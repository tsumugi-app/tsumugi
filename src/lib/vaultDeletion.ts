/** Explicit Vault erasure. No startup worker: preview, confirmation, then a durable,
 * replayable compare-before-write plan. All browser writers are excluded by world
 * + save locks. OS applications do not participate in Web Locks (see lifecycle doc).
 */
import {
  beginPhysicalDeletion, finishPhysicalDeletion, getTombstone, readPhysicalDeletionJournal,
  getVaultIdentityRecord, getActiveVaultEpoch, getCommittedVaultEpoch, getVaultWorldJournalVersion,
  getRegistryGenerationEpoch, bumpRegistryGenerationEpoch, loadVaultHandle, type Tombstone,
} from "./db";
import { isRecoveryBlockingNormalWrites } from "./vaultRecoveryJournal";
import { withVaultSaveLock } from "./vaultSaveLock";
import { writeFileHandleContent } from "./vaultWriter";
import { parseFrontmatter, parseMemoryDayFile, memoryObjectToMarkdown, MEMORY_ENTRY_SEPARATOR } from "./markdown";
import { computeMonthAggregate, getVaultBackend, hashVaultText, dayFileRegistryKey, vaultRegistryBucketOf, type HistoryMonthIndex } from "./vault";

export interface DeletionEdit { path: string; before: string | null; after: string | null }
export interface VaultDeletionPlan {
  version: 1; tombstone: Tombstone; vaultId: string; epoch: number;
  ids: string[]; edits: DeletionEdit[];
  /** A fresh explicit review can repair a partial Worker write; bound to the saved plan. */
  repairOf?: string;
}
const fail = (reason: string): never => { throw new Error(`vault-deletion:${reason}`); };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v); // eslint-disable-line @typescript-eslint/no-explicit-any
const json = (s: string) => { const v: unknown = JSON.parse(s); if (!object(v)) return fail("malformed-metadata"); return v; };
const encode = (v: unknown) => JSON.stringify(v, null, 2);
const safePath = (p: string) => p.length > 0 && !p.includes("\\") && p.split("/").every((x) => x !== "" && x !== "." && x !== "..");
async function parent(root: FileSystemDirectoryHandle, path: string, create = false) {
  if (!safePath(path)) return fail("unsafe-path");
  const parts = path.split("/"); let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name: parts.at(-1)! };
}
async function read(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  try { const { dir, name } = await parent(root, path); return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch (e) { if ((e as Error).name === "NotFoundError") return null; throw e; }
}
async function write(root: FileSystemDirectoryHandle, e: DeletionEdit) {
  const { dir, name } = await parent(root, e.path, e.after !== null);
  if (e.after === null) { await dir.removeEntry(name); return; }
  const file = await dir.getFileHandle(name, { create: true });
  if (typeof file.createWritable !== "function") {
    // Existing OPFS Worker writer verifies readback and attempts rollback on a live failure.
    // A killed Worker is recovered only by an explicit, content-reviewed repair below.
    await writeFileHandleContent(file, e.after); return;
  }
  const stream = await file.createWritable();
  try { await stream.write(e.after); await stream.close(); }
  catch (error) { try { await stream.abort(); } catch { /* retain the original failure */ } throw error; }
}
/** Complete enumeration or throw. Hidden archives are deliberately never erased. */
async function inventory(root: FileSystemDirectoryHandle): Promise<Map<string, string>> {
  const files = new Map<string, string>(); let count = 0;
  async function walk(dir: FileSystemDirectoryHandle, prefix = "", depth = 0): Promise<void> {
    if (depth > 64) return fail("scan-too-deep");
    for await (const [name, h] of dir.entries()) {
      if (++count > 20000) return fail("scan-too-large");
      if (name.startsWith(".") && !(prefix === "" && name === ".tsumugi")) continue;
      const path = prefix + name;
      if (h.kind === "directory") {
        if (!path.startsWith(".tsumugi/") || path === ".tsumugi/history" || path === ".tsumugi/registry") await walk(h as FileSystemDirectoryHandle, path + "/", depth + 1);
      } else if (path.toLowerCase().endsWith(".md") || /^\.tsumugi\/(index|history-meta|registry-meta|vault-identity)\.json$/.test(path) || /^\.tsumugi\/(history|registry)\/[^/]+\.json$/.test(path)) {
        files.set(path, await (await (h as FileSystemFileHandle).getFile()).text());
      }
    }
  }
  await walk(root); return files;
}
interface Entry { raw: string; separator: string; fm?: Record<string, unknown> }
function entries(text: string): Entry[] {
  const first = parseFrontmatter(text.trim())?.frontmatter;
  // Conversations and Reflections are single records, even when their prose contains a day separator.
  if (typeof first?.startedAt === "string" || first?.source === "system-generated") return [{ raw: text, separator: "", fm: first }];
  return text.split(MEMORY_ENTRY_SEPARATOR).map((raw, i) => ({ raw, separator: i === 0 ? "" : MEMORY_ENTRY_SEPARATOR, fm: parseFrontmatter(raw.trim())?.frontmatter }));
}
function target(f: Record<string, unknown> | undefined, t: Tombstone): boolean {
  if (!f || (f.id !== t.id && !(t.kind === "conversation" && t.cascade && f.conversationId === t.id))) return false;
  // An ID mention / hand-written document is not ownership evidence.
  if (f.tsumugi !== true) return fail("matching-record-not-owned");
  const kind = typeof f.startedAt === "string" ? "conversation" : typeof f.date === "string" ? "memory" : null;
  if (!kind || (f.id === t.id && kind !== t.kind)) return fail("ambiguous-record-kind");
  return f.id === t.id || kind === "memory";
}

/** Change only known reference fields in frontmatter; body and unknown fields stay byte-for-byte. */
function withoutDeletedReferences(entry: Entry, ids: Set<string>): Entry {
  const f = entry.fm; if (f?.tsumugi !== true) return entry;
  let raw = entry.raw;
  const replace = (key: string, value: string) => {
    const block = /^(\s*---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(raw);
    if (!block) return fail("reference-frontmatter-unreadable");
    const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*:[^\\r\\n]*`, "gm");
    if ([...block[2].matchAll(pattern)].length !== 1) return fail("ambiguous-reference-field");
    raw = block[1] + block[2].replace(pattern, `${key}: ${value}`) + block[3] + raw.slice(block[0].length);
  };
  if (Array.isArray(f.memoryObjectIds)) {
    const kept = f.memoryObjectIds.filter((id) => typeof id !== "string" || !ids.has(id));
    if (kept.length !== f.memoryObjectIds.length) replace("memoryObjectIds", JSON.stringify(kept));
  }
  if (typeof f.links === "string") {
    const links: unknown = JSON.parse(f.links);
    if (!Array.isArray(links) || links.some((l) => !object(l))) return fail("malformed-links");
    const kept = links.filter((l) => !ids.has(l.sourceId) && !ids.has(l.targetId));
    if (kept.length !== links.length) replace("links", JSON.stringify(JSON.stringify(kept)));
  }
  return { ...entry, raw };
}

/** Pure plan builder used by both browser and fault-injection tests. No file is created. */
export function buildVaultDeletionPlan(files: Map<string, string>, t: Tombstone, vaultId: string, epoch: number, priorIds: string[] = []): VaultDeletionPlan {
  const ids = new Set([t.id, ...priorIds]);
  const edits: DeletionEdit[] = []; const changedPaths = new Map<string, string | null>();
  const affectedDays = new Set<string>();
  if (t.date) affectedDays.add(t.date.slice(0, 10));
  const remainingByDay = new Map<string, Set<string>>();
  const remainingPathsByDay = new Map<string, Set<string>>();
  // Discover the complete cascade before editing references in an earlier file.
  for (const [path, text] of files) if (path.toLowerCase().endsWith(".md") && !path.startsWith(".tsumugi/")) {
    for (const p of entries(text)) if (target(p.fm, t) && typeof p.fm?.id === "string") ids.add(p.fm.id);
  }
  for (const [path, text] of files) {
    if (!path.toLowerCase().endsWith(".md") || path.startsWith(".tsumugi/")) continue;
    const parts = entries(text); const kept = parts.filter((p) => {
      if (!target(p.fm, t)) return true;
      if (typeof p.fm?.id !== "string") return fail("missing-id");
      ids.add(p.fm.id);
      if (typeof p.fm.date === "string") affectedDays.add(p.fm.date.slice(0, 10));
      return false;
    }).map((p) => withoutDeletedReferences(p, ids));
    for (const p of kept) {
      const f = p.fm;
      if (f?.tsumugi === true && typeof f.date === "string" && typeof f.id === "string" && f.source !== "system-generated") {
        const day = f.date.slice(0, 10); const set = remainingByDay.get(day) ?? new Set<string>(); set.add(f.id); remainingByDay.set(day, set);
        const paths = remainingPathsByDay.get(day) ?? new Set<string>(); paths.add(path); remainingPathsByDay.set(day, paths);
      }
    }
    if (kept.length !== parts.length || kept.some((p, i) => p.raw !== parts[i].raw)) {
      const after = kept.length ? kept.map((p, i) => (i === 0 ? "" : p.separator) + p.raw).join("") : null;
      edits.push({ path, before: text, after }); changedPaths.set(path, after);
    }
  }
  const update = (path: string, transform: (v: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const before = files.get(path); if (before === undefined) return;
    const v = json(before); const prior = encode(v); transform(v);
    if (encode(v) !== prior) edits.push({ path, before, after: encode(v) });
  };
  update(".tsumugi/index.json", (v) => { for (const id of ids) delete v[id]; });
  for (const path of files.keys()) if (/^\.tsumugi\/registry\/[0-9a-f]{2}\.json$/.test(path)) update(path, (v) => {
    if (v.schemaVersion !== 1 || !object(v.records) || !object(v.files)) return fail("malformed-registry");
    for (const [p, row] of Object.entries(v.files)) {
      if (!object(row) || !Array.isArray(row.memberIds)) return fail("malformed-registry-row");
      const members = row.memberIds.filter((id: string) => !ids.has(id));
      if (members.length === row.memberIds.length && !changedPaths.has(p)) continue;
      const content = changedPaths.has(p) ? changedPaths.get(p) : files.get(p);
      if (!members.length && (content === null || content === undefined)) {
        delete v.files[p]; for (const [key, value] of Object.entries(v.records)) if (value === p) delete v.records[key];
      } else {
        const actual = typeof content === "string" && row.recordType === "memory-day" ? parseMemoryDayFile(content) : [];
        row.memberIds = [...new Set([...members, ...actual.map((m) => m.id)])];
        // A surviving container retains its path guard even if the registry never knew its added members.
        if (row.status === "ok" && (!members.length || actual.some((m) => !members.includes(m.id)))) row.status = "needs-resync";
        if (object(row.memberHashes)) for (const id of ids) delete row.memberHashes[id];
        // Exact confirmed content, with a deliberately stale stat so the write gate reads its hash.
        if (typeof content === "string") {
          // A deletion is not permission to adopt an unrelated external edit as a safe baseline.
          if (row.status === "ok" && row.contentHash !== hashVaultText(files.get(p) ?? "")) row.status = "needs-resync";
          row.contentHash = hashVaultText(content); row.size = new TextEncoder().encode(content).length; row.mtime = 0;
          if (row.recordType === "memory-day") row.memberHashes = Object.fromEntries(parseMemoryDayFile(content).map((m) => [m.id, hashVaultText(memoryObjectToMarkdown(m))]));
        }
        // Existing conflict/needs-resync states are never relaxed by deletion.
      }
    }
    for (const id of ids) delete v.records[id];
  });
  // Every surviving affected day container needs a guard, including a moved or previously
  // unregistered file. Do not make "all registered members were deleted" mean "safe new day".
  for (const day of affectedDays) {
    const survivors: { path: string; content: string }[] = [];
    for (const path of remainingPathsByDay.get(day) ?? []) {
      const before = files.get(path);
      const content = changedPaths.has(path) ? changedPaths.get(path) : before;
      if (typeof content === "string") survivors.push({ path, content });
    }
    if (!survivors.length) continue;
    const key = dayFileRegistryKey(day); const bucket = vaultRegistryBucketOf(key);
    const path = `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
    const previous = edits.find((e) => e.path === path);
    const original = files.get(path) ?? null;
    const current = previous ? previous.after : original;
    const shard = current === null ? { schemaVersion: 1, bucket, records: {}, files: {} } : json(current);
    if (shard.schemaVersion !== 1 || !object(shard.records) || !object(shard.files)) return fail("malformed-registry");
    const guardedPath = shard.records[key];
    if (survivors.length === 1 && guardedPath === survivors[0].path && object(shard.files[guardedPath])) continue;
    for (const survivor of survivors) {
      const existing = shard.files[survivor.path];
      if (existing && (!object(existing) || existing.recordType !== "memory-day")) return fail("registry-path-collision");
      const members = parseMemoryDayFile(survivor.content);
      shard.files[survivor.path] = {
        ...existing, recordType: "memory-day", mtime: 0, size: new TextEncoder().encode(survivor.content).length,
        contentHash: hashVaultText(survivor.content), memberIds: members.map((m) => m.id),
        memberHashes: Object.fromEntries(members.map((m) => [m.id, hashVaultText(memoryObjectToMarkdown(m))])),
        status: survivors.length > 1 || existing?.status === "conflict" ? "conflict" : "needs-resync",
      };
    }
    shard.records[key] = survivors[0].path;
    const next: DeletionEdit = { path, before: original, after: encode(shard) };
    if (previous) Object.assign(previous, next); else edits.push(next);
  }
  const aggregates: Record<string, { memories: number; conversations: number }> = {};
  for (const path of files.keys()) if (/^\.tsumugi\/history\/\d{4}-\d{2}\.json$/.test(path)) update(path, (v) => {
    if (!object(v.days)) return fail("malformed-history");
    for (const [day, row] of Object.entries(v.days)) {
      if (!object(row)) return fail("malformed-history-day");
      if (Array.isArray(row.conversations)) {
        for (const key of ["conversations", "normalMemories", "reflections"]) {
          if (!Array.isArray(row[key]) || row[key].some((r: unknown) => !object(r) || typeof r.id !== "string")) return fail("malformed-history-row");
          row[key] = row[key].filter((r: { id: string }) => !ids.has(r.id));
        }
      } else {
        if (!Array.isArray(row.conversationIds) || !Array.isArray(row.reflectionIds) || typeof row.normalMemoryCount !== "number") return fail("malformed-history-v1");
        row.conversationIds = row.conversationIds.filter((id: string) => !ids.has(id)); row.reflectionIds = row.reflectionIds.filter((id: string) => !ids.has(id));
        if (affectedDays.has(day)) row.normalMemoryCount = remainingByDay.get(day)?.size ?? 0;
        row.memoryCount = row.normalMemoryCount + row.reflectionIds.length;
      }
    }
    aggregates[path.slice(-12, -5)] = computeMonthAggregate(v as HistoryMonthIndex);
  });
  update(".tsumugi/history-meta.json", (v) => {
    if (!object(v.months)) return fail("malformed-history-meta");
    for (const [month, aggregate] of Object.entries(aggregates)) v.months[month] = aggregate;
    if (Object.values(v.months).some((a) => !object(a) || typeof a.memories !== "number" || typeof a.conversations !== "number")) return fail("malformed-history-meta");
    v.totalMemories = Object.values(v.months).reduce((n, a) => n + a.memories, 0);
    v.totalConversations = Object.values(v.months).reduce((n, a) => n + a.conversations, 0);
  });
  // Invalidate the old generation BEFORE any Markdown / derived-data edit.
  const before = files.get(".tsumugi/registry-meta.json");
  if (before !== undefined) {
    const v = json(before); delete v.registryGeneration; v.dirtyOwnerInstanceId = null;
    edits.unshift({ path: ".tsumugi/registry-meta.json", before, after: encode(v) });
  }
  return { version: 1, tombstone: t, vaultId, epoch, ids: [...ids], edits };
}

/** Exact comparison, not a non-cryptographic hash. Accept before OR after for crash replay. */
export async function applyVaultDeletionEdits(root: FileSystemDirectoryHandle, plan: VaultDeletionPlan): Promise<void> {
  for (const e of plan.edits) {
    if (!safePath(e.path)) return fail("unsafe-path");
    const current = await read(root, e.path);
    if (current !== e.before && current !== e.after) return fail("content-changed:" + e.path);
  }
  for (const e of plan.edits) {
    const current = await read(root, e.path);
    if (current === e.after) continue;
    if (current !== e.before) return fail("content-changed:" + e.path);
    await write(root, e);
    if (await read(root, e.path) !== e.after) return fail("verification-failed:" + e.path);
  }
}

async function locked<T>(root: FileSystemDirectoryHandle, fn: (vaultId: string, epoch: number) => Promise<T>, mode: "read" | "readwrite" = "read"): Promise<T> {
  if (!navigator.locks) return fail("locks-unavailable");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try { return await navigator.locks.request("tsumugi-vault-world", { mode: "exclusive", signal: controller.signal }, () => withVaultSaveLock(async () => {
    clearTimeout(timer);
    if (root.queryPermission && await root.queryPermission({ mode }) !== "granted") return fail("permission-required");
    if (await isRecoveryBlockingNormalWrites()) return fail("recovery-pending");
    const epoch = await getActiveVaultEpoch(); const committed = await getCommittedVaultEpoch();
    if (committed.status !== "valid" || committed.epoch !== epoch || (await getVaultWorldJournalVersion()).status !== "current") return fail("incomplete-world");
    const identity = await getVaultIdentityRecord();
    if (!identity?.vaultId || identity.activeVaultEpoch !== epoch) return fail("unpaired-vault");
    const current = getVaultBackend() === "opfs" ? await navigator.storage.getDirectory() : await loadVaultHandle();
    if (!current || !await root.isSameEntry(current)) return fail("vault-handle-changed");
    const disk = await read(root, ".tsumugi/vault-identity.json");
    if (disk === null || json(disk).vaultId !== identity.vaultId) return fail("vault-identity-mismatch");
    return fn(identity.vaultId, epoch);
  })); } finally { clearTimeout(timer); }
}
export async function previewVaultDeletion(root: FileSystemDirectoryHandle, seen: Tombstone): Promise<VaultDeletionPlan> {
  return locked(root, async (vaultId, epoch) => {
    const t = await getTombstone(seen.kind, seen.id);
    if (!t || JSON.stringify(t) !== JSON.stringify(seen) || t.vaultId !== vaultId) return fail("deletion-intent-changed");
    if (t.physicalDeletionParent) return fail("parent-deletion-required");
    const prior = await readPhysicalDeletionJournal(t.kind, t.id);
    const saved: VaultDeletionPlan | null = prior ? JSON.parse(prior) : null;
    if (saved) validateSavedPlan(saved, t, vaultId, epoch);
    if (saved) await assertReplayable(root, saved);
    const priorIds = saved?.ids ?? [];
    return buildVaultDeletionPlan(await inventory(root), t, vaultId, epoch, priorIds);
  });
}
export async function confirmVaultDeletion(root: FileSystemDirectoryHandle, confirmed: VaultDeletionPlan): Promise<void> {
  return locked(root, async (vaultId, epoch) => {
    if (confirmed.tombstone.physicalDeletionParent) return fail("parent-deletion-required");
    if (vaultId !== confirmed.vaultId || epoch !== confirmed.epoch) return fail("vault-world-changed");
    if (!confirmed.repairOf && confirmed.tombstone.physicalDeletion === "pending") {
      const raw = await readPhysicalDeletionJournal(confirmed.tombstone.kind, confirmed.tombstone.id);
      if (!raw) return fail("journal-missing");
      const saved: VaultDeletionPlan = JSON.parse(raw); validateSavedPlan(saved, confirmed.tombstone, vaultId, epoch);
      await assertReplayable(root, saved);
    }
    const now = confirmed.repairOf
      ? await buildRepairPlan(root, confirmed.tombstone, vaultId, epoch)
      : buildVaultDeletionPlan(await inventory(root), confirmed.tombstone, vaultId, epoch, confirmed.ids);
    if (JSON.stringify(now) !== JSON.stringify(confirmed)) return fail("preview-changed");
    await beginPhysicalDeletion(confirmed.tombstone, JSON.stringify(confirmed), confirmed.tombstone.kind === "conversation" && confirmed.tombstone.cascade ? confirmed.ids.filter((id) => id !== confirmed.tombstone.id) : []);
    await execute(root, confirmed);
  }, "readwrite");
}
async function assertReplayable(root: FileSystemDirectoryHandle, saved: VaultDeletionPlan): Promise<void> {
  for (const e of saved.edits) {
    const current = await read(root, e.path);
    if (current !== e.before && current !== e.after) return fail("content-review-required:" + e.path);
  }
}
function validateSavedPlan(plan: VaultDeletionPlan, seen: Tombstone, vaultId: string, epoch: number): void {
  if (plan.version !== 1 || plan.vaultId !== vaultId || plan.epoch !== epoch || plan.tombstone.deletedAt !== seen.deletedAt || plan.tombstone.id !== seen.id || plan.tombstone.kind !== seen.kind || plan.tombstone.cascade !== seen.cascade) return fail("journal-world-mismatch");
  if (!Array.isArray(plan.edits) || !Array.isArray(plan.ids) || plan.ids.some((id) => typeof id !== "string") || plan.edits.some((e) => typeof e.path !== "string" || (e.before !== null && typeof e.before !== "string") || (e.after !== null && typeof e.after !== "string") || !safePath(e.path) || !(e.path.toLowerCase().endsWith(".md") && !e.path.split("/").some((p) => p.startsWith(".")) || /^\.tsumugi\/(index|history-meta|registry-meta)\.json$/.test(e.path) || /^\.tsumugi\/(history\/\d{4}-\d{2}|registry\/[0-9a-f]{2})\.json$/.test(e.path)))) return fail("journal-malformed");
}
async function journalDigest(raw: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function buildRepairPlan(root: FileSystemDirectoryHandle, seen: Tombstone, vaultId: string, epoch: number): Promise<VaultDeletionPlan> {
  const current = await getTombstone(seen.kind, seen.id);
  if (!current || JSON.stringify(current) !== JSON.stringify(seen) || current.physicalDeletion !== "pending") return fail("deletion-intent-changed");
  if (current.physicalDeletionParent) return fail("parent-deletion-required");
  const raw = await readPhysicalDeletionJournal(seen.kind, seen.id); if (!raw) return fail("journal-missing");
  const saved: VaultDeletionPlan = JSON.parse(raw); validateSavedPlan(saved, seen, vaultId, epoch);
  const edits: DeletionEdit[] = [];
  // Preserve the previously confirmed AFTER text. No parsing/reserializing a possibly torn file.
  for (const e of saved.edits) edits.push({ ...e, before: await read(root, e.path) });
  return { ...saved, tombstone: current, edits, repairOf: await journalDigest(raw) };
}
/** Read-only preview of restoring the already-confirmed results after a torn write.
 * UI must display current/desired text, and confirmation rechecks both journal and files.
 */
export async function previewVaultDeletionRepair(root: FileSystemDirectoryHandle, seen: Tombstone): Promise<VaultDeletionPlan> {
  return locked(root, (vaultId, epoch) => buildRepairPlan(root, seen, vaultId, epoch));
}
async function execute(root: FileSystemDirectoryHandle, plan: VaultDeletionPlan): Promise<void> {
  // A stale in-memory registry mirror cannot authorize writes after this point.
  await bumpRegistryGenerationEpoch(await getRegistryGenerationEpoch());
  await applyVaultDeletionEdits(root, plan);
  const files = await inventory(root);
  for (const e of plan.edits) if (await read(root, e.path) !== e.after) return fail("final-verification-failed:" + e.path);
  for (const [path, text] of files) if (path.toLowerCase().endsWith(".md") && !path.startsWith(".tsumugi/") && entries(text).some((p) => target(p.fm, plan.tombstone))) return fail("copy-reappeared");
  await finishPhysicalDeletion(plan.tombstone);
}
export async function retryVaultDeletion(root: FileSystemDirectoryHandle, seen: Tombstone): Promise<void> {
  return locked(root, async (vaultId, epoch) => {
    const current = await getTombstone(seen.kind, seen.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(seen) || current.physicalDeletion !== "pending") return fail("deletion-intent-changed");
    if (current.physicalDeletionParent) return fail("parent-deletion-required");
    const raw = await readPhysicalDeletionJournal(seen.kind, seen.id);
    if (!raw) return fail("journal-missing");
    const plan: VaultDeletionPlan = JSON.parse(raw);
    validateSavedPlan(plan, seen, vaultId, epoch);
    await execute(root, plan);
  }, "readwrite");
}
