import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSynthesisClusters, buildSynthesisSection, buildThemeTimeline, dropItemsWithMissingEvidence, renderClustersForModel, sanitizeSynthesisContext,
  selectSynthesisForTurn, themeTerms, validateSynthesisItems, SYNTHESIS_LIMITS,
} from "./memorySynthesis";
import { fictionalSynthesisMemories } from "./synthesisFictionalData";
import type { MemoryObject } from "./types";

const memories = fictionalSynthesisMemories();
const clusters = buildSynthesisClusters(memories);
const themes = clusters.map((c) => c.theme);
const work = clusters.find((c) => c.theme === "仕事")!;
const ids = work.evidence.map((e) => e.id);
const running = clusters.find((c) => c.theme === "ランニング")!;
const alone = clusters.find((c) => c.theme === "一人の時間")!;

test("clusters: only themes the user came back to in 3+ conversations over 2+ weeks; one-off topics and Tsumugi's own reflections are not sent", () => {
  assert.ok(themes.includes("仕事") && themes.includes("ランニング") && themes.includes("一人の時間"), themes.join(","));
  assert.ok(!themes.includes("料理") && !themes.includes("映画"), themes.join(","));
  assert.ok(clusters.length <= SYNTHESIS_LIMITS.maxClusters);
  for (const c of clusters) {
    assert.ok(new Set(c.evidence.map((e) => e.conversationId)).size >= SYNTHESIS_LIMITS.minConversations);
    const t = c.evidence.map((e) => Date.parse(e.statedAt));
    assert.deepEqual(t, [...t].sort((a, b) => a - b), "evidence is in the order it was said");
  }
  assert.ok(new Set(clusters.flatMap((c) => c.evidence.map((e) => e.id))).size < memories.length, "not every Memory is sent");
  const withReflection = [...memories, { ...memories[0], id: "refl-1", conversationId: "syn-conv-99", metadata: { ...memories[0].metadata, source: "system-generated" } } as MemoryObject];
  assert.ok(!buildSynthesisClusters(withReflection).some((c) => c.evidence.some((e) => e.id === "refl-1")));
});

test("model text: said-date and event-date are kept apart; the latest record of each theme is marked", () => {
  const text = renderClustersForModel(clusters);
  assert.ok(text.includes("発言日 2026-") && text.includes("出来事の時期 2026-10-03"));
  assert.ok(text.includes(`id=${ids[ids.length - 1]}（発言日 2026-10-10 / このテーマで最新）`), "the latest work record (異動は保留) is marked");
  assert.ok(renderClustersForModel(buildSynthesisClusters(memories.map((m) => ({ ...m, statedAt: undefined })))).includes("記録日 "));
});

test("timeline (code facts): chronological, the latest point is marked and is the most recent thing said on the theme", () => {
  const tl = buildThemeTimeline("仕事", memories);
  assert.ok(tl.length <= SYNTHESIS_LIMITS.maxTimelinePoints);
  assert.equal(tl.filter((p) => p.latest).length, 1);
  const last = tl[tl.length - 1];
  assert.ok(last.latest && last.summary.includes("保留"), last.summary);
  const t = tl.map((p) => Date.parse(p.statedAt));
  assert.deepEqual(t, [...t].sort((a, b) => a - b));
  assert.ok(buildThemeTimeline("ランニング", memories).some((p) => p.eventTime === "2026-10-03"), "the event date travels as its own field");
});

test("validate: invented ids removed; too little evidence, mixed themes, missing situation and unfounded interpretation are dropped and counted", () => {
  const a = alone.evidence.map((e) => e.id);
  const runOnly = running.evidence.map((e) => e.id).filter((id) => !a.includes(id));
  const r = validateSynthesisItems({ items: [
    { kind: "change", statement: "以前は辞めるつもりはないと話していたが、最近は異動が保留になったと話している。", support: "derived", evidenceIds: [ids[0], ids[ids.length - 1], "invented-id"] },
    { kind: "change", statement: "一つだけの根拠", support: "hypothesis", evidenceIds: [ids[0]] },
    { kind: "pattern", statement: "存在しないidだけ", support: "stated", evidenceIds: ["x", "y", "z"] },
    { kind: "pattern", statement: "テーマをまたいだ根拠", support: "hypothesis", evidenceIds: [a[0], runOnly[0], runOnly[1]] },
    { kind: "tension", statement: "状況の違いが書かれていない", support: "derived", evidenceIds: [a[0], a[1]] },
    { kind: "pattern", statement: "気持ちを整えるための手段として走っている。", support: "hypothesis", evidenceIds: runOnly.slice(0, 3) },
    { kind: "diagnosis", statement: "不正な種類", support: "stated", evidenceIds: ids },
  ] }, clusters);
  assert.equal(r.proposed, 7);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].evidenceIds, [ids[0], ids[ids.length - 1]]);
  assert.equal(r.items[0].firstStatedAt, work.evidence[0].statedAt);
  assert.equal(r.items[0].lastStatedAt, work.evidence[work.evidence.length - 1].statedAt);
  assert.deepEqual(r.dropped, { "too-little-evidence": 1, "unknown-evidence": 1, "mixed-themes": 1, "missing-situation": 1, "unfounded-interpretation": 1, malformed: 1 });
});

test("validate: a tension is never 'stated'; shared evidence works for either theme", () => {
  const shared = running.evidence.find((e) => ids.includes(e.id))!;
  const other = ids.find((id) => !running.evidence.some((e) => e.id === id))!;
  const a = alone.evidence.map((e) => e.id);
  const r = validateSynthesisItems({ items: [
    { kind: "change", statement: "仕事の変化", support: "derived", evidenceIds: [other, shared.id] },
    { kind: "tension", statement: "一人でいたいと話した時と、誰かと食べたいと話した時がある。", support: "stated", evidenceIds: [a[0], a[a.length - 1]], situationNote: "人に会いすぎた週の後と、一人暮らしの夜" },
  ] }, clusters);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[1].support, "derived");
});

test("no output vs everything rejected are different results", () => {
  assert.deepEqual(validateSynthesisItems({ items: [] }, clusters), { items: [], proposed: 0, dropped: {} });
  const rejected = validateSynthesisItems({ items: [{ kind: "change", statement: "x", support: "stated", evidenceIds: ["nope"] }] }, clusters);
  assert.equal(rejected.items.length, 0);
  assert.equal(rejected.proposed, 1);
});

test("theme terms: '走ろう' finds the running theme through the user's own words; unrelated words find nothing", () => {
  assert.ok(themeTerms("ランニング", memories).includes("走"), themeTerms("ランニング", memories).join(","));
  assert.ok(themeTerms("一人の時間", memories).includes("一人"));
  for (const theme of themes) assert.ok(!themeTerms(theme, memories).some((t) => "今日は天気よくて、洗濯物がよく乾いた".includes(t)), theme);
});

const items = validateSynthesisItems({ items: [
  { kind: "change", statement: "以前は辞めるつもりはないと話していたが、最近は異動が保留になったと話している。", support: "derived", evidenceIds: [ids[0], ids[ids.length - 1]] },
  { kind: "pattern", statement: "もやもやした日や面談の前に走ったと話している。", support: "stated", evidenceIds: running.evidence.slice(0, 4).map((e) => e.id) },
  { kind: "tension", statement: "一人でいたいと話した時と、誰かと食べたいと話した時がある。", support: "derived", evidenceIds: [alone.evidence[0].id, alone.evidence[alone.evidence.length - 1].id], situationNote: "人に会いすぎた週の後と、一人暮らしの夜" },
] }, clusters).items;

test("turn selection: related AND adds beyond retrieval; unrelated turns get nothing; '走ろう' is found without the word ランニング", () => {
  assert.equal(items.length, 3);
  assert.deepEqual(selectSynthesisForTurn(items, { userText: "今日は天気よくて、洗濯物がよく乾いた", retrievedMemoryIds: [ids[0]] }, memories), []);
  const run = selectSynthesisForTurn(items, { userText: "週末走ろうかと思ってたけど、なんか気が乗らない", retrievedMemoryIds: [] }, memories);
  assert.deepEqual(run.map((c) => c.theme), ["ランニング"]);
  assert.ok(run[0].timeline[run[0].timeline.length - 1].latest);
  const workTurn = selectSynthesisForTurn(items, { userText: "仕事のことで考えちゃって", retrievedMemoryIds: [ids[0]] }, memories);
  assert.equal(workTurn[0].theme, "仕事");
  assert.ok(workTurn[0].timeline.some((p) => p.latest && p.summary.includes("保留")), "the latest state travels with the theme");
  // when retrieval already returned every Memory of the theme, Synthesis adds nothing and is not sent
  const allWork = memories.filter((m) => (m.keywords ?? []).includes("仕事")).map((m) => m.id);
  assert.ok(!selectSynthesisForTurn(items, { userText: "仕事のこと", retrievedMemoryIds: allWork }, memories).some((c) => c.theme === "仕事"));
});

test("deleted evidence takes the whole item with it; source Memories are not modified", () => {
  const before = JSON.stringify(memories);
  assert.equal(dropItemsWithMissingEvidence(items, new Set(memories.map((m) => m.id))).length, 3);
  const withoutLatest = memories.filter((m) => m.id !== ids[ids.length - 1]);
  assert.equal(dropItemsWithMissingEvidence(items, new Set(withoutLatest.map((m) => m.id))).length, 2);
  const workTurn = selectSynthesisForTurn(items, { userText: "仕事のこと", retrievedMemoryIds: [] }, withoutLatest);
  assert.ok(!workTurn.some((c) => c.items.some((i) => i.evidenceIds.includes(ids[ids.length - 1]))));
  assert.ok(!workTurn.some((c) => c.timeline.some((p) => p.summary.includes("保留"))), "a deleted Memory is not in the timeline either");
  assert.equal(JSON.stringify(memories), before);
});

test("chat section: empty without themes (prompt unchanged); facts and understanding are separate; support levels and rules are stated", () => {
  assert.equal(buildSynthesisSection([]), "");
  assert.deepEqual(sanitizeSynthesisContext("x"), []);
  const ctx = selectSynthesisForTurn(items, { userText: "仕事のこと", retrievedMemoryIds: [] }, memories);
  const section = buildSynthesisSection(sanitizeSynthesisContext(JSON.parse(JSON.stringify(ctx))));
  assert.ok(section.includes("記録された経緯（日付はシステムが記録から確定したもの"));
  assert.ok(section.includes("2026-10-10に話した【このテーマで最新】"));
  assert.ok(section.includes("Tsumugiの整理") && section.includes("複数の発言を並べると見えること"));
  assert.ok(section.includes("改めて尋ねない") && section.includes("毎回持ち出さない") && section.includes("話した日付は出来事の日付ではない"));
  const forced = sanitizeSynthesisContext([{ theme: "x", timeline: [], items: [{ kind: "tension", statement: "s", support: "stated", evidenceIds: ["a"], firstStatedAt: "2026-01-01", lastStatedAt: "2026-02-01" }] }]);
  assert.equal(forced[0].items[0].support, "derived");
});
