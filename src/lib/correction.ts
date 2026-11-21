/**
 * N6 訂正優先（案B、オーナー承認 2026-11-21）: 本人が過去の記録の理由・解釈を言い直した（訂正した）
 * という関係を、コードだけで検出して保存し、会話・Timeline・Synthesis が読むための土台。
 *
 * なぜ必要か: 「後から本人が言い直した」という関係は、従来は保存・選択・提示のどこにも無かった。
 * そのため、話題の語が今の発言に無い記録リクエストでは、訂正前の AI の解釈（Reflection）だけが
 * 材料に届き、本人の訂正が届かないまま「本人の理由」として記録されてしまうことがあった（N6）。
 *
 * 設計（オーナー条件）:
 * 1. 訂正と「時間による変化」は区別する。以前はそうだったが今は違う、という変化は訂正ではない。
 *    過去の状態を当時の事実として認める言い方（前は〜／当時は〜）や、気持ちの変化の言い方
 *    （〜ようになった等）を含む文は、訂正の目印（本当は等）を含んでいても訂正にしない。
 * 2. 対象は (a) AI の解釈（Reflection、`system-generated`）か、(b) 理由を述べた本人の記録
 *    （既存の statesOwnReason の定義どおり）だけ。理由の追加（〜だけじゃなくて〜も／あと、等）は
 *    訂正ではない。迷ったらリンクを作らない（従来の挙動のままになる）。
 *    さらに精度条件として、訂正文が対象の理由・解釈に実際に触れていること（engagesReason）を
 *    要求する。同じ話題の別の事実（日付等）の訂正は、理由の記録を打ち消さない。
 * 3. 対象の本文は一切書き換えない。リンクは訂正した側の Memory の `corrections`（追加のみの
 *    optional フィールド）にだけ付く。古い Vault（フィールド無し）は従来どおり。
 *
 * 検出は Capture の保存時だけ（lib/capture.ts が新規 Memory に対して呼ぶ）。AI は呼ばない。
 * ここにあるのは検出・検証・索引だけ。消費（会話の選択への反映）は retrieval.ts、
 * Timeline の根拠の除外は memorySynthesis.ts が、それぞれ最小の範囲で行う。
 */
import type { MemoryCorrection, MemoryObject } from "./types";
import { CORRECTION_FORM, REASON_FORM } from "./personStance";
import { isReflectionSource, sentences, statesOwnReason } from "./recordRelevance";
import { isQuestionText } from "./explicitReason";
import { isQuestionFormTerm } from "./recallQuestion";

/** 1つの Memory に付ける訂正リンクの上限（安全側の天井。通常は1〜2件） */
export const MAX_CORRECTIONS_PER_MEMORY = 3;
const MAX_STORED_CORRECTIONS = 8;
const CORRECTION_QUOTE_MAX_CHARS = 200;

const timeOf = (memory: Pick<MemoryObject, "statedAt" | "date">): number => {
  const t = Date.parse(memory.statedAt ?? memory.date);
  return Number.isFinite(t) ? t : 0;
};

/** 過去の状態を「当時はそうだった」と認める言い方（変化の目印） */
const PAST_ANCHOR = /前は|以前は|前まで|当時は|その頃は|昔は|あの頃は/;
/** 気持ち・考えの変化そのものの言い方（強い訂正の目印が無ければ変化とみる） */
const FEELING_CHANGE = /ようになった|ようになっ|変わった|変わって|変化した|気持ちが変わ|考えが変わ/;
/** 内容そのものへの明示的な訂正（変化の言い方と一緒でも訂正として扱う強い目印） */
const STRONG_CORRECTION = /訂正|言い直|間違いで|じゃなくて|ではなく|言ったのは/;
/** 理由・事情の追加の言い方（訂正ではない） */
const ADDITION_FORM = /だけじゃなくて|だけではなく|もう一つ|もうひとつ|あと一つ|あとひとつ|加えて|それと|ちなみに|追加で|(?:^|[、,])あと[、,]|(?:^|[、,])後[、,]/;

/**
 * その文が「時間による変化」を述べているか。過去を認める言い方（前は〜）は、直後が発言への
 * 言及（〜って言った）のときだけ「言った内容」への訂正でありうるので、変化とみなさない。
 */
function isChangeMarked(sentence: string): boolean {
  const anchor = PAST_ANCHOR.exec(sentence);
  if (anchor) {
    const after = sentence.slice(anchor.index + anchor[0].length, anchor.index + anchor[0].length + 14);
    if (!/言っ|話し|答え/.test(after)) return true;
  }
  if (FEELING_CHANGE.test(sentence) && !STRONG_CORRECTION.test(sentence)) return true;
  return false;
}

/**
 * 訂正専用の目印（CORRECTION_FORM から「というのも」を除いたもの）。「というのも」は理由の
 * 説明の言い方で、同じ理由を繰り返しただけでも当たってしまう（Codex レビュー on PR #63）。
 * 理由の配送では目印として有用でも、「打ち消し」の根拠にはならないため、ここでは使わない。
 */
const CORRECTION_SPECIFIC = /本当は|ほんとうは|というより|っていうより|じゃなくて|ではなくて|ではなく[、,]|(?:と|って)言ったのは|言い直す|訂正|間違いで/;

/** 本人の逐語の中で、訂正と断定できる文（疑問文・変化・追加を除く）。無ければ空配列 */
function correctionSentencesOf(memory: Pick<MemoryObject, "evidenceQuotes">): string[] {
  const out: string[] = [];
  for (const quote of memory.evidenceQuotes ?? []) {
    if (typeof quote !== "string") continue;
    for (const sentence of sentences(quote)) {
      if (isQuestionText(sentence)) continue;
      if (!CORRECTION_FORM.test(sentence)) continue;
      if (!CORRECTION_SPECIFIC.test(sentence)) continue;
      if (isChangeMarked(sentence)) continue;
      if (ADDITION_FORM.test(sentence)) continue;
      out.push(sentence);
    }
  }
  return out;
}

const themeKeywords = (memory: Pick<MemoryObject, "keywords">): string[] =>
  (memory.keywords ?? []).filter((k): k is string => typeof k === "string" && Array.from(k.trim()).length >= 2 && !isQuestionFormTerm(k.trim())).map((k) => k.trim());

/** 2つの記録が同じ話題か（同じ topicId、または質問形でないキーワードの共有）。話題の一致の判定はこれだけ（類義語は広げない） */
export function shareThemeKeyword(a: Pick<MemoryObject, "keywords" | "topicId">, b: Pick<MemoryObject, "keywords" | "topicId">): boolean {
  if (a.topicId && b.topicId && a.topicId === b.topicId) return true;
  const own = new Set(themeKeywords(a));
  return themeKeywords(b).some((k) => own.has(k));
}

function sharesTheme(correcting: MemoryObject, target: MemoryObject, sentence: string): boolean {
  if (shareThemeKeyword(correcting, target)) return true;
  // 訂正の文そのものが対象のキーワードを含む（訂正側のキーワードに話題語が残っていない場合の受け皿）
  return themeKeywords(target).some((k) => sentence.includes(k));
}

/**
 * 訂正文が、対象の「理由・解釈」に実際に触れているか（精度条件。第2ラウンドで追加）。
 * 話題の共有だけでは足りない: 同じ話題の別の事実（日付・金額など）の訂正が、無関係な
 * 理由記録を打ち消してしまう誤検出を防ぐ（Codex 再レビュー on PR #63）。
 * 次のどちらかが必要:
 * - 訂正文自体が理由を述べ直している（REASON_FORM: 〜からだ／理由は〜 等）。
 * - 訂正文が、対象固有のキーワード（訂正側と共有しない語＝古い理由の内容語）を名指ししている
 *   （例:「お金の不安じゃなくて、…」は対象の「お金」を含む）。
 * どちらも無ければ、その訂正は別の事実に向けられたものとみなし、リンクしない（安全側）。
 */
function engagesReason(sentence: string, correcting: MemoryObject, target: MemoryObject): boolean {
  if (REASON_FORM.test(sentence)) return true;
  const ownKeys = new Set(themeKeywords(correcting));
  return themeKeywords(target).some((k) => !ownKeys.has(k) && sentence.includes(k));
}

/**
 * 新しく保存される Memory が、過去のどの記録を訂正しているか（コードのみ・決定的）。
 * 対象の条件を全て満たすものだけ: 別の会話の記録／訂正より前に述べられた記録／AI の解釈か
 * 理由を述べた本人の記録／訂正と話題を共有。1件の訂正文が複数の対象に当たることはある
 * （本人の理由と、それを読んだ AI の解釈の両方）。新しい対象から先に、上限まで。
 */
export function detectMemoryCorrections(memory: MemoryObject, pool: readonly MemoryObject[], opts: { newId: () => string; recordedAt?: string }): MemoryCorrection[] {
  const correctionSentences = correctionSentencesOf(memory);
  if (correctionSentences.length === 0) return [];
  if (!memory.conversationId) return [];
  const statedAt = memory.statedAt ?? memory.date;
  const targets = pool
    .filter(
      (target) =>
        target.id !== memory.id &&
        typeof target.conversationId === "string" &&
        target.conversationId.length > 0 &&
        target.conversationId !== memory.conversationId &&
        timeOf(target) < timeOf(memory) &&
        (isReflectionSource(target) || statesOwnReason(target))
    )
    .sort((a, b) => timeOf(b) - timeOf(a));
  const out: MemoryCorrection[] = [];
  for (const target of targets) {
    const sentence = correctionSentences.find((s) => sharesTheme(memory, target, s) && engagesReason(s, memory, target));
    if (!sentence) continue;
    out.push({
      id: opts.newId(),
      targetMemoryId: target.id,
      quote: Array.from(sentence).slice(0, CORRECTION_QUOTE_MAX_CHARS).join(""),
      statedAt,
      sourceConversationId: memory.conversationId,
      recordedAt: opts.recordedAt ?? statedAt,
      schemaVersion: 1,
    });
    if (out.length >= MAX_CORRECTIONS_PER_MEMORY) break;
  }
  return out;
}

const isValidIso = (v: unknown): v is string => typeof v === "string" && v.length > 0 && Number.isFinite(Date.parse(v));

/** 保存済み（Markdown・IndexedDB）の corrections を検証して読み込む。壊れた項目は、その項目だけ捨てる（例外を投げない）。 */
export function sanitizeStoredCorrections(raw: unknown, selfId?: string): MemoryCorrection[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryCorrection[] = [];
  for (const item of raw) {
    if (out.length >= MAX_STORED_CORRECTIONS) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const m = item as Record<string, unknown>;
    if (
      typeof m.id !== "string" || !m.id ||
      typeof m.targetMemoryId !== "string" || !m.targetMemoryId ||
      (selfId !== undefined && m.targetMemoryId === selfId) ||
      typeof m.quote !== "string" || !m.quote.trim() ||
      !isValidIso(m.statedAt) ||
      typeof m.sourceConversationId !== "string" || !m.sourceConversationId ||
      !isValidIso(m.recordedAt) ||
      m.schemaVersion !== 1
    ) {
      continue;
    }
    out.push({
      id: m.id,
      targetMemoryId: m.targetMemoryId,
      quote: Array.from(m.quote.trim()).slice(0, CORRECTION_QUOTE_MAX_CHARS).join(""),
      statedAt: m.statedAt,
      sourceConversationId: m.sourceConversationId,
      recordedAt: m.recordedAt,
      schemaVersion: 1,
    });
  }
  return out;
}

export interface CorrectionLink {
  correction: MemoryCorrection;
  /** 訂正を述べた側の Memory */
  correcting: MemoryObject;
}

/**
 * 今ある記録全体から「打ち消された記録 → 最新の訂正」の索引を作る。
 * 対象が実在しないリンク（対象が削除された等）は索引に入らない。同じ対象への訂正が
 * 複数あれば、最も新しい訂正だけが効く（古い訂正で新しい訂正を上書きしない）。
 */
export function correctionIndexOf(pool: readonly MemoryObject[]): Map<string, CorrectionLink> {
  const ids = new Set(pool.map((m) => m.id));
  const index = new Map<string, CorrectionLink>();
  for (const correcting of pool) {
    for (const correction of sanitizeStoredCorrections(correcting.corrections, correcting.id)) {
      if (!ids.has(correction.targetMemoryId)) continue;
      const prev = index.get(correction.targetMemoryId);
      if (!prev || Date.parse(correction.statedAt) >= Date.parse(prev.correction.statedAt)) {
        index.set(correction.targetMemoryId, { correction, correcting });
      }
    }
  }
  return index;
}

/** 会話の発言（連結済みテキスト）に、この訂正の話題の語が出ているか（訂正側・対象側どちらのキーワードでもよい） */
export function correctionThemeInText(correcting: MemoryObject, targets: readonly MemoryObject[], text: string): boolean {
  const keys = [...themeKeywords(correcting), ...targets.flatMap((t) => themeKeywords(t))];
  return keys.some((k) => text.includes(k));
}

/** 記録・整理のリクエストか（chat route の looksLikeRecordRequest と同じ語彙。会話側の選択でも同じ判定が要るための複製） */
export function isRecordRequestTurn(text: string): boolean {
  return /記録/.test(text) || /整理して.*(残し|おき|欲し)/.test(text);
}
