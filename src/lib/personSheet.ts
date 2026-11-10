/**
 * Memory Graph P0: the person sheet (a debug view, owner request 2026-11-10). It is DERIVED from the saved Memories every time it is opened.
 * Nothing is stored, no Memory is changed and no AI is called. The sheet is never sent to the chat; normal Retrieval does not read it.
 *
 * What the sheet gathers for one person, each line carrying its kind and the Memories it rests on:
 *   本人の発言  (user)    the user's own words, verbatim: personMentions.quote, evidenceQuotes, topicEvents.quote
 *   AIの要約    (summary) what Capture wrote: summary, keywords, the relation category of a mention
 *   Connectの推測 (connect) a Link that Connect's AI judged; a reading, never a fact
 * Reuses PersonView (relation, contested), the Topic Timeline axis (topicId + topicEvents), the Memory Timeline status words and themes, and Connect links.
 *
 * Who a record is about:
 *   - "mention": a personMention of the record has the person's name (the user named the person in that conversation).
 *   - "keyword": only a keyword of the record is the name. Shown apart; Capture did not record a person for it.
 *   - "text": the name (2+ characters) only appears in the record's words (summary, body, the user's quotes). Shown apart, weakest.
 *   Names that differ only by an honorific (さきさん / さき) are one person. Different names (さきさん / 咲さん / 妻) are never joined by the sheet:
 *   other names that MAY be the same person are listed with what points to it (shared topics, Connect links), and the page can show them together
 *   for the moment (nothing is stored). A name that contains another (さき / まさき) is listed under 「似た名前」 so that a mix-up can be seen.
 *
 * Views: every sentence of the user's words is classified by its FORM (personStatement.ts): a judgment or a thought is a view; a question or a request
 * to the listener is kept apart; a report of what happened or a description of a state is not a view. Each sentence is shown once. The AI summary
 * gives a view only for a record that has no view in the user's words. Every sentence the sheet looked at keeps what became of it, so that the
 * page can tell why a statement is or is not among the views (findInPersonSheet).
 *
 * The sheet does not say what the present state is, and it draws no causal lines. It shows the last record that can be confirmed and its date.
 * A plan's outcome is only a CANDIDATE: a later record with an outcome word that shares a word of the plan; a record of the same topic alone is not one.
 * There is no length limit: every record about the person is shown (the debug page folds the long parts).
 */
import { computePersonViews } from "./person";
import { OWN_VIEW } from "./memoryContext";
import { buildThemeTimeline, isSynthesisSource, statusOf, timelineThemes, type TimelineStatus } from "./memorySynthesis";
import { classifyStatement, statementKey, statementSentences, STATEMENT_ROLE_LABEL, type StatementRole } from "./personStatement";
import type { LinkAxis, MemoryObject, PersonRelation } from "./types";

export type SheetSourceKind = "user" | "summary" | "connect";
export const SHEET_SOURCE_LABEL: Record<SheetSourceKind, string> = { user: "本人の発言", summary: "AIの要約", connect: "Connectの推測" };

export const PERSON_RELATION_LABEL_JA: Record<PersonRelation, string> = {
  spouse: "配偶者", child: "子ども", parent: "親", sibling: "きょうだい", pet: "ペット",
  colleague: "同僚", boss: "上司", friend: "友人", acquaintance: "知人", other: "その他",
};

const HONORIFIC = /(さん|ちゃん|くん|君|様|氏)$/;
/** the same name key as Retrieval uses: NFKC, no spaces, honorific removed when 2+ characters remain */
export function personSheetKey(name: string): string {
  const base = name.normalize("NFKC").replace(/\s+/g, "").trim();
  const stripped = base.replace(HONORIFIC, "");
  return Array.from(stripped).length >= 2 ? stripped : base;
}

const dayOf = (iso: string | undefined) => (iso ? iso.slice(0, 10) : "");
const timeOf = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};
/** when the user SAID the record: statedAt, otherwise the record date */
function saidAtOf(m: MemoryObject): { at: string; isRecordDate: boolean } {
  return m.statedAt && Number.isFinite(Date.parse(m.statedAt)) ? { at: m.statedAt, isRecordDate: false } : { at: m.date, isRecordDate: true };
}

export interface PersonListEntry {
  key: string;
  /** every way the user wrote the name (personMentions) or Capture keyed it (keywords) */
  names: string[];
  mentionRecords: number;
  keywordOnlyRecords: number;
}

/** every person a record names: personMentions, plus keywords that are a name with an honorific (as Retrieval counts them) */
function namesOf(m: MemoryObject): { mention: string[]; keyword: string[] } {
  const mention = (m.personMentions ?? []).map((p) => (p.displayName || p.groupingKey || "").trim()).filter(Boolean);
  const keyword = (m.keywords ?? []).filter((k) => HONORIFIC.test(k.normalize("NFKC").replace(/\s+/g, "")));
  return { mention, keyword };
}

/** the people the debug page offers: one entry per name key, most records first */
export function listSheetPersons(memories: MemoryObject[]): PersonListEntry[] {
  const byKey = new Map<string, { names: Set<string>; mention: Set<string>; keyword: Set<string> }>();
  const entry = (key: string) => {
    let e = byKey.get(key);
    if (!e) { e = { names: new Set(), mention: new Set(), keyword: new Set() }; byKey.set(key, e); }
    return e;
  };
  for (const m of memories) {
    const { mention, keyword } = namesOf(m);
    for (const n of mention) { const e = entry(personSheetKey(n)); e.names.add(n); e.mention.add(m.id); }
    for (const n of keyword) { const e = entry(personSheetKey(n)); e.names.add(n); e.keyword.add(m.id); }
  }
  return [...byKey.entries()]
    .map(([key, e]) => ({ key, names: [...e.names], mentionRecords: e.mention.size, keywordOnlyRecords: [...e.keyword].filter((id) => !e.mention.has(id)).length }))
    .sort((a, b) => b.mentionRecords + b.keywordOnlyRecords - (a.mentionRecords + a.keywordOnlyRecords) || a.key.localeCompare(b.key));
}


/** a piece of text with its kind and the Memory it comes from */
export interface SheetText {
  kind: SheetSourceKind;
  text: string;
  memoryId: string;
  /** when the user said it (or the record date) */
  saidAt: string;
}

/** how a record was found for the person */
export type SheetMatch = "mention" | "keyword" | "text";
export const SHEET_MATCH_LABEL: Record<SheetMatch, string> = {
  mention: "人物として記録",
  keyword: "名前がキーワードにあるだけ",
  text: "本文での言及だけ（人物としてもキーワードとしても記録されていない）",
};

export interface SheetRecord {
  memoryId: string;
  conversationId?: string;
  saidAt: string;
  saidAtIsRecordDate: boolean;
  eventTime?: string;
  /** "mention": Capture recorded the person; "keyword": only a keyword is the name; "text": the name only appears in the record's text */
  match: SheetMatch;
  summary: SheetText;
  /** the user's own words about this person in this record (personMentions of the person) */
  mentionQuotes: SheetText[];
  /** the user's words the record rests on (evidenceQuotes). `aboutOther`: names someone else and not this person */
  evidence: (SheetText & { aboutOther: boolean })[];
  /** the relation category Capture recorded with the mention (AI's classification of the user's words) */
  relations: { relation: PersonRelation; assertion: "mention" | "correction"; quote: string; /** when the user stated it (a mention added later by a Capture UPDATE keeps its own date) */ statedAt: string }[];
  /** other people named in the same record */
  otherPersons: string[];
  topicId?: string;
  /** a status word that appears in the summary (Memory Timeline rule); about the record, not necessarily about the person */
  status?: TimelineStatus;
  /** the record tells, later, about something that happened more than 30 days before */
  retrospective: boolean;
  keywords: string[];
  linkCount: number;
}

/** what became of one sentence of a record on this sheet (shown to explain why a statement is or is not among the views) */
export type StatementFate = "view" | "asked" | "duplicate" | "not-a-view" | "summary-not-used";

export interface SheetStatement {
  text: SheetText;
  /** where the sentence is stored: a person mention's quote, an evidence quote, a topic quote, or the AI summary */
  source: "mention" | "evidence" | "topic" | "summary";
  role: StatementRole;
  reason: string;
  fate: StatementFate;
  /** the fate in words */
  fateNote: string;
  aboutOther: boolean;
  /** for a duplicate: the Memory where the same words were shown first */
  duplicateOf?: string;
}

export interface SheetView {
  /** the user's view in the user's words, or in the AI summary */
  text: SheetText;
  /** the sentence names another person and not this one (possible mix-up) */
  aboutOther: boolean;
  /** judgment: stated outright or a decision; thought: hedged, felt or wished (from the form of the sentence) */
  role: "judgment" | "thought";
  reason: string;
  /** other Memories where the same words are stored too (shown once) */
  alsoIn: string[];
}

/** a question or a request the user addressed to the listener (kept apart from the views) */
export interface SheetAsked {
  text: SheetText;
  role: "question" | "request";
  reason: string;
  alsoIn: string[];
}

export interface SheetLater { memoryId: string; saidAt: string; summary: string; status?: TimelineStatus; /** words of the plan that the later record shares */ sharedTerms: string[] }

export interface SheetPlan {
  record: SheetRecord;
  why: "status" | "event-later-than-said";
  /**
   * a later record that may tell how the plan ended: it carries an outcome word (中止 / 保留 / 実施済み) AND shares a word of the plan (not a name).
   * A candidate only; the sheet never says the plan ended so.
   */
  outcome?: SheetLater & { status: TimelineStatus; sameTopic: boolean };
  /** later records of the same topic that are NOT taken as the outcome (no outcome word, or nothing of the plan in common) */
  laterSameTopic: SheetLater[];
}

export interface SheetTopic {
  topicId: string;
  /** the user's words on this topic (topicEvents), oldest first, from every Memory of the topic */
  events: { quote: string; saidAt: string; memoryId: string; namesThisPerson: boolean; otherPersons: string[] }[];
  /** Memories of the topic that are NOT about this person */
  otherRecords: { memoryId: string; saidAt: string; persons: string[] }[];
}

export interface SheetLink {
  fromId: string;
  toId: string;
  axis: LinkAxis;
  reason: string;
  strength: number;
  contrast: boolean;
  /** the other end is about this person too */
  otherEndAboutPerson: boolean;
  otherEndSummary?: string;
  otherEndSaidAt?: string;
}

export interface SheetTheme {
  theme: string;
  state: string;
  stateBasisId?: string;
  stateBasisSaidAt?: string;
  /** timeline points of the theme; aboutPerson marks the ones of this person's records */
  points: { memoryId: string; saidAt: string; summary: string; status?: TimelineStatus; aboutPerson: boolean }[];
}

/**
 * another name that MAY be the same person, with what points to it. Never joined by the sheet: the page can show both together for a moment,
 * and only the user can say they are one person.
 */
export interface SheetAliasCandidate {
  key: string;
  names: string[];
  records: number;
  /** topics (topicId) that hold records of both names */
  sharedTopics: number;
  /** Connect links between a record of this person and a record of the other name */
  links: number;
  /** other people who appear with both names */
  sharedCoPersons: string[];
  /** records that name both (they may be two different people talked about together) */
  bothInOneRecord: number;
  /** one name contains the other */
  similarName: boolean;
}

export interface PersonSheet {
  key: string;
  /** every name key on this sheet: the selected one, and the ones joined for the moment on the page */
  keys: string[];
  names: string[];
  /** other name keys that contain this one or are contained in it (never joined) */
  similarNames: string[];
  aliasCandidates: SheetAliasCandidate[];
  overview: {
    records: number;
    mentionRecords: number;
    keywordOnlyRecords: number;
    textOnlyRecords: number;
    firstSaidAt?: string;
    lastSaidAt?: string;
    /** PersonView of the mentions (relation as Capture classified it, or contested) */
    relation?: { label: string; contested: boolean; basis: (SheetText & { relation: PersonRelation; correction: boolean })[] };
    /** people who appear in the same records, with how many records */
    coPersons: { name: string; records: number }[];
  };
  /** every record about the person, oldest first */
  records: SheetRecord[];
  /** judgments and thoughts, oldest first, each sentence once */
  views: SheetView[];
  /** questions and requests to the listener, oldest first, each sentence once */
  asked: SheetAsked[];
  /** every sentence the sheet looked at, with what became of it */
  statements: SheetStatement[];
  last: {
    /** the record said last (it may not describe the present) */
    said?: SheetRecord;
    /** the last record with a status word in its summary */
    status?: SheetRecord;
    /** later records of the same topic as `status` that carry a status word and share a word of it (they may be about the same plan; not merged) */
    statusLater?: (SheetLater & { status: TimelineStatus })[];
    /** the last relation the user stated */
    relation?: SheetText & { relation: PersonRelation };
    /** the last view in the user's own words */
    ownView?: SheetView;
    /** the last judgment (stated outright or a decision) in the user's own words */
    judgment?: SheetView;
  };
  plans: SheetPlan[];
  topics: SheetTopic[];
  links: SheetLink[];
  themes: SheetTheme[];
}

const norm = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");

/** the text names this person: the name occurs outside any longer known name that holds it (さき inside さきこ is not さき) */
function namesThis(text: string, key: string, otherKeys: string[] = []): boolean {
  let t = norm(text);
  for (const k of otherKeys.filter((x) => x !== key && x.includes(key)).sort((a, b) => b.length - a.length)) t = t.split(k).join("■");
  return t.includes(key);
}
const namesAny = (text: string, keys: string[], otherKeys: string[]) => keys.some((k) => namesThis(text, k, otherKeys));

/** the other people a text names (by the names known from the records), never counting this person or a name inside this person's name */
function othersNamedIn(text: string, keys: string[], otherKeys: string[]): string[] {
  const t = norm(text);
  let masked = t;
  for (const k of [...keys].sort((a, b) => b.length - a.length)) masked = masked.split(k).join("■");
  // a longer name that holds this one (さきこ for さき) is looked for in the text as it is; any other name, including a shorter one inside this
  // person's name (さき for さきこ), with this person's name masked out, and outside any longer known name that holds it (Codex on PR #32)
  return otherKeys.filter((k) => !keys.includes(k) && (keys.some((kk) => k.includes(kk)) ? t.includes(k) : namesThis(masked, k, otherKeys)));
}

/** the user's words and the AI's words a record holds (for a name found only in the text) */
function textsOf(m: MemoryObject): string[] {
  return [m.summary ?? "", m.content ?? "", ...(m.evidenceQuotes ?? []), ...(m.personMentions ?? []).map((p) => p.quote ?? ""), ...(m.topicEvents ?? []).map((e) => e.quote ?? "")];
}

function isAbout(m: MemoryObject, keys: string[], otherKeys: string[]): SheetMatch | null {
  const { mention, keyword } = namesOf(m);
  if (mention.some((n) => keys.includes(personSheetKey(n)))) return "mention";
  if (keyword.some((n) => keys.includes(personSheetKey(n))) || (m.keywords ?? []).some((k) => keys.includes(personSheetKey(k)))) return "keyword";
  // a name of 2+ characters found in the record's text (a one-character name such as 母 is too likely to be part of another word)
  const textKeys = keys.filter((k) => Array.from(k).length >= 2);
  if (textKeys.length > 0 && textsOf(m).some((t) => t && namesAny(t, textKeys, otherKeys))) return "text";
  return null;
}

const OUTCOME_STATUSES = new Set<TimelineStatus>(["中止", "保留", "実施済み"]);

export interface PersonSheetOptions {
  /** other name keys to show together with `key` on this page only (nothing is stored; the user decides whether they are one person) */
  withKeys?: string[];
}

export function buildPersonSheet(memories: MemoryObject[], key: string, options: PersonSheetOptions = {}): PersonSheet {
  const all = memories.filter((m) => m && typeof m.id === "string");
  const persons = listSheetPersons(all);
  const keys = [...new Set([key, ...(options.withKeys ?? [])].filter((k) => k.length > 0))];
  // every other known person, one-character names (妻, 母) included: a statement about them must not be attributed to this person (Codex on PR #32)
  const otherKeys = persons.map((p) => p.key).filter((k) => !keys.includes(k) && k.length > 0);
  const names = [...new Set(persons.filter((p) => keys.includes(p.key)).flatMap((p) => p.names))];
  const similarNames = otherKeys.filter((k) => Array.from(k).length >= 2 && keys.some((kk) => k.includes(kk) || kk.includes(k)));
  const byId = new Map(all.map((m) => [m.id, m] as const));
  const aboutOther = (text: string) => !namesAny(text, keys, otherKeys) && othersNamedIn(text, keys, otherKeys).length > 0;
  const isName = (k: string) => HONORIFIC.test(norm(k)) || keys.includes(personSheetKey(k)) || otherKeys.includes(personSheetKey(k));
  const termsOf = (m: MemoryObject | undefined) => [...new Set((m?.keywords ?? []).map((k) => k.trim()).filter((k) => k && !isName(k)))];
  const sharedTerms = (terms: string[], m: MemoryObject) => terms.filter((t) => (m.keywords ?? []).includes(t) || (m.summary ?? "").includes(t));

  const about = all
    .map((m) => ({ m, match: isAbout(m, keys, otherKeys) }))
    .filter((x): x is { m: MemoryObject; match: SheetMatch } => x.match !== null)
    .sort((a, b) => timeOf(saidAtOf(a.m).at) - timeOf(saidAtOf(b.m).at));
  const aboutIds = new Set(about.map((x) => x.m.id));

  const records: SheetRecord[] = about.map(({ m, match }) => {
    const said = saidAtOf(m);
    const mine = (m.personMentions ?? []).filter((p) => keys.includes(personSheetKey(p.displayName || p.groupingKey || "")));
    const { mention, keyword } = namesOf(m);
    const others = [...new Set([...mention, ...keyword].filter((n) => !keys.includes(personSheetKey(n))))];
    return {
      memoryId: m.id,
      ...(m.conversationId ? { conversationId: m.conversationId } : {}),
      saidAt: said.at,
      saidAtIsRecordDate: said.isRecordDate,
      ...(m.eventTime ? { eventTime: m.eventTime } : {}),
      match,
      summary: { kind: "summary", text: m.summary ?? "", memoryId: m.id, saidAt: said.at },
      mentionQuotes: mine.filter((p) => p.quote).map((p) => ({ kind: "user" as const, text: p.quote, memoryId: m.id, saidAt: p.statedAt || said.at })),
      // the same words already shown as a mention quote are not repeated
      evidence: (m.evidenceQuotes ?? []).filter((q) => typeof q === "string" && q.trim() && !mine.some((p) => (p.quote ?? "").trim() === q.trim())).map((q) => ({
        kind: "user" as const, text: q.trim(), memoryId: m.id, saidAt: said.at, aboutOther: aboutOther(q),
      })),
      relations: mine.filter((p) => p.relation).map((p) => ({ relation: p.relation as PersonRelation, assertion: p.assertion, quote: p.quote, statedAt: p.statedAt && Number.isFinite(Date.parse(p.statedAt)) ? p.statedAt : said.at })),
      otherPersons: others,
      ...(m.topicId ? { topicId: m.topicId } : {}),
      ...(() => { const s = statusOf(m.summary ?? ""); return s ? { status: s } : {}; })(),
      retrospective: (() => {
        const ev = m.eventTime ? Date.parse(m.eventTime.length === 4 ? `${m.eventTime}-01-01` : m.eventTime.length === 7 ? `${m.eventTime}-01` : m.eventTime) : NaN;
        return Number.isFinite(ev) && timeOf(said.at) - ev > 30 * 86_400_000;
      })(),
      keywords: m.keywords ?? [],
      linkCount: (m.links ?? []).length,
    };
  });

  // relation: the PersonView of each grouping key of this person (Capture's classification, contested when the user's words disagree)
  const personViews = computePersonViews(about.map((x) => x.m)).filter((v) => keys.includes(personSheetKey(v.displayName)));
  const relationBasis = records.flatMap((r) => r.relations.map((rel) => ({ kind: "user" as const, text: rel.quote, memoryId: r.memoryId, saidAt: rel.statedAt, relation: rel.relation, correction: rel.assertion === "correction" })))
    .sort((a, b) => timeOf(a.saidAt) - timeOf(b.saidAt));
  const contested = personViews.some((v) => v.relationContested) || new Set(personViews.map((v) => v.relation).filter(Boolean)).size > 1;
  const current = personViews.map((v) => v.relation).find(Boolean);
  const relation = relationBasis.length > 0 || personViews.length > 0
    ? { label: contested ? "食い違いあり（確定しない）" : current ? PERSON_RELATION_LABEL_JA[current] : "記録なし", contested, basis: relationBasis }
    : undefined;

  const coCount = new Map<string, number>();
  for (const r of records) for (const n of r.otherPersons) coCount.set(n, (coCount.get(n) ?? 0) + 1);

  // statements: every sentence of the user's words of the records, classified by its form; each sentence once (the first time it was said)
  const views: SheetView[] = [];
  const asked: SheetAsked[] = [];
  const statements: SheetStatement[] = [];
  const firstSeen = new Map<string, { memoryId: string; view?: SheetView; asked?: SheetAsked }>();
  for (const { m } of about) {
    const r = records.find((x) => x.memoryId === m.id)!;
    const userTexts: { t: SheetText; source: SheetStatement["source"] }[] = [
      ...r.mentionQuotes.map((t) => ({ t, source: "mention" as const })),
      ...r.evidence.map((e) => ({ t: { kind: e.kind, text: e.text, memoryId: e.memoryId, saidAt: e.saidAt }, source: "evidence" as const })),
      ...(m.topicEvents ?? []).filter((e) => e.quote).map((e) => ({ t: { kind: "user" as const, text: e.quote, memoryId: m.id, saidAt: e.statedAt || r.saidAt }, source: "topic" as const })),
    ];
    let userView = false;
    for (const { t, source } of userTexts) {
      for (const sentence of statementSentences(t.text)) {
        const cls = classifyStatement(sentence);
        const text = { ...t, text: sentence };
        const other = aboutOther(sentence);
        if (cls.role === "judgment" || cls.role === "thought") userView = true;
        // the same words with the same kind are one statement; a question and a judgment that differ only by ？/。 stay apart (Codex on PR #33)
        const k = `${cls.role}:${statementKey(sentence)}`;
        const seen = firstSeen.get(k);
        if (seen) {
          if (seen.memoryId !== m.id) {
            const list = seen.view?.alsoIn ?? seen.asked?.alsoIn;
            if (list && !list.includes(m.id)) list.push(m.id);
          }
          statements.push({ text, source, ...cls, fate: "duplicate", fateNote: `同じ文を先に出した（${seen.memoryId === m.id ? "同じ記録" : `#${seen.memoryId.slice(-6)}`}）`, aboutOther: other, duplicateOf: seen.memoryId });
          continue;
        }
        if (cls.role === "judgment" || cls.role === "thought") {
          const v: SheetView = { text, aboutOther: other, role: cls.role, reason: cls.reason, alsoIn: [] };
          views.push(v);
          firstSeen.set(k, { memoryId: m.id, view: v });
          statements.push({ text, source, ...cls, fate: "view", fateNote: `「過去の考え・結論」に出した（${STATEMENT_ROLE_LABEL[cls.role]}）`, aboutOther: other });
        } else if (cls.role === "question" || cls.role === "request") {
          const a: SheetAsked = { text, role: cls.role, reason: cls.reason, alsoIn: [] };
          asked.push(a);
          firstSeen.set(k, { memoryId: m.id, asked: a });
          statements.push({ text, source, ...cls, fate: "asked", fateNote: `「質問・依頼」に分けた（${STATEMENT_ROLE_LABEL[cls.role]}）`, aboutOther: other });
        } else {
          firstSeen.set(k, { memoryId: m.id });
          statements.push({ text, source, ...cls, fate: "not-a-view", fateNote: `${STATEMENT_ROLE_LABEL[cls.role]}なので、考えには入れない（出来事の欄にある）`, aboutOther: other });
        }
      }
    }
    // the AI summary is narrated by the AI: only its sentences with a thought or feeling word, and only when the record has no view in the user's words
    for (const sentence of statementSentences(r.summary.text)) {
      const text = { ...r.summary, text: sentence };
      const other = aboutOther(sentence);
      const hasView = OWN_VIEW.test(sentence);
      if (!hasView) {
        statements.push({ text, source: "summary", role: "other", reason: "AIの要約で、考え・気持ちの言葉が無い", fate: "not-a-view", fateNote: "AIの要約の文で、考え・気持ちの言葉が無い", aboutOther: other });
      } else if (userView) {
        statements.push({ text, source: "summary", role: "thought", reason: "AIの要約に考え・気持ちの言葉がある", fate: "summary-not-used", fateNote: "この記録には本人の発言の考えがあるため、AIの要約は使わない", aboutOther: other });
      } else {
        views.push({ text, aboutOther: other, role: "thought", reason: "AIの要約に考え・気持ちの言葉がある（本人の発言には考えの文が無い記録）", alsoIn: [] });
        statements.push({ text, source: "summary", role: "thought", reason: "AIの要約に考え・気持ちの言葉がある", fate: "view", fateNote: "「過去の考え・結論」に出した（AIの要約）", aboutOther: other });
      }
    }
  }
  views.sort((a, b) => timeOf(a.text.saidAt) - timeOf(b.text.saidAt));
  asked.sort((a, b) => timeOf(a.text.saidAt) - timeOf(b.text.saidAt));

  const lastBy = <T,>(items: T[], at: (x: T) => string) => items.reduce<T | undefined>((a, b) => (a === undefined || timeOf(at(b)) >= timeOf(at(a)) ? b : a), undefined);
  const later = (m: MemoryObject, after: string) => timeOf(saidAtOf(m).at) > timeOf(after);
  const laterOf = (m: MemoryObject, terms: string[]): SheetLater => ({
    memoryId: m.id, saidAt: saidAtOf(m).at, summary: m.summary ?? "", sharedTerms: sharedTerms(terms, m),
    ...(() => { const s = statusOf(m.summary ?? "", terms); return s ? { status: s } : {}; })(),
  });
  const nonRetro = records.filter((r) => !r.retrospective);
  const lastRelation = lastBy(records.flatMap((r) => r.relations.map((rel) => ({ kind: "user" as const, text: rel.quote, memoryId: r.memoryId, saidAt: rel.statedAt, relation: rel.relation }))), (x) => x.saidAt);
  const ownViews = views.filter((x) => x.text.kind === "user" && !x.aboutOther);
  const last: PersonSheet["last"] = {
    ...(() => { const s = lastBy(records, (r) => r.saidAt); return s ? { said: s } : {}; })(),
    ...(() => {
      const s = lastBy(nonRetro.filter((r) => r.status), (r) => r.saidAt);
      if (!s) return {};
      const terms = termsOf(byId.get(s.memoryId));
      const statusLater = s.topicId
        ? all.filter((m) => m.id !== s.memoryId && m.topicId === s.topicId && later(m, s.saidAt))
          .map((m) => laterOf(m, terms))
          .filter((x): x is SheetLater & { status: TimelineStatus } => x.status !== undefined && x.sharedTerms.length > 0)
          .sort((a, b) => timeOf(a.saidAt) - timeOf(b.saidAt))
        : [];
      return { status: s, ...(statusLater.length > 0 ? { statusLater } : {}) };
    })(),
    ...(lastRelation ? { relation: lastRelation } : {}),
    ...(() => { const v = lastBy(ownViews, (x) => x.text.saidAt); return v ? { ownView: v } : {}; })(),
    ...(() => { const v = lastBy(ownViews.filter((x) => x.role === "judgment"), (x) => x.text.saidAt); return v ? { judgment: v } : {}; })(),
  };

  // plans: a 予定 / 検討中 status word, or an event date later than the day it was said.
  // The outcome is only a later record with an outcome word that shares a word of the plan; sharing the topic alone is not an outcome.
  const plans: SheetPlan[] = [];
  for (const r of records) {
    const futureEvent = r.eventTime ? timeOf(r.eventTime.length === 4 ? `${r.eventTime}-12-31` : r.eventTime.length === 7 ? `${r.eventTime}-28` : r.eventTime) > timeOf(r.saidAt) : false;
    const isPlan = r.status === "予定" || r.status === "検討中";
    if (!isPlan && !futureEvent) continue;
    const terms = termsOf(byId.get(r.memoryId));
    const pool = new Map<string, MemoryObject>();
    if (r.topicId) for (const m of all) if (m.id !== r.memoryId && m.topicId === r.topicId && later(m, r.saidAt)) pool.set(m.id, m);
    for (const { m } of about) if (m.id !== r.memoryId && later(m, r.saidAt)) pool.set(m.id, m);
    const ordered = [...pool.values()].sort((a, b) => timeOf(saidAtOf(a).at) - timeOf(saidAtOf(b).at));
    const outcomeMemory = ordered.find((m) => {
      const l = laterOf(m, terms);
      return l.status !== undefined && OUTCOME_STATUSES.has(l.status) && l.sharedTerms.length > 0;
    });
    const outcome = outcomeMemory ? { ...laterOf(outcomeMemory, terms), sameTopic: Boolean(r.topicId) && outcomeMemory.topicId === r.topicId } as SheetPlan["outcome"] : undefined;
    const laterSameTopic = r.topicId ? ordered.filter((m) => m.topicId === r.topicId && m.id !== outcomeMemory?.id).map((m) => laterOf(m, terms)) : [];
    plans.push({ record: r, why: isPlan ? "status" : "event-later-than-said", ...(outcome ? { outcome } : {}), laterSameTopic });
  }

  // topics of the person's records: the user's words of the whole topic, and the records of the topic about someone else
  // the record's topic and every topic its kept quotes belong to (a Capture UPDATE may change topicId and keep the earlier topic's quotes: Codex on PR #32)
  const topicIdsOf = (m: MemoryObject) => [m.topicId, ...(m.topicEvents ?? []).map((e) => e.topicId)].filter((x): x is string => Boolean(x));
  const topicIds = [...new Set(about.flatMap((x) => topicIdsOf(x.m)))];
  const topics: SheetTopic[] = topicIds.map((topicId) => {
    const inTopic = all.filter((m) => m.topicId === topicId || (m.topicEvents ?? []).some((e) => e.topicId === topicId));
    const events = inTopic.flatMap((m) => (m.topicEvents ?? []).filter((e) => e.topicId === topicId && e.quote).map((e) => ({
      quote: e.quote, saidAt: e.statedAt, memoryId: m.id, namesThisPerson: namesAny(e.quote, keys, otherKeys), otherPersons: othersNamedIn(e.quote, keys, otherKeys),
    }))).sort((a, b) => timeOf(a.saidAt) - timeOf(b.saidAt));
    const otherRecords = inTopic.filter((m) => !aboutIds.has(m.id)).map((m) => { const n = namesOf(m); return { memoryId: m.id, saidAt: saidAtOf(m).at, persons: [...new Set([...n.mention, ...n.keyword])] }; });
    return { topicId, events, otherRecords };
  });

  // Connect: every link of the person's records (a reading of Connect's AI, not a fact)
  const links: SheetLink[] = [];
  const seenLinks = new Set<string>();
  for (const x of about) {
    for (const l of x.m.links ?? []) {
      if (seenLinks.has(l.id)) continue;
      seenLinks.add(l.id);
      const otherId = l.sourceId === x.m.id ? l.targetId : l.sourceId;
      const other = byId.get(otherId);
      links.push({
        fromId: x.m.id, toId: otherId, axis: l.axis, reason: l.reason, strength: l.strength, contrast: l.contrast,
        otherEndAboutPerson: aboutIds.has(otherId),
        ...(other ? { otherEndSummary: other.summary, otherEndSaidAt: saidAtOf(other).at } : {}),
      });
    }
  }

  // Memory Timeline themes that the person's records belong to (the theme may hold records about other people too)
  const personKeywords = new Set(records.flatMap((r) => r.keywords));
  const themes: SheetTheme[] = timelineThemes(all.filter(isSynthesisSource)).filter((t) => personKeywords.has(t)).map((theme) => {
    const { state, points } = buildThemeTimeline(theme, all);
    return {
      theme,
      state: state.status,
      ...(state.basisMemoryId ? { stateBasisId: state.basisMemoryId } : {}),
      ...(state.basisStatedAt ? { stateBasisSaidAt: state.basisStatedAt } : {}),
      points: points.map((p) => ({ memoryId: p.memoryId, saidAt: p.statedAt, summary: p.summary, ...(p.status ? { status: p.status } : {}), aboutPerson: aboutIds.has(p.memoryId) })),
    };
  });

  // other names that MAY be this person: what the records of both have in common (never joined here)
  const namedIds = new Set(about.filter((x) => x.match !== "text").map((x) => x.m.id));
  const myTopics = new Set(about.filter((x) => x.match !== "text").flatMap((x) => topicIdsOf(x.m)));
  const myCo = new Set([...coCount.keys()].map(personSheetKey));
  const aliasCandidates: SheetAliasCandidate[] = [];
  for (const p of persons) {
    if (keys.includes(p.key)) continue;
    const ids = all.filter((m) => { const n = namesOf(m); return [...n.mention, ...n.keyword].some((x) => personSheetKey(x) === p.key); });
    const idSet = new Set(ids.map((m) => m.id));
    const theirTopics = new Set(ids.flatMap(topicIdsOf));
    const sharedTopics = [...theirTopics].filter((t) => myTopics.has(t)).length;
    const linkIds = new Set<string>();
    for (const m of all) for (const l of m.links ?? []) {
      if ((namedIds.has(l.sourceId) && idSet.has(l.targetId)) || (idSet.has(l.sourceId) && namedIds.has(l.targetId))) linkIds.add(l.id);
    }
    const theirCo = new Set(ids.flatMap((m) => { const n = namesOf(m); return [...n.mention, ...n.keyword].map(personSheetKey); }));
    const sharedCoPersons = [...theirCo].filter((k) => k !== p.key && !keys.includes(k) && myCo.has(k));
    const similarName = similarNames.includes(p.key);
    if (sharedTopics === 0 && linkIds.size === 0 && !similarName) continue;
    aliasCandidates.push({
      key: p.key, names: p.names, records: idSet.size, sharedTopics, links: linkIds.size, sharedCoPersons,
      bothInOneRecord: ids.filter((m) => namedIds.has(m.id)).length, similarName,
    });
  }
  aliasCandidates.sort((a, b) => b.sharedTopics + b.links - (a.sharedTopics + a.links) || b.records - a.records);

  return {
    key,
    keys,
    names,
    similarNames,
    aliasCandidates,
    overview: {
      records: records.length,
      mentionRecords: records.filter((r) => r.match === "mention").length,
      keywordOnlyRecords: records.filter((r) => r.match === "keyword").length,
      textOnlyRecords: records.filter((r) => r.match === "text").length,
      ...(records.length > 0 ? { firstSaidAt: records[0].saidAt, lastSaidAt: records[records.length - 1].saidAt } : {}),
      ...(relation ? { relation } : {}),
      coPersons: [...coCount.entries()].map(([name, n]) => ({ name, records: n })).sort((a, b) => b.records - a.records),
    },
    records,
    views,
    asked,
    statements,
    last,
    plans,
    topics,
    links,
    themes,
  };
}

/** one Memory that holds the words looked for, and why it is or is not on the sheet */
export interface SheetFindHit {
  memoryId: string;
  saidAt: string;
  /** how the record is on this sheet; null: it is not */
  onSheet: SheetMatch | null;
  /** the people the record names (person mentions and name keywords) */
  persons: string[];
  /** where the words are: 本人の発言 / 人物の発言 / 話題の発言 / AIの要約 / AIの本文 / キーワード */
  where: string[];
  /** why the record is not on this sheet */
  whyNotOnSheet?: string;
  /** each sentence holding the words, what kind of statement it is, and what the sheet did with it */
  sentences: { text: string; source: string; role?: StatementRole; reason?: string; fateNote: string }[];
}

/**
 * looks for words in every Memory (not only this person's) and tells, for each hit, whether the record is on this sheet and what the sheet did
 * with the sentence: shown as a judgment or thought, kept apart as a question, shown once already, or not a view (and why).
 */
export function findInPersonSheet(memories: MemoryObject[], sheet: PersonSheet, words: string): SheetFindHit[] {
  const q = norm(words);
  if (!q) return [];
  const has = (t: string | undefined) => Boolean(t) && norm(t!).includes(q);
  const hits: SheetFindHit[] = [];
  for (const m of memories) {
    const quotes = [
      ...(m.evidenceQuotes ?? []).map((t) => ({ t, source: "本人の発言（根拠）" })),
      ...(m.personMentions ?? []).map((p) => ({ t: p.quote ?? "", source: `人物の発言（${p.displayName || p.groupingKey}）` })),
      ...(m.topicEvents ?? []).map((e) => ({ t: e.quote ?? "", source: "話題の発言" })),
    ].filter((x) => has(x.t));
    const inSummary = has(m.summary);
    const inContent = has(m.content);
    const inKeywords = (m.keywords ?? []).some((k) => has(k));
    if (quotes.length === 0 && !inSummary && !inContent && !inKeywords) continue;
    const record = sheet.records.find((r) => r.memoryId === m.id);
    const { mention, keyword } = namesOf(m);
    const persons = [...new Set([...mention, ...keyword])];
    const where = [...new Set([...quotes.map((x) => x.source), ...(inSummary ? ["AIの要約"] : []), ...(inContent ? ["AIの本文"] : []), ...(inKeywords ? ["キーワード"] : [])])];
    const fateOf = (sentence: string, sources: SheetStatement["source"][]) => {
      const role = sources.includes("summary") ? undefined : classifyStatement(sentence).role;
      return sheet.statements.find((s) => s.text.memoryId === m.id && sources.includes(s.source) && (role === undefined || s.role === role) && statementKey(s.text.text) === statementKey(sentence));
    };
    const sentences: SheetFindHit["sentences"] = [];
    const seen = new Set<string>();
    for (const { t, source } of quotes) {
      for (const sentence of statementSentences(t).filter(has)) {
        if (seen.has(sentence)) continue;
        seen.add(sentence);
        const st = fateOf(sentence, ["mention", "evidence", "topic"]);
        const cls = st ? { role: st.role, reason: st.reason } : classifyStatement(sentence);
        sentences.push({
          text: sentence, source, ...cls,
          fateNote: st
            ? `${st.fateNote}${st.aboutOther ? "・別の人の話かもしれない" : ""}`
            : !record ? "この記録はこのシートに入っていない"
            : "この人の発言として集めていない（別の人の人物記録の発言）",
        });
      }
    }
    if (inSummary) {
      for (const sentence of statementSentences(m.summary).filter(has)) {
        const st = fateOf(sentence, ["summary"]);
        sentences.push({ text: sentence, source: "AIの要約", fateNote: st ? st.fateNote : "この記録はこのシートに入っていない" });
      }
    }
    if (inContent) sentences.push({ text: statementSentences(m.content).filter(has).join(" "), source: "AIの本文", fateNote: "AIの本文は、考えの材料にしていない（Memoryの詳細で見られる）" });
    hits.push({
      memoryId: m.id,
      saidAt: saidAtOf(m).at,
      onSheet: record ? record.match : null,
      persons,
      where,
      ...(record ? {} : {
        whyNotOnSheet: persons.length > 0
          ? `この記録の人物・名前のキーワードは「${persons.join("、")}」で、このシートの名前（${sheet.names.join("、") || sheet.key}）は記録されていない。本文にもこの名前が無い。別の名前が同じ人なら、「一緒に見る」で表示される`
          : `この記録には人物の記録も名前のキーワードも無く、本文にもこのシートの名前（${sheet.names.join("、") || sheet.key}）が無い`,
      }),
      sentences,
    });
  }
  return hits.sort((a, b) => timeOf(a.saidAt) - timeOf(b.saidAt));
}

/** a plain-text rendering of the sheet (for the debug page's copy button); each line says its kind and the short id of its Memory */
export function renderPersonSheetText(sheet: PersonSheet): string {
  const id = (x: string) => `#${x.slice(-6)}`;
  const t = (x: SheetText) => `[${SHEET_SOURCE_LABEL[x.kind]} ${dayOf(x.saidAt)} ${id(x.memoryId)}] ${x.text}`;
  const out: string[] = [];
  out.push(`人物シート（試作・保存しない・AIは使わない）：${sheet.names.join(" / ") || sheet.key}`);
  if (sheet.keys.length > 1) out.push(`この画面だけ一緒に表示している名前（同じ人とは確定していない）：${sheet.keys.join("、")}`);
  if (sheet.similarNames.length > 0) out.push(`似た名前（別人として扱う。取り違えに注意）：${sheet.similarNames.join("、")}`);
  if (sheet.aliasCandidates.length > 0) {
    out.push("同じ人かもしれない別の名前（推測。まとめていない）：");
    for (const c of sheet.aliasCandidates) out.push(`  ${c.names.join(" / ")}：同じ話題 ${c.sharedTopics}・Connectのつながり ${c.links}${c.sharedCoPersons.length ? `・共通して出てくる人 ${c.sharedCoPersons.join("、")}` : ""}${c.bothInOneRecord ? `・同じ記録に両方の名前 ${c.bothInOneRecord}（別人の可能性）` : ""}${c.similarName ? "・名前が似ている" : ""}`);
  }
  out.push("", "■ 関係の概要");
  out.push(`記録 ${sheet.overview.records}件（人物として記録 ${sheet.overview.mentionRecords}件・キーワードのみ ${sheet.overview.keywordOnlyRecords}件・本文での言及だけ ${sheet.overview.textOnlyRecords}件）${sheet.overview.firstSaidAt ? ` ${dayOf(sheet.overview.firstSaidAt)}〜${dayOf(sheet.overview.lastSaidAt)}` : ""}`);
  if (sheet.overview.relation) {
    out.push(`関係（Captureの分類）：${sheet.overview.relation.label}`);
    for (const b of sheet.overview.relation.basis) out.push(`  ${t(b)}（分類：${PERSON_RELATION_LABEL_JA[b.relation]}${b.correction ? "・訂正" : ""}）`);
  }
  if (sheet.overview.coPersons.length > 0) out.push(`同じ記録に出てくる人：${sheet.overview.coPersons.map((p) => `${p.name}(${p.records})`).join("、")}`);
  out.push("", "■ 出来事（記録の時系列。話した日の順）");
  for (const r of sheet.records) {
    const tags = [r.match === "keyword" ? "キーワードのみ" : r.match === "text" ? "本文での言及だけ" : "", r.saidAtIsRecordDate ? "記録日" : "話した日", r.eventTime ? `出来事 ${r.eventTime}` : "", r.status ? `記録の言葉「${r.status}」` : "", r.retrospective ? "以前の出来事を後から話した" : "", r.otherPersons.length ? `他の人：${r.otherPersons.join("、")}` : "", r.topicId ? `話題 ${id(r.topicId)}` : ""].filter(Boolean).join(" / ");
    out.push(`- ${dayOf(r.saidAt)} ${id(r.memoryId)}（${tags}）`);
    out.push(`  ${t(r.summary)}`);
    for (const q of r.mentionQuotes) out.push(`  ${t(q)}`);
    for (const q of r.evidence) out.push(`  ${t(q)}${q.aboutOther ? "（別の人の話かもしれない）" : ""}`);
  }
  out.push("", "■ 過去の考え・結論（記録した時点のもの。古い順。同じ文は1回）");
  if (sheet.views.length === 0) out.push("（なし）");
  for (const v of sheet.views) out.push(`- 〔${STATEMENT_ROLE_LABEL[v.role]}〕${t(v.text)}${v.aboutOther ? "（別の人についての考えかもしれない）" : ""}${v.alsoIn.length ? `（同じ文：${v.alsoIn.map(id).join(" ")}）` : ""}`);
  out.push("", `■ 質問・依頼（考えとは分けたもの：${sheet.asked.length}件）`);
  for (const a of sheet.asked) out.push(`- 〔${STATEMENT_ROLE_LABEL[a.role]}〕${t(a.text)}`);
  out.push("", "■ 最後に確認できた記録（今も同じとは限らない）");
  if (sheet.last.said) out.push(`- 最後に話した記録：${t(sheet.last.said.summary)}`);
  if (sheet.last.status) out.push(`- 状態の言葉がある最後の記録：「${sheet.last.status.status}」 ${t(sheet.last.status.summary)}`);
  for (const l of sheet.last.statusLater ?? []) out.push(`  同じ話題で共通の言葉（${l.sharedTerms.join("、")}）がある後の記録（この人の記録とは限らない）：${dayOf(l.saidAt)} ${id(l.memoryId)} 「${l.status}」 ${l.summary}`);
  if (sheet.last.relation) out.push(`- 最後に述べた関係：${PERSON_RELATION_LABEL_JA[sheet.last.relation.relation]} ${t(sheet.last.relation)}`);
  if (sheet.last.judgment) out.push(`- 本人の言葉での最後の判断・結論：${t(sheet.last.judgment.text)}`);
  if (sheet.last.ownView) out.push(`- 本人の言葉での最後の考え：${t(sheet.last.ownView.text)}`);
  out.push("", "■ 予定とその後（結果は候補。同じ話題というだけでは結果としない）");
  if (sheet.plans.length === 0) out.push("（なし）");
  for (const p of sheet.plans) {
    out.push(`- ${t(p.record.summary)}（${p.why === "status" ? `記録の言葉「${p.record.status}」` : `出来事 ${p.record.eventTime} が話した日より後`}${p.record.topicId ? `・話題 ${id(p.record.topicId)}` : ""}）`);
    if (p.outcome) out.push(`  結果の候補：${dayOf(p.outcome.saidAt)} ${id(p.outcome.memoryId)} 「${p.outcome.status}」（共通の言葉：${p.outcome.sharedTerms.join("、")}${p.outcome.sameTopic ? "・同じ話題" : "・別の話題"}） ${p.outcome.summary}`);
    else out.push("  結果の候補なし（結果は不明）");
    if (p.laterSameTopic.length > 0) out.push(`  同じ話題の後の記録 ${p.laterSameTopic.length}件（結果とはしていない）：${p.laterSameTopic.map((l) => id(l.memoryId)).join(" ")}`);
  }
  out.push("", "■ 話題（Topic Timeline：本人の発言）");
  if (sheet.topics.length === 0) out.push("（なし）");
  for (const tp of sheet.topics) {
    out.push(`- 話題 ${id(tp.topicId)}`);
    for (const e of tp.events) out.push(`  [本人の発言 ${dayOf(e.saidAt)} ${id(e.memoryId)}] ${e.quote}${e.otherPersons.length ? `（他の人：${e.otherPersons.join("、")}）` : ""}`);
    for (const o of tp.otherRecords) out.push(`  この話題の、この人の記録ではないもの：${dayOf(o.saidAt)} ${id(o.memoryId)}${o.persons.length ? `（${o.persons.join("、")}）` : ""}`);
  }
  out.push("", "■ Connectの推測（AIが判定したつながり。事実ではない）");
  if (sheet.links.length === 0) out.push("（なし）");
  for (const l of sheet.links) out.push(`- ${id(l.fromId)} → ${id(l.toId)} 軸:${l.axis} 強さ:${l.strength}${l.contrast ? " 対比" : ""}${l.otherEndAboutPerson ? "" : "（相手側はこの人の記録ではない）"} 理由:${l.reason}`);
  out.push("", "■ テーマ（Memory Timeline。他の人の記録も含む）");
  if (sheet.themes.length === 0) out.push("（なし）");
  for (const th of sheet.themes) {
    out.push(`- 「${th.theme}」 状態：${th.state}${th.stateBasisId ? `（根拠 ${dayOf(th.stateBasisSaidAt)} ${id(th.stateBasisId)}）` : ""}`);
    for (const p of th.points) out.push(`  ${dayOf(p.saidAt)} ${id(p.memoryId)}${p.status ? ` 「${p.status}」` : ""}${p.aboutPerson ? "" : "（この人の記録ではない）"} ${p.summary}`);
  }
  return out.join("\n");
}
