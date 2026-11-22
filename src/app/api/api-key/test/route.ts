import { AIProviderError, type AIErrorType } from "@/lib/ai/errors";
import { apiKeyTestErrorResponse } from "@/lib/ai/errorResponse";
import { getProvider, resolveApiKey, resolveModel, resolveRequestedProvider } from "@/lib/ai/resolve";

export const runtime = "nodejs";

/**
 * Beta：ユーザーがAPIキー設定画面に入力したキーを、保存する前に検証するためだけの
 * 軽量エンドポイント。/api/chat 等とは違い、会話履歴やMemoryは一切扱わない。
 * 検証に使ったキー自体はレスポンスに含めない・ログに出さない。
 * 確かめるAIは`X-AI-Provider`で名指ししたものだけ（名指しが無ければ断る）。
 */
export async function POST(request: Request) {
  const providerName = resolveRequestedProvider(request);
  if (!providerName) return Response.json({ ok: false, error: "利用するAIが指定されていません。" }, { status: 400 });
  const apiKey = resolveApiKey(request, providerName, { allowEnvFallback: false });
  if (!apiKey) {
    return Response.json({ ok: false, error: "APIキーが指定されていません。" }, { status: 400 });
  }

  const provider = getProvider(providerName);

  try {
    await provider.generateText({
      model: resolveModel(providerName),
      apiKey,
      userContent: "こんにちは",
      maxOutputTokens: 16,
      providerOptions: { gemini: { thinkingBudget: 128 } },
    });
    return Response.json({ ok: true });
  } catch (error) {
    // エラー表示改善：/api/chat と同じ分類（adapterの AIErrorType）で、原因が
    // 分かる文言を返す（errorResponse.ts）。「insufficient_quota」（OpenAI）は
    // adapter側で billing に分類されるため、ここで cause を見る必要はない。
    // ログ・応答ともに、種類と上流ステータス（数値）だけを出し、検証に使った
    // キーや上流のエラー本文は一切出さない。
    const kind: AIErrorType = error instanceof AIProviderError ? error.type : "other";
    const upstreamStatus = error instanceof AIProviderError ? error.status : undefined;
    console.error(
      `[Tsumugi API Key Test] verification failed: kind=${kind}${upstreamStatus !== undefined ? ` status=${upstreamStatus}` : ""}`
    );
    const failure = apiKeyTestErrorResponse(kind, providerName);
    return Response.json({ ok: false, error: failure.message, errorKind: kind }, { status: failure.status });
  }
}
