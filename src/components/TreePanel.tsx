"use client";

import { useEffect, useState } from "react";
import { getAllMemoryObjects } from "@/lib/db";
import { StaleVaultTabError, withVaultWorldRead } from "@/lib/vaultWorldLock";
import { computeTreeSignals, computeTreeStage, TREE_STAGE_IMAGE_PATH, TREE_STAGE_MESSAGE, type TreeStage } from "@/lib/tree";

/**
 * 「つむぎの木」を見るための専用Panel（Beta最小実装）。
 * HistoryPanel/SettingsPanel/ImportPanelと同じ、fixed inset-0のフルスクリーン
 * オーバーレイパターン（呼び出し元のChatScreen.tsx側で
 * `<div className="fixed inset-0 z-40"><TreePanel .../></div>`に包んで使う）を踏襲する。
 *
 * 読み取り専用（Vault/Capture/Connect/DBのいずれにも書き込まない）。データ取得は
 * 既存のgetAllMemoryObjects()（IndexedDBのみを見る、既存のdb.ts関数）をそのまま使い、
 * 新しい取得基盤・DB構造は作らない。段階の判定自体は`@/lib/tree`に完全に委譲する
 * （このコンポーネント自身はしきい値を一切持たない）。
 *
 * 表示するのは木の画像1枚と、静かな一文だけ。「Memory 172件」「Link 48件」のような
 * 数字を出すダッシュボード表示は行わない（設計方針）。Link自体も線として描画しない
 * （段階の判定材料として使うだけで、Connect結果そのものは見せない）。
 *
 * 画像アセット（public/tree/配下）は、この実装時点ではまだリポジトリに存在しない
 * （別途デザイン側からの納品が必要）。読み込みに失敗した場合（onError）は、
 * 壊れた画像アイコンを見せず、一文だけの表示にフォールバックする。
 */
export default function TreePanel({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<TreeStage>(0);
  const [imageFailed, setImageFailed] = useState(false);
  /** Vault境界の安全性（H4対応）：別タブでのVault切替により、このタブが古い保存先の
   * ままだと判定された場合。trueの間は木の段階を一切描画しない。 */
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Vault境界の安全性（H4対応）：Memory World読み取りをロック＋epoch確認で包む。
    withVaultWorldRead(() => getAllMemoryObjects())
      .then((memoryObjects) => {
        if (cancelled) return;
        const signals = computeTreeSignals(memoryObjects);
        setStage(computeTreeStage(signals));
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoading(false);
        if (error instanceof StaleVaultTabError) {
          setStale(true);
        } else {
          console.error("Failed to load memory objects for tree", error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const imagePath = stage === 0 ? null : TREE_STAGE_IMAGE_PATH[stage];

  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex w-full items-center justify-between">
          <p className="text-lg text-stone-800 dark:text-stone-100">つむぎの木</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-300/70 px-4 py-1.5 text-xs text-stone-600 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-300 dark:hover:bg-white/5"
          >
            閉じる
          </button>
        </div>

        {stale ? (
          <p className="text-center text-sm text-stone-700 dark:text-stone-300">
            別のタブで保存先が変更されました。再読み込みしてください。
          </p>
        ) : loading ? (
          <p className="text-sm text-stone-400 dark:text-stone-500">読み込んでいます…</p>
        ) : (
          <>
            {imagePath && !imageFailed && (
              <img src={imagePath} alt="" className="w-full max-w-xs" onError={() => setImageFailed(true)} />
            )}
            <p className="text-center text-sm leading-relaxed text-stone-600 dark:text-stone-300">
              {TREE_STAGE_MESSAGE[stage]}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
