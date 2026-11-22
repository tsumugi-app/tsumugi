/**
 * AIエラーの種類（AIErrorType）から、ユーザーに見せる応答への変換。
 * 文言とステータスはここに一元化する。どの文言にも、上流のエラー本文・
 * APIキー・内部詳細は一切含めない（含めてよいのは種類とHTTPステータスの
 * 数値だけ）。
 *
 * /api/chat の応答本文には文言と一緒に errorKind（種類の安定コード）を
 * 併記し、クライアント（ChatScreen）はステータス番号ではなく種類で
 * 表示を分ける。設定画面のキーテストは route が返す文言をそのまま
 * 表示するため、表面ごとに文言を持つ。
 */
import { isAIErrorType, type AIErrorType } from "./errors";
import type { AIProviderName } from "./types";

/** 会話画面（および /api/chat の応答本文）での、種類ごとの文言。 */
export const CHAT_ERROR_MESSAGES: Record<AIErrorType, string> = {
  auth: "APIキーが無効または期限切れの可能性があります。設定を確認してください。",
  billing:
    "APIのプリペイド残高・利用可能額が不足しています。ご利用のAIサービスの請求・クレジットをご確認ください。",
  rateLimit: "APIの利用上限・レート制限に達しています。しばらく時間を置いてからもう一度お試しください。",
  invalidRequest: "送信内容に問題があり、応答できませんでした。",
  server: "AIサービス側で障害が発生しています。しばらく時間を置いてからもう一度お試しください。",
  network: "通信エラーが発生しました。接続を確認してからもう一度お試しください。",
  other: "メッセージの送信に失敗しました。しばらくしてからもう一度お試しください。",
};

const CHAT_ERROR_STATUSES: Record<AIErrorType, number> = {
  auth: 401,
  billing: 402,
  rateLimit: 429,
  invalidRequest: 400,
  server: 502,
  network: 502,
  other: 502,
};

/** /api/chat が AI 呼び出しの失敗に返す HTTP ステータスと本文の文言。 */
export function chatErrorResponse(kind: AIErrorType): { status: number; message: string } {
  return { status: CHAT_ERROR_STATUSES[kind], message: CHAT_ERROR_MESSAGES[kind] };
}

/** 設定画面の API キーテスト（/api/api-key/test）が失敗に返すステータスと文言。 */
export function apiKeyTestErrorResponse(
  kind: AIErrorType,
  provider: AIProviderName
): { status: number; message: string } {
  switch (kind) {
    case "auth":
      return { status: 401, message: "APIキーが正しくないか、権限がありません。" };
    case "billing":
      return {
        status: 402,
        message:
          provider === "openai"
            ? "APIキーの利用上限に達しています。OpenAIアカウントの請求設定や利用可能額をご確認ください。"
            : "APIのプリペイド残高・利用可能額が不足しています。AI Studioの請求・クレジットをご確認ください。",
      };
    case "rateLimit":
      return { status: 429, message: "APIの利用制限に達しています。しばらく時間を置いて再度お試しください。" };
    case "invalidRequest":
      return { status: 400, message: "リクエストの内容に問題があります。" };
    case "server":
      return { status: 502, message: "AIサービス側で障害が発生しています。時間を置いて再度お試しください。" };
    case "network":
      return { status: 502, message: "APIへの接続に失敗しました。通信環境を確認して再度お試しください。" };
    case "other":
      return { status: 502, message: "APIへの接続に失敗しました。時間を置いて再度お試しください。" };
  }
}

/** 会話画面の送信ステータスのうち、AIエラーの種類に対応するもの。 */
export type ChatSendErrorStatus =
  | "authError"
  | "billingError"
  | "rateLimitError"
  | "invalidRequestError"
  | "serverError"
  | "networkError"
  | "error";

const CHAT_SEND_ERROR_STATUSES: Record<AIErrorType, ChatSendErrorStatus> = {
  auth: "authError",
  billing: "billingError",
  rateLimit: "rateLimitError",
  invalidRequest: "invalidRequestError",
  server: "serverError",
  network: "networkError",
  other: "error",
};

/** AIエラーの種類 → 会話画面の送信ステータス。 */
export function chatSendErrorStatus(kind: AIErrorType): ChatSendErrorStatus {
  return CHAT_SEND_ERROR_STATUSES[kind];
}

/** 会話画面に表示する文言（CHAT_ERROR_MESSAGES と常に一致させる）。 */
export const CHAT_SEND_ERROR_TEXT: Record<ChatSendErrorStatus, string> = {
  authError: CHAT_ERROR_MESSAGES.auth,
  billingError: CHAT_ERROR_MESSAGES.billing,
  rateLimitError: CHAT_ERROR_MESSAGES.rateLimit,
  invalidRequestError: CHAT_ERROR_MESSAGES.invalidRequest,
  serverError: CHAT_ERROR_MESSAGES.server,
  networkError: CHAT_ERROR_MESSAGES.network,
  error: CHAT_ERROR_MESSAGES.other,
};

/**
 * /api/chat のエラー応答（JSON本文とHTTPステータス）から種類を復元する。
 * 本文の errorKind（安定コード）を最優先し、無い場合（旧バージョンの
 * サーバー等）はステータスだけで従来どおり 401→auth、それ以外→other とする。
 */
export function parseChatErrorKind(body: unknown, status: number): AIErrorType {
  const kind = (body as { errorKind?: unknown } | null | undefined)?.errorKind;
  if (isAIErrorType(kind)) return kind;
  return status === 401 ? "auth" : "other";
}
