/**
 * ユーザー自身のAPIキーをクライアントからAPI Routeへ渡すための専用HTTPヘッダー名。
 * クライアント側（fetch呼び出し）とサーバー側（各Route・src/lib/ai/resolve.ts）の
 * 両方から参照する、この用途専用の定数。リクエストボディ・URL・クエリパラメータには
 * APIキーを含めない。
 *
 * `GEMINI_API_KEY_HEADER`は既存のGemini単独運用時から変えていない（後方互換）。
 */
import type { AIProviderName } from "./ai/types";

export const GEMINI_API_KEY_HEADER = "X-Gemini-Api-Key";
export const OPENAI_API_KEY_HEADER = "X-OpenAI-Api-Key";
/** Claudeは今回UIに出さないが、型・構造だけは他providerと揃えておく（未使用）。 */
export const CLAUDE_API_KEY_HEADER = "X-Claude-Api-Key";

export const API_KEY_HEADER_BY_PROVIDER: Record<AIProviderName, string> = {
  gemini: GEMINI_API_KEY_HEADER,
  openai: OPENAI_API_KEY_HEADER,
  claude: CLAUDE_API_KEY_HEADER,
};

/**
 * 利用者が選んだAI（送り先）をサーバーへ伝えるヘッダー。AIを使う全ての要求に付ける。
 * このヘッダーが無い要求は、サーバーが何も送らずに断る（既定のAIは無い）。
 */
export const AI_PROVIDER_HEADER = "X-AI-Provider";

/**
 * 自動の処理（起動時Memory作成とそれに続くConnect・問いかけ生成）が付けるヘッダー。
 * これがある要求には、サーバーは運営側のキーを使わない（src/lib/ai/resolve.ts）。
 * 通常の会話や明示的な会話終了の要求には付けない。
 */
export const USER_KEY_ONLY_HEADER = "X-Tsumugi-User-Key-Only";

/**
 * Beta修正：APIキーをHTTPヘッダー値としてfetch()へ渡す前の検証。
 * ブラウザのFetch API（Headers）はヘッダー値をByteString（ISO-8859-1範囲）としてしか
 * 扱えないため、キーの途中に不可視Unicode文字（ゼロ幅スペース等、copy-paste由来で
 * 混入し得る）や全角文字が含まれていると、fetch()自体がTypeErrorを投げて失敗する
 * （ネットワークには一切到達しない）。
 *
 * ここではキーの値を書き換えたり正規化したりはしない（意味を変えるsanitizeはしない）。
 * 「そのままヘッダーに渡して安全か」を判定するだけの読み取り専用チェックで、
 * printable ASCII（0x20〜0x7E）以外の文字が1つでもあれば不正とみなす。
 * printable ASCIIは ISO-8859-1 の範囲に完全に含まれるため、ByteString制約も同時に満たす。
 * Gemini/OpenAI/Claudeいずれの呼び出し元からも同じ関数を使う（provider別の重複実装をしない）。
 */
export function isSafeApiKeyHeaderValue(key: string): boolean {
  if (!key) return false;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** ヘッダーで送れて、サーバーが「キーあり」と扱える値か。空白だけのキーは、サーバーでは「キーなし」になる。 */
export function isUsableUserKey(key: string | undefined): key is string {
  return !!key?.trim() && isSafeApiKeyHeaderValue(key);
}

/** 自動の処理が、送る瞬間に利用者のキーを確認できなかった。何も送っていないので、運営側のキーも使われていない。 */
export class NoUserKeyError extends Error {
  constructor() { super("no user key"); this.name = "NoUserKeyError"; }
}

/** 送る直前に、利用者の選んだAIが、その処理を始めたときのAIから変わっていた。何も送っていない。 */
export class AiSelectionChangedError extends Error {
  constructor() { super("the selected AI changed"); this.name = "AiSelectionChangedError"; }
}

/**
 * AIへの要求のヘッダー。送り先は利用者が選んだ`provider`だけで、キーもそのAIのものだけを付ける（他のAIのキーは付けない）。
 * `requireUserKey`（自動の処理）：送る直前に読んだ利用者自身のキーがなければ、送らずに止める。サーバーも提供キーを使わない。
 */
export function aiRequestHeaders(provider: AIProviderName, key: string | undefined, requireUserKey = false): Record<string, string> {
  if (requireUserKey) {
    if (!isUsableUserKey(key)) throw new NoUserKeyError();
    return { [AI_PROVIDER_HEADER]: provider, [API_KEY_HEADER_BY_PROVIDER[provider]]: key, [USER_KEY_ONLY_HEADER]: "1" };
  }
  return { [AI_PROVIDER_HEADER]: provider, ...(key ? { [API_KEY_HEADER_BY_PROVIDER[provider]]: key } : {}) };
}
