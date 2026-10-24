/**
 * Durable maintenance gate. It reuses the app's EXISTING Recovery-journal write gate: while an `in-progress` journal exists for the current
 * Vault world, the normal app does not write to the Vault and does not reconcile the Outbox (startup flush returns early, the Save Foundation
 * Bootstrap throws before it reads anything, Connect and the legacy writers refuse, cleanup refuses). The journal lives in IndexedDB, so it
 * survives a closed tab or a browser crash, and every tab reads it afresh before acting. A journal that carries `narrowMemoryRepair` is
 * never resumed by the generic Recovery Apply ("use-explicit-memory-repair"), so the normal Recovery screens can not close or continue it.
 *
 * Nothing here writes to the Vault, to canonical records, to the Outbox or to the sync ledger: the ONLY thing it stores is the journal.
 * The journal holds no conversation / Memory text and no record ids (only a purpose label and times).
 */
import { getActiveVaultEpoch, getCommittedVaultEpoch, getRegistryGenerationEpoch, getVaultWorldJournalVersion } from "../db";
import { getVaultBackend } from "../vault";
import {
  RECOVERY_JOURNAL_VERSION, dbRecoveryJournalStore, readRecoveryJournal, saveRecoveryJournal,
  type RecoveryJournal, type RecoveryJournalStore, type RecoveryJournalWorld,
} from "../vaultRecoveryJournal";

export const MAINTENANCE_GATE_KIND = "maintenance-window";
export interface MaintenanceGatePayload { kind: typeof MAINTENANCE_GATE_KIND; version: 1; purpose: string; openedAt: string }

export interface GateDeps {
  store?: RecoveryJournalStore;
  readWorld?: () => Promise<RecoveryJournalWorld>;
  now?: () => string;
  newId?: () => string;
}

/** Same fields the Recovery code records (vaultRecoveryApply.readProductionWorld). */
export async function readProductionWorld(): Promise<RecoveryJournalWorld> {
  const committed = await getCommittedVaultEpoch();
  const version = await getVaultWorldJournalVersion();
  return {
    activeVaultEpoch: await getActiveVaultEpoch(),
    committedVaultEpoch: committed.status === "valid" ? committed.epoch : null,
    registryGenerationEpoch: await getRegistryGenerationEpoch(),
    journalVersion: version.status === "current" ? "current" : version.status === "missing" ? "missing" : `unexpected:${version.raw}`,
    backend: getVaultBackend(),
  };
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
export function isMaintenanceJournal(journal: RecoveryJournal): boolean {
  const p = journal.narrowMemoryRepair;
  return isObject(p) && p.kind === MAINTENANCE_GATE_KIND;
}
const defaultId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export type GateOpenResult =
  | { ok: true; operationId: string }
  | { ok: false; reason: "journal-unreadable" | "other-journal-in-progress" | "maintenance-gate-already-open" | "world-unreadable" | "journal-not-saved" };

/**
 * Opens the gate: refuses unless there is no journal or the previous one is finished (completed / abandoned). The journal is saved AND read
 * back before this returns ok. Call it while holding the exclusive Vault-world lock.
 */
export async function openMaintenanceGate(purpose: string, deps: GateDeps = {}): Promise<GateOpenResult> {
  const store = deps.store ?? dbRecoveryJournalStore;
  let previous;
  try { previous = await readRecoveryJournal(store); } catch { return { ok: false, reason: "journal-unreadable" }; }
  if (previous.kind === "unreadable") return { ok: false, reason: "journal-unreadable" };
  if (previous.kind === "journal" && previous.journal.status === "in-progress") {
    return { ok: false, reason: isMaintenanceJournal(previous.journal) ? "maintenance-gate-already-open" : "other-journal-in-progress" };
  }
  let world: RecoveryJournalWorld;
  try { world = await (deps.readWorld ?? readProductionWorld)(); } catch { return { ok: false, reason: "world-unreadable" }; }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const operationId = (deps.newId ?? defaultId)();
  const payload: MaintenanceGatePayload = { kind: MAINTENANCE_GATE_KIND, version: 1, purpose, openedAt: now };
  const journal: RecoveryJournal = {
    version: RECOVERY_JOURNAL_VERSION, operationId, status: "in-progress", createdAt: now, updatedAt: now, world,
    baselineAtStart: { status: MAINTENANCE_GATE_KIND, value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false,
    narrowMemoryRepair: payload,
  };
  try { await saveRecoveryJournal(store, journal); } catch { return { ok: false, reason: "journal-not-saved" }; }
  return { ok: true, operationId };
}

export type GateCloseResult = { closed: true } | { closed: false; reason: "no-journal" | "journal-unreadable" | "not-a-maintenance-gate" | "not-in-progress" | "different-operation" | "journal-not-saved" };

/**
 * Closes a maintenance gate (status -> completed). With `operationId` only that operation's gate is closed; with `null` ("stale release",
 * only after the owning tab is gone) any maintenance gate is closed. A journal that is not a maintenance gate is NEVER touched.
 */
export async function closeMaintenanceGate(operationId: string | null, deps: GateDeps = {}): Promise<GateCloseResult> {
  const store = deps.store ?? dbRecoveryJournalStore;
  let read;
  try { read = await readRecoveryJournal(store); } catch { return { closed: false, reason: "journal-unreadable" }; }
  if (read.kind === "none") return { closed: false, reason: "no-journal" };
  if (read.kind === "unreadable") return { closed: false, reason: "journal-unreadable" };
  const j = read.journal;
  if (!isMaintenanceJournal(j)) return { closed: false, reason: "not-a-maintenance-gate" };
  if (j.status !== "in-progress") return { closed: false, reason: "not-in-progress" };
  if (operationId !== null && j.operationId !== operationId) return { closed: false, reason: "different-operation" };
  const now = (deps.now ?? (() => new Date().toISOString()))();
  try { await saveRecoveryJournal(store, { ...j, status: "completed", updatedAt: now, result: { recovered: 0, held: 0, failed: 0 } }); } catch { return { closed: false, reason: "journal-not-saved" }; }
  return { closed: true };
}

export type GateState =
  | { kind: "none" } | { kind: "finished" } | { kind: "unreadable" } | { kind: "other-in-progress" }
  | { kind: "maintenance-open"; operationId: string; openedAt: string };

export async function readGateState(store: RecoveryJournalStore = dbRecoveryJournalStore): Promise<GateState> {
  let read;
  try { read = await readRecoveryJournal(store); } catch { return { kind: "unreadable" }; }
  if (read.kind === "none") return { kind: "none" };
  if (read.kind === "unreadable") return { kind: "unreadable" };
  if (read.journal.status !== "in-progress") return { kind: "finished" };
  if (!isMaintenanceJournal(read.journal)) return { kind: "other-in-progress" };
  return { kind: "maintenance-open", operationId: read.journal.operationId, openedAt: String((read.journal.narrowMemoryRepair as MaintenanceGatePayload).openedAt ?? "") };
}
