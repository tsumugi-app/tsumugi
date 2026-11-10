/**
 * Memory Graph P0 (debug only): what KIND of statement one sentence of the user is, judged from the FORM of the sentence, not from its topic.
 * Used by the person sheet to tell the user's own judgments and thoughts apart from what the user asked or told the AI.
 *
 *   question  a question or a check addressed to the listener: ends with ？ (not a self-directed 〜だろう？ / 〜のかな？), or 〜ですか / 〜ますか / 〜でしょうか, or どう思う
 *   request   asks the listener to do something: 教えて / 調べて / まとめて … (ください / くれる？ / ほしい), お願い
 *   thought   a hedged or felt view: 〜と思う / 〜気がする / 〜かも / 〜かな / 〜だろう, a wish (〜たい / 〜てほしい), a feeling word, an evaluation in the past (楽しかった)
 *   judgment  a view stated outright, in the present: 〜ない / 〜だ / 〜べき / 〜しかない / 無理 …, or a decision (決めた / やめる / 諦めた / 〜ことにした)
 *   report    what happened: ends in the past tense (〜した / 〜だった / 〜ました) and is not a decision or an evaluation
 *   state     how things are: 〜している / 〜てる / いる / ある
 *   other     too short, or no predicate (a name, a noun phrase)
 *
 * The form says what the user did with the sentence (asked, told, judged); it never says whether the judgment is still true. No AI is called.
 * Limits: spoken Japanese without punctuation can join two sentences; a question without ？ that does not end in a question form is not seen.
 */
import { OWN_VIEW } from "./memoryContext";

export type StatementRole = "judgment" | "thought" | "question" | "request" | "report" | "state" | "other";

export const STATEMENT_ROLE_LABEL: Record<StatementRole, string> = {
  judgment: "判断・結論（言い切り）",
  thought: "考え・気持ち",
  question: "質問・確認",
  request: "依頼",
  report: "出来事の報告",
  state: "状態の説明",
  other: "その他",
};

export interface StatementClass {
  role: StatementRole;
  /** why, in words a reader can check against the sentence */
  reason: string;
}

/** closing marks and sentence-final particles that do not change what the sentence does */
const TRAIL = /[。．.!！…〜~ー\s」』）)♪w笑]+$/;
// only the particle goes: the copula stays (友人だよ → 友人だ, a judgment; Codex on PR #33)
const PARTICLES = /(よね|よな|けどね|けど|けれど|のに|よ|ね|ぞ|ぜ|わ|さ)$/;
const QUESTION_MARK = /[?？]+$/;
/** a question the user asks themself: 〜だろう？ / 〜のかな？ (a view, not a question to the listener) */
const SELF_WONDER = /(だろう|だろうか|んだろう|のだろう|のかな|かな|かなあ|かなぁ)$/;
const ASK_FORM = /(ですか|ますか|でしょうか|ませんか|ないですか|んですか|のですか)$/;
const ASK_LISTENER = /(どう思う|どう思います|どう見える|どう考える|どうしたらいい|どうすればいい|どうしたら良い|どうすれば良い|覚えてる|覚えてます|合ってる|あってる)$/;
const REQUEST = /(教えて|調べて|まとめて|聞かせて|手伝って|説明して|書いて|探して|考えて|整理して|見て)(ください|下さい|くれ|くれる|くれない|くれますか|もらえる|もらえない|もらえますか|ほしい|欲しい)?$|お願い(します|ね)?$|頼む$|頼みます$/;
const HEDGE = /(と思う|と思った|と思ってる|と思っている|と思います|思える|気がする|気がした|かもしれない|かもしれません|かも|かな|かなあ|だろう|でしょう|みたい|ようだ|ような|らしい)$/;
const DECISION = /(決めた|決めている|決めてる|決心した|諦めた|あきらめた|やめた|やめる|やめよう|やめます|ことにした|ことにする|ことにしよう|ことにします|しないことにした|もう(?:会わな|連絡しな|関わらな|話さな)い)$/;
const WISH = /(たい|たくない|たかった|てほしい|て欲しい|てほしかった)$/;
const PAST = /(た|だった|でした|ました|ませんでした|なかった)$/;
const PAST_EVALUATION = /[^な]かった$|よかった$/;
const STATE = /(ている|ていない|てる|てない|ています|ていません|いる|いない|ある|あります|います|いません)$/;
const OUTRIGHT = /(ない|無い|なし|べき|べきだ|しかない|はず|はずだ|だ|である|です|じゃない|ではない|無理|ダメ|だめ|嫌|いや|好き|嫌い|大事|大切|必要|不要|十分|当然|違う|ちがう|終わり|終わりだ|い)$/;

const MIN_PREDICATE_CHARS = 4;

/** the kind of one sentence of the user (see the top of this file) */
export function classifyStatement(sentence: string): StatementClass {
  const raw = sentence.normalize("NFKC").trim();
  const noTrail = raw.replace(TRAIL, "");
  const asked = QUESTION_MARK.test(noTrail);
  const core = noTrail.replace(QUESTION_MARK, "").replace(TRAIL, "");
  const body = core.replace(PARTICLES, "");
  if (REQUEST.test(body)) return { role: "request", reason: "相手にしてほしいことを頼む形（〜して／お願い）" };
  if (asked) {
    if (SELF_WONDER.test(body)) return { role: "thought", reason: "自分に問う形（〜だろう？／〜のかな？）" };
    return { role: "question", reason: "相手に尋ねる・確かめる形（？で終わる）" };
  }
  if (ASK_FORM.test(body)) return { role: "question", reason: "相手に尋ねる形（〜ですか／〜ますか）" };
  if (ASK_LISTENER.test(body)) return { role: "question", reason: "相手の意見や記憶を尋ねる形（どう思う／覚えてる）" };
  // a hedge at the end wins over a decision inside (もう会わないかも / やめようと思う are not decided yet: Codex on PR #33)
  if (HEDGE.test(body)) return { role: "thought", reason: "推量・思いの形（〜と思う／〜かも／〜気がする）" };
  if (DECISION.test(body)) return { role: "judgment", reason: "決めたことを言う形（決めた／やめる／〜ことにした）" };
  if (WISH.test(body)) return { role: "thought", reason: "望みを言う形（〜たい／〜てほしい）" };
  if (OWN_VIEW.test(body) && !PAST.test(body)) return { role: "thought", reason: "気持ち・考えを表す言葉がある" };
  // a short text with none of the forms above (はい / そう / みなと) says too little to be a view; a short 好き / 怖い / 決めた is kept above (Codex on PR #33)
  if (Array.from(body).length < MIN_PREDICATE_CHARS) return { role: "other", reason: "短すぎて文の形が分からない" };
  if (PAST.test(body)) {
    if (PAST_EVALUATION.test(body)) return { role: "thought", reason: "過去の出来事への評価・感想（〜かった）" };
    if (OWN_VIEW.test(body)) return { role: "thought", reason: "過去形だが、気持ち・考えを表す言葉がある" };
    return { role: "report", reason: "過去形で、起きたことを伝える形" };
  }
  if (STATE.test(body)) return { role: "state", reason: "今の様子を説明する形（〜している／いる／ある）" };
  if (OUTRIGHT.test(body)) return { role: "judgment", reason: "今のこととして言い切る形（〜ない／〜だ／〜べき）" };
  return { role: "other", reason: "述語で終わっていない（名詞などで終わる）" };
}

/** the sentences of a text (split at 。！？ and line breaks; the closing mark stays with its sentence) */
export function statementSentences(text: string): string[] {
  return (text.match(/[^。！？!?\n]+[。！？!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** the same words written twice (spaces, width and closing marks aside) are one statement */
export function statementKey(sentence: string): string {
  return sentence.normalize("NFKC").replace(/\s+/g, "").replace(/[。．.!！?？…〜~ー」』）)]+$/, "");
}
