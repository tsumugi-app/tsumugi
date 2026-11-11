/**
 * Memory Graph P1-D: only the user's sentences that are about the person go into the person context. One Memory gathers the quotes of its
 * conversation (evidenceQuotes, topicEvents), so a record with the person's name can also hold another matter of that day. Fictional people and
 * words only (みおさん / 美緒さん / けんたさん are invented).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPersonContext, explainPersonContext } from "./personContext";
import type { MemoryObject, PersonMention, TopicEvent } from "./types";

const at = (day: string, hour = "10:00") => `${day}T${hour}:00.000Z`;
function mention(name: string, quote: string, statedAt: string): PersonMention {
  return {
    id: `pm-${name}-${statedAt}-${quote.length}`, groupingKey: name, displayName: name, assertion: "mention", stated: "explicit",
    quote, statedAt, sourceConversationId: "c", recordedAt: statedAt, origin: "ai-extracted", schemaVersion: 1,
  };
}
function topicQuote(topicId: string, quote: string, statedAt: string): TopicEvent {
  return { id: `te-${topicId}-${statedAt}-${quote.length}`, topicId, quote, statedAt, sourceConversationId: "c", recordedAt: statedAt, origin: "ai-extracted", schemaVersion: 1 };
}
function mem(id: string, day: string, summary: string, extra: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id, date: at(day), statedAt: at(day), types: ["event"], conversationId: `conv-${id}`, content: summary, summary, keywords: [],
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    metadata: { id: `meta-${id}`, schemaVersion: "1", source: "ai-capture", createdAt: at(day), updatedAt: at(day) },
    createdAt: at(day), updatedAt: at(day), ...extra,
  } as MemoryObject;
}

const WORK_1 = "急に出せと言われても出せない。";
const WORK_2 = "取引先なので微妙に言いづらい。";
const ABOUT_MIO = "みおさんとは最近ぎくしゃくしている気がする";

const world = (): MemoryObject[] => [
  // case 1: one Memory of a conversation about みおさん and about a submission to a client (no name in the work sentences)
  mem("w1", "2026-09-01", "みおさんとの関係と、取引先への提出について話した。", {
    topicId: "topic-work",
    personMentions: [mention("みおさん", "みおさんとは最近ぎくしゃくしている気がする", at("2026-09-01", "10:00"))],
    evidenceQuotes: [`${ABOUT_MIO}。`, WORK_1, WORK_2],
  }),
  // case 2: the same topic, another matter, even in the same turn as the mention; a shared word only, in another quote
  mem("w2", "2026-09-03", "みおさんの企画と、提出の期限について話した。", {
    topicId: "topic-work",
    personMentions: [mention("みおさん", "みおさんの企画は大事だと思う", at("2026-09-03", "09:00"))],
    topicEvents: [
      topicQuote("topic-work", "提出の期限はもう無理だ。", at("2026-09-03", "09:00")),
      topicQuote("topic-work", "見積の数字はまだ決められない。", at("2026-09-03", "11:00")),
    ],
    evidenceQuotes: ["企画の締め切りは守るべきだ。"],
  }),
  // case 3: the user names the person in a sentence that is not the mention quote
  mem("w3", "2026-09-05", "みおさんの話。", {
    personMentions: [mention("みおさん", "みおさんの話", at("2026-09-05"))],
    evidenceQuotes: ["みおさんには感謝しているので、大切にしたい。"],
  }),
  // case 4: another name of the same person (美緒さん) in a record of みおさん, and a record of 美緒さん
  mem("w4", "2026-09-07", "みおさんの話。", {
    personMentions: [mention("みおさん", "みおさんと話した", at("2026-09-07"))],
    evidenceQuotes: ["美緒さんには本当のことを話したい。"],
  }),
  mem("w4b", "2026-09-08", "美緒さんの話。", {
    personMentions: [mention("美緒さん", "美緒さんとの約束は守るべきだ", at("2026-09-08"))],
  }),
  // case 5: not named, with something that ties it to the person
  mem("w5", "2026-09-10", "みおさんと昼休みに話した。", {
    personMentions: [mention("みおさん", "みおさんと昼休みに話した", at("2026-09-10"))],
    // 彼女 in the same quote as the person's name
    evidenceQuotes: ["みおさんと昼休みに話した。彼女はいつも周りに気を配っていると思う。"],
  }),
  mem("w6", "2026-09-12", "みおさんとの企画の打ち合わせ。", {
    personMentions: [mention("みおさん", "みおさんとの企画の打ち合わせが続く", at("2026-09-12"))],
    topicEvents: [
      // the same turn as the mention, and a word of it (企画)
      topicQuote("topic-plan", "企画のやり方はもっと話し合うべきだ。", at("2026-09-12")),
    ],
    // a pronoun with nothing that says whom it is
    evidenceQuotes: ["あの人のやり方は信用できない。"],
  }),
  // case 6: a record about みおさん and けんたさん
  mem("w7", "2026-09-14", "みおさんとけんたさんの話。", {
    personMentions: [mention("みおさん", "みおさんに相談した", at("2026-09-14")), mention("けんたさん", "けんたさんには腹が立った", at("2026-09-14"))],
    evidenceQuotes: ["けんたさんには腹が立った。", "仕事の段取りは任せるべきだ。", "みおさんとけんたさんは仲がいいと思う。"],
  }),
];

const conclusionsOf = (memories: MemoryObject[], aliases: string[][] = []) => buildPersonContext(memories, "みお", { aliases }).conclusions.map((c) => c.statement.text);
const contextText = (memories: MemoryObject[], aliases: string[][] = []) => JSON.stringify(buildPersonContext(memories, "みお", { aliases }));
const whyOf = (memories: MemoryObject[], text: string, aliases: string[][] = []) =>
  explainPersonContext(memories, "みお", { aliases }).trace.statements.find((s) => s.text === text);

test("case 1: in one Memory, the person's words stay and the work matter of the same conversation is left out (with why)", () => {
  const memories = world();
  assert.ok(conclusionsOf(memories).includes(ABOUT_MIO));
  const all = contextText(memories);
  for (const t of [WORK_1, WORK_2]) {
    assert.ok(!all.includes(t.replace(/。$/, "")), `${t} is not in the person context`);
    const w = whyOf(memories, t);
    if (w) assert.ok(!w.kept && /確かめられない/.test(w.why), `${t}: ${w.why}`);
  }
  assert.match(whyOf(memories, WORK_2)?.why ?? "", /この人の名前も、この人の話とつながる根拠も無い/);
  assert.match(whyOf(memories, ABOUT_MIO)?.basis ?? "", /この人の名前/);
});

test("case 2: a topic quote of the same topic is not taken for being in the topic, nor for being said in the same turn; a common word alone is not enough", () => {
  const memories = world();
  const all = contextText(memories);
  for (const t of ["提出の期限はもう無理だ", "見積の数字はまだ決められない", "企画の締め切りは守るべきだ"]) assert.ok(!all.includes(t), t);
  assert.match(whyOf(memories, "提出の期限はもう無理だ。")?.why ?? "", /同じ発言の別の話の可能性/);
  assert.match(whyOf(memories, "企画の締め切りは守るべきだ。")?.why ?? "", /共通の言葉（企画）だけ/);
  assert.ok(conclusionsOf(memories).includes("みおさんの企画は大事だと思う"));
});

test("case 3: a sentence where the user names the person stays", () => {
  const memories = world();
  assert.ok(conclusionsOf(memories).includes("みおさんには感謝しているので、大切にしたい。"));
  assert.match(whyOf(memories, "みおさんには感謝しているので、大切にしたい。")?.basis ?? "", /この人の名前/);
});

test("case 4: another name of the person counts only when the user confirmed it", () => {
  const memories = world();
  const alias = [["みおさん", "美緒さん"]];
  assert.ok(!contextText(memories).includes("美緒さんには本当のことを話したい"), "an unconfirmed name is another person");
  assert.ok(!contextText(memories).includes("美緒さんとの約束は守るべきだ"));
  const kept = conclusionsOf(memories, alias);
  assert.ok(kept.includes("美緒さんには本当のことを話したい。"));
  assert.ok(kept.includes("美緒さんとの約束は守るべきだ"));
});

test("case 5: a sentence that does not name the person stays when something ties it to her; a pronoun alone does not", () => {
  const memories = world();
  const kept = conclusionsOf(memories);
  assert.ok(kept.includes("彼女はいつも周りに気を配っていると思う。"), "彼女, in the same quote as her name");
  assert.match(whyOf(memories, "彼女はいつも周りに気を配っていると思う。")?.basis ?? "", /「彼女」で話していて、この人の名前を出した文と同じ引用/);
  assert.ok(kept.includes("企画のやり方はもっと話し合うべきだ。"), "the same turn as the mention, and a word of it");
  assert.match(whyOf(memories, "企画のやり方はもっと話し合うべきだ。")?.basis ?? "", /この人について話したのと同じ発言で、この人についての発言と共通の言葉（企画）/);
  assert.ok(!contextText(memories).includes("あの人のやり方は信用できない"), "a pronoun with nothing that says whom it is: left out (a trade-off)");
  assert.match(whyOf(memories, "あの人のやり方は信用できない。")?.why ?? "", /「あの人」が誰のことか確かめられない/);
});

test("case 5b (independent review): 彼は is a pronoun; その方がいい / この人生 are not; a short common ending is not taken as a part of the person's quote", () => {
  const memories = [
    mem("k1", "2026-09-20", "けんたさんと話した。", {
      personMentions: [mention("けんたさん", "けんたさんの企画は大事だと思う", at("2026-09-20"))],
      evidenceQuotes: ["けんたさんと話した。彼は本当に頼りになると思う。", "けんたさんと会った。その方が早いと思う。", "けんたさんと話した。この人生は短いと思う。", "大事だと思う。"],
    }),
  ];
  const kept = buildPersonContext(memories, "けんた").conclusions.map((c) => c.statement.text);
  assert.ok(kept.includes("彼は本当に頼りになると思う。"));
  for (const t of ["その方が早いと思う。", "この人生は短いと思う。", "大事だと思う。"]) assert.ok(!kept.includes(t), t);
});

test("case 6: in a record that also names another person, only the sentences that name this person alone are hers", () => {
  const memories = world();
  const all = contextText(memories);
  for (const t of ["けんたさんには腹が立った", "仕事の段取りは任せるべきだ", "みおさんとけんたさんは仲がいいと思う"]) assert.ok(!all.includes(t), t);
  assert.match(whyOf(memories, "仕事の段取りは任せるべきだ。")?.why ?? "", /ほかの人物も出てくる記録で、この人の名前が無い/);
});

test("a record whose quotes are all about the person is unchanged by P1-D", () => {
  const memories = [
    mem("a1", "2026-08-01", "みおさんの話。", { personMentions: [mention("みおさん", "みおさんとの関係はもう終わりにすることにした", at("2026-08-01"))] }),
    mem("a2", "2026-08-09", "理由を話した。", { personMentions: [mention("みおさん", "みおさんとの関係を終わりにすると言ったのは、自分に家庭があるからだ", at("2026-08-09"))] }),
  ];
  const [c] = buildPersonContext(memories, "みお").conclusions;
  assert.ok(c && c.statement.memoryId === "a1");
  assert.deepEqual(c.reasons.filter((r) => r.when === "later").map((r) => r.memoryId), ["a2"]);
});
