/**
 * Memory Graph P1-C: how the person context CHOOSES what fits its limits. Fictional people and words only (そらさん / あおいさん / ひなたさん /
 * 日向さん / そうたさん are invented). Each test names the case of the owner's request (1–7) it covers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPersonContext, explainPersonContext, selectPersonContextsForTurn } from "./personContext";
import { buildPersonContextSection, sanitizePersonContext, PERSON_CONTEXT_LIMITS } from "./personContextPrompt";
import { buildPersonSheet } from "./personSheet";
import { classifyStatement } from "./personStatement";
import { stanceOf } from "./personStance";
import type { MemoryObject, PersonMention } from "./types";

const at = (day: string) => `${day}T10:00:00.000Z`;
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
/** a record where Capture recorded そらさん, with the user's words */
const sora = (id: string, day: string, words: string, extra: Partial<MemoryObject> = {}) =>
  mem(id, day, extra.summary ?? "そらさんのことを話した。", { personMentions: [mention("そらさん", "そらさんの話", day)], evidenceQuotes: [words], ...extra });

const WISH_1 = "そらさんのことは大切にしたい。";
const WISH_2 = "そらさんにとって特別な存在でありたい。";
const CONCLUSION = "そらさんとの関係に未来はない。";
const EXPLANATION = "そらさんとの関係に未来がないと言ったのは、自分に家庭があるからだ。";

/** the world of cases 1–3: three important views in June–July, then many short words in October, and the user's later explanation */
const world = (): MemoryObject[] => [
  // two other people: the words 仕事 / 関係 are also in the user's words about them, so they tell nothing about そらさん
  mem("o1", "2026-05-01", "あおいさんと打ち合わせをした。", {
    personMentions: [mention("あおいさん", "あおいさんとの仕事の関係は順調だ", "2026-05-01")], evidenceQuotes: ["仕事の関係で、今日も打ち合わせをした。"],
  }),
  mem("o2", "2026-05-02", "うみさんと電話した。", { personMentions: [mention("うみさん", "うみさんとは仕事の関係だけだ", "2026-05-02")] }),
  sora("s1", "2026-06-05", WISH_1, { topicId: "topic-sora" }),
  sora("s2", "2026-06-20", WISH_2),
  sora("s3", "2026-07-01", CONCLUSION, { topicId: "topic-sora" }),
  sora("r1", "2026-10-01", "もう半年だよ。"),
  sora("r2", "2026-10-02", "これでいいのかよくわからない。"),
  sora("r3", "2026-10-03", "前ほどではないが、それでも消えてくれない。"),
  sora("r4", "2026-10-04", "やっぱりつらい。"),
  sora("r5", "2026-10-05", "もう遅い。"),
  sora("r6", "2026-10-06", "今日は雨だった。"),
  sora("r7", "2026-10-07", "そらさんのことを考えると、胸が苦しくなる気がする。"),
  sora("r8", "2026-10-08", "そらさんとは、これからも連絡を取り合うと思う。"),
  sora("x9", "2026-10-10", EXPLANATION, { topicId: "topic-sora" }),
];
const statementsOf = (memories: MemoryObject[], extra: Parameters<typeof buildPersonContext>[2] = {}) =>
  buildPersonContext(memories, "そら", extra).conclusions;

test("stances: a situation, a doubt and a passing feeling are told apart from a conclusion and a wish (form and predicate, no names)", () => {
  const s = (t: string) => stanceOf(t, classifyStatement(t).role).stance;
  assert.equal(s("もう半年だよ。"), "situation");
  assert.equal(s("これでいいのかよくわからない。"), "uncertain");
  assert.equal(s("前ほどではないが、それでも消えてくれない。"), "feeling");
  assert.equal(s("大切にしたい。"), "wish");
  assert.equal(s("特別な存在でありたい。"), "wish");
  assert.equal(s("大切にしたいと思う。"), "wish");
  assert.equal(s("この関係に未来はない。"), "decision");
  assert.equal(s("もう会わないことにした。"), "decision");
  assert.notEqual(s("態度が冷たい。"), "wish", "冷たい is an adjective, not a wish");
  assert.equal(s("これからも連絡を取り合うと思う。"), "view");
  assert.equal(s("楽しかった。"), "feeling");
  // independent review: polite and hedged decisions, a decision after a doubt, が-ない situations, kana adjectives, unlisted judgments
  assert.equal(s("もう連絡するのはやめます。"), "decision");
  assert.equal(s("もう会いません。"), "decision");
  assert.equal(s("やめようと思う。"), "view", "hedged: not decided yet");
  assert.equal(s("どうしたらいいのか分からなかったけど、もう会わないことにした。"), "decision");
  assert.notEqual(s("返事がない。"), "decision");
  assert.notEqual(s("じれったい。"), "wish");
  assert.notEqual(s("つめたい。"), "wish");
  assert.equal(s("あの人は信用できない。"), "view");
  assert.equal(stanceOf("実は来月引っ越すことになった。", "report").explains, false);
  assert.equal(stanceOf("未来がないと言ったのは、家庭があるからだ。", "judgment").explains, true);
  assert.equal(stanceOf("未来がないと言ったのは、家庭があるからだ。", "judgment").stance, "view", "an explanation is a view of its own");
});

test("case 1: short situations and passing feelings no longer push out the user's wishes and conclusion", () => {
  const memories = world();
  const kept = statementsOf(memories);
  const texts = kept.map((c) => c.statement.text);
  assert.ok(kept.length <= PERSON_CONTEXT_LIMITS.maxConclusions);
  for (const t of [WISH_1, WISH_2, CONCLUSION]) assert.ok(texts.includes(t), t);
  for (const t of ["もう半年だよ。", "やっぱりつらい。", "今日は雨だった。"]) assert.ok(!texts.includes(t), t);
  // what each passed view is, in the prompt
  const section = buildPersonContextSection(sanitizePersonContext([buildPersonContext(memories, "そら")]));
  assert.match(section, /- 願い \[本人の発言 2026-06-05\] そらさんのことは大切にしたい。/);
  assert.match(section, /- 結論 \[本人の発言 2026-07-01\] そらさんとの関係に未来はない。/);
  assert.match(section, /- その時の気持ち \[本人の発言 2026-10-07\]/);
  // an outright sentence without a listed word is a view, not dropped as a situation (independent review)
  assert.match(section, /- 考え \[本人の発言 2026-10-05\] もう遅い。/);
  assert.match(section, /「その時の気持ち」「迷い」はその時点の気持ちで、結論ではありません/);
  assert.doesNotMatch(section, /結論 \[本人の発言 2026-10-01\] もう半年だよ/);
  // the debug trace says why the situations are out
  const { trace } = explainPersonContext(memories, "そら");
  assert.equal(trace.statements.find((x) => x.memoryId === "r1")?.why, "状況の説明なので、考え・結論には入れない");
  assert.equal(trace.statements.find((x) => x.memoryId === "r4")?.why, "短い一時的な気持ち・迷いなので入れない");
});

test("case 2: an older important view is not pushed out by many newer statements of the same weight (time diversity)", () => {
  const memories: MemoryObject[] = [sora("old", "2026-03-01", "そらさんとはもう会わないことにした。")];
  const subjects = ["映画", "料理", "読書", "散歩", "音楽", "写真", "旅行", "勉強"];
  subjects.forEach((w, i) => memories.push(sora(`n${i}`, `2026-10-${String(i + 1).padStart(2, "0")}`, `${w}の計画はやめることにした。`)));
  const kept = statementsOf(memories).map((c) => c.statement.memoryId);
  assert.equal(kept.length, PERSON_CONTEXT_LIMITS.maxConclusions);
  assert.ok(kept.includes("old"), `the March decision stays: ${kept.join(",")}`);
  // within one month the later ones go first, as before
  assert.ok(kept.includes("n7") && !kept.includes("n0"));
});

test("case 3: the user's later explanation stays with the earlier conclusion, is not shown twice, and beats the AI's reading", () => {
  const memories = world();
  const c = statementsOf(memories).find((x) => x.statement.text === CONCLUSION);
  assert.ok(c);
  const later = c.reasons.filter((r) => r.when === "later");
  assert.deepEqual(later.map((r) => [r.memoryId, r.link]), [["x9", "topic"]], "same topic: not a guess");
  assert.ok(!statementsOf(memories).some((x) => x.statement.memoryId === "x9"), "shown under the conclusion only");
  // the explanation is kept even when many other views compete (the conclusion with it weighs more)
  const crowded = [...memories];
  for (let i = 0; i < 10; i++) crowded.push(sora(`w${i}`, `2026-11-${String(i + 1).padStart(2, "0")}`, `そらさんの第${i}案のことは大事だ。`));
  const kept = statementsOf(crowded).find((x) => x.statement.text === CONCLUSION);
  assert.ok(kept && kept.reasons.some((r) => r.memoryId === "x9"), "the reason is not lost to the limit");
  // without a shared topic the link is marked as a guess
  const noTopic = memories.map((m) => ({ ...m, topicId: undefined }));
  const guessed = statementsOf(noTopic).find((x) => x.statement.text === CONCLUSION);
  assert.deepEqual(guessed?.reasons.filter((r) => r.when === "later").map((r) => r.link), ["word"]);
  const section = buildPersonContextSection(sanitizePersonContext([buildPersonContext(noTopic, "そら")]));
  assert.match(section, /後から本人が説明した理由 \[本人の発言 2026-10-10\] .*（関連は推測：共通の言葉から）/);
  // a word that is also in the user's words about someone else (関係) links nothing on its own
  const onlyGeneric = [...world().filter((m) => m.id !== "x9"), sora("x8", "2026-10-11", "仕事の関係がうまくいかないのは、忙しいからだ。")];
  const g = statementsOf(onlyGeneric).find((x) => x.statement.text === CONCLUSION);
  assert.ok(g && !g.reasons.some((r) => r.memoryId === "x8"));
});

test("case 4: a newer thought that is not an explanation or a correction is not tied to the old conclusion, and the old one stays", () => {
  const memories = [...world(), sora("y1", "2026-10-20", "そらさんとの未来のことは、今は考えないようにしたい。")];
  const kept = statementsOf(memories);
  const c = kept.find((x) => x.statement.text === CONCLUSION);
  assert.ok(c, "the old conclusion is not deleted by the newer thought");
  assert.ok(!c.reasons.some((r) => r.memoryId === "y1"));
  assert.ok(kept.some((x) => x.statement.memoryId === "y1" && x.stance === "wish"), "the new thought stands on its own");
});

test("case 5: a question or a request to the AI, saved with a plan word in its summary, is not passed as a plan; a wish is passed as a wish", () => {
  const memories = [
    ...world(),
    mem("q1", "2026-10-12", "以前のそらさんとの関係についての考えを整理したいと考えている。", {
      personMentions: [mention("そらさん", "前にそらさんとの未来はないと言った理由を整理してほしい", "2026-10-12")],
    }),
    mem("q2", "2026-10-13", "去年のそらさんとの旅行を振り返り、また行くつもりだったと話した。", {
      personMentions: [mention("そらさん", "去年のそらさんとの旅行、楽しかったな", "2026-10-13")],
    }),
    mem("p1", "2026-10-14", "来週そらさんと映画に行く予定。", {
      eventTime: "2026-10-21", personMentions: [mention("そらさん", "来週そらさんと映画に行く予定", "2026-10-14")],
    }),
    mem("p2", "2026-10-15", "そらさんといつか旅行に行きたいと思っている。", {
      personMentions: [mention("そらさん", "いつかそらさんと旅行に行きたい", "2026-10-15")],
    }),
  ];
  // the sheet (P0) still lists them all as plans: the context is where they are told apart
  const sheetPlans = buildPersonSheet(memories, "そら", { lite: true }).plans.map((p) => p.record.memoryId);
  for (const id of ["q1", "q2", "p1", "p2"]) assert.ok(sheetPlans.includes(id), id);
  const { context, trace } = explainPersonContext(memories, "そら");
  assert.deepEqual(context.plans.map((p) => [p.plan.memoryId, p.type]), [["p1", "plan"], ["p2", "wish"]]);
  assert.equal(trace.plans.find((p) => p.memoryId === "q1")?.kind, "ask-ai");
  assert.equal(trace.plans.find((p) => p.memoryId === "q2")?.kind, "retrospective");
  const section = buildPersonContextSection(sanitizePersonContext([context]));
  assert.match(section, /- 予定 \[AIの要約 2026-10-14\] 来週そらさんと映画に行く予定。/);
  assert.match(section, /- 希望（予定ではない） \[AIの要約 2026-10-15\]/);
  assert.doesNotMatch(section, /整理したい/, "neither a plan nor an event");
  assert.ok(!context.events.some((e) => e.memoryId === "q1"));
});

test("case 6: nameless records of the same conversation or topic are candidates only with a telling shared word AND a structural link", () => {
  const memories = [
    ...world(),
    // the same conversation as そらさん's conclusion, a word of hers (未来): a candidate
    mem("n1", "2026-07-01", "関係の先行きについて話した。", { conversationId: "conv-s3", evidenceQuotes: ["この関係に未来はないと思う。"] }),
    // the same conversation, a work record: nothing of hers in the words
    mem("n2", "2026-07-01", "締め切りについて話した。", { conversationId: "conv-s3", evidenceQuotes: ["仕事の締め切りに間に合わないのは無理だ。"] }),
    // the same conversation and topic, but an unrelated work matter (before P1-C two structural links were enough)
    mem("n6", "2026-07-01", "経費精算について話した。", { conversationId: "conv-s3", topicId: "topic-sora", evidenceQuotes: ["経費精算は今月中に出すべきだ。"] }),
    // the shared word only, in another conversation
    mem("n4", "2026-07-02", "将来について考えた。", { conversationId: "conv-x", evidenceQuotes: ["やっぱり未来はないと思う。"] }),
    // a conversation about two people: the conversation says nothing about whom
    mem("a1", "2026-07-03", "あおいさんとの話。", { conversationId: "conv-mix", personMentions: [mention("あおいさん", "あおいさんと話した", "2026-07-03")] }),
    sora("s5", "2026-07-03", "そらさんのことも少し話した。", { conversationId: "conv-mix" }),
    mem("n5", "2026-07-03", "将来について話した。", { conversationId: "conv-mix", evidenceQuotes: ["結局、未来はないと思う。"] }),
  ];
  const { context, trace } = explainPersonContext(memories, "そら");
  assert.ok(context.memoryIds.includes("n1"));
  for (const id of ["n2", "n6", "n4", "n5"]) assert.ok(!context.memoryIds.includes(id), id);
  const why = (id: string) => trace.candidates.find((c) => c.memoryId === id);
  assert.equal(why("n1")?.accepted, true);
  assert.deepEqual(why("n6")?.signals, ["同じ会話", "同じ話題"]);
  assert.equal(why("n6")?.why, "会話・話題のつながりだけで、この人の話と分かる言葉が無い");
  assert.match(why("n5")?.why ?? "", /ほかの人物の話もある会話/);
  assert.match(why("n4")?.why ?? "", /共通の言葉だけ/);
  // the user's later explanation is shown once, under the user's own conclusion (not again under the candidate)
  const under = context.conclusions.filter((c) => c.reasons.some((r) => r.memoryId === "x9")).map((c) => c.statement.memoryId);
  assert.deepEqual(under, ["s3"]);
  // a candidate is never turned into a fact: marked as one wherever it is shown
  const shown = [...context.conclusions.map((c) => c.statement), ...context.candidates].filter((t) => t.memoryId === "n1");
  assert.ok(shown.length > 0 && shown.every((t) => t.kind === "candidate"));
});

test("case 7: same name, confirmed alias and another person: only confirmed names join, another person's words never come in", () => {
  const memories = [
    mem("h1", "2026-08-01", "ひなたさんの話。", { personMentions: [mention("ひなたさん", "ひなたさんの話", "2026-08-01")], evidenceQuotes: ["ひなたさんのことは信じたい。"] }),
    mem("h2", "2026-08-05", "日向さんの話。", { personMentions: [mention("日向さん", "日向さんの話", "2026-08-05")], evidenceQuotes: ["日向さんとの約束は守るべきだ。"] }),
    mem("h3", "2026-08-07", "ひなたさんとそうたさんの話。", {
      personMentions: [mention("ひなたさん", "ひなたさんと会った", "2026-08-07"), mention("そうたさん", "そうたさんとはもう会わない", "2026-08-07")],
      evidenceQuotes: ["そうたさんとはもう会わないことにした。"],
    }),
    // a similar but different name
    mem("h4", "2026-08-09", "ひなこさんの話。", { personMentions: [mention("ひなこさん", "ひなこさんの話", "2026-08-09")], evidenceQuotes: ["ひなこさんには感謝したい。"] }),
  ];
  const ids = (aliases: string[][]) => buildPersonContext(memories, "ひなた", { aliases }).conclusions.map((c) => c.statement.memoryId);
  assert.deepEqual(ids([]), ["h1"]);
  assert.deepEqual(ids([["ひなたさん", "日向さん"]]), ["h1", "h2"]);
  for (const a of [[], [["ひなたさん", "日向さん"]]]) {
    const t = JSON.stringify(buildPersonContext(memories, "ひなた", { aliases: a }));
    assert.ok(!t.includes("そうたさんとはもう会わないことにした") && !t.includes("ひなこ"), "another person's words and a similar name stay out");
  }
});

test("a simple question Retrieval answers: the context does not repeat the answer, stays small, and adds nothing when no one is named", () => {
  const memories = [
    ...world(),
    mem("p1", "2026-10-14", "来週そらさんと映画に行く予定。", {
      eventTime: "2026-10-21", personMentions: [mention("そらさん", "来週そらさんと映画に行く予定", "2026-10-14")],
    }),
  ];
  const [c] = selectPersonContextsForTurn(memories, { userText: "そらさんと映画に行くのはいつだっけ？", earlierUserTurns: [], alreadyGivenIds: ["p1"] });
  assert.ok(c);
  assert.ok(!c.memoryIds.includes("p1"), "what Retrieval gives is not repeated");
  const section = buildPersonContextSection([c]);
  assert.ok(section.length < 3000, `section size ${section.length}`);
  assert.match(section, /今の話に必要なときだけ使い/);
  assert.deepEqual(selectPersonContextsForTurn(memories, { userText: "映画は何時からだっけ？", earlierUserTurns: [] }), []);
});

test("Codex on PR #36: the same words on two days count as coming back to them; another person's confirmed aliases are one person", () => {
  const twice = [...world(), sora("s1b", "2026-09-01", WISH_1)];
  const c = statementsOf(twice).find((x) => x.statement.text === WISH_1);
  assert.ok(c && c.repeated === true);
  assert.ok(!statementsOf(world()).find((x) => x.statement.text === WISH_1)?.repeated);
  // 旅行 is used about あおいさん and 青井さん only: one person when confirmed, so the word still tells something about そらさん
  const memories = [
    sora("t1", "2026-06-01", "そらさんとの旅行は大事だ。"),
    mem("t2", "2026-06-02", "あおいさんの話。", { personMentions: [mention("あおいさん", "あおいさんと旅行の話をした", "2026-06-02")] }),
    mem("t3", "2026-06-03", "青井さんの話。", { personMentions: [mention("青井さん", "青井さんと旅行の話をした", "2026-06-03")] }),
    mem("t4", "2026-06-01", "旅行の話。", { conversationId: "conv-t1", evidenceQuotes: ["旅行はやめることにした。"] }),
  ];
  assert.ok(!buildPersonContext(memories, "そら").memoryIds.includes("t4"), "unconfirmed: two other people use 旅行");
  assert.ok(buildPersonContext(memories, "そら", { aliases: [["あおいさん", "青井さん"]] }).memoryIds.includes("t4"));
});

test("Codex on PR #36: a request about plans is not a plan; a plan told inside a question is", () => {
  const memories = [
    ...world(),
    mem("q3", "2026-10-20", "そらさんとの予定を整理したいとAIに依頼した。", { personMentions: [mention("そらさん", "そらさんとの予定を整理してほしい。", "2026-10-20")] }),
    mem("q4", "2026-10-21", "来週そらさんと会う予定で、服装を相談した。", { personMentions: [mention("そらさん", "来週そらさんと会うんだけど、何を着ていけばいい？", "2026-10-21")] }),
  ];
  const { context, trace } = explainPersonContext(memories, "そら");
  assert.equal(trace.plans.find((p) => p.memoryId === "q3")?.kind, "ask-ai");
  assert.ok(!context.events.some((e) => e.memoryId === "q3"));
  assert.equal(trace.plans.find((p) => p.memoryId === "q4")?.kind, "plan");
});

test("the route keeps the new fields only in their known shapes", () => {
  const good = buildPersonContext(world(), "そら");
  const [clean] = sanitizePersonContext([good]);
  assert.deepEqual(clean.conclusions.map((c) => c.stance), good.conclusions.map((c) => c.stance));
  const bad = JSON.parse(JSON.stringify(good));
  bad.conclusions[0].stance = "situation";
  bad.conclusions[0].repeated = "yes";
  bad.conclusions.forEach((c: { reasons: { link?: string }[] }) => c.reasons.forEach((r) => { r.link = "maybe"; }));
  bad.plans = [{ plan: { kind: "summary", text: "x", day: "2026-10-01", memoryId: "m" }, type: "promise" }];
  const [b] = sanitizePersonContext([bad]);
  assert.equal(b.conclusions[0].stance, undefined);
  assert.equal(b.conclusions[0].repeated, undefined);
  assert.ok(b.conclusions.every((c) => c.reasons.every((r) => r.link === undefined)));
  assert.equal(b.plans[0].type, undefined);
  assert.match(buildPersonContextSection([b]), /- 予定 \[AIの要約 2026-10-01\] x/, "an unknown type reads as before");
});
