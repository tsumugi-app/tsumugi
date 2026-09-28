/**
 * vaultOutbox.tsの純粋ロジックの回帰テスト（IndexedDB不使用）。
 * 実行方法：`npm run test:save-foundation`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { vaultOutboxIdFor, buildOutboxEntryForUpdate, PROJECTION_STEP_NAMES, type VaultOutboxEntry } from "./vaultOutbox";

test("vaultOutboxIdFor：recordTypeとrecordIdを結合したidを返す", () => {
  assert.equal(vaultOutboxIdFor("conversation", "c1"), "conversation:c1");
  assert.equal(vaultOutboxIdFor("memory", "m1"), "memory:m1");
});

test("buildOutboxEntryForUpdate：既存entryが無い場合、全stepがpendingの新しいentryを返す（必ずprojection対象にする）", () => {
  const entry = buildOutboxEntryForUpdate(undefined, "conversation", "c1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z");
  assert.equal(entry.id, "conversation:c1");
  assert.equal(entry.recordType, "conversation");
  assert.equal(entry.recordId, "c1");
  assert.equal(entry.recordUpdatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(entry.status, "pending");
  for (const step of PROJECTION_STEP_NAMES) assert.equal(entry.steps[step], "pending", `step ${step} should start pending`);
  assert.equal(entry.attempt.count, 0);
  assert.equal(entry.createdAt, "2026-01-01T00:00:01.000Z");
});

test("buildOutboxEntryForUpdate：同一recordUpdatedAtへの再書き込みは、既存entryの進捗をそのまま維持する", () => {
  const existing: VaultOutboxEntry = {
    id: "conversation:c1",
    recordType: "conversation",
    recordId: "c1",
    recordUpdatedAt: "2026-01-01T00:00:00.000Z",
    steps: { markdown: "done", registry: "done", history: "done", index: "done", ledger: "pending" },
    attempt: { count: 2, lastError: "boom", lastAttemptAt: "2026-01-01T00:00:02.000Z" },
    status: "pending",
    heldReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
  const result = buildOutboxEntryForUpdate(existing, "conversation", "c1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:03.000Z");
  assert.deepEqual(result.steps, existing.steps, "同一versionなら進捗を巻き戻さない");
  assert.equal(result.attempt.count, 2);
  assert.equal(result.updatedAt, "2026-01-01T00:00:03.000Z");
});

test("buildOutboxEntryForUpdate：既存entryがdoneでも、recordUpdatedAtが進めば必ず全stepをpendingへ戻す（『Vault projection不要な更新』という特殊状態を作らない）", () => {
  const existing: VaultOutboxEntry = {
    id: "conversation:c1",
    recordType: "conversation",
    recordId: "c1",
    recordUpdatedAt: "2026-01-01T00:00:00.000Z",
    steps: { markdown: "done", registry: "done", history: "done", index: "done", ledger: "done" },
    attempt: { count: 1, lastError: null, lastAttemptAt: "2026-01-01T00:00:00.500Z" },
    status: "done",
    heldReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
  // Assistant応答追加等でConversationが新しいupdatedAtへ進んだ場合を模する。
  const result = buildOutboxEntryForUpdate(existing, "conversation", "c1", "2026-01-01T00:05:00.000Z", "2026-01-01T00:05:00.100Z");
  assert.equal(result.recordUpdatedAt, "2026-01-01T00:05:00.000Z");
  assert.equal(result.status, "pending", "doneだった記録も、更新されれば必ずpendingへ戻る");
  for (const step of PROJECTION_STEP_NAMES) assert.equal(result.steps[step], "pending", `step ${step} must reset to pending after a canonical update`);
  assert.equal(result.attempt.count, 0, "新versionへの再projectionなので試行回数もリセットする");
  assert.equal(result.createdAt, "2026-01-01T00:00:00.000Z", "createdAtは最初のentry作成時刻を保持する");
});

test("buildOutboxEntryForUpdate：既存entryがheldでも、recordUpdatedAtが進めば必ずpendingへ戻す", () => {
  const existing: VaultOutboxEntry = {
    id: "memory:m1",
    recordType: "memory",
    recordId: "m1",
    recordUpdatedAt: "2026-01-01T00:00:00.000Z",
    steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "pending" },
    attempt: { count: 3, lastError: "conflict", lastAttemptAt: "2026-01-01T00:00:03.000Z" },
    status: "held",
    heldReason: "content-differs",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
  };
  const result = buildOutboxEntryForUpdate(existing, "memory", "m1", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.100Z");
  assert.equal(result.status, "pending");
  assert.equal(result.heldReason, null, "新versionのentryはheldを引き継がない（改めてprojection engineが判定する）");
});
