/**
 * Memory Timeline is part of the beta standard configuration (adopted 2026-11-19 after the conversation-quality
 * verification; see docs/beta-standard-config.md): ON by default, with a per-browser opt-out kept in localStorage:
 *   open the app once with `?memoryTimeline=0` to turn it off for this browser, `?memoryTimeline=1` to turn it back on.
 * The opt-out is stored as the value "0"; without the key, it is ON. When storage is unavailable, the URL parameter
 * still decides for that load and the default is ON.
 * Nothing else changes with it: OFF sends exactly the conversation context the app sent before.
 */
export const MEMORY_TIMELINE_FLAG_KEY = "tsumugi.memoryTimeline";

export function memoryTimelineEnabled(): boolean {
  let param: string | null = null;
  try {
    param = new URLSearchParams(window.location.search).get("memoryTimeline");
  } catch {
    /* no readable URL: fall through to the stored opt-out / default */
  }
  if (param === "1" || param === "0") {
    try {
      window.localStorage.setItem(MEMORY_TIMELINE_FLAG_KEY, param);
    } catch {
      /* storage unavailable: the parameter still decides this load */
    }
    return param === "1";
  }
  try {
    return window.localStorage.getItem(MEMORY_TIMELINE_FLAG_KEY) !== "0";
  } catch {
    return true;
  }
}
