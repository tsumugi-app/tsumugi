/** Explicit debug button ONLY. No startup, projection or diagnostic imports this runner. */
import type { MemoryObject } from "./types";
import { compareDiagnosticLinks, memoryDifferenceFields, inspectHeldMemories } from "./recoveryMemoryDiagnostic";
import { createRecoveryApplyEnv, planRecoveryApply, type RecoveryApplyEnv, type RecoveryApplyPlan } from "./vaultRecoveryApply";
import { parseRecoveryMemoryMarkdown, recoveryRecordsSemanticEqual } from "./vaultRecovery";
import { parseMemoryDayFile, serializeMemoryDayFile, memoryObjectToMarkdown } from "./markdown";
import { hashVaultText, serializeVaultRegistryShard, vaultRegistryBucketOf, vaultRecoveryPrimitives, runRecoveryVaultWrite } from "./vault";
import { readRecoveryJournal, saveRecoveryJournal, type RecoveryJournal } from "./vaultRecoveryJournal";
import { commitMemoryLinkRestoration, getVaultIdentityRecord, readMemoryRepairStorage, memoryRepairExpectation, type MemoryRepairExpectation } from "./db";
import { memoryDayFilePath } from "./vaultProjection";
import { runVaultWorldExclusive } from "./vaultWorldLock";

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function insist(value: unknown): asserts value { if (!value) throw new Error("repair-precondition-changed"); }
type FileChange = { path: string; before: string; after: string; beforeHash: string; afterHash: string };
type Payload = { version: 2; storage: MemoryRepairExpectation[]; storageTime: string; allowedFields: { registry: ["contentHash"]; canonical: ["links", "updatedAt"] }; identity: string; targets: string[]; immutable: { path: string; raw: string | null }[]; files: FileChange[]; markdown: { path: string; raw: string; mtime: number; size: number }[];
  changes: { before: MemoryObject; after: MemoryObject }[]; counterparts: MemoryObject[] };
export type NarrowRepairResult = { status: "complete" | "held" | "unavailable"; held?: number; issues?: number };
export interface NarrowRepairEnv {
  apply: RecoveryApplyEnv;
  identity(): Promise<string>;
  read(path: string): Promise<{ raw: string; mtime: number; size: number }>;
  write(path: string, raw: string): Promise<void>;
  commit: typeof commitMemoryLinkRestoration;
  readStorage: typeof readMemoryRepairStorage;
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
  insist(eq(memoryDifferenceFields(before, vault).sort(), ["links", "updatedAt"]));
  const diff = compareDiagnosticLinks(before.links, vault.links);
  insist(diff.category === "vault-strict-superset");
  const a = Date.parse(before.updatedAt), b = Date.parse(vault.updatedAt);
  insist(Number.isFinite(a) && Number.isFinite(b) && b > a);
  const counterparts: MemoryObject[] = [];
  for (const link of diff.exclusive) {
    insist(Number.isFinite(Date.parse(link.createdAt)) && Date.parse(link.createdAt) <= b);
    const other = link.sourceId === before.id && link.targetId !== before.id ? link.targetId
      : link.targetId === before.id && link.sourceId !== before.id ? link.sourceId : null;
    const candidates = all.filter(m => m.id === other);
    insist(candidates.length === 1);
    const matches = candidates[0].links.filter(l => l.id === link.id);
    insist(matches.length === 1 && eq(matches[0], link));
    counterparts.push(candidates[0]);
  }
  return counterparts;
}

async function prepare(env: NarrowRepairEnv, confirmed: RecoveryApplyPlan): Promise<{ plan: RecoveryApplyPlan; payload: Payload }> {
  const plan = await planRecoveryApply(env.apply);
  insist(eq(plan.confirmed.world, confirmed.confirmed.world) && eq(targets(plan), targets(confirmed)));
  insist(plan.ops.length === 0);
  const diagnostic = await inspectHeldMemories(plan, env.apply.root, env.apply.readLocalSnapshot, () => true);
  insist(diagnostic.status === "complete" && diagnostic.registry.dayFileCount === 3);
  const payload: Payload = { version: 2, storage: [], storageTime: env.apply.now(), allowedFields: { registry: ["contentHash"], canonical: ["links", "updatedAt"] }, identity: await env.identity(), targets: targets(plan), immutable: [], files: [], markdown: [], changes: [], counterparts: [] };
  const shards = new Map<string, { before: string; value: { records: Record<string, string>; files: Record<string, Record<string, unknown>> } }>();
  const days = new Map<string, MemoryObject[]>();
  for (const held of plan.held) {
    const r = plan.plan.records.find(r => r.recordType === "memory" && r.recordId === held.recordId)!;
    insist(r && r.vaultPaths.length === 1);
    const path = r.vaultPaths[0];
    if (!days.has(path)) {
      const file = await env.read(path);
      days.set(path, parseAll(file.raw)); payload.markdown.push({ path, ...file });
    }
    const vault = days.get(path)!.find(m => m.id === held.recordId);
    const before = plan.snapshot.memories.find(m => m.id === held.recordId);
    insist(vault && before);
    insist(path === memoryDayFilePath(before) && path === memoryDayFilePath(vault));
    const registryPathOf = async (key: string) => {
      const shardRaw = (await env.read(`.tsumugi/registry/${vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`)).raw;
      return (JSON.parse(shardRaw) as { records?: Record<string, string> }).records?.[key];
    };
    // Registry must already point at the actual path (checked, never rewritten) for every target.
    insist(r.registryKey && await registryPathOf(r.registryKey) === path);
    if (held.reason === "conflict") {
      payload.counterparts.push(...validateLinkRestoration(before, vault, plan.snapshot.memories));
      const after = { ...before, links: vault.links, updatedAt: vault.updatedAt };
      insist(memoryObjectToMarkdown(after) === memoryObjectToMarkdown(vault));
      payload.changes.push({ before, after });
      payload.storage.push(memoryRepairExpectation(before, after, await env.readStorage(before.id), payload.storageTime));
    } else {
      insist(recoveryRecordsSemanticEqual("memory", before, vault));
      const shardPath = `.tsumugi/registry/${vaultRegistryBucketOf(r.registryKey).toString(16).padStart(2, "0")}.json`;
      if (!shards.has(shardPath)) { const { raw } = await env.read(shardPath); const value = JSON.parse(raw); insist(serializeVaultRegistryShard(value) === raw); shards.set(shardPath, { before: raw, value }); }
      const shard = shards.get(shardPath)!;
      insist(shard.value.records[r.registryKey] === path);
      const entry = shard.value.files[path], file = payload.markdown.find(x => x.path === path)!;
      const members = days.get(path)!;
      insist(entry && entry.status === "ok" && entry.recordType === "memory-day" && entry.mtime === file.mtime && entry.size === file.size);
      insist(eq([...(entry.memberIds as string[])].sort(), members.map(m => m.id).sort()));
      insist(eq(Object.keys(entry.memberHashes as object).sort(), members.map(m => m.id).sort()));
      for (const m of members) insist((entry.memberHashes as Record<string, string>)[m.id] === hashVaultText(memoryObjectToMarkdown(m)));
      const rawHash = hashVaultText(file.raw);
      // Repeated held members in one day share one entry; validate against original.
      const original = JSON.parse(shard.before).files[path];
      insist(original.contentHash !== rawHash && original.contentHash === hashVaultText(serializeMemoryDayFile(parseMemoryDayFile(file.raw).sort((a,b) => a.createdAt.localeCompare(b.createdAt)))));
      entry.contentHash = rawHash;
    }
  }
  for (const [path, s] of shards) payload.files.push({ path, before: s.before, after: serializeVaultRegistryShard(s.value), beforeHash: hashVaultText(s.before), afterHash: hashVaultText(serializeVaultRegistryShard(s.value)) });
  insist(payload.changes.length === 5);
  // Shared day-files are permitted only when every local differing member is one
  // of the validated Link restorations. Unknown members are preserved verbatim.
  for (const members of days.values()) for (const m of members) {
    const local = plan.snapshot.memories.find(x => x.id === m.id);
    if (local) insist(recoveryRecordsSemanticEqual("memory", payload.changes.find(x => x.before.id === m.id)?.after ?? local, m));
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
  try {
    const previous = await readRecoveryJournal(env.apply.store);
    if (previous.kind === "unreadable") return { status: "held" };
    if (previous.kind === "journal" && previous.journal.status === "in-progress") {
      insist(previous.journal.narrowMemoryRepair);
      journal = previous.journal;
    } else {
      insist(confirmed);
      const prepared = await prepare(env, confirmed);
      const now = env.apply.now();
      journal = { version: 1, operationId: env.apply.newId(), status: "in-progress", createdAt: now, updatedAt: now,
        world: prepared.plan.confirmed.world, baselineAtStart: { status: prepared.plan.plan.baseline.status, value: null }, managedBefore: {},
        ops: [], held: [], result: null, unresolvedMetadata: false, narrowMemoryRepair: prepared.payload };
      await saveRecoveryJournal(env.apply.store, journal);
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
  } catch { return { status: "held" }; }
}

export async function runExplicitMemoryRepair(root: FileSystemDirectoryHandle, confirmed: RecoveryApplyPlan | null): Promise<NarrowRepairResult> {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("debugLog") !== "1") return { status: "unavailable" };
  const locked = await runVaultWorldExclusive(async () => {
    const read = async (path: string) => {
      const parts = path.split("/"); insist(parts.every(p => p && p !== "." && p !== ".." && !p.includes("\\")));
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: false });
      const file = await (await dir.getFileHandle(parts.at(-1)!, { create: false })).getFile();
      return { raw: await file.text(), mtime: file.lastModified, size: file.size };
    };
    return executeNarrowMemoryRepair({ apply: createRecoveryApplyEnv(root), read, commit: commitMemoryLinkRestoration, readStorage: readMemoryRepairStorage,
      identity: async () => { const id = await getVaultIdentityRecord(); const disk = JSON.parse((await read(".tsumugi/vault-identity.json")).raw); insist(id?.vaultId && disk.vaultId === id.vaultId && id.activeVaultEpoch === (await createRecoveryApplyEnv(root).readWorld()).activeVaultEpoch); return id.vaultId; },
      write: (path, raw) => runRecoveryVaultWrite(async () => {
        insist(/^\.tsumugi\/registry\/[0-9a-f]{2}\.json$/.test(path));
        const dir = await (await root.getDirectoryHandle(".tsumugi", { create: false })).getDirectoryHandle("registry", { create: false });
        await vaultRecoveryPrimitives.writeFileInDir(dir, path.split("/").at(-1)!, raw, "explicit memory repair");
      }),
    }, confirmed);
  });
  return locked.timedOut ? { status: "unavailable" } : locked.result ?? { status: "unavailable" };
}
