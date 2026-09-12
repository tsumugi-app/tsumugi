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

/**
 * TEMP-TEST：Android実機でのVault scan重複調査用。このモジュールが評価される
 * （＝ページが読み込まれる）たびに1回だけ生成される、使い捨てのランダムな識別子。
 * 同一タブ内での二重実行か、別タブ/別ウィンドウ由来かを、ログ上のinstanceIdの
 * 一致・不一致だけで判別するためのものであり、個人情報・セッション情報・
 * 実際のブラウザタブIDなどは一切含まない。永続化もしない（ページを読み込むたびに
 * 新しい値になる）。
 */
const instanceId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

export interface TimingLogEntry {
  ts: number;
  event: string;
  instanceId: string;
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
 * 診断ログを1件追記する。paramsには数値、または短い列挙値の文字列（例："granted"/
 * "opfs"/"connected"等の状態名）のみを渡すこと。会話内容・Memory本文・ファイル名・
 * パス・APIキー・個人情報・Memory ID等の実データは一切渡さない想定。localStorageへの
 * 追記に失敗しても例外を投げない（呼び出し元のVault/Capture本体処理を絶対に
 * ブロック・失敗させないため）。
 */
export function logTimingEvent(event: string, params: Record<string, number | string> = {}): void {
  if (typeof window === "undefined") return;
  try {
    const entries = readEntries();
    entries.push({ ts: Date.now(), event, instanceId, ...params });
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

/** 他モジュール（db.ts等）の計測ログでも同じ`document.hidden`表現を使えるようexport。 */
export function hiddenFlag(): number {
  if (typeof document === "undefined") return 0;
  return document.hidden ? 1 : 0;
}

let bootStartAt: number | null = null;
let bootPhasesDone = 0;
/** ChatScreen起動時の3つの起動処理（①Vault復元+flush+scan／②起動時Connectキャッチアップ／
 * ③起動時Captureキャッチアップ）を数える。処理内容・順序は一切変更せず、それぞれの
 * 開始・終了地点にログ呼び出しを1行ずつ追加するだけ。 */
const BOOT_TOTAL_PHASES = 3;

/**
 * ChatScreenマウント時、起動処理の一番最初（Vault復元effectの先頭）で1回だけ呼ぶこと。
 * 3つの起動処理が全て完了した時点で自動的にboot:endを記録する。
 */
export function markBootStart(): void {
  bootStartAt = Date.now();
  bootPhasesDone = 0;
  console.log(`[Startup] boot:start hidden=${hiddenFlag()}`);
  logTimingEvent("Startup boot:start", { hidden: hiddenFlag() });
}

/** 3つの起動処理のうち1つが完了するたびに呼ぶこと（成功・失敗どちらの経路でも）。 */
export function markBootPhaseDone(): void {
  bootPhasesDone += 1;
  if (bootPhasesDone >= BOOT_TOTAL_PHASES && bootStartAt !== null) {
    const totalMs = Date.now() - bootStartAt;
    console.log(`[Startup] boot:end totalMs=${totalMs} hidden=${hiddenFlag()}`);
    logTimingEvent("Startup boot:end", { totalMs, hidden: hiddenFlag() });
    bootStartAt = null;
  }
}

/** 起動時Connect/Captureキャッチアップの開始・終了だけを記録する最小限のログ。 */
export function logStartupCatchupStart(label: "connectCatchup" | "captureCatchup", count: number): void {
  console.log(`[Startup] ${label}:start count=${count} hidden=${hiddenFlag()}`);
  logTimingEvent(`Startup ${label}:start`, { count, hidden: hiddenFlag() });
}

export function logStartupCatchupEnd(label: "connectCatchup" | "captureCatchup", durationMs: number): void {
  console.log(`[Startup] ${label}:end durationMs=${durationMs} hidden=${hiddenFlag()}`);
  logTimingEvent(`Startup ${label}:end`, { durationMs, hidden: hiddenFlag() });
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
