/**
 * Recovery after a repair that died in the middle (tab or browser killed, power loss): the durable maintenance gate is still in place, the
 * Web Lock is gone, and IndexedDB / the Vault may be anywhere between "untouched" and "repaired and synced".
 *
 *   diagnoseCrash  (read-only)  ->  runCrashRecovery  (typed confirmation, exclusive lock, adopts the existing gate)
 *
 * Rules (each one is covered by tests):
 *  - The gate is released ONLY by a recovery that ends with a fresh strict comparison identical to the saved restore point AND a Vault <-> IndexedDB
 *    consistency check with no finding. Anything else keeps the gate (the lock is given back, the gate stays) and reports a fixed code.
 *  - Two independent proofs of the pre-repair state must agree: the saved restore point (verified by its content hash) and the operator's own copy of
 *    the Vault folder (every file in the restore point's scope must be byte-identical there).
 *  - What the interrupted session may have changed is recognised, not guessed. IndexedDB records: only records carrying the repair stamp of ONE
 *    commit time (the commit stamps all of them with the same `updatedAt`); Outbox entries / sync ledger: only versions of that time; the repair's
 *    own settings keys. Vault files: only enumerated scope files (the session can write nothing else). A record that does not fit, any change outside
 *    the scope (strict collateral check of the restore engine, unchanged), a different Vault, or an unreadable part STOPS before any write.
 *  - Writes use the existing strict engine: Vault first through the guard (enumerated paths only), then one IndexedDB transaction that re-checks every
 *    expected current value. Idempotent: running it again re-classifies from the real state.
 * Nothing here logs, sends or stores anything; reports carry fixed codes, counts and id tails.
 */
import type { Conversation, MemoryObject } from "../types";
import { deleteMaintenanceEvidence, readMaintenanceEvidence } from "../db";
import { hashRecord, sha256Hex } from "./hash";
import { readGateState } from "./maintenanceGate";
import { adoptStaleMaintenanceGate, endMaintenanceWindow, isMaintenanceWindowOpen, releaseWindowKeepingGate, runWithMaintenanceWriteAccess } from "./maintenanceWindow";
import { diagnoseVaultForPrecheck } from "./precheckScope";
import { parseRestorePoint, summarizeRestorePoint, type RestoreEnv, type RestorePoint } from "./restorePoint";
import { createDbRestoreIdb, emptyExpectation, executeRestore, planRestore, type RestoreExpectation, type RestorePlan } from "./restoreEngine";
import { readTextOrNull } from "./restoreGuard";

export type CrashDiagnosisStatus = "no-stale-gate" | "restore-point-invalid" | "restore-point-not-for-this-gate" | "vault-copy-missing" | "vault-copy-differs" | "intact" | "restorable" | "stopped";
export interface CrashDiagnosis {
  status: CrashDiagnosisStatus;
  /** fixed code(s) only */
  reason: string;
  gate?: { operationId: string; openedAt: string };
  restorePoint?: { createdAt: string; contentHash: string; records: number; vaultFiles: number; confirmPhrase: string };
  /** scope paths where the operator's copy differs from the restore point */
  vaultCopyDiffers: string[];
  plan?: { status: RestorePlan["status"]; stopReasons: string[]; recordsToRestore: number; vaultToWrite: number; vaultToDelete: number; collateral: number };
  /** the stamp time recognised as the interrupted repair's commit (null = no repair commit found) */
  commitStamp: string | null;
}
export const confirmPhraseFor = (rp: Pick<RestorePoint, "contentHash">) => `RESTORE ${rp.contentHash.slice(0, 8)}`;

export interface CrashInput {
  /** the text of the SAVED restore point file */
  restorePointText: string;
  root: FileSystemDirectoryHandle;
  /** the operator's own copy of the Vault folder taken before the repair */
  vaultCopyRoot: FileSystemDirectoryHandle | null;
  /** test seam: defaults to the production IndexedDB access */
  env?: RestoreEnv;
}

/**
 * The exact images the interrupted repair COMMIT wrote, taken from the durable backup the commit stored in the same transaction
 * (`afterMemories`, `afterConversations`, `addedMemories`). Provenance is the exact content, not a timestamp: a record that was rewritten after the
 * crash, even keeping the repair's `updatedAt`, does not match and stops the recovery.
 * null = no commit happened (no backup); "unreadable" = a backup that does not parse or has no exact images for the added Memories.
 */
interface CommitImages { at: string; memories: Record<string, MemoryObject>; conversations: Record<string, Conversation>; added: Record<string, MemoryObject> }
async function commitImagesOf(rp: RestorePoint, env: RestoreEnv): Promise<CommitImages | null | "unreadable"> {
  const key = rp.scope.settingsKeys.find((k) => /^memoryRepair:[^:]+:backup:/.test(k));
  if (!key) return null;
  const raw = (await env.idb.getSettings([key]))[key];
  if (raw === null || raw === undefined) return null;
  try {
    const b = JSON.parse(raw) as { at?: string; afterMemories?: MemoryObject[]; afterConversations?: Conversation[]; addedMemories?: MemoryObject[]; absentMemoryIds?: string[] };
    if (typeof b.at !== "string" || !Array.isArray(b.afterMemories) || !Array.isArray(b.afterConversations) || !Array.isArray(b.absentMemoryIds)) return "unreadable";
    // every Memory the commit created must have its exact image recorded (backups written before this field existed can not prove them)
    const added = Object.fromEntries((b.addedMemories ?? []).map((m) => [m.id, m]));
    if (b.absentMemoryIds.some((id) => !added[id])) return "unreadable";
    return { at: b.at, memories: Object.fromEntries(b.afterMemories.map((m) => [m.id, m])), conversations: Object.fromEntries(b.afterConversations.map((c) => [c.id, c])), added };
  } catch { return "unreadable"; }
}

async function buildExpectation(rp: RestorePoint, env: RestoreEnv, images: CommitImages | null | "unreadable", copyProvesPreState: boolean, evidence: Record<string, string[]>): Promise<RestoreExpectation> {
  const exp = emptyExpectation();
  if (images !== null && images !== "unreadable") {
    const accept = async (kind: "memory" | "conversation", id: string, image: { updatedAt: string }) => {
      exp.records[`${kind}:${id}`] = [await hashRecord(image)];
      exp.updatedAts[id] = [image.updatedAt];
    };
    for (const id of rp.scope.memoryIds) { const img = images.memories[id] ?? images.added[id]; if (img) await accept("memory", id, img); }
    for (const id of rp.scope.conversationIds) { const img = images.conversations[id]; if (img) await accept("conversation", id, img); }
  }
  if (copyProvesPreState) {
    // A scope file is explained ONLY if its current content is one the interrupted window recorded durably BEFORE writing it (write-ahead evidence,
    // keyed by this gate). Any other content (an edit by someone else, Obsidian, a sync tool) is not explained and stops the recovery.
    for (const path of rp.scope.vaultPaths) {
      const known = evidence[path] ?? [];
      if (known.length > 0) exp.vaultFiles[path] = [...known];
    }
  }
  return exp;
}

async function copyDiffers(rp: RestorePoint, copyRoot: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for (const [path, file] of Object.entries(rp.vault.files)) {
    let text: string | null;
    try { text = await readTextOrNull(copyRoot, path); } catch { out.push(path); continue; }
    if ((file ? file.content : null) !== text) out.push(path);
  }
  return out;
}

const planSummary = (p: RestorePlan) => ({
  status: p.status, stopReasons: p.stopReasons, collateral: p.collateral.length,
  recordsToRestore: p.work.tx.memories.length + p.work.tx.conversations.length + p.work.tx.outbox.length + p.work.tx.syncLedger.length + p.work.tx.settings.length,
  vaultToWrite: p.work.writes.length, vaultToDelete: p.work.deletes.length,
});

/** Read-only. Safe to run any number of times. The diagnosis carries codes and counts only (never record or file text). */
export async function diagnoseCrash(input: CrashInput): Promise<CrashDiagnosis> { return (await analyze(input)).diagnosis; }

/** the diagnosis plus the parsed restore point (which holds text): internal to this module */
async function analyze(input: CrashInput): Promise<{ diagnosis: CrashDiagnosis; rp?: RestorePoint }> {
  const base = { vaultCopyDiffers: [] as string[], commitStamp: null as string | null };
  const gate = await readGateState();
  if (gate.kind !== "maintenance-open") return { diagnosis: { ...base, status: "no-stale-gate", reason: `gate:${gate.kind}` } };
  const parsed = await parseRestorePoint(input.restorePointText);
  if (!parsed.ok) return { diagnosis: { ...base, status: "restore-point-invalid", reason: parsed.error, gate: { operationId: gate.operationId, openedAt: gate.openedAt } } };
  const rp = parsed.restorePoint;
  const sum = summarizeRestorePoint(rp);
  const head = { gate: { operationId: gate.operationId, openedAt: gate.openedAt }, restorePoint: { createdAt: rp.createdAt, contentHash: rp.contentHash, records: sum.records, vaultFiles: sum.vaultFiles, confirmPhrase: confirmPhraseFor(rp) } };
  if (!rp.gateOperationId || rp.gateOperationId !== gate.operationId) return { rp, diagnosis: { ...base, ...head, status: "restore-point-not-for-this-gate", reason: rp.gateOperationId ? "gate-mismatch" : "restore-point-has-no-gate-binding" } };
  if (!input.vaultCopyRoot) return { rp, diagnosis: { ...base, ...head, status: "vault-copy-missing", reason: "select-the-vault-copy" } };
  const differs = await copyDiffers(rp, input.vaultCopyRoot);
  if (differs.length > 0) return { rp, diagnosis: { ...base, ...head, vaultCopyDiffers: differs, status: "vault-copy-differs", reason: `copy-differs:${differs.length}` } };
  const env: RestoreEnv = input.env ?? { idb: createDbRestoreIdb(), root: input.root };
  const images = await commitImagesOf(rp, env);
  if (images === "unreadable") return { rp, diagnosis: { ...base, ...head, status: "stopped", reason: "repair-backup-unreadable" } };
  const stamp = images ? images.at : null;
  const exp = await buildExpectation(rp, env, images, true, await readMaintenanceEvidence(gate.operationId));
  const plan = await planRestore(rp, exp, env);
  const common = { ...base, ...head, commitStamp: stamp, plan: planSummary(plan) };
  if (plan.status === "nothing-to-restore") return { rp, diagnosis: { ...common, status: "intact", reason: "identical-to-restore-point" } };
  if (plan.status === "stopped") return { rp, diagnosis: { ...common, status: "stopped", reason: plan.stopReasons.slice(0, 6).join(",") } };
  return { rp, diagnosis: { ...common, status: "restorable", reason: "differences-explained-by-the-interrupted-repair" } };
}

export type CrashRecoveryStatus = "recovered" | "refused" | "stopped" | "incomplete";
export interface CrashRecoveryReport {
  status: CrashRecoveryStatus;
  /** fixed codes only */
  reason: string;
  /** true when the durable gate is still in place (always, unless status is "recovered") */
  gateStillInPlace: boolean;
  diagnosis?: CrashDiagnosis;
  restore?: { status: string; failure?: string; vaultWritten: number; vaultDeleted: number };
  consistency?: { mismatched: number; unverified: number };
}

/**
 * Restores the pre-repair state and, ONLY if that is verified, closes the gate. `confirm` must equal `RESTORE <first 8 of the restore point hash>`.
 */
export async function runCrashRecovery(input: CrashInput & { confirm: string }): Promise<CrashRecoveryReport> {
  const keep = (status: CrashRecoveryStatus, reason: string, extra: Partial<CrashRecoveryReport> = {}): CrashRecoveryReport => ({ status, reason, gateStillInPlace: true, ...extra });
  const first = await analyze(input);
  const pre = first.diagnosis, rp0 = first.rp;
  if (!rp0) return keep("refused", pre.reason, { diagnosis: pre });
  if (pre.status !== "intact" && pre.status !== "restorable") return keep("stopped", pre.reason, { diagnosis: pre });
  if (input.confirm !== confirmPhraseFor(rp0)) return keep("refused", "confirmation-phrase", { diagnosis: pre });

  const adopted = await adoptStaleMaintenanceGate();
  if (!adopted.ok) return keep("refused", `window:${adopted.reason}`, { diagnosis: pre });
  const env: RestoreEnv = input.env ?? { idb: createDbRestoreIdb(), root: input.root };
  let report: CrashRecoveryReport;
  try {
    // everything is decided again INSIDE the window (exclusive lock held): the state may have moved since the read-only diagnosis
    const again = await analyze(input);
    const inside = again.diagnosis, rp = again.rp;
    if (!rp || rp.contentHash !== rp0.contentHash || (inside.status !== "intact" && inside.status !== "restorable")) {
      report = keep("stopped", rp ? inside.reason : "restore-point-lost", { diagnosis: inside });
    } else {
      const exp = await buildExpectation(rp, env, await commitImagesOf(rp, env), true, await readMaintenanceEvidence(adopted.operationId));
      const r = await runWithMaintenanceWriteAccess(() => executeRestore(rp, exp, env));
      const restore = { status: r.status, failure: r.failure, vaultWritten: r.vaultWritten.length, vaultDeleted: r.vaultDeleted.length };
      if (r.status !== "restored" && r.status !== "nothing-to-restore") {
        report = keep("incomplete", `restore:${r.status}`, { diagnosis: inside, restore });
      } else {
        // final proof 1: a fresh STRICT comparison (no expectation, no tolerance) equals the restore point
        const strict = await planRestore(rp, emptyExpectation(), env);
        // final proof 2: IndexedDB and the Vault agree for every record that exists in the restored state
        const existing = [
          ...rp.scope.conversationIds.filter((id) => rp.idb.conversations[id] !== null).map((id) => ({ kind: "conversation" as const, id })),
          ...rp.scope.memoryIds.filter((id) => rp.idb.memories[id] !== null).map((id) => ({ kind: "memory" as const, id })),
        ];
        const vaultCheck = await diagnoseVaultForPrecheck(existing, input.root);
        const consistency = { mismatched: vaultCheck.mismatched.length, unverified: vaultCheck.unverified.length };
        if (strict.status !== "nothing-to-restore") report = keep("incomplete", `verification:${strict.status}`, { diagnosis: inside, restore, consistency });
        else if (consistency.mismatched > 0 || consistency.unverified > 0) report = keep("incomplete", "vault-and-indexeddb-disagree", { diagnosis: inside, restore, consistency });
        else report = { status: "recovered", reason: "verified", gateStillInPlace: true, diagnosis: inside, restore, consistency };
      }
    }
  } catch (e) {
    report = keep("incomplete", `exception:${(e as Error)?.name ?? "error"}`);
  }
  if (report.status === "recovered") {
    try { await deleteMaintenanceEvidence(adopted.operationId); } catch { /* housekeeping only */ }
    const end = await endMaintenanceWindow();          // closes the gate: the only place that does
    if (end.ok && end.gateClosed) report.gateStillInPlace = false;
    else report = keep("incomplete", "gate-not-closed", { diagnosis: report.diagnosis, restore: report.restore, consistency: report.consistency });
  } else if (isMaintenanceWindowOpen()) {
    await releaseWindowKeepingGate();                  // gives the lock back; the durable gate stays
  }
  return report;
}
