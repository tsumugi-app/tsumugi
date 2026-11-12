/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * P1-F tests (fictional data only: みおさん / けんたさん are made up):
 *   - chat Retrieval puts the AI's diary reflections after the user's own records; other callers (Connect) keep the old order
 *   - the chat prompt: the order of the material for questions about the user's own past, opinions still allowed, the reflection label
 *   - the debug provenance (`?debugLog=1`): every route, ids, kinds, duplicates, the user's later reasons / corrections, what the route did not pass;
 *     the prompt, the reply and the retrieval are the same with the debug on or off
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
let pool: MemoryObject[] = [];
const rec: { systemInstruction: string } = { systemInstruction: "" };
const fakeProvider = {
  async generateStream(req: { systemInstruction?: string }) {
    rec.systemInstruction = req.systemInstruction ?? "";
    return (async function* () { yield { text: "返答です。", finishReason: "stop" as const }; })();
  },
};
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveRequestedProvider: () => "gemini" },
  "./db": { getAllMemoryObjects: async () => pool, getAllConversations: async () => [], getMemoryObject: async (id: string) => pool.find((m) => m.id === id) },
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
const r = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const prov = require(path.join(ROOT, "lib/chatContextProvenance.js")) as typeof import("./chatContextProvenance");
const voice = require(path.join(ROOT, "lib/conversationVoice.js")) as typeof import("./conversationVoice");
const protocol = require(path.join(ROOT, "lib/generationDebugProtocol.js")) as typeof import("./generationDebugProtocol");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };

let n = 0;
function mem(o: { id: string; conv: string; summary: string; keywords: string[]; quotes?: string[]; reflection?: boolean; day?: number; links?: unknown[] }): MemoryObject {
  n += 1;
  const at = `2026-0${1 + ((o.day ?? n) % 9)}-1${(o.day ?? n) % 10}T12:00:00.000Z`;
  return {
    id: o.id, date: at, statedAt: at, types: o.reflection ? ["insight"] : ["conversation"], conversationId: o.conv,
    content: o.summary, summary: o.summary, keywords: o.keywords, themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: o.links ?? [],
    ...(o.quotes ? { evidenceQuotes: o.quotes } : {}),
    createdAt: at, updatedAt: at, metadata: { id: `meta-${o.id}`, source: o.reflection ? "system-generated" : "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

// the user's conclusion, a reflection of the same day that reads a different motive into it, the user's later explanation, other records
const own = mem({ id: "own-conclusion", conv: "c-a", day: 1, summary: "みおさんとの関係に未来がないと思い、距離を置くことにした", keywords: ["みおさん", "距離"], quotes: ["みおさんとの関係に未来がないと思う。距離を置くことにした。"] });
const reflection = mem({ id: "refl-same-day", conv: "c-a", day: 1, reflection: true, keywords: ["みおさん", "関係", "考え方"],
  summary: "みおさんとの関係について、自分が本当は何を望んでいるのか、その考え方が少しずつ変わってきた一日だった。寂しさを埋めたかったのかもしれない。" });
const later = mem({ id: "own-later-reason", conv: "c-b", day: 5, summary: "未来がないと言ったのは、来年転勤で住む場所が離れるからだった", keywords: ["みおさん", "転勤"], quotes: ["未来がないと言ったのは、来年転勤で住む場所が離れるからだ。"] });
const lonelyReflection = mem({ id: "refl-other-day", conv: "c-r", day: 7, reflection: true, keywords: ["みおさん", "関係"], summary: "みおさんとの関係で何を望んでいたのか考えた日の振り返り。" });
const others = [
  mem({ id: "d1", conv: "c-d1", day: 2, summary: "みおさんと話して自分の気持ちを考えた", keywords: ["みおさん"] }),
  mem({ id: "d2", conv: "c-d2", day: 3, summary: "みおさんとの関係で何を大事にしたいか考えた", keywords: ["みおさん"] }),
  mem({ id: "d3", conv: "c-d3", day: 4, summary: "けんたさんと昼ご飯を食べた", keywords: ["けんたさん"] }),
];
const POOL = [own, reflection, later, lonelyReflection, ...others];
const QA = "以前、みおさんとの関係について自分は何を望んでいて、その後どう考え方が変わったと思う？";
const QB = "以前、みおさんとの関係に未来がないと言ったけど、なぜそう考えていたんだっけ？";
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("before: without the chat option (as Connect calls it) the reflection outranks the user's own conclusion, unchanged", async () => {
  pool = POOL;
  const got = ids(await r.retrieveRelevantMemoriesImpl(QA, {}));
  assert.equal(got[0], "refl-same-day", "the old order is kept for other callers");
  const expected = POOL.map((m) => ({ m, s: r.scoreMemory(m, QA) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.m.id);
  assert.deepEqual(got.slice(0, 3), expected, "the direct matches are exactly the score order");
  assert.ok(!fs.readFileSync(path.join(ROOT, "../src/lib/connect.ts"), "utf8").includes("deferReflections"), "Connect does not pass the chat option");
  assert.ok(!fs.readFileSync(path.join(ROOT, "../src/lib/capture.ts"), "utf8").includes("deferReflections"), "Capture does not pass the chat option");
});

test("1 a reflection that reads another motive into the user's explicit conclusion does not reach the chat over it (abstract question A)", async () => {
  pool = POOL;
  let trace: import("./chatContextProvenance").ReflectionTrace | null = null;
  const got = await r.retrieveRelevantMemoriesImpl(QA, { deferReflections: true, limit: 6, onReflectionTrace: (t) => { trace = t; } });
  const list = ids(got);
  assert.ok(list.includes("own-conclusion") && list.includes("own-later-reason"), list.join(","));
  assert.ok(!list.includes("refl-same-day"), "the reflection of the same conversation is not sent with the user's own record");
  const firstReflection = got.findIndex((m) => m.source === "system-generated");
  const lastOwn = got.map((m) => m.source).lastIndexOf("ai-capture");
  assert.ok(firstReflection === -1 || firstReflection > lastOwn, "reflections only after the user's records");
  assert.ok(trace !== null);
  const t = trace as unknown as import("./chatContextProvenance").ReflectionTrace;
  assert.equal(t.asksAboutReflection, false);
  assert.ok(t.dropped.some((d) => d.memoryId === "refl-same-day" && d.why.includes("同じ会話")));
});

test("2 a concrete reason question (B) gets the user's own conclusion and later reason; a reflection only fills a slot that is left", async () => {
  pool = POOL;
  const got = await r.retrieveRelevantMemoriesImpl(QB, { deferReflections: true, limit: 6 });
  const list = ids(got);
  assert.ok(list.includes("own-conclusion") && list.includes("own-later-reason"), list.join(","));
  assert.ok(!list.includes("refl-same-day"));
  // the other day's reflection has no record of its own here, and a slot is left: it may come, but last
  if (list.includes("refl-other-day")) assert.equal(list.indexOf("refl-other-day"), list.filter((id) => !id.startsWith("refl-")).length);
  // with three slots, the user's records fill them
  const three = ids(await r.retrieveRelevantMemoriesImpl(QB, { deferReflections: true }));
  assert.ok(three.every((id) => !id.startsWith("refl-")), three.join(","));
});

test("3 asking about the reflection itself still finds it (the old order)", async () => {
  pool = POOL;
  let trace: import("./chatContextProvenance").ReflectionTrace | null = null;
  const q = "みおさんとの関係について、あの日の振り返りには何て書いてあった？";
  const got = ids(await r.retrieveRelevantMemoriesImpl(q, { deferReflections: true, onReflectionTrace: (t) => { trace = t; } }));
  assert.deepEqual(got, ids(await r.retrieveRelevantMemoriesImpl(q, {})), "same as without the option");
  assert.ok(got.some((id) => id.startsWith("refl-")));
  assert.equal((trace as unknown as { asksAboutReflection: boolean }).asksAboutReflection, true);
  assert.ok(r.asksAboutReflection("日記に何て書いた？") && !r.asksAboutReflection("みおさんのことどう思う？"));
});

test("4 the analyst path (person-aware selection) also puts reflections after the user's records, without refilling", async () => {
  pool = POOL;
  const before = ids(await r.retrieveRelevantMemoriesImpl(QA, { persona: "analyst", limit: 6 }));
  const after = ids(await r.retrieveRelevantMemoriesImpl(QA, { persona: "analyst", limit: 6, deferReflections: true }));
  assert.ok(!after.includes("refl-same-day") || !after.includes("own-conclusion"));
  assert.ok(after.length <= before.length, "no record is added");
  const firstRefl = after.findIndex((id) => id.startsWith("refl-"));
  assert.ok(firstRefl === -1 || after.slice(firstRefl).every((id) => id.startsWith("refl-")));
});

test("5 a reflection is not brought back through a Connect link when the user's record of its conversation is there", async () => {
  const link = { id: "L1", sourceId: "own-later-reason", targetId: "refl-same-day", axis: "person", reason: "同じ人物についての記録", contrast: "", strength: 0.9, createdBy: "ai-inference", createdAt: "2026-01-01T00:00:00.000Z" };
  const withLink = POOL.map((m) => (m.id === "own-later-reason" ? ({ ...m, links: [link] } as MemoryObject) : m));
  pool = withLink;
  for (const q of ["転勤で未来がないと言ったのは、みおさんと距離を置くことにしたから？", QA, QB]) {
    for (const limit of [3, 6]) {
      const chat = ids(await r.retrieveRelevantMemoriesImpl(q, { deferReflections: true, limit, maxLinkedAdditions: 2 }));
      assert.ok(!(chat.includes("refl-same-day") && chat.includes("own-conclusion")), `${q} ${limit}: ${chat.join(",")}`);
    }
  }
  // the direct pick of the link's source alone: the link would add the reflection for other callers, not for the chat
  pool = [withLink.find((m) => m.id === "own-later-reason")!, withLink.find((m) => m.id === "own-conclusion")!, withLink.find((m) => m.id === "refl-same-day")!];
  const q = "転勤で住む場所が離れる";
  const old = ids(await r.retrieveRelevantMemoriesImpl(q, { limit: 2 }));
  const chat = ids(await r.retrieveRelevantMemoriesImpl(q, { limit: 2, deferReflections: true }));
  if (old.includes("own-conclusion") && old.includes("refl-same-day")) assert.ok(!chat.includes("refl-same-day"), chat.join(","));
});

test("6 the debug trace does not change what retrieval returns", async () => {
  pool = POOL;
  for (const q of [QA, QB]) {
    for (const persona of ["companion", "analyst"] as const) {
      const a = await r.retrieveRelevantMemoriesImpl(q, { persona, deferReflections: true, includeContext: true, limit: 6 });
      const b = await r.retrieveRelevantMemoriesImpl(q, { persona, deferReflections: true, includeContext: true, limit: 6, onReflectionTrace: () => { throw new Error("debug failure"); } });
      assert.deepEqual(a, b, `${persona} ${q}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the chat route
// ---------------------------------------------------------------------------------------------------------------------------------
const T = "2026-10-27T03:00:00.000Z";
async function call(body: Record<string, unknown>) {
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const full = await res.text();
  const at = full.indexOf(protocol.DEBUG_ENVELOPE_DELIMITER);
  const envelope = at === -1 ? null : (JSON.parse(full.slice(at + protocol.DEBUG_ENVELOPE_DELIMITER.length)) as import("./generationDebugProtocol").GenerationDebugEnvelope);
  return { systemInstruction: rec.systemInstruction, visible: at === -1 ? full : full.slice(0, at), envelope };
}
const ask = (content: string, persona = "companion") => ({ persona, turns: [{ role: "user", content, timestamp: T }] });
const retrieved = [
  { id: "own-conclusion", date: "2026-02-11T12:00:00.000Z", summary: own.summary, keywords: own.keywords, source: "ai-capture", quote: "みおさんとの関係に未来がないと思う。" },
  { id: "refl-other-day", date: "2026-08-17T12:00:00.000Z", summary: lonelyReflection.summary, keywords: lonelyReflection.keywords, source: "system-generated" },
];
const memoryTimeline = [{
  theme: "みおさん",
  state: { status: "不明" },
  timeline: [
    { memoryId: "own-conclusion", statedAt: "2026-02-11", summary: own.summary, latestSaid: false, retrospective: false, latestEvent: false, stateBasis: false },
    { memoryId: "own-later-reason", statedAt: "2026-06-15", summary: later.summary, latestSaid: true, retrospective: true, latestEvent: false, stateBasis: false },
  ],
  items: [{ kind: "change", theme: "みおさん", statement: "距離を置いた理由が、気持ちから住む場所の事情へと語られ方が変わったのかもしれない", support: "hypothesis", evidenceIds: ["own-conclusion", "own-later-reason"], firstStatedAt: "2026-02-11", lastStatedAt: "2026-06-15" }],
  corrections: [{ kind: "corrected", saidAt: "2026-07-01", userQuote: "寂しかったからじゃなくて、転勤があるからだよ", aboutReading: "寂しさを埋めたかった" }],
}];
const personContext = [{
  key: "みお", names: ["みおさん"],
  conclusions: [{
    statement: { kind: "user", text: "みおさんとの関係に未来がないと思う。", day: "2026-02-11", memoryId: "own-conclusion" }, role: "judgment", stance: "decision",
    reasons: [{ kind: "user", text: "未来がないと言ったのは、来年転勤で住む場所が離れるからだ。", day: "2026-06-15", memoryId: "own-later-reason", when: "later", link: "topic" }],
    aiReadings: [{ kind: "summary", text: "寂しさから距離を置いたのかもしれない。", day: "2026-02-11", memoryId: "own-conclusion" }],
  }],
  plans: [], events: [], candidates: [], memoryIds: [],
}];
const topicTimeline = [{ topicId: "t-mio", events: [{ time: "2026-06-15T12:00:00.000Z", quote: "未来がないと言ったのは、来年転勤で住む場所が離れるからだ。", sourceConversationId: "c-b" }] }];
const topicContext = [{ topicId: "t-mio", memories: [{ date: "2026-06-15T12:00:00.000Z", summary: later.summary, keywords: later.keywords }] }];

test("7 the priority of the material for questions about the user's own past: only with past context; no pretending when nothing was found", async () => {
  const withPast = await call({ ...ask(QB), retrievedMemories: retrieved });
  assert.ok(withPast.systemInstruction.includes(voice.OWN_PAST_PRIORITY_NOTE));
  const note = voice.OWN_PAST_PRIORITY_NOTE;
  const order = ["1. 本人が明示した発言", "2. 後から本人が説明した理由・訂正", "3. AIの要約", "4. AIの仮説・解釈"].map((x) => note.indexOf(x));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), "the four tiers in order");
  assert.ok(note.includes("見つかったように装わない"));
  const none = await call(ask(QB));
  assert.ok(!none.systemInstruction.includes(voice.OWN_PAST_PRIORITY_NOTE), "no past context: the note is not added");
  assert.ok(none.systemInstruction.includes(voice.NO_PAST_CONTEXT_NOTE), "the existing note for a turn without past context stays");
});

test("8 an opinion is still asked for and allowed: a view and a hypothesis, kept apart from the user's words, not a general answer", async () => {
  const got = await call({ ...ask(QA), retrievedMemories: retrieved });
  assert.ok(got.systemInstruction.includes(voice.CONVERSATION_VOICE_SECTION), "the voice section (own view, grounded hypotheses) is unchanged");
  assert.ok(voice.OWN_PAST_PRIORITY_NOTE.includes("自分の見解や仮説を具体的に述べてよい"));
  assert.ok(voice.OWN_PAST_PRIORITY_NOTE.includes("本人が言ったことと自分の見方を分けて伝える"));
  assert.ok(voice.OWN_PAST_PRIORITY_NOTE.includes("一般論だけで返さない"));
});

test("9 a reflection is labelled as the AI's diary text; other sources are shown as before", async () => {
  const got = await call({ ...ask(QB), retrievedMemories: retrieved });
  assert.ok(got.systemInstruction.includes("出典: Tsumugiが書いた日記の振り返り（AIの文章。本人の発言ではない）"));
  assert.ok(!got.systemInstruction.includes("source: system-generated"));
  assert.ok(got.systemInstruction.includes("source: ai-capture"));
});

test("10 Timeline, Synthesis and Graph all on: every section reaches the prompt, and the debug provenance shows each route, duplicates and the later reasons", async () => {
  const body = { ...ask(QB), retrievedMemories: retrieved, memoryTimeline, personContext, topicTimeline, topicContext, debugGenerationId: "gen-test" };
  const got = await call(body);
  for (const heading of ["## 関連する過去の記憶", "## 複数の会話にわたる経緯", "## 話題の人物について", "## これまでの経緯", "## 継続中かもしれない話題の候補"]) assert.ok(got.systemInstruction.includes(heading), heading);
  const p = got.envelope?.provenance;
  assert.ok(p, "provenance in the envelope");
  for (const path of ["Retrieval", "Reflection", "Topic Continuity", "Topic Timeline", "Memory Timeline", "Memory Synthesis", "Memory Graph"] as const) assert.ok((p.counts[path] ?? 0) > 0, path);
  const dup = p.duplicates.find((d) => d.memoryId === "own-conclusion");
  assert.ok(dup && dup.paths.includes("Retrieval") && dup.paths.includes("Memory Graph") && dup.paths.includes("Memory Timeline") && dup.paths.includes("Memory Synthesis"), JSON.stringify(dup));
  assert.ok(p.explanations.some((x) => x.path === "Memory Graph" && x.memoryIds.includes("own-later-reason") && x.how.includes("後から本人が説明した理由")));
  assert.ok(p.explanations.some((x) => x.path === "Memory Synthesis" && x.how.includes("訂正")));
  assert.ok(p.entries.some((e) => e.path === "Memory Graph" && e.kind === "AIの推測"), "the AI's reading is marked as such");
  assert.ok(p.entries.some((e) => e.path === "Reflection" && e.kind === "AIの要約" && e.why.includes("AIが書いた日記の振り返り")));
  assert.ok(p.entries.some((e) => e.path === "Memory Synthesis" && e.kind === "AIの推測" && e.why.includes("仮説")));
  assert.ok(p.entries.every((e) => Array.from(e.text).length <= prov.PROVENANCE_LIMITS.clipChars + 1), "only short clips");
  assert.ok(!("provenance" in (got.envelope?.serverAccepted ?? {})), "not in the part the debug log stores in localStorage");
  // the client's view of what it sent, compared with what the route accepted
  const sent = prov.buildContextProvenance({ retrievedMemories: retrieved as never, memoryTimeline: memoryTimeline as never, personContext: personContext as never, topicTimeline, topicContinuity: topicContext });
  assert.deepEqual(prov.notAccepted(sent, p), []);
  const text = prov.formatContextProvenance({ sent, accepted: p, reflection: { asksAboutReflection: false, deferred: ["refl-other-day"], dropped: [{ memoryId: "refl-same-day", why: "同じ会話の本人の記録が選ばれている" }] } });
  for (const part of ["■ Memory Graph", "■ 複数の経路から渡ったMemory", "■ 本人の理由・訂正", "■ Reflection", "refl-same-day：入れなかった", "■ 送ったが会話AIに渡らなかったもの"]) assert.ok(text.includes(part), part);
});

test("11 what the route filtered out (an outside fact without web search) is shown as not passed", async () => {
  const withPrice = [...retrieved, { id: "price", date: T, summary: "みおさんと行った店の価格が上がっていた", keywords: ["みおさん"], source: "ai-capture" }];
  const got = await call({ ...ask(QB), retrievedMemories: withPrice, debugGenerationId: "gen-test" });
  const sent = prov.buildContextProvenance({ retrievedMemories: withPrice as never });
  const missing = prov.notAccepted(sent, got.envelope!.provenance!);
  assert.ok(missing.some((e) => e.memoryIds.includes("price")), JSON.stringify(missing));
  assert.ok(!got.envelope!.provenance!.entries.some((e) => e.memoryIds.includes("price")));
});

test("12 the debug on or off: the same prompt and the same reply text", async () => {
  const body = { ...ask(QA), retrievedMemories: retrieved, memoryTimeline, personContext, topicTimeline, topicContext };
  const off = await call(body);
  const on = await call({ ...body, debugGenerationId: "gen-test" });
  assert.equal(on.systemInstruction, off.systemInstruction);
  assert.equal(on.visible, off.visible);
  assert.equal(off.envelope, null, "nothing extra without the debug");
});

test("13 Graph, Timeline and Synthesis off: their sections are absent, as before", async () => {
  const got = await call({ ...ask(QB), retrievedMemories: retrieved });
  assert.ok(!got.systemInstruction.includes("## 話題の人物について"));
  assert.ok(!got.systemInstruction.includes("## 複数の会話にわたる経緯"));
});

test("14 the client keeps the provenance in the tab's memory only, and the chat screen passes the option only to the chat retrieval", () => {
  const store = fs.readFileSync(path.join(ROOT, "../src/lib/contextProvenanceStore.ts"), "utf8");
  assert.ok(!/localStorage|indexedDB|fetch\(/.test(store.replace(/\/\*[\s\S]*?\*\//g, "")), "no storage, no sending");
  const screen = fs.readFileSync(path.join(ROOT, "../src/components/ChatScreen.tsx"), "utf8");
  assert.equal(screen.match(/deferReflections: true/g)?.length, 1);
  assert.ok(/generationDebugLogEnabled\(\) \? \{ onReflectionTrace/.test(screen), "the trace only with the debug");
});
