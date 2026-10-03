/** Explicit debug button ONLY. No startup, projection or diagnostic imports this runner. */
import type { MemoryObject } from "./types";
import { compareDiagnosticLinks, memoryDifferenceFields, inspectHeldMemories, runHeldMemoryDiagnostic, type MemoryDiagnosticResult } from "./recoveryMemoryDiagnostic";
import { createRecoveryApplyEnv, planRecoveryApply, type RecoveryApplyEnv, type RecoveryApplyPlan } from "./vaultRecoveryApply";
import { parseRecoveryMemoryMarkdown, recoveryRecordsSemanticEqual } from "./vaultRecovery";
import { parseMemoryDayFile, serializeMemoryDayFile, memoryObjectToMarkdown } from "./markdown";
import { hashVaultText, serializeVaultRegistryShard, vaultRegistryBucketOf, vaultRecoveryPrimitives, runRecoveryVaultWrite } from "./vault";
import { readRecoveryJournal, saveRecoveryJournal, type RecoveryJournal } from "./vaultRecoveryJournal";
import { commitMemoryLinkRestoration, getVaultIdentityRecord, readMemoryRepairStorage, memoryRepairExpectation, type MemoryRepairExpectation } from "./db";
import { memoryDayFilePath } from "./vaultProjection";
import { runVaultWorldExclusive } from "./vaultWorldLock";
import { excludeArchivedFromApplyPlan } from "./vaultRecoveryLegacyCleanup";

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Diagnostic-only failure description. Closed vocabulary: codes, IDs, and classification values (never record content). */
export type NarrowRepairFailureInfo = { phase: string; code: string; recordType?: string; memoryId?: string; expected?: string; actual?: string };
type FailureDetail = { recordType?: string; memoryId?: string; expected?: string; actual?: string };
export class NarrowRepairFailure extends Error {
  constructor(public code: string, public detail: FailureDetail = {}) { super(code); }
}
function fail(code: string, detail: FailureDetail = {}): never { throw new NarrowRepairFailure(code, detail); }
let checkTrace: ((entry: { code: string; pass: boolean; detail: FailureDetail }) => void) | null = null;
/** Test/diagnostic seam: observe every guard evaluation (code, expected/actual, pass/fail). Never persisted. */
export function __setNarrowRepairCheckTrace(trace: typeof checkTrace): void { checkTrace = trace; }
function check(value: unknown, code: string, detail: FailureDetail = {}): asserts value { checkTrace?.({ code, pass: !!value, detail }); if (!value) fail(code, detail); }
function insist(value: unknown): asserts value { if (!value) throw new NarrowRepairFailure("repair-precondition-changed"); }
const heldSummary = (p: RecoveryApplyPlan) => {
  const counts = new Map<string, number>();
  for (const h of p.held) { const k = `${h.recordType}/${h.reason}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  return `held=${p.heldCount} issues=${p.plan.issues.length} scanCompleted=${p.plan.scanCompleted} ${[...counts].sort().map(([k, n]) => `${k}:${n}`).join(",")}`;
};
const relation = (value: string | undefined | null, before: string, after: string) =>
  value === undefined || value === null ? "absent" : value === before ? "equals-before-updatedAt" : value === after ? "equals-after-updatedAt" : "other-value";
/** Converts any thrown value into a safe diagnostic (error messages are used only when they are plain codes). */
function describeFailure(error: unknown, phase: string): NarrowRepairFailureInfo {
  if (error instanceof NarrowRepairFailure) return { phase, code: error.code, ...error.detail };
  const message = error instanceof Error ? error.message : "";
  return { phase, code: /^[a-z0-9-]{1,60}$/.test(message) ? message : "unexpected-error", actual: error instanceof Error ? error.name : typeof error };
}
type FileChange = { path: string; before: string; after: string; beforeHash: string; afterHash: string };
type Payload = { version: 2; storage: MemoryRepairExpectation[]; storageTime: string; allowedFields: { registry: ["contentHash"]; canonical: ["links", "updatedAt"] }; identity: string; targets: string[]; immutable: { path: string; raw: string | null }[]; files: FileChange[]; markdown: { path: string; raw: string; mtime: number; size: number }[];
  changes: { before: MemoryObject; after: MemoryObject }[]; counterparts: MemoryObject[] };
export type NarrowRepairResult = { status: "complete" | "held" | "unavailable"; held?: number; issues?: number; failure?: NarrowRepairFailureInfo };
export interface NarrowRepairEnv {
  apply: RecoveryApplyEnv;
  identity(): Promise<string>;
  read(path: string): Promise<{ raw: string; mtime: number; size: number }>;
  write(path: string, raw: string): Promise<void>;
  commit: typeof commitMemoryLinkRestoration;
  readStorage: typeof readMemoryRepairStorage;
  /** The same archive exclusion the normal Recovery "確認する" applies (`excludeArchivedFromApplyPlan`). */
  excludeArchived(plan: RecoveryApplyPlan): Promise<RecoveryApplyPlan>;
}
const targets = (p: RecoveryApplyPlan) => p.held.map(h => JSON.stringify([h.recordType, h.recordId, h.reason])).sort();
function parseAll(raw: string): MemoryObject[] {
  const blocks = raw.split("\n<!-- tsumugi:entry -->\n\n").map(x => x.trim()).filter(Boolean);
  const members = blocks.map(parseRecoveryMemoryMarkdown);
  insist(members.length && members.every(Boolean));
  const result = members as MemoryObject[];
  insist(new Set(result.map(m => m.id)).size === result.length);
  return result;
}
export function validateLinkRestoration(before: MemoryObject, vault: MemoryObject, all: MemoryObject[]): MemoryObject[] {
  const d = { recordType: "memory", memoryId: before.id };
  const fields = memoryDifferenceFields(before, vault).sort();
  check(eq(fields, ["links", "updatedAt"]), "link-differing-fields-not-only-links-updatedat", { ...d, expected: "links,updatedAt", actual: fields.join(",") || "none" });
  const diff = compareDiagnosticLinks(before.links, vault.links);
  check(diff.category === "vault-strict-superset", "link-not-vault-strict-superset", { ...d, expected: "vault-strict-superset", actual: diff.category });
  const a = Date.parse(before.updatedAt), b = Date.parse(vault.updatedAt);
  check(Number.isFinite(a) && Number.isFinite(b), "link-updatedat-invalid", { ...d, expected: "valid timestamps", actual: `canonical:${Number.isFinite(a) ? "valid" : "invalid"} vault:${Number.isFinite(b) ? "valid" : "invalid"}` });
  check(b > a, "link-vault-updatedat-not-newer", { ...d, expected: "vault updatedAt > canonical updatedAt", actual: b === a ? "equal" : "vault-older" });
  const counterparts: MemoryObject[] = [];
  for (const link of diff.exclusive) {
    const created = Date.parse(link.createdAt);
    check(Number.isFinite(created) && created <= b, "link-createdat-invalid-or-after-updatedat", { ...d, expected: "valid and <= vault updatedAt", actual: Number.isFinite(created) ? "later-than-vault-updatedAt" : "invalid" });
    const other = link.sourceId === before.id && link.targetId !== before.id ? link.targetId
      : link.targetId === before.id && link.sourceId !== before.id ? link.sourceId : null;
    const candidates = all.filter(m => m.id === other);
    check(candidates.length === 1, "link-counterpart-not-unique", { ...d, expected: "exactly 1 counterpart memory", actual: `${other === null ? "link-not-attached-to-memory" : candidates.length}` });
    const matches = candidates[0].links.filter(l => l.id === link.id);
    check(matches.length === 1 && eq(matches[0], link), "link-counterpart-link-differs", { ...d, expected: "counterpart has identical link", actual: matches.length === 0 ? "counterpart-has-no-matching-link" : matches.length > 1 ? "duplicate-link-ids" : "link-content-differs" });
    counterparts.push(candidates[0]);
  }
  return counterparts;
}

async function prepare(env: NarrowRepairEnv, confirmed: RecoveryApplyPlan): Promise<{ plan: RecoveryApplyPlan; payload: Payload }> {
  const plan = await planRecoveryApply(env.apply);
  check(eq(plan.confirmed.world, confirmed.confirmed.world), "world-changed-since-confirmed-plan", { expected: "same world as the confirmed plan", actual: "world differs" });
  // The confirmed plan is the archive-excluded view the user saw. Compare it with the SAME view of the
  // current state; the repair itself keeps working on the raw plan (archive never counts as resolved).
  const currentView = await env.excludeArchived(plan);
  check(eq(targets(currentView), targets(confirmed)), "held-targets-differ-from-confirmed-plan", { expected: heldSummary(confirmed), actual: `${heldSummary(currentView)} (raw: ${heldSummary(plan)})` });
  check(plan.ops.length === 0, "plan-has-recoverable-ops", { expected: "0 ops", actual: `${plan.ops.length} ops` });
  const diagnostic = await inspectHeldMemories(plan, env.apply.root, env.apply.readLocalSnapshot, () => true);
  check(diagnostic.status === "complete", "held-diagnostic-not-complete", { expected: "complete", actual: diagnostic.status });
  check(diagnostic.registry.dayFileCount === 3, "registry-day-file-count-mismatch", { expected: "3 day-files", actual: `${diagnostic.registry.dayFileCount} day-files` });
  const payload: Payload = { version: 2, storage: [], storageTime: env.apply.now(), allowedFields: { registry: ["contentHash"], canonical: ["links", "updatedAt"] }, identity: await env.identity(), targets: targets(plan), immutable: [], files: [], markdown: [], changes: [], counterparts: [] };
  const shards = new Map<string, { before: string; value: { records: Record<string, string>; files: Record<string, Record<string, unknown>> } }>();
  const days = new Map<string, MemoryObject[]>();
  for (const held of plan.held) {
    const r = plan.plan.records.find(r => r.recordType === "memory" && r.recordId === held.recordId)!;
    const target = { recordType: held.recordType, memoryId: held.recordId };
    check(r && r.vaultPaths.length === 1, "recovery-vault-path-not-unique", { ...target, expected: "exactly 1 Vault path", actual: `${r ? r.vaultPaths.length : "no-plan-record"} paths` });
    const path = r.vaultPaths[0];
    if (!days.has(path)) {
      const file = await env.read(path);
      days.set(path, parseAll(file.raw)); payload.markdown.push({ path, ...file });
    }
    const vault = days.get(path)!.find(m => m.id === held.recordId);
    const before = plan.snapshot.memories.find(m => m.id === held.recordId);
    check(vault && before, "memory-missing-in-vault-or-canonical", { ...target, expected: "present in Vault day-file and canonical", actual: `${vault ? "vault:present" : "vault:missing"} ${before ? "canonical:present" : "canonical:missing"}` });
    check(path === memoryDayFilePath(before), "actual-path-differs-from-normal-projection-path-canonical", { ...target, expected: memoryDayFilePath(before), actual: path });
    check(path === memoryDayFilePath(vault), "actual-path-differs-from-normal-projection-path-vault", { ...target, expected: memoryDayFilePath(vault), actual: path });
    const registryPathOf = async (key: string) => {
      const shardRaw = (await env.read(`.tsumugi/registry/${vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`)).raw;
      return (JSON.parse(shardRaw) as { records?: Record<string, string> }).records?.[key];
    };
    // Registry must already point at the actual path (checked, never rewritten) for every target.
    const registryPath = r.registryKey ? await registryPathOf(r.registryKey) : undefined;
    check(r.registryKey && registryPath === path, "registry-path-mismatch", { ...target, expected: path, actual: registryPath ?? "absent" });
    if (held.reason === "conflict") {
      payload.counterparts.push(...validateLinkRestoration(before, vault, plan.snapshot.memories));
      const after = { ...before, links: vault.links, updatedAt: vault.updatedAt };
      check(memoryObjectToMarkdown(after) === memoryObjectToMarkdown(vault), "link-restored-memory-not-byte-equal-to-vault", { ...target, expected: "restored Markdown == Vault Markdown", actual: "differs" });
      payload.changes.push({ before, after });
      const storage = await env.readStorage(before.id);
      try { payload.storage.push(memoryRepairExpectation(before, after, storage, payload.storageTime)); }
      catch (error) {
        const code = error instanceof Error ? error.message : "repair-storage-invalid";
        const ob = storage.outbox;
        fail(code, { ...target, expected: code === "repair-ledger-changed" ? "ledger absent, or equals canonical before.updatedAt, or equals Vault updatedAt" : "outbox absent, or recordUpdatedAt equals before/after updatedAt",
          actual: code === "repair-ledger-changed" ? `ledger ${relation(storage.ledger, before.updatedAt, after.updatedAt)}` : `outbox ${ob ? `${ob.status} recordUpdatedAt:${relation(ob.recordUpdatedAt, before.updatedAt, after.updatedAt)} idMatches:${ob.id === `memory:${before.id}`}` : "absent"}` });
      }
    } else {
      check(recoveryRecordsSemanticEqual("memory", before, vault), "registry-target-not-semantically-equivalent", { ...target, expected: "canonical == Vault member", actual: `differs in: ${memoryDifferenceFields(before, vault).join(",") || "unknown"}` });
      const shardPath = `.tsumugi/registry/${vaultRegistryBucketOf(r.registryKey).toString(16).padStart(2, "0")}.json`;
      if (!shards.has(shardPath)) { const { raw } = await env.read(shardPath); const value = JSON.parse(raw); check(serializeVaultRegistryShard(value) === raw, "registry-shard-not-in-canonical-format", { ...target, expected: "shard bytes == normal writer serialization", actual: "differs" }); shards.set(shardPath, { before: raw, value }); }
      const shard = shards.get(shardPath)!;
      check(shard.value.records[r.registryKey] === path, "registry-path-mismatch", { ...target, expected: path, actual: shard.value.records[r.registryKey] ?? "absent" });
      const entry = shard.value.files[path], file = payload.markdown.find(x => x.path === path)!;
      const members = days.get(path)!;
      check(entry, "registry-entry-missing", { ...target, expected: "entry for day-file path", actual: "absent" });
      check(entry.status === "ok" && entry.recordType === "memory-day", "registry-entry-status-or-type", { ...target, expected: "status=ok recordType=memory-day", actual: `status=${String(entry.status)} recordType=${String(entry.recordType)}` });
      check(entry.mtime === file.mtime && entry.size === file.size, "registry-entry-mtime-or-size-differs", { ...target, expected: "entry mtime/size == file", actual: `mtime:${entry.mtime === file.mtime ? "equal" : "differs"} size:${entry.size === file.size ? "equal" : "differs"}` });
      check(eq([...(entry.memberIds as string[])].sort(), members.map(m => m.id).sort()), "registry-memberids-differ", { ...target, expected: `${members.length} members of the day-file`, actual: `${(entry.memberIds as string[]).length} memberIds` });
      check(eq(Object.keys(entry.memberHashes as object).sort(), members.map(m => m.id).sort()), "registry-memberhashes-keys-differ", { ...target, expected: `${members.length} memberHashes keys`, actual: `${Object.keys(entry.memberHashes as object).length} keys` });
      for (const m of members) check((entry.memberHashes as Record<string, string>)[m.id] === hashVaultText(memoryObjectToMarkdown(m)), "registry-memberhash-differs", { ...target, memoryId: m.id, expected: "hash of the member's Markdown", actual: "differs" });
      const rawHash = hashVaultText(file.raw);
      // Repeated held members in one day share one entry; validate against original.
      const original = JSON.parse(shard.before).files[path];
      const reserialized = hashVaultText(serializeMemoryDayFile(parseMemoryDayFile(file.raw).sort((a,b) => a.createdAt.localeCompare(b.createdAt))));
      check(original.contentHash !== rawHash && original.contentHash === reserialized, "registry-contenthash-pattern-unexpected", { ...target, expected: "contentHash != raw hash and == re-serialized hash", actual: original.contentHash === rawHash ? "equals-raw-hash" : original.contentHash === reserialized ? "unexpected" : "equals-neither" });
      entry.contentHash = rawHash;
    }
  }
  for (const [path, s] of shards) payload.files.push({ path, before: s.before, after: serializeVaultRegistryShard(s.value), beforeHash: hashVaultText(s.before), afterHash: hashVaultText(serializeVaultRegistryShard(s.value)) });
  check(payload.changes.length === 5, "link-target-count-mismatch", { expected: "5 Link targets", actual: `${payload.changes.length}` });
  // Shared day-files are permitted only when every local differing member is one
  // of the validated Link restorations. Unknown members are preserved verbatim.
  for (const members of days.values()) for (const m of members) {
    const local = plan.snapshot.memories.find(x => x.id === m.id);
    if (local) check(recoveryRecordsSemanticEqual("memory", payload.changes.find(x => x.before.id === m.id)?.after ?? local, m), "dayfile-member-not-equivalent-to-canonical", { recordType: "memory", memoryId: m.id, expected: "canonical (or restored) == Vault member", actual: "differs" });
  }
  const protectedPaths = new Set([".tsumugi/registry-meta.json", ".tsumugi/registry-index.json", ".tsumugi/index.json", ".tsumugi/history-meta.json"]);
  for (const ms of days.values()) for (const m of ms) protectedPaths.add(`.tsumugi/history/${m.date.slice(0,7)}.json`);
  for (const path of protectedPaths) payload.immutable.push({ path, raw: await readOptional(env,path) });
  return { plan, payload };
}

async function readOptional(env: NarrowRepairEnv, path: string): Promise<string | null> {
  try { return (await env.read(path)).raw; }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
}
function validatePayload(p: Payload) {
  insist(eq(p.allowedFields, { registry: ["contentHash"], canonical: ["links", "updatedAt"] }));
  insist(p.version === 2 && p.changes.length === 5 && new Set(p.changes.map(c => c.before.id)).size === 5);
  insist(new Set(p.files.map(f => f.path)).size === p.files.length);
  insist(new Set(p.markdown.map(f => f.path)).size === p.markdown.length);
  insist(p.storage.length === p.changes.length);
  let changed = 0;
  for (const f of p.files) {
    insist(/^\.tsumugi\/registry\/[0-9a-f]{2}\.json$/.test(f.path));
    insist(hashVaultText(f.before) === f.beforeHash && hashVaultText(f.after) === f.afterHash);
    const before = JSON.parse(f.before), after = JSON.parse(f.after), expected = JSON.parse(f.before);
    for (const path of Object.keys(before.files)) if (!eq(before.files[path], after.files[path])) {
      const raw = p.markdown.find(m => m.path === path); insist(raw);
      expected.files[path].contentHash = hashVaultText(raw.raw); changed++;
    }
    insist(eq(expected, after));
    insist(f.before === serializeVaultRegistryShard(before) && f.after === serializeVaultRegistryShard(after));
  }
  insist(changed === 3);
  const vault = p.markdown.flatMap(m => parseAll(m.raw));
  for (const c of p.changes) {
    const storage = p.storage.find(e => e.id === c.before.id);
    insist(storage && eq(storage, memoryRepairExpectation(c.before, c.after, storage.before, p.storageTime)));
    insist(p.markdown.some(m => m.path === memoryDayFilePath(c.after) && parseAll(m.raw).some(v => v.id === c.after.id)));
    insist(eq({ ...c.before, links: c.after.links, updatedAt: c.after.updatedAt }, c.after));
    const matches = vault.filter(m => m.id === c.before.id);
    insist(matches.length === 1 && recoveryRecordsSemanticEqual("memory",c.after,matches[0]));
    insist(memoryObjectToMarkdown(c.after) === memoryObjectToMarkdown(matches[0]));
  }
}

async function verifyInputs(env: NarrowRepairEnv, journal: RecoveryJournal, p: Payload) {
  validatePayload(p);
  insist(eq(await env.apply.readWorld(), journal.world) && await env.identity() === p.identity);
  for (const file of p.markdown) { const now = await env.read(file.path); insist(now.raw === file.raw && now.mtime === file.mtime && now.size === file.size); }
  for (const f of p.immutable) insist(await readOptional(env,f.path) === f.raw);
  const currentPlan = await planRecoveryApply(env.apply);
  insist(currentPlan.plan.scanCompleted && currentPlan.plan.issues.length === 0);
  // Only journal-approved ledger transitions may appear as a temporary held reason.
  insist(currentPlan.held.every(h => p.targets.includes(JSON.stringify([h.recordType, h.recordId, h.reason])) ||
    h.recordType === "memory" && h.reason === "ledger-differs" && p.changes.some(c => c.before.id === h.recordId)));
  insist(currentPlan.ops.every(op => op.members.every(m => p.changes.some(c => c.before.id === m.id)) &&
    Object.entries(op.steps).every(([step, state]) => state === "not-needed" || step === "ledger")));
  const local = await env.apply.readLocalSnapshot();
  for (const c of p.changes) {
    const current = local.memories.find(m => m.id === c.before.id);
    const expected = p.storage.find(e => e.id === c.before.id)!;
    const storage = await env.readStorage(c.before.id);
    insist(eq(current, c.before) && eq(storage, expected.before) ||
      eq(current, c.after) && (eq(storage, expected.intermediate) || eq(storage, expected.after)));
    validateLinkRestoration(c.before, c.after, local.memories);
  }
}

/** Internal runner requires exclusive world ownership; production wrapper below is the only UI entry. */
export async function executeNarrowMemoryRepair(env: NarrowRepairEnv, confirmed: RecoveryApplyPlan | null): Promise<NarrowRepairResult> {
  let journal: RecoveryJournal;
  // Diagnostic only: names the stage that stopped the run (kept in the return value, never persisted).
  let phase = "journal-read";
  try {
    const previous = await readRecoveryJournal(env.apply.store);
    if (previous.kind === "unreadable") return { status: "held", failure: { phase, code: "recovery-journal-unreadable" } };
    if (previous.kind === "journal" && previous.journal.status === "in-progress") {
      check(previous.journal.narrowMemoryRepair, "other-recovery-journal-in-progress", { expected: "narrow repair journal", actual: "in-progress journal without narrow repair" });
      journal = previous.journal;
      phase = "resume";
    } else {
      check(confirmed, "no-confirmed-plan", { expected: "confirmed plan", actual: "none" });
      phase = "prepare";
      const prepared = await prepare(env, confirmed);
      phase = "journal-save";
      const now = env.apply.now();
      journal = { version: 1, operationId: env.apply.newId(), status: "in-progress", createdAt: now, updatedAt: now,
        world: prepared.plan.confirmed.world, baselineAtStart: { status: prepared.plan.plan.baseline.status, value: null }, managedBefore: {},
        ops: [], held: [], result: null, unresolvedMetadata: false, narrowMemoryRepair: prepared.payload };
      await saveRecoveryJournal(env.apply.store, journal);
      phase = "post-journal";
    }
    // Runtime validation below also prevents malformed payloads from reaching writes.
    const p = journal.narrowMemoryRepair as Payload;
    insist(p?.version === 2 && p.changes.length === 5 && p.files.length > 0 && p.markdown.length > 0);
    await verifyInputs(env, journal, p);
    for (const file of p.files) {
      const current = (await env.read(file.path)).raw;
      insist(current === file.before || current === file.after); // neither: never guess on resume
      if (current === file.before) {
        try {
          await env.write(file.path, file.after);
          insist((await env.read(file.path)).raw === file.after);
        } catch {
          // Restore only this interrupted write while holding the lock. Never mark
          // completed on error, even when the rollback read-back succeeds.
          await env.write(file.path, file.before);
          insist((await env.read(file.path)).raw === file.before);
          throw new Error("registry-write-interrupted");
        }
      }
    }
    await verifyInputs(env, journal, p);
    await env.commit(p.changes, p.counterparts, p.storageTime, false, p.storage);
    await verifyInputs(env, journal, p);
    await env.commit(p.changes, p.counterparts, p.storageTime, true, p.storage);
    const plan = await planRecoveryApply(env.apply);
    insist(plan.plan.issues.length === 0 && plan.heldCount === 0 && plan.ops.length === 0);
    await verifyInputs(env, journal, p);
    for (const file of p.files) insist((await env.read(file.path)).raw === file.after);
    journal.status = "completed"; journal.updatedAt = env.apply.now();
    journal.result = { recovered: 10, held: 0, failed: 0 };
    await saveRecoveryJournal(env.apply.store, journal);
    return { status: "complete", held: 0, issues: 0 };
  } catch (error) { return { status: "held", failure: describeFailure(error, phase) }; }
}

const validEpoch = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * The production dependency wiring, shared by the UI entry and by the integration tests.
 * `apply` defaults to the production Recovery env. Tests replace ONLY its `readLocalSnapshot`/`readRecord`
 * (the fake IndexedDB has no IDBFactory.databases()); every other dependency is the production one.
 */
export function createProductionNarrowRepairEnv(root: FileSystemDirectoryHandle, apply: RecoveryApplyEnv = createRecoveryApplyEnv(root)): NarrowRepairEnv {
  const read = async (path: string) => {
    const parts = path.split("/"); insist(parts.every(p => p && p !== "." && p !== ".." && !p.includes("\\")));
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: false });
    const file = await (await dir.getFileHandle(parts.at(-1)!, { create: false })).getFile();
    return { raw: await file.text(), mtime: file.lastModified, size: file.size };
  };
  return {
    apply, read, commit: commitMemoryLinkRestoration, readStorage: readMemoryRepairStorage,
    // VaultIdentityRecord.activeVaultEpoch is never populated by production code (always null), so it cannot be an
    // invariant. The maintained invariants are: IndexedDB vaultId == vault-identity.json vaultId, and the world's
    // active epoch is a valid epoch that equals the committed epoch (a switch/commit is not half-done).
    identity: async () => {
      const id = await getVaultIdentityRecord(); const disk = JSON.parse((await read(".tsumugi/vault-identity.json")).raw);
      check(id?.vaultId, "vault-identity-unpaired", { expected: "paired vaultId in IndexedDB", actual: "absent" });
      check(disk.vaultId === id.vaultId, "vault-identity-mismatch", { expected: "IndexedDB vaultId == vault-identity.json", actual: "differs" });
      const world = await apply.readWorld();
      check(validEpoch(world.activeVaultEpoch) && validEpoch(world.committedVaultEpoch), "vault-world-epoch-invalid", { expected: "valid active and committed epochs", actual: `active=${String(world.activeVaultEpoch)} committed=${String(world.committedVaultEpoch)}` });
      check(world.committedVaultEpoch === world.activeVaultEpoch, "vault-world-epoch-not-committed", { expected: "committed epoch == active epoch", actual: `active=${world.activeVaultEpoch} committed=${world.committedVaultEpoch}` });
      return id.vaultId;
    },
    excludeArchived: async (p) => excludeArchivedFromApplyPlan({ root, vaultIdentity: (await getVaultIdentityRecord()) ?? null }, p),
    write: (path, raw) => runRecoveryVaultWrite(async () => {
      insist(/^\.tsumugi\/registry\/[0-9a-f]{2}\.json$/.test(path));
      const dir = await (await root.getDirectoryHandle(".tsumugi", { create: false })).getDirectoryHandle("registry", { create: false });
      await vaultRecoveryPrimitives.writeFileInDir(dir, path.split("/").at(-1)!, raw, "explicit memory repair");
    }),
  };
}

export async function runExplicitMemoryRepair(root: FileSystemDirectoryHandle, confirmed: RecoveryApplyPlan | null, options: { apply?: RecoveryApplyEnv } = {}): Promise<NarrowRepairResult> {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("debugLog") !== "1") return { status: "unavailable", failure: { phase: "start", code: "debug-log-not-enabled" } };
  const locked = await runVaultWorldExclusive(() => executeNarrowMemoryRepair(createProductionNarrowRepairEnv(root, options.apply), confirmed));
  return locked.timedOut ? { status: "unavailable", failure: { phase: "start", code: "world-lock-timed-out" } } : locked.result ?? { status: "unavailable", failure: { phase: "start", code: "no-result" } };
}

/**
 * READ ONLY diagnostic of the held Memories. The Recovery screen shows an archive-excluded plan, so the
 * raw plan (nothing excluded) is rebuilt from the current state here. Nothing is written, no plan state
 * is replaced, and no archive entry is touched.
 */
export async function runRawHeldMemoryDiagnostic(root: FileSystemDirectoryHandle, stillCurrent: () => boolean,
  deps: { plan(): Promise<RecoveryApplyPlan>; diagnose: typeof runHeldMemoryDiagnostic } = { plan: () => planRecoveryApply(createRecoveryApplyEnv(root)), diagnose: runHeldMemoryDiagnostic }
): Promise<{ diagnostic: MemoryDiagnosticResult; rawHeld: number | null }> {
  let raw: RecoveryApplyPlan;
  try { raw = await deps.plan(); } catch { return { diagnostic: { status: "unavailable" }, rawHeld: null }; }
  return { diagnostic: await deps.diagnose(raw, root, stillCurrent), rawHeld: raw.heldCount };
}
