/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Explicit Memory Search Phase 1のテスト。純粋関数（intent・検索語抽出・検索）と、/api/chatが検索結果を最終contextへ入れること、
 * 通常のAssociative Recall（retrieval.ts）が変わらないことを確認する。
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

const ms = require(path.join(ROOT, "lib/memorySearch.js")) as typeof import("./memorySearch");
const retrieval = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };
type MemoryObject = import("./types").MemoryObject;

let seq = 0;
function mem(o: { summary: string; content: string; keywords: string[]; evidenceQuotes?: string[]; people?: { displayName: string; quote: string }[]; statedAt?: string; conversationId?: string; date?: string }): MemoryObject {
  seq += 1;
  const id = `M${seq}`;
  return {
    id, date: o.date ?? "2026-09-10T00:00:00.000Z", types: ["diary"], conversationId: o.conversationId ?? `C${seq}`, content: o.content, summary: o.summary, keywords: o.keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    ...(o.evidenceQuotes ? { evidenceQuotes: o.evidenceQuotes } : {}),
    ...(o.statedAt ? { statedAt: o.statedAt } : {}),
    ...(o.people ? { personMentions: o.people.map((p, i) => ({ id: `P${seq}-${i}`, groupingKey: p.displayName.toLowerCase(), displayName: p.displayName, assertion: "mention", stated: "explicit", quote: p.quote, statedAt: "2026-09-10T00:00:00.000Z", sourceConversationId: "x", recordedAt: "2026-09-10T00:00:00.000Z", origin: "ai-extracted", schemaVersion: 1 })) } : {}),
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z", metadata: { id, schemaVersion: "0.1", source: "user", createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" },
  } as unknown as MemoryObject;
}

const A = mem({ summary: "さきさんとの仕事について話した", content: "同僚のさきさんとは2023年9月から一緒に仕事をしている", keywords: ["同僚", "仕事"], people: [{ displayName: "さきさん", quote: "同僚のさきさんとは2023年9月から一緒に仕事をしている" }], statedAt: "2026-09-10T03:00:00.000Z" });
const B = mem({ summary: "黄金湯へ行った", content: "昨日は黄金湯に行った", keywords: ["黄金湯", "銭湯"], evidenceQuotes: ["昨日、黄金湯に行った"] });
const C = mem({ summary: "Obsidianを第二の脳として使うことについて考えている", content: "Obsidianで知識を蓄積して第二の脳のように使いたいと考えている", keywords: ["Obsidian", "第二の脳"] });
// 紛らわしい候補：別の同僚、別の仕事の話、一般語
const D = mem({ summary: "同僚のたなかさんと昼食に行った", content: "同僚のたなかさんとランチした", keywords: ["同僚", "ランチ"], people: [{ displayName: "たなかさん", quote: "同僚のたなかさんとランチした" }] });
const E = mem({ summary: "仕事の進め方について考えた", content: "仕事で優先順位をどう付けるか考えた", keywords: ["仕事", "優先順位"] });
const F = mem({ summary: "週末の過ごし方について話した", content: "週末について何をして過ごすかを話した", keywords: ["週末"] });
// 旧Memory：personMentionsもevidenceQuotesも無い（Person Memory v1以前）。contentの中にだけ名前がある
const OLD = mem({ summary: "仕事仲間との関係について", content: "さきさんとは互いに信頼しつつ意識し合っている。距離を取ることになった", keywords: ["人間関係"] });
const ALL = [A, B, C, D, E, F];

const ids = (text: string, all: MemoryObject[] = ALL) => {
  const intent = ms.detectExplicitMemorySearch(text);
  return intent ? ms.searchMemories(all, intent).hits.map((h) => h.memory.id) : null;
};

test("intent 1-6: explicit searches retrieve the right Memory (さきさん / 最近 / 同僚のさきさん / 黄金湯 / 銭湯 / Obsidian)", () => {
  assert.equal(ids("さきさんについて何話した？")![0], A.id);
  assert.equal(ids("最近さきさんについて何話したっけ？")![0], A.id);
  assert.equal(ids("同僚のさきさんについて何話した？")![0], A.id);
  assert.equal(ids("黄金湯について何話した？")![0], B.id);
  assert.equal(ids("銭湯について記録ある？")![0], B.id);
  assert.equal(ids("Obsidianのこと何か残ってる？")![0], C.id);
  // the others from the spec
  assert.equal(ids("黄金湯について前に何話した？")![0], B.id);
  assert.equal(ids("前にフレンチについて話した内容を見たい") !== null, true);
  assert.ok(ids("以前仕事についてどう考えてた？")!.includes(E.id), "検索語「仕事」で仕事の話が見つかる");
});
test("intent 7-8: ordinary conversation is not an explicit search", () => {
  for (const text of ["黄金湯に行きたい", "さきさんと今度仕事する", "Obsidian使ってる", "料理について話しながら楽しめる人と行きたい", "今日は疲れが残ってる", "何話した？", "冷蔵庫に何かあるかな", "明日の予定について話したい", "仕事について考えてる"]) {
    assert.equal(ms.detectExplicitMemorySearch(text), null, text);
  }
});
test("query extraction: search meta words do not dilute the target term", () => {
  const terms = (t: string) => ms.detectExplicitMemorySearch(t)!.terms.map((x) => x.text);
  assert.deepEqual(terms("最近さきさんについて何話したっけ？"), ["さきさん"]);
  assert.deepEqual(terms("黄金湯について前に何話した？"), ["黄金湯"]);
  assert.deepEqual(terms("銭湯について記録ある？"), ["銭湯"]);
  assert.deepEqual(terms("Obsidianのこと何か残ってる？"), ["Obsidian"]);
  assert.deepEqual(terms("前にフレンチについて話した内容を見たい"), ["フレンチ"]);
  assert.deepEqual(terms("以前仕事についてどう考えてた？"), ["仕事"]);
  const rel = ms.detectExplicitMemorySearch("同僚のさきさんについて何話した？")!.terms;
  assert.deepEqual(rel.map((x) => [x.text, x.weak]), [["同僚のさきさん", false], ["同僚", true], ["さきさん", false]]);
  assert.deepEqual(ms.detectExplicitMemorySearch("同僚について何話した？")!.terms.map((x) => [x.text, x.weak]), [["同僚", false]], "a lone relation word is the strong term itself");
});
test("person: 「さきさん」 and 「同僚のさきさん」 both find the Memory; another 同僚 is not mixed in; no identity merging", () => {
  assert.deepEqual(ids("さきさんについて何話した？"), [A.id], "only さきさん's Memory");
  const withRel = ids("同僚のさきさんについて何話した？")!;
  assert.equal(withRel[0], A.id); assert.ok(!withRel.includes(D.id), "a Memory that only matches the weak relation word 同僚 is excluded");
  // honorific difference only: stored as 「さき」, queried as 「さきさん」
  const S = mem({ summary: "仕事の相談", content: "仕事の相談をした", keywords: ["相談"], people: [{ displayName: "さき", quote: "さきに相談した" }] });
  assert.deepEqual(ids("さきさんについて何話した？", [S, B]), [S.id]);
  // different names are never merged
  const T = mem({ summary: "仕事の相談", content: "仕事の相談をした", keywords: ["相談"], people: [{ displayName: "さくら", quote: "さくらに相談した" }] });
  assert.deepEqual(ids("さきさんについて何話した？", [T, B]), []);
  assert.deepEqual(ids("妻について何話した？", [S, T]), [], "さき / さくら are not 妻");
  const W = mem({ summary: "妻と旅行の相談", content: "妻と旅行について相談した", keywords: ["旅行"], people: [{ displayName: "妻", quote: "妻と旅行について相談した" }] });
  assert.deepEqual(ids("妻について何話した？", [S, T, W]), [W.id], "a single-character relation word is searchable");
});
test("existing Memory without personMentions/evidenceQuotes is still found through content (no dependence on Capture changes)", () => {
  assert.deepEqual(ids("さきさんについて何話した？", [OLD, B, C]), [OLD.id]);
  assert.deepEqual(ids("同僚のさきさんについて何話した？", [OLD, B, C]), [OLD.id], "the whole-phrase term misses, the name term hits");
});
test("result count: not capped at 3 (up to EXPLICIT_SEARCH_LIMIT), ranked, weak matches dropped", () => {
  const many = Array.from({ length: 14 }, (_, i) => mem({ summary: `銭湯の話${i}`, content: `銭湯に行った${i}`, keywords: ["銭湯"], date: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
  const intent = ms.detectExplicitMemorySearch("銭湯について何話した？")!;
  const r = ms.searchMemories([...many, A, C], intent);
  assert.equal(r.hits.length, ms.EXPLICIT_SEARCH_LIMIT); assert.equal(r.total, 14);
  assert.ok(ms.EXPLICIT_SEARCH_LIMIT > retrieval.DEFAULT_LIMIT);
  assert.ok(r.hits.every((h) => h.memory.keywords.includes("銭湯")));
});
test("same-conversation Memory is excluded like normal retrieval; no hit -> empty (never padded)", () => {
  const intent = ms.detectExplicitMemorySearch("黄金湯について何話した？")!;
  assert.equal(ms.searchMemories(ALL, intent, { excludeConversationId: B.conversationId }).hits.length, 0);
  assert.deepEqual(ids("存在しない話題について何話した？"), []);
});
test("context payload 9: summary AND detail AND evidence quotes AND keywords AND dates are present, detail is a bounded excerpt", () => {
  const ctx = ms.buildExplicitSearchContext(ALL, "黄金湯について何話した？")!;
  const r = ctx.results[0];
  assert.equal(r.id, B.id); assert.equal(r.summary, "黄金湯へ行った"); assert.equal(r.detail, "昨日は黄金湯に行った");
  assert.deepEqual(r.evidenceQuotes, ["昨日、黄金湯に行った"]); assert.deepEqual(r.keywords, ["黄金湯", "銭湯"]); assert.ok(r.date);
  const a = ms.buildExplicitSearchContext(ALL, "さきさんについて何話した？")!.results[0];
  assert.equal(a.statedAt, "2026-09-10T03:00:00.000Z"); assert.ok(a.detail.includes("2023年9月"));
  const long = mem({ summary: "長い記録", content: "あ".repeat(500) + "ゴールデン銭湯" + "い".repeat(500), keywords: ["銭湯"] });
  const lr = ms.buildExplicitSearchContext([long], "銭湯について何話した？")!.results[0];
  assert.ok(lr.detail.length <= ms.EXPLICIT_SEARCH_DETAIL_MAX + 2 && lr.detail.includes("銭湯"), "excerpt is centred on the match");
  assert.equal(ms.buildExplicitSearchContext(ALL, "黄金湯に行きたい"), null, "no payload for ordinary conversation");
});
test("sanitize: server-side caps; invalid payload is dropped", () => {
  assert.equal(ms.sanitizeExplicitSearchContext(null), null); assert.equal(ms.sanitizeExplicitSearchContext({ terms: [], results: [] }), null);
  const big = { terms: ["x"], total: 99999, results: Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, date: "2026-01-01T00:00:00.000Z", summary: "s".repeat(2000), keywords: Array(40).fill("k"), detail: "d".repeat(5000), evidenceQuotes: Array(9).fill("q".repeat(900)), matchedOn: [] })) };
  const s = ms.sanitizeExplicitSearchContext(big)!;
  assert.equal(s.results.length, ms.EXPLICIT_SEARCH_LIMIT); assert.ok(s.results[0].summary.length <= 401); assert.ok(s.results[0].detail.length <= ms.EXPLICIT_SEARCH_DETAIL_MAX + 5);
  assert.equal(s.results[0].evidenceQuotes.length, ms.EXPLICIT_SEARCH_QUOTES_PER_MEMORY); assert.ok(s.results[0].keywords.length <= 12);
});

async function callChat(body: Json): Promise<string> {
  chatRec.systemInstruction = ""; chatRec.calls = 0;
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  await res.text();
  assert.equal(chatRec.calls, 1);
  return chatRec.systemInstruction;
}
const turn = (content: string) => ({ role: "user", content, timestamp: "2026-10-06T03:00:00.000Z" });
test("chat context 9: the final system instruction carries summary, detail and evidence quotes of the search results, with the Evidence Boundary rules", async () => {
  const ctx = ms.buildExplicitSearchContext(ALL, "黄金湯について何話した？")!;
  const si = await callChat({ persona: "companion", turns: [turn("黄金湯について何話した？")], retrievedMemories: [], explicitSearch: ctx });
  for (const needle of ["保存済みMemoryの検索結果", "黄金湯へ行った", "昨日は黄金湯に行った", "「昨日、黄金湯に行った」", "keywords: 黄金湯, 銭湯", "検索語：黄金湯", "書かれていない内容を補って", "「ユーザー発言の抜粋（逐語）」だけが"]) assert.ok(si.includes(needle), needle);
  // a normally retrieved copy of the same Memory is not duplicated as a summary-only entry
  const retrieved = [{ id: B.id, date: B.date, summary: B.summary, keywords: B.keywords }, { id: C.id, date: C.date, summary: C.summary, keywords: C.keywords }];
  const si2 = await callChat({ persona: "analyst", turns: [turn("黄金湯について何話した？")], retrievedMemories: retrieved, explicitSearch: ctx });
  assert.equal(si2.split("黄金湯へ行った").length - 1, 1, "the explicit result replaces the summary-only copy");
  assert.ok(si2.includes("Obsidianを第二の脳"), "other retrieved Memory still passes through");
});
test("chat context: zero results still tells the model nothing was found (and not to assert 'never talked' or invent records)", async () => {
  const ctx = ms.buildExplicitSearchContext(ALL, "存在しない話題について何話した？")!;
  assert.equal(ctx.results.length, 0);
  const si = await callChat({ persona: "companion", turns: [turn("存在しない話題について何話した？")], explicitSearch: ctx });
  assert.ok(si.includes("一致するものは見つからなかった")); assert.ok(si.includes("「一度も話していない」と断定しない"));
});
test("chat context 10: without explicitSearch the system instruction has no search section (ordinary conversation unchanged)", async () => {
  const si = await callChat({ persona: "companion", turns: [turn("黄金湯に行きたい")], retrievedMemories: [{ id: B.id, date: B.date, summary: B.summary, keywords: B.keywords }] });
  assert.ok(!si.includes("保存済みMemoryの検索結果")); assert.ok(si.includes("関連する過去の記憶"));
  const bad = await callChat({ persona: "companion", turns: [turn("x")], explicitSearch: { terms: "bad", results: 5 } });
  assert.ok(!bad.includes("保存済みMemoryの検索結果"), "a malformed payload fails closed");
});
test("regression 10: normal Associative Recall (retrieval.ts) is untouched — same top-3 behaviour, independent of memorySearch", async () => {
  const pool = [A, B, C, E, F];
  (stubs["./db"] as { getAllMemoryObjects: () => Promise<MemoryObject[]> }).getAllMemoryObjects = async () => pool;
  const normal = await retrieval.retrieveRelevantMemoriesImpl("黄金湯に行きたい", { persona: "companion" });
  assert.equal(normal[0].id, B.id); assert.ok(normal.length <= retrieval.DEFAULT_LIMIT + 1);
  const normalAnalyst = await retrieval.retrieveRelevantMemoriesImpl("Obsidianを使ってる", { persona: "analyst" });
  assert.equal(normalAnalyst[0].id, C.id);
  const src = require("node:fs").readFileSync(path.join(ROOT, "..", "src/lib/memorySearch.ts"), "utf8") as string;
  assert.ok(!/from "\.\/retrieval"/.test(src), "memorySearch does not reuse or touch the normal scoring");
  assert.equal(retrieval.DEFAULT_LIMIT, 3); assert.equal(retrieval.CONVERSATION_MIN_SCORE, 3); assert.equal(retrieval.REFLECTIVE_LIMIT, 6);
});

// ===========================================================================
// P0診断（Conversation Debugger専用の観測。検索挙動・Chat promptには影響しない）
// ===========================================================================
const diag = require(path.join(ROOT, "lib/memorySearchDiagnostics.js")) as typeof import("./memorySearchDiagnostics");
const debugLog = require(path.join(ROOT, "lib/conversationDebugLog.js")) as typeof import("./conversationDebugLog");
type Conversation = import("./types").Conversation;

function conv(id: string, turns: { role: "user" | "ai"; content: string; timestamp: string }[], startedAt = "2026-08-10T14:15:00.000Z"): Conversation {
  return { id, persona: "companion", entryType: "diary", startedAt, turns, status: "captured", memoryObjectIds: [], createdAt: startedAt, updatedAt: startedAt, metadata: { id, schemaVersion: "0.1", source: "user", createdAt: startedAt, updatedAt: startedAt } } as unknown as Conversation;
}
const GOGANE_TEXT = "今日は友人のリュウと銭湯に行った。錦糸町にある黄金湯という銭湯。青じそのイベントを行なっており、色々なグッズが当たるキャンペーンをやっていた。無料でもらった青じそドリンクが個人的に美味しかった。";
const Q = "黄金湯について何話したっけ？";

test("P0 diag 1-2: built only for an explicit search; the extracted terms are recorded", () => {
  assert.equal(diag.buildExplicitSearchDiagnostics(ALL, [], "黄金湯に行きたい"), null);
  const d = diag.buildExplicitSearchDiagnostics(ALL, [], Q)!;
  assert.equal(d.intentDetected, true); assert.deepEqual(d.terms, [{ text: "黄金湯", weak: false }]);
  assert.deepEqual(diag.formatExplicitSearchDiagnostics(null), ["explicitSearch: intent=false (通常会話。診断なし)"]);
});
test("P0 diag 3-5: memory pool counts, candidate/selected counts, selected id/conversationId/source/types/matched field/score", () => {
  const d = diag.buildExplicitSearchDiagnostics(ALL, [], Q, { excludeConversationId: C.conversationId })!;
  assert.equal(d.memory.poolTotal, ALL.length); assert.equal(d.memory.afterCurrentConversationExclusion, ALL.length - 1); assert.equal(d.memory.excludedByCurrentConversation, 1);
  assert.equal(d.memory.candidateCount, 1); assert.equal(d.memory.selectedCount, 1);
  const s = d.memory.selected[0];
  assert.equal(s.id, B.id); assert.equal(s.conversationId, B.conversationId); assert.equal(s.source, "user"); assert.deepEqual(s.types, ["diary"]);
  assert.ok(s.matchedFields.includes("keyword")); assert.deepEqual(s.matchedTerms, ["黄金湯"]); assert.ok(s.score > 0);
  const c = d.memory.termFieldCounts[0];
  assert.equal(c.inAllMemories.keywordExact, 1); assert.equal(c.inAllMemories.summary, 1); assert.equal(c.inAllMemories.content, 1); assert.equal(c.inAllMemories.evidence, 1);
  assert.deepEqual(d.memory.keywordHitMemories.map((m) => m.id), [B.id]);
  // the keyword-hit Memory being excluded as the current conversation is visible
  const ex = diag.buildExplicitSearchDiagnostics(ALL, [], Q, { excludeConversationId: B.conversationId })!;
  assert.equal(ex.memory.selectedCount, 0); assert.equal(ex.memory.keywordHitMemories[0].excludedAsCurrent, true);
  assert.equal(ex.memory.termFieldCounts[0].inAllMemories.keywordExact, 1); assert.equal(ex.memory.termFieldCounts[0].inPool.keywordExact, 0);
  // the selected ids equal the real payload's ids
  assert.deepEqual(d.memory.selected.map((x) => x.id), ms.buildExplicitSearchContext(ALL, Q, { excludeConversationId: C.conversationId })!.results.map((x) => x.id));
});
test("P0 diag 6 + hint: user-turn matches in IndexedDB conversations are counted (id, timestamp, short snippet); cases A / B / C / D", () => {
  const today = conv("CONV-AUG10", [{ role: "user", content: GOGANE_TEXT, timestamp: "2026-08-10T14:15:00.000Z" }, { role: "ai", content: "黄金湯、いいですね", timestamp: "2026-08-10T14:16:00.000Z" }]);
  const other = conv("CONV-OTHER", [{ role: "user", content: "仕事の話", timestamp: "2026-08-11T01:00:00.000Z" }, { role: "ai", content: "黄金湯の話は出ていない", timestamp: "2026-08-11T01:01:00.000Z" }]);
  // B: Conversation has it, Memory side has none
  const b = diag.buildExplicitSearchDiagnostics([E, F], [today, other], Q)!;
  assert.equal(b.conversation.total, 2); assert.equal(b.conversation.matchedCount, 1);
  assert.equal(b.conversation.matches[0].conversationId, "CONV-AUG10"); assert.equal(b.conversation.matches[0].turns[0].timestamp, "2026-08-10T14:15:00.000Z");
  assert.ok(b.conversation.matches[0].turns[0].snippet.includes("黄金湯") && b.conversation.matches[0].turns[0].snippet.length <= 45, "short snippet only, never the full text");
  assert.equal(b.conversation.matches[0].memoriesInIndexedDb, 0); assert.equal(b.memory.selectedCount, 0); assert.ok(b.hint.startsWith("B"));
  assert.equal(b.conversation.perTerm[0].conversations, 1, "AI turns are never matched");
  // A: nowhere
  assert.ok(diag.buildExplicitSearchDiagnostics([E, F], [other], Q)!.hint.startsWith("A"));
  // C: Memory has the word (keyword) but excluded -> selected 0
  assert.ok(diag.buildExplicitSearchDiagnostics(ALL, [], Q, { excludeConversationId: B.conversationId })!.hint.startsWith("C"));
  // D: selected > 0
  assert.ok(diag.buildExplicitSearchDiagnostics(ALL, [today], Q)!.hint.startsWith("D"));
  // the Memory / Reflection belonging to the matched conversation are reported
  const bm = mem({ summary: "黄金湯へ行った", content: "黄金湯に行った", keywords: ["黄金湯"], conversationId: "CONV-AUG10" });
  const refl = { ...mem({ summary: "r", content: "友人のリュウさんと黄金湯を訪れ", keywords: ["黄金湯"], conversationId: "CONV-AUG10" }), metadata: { id: "x", schemaVersion: "0.1", source: "system-generated", createdAt: "", updatedAt: "" } } as unknown as MemoryObject;
  const full = diag.buildExplicitSearchDiagnostics([bm, refl], [today], Q)!;
  assert.equal(full.conversation.matches[0].memoriesInIndexedDb, 1); assert.equal(full.conversation.matches[0].reflectionInIndexedDb, true);
});
test("P0 diag 7-9: the diagnostics never change the search result or the Chat payload (inputs untouched, results identical, no new payload field)", async () => {
  const today = conv("CONV-AUG10", [{ role: "user", content: GOGANE_TEXT, timestamp: "2026-08-10T14:15:00.000Z" }]);
  const memsBefore = JSON.stringify(ALL); const convBefore = JSON.stringify([today]);
  const payloadBefore = JSON.stringify(ms.buildExplicitSearchContext(ALL, Q, { excludeConversationId: "NEW" }));
  diag.buildExplicitSearchDiagnostics(ALL, [today], Q, { excludeConversationId: "NEW" });
  assert.equal(JSON.stringify(ALL), memsBefore); assert.equal(JSON.stringify([today]), convBefore);
  assert.equal(JSON.stringify(ms.buildExplicitSearchContext(ALL, Q, { excludeConversationId: "NEW" })), payloadBefore, "payload identical after running diagnostics");
  // the conversation matches are not part of the search payload
  const payload = ms.buildExplicitSearchContext([E, F], Q)!;
  assert.equal(payload.results.length, 0, "a Conversation-only hit does not become a search result");
  assert.ok(!JSON.stringify(payload).includes("CONV-AUG10"));
  // ordinary conversation: no diagnostics, search behaviour unchanged
  assert.equal(ms.buildExplicitSearchContext(ALL, "黄金湯に行きたい"), null);
  // the Chat prompt is built only from the explicitSearch payload: identical with and without the diagnostics having run
  const ctx = ms.buildExplicitSearchContext(ALL, Q)!;
  const si1 = await callChat({ persona: "companion", turns: [turn(Q)], retrievedMemories: [], explicitSearch: ctx });
  diag.buildExplicitSearchDiagnostics(ALL, [today], Q);
  const si2 = await callChat({ persona: "companion", turns: [turn(Q)], retrievedMemories: [], explicitSearch: ms.buildExplicitSearchContext(ALL, Q)! });
  assert.equal(si1, si2);
  assert.ok(!si1.includes("hint:") && !si1.includes("conversationMatch") && !si1.includes("memoryTermCounts"), "no diagnostics text in the Chat prompt");
});
test("P0 diag: logConversationDebug writes the diagnostics only with ?debugLog=1 and only for an explicit search; Memory/Conversation bodies are not dumped", async () => {
  const today = conv("CONV-AUG10", [{ role: "user", content: GOGANE_TEXT, timestamp: "2026-08-10T14:15:00.000Z" }]);
  const store = new Map<string, string>();
  const g = globalThis as unknown as { window?: unknown };
  const run = async (search: string, text: string) => {
    store.clear();
    g.window = { location: { search }, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
    (stubs["./db"] as { getAllMemoryObjects: () => Promise<MemoryObject[]>; getAllConversations: () => Promise<Conversation[]> }).getAllMemoryObjects = async () => ALL;
    (stubs["./db"] as { getAllConversations: () => Promise<Conversation[]> }).getAllConversations = async () => [today];
    const origLog = console.log; console.log = () => {};
    try { await debugLog.logConversationDebug({ persona: "companion", turns: [{ role: "user", content: text, timestamp: "2026-10-07T00:00:00.000Z" }], retrievedMemories: [], latestUserMessage: text, vaultBackend: null, vaultStatus: "connected", excludeConversationId: "NEW" }); } finally { console.log = origLog; }
    const raw = store.get("tsumugi:conversationDebugLog:v1");
    return raw ? (JSON.parse(raw) as { text: string }[])[0]?.text ?? "" : "";
  };
  try {
    assert.equal(await run("", Q), "", "no ?debugLog=1 -> nothing is written");
    const normal = await run("?debugLog=1", "黄金湯に行きたい");
    assert.ok(normal.includes("explicitSearch: intent=false")); assert.ok(!normal.includes("conversationMatch"));
    const explicit = await run("?debugLog=1", Q);
    for (const needle of ["explicitSearch: intent=true", "terms: 黄金湯", "memory.poolTotal(IndexedDB memoryObjects): 6", "candidateCount: 1 selectedCount: 1", `selected[0] id=${B.id}`, "conversation.total(IndexedDB conversations): 1 matchedByUserTurn=1", "conversationMatch id=CONV-AUG10", "userTurn ts=2026-08-10T14:15:00.000Z", "hint: D?"]) assert.ok(explicit.includes(needle), needle);
    assert.ok(!explicit.includes(GOGANE_TEXT), "the full user turn is never dumped");
    assert.ok(!explicit.includes("昨日は黄金湯に行った"), "Memory content is never dumped");
  } finally { g.window = undefined; }
});

// ===========================================================================
// P0.5：サーバーが受け取ったExplicit Searchの観測（[Server Accepted]。観測専用・promptは不変）
// ===========================================================================
const protocol = require(path.join(ROOT, "lib/generationDebugProtocol.js")) as typeof import("./generationDebugProtocol");
async function callChatDebug(body: Json, debug = true): Promise<{ systemInstruction: string; text: string; accepted?: import("./generationDebugProtocol").ExplicitSearchServerAccepted; envelope?: Json }> {
  chatRec.systemInstruction = ""; chatRec.calls = 0;
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(debug ? { ...body, debugGenerationId: "gen-test" } : body) }));
  const text = await res.text();
  assert.equal(chatRec.calls, 1);
  const i = text.indexOf(protocol.DEBUG_ENVELOPE_DELIMITER);
  const envelope = i >= 0 ? (JSON.parse(text.slice(i + protocol.DEBUG_ENVELOPE_DELIMITER.length)) as { serverAccepted: { explicitSearchServerAccepted?: import("./generationDebugProtocol").ExplicitSearchServerAccepted } }) : undefined;
  return { systemInstruction: chatRec.systemInstruction, text, accepted: envelope?.serverAccepted.explicitSearchServerAccepted, envelope: envelope as unknown as Json };
}
const gogane11 = Array.from({ length: 11 }, (_, i) => mem({ summary: `黄金湯に行った${i}`, content: `昨日、黄金湯に行った${i}`, keywords: ["黄金湯", "銭湯"], evidenceQuotes: ["昨日、黄金湯に行った"] }));

test("P0.5 observe 1: no explicitSearch -> received=false, resultCount=0, sectionLength=0, includedInSystemInstruction=false", async () => {
  const r = await callChatDebug({ persona: "analyst", turns: [turn("黄金湯に行きたい")], retrievedMemories: [] });
  assert.deepEqual(r.accepted, { received: false, terms: [], total: 0, resultCount: 0, sectionLength: 0, includedInSystemInstruction: false });
});
test("P0.5 observe 2: 黄金湯 fixture (total=11, results=10) -> received, terms, total, resultCount, sectionLength>0, included", async () => {
  const ctx = ms.buildExplicitSearchContext(gogane11, Q)!;
  assert.equal(ctx.total, 11); assert.equal(ctx.results.length, 10);
  const r = await callChatDebug({ persona: "analyst", turns: [turn(Q)], retrievedMemories: [], explicitSearch: JSON.parse(JSON.stringify(ctx)) });
  const a = r.accepted!;
  assert.equal(a.received, true); assert.deepEqual(a.terms, ["黄金湯"]); assert.equal(a.total, 11); assert.equal(a.resultCount, 10);
  assert.ok(a.sectionLength > 0); assert.equal(a.includedInSystemInstruction, true);
  assert.ok(r.systemInstruction.includes("## ユーザーが明示的に探している過去のMemory"), "and the section really is in the instruction handed to the provider");
  // the debug field carries counts only: no Memory body, quotes, keywords or ids
  const dump = JSON.stringify(r.envelope);
  const accepted = JSON.stringify(a);
  assert.ok(!accepted.includes("昨日、黄金湯に行った") && !accepted.includes("銭湯") && !accepted.includes(gogane11[0].id));
  assert.ok(dump.includes("explicitSearchServerAccepted"));
});
test("P0.5 observe 3: 0-result search -> received, resultCount=0, the 0-result section exists and is included", async () => {
  const ctx = ms.buildExplicitSearchContext([E, F], Q)!;
  assert.equal(ctx.results.length, 0);
  const r = await callChatDebug({ persona: "companion", turns: [turn(Q)], retrievedMemories: [], explicitSearch: ctx });
  const a = r.accepted!;
  assert.equal(a.received, true); assert.deepEqual(a.terms, ["黄金湯"]); assert.equal(a.total, 0); assert.equal(a.resultCount, 0);
  assert.ok(a.sectionLength > 0 && r.systemInstruction.includes("一致するものは見つからなかった")); assert.equal(a.includedInSystemInstruction, true);
  // a malformed payload is "received" but rejected by sanitize -> visible as resultCount 0 / not included
  const bad = (await callChatDebug({ persona: "companion", turns: [turn(Q)], explicitSearch: { terms: "bad", results: 5 } })).accepted!;
  assert.deepEqual(bad, { received: true, terms: [], total: 0, resultCount: 0, sectionLength: 0, includedInSystemInstruction: false });
});
test("P0.5 observe 4: the observation does not change the prompt (instruction identical with/without debugGenerationId; the normal response has no envelope)", async () => {
  const ctx = ms.buildExplicitSearchContext(gogane11, Q)!;
  for (const persona of ["companion", "analyst"]) {
    for (const explicit of [undefined, ctx]) {
      const body = { persona, turns: [turn(Q)], retrievedMemories: [], ...(explicit ? { explicitSearch: explicit } : {}) };
      const plain = await callChatDebug(body, false);
      const debug = await callChatDebug(body, true);
      assert.equal(debug.systemInstruction, plain.systemInstruction, `${persona} explicit=${!!explicit}`);
      assert.ok(!plain.text.includes(protocol.DEBUG_ENVELOPE_DELIMITER) && plain.accepted === undefined, "the normal response is unchanged");
      assert.ok(debug.accepted !== undefined);
    }
  }
});

// ---- P0.5b：「Conversation Debugger → 全てコピー」（conversationDebugLog）へ載せる ----
async function withDebugWindow<T>(search: string, fn: (store: Map<string, string>) => Promise<T>): Promise<T> {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { window?: unknown };
  g.window = { location: { search }, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
  const origLog = console.log; console.log = () => {};
  try { return await fn(store); } finally { console.log = origLog; g.window = undefined; }
}
/** ConversationDebugPanelの「全てコピー」と同じ読み方：getConversationDebugLog()のtextを連結する。 */
async function copyAll(): Promise<string> { return (await debugLog.getConversationDebugLog()).map((e) => e.text).join("\n\n---\n\n"); }

test("P0.5b 1: a received explicitSearchServerAccepted is appended as one line to the log that 「全てコピー」 reads", async () => {
  const ctx = ms.buildExplicitSearchContext(gogane11, Q)!;
  const r = await callChatDebug({ persona: "analyst", turns: [turn(Q)], retrievedMemories: [], explicitSearch: ctx });
  await withDebugWindow("?debugLog=1", async () => {
    await debugLog.appendExplicitSearchAcceptanceNote("gen-test", r.accepted!);
    const copied = await copyAll();
    assert.ok(copied.includes('explicitSearchServerAccepted: {"received":true,"terms":["黄金湯"],"total":11,"resultCount":10,'), copied);
    assert.ok(copied.includes('"includedInSystemInstruction":true}'));
    assert.equal(copied.split("explicitSearchServerAccepted:").length - 1, 1, "exactly one line");
    // the pre-existing per-turn debug entry and this note coexist in the same copied log
    assert.equal((await debugLog.getConversationDebugLog()).length, 1);
  });
});
test("P0.5b 2: nothing is appended without ?debugLog=1 (normal use)", async () => {
  await withDebugWindow("", async (store) => {
    await debugLog.appendExplicitSearchAcceptanceNote("gen-test", { received: true, terms: ["黄金湯"], total: 11, resultCount: 10, sectionLength: 1528, includedInSystemInstruction: true });
    assert.equal(store.size, 0); assert.equal((await debugLog.getConversationDebugLog()).length, 0);
  });
});
test("P0.5b 3: only the six whitelisted values are stored — no Memory body, evidence quotes, keywords or ids, even if the object has extras", async () => {
  await withDebugWindow("?debugLog=1", async () => {
    const dirty = { received: true, terms: ["黄金湯"], total: 11, resultCount: 10, sectionLength: 1528, includedInSystemInstruction: true, results: [{ id: "SECRET-ID", summary: "SECRET-SUMMARY", detail: "SECRET-DETAIL", evidenceQuotes: ["SECRET-QUOTE"], keywords: ["SECRET-KW"] }], id: "SECRET-ID2" };
    await debugLog.appendExplicitSearchAcceptanceNote("gen-test", dirty as unknown as Parameters<typeof debugLog.appendExplicitSearchAcceptanceNote>[1]);
    const copied = await copyAll();
    for (const secret of ["SECRET", "summary", "detail", "evidenceQuotes", "keywords"]) assert.ok(!copied.includes(secret), secret);
    assert.ok(copied.includes('"received":true') && copied.includes('"resultCount":10'));
  });
});
test("P0.5b 4: provider request (systemInstruction, turns, providerOptions, maxOutputTokens, enableWebSearch) is identical with/without the debug envelope", async () => {
  const ctx = ms.buildExplicitSearchContext(gogane11, Q)!;
  for (const persona of ["companion", "analyst"]) {
    const body = { persona, turns: [turn(Q)], retrievedMemories: [], explicitSearch: ctx };
    await callChatDebug(body, false); const plain = chatRec.req!;
    await callChatDebug(body, true); const debug = chatRec.req!;
    for (const key of ["systemInstruction", "turns", "providerOptions", "maxOutputTokens", "enableWebSearch", "model"]) assert.deepEqual(debug[key], plain[key], `${persona}.${key}`);
  }
});
test("P0.5b 5: ChatScreen wires the note only inside the debug-envelope branch (generationId && debugEnvelope), after appendGenerationDebugEntry", () => {
  const src = require("node:fs").readFileSync(path.join(ROOT, "..", "src/components/ChatScreen.tsx"), "utf8") as string;
  const a = src.indexOf("appendGenerationDebugEntry({"); const n = src.indexOf("appendExplicitSearchAcceptanceNote(generationId");
  assert.ok(a > 0 && n > a, "note comes after appendGenerationDebugEntry");
  const block = src.slice(src.lastIndexOf("if (generationId && debugEnvelope) {", a), n + 200);
  assert.ok(block.includes("if (generationId && debugEnvelope) {") && block.includes("explicitSearchServerAccepted"), "inside the debug branch");
  assert.equal(src.split("appendExplicitSearchAcceptanceNote(").length - 1, 1, "single call site");
});
