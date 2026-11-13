"use client";
/**
 * P1-H 段階1：Context Builderの診断結果（`?debugLog=1`のときだけ）を、このタブのメモリにだけ置く。localStorage・IndexedDB・Vaultへは
 * 保存せず、どこにも送らない。再読み込みで消える。最大MAX_TURNSターン。
 */
import type { ContextBuilderReport } from "./contextBuilder";

const MAX_TURNS = 20;
const reports = new Map<string, ContextBuilderReport>();

export function rememberContextBuilderReport(turnTimestamp: string, report: ContextBuilderReport): void {
  reports.delete(turnTimestamp);
  reports.set(turnTimestamp, report);
  while (reports.size > MAX_TURNS) reports.delete(reports.keys().next().value as string);
}

export function contextBuilderReportFor(turnTimestamp: string): ContextBuilderReport | undefined {
  return reports.get(turnTimestamp);
}
