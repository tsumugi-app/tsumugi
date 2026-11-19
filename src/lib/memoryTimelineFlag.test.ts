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

test("Memory Timeline switch: ON by default (standard configuration); ?memoryTimeline=0 opts this browser out, ?memoryTimeline=1 turns it back on", () => {
  const store = new Map<string, string>();
  fakeWindow("", store);
  assert.equal(memoryTimelineEnabled(), true, "default ON");
  fakeWindow("?memoryTimeline=0", store);
  assert.equal(memoryTimelineEnabled(), false);
  assert.equal(store.get(MEMORY_TIMELINE_FLAG_KEY), "0", "the opt-out is kept in this browser's localStorage only");
  fakeWindow("", store);
  assert.equal(memoryTimelineEnabled(), false, "stays off without the parameter");
  fakeWindow("?memoryTimeline=1", store);
  assert.equal(memoryTimelineEnabled(), true);
  assert.equal(store.get(MEMORY_TIMELINE_FLAG_KEY), "1");
  fakeWindow("", store);
  assert.equal(memoryTimelineEnabled(), true, "stays on without the parameter");
  fakeWindow("?memoryTimeline=yes", store);
  assert.equal(memoryTimelineEnabled(), true, "anything else does not change the setting");
  fakeWindow("?memoryTimeline=0", store);
  assert.equal(memoryTimelineEnabled(), false);
  fakeWindow("?memoryTimeline=yes", store);
  assert.equal(memoryTimelineEnabled(), false, "anything else does not lift the opt-out either");
});

test("Memory Timeline switch: when storage is unavailable (private mode, blocked), the URL parameter decides and the default is ON", () => {
  fakeWindow("?memoryTimeline=1", new Map(), true);
  assert.equal(memoryTimelineEnabled(), true);
  fakeWindow("?memoryTimeline=0", new Map(), true);
  assert.equal(memoryTimelineEnabled(), false);
  fakeWindow("", new Map(), true);
  assert.equal(memoryTimelineEnabled(), true, "no stored opt-out can exist, so the standard default applies");
});
