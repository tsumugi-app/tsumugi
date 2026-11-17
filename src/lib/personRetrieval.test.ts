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
  PERSON_ARC_LIMIT,
  PERSON_ARC_SCAN_LIMIT,
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

test("a name inside an ordinary word is not a person; a name with a particle or honorific is", () => {
  assert.deepEqual(personKeysInText("さきほどの資料を確認したい", ["さき"]), []);
  assert.deepEqual(personKeysInText("さきがそう言った", ["さき"]), ["さき"]);
  assert.deepEqual(personKeysInText("さきさんと話した", ["さき"]), ["さき"]);
  assert.deepEqual(personKeysInText("さき、元気かな", ["さき"]), ["さき"]);
  assert.deepEqual(personKeysInText("田中部長に相談した", ["田中"]), ["田中"]);
  const pool = [mem("s1", "2026-09-10", ["さきさん", "食事"], "さきさんと食事したと話した。", "さきさん")];
  const q = "さきほどの資料を確認したい";
  const before = selectConversationDirectMatches(pool, q, [q], computeKeywordFrequency(pool), DEFAULT_LIMIT).kept.map((e) => e.memory.id);
  const r = select(pool, q);
  assert.equal(r.person, null);
  assert.deepEqual(ids(r), before);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Memory Graph P1-B: names the user CONFIRMED as one person (fictional names)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const ALIAS_POOL = [
  mem("r1", "2026-09-01", ["りこさん", "引っ越し"], "りこさんが引っ越しを考えていると話した。", "りこさん"),
  mem("r2", "2026-10-01", ["りっちゃん", "新居"], "りっちゃんの新居を見に行く約束をしたと話した。", "りっちゃん"),
  mem("mr", "2026-10-05", ["まりこさん", "引っ越し"], "まりこさんも引っ越しをしたと話した。", "まりこさん"),
  mem("x2", "2026-08-05", ["旅行", "行き先"], "夏休みの行き先を決めたと話した。"),
];
const selectWith = (pool: MemoryObject[], latest: string, aliases: string[][], turns: string[] = [latest]) =>
  selectConversationWithPersons(pool, latest, turns, computeKeywordFrequency(pool), DEFAULT_LIMIT, NOW, aliases);

test("P1-B: confirmed names are one person (both names' records, once each); unconfirmed they stay apart", () => {
  const q = "りこさんの引っ越しの話をしたい";
  const apart = select(ALIAS_POOL, q);
  assert.equal(apart.person?.key, "りこ");
  assert.ok(!ids(apart).includes("r2"), "unconfirmed: the other name's record is not joined");
  const joined = selectWith(ALIAS_POOL, q, [["りこさん", "りっちゃん"]]);
  assert.ok(ids(joined).includes("r1") && ids(joined).includes("r2"));
  assert.equal(new Set(ids(joined)).size, ids(joined).length, "no Memory twice");
  assert.ok(!ids(joined).includes("mr"), "a name containing the confirmed one is another person");
  // both names in one turn: one person when confirmed, two people (the previous selection) when not
  const both = "りこさん、昔はりっちゃんって呼ばれてた";
  assert.equal(select(ALIAS_POOL, both).person, null);
  assert.notEqual(selectWith(ALIAS_POOL, both, [["りこさん", "りっちゃん"]]).person, null);
});

test("P1-B: no aliases or unusable aliases change nothing; a revoked name (not in the list) is apart again; similar names never join", () => {
  for (const q of ["りこさんの引っ越しの話をしたい", "りっちゃんの新居", "まりこさんの引っ越し", "夏休みの行き先"]) {
    const before = select(ALIAS_POOL, q);
    assert.deepEqual(selectWith(ALIAS_POOL, q, []), before, q);
    // a group whose names are not known people, a group of one key, a one-character name
    assert.deepEqual(selectWith(ALIAS_POOL, q, [["ゆうさん", "はるさん"], ["ゆうさん", "ゆうちゃん"], ["りこさん", "りこ"], ["り", "りこさん"]]), before, q);
  }
  // after a revoke the list no longer holds the pair: the same as never confirmed
  assert.deepEqual(selectWith(ALIAS_POOL, "りこさんの引っ越しの話をしたい", []), select(ALIAS_POOL, "りこさんの引っ越しの話をしたい"));
  // まりこ is never joined through りこ (partial match), even when りこ is confirmed with りっちゃん
  const m = selectWith(ALIAS_POOL, "まりこさんの引っ越し", [["りこさん", "りっちゃん"]]);
  assert.equal(m.person?.key, "まりこ");
  assert.ok(!ids(m).includes("r1") && !ids(m).includes("r2"));
});

test("P1-B: a carried person keeps the confirmed group; another person's record is still kept out", () => {
  const turns = ["りっちゃんの新居を見に行く", "新居はどのあたりなんだろう"];
  const r = selectWith(ALIAS_POOL, turns[1], [["りこさん", "りっちゃん"]], turns);
  assert.equal(r.person?.how, "carried");
  assert.ok(!ids(r).includes("mr"));
});

test("P1-B: an earlier turn with two confirmed names of one person still carries that person (unconfirmed: two people, nothing carried)", () => {
  const turns = ["りこさん、昔はりっちゃんって呼ばれてた", "新居はどのあたりなんだろう"];
  assert.equal(select(ALIAS_POOL, turns[1], turns).person, null);
  const r = selectWith(ALIAS_POOL, turns[1], [["りこさん", "りっちゃん"]], turns);
  assert.equal(r.person?.how, "carried");
  assert.ok(ids(r).includes("r2"));
  assert.ok(!ids(r).includes("mr"));
});

// the change of a relationship: the records that explain it (fictional person あおいさん, NOW = 2026-11-01)
const reflection = (m: MemoryObject) => ({ ...m, metadata: { ...(m.metadata as object), source: "system-generated" }, evidenceQuotes: [] }) as unknown as MemoryObject;
const AOI = [
  mem("a0", "2025-09-01", ["あおいさん"], "あおいさんと初めて会って、緊張したと話した。", "あおいさん"),
  mem("a1", "2026-01-10", ["あおいさん", "旅行"], "あおいさんと旅行の計画を立てたと話した。", "あおいさん"),
  mem("a2", "2026-03-05", ["あおいさん"], "あおいさんに冷たくされた気がして寂しいと話した。", "あおいさん", true),
  mem("a3", "2026-05-20", ["あおいさん", "ランチ"], "あおいさんとランチに行ったと話した。", "あおいさん"),
  mem("a4", "2026-07-15", ["あおいさん"], "あおいさんと本音で話して、また頼れるようになったと話した。", "あおいさん"),
  mem("a5", "2026-08-01", ["あおいさん", "髪型"], "あおいさんが髪型を変えて、イメージが変わったと話した。", "あおいさん"),
  mem("a6", "2026-09-10", ["あおいさん", "カレー"], "あおいさんとの夕食はカレーにしたと話した。", "あおいさん"),
  reflection(mem("a7", "2026-09-20", ["あおいさん"], "あおいさんとの関係は、以前より安心できるものに変わったのだろう。", "あおいさん")),
  mem("ab", "2026-06-01", ["あおいさん", "はるきさん"], "あおいさんとはるきさんの関係が変わったと話した。", "あおいさん"),
  mem("h1", "2026-06-10", ["はるきさん"], "はるきさんと前より話せるようになったと話した。", "はるきさん"),
  mem("a9", "2026-10-25", ["あおいさん", "映画"], "あおいさんと映画を観たと話した。", "あおいさん"),
];
AOI.find((m) => m.id === "ab")!.personMentions!.push({ ...AOI.find((m) => m.id === "h1")!.personMentions![0] });

test("person arc: a question about how the relationship changed gets the change and the feeling before it, not the oldest, a looks change, a decision, a reflection or another person", () => {
  const r = select(AOI, "あおいさんとの関係って、どう変わってきたと思う？");
  assert.equal(r.person?.key, "あおい");
  assert.deepEqual(r.arc, ["a2", "a4"], `the feeling before the change, then the change (${r.arc.join(", ")})`);
  for (const id of ["a0", "a5", "a6", "a7", "ab", "h1"]) assert.ok(!ids(r).includes(id) || id === "a9", `${id} is not taken (${ids(r).join(", ")})`);
  assert.ok(ids(r).includes("a9"), "the newest record stays");
  assert.ok(r.arc.length <= PERSON_ARC_LIMIT);
  // the change without a relationship word: 「頼れるようになった」 still comes before the newer looks change 「イメージが変わった」 and the decision 「カレーにした」
  const plain = AOI.map((m) => (m.id === "a4" ? mem("a4", "2026-07-15", ["あおいさん"], "あおいさんと話して、また頼れるようになったと話した。", "あおいさん") : m));
  assert.deepEqual(select(plain, "あおいさんとの関係って、どう変わってきたと思う？").arc, ["a2", "a4"]);
});

test("person arc: the name left out (carried person) works the same; no relationship word, no change word, or another person: nothing added", () => {
  const carried = select(AOI, "あの人への気持ちって、どう変わってきたんだろう", ["あおいさんのこと話したい", "あの人への気持ちって、どう変わってきたんだろう"]);
  assert.equal(carried.person?.how, "carried");
  assert.deepEqual(carried.arc, ["a2", "a4"]);
  assert.deepEqual(select(AOI, "あおいさん、髪型変えたんだって").arc, [], "a looks change is not a relationship change");
  assert.deepEqual(select(AOI, "あおいさんとの関係ってどう？").arc, [], "no change asked");
  assert.deepEqual(select(AOI, "仕事の進め方が変わった").arc, [], "no person");
  const h = select(AOI, "はるきさんとの関係って、どう変わった？");
  assert.ok(!h.arc.some((id) => id.startsWith("a")), "only はるきさん's own records");
});

test("person arc: the original change-yuki shape (no feeling word in the records) gets the start and the change; many records stay bounded", () => {
  const Y = [
    mem("y1", "2026-06-07", ["ゆうきさん", "友人"], "友人のゆうきさんと約束のことで喧嘩したと話した。", "ゆうきさん"),
    mem("y2", "2026-07-19", ["ゆうきさん"], "ゆうきさんとまだ気まずいと話した。", "ゆうきさん"),
    mem("y3", "2026-09-06", ["ゆうきさん", "仲直り"], "ゆうきさんに謝って、また話せるようになったと話した。", "ゆうきさん"),
    mem("y4", "2026-10-25", ["ゆうきさん", "自転車"], "ゆうきさんと一緒に自転車で出かけて楽しかったと話した。", "ゆうきさん"),
  ];
  assert.deepEqual(select(Y, "ゆうきさんへの気持ちって、どう変わってきたと思う？").arc, ["y1", "y3"]);
  // 90 records of one person: only the newest PERSON_ARC_SCAN_LIMIT are looked at, at most PERSON_ARC_LIMIT added
  const many = Array.from({ length: 90 }, (_, i) => mem(`m${i}`, new Date(Date.parse("2026-10-30T12:00:00.000Z") - i * 86_400_000).toISOString().slice(0, 10), ["ゆうきさん"], i === 70 ? "ゆうきさんと話せるようになったと話した。" : `ゆうきさんと${i}回目の話をしたと話した。`, "ゆうきさん"));
  const r = select(many, "ゆうきさんとの関係って、どう変わってきた？");
  assert.ok(r.arc.length <= PERSON_ARC_LIMIT);
  assert.ok(!r.arc.includes("m70"), `beyond the newest ${PERSON_ARC_SCAN_LIMIT} records (${r.arc.join(", ")})`);
});

test("person arc (review on this PR): the change already selected is the anchor; 「この前は」 / a decision without a relationship word is not a change; the relationship word must be in the latest turn; the nearest feeling before the change", () => {
  const ASK = "ゆうきさんへの気持ちって、どう変わってきたと思う？";
  // the newest record is the change itself (already selected): the record before it is the argument, not an older trivial 「にした」
  const newestIsChange = [
    mem("c1", "2026-01-15", ["ゆうきさん"], "ゆうきさんと初めて会ったと話した。", "ゆうきさん"),
    mem("c2", "2026-02-10", ["ゆうきさん", "髪型"], "ゆうきさんが髪型を変えたと話した。", "ゆうきさん"),
    mem("c3", "2026-03-20", ["ゆうきさん", "喧嘩"], "ゆうきさんと約束のことで喧嘩したと話した。", "ゆうきさん"),
    mem("c4", "2026-06-01", ["ゆうきさん", "夕食"], "ゆうきさんとの夕食はカレーにしたと話した。", "ゆうきさん"),
    mem("c5", "2026-10-20", ["ゆうきさん"], "ゆうきさんとまた話せるようになったと話した。", "ゆうきさん"),
  ];
  const a = select(newestIsChange, ASK);
  assert.ok(ids(a).includes("c5"));
  assert.ok(!a.arc.includes("c4") && !a.arc.includes("c2"), `no trivial change (${a.arc.join(", ")})`);
  // known limit: 「喧嘩」 is not a feeling / relationship word of the existing lists, so with none in the records the start is the oldest (c1), not the argument (c3)
  assert.deepEqual(a.arc, ["c1"], "before the change: the oldest when no record has a feeling / relationship word");
  // 「この前は」 is not a change phrase
  const konomae = [
    mem("k1", "2026-05-01", ["ゆうきさん"], "ゆうきさんと気まずくなったと話した。", "ゆうきさん"),
    mem("k2", "2026-07-01", ["ゆうきさん"], "ゆうきさんとまた話せるようになったと話した。", "ゆうきさん"),
    mem("k3", "2026-09-01", ["ゆうきさん", "飲み会"], "この前はゆうきさんと飲みに行ったと話した。", "ゆうきさん"),
    mem("k4", "2026-10-20", ["ゆうきさん", "映画"], "ゆうきさんと映画を観たと話した。", "ゆうきさん"),
  ];
  assert.deepEqual(select(konomae, ASK).arc, ["k1", "k2"]);
  // a relationship word only in the previous turn does not make a looks change a relationship change
  assert.deepEqual(select(konomae, "ゆうきさん、髪型変えたんだって", ["ゆうきさんと距離ができて寂しい", "ゆうきさん、髪型変えたんだって"]).arc, []);
  // the feeling nearest before the change, not the oldest feeling
  const nearest = [
    mem("n1", "2026-01-10", ["ゆうきさん"], "ゆうきさんと初めて会えて嬉しかったと話した。", "ゆうきさん", true),
    mem("n2", "2026-06-10", ["ゆうきさん"], "ゆうきさんと距離ができて寂しいと話した。", "ゆうきさん", true),
    mem("n3", "2026-08-10", ["ゆうきさん"], "ゆうきさんとまた話せるようになったと話した。", "ゆうきさん"),
    mem("n4", "2026-10-20", ["ゆうきさん", "映画"], "ゆうきさんと映画を観たと話した。", "ゆうきさん"),
  ];
  assert.deepEqual(select(nearest, ASK).arc, ["n2", "n3"]);
});
