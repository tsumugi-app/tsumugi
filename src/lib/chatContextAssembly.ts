/**
 * 自動評価基盤 E1：会話の画面が /api/chat へ送る「過去の文脈」を組み立てる処理（ChatScreen.tsx から、そのまま切り出したもの）。
 *
 * - 会話の画面（ChatScreen）と、自動評価（テスト）の両方が、この同じ関数を呼ぶ。
 * - 処理の内容・順序・件数・失敗時の扱いは、切り出す前の ChatScreen と同じ（chatContextAssembly.test.ts が、切り出す前の処理の写しと比べる）。
 * - 端末の保存領域（IndexedDB・Vault・合成のキャッシュ）を読む部分と、試験設定の判定は、引数（sources・flags）で渡す。
 *   会話の画面は実際のものを渡す（chatContextSources.ts）。テストは固定した架空のデータを渡す。呼ぶ順序と回数は切り出す前と同じ。
 * - 現在時刻は now で渡す（直前の会話の判定に使う）。Retrieval の新しさの計算・合成の仮説の有効期限など、
 *   この関数の外のモジュールが自分で読む時刻は、ここでは固定しない（テストは Date を固定して揃える）。
 * - AI は呼ばない。保存もしない（合成の仮説を見せた記録だけは、切り出す前と同じ位置で sources.recordSynthesisShown を呼ぶ）。
 */
import { isReflectiveQuery, REFLECTIVE_LIMIT, REFLECTIVE_MAX_LINKED_ADDITIONS, type RetrieveRelevantMemoriesOptions } from "./retrieval";
import { buildRecentConversationPayload, type RecentConversationPayload } from "./recentConversation";
import { buildTopicContinuityPayload, type TopicContinuityCandidate } from "./topicContinuity";
import { computeProfileFacts, selectProfileContext, type ProfileContext } from "./profile";
import { computePersonViews, PERSON_VIEW_CONTEXT_LIMIT, type PersonView } from "./person";
import { computeTopicTimelines, TOPIC_TIMELINE_BUDGET, type TopicTimeline } from "./topicEvent";
import { buildExplicitSearchContext, type ExplicitSearchContext } from "./memorySearch";
import { buildMemoryAnalyticsContext, type MemoryAnalyticsContext } from "./memoryAnalytics";
import { safeSelectTimelineForTurn, type SynthesisThemeContext } from "./memorySynthesis";
import { selectPersonContextsForTurn, withoutCoveredPersonViews, type PersonContext } from "./personContext";
import { StaleVaultTabError } from "./vaultWorldLock";
import type { ReflectionTrace } from "./chatContextProvenance";
import type { Conversation, ConversationTurn, MemoryObject, Persona, RetrievedMemory } from "./types";

/** 端末の保存領域を読む部分（会話の画面は chatContextSources.ts の実物、テストは架空のデータ） */
export interface ChatContextSources {
  /** 記憶の検索（会話の画面は retrieveRelevantMemories：ロックを取ってから検索する） */
  retrieve(text: string, options: RetrieveRelevantMemoriesOptions): Promise<RetrievedMemory[]>;
  /** 本人が確定した同じ人物の名前の組（Memory Graph が ON のときだけ呼ぶ） */
  loadConfirmedAliasLists(): Promise<string[][]>;
  /** すべての会話（ロックを取って読む） */
  loadConversations(): Promise<Conversation[]>;
  /** すべての Memory（ロックを取って読む） */
  loadMemories(): Promise<MemoryObject[]>;
  /** Memory Synthesis が ON のときの経緯と仮説（synthesisChat.ts の synthesisContextForTurn） */
  synthesisContextForTurn(memories: MemoryObject[], turn: { userText: string; retrievedMemoryIds: string[] }): Promise<{ contexts: SynthesisThemeContext[]; shownIds: string[] }>;
  /** 仮説を見せた記録（synthesisChat.ts の recordSynthesisShown） */
  recordSynthesisShown(hypothesisIds: string[], conversationId: string): void;
}

/**
 * 試験設定と診断の判定。切り出す前と同じ位置・同じ回数で読む（どれもURLを端末に書き写すことがあるため、まとめて先に読まない）。
 * Memory Synthesis が ON のときは Memory Timeline を読まない（切り出す前と同じ）。
 */
export interface ChatContextFlags {
  memoryGraph(): boolean;
  memoryTimeline(): boolean;
  memorySynthesis(): boolean;
  /** `?debugLog=1`（診断の記録だけ。送る内容は変えない） */
  diagnostics(): boolean;
}

export interface ChatContextInput {
  /** 今回のユーザーの発言（送信した本文） */
  text: string;
  /** 今回の発言を加えた後の、現在の会話の発言 */
  turns: readonly ConversationTurn[];
  conversationId: string;
  promptedMemoryId?: string;
  persona: Persona;
  /** 現在時刻（ミリ秒）を返す。直前の会話の判定に使う（切り出す前と同じく、会話の一覧を読み終えた時点で1回だけ呼ぶ）。会話の画面は Date.now */
  now: () => number;
}

/** /api/chat へ送る過去の文脈（値は、切り出す前の ChatScreen の同じ名前の変数と同じ） */
export interface AssembledChatContext {
  recentUserTurnsTexts: string[];
  retrievedMemories: RetrievedMemory[];
  recentConversation: RecentConversationPayload | null;
  topicContext: TopicContinuityCandidate[] | null;
  profileContext: ProfileContext | null;
  personViewContext: PersonView[] | null;
  topicTimelineContext: TopicTimeline[] | null;
  explicitSearchContext: ExplicitSearchContext | null;
  memoryAnalyticsContext: MemoryAnalyticsContext | null;
  memoryTimelineContext: SynthesisThemeContext[];
  personGraphContext: PersonContext[];
  /** 診断のときだけ：Retrieval が Reflection をどう扱ったか */
  reflectionTrace: ReflectionTrace | null;
  /** 診断のときだけ：由来を探すための Memory 一覧（診断でなければ空） */
  memoriesForProvenance: MemoryObject[];
}

export async function assembleChatContext(input: ChatContextInput, sources: ChatContextSources, flags: ChatContextFlags): Promise<AssembledChatContext> {
  const { text } = input;
  // Retrieval Engine（ローカルのみ・AIを呼ばない）。毎ターン実行し、
  // 使うかどうかの判断は/api/chat側のAIに委ねる（0件ならそのまま0件で渡す）。
  // 明示的Reflection（ROADMAP.md Phase 2）：ローカル判定のみでlimitとLink経由上限を広げる。
  // 判定がfalseの場合は既定のまま、Phase 1からの挙動を完全に維持する。
  const reflective = isReflectiveQuery(text);
  // Conversation Retrieval（analyst専用、Conversation品質改善 第2修正）が使う、
  // 直近の同一Conversation内user turns本文。turns全文を検索クエリへ連結するのではなく、
  // retrieval.ts側でkeyword単位の存在判定だけに使う（deriveConversationTopicAnchors参照）。
  // companion/coachはこのフィールドを読まないため、常に渡しても挙動に影響しない。
  const recentUserTurnsTexts = input.turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content.trim())
    .filter(Boolean);
  // Memory Graph P1-B（試験フラグONのときだけ）：本人が確定した同じ人物の名前の組（端末内。読めなければ空＝従来どおり）
  const personAliases = flags.memoryGraph() ? await sources.loadConfirmedAliasLists() : [];
  // P1-F：診断（?debugLog=1）のときだけ、RetrievalがReflectionをどう扱ったかを受け取る（結果は変わらない）
  let reflectionTrace: ReflectionTrace | null = null;
  const retrievedMemories = await sources.retrieve(text, {
    excludeConversationId: input.conversationId,
    limit: reflective ? REFLECTIVE_LIMIT : undefined,
    maxLinkedAdditions: reflective ? REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
    persona: input.persona,
    promptedMemoryId: input.promptedMemoryId,
    recentUserTurnsTexts,
    // 会話品質改善 第1段階：選ばれたMemoryに、話題の人物と、要約に無い本人の発言の一文を添える（memoryContext.ts）
    includeContext: true,
    personAliases,
    // P1-F：AIが書いた日記の振り返り（Reflection）は、本人の記録の後に回す（会話の画面だけ。Connect等は従来どおり）
    deferReflections: true,
    // 過去を尋ねる質問では、話題の語（「車」など）を一般語として減点せず、「車種」「車選び」のような形の違いも話題として数える（会話の画面だけ）
    recallTopic: true,
    // 質問の目的（好み・望み・変化・人物の行動・質問そのもの）に合う、話題に一致する記録を先に。過去を尋ねただけの記録は後ろに回す（会話の画面だけ）
    purposeRelevance: true,
    ...(flags.diagnostics() ? { onReflectionTrace: (trace: ReflectionTrace) => { reflectionTrace = trace; } } : {}),
  });

  // Recent Conversation Context（Current Conversation → Recent Conversation → Memory Retrieval
  // の中間層。Recent Conversation Continuity v1）。数時間以内に終了した直前Conversationの
  // 末尾6 turnだけを、現在turnsとは別枠として/api/chatへ渡す（recentConversation.ts参照）。
  // Vault境界の安全性（H4対応）：getAllConversations()はロックを取らないprimitiveのため、
  // withVaultWorldReadで包む（sources.loadConversations）。取得失敗は
  // StaleVaultTabErrorのみ上位へ再送出し、それ以外は会話送信をブロックせずnullで続行する。
  let recentConversation: RecentConversationPayload | null = null;
  try {
    const allConversations = await sources.loadConversations();
    recentConversation = buildRecentConversationPayload(allConversations, input.conversationId, input.now());
  } catch (recentError) {
    if (recentError instanceof StaleVaultTabError) throw recentError;
    console.error("Failed to load recent conversation context", recentError);
  }

  // Topic Continuity Context v1（Recent ConversationとMemory Retrievalの間の層。
  // topicContinuity.ts参照）。「昨日の話なんだけど」のようなcontinuity signalが
  // 現在発言にある場合のみ、MemoryObject.topicId（Capture時に判定・付与済み、
  // Topic Continuity Phase 1）でグルーピングした話題候補（最大3件、各最大3 Memory、
  // summary/date/keywordsのみ）を/api/chatへ別枠で渡す。どのtopicの続きか・
  // どれも使うべきでないかの最終判断はローカルでは行わず、/api/chatの既存LLM呼び出しへ
  // 委ねる（新しいAPI/LLM callは追加しない）。取得失敗は既存recentConversationと同じ
  // 方針：StaleVaultTabErrorのみ上位へ再送出、それ以外は会話送信をブロックせずnullで続行。
  let topicContext: TopicContinuityCandidate[] | null = null;
  // Personal Profile v1：同じMemory一覧から、派生ビュー（ProfileFact）を計算し、今回の話題に関連する少量だけを選ぶ
  // （追加のAPI呼び出し・保存は無い。失敗しても会話送信をブロックしない）。
  let profileContext: ProfileContext | null = null;
  // Topic / Current State v1 + Person View Context Assembly：Person Memoryは今まで
  // 保存されるだけでChat Contextへ一切接続されていなかった。ここで初めて接続する。
  // どちらも追加のAPI呼び出し・保存は無い（computePersonViews()/computeTopicTimelines()は
  // ローカルの純粋関数。失敗しても会話送信をブロックしない）。
  let personViewContext: PersonView[] | null = null;
  let topicTimelineContext: TopicTimeline[] | null = null;
  // Explicit Memory Search Phase 1：ユーザーが保存済みの過去を明示的に探す発言のときだけ、保存済みMemory全体を検索する
  // （通常のAssociative Recall＝上のretrievedMemoriesは変更しない。追加のIDB読み込み・API呼び出しは無い）。
  let explicitSearchContext: ExplicitSearchContext | null = null;
  // Memory Analytics Phase 1：保存済みMemory全体の集計（キーワードランキング）を求める発言のときだけ、code側で集計する。
  // 優先順位は Memory Analytics → Explicit Search → 通常Retrieval。Analyticsが成立した発言は、Explicit Searchとして処理しない。
  let memoryAnalyticsContext: MemoryAnalyticsContext | null = null;
  // Memory Timeline（試験接続・既定OFF）：関連があり、通常のRetrievalに不足する経緯だけ。同じMemory一覧を再利用（追加のIDB読み込み・API呼び出し・保存は無い）。
  let memoryTimelineContext: SynthesisThemeContext[] = [];
  // Memory Graph P1-A（試験・既定OFF）：話題の人物の背景（結論・理由・後からの説明・予定と結果）。同じMemory一覧から端末内で組み立てる（AI呼び出し・保存は無い）
  let personGraphContext: PersonContext[] = [];
  // P1-F：診断のときだけ、ID を持たない経路（話題の候補・経緯）の記録を探すために使う（同じ一覧。追加の読み込みは無い）
  let memoriesForProvenance: MemoryObject[] = [];
  try {
    const allMemoriesForTopicContinuity = await sources.loadMemories();
    if (flags.diagnostics()) memoriesForProvenance = allMemoriesForTopicContinuity;
    try {
      memoryAnalyticsContext = buildMemoryAnalyticsContext(allMemoriesForTopicContinuity, text, { excludeConversationId: input.conversationId });
    } catch (analyticsError) {
      console.error("Failed to run memory analytics", analyticsError);
    }
    try {
      if (memoryAnalyticsContext === null) {
        explicitSearchContext = buildExplicitSearchContext(allMemoriesForTopicContinuity, text, { excludeConversationId: input.conversationId });
      }
    } catch (searchError) {
      console.error("Failed to run explicit memory search", searchError);
    }
    topicContext = buildTopicContinuityPayload(allMemoriesForTopicContinuity, text);
    try {
      const recentUserTexts = input.turns.filter((turn) => turn.role === "user").slice(-3).map((turn) => turn.content).reverse();
      const selected = selectProfileContext(computeProfileFacts(allMemoriesForTopicContinuity), { userTexts: recentUserTexts.length > 0 ? recentUserTexts : [text] });
      if (selected.core.length + selected.relevant.length > 0) profileContext = selected;
    } catch (profileError) {
      console.error("Failed to build profile context", profileError);
    }
    try {
      // 「今回の会話に関係する人物・topicIdだけ」を、既存Retrievalが選んだMemory
      // （retrievedMemories）を起点に特定する（新しいセマンティック検索は作らない。
      // 既にIDBから読み込み済みのallMemoriesForTopicContinuityを再利用するだけで、
      // 追加のIDB読み込みは発生させない）。
      const retrievedIds = new Set(retrievedMemories.map((memory) => memory.id));
      const relevantMemories = allMemoriesForTopicContinuity.filter((memory) => retrievedIds.has(memory.id));
      const relevantGroupingKeys = new Set(
        relevantMemories.flatMap((memory) => (memory.personMentions ?? []).map((mention) => mention.groupingKey))
      );
      if (relevantGroupingKeys.size > 0) {
        const views = computePersonViews(allMemoriesForTopicContinuity).filter((view) => relevantGroupingKeys.has(view.groupingKey));
        if (views.length > 0) personViewContext = views.slice(0, PERSON_VIEW_CONTEXT_LIMIT);
      }
      const relevantTopicIds = [
        ...new Set(relevantMemories.map((memory) => memory.topicId).filter((id): id is string => Boolean(id))),
      ].slice(0, TOPIC_TIMELINE_BUDGET.maxTopics);
      if (relevantTopicIds.length > 0) {
        const timelines = computeTopicTimelines(allMemoriesForTopicContinuity, relevantTopicIds);
        if (timelines.length > 0) topicTimelineContext = timelines;
      }
    } catch (personTopicError) {
      console.error("Failed to build person view / topic timeline context", personTopicError);
    }
    if (flags.memoryGraph()) {
      // 失敗しても空配列（personContext.ts）。この人物のPersonViewは背景に含まれるので二重に送らない
      personGraphContext = selectPersonContextsForTurn(allMemoriesForTopicContinuity, { userText: text, earlierUserTurns: recentUserTurnsTexts.slice(0, -1), excludeConversationId: input.conversationId, alreadyGivenIds: retrievedMemories.map((memory) => memory.id), aliases: personAliases });
      personViewContext = withoutCoveredPersonViews(personViewContext, personGraphContext);
    }
    if (flags.memorySynthesis()) {
      // Memory Synthesis S1（試験・既定OFF）：経緯に、そのテーマのTsumugiの仮説（端末内キャッシュ）を添える。AI呼び出しは無い。失敗時は経緯だけ（synthesisChat.ts）。
      const synthesisTurn = await sources.synthesisContextForTurn(
        allMemoriesForTopicContinuity.filter((memory) => memory.conversationId !== input.conversationId),
        { userText: text, retrievedMemoryIds: retrievedMemories.map((memory) => memory.id) }
      );
      memoryTimelineContext = synthesisTurn.contexts;
      sources.recordSynthesisShown(synthesisTurn.shownIds, input.conversationId);
    } else if (flags.memoryTimeline()) {
      // 失敗しても空配列（会話は通常のRetrievalだけで続く）。今の会話自身のMemoryは、Retrievalと同じく使わない。
      memoryTimelineContext = safeSelectTimelineForTurn(
        allMemoriesForTopicContinuity.filter((memory) => memory.conversationId !== input.conversationId),
        { userText: text, retrievedMemoryIds: retrievedMemories.map((memory) => memory.id) }
      );
    }
  } catch (topicError) {
    if (topicError instanceof StaleVaultTabError) throw topicError;
    console.error("Failed to load topic continuity context", topicError);
  }

  return {
    recentUserTurnsTexts,
    retrievedMemories,
    recentConversation,
    topicContext,
    profileContext,
    personViewContext,
    topicTimelineContext,
    explicitSearchContext,
    memoryAnalyticsContext,
    memoryTimelineContext,
    personGraphContext,
    reflectionTrace,
    memoriesForProvenance,
  };
}

/**
 * /api/chat の本文のうち、過去の文脈の部分（retrievedMemories から contextDedupe まで）。
 * キーの順序と、空のときに送らない規則は、切り出す前の ChatScreen と同じ（JSON の文字列まで同じになる）。
 */
export function chatContextRequestFields(ctx: AssembledChatContext, opts: { generationId?: string; contextDedupe: boolean }): Record<string, unknown> {
  return {
    retrievedMemories: ctx.retrievedMemories,
    ...(ctx.recentConversation ? { recentConversation: ctx.recentConversation } : {}),
    ...(ctx.topicContext ? { topicContext: ctx.topicContext } : {}),
    ...(ctx.profileContext ? { profile: ctx.profileContext } : {}),
    ...(ctx.personViewContext ? { personView: ctx.personViewContext } : {}),
    ...(ctx.topicTimelineContext ? { topicTimeline: ctx.topicTimelineContext } : {}),
    ...(ctx.explicitSearchContext ? { explicitSearch: ctx.explicitSearchContext } : {}),
    ...(ctx.memoryAnalyticsContext ? { memoryAnalytics: ctx.memoryAnalyticsContext } : {}),
    ...(ctx.memoryTimelineContext.length > 0 ? { memoryTimeline: ctx.memoryTimelineContext } : {}),
    ...(ctx.personGraphContext.length > 0 ? { personContext: ctx.personGraphContext } : {}),
    ...(opts.generationId ? { debugGenerationId: opts.generationId } : {}),
    ...(opts.contextDedupe ? { contextDedupe: true } : {}),
  };
}
