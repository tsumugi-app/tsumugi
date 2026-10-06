/**
 * Temporal Phase 2A-1：Capture時のEvent Time確定（純粋関数）。時間表現の基準は**その表現をユーザーが発言したMessage Time**だけ。
 *
 * - 固定語（今日・昨日・一昨日・明日・明後日）：`eventTimeQuote`を、**検証済みevidenceのuser turnだけ**に照合し、一致したturnの
 *   timestampのJST暦日を基準に、サーバーが日付を計算する。LLMが返した日付は使わない。
 * - Memory.statedAt（複数evidenceの最新）は基準に使わない：quoteが属する発言とは限らないため。
 * - fail-closed：quoteが無い・どのevidence turnにも一致しない・一致したturnのtimestampが（1件でも）無効・一致したturnが
 *   異なるJST日に割れる、のいずれかなら、固定語の経路ではeventTime/eventTimePrecisionを**必ず除去**する（LLMの値へfallbackしない）。
 * - Capture実行時刻・最後の発言の日付・conversation.startedAtのような、会話全体で共通の「今日」は、時間解釈の基準に一切使わない。
 */
import { normalizeText } from "./profile";
import { jstDateOf } from "./dateModel";
import { isValidEventTimeSource, resolveEventTimeSourceDate } from "./eventTimeResolver";
import { validStatedAt } from "./markdown";

interface TurnLike { role?: string; content?: unknown; timestamp?: unknown }

/**
 * `evidenceTurns`は検証済みevidenceに対応するuser turnだけ。基準のJST暦日を返す（決められなければnull）。
 * 同じquoteが同じJST日の複数turnに一致する場合は、基準暦日が同じなので解決できる。異なるJST日なら決めない（latest/earliestを選ばない）。
 */
export function resolveEventTimeQuoteBasisJstDate(evidenceTurns: readonly TurnLike[], rawQuote: unknown): string | null {
  const quote = typeof rawQuote === "string" ? rawQuote.trim() : "";
  if (!quote) return null;
  const nq = normalizeText(quote);
  if (!nq) return null;

  const matched = evidenceTurns.filter((turn) => turn.role === "user" && typeof turn.content === "string" && normalizeText(turn.content).includes(nq));
  if (matched.length === 0) return null; // evidence以外・AI発言にしか無い、または存在しない

  const jstDates = new Set<string>();
  for (const turn of matched) {
    const instant = validStatedAt(turn.timestamp); // Phase 1Aと同じ「valid UTC ISO」の条件
    const day = instant === undefined ? null : jstDateOf(instant);
    if (day === null) return null; // 一致したturnのtimestampが1件でも無効なら、その日が違った可能性を排除できない
    jstDates.add(day);
  }
  return jstDates.size === 1 ? [...jstDates][0] : null;
}

/**
 * eventTimeSource / eventTimeQuote / eventTime を確定し、一時的なLLM判定情報（source・quote）を取り除く。
 * 固定語が選ばれた場合：解決できればサーバーが計算した日付、できなければeventTime/eventTimePrecisionを**除去**する
 * （LLMが偽の値を返していても残らない）。none・未指定・不正なsourceの場合は、従来どおり、LLMが会話に明示された内容から
 * 転記した値（あれば）だけをそのまま通す。
 */
export function finalizeEventTimeForMemory(memory: Record<string, unknown>, evidenceTurns: readonly TurnLike[]): Record<string, unknown> {
  const { eventTimeSource, eventTimeQuote, ...rest } = memory;
  if (isValidEventTimeSource(eventTimeSource) && eventTimeSource !== "none") {
    const { eventTime: _llmEventTime, eventTimePrecision: _llmPrecision, ...withoutLlmTime } = rest;
    void _llmEventTime; void _llmPrecision;
    const basisJstDate = resolveEventTimeQuoteBasisJstDate(evidenceTurns, eventTimeQuote);
    if (basisJstDate) {
      return { ...withoutLlmTime, eventTime: resolveEventTimeSourceDate(basisJstDate, eventTimeSource), eventTimePrecision: "day" };
    }
    return withoutLlmTime; // 根拠を検証できない → Event Timeを推測せず付けない（LLMの値も残さない）
  }
  return keepOnlyExplicitAbsoluteEventTime(rest, evidenceTurns);
}

/**
 * none・未指定・不正なsourceの経路。LLMが転記してよいのは、**発言自体に年が明示された絶対日付**だけ（「2026年10月5日」「2026年8月」「2024年」）。
 * eventTimeの年が、検証済みevidenceのuser発言の中に「YYYY年」（または YYYY/ YYYY- YYYY.）として実在しなければ、LLMが
 * Message Timeなしに補った年（「10月5日」「去年」「今年」「来年」の具体化）とみなして、eventTime/eventTimePrecisionを除去する。
 * 基準日（Capture日・最後の発言の日付・conversation.startedAt）はどこにも使わない。
 */
function keepOnlyExplicitAbsoluteEventTime(memory: Record<string, unknown>, evidenceTurns: readonly TurnLike[]): Record<string, unknown> {
  const { eventTime, eventTimePrecision, ...withoutTime } = memory;
  if (eventTime === undefined && eventTimePrecision === undefined) return memory;
  const year = typeof eventTime === "string" ? /^(\d{4})(?:-|$)/.exec(eventTime)?.[1] : undefined;
  if (year === undefined) return memory; // 形式不正はclient側の既存検証（isValidEventTimeValue）が落とす。ここでは従来どおり通す
  const marker = new RegExp(`(?<!\\d)${year}\\s*[年/.\\-]`);
  const grounded = evidenceTurns.some((turn) => turn.role === "user" && typeof turn.content === "string" && marker.test(normalizeText(turn.content)));
  return grounded ? memory : withoutTime;
}
