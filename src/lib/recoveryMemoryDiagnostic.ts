/** One-shot observation of an EXISTING Apply Plan. Never builds/scans/applies a plan.
 * Imports production pure comparisons/serialization only; no db.ts helpers.
 * Output is a closed counts-only schema. Never return/log exceptions or input values.
 */
import type { Link, MemoryObject } from "./types";
import type { RecoveryApplyPlan } from "./vaultRecoveryApply";
import { openExistingRecoveryDatabase, readRecoveryLocalSnapshot, parseRecoveryMemoryMarkdown, recoveryRecordsSemanticEqual, type RecoveryLocalSnapshot } from "./vaultRecovery";
import { readRecoveryControl } from "./vaultRecoverySession";
import { hashVaultText, vaultRegistryBucketOf, dayFileRegistryKey } from "./vault";
import { parseMemoryDayFile, serializeMemoryDayFile, inferSourceType } from "./markdown";

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));
export const MEMORY_DIAGNOSTIC_MISMATCH = "現在のRecovery状態と診断対象が一致しない";
export type MemoryDiagnosticResult = { status: "mismatch" | "unavailable" } | {
  status: "complete";
  registry: { heldMemoryCount: number; dayFileCount: number; statusMismatch: number; rawHashMismatch: number; reserializeOnlyMatch: number; memberIdsMismatch: number };
  links: LinkDiagnostic;
  conflicts: { count: number; "updatedAt-only": number; "timestamp-only": number; "metadata-only": number; "substantive-data-difference": number; fields: Record<string, number> };
};
type LinkCategory = "same-set-order-only" | "canonical-strict-superset" | "vault-strict-superset" | "both-have-unique-links" | "same-link-id-content-difference" | "same-order-and-content";
interface LinkDiagnostic {
  categories: Record<LinkCategory, number>;
  // Counts are per one-sided Link occurrence in the five target Memories.
  canonicalCounterpart: { "counterpart-memory-has-matching-link": number; "no-matching-link": number; indeterminate: number };
  storageEvidence: { "canonical-consistent": number; "vault-consistent": number; indeterminate: number };
}
/** Exact JSON equality, as used by the production Memory links comparison.
 * ID aligns edges; never compare reason/strength loosely or infer chronological authority. */
export function compareDiagnosticLinks(a: Link[], b: Link[]): { category: LinkCategory; exclusive: Link[] } {
  for (const links of [a, b]) {
    requireMatch(Array.isArray(links) && links.every(l => obj(l) && typeof l.id === "string" && l.id.length > 0 && typeof l.sourceId === "string" && typeof l.targetId === "string"));
    requireMatch(new Set(links.map(l => l.id)).size === links.length);
  }
  const am = new Map(a.map(l => [l.id, l])), bm = new Map(b.map(l => [l.id, l]));
  const ax = a.filter(l => !bm.has(l.id)), bx = b.filter(l => !am.has(l.id));
  const changed = a.some(l => bm.has(l.id) && !same(l, bm.get(l.id)));
  const category: LinkCategory = changed ? "same-link-id-content-difference"
    : ax.length && bx.length ? "both-have-unique-links"
    : ax.length ? "canonical-strict-superset" : bx.length ? "vault-strict-superset"
    : same(a, b) ? "same-order-and-content" : "same-set-order-only";
  return { category, exclusive: [...ax, ...bx] };
}
function inspectCounterparts(id: string, links: Link[], memories: MemoryObject[], counts: LinkDiagnostic["canonicalCounterpart"]) {
  for (const link of links) {
    const other = link.sourceId === id && link.targetId !== id ? link.targetId
      : link.targetId === id && link.sourceId !== id ? link.sourceId : null;
    const matches = other === null ? [] : memories.filter(m => m.id === other);
    if (matches.length !== 1 || !Array.isArray(matches[0].links)) { counts.indeterminate++; continue; }
    const edges = matches[0].links.filter(l => l.id === link.id);
    if (edges.length > 1) counts.indeterminate++;
    else if (edges.length === 1 && same(edges[0], link)) counts["counterpart-memory-has-matching-link"]++;
    else counts["no-matching-link"]++;
  }
}
class Mismatch extends Error {}
const requireMatch = (v: unknown) => { if (!v) throw new Mismatch(); };

/** Same fields/normalizations as production semantic comparison. Production comparator
 * is the oracle below: disagreement aborts, never silently reports a different contract. */
export function memoryDifferenceFields(a: MemoryObject, b: MemoryObject): string[] {
  const project = (m: MemoryObject): Obj => ({
    id: m.id, date: m.date.slice(0, 10), types: m.types, content: m.content, summary: m.summary,
    keywords: m.keywords, conversationId: m.conversationId ?? null, links: m.links,
    eventTime: m.eventTime ?? null, eventTimePrecision: m.eventTimePrecision ?? null,
    createdAt: m.createdAt, updatedAt: m.updatedAt,
    "metadata.source": m.metadata.source,
    "metadata.sourceType": m.metadata.sourceType ?? inferSourceType(m.metadata.source),
    "metadata.sourceDetail": m.metadata.sourceDetail ?? null,
    "metadata.aiProvider": m.metadata.aiProvider ?? null,
    "metadata.confidence": m.metadata.confidence ?? null,
    "metadata.schemaVersion": m.metadata.schemaVersion,
    topicId: m.topicId ?? null, profileClaims: m.profileClaims ?? [],
    personMentions: m.personMentions ?? [], topicEvents: m.topicEvents ?? [], evidenceQuotes: m.evidenceQuotes ?? [],
  });
  const x = project(a), y = project(b);
  const fields = Object.keys(x).filter(k => !same(x[k], y[k]));
  requireMatch((fields.length === 0) === recoveryRecordsSemanticEqual("memory", a, b));
  return fields;
}

/** Only getters are reachable on this capability. create:false at every level. */
async function readText(root: FileSystemDirectoryHandle, path: string): Promise<string> {
  const parts = path.split("/");
  requireMatch(parts.length > 1 && parts.every(p => p && p !== "." && p !== ".." && !p.includes("\\")));
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: false });
  return (await (await dir.getFileHandle(parts.at(-1)!, { create: false })).getFile()).text();
}
function strictMembers(raw: string): MemoryObject[] {
  const blocks = raw.split("\n<!-- tsumugi:entry -->\n\n").map(s => s.trim()).filter(Boolean);
  const members = blocks.map(parseRecoveryMemoryMarkdown);
  requireMatch(members.length && members.every(Boolean));
  const result = members as MemoryObject[];
  requireMatch(new Set(result.map(m => m.id)).size === result.length);
  return result;
}

/** Testable read-only core. snapshot() must read existing canonical data, not initialize it. */
export async function inspectHeldMemories(plan: RecoveryApplyPlan, root: FileSystemDirectoryHandle,
  snapshot: () => Promise<RecoveryLocalSnapshot>, stillCurrent: () => boolean): Promise<MemoryDiagnosticResult> {
  try {
    // Capture primitive target tuples before the first await; never retain mutable
    // held objects as the authority for the diagnostic run.
    const targetSignature = () => JSON.stringify({ count: plan.heldCount,
      targets: plan.held.map(h => [h.recordId, h.reason, h.recordType]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      scanCompleted: plan.plan.scanCompleted, issues: plan.plan.issues,
    });
    const initialTargets = targetSignature();
    const held = plan.held.map(h => ({ ...h }));
    const registryHeld = held.filter(h => h.recordType === "memory" && h.reason === "registry-entry-differs");
    const conflictHeld = held.filter(h => h.recordType === "memory" && h.reason === "conflict");
    requireMatch(plan.heldCount === 10 && plan.held.length === 10 && registryHeld.length === 5 && conflictHeld.length === 5);
    requireMatch(plan.plan.scanCompleted && plan.plan.issues.length === 0 && stillCurrent());
    requireMatch(new Set(plan.held.map(h => h.recordId)).size === 10);
    const local = await snapshot();
    // Refuse stale canonical/ledger snapshots, including changes outside the target set.
    requireMatch(same(local, plan.snapshot));
    const reads = new Map<string, string>();
    const read = async (path: string) => {
      if (!reads.has(path)) reads.set(path, await readText(root, path));
      return reads.get(path)!;
    };
    const result: Extract<MemoryDiagnosticResult, { status: "complete" }> = {
      status: "complete", links: {
        categories: { "same-set-order-only": 0, "canonical-strict-superset": 0, "vault-strict-superset": 0, "both-have-unique-links": 0, "same-link-id-content-difference": 0, "same-order-and-content": 0 },
        canonicalCounterpart: { "counterpart-memory-has-matching-link": 0, "no-matching-link": 0, indeterminate: 0 },
        // Ledger/outbox timestamps do not attest to a particular links payload.
        // Do not label either side authoritative from updatedAt alone; no outbox read needed.
        storageEvidence: { "canonical-consistent": 0, "vault-consistent": 0, indeterminate: 5 },
      }, registry: { heldMemoryCount: 5, dayFileCount: 0, statusMismatch: 0, rawHashMismatch: 0, reserializeOnlyMatch: 0, memberIdsMismatch: 0 },
      conflicts: { count: 5, "updatedAt-only": 0, "timestamp-only": 0, "metadata-only": 0, "substantive-data-difference": 0, fields: {} },
    };
    const seen = new Set<string>();
    for (const h of [...registryHeld, ...conflictHeld]) {
      const records = plan.plan.records.filter(r => r.recordType === "memory" && r.recordId === h.recordId);
      requireMatch(records.length === 1);
      const r = records[0];
      requireMatch(r.indexedDBExists && r.vaultPaths.length === 1);
      requireMatch(r.classification === (h.reason === "conflict" ? "conflict" : "equivalent-existing"));
      const canonical = local.memories.filter(m => m.id === h.recordId);
      requireMatch(canonical.length === 1);
      const path = r.vaultPaths[0], raw = await read(path), members = strictMembers(raw);
      const matches = members.filter(m => m.id === h.recordId);
      requireMatch(matches.length === 1);
      const fields = memoryDifferenceFields(canonical[0], matches[0]);
      if (h.reason === "conflict") {
        requireMatch(fields.length > 0);
        const linkDiff = compareDiagnosticLinks(canonical[0].links, matches[0].links);
        result.links.categories[linkDiff.category]++;
        inspectCounterparts(h.recordId, linkDiff.exclusive, local.memories, result.links.canonicalCounterpart);
        const category = fields.length === 1 && fields[0] === "updatedAt" ? "updatedAt-only"
          : fields.every(f => ["date", "createdAt", "updatedAt", "eventTime", "eventTimePrecision"].includes(f)) ? "timestamp-only"
          : fields.every(f => f.startsWith("metadata.")) ? "metadata-only" : "substantive-data-difference";
        result.conflicts[category]++;
        for (const field of fields) result.conflicts.fields[field] = (result.conflicts.fields[field] ?? 0) + 1;
        continue;
      }
      requireMatch(fields.length === 0);
      const key = dayFileRegistryKey(canonical[0].date.slice(0, 10));
      requireMatch(r.registryKey === key && members.every(m => dayFileRegistryKey(m.date.slice(0, 10)) === key));
      const shard: unknown = JSON.parse(await read(`.tsumugi/registry/${vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`));
      requireMatch(obj(shard) && obj(shard.records) && obj(shard.files));
      const s = shard as { records: Obj; files: Obj };
      requireMatch(s.records[key] === path && obj(s.files[path]));
      const entry = s.files[path] as Obj;
      requireMatch(typeof entry.contentHash === "string" && typeof entry.status === "string" && Array.isArray(entry.memberIds) && entry.memberIds.every(x => typeof x === "string"));
      const statusMismatch = entry.status !== "ok";
      const rawMismatch = entry.contentHash !== hashVaultText(raw);
      const memberMismatch = !sameSet(entry.memberIds as string[], members.map(m => m.id));
      requireMatch(statusMismatch || rawMismatch || memberMismatch);
      if (seen.has(path)) continue;
      seen.add(path);
      result.registry.dayFileCount++;
      result.registry.statusMismatch += Number(statusMismatch);
      result.registry.rawHashMismatch += Number(rawMismatch);
      result.registry.memberIdsMismatch += Number(memberMismatch);
      // EXACT production Projection pipeline: ordinary parser, createdAt sort, serializer.
      const projected = parseMemoryDayFile(raw).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      requireMatch(sameSet(projected.map(m => m.id), members.map(m => m.id)));
      result.registry.reserializeOnlyMatch += Number(rawMismatch && entry.contentHash === hashVaultText(serializeMemoryDayFile(projected)));
    }
    // External editors do not honor Web Locks. Re-read every observed file and canonical.
    for (const [path, raw] of reads) requireMatch(await readText(root, path) === raw);
    requireMatch(same(await snapshot(), local) && stillCurrent());
    requireMatch(targetSignature() === initialTargets && plan.plan.scanCompleted && plan.plan.issues.length === 0);
    return result;
  } catch (error) { return { status: error instanceof Mismatch ? "mismatch" : "unavailable" }; }
}

/** Existing handles only. No picker, permission request, OPFS root creation or getDB(). */
export async function runHeldMemoryDiagnostic(plan: RecoveryApplyPlan, root: FileSystemDirectoryHandle,
  stillCurrent: () => boolean, factory: IDBFactory = indexedDB,
  locks: Pick<LockManager, "request"> = navigator.locks): Promise<MemoryDiagnosticResult> {
  try {
    if (!locks?.request) return { status: "unavailable" };
    return await locks.request("tsumugi-vault-world", { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) return { status: "unavailable" };
      const db = await openExistingRecoveryDatabase(factory);
      let changed = false;
      db.onversionchange = () => { changed = true; db.close(); };
      try {
        const before = await readRecoveryControl(db);
        const world = plan.confirmed.world;
        requireMatch(Number(before[0] ?? 0) === world.activeVaultEpoch && Number(before[1]) === world.committedVaultEpoch &&
          before[2] === "1" && world.journalVersion === "current" && Number(before[3] ?? 0) === world.registryGenerationEpoch);
        const result = await inspectHeldMemories(plan, root, () => readRecoveryLocalSnapshot(factory), () => !changed && stillCurrent());
        requireMatch(!changed && same(before, await readRecoveryControl(db)) && stillCurrent());
        return result;
      } finally { db.close(); }
    });
  } catch (error) { return { status: error instanceof Mismatch ? "mismatch" : "unavailable" }; }
}
