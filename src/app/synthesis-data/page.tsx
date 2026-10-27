import type { Metadata } from "next";
import SynthesisDataPanel from "@/components/SynthesisDataPanel";
import WipeGate from "@/components/WipeGate";

/**
 * Memory Synthesis S1（試験）の端末内データを初期化するページ（直接URLを開いた場合用。通常の画面からはリンクしない）。
 * ChatScreen・Capture・Connect・起動処理を動かさない独立した画面。Memory・Vault・同期には触れない。
 */
export const metadata: Metadata = { title: "Tsumugi: Synthesisのデータ", robots: { index: false, follow: false } };

export default function SynthesisDataPage() {
  return (
    <WipeGate>
      <SynthesisDataPanel />
    </WipeGate>
  );
}
