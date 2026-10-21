/**
 * Single-item repair session (stage 2b/2c): ONE contamination-repair item, from the operator's confirmation to a verified end state, inside
 * ONE maintenance window (exclusive Vault-world lock + durable journal gate + window-limited Vault write permission).
 *
 *   window -> pre-check (IndexedDB READY, Vault consistent, no conflicting Outbox, all-clear verdict) -> plan -> backup check
 *   -> restore point captured, SAVED by the caller and READ BACK, round trip no-op (receipt) -> repair commit (single IndexedDB transaction,
 *   existing runner) -> only-enumerated-records-changed check -> real sync dry run -> verified backups -> real sync (executeSyncLocked)
 *   -> receipts of what was actually written -> final verification -> window closed.
 *
 * Any failure after the first write triggers the STRICT restore (restoreEngine) from the restore point, using receipts recorded from what the
 * session itself wrote. If the strict restore can not complete, the window STAYS OPEN (gate and lock kept) and the report says so: nothing
 * else (the normal app) can touch the Vault or the Outbox until the operator resolves it.
 *
 * Nothing here sends data anywhere or logs content; reports carry codes, counts and id tails only. Not reachable from startup, Capture or
 * Connect; the only caller is the maintenance panel.
 */
import type { Conversation, MemoryObject } from "../types";
import {
  appendMaintenanceEvidence, deleteMaintenanceEvidence,
  getAllConversations, getAllMemoryObjects, getDoneVaultOutboxEntries, getHeldVaultOutboxEntries, getPendingVaultOutboxEntries, readMemoryRepairSettings,
} from "../db";
import { isReflection, planRepairItem, repairLedgerKey, repairRollbackLedgerKey } from "../memoryContaminationRepair";
import { createDbRepairEnv } from "../memoryRepairDbEnv";
import { runContaminationRepair, verifyContaminationRepair } from "../memoryRepairRunner";
import type { PrivateRepairData } from "../privateRepairData";
import type { PrecheckInput } from "../memoryRepairPrecheck";
import { hashRecord, sha256Hex } from "./hash";
import { normalizeForActualComparison } from "./invariants";
import { analyzeSelection, diagnoseVaultForPrecheck, overallVerdict, scanLiveStatuses, subsetData } from "./precheckScope";
import { buildManifestDraft, dryRun, exportRecordBackup, executeSyncLocked, verifyRecordBackup, verifyVaultBackup, type ExecuteReport } from "./scopedVaultSync";
import { endMaintenanceWindow, enterMaintenanceWindow, isMaintenanceWindowOpen } from "./maintenanceWindow";
import { captureRestorePoint, computeRestoreScope, readIndexedConversationPaths, serializeRestorePoint, type RestoreEnv, type RestorePoint } from "./restorePoint";
import {
  assertRestorePointReady, createDbRestoreIdb, createReadBackReceipt, emptyExpectation, executeRestore, planRestore, type RestoreExpectation, type RestoreReport,
} from "./restoreEngine";
import { readTextOrNull } from "./restoreGuard";

export type RepairSessionStatus = "completed" | "refused" | "rolled-back" | "rollback-failed" | "needs-review";
export interface RepairSessionInput {
  /** the reviewed repair data (in memory only) */
  data: PrivateRepairData;
  key: string;
  root: FileSystemDirectoryHandle;
  /** must equal `REPAIR <key>` */
  confirm: string;
  /** Memory ids that must never be rewritten (items held / excluded by the operator's decision list); a link counterpart among them refuses the item */
  protectedMemoryIds?: string[];
  /** the operator's own copy of the Vault folder; every file the operation may touch must be byte-identical there */
  vaultBackupRoot: FileSystemDirectoryHandle | null;
  /** saves the serialized restore point where the operator keeps it and returns what a re-read of the SAVED file contains */
  persistRestorePoint: (text: string) => Promise<string>;
  now?: () => string;
  lockTimeoutMs?: number;
  /** test seam: called after each stage; a throw is handled like any other failure at that stage */
  onStage?: (stage: string) => Promise<void> | void;
}
export interface RepairSessionReport {
  status: RepairSessionStatus;
  /** fixed code (+ id tails / paths); never content */
  reason: string;
  stages: string[];
  /** true when the window (lock + gate) is still open and must be resolved by the operator */
  windowOpen: boolean;
  gateClosed: boolean;
  /** true when closing the window was attempted but the durable gate is still in place (normal Vault / Outbox writes stay blocked) */
  gateStuck?: boolean;
  sync?: { ok: boolean; refused?: string; stoppedAt?: string };
  restore?: Pick<RestoreReport, "status" | "failure"> & { stopReasons: string[] };
  problems: string[];
}

const tail = (id: string) => id.slice(-6);

async function readPrecheckInputViaDb(data: PrivateRepairData): Promise<PrecheckInput> {
  const keys = data.repair.items.flatMap((i) => [repairLedgerKey(i.memoryId), repairRollbackLedgerKey(i.memoryId)]);
  return {
    conversations: await getAllConversations(), memories: await getAllMemoryObjects(),
    outbox: [...await getPendingVaultOutboxEntries(), ...await getHeldVaultOutboxEntries(), ...await getDoneVaultOutboxEntries()],
    settings: await readMemoryRepairSettings(keys),
  };
}

/** What the session itself has written so far, recorded from the REAL files / records (never from "whatever is there at restore time"). */
async function recordReceipts(rp: RestorePoint, env: RestoreEnv, sync: ExecuteReport | null, planned: { path: string; after: string }[]): Promise<RestoreExpectation> {
  const exp = emptyExpectation();
  const progress = new Map<string, string>((sync?.fileProgress ?? []).map((p) => [p.path, p.state] as [string, string]));
  const predicted = new Map(planned.map((f) => [f.path, f.after]));
  for (const path of rp.scope.vaultPaths) {
    let cur: string | null;
    try { cur = await readTextOrNull(env.root, path); } catch { continue; }
    const hash = cur === null ? null : await sha256Hex(cur);
    const preHash = rp.vault.files[path]?.hash ?? null;
    if (hash === preHash) continue;
    // a changed file is accepted as "produced by this operation" only if (a) it holds EXACTLY a content the sync's own guarded writer wrote
    // (hash taken at write time; this also covers the intermediate states of a sync that stopped half-way), or (b) the sync reported it as
    // written as planned and the real content equals the prediction apart from the two known volatile fields
    const own = sync?.writtenHashes?.[path] ?? [];
    const p = predicted.get(path);
    if (hash !== null && own.includes(hash)) exp.vaultFiles[path] = [...new Set(own)];
    else if (cur !== null && p !== undefined && progress.get(path) === "written-as-planned" && normalizeForActualComparison(path, cur) === normalizeForActualComparison(path, p)) exp.vaultFiles[path] = [hash];
  }
  for (const id of rp.scope.memoryIds) {
    const cur = await env.idb.getMemory(id);
    if (cur !== null && (await hashRecord(cur)) !== (await hashRecord(rp.idb.memories[id] ?? null))) { exp.records[`memory:${id}`] = [await hashRecord(cur)]; exp.updatedAts[id] = [cur.updatedAt]; }
  }
  for (const id of rp.scope.conversationIds) {
    const cur = await env.idb.getConversation(id);
    if (cur !== null && (await hashRecord(cur)) !== (await hashRecord(rp.idb.conversations[id] ?? null))) { exp.records[`conversation:${id}`] = [await hashRecord(cur)]; exp.updatedAts[id] = [cur.updatedAt]; }
  }
  return exp;
}

export async function runRepairSession(input: RepairSessionInput): Promise<RepairSessionReport> {
  const now = input.now ?? (() => new Date().toISOString());
  const stages: string[] = [];
  const refused = (reason: string, extra: Partial<RepairSessionReport> = {}): RepairSessionReport => ({ status: "refused", reason, stages, windowOpen: false, gateClosed: false, problems: [], ...extra });
  const spec = input.data.repair.items.find((i) => i.key === input.key);
  if (!spec) return refused("unknown-key");
  if (input.confirm !== `REPAIR ${input.key}`) return refused("confirmation-phrase");
  if (!input.vaultBackupRoot) return refused("vault-backup-required");

  const entered = await enterMaintenanceWindow({ purpose: "single-item-repair", timeoutMs: input.lockTimeoutMs, now });
  if (!entered.ok) return refused(`window:${entered.reason}`);
  let report: RepairSessionReport;
  try { report = await inWindow(input, spec, stages, now, entered.operationId); }
  catch (e) { report = { status: "needs-review", reason: `unexpected:${(e as Error)?.name ?? "error"}`, stages, windowOpen: true, gateClosed: false, problems: [] }; }
  // finished cleanly (nothing written, fully restored, or completed and verified): close the gate and release the lock. Otherwise KEEP both.
  if (report.status === "completed" || report.status === "refused" || report.status === "rolled-back") {
    if (isMaintenanceWindowOpen()) {
      const opId = entered.operationId;
      const end = await endMaintenanceWindow();
      report.gateClosed = end.ok && end.gateClosed; report.windowOpen = !end.ok;
      if (report.gateClosed) { try { await deleteMaintenanceEvidence(opId); } catch { /* evidence of a finished window is only housekeeping */ } }
      if (!report.gateClosed) {
        // the lock may be gone but the durable journal still blocks the normal app: never report a clean "completed" in that state
        report.gateStuck = true;
        if (report.status === "completed") { report.status = "needs-review"; report.reason = `gate-not-closed:${"reason" in end ? end.reason : "unknown"}`; }
        else report.problems = [...report.problems, "gate-not-closed"];
      }
    }
  } else report.windowOpen = isMaintenanceWindowOpen();
  return report;
}

async function inWindow(input: RepairSessionInput, spec: PrivateRepairData["repair"]["items"][number], stages: string[], now: () => string, gateOperationId: string): Promise<RepairSessionReport> {
  const done = async (stage: string) => { stages.push(stage); await input.onStage?.(stage); };
  const fail = (status: RepairSessionStatus, reason: string, extra: Partial<RepairSessionReport> = {}): RepairSessionReport => ({ status, reason, stages, windowOpen: true, gateClosed: false, problems: [], ...extra });
  const env: RestoreEnv = { idb: createDbRestoreIdb(), root: input.root };
  await done("window-open");

  // ---- pre-check inside the window (nothing can change underneath: exclusive lock + gate)
  const data = subsetData(input.data, [input.key]);
  // Memories that must never be rewritten, not even as a link counterpart: the operator's held / excluded items AND every other item that is not
  // READY right now (HOLD, already done, unknown): their live state decides, not only the decision file.
  const liveStatuses = await scanLiveStatuses(await readPrecheckInputViaDb(input.data), input.data, now());
  const protectedIds = [...new Set([...(input.protectedMemoryIds ?? []), ...input.data.repair.items.filter((i) => i.key !== input.key && liveStatuses[i.key] !== "READY").map((i) => i.memoryId)])];
  const analysis = await analyzeSelection(await readPrecheckInputViaDb(data), data, [input.key], now(), protectedIds);
  const item = analysis.report.items[0];
  if (!item || item.status !== "READY") return fail("refused", `precheck:${item?.status ?? "none"}`);
  const vaultCheck = await diagnoseVaultForPrecheck(analysis.existing, input.root);
  const verdict = overallVerdict({ status: item.status, conflicts: analysis.conflicts, vault: vaultCheck, blockers: analysis.blockers });
  if (!verdict.safeToRepair) return fail("refused", `verdict:${verdict.code}`);
  await done("prechecked");

  // ---- plan
  const repairEnv = createDbRepairEnv(now);
  const snapshot = await repairEnv.readSnapshot();
  const plan = await planRepairItem(spec, snapshot, now(), data.repair.updating);
  if (plan.status !== "READY") return fail("refused", `plan:${plan.status}`);
  const before: MemoryObject | undefined = snapshot.memories.find((m) => m.id === spec.memoryId);
  if (!before) return fail("refused", "memory-missing");
  // A removed link also changes its counterpart. A system-generated counterpart (Reflection) is projected through a `reflection:` Outbox entry that
  // the scoped sync deliberately does not cover (out of scope), so such an item would commit and then always roll back: refuse BEFORE any write.
  const reflectionCounterparts = plan.counterparts.filter((c) => isReflection(c.before));
  if (reflectionCounterparts.length > 0) return fail("refused", `reflection-counterpart-unsupported:${reflectionCounterparts.map((c) => tail(c.before.id)).join(",")}`);

  // ---- restore point: captured, SAVED by the caller, READ BACK, round trip no-op. No repair write is possible before this succeeds.
  const memories = [before, plan.restoredAfter, ...(plan.newMemory ? [plan.newMemory] : []), ...plan.counterparts.map((c) => c.before)];
  const conversations: Conversation[] = plan.updatingConversation ? [plan.updatingConversation.before] : [];
  const scope = computeRestoreScope({
    repairMemoryId: spec.memoryId, memories, conversations,
    conversationFilePaths: await readIndexedConversationPaths(input.root, conversations.map((c) => c.id)),
  });
  // the operator's Vault copy must be byte-identical for every existing file the operation may touch (checked BEFORE any write)
  const rp = await captureRestorePoint(scope, env, now, gateOperationId);
  for (const [path, file] of Object.entries(rp.vault.files)) {
    if (!file) continue;
    let copy: string | null;
    try { copy = await readTextOrNull(input.vaultBackupRoot!, path); } catch { copy = null; }
    if (copy !== file.content) return fail("refused", `vault-backup-differs:${path}`);
  }
  await done("vault-backup-checked");
  const text = serializeRestorePoint(rp);
  const readBack = await input.persistRestorePoint(text);
  const receiptResult = await createReadBackReceipt(text, readBack, env, now);
  if (!receiptResult.ok) return fail("refused", `restore-point:${receiptResult.reason}`);
  await assertRestorePointReady(receiptResult.receipt, env);
  await done("restore-point-verified");

  // ---- from here on, every failure restores
  let receipts: RestoreExpectation = emptyExpectation();
  let syncSummary: RepairSessionReport["sync"];
  let lastSync: ExecuteReport | null = null;
  let planned: { path: string; after: string }[] = [];
  const rollback = async (reason: string, problems: string[] = []): Promise<RepairSessionReport> => {
    receipts = await recordReceipts(rp, env, lastSync, planned);
    const r = await executeRestore(rp, receipts, env);
    const restore = { status: r.status, failure: r.failure, stopReasons: r.plan.stopReasons };
    const ok = r.status === "restored" || r.status === "nothing-to-restore";
    return fail(ok ? "rolled-back" : "rollback-failed", reason, { restore, sync: syncSummary, problems });
  };
  try {
    const run = await runContaminationRepair(repairEnv, "execute", { spec: [spec], updating: data.repair.updating, only: [spec.key] });
    const outcome = run.items[0]?.outcome;
    if (outcome !== "committed") {
      // a failed commit is atomic: nothing changed. Anything else (hold / already done) was refused before writing.
      const unchanged = await planRestore(rp, emptyExpectation(), env);
      return unchanged.status === "nothing-to-restore" ? fail("refused", `repair:${outcome ?? "none"}`) : await rollback(`repair:${outcome ?? "none"}`);
    }
    await done("repair-committed");
    receipts = await recordReceipts(rp, env, null, []);
    const afterRepair = await planRestore(rp, receipts, env);
    if (afterRepair.status !== "restorable" || afterRepair.collateral.length > 0) return await rollback("repair-touched-more-than-enumerated", afterRepair.stopReasons);

    // ---- sync
    const ids = [
      ...(plan.updatingConversation ? [{ kind: "conversation" as const, id: plan.updatingConversation.before.id }] : []),
      { kind: "memory" as const, id: spec.memoryId }, ...(plan.newMemory ? [{ kind: "memory" as const, id: plan.newMemory.id }] : []),
      ...plan.counterparts.map((c) => ({ kind: "memory" as const, id: c.before.id })),
    ];
    const manifest = await buildManifestDraft(ids);
    const dry = await dryRun(manifest, input.root, now);
    planned = dry.files.map((f) => ({ path: f.path, after: f.after }));
    if (!dry.ok) return await rollback("dry-run-not-clean", dry.violations.map((v) => `${v.code}:${v.path}`));
    const outside = dry.files.filter((f) => !scope.vaultPaths.includes(f.path)).map((f) => f.path);
    if (outside.length > 0) return await rollback("sync-would-touch-files-outside-the-restore-point", outside);
    await done("dry-run-ok");
    const vaultBackup = await verifyVaultBackup(input.vaultBackupRoot!, input.root, dry);
    const recordBackup = await verifyRecordBackup(await exportRecordBackup(dry), dry);
    if (!vaultBackup.ok || !recordBackup.ok) return await rollback("backups-not-verified", [...vaultBackup.problems, ...recordBackup.problems]);
    await done("backups-verified");
    lastSync = await executeSyncLocked({ manifest, root: input.root, report: dry, vaultBackup, recordBackup, confirm: `SYNC ${dry.preflight.targets.length}`, now, evidenceSink: (p, h) => appendMaintenanceEvidence(gateOperationId, p, h) });
    syncSummary = { ok: lastSync.ok, refused: lastSync.refused, stoppedAt: lastSync.stoppedAt };
    if (!lastSync.ok) return await rollback(lastSync.refused ? `sync-refused:${lastSync.refused}` : "sync-failed", lastSync.verification.predictedVsActual);
    await done("synced");

    // ---- final verification: only enumerated records / files changed, each in a state this session itself recorded
    receipts = await recordReceipts(rp, env, lastSync, planned);
    const finalPlan = await planRestore(rp, receipts, env);
    if (finalPlan.status !== "restorable" || finalPlan.collateral.length > 0) return await rollback("final-state-not-fully-identified", finalPlan.stopReasons);
    const integrity = await verifyContaminationRepair(repairEnv, { spec: [spec], updating: data.repair.updating, only: [spec.key] });
    if (integrity.problems.length > 0) return await rollback("integrity-problems", integrity.problems.map((p) => p.code));
    await done("verified");
    return { status: "completed", reason: "verified", stages, windowOpen: false, gateClosed: false, sync: syncSummary, problems: [] };
  } catch (e) {
    return await rollback(`exception:${(e as Error)?.name ?? "error"}:${tail(String((e as Error)?.message ?? ""))}`.slice(0, 120));
  }
}
