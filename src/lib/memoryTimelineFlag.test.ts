import test from "node:test";
import assert from "node:assert/strict";
import { memoryTimelineEnabled, MEMORY_TIMELINE_FLAG_KEY } from "./memoryTimelineFlag";

function fakeWindow(search: string, store: Map<string, string>, throws = false) {
  const localStorage = {
    getItem: (k: string) => { if (throws) throw new Error("blocked"); return store.has(k) ? store.get(k)! : null; },
    setItem: (k: string, v: string) => { if (throws) throw new Error("blocked"); store.set(k, v); },
    removeItem: (k: string) => { if (throws) throw new Error("blocked"); store.delete(k); },
  };
  (globalThis as unknown as { window: unknown }).window = { location: { search }, localStorage };
}

test("Memory Timeline switch: OFF by default; ?memoryTimeline=1 turns it on for this browser, ?memoryTimeline=0 turns it off", () => {
  const store = new Map<string, string>();
  fakeWindow("", store);
  assert.equal(memoryTimelineEnabled(), false, "default OFF");
  fakeWindow("?memoryTimeline=1", store);
  assert.equal(memoryTimelineEnabled(), true);
  assert.equal(store.get(MEMORY_TIMELINE_FLAG_KEY), "1", "kept in this browser's localStorage only");
  fakeWindow("", store);
  assert.equal(memoryTimelineEnabled(), true, "stays on without the parameter");
  fakeWindow("?memoryTimeline=0", store);
  assert.equal(memoryTimelineEnabled(), false);
  assert.equal(store.has(MEMORY_TIMELINE_FLAG_KEY), false);
  fakeWindow("?memoryTimeline=yes", store);
  assert.equal(memoryTimelineEnabled(), false, "anything else does not turn it on");
});

test("Memory Timeline switch: when storage is unavailable (private mode, blocked), it is OFF", () => {
  fakeWindow("?memoryTimeline=1", new Map(), true);
  assert.equal(memoryTimelineEnabled(), false);
});
