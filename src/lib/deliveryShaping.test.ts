/**
 * 配送の整形（deliveryShaping.ts）：拒否が1つでもあれば全量配送（入力そのまま）、
 * 拒否が無ければ Profile T（話題を開いた発言）/ Profile P（純粋な気持ちの共有）だけが
 * 経緯2チャネルの届ける量を絞ることを確かめる。架空のデータだけ、AI呼び出しなし。
 * Run: `npm run test:delivery-shaping`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_SHAPING_MAX_CHARS, shapeDelivery, type DeliveryShapingInput } from "./deliveryShaping";
import { asksPastQuestion } from "./recordRelevance";
import type { SynthesisThemeContext, SynthesisTimelinePoint } from "./memorySynthesis";
import type { TopicTimeline } from "./topicEvent";
import type { MemoryObject } from "./types";

const mem = (id: string, day: string, summary: string, keywords: string[], extra: Record<string, unknown> = {}): MemoryObject =>
  ({
    id, date: day, types: ["event"], content: summary, summary, keywords,
    conversationId: `conv-${id}`,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    evidenceQuotes: [summary],
    createdAt: `${day}T10:00:00.000Z`, updatedAt: `${day}T10:00:00.000Z`,
    ...extra,
  }) as unknown as MemoryObject;

const mention = (id: string, name: string, day: string) => ({
  id: `pm-${id}`, groupingKey: name, displayName: name, assertion: "mention", stated: "explicit",
  quote: "…", statedAt: `${day}T10:00:00.000Z`, sourceConversationId: `conv-${id}`,
  recordedAt: `${day}T10:00:00.000Z`, origin: "ai-extracted", schemaVersion: 1,
});

// ---- 車の世界（テーマ「車」＋ topic-car） ----
const CAR_POOL: MemoryObject[] = [
  mem("car-1", "2026-04-10", "車の買い替えを考え始めたと話した", ["車", "買い替え"], { topicId: "topic-car" }),
  mem("car-2", "2026-06-15", "車の試乗に行ってSUVが気になったと話した", ["車", "試乗"], { topicId: "topic-car" }),
  mem("car-3", "2026-08-20", "車は修理して乗り続けることにしたと話した", ["車", "修理"], { topicId: "topic-car" }),
  mem("car-4", "2026-10-05", "やっぱり車を買い替えたいと話した", ["車", "買い替え"], { topicId: "topic-car" }),
];

// ---- 沙織さんの世界（人物が特定でき、関係の経緯がある） ----
const SAORI_POOL: MemoryObject[] = [
  mem("saori-1", "2026-05-10", "沙織さんと仕事の進め方で言い合いになったと話した", ["沙織さん", "仕事"], { personMentions: [mention("saori-1", "沙織", "2026-05-10")] }),
  mem("saori-2", "2026-07-15", "沙織さんとの距離を感じて、少しほっとしたと話した", ["沙織さん", "距離"], { personMentions: [mention("saori-2", "沙織", "2026-07-15")] }),
  mem("saori-3", "2026-10-20", "沙織さんと最近また距離を感じるようになったと話した", ["沙織さん", "距離"], { personMentions: [mention("saori-3", "沙織", "2026-10-20")] }),
];

const point = (memoryId: string, day: string, flags: Partial<SynthesisTimelinePoint> = {}): SynthesisTimelinePoint => ({
  memoryId,
  statedAt: `${day}T10:00:00.000Z`,
  statedAtIsRecordDate: false,
  summary: `summary-${memoryId}`,
  retrospective: false,
  latestSaid: false,
  latestEvent: false,
  stateBasis: false,
  ...flags,
});

const carContext = (): SynthesisThemeContext => ({
  theme: "車",
  state: {
    status: "検討中",
    basisMemoryId: "car-3",
    basisStatedAt: "2026-08-20T10:00:00.000Z",
    basisSummary: "車は修理して乗り続けることにしたと話した",
    earlier: [{ status: "保留", statedAt: "2026-06-15T10:00:00.000Z", summary: "車の試乗に行ってSUVが気になったと話した", memoryId: "car-2" }],
  },
  timeline: [
    point("car-1", "2026-04-10"),
    point("car-2", "2026-06-15", { earlierState: true }),
    point("car-3", "2026-08-20", { stateBasis: true }),
    point("car-4", "2026-10-05", { latestSaid: true, latestEvent: true }),
  ],
  items: [],
});

const saoriContext = (): SynthesisThemeContext => ({
  theme: "沙織さん",
  state: {
    status: "保留",
    basisMemoryId: "saori-3",
    basisStatedAt: "2026-10-20T10:00:00.000Z",
    basisSummary: "沙織さんと最近また距離を感じるようになったと話した",
    earlier: [{ status: "実施済み", statedAt: "2026-07-15T10:00:00.000Z", summary: "沙織さんとの距離を感じて、少しほっとしたと話した", memoryId: "saori-2" }],
  },
  timeline: [
    point("saori-1", "2026-05-10", { earlierState: true }),
    point("saori-2", "2026-07-15"),
    point("saori-3", "2026-10-20", { latestSaid: true, stateBasis: true }),
  ],
  items: [],
});

const carTopic = (): TopicTimeline => ({
  topicId: "topic-car",
  events: [
    { time: "2026-04-10T10:00:00.000Z", quote: "車の買い替えを考え始めた", sourceConversationId: "conv-car-1" },
    { time: "2026-08-20T10:00:00.000Z", quote: "車は修理して乗り続けることにした", sourceConversationId: "conv-car-3" },
    { time: "2026-10-05T10:00:00.000Z", quote: "やっぱり車を買い替えたい", sourceConversationId: "conv-car-4" },
  ],
});

const baseInput = (over: Partial<DeliveryShapingInput> = {}): DeliveryShapingInput => ({
  text: "車を検討している",
  persona: "companion",
  realtimeDiary: false,
  recentUserTurns: ["車を検討している"],
  pool: CAR_POOL,
  personAliases: [],
  topicTimelineContext: [carTopic()],
  memoryTimelineContext: [carContext()],
  explicitSearchPresent: false,
  memoryAnalyticsPresent: false,
  ...over,
});

const saoriInput = (over: Partial<DeliveryShapingInput> = {}): DeliveryShapingInput =>
  baseInput({
    text: "沙織さんとの距離をすごく感じる",
    recentUserTurns: ["沙織さんとの距離をすごく感じる"],
    pool: SAORI_POOL,
    topicTimelineContext: [carTopic()],
    memoryTimelineContext: [saoriContext()],
    ...over,
  });

/** 全量配送のときは、入力の配列がそのまま（同じ参照で）返る＝下流のバイト同一の土台 */
const assertUnchanged = (input: DeliveryShapingInput, blockedBy?: string) => {
  const result = shapeDelivery(input);
  assert.equal(result.profile, null);
  if (blockedBy) assert.equal(result.blockedBy, blockedBy);
  assert.equal(result.topicTimelineContext, input.topicTimelineContext);
  assert.equal(result.memoryTimelineContext, input.memoryTimelineContext);
  return result;
};

test("asksPastQuestion (veto 7'): question form AND past-pointing form must coincide", () => {
  assert.equal(asksPastQuestion("車のこと、どう考えてた？"), true);
  assert.equal(asksPastQuestion("前に何て言ったっけ"), true);
  assert.equal(asksPastQuestion("車、何がいいかな？"), false, "a question about now is not past-pointing");
  assert.equal(asksPastQuestion("今日は何しようかな？"), false);
  assert.equal(asksPastQuestion("車を検討している"), false, "no question form");
  assert.equal(asksPastQuestion("沙織さんとの距離、前より感じる？"), false, "前より is not the past-pointing form the frozen design uses");
});

test("scope: analyst and the realtime diary are never shaped; coach is shaped like companion", () => {
  assertUnchanged(baseInput({ persona: "analyst" }), "persona");
  assertUnchanged(baseInput({ realtimeDiary: true }), "realtime-diary");
  assertUnchanged(baseInput({ topicTimelineContext: [], memoryTimelineContext: [] }), "no-timeline");
  assert.equal(shapeDelivery(baseInput({ persona: "coach" })).profile, "T");
});

test("veto 1: a record request keeps full delivery", () => {
  assertUnchanged(baseInput({ text: "ここまでの話、記録しておいて", recentUserTurns: ["ここまでの話、記録しておいて"] }), "veto1-record-request");
});

test("veto 2: a reflective query keeps full delivery", () => {
  assertUnchanged(baseInput({ text: "私って、繰り返し同じこと言ってる？", recentUserTurns: ["私って、繰り返し同じこと言ってる？"] }), "veto2-reflective");
});

test("veto 3: an established explicit search / analytics turn keeps full delivery", () => {
  assertUnchanged(baseInput({ explicitSearchPresent: true }), "veto3-search-analytics");
  assertUnchanged(baseInput({ memoryAnalyticsPresent: true }), "veto3-search-analytics");
});

test("veto 4: a reason question keeps full delivery", () => {
  // reasonAsked via purposeContextOf (a past-pointing reason question; not reflective — no recall word)
  assertUnchanged(baseInput({ text: "車を買うって決めた理由って何だっけ？", recentUserTurns: ["車を買うって決めた理由って何だっけ？"] }), "veto4-purpose-reason");
});

test("veto 5: person-change phrasing keeps full delivery even on a feeling-sharing turn", () => {
  assertUnchanged(
    saoriInput({ text: "沙織さんとは、前ほど話さなくなった", recentUserTurns: ["沙織さんとは、前ほど話さなくなった"] }),
    "veto5-person-change-phrasing"
  );
});

test("veto 6: a recall question keeps full delivery", () => {
  assertUnchanged(baseInput({ text: "車のこと、前に何て言ったっけ", recentUserTurns: ["車のこと、前に何て言ったっけ"] }), "veto6-recall");
});

test("veto 7': a past-pointing question keeps full delivery", () => {
  assertUnchanged(baseInput({ text: "車のこと、どう考えてた？", recentUserTurns: ["車のこと、どう考えてた？"] }), "veto7-past-question");
});

test("veto 8: a timeline carrying corrections keeps full delivery (shaping never removes a correction)", () => {
  const withCorrections: SynthesisThemeContext = {
    ...carContext(),
    corrections: [{ kind: "corrected", saidAt: "2026-09-13", userQuote: "本当は修理じゃなくて買い替えなんだ", aboutReading: "修理で済ますつもりだろう" }],
  };
  assertUnchanged(baseInput({ memoryTimelineContext: [withCorrections] }), "veto8-corrections");
  // an empty corrections list is not a correction: shaping proceeds
  assert.equal(shapeDelivery(baseInput({ memoryTimelineContext: [{ ...carContext(), corrections: [] }] })).profile, "T");
});

test("veto 9: a long utterance (the deep-consultation shape) keeps full delivery", () => {
  const text = "今の仕事を辞めて独立するか、ずっと迷っているんだ。どう思う？";
  assert.equal(Array.from(text).length, 30, "fixture sanity: the guard utterance is longer than the threshold");
  assert.equal(DELIVERY_SHAPING_MAX_CHARS, 25);
  assertUnchanged(baseInput({ text, recentUserTurns: [text] }), "veto9-not-short");
});

test("Profile T: a topic-opening turn keeps the state block, trims points to basis + latest said, and the topic timeline to the latest quote", () => {
  const input = baseInput();
  const snapshot = JSON.stringify({ t: input.topicTimelineContext, m: input.memoryTimelineContext });
  const result = shapeDelivery(input);
  assert.equal(result.profile, "T");
  const memory = result.memoryTimelineContext[0];
  assert.deepEqual(memory.state, carContext().state, "the state block (incl. earlier-state lines) is intact");
  assert.deepEqual(memory.timeline.map((p) => p.memoryId), ["car-3", "car-4"], "only the state basis and the latest said point remain");
  const topic = result.topicTimelineContext[0];
  assert.equal(topic.events.length, 1);
  assert.equal(topic.events[0].quote, "やっぱり車を買い替えたい");
  // verbatim principle: a shaped quote exists verbatim in the unshaped delivery
  assert.ok(carTopic().events.some((e) => e.quote === topic.events[0].quote && e.time === topic.events[0].time));
  assert.equal(JSON.stringify({ t: input.topicTimelineContext, m: input.memoryTimelineContext }), snapshot, "inputs are not mutated");
});

test("Profile T: a theme already opened in this conversation is not trimmed", () => {
  assertUnchanged(
    baseInput({ recentUserTurns: ["車の修理の見積もりが来た", "車を検討している"] }),
    "no-theme-opened"
  );
});

test("Profile T: a topic-continuity signal keeps full delivery", () => {
  assertUnchanged(baseInput({ text: "昨日の車の話だけど", recentUserTurns: ["昨日の車の話だけど"] }), "topic-continuity");
});

test("Profile T: the everyday recommendation question (case 10 shape) fires T, not a veto", () => {
  const result = shapeDelivery(baseInput({ text: "車、何がいいかな？", recentUserTurns: ["車、何がいいかな？"] }));
  assert.equal(result.profile, "T");
});

test("Profile P: pure feeling sharing drops the earlier-state lines and keeps only the latest said point", () => {
  const input = saoriInput();
  const snapshot = JSON.stringify({ t: input.topicTimelineContext, m: input.memoryTimelineContext });
  const result = shapeDelivery(input);
  assert.equal(result.profile, "P");
  const memory = result.memoryTimelineContext[0];
  assert.equal(memory.state.earlier, undefined, "the contrast scaffold (earlier-state lines) is removed");
  assert.equal(memory.state.status, saoriContext().state.status, "the current state line itself stays");
  assert.equal(memory.state.basisSummary, saoriContext().state.basisSummary);
  assert.deepEqual(memory.timeline.map((p) => p.memoryId), ["saori-3"], "only the latest said point remains");
  assert.equal(result.topicTimelineContext[0].events.length, 1, "topic timelines are trimmed to the latest quote too");
  assert.equal(JSON.stringify({ t: input.topicTimelineContext, m: input.memoryTimelineContext }), snapshot, "inputs are not mutated");
});

test("Profile P: feeling sharing in question form (case 13 shape) still fires P", () => {
  const result = shapeDelivery(saoriInput({ text: "沙織さんとの距離、前より感じる？", recentUserTurns: ["沙織さんとの距離、前より感じる？"] }));
  assert.equal(result.profile, "P");
  assert.equal(result.memoryTimelineContext[0].state.earlier, undefined);
});

test("degenerate inputs: no pool, empty points, empty events, blank text — no errors, no shaping anomalies", () => {
  assertUnchanged(baseInput({ text: "", recentUserTurns: [], pool: [] }), "no-theme-opened");
  const empty = shapeDelivery(
    baseInput({
      topicTimelineContext: [{ topicId: "topic-car", events: [] }],
      memoryTimelineContext: [{ ...carContext(), timeline: [] }],
    })
  );
  assert.equal(empty.profile, "T");
  assert.equal(empty.memoryTimelineContext[0].timeline.length, 0);
  assert.equal(empty.topicTimelineContext[0].events.length, 0);
});
