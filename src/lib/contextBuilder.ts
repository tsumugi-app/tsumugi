/**
 * P1-H 段階1：Context Builder（診断専用・`?debugLog=1`のときだけ）。
 *
 * 会話AIに渡るすべての経路（直前の会話・Topic Continuity・Topic Timeline・PersonView・Memory Graph・Memory Timeline・Synthesis・Profile・
 * Explicit Search・Memory Analytics・Retrieval）の最終候補を、1つの読み取り専用の形（ContextUnit）に並べ、質問の目的に照らして
 * 「採用・保留・除外」を判定し、現行の入力と「Context Builderを適用した仮想の入力」を比べる。
 *
 * - 純関数。I/Oも保存もAI呼び出しも無い。入力は最初にJSONとして複製するので、渡された値を書き換えない。
 * - ここで判定したことは、実際にAIへ送る内容・順序・件数を一切変えない（チャット画面は結果を診断表示に使うだけ）。
 * - 「現行の入力」は、チャットのrouteがプロンプトを作るときと同じ確認（sanitize・Explicit Searchとの重複除外・時間で変わる事実の除外・
 *   経緯の件数の上限）を通した値で、並びはプロンプトの節の順（route.tsのsystemInstruction）と同じ。
 *
 * 判定の意味：
 * - 採用：仮想の入力に入れる。
 * - 保留：仮想の入力に「入れる」（渡さないのではない）。同じ節の採用より後ろに置き、段階2で減らす候補として示すだけ。
 * - 除外：仮想の入力に入れない。完全な重複（同じMemory ID・同じ種類・同じ本文）と、質問の話題・人物がはっきり読めるときの、
 *   話題にも人物にも一致しない補助の経路（Memory Graph・Memory Timeline・Topic Continuity）の項目だけ。
 *   本人の理由・訂正、人物の関係の行、直前の会話、Profile、Explicit Search、Memory Analyticsは除外しない。
 * - 質問の種類が読み切れないとき（指示語だけの続き・空の発言など）や、仮想の入力が本人の理由・訂正や人物の行を落とすときは、
 *   安全側としてすべて採用（＝現行の入力のまま）にする。
 */
import type { MemoryObject, RetrievedMemory } from "./types";
import type { TopicContinuityMemoryRef } from "./topicContinuity";
import type { ProfileContext } from "./profile";
import type { PersonView } from "./person";
import type { ExplicitSearchContext } from "./memorySearch";
import type { MemoryAnalyticsContext } from "./memoryAnalytics";
import type { SynthesisThemeContext } from "./memorySynthesis";
import type { PersonContext, PersonContextText } from "./personContextPrompt";
import { sanitizeProfileContext } from "./profile";
import { sanitizePersonViewContext } from "./person";
import { sanitizeExplicitSearchContext } from "./memorySearch";
import { sanitizeMemoryAnalyticsContext } from "./memoryAnalytics";
import { sanitizeSynthesisContext } from "./memorySynthesis";
import { sanitizePersonContext } from "./personContextPrompt";
import { sanitizeTopicTimelineContext, selectTimelineEventsForBudget, TOPIC_TIMELINE_BUDGET } from "./topicEvent";
import { isTimeDependentMemory, sanitizeMemoryContext, withoutOutsideFactQuote } from "./memoryContext";
import { needsWebSearch } from "./needsWebSearch";
import { stripLeadingTimeLabels } from "./timeLabel";
import { purposeContextOf, type QuestionPurpose } from "./recordRelevance";
import { questionTopicRuns } from "./recallQuestion";
import { CORRECTION_FORM, REASON_FORM } from "./personStance";

export type ContextRoute =
  | "Recent Conversation"
  | "Topic Continuity"
  | "Topic Timeline"
  | "PersonView"
  | "Memory Graph"
  | "Memory Timeline"
  | "Memory Synthesis"
  | "Profile"
  | "Explicit Search"
  | "Memory Analytics"
  | "Retrieval"
  | "Reflection";

/** the sections of the chat prompt, in the order route.ts writes them (Memory Timeline and Synthesis share one section; Reflection is in Retrieval's) */
export const PROMPT_SECTIONS: { title: string; heading: string; routes: ContextRoute[] }[] = [
  { title: "直前の会話", heading: "## 直前の会話", routes: ["Recent Conversation"] },
  { title: "継続中かもしれない話題の候補", heading: "## 継続中かもしれない話題の候補", routes: ["Topic Continuity"] },
  { title: "これまでの経緯（逐語）", heading: "## これまでの経緯", routes: ["Topic Timeline"] },
  { title: "関係する人物", heading: "## 関係する人物について分かっていること", routes: ["PersonView"] },
  { title: "話題の人物の背景", heading: "## 話題の人物について", routes: ["Memory Graph"] },
  { title: "複数の会話にわたる経緯", heading: "## 複数の会話にわたる経緯", routes: ["Memory Timeline", "Memory Synthesis"] },
  { title: "すでに分かっている前提", heading: "## ユーザーについて、すでに分かっている前提", routes: ["Profile"] },
  { title: "明示的な検索", heading: "## ユーザーが明示的に探している過去のMemory", routes: ["Explicit Search"] },
  { title: "集計", heading: "## Memory Analytics Results", routes: ["Memory Analytics"] },
  { title: "関連する過去の記憶", heading: "## 関連する過去の記憶", routes: ["Retrieval", "Reflection"] },
];

export const CONTEXT_ROUTES: ContextRoute[] = PROMPT_SECTIONS.flatMap((s) => s.routes);

export type UnitKind =
  | "本人の発言"
  | "後からの本人の説明・訂正"
  | "AIの要約"
  | "AIの仮説"
  | "人物の関係"
  | "プロフィール"
  | "直前の会話"
  | "集計・自動の目安";

/** one piece of what the chat AI reads, in the prompt order */
export interface ContextUnit {
  /** 0 = the first piece in the prompt */
  index: number;
  /** index into PROMPT_SECTIONS */
  section: number;
  route: ContextRoute;
  /** which part of the route's item (要約 / 本人の一文 / 後からの理由 / AIの解釈 …) */
  part: string;
  memoryIds: string[];
  kind: UnitKind;
  /** whose story it is, as the source says (never merged across records) */
  persons: string[];
  /** the whole text (kept in memory only; the report keeps a short clip) */
  text: string;
  chars: number;
  /** the user's later explanation or correction, or the user's own words in the form of a reason or a correction */
  explanation: boolean;
  /** a line saying who a person is (PersonView, the Memory Graph's relation line) */
  personLine: boolean;
  /** a nameless record that may be about the person (not confirmed) */
  candidate: boolean;
  /** what the route chose the piece for (the theme of a Memory Timeline / Synthesis, the person of a Memory Graph block): read with the text for relevance */
  context: string[];
}

export type Decision = "採用" | "保留" | "除外";
export type UnitRelation = "話題" | "人物" | "なし" | "判定なし";

export type QuestionType = "理由" | "望み" | "変化" | "考え" | "人物の行動" | "質問の記録" | "アイデア" | "振り返り" | "日常";

export interface QuestionReading {
  types: QuestionType[];
  /** people named in the question (as the records call them) */
  persons: string[];
  /** people named in the earlier turns of this conversation (the question may continue about them) */
  carriedPersons: string[];
  /** topic words of the question */
  terms: string[];
  /** a topic or a person could be read, so relevance can be judged */
  judgeable: boolean;
  /** why every unit was kept as it is (the safe side), or null */
  fallback: string | null;
}

export interface UnitDecision {
  index: number;
  route: ContextRoute;
  part: string;
  kind: UnitKind;
  memoryIds: string[];
  persons: string[];
  /** a short clip of the text */
  text: string;
  chars: number;
  explanation: boolean;
  personLine: boolean;
  relation: UnitRelation;
  decision: Decision;
  why: string;
  /** the position in the virtual input (null when excluded) */
  virtualIndex: number | null;
}

export interface Tally {
  count: number;
  chars: number;
}

export interface ContextBuilderReport {
  question: QuestionReading;
  /** what 保留 means (shown with the report) */
  holdMeaning: string;
  decisions: UnitDecision[];
  /** more units than CONTEXT_BUILDER_LIMITS.maxDecisions: the rest are counted, not listed */
  truncated: boolean;
  routes: { route: ContextRoute; current: Tally; virtual: Tally; hold: number; excluded: number }[];
  totals: { current: Tally; virtual: Tally; hold: number; excluded: number };
  /** one Memory, several different pieces (kept apart: a summary and the user's words are two kinds of evidence) */
  sameMemory: { memoryId: string; pieces: { route: ContextRoute; kind: UnitKind; part: string }[] }[];
  /** exact duplicates (the same Memory ID, kind and text): the later copy is excluded */
  exactDuplicates: { memoryIds: string[]; kind: UnitKind; kept: ContextRoute; removed: ContextRoute }[];
  explanations: {
    /** 「候補にあり」 or 「候補に無し」 (never pretended) */
    status: "候補にあり" | "候補に無し";
    current: number;
    virtual: number;
    /** explanations of the current input that the virtual input does not carry (always empty unless something went wrong) */
    lost: string[];
  };
  hypotheses: {
    current: number;
    virtual: number;
    /** an AI hypothesis comes before the first of the user's reasons / corrections */
    beforeExplanationCurrent: boolean;
    beforeExplanationVirtual: boolean;
  };
  persons: { name: string; current: number; virtual: number; lineCurrent: boolean; lineVirtual: boolean }[];
  /** Memories of the current input that are absent from the virtual input */
  lostMemoryIds: string[];
  /** what the client cannot see (the server may still differ there) */
  notes: string[];
}

export const CONTEXT_BUILDER_LIMITS = { maxDecisions: 150, clipChars: 40 } as const;

export const HOLD_MEANING = "保留＝仮想の入力にも渡す（消さない）。同じ節の採用の後ろに置き、段階2で減らす候補として示すだけ。除外だけが仮想の入力から外れる。";

export interface ContextBuilderInput {
  /** the user's message of this turn */
  question: string;
  /** the user's earlier messages of this conversation (oldest first) */
  earlierUserTurns?: readonly string[];
  /** the turns sent (the route reads「前のターンがあるか」from it) */
  turnCount: number;
  retrievedMemories?: readonly RetrievedMemory[] | null;
  recentConversation?: { turns: readonly { role: string; content: string }[] } | null;
  topicContext?: readonly { topicId: string; memories: readonly TopicContinuityMemoryRef[] }[] | null;
  profile?: ProfileContext | null;
  personView?: readonly PersonView[] | null;
  topicTimeline?: unknown;
  explicitSearch?: ExplicitSearchContext | null;
  memoryAnalytics?: MemoryAnalyticsContext | null;
  memoryTimeline?: readonly SynthesisThemeContext[] | null;
  personContext?: readonly PersonContext[] | null;
}

/** the device's Memories (the same list the chat screen already read): ids for the routes without ids, people and keywords of a Memory */
export type ContextBuilderMemory = Pick<MemoryObject, "id" | "summary" | "date"> & Partial<Pick<MemoryObject, "keywords" | "personMentions" | "topicEvents" | "evidenceQuotes" | "content" | "metadata">>;

/** the relation labels the chat route writes for a PersonView (route.ts PERSON_RELATION_LABEL) */
export const PERSON_VIEW_RELATION_LABEL: Record<string, string> = {
  spouse: "配偶者・パートナー",
  child: "子",
  parent: "親",
  sibling: "兄弟姉妹",
  pet: "ペット",
  colleague: "仕事上の関係者（同僚）",
  boss: "上司",
  friend: "友人",
  acquaintance: "知人",
  other: "関係者",
};

const norm = (t: string) => (t ?? "").normalize("NFKC");
const squash = (t: string) => norm(t).replace(/\s+/g, " ").trim();
const len = (t: string) => Array.from(t ?? "").length;
const clip = (t: string) => {
  const s = squash(t);
  return len(s) > CONTEXT_BUILDER_LIMITS.clipChars ? `${Array.from(s).slice(0, CONTEXT_BUILDER_LIMITS.clipChars).join("")}…` : s;
};
const isExplanationForm = (t: string) => REASON_FORM.test(norm(t)) || CORRECTION_FORM.test(norm(t));
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const wire = <T,>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

// ---------------------------------------------------------------------------------------------------------------------------------
// 1 every route's final candidates, as the chat route writes them, in the prompt order
// ---------------------------------------------------------------------------------------------------------------------------------

export function collectContextUnits(input: ContextBuilderInput, memories: readonly ContextBuilderMemory[] = []): { units: ContextUnit[]; notes: string[] } {
  // what the server receives is the JSON of the request body: start from the same copy (and never touch the caller's values)
  const body = wire({
    retrievedMemories: input.retrievedMemories ?? [],
    recentConversation: input.recentConversation ?? null,
    topicContext: input.topicContext ?? null,
    profile: input.profile ?? null,
    personView: input.personView ?? null,
    topicTimeline: input.topicTimeline ?? null,
    explicitSearch: input.explicitSearch ?? null,
    memoryAnalytics: input.memoryAnalytics ?? null,
    memoryTimeline: input.memoryTimeline ?? null,
    personContext: input.personContext ?? null,
  });
  const byId = new Map(memories.map((m) => [m.id, m]));
  const personsOfIds = (ids: string[]) => uniq(ids.flatMap((id) => (byId.get(id)?.personMentions ?? []).map((p) => squash(p.displayName ?? "")).filter((n) => n.length > 0)));
  const notes: string[] = [];
  const units: ContextUnit[] = [];
  const add = (route: ContextRoute, u: { part: string; memoryIds: string[]; kind: UnitKind; persons?: string[]; text: string; personLine?: boolean; candidate?: boolean; context?: string[] }) => {
    const text = u.text ?? "";
    if (!squash(text)) return;
    const candidate = u.candidate === true;
    units.push({
      index: 0,
      section: PROMPT_SECTIONS.findIndex((s) => s.routes.includes(route)),
      route,
      part: u.part,
      memoryIds: uniq(u.memoryIds.filter((id) => typeof id === "string" && id.length > 0)),
      kind: u.kind,
      persons: uniq((u.persons ?? personsOfIds(u.memoryIds)).map(squash).filter((n) => n.length > 0)),
      text,
      chars: len(text),
      explanation: u.kind === "後からの本人の説明・訂正" || (u.kind === "本人の発言" && !candidate && isExplanationForm(text)),
      personLine: u.personLine === true,
      candidate,
      context: u.context ?? [],
    });
  };

  // the route's checks, in its order (route.ts POST)
  const analytics = sanitizeMemoryAnalyticsContext(body.memoryAnalytics);
  const searchNeeded = needsWebSearch(input.question ?? "", input.turnCount > 1) && analytics === null;
  const explicit = sanitizeExplicitSearchContext(body.explicitSearch);
  const explicitIds = new Set((explicit?.results ?? []).map((m) => m.id));
  const retrievedForContext = sanitizeMemoryContext(Array.isArray(body.retrievedMemories) ? (body.retrievedMemories as RetrievedMemory[]) : []).filter((m) => m.isOriginMemory === true || !explicitIds.has(m.id));
  const memoriesForContext = searchNeeded ? retrievedForContext : retrievedForContext.filter((m) => m.isOriginMemory === true || !isTimeDependentMemory(m)).map(withoutOutsideFactQuote);
  const sentRetrieved = Array.isArray(body.retrievedMemories) ? body.retrievedMemories.length : 0;
  if (memoriesForContext.length < sentRetrieved) notes.push(`Retrievalで送った${sentRetrieved}件のうち${sentRetrieved - memoriesForContext.length}件は、routeの確認（Explicit Searchとの重複・時間で変わる事実）でプロンプトに入らないため、現行の入力から外した`);

  // 直前の会話
  const recent = body.recentConversation;
  if (recent && Array.isArray(recent.turns)) {
    for (const t of recent.turns) {
      if (typeof t?.content !== "string") continue;
      const user = t.role === "user";
      add("Recent Conversation", { part: user ? "ユーザーの発言" : "Tsumugiの返答", memoryIds: [], kind: "直前の会話", persons: [], text: user ? t.content : stripLeadingTimeLabels(t.content) });
    }
  }

  // Topic Continuity（idを持たない：端末のMemoryから探す）
  for (const topic of Array.isArray(body.topicContext) ? body.topicContext : []) {
    for (const ref of Array.isArray(topic?.memories) ? topic.memories : []) {
      const id = memories.find((m) => m.summary === ref.summary && m.date === ref.date)?.id;
      add("Topic Continuity", { part: "話題の候補の要約", memoryIds: id ? [id] : [], kind: "AIの要約", text: ref.summary });
    }
  }

  // Topic Timeline（逐語。routeと同じ上限：最古1件＋直近）
  for (const timeline of sanitizeTopicTimelineContext(body.topicTimeline)) {
    for (const e of selectTimelineEventsForBudget(timeline.events, TOPIC_TIMELINE_BUDGET.maxEventsPerTopic)) {
      const id = memories.find((m) => (m.topicEvents ?? []).some((x) => x.quote === e.quote && x.statedAt === e.time && x.sourceConversationId === e.sourceConversationId))?.id;
      add("Topic Timeline", { part: "経緯の逐語", memoryIds: id ? [id] : [], kind: "本人の発言", text: e.quote });
    }
  }

  // PersonView（人物の関係の行）
  for (const v of sanitizePersonViewContext(body.personView)) {
    const label = v.relation && !v.relationContested ? PERSON_VIEW_RELATION_LABEL[v.relation] : undefined;
    add("PersonView", { part: "人物と関係", memoryIds: [], kind: "人物の関係", persons: [v.displayName], text: label ? `${v.displayName}：${label}` : v.displayName, personLine: true });
  }

  // Memory Graph（人物ごと：関係・考えと結論・後からの理由・AIの解釈・予定・出来事・候補。プロンプトと同じ順）
  for (const p of sanitizePersonContext(body.personContext)) {
    const who = p.names.length > 0 ? p.names : [p.key];
    const graph = (u: Parameters<typeof add>[1]) => add("Memory Graph", { ...u, context: uniq([...who, p.key]) });
    const ownKind = (x: PersonContextText): UnitKind => (x.kind === "summary" ? "AIの要約" : "本人の発言");
    if (p.relation) graph({ part: "人物と関係", memoryIds: p.relation.basis ? [p.relation.basis.memoryId] : [], kind: "人物の関係", persons: who, text: `${who.join("／")}：${p.relation.label}${p.relation.basis ? `　根拠 ${p.relation.basis.text}` : ""}`, personLine: true });
    for (const c of p.conclusions) {
      graph({ part: "過去の考え・結論", memoryIds: [c.statement.memoryId], kind: ownKind(c.statement), persons: who, text: c.statement.text, candidate: c.statement.kind === "candidate" });
      for (const r of c.reasons) if (r.when === "later") graph({ part: "後から本人が説明した理由", memoryIds: [r.memoryId], kind: "後からの本人の説明・訂正", persons: who, text: r.text });
      for (const a of c.aiReadings) graph({ part: "AIの要約の解釈", memoryIds: [a.memoryId], kind: "AIの仮説", persons: who, text: a.text });
    }
    for (const plan of p.plans) {
      graph({ part: "予定・希望", memoryIds: [plan.plan.memoryId], kind: ownKind(plan.plan), persons: who, text: plan.plan.text });
      if (plan.outcome) graph({ part: "予定の結果の候補", memoryIds: [plan.outcome.memoryId], kind: ownKind(plan.outcome), persons: who, text: plan.outcome.text });
    }
    for (const e of p.events) graph({ part: "最近の出来事", memoryIds: [e.memoryId], kind: ownKind(e), persons: who, text: e.text });
    for (const c of p.candidates) graph({ part: "名前の無い記録の候補", memoryIds: [c.memoryId], kind: "本人の発言", persons: who, text: c.text, candidate: true });
  }

  // Memory Timeline ＋ Synthesis（テーマごと：経緯・本人の訂正・Tsumugiの整理。プロンプトと同じ順）
  for (const t of sanitizeSynthesisContext(body.memoryTimeline)) {
    const context = [t.theme];
    for (const p of t.timeline) add("Memory Timeline", { part: `テーマ「${t.theme}」の経緯`, memoryIds: [p.memoryId], kind: "AIの要約", text: p.summary, context });
    for (const c of t.corrections ?? []) add("Memory Synthesis", { part: `テーマ「${t.theme}」への本人の${c.kind === "corrected" ? "訂正" : "否定"}`, memoryIds: [], kind: "後からの本人の説明・訂正", persons: [], text: c.userQuote, context });
    for (const i of t.items) {
      // an item over records of several people names none of them (they are not merged into one); the theme still carries the topic
      const evidencePersons = personsOfIds(i.evidenceIds);
      add("Memory Synthesis", { part: `テーマ「${t.theme}」のTsumugiの整理`, memoryIds: i.evidenceIds, kind: i.support === "stated" ? "AIの要約" : "AIの仮説", persons: evidencePersons.length === 1 ? evidencePersons : [], text: i.statement, context });
    }
  }

  // Profile（core → relevant）
  const profile = sanitizeProfileContext(body.profile);
  for (const item of [...profile.core, ...profile.relevant]) add("Profile", { part: item.kind === "planned" ? "予定" : "前提", memoryIds: [], kind: "プロフィール", persons: [], text: item.text });

  // Explicit Search（要約・詳細・逐語）
  for (const r of explicit?.results ?? []) {
    const reflection = byId.get(r.id)?.metadata?.source === "system-generated";
    add("Explicit Search", { part: reflection ? "検索結果の日記の振り返り（AIの文章）" : "検索結果の要約", memoryIds: [r.id], kind: reflection ? "AIの仮説" : "AIの要約", text: r.summary });
    if (r.detail) add("Explicit Search", { part: "記録本文の抜粋", memoryIds: [r.id], kind: "AIの要約", text: r.detail });
    for (const q of r.evidenceQuotes) add("Explicit Search", { part: "本人の発言の抜粋", memoryIds: [r.id], kind: "本人の発言", text: q });
  }

  // Memory Analytics（集計の行）
  for (const row of analytics?.results ?? []) add("Memory Analytics", { part: "集計の行", memoryIds: [], kind: "集計・自動の目安", persons: [], text: `${row.rank}. ${row.keyword}` });

  // Retrieval（記録ごと：要約・記録の性質・本人の一文。その後にConnectのつながりの理由）
  for (const m of memoriesForContext) {
    const reflection = m.source === "system-generated";
    const route: ContextRoute = reflection ? "Reflection" : "Retrieval";
    const persons = m.persons && m.persons.length > 0 ? m.persons : personsOfIds([m.id]);
    add(route, { part: reflection ? "日記の振り返り（AIの文章）" : m.isOriginMemory ? "会話のきっかけの記憶の要約" : "要約", memoryIds: [m.id], kind: reflection ? "AIの仮説" : "AIの要約", persons, text: m.summary });
    if (m.trait) add(route, { part: "記録の性質（自動の目安）", memoryIds: [m.id], kind: "集計・自動の目安", persons, text: m.trait });
    if (m.quote) add(route, { part: "本人の一文", memoryIds: [m.id], kind: "本人の発言", persons, text: m.quote });
  }
  for (const m of memoriesForContext) {
    if (!m.linkReason) continue;
    add(m.source === "system-generated" ? "Reflection" : "Retrieval", { part: "Connectのつながりの理由", memoryIds: [m.id], kind: "AIの仮説", persons: m.persons ?? personsOfIds([m.id]), text: m.linkReason });
  }

  units.sort((a, b) => a.section - b.section);
  units.forEach((u, i) => { u.index = i; });
  return { units, notes };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2 the question: its purposes (several may apply), its people and topic words; whether it can be judged at all
// ---------------------------------------------------------------------------------------------------------------------------------

const REASON_ASK = /理由|なぜ|何故|どうして|なんで/;
const PAST_ASK = /前に|以前|過去|これまで|今まで|昔|当時|っけ|(?:言っ|話し|思っ|考え|作っ|決め|し|行っ|買っ)た(?!い|く|が)|ていた|てた(?!い)|でいた/;
/** asked (not told): a statement about yesterday (「昨日カフェに行った」) is everyday talk, not a look back */
const QUESTION_FORM = /[?？]|っけ|かな|かしら|ですか|ますか|でしょうか|(?:もの|こと|の)は$|教えて|知りたい/;
const IDEA_ASK = /アイデア|企画|発想|案を/;
/** a pointer to something the question does not name (「それ」「あの件」): what it points to cannot be read from the text alone */
const DEMONSTRATIVE = /それ|あれ|その|あの|この件|さっき|例の/;
/** words that are not a topic of their own (the question's form, time words) */
const NOT_A_TOPIC = /^(?:話|理由|考え|考え方|関係|気持ち|企画|新|前|以前|過去|最近|今|昔|当時|何|こと|もの|自分|私|僕|俺|どう|なぜ|件|例|先日|先週|今週|来週|先月|今月|来月|去年|昨年|今年|来年|昨日|一昨日|今日|明日|週末|前回|毎日|毎週|朝|昼|夜|午前|午後)$/;
const PURPOSE_TYPE: Record<QuestionPurpose, QuestionType> = { questions: "質問の記録", wish: "望み", change: "変化", view: "考え", personAction: "人物の行動" };
const HONORIFIC = /(?:さん|くん|君|ちゃん|様|氏)$/;
const bare = (name: string) => (HONORIFIC.test(name) && len(name.replace(HONORIFIC, "")) >= 2 ? name.replace(HONORIFIC, "") : name);

export function readQuestion(question: string, earlierUserTurns: readonly string[], memories: readonly ContextBuilderMemory[], graphNames: readonly string[] = []): QuestionReading {
  const t = squash(question);
  const pool = memories.map((m) => ({ summary: m.summary, keywords: m.keywords, evidenceQuotes: m.evidenceQuotes, personMentions: m.personMentions, metadata: m.metadata }));
  const ctx = purposeContextOf(t, pool);
  const carriedPersons = uniq(earlierUserTurns.slice(-2).flatMap((x) => purposeContextOf(squash(x), pool).namedPersons)).filter((n) => !ctx.namedPersons.includes(n));
  // the names the Memory Graph matched (confirmed aliases included) count as named too
  const persons = uniq([...ctx.namedPersons, ...graphNames.filter((n) => len(n) >= 2 && (t.includes(n) || t.includes(bare(n))))]);
  const terms = questionTopicRuns(t).filter((run) => !NOT_A_TOPIC.test(run) && !persons.some((p) => run.includes(bare(p)) || bare(p).includes(run)));
  const types: QuestionType[] = [];
  if (REASON_ASK.test(t) && (PAST_ASK.test(t) || ctx.purpose !== null)) types.push("理由");
  if (ctx.purpose) types.push(PURPOSE_TYPE[ctx.purpose]);
  if (IDEA_ASK.test(t)) types.push("アイデア");
  if (types.length === 0) types.push(PAST_ASK.test(t) && QUESTION_FORM.test(t) ? "振り返り" : "日常");
  const judgeable = persons.length > 0 || carriedPersons.length > 0 || terms.length > 0;
  let fallback: string | null = null;
  if (!t) fallback = "発言が空なので、現行の入力のまま";
  else if (DEMONSTRATIVE.test(t) && persons.length === 0 && terms.length === 0) fallback = "指示語だけで話題を指していて、何の話か本文から読めないので、現行の入力のまま";
  return { types: uniq(types), persons, carriedPersons, terms, judgeable, fallback };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3 the decision per unit, the virtual input, and the comparison
// ---------------------------------------------------------------------------------------------------------------------------------

/** purposes for which a record about the same person belongs to the answer (the time series of a relationship, a view, a reason) */
const PERSON_WIDE: QuestionType[] = ["理由", "望み", "変化", "考え"];

export function buildContextBuilderReport(input: ContextBuilderInput, memories: readonly ContextBuilderMemory[] = []): ContextBuilderReport {
  const { units, notes } = collectContextUnits(input, memories);
  const graphNames = uniq((input.personContext ?? []).flatMap((p) => [...(p.names ?? []), p.key]).filter((n): n is string => typeof n === "string"));
  const q = readQuestion(input.question ?? "", input.earlierUserTurns ?? [], memories, graphNames);
  const byId = new Map(memories.map((m) => [m.id, m]));
  const everyday = q.types.length === 1 && q.types[0] === "日常";
  const personWide = q.types.some((x) => PERSON_WIDE.includes(x));
  const askedPersons = [...q.persons, ...q.carriedPersons];

  const hay = (u: ContextUnit) => norm([u.text, ...u.persons, ...u.context, ...u.memoryIds.flatMap((id) => byId.get(id)?.keywords ?? [])].join(" "));
  const relationOf = (u: ContextUnit): UnitRelation => {
    if (!q.judgeable) return "判定なし";
    const h = hay(u);
    if (q.terms.some((term) => h.includes(term))) return "話題";
    if (askedPersons.some((p) => u.persons.some((x) => x === p || bare(x) === bare(p)) || h.includes(bare(p)))) return "人物";
    return "なし";
  };

  // the people the turn is about: named now or just before, or the people of what the question matched by topic
  const relations = units.map(relationOf);
  const topRetrievalId = units.find((u) => u.route === "Retrieval" || u.route === "Reflection")?.memoryIds[0];
  const peopleInPlay = new Set<string>([...askedPersons, ...units.filter((u, i) => relations[i] === "話題" || (everyday && u.memoryIds.includes(topRetrievalId ?? "\u0000"))).flatMap((u) => u.persons)].map(bare));

  const seen = new Map<string, ContextRoute>();
  const exactDuplicates: ContextBuilderReport["exactDuplicates"] = [];
  const decided = units.map((u, i): { decision: Decision; why: string } => {
    const relation = relations[i];
    // 完全な重複だけを除外する（同じMemory ID・同じ種類・同じ本文）。IDが無いもの、種類や本文が違うものは別の情報として残す
    if (u.memoryIds.length > 0) {
      const key = `${[...u.memoryIds].sort().join(",")}\n${u.kind}\n${squash(u.text)}`;
      const kept = seen.get(key);
      if (kept) {
        exactDuplicates.push({ memoryIds: u.memoryIds, kind: u.kind, kept, removed: u.route });
        return { decision: "除外", why: `完全な重複（同じMemory・同じ種類・同じ本文が${kept}に既にある）` };
      }
      seen.set(key, u.route);
    }
    if (q.fallback) return { decision: "採用", why: q.fallback };
    if (u.explanation) {
      return relation === "なし"
        ? { decision: "保留", why: "本人の理由・訂正だが、今回の話題・人物に一致しない（消さずに残す）" }
        : { decision: "採用", why: "本人の理由・訂正（必ず残す。AIの仮説より前に置く）" };
    }
    if (u.personLine) {
      const named = u.persons.some((p) => peopleInPlay.has(bare(p)));
      return named || !q.judgeable ? { decision: "採用", why: "誰の話かを示す人物の行（消さない）" } : { decision: "保留", why: "今回の質問の人物ではない人物の行（消さない）" };
    }
    if (u.route === "Recent Conversation") return { decision: "採用", why: "直前の会話の逐語（会話の流れ）" };
    if (u.route === "Profile") return { decision: "採用", why: "本人が述べた前提（すでに話題で選ばれている）" };
    if (u.route === "Explicit Search") return { decision: "採用", why: "本人が明示的に探した結果（扱いは変えない）" };
    if (u.route === "Memory Analytics") return { decision: "採用", why: "本人が求めた集計（扱いは変えない）" };
    if (everyday) {
      if ((u.route === "Retrieval" || u.route === "Reflection") && topRetrievalId && u.memoryIds.includes(topRetrievalId) && u.kind !== "AIの仮説") return { decision: "採用", why: "日常会話：過去との自然なつながり（検索の最上位の記録）" };
      if (relation === "話題" || relation === "人物") return { decision: u.kind === "AIの仮説" ? "保留" : "採用", why: u.kind === "AIの仮説" ? "日常会話：AIの仮説は押し込まない（消さずに後ろへ）" : "日常会話：今の話題・人物につながる過去" };
      return { decision: "保留", why: "日常会話：必要以上に過去を押し込まない（消さずに後ろへ）" };
    }
    if (u.kind === "AIの仮説") {
      if (relation === "なし") return { decision: "保留", why: "今回の話題・人物に一致しないAIの仮説" };
      return { decision: "採用", why: `AIの仮説として（本人の言葉ではない）。本人の発言・理由の後に置く${relation === "判定なし" ? "（話題を読み取れないため現行どおり）" : ""}` };
    }
    if (relation === "話題") return { decision: "採用", why: "質問の話題に一致" };
    if (relation === "判定なし") return { decision: "採用", why: "質問の話題・人物を読み取れないため、現行どおり" };
    if (relation === "人物") {
      if (personWide || u.route === "Retrieval" || u.route === "Topic Timeline") return { decision: "採用", why: personWide ? "質問の人物について、目的（理由・望み・変化・考え）に関わる記録" : "質問の人物の記録（検索・経緯で選ばれた）" };
      return { decision: "保留", why: "人物が同じだけで、質問の話題ではない" };
    }
    // relation === "なし"
    if (u.route === "Memory Graph" || u.route === "Memory Timeline" || u.route === "Topic Continuity") return { decision: "除外", why: "補助の経路の項目で、質問の話題にも人物にも一致しない" };
    return { decision: "保留", why: "検索で選ばれたが、質問の話題にも人物にも一致しない（会話の広がりとして残す）" };
  });

  // the safe side: the virtual input must keep every reason / correction and the line of every person who is still in it
  const keptIds = new Set(units.filter((_, i) => decided[i].decision !== "除外").flatMap((u) => u.memoryIds));
  const lostExplanation = units.some((u, i) => u.explanation && decided[i].decision === "除外" && !u.memoryIds.every((id) => keptIds.has(id)));
  const lostPersonLine = units.some((u, i) => u.personLine && decided[i].decision === "除外" && !units.some((v, j) => j !== i && v.personLine && decided[j].decision !== "除外" && v.persons.some((p) => u.persons.includes(p))));
  let fallback = q.fallback;
  if (!fallback && (lostExplanation || lostPersonLine)) {
    fallback = lostExplanation ? "仮想の入力が本人の理由・訂正を落とすため、現行の入力のまま" : "仮想の入力が人物の行を落とすため、現行の入力のまま";
    units.forEach((_, i) => {
      if (decided[i].decision !== "除外" || decided[i].why.startsWith("完全な重複")) return;
      decided[i] = { decision: "採用", why: fallback as string };
    });
  }
  const question: QuestionReading = { ...q, fallback };

  // the virtual input: the sections in the prompt order; in each, 採用 then 保留; the AI's hypotheses after every user's word and reason (at the end)
  const order = (decision: Decision, u: ContextUnit) => (u.kind === "AIの仮説" ? 1000 + (decision === "採用" ? 0 : 1) : u.section * 2 + (decision === "採用" ? 0 : 1));
  const virtual = units.map((u, i) => ({ u, i, d: decided[i].decision })).filter((x) => x.d !== "除外").sort((a, b) => order(a.d, a.u) - order(b.d, b.u) || a.i - b.i);
  const virtualIndex = new Map(virtual.map((x, k) => [x.i, k]));

  const tally = (xs: ContextUnit[]): Tally => ({ count: xs.length, chars: xs.reduce((n, u) => n + u.chars, 0) });
  const virtualUnits = virtual.map((x) => x.u);
  const routes = CONTEXT_ROUTES.map((route) => ({
    route,
    current: tally(units.filter((u) => u.route === route)),
    virtual: tally(virtualUnits.filter((u) => u.route === route)),
    hold: units.filter((u, i) => u.route === route && decided[i].decision === "保留").length,
    excluded: units.filter((u, i) => u.route === route && decided[i].decision === "除外").length,
  })).filter((r) => r.current.count > 0);

  const pieces = new Map<string, ContextUnit[]>();
  for (const u of units) for (const id of u.memoryIds) pieces.set(id, [...(pieces.get(id) ?? []), u]);
  const sameMemory = [...pieces].filter(([, us]) => new Set(us.map((u) => `${u.kind}\n${squash(u.text)}`)).size >= 2).map(([memoryId, us]) => ({ memoryId, pieces: us.map((u) => ({ route: u.route, kind: u.kind, part: u.part })) }));

  const explanationKey = (u: ContextUnit) => `${u.memoryIds.join(",")}\n${squash(u.text)}`;
  const currentExplanations = units.filter((u) => u.explanation);
  const virtualExplanationKeys = new Set(virtualUnits.filter((u) => u.explanation).map(explanationKey));
  const firstIndex = (xs: ContextUnit[], f: (u: ContextUnit) => boolean) => xs.findIndex(f);
  const hypBefore = (xs: ContextUnit[]) => {
    const e = firstIndex(xs, (u) => u.explanation);
    const h = firstIndex(xs, (u) => u.kind === "AIの仮説");
    return e >= 0 && h >= 0 && h < e;
  };

  const names = uniq(units.flatMap((u) => u.persons));
  const persons = names.map((name) => ({
    name,
    current: units.filter((u) => u.persons.includes(name)).length,
    virtual: virtualUnits.filter((u) => u.persons.includes(name)).length,
    lineCurrent: units.some((u) => u.personLine && u.persons.includes(name)),
    lineVirtual: virtualUnits.some((u) => u.personLine && u.persons.includes(name)),
  }));

  const currentIds = uniq(units.flatMap((u) => u.memoryIds));
  const virtualIds = new Set(virtualUnits.flatMap((u) => u.memoryIds));
  notes.push("この比較は端末で送る値から作ったもの。サーバー側の値（P1-Fの「サーバーが受け取った値」）とは、時刻で変わる判定などで食い違うことがある");

  const decisions: UnitDecision[] = units.slice(0, CONTEXT_BUILDER_LIMITS.maxDecisions).map((u, i) => ({
    index: u.index,
    route: u.route,
    part: u.part,
    kind: u.kind,
    memoryIds: u.memoryIds,
    persons: u.persons,
    text: clip(u.text),
    chars: u.chars,
    explanation: u.explanation,
    personLine: u.personLine,
    relation: relations[i],
    decision: decided[i].decision,
    why: decided[i].why,
    virtualIndex: virtualIndex.get(i) ?? null,
  }));

  return {
    question,
    holdMeaning: HOLD_MEANING,
    decisions,
    truncated: units.length > CONTEXT_BUILDER_LIMITS.maxDecisions,
    routes,
    totals: {
      current: tally(units),
      virtual: tally(virtualUnits),
      hold: decided.filter((d) => d.decision === "保留").length,
      excluded: decided.filter((d) => d.decision === "除外").length,
    },
    sameMemory,
    exactDuplicates,
    explanations: {
      status: currentExplanations.length > 0 ? "候補にあり" : "候補に無し",
      // distinct reasons / corrections (an exact duplicate is one reason, not a lost one)
      current: new Set(currentExplanations.map(explanationKey)).size,
      virtual: virtualExplanationKeys.size,
      lost: currentExplanations.filter((u) => !virtualExplanationKeys.has(explanationKey(u))).map((u) => clip(u.text)),
    },
    hypotheses: {
      current: units.filter((u) => u.kind === "AIの仮説").length,
      virtual: virtualUnits.filter((u) => u.kind === "AIの仮説").length,
      beforeExplanationCurrent: hypBefore(units),
      beforeExplanationVirtual: hypBefore(virtualUnits),
    },
    persons,
    lostMemoryIds: currentIds.filter((id) => !virtualIds.has(id)),
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4 the debug badge's text
// ---------------------------------------------------------------------------------------------------------------------------------

export function formatContextBuilderReport(r: ContextBuilderReport): string {
  const q = r.question;
  const lines: string[] = [
    "Context Builder（段階1・診断専用。実際に送る内容・順序・件数は変えていない）",
    `質問の種類：${q.types.join("・")}　人物：${q.persons.join("・") || "なし"}${q.carriedPersons.length > 0 ? `（直前の発言から：${q.carriedPersons.join("・")}）` : ""}　話題の語：${q.terms.join("・") || "なし"}`,
    q.fallback ? `安全側：${q.fallback}` : q.judgeable ? "話題・人物を読み取れたので、関連性を判定した" : "話題・人物を読み取れないので、関連性では外していない",
    `判定の意味：採用＝仮想の入力に入れる／${r.holdMeaning}`,
    "",
    "■ 経路ごとの件数・文字数（現行 → 仮想）",
  ];
  for (const x of r.routes) lines.push(`- ${x.route}：${x.current.count}件・${x.current.chars}字 → ${x.virtual.count}件・${x.virtual.chars}字（保留${x.hold}・除外${x.excluded}）`);
  lines.push(`- 合計：${r.totals.current.count}件・${r.totals.current.chars}字 → ${r.totals.virtual.count}件・${r.totals.virtual.chars}字（保留${r.totals.hold}・除外${r.totals.excluded}）`);
  lines.push("", "■ 本人の理由・訂正");
  if (r.explanations.status === "候補に無し") lines.push("- 候補に無し（AIの仮説を本人の理由として扱わない）");
  else lines.push(`- 現行${r.explanations.current}件 → 仮想${r.explanations.virtual}件${r.explanations.lost.length > 0 ? `（失ったもの：${r.explanations.lost.join("／")}）` : "（すべて残る）"}`);
  lines.push("", "■ AIの仮説");
  lines.push(`- 現行${r.hypotheses.current}件 → 仮想${r.hypotheses.virtual}件。本人の理由・訂正より前にあるか：現行 ${r.hypotheses.beforeExplanationCurrent ? "はい" : "いいえ"} → 仮想 ${r.hypotheses.beforeExplanationVirtual ? "はい" : "いいえ"}`);
  lines.push("", "■ 人物（現行 → 仮想の項目数・人物の行）");
  if (r.persons.length === 0) lines.push("- なし");
  for (const p of r.persons) lines.push(`- ${p.name}：${p.current} → ${p.virtual}・人物の行 ${p.lineCurrent ? "あり" : "なし"} → ${p.lineVirtual ? "あり" : "なし"}`);
  lines.push("", "■ 同じMemoryの別の情報（区別して残す）");
  if (r.sameMemory.length === 0) lines.push("- なし");
  for (const s of r.sameMemory) lines.push(`- ${s.memoryId}：${s.pieces.map((p) => `${p.route}/${p.kind}`).join("・")}`);
  lines.push("", "■ 完全な重複（後ろの方を除外）");
  if (r.exactDuplicates.length === 0) lines.push("- なし");
  for (const d of r.exactDuplicates) lines.push(`- ${d.memoryIds.join(",")} [${d.kind}]：${d.kept}に残し、${d.removed}から除外`);
  lines.push("", `■ 仮想の入力から消えるMemory：${r.lostMemoryIds.length === 0 ? "なし" : r.lostMemoryIds.join(", ")}`);
  lines.push("", "■ 判定（プロンプトの順）");
  for (const d of r.decisions) lines.push(`- ${d.index + 1}. [${d.decision}] ${d.route}・${d.part} [${d.kind}] ${d.memoryIds.join(",") || "ID無し"}${d.persons.length > 0 ? `（${d.persons.join("・")}）` : ""} 関連:${d.relation}：${d.why}\n    「${d.text}」`);
  if (r.truncated) lines.push(`（${CONTEXT_BUILDER_LIMITS.maxDecisions}件を超えた分は省略）`);
  if (r.notes.length > 0) lines.push("", "■ 注記", ...r.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}
