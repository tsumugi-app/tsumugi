/**
 * Topic Continuity: the topic candidates are checked against the topic words the turn names (fictional records only, no AI, no storage).
 * Run: `npm run test:topic-continuity`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildTopicContinuityPayload, namedTopicTerms } from "./topicContinuity";
import { scoreMemory } from "./retrieval";
import type { MemoryObject } from "./types";

const mem = (id: string, day: string, summary: string, keywords: string[], topicId: string): MemoryObject =>
  ({
    id, date: day, types: ["event"], content: summary, summary, keywords, topicId,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    createdAt: `${day}T10:00:00.000Z`, updatedAt: `${day}T10:00:00.000Z`,
  }) as unknown as MemoryObject;

// two topics; the job topic is the newer one. The job records say 転職 and 仕事, never 会社
const POOL: MemoryObject[] = [
  mem("bike-1", "2026-07-05", "ロードバイクを買うか迷っていると話した。", ["自転車", "ロードバイク"], "topic-bike"),
  mem("bike-2", "2026-08-10", "ロードバイクを買ったと話した。", ["自転車", "ロードバイク", "買い物"], "topic-bike"),
  mem("job-1", "2026-09-01", "転職を考え始めたと話した。", ["転職", "仕事"], "topic-job"),
  mem("job-2", "2026-09-20", "転職はやめることにしたと話した。", ["転職"], "topic-job"),
];
// the same, and a job record that says 会社
const POOL_KAISHA: MemoryObject[] = [...POOL, mem("job-3", "2026-10-01", "今の会社に残ると話した。", ["転職", "会社"], "topic-job")];
// a topic that names a person in katakana
const POOL_PERSON: MemoryObject[] = [...POOL, mem("kenta-1", "2026-10-05", "ケンタと山に登る約束をしたと話した。", ["登山", "ケンタ"], "topic-hike")];

/** the selection before this change: score, then recency, top 3, with no check against the turn's topic words */
function before(pool: MemoryObject[], text: string): string[] | null {
  const groups = new Map<string, MemoryObject[]>();
  for (const m of pool) if (m.topicId) groups.set(m.topicId, [...(groups.get(m.topicId) ?? []), m]);
  if (!/昨日|前に|この前|さっき|あの件|あの話|例の|続き|その後|やっぱり|前回/.test(text)) return null;
  const scored = [...groups.entries()].map(([id, ms]) => ({ id, score: Math.max(...ms.map((m) => scoreMemory(m, text.trim()))), at: Math.max(...ms.map((m) => Date.parse(m.updatedAt))) }));
  scored.sort((a, b) => b.score - a.score || b.at - a.at);
  return scored.slice(0, 3).map((g) => g.id);
}
const after = (pool: MemoryObject[], text: string) => buildTopicContinuityPayload(pool, text)?.map((t) => t.topicId) ?? null;

const CASES: { what: string; q: string; pool: MemoryObject[]; want: string[] | null; known?: string }[] = [
  { what: "記録に無い話題（none-mars）", q: "前に話した火星旅行の計画、どうなってたっけ？", pool: POOL, want: null },
  { what: "記録に無い話題（none-pottery）", q: "前に話した陶芸教室のこと、どうなってたっけ？", pool: POOL, want: null },
  { what: "記録にある話題（fact-bike-price）", q: "前に買ったロードバイクって、いくらだったっけ？", pool: POOL, want: ["topic-bike"] },
  { what: "記録にある話題（キーワード）", q: "この前の転職の話、どう思う？", pool: POOL, want: ["topic-job"] },
  { what: "話題の語が無い（recent-continue）", q: "さっきの話の続きなんだけど、ゆうきさんとまた出かけたいな", pool: POOL, want: ["topic-job", "topic-bike"] },
  { what: "話題の語が無い", q: "昨日の話なんだけど、やっぱりあれでいこうかな", pool: POOL, want: ["topic-job", "topic-bike"] },
  { what: "話題の語が無い（あの件）", q: "あの件、どうなったっけ？", pool: POOL, want: ["topic-job", "topic-bike"] },
  { what: "話題の語が無い（例の）", q: "例の話、その後どうなったと思う？", pool: POOL, want: ["topic-job", "topic-bike"] },
  { what: "時を言う語だけ", q: "先週の話の続きなんだけど", pool: POOL, want: ["topic-job", "topic-bike"] },
  { what: "人物（ひらがな）だけ", q: "前に話したゆうきさんのこと、覚えてる？", pool: POOL, want: ["topic-job", "topic-bike"] },
  { what: "言い換え＋指し示す言い回し", q: "あの件、やっぱり会社を辞めることにした", pool: POOL, want: ["topic-job", "topic-bike"] },
  { what: "言い換え（記録に「会社」がある）", q: "前に話したけど、やっぱり会社を辞めることにした", pool: POOL_KAISHA, want: ["topic-job"] },
  { what: "言い換えだけ（記録に「会社」が無い）", q: "前に話したけど、やっぱり会社を辞めることにした", pool: POOL, want: null, known: "指し示す言い回しが無い言い換えは、話題の候補が渡らない（今後の課題）" },
  { what: "人物（カタカナ）が記録にある", q: "前に話したケンタとの約束、どうなったっけ？", pool: POOL_PERSON, want: ["topic-hike"] },
  { what: "きっかけの語が無い", q: "ロードバイクに乗りたい", pool: POOL, want: null },
];

test("topic continuity: a turn that names a topic gets only the topics whose records have it; a turn with no topic word or a pointing phrase keeps the recent candidates", () => {
  // the order of several candidates is the old one (score, then recency): compared as a set here, as is in the next test
  const sorted = (ids: string[] | null) => (ids ? [...ids].sort() : null);
  for (const c of CASES) assert.deepEqual(sorted(after(c.pool, c.q)), sorted(c.want), `${c.what}: ${c.q}`);
  assert.deepEqual(namedTopicTerms("あの件、どうなったっけ？"), [], "「件」 of 「あの件」 is not a topic word");
  assert.deepEqual(namedTopicTerms("先週の話の続きなんだけど"), [], "a time word is not a topic word");
  assert.deepEqual(namedTopicTerms("前に話した火星旅行の計画、どうなってたっけ？"), ["火星旅行", "計画"]);
});

test("topic continuity: unchanged where the turn names no topic word (the same candidates as before)", () => {
  for (const c of CASES.filter((x) => namedTopicTerms(x.q).length === 0)) assert.deepEqual(after(c.pool, c.q), before(c.pool, c.q), `${c.what}: ${c.q}`);
});

test("topic continuity report: before / after for each case", () => {
  const rows = CASES.map((c) => `| ${c.what} | ${c.q} | ${before(c.pool, c.q)?.join(", ") ?? "（なし）"} | ${after(c.pool, c.q)?.join(", ") ?? "（なし）"} | ${c.known ?? ""} |`);
  for (const r of rows) console.log(`CI-REPORT topic-continuity ${r}`);
});
