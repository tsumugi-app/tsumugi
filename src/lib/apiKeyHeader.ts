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
 * クライアントが「今回どのproviderとして呼び出したいか」をサーバーへ伝えるヘッダー。
 * このヘッダーが無い場合、サーバー側は常にGeminiとして扱う（既存クライアント・
 * chat以外の機能との後方互換のため）。
 */
export const AI_PROVIDER_HEADER = "X-AI-Provider";

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
