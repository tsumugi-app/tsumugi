import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSynthesisClusters, buildSynthesisSection, buildThemeTimeline, dropItemsWithMissingEvidence, renderClustersForModel, safeSelectTimelineForTurn,
  sanitizeSynthesisContext, selectTimelineForTurn, statusOf, themeTerms, validateSynthesisItems, SYNTHESIS_LIMITS,
} from "./memorySynthesis";
import { FICTIONAL_USERS, fictionalSynthesisMemories } from "./synthesisFictionalData";
import type { MemoryObject } from "./types";

const memories = fictionalSynthesisMemories();
const clusters = buildSynthesisClusters(memories);
const themes = clusters.map((c) => c.theme);
const work = clusters.find((c) => c.theme === "仕事")!;
const ids = work.evidence.map((e) => e.id);
const running = clusters.find((c) => c.theme === "ランニング")!;
const alone = clusters.find((c) => c.theme === "一人の時間")!;
const userB = FICTIONAL_USERS.find((u) => u.id === "B")!.memories();
const userC = FICTIONAL_USERS.find((u) => u.id === "C")!.memories();
const byId = (list: MemoryObject[], id: string) => list.find((m) => m.id === id)!;

test("clusters: only themes the user came back to in 3+ conversations over 2+ weeks; one-off topics and Tsumugi's own reflections are not sent", () => {
  assert.ok(themes.includes("仕事") && themes.includes("ランニング") && themes.includes("一人の時間"), themes.join(","));
  assert.ok(!themes.includes("料理") && !themes.includes("映画"), themes.join(","));
  assert.ok(clusters.length <= SYNTHESIS_LIMITS.maxClusters);
  assert.ok(new Set(clusters.flatMap((c) => c.evidence.map((e) => e.id))).size < memories.length, "not every Memory is sent");
  const withReflection = [...memories, { ...memories[0], id: "refl-1", conversationId: "syn-conv-99", metadata: { ...memories[0].metadata, source: "system-generated" } } as MemoryObject];
  assert.ok(!buildSynthesisClusters(withReflection).some((c) => c.evidence.some((e) => e.id === "refl-1")));
});

test("status words: literal, not negated, not someone else's thing", () => {
  assert.equal(statusOf("異動の話はいったん保留になったが、勉強は続けたいと話した。"), "保留");
  assert.equal(statusOf("台風で家族の沖縄旅行が中止になったと話した。"), "中止");
  assert.equal(statusOf("10kmの大会に申し込んだと話した。"), "予定");
  assert.equal(statusOf("車の修理が終わって戻ってきたと話した。"), "実施済み");
  assert.equal(statusOf("職場に近い部屋への引っ越しを考え始めたと話した。"), "検討中");
  assert.equal(statusOf("古いSF映画を観て面白かったと話した。"), undefined);
  // negation
  assert.equal(statusOf("今のところ引っ越しの予定はないと話した。"), undefined);
  assert.equal(statusOf("異動は保留にはしていないと話した。"), undefined);
  assert.equal(statusOf("結局、大会には申し込まなかったと話した。"), undefined);
  assert.equal(statusOf("部品が届かず、車の修理がまだ終わらないと話した。"), undefined);
  // another person's thing of the same theme
  assert.equal(statusOf("友達の引っ越しを手伝い、無事に終わったと話した。", ["引っ越し"]), undefined);
  assert.equal(statusOf("姉の引っ越しが延期になったと話した。", ["引っ越し"]), undefined);
  assert.equal(statusOf("引っ越しが終わり、通勤が20分になったと話した。", ["引っ越し"]), "実施済み");
});

test("state: a later record without a status does not erase the state (move done, then the bakery)", () => {
  const { state, points } = buildThemeTimeline("引っ越し", userC);
  assert.equal(state.status, "実施済み");
  assert.ok(state.basisSummary!.includes("引っ越しが終わり"), state.basisSummary);
  assert.equal(state.basisEventTime, "2026-07-27");
  const latestSaid = points.find((p) => p.latestSaid)!;
  assert.ok(latestSaid.summary.includes("パン屋") && !latestSaid.stateBasis, "the latest statement is kept apart from the state");
  assert.equal(points.filter((p) => p.stateBasis).length, 1);
});

test("state: car repair done; work on hold; shorter hours in effect while an old setback told in October stays in the past", () => {
  const car = buildThemeTimeline("車", userC);
  assert.equal(car.state.status, "実施済み");
  assert.ok(car.state.basisSummary!.includes("戻ってきた"));
  const workA = buildThemeTimeline("仕事", memories);
  assert.equal(workA.state.status, "保留");
  const workB = buildThemeTimeline("仕事", userB);
  assert.equal(workB.state.status, "実施済み");
  assert.ok(workB.state.basisSummary!.includes("時短勤務になった"));
  const retro = workB.points.find((p) => p.retrospective)!;
  assert.ok(retro.summary.includes("新卒") && retro.latestSaid && !retro.stateBasis && !retro.latestEvent, "told last, but neither the state nor the latest event");
  assert.equal(workB.points[0], retro, "placed at its event date (2019)");
  const trip = buildThemeTimeline(buildSynthesisClusters(userB).find((c) => c.theme === "旅行" || c.theme === "沖縄")!.theme, userB);
  assert.equal(trip.state.status, "保留", "rebooked for next spring, not the cancelled summer trip");
});

test("state: '不明' when no record of the theme states one (nothing is guessed)", () => {
  const t = buildThemeTimeline("一人の時間", memories);
  assert.equal(t.state.status, "不明");
  assert.equal(t.state.basisMemoryId, undefined);
  assert.ok(t.points.every((p) => !p.stateBasis));
});

test("theme terms: a single kanji that sits inside common words (近 in 最近) does not make a turn related; '走ろう' still finds running", () => {
  assert.ok(!selectTimelineForTurn(userC, { userText: "最近また仕事のことで考えちゃって。今の会社、このままでいいのかな", retrievedMemoryIds: [] }).some((c) => c.theme === "引っ越し"));
  assert.ok(!themeTerms("引っ越し", userC).includes("近") && !themeTerms("引っ越し", userC).includes("屋"));
  assert.ok(themeTerms("ランニング", memories).includes("走"));
});

test("Capture's ordinary Memories tagged 'insight' are the user's own records and are used; Tsumugi's reflections (system-generated) are not", () => {
  const at = "2026-10-25T16:58:30.000Z";
  const captured = { ...userC[0], id: "cap-1", conversationId: "cap-conv", types: ["conversation", "insight"], summary: "引っ越し後、以前よりも通勤が楽になったと感じている", keywords: ["引っ越し", "通勤"], statedAt: at, date: at } as MemoryObject;
  const t = buildThemeTimeline("引っ越し", [...userC, captured]);
  assert.ok(t.points.find((p) => p.latestSaid)!.memoryId === "cap-1");
  assert.equal(t.state.status, "実施済み", "still the move, from the record that states it");
  const reflection = { ...captured, id: "refl-2", types: ["insight"], metadata: { ...captured.metadata, source: "system-generated" } } as MemoryObject;
  assert.ok(buildThemeTimeline("引っ越し", [...userC, reflection]).points.every((p) => p.memoryId !== "refl-2"));
});

test("a newer status about a different thing of the same theme does not hide the earlier one (car: repair done, then a drive being considered)", () => {
  const at = "2026-10-25T16:57:57.000Z";
  const drive = { ...userC[0], id: "cap-drive", conversationId: "cap-conv-2", types: ["conversation", "idea"], summary: "週末に車でドライブに行くことを検討している。", keywords: ["ドライブ", "車", "週末"], statedAt: at, date: at } as MemoryObject;
  const t = buildThemeTimeline("車", [...userC, drive]);
  assert.equal(t.state.status, "検討中");
  assert.deepEqual(t.state.earlier!.map((e) => e.status), ["実施済み"]);
  assert.ok(t.state.earlier![0].summary.includes("戻ってきた"));
  const section = buildSynthesisSection(sanitizeSynthesisContext(JSON.parse(JSON.stringify(selectTimelineForTurn([...userC, drive], { userText: "車でドライブ行こうかな", retrievedMemoryIds: [] })))));
  assert.ok(section.includes("それより前の別の状態の記録: 実施済み") && section.includes("対象を取り違えない"), section);
});

test("deleted Memories are not in the timeline and cannot be the state basis", () => {
  const moveDone = userC.find((m) => m.summary.includes("引っ越しが終わり"))!;
  const without = userC.filter((m) => m.id !== moveDone.id);
  const t = buildThemeTimeline("引っ越し", without);
  assert.ok(t.points.every((p) => p.memoryId !== moveDone.id));
  assert.notEqual(t.state.basisMemoryId, moveDone.id);
  assert.equal(JSON.stringify(userC.find((m) => m.id === moveDone.id)), JSON.stringify(byId(FICTIONAL_USERS[2].memories(), moveDone.id)), "Memories are not modified");
});

test("model text: status / retrospective / state basis are marked by the same code rules", () => {
  const text = renderClustersForModel(clusters);
  assert.ok(text.includes("記録の言葉では「保留」 / このテーマの今の状態の根拠"), text);
  const b = renderClustersForModel(buildSynthesisClusters(userB));
  assert.ok(b.includes("出来事の時期 2019 / 以前の出来事を後から話したもの"));
  assert.ok(!/出来事の時期 2019[^）]*今の状態の根拠/.test(b));
  assert.ok(renderClustersForModel(clusters).includes("「一人の時間」（今の状態は記録から判断できない）"));
});

test("validate: evidence, kinds, situation and interpretation rules (unchanged)", () => {
  const a = alone.evidence.map((e) => e.id);
  const runOnly = running.evidence.map((e) => e.id).filter((id) => !a.includes(id));
  const r = validateSynthesisItems({ items: [
    { kind: "change", statement: "以前は辞めるつもりはないと話していたが、最近は異動が保留になったと話している。", support: "derived", evidenceIds: [ids[0], ids[ids.length - 1], "invented-id"] },
    { kind: "change", statement: "一つだけの根拠", support: "hypothesis", evidenceIds: [ids[0]] },
    { kind: "pattern", statement: "テーマをまたいだ根拠", support: "hypothesis", evidenceIds: [a[0], runOnly[0], runOnly[1]] },
    { kind: "tension", statement: "状況の違いが書かれていない", support: "derived", evidenceIds: [a[0], a[1]] },
    { kind: "pattern", statement: "気持ちを整えるための手段として走っている。", support: "derived", evidenceIds: runOnly.slice(0, 3) },
    { kind: "pattern", statement: "もやもやした日に走ったと話しており、気持ちを整える手段になっているのかもしれない。", support: "derived", evidenceIds: runOnly.slice(0, 3) },
  ] }, clusters);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[1].support, "hypothesis", "a hedged reading on 3 statements is kept as a hypothesis");
  assert.deepEqual(r.dropped, { "too-little-evidence": 1, "mixed-themes": 1, "missing-situation": 1, "unfounded-interpretation": 1 });
});

test("theme terms: '走ろう' finds running; unrelated words find nothing", () => {
  assert.ok(themeTerms("ランニング", memories).includes("走"));
  for (const theme of themes) assert.ok(!themeTerms(theme, memories).some((t) => "今日は天気よくて、洗濯物がよく乾いた".includes(t)), theme);
});

test("selection: related only through the user's words; passed only when retrieval misses the state basis / the latest statement / most of the history", () => {
  assert.deepEqual(selectTimelineForTurn(memories, { userText: "今日は天気よくて、洗濯物がよく乾いた", retrievedMemoryIds: [ids[0], ids[2]] }), []);
  const move = selectTimelineForTurn(userC, { userText: "引っ越してから、通勤が前より楽になった気がする", retrievedMemoryIds: userC.filter((m) => m.summary.includes("引っ越しが終わり") || m.summary.includes("考え始め")).map((m) => m.id) });
  assert.equal(move[0].theme, "引っ越し");
  assert.equal(move[0].state.status, "実施済み");
  assert.deepEqual(move[0].items, [], "no Synthesis in the timeline selection by default");
  const all = (theme: string, list: MemoryObject[]) => list.filter((m) => (m.keywords ?? []).includes(theme)).map((m) => m.id);
  assert.ok(!selectTimelineForTurn(memories, { userText: "仕事のこと", retrievedMemoryIds: all("仕事", memories) }).some((c) => c.theme === "仕事"), "retrieval already shows it");
  const workB = selectTimelineForTurn(userB, { userText: "職場の人に、そろそろ管理職どう？って聞かれてさ", retrievedMemoryIds: [] });
  assert.equal(workB[0].state.status, "実施済み");
});

test("the chat screen's timeline call never throws: a broken record yields no timeline (the conversation continues with retrieval only)", () => {
  const broken = Object.defineProperty({ id: "x" }, "metadata", { get() { throw new Error("broken record"); } }) as unknown as MemoryObject;
  const original = console.error; console.error = () => {};
  try { assert.deepEqual(safeSelectTimelineForTurn([...memories, broken], { userText: "仕事のこと", retrievedMemoryIds: [] }), []); }
  finally { console.error = original; }
});

test("with Synthesis (experimental): items only on selected themes; deleted evidence removes them", () => {
  const items = validateSynthesisItems({ items: [{ kind: "change", statement: "以前は辞めるつもりはないと話していたが、最近は異動が保留になったと話している。", support: "derived", evidenceIds: [ids[0], ids[ids.length - 1]] }] }, clusters).items;
  assert.equal(selectTimelineForTurn(memories, { userText: "仕事のことで考えちゃって", retrievedMemoryIds: [ids[0]] }, items)[0].items.length, 1);
  assert.equal(dropItemsWithMissingEvidence(items, new Set(memories.filter((m) => m.id !== ids[ids.length - 1]).map((m) => m.id))).length, 0);
});

test("chat section: empty without themes; state, latest statement and history are separate; '不明' is shown as such; a state without its basis point is refused", () => {
  assert.equal(buildSynthesisSection([]), "");
  assert.deepEqual(sanitizeSynthesisContext("x"), []);
  const move = selectTimelineForTurn(userC, { userText: "引っ越してから通勤が楽", retrievedMemoryIds: [] });
  const section = buildSynthesisSection(sanitizeSynthesisContext(JSON.parse(JSON.stringify(move))));
  assert.ok(section.includes("今の状態（記録の言葉から）: 実施済み（根拠: 2026-08-01に話した「引っ越しが終わり"), section);
  assert.ok(section.includes("最後に話した記録") && section.includes("パン屋"));
  assert.ok(section.includes("引っ越しの後にパン屋の話をしても、引っ越しが済んだことは変わらない"));
  assert.ok(!section.includes("Tsumugiの整理"));
  const unknown = buildSynthesisSection(sanitizeSynthesisContext(JSON.parse(JSON.stringify(selectTimelineForTurn(memories, { userText: "一人でいたい気分", retrievedMemoryIds: [] })))));
  assert.ok(unknown.includes("今の状態: 不明（記録から判断できない。推測で決めない）"), unknown);
  const forged = sanitizeSynthesisContext([{ theme: "車", state: { status: "実施済み" }, timeline: [{ memoryId: "m", statedAt: "2026-09-19", summary: "部品待ち", stateBasis: false }], items: [] }]);
  assert.equal(forged[0].state.status, "不明", "a state is accepted only with the timeline point it comes from");
});
