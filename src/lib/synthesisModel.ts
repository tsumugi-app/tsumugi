/**
 * Memory Synthesis S1 (trial, default OFF): the data model and the pure rules for generating, updating and using Tsumugi's hypotheses.
 *
 * Three kinds of data, kept apart all the way:
 *   - StoredHypothesis  : Tsumugi's readings (AI-generated, validated by code). A regenerable CACHE: it may be cleared and built again.
 *   - UserReaction      : the user's clear rejection / correction of a hypothesis. USER DATA: never regenerated, never cleared together with the cache.
 *   - HypothesisExposure: the conversations in which a hypothesis was used. Provenance: kept apart from the cache, so clearing or regenerating the
 *                         hypotheses never makes an agreement captured in such a conversation look like independent evidence.
 *   - ThemeGenerationState / SynthesisRunMeta : bookkeeping for when a theme needs to be generated again. Regenerable.
 * None of it is a Memory: it lives in its own IndexedDB database (synthesisStore.ts), never in the Memory store, the Vault, the Outbox or sync.
 *
 * Rules that keep a wrong reading from growing:
 *   - Evidence is only the user's own conversation Memories (`isSynthesisSource`, Tsumugi's reflections excluded).
 *   - Earlier hypotheses are never fed back to the model as material (only the user's rejections, as "do not propose this again").
 *   - Support is decided from the evidence of each generation; repeating a hypothesis never raises it.
 *   - A Memory from a conversation in which a hypothesis was shown, that keeps no substantive words of the user (an "そうかも"), is not evidence.
 *   - A rejection / correction is stored only when the user's own words, quoted verbatim, contain a clear denial; anything unclear changes nothing.
 * Pure functions only (no IndexedDB, no fetch), so the same rules run in the app, the API route, the tests and the Preview comparison.
 */
import type { Conversation, MemoryObject } from "./types";
import { normalizeAnalyticsKeyword } from "./memoryAnalytics";
import { jstDateOf } from "./dateModel";
import {
  buildSynthesisClusters,
  buildThemeTimeline,
  HEDGE,
  isSynthesisSource,
  type SynthesisCluster,
  type SynthesisCorrection,
  type SynthesisItem,
  type SynthesisThemeContext,
  type SynthesisKind,
  type SynthesisSupport,
} from "./memorySynthesis";

export const SYNTHESIS_SCHEMA_VERSION = 1 as const;
export const SYNTHESIS_DB_NAME = "tsumugi-synthesis";

export const SYNTHESIS_S1_LIMITS = {
  /** at most one generation attempt per device per this many hours */
  minHoursBetweenRuns: 24,
  maxThemesPerRun: 4,
  /** a hypothesis whose newest evidence is older than this is not used any more */
  maxEvidenceAgeDays: 180,
  /** new Memories on a theme since its last generation that make it worth generating again */
  minNewEvidence: 2,
  maxReactionChecks: 8,
  maxUserTurnsPerCheck: 3,
  userTurnLength: 300,
  tsumugiReplyLength: 400,
  maxRejectedSent: 12,
} as const;

const DAY_MS = 86_400_000;

export type ThemeKind = "keyword" | "person";
/** S1 builds keyword themes only; a person theme (`person:<groupingKey>`) is the planned S2 extension and uses the same records. */
export function keywordThemeId(theme: string): string {
  return `kw:${normalizeAnalyticsKeyword(theme)}`;
}

/** "retired": replaced by a newer generation but some of its uses still wait for a reaction check; never used in a chat turn */
export type HypothesisStatus = "active" | "retired" | "rejected" | "corrected";

export interface StoredHypothesis {
  schemaVersion: typeof SYNTHESIS_SCHEMA_VERSION;
  origin: "ai-synthesis";
  id: string;
  themeId: string;
  themeKind: ThemeKind;
  /** the theme as the Memories spell it (what the chat timeline matches) */
  themeLabel: string;
  kind: SynthesisKind;
  statement: string;
  support: SynthesisSupport;
  situationNote?: string;
  /** each evidence Memory with the version it had when the hypothesis was made (an edited Memory makes the hypothesis unusable) */
  evidence: { memoryId: string; updatedAt: string }[];
  firstStatedAt: string;
  lastStatedAt: string;
  generationId: string;
  generatedAt: string;
  /** the theme's state when the hypothesis was made ("保留|<memoryId>"); a different state now makes it unusable */
  stateFingerprint: string;
  status: HypothesisStatus;
  /** conversations whose chat turns received this hypothesis */
  shownIn: { conversationId: string; at: string }[];
  /** shown entries up to this time have already been judged for a reaction */
  reactionsCheckedThrough?: string;
}

export type ReactionKind = "rejected" | "corrected";

export interface UserReaction {
  schemaVersion: typeof SYNTHESIS_SCHEMA_VERSION;
  origin: "user-reaction";
  id: string;
  themeId: string;
  themeKind: ThemeKind;
  themeLabel: string;
  kind: ReactionKind;
  /** the hypothesis the user answered to (copied: the reaction must outlive the cache) */
  hypothesisStatement: string;
  hypothesisEvidenceIds: string[];
  /** the user's own words, verbatim from the conversation */
  userQuote: string;
  conversationId: string;
  saidAt: string;
  recordedAt: string;
}

export interface ThemeGenerationState {
  schemaVersion: typeof SYNTHESIS_SCHEMA_VERSION;
  themeId: string;
  themeLabel: string;
  inputFingerprint: string;
  stateFingerprint: string;
  /** Memory ids of the theme at the last generation (to count what is new) */
  memoryIds: string[];
  generatedAt?: string;
  lastAttemptAt?: string;
  lastResult?: "ok" | "failed";
  failures: number;
}

export interface SynthesisRunMeta {
  schemaVersion: typeof SYNTHESIS_SCHEMA_VERSION;
  key: "run";
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastResult?: "ok" | "failed" | "nothing-to-do";
}

/** a conversation in which a hypothesis was used (kept when the hypothesis cache is cleared or regenerated) */
export interface HypothesisExposure {
  schemaVersion: typeof SYNTHESIS_SCHEMA_VERSION;
  conversationId: string;
  themeIds: string[];
  firstAt: string;
}

export interface SynthesisState {
  hypotheses: StoredHypothesis[];
  reactions: UserReaction[];
  exposures: HypothesisExposure[];
  themeStates: ThemeGenerationState[];
  meta: SynthesisRunMeta | null;
  /** changes on every reset ("仮説を消す" / "すべて初期化"): a run that started before a reset cannot write afterwards */
  epoch: string;
}

/** one write unit, applied in ONE IndexedDB transaction by the store (all or nothing) */
export interface SynthesisChanges {
  putHypotheses?: StoredHypothesis[];
  /**
   * hypotheses to remove: the store removes one only when none of its stored uses (including uses recorded while the run was waiting) is later than
   * `checkedThrough`; otherwise it keeps it as "retired" so that those uses are still checked for a reaction
   */
  removeHypotheses?: { id: string; checkedThrough?: string }[];
  /** the epoch the run started in; the store refuses the whole commit when a reset happened since */
  expectedEpoch?: string;
  /** reactions are only ever added here; nothing in the generation path removes one */
  addReactions?: UserReaction[];
  putThemeStates?: ThemeGenerationState[];
  meta?: SynthesisRunMeta;
}

/**
 * Uses recorded while a run was waiting for the AI must survive the run's commit: the stored and the committed use lists are merged, never replaced.
 * Uses not yet judged (later than `checkedThrough`) are always kept; only already judged ones are trimmed (to the latest 10).
 */
export function mergeShown(stored: StoredHypothesis["shownIn"], incoming: StoredHypothesis["shownIn"], checkedThrough?: string): StoredHypothesis["shownIn"] {
  const seen = new Set<string>();
  const all = [...stored, ...incoming]
    .filter((s) => {
      const key = `${s.conversationId}@${s.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const judged = all.filter((s) => checkedThrough !== undefined && s.at <= checkedThrough);
  return [...judged.slice(-10), ...all.filter((s) => checkedThrough === undefined || s.at > checkedThrough)];
}

/** the store's decision for one entry of `removeHypotheses`, given what is stored now */
export function removalOutcome(stored: StoredHypothesis, checkedThrough: string | undefined): "delete" | StoredHypothesis {
  const pending = stored.shownIn.some((s) => checkedThrough === undefined || s.at > checkedThrough);
  if (!pending) return "delete";
  return { ...stored, status: stored.status === "active" || stored.status === "retired" ? "retired" : stored.status, reactionsCheckedThrough: checkedThrough };
}

/** the exposure record after a hypothesis of `themeId` was used in `conversationId` */
export function addExposure(existing: HypothesisExposure | undefined, conversationId: string, themeId: string, at: string): HypothesisExposure {
  return {
    schemaVersion: SYNTHESIS_SCHEMA_VERSION,
    conversationId,
    themeIds: [...new Set([...(existing?.themeIds ?? []), themeId])],
    firstAt: existing?.firstAt ?? at,
  };
}

// ---------------------------------------------------------------------------
// fingerprints
// ---------------------------------------------------------------------------

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const onTheme = (m: MemoryObject, theme: string) => {
  const t = normalizeAnalyticsKeyword(theme);
  return (m.keywords ?? []).some((k) => normalizeAnalyticsKeyword(k) === t);
};

export interface ThemeSnapshot {
  themeId: string;
  themeLabel: string;
  memoryIds: string[];
  inputFingerprint: string;
  stateFingerprint: string;
}

export function themeSnapshot(themeLabel: string, memories: MemoryObject[]): ThemeSnapshot {
  const own = memories.filter((m) => isSynthesisSource(m) && onTheme(m, themeLabel)).sort((a, b) => a.id.localeCompare(b.id));
  const { state } = buildThemeTimeline(themeLabel, memories);
  return {
    themeId: keywordThemeId(themeLabel),
    themeLabel,
    memoryIds: own.map((m) => m.id),
    inputFingerprint: fnv1a(own.map((m) => `${m.id}@${m.updatedAt}`).join("|")),
    stateFingerprint: `${state.status}|${state.basisMemoryId ?? ""}`,
  };
}

// ---------------------------------------------------------------------------
// similarity to what the user rejected
// ---------------------------------------------------------------------------

function bigrams(text: string): Set<string> {
  const s = text.replace(/[\s、。・「」『』（）()！？!?,.]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function textSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared / (x.size + y.size - shared);
}

/** a generated statement says (roughly) what the user already rejected or corrected on the same theme */
export function resemblesReaction(item: { themeId: string; statement: string; evidenceIds: string[] }, reaction: UserReaction): boolean {
  if (item.themeId !== reaction.themeId) return false;
  const sim = textSimilarity(item.statement, reaction.hypothesisStatement);
  if (sim >= 0.35) return true;
  const ev = new Set(reaction.hypothesisEvidenceIds);
  const overlap = item.evidenceIds.filter((id) => ev.has(id)).length / Math.max(1, Math.min(item.evidenceIds.length, ev.size));
  return overlap >= 0.5 && sim >= 0.2;
}

// ---------------------------------------------------------------------------
// S1 gate on top of validateSynthesisItems (route and client both apply it)
// ---------------------------------------------------------------------------

/** a cause or a purpose joining the records ("〜するために", "〜を機に") is Tsumugi's reading unless the user said it */
const CAUSAL_READING = /ために|ため、|を機に|をきっかけ|がきっかけ|きっかけで|影響で|ことから|せいで|おかげで/;

/**
 * - An item that joins several records is never "stated" (the user did not say the joined sentence): it is at most "derived".
 * - A cause / purpose that the user's own records do not contain must be worded as a possibility, or the item is dropped.
 */
export function gateS1Items(items: SynthesisItem[], clusters: SynthesisCluster[]): { items: SynthesisItem[]; dropped: number } {
  const out: SynthesisItem[] = [];
  let dropped = 0;
  for (const item of items) {
    const cluster = clusters.find((c) => normalizeAnalyticsKeyword(c.theme) === normalizeAnalyticsKeyword(item.theme));
    const own = (cluster?.evidence ?? []).filter((e) => item.evidenceIds.includes(e.id)).map((e) => `${e.summary} ${e.quote ?? ""}`).join(" ");
    const text = `${item.statement} ${item.situationNote ?? ""}`;
    const causal = text.match(CAUSAL_READING)?.[0];
    if (causal && !own.includes(causal.replace(/、$/, "")) && !HEDGE.test(text)) {
      dropped += 1;
      continue;
    }
    out.push(item.support === "stated" && item.evidenceIds.length >= 2 ? { ...item, support: "derived" } : causal && !own.includes(causal.replace(/、$/, "")) ? { ...item, support: "hypothesis" } : item);
  }
  return { items: out, dropped };
}

// ---------------------------------------------------------------------------
// which hypotheses may be used now (read time; no AI, no write)
// ---------------------------------------------------------------------------

export type UnusableReason = "not-active" | "missing-evidence" | "edited-evidence" | "state-changed" | "expired" | "resembles-reaction";

export function unusableReason(h: StoredHypothesis, memoriesById: Map<string, MemoryObject>, currentStateFingerprint: string | undefined, reactions: UserReaction[], now: number): UnusableReason | null {
  if (h.status !== "active") return "not-active";
  for (const e of h.evidence) {
    const m = memoriesById.get(e.memoryId);
    if (!m) return "missing-evidence";
    if (m.updatedAt !== e.updatedAt) return "edited-evidence";
  }
  if (currentStateFingerprint !== undefined && currentStateFingerprint !== h.stateFingerprint) return "state-changed";
  if (now - Date.parse(h.lastStatedAt) > SYNTHESIS_S1_LIMITS.maxEvidenceAgeDays * DAY_MS) return "expired";
  if (reactions.some((r) => resemblesReaction({ themeId: h.themeId, statement: h.statement, evidenceIds: h.evidence.map((e) => e.memoryId) }, r))) return "resembles-reaction";
  return null;
}

/** the hypotheses a chat turn may receive, as the items the existing timeline selection understands */
export function usableItemsForChat(state: Pick<SynthesisState, "hypotheses" | "reactions">, memories: MemoryObject[], now: number): { items: SynthesisItem[]; hypothesisIdByItem: Map<SynthesisItem, string> } {
  const byId = new Map(memories.map((m) => [m.id, m] as const));
  const stateFp = new Map<string, string>();
  const hypothesisIdByItem = new Map<SynthesisItem, string>();
  const items: SynthesisItem[] = [];
  for (const h of state.hypotheses) {
    if (!stateFp.has(h.themeId)) stateFp.set(h.themeId, themeSnapshot(h.themeLabel, memories).stateFingerprint);
    if (unusableReason(h, byId, stateFp.get(h.themeId), state.reactions, now) !== null) continue;
    const item: SynthesisItem = {
      kind: h.kind,
      theme: h.themeLabel,
      statement: h.statement,
      support: h.support,
      evidenceIds: h.evidence.map((e) => e.memoryId),
      firstStatedAt: h.firstStatedAt,
      lastStatedAt: h.lastStatedAt,
      ...(h.situationNote ? { situationNote: h.situationNote } : {}),
    };
    items.push(item);
    hypothesisIdByItem.set(item, h.id);
  }
  return { items, hypothesisIdByItem };
}

// ---------------------------------------------------------------------------
// material: what the model may see
// ---------------------------------------------------------------------------

/** the user's agreement alone ("うん", "そうかも", "たしかに") — not a statement of anything */
export const AGREEMENT_ONLY = /^(うん|うーん|ええ|はい|そう|そうかも|そうかもね|そうかもしれない|そうだね|そうかな|たしかに|確かに|なるほど|かもね|かも|ある|あるかも|それはある|わかる|分かる)[。、！!？?ー〜…\s]*$/;

/**
 * A Memory made from a conversation in which a hypothesis was shown, that keeps no substantive words of the user, is not evidence:
 * otherwise "そうかも" would come back as "the user said so" and harden Tsumugi's own reading.
 */
export function eligibleEvidenceMemories(memories: MemoryObject[], state: Pick<SynthesisState, "hypotheses" | "exposures">): MemoryObject[] {
  const shownConversations = new Set([...state.exposures.map((e) => e.conversationId), ...state.hypotheses.flatMap((h) => h.shownIn.map((s) => s.conversationId))]);
  return memories.filter((m) => {
    if (!isSynthesisSource(m)) return false;
    if (!shownConversations.has(m.conversationId as string)) return true;
    const quotes = (m.evidenceQuotes ?? []).filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter(Boolean);
    return quotes.some((q) => q.length >= 8 && !AGREEMENT_ONLY.test(q));
  });
}

// ---------------------------------------------------------------------------
// planning (no AI)
// ---------------------------------------------------------------------------

export type ThemeReason = "reaction-check" | "state-changed" | "evidence-changed" | "new-evidence" | "first";
const PRIORITY: Record<ThemeReason, number> = { "reaction-check": 5, "state-changed": 4, "evidence-changed": 3, "new-evidence": 2, first: 1 };

export interface PlannedTheme {
  themeId: string;
  themeLabel: string;
  reasons: ThemeReason[];
  snapshot: ThemeSnapshot;
}

export interface SynthesisPlan {
  due: boolean;
  why: "off-cooldown" | "cooldown" | "nothing-to-do";
  themes: PlannedTheme[];
  clusters: SynthesisCluster[];
}

function pendingShown(h: StoredHypothesis): { conversationId: string; at: string }[] {
  const through = h.reactionsCheckedThrough ? Date.parse(h.reactionsCheckedThrough) : -Infinity;
  return h.shownIn.filter((s) => Date.parse(s.at) > through);
}

export function planGeneration(state: SynthesisState, memories: MemoryObject[], now: number): SynthesisPlan {
  const last = state.meta?.lastAttemptAt ? Date.parse(state.meta.lastAttemptAt) : NaN;
  const cooldown = Number.isFinite(last) && now - last < SYNTHESIS_S1_LIMITS.minHoursBetweenRuns * 3_600_000;
  const eligible = eligibleEvidenceMemories(memories, state);
  const candidates = buildSynthesisClusters(eligible, { maxClusters: 50 });
  const byId = new Map(memories.map((m) => [m.id, m] as const));
  const themeStates = new Map(state.themeStates.map((t) => [t.themeId, t] as const));
  const planned: { theme: PlannedTheme; cluster: SynthesisCluster; score: number }[] = [];
  for (const cluster of candidates) {
    const snapshot = themeSnapshot(cluster.theme, memories);
    const prev = themeStates.get(snapshot.themeId);
    const own = state.hypotheses.filter((h) => h.themeId === snapshot.themeId);
    const reasons: ThemeReason[] = [];
    if (own.some((h) => (h.status === "active" || h.status === "retired") && pendingShown(h).length > 0)) reasons.push("reaction-check");
    if (!prev?.generatedAt) {
      reasons.push("first");
    } else {
      if (prev.stateFingerprint !== snapshot.stateFingerprint) reasons.push("state-changed");
      if (own.some((h) => h.status === "active" && h.evidence.some((e) => byId.get(e.memoryId)?.updatedAt !== e.updatedAt))) reasons.push("evidence-changed");
      const known = new Set(prev.memoryIds);
      if (snapshot.memoryIds.filter((id) => !known.has(id)).length >= SYNTHESIS_S1_LIMITS.minNewEvidence) reasons.push("new-evidence");
    }
    if (reasons.length === 0) continue;
    const score = Math.max(...reasons.map((r) => PRIORITY[r])) * 100 + cluster.evidence.length;
    planned.push({ theme: { themeId: snapshot.themeId, themeLabel: cluster.theme, reasons, snapshot }, cluster, score });
  }
  planned.sort((a, b) => b.score - a.score);
  const chosen = planned.slice(0, SYNTHESIS_S1_LIMITS.maxThemesPerRun);
  if (chosen.length === 0) return { due: false, why: "nothing-to-do", themes: [], clusters: [] };
  if (cooldown) return { due: false, why: "cooldown", themes: chosen.map((c) => c.theme), clusters: [] };
  return { due: true, why: "off-cooldown", themes: chosen.map((c) => c.theme), clusters: chosen.map((c) => c.cluster) };
}

// ---------------------------------------------------------------------------
// reaction checks: what the user answered after a hypothesis was used
// ---------------------------------------------------------------------------

export interface ReactionCheck {
  hypothesisId: string;
  theme: string;
  statement: string;
  conversationId: string;
  /** when the hypothesis was used in that conversation */
  shownAt: string;
  /** Tsumugi's reply right after the hypothesis was used (so the model can see what the user answered to) */
  tsumugiReply: string;
  userTurns: { text: string; at: string }[];
}

export interface ReactionChecks {
  checks: ReactionCheck[];
  /** per hypothesis: the latest use that was examined (sent for judging, or found to have no answer to judge). Later uses stay pending. */
  examinedThrough: Record<string, string>;
}

export function buildReactionChecks(plan: SynthesisPlan, state: SynthesisState, conversations: Conversation[]): ReactionChecks {
  const planned = new Set(plan.themes.filter((t) => t.reasons.includes("reaction-check")).map((t) => t.themeId));
  const convById = new Map(conversations.map((c) => [c.id, c] as const));
  const checks: ReactionCheck[] = [];
  const examinedThrough: Record<string, string> = {};
  for (const h of state.hypotheses) {
    if ((h.status !== "active" && h.status !== "retired") || !planned.has(h.themeId)) continue;
    for (const shown of pendingShown(h)) {
      if (checks.length >= SYNTHESIS_S1_LIMITS.maxReactionChecks) return { checks, examinedThrough };
      const conv = convById.get(shown.conversationId);
      if (!conv) {
        examinedThrough[h.id] = shown.at; // the conversation was deleted: nothing left to judge
        continue;
      }
      const after = conv.turns.filter((t) => Date.parse(t.timestamp) >= Date.parse(shown.at));
      const reply = after.find((t) => t.role === "ai");
      const userTurns = after
        .filter((t) => t.role === "user" && (!reply || Date.parse(t.timestamp) >= Date.parse(reply.timestamp)))
        .slice(0, SYNTHESIS_S1_LIMITS.maxUserTurnsPerCheck)
        .map((t) => ({ text: t.content.slice(0, SYNTHESIS_S1_LIMITS.userTurnLength), at: t.timestamp }));
      if (!reply || userTurns.length === 0) {
        // not answered yet: while the conversation is still open, this use (and the later ones) stay pending
        if (!conv.endedAt) break;
        examinedThrough[h.id] = shown.at;
        continue;
      }
      examinedThrough[h.id] = shown.at;
      checks.push({ hypothesisId: h.id, theme: h.themeLabel, statement: h.statement, conversationId: conv.id, shownAt: shown.at, tsumugiReply: reply.content.slice(0, SYNTHESIS_S1_LIMITS.tsumugiReplyLength), userTurns });
    }
  }
  return { checks, examinedThrough };
}

/** words that make a quote a clear denial / correction (an agreement or a "どうだろう" never matches) */
export const DENIAL_CUE = /違う|ちがう|違います|違った|そうじゃな|そうではな|そんなことな|そういうわけじゃ|わけじゃな|わけではな|わけでもな|じゃなくて|ではなくて|じゃない(?![かよね]?[？?]|か|の)|ではない|でもない|ほどじゃな|ほどでもな|ほどではな|気にしてな|思ってな|感じてな|間違|訂正|むしろ|というより|本当は|実は|勘違い|当たってな|外れて/;

export interface JudgedReaction {
  hypothesisId: string;
  kind: ReactionKind;
  userQuote: string;
  saidAt: string;
  /** the conversation whose answer the quote comes from */
  conversationId: string;
}

/**
 * Server-side gate for the model's reaction judgments. Only "rejected" / "corrected" with a verbatim quote from a user turn that contains a clear
 * denial survive. Everything else ("confirmed", "unclear", a quote that is not the user's, a "そうかも") is dropped: it changes nothing.
 */
export function validateReactions(raw: unknown, checks: ReactionCheck[]): JudgedReaction[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { reactions?: unknown }).reactions) ? (raw as { reactions: unknown[] }).reactions : [];
  const out: JudgedReaction[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const id = typeof x.hypothesisId === "string" ? x.hypothesisId : "";
    const kind = x.reaction === "rejected" || x.reaction === "corrected" ? x.reaction : null;
    const quote = typeof x.userQuote === "string" ? x.userQuote.trim() : "";
    if (!id || !kind || quote.length < 2 || seen.has(id) || AGREEMENT_ONLY.test(quote)) continue;
    // a hypothesis may have been used in several conversations: the quote must be the user's own words in one of them, and that answer must contain a
    // clear denial (the model may quote the corrected part only)
    for (const check of checks) {
      if (check.hypothesisId !== id) continue;
      const turn = check.userTurns.find((t) => t.text.includes(quote) && DENIAL_CUE.test(t.text) && !AGREEMENT_ONLY.test(t.text.trim()));
      if (!turn) continue;
      seen.add(id);
      out.push({ hypothesisId: id, kind, userQuote: quote, saidAt: turn.at, conversationId: check.conversationId });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// applying a generation (one transaction's worth of changes)
// ---------------------------------------------------------------------------

export interface GenerationResult {
  items: SynthesisItem[];
  reactions: JudgedReaction[];
}

/**
 * What a successful generation changes. Per planned theme:
 *   - a judged rejection / correction: a UserReaction is ADDED and the hypothesis is marked rejected / corrected (no longer used);
 *   - the theme's hypotheses are replaced by the new items only when the theme needed regenerating for a reason other than the reaction check,
 *     or the user rejected / corrected one of them. A reaction check that found nothing clear leaves the hypotheses exactly as they were;
 *   - new items that resemble anything the user rejected / corrected on the theme are dropped.
 * Reactions are never removed here.
 */
export function applyGenerationResult(
  state: SynthesisState,
  plan: SynthesisPlan,
  result: GenerationResult,
  memories: MemoryObject[],
  now: number,
  generationId: string,
  examinedThrough: Record<string, string> = {}
): SynthesisChanges {
  const at = new Date(now).toISOString();
  const byId = new Map(memories.map((m) => [m.id, m] as const));
  const hypById = new Map(state.hypotheses.map((h) => [h.id, h] as const));
  const newReactions: UserReaction[] = [];
  const reactedIds = new Map<string, ReactionKind>();
  for (const r of result.reactions) {
    const h = hypById.get(r.hypothesisId);
    if (!h) continue;
    reactedIds.set(h.id, r.kind);
    newReactions.push({
      schemaVersion: SYNTHESIS_SCHEMA_VERSION,
      origin: "user-reaction",
      id: `reaction-${generationId}-${newReactions.length + 1}`,
      themeId: h.themeId,
      themeKind: h.themeKind,
      themeLabel: h.themeLabel,
      kind: r.kind,
      hypothesisStatement: h.statement,
      hypothesisEvidenceIds: h.evidence.map((e) => e.memoryId),
      userQuote: r.userQuote,
      conversationId: r.conversationId,
      saidAt: r.saidAt,
      recordedAt: at,
    });
  }
  const allReactions = [...state.reactions, ...newReactions];
  const putHypotheses: StoredHypothesis[] = [];
  const removeHypotheses: { id: string; checkedThrough?: string }[] = [];
  const putThemeStates: ThemeGenerationState[] = [];
  const prevThemeStates = new Map(state.themeStates.map((t) => [t.themeId, t] as const));
  let n = 0;
  for (const theme of plan.themes) {
    const own = state.hypotheses.filter((h) => h.themeId === theme.themeId);
    const reacted = own.some((h) => reactedIds.has(h.id));
    const regenerate = reacted || theme.reasons.some((r) => r !== "reaction-check");
    for (const h of own) {
      const kind = reactedIds.get(h.id);
      // only the uses that were actually examined count as judged; later ones stay pending for the next run
      const checkedThrough = examinedThrough[h.id] ?? h.reactionsCheckedThrough;
      if (kind) putHypotheses.push({ ...h, status: kind, reactionsCheckedThrough: checkedThrough });
      // replaced (or retired and now fully checked): the store removes it, or keeps it "retired" while some of its uses still wait for a check
      else if ((regenerate && h.status === "active") || h.status === "retired") removeHypotheses.push({ id: h.id, checkedThrough });
      else if (checkedThrough !== h.reactionsCheckedThrough) putHypotheses.push({ ...h, reactionsCheckedThrough: checkedThrough });
    }
    if (regenerate) {
      const themeReactions = allReactions.filter((r) => r.themeId === theme.themeId);
      for (const item of result.items) {
        if (keywordThemeId(item.theme) !== theme.themeId) continue;
        if (themeReactions.some((r) => resemblesReaction({ themeId: theme.themeId, statement: item.statement, evidenceIds: item.evidenceIds }, r))) continue;
        const evidence = item.evidenceIds.map((id) => ({ memoryId: id, updatedAt: byId.get(id)?.updatedAt ?? "" }));
        if (evidence.some((e) => !e.updatedAt)) continue;
        n += 1;
        putHypotheses.push({
          schemaVersion: SYNTHESIS_SCHEMA_VERSION,
          origin: "ai-synthesis",
          id: `hyp-${generationId}-${n}`,
          themeId: theme.themeId,
          themeKind: "keyword",
          themeLabel: item.theme,
          kind: item.kind,
          statement: item.statement,
          support: item.support,
          ...(item.situationNote ? { situationNote: item.situationNote } : {}),
          evidence,
          firstStatedAt: item.firstStatedAt,
          lastStatedAt: item.lastStatedAt,
          generationId,
          generatedAt: at,
          stateFingerprint: theme.snapshot.stateFingerprint,
          status: "active",
          shownIn: [],
        });
      }
    }
    const prev = prevThemeStates.get(theme.themeId);
    putThemeStates.push({
      schemaVersion: SYNTHESIS_SCHEMA_VERSION,
      themeId: theme.themeId,
      themeLabel: theme.themeLabel,
      inputFingerprint: regenerate ? theme.snapshot.inputFingerprint : prev?.inputFingerprint ?? theme.snapshot.inputFingerprint,
      stateFingerprint: regenerate ? theme.snapshot.stateFingerprint : prev?.stateFingerprint ?? theme.snapshot.stateFingerprint,
      memoryIds: regenerate ? theme.snapshot.memoryIds : prev?.memoryIds ?? theme.snapshot.memoryIds,
      generatedAt: regenerate ? at : prev?.generatedAt,
      lastAttemptAt: at,
      lastResult: "ok",
      failures: 0,
    });
  }
  return {
    putHypotheses,
    removeHypotheses,
    expectedEpoch: state.epoch,
    addReactions: newReactions,
    putThemeStates,
    meta: { schemaVersion: SYNTHESIS_SCHEMA_VERSION, key: "run", lastAttemptAt: at, lastSuccessAt: at, lastResult: "ok" },
  };
}

/** a failed generation touches only the bookkeeping: hypotheses and reactions stay exactly as they were */
export function failureChanges(state: SynthesisState, plan: SynthesisPlan, now: number): SynthesisChanges {
  const at = new Date(now).toISOString();
  const prev = new Map(state.themeStates.map((t) => [t.themeId, t] as const));
  return {
    expectedEpoch: state.epoch,
    putThemeStates: plan.themes.map((t) => {
      const p = prev.get(t.themeId);
      return p
        ? { ...p, lastAttemptAt: at, lastResult: "failed" as const, failures: p.failures + 1 }
        : { schemaVersion: SYNTHESIS_SCHEMA_VERSION, themeId: t.themeId, themeLabel: t.themeLabel, inputFingerprint: "", stateFingerprint: "", memoryIds: [], lastAttemptAt: at, lastResult: "failed" as const, failures: 1 };
    }),
    meta: { ...(state.meta ?? { schemaVersion: SYNTHESIS_SCHEMA_VERSION, key: "run" as const }), lastAttemptAt: at, lastResult: "failed" },
  };
}

/** the rejected / corrected readings sent to the model so that it does not propose them again (only for the themes being generated) */
export function rejectedForPrompt(state: SynthesisState, plan: SynthesisPlan): { theme: string; statement: string; userQuote: string }[] {
  const ids = new Set(plan.themes.map((t) => t.themeId));
  return state.reactions
    .filter((r) => ids.has(r.themeId))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, SYNTHESIS_S1_LIMITS.maxRejectedSent)
    .map((r) => ({ theme: r.themeLabel, statement: r.hypothesisStatement, userQuote: r.userQuote }));
}

/**
 * The user's own corrections, attached to the chat context of the SAME theme only (matched by theme id; never to another theme or person).
 * Newest first, at most 2. Only stored reactions are used: they exist only for clear, verbatim denials (validateReactions).
 */
export function attachCorrections(contexts: SynthesisThemeContext[], reactions: UserReaction[]): SynthesisThemeContext[] {
  return contexts.map((c) => {
    const id = keywordThemeId(c.theme);
    const corrections: SynthesisCorrection[] = reactions
      .filter((r) => r.themeId === id)
      .sort((a, b) => b.saidAt.localeCompare(a.saidAt))
      .slice(0, 2)
      // the user's calendar day (JST), not the UTC date: a correction made just now must not read as "yesterday"
      .map((r) => ({ kind: r.kind, saidAt: jstDateOf(r.saidAt) ?? r.saidAt.slice(0, 10), userQuote: r.userQuote, aboutReading: r.hypothesisStatement }));
    return corrections.length > 0 ? { ...c, corrections } : c;
  });
}
