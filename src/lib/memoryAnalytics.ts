/**
 * Memory Analytics Phase 1（純粋関数のみ。ブラウザAPI・IndexedDB・LLMに依存しない）。
 *
 * 「今までよく出てきたキーワードTOP10は？」のように、保存済みMemory**全体**の集計を求める質問に、code側で確定した正確なランキングを渡す。
 * Explicit Memory Search（memorySearch.ts：特定の対象を探す）・通常のAssociative Recall（retrieval.ts）とは**別の目的**であり、
 * このモジュールはどちらもimportしない（互いのロジックに影響しない）。
 *
 * Phase 1の範囲：**全期間のキーワード頻度ランキングだけ**。期間（最近・今月・先月…）・増減の傾向・特定キーワードの出現回数・人物ランキング・
 * 同義語/alias/敬称の統合・stoplist・cache/indexは扱わない。期間や傾向を含む質問は、Analytics intentにしない（全期間として誤って答えないため）。
 *
 * 集計の定義（metric: keyword_conversation_count）：
 * - 主指標 conversationCount：そのキーワードを持つ**通常Memory**が存在するConversationの数。同じConversationの複数Memoryは1。
 *   conversationIdが無いMemoryは、Memory ID単位で別のgroupとして数える。
 * - 副指標 memoryCount：そのキーワードを持つ通常Memoryの数。1 Memory内の重複・表記違い（NFKC/大文字小文字/前後空白）は1。
 * - Reflection（`metadata.source === "system-generated"`。vault.tsのisReflectionSummaryと同じ条件）は集計から除外する
 *   （Reflectionのkeywordsは同じConversationの通常Memoryのkeywordsの和集合のため、含めると二重に数えることになる）。
 * - 現在のConversation由来のMemoryは除外する（Explicit Searchと同じ）。
 * - グルーピングのkeyは NFKC＋空白の正規化＋trim＋小文字化だけ。「リュウ」と「リュウさん」は別のキーワードのまま（誤統合しない）。
 */
import { jstDateOf } from "./dateModel";
import type { MemoryObject } from "./types";

export const MEMORY_ANALYTICS_DEFAULT_LIMIT = 10;
export const MEMORY_ANALYTICS_MAX_LIMIT = 20;
export const MEMORY_ANALYTICS_METRIC = "keyword_conversation_count";
export const MEMORY_ANALYTICS_INTENT = "memory-analytics";
const KEYWORD_DISPLAY_MAX = 60;
const COUNT_MAX = 1_000_000_000;

export interface MemoryAnalyticsRow {
  rank: number;
  keyword: string;
  conversationCount: number;
  memoryCount: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface MemoryAnalyticsScope {
  /** 集計対象になった通常Memoryの数（Reflection・現在のConversationのMemoryを除く）。 */
  memoryCount: number;
  /** 上のMemoryが属するConversation（conversationIdが無いMemoryは1件ずつ）の数。 */
  conversationCount: number;
  /** 対象Memoryに付いている、異なる（正規化後の）キーワードの種類数。 */
  distinctKeywordCount: number;
  /** 対象Memoryの日付（Memory.date＝Conversationの日付、JST）の範囲。 */
  firstDate: string | null;
  lastDate: string | null;
  /** 二重カウントを避けるため除外したReflectionの件数。 */
  excludedReflectionCount: number;
}

export interface MemoryAnalyticsContext {
  intent: typeof MEMORY_ANALYTICS_INTENT;
  metric: typeof MEMORY_ANALYTICS_METRIC;
  /** ユーザーが求めた件数（既定10、1〜20）。 */
  requestedLimit: number;
  scope: MemoryAnalyticsScope;
  results: MemoryAnalyticsRow[];
}

// ---------------------------------------------------------------------------
// 1. 集計
// ---------------------------------------------------------------------------

/** グルーピング用のkey：NFKC・空白の正規化・trim・小文字化だけ。同義語・敬称・aliasの統合はしない。 */
export function normalizeAnalyticsKeyword(keyword: string): string {
  return keyword.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function isReflection(memory: MemoryObject): boolean {
  return memory.metadata?.source === "system-generated";
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Accumulator {
  conversations: Set<string>;
  memoryCount: number;
  surfaces: Map<string, number>;
  firstDate: string | null;
  lastDate: string | null;
}

/**
 * 保存済みMemory全体から、キーワードのランキング（全期間）を集計する。同じ入力なら入力の順序に関わらず同じ結果になる。
 * 順位：conversationCount降順 → memoryCount降順 → lastDate降順（新しい方） → 正規化keyの昇順（決定的な最終tie-break）。
 */
export function computeKeywordRanking(
  memories: readonly MemoryObject[],
  options: { limit?: number; excludeConversationId?: string } = {}
): { results: MemoryAnalyticsRow[]; scope: MemoryAnalyticsScope } {
  const limit = clampLimit(options.limit ?? MEMORY_ANALYTICS_DEFAULT_LIMIT);
  let excludedReflectionCount = 0;
  const considered: MemoryObject[] = [];
  for (const memory of memories) {
    if (isReflection(memory)) {
      excludedReflectionCount += 1;
      continue;
    }
    if (options.excludeConversationId !== undefined && memory.conversationId === options.excludeConversationId) continue;
    considered.push(memory);
  }

  const byKey = new Map<string, Accumulator>();
  const allConversations = new Set<string>();
  let scopeFirst: string | null = null;
  let scopeLast: string | null = null;
  for (const memory of considered) {
    const group = memory.conversationId ? `c:${memory.conversationId}` : `m:${memory.id}`;
    allConversations.add(group);
    const day = typeof memory.date === "string" ? jstDateOf(memory.date) : null;
    if (day !== null) {
      if (scopeFirst === null || day < scopeFirst) scopeFirst = day;
      if (scopeLast === null || day > scopeLast) scopeLast = day;
    }
    // 1 Memory内で、同じ正規化keyは1回だけ数える（表記の違いも1つにまとめる）。表示用の元表記は、このMemory内の異なる表記を1回ずつ記録する。
    const seenInMemory = new Map<string, Set<string>>();
    for (const raw of memory.keywords ?? []) {
      if (typeof raw !== "string") continue;
      const key = normalizeAnalyticsKeyword(raw);
      if (!key) continue;
      const surfaces = seenInMemory.get(key) ?? new Set<string>();
      surfaces.add(raw.trim());
      seenInMemory.set(key, surfaces);
    }
    for (const [key, surfaces] of seenInMemory) {
      let acc = byKey.get(key);
      if (!acc) {
        acc = { conversations: new Set(), memoryCount: 0, surfaces: new Map(), firstDate: null, lastDate: null };
        byKey.set(key, acc);
      }
      acc.conversations.add(group);
      acc.memoryCount += 1;
      for (const surface of surfaces) acc.surfaces.set(surface, (acc.surfaces.get(surface) ?? 0) + 1);
      if (day !== null) {
        if (acc.firstDate === null || day < acc.firstDate) acc.firstDate = day;
        if (acc.lastDate === null || day > acc.lastDate) acc.lastDate = day;
      }
    }
  }

  const rows = [...byKey.entries()].map(([key, acc]) => {
    // 表示：そのkeyで最も多く使われた元表記。同数なら、code pointの昇順で最初のもの（入力順に依存しない）。
    const surface = [...acc.surfaces.entries()].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]))[0][0];
    return { key, surface, conversationCount: acc.conversations.size, memoryCount: acc.memoryCount, firstDate: acc.firstDate, lastDate: acc.lastDate };
  });
  rows.sort((a, b) => {
    if (b.conversationCount !== a.conversationCount) return b.conversationCount - a.conversationCount;
    if (b.memoryCount !== a.memoryCount) return b.memoryCount - a.memoryCount;
    const la = a.lastDate ?? "";
    const lb = b.lastDate ?? "";
    if (la !== lb) return la < lb ? 1 : -1; // 新しい日付が先
    return compareCodePoints(a.key, b.key);
  });

  return {
    results: rows.slice(0, limit).map((row, index) => ({
      rank: index + 1,
      keyword: row.surface,
      conversationCount: row.conversationCount,
      memoryCount: row.memoryCount,
      firstDate: row.firstDate,
      lastDate: row.lastDate,
    })),
    scope: {
      memoryCount: considered.length,
      conversationCount: allConversations.size,
      distinctKeywordCount: byKey.size,
      firstDate: scopeFirst,
      lastDate: scopeLast,
      excludedReflectionCount,
    },
  };
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return MEMORY_ANALYTICS_DEFAULT_LIMIT;
  return Math.min(MEMORY_ANALYTICS_MAX_LIMIT, Math.max(1, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// 2. intent判定（deterministic。Explicit Searchとは独立）
// ---------------------------------------------------------------------------

/** 対象：キーワード（Phase 1は「テーマ」「話題」「人物」へ広げない）。 */
const KEYWORD_TARGET = /キーワード/;
/** 集計の要求（多い順・頻度・ランキング・TOP N 等）。 */
const AGGREGATE_CUE = /TOP\s*\d*|トップ\s*\d*|上位|ランキング|多い順|多い|よく出て|よく出る|よく登場|頻出|頻度|登場回数|出現回数|一番(?:多|よく)|最も(?:多|よく)|並べて|順に/i;
/** 質問・依頼の形（陳述「キーワードがよく出てくる」を拾わない）。 */
const REQUEST_FORM = /[？?]|ください|並べて|見せて|教えて|出して|示して|表示|一覧|まとめて|ランキング|TOP\s*\d*|トップ\s*\d*|何です|ですか|かな$|どれ/i;
/** 期間・傾向を含む質問は、Phase 1ではAnalyticsにしない（全期間として誤って答えないため）。 */
const PERIOD_OR_TREND = /最近|今月|先月|今週|先週|今年|去年|昨年|昨日|今日|今朝|この前|このところ|ここ(?:数|[0-9]+)|直近|今期|\d+\s*月|\d{4}\s*年|[0-9]+\s*(?:週間|ヶ月|か月|日間|年間)|増え|減っ|増加|減少|推移|傾向|変化/;
/** 特定の語の出現回数・特定の対象の検索は、Analyticsではない。 */
const SPECIFIC_TARGET = /何回|何度|[「『"“].+?[」』"”]|という(?:キーワード|言葉|単語)|について|に関して|に関する|のこと/;
const NUMBER_PATTERNS: readonly RegExp[] = [/(?:TOP|トップ|上位)\s*(\d+)/i, /(\d+)\s*(?:個|件|つ|位)/];

/**
 * 発言が「保存済みMemory全体のキーワード頻度ランキング」を求めるものなら、件数（既定10、1〜20）を返す。そうでなければnull。
 * 成立条件：集計の要求 ＋ キーワードが対象 ＋ 質問/依頼の形。期間・傾向・特定の語・特定の対象の検索を含む発言は対象外。
 */
export function detectMemoryAnalyticsIntent(text: string): { limit: number } | null {
  const t = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (!KEYWORD_TARGET.test(t)) return null;
  if (PERIOD_OR_TREND.test(t)) return null;
  if (SPECIFIC_TARGET.test(t)) return null;
  if (!AGGREGATE_CUE.test(t)) return null;
  if (!REQUEST_FORM.test(t)) return null;
  for (const pattern of NUMBER_PATTERNS) {
    const match = pattern.exec(t);
    if (match) return { limit: clampLimit(Number(match[1])) };
  }
  return { limit: MEMORY_ANALYTICS_DEFAULT_LIMIT };
}

/**
 * 発言がAnalyticsなら、保存済みMemory全体を集計して、/api/chatへ渡す形を返す。そうでなければnull（通常会話・Explicit Searchは従来のまま）。
 * 集計結果が0件でもnullにはしない（「集計できるキーワードがまだ無い」ことをChatへ伝えるため）。
 */
export function buildMemoryAnalyticsContext(
  memories: readonly MemoryObject[],
  userText: string,
  options: { excludeConversationId?: string } = {}
): MemoryAnalyticsContext | null {
  const intent = detectMemoryAnalyticsIntent(userText);
  if (!intent) return null;
  const { results, scope } = computeKeywordRanking(memories, { limit: intent.limit, excludeConversationId: options.excludeConversationId });
  return { intent: MEMORY_ANALYTICS_INTENT, metric: MEMORY_ANALYTICS_METRIC, requestedLimit: intent.limit, scope, results };
}

// ---------------------------------------------------------------------------
// 3. サーバー側の再検証（fail-soft。client payloadを無条件でpromptへ入れない）
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= COUNT_MAX ? value : null;
}
function asDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? value : null;
}

/**
 * clientから受け取ったAnalytics結果をserver側で必ず検証する。形が不正（intent/metric/requestedLimit/scopeの不一致）ならnull。
 * 行は、rank・keyword・countsが妥当なものだけを残し、元のrank順に並べて1から振り直し、requestedLimit（最大20）で切る。
 */
export function sanitizeMemoryAnalyticsContext(raw: unknown): MemoryAnalyticsContext | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.intent !== MEMORY_ANALYTICS_INTENT || r.metric !== MEMORY_ANALYTICS_METRIC) return null;
  const requestedLimit = r.requestedLimit;
  if (typeof requestedLimit !== "number" || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MEMORY_ANALYTICS_MAX_LIMIT) return null;
  if (typeof r.scope !== "object" || r.scope === null || Array.isArray(r.scope)) return null;
  const s = r.scope as Record<string, unknown>;
  const memoryCount = asCount(s.memoryCount);
  const conversationCount = asCount(s.conversationCount);
  const distinctKeywordCount = asCount(s.distinctKeywordCount);
  const excludedReflectionCount = asCount(s.excludedReflectionCount);
  if (memoryCount === null || conversationCount === null || distinctKeywordCount === null || excludedReflectionCount === null) return null;

  const rows: MemoryAnalyticsRow[] = [];
  for (const item of Array.isArray(r.results) ? r.results : []) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const rank = row.rank;
    if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1 || rank > COUNT_MAX) continue;
    if (typeof row.keyword !== "string") continue;
    const keyword = row.keyword.replace(/\s+/g, " ").trim().slice(0, KEYWORD_DISPLAY_MAX);
    if (!keyword) continue;
    const rowConversations = asCount(row.conversationCount);
    const rowMemories = asCount(row.memoryCount);
    if (rowConversations === null || rowMemories === null || rowConversations > rowMemories) continue;
    rows.push({ rank, keyword, conversationCount: rowConversations, memoryCount: rowMemories, firstDate: asDate(row.firstDate), lastDate: asDate(row.lastDate) });
  }
  rows.sort((a, b) => a.rank - b.rank);
  const results = rows.slice(0, requestedLimit).map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    intent: MEMORY_ANALYTICS_INTENT,
    metric: MEMORY_ANALYTICS_METRIC,
    requestedLimit,
    scope: { memoryCount, conversationCount, distinctKeywordCount, firstDate: asDate(s.firstDate), lastDate: asDate(s.lastDate), excludedReflectionCount },
    results,
  };
}
