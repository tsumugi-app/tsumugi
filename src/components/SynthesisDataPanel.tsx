"use client";

import { useState } from "react";
import { synthesisStore } from "@/lib/synthesisStore";

/**
 * Memory Synthesis S1（試験）の端末内データの初期化。一覧・編集は無い（S1の範囲外）。
 * 2つの操作を分ける：Tsumugiの仮説（作り直せる）だけを消す／否定・訂正の記録（ユーザーのデータ）も含めてすべて消す。
 * どちらも、ボタンを押して確認した時だけ動く（ページを開いただけでは何も読まない・消さない）。Memory・Vault・同期には触れない。
 */
type Counts = Awaited<ReturnType<typeof synthesisStore.counts>>;

export default function SynthesisDataPanel() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      setMessage(done);
      setCounts(await synthesisStore.counts());
    } catch (error) {
      setMessage(`できませんでした（${error instanceof Error ? error.message : String(error)}）`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-8 text-sm">
      <h1 className="text-lg font-medium">Synthesis（試験）のデータ</h1>
      <p>この端末だけにある、Tsumugiの仮説と、あなたが否定・訂正した記録です。会話の記録（Memory）や保存先（Vault）には含まれず、ここでの操作もそれらには影響しません。</p>
      <button className="self-start rounded-full border px-4 py-2" disabled={busy} onClick={() => run(async () => undefined, "")}>
        件数を表示
      </button>
      {counts && (
        <p role="status">
          仮説 {counts.hypotheses}件（使用中 {counts.activeHypotheses}件）／否定・訂正の記録 {counts.reactions}件
          {counts.lastSuccessAt ? `／最後の生成 ${new Date(counts.lastSuccessAt).toLocaleString()}` : ""}
        </p>
      )}
      <section className="flex flex-col gap-2 rounded-xl border p-3">
        <h2 className="font-medium">仮説だけを消す</h2>
        <p>Tsumugiの仮説を消します。次に会話を終えたときに、必要なら作り直します。否定・訂正の記録は残るので、否定した見方は作り直されません。</p>
        <button
          className="self-start rounded-full border px-4 py-2"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Tsumugiの仮説を消します。否定・訂正の記録は残ります。よろしいですか？")) void run(() => synthesisStore.clearCache(), "仮説を消しました。");
          }}
        >
          仮説を消す
        </button>
      </section>
      <section className="flex flex-col gap-2 rounded-xl border p-3">
        <h2 className="font-medium">すべて初期化する</h2>
        <p>仮説に加えて、あなたが否定・訂正した記録も消します。消した記録は元に戻せず、以前に否定した見方が再び作られる可能性があります。</p>
        <button
          className="self-start rounded-full border px-4 py-2"
          disabled={busy}
          onClick={() => {
            if (window.confirm("仮説と、否定・訂正の記録をすべて消します。元に戻せません。よろしいですか？")) void run(() => synthesisStore.clearAll(), "Synthesisのデータをすべて消しました。");
          }}
        >
          すべて初期化
        </button>
      </section>
      {message && <p role="status">{message}</p>}
    </main>
  );
}
