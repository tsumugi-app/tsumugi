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
import { ulid } from "ulid";
import { buildReflectionMap, conversationHeading, conversationLogicalDay, fallbackConversationTitle, indexEntryHasConversationOnDay, isEffectivelySameText, resolveConversationMemories, resolvePrimaryReflection, selectConversationReflection, type ReflectionPrimaryReaders } from "./historyConversationCard";
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
  assert.ok(!panel.includes("displayedMemoryRows") && !panel.includes("normalMemoryRows"), "no independent memory list is built any more");
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

// ---------------------------------------------------------------------------
// Conversation History v2：Conversation単位の1項目（見出し＝最初のユーザー発言、会話→通常Memory、日記→Reflection）
// ---------------------------------------------------------------------------
const TS = (n: number) => `2026-09-25T10:0${n}:00.000Z`;
const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: T0 });
const aiTurn = (content: string) => ({ role: "ai" as const, content, timestamp: T0 });
const mem = (id: string, over: Partial<MemoryObject> = {}): MemoryObject => ({ ...normalMemory(id), conversationId: "CONV-1", summary: `要約-${id}`, content: `内容-${id}`, keywords: [`k-${id}`], createdAt: TS(Number(id.replace(/\D/g, "")) % 9), ...over });
/** Fake day-file reader; records which days were read. */
const dayReader = (members: MemoryObject[]) => { const days: string[] = []; return { read: async (day: string) => { days.push(day); return members; }, days }; };

test("F/G/H: heading = the first user message (not the AI title); falls back to the existing title, then the last fallback", () => {
  const c = conversation({ title: "AIが付けたタイトル", turns: [userTurn("今日は洗車をした。洗車をしたらやはり少し気持ちがいい。"), aiTurn("いいですね")] });
  assert.equal(conversationHeading(c), "今日は洗車をした。洗車をしたらやはり少し気持ちがいい。");
  assert.equal(conversationHeading(conversation({ title: undefined, turns: [userTurn("  タイトル無しの発言  ")] })), "タイトル無しの発言", "B: no title, user message exists");
  assert.notEqual(conversationHeading(c), c.title, "C: differs from the AI title");
  assert.equal(conversationHeading(conversation({ turns: [aiTurn("先に話しかけたAI"), userTurn("最初のユーザー発言")] })), "最初のユーザー発言", "D: legacy order with the assistant first");
  assert.equal(conversationHeading(conversation({ title: "保存済みタイトル", turns: [aiTurn("AIだけ")] })), "保存済みタイトル", "E: no user message -> the existing title");
  assert.equal(conversationHeading(conversation({ title: undefined, turns: [] })), "タイトルなし", "last fallback");
  const long = "あ".repeat(500); assert.equal(conversationHeading(conversation({ turns: [userTurn(long)] })), long, "stored text is never shortened (display clamps with CSS)");
});
test("I/J/K/L/M/N: a conversation's normal Memories come from memoryObjectIds; Reflections and other conversations' Memories are excluded", async () => {
  const conv = conversation({ id: "CONV-1", memoryObjectIds: ["M1", "R1", "M2"] });
  const r1 = asReflection({ id: "R1" });
  const other = mem("M9", { conversationId: "CONV-OTHER" });
  const day = dayReader([mem("M2"), mem("M1"), r1, other, mem("M3", { conversationId: "CONV-OTHER" })]);
  const found = await resolveConversationMemories(conv, day.read);
  assert.deepEqual(found.map((m) => m.id).sort(), ["M1", "M2"], "J: all of the conversation's normal Memories; K/N: the Reflection is excluded; M: other conversations' Memories are not mixed in");
  assert.deepEqual(day.days, ["2026-09-25"], "the Memory day file is the one of Conversation.startedAt (Capture sets Memory.date = conversation.startedAt)");
  assert.deepEqual((await resolveConversationMemories(conversation({ memoryObjectIds: ["M1"] }), dayReader([mem("M1")]).read)).map((m) => m.id), ["M1"], "I: one Memory");
  assert.deepEqual(await resolveConversationMemories(conversation({ memoryObjectIds: [] }), dayReader([]).read), [], "L: zero Memories -> nothing");
  // a Memory id that points to another conversation's Memory is rejected even if it is listed
  assert.deepEqual(await resolveConversationMemories(conversation({ id: "CONV-1", memoryObjectIds: ["M9"] }), dayReader([other]).read), []);
  // legacy: no usable ids -> the same day file's Memories with a matching conversationId
  const legacy = await resolveConversationMemories(conversation({ id: "CONV-1", memoryObjectIds: [] }), dayReader([mem("M1"), other, r1]).read);
  assert.deepEqual(legacy.map((m) => m.id), ["M1"]);
  // today's not-yet-written Memory is supplied from the session state; a read failure does not break the detail
  const failing = async () => { throw new Error("io"); };
  assert.deepEqual((await resolveConversationMemories(conversation({ memoryObjectIds: ["M5"] }), failing, [mem("M5")])).map((m) => m.id), ["M5"]);
});
test("summary and content that are effectively the same are not shown twice", () => {
  assert.equal(isEffectivelySameText("今日は  洗車をした", "今日は洗車をした"), true);
  assert.equal(isEffectivelySameText("要約", "もっと長い内容"), false);
});
test("list: only Conversation cards (no independent Memory / Reflection section or card)", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  const list = panel.slice(panel.indexOf("conversationRows.length === 0 ? ("), panel.indexOf("function ConversationCard("));
  assert.ok(list.includes("<ConversationCard") && !list.includes("MEMORY_TYPE_LABEL") && !list.includes("openMemoryRow") && !/>記憶</.test(list), "A/B/C/D/E: the day list renders ConversationCard only");
  assert.ok(panel.includes("const displayTitle = full ? conversationHeading(full) : null;") && !panel.includes("full.title?.trim()"), "the card heading is the first user message");
});
test("detail: 日記 shows 振り返り (Reflection + keywords), 会話 shows 記憶 (normal Memories); 会話全文を見る is last for both", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  const start = panel.indexOf("selectedConversationTitle}</p>"), end = panel.indexOf("会話全文を見る", start);
  const detail = panel.slice(start, end);
  assert.ok(detail.indexOf("selectedConversationReflection") < detail.indexOf("selectedConversationMemories"), "Reflection block, then Memory block, then the raw-view button");
  assert.ok(detail.includes(">振り返り<") && detail.includes("selectedConversationReflection.keywords") && detail.includes(">記憶<"), "O/P: 振り返り + keywords; I: 記憶");
  assert.ok(panel.includes('selectedConversationEntryKind === "diary"') && panel.includes('selectedConversationEntryKind === "conversation"'), "N/Q: Reflection only for 日記, normal Memories only for 会話");
  assert.ok(panel.includes("selectedConversationMemories && selectedConversationMemories.length > 0") && panel.includes("selectedConversationReflection && ("), "L/R: empty sections are not rendered");
  assert.equal(panel.indexOf("会話全文を見る", end + 10), -1, "S: the raw-view button is the last element");
});
test("T: the helpers are read-only and the Reflection effect only runs for 日記", () => {
  const lib = fs.readFileSync("src/lib/historyConversationCard.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/putConversation|putMemoryObject|persistCapture|writeMemoryObjectMarkdown|createInsightMemoryObject|readReflectionById|\.put\(/.test(lib), "no writes; readReflectionById is not reused for normal Memories");
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  assert.ok(panel.includes('conversationEntryTypeOf(selectedConversation) !== "diary"') && panel.includes('conversationEntryTypeOf(selectedConversation) !== "conversation"'));
  assert.ok(panel.includes("readMemoriesForDay(handle, day)"), "normal Memories use the existing day-file reader");
});

// ---------------------------------------------------------------------------
// Conversation History v2.1：カレンダーのドット＝Conversation基準／日記詳細の見出し／カレンダーのコンパクト化
// ---------------------------------------------------------------------------
import type { HistoryDayIndex } from "./vault";
const idAt = (iso: string) => ulid(Date.parse(iso));
const v2Entry = (over: { conversations?: string[]; memories?: string[]; reflections?: string[] }): HistoryDayIndex => ({
  conversations: (over.conversations ?? []).map((id) => ({ id, mode: "diary" as const, turnCount: 2 })),
  normalMemories: (over.memories ?? []).map((date) => ({ id: `M-${date}`, types: ["event" as const], preview: "p", createdAt: date, date })),
  reflections: (over.reflections ?? []).map((createdAt) => ({ id: `R-${createdAt}`, types: ["insight" as const], preview: "p", createdAt })),
});
const v1Entry = (over: { conversationIds?: string[]; normalMemoryCount?: number; reflectionIds?: string[] }): HistoryDayIndex => ({
  conversationIds: over.conversationIds ?? [], normalMemoryCount: over.normalMemoryCount ?? 0, reflectionIds: over.reflectionIds ?? [],
  memoryCount: (over.normalMemoryCount ?? 0) + (over.reflectionIds?.length ?? 0),
});
const DAY = "2026-09-25";
const noonId = idAt("2026-09-25T03:00:00.000Z"); // JST 9/25 12:00

test("dots A-E: only a Conversation makes the dot; Memory or Reflection alone never does", () => {
  assert.equal(indexEntryHasConversationOnDay(v2Entry({ conversations: [noonId] }), DAY, DAY), true, "A");
  assert.equal(indexEntryHasConversationOnDay(v2Entry({ memories: ["2026-09-25T00:00:00.000Z"] }), DAY, DAY), false, "B: Memory only");
  assert.equal(indexEntryHasConversationOnDay(v2Entry({ reflections: ["2026-09-25T03:00:00.000Z"] }), DAY, DAY), false, "C: Reflection only");
  assert.equal(indexEntryHasConversationOnDay(v2Entry({ conversations: [noonId], memories: ["2026-09-25T00:00:00.000Z"] }), DAY, DAY), true, "D");
  assert.equal(indexEntryHasConversationOnDay(v2Entry({ conversations: [noonId], reflections: ["2026-09-25T03:00:00.000Z"] }), DAY, DAY), true, "E");
});
test("dots F: the real PC-Vault case — Conversations started JST 9/26 early morning (UTC 9/25) with UTC-9/25 Memories: no dot on 9/25, dot on 9/26", () => {
  const early = ["2026-09-25T16:51:51.000Z", "2026-09-25T20:17:13.000Z", "2026-09-25T20:35:58.000Z"].map(idAt); // JST 9/26 01:51 / 05:17 / 05:35
  const bucket925 = v2Entry({ conversations: early, memories: ["2026-09-25T00:00:00.000Z", "2026-09-25T00:00:00.000Z", "2026-09-25T00:00:00.000Z"] });
  assert.equal(conversationLogicalDay(early[0], undefined, "2026-09-25"), "2026-09-26");
  assert.equal(indexEntryHasConversationOnDay(bucket925, "2026-09-25", "2026-09-25"), false, "the Memories no longer create a 9/25 dot");
  assert.equal(indexEntryHasConversationOnDay(bucket925, "2026-09-25", "2026-09-26"), true, "the Conversations' logical day (JST 9/26) has the dot");
});
test("dots G/H/I: v1 days use conversationIds only", () => {
  assert.equal(indexEntryHasConversationOnDay(v1Entry({ normalMemoryCount: 3 }), DAY, DAY), false, "G");
  assert.equal(indexEntryHasConversationOnDay(v1Entry({ reflectionIds: [idAt("2026-09-25T03:00:00.000Z")] }), DAY, DAY), false, "H");
  assert.equal(indexEntryHasConversationOnDay(v1Entry({ conversationIds: [noonId] }), DAY, DAY), true, "I");
});
test("dot contract: the dot and the Conversation card list use the same logical-day helper (no separate date logic)", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  const dayHas = panel.slice(panel.indexOf("function dayHasRecord("), panel.indexOf("// Memoryの由来会話"));
  assert.ok(dayHas.includes("indexEntryHasConversationOnDay(") && !/normalMemor|reflections|reflectionIds|hasSessionRecordToday/.test(dayHas.replace(/\/\/.*$/gm, "")), "the dot looks at Conversations only (no Memory / Reflection / today's session Memory)");
  assert.ok(panel.includes("return conversationLogicalDay(row.id, row.full?.startedAt, row.bucketDay);"), "the card list filters with the same helper");
  assert.ok(!panel.includes("hasSessionRecordToday"));
});
test("J/O: list cards and 会話 detail keep the first user message as the heading; K: the 日記 detail has no big heading", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  assert.ok(panel.includes("const displayTitle = full ? conversationHeading(full) : null;"), "J: every list card (日記 and 会話) uses the first user message");
  assert.ok(/selectedConversationEntryKind !== "diary" && \(\s*<p[^>]*>\{selectedConversationTitle\}<\/p>/.test(panel), "K/O: the detail heading is rendered only for non-diary (会話)");
  assert.equal((panel.match(/\{selectedConversationTitle\}/g) ?? []).length, 1, "the heading is rendered in exactly one place");
});
test("L/M/N/P/Q: 日記 detail = 振り返り + keywords + 会話全文を見る (last); 会話 detail = 記憶 + 会話全文を見る (last)", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  const start = panel.indexOf("selectedConversationEntryKind !== \"diary\" &&"), end = panel.indexOf("会話全文を見る", start);
  const detail = panel.slice(start, end);
  assert.ok(detail.includes(">振り返り<") && detail.includes("selectedConversationReflection.keywords") && detail.includes(">記憶<") && detail.includes("memory.keywords"));
  assert.ok(detail.indexOf("selectedConversationReflection &&") < detail.indexOf("selectedConversationMemories &&"));
  assert.equal(panel.indexOf("会話全文を見る", end + 10), -1, "the raw-view button is last");
});
test("R/S: month navigation and day selection are unchanged", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  assert.ok(panel.includes("onClick={() => goToMonth(-1)}") && panel.includes("onClick={() => goToMonth(1)}") && panel.includes("onClick={() => selectDay(day)}"));
  assert.ok(panel.includes("grid grid-cols-7"), "the 7-column layout is kept");
});
test("calendar is more compact vertically (spacing classes), without shrinking numbers or the month buttons", () => {
  const panel = fs.readFileSync("src/components/HistoryPanel.tsx", "utf8");
  assert.ok(panel.includes('<div className="flex shrink-0 flex-col gap-2">'), "section gap 20px -> 8px");
  assert.ok(panel.includes("text-center text-[11px] leading-3"), "weekday row line-height 16px -> 12px");
  assert.ok(panel.includes('<div className="flex flex-col gap-0">') && panel.includes("gap-x-1 gap-y-0"), "week row gap 4px -> 0");
  assert.ok(panel.includes("rounded-xl border px-1 py-1 text-xs transition"), "day cell padding 6px -> 4px (same number size text-xs)");
  assert.ok(panel.includes('mt-3 min-h-0 flex-1 overflow-y-auto') && panel.includes("border-t border-black/5 pt-3"), "space below the calendar 20px/16px -> 12px/12px");
  assert.ok(panel.includes("px-3 py-1 text-xs text-stone-500") && panel.includes("前月") && panel.includes("翌月"), "前月/翌月 buttons keep their size");
});
