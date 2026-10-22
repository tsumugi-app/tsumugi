import type { Metadata } from "next";
import DataReviewPanel from "@/components/DataReviewPanel";
import WipeGate from "@/components/WipeGate";

/**
 * データの管理（削除・同期が止まった項目の解決・削除済み記録の整理）。ChatScreen・Capture・Connect・起動処理を動かさない独立した画面。
 * 未完了の「完全削除」がある場合は、他のどの処理よりも先にそれを完了させる（WipeGate）。
 */
export const metadata: Metadata = { title: "Tsumugi: データの管理", robots: { index: false, follow: false } };

export default function DataPage() {
  return (
    <WipeGate>
      <DataReviewPanel />
    </WipeGate>
  );
}
