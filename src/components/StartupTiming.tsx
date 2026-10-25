"use client";

import { useEffect, useRef, useState } from "react";
import { getAllConversations, getAllMemoryObjects, putConversation, putMemoryObject } from "@/lib/db";
import type { Conversation, MemoryObject } from "@/lib/types";
import { LATEST_TEXT, NOT_LATEST_TEXTS, latestShownTooEarly, renderTimingText, runLabel, type TimingRun } from "@/lib/startupTiming";

/**
 * 起動時間の実機計測ページ（Preview専用）。やること：
 *   1. 「架空データを作る」: 架空の会話120件・Memory360件をこの端末のこのPreviewのブラウザ領域へ作る（実データ・本番ドメインとは別の領域）。
 *   2. 「計測して起動」: 画面内の枠でアプリを起動し、起動から「✓ 最新の状態です」が見えるまでの秒数を自動で測る。
 *      1回目＝初回起動（記録をVaultへ書き出す）、2回目以降＝データ変更なしの起動。
 *   3. 「結果をコピー」で結果を貼り付けられる。
 * アプリ本体（ChatScreen等）のコードは変更しない。枠の中の画面を読み取り、設定を開くボタンを押すだけ。
 */
const COUNT = 120;
const RUNS_KEY = "tsumugi-startup-timing-runs";
const TIMEOUT_MS = 240_000;
const BUILD = process.env.NEXT_PUBLIC_APP_BUILD ?? "dev";

function readRuns(): TimingRun[] {
  try { const v = JSON.parse(localStorage.getItem(RUNS_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeRuns(runs: TimingRun[]) { try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)); } catch { /* the page still shows the result */ } }

function fictionalData(): { conversations: Conversation[]; memories: MemoryObject[] } {
  const pad = (n: number) => String(n).padStart(5, "0");
  const jstDay = (offset: number) => new Date(Date.now() + 9 * 3600e3 - offset * 86400e3).toISOString().slice(0, 10);
  const meta = (id: string, T: string) => ({ id: "meta-" + id, source: "ai-capture" as const, sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
  const conversations: Conversation[] = [], memories: MemoryObject[] = [];
  for (let i = 0; i < COUNT; i++) {
    const T = `${jstDay(Math.floor((i * 110) / COUNT))}T0${i % 9}:15:00.000Z`;
    const cid = `perf-conv-${pad(i)}`; const ids: string[] = [];
    const turns = Array.from({ length: 8 }, (_, t) => ({ role: (t % 2 === 0 ? "user" : "ai") as "user" | "ai", content: `架空の発言${i}-${t}。` + "今日はいろいろなことがあって、少し考えごとをしていました。".repeat(2), timestamp: T }));
    for (let m = 0; m < 3; m++) {
      const id = `perf-mem-${pad(i)}-${m}`; ids.push(id);
      memories.push({ id, date: T, types: ["conversation"], conversationId: cid, content: `本文${i}-${m}。` + "出来事の詳しい記録です。".repeat(8), summary: `要約${i}-${m}`, keywords: ["架空", `話題${i % 12}`], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: m > 0 ? [{ id: `perf-l-${pad(i)}-${m}`, sourceId: id, targetId: `perf-mem-${pad(i)}-${m - 1}`, axis: "theme", reason: "r", contrast: false, strength: 0.5, createdBy: "ai-inference", createdAt: T }] : [], evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: meta(id, T) } as unknown as MemoryObject);
    }
    conversations.push({ id: cid, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, turns, memoryObjectIds: ids, metadata: meta(cid, T) } as unknown as Conversation);
  }
  return { conversations, memories };
}

export default function StartupTiming() {
  const [runs, setRuns] = useState<TimingRun[]>([]);
  const [counts, setCounts] = useState<{ c: number; m: number } | null>(null);
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [copyLabel, setCopyLabel] = useState("結果をコピー");
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  async function refreshCounts() {
    try { setCounts({ c: (await getAllConversations()).length, m: (await getAllMemoryObjects()).length }); } catch { setCounts(null); }
  }
  useEffect(() => { setRuns(readRuns()); void refreshCounts(); }, []);

  async function seed() {
    setMessage("架空データを作っています…");
    try {
      const { conversations, memories } = fictionalData();
      for (const c of conversations) await putConversation(c);
      for (const m of memories) await putMemoryObject(m);
      writeRuns([]); setRuns([]);
      await refreshCounts();
      setMessage(`架空データを作りました（会話${COUNT}件・Memory${COUNT * 3}件）。次に「計測して起動」を押してください。`);
    } catch (e) { setMessage("作れませんでした: " + ((e as Error)?.name ?? "error")); }
  }

  function start() {
    if (running) return;
    setRunning(true); setMessage("起動しています。しばらくそのままお待ちください…");
    setFrameKey((k) => k + 1);
  }

  useEffect(() => {
    if (frameKey === 0) return;
    const frame = frameRef.current; if (!frame) return;
    const t0 = performance.now();
    const sec = () => (performance.now() - t0) / 1000;
    const ops = { getFile: 0, write: 0, dirLookups: 0, idbWriteTx: 0, idbWrites: 0 };
    let installed = false, clickedSplash = false, clickedSettings = false, sawChecking = false, tooEarly = false;
    let settingsOpenedSec: number | null = null, latestSec: number | null = null;
    const install = (w: Window & typeof globalThis) => {
      try {
        const wrap = (proto: object, name: string, fn: () => void) => { const o = (proto as Record<string, (...a: unknown[]) => unknown>)[name]; (proto as Record<string, unknown>)[name] = function (this: unknown, ...a: unknown[]) { fn(); return o.apply(this, a); }; };
        wrap(w.FileSystemFileHandle.prototype, "getFile", () => { ops.getFile++; });
        wrap(w.FileSystemFileHandle.prototype, "createWritable", () => { ops.write++; });
        wrap(w.FileSystemDirectoryHandle.prototype, "getFileHandle", () => { ops.dirLookups++; });
        wrap(w.FileSystemDirectoryHandle.prototype, "getDirectoryHandle", () => { ops.dirLookups++; });
        const ot = w.IDBDatabase.prototype.transaction;
        w.IDBDatabase.prototype.transaction = function (this: IDBDatabase, s: string | string[], m?: IDBTransactionMode, o?: IDBTransactionOptions) { if (m === "readwrite") ops.idbWriteTx++; return ot.call(this, s, m, o); } as typeof ot;
        for (const n of ["put", "add", "delete"] as const) wrap(w.IDBObjectStore.prototype, n, () => { ops.idbWrites++; });
        installed = true;
      } catch { /* counts are optional */ }
    };
    const finish = (timedOut: boolean) => {
      window.clearInterval(timer);
      const run: TimingRun = { run: readRuns().length + 1, build: BUILD, latestSec, settingsOpenedSec, sawChecking, latestTooEarly: tooEarly, timedOut, mainThreadOps: installed ? { ...ops } : null };
      const next = [...readRuns(), run]; writeRuns(next); setRuns(next); setRunning(false);
      setMessage(timedOut ? "時間内に「最新の状態です」が表示されませんでした。" : `「${LATEST_TEXT}」まで ${latestSec?.toFixed(1)}秒でした。`);
    };
    const timer = window.setInterval(() => {
      try {
        const w = frame.contentWindow as (Window & typeof globalThis) | null; const doc = frame.contentDocument;
        if (!w || !doc || !doc.body || w.location.href === "about:blank") return;
        if (!installed) install(w);
        const text = doc.body.innerText ?? "";
        if (NOT_LATEST_TEXTS.some((t) => text.includes(t))) sawChecking = true;
        if (latestShownTooEarly(text)) tooEarly = true;
        if (!clickedSplash) { const b = doc.querySelector<HTMLButtonElement>('button[aria-label="tsumugiを開く"]'); if (b) { b.click(); clickedSplash = true; } return; }
        if (!clickedSettings) { const b = doc.querySelector<HTMLButtonElement>('button[aria-label="設定"]'); if (b) { b.click(); clickedSettings = true; settingsOpenedSec = sec(); } return; }
        if (text.includes(LATEST_TEXT)) { latestSec = sec(); finish(false); return; }
        if (performance.now() - t0 > TIMEOUT_MS) finish(true);
      } catch { if (performance.now() - t0 > TIMEOUT_MS) finish(true); }
    }, 25);
    return () => window.clearInterval(timer);
  }, [frameKey]);

  async function copy() {
    try { await navigator.clipboard.writeText(renderTimingText(runs, { userAgent: navigator.userAgent, build: BUILD })); setCopyLabel("コピーしました"); }
    catch { setCopyLabel("コピーできませんでした（下の文字を選択してコピーしてください）"); }
  }

  const BTN = "inline-flex min-h-11 items-center justify-center rounded-full border border-stone-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-stone-600";
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6 text-sm text-stone-800 dark:text-stone-200">
      <h1 className="text-lg font-medium">起動時間の計測（Preview専用）</h1>
      <p className="rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
        架空データだけを使います。実際のデータ・本番とは別のブラウザ領域です。build: {BUILD.slice(0, 7)}
      </p>
      <ol className="list-decimal pl-5 text-xs leading-relaxed text-stone-600 dark:text-stone-400">
        <li>「架空データを作る」（1回だけ）</li>
        <li>「計測して起動」→ 終わるまで待つ。これが<b>初回起動</b>です</li>
        <li>もう一度「計測して起動」（<b>2回目</b>）、さらにもう一度（<b>3回目</b>）</li>
        <li>「結果をコピー」して、そのまま貼り付けて教えてください</li>
      </ol>
      <p className="text-xs">この端末の架空データ: {counts ? `会話${counts.c}件・Memory${counts.m}件` : "（まだありません）"}</p>
      <div className="flex flex-wrap gap-2">
        <button className={BTN} onClick={seed} disabled={running}>架空データを作る</button>
        <button className={BTN} onClick={start} disabled={running || !counts || counts.c === 0}>計測して起動（{runLabel(runs.length + 1)}）</button>
      </div>
      {message && <p role="status">{message}</p>}
      {frameKey > 0 && <iframe key={frameKey} ref={frameRef} src="/" title="Tsumugi" className="h-[480px] w-full rounded-xl border border-stone-300 dark:border-stone-600" />}
      {runs.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">結果</h2>
          <pre className="whitespace-pre-wrap break-words rounded-xl bg-stone-100 p-3 text-xs dark:bg-stone-900">{renderTimingText(runs, { userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent, build: BUILD })}</pre>
          <button className={BTN} onClick={copy}>{copyLabel}</button>
        </section>
      )}
    </main>
  );
}
