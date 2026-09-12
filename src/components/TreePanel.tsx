"use client";

import { useEffect, useState } from "react";
import { readHistoryMeta } from "@/lib/vault";
import { computeTreeStage, TREE_STAGE_IMAGE_PATH, TREE_STAGE_MESSAGE, type TreeStage } from "@/lib/tree";

/**
 * 「つむぎの木」を見るための専用Panel（Beta最小実装）。
 * HistoryPanel/SettingsPanel/ImportPanelと同じ、fixed inset-0のフルスクリーン
 * オーバーレイパターン（呼び出し元のChatScreen.tsx側で
 * `<div className="fixed inset-0 z-40"><TreePanel vaultHandle={...} .../></div>`に
 * 包んで使う）を踏襲する。
 *
 * Vault読込方式の再設計（Step 2）：以前はIndexedDBの`getAllMemoryObjects()`全件を
 * 読んで`computeTreeSignals()`を計算していたが、History Index
 * （`.tsumugi/history-meta.json`、`src/lib/vault.ts`のStep 1で追加）の
 * `totalMemories`をそのまま使う方式へ変更した。段階の判定自体は引き続き完全に
 * `@/lib/tree`（`computeTreeStage`）に委譲する（このコンポーネント自身はしきい値を
 * 一切持たない。判定ロジックは無変更）。`vaultHandle`はChatScreen.tsx側の既存Vault
 * stateをそのまま渡してもらうだけで、Vault切替ロジック自体には一切触れない
 * （呼び出し元がVaultを切り替えれば、propが変わるたびにこのeffectが再実行され、
 * 新しいVaultのtotalMemoriesへ自然に切り替わる）。
 *
 * 表示するのは木の画像1枚と、静かな一文だけ。「Memory 172件」「Link 48件」のような
 * 数字を出すダッシュボード表示は行わない（設計方針）。
 *
 * 画像アセット（public/tree/配下）は、この実装時点ではまだリポジトリに存在しない
 * （別途デザイン側からの納品が必要）。読み込みに失敗した場合（onError）は、
 * 壊れた画像アイコンを見せず、一文だけの表示にフォールバックする。
 */
export default function TreePanel({
  onClose,
  vaultHandle,
}: {
  onClose: () => void;
  vaultHandle: FileSystemDirectoryHandle | null;
}) {
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<TreeStage>(0);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!vaultHandle) {
      // 未接続の場合はVaultへのI/O自体を行わず、Stage 0（まだ何も無い）として扱う
      // （旧Vault MarkdownをscanしてTree件数を復元する、という設計にはしない）。
      setStage(computeTreeStage({ memoryCount: 0, linkCount: 0, insightCount: 0 }));
      setLoading(false);
      return;
    }
    // `readHistoryMeta`自体が、history-meta.jsonが存在しない場合・読み込みに失敗した
    // 場合のいずれも安全な既定値（totalMemories: 0等）を返す設計（Step 1、vault.ts側）
    // のため、ここでの`.catch()`は現実的にはほぼ発火しない防御的なものにとどまる。
    readHistoryMeta(vaultHandle)
      .then((meta) => {
        if (cancelled) return;
        setStage(computeTreeStage({ memoryCount: meta.totalMemories, linkCount: 0, insightCount: 0 }));
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load history meta for tree", error);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultHandle]);

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

        {loading ? (
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
