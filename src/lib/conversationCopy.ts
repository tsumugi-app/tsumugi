/**
 * 会話画面の「会話をコピー」：現在のチャットの発言を、時系列のまま原文で1つの文にする（表示・コピー専用）。
 *
 * - 純関数。保存・送信・AI呼び出しは無い。渡された会話（現在のチャット）の発言だけを使う。診断ログ・内部JSONは入れない。
 * - 本文は原文のまま（切らない・要約しない）。長い会話でもすべての発言を入れる。
 * - 日時は「発言した日時」（ConversationTurn.timestamp：記録された日時）だけを書く。話の中の出来事の日時とは別のもの、と見出しに書く。
 *   リアルタイム日記は、その日記の日付を別に書く（発言日時と混ぜない）。
 */
import type { ConversationTurn } from "./types";
import { isSupersededTurn } from "./aiReplyOutcome";

export interface LocalStamp {
  date: string;
  time: string;
}

/** the device's local date (YYYY-MM-DD) and time (HH:MM); null when the timestamp is missing or invalid */
export function localStamp(iso: string | undefined): LocalStamp | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

export function formatConversationForCopy(
  turns: readonly ConversationTurn[],
  opts: { diaryDate?: string; stamp?: (iso: string | undefined) => LocalStamp | null } = {},
): string {
  const stamp = opts.stamp ?? localStamp;
  const lines: string[] = ["【会話ログ】", "（日時は発言した日時で、この端末の現地時刻。話の中の出来事の日時ではない）"];
  if (opts.diaryDate) lines.push(`リアルタイム日記の日付：${opts.diaryDate}`);
  let day = "";
  const list = [...turns];
  list.forEach((turn, index) => {
    const s = stamp(turn.timestamp);
    if (s && s.date !== day) {
      day = s.date;
      lines.push("", `■ ${s.date}`);
    }
    const who = turn.role === "user" ? "ユーザー" : "Tsumugi";
    const marks = [s ? s.time : "", isSupersededTurn(list, index) ? "途中で止まり、再生成された返答" : turn.interrupted ? "途中で止まった返答" : ""].filter(Boolean);
    lines.push("", `${who}${marks.length > 0 ? `（${marks.join("・")}）` : ""}：`, turn.content);
  });
  return lines.join("\n");
}
