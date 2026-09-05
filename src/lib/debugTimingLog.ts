/**
 * TEMP-TEST：公開ベータで稀に発生する20〜40秒の異常遅延の原因切り分け用。
 * Android実機ではリモートデバッグ（chrome://inspect等）が使えない環境があるため、
 * 既存のconsole.logに加えて、同じ計測値をlocalStorageへ逐次追記し、`?debugLog=1`の
 * ときだけ表示される診断パネル（DebugTimingPanel）から実機だけで確認できるようにする。
 *
 * 会話内容・Memory本文・APIキー・個人情報・Memory ID等は一切保存しない。
 * イベント名・時刻・件数・duration/waitMs等の数値だけを保存する。
 *
 * 「ページがバックグラウンド復帰時に再読み込みされているのでは」という仮説そのものを
 * 検証する用途のため、ログはReact stateではなくlocalStorageに持つ（再読み込みで
 * 消えてしまうと、一番見たいタイミングの記録自体が失われるため）。
 *
 * 原因調査が終わり次第、このファイルと呼び出し箇所ごと削除すること。
 */
"use client";

const STORAGE_KEY = "tsumugi:debugTimingLog:v1";
const MAX_ENTRIES = 300;

export interface TimingLogEntry {
  ts: number;
  event: string;
  [key: string]: number | string;
}

function readEntries(): TimingLogEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TimingLogEntry[]) : [];
  } catch {
    return [];
  }
}

function writeEntries(entries: TimingLogEntry[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 診断ログの書き込み失敗は本体処理に一切影響させない（黙って諦めるだけでよい）。
  }
}

/**
 * 診断ログを1件追記する。paramsには数値のみを渡すこと（会話内容・IDなどの文字列情報は
 * 渡さない想定）。localStorageへの追記に失敗しても例外を投げない（呼び出し元の
 * Vault/Capture本体処理を絶対にブロック・失敗させないため）。
 */
export function logTimingEvent(event: string, params: Record<string, number> = {}): void {
  if (typeof window === "undefined") return;
  try {
    const entries = readEntries();
    entries.push({ ts: Date.now(), event, ...params });
    while (entries.length > MAX_ENTRIES) entries.shift();
    writeEntries(entries);
  } catch {
    // 診断ログの失敗は本体処理に一切影響させない。
  }
}

export function getTimingLog(): TimingLogEntry[] {
  if (typeof window === "undefined") return [];
  return readEntries();
}

export function clearTimingLog(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}

/**
 * ページのライフサイクル（load/visible/hidden）を記録するだけの、監視専用の副作用。
 * 既存のアプリロジックには一切影響しない（新しいイベントリスナーを追加するだけで、
 * 状態変更・画面制御は一切行わない）。このモジュールがバンドルにロードされるたびに
 * （＝ページがフルリロードされるたびに）1回だけpage:loadを記録する想定。
 */
if (typeof window !== "undefined" && typeof document !== "undefined") {
  logTimingEvent("Debug page:load");
  document.addEventListener("visibilitychange", () => {
    logTimingEvent(document.hidden ? "Debug page:hidden" : "Debug page:visible");
  });
}
