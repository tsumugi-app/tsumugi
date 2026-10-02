/**
 * Conversation History（STEP 3）のConversation card／detail表示が必要とする、
 * JSX/DOMに依存しない純粋なロジックだけを集めたモジュール（`HistoryPanel.tsx`から
 * 分離し、`node --test`で検証できるようにする）。
 */
import { truncateHistoryPreview } from "./vault";
import type { Conversation, MemoryObject } from "./types";

/**
 * Conversation.titleが無いlegacy Conversation用の、表示専用fallback（要件4）。
 * 既存データ（turns）だけから決定的に作る——新しいLLM callやtitle生成は行わない。
 * canonicalな`Conversation.title`としては一切保存しない（呼び出し側が表示に使うだけ）。
 * 最初のUser発言を短く示すことを優先し、User発言が無い場合だけ「タイトルなし」にする。
 */
export function fallbackConversationTitle(conversation: Conversation): string {
  const firstUserTurn = conversation.turns.find((turn) => turn.role === "user" && turn.content.trim());
  if (firstUserTurn) return truncateHistoryPreview(firstUserTurn.content.trim());
  return "タイトルなし";
}

/**
 * 同一conversationIdに複数のReflectionが存在するlegacy/異常ケースのための、
 * 決定的な選択ルール（要件7）：最新（createdAt降順）を採用する。
 * 削除・統合は一切行わない——選択されなかった方もVault/IndexedDB上にはそのまま残る。
 */
export function buildReflectionMap(reflections: MemoryObject[]): Map<string, MemoryObject> {
  const sorted = [...reflections].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const map = new Map<string, MemoryObject>();
  for (const reflection of sorted) {
    if (!reflection.conversationId) continue;
    if (!map.has(reflection.conversationId)) map.set(reflection.conversationId, reflection);
  }
  return map;
}
