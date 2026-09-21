"use client";

import { useState } from "react";
import { renderProbeText, runOpfsWriteProbe, PROBE_DIR, type ProbeResult } from "@/lib/opfsWriteProbe";

/**
 * OPFS書き込みプローブの一時ページ（診断専用）。ページを開いただけでは何も書かない・読まない
 * （effect・fetch・保存は一切持たない）。「プローブを実行」を押したときだけ、OPFS root直下の
 * プローブ専用フォルダ（`__tsumugi_write_probe__/`）を作って書き込みを試し、終了時に削除する。
 * Tsumugi本体のVault・IndexedDB・会話・Memory・APIキーには触れない。アプリ本体（ChatScreen）は使わない。
 */
type ViewState = { kind: "idle" } | { kind: "running" } | { kind: "done"; result: ProbeResult; text: string };

export default function OpfsWriteProbe() {
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const [copyLabel, setCopyLabel] = useState("結果をコピー");

  async function start() {
    setState({ kind: "running" });
    setCopyLabel("結果をコピー");
    const result = await runOpfsWriteProbe();
    setState({ kind: "done", result, text: renderProbeText(result) });
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
      <h1 className="text-lg font-medium">OPFS書き込みプローブ</h1>
      <p className="rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
        この端末のブラウザで、Workerによるファイル書き込みが使えるかを確認します。ボタンを押したときだけ、
        端末内の専用フォルダ（{PROBE_DIR}/）にテスト用の小さなファイルを作り、終わったらそのフォルダごと削除します。
        Tsumugiの会話・記憶・設定・APIキー、保存先のデータには触れません。サーバーへは送信しません。
      </p>

      <button
        onClick={() => void start()}
        disabled={state.kind === "running"}
        className="rounded-full border border-stone-400/60 px-4 py-2 text-sm transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:hover:bg-white/5"
      >
        {state.kind === "running" ? "確認しています…" : "プローブを実行"}
      </button>

      {state.kind === "done" && (
        <>
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
