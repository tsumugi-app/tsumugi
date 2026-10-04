/**
 * Conversation History（STEP 3）のConversation card／detail表示が必要とする、
 * JSX/DOMに依存しない純粋なロジックだけを集めたモジュール（`HistoryPanel.tsx`から
 * 分離し、`node --test`で検証できるようにする）。
 */
import { isReflectionSummary, truncateHistoryPreview } from "./vault";
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

/**
 * Conversation → Reflection の primary relation（Conversation History v1）。
 * Reflection生成（`handleEndSession`）は、Reflectionの`MemoryObject.id`を`Conversation.memoryObjectIds`へ
 * 追加して保存する。そのIDを直接たどる——選択中の日のレコードや`conversationId`に依存しないため、
 * Reflectionが別の論理日・別のStorage Bucketにあっても関連付く。
 *
 * `memoryObjectIds`には通常MemoryのIDも入る。候補がReflectionであることは`isReflectionSummary`
 * （`metadata.source === "system-generated"`）で必ず確認し、通常MemoryをReflectionとして扱わない。
 * 通常Memoryは日ファイルのため、IDではRegistry entryが引けず、読み取り自体を行わない。
 *
 * Registry entryが無いIDは読まない：`readReflectionById`のfallback読み取りには、Reflectionの生成日（UTC）を
 * 表す日付のヒントが要るが、`Conversation.startedAt`を生成日と仮定してはいけない。その場合は
 * 呼び出し側が既存の`conversationId`による関連付け（fallback）を使う。
 */
export interface ReflectionPrimaryReaders {
  /** そのIDのRegistry entryがあるか（読み取りのみ）。 */
  hasRegistryEntry(id: string): Promise<boolean>;
  /** Registry経由でIDから直接読む（日付のヒントは使わない）。 */
  readById(id: string): Promise<MemoryObject | null>;
}

export async function resolvePrimaryReflection(conversation: Conversation, readers: ReflectionPrimaryReaders): Promise<MemoryObject | null> {
  for (const id of conversation.memoryObjectIds ?? []) {
    try {
      if (!(await readers.hasRegistryEntry(id))) continue;
      const memory = await readers.readById(id);
      if (memory && memory.id === id && isReflectionSummary(memory)) return memory;
    } catch {
      // 1件の読み取り失敗は他の候補・fallbackを妨げない。
    }
  }
  return null;
}

/**
 * 詳細に表示するReflection。primary（`memoryObjectIds`）で解決できた場合だけそれを使い、
 * 解決できなかった場合に限り、既存の`conversationId`による関連付け（fallback）を使う。
 * primaryが「まだ解決中」（undefined）でも、memoryObjectIdsを持つ会話ではfallbackを先に見せない。
 */
export function selectConversationReflection(
  conversation: Conversation,
  primary: MemoryObject | null | undefined,
  fallback: MemoryObject | undefined
): MemoryObject | undefined {
  if (primary) return primary;
  if (primary === undefined && (conversation.memoryObjectIds?.length ?? 0) > 0) return undefined; // primary解決中
  return fallback;
}
