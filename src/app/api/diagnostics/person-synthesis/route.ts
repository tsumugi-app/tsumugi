import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";
import { renderClustersForModel, SYNTHESIS_LIMITS, validateSynthesisItems, type SynthesisCluster } from "@/lib/memorySynthesis";
import { SYNTHESIS_SCHEMA, SYNTHESIS_SYSTEM_PROMPT } from "@/lib/memorySynthesisPrompt";
import { gateS1Items } from "@/lib/synthesisModel";

export const runtime = "nodejs";

/**
 * EXPERIMENT (Preview only; 404 in production builds): a trial person-level Synthesis for the emotional-understanding comparison (condition C).
 * Stateless, stores nothing, reads no Memory: the comparison page sends one person's fictional records. The same gates as S1 apply
 * (real evidence ids, enough evidence, no unfounded psychology, no unhedged cause). To be removed with the comparison page.
 */
const PERSON_INSTRUCTIONS = `

## このテーマは一人の人物
テーマは、ユーザーが話してきた一人の人物（テーマ名がその人の呼び名）。与えられた記録はすべてその人について話したもの。
- ユーザーがその人と「したこと・あったこと」と、ユーザー自身の「その人への気持ち」を区別する。気持ちは、記録にある本人の言葉に沿って書く。
- 気持ちの時期による移り変わりはchangeとして、時期とともに書く。新しい気持ちが古い気持ちを消したとは書かない。
- 同時にある、食い違って見える気持ち（大切に思う気持ちと、距離ができた寂しさ、など）は一つにまとめず、tensionとして両方の根拠を示す。
- 相手（その人物）の気持ち・意図・性格は推測しない。ユーザーの見方として話されていれば「〜と感じていると話している」と書く。
- 与えられていない別の人物の話を混ぜない。`;

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV === "production") return new Response("Not Found", { status: 404 });
  const providerName = resolveProviderForFeature("reflection");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) return Response.json({ error: "Gemini APIキーが設定されていません。" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { cluster?: SynthesisCluster } | null;
  const raw = body?.cluster;
  if (!raw || typeof raw.theme !== "string" || !Array.isArray(raw.evidence)) return Response.json({ error: "invalid body" }, { status: 400 });
  const cluster: SynthesisCluster = { theme: raw.theme.slice(0, 40), evidence: raw.evidence.slice(0, 12).map((e) => ({ ...e, summary: String(e.summary).slice(0, SYNTHESIS_LIMITS.summaryLength) })) };
  try {
    const response = await getProvider(providerName).generateStructured({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction: `${SYNTHESIS_SYSTEM_PROMPT}${PERSON_INSTRUCTIONS}`,
      userContent: renderClustersForModel([cluster]),
      maxOutputTokens: 4000,
      providerOptions: { gemini: { thinkingBudget: 512 } },
      schema: SYNTHESIS_SCHEMA,
    });
    const validation = validateSynthesisItems(JSON.parse(response.text), [cluster]);
    const gated = gateS1Items(validation.items, [cluster]);
    return Response.json({ items: gated.items, proposed: validation.proposed, dropped: { ...validation.dropped, ...(gated.dropped ? { "unhedged-cause": gated.dropped } : {}) } });
  } catch (error) {
    console.error("[Tsumugi Person Synthesis (experiment)] failed:", error instanceof Error ? error.message : String(error));
    return Response.json({ error: "Failed to generate." }, { status: 502 });
  }
}
