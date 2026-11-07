import type { ConversationTurn } from "@/lib/types";
import { resolveApiKey, resolveRequestedProvider } from "@/lib/ai/resolve";
import { buildFact, checkSubjectMentions } from "@/lib/factExtraction";

export const runtime = "nodejs";

/**
 * /api/chatの会話生成とは完全に独立したエンドポイント（実装方針の指示通り）。
 * Fact抽出がここで失敗しても、通常の会話生成には一切影響しない。
 */
export async function POST(request: Request) {
  // 送り先は、利用者が選んで要求が名指ししたAIだけ。名指しが無ければ何も送らない（既定のAIは無い）。
  const providerName = resolveRequestedProvider(request);
  if (!providerName) return Response.json({ error: "利用するAIが指定されていません。" }, { status: 400 });
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) {
    return Response.json({ error: "APIキーが設定されていません。" }, { status: 401 });
  }

  const { subject, turns } = (await request.json()) as {
    subject: string;
    turns: ConversationTurn[];
  };

  if (!subject || !turns || turns.length === 0) {
    return Response.json({ error: "subject and turns are required" }, { status: 400 });
  }

  try {
    const mentions = await checkSubjectMentions(subject, turns, apiKey, providerName);
    const fact = buildFact(subject, turns, mentions);
    return Response.json({ mentions, fact });
  } catch (error) {
    console.error("[Tsumugi FactExtract] failed:", error);
    return Response.json({ error: "Failed to extract fact from the AI model." }, { status: 502 });
  }
}
