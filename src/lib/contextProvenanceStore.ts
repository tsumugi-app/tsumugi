"use client";
/**
 * P1-F: the per-route provenance of recent chat turns (`?debugLog=1` only), kept in this tab's memory and nowhere else: no localStorage, no IndexedDB,
 * no Vault, nothing sent anywhere. It is gone on reload. At most MAX_TURNS turns.
 */
import type { ContextProvenance, ReflectionTrace } from "./chatContextProvenance";

export interface ContextProvenanceRecord {
  sent: ContextProvenance;
  accepted: ContextProvenance | null;
  reflection: ReflectionTrace | null;
}

const MAX_TURNS = 20;
const records = new Map<string, ContextProvenanceRecord>();

export function rememberContextProvenance(turnTimestamp: string, record: ContextProvenanceRecord): void {
  records.delete(turnTimestamp);
  records.set(turnTimestamp, record);
  while (records.size > MAX_TURNS) records.delete(records.keys().next().value as string);
}

export function contextProvenanceFor(turnTimestamp: string): ContextProvenanceRecord | undefined {
  return records.get(turnTimestamp);
}
