/**
 * Conversationの「入口種別」（ユーザーが「日記」「会話」のどちらの入口からConversationを
 * 始めたか）を表す、唯一の共有定義。
 *
 * 【personaとは別概念】
 * `persona`（`"companion" | "coach" | "analyst"`）はAIの会話スタイル・振る舞い（behavior）を
 * 表すフィールドであり、entry kind（ユーザーがどの入口から始めたか）とは本来別の概念である。
 * 現状はUIの入口選択がpersonaも同時に決めるため対応関係があるが（下記の変換規則）、
 * 将来personaとentry kindが分離しうることを見越し、helper/型の名前はpersonaとは独立に設計する。
 *
 * 【v1の方針：schemaへ新しいフィールドを追加しない】
 * `Conversation`に`entryType`／`mode`等の新しいフィールドは追加しない。唯一のcanonical
 * sourceは既存の`Conversation.persona`のままとし、entry kindは常にpersonaから決定的に
 * 導出する（このファイルの`conversationEntryKindOf`が、その変換を行う唯一の実装）。
 *
 * 【変換規則】
 *   companion      → diary
 *   analyst        → conversation
 *   coach（legacy）→ conversation
 *
 * 【MemoryObject.typesとは完全に無関係】
 * `MemoryObject.types`に存在する`"diary"`/`"conversation"`は、Capture時にLLMがMemory内容を
 * 見て判定する「Memory内容の分類」であり、Conversationの入口種別とは別物。このファイルは
 * `MemoryObject`・`MemoryType`を一切参照しない——Conversationの入口種別だけを扱う。
 */
import type { Persona } from "./types";

export type ConversationEntryKind = "diary" | "conversation";

/** persona → Conversation入口種別。唯一の変換実装（他の箇所で独自に再実装しないこと）。 */
export function conversationEntryKindOf(persona: Persona): ConversationEntryKind {
  return persona === "companion" ? "diary" : "conversation";
}

/** 表示用の日本語ラベル（「日記」「会話」）。 */
export const CONVERSATION_ENTRY_KIND_LABEL: Record<ConversationEntryKind, string> = {
  diary: "日記",
  conversation: "会話",
};

/** persona → 表示用ラベルの合成ヘルパ（既存呼び出し箇所の置き換え用）。 */
export function conversationEntryKindLabel(persona: Persona): string {
  return CONVERSATION_ENTRY_KIND_LABEL[conversationEntryKindOf(persona)];
}
