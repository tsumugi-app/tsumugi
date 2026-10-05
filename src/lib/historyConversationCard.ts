/**
 * Conversation History（STEP 3）のConversation card／detail表示が必要とする、
 * JSX/DOMに依存しない純粋なロジックだけを集めたモジュール（`HistoryPanel.tsx`から
 * 分離し、`node --test`で検証できるようにする）。
 */
import { isHistoryDayIndexV2, isReflectionSummary, truncateHistoryPreview, type HistoryDayIndex } from "./vault";
import { jstDateOf, jstDateOfUlid } from "./dateModel";
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

/**
 * Historyの見出し（Conversation History v2）。AI生成のtitleは使わず、「自分が何を話し始めたか」をそのまま
 * 目印にする：1) Conversationの最初の role === "user" の本文、2) 取得できない場合だけ既存の`Conversation.title`、
 * 3) それも無ければ既存の最終fallback。保存データは書き換えない（長い場合の短縮は表示側のCSS line clampに任せる）。
 */
export function conversationHeading(conversation: Conversation): string {
  const firstUser = conversation.turns.find((turn) => turn.role === "user" && typeof turn.content === "string" && turn.content.trim());
  if (firstUser) return firstUser.content.trim();
  const title = conversation.title?.trim();
  if (title) return title;
  return fallbackConversationTitle(conversation);
}

/** summaryとcontentが実質同じ（空白の違いだけ）なら、同じ文章を二重に表示しない。 */
export function isEffectivelySameText(a: string, b: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, "");
  return normalize(a) === normalize(b);
}

/**
 * 「会話」Conversationの詳細に出す通常Memory。既存データだけを使う：
 * - `Conversation.memoryObjectIds`のうち、通常Memory（Reflectionでないもの）。Captureが新規Memoryを作るとき
 *   `date: conversation.startedAt`を付けるため（capture.ts）、そのMemoryは`startedAt`のUTC日付の日ファイル
 *   （`Memories/YYYY-MM-DD.md`）にある。その日ファイルを`readDayMembers`（既存の`readMemoriesForDay`）で読み、IDで絞り込む。
 *   Reflection（1レコード1ファイル、`isReflectionSummary`）は必ず除外する。`readReflectionById`は流用しない。
 * - 別のConversationのMemory（`conversationId`が違う）は混ぜない。
 * - `memoryObjectIds`から1件も解決できない旧データだけ、同じ日ファイルから`conversationId`が一致する通常Memoryで補う。
 * - 「今日」のVault書き込み未完了分は、呼び出し側が渡す今回セッションのMemory（既にReact stateにあるもの）で補う。
 * 読み取りのみ。新しい関連付け方式・永続化は無い。
 */
export async function resolveConversationMemories(
  conversation: Conversation,
  readDayMembers: (day: string) => Promise<MemoryObject[]>,
  sessionMemories: MemoryObject[] = []
): Promise<MemoryObject[]> {
  let members: MemoryObject[] = [];
  try {
    members = await readDayMembers(conversation.startedAt.slice(0, 10));
  } catch {
    members = [];
  }
  const pool = new Map<string, MemoryObject>();
  for (const memory of members) pool.set(memory.id, memory);
  for (const memory of sessionMemories) if (!pool.has(memory.id)) pool.set(memory.id, memory);
  const belongs = (memory: MemoryObject) => !isReflectionSummary(memory) && (!memory.conversationId || memory.conversationId === conversation.id);
  const byIds: MemoryObject[] = [];
  for (const id of conversation.memoryObjectIds ?? []) {
    const memory = pool.get(id);
    if (memory && belongs(memory) && !byIds.some((m) => m.id === id)) byIds.push(memory);
  }
  const chosen = byIds.length > 0 ? byIds : [...pool.values()].filter((memory) => !isReflectionSummary(memory) && memory.conversationId === conversation.id);
  return chosen.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Conversationの論理日（JST）。日付一覧（Conversationカード）とカレンダーのドットが同じ基準を使うための共有helper。
 * 本体（`startedAt`）を読み終えていればそのJST日付、未読（History Indexの行だけ）ならULID（生成時刻）から、
 * どちらも失敗した場合はStorage Bucketの日付へfail-softにfallbackする。
 */
export function conversationLogicalDay(id: string, startedAt: string | undefined, bucketDay: string): string {
  const fromStartedAt = startedAt ? jstDateOf(startedAt) : null;
  return fromStartedAt ?? jstDateOfUlid(id) ?? bucketDay;
}

/**
 * カレンダーのドット（Conversation History v2）：その論理日に、Historyで表示するConversationが1件以上あるか。
 * 通常Memory・Reflectionは理由にしない（Memoryの日付は日ファイルのUTC日付に切り詰められており、JST早朝に始めた
 * Conversationとは論理日が1日ずれるため）。History Indexの行は本体を読む前なので、日付一覧が行を絞り込むときと同じ
 * `conversationLogicalDay`（ULID基準）で判定する。v1の日も`conversationIds`だけを見る。
 */
export function indexEntryHasConversationOnDay(entry: HistoryDayIndex, bucketDay: string, day: string): boolean {
  const ids = isHistoryDayIndexV2(entry) ? entry.conversations.map((c) => c.id) : entry.conversationIds;
  return ids.some((id) => conversationLogicalDay(id, undefined, bucketDay) === day);
}
