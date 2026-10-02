"use client";
import { useEffect, useRef, useState } from "react";
import type { RecoveryApplyPlan } from "../lib/vaultRecoveryApply";
import { runHeldMemoryDiagnostic, MEMORY_DIAGNOSTIC_MISMATCH, type MemoryDiagnosticResult } from "../lib/recoveryMemoryDiagnostic";

/** Debug-only, existing Plan only. Mount has no IO. A run can be requested once per mount. */
export default function RecoveryMemoryDiagnosticPanel({ plan, root, disabled }: {
  plan: RecoveryApplyPlan; root: FileSystemDirectoryHandle; disabled: boolean;
}) {
  const current = useRef({ active: false });
  const used = useRef(false);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<{ plan: RecoveryApplyPlan; result: MemoryDiagnosticResult } | null>(null);
  useEffect(() => { const token = { active: true }; current.current = token; return () => { token.active = false; }; }, [plan, root]);
  async function inspect() {
    if (disabled || used.current) return;
    used.current = true; setBusy(true);
    const token = current.current;
    const result = await runHeldMemoryDiagnostic(plan, root, () => token.active);
    if (token.active) { setOutput({ plan, result }); setBusy(false); }
  }
  const result = output?.plan === plan ? output.result : null;
  return <section>
    <p>[D] Memory Recovery診断 — READ ONLY・件数のみ</p>
    <p>他のTsumugiタブと外部エディタを閉じてください。整理・復旧は実行しません。</p>
    <button disabled={disabled || busy || !!output} onClick={() => void inspect()}>35件を読み取り専用で診断</button>
    {busy && <p>診断中…</p>}
    {result?.status === "mismatch" && <p>{MEMORY_DIAGNOSTIC_MISMATCH}</p>}
    {result?.status === "unavailable" && <p>読み取りまたは排他確認ができないため中止しました。</p>}
    {result?.status === "complete" && <pre>{JSON.stringify(result, null, 2)}</pre>}
  </section>;
}
