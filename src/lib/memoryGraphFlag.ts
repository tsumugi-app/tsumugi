/**
 * Developer switch for the Memory Graph P1 trial (default OFF), like the Memory Timeline switch: stored per browser in localStorage.
 *   open the app once with `?memoryGraph=1` to turn it on, `?memoryGraph=0` to turn it off. Without the key, it is off.
 * OFF sends exactly the conversation context the app sent before (no person context; the PersonView as before).
 */
export const MEMORY_GRAPH_FLAG_KEY = "tsumugi.memoryGraph";

export function memoryGraphEnabled(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("memoryGraph");
    if (param === "1") window.localStorage.setItem(MEMORY_GRAPH_FLAG_KEY, "1");
    else if (param === "0") window.localStorage.removeItem(MEMORY_GRAPH_FLAG_KEY);
    return window.localStorage.getItem(MEMORY_GRAPH_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
