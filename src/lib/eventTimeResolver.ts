/**
 * Time Axis Phase 2（Event Time, v1）。deterministicに解決できる、閉じた小さな相対日付
 * 表現だけをJST calendar dateから機械的に計算する。巨大な自然言語date parserは作らない
 * （v1では「今日」「昨日」「一昨日」「明日」「明後日」のみ）。
 *
 * 「deterministic resolverを最終決定者にする」設計：LLMには日付そのものを計算させず、
 * 「どの固定表現がこのMemoryの出来事を指しているか」というsemantic selection
 * （eventTimeSource）だけを選ばせる。実際の日付は、Captureリクエストを処理した
 * 同一のJST基準日（todayDateString）から、このモジュールのresolveEventTimeSourceDate()が
 * 機械的に計算し、LLM自身が返した日付があっても無視して上書きする（/api/capture/route.ts
 * 側で確定させる。呼び出し元の責務。クライアント側で別時刻に再計算してはいけない）。
 *
 * ここで解決できない表現（「3年前」「先週の日曜日」等）は対象外：それらについてはLLMに
 * 計算をさせるのではなく、確信が持てなければeventTimeを設定しない（prompt側の責務。
 * このモジュール自体は拡張しない）。
 *
 * /api/chatのbuildCurrentDateTimeContext()（route.ts）と同じくAsia/Tokyo基準で「現在」を
 * 計算するが、UTCのtoISOString().slice(0,10)は使わない（JST 00:00〜08:59台でUTC日付が
 * 前日にずれる既知の問題を、ここで新たに踏まないため）。chat/route.tsとの共通化は、
 * 変更範囲が不必要に広がるため行わず、この最小限の計算をCapture側専用に持つ。
 */
import type { EventTimePrecision } from "./types";

/** JST基準の「今日」をYYYY-MM-DD形式で返す。 */
export function getJstTodayDateString(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * "YYYY-MM-DD"の日付演算はUTCのcalendar componentだけで行う（サーバーの実行時刻の
 * ローカルタイムゾーンに依存しないようにするため）。すでにJST基準で確定した
 * calendar date文字列に対する、純粋なカレンダー演算であり、タイムゾーン変換は
 * これ以上発生しない。
 */
function addDaysToDateString(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * v1で対応する固定語彙。LLMのstructured outputはこのキーだけを選択し、日付そのものは
 * 計算しない（/api/capture/route.tsのMEMORIES_SCHEMA参照）。"none"は「この5表現の
 * どれにも対応しない」という判断結果そのものを表す値であり、Production実機テストで
 * eventTimeSourceがoptionalだったためにLLMが判断自体を省略してしまう事象が確認された
 * ことを受け、eventTimeSourceをrequiredにしたうえで追加した（値の断定を必須にする
 * わけではなく、判断を必須にするための選択肢）。
 */
export type EventTimeSource =
  | "today"
  | "yesterday"
  | "day-before-yesterday"
  | "tomorrow"
  | "day-after-tomorrow"
  | "none";

/** "none"以外の5値（実際に日付計算が必要なもの）だけのoffsetテーブル。 */
const EVENT_TIME_SOURCE_OFFSETS: Record<Exclude<EventTimeSource, "none">, number> = {
  today: 0,
  yesterday: -1,
  "day-before-yesterday": -2,
  tomorrow: 1,
  "day-after-tomorrow": 2,
};

const EVENT_TIME_SOURCES: readonly EventTimeSource[] = [...Object.keys(EVENT_TIME_SOURCE_OFFSETS), "none"] as EventTimeSource[];

/** LLMが返したeventTimeSourceが、v1で対応する6値（固定語彙5つ＋"none"）のいずれかであることを検証する。 */
export function isValidEventTimeSource(value: unknown): value is EventTimeSource {
  return typeof value === "string" && (EVENT_TIME_SOURCES as readonly string[]).includes(value);
}

/**
 * eventTimeSourceが指す確定日付を、todayDateString（そのCaptureリクエストで確定した
 * 同一のJST基準日）から計算する。"none"はここでは扱わない（呼び出し元が"none"かどうかを
 * 先に判定し、"none"の場合はこの関数を呼ばない責務を持つ）。sourceは事前に
 * isValidEventTimeSource()で検証されている前提。
 */
export function resolveEventTimeSourceDate(todayDateString: string, source: Exclude<EventTimeSource, "none">): string {
  return addDaysToDateString(todayDateString, EVENT_TIME_SOURCE_OFFSETS[source]);
}

const EVENT_TIME_PRECISIONS: readonly EventTimePrecision[] = ["day", "month", "year"];

/** precisionが3値のいずれかであることを検証する（無条件castしない）。 */
export function isValidEventTimePrecision(value: unknown): value is EventTimePrecision {
  return typeof value === "string" && (EVENT_TIME_PRECISIONS as readonly string[]).includes(value);
}

const EVENT_TIME_VALUE_PATTERN: Record<EventTimePrecision, RegExp> = {
  day: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-\d{2}$/,
  year: /^\d{4}$/,
};

/**
 * "YYYY-MM-DD"が実在するcalendar dateかを検証する（例：2026-02-30は形式は正しいが
 * 実在しないためfalse）。Date.UTCによるoverflow normalization後の年月日が、入力の
 * 年月日と一致するかで判定する（自前でうるう年・月末日数のテーブルを持たない）。
 */
function isRealCalendarDayDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * eventTimeの値が、指定されたprecisionにとって妥当か（架空の精度・実在しない暦日を
 * 含んでいないか）を検証する。形式（桁数）だけでなく、day精度では実在する暦日か、
 * month精度では01〜12の範囲かまで確認する（v1のyear精度は4桁の形式のみで十分とする）。
 * Capture側（LLM抽出結果）・Markdown復元側の両方から共通で呼ばれる。
 */
export function isValidEventTimeValue(value: unknown, precision: EventTimePrecision): value is string {
  if (typeof value !== "string" || !EVENT_TIME_VALUE_PATTERN[precision].test(value)) return false;

  if (precision === "day") {
    const [year, month, day] = value.split("-").map(Number);
    return isRealCalendarDayDate(year, month, day);
  }
  if (precision === "month") {
    const month = Number(value.split("-")[1]);
    return month >= 1 && month <= 12;
  }
  return true;
}
