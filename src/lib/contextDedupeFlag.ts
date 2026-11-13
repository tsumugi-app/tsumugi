/**
 * P1-H 段階2-A：完全な重複の削減（contextDedupe.ts）の開発用スイッチ（初期値OFF）。Memory Graphのスイッチと同じく、このブラウザのlocalStorageに置く。
 *   一度 `?contextDedupe=1` で開くとON、`?contextDedupe=0` でOFF。キーが無ければOFF。
 * OFFのときは、リクエストに何も足さない（サーバーは従来とまったく同じプロンプトを組み立てる）。
 */
export const CONTEXT_DEDUPE_FLAG_KEY = "tsumugi.contextDedupe";

export function contextDedupeEnabled(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("contextDedupe");
    if (param === "1") window.localStorage.setItem(CONTEXT_DEDUPE_FLAG_KEY, "1");
    else if (param === "0") window.localStorage.removeItem(CONTEXT_DEDUPE_FLAG_KEY);
    return window.localStorage.getItem(CONTEXT_DEDUPE_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
