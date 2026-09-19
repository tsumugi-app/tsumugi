/**
 * Topic Continuity Context v1（Current Conversation → Recent Conversation Context →
 * Topic Continuity Context → Memory Retrieval、という並びのうち、Recent Conversationと
 * Memory Retrievalの間に位置する層）。
 *
 * 目的：「昨日の話なんだけど、やっぱりあれでいこうかな」のように、現在の発言だけでは
 * keywordがほとんど無くても、continuity signal（「昨日」「前に」等）をきっかけに、
 * 継続中の話題（MemoryObject.topicId、Topic Continuity Phase 1で追加済み）の候補を
 * AIへ提示できるようにする。
 *
 * 責務の境界（重要）：このモジュールは「続きである可能性のあるtopic候補を絞る」ところ
 * までしか行わない。「どのtopicの続きか」「どのtopicも使うべきでないか」という最終判断は
 * 一切ここでは行わず、/api/chatの既存LLM呼び出しへ委ねる（新しいAPI/LLM callは追加しない、
 * recentConversation.tsと同じ方式）。特に、signalがあってもkeyword一致がほぼ無い場合に、
 * ローカル側で「最新topic＝続き」と決め打ちしない——その場合は直近の複数topic候補
 * （最大MAX_TOPIC_CANDIDATES件）をそのまま渡し、最終判断は必ずLLM側に委ねる。
 *
 * recentConversation.tsと同じく、このモジュールは純粋関数のみ（副作用なし・ブラウザAPI
 * 非依存・"use client"不要）。全MemoryObjectの取得（getAllMemoryObjects）は呼び出し元
 * （ChatScreen.handleSend）の責務。
 *
 * v1の設計上の割り切り（recentConversation.tsのコメントと同じ位置づけ）：
 * - topicIdを持たないMemory（Topic Continuity Phase 1導入前のMemory、またはPhase 1でも
 *   uncertain判定だったMemory）はcandidate化しない。
 * - 渡すのは各topicの直近MAX_MEMORIES_PER_TOPIC件のsummary/date/keywordsのみ（content・
 *   本文は渡さない。既存RetrievedMemory＝トークン節約のためcontentを含めない、という
 *   既存方針と同じ）。
 * - topic候補の順序は「keywordスコア優先、同点（ゼロ点を含む）なら直近優先」という
 *   単一のsortだけで決める。これにより、「keywordが強い候補は最優先」と「keywordが
 *   ほぼ無い場合は直近の複数候補をそのまま渡す（決め打ちしない）」の両方を、特別扱いの
 *   分岐を増やさずに満たす。
 * - DB schema / Vault Markdownは一切変更しない（Phase 1で追加済みのtopicIdを読むだけ）。
 *   これは永続スキーマではなく、1リクエストごとに組み立てて破棄する/api/chat bodyの
 *   optional field。
 */

import type { EventTimePrecision, MemoryObject } from "./types";
import { scoreMemory } from "./retrieval";

/** topic候補として提示する最大topic数（v1）。 */
export const MAX_TOPIC_CANDIDATES = 3;

/** 1 topicあたり提示する最大Memory数（v1）。同じtopicに5件あっても直近3件のみ渡す。 */
export const MAX_MEMORIES_PER_TOPIC = 3;

/**
 * continuity signal（「昨日」「前に」等）を検出する。isReflectiveQuery（retrieval.ts）と
 * 同じ「トリガー語リスト＋includes()」方式を踏襲する。誤検出は一定程度許容する
 * （完璧な意図判定はできない前提であることも同じ）。
 *
 * 重要：この関数がtrueを返すことは「過去topicを必ず使う」ことを意味しない。あくまで
 * topic candidate retrieval（selectTopicContinuityCandidates）を起動するtriggerに
 * すぎない。実際に使うかどうかの最終判断は/api/chat側のLLMが行う。
 */
const TOPIC_CONTINUITY_SIGNAL_WORDS = [
  "昨日",
  "前に",
  "この前",
  "さっき",
  "あの件",
  "あの話",
  "例の",
  "続き",
  "その後",
  "やっぱり",
  "前回",
];

export function hasTopicContinuitySignal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return TOPIC_CONTINUITY_SIGNAL_WORDS.some((word) => trimmed.includes(word));
}

/** /api/chat bodyのoptional field `topicContext` の1 Memory分の形（永続スキーマではない）。
 *  既存RetrievedMemoryと同じく、contentは含めない（summaryで十分という既存方針）。 */
export interface TopicContinuityMemoryRef {
  date: string;
  eventTime?: string;
  eventTimePrecision?: EventTimePrecision;
  summary: string;
  keywords: string[];
}

/** /api/chat bodyのoptional field `topicContext` の1 topic分の形。 */
export interface TopicContinuityCandidate {
  /** 内部識別用のみ。プロンプト本文へは出さない（デバッグ用途）。 */
  topicId: string;
  /** 直近MAX_MEMORIES_PER_TOPIC件、新しい順。 */
  memories: TopicContinuityMemoryRef[];
}

interface TopicGroup {
  topicId: string;
  memories: MemoryObject[];
}

function groupByTopicId(memories: MemoryObject[]): TopicGroup[] {
  const groups = new Map<string, MemoryObject[]>();
  for (const memory of memories) {
    if (!memory.topicId) continue;
    const list = groups.get(memory.topicId);
    if (list) {
      list.push(memory);
    } else {
      groups.set(memory.topicId, [memory]);
    }
  }
  return [...groups.entries()].map(([topicId, list]) => ({ topicId, memories: list }));
}

function memoryTimeMs(memory: MemoryObject): number {
  const ms = Date.parse(memory.updatedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** グループ内の各Memoryへ既存scoreMemory（retrieval.ts、キーワード一致＋bigram重なり）を
 *  適用し、最良スコアだけを代表値として使う（1件でも強く一致すればそのtopicを優先する）。 */
function bestKeywordScore(group: TopicGroup, trimmed: string): number {
  let best = 0;
  for (const memory of group.memories) {
    const score = scoreMemory(memory, trimmed);
    if (score > best) best = score;
  }
  return best;
}

function toMemoryRef(memory: MemoryObject): TopicContinuityMemoryRef {
  return {
    date: memory.date,
    eventTime: memory.eventTime,
    eventTimePrecision: memory.eventTimePrecision,
    summary: memory.summary,
    keywords: memory.keywords,
  };
}

/**
 * 現在の話題候補を最大MAX_TOPIC_CANDIDATES件選ぶ。呼び出し元は、
 * hasTopicContinuitySignal(currentUserMessage)がtrueの場合にのみこれを呼ぶこと
 * （signalの有無を見るgatingはこの関数の外、呼び出し元の責務。この関数自体はsignalの
 * 有無を判定しない）。
 *
 * 並び順：keywordスコア（scoreMemory、現在発言に対する各topicの最良一致）の降順、
 * 同点（keywordが弱い/無いケースを含む）はtopic内最新Memoryの更新日時の降順。この
 * 単一のsortだけで、「keywordが強いtopicは最優先候補にしてよい」と「keywordがほぼ無い
 * 場合はローカル側で1つに決め打ちせず、直近の複数topicをそのまま候補として渡す」の
 * 両方を、特別扱いの分岐を追加せずに満たす。
 *
 * topicId自体を持つMemoryが無ければ空配列を返す（Phase 1導入前のVaultでは常に空）。
 */
export function selectTopicContinuityCandidates(
  allMemories: MemoryObject[],
  currentUserMessage: string
): TopicContinuityCandidate[] {
  const trimmed = currentUserMessage.trim();
  const groups = groupByTopicId(allMemories);
  if (groups.length === 0) return [];

  const scored = groups.map((group) => ({
    group,
    keywordScore: trimmed ? bestKeywordScore(group, trimmed) : 0,
    recencyMs: Math.max(...group.memories.map(memoryTimeMs)),
  }));

  scored.sort((a, b) => {
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return b.recencyMs - a.recencyMs;
  });

  return scored.slice(0, MAX_TOPIC_CANDIDATES).map(({ group }) => ({
    topicId: group.topicId,
    memories: [...group.memories]
      .sort((a, b) => memoryTimeMs(b) - memoryTimeMs(a))
      .slice(0, MAX_MEMORIES_PER_TOPIC)
      .map(toMemoryRef),
  }));
}

/**
 * ChatScreen.handleSend から呼ぶ薄いヘルパー（recentConversation.tsの
 * buildRecentConversationPayloadと同じ形）。continuity signalの有無をここで
 * gatingし、signalが無い、またはtopic候補が1件も無い場合はnullを返す
 * （/api/chat bodyへtopicContextを含めない＝既存挙動を維持）。
 */
export function buildTopicContinuityPayload(
  allMemories: MemoryObject[],
  currentUserMessage: string
): TopicContinuityCandidate[] | null {
  if (!hasTopicContinuitySignal(currentUserMessage)) return null;
  const candidates = selectTopicContinuityCandidates(allMemories, currentUserMessage);
  return candidates.length > 0 ? candidates : null;
}
