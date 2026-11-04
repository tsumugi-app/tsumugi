import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_CAPTURE_QUIET_MS, emptyAutoCaptureState, type AutoCaptureResult, type AutoCaptureState } from "./autoCapturePolicy";
import { runAutoCapture, type AutoCaptureDeps } from "./autoCaptureRun";
import type { Conversation } from "./types";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const conv = (id: string, ago = AUTO_CAPTURE_QUIET_MS) => ({
  id, status: "active", updatedAt: new Date(NOW - ago).toISOString(), memoryObjectIds: [], chatProviders: ["gemini"],
  turns: [{ role: "user", content: "架空", timestamp: "t" }, { role: "ai", content: "架空の返答", timestamp: "t" }],
}) as unknown as Conversation;

function setup(list: Conversation[], over: Partial<AutoCaptureDeps> = {}, result: () => AutoCaptureResult | Promise<AutoCaptureResult> = () => "saved") {
  const seen = { captured: [] as string[], statesAtCall: [] as AutoCaptureState[], state: emptyAutoCaptureState() };
  const deps: AutoCaptureDeps = {
    loadSettings: async () => ({ enabled: true, allowOtherProviders: false }),
    hasUserKey: async () => true,
    online: () => true,
    blocked: () => false,
    withRunLock: async (fn) => fn(),
    readConversations: async () => list,
    readConversation: async (id) => list.find((c) => c.id === id),
    conversationsWithMemory: async () => new Set(),
    readState: async () => seen.state,
    writeState: async (s) => { seen.state = s; },
    ifConversationFree: async (_id, fn) => ({ ran: true, value: await fn() }),
    capture: async (c) => { seen.captured.push(c.id); seen.statesAtCall.push(seen.state); return result(); },
    now: () => NOW,
    ...over,
  };
  return { deps, seen };
}

test("one conversation per run; the attempt is on record before the AI is called and gone after a success", async () => {
  const { deps, seen } = setup([conv("a", AUTO_CAPTURE_QUIET_MS * 2), conv("b")]);
  assert.equal(await runAutoCapture(deps), "saved");
  assert.deepEqual(seen.captured, ["a"]);
  assert.equal(seen.statesAtCall[0].conversations.a.lastKind, "started");
  assert.equal(seen.state.conversations.a, undefined);
  assert.equal(seen.state.recentRuns.length, 1);
});

test("no AI call while off, without a user key, offline, blocked, or in another tab's run", async () => {
  for (const [over, expected] of [
    [{ loadSettings: async () => ({ enabled: false, allowOtherProviders: true }) }, "off"],
    [{ hasUserKey: async () => false }, "no-key"],
    [{ online: () => false }, "offline"],
    [{ blocked: () => true }, "blocked"],
    [{ withRunLock: async () => null }, "blocked"],
  ] as const) {
    const { deps, seen } = setup([conv("a")], over as Partial<AutoCaptureDeps>);
    assert.equal(await runAutoCapture(deps), expected);
    assert.deepEqual(seen.captured, []);
    assert.deepEqual(seen.state, emptyAutoCaptureState());
  }
});

test("a conversation open in another tab is passed over for the next one, with nothing recorded for it", async () => {
  const { deps, seen } = setup([conv("open", AUTO_CAPTURE_QUIET_MS * 2), conv("free")], {
    ifConversationFree: async (id, fn) => (id === "open" ? { ran: false } : { ran: true, value: await fn() }),
  });
  assert.equal(await runAutoCapture(deps), "saved");
  assert.deepEqual(seen.captured, ["free"]);
});

test("decided again on what is stored after the locks: changed in between means no AI call", async () => {
  const { deps, seen } = setup([conv("a")], { readConversation: async () => ({ ...conv("a"), status: "captured" }) as Conversation });
  assert.equal(await runAutoCapture(deps), "nothing");
  assert.deepEqual(seen.captured, []);
  const second = setup([conv("a")], { conversationsWithMemory: (() => { let n = 0; return async () => (n++ === 0 ? new Set<string>() : new Set(["a"])); })() });
  assert.equal(await runAutoCapture(second.deps), "nothing");
  assert.deepEqual(second.seen.captured, []);
});

test("a failure is recorded, not thrown; a stale tab is thrown and costs no attempt", async () => {
  const failing = setup([conv("a")], {}, () => { throw Object.assign(new Error("x"), { name: "CaptureRequestError", status: 503 }); });
  assert.equal(await runAutoCapture(failing.deps), "http");
  assert.equal(failing.seen.state.conversations.a.attempts, 1);
  assert.equal(failing.seen.state.conversations.a.lastKind, "wait");
  const stale = setup([conv("a")], {}, () => { throw Object.assign(new Error("x"), { name: "StaleVaultTabError" }); });
  await assert.rejects(runAutoCapture(stale.deps), /x/);
  assert.deepEqual(stale.seen.state, emptyAutoCaptureState());
});

test("a Vault switch cancels the call, which costs no attempt", async () => {
  const { deps, seen } = setup([conv("a")], {
    capture: (_c, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })))),
  });
  assert.equal(await runAutoCapture(deps, { shouldCancel: () => true }), "cancelled");
  assert.deepEqual(seen.state, emptyAutoCaptureState());
});
