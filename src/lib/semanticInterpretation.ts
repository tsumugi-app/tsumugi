import type { AISchema } from "@/lib/ai/schema";
import { getProvider, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";
import type { Fact } from "@/lib/factExtraction";

/**
 * Test72〜75で確認した分業を実装する（factExtraction.tsとは独立したレイヤー）。
 *
 * - LLMに渡すのは対象Factのsubjectとevidenceのquoteだけで、会話全体は渡さない
 *   （Test72で、同一会話内の他Factの意味が混入しないことを確認済み）。
 * - LLMがやるのは意味軸ごとの3値判定だけ。quote生成・Fact生成はさせない
 *   （Test70の教訓＝LLMにJSON全体を自由に組み立てさせると捏造・混入が起きる）。
 * - Test73〜74で、「want」を単一のbooleanにすると「desire（欲求）」と「action（行動）」が
 *   混ざり、「行きたかったけど行かなかった」のようなケースで意味が壊れることが分かった。
 *   Test75で、desire/action/evaluationを完全に独立したLLM呼び出しに分けたところ、
 *   50/50（desire・actionは各25/25）で意味干渉が解消したため、ここではその方式
 *   （interpretDesire/interpretAction/interpretEvaluationを別々に呼ぶ）を踏襲する。
 *   3軸を1回のLLM呼び出しでまとめて判定させない。
 * - Factそのもの（id/subject/evidence/created_at）は一切変更しない。SemanticInterpretation
 *   はFactに対して1対1で紐づく別レコードとして扱う（factIdで参照するだけ）。
 * - evaluationはTest75で「明示的な評価語がなくてもdesire+actionの組み合わせから
 *   positive/negativeを推論する」という、観測ではなく推論寄りの挙動が見られた。
 *   ここでは軸自体は残すが、今後「明示評価」と「推論評価」を分けたくなった場合に
 *   備え、desire/actionとは完全に独立したプロンプト・関数のままにしておく。
 */

export type TriState = "true" | "false" | "unknown";
export type ActionState = "done" | "not_done" | "unknown";
export type EvaluationState = "positive" | "negative" | "unknown";

export interface SemanticInterpretation {
  factId: string;
  desire: TriState;
  action: ActionState;
  evaluation: EvaluationState;
}

function buildEvidenceText(fact: Fact): string {
  return fact.evidence.map((evidence) => `- ${evidence.quote}`).join("\n");
}

function schemaFor(field: string, values: string[]): AISchema {
  return {
    type: "object",
    properties: {
      [field]: { type: "string", enum: values },
    },
    required: [field],
  };
}

async function classifyAxis<T extends string>(
  apiKey: string,
  field: string,
  values: T[],
  prompt: string
): Promise<T> {
  const providerName = resolveProviderForFeature("semanticInterpret");
  const provider = getProvider(providerName);

  const response = await provider.generateStructured({
    model: resolveModel(providerName),
    apiKey,
    userContent: prompt,
    schema: schemaFor(field, values),
  });

  const parsed = JSON.parse(response.text) as Record<string, string>;
  const value = parsed[field];
  return (values.includes(value as T) ? value : "unknown") as T;
}

async function interpretDesire(fact: Fact, apiKey: string): Promise<TriState> {
  const prompt = `対象：${fact.subject}

発言：
${buildEvidenceText(fact)}

上記の発言について、「${fact.subject}」に対する意向（〜したい・〜に行きたいという気持ち）を判定してください。

- true：本人の希望・意思・願望が明示または明確に表現されている
- false：本人が希望・意思・願望を明確に否定している
- unknown：発言に本人の希望・意思・願望が明示または明確に表現されていない

行動（実際にした／しなかった）から希望を推測してはいけません。行動の記述だけがあり、希望について何も述べられていない場合はunknownとしてください。`;

  return classifyAxis<TriState>(apiKey, "desire", ["true", "false", "unknown"], prompt);
}

async function interpretAction(fact: Fact, apiKey: string): Promise<ActionState> {
  const prompt = `対象：${fact.subject}

発言：
${buildEvidenceText(fact)}

上記の発言について、「${fact.subject}」に関して実際に行動が行われたかどうかを判定してください。

- done：実際に行った・したと明示または明確に表現されている
- not_done：実際には行かなかった・しなかったと明示または明確に表現されている
- unknown：発言に行動の実行・未実行が明示または明確に表現されていない

希望（したい・したくない）から行動の有無を推測してはいけません。希望の記述だけがあり、実際の行動について何も述べられていない場合はunknownとしてください。`;

  return classifyAxis<ActionState>(apiKey, "action", ["done", "not_done", "unknown"], prompt);
}

async function interpretEvaluation(fact: Fact, apiKey: string): Promise<EvaluationState> {
  const prompt = `対象：${fact.subject}

発言：
${buildEvidenceText(fact)}

上記の発言について、「${fact.subject}」に対する評価を判定してください。

- positive：好意的な評価が明示または明確に表現されている
- negative：否定的な評価が明示または明確に表現されている
- unknown：発言に評価が明示または明確に表現されていない

希望や行動の有無から評価を推測してはいけません。評価についての言葉が発言に無い場合はunknownとしてください。`;

  return classifyAxis<EvaluationState>(apiKey, "evaluation", ["positive", "negative", "unknown"], prompt);
}

export async function interpretFact(fact: Fact, apiKey: string): Promise<SemanticInterpretation> {
  const [desire, action, evaluation] = await Promise.all([
    interpretDesire(fact, apiKey),
    interpretAction(fact, apiKey),
    interpretEvaluation(fact, apiKey),
  ]);

  return { factId: fact.id, desire, action, evaluation };
}
