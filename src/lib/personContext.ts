/**
 * Memory Graph P1-A: the person context for the chat (trial, default OFF: memoryGraphFlag.ts). Built on the device from the saved Memories with the person
 * sheet (personSheet.ts), every time, for the people the user is talking about in this turn. Nothing is stored, no Memory is changed and no AI is called.
 *
 * What it gives the chat, each item tied to its Memory and its kind (本人の発言 / AIの要約 / 候補):
 *   - the relation (Capture's category, with the user's words it rests on)
 *   - past conclusions and thoughts in the user's own words (statement forms: personStatement.ts), oldest first
 *   - REASONS the user gave for a conclusion: in the same sentence, or LATER (後から本人が説明した理由). A later explanation is linked to an earlier
 *     conclusion only when it shares a content word with it (kanji / katakana words, never a fixed list); it is shown next to it, and the earlier words
 *     stay: a newer record does not erase an older one. AI summaries that read a reason into the conclusion are shown apart, as the AI's reading.
 *   - plans and their outcome candidates (personSheet.ts rule), recent events, the last record that can be confirmed (with its date, never "now")
 *   - records WITHOUT a name that may be about the person (candidates): only when two kinds of evidence meet (same conversation, same topic, a Connect link,
 *     a shared content word); one weak link is not enough. They are always marked as candidates.
 *
 * Names: a person is the name key of the sheet (honorific aside), joined only with names the user CONFIRMED as the same person (`aliases`). Similar names,
 * a guess by the sheet or a pronoun alone never join two people.
 */
import { buildPersonSheet, listSheetPersons, namesOf, personSheetKey, type PersonSheet } from "./personSheet";
import { classifyStatement, statementKey, statementSentences } from "./personStatement";
import { personKeysInText } from "./retrieval";
import { PERSON_CONTEXT_LIMITS, type PersonContext, type PersonContextConclusion, type PersonContextKind, type PersonContextText } from "./personContextPrompt";
import { jstDateOf } from "./dateModel";
import type { MemoryObject } from "./types";

export type { PersonContext, PersonContextConclusion, PersonContextKind, PersonContextText } from "./personContextPrompt";
/** the day in Japan time, as the chat route shows the Memories (dateModel.ts) */
const dayOf = (iso: string) => (iso ? jstDateOf(iso) ?? "" : "");
const timeOf = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
/**
 * a reason given in the sentence: だから / 〜いから、/ 〜たので / 〜のため、/ なぜなら / 理由は. Only the forms that join a reason to what follows:
 * から as "from" (来週から / 彼から) and ため inside a word (あらためて) are not reasons (independent review)
 */
const REASON_FORM = /だから|ですから|(?:い|た|る|ない)から[、,]|(?:な|だ|た|る|い)ので|(?:の|る|た|い)ため[、,にだ]|なぜなら|理由は|理由として|せいで|おかげで/;
/** content words: runs of kanji or katakana of two characters or more */
const contentWords = (text: string, exclude: string[]) => {
  const words = text.normalize("NFKC").match(/[一-鿿々]{2,}|[ァ-ヺー]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !exclude.some((x) => x.includes(w) || w.includes(x))))];
};
const shares = (a: string[], b: string[]) => a.some((w) => b.includes(w));

/** the confirmed alias group of a key, in the order the user gave it (the key itself when it has none): the first name stands for the group */
function groupOf(key: string, aliases: string[][]): string[] {
  const group = aliases.find((g) => g.map(personSheetKey).includes(key));
  return group ? [...new Set(group.map(personSheetKey))] : [key];
}

/**
 * the people of this turn: named in the user's latest words, or (only when the latest words name no one) named in the last few user turns.
 * Names are the sheet's keys of two characters or more and the user's confirmed aliases; a confirmed group counts once.
 */
export function personsForTurn(memories: MemoryObject[], latest: string, earlierUserTurns: string[], aliases: string[][] = []): string[] {
  const keys = [...new Set([...listSheetPersons(memories).map((p) => p.key), ...aliases.flat().map(personSheetKey)])].filter((k) => Array.from(k).length >= 2);
  const canonical = (k: string) => groupOf(k, aliases)[0];
  const found = (text: string) => [...new Set(personKeysInText(text, keys).map(canonical))];
  const now = found(latest);
  if (now.length > 0) return now.slice(0, PERSON_CONTEXT_LIMITS.maxPersons);
  for (const turn of earlierUserTurns.slice(-PERSON_CONTEXT_LIMITS.carryTurns).reverse()) {
    const carried = found(turn);
    if (carried.length > 0) return carried.slice(0, PERSON_CONTEXT_LIMITS.maxPersons);
  }
  return [];
}

export interface PersonContextOptions {
  /** names the user confirmed as one person (P1-B stores them in the Vault; until then the debug page passes its own) */
  aliases?: string[][];
  /** Memories of the conversation in progress are left out (as Retrieval does) */
  excludeConversationId?: string;
  /** Memories the normal Retrieval already gives this turn: not repeated as events */
  alreadyGivenIds?: string[];
}

export function buildPersonContext(memories: MemoryObject[], key: string, options: PersonContextOptions = {}): PersonContext {
  const pool = memories.filter((m) => !(options.excludeConversationId && m.conversationId === options.excludeConversationId));
  const group = groupOf(key, options.aliases ?? []);
  const sheet: PersonSheet = buildPersonSheet(pool, group[0], { withKeys: group.slice(1), lite: true });
  const L = PERSON_CONTEXT_LIMITS;
  const fits = (t: string) => t.length > 0 && t.length <= L.maxTextChars;
  const nameWords = [...sheet.keys, ...sheet.names];
  const text = (kind: PersonContextKind, t: { text: string; memoryId: string; saidAt: string }): PersonContextText => ({ kind, text: t.text, day: dayOf(t.saidAt), memoryId: t.memoryId });

  // the user's own views, oldest first: only from records where Capture recorded this person (a keyword or a name in the text is not enough), and,
  // when the record also names other people, only the sentences that name this person (independent review)
  // every other known name, one character too (妻 / 母), as the sheet does
  const otherNameKeys = listSheetPersons(pool).map((p) => p.key).filter((k) => !sheet.keys.includes(k));
  // the names in a text, this person's and the others' matched TOGETHER, the longest first (さき inside まさきさん is not さき: Codex on PR #34)
  const namesIn = (text: string) => {
    const found = personKeysInText(text, [...sheet.keys, ...otherNameKeys]);
    return { mine: found.some((k) => sheet.keys.includes(k)), others: found.some((k) => !sheet.keys.includes(k)) };
  };
  const recordOf = new Map(sheet.records.map((r) => [r.memoryId, r] as const));
  const byId = new Map(pool.map((m) => [m.id, m] as const));
  const eligible = (id: string, sentence: string) => {
    const r = recordOf.get(id);
    return r?.match === "mention" && (r.otherPersons.length === 0 || namesIn(sentence).mine);
  };
  // the sheet shows the same words once (the earliest record, the others in alsoIn): take the earliest record that is eligible (Codex on PR #34)
  const own = sheet.views.flatMap((v) => {
    if (v.text.kind !== "user" || v.aboutOther || !fits(v.text.text)) return [];
    if (eligible(v.text.memoryId, v.text.text)) return [v];
    const alt = v.alsoIn.map((id) => recordOf.get(id)).filter((r) => r !== undefined && eligible(r.memoryId, v.text.text))
      .sort((x, y) => timeOf(x!.saidAt) - timeOf(y!.saidAt))[0];
    return alt ? [{ ...v, text: { ...v.text, memoryId: alt.memoryId, saidAt: alt.saidAt } }] : [];
  }).sort((a, b) => timeOf(a.text.saidAt) - timeOf(b.text.saidAt));
  // records without any name that may be about this person: two kinds of evidence must meet
  const onSheet = new Set(sheet.records.filter((r) => r.match === "mention").map((r) => r.memoryId));
  const named = sheet.records.filter((r) => r.match === "mention").map((r) => byId.get(r.memoryId)).filter((m): m is MemoryObject => m !== undefined);
  const convs = new Set(named.map((m) => m.conversationId).filter(Boolean));
  const topicsOf = (m: MemoryObject) => [m.topicId, ...(m.topicEvents ?? []).map((e) => e.topicId)].filter(Boolean) as string[];
  const topics = new Set(named.flatMap(topicsOf));
  const namedIds = new Set(named.map((m) => m.id));
  const personWords = [...new Set(own.flatMap((v) => contentWords(v.text.text, nameWords)))];
  // a sentence of a record that also names other people counts for this person only when it names this person and no one else (Codex on PR #34)
  const aboutThisOne = (memoryId: string, sentence: string) => {
    const r = recordOf.get(memoryId);
    const n = namesIn(sentence);
    if (!r || r.otherPersons.length === 0) return !n.others || n.mine;
    return n.mine && !n.others;
  };
  const candidates: PersonContext["candidates"] = [];
  const candidateSaidAt = new Map<string, string>();
  for (const m of pool) {
    if (onSheet.has(m.id)) continue;
    const n = namesOf(m);
    if (n.mention.length + n.keyword.length > 0) continue; // a record that names someone is that someone's (or the user's confirmed alias)
    // a record whose words name another known person is not taken for this one
    if (namesIn([m.summary ?? "", m.content ?? "", ...(m.evidenceQuotes ?? []), ...(m.topicEvents ?? []).map((e) => e.quote ?? "")].join(" ")).others) continue;
    const userSentences = (m.evidenceQuotes ?? []).flatMap(statementSentences).filter((s) => fits(s) && ["judgment", "thought"].includes(classifyStatement(s).role));
    if (userSentences.length === 0) continue;
    const signals: string[] = [];
    if (m.conversationId && convs.has(m.conversationId)) signals.push("同じ会話");
    if (topicsOf(m).some((t) => topics.has(t))) signals.push("同じ話題");
    if ((m.links ?? []).some((l) => namedIds.has(l.sourceId === m.id ? l.targetId : l.sourceId))
      || named.some((x) => (x.links ?? []).some((l) => (l.sourceId === m.id || l.targetId === m.id)))) signals.push("Connectのつながり");
    const strong = signals.length > 0;
    if (shares(contentWords(userSentences.join(" "), nameWords), personWords)) signals.push("共通の言葉");
    if (!strong || signals.length < 2) continue;
    const said = m.statedAt && Number.isFinite(Date.parse(m.statedAt)) ? m.statedAt : m.date;
    for (const s of userSentences) { candidates.push({ kind: "candidate", text: s, day: dayOf(said), memoryId: m.id, signals }); candidateSaidAt.set(m.id, said); }
  }
  const candidateIds = new Set(candidates.map((c) => c.memoryId));
  // conclusions and thoughts: the user's own views, and the judgments of the candidate records without a name (marked as candidates)
  interface Source { kind: PersonContextKind; text: string; memoryId: string; saidAt: string; role: "judgment" | "thought"; words: string[] }
  const sources: Source[] = [
    ...own.map((v): Source => ({ kind: "user", text: v.text.text, memoryId: v.text.memoryId, saidAt: v.text.saidAt, role: v.role, words: contentWords(v.text.text, nameWords) })),
    ...candidates.filter((c) => classifyStatement(c.text).role === "judgment")
      .map((c): Source => ({ kind: "candidate", text: c.text, memoryId: c.memoryId, saidAt: candidateSaidAt.get(c.memoryId) ?? "", role: "judgment", words: contentWords(c.text, nameWords) })),
  ].sort((a, b) => timeOf(a.saidAt) - timeOf(b.saidAt));
  const isReason = (x: Source) => REASON_FORM.test(x.text);
  // the AI summaries of the records where Capture recorded the person; a candidate record's summary is read only for that candidate's own conclusion
  const summaries = [
    ...sheet.records.filter((r) => r.match === "mention").map((r) => r.summary),
    ...pool.filter((m) => candidateIds.has(m.id)).map((m) => ({ text: m.summary ?? "", memoryId: m.id, saidAt: m.statedAt && Number.isFinite(Date.parse(m.statedAt)) ? m.statedAt : m.date })),
  ].flatMap((r) => statementSentences(r.text).map((s) => ({ ...r, text: s }))).filter((s) => fits(s.text) && REASON_FORM.test(s.text) && aboutThisOne(s.memoryId, s.text))
    .map((s) => ({ ...s, words: contentWords(s.text, nameWords) }));
  // the user's later explanations: every sentence of the user's words in the person's records that gives a reason, whatever its form (an
  // explanation like 「〜理由は、〜だから。」 is not a view of its own: Codex on PR #34). Repeated words are made one per conclusion, after the time check
  const explanations = sheet.records.filter((r) => r.match === "mention")
    .flatMap((r) => [
      ...r.mentionQuotes, ...r.evidence.filter((e) => !e.aboutOther),
      // the topic quotes too, each with its own time (as the sheet reads them: Codex on PR #34)
      ...(byId.get(r.memoryId)?.topicEvents ?? []).filter((e) => e.quote).map((e) => ({ text: e.quote, memoryId: r.memoryId, saidAt: e.statedAt || r.saidAt })),
    ])
    .flatMap((t) => statementSentences(t.text).map((sentence) => ({ ...t, text: sentence })))
    // a question or a request asks for a reason, it does not give one (Codex on PR #34)
    .filter((t) => fits(t.text) && REASON_FORM.test(t.text) && !["question", "request"].includes(classifyStatement(t.text).role) && eligible(t.memoryId, t.text) && aboutThisOne(t.memoryId, t.text))
    .map((t) => ({ text: t.text, memoryId: t.memoryId, saidAt: t.saidAt, words: contentWords(t.text, nameWords) }));
  const all: PersonContextConclusion[] = sources.map((x) => {
    if (x.role === "thought") return { statement: text(x.kind, x), role: "thought", reasons: isReason(x) ? [{ ...text(x.kind, x), when: "same" as const }] : [], aiReadings: [] };
    // a later explanation is the user's own words only, said after the conclusion, giving a reason, and sharing a content word with it
    const laterAll = explanations.filter((r) => statementKey(r.text) !== statementKey(x.text) && timeOf(r.saidAt) > timeOf(x.saidAt) && shares(r.words, x.words))
      .sort((p, q) => timeOf(p.saidAt) - timeOf(q.saidAt));
    // the same words said again after the conclusion: the latest occurrence (Codex on PR #34)
    const later = laterAll.filter((r, i) => !laterAll.slice(i + 1).some((q) => statementKey(q.text) === statementKey(r.text)));
    const aiReadings = summaries.filter((s) => (!candidateIds.has(s.memoryId) || s.memoryId === x.memoryId) && shares(s.words, x.words));
    return {
      statement: text(x.kind, x),
      role: "judgment",
      reasons: [
        ...(isReason(x) ? [{ ...text(x.kind, x), when: "same" as const }] : []),
        ...later.slice(-L.maxReasonsPerConclusion).map((r) => ({ ...text("user", r), when: "later" as const })),
      ],
      aiReadings: aiReadings.slice(-L.maxAiReadingsPerConclusion).map((s) => text("summary", s)),
    };
  });
  // a statement shown as the later reason of a conclusion is not shown again on its own
  const idOf = (t: PersonContextText) => `${t.memoryId}:${statementKey(t.text)}`;
  const hasLater = (c: PersonContextConclusion) => c.reasons.some((r) => r.when === "later");
  const shownAsLater = new Set(all.flatMap((c) => c.reasons.filter((r) => r.when === "later").map(idOf)));
  const rank = (c: PersonContextConclusion) => (hasLater(c) ? 0 : c.role === "judgment" ? 1 : 2);
  // over the limit (a size bound, not a judgment of which words count): a conclusion with the user's later reason first (its reason is shown only
  // under it), then the other conclusions, then thoughts, the latest first; then back to the order they were said
  const keptConclusions = all
    .filter((c) => !shownAsLater.has(idOf(c.statement)) || hasLater(c))
    // `all` is oldest first by the full time said: the later index is the later statement, also within one day (Codex on PR #34)
    .sort((a, b) => rank(a) - rank(b) || all.indexOf(b) - all.indexOf(a))
    .slice(0, L.maxConclusions)
    .sort((a, b) => all.indexOf(a) - all.indexOf(b));
  const conclusionCandidateTexts = new Set(keptConclusions.filter((c) => c.statement.kind === "candidate").map((c) => idOf(c.statement)));

  const given = new Set(options.alreadyGivenIds ?? []);
  // a plan whose record Retrieval already gives this turn is not repeated
  // only plans of records where Capture recorded this person (a passing mention in the text is someone else's plan: Codex on PR #34)
  const plans = sheet.plans.filter((p) => p.record.match === "mention" && !given.has(p.record.memoryId) && fits(p.record.summary.text)).slice(-L.maxPlans).map((p) => ({
    plan: text("summary", p.record.summary),
    ...(p.outcome && fits(p.outcome.summary) ? { outcome: { kind: "summary" as const, text: p.outcome.summary, day: dayOf(p.outcome.saidAt), memoryId: p.outcome.memoryId, status: p.outcome.status } } : {}),
  }));

  const events = sheet.records.filter((r) => r.match === "mention" && !given.has(r.memoryId) && fits(r.summary.text)).slice(-L.maxEvents).map((r) => text("summary", r.summary));

  const keptCandidates = candidates.filter((c) => !conclusionCandidateTexts.has(`${c.memoryId}:${statementKey(c.text)}`)).sort((a, b) => b.signals.length - a.signals.length || timeOf(b.day) - timeOf(a.day)).slice(0, L.maxCandidates);

  const relation = sheet.overview.relation;
  const basis = relation?.basis[relation.basis.length - 1];
  const context: PersonContext = {
    key: sheet.key,
    names: sheet.names.length > 0 ? sheet.names : [sheet.key],
    ...(relation ? { relation: { label: relation.label, ...(basis && fits(basis.text) ? { basis: text("user", basis) } : {}) } } : {}),
    conclusions: keptConclusions,
    plans,
    events,

    candidates: keptCandidates,
    memoryIds: [],
  };
  context.memoryIds = [...new Set([
    ...(context.relation?.basis ? [context.relation.basis.memoryId] : []),
    ...context.conclusions.flatMap((c) => [c.statement.memoryId, ...c.reasons.map((r) => r.memoryId), ...c.aiReadings.map((r) => r.memoryId)]),
    ...context.plans.flatMap((p) => [p.plan.memoryId, ...(p.outcome ? [p.outcome.memoryId] : [])]),
    ...context.events.map((e) => e.memoryId),
    ...context.candidates.map((c) => c.memoryId),
  ])];
  // the last day the records reach: the person's records and every statement shown (a quote may carry its own, later time: Codex on PR #34)
  const days = [
    ...(sheet.overview.lastSaidAt ? [dayOf(sheet.overview.lastSaidAt)] : []),
    ...context.conclusions.flatMap((c) => [c.statement.day, ...c.reasons.map((r) => r.day), ...c.aiReadings.map((r) => r.day)]),
    ...context.plans.flatMap((p) => [p.plan.day, ...(p.outcome ? [p.outcome.day] : [])]),
    ...context.events.map((e) => e.day),
    ...context.candidates.map((c) => c.day),
  ].filter(Boolean).sort();
  if (days.length > 0) context.lastDay = days[days.length - 1];
  return context;
}

/** the PersonView entries of people the person context already covers are not sent twice (the context carries their relation) */
export function withoutCoveredPersonViews<T extends { displayName: string }>(views: T[] | null, contexts: PersonContext[]): T[] | null {
  if (!views || contexts.length === 0) return views;
  try {
    const covered = new Set(contexts.flatMap((c) => [c.key, ...c.names.map(personSheetKey)]));
    const left = views.filter((v) => !covered.has(personSheetKey(String(v.displayName ?? ""))));
    return left.length > 0 ? left : null;
  } catch {
    return views;
  }
}

/** the person contexts of this turn (empty when the user is not talking about anyone known); never throws */
export function selectPersonContextsForTurn(
  memories: MemoryObject[],
  turn: { userText: string; earlierUserTurns: string[]; excludeConversationId?: string; alreadyGivenIds?: string[]; aliases?: string[][] }
): PersonContext[] {
  try {
    const keys = personsForTurn(memories, turn.userText, turn.earlierUserTurns, turn.aliases ?? []);
    return keys.map((key) => buildPersonContext(memories, key, { aliases: turn.aliases, excludeConversationId: turn.excludeConversationId, alreadyGivenIds: turn.alreadyGivenIds }))
      .filter((c) => c.memoryIds.length > 0 || c.relation);
  } catch {
    return [];
  }
}

