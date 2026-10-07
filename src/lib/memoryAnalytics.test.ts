/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Memory Analytics Phase 1のテスト。集計（純粋関数）・intent・server sanitize・実route経由のprompt・diagnosticを確認する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

type Json = Record<string, unknown>;
const ROOT = path.join(__dirname, "..");
const chatRec: { systemInstruction: string; calls: number; req: Record<string, unknown> | null } = { systemInstruction: "", calls: 0, req: null };
const fakeProvider = {
  async generateStream(req: { systemInstruction?: string }) {
    chatRec.systemInstruction = req.systemInstruction ?? "";
    chatRec.req = req as unknown as Record<string, unknown>;
    chatRec.calls += 1;
    return (async function* () { yield { text: "ok", finishReason: "stop" as const }; })();
  },
};
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveProviderForFeature: () => "gemini", resolveRequestedProvider: () => undefined },
  "./db": { getAllMemoryObjects: async () => [], getAllConversations: async () => [], getMemoryObject: async () => undefined },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn(), getTabVaultEpoch: () => 1, getActiveVaultEpoch: async () => 1, getVaultWorldJournalVersion: async () => ({ status: "current" }), getCommittedVaultEpoch: async () => ({ status: "valid", epoch: 1 }) },
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown; _resolveFilename: (request: string, ...rest: unknown[]) => string };
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

const ma = require(path.join(ROOT, "lib/memoryAnalytics.js")) as typeof import("./memoryAnalytics");
const ms = require(path.join(ROOT, "lib/memorySearch.js")) as typeof import("./memorySearch");
const debugLog = require(path.join(ROOT, "lib/conversationDebugLog.js")) as typeof import("./conversationDebugLog");
const protocol = require(path.join(ROOT, "lib/generationDebugProtocol.js")) as typeof import("./generationDebugProtocol");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };
type MemoryObject = import("./types").MemoryObject;

let seq = 0;
function mem(o: { keywords: string[]; conversationId?: string | null; date?: string; source?: string; types?: string[]; summary?: string }): MemoryObject {
  seq += 1;
  const id = `M${seq}`;
  const d = o.date ?? "2026-09-10T03:00:00.000Z";
  return {
    id, date: d, types: o.types ?? ["diary"], ...(o.conversationId === null ? {} : { conversationId: o.conversationId ?? `C${seq}` }),
    content: "本文", summary: o.summary ?? `要約${seq}`, keywords: o.keywords, themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    createdAt: d, updatedAt: d, metadata: { id, schemaVersion: "0.1", source: o.source ?? "ai-capture", createdAt: d, updatedAt: d },
  } as unknown as MemoryObject;
}
const rank = (mems: MemoryObject[], opts: { limit?: number; excludeConversationId?: string } = {}) => ma.computeKeywordRanking(mems, opts);
const kw = (r: ReturnType<typeof rank>) => r.results.map((x) => `${x.keyword}:${x.conversationCount}/${x.memoryCount}`);

test("1 conversation dedupe: several Memories of one conversation with the same keyword -> conversationCount=1 (memoryCount counts Memories)", () => {
  const r = rank([mem({ keywords: ["黄金湯"], conversationId: "A" }), mem({ keywords: ["黄金湯"], conversationId: "A" }), mem({ keywords: ["黄金湯"], conversationId: "B" })]);
  assert.deepEqual(kw(r), ["黄金湯:2/3"]); assert.equal(r.scope.conversationCount, 2); assert.equal(r.scope.memoryCount, 3);
  const one = rank([mem({ keywords: ["黄金湯"], conversationId: "A" }), mem({ keywords: ["黄金湯"], conversationId: "A" })]);
  assert.deepEqual(kw(one), ["黄金湯:1/2"]);
});
test("2 memory dedupe: a keyword repeated inside one Memory counts once (also across case/width variants)", () => {
  const r = rank([mem({ keywords: ["黄金湯", "黄金湯", " 黄金湯 ", "Obsidian", "OBSIDIAN", "ｏｂｓｉｄｉａｎ"] })]);
  assert.equal(r.results.length, 2); assert.ok(r.results.every((x) => x.memoryCount === 1 && x.conversationCount === 1));
  assert.deepEqual(r.results.map((x) => x.keyword), ["OBSIDIAN", "黄金湯"], "all three surface forms are tied (1 each) -> the first by code point is displayed");
  assert.equal(r.scope.distinctKeywordCount, 2);
});
test("3 Reflection exclusion: system-generated Reflection keywords are never added; excludedReflectionCount reports them", () => {
  const normal = mem({ keywords: ["黄金湯", "銭湯"], conversationId: "A" });
  const reflection = mem({ keywords: ["黄金湯", "銭湯", "リュウ"], conversationId: "A", source: "system-generated", types: ["insight"] });
  const r = rank([normal, reflection]);
  assert.deepEqual(kw(r), ["銭湯:1/1", "黄金湯:1/1"], "ties -> key ascending"); assert.equal(r.scope.excludedReflectionCount, 1); assert.equal(r.scope.memoryCount, 1);
  // a NORMAL Memory that merely has type "insight" is still counted (only metadata.source decides)
  assert.equal(rank([mem({ keywords: ["x1"], types: ["insight"] })]).scope.memoryCount, 1);
  // same condition as vault.ts isReflectionSummary
  const vaultSrc = require("node:fs").readFileSync(path.join(ROOT, "..", "src/lib/vault.ts"), "utf8") as string;
  assert.ok(/export function isReflectionSummary\(memoryObject: MemoryObject\): boolean \{\s*return memoryObject\.metadata\.source === "system-generated";/.test(vaultSrc));
});
test("4 normalization: NFKC / trim / lowercase group together; リュウ and リュウさん stay separate", () => {
  const r = rank([mem({ keywords: ["Obsidian"] }), mem({ keywords: ["ｏｂｓｉｄｉａｎ"] }), mem({ keywords: ["  obsidian  "] }), mem({ keywords: ["リュウ"] }), mem({ keywords: ["リュウさん"] }), mem({ keywords: ["", "  ", "x"] })]);
  assert.equal(r.results[0].conversationCount, 3); assert.equal(ma.normalizeAnalyticsKeyword("ＡＢｃ　"), "abc");
  assert.ok(r.results.some((x) => x.keyword === "リュウ") && r.results.some((x) => x.keyword === "リュウさん"));
  assert.equal(r.scope.distinctKeywordCount, 4, "empty keywords are ignored");
});
test("5 display form: the most used original surface; ties are deterministic", () => {
  const r = rank([mem({ keywords: ["Obsidian"] }), mem({ keywords: ["obsidian"] }), mem({ keywords: ["obsidian"] })]);
  assert.equal(r.results[0].keyword, "obsidian");
  const tie1 = rank([mem({ keywords: ["Obsidian"] }), mem({ keywords: ["obsidian"] })]).results[0].keyword;
  const tie2 = rank([mem({ keywords: ["obsidian"] }), mem({ keywords: ["Obsidian"] })]).results[0].keyword;
  assert.equal(tie1, tie2, "input order does not matter"); assert.equal(tie1, "Obsidian");
});
test("6 ranking: conversationCount -> memoryCount -> lastDate -> key (deterministic, input-order independent)", () => {
  const mk = () => [
    mem({ keywords: ["a1"], conversationId: "X1", date: "2026-09-01T03:00:00.000Z" }), mem({ keywords: ["a1"], conversationId: "X2", date: "2026-09-01T03:00:00.000Z" }),
    mem({ keywords: ["b1"], conversationId: "Y1", date: "2026-09-02T03:00:00.000Z" }), mem({ keywords: ["b1"], conversationId: "Y1", date: "2026-09-02T03:00:00.000Z" }), mem({ keywords: ["b1"], conversationId: "Y2", date: "2026-09-02T03:00:00.000Z" }),
    mem({ keywords: ["c1"], conversationId: "Z1", date: "2026-09-05T03:00:00.000Z" }), mem({ keywords: ["c1"], conversationId: "Z2", date: "2026-09-05T03:00:00.000Z" }),
    mem({ keywords: ["d1"], conversationId: "W1", date: "2026-09-05T03:00:00.000Z" }), mem({ keywords: ["d1"], conversationId: "W2", date: "2026-09-05T03:00:00.000Z" }),
    mem({ keywords: ["e1"], conversationId: "V1", date: "2026-09-09T03:00:00.000Z" }),
  ];
  const a = mk(); const expected = ["b1", "c1", "d1", "a1", "e1"]; // b1: 2 conv / 3 mem; c1,d1: 2/2 same lastDate -> key; a1: 2/2 older; e1: 1 conv
  assert.deepEqual(rank(a).results.map((x) => x.keyword), expected);
  assert.deepEqual(rank([...a].reverse()).results.map((x) => x.keyword), expected);
  assert.deepEqual(rank(a).results.map((x) => x.rank), [1, 2, 3, 4, 5]);
  assert.equal(rank(a).results[0].firstDate, "2026-09-02"); assert.equal(rank(a).results[0].lastDate, "2026-09-02");
  assert.equal(rank(a).scope.firstDate, "2026-09-01"); assert.equal(rank(a).scope.lastDate, "2026-09-09");
});
test("7 missing conversationId: each Memory is its own group", () => {
  const r = rank([mem({ keywords: ["k1"], conversationId: null }), mem({ keywords: ["k1"], conversationId: null }), mem({ keywords: ["k1"], conversationId: "A" }), mem({ keywords: ["k1"], conversationId: "A" })]);
  assert.deepEqual(kw(r), ["k1:3/4"]);
});
test("8 current conversation exclusion", () => {
  const r = rank([mem({ keywords: ["黄金湯"], conversationId: "NOW" }), mem({ keywords: ["黄金湯"], conversationId: "OLD" })], { excludeConversationId: "NOW" });
  assert.deepEqual(kw(r), ["黄金湯:1/1"]); assert.equal(r.scope.memoryCount, 1);
});
test("9 limit: default 10, 1..20 from the question, over 20 -> 20, under 1 -> 1", () => {
  const many = Array.from({ length: 30 }, (_, i) => mem({ keywords: [`kw${String(i).padStart(2, "0")}`] }));
  assert.equal(ma.buildMemoryAnalyticsContext(many, "今までよく出てきたキーワードTOP10は？")!.results.length, 10);
  assert.equal(ma.buildMemoryAnalyticsContext(many, "キーワードを多い順に並べて")!.results.length, 10, "no number -> 10");
  assert.equal(ma.buildMemoryAnalyticsContext(many, "キーワードのTOP5を教えて")!.requestedLimit, 5);
  assert.equal(ma.buildMemoryAnalyticsContext(many, "登場回数が多いキーワードを上位20個並べて")!.results.length, 20);
  assert.equal(ma.buildMemoryAnalyticsContext(many, "キーワードを50個並べて、多い順で")!.requestedLimit, 20, "capped at 20");
  assert.equal(ma.buildMemoryAnalyticsContext(many, "キーワードTOP0を多い順に教えて")!.requestedLimit, 1, "floored at 1");
  assert.equal(ma.buildMemoryAnalyticsContext(many, "キーワードをTOP３で教えて")!.requestedLimit, 3, "full-width digits");
});
const POSITIVE = ["今まで記憶したメモリーの中で、登場回数が多いキーワードを10個並べて", "今までよく出てきたキーワードTOP10は？", "全体で多いキーワードは？", "キーワードを多い順に並べて", "一番よく出てくるキーワードは？", "キーワードランキングを見せて"];
const NEGATIVE = ["黄金湯について何話した？", "黄金湯について記録ある？", "キーワードについて記録ある？", "最近よく話しているテーマは？", "最近増えている話題は？", "コーヒーって何回出てきた？", "今日は仕事の話をよくしてる", "最近よく出てくるキーワードは？", "今月のキーワードTOP10は？", "先月多かったキーワードを並べて", "8月によく出たキーワードは？", "キーワードが増えている？", "このアプリはキーワードがよく出てくる", "一番よく話していることって何？", "人物ランキングを見せて", "黄金湯に行きたい", "さきさんと今度仕事する", "Obsidian使ってる"];
test("10 intent: positives are Analytics; negatives (incl. any period / trend / non-keyword / statements) are not", () => {
  for (const q of POSITIVE) assert.ok(ma.detectMemoryAnalyticsIntent(q), q);
  for (const q of NEGATIVE) assert.equal(ma.detectMemoryAnalyticsIntent(q), null, q);
});
test("11 Explicit Search non-regression: Analytics never claims an Explicit Search, and Explicit Search detection is unchanged", () => {
  for (const q of ["黄金湯について何話した？", "黄金湯について記録ある？", "銭湯について記録ある？", "Obsidianのこと何か残ってる？", "さきさんについて何話した？"]) {
    assert.equal(ma.detectMemoryAnalyticsIntent(q), null, q); assert.ok(ms.detectExplicitMemorySearch(q), `still explicit: ${q}`);
  }
  for (const q of POSITIVE) assert.equal(ms.detectExplicitMemorySearch(q), null, `Analytics phrasing is not an explicit search: ${q}`);
  // ChatScreen wiring: Analytics is evaluated first and Explicit Search is skipped when Analytics matched
  const src = require("node:fs").readFileSync(path.join(ROOT, "..", "src/components/ChatScreen.tsx"), "utf8") as string;
  const a = src.indexOf("buildMemoryAnalyticsContext(allMemoriesForTopicContinuity"); const e = src.indexOf("buildExplicitSearchContext(allMemoriesForTopicContinuity");
  assert.ok(a > 0 && e > a, "analytics first"); assert.ok(src.slice(a, e).includes("if (memoryAnalyticsContext === null)"), "explicit only when analytics did not match");
  assert.ok(src.includes("...(memoryAnalyticsContext ? { memoryAnalytics: memoryAnalyticsContext } : {})"));
  assert.equal(src.split("appendMemoryAnalyticsAcceptanceNote(generationId").length - 1, 1);
});
test("12 ordinary conversation: no Analytics context", () => {
  assert.equal(ma.buildMemoryAnalyticsContext([mem({ keywords: ["黄金湯"] })], "黄金湯に行きたい"), null);
  assert.equal(ma.buildMemoryAnalyticsContext([mem({ keywords: ["黄金湯"] })], "こんにちは"), null);
});

async function callChat(body: Json, debug = true): Promise<{ systemInstruction: string; text: string; accepted?: import("./generationDebugProtocol").MemoryAnalyticsServerAccepted; explicitAccepted?: unknown }> {
  chatRec.systemInstruction = ""; chatRec.calls = 0;
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(debug ? { ...body, debugGenerationId: "gen-test" } : body) }));
  const text = await res.text(); assert.equal(chatRec.calls, 1);
  const i = text.indexOf(protocol.DEBUG_ENVELOPE_DELIMITER);
  const env = i >= 0 ? (JSON.parse(text.slice(i + protocol.DEBUG_ENVELOPE_DELIMITER.length)) as { serverAccepted: { memoryAnalyticsServerAccepted?: import("./generationDebugProtocol").MemoryAnalyticsServerAccepted; explicitSearchServerAccepted?: unknown } }) : undefined;
  return { systemInstruction: chatRec.systemInstruction, text, accepted: env?.serverAccepted.memoryAnalyticsServerAccepted, explicitAccepted: env?.serverAccepted.explicitSearchServerAccepted };
}
const turn = (content: string) => ({ role: "user", content, timestamp: "2026-10-07T00:00:00.000Z" });
const Q = "今までよく出てきたキーワードTOP10は？";
function fixture(): MemoryObject[] {
  const m: MemoryObject[] = [];
  for (let i = 0; i < 12; i++) m.push(mem({ keywords: ["仕事", `話題${i}`], conversationId: `C-job-${i}`, date: `2026-09-${String(i + 1).padStart(2, "0")}T03:00:00.000Z` }));
  for (let i = 0; i < 5; i++) m.push(mem({ keywords: ["黄金湯", "銭湯"], conversationId: `C-bath-${i}` }));
  m.push(mem({ keywords: ["仕事", "黄金湯", "リュウ"], conversationId: "C-r", source: "system-generated", types: ["insight"] }));
  return m;
}

test("13 route POST -> provider.generateStream: the final instruction carries the Analytics section, metric, ranking and the Evidence rules", async () => {
  const ctx = ma.buildMemoryAnalyticsContext(fixture(), Q, { excludeConversationId: "NOW" })!;
  assert.equal(ctx.results[0].keyword, "仕事"); assert.equal(ctx.results[0].conversationCount, 12);
  const si = (await callChat({ persona: "analyst", turns: [turn(Q)], retrievedMemories: [], memoryAnalytics: JSON.parse(JSON.stringify(ctx)) })).systemInstruction;
  for (const needle of ["## Memory Analytics Results（保存済みMemory全体の集計結果）", "metric: keyword_conversation_count", "「単語を発言した回数」でも「本文中の出現回数」でもない", "1. 仕事 — 12会話（Memory 12件、2026-09-01〜2026-09-12）", "2. 銭湯 — 5会話", "3. 黄金湯 — 5会話", "正式なEvidenceである", "再計算・変更・補正をしない", "結果と矛盾する回答をしない", "「全体は分からない」", "Reflection）1件は、二重に数えないよう集計から除外している", "この端末に保存されているMemoryの範囲の集計"]) assert.ok(si.includes(needle), needle);
  assert.ok(!si.includes("C-job-0") && !/\bM\d+\b/.test(si.slice(si.indexOf("## Memory Analytics Results"))), "no internal ids in the section");
  // shared prompt + Evidence Boundary + analyst allow-list registration
  assert.ok(si.includes("Retrieved Memories・Memory Analytics Results（保存済みMemory全体の集計結果）（いずれも実際に提示されている場合）"));
  assert.ok(si.includes("順位と数値はその結果をそのまま使い") && si.includes("Memory Analytics Results（保存済みMemory全体の集計結果）も、ユーザーの保存済みMemory全体についての事実を述べる際の正式な根拠として使ってよい"));
  assert.ok(si.includes("キーワードは、AIが会話からMemoryへ付けた語"));
});
test("14 all personas can use the Analytics Evidence", async () => {
  const ctx = ma.buildMemoryAnalyticsContext(fixture(), Q)!;
  for (const persona of ["companion", "analyst", "coach"]) {
    const si = (await callChat({ persona, turns: [turn(Q)], retrievedMemories: [], memoryAnalytics: ctx })).systemInstruction;
    for (const m of ["Memory Analytics Results", "keyword_conversation_count", "正式なEvidenceである", "1. 仕事 — 12会話"]) assert.ok(si.includes(m), `${persona}: ${m}`);
    assert.ok(!si.includes("関連するMemoryがここに無ければ、Memoryを使わず"), persona);
  }
});
test("15 analyst + normal Retrieval + Analytics: the allow-list includes Analytics and the 'ignore if none here' rule is replaced", async () => {
  const ctx = ma.buildMemoryAnalyticsContext(fixture(), Q)!;
  const retrieved = [{ id: "OTHER", date: "2026-08-10T00:00:00.000Z", summary: "仕事の優先順位について考えた", keywords: ["仕事"] }];
  const si = (await callChat({ persona: "analyst", turns: [turn(Q)], retrievedMemories: retrieved, memoryAnalytics: ctx })).systemInstruction;
  assert.ok(si.includes("セクション（ユーザー自身の明示的な発言に基づく前提）、および「Memory Analytics Results（保存済みMemory全体の集計結果）」セクションだけである"));
  assert.ok(si.includes("このセクションに関連するMemoryが無くても、Memory Analytics Resultsがある場合は、その結果を使って回答する。"));
  assert.ok(!si.includes("関連するMemoryがここに無ければ、Memoryを使わず現在の相談内容だけで回答する")); assert.ok(si.includes("仕事の優先順位について考えた"));
});
test("16 malformed payload: the server sanitizer rejects or shrinks it (never passes it unchecked into the prompt)", async () => {
  const good = ma.buildMemoryAnalyticsContext(fixture(), Q)!;
  const S = ma.sanitizeMemoryAnalyticsContext;
  for (const bad of [null, undefined, 5, "x", [], {}, { ...good, metric: "other" }, { ...good, intent: "x" }, { ...good, requestedLimit: 0 }, { ...good, requestedLimit: 21 }, { ...good, requestedLimit: 1.5 }, { ...good, scope: null }, { ...good, scope: { ...good.scope, memoryCount: -1 } }, { ...good, scope: { ...good.scope, conversationCount: "9" } }]) assert.equal(S(bad), null, JSON.stringify(bad)?.slice(0, 60));
  const dirty = { ...good, requestedLimit: 3, results: [
    { rank: 2, keyword: "z".repeat(500), conversationCount: 3, memoryCount: 3, firstDate: "2026-09-01", lastDate: "bad" },
    { rank: 1, keyword: "ok", conversationCount: 2, memoryCount: 2, firstDate: "x", lastDate: "2026-09-02" },
    { rank: 7, keyword: "", conversationCount: 2, memoryCount: 2 }, { rank: 3, keyword: "neg", conversationCount: -1, memoryCount: 1 }, { rank: 0, keyword: "r0", conversationCount: 1, memoryCount: 1 }, { rank: 4, keyword: "frac", conversationCount: 1.5, memoryCount: 1 }, "junk", null,
    { rank: 5, keyword: "e", conversationCount: 1, memoryCount: 1 }, { rank: 6, keyword: "f", conversationCount: 1, memoryCount: 1 },
  ] };
  const s = S(dirty)!;
  assert.deepEqual(s.results.map((r) => r.rank), [1, 2, 3], "invalid rows dropped, ranks re-issued from 1, capped at requestedLimit");
  assert.deepEqual(s.results.map((r) => r.keyword.length), [2, 60, 1]); assert.equal(s.results[0].keyword, "ok"); assert.equal(s.results[0].firstDate, null); assert.equal(s.results[1].keyword.length, 60); assert.equal(s.results[1].lastDate, null);
  const many = { ...good, requestedLimit: 20, results: Array.from({ length: 50 }, (_, i) => ({ rank: i + 1, keyword: `k${i}`, conversationCount: 1, memoryCount: 1, firstDate: null, lastDate: null })) };
  assert.equal(S(many)!.results.length, 20);
  // through the real route: a malformed payload makes no section
  const si = (await callChat({ persona: "analyst", turns: [turn(Q)], memoryAnalytics: { intent: "memory-analytics", metric: "bad" } }, false)).systemInstruction;
  assert.ok(!si.includes("Memory Analytics Results"));
});
test("17 diagnostic: memoryAnalyticsServerAccepted is correct and reaches the 「全てコピー」 log (counts only)", async () => {
  const ctx = ma.buildMemoryAnalyticsContext(fixture(), Q)!;
  const r = await callChat({ persona: "analyst", turns: [turn(Q)], retrievedMemories: [], memoryAnalytics: ctx });
  const a = r.accepted!;
  assert.equal(a.received, true); assert.equal(a.metric, "keyword_conversation_count"); assert.equal(a.requestedLimit, 10); assert.equal(a.resultCount, 10); assert.ok(a.sectionLength > 0); assert.equal(a.includedInSystemInstruction, true);
  const none = (await callChat({ persona: "analyst", turns: [turn("黄金湯に行きたい")], retrievedMemories: [] })).accepted!;
  assert.deepEqual(none, { received: false, metric: "", requestedLimit: 0, resultCount: 0, sectionLength: 0, includedInSystemInstruction: false });
  const bad = (await callChat({ persona: "analyst", turns: [turn(Q)], memoryAnalytics: { intent: "memory-analytics", metric: "x" } })).accepted!;
  assert.deepEqual(bad, { received: true, metric: "", requestedLimit: 0, resultCount: 0, sectionLength: 0, includedInSystemInstruction: false });
  const store = new Map<string, string>(); const g = globalThis as unknown as { window?: unknown };
  const run = async (search: string) => {
    store.clear(); g.window = { location: { search }, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
    const orig = console.log; console.log = () => {};
    try { await debugLog.appendMemoryAnalyticsAcceptanceNote("gen-test", { ...a, ranking: [{ keyword: "SECRET-KW" }], id: "SECRET-ID" } as unknown as import("./generationDebugProtocol").MemoryAnalyticsServerAccepted); } finally { console.log = orig; }
    return (await debugLog.getConversationDebugLog()).map((e) => e.text).join("\n---\n");
  };
  try {
    const copied = await run("?debugLog=1");
    assert.ok(copied.includes('memoryAnalyticsServerAccepted: {"received":true,"metric":"keyword_conversation_count","requestedLimit":10,"resultCount":10,'), copied);
    assert.ok(!copied.includes("SECRET") && !copied.includes("仕事"), "only the six counts / flags are stored");
    assert.equal(await run(""), "", "nothing without ?debugLog=1");
  } finally { g.window = undefined; }
  const src = require("node:fs").readFileSync(path.join(ROOT, "..", "src/components/ChatScreen.tsx"), "utf8") as string;
  assert.ok(src.includes("if (generationId && debugEnvelope) {") && src.indexOf("appendMemoryAnalyticsAcceptanceNote(generationId") > src.indexOf("appendGenerationDebugEntry({"));
});
test("18 without Analytics the prompt/request is unchanged (normal conversation and Explicit Search turns get none of the new text; debug on/off identical)", async () => {
  const NEW = ["Memory Analytics Results", "keyword_conversation_count", "Memory Analytics Results（保存済みMemory全体の集計結果）"];
  const explicit = ms.buildExplicitSearchContext([mem({ keywords: ["黄金湯"], summary: "黄金湯へ行った" })], "黄金湯について何話した？")!;
  for (const persona of ["companion", "analyst", "coach"]) {
    for (const body of [{ persona, turns: [turn("黄金湯に行きたい")], retrievedMemories: [] }, { persona, turns: [turn("黄金湯について何話した？")], retrievedMemories: [], explicitSearch: explicit }]) {
      await callChat(body, false); const plain = chatRec.req!;
      await callChat(body, true); const debug = chatRec.req!;
      for (const key of ["systemInstruction", "turns", "providerOptions", "maxOutputTokens", "enableWebSearch"]) assert.deepEqual(debug[key], plain[key], `${persona}.${key}`);
      for (const m of NEW) assert.ok(!(plain.systemInstruction as string).includes(m), `${persona}: ${m}`);
    }
  }
  // Explicit Search keeps its own Evidence text (unchanged), and Analytics + Explicit can coexist without conflict
  const si = (await callChat({ persona: "analyst", turns: [turn("x")], retrievedMemories: [{ id: "O", date: "2026-08-10T00:00:00.000Z", summary: "s", keywords: ["k"] }], explicitSearch: explicit, memoryAnalytics: ma.buildMemoryAnalyticsContext(fixture(), Q)! })).systemInstruction;
  assert.ok(si.includes("明示的な検索結果やMemory Analytics Resultsがある場合は、その結果を使って回答する。"));
});

test("19 web search: an Analytics turn never enables Web search (even when needsWebSearch reacts to e.g. TOP10); the same text without Analytics is unchanged", async () => {
  const q = "今までよく出てきたキーワードTOP10は？";
  const { needsWebSearch } = require(path.join(ROOT, "lib/needsWebSearch.js")) as { needsWebSearch: (t: string, prior: boolean) => boolean };
  assert.equal(needsWebSearch(q, false), true, "precondition: this exact phrasing triggers Web search on its own");
  const ctx = ma.buildMemoryAnalyticsContext(fixture(), q)!;
  const withAnalytics = await callChat({ persona: "analyst", turns: [turn(q)], retrievedMemories: [], memoryAnalytics: ctx });
  assert.equal(chatRec.req!.enableWebSearch, false);
  assert.ok(!withAnalytics.systemInstruction.includes("今回のWeb検索指示（このターンのみ）") && withAnalytics.systemInstruction.includes("Memory Analytics Results"));
  assert.ok(withAnalytics.accepted!.includedInSystemInstruction);
  const withoutAnalytics = await callChat({ persona: "analyst", turns: [turn(q)], retrievedMemories: [] });
  assert.equal(chatRec.req!.enableWebSearch, true, "without Analytics the existing Web-search decision is untouched");
  assert.ok(withoutAnalytics.systemInstruction.includes("今回のWeb検索指示（このターンのみ）"));
});
