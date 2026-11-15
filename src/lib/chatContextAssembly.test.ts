/**
 * 自動評価基盤 E1：会話の過去の文脈の組み立て（chatContextAssembly.ts）が、切り出す前の ChatScreen と同じ値を作ることを確かめる。架空のデータだけ。
 *
 * - 「前」＝ main f55e738 の ChatScreen.tsx（5027〜5179行目と、/api/chat の本文の過去の文脈の部分）をそのまま写した legacyAssemble / legacyFields。
 *   写しの中の文字は変えていない（字下げだけ詰めた）。端末の読み込み先と試験設定の判定は、同じ名前の関数として渡す。
 * - 「後」＝ assembleChatContext と chatContextRequestFields（会話の画面が実際に呼ぶもの）。
 * - 同じ架空の記録・同じ固定時刻・同じ設定で、両方を Memory Graph / Memory Timeline / Memory Synthesis / 診断（?debugLog=1）/ contextDedupe の
 *   32 通りすべてで動かし、次を比べる：組み立てた値のすべて、/api/chat の本文（JSONの文字列）、サーバーの最終プロンプトと会話の並び、
 *   読み込み先・設定の判定を呼んだ順序と回数（合成の仮説を見せた記録を含む）、AI の呼び出し回数。
 * - 時刻は node:test の Date の固定で揃える（ChatScreen の now、Retrieval の新しさ、サーバーの現在日時の行が、すべて同じ時刻を読む）。
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
type Conversation = import("./types").Conversation;
type ConversationTurn = import("./types").ConversationTurn;
type Persona = import("./types").Persona;
type ReflectionTrace = import("./chatContextProvenance").ReflectionTrace;
type RecentConversationPayload = import("./recentConversation").RecentConversationPayload;
type TopicContinuityCandidate = import("./topicContinuity").TopicContinuityCandidate;
type ProfileContext = import("./profile").ProfileContext;
type PersonView = import("./person").PersonView;
type TopicTimeline = import("./topicEvent").TopicTimeline;
type ExplicitSearchContext = import("./memorySearch").ExplicitSearchContext;
type MemoryAnalyticsContext = import("./memoryAnalytics").MemoryAnalyticsContext;
type SynthesisThemeContext = import("./memorySynthesis").SynthesisThemeContext;
type PersonContext = import("./personContext").PersonContext;
type RetrieveOptions = import("./retrieval").RetrieveRelevantMemoriesOptions;

class StaleVaultTabError extends Error {}
let pool: MemoryObject[] = [];
const rec: { systemInstruction: string; turns: unknown; calls: number } = { systemInstruction: "", turns: null, calls: 0 };
const fakeProvider = {
  async generateStream(req: { systemInstruction?: string; turns?: unknown }) {
    rec.systemInstruction = req.systemInstruction ?? "";
    rec.turns = req.turns ?? null;
    rec.calls += 1;
    return (async function* () { yield { text: "返答です。", finishReason: "stop" as const }; })();
  },
};
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveRequestedProvider: () => "gemini" },
  "./db": { getAllMemoryObjects: async () => pool, getAllConversations: async () => [], getMemoryObject: async (id: string) => pool.find((m) => m.id === id) },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn(), StaleVaultTabError },
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown; _resolveFilename: (request: string, ...rest: unknown[]) => string };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "@/lib/ai/resolve") return stubs[request];
  if ((parent?.filename?.startsWith(ROOT) ?? false) && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const asm = require(path.join(ROOT, "lib/chatContextAssembly.js")) as typeof import("./chatContextAssembly");
const r = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const { isReflectiveQuery, REFLECTIVE_LIMIT, REFLECTIVE_MAX_LINKED_ADDITIONS } = r;
const { buildRecentConversationPayload } = require(path.join(ROOT, "lib/recentConversation.js")) as typeof import("./recentConversation");
const { buildTopicContinuityPayload } = require(path.join(ROOT, "lib/topicContinuity.js")) as typeof import("./topicContinuity");
const { computeProfileFacts, selectProfileContext } = require(path.join(ROOT, "lib/profile.js")) as typeof import("./profile");
const { computePersonViews, PERSON_VIEW_CONTEXT_LIMIT } = require(path.join(ROOT, "lib/person.js")) as typeof import("./person");
const { computeTopicTimelines, TOPIC_TIMELINE_BUDGET } = require(path.join(ROOT, "lib/topicEvent.js")) as typeof import("./topicEvent");
const { buildExplicitSearchContext } = require(path.join(ROOT, "lib/memorySearch.js")) as typeof import("./memorySearch");
const { buildMemoryAnalyticsContext } = require(path.join(ROOT, "lib/memoryAnalytics.js")) as typeof import("./memoryAnalytics");
const { safeSelectTimelineForTurn } = require(path.join(ROOT, "lib/memorySynthesis.js")) as typeof import("./memorySynthesis");
const { selectPersonContextsForTurn, withoutCoveredPersonViews } = require(path.join(ROOT, "lib/personContext.js")) as typeof import("./personContext");
const { turnsForAi } = require(path.join(ROOT, "lib/aiReplyOutcome.js")) as typeof import("./aiReplyOutcome");
const { FICTIONAL_USERS } = require(path.join(ROOT, "lib/synthesisFictionalData.js")) as typeof import("./synthesisFictionalData");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };

// ---- the fictional world (user C of synthesisFictionalData: 拓也・車・引っ越し・英語 are invented), with the person / topic / profile fields Capture adds
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const at = (day: string) => `${day}T12:00:00.000Z`;
const TAKUYA = new Set(["sync-mem-03", "sync-mem-08", "sync-mem-16", "sync-mem-19"]);
const CAR = new Set(["sync-mem-07", "sync-mem-09", "sync-mem-12", "sync-mem-15"]);
function world(): MemoryObject[] {
  return FICTIONAL_USERS.find((u) => u.id === "C")!.memories().map((m) => {
    const quote = (m.evidenceQuotes ?? [])[0] ?? m.summary;
    const day = m.date.slice(0, 10);
    const extra: Record<string, unknown> = {};
    if (TAKUYA.has(m.id)) {
      extra.personMentions = [{ id: `pm-${m.id}`, groupingKey: "拓也", displayName: "拓也", assertion: "mention", stated: "explicit", quote, statedAt: at(day), sourceConversationId: m.conversationId, recordedAt: at(day), origin: "ai-extracted", schemaVersion: 1 }];
    }
    if (CAR.has(m.id)) {
      extra.topicId = "topic-car";
      extra.topicEvents = [{ id: `te-${m.id}`, topicId: "topic-car", quote, statedAt: at(day), sourceConversationId: m.conversationId, recordedAt: at(day), origin: "ai-extracted", schemaVersion: 1 }];
    }
    if (m.id === "sync-mem-06") {
      extra.profileClaims = [{ id: "pc-home", category: "residence", slot: "residence:primary", value: "駅近", statement: "駅に近い部屋に住んでいる", tense: "current", change: "began", stated: "explicit", quote, statedAt: at(day), sourceConversationId: m.conversationId, recordedAt: at(day), origin: "ai-extracted", schemaVersion: 1 }];
    }
    return { ...m, ...extra } as MemoryObject;
  });
}
/** a conversation that ended an hour before NOW (the recent conversation), and an old one */
const CONVERSATIONS = [
  { id: "conv-recent", persona: "companion", startedAt: "2026-10-25T10:30:00.000Z", endedAt: "2026-10-25T11:00:00.000Z", createdAt: "2026-10-25T10:30:00.000Z", updatedAt: "2026-10-25T11:00:00.000Z", memoryObjectIds: [],
    turns: [{ role: "user", content: "今日は朝から英語をやった", timestamp: "2026-10-25T10:31:00.000Z" }, { role: "ai", content: "朝からえらいですね。", timestamp: "2026-10-25T10:31:10.000Z" }] },
  { id: "conv-old", persona: "companion", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T11:00:00.000Z", memoryObjectIds: [],
    turns: [{ role: "user", content: "映画を観た", timestamp: "2026-10-01T10:01:00.000Z" }] },
] as unknown as Conversation[];

interface Case { name: string; persona: Persona; turns: string[]; promptedMemoryId?: string }
const CASES: Case[] = [
  { name: "person", persona: "companion", turns: ["拓也のことなんだけど、また誘ってもいいと思う？"] },
  { name: "person omitted (continued)", persona: "companion", turns: ["拓也のことで悩んでる", "あいつ、最近どう思ってるのかな"] },
  { name: "continuity + topic timeline", persona: "companion", turns: ["昨日の話なんだけど、車の修理って結局どうなった？"] },
  { name: "explicit search", persona: "companion", turns: ["英語について何話した？"] },
  { name: "analytics", persona: "companion", turns: ["今までよく出てきたキーワードTOP10は？"] },
  { name: "reflective change over time", persona: "companion", turns: ["引っ越してから、自分の気持ちはどう変わってきたと思う？"] },
  { name: "analyst with an origin memory", persona: "analyst", turns: ["拓也と英語の話、何かつながりある？"], promptedMemoryId: "sync-mem-19" },
  { name: "no memory", persona: "companion", turns: ["こんにちは"] },
];
function turnsOf(c: Case): ConversationTurn[] {
  return c.turns.flatMap((content, i) => {
    const t = new Date(NOW - (c.turns.length - i) * 60_000).toISOString();
    const user = { role: "user" as const, content, timestamp: t };
    return i < c.turns.length - 1 ? [user, { role: "ai" as const, content: "そうなんですね。", timestamp: t }] : [user];
  });
}

interface Flags { memoryGraph: boolean; memoryTimeline: boolean; memorySynthesis: boolean; diagnostics: boolean; contextDedupe: boolean }
const FLAG_SETS: Flags[] = [];
for (let i = 0; i < 32; i += 1) FLAG_SETS.push({ memoryGraph: !!(i & 1), memoryTimeline: !!(i & 2), memorySynthesis: !!(i & 4), diagnostics: !!(i & 8), contextDedupe: !!(i & 16) });
const label = (f: Flags) => Object.entries(f).map(([k, v]) => `${k}=${v ? 1 : 0}`).join(" ");

/** the device: reads and flag checks, each call logged in order (the same functions for before and after) */
function device(flags: Flags, log: string[]) {
  const memories = pool;
  return {
    retrieveRelevantMemories: (text: string, options: RetrieveOptions) => { log.push(`retrieve:${JSON.stringify({ ...options, onReflectionTrace: typeof options.onReflectionTrace })}`); return r.retrieveRelevantMemoriesImpl(text, options); },
    loadConfirmedAliasLists: async () => { log.push("aliases"); return [["拓也", "たくや"]]; },
    getAllConversations: async () => { log.push("conversations"); return CONVERSATIONS; },
    getAllMemoryObjects: async () => { log.push("memories"); return memories; },
    withVaultWorldRead: async <T,>(fn: () => Promise<T>) => { log.push("lock"); return fn(); },
    synthesisContextForTurn: async (ms: MemoryObject[], turn: { userText: string; retrievedMemoryIds: string[] }) => {
      log.push(`synthesis:${ms.length}:${turn.retrievedMemoryIds.join(",")}`);
      // a fictional cached hypothesis on the selected themes (the real one reads the device cache; nothing is generated here)
      return { contexts: safeSelectTimelineForTurn(ms, turn), shownIds: ["hyp-fictional-1"] };
    },
    recordSynthesisShown: (ids: string[], conversationId: string) => { log.push(`shown:${ids.join(",")}:${conversationId}`); },
    memoryGraphEnabled: () => { log.push("flag:graph"); return flags.memoryGraph; },
    memoryTimelineEnabled: () => { log.push("flag:timeline"); return flags.memoryTimeline; },
    memorySynthesisEnabled: () => { log.push("flag:synthesis"); return flags.memorySynthesis; },
    generationDebugLogEnabled: () => { log.push("flag:debug"); return flags.diagnostics; },
  };
}

// ---- BEFORE: the code of ChatScreen.tsx at main f55e738, lines 5027–5179 (copied as is; only the indentation is shorter)
async function legacyAssemble(env: { text: string; baseConversation: { id: string; promptedMemoryId?: string }; updated: { turns: ConversationTurn[] }; activePersona: Persona } & ReturnType<typeof device>) {
  const { text, baseConversation, updated, activePersona, retrieveRelevantMemories, loadConfirmedAliasLists, getAllConversations, getAllMemoryObjects, withVaultWorldRead, synthesisContextForTurn, recordSynthesisShown, memoryGraphEnabled, memoryTimelineEnabled, memorySynthesisEnabled, generationDebugLogEnabled } = env;
  // Retrieval Engine（ローカルのみ・AIを呼ばない）。毎ターン実行し、
  // 使うかどうかの判断は/api/chat側のAIに委ねる（0件ならそのまま0件で渡す）。
  // 明示的Reflection（ROADMAP.md Phase 2）：ローカル判定のみでlimitとLink経由上限を広げる。
  // 判定がfalseの場合は既定のまま、Phase 1からの挙動を完全に維持する。
  const reflective = isReflectiveQuery(text);
  // Conversation Retrieval（analyst専用、Conversation品質改善 第2修正）が使う、
  // 直近の同一Conversation内user turns本文。turns全文を検索クエリへ連結するのではなく、
  // retrieval.ts側でkeyword単位の存在判定だけに使う（deriveConversationTopicAnchors参照）。
  // companion/coachはこのフィールドを読まないため、常に渡しても挙動に影響しない。
  const recentUserTurnsTexts = updated.turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content.trim())
    .filter(Boolean);
  // Memory Graph P1-B（試験フラグONのときだけ）：本人が確定した同じ人物の名前の組（端末内。読めなければ空＝従来どおり）
  const personAliases = memoryGraphEnabled() ? await loadConfirmedAliasLists() : [];
  // P1-F：診断（?debugLog=1）のときだけ、RetrievalがReflectionをどう扱ったかを受け取る（結果は変わらない）
  let reflectionTrace: ReflectionTrace | null = null;
  const retrievedMemories = await retrieveRelevantMemories(text, {
    excludeConversationId: baseConversation.id,
    limit: reflective ? REFLECTIVE_LIMIT : undefined,
    maxLinkedAdditions: reflective ? REFLECTIVE_MAX_LINKED_ADDITIONS : undefined,
    persona: activePersona,
    promptedMemoryId: baseConversation.promptedMemoryId,
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
    ...(generationDebugLogEnabled() ? { onReflectionTrace: (trace: ReflectionTrace) => { reflectionTrace = trace; } } : {}),
  });

  // Recent Conversation Context（Current Conversation → Recent Conversation → Memory Retrieval
  // の中間層。Recent Conversation Continuity v1）。数時間以内に終了した直前Conversationの
  // 末尾6 turnだけを、現在turnsとは別枠として/api/chatへ渡す（recentConversation.ts参照）。
  // Vault境界の安全性（H4対応）：getAllConversations()はロックを取らないprimitiveのため、
  // withVaultWorldReadで包む（retrieveRelevantMemories()の内部ロックとは別個の順次取得で
  // あり、同一ロックのネストにはならない。vaultWorldLock.ts参照）。取得失敗は
  // StaleVaultTabErrorのみ上位へ再送出し、それ以外は会話送信をブロックせずnullで続行する。
  let recentConversation: RecentConversationPayload | null = null;
  try {
    const allConversations = await withVaultWorldRead(() => getAllConversations());
    recentConversation = buildRecentConversationPayload(allConversations, baseConversation.id, Date.now());
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
    const allMemoriesForTopicContinuity = await withVaultWorldRead(() => getAllMemoryObjects());
    if (generationDebugLogEnabled()) memoriesForProvenance = allMemoriesForTopicContinuity;
    try {
      memoryAnalyticsContext = buildMemoryAnalyticsContext(allMemoriesForTopicContinuity, text, { excludeConversationId: baseConversation.id });
    } catch (analyticsError) {
      console.error("Failed to run memory analytics", analyticsError);
    }
    try {
      if (memoryAnalyticsContext === null) {
        explicitSearchContext = buildExplicitSearchContext(allMemoriesForTopicContinuity, text, { excludeConversationId: baseConversation.id });
      }
    } catch (searchError) {
      console.error("Failed to run explicit memory search", searchError);
    }
    topicContext = buildTopicContinuityPayload(allMemoriesForTopicContinuity, text);
    try {
      const recentUserTexts = updated.turns.filter((turn) => turn.role === "user").slice(-3).map((turn) => turn.content).reverse();
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
    if (memoryGraphEnabled()) {
      // 失敗しても空配列（personContext.ts）。この人物のPersonViewは背景に含まれるので二重に送らない
      personGraphContext = selectPersonContextsForTurn(allMemoriesForTopicContinuity, { userText: text, earlierUserTurns: recentUserTurnsTexts.slice(0, -1), excludeConversationId: baseConversation.id, alreadyGivenIds: retrievedMemories.map((memory) => memory.id), aliases: personAliases });
      personViewContext = withoutCoveredPersonViews(personViewContext, personGraphContext);
    }
    if (memorySynthesisEnabled()) {
      // Memory Synthesis S1（試験・既定OFF）：経緯に、そのテーマのTsumugiの仮説（端末内キャッシュ）を添える。AI呼び出しは無い。失敗時は経緯だけ（synthesisChat.ts）。
      const synthesisTurn = await synthesisContextForTurn(
        allMemoriesForTopicContinuity.filter((memory) => memory.conversationId !== baseConversation.id),
        { userText: text, retrievedMemoryIds: retrievedMemories.map((memory) => memory.id) }
      );
      memoryTimelineContext = synthesisTurn.contexts;
      recordSynthesisShown(synthesisTurn.shownIds, baseConversation.id);
    } else if (memoryTimelineEnabled()) {
      // 失敗しても空配列（会話は通常のRetrievalだけで続く）。今の会話自身のMemoryは、Retrievalと同じく使わない。
      memoryTimelineContext = safeSelectTimelineForTurn(
        allMemoriesForTopicContinuity.filter((memory) => memory.conversationId !== baseConversation.id),
        { userText: text, retrievedMemoryIds: retrievedMemories.map((memory) => memory.id) }
      );
    }
  } catch (topicError) {
    if (topicError instanceof StaleVaultTabError) throw topicError;
    console.error("Failed to load topic continuity context", topicError);
  }
  return { recentUserTurnsTexts, retrievedMemories, recentConversation, topicContext, profileContext, personViewContext, topicTimelineContext, explicitSearchContext, memoryAnalyticsContext, memoryTimelineContext, personGraphContext, reflectionTrace: reflectionTrace as ReflectionTrace | null, memoriesForProvenance };
}
type Legacy = Awaited<ReturnType<typeof legacyAssemble>>;
/** BEFORE: the past-context part of the /api/chat body at main f55e738 (copied as is) */
function legacyFields(v: Legacy, generationId: string | undefined, contextDedupeOn: boolean): Record<string, unknown> {
  const { retrievedMemories, recentConversation, topicContext, profileContext, personViewContext, topicTimelineContext, explicitSearchContext, memoryAnalyticsContext, memoryTimelineContext, personGraphContext } = v;
  return {
          retrievedMemories,
          ...(recentConversation ? { recentConversation } : {}),
          ...(topicContext ? { topicContext } : {}),
          ...(profileContext ? { profile: profileContext } : {}),
          ...(personViewContext ? { personView: personViewContext } : {}),
          ...(topicTimelineContext ? { topicTimeline: topicTimelineContext } : {}),
          ...(explicitSearchContext ? { explicitSearch: explicitSearchContext } : {}),
          ...(memoryAnalyticsContext ? { memoryAnalytics: memoryAnalyticsContext } : {}),
          ...(memoryTimelineContext.length > 0 ? { memoryTimeline: memoryTimelineContext } : {}),
          ...(personGraphContext.length > 0 ? { personContext: personGraphContext } : {}),
          ...(generationId ? { debugGenerationId: generationId } : {}),
          ...(contextDedupeOn ? { contextDedupe: true } : {}),
  };
}

async function prompt(body: string): Promise<{ systemInstruction: string; turns: unknown; text: string }> {
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
  const text = await res.text();
  return { systemInstruction: rec.systemInstruction, turns: rec.turns, text };
}
const bodyOf = (persona: Persona, turns: ConversationTurn[], fields: Record<string, unknown>) => JSON.stringify({ persona, turns: turnsForAi(turns), ...fields });
const ROUTES = ["retrievedMemories", "recentConversation", "topicContext", "profile", "personView", "topicTimeline", "explicitSearch", "memoryAnalytics", "memoryTimeline", "personContext"] as const;

test("before / after: the same state, time and flags give the same context, request body, final prompt, reads and flag checks (8 cases × 32 flag sets)", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const covered = new Map<string, number>(ROUTES.map((k) => [k, 0]));
  let runs = 0;
  try {
    pool = world();
    for (const c of CASES) {
      const turns = turnsOf(c);
      const text = c.turns[c.turns.length - 1];
      for (const flags of FLAG_SETS) {
        const where = `${c.name} / ${label(flags)}`;
        const generationId = flags.diagnostics ? "gen-fixed" : undefined;
        const beforeLog: string[] = [];
        const before = await legacyAssemble({ text, baseConversation: { id: "conv-now", promptedMemoryId: c.promptedMemoryId }, updated: { turns }, activePersona: c.persona, ...device(flags, beforeLog) });
        const afterLog: string[] = [];
        const d = device(flags, afterLog);
        const after = await asm.assembleChatContext(
          { text, turns, conversationId: "conv-now", promptedMemoryId: c.promptedMemoryId, persona: c.persona, now: () => Date.now() },
          {
            retrieve: d.retrieveRelevantMemories,
            loadConfirmedAliasLists: d.loadConfirmedAliasLists,
            loadConversations: () => d.withVaultWorldRead(() => d.getAllConversations()),
            loadMemories: () => d.withVaultWorldRead(() => d.getAllMemoryObjects()),
            synthesisContextForTurn: d.synthesisContextForTurn,
            recordSynthesisShown: d.recordSynthesisShown,
          },
          { memoryGraph: d.memoryGraphEnabled, memoryTimeline: d.memoryTimelineEnabled, memorySynthesis: d.memorySynthesisEnabled, diagnostics: d.generationDebugLogEnabled }
        );
        // the same reads and flag checks, in the same order and number (the device's lists are read under the lock, as before)
        assert.deepEqual(afterLog, beforeLog, `reads and flag checks: ${where}`);
        assert.deepEqual(after, before, `assembled values: ${where}`);
        const beforeBody = bodyOf(c.persona, turns, legacyFields(before, generationId, flags.contextDedupe));
        const afterBody = bodyOf(c.persona, turns, asm.chatContextRequestFields(after, { generationId, contextDedupe: flags.contextDedupe }));
        assert.equal(afterBody, beforeBody, `request body: ${where}`);
        rec.calls = 0;
        const p1 = await prompt(beforeBody);
        const p2 = await prompt(afterBody);
        assert.equal(rec.calls, 2, "one AI call per request, as before");
        assert.equal(p2.systemInstruction, p1.systemInstruction, `final prompt: ${where}`);
        assert.deepEqual(p2.turns, p1.turns, `turns sent to the AI: ${where}`);
        assert.equal(p2.text, p1.text, `reply stream (with the debug envelope when on): ${where}`);
        assert.ok(p1.systemInstruction.includes("2026年10月25日"), "the server's date line reads the fixed time");
        const fields = JSON.parse(afterBody) as Record<string, unknown>;
        for (const k of ROUTES) if (k in fields && !(Array.isArray(fields[k]) && (fields[k] as unknown[]).length === 0)) covered.set(k, (covered.get(k) ?? 0) + 1);
        runs += 1;
      }
    }
  } finally {
    mock.timers.reset();
  }
  console.log(`CI-REPORT chat-context-assembly: ${runs} runs identical before/after; routes present (runs): ${[...covered].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  assert.equal(runs, CASES.length * FLAG_SETS.length);
  // the comparison exercised the routes (a route that never appears would compare nothing)
  for (const k of ["retrievedMemories", "recentConversation", "memoryAnalytics", "explicitSearch"] as const) assert.ok((covered.get(k) ?? 0) > 0, `route ${k} appeared`);
});

test("the flags keep their dependencies: Synthesis ON reads no Timeline flag; Graph OFF reads no aliases and sends no person context; OFF sends no new field", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    pool = world();
    const c = CASES[0];
    const run = async (flags: Flags) => {
      const log: string[] = [];
      const d = device(flags, log);
      const ctx = await asm.assembleChatContext(
        { text: c.turns[0], turns: turnsOf(c), conversationId: "conv-now", persona: c.persona, now: () => Date.now() },
        { retrieve: d.retrieveRelevantMemories, loadConfirmedAliasLists: d.loadConfirmedAliasLists, loadConversations: d.getAllConversations, loadMemories: d.getAllMemoryObjects, synthesisContextForTurn: d.synthesisContextForTurn, recordSynthesisShown: d.recordSynthesisShown },
        { memoryGraph: d.memoryGraphEnabled, memoryTimeline: d.memoryTimelineEnabled, memorySynthesis: d.memorySynthesisEnabled, diagnostics: d.generationDebugLogEnabled }
      );
      return { ctx, log };
    };
    const off = await run({ memoryGraph: false, memoryTimeline: false, memorySynthesis: false, diagnostics: false, contextDedupe: false });
    assert.ok(!off.log.includes("aliases") && off.log.includes("flag:timeline"));
    assert.deepEqual(off.ctx.personGraphContext, []);
    assert.deepEqual(off.ctx.memoryTimelineContext, []);
    assert.deepEqual(off.ctx.memoriesForProvenance, [], "no memory list is kept without the debug");
    const fields = asm.chatContextRequestFields(off.ctx, { contextDedupe: false });
    for (const k of ["memoryTimeline", "personContext", "debugGenerationId", "contextDedupe"]) assert.ok(!(k in fields), k);
    const syn = await run({ memoryGraph: true, memoryTimeline: true, memorySynthesis: true, diagnostics: false, contextDedupe: false });
    assert.ok(!syn.log.includes("flag:timeline"), "Synthesis ON: the Timeline flag is not read");
    assert.ok(syn.log.includes("aliases") && syn.log.some((l) => l.startsWith("shown:")));
    assert.equal(syn.log.filter((l) => l === "flag:graph").length, 2, "the Graph flag is read where it was (aliases, person context)");
    assert.equal(asm.chatContextRequestFields(syn.ctx, { generationId: "g", contextDedupe: true }).contextDedupe, true);
  } finally {
    mock.timers.reset();
  }
});

test("a failed read keeps the message going as before; a stale tab stops it", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    pool = world();
    const c = CASES[0];
    const flags = { memoryGraph: true, memoryTimeline: true, memorySynthesis: false, diagnostics: true, contextDedupe: false };
    const base = device(flags, []);
    const sources = { retrieve: base.retrieveRelevantMemories, loadConfirmedAliasLists: base.loadConfirmedAliasLists, loadConversations: base.getAllConversations, loadMemories: base.getAllMemoryObjects, synthesisContextForTurn: base.synthesisContextForTurn, recordSynthesisShown: base.recordSynthesisShown };
    const f = { memoryGraph: base.memoryGraphEnabled, memoryTimeline: base.memoryTimelineEnabled, memorySynthesis: base.memorySynthesisEnabled, diagnostics: base.generationDebugLogEnabled };
    const input = { text: c.turns[0], turns: turnsOf(c), conversationId: "conv-now", persona: c.persona, now: () => Date.now() };
    const quiet = mock.method(console, "error", () => {});
    try {
      const broken = await asm.assembleChatContext(input, { ...sources, loadConversations: async () => { throw new Error("read failed"); }, loadMemories: async () => { throw new Error("read failed"); } }, f);
      assert.equal(broken.recentConversation, null);
      assert.equal(broken.topicContext, null);
      assert.ok(broken.retrievedMemories.length > 0, "the Retrieval result is still sent");
    } finally {
      quiet.mock.restore();
    }
    await assert.rejects(asm.assembleChatContext(input, { ...sources, loadMemories: async () => { throw new StaleVaultTabError("stale"); } }, f), StaleVaultTabError);
    await assert.rejects(asm.assembleChatContext(input, { ...sources, loadConversations: async () => { throw new StaleVaultTabError("stale"); } }, f), StaleVaultTabError);
  } finally {
    mock.timers.reset();
  }
});

test("the chat screen uses the assembly with the device's reads and flags; nothing else calls it; no new setting or button", () => {
  const screen = fs.readFileSync(path.join(ROOT, "../src/components/ChatScreen.tsx"), "utf8");
  assert.equal(screen.split("await assembleChatContext(").length - 1, 1);
  assert.ok(screen.includes("deviceChatContextSources,\n        deviceChatContextFlags"));
  assert.ok(screen.includes("now: Date.now }"), "the screen passes the real clock");
  assert.equal(screen.split("...chatContextRequestFields(assembled, { generationId, contextDedupe: contextDedupeOn }),").length - 1, 1);
  for (const gone of ["retrieveRelevantMemories(", "buildRecentConversationPayload(", "selectPersonContextsForTurn(", "safeSelectTimelineForTurn(", "synthesisContextForTurn(", "memoryGraphEnabled()", "memoryTimelineEnabled()", "memorySynthesisEnabled()"]) {
    assert.ok(!screen.includes(gone), `the screen no longer does it itself: ${gone}`);
  }
  const device = fs.readFileSync(path.join(ROOT, "../src/lib/chatContextSources.ts"), "utf8");
  for (const wire of ["retrieve: (text, options) => retrieveRelevantMemories(text, options)", "loadConversations: () => withVaultWorldRead(() => getAllConversations())", "loadMemories: () => withVaultWorldRead(() => getAllMemoryObjects())", "memoryGraph: () => memoryGraphEnabled()", "memoryTimeline: () => memoryTimelineEnabled()", "memorySynthesis: () => memorySynthesisEnabled()", "diagnostics: () => debugLogEnabled()"]) {
    assert.ok(device.includes(wire), wire);
  }
  const code = (f: string) => fs.readFileSync(path.join(ROOT, "../src/lib", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(code("chatContextAssembly.ts"), /fetch\(|localStorage|indexedDB|window\.|from "\.\/db"|generate(Stream|Content)/, "the assembly reads nothing itself and calls no AI");
  for (const f of ["connect.ts", "capture.ts", "reflection.ts"]) assert.ok(!code(f).includes("assembleChatContext"), f);
});
