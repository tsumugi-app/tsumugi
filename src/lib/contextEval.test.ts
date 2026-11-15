/**
 * 自動評価基盤 E2：Memory Graph ON/OFF × 経緯 OFF/Timeline/Synthesis × Context Dedupe ON/OFF の 12 構成を、同じ架空データ・同じ質問・同じ固定時刻で比べる。
 *
 * - 会話の画面と同じ assembleChatContext（E1）で過去の文脈を組み立て、実際の /api/chat の処理でプロンプトを組み立てる。AI は偽物（呼び出しを数えるだけ）。
 * - 読み込み先は架空のデータ（contextEvalWorld.ts）。Memory Synthesis の仮説は、synthesisChat.ts の synthesisContextForTurn と同じ処理を、
 *   端末のキャッシュの代わりに架空の仮説で行う（生成はしない）。
 * - 結果：CI の概要に一覧表（contextEval.ts の formatSummaryMarkdown）。詳細は .eval-out/context-eval.json（CI は成果物として保存する）。
 * - 合否にするのは、壊れてはいけない条件だけ（再現性・AI呼び出し1回・診断の有無で同じプロンプト・AIの文章の区別・
 *   Context Builder が本人の理由・訂正を C にしないこと・どの経路も比較の中に出ること）。
 *   必須の根拠・本人の理由と訂正がプロンプトに届いたか・混入・文字数などは、現状を数値と一覧で記録する（現状の取りこぼしもそのまま示す。
 *   取りこぼしを直すのは Retrieval などの変更で、E2 の範囲ではない。品質低下の合否は E3 で基準を決めてから）。
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;

class StaleVaultTabError extends Error {}
let pool: MemoryObject[] = [];
const rec: { systemInstruction: string; calls: number } = { systemInstruction: "", calls: 0 };
const fakeProvider = {
  async generateStream(req: { systemInstruction?: string }) {
    rec.systemInstruction = req.systemInstruction ?? "";
    rec.calls += 1;
    return (async function* () { yield { text: "返答です。", finishReason: "stop" as const }; })();
  },
};
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveRequestedProvider: () => "gemini" },
  "./db": { getAllMemoryObjects: async () => pool, getAllConversations: async () => [], getMemoryObject: async (id: string) => pool.find((m) => m.id === id) },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn(), StaleVaultTabError },
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown; _resolveFilename: (request: string, ...rest: unknown[]) => string };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "@/lib/ai/resolve") return stubs[request];
  if ((parent?.filename?.startsWith(ROOT) ?? false) && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const asm = require(path.join(ROOT, "lib/chatContextAssembly.js")) as typeof import("./chatContextAssembly");
const r = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const { turnsForAi } = require(path.join(ROOT, "lib/aiReplyOutcome.js")) as typeof import("./aiReplyOutcome");
const { buildContextBuilderReport } = require(path.join(ROOT, "lib/contextBuilder.js")) as typeof import("./contextBuilder");
const { DEBUG_ENVELOPE_DELIMITER } = require(path.join(ROOT, "lib/generationDebugProtocol.js")) as typeof import("./generationDebugProtocol");
const { selectSynthesisForTurn } = require(path.join(ROOT, "lib/memorySynthesis.js")) as typeof import("./memorySynthesis");
const sm = require(path.join(ROOT, "lib/synthesisModel.js")) as typeof import("./synthesisModel");
const world = require(path.join(ROOT, "lib/contextEvalWorld.js")) as typeof import("./contextEvalWorld");
const ev = require(path.join(ROOT, "lib/contextEval.js")) as typeof import("./contextEval");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };
type EvalCase = import("./contextEvalWorld").EvalCase;
type EvalConfig = import("./contextEval").EvalConfig;
type RunResult = import("./contextEval").RunResult;
type GenerationDebugEnvelope = import("./generationDebugProtocol").GenerationDebugEnvelope;

async function post(body: Record<string, unknown>): Promise<{ systemInstruction: string; envelope: GenerationDebugEnvelope | null }> {
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const text = await res.text();
  const i = text.indexOf(DEBUG_ENVELOPE_DELIMITER);
  return { systemInstruction: rec.systemInstruction, envelope: i === -1 ? null : (JSON.parse(text.slice(i + DEBUG_ENVELOPE_DELIMITER.length)) as GenerationDebugEnvelope) };
}

interface Run { result: RunResult; prompt: string; aiCalls: number; debugSamePrompt: boolean; clientSent: Record<string, unknown> }

async function runOne(c: EvalCase, config: EvalConfig): Promise<Run> {
  const memories = world.evalMemories();
  pool = memories;
  const state = { hypotheses: world.evalHypotheses((label) => sm.themeSnapshot(label, memories).stateFingerprint, sm.keywordThemeId), reactions: [] as import("./synthesisModel").UserReaction[] };
  const turns = world.evalTurns(c);
  const text = c.turns[c.turns.length - 1];
  const ctx = await asm.assembleChatContext(
    { text, turns, conversationId: "c-now", persona: c.persona, now: () => Date.now() },
    {
      retrieve: (q, o) => r.retrieveRelevantMemoriesImpl(q, o),
      loadConfirmedAliasLists: async () => world.EVAL_ALIASES,
      loadConversations: async () => world.evalConversations(),
      loadMemories: async () => memories,
      // synthesisChat.ts の synthesisContextForTurn と同じ処理（端末のキャッシュの代わりに架空の仮説）
      synthesisContextForTurn: async (ms, turn) => {
        const { items, hypothesisIdByItem } = sm.usableItemsForChat(state, ms, Date.now());
        const contexts = sm.attachCorrections(selectSynthesisForTurn(items, turn, ms), state.reactions);
        return { contexts, shownIds: contexts.flatMap((x) => x.items.map((i) => hypothesisIdByItem.get(i)).filter((id): id is string => Boolean(id))) };
      },
      recordSynthesisShown: () => {},
    },
    { memoryGraph: () => config.memoryGraph, memoryTimeline: () => config.timeline === "Timeline", memorySynthesis: () => config.timeline === "Synthesis", diagnostics: () => true }
  );
  const report = buildContextBuilderReport(
    { question: text, earlierUserTurns: ctx.recentUserTurnsTexts.slice(0, -1), turnCount: turnsForAi(turns).length, retrievedMemories: ctx.retrievedMemories, recentConversation: ctx.recentConversation, topicContext: ctx.topicContext, profile: ctx.profileContext, personView: ctx.personViewContext, topicTimeline: ctx.topicTimelineContext, explicitSearch: ctx.explicitSearchContext, memoryAnalytics: ctx.memoryAnalyticsContext, memoryTimeline: ctx.memoryTimelineContext, personContext: ctx.personGraphContext, persona: c.persona, contextDedupe: config.contextDedupe },
    ctx.memoriesForProvenance
  );
  const base = { persona: c.persona, turns: turnsForAi(turns) };
  const fields = asm.chatContextRequestFields(ctx, { generationId: "gen-eval", contextDedupe: config.contextDedupe });
  rec.calls = 0;
  const debug = await post({ ...base, ...fields });
  const plain = await post({ ...base, ...asm.chatContextRequestFields(ctx, { contextDedupe: config.contextDedupe }) });
  const aiCalls = rec.calls / 2;
  const empty = await post({ ...base, retrievedMemories: [] });
  const env = debug.envelope;
  const counts = { ...(env?.provenance?.counts ?? {}) } as Record<string, number>;
  // routes the provenance does not list: counted from the values sent (the server builds a section for each non-empty one)
  if (ctx.recentConversation) counts["Recent Conversation"] = ctx.recentConversation.turns.length;
  if (ctx.profileContext) counts.Profile = ctx.profileContext.core.length + ctx.profileContext.relevant.length;
  if (ctx.personViewContext) counts["Person View"] = ctx.personViewContext.length;
  if (ctx.memoryAnalyticsContext) counts["Memory Analytics"] = ctx.memoryAnalyticsContext.results.length;
  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  const cls = (name: string) => report.relevance.classes.find((x) => x.relevance === name) ?? { count: 0, chars: 0 };
  const A = cls("直接根拠"), B = cls("関連する文脈"), C = cls("関連性の低い補助情報");
  const result = ev.evaluateRun({
    caseDef: c,
    config,
    systemInstruction: debug.systemInstruction,
    baselineChars: empty.systemInstruction.length,
    serverRouteCounts: counts,
    serverDuplicates: env?.provenance?.duplicates.length ?? 0,
    dedupeRemoved: env?.contextDedupe?.removed.length ?? 0,
    reasonsSent: env?.explicitReason?.sent.length ?? 0,
    abc: { A: A.count, B: B.count, C: C.count, Achars: A.chars, Bchars: B.chars, Cchars: C.chars },
    reasonStatus: report.relevance.reasons.status,
    aiTexts: { reflection: world.AI_TEXTS.reflection, hypotheses: [world.AI_TEXTS.hypothesisJob, world.AI_TEXTS.hypothesisYuki] },
  });
  return { result, prompt: debug.systemInstruction, aiCalls, debugSamePrompt: debug.systemInstruction === plain.systemInstruction, clientSent: fields };
}

async function runMatrix(): Promise<Run[]> {
  mock.timers.enable({ apis: ["Date"], now: world.EVAL_NOW });
  const quiet = mock.method(console, "log", () => {});
  const quietWarn = mock.method(console, "warn", () => {});
  try {
    const runs: Run[] = [];
    for (const c of world.EVAL_CASES) for (const config of ev.EVAL_CONFIGS) runs.push(await runOne(c, config));
    return runs;
  } finally {
    quiet.mock.restore();
    quietWarn.mock.restore();
    mock.timers.reset();
  }
}

const swapId = (id: string, part: 0 | 1 | 2, value: string) => id.split("-").map((p, i) => (i === part ? value : p)).join("-");

test("E2: the 12 configurations, the same fictional data, questions and fixed time — list in the CI summary, details in JSON", async () => {
  const runs = await runMatrix();
  const again = await runMatrix();
  assert.equal(runs.length, world.EVAL_CASES.length * ev.EVAL_CONFIGS.length);
  assert.equal(JSON.stringify(again.map((x) => [x.result, x.prompt])), JSON.stringify(runs.map((x) => [x.result, x.prompt])), "reproducible: the same conditions give the same prompts and results");
  const results = runs.map((x) => x.result);
  const prompts = new Map(runs.map((x) => [`${x.result.caseId}|${x.result.config}`, x.prompt] as const));
  const summaries = ev.EVAL_CONFIGS.map((c) => ev.summarizeConfig(c.id, results));
  const effects = [
    ev.flagEffect("Memory Graph", (c) => !c.memoryGraph, (id) => swapId(id, 0, "G1"), results, prompts, "OFF", "ON"),
    ev.flagEffect("経緯", (c) => c.timeline === "OFF", (id) => swapId(id, 1, "Timeline"), results, prompts, "OFF", "Timeline"),
    ev.flagEffect("経緯", (c) => c.timeline === "Timeline", (id) => swapId(id, 1, "Synthesis"), results, prompts, "Timeline", "Synthesis"),
    ev.flagEffect("経緯", (c) => c.timeline === "OFF", (id) => swapId(id, 1, "Synthesis"), results, prompts, "OFF", "Synthesis"),
    ev.flagEffect("Context Dedupe", (c) => !c.contextDedupe, (id) => swapId(id, 2, "D1"), results, prompts, "OFF", "ON"),
  ];
  const md = `${ev.formatSummaryMarkdown(summaries, effects, results, world.EVAL_CASES.map((c) => c.id))}\n\n${ev.formatShortfalls(results, runs.map((x) => ({ caseId: x.result.caseId, config: x.result.config, retrievedIds: ((x.clientSent.retrievedMemories ?? []) as { id: string }[]).map((m) => m.id) })))}`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  for (const l of md.split("\n").filter((l) => /^\| (G|ケース|[a-z]+-)/.test(l) || l.startsWith("- "))) console.log(`CI-REPORT context-eval ${l}`);
  for (const e of effects) console.log(`CI-REPORT context-eval effect ${e.setting} ${e.from}->${e.to}: identical ${e.identical}/${e.pairs}, required ${e.requiredDelta}, forbidden ${e.forbiddenDelta}, duplicates ${e.duplicatesDelta}, chars ${e.charsDelta}, changed: ${e.changedCases.join(",") || "none"}`);
  const out = path.join(process.cwd(), ".eval-out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "context-eval.json"), JSON.stringify({
    note: "自動評価 E2（架空データのみ・固定時刻・AIは呼ばない）。prompt はサーバーが組み立てた最終プロンプト。推定トークン＝文字数の粗い目安で、APIの実数ではない。A/B/C は端末の仮想判定。",
    now: new Date(world.EVAL_NOW).toISOString(),
    configs: ev.EVAL_CONFIGS,
    cases: world.EVAL_CASES,
    summaries,
    effects,
    runs: runs.map((x) => ({ ...x.result, clientSent: x.clientSent, prompt: x.prompt })),
  }, null, 1));

  // must hold in every configuration
  for (const x of runs) {
    const where = `${x.result.caseId} / ${x.result.config}`;
    assert.equal(x.aiCalls, 1, `one AI call per message: ${where}`);
    assert.ok(x.debugSamePrompt, `the diagnostics do not change the prompt: ${where}`);
    assert.deepEqual(x.result.aiUnlabelled, [], `the AI's texts reach the prompt only with their label: ${where}`);
    assert.notEqual(x.result.reasonStatus, "保護されていない", `the Context Builder never puts the user's reason / correction in C: ${where}`);
  }
  // Context Dedupe acts only on Memory Graph / Memory Timeline vs Retrieval: without them it changes nothing
  for (const c of world.EVAL_CASES) assert.equal(prompts.get(`${c.id}|G0-OFF-D1`), prompts.get(`${c.id}|G0-OFF-D0`), `dedupe alone has no effect: ${c.id}`);
  // the comparison exercised every route (a route that never appears would compare nothing)
  const seen = new Set(results.flatMap((x) => Object.keys(x.routes)));
  for (const route of ["Retrieval", "Recent Conversation", "Topic Timeline", "Memory Graph", "Memory Timeline", "Memory Synthesis", "Explicit Search"]) assert.ok(seen.has(route), `route ${route} appeared (${[...seen].join(", ")})`);
});

test("E2: the app is untouched — the evaluation files are read by tests only, and call no AI", () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const src = path.join(ROOT, "../src");
  const users = walk(src).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f) && !/contextEval(World)?\.ts$/.test(f)).filter((f) => /contextEval/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(users, [], "no app file imports the evaluation");
  for (const f of ["contextEval.ts", "contextEvalWorld.ts"]) {
    const code = fs.readFileSync(path.join(src, "lib", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, /fetch\(|localStorage|indexedDB|generate(Stream|Content)|from "\.\/db"/, f);
  }
});

