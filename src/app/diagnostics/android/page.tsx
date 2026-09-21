import type { Metadata } from "next";
import AndroidDiagnostics from "@/components/AndroidDiagnostics";

/**
 * Android実機の一時的な診断ページ（URLを直接入力した場合だけ開ける開発用ページ。通常UIからのリンクは無い）。
 * ChatScreen等のアプリ本体をmountしない（起動時のflush・Capture・Connectなどが走らないようにするため）。
 * 診断はボタンを押したときだけ、READ ONLYで行う（`src/lib/androidDiagnostics.ts`）。
 */
export const metadata: Metadata = {
  title: "Android データ診断",
  robots: { index: false, follow: false },
};

export default function AndroidDiagnosticsPage() {
  return <AndroidDiagnostics />;
}
