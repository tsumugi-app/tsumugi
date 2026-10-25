import type { Metadata } from "next";
import { notFound } from "next/navigation";
import StartupTiming from "@/components/StartupTiming";

/**
 * 起動時間の実機計測ページ（Preview専用の一時ページ。本番環境のビルドでは404。通常UIからのリンクは無い）。
 * 架空データだけを使い、実データには触れない。計測のたびにアプリ本体を同じ画面内の枠（iframe）で起動する。
 */
export const metadata: Metadata = {
  title: "起動時間の計測",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function StartupTimingPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <StartupTiming />;
}
