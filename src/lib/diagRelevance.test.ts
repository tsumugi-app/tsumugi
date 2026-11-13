/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * DIAGNOSTIC ONLY (diag/ branch, never merged). Fictional Memories.
 * How relevant are the Memories the chat Retrieval selects today, per question purpose, for analyst and companion,
 * and how would a zero-API re-ranking prototype (method B: question purpose × facets Capture already saved) change it.
 * The prototype lives only in this file. The body code is not changed.
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
const rq = require(path.join(ROOT, "lib/recallQuestion.js")) as typeof import("./recallQuestion");

interface Opt { quotes?: string[]; persons?: string[]; source?: string; types?: string[] }
function mem(id: string, day: string, summary: string, keywords: string[], opt: Opt = {}): MemoryObject {
  const at = `${day}T12:00:00.000Z`;
  return {
    id, date: at, statedAt: at, types: opt.types ?? ["conversation"], conversationId: `c-${id}`, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at,
    evidenceQuotes: opt.quotes ?? [summary],
    ...(opt.persons ? { personMentions: opt.persons.map((name, i) => ({ id: `pm-${id}-${i}`, groupingKey: name, displayName: name, assertion: "mention" })) } : {}),
    metadata: { id: `meta-${id}`, source: opt.source ?? "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

// --- fictional Memories ---
const POOL: MemoryObject[] = [
  // the user's own car views
  mem("gx", "2026-10-27", "見た目で一番好きなのはGX。その次にNX、RX", ["車", "レクサス", "GX", "見た目"]),
  mem("nxo", "2026-10-29", "NXかアウトランダーかなぁと迷っている", ["車", "NX", "アウトランダー"], { quotes: ["NXかアウトランダーかなぁ"] }),
  mem("space", "2026-10-30", "車選びでは燃費より室内の広さを重視したい", ["車選び", "室内", "燃費"]),
  mem("ol", "2026-10-26", "アウトランダーが気になる", ["アウトランダー", "SUV"]),
  // deliberation phrased as a question (must NOT be treated as a "question only" record)
  mem("which", "2026-10-31", "NXとアウトランダーのどちらが良いか迷っている", ["車", "NX", "アウトランダー"], { quotes: ["NXとアウトランダー、どっちがいいかな？"] }),
  // the same words, another purpose
  mem("lego", "2026-10-12", "長男がレゴで車を作った", ["長男", "レゴ", "車"], { persons: ["長男"] }),
  mem("base", "2026-09-28", "長男が段ボールで秘密基地を作っていた", ["長男", "段ボール", "工作"], { persons: ["長男"] }),
  mem("alph", "2026-10-05", "日本の道路にアルファードが多くて驚いた", ["アルファード", "道路", "日本"]),
  // records of only asking (the question itself was captured)
  mem("q1", "2026-11-05", "過去にどんな車がいいと言ったか尋ねた", ["車", "過去"], { quotes: ["過去にどんな車がいいって言ったっけ？"] }),
  mem("q2", "2026-11-08", "以前、車について何を話したか確認した", ["車"], { quotes: ["以前、車について何を話した？"] }),
  mem("q3", "2026-10-20", "仕事の進め方についてどう思うか質問した", ["仕事", "進め方"], { quotes: ["仕事の進め方ってどう思う？"] }),
  // a person
  mem("saki1", "2026-10-18", "咲さんにはもっと自分の時間を大事にしてほしいと思っている", ["咲さん", "時間"], { persons: ["咲さん"] }),
  mem("saki2", "2026-10-22", "咲さんと週末に映画を見た", ["咲さん", "映画"], { persons: ["咲さん"] }),
  mem("saki3", "2026-11-02", "咲さんともっと二人で話す時間がほしい", ["咲さん", "会話"], { persons: ["咲さん"] }),
  // the way of thinking over time
  mem("view1", "2026-11-03", "以前は効率ばかり考えていたが、最近は余白も大切だと思うようになった", ["考え方", "余白", "効率"]),
  mem("view2", "2026-10-25", "失敗を怖がらずに試すことにした", ["挑戦", "失敗"]),
  mem("view3", "2026-05-10", "完璧にやらないと気が済まない", ["完璧主義", "考え方"]),
  // an AI-written diary reflection
  mem("refl", "2026-10-30", "車選びについていろいろ考えた一日だった", ["車選び"], { source: "system-generated", quotes: [] }),
  // unrelated
  mem("u1", "2026-10-02", "電車で通勤している", ["電車", "通勤"]),
  mem("u2", "2026-10-03", "自転車を修理した", ["自転車", "修理"]),
  mem("u3", "2026-10-04", "駐車場が混んでいた", ["駐車場"]),
  mem("u4", "2026-10-06", "最近仕事が忙しい", ["仕事", "多忙"]),
  mem("u5", "2026-10-07", "友人とカフェで話した", ["カフェ", "友人"]),
  mem("u6", "2026-10-08", "週末に過去の写真を整理した", ["整理", "写真"]),
  mem("u7", "2026-10-09", "考えごとをして眠れなかった", ["睡眠", "不安"]),
];

interface Case { q: string; needed: string[]; low: string[]; why: string }
const CASES: Case[] = [
  { q: "過去にどんな車がいいって言ったっけ？", needed: ["gx", "nxo", "space", "ol", "which"], low: ["lego", "alph", "q1", "q2", "refl"], why: "本人の車の好み" },
  { q: "以前、車について何を話した？", needed: ["gx", "nxo", "space", "ol", "which"], low: ["lego", "alph", "q1", "q2", "refl"], why: "車についての話の全体（lego・alphも話の一部だが優先度は下）" },
  { q: "長男が作っていたものは？", needed: ["lego", "base"], low: [], why: "長男の行動。同じlegoがここでは中心" },
  { q: "アルファードについてどう思っていた？", needed: ["alph"], low: [], why: "alphがここでは中心" },
  { q: "前に咲さんについて何を望んでいた？", needed: ["saki1", "saki3"], low: ["saki2"], why: "咲さんへの望み" },
  { q: "最近、自分の考え方はどう変わった？", needed: ["view1", "view2"], low: ["view3"], why: "最近の考え方の変化" },
  { q: "過去にどんな質問をしていた？", needed: ["q1", "q2", "q3"], low: [], why: "質問した記録そのものがここでは中心" },
];

type Persona = import("./types").Persona;
const byId = (id: string) => POOL.find((m) => m.id === id)!;

async function current(q: string, persona: Persona): Promise<string[]> {
  pool = POOL;
  const reflective = r.isReflectiveQuery(q);
  const got = await r.retrieveRelevantMemoriesImpl(q, {
    excludeConversationId: "now", limit: reflective ? r.REFLECTIVE_LIMIT : undefined, maxLinkedAdditions: reflective ? r.REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
    persona, recentUserTurnsTexts: [q], includeContext: true, deferReflections: true, recallTopic: true,
  });
  return got.map((m) => m.id);
}

// --- prototype B (zero API): the question's purpose × facets Capture already saved ---
const norm = (t: string) => t.normalize("NFKC");
const sentences = (t: string) => norm(t).match(/[^。！？!?\n]+[。！？!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
const INTERROGATIVE = /[?？]$|っけ[?？]?$|かな[?？]?$|ですか|ますか|どう思う/;
/** every sentence of the user's own words is a question that asks the Memory back (「前に何て言ったっけ？」) */
const isRecallOnly = (m: MemoryObject) => {
  const q = (m.evidenceQuotes ?? []).flatMap(sentences);
  return q.length > 0 && q.every((s) => rq.isRecallQuestion(s));
};
/** every sentence of the user's own words is a question (to the AI) */
const isQuestionOnly = (m: MemoryObject) => {
  const q = (m.evidenceQuotes ?? []).flatMap(sentences);
  return q.length > 0 && q.every((s) => INTERROGATIVE.test(s));
};
const ASKS_ABOUT_QUESTIONS = /質問|尋ね|聞いた|聞いて/;
const PURPOSES: { ask: RegExp; record: RegExp; name: string }[] = [
  { name: "wish", ask: /望|願|ほしかっ|欲しかっ|してほし/, record: /ほしい|欲しい|したい|てほしい|望|願/ },
  { name: "change", ask: /変わ|変化|ようになっ/, record: /ようになっ|変わ|以前は|前は|にした|ことにし/ },
  { name: "view", ask: /いい|好き|どう思|思って|欲し|気に|選/, record: /好き|いい|良い|欲し|気にな|かな|迷|検討|重視|したい|ほしい|驚|嫌|思/ },
];
const textOf = (m: MemoryObject) => norm(`${m.summary} ${(m.evidenceQuotes ?? []).join(" ")}`);
const personsOf = (m: MemoryObject) => (m.personMentions ?? []).map((p) => p.displayName);
/** the record's first sentence is about another person's action (「長男が…」): the user's words are not the center */
const isOthersAction = (m: MemoryObject) => personsOf(m).some((name) => norm(m.summary).startsWith(`${name}が`) || norm(m.summary).startsWith(`${name}は`));

function protoScores(q: string, persona: Persona): { id: string; score: number }[] {
  const all = POOL;
  const freq = r.computeKeywordFrequency(all);
  const topic = rq.withPoolEvidence(rq.recallTopicOf(q), all);
  const base = persona === "analyst"
    ? r.scoreConversationCandidates(all, q, r.deriveConversationTopicAnchors([q], freq), freq, null, topic).map((e) => ({ m: e.memory, s: e.conversationScore }))
    : all.map((m) => {
        const match = topic ? rq.matchRecallTopic(m, topic, q) : null;
        return { m, s: r.scoreMemory(m, q) + (match ? (match.matched.length - match.coveredByKeyword.length) * r.KEYWORD_WEIGHT : 0) };
      });
  const namedPersons = new Set(all.flatMap(personsOf).filter((name) => norm(q).includes(name.replace(/さん$/, ""))));
  const asksQuestions = ASKS_ABOUT_QUESTIONS.test(q);
  const purposes = PURPOSES.filter((p) => p.ask.test(q));
  const W = r.KEYWORD_WEIGHT;
  return base.map(({ m, s }) => {
    let score = s;
    // 1 the question asks about questions: the question records are the center, by date
    if (asksQuestions) return { id: m.id, score: isQuestionOnly(m) ? W + score : score * 0.3 };
    // 2 a record that only asked the Memory back (no content of its own) is pushed back, not dropped
    if (isRecallOnly(m)) score *= 0.3;
    // 3 a person named in the question: that person's records count as on topic (analyst already does this; companion did not)
    const about = personsOf(m).some((name) => namedPersons.has(name));
    if (about) score = Math.max(score, r.CONVERSATION_MIN_SCORE);
    // 4 another person's action when the question names nobody: pushed back
    if (namedPersons.size === 0 && isOthersAction(m) && score > 0) score -= W;
    // 5 the question's purpose (a wish, a change, a view) in the user's own words of an on-topic record: pushed up
    if (score > 0 && purposes.some((p) => p.record.test(textOf(m)))) score += W;
    // 6 an AI reflection stays behind the user's own records (P1-F)
    if (m.metadata.source === "system-generated") score = Math.min(score * 0.5, W);
    return { id: m.id, score };
  });
}

function prototype(q: string, persona: Persona): string[] {
  const limit = r.isReflectiveQuery(q) ? r.REFLECTIVE_LIMIT : r.DEFAULT_LIMIT;
  const sorted = protoScores(q, persona).filter((e) => e.score > 0).sort((a, b) => b.score - a.score);
  const floor = persona === "analyst" ? sorted.filter((e) => e.score >= r.CONVERSATION_MIN_SCORE) : sorted;
  const top = floor.slice(0, limit);
  const kept = persona === "analyst" && top.length > 0 ? top.filter((e, i) => i === 0 || e.score >= top[0].score * r.DIRECT_RELATIVE_KEEP_RATIO) : top;
  return kept.map((e) => e.id);
}

function describe(ids: string[], c: Case): { text: string; neededHit: number; lowHit: number; unrelated: number; missed: string[] } {
  const rank = (id: string) => { const i = ids.indexOf(id); return i < 0 ? "-" : String(i + 1); };
  const unrelated = ids.filter((id) => !c.needed.includes(id) && !c.low.includes(id)).length;
  const lowHit = ids.filter((id) => c.low.includes(id)).length;
  const neededHit = ids.filter((id) => c.needed.includes(id)).length;
  const share = ids.length === 0 ? "0%" : `${Math.round((unrelated / ids.length) * 100)}%`;
  const lowShare = ids.length === 0 ? "0%" : `${Math.round((lowHit / ids.length) * 100)}%`;
  return {
    text: `${ids.length}件 [${ids.join(", ")}]<br>必要 ${neededHit}/${c.needed.length}（順位 ${c.needed.map((id) => `${id}:${rank(id)}`).join(" ")}）<br>低優先 ${lowShare}・無関係 ${share}`,
    neededHit, lowHit, unrelated, missed: c.needed.filter((id) => !ids.includes(id)),
  };
}

test("relevance survey: current Retrieval vs zero-API prototype (fictional data)", async () => {
  const rows: string[] = ["| 質問 | persona | 現在 | 試作B |", "|---|---|---|---|"];
  const risk: string[] = [];
  const totals = { cur: { n: 0, low: 0, un: 0, all: 0 }, pro: { n: 0, low: 0, un: 0, all: 0 } };
  for (const c of CASES) {
    for (const persona of ["analyst", "companion"] as Persona[]) {
      const cur = await current(c.q, persona);
      const pro = prototype(c.q, persona);
      const a = describe(cur, c);
      const b = describe(pro, c);
      totals.cur.n += a.neededHit; totals.cur.low += a.lowHit; totals.cur.un += a.unrelated; totals.cur.all += cur.length;
      totals.pro.n += b.neededHit; totals.pro.low += b.lowHit; totals.pro.un += b.unrelated; totals.pro.all += pro.length;
      rows.push(`| ${c.q}<br>（${c.why}） | ${persona} | ${a.text} | ${b.text} |`);
      const lost = c.needed.filter((id) => cur.includes(id) && !pro.includes(id));
      if (lost.length > 0) risk.push(`- ${c.q} / ${persona}: 現在は取れていて試作で外れた必要記録 ${lost.join(", ")}`);
    }
  }
  const needTotal = CASES.reduce((n, c) => n + c.needed.length, 0) * 2;
  rows.push(`| 合計 | 両方 | 必要 ${totals.cur.n}/${needTotal}・低優先 ${totals.cur.low}・無関係 ${totals.cur.un}（全${totals.cur.all}件） | 必要 ${totals.pro.n}/${needTotal}・低優先 ${totals.pro.low}・無関係 ${totals.pro.un}（全${totals.pro.all}件） |`);
  // facet checks (mis-exclusion risk)
  const facets = POOL.map((m) => `| ${m.id} | ${m.summary} | ${isRecallOnly(m) ? "○" : ""} | ${isQuestionOnly(m) ? "○" : ""} | ${isOthersAction(m) ? "○" : ""} |`);
  const out = [
    "## Relevance survey (fictional data, diag branch, never merged)",
    ...rows,
    "",
    "### 誤除外の確認（現在は取れていて試作で外れた必要記録）",
    risk.length > 0 ? risk.join("\n") : "- なし",
    "",
    "### 記録の性質（試作の判定）",
    "| id | 要約 | 尋ね返しだけ | 質問だけ | 他人の行動が中心 |",
    "|---|---|---|---|---|",
    ...facets,
  ].join("\n");
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`);
  // the deliberation question is NOT a recall-only record (mis-exclusion guard)
  assert.equal(isRecallOnly(byId("which")), false);
  assert.equal(isRecallOnly(byId("q1")), true);
});
