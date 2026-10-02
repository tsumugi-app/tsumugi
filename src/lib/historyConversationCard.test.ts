/**
 * Conversation History（STEP 3）のConversation card表示ロジック
 * （title fallback・Reflection複数時の決定ルール）の回帰テスト。
 * DOM/Reactに依存しない純粋関数の単体テスト。
 * 実行方法：`npm run test:history-conversation-card`
 * （`tsc -p tsconfig.history-conversation-card.json && node --test .test-out/lib/historyConversationCard.test.js`）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildReflectionMap, fallbackConversationTitle } from "./historyConversationCard";
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
