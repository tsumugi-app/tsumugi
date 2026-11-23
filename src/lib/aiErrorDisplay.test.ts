// AIエラーの分類が adapter → route → 表示まで一貫し、原因（残高不足・利用上限・
// 認証・サービス障害・通信エラー）を区別して伝え、APIキーや上流のエラー詳細を
// 応答にもログにも漏らさないことの検証。実 route と実 adapter を使い、
// SDK（@google/genai / openai）だけを差し替える（aiSelection.test.ts と同じ方式）。
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

import {
  apiKeyTestErrorResponse,
  chatErrorResponse,
  chatSendErrorStatus,
  parseChatErrorKind,
  CHAT_ERROR_MESSAGES,
  CHAT_SEND_ERROR_TEXT,
} from "./ai/errorResponse";
import type { AIErrorType } from "./ai/errors";
import { retryableTurns } from "./aiReplyOutcome";
import type { ConversationTurn } from "./types";

const USER_GEMINI = "fictional-user-gemini-key";
const USER_OPENAI = "fictional-user-openai-key";
const UPSTREAM_DETAIL = "UPSTREAM-SECRET-DETAIL";

const ROOT = path.join(__dirname, "..");

// ---- fake SDKs -------------------------------------------------------------

const geminiState: { error: unknown } = { error: null };
class GoogleGenAI {
  constructor(_opts: { apiKey: string }) {}
  models = {
    generateContent: async () => {
      if (geminiState.error) throw geminiState.error;
      return { text: "架空の返答です。" };
    },
    generateContentStream: async () => {
      if (geminiState.error) throw geminiState.error;
      return (async function* () {
        yield { text: "架空の返答です。", candidates: [{ finishReason: "STOP" }] };
      })();
    },
  };
}

class OpenAIErrorStub extends Error {
  status?: number;
  code?: string | null;
  constructor(...args: unknown[]) {
    super(typeof args[0] === "string" ? args[0] : "openai error");
  }
}
class AuthenticationError extends OpenAIErrorStub {}
class BadRequestError extends OpenAIErrorStub {}
class InternalServerError extends OpenAIErrorStub {}
class NotFoundError extends OpenAIErrorStub {}
class PermissionDeniedError extends OpenAIErrorStub {}
class RateLimitError extends OpenAIErrorStub {}
class UnprocessableEntityError extends OpenAIErrorStub {}
class APIConnectionError extends OpenAIErrorStub {}

const openaiState: { error: unknown } = { error: null };
class FakeOpenAI {
  chat = {
    completions: {
      create: async () => {
        if (openaiState.error) throw openaiState.error;
        return { choices: [{ message: { content: "架空の返答です。" } }] };
      },
    },
  };
  responses = {
    create: async () => {
      if (openaiState.error) throw openaiState.error;
      throw new Error("unused in these tests");
    },
  };
}

const mod = Module as unknown as {
  _load: (request: string, parent?: unknown, isMain?: boolean) => unknown;
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "@google/genai") return { GoogleGenAI, Type: new Proxy({}, { get: (_t, k) => String(k) }) };
  if (request === "openai") {
    return {
      __esModule: true,
      default: FakeOpenAI,
      APIConnectionError,
      AuthenticationError,
      BadRequestError,
      InternalServerError,
      NotFoundError,
      PermissionDeniedError,
      RateLimitError,
      UnprocessableEntityError,
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};

const keys = require(path.join(ROOT, "lib/apiKeyHeader.js")) as typeof import("./apiKeyHeader");
const route = (name: string) =>
  require(path.join(ROOT, `app/api/${name}/route.js`)) as { POST: (r: Request) => Promise<Response> };
const G = keys.GEMINI_API_KEY_HEADER, O = keys.OPENAI_API_KEY_HEADER, P = keys.AI_PROVIDER_HEADER;

// ---- helpers ---------------------------------------------------------------

/** @google/genai の ApiError と同じ形（status=HTTPコード、message=エラー本文JSON）。 */
function geminiApiError(status: number, googleStatus: string): Error & { status: number } {
  const body = JSON.stringify({ error: { code: status, message: UPSTREAM_DETAIL, status: googleStatus } });
  const error = new Error(body) as Error & { status: number };
  error.name = "ApiError";
  error.status = status;
  return error;
}

/** 無効なAPIキーの 400：canonical status は INVALID_ARGUMENT で、details の reason が API_KEY_INVALID。 */
function geminiApiKeyInvalidError(): Error & { status: number } {
  const body = JSON.stringify({
    error: {
      code: 400,
      message: UPSTREAM_DETAIL,
      status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }],
    },
  });
  const error = new Error(body) as Error & { status: number };
  error.name = "ApiError";
  error.status = 400;
  return error;
}

async function callRoute(name: string, headers: Record<string, string>, body: unknown) {
  const res = await route(name).POST(
    new Request(`http://localhost/api/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 成功時のストリーム応答など、JSONでない本文はそのまま */
  }
  return { status: res.status, text, json };
}

async function capturingLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

function assertNoLeak(haystack: string, label: string) {
  assert.ok(!haystack.includes(USER_GEMINI), `${label} must not contain the API key`);
  assert.ok(!haystack.includes(USER_OPENAI), `${label} must not contain the API key`);
  assert.ok(!haystack.includes(UPSTREAM_DETAIL), `${label} must not contain upstream error details`);
}

const CHAT_BODY = {
  persona: "analyst",
  turns: [{ role: "user", content: "架空の相談です", timestamp: "2026-01-01T00:00:00Z" }],
};

// ---- pure mapping ----------------------------------------------------------

test("chatErrorResponse: every kind maps to its status and message", () => {
  const expected: Record<AIErrorType, number> = {
    auth: 401,
    billing: 402,
    rateLimit: 429,
    invalidRequest: 400,
    server: 502,
    network: 502,
    other: 502,
  };
  for (const kind of Object.keys(expected) as AIErrorType[]) {
    assert.deepEqual(chatErrorResponse(kind), { status: expected[kind], message: CHAT_ERROR_MESSAGES[kind] });
  }
});

test("apiKeyTestErrorResponse: every kind maps to its status and a surface message", () => {
  assert.deepEqual(apiKeyTestErrorResponse("auth", "gemini"), {
    status: 401,
    message: "APIキーが正しくないか、権限がありません。",
  });
  assert.deepEqual(apiKeyTestErrorResponse("billing", "gemini"), {
    status: 402,
    message: "APIのプリペイド残高・利用可能額が不足しています。AI Studioの請求・クレジットをご確認ください。",
  });
  assert.deepEqual(apiKeyTestErrorResponse("billing", "openai"), {
    status: 402,
    message: "APIキーの利用上限に達しています。OpenAIアカウントの請求設定や利用可能額をご確認ください。",
  });
  assert.equal(apiKeyTestErrorResponse("rateLimit", "gemini").status, 429);
  assert.equal(apiKeyTestErrorResponse("invalidRequest", "gemini").status, 400);
  assert.equal(apiKeyTestErrorResponse("server", "gemini").status, 502);
  assert.equal(apiKeyTestErrorResponse("network", "gemini").status, 502);
  assert.equal(apiKeyTestErrorResponse("other", "gemini").status, 502);
});

test("chatSendErrorStatus and CHAT_SEND_ERROR_TEXT agree with CHAT_ERROR_MESSAGES", () => {
  const kinds: AIErrorType[] = ["auth", "billing", "rateLimit", "invalidRequest", "server", "network", "other"];
  for (const kind of kinds) {
    assert.equal(CHAT_SEND_ERROR_TEXT[chatSendErrorStatus(kind)], CHAT_ERROR_MESSAGES[kind]);
  }
});

test("parseChatErrorKind: errorKind wins; status is only the legacy fallback", () => {
  assert.equal(parseChatErrorKind({ errorKind: "billing" }, 502), "billing");
  assert.equal(parseChatErrorKind({ errorKind: "network" }, 502), "network");
  assert.equal(parseChatErrorKind({ errorKind: "bogus" }, 401), "auth");
  assert.equal(parseChatErrorKind(null, 401), "auth");
  assert.equal(parseChatErrorKind(null, 402), "other", "status alone never invents a kind");
  assert.equal(parseChatErrorKind(undefined, 500), "other");
  assert.equal(parseChatErrorKind("not json", 502), "other");
});

// ---- Gemini via the key-test route (generateText path) ---------------------

const geminiKeyTestCases: {
  name: string;
  error: () => unknown;
  status: number;
  kind: AIErrorType;
}[] = [
  { name: "402 prepaid balance", error: () => geminiApiError(402, "PERMISSION_DENIED"), status: 402, kind: "billing" },
  { name: "429 quota", error: () => geminiApiError(429, "RESOURCE_EXHAUSTED"), status: 429, kind: "rateLimit" },
  { name: "401 unauthenticated", error: () => geminiApiError(401, "UNAUTHENTICATED"), status: 401, kind: "auth" },
  { name: "403 permission", error: () => geminiApiError(403, "PERMISSION_DENIED"), status: 401, kind: "auth" },
  { name: "400 permission-shaped", error: () => geminiApiError(400, "PERMISSION_DENIED"), status: 401, kind: "auth" },
  { name: "400 invalid argument", error: () => geminiApiError(400, "INVALID_ARGUMENT"), status: 400, kind: "invalidRequest" },
  { name: "400 api key invalid", error: () => geminiApiKeyInvalidError(), status: 401, kind: "auth" },
  { name: "500 internal", error: () => geminiApiError(500, "INTERNAL"), status: 502, kind: "server" },
  { name: "503 unavailable", error: () => geminiApiError(503, "UNAVAILABLE"), status: 502, kind: "server" },
  { name: "fetch failed (TypeError)", error: () => new TypeError("fetch failed"), status: 502, kind: "network" },
  {
    name: "network cause code",
    error: () => Object.assign(new Error("request failed"), { cause: { code: "ENOTFOUND" } }),
    status: 502,
    kind: "network",
  },
  { name: "404 model", error: () => geminiApiError(404, "NOT_FOUND"), status: 502, kind: "other" },
  { name: "unknown error", error: () => new Error("something odd"), status: 502, kind: "other" },
];

for (const c of geminiKeyTestCases) {
  test(`api-key/test (gemini): ${c.name} → ${c.kind}`, async () => {
    geminiState.error = c.error();
    const { result, logs } = await capturingLogs(() =>
      callRoute("api-key/test", { [P]: "gemini", [G]: USER_GEMINI }, {})
    );
    geminiState.error = null;
    const expected = apiKeyTestErrorResponse(c.kind, "gemini");
    assert.equal(result.status, c.status);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.errorKind, c.kind);
    assert.equal(result.json.error, expected.message);
    assertNoLeak(result.text, "key-test response");
    assertNoLeak(logs, "key-test log");
    assert.ok(logs.includes(`kind=${c.kind}`), "log carries the kind");
  });
}

test("api-key/test (gemini): the log carries the upstream status number, nothing else", async () => {
  geminiState.error = geminiApiError(402, "PERMISSION_DENIED");
  const { logs } = await capturingLogs(() => callRoute("api-key/test", { [P]: "gemini", [G]: USER_GEMINI }, {}));
  geminiState.error = null;
  assert.ok(logs.includes("status=402"));
});

// ---- Gemini via the chat route (generateStream path) ------------------------

const geminiChatCases: {
  name: string;
  error: () => unknown;
  status: number;
  kind: AIErrorType;
}[] = [
  { name: "402 prepaid balance", error: () => geminiApiError(402, "PERMISSION_DENIED"), status: 402, kind: "billing" },
  { name: "429 quota", error: () => geminiApiError(429, "RESOURCE_EXHAUSTED"), status: 429, kind: "rateLimit" },
  { name: "401 unauthenticated", error: () => geminiApiError(401, "UNAUTHENTICATED"), status: 401, kind: "auth" },
  { name: "400 api key invalid", error: () => geminiApiKeyInvalidError(), status: 401, kind: "auth" },
  { name: "500 internal", error: () => geminiApiError(500, "INTERNAL"), status: 502, kind: "server" },
  { name: "fetch failed (TypeError)", error: () => new TypeError("fetch failed"), status: 502, kind: "network" },
  { name: "unknown error", error: () => new Error("something odd"), status: 502, kind: "other" },
];

for (const c of geminiChatCases) {
  test(`chat (gemini): ${c.name} → ${c.kind}`, async () => {
    geminiState.error = c.error();
    const { result, logs } = await capturingLogs(() =>
      callRoute("chat", { [P]: "gemini", [G]: USER_GEMINI }, CHAT_BODY)
    );
    geminiState.error = null;
    const expected = chatErrorResponse(c.kind);
    assert.equal(result.status, c.status);
    assert.equal(result.json.errorKind, c.kind);
    assert.equal(result.json.error, expected.message);
    assertNoLeak(result.text, "chat response");
    assertNoLeak(logs, "chat log");
    assert.ok(logs.includes(`kind=${c.kind}`), "log carries the kind");
  });
}

test("chat (gemini): a successful stream is unaffected", async () => {
  geminiState.error = null;
  const { result } = await capturingLogs(() => callRoute("chat", { [P]: "gemini", [G]: USER_GEMINI }, CHAT_BODY));
  assert.equal(result.status, 200);
  assert.ok(result.text.includes("架空の返答です。"));
});

// ---- OpenAI via the key-test route ------------------------------------------

test("api-key/test (openai): insufficient_quota is billing, not a passing rate limit", async () => {
  openaiState.error = Object.assign(new RateLimitError("quota"), { status: 429, code: "insufficient_quota" });
  const { result, logs } = await capturingLogs(() =>
    callRoute("api-key/test", { [P]: "openai", [O]: USER_OPENAI }, {})
  );
  openaiState.error = null;
  assert.equal(result.status, 402);
  assert.equal(result.json.errorKind, "billing");
  assert.equal(
    result.json.error,
    "APIキーの利用上限に達しています。OpenAIアカウントの請求設定や利用可能額をご確認ください。"
  );
  assertNoLeak(result.text, "key-test response");
  assertNoLeak(logs, "key-test log");
});

test("api-key/test (openai): a plain rate limit stays rateLimit", async () => {
  openaiState.error = Object.assign(new RateLimitError("slow down"), { status: 429, code: "rate_limit_exceeded" });
  const { result } = await capturingLogs(() => callRoute("api-key/test", { [P]: "openai", [O]: USER_OPENAI }, {}));
  openaiState.error = null;
  assert.equal(result.status, 429);
  assert.equal(result.json.errorKind, "rateLimit");
});

test("api-key/test (openai): a connection error is network", async () => {
  openaiState.error = new APIConnectionError({ message: "connection failed", cause: undefined });
  const { result } = await capturingLogs(() => callRoute("api-key/test", { [P]: "openai", [O]: USER_OPENAI }, {}));
  openaiState.error = null;
  assert.equal(result.status, 502);
  assert.equal(result.json.errorKind, "network");
});

test("api-key/test (openai): an authentication error is auth", async () => {
  openaiState.error = Object.assign(new AuthenticationError("bad key"), { status: 401 });
  const { result } = await capturingLogs(() => callRoute("api-key/test", { [P]: "openai", [O]: USER_OPENAI }, {}));
  openaiState.error = null;
  assert.equal(result.status, 401);
  assert.equal(result.json.errorKind, "auth");
});

// ---- regression: retry never duplicates the user's utterance -----------------

test("regression: retryableTurns reuses the recorded turns and never appends the utterance again", () => {
  const user = (content: string, at: string): ConversationTurn => ({ role: "user", content, timestamp: at });
  const ai = (content: string, at: string): ConversationTurn => ({ role: "ai", content, timestamp: at });
  const turns = [
    user("架空の最初の発言", "2026-01-01T00:00:00Z"),
    ai("架空の返答", "2026-01-01T00:00:01Z"),
    user("架空の二つ目の発言", "2026-01-01T00:00:02Z"),
  ];
  const retry = retryableTurns(turns);
  assert.deepEqual(retry, turns, "retry sends exactly the recorded turns");
  assert.equal(
    retry?.filter((t) => t.content === "架空の二つ目の発言").length,
    1,
    "the unanswered utterance appears exactly once"
  );
  assert.equal(retryableTurns([user("架空", "2026-01-01T00:00:00Z"), ai("架空の返答", "2026-01-01T00:00:01Z")]), null);
});
