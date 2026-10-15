/**
 * The real repair / Backfill content (user statements, Memory text, ids) is PRIVATE DATA and is never part of the code.
 * It lives in a JSON file outside Git (`private/…` is git-ignored) that the operator loads by hand in the browser
 * (file picker / paste). This module only defines the shape and a strict validator; it contains no data, does no I/O,
 * and its error messages never echo any of the content it was given.
 */
import type { MemoryType } from "./types";
import type { RepairSpecItem, UpdatingMemorySpec } from "./memoryContaminationRepair";
import type { BackfillSpecItem } from "./memoryBackfill";

export const PRIVATE_DATA_FORMAT = "tsumugi-memory-repair-data";
export interface PrivateRepairData {
  format: typeof PRIVATE_DATA_FORMAT;
  schema: 1;
  repair: { items: RepairSpecItem[]; updating: Record<string, UpdatingMemorySpec> };
  backfill: BackfillSpecItem[];
}
export type ParsedPrivateData = { ok: true; data: PrivateRepairData; counts: { repair: number; updating: number; backfill: number } } | { ok: false; error: string };

const TYPES: MemoryType[] = ["conversation", "diary", "idea", "emotion", "goal", "person", "event", "insight"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string" && v.length > 0;
const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const text = (v: unknown): boolean => isObj(v) && str(v.summary) && str(v.content) && strs(v.keywords) && strs(v.evidence) && Array.isArray(v.types) && v.types.every((t) => TYPES.includes(t as MemoryType));

/** Strict shape check. The error is a fixed code plus a JSON path (field names only, never values). */
export function parsePrivateRepairData(raw: string): ParsedPrivateData {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, error: "not-json" }; }
  if (!isObj(json) || json.format !== PRIVATE_DATA_FORMAT || json.schema !== 1) return { ok: false, error: "wrong-format-or-schema" };
  const repair = json.repair;
  if (!isObj(repair) || !Array.isArray(repair.items) || !isObj(repair.updating) || !Array.isArray(json.backfill)) return { ok: false, error: "missing-sections" };
  const keys = new Set<string>();
  for (const [i, it] of repair.items.entries()) {
    const at = `repair.items[${i}]`;
    if (!isObj(it) || !str(it.key) || !str(it.memoryId) || !str(it.originalConversationId) || !str(it.updatingConversationId)) return { ok: false, error: `${at}:ids` };
    if (keys.has(it.key as string)) return { ok: false, error: `${at}:duplicate-key` };
    keys.add(it.key as string);
    const eb = it.expectedBefore;
    if (!isObj(eb) || !str(eb.summary) || !str(eb.content) || !str(eb.updatedAt)) return { ok: false, error: `${at}:expectedBefore` };
    const r = it.restored;
    if (!text(r) || !isObj(r) || !["keep", "move-to-updating"].includes(r.topicId as string) || typeof r.dropEventTime !== "boolean") return { ok: false, error: `${at}:restored` };
    if (!isObj(it.links) || !Object.values(it.links).every((d) => d === "keep" || d === "remove")) return { ok: false, error: `${at}:links` };
    if (!(it.updatingConversationId as string in repair.updating)) return { ok: false, error: `${at}:updating-missing` };
  }
  for (const [id, u] of Object.entries(repair.updating)) {
    if (!text(u)) return { ok: false, error: `repair.updating[${id.length}-chars-id]:text` };
    const et = (u as Record<string, unknown>).eventTime;
    if (et !== undefined && (!isObj(et) || !str(et.value) || !["day", "month", "year"].includes(et.precision as string))) return { ok: false, error: "repair.updating:eventTime" };
  }
  for (const [i, b] of json.backfill.entries()) {
    const at = `backfill[${i}]`;
    if (!isObj(b) || !str(b.key) || !str(b.conversationId) || !str(b.expectedFirstUserTurn) || !text(b.memory)) return { ok: false, error: `${at}:shape` };
    if (keys.has(b.key as string)) return { ok: false, error: `${at}:duplicate-key` };
    keys.add(b.key as string);
  }
  const data = json as unknown as PrivateRepairData;
  return { ok: true, data, counts: { repair: data.repair.items.length, updating: Object.keys(data.repair.updating).length, backfill: data.backfill.length } };
}
