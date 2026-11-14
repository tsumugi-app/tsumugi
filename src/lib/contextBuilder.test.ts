/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * P1-H 段階1：Context Builder（診断専用）のテスト。架空のデータだけ（長男・咲さん・車・アイデアは作りもの）。
 *   - 設計調査の8ケースで、現行の入力（チャット画面が実際に作るリクエストの値）と、Context Builderを適用した仮想の入力を比べる
 *   - 重要なMemory・本人の理由・訂正を失わない／人物を統合しない／AIの仮説を本人の言葉にしない／保留は渡す側／安全側の戻し
 *   - 診断の表示の順序が、実際のプロンプトの順序と同じ
 *   - 診断のON/OFFで、送る内容とプロンプトが同じ／Capture・Connect・Vault・既存Memoryに触れない／AI呼び出しを増やさない
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
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
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn() },
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
const cb = require(path.join(ROOT, "lib/contextBuilder.js")) as typeof import("./contextBuilder");
const r = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const pc = require(path.join(ROOT, "lib/personContext.js")) as typeof import("./personContext");
const person = require(path.join(ROOT, "lib/person.js")) as typeof import("./person");
const syn = require(path.join(ROOT, "lib/memorySynthesis.js")) as typeof import("./memorySynthesis");
const tc = require(path.join(ROOT, "lib/topicContinuity.js")) as typeof import("./topicContinuity");
const ms = require(path.join(ROOT, "lib/memorySearch.js")) as typeof import("./memorySearch");
const ma = require(path.join(ROOT, "lib/memoryAnalytics.js")) as typeof import("./memoryAnalytics");
const profile = require(path.join(ROOT, "lib/profile.js")) as typeof import("./profile");
const te = require(path.join(ROOT, "lib/topicEvent.js")) as typeof import("./topicEvent");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };

type SynthesisItem = import("./memorySynthesis").SynthesisItem;
type PersonMention = import("./types").PersonMention;
type Report = import("./contextBuilder").ContextBuilderReport;
type Input = import("./contextBuilder").ContextBuilderInput;

function mention(name: string, quote: string, at: string, relation?: PersonMention["relation"]): PersonMention {
  return { id: `pm-${name}-${at}`, groupingKey: name, displayName: name, ...(relation ? { relation } : {}), assertion: "mention", stated: "explicit", quote, statedAt: at, sourceConversationId: "c", recordedAt: at, origin: "ai-extracted", schemaVersion: 1 };
}
interface Opt { quotes?: string[]; who?: [string, PersonMention["relation"]?]; source?: string; topicId?: string; types?: string[]; event?: boolean }
function mem(id: string, day: string, summary: string, keywords: string[], opt: Opt = {}): MemoryObject {
  const at = `${day}T10:00:00.000Z`;
  const quotes = opt.quotes ?? [summary];
  return {
    id, date: at, statedAt: at, types: opt.types ?? ["conversation"], conversationId: `c-${id}`, content: quotes.join(" "), summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at,
    evidenceQuotes: quotes,
    ...(opt.topicId ? { topicId: opt.topicId } : {}),
    ...(opt.topicId && opt.event ? { topicEvents: [{ id: `te-${id}`, topicId: opt.topicId, quote: quotes[0] ?? summary, statedAt: at, sourceConversationId: `c-${id}`, recordedAt: at, origin: "ai-extracted", schemaVersion: 1 }] } : {}),
    ...(opt.who ? { personMentions: [mention(opt.who[0], quotes[0] ?? summary, at, opt.who[1])] } : {}),
    metadata: { id: `meta-${id}`, source: opt.source ?? "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

const POOL: MemoryObject[] = [
  mem("c1", "2026-10-01", "見た目で一番好きなのはGX。その次にNX、RX", ["車", "GX", "レクサス"], { topicId: "t-car" }),
  mem("c2", "2026-10-20", "NXかアウトランダーかなぁと迷っている", ["車", "NX", "アウトランダー"], { quotes: ["NXかアウトランダーかなぁ"], topicId: "t-car" }),
  mem("c3", "2026-10-29", "次の車は室内の広い車が欲しい", ["車", "室内"], { quotes: ["次の車は室内が広いのが欲しい"], topicId: "t-car" }),
  mem("s1", "2026-09-10", "長男がレゴで独創的な車を作った", ["長男", "レゴ", "車"], { quotes: ["長男がレゴで独創的な車を作ってた"], who: ["長男", "child"], topicId: "t-son", event: true }),
  mem("s2", "2026-09-20", "長男の運動会でリレーに出た", ["長男", "運動会"], { who: ["長男", "child"], topicId: "t-son", event: true }),
  mem("s3", "2026-10-05", "長男をお迎えに行った", ["長男", "お迎え"], { who: ["長男", "child"], topicId: "t-son" }),
  mem("s4", "2026-10-20", "長男とSwitchで遊んだ", ["長男", "Switch"], { who: ["長男", "child"], topicId: "t-son" }),
  mem("s5", "2026-10-28", "長男が次男の面倒を見ていた", ["長男", "次男"], { who: ["長男", "child"], topicId: "t-son" }),
  mem("k1", "2026-08-01", "咲さんともっと二人で過ごしたいと思っていた", ["咲さん", "二人"], { quotes: ["咲さんともっと二人で過ごしたい"], who: ["咲さん", "friend"], topicId: "t-saki", event: true }),
  mem("k2", "2026-08-20", "咲さんとの関係には未来がないと話した", ["咲さん", "関係"], { quotes: ["正直、咲さんとの関係に未来はない"], who: ["咲さん", "friend"], topicId: "t-saki", event: true }),
  mem("k3", "2026-09-05", "咲さんとの関係に未来がない理由は、自分が既婚者だからだと説明した", ["咲さん", "未来"], { quotes: ["咲さんとの関係に未来がないと言ったのは、自分が既婚者だから。"], who: ["咲さん", "friend"], topicId: "t-saki", event: true }),
  mem("k4", "2026-08-21", "咲さんとの距離が遠くなり、冷たくされたと感じて未来がないと思っているようだ", ["咲さん", "関係"], { source: "system-generated", quotes: [] }),
  mem("k5", "2026-10-15", "最近は咲さんを友人として大切にしたいと考えるようになった", ["咲さん", "友人"], { quotes: ["今は咲さんを友人として大切にしたいと思うようになった"], who: ["咲さん", "friend"], topicId: "t-saki" }),
  mem("k6", "2026-10-25", "咲さんとカフェでランチした", ["咲さん", "カフェ"], { who: ["咲さん", "friend"] }),
  mem("i1", "2026-09-15", "地域の子ども向けにプログラミング教室を開くアイデア", ["アイデア", "プログラミング", "教室"], { types: ["idea"] }),
  mem("i2", "2026-10-10", "古い車を改装してキッチンカーにするアイデア", ["アイデア", "キッチンカー", "車"], { types: ["idea"] }),
  mem("m1", "2026-10-30", "最近仕事が忙しくて疲れている", ["仕事", "疲れ"]),
  mem("m2", "2026-10-02", "週末に過去の写真を整理した", ["整理", "写真"]),
  mem("m3", "2026-10-12", "睡眠不足で集中できない", ["睡眠", "集中"]),
];
const ITEMS: SynthesisItem[] = [
  { kind: "pattern", theme: "長男", statement: "遊びや学校行事の記録から、長男の成長を見守っている様子がうかがえるのかもしれない", support: "hypothesis", evidenceIds: ["s1", "s2", "s3"], firstStatedAt: "2026-09-10T10:00:00.000Z", lastStatedAt: "2026-10-05T10:00:00.000Z" },
  { kind: "pattern", theme: "咲さん", statement: "咲さんに近づきたい気持ちと距離を取る気持ちが揺れているのかもしれない", support: "hypothesis", evidenceIds: ["k1", "k2", "k5"], firstStatedAt: "2026-08-01T10:00:00.000Z", lastStatedAt: "2026-10-15T10:00:00.000Z" },
];
const HYPOTHESES = [ITEMS[0].statement, ITEMS[1].statement, POOL.find((m) => m.id === "k4")!.summary];

interface Case { q: string; needed: string[]; key: string[]; why: string; earlier?: string[] }
const CASES: Case[] = [
  { q: "前にどんな車が欲しいと言った？", needed: ["c1", "c2", "c3"], key: [], why: "具体的な過去の事実（本人の希望）" },
  { q: "長男がレゴで何を作った？", needed: ["s1"], key: [], why: "具体的な過去の事実（人物の行動）" },
  { q: "以前、咲さんとどうなりたいと思っていた？", needed: ["k1"], key: [], why: "人間関係（本人の望み）" },
  { q: "咲さんとの関係について考え方はどう変わった？", needed: ["k1", "k2", "k5"], key: ["k3", "k5"], why: "考え方の変化（時系列）" },
  { q: "未来がないと言った理由は？", needed: ["k2", "k3"], key: ["k3"], why: "本人の理由（後からの説明）", earlier: ["咲さんのことを少し話したい"] },
  { q: "以前のアイデアを使って新しい企画を考えたい", needed: ["i1", "i2"], key: [], why: "アイデアの相談" },
  { q: "なんだか最近疲れる", needed: [], key: [], why: "日常会話（押し込まない）" },
  { q: "前に何の話をしたっけ？", needed: [], key: [], why: "漠然とした振り返り" },
];
const T = "2026-11-01T03:00:00.000Z";
const RECENT = { id: "conv-prev", endedAt: "2026-10-31T12:00:00.000Z", elapsedMs: 3_600_000, turns: [{ role: "user" as const, content: "咲さんとの関係について、少しだけ整理したい", timestamp: "2026-10-31T11:50:00.000Z" }, { role: "assistant" as const, content: "うん、ゆっくり整理しよう。", timestamp: "2026-10-31T11:51:00.000Z" }] };

/** the request body's values, built the way ChatScreen builds them (every trial route ON, Synthesis items given) */
async function bodyFor(c: Case, extra: Partial<Input> = {}): Promise<Input> {
  pool = POOL;
  const q = c.q;
  const reflective = r.isReflectiveQuery(q);
  const earlier = c.earlier ?? [];
  const retrievedMemories = await r.retrieveRelevantMemoriesImpl(q, {
    excludeConversationId: "now", limit: reflective ? r.REFLECTIVE_LIMIT : undefined, maxLinkedAdditions: reflective ? r.REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
    persona: "companion", recentUserTurnsTexts: [...earlier, q], includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance: true,
  });
  const memoryAnalytics = ma.buildMemoryAnalyticsContext(POOL, q, { excludeConversationId: "now" });
  const explicitSearch = memoryAnalytics === null ? ms.buildExplicitSearchContext(POOL, q, { excludeConversationId: "now" }) : null;
  const topicContext = tc.buildTopicContinuityPayload(POOL, q);
  const selectedProfile = profile.selectProfileContext(profile.computeProfileFacts(POOL), { userTexts: [q] });
  const retrievedIds = new Set(retrievedMemories.map((m) => m.id));
  const relevant = POOL.filter((m) => retrievedIds.has(m.id));
  const keys = new Set(relevant.flatMap((m) => (m.personMentions ?? []).map((p) => p.groupingKey)));
  let personView = keys.size > 0 ? person.computePersonViews(POOL).filter((v) => keys.has(v.groupingKey)).slice(0, person.PERSON_VIEW_CONTEXT_LIMIT) : null;
  if (personView && personView.length === 0) personView = null;
  const topicIds = [...new Set(relevant.map((m) => m.topicId).filter((id): id is string => Boolean(id)))].slice(0, te.TOPIC_TIMELINE_BUDGET.maxTopics);
  const timelines = topicIds.length > 0 ? te.computeTopicTimelines(POOL, topicIds) : [];
  const personContext = pc.selectPersonContextsForTurn(POOL, { userText: q, earlierUserTurns: earlier, excludeConversationId: "now", alreadyGivenIds: retrievedMemories.map((m) => m.id), aliases: [] });
  personView = pc.withoutCoveredPersonViews(personView, personContext);
  const memoryTimeline = syn.selectTimelineForTurn(POOL, { userText: q, retrievedMemoryIds: retrievedMemories.map((m) => m.id) }, ITEMS);
  return {
    question: q, earlierUserTurns: earlier, turnCount: 1, retrievedMemories,
    recentConversation: null, topicContext, profile: selectedProfile.core.length + selectedProfile.relevant.length > 0 ? selectedProfile : null,
    personView, topicTimeline: timelines.length > 0 ? timelines : null, explicitSearch, memoryAnalytics, memoryTimeline, personContext,
    ...extra,
  };
}
/** the fetch body as ChatScreen writes it from the same values */
function fetchBody(input: Input, debug: boolean) {
  return {
    persona: "companion",
    turns: [{ role: "user", content: input.question, timestamp: T }],
    retrievedMemories: input.retrievedMemories,
    ...(input.recentConversation ? { recentConversation: input.recentConversation } : {}),
    ...(input.topicContext ? { topicContext: input.topicContext } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.personView ? { personView: input.personView } : {}),
    ...(input.topicTimeline ? { topicTimeline: input.topicTimeline } : {}),
    ...(input.explicitSearch ? { explicitSearch: input.explicitSearch } : {}),
    ...(input.memoryAnalytics ? { memoryAnalytics: input.memoryAnalytics } : {}),
    ...(input.memoryTimeline && input.memoryTimeline.length > 0 ? { memoryTimeline: input.memoryTimeline } : {}),
    ...(input.personContext && input.personContext.length > 0 ? { personContext: input.personContext } : {}),
    ...(debug ? { debugGenerationId: "gen-test" } : {}),
  };
}
async function prompt(body: Record<string, unknown>) {
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  await res.text();
  return rec.systemInstruction;
}
const idsOf = (report: Report, which: "current" | "virtual") => new Set(report.decisions.filter((d) => which === "current" || d.decision !== "除外").flatMap((d) => d.memoryIds));
const deepFreeze = <T,>(x: T): T => {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  }
  return x;
};

const reports = new Map<string, Report>();
async function reportFor(c: Case): Promise<Report> {
  const got = reports.get(c.q);
  if (got) return got;
  const input = await bodyFor(c);
  const report = cb.buildContextBuilderReport(input, POOL);
  reports.set(c.q, report);
  return report;
}

test("1 the 8 survey cases: the virtual input keeps every needed Memory and every reason / correction (the comparison table is printed)", async () => {
  const rows = ["| 質問 | 種類 | 現行 | 仮想 | 保留 | 除外 | 必要なMemory | 本人の理由・訂正 | AIの仮説が本人の理由より前（現行→仮想） |", "|---|---|---|---|---|---|---|---|---|"];
  for (const c of CASES) {
    const report = await reportFor(c);
    const cur = idsOf(report, "current");
    const vir = idsOf(report, "virtual");
    const neededHere = c.needed.filter((id) => cur.has(id));
    for (const id of neededHere) assert.ok(vir.has(id), `${c.q}: the needed ${id} is kept`);
    assert.deepEqual(report.explanations.lost, [], `${c.q}: no reason / correction lost`);
    assert.equal(report.explanations.virtual, report.explanations.current, c.q);
    for (const id of c.key) {
      const inCurrent = report.decisions.some((d) => d.memoryIds.includes(id) && d.kind !== "AIの仮説");
      if (inCurrent) assert.ok(report.decisions.some((d) => d.memoryIds.includes(id) && d.kind !== "AIの仮説" && d.decision !== "除外"), `${c.q}: the user's words of ${id} stay`);
    }
    assert.equal(report.hypotheses.beforeExplanationVirtual, false, `${c.q}: in the virtual input no AI hypothesis comes before the user's reasons`);
    for (const d of report.decisions) {
      if (d.decision === "除外") assert.equal(d.virtualIndex, null);
      else assert.notEqual(d.virtualIndex, null, "保留 is still passed in the virtual input");
      if (d.explanation || d.personLine) assert.ok(d.decision !== "除外" || d.why.startsWith("完全な重複"), `${c.q}: a reason / a person line is never excluded except as an exact duplicate`);
    }
    rows.push(`| ${c.q}（${c.why}） | ${report.question.types.join("・")} | ${report.totals.current.count}件・${report.totals.current.chars}字 | ${report.totals.virtual.count}件・${report.totals.virtual.chars}字 | ${report.totals.hold} | ${report.totals.excluded} | ${neededHere.length}/${c.needed.length}（仮想も同じ） | ${report.explanations.status} ${report.explanations.current}→${report.explanations.virtual} | ${report.hypotheses.beforeExplanationCurrent ? "はい" : "いいえ"}→${report.hypotheses.beforeExplanationVirtual ? "はい" : "いいえ"} |`);
  }
  const out = ["## Context Builder 段階1（架空データ・8ケース）", ...rows].join("\n");
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`);
});

test("2 people are never merged: each piece names only the people of its own source", async () => {
  const personsOf = (id: string) => (POOL.find((m) => m.id === id)?.personMentions ?? []).map((p) => p.displayName);
  for (const c of CASES) {
    const report = await reportFor(c);
    for (const d of report.decisions) {
      assert.ok(!(d.persons.includes("長男") && d.persons.includes("咲さん")), `${c.q}: ${d.route} ${d.text}`);
      if (d.route === "Memory Graph" || d.route === "PersonView") continue; // the block's / the view's person
      const own = new Set(d.memoryIds.flatMap(personsOf));
      for (const p of d.persons) assert.ok(own.has(p), `${c.q}: ${d.route} ${d.memoryIds.join(",")} names ${p}, which its records do not`);
    }
    // a person who is in the current input keeps a line saying who they are, if they had one
    for (const p of report.persons) if (p.lineCurrent && p.virtual > 0) assert.ok(p.lineVirtual, `${c.q}: ${p.name} keeps the person line`);
  }
});

test("3 the AI's hypotheses are never the user's words, and they are not limited to questions about a change", async () => {
  for (const c of CASES) {
    const report = await reportFor(c);
    for (const d of report.decisions) {
      const isHyp = HYPOTHESES.some((h) => h.startsWith(d.text.replace(/…$/, "")));
      if (isHyp) assert.equal(d.kind, "AIの仮説", `${c.q}: ${d.text}`);
      if (d.kind === "本人の発言" || d.kind === "後からの本人の説明・訂正") assert.ok(!isHyp, `${c.q}: a hypothesis labelled as the user's words`);
    }
  }
  // a question about a wish / a view (not a change) still gets the related hypothesis about the same person
  const view = await reportFor(CASES[2]);
  const hyp = view.decisions.filter((d) => d.kind === "AIの仮説" && d.persons.includes("咲さん"));
  if (hyp.length > 0) assert.ok(hyp.some((d) => d.decision === "採用"), JSON.stringify(hyp));
  // the reason question: the user's later reason is kept and comes before every hypothesis in the virtual input
  const reason = await reportFor(CASES[4]);
  assert.ok(reason.question.types.includes("理由"), reason.question.types.join(","));
  assert.ok(reason.decisions.some((d) => d.memoryIds.includes("k3") && d.decision === "採用"), "the later reason k3 is kept");
});

test("4 the same Memory ID with different information is kept apart; a copy without an ID on the wire is not compared (uncertain: kept)", () => {
  const retrieved = [{ id: "k3", date: "2026-09-05T10:00:00.000Z", summary: POOL[10].summary, keywords: ["咲さん", "未来"], source: "ai-capture" as const, quote: "咲さんとの関係に未来がないと言ったのは、自分が既婚者だから。", persons: ["咲さん"] }];
  const topicContext = [{ topicId: "t-saki", memories: [{ date: "2026-09-05T10:00:00.000Z", summary: POOL[10].summary, keywords: ["咲さん", "未来"] }] }];
  const report = cb.buildContextBuilderReport({ question: "咲さんとの未来の話、前にどう言った？", turnCount: 1, retrievedMemories: retrieved as never, topicContext }, POOL);
  const k3 = report.decisions.filter((d) => d.memoryIds.includes("k3"));
  assert.ok(k3.some((d) => d.route === "Retrieval" && d.kind === "本人の発言" && d.decision !== "除外"), "the user's words of the same Memory stay");
  assert.ok(k3.some((d) => d.route === "Topic Continuity" && d.decision !== "除外"), "the first copy of the summary stays");
  const dup = k3.find((d) => d.route === "Retrieval" && d.kind === "AIの要約");
  // the Topic Continuity copy has no Memory ID on the wire (the device found it by its summary): the reduction does not rely on that guess
  assert.notEqual(dup?.decision, "除外", "an uncertain duplicate is kept");
  assert.deepEqual(report.dedupe.removed, []);
  assert.ok(report.sameMemory.some((s) => s.memoryId === "k3"));
  assert.equal(report.exactDuplicates.length, 1, "the diagnosis still shows the same text twice");
  assert.deepEqual(report.lostMemoryIds, [], "the Memory itself is not lost");
});

test("5 no reason in the candidates: the report says so and does not present a hypothesis as the reason", async () => {
  const input = await bodyFor({ q: "長男がレゴで車を作った理由は？", needed: [], key: [], why: "" });
  const report = cb.buildContextBuilderReport(input, POOL);
  if (report.explanations.current === 0) {
    assert.equal(report.explanations.status, "候補に無し");
    assert.ok(cb.formatContextBuilderReport(report).includes("候補に無し（AIの仮説を本人の理由として扱わない）"));
  }
  assert.ok(report.decisions.every((d) => d.kind !== "後からの本人の説明・訂正" || !HYPOTHESES.some((h) => h.startsWith(d.text.replace(/…$/, "")))));
});

test("6 everyday talk keeps a natural link to the past and pushes nothing out", async () => {
  const report = await reportFor(CASES[6]);
  assert.deepEqual(report.question.types, ["日常"]);
  assert.equal(report.totals.excluded, report.dedupe.removed.length, "only the exact duplicates the reduction takes out are excluded");
  const retrieval = report.decisions.filter((d) => d.route === "Retrieval");
  if (retrieval.length > 0) assert.ok(retrieval.some((d) => d.decision === "採用"), "the top record stays as a natural link");
});

test("7 the safe side: a question that cannot be read keeps the current input as it is", async () => {
  for (const q of ["それってどうだったっけ？", ""]) {
    const input = await bodyFor({ q: "咲さんとの関係について考え方はどう変わった？", needed: [], key: [], why: "" });
    const report = cb.buildContextBuilderReport({ ...input, question: q }, POOL);
    assert.ok(report.question.fallback, q);
    for (const d of report.decisions) assert.ok(d.decision === "採用" || d.why.startsWith("完全な重複"), `${q}: ${d.decision} ${d.why}`);
  }
  // a vague look back with no topic and no person: nothing is excluded by relevance either
  const vague = await reportFor(CASES[7]);
  assert.ok(vague.decisions.every((d) => d.decision !== "除外" || d.why.startsWith("完全な重複")), JSON.stringify(vague.decisions.filter((d) => d.decision === "除外")));
});

test("8 the diagnostic order is the prompt order (every piece found in the real system instruction, in order)", async () => {
  const input = await bodyFor(CASES[3], { recentConversation: RECENT });
  const sys = await prompt(fetchBody(input, false));
  const { units } = cb.collectContextUnits(input, POOL);
  assert.ok(units.length > 10, `${units.length} pieces`);
  // the sections, in the order of PROMPT_SECTIONS
  const sections = cb.PROMPT_SECTIONS.filter((s) => units.some((u) => s.routes.includes(u.route)));
  const at = sections.map((s) => sys.indexOf(s.heading));
  assert.ok(at.every((i) => i >= 0), sections.map((s, k) => `${s.heading}:${at[k]}`).join(" "));
  assert.ok(at.every((i, k) => k === 0 || i > at[k - 1]), sections.map((s, k) => `${s.heading}:${at[k]}`).join(" "));
  // every piece, walking the prompt forward
  let cursor = 0;
  for (const u of units) {
    const probe = u.route === "Memory Graph" && u.personLine ? u.text.split("：")[1].split("　")[0] : u.text;
    const i = sys.indexOf(probe, cursor);
    assert.ok(i >= 0, `${u.index} ${u.route} ${u.part}「${probe}」 not found after ${cursor}`);
    cursor = i;
  }
  for (const route of ["Recent Conversation", "Memory Graph", "Memory Synthesis", "Retrieval"] as const) assert.ok(units.some((u) => u.route === route), route);
});

test("9 diagnostics on or off: the same request values, the same prompt, the same number of AI calls", async () => {
  const input = deepFreeze(structuredClone(await bodyFor(CASES[4], { recentConversation: RECENT })));
  const before = JSON.stringify(input);
  const snapshot = JSON.stringify(POOL);
  rec.calls = 0;
  const off = await prompt(fetchBody(input, false));
  const report = cb.buildContextBuilderReport(input, POOL);
  cb.formatContextBuilderReport(report);
  let on = await prompt(fetchBody(input, true));
  // the prompt carries the current minute: if it just rolled over, compare once more
  if (on !== off) on = (await prompt(fetchBody(input, false))) === (await prompt(fetchBody(input, true))) ? off : on;
  assert.equal(JSON.stringify(input), before, "the request values are not changed (frozen, so a write would throw)");
  assert.equal(JSON.stringify(POOL), snapshot, "the Memories are not changed");
  assert.equal(on, off, "the same prompt with the debug on or off");
  assert.ok(rec.calls === 2 || rec.calls === 4, `only the chat calls of this test (${rec.calls}): the builder calls no AI`);
  const onBody: Record<string, unknown> = { ...fetchBody(input, true) };
  delete onBody.debugGenerationId;
  assert.deepEqual(onBody, fetchBody(input, false), "the body differs only by the existing debug id");
  // the chat screen: the report is built inside the debug block, before the fetch, and the fetch body never reads it
  const screen = fs.readFileSync(path.join(ROOT, "../src/components/ChatScreen.tsx"), "utf8");
  const call = screen.indexOf("contextBuilderReport = buildContextBuilderReport(");
  const fetchAt = screen.indexOf('const res = await fetch("/api/chat"');
  assert.ok(call > 0 && fetchAt > call, "built before the request");
  const guard = screen.lastIndexOf("if (generationId) {", call);
  assert.ok(guard > 0 && screen.slice(guard, call).split("\n").length <= 4, "inside the debug (?debugLog=1) block");
  assert.ok(screen.slice(call, fetchAt).includes("} catch (error) {"), "a failure is caught: the message is still sent");
  const body = screen.slice(fetchAt, screen.indexOf("if (!res.ok || !res.body)", fetchAt));
  assert.ok(!/contextBuilder|ContextBuilder/.test(body), "the fetch body does not use the report");
  assert.ok(!fs.readFileSync(path.join(ROOT, "../src/app/api/chat/route.ts"), "utf8").includes("contextBuilder"), "the chat route does not change");
});

test("10 Capture, Connect, the Vault and the saved Memories are untouched; no storage, no AI call, no network", () => {
  const src = (f: string) => fs.readFileSync(path.join(ROOT, "../src", f), "utf8");
  for (const f of ["lib/contextBuilder.ts", "lib/contextBuilderStore.ts", "lib/contextDedupe.ts"]) {
    const s = src(f).split("\n").filter((l) => /^import /.test(l)).join("\n");
    assert.ok(!/\/db"|vault|Vault|\/ai\/|capture|connect"|storage|outbox/i.test(s), `${f} imports: ${s}`);
    const body = src(f).replace(/^\s*(?:\*|\/\/).*$/gm, "");
    assert.ok(!/fetch\(|localStorage|sessionStorage|indexedDB|IndexedDB|putMemoryObject|putConversation|generateStream/.test(body), f);
  }
  for (const f of ["lib/capture.ts", "lib/connect.ts", "lib/db.ts", "lib/vault.ts", "app/api/chat/route.ts"]) {
    if (fs.existsSync(path.join(ROOT, "../src", f))) assert.ok(!src(f).includes("contextBuilder"), f);
  }
});

test("11 the report: what 保留 means, per-route counts and characters, and the debug text", async () => {
  const report = await reportFor(CASES[3]);
  assert.ok(report.holdMeaning.includes("仮想の入力にも渡す"));
  const sum = report.routes.reduce((n, x) => n + x.current.count, 0);
  assert.equal(sum, report.totals.current.count);
  assert.equal(report.routes.reduce((n, x) => n + x.virtual.chars, 0), report.totals.virtual.chars);
  assert.ok(report.decisions.every((d) => Array.from(d.text).length <= cb.CONTEXT_BUILDER_LIMITS.clipChars + 1), "only short clips are kept");
  const text = cb.formatContextBuilderReport(report);
  for (const part of ["段階1の判定は診断専用", "OFF：送る内容は従来どおり", "判定の意味", "■ 経路ごとの件数・文字数", "■ 本人の理由・訂正", "■ AIの仮説", "■ 人物", "■ 同じMemoryの別の情報", "■ 同じ本文の重複", "■ 重複の削減（段階2-A）", "■ 判定（プロンプトの順）"]) assert.ok(text.includes(part), part);
});

test("12 review: a pointer or a time word is not a topic; a statement (not a question) is everyday talk; a theme / a Graph name counts", async () => {
  const input = await bodyFor({ q: "咲さんとの関係について考え方はどう変わった？", needed: [], key: [], why: "" });
  for (const q of ["あの件はどうなった？", "先週の話だけど、あれどうなった？"]) {
    const report = cb.buildContextBuilderReport({ ...input, question: q }, POOL);
    assert.ok(report.question.fallback, `${q}: ${report.question.terms.join(",")}`);
  }
  for (const q of ["ドライブしたい", "昨日カフェに行った"]) {
    const report = cb.buildContextBuilderReport({ ...input, question: q }, POOL);
    assert.deepEqual(report.question.types, ["日常"], q);
    assert.equal(report.totals.excluded, report.dedupe.removed.length, `${q}: everyday talk pushes nothing out`);
  }
  // a Memory Timeline point chosen for its theme is about the theme even when its own words differ
  const theme = [{ theme: "引っ越し", state: { status: "不明" }, timeline: [{ memoryId: "mv1", statedAt: "2026-10-01T10:00:00.000Z", statedAtIsRecordDate: false, summary: "新居の契約を済ませた", retrospective: false, latestSaid: true, latestEvent: false, stateBasis: true }], items: [] }];
  const moved = cb.buildContextBuilderReport({ question: "前に引っ越しについて何て言った？", turnCount: 1, memoryTimeline: theme as never }, POOL);
  assert.ok(moved.decisions.some((d) => d.route === "Memory Timeline" && d.decision === "採用"), JSON.stringify(moved.decisions));
  assert.deepEqual(moved.lostMemoryIds, []);
  // a name the Memory Graph matched (an alias) counts as the person asked about
  const graph = [{ key: "咲", names: ["さきちゃん"], conclusions: [{ statement: { kind: "user", text: "さきちゃんとはもう会わないと決めた", day: "2026-09-01", memoryId: "g1" }, role: "judgment", reasons: [], aiReadings: [] }], plans: [], events: [{ kind: "summary", text: "カフェでランチした", day: "2026-10-01", memoryId: "g2" }], candidates: [], memoryIds: ["g1", "g2"] }];
  const alias = cb.buildContextBuilderReport({ question: "さきちゃんとの将来について前にどう思っていた？", turnCount: 1, personContext: graph as never }, POOL);
  assert.ok(alias.question.persons.includes("さきちゃん"), alias.question.persons.join(","));
  assert.ok(alias.decisions.filter((d) => d.route === "Memory Graph").every((d) => d.decision !== "除外"), JSON.stringify(alias.decisions));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// P1-H 段階2-A：完全な重複の削減（contextDedupe.ts、機能フラグ既定OFF）。架空のデータだけ
// ---------------------------------------------------------------------------------------------------------------------------------

const dd = require(path.join(ROOT, "lib/contextDedupe.js")) as typeof import("./contextDedupe");
const DELIM = (require(path.join(ROOT, "lib/generationDebugProtocol.js")) as typeof import("./generationDebugProtocol")).DEBUG_ENVELOPE_DELIMITER;
const occurrences = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);
/** two prompts built in the same minute (the prompt carries the current minute) */
async function pair(a: Record<string, unknown>, b: Record<string, unknown>): Promise<[string, string]> {
  for (let k = 0; k < 3; k++) {
    const x = await prompt(a);
    const y = await prompt(b);
    if ((await prompt(a)) === x) return [x, y];
  }
  throw new Error("the minute kept rolling over");
}
async function envelope(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const text = await res.text();
  const at = text.indexOf(DELIM);
  return at < 0 ? null : (JSON.parse(text.slice(at + DELIM.length)) as Record<string, unknown>);
}
/** every piece of the diagnosis, found in the prompt in the same order */
function walk(units: import("./contextBuilder").ContextUnit[], sys: string, label: string) {
  let cursor = 0;
  for (const u of units) {
    const probe = u.route === "Memory Graph" && u.personLine ? u.text.split("：")[1].split("　")[0] : u.text;
    const i = sys.indexOf(probe, cursor);
    assert.ok(i >= 0, `${label}: ${u.index} ${u.route} ${u.part}「${probe}」 not found after ${cursor}`);
    cursor = i;
  }
}
const report = (lines: string[]) => {
  for (const l of lines) console.log(`CI-REPORT ${l}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
};

// the three duplicates of the device log, in fictional words
const S1 = "長男の運動会でリレーのアンカーを走った";
const S2 = "長男と次男が公園で一緒に自転車の練習をした";
const S3 = "長男が次男の宿題を見てあげた";
const S4 = "長男の担任の先生と面談した";
const REASON = "自分が厳しく育てられて苦しかったから";
const point = (memoryId: string, day: string, summary: string, extra: Record<string, unknown> = {}) => ({ memoryId, statedAt: `${day}T10:00:00.000Z`, statedAtIsRecordDate: true, summary, retrospective: false, latestSaid: false, latestEvent: false, stateBasis: false, ...extra });
const themeOf = (points: unknown[], theme = "長男") => [{ theme, state: { status: "不明" }, timeline: points, items: [] }];
const said = (memoryId: string, day: string, text: string, kind = "summary") => ({ kind, text, day, memoryId });
const retr = (id: string, day: string, summary: string, extra: Record<string, unknown> = {}) => ({ id, date: `${day}T10:00:00.000Z`, summary, keywords: ["長男"], source: "ai-capture", persons: ["長男"], ...extra });
const GRAPH = [
  { key: "長男", names: ["長男"], relation: { label: "子" }, conclusions: [{ statement: said("d5", "2026-09-01", "長男にはのびのび育ってほしい", "user"), role: "thought", reasons: [{ ...said("d6", "2026-10-10", REASON, "user"), when: "later" }], aiReadings: [] }], plans: [], events: [said("d1", "2026-09-20", S1), said("d2", "2026-10-04", S2)], candidates: [], memoryIds: [] },
  { key: "次男", names: ["次男"], conclusions: [], plans: [], events: [said("d2", "2026-10-04", S2)], candidates: [], memoryIds: [] },
];
/** turn 1: the Memory Graph and the Memory Timeline carry the same summaries (運動会; 長男と次男) */
const SCENE_X = { personContext: GRAPH, memoryTimeline: themeOf([point("d1", "2026-09-20", S1), point("d2", "2026-10-04", S2), point("d3", "2026-10-28", S3, { latestSaid: true })]), retrievedMemories: [retr("d4", "2026-10-30", S4)] };
/** turn 2: the Memory Timeline and Retrieval carry the same summary (運動会) */
const SCENE_Y = { memoryTimeline: themeOf([point("d1", "2026-09-20", S1), point("d3", "2026-10-28", S3, { latestSaid: true })]), retrievedMemories: [retr("d1", "2026-09-20", S1), retr("d4", "2026-10-30", S4)] };
const Q = "長男のこと、どうだったっけ？";
const chatBody = (scene: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ persona: "companion", turns: [{ role: "user", content: Q, timestamp: T }], ...scene, ...extra });

test("13 the device log's three duplicates: the later copy leaves the real prompt with the flag ON; OFF is the prompt as before", async () => {
  // turn 1: Memory Graph → Memory Timeline (運動会; 長男と次男)
  const [offX, onX] = await pair(chatBody(SCENE_X), chatBody(SCENE_X, { contextDedupe: true }));
  assert.equal(occurrences(offX, S1), 2, "OFF: 運動会 twice (Memory Graph and Memory Timeline), as before");
  assert.equal(occurrences(onX, S1), 1, "ON: 運動会 once");
  assert.equal(occurrences(offX, S2), 3, "OFF: 長男と次男 under both people and in the Memory Timeline");
  assert.equal(occurrences(onX, S2), 2, "ON: kept under both people (two people are not merged), gone from the Memory Timeline");
  for (const kept of [S3, S4, REASON, "関係（記録を作ったAIの分類）：子", "### 長男", "### 次男", "## 複数の会話にわたる経緯", "## 関連する過去の記憶"]) assert.ok(onX.includes(kept), `ON keeps ${kept}`);
  // the time series stays: every point keeps its date and place; only the duplicated summary becomes a short reference
  const tl = onX.slice(onX.indexOf("## 複数の会話にわたる経緯"));
  const at = ["2026-09-20に記録: （上の人物「長男」と同じ記録）", "2026-10-04に記録: （上の人物「長男」と同じ記録）", `2026-10-28に記録（最後に話した記録）: ${S3}`].map((x) => tl.indexOf(x));
  assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `the three points in order: ${at.join(",")}`);
  // turn 2: Memory Timeline → Retrieval (運動会)
  const [offY, onY] = await pair(chatBody(SCENE_Y), chatBody(SCENE_Y, { contextDedupe: true }));
  assert.equal(occurrences(offY, S1), 2);
  assert.equal(occurrences(onY, S1), 1, "ON: the Retrieval copy leaves; the Memory Timeline copy (with its date in the time series) stays");
  assert.ok(onY.indexOf(S1) < onY.indexOf("## 関連する過去の記憶") && onY.includes(S4), "the earlier copy stays; the other record of Retrieval stays");
  // anything but true is OFF
  const [offAgain, junk] = await pair(chatBody(SCENE_X), chatBody(SCENE_X, { contextDedupe: "1" }));
  assert.equal(junk, offAgain, "a flag that is not true changes nothing");

  // the server says what it actually took out (only with the debug id); OFF adds nothing to the debug envelope either
  const envOn = await envelope(chatBody(SCENE_X, { contextDedupe: true, debugGenerationId: "g1" }));
  const envOff = await envelope(chatBody(SCENE_X, { debugGenerationId: "g1" }));
  const server = envOn?.contextDedupe as import("./contextDedupe").ServerDedupeReport;
  assert.deepEqual(server.removed.map((x) => [x.route, x.memoryId, x.keptIn]), [["Memory Timeline", "d1", "Memory Graph"], ["Memory Timeline", "d2", "Memory Graph"]]);
  assert.ok(server.sectionChars.after < server.sectionChars.before, JSON.stringify(server.sectionChars));
  assert.ok(envOff && !("contextDedupe" in envOff), "OFF: the envelope is as before");
  assert.ok(dd.formatServerDedupeReport(server).includes("外した2件"));
  const envY = (await envelope(chatBody(SCENE_Y, { contextDedupe: true, debugGenerationId: "g2" })))?.contextDedupe as import("./contextDedupe").ServerDedupeReport;
  assert.deepEqual(envY.removed.map((x) => [x.route, x.memoryId, x.keptIn]), [["Retrieval", "d1", "Memory Timeline"]]);

  // the client's diagnosis shows the same pieces: OFF as 除外 (would leave), ON already gone from the current input
  for (const [scene, sys, ids] of [[SCENE_X, onX, ["d1", "d2"]], [SCENE_Y, onY, ["d1"]]] as const) {
    const base = { question: Q, turnCount: 1, ...(scene as Record<string, unknown>), persona: "companion" } as unknown as Input;
    const off = cb.buildContextBuilderReport(base, POOL);
    const on = cb.buildContextBuilderReport({ ...base, contextDedupe: true }, POOL);
    assert.deepEqual(on.dedupe.removed, off.dedupe.removed);
    assert.deepEqual(off.dedupe.removed.map((x) => x.memoryId), ids);
    for (const id of ids) assert.ok(off.decisions.some((d) => d.memoryIds[0] === id && d.kind === "AIの要約" && d.decision === "除外" && d.why.startsWith("完全な重複")), `OFF shows ${id} as the duplicate that ON takes out`);
    assert.equal(off.totals.current.chars - on.totals.current.chars, on.dedupe.removedChars, "the characters taken out");
    assert.equal(off.explanations.current, on.explanations.current, "no reason / correction lost");
    assert.deepEqual(off.persons.map((p) => [p.name, p.lineCurrent]), on.persons.map((p) => [p.name, p.lineCurrent]), "no person line lost");
    walk(cb.collectContextUnits({ ...base, contextDedupe: true }, POOL).units, sys, "ON order");
    assert.ok(cb.formatContextBuilderReport(on).includes("ON（下のものは実際に送っていない）"));
  }
  report([
    "## 段階2-A：実機ログの3件（架空データ）",
    "| 場面 | OFFのプロンプト | ONのプロンプト | 外したもの |",
    "|---|---|---|---|",
    `| 1ターン目（Memory Graph→Memory Timeline） | ${Array.from(offX).length}字 | ${Array.from(onX).length}字 | ${server.removed.map((x) => `${x.route} ${x.memoryId}「${x.text}」`).join("／")} |`,
    `| 2ターン目（Memory Timeline→Retrieval） | ${Array.from(offY).length}字 | ${Array.from(onY).length}字 | ${envY.removed.map((x) => `${x.route} ${x.memoryId}「${x.text}」`).join("／")} |`,
  ]);
});

test("14 kept when unsure or when the later copy says more: another text, another kind, another day, a time-series mark, the user's words, a person, analyst", () => {
  const T1 = "長男が水泳の検定に合格して、家族みんなで喜んだ";
  const other = point("x0", "2026-09-01", "長男と図書館に行った");
  const plan = (graph: unknown[], timeline: unknown[], retrieved: unknown[] = [], persona = "companion") =>
    dd.dedupeExactContext({ persona, personContext: graph as never, memoryTimeline: themeOf(timeline) as never, retrievedMemories: retrieved as never });
  const block = (...events: unknown[]) => [{ key: "長男", names: ["長男"], conclusions: [], plans: [], events, candidates: [], memoryIds: [] }];
  // the plain case is taken out
  assert.equal(plan(block(said("n1", "2026-10-01", T1)), [point("n1", "2026-10-01", T1), other]).removed.length, 1);
  // a time-series mark keeps the Memory Timeline point
  for (const extra of [{ eventTime: "2026-09" }, { status: "保留" }, { retrospective: true }, { stateBasis: true }, { latestSaid: true }]) {
    const r = plan(block(said("n1", "2026-10-01", T1)), [point("n1", "2026-10-01", T1, extra), other]);
    assert.equal(r.removed.length, 0, JSON.stringify(extra));
    assert.equal(r.kept.length, 1, JSON.stringify(extra));
  }
  // another day, another text, another kind (the user's words), the last point of a theme
  assert.match(plan(block(said("n1", "2026-10-02", T1)), [point("n1", "2026-10-01", T1), other]).kept[0].why, /話した日/);
  assert.deepEqual(plan(block(said("n1", "2026-10-01", `${T1}。`)), [point("n1", "2026-10-01", T1), other]).removed, []);
  assert.deepEqual(plan(block(said("n1", "2026-10-01", T1, "user")), [point("n1", "2026-10-01", T1), other]).removed, []);
  assert.deepEqual(plan(block(said("n2", "2026-10-01", T1)), [point("n1", "2026-10-01", T1), other]).removed, [], "another Memory ID");
  assert.match(plan(block(said("n1", "2026-10-01", T1)), [point("n1", "2026-10-01", T1)]).kept[0].why, /空になる/);
  assert.match(plan(block(said("n1", "2026-10-01", "長男が泳いだ")), [point("n1", "2026-10-01", "長男が泳いだ"), other]).kept[0].why, /参照より短い/, "a reference never makes the prompt longer");

  // Retrieval: anything the earlier copy does not carry keeps the record
  const tl = [point("r1", "2026-10-01", T1), other];
  const second = retr("z9", "2026-10-30", S4);
  assert.equal(plan([], tl, [retr("r1", "2026-10-01", T1), second]).removed.length, 1, "the plain case is taken out");
  for (const extra of [{ keywords: ["長男", "成長"] }, { quote: "検定に受かったよ" }, { trait: "質問の記録" }, { linkReason: "水泳の話が続いている" }, { isOriginMemory: true }, { source: "user-authored" }, { persons: ["次男"] }, { eventTime: "2026-09-30" }, { date: "2026-10-03T10:00:00.000Z" }]) {
    const r = plan([], tl, [retr("r1", "2026-10-01", T1, extra), second]);
    assert.equal(r.removed.length, 0, JSON.stringify(extra));
    assert.equal(r.kept.length, 1, JSON.stringify(extra));
  }
  assert.equal(plan([], tl, [retr("r1", "2026-10-01", T1, { source: "system-generated" }), second]).removed.length, 0, "a Reflection is another kind");
  assert.match(plan([], tl, [retr("r1", "2026-10-01", T1), second], "analyst").kept[0].why, /分析モード/);
  assert.match(plan([], tl, [retr("r1", "2026-10-01", T1)]).kept[0].why, /空になる/);
  assert.match(plan([], tl, [retr("r1", "2026-10-01", T1), retr("rf", "2026-10-05", "日記の振り返り", { source: "system-generated" })]).kept[0].why, /空になる/, "a Reflection does not keep the section");
  // the same record in two themes is two meanings; each theme is compared with the Memory Graph only, the Memory Graph keeps everything
  const two = dd.dedupeExactContext({ personContext: block(said("n1", "2026-10-01", T1)) as never, memoryTimeline: [...themeOf([point("n1", "2026-10-01", T1), other]), ...themeOf([point("n1", "2026-10-01", T1), other], "水泳")] as never, retrievedMemories: [] });
  assert.deepEqual(two.removed.map((x) => x.theme), ["長男", "水泳"]);
  // the values passed in are never changed
  const frozen = deepFreeze(structuredClone({ g: block(said("n1", "2026-10-01", T1)), t: themeOf([point("n1", "2026-10-01", T1), other]), r: [retr("r1", "2026-10-01", T1), second] }));
  const before = JSON.stringify(frozen);
  dd.dedupeExactContext({ personContext: frozen.g as never, memoryTimeline: frozen.t as never, retrievedMemories: frozen.r as never });
  assert.equal(JSON.stringify(frozen), before);
});

test("15 the eight survey cases with the flag ON: the real prompt keeps every needed Memory, reason, person line and order (table: before → after)", async () => {
  const rows = ["## 段階2-A：8ケースの変更前後（架空データ・実際のプロンプト）", "| 質問 | 入力の件数・文字数（OFF→ON） | プロンプト全体の文字数（OFF→ON） | 外したもの | 同じ本文だが残したもの |", "|---|---|---|---|---|"];
  for (const c of CASES) {
    const input = await bodyFor(c, { recentConversation: RECENT });
    const offBody = fetchBody(input, false) as Record<string, unknown>;
    const [offSys, onSys] = await pair(offBody, { ...offBody, contextDedupe: true });
    const off = cb.buildContextBuilderReport({ ...input, persona: "companion" }, POOL);
    const on = cb.buildContextBuilderReport({ ...input, persona: "companion", contextDedupe: true }, POOL);
    assert.deepEqual(on.dedupe.removed, off.dedupe.removed, `${c.q}: the same pieces`);
    if (off.dedupe.removed.length === 0) assert.equal(onSys, offSys, `${c.q}: nothing to take out, the same prompt`);
    for (const x of off.dedupe.removed) {
      const probe = x.text.replace(/…$/, "");
      const times = off.dedupe.removed.filter((y) => y.text === x.text).length;
      assert.equal(occurrences(onSys, probe), occurrences(offSys, probe) - times, `${c.q}: ${x.memoryId} once less`);
      assert.ok(onSys.includes(probe), `${c.q}: ${x.memoryId} still in the prompt (the earlier copy)`);
    }
    const offIds = idsOf(off, "current");
    const onIds = idsOf(on, "current");
    for (const id of offIds) assert.ok(onIds.has(id), `${c.q}: ${id} is not lost`);
    assert.equal(on.explanations.current, off.explanations.current, `${c.q}: no reason / correction lost`);
    assert.deepEqual(on.persons.map((p) => [p.name, p.lineCurrent]), off.persons.map((p) => [p.name, p.lineCurrent]), `${c.q}: no person merged or lost`);
    for (const d of on.decisions) if (d.kind === "本人の発言" || d.kind === "後からの本人の説明・訂正") assert.ok(!HYPOTHESES.some((h) => h.startsWith(d.text.replace(/…$/, ""))), `${c.q}: a hypothesis as the user's words`);
    walk(cb.collectContextUnits({ ...input, persona: "companion", contextDedupe: true }, POOL).units, onSys, c.q);
    rows.push(`| ${c.q} | ${off.totals.current.count}件・${off.totals.current.chars}字 → ${on.totals.current.count}件・${on.totals.current.chars}字 | ${Array.from(offSys).length} → ${Array.from(onSys).length} | ${off.dedupe.removed.map((x) => `${x.route} ${x.memoryId}（${x.keptIn}に残る）`).join("／") || "なし"} | ${off.dedupe.kept.map((x) => `${x.route} ${x.memoryId}：${x.why}`).join("／") || "なし"} |`);
  }
  report(rows);
});

test("16 the flag: default OFF, the request gains a field only when ON, the server decides with the same function, no extra AI call", async () => {
  const screen = fs.readFileSync(path.join(ROOT, "../src/components/ChatScreen.tsx"), "utf8");
  const fetchAt = screen.indexOf('const res = await fetch("/api/chat"');
  const body = screen.slice(fetchAt, screen.indexOf("if (!res.ok || !res.body)", fetchAt));
  assert.ok(body.includes("...(contextDedupeOn ? { contextDedupe: true } : {})"), "OFF adds nothing to the request");
  const flag = fs.readFileSync(path.join(ROOT, "../src/lib/contextDedupeFlag.ts"), "utf8");
  assert.ok(flag.includes('.get("contextDedupe") === "1"') && !/getItem|setItem/.test(flag), "on only with ?contextDedupe=1 in the URL; nothing read from storage (contextDedupeFlag.test.ts)");
  const route = fs.readFileSync(path.join(ROOT, "../src/app/api/chat/route.ts"), "utf8");
  assert.ok(route.includes("contextDedupe === true ? dedupeExactContext("), "the server applies it only for true");
  rec.calls = 0;
  await prompt(chatBody(SCENE_X, { contextDedupe: true }));
  assert.equal(rec.calls, 1, "one chat call, as before");
});

test("17 the flag OFF (no field, false, or anything but true) builds exactly the prompt of the reduction-free route: the duplicates stay as before", async () => {
  for (const scene of [SCENE_X, SCENE_Y] as Record<string, unknown>[]) {
    const [none, falseFlag] = await pair(chatBody(scene), chatBody(scene, { contextDedupe: false }));
    assert.equal(falseFlag, none, "contextDedupe:false is OFF");
    const [none2, stringFlag] = await pair(chatBody(scene), chatBody(scene, { contextDedupe: "1" }));
    assert.equal(stringFlag, none2, "a string is OFF");
    assert.equal(occurrences(none, S1), 2, "OFF keeps both copies, as before the reduction existed");
    const env = await envelope(chatBody(scene, { debugGenerationId: "g-off" }));
    assert.ok(env && !("contextDedupe" in env), "OFF: the server reports no reduction");
  }
});
