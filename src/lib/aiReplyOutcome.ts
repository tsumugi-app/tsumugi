import type { ConversationTurn } from "@/lib/types";

/** 本文が1文字も無い応答（空白だけ・日時ラベルだけを取り除いた後の空も含む）。会話の発言としては保存しない。本文のある応答の空白はそのまま残す。 */
export function isBlankAiReply(normalizedText: string): boolean {
  return normalizedText.trim() === "";
}

/**
 * 同じ発言でもう一度応答を求めるときに/api/chatへ渡すturns。末尾がユーザー発言のときと、末尾が途中で止まった応答（interruptedTurnAt）のときだけ返す。
 * 途中で止まった応答は記録に残したまま、ここでは渡さない（AIには最後のユーザー発言への応答を求める）。それ以外（外部編集でAI発言が届いた等）は再試行の対象がないのでnull。
 */
export function retryableTurns(turns: ConversationTurn[], interruptedTurnAt: string | null): ConversationTurn[] | null {
  const last = turns[turns.length - 1];
  if (!last) return null;
  if (last.role === "user") return turns;
  if (interruptedTurnAt === null || last.timestamp !== interruptedTurnAt) return null;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") return turns.slice(0, i + 1);
  }
  return null;
}
