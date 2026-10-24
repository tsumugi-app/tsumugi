"use client";

import { useState } from "react";
import { runMemoryRepairPrecheck } from "@/lib/memoryRepairPrecheck";
import { parsePrivateRepairData, type PrivateRepairData } from "@/lib/privateRepairData";

/**
 * Developer-only, READ-ONLY pre-flight page for the Memory contamination repair (not linked from any screen).
 * The reviewed repair content is PRIVATE data that is not part of this app: the operator selects the JSON file on their own
 * device (read with FileReader, never uploaded, never stored). Opening the page reads nothing. Only after a valid data file is
 * loaded AND the confirmation word is typed AND the button is pressed does it read IndexedDB (readonly, lib/memoryRepairPrecheck.ts).
 * There is no execute / repair / backfill button, no import of the storage layer or the runner, no network request.
 */
const CONFIRM_WORD = "READ ONLY";
type View = { kind: "idle" } | { kind: "running" } | { kind: "done"; text: string };
type Loaded = { kind: "none" } | { kind: "error"; code: string } | { kind: "ok"; data: PrivateRepairData; counts: { repair: number; updating: number; backfill: number } };

export default function MemoryRepairPrecheck() {
  const [typed, setTyped] = useState("");
  const [loaded, setLoaded] = useState<Loaded>({ kind: "none" });
  const [view, setView] = useState<View>({ kind: "idle" });
  const [copyLabel, setCopyLabel] = useState("結果をコピー");
  const armed = typed.trim() === CONFIRM_WORD && loaded.kind === "ok";

  function accept(raw: string) {
    const parsed = parsePrivateRepairData(raw);
    setView({ kind: "idle" });
    setLoaded(parsed.ok ? { kind: "ok", data: parsed.data, counts: parsed.counts } : { kind: "error", code: parsed.error });
  }
  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => accept(String(reader.result ?? ""));
    reader.onerror = () => setLoaded({ kind: "error", code: "file-read-failed" });
    reader.readAsText(file);
  }
  async function start() {
    if (!armed || loaded.kind !== "ok") return;
    setView({ kind: "running" });
    setCopyLabel("結果をコピー");
    const { text } = await runMemoryRepairPrecheck({ indexedDB: window.indexedDB, build: process.env.NEXT_PUBLIC_APP_BUILD ?? "dev", now: () => new Date().toISOString() }, loaded.data);
    setView({ kind: "done", text });
  }
  async function copy() {
    if (view.kind !== "done") return;
    try { await navigator.clipboard.writeText(view.text); setCopyLabel("コピーしました"); } catch { setCopyLabel("コピーできませんでした（下の文字を選択してコピーしてください）"); }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6 text-sm text-stone-800 dark:text-stone-200">
      <h1 className="text-lg font-medium">Memory修復 事前照合（読み取り専用）</h1>
      <p className="rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
        この診断はデータを変更しません。この端末のIndexedDBを読み取り、あなたが選んだ非公開データファイルの内容と一致するかを表示するだけです。
        修復やBackfillを実行する機能はこのページにありません。ファイルはこの端末内で読み込まれ、サーバーへは送信されず、保存もされません。
        結果には会話・Memoryの本文を出力せず、ID・判定・件数のみ表示します。
      </p>
      <label className="flex flex-col gap-1 text-xs">
        1. 非公開データファイル（JSON）を選択
        <input type="file" accept="application/json,.json" onChange={(e) => onFile(e.target.files?.[0])} className="text-xs" />
      </label>
      {loaded.kind === "ok" && <p className="text-xs">読み込み済み: 修復 {loaded.counts.repair}件 / 更新元 {loaded.counts.updating}件 / Backfill {loaded.counts.backfill}件</p>}
      {loaded.kind === "error" && <p className="text-xs text-red-600">データファイルを読み込めません（{loaded.code}）</p>}
      <label className="flex flex-col gap-1 text-xs">
        2. 「{CONFIRM_WORD}」と入力してください
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="rounded-lg border border-stone-400/60 bg-transparent px-3 py-2 text-sm" />
      </label>
      <button onClick={() => void start()} disabled={!armed || view.kind === "running"} className="rounded-full border border-stone-400/60 px-4 py-2 text-sm transition hover:bg-stone-900/5 disabled:opacity-40 dark:border-stone-500/60 dark:hover:bg-white/5">
        {view.kind === "running" ? "照合しています…" : "READ ONLY照合を開始"}
      </button>
      {view.kind === "done" && (
        <>
          <button onClick={() => void copy()} className="rounded-full border border-stone-400/60 px-4 py-2 text-sm dark:border-stone-500/60">{copyLabel}</button>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-stone-300/60 px-3 py-2 text-xs dark:border-stone-600/60">{view.text}</pre>
        </>
      )}
    </main>
  );
}
