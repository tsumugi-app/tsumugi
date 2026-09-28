/**
 * 新保存基盤 Phase 3-1（DB基盤）の回帰テスト。
 *
 * 対象：vaultOutbox / vaultIdentity / migrationJournal の各storeと、
 * `putConversationWithOutbox`等のatomic transaction API（Invariant 1/2）。
 * 実IndexedDBは使わない（`fakeIdb.ts`——同一transaction内のstaged writeが、
 * いずれかのstoreへの書き込み失敗でtransaction全体としてrollbackされることまで
 * 再現する最小限のフェイク）を、Module._loadで`require("idb")`へ差し替えて使う。
 *
 * 実行方法：`npm run test:save-foundation`
 * （`tsc -p tsconfig.save-foundation.json && node --test .test-out/lib/db.foundation.test.js`）。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..");
const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};

const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "idb") return require(path.join(OUT, "lib/fakeIdb.js"));
  return origLoad.call(this, request, parent, isMain);
};

const dbMod = require(path.join(OUT, "lib/db.js")) as typeof import("./db");
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as { __failNextPutOn: (dbName: string, storeName: string) => void };

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type Source = import("./types").Source;

const T = "2026-01-01T00:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };

function conversation(id: string, updatedAt: string = T): Conversation {
  return {
    id, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt,
    turns: [{ role: "user", content: "テスト発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...meta },
  } as Conversation;
}
function memory(id: string, updatedAt: string = T): MemoryObject {
  return {
    id, date: T, content: "内容", summary: "要約", types: ["event"], conversationId: "c1", keywords: [],
    links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T, updatedAt, metadata: { ...meta },
  } as MemoryObject;
}
function source(id: string, updatedAt: string = T): Source {
  return { id, title: "素材", content: "素材本文", createdAt: T, updatedAt, sourceType: "note" } as Source;
}

// ===========================================================================
// Invariant 1 / 2：canonical writeとoutbox upsertの同一transaction atomicity
// ===========================================================================

test("putConversationWithOutbox：canonical write成功時、outbox entryも同時に作られる（必ずVault projection対象になる）", async () => {
  const c = conversation("c-basic-1");
  const entry = await dbMod.putConversationWithOutbox(c);
  assert.equal(entry.recordType, "conversation");
  assert.equal(entry.recordId, "c-basic-1");
  assert.equal(entry.status, "pending");
  const stored = await dbMod.getConversation("c-basic-1");
  assert.ok(stored, "canonical recordがIndexedDBへ保存されている");
  const outboxEntry = await dbMod.getVaultOutboxEntry("conversation:c-basic-1");
  assert.ok(outboxEntry, "outbox entryが同時に作られている");
  assert.equal(outboxEntry!.recordUpdatedAt, c.updatedAt);
});

test("Invariant 1/2：vaultOutbox側のput失敗時、canonical record側も一切反映されない（同一transactionのatomicity）", async () => {
  const id = "c-atomic-fail-outbox";
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox");
  await assert.rejects(dbMod.putConversationWithOutbox(conversation(id)));
  const stored = await dbMod.getConversation(id);
  assert.equal(stored, undefined, "outbox側が失敗した以上、canonical recordも書き込まれていてはいけない");
  const outboxEntry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.equal(outboxEntry, undefined);
});

test("Invariant 1/2：canonical record側のput失敗時、outbox側も一切反映されない（逆方向のatomicity）", async () => {
  const id = "c-atomic-fail-canonical";
  fakeIdbMod.__failNextPutOn("tsumugi", "conversations");
  await assert.rejects(dbMod.putConversationWithOutbox(conversation(id)));
  const stored = await dbMod.getConversation(id);
  assert.equal(stored, undefined);
  const outboxEntry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.equal(outboxEntry, undefined, "canonical側が失敗した以上、outbox entryが先行して残っていてはいけない");
});

test("putConversationWithOutbox：同一updatedAtでの再書き込みは、既存entryの進捗を維持する（buildOutboxEntryForUpdateの結線確認）", async () => {
  const id = "c-same-version";
  const first = await dbMod.putConversationWithOutbox(conversation(id));
  await dbMod.putVaultOutboxEntry({ ...first, steps: { ...first.steps, markdown: "done" }, status: "pending" });
  const second = await dbMod.putConversationWithOutbox(conversation(id)); // 同じupdatedAt
  assert.equal(second.steps.markdown, "done", "同一versionへの再書き込みでは進捗を巻き戻さない");
});

test("putConversationWithOutbox：updatedAtが進めば、既存entryがdoneでも必ずpendingへ戻す（Assistant応答追加後の再projection相当）", async () => {
  const id = "c-updated-version";
  const first = await dbMod.putConversationWithOutbox(conversation(id, "2026-01-01T00:00:00.000Z"));
  await dbMod.putVaultOutboxEntry({
    ...first,
    steps: { markdown: "done", registry: "done", history: "done", index: "done", ledger: "done" },
    status: "done",
  });
  const second = await dbMod.putConversationWithOutbox(conversation(id, "2026-01-01T01:00:00.000Z"));
  assert.equal(second.status, "pending");
  assert.equal(second.steps.markdown, "pending", "『conversation-turn-durable』のようなprojection不要状態は作らない");
});

test("putMemoryObjectWithOutbox：recordTypeにmemory/reflectionを指定でき、それぞれ別のoutbox entryになる", async () => {
  const m = memory("m-dual-1");
  const entryAsMemory = await dbMod.putMemoryObjectWithOutbox(m, "memory");
  assert.equal(entryAsMemory.recordType, "memory");
  const r = memory("r-dual-1");
  const entryAsReflection = await dbMod.putMemoryObjectWithOutbox(r, "reflection");
  assert.equal(entryAsReflection.recordType, "reflection");
});

test("putSourceWithOutbox：canonical writeとoutbox entryが同時に作られる", async () => {
  const s = source("s-basic-1");
  const entry = await dbMod.putSourceWithOutbox(s);
  assert.equal(entry.recordType, "source");
  const stored = await dbMod.getSource("s-basic-1");
  assert.ok(stored);
});

// ===========================================================================
// outbox：pending index
// ===========================================================================

test("getPendingVaultOutboxEntries：status:pendingのentryだけを返す（起動時reconcileが全件走査せずに済むための索引）", async () => {
  const pendingId = "c-pending-query-1";
  await dbMod.putConversationWithOutbox(conversation(pendingId));
  const doneId = "c-pending-query-2";
  const doneEntry = await dbMod.putConversationWithOutbox(conversation(doneId));
  await dbMod.putVaultOutboxEntry({ ...doneEntry, status: "done" });

  const pending = await dbMod.getPendingVaultOutboxEntries();
  const ids = pending.map((e) => e.id);
  assert.ok(ids.includes(`conversation:${pendingId}`));
  assert.ok(!ids.includes(`conversation:${doneId}`), "doneになったentryはpending一覧に出ない");
});

test("deleteVaultOutboxEntry：entryを削除できる", async () => {
  const id = "c-delete-1";
  await dbMod.putConversationWithOutbox(conversation(id));
  await dbMod.deleteVaultOutboxEntry(`conversation:${id}`);
  assert.equal(await dbMod.getVaultOutboxEntry(`conversation:${id}`), undefined);
});

// ===========================================================================
// vaultIdentity
// ===========================================================================

test("vaultIdentity：CRUDのround-trip（未ペア状態から開始する）", async () => {
  assert.equal(await dbMod.getVaultIdentityRecord(), undefined, "初期状態はまだ何も保存されていない");
  const record = { id: "current" as const, vaultId: "vault-abc", activeVaultEpoch: 3, registryGeneration: "gen-1", pairedAt: T, updatedAt: T };
  await dbMod.putVaultIdentityRecord(record);
  const stored = await dbMod.getVaultIdentityRecord();
  assert.deepEqual(stored, record);
});

// ===========================================================================
// migrationJournal
// ===========================================================================

test("migrationJournal：CRUDと、status:pendingでの絞り込み", async () => {
  const pendingEntry = { id: "conversation:c1:2", recordType: "conversation", recordId: "c1", fromVersion: "1", toVersion: "2", status: "pending" as const, createdAt: T, updatedAt: T };
  const doneEntry = { id: "conversation:c2:2", recordType: "conversation", recordId: "c2", fromVersion: "1", toVersion: "2", status: "done" as const, createdAt: T, updatedAt: T };
  await dbMod.putMigrationJournalEntry(pendingEntry);
  await dbMod.putMigrationJournalEntry(doneEntry);
  assert.deepEqual(await dbMod.getMigrationJournalEntry("conversation:c1:2"), pendingEntry);
  const pending = await dbMod.getPendingMigrationJournalEntries();
  const ids = pending.map((e) => e.id);
  assert.ok(ids.includes("conversation:c1:2"));
  assert.ok(!ids.includes("conversation:c2:2"));
});

// ===========================================================================
// 既存保存経路への影響が無いこと
// ===========================================================================

test("既存のputConversation（新基盤を経由しない従来の保存関数）は、outbox entryを一切作らない", async () => {
  const id = "c-legacy-path-untouched";
  await dbMod.putConversation(conversation(id));
  const stored = await dbMod.getConversation(id);
  assert.ok(stored, "従来の保存経路は変わらず機能する");
  const outboxEntry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.equal(outboxEntry, undefined, "新基盤（outbox）はまだどの既存経路にも結線されていない");
});

test("既存のputConversationAndMarkSynced（Vault resync applyの既存atomic API）も、新基盤とは無関係に動作する", async () => {
  const id = "c-legacy-sync-untouched";
  await dbMod.putConversationAndMarkSynced(conversation(id), `conversation:${id}`);
  const outboxEntry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.equal(outboxEntry, undefined);
});
