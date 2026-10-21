/**
 * Strict restore engine (stage 2a). Puts the IndexedDB records and Vault files of ONE item back to the state captured in a restore point.
 * NOT connected to the repair runner, the sync or any screen yet.
 *
 * Safety rules (each is covered by restore.test.ts):
 *  - Nothing is written unless EVERY difference can be identified. For each enumerated record / file the current state must be either the
 *    restore point's state ("pre": nothing to do) or one of the states the operation is known to have produced (the caller's
 *    `RestoreExpectation`: hashes). Anything else ("unidentified": edited by someone, half-written, unreadable, a different Vault) STOPS
 *    the whole restore before any write (CAS). Existing data is never overwritten on a mismatch.
 *  - Anything outside the enumerated scope that differs from the restore point (other records, other Outbox entries, other Vault files,
 *    anything outside Tsumugi's Vault areas) is "collateral" and also stops the restore.
 *  - Vault first, IndexedDB second. The Vault phase writes ONLY enumerated paths (RestoreGuard) and deletes ONLY files the operation
 *    created (restore point: absent; current: a known post-operation hash). After each file the result is read back.
 *  - The IndexedDB phase is one transaction that re-checks every expected current value; a mismatch writes nothing.
 *  - The restore is idempotent and resumable: re-running it re-classifies from the real state (progress is never trusted).
 *  - Success is declared only after a fresh comparison finds the restored state identical to the restore point.
 */
import type { Conversation, MemoryObject } from "../types";
import type { VaultOutboxEntry } from "../vaultOutbox";
import {
  getConversation, getMemoryObject, getVaultOutboxEntry, getVaultSyncState, readMemoryRepairSettings, commitMaintenanceRestore, type MaintenanceRestoreTransaction,
} from "../db";
import { hashRecord, sha256Hex } from "./hash";
import { idbSnapshot } from "./scopedVaultSync";
import { RestoreGuard, readTextOrNull, removeDirectory, removeFile, writeText } from "./restoreGuard";
import {
  captureRestorePoint, inTsumugiArea, parseRestorePoint, readVaultId, summarizeVaultTree,
  type RestoreEnv, type RestoreIdbAccess, type RestorePoint,
} from "./restorePoint";

// ------------------------------------------------------------------------------------------------ production wiring of the IndexedDB access
const copy = <T>(v: T | undefined | null): T | null => (v === undefined || v === null ? null : (JSON.parse(JSON.stringify(v)) as T));
export function createDbRestoreIdb(): RestoreIdbAccess {
  return {
    getMemory: async (id) => copy<MemoryObject>(await getMemoryObject(id)),
    getConversation: async (id) => copy<Conversation>(await getConversation(id)),
    getOutbox: async (id) => copy<VaultOutboxEntry>(await getVaultOutboxEntry(id)),
    getSyncLedger: async (key) => (await getVaultSyncState(key)) ?? null,
    getSettings: async (keys) => Object.fromEntries(Object.entries(await readMemoryRepairSettings(keys)).map(([k, v]) => [k, v ?? null])),
    hashes: async (settingsKeys) => {
      const out: Record<string, string> = Object.fromEntries(await idbSnapshot());
      const settings = await readMemoryRepairSettings(settingsKeys);
      for (const key of settingsKeys) out[`settings:${key}`] = settings[key] === undefined ? "absent" : await sha256Hex(String(settings[key]));
      return out;
    },
    commit: commitMaintenanceRestore,
  };
}

// ------------------------------------------------------------------------------------------------ what the operation is known to have produced
export interface RestoreExpectation {
  /** Vault path -> hashes the file may have after the operation (null = the file may be absent). The restore point's own state is always accepted. */
  vaultFiles: Record<string, (string | null)[]>;
  /** "memory:<id>" | "conversation:<id>" -> hashRecord of every state the operation may have left (the restore point's own state is always accepted) */
  records: Record<string, string[]>;
  /** record id -> every `updatedAt` the operation may have written (accepted for that record's Outbox entries and sync ledger) */
  updatedAts: Record<string, string[]>;
  /** optional, per Outbox entry id: besides the version (`updatedAts`) the entry must be in one of these statuses and must not be held (a held / re-held entry is never explained by the operation) */
  outboxRules?: Record<string, { statuses: string[] }>;
}
export const emptyExpectation = (): RestoreExpectation => ({ vaultFiles: {}, records: {}, updatedAts: {} });

// ------------------------------------------------------------------------------------------------ planning (read-only)
type Verdict = "pre" | "restore" | "unidentified";
export interface RestorePlan {
  status: "nothing-to-restore" | "restorable" | "stopped";
  /** fixed codes + paths / id tails only, never content */
  stopReasons: string[];
  vault: { path: string; verdict: Verdict | "unreadable"; action: "none" | "write" | "delete" }[];
  records: { key: string; verdict: Verdict }[];
  collateral: string[];
  /** internal: what the executor needs (current values read during planning) */
  work: PlanWork;
}
interface PlanWork {
  /** `seen` = the hash of the file when it was classified: the executor re-checks it immediately before touching the file (compare-and-swap) */
  writes: { path: string; content: string; hash: string; seen: string | null }[];
  deletes: { path: string; seen: string | null }[];
  tx: MaintenanceRestoreTransaction;
  createdDirs: string[];
}
const tail = (id: string) => id.slice(-6);
const emptyTx = (): MaintenanceRestoreTransaction => ({ memories: [], conversations: [], outbox: [], syncLedger: [], settings: [] });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function planRestore(rp: RestorePoint, expectation: RestoreExpectation, env: RestoreEnv, options: { allowCollateral?: boolean } = {}): Promise<RestorePlan> {
  const stop: string[] = []; const collateral: string[] = [];
  const work: PlanWork = { writes: [], deletes: [], tx: emptyTx(), createdDirs: [] };
  const vault: RestorePlan["vault"] = []; const records: RestorePlan["records"] = [];
  const pre = rp.idb;

  // 0. same Vault
  if ((await readVaultId(env.root)) !== rp.vaultId) stop.push("different-vault");

  // 1. IndexedDB records
  const classifyRecord = async <T extends { id: string; updatedAt: string }>(kind: "memory" | "conversation", id: string, before: T | null, current: T | null) => {
    const key = `${kind}:${id}`;
    const accepted = new Set(expectation.records[key] ?? []);
    let verdict: Verdict;
    if ((await hashOrNull(current)) === (await hashOrNull(before))) verdict = "pre";
    else if (current !== null && accepted.has(await hashRecord(current))) verdict = "restore";
    else verdict = "unidentified";
    records.push({ key, verdict });
    if (verdict === "unidentified") stop.push(`record-unidentified:${kind}:${tail(id)}`);
    return verdict;
  };
  for (const id of rp.scope.memoryIds) {
    const cur = await env.idb.getMemory(id); const before = (pre.memories[id] ?? null) as MemoryObject | null;
    if ((await classifyRecord("memory", id, before, cur)) === "restore") work.tx.memories.push({ id, expectCurrent: cur, target: before });
  }
  for (const id of rp.scope.conversationIds) {
    const cur = await env.idb.getConversation(id); const before = (pre.conversations[id] ?? null) as Conversation | null;
    if ((await classifyRecord("conversation", id, before, cur)) === "restore") work.tx.conversations.push({ id, expectCurrent: cur, target: before });
  }
  const knownUpdatedAts = (recordId: string) => {
    const s = new Set<string>(expectation.updatedAts[recordId] ?? []);
    const m = pre.memories[recordId] ?? pre.conversations[recordId]; if (m) s.add((m as { updatedAt: string }).updatedAt);
    return s;
  };

  // 2. Outbox entries and sync ledger: derived state of the enumerated records, accepted only for versions the operation may have written
  for (const id of rp.scope.outboxIds) {
    const cur = await env.idb.getOutbox(id); const before = (pre.outbox[id] ?? null) as VaultOutboxEntry | null;
    if (same(cur, before)) { records.push({ key: `outbox:${id}`, verdict: "pre" }); continue; }
    const recordId = id.slice(id.indexOf(":") + 1);
    const rule = expectation.outboxRules?.[id];
    const ruleOk = !rule || cur === null || (rule.statuses.includes(cur.status) && !cur.heldReason);
    if (cur === null || (knownUpdatedAts(recordId).has(cur.recordUpdatedAt) && ruleOk)) { records.push({ key: `outbox:${id}`, verdict: "restore" }); work.tx.outbox.push({ id, expectCurrent: cur, target: before }); }
    else { records.push({ key: `outbox:${id}`, verdict: "unidentified" }); stop.push(`outbox-unidentified:${id.split(":")[0]}:${tail(recordId)}`); }
  }
  for (const key of rp.scope.ledgerKeys) {
    const cur = await env.idb.getSyncLedger(key); const before = pre.ledger[key] ?? null;
    if (cur === before) { records.push({ key: `ledger:${key}`, verdict: "pre" }); continue; }
    const recordId = key.slice(key.indexOf(":") + 1);
    if (cur === null || knownUpdatedAts(recordId).has(cur)) { records.push({ key: `ledger:${key}`, verdict: "restore" }); work.tx.syncLedger.push({ key, expectCurrent: cur, target: before }); }
    else { records.push({ key: `ledger:${key}`, verdict: "unidentified" }); stop.push(`ledger-unidentified:${tail(recordId)}`); }
  }
  const settingsNow = await env.idb.getSettings(rp.scope.settingsKeys);
  for (const key of rp.scope.settingsKeys) {
    const cur = settingsNow[key] ?? null; const before = pre.settings[key] ?? null;
    if (cur === before) { records.push({ key: `settings:${key}`, verdict: "pre" }); continue; }
    // the repair's own keys: written only by the repair; if they existed before, a different value is not explained by the operation
    if (before === null) { records.push({ key: `settings:${key}`, verdict: "restore" }); work.tx.settings.push({ key, expectCurrent: cur, target: null }); }
    else { records.push({ key: `settings:${key}`, verdict: "unidentified" }); stop.push("settings-unidentified"); }
  }

  // 3. Vault files in scope
  const createdDirCandidates = new Set<string>();
  for (const path of rp.scope.vaultPaths) {
    const before = rp.vault.files[path] ?? null;
    let text: string | null;
    try { text = await readTextOrNull(env.root, path); } catch { vault.push({ path, verdict: "unreadable", action: "none" }); stop.push(`vault-unreadable:${path}`); continue; }
    const curHash = text === null ? null : await sha256Hex(text);
    const preHash = before ? before.hash : null;
    if (curHash === preHash) { vault.push({ path, verdict: "pre", action: "none" }); continue; }
    if ((expectation.vaultFiles[path] ?? []).includes(curHash)) {
      if (before) { vault.push({ path, verdict: "restore", action: "write" }); work.writes.push({ path, content: before.content, hash: before.hash, seen: curHash }); }
      else {
        vault.push({ path, verdict: "restore", action: "delete" }); work.deletes.push({ path, seen: curHash });
        const parts = path.split("/"); for (let i = 1; i < parts.length; i++) createdDirCandidates.add(parts.slice(0, i).join("/"));
      }
    } else { vault.push({ path, verdict: "unidentified", action: "none" }); stop.push(`vault-unidentified:${path}`); }
  }

  // 4. collateral: everything NOT enumerated must still be exactly as captured
  const owned = new Set<string>([
    ...rp.scope.memoryIds.flatMap((id) => [`memory:${id}`, `ledger:memory:${id}`]), ...rp.scope.conversationIds.flatMap((id) => [`conversation:${id}`, `ledger:conversation:${id}`]),
    ...rp.scope.outboxIds.map((id) => `outbox:${id}`), ...rp.scope.settingsKeys.map((k) => `settings:${k}`),
  ]);
  const nowHashes = await env.idb.hashes(rp.scope.settingsKeys);
  for (const k of new Set([...Object.keys(rp.idb.hashes), ...Object.keys(nowHashes)])) {
    if (owned.has(k)) continue;
    if (rp.idb.hashes[k] !== nowHashes[k]) collateral.push(`indexeddb:${k.split(":")[0]}:${tail(k)}`);
  }
  let tree;
  try { tree = await summarizeVaultTree(env.root); } catch { tree = null; stop.push("vault-tree-unreadable"); }
  if (tree) {
    const scopePaths = new Set(rp.scope.vaultPaths);
    for (const p of new Set([...Object.keys(rp.vault.areaFiles), ...Object.keys(tree.areaFiles)])) {
      if (scopePaths.has(p)) continue;
      if (rp.vault.areaFiles[p] !== tree.areaFiles[p]) collateral.push(`vault:${p}`);
    }
    const preDirs = new Set(rp.vault.dirs);
    for (const d of rp.vault.dirs) if (!tree.dirs.includes(d)) collateral.push(`vault-dir-missing:${d}`);
    for (const d of tree.dirs) {
      if (preDirs.has(d)) continue;
      if (createdDirCandidates.has(d)) work.createdDirs.push(d); else collateral.push(`vault-dir-extra:${d}`);
    }
    if (tree.otherDigest !== rp.vault.otherDigest) collateral.push("vault-outside-tsumugi-areas");
  }
  if (collateral.length > 0 && !options.allowCollateral) stop.push(`collateral:${collateral.length}`);
  work.createdDirs.sort((a, b) => b.split("/").length - a.split("/").length);

  const needs = work.writes.length + work.deletes.length + work.tx.memories.length + work.tx.conversations.length + work.tx.outbox.length + work.tx.syncLedger.length + work.tx.settings.length + work.createdDirs.length;
  const status: RestorePlan["status"] = stop.length > 0 ? "stopped" : needs > 0 ? "restorable" : "nothing-to-restore";
  return { status, stopReasons: stop, vault, records, collateral, work };
}
const hashOrNull = async (v: unknown) => (v === null || v === undefined ? null : hashRecord(v));

// ------------------------------------------------------------------------------------------------ execution
export type RestoreStatus = "nothing-to-restore" | "restored" | "stopped" | "vault-incomplete" | "indexeddb-failed" | "verification-failed";
export interface RestoreReport { status: RestoreStatus; plan: RestorePlan; vaultWritten: string[]; vaultDeleted: string[]; blocked: string[]; failure?: string; verification?: RestorePlan }

/**
 * Restores. Re-running after any interruption is safe: the plan is rebuilt from the real state. `stopped` means NOTHING was written.
 */
export async function executeRestore(rp: RestorePoint, expectation: RestoreExpectation, env: RestoreEnv, options: { allowCollateral?: boolean } = {}): Promise<RestoreReport> {
  const plan = await planRestore(rp, expectation, env, options);
  const base = { plan, vaultWritten: [] as string[], vaultDeleted: [] as string[], blocked: [] as string[] };
  if (plan.status === "nothing-to-restore") return { ...base, status: "nothing-to-restore" };
  if (plan.status === "stopped") return { ...base, status: "stopped" };

  // Vault phase: enumerated paths only
  const guard = new RestoreGuard(env.root, {
    writable: new Set(plan.work.writes.map((w) => w.path)),
    removableFiles: new Set(plan.work.deletes.map((d) => d.path)),
    removableDirs: new Set(plan.work.createdDirs),
  });
  const root = guard.root();
  try {
    const unchangedSincePlan = async (path: string, seen: string | null) => {
      let now: string | null;
      try { now = await readTextOrNull(env.root, path); } catch { return false; }
      return (now === null ? null : await sha256Hex(now)) === seen;
    };
    for (const w of plan.work.writes) {
      if (!(await unchangedSincePlan(w.path, w.seen))) throw new Error("changed-since-plan");   // someone touched the file after it was classified: never overwrite it
      await writeText(root, w.path, w.content);
      const back = await readTextOrNull(env.root, w.path);
      if (back === null || (await sha256Hex(back)) !== w.hash) throw new Error("read-back-differs");
      base.vaultWritten.push(w.path);
    }
    for (const d of plan.work.deletes) {
      if (!(await unchangedSincePlan(d.path, d.seen))) throw new Error("changed-since-plan");
      await removeFile(root, d.path);
      if ((await readTextOrNull(env.root, d.path)) !== null) throw new Error("still-present");
      base.vaultDeleted.push(d.path);
    }
    for (const dir of plan.work.createdDirs) { try { await removeDirectory(root, dir); } catch { /* not empty / already gone: the final comparison decides */ } }
  } catch (e) {
    return { ...base, status: "vault-incomplete", blocked: guard.blocked, failure: (e as Error)?.message?.slice(0, 80) ?? "error" };
  }

  // IndexedDB phase: one transaction, every expected current value re-checked inside it
  const tx = plan.work.tx;
  if (tx.memories.length + tx.conversations.length + tx.outbox.length + tx.syncLedger.length + tx.settings.length > 0) {
    try { await env.idb.commit(tx); } catch (e) { return { ...base, status: "indexeddb-failed", blocked: guard.blocked, failure: (e as Error)?.message?.slice(0, 80) ?? "error" }; }
  }

  // Success only if a fresh comparison finds everything identical to the restore point
  const verification = await planRestore(rp, emptyExpectation(), env);   // strict: collateral never counts as success, even if the caller overrode the stop
  if (verification.status !== "nothing-to-restore") return { ...base, status: "verification-failed", blocked: guard.blocked, verification };
  return { ...base, status: "restored", blocked: guard.blocked, verification };
}

// ------------------------------------------------------------------------------------------------ the gate in front of a repair
const issued = new WeakSet<object>();
export interface ReadBackReceipt { readonly contentHash: string; readonly restorePoint: RestorePoint; readonly verifiedAt: string }
export class RestorePointNotReadyError extends Error {
  constructor(public readonly code: string) { super(`restore-point-not-ready: ${code}`); this.name = "RestorePointNotReadyError"; }
}

/**
 * A repair may start only with a receipt from here. It is issued only when
 *  1. the text that was SAVED and then READ BACK is identical to the text that was serialized,
 *  2. it parses, the content hash and every file hash match,
 *  3. the round trip passes: restoring it against the CURRENT state is a no-op (so the capture, the hashes and the comparison logic agree
 *     with the real data), with no collateral.
 */
export async function createReadBackReceipt(original: string, readBack: string, env: RestoreEnv, now: () => string = () => new Date().toISOString()): Promise<{ ok: true; receipt: ReadBackReceipt } | { ok: false; reason: string }> {
  if (original !== readBack) return { ok: false, reason: "read-back-differs" };
  const parsed = await parseRestorePoint(readBack);
  if (!parsed.ok) return { ok: false, reason: `parse:${parsed.error}` };
  const plan = await planRestore(parsed.restorePoint, emptyExpectation(), env);
  if (plan.status !== "nothing-to-restore") return { ok: false, reason: `round-trip:${plan.status}` };
  const receipt: ReadBackReceipt = Object.freeze({ contentHash: parsed.restorePoint.contentHash, restorePoint: parsed.restorePoint, verifiedAt: now() });
  issued.add(receipt);
  return { ok: true, receipt };
}

/** Called by the repair start (stage 2b) immediately before the first write: the receipt must be genuine and the world must still equal the restore point. */
export async function assertRestorePointReady(receipt: ReadBackReceipt, env: RestoreEnv): Promise<void> {
  if (!issued.has(receipt)) throw new RestorePointNotReadyError("receipt-not-issued");
  const plan = await planRestore(receipt.restorePoint, emptyExpectation(), env);
  if (plan.status !== "nothing-to-restore") throw new RestorePointNotReadyError(`world-changed:${plan.status}`);
}

export { captureRestorePoint, inTsumugiArea };
