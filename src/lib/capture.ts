/**
 * クライアント側のCaptureオーケストレーション（MEMORY_ENGINE.md 2.2）。
 * 会話が一往復進むたびに呼ばれ、そのConversationから意味のある単位でMemoryObjectを
 * 複数抽出しうる（1 Conversation = 1 Memoryとは限らない）。
 * まだ他の記憶とは接続しない（Connectは行わない。ROADMAP.md Phase 2のスコープ）。
 */
"use client";

import { ulid } from "ulid";
import { getAllMemoryObjects, loadApiKey, putConversation, putMemoryObject } from "./db";
import { logTimingEvent } from "./debugTimingLog";
import { isReflectionSummary, writeConversationMarkdown, writeMemoryObjectMarkdown, type VaultWritePriority } from "./vault";
import { isSameConversation, scoreMemory, KEYWORD_WEIGHT, DEFAULT_LIMIT } from "./retrieval";
import { withVaultWorldRead } from "./vaultWorldLock";
import { SCHEMA_VERSION } from "./types";
import type { Conversation, ConversationTurn, EventTimePrecision, MemoryObject, MemoryType, Persona } from "./types";
import { getJstTodayDateString, isValidEventTimePrecision, isValidEventTimeValue } from "./eventTimeResolver";
import { PROFILE_LIMITS, draftsToClaims, mergeProfileClaims, sanitizeStoredProfileClaims, validateProfileCandidates } from "./profile";
import {
  PERSON_MEMORY_LIMITS,
  draftsToPersonMentions,
  mergePersonMentions,
  sanitizeStoredPersonMentions,
  validatePersonMentionCandidates,
} from "./person";
import {
  TOPIC_EVENT_LIMITS,
  draftsToTopicEvents,
  mergeTopicEvents,
  sanitizeStoredTopicEvents,
  validateTopicEventQuotes,
} from "./topicEvent";
import { GEMINI_API_KEY_HEADER } from "./apiKeyHeader";

const AI_PROVIDER = "gemini";

function nowISO(): string {
  return new Date().toISOString();
}

export function createConversation(persona: Persona): Conversation {
  const timestamp = nowISO();
  return {
    id: ulid(),
    persona,
    startedAt: timestamp,
    turns: [],
    status: "active",
    memoryObjectIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      id: ulid(),
      schemaVersion: SCHEMA_VERSION,
      source: "ai-capture",
      aiProvider: AI_PROVIDER,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

export function appendTurn(conversation: Conversation, turn: ConversationTurn): Conversation {
  return {
    ...conversation,
    turns: [...conversation.turns, turn],
    updatedAt: nowISO(),
  };
}

/** Topic Continuity Phase 1。existingMemoryId（同一Memoryの更新かどうか）とは別の軸。 */
type TopicDecision = "sameTopic" | "newTopic" | "uncertain";

interface ExtractedMemory {
  existingMemoryId?: string;
  topicDecision: TopicDecision;
  sameTopicMemoryId?: string;
  summary: string;
  content: string;
  keywords: string[];
  types: MemoryType[];
  confidence: number;
  /** Time Axis Phase 2（Event Time, v1）。/api/capture参照。 */
  eventTime?: string;
  eventTimePrecision?: EventTimePrecision;
  /**
   * Personal Profile v1（optional）。/api/captureが検証済みの候補を返す。ここでも同じ関数で再検証してから使う
   * （idやslot等はTsumugi側が決定的に付与する）。無い会話では未設定。
   */
  profileClaims?: unknown;
  /**
   * Person Memory v1（optional）。/api/captureが検証済みの候補を返す。ここでも同じ関数で
   * 再検証してから使う（idやgroupingKey等はTsumugi側が決定的に付与する）。無い会話では未設定。
   */
  personMentions?: unknown;
  /**
   * Topic / Current State v1（optional）。/api/captureが検証済みのquote文字列配列を返す。
   * ここでも同じ関数で再検証してから使う（id・topicId等はTsumugi側が決定的に付与する）。
   * topicIdは`resolveTopicId()`の結果（`resolvedTopicId`）が存在する場合のみ付与できる
   * ——topicIdが確定しない候補は、evidence自体は有効でも保存しない（buildTopicEventsFor参照）。
   */
  topicEvents?: unknown;
}

/**
 * 別Conversationからの類似Memory候補の件数上限。retrieval.tsのDEFAULT_LIMIT
 * （通常会話でのRetrieved Memory直接一致の既定件数）とあえて同じ値を使う。
 * Captureのpromptを不必要に肥大化させない一方、既存の「候補は絞って渡す」という
 * このシステム全体の基準と揃えるため。
 */
const CROSS_CONVERSATION_CANDIDATE_LIMIT = DEFAULT_LIMIT;
/**
 * 候補として採用する最低スコア。retrieval.tsのKEYWORD_WEIGHT（キーワード1件一致分の
 * 重み）と同じ値にする＝「summary/contentの文字重なりだけ」ではなく、少なくとも
 * キーワード1件分に相当する関連度が無ければ候補にしない、という保守的な下限。
 * retrieveRelevantMemories()の通常会話向けフィルタ（score > 0）より厳しくしている
 * のは、こちらは「AIに重複統合を検討させる候補」であり、単に関連しているだけの
 * Memoryまで混ぜると、無関係なMemoryとの誤統合や、Captureプロンプトの肥大化を
 * 招きやすいため。
 */
const CROSS_CONVERSATION_MIN_SCORE = KEYWORD_WEIGHT;

/**
 * 現在のConversation以外から、話題が近そうなMemoryを少数だけ探す。
 * retrieval.tsの既存のスコアリング（scoreMemory）をそのまま流用し、新しい
 * アルゴリズム・Embedding・追加のAI呼び出しは一切導入しない。
 * ここで見つけた候補は「AIへの参考情報」に過ぎず、統合するかどうかの判断は
 * 引き続き/api/capture側のAIに委ねる（ここでは一切統合しない）。
 * existingMemoryObjects（このConversationから既に生成済みのMemory）と同じMemoryが
 * 二重に候補へ入らないよう、conversationIdによる除外に加えてid自体でも除外する。
 */
/**
 * Capture Reflection保護（2026-09-23）：Reflection（`isReflectionSummary`、
 * `metadata.source === "system-generated"`）は、別Conversationからの類似候補
 * （relatedMemories）として通常CaptureのexistingMemoryId対象に含めない。
 *
 * 実データで確認された不具合：Reflectionは会話の要約・洞察をAIが独自に統合して
 * 作る記録であり、topicの類似度だけなら通常Memory以上に幅広い会話とマッチしやすい。
 * 除外しないと、無関係な新しいUser発言から生成されたMemory候補が、LLMの
 * existingMemoryId判断によって既存のReflectionへ「UPDATE」として統合され、
 * Reflection本来の内容（content/summary/types）を上書きしてしまう
 * （実例：2026-08-23生成のReflection`01M0Q9P2JNZYFX42RXFHF3JE2X`が、無関係な
 * 2026-09-22のCaptureによって上書きされた）。
 *
 * Reflection自体のRetrieval参照・Reflection生成処理（reflection.ts、
 * /api/reflect）はこの関数の対象外であり、一切変更しない——ここで除外するのは
 * 「通常CaptureのUPDATE候補として提示するかどうか」という一点だけ。
 */
async function findRelatedMemoriesFromOtherConversations(
  conversation: Conversation,
  existingMemoryObjects: MemoryObject[]
): Promise<MemoryObject[]> {
  const queryText = conversation.turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content)
    .join(" ")
    .trim();
  if (!queryText) return [];

  const all = await getAllMemoryObjects();
  const existingIds = new Set(existingMemoryObjects.map((memory) => memory.id));

  return all
    .filter((memory) => !isReflectionSummary(memory))
    .filter((memory) => !isSameConversation(memory.conversationId, conversation.id))
    .filter((memory) => !existingIds.has(memory.id))
    .map((memory) => ({ memory, score: scoreMemory(memory, queryText) }))
    .filter((entry) => entry.score >= CROSS_CONVERSATION_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, CROSS_CONVERSATION_CANDIDATE_LIMIT)
    .map((entry) => entry.memory);
}

/**
 * existingMemoryObjectsは「このConversationから既に生成済みのMemory」を渡す
 * （Vault/IndexedDB全体を毎回渡すことはしない）。relatedMemoryObjectsは、
 * findRelatedMemoriesFromOtherConversations()が見つけた、別Conversation由来の
 * 少数の類似候補。どちらもsummary/keywordsだけの軽量な形に絞って送る（contentは
 * 送らない。トークン節約と、AIに既存Memoryをまるごと書き直させないため）。
 * /api/capture側で、この2つは別のセクションとしてAIへ提示され、区別される。
 */
/**
 * Capture Evidence Boundary観測性（2026-09-23、挙動は一切変更しない）：/api/captureが
 * 返す`X-Tsumugi-Evidence`ヘッダ（proposed/accepted/dropped件数、任意でdrop理由ごとの
 * 内訳）を、既存のCapture診断ログ経路（`logTimingEvent`、Capture topicDecision/
 * profileClaimsと同じ仕組み）へそのまま記録するだけの副作用。会話内容・User/Assistant
 * 発言・evidenceQuotes・Memory本文・個人情報は一切渡さない（渡すのは件数と、
 * ハイフン区切りの理由ラベルだけ）。
 *
 * ヘッダが無い・想定外の形式の場合は、既存の実装が無かった場合と同じく単に記録を
 * skipする（例外を投げない）。ヘッダの有無・内容は、Captureの成否・戻り値
 * （`extractMemories`が返すMemory候補の内容）に一切影響しない——この関数の戻り値は
 * 常に`void`で、呼び出し元はこの関数の結果を一切利用しない。
 */
function logEvidenceBoundaryHeader(res: Response): void {
  const header = res.headers.get("X-Tsumugi-Evidence");
  if (!header) return;
  try {
    const params: Record<string, number | string> = {};
    for (const part of header.split(";")) {
      const [key, value] = part.split("=");
      if (!key || value === undefined) continue;
      if (key === "proposed" || key === "accepted" || key === "dropped") {
        const n = Number(value);
        if (Number.isFinite(n)) params[key] = n;
      } else if (key === "dropReasons" && value) {
        // "not-found:1,missing:2" のような形式。理由ラベルごとの件数だけを個別キーへ展開する。
        for (const pair of value.split(",")) {
          const [reason, countStr] = pair.split(":");
          if (!reason || countStr === undefined) continue;
          const count = Number(countStr);
          if (Number.isFinite(count)) params[`drop_${reason}`] = count;
        }
      }
    }
    if (Object.keys(params).length > 0) logTimingEvent("Capture evidenceBoundary", params);
  } catch {
    // 診断目的のヘッダparseであり、失敗してもCapture本体には一切影響させない。
  }
}

/**
 * Person Memory v1観測性（2026-09-23、挙動・判定ロジックは一切変更しない）：/api/captureが
 * 常に返す`X-Tsumugi-Person-Mentions`ヘッダ（kill switchの実際の状態`enabled`、有効時は
 * proposed/accepted/dropped、`PersonMentionDropReason`ごとの内訳、およびrelationの
 * groundingに失敗しPersonMention自体は採用しつつrelationだけ取り除いた件数
 * `relationStripped`）を、
 * `logEvidenceBoundaryHeader`と同じ仕組みでそのまま記録するだけの副作用。会話内容・
 * User/Assistant発言・quote・displayName・Memory本文・個人情報は一切渡さない
 * （渡すのは件数と、既存のdrop理由ラベルだけ）。disabled時（enabled=0）もヘッダは
 * 常に返るため、kill switchが意図せず無効化されていないかを、常にログから確認できる。
 *
 * ヘッダが無い・想定外の形式の場合は記録をskipする（例外を投げない）。ヘッダの有無・内容は、
 * Captureの成否・戻り値に一切影響しない——この関数の戻り値は常に`void`で、
 * 呼び出し元はこの関数の結果を一切利用しない。
 */
function logPersonMentionsHeader(res: Response): void {
  const header = res.headers.get("X-Tsumugi-Person-Mentions");
  if (!header) return;
  try {
    const params: Record<string, number | string> = {};
    for (const part of header.split(";")) {
      const [key, value] = part.split("=");
      if (!key || value === undefined) continue;
      if (key === "enabled" || key === "proposed" || key === "accepted" || key === "dropped" || key === "relationStripped") {
        const n = Number(value);
        if (Number.isFinite(n)) params[key] = n;
      } else if (key === "dropReasons" && value) {
        // "quote:1,displayName:1" のような形式。理由ラベル（PersonMentionDropReasonの値）
        // ごとの件数だけを個別キーへ展開する。
        for (const pair of value.split(",")) {
          const [reason, countStr] = pair.split(":");
          if (!reason || countStr === undefined) continue;
          const count = Number(countStr);
          if (Number.isFinite(count)) params[`drop_${reason}`] = count;
        }
      }
    }
    if (Object.keys(params).length > 0) logTimingEvent("Capture personMentions", params);
  } catch {
    // 診断目的のヘッダparseであり、失敗してもCapture本体には一切影響させない。
  }
}

/**
 * Topic / Current State v1観測性（挙動・判定ロジックは一切変更しない）：/api/captureが
 * 常に返す`X-Tsumugi-Topic-Events`ヘッダ（kill switchの実際の状態`enabled`、有効時は
 * proposed/accepted/dropped、`TopicEventDropReason`ごとの内訳）を、`logPersonMentionsHeader`
 * と同じ仕組みでそのまま記録するだけの副作用。会話内容・quote本文は一切渡さない
 * （渡すのは件数と、既存のdrop理由ラベルだけ）。disabled時（enabled=0）もヘッダは
 * 常に返るため、kill switchが意図せず無効化されていないかを、常にログから確認できる。
 *
 * ヘッダが無い・想定外の形式の場合は記録をskipする（例外を投げない）。ヘッダの有無・内容は、
 * Captureの成否・戻り値に一切影響しない——この関数の戻り値は常に`void`で、
 * 呼び出し元はこの関数の結果を一切利用しない。
 */
function logTopicEventsHeader(res: Response): void {
  const header = res.headers.get("X-Tsumugi-Topic-Events");
  if (!header) return;
  try {
    const params: Record<string, number | string> = {};
    for (const part of header.split(";")) {
      const [key, value] = part.split("=");
      if (!key || value === undefined) continue;
      if (key === "enabled" || key === "proposed" || key === "accepted" || key === "dropped") {
        const n = Number(value);
        if (Number.isFinite(n)) params[key] = n;
      } else if (key === "dropReasons" && value) {
        // "quote:1,not-user:1" のような形式。理由ラベル（TopicEventDropReasonの値）
        // ごとの件数だけを個別キーへ展開する。
        for (const pair of value.split(",")) {
          const [reason, countStr] = pair.split(":");
          if (!reason || countStr === undefined) continue;
          const count = Number(countStr);
          if (Number.isFinite(count)) params[`drop_${reason}`] = count;
        }
      }
    }
    if (Object.keys(params).length > 0) logTimingEvent("Capture topicEvents", params);
  } catch {
    // 診断目的のヘッダparseであり、失敗してもCapture本体には一切影響させない。
  }
}

async function extractMemories(
  persona: Persona,
  turns: ConversationTurn[],
  existingMemoryObjects: MemoryObject[],
  relatedMemoryObjects: MemoryObject[]
): Promise<ExtractedMemory[]> {
  const apiKey = await loadApiKey();
  const toRef = (memory: MemoryObject) => ({
    id: memory.id,
    summary: memory.summary,
    keywords: memory.keywords,
  });
  // TEMP-TEST：20〜40秒の異常遅延の原因切り分け用。原因調査が終わり次第削除すること。
  console.log(`[Capture] request:start`);
  logTimingEvent("Capture request:start");
  const res = await fetch("/api/capture", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { [GEMINI_API_KEY_HEADER]: apiKey } : {}),
    },
    body: JSON.stringify({
      persona,
      turns,
      existingMemories: existingMemoryObjects.map(toRef),
      relatedMemories: relatedMemoryObjects.map(toRef),
    }),
  });
  if (!res.ok) {
    throw new Error(`capture request failed with status ${res.status}`);
  }
  logEvidenceBoundaryHeader(res);
  logPersonMentionsHeader(res);
  logTopicEventsHeader(res);
  const data = (await res.json()) as { memories: ExtractedMemory[] };
  return data.memories ?? [];
}

export interface CaptureResult {
  conversation: Conversation;
  /** 今回のCaptureで新規作成 or 更新されたMemoryのみ（既存Memoryのうち触れられなかったものは含まない）。 */
  memoryObjects: MemoryObject[];
}

/**
 * existingMemoryObjectsは、呼び出し元がこのConversationについて把握している
 * MemoryObjectの一覧（conversation.memoryObjectIdsに対応する実体）を渡す。
 * ここではVault/IndexedDB全件を検索・再取得することはしない。
 *
 * 戻り値のConversation.memoryObjectIdsは「そのConversationから新規生成された
 * MemoryのID一覧」を意味する（MemoryObject.conversationIdという単一の血統情報と
 * 意味を一致させる）。既存Memoryの更新（同一Conversation由来・別Conversation由来の
 * どちらも）では、更新対象のMemoryのidをmemoryObjectIdsへ追加しない。
 */
/**
 * Vault境界の安全性（H4対応）：Memory World（他Conversation由来の類似Memory探索を含む）を
 * 読むため、共有ロック＋epoch確認で包んだ公開版。実処理は`captureConversationImpl`
 * （ロックを取得しない内部専用版）に committed。このImpl版は、既にロックを保持している
 * 呼び出し元（今のところ無い）から直接呼べるよう分離してある（デッドロック回避の原則、
 * vaultWorldLock.ts参照）。
 */
export async function captureConversation(
  conversation: Conversation,
  existingMemoryObjects: MemoryObject[]
): Promise<CaptureResult> {
  return withVaultWorldRead(() => captureConversationImpl(conversation, existingMemoryObjects));
}

async function captureConversationImpl(
  conversation: Conversation,
  existingMemoryObjects: MemoryObject[]
): Promise<CaptureResult> {
  const relatedMemoryObjects = await findRelatedMemoriesFromOtherConversations(conversation, existingMemoryObjects);
  const extracted = await extractMemories(
    conversation.persona,
    conversation.turns,
    existingMemoryObjects,
    relatedMemoryObjects
  );
  const timestamp = nowISO();
  // existingMemoryIdは、同一Conversationの既存Memoryだけでなく、別Conversationからの
  // 類似候補（relatedMemoryObjects）のidを指すこともある。両方をマージしておかないと、
  // AIが「別Conversationの候補を更新する」と判断したケースを拾えず、意図せず新規
  // MemoryObjectとして重複生成してしまう。
  const existingById = new Map(
    [...existingMemoryObjects, ...relatedMemoryObjects].map((memory) => [memory.id, memory])
  );

  // newlyCreatedIdsには、このConversationから今回実際に新規作成されたMemoryのidだけを
  // 集める（既存Memoryの更新は、それが同一Conversation由来か別Conversation由来かに
  // 関わらず一切含めない）。conversation.memoryObjectIdsの意味を「そのConversationから
  // 新規生成されたMemoryのID一覧」に統一するため（MemoryObject.conversationIdという
  // 単一の血統情報と、意味を一致させる）。
  const newlyCreatedIds: string[] = [];

  // Topic Continuity Phase 1：existingMemoryId（同一Memoryの更新かどうか）とは独立に
  // topicIdを解決する。「弱い関連を無理にsameTopicにしない」「空白を勝手に埋めない」
  // という方針から：
  // - sameTopic：対象候補が既にtopicIdを持っていればそれを継承する。対象候補が
  //   まだtopicIdを持たない場合、既存Memory（対象候補）側へは一切書き戻さず
  //   （Phase 1では過去Memoryへのbackfillをしない。10/11の制約通り）、新しいtopicIdを
  //   この新規/更新Memory側にだけ発行する。
  // - newTopic：新しいtopicIdを発行する（今後sameTopicの対象として機能しうる）。
  // - uncertain：新規にtopicIdを発行しない（安全側。理由は実装報告参照）。ただし
  //   更新対象（existing）が既にtopicIdを持っていた場合、今回の判定がuncertainだった
  //   というだけの理由でそれを消さない（維持する）。
  function resolveTopicId(item: ExtractedMemory, existing: MemoryObject | undefined): string | undefined {
    if (item.topicDecision === "sameTopic") {
      const target = item.sameTopicMemoryId ? existingById.get(item.sameTopicMemoryId) : undefined;
      if (target?.topicId) return target.topicId;
      return ulid();
    }
    if (item.topicDecision === "newTopic") {
      return ulid();
    }
    return existing?.topicId;
  }

  // Time Axis Phase 2（Event Time, v1）：existingMemoryId・topicDecisionとは独立に
  // eventTime/eventTimePrecisionを解決する。「過剰なUPDATE判定Engineは作らない、
  // v1ではfail-safeを優先する」という方針から、既存Memory（更新対象）が既にeventTimeを
  // 持っている場合、今回の抽出結果が別の出来事（次回の予定等）を指している可能性がある
  // ため、常に既存の値を維持し一切上書きしない（「同じ出来事をより正確に表しているか」を
  // ここで判定するロジックは追加しない）。既存に無く今回分かった場合にのみ新しく設定する。
  // どちらの値も、precisionと矛盾しない形式かを検証してから採用する（無条件castしない）。
  function resolveEventTime(
    item: ExtractedMemory,
    existing: MemoryObject | undefined
  ): { eventTime?: string; eventTimePrecision?: EventTimePrecision } {
    if (existing?.eventTime && existing?.eventTimePrecision) {
      return { eventTime: existing.eventTime, eventTimePrecision: existing.eventTimePrecision };
    }
    if (
      item.eventTime &&
      isValidEventTimePrecision(item.eventTimePrecision) &&
      isValidEventTimeValue(item.eventTime, item.eventTimePrecision)
    ) {
      return { eventTime: item.eventTime, eventTimePrecision: item.eventTimePrecision };
    }
    return {};
  }

  // TEMP-TEST：Topic Continuity Phase 1の判定結果を観測するためだけのログ。
  // 本文・summary・keywords・topicId自体は出さない（列挙値と件数のみ）。
  const candidateCount = existingMemoryObjects.length + relatedMemoryObjects.length;

  // Personal Profile v1：候補を、この会話のユーザー発言に対して再検証し（サーバーの検証と同じ関数）、Tsumugi側で
  // id・slot・statedAt・sourceConversationId・recordedAt等を確定する。1回のCapture全体で最大perCapture件。
  const todayJst = getJstTodayDateString();
  const fallbackStatedAt = conversation.turns.find((turn) => turn.role === "user" && !Number.isNaN(Date.parse(turn.timestamp)))?.timestamp ?? conversation.startedAt;
  let profileBudget = PROFILE_LIMITS.perCapture;
  let profileProposed = 0;
  let profileAccepted = 0;
  function buildProfileClaimsFor(item: ExtractedMemory) {
    if (item.profileClaims === undefined) return [];
    const validated = validateProfileCandidates(item.profileClaims, {
      turns: conversation.turns,
      todayJst,
      maxItems: Math.min(PROFILE_LIMITS.perMemoryItem, Math.max(0, profileBudget)),
      fallbackStatedAt,
    });
    profileProposed += validated.proposed;
    profileAccepted += validated.drafts.length;
    profileBudget -= validated.drafts.length;
    return draftsToClaims(validated.drafts, { conversationId: conversation.id, recordedAt: timestamp, newId: ulid });
  }

  // Person Memory v1：Profileと同じ二重検証パターン（サーバーの検証結果を、クライアントで
  // 同じ関数を使って再検証してからid・groupingKey等をTsumugi側で確定する）。
  let personBudget = PERSON_MEMORY_LIMITS.perCapture;
  let personProposed = 0;
  let personAccepted = 0;
  function buildPersonMentionsFor(item: ExtractedMemory) {
    if (item.personMentions === undefined) return [];
    const validated = validatePersonMentionCandidates(item.personMentions, {
      turns: conversation.turns,
      maxItems: Math.min(PERSON_MEMORY_LIMITS.perMemoryItem, Math.max(0, personBudget)),
      fallbackStatedAt,
    });
    personProposed += validated.proposed;
    personAccepted += validated.drafts.length;
    personBudget -= validated.drafts.length;
    return draftsToPersonMentions(validated.drafts, { conversationId: conversation.id, recordedAt: timestamp, newId: ulid });
  }

  // Topic / Current State v1：Profile/Person Memoryと同じ二重検証パターンに加え、
  // 「resolvedTopicIdが存在する場合のみ保存する」という決定的なゲートを持つ
  // （topicEvent.ts参照）。topicIdが確定しない（Topic Continuityがuncertainと判定した）
  // 候補は、quote自体は有効でも一切保存しない——無差別なTopicEvent化を防ぐ主機構。
  let topicBudget = TOPIC_EVENT_LIMITS.perCapture;
  let topicProposed = 0;
  let topicAccepted = 0;
  function buildTopicEventsFor(item: ExtractedMemory, resolvedTopicId: string | undefined) {
    if (item.topicEvents === undefined) return [];
    if (resolvedTopicId === undefined) return [];
    const validated = validateTopicEventQuotes(item.topicEvents, {
      turns: conversation.turns,
      maxItems: Math.min(TOPIC_EVENT_LIMITS.perMemoryItem, Math.max(0, topicBudget)),
      fallbackStatedAt,
    });
    topicProposed += validated.proposed;
    topicAccepted += validated.drafts.length;
    topicBudget -= validated.drafts.length;
    return draftsToTopicEvents(validated.drafts, { topicId: resolvedTopicId, conversationId: conversation.id, recordedAt: timestamp, newId: ulid });
  }

  const memoryObjects: MemoryObject[] = extracted.map((item) => {
    const matched = item.existingMemoryId ? existingById.get(item.existingMemoryId) : undefined;
    // Capture Reflection保護・二重防御（2026-09-23）：`findRelatedMemoriesFromOtherConversations`
    // が既にReflectionを候補から除外しているため通常はここに来ないはずだが、
    // existingMemoryObjects（このConversation自身から既に生成済みのMemory）側に
    // 万一Reflectionが含まれていた場合や、将来の変更で候補構築ロジックが変わった
    // 場合に備え、UPDATE適用の直前でもう一度fail-safeとして確認する。Reflectionが
    // 一致した場合はUPDATE対象として扱わず（`existing`をundefinedにフォールバック
    // し）、常にNEW Memoryとして作成する——ReflectionのUPDATEは通常Captureの
    // どの経路からも一切発生させない。
    const existing = matched && isReflectionSummary(matched) ? undefined : matched;
    const resolvedTopicId = resolveTopicId(item, existing);
    const resolvedEventTime = resolveEventTime(item, existing);
    logTimingEvent("Capture topicDecision", {
      topicDecision: item.topicDecision,
      candidateCount,
      topicIdPresent: resolvedTopicId ? 1 : 0,
    });

    const newProfileClaims = buildProfileClaimsFor(item);
    const newPersonMentions = buildPersonMentionsFor(item);
    const newTopicEvents = buildTopicEventsFor(item, resolvedTopicId);

    if (existing) {
      // Personal Profile v1：追加のみ。既存のclaimは削除せず、新しいclaimだけを重複排除して足す。
      const mergedProfileClaims = mergeProfileClaims(existing.profileClaims ? sanitizeStoredProfileClaims(existing.profileClaims) : undefined, newProfileClaims);
      // Person Memory v1：同じく追加のみ。既存のmention（Correction含む）は削除・編集しない。
      const mergedPersonMentions = mergePersonMentions(existing.personMentions ? sanitizeStoredPersonMentions(existing.personMentions) : undefined, newPersonMentions);
      // Topic / Current State v1：同じく追加のみ。既存のeventは削除・編集しない。
      const mergedTopicEvents = mergeTopicEvents(existing.topicEvents ? sanitizeStoredTopicEvents(existing.topicEvents) : undefined, newTopicEvents);
      return {
        ...existing,
        content: item.content,
        summary: item.summary,
        keywords: item.keywords,
        types: item.types,
        topicId: resolvedTopicId,
        eventTime: resolvedEventTime.eventTime,
        eventTimePrecision: resolvedEventTime.eventTimePrecision,
        ...(mergedProfileClaims.length > 0 ? { profileClaims: mergedProfileClaims } : {}),
        ...(mergedPersonMentions.length > 0 ? { personMentions: mergedPersonMentions } : {}),
        ...(mergedTopicEvents.length > 0 ? { topicEvents: mergedTopicEvents } : {}),
        updatedAt: timestamp,
        metadata: {
          ...existing.metadata,
          confidence: item.confidence,
          updatedAt: timestamp,
        },
      };
    }

    const id = ulid();
    newlyCreatedIds.push(id);
    return {
      id,
      date: conversation.startedAt,
      types: item.types,
      conversationId: conversation.id,
      content: item.content,
      summary: item.summary,
      keywords: item.keywords,
      themeIds: [],
      personIds: [],
      emotionIds: [],
      goalIds: [],
      ideaIds: [],
      eventIds: [],
      links: [],
      topicId: resolvedTopicId,
      eventTime: resolvedEventTime.eventTime,
      eventTimePrecision: resolvedEventTime.eventTimePrecision,
      ...(newProfileClaims.length > 0 ? { profileClaims: newProfileClaims } : {}),
      ...(newPersonMentions.length > 0 ? { personMentions: newPersonMentions } : {}),
      ...(newTopicEvents.length > 0 ? { topicEvents: newTopicEvents } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        id: ulid(),
        schemaVersion: SCHEMA_VERSION,
        source: "ai-capture",
        aiProvider: AI_PROVIDER,
        confidence: item.confidence,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  });

  // 品質の観測用（件数のみ。会話・claimの内容は含めない）
  if (profileProposed > 0) logTimingEvent("Capture profileClaims", { proposed: profileProposed, accepted: profileAccepted });
  // 品質の観測用（件数のみ。会話・mention内容は含めない）
  if (personProposed > 0) logTimingEvent("Capture personMentions", { proposed: personProposed, accepted: personAccepted });
  // 品質の観測用（件数のみ。会話・quote内容は含めない）
  if (topicProposed > 0) logTimingEvent("Capture topicEvents", { proposed: topicProposed, accepted: topicAccepted });

  const updatedConversation: Conversation = {
    ...conversation,
    status: "captured",
    memoryObjectIds:
      newlyCreatedIds.length === 0
        ? conversation.memoryObjectIds
        : [...conversation.memoryObjectIds, ...newlyCreatedIds],
    updatedAt: timestamp,
  };

  return { conversation: updatedConversation, memoryObjects };
}

export interface PersistCaptureResult {
  /** conversation自体のIndexedDB書き込みが失敗したか（Markdown書き込み失敗は含まない）。 */
  conversationFailed: boolean;
  /**
   * IndexedDBへの書き込みそのものが失敗し、この呼び出しでは保存できなかったMemoryObjectのid。
   * Markdown書き込みだけが失敗したMemoryはここに含めない（IndexedDBには残るため、
   * 次のflushPendingToVaultで自然に書き戻される＝失われてはいない）。
   */
  failedMemoryIds: string[];
  /**
   * H4 Codexレビュー指摘High-2対応：`awaitVaultSync=false`のときのみ非null。
   * 呼び出し元は必ず何らかの手段（ChatScreen.tsxのtrackMemoryTask等）で追跡し、
   * Vault切替の収束待ち（drainPendingMemoryTasks）がこれの完了も待てるようにすること。
   * 詳細は下のpersistConversation/persistCaptureのコメント参照。
   */
  backgroundSyncPromise: Promise<void> | null;
}

export interface PersistConversationResult {
  /** conversation自体のIndexedDB書き込みが失敗したか（Markdown書き込み失敗は含まない）。 */
  conversationFailed: boolean;
  /** PersistCaptureResult.backgroundSyncPromiseと同じ意味・同じ注意点。 */
  backgroundSyncPromise: Promise<void> | null;
}

/**
 * H4 Codexレビュー指摘High-2対応：`awaitVaultSync=false`のfire-and-forget Vault write
 * （Markdown書き込み＋sync ledger更新）が、それを開始したwithVaultWorldReadの共有ロック
 * 保持区間の外へ「無保護のまま」逃げてしまう問題への対処。
 *
 * 対策の骨子：
 * - Impl側（persistConversationImpl/persistCaptureImpl）は、awaitVaultSync=falseのときも
 *   その場でVault writeを`void`発火しない。代わりに「まだ実行していない、実行すると
 *   別の共有ロックを取得してからwriteとledger更新を行う」関数（サンク）だけを組み立てて
 *   返す（ロック解放後まで実行を遅延させる）。
 * - 公開版（persistConversation/persistCapture）が、自分自身のwithVaultWorldRead呼び出しが
 *   完全に解決した（＝そのロックを解放し終えた）後で、初めてこのサンクを呼び出す。
 *   ここで新しく取得するロックは、既に解放済みの別のロック要求の"後"に行う独立した
 *   要求であり、同じロックのネスト要求（デッドロックの原因）にはならない
 *   （vaultWorldLock.ts冒頭のデッドロック回避原則を参照）。
 * - これにより、呼び出し元（UI側）への応答は従来通り速いまま（IndexedDB保存が終わり次第
 *   すぐ返る）でありながら、実際のMarkdown書き込み・sync ledger更新自体は、開始から
 *   終了まで必ずどこかの共有ロックで保護された状態になる。他タブの排他ロック
 *   （Vault切替）取得は、Web Locks APIの標準動作により、この保護区間が終わるまで
 *   自動的に待たされる（追加の調整コードは不要）。
 * - 呼び出し元（ChatScreen.tsx）は、返されたbackgroundSyncPromiseを必ず
 *   pendingMemoryTasksRef（trackMemoryTask）で追跡すること。これにより、同一タブ内での
 *   「exclusive lock取得前に、まだ開始していないこの背景処理のロック要求を取りこぼす」
 *   自己デッドロック（drainPendingMemoryTasksが待つべき対象を認識できないまま
 *   排他ロックが先に要求されてしまう問題）も防げる。
 */
function scheduleBackgroundVaultSync(doSync: () => Promise<void>): () => Promise<void> {
  return () => withVaultWorldRead(doSync);
}

/**
 * Conversation本文だけを保存する（Memory生成・Captureの成否とは完全に独立）。
 *
 * 設計方針（Conversation本文保存とMemory生成の責務分離）：
 * このConversation Boundary再設計の目的そのものが「会話本文の保存」と「Memory生成
 * （Capture）」を明確に分けることにあるため、Conversation本文の保存はこの専用関数に
 * 一本化する。呼び出し元は2種類：
 *   - ChatScreen.tsx側：AI返信を受け取った直後、毎ターン呼ぶ（Captureの成否を待たない）
 *   - persistCapture（このファイル内）：Boundary Capture時、Memory保存とあわせて呼ぶ
 * どちらの経路でも実装は完全に同一（重複させない）。
 *
 * IndexedDBへの保存成功を「ユーザー操作上の保存完了」とする（Beta修正）。
 * 以前は「Markdown/.tsumugiが先、IndexedDBが後」の順で、かつ両方をawaitしていたため、
 * Android実機でVault write（Markdown書き込み）が遅い場合、ユーザー操作（「この会話を
 * 終える」等）がその完了まで待たされていた。今回、書き込み順序をIndexedDB→Vaultへ
 * 入れ替えた上で、`awaitVaultSync`が`false`のときはVault書き込みをawaitせず
 * fire-and-forgetで開始するだけにする（デフォルトは`true`＝従来通り両方awaitする。
 * 起動時キャッチアップ等、既存の呼び出し元の挙動を変えないため）。
 *
 * Vault書き込みが失敗しても例外を外へ投げない（内部でtry/catch済みのため、
 * fire-and-forgetにしても未処理Promise rejectionは発生しない）。失敗時はsync ledgerが
 * 更新されないため（vault.ts側の既存の仕組み）、次回のflushPendingToVaultで自然に
 * 再試行される。IndexedDBへの書き込み自体が失敗した場合のみ、本当に失敗として扱い
 * conversationFailedをtrueで返す。
 */
/**
 * Vault境界の安全性（H4対応）：共有ロック＋epoch確認で包んだ公開版。実処理は
 * `persistConversationImpl`（ロックを取得しない内部専用版）。`persistCapture`は
 * 自身の公開版がロックを保持したまま、この公開版を呼ぶとネストしてしまうため
 * （デッドロックの危険。vaultWorldLock.ts参照）、`persistCaptureImpl`からは
 * 必ず`persistConversationImpl`を直接呼ぶこと（公開版`persistConversation`を
 * 呼ばない）。
 */
export async function persistConversation(
  vaultHandle: FileSystemDirectoryHandle | null,
  conversation: Conversation,
  priority: VaultWritePriority = "interactive",
  awaitVaultSync: boolean = true
): Promise<PersistConversationResult> {
  const { conversationFailed, startBackgroundSync } = await withVaultWorldRead(() =>
    persistConversationImpl(vaultHandle, conversation, priority, awaitVaultSync)
  );
  // ロックは既に解放済み。ここで初めて（ネストしない、独立した新規ロック要求として）
  // 背景Vault writeを開始する（H4 Codexレビュー指摘High-2対応）。
  return { conversationFailed, backgroundSyncPromise: startBackgroundSync ? startBackgroundSync() : null };
}

interface PersistConversationImplResult {
  conversationFailed: boolean;
  /** ロック解放後にのみ呼び出すこと（呼び出し元＝persistConversation/persistCaptureImplの責務）。 */
  startBackgroundSync: (() => Promise<void>) | null;
}

async function persistConversationImpl(
  vaultHandle: FileSystemDirectoryHandle | null,
  conversation: Conversation,
  priority: VaultWritePriority = "interactive",
  awaitVaultSync: boolean = true
): Promise<PersistConversationImplResult> {
  // TEMP-TEST：20〜40秒の異常遅延の原因切り分け用。件数・経過時間のみ（会話内容は出さない）。
  // 原因調査が終わり次第削除すること。
  const persistStart = Date.now();
  console.log(`[Conversation] persist:start`);
  logTimingEvent("Conversation persist:start");

  let conversationFailed = false;
  try {
    await putConversation(conversation);
  } catch (error) {
    console.error("[Tsumugi] conversation IndexedDB write failed:", error);
    conversationFailed = true;
  }

  let startBackgroundSync: (() => Promise<void>) | null = null;
  if (vaultHandle) {
    const syncToVault = async () => {
      try {
        await writeConversationMarkdown(vaultHandle, conversation, priority);
      } catch (error) {
        console.error("[Tsumugi] conversation markdown write failed (will retry on next vault flush):", error);
      }
    };
    if (awaitVaultSync) {
      await syncToVault();
    } else {
      // H4 Codexレビュー指摘High-2対応：ここでは発火しない（まだ現在のロックの内側のため）。
      // 呼び出し元がロック解放後に呼び出すサンクとしてのみ渡す。
      startBackgroundSync = scheduleBackgroundVaultSync(syncToVault);
    }
  }

  const persistDurationMs = Date.now() - persistStart;
  console.log(`[Conversation] persist:end durationMs=${persistDurationMs}`);
  logTimingEvent("Conversation persist:end", { durationMs: persistDurationMs });
  return { conversationFailed, startBackgroundSync };
}

/**
 * Conversation本文の保存自体はpersistConversationへ委譲。ここではそれにMemoryObjectの
 * 保存を組み合わせる。
 *
 * 各書き込みを個別のtry/catchで分離する（Beta修正）。以前はMemoryObjectのMarkdown書き込みが
 * 1件でも失敗すると関数全体が例外を投げ、それ以前に成功していたMemoryも含めて一切
 * IndexedDBへ保存されなかった（=静かに消失していた）。今回の修正では：
 * - Markdown書き込みの失敗は、そのMemoryのIndexedDB保存をブロックしない（Markdownには
 *   残らないが、IndexedDBには残るので、次にVaultへ接続・再接続した際のflushPendingToVaultが
 *   自動的に書き戻す。つまりMarkdown書き込み失敗は「失われる」のではなく「vaultへの反映が
 *   次回に持ち越される」だけにする）。
 * - IndexedDBへの書き込み自体が失敗した場合のみ、そのMemoryを本当に失敗として扱い、
 *   呼び出し元（runConversationBoundary）が画面に表示できるようfailedMemoryIdsで返す。
 * - 1件の失敗が他の件の処理を止めない（ループを継続する）。
 *
 * IndexedDBへの保存成功を「ユーザー操作上の保存完了」とする（Beta修正）。各Memoryも
 * ConversationならびにIndexedDBへのputを先に行い、Vaultへの書き込みはその後にする。
 * `awaitVaultSync`が`false`のときは、そのVault書き込みをawaitせずfire-and-forgetで
 * 開始するだけにする（デフォルトは`true`＝従来通り。起動時キャッチアップ等、既存の
 * 呼び出し元の挙動を変えないため）。Vault書き込みの失敗は内部でtry/catch済みのため、
 * fire-and-forgetにしても未処理Promise rejectionは発生しない。
 */
/**
 * Vault境界の安全性（H4対応）：共有ロック＋epoch確認で包んだ公開版。実処理は
 * `persistCaptureImpl`（ロックを取得しない内部専用版）。
 */
export async function persistCapture(
  vaultHandle: FileSystemDirectoryHandle | null,
  conversation: Conversation,
  memoryObjects: MemoryObject[],
  priority: VaultWritePriority = "interactive",
  awaitVaultSync: boolean = true
): Promise<PersistCaptureResult> {
  const { conversationFailed, failedMemoryIds, startBackgroundSync } = await withVaultWorldRead(() =>
    persistCaptureImpl(vaultHandle, conversation, memoryObjects, priority, awaitVaultSync)
  );
  // ロックは既に解放済み。ここで初めて（ネストしない、独立した新規ロック要求として）
  // 背景Vault write群をまとめて開始する（H4 Codexレビュー指摘High-2対応）。
  return { conversationFailed, failedMemoryIds, backgroundSyncPromise: startBackgroundSync ? startBackgroundSync() : null };
}

interface PersistCaptureImplResult {
  conversationFailed: boolean;
  failedMemoryIds: string[];
  /** ロック解放後にのみ呼び出すこと（呼び出し元＝persistCaptureの責務）。 */
  startBackgroundSync: (() => Promise<void>) | null;
}

async function persistCaptureImpl(
  vaultHandle: FileSystemDirectoryHandle | null,
  conversation: Conversation,
  memoryObjects: MemoryObject[],
  priority: VaultWritePriority = "interactive",
  awaitVaultSync: boolean = true
): Promise<PersistCaptureImplResult> {
  // ネスト回避のため、公開版persistConversation（ロック付き）ではなく
  // persistConversationImpl（ロック無し）を直接呼ぶ（vaultWorldLock.ts参照）。
  const { conversationFailed, startBackgroundSync: conversationStartBackgroundSync } = await persistConversationImpl(
    vaultHandle,
    conversation,
    priority,
    awaitVaultSync
  );

  const failedMemoryIds: string[] = [];
  // H4 Codexレビュー指摘High-2対応：conversation分と合わせて、まだ実行していない
  // 背景sync（サンク）をここへ集める。ここで`void`発火・awaitはしない
  // （現在のロックの内側のため。呼び出し元＝persistCaptureがロック解放後にまとめて呼ぶ）。
  const memoryStartBackgroundSyncs: (() => Promise<void>)[] = [];
  for (const memoryObject of memoryObjects) {
    try {
      await putMemoryObject(memoryObject);
    } catch (error) {
      console.error(`[Tsumugi Capture] memory IndexedDB write failed for ${memoryObject.id}:`, error);
      failedMemoryIds.push(memoryObject.id);
    }

    if (vaultHandle) {
      const syncToVault = async () => {
        try {
          await writeMemoryObjectMarkdown(vaultHandle, memoryObject, priority);
        } catch (error) {
          console.error(
            `[Tsumugi Capture] memory markdown write failed for ${memoryObject.id} (will retry on next vault flush):`,
            error
          );
        }
      };
      if (awaitVaultSync) {
        await syncToVault();
      } else {
        memoryStartBackgroundSyncs.push(scheduleBackgroundVaultSync(syncToVault));
      }
    }
  }

  const allStarts = [
    ...(conversationStartBackgroundSync ? [conversationStartBackgroundSync] : []),
    ...memoryStartBackgroundSyncs,
  ];
  // conversation・memoryObjects複数件ぶんの背景syncを、呼び出し元からは1つのPromiseとして
  // 扱えるようまとめる（個々は内部でtry/catch済みのため、ここでも例外を投げない）。
  const startBackgroundSync =
    allStarts.length > 0 ? () => Promise.all(allStarts.map((start) => start())).then(() => undefined) : null;

  return { conversationFailed, failedMemoryIds, startBackgroundSync };
}
