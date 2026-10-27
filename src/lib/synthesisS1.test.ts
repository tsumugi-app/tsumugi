/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Memory Synthesis S1: generation planning, the separation of hypotheses (cache) and the user's reactions (user data), the reaction gates
 * (clear denial only; unclear / agreement change nothing), corrected readings never coming back, failure isolation, the generation route's gates,
 * the full device wipe, and the static boundary (Synthesis code never writes Memories, the Vault, the Outbox or sync).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { fictionalSynthesisMemories } from "./synthesisFictionalData";
import {
  AGREEMENT_ONLY,
  eligibleEvidenceMemories,
  gateS1Items,
  keywordThemeId,
  planGeneration,
  SYNTHESIS_DB_NAME,
  themeSnapshot,
  unusableReason,
  usableItemsForChat,
  validateReactions,
  type ReactionCheck,
  type StoredHypothesis,
  type SynthesisState,
} from "./synthesisModel";
import { createMemorySynthesisStore, runSynthesisOnce, type SynthesisRunDeps } from "./synthesisRunner";
import { memorySynthesisEnabled, MEMORY_SYNTHESIS_FLAG_KEY } from "./memorySynthesisFlag";
import { runPendingWipe } from "./dataWipe";
import type { SynthesisCluster } from "./memorySynthesis";
import type { Conversation, MemoryObject } from "./types";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const H = 3_600_000;
const empty = (): SynthesisState => ({ hypotheses: [], reactions: [], themeStates: [], meta: null });

/** a fake /api/synthesize: for the "仕事" cluster, one change item over its first and last evidence (+ whatever extra the test asks for) */
function fakeApi(opts: { extraItems?: (c: SynthesisCluster) => unknown[]; reactions?: unknown[]; fail?: boolean } = {}) {
  const calls: { clusters: SynthesisCluster[]; rejected: unknown; checks: ReactionCheck[] }[] = [];
  const callApi: SynthesisRunDeps["callApi"] = async (payload) => {
    calls.push(payload as { clusters: SynthesisCluster[]; rejected: unknown; checks: ReactionCheck[] });
    if (opts.fail) throw new Error("network down");
    const clusters = payload.clusters as SynthesisCluster[];
    const items = clusters.flatMap((c) =>
      c.theme === "仕事"
        ? [{ kind: "change", statement: "以前は会社に残ると話していたが、その後デザインの勉強を始め、異動の話も出ている、と話している。", support: "derived", evidenceIds: [c.evidence[0].id, c.evidence[c.evidence.length - 1].id] }, ...(opts.extraItems?.(c) ?? [])]
        : []
    );
    return { items, reactions: opts.reactions ?? [] };
  };
  return { calls, callApi };
}

function deps(store: ReturnType<typeof createMemorySynthesisStore>, memories: MemoryObject[], api: SynthesisRunDeps["callApi"], now: number, conversations: Conversation[] = []): SynthesisRunDeps {
  let n = 0;
  return { store, readMemories: async () => memories, readConversations: async () => conversations, callApi: api, now: () => now, newId: () => `g${++n}-${now}` };
}

async function firstRun() {
  const memories = fictionalSynthesisMemories();
  const store = createMemorySynthesisStore();
  const api = fakeApi();
  const out = await runSynthesisOnce(deps(store, memories, api.callApi, NOW));
  return { memories, store, api, out };
}

function shownConversation(id: string, shownAt: number, userText: string): Conversation {
  const iso = (t: number) => new Date(t).toISOString();
  return {
    id,
    persona: "analyst",
    turns: [
      { role: "user", content: "今の会社、このままでいいと思う？", timestamp: iso(shownAt - 1000) },
      { role: "ai", content: "迷いの中心は、デザインの仕事に近づけるかどうかにあるように見えます。", timestamp: iso(shownAt + 1000) },
      { role: "user", content: userText, timestamp: iso(shownAt + 2000) },
    ],
  } as unknown as Conversation;
}

// ---------------------------------------------------------------------------

test("planning: a first run picks at most 4 themes by code; within 24h of an attempt nothing is called", () => {
  const memories = fictionalSynthesisMemories();
  const plan = planGeneration(empty(), memories, NOW);
  assert.equal(plan.due, true);
  assert.ok(plan.themes.length >= 1 && plan.themes.length <= 4);
  assert.ok(plan.themes.every((t) => t.reasons.includes("first")));
  assert.deepEqual(plan.clusters.map((c) => keywordThemeId(c.theme)), plan.themes.map((t) => t.themeId));
  const recent = planGeneration({ ...empty(), meta: { schemaVersion: 1, key: "run", lastAttemptAt: new Date(NOW - 2 * H).toISOString() } }, memories, NOW);
  assert.equal(recent.due, false);
  assert.equal(recent.why, "cooldown");
  assert.equal(planGeneration({ ...empty(), meta: { schemaVersion: 1, key: "run", lastAttemptAt: new Date(NOW - 25 * H).toISOString() } }, memories, NOW).due, true);
});

test("a successful run stores hypotheses as an AI cache (never Memories); the Memories it read are unchanged; a second run the same day makes no call", async () => {
  const memories = fictionalSynthesisMemories();
  const before = JSON.stringify(memories);
  const store = createMemorySynthesisStore();
  const api = fakeApi();
  const out = await runSynthesisOnce(deps(store, memories, api.callApi, NOW));
  assert.equal(out.status, "done");
  const s = store.snapshot();
  assert.ok(s.hypotheses.length >= 1);
  for (const h of s.hypotheses) {
    assert.equal(h.origin, "ai-synthesis");
    assert.equal(h.schemaVersion, 1);
    assert.equal(h.status, "active");
    assert.ok(h.evidence.every((e) => memories.some((m) => m.id === e.memoryId && m.updatedAt === e.updatedAt)));
  }
  assert.equal(s.reactions.length, 0);
  assert.equal(JSON.stringify(memories), before, "Memories are only read");
  // nothing changed: nothing to do; something changed but within 24h of the attempt: cooldown. Neither calls the AI.
  assert.equal((await runSynthesisOnce(deps(store, memories, api.callApi, NOW + H))).status, "nothing-to-do");
  const at = "2026-10-27T12:30:00.000Z";
  const more = [1, 2].map((i) => ({ ...memories[0], id: `m-new-${i}`, conversationId: `c-new-${i}`, statedAt: at, date: at, createdAt: at, updatedAt: at, keywords: ["仕事"], summary: `仕事の話をした${i}`, evidenceQuotes: [`仕事の話${i}`] }) as MemoryObject);
  assert.equal((await runSynthesisOnce(deps(store, [...memories, ...more], api.callApi, NOW + H))).status, "cooldown");
  assert.equal(api.calls.length, 1);
});

test("a failed run (network error / app closed) leaves hypotheses and reactions exactly as they were", async () => {
  const { memories, store } = await firstRun();
  const before = store.snapshot();
  const shown = { ...before.hypotheses[0], shownIn: [{ conversationId: "c-x", at: new Date(NOW + 1 * H).toISOString() }] };
  await store.commit({ putHypotheses: [shown] });
  const mid = store.snapshot();
  const out = await runSynthesisOnce(deps(store, memories, fakeApi({ fail: true }).callApi, NOW + 30 * H, [shownConversation("c-x", NOW + 1 * H, "それは違うよ")]));
  assert.equal(out.status, "failed");
  const after = store.snapshot();
  assert.deepEqual(after.hypotheses, mid.hypotheses);
  assert.deepEqual(after.reactions, mid.reactions);
  assert.equal(after.meta?.lastResult, "failed");
});

test("a clear correction is stored as the user's reaction (not as a hypothesis), the corrected reading is no longer used and is not generated again", async () => {
  const { memories, store } = await firstRun();
  const target = store.snapshot().hypotheses[0];
  const shownAt = NOW + 1 * H;
  await store.commit({ putHypotheses: [{ ...target, shownIn: [{ conversationId: "c-x", at: new Date(shownAt).toISOString() }] }] });
  const userText = "いや、デザインは趣味みたいなもので、仕事にしたいわけじゃないよ";
  const api = fakeApi({
    reactions: [{ hypothesisId: target.id, reaction: "corrected", userQuote: "仕事にしたいわけじゃない" }],
    // the model tries the same reading again in other words, and offers one new reading
    extraItems: (c) => [
      { kind: "change", statement: "以前は会社に残ると話していたが、その後デザインの勉強を始め、異動の話も出ていると話している。", support: "derived", evidenceIds: [c.evidence[0].id, c.evidence[c.evidence.length - 1].id] },
    ],
  });
  const out = await runSynthesisOnce(deps(store, memories, api.callApi, NOW + 30 * H, [shownConversation("c-x", shownAt, userText)]));
  assert.equal(out.status, "done");
  assert.equal(api.calls[0].checks.length, 1, "the user's answer was sent for judging, in the same call");
  const s = store.snapshot();
  assert.equal(s.reactions.length, 1);
  assert.equal(s.reactions[0].origin, "user-reaction");
  assert.equal(s.reactions[0].kind, "corrected");
  assert.equal(s.reactions[0].userQuote, "仕事にしたいわけじゃない");
  assert.equal(s.hypotheses.find((h) => h.id === target.id)?.status, "corrected");
  assert.ok(!s.hypotheses.some((h) => h.status === "active" && h.themeId === target.themeId && h.statement.includes("デザインの勉強を始め")), "the corrected reading is not generated again");
  const usable = usableItemsForChat(s, memories, NOW + 31 * H).items;
  assert.ok(!usable.some((i) => i.statement.includes("デザインの勉強を始め")), "and it never reaches a chat turn");
});

test("an unclear answer, an agreement or a quote that is not the user's changes nothing; the hypothesis stays exactly as it was", async () => {
  for (const [userText, quote] of [["うーん、どうだろうね", "どうだろうね"], ["そうかも", "そうかも"], ["そうなのかな", "それは違う"]] as const) {
    const { memories, store } = await firstRun();
    const target = store.snapshot().hypotheses[0];
    const shownAt = NOW + 1 * H;
    await store.commit({ putHypotheses: [{ ...target, shownIn: [{ conversationId: "c-y", at: new Date(shownAt).toISOString() }] }] });
    const api = fakeApi({ reactions: [{ hypothesisId: target.id, reaction: "rejected", userQuote: quote }] });
    // only the reaction check is due (no new Memories): the model would also return items, which must not replace the hypothesis
    await runSynthesisOnce(deps(store, memories, api.callApi, NOW + 30 * H, [shownConversation("c-y", shownAt, userText)]));
    const s = store.snapshot();
    assert.equal(s.reactions.length, 0, userText);
    const kept = s.hypotheses.find((h) => h.id === target.id);
    assert.equal(kept?.status, "active", userText);
    assert.equal(kept?.statement, target.statement, userText);
    assert.ok(kept?.reactionsCheckedThrough, "the answer is judged once, not again on every run");
  }
});

test("validateReactions: only a verbatim, clear denial of the user survives", () => {
  const check: ReactionCheck = { hypothesisId: "h1", theme: "仕事", statement: "x", conversationId: "c", tsumugiReply: "y", userTurns: [{ text: "いや、それは違うと思う。趣味で続けたいだけ", at: "2026-10-27T00:00:00.000Z" }, { text: "そうかも", at: "2026-10-27T00:01:00.000Z" }] };
  assert.equal(validateReactions({ reactions: [{ hypothesisId: "h1", reaction: "corrected", userQuote: "それは違うと思う" }] }, [check]).length, 1);
  assert.equal(validateReactions({ reactions: [{ hypothesisId: "h1", reaction: "rejected", userQuote: "そうかも" }] }, [check]).length, 0, "agreement");
  assert.equal(validateReactions({ reactions: [{ hypothesisId: "h1", reaction: "rejected", userQuote: "全然違う" }] }, [check]).length, 0, "not the user's words");
  assert.equal(validateReactions({ reactions: [{ hypothesisId: "h1", reaction: "confirmed", userQuote: "趣味で続けたいだけ" }] }, [check]).length, 0, "confirmed is never stored");
  assert.equal(validateReactions({ reactions: [{ hypothesisId: "h1", reaction: "corrected", userQuote: "趣味で続けたいだけ" }] }, [check]).length, 1, "the corrected part of an answer that denies");
  const soft: ReactionCheck = { ...check, userTurns: [{ text: "趣味で続けたいだけ", at: "2026-10-27T00:00:00.000Z" }, { text: "いや、複雑ってほどじゃないよ。口出しも別に気にしてないし", at: "2026-10-27T00:02:00.000Z" }] };
  assert.equal(validateReactions({ reactions: [{ hypothesisId: "h1", reaction: "rejected", userQuote: "趣味で続けたいだけ" }] }, [soft]).length, 0, "no denial in that answer");
  assert.equal(validateReactions({ reactions: [{ hypothesisId: "h1", reaction: "corrected", userQuote: "口出しも別に気にしてないし" }] }, [soft]).length, 1);
  assert.equal(validateReactions({ reactions: [{ hypothesisId: "other", reaction: "rejected", userQuote: "それは違うと思う" }] }, [check]).length, 0, "unknown hypothesis");
  assert.ok(AGREEMENT_ONLY.test("そうかも。") && AGREEMENT_ONLY.test("たしかに") && !AGREEMENT_ONLY.test("そうかも、でも仕事にはしたくない"));
});

test("gateS1Items: a joined sentence is never 'stated'; an unspoken cause must be a possibility or the item is dropped", () => {
  const cluster: SynthesisCluster = { theme: "仕事", evidence: [
    { id: "e1", conversationId: "c1", statedAt: "2026-04-05T12:00:00.000Z", statedAtIsRecordDate: false, summary: "来年は管理職の試験を受けたいと話した。" },
    { id: "e2", conversationId: "c2", statedAt: "2026-09-06T12:00:00.000Z", statedAtIsRecordDate: false, summary: "9月から時短勤務になったと話した。" },
  ] };
  const base = { kind: "change" as const, theme: "仕事", evidenceIds: ["e1", "e2"], firstStatedAt: "2026-04-05T12:00:00.000Z", lastStatedAt: "2026-09-06T12:00:00.000Z" };
  const plain = gateS1Items([{ ...base, statement: "管理職の試験を受けたいと話していたが、9月から時短勤務になったと話している。", support: "stated" }], [cluster]);
  assert.equal(plain.items[0].support, "derived");
  const cause = gateS1Items([{ ...base, statement: "家庭を優先するために試験を見送り、時短勤務になった。", support: "stated" }], [cluster]);
  assert.equal(cause.items.length, 0);
  assert.equal(cause.dropped, 1);
  const hedged = gateS1Items([{ ...base, statement: "家庭を優先するために、試験より時短勤務を選んだのかもしれない。", support: "derived" }], [cluster]);
  assert.equal(hedged.items[0].support, "hypothesis");
});

test("an agreement captured from a conversation where a hypothesis was used is not evidence; the user's substantive words still are", () => {
  const memories = fictionalSynthesisMemories();
  const at = "2026-10-26T12:00:00.000Z";
  const mk = (id: string, quote: string) => ({ ...memories[0], id, conversationId: "c-shown", statedAt: at, date: at, createdAt: at, updatedAt: at, summary: `${quote}と話した。`, content: quote, evidenceQuotes: [quote] }) as MemoryObject;
  const agree = mk("m-agree", "そうかも");
  const said = mk("m-said", "デザインは仕事じゃなくて趣味として続けたい");
  const hyp = { shownIn: [{ conversationId: "c-shown", at }] } as unknown as StoredHypothesis;
  const eligible = eligibleEvidenceMemories([...memories, agree, said], [hyp]).map((m) => m.id);
  assert.ok(!eligible.includes("m-agree"));
  assert.ok(eligible.includes("m-said"));
});

test("read time: a deleted or edited evidence Memory, a changed theme state, old evidence or a resemblance to a reaction makes a hypothesis unusable", async () => {
  const { memories, store } = await firstRun();
  const s = store.snapshot();
  const h = s.hypotheses[0];
  const byId = (ms: MemoryObject[]) => new Map(ms.map((m) => [m.id, m] as const));
  const fp = themeSnapshot(h.themeLabel, memories).stateFingerprint;
  assert.equal(unusableReason(h, byId(memories), fp, [], NOW), null);
  assert.equal(unusableReason(h, byId(memories.filter((m) => m.id !== h.evidence[0].memoryId)), fp, [], NOW), "missing-evidence");
  assert.equal(unusableReason(h, byId(memories.map((m) => (m.id === h.evidence[0].memoryId ? { ...m, updatedAt: "2026-10-27T00:00:00.000Z" } : m))), fp, [], NOW), "edited-evidence");
  assert.equal(unusableReason(h, byId(memories), "実施済み|other", [], NOW), "state-changed");
  assert.equal(unusableReason(h, byId(memories), fp, [], NOW + 400 * 24 * H), "expired");
  const reaction = { schemaVersion: 1 as const, origin: "user-reaction" as const, id: "r", themeId: h.themeId, themeKind: "keyword" as const, themeLabel: h.themeLabel, kind: "rejected" as const, hypothesisStatement: h.statement, hypothesisEvidenceIds: h.evidence.map((e) => e.memoryId), userQuote: "違う", conversationId: "c", saidAt: "x", recordedAt: "x" };
  assert.equal(unusableReason(h, byId(memories), fp, [reaction], NOW), "resembles-reaction");
  // deleting the evidence Memory also keeps it out of the chat
  assert.equal(usableItemsForChat(s, memories.filter((m) => m.id !== h.evidence[0].memoryId), NOW).items.some((i) => i.statement === h.statement), false);
});

test("a state change of the theme makes the theme due again, ahead of plain new evidence", async () => {
  const { memories, store } = await firstRun();
  const s = store.snapshot();
  const theme = s.themeStates.find((t) => t.themeLabel === "仕事");
  assert.ok(theme);
  const at = "2026-10-26T12:00:00.000Z";
  const decided = { ...memories[0], id: "m-decided", conversationId: "c-new", statedAt: at, date: at, createdAt: at, updatedAt: at, keywords: ["仕事", "異動"], summary: "デザイン部門への異動が正式に決まり、来月から異動になったと話した。", content: "異動になった", evidenceQuotes: ["異動、正式に決まった！"] } as MemoryObject;
  const plan = planGeneration({ ...s, meta: null }, [...memories, decided], NOW + 30 * H);
  const work = plan.themes.find((t) => t.themeLabel === "仕事");
  assert.ok(work && work.reasons.includes("state-changed"));
  assert.equal(plan.themes[0].themeLabel, "仕事", "state changes come first");
});

test("reactions are user data: no generation removes them, and they are kept apart from the hypothesis cache", async () => {
  const { memories, store } = await firstRun();
  const reaction = { schemaVersion: 1 as const, origin: "user-reaction" as const, id: "r-keep", themeId: "kw:仕事", themeKind: "keyword" as const, themeLabel: "仕事", kind: "rejected" as const, hypothesisStatement: "仕事より家族を優先したいのかもしれない", hypothesisEvidenceIds: [], userQuote: "それは違う", conversationId: "c", saidAt: "2026-10-26T00:00:00.000Z", recordedAt: "2026-10-26T00:00:00.000Z" };
  await store.commit({ addReactions: [reaction] });
  const at = "2026-10-26T12:00:00.000Z";
  const more = [1, 2].map((i) => ({ ...memories[0], id: `m-more-${i}`, conversationId: `c-more-${i}`, statedAt: at, date: at, createdAt: at, updatedAt: at, keywords: ["仕事"], summary: `仕事の話をした${i}`, evidenceQuotes: [`仕事の話${i}をした`] }) as MemoryObject);
  await runSynthesisOnce(deps(store, [...memories, ...more], fakeApi().callApi, NOW + 30 * H));
  assert.deepEqual(store.snapshot().reactions, [reaction]);
});

// ---------------------------------------------------------------------------
// the generation route, with a fake AI provider
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, "..");
const providerOut = { text: "" };
const resolveStub = { getProvider: () => ({ async generateStructured() { return { text: providerOut.text }; } }), resolveApiKey: () => "k", resolveModel: () => "m", resolveProviderForFeature: () => "gemini" };
const mod = Module as unknown as { _load: (r: string, p?: { filename?: string }, m?: boolean) => unknown; _resolveFilename: (r: string, ...rest: unknown[]) => string };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "@/lib/ai/resolve") return resolveStub;
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};

test("route: only real evidence, nothing resembling a rejected reading, and only verbatim clear denials come back", async () => {
  const route = require(path.join(ROOT, "app/api/synthesize/route.js")) as { POST: (r: Request) => Promise<Response> };
  const plan = planGeneration(empty(), fictionalSynthesisMemories(), NOW);
  const work = plan.clusters.find((c) => c.theme === "仕事")!;
  const ids = [work.evidence[0].id, work.evidence[work.evidence.length - 1].id];
  providerOut.text = JSON.stringify({
    items: [
      { kind: "change", statement: "会社に残ると話していたが、その後デザインの勉強を始めたと話している。", support: "derived", evidenceIds: ids },
      { kind: "change", statement: "作られた根拠", support: "derived", evidenceIds: ["made-up-1", "made-up-2"] },
      { kind: "change", statement: "仕事より家族を優先したいと考えるようになったと話している。", support: "derived", evidenceIds: ids },
    ],
    reactions: [
      { hypothesisId: "h1", reaction: "corrected", userQuote: "仕事にしたいわけじゃない" },
      { hypothesisId: "h2", reaction: "rejected", userQuote: "どうだろう" },
    ],
  });
  const checks = [
    { hypothesisId: "h1", theme: "仕事", statement: "a", conversationId: "c", tsumugiReply: "r", userTurns: [{ text: "デザインは趣味で、仕事にしたいわけじゃない", at: "2026-10-27T00:00:00.000Z" }] },
    { hypothesisId: "h2", theme: "仕事", statement: "b", conversationId: "c", tsumugiReply: "r", userTurns: [{ text: "うーん、どうだろう", at: "2026-10-27T00:00:00.000Z" }] },
  ];
  const res = await route.POST(new Request("http://x/api/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clusters: plan.clusters, rejected: [{ theme: "仕事", statement: "仕事より家族を優先したいと考えるようになったと話している。", userQuote: "違う" }], checks }) }));
  const out = (await res.json()) as { items: { statement: string }[]; reactions: { hypothesisId: string }[]; dropped: Record<string, number> };
  assert.deepEqual(out.items.map((i) => i.statement), ["会社に残ると話していたが、その後デザインの勉強を始めたと話している。"]);
  assert.equal(out.dropped["unknown-evidence"], 1);
  assert.equal(out.dropped["resembles-rejected"], 1);
  assert.deepEqual(out.reactions.map((r) => r.hypothesisId), ["h1"]);
});

// ---------------------------------------------------------------------------
// wipe, switch, static boundary
// ---------------------------------------------------------------------------

test("the full device wipe deletes the Synthesis database too (also where indexedDB.databases() is unavailable)", async () => {
  const deleted: string[] = [];
  const req = () => ({}) as Record<string, ((...a: unknown[]) => void) | unknown>;
  const factory = {
    deleteDatabase(name: string) {
      deleted.push(name);
      const r = req();
      setTimeout(() => (r.onsuccess as () => void)?.());
      return r;
    },
    open() {
      const r = req();
      setTimeout(() => {
        r.transaction = { abort() {} };
        (r.onupgradeneeded as () => void)?.();
        r.result = { close() {} };
        (r.onsuccess as () => void)?.();
      });
      return r;
    },
  } as unknown as IDBFactory;
  const ls = new Map<string, string>([["tsumugi:wipe:v1", "{}"], [MEMORY_SYNTHESIS_FLAG_KEY, "1"]]);
  const storage = { get length() { return ls.size; }, key: (i: number) => [...ls.keys()][i] ?? null, getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) };
  const result = await runPendingWipe({ indexedDB: factory, localStorage: storage, sessionStorage: null, getOpfsRoot: null });
  assert.equal(result.status, "completed");
  assert.ok(deleted.includes(SYNTHESIS_DB_NAME));
  assert.ok(!ls.has(MEMORY_SYNTHESIS_FLAG_KEY), "the trial switch goes with it");
});

test("the trial switch is OFF by default; ?memorySynthesis=1 / =0 turn it on / off for this browser", () => {
  const store = new Map<string, string>();
  const win = (search: string) => {
    (globalThis as unknown as { window: unknown }).window = { location: { search }, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
  };
  win("");
  assert.equal(memorySynthesisEnabled(), false);
  win("?memorySynthesis=1");
  assert.equal(memorySynthesisEnabled(), true);
  win("");
  assert.equal(memorySynthesisEnabled(), true);
  win("?memorySynthesis=0");
  assert.equal(memorySynthesisEnabled(), false);
});

test("static boundary: Synthesis code reads Memories / Conversations only, never writes them, the Vault, the Outbox or sync, and has its own database", () => {
  const REPO = path.join(__dirname, "..", "..");
  const src = (rel: string) => fs.readFileSync(path.join(REPO, "src", rel), "utf8");
  const files = ["lib/synthesisModel.ts", "lib/synthesisRunner.ts", "lib/synthesisChat.ts", "lib/synthesisStore.ts", "lib/memorySynthesisFlag.ts", "app/api/synthesize/route.ts", "components/SynthesisDataPanel.tsx", "app/synthesis-data/page.tsx"];
  for (const f of files) {
    const text = src(f);
    for (const m of text.matchAll(/from "([^"]+)"/g)) {
      const spec = m[1].replace("vaultWorldLock", "");
      assert.ok(!/vault|outbox|capture|connect|sync|recordAdapter|dataLifecycle|memoryRepair/i.test(spec), `${f} imports ${m[1]}`);
    }
    const dbImport = text.match(/import \{([^}]+)\} from "\.\/db"/);
    if (dbImport) assert.deepEqual(dbImport[1].split(",").map((x) => x.trim()).sort(), ["getAllConversations", "getAllMemoryObjects", "loadApiKey"], `${f} may only read from db.ts`);
    assert.ok(!/putMemoryObject|deleteMemory|putConversation|enqueue|writeMemoryObjectMarkdown|persistCapture/.test(text), `${f} must not write Memories / Conversations / the Vault`);
  }
  const store = src("lib/synthesisStore.ts");
  assert.ok(/openDB\(SYNTHESIS_DB_NAME/.test(store) && !/openDB\("tsumugi"/.test(store), "its own database, never the Memory database");
  assert.ok(/isWipePending\(\)/.test(store), "never opened while the device wipe is pending");
  assert.ok(/"tsumugi-synthesis"/.test(src("lib/dataWipe.ts")), "the full wipe knows the database by name");
});
