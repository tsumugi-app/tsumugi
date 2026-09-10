/**
 * Recent Conversation Continuity v1（Current Conversation → Recent Conversation Context →
 * Memory Retrieval の3層のうち、真ん中の層）。
 *
 * 目的：Conversationを終了して新しいConversationを開始しても、数分〜数時間前に実際に
 * 話した内容を「さっきの話」「続きなんだけど」のように自然に再開できるようにする。
 * また、明示的な「さっき」が無くても、直前Conversationを理解材料として使えるようにする。
 *
 * このモジュールは純粋関数のみ（副作用なし・ブラウザAPI非依存・"use client"不要）。
 * Conversation配列の取得（getAllConversations）とVault World safety（withVaultWorldRead）は
 * 呼び出し元（ChatScreen.handleSend）の責務。ここは受け取った配列から「直前Conversation」を
 * 選び、/api/chatへ渡す軽量ペイロードへ整形するだけ。
 *
 * v1の設計上の割り切り：
 * - 時間窓は calendar date ではなく elapsed time（endedAt が現在時刻から6時間以内）。
 *   これにより 23:50 Conversation A → 00:10 Conversation B もRecentとして扱える。
 * - 渡すのは末尾6 turnのみ（会話全文は絶対に渡さない）。
 * - Memory summary は Recent Conversation Context へ含めない（v1単体の効果を実測するため。
 *   既存 Memory Retrieval は別経路で従来通り動く）。
 * - DB schema / Vault Markdown は一切変更しない。これは永続スキーマではなく、
 *   1リクエストごとに組み立てて破棄する /api/chat body の optional field。
 */

import type { Conversation, ConversationTurn } from "./types";

/** endedAt が現在時刻からこのミリ秒以内の直前Conversationのみ Recent として扱う（v1: 6時間）。 */
export const RECENT_CONVERSATION_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Recent Conversation として /api/chat へ渡す末尾ターン数の上限（v1: 6）。 */
export const RECENT_CONVERSATION_MAX_TURNS = 6;

/** /api/chat body の optional field `recentConversation` の形（永続スキーマではない）。 */
export interface RecentConversationPayload {
  /** 直前Conversationのid（デバッグログ用。プロンプトには出さない）。 */
  id: string;
  endedAt: string;
  /** 現在時刻から endedAt までの経過ミリ秒（デバッグログ用。プロンプトには出さない）。 */
  elapsedMs: number;
  /** 末尾 RECENT_CONVERSATION_MAX_TURNS 件の逐語ターン（user / assistant 両方）。 */
  turns: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp?: string;
  }>;
}

function parseTimeMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 与えられた全Conversationから「直前Conversation」を1件選ぶ。
 *
 * 条件（すべて満たす）：
 * - 現在開いているConversation（currentConversationId）ではない
 * - endedAt を持つ（終了済み）かつ endedAt がパース可能
 * - turns を1件以上持つ（空会話は除外）
 * - `nowMs - endedAtMs` が 0以上 かつ RECENT_CONVERSATION_WINDOW_MS 以内
 *
 * 複数該当する場合は endedAt が最も新しいものを返す。該当なしなら null。
 */
export function selectRecentConversation(
  allConversations: Conversation[],
  currentConversationId: string,
  nowMs: number
): { conversation: Conversation; elapsedMs: number } | null {
  let best: { conversation: Conversation; elapsedMs: number; endedAtMs: number } | null = null;

  for (const conversation of allConversations) {
    if (conversation.id === currentConversationId) continue;
    if (!conversation.turns || conversation.turns.length === 0) continue;

    const endedAtMs = parseTimeMs(conversation.endedAt);
    if (endedAtMs === null) continue;

    const elapsedMs = nowMs - endedAtMs;
    if (elapsedMs < 0) continue; // 未来のendedAt（時計ずれ等）は採用しない
    if (elapsedMs > RECENT_CONVERSATION_WINDOW_MS) continue;

    if (!best || endedAtMs > best.endedAtMs) {
      best = { conversation, elapsedMs, endedAtMs };
    }
  }

  if (!best) return null;
  return { conversation: best.conversation, elapsedMs: best.elapsedMs };
}

/** ConversationTurn.role（"user" | "ai"）を payload の role（"user" | "assistant"）へ写像する。 */
function toPayloadRole(role: ConversationTurn["role"]): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

/**
 * selectRecentConversation() が返した Conversation を、/api/chat へ渡す軽量ペイロードへ整形する。
 * 末尾 RECENT_CONVERSATION_MAX_TURNS 件だけを取り出す（会話全文は渡さない）。
 */
export function toRecentConversationPayload(
  conversation: Conversation,
  elapsedMs: number
): RecentConversationPayload {
  const tailTurns = conversation.turns.slice(-RECENT_CONVERSATION_MAX_TURNS).map((turn) => ({
    role: toPayloadRole(turn.role),
    content: turn.content,
    ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
  }));

  return {
    id: conversation.id,
    endedAt: conversation.endedAt ?? "",
    elapsedMs,
    turns: tailTurns,
  };
}

/**
 * ChatScreen.handleSend から呼ぶ薄いヘルパー。すでに（withVaultWorldRead 保護下で）取得済みの
 * 全Conversation配列を受け取り、直前Conversationのペイロード（無ければ null）を返す。
 */
export function buildRecentConversationPayload(
  allConversations: Conversation[],
  currentConversationId: string,
  nowMs: number
): RecentConversationPayload | null {
  const selection = selectRecentConversation(allConversations, currentConversationId, nowMs);
  if (!selection) return null;
  return toRecentConversationPayload(selection.conversation, selection.elapsedMs);
}
