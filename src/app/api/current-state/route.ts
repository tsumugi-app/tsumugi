import type { Fact } from "@/lib/factExtraction";
import type { SemanticInterpretation } from "@/lib/semanticInterpretation";
import { buildCurrentState } from "@/lib/currentState";

export const runtime = "nodejs";

/**
 * buildCurrentState()はLLMを呼ばない純粋関数だが、動作確認をブラウザ経由の
 * fetchで行えるように薄いラッパーとして公開する。/api/chat・/api/fact-extract・
 * /api/semantic-interpretのいずれとも独立しており、それらを一切呼び出さない。
 */
export async function POST(request: Request) {
  const { facts, interpretations } = (await request.json()) as {
    facts: Fact[];
    interpretations: SemanticInterpretation[];
  };

  if (!facts || !interpretations) {
    return Response.json({ error: "facts and interpretations are required" }, { status: 400 });
  }

  const currentState = buildCurrentState(facts, interpretations);
  return Response.json({ currentState });
}
