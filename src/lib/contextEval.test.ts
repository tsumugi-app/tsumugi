/**
 * 自動評価基盤 E2：Memory Graph ON/OFF × 経緯 OFF/Timeline/Synthesis × Context Dedupe ON/OFF の 12 構成を、同じ架空データ・同じ質問・同じ固定時刻で比べる。
 *
 * - 会話の画面と同じ assembleChatContext（E1）で過去の文脈を組み立て、実際の /api/chat の処理でプロンプトを組み立てる。AI は偽物（呼び出しを数えるだけ）。
 * - 読み込み先は架空のデータ（contextEvalWorld.ts）。Memory Synthesis の仮説は、synthesisChat.ts の synthesisContextForTurn と同じ処理を、
 *   端末のキャッシュの代わりに架空の仮説で行う（生成はしない）。
 * - 結果：CI の概要に一覧表（contextEval.ts の formatSummaryMarkdown）。詳細は .eval-out/context-eval.json に書く
 *   （CI の成果物として残すには ci.yml に upload-artifact の手順が要る。この PR の時点では無い：ワークフローの変更は別途）。
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
const prov = require(path.join(ROOT, "lib/chatContextProvenance.js")) as typeof import("./chatContextProvenance");
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

async function post(body: Record<string, unknown>): Promise<{ systemInstruction: string; envelope: GenerationDebugEnvelope | null; webSearch: boolean; calls: number }> {
  rec.systemInstruction = "";
  const before = rec.calls;
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal(res.status, 200, "the chat route answered");
  const text = await res.text();
  const i = text.indexOf(DEBUG_ENVELOPE_DELIMITER);
  return { systemInstruction: rec.systemInstruction, envelope: i === -1 ? null : (JSON.parse(text.slice(i + DEBUG_ENVELOPE_DELIMITER.length)) as GenerationDebugEnvelope), webSearch: res.headers.get("X-Tsumugi-Web-Search-Requested") === "true", calls: rec.calls - before };
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
  const debug = await post({ ...base, ...fields });
  const plain = await post({ ...base, ...asm.chatContextRequestFields(ctx, { contextDedupe: config.contextDedupe }) });
  const empty = await post({ ...base, retrievedMemories: [] });
  const aiCalls = Math.max(debug.calls, plain.calls);
  assert.ok(debug.calls === 1 && plain.calls === 1 && empty.calls === 1 && empty.systemInstruction.length > 0, "one AI call per request, each with a prompt");
  const env = debug.envelope;
  // entries per route, all from what the server accepted: the provenance entries (one Memory may give several: a summary, the user's words, a reason line),
  // and, for the routes the provenance does not list, the accepted values (turns, facts, people, results)
  const counts = { ...(env?.provenance?.counts ?? {}) } as Record<string, number>;
  const acc = env?.serverAccepted;
  if (acc?.recentConversation) counts["Recent Conversation"] = acc.recentConversation.turns.length;
  if (acc?.profile) counts.Profile = acc.profile.core.length + acc.profile.relevant.length;
  if (acc?.personView) counts["Person View"] = acc.personView.length;
  if (acc?.memoryAnalyticsServerAccepted) counts["Memory Analytics"] = acc.memoryAnalyticsServerAccepted.resultCount;
  for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
  const cls = (name: string) => report.relevance.classes.find((x) => x.relevance === name) ?? { count: 0, chars: 0 };
  const A = cls("直接根拠"), B = cls("関連する文脈"), C = cls("関連性の低い補助情報");
  const result = ev.evaluateRun({
    caseDef: c,
    config,
    systemInstruction: debug.systemInstruction,
    baselineChars: empty.systemInstruction.length,
    serverRouteCounts: counts,
    // the server leaves ids empty for routes without them (Topic Continuity / Topic Timeline): fill them from what the client sent, as the [D] view does
    serverDuplicates: env?.provenance ? prov.withSentIds(env.provenance, prov.buildContextProvenance(
      { retrievedMemories: ctx.retrievedMemories, topicContinuity: ctx.topicContext, topicTimeline: ctx.topicTimelineContext, memoryTimeline: ctx.memoryTimelineContext, personContext: ctx.personGraphContext, explicitSearch: ctx.explicitSearchContext },
      {
        topicContinuityId: (ref) => ctx.memoriesForProvenance.find((m) => m.summary === ref.summary && m.date === ref.date)?.id,
        topicTimelineId: (event) => ctx.memoriesForProvenance.find((m) => (m.topicEvents ?? []).some((e) => e.quote === event.quote && e.statedAt === event.time && e.sourceConversationId === event.sourceConversationId))?.id,
      }
    )).duplicates.length : 0,
    dedupeRemoved: env?.contextDedupe?.removed.length ?? 0,
    reasonsSent: env?.explicitReason?.sent.length ?? 0,
    // Retrieval records the server did not put into its Retrieval section: not moved to the Explicit Search, not removed as an exact duplicate
    // (those are listed apart), i.e. left out by its filters. Another route may still carry the same Memory.
    serverDroppedRetrieval: ctx.retrievedMemories.map((m) => m.id).filter((id) => !(acc?.retrievedMemory ?? []).some((m) => m.id === id) && !(ctx.explicitSearchContext?.results ?? []).some((m) => m.id === id) && !(env?.contextDedupe?.removed ?? []).some((p) => p.route === "Retrieval" && p.memoryId === id)),
    webSearch: debug.webSearch,
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
  // the user's correction with 今の (job-3) is a wish of that time, not today's state: the server's time filter keeps it in Retrieval in all 12
  // configurations, with Memory Timeline / Synthesis OFF too, and the user's words reach the prompt in the Retrieval section
  const CORRECTION = "チームを離れたくなかった";
  // a reason question, asked (reason-job) or put forward against the AI's reading (contradict-job): the device Retrieval selects the correction
  // before the AI reflection, and the user's own sentence (not only the AI summary) reaches the Retrieval section, in all 12 configurations
  const OWN_WORDS = "本人の発言（当時の逐語の抜粋）：「給料って言ったけど、本当は今のチームを離れたくなかったからなんだ」";
  for (const x of runs.filter((r) => r.result.caseId === "reason-job" || r.result.caseId === "contradict-job")) {
    const where = `${x.result.caseId} / ${x.result.config}`;
    const sent = ((x.clientSent.retrievedMemories ?? []) as { id: string }[]).map((m) => m.id);
    assert.ok(sent.includes("job-3"), `the device Retrieval selects the correction: ${where} (${sent.join(", ")})`);
    if (sent.includes("job-refl")) assert.ok(sent.indexOf("job-3") < sent.indexOf("job-refl"), `the user's words before the AI reflection: ${where} (${sent.join(", ")})`);
    assert.ok(!x.result.serverDroppedRetrieval.includes("job-3"), `the time filter keeps the correction: ${where}`);
    assert.equal(x.result.protectedOk, true, `the correction reaches the prompt: ${where}`);
    const at: string[] = [];
    for (let i = x.prompt.indexOf(CORRECTION); i !== -1; i = x.prompt.indexOf(CORRECTION, i + 1)) at.push(ev.sectionAt(x.prompt, i));
    assert.ok(at.some((h) => h.startsWith("関連する過去の記憶")), `in the Retrieval section: ${where} (${at.join(" / ")})`);
    const own = x.prompt.indexOf(OWN_WORDS);
    assert.ok(own !== -1 && ev.sectionAt(x.prompt, own).startsWith("関連する過去の記憶"), `the user's own sentence in the Retrieval section: ${where}`);
  }
  // the AI's hypothesis never reaches a turn without the user's correction it contradicts
  for (const x of runs.filter((r) => r.prompt.includes(world.AI_TEXTS.hypothesisJob))) assert.ok(x.prompt.includes(CORRECTION), `hypothesis with the correction: ${x.result.caseId} / ${x.result.config}`);
  // the correction does not reach questions about something else, chat-weather included (its weak overlaps 「し、」「たい」 no longer pick job-3 / job-refl
  // in companion; the outing record yuki-4 stays)
  for (const x of runs.filter((r) => !["reason-job", "contradict-job"].includes(r.result.caseId))) assert.ok(!x.prompt.includes(CORRECTION), `no correction in an unrelated question: ${x.result.caseId} / ${x.result.config}`);
  for (const x of runs.filter((r) => r.result.caseId === "chat-weather")) {
    const sent = ((x.clientSent.retrievedMemories ?? []) as { id: string }[]).map((m) => m.id);
    assert.deepEqual(sent, ["yuki-4"], `chat-weather: ${x.result.config} (${sent.join(", ")})`);
    assert.deepEqual(x.result.forbiddenHits, [], `chat-weather mixes nothing in: ${x.result.config}`);
  }
  // Topic Continuity: a turn that names a topic no record has (火星旅行・陶芸教室) gets no topic candidate; a turn whose topic a record has
  // (ロードバイク) and a turn with no topic word (「さっきの話の続き…」) keep the topic-bike candidate, in every configuration
  const topicIds = (x: Run) => ((x.clientSent.topicContext ?? []) as { topicId: string }[]).map((t) => t.topicId);
  for (const x of runs.filter((r) => r.result.caseId === "none-mars" || r.result.caseId === "none-pottery")) {
    assert.deepEqual(topicIds(x), [], `no topic candidate: ${x.result.caseId} / ${x.result.config}`);
    assert.deepEqual(x.result.forbiddenHits, [], `nothing mixed in: ${x.result.caseId} / ${x.result.config}`);
  }
  for (const x of runs.filter((r) => r.result.caseId === "fact-bike-price" || r.result.caseId === "recent-continue")) {
    assert.deepEqual(topicIds(x), ["topic-bike"], `the topic candidate stays: ${x.result.caseId} / ${x.result.config}`);
  }
  // change-yuki: the Retrieval itself carries the change of the relationship (the start and the change), so the routes that are off by default
  // (Timeline / Memory Graph) are not needed for it; nothing about another person comes in
  for (const x of runs.filter((r) => r.result.caseId === "change-yuki")) {
    const sent = ((x.clientSent.retrievedMemories ?? []) as { id: string }[]).map((m) => m.id);
    for (const id of ["yuki-1", "yuki-3", "yuki-4"]) assert.ok(sent.includes(id), `change-yuki ${x.result.config}: ${id} (${sent.join(", ")})`);
    assert.ok(sent.every((id) => id.startsWith("yuki-")), `change-yuki ${x.result.config}: only ゆうきさん (${sent.join(", ")})`);
    assert.deepEqual(x.result.forbiddenHits, [], `change-yuki mixes nothing in: ${x.result.config}`);
  }
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

