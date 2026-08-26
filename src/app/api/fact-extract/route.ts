import type { ConversationTurn } from "@/lib/types";
import { resolveApiKey, resolveProviderForFeature } from "@/lib/ai/resolve";
import { buildFact, checkSubjectMentions } from "@/lib/factExtraction";

export const runtime = "nodejs";

/**
 * /api/chatの会話生成とは完全に独立したエンドポイント（実装方針の指示通り）。
 * Fact抽出がここで失敗しても、通常の会話生成には一切影響しない。
 */
export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("factExtract");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) {
    return Response.json({ error: "Gemini APIキーが設定されていません。" }, { status: 401 });
  }

  const { subject, turns } = (await request.json()) as {
    subject: string;
    turns: ConversationTurn[];
  };

  if (!subject || !turns || turns.length === 0) {
    return Response.json({ error: "subject and turns are required" }, { status: 400 });
  }

  try {
    const mentions = await checkSubjectMentions(subject, turns, apiKey);
    const fact = buildFact(subject, turns, mentions);
    return Response.json({ mentions, fact });
  } catch (error) {
    console.error("[Tsumugi FactExtract] failed:", error);
    return Response.json({ error: "Failed to extract fact from the AI model." }, { status: 502 });
  }
}
