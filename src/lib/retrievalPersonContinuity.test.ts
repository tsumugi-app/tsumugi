/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Person continuity（会話入口のRetrievalで、名前を省いたまま続く人物の話を引き継ぐ）のテスト。架空のMemoryだけを使う。
 * 「変更前」は、同じ選定手順を人物の引き継ぎ無し（personFocus=null）で実行した結果＝従来の計算式そのもの。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
const stubs: Record<string, unknown> = {
  "./db": { getAllMemoryObjects: async () => [], getMemoryObject: async () => undefined },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn() },
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if ((parent?.filename?.startsWith(ROOT) ?? false) && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const r = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
type MemoryObject = import("./types").MemoryObject;

let n = 0;
function mem(summary: string, keywords: string[], persons: string[] = []): MemoryObject {
  n += 1;
  const at = `2026-0${1 + (n % 9)}-1${n % 10}T12:00:00.000Z`;
  return {
    id: `pc-${String(n).padStart(2, "0")}`, date: at, statedAt: at, types: ["conversation"], conversationId: `pc-conv-${n}`,
    content: summary, summary, keywords, themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    ...(persons.length ? { personMentions: persons.map((p, i) => ({ id: `pm-${n}-${i}`, groupingKey: p, displayName: p, assertion: "mention", stated: "explicit", quote: p, statedAt: at, sourceConversationId: `pc-conv-${n}` })) } : {}),
    createdAt: at, updatedAt: at, metadata: { id: `meta-${n}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

const pool: MemoryObject[] = [
  // さきさん（何度も話題に出る＝珍しいキーワードではない人物）。キーワードには名前が入っていない記録もある
  mem("さきさんと距離ができて、少しモヤモヤしていると話した。", ["友人関係", "モヤモヤ"], ["さきさん"]),
  mem("さきさんと久しぶりに長く話せて、名残惜しかったと話した。", ["友人関係", "会話"], ["さきさん"]),
  mem("さきさんにまた会いたいと話した。", ["友人関係"], ["さきさん"]),
  mem("さきさんとは学生時代からの付き合いだと話した。", ["友人関係", "学生時代"], ["さきさん"]),
  mem("さきさんの言葉に救われたことがあると話した。", ["友人関係", "支え"], ["さきさん"]),
  // 別の人物
  mem("ゆうとくんと飲みに行って楽しかったと話した。", ["飲み会"], ["ゆうとくん"]),
  mem("ゆうとくんが転職すると聞いて驚いたと話した。", ["転職"], ["ゆうとくん"]),
  // 続柄だけの人物（引き継ぎ対象にしない）
  mem("母から電話があり、体調の話をしたと話した。", ["電話", "体調"], ["母"]),
  mem("母に心配をかけたくないと話した。", ["心配"], ["母"]),
  // 無関係な話題
  mem("出張の準備が大変で、資料作りに追われていると話した。", ["出張", "資料"]),
  mem("週末に川沿いを走って気持ちよかったと話した。", ["ランニング"]),
  mem("新しいカレーのレシピを試したと話した。", ["料理", "カレー"]),
  mem("仕事の締め切りがきついと話した。", ["仕事", "締め切り"]),
];
const freq = r.computeKeywordFrequency(pool);
const SAKI = new Set(pool.filter((m) => m.summary.includes("さきさん")).map((m) => m.id));
const YUTO = new Set(pool.filter((m) => m.summary.includes("ゆうとくん")).map((m) => m.id));

function select(turns: string[]) {
  return r.selectConversationDirectMatches(pool, turns[turns.length - 1], turns, freq, r.DEFAULT_LIMIT);
}
/** 変更前：同じ手順を人物の引き継ぎ無しで（＝従来の計算式） */
function selectBefore(turns: string[]) {
  const trimmed = turns[turns.length - 1];
  const anchors = r.deriveConversationTopicAnchors(turns, freq);
  const scored = r.scoreConversationCandidates(pool, trimmed, anchors, freq).filter((e) => e.conversationScore >= r.CONVERSATION_MIN_SCORE)
    .sort((a, b) => b.conversationScore - a.conversationScore).slice(0, r.DEFAULT_LIMIT);
  const kept = new Set(r.applyRelativeStrengthFilter(scored.map((e) => ({ memory: e.memory, score: e.conversationScore }))).map((e) => e.memory.id));
  return scored.filter((e) => kept.has(e.memory.id)).map((e) => e.memory.id);
}
const ids = (turns: string[]) => select(turns).kept.map((e) => e.memory.id);

const SAKI_CHAT = ["さきさんについて話したい", "以前はモヤモヤしていた", "最近はもっと話したい", "前みたいに名残惜しくなるまで話したい", "彼女は自分にとってどういう存在なんだろう"];

test("名前を省いた発言が3ターン以上続いても、同じ人物の話の続きならその人物のMemoryが選ばれる", () => {
  const focus = r.deriveConversationPersonFocus(SAKI_CHAT, pool);
  assert.deepEqual(focus, { displayName: "さき", turnsSinceMention: 4 });
  const after = ids(SAKI_CHAT);
  assert.ok(after.length > 0 && after.every((id) => SAKI.has(id)), `after=${after}`);
  const before = selectBefore(SAKI_CHAT).filter((id) => SAKI.has(id)).length;
  assert.ok(after.filter((id) => SAKI.has(id)).length > before, `変更前は${before}件（珍しいキーワード「モヤモヤ」の継続だけ）、変更後は${after.length}件`);
  // 途中の発言でも、内容がつながっていれば選ばれる（「名残惜しく」はさきさんのMemoryと共有）
  assert.ok(ids(SAKI_CHAT.slice(0, 4)).some((id) => SAKI.has(id)));
});

test("名前の無い無関係な発言には、人物を持ち込まない（続きらしさが無い）", () => {
  const turns = ["さきさんについて話したい", "以前はモヤモヤしていた", "コンビニの新作アイス、当たりだった"];
  assert.equal(r.deriveConversationPersonFocus(turns, pool), null);
  assert.deepEqual(ids(turns), selectBefore(turns));
});

test("別の人物に切り替わったら、前の人物は引きずらない", () => {
  const toYuto = ["さきさんについて話したい", "以前はモヤモヤしていた", "そういえばゆうとくんとこの前飲んだ", "その人、また誘ってくれるかな"];
  assert.equal(r.deriveConversationPersonFocus(toYuto, pool)?.displayName, "ゆうと", "話題を変えて出てきた新しい人物の方を追う");
  // さきさんには人物の加点が付かない（既存の「珍しいキーワードの継続」＝モヤモヤによる選定は今回変更しない別の仕組み）
  assert.ok(select(toYuto).kept.every((e) => !SAKI.has(e.memory.id) || e.personBonus === 0));
  const toYuto2 = ["さきさんについて話したい", "以前はモヤモヤしていた", "ゆうとくんとこの前飲んだ", "あの人、また誘ってくれるかな"];
  assert.equal(r.deriveConversationPersonFocus(toYuto2, pool)?.displayName, "ゆうと", "直近に名前が出た人物（ゆうと）であって、さきではない");
  assert.ok(ids(toYuto2).every((id) => !SAKI.has(id)));
  const toMother = ["さきさんについて話したい", "以前はモヤモヤしていた", "母から電話があって", "なんだか疲れた"];
  assert.equal(r.deriveConversationPersonFocus(toMother, pool), null, "続柄の人（母）が出たら、さきさんは引き継がない");
  assert.ok(ids(toMother).every((id) => !SAKI.has(id)));
});

test("明確な話題転換（ところで／話は変わるけど…）の後は、前の人物を引きずらない", () => {
  for (const turns of [
    ["さきさんについて話したい", "ところで来週の出張の準備が大変で"],
    ["さきさんについて話したい", "以前はモヤモヤしていた", "話は変わるけど仕事の締め切りがきつい", "どうしたらいいかな、もっと話したい"],
  ]) {
    assert.equal(r.deriveConversationPersonFocus(turns, pool), null, turns.join(" / "));
    // 人物の引き継ぎは起きない＝選定は変更前と同じ（既存の珍しいキーワードの継続による選定は、今回は変更しない）
    assert.deepEqual(ids(turns), selectBefore(turns), turns.join(" / "));
  }
});

test("曖昧な場合は人物を特定しない：同じ発言に2人、名前の無い指示語だけ、続柄だけ", () => {
  assert.equal(r.deriveConversationPersonFocus(["さきさんとゆうとくんとご飯に行った", "あの人、楽しそうだった"], pool), null, "2人のうち誰か分からない");
  assert.equal(r.deriveConversationPersonFocus(["さきさんと母とご飯に行った", "あの人、楽しそうだった"], pool), null);
  assert.equal(r.deriveConversationPersonFocus(["彼女とまた話せた", "それが嬉しかった"], pool), null, "名前がどこにも無い");
  assert.equal(r.deriveConversationPersonFocus(["母のことを話したい", "最近元気がないみたいで心配"], pool), null, "続柄（母）は引き継ぎ対象外");
  assert.equal(r.deriveConversationPersonFocus(["さきさんについて話したい", "それってどうなんだろう"], pool), null, "「それ」だけでは人を指すとは限らない");
});

test("引き継ぎには上限がある：名前が出てから長く経った発言には持ち込まない", () => {
  const long = ["さきさんについて話したい", ...Array.from({ length: r.PERSON_CARRY_MAX_TURNS }, () => "うーん"), "彼女のことどう思う？"];
  assert.equal(r.deriveConversationPersonFocus(long, pool), null);
});

test("呼び方の揺れ（さき／さきさん）は同じ人物として扱う", () => {
  assert.equal(r.deriveConversationPersonFocus(["さきのこと話したい", "彼女は自分にとってどういう存在なんだろう"], pool)?.displayName, "さき");
});

test("変更前後の比較：引き継ぎが起きない会話では選定結果が変わらない／無関係なMemoryは増えない", () => {
  const cases: string[][] = [
    ["出張の準備が大変"], ["カレー作った"], ["週末走ってきた"], ["仕事の締め切りがきつい"], ["さきさんにまた会いたい"], ["ゆうとくんが転職するらしい"],
    ["母から電話があった", "体調が心配"], ["今日は天気がいい"], ["コンビニのアイスが当たり"],
    ["出張の準備が大変", "資料作りが終わらない"], ["カレー作った", "スパイスから"],
  ];
  for (const turns of cases) {
    const before = selectBefore(turns);
    const after = ids(turns);
    if (r.deriveConversationPersonFocus(turns, pool) === null) assert.deepEqual(after, before, turns.join(" / "));
    assert.ok(after.length <= Math.max(before.length, 1) || after.every((id) => SAKI.has(id) || YUTO.has(id)), turns.join(" / "));
  }
});

test("引き継いだ人物の加点は、その人物の記録を持つMemoryだけに付き、既存の足切り（最低点・上位件数・相対フィルタ）はそのまま", () => {
  const sel = select(SAKI_CHAT);
  assert.ok(sel.kept.length <= r.DEFAULT_LIMIT);
  for (const e of sel.kept) assert.equal(e.personBonus, r.PERSON_CARRY_WEIGHT);
  const scored = r.scoreConversationCandidates(pool, SAKI_CHAT[4], [], freq, sel.personFocus);
  for (const e of scored) assert.equal(e.personBonus > 0, SAKI.has(e.memory.id), e.memory.summary);
  assert.equal(sel.personFocus?.displayName, "さき");
});
