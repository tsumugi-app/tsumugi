import { getProvider, resolveApiKey, resolveModel, resolveProviderForFeature } from "@/lib/ai/resolve";
import { renderClustersForModel, SYNTHESIS_LIMITS, validateSynthesisItems, type SynthesisCluster, type SynthesisEvidence } from "@/lib/memorySynthesis";
import { renderReactionChecksForModel, renderRejectedForModel, SYNTHESIS_S1_INSTRUCTIONS, SYNTHESIS_S1_SCHEMA, SYNTHESIS_SYSTEM_PROMPT } from "@/lib/memorySynthesisPrompt";
import { gateS1Items, keywordThemeId, SYNTHESIS_S1_LIMITS, textSimilarity, validateReactions, type ReactionCheck } from "@/lib/synthesisModel";

export const runtime = "nodejs";

/**
 * Memory Synthesis S1 (trial, default OFF): one generation call for the themes the client chose by code (synthesisModel.planGeneration), after a session
 * ended. Stateless: nothing is stored here, no Memory is read or written. The client keeps the result in its own Synthesis database (never a Memory).
 * Everything the model returns is gated here: items by validateSynthesisItems (real evidence ids, one theme, enough evidence, no unfounded psychology),
 * items resembling a reading the user rejected are dropped, and reactions by validateReactions (a verbatim denial of the user, or nothing).
 */
const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");

function sanitizeClusters(raw: unknown): SynthesisCluster[] {
  if (!Array.isArray(raw)) return [];
  const out: SynthesisCluster[] = [];
  for (const c of raw.slice(0, SYNTHESIS_S1_LIMITS.maxThemesPerRun)) {
    if (!c || typeof c !== "object") continue;
    const theme = str((c as { theme?: unknown }).theme, 40).trim();
    const evidenceRaw = (c as { evidence?: unknown }).evidence;
    if (!theme || !Array.isArray(evidenceRaw)) continue;
    const evidence: SynthesisEvidence[] = [];
    for (const e of evidenceRaw.slice(0, SYNTHESIS_LIMITS.maxEvidencePerCluster)) {
      if (!e || typeof e !== "object") continue;
      const x = e as Record<string, unknown>;
      const id = str(x.id, 80);
      const statedAt = str(x.statedAt, 40);
      const summary = str(x.summary, SYNTHESIS_LIMITS.summaryLength).trim();
      if (!id || !Number.isFinite(Date.parse(statedAt)) || !summary) continue;
      evidence.push({
        id,
        conversationId: str(x.conversationId, 80),
        statedAt,
        statedAtIsRecordDate: x.statedAtIsRecordDate === true,
        ...(typeof x.eventTime === "string" ? { eventTime: str(x.eventTime, 20) } : {}),
        summary,
        ...(typeof x.quote === "string" && x.quote.trim() ? { quote: str(x.quote, SYNTHESIS_LIMITS.quoteLength) } : {}),
      });
    }
    if (evidence.length >= 2) out.push({ theme, evidence });
  }
  return out;
}

function sanitizeChecks(raw: unknown): ReactionCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: ReactionCheck[] = [];
  for (const c of raw.slice(0, SYNTHESIS_S1_LIMITS.maxReactionChecks)) {
    if (!c || typeof c !== "object") continue;
    const x = c as Record<string, unknown>;
    const userTurns = Array.isArray(x.userTurns)
      ? x.userTurns.slice(0, SYNTHESIS_S1_LIMITS.maxUserTurnsPerCheck).flatMap((t) => {
          const turn = t as Record<string, unknown>;
          const text = str(turn?.text, SYNTHESIS_S1_LIMITS.userTurnLength).trim();
          const at = str(turn?.at, 40);
          return text && Number.isFinite(Date.parse(at)) ? [{ text, at }] : [];
        })
      : [];
    const check: ReactionCheck = {
      hypothesisId: str(x.hypothesisId, 120),
      theme: str(x.theme, 40),
      statement: str(x.statement, SYNTHESIS_LIMITS.maxStatementLength),
      conversationId: str(x.conversationId, 80),
      shownAt: str(x.shownAt, 40),
      tsumugiReply: str(x.tsumugiReply, SYNTHESIS_S1_LIMITS.tsumugiReplyLength),
      userTurns,
    };
    if (check.hypothesisId && check.statement && userTurns.length > 0) out.push(check);
  }
  return out;
}

function sanitizeRejected(raw: unknown): { theme: string; statement: string; userQuote: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, SYNTHESIS_S1_LIMITS.maxRejectedSent).flatMap((r) => {
    const x = (r ?? {}) as Record<string, unknown>;
    const theme = str(x.theme, 40).trim();
    const statement = str(x.statement, SYNTHESIS_LIMITS.maxStatementLength).trim();
    return theme && statement ? [{ theme, statement, userQuote: str(x.userQuote, SYNTHESIS_S1_LIMITS.userTurnLength) }] : [];
  });
}

export async function POST(request: Request) {
  const providerName = resolveProviderForFeature("reflection");
  const apiKey = resolveApiKey(request, providerName);
  if (!apiKey) return Response.json({ error: "Gemini APIキーが設定されていません。" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const clusters = sanitizeClusters(body.clusters);
  const checks = sanitizeChecks(body.checks);
  const rejected = sanitizeRejected(body.rejected);
  if (clusters.length === 0 && checks.length === 0) return Response.json({ items: [], reactions: [], proposed: 0, dropped: {} });

  const provider = getProvider(providerName);
  let text: string;
  try {
    const response = await provider.generateStructured({
      model: resolveModel(providerName),
      apiKey,
      systemInstruction: `${SYNTHESIS_SYSTEM_PROMPT}${SYNTHESIS_S1_INSTRUCTIONS}`,
      userContent: `${renderClustersForModel(clusters)}${renderRejectedForModel(rejected)}${renderReactionChecksForModel(checks)}`,
      maxOutputTokens: 4000,
      providerOptions: { gemini: { thinkingBudget: 512 } },
      schema: SYNTHESIS_S1_SCHEMA,
    });
    text = response.text;
  } catch (error) {
    console.error("[Tsumugi Synthesize] generateStructured failed:", error);
    return Response.json({ error: "Failed to generate a synthesis." }, { status: 502 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ error: "Failed to parse AI response as JSON." }, { status: 502 });
  }
  const validation = validateSynthesisItems(parsed, clusters);
  const gated = gateS1Items(validation.items, clusters);
  const items = gated.items.filter(
    (item) => !rejected.some((r) => keywordThemeId(r.theme) === keywordThemeId(item.theme) && textSimilarity(item.statement, r.statement) >= 0.35)
  );
  const dropped = {
    ...validation.dropped,
    ...(gated.dropped > 0 ? { "unhedged-cause": gated.dropped } : {}),
    ...(items.length < gated.items.length ? { "resembles-rejected": gated.items.length - items.length } : {}),
  };
  // returned in the model's own shape, so that the client can (and does) run the same gate again against what it sent
  const reactions = validateReactions(parsed, checks).map((r) => ({ hypothesisId: r.hypothesisId, reaction: r.kind, userQuote: r.userQuote }));
  return Response.json({ items, reactions, proposed: validation.proposed, dropped });
}
