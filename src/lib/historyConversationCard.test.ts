/**
 * Conversation History（STEP 3）のConversation card表示ロジック
 * （title fallback・Reflection複数時の決定ルール）の回帰テスト。
 * DOM/Reactに依存しない純粋関数の単体テスト。
 * 実行方法：`npm run test:history-conversation-card`
 * （`tsc -p tsconfig.history-conversation-card.json && node --test .test-out/lib/historyConversationCard.test.js`）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildReflectionMap, fallbackConversationTitle, resolvePrimaryReflection, selectConversationReflection, type ReflectionPrimaryReaders } from "./historyConversationCard";
import type { Conversation, MemoryObject } from "./types";

const T0 = "2026-09-25T10:00:00.000Z";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "CONV-1",
    persona: "companion",
    startedAt: T0,
    status: "active",
    turns: [],
    memoryObjectIds: [],
    createdAt: T0,
    updatedAt: T0,
    metadata: { id: "m", schemaVersion: "0.1", source: "user-authored", createdAt: T0, updatedAt: T0 },
    ...overrides,
  };
}

function reflection(overrides: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id: "REF-1",
    date: T0,
    types: ["insight"],
    conversationId: "CONV-1",
    content: "振り返り本文",
    summary: "振り返り本文",
    keywords: [],
    themeIds: [],
    personIds: [],
    emotionIds: [],
    goalIds: [],
    ideaIds: [],
    eventIds: [],
    links: [],
    createdAt: T0,
    updatedAt: T0,
    metadata: { id: "m", schemaVersion: "0.1", source: "system-generated", createdAt: T0, updatedAt: T0 },
    ...overrides,
  };
}

// ===========================================================================
// fallbackConversationTitle（要件4）
// ===========================================================================

test("fallbackConversationTitle: 最初のUser発言を短く表示する", () => {
  const c = conversation({
    turns: [
      { role: "ai", content: "こんにちは", timestamp: T0 },
      { role: "user", content: "今日は子どもの離乳食と買い物について話したい", timestamp: T0 },
    ],
  });
  assert.equal(fallbackConversationTitle(c), "今日は子どもの離乳食と買い物について話したい");
});

test("fallbackConversationTitle: User発言が無い場合は「タイトルなし」", () => {
  const c = conversation({ turns: [{ role: "ai", content: "こんにちは", timestamp: T0 }] });
  assert.equal(fallbackConversationTitle(c), "タイトルなし");
});

test("fallbackConversationTitle: turnsが空の場合も「タイトルなし」（クラッシュしない）", () => {
  const c = conversation({ turns: [] });
  assert.equal(fallbackConversationTitle(c), "タイトルなし");
});

test("fallbackConversationTitle: 空白だけのUser発言は無視して次のUser発言を使う", () => {
  const c = conversation({
    turns: [
      { role: "user", content: "   ", timestamp: T0 },
      { role: "user", content: "本題はこれ", timestamp: T0 },
    ],
  });
  assert.equal(fallbackConversationTitle(c), "本題はこれ");
});

// ===========================================================================
// buildReflectionMap（要件7：複数Reflection時の決定的選択ルール＝最新を採用）
// ===========================================================================

test("buildReflectionMap: 1件だけの場合はそのままconversationIdへ紐付く", () => {
  const map = buildReflectionMap([reflection()]);
  assert.equal(map.get("CONV-1")?.id, "REF-1");
});

test("buildReflectionMap: 同一conversationIdに複数ある場合は最新（createdAt降順）を採用する", () => {
  const older = reflection({ id: "REF-OLD", createdAt: "2026-09-20T10:00:00.000Z", content: "古い振り返り", summary: "古い振り返り" });
  const newer = reflection({ id: "REF-NEW", createdAt: "2026-09-25T10:00:00.000Z", content: "新しい振り返り", summary: "新しい振り返り" });
  const map = buildReflectionMap([older, newer]);
  assert.equal(map.size, 1, "削除・統合はしないが、1 conversationIdにつき採用するのは1件だけ");
  assert.equal(map.get("CONV-1")?.id, "REF-NEW");
});

test("buildReflectionMap: conversationIdが無いReflectionは無視する（クラッシュしない）", () => {
  const orphan = reflection({ id: "REF-ORPHAN", conversationId: undefined });
  const map = buildReflectionMap([orphan]);
  assert.equal(map.size, 0);
});

test("buildReflectionMap: 異なるconversationIdはそれぞれ独立して保持される", () => {
  const a = reflection({ id: "REF-A", conversationId: "CONV-A" });
  const b = reflection({ id: "REF-B", conversationId: "CONV-B" });
  const map = buildReflectionMap([a, b]);
  assert.equal(map.get("CONV-A")?.id, "REF-A");
  assert.equal(map.get("CONV-B")?.id, "REF-B");
});

test("buildReflectionMap: 空配列ではクラッシュせず空のMapを返す", () => {
  const map = buildReflectionMap([]);
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// Conversation History v1：primary relation（Conversation.memoryObjectIds → Reflection）
// ---------------------------------------------------------------------------
const normalMemory = (id: string): MemoryObject => ({ ...reflection({ id, conversationId: "CONV-1" }), types: ["event"], metadata: { ...reflection().metadata, source: "ai-capture" } });
const asReflection = (over: Partial<MemoryObject> = {}): MemoryObject => ({ ...reflection(over), metadata: { ...reflection().metadata, source: "system-generated" } });
/** Fake Vault: `registry` = ids that have a Registry entry; `store` = what readById returns. Records every call. */
function readers(registry: string[], store: MemoryObject[]) {
  const calls = { has: [] as string[], read: [] as string[] };
  const r: ReflectionPrimaryReaders = {
    async hasRegistryEntry(id) { calls.has.push(id); return registry.includes(id); },
    async readById(id) { calls.read.push(id); return store.find((m) => m.id === id) ?? null; },
  };
  return { r, calls };
}

test("A: memoryObjectIds holds the Reflection id -> the primary path returns that Reflection", async () => {
  const ref = asReflection({ id: "REF-A", keywords: ["a", "b"] });
  const { r } = readers(["REF-A"], [ref]);
  const found = await resolvePrimaryReflection(conversation({ memoryObjectIds: ["REF-A"] }), r);
  assert.equal(found?.id, "REF-A");
});
test("B: normal Memory ids and the Reflection id are mixed -> only the Reflection is selected (isReflectionSummary is always checked)", async () => {
  const ref = asReflection({ id: "REF-B" });
  // The normal Memory even has a Registry entry and is readable: it must still not be treated as a Reflection.
  const { r, calls } = readers(["MEM-1", "REF-B", "MEM-2"], [normalMemory("MEM-1"), ref, normalMemory("MEM-2")]);
  const found = await resolvePrimaryReflection(conversation({ memoryObjectIds: ["MEM-1", "MEM-2", "REF-B"] }), r);
  assert.equal(found?.id, "REF-B");
  assert.ok(calls.read.includes("MEM-1"), "the normal Memory was inspected and rejected, not trusted");
  const onlyNormal = await resolvePrimaryReflection(conversation({ memoryObjectIds: ["MEM-1"] }), readers(["MEM-1"], [normalMemory("MEM-1")]).r);
  assert.equal(onlyNormal, null, "a normal Memory is never returned as the Reflection");
});
test("C: no Reflection id -> primary is null and the existing conversationId fallback supplies the Reflection", async () => {
  const conv = conversation({ memoryObjectIds: ["MEM-1"] });
  const primary = await resolvePrimaryReflection(conv, readers([], []).r);
  assert.equal(primary, null);
  const byConversationId = buildReflectionMap([asReflection({ id: "REF-C", conversationId: "CONV-1" })]).get("CONV-1");
  assert.equal(selectConversationReflection(conv, primary, byConversationId)?.id, "REF-C");
  assert.equal(selectConversationReflection(conversation({ memoryObjectIds: [] }), undefined, byConversationId)?.id, "REF-C", "legacy conversation without ids uses the fallback immediately");
});
test("D: the primary Registry entry is missing -> nothing is read with a guessed date; the fallback is used", async () => {
  const ref = asReflection({ id: "REF-D" });
  const { r, calls } = readers([], [ref]); // the file exists, but there is no Registry entry
  const conv = conversation({ memoryObjectIds: ["REF-D"] });
  const primary = await resolvePrimaryReflection(conv, r);
  assert.equal(primary, null); assert.deepEqual(calls.read, [], "no read was attempted (a date hint would have had to be guessed from the Conversation)");
  const fallback = buildReflectionMap([asReflection({ id: "REF-D", conversationId: "CONV-1" })]).get("CONV-1");
  assert.equal(selectConversationReflection(conv, primary, fallback)?.id, "REF-D");
  // The panel calls readReflectionById with no date at all (the Registry entry makes it unnecessary).
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  assert.ok(panel.includes('readReflectionById(handle, id, "")') && !/readReflectionById\([^)]*startedAt/.test(panel), "Conversation.startedAt is never used as the Reflection date");
});
test("E: Conversation and Reflection on different logical days -> the primary path needs neither day; the fallback still works for same-day data", async () => {
  const ref = asReflection({ id: "REF-E", createdAt: "2026-09-27T01:00:00.000Z", date: "2026-09-27T01:00:00.000Z" });
  const conv = conversation({ startedAt: "2026-09-25T10:00:00.000Z", memoryObjectIds: ["REF-E"] });
  const { r, calls } = readers(["REF-E"], [ref]);
  assert.equal((await resolvePrimaryReflection(conv, r))?.id, "REF-E");
  assert.deepEqual(calls.has, ["REF-E"], "only the id is used");
});
test("primary resolution: while it is pending a conversation with ids does not flash the fallback; a read failure does not break the other candidates", async () => {
  const conv = conversation({ memoryObjectIds: ["X"] });
  const fb = asReflection({ id: "FB" });
  assert.equal(selectConversationReflection(conv, undefined, fb), undefined, "pending");
  assert.equal(selectConversationReflection(conv, null, fb)?.id, "FB", "unresolved -> fallback");
  assert.equal(selectConversationReflection(conv, asReflection({ id: "P" }), fb)?.id, "P", "primary wins over the fallback");
  const flaky: ReflectionPrimaryReaders = { async hasRegistryEntry(id) { if (id === "BAD") throw new Error("io"); return true; }, async readById(id) { return id === "OK" ? asReflection({ id: "OK" }) : null; } };
  assert.equal((await resolvePrimaryReflection(conversation({ memoryObjectIds: ["BAD", "OK"] }), flaky))?.id, "OK");
});
test("F/G: a plain conversation shows title only; a diary with a Reflection shows title + body + keywords (display logic)", () => {
  const plain = conversation({ title: "会話のタイトル", memoryObjectIds: [] });
  assert.equal(selectConversationReflection(plain, undefined, undefined), undefined, "no Reflection -> nothing to show");
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  const detailStart = panel.indexOf("selectedConversationReflection && (");
  const detail = panel.slice(detailStart, panel.indexOf("会話全文を見る", detailStart));
  assert.ok(detail.includes("selectedConversationReflection.content") && detail.includes("selectedConversationReflection.keywords.length > 0") && detail.includes("キーワード"), "body then keywords, both only inside the Reflection block");
  assert.ok(detail.indexOf(".content") < detail.indexOf(".keywords"), "order: body, keywords");
  const header = panel.slice(panel.lastIndexOf("selectedConversationTitle}", detailStart) - 200, detailStart);
  assert.ok(header.includes("selectedConversationTitle"), "title comes before the Reflection");
});
test("H/J: the list has no Reflection preview and Reflection is not a separate History item", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  const card = panel.slice(panel.indexOf("function ConversationCard("), panel.indexOf("function ConversationCard(") + 2500);
  assert.ok(!/reflection/i.test(card.replace(/\/\*[\s\S]*?\*\//g, "")), "ConversationCard has no Reflection prop, preview or markup");
  assert.ok(!panel.includes("reflection={reflectionByConversationId.get(row.id)}"));
  assert.ok(panel.includes('memoryRows.filter((row) => row.origin !== "reflection")'), "Reflection rows are still excluded from the memory list");
});
test("I: 会話全文を見る keeps working (the raw conversation view is untouched)", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  assert.ok(panel.includes("onClick={() => setRawConversationView(true)}") && panel.includes("会話全文を見る"));
  const raw = panel.slice(panel.indexOf("selectedConversation && rawConversationView"));
  assert.ok(raw.includes("HistoryTurnBubble") && raw.includes("selectedConversation.turns.map"), "the raw view still renders every turn");
});
test("Scope: the change stays in History display; no save / Recovery / generation code is touched", () => {
  const src = fs.readFileSync("src/lib/historyConversationCard.ts", "utf8");
  assert.ok(!/putConversation|putMemoryObject|persistCapture|writeMemoryObjectMarkdown|createInsightMemoryObject|\.put\(/.test(src), "read-only, pure logic");
});
