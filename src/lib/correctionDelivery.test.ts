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

test("記録経路の補完は、別の話題のReflectionの裏付け（本人の記録）を追い出さない（Codex 再レビュー）", async () => {
  // 枠が満杯（上限3）で、話題AのReflectionには本人の記録の裏付けがあり、話題BのReflectionには裏付けが無い場面。
  // Bの補完の入れ替えでAの裏付け（最もスコアの低い a-1）を追い出すと、AのReflectionが
  // 「裏付けあり」の判定のまま単独で残ってしまう（修正前は実際に [a-2, b-3] になった）。
  const a1 = mem("a-1", "2026-03-01", "c-a1", "温泉旅行へ行った。宿の食事も美味しく、露天風呂にもゆっくり入った。地元の蕎麦屋にも寄って、家族への土産も買った。", ["旅行", "温泉"], { quote: "春に温泉旅行へ行った" });
  const a2 = mem("a-2", "2026-03-02", "c-a2", "温泉とお金の話が心に残ったようだ。", ["旅行", "温泉"], { source: "system-generated" });
  const b2 = mem("b-2", "2026-04-02", "c-b2", "お金の話、記録に残る不安が強かったようだ。", ["転職", "お金"], { source: "system-generated" });
  const b3 = mem("b-3", "2026-05-01", "c-b3", "今はチームの雰囲気が良く、転職は考えていないと述べた。", ["転職", "チーム"], { quote: "最近はチームの雰囲気が良くて、転職は考えていない" });
  pool = [a1, a2, b2, b3];
  const res = await r.retrieveRelevantMemoriesImpl("温泉とお金の話、記録しておいて", {
    excludeConversationId: "now", limit: 3, persona: "companion", recentUserTurnsTexts: [], includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance: true,
  });
  const ids = res.map((m) => m.id);
  assert.ok(ids.includes("b-3"), `話題Bの本人の記録 b-3 が補完で届く (got: ${ids.join(",")})`);
  assert.ok(!(ids.includes("a-2") && !ids.includes("a-1")), `話題AのReflectionが裏付けなしで単独に残らない (got: ${ids.join(",")})`);
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

test("最終確定 R4-a: 訂正リンクの無いVaultで、Link経由で入った裏付けの無いReflectionが記録経路に残らない（監査の最小再現）", async () => {
  // 監査（tsumugi-n6-design-audit.md §3）の世界: 訂正リンクは一切無い。
  // 選定段階では job-refl は scored に無く、フォールバックの検査後に Link で入るのが欠陥だった。
  const t1 = mem("t-1", "2026-03-01", "c-t1", "温泉旅行へ行った。露天風呂にもゆっくり入った。", ["旅行", "温泉"], { quote: "春に温泉旅行へ行った" });
  const refl = mem("job-refl", "2026-06-05", "c-refl", "転職を見送ったのは、お金への不安が強かったからだろう。", ["転職", "お金"], { source: "system-generated" });
  const linked = {
    ...t1,
    links: [{ id: "link-t1-refl", sourceId: "t-1", targetId: "job-refl", axis: "theme" as const, reason: "同じ時期の話題", contrast: false, strength: 0.9, createdBy: "auto-linked" as const, createdAt: "2026-10-05T03:00:00.000Z" }],
  };
  const res = await run("温泉旅行の話、記録しておいて", [], [linked, refl]);
  const ids = res.map((m) => m.id);
  assert.ok(ids.includes("t-1"), `本人の記録 t-1 は届く (got: ${ids.join(",")})`);
  assert.ok(!ids.includes("job-refl"), `Link経由の job-refl は最終確定で外れる (got: ${ids.join(",")})`);
});

test("最終確定 起点Memory: 明示的に呼び出したReflectionは、記録経路でも外さない（出典の区別は保つ）", async () => {
  const t1 = mem("t-1", "2026-03-01", "c-t1", "温泉旅行へ行った。露天風呂にもゆっくり入った。", ["旅行", "温泉"], { quote: "春に温泉旅行へ行った" });
  const refl = mem("job-refl", "2026-06-05", "c-refl", "転職を見送ったのは、お金への不安が強かったからだろう。", ["転職", "お金"], { source: "system-generated" });
  const linked = {
    ...t1,
    links: [{ id: "link-t1-refl", sourceId: "t-1", targetId: "job-refl", axis: "theme" as const, reason: "同じ時期の話題", contrast: false, strength: 0.9, createdBy: "auto-linked" as const, createdAt: "2026-10-05T03:00:00.000Z" }],
  };
  pool = [linked, refl];
  const res = await r.retrieveRelevantMemoriesImpl("温泉旅行の話、記録しておいて", {
    excludeConversationId: "now", persona: "companion", promptedMemoryId: "job-refl",
    recentUserTurnsTexts: [], includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance: true,
  });
  const origin = res.find((m) => m.id === "job-refl");
  assert.ok(origin, "起点として呼び出した job-refl は残る");
  assert.equal(origin!.isOriginMemory, true, "起点 Memory として届く");
  assert.equal(origin!.source, "system-generated", "出典は AI の文章のまま（route が『本人の発言ではない』と表示する根拠）");
});

test("最終確定 起点Memory: 打ち消されたReflectionを呼び出した場合は、注記と訂正記録が対で届く", async () => {
  pool = correctedEvalWorld();
  const res = await r.retrieveRelevantMemoriesImpl("今日は天気がいいね", {
    excludeConversationId: "now", persona: "companion", promptedMemoryId: "job-refl",
    recentUserTurnsTexts: [], includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance: true,
  });
  const ids = res.map((m) => m.id);
  const origin = res.find((m) => m.id === "job-refl");
  assert.ok(origin, "起点の job-refl は外されない");
  assert.ok(origin!.correctionNote, "打ち消された記録として注記が付く");
  assert.ok(ids.includes("job-3"), `訂正記録 job-3 が対として届く (got: ${ids.join(",")})`);
});

test("最終確定 analyst: 訂正記録が選定に無くても、打ち消されたReflectionは訂正と対＋注記で届く", async () => {
  const r1 = mem("r-1", "2026-06-05", "c-r1", "転職を見送ったのは、お金への不安が強かったからだろう。", ["転職", "お金"], { source: "system-generated" });
  const u2 = mem("u-2", "2026-07-01", "c-u2", "言い直した。", ["チーム"], { quote: CORRECTION_QUOTE, corrections: corrTo("r-1", "2026-07-01", "c-u2") });
  const res = await run("転職をやめたのって、なんでだったっけ？", [], [r1, u2], "analyst");
  const ids = res.map((m) => m.id);
  const refl = res.find((m) => m.id === "r-1");
  assert.ok(refl, `analyst でも r-1 が選ばれる (got: ${ids.join(",")})`);
  assert.ok(refl!.correctionNote, "r-1 に訂正注記が付く");
  assert.ok(ids.includes("u-2"), `訂正記録 u-2 が最終確定で対として届く (got: ${ids.join(",")})`);
});

test("最終確定 analyst: 記録リクエストでは、訂正情報の無い裏付けの無いReflectionを analyst でも渡さない", async () => {
  const r1 = mem("r-1", "2026-06-05", "c-r1", "転職を見送ったのは、お金への不安が強かったからだろう。", ["転職", "お金"], { source: "system-generated" });
  const res = await run("転職の話、記録しておいて", [], [r1], "analyst");
  const ids = res.map((m) => m.id);
  assert.ok(!ids.includes("r-1"), `裏付けの無い r-1 は analyst の記録経路でも外れる (got: ${ids.join(",")})`);
});

// ---- 訂正の連鎖（Codex 再レビュー on PR #63: 最終確定で追加された訂正記録にも不変条件を適用する） ----
const CHAIN_B_QUOTE = "給料って言ったけど、本当は今のチームを離れたくなかったからなんだ";
const CHAIN_C_QUOTE = "チームって言ったけど、本当は家族との時間を優先したかったからなんだ";
const corrQ = (targetMemoryId: string, day: string, conv: string, quote: string) => [
  { id: `corr-${targetMemoryId}-${day}`, targetMemoryId, quote, statedAt: `${day}T03:00:00.000Z`, sourceConversationId: conv, recordedAt: `${day}T03:00:00.000Z`, schemaVersion: 1 as const },
];
/** Reflection A を本人の記録 B が訂正し、B を本人の記録 C がさらに訂正する世界（Codex の最小再現と同じ形） */
const chainWorld = (): MemoryObject[] => [
  mem("chain-a", "2026-06-05", "c-chain-a", "転職を見送ったのは、お金への不安が強かったからだろう。", ["転職", "お金"], { source: "system-generated" }),
  mem("chain-b", "2026-07-01", "c-chain-b", "転職をやめた理由を言い直した。", ["転職", "チーム"], { quote: CHAIN_B_QUOTE, corrections: corrQ("chain-a", "2026-07-01", "c-chain-b", CHAIN_B_QUOTE) }),
  mem("chain-c", "2026-08-01", "c-chain-c", "転職をやめた理由をさらに言い直した。", ["転職", "家族"], { quote: CHAIN_C_QUOTE, corrections: corrQ("chain-b", "2026-08-01", "c-chain-c", CHAIN_C_QUOTE) }),
];
const rmOf = (m: MemoryObject): RetrievedMemory =>
  ({ id: m.id, date: m.date, summary: m.summary, keywords: m.keywords }) as unknown as RetrievedMemory;

test("最終確定 連鎖: 起点に呼び出したReflectionの訂正記録（B）自体が訂正（C）されている場合、Bにも注記が付く（Codex 再レビュー）", async () => {
  pool = chainWorld();
  const res = await r.retrieveRelevantMemoriesImpl("今日は天気がいいね", {
    excludeConversationId: "now", persona: "companion", promptedMemoryId: "chain-a",
    recentUserTurnsTexts: [], includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance: true,
  });
  const ids = res.map((m) => m.id);
  const a = res.find((m) => m.id === "chain-a");
  assert.ok(a, "起点の chain-a は外されない");
  assert.ok(a!.correctionNote && a!.correctionNote.quote.includes("チーム"), "chain-a には B の訂正注記が付く");
  const b = res.find((m) => m.id === "chain-b");
  assert.ok(b, `訂正記録 chain-b が対として届く (got: ${ids.join(",")})`);
  assert.ok(b!.correctionNote, "最終確定で追加された chain-b にも訂正注記が付く（打ち消された理由が無資格で残らない）");
  assert.ok(b!.correctionNote!.quote.includes("家族"), "chain-b の注記は C の訂正の逐語を含む");
});

test("最終確定 連鎖: analyst でも、追加された訂正記録に注記が付く（Codex 再レビュー）", async () => {
  pool = chainWorld();
  const res = await r.retrieveRelevantMemoriesImpl("今日は天気がいいね", {
    excludeConversationId: "now", persona: "analyst", promptedMemoryId: "chain-a",
    recentUserTurnsTexts: [], includeContext: true, deferReflections: true, recallTopic: true, purposeRelevance: true,
  });
  const ids = res.map((m) => m.id);
  const a = res.find((m) => m.id === "chain-a");
  assert.ok(a, `analyst でも起点の chain-a は外されない (got: ${ids.join(",")})`);
  const b = res.find((m) => m.id === "chain-b");
  assert.ok(b, `analyst でも訂正記録 chain-b が対として届く (got: ${ids.join(",")})`);
  assert.ok(b!.correctionNote && b!.correctionNote.quote.includes("家族"), "analyst でも chain-b に C の訂正注記が付く");
});

test("最終確定 連鎖（直接）: 長い連鎖でも、最終結果に残る打ち消された記録は全て注記を持つ", () => {
  const q = (n: string) => `訂正${n}の逐語、本当は理由${n}なんだ`;
  const r0 = mem("lc-0", "2026-05-05", "c-lc0", "転職を見送ったのは、お金への不安が強かったからだろう。", ["転職", "お金"], { source: "system-generated" });
  const u1 = mem("lc-1", "2026-06-01", "c-lc1", "転職をやめた理由を言い直した。", ["転職"], { quote: q("1"), corrections: corrQ("lc-0", "2026-06-01", "c-lc1", q("1")) });
  const u2 = mem("lc-2", "2026-07-01", "c-lc2", "転職をやめた理由を言い直した。", ["転職"], { quote: q("2"), corrections: corrQ("lc-1", "2026-07-01", "c-lc2", q("2")) });
  const u3 = mem("lc-3", "2026-08-01", "c-lc3", "転職をやめた理由を言い直した。", ["転職"], { quote: q("3"), corrections: corrQ("lc-2", "2026-08-01", "c-lc3", q("3")) });
  const u4 = mem("lc-4", "2026-09-01", "c-lc4", "転職をやめた理由を言い直した。", ["転職"], { quote: q("4"), corrections: corrQ("lc-3", "2026-09-01", "c-lc4", q("4")) });
  const out = r.finalizeCorrectionInvariants([rmOf(r0)], [r0, u1, u2, u3, u4], { recordRequest: false });
  const ids = out.map((m) => m.id);
  // 本人の記録の訂正は注記（逐語）で表す既存の規則どおり、対として届くのは直接の訂正 lc-1 まで。
  // その lc-1 自身の打ち消しは、lc-2 の逐語の注記で表される
  assert.deepEqual(ids, ["lc-0", "lc-1"], `連鎖の届く範囲 (got: ${ids.join(",")})`);
  assert.equal(out.find((m) => m.id === "lc-0")!.correctionNote!.quote, q("1"), "lc-0 の注記は直接の訂正（lc-1）の逐語");
  assert.equal(out.find((m) => m.id === "lc-1")!.correctionNote!.quote, q("2"), "追加された lc-1 の注記は、その訂正（lc-2）の逐語");
});

test("最終確定 連鎖（直接）: 連鎖の途中にReflectionがあっても、対の追加と注記が最後まで通る", () => {
  const r0 = mem("mc-0", "2026-05-05", "c-mc0", "転職を見送ったのは、お金への不安が強かったからだろう。", ["転職", "お金"], { source: "system-generated" });
  const r1 = mem("mc-1", "2026-06-05", "c-mc1", "転職を見送ったのは、チームの人間関係が理由だろう。", ["転職", "チーム"], { source: "system-generated", corrections: corrQ("mc-0", "2026-06-05", "c-mc1", "お金じゃなくて、本当はチームの人間関係なんだ") });
  const u2 = mem("mc-2", "2026-07-01", "c-mc2", "転職をやめた理由を言い直した。", ["転職", "家族"], { quote: "本当は家族との時間を優先したかったからだ", corrections: corrQ("mc-1", "2026-07-01", "c-mc2", "チームじゃなくて、本当は家族との時間を優先したかったからだ") });
  const out = r.finalizeCorrectionInvariants([rmOf(r0)], [r0, r1, u2], { recordRequest: false });
  const ids = out.map((m) => m.id);
  assert.deepEqual(ids, ["mc-0", "mc-1", "mc-2"], `Reflection の対、その対の対まで届く (got: ${ids.join(",")})`);
  assert.ok(out.find((m) => m.id === "mc-0")!.correctionNote, "mc-0 に注記が付く");
  assert.ok(out.find((m) => m.id === "mc-1")!.correctionNote, "追加された Reflection mc-1 にも注記が付く");
  assert.equal(out.find((m) => m.id === "mc-2")!.correctionNote, undefined, "打ち消されていない訂正記録には注記は付かない");
});

test("最終確定 循環（直接）: 本人の記録同士の循環でも最終確定は止まり、注記が付く", () => {
  const x = mem("cy-x", "2026-06-01", "c-cyx", "転職をやめた理由を述べた記録X。", ["転職"], { quote: "Xの逐語", corrections: corrQ("cy-y", "2026-06-01", "c-cyx", "Xの逐語") });
  const y = mem("cy-y", "2026-07-01", "c-cyy", "転職をやめた理由を述べた記録Y。", ["転職"], { quote: "Yの逐語", corrections: corrQ("cy-x", "2026-07-01", "c-cyy", "Yの逐語") });
  const out = r.finalizeCorrectionInvariants([rmOf(x)], [x, y], { recordRequest: false });
  assert.deepEqual(out.map((m) => m.id), ["cy-x"], "本人の記録は事実として残る（対の追加はしない既存の規則）");
  assert.equal(out[0].correctionNote!.quote, "Yの逐語", "循環でも直接の訂正の注記が付く");
});

test("最終確定 循環（直接）: Reflection同士の循環でも対と注記が付き、止まる", () => {
  const p = mem("cy-p", "2026-06-05", "c-cyp", "転職を見送った理由についてのAIの解釈P。", ["転職"], { source: "system-generated", corrections: corrQ("cy-q", "2026-06-05", "c-cyp", "Pの逐語") });
  const qq = mem("cy-q", "2026-07-05", "c-cyq", "転職を見送った理由についてのAIの解釈Q。", ["転職"], { source: "system-generated", corrections: corrQ("cy-p", "2026-07-05", "c-cyq", "Qの逐語") });
  const out = r.finalizeCorrectionInvariants([rmOf(p)], [p, qq], { recordRequest: false });
  assert.deepEqual(out.map((m) => m.id), ["cy-p", "cy-q"], "互いが対になり、無限に追加されない");
  assert.ok(out.every((m) => m.correctionNote), "両方に注記が付く");
});

test("最終確定 欠損（直接）: 対象の無い訂正リンクは無視され、通常の記録はそのまま届く", () => {
  const d = mem("ml-d", "2026-06-01", "c-mld", "何かを言い直した記録。", ["転職"], { quote: "言い直した", corrections: corrQ("ghost", "2026-06-01", "c-mld", "言い直した") });
  const o = mem("ml-o", "2026-06-02", "c-mlo", "普通の記録。", ["旅行"], { quote: "旅行した" });
  const out = r.finalizeCorrectionInvariants([rmOf(d), rmOf(o)], [d, o], { recordRequest: false });
  assert.deepEqual(out.map((m) => m.id), ["ml-d", "ml-o"], "壊れたリンクがあっても結果は変わらない");
  assert.ok(out.every((m) => !m.correctionNote), "実在しない対象へのリンクでは注記は付かない");
});

test("最終確定 欠損（直接）: 連鎖の先の訂正がプールに無い場合、視界にある範囲の注記で安全に劣化する", () => {
  const worldPool = chainWorld().filter((m) => m.id !== "chain-c");
  const a = worldPool.find((m) => m.id === "chain-a")!;
  const out = r.finalizeCorrectionInvariants([rmOf(a)], worldPool, { recordRequest: false });
  const ids = out.map((m) => m.id);
  assert.deepEqual(ids, ["chain-a", "chain-b"], `対は届く (got: ${ids.join(",")})`);
  assert.ok(out.find((m) => m.id === "chain-a")!.correctionNote, "chain-a には注記が付く");
  assert.equal(out.find((m) => m.id === "chain-b")!.correctionNote, undefined, "プールに無い訂正は注記にできない（視界の範囲で劣化し、壊れない）");
});

test("最終確定 重複（直接）: 同じ訂正記録が2件の対象の対でも、追加は1回だけ", () => {
  const a1 = mem("dp-1", "2026-06-05", "c-dp1", "転職を見送ったのは、お金への不安が強かったからだろう。", ["転職", "お金"], { source: "system-generated" });
  const a2 = mem("dp-2", "2026-06-06", "c-dp2", "転職を見送ったのは、通勤が遠いからだろう。", ["転職", "通勤"], { source: "system-generated" });
  const b = mem("dp-b", "2026-07-01", "c-dpb", "転職をやめた理由を言い直した。", ["転職", "チーム"], { quote: CHAIN_B_QUOTE, corrections: [...corrQ("dp-1", "2026-07-01", "c-dpb", CHAIN_B_QUOTE), ...corrQ("dp-2", "2026-07-01", "c-dpb", CHAIN_B_QUOTE)] });
  const out = r.finalizeCorrectionInvariants([rmOf(a1), rmOf(a2)], [a1, a2, b], { recordRequest: false });
  assert.equal(out.filter((m) => m.id === "dp-b").length, 1, "訂正記録は1回だけ追加される");
  assert.ok(out.find((m) => m.id === "dp-1")!.correctionNote && out.find((m) => m.id === "dp-2")!.correctionNote, "両方の対象に注記が付く");
});

test("最終確定 重複（直接）: 同じ記録が二重に届いても、判定は一度だけ・対も一回だけ", () => {
  const worldPool = chainWorld();
  const a = worldPool.find((m) => m.id === "chain-a")!;
  const out = r.finalizeCorrectionInvariants([rmOf(a), rmOf(a)], worldPool, { recordRequest: false });
  assert.equal(out.filter((m) => m.id === "chain-a").length, 2, "入力の重複コピーは両方残る（従来どおり）");
  assert.equal(out.filter((m) => m.id === "chain-b").length, 1, "対の追加は1回だけ");
  assert.ok(out.filter((m) => m.id === "chain-a").every((m) => m.correctionNote), "両コピーに注記が付く");
  assert.ok(out.find((m) => m.id === "chain-b")!.correctionNote, "追加された訂正記録にも注記が付く");
});

test("最終確定 通常（直接）: 訂正されていない記録には何もしない", () => {
  const o1 = mem("od-1", "2026-05-01", "c-od1", "普通の記録1。", ["旅行"], { quote: "旅行した" });
  const o2 = mem("od-2", "2026-05-02", "c-od2", "普通の記録2。", ["仕事"], { quote: "仕事した" });
  const input = [rmOf(o1), rmOf(o2)];
  const out = r.finalizeCorrectionInvariants(input, [...chainWorld(), o1, o2], { recordRequest: false });
  assert.deepEqual(out.map((m) => m.id), ["od-1", "od-2"], "順序も件数も変わらない");
  assert.ok(out.every((m) => !m.correctionNote), "注記は付かない");
  assert.equal(out[0], input[0], "記録オブジェクト自体は書き換えない");
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
