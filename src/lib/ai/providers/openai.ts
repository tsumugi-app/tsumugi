/**
 * OpenAI adapter。`openai` SDKを知っているのはこのファイルだけにする
 * （Chat Completions APIのメッセージ形式・finish_reasonの生文字列・
 * response_formatの形など、OpenAI固有の詳細はここで吸収し、route側・
 * Gemini adapterには一切漏らさない）。
 *
 * 通常はChat Completions API（`client.chat.completions.create`）を使う。
 * 3パターンとも同じエンドポイントで、`stream`と`response_format`の
 * 有無だけが異なる。
 *
 * `req.enableWebSearch`（provider非依存の要求フラグ、types.ts参照）がtrueの場合のみ、
 * `generateStream()`はResponses API（`client.responses.create`）+ `web_search`ツールへ
 * 切り替える。Chat Completions APIの`web_search`はプレビュー専用モデル限定かつ既に
 * 廃止されており、通常モデルでWeb検索を使うにはResponses APIが必要なため
 * （公式ドキュメント: https://developers.openai.com/api/docs/guides/tools-web-search）。
 * Web検索不要時（false/undefined）の既存Chat Completions経路は一切変更しない。
 * generateText/generateStructured（Capture/Connect/Reflection等）はenableWebSearchを
 * 設定されないため、常にChat Completions APIのまま。
 */
import OpenAI, {
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import type { EasyInputMessage, ResponseStreamEvent } from "openai/resources/responses/responses";
import { AIProviderError, type AIErrorType } from "../errors";
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

function toOpenAIRole(role: AITurn["role"]): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

function buildMessages(req: AIRequestBase, userContent: string): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  if (req.systemInstruction) {
    messages.push({ role: "system", content: req.systemInstruction });
  }
  messages.push({ role: "user", content: userContent });
  return messages;
}

/**
 * provider非依存のAISchemaをOpenAIのJSON Schema形式へ変換する。
 * OpenAIの厳格（strict）モードは全プロパティをrequiredにする必要があり、
 * AISchemaの「一部だけ必須」という意味（例：captureのexistingMemoryIdは任意）が
 * 変わってしまう。挙動をGemini版と揃えるため、strictモードは使わず、
 * AISchemaのrequiredをそのまま渡すだけの素直な変換にする。
 */
function toOpenAISchema(schema: AISchema): Record<string, unknown> {
  switch (schema.type) {
    case "object":
      return {
        type: "object",
        description: schema.description,
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => [key, toOpenAISchema(value)])
        ),
        required: schema.required,
      };
    case "array":
      return {
        type: "array",
        description: schema.description,
        items: toOpenAISchema(schema.items),
      };
    case "string":
      return { type: "string", description: schema.description, enum: schema.enum };
    case "number":
      return { type: "number", description: schema.description };
    case "boolean":
      return { type: "boolean", description: schema.description };
  }
}

function normalizeError(error: unknown): AIProviderError {
  const message = error instanceof Error ? error.message : String(error);
  let type: AIErrorType = "other";
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    type = "auth";
  } else if (error instanceof RateLimitError) {
    type = "rateLimit";
  } else if (
    error instanceof BadRequestError ||
    error instanceof NotFoundError ||
    error instanceof UnprocessableEntityError
  ) {
    type = "invalidRequest";
  } else if (error instanceof InternalServerError) {
    type = "server";
  }
  return new AIProviderError(type, message, { cause: error });
}

function normalizeFinishReason(reason: string | null | undefined): StreamChunk["finishReason"] {
  if (!reason) return undefined;
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "other";
}

async function generateText(req: GenerateTextRequest): Promise<GenerateTextResult> {
  const client = new OpenAI({ apiKey: req.apiKey });
  try {
    const response = await client.chat.completions.create({
      model: req.model,
      messages: buildMessages(req, req.userContent),
      max_completion_tokens: req.maxOutputTokens,
    });
    return { text: response.choices[0]?.message?.content ?? "" };
  } catch (error) {
    throw normalizeError(error);
  }
}

async function generateStructured(req: GenerateStructuredRequest): Promise<GenerateStructuredResult> {
  const client = new OpenAI({ apiKey: req.apiKey });
  try {
    const response = await client.chat.completions.create({
      model: req.model,
      messages: buildMessages(req, req.userContent),
      max_completion_tokens: req.maxOutputTokens,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: toOpenAISchema(req.schema),
        },
      },
    });
    return { text: response.choices[0]?.message?.content ?? "" };
  } catch (error) {
    throw normalizeError(error);
  }
}

async function* mapStream(stream: AsyncIterable<ChatCompletionChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const rawFinishReason = choice?.finish_reason;
    yield {
      text: choice?.delta?.content ?? "",
      finishReason: normalizeFinishReason(rawFinishReason),
      rawFinishReason: rawFinishReason ?? undefined,
    };
  }
}

async function generateStreamViaChatCompletions(req: GenerateStreamRequest): Promise<AsyncIterable<StreamChunk>> {
  const client = new OpenAI({ apiKey: req.apiKey });
  try {
    const messages: ChatCompletionMessageParam[] = [];
    if (req.systemInstruction) {
      messages.push({ role: "system", content: req.systemInstruction });
    }
    for (const turn of req.turns) {
      messages.push({ role: toOpenAIRole(turn.role), content: turn.content });
    }
    const stream = await client.chat.completions.create(
      {
        model: req.model,
        messages,
        max_completion_tokens: req.maxOutputTokens,
        stream: true,
      },
      { signal: req.abortSignal }
    );
    return mapStream(stream);
  } catch (error) {
    throw normalizeError(error);
  }
}

/**
 * Responses APIのstreamingイベントを、Chat Completions版と同じStreamChunk形へ変換する。
 * `response.output_text.delta`だけを本文として扱い、`web_search_call`の進捗イベント・
 * reasoning等、StreamChunkに関係の無いイベント種別は無視する（route側には一切漏らさない）。
 * 検索結果のURL・タイトル等（citation/annotation）も今回は一切読み取らない
 * （Source保存は今回のスコープ外のため）。
 */
async function* mapResponsesStream(stream: AsyncIterable<ResponseStreamEvent>): AsyncIterable<StreamChunk> {
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      yield { text: event.delta };
      continue;
    }
    if (event.type === "response.completed") {
      yield { text: "", finishReason: "stop", rawFinishReason: event.type };
      continue;
    }
    if (event.type === "response.failed" || event.type === "response.incomplete") {
      yield { text: "", finishReason: "other", rawFinishReason: event.type };
      continue;
    }
  }
}

/**
 * `req.enableWebSearch`がtrueの場合だけ通る経路。Chat Completions版と同じ
 * `systemInstruction`+`turns`をResponses APIの`instructions`+`input`へ組み替えるだけで、
 * プロンプトの内容自体（Tsumugi Layer側の指示文）は一切変更しない。
 */
async function generateStreamWithWebSearch(req: GenerateStreamRequest): Promise<AsyncIterable<StreamChunk>> {
  const client = new OpenAI({ apiKey: req.apiKey });
  try {
    const input: EasyInputMessage[] = req.turns.map((turn) => ({
      role: toOpenAIRole(turn.role),
      content: turn.content,
    }));
    const stream = await client.responses.create(
      {
        model: req.model,
        instructions: req.systemInstruction,
        input,
        tools: [{ type: "web_search" }],
        max_output_tokens: req.maxOutputTokens,
        stream: true,
      },
      { signal: req.abortSignal }
    );
    return mapResponsesStream(stream);
  } catch (error) {
    throw normalizeError(error);
  }
}

async function generateStream(req: GenerateStreamRequest): Promise<AsyncIterable<StreamChunk>> {
  return req.enableWebSearch ? generateStreamWithWebSearch(req) : generateStreamViaChatCompletions(req);
}

export const openaiProvider: AIProvider = {
  generateText,
  generateStructured,
  generateStream,
};
