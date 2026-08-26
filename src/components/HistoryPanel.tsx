"use client";

import { useEffect, useState } from "react";
import { getAllMemoryObjects } from "@/lib/db";
import type { MemoryObject } from "@/lib/types";

type HistoryView = "list" | "detail";

/**
 * 「Tsumugiに話したことが、ちゃんと残っていて、あとから自分で見返せる」という
 * MVPの体験を最小限で成立させるための一覧・詳細UI。SettingsPanel/ImportPanelと
 * 同じfixed inset-0のフルスクリーンオーバーレイパターンを踏襲する。
 *
 * 読み取り専用（Vaultへの書き込みは一切行わない）のため、vaultHandleは受け取らず
 * onCloseだけで完結する。データ取得は既存のgetAllMemoryObjects()をそのまま使い、
 * 新しい取得基盤・検索基盤は作らない。全文検索・キーワード検索・AI検索・
 * Connect結果表示・Source一覧・元Conversationへのドリルダウンは対象外。
 *
 * 日付順のソート・グルーピングは`date`（この記憶が指す時点）を基準にする。
 * `createdAt`/`updatedAt`（Tsumugiがレコードを作成・更新した時刻）とは混同しない。
 */
export default function HistoryPanel({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<HistoryView>("list");
  const [memoryObjects, setMemoryObjects] = useState<MemoryObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MemoryObject | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAllMemoryObjects().then((all) => {
      if (cancelled) return;
      // dateの新しい順。createdAt/updatedAtではなくdate（記憶が指す時点）で並べる。
      const sorted = [...all].sort((a, b) => b.date.localeCompare(a.date));
      setMemoryObjects(sorted);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function openDetail(memory: MemoryObject) {
    setSelected(memory);
    setView("detail");
  }

  function backToList() {
    setSelected(null);
    setView("list");
  }

  // 日付（YYYY-MM-DD）ごとにグルーピングする。既にdate降順なので同じ日付は隣り合っている。
  // markdown.ts/vault.tsが日別ファイル名等に使うdate.slice(0, 10)と同じ切り出し方を踏襲する。
  const groups: { dateLabel: string; items: MemoryObject[] }[] = [];
  for (const memory of memoryObjects) {
    const dateLabel = memory.date.slice(0, 10);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.dateLabel === dateLabel) {
      lastGroup.items.push(memory);
    } else {
      groups.push({ dateLabel, items: [memory] });
    }
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col gap-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <p className="text-lg text-stone-800 dark:text-stone-100">これまでの記憶</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-300/70 px-4 py-1.5 text-xs text-stone-600 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-300 dark:hover:bg-white/5"
          >
            閉じる
          </button>
        </div>

        {view === "list" && (
          <div className="flex flex-col gap-5">
            {loading && <p className="text-sm text-stone-400 dark:text-stone-500">読み込んでいます…</p>}
            {!loading && groups.length === 0 && (
              <p className="text-sm text-stone-400 dark:text-stone-500">まだ記憶がありません。</p>
            )}
            {groups.map((group) => (
              <div key={group.dateLabel} className="flex flex-col gap-2">
                <p className="text-xs text-stone-400 dark:text-stone-500">{group.dateLabel}</p>
                <div className="flex flex-col gap-2">
                  {group.items.map((memory) => (
                    <button
                      key={memory.id}
                      type="button"
                      onClick={() => openDetail(memory)}
                      className="rounded-2xl border border-stone-300/70 px-4 py-3 text-left text-sm text-stone-700 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-300 dark:hover:border-stone-400 dark:hover:bg-stone-900"
                    >
                      {memory.summary}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "detail" && selected && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={backToList}
              className="self-start rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
            >
              戻る
            </button>
            <p className="text-xs text-stone-400 dark:text-stone-500">{selected.date.slice(0, 10)}</p>
            <p className="text-base text-stone-800 dark:text-stone-100">{selected.summary}</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-300">
              {selected.content}
            </p>
            {selected.keywords.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {selected.keywords.map((keyword) => (
                  <span
                    key={keyword}
                    className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 dark:border-stone-600/60 dark:text-stone-400"
                  >
                    {keyword}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
