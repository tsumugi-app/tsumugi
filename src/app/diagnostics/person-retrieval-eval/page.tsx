import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PersonRetrievalEval from "@/components/PersonRetrievalEval";

/** 人物Retrievalの比較ページ。Preview専用（本番ビルドでは404）。架空データのみ、保存なし。マージ前に削除する。 */
export const metadata: Metadata = { title: "人物Retrievalの比較", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function PersonRetrievalEvalPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <PersonRetrievalEval />;
}
