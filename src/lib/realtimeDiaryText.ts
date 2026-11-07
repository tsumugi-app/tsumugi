"use client";
/**
 * リアルタイム日記の本文を、選んでいるAIに書いてもらう（/api/diary）。送るのはその日の会話（発言と返答、端末のローカル時刻）だけ。
 * 送り先とキーはPR #27の共通の仕組み（selectedAiHeaders）で決まり、別のAIへ切り替えることはない。保存はしない（呼び出し側が端末の記録へ）。
 */
import { turnsForAi } from "./aiReplyOutcome";
import { formatDiaryTime } from "./realtimeDiary";
import { selectedAiHeaders, type AiRequestOptions } from "./selectedAi";
import type { Conversation } from "./types";

export interface WrittenRealtimeDiary {
  text: string;
  title: string;
  aiProvider: string;
}

export async function writeRealtimeDiaryText(conversation: Conversation, ai: AiRequestOptions = {}, signal?: AbortSignal): Promise<WrittenRealtimeDiary> {
  const date = conversation.realtimeDiary?.date;
  if (!date) throw new Error("not a realtime diary");
  const { provider, headers } = await selectedAiHeaders(ai);
  const turns = turnsForAi(conversation.turns).map((turn) => {
    const at = Date.parse(turn.timestamp);
    return { role: turn.role, content: turn.content, ...(Number.isFinite(at) ? { time: formatDiaryTime(new Date(at), date) } : {}) };
  });
  const res = await fetch("/api/diary", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ date, turns }),
    signal,
  });
  if (!res.ok) throw new Error(`diary request failed with status ${res.status}`);
  const data = (await res.json()) as { diary?: unknown; title?: unknown };
  const text = typeof data.diary === "string" ? data.diary.trim() : "";
  if (!text) throw new Error("diary request returned no text");
  return { text, title: typeof data.title === "string" ? data.title.trim() : "", aiProvider: provider };
}
