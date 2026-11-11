/**
 * Memory Graph P1-C: what a view of the user (a judgment or a thought, personStatement.ts) DOES, for choosing the background of the chat.
 * The sheet's form classes say only "stated outright" or "hedged"; an outright sentence is not, by its form, an important one
 * (「もう半年だよ」 is a situation, 「よくわからない」 a passing doubt). Judged from the form and the kind of predicate, never from a person
 * or a fixed topic. No AI is called.
 *
 *   decision     a judgment or a conclusion: a decision (決めた / やめる / 〜ことにした), "X is not" of a thing (未来はない / 意味がない),
 *                an evaluation (べき / しかない / 無理 / 大事 / 必要 / 違う)
 *   wish         what the user wants to be or to do: 〜たい / 〜ありたい / 〜てほしい (with 〜と思う, 〜んです too)
 *   view         another thought or view (〜と思う / 〜気がする, a thought word), not a passing feeling
 *   feeling      a feeling of the moment: a feeling word, 〜てくれない / 消えない / 離れない, an evaluation of a past event (楽しかった)
 *   uncertain    a doubt: わからない / 迷っている / どうしたらいいのか
 *   situation    a description of how things are: a noun with だ / です and no thought or evaluation word (もう半年だ / 平日だ)
 *
 * `explains` is set when the sentence gives a reason or corrects / explains what was said before (だから / 理由は / 本当は / というより /
 * 〜と言ったのは …); it is a property, not a kind: an explanation is also a decision or a view.
 */
import { OWN_VIEW } from "./memoryContext";
import type { StatementRole } from "./personStatement";

export type Stance = "decision" | "wish" | "view" | "feeling" | "uncertain" | "situation";

export const STANCE_LABEL: Record<Stance, string> = {
  decision: "結論",
  wish: "願い",
  view: "考え",
  feeling: "その時の気持ち",
  uncertain: "迷い",
  situation: "状況の説明",
};

/** a reason given in the sentence (as P1-A, and 〜からだ / 〜からかな: the reason after the conclusion) */
export const REASON_FORM = /だから|ですから|(?:い|た|る|ない)から[、,]|(?:い|た|る|ない|だ)から(?:だ|です|なんだ|なの|かな|かも|と思う)|(?:な|だ|た|る|い)ので|(?:の|る|た|い)ため[、,にだ]|なぜなら|理由は|理由として|理由が|せいで|おかげで/;
/** an explanation or a correction of what was said before */
export const CORRECTION_FORM = /本当は|ほんとうは|実は|というより|っていうより|じゃなくて|ではなくて|ではなく[、,]|(?:と|って)言ったのは|というのは|っていうのは|というのも|言い直す|訂正|間違いで/;

const TRAIL = /[。．.!！…〜~ー\s」』）)♪w笑]+$/;
const PARTICLES = /(よね|よな|けどね|けど|けれど|のに|よ|ね|ぞ|ぜ|わ|さ)$/;
const POLITE = /(なんです|なのです|んです|のです|です|なんだ|なのだ|んだ|のだ)$/;
const HEDGE_TAIL = /(と思う|と思ってる|と思っている|と思います|なと思う|気がする)$/;

// 冷たい / 重たい / ありがたい are adjectives, not a wish
const ADJECTIVE_TAI = /(?:冷|重|眠|平|めで|ありが|うしろめ|後ろめ)たい$/;
const WISH_END = /(たい|たくない|ありたい|でいたい|ていたい|てほしい|て欲しい|てもらいたい)$/;
const isWish = (t: string) => WISH_END.test(t) && !ADJECTIVE_TAI.test(t);
const UNCERTAIN = /(わから|分から|わかん|分かん|判ら)(ない|なく|ん)|迷って|迷う|迷い|どうしたらいいのか|どうすればいいのか|決められない|決めきれない/;
const FEELING_END = /(てくれない|消えない|離れない|止まらない|おさまらない|収まらない|忘れられない)$/;
const FEELING_WORD = /つらい|辛い|苦し|しんどい|寂し|さみし|悲し|不安|怖い|こわい|モヤモヤ|もやもや|イライラ|落ち込|疲れ|嬉し|うれし|楽し|悔し|切ない|せつない|虚し|むなし/;
const DECISION = /(決めた|決めました|決めている|決めてる|決心した|諦めた|あきらめた|やめた|やめる|やめよう|ことにした|ことにする|ことにしよう|ことにしました)$|もう(?:会わな|連絡しな|関わらな|話さな)い$/;
/** "X は / が / も ない": a thing that does not exist (未来はない / 意味がない), not a verb in the negative (消えない) */
const NOT_A_THING = /[はがも](?:ない|無い|なかった|ありません)$/;
const EVALUATION = /べき|しかない|はず|無理|ダメ|だめ|大事|大切|必要|不要|当然|違う|ちがう|正しい|間違い|ありえない|あり得ない|仕方(?:が)?ない|しょうがない|意味(?:が|は)?ない|価値|限界/;
const COPULA = /(だ|である|でした|だった)$/;

const bodyOf = (sentence: string) => {
  let s = sentence.normalize("NFKC").trim().replace(TRAIL, "").replace(/[?？]+$/, "").replace(TRAIL, "");
  s = s.replace(PARTICLES, "");
  return s;
};

/** what a view of the user does (see the top of this file); `role` is its form class (only judgment / thought are views) */
export function stanceOf(sentence: string, role: StatementRole): { stance: Stance; explains: boolean } {
  const body = bodyOf(sentence);
  const plain = body.replace(POLITE, "");
  const core = plain.replace(HEDGE_TAIL, "").replace(POLITE, "");
  const explains = REASON_FORM.test(body) || CORRECTION_FORM.test(body);
  const stance = ((): Stance => {
    if (isWish(core) || isWish(plain)) return "wish";
    if (UNCERTAIN.test(body)) return "uncertain";
    if (DECISION.test(core)) return "decision";
    if (FEELING_END.test(core)) return "feeling";
    if (NOT_A_THING.test(core) || EVALUATION.test(body)) return "decision";
    // a feeling word without an evaluation, or an evaluation of a past event (楽しかった)
    if (FEELING_WORD.test(body) || /[^な]かった$/.test(core)) return "feeling";
    if (role === "thought" || OWN_VIEW.test(body)) return "view";
    // an explanation of what was said before is a view of its own, whatever its predicate
    if (explains) return "view";
    // stated outright, but only a description: a noun with だ / です, or a state
    if (COPULA.test(plain) || POLITE.test(body) || role === "judgment") return "situation";
    return "view";
  })();
  return { stance, explains };
}

/**
 * how much a view weighs when the background has to be cut to its size. Not a judgment of the user's words: a size bound that keeps
 * conclusions and wishes before a passing feeling, and leaves situations out (they are in the events). Short sentences weigh a little less.
 */
export const STANCE_WEIGHT: Record<Stance, number> = { decision: 5, wish: 5, view: 3, feeling: 1, uncertain: 1, situation: 0 };
