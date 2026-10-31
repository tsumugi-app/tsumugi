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
  /** queryScore - genericPenalty + anchorBonus + personBonus。実際の順位付け・floor判定に使う値。 */
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
  personFocus: ConversationPersonFocus | null = null
): ConversationCandidateScore[] {
  return pool.map((memory) => {
    const queryScore = scoreMemory(memory, trimmed);
    const genericPenalty = genericKeywordPenalty(memory, trimmed, keywordFrequency);
    const anchorBonus = conversationAnchorScore(memory, anchors);
    const personBonus = personCarryScore(memory, personFocus);
    return { memory, queryScore, genericPenalty, anchorBonus, personBonus, conversationScore: queryScore - genericPenalty + anchorBonus + personBonus };
  });
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
  limit: number
): ConversationDirectSelection {
  const anchors = deriveConversationTopicAnchors(recentUserTurnsTexts, keywordFrequency);
  const personFocus = deriveConversationPersonFocus(recentUserTurnsTexts, pool);
  const allScored = scoreConversationCandidates(pool, trimmed, anchors, keywordFrequency, personFocus);

  const aboveFloor = allScored.filter((entry) => entry.conversationScore >= CONVERSATION_MIN_SCORE);
  const droppedByFloor = allScored
    .filter((entry) => entry.conversationScore > 0 && entry.conversationScore < CONVERSATION_MIN_SCORE)
    .sort((a, b) => b.conversationScore - a.conversationScore);

  const sorted = [...aboveFloor].sort((a, b) => b.conversationScore - a.conversationScore).slice(0, limit);

  const relativeInput = sorted.map((entry) => ({ memory: entry.memory, score: entry.conversationScore }));
  const keptIds = new Set(applyRelativeStrengthFilter(relativeInput).map((entry) => entry.memory.id));
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
  dropped: string[];
  feeling: string | null;
}

export function selectConversationWithPersons(
  pool: MemoryObject[],
  trimmed: string,
  recentUserTurnsTexts: string[],
  keywordFrequency: Map<string, number>,
  limit: number,
  now: number
): PersonAwareSelection {
  // 人物の話でなければ、元の入力のままの従来の選定（「2人」の読み替えも人物の話のときだけ）
  const fallback = (): PersonAwareSelection => ({
    memories: selectConversationDirectMatches(pool, trimmed, recentUserTurnsTexts, keywordFrequency, limit).kept.map((entry) => entry.memory),
    person: null,
    added: [],
    dropped: [],
    feeling: null,
  });
  const latest = normalizeTwoPeople(trimmed);
  const turns = recentUserTurnsTexts.map(normalizeTwoPeople);
  const keys = knownPersonKeys(pool);
  if (keys.length === 0) return fallback();

  const named = personKeysInText(trimmed, keys);
  let person: PersonAwareSelection["person"] = null;
  if (named.length === 1) {
    person = { key: named[0], how: "named" };
  } else if (named.length === 0) {
    // 従来の人物継続を、キーワードが名前と一致する記録もその人物の記録として扱った写しの上で使う
    const linked = pool.map((memory) => {
      const extra = keys.filter((key) => !(memory.personMentions ?? []).some((mention) => personNameKey(mention.displayName ?? "") === key) && (memory.keywords ?? []).some((keyword) => personNameKey(keyword) === key));
      return extra.length === 0 ? memory : ({ ...memory, personMentions: [...(memory.personMentions ?? []), ...extra.map((key) => ({ displayName: key, groupingKey: key }))] } as unknown as MemoryObject);
    });
    const focus = deriveConversationPersonFocus(turns, linked);
    if (focus) person = { key: personNameKey(focus.displayName), how: "carried" };
  }
  if (!person) return fallback();
  const target = person.key;
  const base = selectConversationDirectMatches(pool, latest, turns, keywordFrequency, limit).kept.map((entry) => entry.memory);
  const aboutOther = (memory: MemoryObject) => keys.some((key) => key !== target && isAboutPerson(memory, key));

  const dropped: string[] = [];
  const kept = base.filter((memory) => {
    if (aboutOther(memory) && !isAboutPerson(memory, target)) {
      dropped.push(memory.id);
      return false;
    }
    return true;
  });

  // 名前を除いた会話（名前だけで「重なる」としないため）
  const query = keys.reduce((text, key) => text.split(key).join(" "), nfkcCompact((turns.length > 0 ? turns : [latest]).join(" ")).replace(/(さん|ちゃん|くん|君|様|氏)/g, " "));
  const ownKeywordHits = (memory: MemoryObject) => (memory.keywords ?? []).filter((keyword) => !keys.includes(personNameKey(keyword)) && query.includes(nfkcCompact(keyword))).length;

  const included = new Set(kept.map((memory) => memory.id));
  const candidates = pool.filter((memory) => isAboutPerson(memory, target) && !aboutOther(memory) && !included.has(memory.id));
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

  let feeling: MemoryObject | undefined;
  if (isRelationshipTalk(trimmed, turns.length >= 2 ? turns[turns.length - 2] : undefined)) {
    const eligible = pool
      .filter((memory) => isAboutPerson(memory, target) && isFeelingRecord(memory) && !aboutOther(memory))
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
    memories: [...kept, ...extra, ...(feeling ? [feeling] : [])],
    person,
    added: extra.map((memory) => memory.id),
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
  }
): Promise<RetrievedMemory[]> {
  const directLimit = options.limit ?? DEFAULT_LIMIT;
  const all = await getAllMemoryObjects();
  const pool = all.filter((memory) => !isSameConversation(memory.conversationId, options.excludeConversationId));
  const keywordFrequency = computeKeywordFrequency(all);

  // 人物が話題のターンだけ、その人物の記録を整える（selectConversationWithPersons。人物が出てこないターンは従来の選定そのまま）
  const directMatches = selectConversationWithPersons(
    pool,
    trimmed,
    options.recentUserTurnsTexts ?? [],
    keywordFrequency,
    directLimit,
    Date.now()
  ).memories;

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
    eventTime: memory.eventTime,
    eventTimePrecision: memory.eventTimePrecision,
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
