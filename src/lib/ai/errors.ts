/**
 * provider非依存に正規化したエラー。種類（AIErrorType）は「ユーザーに伝えるべき
 * 原因と、次に取るべき行動が違うか」で分ける：
 * - "auth"：APIキー・権限の問題
 * - "billing"：プリペイド残高・利用可能額の不足
 * - "rateLimit"：利用上限・レート制限（一時的なもの）
 * - "invalidRequest"：リクエスト内容の問題
 * - "server"：AIサービス側の障害
 * - "network"：通信エラー（HTTP応答が無い失敗）
 * - "other"：上記に分類できないもの
 * route側はこの種類だけを見て、表示文言とHTTPステータスを決める
 * （errorResponse.ts）。上流のエラー本文やAPIキーは、ここにも表示側にも出さない。
 * `status`は上流のHTTPステータス（数値のみ）で、分類の補助とログ用
 * （ログにも本文ではなくこの数値だけを出す）。
 */
export type AIErrorType =
  | "auth"
  | "billing"
  | "rateLimit"
  | "invalidRequest"
  | "server"
  | "network"
  | "other";

const AI_ERROR_TYPES: readonly AIErrorType[] = [
  "auth",
  "billing",
  "rateLimit",
  "invalidRequest",
  "server",
  "network",
  "other",
];

/** クライアントが route の応答本文から種類を復元するときの検証用。 */
export function isAIErrorType(value: unknown): value is AIErrorType {
  return typeof value === "string" && (AI_ERROR_TYPES as readonly string[]).includes(value);
}

export class AIProviderError extends Error {
  readonly type: AIErrorType;
  /** 上流のHTTPステータス（分かっている場合のみ）。表示には使わない。 */
  readonly status?: number;

  constructor(type: AIErrorType, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "AIProviderError";
    this.type = type;
    this.status = options?.status;
  }
}
