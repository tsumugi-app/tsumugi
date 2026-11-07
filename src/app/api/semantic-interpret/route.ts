import type { Fact } from "@/lib/factExtraction";
import { resolveApiKey, resolveRequestedProvider } from "@/lib/ai/resolve";
import { interpretFact } from "@/lib/semanticInterpretation";

export const runtime = "nodejs";

/**
 * fact-extractと同じく/api/chatの会話生成とは完全に独立したエンドポイント。
 * ここが失敗しても通常の会話生成には一切影響しない。
 */
export async function POST(request: Request) {
  // 送り先は、利用者が選んで要求が名指ししたAIだけ。名指しが無ければ何も送らない（既定のAIは無い）。
  const providerName = resolveRequestedProvider(request);
  if (!providerName) return Response.json({ error: "利用するAIが指定されていません。" }, { status: 400 });
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) {
    return Response.json({ error: "APIキーが設定されていません。" }, { status: 401 });
  }

  const { fact } = (await request.json()) as { fact: Fact };
  if (!fact || !fact.id || !fact.subject || !fact.evidence || fact.evidence.length === 0) {
    return Response.json({ error: "fact is required" }, { status: 400 });
  }

  try {
    const interpretation = await interpretFact(fact, apiKey, providerName);
    return Response.json({ interpretation });
  } catch (error) {
    console.error("[Tsumugi SemanticInterpretation] failed:", error);
    return Response.json({ error: "Failed to interpret fact." }, { status: 502 });
  }
}
