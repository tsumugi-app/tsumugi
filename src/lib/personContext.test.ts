/**
 * Memory Graph P1-A: the person context of the chat. Fictional people and events only (はるかさん / 遥さん / みなとさん are invented).
 * The world: the user talks about はるかさん; a record of the same conversation says only 「この関係に未来はない」 (no name), and its AI summary reads a
 * reason into it (distance, a cold attitude). Days later the user, calling the same person 遥さん, gives a different reason. The two names are one person
 * only when the user confirmed it (aliases).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPersonContext, personsForTurn, selectPersonContextsForTurn, withoutCoveredPersonViews } from "./personContext";
import { buildPersonContextSection, PERSON_CONTEXT_LIMITS, sanitizePersonContext } from "./personContextPrompt";
import { computePersonViews } from "./person";
import type { MemoryObject, PersonMention } from "./types";

function mention(name: string, quote: string, statedAt: string, relation?: PersonMention["relation"]): PersonMention {
  return {
    id: `pm-${name}-${statedAt}`, groupingKey: name, displayName: name, ...(relation ? { relation } : {}), assertion: "mention", stated: "explicit",
    quote, statedAt, sourceConversationId: "c", recordedAt: statedAt, origin: "ai-extracted", schemaVersion: 1,
  };
}
function mem(id: string, day: string, summary: string, extra: Partial<MemoryObject> = {}): MemoryObject {
  const at = `${day}T10:00:00.000Z`;
  return {
    id, date: at, statedAt: at, types: ["event"], conversationId: `conv-${id}`, content: summary, summary, keywords: [],
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    metadata: { id: `meta-${id}`, schemaVersion: "1", source: "ai-capture", createdAt: at, updatedAt: at },
    createdAt: at, updatedAt: at, ...extra,
  } as MemoryObject;
}

const CONCLUSION = "正直、この関係に未来はない。";
const AI_READING = "相手との距離が遠くなり、冷たい態度をとられたので、関係に未来はないと感じている。";
const LATER_REASON = "遥さんのことは、自分が既婚者だから、お互いに想っていてもこの関係に未来はない。";

const world = (): MemoryObject[] => [
  mem("h1", "2026-09-01", "はるかさんと駅前のカフェで話した。", {
    conversationId: "conv-A", keywords: ["はるかさん", "カフェ"],
    personMentions: [mention("はるかさん", "はるかさんと駅前のカフェで話した", "2026-09-01T10:00:00.000Z", "friend")],
    evidenceQuotes: ["はるかさんとの関係をどうするか、ずっと迷っている。"],
  }),
  // the same conversation, no name: a candidate (same conversation + a shared word)
  mem("n1", "2026-09-05", AI_READING, { conversationId: "conv-A", keywords: ["関係"], evidenceQuotes: [CONCLUSION] }),
  // no name, a shared word only (weak): never linked
  mem("n2", "2026-09-06", "人間関係について考えた。", { conversationId: "conv-other", evidenceQuotes: ["あの関係に未来はないと思う。"] }),
  // the same conversation, but its words name another known person: never taken for はるかさん
  mem("n3", "2026-09-06", "みなとさんとの仕事の関係に限界を感じている。", { conversationId: "conv-A", evidenceQuotes: ["仕事の関係はもう限界だ。"] }),
  // the same conversation, nothing in common: one weak link is not enough
  mem("n4", "2026-09-06", "締め切りが近くて焦っている。", { conversationId: "conv-A", evidenceQuotes: ["締め切りが近くて焦りを感じる。"] }),
  // the same person under another name; the user's later explanation
  mem("r1", "2026-09-09", "遥さんとの関係について、既婚者であることを理由に先はないと話した。", {
    conversationId: "conv-B", keywords: ["遥さん"],
    personMentions: [mention("遥さん", LATER_REASON, "2026-09-09T10:00:00.000Z")],
    evidenceQuotes: [LATER_REASON],
  }),
  mem("h4", "2026-09-10", "はるかさんと来月、美術館に行く予定。", {
    keywords: ["はるかさん", "美術館"], topicId: "topic-museum", eventTime: "2026-10",
    personMentions: [mention("はるかさん", "来月はるかさんと美術館に行く予定", "2026-09-10T10:00:00.000Z")],
  }),
  mem("m1", "2026-09-03", "みなとさんと会議をした。", {
    keywords: ["みなとさん"], personMentions: [mention("みなとさん", "みなとさんと会議した", "2026-09-03T10:00:00.000Z", "colleague")],
  }),
];
const ALIAS = [["はるかさん", "遥さん"]];

test("names: two names are one person only when the user confirmed it; similar or unconfirmed names never join", () => {
  const memories = world();
  assert.deepEqual(personsForTurn(memories, "はるかさんと遥さんのこと", []).sort(), ["はるか", "遥さん"].sort());
  assert.deepEqual(personsForTurn(memories, "はるかさんと遥さんのこと", [], ALIAS), ["はるか"]);
  assert.deepEqual(personsForTurn(memories, "遥さんのこと", [], ALIAS), ["はるか"]);
  // without the alias, はるかさん's context has no word of 遥さん's record
  const alone = buildPersonContext(memories, "はるか");
  assert.ok(!alone.memoryIds.includes("r1"));
  assert.ok(!JSON.stringify(alone).includes("既婚者"));
  // with it, the later explanation is there
  const joined = buildPersonContext(memories, "はるか", { aliases: ALIAS });
  assert.ok(joined.memoryIds.includes("r1"));
  assert.ok(joined.names.includes("遥さん") && joined.names.includes("はるかさん"));
});

test("a record without a name is a candidate only when two kinds of evidence meet, and never when it names another person", () => {
  const context = buildPersonContext(world(), "はるか");
  const ids = context.memoryIds;
  assert.ok(ids.includes("n1"), "same conversation + a shared word");
  assert.ok(!ids.includes("n2"), "a shared word alone is not enough");
  assert.ok(!ids.includes("n3"), "a record naming みなとさん is not はるかさん's");
  assert.ok(!ids.includes("n4"), "the same conversation alone is not enough");
  const n1 = context.conclusions.find((c) => c.statement.memoryId === "n1");
  assert.ok(n1);
  assert.equal(n1.statement.kind, "candidate", "always marked as a candidate, never as a fact about the person");
  // shown once: as a conclusion, not again among the candidates
  assert.ok(!context.candidates.some((c) => c.memoryId === "n1" && c.text === n1.statement.text));
  // without the conversation (it is the one in progress), there is no evidence left
  assert.ok(!buildPersonContext(world(), "はるか", { excludeConversationId: "conv-A" }).memoryIds.includes("n1"));
});

test("the earlier conclusion, the user's later reason and the AI's reading stay three distinct things; the older words are not erased", () => {
  const context = buildPersonContext(world(), "はるか", { aliases: ALIAS });
  const conclusion = context.conclusions.find((c) => c.statement.memoryId === "n1");
  assert.ok(conclusion, "the earlier conclusion is kept");
  assert.equal(conclusion.statement.text, CONCLUSION);
  const later = conclusion.reasons.filter((r) => r.when === "later");
  assert.deepEqual(later.map((r) => [r.kind, r.memoryId, r.text]), [["user", "r1", LATER_REASON]]);
  assert.deepEqual(conclusion.aiReadings.map((r) => [r.kind, r.memoryId]), [["summary", "n1"]]);
  assert.match(conclusion.aiReadings[0].text, /冷たい/);
  // the later explanation is not shown a second time as a conclusion of its own
  assert.equal(context.conclusions.filter((c) => c.statement.text === LATER_REASON).length, 0);
  const section = buildPersonContextSection(context ? [context] : []);
  const at = (s: string) => section.indexOf(s);
  assert.ok(at(CONCLUSION) > 0 && at(LATER_REASON) > at(CONCLUSION) && at("冷たい") > 0);
  assert.match(section, /後から本人が説明した理由 \[本人の発言 2026-09-09\]/);
  assert.match(section, /AIの要約の解釈（本人の説明とは違うかもしれない） \[AIの要約 2026-09-05\]/);
  assert.match(section, /\[候補・名前の無い記録 2026-09-05\] 正直、この関係に未来はない。/);
  assert.match(section, /今もそうだと決めつけず/);
  assert.match(section, /新しい記録だというだけで以前の本人の言葉を否定しないでください/);
  assert.match(section, /最後に確認できた記録：2026-09-10（それ以降のことは記録に無い）/);
});

test("old (PersonView) vs Memory Graph: the person view only lists the person's own records; the context adds the confirmed name and the candidate", () => {
  const memories = world();
  const old = computePersonViews(memories).find((v) => v.groupingKey === "はるかさん");
  assert.ok(old);
  assert.ok(!old.memoryIds.includes("n1") && !old.memoryIds.includes("r1"), "before: the nameless conclusion and the other name are out of reach");
  const [graph] = selectPersonContextsForTurn(memories, { userText: "はるかさんのこと、まだ考えてる", earlierUserTurns: [], aliases: ALIAS });
  assert.ok(graph.memoryIds.includes("n1") && graph.memoryIds.includes("r1"));
  // nothing unrelated comes along
  for (const id of ["n2", "n3", "n4", "m1"]) assert.ok(!graph.memoryIds.includes(id), id);
  // the PersonView of a covered person is not sent twice; others stay
  const views = [{ displayName: "はるかさん" }, { displayName: "みなとさん" }];
  assert.deepEqual(withoutCoveredPersonViews(views, [graph]), [{ displayName: "みなとさん" }]);
  assert.equal(withoutCoveredPersonViews([{ displayName: "はるかさん" }], [graph]), null);
  assert.equal(withoutCoveredPersonViews(views, []), views);
});

test("the people of a turn: named now, or carried from the last two user turns only; no name, no context", () => {
  const memories = world();
  assert.deepEqual(selectPersonContextsForTurn(memories, { userText: "今日は雨だった", earlierUserTurns: [] }), []);
  assert.deepEqual(personsForTurn(memories, "それでどう思う？", ["はるかさんの話", "うん"]), ["はるか"]);
  assert.deepEqual(personsForTurn(memories, "それでどう思う？", ["はるかさんの話", "うん", "そう", "雨"]), [], "too far back");
  assert.equal(buildPersonContextSection([]), "", "no context: the prompt is exactly as before");
});

test("events already given by Retrieval are not repeated; plans keep their outcome unknown when nothing says what became of them", () => {
  const context = buildPersonContext(world(), "はるか", { alreadyGivenIds: ["h1"] });
  assert.ok(!context.events.some((e) => e.memoryId === "h1"));
  assert.ok(context.events.some((e) => e.memoryId === "h4"));
  const plan = context.plans.find((p) => p.plan.memoryId === "h4");
  assert.ok(plan && !plan.outcome);
  assert.match(buildPersonContextSection([context]), /その後は記録に無い（結果は不明）/);
});

test("over the limit, conclusions are kept before thoughts, and every list stays bounded", () => {
  const memories: MemoryObject[] = [];
  memories.push(mem("j1", "2026-08-01", "みなとさんの件。", {
    personMentions: [mention("みなとさん", "みなとさんとはもう会わない", "2026-08-01T10:00:00.000Z")], evidenceQuotes: ["みなとさんとはもう会わないことにした。"],
  }));
  for (let i = 0; i < 12; i++) {
    const day = `2026-08-${String(i + 2).padStart(2, "0")}`;
    memories.push(mem(`t${i}`, day, `みなとさんのことを考えた${i}。`, {
      personMentions: [mention("みなとさん", `みなとさんのこと${i}`, `${day}T10:00:00.000Z`)], evidenceQuotes: [`みなとさんのことを第${i}案で考えている気がする。`],
    }));
  }
  const context = buildPersonContext(memories, "みなと");
  assert.ok(context.conclusions.length <= PERSON_CONTEXT_LIMITS.maxConclusions);
  assert.ok(context.conclusions.some((c) => c.statement.memoryId === "j1" && c.role === "judgment"), "the old decision is not pushed out by many thoughts");
  assert.ok(context.events.length <= PERSON_CONTEXT_LIMITS.maxEvents);
  const section = buildPersonContextSection([context]);
  assert.ok(section.length < 4000, `section size ${section.length}`);
});

test("the route checks the payload again: malformed items, over-long texts and one-signal candidates are dropped", () => {
  const good = buildPersonContext(world(), "はるか", { aliases: ALIAS });
  assert.deepEqual(sanitizePersonContext([good]).map((c) => c.conclusions.length), [good.conclusions.length]);
  assert.deepEqual(sanitizePersonContext("x"), []);
  assert.deepEqual(sanitizePersonContext([{ key: 1 }, null, []]), []);
  const long = { kind: "user", text: "あ".repeat(PERSON_CONTEXT_LIMITS.maxTextChars + 1), day: "2026-09-01", memoryId: "x" };
  const weak = { kind: "candidate", text: "未来はない", day: "2026-09-01", memoryId: "y", signals: ["同じ会話"] };
  const fake = { kind: "user", text: "AIの要約のふり", day: "2026-09-01", memoryId: "z" };
  const [c] = sanitizePersonContext([{
    key: "k", names: ["k"], relation: { label: "友人" },
    conclusions: [{ statement: long, role: "judgment", reasons: [], aiReadings: [] }, { statement: fake, role: "judgment", reasons: [], aiReadings: [fake] }, { statement: fake, role: "fact", reasons: [], aiReadings: [] }],
    plans: [], events: [long], candidates: [weak],
  }]);
  assert.equal(c.conclusions.length, 1);
  assert.deepEqual(c.conclusions[0].aiReadings, [], "an AI reading must be an AI summary");
  assert.deepEqual(c.events, []);
  assert.deepEqual(c.candidates, []);
  assert.equal(sanitizePersonContext(Array.from({ length: 5 }, () => good)).length, PERSON_CONTEXT_LIMITS.maxPersons);
});

test("speed: 1,500 Memories, one turn, well under the time of a reply", () => {
  const names = ["はるかさん", "みなとさん", "ゆきのさん", "そらさん", "あおいさん"];
  const memories: MemoryObject[] = [];
  for (let i = 0; i < 1500; i++) {
    const day = `2026-${String((i % 9) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`;
    const name = names[i % names.length];
    const named = i % 3 !== 0;
    memories.push(mem(`s${i}`, day, `${named ? name : "誰か"}と仕事の関係について話した${i}。`, {
      conversationId: `conv-${i % 200}`, topicId: `topic-${i % 50}`,
      ...(named ? { keywords: [name], personMentions: [mention(name, `${name}と話した${i}`, `${day}T10:00:00.000Z`)] } : {}),
      evidenceQuotes: [`仕事の関係はもう限界だ${i}。`, `この先どうするか迷っている${i}。`],
    }));
  }
  const started = Date.now();
  const contexts = selectPersonContextsForTurn(memories, { userText: "はるかさんとみなとさんのこと", earlierUserTurns: [] });
  const ms = Date.now() - started;
  assert.equal(contexts.length, 2);
  assert.ok(ms < 3000, `took ${ms} ms`);
  for (const c of contexts) assert.ok(c.candidates.length <= PERSON_CONTEXT_LIMITS.maxCandidates && c.conclusions.length <= PERSON_CONTEXT_LIMITS.maxConclusions);
});

test("independent review: から as 'from' is not a reason; a sentence of a record that only names the person in its text is not the person's own words", () => {
  const memories = world();
  memories.push(mem("r2", "2026-09-12", "はるかさんと会う頻度を減らすことにした。", {
    keywords: ["はるかさん"], personMentions: [mention("はるかさん", "来週から、この関係は少し距離をおくことにした", "2026-09-12T10:00:00.000Z")],
    evidenceQuotes: ["来週から、この関係は少し距離をおくことにした。"],
  }));
  // a record of みなとさん whose text names はるかさん in passing: its nameless sentences are not はるかさん's
  memories.push(mem("x1", "2026-09-13", "みなとさんと話していて、はるかさんの名前も出た。", {
    conversationId: "conv-X", personMentions: [mention("みなとさん", "みなとさんと話した", "2026-09-13T10:00:00.000Z")], evidenceQuotes: ["この関係はもう限界だ。"],
  }));
  const context = buildPersonContext(memories, "はるか", { aliases: ALIAS });
  const n1 = context.conclusions.find((c) => c.statement.memoryId === "n1");
  assert.ok(n1);
  assert.deepEqual(n1.reasons.filter((r) => r.when === "later").map((r) => r.memoryId), ["r1"], "「来週から」 is not a reason");
  assert.ok(context.conclusions.some((c) => c.statement.memoryId === "r2"), "the decision stays a conclusion of its own");
  assert.ok(!context.memoryIds.includes("x1"));
});

test("independent review: a one-character known name (妻) keeps a nameless record out; days are in Japan time", () => {
  const memories = world();
  memories.push(mem("w1", "2026-08-01", "妻と買い物に行った。", { personMentions: [mention("妻", "妻と買い物に行った", "2026-08-01T10:00:00.000Z", "spouse")] }));
  memories.push(mem("n5", "2026-09-07", "妻とのこの関係に未来はないと話した。", { conversationId: "conv-A", evidenceQuotes: ["妻とはこの関係に未来はない。"] }));
  memories.push(mem("h6", "2026-09-20", "はるかさんと電話した。", {
    statedAt: "2026-09-20T20:00:00.000Z", personMentions: [mention("はるかさん", "はるかさんと電話した", "2026-09-20T20:00:00.000Z")],
  }));
  const context = buildPersonContext(memories, "はるか");
  assert.ok(!context.memoryIds.includes("n5"));
  assert.equal(context.events.find((e) => e.memoryId === "h6")?.day, "2026-09-21");
  assert.equal(context.lastDay, "2026-09-21");
});

test("Codex on PR #34: the same words in an earlier text-only record do not hide the person's own conclusion; another person's plan is not hers", () => {
  const memories = world();
  memories.push(mem("t1", "2026-09-02", "はるかさんの話も少し出た。", { conversationId: "conv-T", evidenceQuotes: ["もう諦めることにした。"] }));
  memories.push(mem("h7", "2026-09-15", "はるかさんとのことを話した。", {
    personMentions: [mention("はるかさん", "はるかさんのことは、もう諦めることにした", "2026-09-15T10:00:00.000Z")], evidenceQuotes: ["もう諦めることにした。"],
  }));
  memories.push(mem("p1", "2026-09-16", "みなとさんは来月引っ越す予定。", {
    eventTime: "2026-10", content: "みなとさんは来月引っ越す予定。はるかさんにも伝えた。", personMentions: [mention("みなとさん", "みなとさんは来月引っ越す予定", "2026-09-16T10:00:00.000Z")],
  }));
  const context = buildPersonContext(memories, "はるか");
  const decided = context.conclusions.find((c) => c.statement.text === "もう諦めることにした。");
  assert.ok(decided, "kept from the record where Capture recorded はるかさん");
  assert.equal(decided.statement.memoryId, "h7");
  assert.ok(!context.plans.some((p) => p.plan.memoryId === "p1"));
});

test("Codex on PR #34: over the limit within one day, the latest conclusions are kept", () => {
  const memories: MemoryObject[] = [];
  for (let i = 0; i < 8; i++) {
    const at = `2026-09-01T0${i}:30:00.000Z`;
    memories.push(mem(`d${i}`, "2026-09-01", `みなとさんの件${i}。`, {
      statedAt: at, personMentions: [mention("みなとさん", `みなとさんの件${i}`, at)], evidenceQuotes: [`第${i}案はやめることにした。`],
    }));
  }
  const kept = buildPersonContext(memories, "みなと").conclusions.map((c) => c.statement.memoryId);
  assert.deepEqual(kept, ["d2", "d3", "d4", "d5", "d6", "d7"]);
});

test("Codex on PR #34: a later explanation of any sentence form is attached; another person's sentence is not taken as the AI's reading", () => {
  const at = (d: string) => `${d}T10:00:00.000Z`;
  const memories: MemoryObject[] = [
    mem("a1", "2026-09-01", "はるかさんとの関係について話した。", {
      personMentions: [mention("はるかさん", "はるかさんとの関係に未来はない", at("2026-09-01"))], evidenceQuotes: ["はるかさんとの関係に未来はない。"],
    }),
    mem("a2", "2026-09-03", "はるかさんと話した。みなとさんとの関係は、仕事が忙しいので諦めることにした。", {
      personMentions: [mention("はるかさん", "はるかさんと話した", at("2026-09-03")), mention("みなとさん", "みなとさんとは諦めた", at("2026-09-03"))],
    }),
    mem("a3", "2026-09-09", "はるかさんについて理由を話した。", {
      personMentions: [mention("はるかさん", "はるかさんとの関係に未来がない理由は、自分が既婚者だから。", at("2026-09-09"))],
      evidenceQuotes: ["はるかさんとの関係に未来がない理由は、自分が既婚者だから。"],
    }),
  ];
  const context = buildPersonContext(memories, "はるか");
  const c = context.conclusions.find((x) => x.statement.memoryId === "a1");
  assert.ok(c);
  assert.deepEqual(c.reasons.filter((r) => r.when === "later").map((r) => r.memoryId), ["a3"]);
  assert.ok(!c.aiReadings.some((r) => r.memoryId === "a2"), "みなとさん's sentence is not a reading of はるかさん's conclusion");
});

test("Codex on PR #34: a later explanation kept only as a topic quote is attached, with its own time", () => {
  const memories: MemoryObject[] = [
    mem("b1", "2026-09-01", "はるかさんとの関係について話した。", {
      personMentions: [mention("はるかさん", "はるかさんとの関係に未来はない", "2026-09-01T10:00:00.000Z")], evidenceQuotes: ["はるかさんとの関係に未来はない。"],
    }),
    mem("b2", "2026-09-01", "はるかさんについて話した。", {
      statedAt: "2026-09-01T08:00:00.000Z",
      personMentions: [mention("はるかさん", "はるかさんの話", "2026-09-01T08:00:00.000Z")],
      topicEvents: [{ id: "te-b2", topicId: "topic-h", quote: "はるかさんとの関係に未来がない理由は、自分が既婚者だから。", statedAt: "2026-09-09T10:00:00.000Z", sourceConversationId: "c", recordedAt: "2026-09-09T10:00:00.000Z", origin: "ai-extracted", schemaVersion: 1 }],
    }),
  ];
  const c = buildPersonContext(memories, "はるか").conclusions.find((x) => x.statement.memoryId === "b1");
  assert.ok(c);
  assert.deepEqual(c.reasons.filter((r) => r.when === "later").map((r) => [r.memoryId, r.day]), [["b2", "2026-09-09"]]);
});

test("Codex on PR #34: an explanation repeated after the conclusion is attached; the last day includes the times of the statements shown", () => {
  const at = (d: string) => `${d}T10:00:00.000Z`;
  const why = "はるかさんとの関係に未来がない理由は、自分が既婚者だから。";
  const memories: MemoryObject[] = [
    mem("c1", "2026-09-01", "理由を話した。", { personMentions: [mention("はるかさん", why, at("2026-09-01"))], evidenceQuotes: [why] }),
    mem("c2", "2026-09-05", "関係について話した。", { personMentions: [mention("はるかさん", "はるかさんとの関係に未来はない", at("2026-09-05"))] }),
    mem("c3", "2026-09-06", "また理由を話した。", {
      personMentions: [mention("はるかさん", "はるかさんの話", at("2026-09-06"))],
      topicEvents: [{ id: "te-c3", topicId: "topic-h", quote: why, statedAt: at("2026-09-20"), sourceConversationId: "c", recordedAt: at("2026-09-20"), origin: "ai-extracted", schemaVersion: 1 }],
    }),
  ];
  const context = buildPersonContext(memories, "はるか");
  const c = context.conclusions.find((x) => x.statement.memoryId === "c2");
  assert.ok(c);
  assert.deepEqual(c.reasons.filter((r) => r.when === "later").map((r) => [r.memoryId, r.day]), [["c3", "2026-09-20"]]);
  assert.equal(context.lastDay, "2026-09-20");
});

test("Codex on PR #34: a question is not an explanation; overlapping names are matched together", () => {
  const at = (d: string) => `${d}T10:00:00.000Z`;
  const memories: MemoryObject[] = [
    mem("e1", "2026-09-01", "まさきさんとの関係について話した。", { personMentions: [mention("まさきさん", "まさきさんとの関係に未来はない", at("2026-09-01"))] }),
    mem("e2", "2026-09-05", "まさきさんについて聞いた。", { personMentions: [mention("まさきさん", "まさきさんとの関係に未来がない理由は何だと思う？", at("2026-09-05"))] }),
    mem("e3", "2026-09-09", "まさきさんとさきさんの話をした。", {
      personMentions: [mention("まさきさん", "まさきさんとの関係に未来がない理由は、自分が既婚者だから。", at("2026-09-09")), mention("さきさん", "さきさんとも会った", at("2026-09-09"))],
    }),
  ];
  const c = buildPersonContext(memories, "まさき").conclusions.find((x) => x.statement.memoryId === "e1");
  assert.ok(c);
  assert.deepEqual(c.reasons.filter((r) => r.when === "later").map((r) => r.memoryId), ["e3"]);
});
