/**
 * P1-H 段階2-A：完全な重複の削減（contextDedupe.ts）の開発用スイッチ（初期値OFF）。
 *   URLに `?contextDedupe=1` があるときだけON。`?contextDedupe=0`・パラメータ無し・ほかの値はOFF（`?debugLog=1`と同じく、URLだけで決める）。
 *   ブラウザには何も保存しない。以前の版がlocalStorageに残した `tsumugi.contextDedupe` は、読むたびに消す（使わない）。
 *   ストレージが使えなくても（プライベートモード等）判定は変わらず、アプリは止まらない。
 * OFFのときは、リクエストに何も足さない（サーバーは従来とまったく同じプロンプトを組み立てる）。
 */
export const CONTEXT_DEDUPE_FLAG_KEY = "tsumugi.contextDedupe";

export function contextDedupeEnabled(): boolean {
  let on = false;
  try {
    on = new URLSearchParams(window.location.search).get("contextDedupe") === "1";
  } catch {
    on = false;
  }
  // the earlier version kept the switch in localStorage: remove what it left (never read it)
  try {
    window.localStorage.removeItem(CONTEXT_DEDUPE_FLAG_KEY);
  } catch {
    // storage unavailable: nothing to remove, and the answer does not depend on it
  }
  return on;
}
