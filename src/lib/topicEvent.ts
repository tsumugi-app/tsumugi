/**
 * Topic / Current State v1（Personal Modelの時系列層）。
 *
 * 【構造】
 * - ソース層（保存）：Captureが、ユーザー自身の明示的な発言から見つけた「既存の継続的
 *   テーマ（topicId）についての具体的な出来事・状態」を、逐語quoteのみの`TopicEvent`として
 *   `MemoryObject.topicEvents`に付ける（追加のみ）。専用のIndexedDB store・Vault folder・
 *   Topic Entityは作らない。既存の`MemoryObject.topicId`軸をそのまま再利用する。
 * - ビュー層（計算のみ）：全Memoryのeventから、`TopicTimeline`（topicId軸で束ねた、
 *   時系列順のgrounded evidence一覧）を決定的に計算する。保存しない。
 *
 * 【原則（Person Memoryとの違いに注意）】
 * - `TopicEvent`はUser逐語の`quote`だけを持つ。AI生成の要約・解釈・statementは一切
 *   持たない——PersonMentionの`relation`のような構造化フィールドも持たない。理由：
 *   Topic Stateは本質的に自由文であり、PersonRelationのような閉じたenum・代表語辞書で
 *   決定的にgroundingできないため、自由文の要約を保存すること自体がCapture Evidence
 *   Boundaryで防いだ「semantic strengthening」をTopicEventで再導入するリスクになる。
 * - `TopicTimeline`（派生ビュー）も、AIによる要約文章を一切生成しない。「いつ／Userが
 *   何と言ったか」（time/quote/sourceConversationId）だけを機械的に並べる。「現在の理解」
 *   （Current State）の統合は、chat応答生成の瞬間にLLMが行い、一切保存しない
 *   （保存された誤りが自己増殖する構造を避ける）。
 * - `TopicEvent`の保存対象は、LLMの自由な重要度判断だけに委ねない。既存のTopic
 *   Continuity判定（`resolveTopicId()`、capture.ts）が既にtopicIdを発行した
 *   （＝継続的テーマとして追う価値があると判定した）Memory候補にのみ、TopicEventを
 *   保持できる。topicIdが確定しない場合、TopicEvent候補は保存しない
 *   （`resolvedTopicId`ゲート、capture.ts参照）。
 *
 * このモジュールはサーバー（/api/capture, /api/chat）とクライアントの両方から使う
 * 純粋関数だけを持つ。
 */
import { normalizeText } from "./profile";
import type { ConversationTurn, ID, MemoryObject, TopicEvent } from "./types";

export const TOPIC_EVENT_LIMITS = {
  quoteMin: 2,
  quoteMax: 80,
  /** 1つのMemory候補（Capture出力の1項目）あたり */
  perMemoryItem: 5,
  /** 1回のCapture全体 */
  perCapture: 8,
  /** 1つのMemoryに保存する上限（超えたら新しい重複から捨てる。既存eventは削除しない） */
  perMemoryStored: 12,
} as const;

/**
 * Chat Context Assemblyの上限（重要度推論ではない、v1のdeterministic budget rule。
 * 将来変更可能な定数として持つ）。
 */
export const TOPIC_TIMELINE_BUDGET = {
  /** 同時に扱うtopicIdの数 */
  maxTopics: 3,
  /** 1 topicIdあたりのTopicEvent表示数（最古1件＋直近(N-1)件） */
  maxEventsPerTopic: 5,
} as const;

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export type TopicEventDropReason = "schema" | "quote" | "not-user" | "cap";

/** 検証済みの候補。id・topicId・sourceConversationId・recordedAtは、保存時にTsumugiが付ける。 */
export interface TopicEventDraft {
  quote: string;
  statedAt: string;
}

export interface TopicEventValidationContext {
  turns: ConversationTurn[];
  /** この呼び出しで受理する最大件数（既定：perMemoryItem） */
  maxItems?: number;
  /** quoteを含むturnにtimestampが無い場合の代替 */
  fallbackStatedAt?: string;
}

export interface TopicEventValidationResult {
  drafts: TopicEventDraft[];
  proposed: number;
  dropped: Partial<Record<TopicEventDropReason, number>>;
}

/**
 * LLMが出した候補（quote文字列の配列）を、決定的に検証する。外れた候補だけを個別に
 * 破棄する（Memory自体には影響しない）。サーバー（/api/capture）で検証し、クライアント
 * （capture.ts）でも同じ関数で再検証する（冪等）。「安全に判定できない」候補は保存しない
 * （fail-closed）。topicId自体の妥当性（Topic Continuityが実際にtopicIdを発行したか）は
 * ここでは判定しない——それは呼び出し元（capture.ts、`resolvedTopicId`ゲート）の責務。
 */
export function validateTopicEventQuotes(raw: unknown, ctx: TopicEventValidationContext): TopicEventValidationResult {
  const dropped: Partial<Record<TopicEventDropReason, number>> = {};
  const drop = (reason: TopicEventDropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const list = Array.isArray(raw) ? raw : [];
  const result: TopicEventDraft[] = [];
  const maxItems = ctx.maxItems ?? TOPIC_EVENT_LIMITS.perMemoryItem;
  const userTurns = ctx.turns.filter((turn) => turn.role === "user");
  const aiTurns = ctx.turns.filter((turn) => turn.role !== "user");

  for (const item of list) {
    if (result.length >= maxItems) {
      drop("cap");
      continue;
    }
    const quote = typeof item === "string" ? item.trim() : "";
    if (!quote || quote.length < TOPIC_EVENT_LIMITS.quoteMin || quote.length > TOPIC_EVENT_LIMITS.quoteMax) {
      drop("schema");
      continue;
    }

    // quoteが、ユーザーturnに逐語で含まれること（AI発言にしか無い引用・捏造は根拠にしない）
    const nq = normalizeText(quote);
    const sourceTurn = userTurns.find((turn) => normalizeText(turn.content).includes(nq));
    if (!sourceTurn) {
      drop(aiTurns.some((turn) => normalizeText(turn.content).includes(nq)) ? "not-user" : "quote");
      continue;
    }

    const statedAt = isValidIso(sourceTurn.timestamp) ? sourceTurn.timestamp : ctx.fallbackStatedAt;
    if (!statedAt || !isValidIso(statedAt)) {
      drop("schema");
      continue;
    }

    result.push({ quote, statedAt });
  }

  return { drafts: result, proposed: list.length, dropped };
}

/**
 * サーバー（/api/capture）が検証済みdraftをクライアントへ返す際の中間形（quote文字列の配列、
 * LLM出力と同じ形）。クライアント（capture.ts）が同じ`validateTopicEventQuotes`で再検証
 * してから`draftsToTopicEvents`で最終的なTopicEventを組み立てる（Profile/Person Memory
 * v1と同じ二重検証パターン）。
 */
export function draftsToTopicEventQuotes(drafts: TopicEventDraft[]): string[] {
  return drafts.map((d) => d.quote);
}

/** 検証済みdraftから、保存するeventを作る（id・topicId・sourceConversationId・recordedAt・origin・schemaVersionはTsumugiが付与する）。 */
export function draftsToTopicEvents(
  drafts: TopicEventDraft[],
  meta: { topicId: ID; conversationId: ID; recordedAt: string; newId: () => string }
): TopicEvent[] {
  return drafts.map((d) => ({
    id: meta.newId(),
    topicId: meta.topicId,
    quote: d.quote,
    statedAt: d.statedAt,
    sourceConversationId: meta.conversationId,
    recordedAt: meta.recordedAt,
    origin: "ai-extracted" as const,
    schemaVersion: 1 as const,
  }));
}

// ---------------------------------------------------------------------------
// 保存済みeventの読み込み（fail-soft）と、UPDATE時のmerge
// ---------------------------------------------------------------------------

const MAX_STORED_ON_READ = 24;

/** 保存済み（Markdown・IndexedDB）のeventを検証して読み込む。壊れたeventは、そのeventだけ捨てる（例外を投げない）。 */
export function sanitizeStoredTopicEvents(raw: unknown): TopicEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: TopicEvent[] = [];
  for (const item of raw) {
    if (out.length >= MAX_STORED_ON_READ) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e.id !== "string" ||
      !e.id ||
      typeof e.topicId !== "string" ||
      !e.topicId ||
      typeof e.quote !== "string" ||
      !e.quote ||
      !isValidIso(e.statedAt) ||
      typeof e.sourceConversationId !== "string" ||
      !e.sourceConversationId ||
      !isValidIso(e.recordedAt)
    ) {
      continue;
    }
    out.push({
      id: e.id,
      topicId: e.topicId,
      quote: e.quote,
      statedAt: e.statedAt as string,
      sourceConversationId: e.sourceConversationId,
      recordedAt: e.recordedAt as string,
      origin: "ai-extracted",
      schemaVersion: 1,
    });
  }
  return out;
}

/**
 * Capture UPDATE時のmerge。追加のみ：既存のeventは編集も削除もしない
 * （履歴を破壊しない）。同じ会話・同じquoteのeventは追加しない（retryでの重複防止）。
 */
export function mergeTopicEvents(existing: TopicEvent[] | undefined, incoming: TopicEvent[]): TopicEvent[] {
  const merged: TopicEvent[] = [...(existing ?? [])];
  for (const event of incoming) {
    if (merged.length >= TOPIC_EVENT_LIMITS.perMemoryStored) break;
    const isDuplicate = merged.some((e) => e.sourceConversationId === event.sourceConversationId && e.quote === event.quote);
    if (isDuplicate) continue;
    merged.push(event);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Topic Timeline（派生。保存しない）
// ---------------------------------------------------------------------------

export interface TopicTimelineEntry {
  /** v1はstatedAt（Message Time）のみ。quote単位のEvent Timeは将来フェーズ。 */
  time: ISODateStringAlias;
  quote: string;
  sourceConversationId: ID;
}

// TopicEvent.statedAt/recordedAtと同じISODateString型だが、このファイル単体でも
// 意味が分かるよう別名でexportする（types.tsのISODateStringをそのまま再利用）。
type ISODateStringAlias = string;

export interface TopicTimeline {
  topicId: string;
  /** 時系列昇順、全件（Context Budgetの選択は`selectTimelineEventsForBudget`が別途行う）。 */
  events: TopicTimelineEntry[];
}

/**
 * 全MemoryObjectの`topicEvents`から、指定した1つのtopicIdについてTopicTimelineを計算する。
 * AIによる要約は一切生成しない——時系列に並べるだけ（`computePersonView`と同型の純関数）。
 */
export function computeTopicTimeline(memories: MemoryObject[], topicId: string): TopicTimeline | undefined {
  const events: TopicTimelineEntry[] = [];
  for (const memory of memories) {
    for (const event of memory.topicEvents ?? []) {
      if (event.topicId !== topicId) continue;
      events.push({ time: event.statedAt, quote: event.quote, sourceConversationId: event.sourceConversationId });
    }
  }
  if (events.length === 0) return undefined;
  events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { topicId, events };
}

/** 複数topicIdについて、まとめてTopicTimelineを計算する（存在しないtopicIdは結果に含めない）。 */
export function computeTopicTimelines(memories: MemoryObject[], topicIds: string[]): TopicTimeline[] {
  const out: TopicTimeline[] = [];
  for (const topicId of topicIds) {
    const timeline = computeTopicTimeline(memories, topicId);
    if (timeline) out.push(timeline);
  }
  return out;
}

/**
 * Chat Context Assembly用のdeterministic budget rule（v1、将来変更可能な定数）。
 * 「最古＝重要」と定義するものではない——単に、起点となる最古の1件と、直近の会話の流れに
 * 関係する可能性が高い直近(N-1)件を、重要度推論なしで機械的に残すだけの規則。
 */
export function selectTimelineEventsForBudget(
  events: TopicTimelineEntry[],
  maxEvents: number = TOPIC_TIMELINE_BUDGET.maxEventsPerTopic
): TopicTimelineEntry[] {
  if (maxEvents <= 0) return [];
  if (events.length <= maxEvents) return events;
  if (maxEvents === 1) return [events[events.length - 1]];
  const oldest = events[0];
  const recent = events.slice(events.length - (maxEvents - 1));
  if (recent[0] === oldest) return recent;
  return [oldest, ...recent];
}

// ---------------------------------------------------------------------------
// Chat Context Assembly：サーバー（/api/chat）が、clientから受け取ったTopicTimeline[]を
// 再検証する（Profileの`sanitizeProfileContext`と同じfail-softパターン）。
// ---------------------------------------------------------------------------

/**
 * sanitize段階（防御的な最大値）でのevent件数上限。表示件数の上限
 * （`TOPIC_TIMELINE_BUDGET.maxEventsPerTopic`、最古1件＋直近N-1件）とは別。
 * ここで単純に先頭N件へ切り詰めてしまうと、`selectTimelineEventsForBudget`が行う
 * 「最古＋直近」選択の対象から新しい出来事が失われてしまうため、表示上限より
 * 十分大きい値を持つ（`sanitizeStoredTopicEvents`のMAX_STORED_ON_READと同スケール）。
 */
const SANITIZE_MAX_EVENTS_PER_TOPIC = 24;

export function sanitizeTopicTimelineContext(raw: unknown): TopicTimeline[] {
  if (!Array.isArray(raw)) return [];
  const out: TopicTimeline[] = [];
  for (const item of raw) {
    if (out.length >= TOPIC_TIMELINE_BUDGET.maxTopics) break;
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.topicId !== "string" || !t.topicId) continue;
    if (!Array.isArray(t.events)) continue;
    const events: TopicTimelineEntry[] = [];
    for (const rawEvent of t.events) {
      if (events.length >= SANITIZE_MAX_EVENTS_PER_TOPIC) break;
      if (typeof rawEvent !== "object" || rawEvent === null) continue;
      const e = rawEvent as Record<string, unknown>;
      if (typeof e.time !== "string" || !isValidIso(e.time)) continue;
      if (typeof e.quote !== "string" || !e.quote || e.quote.length > TOPIC_EVENT_LIMITS.quoteMax) continue;
      if (typeof e.sourceConversationId !== "string" || !e.sourceConversationId) continue;
      events.push({ time: e.time, quote: e.quote, sourceConversationId: e.sourceConversationId });
    }
    if (events.length > 0) out.push({ topicId: t.topicId, events });
  }
  return out;
}
