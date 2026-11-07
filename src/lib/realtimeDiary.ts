/**
 * リアルタイム日記：一日につき一つの会話を、一時保存・再開しながら続ける。会話そのものは既存のConversation・保存処理をそのまま使い、
 * この会話であることと対象日だけを`Conversation.realtimeDiary`に持つ（types.ts）。
 *
 * - 対象日は端末のローカル時刻で決め、午前4時より前は前日の日記とする（11月8日 3:59 → 11月7日、4:00 → 11月8日）。
 *   日記を始めた時点で確定して保存し、発言の実際の日時（turn.timestamp）から計算し直さない。発言時刻も書き換えない。
 * - 終了日時（endedAt）が無い間は「書きかけ」。会話の区切り（ホームへ戻る等）でも、起動時の自動処理でも、Memoryを作らない。
 * - 時刻は、書き始めと、間が空いて再開した発言にだけ出す（すべての吹き出しには出さない）。
 */
import type { Conversation, ConversationTurn } from "./types";

/** この時刻（端末のローカル時刻）から新しい日記の日になる */
export const DIARY_DAY_START_HOUR = 4;
/** 前の発言からこれだけ空いて再開した発言に時刻を出す */
export const DIARY_TIME_GAP_MS = 30 * 60_000;

const pad2 = (n: number) => String(n).padStart(2, "0");
const localDateKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 実在する日付の YYYY-MM-DD か */
export function isDiaryDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** その瞬間に始める日記の対象日（端末のローカル時刻、午前4時区切り） */
export function diaryDateOf(now: Date): string {
  // 正午で数えるので、夏時間の切り替わる日でも暦の日付がずれない
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < DIARY_DAY_START_HOUR ? 1 : 0), 12);
  return localDateKey(day);
}

/** 書きかけのリアルタイム日記（終了していない）。会話の区切りでMemoryを作らず、起動時の自動処理の対象にもしない */
export function isOpenRealtimeDiary(conversation: Conversation): boolean {
  return conversation.realtimeDiary !== undefined && !conversation.endedAt;
}

/**
 * `next`が`stored`の発言をすべて含むか（発言と返答を、役割と時刻で見分ける。内容はVaultでの編集で変わりうるので比べない）。
 * 同じ日記を二つのタブで開いて書いたとき、古い画面の保存が別のタブの発言を消さないための確認（db.tsの保存と、送信前の読み直し）。
 */
export function keepsEveryTurn(stored: ConversationTurn[], next: ConversationTurn[]): boolean {
  const keys = new Set(next.map((t) => `${t.role}|${t.timestamp}`));
  return stored.every((t) => keys.has(`${t.role}|${t.timestamp}`));
}

/** 「今日の続きを書く」で開く日記：その対象日の、書きかけで発言のある日記（複数あれば最後に更新されたもの） */
export function resumableRealtimeDiary(conversations: Conversation[], date: string): Conversation | undefined {
  return conversations
    .filter((c) => isOpenRealtimeDiary(c) && c.status === "active" && c.realtimeDiary?.date === date && c.turns.length > 0)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))[0];
}

/**
 * Markdownの`## Diary`節に書く日記本文。`#`か`\\`で始まる行は先頭に`\\`を足す（本文の行が見出しとして読まれて会話記録の区切りと
 * 取り違えられない）。読むときに1つだけ外すので、元の文に戻る。
 */
export function escapeDiaryText(text: string): string {
  return text.split("\n").map((line) => (/^[#\\]/.test(line) ? `\\${line}` : line)).join("\n");
}
export function unescapeDiaryText(text: string): string {
  return text.split("\n").map((line) => (line.startsWith("\\") ? line.slice(1) : line)).join("\n");
}

/** 日記を終えて、Memory（既存のCapture）と日記本文の両方ができている */
export function isRealtimeDiaryComplete(conversation: Conversation): boolean {
  return conversation.realtimeDiary !== undefined && !!conversation.endedAt && conversation.status === "captured" && !!conversation.realtimeDiary.text;
}

/** 終えたが、Memoryか日記本文がまだの日記（AIの失敗・途中で閉じた等）。ホームから仕上げ直せる。新しいものから */
export function unfinishedRealtimeDiaries(conversations: Conversation[]): Conversation[] {
  return conversations
    .filter((c) => c.realtimeDiary !== undefined && !!c.endedAt && c.status !== "archived" && c.turns.length > 0 && !isRealtimeDiaryComplete(c))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** その対象日の前日（YYYY-MM-DD）。ホームの「昨日の日記を仕上げる」の判定に使う */
export function previousDiaryDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDateKey(new Date(y, m - 1, d - 1, 12));
}

/**
 * 午前4時を過ぎて対象日が終わった、書きかけの日記（PR-C）。`today`は今の対象日（diaryDateOf(now)）。文字列の大小で比べる（YYYY-MM-DD）。
 * 端末の時計が戻った・西へ移動した等で対象日が今日より後の日記は、締め切らずにそのまま書き続ける。
 */
export function isOverdueRealtimeDiary(conversation: Conversation, today: string): boolean {
  return isOpenRealtimeDiary(conversation) && conversation.realtimeDiary!.date < today;
}

/**
 * 書きかけの日記へ新しい発言を送ろうとしたとき、日付の切り替えを案内するか。発言のある日記の対象日が過ぎていたら案内する
 * （発言は勝手に別の日記へ移さない。本人が切り替えを選ぶ）。発言の無い日記は、まだ何も保存されていないので案内しない（呼び出し側が今日の日付にする）。
 */
export function needsDiaryDayChange(conversation: Conversation, now: Date): { from: string; to: string } | null {
  if (!isOpenRealtimeDiary(conversation) || conversation.turns.length === 0) return null;
  const to = diaryDateOf(now);
  return isOverdueRealtimeDiary(conversation, to) ? { from: conversation.realtimeDiary!.date, to } : null;
}

/**
 * ホームに出す「仕上げ待ち」の日記：終えたがMemoryか日記本文がまだの日記と、午前4時を過ぎた書きかけの日記（発言のあるもの）。
 * 前日分が残っていても、今日の日記は別に始められる（「リアルタイム日記を始める」は今日の対象日だけを見る）。新しいものから。
 */
export function realtimeDiariesToFinish(conversations: Conversation[], today: string): Conversation[] {
  const overdue = conversations.filter((c) => isOverdueRealtimeDiary(c, today) && c.status === "active" && c.turns.length > 0);
  return [...unfinishedRealtimeDiaries(conversations), ...overdue]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** 時刻の表示。対象日と違う暦日の発言（深夜など）には月日も付ける。端末のローカル時刻 */
export function formatDiaryTime(at: Date, diaryDate: string): string {
  const time = `${at.getHours()}:${pad2(at.getMinutes())}`;
  return localDateKey(at) === diaryDate ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

/** この発言の前に出す時刻。書き始めの発言と、前の発言から間が空いた発言だけ（AIの返答には出さない） */
export function diaryTimeLabelAt(turns: ConversationTurn[], index: number, diaryDate: string): string | null {
  const turn = turns[index];
  if (!turn || turn.role !== "user") return null;
  const at = Date.parse(turn.timestamp);
  if (!Number.isFinite(at)) return null;
  for (let i = index - 1; i >= 0; i--) {
    const before = Date.parse(turns[i].timestamp);
    if (!Number.isFinite(before)) continue;
    if (at - before < DIARY_TIME_GAP_MS) return null;
    break;
  }
  return formatDiaryTime(new Date(at), diaryDate);
}
