/**
 * Asia/Tokyo（JST）基準の「今日」を一貫して扱うための最小限の共有ユーティリティ。
 * サーバー側（/api/capture、eventTimeResolver.ts経由）・クライアント側
 * （HistoryPanel.tsx・topPrompt.ts）の両方から使われるため、"use client"は付けない
 * （Intl.DateTimeFormatという環境非依存の標準Web APIのみに依存する）。
 *
 * `new Date().toISOString().slice(0, 10)`のようなUTC基準のスライスを「今日」の判定に
 * 使ってはいけない——日本時間0:00〜8:59の間はUTC側が前日になるため、日付跨ぎの
 * 前後で実際の日付とずれる（HistoryPanel.tsx/topPrompt.tsで実際に確認された不具合
 * パターン）。
 */

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
 * `getJstTodayDateString()`の結果からyear/monthだけを取り出す（HistoryPanel.tsxの
 * viewYear/viewMonth初期値用）。
 */
export function getJstYearMonth(now: Date = new Date()): { year: number; month: number } {
  const [year, month] = getJstTodayDateString(now).split("-").map(Number);
  return { year, month };
}
