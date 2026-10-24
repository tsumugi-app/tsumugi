/**
 * Explicit, one-shot runner for the contamination repair, its recovery, and the Backfill. Nothing imports this file
 * from startup, bootstrap, projection, Capture or any UI. It owns no storage code: every read/write goes through
 * `RepairEnv` (production wiring = memoryRepairDbEnv.ts, tests = fakeIdb). `dry-run` never calls `env.commit`.
 *
 * Contamination repair and Backfill are independent: separate specs, separate ledger key prefixes, separate runs.
 * Re-running is safe: a finished item has a ledger entry (skipped), an unfinished item is re-planned from FRESH state
 * and committed atomically, so a crash at any point leaves each item either fully before or fully after.
 * After every commit the runner re-reads the stores and refuses to continue if anything outside the item's write set changed.
 */
import type { MemoryRepairCommitResult, MemoryRepairTransaction } from "./db";
import type { VaultOutboxEntry } from "./vaultOutbox";
import {
  collateralChanges, planRepairItem, planRepairRollback, previewOf, repairBackupKey, repairLedgerKey, repairRollbackLedgerKey, updatingMemoryIdFor, verifyRepairIntegrity,
  type IntegrityProblem, type PlannedItem, type PreflightCheck, type RepairPreview, type RepairSnapshot, type RepairSpecItem, type UpdatingMemorySpec,
} from "./memoryContaminationRepair";
import { planBackfillItem, backfillBackupKey, type BackfillSpecItem, type PlannedBackfill } from "./memoryBackfill";

export interface RepairEnv {
  readSnapshot(): Promise<RepairSnapshot>;
  readSettings(keys: string[]): Promise<Record<string, string | undefined>>;
  readOutbox(ids: string[]): Promise<Record<string, VaultOutboxEntry | undefined>>;
  commit(transaction: MemoryRepairTransaction): Promise<MemoryRepairCommitResult>;
  now(): string;
}
export type RunMode = "dry-run" | "execute";
export interface RunItemReport { key: string; outcome: "would-commit" | "committed" | "already-done" | "ledger-done" | "hold" | "failed"; reasons?: string[]; checks?: PreflightCheck[]; preview?: RepairPreview; error?: string }
export interface RunReport { mode: RunMode; items: RunItemReport[]; commits: number; stoppedOnFailure: boolean }

const ledgerValueOf = (kind: string, key: string, memoryIds: string[]) => JSON.stringify({ kind, key, memoryIds });

async function drive<P extends { status: string; key: string }>(
  env: RepairEnv, mode: RunMode, keys: string[], ledgerKeyOf: (key: string) => string,
  plan: (key: string, snapshot: RepairSnapshot, now: string) => Promise<P>,
  build: (planned: P, now: string) => MemoryRepairTransaction, previewOf2: (p: P) => RepairPreview,
  allowedOf: (planned: P) => { memoryIds: string[]; conversationIds: string[] },
): Promise<RunReport> {
  const items: RunItemReport[] = []; let commits = 0; let stopped = false;
  for (const key of keys) {
    const ledger = (await env.readSettings([ledgerKeyOf(key)]))[ledgerKeyOf(key)];
    if (ledger !== undefined) { items.push({ key, outcome: "ledger-done" }); continue; }
    const now = env.now();
    const snapshot = await env.readSnapshot();
    const planned = await plan(key, snapshot, now);
    if (planned.status === "ALREADY_DONE") { items.push({ key, outcome: "already-done" }); continue; }
    if (planned.status === "HOLD") { const h = planned as unknown as { reasons: string[]; checks?: PreflightCheck[] }; items.push({ key, outcome: "hold", reasons: h.reasons, checks: h.checks }); continue; }
    const preview = previewOf2(planned);
    if (mode === "dry-run") { items.push({ key, outcome: "would-commit", preview }); continue; }
    try {
      const result = await env.commit(build(planned, now));
      if (result === "committed") commits++;
      const collateral = collateralChanges(snapshot, await env.readSnapshot(), allowedOf(planned));
      if (collateral.length > 0) { items.push({ key, outcome: "failed", error: `collateral-change:${collateral.join(",")}`, preview }); stopped = true; break; }
      items.push({ key, outcome: result === "committed" ? "committed" : "already-done", preview });
    } catch (error) {
      items.push({ key, outcome: "failed", error: error instanceof Error ? error.message : String(error) });
      stopped = true; break; // later items are untouched and stay resumable
    }
  }
  return { mode, items, commits, stoppedOnFailure: stopped };
}

export async function runContaminationRepair(env: RepairEnv, mode: RunMode, options: { spec: RepairSpecItem[]; updating: Record<string, UpdatingMemorySpec>; only?: string[] }): Promise<RunReport> {
  const spec = options.spec.filter((i) => !options.only || options.only.includes(i.key));
  const byKey = new Map(spec.map((i) => [i.key, i]));
  return drive<PlannedItem>(env, mode, spec.map((i) => i.key), (key) => repairLedgerKey(byKey.get(key)!.memoryId),
    (key, snapshot, now) => planRepairItem(byKey.get(key)!, snapshot, now, options.updating),
    (p, now) => {
      if (p.status !== "READY") throw new Error("not-ready");
      return {
        ledgerKey: p.ledgerKey, ledgerValue: ledgerValueOf("contamination-v1", p.key, [p.memoryId, p.updatingMemoryId]), backupKey: repairBackupKey(p.memoryId),
        replaceMemories: [{ before: p.before, after: p.restoredAfter }, ...p.counterparts], addMemories: p.newMemory ? [p.newMemory] : [],
        replaceConversations: p.updatingConversation ? [p.updatingConversation] : [], now,
      };
    }, previewOf, (p) => (p.status === "READY" ? p.writeSet : { memoryIds: [], conversationIds: [] }));
}

export async function runBackfill(env: RepairEnv, mode: RunMode, options: { spec: BackfillSpecItem[]; only?: string[] }): Promise<RunReport> {
  const spec = options.spec.filter((i) => !options.only || options.only.includes(i.key));
  const byKey = new Map(spec.map((i) => [i.key, i]));
  return drive<PlannedBackfill>(env, mode, spec.map((i) => i.key), (key) => `memoryBackfill:v1:${byKey.get(key)!.conversationId}`,
    (key, snapshot, now) => planBackfillItem(byKey.get(key)!, snapshot, now),
    (p, now) => {
      if (p.status !== "READY") throw new Error("not-ready");
      return {
        ledgerKey: p.ledgerKey, ledgerValue: ledgerValueOf("backfill-v1", p.key, [p.newMemory.id]), backupKey: backfillBackupKey(p.conversationId),
        replaceMemories: [], addMemories: [p.newMemory], replaceConversations: [p.conversation], requireNoOtherMemoryFor: [p.conversationId], now,
      };
    },
    (p) => ({ key: p.key, status: p.status, newMemory: p.status === "READY" ? { id: p.newMemory.id, conversationId: p.conversationId, summary: p.newMemory.summary, content: p.newMemory.content, keywords: p.newMemory.keywords } : null }),
    (p) => (p.status === "READY" ? { memoryIds: [p.newMemory.id], conversationIds: [p.conversationId] } : { memoryIds: [], conversationIds: [] }));
}

export interface IntegrityReport { checkedItems: string[]; problems: IntegrityProblem[]; projection: Record<string, "pending" | "held" | "done" | "missing" | "stale"> }
/** Read-only post-repair verification: references, links, Outbox entries (and their projection state) of every repaired item. */
export async function verifyContaminationRepair(env: RepairEnv, options: { spec: RepairSpecItem[]; updating: Record<string, UpdatingMemorySpec>; only?: string[] }): Promise<IntegrityReport> {
  const spec = options.spec.filter((i) => !options.only || options.only.includes(i.key));
  const updating = options.updating;
  const ledgers = await env.readSettings(spec.map((i) => repairLedgerKey(i.memoryId)));
  const done = spec.filter((i) => ledgers[repairLedgerKey(i.memoryId)] !== undefined);
  const snapshot = await env.readSnapshot();
  const newIds: Record<string, string> = {};
  for (const i of done) newIds[i.updatingConversationId] = await updatingMemoryIdFor(i.updatingConversationId);
  const ids = [...new Set(done.flatMap((i) => [`memory:${i.memoryId}`, `memory:${newIds[i.updatingConversationId]}`, `conversation:${i.updatingConversationId}`]))];
  const outbox = await env.readOutbox(ids);
  const projection: IntegrityReport["projection"] = {};
  for (const id of ids) {
    const entry = outbox[id]; const [kind, rid] = id.split(":");
    const record = kind === "memory" ? snapshot.memories.find((m) => m.id === rid) : snapshot.conversations.find((c) => c.id === rid);
    projection[id] = !entry ? "missing" : record && entry.recordUpdatedAt !== record.updatedAt ? "stale" : entry.status === "done" ? "done" : entry.status === "held" ? "held" : "pending";
  }
  return { checkedItems: done.map((i) => i.key), problems: verifyRepairIntegrity(snapshot, outbox, done, updating, newIds), projection };
}

/** Recovery for items found faulty AFTER a repair: puts the pre-repair Memory back (never deletes, keeps the new Memory). */
export async function rollbackContaminationRepair(env: RepairEnv, mode: RunMode, options: { only: string[]; spec: RepairSpecItem[] }): Promise<RunReport> {
  const spec = options.spec.filter((i) => options.only.includes(i.key));
  const items: RunItemReport[] = []; let commits = 0; let stopped = false;
  for (const item of spec) {
    const keys = [repairLedgerKey(item.memoryId), repairBackupKey(item.memoryId), repairRollbackLedgerKey(item.memoryId)];
    const settings = await env.readSettings(keys);
    if (settings[keys[0]] === undefined) { items.push({ key: item.key, outcome: "hold", reasons: ["repair-was-never-applied"] }); continue; }
    if (settings[keys[2]] !== undefined) { items.push({ key: item.key, outcome: "ledger-done" }); continue; }
    const now = env.now();
    const snapshot = await env.readSnapshot();
    const plan = planRepairRollback(item, snapshot, settings[keys[1]], now);
    if (plan.status === "HOLD") { items.push({ key: item.key, outcome: "hold", reasons: plan.reasons, checks: plan.checks }); continue; }
    if (mode === "dry-run") { items.push({ key: item.key, outcome: "would-commit", checks: plan.checks }); continue; }
    try {
      const allowed = { memoryIds: plan.replace.map((r) => r.before.id), conversationIds: [] as string[] };
      const result = await env.commit({ ledgerKey: plan.ledgerKey, ledgerValue: ledgerValueOf("rollback-v1", item.key, plan.replace.map((r) => r.before.id)), backupKey: plan.backupKey, replaceMemories: plan.replace, addMemories: [], replaceConversations: [], now });
      if (result === "committed") commits++;
      const collateral = collateralChanges(snapshot, await env.readSnapshot(), allowed);
      if (collateral.length > 0) { items.push({ key: item.key, outcome: "failed", error: `collateral-change:${collateral.join(",")}` }); stopped = true; break; }
      items.push({ key: item.key, outcome: result === "committed" ? "committed" : "already-done" });
    } catch (error) { items.push({ key: item.key, outcome: "failed", error: error instanceof Error ? error.message : String(error) }); stopped = true; break; }
  }
  return { mode, items, commits, stoppedOnFailure: stopped };
}
