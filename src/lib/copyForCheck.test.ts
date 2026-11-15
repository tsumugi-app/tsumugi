/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * 実機確認用のコピー（表示・コピー専用）のテスト。架空のデータだけ。
 *   - [D]の「診断ログをコピー」：質問・返答の全文、Generation ID・モデル、経路ごとの件数、A・B・C、本人の理由・訂正、Cの項目と理由、警告、
 *     重複の削減のON/OFF、サーバーの実際の入力と端末の仮想判定の区別。8,000字以内。超えるときは省略した件数と種類を書く（黙って切らない）
 *   - 会話画面の「会話をコピー」：現在のチャットの発言を時系列・原文のまま。発言日時だけ（出来事の日時と混ぜない）。診断・JSONを入れない。長い会話も欠けない
 *   - コピーに失敗したときはfalse（成功と表示しない）
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
const stubs: Record<string, unknown> = {
  "./db": { getAllMemoryObjects: async () => [], getAllConversations: async () => [], getMemoryObject: async () => undefined },
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
const dc = require(path.join(ROOT, "lib/debugCopy.js")) as typeof import("./debugCopy");
const cc = require(path.join(ROOT, "lib/conversationCopy.js")) as typeof import("./conversationCopy");
const ct = require(path.join(ROOT, "lib/copyText.js")) as typeof import("./copyText");
const cb = require(path.join(ROOT, "lib/contextBuilder.js")) as typeof import("./contextBuilder");

type RetrievedMemory = import("./types").RetrievedMemory;
type ConversationTurn = import("./types").ConversationTurn;
type GenerationDebugContext = import("./generationDebugProtocol").GenerationDebugContext;

const Q = "以前、未来がないと言ったのは、どういう理由だったっけ？";
const REASON = "未来がないって言ったのは、自分が来年から海外に転勤するから、一緒にいられる時間が無いって意味だよ。";
const ANSWER = "11月9日の会話で、来年から海外に転勤するので一緒にいられる時間が無い、という意味だと話していたよ。";
const AT = "2026-11-09T10:00:00.000Z";
const rm = (id: string, summary: string, quote?: string): RetrievedMemory => ({ id, date: AT, summary, keywords: ["未来"], ...(quote ? { quote } : {}) } as RetrievedMemory);
const timeline = [{ topicId: "t1", events: [
  { time: "2026-09-01T10:00:00.000Z", quote: "みおさんと初めて会った", sourceConversationId: "c0" },
  { time: AT, quote: REASON, sourceConversationId: "c1" },
  { time: "2026-11-14T10:00:00.000Z", quote: "物語を考えてみようと思う", sourceConversationId: "c2" },
  { time: "2026-11-15T10:00:00.000Z", quote: "2023年の9月からだよ", sourceConversationId: "c3" },
] }];
const retrieved = [rm("m-r", "未来がないと言った理由を話した", REASON), rm("m-x", "週末にカフェへ行った")];
const server: GenerationDebugContext = { recentConversation: null, profile: null, personView: null, topicTimeline: timeline, topicContinuity: null, retrievedMemory: retrieved };
const generation = { persona: "companion", provider: "gemini", model: "gemini-test", thinkingBudget: 0, maxOutputTokens: 2048, searchNeeded: false };
const builder = () => ({
  report: cb.buildContextBuilderReport({ question: Q, turnCount: 1, retrievedMemories: retrieved, topicTimeline: timeline, persona: "companion" }, []),
  server: null,
  serverReason: { asked: true, terms: ["未来"], sent: [{ route: "Retrieval" as const, memoryId: "m-r", text: REASON }] },
});
const len = (t: string) => Array.from(t).length;

test("1 the short diagnostic copy carries what a check needs, apart: the question and the answer in full, the model, the counts, A / B / C, the reasons, C with its reasons, dedupe, the server's real input and the client's virtual judgement", () => {
  const text = dc.formatDebugCopy({ question: Q, answer: ANSWER, generationId: "gen-1", generation, serverAccepted: server, builder: builder() });
  for (const s of [Q, ANSWER, "Generation ID：gen-1", "gemini / gemini-test", "maxOutputTokens：2048", "Retrieval 2件", "Topic Timeline（経緯の発言） 4件",
    "■ サーバーが受け取った値（実際の入力）", "■ 端末の仮想判定（Context Builder。実際の入力は変えていない）", "直接根拠", "関連する文脈", "関連性の低い補助情報",
    "仮にCを省いた場合", "本人の理由・訂正（実際のプロンプト）：話題の語 未来　入った1件", "重複の削減：OFF", "■ Cに分類された項目", "■ 警告・取りこぼし・注記"]) assert.ok(text.includes(s), `missing: ${s}\n${text}`);
  // C with its reason (the unrelated Topic Timeline line of the device's shape)
  assert.ok(/■ Cに分類された項目[\s\S]*物語を考えてみようと思う/.test(text), text);
  // the stated reason, as the user said it, with whether it is sent
  assert.ok(/渡る：[^\n]*未来がないって言ったのは/.test(text), text);
  assert.ok(len(text) <= dc.DEBUG_COPY_TARGET_CHARS, `${len(text)} chars`);
  assert.ok(!text.includes('{"') && !text.includes('"retrievedMemory"'), "no raw JSON");
  assert.ok(text.includes("省略なし"), "says nothing was left out");
  console.log(`CI-REPORT 診断ログの短縮コピー（架空データ）：${len(text)}字`);
});

test("2 over the target: the lists get shorter, and what was left out is said (count and kind); the question and the answer stay whole", () => {
  const b = builder();
  const many = Array.from({ length: 300 }, (_, k) => ({ index: k, route: "Retrieval" as const, part: "要約", kind: "AIの要約" as const, memoryIds: [`m${k}`], text: `関係の薄い記録その${k}について、長めの説明が続く文。`.repeat(2), chars: 60, why: "検索で選ばれたが、質問の話題にも人物にも一致しない（会話の広がりとして残す）" }));
  b.report.relevance.omitCandidates = many;
  const text = dc.formatDebugCopy({ question: Q, answer: ANSWER, generationId: "gen-2", generation, serverAccepted: server, builder: b });
  assert.ok(len(text) <= dc.DEBUG_COPY_TARGET_CHARS, `${len(text)} chars`);
  assert.ok(text.includes(Q) && text.includes(ANSWER));
  assert.match(text, /（ほか\d+件を省略：Cの項目。詳細は\[D\]の表示にある）/);
  assert.match(text, /省略：Cの項目 \d+件/);
  // a very long answer is never cut: the note says the target was passed
  const long = "とても長い返答。".repeat(1500);
  const t2 = dc.formatDebugCopy({ question: Q, answer: long, generationId: "gen-3", generation, serverAccepted: server, builder: b });
  assert.ok(t2.includes(long), "the whole answer");
  assert.match(t2, /目標の8000字を超えた。質問・返答・警告は全文のまま/);
});

test("2b the server's real input comes before the client's virtual judgement; reasons are shortened only after the C items; the provenance counts name Memory Graph", () => {
  const b = builder();
  b.report.relevance.omitCandidates = Array.from({ length: 300 }, (_, k) => ({ index: k, route: "Retrieval" as const, part: "要約", kind: "AIの要約" as const, memoryIds: [`m${k}`], text: `関係の薄い記録その${k}の長めの説明文。`.repeat(3), chars: 60, why: "質問の話題にも人物にも一致しない" }));
  const text = dc.formatDebugCopy({ question: Q, answer: ANSWER, generationId: "gen-5", generation, serverAccepted: server, serverRouteCounts: { "Memory Graph": 4, "Memory Timeline": 2 }, builder: b });
  const at = (s: string) => text.indexOf(s);
  assert.ok(at("■ サーバーが受け取った値") < at("■ 実際のプロンプトに入った本人の理由・訂正（サーバー）"));
  assert.ok(at("■ 実際のプロンプトに入った本人の理由・訂正（サーバー）") < at("■ 端末の仮想判定"), "server lists stay under the server heading");
  assert.ok(text.includes("Memory Graph（由来の項目） 4件") && text.includes("Memory Timeline（由来の項目） 2件"));
  assert.ok(text.includes(`「${REASON}」`), "the user's reason in full, though the C list was cut");
  assert.match(text, /省略：Cの項目 \d+件/);
  assert.ok(!/省略：[^）]*理由・訂正の候補/.test(text), "the reasons are not cut while the C items can be");
  assert.ok(len(text) <= dc.DEBUG_COPY_TARGET_CHARS);
});

test("3 no Context Builder record (after a reload): said so, the rest is still there", () => {
  const text = dc.formatDebugCopy({ question: Q, answer: ANSWER, generationId: "gen-4", generation, serverAccepted: server, builder: null });
  assert.ok(text.includes("記録なし（このタブで送ったターンだけ。再読み込みの後は無い）"));
  assert.ok(text.includes("重複の削減：不明（このタブの記録なし）") && text.includes("本人の理由・訂正（実際のプロンプト）：不明"), "said unknown, not omitted");
  assert.ok(text.includes("Memory Graph・Memory Timeline・Synthesis・Reflection の件数：このタブの記録なし"));
  assert.ok(text.includes(ANSWER) && text.includes("Retrieval 2件"));
});

test("4 the conversation copy: the current chat's turns in order, word for word, with the time each was said (not the time of what it is about); no diagnostics", () => {
  const stamp = (iso: string | undefined) => (iso ? { date: iso.slice(0, 10), time: iso.slice(11, 16) } : null);
  const turns: ConversationTurn[] = [
    { role: "user", content: Q, timestamp: "2026-11-15T09:00:00.000Z" },
    { role: "ai", content: "途中まで", timestamp: "2026-11-15T09:00:05.000Z", interrupted: true },
    { role: "ai", content: ANSWER, timestamp: "2026-11-15T09:00:30.000Z" },
    { role: "user", content: "ありがとう。\n2行目もそのまま。", timestamp: "2026-11-16T08:00:00.000Z" },
  ];
  const text = cc.formatConversationForCopy(turns, { stamp });
  assert.equal(text, [
    "【会話ログ】", "（日時は発言した日時で、この端末の現地時刻。話の中の出来事の日時ではない）",
    "", "■ 2026-11-15",
    "", "ユーザー（09:00）：", Q,
    "", "Tsumugi（09:00・途中で止まり、再生成された返答）：", "途中まで",
    "", "Tsumugi（09:00）：", ANSWER,
    "", "■ 2026-11-16",
    "", "ユーザー（08:00）：", "ありがとう。\n2行目もそのまま。",
  ].join("\n"));
  assert.ok(!text.includes("Generation") && !text.includes("{"), "no diagnostics, no JSON");
  // a realtime diary: its date is apart from the times said
  assert.ok(cc.formatConversationForCopy(turns, { stamp, diaryDate: "2026-11-14" }).includes("リアルタイム日記の日付：2026-11-14"));
  // a long conversation: every turn, in order
  const longTurns: ConversationTurn[] = Array.from({ length: 600 }, (_, k) => ({ role: k % 2 === 0 ? "user" : "ai", content: `発言${k}`, timestamp: new Date(Date.UTC(2026, 10, 15, 0, 0, k)).toISOString() }));
  const longText = cc.formatConversationForCopy(longTurns, { stamp });
  const said = longText.split("\n").filter((l) => /^発言\d+$/.test(l));
  assert.deepEqual(said, longTurns.map((t) => t.content), "every turn, once, in order");
  // a turn without a valid time: no made-up date
  assert.ok(cc.formatConversationForCopy([{ role: "user", content: "こんにちは", timestamp: "" }]).endsWith("ユーザー：\nこんにちは"));
});

test("5 copying: true only when the copy succeeded; a refused clipboard with no other way is false (never shown as copied)", async () => {
  type Env = import("./copyText").CopyEnv;
  let got = "";
  assert.equal(await ct.copyText("abc", { navigator: { clipboard: { writeText: async (t: string) => { got = t; } } } }), true);
  assert.equal(got, "abc");
  const refused = { clipboard: { writeText: async () => { throw new Error("denied"); } } };
  assert.equal(await ct.copyText("abc", { navigator: refused }), false, "refused and no fallback");
  const area = () => ({ value: "", style: {}, setAttribute: () => undefined, select: () => undefined, setSelectionRange: () => undefined });
  const body = { appendChild: () => undefined, removeChild: () => undefined };
  const doc = (ok: boolean) => ({ body, createElement: area, execCommand: () => ok }) as unknown as Env["document"];
  assert.equal(await ct.copyText("abc", { navigator: refused, document: doc(false) }), false, "execCommand false is a failure");
  assert.equal(await ct.copyText("abc", { navigator: refused, document: doc(true) }), true, "the selection copy");
  assert.equal(await ct.copyText("abc", {}), false, "no clipboard at all");
});
