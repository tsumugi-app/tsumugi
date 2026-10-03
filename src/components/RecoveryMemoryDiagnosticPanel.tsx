"use client";
import { runExplicitMemoryRepair, runRawHeldMemoryDiagnostic, type NarrowRepairResult } from "../lib/memoryNarrowRepair";
import { useEffect, useRef, useState } from "react";
import type { RecoveryApplyPlan } from "../lib/vaultRecoveryApply";
import { MEMORY_DIAGNOSTIC_MISMATCH, type MemoryDiagnosticResult } from "../lib/recoveryMemoryDiagnostic";

/** Debug-only, existing Plan only. Mount has no IO. A run can be requested once per mount. */
export default function RecoveryMemoryDiagnosticPanel({ plan, root, disabled }: {
  plan: RecoveryApplyPlan | null; root: FileSystemDirectoryHandle; disabled: boolean;
}) {
  const [repair, setRepair] = useState<NarrowRepairResult | null>(null);
  const repairRunning = useRef(false);
  const current = useRef({ active: false });
  const used = useRef(false);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<{ result: MemoryDiagnosticResult; rawHeld: number | null } | null>(null);
  useEffect(() => { const token = { active: true }; current.current = token; return () => { token.active = false; }; }, [plan, root]);
  async function inspect() {
    if (disabled || used.current) return;
    used.current = true; setBusy(true);
    const token = current.current;
    // The screen's plan excludes archived records; the diagnostic rebuilds the raw plan (read only).
    const { diagnostic, rawHeld } = await runRawHeldMemoryDiagnostic(root, () => token.active);
    if (token.active) { setOutput({ result: diagnostic, rawHeld }); setBusy(false); }
  }
  async function repairExplicitly() {
    if (disabled || busy || repairRunning.current) return;
    repairRunning.current = true; setBusy(true);
    try { setRepair(await runExplicitMemoryRepair(root, plan)); }
    catch { setRepair({ status: "held", failure: { phase: "start", code: "unexpected-error" } }); }
    finally { repairRunning.current = false; setBusy(false); }
  }
  const result = output?.result ?? null;
  return <section>
    <p>[D] Memory Recovery診断 — READ ONLY・件数のみ</p>
    <p>他のTsumugiタブと外部エディタを閉じてください。診断ボタンはデータを変更しません。</p>
    <button disabled={disabled || busy || !!output} onClick={() => void inspect()}>現在状態から再構築して読み取り専用で診断</button>
    {output?.rawHeld != null && <p>診断対象（archive除外前）: {output.rawHeld}件</p>}
    <div>
      <p>以下はREAD ONLY診断とは別の、明示実行する限定修復です。全条件を再検証してから変更します。</p>
      <button disabled={disabled || busy || repair?.status === "complete"} onClick={() => void repairExplicitly()}>
        {plan ? "検証済み10件を修復" : "限定修復を再検証して再開"}
      </button>
      {repair && <p>{repair.status === "complete" ? `修復後 held: ${repair.held} / issues: ${repair.issues}` : "修復を完了できませんでした。変更前後の記録を保持して保留しています。"}</p>}
      {repair?.failure && <pre>{[`phase: ${repair.failure.phase}`, `code: ${repair.failure.code}`, repair.failure.recordType && `recordType: ${repair.failure.recordType}`, repair.failure.memoryId && `memoryId: ${repair.failure.memoryId}`, repair.failure.expected && `expected: ${repair.failure.expected}`, repair.failure.actual && `actual: ${repair.failure.actual}`].filter(Boolean).join("\n")}</pre>}
    </div>
    {busy && <p>確認・処理中…</p>}
    {result?.status === "mismatch" && <p>{MEMORY_DIAGNOSTIC_MISMATCH}</p>}
    {result?.status === "unavailable" && <p>読み取りまたは排他確認ができないため中止しました。</p>}
    {result?.status === "complete" && <pre>{JSON.stringify(result, null, 2)}</pre>}
  </section>;
}
