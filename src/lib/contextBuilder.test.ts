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

test("4 the same Memory ID with different information is kept apart; only an exact duplicate is removed", () => {
  const retrieved = [{ id: "k3", date: "2026-09-05T10:00:00.000Z", summary: POOL[10].summary, keywords: ["咲さん", "未来"], source: "ai-capture" as const, quote: "咲さんとの関係に未来がないと言ったのは、自分が既婚者だから。", persons: ["咲さん"] }];
  const topicContext = [{ topicId: "t-saki", memories: [{ date: "2026-09-05T10:00:00.000Z", summary: POOL[10].summary, keywords: ["咲さん", "未来"] }] }];
  const report = cb.buildContextBuilderReport({ question: "咲さんとの未来の話、前にどう言った？", turnCount: 1, retrievedMemories: retrieved as never, topicContext }, POOL);
  const k3 = report.decisions.filter((d) => d.memoryIds.includes("k3"));
  assert.ok(k3.some((d) => d.route === "Retrieval" && d.kind === "本人の発言" && d.decision !== "除外"), "the user's words of the same Memory stay");
  assert.ok(k3.some((d) => d.route === "Topic Continuity" && d.decision !== "除外"), "the first copy of the summary stays");
  const dup = k3.find((d) => d.route === "Retrieval" && d.kind === "AIの要約");
  assert.equal(dup?.decision, "除外", "the same summary of the same Memory a second time is the only exclusion");
  assert.ok(report.sameMemory.some((s) => s.memoryId === "k3"));
  assert.equal(report.exactDuplicates.length, 1);
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
  assert.equal(report.totals.excluded, report.exactDuplicates.length, "only exact duplicates are excluded");
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
  for (const f of ["lib/contextBuilder.ts", "lib/contextBuilderStore.ts"]) {
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
  for (const part of ["段階1・診断専用", "判定の意味", "■ 経路ごとの件数・文字数", "■ 本人の理由・訂正", "■ AIの仮説", "■ 人物", "■ 同じMemoryの別の情報", "■ 完全な重複", "■ 判定（プロンプトの順）"]) assert.ok(text.includes(part), part);
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
    assert.equal(report.totals.excluded, report.exactDuplicates.length, `${q}: everyday talk pushes nothing out`);
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
