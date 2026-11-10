import type { Metadata } from "next";
import PersonSheetDiagnostics from "@/components/PersonSheetDiagnostics";

/**
 * Memory Graph P0（試作）：保存済みMemoryから人物シートを組み立てて見るだけの開発用ページ。
 * Conversation Debug（`?debugLog=1`）のパネルからリンクする。ChatScreen等のアプリ本体をmountしない
 * （起動時のflush・Capture・Connectなどが走らない）。読み込みはボタンを押したときだけ、READ ONLY（`src/lib/personSheetRead.ts`）。
 * AIは呼ばず、何も保存しない。会話のRetrievalには使われない。
 */
export const metadata: Metadata = {
  title: "人物シート（試作）",
  robots: { index: false, follow: false },
};

export default function PersonSheetPage() {
  return <PersonSheetDiagnostics />;
}
