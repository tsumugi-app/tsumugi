import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SynthesisEval from "@/components/SynthesisEval";

/**
 * Memory Synthesis Phase 1の比較ページ（Preview専用の一時ページ。本番環境のビルドでは404。通常UIからのリンクは無い）。
 * 架空の長期Memoryだけを使い、IndexedDB・Vault・実データには一切触れない。
 */
export const metadata: Metadata = { title: "Synthesis比較", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function SynthesisEvalPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <SynthesisEval />;
}
