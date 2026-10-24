/**
 * Repair PRE-CHECK scope (read-only). Everything here is pure except `diagnoseVaultForPrecheck`, which only reads the Vault.
 *
 * Three findings are kept SEPARATE on purpose and only combined by `overallVerdict`:
 *   1. the IndexedDB pre-flight (READY / HOLD / ALREADY_DONE ...), produced by the reviewed planners in memoryRepairPrecheck.ts;
 *   2. the Outbox conflict view: other not-finished Outbox entries that share a day-file / Registry shard / History month with a target;
 *   3. the Vault consistency view: does the Vault currently hold the same state as IndexedDB, for the records that exist today.
 * Nothing here writes. The reviewed spec (private data) is only ever held in memory; no function here sends it anywhere.
 */
import type { Conversation, MemoryObject } from "../types";
import type { PrivateRepairData } from "../privateRepairData";
import type { OutboxLike, PrecheckInput, PrecheckItem, PrecheckReport, PrecheckStatus } from "../memoryRepairPrecheck";
import { buildPrecheckReport } from "../memoryRepairPrecheck";
import { isReflection, planRepairItem } from "../memoryContaminationRepair";
import { dayFileRegistryKey, vaultRegistryBucketOf } from "../vault";
import { MANIFEST_FORMAT, type MaintenanceManifest } from "./manifest";
import { diagnoseTargets, type DiagnosisItem } from "./scopedVaultSync";

/**
 * Which items may be selected is decided by TWO independent layers, and BOTH must agree:
 *   1. the live IndexedDB pre-flight: only READY items are selectable (HOLD / ALREADY_DONE / LEDGER_DONE never are);
 *   2. the operator's private decision list (`memory-repair-decisions.json`, never in the repository): keys listed as `held` or
 *      `excluded` are never selectable, even if their live status is READY.
 * If the decision list is not loaded, is malformed, or names a key the loaded data does not contain, NOTHING is selectable.
 * No item key or id appears in this source.
 */
export const DECISIONS_FORMAT = "tsumugi-repair-decisions";
export interface Decisions { held: string[]; excluded: string[] }
export type DecisionsParse = { ok: true; decisions: Decisions } | { ok: false; error: string };

const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64);

/** Strict shape check; errors are fixed codes (never echo the input). */
export function parseDecisions(raw: string): DecisionsParse {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, error: "not-json" }; }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, error: "not-object" };
  const o = json as Record<string, unknown>;
  if (o.format !== DECISIONS_FORMAT || o.schema !== 1) return { ok: false, error: "wrong-format-or-schema" };
  if (!strArray(o.held) || !strArray(o.excluded)) return { ok: false, error: "lists" };
  if (new Set([...o.held, ...o.excluded]).size !== o.held.length + o.excluded.length) return { ok: false, error: "duplicate-key" };
  return { ok: true, decisions: { held: [...o.held], excluded: [...o.excluded] } };
}

/** A decision list that names a key the loaded data does not have is rejected (a typo must never silently stop blocking). */
export function decisionsError(data: PrivateRepairData, decisions: Decisions | null): string | null {
  if (!decisions) return "decisions-not-loaded";
  const keys = new Set([...data.repair.items.map((i) => i.key), ...data.backfill.map((b) => b.key)]);
  for (const k of [...decisions.held, ...decisions.excluded]) if (!keys.has(k)) return "decision-key-not-in-data";
  return null;
}

export type LiveStatuses = Record<string, PrecheckStatus>;
export interface ListedItem { kind: "repair" | "backfill"; key: string; selectable: boolean; reason: string | null }

export function listItems(data: PrivateRepairData, decisions: Decisions | null, live: LiveStatuses | null): ListedItem[] {
  const gate = decisionsError(data, decisions);
  const one = (kind: ListedItem["kind"], key: string): ListedItem => {
    let reason: string | null = null;
    if (gate) reason = gate;
    else if (decisions!.held.includes(key)) reason = "held by decision";
    else if (decisions!.excluded.includes(key)) reason = "excluded by decision";
    else if (!live) reason = "not scanned yet";
    else if (!Object.prototype.hasOwnProperty.call(live, key)) reason = "no live status";
    else if (live[key] !== "READY") reason = `live status ${live[key]}`;
    return { kind, key, selectable: reason === null, reason };
  };
  return [...data.repair.items.map((i) => one("repair", i.key)), ...data.backfill.map((b) => one("backfill", b.key))];
}

/** At most this many items per pre-check (the sync scope is also small). */
export const MAX_SELECTED = 3;

/** null when the selection is acceptable; otherwise a fixed code (never echoes data). */
export function selectionError(data: PrivateRepairData, decisions: Decisions | null, live: LiveStatuses | null, keys: string[]): string | null {
  if (keys.length === 0) return "nothing-selected";
  if (keys.length > MAX_SELECTED) return "too-many-selected";
  if (new Set(keys).size !== keys.length) return "duplicate-key";
  const known = new Map(listItems(data, decisions, live).map((i) => [i.key, i]));
  for (const k of keys) {
    const it = known.get(k);
    if (!it) return "unknown-key";
    if (!it.selectable) return "not-selectable";
  }
  return null;
}

/** Live statuses for EVERY item (read-only planners; nothing is selected or written). */
export async function scanLiveStatuses(input: PrecheckInput, data: PrivateRepairData, now: string): Promise<LiveStatuses> {
  const report = await buildPrecheckReport(input, data, now);
  return Object.fromEntries(report.items.map((i) => [i.key, i.status]));
}

/** The reviewed data reduced to the selected keys (the planners then only look at those). */
export function subsetData(data: PrivateRepairData, keys: string[]): PrivateRepairData {
  const items = data.repair.items.filter((i) => keys.includes(i.key));
  const needed = new Set(items.map((i) => i.updatingConversationId));
  return {
    ...data,
    repair: { items, updating: Object.fromEntries(Object.entries(data.repair.updating).filter(([id]) => needed.has(id))) },
    backfill: data.backfill.filter((b) => keys.includes(b.key)),
  };
}

// ------------------------------------------------------------------------------------------------ Outbox conflicts
export interface OutboxConflict { id: string; tail: string; status: string; shares: ("day-file" | "registry-shard" | "history-month")[] }
export interface TargetSet { memoryIds: string[]; conversationIds: string[] }

/** The records whose canonical state / Vault files the pre-checked items would touch (restored Memory, new Memory, both conversations). */
export function targetsOf(data: PrivateRepairData, newMemoryIdOf: (item: PrecheckItem) => string | null, items: PrecheckItem[]): TargetSet {
  const memoryIds = new Set<string>(); const conversationIds = new Set<string>();
  for (const spec of data.repair.items) { memoryIds.add(spec.memoryId); conversationIds.add(spec.originalConversationId); conversationIds.add(spec.updatingConversationId); }
  for (const b of data.backfill) conversationIds.add(b.conversationId);
  for (const it of items) { const id = newMemoryIdOf(it); if (id) memoryIds.add(id); }
  return { memoryIds: [...memoryIds], conversationIds: [...conversationIds] };
}

const dayOf = (iso: string) => iso.slice(0, 10);
const monthOf = (iso: string) => iso.slice(0, 7);

/**
 * Other Outbox entries that are not finished ("done") and could write the same files as a target. Entries of the targets themselves are
 * never listed. Pure: the caller passes the snapshot it already read. Only ids (last 6 chars), statuses and the kind of overlap leave here.
 */
export function outboxConflicts(input: { outbox: OutboxLike[]; memories: MemoryObject[]; conversations: Conversation[]; targets: TargetSet }): OutboxConflict[] {
  const tm = new Set(input.targets.memoryIds), tc = new Set(input.targets.conversationIds);
  const memById = new Map(input.memories.map((m) => [m.id, m]));
  const convById = new Map(input.conversations.map((c) => [c.id, c]));
  const targetDays = new Set<string>(), targetMonths = new Set<string>(), targetShards = new Set<number>();
  for (const id of tm) { const m = memById.get(id); if (m) { targetDays.add(dayOf(m.date)); targetMonths.add(monthOf(m.date)); targetShards.add(vaultRegistryBucketOf(dayFileRegistryKey(m.date))); } }
  for (const id of tc) {
    const c = convById.get(id);
    if (c) { targetMonths.add(monthOf(c.startedAt)); targetShards.add(vaultRegistryBucketOf(id)); }
  }
  const out: OutboxConflict[] = [];
  for (const o of input.outbox) {
    if (o.status === "done") continue;
    if ((o.recordType === "memory" || o.recordType === "reflection") && tm.has(o.recordId)) continue;
    if (o.recordType === "conversation" && tc.has(o.recordId)) continue;
    const shares: OutboxConflict["shares"] = [];
    if (o.recordType === "conversation") {
      const c = convById.get(o.recordId);
      if (c && targetMonths.has(monthOf(c.startedAt))) shares.push("history-month");
      if (targetShards.has(vaultRegistryBucketOf(o.recordId))) shares.push("registry-shard");
    } else {
      const m = memById.get(o.recordId);
      if (m) {
        if (targetDays.has(dayOf(m.date))) shares.push("day-file");
        if (targetShards.has(vaultRegistryBucketOf(dayFileRegistryKey(m.date)))) shares.push("registry-shard");
        if (targetMonths.has(monthOf(m.date))) shares.push("history-month");
      }
    }
    out.push({ id: o.id, tail: o.recordId.slice(-6), status: o.status + (o.heldReason ? `(${o.heldReason})` : ""), shares });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ Vault consistency
export interface VaultCheck {
  performed: true;
  /** file-level areas only (markdown / index / registry / history); ledger and Outbox are sync state, shown by the Outbox view */
  items: DiagnosisItem[];
  mismatched: DiagnosisItem[];   // mismatch | missing
  unverified: DiagnosisItem[];   // unreadable | legacy-format (cannot be proven either way)
  checkedRecords: number;
}

const FILE_AREAS: DiagnosisItem["area"][] = ["markdown", "index", "registry", "history"];

/** Pure summary of a diagnosis (kept separate so it is testable without a Vault). */
export function summarizeDiagnosis(diag: DiagnosisItem[], checkedRecords: number): VaultCheck {
  const items = diag.filter((d) => FILE_AREAS.includes(d.area));
  return {
    performed: true, items, checkedRecords,
    mismatched: items.filter((d) => d.status === "mismatch" || d.status === "missing"),
    unverified: items.filter((d) => d.status === "unreadable" || d.status === "legacy-format"),
  };
}

/**
 * Is `diagnoseTargets` reusable BEFORE a repair? It compares the Vault with the CURRENT canonical record, never with a repaired state, and
 * it only needs {kind, id} per record; so for records that exist today it answers "does the Vault hold what IndexedDB holds now?", which is
 * exactly the pre-repair question. Two parts of it are not meaningful before a repair and are not used: a record that does not exist yet
 * (the new Memory) is never passed in, and the ledger / Outbox rows describe sync state (reported by the Outbox view), so they are dropped.
 */
export async function diagnoseVaultForPrecheck(existing: { kind: "conversation" | "memory"; id: string }[], root: FileSystemDirectoryHandle): Promise<VaultCheck> {
  if (existing.length === 0) return summarizeDiagnosis([], 0);
  const placeholder = "0".repeat(64);   // diagnoseTargets never reads these two fields
  const manifest: MaintenanceManifest = {
    format: MANIFEST_FORMAT, schema: 1, scope: "vault-sync", vaultId: "precheck",
    records: existing.map((r) => ({ kind: r.kind, id: r.id, expectedUpdatedAt: "", canonicalHash: placeholder })),
  };
  return summarizeDiagnosis(await diagnoseTargets(manifest, root), existing.length);
}

// ------------------------------------------------------------------------------------------------ analysis + verdict
export interface Analysis {
  report: PrecheckReport;                                   // IndexedDB pre-flight (separate finding 1)
  conflicts: OutboxConflict[];                              // separate finding 2
  existing: { kind: "conversation" | "memory"; id: string }[]; // what the Vault check may look at (records that exist today); includes the link counterparts a repair would rewrite
  pendingOtherTotal: number;
  /** fixed codes: a link counterpart that the repair would rewrite is unsafe to touch (unfinished Outbox entry, protected by a decision, system-generated) */
  blockers: string[];
}

/** Pure: pre-flight + conflicts + the list of existing records, from one already-read snapshot restricted to the selected keys. */
export async function analyzeSelection(input: PrecheckInput, data: PrivateRepairData, keys: string[], now: string, protectedMemoryIds: string[] = []): Promise<Analysis> {
  const sub = subsetData(data, keys);
  const report = await buildPrecheckReport(input, sub, now);
  const targets = targetsOf(sub, (it) => it.facts?.newMemoryId ?? null, report.items);
  const memIds = new Set(input.memories.map((m) => m.id)), convIds = new Set(input.conversations.map((c) => c.id));
  const existing = [
    ...targets.conversationIds.filter((id) => convIds.has(id)).map((id) => ({ kind: "conversation" as const, id })),
    ...targets.memoryIds.filter((id) => memIds.has(id)).map((id) => ({ kind: "memory" as const, id })),
  ];
  // A removed link also rewrites its counterpart (record + Outbox entry + Vault projection). The counterpart is NOT a target of the item, so it needs its own
  // checks, and ITS files (day-file / shard / month, possibly different from the target's) must be part of the Outbox conflict detection too.
  const blockers: string[] = [];
  const snapshot = { memories: input.memories, conversations: input.conversations };
  const known = new Set(existing.map((e) => `${e.kind}:${e.id}`));
  const guarded = new Set(protectedMemoryIds);
  const counterpartIds: string[] = [];
  for (const spec of sub.repair.items) {
    const planned = await planRepairItem(spec, snapshot, now, sub.repair.updating);
    if (planned.status !== "READY") continue;
    for (const c of planned.counterparts) {
      const id = c.before.id, tail = id.slice(-6);
      counterpartIds.push(id);
      if (input.outbox.some((o) => o.status !== "done" && (o.recordType === "memory" || o.recordType === "reflection") && o.recordId === id)) blockers.push(`counterpart-unfinished-outbox:${tail}`);
      if (guarded.has(id)) blockers.push(`counterpart-protected:${tail}`);
      if (isReflection(c.before)) blockers.push(`counterpart-system-generated:${tail}`);
      if (!known.has(`memory:${id}`)) { existing.push({ kind: "memory", id }); known.add(`memory:${id}`); }
    }
  }
  const conflicts = outboxConflicts({ outbox: input.outbox, memories: input.memories, conversations: input.conversations, targets: { memoryIds: [...targets.memoryIds, ...counterpartIds], conversationIds: targets.conversationIds } });
  return { report, conflicts, existing, pendingOtherTotal: conflicts.length, blockers: [...new Set(blockers)] };
}

export type VerdictCode =
  | "HOLD" | "ALREADY_DONE" | "READY_COUNTERPART_BLOCKED" | "READY_VAULT_NOT_CHECKED" | "READY_VAULT_MISMATCH" | "READY_VAULT_UNVERIFIED" | "READY_OUTBOX_CONFLICT" | "READY_ALL_CLEAR";
export interface Verdict { code: VerdictCode; safeToRepair: boolean; label: string; reasons: string[] }

/** Only READY_ALL_CLEAR is "safe to repair". Anything not proven (Vault not checked, unreadable, legacy-format) is NOT safe. */
export function overallVerdict(i: { status: PrecheckStatus; conflicts: OutboxConflict[]; vault: VaultCheck | null; blockers?: string[] }): Verdict {
  if (i.status === "HOLD") return { code: "HOLD", safeToRepair: false, label: "HOLD: do not repair", reasons: ["IndexedDB pre-flight is HOLD"] };
  if (i.status === "ALREADY_DONE" || i.status === "LEDGER_DONE") {
    return { code: "ALREADY_DONE", safeToRepair: false, label: "Already repaired: nothing to do", reasons: [`IndexedDB pre-flight is ${i.status}`] };
  }
  const sharing = i.conflicts.filter((c) => c.shares.length > 0);
  if ((i.blockers ?? []).length > 0) return { code: "READY_COUNTERPART_BLOCKED", safeToRepair: false, label: "READY, but a link counterpart that the repair would rewrite is protected or unfinished: not safe", reasons: i.blockers ?? [] };
  if (!i.vault) return { code: "READY_VAULT_NOT_CHECKED", safeToRepair: false, label: "READY in IndexedDB, but the Vault has not been checked: not proven safe", reasons: ["run the Vault consistency check"] };
  if (i.vault.mismatched.length > 0) {
    return { code: "READY_VAULT_MISMATCH", safeToRepair: false, label: "READY in IndexedDB, but the Vault disagrees: not safe", reasons: i.vault.mismatched.map((d) => `${d.area}:${d.status}`) };
  }
  if (i.vault.unverified.length > 0) {
    return { code: "READY_VAULT_UNVERIFIED", safeToRepair: false, label: "READY in IndexedDB, but some Vault items could not be verified: not proven safe", reasons: i.vault.unverified.map((d) => `${d.area}:${d.status}`) };
  }
  if (sharing.length > 0) {
    return { code: "READY_OUTBOX_CONFLICT", safeToRepair: false, label: "READY, Vault consistent, but other unfinished Outbox entries share files with the targets: not safe", reasons: sharing.map((c) => `${c.tail}:${c.shares.join("+")}`) };
  }
  return { code: "READY_ALL_CLEAR", safeToRepair: true, label: "No blocking finding in the read-only checks (this tool performs no repair)", reasons: [] };
}
