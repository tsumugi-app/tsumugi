"use client";

import { useState } from "react";
import { renderReportText, runAndroidDiagnostics, type DiagnosticsReport } from "@/lib/androidDiagnostics";

/**
 * Android実機の診断ページ（一時的な、診断専用）。ページを開いただけでは何も読まない（副作用のあるhook・
 * effectは一切持たない）。「READ ONLY診断を開始」を押したときだけ、`runAndroidDiagnostics`
 * （IndexedDB・OPFSの読み取りのみ）を実行する。結果は画面表示とクリップボードへのコピーだけで、
 * サーバーへ送信せず、localStorage等へも保存しない。アプリ本体のデータ層・ChatScreenは使わない。
 */
type ViewState = { kind: "idle" } | { kind: "running" } | { kind: "done"; report: DiagnosticsReport; text: string };

const LEVEL_LABEL: Record<DiagnosticsReport["verdict"]["level"], string> = {
  A: "A：OPFSに無いMemoryがIndexedDBにあります",
  B: "B：関連する内容がIndexedDBのみのMemoryにあります",
  C: "C：旧Memory残存仮説は確認できません",
  undetermined: "断定できません",
};

export default function AndroidDiagnostics() {
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const [copyLabel, setCopyLabel] = useState("結果をコピー");

  async function start() {
    setState({ kind: "running" });
    setCopyLabel("結果をコピー");
    const report = await runAndroidDiagnostics();
    setState({ kind: "done", report, text: renderReportText(report) });
  }

  async function copy() {
    if (state.kind !== "done") return;
    try {
      await navigator.clipboard.writeText(state.text);
      setCopyLabel("コピーしました");
    } catch {
      setCopyLabel("コピーできませんでした（下の文字を選択してコピーしてください）");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6 text-sm text-stone-800 dark:text-stone-200">
      <h1 className="text-lg font-medium">Android データ診断</h1>
      <p className="rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
        この診断はデータを変更しません。端末内のデータを読み取って、画面に表示するだけです（サーバーへは送信しません）。
      </p>

      <button
        onClick={() => void start()}
        disabled={state.kind === "running"}
        className="rounded-full border border-stone-400/60 px-4 py-2 text-sm transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:hover:bg-white/5"
      >
        {state.kind === "running" ? "診断しています…" : "READ ONLY診断を開始"}
      </button>

      {state.kind === "done" && (
        <>
          <section className="flex flex-col gap-1 rounded-xl border border-stone-300/60 px-3 py-2 dark:border-stone-600/60">
            <h2 className="font-medium">判定</h2>
            <p>{LEVEL_LABEL[state.report.verdict.level]}</p>
            {state.report.verdict.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {state.report.verdict.details.map((line) => (
              <p key={line} className="text-xs text-stone-500 dark:text-stone-400">
                ・{line}
              </p>
            ))}
          </section>

          <section className="flex flex-col gap-1 rounded-xl border border-stone-300/60 px-3 py-2 dark:border-stone-600/60">
            <h2 className="font-medium">診断v2：baseline以降のIDB-only</h2>
            {state.report.v2?.available ? (
              <>
                <p>
                  Memory {state.report.v2.memory.counts.total}件（H1: {state.report.v2.memory.counts.H1} / Registry HOLD:{" "}
                  {state.report.v2.memory.counts.registry} / 直接原因なし: {state.report.v2.memory.counts.unresolved}）
                </p>
                <p>
                  Conversation {state.report.v2.conversation.counts.total}件（H2: {state.report.v2.conversation.counts.H2} / H3候補:{" "}
                  {state.report.v2.conversation.counts.H3} / Registry HOLD: {state.report.v2.conversation.counts.registry} / 原因未解決:{" "}
                  {state.report.v2.conversation.counts.unresolved}）
                </p>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  該当なしは推測で分類していません（書き込みの失敗などは、データだけでは排除できません）。詳細は下の結果をコピーしてください。
                </p>
              </>
            ) : (
              <p>{state.report.v2?.unavailableReason ?? "算出できませんでした。"}</p>
            )}
          </section>

          <pre className="whitespace-pre-wrap break-all rounded-xl bg-stone-50 px-3 py-2 font-mono text-[11px] leading-relaxed dark:bg-stone-950">
            {state.text}
          </pre>

          <button
            onClick={() => void copy()}
            className="rounded-full border border-stone-400/60 px-4 py-2 text-sm transition hover:bg-stone-900/5 dark:border-stone-500/60 dark:hover:bg-white/5"
          >
            {copyLabel}
          </button>
        </>
      )}
    </main>
  );
}
