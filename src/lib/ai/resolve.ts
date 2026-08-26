/**
 * Provider差し替えの責務をここに閉じ込める。
 * - どの機能（AIFeature）がどのProviderを使うか（Phase 1では全てGemini固定）
 * - Providerごとの実装（geminiProvider/openaiProvider）の取得
 * - APIキー・モデル名のprovider別解決
 * route.ts側はここの関数だけを使い、`@google/genai`やGemini固有の詳細を知らない。
 */
import { AI_PROVIDER_HEADER, API_KEY_HEADER_BY_PROVIDER } from "@/lib/apiKeyHeader";
import { geminiProvider } from "./providers/gemini";
import { openaiProvider } from "./providers/openai";
import type { AIFeature, AIProvider, AIProviderName } from "./types";

/**
 * 機能ごとのProvider割り当て。将来的に「creative→OpenAI」のように機能単位で
 * 差し替えられる構造にするための唯一の場所。Phase 1ではユーザー設定・環境変数
 * どちらからも読まず、全機能をGeminiに固定する（既存の挙動を変えないため）。
 */
const FEATURE_PROVIDER: Record<AIFeature, AIProviderName> = {
  diary: "gemini",
  exploration: "gemini",
  creative: "gemini",
  capture: "gemini",
  connect: "gemini",
  reflection: "gemini",
  revisitPrompt: "gemini",
  apiKeyTest: "gemini",
  factExtract: "gemini",
  semanticInterpret: "gemini",
};

export function resolveProviderForFeature(feature: AIFeature): AIProviderName {
  return FEATURE_PROVIDER[feature];
}

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

/** provider別のサーバー環境変数フォールバック。 */
const API_KEY_ENV_FALLBACK: Partial<Record<AIProviderName, string | undefined>> = {
  gemini: process.env.GOOGLE_API_KEY,
  openai: process.env.OPENAI_API_KEY,
};

/**
 * `allowEnvFallback: false`はapi-key/test/route.ts専用（検証中のキー自体を
 * 使わせたいので、サーバーの既定キーへ黙ってフォールバックしてはいけない）。
 */
export function resolveApiKey(
  request: Request,
  provider: AIProviderName,
  options?: { allowEnvFallback?: boolean }
): string | undefined {
  const headerName = API_KEY_HEADER_BY_PROVIDER[provider];
  const fromHeader = headerName ? request.headers.get(headerName)?.trim() : undefined;
  if (fromHeader) return fromHeader;
  if (options?.allowEnvFallback === false) return undefined;
  return API_KEY_ENV_FALLBACK[provider] || undefined;
}

/**
 * クライアントが`X-AI-Provider`ヘッダーで明示的にproviderを指定してきた場合のみ、
 * そのproviderを返す。ヘッダーが無い・不明な値の場合はundefined（＝呼び出し元は
 * 既存のfeatureベースの既定値にフォールバックする＝常にGemini）。
 * 現状これを実際に見るのはchat/route.tsとapi-key/test/route.tsだけであり、
 * capture/connect/reflect/promptはこの関数を呼ばない（＝今回のPhaseでは
 * 引き続きGemini固定のまま）。
 */
export function resolveRequestedProvider(request: Request): AIProviderName | undefined {
  const raw = request.headers.get(AI_PROVIDER_HEADER)?.trim();
  if (raw === "gemini" || raw === "openai" || raw === "claude") return raw;
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
