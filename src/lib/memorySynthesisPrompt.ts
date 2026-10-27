/**
 * Memory Synthesis: the instructions and output schema verified in the Preview comparisons of PR #6, used by the S1 generation route (/api/synthesize),
 * which runs after a session ends (never per chat turn) and only while the `?memorySynthesis=1` trial is on.
 * The model output must always go through `validateSynthesisItems` (memorySynthesis.ts) and `validateReactions` (synthesisModel.ts) before use.
 */
import type { AISchema, AISchemaObject } from "./ai/schema";

export const SYNTHESIS_SYSTEM_PROMPT = `あなたはTsumugiという「Personal Memory OS」の一部です。
同じユーザーが、別々の日に話した内容の記録（Memory）が、テーマごとに話した順に与えられます。「このテーマの今の状態の根拠」と印のある記録が、そのテーマの今の状態を表す記録です（それより後に話した記録が、別の対象のことを話している場合もあります）。「以前の出来事を後から話したもの」は過去の出来事であり、今の状態ではありません。「記録の言葉では「保留」」などは、記録に書かれた言葉から機械的に付けた印です。
複数の記録を並べたときに初めて見えるものだけを、短く整理してください。

出力する種類（該当するものだけ。無理に作らない。0件でもよい）：
- change（変化）：以前と最近とで、考え方・目標・状態が変わったこと。最新の記録まで含めて、今どうなっているかを書く。
- pattern（繰り返し）：3つ以上の別々の会話で繰り返し出てくる関心・判断の仕方・行動。
- tension（揺れ）：時期や状況によって望みや考えが違って見えること。矛盾と断定しない。situationNoteに、それぞれ「どんな状況で何と話したか」を書く。

support（根拠の強さ）：
- "stated"：本人が記録の中で、ほぼそのまま言っている。
- "derived"：複数の記録を並べると、本人の発言だけから言える。
- "hypothesis"：Tsumugiの読み。ただし記録にある発言の組み合わせを超えない。
tensionは"stated"にしない。

厳守すること：
- 根拠は与えられた記録だけ。記録に無い出来事・感情・理由・背景・目的を足さない。
- 今の状態を必ず反映する。今の状態の記録で結果が出ていること（例：保留になった、完走した、中止になった）を、まだ途中や予定のように書かない。予定・検討中・保留・中止・実施済みを混同しない。
- evidenceIdsには、根拠にした記録のidだけを、与えられたものからそのまま書く。1つのテーマの中の記録だけを使う。
- 性格・心理・病名・「〜な人」というラベル付けや診断をしない。動機や深層心理を推測しない。
- 行動の目的・役割・気持ちの理由（「〜のための手段」「〜を求めている」等）は、本人がそう話していればそのまま書いてよい。本人が話していない読みは、2つ以上の記録に支えられる場合に限り、support="hypothesis"で「〜のかもしれない」「〜とも読める」のように可能性として書く。根拠の記録を示せない読みは書かない。
- statementとsituationNoteは、事実の部分は「〜と話していた」「〜と話している」の形で書く。内面の推移を断定しない。
- 発言日（記録日）と出来事の時期は別のもの。発言日を出来事の日付として書かない。
- statementは、本人に向けて話す文ではなく、事実を整理した1〜2文（120文字程度まで）にする。日付は書かなくてよい（日付はシステムが根拠から付ける）。`;

export const SYNTHESIS_SCHEMA: AISchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["change", "pattern", "tension"] },
          statement: { type: "string", description: "記録から言えることの整理（1〜2文）" },
          support: { type: "string", enum: ["stated", "derived", "hypothesis"] },
          evidenceIds: { type: "array", items: { type: "string" }, description: "根拠にした記録のid（与えられたものだけ）" },
          situationNote: { type: "string", description: "tensionのとき必須：それぞれの時点の状況の違い。他の種類では空でよい" },
        },
        required: ["kind", "statement", "support", "evidenceIds"],
      },
    },
  },
  required: ["items"],
};

/**
 * Memory Synthesis S1: the extra instructions for one generation call (/api/synthesize). The same call also judges how the user answered when a hypothesis
 * was used in a conversation, so judging reactions adds no AI call. The output still goes through code gates (validateSynthesisItems / validateReactions).
 */
export const SYNTHESIS_S1_INSTRUCTIONS = `

## ユーザーが否定・訂正した見方
「ユーザーが否定・訂正した見方」が与えられたら、それと同じ趣旨の整理を出さない。言い回しを変えて同じことを書くのも不可。ユーザーの言葉と矛盾する整理も出さない。
ユーザーの訂正は、今の見方を更新するための情報であり、過去の出来事を消したり書き換えたりするものではない。
- 「今は気にしていない」から「以前から一度も気にしていなかった」と推論しない。「今は感謝している」から「一貫して感謝してきた」「ずっと〜だった」と一般化しない。
- 訂正と食い違う記録が残っているときは、「以前は〜と話していたが、〜の時点では〜と話している」のように変化として書くか、断定を避ける。記録を無かったことにしない。

## 反応の判定（reactions）
「会話で使った整理と、その後のユーザーの発言」が与えられたら、それぞれについて、ユーザーがその整理をどう受け止めたかを判定する。
- "rejected"：ユーザーが、その見方をはっきり否定している（例：「それは違う」「そういうわけじゃない」）。
- "corrected"：ユーザーが、はっきり否定したうえで、別の事実や考えを述べている（例：「仕事にしたいわけじゃなくて、趣味として続けたい」）。
- "confirmed"：ユーザーが、その見方をはっきり認めている。
- "unclear"：上のどれとも言い切れない。相づち（「うん」「そうかも」「たしかに」）、迷い（「どうだろう」「うーん」）、話題が変わった、などは必ず"unclear"。
迷ったら"unclear"にする。"rejected"と"corrected"のときは、userQuoteに、否定している部分のユーザーの発言をそのまま（一字一句変えずに）書く。`;

export const SYNTHESIS_S1_SCHEMA: AISchema = {
  type: "object",
  properties: {
    items: (SYNTHESIS_SCHEMA as AISchemaObject).properties.items,
    reactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hypothesisId: { type: "string" },
          reaction: { type: "string", enum: ["rejected", "corrected", "confirmed", "unclear"] },
          userQuote: { type: "string", description: "rejected / corrected のとき、否定しているユーザーの発言（そのまま）" },
        },
        required: ["hypothesisId", "reaction"],
      },
    },
  },
  required: ["items", "reactions"],
};

export function renderRejectedForModel(rejected: { theme: string; statement: string; userQuote: string }[]): string {
  if (rejected.length === 0) return "";
  return `\n\n## ユーザーが否定・訂正した見方（同じ趣旨を出さない）\n${rejected.map((r) => `- テーマ「${r.theme}」: ${r.statement}\n  ユーザーの言葉:「${r.userQuote}」`).join("\n")}`;
}

export function renderReactionChecksForModel(checks: { hypothesisId: string; theme: string; statement: string; tsumugiReply: string; userTurns: { text: string }[] }[]): string {
  if (checks.length === 0) return "";
  return `\n\n## 会話で使った整理と、その後のユーザーの発言（reactionsで判定する）\n${checks
    .map((c) => `- hypothesisId=${c.hypothesisId}（テーマ「${c.theme}」）\n  整理: ${c.statement}\n  Tsumugiの返答: ${c.tsumugiReply}\n${c.userTurns.map((t) => `  ユーザー:「${t.text}」`).join("\n")}`)
    .join("\n")}`;
}
