/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Purpose relevance (chat Retrieval only, `purposeRelevance`): fictional Memories, the 7 questions of the survey (2026-11-13).
 * "before" = the chat Retrieval without the option (main as of 041f831), "after" = with it. Both with every other option the chat screen passes.
 * The before / after table (needed records and their ranks, low-priority and unrelated shares) is written to the CI job summary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
type Persona = import("./types").Persona;
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
const rr = require(path.join(ROOT, "lib/recordRelevance.js")) as typeof import("./recordRelevance");
const rq = require(path.join(ROOT, "lib/recallQuestion.js")) as typeof import("./recallQuestion");
const mc = require(path.join(ROOT, "lib/memoryContext.js")) as typeof import("./memoryContext");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };

interface Opt { quotes?: string[]; persons?: string[]; source?: string }
function mem(id: string, day: string, summary: string, keywords: string[], opt: Opt = {}): MemoryObject {
  const at = `${day}T12:00:00.000Z`;
  return {
    id, date: at, statedAt: at, types: ["conversation"], conversationId: `c-${id}`, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at,
    evidenceQuotes: opt.quotes ?? [summary],
    ...(opt.persons ? { personMentions: opt.persons.map((name, i) => ({ id: `pm-${id}-${i}`, groupingKey: name, displayName: name, assertion: "mention" })) } : {}),
    metadata: { id: `meta-${id}`, source: opt.source ?? "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

// the fictional Memories of the survey (diag/relevance-survey)
const POOL: MemoryObject[] = [
  mem("gx", "2026-10-27", "見た目で一番好きなのはGX。その次にNX、RX", ["車", "レクサス", "GX", "見た目"]),
  mem("nxo", "2026-10-29", "NXかアウトランダーかなぁと迷っている", ["車", "NX", "アウトランダー"], { quotes: ["NXかアウトランダーかなぁ"] }),
  mem("space", "2026-10-30", "車選びでは燃費より室内の広さを重視したい", ["車選び", "室内", "燃費"]),
  mem("ol", "2026-10-26", "アウトランダーが気になる", ["アウトランダー", "SUV"]),
  mem("which", "2026-10-31", "NXとアウトランダーのどちらが良いか迷っている", ["車", "NX", "アウトランダー"], { quotes: ["NXとアウトランダー、どっちがいいかな？"] }),
  mem("lego", "2026-10-12", "長男がレゴで車を作った", ["長男", "レゴ", "車"], { persons: ["長男"] }),
  mem("base", "2026-09-28", "長男が段ボールで秘密基地を作っていた", ["長男", "段ボール", "工作"], { persons: ["長男"] }),
  mem("alph", "2026-10-05", "日本の道路にアルファードが多くて驚いた", ["アルファード", "道路", "日本"]),
  mem("q1", "2026-11-05", "過去にどんな車がいいと言ったか尋ねた", ["車", "過去"], { quotes: ["過去にどんな車がいいって言ったっけ？"] }),
  mem("q2", "2026-11-08", "以前、車について何を話したか確認した", ["車"], { quotes: ["以前、車について何を話した？"] }),
  mem("q3", "2026-10-20", "仕事の進め方についてどう思うか質問した", ["仕事", "進め方"], { quotes: ["仕事の進め方ってどう思う？"] }),
  mem("saki1", "2026-10-18", "咲さんにはもっと自分の時間を大事にしてほしいと思っている", ["咲さん", "時間"], { persons: ["咲さん"] }),
  mem("saki2", "2026-10-22", "咲さんと週末に映画を見た", ["咲さん", "映画"], { persons: ["咲さん"] }),
  mem("saki3", "2026-11-02", "咲さんともっと二人で話す時間がほしい", ["咲さん", "会話"], { persons: ["咲さん"] }),
  mem("view1", "2026-11-03", "以前は効率ばかり考えていたが、最近は余白も大切だと思うようになった", ["考え方", "余白", "効率"]),
  mem("view2", "2026-10-25", "失敗を怖がらずに試すことにした", ["挑戦", "失敗"]),
  mem("view3", "2026-05-10", "完璧にやらないと気が済まない", ["完璧主義", "考え方"]),
  mem("refl", "2026-10-30", "車選びについていろいろ考えた一日だった", ["車選び"], { source: "system-generated", quotes: [] }),
  mem("u1", "2026-10-02", "電車で通勤している", ["電車", "通勤"]),
  mem("u2", "2026-10-03", "自転車を修理した", ["自転車", "修理"]),
  mem("u3", "2026-10-04", "駐車場が混んでいた", ["駐車場"]),
  mem("u4", "2026-10-06", "最近仕事が忙しい", ["仕事", "多忙"]),
  mem("u5", "2026-10-07", "友人とカフェで話した", ["カフェ", "友人"]),
  mem("u6", "2026-10-08", "週末に過去の写真を整理した", ["整理", "写真"]),
  mem("u7", "2026-10-09", "考えごとをして眠れなかった", ["睡眠", "不安"]),
];

interface Case { q: string; needed: string[]; low: string[]; why: string }
const CASES: Case[] = [
  { q: "過去にどんな車がいいって言ったっけ？", needed: ["gx", "nxo", "space", "ol", "which"], low: ["lego", "alph", "q1", "q2", "refl"], why: "本人の車の好み" },
  { q: "以前、車について何を話した？", needed: ["gx", "nxo", "space", "ol", "which"], low: ["lego", "alph", "q1", "q2", "refl"], why: "車についての話" },
  { q: "長男が作っていたものは？", needed: ["lego", "base"], low: [], why: "長男の行動（legoが中心）" },
  { q: "アルファードについてどう思っていた？", needed: ["alph"], low: [], why: "alphが中心" },
  { q: "前に咲さんについて何を望んでいた？", needed: ["saki1", "saki3"], low: ["saki2"], why: "咲さんへの望み" },
  { q: "最近、自分の考え方はどう変わった？", needed: ["view1", "view2"], low: ["view3"], why: "考え方の変化" },
  { q: "過去にどんな質問をしていた？", needed: ["q1", "q2", "q3"], low: ["which"], why: "質問した記録が中心" },
];

async function run(q: string, persona: Persona, purposeRelevance: boolean, memories: MemoryObject[] = POOL) {
  pool = memories;
  const reflective = r.isReflectiveQuery(q);
  return r.retrieveRelevantMemoriesImpl(q, {
    excludeConversationId: "now", limit: reflective ? r.REFLECTIVE_LIMIT : undefined, maxLinkedAdditions: reflective ? r.REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
    persona, recentUserTurnsTexts: [q], includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance,
  });
}
const ids = async (q: string, persona: Persona, on: boolean, memories?: MemoryObject[]) => (await run(q, persona, on, memories)).map((m) => m.id);

function measure(got: string[], c: Case) {
  const rank = (id: string) => { const i = got.indexOf(id); return i < 0 ? "-" : String(i + 1); };
  const unrelated = got.filter((id) => !c.needed.includes(id) && !c.low.includes(id));
  const low = got.filter((id) => c.low.includes(id));
  const needed = got.filter((id) => c.needed.includes(id));
  const pct = (n: number) => (got.length === 0 ? "0%" : `${Math.round((n / got.length) * 100)}%`);
  return {
    needed, low, unrelated,
    text: `${got.length}件 [${got.join(", ")}]<br>必要 ${needed.length}/${c.needed.length}（${c.needed.map((id) => `${id}:${rank(id)}`).join(" ")}）<br>低優先 ${pct(low.length)}・無関係 ${unrelated.length}件 ${pct(unrelated.length)}`,
  };
}

test("1-6 the 7 questions, before / after: no needed record is lost, unrelated records do not increase (both personas), the question-only record no longer crowds out the answers", async () => {
  const rows = ["| 質問 | persona | 修正前 | 修正後 |", "|---|---|---|---|"];
  const lost: string[] = [];
  const total = { before: { needed: 0, low: 0, unrelated: 0, n: 0 }, after: { needed: 0, low: 0, unrelated: 0, n: 0 } };
  const companion = { before: 0, after: 0 };
  for (const c of CASES) {
    for (const persona of ["analyst", "companion"] as Persona[]) {
      const before = await ids(c.q, persona, false);
      const after = await ids(c.q, persona, true);
      const b = measure(before, c);
      const a = measure(after, c);
      rows.push(`| ${c.q}<br>（${c.why}） | ${persona} | ${b.text} | ${a.text} |`);
      for (const [k, m, list] of [["before", b, before], ["after", a, after]] as const) {
        total[k].needed += m.needed.length; total[k].low += m.low.length; total[k].unrelated += m.unrelated.length; total[k].n += list.length;
      }
      if (persona === "companion") { companion.before += b.unrelated.length; companion.after += a.unrelated.length; }
      for (const id of c.needed) if (before.includes(id) && !after.includes(id)) lost.push(`${c.q} / ${persona}: ${id}`);
      // 3 a record that only asked never ranks above a needed record
      for (const asked of ["q1", "q2"].filter((id) => !c.needed.includes(id) && after.includes(id))) {
        for (const id of c.needed.filter((n) => after.includes(n))) assert.ok(after.indexOf(asked) > after.indexOf(id), `${c.q} / ${persona}: ${asked} above ${id} (${after.join(",")})`);
      }
    }
  }
  const neededTotal = CASES.reduce((n, c) => n + c.needed.length, 0) * 2;
  rows.push(`| 合計 | 両方 | 必要 ${total.before.needed}/${neededTotal}・低優先 ${total.before.low}・無関係 ${total.before.unrelated}（全${total.before.n}件、companionの無関係 ${companion.before}） | 必要 ${total.after.needed}/${neededTotal}・低優先 ${total.after.low}・無関係 ${total.after.unrelated}（全${total.after.n}件、companionの無関係 ${companion.after}） |`);
  const out = ["## Purpose relevance: before / after (fictional data)", ...rows, "", lost.length > 0 ? `失われた必要記録: ${lost.join(" / ")}` : "失われた必要記録: なし"].join("\n");
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`);
  assert.deepEqual(lost, [], "a needed record found before is lost");
  assert.ok(companion.after <= companion.before, `companion unrelated ${companion.before} → ${companion.after}`);
  assert.ok(total.after.unrelated <= total.before.unrelated, `unrelated ${total.before.unrelated} → ${total.after.unrelated}`);
  assert.ok(total.after.needed > total.before.needed, `needed ${total.before.needed} → ${total.after.needed}`);
  // 3 the survey's main failure: analyst answered only with the question-only record
  for (const q of [CASES[0].q, CASES[1].q]) {
    const after = await ids(q, "analyst", true);
    assert.ok(["gx", "nxo", "space", "which"].filter((id) => after.includes(id)).length >= 3, `${q}: ${after.join(",")}`);
  }
});

test("4 the same record is important for one question and pushed back for another", async () => {
  // lego: back for the user's own car view, first for what the eldest son made
  const view = await ids(CASES[0].q, "companion", true);
  const son = await ids(CASES[2].q, "companion", true);
  assert.ok(son.slice(0, 2).includes("lego"), son.join(","));
  if (view.includes("lego")) for (const id of ["gx", "nxo", "which"]) assert.ok(view.indexOf("lego") > view.indexOf(id), view.join(","));
  // q1: back for the car question, first for the question about questions
  const asked = await ids(CASES[6].q, "analyst", true);
  assert.ok(asked.slice(0, 3).includes("q1") && asked.includes("q2") && asked.includes("q3"), asked.join(","));
});

test("1 a question-only record is still found when nothing else matches; a record with real content besides the question is not pushed back", async () => {
  const alone = [byId("q1"), ...POOL.filter((m) => m.id.startsWith("u"))];
  for (const persona of ["analyst", "companion"] as Persona[]) assert.ok((await ids(CASES[0].q, persona, true, alone)).includes("q1"), persona);
  const mixed = mem("mix", "2026-11-09", "前に何と言ったか尋ね、GXが好きだった気がすると話した", ["車", "GX"], { quotes: ["前に何て言ったっけ？GXが好きだった気がする"] });
  assert.equal(rr.isRecallOnlyRecord(mixed), false);
  assert.equal(rr.isRecallOnlyRecord(byId("q1")), true);
  assert.equal(rr.isRecallOnlyRecord(byId("which")), false, "a deliberation question is not a recall-only record");
  assert.equal(rr.isRecallOnlyRecord(mem("old", "2026-01-01", "過去の車の話を尋ねた", ["車"], { quotes: [] })), false, "no quotes (older record): never pushed back");
  const ctx = rr.purposeContextOf(CASES[0].q, POOL);
  assert.equal(rr.adjustForPurpose(mixed, 10, ctx, CASES[0].q, true, 3, 3).demoted, false);
  assert.deepEqual(rr.adjustForPurpose(byId("q1"), 10, ctx, CASES[0].q, true, 3, 3), { score: 3, onTopic: true, demoted: true }, "capped at one keyword hit: still passes the floor");
});

const byId = (id: string) => POOL.find((m) => m.id === id)!;

test("2 the purpose only moves on-topic records; an off-topic record is never raised; no purpose keeps the order", () => {
  const ctx = rr.purposeContextOf("前に咲さんについて何を望んでいた？", POOL);
  assert.equal(ctx.purpose, "wish");
  assert.deepEqual(ctx.namedPersons, ["咲さん"]);
  // off topic (no keyword, no topic, not about 咲さん): a wish in its words does not raise it
  const offTopic = mem("off", "2026-10-01", "旅行に行きたい", ["旅行"]);
  assert.deepEqual(rr.adjustForPurpose(offTopic, 1.2, ctx, "前に咲さんについて何を望んでいた？", false, 3, 3), { score: 1.2, onTopic: false, demoted: false });
  assert.equal(rr.adjustForPurpose(byId("saki1"), 4, ctx, "前に咲さんについて何を望んでいた？", false, 3, 3).score, 7);
  // purposes, from the wording only
  assert.equal(rr.purposeContextOf("過去にどんな質問をしていた？", POOL).purpose, "questions");
  assert.equal(rr.purposeContextOf("最近、自分の考え方はどう変わった？", POOL).purpose, "change");
  assert.equal(rr.purposeContextOf("アルファードについてどう思っていた？", POOL).purpose, "view");
  assert.equal(rr.purposeContextOf("長男が作っていたものは？", POOL).purpose, "personAction");
  for (const text of ["今日はいい天気だね", "車を買おうか迷ってる", "前に車の話をしたっけ？", "これからどうしようかな"]) assert.equal(rr.purposeContextOf(text, POOL).purpose, null, text);
  // no topic, product or person name in the code
  const src = fs.readFileSync(path.join(ROOT, "..", "src", "lib", "recordRelevance.ts"), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join("\n");
  for (const word of ["車", "アウトランダー", "レクサス", "長男", "咲"]) assert.ok(!src.includes(word), word);
});

test("2 no purpose: the order is the same as before (records that only asked aside)", async () => {
  const noAsk = POOL.filter((m) => !["q1", "q2", "q3"].includes(m.id));
  for (const q of ["車を買おうか迷ってる", "前に車の話をしたっけ？", "長男とレゴで遊んだ"]) {
    for (const persona of ["analyst", "companion"] as Persona[]) assert.deepEqual(await ids(q, persona, true, noAsk), await ids(q, persona, false, noAsk), `${q} / ${persona}`);
  }
});

test("2 order: the adjustment comes before the floor, the limit and the relative filter (analyst)", () => {
  const all = POOL;
  const freq = r.computeKeywordFrequency(all);
  const q = CASES[0].q;
  const ctx = rr.purposeContextOf(q, all);
  const topic = rq.withPoolEvidence(rq.recallTopicOf(q), all);
  const without = r.selectConversationDirectMatches(all, q, [q], freq, r.REFLECTIVE_LIMIT, topic, null);
  const withPurpose = r.selectConversationDirectMatches(all, q, [q], freq, r.REFLECTIVE_LIMIT, topic, ctx);
  // without: the question-only record is first and its score removes the answers by the relative filter
  assert.equal(without.kept[0]?.memory.id, "q1");
  const q1 = r.scoreConversationCandidates(all, q, r.deriveConversationTopicAnchors([q], freq), freq, null, topic, ctx).find((e) => e.memory.id === "q1");
  assert.ok(q1 && q1.demoted && q1.conversationScore <= r.KEYWORD_WEIGHT, "pushed back to one keyword hit");
  assert.notEqual(withPurpose.kept[0]?.memory.id, "q1");
  assert.ok(withPurpose.kept.length > without.kept.length, "the relative filter now keeps the answers");
});

test("3 the chat AI gets a short trait, from the wording, not on AI reflections; the route accepts only the fixed traits", async () => {
  const car = await run(CASES[0].q, "companion", true);
  const q1 = car.find((m) => m.id === "q1");
  if (q1) assert.equal(q1.trait, rr.RECORD_TRAITS.recallOnly);
  assert.equal(car.find((m) => m.id === "refl")?.trait, undefined, "no trait on an AI reflection");
  const lego = car.find((m) => m.id === "lego");
  if (lego) assert.equal(lego.trait, "主に長男の行動の記録");
  for (const m of car.filter((x) => ["gx", "nxo", "space", "which"].includes(x.id))) assert.equal(m.trait, undefined, `${m.id}: no trait on a plain answer`);
  const asked = await run(CASES[6].q, "analyst", true);
  assert.ok(asked.filter((m) => m.trait === rr.RECORD_TRAITS.question).length >= 2);
  const wish = await run(CASES[4].q, "analyst", true);
  assert.equal(wish.find((m) => m.id === "saki3")?.trait, rr.RECORD_TRAITS.wish);
  // off: no trait at all
  assert.ok((await run(CASES[0].q, "companion", false)).every((m) => m.trait === undefined));
  // the route's check
  const clean = mc.sanitizeMemoryContext([{ ...car[0], trait: "本人の確定した意図：〇〇" }, { ...car[0], trait: rr.RECORD_TRAITS.wish }, { ...car[0], trait: "主に長男の行動の記録" }]);
  assert.deepEqual(clean.map((m) => m.trait), [undefined, rr.RECORD_TRAITS.wish, "主に長男の行動の記録"]);
  assert.ok(mc.memoryContextLines({ trait: rr.RECORD_TRAITS.recallOnly }).includes("本人が確かめたものではない"));
  // through the chat route: the trait line reaches the prompt, next to P1-F's source line of a reflection
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona: "companion", turns: [{ role: "user", content: CASES[0].q, timestamp: "2026-11-13T03:00:00.000Z" }], retrievedMemories: car }) }));
  await res.text();
  if (q1) assert.ok(rec.systemInstruction.includes(`記録の性質（言い回しからの自動の目安。本人が確かめたものではない）：${rr.RECORD_TRAITS.recallOnly}`));
  if (car.some((m) => m.id === "refl")) assert.ok(rec.systemInstruction.includes("出典: Tsumugiが書いた日記の振り返り"));
});

test("7 Connect, Capture, the Timeline, Synthesis, Memory Graph and the other callers do not pass or read the option", () => {
  for (const file of ["connect.ts", "capture.ts", "topicContinuity.ts", "memorySearch.ts", "reflection.ts", "memorySynthesis.ts", "personContext.ts", "personAlias.ts"]) {
    const p = path.join(ROOT, "..", "src", "lib", file);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8");
      assert.ok(!text.includes("purposeRelevance") && !text.includes("recordRelevance"), file);
    }
  }
  const chat = fs.readFileSync(path.join(ROOT, "..", "src", "components", "ChatScreen.tsx"), "utf8");
  assert.equal(chat.split("purposeRelevance: true").length - 1, 1, "only the chat Retrieval call");
});
