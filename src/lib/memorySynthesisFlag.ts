/**
 * Developer switch for the Memory Synthesis S1 trial (default OFF). Stored per browser in localStorage, like the Memory Timeline switch:
 *   open the app once with `?memorySynthesis=1` to turn it on, `?memorySynthesis=0` to turn it off (the Synthesis data on the device is kept).
 * ON: after a session ends, Tsumugi may generate hypotheses (at most once a day), and a chat turn whose topic has a Memory Timeline also receives
 * the usable hypotheses of that theme. OFF: nothing is generated, nothing is read, and the chat request is exactly what it was before.
 */
export const MEMORY_SYNTHESIS_FLAG_KEY = "tsumugi.memorySynthesis";

export function memorySynthesisEnabled(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("memorySynthesis");
    if (param === "1") window.localStorage.setItem(MEMORY_SYNTHESIS_FLAG_KEY, "1");
    else if (param === "0") window.localStorage.removeItem(MEMORY_SYNTHESIS_FLAG_KEY);
    return window.localStorage.getItem(MEMORY_SYNTHESIS_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
