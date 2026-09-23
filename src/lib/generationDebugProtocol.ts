/**
 * Conversation Debugger v1（開発専用）。
 *
 * `/api/chat`のstreamingレスポンス（`Content-Type: text/plain`）は通常ユーザーには
 * 一切変更しない。`debugGenerationId`がリクエストに含まれた場合（＝クライアントが
 * `?debugLog=1`のときだけ送る）のみ、可視テキストのストリームの直後に
 * `DEBUG_ENVELOPE_DELIMITER`（NUL文字を含む、Gemini出力に実質出現し得ない区切り）と
 * JSON化した`GenerationDebugEnvelope`を追記する。クライアントは`debugGenerationId`を
 * 自分で送った場合だけこの区切りを探し、可視本文から切り離す（通常ユーザーの応答は
 * 一切変わらない）。
 *
 * このファイルは"use client"を持たない中立モジュール（サーバーのroute.tsと、
 * クライアントのChatScreen.tsx／generationDebugLog.tsの両方からimportされる）。
 *
 * 含めないもの（重要）：system prompt本文（persona固定文・共有prompt・Evidence
 * Boundary本文）、API key、その他secret。含めるのはPersonal Model context（Profile／
 * Person View／Topic Timeline／Topic Continuity／Retrieved Memory／Recent
 * Conversation）の、既にクライアント⇄サーバー間で実際にやり取りされている値だけ。
 */
import type { ProfileContext } from "./profile";
import type { PersonView } from "./person";
import type { TopicTimeline } from "./topicEvent";
import type { TopicContinuityMemoryRef } from "./topicContinuity";
import type { RetrievedMemory } from "./types";

export const DEBUG_ENVELOPE_DELIMITER = "\u0000TSUMUGI_DEBUG_ENVELOPE_V1\u0000";

/**
 * 実際にfetch bodyへ入る形（`RecentConversationPayload`／route.tsの
 * `RecentConversationInput`）とそのまま同じ——Debugger専用に要約し直さない。
 */
export interface GenerationDebugRecentConversation {
  id: string;
  endedAt: string;
  elapsedMs: number;
  turns: Array<{ role: "user" | "assistant"; content: string; timestamp?: string }>;
}

export interface GenerationDebugTopicContinuityInput {
  topicId: string;
  memories: TopicContinuityMemoryRef[];
}

/** [Client Sent] / [Server Accepted] 共通の、Personal Model context一式。 */
export interface GenerationDebugContext {
  recentConversation: GenerationDebugRecentConversation | null;
  profile: ProfileContext | null;
  personView: PersonView[] | null;
  topicTimeline: TopicTimeline[] | null;
  topicContinuity: GenerationDebugTopicContinuityInput[] | null;
  retrievedMemory: RetrievedMemory[];
}

/** [Generation]：実際にプロバイダへ渡した値（推測・ミラーではない）。 */
export interface GenerationDebugGeneration {
  persona: string;
  provider: string;
  model: string;
  thinkingBudget: number;
  maxOutputTokens: number;
  searchNeeded: boolean;
}

export interface GenerationDebugEnvelope {
  generationId: string;
  generation: GenerationDebugGeneration;
  /** サーバー側の`sanitize*Context()`通過後、実際にsystemInstructionへ使われた値。 */
  serverAccepted: GenerationDebugContext;
}
