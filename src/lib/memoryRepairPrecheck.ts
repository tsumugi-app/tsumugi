/**
 * READ-ONLY pre-flight comparison of the REAL IndexedDB against the reviewed contamination-repair / Backfill specs.
 *
 * Structural guarantees (enforced by memoryRepairPrecheck.test.ts, which also scans this file's import graph). The reviewed spec is
 * PRIVATE DATA handed in by the operator (privateRepairData.ts); this file contains none of it.
 * - It imports ONLY the pure planners (memoryContaminationRepair.ts, memoryBackfill.ts) and types. It does NOT import
 *   db.ts (whose getDB() can create/upgrade the database), the runner, the DB env, vault.ts, capture.ts or anything with a write path.
 * - It talks to IndexedDB through its own tiny reader: `open("tsumugi")` WITHOUT a version (never upgrades; if the DB does not
 *   exist the open is aborted and nothing is created), and only `readonly` transactions with get / getAll.
 * - It never reads `settings` generally (that store holds the API key): only the specific repair ledger keys it derives itself.
 * - It performs no network request and stores nothing (no localStorage / cookies); the result is a text the operator copies.
 * - The report prints IDs, verdicts, check codes, counts and kinds of difference. No Memory / Conversation text is printed:
 *   any detail containing non-ASCII characters (all user text is Japanese) is replaced by "<text>".
 */
import type { Conversation, MemoryObject } from "./types";
import {
  planRepairItem, repairLedgerKey, repairRollbackLedgerKey, updatingMemoryIdFor, type PlannedItem, type RepairSpecItem, type UpdatingMemorySpec,
} from "./memoryContaminationRepair";
import { backfillLedgerKey, backfillMemoryIdFor, planBackfillItem, type PlannedBackfill } from "./memoryBackfill";
import type { PrivateRepairData } from "./privateRepairData";

export interface OutboxLike { id: string; recordType: string; recordId: string; recordUpdatedAt: string; status: string; heldReason?: string | null }
export interface PrecheckInput { conversations: Conversation[]; memories: MemoryObject[]; outbox: OutboxLike[]; settings: Record<string, string | undefined> }
export type PrecheckStatus = "READY" | "HOLD" | "ALREADY_DONE" | "LEDGER_DONE";

export interface ItemFacts {
  memoryExists: boolean; originalConversationExists: boolean; updatingConversationExists: boolean;
  diff: string[];                      // which of summary/content/updatedAt/conversationId differ from the reviewed corrupted state
  newMemoryId: string; newMemoryState: "absent" | "identical" | "conflict";
  originalReferencesMemory: boolean | null; updatingReferencesNewMemory: boolean | null;
  links: { total: number; reviewed: number; unreviewed: number; counterpartIntact: number; plannedRemove: number } | null;
  structured: Record<string, { original: number; updating: number; foreign: number }>;
  outbox: Record<string, string>;      // record -> done|pending|held|stale|missing
}
export interface PrecheckItem { kind: "repair" | "backfill"; key: string; id: string; status: PrecheckStatus; failed: string[]; checks: { total: number; failed: number }; facts?: ItemFacts; ledger: "present" | "absent"; rollbackLedger?: "present" | "absent" }
export interface ForeignMention { field: string; sourceConversation: string; assertion: string; relation: string; sourceConversationExists: boolean; sourceHasOwnNormalMemory: boolean; backfillKey: string | null }
export interface PrecheckReport {
  status: "ok" | "no-database" | "error";
  error?: string;
  totals: { conversations: number; memories: number; outbox: Record<string, number> };
  items: PrecheckItem[];
  heldForeign: { key: string; holdMaintained: boolean; foreign: ForeignMention[] }[];
  summary: { repair: Record<string, number>; backfill: Record<string, number> };
}

const NON_ASCII = /[^\x20-\x7e]/;
/** Details may carry ids / static English; anything with user text (non-ASCII) is never echoed. */
export function safeDetail(detail: string): string { return NON_ASCII.test(detail) ? "<text>" : detail.slice(0, 160); }
const failedList = (checks: { code: string; pass: boolean; detail: string }[]) =>
  checks.filter((c) => !c.pass).map((c) => (c.detail ? `${NON_ASCII.test(c.code) ? "<text>" : c.code}(${safeDetail(c.detail)})` : c.code));

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const outboxState = (entry: OutboxLike | undefined, updatedAt: string | undefined) =>
  !entry ? "missing" : updatedAt !== undefined && entry.recordUpdatedAt !== updatedAt ? "stale" : entry.status;

type Structured = { sourceConversationId?: string; assertion?: string; relation?: string };

async function describeRepairItem(item: RepairSpecItem, input: PrecheckInput, updating: Record<string, UpdatingMemorySpec>): Promise<ItemFacts> {
  const mem = new Map(input.memories.map((m) => [m.id, m]));
  const memory = mem.get(item.memoryId);
  const original = input.conversations.find((c) => c.id === item.originalConversationId);
  const updatingConv = input.conversations.find((c) => c.id === item.updatingConversationId);
  const newId = await updatingMemoryIdFor(item.updatingConversationId);
  const existingNew = mem.get(newId);
  const spec = updating[item.updatingConversationId];
  const outbox = new Map(input.outbox.map((o) => [o.id, o]));
  const diff: string[] = [];
  if (memory) {
    if (memory.summary !== item.expectedBefore.summary) diff.push("summary");
    if (memory.content !== item.expectedBefore.content) diff.push("content");
    if (memory.updatedAt !== item.expectedBefore.updatedAt) diff.push("updatedAt");
    if (memory.conversationId !== item.originalConversationId) diff.push("conversationId");
  }
  const structured: ItemFacts["structured"] = {};
  for (const field of ["personMentions", "profileClaims", "topicEvents"]) {
    const list = ((memory as unknown as Record<string, Structured[] | undefined> | undefined)?.[field]) ?? [];
    structured[field] = {
      original: list.filter((x) => x.sourceConversationId === item.originalConversationId).length,
      updating: list.filter((x) => x.sourceConversationId === item.updatingConversationId).length,
      foreign: list.filter((x) => x.sourceConversationId !== item.originalConversationId && x.sourceConversationId !== item.updatingConversationId).length,
    };
  }
  let links: ItemFacts["links"] = null;
  if (memory) {
    let reviewed = 0, intact = 0;
    for (const l of memory.links) {
      if (item.links[l.id]) reviewed++;
      const other = mem.get(l.sourceId === memory.id ? l.targetId : l.sourceId);
      if (other && other.links.filter((x) => x.id === l.id).length === 1 && sameJson(other.links.find((x) => x.id === l.id), l)) intact++;
    }
    links = { total: memory.links.length, reviewed, unreviewed: memory.links.length - reviewed, counterpartIntact: intact, plannedRemove: Object.values(item.links).filter((d) => d === "remove").length };
  }
  return {
    memoryExists: !!memory, originalConversationExists: !!original, updatingConversationExists: !!updatingConv, diff,
    newMemoryId: newId,
    newMemoryState: !existingNew ? "absent" : existingNew.conversationId === item.updatingConversationId && spec && existingNew.summary === spec.summary && existingNew.content === spec.content ? "identical" : "conflict",
    originalReferencesMemory: original ? original.memoryObjectIds.includes(item.memoryId) : null,
    updatingReferencesNewMemory: updatingConv ? updatingConv.memoryObjectIds.includes(newId) : null,
    links, structured,
    outbox: {
      [`memory:${item.memoryId}`]: outboxState(outbox.get(`memory:${item.memoryId}`), memory?.updatedAt),
      [`conversation:${item.updatingConversationId}`]: outboxState(outbox.get(`conversation:${item.updatingConversationId}`), updatingConv?.updatedAt),
    },
  };
}

const countBy = <T,>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((a, x) => { const k = f(x); a[k] = (a[k] ?? 0) + 1; return a; }, {});

/** Pure: builds the report from an already-read snapshot (the reader below is the only part that touches IndexedDB). */
export async function buildPrecheckReport(input: PrecheckInput, data: PrivateRepairData, now = "1970-01-01T00:00:00.000Z"): Promise<PrecheckReport> {
  const items: PrecheckItem[] = [];
  for (const item of data.repair.items) {
    const ledger = input.settings[repairLedgerKey(item.memoryId)] !== undefined ? "present" : "absent";
    const rollbackLedger = input.settings[repairRollbackLedgerKey(item.memoryId)] !== undefined ? "present" : "absent";
    const planned: PlannedItem = await planRepairItem(item, { memories: input.memories, conversations: input.conversations }, now, data.repair.updating);
    const facts = await describeRepairItem(item, input, data.repair.updating);
    const status: PrecheckStatus = ledger === "present" ? "LEDGER_DONE" : planned.status;
    items.push({
      kind: "repair", key: item.key, id: item.memoryId, status, ledger, rollbackLedger, facts,
      failed: planned.status === "HOLD" ? failedList(planned.checks) : [],
      checks: planned.status === "ALREADY_DONE" ? { total: 0, failed: 0 } : { total: planned.checks.length, failed: planned.checks.filter((c) => !c.pass).length },
    });
  }
  for (const item of data.backfill) {
    const ledger = input.settings[backfillLedgerKey(item.conversationId)] !== undefined ? "present" : "absent";
    const planned: PlannedBackfill = await planBackfillItem(item, { memories: input.memories, conversations: input.conversations }, now);
    const id = await backfillMemoryIdFor(item.conversationId);
    const conv = input.conversations.find((c) => c.id === item.conversationId);
    const entry = input.outbox.find((o) => o.id === `conversation:${item.conversationId}`);
    items.push({
      kind: "backfill", key: item.key, id: item.conversationId, ledger,
      status: ledger === "present" ? "LEDGER_DONE" : planned.status,
      failed: planned.status === "HOLD" ? planned.reasons.map(safeDetail) : [],
      checks: { total: 0, failed: planned.status === "HOLD" ? planned.reasons.length : 0 },
      facts: {
        memoryExists: input.memories.some((m) => m.id === id), originalConversationExists: !!conv, updatingConversationExists: !!conv, diff: [], newMemoryId: id,
        newMemoryState: input.memories.some((m) => m.id === id) ? "identical" : "absent",
        originalReferencesMemory: conv ? conv.memoryObjectIds.includes(id) : null, updatingReferencesNewMemory: null, links: null, structured: {},
        outbox: { [`conversation:${item.conversationId}`]: outboxState(entry, conv?.updatedAt) },
      },
    });
  }
  // Held items whose structured entries come from OTHER conversations: only the state of those entries is reported (no text, no change).
  const normalMemoryOwners = new Set(input.memories.filter((x) => x.metadata.source !== "system-generated" && x.conversationId).map((x) => x.conversationId));
  const heldForeign: PrecheckReport["heldForeign"] = [];
  for (const spec of data.repair.items) {
    const m = input.memories.find((x) => x.id === spec.memoryId);
    const foreign: ForeignMention[] = [];
    for (const field of ["personMentions", "profileClaims", "topicEvents"]) {
      for (const x of (((m as unknown as Record<string, Structured[] | undefined> | undefined)?.[field]) ?? [])) {
        if (x.sourceConversationId === spec.originalConversationId || x.sourceConversationId === spec.updatingConversationId) continue;
        const src = x.sourceConversationId ?? "";
        foreign.push({
          field, sourceConversation: src.slice(-6), assertion: x.assertion ?? "-", relation: x.relation ?? "-",
          sourceConversationExists: input.conversations.some((c) => c.id === src), sourceHasOwnNormalMemory: normalMemoryOwners.has(src),
          backfillKey: data.backfill.find((b) => b.conversationId === src)?.key ?? null,
        });
      }
    }
    if (foreign.length) heldForeign.push({ key: spec.key, holdMaintained: items.find((i) => i.kind === "repair" && i.key === spec.key)?.status === "HOLD", foreign });
  }
  const tally = (kind: "repair" | "backfill") => countBy(items.filter((i) => i.kind === kind), (i) => i.status);
  return {
    status: "ok",
    totals: { conversations: input.conversations.length, memories: input.memories.length, outbox: countBy(input.outbox, (o) => o.status) },
    items, heldForeign, summary: { repair: tally("repair"), backfill: tally("backfill") },
  };
}

export function renderPrecheckText(report: PrecheckReport, meta: { build: string; at: string }): string {
  const out: string[] = [];
  out.push("# Memory repair PRE-FLIGHT (read-only; nothing was written, nothing was sent)");
  out.push(`build=${meta.build} at=${meta.at}`);
  if (report.status !== "ok") { out.push(`status=${report.status}${report.error ? ` error=${safeDetail(report.error)}` : ""}`); return out.join("\n"); }
  out.push(`IndexedDB: conversations=${report.totals.conversations} memories=${report.totals.memories} outbox=${JSON.stringify(report.totals.outbox)}`);
  out.push(`repair: ${JSON.stringify(report.summary.repair)}  backfill: ${JSON.stringify(report.summary.backfill)}`);
  out.push("", "## Contamination repair");
  for (const i of report.items.filter((x) => x.kind === "repair")) {
    const f = i.facts!;
    out.push(`- ${i.key} memory=${i.id} => ${i.status} (checks ${i.checks.total - i.checks.failed}/${i.checks.total} pass) ledger=${i.ledger} rollbackLedger=${i.rollbackLedger}`);
    if (i.failed.length) out.push(`    failed: ${i.failed.join("; ")}`);
    out.push(`    exists: memory=${f.memoryExists} originalConv=${f.originalConversationExists} updatingConv=${f.updatingConversationExists} | diff-from-reviewed-state: ${f.diff.length ? f.diff.join(",") : "none"}`);
    out.push(`    newMemory ${f.newMemoryId}: ${f.newMemoryState} | original.memoryObjectIds has memory: ${f.originalReferencesMemory} | updating.memoryObjectIds has new: ${f.updatingReferencesNewMemory}`);
    if (f.links) out.push(`    links: total=${f.links.total} reviewed=${f.links.reviewed} unreviewed=${f.links.unreviewed} counterpartIntact=${f.links.counterpartIntact} plannedRemove=${f.links.plannedRemove}`);
    out.push(`    structured(original/updating/foreign): ${Object.entries(f.structured).map(([k, v]) => `${k}=${v.original}/${v.updating}/${v.foreign}`).join(" ")}`);
    out.push(`    outbox: ${Object.entries(f.outbox).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  for (const held of report.heldForeign) {
    out.push("", `## ${held.key}: HOLD maintained=${held.holdMaintained} (no repair, no deletion; entries from other conversations: ${held.foreign.length})`);
    for (const f of held.foreign) out.push(`- ${f.field} source=…${f.sourceConversation} assertion=${f.assertion} relation=${f.relation} sourceConvExists=${f.sourceConversationExists} sourceHasOwnNormalMemory=${f.sourceHasOwnNormalMemory} backfill=${f.backfillKey ?? "none"}`);
  }
  out.push("", "## Backfill (only the items in the loaded data are examined)");
  for (const i of report.items.filter((x) => x.kind === "backfill")) {
    const f = i.facts!;
    out.push(`- ${i.key} conversation=${i.id} => ${i.status} ledger=${i.ledger} | conv exists=${f.originalConversationExists} newMemoryId=${f.newMemoryId} (${f.newMemoryState}) refs=${f.originalReferencesMemory} | outbox ${Object.values(f.outbox).join(",")}`);
    if (i.failed.length) out.push(`    failed: ${i.failed.join("; ")}`);
  }
  out.push("", "writes performed by this diagnostic: 0");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------- IndexedDB reader (read-only)
export interface PrecheckEnv { indexedDB: IDBFactory; build: string; now: () => string }
const DB_NAME = "tsumugi";
/** Exactly the keys this diagnostic derives itself; the `settings` store (API key etc.) is never listed or scanned. */
const settingsKeys = (data: PrivateRepairData) => [
  ...data.repair.items.flatMap((i) => [repairLedgerKey(i.memoryId), repairRollbackLedgerKey(i.memoryId)]),
  ...data.backfill.map((b) => backfillLedgerKey(b.conversationId)),
];
function req<T>(r: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }

async function openExisting(factory: IDBFactory): Promise<IDBDatabase | null> {
  if (typeof factory.databases === "function") { const list = await factory.databases(); if (!list.some((d) => d.name === DB_NAME)) return null; }
  return new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = factory.open(DB_NAME); // no version: opens the existing database as-is, never upgrades
    request.onupgradeneeded = (event) => { try { (event.target as IDBOpenDBRequest).transaction?.abort(); } catch { /* no-op */ } resolve(null); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

export async function readPrecheckInput(env: PrecheckEnv, data: PrivateRepairData): Promise<PrecheckInput | null> {
  const db = await openExisting(env.indexedDB);
  if (!db) return null;
  try {
    const has = (n: string) => db.objectStoreNames.contains(n);
    const store = (n: string) => db.transaction(n, "readonly").objectStore(n);
    const all = async <T,>(n: string): Promise<T[]> => (has(n) ? ((await req(store(n).getAll())) as T[]) : []);
    const settings: Record<string, string | undefined> = {};
    if (has("settings")) for (const key of settingsKeys(data)) settings[key] = (await req(store("settings").get(key))) as string | undefined;
    return { conversations: await all<Conversation>("conversations"), memories: await all<MemoryObject>("memoryObjects"), outbox: await all<OutboxLike>("vaultOutbox"), settings };
  } finally { db.close(); }
}

/** The single entry point the diagnostic page calls. Never throws; a failure only yields an error report. */
export async function runMemoryRepairPrecheck(env: PrecheckEnv, data: PrivateRepairData): Promise<{ report: PrecheckReport; text: string }> {
  const at = env.now();
  let report: PrecheckReport;
  try {
    const input = await readPrecheckInput(env, data);
    report = input ? await buildPrecheckReport(input, data, at) : { status: "no-database", totals: { conversations: 0, memories: 0, outbox: {} }, items: [], heldForeign: [], summary: { repair: {}, backfill: {} } };
  } catch (error) {
    report = { status: "error", error: error instanceof Error ? error.name : "unknown", totals: { conversations: 0, memories: 0, outbox: {} }, items: [], heldForeign: [], summary: { repair: {}, backfill: {} } };
  }
  return { report, text: renderPrecheckText(report, { build: env.build, at }) };
}
