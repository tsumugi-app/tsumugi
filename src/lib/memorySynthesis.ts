/**
 * Memory Synthesis Phase 1 (experimental). Understanding that only appears across SEVERAL Memories of the same person:
 *   change  - how a thought / goal / state moved from an earlier time to a later one
 *   pattern - something that keeps coming back across several conversations
 *   tension - two wishes / views from different times that pull in different directions (never called a contradiction when the situations differ)
 *
 * Design (what this module guarantees, independent of what the model writes):
 *   - Nothing is stored. A synthesis is computed from the Memories that exist now, and is dropped as soon as one of its evidence Memories is gone (deleted).
 *     The source Memories are never modified.
 *   - Only a few small, time-spread clusters are sent to the model (never all Memories). The clusters are chosen by code from the Memories' own keywords /
 *     topicId; the model only words what the evidence shows.
 *   - Every item carries the ids of its evidence Memories; ids the model invents are removed, and an item without enough real evidence is dropped. The dates of
 *     an item are computed here from its evidence (statedAt = when it was SAID; eventTime = when the event happened), never taken from the model.
 *   - "explicit" means the user said so in the evidence; everything else is a "hypothesis" and is presented as such. A tension is always a hypothesis.
 * Pure functions only (no IndexedDB, no fetch), so that the server route, the chat route and tests share exactly the same rules.
 */
import type { EventTimePrecision, MemoryObject } from "./types";
import { normalizeAnalyticsKeyword } from "./memoryAnalytics";

export type SynthesisKind = "change" | "pattern" | "tension";
export type SynthesisBasis = "explicit" | "hypothesis";

export interface SynthesisEvidence {
  id: string;
  conversationId: string;
  /** when the user SAID it (statedAt, or the record date when statedAt is unknown) */
  statedAt: string;
  statedAtIsRecordDate: boolean;
  eventTime?: string;
  eventTimePrecision?: EventTimePrecision;
  summary: string;
  /** the user's own words, when the Memory kept them */
  quote?: string;
}

export interface SynthesisCluster {
  theme: string;
  evidence: SynthesisEvidence[];
}

export interface SynthesisItem {
  kind: SynthesisKind;
  theme: string;
  statement: string;
  basis: SynthesisBasis;
  evidenceIds: string[];
  /** computed from the evidence (statedAt), not from the model */
  firstStatedAt: string;
  lastStatedAt: string;
  /** for a tension: what differed between the situations (required) */
  situationNote?: string;
}

export const SYNTHESIS_LIMITS = {
  maxClusters: 4,
  maxEvidencePerCluster: 8,
  minConversations: 3,
  minSpanDays: 14,
  maxItems: 8,
  maxStatementLength: 220,
  maxItemsPerTurn: 2,
  summaryLength: 160,
  quoteLength: 120,
} as const;

const DAY_MS = 86_400_000;

function statedAtOf(m: MemoryObject): { at: string; isRecordDate: boolean } {
  return m.statedAt && Number.isFinite(Date.parse(m.statedAt)) ? { at: m.statedAt, isRecordDate: false } : { at: m.date, isRecordDate: true };
}

/** Memories a synthesis may use: the user's own conversations, not Tsumugi's own reflections / insights, with a conversation id */
export function isSynthesisSource(m: MemoryObject): boolean {
  if (m.metadata?.source === "system-generated") return false;
  if ((m.types ?? []).includes("insight")) return false;
  return typeof m.conversationId === "string" && m.conversationId.length > 0 && typeof m.summary === "string" && m.summary.trim().length > 0;
}

function toEvidence(m: MemoryObject): SynthesisEvidence {
  const stated = statedAtOf(m);
  const quote = (m.evidenceQuotes ?? []).find((q) => typeof q === "string" && q.trim().length > 0);
  return {
    id: m.id,
    conversationId: m.conversationId as string,
    statedAt: stated.at,
    statedAtIsRecordDate: stated.isRecordDate,
    ...(m.eventTime ? { eventTime: m.eventTime, eventTimePrecision: m.eventTimePrecision } : {}),
    summary: m.summary.trim().slice(0, SYNTHESIS_LIMITS.summaryLength),
    ...(quote ? { quote: quote.trim().slice(0, SYNTHESIS_LIMITS.quoteLength) } : {}),
  };
}

/** keeps the earliest and the latest and spreads the rest evenly over time (a change can only be seen across time) */
function spreadOverTime(sorted: SynthesisEvidence[], max: number): SynthesisEvidence[] {
  if (sorted.length <= max) return sorted;
  const picked = new Set<number>([0, sorted.length - 1]);
  for (let i = 1; picked.size < max; i++) picked.add(Math.round((i * (sorted.length - 1)) / (max - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => sorted[i]);
}

/**
 * Code-only selection of what the model may look at. A cluster is a theme (a Memory keyword, or a topicId) that the user came back to in at least
 * `minConversations` different conversations over at least `minSpanDays`. One evidence item per conversation (the latest Memory of that conversation for the theme).
 */
export function buildSynthesisClusters(memories: MemoryObject[], options: { maxClusters?: number } = {}): SynthesisCluster[] {
  const groups = new Map<string, { theme: string; byConversation: Map<string, MemoryObject> }>();
  const add = (key: string, theme: string, m: MemoryObject) => {
    let g = groups.get(key);
    if (!g) { g = { theme, byConversation: new Map() }; groups.set(key, g); }
    const prev = g.byConversation.get(m.conversationId as string);
    if (!prev || Date.parse(statedAtOf(m).at) > Date.parse(statedAtOf(prev).at)) g.byConversation.set(m.conversationId as string, m);
  };
  for (const m of memories) {
    if (!isSynthesisSource(m)) continue;
    for (const k of m.keywords ?? []) {
      const norm = normalizeAnalyticsKeyword(k);
      if (norm) add(`k:${norm}`, k.trim(), m);
    }
    if (m.topicId) add(`t:${m.topicId}`, (m.keywords ?? [])[0] ?? "話題", m);
  }
  const candidates: SynthesisCluster[] = [];
  for (const g of groups.values()) {
    if (g.byConversation.size < SYNTHESIS_LIMITS.minConversations) continue;
    const sorted = [...g.byConversation.values()].map(toEvidence).sort((a, b) => Date.parse(a.statedAt) - Date.parse(b.statedAt));
    const span = Date.parse(sorted[sorted.length - 1].statedAt) - Date.parse(sorted[0].statedAt);
    if (!(span >= SYNTHESIS_LIMITS.minSpanDays * DAY_MS)) continue;
    candidates.push({ theme: g.theme, evidence: spreadOverTime(sorted, SYNTHESIS_LIMITS.maxEvidencePerCluster) });
  }
  // the broadest themes first; a theme whose evidence is mostly the same as an already chosen one adds nothing
  candidates.sort((a, b) => b.evidence.length - a.evidence.length || a.theme.localeCompare(b.theme));
  const chosen: SynthesisCluster[] = [];
  for (const c of candidates) {
    const ids = new Set(c.evidence.map((e) => e.id));
    const overlaps = chosen.some((o) => {
      const shared = o.evidence.filter((e) => ids.has(e.id)).length;
      return shared / Math.min(ids.size, o.evidence.length) > 0.6;
    });
    if (!overlaps) chosen.push(c);
    if (chosen.length >= (options.maxClusters ?? SYNTHESIS_LIMITS.maxClusters)) break;
  }
  return chosen;
}

/** the text the model sees: ids, both dates kept apart, the summary and (if kept) the user's own words */
export function renderClustersForModel(clusters: SynthesisCluster[]): string {
  return clusters
    .map((c, i) => {
      const lines = c.evidence.map((e) => {
        const said = `${e.statedAtIsRecordDate ? "記録日" : "発言日"} ${e.statedAt.slice(0, 10)}`;
        const event = e.eventTime ? ` / 出来事の時期 ${e.eventTime}` : "";
        const quote = e.quote ? `\n    本人の言葉:「${e.quote}」` : "";
        return `  - id=${e.id}（${said}${event}）\n    要約: ${e.summary}${quote}`;
      });
      return `テーマ${i + 1}「${c.theme}」\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

const KINDS: SynthesisKind[] = ["change", "pattern", "tension"];

/**
 * Server-side gate for what the model returned. Keeps only items whose evidence ids are real (and from ONE cluster), with enough evidence for their kind:
 *   change  >= 2 Memories said on different days;  pattern >= 3 different conversations;  tension >= 2 Memories, a situation note, and always "hypothesis".
 * Dates are recomputed from the evidence. Anything malformed is dropped (never repaired into a claim).
 */
export function validateSynthesisItems(raw: unknown, clusters: SynthesisCluster[]): SynthesisItem[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  // one Memory can be evidence in several themes (e.g. "仕事" and "ランニング"): an item is valid when ALL its ids belong to one common theme
  const evidenceById = new Map<string, { e: SynthesisEvidence; clusters: Set<number> }>();
  clusters.forEach((c, ci) => c.evidence.forEach((e) => {
    const known = evidenceById.get(e.id);
    if (known) known.clusters.add(ci); else evidenceById.set(e.id, { e, clusters: new Set([ci]) });
  }));
  const out: SynthesisItem[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const item = r as Record<string, unknown>;
    const kind = item.kind as SynthesisKind;
    if (!KINDS.includes(kind)) continue;
    const statement = typeof item.statement === "string" ? item.statement.trim() : "";
    if (!statement || statement.length > SYNTHESIS_LIMITS.maxStatementLength) continue;
    const ids = Array.isArray(item.evidenceIds) ? [...new Set(item.evidenceIds.filter((x): x is string => typeof x === "string" && evidenceById.has(x)))] : [];
    if (ids.length === 0) continue;
    const clusterIndex = [...evidenceById.get(ids[0])!.clusters].find((ci) => ids.every((id) => evidenceById.get(id)!.clusters.has(ci)));
    if (clusterIndex === undefined) continue;
    const ev = ids.map((id) => evidenceById.get(id)!.e).sort((a, b) => Date.parse(a.statedAt) - Date.parse(b.statedAt));
    const days = new Set(ev.map((e) => e.statedAt.slice(0, 10)));
    const conversations = new Set(ev.map((e) => e.conversationId));
    if (kind === "change" && days.size < 2) continue;
    if (kind === "pattern" && conversations.size < SYNTHESIS_LIMITS.minConversations) continue;
    const situationNote = typeof item.situationNote === "string" ? item.situationNote.trim().slice(0, SYNTHESIS_LIMITS.maxStatementLength) : "";
    if (kind === "tension" && (ev.length < 2 || !situationNote)) continue;
    const basis: SynthesisBasis = kind === "tension" ? "hypothesis" : item.basis === "explicit" ? "explicit" : "hypothesis";
    out.push({
      kind,
      theme: clusters[clusterIndex].theme,
      statement,
      basis,
      evidenceIds: ev.map((e) => e.id),
      firstStatedAt: ev[0].statedAt,
      lastStatedAt: ev[ev.length - 1].statedAt,
      ...(situationNote ? { situationNote } : {}),
    });
    if (out.length >= SYNTHESIS_LIMITS.maxItems) break;
  }
  return out;
}

/** An item is usable only while ALL of its evidence Memories still exist (a deleted Memory takes the whole item with it). */
export function dropItemsWithMissingEvidence(items: SynthesisItem[], existingMemoryIds: Set<string>): SynthesisItem[] {
  return items.filter((i) => i.evidenceIds.every((id) => existingMemoryIds.has(id)));
}

/**
 * Which items (if any) belong to THIS turn: only those that share evidence with the Memories retrieved for this turn, or whose theme the user just mentioned.
 * Nothing else is sent; most turns get none.
 */
export function selectSynthesisForTurn(items: SynthesisItem[], turn: { userText: string; retrievedMemoryIds: string[] }): SynthesisItem[] {
  const retrieved = new Set(turn.retrievedMemoryIds);
  const text = normalizeAnalyticsKeyword(turn.userText);
  const scored = items
    .map((i) => {
      const shared = i.evidenceIds.filter((id) => retrieved.has(id)).length;
      const themeHit = i.theme && text.includes(normalizeAnalyticsKeyword(i.theme)) ? 1 : 0;
      return { i, score: shared * 2 + themeHit };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, SYNTHESIS_LIMITS.maxItemsPerTurn).map((x) => x.i);
}

/** chat route: accepts only well-formed items, at most `maxItemsPerTurn` */
export function sanitizeSynthesisContext(raw: unknown): SynthesisItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SynthesisItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const i = r as Record<string, unknown>;
    if (!KINDS.includes(i.kind as SynthesisKind)) continue;
    if (typeof i.statement !== "string" || !i.statement.trim() || i.statement.length > SYNTHESIS_LIMITS.maxStatementLength) continue;
    if (typeof i.theme !== "string" || typeof i.firstStatedAt !== "string" || typeof i.lastStatedAt !== "string") continue;
    if (!Array.isArray(i.evidenceIds) || i.evidenceIds.length === 0 || !i.evidenceIds.every((x) => typeof x === "string")) continue;
    const kind = i.kind as SynthesisKind;
    out.push({
      kind,
      theme: i.theme.slice(0, 40),
      statement: i.statement.trim(),
      basis: kind === "tension" || i.basis !== "explicit" ? "hypothesis" : "explicit",
      evidenceIds: (i.evidenceIds as string[]).slice(0, SYNTHESIS_LIMITS.maxEvidencePerCluster),
      firstStatedAt: i.firstStatedAt,
      lastStatedAt: i.lastStatedAt,
      ...(typeof i.situationNote === "string" && i.situationNote.trim() ? { situationNote: i.situationNote.trim().slice(0, SYNTHESIS_LIMITS.maxStatementLength) } : {}),
    });
    if (out.length >= SYNTHESIS_LIMITS.maxItemsPerTurn) break;
  }
  return out;
}

const KIND_LABEL: Record<SynthesisKind, string> = { change: "変化", pattern: "繰り返し", tension: "揺れ" };

/** the chat section. Empty when there is nothing for this turn (the prompt is then byte-for-byte what it was before). */
export function buildSynthesisSection(items: SynthesisItem[]): string {
  if (items.length === 0) return "";
  const lines = items
    .map((i) => {
      const when = i.firstStatedAt.slice(0, 7) === i.lastStatedAt.slice(0, 7) ? i.firstStatedAt.slice(0, 7) : `${i.firstStatedAt.slice(0, 7)}〜${i.lastStatedAt.slice(0, 7)}`;
      const basis = i.basis === "explicit" ? "本人が話した内容のまとめ" : "Tsumugiの仮説";
      const note = i.situationNote ? `\n  状況の違い: ${i.situationNote}` : "";
      return `- [${KIND_LABEL[i.kind]}・${basis}・${when}に話した内容から] ${i.statement}${note}`;
    })
    .join("\n");
  return `

## 複数の会話から見えている流れ（Tsumugiの整理。今回の話題に関係するものだけ）

${lines}

これは、ユーザーが別々の日に話した内容をTsumugiが並べて見たときの整理であり、ユーザーの性格や心理の診断ではない。
- 今の発言に本当に関係するときだけ、自然に一度生かす。関係が薄ければ触れない。毎回持ち出さない。
- 「Tsumugiの仮説」は事実として断定しない。「前は〜と話していて、最近は〜」のように、本人が話した内容に沿って、確かめるように触れる。
- 「揺れ」は矛盾の指摘ではない。状況が違えば望みが違うのは自然なこととして扱い、責めたり白黒をつけさせたりしない。
- 期間は「話した時期」であり、出来事が起きた時期ではない。
- 性格・心理・病名などのラベルを付けない。「あなたは〜な人」と言い切らない。`;
}
