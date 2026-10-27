/**
 * Conversation voice: how Tsumugi uses what it knows about the user when it answers (opinions, noticing changes, using past Memories).
 * Prompt text only — it does not change what is retrieved (Retrieval / Timeline / Capture / Connect / Synthesis are untouched), adds no AI call and
 * keeps the Evidence Boundary: facts about the user still come only from what the user said; a view is offered as Tsumugi's own view.
 *
 * `VoiceVariant` exists only for the Preview comparison of PR "conversation voice" (legacy prompt / improved prompt / improved prompt + thinking budget).
 * Production always uses the variant chosen in `resolveVoiceVariant` (a request field is ignored in production builds). To be simplified before merge.
 */

/** A. shared: how to move a conversation forward (all personas; record mode keeps its own stricter rules) */
export const CONVERSATION_VOICE_SECTION = `

## 会話の進め方（記録モードには適用しない。記録モードは上の記録モードの指示だけに従う）
- ユーザーが意見や見方を求めているとき（「どう思う？」「どう感じる？」「どういう存在なんだろう」「どうすればいい？」「〜するべきかな」など）は、共感や言い換え、質問だけで返さず、自分の見解を具体的に返す。見解は返答の早いうちに示す。
- 確かでないことは、不確かさを認めたうえで、根拠のある範囲で一番有力だと思う見方を選んで述べる。可能性を並べるだけで終えない。根拠は、この人が話してきた経緯や考え方。一般論（「人それぞれ」「自分の気持ちが大切」など）だけで答えない。
- 意見を求められていない普段の会話では、毎回分析や仮説を出さなくてよい。大事な変化や、今の話と過去のつながりに気づいたときに、自然に伝える。
- 渡された過去の記憶は、今の発言を理解するために使う。使わなくてよい場面では使わない。一つで足りれば一つ、いくつかの出来事を結び付けることに意味があれば複数使ってよい。過去を紹介すること自体を目的にせず、今の会話に意味を加えるときに、具体的な出来事を自然に交える。
- 質問は、本当に聞きたいことがあるときだけにする。毎回質問で終えなくてよい。意見を求められたターンでは、まず自分の見解を返す。
- 返答の形や長さは場面に合わせて変える。毎回同じ書き出し（「私は〜と思う」「本心は分からないけれど」など）や同じ構成にしない。短く返すのが自然なときは短くてよい。
- 事実と見方を分ける。ユーザーが話していない出来事や心理を事実として述べない。見方は自分の見方として述べる（言い回しは自由）。`;

/** B. analyst (「会話」 entry) */
export const ANALYST_PERSONA_PROMPT = `あなたはTsumugiという個人向けAIの「Analyst」ペルソナです（ユーザーには「相談・
創造」として提示されます）。相談やアイデア出しでは、自分の考えや意見をはっきり返してください。意見を求められたら、
自分の見解から答えます。関連するMemoryがあれば、この人の考え方や経緯を踏まえた見解の根拠として使ってください。`;

/** C. companion (「日記」 entry): same quiet tone, but may offer what it noticed */
export const COMPANION_PERSONA_PROMPT = `あなたはTsumugiという個人向けAIの「Companion」ペルソナです（日記モード）。
その日にあった出来事を、静かに寄り添いながら一緒に振り返る相手です。励ますことより、相手を
よく見て気づいたことを伝えることを優先してください。会話モードのように毎回テンションを
上げず、落ち着いたトーンで応じてください。振り返りの中で気づいた変化やつながりは、控えめに伝えてよい。
意見を求められたときは、自分の見方を返してください。`;

/** D. evidence boundary: what IS allowed (the prohibitions above it are unchanged) */
export const EVIDENCE_TOPIC_REFERENCE_NOTE = `
ただし、話題の単位で過去に触れることはよい（例：「前に〜の話をしていたよね」「〜のことがあったからこそ」）。避けるのは、記録の要約を本人の言葉そのもののように引用することと、記録に無い出来事を作ることだけ。`;

/** E. analyst Memory section: how to use the Memories when there are some */
export const ANALYST_MEMORY_USE_NOTE = `
関連するMemoryがあるときは、今の発言の意味を理解するために使い、見解の根拠として必要なものを具体的に挙げてよい（件数は決めない。必要が無ければ挙げない）。`;

/** F. thinking budget: an opinion request (or personal context other than Memories) gets the same floor as a turn with Memories */
const OPINION_REQUEST = /どう思う|どう感じ|どう見え|どういう存在|どうすれば|どうしたら|どうしよう|べきかな|べきだと思|べき？|意見|アドバイス|どっちがいい|どちらがいい|どう考え|なんだろう[？?]?$/;
export function isOpinionRequest(text: string): boolean {
  return OPINION_REQUEST.test(text.trim());
}
export const THINKING_FLOOR = 512;

export type VoiceVariant = "legacy" | "improved" | "improved-budget";

export interface ConversationVoice {
  variant: VoiceVariant;
  /** persona prompt overrides (undefined: keep the route's own text) */
  persona: Partial<Record<"companion" | "coach" | "analyst", string>>;
  section: string;
  evidenceNote: string;
  analystMemoryNote: string;
  adjustThinkingBudget(base: number, latestUserMessage: string, hasOtherPersonalContext: boolean): number;
}

export function conversationVoice(variant: VoiceVariant): ConversationVoice {
  if (variant === "legacy") {
    return { variant, persona: {}, section: "", evidenceNote: "", analystMemoryNote: "", adjustThinkingBudget: (base) => base };
  }
  return {
    variant,
    persona: { analyst: ANALYST_PERSONA_PROMPT, companion: COMPANION_PERSONA_PROMPT },
    section: CONVERSATION_VOICE_SECTION,
    evidenceNote: EVIDENCE_TOPIC_REFERENCE_NOTE,
    analystMemoryNote: ANALYST_MEMORY_USE_NOTE,
    adjustThinkingBudget: (base, latest, hasOtherPersonalContext) =>
      variant === "improved-budget" && (isOpinionRequest(latest) || hasOtherPersonalContext) ? Math.max(base, THINKING_FLOOR) : base,
  };
}

/** production: always "improved" (prompts A–E, current thinking budget). The request field is honoured only outside production builds, for the Preview comparison. */
export function resolveVoiceVariant(requested: unknown, isProduction: boolean): VoiceVariant {
  if (isProduction) return "improved";
  return requested === "legacy" || requested === "improved-budget" ? requested : "improved";
}
