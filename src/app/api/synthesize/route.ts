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
同じユーザーが、別々の日に話した内容の記録（Memory）が、テーマごとに古い順に与えられます。各テーマの最後の記録が、そのテーマで最新の記録です。
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
- 最新の記録を必ず反映する。最新の記録で結果が出ていること（例：保留になった、完走した）を、まだ途中のように書かない。
- evidenceIdsには、根拠にした記録のidだけを、与えられたものからそのまま書く。1つのテーマの中の記録だけを使う。
- 性格・心理・病名・「〜な人」というラベル付けや診断をしない。動機や深層心理を推測しない。
- 行動の目的・役割（「〜のための手段」「〜を図る」「欲求」等）は、本人がそう話している場合だけ書く。話していなければ「〜した日に〜したと話している」のように、話した事実の組み合わせだけを書く。
- statementとsituationNoteは「〜と話していた」「〜と話している」の形で、記録された発言に沿って書く。内面の推移を断定しない。
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
  // Outcomes are kept apart for the caller: provider failure (502, failure "provider"), unusable model output after one retry (502, failure "invalid-output"),
  // and a successful call (200) whose status is "ok" (items kept), "no-proposals" (the model found nothing) or "all-rejected" (everything failed validation).
  let parsed: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      const response = await getProvider(providerName).generateStructured({
        model: resolveModel(providerName),
        apiKey,
        systemInstruction: SYSTEM_PROMPT,
        userContent: renderClustersForModel(clusters),
        maxOutputTokens: 2400,
        providerOptions: { gemini: { thinkingBudget: 512 } },
        schema: SCHEMA,
      });
      text = response.text;
    } catch (error) {
      console.error("[Tsumugi Synthesize] generateStructured failed:", error);
      return Response.json({ error: "Failed to generate a synthesis.", failure: "provider", attempts: attempt + 1 }, { status: 502 });
    }
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)) break;
    parsed = null;
  }
  if (!parsed) return Response.json({ error: "The AI output could not be used.", failure: "invalid-output", attempts: 2 }, { status: 502 });
  const result = validateSynthesisItems(parsed, clusters);
  const status = result.items.length > 0 ? "ok" : result.proposed === 0 ? "no-proposals" : "all-rejected";
  return Response.json({ status, ...result }, { headers: { "Server-Timing": `model;dur=${Date.now() - started}` } });
}
