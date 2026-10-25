/**
 * Developer switch for the Memory Timeline trial (default OFF). Stored per browser in localStorage, like the other per-device conveniences:
 *   open the app once with `?memoryTimeline=1` to turn it on, `?memoryTimeline=0` to turn it off. Without the key, it is off.
 * Nothing else changes with it: OFF sends exactly the conversation context the app sent before.
 */
export const MEMORY_TIMELINE_FLAG_KEY = "tsumugi.memoryTimeline";

export function memoryTimelineEnabled(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("memoryTimeline");
    if (param === "1") window.localStorage.setItem(MEMORY_TIMELINE_FLAG_KEY, "1");
    else if (param === "0") window.localStorage.removeItem(MEMORY_TIMELINE_FLAG_KEY);
    return window.localStorage.getItem(MEMORY_TIMELINE_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
