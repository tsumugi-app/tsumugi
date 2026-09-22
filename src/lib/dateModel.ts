/**
 * Logical Date（JST基準の「見える日付」）とStorage Bucket（Vault内部の保存単位。
 * 既存互換のためUTC基準のまま維持する日付キー）を明確に分離するための共有ユーティリティ。
 *
 * 背景（2026-09-22 JST日跨ぎ調査で確認された不具合の根本原因）：
 * Conversation/Memoryの実時刻（UTC ISO文字列）は常に正しい。しかし、Calendar・History・
 * 各種prompt等の表示側が、その日付部分を`slice(0, 10)`のようなUTCベースの文字列切り出しで
 * 求めていたため、JST 0:00〜8:59に作られた記録が「前日」として扱われていた
 * （UTCはJSTより9時間遅れるため、JST 0:00〜8:59はUTCでは前日15:00〜23:59にあたる）。
 *
 * 一方、Vault側の物理ファイル名・Registryの day key・History Indexの day
 * key（`fileNameFor`/`dayFileNameFor`、`src/lib/vault.ts`）は、既存Vaultとの
 * 後方互換のため、意図的にUTC基準のまま維持する（Storage Bucket）。
 *
 * したがって：
 * - ユーザー・AIに見せる日付、「今日」の判定 → 必ずこのファイルのLogical Date関数を使う。
 * - Vault内のファイル名・Registry/History Indexのkey（Storage Bucket） → 変更しない
 *   （`vault.ts`の`fileNameFor`/`dayFileNameFor`/`memoryObject.date.slice(0, 10)`等はそのまま）。
 *
 * Storage BucketをLogical Dateとして再解釈する（＝ユーザーに見せる）目的以外で、
 * このファイルの関数をVault書き込み側のpath/key計算に使ってはいけない。
 */

import { decodeTime } from "ulid";

export const JST_TIME_ZONE = "Asia/Tokyo";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 任意の時刻（ISO文字列・epoch ms・Date）から、Asia/Tokyo基準の暦日をYYYY-MM-DD形式で返す。
 * `getJstTodayDateString()`（jstDate.ts、「今の瞬間」専用）の一般化版——任意の過去/未来の
 * 瞬間に対しても同じ規則（Intl.DateTimeFormatによる環境非依存のタイムゾーン変換）を適用する。
 *
 * 不正な入力（parse不能な文字列等）の場合はnullを返す（呼び出し元がfail-softにfallbackできる
 * ようにする。例外は投げない——表示専用のヘルパーが例外で画面を壊してはいけないため）。
 */
export function jstDateOf(instant: string | number | Date): string | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/**
 * ULID文字列（`ulid`パッケージの`decodeTime`）から生成時刻を取り出し、そのAsia/Tokyo暦日を返す。
 * Conversation/Memory/ReflectionのidはすべてTsumugi自身が`ulid()`で採番するため
 * （capture.ts`createConversation`等）、id自体が信頼できる生成時刻を内包している。
 *
 * 主な用途：History Index v2のConversation行（`HistoryConversationSummary`）は本文
 * timestampを持たないため、追加のMarkdown readを行わずにこの関数でConversation Dateを
 * 近似する（`conversation.id`の生成時刻 ≈ `conversation.startedAt`。両者は
 * `createConversation`内で同期的に採番されるため、実務上ずれない）。
 *
 * decode失敗（不正な形式のid）の場合はnullを返す（fail-soft。例外は投げない）。
 */
export function jstDateOfUlid(id: string): string | null {
  try {
    const ms = decodeTime(id);
    return jstDateOf(ms);
  } catch {
    return null;
  }
}

/** YYYY-MM-DD形式の日付キーに対して、タイムゾーンに依存しない純粋な日付演算で±delta日する。
 *  UTC基準のDate.UTCだけを使う（ブラウザのローカルタイムゾーンやDSTには一切依存しない）。 */
export function addDaysToDateKey(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, date) + delta * 86_400_000;
  const next = new Date(ms);
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

/** Logical Date `day`について、UTC Storage Bucket上で参照しうる前日キー（`day`の1日前）。
 *  JST 0:00〜8:59の記録はUTC側では前日のバケットに置かれるため、Logical Date `day`の
 *  記録を漏れなく集めるには、Storage Bucket `day`自身に加えてこの前日バケットも見る必要がある
 *  （詳細はこのファイル冒頭のコメント、および`HistoryPanel.tsx`の該当コメント参照）。 */
export function previousDateKey(day: string): string {
  return addDaysToDateKey(day, -1);
}

/** YYYY-MM-DD形式の日付キーから、月Index（`.tsumugi/history/YYYY-MM.json`）のkey（YYYY-MM）を返す。 */
export function monthKeyOfDateKey(day: string): string {
  return day.slice(0, 7);
}
