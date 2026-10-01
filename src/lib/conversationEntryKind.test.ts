/**
 * Conversation入口種別（diary/conversation）の共有helperの回帰テスト。
 * DOM/Reactに依存しない純粋関数の単体テスト。
 * 実行方法：`npm run test:conversation-entry-kind`
 * （`tsc -p tsconfig.conversation-entry-kind.json && node --test .test-out/lib/conversationEntryKind.test.js`）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationEntryKindOf,
  conversationEntryKindLabel,
  conversationEntryTypeOf,
  conversationEntryTypeLabel,
  CONVERSATION_ENTRY_KIND_LABEL,
} from "./conversationEntryKind";
import { conversationToMarkdown, parseConversationMarkdown } from "./markdown";
import type { Conversation, Persona } from "./types";

const T0 = "2026-09-25T10:00:00.000Z";

function conversation(overrides: Partial<Conversation> & { persona: Persona }): Conversation {
  return {
    id: "CONV-1",
    startedAt: T0,
    turns: [],
    status: "active",
    memoryObjectIds: [],
    createdAt: T0,
    updatedAt: T0,
    metadata: { id: "m", schemaVersion: "0.1", source: "user-authored", createdAt: T0, updatedAt: T0 },
    ...overrides,
  };
}

test("companion → diary", () => {
  assert.equal(conversationEntryKindOf("companion"), "diary");
});

test("analyst → conversation", () => {
  assert.equal(conversationEntryKindOf("analyst"), "conversation");
});

test("coach（legacy） → conversation", () => {
  assert.equal(conversationEntryKindOf("coach"), "conversation");
});

test("表示ラベル：companion → 日記", () => {
  assert.equal(conversationEntryKindLabel("companion"), "日記");
  assert.equal(CONVERSATION_ENTRY_KIND_LABEL.diary, "日記");
});

test("表示ラベル：analyst / coach → 会話", () => {
  assert.equal(conversationEntryKindLabel("analyst"), "会話");
  assert.equal(conversationEntryKindLabel("coach"), "会話");
  assert.equal(CONVERSATION_ENTRY_KIND_LABEL.conversation, "会話");
});

// ===========================================================================
// conversationEntryTypeOf（2026-10-01追加：Entry Type / Persona分離の
// 唯一のConversation単位resolver。優先順位：entryType → legacy persona fallback）
// ===========================================================================

test("最重要regression：entryType=conversation / persona=companionでも、Entry Typeは「会話」を優先する", () => {
  const c = conversation({ persona: "companion", entryType: "conversation" });
  assert.equal(conversationEntryTypeOf(c), "conversation");
  assert.equal(conversationEntryTypeLabel(c), "会話");
});

test("entryType=diary / persona=analystでも、Entry Typeは「日記」を優先する", () => {
  const c = conversation({ persona: "analyst", entryType: "diary" });
  assert.equal(conversationEntryTypeOf(c), "diary");
  assert.equal(conversationEntryTypeLabel(c), "日記");
});

test("legacy：entryTypeなし + persona=companion → personaからdiaryへfallback", () => {
  const c = conversation({ persona: "companion" });
  assert.equal(conversationEntryTypeOf(c), "diary");
});

test("legacy：entryTypeなし + persona=analyst → personaからconversationへfallback", () => {
  const c = conversation({ persona: "analyst" });
  assert.equal(conversationEntryTypeOf(c), "conversation");
});

test("legacy coach：entryTypeなし + persona=coach → conversationへfallback（独自判定を追加しない）", () => {
  const c = conversation({ persona: "coach" });
  assert.equal(conversationEntryTypeOf(c), "conversation");
});

test("entryTypeが通常のConversationどおりに一致する場合も正しく返す（diary/companion）", () => {
  const c = conversation({ persona: "companion", entryType: "diary" });
  assert.equal(conversationEntryTypeOf(c), "diary");
});

test("entryTypeが通常のConversationどおりに一致する場合も正しく返す（conversation/analyst）", () => {
  const c = conversation({ persona: "analyst", entryType: "conversation" });
  assert.equal(conversationEntryTypeOf(c), "conversation");
});

// ===========================================================================
// MemoryObject.typesはentry kind判定へ一切影響しない（conversationEntryTypeOfは
// MemoryObject・MemoryTypeを一切importしない設計。型レベルで参照不能であることの
// 確認として、Conversationにしか無いフィールドだけを見ていることを示す）
// ===========================================================================

test("MemoryObject.typesに相当する情報が無くても、Conversation単体でentry kindが決まる", () => {
  // conversation()はMemoryObject関連フィールドを一切持たない。これだけでEntry Typeが
  // 決定できること自体が、MemoryObject.typesに依存していないことの直接的な証拠。
  const c = conversation({ persona: "companion", entryType: "conversation" });
  assert.equal(conversationEntryTypeOf(c), "conversation");
});

// ===========================================================================
// Persistence：Conversation.entryTypeのMarkdown round-trip（要件12/13/15）
// ===========================================================================

test("Markdown round-trip：entryType=diaryがfrontmatterへ書き出され、そのまま読み戻せる", () => {
  const c = conversation({ persona: "companion", entryType: "diary" });
  const md = conversationToMarkdown(c);
  assert.match(md, /\nentryType: diary\n/);
  const parsed = parseConversationMarkdown(md);
  assert.equal(parsed?.entryType, "diary");
});

test("Markdown round-trip：entryType=conversationがfrontmatterへ書き出され、そのまま読み戻せる", () => {
  const c = conversation({ persona: "analyst", entryType: "conversation" });
  const md = conversationToMarkdown(c);
  assert.match(md, /\nentryType: conversation\n/);
  const parsed = parseConversationMarkdown(md);
  assert.equal(parsed?.entryType, "conversation");
});

test("legacy Markdown：entryTypeフィールドが無くても例外なく読め、undefinedになり、personaへlegacy fallbackする", () => {
  const legacy = conversation({ persona: "analyst" }); // entryType未設定
  const md = conversationToMarkdown(legacy);
  assert.doesNotMatch(md, /\nentryType: /, "entryType未設定時はfrontmatterにキー自体が出ない");
  const parsed = parseConversationMarkdown(md);
  assert.equal(parsed?.entryType, undefined);
  assert.equal(conversationEntryTypeOf(parsed!), "conversation", "legacy fallbackでpersonaから推定される");
});

test("titleとentryTypeが共存してもMarkdown round-tripで両方保持される", () => {
  const c = conversation({ persona: "companion", entryType: "diary", title: "公園散歩の記録" });
  const md = conversationToMarkdown(c);
  const parsed = parseConversationMarkdown(md);
  assert.equal(parsed?.entryType, "diary");
  assert.equal(parsed?.title, "公園散歩の記録");
});
