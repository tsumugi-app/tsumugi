/**
 * Retrieval Engine（ARCHITECTURE.md「Retrieval Engine」層）。
 *
 * ローカルのIndexedDBのみを対象に検索し、AIを一切呼ばない。
 * REQUIREMENTS.md 4.2「全記憶をAIに渡さない」を担保する層であり、
 * ここで少数（既定3件）に絞ってから初めて /api/chat がAIへ渡す。
 *
 * スコア軸は3つ。person/theme/emotion（Entity）軸は、Connect（Phase 2, ROADMAP.md）が
 * 実際にIDを埋め始めるまで常に0を返すスタブとして用意してあり、
 * 将来データが入り次第このファイルの他の場所を変更せずに稼働し始める。
 *
 * 直接一致（キーワード/bigram）で候補が埋まらない場合に限り、直接一致した記憶が持つ
 * Link（Connectが生成したMemory-to-Memory Link）を1-hopだけ辿り、最大`maxLinkedAdditions`件を補う
 * （ARCHITECTURE.mdのSearch Strategy優先度2「リンクされた記憶」に対応）。
 * 通常会話では既定`MAX_LINKED_ADDITIONS=1`件、明示的Reflection時のみ
 * `REFLECTIVE_MAX_LINKED_ADDITIONS=2`件まで（Memory Editing最小実装、MEMORY_ENGINE.md 6章）。
 * 選ばれたLink経由の記憶にはそれぞれ`RetrievedMemory.linkReason`として`Link.reason`を付与する
 * （直接一致の記憶には付かない）。axis/contrast/strengthは渡さない。
 *
 * 明示的Reflection（REQUIREMENTS.md 3.6 / UI_UX.md「Reflection」、ROADMAP.md Phase 2）。
 * ユーザーが能動的に過去を振り返るような問いを投げたときだけ、直接一致の`limit`とLink経由の
 * 上限を広げる。判定はAIを呼ばないローカルなキーワード一致のみで行う（`isReflectiveQuery`）。
 * スコアリング式・通常会話時の`MAX_LINKED_ADDITIONS`・`linkReason`の型は一切変更しない。
 * セッション終了時の既存Reflection（`/api/reflect`, `generateSessionReflection`）とは無関係。
 */
"use client";

import { getAllMemoryObjects, getMemoryObject } from "./db";
import type { MemoryObject, Persona, RetrievedMemory } from "./types";

/** capture.ts側の候補スコア閾値の根拠としても参照する（1キーワード一致分の重み）。 */
export const KEYWORD_WEIGHT = 3;
const TEXT_WEIGHT = 5;
/** capture.ts側の候補件数上限の既定値としても参照する（通常会話の直接一致と同じ基準）。 */
export const DEFAULT_LIMIT = 3;
/** 直接一致で埋まらなかった枠を補う、Link経由の記憶の最大追加件数（通常会話）。 */
const MAX_LINKED_ADDITIONS = 1;
/**
 * クリエイト（analyst）専用。直接関連するMemoryだけでなく、あえて時間的に遠い・
 * 独自語を含むMemoryも一定数混ぜる（発想の飛躍の材料にするため）。件数は固定値。
 */
const CREATIVE_DIVERGENT_COUNT = 3;
/** Link経由の記憶の最大追加件数（明示的Reflection時のみ）。Memory Editing最小実装。呼び出し元（ChatScreen.tsx）が使う。 */
export const REFLECTIVE_MAX_LINKED_ADDITIONS = 2;
/** 明示的Reflectionと判定された場合にのみ使う、直接一致の拡大limit。呼び出し元（ChatScreen.tsx）が使う。 */
export const REFLECTIVE_LIMIT = 6;

/** 想起を促す語（前提として過去に触れている） */
const REFLECTIVE_RECALL_WORDS = ["前に", "以前", "これまで", "昔", "過去に", "過去の"];
/** 抽象化・パターン把握を求める語（これ単体でも反射的な問いとみなす） */
const REFLECTIVE_PATTERN_WORDS = ["パターン", "傾向", "繰り返し", "共通点"];
/** 疑問形の目安（記号だけでなく、日本語の口語的な疑問表現も含む） */
const QUESTION_MARKERS = ["？", "?", "かな", "だろう", "かしら", "ますか", "ある？"];

/**
 * ユーザーの発言が「明示的な振り返りの問い」らしいかを、ローカルの文字列マッチだけで判定する。
 * AIは呼ばない（判定のための追加AI呼び出しを増やさないため）。
 * 形態素解析は行わず、既存のbigramスコアリングと同じ「MVPとしての割り切り」を踏襲する
 * （完璧な意図判定はできない前提。誤検出は許容する）。
 *
 * - 想起語（前に／以前 等）＋ 疑問形の組み合わせ、または
 * - パターン・傾向を問う語（単体で成立）
 * のいずれかを満たす場合にtrueを返す。
 */
export function isReflectiveQuery(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (REFLECTIVE_PATTERN_WORDS.some((word) => trimmed.includes(word))) {
    return true;
  }

  const hasRecallWord = REFLECTIVE_RECALL_WORDS.some((word) => trimmed.includes(word));
  const hasQuestionMarker = QUESTION_MARKERS.some((marker) => trimmed.includes(marker));
  return hasRecallWord && hasQuestionMarker;
}

function toBigrams(text: string): Set<string> {
  const chars = Array.from(text.replace(/\s+/g, ""));
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) {
    grams.add(chars[i] + chars[i + 1]);
  }
  return grams;
}

/**
 * 日本語は分かち書きされないため、形態素解析の代わりに文字bi-gramの重なり率を使う。
 * MeCab等の辞書付きトークナイザは導入しない（MVPとしての複雑さを避けるため）。
 */
function bigramOverlap(a: string, b: string): number {
  const setA = toBigrams(a);
  const setB = toBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const gram of setA) {
    if (setB.has(gram)) shared += 1;
  }
  return shared / Math.min(setA.size, setB.size);
}

/**
 * Entity（person/theme/emotion）軸のスコアラー。
 * MemoryObject.themeIds等はPhase 1では常に空配列（Connect未実装）であることに加え、
 * クエリ文字列側からEntityを抽出する仕組みも無いため、現時点では計算しようが無い。
 * Phase 2でConnectとクエリ側のEntity抽出が揃った時点で、この関数の中身だけ差し替える。
 */
function entityScore(): number {
  return 0;
}

/** 通常の関連度スコア（キーワード一致＋bigram重なり）。既存のretrieveRelevantMemoriesと
 * クリエイト専用のretrieveCreativeMemoriesの両方から使う、挙動を変えない共通処理。
 * capture.ts（別Conversationからの類似Memory候補探し）からも読み取り専用で再利用する。
 * ロジック自体はここでは変更しない。 */
export function scoreMemory(memory: MemoryObject, trimmed: string): number {
  const keywordHits = memory.keywords.filter((keyword) => keyword && trimmed.includes(keyword)).length;
  const textOverlap = bigramOverlap(trimmed, `${memory.summary} ${memory.content}`);
  return keywordHits * KEYWORD_WEIGHT + textOverlap * TEXT_WEIGHT + entityScore();
}

/**
 * クリエイト専用。「遠いMemory」を選ぶための補助スコアラー群。
 * 形態素解析・固有名詞抽出は導入せず（MVPとしての割り切りを踏襲）、
 * 「keywordがコーパス全体でどれだけ珍しいか」を独自語らしさの代理指標として使う。
 */
function computeKeywordFrequency(all: MemoryObject[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const memory of all) {
    for (const keyword of memory.keywords) {
      if (!keyword) continue;
      freq.set(keyword, (freq.get(keyword) ?? 0) + 1);
    }
  }
  return freq;
}

/** keywordsの中で最も珍しい（コーパス内での出現回数が少ない）ものほど高スコアにする。 */
function distinctivenessScore(memory: MemoryObject, freq: Map<string, number>): number {
  if (memory.keywords.length === 0) return 0;
  const freqs = memory.keywords.map((keyword) => freq.get(keyword) ?? 1);
  return 1 / Math.min(...freqs);
}

function daysAgo(dateISO: string): number {
  return (Date.now() - new Date(dateISO).getTime()) / (24 * 60 * 60 * 1000);
}

/** 90日分を上限に0〜3のスケールへ正規化し、distinctivenessScoreと同じ程度の重みで足し合わせられるようにする。 */
function ageScore(dateISO: string): number {
  return Math.min(daysAgo(dateISO) / 30, 3);
}

/** 重複無しでn件をランダムに選ぶ（候補が少なければ全件返す）。完全な均一ランダムではなく、
 * 呼び出し元が事前に「遠さ」で絞り込んだ候補集合の中からだけ選ぶために使う。 */
function pickRandomN<T>(items: T[], n: number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (pool.length > 0 && picked.length < n) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

/**
 * クリエイト（analyst）専用の「遠いMemory」選定。直接一致からは外れた候補の中から、
 * 独自語らしさ（distinctivenessScore）＋時間的な遠さ（ageScore）が高いものを広めに
 * ショートリストし、その中からランダムにcount件選ぶ（完全ランダムにはしない）。
 */
function selectDivergentMemories(
  candidates: MemoryObject[],
  keywordFrequency: Map<string, number>,
  count: number
): MemoryObject[] {
  if (candidates.length === 0 || count <= 0) return [];
  const scored = candidates
    .map((memory) => ({
      memory,
      score: distinctivenessScore(memory, keywordFrequency) + ageScore(memory.date),
    }))
    .sort((a, b) => b.score - a.score);
  const shortlist = scored.slice(0, Math.max(count * 3, 6)).map((entry) => entry.memory);
  return pickRandomN(shortlist, count);
}

/**
 * 「同じConversationから生まれた記憶だから除外する」判定。excludeConversationIdは
 * 呼び出し元（Connect）が「今回追加された記憶自身のconversationId」を渡す仕組みのため、
 * これがundefined＝Conversationを持たない記憶（将来のimport等）である場合は、
 * 「同じConversationに属する」という概念自体が存在しない。単純に
 * `conversationId !== excludeConversationId`で比較すると、比較対象双方が
 * undefined同士のときにtrueとみなされてしまい（`undefined !== undefined`はfalse＝除外）、
 * Conversationを持たない記憶同士が「たまたま両方Conversation無し」というだけで
 * 永久に除外され合う不具合になる。excludeConversationIdがundefinedのときは
 * この基準による除外を一切行わない（conversationIdの有無に関わらずfalseを返す）ことで、
 * Conversationありの記憶同士の既存の除外挙動は変えずに、この不具合だけを解消する。
 * capture.ts（別Conversationからの類似Memory候補探し）からも読み取り専用で再利用する。
 */
export function isSameConversation(conversationId: string | undefined, excludeConversationId: string | undefined): boolean {
  return excludeConversationId !== undefined && conversationId === excludeConversationId;
}

/**
 * クリエイト（analyst）専用のMemory取得。「直接関連するMemory」＋「あえて遠いMemory」の
 * 2部構成にする。companion/coachが使う既存のretrieveRelevantMemoriesの
 * スコアリング・件数ロジックには一切影響しない（別関数として完全に分離）。
 * Link経由の追加（pickLinkedAdditions）はここでは行わない（既存のConnect機能とは別軸のため）。
 */
async function retrieveCreativeMemories(
  trimmed: string,
  options: { excludeConversationId?: string; limit?: number }
): Promise<RetrievedMemory[]> {
  const directLimit = options.limit ?? DEFAULT_LIMIT;
  const all = await getAllMemoryObjects();
  const pool = all.filter((memory) => !isSameConversation(memory.conversationId, options.excludeConversationId));

  const directMatches = pool
    .map((memory) => ({ memory, score: scoreMemory(memory, trimmed) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, directLimit)
    .map((entry) => entry.memory);

  const directIds = new Set(directMatches.map((memory) => memory.id));
  const divergentPool = pool.filter((memory) => !directIds.has(memory.id));
  const keywordFrequency = computeKeywordFrequency(all);
  const divergentMatches = selectDivergentMemories(divergentPool, keywordFrequency, CREATIVE_DIVERGENT_COUNT);

  return [...directMatches, ...divergentMatches].map((memory) => toRetrievedMemory(memory));
}

function toRetrievedMemory(memory: MemoryObject, linkReason?: string): RetrievedMemory {
  return {
    id: memory.id,
    date: memory.date,
    summary: memory.summary,
    keywords: memory.keywords,
    linkReason,
    source: memory.metadata.source,
  };
}

interface LinkedAddition {
  memory: MemoryObject;
  reason: string;
}

/**
 * directMatches（直接一致した記憶）が持つLinkを1-hopだけ辿り、まだ候補に無い記憶を
 * strengthの高い順に最大maxAdditions件選ぶ。strengthは直接一致スコアとは合成せず、
 * Link経由候補同士を選ぶためだけに使う（Linkは生成時点で既にstrength閾値を通過済みのため、
 * ここで改めて閾値フィルタはしない）。同じ候補が複数のLinkから見つかった場合は
 * strengthが最も高いものだけを残す（重複除外）。選ばれたLinkのreasonも一緒に返す。
 *
 * 通常会話（maxAdditions=1）では従来のpickLinkedAdditionと同じ結果を返す。
 * 明示的Reflection（maxAdditions=2, Memory Editing最小実装）でのみ複数件を返しうる。
 */
function pickLinkedAdditions(
  directMatches: MemoryObject[],
  allById: Map<string, MemoryObject>,
  excludeIds: Set<string>,
  maxAdditions: number,
  excludeConversationId?: string
): LinkedAddition[] {
  const bestByCandidateId = new Map<string, { memory: MemoryObject; strength: number; reason: string }>();

  for (const direct of directMatches) {
    for (const link of direct.links) {
      const candidateId = link.sourceId === direct.id ? link.targetId : link.sourceId;
      if (excludeIds.has(candidateId)) continue;
      const candidate = allById.get(candidateId);
      if (!candidate) continue;
      if (isSameConversation(candidate.conversationId, excludeConversationId)) continue;
      const existing = bestByCandidateId.get(candidateId);
      if (!existing || link.strength > existing.strength) {
        bestByCandidateId.set(candidateId, { memory: candidate, strength: link.strength, reason: link.reason });
      }
    }
  }

  return [...bestByCandidateId.values()]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxAdditions)
    .map(({ memory, reason }) => ({ memory, reason }));
}

/**
 * Beta「過去からの問いかけ」起点Memory連携。promptedMemoryIdが指定されている場合のみ、
 * そのMemoryを検索スコアに関係なく必ず結果へ含める。既存の検索ロジック（スコアリング・
 * Link経由追加・analyst専用ロジック）には一切手を加えず、どちらの結果に対しても
 * 同じように最後に適用できる独立処理として分離する。
 * 既に結果に含まれている場合は新しいエントリを二重追加せず、既存エントリへ
 * isOriginMemoryフラグだけを立てる。
 */
async function ensureOriginMemoryIncluded(
  results: RetrievedMemory[],
  promptedMemoryId: string
): Promise<RetrievedMemory[]> {
  const alreadyIncluded = results.some((memory) => memory.id === promptedMemoryId);
  if (alreadyIncluded) {
    return results.map((memory) =>
      memory.id === promptedMemoryId ? { ...memory, isOriginMemory: true } : memory
    );
  }

  const originMemory = await getMemoryObject(promptedMemoryId);
  if (!originMemory) return results;

  return [...results, { ...toRetrievedMemory(originMemory), isOriginMemory: true }];
}

export async function retrieveRelevantMemories(
  queryText: string,
  options: {
    excludeConversationId?: string;
    limit?: number;
    maxLinkedAdditions?: number;
    persona?: Persona;
    promptedMemoryId?: string;
  } = {}
): Promise<RetrievedMemory[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];

  // クリエイト（analyst）だけ別ロジックへ委譲する。companion/coachはこの下の
  // 既存ロジックをそのまま通る（挙動は一切変えていない）。
  if (options.persona === "analyst") {
    const creativeResults = await retrieveCreativeMemories(trimmed, options);
    return options.promptedMemoryId
      ? ensureOriginMemoryIncluded(creativeResults, options.promptedMemoryId)
      : creativeResults;
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxLinkedAdditions = options.maxLinkedAdditions ?? MAX_LINKED_ADDITIONS;
  const all = await getAllMemoryObjects();

  const scored = all
    .filter((memory) => !isSameConversation(memory.conversationId, options.excludeConversationId))
    .map((memory) => ({ memory, score: scoreMemory(memory, trimmed) }))
    // スコア0（関連なし）は返さない。無理に件数を埋めない（MEMORY_ENGINE.md 7.4）。
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const directMatches = scored.map((entry) => entry.memory);
  const results: RetrievedMemory[] = directMatches.map((memory) => toRetrievedMemory(memory));

  // Link経由の追加は、直接一致がlimitを埋めているかどうかに関係なく常に探索する
  // （直接一致件数とは独立の別枠。直接一致のスコアリングやpickLinkedAdditions自体のロジックは変更しない）。
  {
    const allById = new Map(all.map((memory) => [memory.id, memory]));
    const excludeIds = new Set(directMatches.map((memory) => memory.id));
    const additions = pickLinkedAdditions(
      directMatches,
      allById,
      excludeIds,
      maxLinkedAdditions,
      options.excludeConversationId
    );
    for (const addition of additions) {
      results.push(toRetrievedMemory(addition.memory, addition.reason));
    }
  }

  const capped = results.slice(0, limit + maxLinkedAdditions);
  return options.promptedMemoryId ? ensureOriginMemoryIncluded(capped, options.promptedMemoryId) : capped;
}
