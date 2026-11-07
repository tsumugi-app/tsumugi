import { loadSelectedAi } from "./db";
import { AiSelectionChangedError, aiRequestHeaders } from "./apiKeyHeader";
import type { AIProviderName } from "./ai/types";

export interface AiRequestOptions { provider?: AIProviderName; requireUserKey?: boolean }

/**
 * AIへの要求のヘッダーと送り先のAIを、送る直前に読んだ「利用者が選んだAI」とそのAIのキーで作る。会話以外の全ての機能が使う。
 * `provider`：処理を始めたときのAI。送る直前の選択がそれと違えば、別のAIへは送らずに止める（AiSelectionChangedError）。
 * `requireUserKey`：自動の処理。利用者自身のキーがなければ送らない（NoUserKeyError）。
 */
export async function selectedAiHeaders(options: AiRequestOptions = {}): Promise<{ provider: AIProviderName; headers: Record<string, string> }> {
  const { provider, key } = await loadSelectedAi();
  if (options.provider && options.provider !== provider) throw new AiSelectionChangedError();
  return { provider, headers: aiRequestHeaders(provider, key, options.requireUserKey === true) };
}
