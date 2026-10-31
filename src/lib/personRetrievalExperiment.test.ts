/**
 * EXPERIMENT person-aware retrieval (R2): safety rules on fictional Memories. Production retrieval is not changed by this module.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeKeywordFrequency, DEFAULT_LIMIT, selectConversationDirectMatches } from "./retrieval";
import { isAboutPerson, knownPersonKeys, normalizeTwoPeople, PERSON_EXTRA_LIMIT, personKeysInText, relationTalk, selectWithPersonRetrieval } from "./personRetrievalExperiment";
import type { MemoryObject } from "./types";

const at = (d: string) => `${d}T12:00:00.000Z`;
function mem(id: string, day: string, keywords: string[], summary: string, person?: string): MemoryObject {
  return {
    id, date: at(day), statedAt: at(day), types: ["conversation"], conversationId: `c-${id}`, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [summary],
    ...(person ? { personMentions: [{ id: `pm-${id}`, groupingKey: person, displayName: person, assertion: "mention", stated: "explicit", quote: summary, statedAt: at(day), sourceConversationId: `c-${id}` }] } : {}),
    createdAt: at(day), updatedAt: at(day), metadata: { id: `meta-${id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at(day), updatedAt: at(day) },
  } as unknown as MemoryObject;
}
const POOL = [
  mem("s1", "2026-04-10", ["さきさん", "仕事", "二人"], "さきさんと二人で進めてきた企画が形になり、息が合うと話した。", "さきさん"),
  mem("s2", "2026-05-15", ["さきさん", "信頼"], "さきさんは何でも話せる相手で、大切な存在だと話した。"),
  mem("s4", "2026-07-25", ["さきさん", "距離"], "さきさんと最近距離ができた気がして、寂しいと話した。"),
  mem("s7", "2026-10-20", ["さきさん", "会話"], "さきさんと久しぶりにゆっくり話せて、やっぱり大切だと感じたと話した。", "さきさん"),
  mem("w1", "2026-10-22", ["渡邊さん", "仕事", "距離"], "渡邊さんが距離を置きたがっているように感じたと話した。", "渡邊さん"),
  mem("m1", "2026-09-10", ["まさきさん", "取引先"], "取引先のまさきさんに見積もりを出したと話した。", "まさきさん"),
  mem("x1", "2026-08-05", ["旅行", "行き先"], "夏休みの行き先を決めたと話した。"),
];

test("names: a longer name hides the shorter one inside it; relation words and 1-character names are not names", () => {
  const keys = knownPersonKeys(POOL);
  assert.deepEqual([...keys].sort(), ["さき", "まさき", "渡邊"].sort());
  assert.deepEqual(personKeysInText("まさきさんから返事が来ない", keys), ["まさき"]);
  assert.deepEqual(personKeysInText("さきさんと話した", keys), ["さき"]);
  assert.ok(!isAboutPerson(POOL.find((m) => m.id === "m1")!, "さき"), "まさきさん's record is not さきさん's");
  assert.ok(!isAboutPerson(POOL.find((m) => m.id === "x1")!, "さき"), "行き先 is not a person");
  assert.ok(isAboutPerson(POOL.find((m) => m.id === "s2")!, "さき"), "an exact name keyword counts even without personMentions");
  assert.equal(normalizeTwoPeople("2人だけ／２人だけ"), "二人だけ／二人だけ");
});

test("no person in the turn: exactly the production selection", () => {
  const latest = "今日は雨で洗濯物が乾かない";
  const prod = selectConversationDirectMatches(POOL, latest, [latest], computeKeywordFrequency(POOL), DEFAULT_LIMIT).kept.map((e) => e.memory.id);
  const r = selectWithPersonRetrieval(POOL, latest, [latest]);
  assert.equal(r.target, null);
  assert.deepEqual(r.memories.map((m) => m.id), prod);
});

test("another person's record never comes in through a shared word, and a similar name is a different person", () => {
  const r = selectWithPersonRetrieval(POOL, "さきさんも距離取りたいのかもしれないからちょうどいいんじゃない？", ["さきさんも距離取りたいのかもしれないからちょうどいいんじゃない？"]);
  assert.equal(r.target?.key, "さき");
  assert.ok(!r.memories.some((m) => m.id === "w1" || m.id === "m1" || m.id === "x1"));
  const m = selectWithPersonRetrieval(POOL, "まさきさんから見積もりの返事が来ない", ["まさきさんから見積もりの返事が来ない"]);
  assert.equal(m.target?.key, "まさき");
  assert.ok(!m.memories.some((x) => x.id.startsWith("s")), "no さきさん record for まさきさん");
  const w = selectWithPersonRetrieval(POOL, "渡邊さん、最近ちょっと距離置きたそう", ["渡邊さん、最近ちょっと距離置きたそう"]);
  assert.ok(!w.memories.some((x) => x.id.startsWith("s")), "no さきさん record for 渡邊さん");
});

test("carried person with 「2人」: the person's records are found, at most a few are added, the newest included", () => {
  const turns = ["さきさんとは今まで2人で仕事してきたけど、今回はもう一人入ってる", "そもそも2人だけの空気感でいたいんだよほんとは"];
  const r = selectWithPersonRetrieval(POOL, turns[1], turns);
  assert.equal(r.target?.key, "さき");
  assert.equal(r.target?.how, "carried");
  assert.ok(r.added.length <= PERSON_EXTRA_LIMIT);
  assert.ok(r.memories.some((m) => m.id === "s7"), "the newest record of the person");
  assert.ok(r.memories.length <= DEFAULT_LIMIT + PERSON_EXTRA_LIMIT);
  assert.ok(r.memories.every((m) => isAboutPerson(m, "さき") || !["w1", "m1"].includes(m.id)));
});

test("two people named in one message: no person augmentation (the production selection)", () => {
  const latest = "さきさんと渡邊さんの三人で打ち合わせした";
  const r = selectWithPersonRetrieval(POOL, latest, [latest]);
  assert.equal(r.target, null);
});

test("the person's name alone never makes a record 'overlap': a work question does not pull in a feelings record", () => {
  const latest = "さきさんと来週の企画のプレゼン、どっちが話すか決めないと";
  const r = selectWithPersonRetrieval(POOL, latest, [latest]);
  assert.ok(!r.added.some((a) => a.id === "s4" && a.why.includes("重なる")), "距離・寂しい is not chosen for overlapping the name");
});

test("R3: a feelings record only when the turn is about the relationship; plain work talk gets none; never another person's", () => {
  assert.equal(relationTalk("さきさんと来週の企画のプレゼン、どっちが話すか決めないと").yes, false);
  assert.equal(relationTalk("そもそも2人だけの空気感でいたいんだよほんとは").yes, true);
  assert.equal(relationTalk("今日は雨で洗濯物が乾かない").yes, false);
  const turns = ["さきさんとは今まで2人で仕事してきたけど、今回はもう一人入ってる", "そもそも2人だけの空気感でいたいんだよほんとは"];
  const r3 = selectWithPersonRetrieval(POOL, turns[1], turns, { feelingSlot: true });
  assert.ok(r3.feeling?.added, "a feelings record is added for the relationship turn");
  assert.ok(isAboutPerson(POOL.find((m) => m.id === r3.feeling!.added)!, "さき"));
  const work = "さきさんと来週の企画のプレゼン、どっちが話すか決めないと";
  const w = selectWithPersonRetrieval(POOL, work, [work], { feelingSlot: true });
  assert.equal(w.feeling?.added, null, "no feelings record for plain work");
  const other = "渡邊さん、最近ちょっと距離置きたそうで寂しい";
  const o = selectWithPersonRetrieval(POOL, other, [other], { feelingSlot: true });
  assert.ok(!o.memories.some((m) => m.id.startsWith("s")), "never さきさん's feelings for 渡邊さん");
  const none = selectWithPersonRetrieval(POOL, "今日は雨で寂しい", ["今日は雨で寂しい"], { feelingSlot: true });
  assert.equal(none.target, null, "no person: nothing is added");
  assert.ok(r3.memories.length <= DEFAULT_LIMIT + PERSON_EXTRA_LIMIT + 1);
});

test("R3n / R3x: no guess from text similarity; R3n falls back to the newest feelings record, R3x adds nothing", () => {
  const turns = ["さきさんとは今まで2人で仕事してきたけど、今回はもう一人入ってる", "そもそも2人だけの空気感でいたいんだよほんとは"];
  const n = selectWithPersonRetrieval(POOL, turns[1], turns, { feelingSlot: true, feelingPick: "newest" });
  const x = selectWithPersonRetrieval(POOL, turns[1], turns, { feelingSlot: true, feelingPick: "none" });
  const already = new Set([...n.memories.map((m) => m.id)]);
  assert.ok(n.feeling?.added === null || already.has(n.feeling!.added!));
  if (n.feeling?.added) assert.ok(n.feeling.why.includes("最新") || n.feeling.why.includes("キーワード"));
  assert.ok(x.feeling?.added === null || x.feeling!.why.includes("キーワード"), "R3x only adds a keyword-matched record");
  const work = "さきさんと来週の企画のプレゼン、どっちが話すか決めないと";
  for (const pick of ["newest", "none"] as const) assert.equal(selectWithPersonRetrieval(POOL, work, [work], { feelingSlot: true, feelingPick: pick }).feeling?.added, null);
});

// --- bias of "the newest feelings record" (R3n) ---
function feelMem(id: string, day: string, keywords: string[], summary: string, person = "さきさん"): MemoryObject {
  const m = mem(id, day, keywords, summary, person);
  return { ...m, types: ["conversation", "emotion"] } as unknown as MemoryObject;
}
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const turnsRel = ["さきさんとは今まで2人で仕事してきたけど、今回はもう一人入ってる", "そもそも2人だけの空気感でいたいんだよほんとは"];
const pickFor = (pool: MemoryObject[]) => selectWithPersonRetrieval(pool, turnsRel[1], turnsRel, { feelingSlot: true, feelingPick: "newest", now: NOW });
const workBase = [mem("w-a", "2026-04-10", ["さきさん", "仕事", "二人"], "さきさんと二人で企画を進めてきたと話した。", "さきさん")];

const ids = (r: ReturnType<typeof pickFor>) => r.memories.map((m) => m.id);

test("bias 1: the newest feelings record is positive -> it is passed (once), no older feeling stacked on top", () => {
  const r = pickFor([...workBase, feelMem("f1", "2026-06-01", ["さきさん", "寂しい"], "さきさんと距離ができて寂しいと話した。"), feelMem("f2", "2026-10-20", ["さきさん", "大切"], "さきさんがやっぱり大切だと感じたと話した。")]);
  assert.ok(ids(r).includes("f2"));
  assert.ok(r.feeling?.added === null || r.feeling?.added === "f2");
});

test("bias 2: the newest is negative -> it is passed with its date (as a dated record, not as the whole present feeling)", () => {
  const r = pickFor([...workBase, feelMem("f1", "2026-08-01", ["さきさん", "大切"], "さきさんが大切だと話した。"), feelMem("f2", "2026-10-25", ["さきさん", "怒り"], "さきさんに腹が立って、少し距離を置きたいと話した。")]);
  assert.ok(ids(r).includes("f2"));
  assert.ok(r.memories.find((m) => m.id === "f2")!.date.startsWith("2026-10-25"), "the record keeps its date");
});

test("bias 3: feelings changed quickly -> the latest of them is passed", () => {
  const r = pickFor([...workBase, feelMem("f1", "2026-09-01", ["さきさん", "大切"], "さきさんが大切だと話した。"), feelMem("f2", "2026-10-01", ["さきさん", "怒り"], "さきさんに腹が立ったと話した。"), feelMem("f3", "2026-10-20", ["さきさん", "安心"], "さきさんと仲直りして安心したと話した。")]);
  assert.ok(ids(r).includes("f3"));
});

test("bias 4: a one-off newest feeling over a feeling that keeps coming back -> the recurring feeling is added next to it", () => {
  const r = pickFor([
    ...workBase,
    feelMem("f1", "2026-06-01", ["さきさん", "大切"], "さきさんが大切だと話した。"),
    feelMem("f2", "2026-08-01", ["さきさん", "大切"], "さきさんのことをやっぱり大切に思うと話した。"),
    feelMem("f3", "2026-10-01", ["さきさん", "大切"], "さきさんが大切な存在だと改めて話した。"),
    feelMem("f4", "2026-10-28", ["さきさん", "苛立ち"], "さきさんの一言に少しイラッとしたと話した。"),
  ]);
  assert.ok(ids(r).includes("f4"));
  assert.ok(ids(r).includes("f3"), "the latest record of the recurring 大切");
  assert.ok(r.feeling?.added === "f3");
});

test("bias 5: an old feelings record or one shared with another person is never added by the feelings slot", () => {
  const old = pickFor([...workBase, feelMem("f1", "2025-12-01", ["さきさん", "大切"], "さきさんが大切だと話した。")]);
  assert.equal(old.feeling?.added, null, "older than the age limit");
  const shared = pickFor([...workBase, mem("w-b", "2026-09-01", ["渡邊さん"], "渡邊さんと打ち合わせした。", "渡邊さん"), { ...feelMem("f1", "2026-10-20", ["さきさん", "渡邊さん", "嫉妬"], "さきさんと渡邊さんが親しげで嫉妬したと話した。"), personMentions: [{ displayName: "さきさん", groupingKey: "さきさん" }, { displayName: "渡邊さん", groupingKey: "渡邊さん" }] } as unknown as MemoryObject]);
  assert.equal(shared.feeling?.added, null, "a feelings record that is also about another person");
});

test("the newest feelings record missing (only an older sad one present) -> the newest is added", () => {
  const turns = ["さきさんと最近距離がある", "さきさんも距離取りたいのかもしれないからちょうどいいんじゃない？"];
  const pool = [
    ...workBase,
    feelMem("f1", "2026-07-25", ["さきさん", "距離"], "さきさんと距離ができて寂しいと話した。"),
    mem("w-c", "2026-10-28", ["さきさん", "仕事"], "さきさんと三人で打ち合わせしたと話した。", "さきさん"),
    feelMem("f2", "2026-10-20", ["さきさん", "会話"], "さきさんと話せて、やっぱり大切だと感じたと話した。"),
  ];
  const r = selectWithPersonRetrieval(pool, turns[1], turns, { feelingSlot: true, feelingPick: "newest", now: NOW });
  assert.ok(ids(r).includes("f2"), "the present 'やっぱり大切' joins the past 'さみしい'");
});

test("a keyword-matched feelings record wins over the newest one", () => {
  const turns = ["さきさんと最近距離がある気がする", "距離取りたいのかもしれないね"];
  const r = selectWithPersonRetrieval([...workBase, feelMem("f1", "2026-07-01", ["さきさん", "距離"], "さきさんと距離ができて寂しいと話した。"), feelMem("f2", "2026-10-20", ["さきさん", "大切"], "さきさんが大切だと話した。")], turns[1], turns, { feelingSlot: true, feelingPick: "newest", now: NOW });
  assert.ok(r.memories.some((m) => m.id === "f1"));
});
