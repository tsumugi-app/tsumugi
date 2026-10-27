import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SynthesisEval from "@/components/SynthesisEval";

/** Memory Synthesis S1 の比較ページ。Preview専用（本番ビルドでは404）。架空データのみ、保存なし。マージ前に削除する。 */
export const metadata: Metadata = { title: "Synthesis比較", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function SynthesisEvalPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <SynthesisEval />;
}
