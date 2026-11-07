/**
 * AI Provider抽象化レイヤーの型定義（ARCHITECTURE.md想定の拡張）。
 *
 * 送り先のAIは利用者が選んだ1つで、全ての機能が同じAIを使う（resolve.tsの`resolveRequestedProvider`）。
 * AIを足すときは、providers/に実装を足してresolve.tsとapiKeyHeader.tsに登録するだけで、機能ごとの変更は要らない。
 */
import type { AISchema } from "./schema";

export type AIProviderName = "gemini" | "openai" | "claude";

/**
 * Gemini固有のthinkingBudget等、他Providerには意味を持たない調整値を渡すための
 * 抜け道。Phase 1では各routeがGeminiの既存の数値をそのまま`gemini.thinkingBudget`
 * として渡すことで、reasoningEffortの3段階へ丸めることによる挙動変化を避ける。
 */
export interface AIProviderOptions {
  gemini?: {
    thinkingBudget?: number;
  };
}

export interface AIRequestBase {
  model: string;
  apiKey: string;
  /** api-key/test（検証専用の軽量呼び出し）は元々systemInstructionを渡していないため任意にする。 */
  systemInstruction?: string;
  maxOutputTokens?: number;
  /** 将来のprovider横断的な目安（Phase 1では各adapterのフォールバック用途のみ）。 */
  reasoningEffort?: "low" | "medium" | "high";
  providerOptions?: AIProviderOptions;
  abortSignal?: AbortSignal;
  /**
   * Tsumugi側（route.ts、`needsWebSearch()`の判定結果）が「このターンは現在のWeb情報が
   * 必要」と判断したことを表す、provider非依存の要求フラグ。各providerがこれをどう満たすか
   * （例：Gemini＝Google Search grounding、OpenAI＝Responses API + web_search）は、
   * それぞれのprovider実装内に閉じ込める。route.ts・この型定義にはprovider固有の
   * ツール名・API仕様を一切持ち込まない。
   */
  enableWebSearch?: boolean;
}

export interface GenerateTextRequest extends AIRequestBase {
  userContent: string;
}

export interface GenerateTextResult {
  text: string;
}

export interface GenerateStructuredRequest extends AIRequestBase {
  userContent: string;
  schema: AISchema;
}

export interface GenerateStructuredResult {
  /** JSON文字列のまま返す。パースとエラーメッセージの文言は呼び出し元（route）の責務のまま維持する。 */
  text: string;
}

export type AIChatRole = "user" | "ai";

export interface AITurn {
  role: AIChatRole;
  content: string;
}

export interface GenerateStreamRequest extends AIRequestBase {
  turns: AITurn[];
}

export interface StreamChunk {
  text: string;
  /**
   * provider非依存に正規化した終了理由。他providerが増えた際もroute側はこれだけを
   * 見ればよい。"length"はOpenAI adapter導入で追加した値（トークン上限による打ち切り）。
   * Gemini adapterはこれまで通り"stop"/"other"の2値しか返さない（挙動は変わらない）。
   */
  finishReason?: "stop" | "length" | "other";
  /** ログ用に元の文字列も保持する（Geminiなら"STOP"、OpenAIなら"stop"等）。 */
  rawFinishReason?: string;
}

export interface AIProvider {
  generateText(req: GenerateTextRequest): Promise<GenerateTextResult>;
  generateStructured(req: GenerateStructuredRequest): Promise<GenerateStructuredResult>;
  generateStream(req: GenerateStreamRequest): Promise<AsyncIterable<StreamChunk>>;
}
