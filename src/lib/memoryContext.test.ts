/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Conversation quality step 1 (memoryContext.ts): the people and one quote of the user's own words added to a selected Memory, the chat route's
 * check and display of them, and the time filter that keeps the user's own past views. Fictional people and events only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
const rec: { systemInstruction: string } = { systemInstruction: "" };
const fakeProvider = {
  async generateStream(req: { systemInstruction?: string }) {
    rec.systemInstruction = req.systemInstruction ?? "";
    return (async function* () { yield { text: "ok", finishReason: "stop" as const }; })();
  },
};
type MemoryObject = import("./types").MemoryObject;
type RetrievedMemory = import("./types").RetrievedMemory;
let POOL: MemoryObject[] = [];
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveRequestedProvider: () => "gemini" },
  "./db": { getAllMemoryObjects: async () => POOL, getAllConversations: async () => [], getMemoryObject: async (id: string) => POOL.find((m) => m.id === id) },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn() },
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown; _resolveFilename: (request: string, ...rest: unknown[]) => string };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "@/lib/ai/resolve") return stubs[request];
  if ((parent?.filename?.startsWith(ROOT) ?? false) && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const mc = require(path.join(ROOT, "lib/memoryContext.js")) as typeof import("./memoryContext");
const retrieval = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };

const at = (d: string) => `${d}T12:00:00.000Z`;
function mem(id: string, day: string, keywords: string[], summary: string, quotes: string[], person?: string, emotion = false): MemoryObject {
  return {
    id, date: at(day), statedAt: at(day), types: emotion ? ["conversation", "emotion"] : ["conversation"], conversationId: `c-${id}`, content: `${summary}（本文）`, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: quotes,
    ...(person ? { personMentions: [{ id: `pm-${id}`, groupingKey: person, displayName: person, assertion: "mention", stated: "explicit", quote: quotes[0] ?? summary, statedAt: at(day), sourceConversationId: `c-${id}`, recordedAt: at(day), origin: "ai-extracted", schemaVersion: 1 }] } : {}),
    createdAt: at(day), updatedAt: at(day), metadata: { id: `meta-${id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at(day), updatedAt: at(day) },
  } as unknown as MemoryObject;
}
// The summary alone does not say what the user meant; the user's words do.
const FUTURE = mem("f1", "2026-09-10", ["みなとさん", "関係"], "みなとさんとの関係について、先の見通しが立たないと話した。", ["みなとさんとは、正直もう未来はないと思ってる。でも嫌いになったわけじゃない。"], "みなとさん", true);
const MINATO_TRIP = mem("f2", "2026-10-02", ["みなとさん", "旅行"], "みなとさんと秋に旅行へ行く計画を話した。", ["みなとさんと秋に旅行へ行く計画を話した。"], "みなとさん");
const YUKINO = mem("o1", "2026-10-05", ["ゆきのさん", "将来"], "ゆきのさんと将来の未来の話をした。", ["ゆきのさんとは未来の話で盛り上がった。"], "ゆきのさん", true);
const PRICE = mem("p1", "2026-06-01", ["カフェ", "価格"], "近所のカフェは今の価格だとランチが千円だと話した。", ["近所のカフェ、今はランチ千円。"]);
const OWN_NOW = mem("v1", "2026-08-20", ["一人の時間"], "今は一人の時間が大事だと感じていると話した。", ["今は一人の時間が一番大事だと感じる。"]);
const HOME_NOW = mem("h1", "2026-08-21", ["住まい", "駅"], "今の住まいは駅から歩いて二十分だと話した。", ["今の住まいは駅から二十分。"]);

const LATEST = "みなとさんとこの先どうなるのか、ずっと考えてる";
const TURNS = ["昨日みなとさんと少しだけ会った", LATEST];
const T = "2026-11-08T03:00:00.000Z";
async function prompt(body: Record<string, unknown>): Promise<string> {
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  await res.text();
  return rec.systemInstruction;
}
const chatBody = (latest: string, retrievedMemories: RetrievedMemory[], persona = "analyst") => ({ persona, turns: [{ role: "user", content: latest, timestamp: T }], retrievedMemories });

test("a past 「未来はない」 view about the person of the turn is selected, with the person and the user's own words, although the turn never says 未来", async () => {
  POOL = [FUTURE, MINATO_TRIP, YUKINO, PRICE, OWN_NOW, HOME_NOW];
  const got = await retrieval.retrieveRelevantMemoriesImpl(LATEST, { persona: "analyst", excludeConversationId: "now", recentUserTurnsTexts: TURNS, includeContext: true });
  const future = got.find((m) => m.id === "f1");
  assert.ok(future, JSON.stringify(got.map((m) => m.id)));
  assert.deepEqual(future!.persons, ["みなとさん"]);
  assert.equal(future!.quote, "みなとさんとは、正直もう未来はないと思ってる。");
  // another person's record is not brought in, even though it says 未来
  assert.ok(!got.some((m) => m.id === "o1"));
  // the content of a Memory is never carried
  assert.ok(!JSON.stringify(got).includes("（本文）"));
});

test("without includeContext (Connect, debug log) the result is exactly the previous shape, and the selection is the same either way", async () => {
  POOL = [FUTURE, MINATO_TRIP, YUKINO, PRICE, OWN_NOW, HOME_NOW];
  const options = { persona: "analyst" as const, excludeConversationId: "now", recentUserTurnsTexts: TURNS };
  const plain = await retrieval.retrieveRelevantMemoriesImpl(LATEST, options);
  const withCtx = await retrieval.retrieveRelevantMemoriesImpl(LATEST, { ...options, includeContext: true });
  assert.deepEqual(withCtx.map((m) => m.id), plain.map((m) => m.id));
  for (const m of plain) assert.ok(!("quote" in m) && !("persons" in m), m.id);
  for (const persona of ["companion", undefined] as const) {
    const a = await retrieval.retrieveRelevantMemoriesImpl("みなとさんのこと", { persona, excludeConversationId: "now", recentUserTurnsTexts: ["みなとさんのこと"] });
    const b = await retrieval.retrieveRelevantMemoriesImpl("みなとさんのこと", { persona, excludeConversationId: "now", recentUserTurnsTexts: ["みなとさんのこと"], includeContext: true });
    assert.deepEqual(b.map((m) => m.id), a.map((m) => m.id));
    assert.ok(a.every((m) => !("quote" in m) && !("persons" in m)));
    assert.ok(b.some((m) => m.persons?.includes("みなとさん")), String(persona));
  }
});

test("a quote is sent only when the summary does not already say it, and at most 3 a turn, in the order of the selection", () => {
  assert.equal(mc.memoryQuote(MINATO_TRIP, [LATEST]), undefined);
  assert.equal(mc.memoryQuote({ summary: "s", evidenceQuotes: [] }, [LATEST]), undefined);
  const long = "あ".repeat(200);
  assert.equal(mc.memoryQuote({ summary: "要約", evidenceQuotes: [long] }, [])!.length, mc.MEMORY_CONTEXT_QUOTE_MAX_CHARS + 1);
  // the sentence closest to the turn is taken
  assert.equal(mc.memoryQuote({ summary: "週末の話", evidenceQuotes: ["朝から雨だった。午後は図書館で本を借りた。"] }, ["図書館の本"]), "午後は図書館で本を借りた。");
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, quote: `q${i}` }));
  assert.deepEqual(mc.limitMemoryQuotes(five).map((m) => m.quote), ["q0", "q1", "q2", undefined, undefined]);
});

test("the chat route checks what the client sent: strings only, clipped, at most 2 people and 3 quotes", () => {
  const base = { date: at("2026-09-01"), summary: "s", keywords: [] };
  const cleaned = mc.sanitizeMemoryContext([
    { ...base, id: "a", quote: "x".repeat(500), persons: ["a", 3, "", "b", "c"] as unknown as string[] },
    { ...base, id: "b", quote: 42 as unknown as string },
    { ...base, id: "c", quote: "two" },
    { ...base, id: "d", quote: "three" },
    { ...base, id: "e", quote: "four" },
  ]);
  assert.equal(Array.from(cleaned[0].quote!).length, mc.MEMORY_CONTEXT_QUOTE_MAX_CHARS + 1);
  assert.deepEqual((cleaned[0] as RetrievedMemory).persons, ["a", "b"]);
  assert.ok(!("quote" in cleaned[1]));
  assert.deepEqual(cleaned.map((m) => m.quote ? "q" : "-"), ["q", "-", "q", "q", "-"]);
});

test("the prompt shows the person and the user's words under the Memory, says the words are the user's own, and that a past view is of that day", async () => {
  POOL = [FUTURE, MINATO_TRIP, YUKINO, PRICE, OWN_NOW, HOME_NOW];
  const got = await retrieval.retrieveRelevantMemoriesImpl(LATEST, { persona: "analyst", excludeConversationId: "now", recentUserTurnsTexts: TURNS, includeContext: true });
  const si = await prompt(chatBody(LATEST, got));
  assert.ok(si.includes("みなとさんとの関係について、先の見通しが立たないと話した。"), si);
  assert.ok(si.includes("  話題の人物：みなとさん"));
  assert.ok(si.includes("  本人の発言（当時の逐語の抜粋）：「みなとさんとは、正直もう未来はないと思ってる。」"));
  assert.ok(si.includes(mc.MEMORY_CONTEXT_NOTE) && si.includes(mc.MEMORY_PAST_VIEW_NOTE));
  assert.ok(!si.includes("（本文）"));
  assert.ok(!si.includes("ゆきのさん"));
  // a client without the new values: no person / quote lines and no note about them (the past-view note stays)
  const old = await prompt(chatBody(LATEST, got.map((m) => { const rest = { ...m }; delete rest.quote; delete rest.persons; return rest; })));
  assert.ok(!old.includes("話題の人物") && !old.includes("本人の発言（当時") && !old.includes(mc.MEMORY_CONTEXT_NOTE));
  assert.ok(old.includes(mc.MEMORY_PAST_VIEW_NOTE));
});

test("time filter without web search: outside, changing facts stay out; the user's own past view with 今は stays in; a quote naming a price is not sent", async () => {
  const toRet = (m: MemoryObject, extra: Partial<RetrievedMemory> = {}): RetrievedMemory => ({ id: m.id, date: m.date, summary: m.summary, keywords: m.keywords, source: "ai-capture", ...extra });
  const latest = "なんだか疲れてる";
  const si = await prompt(chatBody(latest, [toRet(PRICE), toRet(OWN_NOW), toRet(HOME_NOW), toRet(FUTURE, { quote: "あの店の価格は前と同じだった。" })]));
  assert.ok(!si.includes(PRICE.summary), "outside fact (価格)");
  assert.ok(!si.includes(HOME_NOW.summary), "a present-tense record that is not the user's own view");
  assert.ok(si.includes(OWN_NOW.summary), "the user's own past view");
  assert.ok(si.includes(FUTURE.summary) && !si.includes("あの店の価格"), "the Memory stays, the quote naming a price goes");
  assert.ok(si.includes(mc.MEMORY_PAST_VIEW_NOTE));
  // a quote is checked like a summary: a present-tense outside fact goes, the user's own present-tense view stays (Codex on PR #31)
  const cafe = await prompt(chatBody(latest, [toRet(PRICE, { summary: "近所のカフェについて話した。", keywords: ["カフェ"], quote: "今はランチが千円。" }), toRet(OWN_NOW, { summary: "一人で過ごした週末の話をした。", keywords: ["週末"], quote: "今は一人の時間が一番大事だと感じる。" })]));
  assert.ok(cafe.includes("近所のカフェについて話した。") && !cafe.includes("今はランチが千円"), cafe);
  assert.ok(cafe.includes("「今は一人の時間が一番大事だと感じる。」"));
  assert.equal(mc.withoutOutsideFactQuote({ quote: "次回の上映は土曜。" }).quote, undefined);
  assert.equal(mc.isTimeDependentMemory({ summary: "最新モデルが欲しいと思う", keywords: [] }), true);
  assert.equal(mc.isTimeDependentMemory({ summary: "次回の打ち合わせは月曜", keywords: [] }), true);
  assert.equal(mc.isTimeDependentMemory({ summary: "次回はもっと早く寝ようと決めた", keywords: [] }), false);
  // the own-view exemption belongs to the sentence that says "now": an opinion elsewhere (another sentence, the quote) does not exempt a present-tense fact (Codex on PR #31)
  assert.equal(mc.isTimeDependentMemory({ summary: "今の関係のままでいいと思うと話した。", keywords: [] }), false);
  assert.equal(mc.isTimeDependentMemory({ summary: "近所のカフェは今はランチが千円だと話した。", keywords: ["カフェ"] }), true);
  assert.equal(mc.isTimeDependentMemory({ summary: "店の雰囲気が好き。今はランチが千円。", keywords: [] }), true);
  assert.equal(mc.isTimeDependentMemory({ summary: "仕事の話をした。", keywords: ["今の会社"] }), true);
  const unrelated = await prompt(chatBody(latest, [toRet(PRICE, { summary: "近所のカフェは今はランチが千円だと話した。", keywords: ["カフェ"], quote: "この店の雰囲気が好き。" })]));
  assert.ok(!unrelated.includes("ランチが千円") && !unrelated.includes("雰囲気が好き"), unrelated);
  assert.equal(mc.withoutOutsideFactQuote({ quote: "雰囲気が好き。今はランチが千円。" }).quote, undefined);
});

test("time filter: the user's own past wish or correction with 今の stays in (summary and quote); a present state, a present wish and a fact that goes stale with the day stay out", async () => {
  const kept = (summary: string) => assert.equal(mc.isTimeDependentMemory({ summary, keywords: [] }), false, summary);
  const out = (summary: string) => assert.equal(mc.isTimeDependentMemory({ summary, keywords: [] }), true, summary);
  // 1. the user's correction of a past reason: a wish of that time, not today's state
  kept("本当は今のチームを離れたくなかった");
  kept("転職をやめた理由を言い直し、本当は今のチームを離れたくなかったからだと話した。");
  assert.equal(mc.withoutOutsideFactQuote({ quote: "給料って言ったけど、本当は今のチームを離れたくなかったからなんだ" }).quote, "給料って言ったけど、本当は今のチームを離れたくなかったからなんだ");
  kept("本当は今の仕事を続けたかったと話した。");
  kept("今の部署に残ってほしかったと話した。");
  // 2. a present state that can go stale: still out
  out("今の会社に勤めている");
  out("今の会社に勤めていた");
  out("今の会社に3年前に入ったと話した。");
  assert.equal(mc.withoutOutsideFactQuote({ quote: "今の会社に勤めてる" }).quote, undefined);
  // 3. a past wish told with a thought word (as before)
  kept("以前は今の仕事を辞めたいと思っていた");
  // 4. a changed view (as before: a thought word)
  kept("あのときはそう思ったけれど、今は違う");
  // a present wish is today's view of a state: out, as before (only past forms are exempt)
  out("今は会社を辞めたい");
  // adjectives / まったく are not wishes
  out("今の部屋は冷たかった");
  out("今の鞄は重たかった");
  out("今のチームには不満がまったくなかった");
  out("今の部屋は煙たかった");
  out("今の靴はかたかった");
  // a wish exempts only its own clause: a present fact joined to it with 、 / けど / ながら stays out (summary and quote)
  out("今の会社に勤めながら、本当は転職したかったと話した。");
  out("次回の検診は12月3日で、本当は休みたかった。");
  assert.equal(mc.withoutOutsideFactQuote({ quote: "今は大阪に住んでて、ほんとは東京に住みたかったんだけど" }).quote, undefined);
  kept("給料って言ったけど、本当は今のチームを離れたくなかったからなんだ");
  kept("本当は今のチームにいたかった");
  // 8. a fact that goes stale when the day changes: out, a wish in another sentence does not exempt it (the exemption is per sentence)
  out("次回の検診は12月3日。");
  out("現在は大阪に住んでいる。");
  out("前は東京に住みたかった。現在は大阪に住んでいる。");
  // a present-tense keyword and an outside fact stay out whatever the summary says
  assert.equal(mc.isTimeDependentMemory({ summary: "本当は今のチームを離れたくなかった", keywords: ["今の会社"] }), true);
  assert.equal(mc.isTimeDependentMemory({ summary: "今の価格で買いたかった", keywords: [] }), true);
  // the prompt: the correction (summary and the user's words) reaches a turn without web search; the present state does not
  const toRet = (id: string, summary: string, quote?: string): RetrievedMemory => ({ id, date: "2026-09-13", summary, keywords: ["転職"], source: "ai-capture", ...(quote ? { quote } : {}) });
  const si = await prompt(chatBody("転職をやめた理由って何だったっけ", [
    toRet("m-correct", "転職をやめた理由を言い直し、本当は今のチームを離れたくなかったからだと話した。", "給料って言ったけど、本当は今のチームを離れたくなかったからなんだ"),
    toRet("m-state", "今の会社に勤めていると話した。"),
  ]));
  assert.ok(si.includes("本当は今のチームを離れたくなかったからだと話した。") && si.includes("「給料って言ったけど、本当は今のチームを離れたくなかったからなんだ」"), si);
  assert.ok(!si.includes("今の会社に勤めていると話した。"), "a present state stays out");
});
