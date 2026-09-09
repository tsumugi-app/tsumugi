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
function genericKeywordPenalty(memory: MemoryObject, trimmed: string, keywordFrequency: Map<string, number>): number {
  const hits = memory.keywords.filter((keyword) => keyword && trimmed.includes(keyword));
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

export interface ConversationCandidateScore {
  memory: MemoryObject;
  /** 既存scoreMemory()の生値（未補正）。 */
  queryScore: number;
  /** 一般的なkeywordの寄与を減衰させた分（正の値。scoreからはこの分を引く）。 */
  genericPenalty: number;
  /** 直近turnsでの継続によるボーナス（加点）。 */
  anchorBonus: number;
  /** queryScore - genericPenalty + anchorBonus。実際の順位付け・floor判定に使う値。 */
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
  keywordFrequency: Map<string, number>
): ConversationCandidateScore[] {
  return pool.map((memory) => {
    const queryScore = scoreMemory(memory, trimmed);
    const genericPenalty = genericKeywordPenalty(memory, trimmed, keywordFrequency);
    const anchorBonus = conversationAnchorScore(memory, anchors);
    return { memory, queryScore, genericPenalty, anchorBonus, conversationScore: queryScore - genericPenalty + anchorBonus };
  });
}

export interface ConversationDirectSelection {
  anchors: ConversationTopicAnchor[];
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
  limit: number
): ConversationDirectSelection {
  const anchors = deriveConversationTopicAnchors(recentUserTurnsTexts, keywordFrequency);
  const allScored = scoreConversationCandidates(pool, trimmed, anchors, keywordFrequency);

  const aboveFloor = allScored.filter((entry) => entry.conversationScore >= CONVERSATION_MIN_SCORE);
  const droppedByFloor = allScored
    .filter((entry) => entry.conversationScore > 0 && entry.conversationScore < CONVERSATION_MIN_SCORE)
    .sort((a, b) => b.conversationScore - a.conversationScore);

  const sorted = [...aboveFloor].sort((a, b) => b.conversationScore - a.conversationScore).slice(0, limit);

  const relativeInput = sorted.map((entry) => ({ memory: entry.memory, score: entry.conversationScore }));
  const keptIds = new Set(applyRelativeStrengthFilter(relativeInput).map((entry) => entry.memory.id));
  const kept = sorted.filter((entry) => keptIds.has(entry.memory.id));
  const droppedByRelativeStrength = sorted.filter((entry) => !keptIds.has(entry.memory.id));

  return { anchors, consideredCount: allScored.length, kept, droppedByFloor, droppedByRelativeStrength };
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
  }
): Promise<RetrievedMemory[]> {
  const directLimit = options.limit ?? DEFAULT_LIMIT;
  const all = await getAllMemoryObjects();
  const pool = all.filter((memory) => !isSameConversation(memory.conversationId, options.excludeConversationId));
  const keywordFrequency = computeKeywordFrequency(all);

  const { kept } = selectConversationDirectMatches(
    pool,
    trimmed,
    options.recentUserTurnsTexts ?? [],
    keywordFrequency,
    directLimit
  );
  const directMatches = kept.map((entry) => entry.memory);

  let divergentMatches: MemoryObject[] = [];
  if (options.includeDivergent) {
    const directIds = new Set(directMatches.map((memory) => memory.id));
    const divergentPool = pool.filter((memory) => !directIds.has(memory.id));
    divergentMatches = selectDivergentMemories(divergentPool, keywordFrequency, CREATIVE_DIVERGENT_COUNT);
  }

  return [
    ...directMatches.map((memory) => toRetrievedMemory(memory, undefined, "direct")),
    ...divergentMatches.map((memory) => toRetrievedMemory(memory, undefined, "divergent")),
  ];
}

function toRetrievedMemory(memory: MemoryObject, linkReason?: string, matchType?: "direct" | "divergent"): RetrievedMemory {
  return {
    id: memory.id,
    date: memory.date,
    summary: memory.summary,
    keywords: memory.keywords,
    linkReason,
    source: memory.metadata.source,
    matchType,
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
  excludeConversationId?: string
): LinkedAddition[] {
  const bestByCandidateId = new Map<string, { memory: MemoryObject; strength: number; reason: string }>();

  for (const direct of directMatches) {
    for (const link of direct.links) {
      const candidateId = link.sourceId === direct.id ? link.targetId : link.sourceId;
      if (excludeIds.has(candidateId)) continue;
      const candidate = allById.get(candidateId);
      if (!candidate) continue;
      if (isSameConversation(candidate.conversationId, excludeConversationId)) continue;
      const existing = bestByCandidateId.get(candidateId);
      if (!existing || link.strength > existing.strength) {
        bestByCandidateId.set(candidateId, { memory: candidate, strength: link.strength, reason: link.reason });
      }
    }
  }

  return [...bestByCandidateId.values()]
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
  promptedMemoryId: string
): Promise<RetrievedMemory[]> {
  const alreadyIncluded = results.some((memory) => memory.id === promptedMemoryId);
  if (alreadyIncluded) {
    return results.map((memory) =>
      memory.id === promptedMemoryId ? { ...memory, isOriginMemory: true } : memory
    );
  }

  const originMemory = await getMemoryObject(promptedMemoryId);
  if (!originMemory) return results;

  return [...results, { ...toRetrievedMemory(originMemory), isOriginMemory: true }];
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

  // クリエイト（analyst）だけ別ロジックへ委譲する。companion/coachはこの下の
  // 既存ロジックをそのまま通る（挙動は一切変えていない）。
  if (options.persona === "analyst") {
    const creativeResults = await retrieveCreativeMemories(trimmed, options);
    return options.promptedMemoryId
      ? ensureOriginMemoryIncluded(creativeResults, options.promptedMemoryId)
      : creativeResults;
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxLinkedAdditions = options.maxLinkedAdditions ?? MAX_LINKED_ADDITIONS;
  const all = await getAllMemoryObjects();

  const scored = all
    .filter((memory) => !isSameConversation(memory.conversationId, options.excludeConversationId))
    .map((memory) => ({ memory, score: scoreMemory(memory, trimmed) }))
    // スコア0（関連なし）は返さない。無理に件数を埋めない（MEMORY_ENGINE.md 7.4）。
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const directMatches = scored.map((entry) => entry.memory);
  const results: RetrievedMemory[] = directMatches.map((memory) => toRetrievedMemory(memory));

  // Link経由の追加は、直接一致がlimitを埋めているかどうかに関係なく常に探索する
  // （直接一致件数とは独立の別枠。直接一致のスコアリングやpickLinkedAdditions自体のロジックは変更しない）。
  {
    const allById = new Map(all.map((memory) => [memory.id, memory]));
    const excludeIds = new Set(directMatches.map((memory) => memory.id));
    const additions = pickLinkedAdditions(
      directMatches,
      allById,
      excludeIds,
      maxLinkedAdditions,
      options.excludeConversationId
    );
    for (const addition of additions) {
      results.push(toRetrievedMemory(addition.memory, addition.reason));
    }
  }

  const capped = results.slice(0, limit + maxLinkedAdditions);
  return options.promptedMemoryId ? ensureOriginMemoryIncluded(capped, options.promptedMemoryId) : capped;
}
