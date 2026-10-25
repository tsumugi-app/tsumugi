/**
 * Memory Synthesis (experimental, not connected to any screen or API route yet): the instructions and output schema that were verified in the Preview
 * comparisons of PR #6. Kept here so that a later, reviewed trigger (not per chat turn) can reuse them; nothing imports this in production code today.
 * The model output must always go through `validateSynthesisItems` (memorySynthesis.ts) before use.
 */
import type { AISchema } from "./ai/schema";

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
