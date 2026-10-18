/**
 * Scoped Vault sync for already-repaired records (S1 preflight, S2 dry run, S3 execute + verify).
 *
 * It re-uses the app's OWN writers and projection (same functions, same order as the startup flush):
 *   writeConversationMarkdown / writeMemoryObjectMarkdown  ->  reconcile*OutboxEntry (single entry)
 * and adds only: a manifest scope, a shadow (in-memory) rehearsal, non-target invariants, a fingerprint that binds the dry run to the
 * real execution, backup verification, and post-write verification. It never imports Capture / Connect / any AI or network code.
 */
import type { Conversation, MemoryObject } from "../types";
import {
  getAllConversations, getAllMemoryObjects, getConversation, getMemoryObject, getVaultIdentityRecord, getVaultOutboxEntry, getVaultSyncState,
  getPendingVaultOutboxEntries, getDoneVaultOutboxEntries, getHeldVaultOutboxEntries,
} from "../db";
import {
  VaultRecordNeedsResyncError, dayFileRegistryKey, dayFileNameFor, hashVaultText, isReflectionSummary, normalizedSourceType, truncateHistoryPreview, vaultRegistryBucketOf,
  writeConversationMarkdown, writeMemoryObjectMarkdown,
} from "../vault";
import { isMemorySame, memoryDayFilePath, reconcileConversationOutboxEntry, reconcileMemoryOutboxEntry, registerProjectionDryRun } from "../vaultProjection";
import { ShadowVault } from "../shadowVault";
import { conversationToMarkdown, memoryObjectToMarkdown, parseMemoryDayFile } from "../markdown";
import { IncompleteVaultWorldError, StaleVaultTabError, runVaultWorldExclusive } from "../vaultWorldLock";
import { withVaultSaveLock } from "../vaultSaveLock";
import { conversationEntryTypeOf } from "../conversationEntryKind";
import { GuardedVault, diffTree, snapshotTree } from "./vaultGuard";
import { isMaintenanceWindowOpen, runWithMaintenanceWriteAccess } from "./maintenanceWindow";
import type { VaultOutboxEntry } from "../vaultOutbox";
import { hashRecord, sha256Hex, stableStringify } from "./hash";
import { checkVaultInvariants, normalizeForActualComparison, type FileChange, type InvariantContext, type Violation } from "./invariants";
import type { MaintenanceManifest, ManifestRecord } from "./manifest";

export interface Check { code: string; pass: boolean; detail: string }
export interface ResolvedTarget { kind: "conversation" | "memory"; id: string; record: Conversation | MemoryObject; outbox: VaultOutboxEntry | undefined; ledger: string | undefined }
export interface Preflight { ok: boolean; checks: Check[]; targets: ResolvedTarget[]; vaultId: string | null }
export interface WriterOutcome { kind: string; id: string; status: "would-write" | "held" | "error"; reason?: string }
export interface ProjectionOutcome { kind: string; id: string; status: string; reason?: string | null }
/** Every path the writers will WRITE (even when the bytes end up identical); `unchanged` marks a rewrite that does not change the content. */
export interface PlannedFile { path: string; before: string | null; after: string; beforeHash: string | null; afterHash: string; unchanged: boolean }
export interface DryRunReport {
  ok: boolean; preflight: Preflight; writers: WriterOutcome[]; projection: ProjectionOutcome[];
  files: PlannedFile[]; violations: Violation[]; warnings: string[]; fingerprint: string; idbDigest: string;
}

const clone = <T,>(v: T): T => structuredClone(v);
const order = (a: ManifestRecord, b: ManifestRecord) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "conversation" ? -1 : 1);
const dayOf = (t: ResolvedTarget) => (t.kind === "conversation" ? (t.record as Conversation).startedAt : (t.record as MemoryObject).date).slice(0, 10);
const ledgerKey = (t: { kind: string; id: string }) => `${t.kind}:${t.id}`;
const outboxId = (t: { kind: string; id: string }) => `${t.kind}:${t.id}`;
const check = (checks: Check[], code: string, pass: boolean, detail = "") => { checks.push({ code, pass, detail: pass ? "" : detail }); return pass; };
/**
 * Inside an open maintenance window (journal gate in place) the legacy writers are refused by the app's own write gate; this runs them
 * with the window-limited permission. Without an open window (every existing caller / test) it is exactly `fn()`.
 */
const scoped = <T,>(fn: () => Promise<T>): Promise<T> => (isMaintenanceWindowOpen() ? runWithMaintenanceWriteAccess(fn) : fn());

async function readVaultText(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  return new ShadowVault(root).readText(path); // read-only access path (create:false)
}

/** S1: everything that must hold before a rehearsal is meaningful. Reads only. */
export async function preflight(manifest: MaintenanceManifest, root: FileSystemDirectoryHandle): Promise<Preflight> {
  const checks: Check[] = [];
  const identity = await getVaultIdentityRecord();
  check(checks, "indexeddb-vault-paired", !!identity && !!identity.vaultId, "this IndexedDB is not paired with a Vault");
  check(checks, "manifest-vault-matches-indexeddb", !!identity && identity.vaultId === manifest.vaultId, "manifest.vaultId differs from the paired Vault");
  let onDisk: string | null = null;
  try { const raw = await readVaultText(root, ".tsumugi/vault-identity.json"); onDisk = raw ? (JSON.parse(raw) as { vaultId?: string }).vaultId ?? null : null; } catch { onDisk = null; }
  check(checks, "vault-folder-identity-matches", !!identity && !!onDisk && onDisk === identity.vaultId, "the selected Vault folder has a different (or unreadable) identity");
  const targets: ResolvedTarget[] = [];
  for (const r of [...manifest.records].sort(order)) {
    const record = r.kind === "conversation" ? await getConversation(r.id) : await getMemoryObject(r.id);
    const tag = `${r.kind}:${r.id.slice(-6)}`;
    if (!check(checks, `record-exists:${tag}`, !!record, "canonical record missing")) continue;
    if (r.kind === "memory" && isReflectionSummary(record as MemoryObject)) { check(checks, `not-a-reflection:${tag}`, false, "Reflection records are out of scope"); continue; }
    check(checks, `updatedAt-as-reviewed:${tag}`, record!.updatedAt === r.expectedUpdatedAt, "updatedAt differs from the manifest");
    check(checks, `canonical-hash-as-reviewed:${tag}`, (await hashRecord(record)) === r.canonicalHash, "record content differs from the manifest hash");
    const outbox = await getVaultOutboxEntry(outboxId(r));
    check(checks, `outbox-entry-exists:${tag}`, !!outbox, "no Outbox entry");
    check(checks, `outbox-entry-current:${tag}`, !!outbox && outbox.recordUpdatedAt === record!.updatedAt, "Outbox entry is for another version");
    check(checks, `outbox-not-done:${tag}`, !outbox || outbox.status !== "done", "already projected (nothing to sync)");
    const ledger = await getVaultSyncState(ledgerKey(r));
    check(checks, `ledger-needs-sync:${tag}`, ledger !== record!.updatedAt, "ledger says synced");
    targets.push({ kind: r.kind, id: r.id, record: record as Conversation | MemoryObject, outbox, ledger });
  }
  return { ok: checks.every((c) => c.pass), checks, targets, vaultId: identity?.vaultId ?? null };
}

/** Digest of every IndexedDB record that can influence or be touched by a sync (any change anywhere invalidates a dry run). */
export async function idbSnapshot(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const c of await getAllConversations()) { out.set(`conversation:${c.id}`, await hashRecord(c)); out.set(`ledger:conversation:${c.id}`, String(await getVaultSyncState(`conversation:${c.id}`))); }
  for (const m of await getAllMemoryObjects()) { out.set(`memory:${m.id}`, await hashRecord(m)); out.set(`ledger:memory:${m.id}`, String(await getVaultSyncState(`memory:${m.id}`))); }
  const entries = [...await getPendingVaultOutboxEntries(), ...await getHeldVaultOutboxEntries(), ...await getDoneVaultOutboxEntries()];
  for (const e of entries) out.set(`outbox:${e.id}`, stableStringify({ s: e.status, u: e.recordUpdatedAt, a: e.attempt, h: e.heldReason, st: e.steps, up: e.updatedAt }));
  return out;
}
async function digestOf(snap: Map<string, string>): Promise<string> { return sha256Hex([...snap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n")); }

function contextOf(targets: ResolvedTarget[]): InvariantContext {
  const days = [...new Set(targets.map(dayOf))];
  const memoryDays = [...new Set(targets.filter((t) => t.kind === "memory").map((t) => (t.record as MemoryObject).date.slice(0, 10)))];
  return {
    targetConversationIds: targets.filter((t) => t.kind === "conversation").map((t) => t.id), targetMemoryIds: targets.filter((t) => t.kind === "memory").map((t) => t.id),
    targetDays: days, registryKeys: [...targets.filter((t) => t.kind === "conversation").map((t) => t.id), ...memoryDays.map((d) => dayFileRegistryKey(d))],
  };
}
function expectedPaths(ctx: InvariantContext, targets: ResolvedTarget[]): { exact: Set<string>; conversationPattern: RegExp } {
  const exact = new Set<string>([".tsumugi/index.json", ".tsumugi/history-meta.json"]);
  for (const d of ctx.targetDays) exact.add(`.tsumugi/history/${d.slice(0, 7)}.json`);
  for (const k of ctx.registryKeys) exact.add(`.tsumugi/registry/${vaultRegistryBucketOf(k).toString(16).padStart(2, "0")}.json`);
  for (const t of targets) if (t.kind === "memory") exact.add(memoryDayFilePath(t.record as MemoryObject));
  return { exact, conversationPattern: /^Conversations\/[^/]+\.md$/ };
}

function aggregate(shadow: ShadowVault): FileChange[] {
  const m = new Map<string, FileChange>();
  for (const w of shadow.writes) { const e = m.get(w.path); if (e) e.after = w.after; else m.set(w.path, { path: w.path, before: w.before, after: w.after }); }
  return [...m.values()];
}

async function fingerprintOf(targets: ResolvedTarget[], files: PlannedFile[], idbDigest: string, vaultId: string | null): Promise<string> {
  return sha256Hex(stableStringify({
    vaultId, idbDigest,
    targets: await Promise.all(targets.map(async (t) => ({ kind: t.kind, id: t.id, updatedAt: t.record.updatedAt, hash: await hashRecord(t.record), outbox: t.outbox ? { s: t.outbox.status, u: t.outbox.recordUpdatedAt, a: t.outbox.attempt.count } : null, ledger: t.ledger ?? null }))),
    files: files.map((f) => ({ path: f.path, b: f.beforeHash, a: f.afterHash })),
  }));
}

/** S2: rehearse the real writers + projection on a shadow copy of Vault and IndexedDB. Writes nothing real. */
export async function dryRun(manifest: MaintenanceManifest, root: FileSystemDirectoryHandle, now: () => string = () => new Date().toISOString()): Promise<DryRunReport> {
  const pf = await preflight(manifest, root);
  const empty: DryRunReport = { ok: false, preflight: pf, writers: [], projection: [], files: [], violations: [], warnings: [], fingerprint: "", idbDigest: "" };
  if (!pf.ok) return empty;
  const snap = await idbSnapshot(); const idbDigest = await digestOf(snap);
  const identity = await getVaultIdentityRecord();
  const shadow = new ShadowVault(root);
  const writers: WriterOutcome[] = []; const warnings: string[] = [];
  for (const t of pf.targets) {
    try {
      if (t.kind === "conversation") await scoped(() => writeConversationMarkdown(shadow.root(), clone(t.record as Conversation), "interactive", undefined, { skipLedger: true }));
      else await scoped(() => writeMemoryObjectMarkdown(shadow.root(), clone(t.record as MemoryObject), "interactive", undefined, { skipLedger: true }));
      writers.push({ kind: t.kind, id: t.id, status: "would-write" });
    } catch (e) {
      writers.push({ kind: t.kind, id: t.id, status: e instanceof VaultRecordNeedsResyncError ? "held" : "error", reason: e instanceof VaultRecordNeedsResyncError ? e.holdReason : (e as Error)?.name ?? "error" });
    }
  }
  const projection: ProjectionOutcome[] = [];
  for (const t of pf.targets) {
    const entry = t.outbox!;
    let outcome: { status: string; reason: string | null } | null = null;
    const un = registerProjectionDryRun(entry, (o) => { outcome = { status: o.status, reason: o.reason ?? null }; });
    try {
      const env = { root: shadow.root(), vaultIdentity: identity ?? null, now };
      const res = t.kind === "conversation" ? await reconcileConversationOutboxEntry(env, entry) : await reconcileMemoryOutboxEntry(env, entry);
      const o = outcome ?? { status: res.status, reason: "reason" in res ? res.reason : null };
      projection.push({ kind: t.kind, id: t.id, status: o.status, reason: o.reason });
    } catch (e) { projection.push({ kind: t.kind, id: t.id, status: "error", reason: (e as Error)?.name ?? "error" }); }
    finally { un(); }
  }
  const touched = aggregate(shadow);
  const changes = touched.filter((c) => c.before !== c.after);
  const ctx = contextOf(pf.targets);
  const violations = checkVaultInvariants(changes, ctx);
  const exp = expectedPaths(ctx, pf.targets);
  for (const c of touched) if (!exp.exact.has(c.path) && !exp.conversationPattern.test(c.path)) violations.push({ path: c.path, code: "path-outside-expected-set", detail: "" });
  const files: PlannedFile[] = [];
  // the "after" hash ignores only the volatile bookkeeping fields the writer stamps itself (registry mtime, history-meta updatedAt)
  for (const c of touched) files.push({ path: c.path, before: c.before, after: c.after, unchanged: c.before === c.after, beforeHash: c.before === null ? null : await sha256Hex(c.before), afterHash: await sha256Hex(normalizeForActualComparison(c.path, c.after)) });
  for (const p of projection) {
    if (p.status === "done") continue;
    if (p.status === "pending" && p.reason === "verify-history-mismatch") { warnings.push(`${p.kind}:${p.id.slice(-6)} History day is in the legacy format: the Vault will be correct but the Outbox entry stays pending`); continue; }
    violations.push({ path: `${p.kind}:${p.id.slice(-6)}`, code: "projection-not-done", detail: `${p.status}${p.reason ? `:${p.reason}` : ""}` });
  }
  for (const w of writers) if (w.status !== "would-write") violations.push({ path: `${w.kind}:${w.id.slice(-6)}`, code: `writer-${w.status}`, detail: w.reason ?? "" });
  return { ok: violations.length === 0, preflight: pf, writers, projection, files, violations, warnings, fingerprint: await fingerprintOf(pf.targets, files, idbDigest, pf.vaultId), idbDigest };
}

// ------------------------------------------------------------------ backup verification (the app can verify what it can read)
export interface BackupVerification { ok: boolean; problems: string[]; forFingerprint: string }

/** The Vault backup folder must be the same Vault and must hold, byte-for-byte, every file this sync is about to modify. */
export async function verifyVaultBackup(backupRoot: FileSystemDirectoryHandle, currentRoot: FileSystemDirectoryHandle, report: DryRunReport): Promise<BackupVerification> {
  const problems: string[] = [];
  let id: string | null = null;
  try { const raw = await readVaultText(backupRoot, ".tsumugi/vault-identity.json"); id = raw ? (JSON.parse(raw) as { vaultId?: string }).vaultId ?? null : null; } catch { id = null; }
  if (!id || id !== report.preflight.vaultId) problems.push("backup-vault-identity-mismatch");
  for (const f of report.files) {
    if (f.before === null) continue; // created files have nothing to back up
    const inBackup = await readVaultText(backupRoot, f.path).catch(() => null);
    if (inBackup === null) problems.push(`backup-missing:${f.path}`);
    else if (inBackup !== f.before) problems.push(`backup-differs:${f.path}`);
    const current = await readVaultText(currentRoot, f.path).catch(() => null);
    if (current !== f.before) problems.push(`current-changed-since-dry-run:${f.path}`);
  }
  return { ok: problems.length === 0, problems, forFingerprint: report.fingerprint };
}

/** Pre-sync export of the target records + their Outbox entries + ledger values (personal data: a local file only, never uploaded). */
export async function exportRecordBackup(report: DryRunReport): Promise<string> {
  return JSON.stringify({
    format: "tsumugi-maintenance-record-backup", schema: 1, fingerprint: report.fingerprint,
    records: await Promise.all(report.preflight.targets.map(async (t) => ({ kind: t.kind, id: t.id, hash: await hashRecord(t.record), record: t.record, outbox: t.outbox ?? null, ledger: t.ledger ?? null }))),
  });
}
/** The exported file must be loaded back by the operator and must match the current records (proves the file exists and is intact). */
export async function verifyRecordBackup(jsonText: string, report: DryRunReport): Promise<BackupVerification> {
  const problems: string[] = [];
  let parsed: { format?: string; fingerprint?: string; records?: { kind: string; id: string; hash: string; record: unknown }[] } | null = null;
  try { parsed = JSON.parse(jsonText); } catch { parsed = null; }
  if (!parsed || parsed.format !== "tsumugi-maintenance-record-backup" || !Array.isArray(parsed.records)) return { ok: false, problems: ["backup-file-unreadable"], forFingerprint: report.fingerprint };
  if (parsed.fingerprint !== report.fingerprint) problems.push("backup-file-is-for-another-dry-run");
  for (const t of report.preflight.targets) {
    const entry = parsed.records.find((r) => r.kind === t.kind && r.id === t.id);
    if (!entry) { problems.push(`backup-record-missing:${t.kind}:${t.id.slice(-6)}`); continue; }
    if (entry.hash !== (await hashRecord(t.record)) || (await hashRecord(entry.record)) !== entry.hash) problems.push(`backup-record-differs:${t.kind}:${t.id.slice(-6)}`);
  }
  return { ok: problems.length === 0, problems, forFingerprint: report.fingerprint };
}

// ------------------------------------------------------------------ S3 execute + verify
export interface TargetState { kind: string; id: string; vaultMatchesCanonical: boolean | null; ledgerSynced: boolean; outbox: string }
/** One line of the half-finished-state diagnosis: which file / which item disagrees with the canonical record, and how. */
export interface DiagnosisItem { kind: string; id: string; area: "markdown" | "ledger" | "outbox" | "index" | "registry" | "history"; item: string; status: "ok" | "mismatch" | "missing" | "legacy-format" | "unreadable"; detail: string }

async function indexPath(root: FileSystemDirectoryHandle, id: string): Promise<string | null> {
  const raw = await readVaultText(root, ".tsumugi/index.json").catch(() => null);
  if (!raw) return null;
  try { const v = (JSON.parse(raw) as Record<string, string>)[id]; return typeof v === "string" ? v : null; } catch { return null; }
}
async function readJsonAt(root: FileSystemDirectoryHandle, path: string): Promise<{ state: "ok"; value: Record<string, unknown> } | { state: "missing" } | { state: "unreadable" }> {
  let raw: string | null;
  try { raw = await readVaultText(root, path); } catch { return { state: "unreadable" }; }
  if (raw === null) return { state: "missing" };
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? { state: "ok", value: v as Record<string, unknown> } : { state: "unreadable" }; } catch { return { state: "unreadable" }; }
}
const registryShardPath = (key: string) => `.tsumugi/registry/${vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read-only diagnosis of every target: Markdown, ledger, Outbox AND the shared files (index, Registry, History).
 * It never repairs anything; it tells the operator exactly which file/item disagrees.
 */
export async function diagnoseTargets(manifest: MaintenanceManifest, root: FileSystemDirectoryHandle): Promise<DiagnosisItem[]> {
  const out: DiagnosisItem[] = [];
  const add = (t: { kind: string; id: string }, area: DiagnosisItem["area"], item: string, status: DiagnosisItem["status"], detail = "") => out.push({ kind: t.kind, id: t.id, area, item, status, detail });
  for (const r of [...manifest.records].sort(order)) {
    const t = { kind: r.kind, id: r.id };
    const record = r.kind === "conversation" ? await getConversation(r.id) : await getMemoryObject(r.id);
    if (!record) { add(t, "markdown", "canonical record", "missing", "no canonical record in IndexedDB"); continue; }
    // --- Markdown
    let expectedPath: string; let registryKey: string; let expectedHash: string[] = [];
    if (r.kind === "conversation") {
      const conv = record as Conversation; const expectedText = conversationToMarkdown(conv);
      const p = await indexPath(root, r.id);
      expectedPath = p ?? "";
      const text = p ? await readVaultText(root, p).catch(() => undefined) : null;
      if (!p) add(t, "markdown", "conversation file", "missing", "no path in index.json");
      else if (text === undefined) add(t, "markdown", p, "unreadable");
      else if (text === null) add(t, "markdown", p, "missing", "file does not exist");
      else add(t, "markdown", p, text === expectedText ? "ok" : "mismatch", text === expectedText ? "" : "file differs from the canonical conversation");
      registryKey = r.id; expectedHash = [hashVaultText(expectedText)];
    } else {
      const mem = record as MemoryObject; expectedPath = memoryDayFilePath(mem);
      const text = await readVaultText(root, expectedPath).catch(() => undefined);
      const member = text ? parseMemoryDayFile(text).find((x) => x.id === r.id) : undefined;
      if (text === undefined) add(t, "markdown", expectedPath, "unreadable");
      else if (text === null) add(t, "markdown", expectedPath, "missing", "day-file does not exist");
      else if (!member) add(t, "markdown", expectedPath, "missing", "member is not in the day-file");
      else add(t, "markdown", expectedPath, isMemorySame(member, mem) ? "ok" : "mismatch", isMemorySame(member, mem) ? "" : "member differs from the canonical Memory");
      registryKey = dayFileRegistryKey(mem.date.slice(0, 10));
      const plain = memoryObjectToMarkdown(mem);
      const norm = memoryObjectToMarkdown({ ...mem, metadata: { ...mem.metadata, sourceType: normalizedSourceType(mem.metadata.source, mem.metadata.sourceType) } });
      expectedHash = [hashVaultText(plain), hashVaultText(norm)];
    }
    // --- ledger and Outbox
    const ledger = await getVaultSyncState(ledgerKey(t));
    add(t, "ledger", ledgerKey(t), ledger === record.updatedAt ? "ok" : ledger === undefined ? "missing" : "mismatch", ledger === record.updatedAt ? "" : "sync ledger is not at the canonical updatedAt");
    const ob = await getVaultOutboxEntry(outboxId(t));
    if (!ob) add(t, "outbox", outboxId(t), "missing", "no Outbox entry");
    else add(t, "outbox", outboxId(t), ob.status === "done" && ob.recordUpdatedAt === record.updatedAt ? "ok" : "mismatch", `status=${ob.status}${ob.heldReason ? `(${ob.heldReason})` : ""} entryUpToDate=${ob.recordUpdatedAt === record.updatedAt}`);
    // --- index.json
    const idx = await readJsonAt(root, ".tsumugi/index.json");
    if (idx.state !== "ok") add(t, "index", ".tsumugi/index.json", idx.state === "missing" ? "missing" : "unreadable");
    else { const v = idx.value[r.id]; add(t, "index", `index.json[${tailId(r.id)}]`, v === undefined ? "missing" : expectedPath && v !== expectedPath ? "mismatch" : "ok", v === undefined ? "id is not listed" : expectedPath && v !== expectedPath ? "points to a different path" : ""); }
    // --- Registry
    const shardPath = registryShardPath(registryKey);
    const shard = await readJsonAt(root, shardPath);
    if (shard.state !== "ok") add(t, "registry", shardPath, shard.state === "missing" ? "missing" : "unreadable");
    else {
      const records = isObj(shard.value.records) ? shard.value.records : {}, files = isObj(shard.value.files) ? shard.value.files : {};
      const p = records[registryKey];
      if (typeof p !== "string") add(t, "registry", `${shardPath} records[${tailId(registryKey)}]`, "missing", "key is not registered");
      else if (expectedPath && p !== expectedPath) add(t, "registry", `${shardPath} records[${tailId(registryKey)}]`, "mismatch", "registered path differs");
      else {
        const e = files[p];
        if (!isObj(e) || e.status !== "ok") add(t, "registry", `${shardPath} files[${p}]`, "mismatch", "entry missing or not ok");
        else if (r.kind === "conversation") add(t, "registry", `${shardPath} files[${p}].contentHash`, expectedHash.includes(String(e.contentHash)) ? "ok" : "mismatch", expectedHash.includes(String(e.contentHash)) ? "" : "hash differs from the canonical conversation");
        else {
          const hashes = isObj(e.memberHashes) ? e.memberHashes : {};
          const ids = Array.isArray(e.memberIds) ? e.memberIds : [];
          add(t, "registry", `${shardPath} files[${p}].memberIds`, ids.includes(r.id) ? "ok" : "missing", ids.includes(r.id) ? "" : "member is not listed");
          add(t, "registry", `${shardPath} files[${p}].memberHashes[${tailId(r.id)}]`, expectedHash.includes(String(hashes[r.id])) ? "ok" : hashes[r.id] === undefined ? "missing" : "mismatch", expectedHash.includes(String(hashes[r.id])) ? "" : "member hash differs from the canonical Memory");
        }
      }
    }
    // --- History
    const day = r.kind === "conversation" ? (record as Conversation).startedAt.slice(0, 10) : (record as MemoryObject).date.slice(0, 10);
    const hp = `.tsumugi/history/${day.slice(0, 7)}.json`;
    const hist = await readJsonAt(root, hp);
    if (hist.state !== "ok") add(t, "history", hp, hist.state === "missing" ? "missing" : "unreadable");
    else {
      const days = isObj(hist.value.days) ? hist.value.days : {}; const d = days[day];
      if (!isObj(d)) add(t, "history", `${hp} days[${day}]`, "missing", "day is not in the month file");
      else if (!(Array.isArray(d.conversations) || Array.isArray(d.normalMemories) || Array.isArray(d.reflections))) {
        const ids = (Array.isArray(d.conversationIds) ? d.conversationIds : []) as string[];
        add(t, "history", `${hp} days[${day}]`, "legacy-format", r.kind === "conversation" ? (ids.includes(r.id) ? "id listed (legacy day: row fields cannot be verified)" : "id not listed (legacy day)") : "legacy day: member row cannot be verified");
      } else if (r.kind === "conversation") {
        const row = (Array.isArray(d.conversations) ? d.conversations : []).find((x) => isObj(x) && x.id === r.id) as Record<string, unknown> | undefined;
        const conv = record as Conversation;
        const ok = !!row && row.mode === conversationEntryTypeOf(conv) && row.turnCount === conv.turns.length;
        add(t, "history", `${hp} days[${day}].conversations[${tailId(r.id)}]`, row ? (ok ? "ok" : "mismatch") : "missing", row ? (ok ? "" : "mode/turnCount differ") : "row is absent");
      } else {
        const row = (Array.isArray(d.normalMemories) ? d.normalMemories : []).find((x) => isObj(x) && x.id === r.id) as Record<string, unknown> | undefined;
        const mem = record as MemoryObject;
        const ok = !!row && row.preview === truncateHistoryPreview(mem.summary) && JSON.stringify(row.types) === JSON.stringify(mem.types);
        add(t, "history", `${hp} days[${day}].normalMemories[${tailId(r.id)}]`, row ? (ok ? "ok" : "mismatch") : "missing", row ? (ok ? "" : "preview/types differ") : "row is absent");
      }
    }
  }
  return out;
}
const tailId = (id: string) => "…" + id.slice(-6);

/** Read-only: where each target stands right now (summary view of the diagnosis). */
export async function inspectStates(manifest: MaintenanceManifest, root: FileSystemDirectoryHandle): Promise<TargetState[]> {
  const diag = await diagnoseTargets(manifest, root);
  const states = [...manifest.records].sort(order).map((r) => {
    const rows = diag.filter((d) => d.kind === r.kind && d.id === r.id);
    const md = rows.find((d) => d.area === "markdown");
    return { kind: r.kind, id: r.id, vaultMatchesCanonical: md ? (md.status === "ok" ? true : md.status === "unreadable" ? null : false) : null,
      ledgerSynced: rows.some((d) => d.area === "ledger" && d.status === "ok"), outbox: "" };
  });
  for (const st of states) { const e = await getVaultOutboxEntry(outboxId(st)); st.outbox = e ? `${e.status}${e.heldReason ? `(${e.heldReason})` : ""}` : "none"; }
  return states;
}

export interface FileProgress { path: string; state: "not-written" | "written-as-planned" | "unexpected-content" | "missing" }
export interface ExecuteInput {
  manifest: MaintenanceManifest; root: FileSystemDirectoryHandle; report: DryRunReport; vaultBackup: BackupVerification | null; recordBackup: BackupVerification | null;
  confirm: string; now?: () => string;
  /** How long to wait for the Vault-world lock held by another tab (default 15 s). */
  lockTimeoutMs?: number;
}
export interface ExecuteReport {
  ok: boolean; refused?: string; stoppedAt?: string; steps: { kind: string; id: string; writer: string; projection: string }[];
  verification: {
    predictedVsActual: string[]; invariantViolations: Violation[]; idbCollateral: string[]; canonicalChanged: string[];
    /** whole-folder before/after comparison (M2) */
    unexpectedCreated: string[]; unexpectedChanged: string[]; unexpectedDeleted: string[]; blockedWrites: string[];
  };
  fileProgress: FileProgress[];
  /** hash of every content the sync itself wrote into each file (see GuardedVault.writtenHashes); lets a caller tell its own writes from anyone else's */
  writtenHashes?: Record<string, string[]>;
  states: TargetState[];
  diagnosis: DiagnosisItem[];
}
const emptyVerification = (): ExecuteReport["verification"] => ({ predictedVsActual: [], invariantViolations: [], idbCollateral: [], canonicalChanged: [], unexpectedCreated: [], unexpectedChanged: [], unexpectedDeleted: [], blockedWrites: [] });

/** Everything `executeSync` checks BEFORE it takes the Vault-world lock. Returns the refusal, or null when execution may start. */
async function refusalBeforeExecute(input: ExecuteInput): Promise<ExecuteReport | null> {
  const { root, report } = input;
  const refuse = (why: string): ExecuteReport => ({ ok: false, steps: [], verification: emptyVerification(), fileProgress: [], states: [], diagnosis: [], refused: why });
  if (!report.ok) return refuse("dry-run-not-clean");
  if (input.confirm !== `SYNC ${report.preflight.targets.length}`) return refuse("confirmation-phrase");
  for (const b of [input.vaultBackup, input.recordBackup]) if (!b || !b.ok || b.forFingerprint !== report.fingerprint) return refuse("backup-not-verified-for-this-dry-run");
  const perm = typeof (root as unknown as { queryPermission?: unknown }).queryPermission === "function" ? await root.queryPermission({ mode: "readwrite" }) : "granted";
  if (perm !== "granted") return refuse("vault-write-permission-not-granted");
  return null;
}

/**
 * The execution itself. The CALLER holds the exclusive Vault-world lock (`executeSync` takes it; the maintenance window holds it for its
 * whole duration and calls `executeSyncLocked`). Nothing in here takes it again (the lock is not re-entrant).
 */
async function executeBody(input: ExecuteInput): Promise<ExecuteReport> {
  const { manifest, root, report } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const base: ExecuteReport = { ok: false, steps: [], verification: emptyVerification(), fileProgress: [], states: [], diagnosis: [] };
  const refuse = (why: string): ExecuteReport => ({ ...base, refused: why });
  {
    {
      // the world must be exactly what the dry run saw: re-run it UNDER the lock (any change anywhere, including other records, refuses)
      const again = await dryRun(manifest, root, now);
      if (!again.ok || again.fingerprint !== report.fingerprint) return refuse("data-changed-since-dry-run");

      const planned = new Set(report.files.map((f) => f.path));
      const guard = new GuardedVault(root, planned);
      const before = await idbSnapshot();
      const treeBefore = await snapshotTree(root);
      const identity = await getVaultIdentityRecord();
      const ctx = contextOf(report.preflight.targets);
      const out: ExecuteReport = { ...base, verification: emptyVerification() };
      const guarded = guard.root();
      for (const t of report.preflight.targets) {
        const step = { kind: t.kind, id: t.id, writer: "pending", projection: "pending" };
        out.steps.push(step);
        const fresh = t.kind === "conversation" ? await getConversation(t.id) : await getMemoryObject(t.id);
        if (!fresh || fresh.updatedAt !== t.record.updatedAt) { step.writer = "record-changed"; out.stoppedAt = `${t.kind}:${t.id}`; break; }
        try {
          // the writers stamp `metadata.obsidian` on the object they are given: hand them a copy so the canonical object is never mutated
          if (t.kind === "conversation") await scoped(() => writeConversationMarkdown(guarded, clone(fresh as Conversation), "interactive"));
          else await scoped(() => writeMemoryObjectMarkdown(guarded, clone(fresh as MemoryObject), "interactive"));
          step.writer = "written";
        } catch (e) { step.writer = e instanceof VaultRecordNeedsResyncError ? `held:${e.holdReason}` : `error:${(e as Error)?.message?.startsWith("guarded-vault") ? "blocked-unplanned-write" : (e as Error)?.name ?? "error"}`; out.stoppedAt = `${t.kind}:${t.id}`; break; }
        const entry = await getVaultOutboxEntry(outboxId(t));
        if (!entry) { step.projection = "no-entry"; out.stoppedAt = `${t.kind}:${t.id}`; break; }
        const env = { root: guarded, vaultIdentity: identity ?? null, now };
        // the projection is the "bootstrap" side of the save lock (same as saveFoundationBootstrap): serialised against the legacy writers
        const res = await scoped(() => withVaultSaveLock(() => (t.kind === "conversation" ? reconcileConversationOutboxEntry(env, entry) : reconcileMemoryOutboxEntry(env, entry))));
        step.projection = res.status + ("reason" in res && res.reason ? `:${res.reason}` : "");
        const okPending = res.status === "pending" && "reason" in res && res.reason === "verify-history-mismatch";
        if (res.status !== "done" && !okPending) { out.stoppedAt = `${t.kind}:${t.id}`; break; }
      }
      // ---- verification (also after a stop: it shows the half-finished state)
      const v = out.verification;
      v.blockedWrites = [...guard.blocked];
      out.writtenHashes = { ...guard.writtenHashes };
      const realChanges: FileChange[] = [];
      for (const f of report.files) {
        const actual = await readVaultText(root, f.path).catch(() => null);
        if (actual === null) { out.fileProgress.push({ path: f.path, state: "missing" }); if (f.before !== null || out.stoppedAt === undefined) v.predictedVsActual.push(`missing:${f.path}`); continue; }
        const same = normalizeForActualComparison(f.path, actual) === normalizeForActualComparison(f.path, f.after);
        const untouched = f.before !== null && actual === f.before;
        out.fileProgress.push({ path: f.path, state: same ? "written-as-planned" : untouched ? "not-written" : "unexpected-content" });
        if (out.stoppedAt === undefined && !same) v.predictedVsActual.push(`differs-from-dry-run:${f.path}`);
        if (out.stoppedAt !== undefined && !same && !untouched) v.predictedVsActual.push(`unexpected-content:${f.path}`);
        realChanges.push({ path: f.path, before: f.before, after: actual });
      }
      v.invariantViolations = checkVaultInvariants(realChanges.filter((c) => c.before !== c.after), ctx);
      const treeAfter = await snapshotTree(root);
      const tree = diffTree(treeBefore, treeAfter, planned);
      v.unexpectedCreated = tree.unexpected.created; v.unexpectedChanged = tree.unexpected.changed; v.unexpectedDeleted = tree.unexpected.deleted;
      const after = await idbSnapshot();
      const allowed = new Set<string>();
      for (const t of report.preflight.targets) { allowed.add(`ledger:${t.kind}:${t.id}`); allowed.add(`outbox:${t.kind}:${t.id}`); }
      for (const k of new Set([...before.keys(), ...after.keys()])) if (before.get(k) !== after.get(k) && !allowed.has(k)) v.idbCollateral.push(k);
      for (const t of report.preflight.targets) if (before.get(`${t.kind}:${t.id}`) !== after.get(`${t.kind}:${t.id}`)) v.canonicalChanged.push(`${t.kind}:${t.id}`);
      out.diagnosis = await diagnoseTargets(manifest, root);
      out.states = await inspectStates(manifest, root);
      const legacyDay = (d: DiagnosisItem) => d.status === "legacy-format";
      const historyPending = new Set(out.steps.filter((x) => x.projection === "pending:verify-history-mismatch").map((x) => `${x.kind}:${x.id}`));
      out.ok = out.stoppedAt === undefined && v.predictedVsActual.length === 0 && v.invariantViolations.length === 0 && v.idbCollateral.length === 0 && v.canonicalChanged.length === 0
        && v.unexpectedCreated.length === 0 && v.unexpectedChanged.length === 0 && v.unexpectedDeleted.length === 0 && v.blockedWrites.length === 0
        && out.diagnosis.every((d) => d.status === "ok" || legacyDay(d) || (d.area === "outbox" && historyPending.has(`${d.kind}:${d.id}`)))
        && out.states.every((s) => s.vaultMatchesCanonical === true && s.ledgerSynced);
      return out;
    }
  }
}

export async function executeSync(input: ExecuteInput): Promise<ExecuteReport> {
  const refusal = await refusalBeforeExecute(input);
  if (refusal) return refusal;
  const refuse = (why: string): ExecuteReport => ({ ok: false, steps: [], verification: emptyVerification(), fileProgress: [], states: [], diagnosis: [], refused: why });
  // M1: from here on this tab owns the Vault world EXCLUSIVELY (other tabs' Capture / Connect / flush / bootstrap wait or are refused).
  // Lock order is the app's own: world lock (outer) -> save lock (inner, taken by the writers / around each projection) -> registry/history locks.
  // Nothing inside calls withVaultWorldRead / runVaultWorldExclusive again, and the writers are NOT wrapped in the save lock (they take it themselves).
  let locked: Awaited<ReturnType<typeof runVaultWorldExclusive<ExecuteReport>>>;
  try {
    locked = await runVaultWorldExclusive<ExecuteReport>(() => executeBody(input), input.lockTimeoutMs ?? 15000);
  } catch (e) {
    if (e instanceof StaleVaultTabError) return refuse("stale-vault-tab");
    if (e instanceof IncompleteVaultWorldError) return refuse("vault-world-not-in-a-committed-state");
    throw e;
  }
  if (locked.timedOut || !locked.result) return refuse("vault-world-lock-unavailable-another-tab-or-unsupported-browser");
  return locked.result;
}

/**
 * Same execution as `executeSync`, for a caller that ALREADY holds the exclusive Vault-world lock (the maintenance window). It takes no lock
 * of its own (the lock is not re-entrant), so calling `executeSync` from inside the window would deadlock.
 */
export async function executeSyncLocked(input: ExecuteInput): Promise<ExecuteReport> {
  const refusal = await refusalBeforeExecute(input);
  if (refusal) return refusal;
  return executeBody(input);
}

/** Operator helper: builds a manifest draft for the given records (IDs + reviewed state + hash). Reads only; the file is reviewed and re-loaded. */
export async function buildManifestDraft(ids: { kind: "conversation" | "memory"; id: string }[]): Promise<MaintenanceManifest> {
  const identity = await getVaultIdentityRecord();
  const records: ManifestRecord[] = [];
  for (const r of ids) {
    const rec = r.kind === "conversation" ? await getConversation(r.id) : await getMemoryObject(r.id);
    if (!rec) throw new Error(`record-missing:${r.kind}`);
    records.push({ kind: r.kind, id: r.id, expectedUpdatedAt: rec.updatedAt, canonicalHash: await hashRecord(rec) });
  }
  return { format: "tsumugi-maintenance-manifest", schema: 1, scope: "vault-sync", vaultId: identity?.vaultId ?? "", records };
}
// the Vault file name helper is re-exported for tests that need to predict day-file paths
export { dayFileNameFor };
