/**
 * Topic Continuity Context v1（Current Conversation → Recent Conversation Context →
 * Topic Continuity Context → Memory Retrieval、という並びのうち、Recent Conversationと
 * Memory Retrievalの間に位置する層）。
 *
 * 目的：「昨日の話なんだけど、やっぱりあれでいこうかな」のように、現在の発言だけでは
 * keywordがほとんど無くても、continuity signal（「昨日」「前に」等）をきっかけに、
 * 継続中の話題（MemoryObject.topicId、Topic Continuity Phase 1で追加済み）の候補を
 * AIへ提示できるようにする。
 *
 * 責務の境界（重要）：このモジュールは「続きである可能性のあるtopic候補を絞る」ところ
 * までしか行わない。「どのtopicの続きか」「どのtopicも使うべきでないか」という最終判断は
 * 一切ここでは行わず、/api/chatの既存LLM呼び出しへ委ねる（新しいAPI/LLM callは追加しない、
 * recentConversation.tsと同じ方式）。特に、signalがあってもkeyword一致がほぼ無い場合に、
 * ローカル側で「最新topic＝続き」と決め打ちしない——その場合は直近の複数topic候補
 * （最大MAX_TOPIC_CANDIDATES件）をそのまま渡し、最終判断は必ずLLM側に委ねる。
 *
 * recentConversation.tsと同じく、このモジュールは純粋関数のみ（副作用なし・ブラウザAPI
 * 非依存・"use client"不要）。全MemoryObjectの取得（getAllMemoryObjects）は呼び出し元
 * （ChatScreen.handleSend）の責務。
 *
 * v1の設計上の割り切り（recentConversation.tsのコメントと同じ位置づけ）：
 * - topicIdを持たないMemory（Topic Continuity Phase 1導入前のMemory、またはPhase 1でも
 *   uncertain判定だったMemory）はcandidate化しない。
 * - 渡すのは各topicの直近MAX_MEMORIES_PER_TOPIC件のsummary/date/keywordsのみ（content・
 *   本文は渡さない。既存RetrievedMemory＝トークン節約のためcontentを含めない、という
 *   既存方針と同じ）。
 * - topic候補の順序は「keywordスコア優先、同点（ゼロ点を含む）なら直近優先」という
 *   単一のsortだけで決める。これにより、「keywordが強い候補は最優先」と「keywordが
 *   ほぼ無い場合は直近の複数候補をそのまま渡す（決め打ちしない）」の両方を、特別扱いの
 *   分岐を増やさずに満たす。
 * - DB schema / Vault Markdownは一切変更しない（Phase 1で追加済みのtopicIdを読むだけ）。
 *   これは永続スキーマではなく、1リクエストごとに組み立てて破棄する/api/chat bodyの
 *   optional field。
 */

import type { EventTimePrecision, MemoryObject } from "./types";
import { scoreMemory } from "./retrieval";
import { questionTopicRuns } from "./recallQuestion";

/** topic候補として提示する最大topic数（v1）。 */
export const MAX_TOPIC_CANDIDATES = 3;

/** 1 topicあたり提示する最大Memory数（v1）。同じtopicに5件あっても直近3件のみ渡す。 */
export const MAX_MEMORIES_PER_TOPIC = 3;

/**
 * continuity signal（「昨日」「前に」等）を検出する。isReflectiveQuery（retrieval.ts）と
 * 同じ「トリガー語リスト＋includes()」方式を踏襲する。誤検出は一定程度許容する
 * （完璧な意図判定はできない前提であることも同じ）。
 *
 * 重要：この関数がtrueを返すことは「過去topicを必ず使う」ことを意味しない。あくまで
 * topic candidate retrieval（selectTopicContinuityCandidates）を起動するtriggerに
 * すぎない。実際に使うかどうかの最終判断は/api/chat側のLLMが行う。
 */
const TOPIC_CONTINUITY_SIGNAL_WORDS = [
  "昨日",
  "前に",
  "この前",
  "さっき",
  "あの件",
  "あの話",
  "例の",
  "続き",
  "その後",
  "やっぱり",
  "前回",
];

/**
 * 指し示すだけの言い回し（「あの件」「例の」「続き」「その後」「あの話」）。何の話かを言わずに過去の話題を指すので、発言の他の語が記録と
 * 一致しなくても（「あの件、やっぱり会社を辞めることにした」の「会社」が記録では「転職」）、従来どおり直近の候補を渡す。
 * 「前に」「昨日」「さっき」「やっぱり」は時や気持ちを言うだけなので、ここには入れない。
 */
const POINTING_SIGNAL_WORDS = ["あの件", "あの話", "例の", "続き", "その後"];
/** 時を言う短い語（「先週」「去年」「今朝」「明日」）。話題の語として数えない（「誕生日」「記念日」のような3文字以上の語は数える） */
const SHORT_TIME_TERM = /^.?(?:週|月|年|日|朝|昼|夜|晩|頃|時|間|前|後|昔|去|今)$/;
/**
 * 話題の名前として置かれた語：直後が「の・って・は・が・も・と・について」か句読点・疑問符。「説明して」「確認して」「不安になって」
 * 「会社を辞める」「LINEした」のように、頼みごと・様子・動作の語として使った語は、話題の名前に数えない（Codex / 独立レビュー on this PR）
 */
const TOPIC_POSITION = /^(?:の|って|は|が|も|と|について|[、,。.？?！!])/;
/** よくある語：その語に一致する記録が max(5件, 全体の2割) 以上（「仕事」「予定」など）。話題を見分ける根拠にしない */
const COMMON_RECORDS = 5;
const COMMON_SHARE = 0.2;

const inTopicPosition = (text: string, term: string) => {
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) if (TOPIC_POSITION.test(text.slice(at + term.length))) return true;
  return false;
};

/**
 * 発言が名前で挙げた話題の語（recallQuestion.questionTopicRuns：漢字・カタカナ・英数字の語から、質問の形の語・1文字の語幹を除いたもの）のうち、
 * 話題の名前として置かれたもの。きっかけの言い回しの一部（「あの件」の「件」）・時を言う短い語・数字だけの語は除く。
 * 話題の語が無い発言（「昨日の話なんだけど、やっぱりあれでいこうかな」「昨日の話、もう少し詳しく説明して」）は空。
 */
export function namedTopicTerms(text: string): string[] {
  const t = text.trim().normalize("NFKC");
  return questionTopicRuns(t).filter(
    (term) => !TOPIC_CONTINUITY_SIGNAL_WORDS.some((word) => word.includes(term)) && !SHORT_TIME_TERM.test(term) && !/^[0-9]+$/.test(term) && inTopicPosition(t, term)
  );
}

const RUNS = /[一-鿿々]+|[ァ-ヺー]{2,}|[A-Za-z0-9]{2,}/g;
const runsOf = (text: string): string[] => text.normalize("NFKC").match(RUNS) ?? [];
const keywordsOf = (memory: MemoryObject) => (memory.keywords ?? []).filter((k): k is string => typeof k === "string").map((k) => k.normalize("NFKC").trim()).filter(Boolean);

/**
 * 記録がその語に一致するか（1ターンに1回、記録ごとの語を作って使い回す）:
 * - キーワード、またはキーワード・要約・本文の語が、その語で始まる（Retrievalの想起の質問と同じ。「車」には「車選び」）か、2文字以上の語なら
 *   その語で終わる（「旅行」には「京都旅行」、「会議」には「定例会議」。独立レビュー on this PR）。1文字の語は要約・本文の語と同じときだけ
 * - そのままの一致がどの記録にも無い語だけ、その語の中にある2文字以上のキーワード（「火星旅行」の「旅行」）でも一致とする
 *   （1文字のキーワード「車」で「自転車通勤」には一致させない）
 */
function recordMatcher(memories: readonly MemoryObject[]) {
  const cache = new Map<MemoryObject, { keywords: string[]; runs: string[] }>();
  const wordsOf = (memory: MemoryObject) => {
    let words = cache.get(memory);
    if (!words) {
      const keywords = keywordsOf(memory);
      words = { keywords, runs: [...keywords, ...keywords.flatMap(runsOf), ...runsOf(`${memory.summary ?? ""} ${memory.content ?? ""}`)] };
      cache.set(memory, words);
    }
    return words;
  };
  return (term: string): Set<MemoryObject> => {
    const single = Array.from(term).length === 1;
    const direct = new Set(
      memories.filter((memory) => {
        const { keywords, runs } = wordsOf(memory);
        return keywords.some((k) => k.startsWith(term)) || runs.some((run) => (single ? run === term : run.startsWith(term) || run.endsWith(term)));
      })
    );
    if (direct.size > 0) return direct;
    return new Set(memories.filter((memory) => wordsOf(memory).keywords.some((k) => Array.from(k).length >= 2 && term.includes(k))));
  };
}

export function hasTopicContinuitySignal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return TOPIC_CONTINUITY_SIGNAL_WORDS.some((word) => trimmed.includes(word));
}

/** /api/chat bodyのoptional field `topicContext` の1 Memory分の形（永続スキーマではない）。
 *  既存RetrievedMemoryと同じく、contentは含めない（summaryで十分という既存方針）。 */
export interface TopicContinuityMemoryRef {
  date: string;
  eventTime?: string;
  eventTimePrecision?: EventTimePrecision;
  summary: string;
  keywords: string[];
}

/** /api/chat bodyのoptional field `topicContext` の1 topic分の形。 */
export interface TopicContinuityCandidate {
  /** 内部識別用のみ。プロンプト本文へは出さない（デバッグ用途）。 */
  topicId: string;
  /** 直近MAX_MEMORIES_PER_TOPIC件、新しい順。 */
  memories: TopicContinuityMemoryRef[];
}

interface TopicGroup {
  topicId: string;
  memories: MemoryObject[];
}

function groupByTopicId(memories: MemoryObject[]): TopicGroup[] {
  const groups = new Map<string, MemoryObject[]>();
  for (const memory of memories) {
    if (!memory.topicId) continue;
    const list = groups.get(memory.topicId);
    if (list) {
      list.push(memory);
    } else {
      groups.set(memory.topicId, [memory]);
    }
  }
  return [...groups.entries()].map(([topicId, list]) => ({ topicId, memories: list }));
}

function memoryTimeMs(memory: MemoryObject): number {
  const ms = Date.parse(memory.updatedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** グループ内の各Memoryへ既存scoreMemory（retrieval.ts、キーワード一致＋bigram重なり）を
 *  適用し、最良スコアだけを代表値として使う（1件でも強く一致すればそのtopicを優先する）。 */
function bestKeywordScore(group: TopicGroup, trimmed: string): number {
  let best = 0;
  for (const memory of group.memories) {
    const score = scoreMemory(memory, trimmed);
    if (score > best) best = score;
  }
  return best;
}

function toMemoryRef(memory: MemoryObject): TopicContinuityMemoryRef {
  return {
    date: memory.date,
    eventTime: memory.eventTime,
    eventTimePrecision: memory.eventTimePrecision,
    summary: memory.summary,
    keywords: memory.keywords,
  };
}

/**
 * 現在の話題候補を最大MAX_TOPIC_CANDIDATES件選ぶ。呼び出し元は、
 * hasTopicContinuitySignal(currentUserMessage)がtrueの場合にのみこれを呼ぶこと
 * （signalの有無を見るgatingはこの関数の外、呼び出し元の責務。この関数自体はsignalの
 * 有無を判定しない）。
 *
 * 並び順：keywordスコア（scoreMemory、現在発言に対する各topicの最良一致）の降順、
 * 同点（keywordが弱い/無いケースを含む）はtopic内最新Memoryの更新日時の降順。この
 * 単一のsortだけで、「keywordが強いtopicは最優先候補にしてよい」と「keywordがほぼ無い
 * 場合はローカル側で1つに決め打ちせず、直近の複数topicをそのまま候補として渡す」の
 * 両方を、特別扱いの分岐を追加せずに満たす。
 *
 * topicId自体を持つMemoryが無ければ空配列を返す（Phase 1導入前のVaultでは常に空）。
 */
export function selectTopicContinuityCandidates(
  allMemories: MemoryObject[],
  currentUserMessage: string
): TopicContinuityCandidate[] {
  const trimmed = currentUserMessage.trim();
  const allGroups = groupByTopicId(allMemories);
  if (allGroups.length === 0) return [];

  // 関連の確認：発言が話題の名前を挙げたとき（「前に話した火星旅行の計画、」）は、その語に一致する記録を含む話題だけを候補にする。
  // - 見分ける根拠にするのは、よくある語でない語だけ（よくある語・話題の名前でない語しか無ければ従来どおり）
  // - 一致する話題が無く、どの記録にも無い名前なら候補を渡さない（無関係な直近の話題を渡さない）
  // - 指し示すだけの言い回し（「あの件」「続き」）があるときは、一致が無ければ従来どおり（言い換え「会社を辞める」→「転職」を失わない）
  // 話題の語が無い発言は従来どおり（キーワードが弱ければ直近の複数の候補をそのまま渡し、判断はAIに委ねる）
  // 見分ける根拠は、発言が最初に挙げた話題の名前（よくある語を除く）だけ。「火星旅行の計画」の「計画」のような後の語では話題を選ばない
  // （別の話題の「…計画を立てた」を候補に戻さない。独立レビュー on this PR）
  const common = Math.max(COMMON_RECORDS, Math.ceil(allMemories.length * COMMON_SHARE));
  const matching = recordMatcher(allMemories);
  const named = (trimmed ? namedTopicTerms(trimmed) : []).map(matching).find((records) => records.size < common);
  let groups = allGroups;
  if (named) {
    const related = allGroups.filter((group) => group.memories.some((memory) => named.has(memory)));
    const pointing = POINTING_SIGNAL_WORDS.some((word) => trimmed.includes(word));
    groups = related.length > 0 || !pointing ? related : allGroups;
  }
  if (groups.length === 0) return [];

  const scored = groups.map((group) => ({
    group,
    keywordScore: trimmed ? bestKeywordScore(group, trimmed) : 0,
    recencyMs: Math.max(...group.memories.map(memoryTimeMs)),
  }));

  scored.sort((a, b) => {
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return b.recencyMs - a.recencyMs;
  });

  return scored.slice(0, MAX_TOPIC_CANDIDATES).map(({ group }) => ({
    topicId: group.topicId,
    memories: [...group.memories]
      .sort((a, b) => memoryTimeMs(b) - memoryTimeMs(a))
      .slice(0, MAX_MEMORIES_PER_TOPIC)
      .map(toMemoryRef),
  }));
}

/**
 * ChatScreen.handleSend から呼ぶ薄いヘルパー（recentConversation.tsの
 * buildRecentConversationPayloadと同じ形）。continuity signalの有無をここで
 * gatingし、signalが無い、またはtopic候補が1件も無い場合はnullを返す
 * （/api/chat bodyへtopicContextを含めない＝既存挙動を維持）。
 */
export function buildTopicContinuityPayload(
  allMemories: MemoryObject[],
  currentUserMessage: string
): TopicContinuityCandidate[] | null {
  if (!hasTopicContinuitySignal(currentUserMessage)) return null;
  const candidates = selectTopicContinuityCandidates(allMemories, currentUserMessage);
  return candidates.length > 0 ? candidates : null;
}
