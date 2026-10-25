import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSynthesisClusters, buildSynthesisSection, dropItemsWithMissingEvidence, renderClustersForModel, sanitizeSynthesisContext,
  selectSynthesisForTurn, validateSynthesisItems, withAnchors, SYNTHESIS_LIMITS,
} from "./memorySynthesis";
import { fictionalSynthesisMemories } from "./synthesisFictionalData";
import type { MemoryObject } from "./types";

const memories = fictionalSynthesisMemories();
const clusters = buildSynthesisClusters(memories);
const themes = clusters.map((c) => c.theme);

test("clusters: only themes the user came back to in 3+ conversations over 2+ weeks; one-off topics are not sent", () => {
  assert.ok(themes.includes("仕事") && themes.includes("ランニング"), themes.join(","));
  assert.ok(!themes.includes("料理") && !themes.includes("映画"), themes.join(","));
  assert.ok(clusters.length <= SYNTHESIS_LIMITS.maxClusters);
  for (const c of clusters) {
    assert.ok(new Set(c.evidence.map((e) => e.conversationId)).size >= SYNTHESIS_LIMITS.minConversations);
    assert.ok(c.evidence.length <= SYNTHESIS_LIMITS.maxEvidencePerCluster);
    const t = c.evidence.map((e) => Date.parse(e.statedAt));
    assert.deepEqual(t, [...t].sort((a, b) => a - b), "evidence is in the order it was said");
  }
  const sent = new Set(clusters.flatMap((c) => c.evidence.map((e) => e.id)));
  assert.ok(sent.size < memories.length, "not every Memory is sent to the model");
});

test("clusters: Tsumugi's own reflections / insights are never evidence", () => {
  const withReflection = [...memories, { ...memories[0], id: "refl-1", conversationId: "syn-conv-99", metadata: { ...memories[0].metadata, source: "system-generated" } } as MemoryObject];
  assert.ok(!buildSynthesisClusters(withReflection).some((c) => c.evidence.some((e) => e.id === "refl-1")));
});

test("model text: said-date and event-date are kept apart; a record date is labelled as such", () => {
  const text = renderClustersForModel(clusters);
  assert.ok(text.includes("発言日 2026-"));
  assert.ok(text.includes("出来事の時期 2026-10-03"), "the event time is passed as its own field");
  const noStated = buildSynthesisClusters(memories.map((m) => ({ ...m, statedAt: undefined })));
  assert.ok(renderClustersForModel(noStated).includes("記録日 "));
});

const work = clusters.find((c) => c.theme === "仕事")!;
const ids = work.evidence.map((e) => e.id);

test("validate: invented ids are removed, items without enough evidence are dropped, dates come from the evidence", () => {
  const items = validateSynthesisItems({ items: [
    { kind: "change", statement: "以前は辞めるつもりはないと話していたが、最近はデザインの方向へ動いている。", basis: "explicit", evidenceIds: [ids[0], ids[ids.length - 1], "invented-id"] },
    { kind: "change", statement: "一つだけの根拠", basis: "hypothesis", evidenceIds: [ids[0]] },
    { kind: "pattern", statement: "2件だけでは繰り返しとは言えない", basis: "hypothesis", evidenceIds: [ids[0], ids[1]] },
    { kind: "pattern", statement: "存在しないidだけ", basis: "explicit", evidenceIds: ["x", "y", "z"] },
    { kind: "diagnosis", statement: "不正な種類", basis: "explicit", evidenceIds: ids },
  ] }, clusters);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].evidenceIds, [ids[0], ids[ids.length - 1]]);
  assert.equal(items[0].firstStatedAt, work.evidence[0].statedAt);
  assert.equal(items[0].lastStatedAt, work.evidence[work.evidence.length - 1].statedAt);
});

test("validate: a tension needs a situation note and is always a hypothesis; mixing evidence of two themes is rejected", () => {
  const alone = clusters.find((c) => c.theme === "一人の時間")!;
  const a = alone.evidence.map((e) => e.id);
  const run = clusters.find((c) => c.theme === "ランニング")!.evidence.map((e) => e.id);
  const items = validateSynthesisItems({ items: [
    { kind: "tension", statement: "一人でいたい時期と、誰かといたい時期がある。", basis: "explicit", evidenceIds: [a[0], a[1]], situationNote: "忙しい週の後と、一人暮らしの夜とで状況が違う" },
    { kind: "tension", statement: "状況の違いが書かれていない", basis: "hypothesis", evidenceIds: [a[0], a[1]] },
    { kind: "pattern", statement: "テーマをまたいだ根拠", basis: "hypothesis", evidenceIds: [a[0], run[0], run[1]] },
  ] }, clusters);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tension");
  assert.equal(items[0].basis, "hypothesis");
});

test("validate: a Memory that is evidence in two themes may be used in either", () => {
  const shared = clusters.find((c) => c.theme === "ランニング")!.evidence.find((e) => ids.includes(e.id))!;
  const other = ids.find((id) => id !== shared.id && !clusters.find((c) => c.theme === "ランニング")!.evidence.some((e) => e.id === id))!;
  assert.equal(validateSynthesisItems({ items: [{ kind: "change", statement: "仕事の変化", basis: "hypothesis", evidenceIds: [other, shared.id] }] }, clusters).length, 1);
});

test("deleted evidence takes the whole item with it; source Memories are not modified", () => {
  const before = JSON.stringify(memories);
  const items = validateSynthesisItems({ items: [{ kind: "change", statement: "変化", basis: "hypothesis", evidenceIds: [ids[0], ids[2]] }] }, clusters);
  assert.equal(dropItemsWithMissingEvidence(items, new Set(memories.map((m) => m.id))).length, 1);
  assert.equal(dropItemsWithMissingEvidence(items, new Set(memories.map((m) => m.id).filter((id) => id !== ids[2]))).length, 0);
  assert.equal(JSON.stringify(memories), before);
});

test("turn selection: only items related to this turn; an unrelated turn gets none; at most 2", () => {
  const items = validateSynthesisItems({ items: [
    { kind: "change", statement: "仕事の変化", basis: "hypothesis", evidenceIds: [ids[0], ids[ids.length - 1]] },
    { kind: "pattern", statement: "仕事の繰り返し", basis: "hypothesis", evidenceIds: ids.slice(0, 3) },
    { kind: "change", statement: "仕事の別の変化", basis: "hypothesis", evidenceIds: [ids[1], ids[3]] },
  ] }, clusters);
  assert.equal(selectSynthesisForTurn(items, { userText: "今日は天気がいい", retrievedMemoryIds: [] }).length, 0);
  assert.equal(selectSynthesisForTurn(items, { userText: "仕事どうしよう", retrievedMemoryIds: [] }).length, 2);
  assert.equal(selectSynthesisForTurn(items, { userText: "ねえ", retrievedMemoryIds: [ids[3]] }).length, 0, "one loosely retrieved Memory is not enough");
  assert.equal(selectSynthesisForTurn(items, { userText: "ねえ", retrievedMemoryIds: [ids[1], ids[3]] })[0].statement, "仕事の別の変化");
});

test("anchors: the earliest / middle / latest evidence with its said-date are added for the chat, and survive the chat sanitizer", () => {
  const items = validateSynthesisItems({ items: [{ kind: "change", statement: "仕事の変化", basis: "hypothesis", evidenceIds: ids }] }, clusters);
  const [anchored] = withAnchors(items, memories);
  assert.equal(anchored.anchors!.length, 3);
  assert.equal(anchored.anchors![0].statedAt, work.evidence[0].statedAt);
  const section = buildSynthesisSection(sanitizeSynthesisContext([anchored]));
  assert.ok(section.includes(`${work.evidence[0].statedAt.slice(0, 10)}に話したこと`));
});

test("anchors: the most recent thing said on the theme is included even if the model did not cite it", () => {
  const items = validateSynthesisItems({ items: [{ kind: "change", statement: "仕事の変化", basis: "hypothesis", evidenceIds: [ids[0], ids[1]] }] }, clusters);
  const [anchored] = withAnchors(items, memories);
  assert.equal(anchored.anchors![anchored.anchors!.length - 1].statedAt, work.evidence[work.evidence.length - 1].statedAt);
});

test("chat section: empty without items (prompt unchanged); hypotheses are labelled; tension basis cannot be forced to explicit", () => {
  assert.equal(buildSynthesisSection([]), "");
  assert.deepEqual(sanitizeSynthesisContext("x"), []);
  const s = sanitizeSynthesisContext([
    { kind: "tension", theme: "一人の時間", statement: "揺れ", basis: "explicit", evidenceIds: ["a", "b"], firstStatedAt: "2026-05-16T00:00:00Z", lastStatedAt: "2026-10-17T00:00:00Z", situationNote: "状況が違う" },
    { kind: "change", theme: "仕事", statement: "変化", basis: "explicit", evidenceIds: ["c", "d"], firstStatedAt: "2026-05-09T00:00:00Z", lastStatedAt: "2026-10-10T00:00:00Z" },
    { kind: "pattern", theme: "x", statement: "3件目は落ちる", basis: "hypothesis", evidenceIds: ["e"], firstStatedAt: "2026-05-09T00:00:00Z", lastStatedAt: "2026-10-10T00:00:00Z" },
  ]);
  assert.equal(s.length, 2);
  assert.equal(s[0].basis, "hypothesis");
  const section = buildSynthesisSection(s);
  assert.ok(section.includes("Tsumugiの仮説") && section.includes("本人が話した内容のまとめ"));
  assert.ok(section.includes("2026-05〜2026-10に話した内容から"));
  assert.ok(section.includes("診断ではない") && section.includes("毎回持ち出さない"));
});
