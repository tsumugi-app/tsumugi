/* eslint-disable @typescript-eslint/no-require-imports */
/** Temporal Phase 1A：Memory.statedAtの保存・復元（生成はPhase 1B）。Standalone Node tests。 */
import test from "node:test";
import assert from "node:assert/strict";
import type { MemoryObject, Source } from "./types";
const md = require("./markdown") as typeof import("./markdown");
const vault = require("./vault") as typeof import("./vault");
const outbox = require("./vaultOutbox") as typeof import("./vaultOutbox");
const reflection = require("./reflection") as typeof import("./reflection");

const T = "2026-08-25T23:30:00.000Z";
const STATED = "2026-08-26T11:15:00.000Z"; // dateとは別のUTC日
const meta = { id: "meta", source: "ai-capture", sourceType: "conversation", schemaVersion: "1", createdAt: T, updatedAt: T };
const memory = (id: string, extra: Partial<MemoryObject> = {}): MemoryObject =>
  ({ id, date: T, content: "離乳食を始めた", summary: "離乳食を始めた", types: ["event"], conversationId: "c1",
    keywords: ["離乳食"], links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T, updatedAt: T, metadata: { ...meta }, ...extra }) as MemoryObject;

// 変更前（HEAD, statedAt追加前）のmemoryObjectToMarkdownで生成した固定出力（git archive HEADをコンパイルして取得）。
const LEGACY_FIXTURE = "---\nid: m-legacy\ntsumugi: true\ndate: 2026-08-25\ntypes: [event]\nkeywords: [離乳食]\nconversationId: c1\nsummary: 離乳食を始めた\nsource: ai-capture\nsourceType: conversation\nschemaVersion: \"1\"\ncreatedAt: \"2026-08-25T23:30:00.000Z\"\nupdatedAt: \"2026-08-25T23:30:00.000Z\"\n---\n\n# 2026-08-25\n\n## Summary\n離乳食を始めた\n";

test("A: statedAtあり → serialize → parse でstatedAtが完全一致", () => {
  const m = memory("m1", { statedAt: STATED });
  const text = md.memoryObjectToMarkdown(m);
  assert.ok(text.includes(`statedAt: "${STATED}"`));
  assert.equal(md.parseMemoryObjectMarkdown(text)?.statedAt, STATED);
});

test("B: statedAtなし旧Memoryのserialize結果は変更前出力とバイト単位で一致", () => {
  const out = md.memoryObjectToMarkdown(memory("m-legacy"));
  assert.ok(!out.includes("statedAt"));
  assert.equal(out, LEGACY_FIXTURE);
  const parsed = md.parseMemoryObjectMarkdown(LEGACY_FIXTURE)!;
  assert.ok(!("statedAt" in parsed));
  assert.equal(md.memoryObjectToMarkdown(parsed), LEGACY_FIXTURE);
});

test("C: statedAtあり/なし混在のday-fileが往復する", () => {
  const list = [memory("a"), memory("b", { statedAt: STATED }), memory("c")];
  const text = md.serializeMemoryDayFile(list);
  const back = md.parseMemoryDayFile(text);
  assert.deepEqual(back.map((m) => m.id), ["a", "b", "c"]);
  assert.deepEqual(back.map((m) => m.statedAt), [undefined, STATED, undefined]);
  assert.equal(md.serializeMemoryDayFile(back), text);
});

test("D: 不正statedAtはparse成功・statedAtはundefined（serializeも書かない）", () => {
  const base = md.memoryObjectToMarkdown(memory("m-bad"));
  for (const bad of ["not-a-date", "2026-08-26", "2026-13-40T00:00:00.000Z", "2026-08-26T11:15:00+09:00", "", "123"]) {
    const text = base.replace("summary: ", `statedAt: ${bad}\nsummary: `);
    const parsed = md.parseMemoryObjectMarkdown(text);
    assert.ok(parsed, `parse成功: ${bad}`);
    assert.equal(parsed!.statedAt, undefined, `undefined: ${bad}`);
    assert.equal(md.parseMemoryDayFile(text).length, 1);
    assert.ok(!md.memoryObjectToMarkdown(memory("x", { statedAt: bad })).includes("statedAt"));
  }
});

test("E: statedAtのみ異なるMemoryはsemantic equal", () => {
  assert.equal(vault.memoryObjectsSemanticEqual(memory("m"), memory("m", { statedAt: STATED })), true);
  assert.equal(vault.memoryObjectsSemanticEqual(memory("m", { statedAt: "2026-01-01T00:00:00.000Z" }), memory("m", { statedAt: STATED })), true);
});

test("F-K: statedAtがあってもdate/eventTime/ファイル名/registry/outbox pathは不変", () => {
  const plain = memory("m-k", { eventTime: "2026-08-25", eventTimePrecision: "day" });
  const stated = { ...plain, statedAt: STATED };
  const back = md.parseMemoryObjectMarkdown(md.memoryObjectToMarkdown(stated))!;
  assert.equal(back.date.slice(0, 10), "2026-08-25"); // F（statedAtの日=08-26に引きずられない）
  assert.equal(back.eventTime, "2026-08-25"); // G
  assert.equal(back.eventTimePrecision, "day");
  assert.equal(vault.dayFileNameFor(stated.date), vault.dayFileNameFor(plain.date)); // H
  assert.equal(vault.dayFileNameFor(stated.date), "2026-08-25.md");
  assert.equal(vault.fileNameFor(stated.id, stated.date), vault.fileNameFor(plain.id, plain.date));
  assert.equal(vault.dayFileRegistryKey(stated.date.slice(0, 10)), vault.dayFileRegistryKey(plain.date.slice(0, 10))); // I
  assert.equal(vault.vaultRegistryBucketOf(vault.dayFileRegistryKey("2026-08-25")), vault.vaultRegistryBucketOf(vault.dayFileRegistryKey(plain.date.slice(0, 10))));
  assert.equal(outbox.vaultOutboxIdFor("memory", stated.id), outbox.vaultOutboxIdFor("memory", plain.id)); // K
  // J：History bucketはdate.slice(0,10)由来（statedAtを参照しない）
  assert.equal(stated.date.slice(0, 10), plain.date.slice(0, 10));
});

test("L/M: Reflection・Source出力にstatedAtは現れない", () => {
  const conv = { id: "c1", startedAt: T, turns: [] } as never;
  const ref = reflection.createInsightMemoryObject(conv, memory("src", { statedAt: STATED }), "気づき");
  assert.equal(ref.statedAt, undefined);
  assert.ok(!md.memoryObjectToMarkdown(ref).includes("statedAt"));
  const source = { id: "s1", sourceType: "url", title: "t", content: "c", createdAt: T, updatedAt: T } as Source;
  assert.ok(!md.sourceToMarkdown(source).includes("statedAt"));
});


for (const value of [
  "2026-02-28T00:00:00.000Z",
  "2024-02-29T00:00:00.000Z",
  "2026-12-31T23:59:59.999Z",
  "2026-02-28T00:00:00Z",
  "2026-02-28T00:00:00.1Z",
  "2026-02-28T00:00:00.12Z",
]) test(`Valid UTC boundary: serialize/parse preserves ${value}`, () => {
  const raw = md.memoryObjectToMarkdown(memory("valid-boundary", { statedAt: value }));
  assert.ok(raw.includes(`statedAt: "${value}"`));
  assert.equal(md.parseMemoryObjectMarkdown(raw)?.statedAt, value);
});

for (const value of [
  "2026-02-29T00:00:00.000Z",
  "2026-02-30T00:00:00.000Z",
  "2026-04-31T00:00:00.000Z",
  "2026-02-28T24:00:00.000Z",
  "2026-02-28T23:60:00.000Z",
  "2026-02-28T23:59:60.000Z",
]) test(`Invalid UTC boundary: serialize/parse rejects ${value}`, () => {
  const base = md.memoryObjectToMarkdown(memory("invalid-boundary"));
  assert.equal(md.memoryObjectToMarkdown(memory("invalid-boundary", { statedAt: value })), base);
  const raw = base.replace("summary: ", `statedAt: "${value}"\nsummary: `);
  const parsed = md.parseMemoryObjectMarkdown(raw);
  assert.ok(parsed, "Invalid statedAt must not reject the Memory itself");
  assert.equal(parsed.statedAt, undefined);
});
