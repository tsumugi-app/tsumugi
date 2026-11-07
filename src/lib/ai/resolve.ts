/**
 * Provider差し替えの責務をここに閉じ込める。
 * - 送り先のAIは、要求が`X-AI-Provider`で名指ししたものだけ（利用者が選んだAI）。名指しのない要求に既定のAIは無い
 * - Providerごとの実装（geminiProvider/openaiProvider）の取得
 * - APIキー・モデル名のprovider別解決
 * route.ts側はここの関数だけを使い、`@google/genai`やGemini固有の詳細を知らない。
 */
import { AI_PROVIDER_HEADER, API_KEY_HEADER_BY_PROVIDER, USER_KEY_ONLY_HEADER } from "@/lib/apiKeyHeader";
import { geminiProvider } from "./providers/gemini";
import { openaiProvider } from "./providers/openai";
import type { AIProvider, AIProviderName } from "./types";

export function getProvider(name: AIProviderName): AIProvider {
  switch (name) {
    case "gemini":
      return geminiProvider;
    case "openai":
      return openaiProvider;
    case "claude":
      throw new Error("Claude provider is not implemented yet.");
  }
}

/**
 * Beta提供キー。Geminiを利用AIとして名指しした要求で、利用者自身のキーがないときだけ使う。
 * 他のAIには提供キーが無い（別のAIを選んだ要求が、提供キーのあるAIへ回ることも無い）。
 */
const API_KEY_ENV_FALLBACK: Partial<Record<AIProviderName, string | undefined>> = {
  gemini: process.env.GOOGLE_API_KEY,
};

/**
 * `allowEnvFallback: false`はapi-key/test/route.ts専用（検証中のキー自体を
 * 使わせたいので、サーバーの既定キーへ黙ってフォールバックしてはいけない）。
 * `USER_KEY_ONLY_HEADER`付きの要求（自動の処理）も同じく、運営側のキーを使わない。
 */
export function resolveApiKey(
  request: Request,
  provider: AIProviderName,
  options?: { allowEnvFallback?: boolean }
): string | undefined {
  const headerName = API_KEY_HEADER_BY_PROVIDER[provider];
  const fromHeader = headerName ? request.headers.get(headerName)?.trim() : undefined;
  if (fromHeader) return fromHeader;
  if (options?.allowEnvFallback === false || request.headers.get(USER_KEY_ONLY_HEADER) === "1") return undefined;
  return API_KEY_ENV_FALLBACK[provider] || undefined;
}

/**
 * 要求が`X-AI-Provider`で名指しした、利用者の選んだAI。AIを使う全てのrouteが、これだけで送り先を決める。
 * 名指しが無い・Tsumugiが呼べないAIの場合はundefinedで、routeは何も送らずに断る（暗黙の既定AIは無い）。
 */
export function resolveRequestedProvider(request: Request): AIProviderName | undefined {
  const raw = request.headers.get(AI_PROVIDER_HEADER)?.trim();
  if (raw === "gemini" || raw === "openai") return raw;
  return undefined;
}

const MODEL_ENV: Partial<Record<AIProviderName, string | undefined>> = {
  gemini: process.env.GEMINI_MODEL,
  openai: process.env.OPENAI_MODEL,
};

/** 既定モデルは、環境変数で上書きしない限り使われる最小限のフォールバック1つだけにする。 */
const DEFAULT_MODEL: Partial<Record<AIProviderName, string>> = {
  gemini: "gemini-3.1-flash-lite",
  openai: "gpt-4.1-mini",
};

export function resolveModel(provider: AIProviderName, override?: string): string {
  const model = override ?? MODEL_ENV[provider] ?? DEFAULT_MODEL[provider];
  if (!model) {
    throw new Error(`No default model configured for provider: ${provider}`);
  }
  return model;
}
