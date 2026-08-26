import type { Fact } from "@/lib/factExtraction";
import type { ActionState, EvaluationState, SemanticInterpretation, TriState } from "@/lib/semanticInterpretation";

/**
 * Test76〜77で確認した「過去は書き換えない。現在だけを新しく導出する」を実装する。
 *
 * - CurrentStateはFact/SemanticInterpretationとは別オブジェクト。ここで生成した後も
 *   入力のfacts/interpretationsは一切変更しない（副作用なし・純粋関数）。
 * - 各意味軸（desire/action/evaluation）を独立に処理する。「最新のFactをそのまま
 *   採用する」のではなく、軸ごとに時系列で最後に観測された非unknown値を採用する
 *   （Test77-Fで、desireが8月由来・actionが10月由来という異なるFactから独立に
 *   導出されるケースを確認済み）。
 * - unknownは値のリセットではない。ある軸が一度も非unknownで観測されていない
 *   場合にのみ、その軸はunknownのままになる。
 * - LLMはここでは一切呼ばない。Fact→SemanticInterpretationまでがLLMの担当で、
 *   SemanticInterpretation→CurrentStateは完全に決定論的なJSロジックとする。
 * - evaluationもdesire/actionと全く同じルールで処理する。「desire=true かつ
 *   action=doneだからevaluation=positiveだろう」のような新しい推論はここで
 *   絶対に行わない（Test75で確認した「評価は明示された場合のみ」という
 *   interpretEvaluation()側の方針を、この層でも壊さない）。
 */

export interface CurrentState {
  subject: string;
  desire: TriState;
  action: ActionState;
  evaluation: EvaluationState;
  derivedFrom: string[];
  createdAt: string;
}

/**
 * facts/interpretationsは同一subjectのものだけを渡す前提（Fact.subjectでの絞り込みは
 * 呼び出し元の責務とする）。created_atで時系列順に並べ、各軸を独立に走査する。
 */
export function buildCurrentState(facts: Fact[], interpretations: SemanticInterpretation[]): CurrentState | null {
  if (facts.length === 0 || interpretations.length === 0) return null;

  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const orderedInterpretations = [...interpretations].sort((a, b) => {
    const factA = factById.get(a.factId);
    const factB = factById.get(b.factId);
    const timeA = factA ? Date.parse(factA.createdAt) : 0;
    const timeB = factB ? Date.parse(factB.createdAt) : 0;
    return timeA - timeB;
  });

  let desire: TriState = "unknown";
  let action: ActionState = "unknown";
  let evaluation: EvaluationState = "unknown";
  let desireFactId: string | null = null;
  let actionFactId: string | null = null;
  let evaluationFactId: string | null = null;

  for (const interpretation of orderedInterpretations) {
    if (interpretation.desire !== "unknown") {
      desire = interpretation.desire;
      desireFactId = interpretation.factId;
    }
    if (interpretation.action !== "unknown") {
      action = interpretation.action;
      actionFactId = interpretation.factId;
    }
    if (interpretation.evaluation !== "unknown") {
      evaluation = interpretation.evaluation;
      evaluationFactId = interpretation.factId;
    }
  }

  const derivedFrom = [...new Set([desireFactId, actionFactId, evaluationFactId].filter((id): id is string => id !== null))];

  return {
    subject: facts[0].subject,
    desire,
    action,
    evaluation,
    derivedFrom,
    createdAt: new Date().toISOString(),
  };
}
