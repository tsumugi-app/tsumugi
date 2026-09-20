/**
 * 「過去からの問いかけ」（revisitPrompt）のTime Safety。
 *
 * revisitPromptは生成時に一度だけ作られ、MemoryObject.revisitPromptとして保存され、
 * 翌日以降もトップ画面に表示され、さらに開始したConversationのrole:"ai"発言としても使われる。
 * そのため、表示する日によって意味が変わる相対的な時間表現（「昨日」等）を含むまま保存・
 * 表示・送信されてはいけない。ここでは、その判定と、判定に基づく候補選定・入力整形を
 * 副作用の無い純粋関数として持つ（IndexedDB・fetch・Reactに依存しない）。
 *
 * 既存の保存済みpromptは削除・書き換えしない。unsafeなものは候補から除外するだけで、
 * 「未生成」とは扱わない（unsafeを理由に再生成APIを呼ばない）。
 */

/**
 * 固定の、狭い相対時間語彙。曖昧な正規表現にはしない（部分文字列の一致のみ）。
 * 「昨日」は「一昨日」、「明日」は「明後日」の一部ではないため、後者は別に持つ。
 * Event Timeの固定語彙（今日・昨日・一昨日・明日・明後日）と、週を単位とする表現、
 * 「この前」「最近」のような時期が不定の表現を対象にする。
 */
export const RELATIVE_TIME_TERMS: readonly string[] = [
  "昨日",
  "今日",
  "明日",
  "明後日",
  "先週",
  "今週",
  "来週",
  "この前",
  "最近",
  "きのう",
  "きょう",
  "あした",
];

/** テキストに含まれる相対時間語彙を1つ返す。含まれなければnull。 */
export function findRelativeTimeExpression(text: string): string | null {
  for (const term of RELATIVE_TIME_TERMS) {
    if (text.includes(term)) return term;
  }
  return null;
}

/** 空でなく、相対時間語彙を含まない場合のみtrue（保存・表示・送信のすべてで共通に使う）。 */
export function isSafeRevisitPromptText(text: string | undefined | null): text is string {
  return typeof text === "string" && text.trim().length > 0 && findRelativeTimeExpression(text) === null;
}

/**
 * LLMが返した問いかけを保存前に検証する。safeなら前後の空白を除いた文字列、unsafe・空なら
 * undefined。指示違反（「昨日」等を含む生成結果）はここで必ず落とし、再生成はしない。
 */
export function validateGeneratedRevisitPrompt(raw: string | undefined | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return isSafeRevisitPromptText(trimmed) ? trimmed : undefined;
}

export interface RevisitCandidateMemory {
  id: string;
  date: string;
  revisitPrompt?: string;
}

export interface RevisitCandidateSelection<T> {
  memory: T;
  /** trueの場合、このMemoryは未生成（revisitPromptが無い）。呼び出し元が1回だけ生成する。 */
  needsGeneration: boolean;
}

/**
 * 候補Memoryを段階的に緩めながら選ぶ。
 *
 * - safeなrevisitPromptを持つもの：そのまま表示できる（生成API 0回）。
 * - unsafeなrevisitPromptを持つもの：候補から除外する。保存データは変更しない。
 *   「未生成」とも扱わないため、unsafeしか無いMemoryは再生成の対象にもならない。
 * - revisitPromptを持たないもの（本当に未生成）：従来通り、safeな候補が無いときだけ
 *   1件を選んで生成する。
 *
 * tierの順序・意味は従来と同じ（単調に緩めるだけで、tierを跨いで戻らない）：
 * 1. safe持ち・直近5件未表示・当日生成でない
 * 2. safe持ち・直前1件だけは避ける
 * 3. safe持ちなら何でもよい
 * 4. 未生成・当日生成でない
 * 5. 未生成なら何でもよい
 */
export function selectRevisitCandidate<T extends RevisitCandidateMemory>(
  all: T[],
  lastPromptedIds: string[],
  isToday: (dateISO: string) => boolean,
  pick: (items: T[]) => T | undefined
): RevisitCandidateSelection<T> | undefined {
  const excludedRecent = new Set(lastPromptedIds);
  const mostRecentId = lastPromptedIds[lastPromptedIds.length - 1];

  const withSafePrompt = all.filter((memory) => isSafeRevisitPromptText(memory.revisitPrompt));
  const withoutPrompt = all.filter((memory) => !memory.revisitPrompt);

  const tier1 = withSafePrompt.filter((memory) => !excludedRecent.has(memory.id) && !isToday(memory.date));
  const picked1 = pick(tier1);
  if (picked1) return { memory: picked1, needsGeneration: false };

  const tier2 = withSafePrompt.filter((memory) => memory.id !== mostRecentId);
  const picked2 = pick(tier2);
  if (picked2) return { memory: picked2, needsGeneration: false };

  const picked3 = pick(withSafePrompt);
  if (picked3) return { memory: picked3, needsGeneration: false };

  const tier4 = withoutPrompt.filter((memory) => !isToday(memory.date));
  const picked4 = pick(tier4);
  if (picked4) return { memory: picked4, needsGeneration: true };

  const picked5 = pick(withoutPrompt);
  if (picked5) return { memory: picked5, needsGeneration: true };

  return undefined;
}

export interface RevisitPromptSourceMemory {
  summary: string;
  content: string;
  keywords: string[];
  /** 記録日（Memory.date）。出来事の日時ではない。 */
  date?: string;
  eventTime?: string;
  eventTimePrecision?: string;
}

const EVENT_TIME_PATTERN: Record<string, RegExp> = {
  day: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-\d{2}$/,
  year: /^\d{4}$/,
};

/**
 * LLMへ渡す「出来事日時」の説明文。precisionと形式が矛盾する値・precisionの無い値は
 * 採用しない（無い場合と同じ扱い）。精度が粗い場合に存在しない精度（月精度で日、年精度で月）
 * を補わせない。Event Timeが無い場合、記録日から出来事日時を推測させない。
 */
export function describeEventTimeForRevisitPrompt(
  eventTime: string | undefined,
  precision: string | undefined
): string {
  const pattern = precision ? EVENT_TIME_PATTERN[precision] : undefined;
  if (!eventTime || !precision || !pattern || !pattern.test(eventTime)) {
    return "不明（記録日から出来事の日時を推測しない。日付・時期を書かない）";
  }
  if (precision === "day") {
    return `${eventTime}（日精度。この日付を「YYYY年M月D日」のような絶対日付で書いてよい）`;
  }
  if (precision === "month") {
    return `${eventTime}（月精度。日は不明。「YYYY年M月」まで。日を補わない）`;
  }
  return `${eventTime}（年精度。月日は不明。「YYYY年」まで。月日を補わない）`;
}

/** /api/promptがLLMへ渡すMemory情報。記録日と出来事日時は別の行として区別する。 */
export function buildRevisitPromptRecord(memory: RevisitPromptSourceMemory): string {
  const recordDate = memory.date ? memory.date.slice(0, 10) : "不明";
  const keywords = memory.keywords.length > 0 ? memory.keywords.join(", ") : "なし";
  return [
    `記録日: ${recordDate}（Tsumugiに保存された日。出来事が起きた日とは限らない）`,
    `出来事日時: ${describeEventTimeForRevisitPrompt(memory.eventTime, memory.eventTimePrecision)}`,
    `要約: ${memory.summary}`,
    `内容: ${memory.content}`,
    `キーワード: ${keywords}`,
  ].join("\n");
}
