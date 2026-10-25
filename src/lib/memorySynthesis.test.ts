import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSynthesisClusters, buildSynthesisSection, buildThemeTimeline, dropItemsWithMissingEvidence, renderClustersForModel, sanitizeSynthesisContext,
  selectTimelineForTurn, statusOf, themeTerms, validateSynthesisItems, SYNTHESIS_LIMITS,
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

test("clusters: only themes the user came back to in 3+ conversations over 2+ weeks; one-off topics and Tsumugi's own reflections are not sent", () => {
  assert.ok(themes.includes("仕事") && themes.includes("ランニング") && themes.includes("一人の時間"), themes.join(","));
  assert.ok(!themes.includes("料理") && !themes.includes("映画"), themes.join(","));
  assert.ok(clusters.length <= SYNTHESIS_LIMITS.maxClusters);
  for (const c of clusters) assert.ok(new Set(c.evidence.map((e) => e.conversationId)).size >= SYNTHESIS_LIMITS.minConversations);
  assert.ok(new Set(clusters.flatMap((c) => c.evidence.map((e) => e.id))).size < memories.length, "not every Memory is sent");
  const withReflection = [...memories, { ...memories[0], id: "refl-1", conversationId: "syn-conv-99", metadata: { ...memories[0].metadata, source: "system-generated" } } as MemoryObject];
  assert.ok(!buildSynthesisClusters(withReflection).some((c) => c.evidence.some((e) => e.id === "refl-1")));
});

test("model text: said-date / event-date / status word / retrospective / current state are all marked by code", () => {
  const text = renderClustersForModel(clusters);
  assert.ok(text.includes("発言日 2026-") && text.includes("出来事の時期 2026-10-03"));
  assert.ok(text.includes(`id=${ids[ids.length - 1]}（発言日 2026-10-10 / 記録の言葉では「保留」 / このテーマの今の状態）`), text);
  const b = renderClustersForModel(buildSynthesisClusters(userB));
  assert.ok(b.includes("出来事の時期 2019 / 以前の出来事を後から話したもの"), "an old setback told in October is marked as such");
  assert.ok(!/出来事の時期 2019[^）]*このテーマの今の状態/.test(b), "and it is not the current state");
});

test("status words come from the record's own wording (no interpretation)", () => {
  assert.equal(statusOf("異動の話はいったん保留になったが、勉強は続けたいと話した。"), "保留");
  assert.equal(statusOf("台風で家族の沖縄旅行が中止になったと話した。"), "中止");
  assert.equal(statusOf("10kmの大会に申し込んだと話した。"), "予定");
  assert.equal(statusOf("車の修理が終わって戻ってきたと話した。"), "実施済み");
  assert.equal(statusOf("職場に近い部屋への引っ越しを考え始めたと話した。"), "検討中");
  assert.equal(statusOf("古いSF映画を観て面白かったと話した。"), undefined);
});

test("timeline: chronological, said/event dates apart, the current state is the latest non-retrospective point", () => {
  const tl = buildThemeTimeline("仕事", memories);
  assert.ok(tl.length <= SYNTHESIS_LIMITS.maxTimelinePoints);
  assert.equal(tl.filter((p) => p.current).length, 1);
  assert.ok(tl.find((p) => p.current)!.summary.includes("保留"));
  const bWork = buildThemeTimeline("仕事", userB);
  const cur = bWork.find((p) => p.current)!;
  assert.ok(cur.summary.includes("時短勤務になった"), cur.summary);
  const retro = bWork.find((p) => p.retrospective)!;
  assert.ok(retro && retro.summary.includes("新卒") && retro.eventTime === "2019" && !retro.current);
  assert.equal(bWork[0], retro, "a past event told later is placed at its event date (oldest)");
  const trip = buildThemeTimeline(buildSynthesisClusters(userB).find((c) => c.theme === "旅行" || c.theme === "沖縄")!.theme, userB);
  assert.ok(trip.find((p) => p.current)!.summary.includes("来年の春"), "the rebooked plan is the present state, not the cancelled summer trip");
  assert.ok(trip.some((p) => p.status === "中止") && trip.some((p) => p.status === "予定"));
  const car = buildThemeTimeline("車", userC);
  assert.ok(car.find((p) => p.current)!.summary.includes("戻ってきた"));
  assert.equal(car.find((p) => p.current)!.status, "実施済み");
});

test("validate: invented ids, too little evidence, mixed themes, missing situation and unfounded interpretation are dropped and counted", () => {
  const a = alone.evidence.map((e) => e.id);
  const runOnly = running.evidence.map((e) => e.id).filter((id) => !a.includes(id));
  const r = validateSynthesisItems({ items: [
    { kind: "change", statement: "以前は辞めるつもりはないと話していたが、最近は異動が保留になったと話している。", support: "derived", evidenceIds: [ids[0], ids[ids.length - 1], "invented-id"] },
    { kind: "change", statement: "一つだけの根拠", support: "hypothesis", evidenceIds: [ids[0]] },
    { kind: "pattern", statement: "存在しないidだけ", support: "stated", evidenceIds: ["x", "y", "z"] },
    { kind: "pattern", statement: "テーマをまたいだ根拠", support: "hypothesis", evidenceIds: [a[0], runOnly[0], runOnly[1]] },
    { kind: "tension", statement: "状況の違いが書かれていない", support: "derived", evidenceIds: [a[0], a[1]] },
    { kind: "pattern", statement: "気持ちを整えるための手段として走っている。", support: "derived", evidenceIds: runOnly.slice(0, 3) },
    { kind: "diagnosis", statement: "不正な種類", support: "stated", evidenceIds: ids },
  ] }, clusters);
  assert.equal(r.proposed, 7);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].evidenceIds, [ids[0], ids[ids.length - 1]]);
  assert.deepEqual(r.dropped, { "too-little-evidence": 1, "unknown-evidence": 1, "mixed-themes": 1, "missing-situation": 1, "unfounded-interpretation": 1, malformed: 1 });
});

test("validate: a reading of motive / purpose is accepted only as a hedged hypothesis on 2+ statements, and is labelled hypothesis", () => {
  const runOnly = running.evidence.map((e) => e.id).filter((id) => !alone.evidence.some((e) => e.id === id));
  const r = validateSynthesisItems({ items: [
    { kind: "pattern", statement: "仕事でもやもやした日や面談の前に走ったと話しており、走ることが気持ちを整える手段になっているのかもしれない。", support: "derived", evidenceIds: runOnly.slice(0, 3) },
    { kind: "pattern", statement: "走ることが気持ちを整える手段になっているのかもしれない。", support: "hypothesis", evidenceIds: [runOnly[0]] },
  ] }, clusters);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].support, "hypothesis");
  assert.equal(r.dropped["too-little-evidence"] ?? 0, 1, "a pattern on one statement is dropped before the reading is even considered");
});

test("validate: a tension is never 'stated'; shared evidence works for either theme; no output vs everything rejected differ", () => {
  const shared = running.evidence.find((e) => ids.includes(e.id))!;
  const other = ids.find((id) => !running.evidence.some((e) => e.id === id))!;
  const a = alone.evidence.map((e) => e.id);
  const r = validateSynthesisItems({ items: [
    { kind: "change", statement: "仕事の変化", support: "derived", evidenceIds: [other, shared.id] },
    { kind: "tension", statement: "一人でいたいと話した時と、誰かと食べたいと話した時がある。", support: "stated", evidenceIds: [a[0], a[a.length - 1]], situationNote: "人に会いすぎた週の後と、一人暮らしの夜" },
  ] }, clusters);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[1].support, "derived");
  assert.deepEqual(validateSynthesisItems({ items: [] }, clusters), { items: [], proposed: 0, dropped: {} });
  assert.equal(validateSynthesisItems({ items: [{ kind: "change", statement: "x", support: "stated", evidenceIds: ["nope"] }] }, clusters).proposed, 1);
});

test("theme terms: '走ろう' finds running through the user's own words; unrelated words find nothing", () => {
  assert.ok(themeTerms("ランニング", memories).includes("走"));
  assert.ok(themeTerms("一人の時間", memories).includes("一人"));
  for (const theme of themes) assert.ok(!themeTerms(theme, memories).some((t) => "今日は天気よくて、洗濯物がよく乾いた".includes(t)), theme);
});

test("timeline selection does not need Synthesis; it is passed only when related AND retrieval does not already show the history", () => {
  assert.deepEqual(selectTimelineForTurn(memories, { userText: "今日は天気よくて、洗濯物がよく乾いた", retrievedMemoryIds: [ids[0]] }), []);
  const run = selectTimelineForTurn(memories, { userText: "週末走ろうかと思ってたけど、なんか気が乗らない", retrievedMemoryIds: [] });
  assert.deepEqual(run.map((c) => c.theme), ["ランニング"]);
  assert.deepEqual(run[0].items, [], "no Synthesis given: facts only");
  const car = selectTimelineForTurn(userC, { userText: "週末、久しぶりに車でドライブでも行こうかな", retrievedMemoryIds: [] });
  assert.ok(car[0].timeline.find((p) => p.current)!.summary.includes("戻ってきた"), "Synthesis-free timeline gives the current state of the car");
  const allWork = memories.filter((m) => (m.keywords ?? []).includes("仕事")).map((m) => m.id);
  assert.ok(!selectTimelineForTurn(memories, { userText: "仕事のこと", retrievedMemoryIds: allWork }).some((c) => c.theme === "仕事"), "retrieval already shows it");
});

const items = validateSynthesisItems({ items: [
  { kind: "change", statement: "以前は辞めるつもりはないと話していたが、最近は異動が保留になったと話している。", support: "derived", evidenceIds: [ids[0], ids[ids.length - 1]] },
  { kind: "pattern", statement: "もやもやした日や面談の前に走ったと話している。", support: "stated", evidenceIds: running.evidence.slice(0, 4).map((e) => e.id) },
] }, clusters).items;

test("with Synthesis: items attach only to themes the timeline rule selected; deleted evidence removes items and timeline points; Memories untouched", () => {
  const before = JSON.stringify(memories);
  const workTurn = selectTimelineForTurn(memories, { userText: "仕事のことで考えちゃって", retrievedMemoryIds: [ids[0]] }, items);
  assert.equal(workTurn[0].theme, "仕事");
  assert.equal(workTurn[0].items.length, 1);
  assert.equal(selectTimelineForTurn(memories, { userText: "今日は天気がいい", retrievedMemoryIds: [] }, items).length, 0);
  const withoutLatest = memories.filter((m) => m.id !== ids[ids.length - 1]);
  assert.equal(dropItemsWithMissingEvidence(items, new Set(withoutLatest.map((m) => m.id))).length, 1);
  const after = selectTimelineForTurn(withoutLatest, { userText: "仕事のこと", retrievedMemoryIds: [] }, items);
  assert.ok(after.every((c) => c.items.every((i) => !i.evidenceIds.includes(ids[ids.length - 1]))));
  assert.ok(after.every((c) => c.timeline.every((p) => !p.summary.includes("保留"))));
  assert.equal(JSON.stringify(memories), before);
});

test("chat section: empty without themes; facts (code) and understanding (Synthesis) are separate; current/retrospective/status are shown", () => {
  assert.equal(buildSynthesisSection([]), "");
  assert.deepEqual(sanitizeSynthesisContext("x"), []);
  const factsOnly = buildSynthesisSection(sanitizeSynthesisContext(JSON.parse(JSON.stringify(selectTimelineForTurn(userB, { userText: "そろそろ管理職どう？って聞かれた", retrievedMemoryIds: [] })))));
  assert.ok(factsOnly.includes("【今の状態（このテーマで最新）】") && factsOnly.includes("以前の出来事を後から話したもの・今の状態ではない"));
  assert.ok(!factsOnly.includes("Tsumugiの整理"), "no Synthesis -> no understanding block");
  assert.ok(factsOnly.includes("予定・検討中・保留・中止・実施済みを混同しない"));
  const withItems = buildSynthesisSection(sanitizeSynthesisContext(JSON.parse(JSON.stringify(selectTimelineForTurn(memories, { userText: "仕事のこと", retrievedMemoryIds: [] }, items)))));
  assert.ok(withItems.includes("Tsumugiの整理") && withItems.includes("記録の言葉では「保留」"));
  const forced = sanitizeSynthesisContext([{ theme: "x", timeline: [], items: [{ kind: "tension", statement: "s", support: "stated", evidenceIds: ["a"], firstStatedAt: "2026-01-01", lastStatedAt: "2026-02-01" }] }]);
  assert.equal(forced[0].items[0].support, "derived");
});
