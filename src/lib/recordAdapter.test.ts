/**
 * recordAdapter.tsの回帰テスト（IndexedDB不使用）。
 * 実行方法：`npm run test:save-foundation`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getRecordAdapter,
  listRegisteredRecordTypes,
  registerRecordAdapter,
  __resetRecordAdapterRegistryForTests,
  type RecordAdapter,
} from "./recordAdapter";
import type { Conversation, MemoryObject, Source } from "./types";

const T = "2026-01-01T00:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };

function conversation(): Conversation {
  return {
    id: "c1", persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: [{ role: "user", content: "テスト発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...meta },
  } as Conversation;
}
function memory(): MemoryObject {
  return {
    id: "m1", date: T, content: "内容", summary: "要約", types: ["event"], conversationId: "c1", keywords: [],
    links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T, updatedAt: T, metadata: { ...meta },
  } as MemoryObject;
}
function source(): Source {
  return { id: "s1", title: "素材", content: "素材本文", createdAt: T, updatedAt: T, sourceType: "note" } as Source;
}

test("組み込みadapter（conversation/reflection/source/memory）が登録済み", () => {
  const types = listRegisteredRecordTypes();
  for (const t of ["conversation", "reflection", "source", "memory"]) assert.ok(types.includes(t), `${t} should be registered`);
});

test("conversation adapter：toMarkdown/parseMarkdownが既存のmarkdown.ts実装と一致し、round-tripできる", () => {
  const adapter = getRecordAdapter("conversation") as RecordAdapter<Conversation>;
  const c = conversation();
  const text = adapter.toMarkdown!(c);
  const parsed = adapter.parseMarkdown!(text);
  assert.ok(parsed);
  assert.equal(parsed!.id, "c1");
  assert.equal(adapter.registryKeyOf!(c), "c1");
});

test("reflection adapter：toMarkdown/parseMarkdownでround-tripできる", () => {
  const adapter = getRecordAdapter("reflection") as RecordAdapter<MemoryObject>;
  const m = memory();
  const text = adapter.toMarkdown!(m);
  const parsed = adapter.parseMarkdown!(text);
  assert.ok(parsed);
  assert.equal(parsed!.id, "m1");
});

test("source adapter：不正なMarkdownはthrowせずnullを返す（parseSourceMarkdown自体はthrowする実装のため、adapter側で吸収する）", () => {
  const adapter = getRecordAdapter("source") as RecordAdapter<Source>;
  const s = source();
  const text = adapter.toMarkdown!(s);
  assert.ok(adapter.parseMarkdown!(text));
  assert.equal(adapter.parseMarkdown!("not a tsumugi markdown at all"), null);
});

test("memory adapter：day-file特有のため1record単位のtoMarkdown/parseMarkdown/registryKeyOfを持たない", () => {
  const adapter = getRecordAdapter("memory") as RecordAdapter<MemoryObject>;
  assert.equal(adapter.toMarkdown, undefined);
  assert.equal(adapter.parseMarkdown, undefined);
  assert.equal(adapter.registryKeyOf, undefined);
  assert.equal(adapter.schemaVersion, "1");
});

test("未登録のrecordTypeはundefinedを返す（新record type追加時の既定の安全側動作）", () => {
  assert.equal(getRecordAdapter("person"), undefined);
});

test("registerRecordAdapter：新しいrecord typeを、保存エンジン本体を変更せずに追加できる", () => {
  registerRecordAdapter({
    recordType: "person",
    schemaVersion: "1",
    migrate: (raw) => raw,
  });
  assert.ok(getRecordAdapter("person"));
  __resetRecordAdapterRegistryForTests(); // 他のテストへ影響しないよう、組み込みadapterへ戻す
  assert.equal(getRecordAdapter("person"), undefined);
  assert.ok(getRecordAdapter("conversation"), "組み込みadapterは復元されている");
});
