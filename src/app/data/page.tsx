import type { Metadata } from "next";
import DataReviewPanel from "@/components/DataReviewPanel";
import WipeGate from "@/components/WipeGate";

/**
 * 削除の復旧ページ（直接URLを開いた場合用。通常の画面からはリンクしない）。ChatScreen・Capture・Connect・起動処理を動かさない独立した画面。
 * 未完了の「完全削除」がある場合は、他のどの処理よりも先にそれを完了させる（WipeGate）。
 */
export const metadata: Metadata = { title: "Tsumugi: 削除を完了する", robots: { index: false, follow: false } };

export default function DataPage() {
  return (
    <WipeGate>
      <DataReviewPanel />
    </WipeGate>
  );
}
