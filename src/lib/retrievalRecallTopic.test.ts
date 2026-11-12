/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Recall topic (fictional data only): a question about the user's own past (「過去にどんな車がいいって言ったっけ？」) finds the records of its topic.
 *   - "before" = the chat Retrieval without `recallTopic` (what main does); "after" = with it (what the chat screen now passes)
 *   - per case: the number of results, the ranks of the relevant records, the share of unrelated records (written to the CI job summary)
 *   - the Memory Timeline theme choice, the prompt of a recall question that found nothing, and the callers that do not pass the option
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
let pool: MemoryObject[] = [];
const rec: { systemInstruction: string } = { systemInstruction: "" };
const fakeProvider = {
  async generateStream(req: { systemInstruction?: string }) {
    rec.systemInstruction = req.systemInstruction ?? "";
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
const r = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const rq = require(path.join(ROOT, "lib/recallQuestion.js")) as typeof import("./recallQuestion");
const syn = require(path.join(ROOT, "lib/memorySynthesis.js")) as typeof import("./memorySynthesis");
const voice = require(path.join(ROOT, "lib/conversationVoice.js")) as typeof import("./conversationVoice");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };

function mem(id: string, day: string, summary: string, keywords: string[]): MemoryObject {
  const at = `${day}T12:00:00.000Z`;
  return {
    id, date: at, statedAt: at, types: ["conversation"], conversationId: `c-${id}`, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at,
    metadata: { id: `meta-${id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

// the two records of the report (made up), in two keyword shapes: A = the keyword 「車」 is on 3 records; C = no record has the keyword 「車」
const CAR1 = "アウトランダーが気になる";
const CAR2 = "車について話したい。レクサスGX・NX・RX、アウトランダーなどを検討";
const carA = [
  mem("car1", "2026-10-26", CAR1, ["アウトランダー", "車"]),
  mem("car2", "2026-10-27", CAR2, ["車", "レクサス", "アウトランダー"]),
  mem("car3", "2026-09-01", "車で実家に帰った", ["車", "実家"]),
];
const carC = [
  mem("car1", "2026-10-26", CAR1, ["アウトランダー", "SUV"]),
  mem("car2", "2026-10-27", CAR2, ["車選び", "レクサス", "アウトランダー"]),
];
// a theme 「整理」 whose records say 「過去」 (3+ conversations over 2+ weeks: a Memory Timeline theme)
const seiri = [
  mem("s1", "2026-09-20", "過去のメモを整理して、要らないものを捨てた", ["整理", "メモ"]),
  mem("s2", "2026-10-01", "部屋を整理した。過去の手紙も見返した", ["整理", "部屋"]),
  mem("s3", "2026-10-15", "仕事の書類を整理した", ["整理", "書類"]),
  mem("s4", "2026-11-01", "週末に過去の写真を整理した", ["整理", "写真"]),
];
// records that share letters with the question but not its topic, and words that END with 車 (not about cars)
const unrelated = [
  mem("u1", "2026-08-01", "過去の失敗を思い出して落ち込んだ", ["失敗"]),
  mem("u2", "2026-08-03", "いい天気だったので散歩した", ["散歩", "天気"]),
  mem("u3", "2026-08-05", "上司に言ったことを後悔している", ["上司", "後悔"]),
  mem("u4", "2026-08-07", "電車で通勤するのが疲れる", ["電車", "通勤"]),
  mem("u5", "2026-08-09", "自転車を修理してもらった", ["自転車", "修理"]),
  mem("u6", "2026-08-11", "駐車場がいつも混んでいる", ["駐車場"]),
  mem("u7", "2026-08-13", "どんな本がいいか友人に聞いた", ["本", "友人"]),
  mem("u8", "2026-08-15", "って言われて少し傷ついた", ["傷つき"]),
  mem("u9", "2026-08-17", "過去にいい思い出がある場所に行った", ["思い出", "場所"]),
  mem("u10", "2026-08-19", "カフェで新しいケーキを食べた", ["カフェ", "ケーキ"]),
];
// many records with the keyword 「車」 (the generic-keyword case)
const manyCars = [
  mem("car1", "2026-10-26", CAR1, ["アウトランダー", "車"]),
  mem("car2", "2026-10-27", CAR2, ["車", "レクサス", "アウトランダー"]),
  ...["車で買い物に行った", "車を洗った", "車の点検に行った", "車で海まで行った", "車の保険を見直した", "車で友人を送った", "車のタイヤを替えた", "車で渋滞にはまった"]
    .map((s, i) => mem(`carx${i}`, `2026-0${1 + (i % 8)}-1${i}`, s, ["車"])),
];

const Q_ABSTRACT = "過去にどんな車がいいって言ったっけ？";
const Q_NAME = "アウトランダーって言わなかったっけ？";
const Q_KIND = "どんな車種がいいって言ったっけ？";
const Q_AUTO = "前に自動車の話をしたっけ？";
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

type Persona = "analyst" | "companion";
async function retrieve(q: string, persona: Persona, after: boolean): Promise<string[]> {
  const reflective = r.isReflectiveQuery(q);
  return ids(await r.retrieveRelevantMemoriesImpl(q, {
    persona, recentUserTurnsTexts: [q], deferReflections: true,
    limit: reflective ? r.REFLECTIVE_LIMIT : undefined, maxLinkedAdditions: reflective ? r.REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
    ...(after ? { recallTopic: true } : {}),
  }));
}
const isCar = (id: string) => id.startsWith("car");
interface Row { case: string; persona: Persona; q: string; got: string[]; ranks: string; unrelatedShare: number }
const rows: { before: Row; after: Row }[] = [];
function measure(name: string, persona: Persona, q: string, got: string[], relevant: string[]): Row {
  const ranks = relevant.map((id) => `${id}:${got.indexOf(id) === -1 ? "-" : got.indexOf(id) + 1}`).join(" ");
  const unrelatedShare = got.length === 0 ? 0 : got.filter((id) => !isCar(id)).length / got.length;
  return { case: name, persona, q, got, ranks, unrelatedShare };
}
async function compare(name: string, q: string, relevant: string[]) {
  const out: Record<Persona, { before: Row; after: Row }> = {} as never;
  for (const persona of ["analyst", "companion"] as const) {
    const before = measure(name, persona, q, await retrieve(q, persona, false), relevant);
    const after = measure(name, persona, q, await retrieve(q, persona, true), relevant);
    rows.push({ before, after });
    out[persona] = { before, after };
  }
  return out;
}

test("the recall question and its topic: question-form words are not the topic; no topic is named in the code", () => {
  assert.deepEqual(rq.recallTopicOf(Q_ABSTRACT)?.terms, ["車"]);
  assert.deepEqual(rq.recallTopicOf(Q_KIND)?.terms, ["車種"]);
  assert.deepEqual(rq.recallTopicOf(Q_AUTO)?.terms, ["自動車"]);
  assert.deepEqual(rq.recallTopicOf(Q_NAME)?.terms, ["アウトランダー"]);
  assert.equal(rq.recallTopicOf("前に何て言ったっけ？"), null, "no topic left: nothing changes");
  for (const casual of ["車を洗うのが面倒だった", "今日はいい天気", "最近仕事が忙しい"]) assert.equal(rq.recallTopicOf(casual), null, casual);
  const src = fs.readFileSync(path.join(ROOT, "..", "src", "lib", "recallQuestion.ts"), "utf8");
  for (const word of ["車", "アウトランダー", "レクサス"]) assert.ok(!src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).some((l) => l.includes(word)), `no topic in code: ${word}`);
  // a word that only ENDS with the topic is not the topic
  const topic = rq.recallTopicOf(Q_ABSTRACT)!;
  for (const [summary, keywords] of [["電車で通勤", ["電車"]], ["自転車を修理", ["自転車"]], ["駐車場が混む", ["駐車場"]]] as const) assert.deepEqual(rq.matchRecallTopic({ summary, keywords: [...keywords] }, topic, Q_ABSTRACT).matched, [], summary);
  assert.deepEqual(rq.matchRecallTopic({ summary: "x", keywords: ["車選び"] }, topic, Q_ABSTRACT).matched, ["車"]);
  assert.deepEqual(rq.matchRecallTopic({ summary: "車種で迷う", keywords: [] }, topic, Q_ABSTRACT).matched, ["車"]);
});

test("1 an abstract category (「車」「車種」「自動車」), the keyword 「車」 on 3 records: before analyst found nothing; after both find the car records first", async () => {
  pool = [...carA, ...seiri, ...unrelated];
  for (const q of [Q_ABSTRACT, Q_KIND, Q_AUTO]) {
    const got = await compare(`1 カテゴリ名（A）${q === Q_ABSTRACT ? "" : "・" + rq.recallTopicOf(q)?.terms[0]}`, q, ["car1", "car2"]);
    assert.deepEqual(got.analyst.before.got, [], `the reported bug reproduces before: ${q}`);
    for (const persona of ["analyst", "companion"] as const) {
      const after = got[persona].after.got;
      assert.ok(after.includes("car1") && after.includes("car2"), `${persona} ${q}: ${after.join(",")}`);
      assert.equal(got[persona].after.unrelatedShare, 0, `${persona} ${q}: no unrelated record: ${after.join(",")}`);
    }
  }
});

test("1b the keyword 「車」 on no record (「SUV」「車選び」): the record whose summary or keyword starts with 車 is found; a record with no 車 anywhere is not (limit)", async () => {
  pool = [...carC, ...seiri, ...unrelated];
  const got = await compare("1b カテゴリ名（C：キーワードに車なし）", Q_ABSTRACT, ["car1", "car2"]);
  for (const persona of ["analyst", "companion"] as const) {
    assert.equal(got[persona].after.got[0], "car2", `${persona}: ${got[persona].after.got.join(",")}`);
    assert.ok(!got[persona].after.got.includes("car1"), "「アウトランダーが気になる」 with keywords アウトランダー / SUV has no 車: not found by 「車」 (no synonym list)");
    assert.equal(got[persona].after.unrelatedShare, 0, got[persona].after.got.join(","));
  }
});

test("2 a proper noun (「アウトランダー」): found before and after, first", async () => {
  for (const [label, world] of [["A", carA], ["C", carC]] as const) {
    pool = [...world, ...seiri, ...unrelated];
    const got = await compare(`2 固有名詞（${label}）`, Q_NAME, ["car1", "car2"]);
    for (const persona of ["analyst", "companion"] as const) {
      for (const phase of ["before", "after"] as const) assert.deepEqual([...got[persona][phase].got.slice(0, 2)].sort(), ["car1", "car2"], `${label} ${persona} ${phase}`);
      assert.equal(got[persona].after.unrelatedShare, 0);
    }
  }
});

test("3 a generic keyword on many records: the topic records fill the slots, nothing unrelated; a casual remark (not a recall question) keeps the generic discount", async () => {
  pool = [...manyCars, ...seiri, ...unrelated];
  const got = await compare("3 一般語が多数の記録にある（車×10件）", Q_ABSTRACT, ["car1", "car2"]);
  for (const persona of ["analyst", "companion"] as const) {
    assert.ok(got[persona].after.got.length > 0 && got[persona].after.got.length <= r.REFLECTIVE_LIMIT + r.REFLECTIVE_MAX_LINKED_ADDITIONS, `${persona}: ${got[persona].after.got.join(",")}`);
    assert.equal(got[persona].after.unrelatedShare, 0, `${persona}: ${got[persona].after.got.join(",")}`);
  }
  // not a recall question: the option changes nothing (the generic discount stays)
  for (const casual of ["車を洗うのが面倒だった", "今日は仕事で車を使った"]) {
    for (const persona of ["analyst", "companion"] as const) assert.deepEqual(await retrieve(casual, persona, true), await retrieve(casual, persona, false), `${persona} ${casual}`);
  }
});

test("4 many records unrelated to the question but sharing its letters (過去・いい・言った・…車): none of them comes in after", async () => {
  pool = [...carA, ...seiri, ...unrelated];
  const got = await compare("4 無関係な記録が多数", Q_ABSTRACT, ["car1", "car2"]);
  assert.ok(got.companion.before.unrelatedShare > 0, `before, companion took letter-only matches: ${got.companion.before.got.join(",")}`);
  for (const persona of ["analyst", "companion"] as const) {
    assert.ok(!got[persona].after.got.some((id) => ["u4", "u5", "u6"].includes(id)), "電車・自転車・駐車場 are not about 車");
    assert.equal(got[persona].after.unrelatedShare, 0, `${persona}: ${got[persona].after.got.join(",")}`);
  }
  // no record has the topic at all: letter-only matches are not passed off as an answer (0 results; the prompt then says the search found nothing)
  pool = [...seiri, ...unrelated];
  assert.ok((await retrieve(Q_ABSTRACT, "companion", false)).length > 0, "before, companion took letter-only matches");
  for (const persona of ["analyst", "companion"] as const) assert.deepEqual(await retrieve(Q_ABSTRACT, persona, true), [], persona);
});

test("5 analyst and companion return the same records for the recall questions after (before they differed)", async () => {
  for (const world of [carA, carC, manyCars]) {
    pool = [...world, ...seiri, ...unrelated];
    for (const q of [Q_ABSTRACT, Q_NAME, Q_KIND, Q_AUTO]) {
      const a = new Set(await retrieve(q, "analyst", true));
      const c = new Set(await retrieve(q, "companion", true));
      assert.deepEqual([...a].sort(), [...c].sort(), `${q}: analyst ${[...a].join(",")} / companion ${[...c].join(",")}`);
    }
  }
});

test("6 the Memory Timeline: 「過去」 alone does not pick the theme 「整理」; the theme's own words still do; the topic's own theme is still offered", () => {
  pool = [...carA, ...seiri, ...unrelated];
  assert.ok(syn.themeTerms("整理", pool).includes("過去"), "the fixture reproduces the report: 過去 is one of the theme's words");
  const themesFor = (q: string) => syn.selectTimelineForTurn(pool, { userText: q, retrievedMemoryIds: [] }).map((c) => c.theme);
  assert.ok(!themesFor(Q_ABSTRACT).includes("整理"), themesFor(Q_ABSTRACT).join(","));
  assert.ok(themesFor(Q_ABSTRACT).includes("車"), "the car theme (3 conversations over 2 weeks) is offered");
  assert.ok(themesFor("前に整理の話をしたっけ？").includes("整理"));
  assert.ok(themesFor("最近、部屋の整理が進まない").includes("整理"));
});

const T = "2026-10-27T03:00:00.000Z";
async function systemFor(body: Record<string, unknown>): Promise<string> {
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  await res.text();
  return rec.systemInstruction;
}
const ask = (content: string, persona = "analyst") => ({ persona, turns: [{ role: "user", content, timestamp: T }] });
const NOTE_HEAD = "## 過去を尋ねられたが、このターンの記憶の検索で一致する記録が見つからなかったとき";

test("7 a recall question whose Memory search found nothing: the prompt says the search has limits (never 'no record'), briefly; other turns are unchanged", async () => {
  for (const persona of ["analyst", "companion"]) {
    const none = await systemFor(ask(Q_ABSTRACT, persona));
    assert.ok(none.includes(NOTE_HEAD), persona);
    assert.ok(none.includes("断定しない") && none.includes("今回参照できた記録では確認できなかった") && none.includes("謝罪"), persona);
    pool = [...carA, ...seiri, ...unrelated];
    const retrieved = await r.retrieveRelevantMemoriesImpl(Q_ABSTRACT, { persona: persona as Persona, recallTopic: true, recentUserTurnsTexts: [Q_ABSTRACT] });
    assert.ok(retrieved.length > 0);
    assert.ok(!(await systemFor({ ...ask(Q_ABSTRACT, persona), retrievedMemories: retrieved })).includes(NOTE_HEAD), `${persona}: found`);
    assert.ok(!(await systemFor(ask("今日はいい天気だった", persona))).includes(NOTE_HEAD), `${persona}: not a recall question`);
  }
  const v = voice.conversationVoice(undefined, "analyst");
  assert.equal(v.recallNotFoundNote(Q_ABSTRACT, false), "", "an explicit search / analytics result or a found Memory: no note");
  assert.equal(v.recallNotFoundNote("車を洗った", true), "");
});

test("8 Connect, Capture and the other callers do not pass the option; without it the chat Retrieval is exactly as before", async () => {
  for (const file of ["connect.ts", "capture.ts", "topicContinuity.ts", "memorySearch.ts", "reflection.ts"]) {
    const p = path.join(ROOT, "..", "src", "lib", file);
    if (fs.existsSync(p)) assert.ok(!fs.readFileSync(p, "utf8").includes("recallTopic"), file);
  }
  const chat = fs.readFileSync(path.join(ROOT, "..", "src", "components", "ChatScreen.tsx"), "utf8");
  assert.equal(chat.split("recallTopic: true").length - 1, 1, "only the chat screen's chat Retrieval passes it");
  pool = [...carA, ...seiri, ...unrelated];
  // without the option: the companion order is exactly scoreMemory's (as Connect calls it)
  for (const q of [Q_ABSTRACT, Q_NAME, "車を洗った"]) {
    const got = ids(await r.retrieveRelevantMemoriesImpl(q, { limit: 3, maxLinkedAdditions: 0 }));
    const expected = pool.map((m) => ({ m, s: r.scoreMemory(m, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.m.id);
    assert.deepEqual(got, expected, q);
  }
  // the analyst scoring without a topic is unchanged (no recall bonus, the same discount)
  const freq = r.computeKeywordFrequency(pool);
  for (const e of r.scoreConversationCandidates(pool, Q_ABSTRACT, [], freq)) assert.equal(e.recallBonus, 0);
});

test("summary: before / after per case (count, ranks of the relevant records, share of unrelated records)", () => {
  const fmt = (x: Row) => `${x.got.length}件 [${x.got.join(", ")}] 順位 ${x.ranks} 無関係 ${Math.round(x.unrelatedShare * 100)}%`;
  const md = ["### Recall topic: before / after (fictional data)", "| case | persona | before | after |", "|---|---|---|---|",
    ...rows.map(({ before, after }) => `| ${before.case} 「${before.q}」 | ${before.persona} | ${fmt(before)} | ${fmt(after)} |`)].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(md);
  assert.ok(rows.length > 0);
});
