/**
 * provider非依存に正規化したエラー。route側が実際に分岐に使うのは今のところ
 * "auth"（api-key/test/route.tsが401 vs 502を判定するため）だけだが、
 * OpenAI adapter導入に合わせて種類を広げる（既存のGemini adapterは
 * これまで通り"auth"/"other"の2種類しか使わないため、この拡張自体は
 * Geminiの挙動に影響しない）。
 */
export type AIErrorType = "auth" | "rateLimit" | "invalidRequest" | "server" | "other";

export class AIProviderError extends Error {
  readonly type: AIErrorType;

  constructor(type: AIErrorType, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AIProviderError";
    this.type = type;
  }
}
