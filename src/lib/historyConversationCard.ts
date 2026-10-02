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
 * 決定的な選択ルール（要件7、2026-10-02改訂）：内容が充実している方（keywordsを
 * 持つ・本文が長い）を優先し、最後にcreatedAt降順（最新）で決める。
 * 単純な「最新を採用」ではない理由：STEP 2-Bで冪等性ガード（conversationIdに既存の
 * Reflectionがあれば新規生成しない）を導入する以前のlegacyデータでは、同じ会話に
 * 対して複数回Reflectionが生成され得た。その場合、後から作られた方が必ずしも
 * 内容豊富とは限らない（例：短い/キーワード無しの劣化した複製が、内容の充実した
 * 古いReflectionより後に作られているケース）。これを「最新だから正しい」と仮定して
 * 選ぶと、ユーザーが実際に読んでいた内容の濃いReflectionではなく、タイトルのように
 * 短くkeywordsも無い方が表示されてしまう。
 * 削除・統合は一切行わない——選択されなかった方もVault/IndexedDB上にはそのまま残る。
 */
export function buildReflectionMap(reflections: MemoryObject[]): Map<string, MemoryObject> {
  const map = new Map<string, MemoryObject>();
  for (const reflection of reflections) {
    if (!reflection.conversationId) continue;
    const current = map.get(reflection.conversationId);
    if (!current || isRicherReflection(reflection, current)) {
      map.set(reflection.conversationId, reflection);
    }
  }
  return map;
}

function isRicherReflection(candidate: MemoryObject, current: MemoryObject): boolean {
  const candidateHasKeywords = candidate.keywords.length > 0;
  const currentHasKeywords = current.keywords.length > 0;
  if (candidateHasKeywords !== currentHasKeywords) return candidateHasKeywords;
  if (candidate.content.length !== current.content.length) return candidate.content.length > current.content.length;
  return candidate.createdAt.localeCompare(current.createdAt) > 0;
}
