import type { Fact } from "@/lib/factExtraction";
import { resolveApiKey, resolveProviderForFeature } from "@/lib/ai/resolve";
import { interpretFact } from "@/lib/semanticInterpretation";

export const runtime = "nodejs";

/**
 * fact-extractと同じく/api/chatの会話生成とは完全に独立したエンドポイント。
 * ここが失敗しても通常の会話生成には一切影響しない。
 */
export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("semanticInterpret");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) {
    return Response.json({ error: "Gemini APIキーが設定されていません。" }, { status: 401 });
  }

  const { fact } = (await request.json()) as { fact: Fact };
  if (!fact || !fact.id || !fact.subject || !fact.evidence || fact.evidence.length === 0) {
    return Response.json({ error: "fact is required" }, { status: 400 });
  }

  try {
    const interpretation = await interpretFact(fact, apiKey);
    return Response.json({ interpretation });
  } catch (error) {
    console.error("[Tsumugi SemanticInterpretation] failed:", error);
    return Response.json({ error: "Failed to interpret fact." }, { status: 502 });
  }
}
