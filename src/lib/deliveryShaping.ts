/**
 * 配送の整形（Delivery Shaping）：短い日常の発言・気持ちの共有のターンで、経緯（Topic Timeline /
 * Memory Timeline）の届け方だけを絞る。狙いは、話題を開いたばかりの発言や気持ちの共有に対して、
 * 過去の記録の列挙・対比の足場がそのまま届いて応答が「列挙・分析」になるのを、材料側で止めること。
 *
 * 設計は凍結済み（tsumugi-delivery-design-investigation.md）。要点：
 * - 判定は chatContextAssembly の最後段の1か所だけ。companion / coach のみ（analyst は対象外）。
 *   リアルタイム日記モードも対象外。
 * - 拒否（veto）が1つでも立ったら、従来どおり全量配送（バイト同一）。整形はターン毎・無状態で、
 *   判定に迷う側は常に全量配送へ倒す。
 * - Retrieval の選択・人物補完・深い過去の規則・Timeline の発火条件・プロンプト文面・記録モードは
 *   一切変えない。変えるのは Timeline 2チャネルの「届ける量」だけ。
 * - Topic Timeline は本人の言葉の引用だけのチャネル（創設原則）：引用の数を減らすだけで、
 *   生成した状態文を足したりはしない。Memory Timeline の状態ブロックは Profile T ではそのまま残す。
 * - 訂正（PR #63）を含む Timeline は拒否8で全量配送になり、整形が訂正・そのペア・注記を取り除くことはない。
 */
import { isRecordRequestTurn } from "./correction";
import { themeTerms, type SynthesisThemeContext } from "./memorySynthesis";
import { isRecallQuestion } from "./recallQuestion";
import { asksPastQuestion, asksPersonChange, purposeContextOf } from "./recordRelevance";
import { isReflectiveQuery, isRelationshipTalk, personChangeGate, resolveTurnPerson } from "./retrieval";
import { selectTimelineEventsForBudget, type TopicTimeline } from "./topicEvent";
import { hasTopicContinuitySignal } from "./topicContinuity";
import type { MemoryObject, Persona } from "./types";

/**
 * 拒否9「短い発言でない」の閾値（文字数）。凍結設計は「保守的な実装パラメータ」とだけ定める。
 * 検証フィクスチャの発火側は最長20文字（話題の継続の挨拶を除く日常発言）、守る側の深い相談の
 * 最新発言は30文字。25 を境にすると、日常の短い発言だけが整形候補になり、それ以上の長さの
 * 発言は常に全量配送（現状維持）になる。
 */
export const DELIVERY_SHAPING_MAX_CHARS = 25;

export interface DeliveryShapingInput {
  /** 今回のユーザーの発言 */
  text: string;
  persona: Persona;
  /** リアルタイム日記の会話なら true（整形しない） */
  realtimeDiary: boolean;
  /** 現在の会話のユーザー発言（最新が末尾） */
  recentUserTurns: readonly string[];
  /** 読み込み済みの Memory 全体（追加の読み込みはしない） */
  pool: MemoryObject[];
  /** 本人が確定した同じ人物の名前の組（Memory Graph と同じ入力） */
  personAliases: string[][];
  topicTimelineContext: readonly TopicTimeline[];
  memoryTimelineContext: readonly SynthesisThemeContext[];
  /** 拒否3：明示検索／集計が成立した発言か */
  explicitSearchPresent: boolean;
  memoryAnalyticsPresent: boolean;
}

export interface DeliveryShapingResult {
  /** 適用したプロファイル。null なら全量配送（入力の配列をそのまま返す） */
  profile: "T" | "P" | null;
  /** 整形しなかった理由（拒否の番号など。診断・テスト用で、どこにも送らない） */
  blockedBy?: string;
  topicTimelineContext: readonly TopicTimeline[];
  memoryTimelineContext: readonly SynthesisThemeContext[];
}

const includesTerm = (turn: string, term: string) => {
  const t = term.normalize("NFKC");
  return t.length > 0 && turn.normalize("NFKC").includes(t);
};

/** テーマがこの会話で初めて開かれたか：テーマの特徴語が過去のユーザー発言のどれにも出ていない */
function themeOpened(theme: string, pool: MemoryObject[], earlierTurns: readonly string[]): boolean {
  const terms = themeTerms(theme, pool);
  if (terms.length === 0) return false;
  return !earlierTurns.some((turn) => terms.some((term) => includesTerm(turn, term)));
}

/** topic がこの会話で初めて開かれたか：その topic の記録のキーワードが過去のユーザー発言のどれにも出ていない。キーワードが無ければ判定できないので「開かれていない」（全量配送）に倒す */
function topicOpened(topicId: string, pool: MemoryObject[], earlierTurns: readonly string[]): boolean {
  const keywords = new Set<string>();
  for (const memory of pool) {
    if (memory.topicId !== topicId) continue;
    for (const keyword of memory.keywords ?? []) {
      if (typeof keyword === "string" && keyword.trim().length > 0) keywords.add(keyword.trim());
    }
  }
  if (keywords.size === 0) return false;
  return !earlierTurns.some((turn) => [...keywords].some((keyword) => includesTerm(turn, keyword)));
}

/**
 * 経緯の配送を整形する。拒否が1つでもあれば入力をそのまま返す（profile: null）。
 * 例外は投げない方針だが、呼び出し側でも失敗時は整形なしで続行する。
 */
export function shapeDelivery(input: DeliveryShapingInput): DeliveryShapingResult {
  const unshaped: DeliveryShapingResult = {
    profile: null,
    topicTimelineContext: input.topicTimelineContext,
    memoryTimelineContext: input.memoryTimelineContext,
  };
  const blocked = (blockedBy: string): DeliveryShapingResult => ({ ...unshaped, blockedBy });

  // 対象範囲：companion / coach の通常会話だけ。整形する経緯が無ければ何もしない
  if (input.persona !== "companion" && input.persona !== "coach") return blocked("persona");
  if (input.realtimeDiary) return blocked("realtime-diary");
  if (input.topicTimelineContext.length === 0 && input.memoryTimelineContext.length === 0) return blocked("no-timeline");

  const text = input.text.trim();

  // ---- 拒否（1つでも立てば全量配送） ----
  if (isRecordRequestTurn(text)) return blocked("veto1-record-request");
  if (isReflectiveQuery(text)) return blocked("veto2-reflective");
  if (input.explicitSearchPresent || input.memoryAnalyticsPresent) return blocked("veto3-search-analytics");
  const purpose = purposeContextOf(text, input.pool);
  if (purpose.purpose !== null || purpose.reasonAsked === true) return blocked("veto4-purpose-reason");
  const person = resolveTurnPerson(input.pool, text, [...input.recentUserTurns], input.personAliases);
  if (asksPersonChange(text)) return blocked("veto5-person-change-phrasing");
  if (person && personChangeGate(text, person)) return blocked("veto5-person-change-gate");
  if (isRecallQuestion(text)) return blocked("veto6-recall");
  if (asksPastQuestion(text)) return blocked("veto7-past-question");
  if (input.memoryTimelineContext.some((context) => (context.corrections?.length ?? 0) > 0)) return blocked("veto8-corrections");
  if (Array.from(text).length > DELIVERY_SHAPING_MAX_CHARS) return blocked("veto9-not-short");

  // ---- Profile P：純粋な気持ちの共有（人物が特定でき、関係・気持ちの話） ----
  // 対比の足場になる「以前の別の状態」の行を取り、時点は本人が最後に話したものだけにする。
  // 状態そのもの（今の状態の行）は残す：今の気持ちへの応答に要るのは今の状態だから。
  const previousUserTurn = input.recentUserTurns.length >= 2 ? input.recentUserTurns[input.recentUserTurns.length - 2] : undefined;
  if (person && isRelationshipTalk(text, previousUserTurn)) {
    return {
      profile: "P",
      topicTimelineContext: input.topicTimelineContext.map((timeline) => ({
        ...timeline,
        events: selectTimelineEventsForBudget(timeline.events, 1),
      })),
      memoryTimelineContext: input.memoryTimelineContext.map((context) => ({
        ...context,
        state: { ...context.state, earlier: undefined },
        timeline: context.timeline.filter((point) => point.latestSaid === true),
      })),
    };
  }

  // ---- Profile T：話題を開いた発言 ----
  // 会話の続きを示す発言（「昨日の話だけど」等）では整形しない。テーマ／topic ごとに、
  // この会話で初めて開かれたものだけを絞る（途中で開かれた話題の経緯は従来どおり届ける）。
  if (hasTopicContinuitySignal(text)) return blocked("topic-continuity");
  const earlierTurns = input.recentUserTurns.slice(0, -1);
  let shapedAny = false;
  const memoryTimelineContext = input.memoryTimelineContext.map((context) => {
    if (!themeOpened(context.theme, input.pool, earlierTurns)) return context;
    shapedAny = true;
    // 状態ブロック（以前の状態の行を含む）はそのまま。時点は「状態の根拠」と「最後に話したもの」だけ
    return { ...context, timeline: context.timeline.filter((point) => point.stateBasis === true || point.latestSaid === true) };
  });
  const topicTimelineContext = input.topicTimelineContext.map((timeline) => {
    if (!topicOpened(timeline.topicId, input.pool, earlierTurns)) return timeline;
    shapedAny = true;
    // 引用だけのチャネル：最新の引用1件だけにする（状態文は作らない）
    return { ...timeline, events: selectTimelineEventsForBudget(timeline.events, 1) };
  });
  if (!shapedAny) return blocked("no-theme-opened");
  return { profile: "T", topicTimelineContext, memoryTimelineContext };
}
