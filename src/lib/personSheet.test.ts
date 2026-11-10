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
  const { memories, skipped } = normalizeSheetMemories([null, { id: 1 }, { id: "a", summary: "s", date: "2026-01-01" }]);
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
