/**
 * contextDedupeフラグ：URLの `?contextDedupe=1` だけでON（localStorageは使わない）。以前の保存値は消す。ほかのフラグの仕様は変えない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contextDedupeEnabled, CONTEXT_DEDUPE_FLAG_KEY } from "./contextDedupeFlag";
import { memoryGraphEnabled, MEMORY_GRAPH_FLAG_KEY } from "./memoryGraphFlag";
import { memoryTimelineEnabled, MEMORY_TIMELINE_FLAG_KEY } from "./memoryTimelineFlag";
import { memorySynthesisEnabled, MEMORY_SYNTHESIS_FLAG_KEY } from "./memorySynthesisFlag";

function fakeWindow(search: string, store: Map<string, string>, throws = false) {
  const localStorage = {
    getItem: (k: string) => { if (throws) throw new Error("blocked"); return store.has(k) ? store.get(k)! : null; },
    setItem: (k: string, v: string) => { if (throws) throw new Error("blocked"); store.set(k, v); },
    removeItem: (k: string) => { if (throws) throw new Error("blocked"); store.delete(k); },
  };
  (globalThis as unknown as { window: unknown }).window = { location: { search }, localStorage };
}

test("1 a stored \"1\" from the earlier version does not turn it on without the parameter, and it is removed", () => {
  const store = new Map([[CONTEXT_DEDUPE_FLAG_KEY, "1"]]);
  fakeWindow("?debugLog=1&memoryGraph=1&utm_source=x", store);
  assert.equal(contextDedupeEnabled(), false);
  assert.equal(store.has(CONTEXT_DEDUPE_FLAG_KEY), false, "the old value is removed");
  fakeWindow("", store);
  assert.equal(contextDedupeEnabled(), false);
});

test("2 only ?contextDedupe=1 turns it on (nothing is stored)", () => {
  const store = new Map<string, string>();
  fakeWindow("?contextDedupe=1", store);
  assert.equal(contextDedupeEnabled(), true);
  fakeWindow("?debugLog=1&contextDedupe=1", store);
  assert.equal(contextDedupeEnabled(), true);
  assert.equal(store.size, 0, "nothing written to localStorage");
  for (const search of ["?contextDedupe=true", "?contextDedupe=yes", "?contextDedupe=", "?contextDedupe", "?contextdedupe=1", "#contextDedupe=1"]) {
    fakeWindow(search, store);
    assert.equal(contextDedupeEnabled(), false, search);
  }
});

test("3 ?contextDedupe=0 is OFF", () => {
  const store = new Map([[CONTEXT_DEDUPE_FLAG_KEY, "1"]]);
  fakeWindow("?contextDedupe=0", store);
  assert.equal(contextDedupeEnabled(), false);
  assert.equal(store.has(CONTEXT_DEDUPE_FLAG_KEY), false);
});

test("4 from an ON URL to an OFF URL, nothing carries over", () => {
  const store = new Map<string, string>();
  fakeWindow("?contextDedupe=1", store);
  assert.equal(contextDedupeEnabled(), true);
  fakeWindow("", store);
  assert.equal(contextDedupeEnabled(), false, "no parameter after ON");
  fakeWindow("?contextDedupe=1", store);
  assert.equal(contextDedupeEnabled(), true);
  fakeWindow("?contextDedupe=0", store);
  assert.equal(contextDedupeEnabled(), false);
  fakeWindow("?debugLog=1", store);
  assert.equal(contextDedupeEnabled(), false);
});

test("5 storage unavailable: the URL still decides, and nothing throws; no window (server render): OFF", () => {
  fakeWindow("?contextDedupe=1", new Map(), true);
  assert.equal(contextDedupeEnabled(), true);
  fakeWindow("", new Map(), true);
  assert.equal(contextDedupeEnabled(), false);
  delete (globalThis as { window?: unknown }).window;
  assert.equal(contextDedupeEnabled(), false);
});

test("6 the other switches keep their own behaviour (stored in this browser, ?x=0 to turn off) and their values are untouched", () => {
  const store = new Map<string, string>([[MEMORY_GRAPH_FLAG_KEY, "1"], [MEMORY_TIMELINE_FLAG_KEY, "1"], [MEMORY_SYNTHESIS_FLAG_KEY, "1"], [CONTEXT_DEDUPE_FLAG_KEY, "1"]]);
  fakeWindow("", store);
  assert.equal(contextDedupeEnabled(), false);
  assert.equal(memoryGraphEnabled(), true, "Memory Graph stays on from the stored value");
  assert.equal(memoryTimelineEnabled(), true);
  assert.equal(memorySynthesisEnabled(), true);
  for (const k of [MEMORY_GRAPH_FLAG_KEY, MEMORY_TIMELINE_FLAG_KEY, MEMORY_SYNTHESIS_FLAG_KEY]) assert.equal(store.get(k), "1", `${k} untouched`);
  fakeWindow("?memoryGraph=0&contextDedupe=1", store);
  assert.equal(contextDedupeEnabled(), true);
  assert.equal(memoryGraphEnabled(), false);
  assert.equal(memoryTimelineEnabled(), true);
  // the source: the switch reads no storage value
  const src = fs.readFileSync(path.join(__dirname, "../../src/lib/contextDedupeFlag.ts"), "utf8").replace(/^\s*(?:\*|\/\/|\/\*\*).*$/gm, "");
  assert.ok(!/getItem|setItem/.test(src), "contextDedupe never reads or writes localStorage");
});
