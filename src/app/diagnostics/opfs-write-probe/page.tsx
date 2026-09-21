import type { Metadata } from "next";
import OpfsWriteProbe from "@/components/OpfsWriteProbe";

/**
 * OPFS書き込みプローブの一時ページ（URLを直接入力した場合だけ開ける開発用ページ。通常UIからのリンクは無い）。
 * ChatScreen等のアプリ本体をmountしない。プローブはボタンを押したときだけ、専用フォルダで行う
 * （`src/lib/opfsWriteProbe.ts`）。
 */
export const metadata: Metadata = {
  title: "OPFS書き込みプローブ",
  robots: { index: false, follow: false },
};

export default function OpfsWriteProbePage() {
  return <OpfsWriteProbe />;
}
