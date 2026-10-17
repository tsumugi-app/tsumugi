/**
 * Restore point (stage 2a): everything needed to put ONE repaired item back EXACTLY as it was, captured BEFORE the repair starts.
 *
 * What a repair + Vault sync + restore can change (this is the scope, defined once in `computeRestoreScope`):
 *  IndexedDB
 *   - the Memory records involved (the restored Memory, link counterparts, the new Memory) and the updating Conversation;
 *   - the Outbox entries of those records (a Memory may be a Reflection, so both `memory:` and `reflection:` ids are listed);
 *   - the sync ledger (`vaultSyncState`) entries of those records;
 *   - the repair's own `settings` keys (ledger, backup, rollback ledger, rollback backup).
 *  Vault
 *   - index.json, history-meta.json;
 *   - the day-file of every Memory, the History month file and the Registry shard of every Memory / Conversation involved;
 *   - the Markdown file of every involved Conversation that already exists (paths come from index.json).
 * Everything else must be unchanged: the restore point also records a hash of every other IndexedDB record / ledger / Outbox entry and a
 * hash of every other file in Tsumugi's own Vault areas, so a later restore can prove that nothing else moved.
 *
 * The restore point contains record and file TEXT (it is a backup). It is built in memory, serialized to ONE string for the caller to save
 * locally, and never logged, never sent anywhere (this module has no network code and no console output). Errors carry fixed codes only.
 */
import type { Conversation, MemoryObject } from "../types";
import type { VaultOutboxEntry } from "../vaultOutbox";
import { dayFileNameFor, dayFileRegistryKey, vaultRegistryBucketOf } from "../vault";
import { repairBackupKey, repairLedgerKey, repairRollbackBackupKey, repairRollbackLedgerKey } from "../memoryContaminationRepair";
import type { MaintenanceRestoreTransaction } from "../db";
import { hashRecord, sha256Hex, stableStringify } from "./hash";
import { TSUMUGI_AREAS, snapshotTree } from "./vaultGuard";
import { readTextOrNull } from "./restoreGuard";

export const RESTORE_POINT_FORMAT = "tsumugi-restore-point";

// ------------------------------------------------------------------------------------------------ environment (injectable)
export interface RestoreIdbAccess {
  getMemory(id: string): Promise<MemoryObject | null>;
  getConversation(id: string): Promise<Conversation | null>;
  getOutbox(id: string): Promise<VaultOutboxEntry | null>;
  getSyncLedger(key: string): Promise<string | null>;
  getSettings(keys: string[]): Promise<Record<string, string | null>>;
  /** hash of EVERY conversation / Memory / sync-ledger value / Outbox entry, plus the given settings keys (`settings:<key>`) */
  hashes(settingsKeys: string[]): Promise<Record<string, string>>;
  /** one atomic transaction; every entry carries the exact value expected to be there now */
  commit(t: MaintenanceRestoreTransaction): Promise<void>;
}
export interface RestoreEnv { idb: RestoreIdbAccess; root: FileSystemDirectoryHandle }

// ------------------------------------------------------------------------------------------------ scope
export interface RestoreScope {
  memoryIds: string[];
  conversationIds: string[];
  outboxIds: string[];
  ledgerKeys: string[];
  settingsKeys: string[];
  vaultPaths: string[];
}
export interface ScopeInput {
  /** the Memory the repair is about (its repair settings keys are in scope) */
  repairMemoryId: string;
  /** every Memory the repair / sync can write: BEFORE and AFTER images, link counterparts, the new Memory */
  memories: { id: string; date: string }[];
  /** every Conversation the repair / sync can write */
  conversations: { id: string; startedAt: string }[];
  /** Markdown paths of those Conversations that already exist in the Vault (from index.json) */
  conversationFilePaths: string[];
}
const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();
const shardPath = (key: string) => `.tsumugi/registry/${vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`;

export function computeRestoreScope(input: ScopeInput): RestoreScope {
  const memoryIds = uniqSorted(input.memories.map((m) => m.id));
  const conversationIds = uniqSorted(input.conversations.map((c) => c.id));
  const paths = new Set<string>([".tsumugi/index.json", ".tsumugi/history-meta.json", ...input.conversationFilePaths]);
  for (const m of input.memories) {
    paths.add(`Memories/${dayFileNameFor(m.date)}`);
    paths.add(`.tsumugi/history/${m.date.slice(0, 7)}.json`);
    paths.add(shardPath(dayFileRegistryKey(m.date)));
  }
  for (const c of input.conversations) {
    paths.add(`.tsumugi/history/${c.startedAt.slice(0, 7)}.json`);
    paths.add(shardPath(c.id));
  }
  return {
    memoryIds, conversationIds,
    outboxIds: uniqSorted([...memoryIds.flatMap((id) => [`memory:${id}`, `reflection:${id}`]), ...conversationIds.map((id) => `conversation:${id}`)]),
    ledgerKeys: uniqSorted([...memoryIds.map((id) => `memory:${id}`), ...conversationIds.map((id) => `conversation:${id}`)]),
    settingsKeys: uniqSorted([repairLedgerKey, repairBackupKey, repairRollbackLedgerKey, repairRollbackBackupKey].map((f) => f(input.repairMemoryId))),
    vaultPaths: uniqSorted([...paths]),
  };
}
/** Vault paths of Conversations that already have a Markdown file (index.json maps id -> path). Unknown / unreadable index => no paths. */
export async function readIndexedConversationPaths(root: FileSystemDirectoryHandle, conversationIds: string[]): Promise<string[]> {
  let raw: string | null;
  try { raw = await readTextOrNull(root, ".tsumugi/index.json"); } catch { return []; }
  if (!raw) return [];
  try {
    const index = JSON.parse(raw) as Record<string, unknown>;
    return conversationIds.map((id) => index[id]).filter((p): p is string => typeof p === "string");
  } catch { return []; }
}

// ------------------------------------------------------------------------------------------------ the restore point
export interface RestorePoint {
  format: typeof RESTORE_POINT_FORMAT;
  schema: 1;
  createdAt: string;
  vaultId: string | null;
  scope: RestoreScope;
  idb: {
    memories: Record<string, MemoryObject | null>;
    conversations: Record<string, Conversation | null>;
    outbox: Record<string, VaultOutboxEntry | null>;
    ledger: Record<string, string | null>;
    settings: Record<string, string | null>;
    /** hash of every IndexedDB value (see RestoreIdbAccess.hashes) at capture time */
    hashes: Record<string, string>;
  };
  vault: {
    /** every scope path: full text + hash, or null if the file did not exist */
    files: Record<string, { content: string; hash: string } | null>;
    /** content hash of every file in Tsumugi's own areas, and every directory in them */
    areaFiles: Record<string, string>;
    dirs: string[];
    /** digest of path|kind|size|mtime of everything outside Tsumugi's areas (never touched by the operation) */
    otherDigest: string;
  };
  contentHash: string;
}

export class RestorePointError extends Error {
  constructor(public readonly code: string) { super(`restore-point: ${code}`); this.name = "RestorePointError"; }
}

export const inTsumugiArea = (path: string) => TSUMUGI_AREAS.some((a) => path === a || path.startsWith(a + "/"));
const clone = <T>(v: T): T => (v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Hashes the whole Vault folder the same way for capture and for every later comparison. */
export async function summarizeVaultTree(root: FileSystemDirectoryHandle): Promise<{ areaFiles: Record<string, string>; dirs: string[]; otherDigest: string }> {
  const tree = await snapshotTree(root);
  const areaFiles: Record<string, string> = {}; const dirs: string[] = []; const other: string[] = [];
  for (const [p, e] of tree) {
    if (inTsumugiArea(p)) { if (e.kind === "directory") dirs.push(p); else areaFiles[p] = e.hash ?? ""; }
    else other.push(`${p}|${e.kind}|${e.size}|${e.modified}`);
  }
  return { areaFiles, dirs: dirs.sort(), otherDigest: await sha256Hex(other.sort().join("\n")) };
}

export async function readVaultId(root: FileSystemDirectoryHandle): Promise<string | null> {
  try {
    const raw = await readTextOrNull(root, ".tsumugi/vault-identity.json");
    const id = raw ? (JSON.parse(raw) as { vaultId?: unknown }).vaultId : null;
    return typeof id === "string" ? id : null;
  } catch { return null; }
}

const contentHashOf = (rp: Omit<RestorePoint, "contentHash">) => sha256Hex(stableStringify(rp));

/**
 * Captures the restore point (read-only). Any part that can not be read exactly aborts the capture (`RestorePointError`): a restore point
 * with a gap would give a false sense of safety.
 */
export async function captureRestorePoint(scope: RestoreScope, env: RestoreEnv, now: () => string = () => new Date().toISOString()): Promise<RestorePoint> {
  const idb: RestorePoint["idb"] = { memories: {}, conversations: {}, outbox: {}, ledger: {}, settings: {}, hashes: {} };
  try {
    for (const id of scope.memoryIds) idb.memories[id] = clone(await env.idb.getMemory(id));
    for (const id of scope.conversationIds) idb.conversations[id] = clone(await env.idb.getConversation(id));
    for (const id of scope.outboxIds) idb.outbox[id] = clone(await env.idb.getOutbox(id));
    for (const key of scope.ledgerKeys) idb.ledger[key] = await env.idb.getSyncLedger(key);
    idb.settings = await env.idb.getSettings(scope.settingsKeys);
    idb.hashes = await env.idb.hashes(scope.settingsKeys);
  } catch { throw new RestorePointError("indexeddb-unreadable"); }
  const files: RestorePoint["vault"]["files"] = {};
  for (const path of scope.vaultPaths) {
    let text: string | null;
    try { text = await readTextOrNull(env.root, path); } catch { throw new RestorePointError("vault-file-unreadable"); }
    files[path] = text === null ? null : { content: text, hash: await sha256Hex(text) };
  }
  let tree;
  try { tree = await summarizeVaultTree(env.root); } catch { throw new RestorePointError("vault-tree-unreadable"); }
  const body: Omit<RestorePoint, "contentHash"> = {
    format: RESTORE_POINT_FORMAT, schema: 1, createdAt: now(), vaultId: await readVaultId(env.root), scope, idb,
    vault: { files, areaFiles: tree.areaFiles, dirs: tree.dirs, otherDigest: tree.otherDigest },
  };
  return { ...body, contentHash: await contentHashOf(body) };
}

export const serializeRestorePoint = (rp: RestorePoint): string => JSON.stringify(rp);

// ------------------------------------------------------------------------------------------------ parsing (strict, with integrity check)
export type RestorePointParse = { ok: true; restorePoint: RestorePoint } | { ok: false; error: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const mapOf = (v: unknown, ok: (x: unknown) => boolean) => isObj(v) && Object.values(v).every(ok);
const strOrNull = (x: unknown) => x === null || typeof x === "string";

/** Strict shape check + recomputed content hash + per-file hash. Errors are fixed codes (the input is never echoed). */
export async function parseRestorePoint(text: string): Promise<RestorePointParse> {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, error: "not-json" }; }
  if (!isObj(json) || json.format !== RESTORE_POINT_FORMAT || json.schema !== 1) return { ok: false, error: "wrong-format-or-schema" };
  const { scope, idb, vault } = json as Record<string, unknown>;
  if (typeof json.createdAt !== "string" || !(json.vaultId === null || typeof json.vaultId === "string") || typeof json.contentHash !== "string") return { ok: false, error: "header" };
  if (!isObj(scope) || !["memoryIds", "conversationIds", "outboxIds", "ledgerKeys", "settingsKeys", "vaultPaths"].every((k) => strs(scope[k]))) return { ok: false, error: "scope" };
  if (!isObj(idb) || !mapOf(idb.memories, (x) => x === null || isObj(x)) || !mapOf(idb.conversations, (x) => x === null || isObj(x)) || !mapOf(idb.outbox, (x) => x === null || isObj(x))
    || !mapOf(idb.ledger, strOrNull) || !mapOf(idb.settings, strOrNull) || !mapOf(idb.hashes, (x) => typeof x === "string")) return { ok: false, error: "idb" };
  if (!isObj(vault) || !mapOf(vault.files, (x) => x === null || (isObj(x) && typeof x.content === "string" && typeof x.hash === "string")) || !mapOf(vault.areaFiles, (x) => typeof x === "string")
    || !strs(vault.dirs) || typeof vault.otherDigest !== "string") return { ok: false, error: "vault" };
  const sc = scope as unknown as RestoreScope;
  const covered = (keys: string[], map: unknown) => keys.every((k) => Object.prototype.hasOwnProperty.call(map, k));
  if (!covered(sc.memoryIds, idb.memories) || !covered(sc.conversationIds, idb.conversations) || !covered(sc.outboxIds, idb.outbox) || !covered(sc.ledgerKeys, idb.ledger)
    || !covered(sc.settingsKeys, idb.settings) || !covered(sc.vaultPaths, vault.files)) return { ok: false, error: "scope-not-covered" };
  for (const f of Object.values(vault.files as Record<string, { content: string; hash: string } | null>)) {
    if (f && (await sha256Hex(f.content)) !== f.hash) return { ok: false, error: "file-hash" };
  }
  const { contentHash, ...body } = json as Record<string, unknown> & { contentHash: string };
  if ((await sha256Hex(stableStringify(body))) !== contentHash) return { ok: false, error: "content-hash" };
  return { ok: true, restorePoint: json as unknown as RestorePoint };
}

/** Counts only (no text), for display. */
export function summarizeRestorePoint(rp: RestorePoint) {
  return {
    createdAt: rp.createdAt, contentHash: rp.contentHash,
    records: rp.scope.memoryIds.length + rp.scope.conversationIds.length,
    existingRecords: [...Object.values(rp.idb.memories), ...Object.values(rp.idb.conversations)].filter((x) => x !== null).length,
    outboxEntries: Object.values(rp.idb.outbox).filter((x) => x !== null).length,
    vaultFiles: rp.scope.vaultPaths.length, existingVaultFiles: Object.values(rp.vault.files).filter((x) => x !== null).length,
  };
}

export { hashRecord };
