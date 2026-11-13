/**
 * Recall questions: the user asks what they themselves said, thought or did before (「過去にどんな車がいいって言ったっけ？」).
 * Pure functions, no AI, no storage. Used only by the chat (Retrieval with `recallTopic`, the Memory Timeline theme choice, the chat prompt).
 *
 * The TOPIC of such a question is what is left of its kanji / katakana / latin runs after the words that only shape the question
 * (過去・以前・前・言…) and the single-kanji stems of verbs and adjectives (好き・決めた…). Matching the topic with a Memory is by those runs too,
 * so a topic matches the same word and longer words that start with it, without a synonym list and without naming any topic in the code.
 */

/** words that only shape a question about the past (when, asked how), never its topic */
export const QUESTION_FORM_TERMS: ReadonlySet<string> = new Set([
  "過去", "以前", "前", "前回", "昔", "今", "今回", "今日", "昨日", "最近", "当時", "最初", "最後", "一番", "名前",
  "話", "言", "何", "事", "時", "頃", "方", "自分", "私", "僕", "俺", "思", "考", "気", "感", "感じ", "結局", "覚", "教",
]);

/** single kanji that are a stem of a common adjective or a direction more often than a topic (「新しい」「大きい」「上の」): not a topic on their own */
const SINGLE_KANJI_NOT_TOPIC: ReadonlySet<string> = new Set(["新", "大", "小", "高", "低", "長", "短", "多", "少", "早", "遅", "良", "悪", "古", "近", "遠", "強", "弱", "上", "下", "中", "外", "内", "後", "先", "次", "全", "同", "別", "他", "楽", "辛", "嫌", "見", "行", "来", "出", "入", "使", "持", "聞", "食", "飲", "書", "読", "買", "会"]);

/** a word that only shapes a question about the past (also used by the Memory Timeline theme choice) */
export function isQuestionFormTerm(term: string): boolean {
  return QUESTION_FORM_TERMS.has(term);
}

/** not a topic of a recall question: a question-form word, or a single kanji that is rarely a topic alone */
const isNotTopic = (term: string) => QUESTION_FORM_TERMS.has(term) || SINGLE_KANJI_NOT_TOPIC.has(term);

const RUNS = /[一-鿿々]+|[ァ-ヺー]{2,}|[A-Za-z0-9]{2,}/g;
const runsOf = (text: string): string[] => text.normalize("NFKC").match(RUNS) ?? [];
const isSingleKanji = (run: string) => Array.from(run).length === 1 && /[一-鿿々]/.test(run);
/** hiragana right after a single kanji that is NOT a particle: the kanji is the stem of a verb or adjective (好き・決めた・欲しい), not a noun (車が・本を) */
const STEM_FOLLOWER = /^[ぁ-ゖ]/;
const PARTICLE_FOLLOWER = /^(?:の|が|を|は|に|で|と|も|へ|や|か|っ)/;

/** the question's own runs that can be its topic (also used by recordRelevance.ts, for any question about the past) */
export function questionTopicRuns(text: string): string[] {
  const t = text.normalize("NFKC");
  const out: string[] = [];
  for (const m of t.matchAll(RUNS)) {
    const run = m[0];
    if (isNotTopic(run)) continue;
    const after = t.slice((m.index ?? 0) + run.length);
    if (isSingleKanji(run) && STEM_FOLLOWER.test(after) && !PARTICLE_FOLLOWER.test(after)) continue;
    out.push(run);
  }
  return [...new Set(out)];
}

/** pointing back at the user's own earlier words or days (「前に」 only on its own: not 名前は・目の前に・事前に・寝る前に) */
const RECALL_ANCHOR = /過去|以前|(?<![名目事直手寝る午最生戦建空以食])前(?:に|は|回)|昔|これまで|今まで|この前|当時/;
/** what the user said / thought / did, asked back (「言ったっけ」「話をしたっけ」「考えてた」); 「だっけ」 alone (「何メートルだっけ」) is not */
const RECALL_VERB = /言っ|言わ|話し|話さ|話を|思っ|考え|書い|決め|選ん|たっけ|てた|ていた/;
/** a question (「かな」 only at the end: not 「かなり」) */
const QUESTION = /[?？]|っけ|かな[?？。!！]?$|かしら|でしょうか|ですか/;

/** the asker themself (「私は前に何て言った？」): the question is about the user even with another word marked as its subject */
const FIRST_PERSON = /私|僕|俺|自分|わたし|ぼく|おれ|あたし/;
/** 「昔の人」「過去の出来事」: the anchor describes the world's past, not the user's (「以前の会話」「過去の自分」 still point at the user) */
const ATTRIBUTIVE_ANCHOR = /(?:過去|以前|昔|当時)の(?!私|僕|俺|自分|わたし|ぼく|おれ|会話|話|記録|日記|メモ)/g;
/** a run that names a time, not an actor (「先週は」「去年は」「この間は」) */
const TIME_RUN = /(?:週|月|年|日|朝|昼|夜|晩|頃|時|間|前|後|昔|去|今)$/;
/** a quotation in front of the verb (「〜がいいって言った」「〜と思った」): the marked word is inside what was said, the speaker is left unsaid (the user) */
const QUOTE = /って|と(?:言|話|思|考|書|決)/;
/** only an interrogative is quoted (「何て言った」「どう思った」): the marked word is the one who said it */
const INTERROGATIVE_QUOTE = /^(?:何|なに|なん|どう)(?:って|て|と)?/;

/**
 * The question names someone or something else as the one who said or did it (「ニュートンは何て言ったっけ？」「昔の人は何を食べてた？」):
 * a word marked with は／が whose clause has no quotation of its own (or quotes only an interrogative), when nothing before it is the user's own words
 * (「前に話した本はどうだったっけ？」 is about the user) and the asker does not name themself.
 */
function hasOtherActor(t: string): boolean {
  if (FIRST_PERSON.test(t)) return false;
  for (const m of t.matchAll(/([一-鿿々]+|[ァ-ヺー]{2,}|[A-Za-z]{2,})(は|が)/g)) {
    const run = m[1];
    if (QUESTION_FORM_TERMS.has(run) || TIME_RUN.test(run)) continue;
    const start = m.index ?? 0;
    if (RECALL_VERB.test(t.slice(0, start))) return false;
    const rest = t.slice(start + m[0].length);
    if (INTERROGATIVE_QUOTE.test(rest) || !QUOTE.test(rest)) return true;
    return false;
  }
  return false;
}

export function isRecallQuestion(text: string): boolean {
  const t = (text ?? "").normalize("NFKC").trim();
  if (!t || !QUESTION.test(t) || !RECALL_VERB.test(t)) return false;
  if (hasOtherActor(t)) return false;
  return RECALL_ANCHOR.test(t.replace(ATTRIBUTIVE_ANCHOR, "　")) || /たっけ/.test(t);
}

export interface RecallTopic {
  /** the topic runs of the question (no question-form words, no verb / adjective stems), e.g. ["車"], ["車種"], ["アウトランダー"] */
  terms: string[];
  /**
   * the terms some record of the searched pool matches directly (a run that is the term or starts with it). Set by `withPoolEvidence`.
   * For a term no record matches directly (「自動車」「車種」 when no record says so), a shorter keyword inside it (「車」) stands for it.
   * Absent: every term counts as matched directly (no fallback).
   */
  direct?: string[];
}

/** the topic of a recall question; null when the text is not a recall question or has no topic left (「前に何て言ったっけ？」) */
export function recallTopicOf(text: string): RecallTopic | null {
  if (!isRecallQuestion(text)) return null;
  const terms = questionTopicRuns(text);
  return terms.length > 0 ? { terms } : null;
}

/** what a record offers to the topic match: the same fields scoreMemory reads (keywords, summary, content) */
export type TopicSource = { keywords?: string[]; summary?: string; content?: string };

const keywordsOf = (memory: { keywords?: string[] }) => (memory.keywords ?? []).filter((k): k is string => typeof k === "string" && k.trim().length > 0);

/**
 * A record matches a topic term directly when one of its keyword runs is the term or starts with it (keyword 「車選び」 for 「車」), or one of its summary /
 * content runs is the term (a single kanji) or starts with it (two or more letters). A run that only ENDS with the term (「電車」「自転車」「駐車場」) or is shorter
 * than it (「日本」 for 「日本酒」) is not a direct match.
 */
function matchesDirectly(memory: TopicSource, term: string): boolean {
  const keywords = keywordsOf(memory).map((k) => k.normalize("NFKC").trim());
  if ([...keywords, ...keywords.flatMap(runsOf)].some((run) => run.startsWith(term))) return true;
  const single = isSingleKanji(term);
  // the summary and the content (scoreMemory reads both)
  return runsOf(`${memory.summary ?? ""} ${memory.content ?? ""}`).some((run) => (single ? run === term : run.startsWith(term)));
}

/** the topic with the terms the pool matches directly (see `RecallTopic.direct`) */
export function withPoolEvidence(topic: RecallTopic | null, memories: readonly TopicSource[]): RecallTopic | null {
  if (!topic) return null;
  return { terms: topic.terms, direct: topic.terms.filter((term) => memories.some((memory) => matchesDirectly(memory, term))) };
}

const isDirect = (topic: RecallTopic, term: string) => topic.direct === undefined || topic.direct.includes(term);
/** a keyword of the question that stands for the term: it starts with the term, or (only when no record matches the term directly) it is inside it */
const standsFor = (keyword: string, term: string, topic: RecallTopic) => keyword.startsWith(term) || (!isDirect(topic, term) && term.includes(keyword));

/** how a Memory touches the topic: the terms it matches (each once) and whether a keyword hit of the normal scoring already counts the term */
export interface RecallTopicMatch {
  /** topic terms the Memory matches */
  matched: string[];
  /** of those, the terms a keyword hit of the normal scoring already covers (the keyword is in the question and stands for the term) */
  coveredByKeyword: string[];
}

export function matchRecallTopic(memory: TopicSource, topic: RecallTopic, questionText: string): RecallTopicMatch {
  // the same raw comparison as scoreMemory: a keyword is "covered" only where the normal scoring counted it
  const keywordHits = keywordsOf(memory).filter((k) => (questionText ?? "").includes(k));
  const matched: string[] = [];
  const coveredByKeyword: string[] = [];
  for (const term of topic.terms) {
    const covered = keywordHits.some((k) => standsFor(k.normalize("NFKC").trim(), term, topic));
    if (!covered && !matchesDirectly(memory, term)) continue;
    matched.push(term);
    if (covered) coveredByKeyword.push(term);
  }
  return { matched, coveredByKeyword };
}

/** a keyword hit of the normal scoring that IS the topic of the recall question (it should not be discounted as a generic word) */
export function isTopicKeyword(keyword: string, topic: RecallTopic | null): boolean {
  if (!topic) return false;
  const k = keyword.normalize("NFKC").trim();
  return k.length > 0 && topic.terms.some((term) => standsFor(k, term, topic));
}
