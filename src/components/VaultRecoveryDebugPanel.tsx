"use client";
import { useEffect, useRef, useState } from "react";
import type { RecoveryPlan } from "../lib/vaultRecovery";
import { runRecoveryDiagnostic } from "../lib/vaultRecoverySession";

/** Mount does no storage IO. Dedicated route only; no normal application context. */
export default function VaultRecoveryDebugPanel() {
  const [plan, setPlan] = useState<RecoveryPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);

  async function inspect() {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setPlan(null); setFeedback("");
    try {
      const result = await runRecoveryDiagnostic({ factory: indexedDB, storage: navigator.storage,
        locks: navigator.locks, localStorage, userAgent: navigator.userAgent,
        hasDirectoryPicker: "showDirectoryPicker" in window }, abort.signal);
      if (!abort.signal.aborted) setPlan(result);
    } catch {
      if (!abort.signal.aborted) setFeedback("診断できませんでした。既存DB・OPFS・world管理情報を確認できないか、他の処理と競合しています。データの作成・修復は行っていません。他のTsumugiタブを閉じてから再試行してください。");
    } finally {
      if (controller.current === abort) controller.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  async function copy() {
    if (!plan) return;
    try { await navigator.clipboard.writeText(JSON.stringify(plan, null, 2)); setFeedback("JSONをコピーしました"); }
    catch { setFeedback("コピーできませんでした。下のJSONを選択してコピーしてください。"); }
  }
  return <main className="mx-auto max-w-3xl space-y-4 p-4">
    <h1>Vault Recovery Diagnostic</h1>
    <p><strong>READ ONLY</strong> — この画面では記録や保存先を変更しません。復旧処理は実行しません。</p>
    <p>Tsumugiの他のタブ・ホーム画面アプリを閉じてから実行してください。ロックに従わない別画面の処理までは停止できません。</p>
    <p>既存のOPFS保存先専用です。診断結果にはID・path・日時を含みます。結果はこの画面内だけに保持します。</p>
    <button disabled={busy} onClick={() => void inspect()}>{busy ? "診断中…" : "診断開始"}</button>{" "}
    <button disabled={busy || !plan} onClick={() => void copy()}>JSONコピー</button>
    <p role="status">{feedback}</p>
    {plan && <section className="space-y-2">
      <p>対象 {plan.records.length}件 / Markdown {plan.scannedMarkdownCount}件 / 走査 {plan.scanCompleted ? "完了" : "不完全"} / 読取問題 {plan.issues.length}件</p>
      <p>診断時点: {plan.completedAt}（この時点の結果です。自動更新しません）</p>
      {Object.entries(plan.counts).map(([name, count]) => <div key={name}>{name}: {count}</div>)}
      {plan.records.map((record, index) => <details key={`${record.recordType}:${record.recordId}:${index}`}>
        <summary>{record.recordType} / {record.recordId} / {record.classification}</summary>
        <pre className="whitespace-pre-wrap break-all">{JSON.stringify(record, null, 2)}</pre>
      </details>)}
      <textarea aria-label="Vault Recovery Plan JSON" readOnly value={JSON.stringify(plan, null, 2)} className="min-h-72 w-full" />
    </section>}
  </main>;
}
