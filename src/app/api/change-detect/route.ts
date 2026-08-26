import type { Fact } from "@/lib/factExtraction";
import type { SemanticInterpretation } from "@/lib/semanticInterpretation";
import { buildChanges } from "@/lib/changeDetection";

export const runtime = "nodejs";

/**
 * buildChanges()はLLMを呼ばない純粋関数だが、動作確認をブラウザ経由のfetchで
 * 行えるように薄いラッパーとして公開する。/api/chat・/api/fact-extract・
 * /api/semantic-interpret・/api/current-stateのいずれとも独立しており、
 * それらを一切呼び出さない。
 */
export async function POST(request: Request) {
  const { facts, interpretations } = (await request.json()) as {
    facts: Fact[];
    interpretations: SemanticInterpretation[];
  };

  if (!facts || !interpretations) {
    return Response.json({ error: "facts and interpretations are required" }, { status: 400 });
  }

  const changes = buildChanges(facts, interpretations);
  return Response.json({ changes });
}
