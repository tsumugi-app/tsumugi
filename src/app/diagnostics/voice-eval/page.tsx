import type { Metadata } from "next";
import { notFound } from "next/navigation";
import VoiceEval from "@/components/VoiceEval";

/** 会話の声（意見・気づき・記憶の使い方）の比較ページ。Preview専用（本番ビルドでは404）。架空データのみ、保存なし。マージ前に削除する。 */
export const metadata: Metadata = { title: "Voice比較", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function VoiceEvalPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <VoiceEval />;
}
