/**
 * Non-target invariants for a Vault sync. Pure: takes the files a write would change (before / after text) and reports every change that
 * touches anything other than the target records. NOTHING non-target may change, not even formatting: a "normalization" is a violation.
 * Allowed, bookkeeping-only exceptions are listed explicitly in each checker (history-meta `updatedAt`, aggregates of the touched month,
 * registry mtime of the files that are being written).
 */
import { parseMemoryObjectMarkdown, parseConversationMarkdown } from "../markdown";

export interface FileChange { path: string; before: string | null; after: string }
export interface InvariantContext {
  targetConversationIds: string[];
  targetMemoryIds: string[];
  /** YYYY-MM-DD of every History day the targets live on. */
  targetDays: string[];
  /** Registry keys that belong to the targets (conversation ids, day-file keys). */
  registryKeys: string[];
}
export interface Violation { path: string; code: string; detail: string }

const SEP = "\n<!-- tsumugi:entry -->\n\n";
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const canonicalJson = (v: unknown) => JSON.stringify(v, null, 2);
const parseJson = (text: string | null): unknown => { if (text === null) return undefined; try { return JSON.parse(text); } catch { return Symbol.for("unparsable"); } };
const UNPARSABLE = Symbol.for("unparsable");

function checkIndex(c: FileChange, ctx: InvariantContext, out: Violation[]) {
  const before = c.before === null ? {} : parseJson(c.before), after = parseJson(c.after);
  if (before === UNPARSABLE || after === UNPARSABLE || !isObj(before) || !isObj(after)) { out.push({ path: c.path, code: "index-unparsable", detail: "" }); return; }
  if (c.before !== null && c.before !== canonicalJson(before)) out.push({ path: c.path, code: "format-would-change", detail: "index.json is not in the writer's canonical formatting" });
  if (c.after !== canonicalJson(after)) out.push({ path: c.path, code: "after-format-unexpected", detail: "" });
  const targets = new Set([...ctx.targetConversationIds, ...ctx.targetMemoryIds]);
  for (const k of Object.keys(before)) if (!(k in after)) out.push({ path: c.path, code: "entry-removed", detail: k.slice(-6) });
  for (const k of Object.keys(after)) {
    if (targets.has(k)) continue;
    if (!(k in before)) out.push({ path: c.path, code: "non-target-entry-added", detail: k.slice(-6) });
    else if (before[k] !== after[k]) out.push({ path: c.path, code: "non-target-entry-changed", detail: k.slice(-6) });
  }
}

function blocksOf(text: string | null): string[] {
  if (text === null) return [];
  return text.split(SEP);
}
function checkDayFile(c: FileChange, ctx: InvariantContext, out: Violation[]) {
  const targets = new Set(ctx.targetMemoryIds);
  const idOf = (block: string) => parseMemoryObjectMarkdown(block.trim())?.id ?? null;
  const before = blocksOf(c.before).filter((b) => b.trim().length > 0), after = blocksOf(c.after).filter((b) => b.trim().length > 0);
  const beforeIds = before.map(idOf), afterIds = after.map(idOf);
  if (beforeIds.some((i) => i === null)) out.push({ path: c.path, code: "unparsable-member-in-day-file", detail: "a block of the existing day-file cannot be parsed and would be dropped" });
  if (afterIds.some((i) => i === null)) out.push({ path: c.path, code: "unparsable-member-after", detail: "" });
  const beforeNon = before.map((b, i) => [beforeIds[i], b] as const).filter(([id]) => id !== null && !targets.has(id));
  const afterNon = after.map((b, i) => [afterIds[i], b] as const).filter(([id]) => id !== null && !targets.has(id));
  if (beforeNon.length !== afterNon.length) out.push({ path: c.path, code: "non-target-member-count-changed", detail: `${beforeNon.length}->${afterNon.length}` });
  const afterMap = new Map(afterNon);
  for (const [id, raw] of beforeNon) {
    const now = afterMap.get(id);
    if (now === undefined) out.push({ path: c.path, code: "non-target-member-removed", detail: String(id).slice(-6) });
    else if (now !== raw) out.push({ path: c.path, code: "non-target-member-bytes-changed", detail: String(id).slice(-6) });
  }
  if (!eq(beforeNon.map(([id]) => id), afterNon.map(([id]) => id))) out.push({ path: c.path, code: "non-target-member-order-changed", detail: "" });
  for (const id of afterIds) if (id !== null && !targets.has(id) && !beforeIds.includes(id)) out.push({ path: c.path, code: "non-target-member-added", detail: String(id).slice(-6) });
}

function checkHistoryMonth(c: FileChange, ctx: InvariantContext, out: Violation[]) {
  const before = c.before === null ? { version: 2, month: "", days: {} } : parseJson(c.before), after = parseJson(c.after);
  if (before === UNPARSABLE || after === UNPARSABLE || !isObj(before) || !isObj(after) || !isObj(before.days) || !isObj(after.days)) { out.push({ path: c.path, code: "history-unparsable", detail: "" }); return; }
  if (c.before !== null && c.before !== canonicalJson(before)) out.push({ path: c.path, code: "format-would-change", detail: "history month file is not in canonical formatting" });
  if (c.before !== null && before.version !== after.version) out.push({ path: c.path, code: "history-version-changed", detail: `${String(before.version)}->${String(after.version)}` });
  const targets = new Set([...ctx.targetConversationIds, ...ctx.targetMemoryIds]);
  const bd = before.days as Record<string, unknown>, ad = after.days as Record<string, unknown>;
  for (const day of Object.keys(bd)) if (!(day in ad)) out.push({ path: c.path, code: "day-removed", detail: day });
  for (const day of Object.keys(ad)) {
    const isTargetDay = ctx.targetDays.includes(day);
    if (!isTargetDay) { if (!(day in bd)) out.push({ path: c.path, code: "non-target-day-added", detail: day }); else if (!eq(bd[day], ad[day])) out.push({ path: c.path, code: "non-target-day-changed", detail: day }); continue; }
    const b = bd[day], a = ad[day];
    if (b === undefined) continue; // a new day holding only target rows (verified below through row ids)
    if (!isObj(b) || !isObj(a)) { out.push({ path: c.path, code: "history-day-shape", detail: day }); continue; }
    const v2 = (d: Record<string, unknown>) => Array.isArray(d.normalMemories) || Array.isArray(d.conversations) || Array.isArray(d.reflections);
    if (v2(b) !== v2(a)) { out.push({ path: c.path, code: "history-day-format-upgraded", detail: day }); continue; }
    if (v2(b)) {
      for (const key of ["conversations", "normalMemories", "reflections"]) {
        const br = (Array.isArray(b[key]) ? b[key] : []) as Record<string, unknown>[], ar = (Array.isArray(a[key]) ? a[key] : []) as Record<string, unknown>[];
        const nonB = br.filter((r) => isObj(r) && !targets.has(String(r.id))), nonA = ar.filter((r) => isObj(r) && !targets.has(String(r.id)));
        if (!eq(nonB, nonA)) out.push({ path: c.path, code: "non-target-history-row-changed", detail: `${day} ${key}` });
      }
      for (const k of Object.keys(b)) if (!["conversations", "normalMemories", "reflections"].includes(k) && !eq(b[k], a[k])) out.push({ path: c.path, code: "history-day-field-changed", detail: `${day} ${k}` });
    } else {
      // v1 day: counts/ids only. Non-target ids must be kept; the normal-memory count may only grow by the number of NEW target members
      for (const key of ["conversationIds", "reflectionIds"]) {
        const br = (Array.isArray(b[key]) ? b[key] : []) as string[], ar = (Array.isArray(a[key]) ? a[key] : []) as string[];
        if (!eq(br.filter((i) => !targets.has(i)), ar.filter((i) => !targets.has(i)))) out.push({ path: c.path, code: "non-target-history-row-changed", detail: `${day} ${key}` });
      }
    }
  }
}

function checkHistoryMeta(c: FileChange, ctx: InvariantContext, out: Violation[]) {
  const before = c.before === null ? {} : parseJson(c.before), after = parseJson(c.after);
  if (before === UNPARSABLE || after === UNPARSABLE || !isObj(before) || !isObj(after)) { out.push({ path: c.path, code: "meta-unparsable", detail: "" }); return; }
  if (c.before !== null && c.before !== canonicalJson(before)) out.push({ path: c.path, code: "format-would-change", detail: "history-meta.json is not in canonical formatting" });
  const touchedMonths = new Set(ctx.targetDays.map((d) => d.slice(0, 7)));
  const bm = (isObj(before.months) ? before.months : {}) as Record<string, unknown>, am = (isObj(after.months) ? after.months : {}) as Record<string, unknown>;
  for (const m of new Set([...Object.keys(bm), ...Object.keys(am)])) if (!touchedMonths.has(m) && !eq(bm[m], am[m])) out.push({ path: c.path, code: "non-target-month-aggregate-changed", detail: m });
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (["months", "updatedAt", "totalMemories", "totalConversations"].includes(k)) continue; // bookkeeping recomputed by the writer
    if (!eq(before[k], after[k])) out.push({ path: c.path, code: "meta-field-changed", detail: k });
  }
}

function checkRegistryShard(c: FileChange, ctx: InvariantContext, written: Set<string>, out: Violation[]) {
  const before = c.before === null ? { records: {}, files: {} } : parseJson(c.before), after = parseJson(c.after);
  if (before === UNPARSABLE || after === UNPARSABLE || !isObj(before) || !isObj(after)) { out.push({ path: c.path, code: "registry-unparsable", detail: "" }); return; }
  if (c.before !== null && c.before !== canonicalJson(before)) out.push({ path: c.path, code: "format-would-change", detail: "registry shard is not in canonical formatting" });
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (k !== "records" && k !== "files" && !eq(before[k], after[k])) out.push({ path: c.path, code: "registry-field-changed", detail: k });
  const br = (isObj(before.records) ? before.records : {}) as Record<string, unknown>, ar = (isObj(after.records) ? after.records : {}) as Record<string, unknown>;
  const bf = (isObj(before.files) ? before.files : {}) as Record<string, unknown>, af = (isObj(after.files) ? after.files : {}) as Record<string, unknown>;
  const mine = new Set(ctx.registryKeys);
  for (const k of new Set([...Object.keys(br), ...Object.keys(ar)])) if (!mine.has(k) && !eq(br[k], ar[k])) out.push({ path: c.path, code: "non-target-registry-record-changed", detail: k.slice(-12) });
  const targets = new Set([...ctx.targetConversationIds, ...ctx.targetMemoryIds]);
  for (const p of new Set([...Object.keys(bf), ...Object.keys(af)])) {
    if (!written.has(p)) { if (!eq(bf[p], af[p])) out.push({ path: c.path, code: "non-target-registry-file-changed", detail: p }); continue; }
    const b = bf[p], a = af[p];
    if (b === undefined || !isObj(b) || !isObj(a)) continue; // newly registered file of a target
    const bIds = (Array.isArray(b.memberIds) ? b.memberIds : []) as string[], aIds = (Array.isArray(a.memberIds) ? a.memberIds : []) as string[];
    for (const id of bIds) if (!aIds.includes(id)) out.push({ path: c.path, code: "registry-member-removed", detail: String(id).slice(-6) });
    for (const id of aIds) if (!bIds.includes(id) && !targets.has(id)) out.push({ path: c.path, code: "registry-non-target-member-added", detail: String(id).slice(-6) });
    const bh = (isObj(b.memberHashes) ? b.memberHashes : {}) as Record<string, unknown>, ah = (isObj(a.memberHashes) ? a.memberHashes : {}) as Record<string, unknown>;
    for (const id of Object.keys(bh)) if (!targets.has(id) && bh[id] !== ah[id]) out.push({ path: c.path, code: "registry-non-target-member-hash-changed", detail: id.slice(-6) });
  }
}

function checkConversationFile(c: FileChange, ctx: InvariantContext, out: Violation[]) {
  const a = parseConversationMarkdown(c.after);
  if (!a || !ctx.targetConversationIds.includes(a.id)) { out.push({ path: c.path, code: "non-target-conversation-file-changed", detail: "" }); return; }
  if (c.before !== null) { const b = parseConversationMarkdown(c.before); if (!b || b.id !== a.id) out.push({ path: c.path, code: "conversation-file-identity-changed", detail: "" }); }
}

/** Path classification + all invariants. A path outside the known shared/target files is itself a violation. */
export function checkVaultInvariants(changes: FileChange[], ctx: InvariantContext): Violation[] {
  const out: Violation[] = [];
  const written = new Set(changes.map((c) => c.path));
  for (const c of changes) {
    if (c.path === ".tsumugi/index.json") checkIndex(c, ctx, out);
    else if (/^Memories\/[^/]+\.md$/.test(c.path)) checkDayFile(c, ctx, out);
    else if (/^\.tsumugi\/history\/\d{4}-\d{2}\.json$/.test(c.path)) checkHistoryMonth(c, ctx, out);
    else if (c.path === ".tsumugi/history-meta.json") checkHistoryMeta(c, ctx, out);
    else if (/^\.tsumugi\/registry\/[0-9a-f]{2}\.json$/.test(c.path)) checkRegistryShard(c, ctx, written, out);
    else if (/^Conversations\/[^/]+\.md$/.test(c.path)) checkConversationFile(c, ctx, out);
    else out.push({ path: c.path, code: "unexpected-path", detail: "" });
  }
  return out;
}

/** Expected-vs-actual comparison after the real write. Only the listed bookkeeping fields are ignored (file mtime in the registry, meta updatedAt). */
export function normalizeForActualComparison(path: string, text: string): string {
  if (/^\.tsumugi\/registry\/[0-9a-f]{2}\.json$/.test(path)) {
    const v = parseJson(text);
    if (isObj(v) && isObj(v.files)) { const files: Record<string, unknown> = {}; for (const [p, e] of Object.entries(v.files)) files[p] = isObj(e) ? { ...e, mtime: 0 } : e; return JSON.stringify({ ...v, files }); }
  }
  if (path === ".tsumugi/history-meta.json") { const v = parseJson(text); if (isObj(v)) return JSON.stringify({ ...v, updatedAt: "" }); }
  return text;
}
