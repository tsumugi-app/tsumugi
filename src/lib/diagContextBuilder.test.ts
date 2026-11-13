/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * DIAGNOSTIC ONLY (diag/ branch, never merged). Fictional Memories (長男 / 咲さん / the cars are invented).
 * What every route of the chat context gives the AI today (Retrieval, PersonView, Memory Graph, Memory Timeline + Synthesis items, Topic Continuity,
 * Explicit Search), built the way ChatScreen builds it with every trial flag ON, and what a prototype Context Builder (B + C: one cross-route pass
 * on the device, no AI call) would keep. The prototype lives only in this file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
let pool: MemoryObject[] = [];
const stubs: Record<string, unknown> = {
  "./db": { getAllMemoryObjects: async () => pool, getAllConversations: async () => [], getMemoryObject: async (id: string) => pool.find((m) => m.id === id) },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn() },
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown; _resolveFilename: (request: string, ...rest: unknown[]) => string };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if ((parent?.filename?.startsWith(ROOT) ?? false) && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const r = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const pc = require(path.join(ROOT, "lib/personContext.js")) as typeof import("./personContext");
const person = require(path.join(ROOT, "lib/person.js")) as typeof import("./person");
const syn = require(path.join(ROOT, "lib/memorySynthesis.js")) as typeof import("./memorySynthesis");
const tc = require(path.join(ROOT, "lib/topicContinuity.js")) as typeof import("./topicContinuity");
const ms = require(path.join(ROOT, "lib/memorySearch.js")) as typeof import("./memorySearch");
const rr = require(path.join(ROOT, "lib/recordRelevance.js")) as typeof import("./recordRelevance");
const rq = require(path.join(ROOT, "lib/recallQuestion.js")) as typeof import("./recallQuestion");

type SynthesisItem = import("./memorySynthesis").SynthesisItem;
type PersonMention = import("./types").PersonMention;

function mention(name: string, quote: string, at: string, relation?: PersonMention["relation"]): PersonMention {
  return { id: `pm-${name}-${at}`, groupingKey: name, displayName: name, ...(relation ? { relation } : {}), assertion: "mention", stated: "explicit", quote, statedAt: at, sourceConversationId: "c", recordedAt: at, origin: "ai-extracted", schemaVersion: 1 };
}
interface Opt { quotes?: string[]; who?: [string, PersonMention["relation"]?]; source?: string; topicId?: string; types?: string[] }
function mem(id: string, day: string, summary: string, keywords: string[], opt: Opt = {}): MemoryObject {
  const at = `${day}T10:00:00.000Z`;
  const quotes = opt.quotes ?? [summary];
  return {
    id, date: at, statedAt: at, types: opt.types ?? ["conversation"], conversationId: `c-${id}`, content: quotes.join(" "), summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at,
    evidenceQuotes: quotes,
    ...(opt.topicId ? { topicId: opt.topicId } : {}),
    ...(opt.who ? { personMentions: [mention(opt.who[0], quotes[0] ?? summary, at, opt.who[1])] } : {}),
    metadata: { id: `meta-${id}`, source: opt.source ?? "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

const POOL: MemoryObject[] = [
  // cars (the user's own wishes)
  mem("c1", "2026-10-01", "見た目で一番好きなのはGX。その次にNX、RX", ["車", "GX", "レクサス"], { topicId: "t-car" }),
  mem("c2", "2026-10-20", "NXかアウトランダーかなぁと迷っている", ["車", "NX", "アウトランダー"], { quotes: ["NXかアウトランダーかなぁ"], topicId: "t-car" }),
  mem("c3", "2026-10-29", "次の車は室内の広い車が欲しい", ["車", "室内"], { quotes: ["次の車は室内が広いのが欲しい"], topicId: "t-car" }),
  // the eldest son: five records over seven weeks (a timeline theme)
  mem("s1", "2026-09-10", "長男がレゴで独創的な車を作った", ["長男", "レゴ", "車"], { quotes: ["長男がレゴで独創的な車を作ってた"], who: ["長男", "child"], topicId: "t-son" }),
  mem("s2", "2026-09-20", "長男の運動会でリレーに出た", ["長男", "運動会"], { who: ["長男", "child"], topicId: "t-son" }),
  mem("s3", "2026-10-05", "長男をお迎えに行った", ["長男", "お迎え"], { who: ["長男", "child"], topicId: "t-son" }),
  mem("s4", "2026-10-20", "長男とSwitchで遊んだ", ["長男", "Switch"], { who: ["長男", "child"], topicId: "t-son" }),
  mem("s5", "2026-10-28", "長男が次男の面倒を見ていた", ["長男", "次男"], { who: ["長男", "child"], topicId: "t-son" }),
  // 咲さん: a wish, a conclusion, the user's later reason, an AI reflection reading another reason, a change, an event
  mem("k1", "2026-08-01", "咲さんともっと二人で過ごしたいと思っていた", ["咲さん", "二人"], { quotes: ["咲さんともっと二人で過ごしたい"], who: ["咲さん", "friend"], topicId: "t-saki" }),
  mem("k2", "2026-08-20", "咲さんとの関係には未来がないと話した", ["咲さん", "関係"], { quotes: ["正直、咲さんとの関係に未来はない"], who: ["咲さん", "friend"], topicId: "t-saki" }),
  mem("k3", "2026-09-05", "咲さんとの関係に未来がない理由は、自分が既婚者だからだと説明した", ["咲さん", "未来"], { quotes: ["咲さんとの関係に未来がないと言ったのは、自分が既婚者だから。"], who: ["咲さん", "friend"], topicId: "t-saki" }),
  mem("k4", "2026-08-21", "咲さんとの距離が遠くなり、冷たくされたと感じて未来がないと思っているようだ", ["咲さん", "関係"], { source: "system-generated", quotes: [] }),
  mem("k5", "2026-10-15", "最近は咲さんを友人として大切にしたいと考えるようになった", ["咲さん", "友人"], { quotes: ["今は咲さんを友人として大切にしたいと思うようになった"], who: ["咲さん", "friend"], topicId: "t-saki" }),
  mem("k6", "2026-10-25", "咲さんとカフェでランチした", ["咲さん", "カフェ"], { who: ["咲さん", "friend"] }),
  // ideas
  mem("i1", "2026-09-15", "地域の子ども向けにプログラミング教室を開くアイデア", ["アイデア", "プログラミング", "教室"], { types: ["idea"] }),
  mem("i2", "2026-10-10", "古い車を改装してキッチンカーにするアイデア", ["アイデア", "キッチンカー", "車"], { types: ["idea"] }),
  // everyday
  mem("m1", "2026-10-30", "最近仕事が忙しくて疲れている", ["仕事", "疲れ"]),
  mem("m2", "2026-10-02", "週末に過去の写真を整理した", ["整理", "写真"]),
  mem("m3", "2026-10-12", "睡眠不足で集中できない", ["睡眠", "集中"]),
];
// fictional Synthesis items (AI hypotheses cached on the device)
const ITEMS: SynthesisItem[] = [
  { kind: "pattern", theme: "長男", statement: "遊びや学校行事の記録から、長男の成長を見守っている様子がうかがえるのかもしれない", support: "hypothesis", evidenceIds: ["s1", "s2", "s3"], firstStatedAt: "2026-09-10T10:00:00.000Z", lastStatedAt: "2026-10-05T10:00:00.000Z" },
  { kind: "pattern", theme: "咲さん", statement: "咲さんに近づきたい気持ちと距離を取る気持ちが揺れているのかもしれない", support: "hypothesis", evidenceIds: ["k1", "k2", "k5"], firstStatedAt: "2026-08-01T10:00:00.000Z", lastStatedAt: "2026-10-15T10:00:00.000Z" },
];

interface Case { q: string; needed: string[]; related: string[]; key: string[]; why: string }
const CASES: Case[] = [
  { q: "前にどんな車が欲しいと言った？", needed: ["c1", "c2", "c3"], related: ["i2"], key: [], why: "具体的な過去の事実（本人の希望）" },
  { q: "長男がレゴで何を作った？", needed: ["s1"], related: [], key: [], why: "具体的な過去の事実（人物の行動）" },
  { q: "以前、咲さんとどうなりたいと思っていた？", needed: ["k1"], related: ["k5", "k2", "k3"], key: ["k1"], why: "人間関係（本人の望み）" },
  { q: "咲さんとの関係について考え方はどう変わった？", needed: ["k1", "k2", "k5"], related: ["k3", "k6"], key: ["k3", "k5"], why: "考え方の変化（時系列）" },
  { q: "未来がないと言った理由は？", needed: ["k2", "k3"], related: ["k1", "k5"], key: ["k3"], why: "本人の理由（後からの説明）" },
  { q: "以前のアイデアを使って新しい企画を考えたい", needed: ["i1", "i2"], related: [], key: [], why: "アイデアの相談" },
  { q: "なんだか最近疲れる", needed: [], related: ["m1", "m3"], key: [], why: "日常会話（押し込まない）" },
  { q: "前に何の話をしたっけ？", needed: [], related: POOL.map((m) => m.id), key: [], why: "漠然とした振り返り（量だけ見る）" },
];

type Kind = "本人の発言" | "後からの本人の説明・訂正" | "AIの要約" | "AIの推測" | "背景";
interface Unit { route: string; ids: string[]; kind: Kind; text: string; part: string }
/** the order of the sections in the prompt (route.ts): earlier = higher in the system instruction */
const PROMPT_ORDER = ["Topic Continuity", "PersonView", "Memory Graph", "Memory Timeline", "Explicit Search", "Retrieval"];
const byId = new Map(POOL.map((m) => [m.id, m]));

async function currentUnits(q: string): Promise<Unit[]> {
  pool = POOL;
  const units: Unit[] = [];
  const reflective = r.isReflectiveQuery(q);
  const retrieved = await r.retrieveRelevantMemoriesImpl(q, {
    excludeConversationId: "now", limit: reflective ? r.REFLECTIVE_LIMIT : undefined, maxLinkedAdditions: reflective ? r.REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
    persona: "analyst", recentUserTurnsTexts: [q], includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance: true,
  });
  for (const m of retrieved) {
    units.push({ route: "Retrieval", ids: [m.id], kind: m.source === "system-generated" ? "AIの推測" : "AIの要約", text: m.summary, part: "summary" });
    if (m.quote) units.push({ route: "Retrieval", ids: [m.id], kind: "本人の発言", text: m.quote, part: "quote" });
  }
  // Explicit Search (only when its intent fires)
  const explicit = ms.buildExplicitSearchContext(POOL, q, { excludeConversationId: "now" });
  for (const e of explicit?.results ?? []) {
    units.push({ route: "Explicit Search", ids: [e.id], kind: "AIの要約", text: e.summary, part: "summary" });
    for (const quote of e.evidenceQuotes) units.push({ route: "Explicit Search", ids: [e.id], kind: "本人の発言", text: quote, part: "quote" });
  }
  // Topic Continuity (continuity words only; summaries without ids)
  for (const cand of tc.buildTopicContinuityPayload(POOL, q) ?? []) {
    for (const ref of cand.memories) {
      const m = POOL.find((x) => x.summary === ref.summary && x.date === ref.date);
      units.push({ route: "Topic Continuity", ids: m ? [m.id] : [], kind: "AIの要約", text: ref.summary, part: "summary" });
    }
  }
  // PersonView: the people of the retrieved records
  const keys = new Set(retrieved.flatMap((m) => (byId.get(m.id)?.personMentions ?? []).map((p) => p.groupingKey)));
  let views = keys.size > 0 ? person.computePersonViews(POOL).filter((v) => keys.has(v.groupingKey)).slice(0, person.PERSON_VIEW_CONTEXT_LIMIT) : null;
  // Memory Graph (flag ON)
  const contexts = pc.selectPersonContextsForTurn(POOL, { userText: q, earlierUserTurns: [], excludeConversationId: "now", alreadyGivenIds: retrieved.map((m) => m.id), aliases: [] });
  views = pc.withoutCoveredPersonViews(views, contexts);
  for (const v of views ?? []) units.push({ route: "PersonView", ids: [], kind: "背景", text: `${v.displayName}（${v.relation ?? "関係不明"}）`, part: "relation" });
  const userKind = (k: string): Kind => (k === "user" ? "本人の発言" : k === "candidate" ? "本人の発言" : "AIの要約");
  for (const c of contexts) {
    if (c.relation) units.push({ route: "Memory Graph", ids: c.relation.basis ? [c.relation.basis.memoryId] : [], kind: "背景", text: `${c.names.join("・")}: ${c.relation.label}`, part: "relation" });
    for (const con of c.conclusions) {
      units.push({ route: "Memory Graph", ids: [con.statement.memoryId], kind: userKind(con.statement.kind), text: con.statement.text, part: "conclusion" });
      for (const reason of con.reasons) units.push({ route: "Memory Graph", ids: [reason.memoryId], kind: reason.when === "later" ? "後からの本人の説明・訂正" : "本人の発言", text: reason.text, part: "reason" });
      for (const ai of con.aiReadings) units.push({ route: "Memory Graph", ids: [ai.memoryId], kind: "AIの推測", text: ai.text, part: "aiReading" });
    }
    for (const p of c.plans) units.push({ route: "Memory Graph", ids: [p.plan.memoryId], kind: userKind(p.plan.kind), text: p.plan.text, part: "plan" });
    for (const e of c.events) units.push({ route: "Memory Graph", ids: [e.memoryId], kind: "AIの要約", text: e.text, part: "event" });
    for (const cand of c.candidates) units.push({ route: "Memory Graph", ids: [cand.memoryId], kind: "本人の発言", text: cand.text, part: "candidate" });
  }
  // Memory Timeline + Synthesis items (flags ON)
  for (const t of syn.selectTimelineForTurn(POOL, { userText: q, retrievedMemoryIds: retrieved.map((m) => m.id) }, ITEMS)) {
    for (const p of t.timeline) units.push({ route: "Memory Timeline", ids: [p.memoryId], kind: "AIの要約", text: p.summary, part: `timeline:${t.theme}` });
    for (const i of t.items) units.push({ route: "Memory Timeline", ids: i.evidenceIds, kind: "AIの推測", text: i.statement, part: `synthesis:${t.theme}` });
  }
  return units.sort((a, b) => PROMPT_ORDER.indexOf(a.route) - PROMPT_ORDER.indexOf(b.route));
}

// --------------------------------------------------------------------------------------------
// prototype Context Builder (B + C): one pass over every route's units, on the device, no AI call
// --------------------------------------------------------------------------------------------
const norm = (t: string) => t.normalize("NFKC");
interface Decision { unit: Unit; verdict: "採用" | "保留" | "除外"; why: string }

function buildContext(q: string, units: Unit[]): Decision[] {
  const ctx = rr.purposeContextOf(q, POOL);
  const persons = ctx.namedPersons.map((n) => n.replace(/さん$/, ""));
  // topic words of the question: its runs, minus the people and the question-form words
  const terms = rq.questionTopicRuns(q).filter((t) => !persons.some((p) => t.includes(p) || p.includes(t)) && !/^(?:話|理由|考え方|関係|企画|新)$/.test(t));
  const reasonAsked = /理由|なぜ|どうして/.test(q);
  const idea = /アイデア|企画|案/.test(q);
  const change = ctx.purpose === "change" || /変わ|変化/.test(q);
  const relation = persons.length > 0 && /どうなり|関係|気持ち|望|思って/.test(q);
  // a question about the past: a word pointing back, or a past form anywhere (「言った理由は？」)
  const pastAsk = /前に|以前|過去|これまで|っけ|(?:言っ|話し|思っ|考え|作っ|決め)た|た[?？]$/.test(norm(q)) || reasonAsked;
  const unitText = (u: Unit) => norm(`${u.text} ${u.ids.map((id) => (byId.get(id)?.keywords ?? []).join(" ")).join(" ")}`);
  const direct = (u: Unit) => terms.some((t) => unitText(u).includes(t));
  const aboutPerson = (u: Unit) => persons.length > 0 && persons.some((p) => unitText(u).includes(p) || u.ids.some((id) => (byId.get(id)?.personMentions ?? []).some((m) => m.displayName.includes(p))));
  const isKey = (u: Unit) => u.kind === "後からの本人の説明・訂正" || (u.kind === "本人の発言" && /から。?$|ため|理由|ようになった|訂正|違う/.test(u.text) && (direct(u) || aboutPerson(u)));
  const seen = new Set<string>();
  const out: Decision[] = [];
  // 1 the user's later explanations / corrections first, then the user's words, then summaries, the AI's readings last (the prompt order follows it)
  const rank = (u: Unit) => (isKey(u) ? 0 : u.kind === "本人の発言" ? 1 : u.kind === "背景" ? 2 : u.kind === "AIの要約" ? 3 : 4);
  const sorted = [...units].sort((a, b) => rank(a) - rank(b));
  let casualKept = 0;
  for (const u of sorted) {
    // 2 duplicates: the same record, the same kind of words, from another route (different kinds are kept: a summary and the user's words are two kinds of evidence)
    const dupKey = `${u.ids.join(",")}|${u.kind}|${u.part.split(":")[0]}`;
    if (u.ids.length > 0 && seen.has(dupKey)) { out.push({ unit: u, verdict: "除外", why: "同じ記録・同じ種類の情報が別の経路で既にある" }); continue; }
    if (u.ids.length > 0) seen.add(dupKey);
    const d = direct(u);
    const p = aboutPerson(u);
    if (isKey(u) && (d || p)) { out.push({ unit: u, verdict: "採用", why: "本人の理由・訂正（必ず残す）" }); continue; }
    if (u.kind === "背景") { out.push({ unit: u, verdict: p ? "採用" : "除外", why: p ? "誰の話かを示す人物の関係（1行）" : "今回の質問の人物ではない" }); continue; }
    // 3 everyday talk (no past asked, no topic of the records): at most one directly matching record, nothing else
    if (!pastAsk && !idea && persons.length === 0) {
      // the top record of Retrieval stays (a natural widening of the talk); the rest is held back, never pushed in
      if (u.route === "Retrieval" && u.part === "summary" && casualKept < 1) { casualKept += 1; out.push({ unit: u, verdict: "採用", why: "日常会話：検索の最上位1件だけ（会話の広がり）" }); }
      else out.push({ unit: u, verdict: d ? "保留" : "除外", why: "日常会話：必要以上に押し込まない" });
      continue;
    }
    // 4 the AI's readings: only when the change over time is asked and they are about this topic / person; never ahead of the user's words
    if (u.kind === "AIの推測") {
      const ok = change && (d || p);
      out.push({ unit: u, verdict: ok ? "採用" : "保留", why: ok ? "考え方の変化：AIの仮説として（本人の発言の後）" : reasonAsked ? "理由は本人の説明を優先（AIの読みは渡さない）" : "質問の目的に合わないAIの仮説" });
      continue;
    }
    // 5 the timeline: whole only for a change / a relationship; otherwise only its points that are about the question's topic
    if (u.route === "Memory Timeline") {
      const ok = d || ((change || relation) && p);
      out.push({ unit: u, verdict: ok ? "採用" : "除外", why: ok ? "質問の話題・経緯に関係する時点" : "人物・テーマが同じだけで、質問の話題ではない時点" });
      continue;
    }
    // 6 Memory Graph: conclusions and reasons for a relationship / change / reason question; events only when about the topic
    if (u.route === "Memory Graph") {
      const ok = d || ((relation || change || reasonAsked) && p && u.part !== "event");
      out.push({ unit: u, verdict: ok ? "採用" : "除外", why: ok ? "人物について質問の目的に合う記録" : "人物が同じだけの最近の出来事" });
      continue;
    }
    // 7 Retrieval / Explicit Search / Topic Continuity: already chosen for this question; kept unless they match neither topic nor person
    const ok = d || p || terms.length === 0 || idea;
    out.push({ unit: u, verdict: ok ? "採用" : "保留", why: ok ? "検索で選ばれ、質問の話題か人物に一致" : "話題にも人物にも一致しない（会話の広がりとして保留）" });
  }
  return out;
}

function measure(units: Unit[], c: Case) {
  const ids = new Set(units.flatMap((u) => u.ids));
  const chars = units.reduce((n, u) => n + Array.from(u.text).length, 0);
  const isUnrelated = (u: Unit) => u.ids.length > 0 && u.ids.every((id) => !c.needed.includes(id) && !c.related.includes(id) && !c.key.includes(id));
  const unrelated = units.filter(isUnrelated).length;
  const needed = c.needed.filter((id) => ids.has(id));
  const key = c.key.filter((id) => units.some((u) => u.ids.includes(id) && u.kind !== "AIの推測"));
  // a reading of the AI placed before the user's own reason / correction
  const firstKey = units.findIndex((u) => c.key.some((id) => u.ids.includes(id)) && (u.kind === "後からの本人の説明・訂正" || u.kind === "本人の発言"));
  const firstAi = units.findIndex((u) => u.kind === "AIの推測");
  const aiFirst = c.key.length > 0 && firstAi >= 0 && (firstKey < 0 || firstAi < firstKey);
  const routes = [...new Set(units.map((u) => u.route))].map((rt) => `${rt}:${units.filter((u) => u.route === rt).length}`).join(" ");
  return { n: units.length, chars, unrelated, needed, key, aiFirst, routes, pct: units.length === 0 ? "0%" : `${Math.round((unrelated / units.length) * 100)}%` };
}

test("context builder survey: current routes vs a cross-route prototype (fictional data)", async () => {
  const rows = ["| 質問 | 現在 | 試作（B＋C） |", "|---|---|---|"];
  const detail: string[] = [];
  const tot = { cur: { n: 0, chars: 0, un: 0, need: 0, key: 0, aiFirst: 0 }, pro: { n: 0, chars: 0, un: 0, need: 0, key: 0, aiFirst: 0 } };
  let needAll = 0;
  let keyAll = 0;
  for (const c of CASES) {
    const units = await currentUnits(c.q);
    const decisions = buildContext(c.q, units);
    const kept = decisions.filter((d) => d.verdict === "採用").map((d) => d.unit);
    const a = measure(units, c);
    const b = measure(kept, c);
    needAll += c.needed.length;
    keyAll += c.key.length;
    for (const [k, m] of [["cur", a], ["pro", b]] as const) {
      tot[k].n += m.n; tot[k].chars += m.chars; tot[k].un += m.unrelated; tot[k].need += m.needed.length; tot[k].key += m.key.length; tot[k].aiFirst += m.aiFirst ? 1 : 0;
    }
    const fmt = (m: ReturnType<typeof measure>) => `${m.n}項目・${m.chars}字<br>${m.routes}<br>必要 ${m.needed.length}/${c.needed.length}・本人の理由/訂正 ${m.key.length}/${c.key.length}${m.aiFirst ? "・**AIの仮説が先**" : ""}<br>無関係 ${m.unrelated}件 ${m.pct}`;
    rows.push(`| ${c.q}<br>（${c.why}） | ${fmt(a)} | ${fmt(b)} |`);
    detail.push(`#### ${c.q}`, "| 経路 | 種類 | 内容 | 判定 | 理由 |", "|---|---|---|---|---|");
    for (const d of decisions) detail.push(`| ${d.unit.route} | ${d.unit.kind} | ${d.unit.text.slice(0, 40)} | ${d.verdict} | ${d.why} |`);
    detail.push("");
  }
  rows.push(`| 合計 | ${tot.cur.n}項目・${tot.cur.chars}字・必要 ${tot.cur.need}/${needAll}・理由/訂正 ${tot.cur.key}/${keyAll}・無関係 ${tot.cur.un}件（${Math.round((tot.cur.un / Math.max(1, tot.cur.n)) * 100)}%）・AIの仮説が先 ${tot.cur.aiFirst}問 | ${tot.pro.n}項目・${tot.pro.chars}字・必要 ${tot.pro.need}/${needAll}・理由/訂正 ${tot.pro.key}/${keyAll}・無関係 ${tot.pro.un}件（${Math.round((tot.pro.un / Math.max(1, tot.pro.n)) * 100)}%）・AIの仮説が先 ${tot.pro.aiFirst}問 |`);
  const out = ["## Context builder survey (fictional data, diag branch, never merged)", ...rows, "", "### 試作の判定（採用・保留・除外）", ...detail].join("\n");
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`);
  // deliberate failure: the CI annotation carries the table (readable without signing in)
  assert.fail(`DIAG\n${rows.join("\n")}\n${detail.join("\n")}`);
});
