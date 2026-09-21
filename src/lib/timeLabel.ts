/**
 * Conversation Time Awareness（`/api/chat`）がLLMへ渡す入力専用の日時ラベル「[YYYY-MM-DD HH:mm JST]」を、
 * AIの返答・保存されるAI turn・provider投入用の過去履歴の「先頭」から取り除くための共通処理。
 *
 * 背景：過去のAI発言にも日時ラベルを付けて渡しているため、モデルがそのパターンを真似て、返答の先頭に
 * 日時ラベルを出力することがある（画面・IndexedDB・Vault Markdownに残り、次のターンで二重のラベルになる）。
 *
 * 【対象は「先頭」だけ】本文の途中にある同じ形式の文字列（ユーザーが意図的に書いた日付表記など）は削除しない。
 * 先頭のラベルは、直後の空白・改行とあわせて、連続していれば全て取り除く。`[メモ]`や`[2026-09-21]`のような、
 * ラベルと完全一致しない`[`始まりの文字列は、そのまま残す。
 *
 * このモジュールは他をimportしない（サーバー（/api/chat・/api/capture）とクライアント（ChatScreen）の両方から使う）。
 */

const LABEL_LENGTH = 22; // "[2026-09-21 19:37 JST]"
const DIGIT_INDEXES = new Set([1, 2, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16]);
const LITERALS: Record<number, string> = { 0: "[", 5: "-", 8: "-", 11: " ", 14: ":", 17: " ", 18: "J", 19: "S", 20: "T", 21: "]" };

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** `s`の`start`位置が、ラベルと一致（full）／ラベルの先頭部分と一致（partial：まだ判定できない）／不一致（none）。 */
function classify(s: string, start: number): "full" | "partial" | "none" {
  const rest = s.length - start;
  const n = Math.min(rest, LABEL_LENGTH);
  for (let i = 0; i < n; i++) {
    const ch = s[start + i];
    if (DIGIT_INDEXES.has(i) ? !(ch >= "0" && ch <= "9") : ch !== LITERALS[i]) return "none";
  }
  return rest >= LABEL_LENGTH ? "full" : "partial";
}

/** テキスト先頭の日時ラベル（連続していれば全て）と、その直後の空白・改行を取り除く。先頭以外は変更しない。 */
export function stripLeadingTimeLabels(text: string): string {
  let i = 0;
  let stripped = false;
  for (;;) {
    let j = i;
    while (j < text.length && isWhitespace(text[j])) j++;
    if (classify(text, j) !== "full") break;
    i = j + LABEL_LENGTH;
    while (i < text.length && isWhitespace(text[i])) i++;
    stripped = true;
  }
  return stripped ? text.slice(i) : text;
}

/** AIの最終的な返答本文の正規化（画面・保存・Captureへ渡す直前の防御）。 */
export function normalizeAiResponseText(text: string): string {
  return stripLeadingTimeLabels(text);
}

/**
 * ストリーミング表示用。先頭のラベルを取り除き、さらに、ラベルの途中（例：`[2026-09-21 19:`）までしか届いて
 * いない間は、その断片も表示しない（完成するか、ラベルではないと分かるまで待つ）。
 */
export function stripLeadingTimeLabelsForDisplay(text: string): string {
  const s = stripLeadingTimeLabels(text);
  let j = 0;
  while (j < s.length && isWhitespace(s[j])) j++;
  if (j < s.length && classify(s, j) === "partial") return "";
  return s;
}

/**
 * ストリーム用の除去器。先頭の日時ラベルだけを取り除き、複数チャンクに分割されていても対応する。
 * 先頭が`[`でも空白でもなければ、最初のチャンクで即座に判定を終える（通常の返答を余分にbufferしない）。
 * `[`で始まる場合も、ラベルと一致しない文字が来た時点で、溜めていた分をそのまま出す。
 */
export class LeadingTimeLabelStripper {
  private buffer = "";
  private decided = false;
  private strippedAny = false;

  push(chunk: string): string {
    if (this.decided) return chunk;
    this.buffer += chunk;
    return this.drain(false);
  }

  /** ストリーム終了時。未確定のまま残っていた分（ラベルになりきらなかった断片）を、そのまま出す。 */
  flush(): string {
    if (this.decided) return "";
    const out = this.drain(true);
    this.decided = true;
    return out;
  }

  private drain(final: boolean): string {
    let out = "";
    for (;;) {
      let s = this.buffer;
      let j = 0;
      while (j < s.length && isWhitespace(s[j])) j++;
      if (this.strippedAny) {
        // ラベルを取り除いた後の空白・改行は捨てる
        s = s.slice(j);
        this.buffer = s;
        j = 0;
      }
      if (j === s.length) {
        // 空、または空白だけ（ラベルを除去していなければ、次のチャンクまで待つ）
        if (final) {
          out += this.buffer;
          this.buffer = "";
        }
        return out;
      }
      const kind = classify(s, j);
      if (kind === "full") {
        this.buffer = s.slice(j + LABEL_LENGTH);
        this.strippedAny = true;
        continue;
      }
      if (kind === "partial") {
        if (final) {
          out += s;
          this.buffer = "";
          this.decided = true;
        }
        return out;
      }
      out += s;
      this.buffer = "";
      this.decided = true;
      return out;
    }
  }
}
