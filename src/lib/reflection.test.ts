/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Reflection STEP 2-B（titleとreflectionを同じLLM callで生成する）の回帰テスト。
 *
 * 実行方法（Node組み込みのtest runnerのみ。新しい依存は無い。外部AI APIも呼ばない）：
 *   npm run test:reflect
 * （tsconfig.reflect.jsonでreflection.ts・markdown.ts・/api/reflect route.ts・
 *   このファイルを`.test-out/`へコンパイルし、`node --test`で実行する）
 *
 * 守りたい不変条件：
 * - title専用の追加LLM callを増やさない（/api/reflectへのgenerateStructured呼び出しは常に1回）。
 * - titleが空・reflectionが空・malformedなstructured outputは、安全に502エラーとして
 *   扱う（不正な値をそのままConversation/MemoryObjectへ保存しない）。
 * - createInsightMemoryObjectは引き続きreflection本文だけをcontent/summaryにし、
 *   conversationId・types（["insight"]）は変更しない（title追加の影響を受けない）。
 * - Conversation.titleはoptionalで、legacy（titleフィールドが無い）Markdownもそのまま読める。
 * - STEP 2-AのConversation entry kind（conversationEntryKindOf）はtitle追加の影響を受けない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";
import { conversationEntryKindOf } from "./conversationEntryKind";

// コンパイル後の配置：.test-out/lib/reflection.test.js → ROOTは.test-out
const ROOT = path.join(__dirname, "..");

type ProviderRequest = { systemInstruction: string; userContent: string; schema: unknown };
type Step = { title: string; reflection: string } | { rawText: string } | { throw: true };

const rec: { script: Step[] | null; requests: ProviderRequest[] } = { script: null, requests: [] };

const fakeProvider = {
  async generateStructured(req: ProviderRequest) {
    rec.requests.push(req);
    const step: Step = rec.script && rec.script.length > 0 ? rec.script.shift()! : { throw: true };
    if ("throw" in step) throw new Error("scripted provider failure (unexpected call)");
    if ("rawText" in step) return { text: step.rawText };
    return { text: JSON.stringify({ title: step.title, reflection: step.reflection }) };
  },
};

const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveProviderForFeature: () => "gemini" },
  "./db": new Proxy({ loadApiKey: async () => "k" }, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : async () => undefined) }),
};

const mod = Module as unknown as {
  _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown;
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  const inTree = parent?.filename?.startsWith(ROOT) ?? false;
  if (request === "@/lib/ai/resolve") return stubs[request];
  if (inTree && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};

const reflectRoute = require(path.join(ROOT, "app/api/reflect/route.js")) as { POST: (req: Request) => Promise<Response> };
const reflectionLib = require(path.join(ROOT, "lib/reflection.js")) as {
  generateSessionReflection: (persona: string, source: unknown) => Promise<{ title: string; reflection: string }>;
  createInsightMemoryObject: (conversation: unknown, source: unknown, text: string) => {
    conversationId: string;
    types: string[];
    content: string;
    summary: string;
  };
};
const markdownLib = require(path.join(ROOT, "lib/markdown.js")) as {
  conversationToMarkdown: (c: unknown) => string;
  parseConversationMarkdown: (raw: string) => { title?: string } | null;
};

function run(script: Step[]) {
  rec.script = [...script];
  rec.requests = [];
}

const T0 = "2026-09-25T10:00:00.000Z";
const BASE_CONVERSATION = {
  id: "CONV-R1",
  persona: "companion",
  startedAt: T0,
  status: "active",
  createdAt: T0,
  updatedAt: T0,
  memoryObjectIds: [],
  turns: [],
  metadata: { id: "x", schemaVersion: "0.1", source: "user", createdAt: T0, updatedAt: T0 },
};
const BASE_MEMORY = {
  id: "MEM-1",
  date: T0,
  types: ["conversation"],
  conversationId: "CONV-R1",
  content: "今日は公園を散歩した。",
  summary: "公園を散歩した",
  keywords: ["公園"],
  themeIds: [],
  personIds: [],
  emotionIds: [],
  goalIds: [],
  ideaIds: [],
  eventIds: [],
  links: [],
  createdAt: T0,
  updatedAt: T0,
  metadata: { id: "m", schemaVersion: "0.1", source: "ai-capture", aiProvider: "gemini", createdAt: T0, updatedAt: T0 },
};

async function callReflectRoute(body: Record<string, unknown>): Promise<Response> {
  return reflectRoute.POST(new Request("http://x/api/reflect", { method: "POST", body: JSON.stringify(body) }));
}

// ===========================================================================
// 1. /api/reflectがtitle + reflectionを返す
// ===========================================================================

test("1: /api/reflectは1回のgenerateStructured callでtitleとreflectionを両方返す", async () => {
  run([{ title: "公園散歩の記録", reflection: "今日は公園を散歩した。" }]);
  const res = await callReflectRoute({ persona: "companion", summary: "公園を散歩した", content: "今日は公園を散歩した。", keywords: ["公園"] });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { title: string; reflection: string };
  assert.equal(data.title, "公園散歩の記録");
  assert.equal(data.reflection, "今日は公園を散歩した。");
  assert.equal(rec.requests.length, 1, "title用の追加callは発生しない（常に1回）");
});

// ===========================================================================
// 2. titleが空にならない
// ===========================================================================

test("2: titleが空文字で返った場合は502として安全に扱う（空titleを保存しない）", async () => {
  run([{ title: "", reflection: "今日は公園を散歩した。" }]);
  const res = await callReflectRoute({ persona: "companion", summary: "s", content: "c", keywords: [] });
  assert.equal(res.status, 502);
  const data = (await res.json()) as { error: string };
  assert.match(data.error, /title/i);
});

// ===========================================================================
// 3. reflectionが空にならない
// ===========================================================================

test("3: reflectionが空文字で返った場合は502として安全に扱う（空reflectionを保存しない）", async () => {
  run([{ title: "散歩", reflection: "" }]);
  const res = await callReflectRoute({ persona: "companion", summary: "s", content: "c", keywords: [] });
  assert.equal(res.status, 502);
  const data = (await res.json()) as { error: string };
  assert.match(data.error, /reflection/i);
});

// ===========================================================================
// 4. malformed structured responseを安全に扱う
// ===========================================================================

test("4: 構造化出力がJSONとしてparseできない場合は502として安全に扱う", async () => {
  run([{ rawText: "not a json" }]);
  const res = await callReflectRoute({ persona: "companion", summary: "s", content: "c", keywords: [] });
  assert.equal(res.status, 502);
  const data = (await res.json()) as { error: string };
  assert.match(data.error, /parse/i);
});

// ===========================================================================
// 6 / 7 / 9. generateSessionReflection → createInsightMemoryObjectの既存契約が維持される
// ===========================================================================

test("6/7/9: titleを追加してもReflection保存契約（content/summary/conversationId/types）は従来どおり", async () => {
  run([{ title: "散歩の記録", reflection: "今日は公園を散歩した。" }]);
  const prevFetch = global.fetch;
  global.fetch = (async (_url: string, init: RequestInit) => callReflectRoute(JSON.parse(init.body as string))) as typeof fetch;
  try {
    const { title, reflection } = await reflectionLib.generateSessionReflection("companion", BASE_MEMORY);
    assert.equal(title, "散歩の記録");
    assert.equal(reflection, "今日は公園を散歩した。");

    const insight = reflectionLib.createInsightMemoryObject(BASE_CONVERSATION, BASE_MEMORY, reflection);
    assert.equal(insight.conversationId, BASE_CONVERSATION.id, "conversationId relationが維持される");
    assert.deepEqual(insight.types, ["insight"], "MemoryObject.typesはinsightのまま（titleに影響されない）");
    assert.equal(insight.content, reflection, "titleはReflection MemoryObjectのcontentに混入しない");
    assert.equal(insight.summary, reflection);
  } finally {
    global.fetch = prevFetch;
  }
});

// ===========================================================================
// 5 / 8. Conversation.titleのMarkdown round-trip・legacy互換性
// ===========================================================================

test("5: Conversation.titleを設定するとMarkdown frontmatterへ書き出され、そのまま読み戻せる", () => {
  const withTitle = { ...BASE_CONVERSATION, title: "公園散歩の記録" };
  const md = markdownLib.conversationToMarkdown(withTitle);
  assert.match(md, /\ntitle: /);
  const parsed = markdownLib.parseConversationMarkdown(md);
  assert.equal(parsed?.title, "公園散歩の記録");
});

test("8: titleフィールドが無いlegacy Conversation Markdownも例外なく読め、titleはundefinedになる", () => {
  const legacyMd = markdownLib.conversationToMarkdown(BASE_CONVERSATION); // title未設定
  assert.doesNotMatch(legacyMd, /\ntitle: /, "title未設定時はfrontmatterにキー自体が出ない");
  const parsed = markdownLib.parseConversationMarkdown(legacyMd);
  assert.equal(parsed?.title, undefined);
});

// ===========================================================================
// 10. Conversation entry kind（STEP 2-A）への影響なし
// ===========================================================================

test("10: Conversation entry kindはtitle追加の影響を受けない", () => {
  assert.equal(conversationEntryKindOf("companion"), "diary");
  assert.equal(conversationEntryKindOf("analyst"), "conversation");
  assert.equal(conversationEntryKindOf("coach"), "conversation");
});
