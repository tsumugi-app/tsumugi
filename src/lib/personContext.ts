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
 * P1-C (choosing what fits the limits): each view is weighed by what it does (personStance.ts: a conclusion or a wish before a passing feeling or a
 * doubt; a description of a situation is never passed as a conclusion), not by being stated outright or by being recent; views are picked one by
 * one for diversity of time and content; a conclusion with the user's later explanation keeps it. A later explanation is linked only by a word that
 * tells something about THIS person (not a word also in the user's words about other people), and marked as a guess when Capture did not put both
 * in one topic. A plan the AI summary read into a question or a request to the AI, or into a look back, is not passed as a plan. A nameless record
 * needs such a word AND a structural link. `explainPersonContext` gives the debug page why each item was or was not passed.
 *
 * Names: a person is the name key of the sheet (honorific aside), joined only with names the user CONFIRMED as the same person (`aliases`). Similar names,
 * a guess by the sheet or a pronoun alone never join two people.
 */
import { buildPersonSheet, listSheetPersons, namesOf, personSheetKey, type PersonSheet, type SheetPlan } from "./personSheet";
import { classifyStatement, statementKey, statementSentences } from "./personStatement";
import { CORRECTION_FORM, REASON_FORM, stanceOf, STANCE_WEIGHT, type Stance } from "./personStance";
import { statusOf } from "./memorySynthesis";
import { personKeysInText } from "./retrieval";
import { PERSON_CONTEXT_LIMITS, type PersonContext, type PersonContextConclusion, type PersonContextKind, type PersonContextPlanType, type PersonContextStance, type PersonContextText } from "./personContextPrompt";
import { jstDateOf } from "./dateModel";
import type { MemoryObject } from "./types";

export type { PersonContext, PersonContextConclusion, PersonContextKind, PersonContextText } from "./personContextPrompt";
/** the day in Japan time, as the chat route shows the Memories (dateModel.ts) */
const dayOf = (iso: string) => (iso ? jstDateOf(iso) ?? "" : "");
const timeOf = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
/** content words: runs of kanji or katakana of two characters or more */
const contentWords = (text: string, exclude: string[]) => {
  const words = text.normalize("NFKC").match(/[一-鿿々]{2,}|[ァ-ヺー]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !exclude.some((x) => x.includes(w) || w.includes(x))))];
};
const shares = (a: string[], b: string[]) => a.some((w) => b.includes(w));
/** a sentence shorter than this (spaces and closing marks aside) says little on its own: it weighs a little less */
const SHORT_CHARS = 10;
/** a view below this weight is not passed (a short passing feeling or doubt) */
const MIN_WEIGHT = 1;

/** what the debug page shows of how the context was chosen (never sent to the chat) */
export interface PersonContextTrace {
  statements: { memoryId: string; text: string; stance: Stance; score: number; kept: boolean; why: string; linkedReasons?: string[] }[];
  plans: { memoryId: string; text: string; kind: PersonContextPlanType | "ask-ai" | "retrospective"; why: string }[];
  candidates: { memoryId: string; text: string; signals: string[]; accepted: boolean; why: string }[];
}

// a question or a request to the AI, and a look back, as the AI summary words them (the sentence that carries the plan's status word)
const ASK_AI_WORDS = /依頼|頼ん|頼み|質問|尋ね|聞いた|聞きたい|求め|整理|まとめ|教えて|AI|アシスタント/;
const LOOK_BACK_WORDS = /振り返|以前の|前に(?:言|話|考え)|当時の|過去の/;
/** what the user's words of the record say a plan is: a plan, a wish, or nothing (the AI summary's reading) */
// 行く / 会う only as the end of a clause about doing it (会うことはない / 会うたびに are not plans)
const PLAN_WORDS = /予約|申し込|予定|つもり|ことにした|ことにする|(?:行く|会う|行きます|会います)(?:予定|つもり|ことに|んだ|んです|けど|から|。|、|$)/;
/** inside a question or a request, only a plan TOLD before a clause break counts (来週会うんだけど、〜？); 「予定を整理してほしい」 asks about plans (Codex on PR #36) */
const PLAN_TOLD_IN_QUESTION = /(?:予約した|申し込んだ|予定|つもり|行く|会う|行きます|会います)(?:だ|です|なんだ|なんです|んだ|んです)?(?:けど|けれど|が[、,]|から[、,])/;

/**
 * P1-C: a plan of the sheet (a status word of the AI summary, or an event date later than the day said) as the context passes it:
 *   ask-ai         the user's words of the record only ask or request (the AI summary words a request as an intention), or ask and the
 *                  summary's plan sentence is about asking / sorting out → left out
 *   retrospective  a look back: the record tells of the past, or its plan sentence is about earlier thoughts → left out
 *   plan           the user's words state a plan, or the record has an event date later than the day said
 *   wish           the user's words state a wish (〜たい), not a plan
 *   summary        only the AI summary says it: passed as the summary's reading, not as the user's plan
 */
function planKindOf(p: SheetPlan, m: MemoryObject | undefined, mine: (memoryId: string, sentence: string) => boolean): { kind: PersonContextTrace["plans"][number]["kind"]; why: string } {
  const r = p.record;
  const userSentences = [
    ...r.mentionQuotes, ...r.evidence.filter((e) => !e.aboutOther),
    ...(m?.topicEvents ?? []).filter((e) => e.quote).map((e) => ({ text: e.quote, memoryId: r.memoryId })),
  ].flatMap((t) => statementSentences(t.text)).filter((s) => mine(r.memoryId, s));
  const roles = userSentences.map((s) => classifyStatement(s).role);
  const asks = roles.filter((x) => x === "question" || x === "request").length;
  const statusSentence = statementSentences(r.summary.text).find((s) => statusOf(s) !== undefined) ?? r.summary.text;
  // an event date later than the day said (as the sheet reads it), whether or not the summary also has a status word
  const ev = r.eventTime ? Date.parse(r.eventTime.length === 4 ? `${r.eventTime}-12-31` : r.eventTime.length === 7 ? `${r.eventTime}-28` : r.eventTime) : NaN;
  const futureEvent = p.why === "event-later-than-said" || (Number.isFinite(ev) && ev > timeOf(r.saidAt));
  const said = userSentences.filter((s, i) => roles[i] !== "question" && roles[i] !== "request");
  // a plan may be told inside a question too (来週会うんだけど、何を着ていけばいい？)
  const statesPlan = userSentences.some((s) => {
    const role = roles[userSentences.indexOf(s)];
    const t = s.normalize("NFKC").replace(/[。．.!！…\s]+$/, "");
    if (role === "question" || role === "request") return PLAN_TOLD_IN_QUESTION.test(t);
    return PLAN_WORDS.test(t) && stanceOf(s, role).stance !== "wish";
  });
  if (r.retrospective) return { kind: "retrospective", why: "過去の出来事を後から話した記録（振り返り）" };
  if (userSentences.length > 0 && asks === userSentences.length && !futureEvent && !statesPlan) return { kind: "ask-ai", why: "本人の発言がAIへの質問・依頼だけ（要約が依頼を意図として書いた）" };
  if (asks > 0 && ASK_AI_WORDS.test(statusSentence) && !statesPlan) return { kind: "ask-ai", why: "要約の予定の文がAIへの質問・依頼のこと" };
  if (LOOK_BACK_WORDS.test(statusSentence) && !futureEvent && !statesPlan) return { kind: "retrospective", why: "要約の予定の文が以前の考え・過去の振り返りのこと" };
  if (ASK_AI_WORDS.test(statusSentence) && userSentences.length === 0 && !futureEvent) return { kind: "ask-ai", why: "本人の発言が無く、要約の予定の文がAIへの依頼のこと" };
  if (statesPlan || futureEvent) return { kind: "plan", why: futureEvent ? "出来事の日付が話した日より後" : "本人の発言が予定を言っている" };
  if (said.some((s) => stanceOf(s, roles[userSentences.indexOf(s)]).stance === "wish")) return { kind: "wish", why: "本人の発言は希望（〜たい）で、予定とは言っていない" };
  return { kind: "summary", why: "予定と書いているのはAIの要約だけ" };
}

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
  return explainPersonContext(memories, key, options).context;
}

/** the person context and how it was chosen (the debug page shows both; the chat sends only the context) */
export function explainPersonContext(memories: MemoryObject[], key: string, options: PersonContextOptions = {}): { context: PersonContext; trace: PersonContextTrace } {
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
    // the duplicate occurrence of the same form keeps its own time (a mention or topic quote may be later than its record; a question with the same
    // words is another statement: Codex on PR #34)
    const key = statementKey(v.text.text);
    const alt = sheet.statements
      .filter((st) => st.text.kind === "user" && st.role === v.role && v.alsoIn.includes(st.text.memoryId) && statementKey(st.text.text) === key && eligible(st.text.memoryId, v.text.text))
      .sort((x, y) => timeOf(x.text.saidAt) - timeOf(y.text.saidAt))[0];
    return alt ? [{ ...v, text: { ...v.text, memoryId: alt.text.memoryId, saidAt: alt.text.saidAt } }] : [];
  }).sort((a, b) => timeOf(a.text.saidAt) - timeOf(b.text.saidAt));
  // records without any name that may be about this person (P1-C: stricter). A candidate needs a word of the person's own views that tells
  // something about THIS person (not a word that is also in the user's words about other people), AND a structural link: the same topic,
  // a Connect link, or the same conversation when that conversation is about no one else. One of the two alone is never enough.
  const onSheet = new Set(sheet.records.filter((r) => r.match === "mention").map((r) => r.memoryId));
  const named = sheet.records.filter((r) => r.match === "mention").map((r) => byId.get(r.memoryId)).filter((m): m is MemoryObject => m !== undefined);
  const convs = new Set(named.map((m) => m.conversationId).filter(Boolean));
  const topicsOf = (m: MemoryObject | undefined) => (m ? [m.topicId, ...(m.topicEvents ?? []).map((e) => e.topicId)].filter(Boolean) as string[] : []);
  const topics = new Set(named.flatMap(topicsOf));
  const namedIds = new Set(named.map((m) => m.id));
  // the records about other people (Capture recorded someone else, not this person)
  const othersRecords = pool.filter((m) => !recordOf.has(m.id) && namesOf(m).mention.length > 0);
  // a word the user uses about two other people or more says nothing about this one (one other person is not enough: an unconfirmed second
  // name of this person is "another person" to the sheet)
  const peopleByWord = new Map<string, Set<string>>();
  for (const m of othersRecords) {
    // a person with confirmed aliases is one person (Codex on PR #36)
    const who = [...new Set(namesOf(m).mention.map((n) => groupOf(personSheetKey(n), options.aliases ?? [])[0]))];
    for (const w of contentWords([...(m.personMentions ?? []).map((p) => p.quote ?? ""), ...(m.evidenceQuotes ?? [])].join(" "), nameWords)) {
      const set = peopleByWord.get(w) ?? new Set<string>();
      for (const k of who) set.add(k);
      peopleByWord.set(w, set);
    }
  }
  const genericWords = new Set([...peopleByWord].filter(([, people]) => people.size >= 2).map(([w]) => w));
  const telling = (words: string[]) => words.filter((w) => !genericWords.has(w));
  const wordsOf = (t: string) => telling(contentWords(t, nameWords));
  // a conversation that is also about someone else says little about whom a nameless record of it is about
  const mixedConvs = new Set([
    ...othersRecords.map((m) => m.conversationId),
    ...sheet.records.filter((r) => r.otherPersons.length > 0).map((r) => r.conversationId),
  ].filter(Boolean));
  const personWords = [...new Set(own.flatMap((v) => wordsOf(v.text.text)))];
  // a sentence of a record that also names other people counts for this person only when it names this person and no one else (Codex on PR #34)
  const aboutThisOne = (memoryId: string, sentence: string) => {
    const r = recordOf.get(memoryId);
    const n = namesIn(sentence);
    if (!r || r.otherPersons.length === 0) return !n.others || n.mine;
    return n.mine && !n.others;
  };
  const trace: PersonContextTrace = { statements: [], plans: [], candidates: [] };
  const candidates: PersonContext["candidates"] = [];
  const candidateSaidAt = new Map<string, string>();
  for (const m of pool) {
    if (onSheet.has(m.id)) continue;
    const n = namesOf(m);
    if (n.mention.length + n.keyword.length > 0) continue; // a record that names someone is that someone's (or the user's confirmed alias)
    const userSentences = (m.evidenceQuotes ?? []).flatMap(statementSentences)
      .filter((s) => fits(s) && ["judgment", "thought"].includes(classifyStatement(s).role) && stanceOf(s, classifyStatement(s).role).stance !== "situation");
    if (userSentences.length === 0) continue;
    const note = (why: string, signals: string[], accepted: boolean) => trace.candidates.push({ memoryId: m.id, text: userSentences[0], signals, accepted, why });
    // a record whose words name another known person is not taken for this one
    if (namesIn([m.summary ?? "", m.content ?? "", ...(m.evidenceQuotes ?? []), ...(m.topicEvents ?? []).map((e) => e.quote ?? "")].join(" ")).others) {
      if (m.conversationId && convs.has(m.conversationId)) note("ほかの人物の名前がある", [], false);
      continue;
    }
    const signals: string[] = [];
    const sameConv = Boolean(m.conversationId && convs.has(m.conversationId));
    if (sameConv && !mixedConvs.has(m.conversationId)) signals.push("同じ会話");
    if (topicsOf(m).some((t) => topics.has(t))) signals.push("同じ話題");
    if ((m.links ?? []).some((l) => namedIds.has(l.sourceId === m.id ? l.targetId : l.sourceId))
      || named.some((x) => (x.links ?? []).some((l) => (l.sourceId === m.id || l.targetId === m.id)))) signals.push("Connectのつながり");
    const structural = signals.length > 0;
    const sharedWords = wordsOf(userSentences.join(" ")).filter((w) => personWords.includes(w));
    if (sharedWords.length > 0) signals.push("共通の言葉");
    if (!structural && sharedWords.length === 0) {
      if (sameConv) note("同じ会話だが、ほかの人物の話もある会話で、共通の言葉も無い", signals, false);
      continue;
    }
    if (!structural) { note(sameConv ? "共通の言葉だけ（同じ会話だが、ほかの人物の話もある会話）" : "共通の言葉だけ（会話・話題・Connectのつながりが無い）", signals, false); continue; }
    if (sharedWords.length === 0) { note("会話・話題のつながりだけで、この人の話と分かる言葉が無い", signals, false); continue; }
    note(`候補にした（共通の言葉：${sharedWords.slice(0, 3).join("・")}）`, signals, true);
    const said = m.statedAt && Number.isFinite(Date.parse(m.statedAt)) ? m.statedAt : m.date;
    for (const s of userSentences) { candidates.push({ kind: "candidate", text: s, day: dayOf(said), memoryId: m.id, signals }); candidateSaidAt.set(m.id, said); }
  }
  const candidateIds = new Set(candidates.map((c) => c.memoryId));
  // conclusions and thoughts: the user's own views, and the conclusions and wishes of the candidate records without a name (marked as candidates)
  interface Source { kind: PersonContextKind; text: string; memoryId: string; saidAt: string; day: string; alsoDays: string[]; role: "judgment" | "thought"; stance: Stance; explains: boolean; words: string[] }
  const toSource = (kind: PersonContextKind, t: { text: string; memoryId: string; saidAt: string }, role: "judgment" | "thought", alsoDays: string[] = []): Source =>
    ({ kind, text: t.text, memoryId: t.memoryId, saidAt: t.saidAt, day: dayOf(t.saidAt), alsoDays, role, ...stanceOf(t.text, role), words: wordsOf(t.text) });
  const allSources: Source[] = [
    // the same words said again in another of the person's records count as coming back to it (the sheet keeps them in alsoIn: Codex on PR #36)
    ...own.map((v) => toSource("user", v.text, v.role, v.alsoIn.filter((id) => id !== v.text.memoryId && eligible(id, v.text.text)).map((id) => dayOf(recordOf.get(id)!.saidAt)))),
    ...candidates.map((c) => toSource("candidate", { text: c.text, memoryId: c.memoryId, saidAt: candidateSaidAt.get(c.memoryId) ?? "" }, classifyStatement(c.text).role === "judgment" ? "judgment" : "thought"))
      .filter((x) => x.stance === "decision" || x.stance === "wish"),
  ].sort((a, b) => timeOf(a.saidAt) - timeOf(b.saidAt));
  // a description of a situation is not a view (it is among the events): never passed as a conclusion
  for (const x of allSources.filter((s) => s.stance === "situation")) trace.statements.push({ memoryId: x.memoryId, text: x.text, stance: x.stance, score: 0, kept: false, why: "状況の説明なので、考え・結論には入れない" });
  const sources = allSources.filter((s) => s.stance !== "situation");
  const isReason = (x: Source) => x.explains && REASON_FORM.test(x.text);
  // the AI summaries of the records where Capture recorded the person; a candidate record's summary is read only for that candidate's own conclusion
  const summaries = [
    ...sheet.records.filter((r) => r.match === "mention").map((r) => r.summary),
    ...pool.filter((m) => candidateIds.has(m.id)).map((m) => ({ text: m.summary ?? "", memoryId: m.id, saidAt: m.statedAt && Number.isFinite(Date.parse(m.statedAt)) ? m.statedAt : m.date })),
  ].flatMap((r) => statementSentences(r.text).map((s) => ({ ...r, text: s }))).filter((s) => fits(s.text) && REASON_FORM.test(s.text) && aboutThisOne(s.memoryId, s.text))
    .map((s) => ({ ...s, words: wordsOf(s.text) }));
  // the user's later explanations: every sentence of the user's words in the person's records that gives a reason or corrects / explains what
  // was said, whatever its form (Codex on PR #34). Repeated words are made one per conclusion, after the time check
  const explanations = sheet.records.filter((r) => r.match === "mention")
    .flatMap((r) => [
      ...r.mentionQuotes, ...r.evidence.filter((e) => !e.aboutOther),
      // the topic quotes too, each with its own time (as the sheet reads them: Codex on PR #34)
      ...(byId.get(r.memoryId)?.topicEvents ?? []).filter((e) => e.quote).map((e) => ({ text: e.quote, memoryId: r.memoryId, saidAt: e.statedAt || r.saidAt, topicId: e.topicId })),
    ] as { text: string; memoryId: string; saidAt: string; topicId?: string }[])
    .flatMap((t) => statementSentences(t.text).map((sentence) => ({ ...t, text: sentence })))
    // a question or a request asks for a reason, it does not give one (Codex on PR #34)
    .filter((t) => fits(t.text) && (REASON_FORM.test(t.text) || CORRECTION_FORM.test(t.text)) && !["question", "request"].includes(classifyStatement(t.text).role) && eligible(t.memoryId, t.text) && aboutThisOne(t.memoryId, t.text))
    // the topic of the words themselves: a topic quote's own topic, otherwise the record's topic
    .map((t) => ({ text: t.text, memoryId: t.memoryId, saidAt: t.saidAt, words: wordsOf(t.text), topics: t.topicId ? [t.topicId] : byId.get(t.memoryId)?.topicId ? [byId.get(t.memoryId)!.topicId as string] : [] }));
  // a later explanation is linked to a conclusion, a wish or a view (not to a passing feeling or a doubt) only when it shares a word that tells
  // something about this person; the link is "topic" when Capture also put both records in one topic, otherwise only a guess from the words ("word")
  // the topic of the conclusion's own words, as for the explanations: the topic of the topic quote it was said in, otherwise the record's topic.
  // Not every topic the record was ever in (Capture UPDATE keeps older topic events while replacing topicId: Codex on PR #36)
  const ownTopicsOf = (memoryId: string, sentence: string): string[] => {
    const m = byId.get(memoryId);
    if (!m) return [];
    const key = statementKey(sentence);
    const fromQuotes = (m.topicEvents ?? []).filter((e) => e.quote && e.topicId && statementSentences(e.quote).some((q) => statementKey(q) === key)).map((e) => e.topicId as string);
    return fromQuotes.length > 0 ? fromQuotes : m.topicId ? [m.topicId] : [];
  };
  const linkable = (x: Source) => x.stance === "decision" || x.stance === "wish" || x.stance === "view";
  const all: PersonContextConclusion[] = sources.map((x) => {
    // situations are out of `sources`: the stance is one the payload knows
    const base = { statement: text(x.kind, x), role: x.role, stance: x.stance as PersonContextStance };
    const same = isReason(x) ? [{ ...text(x.kind, x), when: "same" as const }] : [];
    if (!linkable(x)) return { ...base, reasons: same, aiReadings: [] };
    const laterAll = explanations.filter((r) => statementKey(r.text) !== statementKey(x.text) && timeOf(r.saidAt) > timeOf(x.saidAt) && shares(r.words, x.words))
      .sort((p, q) => timeOf(p.saidAt) - timeOf(q.saidAt));
    // the same words said again after the conclusion: the latest occurrence (Codex on PR #34)
    const later = laterAll.filter((r, i) => !laterAll.slice(i + 1).some((q) => statementKey(q.text) === statementKey(r.text)));
    const xTopics = ownTopicsOf(x.memoryId, x.text);
    const aiReadings = x.role === "judgment" ? summaries.filter((s) => (!candidateIds.has(s.memoryId) || s.memoryId === x.memoryId) && shares(s.words, x.words)) : [];
    return {
      ...base,
      reasons: [
        ...same,
        ...later.slice(-L.maxReasonsPerConclusion).map((r) => ({
          ...text("user", r), when: "later" as const,
          link: r.topics.some((t) => xTopics.includes(t)) ? "topic" as const : "word" as const,
        })),
      ],
      aiReadings: aiReadings.slice(-L.maxAiReadingsPerConclusion).map((s) => text("summary", s)),
    };
  });
  // a view the user came back to on another day (a word that tells something about this person, said on two days or more)
  const sourceOf = new Map(all.map((c, i) => [c, sources[i]] as const));
  for (const c of all) {
    const x = sourceOf.get(c)!;
    if (x.kind === "user" && (x.alsoDays.some((d) => d !== x.day) || sources.some((y) => y !== x && y.kind === "user" && y.day !== x.day && shares(y.words, x.words)))) c.repeated = true;
  }
  // over the limit (a size bound): the weight of what the view does (personStance.ts), more for a view with the user's later explanation, one
  // the user came back to, and one that explains; less for a very short sentence and for a candidate. Picked one by one, a view of a month or of
  // words already picked weighs a little less (time and content diversity), so that many recent short words do not push out an older important one.
  // At equal weight the later statement goes first (as before). Then back to the order they were said.
  const idOf = (t: PersonContextText) => `${t.memoryId}:${statementKey(t.text)}`;
  const hasLater = (c: PersonContextConclusion) => c.reasons.some((r) => r.when === "later");
  const weightOf = (c: PersonContextConclusion) => {
    const x = sourceOf.get(c)!;
    return STANCE_WEIGHT[x.stance] + (hasLater(c) ? 2 : 0) + (c.repeated ? 1 : 0) + (x.explains ? 1 : 0)
      - (Array.from(statementKey(x.text)).length < SHORT_CHARS ? 1 : 0) - (x.kind === "candidate" ? 1 : 0);
  };
  const monthOf = (c: PersonContextConclusion) => c.statement.day.slice(0, 7);
  const picked: PersonContextConclusion[] = [];
  const dropped = new Map<PersonContextConclusion, string>();
  for (;;) {
    const covered = new Set(picked.flatMap((c) => c.reasons.filter((r) => r.when === "later").map(idOf)));
    // a statement shown as the later reason of a conclusion is not shown again on its own (also after the last pick: independent review)
    for (let i = picked.length - 1; i >= 0; i--) {
      if (covered.has(idOf(picked[i].statement)) && !hasLater(picked[i])) { dropped.set(picked[i], "別の結論の「後からの説明」として出した"); picked.splice(i, 1); }
    }
    if (picked.length >= L.maxConclusions) break;
    let best: PersonContextConclusion | undefined;
    let bestScore = -Infinity;
    for (const c of all) {
      if (picked.includes(c) || dropped.has(c) || weightOf(c) < MIN_WEIGHT) continue;
      if (covered.has(idOf(c.statement)) && !hasLater(c)) continue;
      const x = sourceOf.get(c)!;
      const s = weightOf(c) - 0.5 * picked.filter((p) => monthOf(p) === monthOf(c)).length - (picked.some((p) => shares(sourceOf.get(p)!.words, x.words)) ? 0.5 : 0);
      if (s > bestScore || (s === bestScore && best !== undefined && all.indexOf(c) > all.indexOf(best))) { best = c; bestScore = s; }
    }
    if (!best) break;
    picked.push(best);
  }
  const finalCovered = new Set(picked.flatMap((c) => c.reasons.filter((r) => r.when === "later").map(idOf)));
  const keptConclusions = picked.sort((a, b) => all.indexOf(a) - all.indexOf(b));
  // one later explanation is shown under one conclusion only: the user's own words before a candidate, a shared topic before shared words, then
  // the earlier conclusion
  const rankOf = (c: PersonContextConclusion, r: PersonContextConclusion["reasons"][number]) => (c.statement.kind === "user" ? 0 : 2) + (r.link === "topic" ? 0 : 1);
  const ownerOf = new Map<string, { c: PersonContextConclusion; rank: number }>();
  for (const c of keptConclusions) {
    for (const r of c.reasons) {
      if (r.when !== "later") continue;
      const cur = ownerOf.get(idOf(r));
      if (!cur || rankOf(c, r) < cur.rank) ownerOf.set(idOf(r), { c, rank: rankOf(c, r) });
    }
  }
  for (const c of keptConclusions) c.reasons = c.reasons.filter((r) => r.when !== "later" || ownerOf.get(idOf(r))?.c === c);
  for (const c of all) {
    const x = sourceOf.get(c)!;
    const kept = keptConclusions.includes(c);
    const why = kept ? "背景に入れた"
      : dropped.get(c) ?? (finalCovered.has(idOf(c.statement)) ? "別の結論の「後からの説明」として出した"
        : weightOf(c) < MIN_WEIGHT ? "短い一時的な気持ち・迷いなので入れない" : "件数の上限（より重いもの・時期や内容の違うものを先に入れた）");
    trace.statements.push({ memoryId: c.statement.memoryId, text: c.statement.text, stance: x.stance, score: weightOf(c), kept, why, ...(hasLater(c) ? { linkedReasons: c.reasons.filter((r) => r.when === "later").map((r) => r.memoryId) } : {}) });
  }
  const conclusionCandidateTexts = new Set(keptConclusions.filter((c) => c.statement.kind === "candidate").map((c) => idOf(c.statement)));

  const given = new Set(options.alreadyGivenIds ?? []);
  // plans (P1-C): only of records where Capture recorded this person (Codex on PR #34); a status word of the AI summary is not enough to pass a
  // plan: a question or a request to the AI, or a look back at the past, is left out; a wish is passed as a wish; a plan the user's words never
  // state is passed as the AI summary's reading only
  const plans = sheet.plans.filter((p) => p.record.match === "mention" && !given.has(p.record.memoryId) && fits(p.record.summary.text)).flatMap((p) => {
    const kind = planKindOf(p, byId.get(p.record.memoryId), (id, s) => eligible(id, s) && aboutThisOne(id, s));
    trace.plans.push({ memoryId: p.record.memoryId, text: p.record.summary.text, kind: kind.kind, why: kind.why });
    if (kind.kind === "ask-ai" || kind.kind === "retrospective") return [];
    return [{
      plan: text("summary", p.record.summary),
      type: kind.kind,
      ...(p.outcome && fits(p.outcome.summary) ? { outcome: { kind: "summary" as const, text: p.outcome.summary, day: dayOf(p.outcome.saidAt), memoryId: p.outcome.memoryId, status: p.outcome.status } } : {}),
    }];
  }).slice(-L.maxPlans);

  // a record that only asked or requested something of the AI is not an event of this person either
  const askedAi = new Set(trace.plans.filter((p) => p.kind === "ask-ai").map((p) => p.memoryId));
  const events = sheet.records.filter((r) => r.match === "mention" && !given.has(r.memoryId) && !askedAi.has(r.memoryId) && fits(r.summary.text)).slice(-L.maxEvents).map((r) => text("summary", r.summary));
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
  return { context, trace };
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

