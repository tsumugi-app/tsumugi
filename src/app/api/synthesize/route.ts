import type { AISchema } from "@/lib/ai/schema";
import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";
import { renderClustersForModel, validateSynthesisItems, SYNTHESIS_LIMITS, type SynthesisCluster } from "@/lib/memorySynthesis";

export const runtime = "nodejs";

/**
 * Memory Synthesis Phase 1 (experimental). ONE model call for a few small clusters that the client chose by code (`buildSynthesisClusters`).
 * Nothing is stored here; the result is returned to the caller only. The model's output is never trusted as is: `validateSynthesisItems` keeps only items whose
 * evidence ids are real and sufficient, and recomputes their dates from the evidence.
 */
const SYSTEM_PROMPT = `あなたはTsumugiという「Personal Memory OS」の一部です。
同じユーザーが、別々の日に話した内容の記録（Memory）が、テーマごとに時系列で与えられます。
複数の記録を並べたときに初めて見えるものだけを、短く整理してください。

出力する種類（該当するものだけ。無理に作らない。0件でもよい）：
- change（変化）：以前と最近とで、考え方・目標・状態が変わったこと。「以前は〜と話していたが、最近は〜と話している」の形で、両方の時点の記録を根拠にする。
- pattern（繰り返し）：3つ以上の別々の会話で繰り返し出てくる関心・判断の仕方・行動。
- tension（揺れ）：時期や状況によって望みや考えが違って見えること。矛盾と断定しない。状況の違い（situationNote）を必ず書く。状況の違いで説明できるなら、それを書く。

厳守すること：
- 根拠は与えられた記録だけ。記録に無い出来事・感情・理由・背景を足さない。
- evidenceIdsには、根拠にした記録のidだけを、与えられたものからそのまま書く。1つのテーマの中の記録だけを使う。
- basis：本人がその変化・繰り返しをはっきり話している場合だけ"explicit"。記録を並べてTsumugiがそう見えるだけなら"hypothesis"。tensionは常に"hypothesis"。
- 性格・心理・病名・「〜な人」というラベル付けや診断をしない。動機や深層心理を推測しない。
- 発言日（記録日）と出来事の時期は別のもの。発言日を出来事の日付として書かない。
- statementは、本人に向けて話す文ではなく、事実を整理した1〜2文（120文字程度まで）にする。日付は書かなくてよい（日付はシステムが根拠から付ける）。`;

const SCHEMA: AISchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["change", "pattern", "tension"] },
          statement: { type: "string", description: "記録から言えることの整理（1〜2文）" },
          basis: { type: "string", enum: ["explicit", "hypothesis"] },
          evidenceIds: { type: "array", items: { type: "string" }, description: "根拠にした記録のid（与えられたものだけ）" },
          situationNote: { type: "string", description: "tensionのとき必須：それぞれの時点の状況の違い。他の種類では空でよい" },
        },
        required: ["kind", "statement", "basis", "evidenceIds"],
      },
    },
  },
  required: ["items"],
};

function sanitizeClusters(raw: unknown): SynthesisCluster[] {
  if (!Array.isArray(raw)) return [];
  const out: SynthesisCluster[] = [];
  for (const c of raw.slice(0, SYNTHESIS_LIMITS.maxClusters)) {
    if (!c || typeof c !== "object" || typeof (c as { theme?: unknown }).theme !== "string" || !Array.isArray((c as { evidence?: unknown }).evidence)) continue;
    const evidence = ((c as { evidence: unknown[] }).evidence)
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .filter((e) => typeof e.id === "string" && typeof e.conversationId === "string" && typeof e.statedAt === "string" && Number.isFinite(Date.parse(e.statedAt as string)) && typeof e.summary === "string")
      .slice(0, SYNTHESIS_LIMITS.maxEvidencePerCluster)
      .map((e) => ({
        id: e.id as string,
        conversationId: e.conversationId as string,
        statedAt: e.statedAt as string,
        statedAtIsRecordDate: e.statedAtIsRecordDate === true,
        ...(typeof e.eventTime === "string" ? { eventTime: e.eventTime } : {}),
        summary: (e.summary as string).slice(0, SYNTHESIS_LIMITS.summaryLength),
        ...(typeof e.quote === "string" ? { quote: e.quote.slice(0, SYNTHESIS_LIMITS.quoteLength) } : {}),
      }));
    if (evidence.length >= 2) out.push({ theme: ((c as { theme: string }).theme).slice(0, 40), evidence });
  }
  return out;
}

export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("reflection");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) return Response.json({ error: "APIキーが設定されていません。" }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const clusters = sanitizeClusters((body as { clusters?: unknown } | null)?.clusters);
  if (clusters.length === 0) return Response.json({ error: "clusters is required" }, { status: 400 });

  const started = Date.now();
  let text: string;
  try {
    const response = await getProvider(providerName).generateStructured({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction: SYSTEM_PROMPT,
      userContent: renderClustersForModel(clusters),
      maxOutputTokens: 1600,
      providerOptions: { gemini: { thinkingBudget: 512 } },
      schema: SCHEMA,
    });
    text = response.text;
  } catch (error) {
    console.error("[Tsumugi Synthesize] generateStructured failed:", error);
    return Response.json({ error: "Failed to generate a synthesis." }, { status: 502 });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return Response.json({ error: "Failed to parse AI response as JSON." }, { status: 502 }); }
  const items = validateSynthesisItems(parsed, clusters);
  const proposed = parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items.length : 0;
  return Response.json({ items, proposed }, { headers: { "Server-Timing": `model;dur=${Date.now() - started}` } });
}
