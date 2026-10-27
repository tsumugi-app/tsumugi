/**
 * Memory Synthesis S1: one generation run after a session ended. Everything it touches comes in through `SynthesisRunDeps`, so the same code runs with
 * the device's Synthesis database (synthesisChat.ts), with an in-memory store (tests, the Preview comparison) and never with the Memory store:
 * Memories and Conversations are only READ (`readMemories` / `readConversations`); the only writes go to the Synthesis store, in one `commit` per run.
 *
 * Order of a run:
 *   1. plan by code (no AI): which themes need generating and why; nothing to do, or generated less than 24h ago -> stop (no AI call)
 *   2. the attempt time is committed first, so a second tab or a crash right after cannot make a second call the same day
 *   3. one /api/synthesize call: new items for the planned themes + a judgment of how the user answered where a hypothesis was used
 *   4. the result is checked again here (same gates as the route) and applied in one commit; a failure commits only the bookkeeping
 * An interrupted run (app closed, network error) leaves the hypotheses and the user's reactions exactly as they were.
 */
import type { Conversation, MemoryObject } from "./types";
import { validateSynthesisItems, type SynthesisItem } from "./memorySynthesis";
import {
  applyGenerationResult,
  buildReactionChecks,
  failureChanges,
  gateS1Items,
  planGeneration,
  rejectedForPrompt,
  SYNTHESIS_S1_LIMITS,
  SYNTHESIS_SCHEMA_VERSION,
  validateReactions,
  type ReactionCheck,
  type SynthesisChanges,
  type SynthesisState,
} from "./synthesisModel";

export interface SynthesisStorePort {
  load(): Promise<SynthesisState>;
  commit(changes: SynthesisChanges): Promise<void>;
  /** atomically: false when an attempt was recorded less than `minHours` before `at`; otherwise records `at` as the attempt and returns true */
  claimRun(at: string, minHours: number): Promise<boolean>;
}

export interface SynthesisRunDeps {
  store: SynthesisStorePort;
  readMemories(): Promise<MemoryObject[]>;
  readConversations(): Promise<Conversation[]>;
  callApi(payload: { clusters: unknown; rejected: unknown; checks: ReactionCheck[] }): Promise<{ items?: unknown; reactions?: unknown }>;
  now(): number;
  newId(): string;
}

export type SynthesisRunOutcome =
  | { status: "nothing-to-do" }
  | { status: "cooldown" }
  | { status: "failed"; error: string }
  | { status: "done"; themes: string[]; added: number; reactions: number; kept: number };

export async function runSynthesisOnce(deps: SynthesisRunDeps): Promise<SynthesisRunOutcome> {
  const state = await deps.store.load();
  const memories = await deps.readMemories();
  const now = deps.now();
  const plan = planGeneration(state, memories, now);
  if (!plan.due) return { status: plan.why === "cooldown" ? "cooldown" : "nothing-to-do" };

  // one attempt per device per day, also across tabs: the claim is a single read-and-write of the store
  if (!(await deps.store.claimRun(new Date(now).toISOString(), SYNTHESIS_S1_LIMITS.minHoursBetweenRuns))) return { status: "cooldown" };

  const { checks, examinedThrough } = buildReactionChecks(plan, state, await deps.readConversations());
  let response: { items?: unknown; reactions?: unknown };
  try {
    response = await deps.callApi({ clusters: plan.clusters, rejected: rejectedForPrompt(state, plan), checks });
  } catch (error) {
    await deps.store.commit(failureChanges(state, plan, now));
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  // the route already gated the result; gate it again against what THIS device sent (a response is never trusted as is)
  const items: SynthesisItem[] = gateS1Items(validateSynthesisItems({ items: response.items }, plan.clusters).items, plan.clusters).items;
  const reactions = validateReactions({ reactions: response.reactions }, checks);
  const generationId = deps.newId();
  const changes = applyGenerationResult(state, plan, { items, reactions }, memories, now, generationId, examinedThrough);
  await deps.store.commit(changes);
  return {
    status: "done",
    themes: plan.themes.map((t) => t.themeLabel),
    added: (changes.putHypotheses ?? []).filter((h) => h.generationId === generationId).length,
    reactions: (changes.addReactions ?? []).length,
    kept: state.hypotheses.length - (changes.deleteHypothesisIds ?? []).length,
  };
}

/** an in-memory store with the same all-or-nothing commit semantics (tests and the Preview comparison; never the device's data) */
export function createMemorySynthesisStore(initial?: Partial<SynthesisState>): SynthesisStorePort & { snapshot(): SynthesisState } {
  let state: SynthesisState = { hypotheses: [], reactions: [], themeStates: [], meta: null, ...initial };
  const copy = (s: SynthesisState): SynthesisState => JSON.parse(JSON.stringify(s)) as SynthesisState;
  return {
    async load() {
      return copy(state);
    },
    async commit(changes) {
      const next = copy(state);
      const del = new Set(changes.deleteHypothesisIds ?? []);
      const hyps = new Map(next.hypotheses.filter((h) => !del.has(h.id)).map((h) => [h.id, h] as const));
      for (const h of changes.putHypotheses ?? []) hyps.set(h.id, h);
      const themes = new Map(next.themeStates.map((t) => [t.themeId, t] as const));
      for (const t of changes.putThemeStates ?? []) themes.set(t.themeId, t);
      state = {
        hypotheses: [...hyps.values()],
        reactions: [...next.reactions, ...(changes.addReactions ?? []).filter((r) => !next.reactions.some((x) => x.id === r.id))],
        themeStates: [...themes.values()],
        meta: changes.meta ?? next.meta,
      };
    },
    async claimRun(at, minHours) {
      const last = state.meta?.lastAttemptAt ? Date.parse(state.meta.lastAttemptAt) : NaN;
      if (Number.isFinite(last) && Date.parse(at) - last < minHours * 3_600_000) return false;
      state = { ...copy(state), meta: { ...(state.meta ?? { schemaVersion: SYNTHESIS_SCHEMA_VERSION, key: "run" }), lastAttemptAt: at } };
      return true;
    },
    snapshot() {
      return copy(state);
    },
  };
}
