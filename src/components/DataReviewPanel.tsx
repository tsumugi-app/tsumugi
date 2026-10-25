"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Tombstone } from "@/lib/db";
import { listIncompleteDeletions } from "@/lib/deleteFlow";
import DataAdvancedPanel from "@/components/DataAdvancedPanel";
import DeleteConversationDialog, { type DeleteRequest } from "@/components/DeleteConversationDialog";

/**
 * 削除の復旧ページ（/data）。通常のユーザー画面からはリンクしない（設定画面には、未完了の削除があるときだけ「削除を完了する」の案内が出る）。
 * 旧URLを直接開いた場合や、古いリンクが残っていた場合のための、最小限の復旧口：途中で止まった削除を完了する／（折りたたみ）同期が止まった項目などの上級者向け操作。
 * 記憶・会話の一覧や、個別の削除操作はない（削除はカレンダーの詳細から、会話単位で行う）。
 */
const BTN = "inline-flex min-h-10 items-center justify-center rounded-full border border-stone-300/70 px-4 py-2 text-sm text-stone-600 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-600/70 dark:text-stone-300 dark:hover:bg-white/10";
const CARD = "flex flex-col gap-2 rounded-2xl border border-stone-300/70 p-3 dark:border-stone-700/70";

export default function DataReviewPanel() {
  const [incomplete, setIncomplete] = useState<Tombstone[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DeleteRequest | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try { setIncomplete(await listIncompleteDeletions()); setLoadError(null); }
    catch (e) { setLoadError("読み込めませんでした: " + ((e as Error)?.name ?? "error")); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load, refreshKey]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-10 text-sm text-stone-700 dark:text-stone-200">
      <header className="sticky top-0 z-10 -mx-4 mb-4 flex items-center gap-3 border-b border-stone-200 bg-[var(--background)] px-4 py-3 dark:border-stone-700">
        <Link href="/" className={BTN} aria-label="トップページへ戻る">← トップへ</Link>
        <h1 className="text-lg font-medium">削除を完了する</h1>
      </header>
      <div className="flex flex-col gap-5">
        {loadError && <p role="alert" className="rounded border border-red-400 px-3 py-2 text-red-700">{loadError}</p>}
        {incomplete.length === 0 ? (
          <p className="text-sm text-stone-500">途中で止まっている削除はありません。記憶と会話の削除は、カレンダーで記憶や会話を開いて行います。</p>
        ) : (
          <section aria-labelledby="incomplete-h" className="flex flex-col gap-3">
            <h2 id="incomplete-h" className="text-base font-medium">削除を完了する必要があります（{incomplete.length}）</h2>
            <p className="text-xs text-stone-500">削除が途中で止まっています。データは安全に保護されていて、削除した記録が戻ることはありません。</p>
            <ul className="flex flex-col gap-2">
              {incomplete.map((t) => {
                const label = `${t.kind === "conversation" ? "会話" : "記憶"} …${t.id.slice(-6)}（${t.deletedAt.slice(0, 10)}に削除）`;
                return (
                  <li key={`${t.kind}:${t.id}`} className={CARD}>
                    <p className="break-words [overflow-wrap:anywhere]">{label}</p>
                    <button className={BTN} onClick={() => setDialog({ type: "continue", tombstone: t, label })}>削除を続ける</button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <details className="rounded-2xl border border-stone-200 p-4 dark:border-stone-700">
          <summary className="cursor-pointer text-sm text-stone-500">詳細な管理（上級者向け）</summary>
          <div className="mt-4"><DataAdvancedPanel refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} /></div>
        </details>
      </div>
      {dialog && <DeleteConversationDialog request={dialog} onClose={(r) => { setDialog(null); if (r.changed) setRefreshKey((k) => k + 1); }} />}
    </div>
  );
}
