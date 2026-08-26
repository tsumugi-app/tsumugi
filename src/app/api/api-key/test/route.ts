import { AIProviderError } from "@/lib/ai/errors";
import { getProvider, resolveApiKey, resolveModel, resolveRequestedProvider } from "@/lib/ai/resolve";

export const runtime = "nodejs";

/**
 * Beta：ユーザーがAPIキー設定画面に入力したキーを、保存する前に検証するためだけの
 * 軽量エンドポイント。/api/chat 等とは違い、会話履歴やMemoryは一切扱わない。
 * 検証に使ったキー自体はレスポンスに含めない・ログに出さない。
 *
 * `X-AI-Provider`が無い場合はGemini（既存クライアントとの後方互換）。
 */
export async function POST(request: Request) {
  const providerName = resolveRequestedProvider(request) ?? "gemini";
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
    console.error("[Tsumugi API Key Test] verification failed:", error);

    if (error instanceof AIProviderError && error.type === "auth") {
      return Response.json(
        { ok: false, error: "APIキーが正しくないか、権限がありません。" },
        { status: 401 }
      );
    }

    if (error instanceof AIProviderError && error.type === "rateLimit") {
      // "insufficient_quota"（OpenAI）は請求設定・利用可能額の問題であり、
      // 時間を置いても自然には解決しない。通常のrate limit（一時的な混雑等）とは
      // メッセージを分ける。AI provider側の型（AIProviderError自体の構造）は
      // 変更せず、元のSDKエラー（error.cause）が持つcodeフィールドをここだけで
      // 直接参照して判定する。
      const cause = error.cause as { code?: string } | undefined;
      const isInsufficientQuota = cause?.code === "insufficient_quota";
      return Response.json(
        {
          ok: false,
          error: isInsufficientQuota
            ? "APIキーの利用上限に達しています。OpenAIアカウントの請求設定や利用可能額をご確認ください。"
            : "APIの利用制限に達しています。しばらく時間を置いて再度お試しください。",
        },
        { status: 429 }
      );
    }

    return Response.json(
      { ok: false, error: "APIへの接続に失敗しました。時間を置いて再度お試しください。" },
      { status: 502 }
    );
  }
}
