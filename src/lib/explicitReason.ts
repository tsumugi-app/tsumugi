/**
 * P1-H：本人が明示した理由・訂正を、理由を尋ねる質問の根拠として確実に渡す（端末とサーバーで同じ判定）。
 *
 * - 理由を尋ねる質問（「〜と言ったのは、どういう理由だったっけ？」「前に〜したのはなぜ？」）だけが対象。過去を振り返る形でない
 *   「なんで疲れるんだろう」のような発言や、話題の語を読み取れない「なんでだっけ？」は対象にしない（従来どおり）。
 * - 「質問に答える本人の理由・訂正」＝本人の逐語の一文で、理由・訂正の言い回し（personStance.tsのREASON_FORM・CORRECTION_FORM）を持ち、
 *   質問の話題の語を少なくとも1つ含むもの。人物名・特定の文はハードコードしない。AIの要約・AIの仮説は対象にしない（逐語だけ）。
 * - 本人の言葉にない理由は作らない：該当する一文が無ければ何も選ばない（呼び出し側は従来の選び方に戻る）。
 *
 * 純関数。保存・I/O・AI呼び出しは無い。
 */
import { CORRECTION_FORM, REASON_FORM } from "./personStance";
import { questionTopicRuns } from "./recallQuestion";

const norm = (t: string) => (t ?? "").normalize("NFKC");
const len = (t: string) => Array.from(t ?? "").length;

/** asking why (理由・なぜ・どうして・なんで) */
export const REASON_ASK = /理由|なぜ|何故|どうして|なんで|わけは|訳は/;
/** looking back at what the user said / thought / did (not a question about now) */
const PAST_ASK = /前に|以前|過去|これまで|今まで|昔|当時|っけ|(?:言っ|話し|思っ|考え|作っ|決め|し|行っ|買っ|やめ|辞め)た(?!い|く|が)|ていた|てた(?!い)|でいた/;
/** words that are not a topic of their own (the question's form, time words, reason words) */
const NOT_A_TOPIC = /^(?:話|理由|考え|考え方|関係|気持ち|前|以前|過去|最近|今|昔|当時|何|こと|もの|自分|私|僕|俺|どう|なぜ|何故|件|例|先日|先週|今週|来週|先月|今月|来月|去年|昨年|今年|来年|昨日|一昨日|今日|明日|週末|前回|毎日|毎週|朝|昼|夜|午前|午後|言|意味|訳)$/;

export interface ReasonFocus {
  /** the topic words of the question (a sentence that answers it names at least one of them) */
  terms: string[];
}

/** the question asks for the reason of something the user said or did before, and names what it is about; null otherwise */
export function reasonFocusOf(question: string): ReasonFocus | null {
  const t = norm(question).trim();
  if (!t || !REASON_ASK.test(t) || !PAST_ASK.test(t)) return null;
  const terms = questionTopicRuns(t).filter((run) => !NOT_A_TOPIC.test(run) && !REASON_ASK.test(run) && len(run) >= 1);
  return terms.length > 0 ? { terms: [...new Set(terms)] } : null;
}

/** the user's words in the form of a reason or a correction */
export const isExplanationText = (text: string) => REASON_FORM.test(norm(text)) || CORRECTION_FORM.test(norm(text));

/** how well one of the user's sentences answers the question: 0 = it does not (no reason / correction form, or none of the topic words) */
export function reasonAnswerScore(sentence: string, focus: ReasonFocus): number {
  const s = norm(sentence);
  if (!isExplanationText(s)) return 0;
  const named = focus.terms.filter((term) => s.includes(term)).length;
  return named > 0 ? named : 0;
}

/** the sentences of a quote (the same split as memoryContext.ts) */
export function sentencesOf(quote: string): string[] {
  return (quote.match(/[^。！？!?\n]+[。！？!?]*/g) ?? []).map((s) => s.trim()).filter((s) => len(s) >= 2);
}

export interface ReasonSource {
  summary?: string;
  evidenceQuotes?: readonly string[];
  topicEvents?: readonly { quote: string; statedAt: string }[];
}

/**
 * the user's sentence of one record that answers the question best: the most topic words, then the newest (a later correction wins over an
 * earlier statement), then the first written. Only the user's own words (evidenceQuotes, topicEvents); undefined when none answers.
 */
export function reasonSentenceOf(memory: ReasonSource, focus: ReasonFocus): string | undefined {
  let best: { text: string; score: number; time: number; order: number } | undefined;
  let order = 0;
  const consider = (quote: unknown, time: number) => {
    if (typeof quote !== "string") return;
    for (const sentence of sentencesOf(quote)) {
      const score = reasonAnswerScore(sentence, focus);
      order += 1;
      if (score === 0) continue;
      if (!best || score > best.score || (score === best.score && time > best.time)) best = { text: sentence, score, time, order };
    }
  };
  for (const e of memory.topicEvents ?? []) consider(e?.quote, Number.isFinite(Date.parse(e?.statedAt ?? "")) ? Date.parse(e.statedAt) : 0);
  for (const q of memory.evidenceQuotes ?? []) consider(q, 0);
  return best?.text;
}

/** how many Topic Timeline slots may go to events that answer the question (the oldest and the latest keep the rest) */
export const REASON_TIMELINE_SLOTS = 2;

/** the user's verbatim lines the prompt carries that answer the question (the server's report, only with ?debugLog=1) */
export interface ServerReasonReport {
  asked: boolean;
  terms: string[];
  sent: { route: "Retrieval" | "Topic Timeline"; memoryId?: string; text: string }[];
}

const CLIP = 60;
const clip = (t: string) => (len(t) > CLIP ? `${Array.from(t).slice(0, CLIP).join("")}…` : t);

export function serverReasonReport(question: string, retrieved: readonly { id: string; quote?: string }[], timelineEvents: readonly { quote: string }[]): ServerReasonReport {
  const focus = reasonFocusOf(question);
  if (!focus) return { asked: false, terms: [], sent: [] };
  const sent: ServerReasonReport["sent"] = [];
  for (const m of retrieved) if (m.quote && reasonAnswerScore(m.quote, focus) > 0) sent.push({ route: "Retrieval", memoryId: m.id, text: clip(m.quote) });
  for (const e of timelineEvents) if (sentencesOf(e.quote).some((s) => reasonAnswerScore(s, focus) > 0)) sent.push({ route: "Topic Timeline", text: clip(e.quote) });
  return { asked: true, terms: focus.terms, sent };
}

export function formatServerReasonReport(r: ServerReasonReport | null | undefined): string {
  if (!r) return "本人の理由・訂正（サーバーが受け取った値）：記録なし（このターンの診断が無い）";
  if (!r.asked) return "本人の理由・訂正（サーバーが受け取った値）：理由を尋ねる質問ではない（従来どおり）";
  const head = `本人の理由・訂正（サーバーが受け取った値・実際のプロンプト）：話題の語 ${r.terms.join("・")}　プロンプトに入った${r.sent.length}件`;
  return [head, ...(r.sent.length === 0 ? ["- 入っていない"] : r.sent.map((s) => `- ${s.route}${s.memoryId ? ` ${s.memoryId}` : ""}：「${s.text}」`))].join("\n");
}
