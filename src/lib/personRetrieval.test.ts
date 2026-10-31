/**
 * Person-aware conversation retrieval (selectConversationWithPersons): person identification, another person never mixed in, the feelings record
 * only for relationship talk, and the bias cases of "the newest feelings record". Fictional Memories only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeKeywordFrequency,
  DEFAULT_LIMIT,
  FEELING_MAX_AGE_DAYS,
  isAboutPerson,
  isRelationshipTalk,
  normalizeTwoPeople,
  PERSON_EXTRA_LIMIT,
  personKeysInText,
  selectConversationDirectMatches,
  selectConversationWithPersons,
} from "./retrieval";
import type { MemoryObject } from "./types";

const at = (d: string) => `${d}T12:00:00.000Z`;
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
function mem(id: string, day: string, keywords: string[], summary: string, person?: string, emotion = false): MemoryObject {
  return {
    id, date: at(day), statedAt: at(day), types: emotion ? ["conversation", "emotion"] : ["conversation"], conversationId: `c-${id}`, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [summary],
    ...(person ? { personMentions: [{ id: `pm-${id}`, groupingKey: person, displayName: person, assertion: "mention", stated: "explicit", quote: summary, statedAt: at(day), sourceConversationId: `c-${id}` }] } : {}),
    createdAt: at(day), updatedAt: at(day), metadata: { id: `meta-${id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at(day), updatedAt: at(day) },
  } as unknown as MemoryObject;
}
const POOL = [
  mem("s1", "2026-04-10", ["さきさん", "仕事", "二人"], "さきさんと二人で進めてきた企画が形になり、息が合うと話した。", "さきさん"),
  mem("s2", "2026-05-15", ["さきさん", "信頼"], "さきさんは何でも話せる相手で、大切な存在だと話した。", undefined, true),
  mem("s4", "2026-07-25", ["さきさん", "距離"], "さきさんと最近距離ができた気がして、寂しいと話した。", undefined, true),
  mem("s7", "2026-10-20", ["さきさん", "会話"], "さきさんと久しぶりにゆっくり話せて、やっぱり大切だと感じたと話した。", "さきさん", true),
  mem("s9", "2026-10-28", ["さきさん", "仕事", "新メンバー"], "さきさんと新メンバーの三人で初めて打ち合わせをしたと話した。", "さきさん"),
  mem("w1", "2026-10-22", ["渡邊さん", "仕事", "距離"], "渡邊さんが距離を置きたがっているように感じたと話した。", "渡邊さん"),
  mem("m1", "2026-09-10", ["まさきさん", "取引先"], "取引先のまさきさんに見積もりを出したと話した。", "まさきさん"),
  mem("x1", "2026-08-05", ["旅行", "行き先"], "夏休みの行き先を決めたと話した。"),
];
const select = (pool: MemoryObject[], latest: string, turns: string[] = [latest]) => selectConversationWithPersons(pool, latest, turns, computeKeywordFrequency(pool), DEFAULT_LIMIT, NOW);
const ids = (r: { memories: MemoryObject[] }) => r.memories.map((m) => m.id);

test("names: a longer name hides the shorter one inside it; an exact name keyword counts, a substring never does; 「2人」 is 「二人」", () => {
  assert.deepEqual(personKeysInText("まさきさんから返事が来ない", ["さき", "まさき", "渡邊"]), ["まさき"]);
  assert.deepEqual(personKeysInText("さきさんと話した", ["さき", "まさき", "渡邊"]), ["さき"]);
  assert.ok(isAboutPerson(POOL.find((m) => m.id === "s2")!, "さき"));
  assert.ok(!isAboutPerson(POOL.find((m) => m.id === "m1")!, "さき"));
  assert.ok(!isAboutPerson(POOL.find((m) => m.id === "x1")!, "さき"));
  assert.equal(normalizeTwoPeople("2人だけ／２人だけ"), "二人だけ／二人だけ");
});

test("no person in the turn: exactly the previous selection", () => {
  const latest = "今日は雨で洗濯物が乾かない";
  const before = selectConversationDirectMatches(POOL, latest, [latest], computeKeywordFrequency(POOL), DEFAULT_LIMIT).kept.map((e) => e.memory.id);
  const r = select(POOL, latest);
  assert.equal(r.person, null);
  assert.deepEqual(ids(r), before);
});

test("another person's record never comes in through a shared word; a similar name is a different person; two names: previous selection", () => {
  const r = select(POOL, "さきさんも距離取りたいのかもしれないからちょうどいいんじゃない？");
  assert.equal(r.person?.key, "さき");
  assert.ok(!ids(r).some((id) => ["w1", "m1", "x1"].includes(id)));
  const m = select(POOL, "まさきさんから見積もりの返事が来ない");
  assert.equal(m.person?.key, "まさき");
  assert.ok(!ids(m).some((id) => id.startsWith("s")));
  const w = select(POOL, "渡邊さん、最近ちょっと距離置きたそうで寂しい");
  assert.ok(!ids(w).some((id) => id.startsWith("s")));
  assert.equal(select(POOL, "さきさんと渡邊さんの三人で打ち合わせした").person, null);
});

test("carried person with 「2人」, relationship talk: the person's records and at most one feelings record; never all of them", () => {
  const turns = ["さきさんとは今まで2人で仕事してきたけど、今回はもう一人入ってる", "そもそも2人だけの空気感でいたいんだよほんとは"];
  const r = select(POOL, turns[1], turns);
  assert.equal(r.person?.how, "carried");
  assert.ok(r.added.length <= PERSON_EXTRA_LIMIT);
  assert.ok(r.memories.length <= DEFAULT_LIMIT + PERSON_EXTRA_LIMIT + 1);
  assert.ok(ids(r).includes("s7"), "the present 'やっぱり大切'");
});

test("plain work talk about the person: no feelings record; the person's name alone never makes a record overlap", () => {
  assert.equal(isRelationshipTalk("さきさんと来週の企画のプレゼン、どっちが話すか決めないと"), false);
  const r = select(POOL, "さきさんと来週の企画のプレゼン、どっちが話すか決めないと");
  assert.equal(r.feeling, null);
  assert.ok(!ids(r).includes("s4"), "距離・寂しい is not pulled into a work question");
});

const feel = (id: string, day: string, keywords: string[], summary: string) => mem(id, day, ["さきさん", ...keywords], summary, undefined, true);
const rel = ["さきさんとは今まで2人で仕事してきたけど、今回はもう一人入ってる", "そもそも2人だけの空気感でいたいんだよほんとは"];
const base = [mem("w-a", "2026-04-10", ["さきさん", "仕事", "二人"], "さきさんと二人で企画を進めてきたと話した。", "さきさん")];

test("bias: positive newest / negative newest / quickly changing -> the newest feelings record is passed, once, with its date", () => {
  const p = select([...base, feel("f1", "2026-06-01", ["寂しい"], "寂しいと話した。"), feel("f2", "2026-10-20", ["大切"], "大切だと話した。")], rel[1], rel);
  assert.ok(ids(p).includes("f2"));
  const n = select([...base, feel("f1", "2026-08-01", ["大切"], "大切だと話した。"), feel("f2", "2026-10-25", ["怒り"], "腹が立って少し距離を置きたいと話した。")], rel[1], rel);
  assert.ok(ids(n).includes("f2"));
  assert.ok(n.memories.find((m) => m.id === "f2")!.date.startsWith("2026-10-25"));
  const c = select([...base, feel("f1", "2026-09-01", ["大切"], "大切だと話した。"), feel("f2", "2026-10-01", ["怒り"], "腹が立ったと話した。"), feel("f3", "2026-10-20", ["安心"], "仲直りして安心したと話した。")], rel[1], rel);
  assert.ok(ids(c).includes("f3"));
});

test("bias: a one-off newest mood over a feeling that keeps coming back -> the recurring feeling is passed next to it", () => {
  const r = select([...base, feel("f1", "2026-06-01", ["大切"], "大切だと話した。"), feel("f2", "2026-08-01", ["大切"], "やっぱり大切だと話した。"), feel("f3", "2026-10-01", ["大切"], "大切な存在だと話した。"), feel("f4", "2026-10-28", ["苛立ち"], "一言に少しイラッとしたと話した。")], rel[1], rel);
  assert.ok(ids(r).includes("f4"));
  assert.equal(r.feeling, "f3");
});

test("bias: a feelings record older than the age limit, or shared with another person, is never added", () => {
  const old = select([...base, feel("f1", "2025-12-01", ["大切"], "大切だと話した。")], rel[1], rel);
  assert.equal(old.feeling, null);
  assert.equal(FEELING_MAX_AGE_DAYS, 180);
  const shared = { ...feel("f1", "2026-10-20", ["渡邊さん", "嫉妬"], "渡邊さんと親しげで嫉妬したと話した。"), personMentions: [{ displayName: "さきさん", groupingKey: "さきさん" }, { displayName: "渡邊さん", groupingKey: "渡邊さん" }] } as unknown as MemoryObject;
  const s = select([...base, mem("w-b", "2026-09-01", ["渡邊さん"], "渡邊さんと打ち合わせした。", "渡邊さん"), shared], rel[1], rel);
  assert.equal(s.feeling, null);
});

test("review fixes: shared records are never extras; a keyword-only name hides a shorter one; no-person turns keep the original input; work 「大事」 is not relationship talk", () => {
  // 1. a newer record about さきさん AND 渡邊さん is never added as an extra
  const shared = { ...mem("sh", "2026-10-30", ["さきさん", "渡邊さん", "食事"], "さきさんと渡邊さんと食事したと話した。"), personMentions: [{ displayName: "さきさん", groupingKey: "さきさん" }, { displayName: "渡邊さん", groupingKey: "渡邊さん" }] } as unknown as MemoryObject;
  const r1 = select([...POOL, shared], "さきさんとプレゼンの資料を作りたい");
  assert.ok(!ids(r1).includes("sh") || selectConversationDirectMatches([...POOL, shared], "さきさんとプレゼンの資料を作りたい", ["さきさんとプレゼンの資料を作りたい"], computeKeywordFrequency([...POOL, shared]), DEFAULT_LIMIT).kept.some((e) => e.memory.id === "sh"));
  assert.ok(!r1.added.includes("sh"));
  // 2. まさきさん only as a keyword: still a different person from さきさん
  const pool2 = [mem("s1", "2026-04-10", ["さきさん", "仕事"], "さきさんと仕事をしたと話した。", "さきさん"), mem("mk", "2026-09-10", ["まさきさん", "見積"], "まさきさんに見積を出したと話した。")];
  const r2 = select(pool2, "まさきさんに見積を出したい");
  assert.notEqual(r2.person?.key, "さき");
  assert.ok(!ids(r2).includes("s1") || selectConversationDirectMatches(pool2, "まさきさんに見積を出したい", ["まさきさんに見積を出したい"], computeKeywordFrequency(pool2), DEFAULT_LIMIT).kept.some((e) => e.memory.id === "s1"));
  // 3. no person: 「2人」 is not read as 「二人」, the previous selection exactly
  const pool3 = [mem("tr", "2026-08-01", ["2人", "旅行"], "旅行の計画を立てた。")];
  const before = selectConversationDirectMatches(pool3, "2人で行く", ["2人で行く"], computeKeywordFrequency(pool3), DEFAULT_LIMIT).kept.map((e) => e.memory.id);
  assert.deepEqual(ids(select(pool3, "2人で行く")), before);
  // 4. work talk with 大事 is not relationship talk; a clear feeling word still is
  assert.equal(isRelationshipTalk("さきさんとプレゼン資料の大事な点を確認したい"), false);
  assert.equal(isRelationshipTalk("打ち合わせのあと、さきさんと距離を感じて寂しかった"), true);
  assert.equal(isRelationshipTalk("さきさんは大切な存在だと思う"), true);
});
