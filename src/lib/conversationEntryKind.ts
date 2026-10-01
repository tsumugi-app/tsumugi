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
 * 【v2の方針（2026-10-01、Entry Type / Persona / Memory Type分離整理）：
 *  Conversation.entryTypeがcanonical source】
 * `Conversation.entryType`（optional）が、ユーザーが実際に押した入口をそのまま保持する
 * canonical sourceである。新規Conversationは、入口buttonのhandlerがこの値を直接
 * 渡して作成するため、personaから逆算する必要が無い（`conversationEntryTypeOf`参照）。
 * 以前（v1、STEP 2-A）はConversationにこのフィールドが無く、entry kindは常にpersonaから
 * 決定的に導出していた——`conversationEntryKindOf`（persona→entry kindの純粋な変換）は
 * その実装として現在も存在するが、v2では「entryTypeが無いlegacy Conversationだけの
 * fallback」としての役割に限定される（`conversationEntryTypeOf`参照）。新規Conversationの
 * canonical classificationにはこの関数を直接使わない。
 *
 * 【変換規則（personaからの導出。legacy fallback・persona behaviorの参考情報としてのみ使う）】
 *   companion      → diary
 *   analyst        → conversation
 *   coach（legacy）→ conversation
 *
 * 【MemoryObject.typesとは完全に無関係】
 * `MemoryObject.types`に存在する`"diary"`/`"conversation"`は、Capture時にLLMがMemory内容を
 * 見て判定する「Memory内容の分類」であり、Conversationの入口種別とは別物。このファイルは
 * `MemoryObject`・`MemoryType`を一切参照しない——Conversationの入口種別だけを扱う。
 */
import type { Conversation, Persona } from "./types";

export type ConversationEntryKind = "diary" | "conversation";

/**
 * persona → Conversation入口種別（legacy fallback専用）。
 * 新規Conversationのcanonical classificationには使わない——必ず`conversationEntryTypeOf`
 * （`Conversation.entryType`を優先し、無い場合だけこの関数へfallbackする）を経由すること。
 * この関数自体は、Conversation Generation側でpersona behaviorの参考値として引き続き
 * 使ってよい（entry kind判定とpersona behaviorは別の利用目的であり、この変換式自体は
 * どちらからも参照されうる）。
 */
export function conversationEntryKindOf(persona: Persona): ConversationEntryKind {
  return persona === "companion" ? "diary" : "conversation";
}

/** 表示用の日本語ラベル（「日記」「会話」）。 */
export const CONVERSATION_ENTRY_KIND_LABEL: Record<ConversationEntryKind, string> = {
  diary: "日記",
  conversation: "会話",
};

/** persona → 表示用ラベルの合成ヘルパ（legacy fallback専用。`conversationEntryTypeOf`参照）。 */
export function conversationEntryKindLabel(persona: Persona): string {
  return CONVERSATION_ENTRY_KIND_LABEL[conversationEntryKindOf(persona)];
}

/**
 * Conversation全体を受け取る、entry kindの唯一のresolver（2026-10-01追加）。
 * 優先順位：
 *   1. `conversation.entryType`（canonical source。ユーザーが実際に押した入口）
 *   2. legacyのみ：`conversation.persona`（`conversationEntryKindOf`、上記fallback変換）
 * `MemoryObject.types`・`HistoryDayIndexV2.mode`・Reflection内容・title内容・AIによる
 * 推測は一切参照しない。History表示・History Index生成は、必ずこの関数（または
 * `conversationEntryTypeLabel`）を経由すること。
 */
export function conversationEntryTypeOf(conversation: Conversation): ConversationEntryKind {
  if (conversation.entryType === "diary" || conversation.entryType === "conversation") {
    return conversation.entryType;
  }
  return conversationEntryKindOf(conversation.persona);
}

/** Conversation全体 → 表示用ラベルの合成ヘルパ（`conversationEntryTypeOf`参照）。 */
export function conversationEntryTypeLabel(conversation: Conversation): string {
  return CONVERSATION_ENTRY_KIND_LABEL[conversationEntryTypeOf(conversation)];
}
