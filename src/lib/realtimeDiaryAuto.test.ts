// Realtime diary PR-C: the automatic finishing of diaries past 4:00. Only with the user's permission, only to the chosen AI with the user's own key,
// one diary per start, three tries per diary, and never a diary that is open, being written or finished elsewhere. Every word is fictional.
import test from "node:test";
import assert from "node:assert/strict";
import {
  REALTIME_DIARY_AUTO_MAX_ATTEMPTS, REALTIME_DIARY_AUTO_QUIET_MS, isPastUnfinishedDiary, parseRealtimeDiaryAutoSettings, runRealtimeDiaryAutoFinish, selectRealtimeDiaryAutoTargets,
  type RealtimeDiaryAutoDeps, type RealtimeDiaryAutoState,
} from "./realtimeDiaryAuto";
import { isUnprocessedConversation } from "./autoCapturePolicy";
import type { Conversation } from "./types";

const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = local(2026, 11, 8, 9, 0).getTime();
const T = (d: Date) => d.toISOString();
function diary(id: string, date: string, extra: Partial<Conversation> = {}): Conversation {
  const at = T(local(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)), 21, 0));
  return { id, persona: "companion", entryType: "diary", startedAt: at, status: "active", chatProviders: ["gemini"], memoryObjectIds: [], createdAt: at, updatedAt: at, realtimeDiary: { date },
    turns: [{ role: "user", content: "架空の出来事です", timestamp: at }, { role: "ai", content: "架空の返答です。", timestamp: at }],
    metadata: { id: `meta-${id}`, schemaVersion: "0.1", source: "ai-capture", createdAt: at, updatedAt: at }, ...extra };
}
const none: RealtimeDiaryAutoState = { diaries: {} };
const send = { allowOtherProviders: false };

test("the permission is off unless the user turned it on", () => {
  assert.deepEqual(parseRealtimeDiaryAutoSettings(undefined), { enabled: false });
  assert.deepEqual(parseRealtimeDiaryAutoSettings("not json"), { enabled: false });
  assert.deepEqual(parseRealtimeDiaryAutoSettings(JSON.stringify({ enabled: "yes" })), { enabled: false });
  assert.deepEqual(parseRealtimeDiaryAutoSettings(JSON.stringify({ enabled: true })), { enabled: true });
});

test("targets: diaries whose day ended (open, or ended but unfinished), quiet for a while, held with the chosen AI, oldest day first", () => {
  const open = diary("open", "2026-11-07");
  const older = diary("older", "2026-11-05", { endedAt: T(local(2026, 11, 5, 22, 0)), status: "captured" });
  const today = diary("today", "2026-11-08");
  const done = diary("done", "2026-11-06", { endedAt: T(local(2026, 11, 6, 22, 0)), status: "captured", realtimeDiary: { date: "2026-11-06", text: "架空の日記。" } });
  const todayEnded = diary("today-ended", "2026-11-08", { endedAt: T(local(2026, 11, 8, 8, 0)), updatedAt: T(local(2026, 11, 8, 8, 0)) });
  const fresh = diary("fresh", "2026-11-07", { updatedAt: new Date(NOW - REALTIME_DIARY_AUTO_QUIET_MS + 60_000).toISOString() });
  const openai = diary("openai", "2026-11-07", { chatProviders: ["openai"] });
  const all = [open, older, today, done, todayEnded, fresh, openai];
  assert.deepEqual(selectRealtimeDiaryAutoTargets(all, "2026-11-08", none, NOW, "gemini", send).map((c) => c.id), ["older", "open"]);
  // an ended diary is taken again at once (a start interrupted the last try): nobody can write in it any more
  const justEnded = diary("just-ended", "2026-11-07", { endedAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString() });
  assert.deepEqual(selectRealtimeDiaryAutoTargets([justEnded, fresh], "2026-11-08", none, NOW, "gemini", send).map((c) => c.id), ["just-ended"]);
  // another AI only with the same permission as the end of a conversation
  assert.deepEqual(selectRealtimeDiaryAutoTargets(all, "2026-11-08", none, NOW, "gemini", { allowOtherProviders: true }).map((c) => c.id), ["older", "open", "openai"]);
  // three tries, then only by hand
  const stopped: RealtimeDiaryAutoState = { diaries: { older: { attempts: REALTIME_DIARY_AUTO_MAX_ATTEMPTS, lastAttemptAt: T(local(2026, 11, 7, 9, 0)) } } };
  assert.deepEqual(selectRealtimeDiaryAutoTargets(all, "2026-11-08", stopped, NOW, "gemini", send).map((c) => c.id), ["open"]);
  // the diary closed on this screen at the day change: no wait
  assert.deepEqual(selectRealtimeDiaryAutoTargets(all, "2026-11-08", none, NOW, "gemini", send, "fresh").map((c) => c.id), ["fresh"]);
  // a diary is never also a target of the automatic Memory run for conversations
  for (const c of all) assert.equal(isUnprocessedConversation(c), false, c.id);
  assert.equal(isPastUnfinishedDiary(diary("archived", "2026-11-07", { status: "archived" }), "2026-11-08"), false);
});

function fakeDeps(conversations: Conversation[], over: Partial<RealtimeDiaryAutoDeps> = {}) {
  let state: RealtimeDiaryAutoState = { diaries: {} };
  const log = { finished: [] as { id: string; provider: string }[], states: [] as RealtimeDiaryAutoState[] };
  const deps: RealtimeDiaryAutoDeps = {
    loadSettings: async () => ({ enabled: true }),
    loadSendSettings: async () => send,
    selectedProvider: async () => "gemini",
    hasUserKey: async () => true,
    online: () => true,
    blocked: () => false,
    withRunLock: (fn) => fn(),
    readConversations: async () => conversations,
    readConversation: async (id) => conversations.find((c) => c.id === id),
    readState: async () => state,
    writeState: async (next) => { state = next; log.states.push(next); },
    ifDiaryFree: async (_id, fn) => ({ ran: true, value: await fn() }),
    vaultFileUnchanged: async () => true,
    finish: async (c, provider) => { log.finished.push({ id: c.id, provider }); return true; },
    today: () => "2026-11-08",
    now: () => NOW,
    ...over,
  };
  return { deps, log, state: () => state };
}

test("nothing is sent without the permission, without the user's own key, offline or while blocked", async () => {
  const c = [diary("open", "2026-11-07")];
  for (const [over, outcome] of [
    [{ loadSettings: async () => ({ enabled: false }) }, "off"],
    [{ hasUserKey: async () => false }, "no-key"],
    [{ online: () => false }, "offline"],
    [{ blocked: () => true }, "blocked"],
    [{ withRunLock: async () => null }, "blocked"],
  ] as const) {
    const { deps, log } = fakeDeps(c, over as Partial<RealtimeDiaryAutoDeps>);
    assert.equal(await runRealtimeDiaryAutoFinish(deps), outcome);
    assert.deepEqual(log.finished, []);
  }
});

test("one diary per start, to the chosen AI only; a finished diary leaves no record of tries", async () => {
  const { deps, log, state } = fakeDeps([diary("a", "2026-11-06"), diary("b", "2026-11-07")], { selectedProvider: async () => "openai", loadSendSettings: async () => ({ allowOtherProviders: true }) });
  assert.equal(await runRealtimeDiaryAutoFinish(deps), "finished");
  assert.deepEqual(log.finished, [{ id: "a", provider: "openai" }]);
  assert.deepEqual(state(), { diaries: {} });
  assert.equal(log.states[0].diaries.a.attempts, 1, "the try is written before the AI is called");
});

test("an unfinished result or a failure keeps the diary waiting and counts one try; after three tries it is left for the user", async () => {
  let calls = 0;
  const { deps, state } = fakeDeps([diary("a", "2026-11-07")], { finish: async () => { calls++; if (calls === 2) throw new Error("fictional network failure"); return false; } });
  for (let i = 0; i < REALTIME_DIARY_AUTO_MAX_ATTEMPTS; i++) assert.equal(await runRealtimeDiaryAutoFinish(deps), "partial");
  assert.equal(state().diaries.a.attempts, REALTIME_DIARY_AUTO_MAX_ATTEMPTS);
  assert.equal(await runRealtimeDiaryAutoFinish(deps), "nothing");
  assert.equal(calls, REALTIME_DIARY_AUTO_MAX_ATTEMPTS);
});

test("a diary open in a tab, being finished, edited in the Vault, or changed since the list was read is skipped without a try", async () => {
  const listed = diary("a", "2026-11-07");
  for (const over of [
    { ifDiaryFree: async () => ({ ran: false as const }) },
    { vaultFileUnchanged: async () => false },
    // finished by another device meanwhile: the stored record decides
    { readConversation: async () => ({ ...listed, endedAt: T(local(2026, 11, 7, 22, 0)), status: "captured" as const, realtimeDiary: { date: "2026-11-07", text: "架空の日記。" } }) },
    // written on again in the last minutes (another tab)
    { readConversation: async () => ({ ...listed, updatedAt: new Date(NOW - 60_000).toISOString() }) },
  ]) {
    const { deps, log } = fakeDeps([listed], over as Partial<RealtimeDiaryAutoDeps>);
    assert.equal(await runRealtimeDiaryAutoFinish(deps), "nothing");
    assert.deepEqual(log.finished, []);
    assert.deepEqual(log.states, []);
  }
});

test("a stale tab stops the run", async () => {
  const stale = Object.assign(new Error("stale"), { name: "StaleVaultTabError" });
  const { deps } = fakeDeps([diary("a", "2026-11-07")], { finish: async () => { throw stale; } });
  await assert.rejects(runRealtimeDiaryAutoFinish(deps), { name: "StaleVaultTabError" });
});
