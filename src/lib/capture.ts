/**
 * クライアント側のCaptureオーケストレーション（MEMORY_ENGINE.md 2.2）。
 * 会話が一往復進むたびに呼ばれ、そのConversationから意味のある単位でMemoryObjectを
 * 複数抽出しうる（1 Conversation = 1 Memoryとは限らない）。
 * まだ他の記憶とは接続しない（Connectは行わない。ROADMAP.md Phase 2のスコープ）。
 */
"use client";

import { ulid } from "ulid";
import { getAllMemoryObjects, loadApiKey, putConversation, putMemoryObject } from "./db";
import { writeConversationMarkdown, writeMemoryObjectMarkdown } from "./vault";
import { isSameConversation, scoreMemory, KEYWORD_WEIGHT, DEFAULT_LIMIT } from "./retrieval";
import { SCHEMA_VERSION } from "./types";
import type { Conversation, ConversationTurn, MemoryObject, MemoryType, Persona } from "./types";
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

interface ExtractedMemory {
  existingMemoryId?: string;
  summary: string;
  content: string;
  keywords: string[];
  types: MemoryType[];
  confidence: number;
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
export async function captureConversation(
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

  const memoryObjects: MemoryObject[] = extracted.map((item) => {
    const existing = item.existingMemoryId ? existingById.get(item.existingMemoryId) : undefined;

    if (existing) {
      return {
        ...existing,
        content: item.content,
        summary: item.summary,
        keywords: item.keywords,
        types: item.types,
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
}

/**
 * STORAGE.md §2.3「書き込みは常にMarkdown/.tsumugiが先、IndexedDBが後」を実装として守る。
 * vaultHandleがまだ無い場合はIndexedDBにのみ保存し、Vault接続後にflushPendingToVaultで書き戻す。
 *
 * 各書き込みを個別のtry/catchで分離する（Beta修正）。以前はMemoryObjectのMarkdown書き込みが
 * 1件でも失敗すると関数全体が例外を投げ、それ以前に成功していたMemoryも含めて一切
 * IndexedDBへ保存されなかった（=静かに消失していた）。今回の修正では：
 * - Markdown書き込みの失敗は、そのMemoryのIndexedDB保存をブロックしない（Markdownには
 *   残らないが、IndexedDBには残るので、次にVaultへ接続・再接続した際のflushPendingToVaultが
 *   自動的に書き戻す。つまりMarkdown書き込み失敗は「失われる」のではなく「vaultへの反映が
 *   次回に持ち越される」だけにする）。
 * - IndexedDBへの書き込み自体が失敗した場合のみ、そのMemoryを本当に失敗として扱い、
 *   呼び出し元（enqueueCapture）が画面に表示できるようfailedMemoryIdsで返す。
 * - 1件の失敗が他の件の処理を止めない（ループを継続する）。
 */
export async function persistCapture(
  vaultHandle: FileSystemDirectoryHandle | null,
  conversation: Conversation,
  memoryObjects: MemoryObject[]
): Promise<PersistCaptureResult> {
  if (vaultHandle) {
    try {
      await writeConversationMarkdown(vaultHandle, conversation);
    } catch (error) {
      console.error("[Tsumugi Capture] conversation markdown write failed (will retry on next vault flush):", error);
    }
  }

  let conversationFailed = false;
  try {
    await putConversation(conversation);
  } catch (error) {
    console.error("[Tsumugi Capture] conversation IndexedDB write failed:", error);
    conversationFailed = true;
  }

  const failedMemoryIds: string[] = [];
  for (const memoryObject of memoryObjects) {
    if (vaultHandle) {
      try {
        await writeMemoryObjectMarkdown(vaultHandle, memoryObject);
      } catch (error) {
        console.error(
          `[Tsumugi Capture] memory markdown write failed for ${memoryObject.id} (will retry on next vault flush):`,
          error
        );
      }
    }
    try {
      await putMemoryObject(memoryObject);
    } catch (error) {
      console.error(`[Tsumugi Capture] memory IndexedDB write failed for ${memoryObject.id}:`, error);
      failedMemoryIds.push(memoryObject.id);
    }
  }

  return { conversationFailed, failedMemoryIds };
}
