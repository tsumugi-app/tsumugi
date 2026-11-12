/**
 * P1-F: what each route gives the chat AI, for the debug view (`?debugLog=1` only). Pure functions, no I/O, no storage, no AI call: the client runs it on
 * the request body it sends, the chat route on what it accepted (after its checks and filters), and the debug badge shows both side by side.
 *
 * For every item: the route, the Memory ID(s), whose words they are (本人の発言 / 後からの本人の説明・訂正 / AIの要約 / AIの推測), why the route took
 * it, and a short clip of the text (never the whole text: a debug view is not a copy of the Memories). Also: the Memories sent by more than one route,
 * and the user's reasons / corrections the turn carries (said later, or in the form of a reason or a correction).
 *
 * Nothing here decides what is sent: the chat request and the prompt are the same with or without it.
 */
import type { RetrievedMemory } from "./types";
import type { TopicTimeline } from "./topicEvent";
import type { TopicContinuityMemoryRef } from "./topicContinuity";
import type { SynthesisThemeContext } from "./memorySynthesis";
import type { PersonContext } from "./personContextPrompt";
import type { ExplicitSearchContext } from "./memorySearch";
import { CORRECTION_FORM, REASON_FORM } from "./personStance";

export type ProvenancePath =
  | "Retrieval"
  | "Reflection"
  | "Topic Continuity"
  | "Topic Timeline"
  | "Memory Timeline"
  | "Memory Synthesis"
  | "Memory Graph"
  | "Explicit Search";

export const PROVENANCE_PATHS: ProvenancePath[] = ["Retrieval", "Reflection", "Explicit Search", "Topic Continuity", "Topic Timeline", "Memory Timeline", "Memory Synthesis", "Memory Graph"];

export type ProvenanceKind = "本人の発言" | "後からの本人の説明・訂正" | "AIの要約" | "AIの推測";

export interface ProvenanceEntry {
  path: ProvenancePath;
  /** the Memories the item comes from ([] when the route does not carry an id) */
  memoryIds: string[];
  kind: ProvenanceKind;
  /** the Memory's metadata.source, when the route carries it */
  source?: string;
  why: string;
  /** a short clip of the text */
  text: string;
  /** a nameless record that may be about the person (Memory Graph): the user's words, but not confirmed as about this person */
  candidate?: boolean;
  /** the user's words in the form of a reason or a correction (read on the whole text, before the clip) */
  explanationForm?: boolean;
  /** routes without an id on the server (Topic Continuity / Topic Timeline): which item this is (date, conversation, whole text), to match the client's id to it */
  ref?: string;
}

export interface ContextProvenance {
  entries: ProvenanceEntry[];
  /** Memories given by two routes or more */
  duplicates: { memoryId: string; paths: ProvenancePath[] }[];
  /** the user's reasons and corrections among the entries */
  explanations: { path: ProvenancePath; memoryIds: string[]; how: string; text: string }[];
  /** entries per route (before the entry limit) */
  counts: Partial<Record<ProvenancePath, number>>;
  /** more entries than PROVENANCE_LIMITS.maxEntries: the rest are counted, not listed */
  truncated: boolean;
}

export const PROVENANCE_LIMITS = { maxEntries: 120, clipChars: 40 } as const;

export interface ProvenanceInput {
  retrievedMemories?: RetrievedMemory[] | null;
  topicContinuity?: { topicId: string; memories: TopicContinuityMemoryRef[] }[] | null;
  topicTimeline?: TopicTimeline[] | null;
  memoryTimeline?: SynthesisThemeContext[] | null;
  personContext?: PersonContext[] | null;
  explicitSearch?: ExplicitSearchContext | null;
}

/** the client side only: finds the Memory of a route that does not carry an id (the server has no Memories and leaves them empty) */
export interface ProvenanceLookup {
  topicContinuityId?: (ref: TopicContinuityMemoryRef) => string | undefined;
  topicTimelineId?: (event: { time: string; quote: string; sourceConversationId: string }) => string | undefined;
}

const clip = (text: string) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return Array.from(t).length > PROVENANCE_LIMITS.clipChars ? `${Array.from(t).slice(0, PROVENANCE_LIMITS.clipChars).join("")}…` : t;
};
const isExplanationForm = (text: string) => REASON_FORM.test(text) || CORRECTION_FORM.test(text);
const ids = (...xs: (string | undefined)[]) => xs.filter((x): x is string => typeof x === "string" && x.length > 0);

const SUPPORT_WHY: Record<string, string> = { stated: "本人が話した内容としてAIがまとめた", derived: "複数の発言を並べてAIが読み取った", hypothesis: "Tsumugiの仮説" };
const KIND_WHY: Record<string, string> = { change: "変化", pattern: "繰り返し", tension: "揺れ" };

export function buildContextProvenance(input: ProvenanceInput, lookup: ProvenanceLookup = {}): ContextProvenance {
  const all: ProvenanceEntry[] = [];
  // the reason / correction form is read on the whole text, before the clip
  const explanationForm = new Set<ProvenanceEntry>();
  const add = (e: ProvenanceEntry) => {
    const entry = { ...e, text: clip(e.text) };
    all.push(entry);
    if (e.kind === "本人の発言" && !e.candidate && isExplanationForm(e.text)) explanationForm.add(entry);
  };

  for (const m of input.retrievedMemories ?? []) {
    const reflection = m.source === "system-generated";
    const path: ProvenancePath = reflection ? "Reflection" : "Retrieval";
    const why = m.isOriginMemory ? "この会話のきっかけの記憶"
      : m.linkReason ? "Connectのつながりで追加"
      : m.matchType === "divergent" ? "あえて遠い記憶（発想の材料）"
      : "今の発言との一致（キーワード・本文）";
    add({ path, memoryIds: [m.id], kind: "AIの要約", source: m.source, why: reflection ? `AIが書いた日記の振り返り・${why}` : why, text: m.summary });
    if (m.quote) add({ path, memoryIds: [m.id], kind: "本人の発言", source: m.source, why: "要約に無い本人の発言の一文", text: m.quote });
    if (m.linkReason) add({ path, memoryIds: [m.id], kind: "AIの推測", source: m.source, why: "Connectのつながりの理由（AIの仮説）", text: m.linkReason });
  }

  if (input.explicitSearch) {
    for (const r of input.explicitSearch.results) {
      add({ path: "Explicit Search", memoryIds: [r.id], kind: "AIの要約", why: `明示的な検索（検索語：${input.explicitSearch.terms.join("・")}）`, text: r.summary });
      for (const q of r.evidenceQuotes) add({ path: "Explicit Search", memoryIds: [r.id], kind: "本人の発言", why: "逐語の抜粋", text: q });
    }
  }

  for (const topic of input.topicContinuity ?? []) {
    for (const ref of topic.memories) add({ path: "Topic Continuity", memoryIds: ids(lookup.topicContinuityId?.(ref)), kind: "AIの要約", why: "続きを指す言い回しがあり、同じ話題の候補", text: ref.summary, ref: JSON.stringify([ref.date, ref.summary]) });
  }

  for (const timeline of input.topicTimeline ?? []) {
    for (const event of timeline.events) add({ path: "Topic Timeline", memoryIds: ids(lookup.topicTimelineId?.(event)), kind: "本人の発言", why: "取得した記録と同じ話題の経緯（逐語）", text: event.quote, ref: JSON.stringify([event.time, event.sourceConversationId, event.quote]) });
  }

  for (const ctx of input.memoryTimeline ?? []) {
    for (const p of ctx.timeline) {
      const tags = [p.stateBasis ? "今の状態の根拠" : "", p.latestSaid ? "最後に話した記録" : "", p.retrospective ? "以前の出来事を後から話したもの" : "", p.earlierState ? "それより前の状態" : ""].filter(Boolean).join("・");
      add({ path: "Memory Timeline", memoryIds: ids(p.memoryId), kind: "AIの要約", why: `テーマ「${ctx.theme}」の経緯${tags ? `（${tags}）` : ""}`, text: p.summary });
    }
    for (const i of ctx.items) add({ path: "Memory Synthesis", memoryIds: [...i.evidenceIds], kind: i.support === "stated" ? "AIの要約" : "AIの推測", why: `テーマ「${ctx.theme}」の${KIND_WHY[i.kind] ?? i.kind}・${SUPPORT_WHY[i.support] ?? i.support}`, text: i.statement });
    for (const c of ctx.corrections ?? []) add({ path: "Memory Synthesis", memoryIds: [], kind: "後からの本人の説明・訂正", why: `Tsumugiの見方へのユーザー自身の${c.kind === "corrected" ? "訂正" : "否定"}（${c.saidAt}）`, text: c.userQuote });
  }

  for (const p of input.personContext ?? []) {
    const who = p.names[0] ?? p.key;
    if (p.relation?.basis) add({ path: "Memory Graph", memoryIds: ids(p.relation.basis.memoryId), kind: "本人の発言", why: `${who}：関係（${p.relation.label}）の根拠`, text: p.relation.basis.text });
    for (const c of p.conclusions) {
      const candidate = c.statement.kind === "candidate";
      add({ path: "Memory Graph", memoryIds: ids(c.statement.memoryId), kind: c.statement.kind === "summary" ? "AIの要約" : "本人の発言", candidate, why: `${who}：過去の考え・結論${candidate ? "（名前の無い記録の候補。この人の話か確定していない）" : ""}`, text: c.statement.text });
      for (const r of c.reasons) {
        if (r.when !== "later") continue;
        add({ path: "Memory Graph", memoryIds: ids(r.memoryId), kind: "後からの本人の説明・訂正", why: `${who}：後から本人が説明した理由（${r.link === "topic" ? "同じ話題" : "共通の言葉からの推測"}）`, text: r.text });
      }
      for (const a of c.aiReadings) add({ path: "Memory Graph", memoryIds: ids(a.memoryId), kind: "AIの推測", why: `${who}：AIの要約の解釈`, text: a.text });
    }
    for (const plan of p.plans) {
      add({ path: "Memory Graph", memoryIds: ids(plan.plan.memoryId), kind: "AIの要約", why: `${who}：予定・希望`, text: plan.plan.text });
      if (plan.outcome) add({ path: "Memory Graph", memoryIds: ids(plan.outcome.memoryId), kind: "AIの要約", why: `${who}：予定の結果の候補（${plan.outcome.status}）`, text: plan.outcome.text });
    }
    for (const e of p.events) add({ path: "Memory Graph", memoryIds: ids(e.memoryId), kind: "AIの要約", why: `${who}：最近の出来事`, text: e.text });
    for (const c of p.candidates) add({ path: "Memory Graph", memoryIds: ids(c.memoryId), kind: "本人の発言", candidate: true, why: `${who}：名前の無い記録の候補（${c.signals.join("・")}）`, text: c.text });
  }

  for (const e of all) if (explanationForm.has(e)) e.explanationForm = true;
  return summarize(all);
}

/** duplicates, explanations and counts of a list of entries (also after the client's ids are added to the server's entries) */
function summarize(all: ProvenanceEntry[]): ContextProvenance {
  const pathsById = new Map<string, Set<ProvenancePath>>();
  for (const e of all) for (const id of e.memoryIds) pathsById.set(id, (pathsById.get(id) ?? new Set()).add(e.path));
  const duplicates = [...pathsById].filter(([, paths]) => paths.size >= 2).map(([memoryId, paths]) => ({ memoryId, paths: PROVENANCE_PATHS.filter((p) => paths.has(p)) }));
  const explanations: ContextProvenance["explanations"] = all
    .filter((e) => e.kind === "後からの本人の説明・訂正" || e.explanationForm)
    .map((e) => ({ path: e.path, memoryIds: e.memoryIds, how: e.kind === "後からの本人の説明・訂正" ? e.why : "理由・訂正の形の本人の発言", text: e.text }));
  const counts: Partial<Record<ProvenancePath, number>> = {};
  for (const e of all) counts[e.path] = (counts[e.path] ?? 0) + 1;
  return { entries: all.slice(0, PROVENANCE_LIMITS.maxEntries), duplicates: duplicates.slice(0, PROVENANCE_LIMITS.maxEntries), explanations: explanations.slice(0, PROVENANCE_LIMITS.maxEntries), counts, truncated: all.length > PROVENANCE_LIMITS.maxEntries };
}

/**
 * the server's entries with the Memory ids the client found for the routes that carry no id (Topic Continuity, Topic Timeline): taken from the sent entry
 * of the same route, kind and text. Then the duplicates and the explanations are counted again.
 */
export function withSentIds(accepted: ContextProvenance, sent: ContextProvenance): ContextProvenance {
  // the item's own identity (date, conversation, whole text) first: the same words on another day are another item; the clip only when there is none
  const keyOf = (e: ProvenanceEntry) => (e.ref !== undefined ? `${e.path}\n${e.ref}` : `${e.path}\n${e.kind}\n${e.text}`);
  const idsOf = new Map<string, string[]>();
  for (const e of sent.entries) if (e.memoryIds.length > 0) idsOf.set(keyOf(e), e.memoryIds);
  const entries = accepted.entries.map((e) => (e.memoryIds.length > 0 ? e : { ...e, memoryIds: idsOf.get(keyOf(e)) ?? [] }));
  const merged = summarize(entries);
  // the server may have more entries than it listed: keep its counts
  return { ...merged, counts: accepted.counts, truncated: accepted.truncated, explanations: merged.explanations.length > 0 || accepted.explanations.length === 0 ? merged.explanations : accepted.explanations };
}

/**
 * what the client sent but the chat AI did not get in that route (the route's checks, limits and the time filter). Compared per route by the text (the
 * kind may change when the route checks it, e.g. a tension "stated" becomes "derived"; ids are absent on the server for some routes). An item whose
 * Memory still reached the AI through another route (a Retrieval item that is in the Explicit Search) says so.
 */
export function notAccepted(sent: ContextProvenance, accepted: ContextProvenance | null): (ProvenanceEntry & { note?: string })[] {
  if (!accepted) return [];
  const textKey = (e: ProvenanceEntry) => `${e.path}\n${e.text}`;
  const got = new Set(accepted.entries.map(textKey));
  const acceptedPathsOf = (id: string) => [...new Set(accepted.entries.filter((e) => e.memoryIds.includes(id)).map((e) => e.path))];
  return sent.entries.filter((e) => !got.has(textKey(e))).map((e) => {
    const elsewhere = [...new Set(e.memoryIds.flatMap(acceptedPathsOf))].filter((p) => p !== e.path);
    return elsewhere.length > 0 ? { ...e, note: `同じMemoryは${elsewhere.join("・")}で渡った` } : e;
  });
}

/** what retrieval did with the AI's diary reflections this turn (retrieval.ts, chat only) */
export interface ReflectionTrace {
  /** the user's words asked about a reflection or the diary: reflections were ranked as before */
  asksAboutReflection: boolean;
  /** reflections given after the user's own records (a slot was left) */
  deferred: string[];
  dropped: { memoryId: string; why: string }[];
}

/** the debug badge's text: one line per item, grouped by route */
export function formatContextProvenance(record: { sent: ContextProvenance; accepted: ContextProvenance | null; reflection?: ReflectionTrace | null }): string {
  const { sent, accepted, reflection } = record;
  const shown = accepted ? withSentIds(accepted, sent) : sent;
  const lines: string[] = [`会話AIに渡った情報（${accepted ? "サーバーが受け取り、プロンプトに使った値" : "送信した値（サーバー側の値は未取得）"}）`];
  for (const path of PROVENANCE_PATHS) {
    const items = shown.entries.filter((e) => e.path === path);
    if (items.length === 0) continue;
    lines.push("", `■ ${path}（${shown.counts[path] ?? items.length}件）`);
    for (const e of items) lines.push(`- [${e.kind}] ${e.memoryIds.join(",") || "ID無し"}${e.source ? ` (${e.source})` : ""}：${e.why}\n    「${e.text}」`);
  }
  if (shown.truncated) lines.push("", `（${PROVENANCE_LIMITS.maxEntries}件を超えた分は省略）`);
  lines.push("", "■ 複数の経路から渡ったMemory");
  if (shown.duplicates.length === 0) lines.push("- なし");
  for (const d of shown.duplicates) lines.push(`- ${d.memoryId}：${d.paths.join("・")}`);
  lines.push("", "■ 本人の理由・訂正");
  if (shown.explanations.length === 0) lines.push("- このターンには含まれていない");
  for (const x of shown.explanations) lines.push(`- ${x.path} ${x.memoryIds.join(",") || "ID無し"}：${x.how}「${x.text}」`);
  if (reflection) {
    lines.push("", "■ Reflection（AIが書いた日記の振り返り）の扱い");
    lines.push(reflection.asksAboutReflection ? "- 発言が振り返り・日記に書いたことを尋ねているので、従来どおり本人の記録と同じ順位で選んだ"
      : reflection.deferred.length + reflection.dropped.length === 0 ? "- 候補にReflectionは無かった" : "- キーワードの一致する本人の記録を先に選び、Reflectionはその後に回した");
    for (const id of reflection.deferred) lines.push(`- ${id}：空いた枠に入れた（本人の記録の後）`);
    for (const d of reflection.dropped) lines.push(`- ${d.memoryId}：入れなかった（${d.why}）`);
  }
  const missing = notAccepted(sent, accepted);
  if (accepted) {
    lines.push("", "■ 送ったが会話AIに渡らなかったもの（サーバーの確認・上限・時間で変わる事実の除外）");
    if (missing.length === 0) lines.push("- なし");
    for (const e of missing) lines.push(`- ${e.path} [${e.kind}] ${e.memoryIds.join(",") || "ID無し"}「${e.text}」${e.note ? `（${e.note}）` : ""}`);
  }
  return lines.join("\n");
}
