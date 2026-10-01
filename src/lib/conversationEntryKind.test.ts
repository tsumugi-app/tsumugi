/**
 * Conversation入口種別（diary/conversation）の共有helperの回帰テスト。
 * DOM/Reactに依存しない純粋関数の単体テスト。
 * 実行方法：`npm run test:conversation-entry-kind`
 * （`tsc -p tsconfig.conversation-entry-kind.json && node --test .test-out/lib/conversationEntryKind.test.js`）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { conversationEntryKindOf, conversationEntryKindLabel, CONVERSATION_ENTRY_KIND_LABEL } from "./conversationEntryKind";

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
