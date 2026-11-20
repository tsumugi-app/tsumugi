/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * N6 訂正優先（案B 検出側）: コードだけの訂正検出のテスト。AI は呼ばない。
 *
 * オーナー条件（2026-11-21）:
 * 1. 訂正と「時間による変化」は区別する。変化は過去の記録を打ち消さない。
 * 2. 対象は (a) AI の解釈（Reflection）か (b) 理由を述べた本人の記録だけ。理由の追加は訂正ではない。
 *    迷ったらリンクを作らない（現行挙動のまま）。
 * 3. 対象の本文は書き換えない。リンクは訂正した側の Memory に、追加情報としてだけ付く。
 *
 * 検出の境界（意図した保守性）: 対象の理由形は既存の statesOwnReason の定義そのものを使う。
 * 文末の「〜から」だけの言い方（評価世界の job-2）は理由形とみなさないため対象にならない
 * （既存の理由配送 §4 でも同じ扱い）。この境界はテストで固定する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
const mod = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const c = require(path.join(ROOT, "lib/correction.js")) as typeof import("./correction");
const world = require(path.join(ROOT, "lib/contextEvalWorld.js")) as typeof import("./contextEvalWorld");

let seq = 0;
const newId = () => `corr-${++seq}`;
const detect = (memory: MemoryObject, pool: MemoryObject[]) => c.detectMemoryCorrections(memory, pool, { newId });

function mem(id: string, day: string, conv: string, summary: string, keywords: string[], quote?: string, source = "ai-capture"): MemoryObject {
  const at = `${day}T03:00:00.000Z`;
  return {
    id, date: at, statedAt: at, types: source === "system-generated" ? ["insight"] : ["conversation"], conversationId: conv, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at,
    ...(quote ? { evidenceQuotes: [quote] } : {}),
    metadata: { id: `meta-${id}`, source, schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

test("検出(ii): AIの解釈（Reflection）への訂正はリンクする。評価世界の job-3 → job-refl", () => {
  const memories = world.evalMemories();
  const job3 = memories.find((m) => m.id === "job-3")!;
  const pool = memories.filter((m) => m.id !== "job-3");
  const found = detect(job3, pool);
  assert.deepEqual(found.map((x) => x.targetMemoryId), ["job-refl"], "Reflection だけにリンクする");
  assert.ok(found[0].quote.includes("本当は"), "本人の訂正の逐語を保持する");
  assert.equal(found[0].sourceConversationId, "c-job-3");
  assert.equal(found[0].schemaVersion, 1);
});

test("検出の境界: 文末「から」だけの理由（job-2）は対象にならない（statesOwnReason の定義どおり）", () => {
  const memories = world.evalMemories();
  const job3 = memories.find((m) => m.id === "job-3")!;
  const job2 = memories.find((m) => m.id === "job-2")!;
  const found = detect(job3, [job2]);
  assert.deepEqual(found, [], "理由形を持たない本人の記録は打ち消さない（保守側）");
});

test("検出(iii): 理由を明示した本人の過去発言への訂正はリンクする", () => {
  const target = mem("t-own", "2026-06-01", "c-a", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], "転職はやめた。理由は給料が下がるからだ");
  const correcting = mem("t-cor", "2026-07-01", "c-b", "転職をやめた理由を言い直した。", ["転職", "チーム"], "給料って言ったけど、本当は今のチームを離れたくなかったからなんだ");
  const found = detect(correcting, [target]);
  assert.deepEqual(found.map((x) => x.targetMemoryId), ["t-own"]);
});

test("検出(iv): 時間による気持ちの変化は訂正ではない（リンクしない）", () => {
  const target = mem("t-chg", "2026-06-01", "c-a", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], "転職はやめた。理由は給料が下がるからだ");
  const change1 = mem("t-chg1", "2026-07-01", "c-b", "気持ちが変わった。", ["転職", "チーム"], "というより、前は給料のことが気になってたけど、今はチームの雰囲気のほうが気になる");
  assert.deepEqual(detect(change1, [target]), [], "「前は〜、今は〜」は変化であって訂正ではない");
  const change2 = mem("t-chg2", "2026-07-01", "c-b", "考えが変わった。", ["転職", "給料"], "本当は、前は給料が一番大事だと思ってたけど、最近はそう思わなくなった");
  assert.deepEqual(detect(change2, [target]), [], "過去の状態を認める言い方は、本当はがあっても訂正にしない");
});

test("検出(v): 理由の追加は訂正ではない（リンクしない）", () => {
  const target = mem("t-add", "2026-06-01", "c-a", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], "転職はやめた。理由は給料が下がるからだ");
  const addition = mem("t-add2", "2026-07-01", "c-b", "理由を足した。", ["転職", "給料", "通勤"], "あと、給料だけじゃなくて、通勤時間も長かったからなんだ");
  assert.deepEqual(detect(addition, [target]), [], "〜だけじゃなくて〜も、は追加");
});

test("検出(vi): 別の話題の訂正は混ざらない", () => {
  const jobTarget = mem("t-job", "2026-06-01", "c-a", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], "転職はやめた。理由は給料が下がるからだ");
  const bikeCorrection = mem("t-bike", "2026-07-01", "c-b", "自転車の値段を言い直した。", ["自転車", "ロードバイク"], "自転車の値段、12万円って言ったけど、本当は10万円だったんだ");
  assert.deepEqual(detect(bikeCorrection, [jobTarget]), [], "話題が重ならなければリンクしない");
  const bikeTarget = mem("t-bike2", "2026-06-15", "c-c", "ロードバイクを買ったと話した。", ["自転車", "ロードバイク"], "ロードバイク買った。12万円だった");
  assert.deepEqual(detect(bikeCorrection, [bikeTarget]), [], "理由も解釈でもない記録は、同じ話題でも対象にならない");
});

test("検出の安全側: 対象が後・同じ会話・疑問文のときはリンクしない", () => {
  const correcting = mem("t-x", "2026-07-01", "c-b", "言い直した。", ["転職", "チーム"], "給料って言ったけど、本当は今のチームを離れたくなかったからなんだ");
  const later = mem("t-late", "2026-08-01", "c-a", "理由は給料が下がるからだと話した。", ["転職", "給料"], "転職はやめた。理由は給料が下がるからだ");
  assert.deepEqual(detect(correcting, [later]), [], "訂正より後の記録は対象にしない");
  const sameConv = mem("t-same", "2026-06-01", "c-b", "理由は給料が下がるからだと話した。", ["転職", "給料"], "転職はやめた。理由は給料が下がるからだ");
  assert.deepEqual(detect(correcting, [sameConv]), [], "同じ会話の中の言い直しは会話自体が文脈になるため対象外");
  const question = mem("t-q", "2026-07-01", "c-b", "尋ねた。", ["転職", "チーム"], "本当は給料じゃなかったのかな？");
  const target = mem("t-t", "2026-06-01", "c-a", "理由は給料が下がるからだと話した。", ["転職", "給料"], "転職はやめた。理由は給料が下がるからだ");
  assert.deepEqual(detect(question, [target]), [], "疑問文は訂正とみなさない");
});

test("sanitize: 壊れた corrections は捨て、正しいものだけ残る（fail-soft）", () => {
  const good = { id: "a", targetMemoryId: "t", quote: "本当は違った", statedAt: "2026-07-01T03:00:00.000Z", sourceConversationId: "c-b", recordedAt: "2026-07-01T03:00:00.000Z", schemaVersion: 1 };
  const raw = [good, { ...good, id: "b", targetMemoryId: "" }, { ...good, id: "c", quote: "" }, { ...good, id: "d", schemaVersion: 2 }, { ...good, id: "e", statedAt: "not-a-date" }, null, "x", { ...good, id: "f", targetMemoryId: "self" }];
  const host = mem("self", "2026-07-01", "c-b", "x", ["転職"]);
  const cleaned = c.sanitizeStoredCorrections(raw, host.id);
  assert.deepEqual(cleaned.map((x) => x.id), ["a"], "自分自身へのリンクも捨てる");
  assert.deepEqual(c.sanitizeStoredCorrections(undefined), []);
  assert.deepEqual(c.sanitizeStoredCorrections("nope"), []);
});

test("index: 対象ごとに最新の訂正だけが効く。実在しない対象へのリンクは落ちる", () => {
  const target = mem("t-idx", "2026-06-01", "c-a", "理由は給料が下がるからだと話した。", ["転職", "給料"], "転職はやめた。理由は給料が下がるからだ");
  const older = { ...mem("t-old", "2026-07-01", "c-b", "言い直した。", ["転職"]), corrections: [{ id: "k1", targetMemoryId: "t-idx", quote: "本当は違った", statedAt: "2026-07-01T03:00:00.000Z", sourceConversationId: "c-b", recordedAt: "2026-07-01T03:00:00.000Z", schemaVersion: 1 as const }] };
  const newer = { ...mem("t-new", "2026-08-01", "c-c", "また言い直した。", ["転職"]), corrections: [{ id: "k2", targetMemoryId: "t-idx", quote: "やっぱり本当はこっちだった", statedAt: "2026-08-01T03:00:00.000Z", sourceConversationId: "c-c", recordedAt: "2026-08-01T03:00:00.000Z", schemaVersion: 1 as const }] };
  const ghost = { ...mem("t-ghost", "2026-08-01", "c-c", "言い直した。", ["転職"]), corrections: [{ id: "k3", targetMemoryId: "missing", quote: "本当は違った", statedAt: "2026-08-01T03:00:00.000Z", sourceConversationId: "c-c", recordedAt: "2026-08-01T03:00:00.000Z", schemaVersion: 1 as const }] };
  const index = c.correctionIndexOf([target, older, newer, ghost]);
  assert.equal(index.size, 1);
  assert.equal(index.get("t-idx")!.correcting.id, "t-new", "新しい訂正が勝つ");
  assert.equal(index.get("t-idx")!.correction.quote, "やっぱり本当はこっちだった");
});

test("記録リクエスト判定: route と同じ語彙（記録／整理して＋残し・おき・欲し）", () => {
  assert.equal(c.isRecordRequestTurn("ここまでの話、整理して残して。で、私は今どういう段階に来ているんだろう"), true);
  assert.equal(c.isRecordRequestTurn("今日の話、記録しておいて"), true);
  assert.equal(c.isRecordRequestTurn("整理して教えて"), false);
  assert.equal(c.isRecordRequestTurn("今日は天気がいいし、どこか出かけたいな"), false);
});
