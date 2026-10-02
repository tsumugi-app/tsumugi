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
import path from "node:path";
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
// buildReflectionMap（要件7、2026-10-02改訂：複数Reflection時は「内容が充実している
// 方」を優先し、最後にcreatedAt降順＝最新で決める。単純な「最新を採用」ではない）
// ===========================================================================

test("buildReflectionMap: 1件だけの場合はそのままconversationIdへ紐付く", () => {
  const map = buildReflectionMap([reflection()]);
  assert.equal(map.get("CONV-1")?.id, "REF-1");
});

test("buildReflectionMap: keywords・本文の長さが同程度なら新しい方（createdAt降順）を採用する", () => {
  const older = reflection({ id: "REF-OLD", createdAt: "2026-09-20T10:00:00.000Z", content: "古い振り返り", summary: "古い振り返り" });
  const newer = reflection({ id: "REF-NEW", createdAt: "2026-09-25T10:00:00.000Z", content: "新しい振り返りです", summary: "新しい振り返りです" });
  const map = buildReflectionMap([older, newer]);
  assert.equal(map.size, 1, "削除・統合はしないが、1 conversationIdにつき採用するのは1件だけ");
  assert.equal(map.get("CONV-1")?.id, "REF-NEW");
});

test("buildReflectionMap: 実機バグの再現ケース——古いが内容豊富なReflectionを、新しいが劣化した複製（keywords無し・タイトルのように短い）より優先する", () => {
  // STEP 2-Bの冪等性ガード導入前のlegacyデータを想定：同じ会話に対し、内容の濃い
  // Reflection（keywordsあり・本文が長い）が先に作られ、後から短く情報の薄い
  // 複製が作られてしまったケース。「最新を採用」だとこの劣化複製が選ばれてしまい、
  // 実機で報告された「本文がタイトルのように短く、keywordsが出ない」症状と一致する。
  const rich = reflection({
    id: "REF-RICH",
    createdAt: "2026-09-20T10:00:00.000Z",
    content: "今日は公園で子どもと遊んだ後、近所のパン屋に寄って好きなクロワッサンを買って帰った。",
    summary: "今日は公園で子どもと遊んだ後、近所のパン屋に寄って好きなクロワッサンを買って帰った。",
    keywords: ["公園", "パン屋"],
  });
  const degenerate = reflection({
    id: "REF-THIN",
    createdAt: "2026-09-25T10:00:00.000Z",
    content: "公園でのこと",
    summary: "公園でのこと",
    keywords: [],
  });
  const map = buildReflectionMap([rich, degenerate]);
  assert.equal(map.get("CONV-1")?.id, "REF-RICH", "新しくても劣化した複製ではなく、内容の濃い既存Reflectionを選ぶ");
  assert.deepEqual(map.get("CONV-1")?.keywords, ["公園", "パン屋"], "選ばれたReflectionのkeywordsがそのまま使われる");
});

test("buildReflectionMap: keywordsの有無が異なれば、本文の長さに関わらずkeywordsがある方を優先する", () => {
  const withKeywords = reflection({
    id: "REF-KW",
    createdAt: "2026-09-20T10:00:00.000Z",
    content: "短い本文",
    summary: "短い本文",
    keywords: ["散歩"],
  });
  const withoutKeywords = reflection({
    id: "REF-NOKW",
    createdAt: "2026-09-25T10:00:00.000Z",
    content: "こちらのほうが本文は長いけれどkeywordsが無い振り返り",
    summary: "こちらのほうが本文は長いけれどkeywordsが無い振り返り",
    keywords: [],
  });
  const map = buildReflectionMap([withKeywords, withoutKeywords]);
  assert.equal(map.get("CONV-1")?.id, "REF-KW", "本文の長さより、keywordsの有無を優先する");
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

// ===========================================================================
// History一覧からの「独立した振り返り」排除と、Conversation詳細への同一Reflection
// 紐付け（2026-10-02、要件3：filterコードの存在だけでなく、実際のデータ経路を確認する）
// ===========================================================================

test("Reflectionは一覧（記憶）行としては除外され、同じReflectionがconversationIdでdetailへ紐付く", () => {
  // HistoryPanel.tsxのMemoryRow（id/origin/...）と同じ形の、その日の一覧行を模す。
  const normalRow = { id: "MEM-1", origin: "normal" as const };
  const reflectionRow = { id: "REF-1", origin: "reflection" as const };
  const dayRows = [normalRow, reflectionRow];

  // HistoryPanel.tsxの`normalMemoryRows`と全く同じ述語（row.origin !== "reflection"）。
  const listRows = dayRows.filter((row) => row.origin !== "reflection");
  assert.deepEqual(listRows.map((r) => r.id), ["MEM-1"], "「記憶」一覧にはReflectionが独立項目として出てこない");

  // 同じ日に実在する、まさにそのReflectionの本体（MemoryObject）。
  const theReflection = reflection({ id: "REF-1", conversationId: "CONV-1", content: "今日は散歩した", summary: "今日は散歩した", keywords: ["散歩"] });
  const map = buildReflectionMap([theReflection]);
  const linked = map.get("CONV-1");
  assert.equal(linked?.id, "REF-1", "一覧から除外したのと同じidのReflectionがdetail用mapに入る");
  assert.equal(linked, theReflection, "参照そのものが同一（複製・再生成していない）");
  assert.equal(linked?.content, "今日は散歩した", "detailへ渡る内容は既存のReflection本文そのまま");
  assert.deepEqual(linked?.keywords, ["散歩"], "既存keywordsもそのまま渡る（新規生成していない）");
});

test("normal MemoryはReflection除外の影響を受けず、一覧にそのまま残る", () => {
  const rows = [
    { id: "MEM-1", origin: "normal" as const },
    { id: "MEM-2", origin: "normal" as const },
    { id: "REF-1", origin: "reflection" as const },
  ];
  const listRows = rows.filter((row) => row.origin !== "reflection");
  assert.deepEqual(listRows.map((r) => r.id), ["MEM-1", "MEM-2"]);
});

// ===========================================================================
// HistoryPanel.tsx構造確認（2026-10-02）：一覧はtitleのみ、detailはtitle→Reflection→
// keywords→会話全文、色はエンジ〜茶の同系統。ソースを直接確認する
// （vaultRecoveryLegacyCleanup.test.tsの既存パターンと同じ手法）。
// ===========================================================================

const HISTORY_PANEL_SOURCE = fs.readFileSync(
  path.join(process.cwd(), "src/components/HistoryPanel.tsx"),
  "utf8"
);

test("HistoryPanel.tsx: Conversation card（一覧）はReflection previewを表示しない", () => {
  const begin = HISTORY_PANEL_SOURCE.indexOf("function ConversationCard(");
  const body = HISTORY_PANEL_SOURCE.slice(begin, HISTORY_PANEL_SOURCE.indexOf("function HistoryTurnBubble(", begin));
  assert.ok(!body.includes("reflection:"), "ConversationCardはもうreflection propを受け取らない");
  assert.ok(!body.includes("reflectionPreview"), "一覧側にReflection preview変数が残っていない");
  assert.ok(body.includes("displayTitle"), "一覧にはtitleは引き続き表示する");
  assert.ok(body.includes('entryKind ? CONVERSATION_ENTRY_KIND_LABEL[entryKind]'), "一覧には会話/日記のラベルも引き続き表示する");
});

test("HistoryPanel.tsx: Conversation detailはtitle→Reflection本文→keywords→会話全文、の順で、独立した「振り返り」ラベルを持たない", () => {
  const begin = HISTORY_PANEL_SOURCE.indexOf("selectedConversationTitle}</p>");
  const end = HISTORY_PANEL_SOURCE.indexOf("会話全文を見る", begin);
  const detailBlock = HISTORY_PANEL_SOURCE.slice(begin, end);
  assert.ok(detailBlock.includes("selectedConversationReflection.content"), "Reflection本文（既存の内容）がtitleの直後に続く");
  assert.ok(detailBlock.includes("selectedConversationReflection.keywords"), "既存keywordsがReflection本文の下に表示される");
  assert.ok(
    detailBlock.indexOf("selectedConversationReflection.content") < detailBlock.indexOf("selectedConversationReflection.keywords"),
    "Reflection本文→keywordsの順になっている"
  );
  assert.ok(!detailBlock.includes(">振り返り<"), "「振り返り」という独立section labelは表示しない");
});

test("HistoryPanel.tsx: entry kindの色はエンジ〜茶の同系統（rose/amber）で、赤×青のような対比ではない", () => {
  const begin = HISTORY_PANEL_SOURCE.indexOf("const ENTRY_KIND_ACCENT");
  const block = HISTORY_PANEL_SOURCE.slice(begin, HISTORY_PANEL_SOURCE.indexOf("};", begin));
  assert.ok(block.includes("rose"), "会話＝エンジ系（rose系統）");
  assert.ok(block.includes("amber"), "日記＝薄めの茶系（amber系統）");
  assert.ok(!block.includes("slate"), "以前の寒色（slate）は使わない");
  assert.ok(!block.includes("sky"), "赤と対比する青系は使わない");
  assert.ok(!block.includes("blue"), "赤と対比する青系は使わない");
});

test("HistoryPanel.tsx: 一覧外のUI配色（背景・既存の警告表示）は変更していない", () => {
  assert.ok(HISTORY_PANEL_SOURCE.includes("bg-[var(--background)]"), "背景は既存のCSS変数のまま");
  assert.ok(HISTORY_PANEL_SOURCE.includes("bg-amber-50/60"), "既存の「開けません」警告色は変更していない");
});
