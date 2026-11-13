"use client";
/**
 * P1-H 段階1：Context Builderの診断結果（`?debugLog=1`のときだけ）を、このタブのメモリにだけ置く。localStorage・IndexedDB・Vaultへは
 * 保存せず、どこにも送らない。再読み込みで消える。最大MAX_TURNSターン。
 */
import type { ContextBuilderReport } from "./contextBuilder";
import type { ServerDedupeReport } from "./contextDedupe";

const MAX_TURNS = 20;
/** server: 段階2-A, what the server actually took out of the prompt (null when the reduction was OFF) */
const reports = new Map<string, { report: ContextBuilderReport; server: ServerDedupeReport | null }>();

export function rememberContextBuilderReport(turnTimestamp: string, report: ContextBuilderReport, server: ServerDedupeReport | null = null): void {
  reports.delete(turnTimestamp);
  reports.set(turnTimestamp, { report, server });
  while (reports.size > MAX_TURNS) reports.delete(reports.keys().next().value as string);
}

export function contextBuilderReportFor(turnTimestamp: string): { report: ContextBuilderReport; server: ServerDedupeReport | null } | undefined {
  return reports.get(turnTimestamp);
}
