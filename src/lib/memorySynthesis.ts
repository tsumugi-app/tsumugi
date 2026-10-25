/**
 * Memory Synthesis Phase 1 (experimental). Understanding that only appears across SEVERAL Memories of the same person:
 *   change  - how a thought / goal / state moved from an earlier time to a later one
 *   pattern - something that keeps coming back across several conversations
 *   tension - wishes / views from different times or situations that pull in different directions (never called a contradiction)
 *
 * Two layers, kept apart all the way into the chat prompt:
 *   FACTS (code)          - per theme, the dated timeline of what the user said (said-date and event-date kept apart), with the LATEST point marked.
 *                           Built here from the Memories that exist now; the model never writes it. The latest point is the "current state" of the theme.
 *   UNDERSTANDING (model) - change / pattern / tension items, each with a support level:
 *                             "stated"  the user said it in so many words in the evidence
 *                             "derived" it follows from putting several of the user's statements side by side
 *                             "hypothesis" Tsumugi's reading; may only combine what was said, never adds motives, purposes or psychology
 *
 * Guarantees (independent of what the model writes):
 *   - Nothing is stored; the source Memories are never modified; an item whose evidence Memory is gone (deleted) is dropped.
 *   - Only a few small, time-spread clusters are sent to the model (never all Memories); the clusters are chosen by code.
 *   - Evidence ids the model invents are removed; an item without enough real evidence is dropped; dates come from the evidence.
 *   - Words that put a motive / purpose / psychology on the user are dropped unless the user's own records contain them.
 *   - A theme is attached to a chat turn only when it is related to what the user just said AND adds Memories the normal retrieval did not already bring.
 * Pure functions only (no IndexedDB, no fetch).
 */
import type { EventTimePrecision, MemoryObject } from "./types";
import { normalizeAnalyticsKeyword } from "./memoryAnalytics";

export type SynthesisKind = "change" | "pattern" | "tension";
export type SynthesisSupport = "stated" | "derived" | "hypothesis";

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
  support: SynthesisSupport;
  evidenceIds: string[];
  /** computed from the evidence (said-dates), not from the model */
  firstStatedAt: string;
  lastStatedAt: string;
  /** for a tension: what differed between the situations (required) */
  situationNote?: string;
}

export type SynthesisDropReason = "malformed" | "unknown-evidence" | "mixed-themes" | "too-little-evidence" | "missing-situation" | "unfounded-interpretation";

export interface SynthesisValidation {
  items: SynthesisItem[];
  proposed: number;
  dropped: Partial<Record<SynthesisDropReason, number>>;
}

/** FACTS: one dated point of a theme's timeline (code-built) */
export interface SynthesisTimelinePoint {
  statedAt: string;
  statedAtIsRecordDate: boolean;
  eventTime?: string;
  summary: string;
  latest: boolean;
}

/** what one chat turn receives for one theme */
export interface SynthesisThemeContext {
  theme: string;
  timeline: SynthesisTimelinePoint[];
  items: SynthesisItem[];
}

export const SYNTHESIS_LIMITS = {
  maxClusters: 4,
  maxEvidencePerCluster: 8,
  minConversations: 3,
  minSpanDays: 14,
  maxItems: 8,
  maxStatementLength: 220,
  maxThemesPerTurn: 2,
  maxItemsPerTheme: 2,
  maxTimelinePoints: 4,
  summaryLength: 160,
  quoteLength: 120,
} as const;

const DAY_MS = 86_400_000;

function statedAtOf(m: MemoryObject): { at: string; isRecordDate: boolean } {
  return m.statedAt && Number.isFinite(Date.parse(m.statedAt)) ? { at: m.statedAt, isRecordDate: false } : { at: m.date, isRecordDate: true };
}
const timeOf = (m: MemoryObject) => Date.parse(statedAtOf(m).at);

/** Memories a synthesis may use: the user's own conversations, not Tsumugi's own reflections / insights */
export function isSynthesisSource(m: MemoryObject): boolean {
  if (m.metadata?.source === "system-generated") return false;
  if ((m.types ?? []).includes("insight")) return false;
  return typeof m.conversationId === "string" && m.conversationId.length > 0 && typeof m.summary === "string" && m.summary.trim().length > 0;
}

const hasTheme = (m: MemoryObject, theme: string) => {
  const t = normalizeAnalyticsKeyword(theme);
  return (m.keywords ?? []).some((k) => normalizeAnalyticsKeyword(k) === t);
};

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
function spreadOverTime<T>(sorted: T[], max: number): T[] {
  if (sorted.length <= max) return sorted;
  const picked = new Set<number>([0, sorted.length - 1]);
  for (let i = 1; picked.size < max; i++) picked.add(Math.round((i * (sorted.length - 1)) / (max - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => sorted[i]);
}

/**
 * Code-only selection of what the model may look at: a Memory keyword the user came back to in at least `minConversations` different conversations
 * over at least `minSpanDays`. One evidence item per conversation (its latest Memory on the theme).
 */
export function buildSynthesisClusters(memories: MemoryObject[], options: { maxClusters?: number } = {}): SynthesisCluster[] {
  const groups = new Map<string, { theme: string; byConversation: Map<string, MemoryObject> }>();
  for (const m of memories) {
    if (!isSynthesisSource(m)) continue;
    for (const k of m.keywords ?? []) {
      const key = normalizeAnalyticsKeyword(k);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) { g = { theme: k.trim(), byConversation: new Map() }; groups.set(key, g); }
      const prev = g.byConversation.get(m.conversationId as string);
      if (!prev || timeOf(m) > timeOf(prev)) g.byConversation.set(m.conversationId as string, m);
    }
  }
  const candidates: SynthesisCluster[] = [];
  for (const g of groups.values()) {
    if (g.byConversation.size < SYNTHESIS_LIMITS.minConversations) continue;
    const sorted = [...g.byConversation.values()].sort((a, b) => timeOf(a) - timeOf(b)).map(toEvidence);
    const span = Date.parse(sorted[sorted.length - 1].statedAt) - Date.parse(sorted[0].statedAt);
    if (!(span >= SYNTHESIS_LIMITS.minSpanDays * DAY_MS)) continue;
    candidates.push({ theme: g.theme, evidence: spreadOverTime(sorted, SYNTHESIS_LIMITS.maxEvidencePerCluster) });
  }
  candidates.sort((a, b) => b.evidence.length - a.evidence.length || a.theme.localeCompare(b.theme));
  const chosen: SynthesisCluster[] = [];
  for (const c of candidates) {
    const ids = new Set(c.evidence.map((e) => e.id));
    const overlaps = chosen.some((o) => o.evidence.filter((e) => ids.has(e.id)).length / Math.min(ids.size, o.evidence.length) > 0.6);
    if (!overlaps) chosen.push(c);
    if (chosen.length >= (options.maxClusters ?? SYNTHESIS_LIMITS.maxClusters)) break;
  }
  return chosen;
}

/** the text the model sees: ids, both dates kept apart, the latest point marked, the summary and (if kept) the user's own words */
export function renderClustersForModel(clusters: SynthesisCluster[]): string {
  return clusters
    .map((c, i) => {
      const lines = c.evidence.map((e, n) => {
        const said = `${e.statedAtIsRecordDate ? "記録日" : "発言日"} ${e.statedAt.slice(0, 10)}`;
        const event = e.eventTime ? ` / 出来事の時期 ${e.eventTime}` : "";
        const latest = n === c.evidence.length - 1 ? " / このテーマで最新" : "";
        const quote = e.quote ? `\n    本人の言葉:「${e.quote}」` : "";
        return `  - id=${e.id}（${said}${event}${latest}）\n    要約: ${e.summary}${quote}`;
      });
      return `テーマ${i + 1}「${c.theme}」\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * Words that put a motive, a purpose or a psychological reading on the user. A statement may use one only if the user's own records of that theme contain it.
 * (A code check, because a prompt alone did not keep the model from writing "〜のための手段" / "欲求が強まっている".)
 */
export const INTERPRETATION_TERMS = ["手段", "欲求", "心理", "深層", "性格", "本当は", "無意識", "承認", "依存", "逃避", "防衛", "癒し", "図る", "図ろう", "ストレス解消", "求めている", "求める", "強まって", "精神的", "感情調整", "自己"];

const KINDS: SynthesisKind[] = ["change", "pattern", "tension"];
const SUPPORTS: SynthesisSupport[] = ["stated", "derived", "hypothesis"];

/**
 * Server-side gate for what the model returned. Keeps only items whose evidence ids are real and from one common theme, with enough evidence for their kind:
 *   change >= 2 Memories said on different days;  pattern >= 3 different conversations;  tension >= 2 Memories and a situation note, never "stated".
 * Dates are recomputed from the evidence; unfounded interpretation words drop the item. Every drop is counted by reason (so "nothing proposed",
 * "everything rejected" and "everything kept" can be told apart).
 */
export function validateSynthesisItems(raw: unknown, clusters: SynthesisCluster[]): SynthesisValidation {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  const dropped: Partial<Record<SynthesisDropReason, number>> = {};
  const drop = (r: SynthesisDropReason) => { dropped[r] = (dropped[r] ?? 0) + 1; };
  // one Memory can be evidence in several themes: an item is valid when ALL its ids belong to one common theme
  const evidenceById = new Map<string, { e: SynthesisEvidence; clusters: Set<number> }>();
  clusters.forEach((c, ci) => c.evidence.forEach((e) => {
    const known = evidenceById.get(e.id);
    if (known) known.clusters.add(ci); else evidenceById.set(e.id, { e, clusters: new Set([ci]) });
  }));
  const items: SynthesisItem[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") { drop("malformed"); continue; }
    const item = r as Record<string, unknown>;
    const kind = item.kind as SynthesisKind;
    const statement = typeof item.statement === "string" ? item.statement.trim() : "";
    if (!KINDS.includes(kind) || !statement || statement.length > SYNTHESIS_LIMITS.maxStatementLength) { drop("malformed"); continue; }
    const ids = Array.isArray(item.evidenceIds) ? [...new Set(item.evidenceIds.filter((x): x is string => typeof x === "string" && evidenceById.has(x)))] : [];
    if (ids.length === 0) { drop("unknown-evidence"); continue; }
    const clusterIndex = [...evidenceById.get(ids[0])!.clusters].find((ci) => ids.every((id) => evidenceById.get(id)!.clusters.has(ci)));
    if (clusterIndex === undefined) { drop("mixed-themes"); continue; }
    const ev = ids.map((id) => evidenceById.get(id)!.e).sort((a, b) => Date.parse(a.statedAt) - Date.parse(b.statedAt));
    const days = new Set(ev.map((e) => e.statedAt.slice(0, 10)));
    const conversations = new Set(ev.map((e) => e.conversationId));
    if ((kind === "change" && days.size < 2) || (kind === "pattern" && conversations.size < SYNTHESIS_LIMITS.minConversations) || (kind === "tension" && ev.length < 2)) { drop("too-little-evidence"); continue; }
    const situationNote = typeof item.situationNote === "string" ? item.situationNote.trim().slice(0, SYNTHESIS_LIMITS.maxStatementLength) : "";
    if (kind === "tension" && !situationNote) { drop("missing-situation"); continue; }
    const userText = clusters[clusterIndex].evidence.map((e) => `${e.summary} ${e.quote ?? ""}`).join(" ");
    if (INTERPRETATION_TERMS.some((t) => (statement.includes(t) || situationNote.includes(t)) && !userText.includes(t))) { drop("unfounded-interpretation"); continue; }
    const asked = SUPPORTS.includes(item.support as SynthesisSupport) ? (item.support as SynthesisSupport) : "hypothesis";
    const support: SynthesisSupport = kind === "tension" && asked === "stated" ? "derived" : asked;
    items.push({
      kind,
      theme: clusters[clusterIndex].theme,
      statement,
      support,
      evidenceIds: ev.map((e) => e.id),
      firstStatedAt: ev[0].statedAt,
      lastStatedAt: ev[ev.length - 1].statedAt,
      ...(situationNote ? { situationNote } : {}),
    });
    if (items.length >= SYNTHESIS_LIMITS.maxItems) break;
  }
  return { items, proposed: list.length, dropped };
}

/** An item is usable only while ALL of its evidence Memories still exist (a deleted Memory takes the whole item with it). */
export function dropItemsWithMissingEvidence(items: SynthesisItem[], existingMemoryIds: Set<string>): SynthesisItem[] {
  return items.filter((i) => i.evidenceIds.every((id) => existingMemoryIds.has(id)));
}

/** FACTS: the dated timeline of a theme from the Memories that exist now: the earliest, a middle one and the two latest; the very latest is marked. */
export function buildThemeTimeline(theme: string, memories: MemoryObject[]): SynthesisTimelinePoint[] {
  const onTheme = memories.filter((m) => isSynthesisSource(m) && hasTheme(m, theme)).sort((a, b) => timeOf(a) - timeOf(b));
  if (onTheme.length === 0) return [];
  const n = onTheme.length;
  const idx = n <= SYNTHESIS_LIMITS.maxTimelinePoints ? onTheme.map((_, i) => i) : [...new Set([0, Math.floor((n - 2) / 2), n - 2, n - 1])].sort((a, b) => a - b);
  return idx.map((i) => {
    const m = onTheme[i];
    const stated = statedAtOf(m);
    return { statedAt: stated.at, statedAtIsRecordDate: stated.isRecordDate, ...(m.eventTime ? { eventTime: m.eventTime } : {}), summary: m.summary.trim().slice(0, SYNTHESIS_LIMITS.summaryLength), latest: i === n - 1 };
  });
}

const STOP_TERMS = new Set(["今日", "最近", "以前", "前回", "今", "話", "日", "気", "人", "前", "後", "時", "中", "方", "事", "何", "少", "思", "感", "行", "来", "見", "言", "私", "夜", "週末"]);

/**
 * Words that characterise a theme in the user's own records (kanji / katakana runs that occur in at least 40% of the theme's Memories, at least twice).
 * Lets "走ろう" find the theme "ランニング" through "走" (川沿いを5km走り / 走りたくなる / 走れず ...) without an AI call and without a synonym list.
 */
export function themeTerms(theme: string, memories: MemoryObject[]): string[] {
  const docs = memories.filter((m) => isSynthesisSource(m) && hasTheme(m, theme)).map((m) => `${m.summary} ${(m.evidenceQuotes ?? []).join(" ")} ${(m.keywords ?? []).join(" ")}`);
  if (docs.length === 0) return [];
  const runs = new Set<string>();
  for (const d of docs) for (const r of d.match(/[一-鿿々]+|[ァ-ヺー]{2,}/g) ?? []) runs.add(r);
  const terms = [...runs].filter((t) => !STOP_TERMS.has(t)).filter((t) => {
    const df = docs.filter((d) => d.includes(t)).length;
    return df >= 2 && df / docs.length >= 0.4;
  });
  return [...new Set([theme.trim(), ...terms])];
}

/**
 * Which themes (if any) this chat turn receives. A theme is attached only when BOTH hold:
 *   related - the user's words contain one of the theme's own terms, or the normal retrieval returned 2+ of its Memories;
 *   adds    - the theme's timeline / evidence holds Memories that the normal retrieval did NOT already bring (otherwise retrieval alone is enough).
 * Unrelated turns get nothing; the normal retrieval is never replaced.
 */
export function selectSynthesisForTurn(
  items: SynthesisItem[],
  turn: { userText: string; retrievedMemoryIds: string[] },
  memories: MemoryObject[]
): SynthesisThemeContext[] {
  const retrieved = new Set(turn.retrievedMemoryIds);
  const existing = new Set(memories.map((m) => m.id));
  const live = dropItemsWithMissingEvidence(items, existing);
  const byTheme = new Map<string, SynthesisItem[]>();
  for (const i of live) byTheme.set(i.theme, [...(byTheme.get(i.theme) ?? []), i]);
  const out: { ctx: SynthesisThemeContext; score: number }[] = [];
  for (const [theme, themeItems] of byTheme) {
    const evidenceIds = new Set(themeItems.flatMap((i) => i.evidenceIds));
    const shared = [...evidenceIds].filter((id) => retrieved.has(id)).length;
    const termHit = themeTerms(theme, memories).some((t) => turn.userText.includes(t));
    if (!termHit && shared < 2) continue;
    const themeMemoryIds = memories.filter((m) => isSynthesisSource(m) && hasTheme(m, theme)).map((m) => m.id);
    const adds = themeMemoryIds.some((id) => !retrieved.has(id));
    if (!adds) continue;
    out.push({ ctx: { theme, timeline: buildThemeTimeline(theme, memories), items: themeItems.slice(0, SYNTHESIS_LIMITS.maxItemsPerTheme) }, score: shared * 2 + (termHit ? 1 : 0) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, SYNTHESIS_LIMITS.maxThemesPerTurn).map((x) => x.ctx);
}

/** chat route: accepts only well-formed theme contexts, within the limits */
export function sanitizeSynthesisContext(raw: unknown): SynthesisThemeContext[] {
  if (!Array.isArray(raw)) return [];
  const out: SynthesisThemeContext[] = [];
  for (const r of raw.slice(0, SYNTHESIS_LIMITS.maxThemesPerTurn)) {
    if (!r || typeof r !== "object" || typeof (r as { theme?: unknown }).theme !== "string") continue;
    const ctx = r as { theme: string; timeline?: unknown; items?: unknown };
    const timeline = (Array.isArray(ctx.timeline) ? ctx.timeline : [])
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { statedAt?: unknown }).statedAt === "string" && typeof (p as { summary?: unknown }).summary === "string")
      .slice(0, SYNTHESIS_LIMITS.maxTimelinePoints)
      .map((p) => ({
        statedAt: (p.statedAt as string).slice(0, 10),
        statedAtIsRecordDate: p.statedAtIsRecordDate === true,
        ...(typeof p.eventTime === "string" ? { eventTime: p.eventTime.slice(0, 10) } : {}),
        summary: (p.summary as string).slice(0, SYNTHESIS_LIMITS.summaryLength),
        latest: p.latest === true,
      }));
    const items: SynthesisItem[] = [];
    for (const x of Array.isArray(ctx.items) ? ctx.items : []) {
      if (!x || typeof x !== "object") continue;
      const i = x as Record<string, unknown>;
      if (!KINDS.includes(i.kind as SynthesisKind)) continue;
      if (typeof i.statement !== "string" || !i.statement.trim() || i.statement.length > SYNTHESIS_LIMITS.maxStatementLength) continue;
      if (typeof i.firstStatedAt !== "string" || typeof i.lastStatedAt !== "string") continue;
      if (!Array.isArray(i.evidenceIds) || i.evidenceIds.length === 0 || !i.evidenceIds.every((y) => typeof y === "string")) continue;
      const kind = i.kind as SynthesisKind;
      const asked = SUPPORTS.includes(i.support as SynthesisSupport) ? (i.support as SynthesisSupport) : "hypothesis";
      items.push({
        kind,
        theme: ctx.theme.slice(0, 40),
        statement: i.statement.trim(),
        support: kind === "tension" && asked === "stated" ? "derived" : asked,
        evidenceIds: (i.evidenceIds as string[]).slice(0, SYNTHESIS_LIMITS.maxEvidencePerCluster),
        firstStatedAt: i.firstStatedAt,
        lastStatedAt: i.lastStatedAt,
        ...(typeof i.situationNote === "string" && i.situationNote.trim() ? { situationNote: i.situationNote.trim().slice(0, SYNTHESIS_LIMITS.maxStatementLength) } : {}),
      });
      if (items.length >= SYNTHESIS_LIMITS.maxItemsPerTheme) break;
    }
    if (timeline.length > 0 || items.length > 0) out.push({ theme: ctx.theme.slice(0, 40), timeline, items });
  }
  return out;
}

const KIND_LABEL: Record<SynthesisKind, string> = { change: "変化", pattern: "繰り返し", tension: "揺れ" };
const SUPPORT_LABEL: Record<SynthesisSupport, string> = { stated: "本人が話した内容", derived: "複数の発言を並べると見えること", hypothesis: "Tsumugiの仮説" };

/** the chat section. Empty when there is nothing for this turn (the prompt is then byte-for-byte what it was before). */
export function buildSynthesisSection(contexts: SynthesisThemeContext[]): string {
  if (contexts.length === 0) return "";
  const blocks = contexts
    .map((c) => {
      const facts = c.timeline
        .map((p) => `  - ${p.statedAt.slice(0, 10)}に${p.statedAtIsRecordDate ? "記録" : "話した"}${p.eventTime ? `（出来事の時期: ${p.eventTime}）` : ""}${p.latest ? "【このテーマで最新】" : ""}: ${p.summary}`)
        .join("\n");
      const understanding = c.items
        .map((i) => `  - [${KIND_LABEL[i.kind]}・${SUPPORT_LABEL[i.support]}] ${i.statement}${i.situationNote ? `（状況の違い: ${i.situationNote}）` : ""}`)
        .join("\n");
      return `テーマ「${c.theme}」\n 記録された経緯（日付はシステムが記録から確定したもの。要約はAIによる記録）:\n${facts}${understanding ? `\n Tsumugiの整理:\n${understanding}` : ""}`;
    })
    .join("\n\n");
  return `

## 複数の会話にわたる経緯（今回の話題に関係するテーマだけ）

${blocks}

使い方：
- 「このテーマで最新」の記録が、このテーマの今の状態の起点。それより前の記録は経緯として扱い、今もそうだと決めつけない。
- 最新の記録で結果や答えがすでに出ていることを、改めて尋ねない（例：「保留になった」と記録されている予定について「どうでしたか」と聞かない）。聞くなら、その後のことや、今どう感じているかを聞く。
- 今の発言に本当に関係するときだけ、自然に一度生かす。関係が薄ければ触れない。毎回持ち出さない。
- 生かすときは、整理の言い換えではなく、経緯の具体的な中身（いつ頃、何を話していたか）に触れて今の発言とつなげる。日付は「5月ごろ」「先月」のように自然に言えばよい。
- 「Tsumugiの仮説」「複数の発言を並べると見えること」は事実として断定しない。確かめるように触れる。
- 「揺れ」は矛盾の指摘ではない。状況が違えば望みが違うのは自然なこととして扱う。
- 話した日付は出来事の日付ではない。
- 記録に無い動機・目的・心理を付け足さない。性格や心理のラベル（「〜な人」「〜を求めている」「心を守る」等）を付けない。`;
}
