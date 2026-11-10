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
 *   Names that differ only by an honorific (さきさん / さき) are one person. Different names (さきさん / 妻) are never joined. A name that contains
 *   another (さき / まさき) is listed under 「似た名前」 so that a mix-up can be seen.
 *
 * The sheet does not say what the present state is, and it draws no causal lines. It shows the last record that can be confirmed and its date,
 * and links a plan only to a later record that shares its topic (same topicId) or, as a candidate, a keyword.
 * There is no length limit: every record about the person is shown (the debug page folds the long parts).
 */
import { computePersonViews } from "./person";
import { OWN_VIEW } from "./memoryContext";
import { buildThemeTimeline, isSynthesisSource, statusOf, timelineThemes, type TimelineStatus } from "./memorySynthesis";
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
const sentencesOf = (text: string) => (text.match(/[^。！？!?\n]+[。！？!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

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

export interface SheetRecord {
  memoryId: string;
  conversationId?: string;
  saidAt: string;
  saidAtIsRecordDate: boolean;
  eventTime?: string;
  /** "mention": Capture recorded the person; "keyword": only a keyword is the name */
  match: "mention" | "keyword";
  summary: SheetText;
  /** the user's own words about this person in this record (personMentions of the person) */
  mentionQuotes: SheetText[];
  /** the user's words the record rests on (evidenceQuotes). `aboutOther`: names someone else and not this person */
  evidence: (SheetText & { aboutOther: boolean })[];
  /** the relation category Capture recorded with the mention (AI's classification of the user's words) */
  relations: { relation: PersonRelation; assertion: "mention" | "correction"; quote: string }[];
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

export interface SheetView {
  /** the user's view in the user's words, or in the AI summary */
  text: SheetText;
  /** the sentence names another person and not this one (possible mix-up) */
  aboutOther: boolean;
}

export interface SheetPlan {
  record: SheetRecord;
  why: "status" | "event-later-than-said";
  /** later records of the same topic (topicId), with their status words */
  sameTopicLater: { memoryId: string; saidAt: string; status?: TimelineStatus; summary: string }[];
  /** later records about the person sharing a keyword (candidates only: they may be about something else) */
  keywordLater: { memoryId: string; saidAt: string; status?: TimelineStatus; summary: string; sharedKeywords: string[] }[];
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

export interface PersonSheet {
  key: string;
  names: string[];
  /** other name keys that contain this one or are contained in it (never joined) */
  similarNames: string[];
  overview: {
    records: number;
    mentionRecords: number;
    keywordOnlyRecords: number;
    firstSaidAt?: string;
    lastSaidAt?: string;
    /** PersonView of the mentions (relation as Capture classified it, or contested) */
    relation?: { label: string; contested: boolean; basis: (SheetText & { relation: PersonRelation; correction: boolean })[] };
    /** people who appear in the same records, with how many records */
    coPersons: { name: string; records: number }[];
  };
  /** every record about the person, oldest first */
  records: SheetRecord[];
  views: SheetView[];
  last: {
    /** the record said last (it may not describe the present) */
    said?: SheetRecord;
    /** the last record with a status word in its summary */
    status?: SheetRecord;
    /** later records of the same topic as `status` that carry a status word (they may be about the same plan; not merged) */
    statusLater?: { memoryId: string; saidAt: string; status: TimelineStatus; summary: string }[];
    /** the last relation the user stated */
    relation?: SheetText & { relation: PersonRelation };
    /** the last view in the user's own words */
    ownView?: SheetView;
  };
  plans: SheetPlan[];
  topics: SheetTopic[];
  links: SheetLink[];
  themes: SheetTheme[];
}

function isAboutKey(m: MemoryObject, key: string): "mention" | "keyword" | null {
  const { mention, keyword } = namesOf(m);
  if (mention.some((n) => personSheetKey(n) === key)) return "mention";
  if (keyword.some((n) => personSheetKey(n) === key) || (m.keywords ?? []).some((k) => personSheetKey(k) === key)) return "keyword";
  return null;
}

/** the other people a text names (by the names known from the records), never counting this person or a name inside this person's name */
function othersNamedIn(text: string, key: string, otherKeys: string[]): string[] {
  const t = text.normalize("NFKC").replace(/\s+/g, "");
  const masked = t.split(key).join("■");
  // a longer name that holds this one (さきこ for さき) is looked for in the text as it is; any other name with this person's name masked out
  return otherKeys.filter((k) => k !== key && !key.includes(k) && (k.includes(key) ? t.includes(k) : masked.includes(k)));
}

/** the text names this person: the name occurs outside any longer known name that holds it (さき inside さきこ is not さき) */
function namesThis(text: string, key: string, otherKeys: string[] = []): boolean {
  let t = text.normalize("NFKC").replace(/\s+/g, "");
  for (const k of otherKeys.filter((x) => x !== key && x.includes(key)).sort((a, b) => b.length - a.length)) t = t.split(k).join("\u25A0");
  return t.includes(key);
}

export function buildPersonSheet(memories: MemoryObject[], key: string): PersonSheet {
  const all = memories.filter((m) => m && typeof m.id === "string");
  const persons = listSheetPersons(all);
  const otherKeys = persons.map((p) => p.key).filter((k) => k !== key && Array.from(k).length >= 2);
  const names = persons.find((p) => p.key === key)?.names ?? [];
  const similarNames = otherKeys.filter((k) => k.includes(key) || key.includes(k));
  const byId = new Map(all.map((m) => [m.id, m] as const));

  const about = all
    .map((m) => ({ m, match: isAboutKey(m, key) }))
    .filter((x): x is { m: MemoryObject; match: "mention" | "keyword" } => x.match !== null)
    .sort((a, b) => timeOf(saidAtOf(a.m).at) - timeOf(saidAtOf(b.m).at));
  const aboutIds = new Set(about.map((x) => x.m.id));

  const records: SheetRecord[] = about.map(({ m, match }) => {
    const said = saidAtOf(m);
    const mine = (m.personMentions ?? []).filter((p) => personSheetKey(p.displayName || p.groupingKey || "") === key);
    const { mention, keyword } = namesOf(m);
    const others = [...new Set([...mention, ...keyword].filter((n) => personSheetKey(n) !== key))];
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
        kind: "user" as const, text: q.trim(), memoryId: m.id, saidAt: said.at,
        aboutOther: !namesThis(q, key, otherKeys) && othersNamedIn(q, key, otherKeys).length > 0,
      })),
      relations: mine.filter((p) => p.relation).map((p) => ({ relation: p.relation as PersonRelation, assertion: p.assertion, quote: p.quote })),
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
  const views = computePersonViews(about.map((x) => x.m)).filter((v) => personSheetKey(v.displayName) === key);
  const relationBasis = records.flatMap((r) => r.relations.map((rel) => ({ kind: "user" as const, text: rel.quote, memoryId: r.memoryId, saidAt: r.saidAt, relation: rel.relation, correction: rel.assertion === "correction" })));
  const contested = views.some((v) => v.relationContested) || new Set(views.map((v) => v.relation).filter(Boolean)).size > 1;
  const current = views.map((v) => v.relation).find(Boolean);
  const relation = relationBasis.length > 0 || views.length > 0
    ? { label: contested ? "食い違いあり（確定しない）" : current ? PERSON_RELATION_LABEL_JA[current] : "記録なし", contested, basis: relationBasis }
    : undefined;

  const coCount = new Map<string, number>();
  for (const r of records) for (const n of r.otherPersons) coCount.set(n, (coCount.get(n) ?? 0) + 1);

  // views: sentences with a thought / feeling / judgment word; the user's words first, then the AI summary of records that have no such words of the user
  const viewsOut: SheetView[] = [];
  for (const r of records) {
    const userTexts = [...r.mentionQuotes, ...r.evidence];
    const userViews = userTexts.flatMap((t) => sentencesOf(t.text).filter((s) => OWN_VIEW.test(s)).map((s) => ({ ...t, text: s })));
    const seen = new Set<string>();
    for (const t of userViews) {
      if (seen.has(t.text)) continue;
      seen.add(t.text);
      viewsOut.push({ text: t, aboutOther: !namesThis(t.text, key, otherKeys) && othersNamedIn(t.text, key, otherKeys).length > 0 });
    }
    if (userViews.length === 0) {
      for (const s of sentencesOf(r.summary.text).filter((x) => OWN_VIEW.test(x))) {
        viewsOut.push({ text: { ...r.summary, text: s }, aboutOther: !namesThis(s, key, otherKeys) && othersNamedIn(s, key, otherKeys).length > 0 });
      }
    }
  }

  const lastBy = <T,>(items: T[], at: (x: T) => string) => items.reduce<T | undefined>((a, b) => (a === undefined || timeOf(at(b)) >= timeOf(at(a)) ? b : a), undefined);
  const nonRetro = records.filter((r) => !r.retrospective);
  const lastRelation = lastBy(records.flatMap((r) => r.relations.map((rel) => ({ kind: "user" as const, text: rel.quote, memoryId: r.memoryId, saidAt: r.saidAt, relation: rel.relation }))), (x) => x.saidAt);
  const last = {
    ...(() => { const s = lastBy(records, (r) => r.saidAt); return s ? { said: s } : {}; })(),
    ...(() => {
      const s = lastBy(nonRetro.filter((r) => r.status), (r) => r.saidAt);
      if (!s) return {};
      const later = s.topicId
        ? all.filter((m) => m.id !== s.memoryId && m.topicId === s.topicId && timeOf(saidAtOf(m).at) > timeOf(s.saidAt))
          .map((m) => ({ memoryId: m.id, saidAt: saidAtOf(m).at, status: statusOf(m.summary ?? ""), summary: m.summary ?? "" }))
          .filter((x): x is { memoryId: string; saidAt: string; status: TimelineStatus; summary: string } => x.status !== undefined)
          .sort((a, b) => timeOf(a.saidAt) - timeOf(b.saidAt))
        : [];
      return { status: s, ...(later.length > 0 ? { statusLater: later } : {}) };
    })(),
    ...(lastRelation ? { relation: lastRelation } : {}),
    ...(() => { const v = lastBy(viewsOut.filter((x) => x.text.kind === "user" && !x.aboutOther), (x) => x.text.saidAt); return v ? { ownView: v } : {}; })(),
  };

  // plans: a 予定 / 検討中 status word, or an event date later than the day it was said
  const plans: SheetPlan[] = [];
  for (const r of records) {
    const futureEvent = r.eventTime ? timeOf(r.eventTime.length === 4 ? `${r.eventTime}-12-31` : r.eventTime.length === 7 ? `${r.eventTime}-28` : r.eventTime) > timeOf(r.saidAt) : false;
    const isPlan = r.status === "予定" || r.status === "検討中";
    if (!isPlan && !futureEvent) continue;
    const later = (m: MemoryObject) => timeOf(saidAtOf(m).at) > timeOf(r.saidAt);
    const sameTopicLater = r.topicId
      ? all.filter((m) => m.id !== r.memoryId && m.topicId === r.topicId && later(m)).sort((a, b) => timeOf(saidAtOf(a).at) - timeOf(saidAtOf(b).at))
        .map((m) => ({ memoryId: m.id, saidAt: saidAtOf(m).at, summary: m.summary ?? "", ...(() => { const s = statusOf(m.summary ?? ""); return s ? { status: s } : {}; })() }))
      : [];
    const sameTopicIds = new Set(sameTopicLater.map((x) => x.memoryId));
    const ownKeywords = r.keywords.filter((k) => personSheetKey(k) !== key && !HONORIFIC.test(k));
    const keywordLater = about.map((x) => x.m)
      .filter((m) => m.id !== r.memoryId && !sameTopicIds.has(m.id) && later(m))
      .map((m) => ({ m, shared: ownKeywords.filter((k) => (m.keywords ?? []).includes(k)) }))
      .filter((x) => x.shared.length > 0)
      .map(({ m, shared }) => ({ memoryId: m.id, saidAt: saidAtOf(m).at, summary: m.summary ?? "", sharedKeywords: shared, ...(() => { const s = statusOf(m.summary ?? ""); return s ? { status: s } : {}; })() }));
    plans.push({ record: r, why: isPlan ? "status" : "event-later-than-said", sameTopicLater, keywordLater });
  }

  // topics of the person's records: the user's words of the whole topic, and the records of the topic about someone else
  const topicIds = [...new Set(records.map((r) => r.topicId).filter((x): x is string => Boolean(x)))];
  const topics: SheetTopic[] = topicIds.map((topicId) => {
    const inTopic = all.filter((m) => m.topicId === topicId || (m.topicEvents ?? []).some((e) => e.topicId === topicId));
    const events = inTopic.flatMap((m) => (m.topicEvents ?? []).filter((e) => e.topicId === topicId && e.quote).map((e) => ({
      quote: e.quote, saidAt: e.statedAt, memoryId: m.id, namesThisPerson: namesThis(e.quote, key, otherKeys), otherPersons: othersNamedIn(e.quote, key, otherKeys),
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

  return {
    key,
    names,
    similarNames,
    overview: {
      records: records.length,
      mentionRecords: records.filter((r) => r.match === "mention").length,
      keywordOnlyRecords: records.filter((r) => r.match === "keyword").length,
      ...(records.length > 0 ? { firstSaidAt: records[0].saidAt, lastSaidAt: records[records.length - 1].saidAt } : {}),
      ...(relation ? { relation } : {}),
      coPersons: [...coCount.entries()].map(([name, n]) => ({ name, records: n })).sort((a, b) => b.records - a.records),
    },
    records,
    views: viewsOut,
    last,
    plans,
    topics,
    links,
    themes,
  };
}

/** a plain-text rendering of the sheet (for the debug page's copy button); each line says its kind and the short id of its Memory */
export function renderPersonSheetText(sheet: PersonSheet): string {
  const id = (x: string) => `#${x.slice(-6)}`;
  const t = (x: SheetText) => `[${SHEET_SOURCE_LABEL[x.kind]} ${dayOf(x.saidAt)} ${id(x.memoryId)}] ${x.text}`;
  const out: string[] = [];
  out.push(`人物シート（試作・保存しない・AIは使わない）：${sheet.names.join(" / ") || sheet.key}`);
  if (sheet.similarNames.length > 0) out.push(`似た名前（別人として扱う。取り違えに注意）：${sheet.similarNames.join("、")}`);
  out.push("", "■ 関係の概要");
  out.push(`記録 ${sheet.overview.records}件（人物として記録 ${sheet.overview.mentionRecords}件・キーワードのみ ${sheet.overview.keywordOnlyRecords}件）${sheet.overview.firstSaidAt ? ` ${dayOf(sheet.overview.firstSaidAt)}〜${dayOf(sheet.overview.lastSaidAt)}` : ""}`);
  if (sheet.overview.relation) {
    out.push(`関係（Captureの分類）：${sheet.overview.relation.label}`);
    for (const b of sheet.overview.relation.basis) out.push(`  ${t(b)}（分類：${PERSON_RELATION_LABEL_JA[b.relation]}${b.correction ? "・訂正" : ""}）`);
  }
  if (sheet.overview.coPersons.length > 0) out.push(`同じ記録に出てくる人：${sheet.overview.coPersons.map((p) => `${p.name}(${p.records})`).join("、")}`);
  out.push("", "■ 出来事（記録の時系列。話した日の順）");
  for (const r of sheet.records) {
    const tags = [r.match === "keyword" ? "キーワードのみ" : "", r.saidAtIsRecordDate ? "記録日" : "話した日", r.eventTime ? `出来事 ${r.eventTime}` : "", r.status ? `記録の言葉「${r.status}」` : "", r.retrospective ? "以前の出来事を後から話した" : "", r.otherPersons.length ? `他の人：${r.otherPersons.join("、")}` : "", r.topicId ? `話題 ${id(r.topicId)}` : ""].filter(Boolean).join(" / ");
    out.push(`- ${dayOf(r.saidAt)} ${id(r.memoryId)}（${tags}）`);
    out.push(`  ${t(r.summary)}`);
    for (const q of r.mentionQuotes) out.push(`  ${t(q)}`);
    for (const q of r.evidence) out.push(`  ${t(q)}${q.aboutOther ? "（別の人の話かもしれない）" : ""}`);
  }
  out.push("", "■ 過去の考え・結論（記録した時点のもの）");
  if (sheet.views.length === 0) out.push("（なし）");
  for (const v of sheet.views) out.push(`- ${t(v.text)}${v.aboutOther ? "（別の人についての考えかもしれない）" : ""}`);
  out.push("", "■ 最後に確認できた記録（今も同じとは限らない）");
  if (sheet.last.said) out.push(`- 最後に話した記録：${t(sheet.last.said.summary)}`);
  if (sheet.last.status) out.push(`- 状態の言葉がある最後の記録：「${sheet.last.status.status}」 ${t(sheet.last.status.summary)}`);
  for (const l of sheet.last.statusLater ?? []) out.push(`  同じ話題の後の記録（この人の記録とは限らない）：${dayOf(l.saidAt)} ${id(l.memoryId)} 「${l.status}」 ${l.summary}`);
  if (sheet.last.relation) out.push(`- 最後に述べた関係：${PERSON_RELATION_LABEL_JA[sheet.last.relation.relation]} ${t(sheet.last.relation)}`);
  if (sheet.last.ownView) out.push(`- 本人の言葉での最後の考え：${t(sheet.last.ownView.text)}`);
  out.push("", "■ 予定とその後");
  if (sheet.plans.length === 0) out.push("（なし）");
  for (const p of sheet.plans) {
    out.push(`- ${t(p.record.summary)}（${p.why === "status" ? `記録の言葉「${p.record.status}」` : `出来事 ${p.record.eventTime} が話した日より後`}）`);
    if (p.sameTopicLater.length === 0 && p.keywordLater.length === 0) out.push("  その後の記録なし（結果は不明）");
    for (const l of p.sameTopicLater) out.push(`  同じ話題の後の記録：${dayOf(l.saidAt)} ${id(l.memoryId)}${l.status ? ` 「${l.status}」` : ""} ${l.summary}`);
    for (const l of p.keywordLater) out.push(`  候補（同じキーワード ${l.sharedKeywords.join("、")}。結果かどうかは未確認）：${dayOf(l.saidAt)} ${id(l.memoryId)}${l.status ? ` 「${l.status}」` : ""} ${l.summary}`);
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
