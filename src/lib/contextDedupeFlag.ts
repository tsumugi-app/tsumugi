/**
 * P1-H 段階2-A：完全な重複の削減（contextDedupe.ts）は正式採用され、既定でON。
 *   一時的に無効化するときだけ、URLに `?contextDedupe=0` を付ける（`?debugLog=1`と同じく、URLだけで決める）。
 *   ブラウザには何も保存しない。以前の版がlocalStorageに残した `tsumugi.contextDedupe` は、読むたびに消す（使わない）。
 *   URLが読めない環境でも既定どおりONとして扱う。ストレージが使えなくても（プライベートモード等）判定は変わらず、アプリは止まらない。
 * OFFのときは、リクエストに何も足さない（サーバーは従来とまったく同じプロンプトを組み立てる）。
 */
export const CONTEXT_DEDUPE_FLAG_KEY = "tsumugi.contextDedupe";

export function contextDedupeEnabled(): boolean {
  let on = true;
  try {
    on = new URLSearchParams(window.location.search).get("contextDedupe") !== "0";
  } catch {
    on = true;
  }
  // the earlier version kept the switch in localStorage: remove what it left (never read it)
  try {
    window.localStorage.removeItem(CONTEXT_DEDUPE_FLAG_KEY);
  } catch {
    // storage unavailable: nothing to remove, and the answer does not depend on it
  }
  return on;
}
