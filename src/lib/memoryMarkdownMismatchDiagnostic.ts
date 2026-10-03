/**
 * READ ONLY diagnostic for the pre-repair guard `link-restored-memory-not-byte-equal-to-vault`.
 * For each Link-conflict Memory it compares, byte for byte:
 *   R = the raw member block in the current Vault day-file (day-file blocks are trimmed, so R is compared with trimmed D/E)
 *   E = the normal serializer applied to the Vault member parsed from R
 *   D = the normal serializer applied to the restored canonical ({...canonical, links, updatedAt from the Vault})
 * and reports WHERE they differ (key / offset / character class), never user text: values are shown only for
 * enum/ID/timestamp keys; everything else is length + first differing offset + character codes.
 * Nothing is written, no plan state is changed, no journal is created.
 */
import type { MemoryObject } from "./types";
import { memoryObjectToMarkdown } from "./markdown";
import { memoryDifferenceFields } from "./recoveryMemoryDiagnostic";
import { parseRecoveryMemoryMarkdown } from "./vaultRecovery";
import { planRecoveryApply, type RecoveryApplyEnv } from "./vaultRecoveryApply";
import { createProductionNarrowRepairEnv } from "./memoryNarrowRepair";
import { runVaultWorldExclusive } from "./vaultWorldLock";

const ENTRY_SEPARATOR = "\n<!-- tsumugi:entry -->\n\n";
/** Keys whose values are enums / IDs / timestamps / numbers (never user text). */
const SAFE_KEYS = new Set(["id", "tsumugi", "date", "types", "conversationId", "topicId", "eventTime", "eventTimePrecision", "source", "sourceType", "aiProvider", "confidence", "schemaVersion", "createdAt", "updatedAt"]);

export type TextDiff = { equal: boolean; lengthA: number; lengthB: number; firstDiffAt: number | null; codeA: number | null; codeB: number | null };
export type KeyDiff = { key: string; kind: "only-in-D" | "only-in-E" | "value-differs"; d?: string; e?: string; diff?: TextDiff };
export type MemoryMarkdownDiagnostic = {
  memoryId: string;
  dayFile: { path: string; memberIndex: number; memberCount: number };
  semanticDifferenceFields: string[];
  rawEqualsE: boolean; rawEqualsD: boolean; dEqualsE: boolean;
  keyDifferences: KeyDiff[];
  body: TextDiff;
  rawVsE: TextDiff; rawVsD: TextDiff;
  shape: Record<string, { canonical: string; vault: string }>;
  verdict: "D==E (guard passes)" | "semantically identical, serialization differs" | "semantic difference";
};
export type MarkdownMismatchReport = { rawHeld: number; memories: MemoryMarkdownDiagnostic[] } | { unavailable: string };

function diffText(a: string, b: string): TextDiff {
  let i = 0; const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const equal = a === b;
  return { equal, lengthA: a.length, lengthB: b.length, firstDiffAt: equal ? null : i, codeA: equal || i >= a.length ? null : a.charCodeAt(i), codeB: equal || i >= b.length ? null : b.charCodeAt(i) };
}
function splitMarkdown(text: string): { front: Map<string, string>; body: string } {
  const lines = text.split("\n"), front = new Map<string, string>(); let i = 1;
  for (; i < lines.length && lines[i] !== "---"; i++) { const at = lines[i].indexOf(":"); if (at > 0) front.set(lines[i].slice(0, at), lines[i].slice(at + 1).trimStart()); }
  return { front, body: lines.slice(i + 1).join("\n") };
}
function kind(value: unknown): string {
  if (value === undefined) return "undefined"; if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? `array(${value.length})` : "empty-array";
  if (typeof value === "object") return Object.keys(value as object).length ? "object" : "empty-object";
  return typeof value === "string" ? (value === "" ? "empty-string" : "string") : typeof value;
}
const SHAPE_FIELDS: [string, (m: MemoryObject) => unknown][] = [
  ["conversationId", m => m.conversationId], ["topicId", m => m.topicId], ["eventTime", m => m.eventTime], ["eventTimePrecision", m => m.eventTimePrecision],
  ["metadata.sourceType", m => m.metadata.sourceType], ["metadata.sourceDetail", m => m.metadata.sourceDetail], ["metadata.aiProvider", m => m.metadata.aiProvider], ["metadata.confidence", m => m.metadata.confidence],
  ["keywords", m => m.keywords], ["profileClaims", m => m.profileClaims], ["personMentions", m => m.personMentions], ["topicEvents", m => m.topicEvents], ["evidenceQuotes", m => m.evidenceQuotes], ["revisitPrompt", m => m.revisitPrompt],
];

/** Pure core: compares one Memory given its canonical form and the raw Vault member block. */
export function diagnoseMemoryMarkdown(before: MemoryObject, vault: MemoryObject, rawBlock: string, location: MemoryMarkdownDiagnostic["dayFile"]): MemoryMarkdownDiagnostic {
  const after: MemoryObject = { ...before, links: vault.links, updatedAt: vault.updatedAt };
  const D = memoryObjectToMarkdown(after), E = memoryObjectToMarkdown(vault), R = rawBlock;
  const d = splitMarkdown(D), e = splitMarkdown(E), keyDifferences: KeyDiff[] = [];
  for (const key of new Set([...d.front.keys(), ...e.front.keys()])) {
    const dv = d.front.get(key), ev = e.front.get(key);
    if (dv === ev) continue;
    const safe = SAFE_KEYS.has(key);
    keyDifferences.push(dv === undefined ? { key, kind: "only-in-E", ...(safe ? { e: ev } : {}) } : ev === undefined ? { key, kind: "only-in-D", ...(safe ? { d: dv } : {}) }
      : { key, kind: "value-differs", ...(safe ? { d: dv, e: ev } : { diff: diffText(dv, ev) }) });
  }
  const semantic = memoryDifferenceFields(before, vault).filter(f => f !== "links" && f !== "updatedAt");
  const shape: MemoryMarkdownDiagnostic["shape"] = {};
  for (const [name, get] of SHAPE_FIELDS) shape[name] = { canonical: kind(get(before)), vault: kind(get(vault)) };
  return {
    memoryId: before.id, dayFile: location, semanticDifferenceFields: semantic, rawEqualsE: R === E.trim(), rawEqualsD: R === D.trim(), dEqualsE: D === E, keyDifferences,
    body: diffText(d.body, e.body), rawVsE: diffText(R, E.trim()), rawVsD: diffText(R, D.trim()), shape,
    verdict: D === E ? "D==E (guard passes)" : semantic.length === 0 && memoryDifferenceFields(after, vault).length === 0 ? "semantically identical, serialization differs" : "semantic difference",
  };
}

export async function runMarkdownMismatchDiagnostic(apply: RecoveryApplyEnv, read: (path: string) => Promise<{ raw: string }>): Promise<MarkdownMismatchReport> {
  try {
    const plan = await planRecoveryApply(apply);
    const memories: MemoryMarkdownDiagnostic[] = [];
    for (const held of plan.held.filter(h => h.recordType === "memory" && h.reason === "conflict")) {
      const record = plan.plan.records.find(r => r.recordType === "memory" && r.recordId === held.recordId);
      const before = plan.snapshot.memories.find(m => m.id === held.recordId);
      if (!record || record.vaultPaths.length !== 1 || !before) continue;
      const path = record.vaultPaths[0], blocks = (await read(path)).raw.split(ENTRY_SEPARATOR).map(x => x.trim()).filter(Boolean);
      const parsed = blocks.map(b => { try { return parseRecoveryMemoryMarkdown(b); } catch { return null; } });
      const index = parsed.findIndex(m => m?.id === held.recordId);
      if (index < 0) continue;
      memories.push(diagnoseMemoryMarkdown(before, parsed[index] as MemoryObject, blocks[index], { path, memberIndex: index, memberCount: blocks.length }));
    }
    return { rawHeld: plan.heldCount, memories };
  } catch { return { unavailable: "diagnostic-failed" }; }
}

/** UI entry: debugLog=1 only, world lock like the repair; READ ONLY. */
export async function runExplicitMarkdownMismatchDiagnostic(root: FileSystemDirectoryHandle, options: { apply?: RecoveryApplyEnv } = {}): Promise<MarkdownMismatchReport> {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("debugLog") !== "1") return { unavailable: "debug-log-not-enabled" };
  const locked = await runVaultWorldExclusive(async () => { const env = createProductionNarrowRepairEnv(root, options.apply); return runMarkdownMismatchDiagnostic(env.apply, env.read); });
  return locked.timedOut || !locked.result ? { unavailable: "world-lock-timed-out" } : locked.result;
}
