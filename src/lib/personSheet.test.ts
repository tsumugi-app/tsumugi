/**
 * Memory Graph P0: the person sheet (debug view). Fictional people and events only (みなとさん / ゆきのさん / まなとさん / 妻 are invented).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPersonSheet, listSheetPersons, personSheetKey, renderPersonSheetText } from "./personSheet";
import { normalizeSheetMemories, readMemoriesForPersonSheet } from "./personSheetRead";
import type { Link, MemoryObject, PersonMention, TopicEvent } from "./types";

function mention(name: string, quote: string, statedAt: string, relation?: PersonMention["relation"]): PersonMention {
  return {
    id: `pm-${name}-${statedAt}`, groupingKey: name, displayName: name, ...(relation ? { relation } : {}), assertion: "mention", stated: "explicit",
    quote, statedAt, sourceConversationId: "c", recordedAt: statedAt, origin: "ai-extracted", schemaVersion: 1,
  };
}
function topicEvent(topicId: string, quote: string, statedAt: string): TopicEvent {
  return { id: `te-${quote}`, topicId, quote, statedAt, sourceConversationId: "c", recordedAt: statedAt, origin: "ai-extracted", schemaVersion: 1 };
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
function link(id: string, sourceId: string, targetId: string, reason: string): Link {
  return { id, sourceId, targetId, axis: "person", reason, contrast: false, strength: 0.8, createdBy: "ai-inference", createdAt: "2026-08-01T00:00:00.000Z" };
}

const T1 = "topic-meeting";
const world = (): MemoryObject[] => [
  mem("m1", "2026-07-10", "会議室で、みなとさんと仕事の進め方と距離感について話した。", {
    keywords: ["みなとさん", "会議室", "仕事"], topicId: T1,
    personMentions: [mention("みなとさん", "会議室でみなとさんと進め方の話をした", "2026-07-10T10:00:00.000Z", "colleague")],
    evidenceQuotes: ["会議室でみなとさんと進め方の話をした", "ちょっと距離が近すぎるのかもと思った"],
    topicEvents: [topicEvent(T1, "会議室でみなとさんと進め方の話をした", "2026-07-10T10:00:00.000Z")],
    links: [link("l1", "m1", "o1", "同じ職場の人間関係")],
  }),
  mem("m2", "2026-07-24", "みなとさんへのDMを控えるようにしている。", {
    keywords: ["みなとさん", "DM"], topicId: T1,
    personMentions: [mention("みなと", "みなとにDMするのは控えてる", "2026-07-24T10:00:00.000Z")],
    evidenceQuotes: ["みなとにDMするのは控えてる"],
    topicEvents: [topicEvent(T1, "みなとにDMするのは控えてる", "2026-07-24T10:00:00.000Z")],
  }),
  mem("m3", "2026-08-15", "みなとさんとの関係について、先の見通しが立たないと話した。", {
    keywords: ["みなとさん", "関係"],
    personMentions: [mention("みなとさん", "みなとさんとは、正直もう未来はないと思ってる", "2026-08-15T10:00:00.000Z")],
    evidenceQuotes: ["みなとさんとは、正直もう未来はないと思ってる"],
  }),
  mem("m4", "2026-09-01", "みなとさんと来月の勉強会に行く予定。", {
    keywords: ["みなとさん", "勉強会"], topicId: "topic-study", eventTime: "2026-10",
    personMentions: [mention("みなとさん", "来月みなとさんと勉強会に行く予定", "2026-09-01T10:00:00.000Z")],
  }),
  mem("m5", "2026-09-20", "勉強会は中止になった。", { keywords: ["勉強会"], topicId: "topic-study" }),
  mem("m6", "2026-10-05", "みなとさんの話はキーワードだけに残っている記録。", { keywords: ["みなとさん", "雑談"] }),
  // another person, similar words: must not enter みなとさん's sheet
  mem("o1", "2026-08-20", "ゆきのさんとの関係には未来がないと感じている。", {
    keywords: ["ゆきのさん", "関係"], topicId: T1,
    personMentions: [mention("ゆきのさん", "ゆきのさんとは未来がない気がする", "2026-08-20T10:00:00.000Z", "friend")],
    evidenceQuotes: ["ゆきのさんとは未来がない気がする"],
    topicEvents: [topicEvent(T1, "ゆきのさんとは未来がない気がする", "2026-08-20T10:00:00.000Z")],
  }),
  // a name that contains みなと, and a different way of naming (never joined)
  mem("o2", "2026-08-25", "まなとさんと飲みに行った。", { keywords: ["まなとさん"], personMentions: [mention("まなとさん", "まなとさんと飲んだ", "2026-08-25T10:00:00.000Z")] }),
  mem("o3", "2026-08-26", "妻と買い物に行った。", { keywords: ["妻"], personMentions: [mention("妻", "妻と買い物に行った", "2026-08-26T10:00:00.000Z", "spouse")] }),
];

test("names that differ only by an honorific are one person; a different name is never joined", () => {
  assert.equal(personSheetKey("みなとさん"), "みなと");
  assert.equal(personSheetKey("みなと"), "みなと");
  const list = listSheetPersons(world());
  const minato = list.find((p) => p.key === "みなと");
  assert.ok(minato);
  assert.deepEqual([...minato!.names].sort(), ["みなと", "みなとさん"].sort());
  assert.equal(minato!.mentionRecords, 4);
  assert.equal(minato!.keywordOnlyRecords, 1);
  assert.ok(list.some((p) => p.key === "妻"));
  assert.ok(list.some((p) => p.key === "ゆきの"));
});

test("the sheet holds this person's records only; keyword-only records are marked; another person's similar record is left out", () => {
  const sheet = buildPersonSheet(world(), "みなと");
  assert.deepEqual(sheet.records.map((r) => r.memoryId), ["m1", "m2", "m3", "m4", "m6"]);
  assert.equal(sheet.records.find((r) => r.memoryId === "m6")!.match, "keyword");
  assert.equal(sheet.records.find((r) => r.memoryId === "m1")!.match, "mention");
  assert.ok(!sheet.records.some((r) => r.memoryId === "o1"));
  assert.ok(!sheet.views.some((v) => v.text.memoryId === "o1"));
  assert.equal(sheet.overview.mentionRecords, 4);
  assert.equal(sheet.overview.keywordOnlyRecords, 1);
});

test("every line says what it is and which Memory it rests on: the user's words, the AI summary, Connect's reading", () => {
  const sheet = buildPersonSheet(world(), "みなと");
  const m3 = sheet.records.find((r) => r.memoryId === "m3")!;
  assert.equal(m3.summary.kind, "summary");
  assert.equal(m3.mentionQuotes[0].kind, "user");
  assert.equal(m3.mentionQuotes[0].text, "みなとさんとは、正直もう未来はないと思ってる");
  assert.equal(m3.mentionQuotes[0].memoryId, "m3");
  const view = sheet.views.find((v) => v.text.text.includes("未来はない"));
  assert.ok(view, "the past view in the user's words is in the sheet");
  assert.equal(view!.text.kind, "user");
  assert.equal(view!.text.memoryId, "m3");
  assert.equal(sheet.links.length, 1);
  assert.equal(sheet.links[0].otherEndAboutPerson, false, "the other end of the link is about someone else");
  const text = renderPersonSheetText(sheet);
  assert.match(text, /\[本人の発言 2026-08-15 #m3\] みなとさんとは、正直もう未来はないと思ってる/);
  assert.match(text, /\[AIの要約 2026-07-10 #m1\]/);
  assert.match(text, /Connectの推測（AIが判定したつながり。事実ではない）/);
  assert.match(text, /相手側はこの人の記録ではない/);
});

test("the relation comes from the user's stated words; a view from the AI summary appears only when the record has no such words of the user", () => {
  const sheet = buildPersonSheet(world(), "みなと");
  assert.equal(sheet.overview.relation?.label, "同僚");
  assert.ok(sheet.overview.relation?.basis.every((b) => b.kind === "user"));
  // m1 has a view in the user's words (思った) → no summary view from m1
  assert.ok(!sheet.views.some((v) => v.text.memoryId === "m1" && v.text.kind === "summary"));
  assert.ok(sheet.views.some((v) => v.text.memoryId === "m1" && v.text.kind === "user"));
});

test("the last records are shown with their dates and are not called the present state", () => {
  const sheet = buildPersonSheet(world(), "みなと");
  assert.equal(sheet.last.said?.memoryId, "m6");
  assert.equal(sheet.last.ownView?.text.memoryId, "m3");
  assert.equal(sheet.last.relation?.relation, "colleague");
  const text = renderPersonSheetText(sheet);
  assert.match(text, /最後に確認できた記録（今も同じとは限らない）/);
  assert.doesNotMatch(text, /現在の状態：/);
});

test("a plan is followed only by a later record of the same topic; nothing later means the result is unknown", () => {
  const sheet = buildPersonSheet(world(), "みなと");
  const plan = sheet.plans.find((p) => p.record.memoryId === "m4");
  assert.ok(plan);
  assert.deepEqual(plan!.sameTopicLater.map((l) => [l.memoryId, l.status]), [["m5", "中止"]]);
  const lone = buildPersonSheet(world().filter((m) => m.id !== "m5"), "みなと").plans.find((p) => p.record.memoryId === "m4")!;
  assert.equal(lone.sameTopicLater.length, 0);
  assert.match(renderPersonSheetText(buildPersonSheet(world().filter((m) => m.id !== "m5"), "みなと")), /その後の記録なし（結果は不明）/);
});

test("a topic shared with another person: the user's words of the topic are shown, and the other person's record of the topic is marked", () => {
  const sheet = buildPersonSheet(world(), "みなと");
  const topic = sheet.topics.find((t) => t.topicId === T1)!;
  assert.deepEqual(topic.events.map((e) => e.memoryId), ["m1", "m2", "o1"]);
  assert.deepEqual(topic.events.find((e) => e.memoryId === "o1")!.otherPersons, ["ゆきの"]);
  assert.deepEqual(topic.otherRecords.map((o) => o.memoryId), ["o1"]);
});

test("a name that contains this one is listed as similar and never merged", () => {
  const sheet = buildPersonSheet(world(), "みなと");
  assert.ok(!sheet.similarNames.includes("まなと"), "まなと does not contain みなと");
  const w = [...world(), mem("o4", "2026-09-02", "みなとこさんと話した。", { keywords: ["みなとこさん"], personMentions: [mention("みなとこさん", "みなとこさんと話した", "2026-09-02T10:00:00.000Z")] })];
  const s2 = buildPersonSheet(w, "みなと");
  assert.ok(s2.similarNames.includes("みなとこ"));
  assert.ok(!s2.records.some((r) => r.memoryId === "o4"));
  // the user's words naming the longer name are flagged as possibly about someone else
  const w3 = [...world(), mem("m7", "2026-09-03", "みなとさんの話。", { keywords: ["みなとさん"], evidenceQuotes: ["みなとこさんにも相談したいと思う"] })];
  const s3 = buildPersonSheet([...w3, ...w.slice(-1)], "みなと");
  assert.equal(s3.records.find((r) => r.memoryId === "m7")!.evidence[0].aboutOther, true);
});

test("no fixed limit: every record about the person is in the sheet", () => {
  const many = Array.from({ length: 40 }, (_, i) => mem(`n${i}`, `2026-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, "0")}`, `みなとさんと話した記録${i}。`, {
    keywords: ["みなとさん"], personMentions: [mention("みなとさん", `みなとさんと話した${i}`, "2026-05-01T00:00:00.000Z")],
  }));
  const sheet = buildPersonSheet(many, "みなと");
  assert.equal(sheet.records.length, 40);
  assert.equal(renderPersonSheetText(sheet).split("\n").filter((l) => l.startsWith("- 2026")).length, 40);
});

test("building the sheet changes nothing in the Memories", () => {
  const w = world();
  const before = JSON.stringify(w);
  buildPersonSheet(w, "みなと");
  renderPersonSheetText(buildPersonSheet(w, "ゆきの"));
  assert.equal(JSON.stringify(w), before);
});

test("the reader skips records of an unexpected shape and fills absent lists; a missing database is not created", async () => {
  const { memories, skipped, droppedItems } = normalizeSheetMemories([null, { id: 1 }, { id: "a", summary: "s", date: "2026-01-01" }]);
  assert.equal(droppedItems, 0);
  assert.equal(skipped, 2);
  assert.deepEqual(memories[0].keywords, []);
  assert.deepEqual(memories[0].links, []);
  let opened = false;
  const fake = { databases: async () => [], open: () => { opened = true; throw new Error("must not open"); } } as unknown as IDBFactory;
  const result = await readMemoriesForPersonSheet(fake);
  assert.equal(result.missing, true);
  assert.equal(opened, false);
});

test("the person sheet is a debug view only: no chat, Retrieval or write path imports it, and its reader never writes", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = path.join(process.cwd(), "src");
  const importers: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue;
      if (/from ["'](@\/lib\/|\.\/)personSheet(Read)?["']/.test(fs.readFileSync(p, "utf8"))) importers.push(path.relative(src, p).split(path.sep).join("/"));
    }
  };
  walk(src);
  assert.deepEqual(importers.sort(), ["components/PersonSheetDiagnostics.tsx"]);
  const reader = fs.readFileSync(path.join(src, "lib", "personSheetRead.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(reader, /readwrite|\.put\(|\.add\(|\.delete\(|\.clear\(|deleteDatabase|fetch\(|localStorage|from ["'].*\/(db|vault)["']/);
  const sheet = fs.readFileSync(path.join(src, "lib", "personSheet.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(sheet, /fetch\(|indexedDB|localStorage|from ["'].*\/(db|vault|selectedAi|retrieval)["']/);
});

test("the same words are not shown twice; the relation category stays apart from the user's words; a later record of the same topic follows the last status", () => {
  const sheet = buildPersonSheet(world(), "みなと");
  const m3 = sheet.records.find((r) => r.memoryId === "m3")!;
  assert.equal(m3.mentionQuotes.length, 1);
  assert.equal(m3.evidence.length, 0, "the evidence quote equal to the mention quote is not repeated");
  assert.equal(sheet.records.find((r) => r.memoryId === "m1")!.evidence.length, 1);
  assert.equal(sheet.overview.relation!.basis[0].text, "会議室でみなとさんと進め方の話をした");
  assert.equal(sheet.overview.relation!.basis[0].relation, "colleague");
  assert.equal(sheet.last.status?.memoryId, "m4");
  assert.deepEqual(sheet.last.statusLater?.map((l) => [l.memoryId, l.status]), [["m5", "中止"]]);
  assert.match(renderPersonSheetText(sheet), /同じ話題の後の記録（この人の記録とは限らない）：2026-09-20 #m5 「中止」/);
});

test("Codex on PR #32: a one-character person is someone else; a relation added later counts at its own date; a kept topic quote keeps its topic", () => {
  const w = [
    ...world(),
    mem("m8", "2026-10-10", "みなとさんと妻の話をした。", {
      keywords: ["みなとさん", "妻"],
      personMentions: [mention("みなとさん", "みなとさんにも話した", "2026-10-10T10:00:00.000Z"), mention("妻", "妻のことが心配で不安に思う", "2026-10-10T10:00:00.000Z", "spouse")],
      evidenceQuotes: ["妻のことが心配で不安に思う"],
    }),
  ];
  const sheet = buildPersonSheet(w, "みなと");
  const m8 = sheet.records.find((r) => r.memoryId === "m8")!;
  assert.equal(m8.evidence[0].aboutOther, true, "a statement about 妻 is not this person's");
  assert.notEqual(sheet.last.ownView?.text.memoryId, "m8");
  assert.ok(!sheet.similarNames.includes("妻"));

  // an older Memory that gained a relation mention later (Capture UPDATE keeps the Memory's statedAt)
  const w2 = world().map((m) => m.id === "m1"
    ? { ...m, personMentions: [...(m.personMentions ?? []), mention("みなとさん", "みなとさんは今は友達", "2026-10-20T10:00:00.000Z", "friend")] }
    : m);
  const s2 = buildPersonSheet(w2, "みなと");
  assert.equal(s2.last.relation?.relation, "friend");
  assert.equal(s2.last.relation?.saidAt.slice(0, 10), "2026-10-20");

  // a Memory whose topicId changed but kept quotes of its earlier topic
  const w3 = world().map((m) => m.id === "m2" ? { ...m, topicId: "topic-new", topicEvents: [...(m.topicEvents ?? []), topicEvent("topic-old", "前の話題でのみなとの話", "2026-07-01T10:00:00.000Z")] } : m);
  const s3 = buildPersonSheet(w3, "みなと");
  assert.ok(s3.topics.some((t) => t.topicId === "topic-old" && t.events.some((e) => e.quote === "前の話題でのみなとの話")));
});

test("Codex on PR #32: a malformed person mention, quote, link or topic quote is left out instead of breaking the sheet", () => {
  const bad = {
    ...mem("b1", "2026-09-05", "みなとさんの記録。"),
    keywords: ["みなとさん", 7],
    evidenceQuotes: ["ふつうの発言", { x: 1 }],
    personMentions: [{ displayName: "みなとさん", quote: 17, assertion: "mention" }, mention("みなとさん", "みなとさんと会った", "2026-09-05T10:00:00.000Z"), { displayName: "みなとさん", quote: "x", assertion: "mention", relation: "rival" }],
    links: [{ id: "lx", sourceId: "b1", targetId: "m1" }],
    topicEvents: [{ topicId: "t", quote: null, statedAt: "2026-09-05T10:00:00.000Z" }],
  };
  const { memories, skipped, droppedItems } = normalizeSheetMemories([...world(), bad]);
  assert.equal(skipped, 0);
  assert.equal(droppedItems, 6);
  const b1 = memories.find((m) => m.id === "b1")!;
  assert.equal(b1.personMentions!.length, 1);
  const sheet = buildPersonSheet(memories, "みなと");
  assert.ok(sheet.records.some((r) => r.memoryId === "b1"));
  assert.doesNotThrow(() => renderPersonSheetText(sheet));
});

test("Codex on PR #32: a shorter person's name inside the selected name is still another person when it stands alone", () => {
  const w = [...world(), mem("o5", "2026-09-06", "みなとこさんとみなとさんの話。", {
    keywords: ["みなとこさん", "みなとさん"],
    personMentions: [mention("みなとこさん", "みなとこさんと話した", "2026-09-06T10:00:00.000Z"), mention("みなとさん", "みなとさんとも話した", "2026-09-06T10:00:00.000Z")],
    evidenceQuotes: ["みなとさんとは未来がないと思う", "みなとこさんとはまた会いたいと思う"],
  })];
  const s = buildPersonSheet(w, "みなとこ");
  const o5 = s.records.find((r) => r.memoryId === "o5")!;
  assert.equal(o5.evidence.find((q) => q.text.startsWith("みなとさんとは"))!.aboutOther, true);
  assert.equal(o5.evidence.find((q) => q.text.startsWith("みなとこさんとは"))!.aboutOther, false);
  assert.ok(!s.last.ownView || !s.last.ownView.text.text.startsWith("みなとさんとは"));
});
