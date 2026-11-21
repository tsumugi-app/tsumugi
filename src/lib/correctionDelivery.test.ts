/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * N6 訂正優先（案B 消費側＋案C 記録経路）: API を呼ばない選択・配送・状態のテスト。
 *
 * 守る条件（オーナー承認 2026-11-21）:
 * - 記録・整理リクエストでは、話題の語が今の発言になくても、その話題の訂正記録が必ず届く（N6 再現ケース）。
 * - 打ち消された AI の解釈（Reflection）は、訂正とペアでなければ会話に渡らない。単独で「今の理由」にならない。
 * - 訂正済みの本人の記録には、訂正の逐語を添えた注記（correctionNote）が付き、プロンプトにもその行が出る。
 * - 訂正情報が無い古い Vault では、記録経路で話題の裏付け（本人の記録）が無い Reflection を渡さない（案C フォールバック）。
 * - Timeline の「今の状態」の根拠に、打ち消された記録を使わない（過去の点としては残る）。
 * - Synthesis のクラスタ根拠は、打ち消された記録だけで組み立てない（訂正記録を必ず対にする）。
 * - corrections は Vault（Markdown）の往復で失われない。壊れた値は読み込みで捨てる（fail-soft）。
 *
 * 架空データのみ（contextEvalWorld の転職ケース＋このファイル内の小さな世界）。AI は呼ばない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
type Persona = import("./types").Persona;
type RetrievedMemory = import("./types").RetrievedMemory;
let pool: MemoryObject[] = [];
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => { throw new Error("no AI in this suite"); }, resolveApiKey: () => "k", resolveModel: () => "m", resolveRequestedProvider: () => "gemini" },
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
const mc = require(path.join(ROOT, "lib/memoryContext.js")) as typeof import("./memoryContext");
const ms = require(path.join(ROOT, "lib/memorySynthesis.js")) as typeof import("./memorySynthesis");
const md = require(path.join(ROOT, "lib/markdown.js")) as typeof import("./markdown");
const world = require(path.join(ROOT, "lib/contextEvalWorld.js")) as typeof import("./contextEvalWorld");

/** 会話画面と同じ形の呼び出し（retrievalPurposeRelevance.test.ts と同じ組み立て） */
async function run(q: string, recent: string[], memories: MemoryObject[], persona: Persona = "companion"): Promise<RetrievedMemory[]> {
  pool = memories;
  const reflective = r.isReflectiveQuery(q);
  return r.retrieveRelevantMemoriesImpl(q, {
    excludeConversationId: "now", limit: reflective ? r.REFLECTIVE_LIMIT : undefined, maxLinkedAdditions: reflective ? r.REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
    persona, recentUserTurnsTexts: recent, includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance: true,
  });
}

const CORRECTION_QUOTE = "給料って言ったけど、本当は今のチームを離れたくなかったからなんだ";
/** Capture が job-3 の保存時に付けるはずのリンク（検出の実出力と同じ形。job-2 は文末「から」だけで理由形を持たないため対象外＝correction.test.ts で固定） */
const correctedEvalWorld = (): MemoryObject[] =>
  world.evalMemories().map((m) =>
    m.id === "job-3"
      ? { ...m, corrections: [{ id: "corr-job3-refl", targetMemoryId: "job-refl", quote: CORRECTION_QUOTE, statedAt: "2026-09-13T03:00:00.000Z", sourceConversationId: "c-job-3", recordedAt: "2026-09-13T03:00:00.000Z", schemaVersion: 1 as const }] }
      : m
  );

const N6_TURN = "ここまでの話、整理して残して。で、私は今どういう段階に来ているんだろう";
const N6_EARLIER = "この間の転職の話なんだけど、やめた理由を聞かれたら給料って答えてるんだよね";

test("N6再現(i)(vii): 記録リクエスト（話題の語なし）で訂正記録が届き、打ち消されたReflectionは単独で渡らない", async () => {
  const res = await run(N6_TURN, [N6_EARLIER], correctedEvalWorld());
  const ids = res.map((m) => m.id);
  assert.ok(ids.includes("job-3"), `訂正記録 job-3 が届く (got: ${ids.join(",")})`);
  const refl = res.find((m) => m.id === "job-refl");
  if (refl) {
    assert.ok(refl.correctionNote, "job-refl が渡るなら訂正注記が付く");
    assert.ok(refl.correctionNote!.quote.includes("本当は"), "注記に本人の訂正の逐語が入る");
    assert.ok(mc.memoryContextLines(refl).includes("訂正あり"), "プロンプトの行にも訂正が出る");
  }
});

test("案Cフォールバック(i): 訂正情報の無い古いVaultでは、記録経路で裏付けの無いReflectionを渡さない", async () => {
  const res = await run(N6_TURN, [N6_EARLIER], world.evalMemories());
  const ids = res.map((m) => m.id);
  assert.ok(!ids.includes("job-refl"), `job-refl は渡らない (got: ${ids.join(",")})`);
});

test("通常会話でも、打ち消されたReflectionは訂正とペアでなければ渡らない", async () => {
  const res = await run("転職のこと、最近どうなってたっけ？", [], correctedEvalWorld());
  const ids = res.map((m) => m.id);
  const refl = res.find((m) => m.id === "job-refl");
  if (refl) {
    assert.ok(ids.includes("job-3"), "job-refl が渡るなら訂正 job-3 も一緒");
    assert.ok(refl.correctionNote, "訂正注記が付く");
  }
});

test("振り返り(viii): 訂正前と訂正後の本人の記録が両方届き、Reflectionはペア＋注記でのみ届く", async () => {
  const res = await run("転職をやめた理由って、どう変わってきたんだっけ？", [], correctedEvalWorld());
  const ids = res.map((m) => m.id);
  assert.ok(ids.includes("job-2"), `訂正前の本人の記録 job-2 が届く (got: ${ids.join(",")})`);
  assert.ok(ids.includes("job-3"), `訂正後の記録 job-3 が届く (got: ${ids.join(",")})`);
  const refl = res.find((m) => m.id === "job-refl");
  if (refl) assert.ok(refl.correctionNote, "job-refl には訂正注記が付く");
});

test("打ち消された本人の記録が届くときは、訂正注記が必ず付く（古い理由を単独で使わせない）", async () => {
  const u1 = mem("u-1", "2026-06-01", "c-u1", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], { quote: "転職はやめた。理由は給料が下がるからだ" });
  const u2 = mem("u-2", "2026-07-01", "c-u2", "転職をやめた理由を言い直した。", ["転職", "チーム"], { quote: CORRECTION_QUOTE, corrections: corrTo("u-1", "2026-07-01", "c-u2") });
  const res = await run("転職をやめた理由って何だったっけ？", [], [u1, u2]);
  const ids = res.map((m) => m.id);
  assert.ok(ids.includes("u-1"), `訂正前の本人の記録 u-1 が届く (got: ${ids.join(",")})`);
  const noted = res.find((m) => m.id === "u-1")!;
  assert.ok(noted.correctionNote, "u-1 には訂正注記が付く");
  assert.ok(noted.correctionNote!.quote.includes("本当は"), "注記は訂正の逐語を含む");
  assert.ok(mc.memoryContextLines(noted).includes("訂正あり"), "プロンプトにも訂正の行が出る");
});

test("Link経由で入った打ち消されたReflectionにも、ペアリングの不変条件が効く（Codex on PR #63）", async () => {
  const linked = correctedEvalWorld().map((m) =>
    m.id === "bike-1"
      ? { ...m, links: [{ id: "link-bike-refl", sourceId: "bike-1", targetId: "job-refl", axis: "theme" as const, reason: "同じ時期の話題", contrast: false, strength: 0.9, createdBy: "auto-linked" as const, createdAt: "2026-10-05T03:00:00.000Z" }] }
      : m
  );
  const res = await run(N6_TURN, [N6_EARLIER], linked);
  const ids = res.map((m) => m.id);
  assert.ok(ids.includes("job-3"), `訂正記録 job-3 が届く (got: ${ids.join(",")})`);
  const refl = res.find((m) => m.id === "job-refl");
  if (refl) {
    assert.ok(refl.correctionNote, "Link経由の job-refl にも訂正注記が付く");
    assert.ok(ids.includes("job-3"), "訂正と対になっている");
  }
});

test("記録経路の保証 P2-2: 基礎の選定が空でも、その話題の訂正記録が必ず届く", async () => {
  const p1 = mem("p-1", "2026-06-01", "c-p1", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], { quote: "転職はやめた。理由は給料が下がるからだ" });
  const p2 = mem("p-2", "2026-07-01", "c-p2", "転職をやめた理由を言い直した。", ["転職", "チーム"], { quote: CORRECTION_QUOTE, corrections: corrTo("p-1", "2026-07-01", "c-p2") });
  // 今の発言は記録リクエストのみ（話題の語なし）。基礎の選定は空になる組み立て
  const res = await run("今日の分、記録しておいて", [N6_EARLIER], [p1, p2]);
  const ids = res.map((m) => m.id);
  assert.deepEqual(ids, ["p-2"], `選定が空でも訂正記録 p-2 だけが保証で届く (got: ${ids.join(",")})`);
});

test("記録経路の薄さ対策: Reflectionが外れる話題では、本人の後の発言が補完されて届く", async () => {
  const res = await run(N6_TURN, [N6_EARLIER], world.evalMemories());
  const ids = res.map((m) => m.id);
  assert.ok(!ids.includes("job-refl"), "job-refl は従来どおり渡らない（安全条件は弱めない）");
  assert.ok(ids.includes("job-3"), `本人の後の発言 job-3 が補完で届く (got: ${ids.join(",")})`);
  assert.ok(ids.includes("job-2"), `本人の記録 job-2 も補完で届く (got: ${ids.join(",")})`);
});

test("analyst P2-3: analyst経路でも、打ち消された記録には訂正注記が付く（選定は変えない）", async () => {
  const q = "転職をやめたのって、なんでだったっけ？";
  const res = await run(q, [], correctedEvalWorld(), "analyst");
  const ids = res.map((m) => m.id);
  const refl = res.find((m) => m.id === "job-refl");
  assert.ok(refl, `analyst でも job-refl が選ばれる (got: ${ids.join(",")})`);
  assert.ok(refl!.correctionNote, "job-refl に訂正注記が付く");
  assert.ok(refl!.correctionNote!.quote.includes("本当は"), "注記に本人の訂正の逐語が入る");
  assert.ok(mc.memoryContextLines(refl!).includes("訂正あり"), "プロンプトの行にも訂正が出る");
  const plain = res.find((m) => m.id === "job-1");
  assert.ok(plain && !plain.correctionNote, "打ち消されていない記録には注記は付かない");
  const bare = await run(q, [], world.evalMemories(), "analyst");
  assert.ok(bare.every((m) => !m.correctionNote), "訂正情報の無い世界では analyst でも注記は付かない");
});

test("無関係な話題では訂正注記は付かない（漏れない）", async () => {
  const res = await run("ロードバイクっていくらだったっけ？", [], correctedEvalWorld());
  assert.ok(res.some((m) => m.id === "bike-2"), "自転車の記録は届く");
  assert.ok(res.every((m) => !m.correctionNote), "correctionNote は付かない");
});

// ---- Timeline / Synthesis 用の小さな世界 ----
interface MemOpt { quote?: string; source?: string; corrections?: MemoryObject["corrections"] }
function mem(id: string, day: string, conv: string, summary: string, keywords: string[], opt: MemOpt = {}): MemoryObject {
  const at = `${day}T03:00:00.000Z`;
  return {
    id, date: at, statedAt: at, types: ["conversation"], conversationId: conv, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at,
    ...(opt.quote ? { evidenceQuotes: [opt.quote] } : {}),
    ...(opt.corrections ? { corrections: opt.corrections } : {}),
    metadata: { id: `meta-${id}`, source: opt.source ?? "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}
const corrTo = (targetMemoryId: string, day: string, conv: string) => [
  { id: `corr-${targetMemoryId}`, targetMemoryId, quote: CORRECTION_QUOTE, statedAt: `${day}T03:00:00.000Z`, sourceConversationId: conv, recordedAt: `${day}T03:00:00.000Z`, schemaVersion: 1 as const },
];

test("Timeline: 打ち消された記録は「今の状態」の根拠にならない（過去の点としては残る）", () => {
  const tj1 = mem("tj-1", "2026-05-01", "c-t1", "今の会社からの転職を考え始めたと話した。", ["転職", "仕事"], { quote: "今の会社、そろそろ転職しようかな" });
  const tj2 = mem("tj-2", "2026-06-01", "c-t2", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], { quote: "転職はやめた。理由は給料が下がるからだ" });
  const tj3 = mem("tj-3", "2026-07-01", "c-t3", "転職をやめた理由を言い直した。", ["転職", "チーム"], { quote: CORRECTION_QUOTE });
  const before = ms.buildThemeTimeline("転職", [tj1, tj2, tj3]);
  assert.equal(before.state.basisMemoryId, "tj-2", "対照: 訂正が無ければ tj-2 が今の状態の根拠になる");
  const tj3c = { ...tj3, corrections: corrTo("tj-2", "2026-07-01", "c-t3") };
  const after = ms.buildThemeTimeline("転職", [tj1, tj2, tj3c]);
  assert.notEqual(after.state.basisMemoryId, "tj-2", "訂正後は tj-2 が根拠にならない");
  assert.equal(after.state.basisMemoryId, "tj-1", "根拠は打ち消されていない最新の状態記録へ移る");
  assert.ok((after.state.earlier ?? []).every((e) => e.memoryId !== "tj-2"), "以前の状態としても tj-2 を挙げない");
  assert.ok(after.points.some((p) => p.memoryId === "tj-2"), "tj-2 は時系列の点としては残る（履歴は消さない）");
  assert.ok(after.points.some((p) => p.memoryId === "tj-3"), "訂正記録も点として残る");
});

test("Synthesis: クラスタ根拠は打ち消された記録だけで組み立てない（訂正記録を対にする）", () => {
  const sj0 = mem("sj-0", "2026-05-01", "c-s0", "転職を考え始めたと話した。", ["転職"], { quote: "転職しようかな" });
  const sj4 = mem("sj-4", "2026-05-20", "c-s4", "転職の面接を受けたと話した。", ["転職", "面接"], { quote: "面接を受けた" });
  const sj2 = mem("sj-2", "2026-06-01", "c-s2", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], { quote: "転職はやめた。理由は給料が下がるからだ" });
  // 訂正記録は話題キーワード（転職）を持たない＝通常のクラスタ化では根拠に入らない
  const sj3 = mem("sj-3", "2026-07-01", "c-s3", "転職をやめた理由を言い直した。", ["チーム"], { quote: CORRECTION_QUOTE, corrections: corrTo("sj-2", "2026-07-01", "c-s3") });
  const clusters = ms.buildSynthesisClusters([sj0, sj4, sj2, sj3]);
  const job = clusters.find((c) => c.theme === "転職");
  assert.ok(job, "転職クラスタができる");
  const ids = job.evidence.map((e) => e.id);
  assert.ok(ids.includes("sj-2"), "打ち消された記録も根拠に残る（事実として）");
  assert.ok(ids.includes("sj-3"), `訂正記録 sj-3 が必ず対になる (got: ${ids.join(",")})`);
});

test("Synthesis: 訂正した会話が別の記録で代表されていても、訂正記録が根拠に入る（Codex on PR #63）", () => {
  const sj0 = mem("sj-0", "2026-05-01", "c-s0", "転職を考え始めたと話した。", ["転職"], { quote: "転職しようかな" });
  const sj4 = mem("sj-4", "2026-05-20", "c-s4", "転職の面接を受けたと話した。", ["転職", "面接"], { quote: "面接を受けた" });
  const sj2 = mem("sj-2", "2026-06-01", "c-s2", "転職はやめることにした。理由は給料が下がるからだと話した。", ["転職", "給料"], { quote: "転職はやめた。理由は給料が下がるからだ" });
  const sj3 = mem("sj-3", "2026-07-01", "c-s3", "転職をやめた理由を言い直した。", ["チーム"], { quote: CORRECTION_QUOTE, corrections: corrTo("sj-2", "2026-07-01", "c-s3") });
  // 訂正と同じ会話の、より新しい話題記録がクラスタの代表になるケース
  const sj5 = mem("sj-5", "2026-07-05", "c-s3", "転職活動を振り返った。", ["転職"], { quote: "振り返った" });
  const clusters = ms.buildSynthesisClusters([sj0, sj4, sj2, sj3, sj5]);
  const job = clusters.find((c) => c.theme === "転職");
  assert.ok(job, "転職クラスタができる");
  const ids = job.evidence.map((e) => e.id);
  assert.ok(ids.includes("sj-2"), "打ち消された記録が根拠に残る");
  assert.ok(ids.includes("sj-3"), `代表の置き換えで訂正記録 sj-3 が入る (got: ${ids.join(",")})`);
});

test("Vault往復: corrections は Markdown に保存され、読み戻しても失われない", () => {
  const m = mem("tj-3", "2026-07-01", "c-t3", "転職をやめた理由を言い直した。", ["転職", "チーム"], { quote: CORRECTION_QUOTE, corrections: corrTo("tj-2", "2026-07-01", "c-t3") });
  const text = md.memoryObjectToMarkdown(m);
  assert.ok(text.includes("corrections"), "frontmatter に corrections が書かれる");
  const back = md.parseMemoryObjectMarkdown(text);
  assert.ok(back, "読み戻せる");
  assert.deepEqual(back!.corrections, m.corrections, "往復で同一");
  const plain = mem("tj-1", "2026-05-01", "c-t1", "今の会社からの転職を考え始めたと話した。", ["転職"], { quote: "転職しようかな" });
  const plainText = md.memoryObjectToMarkdown(plain);
  assert.ok(!plainText.includes("corrections"), "訂正の無いMemoryにはキーを書かない");
  const plainBack = md.parseMemoryObjectMarkdown(plainText);
  assert.equal(plainBack!.corrections, undefined, "古い形式のまま読める（後方互換）");
});

test("route検証: correctionNote は形と長さだけ検証され、壊れた値は落とされる", () => {
  const base = { id: "x", date: "2026-07-01T03:00:00.000Z", summary: "要約", keywords: ["転職"] } as unknown as RetrievedMemory;
  const ok = mc.sanitizeMemoryContext([{ ...base, correctionNote: { quote: "あ".repeat(120) } }], "");
  assert.ok(ok[0].correctionNote, "正しい形は残る");
  assert.ok(Array.from(ok[0].correctionNote!.quote).length <= 81, "逐語は上限で切られる");
  const bad = mc.sanitizeMemoryContext([{ ...base, correctionNote: { quote: 5 } as unknown as { quote: string } }], "");
  assert.equal(bad[0].correctionNote, undefined, "壊れた値は落とされる");
  const lines = mc.memoryContextLines({ correctionNote: { quote: CORRECTION_QUOTE } });
  assert.ok(lines.includes("訂正あり") && lines.includes("本当は"), "プロンプト行に訂正の逐語が出る");
});
