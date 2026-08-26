/**
 * Gemini adapter。`@google/genai`を知っているのはこのファイルだけにする
 * （thinkingBudget・Type列挙型・finishReasonの生文字列等、Gemini固有の形は
 * ここで吸収し、route側・他adapterには一切漏らさない）。
 *
 * Phase 1の絶対条件：既存の6つのroute.tsが今まで直接呼んでいたコードと
 * 完全に同じリクエスト・同じ挙動になるようにする（プロンプト・thinkingBudgetの
 * 数値・ストリーミング・エラーメッセージ文言は route側にそのまま残し、
 * ここでは「呼び方」だけを差し替える）。
 */
import { GoogleGenAI, Type } from "@google/genai";
import { AIProviderError } from "../errors";
import type { AISchema } from "../schema";
import type {
  AIProvider,
  AIRequestBase,
  AITurn,
  GenerateStreamRequest,
  GenerateStructuredRequest,
  GenerateStructuredResult,
  GenerateTextRequest,
  GenerateTextResult,
  StreamChunk,
} from "../types";

/** reasoningEffortしか指定されなかった場合のフォールバック。Phase 1では各routeが
 * 必ずproviderOptions.gemini.thinkingBudgetを渡すため、実質使われない。 */
const REASONING_EFFORT_BUDGET: Record<"low" | "medium" | "high", number> = {
  low: 128,
  medium: 384,
  high: 768,
};
const DEFAULT_THINKING_BUDGET = REASONING_EFFORT_BUDGET.medium;

function resolveThinkingBudget(req: AIRequestBase): number {
  const explicit = req.providerOptions?.gemini?.thinkingBudget;
  if (explicit !== undefined) return explicit;
  if (req.reasoningEffort) return REASONING_EFFORT_BUDGET[req.reasoningEffort];
  return DEFAULT_THINKING_BUDGET;
}

function toGeminiRole(role: AITurn["role"]): "user" | "model" {
  return role === "user" ? "user" : "model";
}

/**
 * 共通のconfigフィールドを組み立てる。systemInstructionは、渡されなかった場合
 * （api-key/testのみ）キー自体を含めない。元のコードもこのケースでは
 * `systemInstruction`キーを一切書いていなかったため、configの形を完全に一致させる。
 */
function baseConfig(req: AIRequestBase) {
  return {
    ...(req.systemInstruction ? { systemInstruction: req.systemInstruction } : {}),
    maxOutputTokens: req.maxOutputTokens,
    thinkingConfig: { thinkingBudget: resolveThinkingBudget(req) },
    // enableWebSearchはprovider非依存の要求フラグ（types.ts参照）。Gemini固有の実装詳細
    // （`tools:[{googleSearch:{}}]`という形）はこのファイルの外には一切漏らさない。
    ...(req.enableWebSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };
}

/**
 * provider非依存のAISchemaをGeminiのType列挙型形式へ変換する。
 * propertyOrderingは明示指定をやめ、propertiesのキー順（＝既存route.tsでの
 * 定義順とpropertyOrderingは元々一致していた）から自動生成する。
 */
function toGeminiSchema(schema: AISchema): unknown {
  switch (schema.type) {
    case "object": {
      const keys = Object.keys(schema.properties);
      return {
        type: Type.OBJECT,
        description: schema.description,
        properties: Object.fromEntries(keys.map((key) => [key, toGeminiSchema(schema.properties[key])])),
        required: schema.required,
        propertyOrdering: keys,
      };
    }
    case "array":
      return {
        type: Type.ARRAY,
        description: schema.description,
        items: toGeminiSchema(schema.items),
      };
    case "string":
      return {
        type: Type.STRING,
        description: schema.description,
        enum: schema.enum,
      };
    case "number":
      return { type: Type.NUMBER, description: schema.description };
    case "boolean":
      return { type: Type.BOOLEAN, description: schema.description };
  }
}

/** 既存route.ts（api-key/test）がやっていたstatus判定をそのまま踏襲する。 */
function normalizeError(error: unknown): AIProviderError {
  const status = (error as { status?: number } | undefined)?.status;
  const isAuthError = status === 400 || status === 401 || status === 403;
  const message = error instanceof Error ? error.message : String(error);
  return new AIProviderError(isAuthError ? "auth" : "other", message, { cause: error });
}

async function generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
  const client = new GoogleGenAI({ apiKey: req.apiKey });
  try {
    const response = await client.models.generateContent({
      model: req.model,
      contents: [{ role: "user", parts: [{ text: req.userContent }] }],
      config: baseConfig(req),
    });
    return { text: response.text ?? "" };
  } catch (error) {
    throw normalizeError(error);
  }
}

async function generateStructured(req: GenerateStructuredRequest): Promise<GenerateStructuredResult> {
  const client = new GoogleGenAI({ apiKey: req.apiKey });
  try {
    const response = await client.models.generateContent({
      model: req.model,
      contents: [{ role: "user", parts: [{ text: req.userContent }] }],
      config: {
        ...baseConfig(req),
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(req.schema),
      },
    });
    return { text: response.text ?? "" };
  } catch (error) {
    throw normalizeError(error);
  }
}

async function* mapStream(
  stream: AsyncIterable<{ text?: string; candidates?: { finishReason?: string; groundingMetadata?: { webSearchQueries?: string[] } }[] }>
): AsyncIterable<StreamChunk> {
  // Web検索groundingが実際に発火したかをサーバーログだけで確認できるようにする診断ログ。
  // StreamChunkの型・呼び出し元（route.ts）の挙動は変えない（groundingMetadata自体はUIへ渡さない）。
  // 注意：Gemini API側の既知の制約により、実際に検索が行われてもgroundingMetadataが
  // ストリーミング応答に付与されないことがある。このログが出力されないことは
  // 「検索していない」ことの証明にはならない（2026-08時点の検証で確認済み）。
  let loggedGrounding = false;
  for await (const chunk of stream) {
    const rawFinishReason = chunk.candidates?.[0]?.finishReason;
    const webSearchQueries = chunk.candidates?.[0]?.groundingMetadata?.webSearchQueries;
    if (!loggedGrounding && webSearchQueries && webSearchQueries.length > 0) {
      loggedGrounding = true;
      console.log("[Tsumugi Chat] Google Search grounding used:", webSearchQueries);
    }
    yield {
      text: chunk.text ?? "",
      finishReason: rawFinishReason ? (rawFinishReason === "STOP" ? "stop" : "other") : undefined,
      rawFinishReason,
    };
  }
}

async function generateStream(req: GenerateStreamRequest): Promise<AsyncIterable<StreamChunk>> {
  const client = new GoogleGenAI({ apiKey: req.apiKey });
  try {
    const stream = await client.models.generateContentStream({
      model: req.model,
      contents: req.turns.map((turn) => ({
        role: toGeminiRole(turn.role),
        parts: [{ text: turn.content }],
      })),
      config: {
        ...baseConfig(req),
        abortSignal: req.abortSignal,
      },
    });
    return mapStream(stream);
  } catch (error) {
    throw normalizeError(error);
  }
}

export const geminiProvider: AIProvider = {
  generateText,
  generateStructured,
  generateStream,
};
