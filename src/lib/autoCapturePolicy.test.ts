import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_CAPTURE_DAY_MS, AUTO_CAPTURE_QUIET_MS, AUTO_CAPTURE_WAIT_MS, beginAutoCaptureAttempt, classifyAutoCaptureFailure, emptyAutoCaptureState, finishAutoCaptureAttempt, heldOnlyWithGemini,
  isStopped, parseAutoCaptureSettings, parseAutoCaptureState, selectAutoCaptureTargets, summarizeAutoCapture, withChatProvider, type AutoCaptureSettings,
} from "./autoCapturePolicy";
import type { Conversation } from "./types";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const ON: AutoCaptureSettings = { enabled: true, allowOtherProviders: true };
const conv = (id: string, agoMs = AUTO_CAPTURE_QUIET_MS, extra: Partial<Conversation> = {}) => ({
  id, status: "active", updatedAt: new Date(NOW - agoMs).toISOString(),
  turns: [{ role: "user", content: "架空", timestamp: "t" }, { role: "ai", content: "架空の返答", timestamp: "t" }], memoryObjectIds: [], ...extra,
}) as unknown as Conversation;
const ids = (list: Conversation[]) => list.map((c) => c.id);
const select = (list: Conversation[], state = emptyAutoCaptureState(), settings = ON, manual = false, memory: Set<string> = new Set()) => ids(selectAutoCaptureTargets(list, memory, state, settings, NOW, manual));

test("off until the user says otherwise, whatever is stored", () => {
  for (const raw of [undefined, "", "not json", "null", "{}", '{"enabled":"true"}']) assert.deepEqual(parseAutoCaptureSettings(raw), { enabled: false, allowOtherProviders: false });
  assert.equal(parseAutoCaptureSettings('{"enabled":true}').enabled, true);
  assert.deepEqual(parseAutoCaptureState("broken"), emptyAutoCaptureState());
});

test("30 minutes without an update, and no upper age limit", () => {
  assert.deepEqual(select([conv("now", 0), conv("just-under", AUTO_CAPTURE_QUIET_MS - 1), conv("exact"), conv("years", AUTO_CAPTURE_DAY_MS * 1000)]), ["years", "exact"]);
});

test("not sent: already captured, already has a Memory, no user words, no AI reply, blank reply only, ends in a cut reply", () => {
  const list = [
    conv("captured", undefined, { status: "captured" }),
    conv("has-memory"),
    conv("no-reply", undefined, { turns: [{ role: "user", content: "架空", timestamp: "t" }] }),
    conv("blank", undefined, { turns: [{ role: "user", content: "架空", timestamp: "t" }, { role: "ai", content: "  \n", timestamp: "t" }] }),
    conv("no-user", undefined, { turns: [{ role: "ai", content: "架空", timestamp: "t" }] }),
    conv("cut", undefined, { turns: [{ role: "user", content: "架空", timestamp: "t" }, { role: "ai", content: "架空", timestamp: "t", interrupted: true }] }),
  ];
  assert.deepEqual(select(list, undefined, ON, false, new Set(["has-memory"])), []);
});

test("another AI, or no record of which AI, needs the permission", () => {
  const list = [conv("gemini", undefined, { chatProviders: ["gemini"] }), conv("openai", undefined, { chatProviders: ["openai"] }), conv("mixed", undefined, { chatProviders: ["gemini", "openai"] }), conv("unknown")];
  assert.deepEqual(select(list, undefined, { enabled: true, allowOtherProviders: false }), ["gemini"]);
  assert.equal(select(list).length, 4);
  const fresh = conv("x", undefined, { turns: [] });
  assert.equal(heldOnlyWithGemini(withChatProvider(withChatProvider(fresh, "gemini"), "gemini")), true);
  assert.deepEqual(withChatProvider(withChatProvider(fresh, "gemini"), "openai").chatProviders, ["gemini", "openai"]);
  const asked = { ...fresh, chatProviders: [], turns: conv("asked").turns };
  assert.deepEqual(withChatProvider(asked, "gemini").chatProviders, ["gemini"], "a new conversation's first turn may be a past question");
  assert.equal(heldOnlyWithGemini(asked), false, "no AI on record yet");
  assert.deepEqual(withChatProvider(asked, "openai").chatProviders, ["openai"]);
  const resumed = withChatProvider(conv("old"), "gemini");
  assert.deepEqual(resumed.chatProviders, ["unknown", "gemini"], "an old conversation that goes on with Gemini is still unknown");
  assert.equal(heldOnlyWithGemini(resumed), false);
});

test("5 attempts in 24 hours, older ones no longer count", () => {
  let state = emptyAutoCaptureState();
  for (let i = 0; i < 5; i++) state = beginAutoCaptureAttempt(state, `a${i}`, NOW - 1000);
  assert.deepEqual(select([conv("next")], state), []);
  assert.deepEqual(select([conv("next")], { ...state, recentRuns: state.recentRuns.map(() => new Date(NOW - AUTO_CAPTURE_DAY_MS).toISOString()) }), ["next"]);
});

test("never tried first and oldest first, so a failing conversation does not hold back the others", () => {
  const list = [conv("failed-oldest", AUTO_CAPTURE_DAY_MS * 9), conv("new"), conv("old", AUTO_CAPTURE_DAY_MS)];
  const failed = finishAutoCaptureAttempt(beginAutoCaptureAttempt(emptyAutoCaptureState(), "failed-oldest", NOW - AUTO_CAPTURE_WAIT_MS), emptyAutoCaptureState(), "failed-oldest", "http");
  assert.deepEqual(select(list, failed), ["old", "new", "failed-oldest"]);
});

test("after an HTTP failure it waits; after a dropped connection or a closed app it goes at the next start; a refused key costs no attempt", () => {
  const empty = emptyAutoCaptureState();
  const started = beginAutoCaptureAttempt(empty, "c", NOW);
  assert.equal(started.recentRuns.length, 1);
  assert.deepEqual(select([conv("c")], started), ["c"], "closed during the call");
  assert.deepEqual(select([conv("c")], finishAutoCaptureAttempt(started, empty, "c", "network")), ["c"]);
  for (const r of ["http", "all-dropped", "save-failed"] as const) assert.deepEqual(select([conv("c")], finishAutoCaptureAttempt(started, empty, "c", r)), []);
  for (const r of ["key", "changed", "cancelled"] as const) {
    assert.equal(finishAutoCaptureAttempt(started, empty, "c", r).conversations.c, undefined);
    assert.equal(finishAutoCaptureAttempt(started, empty, "c", r).recentRuns.length, 1, "the request was made");
    assert.deepEqual(finishAutoCaptureAttempt(started, empty, "c", r, false), empty, "no request was made");
  }
  for (const r of ["saved", "empty", "deleted", "already"] as const) assert.equal(finishAutoCaptureAttempt(started, empty, "c", r).conversations.c, undefined);
});

test("3 attempts, then only the manual retry, which allows 3 more", () => {
  let state = emptyAutoCaptureState();
  for (let i = 0; i < 3; i++) state = finishAutoCaptureAttempt(beginAutoCaptureAttempt(state, "c", NOW), state, "c", "network");
  assert.ok(isStopped(state, "c"));
  assert.deepEqual(select([conv("c"), conv("other")], state), ["other"]);
  assert.deepEqual(select([conv("c"), conv("other")], state, ON, true), ["c"]);
  const again = beginAutoCaptureAttempt(state, "c", NOW, true);
  assert.equal(again.conversations.c.attempts, 1);
  const full = { ...state, recentRuns: Array(9).fill(new Date(NOW).toISOString()) };
  assert.deepEqual(select([conv("c")], full, ON, true), ["c"], "an explicit press is not held by the daily limit");
});

test("failures are told apart", () => {
  const http = (status: number) => Object.assign(new Error("x"), { name: "CaptureRequestError", status });
  for (const s of [400, 401, 403]) assert.equal(classifyAutoCaptureFailure(http(s), false), "key");
  for (const s of [429, 500, 503]) assert.equal(classifyAutoCaptureFailure(http(s), false), "http");
  assert.equal(classifyAutoCaptureFailure(Object.assign(new Error("x"), { name: "NoUserKeyError" }), false), "key");
  assert.equal(classifyAutoCaptureFailure(new TypeError("network"), false), "network");
  assert.equal(classifyAutoCaptureFailure(Object.assign(new Error("x"), { name: "AbortError" }), false), "network");
  assert.equal(classifyAutoCaptureFailure(Object.assign(new Error("x"), { name: "AbortError" }), true), "cancelled");
  assert.equal(classifyAutoCaptureFailure(Object.assign(new Error("x"), { name: "TombstonedRecordError" }), false), "deleted");
  assert.equal(classifyAutoCaptureFailure(new Error("indexeddb"), false), "save-failed");
});

test("the summary counts what waits, what needs permission and what stopped", () => {
  let state = emptyAutoCaptureState();
  for (let i = 0; i < 3; i++) state = beginAutoCaptureAttempt(state, "stopped", NOW);
  const list = [conv("stopped", undefined, { chatProviders: ["gemini"] }), conv("ok", undefined, { chatProviders: ["gemini"] }), conv("unknown")];
  assert.deepEqual(summarizeAutoCapture(list, new Set(), state, { enabled: true, allowOtherProviders: false }), { waiting: 1, stopped: 1, needsPermission: 1, heldForMemory: 0 });
});

test("a conversation that refers to Memories is not sent, automatically or by the manual retry, whether or not they are found", () => {
  const refers = conv("refers", undefined, { memoryObjectIds: ["memory-of-it"] });
  assert.deepEqual(select([refers, conv("free")]), ["free"]);
  let state = emptyAutoCaptureState();
  for (let i = 0; i < 3; i++) state = beginAutoCaptureAttempt(state, "refers", NOW);
  assert.deepEqual(select([refers], state, ON, true), [], "not by the manual retry either");
});

test("the summary keeps a conversation whose Memories are missing apart: not waiting, not stopped, not finished", () => {
  const settings = { enabled: true, allowOtherProviders: true };
  const missing = conv("missing", undefined, { memoryObjectIds: ["gone"] });
  assert.deepEqual(summarizeAutoCapture([missing, conv("free")], new Set(), emptyAutoCaptureState(), settings, new Set()), { waiting: 1, stopped: 0, needsPermission: 0, heldForMemory: 1 });
  assert.deepEqual(summarizeAutoCapture([missing], new Set(), emptyAutoCaptureState(), settings, new Set(["gone"])), { waiting: 0, stopped: 0, needsPermission: 0, heldForMemory: 0 }, "found, under another or no conversationId: nothing is missing");
  assert.deepEqual(summarizeAutoCapture([missing], new Set(["missing"]), emptyAutoCaptureState(), settings, new Set()), { waiting: 0, stopped: 0, needsPermission: 0, heldForMemory: 0 }, "it has a Memory");
});
