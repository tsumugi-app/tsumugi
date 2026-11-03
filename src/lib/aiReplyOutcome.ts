import type { Conversation, ConversationTurn } from "./types";

/** 本文が1文字も無い応答（空白だけ・日時ラベルだけを取り除いた後の空も含む）。会話の発言としては保存しない。本文のある応答の空白はそのまま残す。 */
export function isBlankAiReply(normalizedText: string): boolean {
  return normalizedText.trim() === "";
}

/**
 * 同じ発言でもう一度応答を求めるときの、最後のユーザー発言までのturns。末尾がユーザー発言か途中で止まった応答のときだけ返す。
 * 途中で止まった応答は記録に残したまま、ここでは渡さない。それ以外（外部編集で普通のAI発言が届いた等）は再試行の対象がないのでnull。
 */
export function retryableTurns(turns: ConversationTurn[]): ConversationTurn[] | null {
  const last = turns[turns.length - 1];
  if (!last) return null;
  if (last.role === "user") return turns;
  if (!last.interrupted) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") return turns.slice(0, i + 1);
  }
  return null;
}

/** 途中で止まった応答の後に、同じ発言への別の応答が続いている（再試行された）か */
export function isSupersededTurn(turns: ConversationTurn[], index: number): boolean {
  return turns[index]?.interrupted === true && turns[index + 1]?.role === "ai";
}

/** AIへ渡す発言（/api/chat・/api/capture・直前の会話）。再試行された途中の応答は記録に残るが、回答としては渡さない。 */
export function turnsForAi(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.filter((_, index) => !isSupersededTurn(turns, index));
}

/** 途中で止まった応答で終わり、まだ閉じていない会話。起動時のCaptureを待たせ、ホーム画面から続きを開ける。 */
export function endsWithInterruptedReply(conversation: Conversation): boolean {
  return conversation.status === "active" && !conversation.endedAt && conversation.turns[conversation.turns.length - 1]?.interrupted === true;
}

export function newestInterruptedConversation(conversations: Conversation[]): Conversation | null {
  let newest: Conversation | null = null;
  for (const conversation of conversations) {
    if (endsWithInterruptedReply(conversation) && (!newest || conversation.updatedAt > newest.updatedAt)) newest = conversation;
  }
  return newest;
}
