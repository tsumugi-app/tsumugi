// The AI the user chose is the only place anything is sent, with that AI's key only. The real routes and the real resolver run, with the Beta
// Gemini key and an OpenAI server key both set on the server. Only the two SDKs are fake: each records which AI and which key a request reached.
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

const SERVER_GEMINI = "fictional-server-gemini-key";
process.env.GOOGLE_API_KEY = SERVER_GEMINI;
process.env.OPENAI_API_KEY = "fictional-server-openai-key"; // must never be used: only Gemini has a provided key
const USER_GEMINI = "fictional-user-gemini-key";
const USER_OPENAI = "fictional-user-openai-key";

const ROOT = path.join(__dirname, "..");
const reached: string[] = [];
const ANSWER = JSON.stringify({ memories: [], links: [], title: "架空", reflection: "架空の振り返り", userMentioned: false, assistantMentioned: false, desire: "unknown", action: "unknown", evaluation: "unknown", items: [], reactions: [] });

class GoogleGenAI {
  constructor({ apiKey }: { apiKey: string }) { reached.push(`gemini:${apiKey}`); }
  models = {
    generateContent: async () => ({ text: ANSWER }),
    generateContentStream: async () => (async function* () { yield { text: "架空の返答です。", candidates: [{ finishReason: "STOP" }] }; })(),
  };
}
class FakeOpenAI {
  constructor({ apiKey }: { apiKey: string }) { reached.push(`openai:${apiKey}`); }
  chat = {
    completions: {
      create: async (params: { stream?: boolean }) => params.stream
        ? (async function* () { yield { choices: [{ delta: { content: "架空の返答です。" }, finish_reason: "stop" }] }; })()
        : { choices: [{ message: { content: ANSWER } }] },
    },
  };
  responses = { create: async () => (async function* () { yield { type: "response.output_text.delta", delta: "架空の返答です。" }; })() };
}
class ErrorStub extends Error {}
const mod = Module as unknown as {
  _load: (request: string, parent?: unknown, isMain?: boolean) => unknown;
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "@google/genai") return { GoogleGenAI, Type: new Proxy({}, { get: (_t, k) => String(k) }) };
  if (request === "openai") {
    return { __esModule: true, default: FakeOpenAI, AuthenticationError: ErrorStub, BadRequestError: ErrorStub, InternalServerError: ErrorStub, NotFoundError: ErrorStub, PermissionDeniedError: ErrorStub, RateLimitError: ErrorStub, UnprocessableEntityError: ErrorStub };
  }
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const keys = require(path.join(ROOT, "lib/apiKeyHeader.js")) as typeof import("./apiKeyHeader");
const route = (name: string) => require(path.join(ROOT, `app/api/${name}/route.js`)) as { POST: (r: Request) => Promise<Response> };

const MEMORY = { summary: "架空の要約", content: "架空の記憶", keywords: ["架空"], date: "2026-01-01" };
const TURNS = [{ role: "user", content: "架空の話題です", timestamp: "2026-01-01T00:00:00Z" }, { role: "ai", content: "架空の返答です。", timestamp: "2026-01-01T00:00:01Z" }];
/** every route that sends to an AI, with a body that gets as far as the AI call */
const ROUTES: Record<string, unknown> = {
  chat: { persona: "analyst", turns: [{ role: "user", content: "架空の相談です", timestamp: "2026-01-01T00:00:00Z" }] },
  capture: { persona: "companion", turns: TURNS, existingMemories: [], relatedMemories: [] },
  connect: { newMemory: MEMORY, candidates: [{ id: "a", date: "2026-01-01", summary: "架空", keywords: ["架空"] }] },
  prompt: MEMORY,
  reflect: { persona: "companion", ...MEMORY },
  "fact-extract": { subject: "架空", turns: TURNS },
  "semantic-interpret": { fact: { id: "f", subject: "架空", evidence: [{ quote: "架空の話題です" }] } },
  "api-key/test": {},
};
/** reached only with a non-empty Memory Synthesis plan; its refusals are checked, and it shares the resolver with the others */
const ALL = [...Object.keys(ROUTES), "synthesize"];

async function call(name: string, headers: Record<string, string>) {
  reached.length = 0;
  const res = await route(name).POST(new Request(`http://localhost/api/${name}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(ROUTES[name] ?? {}) }));
  if (res.body) await res.text();
  return { status: res.status, reached: [...new Set(reached)] };
}
const G = keys.GEMINI_API_KEY_HEADER, O = keys.OPENAI_API_KEY_HEADER, P = keys.AI_PROVIDER_HEADER, ONLY = keys.USER_KEY_ONLY_HEADER;

for (const name of ALL) {
  test(`${name}: a request that names no AI is refused and reaches no AI, though it carries a Gemini key and the server has one`, async () => {
    assert.deepEqual(await call(name, { [G]: USER_GEMINI }), { status: 400, reached: [] });
    assert.deepEqual(await call(name, {}), { status: 400, reached: [] });
  });
  test(`${name}: an AI Tsumugi cannot call is refused, never replaced by another`, async () => {
    assert.deepEqual(await call(name, { [P]: "claude", [G]: USER_GEMINI }), { status: 400, reached: [] });
  });
  test(`${name}: OpenAI chosen but only a Gemini key: refused, nothing goes to Gemini (no fallback) nor to OpenAI on a server key`, async () => {
    const refused = name === "api-key/test" ? 400 : 401; // the key check answers 400 when no key was typed
    assert.deepEqual(await call(name, { [P]: "openai", [G]: USER_GEMINI }), { status: refused, reached: [] });
    assert.deepEqual(await call(name, { [P]: "openai" }), { status: refused, reached: [] });
  });
}
for (const name of Object.keys(ROUTES)) {
  test(`${name}: OpenAI chosen with its key: only OpenAI, with the user's key, is reached`, async () => {
    const r = await call(name, { [P]: "openai", [O]: USER_OPENAI });
    assert.notEqual(r.status, 400); assert.notEqual(r.status, 401);
    assert.deepEqual(r.reached, [`openai:${USER_OPENAI}`]);
  });
  test(`${name}: both keys on the device: the chosen AI's key only goes to the chosen AI`, async () => {
    assert.deepEqual((await call(name, { [P]: "openai", [O]: USER_OPENAI, [G]: USER_GEMINI })).reached, [`openai:${USER_OPENAI}`]);
    assert.deepEqual((await call(name, { [P]: "gemini", [O]: USER_OPENAI, [G]: USER_GEMINI })).reached, [`gemini:${USER_GEMINI}`]);
  });
  test(`${name}: Gemini chosen with the user's key: only that key`, async () => {
    assert.deepEqual((await call(name, { [P]: "gemini", [G]: USER_GEMINI })).reached, [`gemini:${USER_GEMINI}`]);
  });
  if (name !== "api-key/test") {
    test(`${name}: Gemini chosen with no key: the Beta key serves it; marked automatic, it does not`, async () => {
      assert.deepEqual((await call(name, { [P]: "gemini" })).reached, [`gemini:${SERVER_GEMINI}`]);
      assert.deepEqual(await call(name, { [P]: "gemini", [ONLY]: "1" }), { status: 401, reached: [] });
    });
  }
}
test("api-key/test checks the key typed in only, never a provided key", async () => {
  assert.deepEqual(await call("api-key/test", { [P]: "gemini" }), { status: 400, reached: [] });
});
test("synthesize: Gemini with no key and OpenAI with its key pass the AI check (an empty plan then needs no call)", async () => {
  assert.equal((await call("synthesize", { [P]: "gemini" })).status, 200);
  assert.equal((await call("synthesize", { [P]: "openai", [O]: USER_OPENAI })).status, 200);
});

test("in the app, a request names the chosen AI and carries that AI's key only", () => {
  assert.deepEqual(keys.aiRequestHeaders("openai", USER_OPENAI), { [P]: "openai", [O]: USER_OPENAI });
  assert.deepEqual(keys.aiRequestHeaders("gemini", USER_GEMINI), { [P]: "gemini", [G]: USER_GEMINI });
  assert.deepEqual(keys.aiRequestHeaders("openai", undefined), { [P]: "openai" }, "no key: the server refuses, nothing is sent elsewhere");
  assert.deepEqual(keys.aiRequestHeaders("gemini", undefined), { [P]: "gemini" });
});
test("in the app, an automatic request is built only with a usable key of the chosen AI, and always with the mark", () => {
  for (const provider of ["gemini", "openai"] as const) {
    for (const key of [undefined, "", "   ", "架空のキー", "key​"]) assert.throws(() => keys.aiRequestHeaders(provider, key, true), { name: "NoUserKeyError" });
  }
  assert.deepEqual(keys.aiRequestHeaders("openai", USER_OPENAI, true), { [P]: "openai", [O]: USER_OPENAI, [ONLY]: "1" });
});

// the app side: the choice and the key are read just before sending; a run that began with another AI sends nothing
const store: Record<string, string | undefined> = {};
const dbStub = {
  loadChatProvider: async () => (store.chatProvider === "openai" ? "openai" : "gemini"),
  loadApiKey: async (p: string) => store[`key:${p}`],
  loadSelectedAi: async () => { const provider = await dbStub.loadChatProvider(); return { provider, key: store[`key:${provider}`] }; },
};
test("selectedAiHeaders: the chosen AI and its key; a changed choice stops an automatic run before anything is sent", async () => {
  const withFakes = mod._load;
  mod._load = function (request, parent, isMain) {
    if (request === "./db" && (parent as { filename?: string } | undefined)?.filename?.endsWith("selectedAi.js")) return dbStub;
    return withFakes.call(this, request, parent, isMain);
  };
  const { selectedAiHeaders } = require(path.join(ROOT, "lib/selectedAi.js")) as typeof import("./selectedAi");
  Object.assign(store, { chatProvider: "openai", "key:openai": USER_OPENAI, "key:gemini": USER_GEMINI });
  assert.deepEqual(await selectedAiHeaders(), { provider: "openai", headers: { [P]: "openai", [O]: USER_OPENAI } });
  assert.deepEqual((await selectedAiHeaders({ provider: "openai", requireUserKey: true })).headers, { [P]: "openai", [O]: USER_OPENAI, [ONLY]: "1" });
  await assert.rejects(selectedAiHeaders({ provider: "gemini", requireUserKey: true }), { name: "AiSelectionChangedError" });
  await assert.rejects(selectedAiHeaders({ provider: "gemini" }), { name: "AiSelectionChangedError" }, "the end of a conversation checked the AI it decided on");
  store["key:openai"] = undefined;
  await assert.rejects(selectedAiHeaders({ provider: "openai", requireUserKey: true }), { name: "NoUserKeyError" }, "no fallback to the Gemini key on the device");
  assert.deepEqual(await selectedAiHeaders(), { provider: "openai", headers: { [P]: "openai" } });
  store.chatProvider = undefined;
  assert.deepEqual(await selectedAiHeaders(), { provider: "gemini", headers: { [P]: "gemini", [G]: USER_GEMINI } });
});
