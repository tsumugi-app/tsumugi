import type { Fact } from "@/lib/factExtraction";
import type { SemanticInterpretation } from "@/lib/semanticInterpretation";

/**
 * Test79で確定した「変化」の定義をそのまま実装する（currentState.tsとは独立したレイヤー）。
 *
 * - 各Semantic Axis（desire/action/evaluation）を完全に独立して処理する。異なるaxisの
 *   変化を1つのChangeに統合しない（Test79-Hで、desireの変化とactionの変化を必ず
 *   別々の2件として検出することを確認済み）。
 * - unknownは比較対象から完全にスキップする。unknownをfrom/toに使ったChangeは
 *   生成しない。ある軸で最初に観測された非unknown値は「基準値」であり、それ自体は
 *   Changeにしない（Test79-C/D＝初回観測はChangeではない、を確認済み）。
 * - 直近の非unknown値と異なる非unknown値が現れた時点でChangeを1件生成し、以後の
 *   比較基準をその新しい値に更新する。往復（true→false→true）は1つに潰さず、
 *   2件のChangeとして残す（Test79-E）。
 * - fromFactId/toFactIdは、実際に値が変化した2点のFact idを指す。間にunknownの
 *   Factが挟まっていても、直前の非unknown値のFactを指す（unknownのFactを
 *   from/toに使わない）。
 * - LLMを一切呼ばない。入力のfacts/interpretationsは変更しない（純粋関数）。
 */

export type ChangeAxis = "desire" | "action" | "evaluation";
export type ChangeValue = "true" | "false" | "done" | "not_done" | "positive" | "negative";

export interface Change {
  id: string;
  subject: string;
  axis: ChangeAxis;
  from: ChangeValue;
  to: ChangeValue;
  fromFactId: string;
  toFactId: string;
  createdAt: string;
}

const AXES: ChangeAxis[] = ["desire", "action", "evaluation"];

/**
 * facts/interpretationsは同一subjectのものだけを渡す前提（絞り込みは呼び出し元の責務）。
 */
export function buildChanges(facts: Fact[], interpretations: SemanticInterpretation[]): Change[] {
  if (facts.length === 0 || interpretations.length === 0) return [];

  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const subject = facts[0].subject;

  const ordered = [...interpretations].sort((a, b) => {
    const factA = factById.get(a.factId);
    const factB = factById.get(b.factId);
    const timeA = factA ? Date.parse(factA.createdAt) : 0;
    const timeB = factB ? Date.parse(factB.createdAt) : 0;
    return timeA - timeB;
  });

  const changes: Change[] = [];

  for (const axis of AXES) {
    let lastValue: ChangeValue | null = null;
    let lastFactId: string | null = null;

    for (const interpretation of ordered) {
      const value = interpretation[axis];
      if (value === "unknown") continue;

      if (lastValue === null) {
        lastValue = value as ChangeValue;
        lastFactId = interpretation.factId;
        continue;
      }

      if (value !== lastValue) {
        changes.push({
          id: crypto.randomUUID(),
          subject,
          axis,
          from: lastValue,
          to: value as ChangeValue,
          fromFactId: lastFactId as string,
          toFactId: interpretation.factId,
          createdAt: new Date().toISOString(),
        });
        lastValue = value as ChangeValue;
        lastFactId = interpretation.factId;
      }
    }
  }

  return changes;
}
