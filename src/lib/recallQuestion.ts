/**
 * Recall questions: the user asks what they themselves said, thought or did before (「過去にどんな車がいいって言ったっけ？」).
 * Pure functions, no AI, no storage. Used only by the chat (Retrieval with `recallTopic`, the Memory Timeline theme choice, the chat prompt).
 *
 * The TOPIC of such a question is what is left of its kanji / katakana / latin runs after the words that only shape the question
 * (過去・以前・前・言…). Matching the topic with a Memory is by those runs too, so 「車」「車種」 match 「車」「車種」「車選び」 without a synonym list
 * and without naming any topic in the code.
 */

/** words that only shape a question about the past (when, asked how), never its topic */
export const QUESTION_FORM_TERMS: ReadonlySet<string> = new Set([
  "過去", "以前", "前", "前回", "昔", "今", "今回", "今日", "昨日", "最近", "当時", "最初", "最後", "一番",
  "話", "言", "何", "事", "時", "頃", "方", "自分", "私", "僕", "俺", "思", "考", "気", "感", "感じ", "結局",
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

/** pointing back at something earlier (「っけ」 alone also does: 「言ったっけ」「どこだっけ」) */
const RECALL_ANCHOR = /過去|以前|前に|前は|前回|昔|これまで|今まで|この前|当時|っけ/;
const QUESTION = /[?？]|っけ|かな|かしら|でしょうか|ですか|だった\s*$/;

export function isRecallQuestion(text: string): boolean {
  const t = (text ?? "").normalize("NFKC").trim();
  return t.length > 0 && RECALL_ANCHOR.test(t) && QUESTION.test(t);
}

export interface RecallTopic {
  /** the topic runs of the question (no question-form words), e.g. ["車"], ["車種"], ["アウトランダー"] */
  terms: string[];
  /**
   * the terms some record of the searched pool matches directly (a run that is the term or starts with it). Set by `withPoolEvidence`.
   * For a term no record matches directly (「自動車」 when no record says 自動車), a shorter keyword inside it (「車」) stands for it.
   * Absent: every term counts as matched directly (no fallback).
   */
  direct?: string[];
}

/** the topic of a recall question; null when the text is not a recall question or has no topic left (「前に何て言ったっけ？」) */
export function recallTopicOf(text: string): RecallTopic | null {
  if (!isRecallQuestion(text)) return null;
  const terms = [...new Set(runsOf(text).filter((run) => !isNotTopic(run)))];
  return terms.length > 0 ? { terms } : null;
}

const prefixRelated = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
const keywordsOf = (memory: { keywords?: string[] }) =>
  (memory.keywords ?? []).filter((k) => typeof k === "string" && k.trim().length > 0).map((k) => k.normalize("NFKC").trim());

/**
 * A record matches a topic term directly when one of its keyword runs is the term, starts with it or begins the term (「車」→「車種」「車選び」, 「車種」→「車」),
 * or one of its summary runs is the term or starts with it. Runs that only END with the term are not matches (「電車」「自転車」「駐車場」 are not about 「車」).
 */
function matchesDirectly(memory: { keywords?: string[]; summary?: string }, term: string): boolean {
  const keywords = keywordsOf(memory);
  const keywordRuns = [...new Set([...keywords, ...keywords.flatMap(runsOf)])].filter((run) => !isNotTopic(run));
  if (keywordRuns.some((run) => prefixRelated(run, term))) return true;
  return runsOf(memory.summary ?? "").some((run) => !isNotTopic(run) && run.startsWith(term));
}

/** the topic with the terms the pool matches directly (see `RecallTopic.direct`) */
export function withPoolEvidence(topic: RecallTopic | null, memories: readonly { keywords?: string[]; summary?: string }[]): RecallTopic | null {
  if (!topic) return null;
  return { terms: topic.terms, direct: topic.terms.filter((term) => memories.some((memory) => matchesDirectly(memory, term))) };
}

const isDirect = (topic: RecallTopic, term: string) => topic.direct === undefined || topic.direct.includes(term);
/** a keyword of the question that stands for the term: prefix-related to it, or (when no record matches the term directly) inside it */
const standsFor = (keyword: string, term: string, topic: RecallTopic) => prefixRelated(keyword, term) || (!isDirect(topic, term) && term.includes(keyword));

/** how a Memory touches the topic: the terms it matches (each once) and whether a keyword hit of the normal scoring already counts the term */
export interface RecallTopicMatch {
  /** topic terms the Memory matches */
  matched: string[];
  /** of those, the terms a keyword hit of the normal scoring already covers (the keyword is in the question and stands for the term) */
  coveredByKeyword: string[];
}

export function matchRecallTopic(memory: { keywords?: string[]; summary?: string }, topic: RecallTopic, questionText: string): RecallTopicMatch {
  const question = (questionText ?? "").normalize("NFKC");
  const keywordHits = keywordsOf(memory).filter((k) => question.includes(k));
  const matched: string[] = [];
  const coveredByKeyword: string[] = [];
  for (const term of topic.terms) {
    const covered = keywordHits.some((k) => standsFor(k, term, topic));
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
