/**
 * 自動評価基盤 E1：会話の画面が assembleChatContext（chatContextAssembly.ts）へ渡す、実際の読み込み先と試験設定の判定。
 * 切り出す前の ChatScreen が直接呼んでいた関数を、そのまま並べただけ（処理は変えていない）。
 */
import { getAllConversations, getAllMemoryObjects } from "./db";
import { retrieveRelevantMemories } from "./retrieval";
import { loadConfirmedAliasLists } from "./personAliasDevice";
import { recordSynthesisShown, synthesisContextForTurn } from "./synthesisChat";
import { withVaultWorldRead } from "./vaultWorldLock";
import { memoryGraphEnabled } from "./memoryGraphFlag";
import { memoryTimelineEnabled } from "./memoryTimelineFlag";
import { memorySynthesisEnabled } from "./memorySynthesisFlag";
import { debugLogEnabled } from "./generationDebugLog";
import type { ChatContextFlags, ChatContextSources } from "./chatContextAssembly";

export const deviceChatContextSources: ChatContextSources = {
  retrieve: (text, options) => retrieveRelevantMemories(text, options),
  loadConfirmedAliasLists: () => loadConfirmedAliasLists(),
  loadConversations: () => withVaultWorldRead(() => getAllConversations()),
  loadMemories: () => withVaultWorldRead(() => getAllMemoryObjects()),
  synthesisContextForTurn: (memories, turn) => synthesisContextForTurn(memories, turn),
  recordSynthesisShown: (ids, conversationId) => recordSynthesisShown(ids, conversationId),
};

export const deviceChatContextFlags: ChatContextFlags = {
  memoryGraph: () => memoryGraphEnabled(),
  memoryTimeline: () => memoryTimelineEnabled(),
  memorySynthesis: () => memorySynthesisEnabled(),
  diagnostics: () => debugLogEnabled(),
};
