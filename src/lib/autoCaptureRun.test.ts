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
    vaultFileUnchanged: async () => true,
    capture: async (c, _signal, onRequestSent) => { onRequestSent(); seen.captured.push(c.id); seen.statesAtCall.push(seen.state); return result(); },
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

test("once a request was made the run ends there and the request stays counted, whatever became of its result", async () => {
  for (const result of ["changed", "already", "key", "cancelled", "network", "http", "save-failed", "all-dropped", "empty", "deleted"] as const) {
    const { deps, seen } = setup([conv("a", AUTO_CAPTURE_QUIET_MS * 2), conv("b")], {}, () => result);
    assert.equal(await runAutoCapture(deps), result);
    assert.deepEqual(seen.captured, ["a"], result);
    assert.equal(seen.state.recentRuns.length, 1, result);
  }
});

test("a thrown away result uses no attempt of the conversation, and the words go at the next start", async () => {
  const { deps, seen } = setup([conv("a")], {}, () => "changed");
  await runAutoCapture(deps);
  assert.equal(seen.state.conversations.a, undefined);
  await runAutoCapture(deps);
  assert.deepEqual(seen.captured, ["a", "a"]);
  assert.equal(seen.state.recentRuns.length, 2);
});

test("the key is gone by the time of the request: nothing was sent, nothing is counted, and the run ends", async () => {
  const { deps, seen } = setup([conv("a", AUTO_CAPTURE_QUIET_MS * 2), conv("b")], {
    capture: async (c) => { seen.captured.push(c.id); throw Object.assign(new Error("x"), { name: "NoUserKeyError" }); },
  });
  assert.equal(await runAutoCapture(deps), "key");
  assert.deepEqual(seen.captured, ["a"]);
  assert.deepEqual(seen.state, emptyAutoCaptureState());
});

test("5 requests in 24 hours, thrown away or refused ones included; a sixth start sends nothing", async () => {
  let n = 0;
  const { deps, seen } = setup([conv("a")], {}, () => (n++ % 2 === 0 ? "changed" : "key"));
  for (let i = 0; i < 5; i++) await runAutoCapture(deps);
  assert.equal(seen.captured.length, 5);
  assert.equal(await runAutoCapture(deps), "nothing");
  assert.equal(seen.captured.length, 5);
});

test("what ended before any request costs nothing and gives way to the next conversation", async () => {
  const sent: string[] = [];
  const { deps, seen } = setup([conv("a", AUTO_CAPTURE_QUIET_MS * 2), conv("b")], {
    capture: async (c, _signal, onRequestSent) => {
      if (c.id === "a") return "changed";
      onRequestSent(); sent.push(c.id); return "saved";
    },
  });
  assert.equal(await runAutoCapture(deps), "saved");
  assert.deepEqual(sent, ["b"]);
  assert.equal(seen.state.recentRuns.length, 1);
  assert.equal(seen.state.conversations.a, undefined);
});

test("a Vault file edited from outside: no request for it, nothing recorded, and the next conversation goes", async () => {
  const { deps, seen } = setup([conv("edited", AUTO_CAPTURE_QUIET_MS * 2), conv("b")], { vaultFileUnchanged: async (c) => c.id !== "edited" });
  assert.equal(await runAutoCapture(deps), "saved");
  assert.deepEqual(seen.captured, ["b"]);
  assert.equal(seen.state.recentRuns.length, 1);
});

test("a failure is recorded, not thrown; a stale tab is thrown and costs no attempt", async () => {
  const failing = setup([conv("a")], {}, () => { throw Object.assign(new Error("x"), { name: "CaptureRequestError", status: 503 }); });
  assert.equal(await runAutoCapture(failing.deps), "http");
  assert.equal(failing.seen.state.conversations.a.attempts, 1);
  assert.equal(failing.seen.state.conversations.a.lastKind, "wait");
  const stale = setup([conv("a")], { capture: async () => { throw Object.assign(new Error("x"), { name: "StaleVaultTabError" }); } });
  await assert.rejects(runAutoCapture(stale.deps), /x/);
  assert.deepEqual(stale.seen.state, emptyAutoCaptureState());
  const staleAfter = setup([conv("a")], {}, () => { throw Object.assign(new Error("x"), { name: "StaleVaultTabError" }); });
  await assert.rejects(runAutoCapture(staleAfter.deps), /x/);
  assert.equal(staleAfter.seen.state.conversations.a, undefined);
  assert.equal(staleAfter.seen.state.recentRuns.length, 1, "the request was made");
});

test("a Vault switch cancels the call: no attempt used, and the request stays counted", async () => {
  const { deps, seen } = setup([conv("a")], {
    capture: (_c, signal, onRequestSent) => { onRequestSent(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })))); },
  });
  assert.equal(await runAutoCapture(deps, { shouldCancel: () => true }), "cancelled");
  assert.equal(seen.state.conversations.a, undefined);
  assert.equal(seen.state.recentRuns.length, 1);
});
