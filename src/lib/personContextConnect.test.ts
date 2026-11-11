/**
 * Memory Graph P1-E: a Connect link (the AI's guess from two summaries) ties a nameless record to a person only through the user's own words about
 * the person in the record it links to, and a telling word they share. Fictional people and words only (みおさん / 美緒さん / けんたさん are invented).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPersonContext, explainPersonContext } from "./personContext";
import type { Link, LinkAxis, MemoryObject, PersonMention } from "./types";

const at = (day: string, hour = "10:00") => `${day}T${hour}:00.000Z`;
function mention(name: string, quote: string, day: string): PersonMention {
  return {
    id: `pm-${name}-${day}-${quote.length}`, groupingKey: name, displayName: name, assertion: "mention", stated: "explicit",
    quote, statedAt: at(day), sourceConversationId: "c", recordedAt: at(day), origin: "ai-extracted", schemaVersion: 1,
  };
}
function mem(id: string, day: string, summary: string, extra: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id, date: at(day), statedAt: at(day), types: ["event"], conversationId: `conv-${id}`, content: summary, summary, keywords: [],
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    metadata: { id: `meta-${id}`, schemaVersion: "1", source: "ai-capture", createdAt: at(day), updatedAt: at(day) },
    createdAt: at(day), updatedAt: at(day), ...extra,
  } as MemoryObject;
}
/** a Connect link as Connect saves it: on both records */
function connect(memories: MemoryObject[], from: string, to: string, reason: string, axis: LinkAxis = "person", strength = 0.9): MemoryObject[] {
  const link: Link = { id: `link-${from}-${to}`, sourceId: from, targetId: to, axis, reason, contrast: false, strength, createdBy: "ai-inference", createdAt: at("2026-10-01") };
  return memories.map((m) => (m.id === from || m.id === to ? { ...m, links: [...m.links, link] } : m));
}

const RESTAURANT = "最近レストランの料理っていいなと思うことがある。";
const AI_REASON = "レストランに行きたい気持ちは、みおさんと一緒に行きたいという願いなのかもしれません。";

const base = (): MemoryObject[] => [
  // records of みおさん (Capture recorded her): lunch lately, her cooking, a plan of work
  mem("p1", "2026-09-01", "みおさんとランチの話。", { personMentions: [mention("みおさん", "みおさんとは最近ランチによく行く", "2026-09-01")], evidenceQuotes: ["みおさんとは最近ランチによく行く。"] }),
  mem("p2", "2026-09-03", "みおさんの料理の話。", { personMentions: [mention("みおさん", "みおさんは料理が上手だと思う", "2026-09-03")], evidenceQuotes: ["みおさんは料理が上手だと思う。"] }),
  mem("p3", "2026-09-05", "みおさんと企画の話。", { personMentions: [mention("みおさん", "みおさんとの企画はもっと良くできると思う", "2026-09-05")], evidenceQuotes: ["みおさんとの企画はもっと良くできると思う。"] }),
  // a hobby of the user, without a name: the AI summary words the AI's question as if it were about her (the user did not say so)
  mem("r1", "2026-09-10", "レストラン巡りの話。AIからみおさんと行きたいか聞かれた。", { evidenceQuotes: ["レストラン巡りをしてみたい。", RESTAURANT] }),
  // without a name, about the plan of work she was in
  mem("r2", "2026-09-12", "企画の進め方の話。", { evidenceQuotes: ["企画の進め方は見直すべきだ。"] }),
];

const candidateOf = (memories: MemoryObject[], id: string, key = "みお", aliases: string[][] = []) =>
  explainPersonContext(memories, key, { aliases }).trace.candidates.find((c) => c.memoryId === id);
const contextIds = (memories: MemoryObject[], key = "みお", aliases: string[][] = []) => buildPersonContext(memories, key, { aliases }).memoryIds;

test("case 1: a hobby record linked by Connect to her record, with nothing of her in common, is not a candidate (the link alone is not enough)", () => {
  const memories = connect(base(), "r1", "p1", AI_REASON);
  const c = candidateOf(memories, "r1");
  assert.ok(c, "the record was weighed as a candidate");
  assert.equal(c.accepted, false);
  assert.match(c.why, /Connectがあるだけでは根拠にしない/);
  assert.ok(!c.signals.includes("Connectのつながり"));
  assert.ok(!contextIds(memories).includes("r1"));
});

test("case 2: a record linked by Connect that shares a telling word with her record's words about her stays a candidate, never a fact", () => {
  const memories = connect(base(), "r2", "p3", "企画の進め方についての考えがつながっているようです。", "theme", 0.6);
  const { context, trace } = explainPersonContext(memories, "みお");
  const c = trace.candidates.find((x) => x.memoryId === "r2");
  assert.equal(c?.accepted, true);
  assert.deepEqual(c?.signals, ["Connectのつながり", "共通の言葉"]);
  assert.match(c?.why ?? "", /共通の言葉：企画/);
  assert.match(c?.why ?? "", /この人のこととは確定しない/);
  const shown = [...context.conclusions.map((x) => x.statement), ...context.candidates].filter((t) => t.memoryId === "r2");
  assert.ok(shown.length > 0 && shown.every((t) => t.kind === "candidate"), "marked as a candidate wherever it is shown");
});

test("case 3: a word shared with another of her records, not with the linked one, does not count", () => {
  // 料理 is in her record p2, but the link goes to p1 (lunch lately): before P1-E the words of all her records counted
  const memories = connect(base(), "r1", "p1", AI_REASON);
  const c = candidateOf(memories, "r1");
  assert.ok(!c?.why.includes("料理"));
  assert.equal(c?.accepted, false);
});

test("case 4: a time word or a general word alone does not tie the records", () => {
  const memories = connect(base(), "r1", "p1", AI_REASON);
  const link = candidateOf(memories, "r1")?.links?.[0];
  assert.equal(link?.used, false);
  assert.match(link?.why ?? "", /時間・一般的な言葉（最近）だけ/);
  // 今日 / 先週 / 一緒 the same way
  const more = connect([
    ...base(),
    mem("p4", "2026-09-20", "みおさんと話した。", { personMentions: [mention("みおさん", "みおさんとは先週も今日も一緒だった", "2026-09-20")] }),
    mem("r5", "2026-09-21", "週末の話。", { evidenceQuotes: ["先週も今日も一緒に出かけたいと思う。"] }),
  ], "r5", "p4", "どちらも一緒に過ごす時間の話のようです。");
  assert.equal(candidateOf(more, "r5")?.accepted, false);
  assert.match(candidateOf(more, "r5")?.links?.[0]?.why ?? "", /時間・一般的な言葉/);
});

test("case 5: a link the AI guessed (an AI question, an AI reason) is not taken as her wish, and its reason is shown only as the AI's words", () => {
  const memories = connect(base(), "r1", "p1", AI_REASON, "person", 0.95);
  const { context, trace } = explainPersonContext(memories, "みお");
  const all = JSON.stringify(context);
  assert.ok(!all.includes("レストラン"), "neither the hobby nor the AI's reading goes to the chat");
  assert.ok(!all.includes(AI_REASON));
  assert.ok(!context.conclusions.some((c) => c.statement.memoryId === "r1"));
  // the debug page shows what is saved of the link, apart from the user's words
  const link = trace.candidates.find((c) => c.memoryId === "r1")?.links?.[0];
  assert.deepEqual({ from: link?.fromId, to: link?.toId, axis: link?.axis, strength: link?.strength, reason: link?.reason }, { from: "r1", to: "p1", axis: "person", strength: 0.95, reason: AI_REASON });
});

test("case 6: without any Connect link, the candidates are as before P1-E", () => {
  const memories = [
    ...base(),
    // the same topic as her record and a word of her views: a candidate (P1-C)
    mem("t1", "2026-09-06", "企画の話。", { topicId: "topic-plan", evidenceQuotes: ["企画はもっと話し合うべきだ。"] }),
  ].map((m) => (m.id === "p3" ? { ...m, topicId: "topic-plan" } : m));
  const { trace } = explainPersonContext(memories, "みお");
  const t1 = trace.candidates.find((c) => c.memoryId === "t1");
  assert.equal(t1?.accepted, true);
  assert.deepEqual(t1?.signals, ["同じ話題", "共通の言葉"]);
  assert.equal(t1?.why, "候補にした（共通の言葉：企画）");
  assert.equal(t1?.links, undefined);
  // a shared word only (料理 of p2), no link: the P1-C reason
  const r1 = trace.candidates.find((c) => c.memoryId === "r1");
  assert.equal(r1?.accepted, false);
  assert.equal(r1?.why, "共通の言葉だけ（会話・話題・Connectのつながりが無い）");
});

test("case 7: with other people and a confirmed alias, a link joins only through the words about this person", () => {
  let memories: MemoryObject[] = [
    ...base(),
    mem("k1", "2026-09-14", "けんたさんとカメラの話。", { personMentions: [mention("けんたさん", "けんたさんとはよくカメラの話をする", "2026-09-14")] }),
    // a record of both: the sentence about カメラ is about けんたさん
    mem("p5", "2026-09-15", "みおさんとけんたさんの話。", {
      personMentions: [mention("みおさん", "みおさんと会った", "2026-09-15"), mention("けんたさん", "けんたさんはカメラに詳しい", "2026-09-15")],
      evidenceQuotes: ["みおさんと会った。", "けんたさんはカメラに詳しい。"],
    }),
    mem("r3", "2026-09-16", "カメラの話。", { evidenceQuotes: ["カメラはもっと良いものを買うべきだ。"] }),
    // another name the user may confirm as hers
    mem("m5", "2026-09-17", "美緒さんと陶芸の話。", { personMentions: [mention("美緒さん", "美緒さんの陶芸の作品は素敵だと思う", "2026-09-17")] }),
    mem("r4", "2026-09-18", "陶芸の話。", { evidenceQuotes: ["陶芸はもっと続けるべきだ。"] }),
  ];
  memories = connect(memories, "r3", "p5", "カメラの話でつながっているようです。");
  memories = connect(memories, "r3", "k1", "カメラの話でつながっているようです。");
  memories = connect(memories, "r4", "m5", "陶芸の話でつながっているようです。");
  // みおさん: the link to the record of both reads only her own sentence there (no カメラ); けんたさん's record is not hers
  const r3 = candidateOf(memories, "r3");
  assert.equal(r3?.accepted, false);
  assert.equal(r3?.links?.length, 1, "only the link to her record is read");
  assert.ok(!contextIds(memories).includes("r3"));
  // けんたさん: his own words share カメラ
  assert.equal(candidateOf(memories, "r3", "けんた")?.accepted, true);
  // 美緒さん is another person until the user confirms the name
  assert.ok(!contextIds(memories).includes("r4"));
  assert.equal(candidateOf(memories, "r4", "みお", [["みおさん", "美緒さん"]])?.accepted, true);
});
