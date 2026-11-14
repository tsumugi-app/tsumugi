/**
 * Question purpose × record relevance (chat Retrieval only, `purposeRelevance`). Pure functions: no AI, no storage, no Memory is changed.
 *
 * 1. A record whose user's own words only asked the Memory back (every sentence of its evidenceQuotes is a recall question:
 *    「過去にどんな車がいいって言ったっけ？」) carries no answer. It is pushed back to at most one keyword hit, so it never crowds out a record that
 *    holds the answer, and it is still found when nothing else matches. A record with real content in another sentence is not pushed back.
 *    When the question asks about the user's questions themselves (「過去にどんな質問をしていた？」), question records come first instead.
 * 2. The purpose of a question about the past (a wish, a change, a view, a person's action, the questions themselves), read from its wording.
 *    Only a record already ON TOPIC (a keyword of it is in the question, it matches the recall topic, or it is about a person the question names)
 *    is moved by the purpose: up when the user's words or the summary say that kind of thing, back when the question asks for the user's own view
 *    but the record is mainly another person's action. A record that is not on topic is never raised. No purpose: the order is unchanged.
 * 3. A short trait for the chat AI (「過去の記録を尋ねただけ」「主に長男の行動」「本人の希望の言い回しがある」), from the wording only:
 *    an automatic hint, not the user's confirmed intent. AI-written reflections get none (P1-F already marks their source).
 * No topic, product or person name is written in this code.
 */
import { isQuestionFormTerm, isRecallQuestion, questionTopicRuns } from "./recallQuestion";

export type QuestionPurpose = "questions" | "wish" | "change" | "view" | "personAction";

export interface PurposeContext {
  purpose: QuestionPurpose | null;
  /** person names of the pool (as the user called them) that the question names */
  namedPersons: string[];
  /** the question names a topic besides asking about questions (「前に仕事について質問したことは？」): off-topic question records are not raised then */
  hasTopic: boolean;
}

/** what the facets read: the user's own words (evidenceQuotes), the AI summary, the people, the source */
export interface RelevanceSource {
  summary?: string;
  content?: string;
  keywords?: string[];
  evidenceQuotes?: string[];
  personMentions?: { displayName?: string }[];
  metadata?: { source?: string };
}

const norm = (text: string) => (text ?? "").normalize("NFKC");
const sentences = (text: string) => (norm(text).match(/[^。！？!?\n]+[。！？!?]*/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
const quoteSentences = (memory: RelevanceSource) => (memory.evidenceQuotes ?? []).filter((q): q is string => typeof q === "string").flatMap(sentences);
const HONORIFIC = /(?:さん|くん|君|ちゃん|様|氏)$/;
const personNames = (memory: RelevanceSource) =>
  [...new Set((memory.personMentions ?? []).map((p) => norm(typeof p?.displayName === "string" ? p.displayName : "").trim()).filter((n) => Array.from(n).length >= 2))];

/** a question (asked to the AI, not a statement) */
const INTERROGATIVE = /[?？]$|っけ[?？。]?$|かな[?？。]?$|かしら[?？。]?$|ですか[?？。]?$|ますか[?？。]?$|でしょうか[?？。]?$/;
/** a question about the past: a past form or a word pointing back (「最近」 alone is not: 「最近いい映画ある？」) */
const ASKS_PAST = /た(?:の|ん|っけ|か|かな)?[?？]?$|ていた|でいた|てた|でた|たっけ|過去|以前|前に|昔|これまで|今まで|当時/;
/** the user's own view asked back (「どう思っていた」「考えてた」); otherwise a view purpose needs a recall question (「どんな車がいいって言ったっけ？」), not 「最近いい映画あった？」 */
const VIEW_ASKED_BACK = /(?:思|考|感じ)(?:って|て)(?:い)?た/;
const ASKS_QUESTION_FORM = /[?？]|っけ|かな$|かしら|ですか|でしょうか|(?:もの|こと|の)は$/;

const PURPOSE_ASK: { purpose: Exclude<QuestionPurpose, "personAction">; ask: RegExp }[] = [
  { purpose: "questions", ask: /質問|尋ね/ },
  { purpose: "wish", ask: /望|願|ほしかっ|欲しかっ|してほし|たかった/ },
  { purpose: "change", ask: /変わ|変化|ようになっ|変え/ },
  { purpose: "view", ask: /どう思|思って|考えて|好き|嫌い|いい|良い|欲し|気に|選|どっち|どちら|評価|印象|感じ/ },
];
/** what the user's words or the summary say, per purpose */
const RECORD_SAYS: Record<"wish" | "change" | "view", RegExp> = {
  wish: /ほしい|欲しい|したい|てほしい|望|願|たい(?:と|。|$)/,
  change: /ようになっ|変わ|以前は|前は|ことにし|にした|やめ|始め/,
  view: /好き|嫌い|いい|良い|欲し|気にな|かな|迷|検討|重視|したい|ほしい|驚|思|感じ|考え/,
};

/** the purpose of the turn's question; null when it is not a question about the past or no purpose is clear (then nothing changes) */
export function purposeContextOf(text: string, pool: readonly RelevanceSource[]): PurposeContext {
  const t = norm(text).trim();
  const known = [...new Set(pool.flatMap(personNames))];
  const namedPersons = known.filter((name) => t.includes(name) || (HONORIFIC.test(name) && Array.from(name.replace(HONORIFIC, "")).length >= 2 && t.includes(name.replace(HONORIFIC, ""))));
  const hasTopic = namedPersons.length > 0 || questionTopicRuns(t).some((run) => !/質問|尋ね/.test(run));
  if (!t || !ASKS_QUESTION_FORM.test(t) || !ASKS_PAST.test(t)) return { purpose: null, namedPersons, hasTopic };
  const found = PURPOSE_ASK.find((p) => p.ask.test(t) && (p.purpose !== "view" || isRecallQuestion(t) || VIEW_ASKED_BACK.test(t)));
  if (found) return { purpose: found.purpose, namedPersons, hasTopic };
  return { purpose: namedPersons.length > 0 ? "personAction" : null, namedPersons, hasTopic };
}

/** every sentence of the user's own words asks the Memory back (no answer of its own). No quotes (older records): false, never pushed back */
export function isRecallOnlyRecord(memory: RelevanceSource): boolean {
  const s = quoteSentences(memory);
  return s.length > 0 && s.every((sentence) => isRecallQuestion(sentence));
}

/** every sentence of the user's own words is a question */
export function isQuestionRecord(memory: RelevanceSource): boolean {
  const s = quoteSentences(memory);
  return s.length > 0 && s.every((sentence) => INTERROGATIVE.test(sentence));
}

export const isReflectionSource = (memory: RelevanceSource) => memory.metadata?.source === "system-generated";

/** the person whose action the record is mainly about (its summary starts with 「Xが」「Xは」), or null */
export function actionPersonOf(memory: RelevanceSource): string | null {
  const summary = norm(memory.summary ?? "").trim();
  return personNames(memory).find((name) => summary.startsWith(`${name}が`) || summary.startsWith(`${name}は`)) ?? null;
}

const isAboutNamed = (memory: RelevanceSource, ctx: PurposeContext) => personNames(memory).some((name) => ctx.namedPersons.includes(name));
/** the user's own words (not the AI summary) say this kind of thing */
/** one text says a wish / a change / a view (the same wording the ranking reads; used by the Context Builder's diagnostics) */
export const textSaysPurpose = (text: string, purpose: "wish" | "change" | "view") => RECORD_SAYS[purpose].test(norm(text));
const quotesSay = (memory: RelevanceSource, purpose: "wish" | "change" | "view") => RECORD_SAYS[purpose].test(quoteSentences(memory).join(" "));
/**
 * pushed back as another person's action: the user's own view / wish / change was asked, the summary opens with another person (not named in the question),
 * and the user's own words do not say that kind of thing (「妻が車はGXがいいと言い、自分もそう思った」 keeps its place)
 */
function othersActionOnly(memory: RelevanceSource, ctx: PurposeContext): string | null {
  if (ctx.purpose !== "wish" && ctx.purpose !== "change" && ctx.purpose !== "view") return null;
  const actor = actionPersonOf(memory);
  if (!actor || ctx.namedPersons.includes(actor) || quotesSay(memory, ctx.purpose)) return null;
  return actor;
}
const saysPurpose = (memory: RelevanceSource, purpose: "wish" | "change" | "view") => RECORD_SAYS[purpose].test(norm(`${quoteSentences(memory).join(" ")} ${memory.summary ?? ""}`));

export interface PurposeAdjustment {
  /** the score after the adjustment (applied before the floor, the limit and the relative filter) */
  score: number;
  /** on topic for the purpose: a keyword hit, a recall topic match, a named person, or a question record when the questions are asked about */
  onTopic: boolean;
  /** pushed back (ranked after equal scores) */
  demoted: boolean;
}

/**
 * The adjustment of one candidate. `score` is the caller's score (analyst conversationScore / companion score); `topicMatched` the recall-topic match.
 * `weight` = one keyword hit, `floor` = the analyst minimum score. Pushing back caps at one keyword hit (= the floor), so a record that passed the floor still passes it.
 */
export function adjustForPurpose(memory: RelevanceSource, score: number, ctx: PurposeContext | null, questionText: string, topicMatched: boolean, weight: number, floor: number): PurposeAdjustment {
  if (!ctx) return { score, onTopic: topicMatched, demoted: false };
  const reflection = isReflectionSource(memory);
  if (!reflection && ctx.purpose !== "questions" && isRecallOnlyRecord(memory)) return { score: Math.min(score, weight), onTopic: topicMatched, demoted: true };
  // no purpose: nothing else changes (the on-topic test stays the recall-topic match, as before)
  if (!ctx.purpose) return { score, onTopic: topicMatched, demoted: false };
  // the same raw comparison as scoreMemory; a question-form word (過去・最近・自分…) as a keyword does not make a record on topic
  const keywordHit = (memory.keywords ?? []).some((k) => typeof k === "string" && k.trim().length > 0 && !isQuestionFormTerm(k.trim()) && (questionText ?? "").includes(k));
  const onTopic = topicMatched || keywordHit || isAboutNamed(memory, ctx);
  if (ctx.purpose === "questions") {
    // question records first; with a topic named (「前に仕事について質問したことは？」) only the on-topic ones
    if (!reflection && isQuestionRecord(memory) && (onTopic || !ctx.hasTopic)) return { score: Math.max(score, floor) + weight, onTopic: true, demoted: false };
    return { score, onTopic, demoted: false };
  }
  if (!onTopic || reflection || score <= 0) return { score, onTopic, demoted: false };
  if (ctx.purpose === "personAction") {
    const actor = actionPersonOf(memory);
    return actor && ctx.namedPersons.includes(actor) ? { score: score + weight, onTopic, demoted: false } : { score, onTopic, demoted: false };
  }
  // the user's own view / wish / change was asked: a record mainly about another person's action goes back
  if (othersActionOnly(memory, ctx)) return { score: Math.min(score, weight), onTopic, demoted: true };
  if (saysPurpose(memory, ctx.purpose)) return { score: score + weight, onTopic, demoted: false };
  return { score, onTopic, demoted: false };
}

/** the traits the chat AI may receive (a fixed set: the route accepts only these) */
export const RECORD_TRAITS = {
  recallOnly: "過去の記録を尋ねただけ（答えの内容は無い）",
  question: "本人が過去にした質問",
  wish: "本人の希望の言い回しがある",
  change: "考えの変化の言い回しがある",
} as const;
const ACTION_TRAIT = /^主に(.{1,20})の行動の記録$/;

/** a trait of a selected record for this turn, or undefined (AI reflections: none; one trait at most) */
export function recordTraitOf(memory: RelevanceSource, ctx: PurposeContext | null): string | undefined {
  if (!ctx || isReflectionSource(memory)) return undefined;
  if (ctx.purpose === "questions") return isQuestionRecord(memory) ? RECORD_TRAITS.question : undefined;
  if (isRecallOnlyRecord(memory)) return RECORD_TRAITS.recallOnly;
  if (!ctx.purpose) return undefined;
  // only where the record was pushed back for it
  const actor = othersActionOnly(memory, ctx);
  if (actor) return `主に${actor}の行動の記録`;
  if (ctx.purpose === "wish" && saysPurpose(memory, "wish")) return RECORD_TRAITS.wish;
  if (ctx.purpose === "change" && saysPurpose(memory, "change")) return RECORD_TRAITS.change;
  return undefined;
}

/** the route's check of a trait a client sent: only the fixed traits, or 「主にXの行動の記録」 where X is one of the record's (already checked) people */
export function isAllowedTrait(value: unknown, persons: readonly string[] = []): value is string {
  if (typeof value !== "string") return false;
  if ((Object.values(RECORD_TRAITS) as string[]).includes(value)) return true;
  const name = ACTION_TRAIT.exec(value)?.[1];
  return name !== undefined && persons.includes(name);
}
