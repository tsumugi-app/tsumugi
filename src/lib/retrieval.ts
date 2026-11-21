/**
 * Retrieval Engine（ARCHITECTURE.md「Retrieval Engine」層）。
 *
 * ローカルのIndexedDBのみを対象に検索し、AIを一切呼ばない。
 * REQUIREMENTS.md 4.2「全記憶をAIに渡さない」を担保する層であり、
 * ここで少数（既定3件）に絞ってから初めて /api/chat がAIへ渡す。
 *
 * スコア軸は3つ。person/theme/emotion（Entity）軸は、Connect（Phase 2, ROADMAP.md）が
 * 実際にIDを埋め始めるまで常に0を返すスタブとして用意してあり、
 * 将来データが入り次第このファイルの他の場所を変更せずに稼働し始める。
 *
 * 直接一致（キーワード/bigram）で候補が埋まらない場合に限り、直接一致した記憶が持つ
 * Link（Connectが生成したMemory-to-Memory Link）を1-hopだけ辿り、最大`maxLinkedAdditions`件を補う
 * （ARCHITECTURE.mdのSearch Strategy優先度2「リンクされた記憶」に対応）。
 * 通常会話では既定`MAX_LINKED_ADDITIONS=1`件、明示的Reflection時のみ
 * `REFLECTIVE_MAX_LINKED_ADDITIONS=2`件まで（Memory Editing最小実装、MEMORY_ENGINE.md 6章）。
 * 選ばれたLink経由の記憶にはそれぞれ`RetrievedMemory.linkReason`として`Link.reason`を付与する
 * （直接一致の記憶には付かない）。axis/contrast/strengthは渡さない。
 *
 * 明示的Reflection（REQUIREMENTS.md 3.6 / UI_UX.md「Reflection」、ROADMAP.md Phase 2）。
 * ユーザーが能動的に過去を振り返るような問いを投げたときだけ、直接一致の`limit`とLink経由の
 * 上限を広げる。判定はAIを呼ばないローカルなキーワード一致のみで行う（`isReflectiveQuery`）。
 * スコアリング式・通常会話時の`MAX_LINKED_ADDITIONS`・`linkReason`の型は一切変更しない。
 * セッション終了時の既存Reflection（`/api/reflect`, `generateSessionReflection`）とは無関係。
 */
"use client";

import { getAllMemoryObjects, getMemoryObject } from "./db";
import { withVaultWorldRead } from "./vaultWorldLock";
import type { MemoryObject, Persona, RetrievedMemory } from "./types";
import { limitMemoryQuotes, memoryContextOf } from "./memoryContext";
import type { ReflectionTrace } from "./chatContextProvenance";
import { isTopicKeyword, matchRecallTopic, recallTopicOf, withPoolEvidence, type RecallTopic } from "./recallQuestion";
import { adjustForPurpose, asksPersonChange, isRecallOnlyRecord, purposeContextOf, recordTraitOf, sentences, type PurposeContext } from "./recordRelevance";
import { correctionIndexOf, correctionThemeInText, isRecordRequestTurn, shareThemeKeyword } from "./correction";

/** capture.ts側の候補スコア閾値の根拠としても参照する（1キーワード一致分の重み）。 */
export const KEYWORD_WEIGHT = 3;
const TEXT_WEIGHT = 5;
/** capture.ts側の候補件数上限の既定値としても参照する（通常会話の直接一致と同じ基準）。 */
export const DEFAULT_LIMIT = 3;
/** 直接一致で埋まらなかった枠を補う、Link経由の記憶の最大追加件数（通常会話）。 */
const MAX_LINKED_ADDITIONS = 1;
/**
 * クリエイト（analyst）専用。直接関連するMemoryだけでなく、あえて時間的に遠い・
 * 独自語を含むMemoryも一定数混ぜる（発想の飛躍の材料にするため）。件数は固定値。
 */
const CREATIVE_DIVERGENT_COUNT = 3;
/** Link経由の記憶の最大追加件数（明示的Reflection時のみ）。Memory Editing最小実装。呼び出し元（ChatScreen.tsx）が使う。 */
export const REFLECTIVE_MAX_LINKED_ADDITIONS = 2;
/** 明示的Reflectionと判定された場合にのみ使う、直接一致の拡大limit。呼び出し元（ChatScreen.tsx）が使う。 */
export const REFLECTIVE_LIMIT = 6;

/** 想起を促す語（前提として過去に触れている） */
const REFLECTIVE_RECALL_WORDS = ["前に", "以前", "これまで", "昔", "過去に", "過去の"];
/** 抽象化・パターン把握を求める語（これ単体でも反射的な問いとみなす） */
const REFLECTIVE_PATTERN_WORDS = ["パターン", "傾向", "繰り返し", "共通点"];
/** 疑問形の目安（記号だけでなく、日本語の口語的な疑問表現も含む） */
const QUESTION_MARKERS = ["？", "?", "かな", "だろう", "かしら", "ますか", "ある？"];

/**
 * ユーザーの発言が「明示的な振り返りの問い」らしいかを、ローカルの文字列マッチだけで判定する。
 * AIは呼ばない（判定のための追加AI呼び出しを増やさないため）。
 * 形態素解析は行わず、既存のbigramスコアリングと同じ「MVPとしての割り切り」を踏襲する
 * （完璧な意図判定はできない前提。誤検出は許容する）。
 *
 * - 想起語（前に／以前 等）＋ 疑問形の組み合わせ、または
 * - パターン・傾向を問う語（単体で成立）
 * のいずれかを満たす場合にtrueを返す。
 */
export function isReflectiveQuery(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (REFLECTIVE_PATTERN_WORDS.some((word) => trimmed.includes(word))) {
    return true;
  }

  const hasRecallWord = REFLECTIVE_RECALL_WORDS.some((word) => trimmed.includes(word));
  const hasQuestionMarker = QUESTION_MARKERS.some((marker) => trimmed.includes(marker));
  return hasRecallWord && hasQuestionMarker;
}

function toBigrams(text: string): Set<string> {
  const chars = Array.from(text.replace(/\s+/g, ""));
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) {
    grams.add(chars[i] + chars[i + 1]);
  }
  return grams;
}

/**
 * 日本語は分かち書きされないため、形態素解析の代わりに文字bi-gramの重なり率を使う。
 * MeCab等の辞書付きトークナイザは導入しない（MVPとしての複雑さを避けるため）。
 */
function bigramOverlap(a: string, b: string): number {
  const setA = toBigrams(a);
  const setB = toBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const gram of setA) {
    if (setB.has(gram)) shared += 1;
  }
  return shared / Math.min(setA.size, setB.size);
}

/**
 * 会話の画面のcompanion/coachだけ（`purposeRelevance`を渡す呼び出し）。キーワード・話題・人物のどれにも一致せず、最低点にも届かない弱い記録を、
 * 文字の重なりだけで選んでよいか。scoreMemoryのスコア自体は変えず、選ぶかどうかの根拠だけを確かめる。
 *
 * 根拠になるのは、発言の中の、記録の要約に「そのまま含まれる」続いた文字列（sharedTextRuns）だけ:
 * - 句読点・記号・空白をまたがない（「言い直し、」と「いいし、」の「し、」は根拠にしない）
 * - 端の助詞は、漢字・カタカナ・英数字と接しているときだけ1文字除く（「旅行をやめた」の「を」、「理由を」の「を」。「にでかけ」の「で」は語の一部として残す）
 * - 3文字以上（「たい」「理由」だけの一致では選ばない。「さみし」「でかけ」「やめた」は残る）
 * - 記録の集合の中で珍しい：その文字列を含む記録が max(5件, 全体の2割) 未満（「と話した」のような多くの記録にある言い回しは根拠にしない）。
 *   小さい集合でも、よく話す話題（3〜4件の記録）は根拠に残す。大きい集合では2割未満の言い回しも珍しい扱いになる（今後の関連度の課題）
 * 文字の種類（漢字・ひらがな）だけでは決めない。語や話題の名前は書かない。
 */
const WEAK_RUN_BREAK = /[\s、。，．,.・！？!?「」『』（）()［］\[\]【】〈〉《》〔〕｛｝{}"'“”‘’…‥〜～:：;；\/／\\＼|｜\-－―＋+＝=＊*＆&＃#＠@％%＄$￥¥^＾_＿<>＜＞★☆○●◎◇◆□■△▲▽▼♪※→←↑↓]/;
const WEAK_RUN_EDGE_PARTICLE = /^[をがはのにでともへ]$/;
const HIRAGANA = /^[\u3041-\u309f]$/;
/** a character that carries content on its own (kanji, katakana, letters, digits): not hiragana, not punctuation */
const isContentChar = (c: string | undefined) => c !== undefined && !HIRAGANA.test(c) && !WEAK_RUN_BREAK.test(c);
/** a reason word, never the topic of a reason question */
const REASON_WORD = /^(?:理由|なぜ|何故|どうして|なんで|わけ|訳)$/;
/**
 * the recall topic terms inside the subject of a reason question. When none is inside it (the subject is only an opener: 「そっか、なんで転職を…」),
 * the terms without the reason words (independent review on this PR). null when nothing is left
 */
const subjectTermsOf = (topic: RecallTopic | null, subject: string): RecallTopic | null => {
  if (!topic) return null;
  const inSubject = topic.terms.filter((term) => subject.includes(term));
  const terms = inSubject.length > 0 ? inSubject : topic.terms.filter((term) => !REASON_WORD.test(term));
  return terms.length > 0 ? { terms } : null;
};
export const WEAK_RUN_MIN_CHARS = 3;
const WEAK_RUN_COMMON_RECORDS = 5;
const WEAK_RUN_COMMON_SHARE = 0.2;
export function sharedTextRuns(query: string, memoryText: string): string[] {
  const text = memoryText.replace(/\s+/g, "");
  const chars = Array.from(query.replace(/\s+/g, ""));
  const runs: string[] = [];
  let p = 0;
  while (p < chars.length - 1) {
    if (WEAK_RUN_BREAK.test(chars[p])) { p += 1; continue; }
    // the longest piece from p that the record contains as it is (not a chain of bigrams found in different places)
    let len = 1;
    while (p + len < chars.length && !WEAK_RUN_BREAK.test(chars[p + len]) && text.includes(chars.slice(p, p + len + 1).join(""))) len += 1;
    if (len < 2) { p += 1; continue; }
    let piece = chars.slice(p, p + len);
    if (WEAK_RUN_EDGE_PARTICLE.test(piece[0]) && isContentChar(chars[p - 1])) piece = piece.slice(1);
    if (piece.length >= 2 && WEAK_RUN_EDGE_PARTICLE.test(piece[piece.length - 1]) && isContentChar(piece[piece.length - 2])) piece = piece.slice(0, -1);
    if (piece.length >= WEAK_RUN_MIN_CHARS) runs.push(piece.join(""));
    p += len - 1;
  }
  return runs;
}
const runCounts = new WeakMap<readonly string[], Map<string, number>>();
/** how many records of the pool contain the run (cached per pool for the turn) */
function poolCount(run: string, poolTexts: readonly string[]): number {
  let counts = runCounts.get(poolTexts);
  if (!counts) { counts = new Map(); runCounts.set(poolTexts, counts); }
  let n = counts.get(run);
  if (n === undefined) { n = poolTexts.filter((t) => t.includes(run)).length; counts.set(run, n); }
  return n;
}
/** the shared runs of a weak record that are not common in the pool */
export function distinctSharedRuns(query: string, memory: MemoryObject, poolTexts: readonly string[]): string[] {
  const common = Math.max(WEAK_RUN_COMMON_RECORDS, Math.ceil(poolTexts.length * WEAK_RUN_COMMON_SHARE));
  return sharedTextRuns(query, `${memory.summary} ${memory.content}`).filter((run) => poolCount(run, poolTexts) < common);
}
export const hasDistinctSharedRun = (query: string, memory: MemoryObject, poolTexts: readonly string[]) => distinctSharedRuns(query, memory, poolTexts).length > 0;
/**
 * a reason question about a past act (「旅行をやめたのは、雨のせいだったのかな？」): a weak record counts only through a distinct run inside the act asked
 * about (the subject) that has a kanji / katakana / letter / digit (「未来がないと言った理由は？」 keeps 「…未来がないと話した」; 「やめた」 alone does not
 * tie 「転職をやめた」 to 「旅行をやめた」; the reason put forward, 「雨のせい」「さみしい」, never counts)
 */
export const hasSubjectRun = (memory: MemoryObject, poolTexts: readonly string[], subject: string) =>
  // the runs are taken from the subject itself: a longer run of the whole question (「スパイスを買ったのは」) still ties the act (Codex on this PR)
  // two or more kanji / katakana / letters / digits: one kanji with its ending (「買った」) is not a tie (single characters never count)
  distinctSharedRuns(subject, memory, poolTexts).some((run) => Array.from(run).filter((c) => isContentChar(c)).length >= 2);

/**
 * Entity（person/theme/emotion）軸のスコアラー。
 * MemoryObject.themeIds等はPhase 1では常に空配列（Connect未実装）であることに加え、
 * クエリ文字列側からEntityを抽出する仕組みも無いため、現時点では計算しようが無い。
 * Phase 2でConnectとクエリ側のEntity抽出が揃った時点で、この関数の中身だけ差し替える。
 */
function entityScore(): number {
  return 0;
}

/** 通常の関連度スコア（キーワード一致＋bigram重なり）。既存のretrieveRelevantMemoriesと
 * クリエイト専用のretrieveCreativeMemoriesの両方から使う、挙動を変えない共通処理。
 * capture.ts（別Conversationからの類似Memory候補探し）からも読み取り専用で再利用する。
 * ロジック自体はここでは変更しない。 */
export function scoreMemory(memory: MemoryObject, trimmed: string): number {
  const keywordHits = memory.keywords.filter((keyword) => keyword && trimmed.includes(keyword)).length;
  const textOverlap = bigramOverlap(trimmed, `${memory.summary} ${memory.content}`);
  return keywordHits * KEYWORD_WEIGHT + textOverlap * TEXT_WEIGHT + entityScore();
}

/**
 * クリエイト専用。「遠いMemory」を選ぶための補助スコアラー群。
 * 形態素解析・固有名詞抽出は導入せず（MVPとしての割り切りを踏襲）、
 * 「keywordがコーパス全体でどれだけ珍しいか」を独自語らしさの代理指標として使う。
 */
export function computeKeywordFrequency(all: MemoryObject[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const memory of all) {
    for (const keyword of memory.keywords) {
      if (!keyword) continue;
      freq.set(keyword, (freq.get(keyword) ?? 0) + 1);
    }
  }
  return freq;
}

/** keywordsの中で最も珍しい（コーパス内での出現回数が少ない）ものほど高スコアにする。 */
function distinctivenessScore(memory: MemoryObject, freq: Map<string, number>): number {
  if (memory.keywords.length === 0) return 0;
  const freqs = memory.keywords.map((keyword) => freq.get(keyword) ?? 1);
  return 1 / Math.min(...freqs);
}

function daysAgo(dateISO: string): number {
  return (Date.now() - new Date(dateISO).getTime()) / (24 * 60 * 60 * 1000);
}

/** 90日分を上限に0〜3のスケールへ正規化し、distinctivenessScoreと同じ程度の重みで足し合わせられるようにする。 */
function ageScore(dateISO: string): number {
  return Math.min(daysAgo(dateISO) / 30, 3);
}

/** 重複無しでn件をランダムに選ぶ（候補が少なければ全件返す）。完全な均一ランダムではなく、
 * 呼び出し元が事前に「遠さ」で絞り込んだ候補集合の中からだけ選ぶために使う。 */
function pickRandomN<T>(items: T[], n: number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (pool.length > 0 && picked.length < n) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

/**
 * クリエイト（analyst）専用の「遠いMemory」選定。直接一致からは外れた候補の中から、
 * 独自語らしさ（distinctivenessScore）＋時間的な遠さ（ageScore）が高いものを広めに
 * ショートリストし、その中からランダムにcount件選ぶ（完全ランダムにはしない）。
 */
function selectDivergentMemories(
  candidates: MemoryObject[],
  keywordFrequency: Map<string, number>,
  count: number
): MemoryObject[] {
  if (candidates.length === 0 || count <= 0) return [];
  const scored = candidates
    .map((memory) => ({
      memory,
      score: distinctivenessScore(memory, keywordFrequency) + ageScore(memory.date),
    }))
    .sort((a, b) => b.score - a.score);
  const shortlist = scored.slice(0, Math.max(count * 3, 6)).map((entry) => entry.memory);
  return pickRandomN(shortlist, count);
}

/**
 * 「同じConversationから生まれた記憶だから除外する」判定。excludeConversationIdは
 * 呼び出し元（Connect）が「今回追加された記憶自身のconversationId」を渡す仕組みのため、
 * これがundefined＝Conversationを持たない記憶（将来のimport等）である場合は、
 * 「同じConversationに属する」という概念自体が存在しない。単純に
 * `conversationId !== excludeConversationId`で比較すると、比較対象双方が
 * undefined同士のときにtrueとみなされてしまい（`undefined !== undefined`はfalse＝除外）、
 * Conversationを持たない記憶同士が「たまたま両方Conversation無し」というだけで
 * 永久に除外され合う不具合になる。excludeConversationIdがundefinedのときは
 * この基準による除外を一切行わない（conversationIdの有無に関わらずfalseを返す）ことで、
 * Conversationありの記憶同士の既存の除外挙動は変えずに、この不具合だけを解消する。
 * capture.ts（別Conversationからの類似Memory候補探し）からも読み取り専用で再利用する。
 */
export function isSameConversation(conversationId: string | undefined, excludeConversationId: string | undefined): boolean {
  return excludeConversationId !== undefined && conversationId === excludeConversationId;
}

/**
 * Retrievalのノイズ抑制（Conversation品質改善 第1修正）。
 *
 * 「候補があれば上限件数まで機械的に埋める」のではなく、1位の候補との相対的な強さを見て、
 * 弱い候補は最初から返さない。1位が圧倒的に強く2位以降が大きく劣る場合は1件だけ、
 * 2位・3位が1位に近い強さを持つ場合はそのまま複数件を返す。既存のscoreMemory自体は
 * 変更しない（スコアの計算方法ではなく、計算済みスコアの「使い方」だけを変える）。
 *
 * ルール（意図的に単純にしてある。説明可能であることを優先）：
 * - 1位（最高スコア）は、score > 0 である限り常に残す。
 * - 2位以降は、そのスコアが「1位のスコア × DIRECT_RELATIVE_KEEP_RATIO」以上の場合だけ残す。
 *   例：1位が8.88点なら、2位以降は4.44点未満（8.88の半分未満）なら落とす。
 * - 候補が1件も無い（score > 0が1件も無い）場合は空配列を返す（0件は正常な結果）。
 *
 * 実データでの確認（PC）：8.88 / 2.88 / 2.12 → 2.88, 2.12 はどちらも8.88の半分(4.44)未満のため
 * 1位だけが残る。（スマホ）：8.73 / 1.52 / 1.52 → 同様に1位だけが残る。
 * 一方、1位・2位が近い強さ（例：8 / 7 / 6）の場合は3件とも残る。
 *
 * companion/coachが使うretrieveRelevantMemories本体のロジックには一切手を加えない
 * （このフィルタはretrieveCreativeMemories＝analyst専用の経路にだけ適用する）。
 */
export const DIRECT_RELATIVE_KEEP_RATIO = 0.5;

/**
 * pool（対象Memory群）を既存のscoreMemoryでスコアリングし、スコア>0のものを降順ソートして
 * 上位limit件までに絞る（相対的な強さでの絞り込みはまだ行わない、単なる「候補集め」の段階）。
 * retrieveCreativeMemoriesの内部処理を、ConversationDebugでの再利用のために独立した
 * 関数として切り出しただけで、計算内容自体は変更していない。
 */
export function scoreDirectCandidates(
  pool: MemoryObject[],
  trimmed: string,
  limit: number
): { memory: MemoryObject; score: number }[] {
  return pool
    .map((memory) => ({ memory, score: scoreMemory(memory, trimmed) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * scoreDirectCandidates()が返した「上位limit件」の中から、1位との相対的な強さで
 * さらに絞り込む（上のファイル冒頭コメント参照）。sortedScoredはスコア降順である前提。
 */
export function applyRelativeStrengthFilter(
  sortedScored: { memory: MemoryObject; score: number }[]
): { memory: MemoryObject; score: number }[] {
  if (sortedScored.length === 0) return [];
  const topScore = sortedScored[0].score;
  return sortedScored.filter((entry, index) => index === 0 || entry.score >= topScore * DIRECT_RELATIVE_KEEP_RATIO);
}

/**
 * Conversation Retrieval（Conversation品質改善 第2修正）。
 *
 * 「候補同士の相対的な強さ」（applyRelativeStrengthFilter）だけでは、1位の候補自体が
 * 「時間」「自分」のような一般語の偶然の一致だけでfalse positiveになるケースを防げない
 * （調査ラウンドで実データから確認済み：1位は常に無条件採用される設計のため）。
 * このセクションは、既存のscoreMemory()自体は一切変更せず、その計算結果を
 * 「使う前に補正する」薄いレイヤーとして追加する：
 *
 *   conversationScore = scoreMemory()の値
 *                        - genericKeywordPenalty（コーパス内で頻出する一般的なkeywordの
 *                          寄与を、既存のcomputeKeywordFrequencyと同じ考え方で減衰させる）
 *                        + conversationAnchorScore（直近の同一Conversation内user turnsで
 *                          繰り返し出現している、かつ一般的でないkeywordを持つMemoryを補強する）
 *
 * turns全文を1つの文字列に連結してbigram検索することはしない（一般語・ノイズが
 * 増えるだけのため、調査ラウンドで明示的に避けると判断した設計）。直近turns本文は
 * 「Memoryのkeywordがそのturnに含まれるか」というkeyword単位の存在判定だけに使う
 * （deriveConversationTopicAnchors参照）。
 *
 * companion/coachが使うretrieveRelevantMemories本体の非analystブランチ、および
 * scoreMemory()自体には一切変更を加えない。analystのdivergent選定
 * （selectDivergentMemories等）にも影響しない（将来のBroad/Divergent Retrievalのために
 * そのまま温存する）。
 *
 * 【暫定値について】CONVERSATION_MIN_SCORE・CONVERSATION_ANCHOR_WEIGHT・
 * CONVERSATION_RECENT_TURNS_WINDOWの3つは、実データが無い状態で設計時に決めた暫定値。
 * 実機BetaのConversation Debug Log（queryScore/genericPenalty/anchorBonus/
 * conversationScoreの内訳、floor未満での除外理由）を見ながら調整する前提で、
 * 変更しやすいようこのファイル内の1箇所にまとめてexportしてある。
 */

/** 直接一致候補として最低限必要な補正後スコア（暫定値）。これ未満の候補は
 * 1位であっても採用しない（0件を許容する。無理に埋めない。MEMORY_ENGINE.md 7.4）。 */
export const CONVERSATION_MIN_SCORE = KEYWORD_WEIGHT; // 暫定値=3。実データで調整する

/** 直近turnsで継続しているtopic anchor 1件あたりの重み（暫定値）。 */
export const CONVERSATION_ANCHOR_WEIGHT = 4; // 暫定値。実データで調整する

/** topic anchor抽出の対象とする、直近の同一Conversation内user turnsの件数（暫定値）。 */
export const CONVERSATION_RECENT_TURNS_WINDOW = 6; // 暫定値。実データで調整する

/**
 * topic anchorとして扱うために必要な最低distinctiveness（暫定値）。
 * 「自分」「時間」のような一般語は、直近turns内で何度再出現しても、コーパス全体では
 * 多くのMemoryのkeywordsに含まれているためdistinctivenessが低い。turnsContaining
 * （再出現回数）だけでanchor化すると、一般語がConversation内で繰り返されただけで
 * anchor扱いされてしまう（実装後の合成データ検証で確認した不具合）。この閾値未満の
 * keywordはanchor候補にしない（重み付けだけでなくgate自体をかける）。
 * 例：0.5は「コーパス内で高々2件のMemoryにしか使われていないkeyword」に相当。
 */
export const CONVERSATION_ANCHOR_MIN_DISTINCTIVENESS = 0.5; // 暫定値。実データで調整する

/**
 * keywordがコーパス内でどれだけ珍しいかの重み（1に近いほど珍しい＝1件程度のMemoryでしか
 * 使われていない＝distinctive、0に近いほど多くのMemoryで使われる一般語）。
 * distinctivenessScore()と同じ考え方の再利用だが、あちらは「Memoryが持つ複数keywordの
 * うち最も珍しいもの」を返す集約関数のため、ここではkeyword単体の重みとして独立させる。
 */
function keywordRarityWeight(keyword: string, keywordFrequency: Map<string, number>): number {
  const freq = keywordFrequency.get(keyword) ?? 1;
  return freq > 0 ? 1 / freq : 1;
}

export interface ConversationTopicAnchor {
  keyword: string;
  /** keywordRarityWeightと同じ値（1に近いほど珍しい＝話題を決める語らしい）。 */
  distinctiveness: number;
  /** 直近turnsウィンドウのうち、このkeywordを含んでいたturnの数。 */
  turnsContaining: number;
}

/**
 * 直近の同一Conversation内user turns本文から、既存Memory keyword語彙（keywordFrequencyの
 * キー集合＝既存Captureが既に抽出済みのkeywordだけ）と照合してtopic anchorを導出する。
 * AI/APIによる新規Topic抽出は行わない。
 *
 * turns全文を連結してbigram化することはしない。各keywordについて「直近turnsのうち
 * このkeywordを含むものが何件あるか」を`turn.includes(keyword)`で個別に数えるだけであり、
 * turn本文の助詞・一般語の量そのものがスコアへ混入することはない。
 */
export function deriveConversationTopicAnchors(
  recentUserTurnsTexts: string[],
  keywordFrequency: Map<string, number>
): ConversationTopicAnchor[] {
  const window = recentUserTurnsTexts.slice(-CONVERSATION_RECENT_TURNS_WINDOW);
  const anchors: ConversationTopicAnchor[] = [];
  for (const keyword of keywordFrequency.keys()) {
    if (!keyword) continue;
    const turnsContaining = window.filter((text) => text.includes(keyword)).length;
    if (turnsContaining === 0) continue;
    const distinctiveness = keywordRarityWeight(keyword, keywordFrequency);
    // 一般語はConversation内で何度再出現してもanchor化しない（CONVERSATION_ANCHOR_MIN_DISTINCTIVENESS参照）。
    if (distinctiveness < CONVERSATION_ANCHOR_MIN_DISTINCTIVENESS) continue;
    anchors.push({ keyword, distinctiveness, turnsContaining });
  }
  return anchors;
}

/**
 * scoreMemory()のkeywordHit寄与（keywordHits * KEYWORD_WEIGHT）のうち、一般的な
 * （コーパス内で頻出する）keywordの分だけを差し引く補正値。scoreMemory自体は
 * 読み取り専用で呼ぶだけで変更しない。1件のみで使われる珍しいkeywordの一致は
 * 減衰させない（keywordRarityWeightが1に近いためpenaltyはほぼ0になる）。
 */
function genericKeywordPenalty(memory: MemoryObject, trimmed: string, keywordFrequency: Map<string, number>, recall: RecallTopic | null = null): number {
  // 過去を尋ねる質問（recallTopic）の話題そのものの語は、多くの記録にあっても「一般語」として減点しない（その語が質問の中心だから）
  const hits = memory.keywords.filter((keyword) => keyword && trimmed.includes(keyword) && !isTopicKeyword(keyword, recall));
  return hits.reduce((sum, keyword) => sum + KEYWORD_WEIGHT * (1 - keywordRarityWeight(keyword, keywordFrequency)), 0);
}

/**
 * 直近turnsで継続しているtopic anchor（一般的でない、繰り返し出現しているkeyword）を
 * 持つMemoryを補強するボーナス値。anchorsに無いkeywordは寄与0。
 */
function conversationAnchorScore(memory: MemoryObject, anchors: ConversationTopicAnchor[]): number {
  if (anchors.length === 0) return 0;
  const anchorByKeyword = new Map(anchors.map((anchor) => [anchor.keyword, anchor]));
  let score = 0;
  for (const keyword of memory.keywords) {
    if (!keyword) continue;
    const anchor = anchorByKeyword.get(keyword);
    if (anchor) score += CONVERSATION_ANCHOR_WEIGHT * anchor.distinctiveness;
  }
  return score;
}

/**
 * Person continuity（会話入口の人物の継続）。直近の同じ会話で名前を出した人物の話が、名前を省いたまま続いているとき
 * （「さきさんについて話したい」→「以前はモヤモヤしていた」→「最近はもっと話したい」→「彼女は自分にとってどういう存在なんだろう」）、
 * その人物の記録を持つMemoryに補助の加点をする。AIは呼ばない。人物の語彙は、既存MemoryにCaptureが付けた
 * `personMentions[].displayName`だけ（新しい人物抽出はしない）。
 *
 * 引き継ぐのは、次をすべて満たすときだけ（曖昧なら引き継がない＝無理に人物を特定しない）：
 *   - 最新発言より前で、最後に既知の人物名が出た発言に、その人物が1人だけ出ている（2人以上なら曖昧）
 *   - そこから最新発言までのどの発言にも、別の既知の人物名・一般的な続柄（母・上司・友達…）・話題転換の言い回しが無い
 *   - 最新発言自身が人物名を出していない（出していれば通常の検索に任せる＝従来どおり）
 *   - 名前が出た発言から、最新発言までが PERSON_CARRY_MAX_TURNS 以内
 *   - 最新発言が「続き」らしい：その人を指す言い方（彼女・彼・その人・あの人・あの子・二人・相手…）を含む、または
 *     名前が出てからの発言かその人物のMemoryと、内容語（2文字以上の漢字・カタカナ語。一般語は除く）を共有している
 *     （名前の無い無関係な発言＝「コンビニの新作アイス、当たりだった」に人物を持ち込まないため）
 * 名前の省略が何ターン続いても、上の条件を満たす限り引き継ぐ（直近1〜2発言に名前があることは要求しない）。
 * 一般的な続柄や1文字の呼び方は、誤一致しやすいため引き継ぎ対象にしない（通常の検索では従来どおり扱われる）。
 */
export const PERSON_CARRY_MAX_TURNS = 8;
/** 引き継いだ人物の記録を持つMemoryへの加点。最低点（CONVERSATION_MIN_SCORE）を単独で超える大きさ。 */
export const PERSON_CARRY_WEIGHT = CONVERSATION_ANCHOR_WEIGHT;
/** 誰のことか特定できない続柄・一般名詞。引き継ぎの対象にせず、最新発言などに出たら「別の人の話」とみなす。 */
const GENERIC_PERSON_WORDS = [
  "母", "父", "両親", "妻", "夫", "姉", "兄", "弟", "妹", "祖母", "祖父", "おばあちゃん", "おじいちゃん", "家族", "息子", "娘", "子ども", "子供",
  "上司", "部下", "同僚", "先輩", "後輩", "先生", "友達", "友人", "彼氏", "恋人", "親友", "知人", "社長", "店長",
];
/** 名前を省いて同じ人を指すときの言い方（あれば「続き」とみなす根拠になる） */
const PERSON_REFERENCE_CUES = ["彼女", "彼は", "彼が", "彼と", "彼に", "彼の", "その人", "あの人", "あの子", "その子", "二人", "ふたり", "相手", "あいつ", "あちら"];
/** 内容語として数えない一般語 */
const GENERIC_CONTENT_WORDS = new Set(["最近", "以前", "今日", "昨日", "自分", "時間", "今回", "前回", "本当", "気持", "感じ", "結局", "一緒", "存在", "関係"]);
const contentWords = (text: string): Set<string> =>
  new Set((text.normalize("NFKC").match(/[\u4E00-\u9FFF々]{2,}|[\u30A1-\u30FAー]{2,}/g) ?? []).filter((w) => !GENERIC_CONTENT_WORDS.has(w)));

/** 話題を明確に切り替える言い回し */
const TOPIC_SWITCH_PHRASES = ["ところで", "話は変わる", "話変わる", "それはそうと", "全然関係ない", "関係ないけど", "別の話", "違う話", "それより", "そういえば"];

export interface ConversationPersonFocus {
  displayName: string;
  /** 名前が出た発言から最新発言までのuser turn数（1＝直前の発言） */
  turnsSinceMention: number;
}

/** 表記ゆれを吸収した人物名のkey：NFKC・空白除去・末尾の敬称（さん/ちゃん/くん/様/氏）を外す（外した残りが2文字以上のときだけ）。 */
function personNameKey(name: string): string {
  const base = name.normalize("NFKC").replace(/\s+/g, "").trim();
  const stripped = base.replace(/(さん|ちゃん|くん|君|様|氏)$/, "");
  return Array.from(stripped).length >= 2 ? stripped : base;
}

/** 既知の人物名（既存MemoryのpersonMentions由来）。続柄・1文字の呼び方は引き継ぎ対象から外す。 */
function carriablePersonNames(pool: MemoryObject[]): string[] {
  const names = new Set<string>();
  for (const memory of pool) {
    for (const mention of memory.personMentions ?? []) {
      const name = personNameKey(mention.displayName ?? "");
      if (Array.from(name).length < 2) continue;
      if (GENERIC_PERSON_WORDS.includes(name)) continue;
      names.add(name);
    }
  }
  return [...names];
}

const mentionsOf = (text: string, names: string[]) => {
  const normalized = text.normalize("NFKC").replace(/\s+/g, "");
  return names.filter((name) => normalized.includes(name));
};
/** 続柄の言葉が「人」として出ているか。1文字の続柄（母・夫・妻…）は、前後が漢字のとき（大丈夫・母国・稲妻…）は別の語の一部なので数えない。 */
const isKanji = (ch: string | undefined) => ch !== undefined && /[\u4E00-\u9FFF々]/.test(ch);
const mentionsGenericPerson = (text: string) => GENERIC_PERSON_WORDS.some((word) => {
  if (Array.from(word).length > 1) return text.includes(word);
  const chars = Array.from(text);
  return chars.some((ch, k) => ch === word && !isKanji(chars[k - 1]) && !isKanji(chars[k + 1]));
});
const switchesTopic = (text: string) => TOPIC_SWITCH_PHRASES.some((phrase) => text.includes(phrase));

/**
 * 直近の同じ会話のuser turns（最新発言を末尾に含む）から、名前を省いたまま続いている人物を求める。
 * 引き継がない場合はnull（上のコメントの条件参照）。
 */
export function deriveConversationPersonFocus(recentUserTurnsTexts: string[], pool: MemoryObject[]): ConversationPersonFocus | null {
  if (recentUserTurnsTexts.length < 2) return null;
  const names = carriablePersonNames(pool);
  if (names.length === 0) return null;
  const latest = recentUserTurnsTexts[recentUserTurnsTexts.length - 1];
  // 最新発言が人物（既知の名前・続柄）を出している、または話題を切り替えている：引き継がない
  if (mentionsOf(latest, names).length > 0 || mentionsGenericPerson(latest) || switchesTopic(latest)) return null;
  for (let i = recentUserTurnsTexts.length - 2, distance = 1; i >= 0 && distance <= PERSON_CARRY_MAX_TURNS; i--, distance++) {
    const text = recentUserTurnsTexts[i];
    const mentioned = mentionsOf(text, names);
    if (mentioned.length === 0) {
      // 名前の出ていない発言：別の人・話題転換が出ていれば、それより前の人物は引き継がない
      if (mentionsGenericPerson(text) || switchesTopic(text)) return null;
      continue;
    }
    // 最後に名前が出た発言。1人だけなら候補（2人以上、または続柄の人も同じ発言に出ていれば、誰の話か特定しない）
    if (mentioned.length > 1 || mentionsGenericPerson(text)) return null;
    const person = mentioned[0];
    // 最新発言が「続き」らしいか：人を指す言い方、または名前が出てからの発言／その人物のMemoryとの内容語の共有
    if (PERSON_REFERENCE_CUES.some((cue) => latest.includes(cue))) return { displayName: person, turnsSinceMention: distance };
    const latestWords = contentWords(latest);
    if (latestWords.size === 0) return null;
    // 根拠にする語：名前が出た発言とその人物のMemory、そして間の発言のうち、それ自体がその人物の話につながっているものだけ
    // （人を指す言い方を含む、または既につながっている語を共有する）。つながっていない間の発言（別の話題）は根拠に入れない。
    const connected = new Set<string>([
      ...contentWords(text),
      ...pool.filter((m) => (m.personMentions ?? []).some((pm) => personNameKey(pm.displayName ?? "") === person)).flatMap((m) => [...contentWords(`${m.summary} ${(m.keywords ?? []).join(" ")}`)]),
    ]);
    for (const between of recentUserTurnsTexts.slice(i + 1, recentUserTurnsTexts.length - 1)) {
      const words = contentWords(between);
      if (PERSON_REFERENCE_CUES.some((cue) => between.includes(cue)) || [...words].some((w) => connected.has(w))) for (const w of words) connected.add(w);
    }
    return [...latestWords].some((w) => connected.has(w)) ? { displayName: person, turnsSinceMention: distance } : null;
  }
  return null;
}

/** 引き継いだ人物の記録（personMentions）を持つMemoryへの加点。人物が無ければ0。 */
function personCarryScore(memory: MemoryObject, focus: ConversationPersonFocus | null): number {
  if (!focus) return 0;
  return (memory.personMentions ?? []).some((mention) => personNameKey(mention.displayName ?? "") === focus.displayName) ? PERSON_CARRY_WEIGHT : 0;
}

export interface ConversationCandidateScore {
  memory: MemoryObject;
  /** 既存scoreMemory()の生値（未補正）。 */
  queryScore: number;
  /** 一般的なkeywordの寄与を減衰させた分（正の値。scoreからはこの分を引く）。 */
  genericPenalty: number;
  /** 直近turnsでの継続によるボーナス（加点）。 */
  anchorBonus: number;
  /** 名前を省いたまま続いている人物（Person continuity）の記録を持つMemoryへの加点。引き継ぎが無ければ0。 */
  personBonus: number;
  /** 過去を尋ねる質問（recallTopic、会話の画面だけ）の話題に、キーワード一致では数えていない形で一致した分（「車」→「車種」「車選び」）。無ければ0。 */
  recallBonus: number;
  /** 質問の目的に応じた加点・減点（purposeRelevance、会話の画面だけ。recordRelevance.ts）。無ければ0。 */
  purposeAdjust: number;
  /** 理由を尋ねる質問への、話題に一致する本人の理由・訂正（recordRelevance.ts 4.）。相対の強さでは外さない（floor・件数は従来どおり）。 */
  reasonAnswer?: boolean;
  /** 質問の目的で後ろに回した（尋ねただけの記録・他人の行動が中心の記録）。同点なら後に並べる。 */
  demoted: boolean;
  /** queryScore - genericPenalty + anchorBonus + personBonus + recallBonus + purposeAdjust。実際の順位付け・floor判定に使う値。 */
  conversationScore: number;
}

/**
 * poolの各Memoryについて、Conversation Retrieval用の補正後スコアと内訳を計算する。
 * scoreMemory()は変更せず読み取り専用で呼ぶだけ。ConversationDebugからも
 * 同じ関数を再利用し、実際の選定ロジックとログの内訳を常に一致させる。
 */
export function scoreConversationCandidates(
  pool: MemoryObject[],
  trimmed: string,
  anchors: ConversationTopicAnchor[],
  keywordFrequency: Map<string, number>,
  personFocus: ConversationPersonFocus | null = null,
  recall: RecallTopic | null = null,
  /** 質問の目的（会話の画面だけ。未指定なら従来どおり） */
  purpose: PurposeContext | null = null
): ConversationCandidateScore[] {
  return pool.map((memory) => {
    const queryScore = scoreMemory(memory, trimmed);
    const genericPenalty = genericKeywordPenalty(memory, trimmed, keywordFrequency, recall);
    const anchorBonus = conversationAnchorScore(memory, anchors);
    const personBonus = personCarryScore(memory, personFocus);
    const recallBonus = recallTopicBonus(memory, recall, trimmed);
    const base = queryScore - genericPenalty + anchorBonus + personBonus + recallBonus;
    // floor・件数・相対の強さの判定より前に、質問の目的で加点・減点する（話題に一致する記録だけ。recordRelevance.ts）
    const adjusted = purpose ? adjustForPurpose(memory, base, purpose, trimmed, recall ? matchRecallTopic(memory, recall, trimmed).matched.length > 0 : false, KEYWORD_WEIGHT, CONVERSATION_MIN_SCORE) : null;
    const conversationScore = adjusted ? adjusted.score : base;
    return { memory, queryScore, genericPenalty, anchorBonus, personBonus, recallBonus, purposeAdjust: conversationScore - base, demoted: adjusted?.demoted ?? false, ...(adjusted?.reasonAnswer ? { reasonAnswer: true } : {}), conversationScore };
  });
}

/**
 * 過去を尋ねる質問の話題に、キーワード一致では数えていない形で一致したとき（質問「車」と記録のキーワード「車選び」・要約の「車種」など）、1語につきキーワード1件分。
 * 話題の語が質問に無い・recallが無いときは0（従来どおり）。
 */
function recallTopicBonus(memory: MemoryObject, recall: RecallTopic | null, trimmed: string): number {
  if (!recall) return 0;
  const match = matchRecallTopic(memory, recall, trimmed);
  return (match.matched.length - match.coveredByKeyword.length) * KEYWORD_WEIGHT;
}

export interface ConversationDirectSelection {
  anchors: ConversationTopicAnchor[];
  /** 名前を省いたまま続いている人物（引き継がない場合null）。 */
  personFocus: ConversationPersonFocus | null;
  /** floor判定前の全候補数（デバッグ表示用）。 */
  consideredCount: number;
  kept: ConversationCandidateScore[];
  /** CONVERSATION_MIN_SCORE未満で除外された候補（正の値を持つもののみ、スコア降順）。 */
  droppedByFloor: ConversationCandidateScore[];
  /** floorは超えたが、相対的な強さが足りず除外された候補。 */
  droppedByRelativeStrength: ConversationCandidateScore[];
}

/**
 * Conversation Retrievalの直接一致選定：scoreConversationCandidatesで補正後スコアを計算し、
 * (1) 暫定の絶対floor（CONVERSATION_MIN_SCORE）未満を除外 → (2) 上位limit件に絞り →
 * (3) 既存のapplyRelativeStrengthFilter（変更なし）をそのまま適用、の3段階で絞り込む。
 * floorを超える候補が1件も無ければ空配列を返す（0件を許容し、divergentや無関係な
 * Memoryでの穴埋めは行わない）。
 */
export function selectConversationDirectMatches(
  pool: MemoryObject[],
  trimmed: string,
  recentUserTurnsTexts: string[],
  keywordFrequency: Map<string, number>,
  limit: number,
  /** 過去を尋ねる質問の話題（会話の画面だけ。未指定なら従来どおり） */
  recall: RecallTopic | null = null,
  /** 質問の目的（会話の画面だけ。未指定なら従来どおり） */
  purpose: PurposeContext | null = null
): ConversationDirectSelection {
  const anchors = deriveConversationTopicAnchors(recentUserTurnsTexts, keywordFrequency);
  const personFocus = deriveConversationPersonFocus(recentUserTurnsTexts, pool);
  const allScored = scoreConversationCandidates(pool, trimmed, anchors, keywordFrequency, personFocus, recall, purpose);

  const aboveFloor = allScored.filter((entry) => entry.conversationScore >= CONVERSATION_MIN_SCORE);
  const droppedByFloor = allScored
    .filter((entry) => entry.conversationScore > 0 && entry.conversationScore < CONVERSATION_MIN_SCORE)
    .sort((a, b) => b.conversationScore - a.conversationScore);

  // 同点なら、質問の目的で後ろに回した記録を後に（目的が無ければdemotedは常にfalse＝従来どおり）
  const sorted = [...aboveFloor].sort((a, b) => b.conversationScore - a.conversationScore || Number(a.demoted) - Number(b.demoted)).slice(0, limit);

  const relativeInput = sorted.map((entry) => ({ memory: entry.memory, score: entry.conversationScore }));
  const keptIds = new Set(applyRelativeStrengthFilter(relativeInput).map((entry) => entry.memory.id));
  // 理由を尋ねる質問：話題に一致する本人の理由・訂正は、1位（質問の言い回しをなぞったAIの振り返りのこともある）より弱いだけでは外さない
  for (const entry of sorted) if (entry.reasonAnswer) keptIds.add(entry.memory.id);
  const kept = sorted.filter((entry) => keptIds.has(entry.memory.id));
  const droppedByRelativeStrength = sorted.filter((entry) => !keptIds.has(entry.memory.id));

  return { anchors, personFocus, consideredCount: allScored.length, kept, droppedByFloor, droppedByRelativeStrength };
}

// ---------------------------------------------------------------------------
// Person-aware conversation retrieval（会話＝analystのRetrieval）。
// 架空Memoryによる比較（R2＋R3n、2026-10-31〜11-01）を経た仕様。上のselectConversationDirectMatchesはそのまま呼び出し、その結果に対して
// 「このターンが一人の人物の話であるとき」だけ、次を行う：
//   1. その人物の記録 = personMentionsにその人物がある、またはキーワードがその人物の名前と完全に一致する記録（部分一致は使わない。
//      発言中の名前は長いものから照合し、照合した部分を伏せるので「まさきさん」の中の「さき」は数えない）。
//   2. 選定結果から、別の人物だけの記録を外す（「距離」のような共通語で別の人物の記録が入るのを防ぐ）。
//   3. その人物の他の記録を最大PERSON_EXTRA_LIMIT件足す：最新の記録、名前以外のキーワードが会話に出てくる記録。
//   4. 関係や気持ちの話のとき（業務の進め方の話ではないとき）だけ、その人物の気持ちの記録を最大1件足す：キーワードが会話に出てくるもの。
//      無ければ最新の気持ちの記録（既に入っていれば、繰り返し話している気持ちの最新の記録）。FEELING_MAX_AGE_DAYSより古いもの、
//      別の人物にも関わるものは足さない。記録は日付つきのまま渡り、その人への今の気持ちのすべてとしては扱わない（会話プロンプト側の扱いは変えない）。
// 「2人」「２人」はRetrievalの中だけ「二人」として扱う。人物が出てこない、または発言に二人以上の名前が出るターンは、従来の選定そのまま。
// ---------------------------------------------------------------------------
export const PERSON_EXTRA_LIMIT = 2;
export const FEELING_MAX_AGE_DAYS = 180;
/** 人物との関係の変化を尋ねるターンに足す、変化を説明する記録の上限（変化の前の記録・変化の記録） */
export const PERSON_ARC_LIMIT = 2;
/** その記録を探す範囲：この日数以内の、その人物の新しい記録から最大PERSON_ARC_SCAN_LIMIT件 */
export const PERSON_ARC_MAX_AGE_DAYS = 365;
export const PERSON_ARC_SCAN_LIMIT = 60;
/**
 * 関係の変化を説明する記録の言い回し（質問の目的「変化」の判定 RECORD_SAYS.change と同じ語。「前は」は文や句の始まりのときだけ。「この前は」「名前は」「午前は」は除く）。
 * STATE_CHANGEは、関係の言葉が無くても変化の記録にしてよい、できること・状態の変化（「話せるようになった」「以前は」）だけ
 */
const ARC_CHANGE = /ようになっ|変わ|以前は|(?<![一-鿿々ぁ-んァ-ヶー])前は|ことにし|にした|やめ|始め/;
const STATE_CHANGE = /ようになっ|以前は|(?<![一-鿿々ぁ-んァ-ヶー])前は/;
const DAY_MS_RETRIEVAL = 86_400_000;

export const normalizeTwoPeople = (text: string) => text.replace(/2人|２人/g, "二人");
const nfkcCompact = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");

/** 既知の人物：personMentionsの名前と、敬称つきの名前そのものであるキーワード（「まさきさん」がキーワードだけにあっても、別の人物として数える） */
function knownPersonKeys(pool: MemoryObject[]): string[] {
  const keys = new Set<string>();
  const add = (name: string) => {
    const key = personNameKey(name);
    if (Array.from(key).length >= 2 && !GENERIC_PERSON_WORDS.includes(key)) keys.add(key);
  };
  for (const memory of pool) {
    for (const mention of memory.personMentions ?? []) add(mention.displayName ?? mention.groupingKey ?? "");
    for (const keyword of memory.keywords ?? []) if (/(さん|ちゃん|くん|君|様|氏)$/.test(nfkcCompact(keyword))) add(keyword);
  }
  return [...keys];
}

/** 発言に出てくる既知の人物（長い名前から照合し、照合した部分を伏せる） */
const NAME_FOLLOWERS = /^(さん|ちゃん|くん|君|様|氏|先輩|先生|部長|課長|社長|は|が|を|に|と|の|も|へ|で|や|から|まで|って|とか|より|だ|じゃ|[\s、。，．！？!?・「」『』（）()\u25A0]|$)/;
const scriptOf = (char: string) => (/[\u3040-\u309F]/.test(char) ? "hira" : /[\u30A0-\u30FF]/.test(char) ? "kata" : /[\u4E00-\u9FFF々]/.test(char) ? "kanji" : "other");
/** 名前として読める出現か：直後が敬称・助詞・区切りか、名前の最後の文字と違う種類の文字なら名前とみなす（「さきほど」の「さき」は名前ではない） */
function isNameOccurrence(text: string, index: number, key: string): boolean {
  const after = text.slice(index + key.length);
  if (NAME_FOLLOWERS.test(after)) return true;
  const last = Array.from(key).pop() ?? "";
  return scriptOf(Array.from(after)[0] ?? "") !== scriptOf(last);
}

export function personKeysInText(text: string, keys: string[]): string[] {
  let rest = nfkcCompact(text);
  const found: string[] = [];
  for (const key of [...keys].sort((a, b) => Array.from(b).length - Array.from(a).length)) {
    let named = false;
    for (let index = rest.indexOf(key); index !== -1; index = rest.indexOf(key, index + key.length)) if (isNameOccurrence(rest, index, key)) named = true;
    if (named) found.push(key);
    // 長い名前の中の短い名前を拾わないよう、名前として読めなくても長い順に伏せる
    rest = rest.split(key).join("\u25A0".repeat(key.length));
  }
  return found;
}

/** 発言の中の名前を、確定した組の最初の名前に置き換える（長い名前から伏せるので、「まりこ」の中の「りこ」は置き換えない） */
function withCanonicalNames(text: string, keys: string[], canonical: (key: string) => string): string {
  const sorted = [...keys].sort((a, b) => Array.from(b).length - Array.from(a).length);
  let masked = nfkcCompact(text);
  sorted.forEach((key, index) => { masked = masked.split(key).join(`\u0001${index}\u0002`); });
  return masked.replace(/\u0001(\d+)\u0002/g, (_, index: string) => canonical(sorted[Number(index)]));
}

export function isAboutPerson(memory: MemoryObject, key: string): boolean {
  if ((memory.personMentions ?? []).some((mention) => personNameKey(mention.displayName ?? mention.groupingKey ?? "") === key)) return true;
  return (memory.keywords ?? []).some((keyword) => personNameKey(keyword) === key);
}

const FEELING_WORDS = /寂し|さみし|嫉妬|妬|大切|大事|好き|嫌い|不安|辛い|つらい|悲し|嬉し|うれし|安心|ほっと|モヤモヤ|もやもや|葛藤|信頼|傷つ|怖|距離|気持ち|会いたい|恋し|怒|腹が立|イラ|苛立/;
export function isFeelingRecord(memory: MemoryObject): boolean {
  if ((memory.types ?? []).includes("emotion")) return true;
  return FEELING_WORDS.test(`${(memory.keywords ?? []).join(" ")} ${memory.summary}`);
}

/** 関係・気持ちの話であることがはっきりする言葉 */
const STRONG_RELATION_CUES = /寂し|さみし|嫉妬|妬|好き|嫌い|嫌われ|不安|辛い|つらい|悲し|嬉し|うれし|安心|ほっと|モヤモヤ|もやもや|傷つ|怖|会いたい|話したい|一緒にいたい|二人だけ|二人でいたい|二人の時間|距離|空気感|関係|避け|冷た|そっけな|離れ|本音/;
/** 業務の話でも使われる言葉（「大事な点」「存在する」など）：業務の言葉が無いときだけ関係の話とみなす */
const WEAK_RELATION_CUES = /大切|大事|気持ち|存在|ほんとは|本当は/;
const WORK_CUES = /プレゼン|資料|締め切り|締切|会議|打ち合わせ|見積|タスク|分担|スケジュール|進め方|段取り|納期|作業|手順|報告|担当/;
const relationCueIn = (text: string) => STRONG_RELATION_CUES.test(text) || (WEAK_RELATION_CUES.test(text) && !WORK_CUES.test(text));

/** 関係や気持ちの話か（業務の進め方の話ではないか）。今の発言を優先し、今の発言が中立なら直前の発言を見る。 */
export function isRelationshipTalk(latest: string, previousUserTurn?: string): boolean {
  const lat = normalizeTwoPeople(nfkcCompact(latest));
  if (relationCueIn(lat)) return true;
  if (WORK_CUES.test(lat)) return false;
  return previousUserTurn !== undefined && relationCueIn(normalizeTwoPeople(nfkcCompact(previousUserTurn)));
}

const memoryTime = (memory: MemoryObject) => Date.parse(memory.statedAt ?? memory.date);

export interface PersonAwareSelection {
  memories: MemoryObject[];
  /** このターンの人物（無ければnull＝従来の選定そのまま） */
  person: { key: string; how: "named" | "carried" } | null;
  added: string[];
  /** 関係の変化を尋ねるターンに足した、変化を説明する記録（変化の前・変化。古い順） */
  arc: string[];
  dropped: string[];
  feeling: string | null;
}

// ---------------------------------------------------------------------------
// 人物の特定・変化のゲート・弧の選定（analyst と companion/coach で共有する部品）。
// 人物の特定と「深掘りするか」の判断は分ける：特定しただけでは記録は1件も足さない。
// 深掘り（時系列の補完）は、変化／振り返りのゲートが開いたときだけ行う。
// ---------------------------------------------------------------------------

export interface TurnPersonResolution {
  /** 特定した人物のキー（名前が出た形のキー。確定した組があるときはその組のキー） */
  key: string;
  /** その人物の名前の組（確定した同じ人物の名前。組が無ければ [key]） */
  targetKeys: string[];
  how: "named" | "carried";
  /** 既知の人物キーすべて（確定した組の名前を含む）。他の人物の判定・名前を伏せた照合に使う */
  keys: string[];
}

/**
 * 段階1：このターンが一人の人物の話かを求める。名前が明示されていれば（別名の組は1人と数える）その人物、
 * 無ければ従来の人物継続（deriveConversationPersonFocus）を、キーワードが名前と一致する記録もその人物の記録として
 * 扱った写しの上で使う。曖昧・複数・続柄のみ・話題転換のときは null（呼び出し元は従来の選定そのままになる）。
 */
export function resolveTurnPerson(
  pool: MemoryObject[],
  trimmed: string,
  recentUserTurnsTexts: string[],
  /** Memory Graph P1-B：本人が確定した同じ人物の名前の組（未指定・空なら従来どおり） */
  aliases: string[][] = []
): TurnPersonResolution | null {
  const turns = recentUserTurnsTexts.map(normalizeTwoPeople);
  const known = knownPersonKeys(pool);
  if (known.length === 0) return null;
  // 確定した名前の組：既知の名前を1つでも含む組だけ。組の名前はどれも既知の人物の名前として扱い、同じ組の名前は1人と数える
  const groupOf = new Map<string, string[]>();
  for (const list of aliases) {
    const group = [...new Set(list.map(personNameKey).filter((key) => Array.from(key).length >= 2 && !GENERIC_PERSON_WORDS.includes(key)))];
    if (group.length < 2 || !group.some((key) => known.includes(key)) || group.some((key) => groupOf.has(key))) continue;
    for (const key of group) groupOf.set(key, group);
  }
  const keys = [...new Set([...known, ...groupOf.keys()])];
  const groupKeys = (key: string) => groupOf.get(key) ?? [key];

  const named = [...new Map(personKeysInText(trimmed, keys).map((key) => [groupKeys(key)[0], key])).values()];
  if (named.length === 1) {
    return { key: named[0], targetKeys: groupKeys(named[0]), how: "named", keys };
  }
  if (named.length === 0) {
    // 従来の人物継続を、キーワードが名前と一致する記録（と、確定した同じ人物の別の名前の記録）もその人物の記録として扱った写しの上で使う
    // 確定した名前の組は、組の最初の名前1つとして読む（発言の別名を置き換え、組のどの名前の記録もその名前の記録として扱う）。組が無ければ従来どおり
    const canonical = (key: string) => groupKeys(key)[0];
    const linked = pool.map((memory) => {
      const extra = keys.filter((key) => canonical(key) === key && !(memory.personMentions ?? []).some((mention) => personNameKey(mention.displayName ?? "") === key) && groupKeys(key).some((k) => (k === key ? (memory.keywords ?? []).some((keyword) => personNameKey(keyword) === key) : isAboutPerson(memory, k))));
      return extra.length === 0 ? memory : ({ ...memory, personMentions: [...(memory.personMentions ?? []), ...extra.map((key) => ({ displayName: key, groupingKey: key }))] } as unknown as MemoryObject);
    });
    const focus = deriveConversationPersonFocus(groupOf.size === 0 ? turns : turns.map((text) => withCanonicalNames(text, keys, canonical)), linked);
    if (focus) {
      const key = personNameKey(focus.displayName);
      return { key, targetKeys: groupKeys(key), how: "carried", keys };
    }
  }
  return null;
}

/** 会話の本文から人物名を除いた照合用の文字列（名前だけで「重なる」としないため。敬称も除く） */
function personMaskedQuery(turns: string[], latest: string, keys: string[]): string {
  return keys.reduce((text, key) => text.split(key).join(" "), nfkcCompact((turns.length > 0 ? turns : [latest]).join(" ")).replace(/(さん|ちゃん|くん|君|様|氏)/g, " "));
}

/** 名前以外のキーワードが、名前を除いた会話に出てくる数 */
export function ownKeywordHitsOf(memory: MemoryObject, query: string, keys: string[]): number {
  return (memory.keywords ?? []).filter((keyword) => !keys.includes(personNameKey(keyword)) && query.includes(nfkcCompact(keyword))).length;
}

export interface PersonArcSelection {
  /** 変化の記録（既に選ばれている記録のこともある。そのときは変化の時点の基準として使う） */
  change: MemoryObject | null;
  /** 変化の前の記録（未選定のものだけ） */
  before: MemoryObject | null;
  changeAt: number;
}

/**
 * 段階4の材料：関係の変化を説明する記録の選定（analyst の弧と同じ規則のまま切り出したもの）。
 * 候補は、対象人物だけの記録（別の人物も関わる記録は使わない）・本人の言葉があるもの・AIの振り返りでないもの・
 * 尋ねただけの記録でないもの、PERSON_ARC_MAX_AGE_DAYS以内の新しい順に最大PERSON_ARC_SCAN_LIMIT件。
 *   - 変化の記録：本人の言葉＋要約に、関係の言葉と変化の言い回しがあるもの → 無ければ、できること・状態の変化のもの。それぞれ新しい順
 *   - 変化の前の記録：変化の時点より前で未選定のものから、気持ち・関係の言葉がある中で変化に一番近いもの。無ければ一番古いもの
 */
export function pickPersonArc(
  pool: MemoryObject[],
  opts: { keys: string[]; targetKeys: string[]; includedIds: ReadonlySet<string>; now: number }
): PersonArcSelection {
  const { keys, targetKeys, includedIds, now } = opts;
  const isAboutTarget = (memory: MemoryObject) => targetKeys.some((key) => isAboutPerson(memory, key));
  const aboutOther = (memory: MemoryObject) => keys.some((key) => !targetKeys.includes(key) && isAboutPerson(memory, key));
  const hasOwnWords = (memory: MemoryObject) => (memory.evidenceQuotes ?? []).some((quote) => typeof quote === "string" && quote.trim().length > 0);
  const ownText = (memory: MemoryObject) => nfkcCompact([...(memory.evidenceQuotes ?? []).filter((quote) => typeof quote === "string"), memory.summary ?? ""].join("。"));
  const own = pool
    .filter((memory) => isAboutTarget(memory) && !aboutOther(memory) && !isReflectionMemory(memory) && !isRecallOnlyRecord(memory) && hasOwnWords(memory))
    .filter((memory) => now - memoryTime(memory) <= PERSON_ARC_MAX_AGE_DAYS * DAY_MS_RETRIEVAL)
    .sort((a, b) => memoryTime(b) - memoryTime(a))
    .slice(0, PERSON_ARC_SCAN_LIMIT);
  const cue = (memory: MemoryObject) => isFeelingRecord(memory) || relationCueIn(ownText(memory));
  const change = own.find((memory) => ARC_CHANGE.test(ownText(memory)) && relationCueIn(ownText(memory))) ?? own.find((memory) => STATE_CHANGE.test(ownText(memory))) ?? null;
  const changeAt = change ? memoryTime(change) : Math.min(...own.filter((memory) => includedIds.has(memory.id)).map(memoryTime), Infinity);
  const beforeList = own.filter((memory) => memory !== change && !includedIds.has(memory.id) && memoryTime(memory) < changeAt);
  const before = beforeList.find(cue) ?? beforeList[beforeList.length - 1] ?? null;
  return { change, before, changeAt };
}

/**
 * 段階3：変化／振り返りのゲート。開くのは、人物が1人特定できていて、最新発言に変化の言い回し（asksPersonChange）があり、
 * その変化がその人物についてのものである傍証が取れるときだけ。傍証は「変化の語がある文」の中でだけ数える：
 *   (a) 変化の語がある文そのものが関係・気持ちの話（isRelationshipTalk）、または
 *   (b) 変化の語がある同じ文に、その人物への言及（名前・人を指す言い方）がある、または
 *   (c) 変化の語がある文に気持ちの言葉がある。
 * 別の文にある関係の合図では開かない（「ゆうきさんに会いたい。最近、体重が減ったよ」の「会いたい」は、
 * 体重の変化をゆうきさんの変化にしない）。人物と無関係な変化では開かない、は文単位の原則（Codex 再レビュー [P2]）。
 * 判定は最新発言だけ（直前の発言は見ない）。判定の前に normalizeTwoPeople を通して人物の特定と同じ土俵にし、
 * 「二人」「2人」「２人」を同じ言及として扱う（Codex 再レビュー [P2]）。
 */
export function personChangeGate(latest: string, person: { targetKeys: string[] }): boolean {
  const text = normalizeTwoPeople(latest);
  if (!asksPersonChange(text)) return false;
  for (const sentence of sentences(text)) {
    if (!asksPersonChange(sentence)) continue;
    if (isRelationshipTalk(sentence)) return true;
    if (personKeysInText(sentence, person.targetKeys).length > 0) return true;
    if (PERSON_REFERENCE_CUES.some((cue) => sentence.includes(cue))) return true;
    if (FEELING_WORDS.test(sentence)) return true;
  }
  return false;
}

export function selectConversationWithPersons(
  pool: MemoryObject[],
  trimmed: string,
  recentUserTurnsTexts: string[],
  keywordFrequency: Map<string, number>,
  limit: number,
  now: number,
  /** Memory Graph P1-B：本人が確定した同じ人物の名前の組（未指定・空なら従来どおり。名前の推測では束ねない） */
  aliases: string[][] = [],
  /** 過去を尋ねる質問の話題（会話の画面だけ。未指定なら従来どおり） */
  recall: RecallTopic | null = null,
  /** 質問の目的（会話の画面だけ。未指定なら従来どおり） */
  purpose: PurposeContext | null = null
): PersonAwareSelection {
  // 人物の話でなければ、元の入力のままの従来の選定（「2人」の読み替えも人物の話のときだけ）
  const fallback = (): PersonAwareSelection => ({
    memories: selectConversationDirectMatches(pool, trimmed, recentUserTurnsTexts, keywordFrequency, limit, recall, purpose).kept.map((entry) => entry.memory),
    person: null,
    added: [],
    arc: [],
    dropped: [],
    feeling: null,
  });
  const latest = normalizeTwoPeople(trimmed);
  const turns = recentUserTurnsTexts.map(normalizeTwoPeople);
  // 人物の特定は共有部品（resolveTurnPerson）。特定できなければ従来の選定そのまま
  const resolution = resolveTurnPerson(pool, trimmed, recentUserTurnsTexts, aliases);
  if (!resolution) return fallback();
  const person: PersonAwareSelection["person"] = { key: resolution.key, how: resolution.how };
  const keys = resolution.keys;
  const targetKeys = resolution.targetKeys;
  const isAboutTarget = (memory: MemoryObject) => targetKeys.some((key) => isAboutPerson(memory, key));
  const base = selectConversationDirectMatches(pool, latest, turns, keywordFrequency, limit, recall, purpose).kept.map((entry) => entry.memory);
  const aboutOther = (memory: MemoryObject) => keys.some((key) => !targetKeys.includes(key) && isAboutPerson(memory, key));

  const dropped: string[] = [];
  const kept = base.filter((memory) => {
    if (aboutOther(memory) && !isAboutTarget(memory)) {
      dropped.push(memory.id);
      return false;
    }
    return true;
  });

  // 名前を除いた会話（名前だけで「重なる」としないため）
  const query = personMaskedQuery(turns, latest, keys);
  const ownKeywordHits = (memory: MemoryObject) => ownKeywordHitsOf(memory, query, keys);

  const included = new Set(kept.map((memory) => memory.id));
  const candidates = pool.filter((memory) => isAboutTarget(memory) && !aboutOther(memory) && !included.has(memory.id));
  const added: MemoryObject[] = [];
  const newest = [...candidates].sort((a, b) => memoryTime(b) - memoryTime(a))[0];
  if (newest) added.push(newest);
  const overlap = candidates
    .filter((memory) => memory !== newest)
    .map((memory) => ({ memory, hits: ownKeywordHits(memory) }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits || memoryTime(b.memory) - memoryTime(a.memory))[0];
  if (overlap) added.push(overlap.memory);
  const extra = added.slice(0, PERSON_EXTRA_LIMIT);
  for (const memory of extra) included.add(memory.id);

  const relationshipTalk = isRelationshipTalk(trimmed, turns.length >= 2 ? turns[turns.length - 2] : undefined);
  // 人物との関係・気持ちの変化を尋ねる（語る）ターンだけ（「ゆうきさんへの気持ちって、どう変わってきた？」。関係の言葉は今の発言に要る：
  // 「髪型を変えた」のような関係の言葉が無い変化、前の発言の関係の言葉だけでは足さない）：最新の記録だけでは変化が分からないので、
  // その変化を説明する本人の記録を最大PERSON_ARC_LIMIT件足す。
  //   - 変化の記録：関係・気持ちの言葉と変化の言い回しがある記録 → できること・状態の変化（「話せるようになった」「以前は」）の記録。それぞれ新しい順。
  //     既に選ばれている記録でもよい（そのときは足さずに、変化の時点として使う）。「夕食はカレーにした」のような関係の言葉が無い決めごとは使わない
  //   - 変化の前の記録：それより前の、本人の言葉がある記録。気持ち・関係の言葉がある中で変化にいちばん近いもの、無ければ最も古いもの
  // AIの振り返り・尋ねただけの記録・別の人物も関わる記録は使わない。範囲はPERSON_ARC_MAX_AGE_DAYS以内の新しい順PERSON_ARC_SCAN_LIMIT件
  const arc: MemoryObject[] = [];
  // 変化の言い回しは companion/coach のゲートと共有する拡張語彙（asksPersonChange）。analyst は元々 isRelationshipTalk を
  // 必須にし、人物も特定済みの文脈でのみ弧が動くため、差分は語彙の拡張だけ（D1）
  if (isRelationshipTalk(trimmed) && asksPersonChange(latest)) {
    const { change, before } = pickPersonArc(pool, { keys, targetKeys, includedIds: included, now });
    for (const memory of [before, change]) if (memory && !included.has(memory.id) && arc.length < PERSON_ARC_LIMIT) arc.push(memory);
    arc.sort((a, b) => memoryTime(a) - memoryTime(b));
    for (const memory of arc) included.add(memory.id);
  }

  let feeling: MemoryObject | undefined;
  if (relationshipTalk) {
    const eligible = pool
      // AIの振り返りは本人の気持ちの記録の代わりにしない（本人の言葉より先に立てない）
      .filter((memory) => isAboutTarget(memory) && isFeelingRecord(memory) && !aboutOther(memory) && !isReflectionMemory(memory))
      .filter((memory) => now - memoryTime(memory) <= FEELING_MAX_AGE_DAYS * DAY_MS_RETRIEVAL);
    const matched = eligible
      .filter((memory) => !included.has(memory.id))
      .map((memory) => ({ memory, hits: ownKeywordHits(memory) }))
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits || memoryTime(b.memory) - memoryTime(a.memory))[0];
    if (matched) {
      feeling = matched.memory;
    } else {
      const newestFeeling = [...eligible].sort((a, b) => memoryTime(b) - memoryTime(a))[0];
      if (newestFeeling && !included.has(newestFeeling.id)) {
        feeling = newestFeeling;
      } else if (newestFeeling) {
        // 最新の気持ちは既にある：繰り返し話している気持ち（名前以外の同じキーワードを持つ気持ちの記録が2件以上）が入っていなければ、その最新の記録
        const counts = new Map<string, number>();
        for (const memory of eligible) for (const keyword of new Set((memory.keywords ?? []).filter((k) => !keys.includes(personNameKey(k))))) counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
        const recurring = [...counts.entries()].filter(([, n]) => n >= 2).map(([keyword]) => keyword);
        const hasRecurring = (memory: MemoryObject, keyword: string) => (memory.keywords ?? []).includes(keyword);
        feeling = eligible
          .filter((memory) => !included.has(memory.id))
          .filter((memory) => recurring.some((keyword) => hasRecurring(memory, keyword) && !eligible.some((other) => included.has(other.id) && hasRecurring(other, keyword))))
          .sort((a, b) => memoryTime(b) - memoryTime(a))[0];
      }
    }
  }

  return {
    memories: [...kept, ...extra, ...arc, ...(feeling ? [feeling] : [])],
    person,
    added: extra.map((memory) => memory.id),
    arc: arc.map((memory) => memory.id),
    dropped,
    feeling: feeling?.id ?? null,
  };
}


/**
 * クリエイト（analyst）専用のMemory取得。companion/coachが使う既存のretrieveRelevantMemoriesの
 * スコアリング・件数ロジックには一切影響しない（別関数として完全に分離）。
 * Link経由の追加（pickLinkedAdditions）はここでは行わない（既存のConnect機能とは別軸のため）。
 *
 * 直接一致の選定は、Conversation Retrieval（selectConversationDirectMatches、上のセクション参照）に
 * 委譲する。scoreDirectCandidates + applyRelativeStrengthFilterだけを使っていた旧実装は、
 * 1位の候補自体が一般語一致だけのfalse positiveになるケースを防げなかったため、
 * このConversation品質改善 第2修正で置き換えた。
 *
 * 「あえて遠いMemory」（selectDivergentMemories、創造的な飛躍のための材料）は、
 * options.includeDivergentがtrueの場合にのみ追加する。通常のanalyst会話
 * （ChatScreen.tsxからの既定の呼び出し）ではこのオプションを渡していないため、
 * 現時点では自動投入されない。将来「別の視点がほしい」「意外なつながりを探して」等の
 * 明示的な要求を検出する仕組みを追加する際に、そこからoptions.includeDivergent:trueで
 * 呼び出せるよう、ロジック自体（selectDivergentMemories等）は削除せずそのまま残してある
 * （Conversation Retrievalの変更はdivergent選定に一切影響しない）。
 */
async function retrieveCreativeMemories(
  trimmed: string,
  options: {
    excludeConversationId?: string;
    limit?: number;
    includeDivergent?: boolean;
    /** Conversation Retrieval用。直近の同一Conversation内user turns本文（最新発言含む）。
     * 未指定時は空配列扱い＝anchorボーナス無しでgenericKeywordPenaltyのみ効く。 */
    recentUserTurnsTexts?: string[];
    personAliases?: string[][];
    /** 過去を尋ねる質問の話題（retrieveRelevantMemoriesImplが`recallTopic`のときだけ求める） */
    recall?: RecallTopic | null;
    /** 質問の目的に応じた関連性（会話の画面だけ） */
    purposeRelevance?: boolean;
  },
  context?: string[],
  /** P1-F：会話のRetrievalだけ。Reflectionを本人の記録の後に回し、その扱いを知らせる */
  deferReflectionsAndReport?: (trace: ReflectionTrace) => void
): Promise<RetrievedMemory[]> {
  const directLimit = options.limit ?? DEFAULT_LIMIT;
  const all = await getAllMemoryObjects();
  const pool = all.filter((memory) => !isSameConversation(memory.conversationId, options.excludeConversationId));
  const keywordFrequency = computeKeywordFrequency(all);
  const purpose = options.purposeRelevance === true ? purposeContextOf(trimmed, pool) : null;

  // 人物が話題のターンだけ、その人物の記録を整える（selectConversationWithPersons。人物が出てこないターンは従来の選定そのまま）
  const selected = selectConversationWithPersons(
    pool,
    trimmed,
    options.recentUserTurnsTexts ?? [],
    keywordFrequency,
    directLimit,
    Date.now(),
    options.personAliases ?? [],
    withPoolEvidence(options.recall ?? null, pool),
    purpose
  ).memories;
  // P1-F：本人の記録で枠を埋め直すことはしない（analystの選定はそのまま）。同じ会話の本人の記録と重なるReflectionを外し、残りを後ろに回すだけ
  let directMatches = selected;
  if (deferReflectionsAndReport) {
    const deferred = deferReflectionItems(selected, (memory) => memory, selected.length);
    directMatches = deferred.items;
    deferReflectionsAndReport(deferred.trace);
  }

  let divergentMatches: MemoryObject[] = [];
  if (options.includeDivergent) {
    const directIds = new Set(directMatches.map((memory) => memory.id));
    const divergentPool = pool.filter((memory) => !directIds.has(memory.id));
    divergentMatches = selectDivergentMemories(divergentPool, keywordFrequency, CREATIVE_DIVERGENT_COUNT);
  }

  return [
    ...directMatches.map((memory) => withTrait(toRetrievedMemory(memory, undefined, "direct", context), memory, purpose)),
    ...divergentMatches.map((memory) => toRetrievedMemory(memory, undefined, "divergent", context)),
  ];
}

// ---------------------------------------------------------------------------
// P1-F：会話のRetrievalでの、AIが書いた日記の振り返り（Reflection）の扱い
// ---------------------------------------------------------------------------

/** AIが書いた日記の振り返り（reflection.ts。本文も要約もAIの文章で、キーワードは元の記録と同じ） */
export function isReflectionMemory(memory: Pick<MemoryObject, "metadata">): boolean {
  return memory.metadata?.source === "system-generated";
}

/**
 * 発言が振り返り・日記に書いたことそのものを尋ねている（このときは従来どおり、本人の記録と同じ順位で選ぶ）。
 * 「振り返り」「日記」という語だけでは尋ねたことにしない（「今年の振り返り」「今日の日記」は日記を書いている・話しているだけ）
 */
const ASKS_ABOUT_REFLECTION = /(?:振り返り|ふりかえり|日記)[^。？?！!]*(?:書い|書か|残っ|残し|あっ|見せ|読み|読ん|教え|何て|なんて|どんな)/;
export function asksAboutReflection(text: string): boolean {
  return ASKS_ABOUT_REFLECTION.test(text.normalize("NFKC"));
}

/**
 * 会話のRetrieval（`deferReflections`）だけ：Reflectionは本人の記録の代わりにならない。
 * - 順位：スコアがあるとき（companion/coach）、Reflectionは自分のスコアの半分か1キーワード一致分（KEYWORD_WEIGHT）の低い方として並べる。
 *   キーワードが一致する本人の記録はその前に来るが、文字の偶然の重なりだけの弱い記録がReflectionを押し出すことはない。
 *   スコアが無いとき（analystの選定済みの一覧）は、本人の記録の後に回すだけ（埋め直さない）。
 * - 同じ会話の本人の記録が先頭`limit`件に入っていれば、そのReflectionは入れない（同じ会話をAIの文章で重ねて渡さない）。
 * スコア・本人の記録どうしの順は変えない。
 */
export function deferReflectionItems<T>(items: T[], memoryOf: (item: T) => MemoryObject, limit: number, scoreOf?: (item: T) => number): { items: T[]; trace: ReflectionTrace } {
  const keyOf = (item: T) => {
    if (!scoreOf) return isReflectionMemory(memoryOf(item)) ? 0 : 1;
    const score = scoreOf(item);
    return isReflectionMemory(memoryOf(item)) ? Math.min(score * 0.5, KEYWORD_WEIGHT) : score;
  };
  const order = (list: T[]) => list.map((item, index) => ({ item, index, key: keyOf(item), reflection: isReflectionMemory(memoryOf(item)) }))
    // 同じ値なら本人の記録を先に、あとは元の順
    .sort((a, b) => b.key - a.key || Number(a.reflection) - Number(b.reflection) || a.index - b.index)
    .map((x) => x.item);
  const trace: ReflectionTrace = { asksAboutReflection: false, deferred: [], dropped: [] };
  let kept = order(items);
  // Reflectionを外すと次の本人の記録が枠に入るので、その会話のReflectionも外す。枠が変わらなくなるまで繰り返す（毎回1件以上減るので止まる）
  for (;;) {
    const ownConversations = new Set(kept.slice(0, limit).filter((item) => !isReflectionMemory(memoryOf(item))).map((item) => memoryOf(item).conversationId).filter((id): id is string => Boolean(id)));
    const next = kept.filter((item) => {
      const memory = memoryOf(item);
      if (!isReflectionMemory(memory) || !memory.conversationId || !ownConversations.has(memory.conversationId)) return true;
      trace.dropped.push({ memoryId: memory.id, why: "同じ会話の本人の記録が選ばれている" });
      return false;
    });
    if (next.length === kept.length) break;
    kept = next;
  }
  kept.forEach((item, index) => {
    const memory = memoryOf(item);
    if (!isReflectionMemory(memory)) return;
    if (index < limit) trace.deferred.push(memory.id);
    else trace.dropped.push({ memoryId: memory.id, why: "本人の記録で枠が埋まった" });
  });
  return { items: kept, trace };
}

/** 質問の目的に応じた関連性（会話の画面だけ）：選ばれた記録の短い性質（recordRelevance.ts。目的が無ければ何も添えない） */
function withTrait(retrieved: RetrievedMemory, memory: MemoryObject, purpose: PurposeContext | null): RetrievedMemory {
  const trait = recordTraitOf(memory, purpose);
  return trait ? { ...retrieved, trait } : retrieved;
}

/** `context`：会話のRetrievalが`includeContext`で求めたときだけ、今の発言（と直前の発言）。人物と本人の発言の一文を添える（memoryContext.ts） */
function toRetrievedMemory(memory: MemoryObject, linkReason?: string, matchType?: "direct" | "divergent", context?: string[]): RetrievedMemory {
  return {
    id: memory.id,
    date: memory.date,
    eventTime: memory.eventTime,
    eventTimePrecision: memory.eventTimePrecision,
    summary: memory.summary,
    keywords: memory.keywords,
    linkReason,
    source: memory.metadata.source,
    matchType,
    ...(context ? memoryContextOf(memory, context) : {}),
  };
}

interface LinkedAddition {
  memory: MemoryObject;
  reason: string;
}

/**
 * directMatches（直接一致した記憶）が持つLinkを1-hopだけ辿り、まだ候補に無い記憶を
 * strengthの高い順に最大maxAdditions件選ぶ。strengthは直接一致スコアとは合成せず、
 * Link経由候補同士を選ぶためだけに使う（Linkは生成時点で既にstrength閾値を通過済みのため、
 * ここで改めて閾値フィルタはしない）。同じ候補が複数のLinkから見つかった場合は
 * strengthが最も高いものだけを残す（重複除外）。選ばれたLinkのreasonも一緒に返す。
 *
 * 通常会話（maxAdditions=1）では従来のpickLinkedAdditionと同じ結果を返す。
 * 明示的Reflection（maxAdditions=2, Memory Editing最小実装）でのみ複数件を返しうる。
 */
function pickLinkedAdditions(
  directMatches: MemoryObject[],
  allById: Map<string, MemoryObject>,
  excludeIds: Set<string>,
  maxAdditions: number,
  excludeConversationId?: string,
  /** P1-F：会話のRetrievalだけ。Link経由でも入れない記録（同じ会話の本人の記録がすでにあるReflection） */
  skip?: (candidate: MemoryObject) => boolean
): LinkedAddition[] {
  const bestByCandidateId = new Map<string, { memory: MemoryObject; strength: number; reason: string }>();

  for (const direct of directMatches) {
    for (const link of direct.links) {
      const candidateId = link.sourceId === direct.id ? link.targetId : link.sourceId;
      if (excludeIds.has(candidateId)) continue;
      const candidate = allById.get(candidateId);
      if (!candidate) continue;
      if (isSameConversation(candidate.conversationId, excludeConversationId)) continue;
      if (skip?.(candidate)) continue;
      const existing = bestByCandidateId.get(candidateId);
      if (!existing || link.strength > existing.strength) {
        bestByCandidateId.set(candidateId, { memory: candidate, strength: link.strength, reason: link.reason });
      }
    }
  }

  let pooled = [...bestByCandidateId.values()];
  if (skip) {
    // P1-F：Link経由の候補どうしでも、同じ会話の本人の記録が候補にあればReflectionは後に回す。
    // 本人の記録が先に枠を取るので、そのReflectionが入る余地は無い（＝入れない）
    const ownCandidateConversations = new Set(pooled.filter(({ memory }) => !isReflectionMemory(memory)).map(({ memory }) => memory.conversationId).filter(Boolean));
    pooled = pooled.filter(({ memory }) => !(isReflectionMemory(memory) && Boolean(memory.conversationId) && ownCandidateConversations.has(memory.conversationId)));
  }

  return pooled
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxAdditions)
    .map(({ memory, reason }) => ({ memory, reason }));
}

/**
 * Beta「過去からの問いかけ」起点Memory連携。promptedMemoryIdが指定されている場合のみ、
 * そのMemoryを検索スコアに関係なく必ず結果へ含める。既存の検索ロジック（スコアリング・
 * Link経由追加・analyst専用ロジック）には一切手を加えず、どちらの結果に対しても
 * 同じように最後に適用できる独立処理として分離する。
 * 既に結果に含まれている場合は新しいエントリを二重追加せず、既存エントリへ
 * isOriginMemoryフラグだけを立てる。
 */
async function ensureOriginMemoryIncluded(
  results: RetrievedMemory[],
  promptedMemoryId: string,
  context?: string[]
): Promise<RetrievedMemory[]> {
  const alreadyIncluded = results.some((memory) => memory.id === promptedMemoryId);
  if (alreadyIncluded) {
    return results.map((memory) =>
      memory.id === promptedMemoryId ? { ...memory, isOriginMemory: true } : memory
    );
  }

  const originMemory = await getMemoryObject(promptedMemoryId);
  if (!originMemory) return results;

  return [...results, { ...toRetrievedMemory(originMemory, undefined, undefined, context), isOriginMemory: true }];
}

/**
 * P1-F：会話のRetrievalの最後に、結果全体（Link経由・きっかけの記憶も含む）で同じ会話の本人の記録があるReflectionを外す。
 * きっかけの記憶（isOriginMemory）は外さない。結果は数件なので、Memoryは1件ずつ読む。
 */
async function dropReflectionsCoveredByOwnRecords(results: RetrievedMemory[], trace: ReflectionTrace): Promise<RetrievedMemory[]> {
  if (!results.some((r) => r.source === "system-generated")) return results;
  const memories = await Promise.all(results.map((r) => getMemoryObject(r.id)));
  const ownConversations = new Set(memories.filter((m): m is MemoryObject => Boolean(m) && !isReflectionMemory(m as MemoryObject)).map((m) => m.conversationId).filter(Boolean));
  const removed = new Set<string>();
  results.forEach((r, i) => {
    const m = memories[i];
    if (m && isReflectionMemory(m) && !r.isOriginMemory && m.conversationId && ownConversations.has(m.conversationId)) removed.add(r.id);
  });
  if (removed.size === 0) return results;
  trace.deferred = trace.deferred.filter((id) => !removed.has(id));
  const already = new Set(trace.dropped.map((d) => d.memoryId));
  for (const id of removed) if (!already.has(id)) trace.dropped.push({ memoryId: id, why: "同じ会話の本人の記録が選ばれている" });
  return results.filter((r) => !removed.has(r.id));
}

export interface CorrectionFinalizationOptions {
  /** 記録・整理リクエストのターンか（記録経路フォールバックの適用条件） */
  recordRequest: boolean;
  /**
   * フォールバックの「裏付け」に数えない記録の id（記録経路の薄さ対策で補完された本人の記録）。
   * 補完は「Reflection を外した後の記録に本人の言葉を残す」ための挿入であり、Reflection を
   * 残す根拠にはしない（従来の beforeFallback 基準の判定と最終結果の判定を一致させるため）。
   */
  nonBackingIds?: ReadonlySet<string>;
  /** 会話の画面の文脈（添付する訂正記録にも本人の発言・人物を添えるため。toRetrievedMemory の context と同じ） */
  context?: string[];
  /** 外した Reflection の通知（診断トレース用。結果そのものは変えない） */
  onRemoved?: (memoryId: string, why: string) => void;
}

/**
 * N6 訂正優先（案B・最終確定、オーナー承認 2026-11-21）: 訂正に関する不変条件を、経路ごとに
 * 途中段階のスナップショットへ書くのではなく、完成した結果リストに対して一箇所で言明する。
 * companion / coach / analyst が共有し、各経路の「全ての追加・選定が終わった後」の最後の
 * 段としてだけ呼ぶ（この関数の後に結果リストを変更する処理は置かない）。
 *
 * 検証する不変条件:
 * (a) ペアリング: 打ち消された Reflection は、訂正記録と対でなければ渡さない（対にできない
 *     場合は外す）。打ち消された本人の記録は残す（事実として）。
 * (b) 注記: 打ち消された記録が結果に残る場合は、必ず訂正注記（本人の訂正の逐語）を付ける。
 * (c) 記録経路フォールバック: 記録・整理リクエストでは、訂正情報の無い Reflection は、
 *     最終結果の中に同じ話題の本人の記録が一緒に無ければ材料にしない（入口が直接スコア・
 *     Link 追加・起点 Memory のどれでも同じ判定。索引が空の Vault でも働く）。
 *
 * 明示的な記録参照（起点 Memory、isOriginMemory）は外さない: 本人が特定の記録を呼び出した
 * 場合はアクセスを維持し、打ち消されていれば注記と訂正記録の対で「AI の文章である」ことと
 * 訂正を一緒に届ける（出典の区別は chat route が source から必ず表示する）。
 *
 * 対象外（従来の位置に残す）: 検出（correction.ts）、記録経路の保証配送と薄さ対策の補完
 * （枠の入れ替えを伴う挿入）、Timeline / Synthesis の消費。
 */
export function finalizeCorrectionInvariants(
  results: RetrievedMemory[],
  pool: readonly MemoryObject[],
  options: CorrectionFinalizationOptions
): RetrievedMemory[] {
  const index = correctionIndexOf(pool);
  if (index.size === 0 && !options.recordRequest) return results;
  const byId = new Map(pool.map((memory) => [memory.id, memory] as const));
  const present = new Set(results.map((item) => item.id));
  const notes = new Map<string, { quote: string }>();
  const kept: RetrievedMemory[] = [];
  const extra: RetrievedMemory[] = [];
  // (a) ペアリングと (b) 注記
  for (const item of results) {
    const link = index.get(item.id);
    if (!link) {
      kept.push(item);
      continue;
    }
    notes.set(item.id, { quote: link.correction.quote });
    if (present.has(link.correcting.id)) {
      kept.push(item);
      continue;
    }
    const target = byId.get(item.id);
    const reflection = target ? isReflectionMemory(target) : item.source === "system-generated";
    if (!reflection) {
      // 本人の記録自体は事実として残す。注記が付くので、古い理由が単独で「今の理由」にはならない
      kept.push(item);
      continue;
    }
    const correcting = byId.get(link.correcting.id);
    if (!correcting && !item.isOriginMemory) {
      options.onRemoved?.(item.id, "訂正と対にできないため除外（打ち消された解釈を単独で渡さない）");
      continue;
    }
    kept.push(item);
    if (correcting) {
      extra.push(toRetrievedMemory(correcting, undefined, undefined, options.context));
      present.add(correcting.id);
    }
  }
  let finalized = [...kept, ...extra];
  // (c) 記録経路フォールバック（最終結果に対して判定する）
  if (options.recordRequest) {
    const nonBacking = options.nonBackingIds;
    finalized = finalized.filter((item) => {
      if (item.isOriginMemory || index.has(item.id)) return true;
      const memory = byId.get(item.id);
      if (!memory || !isReflectionMemory(memory)) return true;
      const backed = finalized.some((other) => {
        if (other.id === item.id || nonBacking?.has(other.id)) return false;
        const otherMemory = byId.get(other.id);
        return Boolean(otherMemory) && !isReflectionMemory(otherMemory as MemoryObject) && shareThemeKeyword(otherMemory as MemoryObject, memory);
      });
      if (!backed) options.onRemoved?.(item.id, "記録経路: 同じ話題の本人の記録が無く、訂正情報も無いReflectionは材料にしない");
      return backed;
    });
  }
  if (notes.size === 0) return finalized;
  return finalized.map((item) => {
    const note = notes.get(item.id);
    return note ? { ...item, correctionNote: note } : item;
  });
}

export interface RetrieveRelevantMemoriesOptions {
  excludeConversationId?: string;
  limit?: number;
  maxLinkedAdditions?: number;
  persona?: Persona;
  promptedMemoryId?: string;
  /**
   * analyst専用。「あえて遠いMemory」（creative divergent）を追加するかどうか。
   * 既定はfalse相当（未指定）＝追加しない。companion/coachには影響しない
   * （retrieveCreativeMemories自体がanalystのときにしか呼ばれないため）。
   */
  includeDivergent?: boolean;
  /**
   * Conversation Retrieval用（analyst専用）。直近の同一Conversation内user turns本文
   * （最新発言含む）。deriveConversationTopicAnchorsでtopic anchor抽出にのみ使い、
   * turns全文を検索クエリへ連結することはしない。companion/coachのブランチは
   * このフィールドを読まないため、渡しても渡さなくても挙動に影響しない。
   */
  recentUserTurnsTexts?: string[];
  /**
   * 会話品質改善 第1段階（会話画面だけが渡す）。選ばれたMemoryに、その記録で本人が話題にした人と、要約に無い本人の発言の一文を添える
   * （1ターンに最大3件。memoryContext.ts）。未指定（Connect等）は従来どおり何も添えない。選ばれるMemory自体は変わらない。
   */
  includeContext?: boolean;
  /**
   * Memory Graph P1-B（会話画面が試験フラグONのときだけ渡す）。本人が確定した同じ人物の名前の組。人物を選ぶときに組を1人として扱う
   * （selectConversationWithPersons）。未指定・空なら従来どおり。
   */
  personAliases?: string[][];
  /**
   * P1-F（会話画面だけが渡す）：AIが書いた日記の振り返り（Reflection）を、本人の記録の後に回す（deferReflectionItems）。
   * 発言が振り返り・日記そのものを尋ねているときは従来どおり。未指定（Connect等）は従来どおり。
   */
  deferReflections?: boolean;
  /**
   * 会話の画面だけ（Connect等は渡さない）。発言が自分の過去を尋ねる質問（「過去にどんな車がいいって言ったっけ？」、recallQuestion.ts）のとき、
   * その話題の語を「一般語」として減点せず、「車」→「車種」「車選び」のような形の違いでも話題に一致した記録を数える。
   * companionでも、話題に一致せず文字の偶然の重なりだけの弱い記録（analystの最低点未満）は外す。過去を尋ねる質問でなければ従来どおり。
   */
  recallTopic?: boolean;
  /**
   * 会話の画面だけ（Connect等は渡さない）。質問の目的（好み・意見／望み／変化／人物の行動／質問そのもの）に応じて、話題に一致する記録だけを並べ替え、
   * 本人が過去を尋ねただけの記録は後ろに回す（recordRelevance.ts）。選んだ記録に短い性質（自動の目安）を添える。目的が分からない質問は従来の順位のまま。
   */
  purposeRelevance?: boolean;
  /** P1-F：診断（`?debugLog=1`）のときだけ会話画面が渡す。結果は変えず、Reflectionの扱いを知らせる */
  onReflectionTrace?: (trace: ReflectionTrace) => void;
  /**
   * 評価用（会話画面は渡さない）：companion/coach の人物機構で「深い過去」とみなす境界（日数）を差し替える。
   * 未指定は COMPANION_DEEP_PAST_DAYS。境界は暫定値であり、恒久的な製品ルールではない（評価で比較して決める）。
   */
  deepPastDays?: number;
  /** 診断・評価用：人物機構の判定（特定した人物・ゲート・深い過去の除外・補完の入れ替え）を知らせる。結果は変えない */
  onPersonTrace?: (trace: PersonRetrievalTrace) => void;
}

/**
 * 「深い過去」の境界（日数。暫定）。ゲートが閉じているとき、対象人物の記録がこれより古く、人物以外のつながりが
 * 無ければ候補から外す。評価フィクスチャでは「気まずい」記録（119日）が深く、「謝った」記録（70日）が深くない
 * 境界にあり、90 はその中間。既存の暫定値と同じく、実データで調整する前提で1か所に置く。
 */
export const COMPANION_DEEP_PAST_DAYS = 90;

/** companion/coach の人物機構の診断（評価・`?debugLog=1` 相当の用途だけ。選定そのものは変えない） */
export interface PersonRetrievalTrace {
  /** 段階1で特定した人物（特定できなければ null＝従来の選定そのまま） */
  person: { key: string; how: "named" | "carried" } | null;
  /** 段階3の変化／振り返りゲートが開いたか */
  gateOpen: boolean;
  /** P4：深い過去で、人物以外のつながりが無く候補から外した記録 */
  excludedDeepPast: string[];
  /** 段階4の補完で枠から出した記録（何の枠を空けたか） */
  evictions: { memoryId: string; why: string; forId: string }[];
  /** 段階4の補完で入れた記録と、その役割 */
  completed: { memoryId: string; role: "newest" | "before" | "change" }[];
}

/**
 * Vault境界の安全性（H4対応）：共有ロック＋epoch確認で包んだ公開版。実処理は
 * `retrieveRelevantMemoriesImpl`（ロックを取得しない内部専用版）。connect.tsの
 * connectMemory()は、自身が既にロックを保持している間はこの公開版ではなく
 * `retrieveRelevantMemoriesImpl`を直接呼ぶこと（ネスト回避。vaultWorldLock.ts参照）。
 */
export async function retrieveRelevantMemories(
  queryText: string,
  options: RetrieveRelevantMemoriesOptions = {}
): Promise<RetrievedMemory[]> {
  return withVaultWorldRead(() => retrieveRelevantMemoriesImpl(queryText, options));
}

export async function retrieveRelevantMemoriesImpl(
  queryText: string,
  options: RetrieveRelevantMemoriesOptions = {}
): Promise<RetrievedMemory[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];
  const context = options.includeContext ? [trimmed, ...(options.recentUserTurnsTexts ?? []).slice(-3)] : undefined;
  const withContext = (memories: RetrievedMemory[]) => (context ? limitMemoryQuotes(memories, trimmed) : memories);

  // クリエイト（analyst）だけ別ロジックへ委譲する。companion/coachはこの下の
  // 既存ロジックをそのまま通る（挙動は一切変えていない）。
  const deferReflections = options.deferReflections === true && !asksAboutReflection(trimmed);
  const recall = options.recallTopic === true ? recallTopicOf(trimmed) : null;
  const report = (trace: ReflectionTrace) => {
    try {
      options.onReflectionTrace?.(trace);
    } catch {
      // 診断の失敗で会話を止めない
    }
  };
  const reportPerson = (trace: PersonRetrievalTrace) => {
    try {
      options.onPersonTrace?.(trace);
    } catch {
      // 診断の失敗で会話を止めない
    }
  };

  if (options.persona === "analyst") {
    if (options.deferReflections && !deferReflections) report({ asksAboutReflection: true, deferred: [], dropped: [] });
    let analystTrace: ReflectionTrace | null = null;
    const creativeResults = await retrieveCreativeMemories(trimmed, { ...options, recall }, context, deferReflections ? (trace) => { analystTrace = trace; } : undefined);
    const withOrigin = options.promptedMemoryId
      ? await ensureOriginMemoryIncluded(creativeResults, options.promptedMemoryId, context)
      : creativeResults;
    const covered = analystTrace ? await dropReflectionsCoveredByOwnRecords(withOrigin, analystTrace) : withOrigin;
    // N6 訂正優先（案B・最終確定）: analyst も会話経路と同じ最終確定関数を通す（ペアリング・
    // 注記・記録経路フォールバックを最終結果に対して一括で適用。選定そのものは変えない）。
    // 索引の土台は従来の注記パスと同じ（今の会話を除いたプール）。
    const analystAll = await getAllMemoryObjects();
    const analystPool = analystAll.filter((memory) => !isSameConversation(memory.conversationId, options.excludeConversationId));
    // analystTrace はコールバックで代入されるため、型検査のフロー解析では null に狭まって見える。実型で読み直す
    const traceSnapshot = analystTrace as ReflectionTrace | null;
    let analystOnRemoved: ((memoryId: string, why: string) => void) | undefined;
    if (traceSnapshot) {
      const trace = traceSnapshot;
      analystOnRemoved = (memoryId, why) => {
        trace.deferred = trace.deferred.filter((id) => id !== memoryId);
        trace.dropped.push({ memoryId, why });
      };
    }
    const finalized = finalizeCorrectionInvariants(covered, analystPool, {
      recordRequest: isRecordRequestTurn(trimmed),
      context,
      onRemoved: analystOnRemoved,
    });
    if (analystTrace) report(analystTrace);
    return withContext(finalized);
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxLinkedAdditions = options.maxLinkedAdditions ?? MAX_LINKED_ADDITIONS;
  const all = await getAllMemoryObjects();

  const searchable = all.filter((memory) => !isSameConversation(memory.conversationId, options.excludeConversationId));
  const purpose = options.purposeRelevance === true ? purposeContextOf(trimmed, searchable) : null;
  // 会話の画面で過去の行動の理由を尋ねるとき：話題は尋ねた行動（主題）の語だけ。「理由」などの理由の語は話題の根拠にしない
  // （「旅行をやめた理由って何だったっけ？」の「理由」で「転職をやめた理由を…」を話題に一致させない）
  const topic = withPoolEvidence(purpose?.reasonAsked && purpose.reasonSubject ? subjectTermsOf(recall, purpose.reasonSubject) : recall, searchable);
  // 会話の画面（purposeRelevanceを渡す）だけ、弱い文字の重なりの根拠を確かめる。Connect等は従来どおり
  const weakGate = options.purposeRelevance === true;
  const poolTexts = weakGate ? searchable.map((memory) => `${memory.summary} ${memory.content}`.replace(/\s+/g, "")) : [];
  // a person of the record is named in the turn (as purposeContextOf reads it: 「ゆうき」 names 「ゆうきさん」). A keyword hit already passes the floor
  const namesPerson = (memory: MemoryObject) =>
    (purpose?.namedPersons.length ?? 0) > 0 &&
    (memory.personMentions ?? []).some((p) => typeof p?.displayName === "string" && purpose!.namedPersons.includes(p.displayName.normalize("NFKC").trim()));

  // companion/coach の人物機構（段階1〜4＋P4）。会話の画面（purposeRelevance）だけ有効で、Connect・Capture の候補探しは
  // 従来どおり。人物が特定できなければ、このターンは従来の選定と1件も変わらない。人物の特定と深掘りは分ける：
  // 特定だけでは記録は足さず、加点・他人のみの記録の除外・深い過去の除外（ゲートが閉じているとき）だけが効き、
  // 時系列の補完は補完パス（上限切りの後）で、ゲートが開いたときだけ以前の端・変化の記録まで広げる。
  const deepPastDays = options.deepPastDays ?? COMPANION_DEEP_PAST_DAYS;
  const personRes = weakGate ? resolveTurnPerson(searchable, trimmed, options.recentUserTurnsTexts ?? [], options.personAliases ?? []) : null;
  const personGateOpen = personRes ? personChangeGate(trimmed, personRes) : false;
  const personTrace: PersonRetrievalTrace = {
    person: personRes ? { key: personRes.key, how: personRes.how } : null,
    gateOpen: personGateOpen,
    excludedDeepPast: [],
    evictions: [],
    completed: [],
  };
  const isAboutTarget = (memory: MemoryObject) => personRes !== null && personRes.targetKeys.some((key) => isAboutPerson(memory, key));
  const aboutOther = (memory: MemoryObject) => personRes !== null && personRes.keys.some((key) => !personRes.targetKeys.includes(key) && isAboutPerson(memory, key));
  /** 別の人物だけの記録（対象人物と別の人物の両方に関わる記録は残す。analyst と同じ規則） */
  const otherOnly = (memory: MemoryObject) => aboutOther(memory) && !isAboutTarget(memory);
  const personNow = Date.now();
  /** 対象人物の現在の端：Reflection を除いた最新の記録（現在の状態は本人の記録で表す） */
  const newestTarget = personRes
    ? (searchable.filter((memory) => isAboutTarget(memory) && !isReflectionMemory(memory)).sort((a, b) => memoryTime(b) - memoryTime(a))[0] ?? null)
    : null;
  // 名前を除いた会話（P4 の「人物以外のつながり」の判定用。analyst の ownKeywordHits と同じ作り）
  const personQuery = personRes ? personMaskedQuery((options.recentUserTurnsTexts ?? []).map(normalizeTwoPeople), normalizeTwoPeople(trimmed), personRes.keys) : "";
  const maskNames = (text: string) => {
    if (!personRes) return text;
    let masked = text ?? "";
    for (const key of [...personRes.keys].sort((a, b) => Array.from(b).length - Array.from(a).length)) masked = masked.split(key).join("■");
    return masked.replace(/(さん|ちゃん|くん|君|様|氏)/g, "■");
  };
  const maskedPoolTexts = personRes && !personGateOpen ? searchable.map((memory) => `${maskNames(memory.summary)} ${maskNames(memory.content)}`) : [];
  /** 話題の語が人物名そのものか（P4 の受け皿では、人物名による話題の一致は「人物以外のつながり」に数えない） */
  const isPersonNameTerm = (term: string) => (personRes?.keys ?? []).some((key) => key === term || key.includes(term) || term.includes(key));
  /** P4 の受け皿：人物以外のつながりがあるか（最新の記録／名前以外のキーワードの一致／話題の一致・理由の記録／名前を伏せた文字列の共有） */
  const hasNonPersonTie = (entry: { memory: MemoryObject; topicMatched: boolean; reasonAnswer: boolean }): boolean => {
    if (!personRes) return true;
    const memory = entry.memory;
    if (newestTarget && memory.id === newestTarget.id) return true;
    if (ownKeywordHitsOf(memory, personQuery, personRes.keys) >= 1) return true;
    if (entry.topicMatched || entry.reasonAnswer) return true;
    const maskedMemory = { ...memory, summary: maskNames(memory.summary), content: maskNames(memory.content) } as MemoryObject;
    return hasDistinctSharedRun(maskNames(trimmed), maskedMemory, maskedPoolTexts);
  };
  /** P4：ゲートが閉じているとき、深い過去の対象人物の記録で、人物以外のつながりが無いものを候補から外す（ゲートが開けば全面的に緩む） */
  const deepPastExcluded = (entry: { memory: MemoryObject; topicMatched: boolean; reasonAnswer: boolean }): boolean =>
    personRes !== null && !personGateOpen && isAboutTarget(entry.memory) && personNow - memoryTime(entry.memory) > deepPastDays * DAY_MS_RETRIEVAL && !hasNonPersonTie(entry);

  const candidates = searchable
    .map((memory) => {
      const match = topic ? matchRecallTopic(memory, topic, trimmed) : null;
      const bonus = match ? (match.matched.length - match.coveredByKeyword.length) * KEYWORD_WEIGHT : 0;
      // 段階2の加点：対象人物の記録に PERSON_CARRY_WEIGHT（adjustForPurpose の前。analyst の引き継ぎ加点と同じ位置・同じ値）
      const personBonus = personRes && isAboutTarget(memory) ? PERSON_CARRY_WEIGHT : 0;
      // 件数・Reflectionの扱いより前に、質問の目的で加点・減点する（話題に一致する記録だけ。目的が無ければ尋ねただけの記録を後ろに回すだけ）
      const adjusted = adjustForPurpose(memory, scoreMemory(memory, trimmed) + bonus + personBonus, purpose, trimmed, (match?.matched.length ?? 0) > 0, KEYWORD_WEIGHT, CONVERSATION_MIN_SCORE);
      // P4 の受け皿用の話題一致：人物名そのものの語による一致は除く（名前で一致しただけでは、深い過去のつながりにしない）
      const topicMatched = match ? match.matched.some((term) => !isPersonNameTerm(term)) : false;
      return { memory, score: adjusted.score, onTopic: adjusted.onTopic, demoted: adjusted.demoted, reasonAnswer: adjusted.reasonAnswer === true, topicMatched };
    })
    // スコア0（関連なし）は返さない。無理に件数を埋めない（MEMORY_ENGINE.md 7.4）。
    .filter((entry) => entry.score > 0)
    // 会話の画面だけ：キーワード・話題・人物のどれにも一致しない最低点未満の弱い記録は、珍しい続いた文字列を共有するときだけ（hasDistinctSharedRun）
    .filter((entry) => !weakGate || entry.score >= CONVERSATION_MIN_SCORE || entry.onTopic || entry.reasonAnswer || namesPerson(entry.memory) || hasDistinctSharedRun(trimmed, entry.memory, poolTexts))
    // 段階2：別の人物だけの記録は候補に入れない（人物が特定できたときだけ）
    .filter((entry) => !personRes || !otherOnly(entry.memory))
    // P4：深い過去の除外（ゲートが閉じているときだけ。除外した記録は診断に残す）
    .filter((entry) => {
      if (!deepPastExcluded(entry)) return true;
      personTrace.excludedDeepPast.push(entry.memory.id);
      return false;
    });
  /** 補完パスの下限判定用：候補として成立していた記録（スコア計算・足切り・人物の除外を通過したもの） */
  const candidateIds = new Set(candidates.map((entry) => entry.memory.id));
  // 過去を尋ねる質問（話題の語があるとき）・目的が分かる過去の質問：話題に一致せず、analystの最低点にも届かない弱い記録（文字の偶然の重なりだけ）は入れない（analystと同じ基準）
  // 過去の行動の理由を尋ねる質問（それだけのとき）も同じ。ただし、名前を挙げた人物の記録と、尋ねた行動（主題）の中の珍しい文字列を共有する記録は残す
  // （hasSubjectRun。「旅行をやめた」に「転職をやめた」は入れない）。本人の理由・訂正（reasonAnswer）は最低点＋1キーワード分あるので残る
  const reasonOnly = !topic && !purpose?.purpose && purpose?.reasonAsked === true && Boolean(purpose.reasonSubject);
  const ranked = (topic || purpose?.purpose || reasonOnly
    ? candidates.filter((entry) => entry.onTopic || entry.score >= CONVERSATION_MIN_SCORE || (reasonOnly && (namesPerson(entry.memory) || hasSubjectRun(entry.memory, poolTexts, purpose!.reasonSubject!))))
    : candidates)
    .sort((a, b) => b.score - a.score || Number(a.demoted) - Number(b.demoted))
    .map(({ memory, score, reasonAnswer }) => ({ memory, score, reasonAnswer }));
  // P1-F：会話のRetrievalだけ、Reflectionを本人の記録の後に回す（未指定なら従来の順のまま）
  const deferred = deferReflections ? deferReflectionItems(ranked, (entry) => entry.memory, limit, (entry) => entry.score) : null;
  let scored = (deferred ? deferred.items : ranked).slice(0, limit);

  // 段階2の保証＋段階4の補完（枠内の入れ替えだけ。追加枠は作らない）。Reflection の後ろ倒しの後に置く
  // （後ろ倒しで落ちた記録を補完が拾い直さないため）。人物が特定できなければ何もしない。
  // 処理は優先順に1件ずつ：現在の端 →（ゲートが開いているとき）以前の端 → 変化の記録。
  // 弧の選定は、現在の端の入れ替えが終わった後の選定に対して行う（入れ替えで外れた記録が「以前の端」になりうるため）。
  if (personRes) {
    const droppedByDefer = new Set((deferred?.trace.dropped ?? []).map((d) => d.memoryId));
    const scoreOf = new Map(ranked.map((entry) => [entry.memory.id, entry.score] as const));
    /** 弧の候補条件（対象人物だけ・本人の言葉・Reflection でない・尋ねただけではない・365日以内）。最新保証の下限の片方 */
    const arcEligible = (memory: MemoryObject) =>
      isAboutTarget(memory) && !aboutOther(memory) && !isReflectionMemory(memory) && !isRecallOnlyRecord(memory) &&
      (memory.evidenceQuotes ?? []).some((quote) => typeof quote === "string" && quote.trim().length > 0) &&
      personNow - memoryTime(memory) <= PERSON_ARC_MAX_AGE_DAYS * DAY_MS_RETRIEVAL;
    const appended = new Set<string>();
    /** 追い出しから保護する記録：既に満たされた必要な記録と、変化の時点の基準になった変化の記録 */
    const protectedIds = new Set<string>();
    const tryComplete = (memory: MemoryObject, role: "newest" | "before" | "change") => {
      if (scored.some((entry) => entry.memory.id === memory.id) || appended.has(memory.id)) {
        protectedIds.add(memory.id);
        return;
      }
      const evictable = scored.filter((entry) => !protectedIds.has(entry.memory.id) && !appended.has(entry.memory.id) && !entry.reasonAnswer);
      // 第1順位：対象人物に関わらない記録（スコアの低いものから）。第2順位：対象人物の記録のうち必要な記録でないもの（低いものから、同点なら古いものから）
      const victim =
        evictable.filter((entry) => !isAboutTarget(entry.memory)).sort((a, b) => a.score - b.score)[0] ??
        evictable.filter((entry) => isAboutTarget(entry.memory)).sort((a, b) => a.score - b.score || memoryTime(a.memory) - memoryTime(b.memory))[0];
      if (!victim) return; // 追い出せる記録が無ければ、その必要な記録は諦める（ペアは不完全のまま）
      scored = scored.filter((entry) => entry.memory.id !== victim.memory.id);
      scored = [...scored, { memory, score: scoreOf.get(memory.id) ?? 0, reasonAnswer: false }];
      appended.add(memory.id);
      protectedIds.add(memory.id);
      personTrace.evictions.push({
        memoryId: victim.memory.id,
        why: isAboutTarget(victim.memory) ? "補完のため除外：対象人物の記録だが、現在の端・以前の端・変化の記録ではない" : "補完のため除外：対象人物の記録ではない",
        forId: memory.id,
      });
      personTrace.completed.push({ memoryId: memory.id, role });
    };
    // 現在の端（ゲートの開閉によらず）。下限：候補として成立していた、または弧の候補条件を満たす記録だけを保証する
    if (newestTarget && !droppedByDefer.has(newestTarget.id) && (candidateIds.has(newestTarget.id) || arcEligible(newestTarget))) {
      tryComplete(newestTarget, "newest");
    }
    if (personGateOpen) {
      const includedIds = new Set(scored.map((entry) => entry.memory.id));
      const arc = pickPersonArc(searchable, { keys: personRes.keys, targetKeys: personRes.targetKeys, includedIds, now: personNow });
      // 変化の記録が既に選定内にあるときは「時点の基準」として満たされたものとし、追い出しから保護する
      if (arc.change && includedIds.has(arc.change.id)) protectedIds.add(arc.change.id);
      if (arc.before && !droppedByDefer.has(arc.before.id)) tryComplete(arc.before, "before");
      if (arc.change && !includedIds.has(arc.change.id) && !droppedByDefer.has(arc.change.id)) tryComplete(arc.change, "change");
    }
    if (appended.size > 0) {
      // 補完した記録は直接一致の末尾に古い順で置く（analyst が弧を古い順に渡す流儀に合わせ、時系列として読めるように）
      const tail = scored.filter((entry) => appended.has(entry.memory.id)).sort((a, b) => memoryTime(a.memory) - memoryTime(b.memory));
      scored = [...scored.filter((entry) => !appended.has(entry.memory.id)), ...tail];
    }
  }
  if (weakGate) reportPerson(personTrace);

  // N6 訂正優先（案B 消費側＋案C 記録経路）: 会話の画面だけ（weakGate。人物機構と同じ境界）。
  // ここで行うのは「選定への挿入」だけ（枠の入れ替えを伴うため、最終確定には含めない）:
  // - 記録・整理のリクエストでは、その話題の訂正記録を、話題の語が今の発言になくても必ず入れる（保証配送）。
  // - 記録経路の薄さ対策: 裏付けの無い Reflection だけが話題の材料になっている場合、その話題の
  //   本人の記録を補完する（補完した記録は、最終確定のフォールバック判定では裏付けに数えない）。
  // ペアリング・注記・フォールバックの不変条件そのものは途中段階では検査せず、結果が完成した後に
  // finalizeCorrectionInvariants が最終結果に対して一括で適用する。
  const fallbackCompletionIds = new Set<string>();
  if (weakGate) {
    const correctionIndex = correctionIndexOf(searchable);
    const recordRequest = isRecordRequestTurn(trimmed);
    if (correctionIndex.size > 0 || recordRequest) {
      const byId = new Map(searchable.map((memory) => [memory.id, memory] as const));
      const rankedScore = new Map(ranked.map((entry) => [entry.memory.id, entry.score] as const));
      const correctingIds = new Set([...correctionIndex.values()].map((link) => link.correcting.id));
      const appendedCorrections: MemoryObject[] = [];
      /** 最終確定のフォールバック判定で「裏付け」になる本人の記録（補完の入れ替えで追い出さない） */
      const fallbackProtectedIds = new Set<string>();
      /** 人物補完（tryComplete）と同じ作法: 原則は枠内の入れ替えだけ。理由の記録（reasonAnswer）と訂正記録は追い出さない */
      const addByEviction = (memory: MemoryObject): boolean => {
        if (scored.some((entry) => entry.memory.id === memory.id)) return true;
        // 枠に空きがある（上限未満）のに追い出せる記録が無い場合（選定が空・全て保護対象）は、
        // 入れ替えではなく直接追加で保証を果たす（上限は超えない。第2ラウンド P2-2）
        if (scored.length < limit) {
          scored = [...scored, { memory, score: rankedScore.get(memory.id) ?? 0, reasonAnswer: false }];
          appendedCorrections.push(memory);
          return true;
        }
        const victim = scored
          .filter((entry) => !entry.reasonAnswer && !correctingIds.has(entry.memory.id) && !fallbackProtectedIds.has(entry.memory.id) && !appendedCorrections.some((m) => m.id === entry.memory.id))
          .sort((a, b) => a.score - b.score || memoryTime(a.memory) - memoryTime(b.memory))[0];
        if (!victim) return false;
        scored = scored.filter((entry) => entry.memory.id !== victim.memory.id);
        scored = [...scored, { memory, score: rankedScore.get(memory.id) ?? 0, reasonAnswer: false }];
        appendedCorrections.push(memory);
        return true;
      };
      // 記録経路の保証: 会話のどこかで話題が出ている訂正は、今の発言に話題の語が無くても入れる（新しいものから最大2件）
      if (recordRequest && correctionIndex.size > 0) {
        const conversationText = [trimmed, ...(options.recentUserTurnsTexts ?? [])].join(" ");
        const targetsByCorrecting = new Map<string, MemoryObject[]>();
        for (const [targetId, link] of correctionIndex) {
          const target = byId.get(targetId);
          if (!target) continue;
          const list = targetsByCorrecting.get(link.correcting.id) ?? [];
          list.push(target);
          targetsByCorrecting.set(link.correcting.id, list);
        }
        const themeCorrecting = [...targetsByCorrecting.entries()]
          .map(([id, targets]) => ({ memory: byId.get(id)!, targets }))
          .filter(({ memory, targets }) => memory && correctionThemeInText(memory, targets, conversationText))
          .sort((a, b) => memoryTime(b.memory) - memoryTime(a.memory))
          .slice(0, 2);
        for (const { memory } of themeCorrecting) addByEviction(memory);
      }
      // 記録経路のフォールバックに向けた挿入（裏付けの保護と薄さ対策の補完）。
      // Reflection を外すかどうか自体は最終確定（finalizeCorrectionInvariants）が最終結果で判定する。
      if (recordRequest) {
        const beforeFallback = scored;
        // 補完の入れ替えで、別の Reflection の「裏付け」になっている本人の記録を追い出さない
        // （裏付けの判定は最終確定が最終結果に対して行うため、追い出すと最終結果で裏付けが
        // 消え、裏付けありとされた Reflection が単独で残ってしまう。Codex 再レビュー on PR #63）
        for (const entry of beforeFallback) {
          if (!isReflectionMemory(entry.memory) || correctionIndex.has(entry.memory.id)) continue;
          for (const other of beforeFallback) {
            if (other.memory.id !== entry.memory.id && !isReflectionMemory(other.memory) && shareThemeKeyword(other.memory, entry.memory)) {
              fallbackProtectedIds.add(other.memory.id);
            }
          }
        }
        // 薄さ対策（第2ラウンド）: Reflection だけがその話題の材料になっている場合、外される前に、
        // その話題の本人の記録（本人の逐語を持つもの、新しいものから最大2件）を補完する。
        // 本人の後の発言が基礎の検索で選ばれていない場面でも、記録が本人の言葉で厚みを保てる。
        // Reflection 自体は最終確定で従来どおり外れる（補完した記録は最終確定の「裏付け」に
        // 数えない＝fallbackCompletionIds に記録する）ため、安全条件（古い AI の解釈を本人の
        // 確定した理由として単独で記録しない）は弱まらない。
        for (const entry of beforeFallback) {
          if (!isReflectionMemory(entry.memory) || correctionIndex.has(entry.memory.id)) continue;
          const hasOwnCompany = beforeFallback.some((other) => other.memory.id !== entry.memory.id && !isReflectionMemory(other.memory) && shareThemeKeyword(other.memory, entry.memory));
          if (hasOwnCompany) continue;
          const ownCandidates = searchable
            .filter((m) => !isReflectionMemory(m) && !scored.some((e) => e.memory.id === m.id) && shareThemeKeyword(m, entry.memory) && (m.evidenceQuotes ?? []).some((q) => typeof q === "string" && q.trim().length > 0))
            .sort((a, b) => memoryTime(b) - memoryTime(a))
            .slice(0, 2);
          for (const candidate of ownCandidates) {
            if (addByEviction(candidate)) fallbackCompletionIds.add(candidate.id);
          }
        }
      }
      if (appendedCorrections.length > 0) {
        const tail = scored.filter((entry) => appendedCorrections.some((m) => m.id === entry.memory.id)).sort((a, b) => memoryTime(a.memory) - memoryTime(b.memory));
        scored = [...scored.filter((entry) => !appendedCorrections.some((m) => m.id === entry.memory.id)), ...tail];
      }
    }
  }

  const directMatches = scored.map((entry) => entry.memory);
  const results: RetrievedMemory[] = directMatches.map((memory) => withTrait(toRetrievedMemory(memory, undefined, undefined, context), memory, purpose));

  // Link経由の追加は、直接一致がlimitを埋めているかどうかに関係なく常に探索する
  // （直接一致件数とは独立の別枠。直接一致のスコアリングやpickLinkedAdditions自体のロジックは変更しない）。
  {
    const allById = new Map(all.map((memory) => [memory.id, memory]));
    const excludeIds = new Set(directMatches.map((memory) => memory.id));
    const ownConversations = new Set(directMatches.filter((memory) => !isReflectionMemory(memory)).map((memory) => memory.conversationId).filter(Boolean));
    // §6.4：人物が特定できたときは、Link経由でも別の人物だけの記録と、つながりの無い深い過去の記録を入れない
    // （直接一致で塞いだ問題が +1 件の裏口から戻らないように。候補として残った記録は、その記録自身のつながり判定を使う）
    const candidateById = new Map(candidates.map((entry) => [entry.memory.id, entry] as const));
    const personSkip = personRes
      ? (candidate: MemoryObject) =>
          otherOnly(candidate) ||
          deepPastExcluded(candidateById.get(candidate.id) ?? { memory: candidate, topicMatched: topic ? matchRecallTopic(candidate, topic, trimmed).matched.some((term) => !isPersonNameTerm(term)) : false, reasonAnswer: false })
      : null;
    const reflectionSkip = deferReflections
      ? (candidate: MemoryObject) => isReflectionMemory(candidate) && ((Boolean(candidate.conversationId) && ownConversations.has(candidate.conversationId)) || (deferred?.trace.dropped.some((d) => d.memoryId === candidate.id) ?? false))
      : null;
    const additions = pickLinkedAdditions(
      directMatches,
      allById,
      excludeIds,
      maxLinkedAdditions,
      options.excludeConversationId,
      // Link経由でも、同じ会話の本人の記録がある・枠から外したReflectionは入れない（診断の表示と食い違わないように）
      reflectionSkip || personSkip ? (candidate) => (reflectionSkip?.(candidate) ?? false) || (personSkip?.(candidate) ?? false) : undefined
    );
    for (const addition of additions) {
      results.push(toRetrievedMemory(addition.memory, addition.reason, undefined, context));
    }
    // P1-F：Link経由で本人の記録が入った会話の、直接一致のReflectionも外す（同じ会話をAIの文章で重ねて渡さない）
    if (deferred) {
      const linkedOwnConversations = new Set(additions.filter(({ memory }) => !isReflectionMemory(memory)).map(({ memory }) => memory.conversationId).filter(Boolean));
      const removed = new Set(directMatches.filter((memory) => isReflectionMemory(memory) && Boolean(memory.conversationId) && linkedOwnConversations.has(memory.conversationId)).map((memory) => memory.id));
      if (removed.size > 0) {
        for (let i = results.length - 1; i >= 0; i -= 1) if (removed.has(results[i].id) && !results[i].linkReason) results.splice(i, 1);
        deferred.trace.deferred = deferred.trace.deferred.filter((id) => !removed.has(id));
        for (const id of removed) deferred.trace.dropped.push({ memoryId: id, why: "同じ会話の本人の記録がLink経由で選ばれている" });
      }
    }
  }
  const capped = results.slice(0, limit + maxLinkedAdditions);
  let withOrigin = options.promptedMemoryId ? await ensureOriginMemoryIncluded(capped, options.promptedMemoryId, context) : capped;
  // P1-F: 結果全体で、同じ会話の本人の記録がある Reflection を外す。外すだけの処理は
  // 不変条件を壊さないため、最終確定より前に置く（最終確定の後に結果は変更しない）。
  if (deferred) {
    withOrigin = await dropReflectionsCoveredByOwnRecords(withOrigin, deferred.trace);
  }
  // N6 訂正優先（案B・最終確定）: 全ての追加・選定（直接一致・補完・Link 追加・起点 Memory・
  // P1-F の除去）が終わった最終結果に対して、共有の最終確定関数が不変条件（ペアリング・
  // 注記・記録経路フォールバック）を一括で適用する。会話の画面だけ（weakGate）。
  const finalized = weakGate
    ? finalizeCorrectionInvariants(withOrigin, all, {
        recordRequest: isRecordRequestTurn(trimmed),
        nonBackingIds: fallbackCompletionIds,
        context,
        onRemoved: deferred
          ? (memoryId, why) => {
              deferred.trace.deferred = deferred.trace.deferred.filter((id) => id !== memoryId);
              deferred.trace.dropped.push({ memoryId, why });
            }
          : undefined,
      })
    : withOrigin;
  if (deferred) report(deferred.trace);
  if (options.deferReflections && !deferred) report({ asksAboutReflection: true, deferred: [], dropped: [] });
  return withContext(finalized);
}
