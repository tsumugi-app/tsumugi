/**
 * Explicit Memory Search P0診断（観測専用の純粋関数。Conversation Debugger＝`?debugLog=1`専用）。
 *
 * 目的：「黄金湯について何話したっけ？」のようなExplicit Searchが実機で0件になったとき、その端末のIndexedDBに何があり、
 * Explicit Searchが何を検索し、何件candidate/selectedになったかを確認できるようにすること。
 *
 * 重要（検索挙動・Chat promptには一切影響しない）：
 * - 検索ロジックは変更しない。`detectExplicitMemorySearch`/`searchMemories`/`buildExplicitSearchContext`を**同じ引数で読み取り専用に再実行**するだけ
 *   （実際の選定結果と常に一致する）。
 * - Conversationの照合（user turn本文）は診断専用。検索結果にもChat回答にも渡さない（このモジュールの戻り値はdebug logにしか使わない）。
 * - 出力はid・件数・score・一致フィールド・timestamp・短い一致snippet（最大約40字）まで。会話本文やMemory本文の全文は含めない。
 */
import { normalizeKey } from "./profile";
import { buildExplicitSearchContext, detectExplicitMemorySearch, searchMemories } from "./memorySearch";
import type { Conversation, MemoryObject } from "./types";

const ID_LIST_MAX = 10;
const TURNS_PER_CONVERSATION_MAX = 3;
const SNIPPET_RADIUS = 15;

export interface ExplicitSearchTermFieldCounts {
  term: string;
  weak: boolean;
  /** IndexedDB全体（現在の会話の除外前）での、このtermを含むMemory件数。 */
  inAllMemories: { keywordExact: number; keywordContains: number; summary: number; content: number; evidence: number; personMentions: number };
  /** 現在の会話の除外後のpool内での件数。 */
  inPool: { keywordExact: number; keywordContains: number; summary: number; content: number; evidence: number; personMentions: number };
}

export interface ExplicitSearchSelectedDiagnostic {
  id: string;
  conversationId: string | null;
  source: string | null;
  types: string[];
  matchedFields: string[];
  matchedTerms: string[];
  score: number;
}

export interface ExplicitSearchConversationMatch {
  conversationId: string;
  startedAt: string;
  excludedAsCurrent: boolean;
  /** 一致したuser turn（最大3件）。timestampと、一致箇所まわりの短いsnippetだけ。 */
  turns: { timestamp: string; snippet: string }[];
  /** そのConversationから作られたMemoryがIndexedDBに何件あるか（Reflectionを除く／Reflectionの有無）。 */
  memoriesInIndexedDb: number;
  reflectionInIndexedDb: boolean;
}

export interface ExplicitSearchDiagnostics {
  intentDetected: true;
  terms: { text: string; weak: boolean }[];
  memory: {
    poolTotal: number;
    afterCurrentConversationExclusion: number;
    excludedByCurrentConversation: number;
    /** relative filter後・limit前の件数（searchMemoriesが返し得る全件）。 */
    candidateCount: number;
    selectedCount: number;
    selected: ExplicitSearchSelectedDiagnostic[];
    termFieldCounts: ExplicitSearchTermFieldCounts[];
    /** いずれかのtermをkeywordsに含む（部分一致を含む）Memoryのid（最大10件）と、現在の会話の除外に当たったか。 */
    keywordHitMemories: { id: string; conversationId: string | null; source: string | null; excludedAsCurrent: boolean }[];
  };
  conversation: {
    total: number;
    /** いずれかのtermをuser turn本文に含むConversation件数（診断専用。検索には使わない）。 */
    matchedCount: number;
    perTerm: { term: string; conversations: number }[];
    matches: ExplicitSearchConversationMatch[];
  };
  /** 切り分けの目安（A:どこにも無い／B:Conversationにはあるが記録側に無い／C:記録側に語はあるがselected 0／D:selectedあり→payload/server側を確認）。 */
  hint: string;
}

function snippetAround(content: string, termKeyRaw: string): string {
  const text = content.normalize("NFKC").replace(/\s+/g, " ");
  const at = text.toLowerCase().indexOf(termKeyRaw.normalize("NFKC").toLowerCase());
  if (at < 0) return "";
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + termKeyRaw.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function fieldCounts(memories: readonly MemoryObject[], termKey: string): ExplicitSearchTermFieldCounts["inPool"] {
  const counts = { keywordExact: 0, keywordContains: 0, summary: 0, content: 0, evidence: 0, personMentions: 0 };
  for (const memory of memories) {
    const keywordKeys = memory.keywords.map((k) => normalizeKey(k));
    if (keywordKeys.some((k) => k === termKey)) counts.keywordExact += 1;
    if (keywordKeys.some((k) => k.includes(termKey))) counts.keywordContains += 1;
    if (normalizeKey(memory.summary).includes(termKey)) counts.summary += 1;
    if (normalizeKey(memory.content).includes(termKey)) counts.content += 1;
    const evidence = [...(memory.evidenceQuotes ?? []), ...(memory.topicEvents ?? []).map((e) => e.quote)];
    if (evidence.some((q) => typeof q === "string" && normalizeKey(q).includes(termKey))) counts.evidence += 1;
    const persons = (memory.personMentions ?? []).flatMap((m) => [m.displayName, m.quote]);
    if (persons.some((p) => typeof p === "string" && normalizeKey(p).includes(termKey))) counts.personMentions += 1;
  }
  return counts;
}

/**
 * 発言がExplicit Searchでなければnull（通常会話では診断を作らない）。
 * memories/conversationsはIndexedDBの全件。excludeConversationIdは、実際の検索へ渡している値と同じもの。
 */
export function buildExplicitSearchDiagnostics(
  memories: readonly MemoryObject[],
  conversations: readonly Conversation[],
  userText: string,
  options: { excludeConversationId?: string } = {}
): ExplicitSearchDiagnostics | null {
  const intent = detectExplicitMemorySearch(userText);
  if (!intent) return null;

  const pool = memories.filter((m) => options.excludeConversationId === undefined || m.conversationId !== options.excludeConversationId);
  // 実際の検索と同じ呼び出し（selectedは本番と同じ上限）。candidateは同じ関数をlimitなしで呼んだ件数。
  const real = buildExplicitSearchContext(memories, userText, options);
  const full = searchMemories(memories, intent, { ...options, limit: Math.max(1, memories.length) });
  const hitById = new Map(full.hits.map((hit) => [hit.memory.id, hit]));
  const memoryById = new Map(memories.map((m) => [m.id, m]));
  const selected: ExplicitSearchSelectedDiagnostic[] = (real?.results ?? []).map((result) => {
    const hit = hitById.get(result.id);
    const memory = memoryById.get(result.id);
    return {
      id: result.id,
      conversationId: memory?.conversationId ?? null,
      source: memory?.metadata?.source ?? null,
      types: (memory?.types ?? []) as string[],
      matchedFields: hit?.matchedFields ?? [],
      matchedTerms: hit?.matchedTerms ?? [],
      score: Number((hit?.score ?? 0).toFixed(2)),
    };
  });

  const termKeys = intent.terms.map((term) => ({ term, key: normalizeKey(term.text) }));
  const termFieldCounts: ExplicitSearchTermFieldCounts[] = termKeys.map(({ term, key }) => ({
    term: term.text,
    weak: term.weak,
    inAllMemories: fieldCounts(memories, key),
    inPool: fieldCounts(pool, key),
  }));
  const keywordHitMemories = memories
    .filter((m) => m.keywords.some((k) => termKeys.some(({ key }) => key && normalizeKey(k).includes(key))))
    .slice(0, ID_LIST_MAX)
    .map((m) => ({
      id: m.id,
      conversationId: m.conversationId ?? null,
      source: m.metadata?.source ?? null,
      excludedAsCurrent: options.excludeConversationId !== undefined && m.conversationId === options.excludeConversationId,
    }));

  // Conversation（診断専用）。user turn本文だけを見る（AI turnは見ない）。
  const perTerm = termKeys.map(({ term }) => ({ term: term.text, conversations: 0 }));
  const matches: ExplicitSearchConversationMatch[] = [];
  let matchedCount = 0;
  for (const conversation of conversations) {
    const turnHits: { timestamp: string; snippet: string }[] = [];
    let any = false;
    termKeys.forEach(({ term, key }, i) => {
      if (!key) return;
      let hitThisTerm = false;
      for (const turn of conversation.turns ?? []) {
        if (turn.role !== "user" || typeof turn.content !== "string") continue;
        if (!normalizeKey(turn.content).includes(key)) continue;
        hitThisTerm = true;
        if (turnHits.length < TURNS_PER_CONVERSATION_MAX) turnHits.push({ timestamp: turn.timestamp, snippet: snippetAround(turn.content, term.text) });
      }
      if (hitThisTerm) {
        perTerm[i].conversations += 1;
        any = true;
      }
    });
    if (!any) continue;
    matchedCount += 1;
    if (matches.length < ID_LIST_MAX) {
      const own = memories.filter((m) => m.conversationId === conversation.id);
      matches.push({
        conversationId: conversation.id,
        startedAt: conversation.startedAt,
        excludedAsCurrent: options.excludeConversationId !== undefined && conversation.id === options.excludeConversationId,
        turns: turnHits,
        memoriesInIndexedDb: own.filter((m) => m.metadata?.source !== "system-generated").length,
        reflectionInIndexedDb: own.some((m) => m.metadata?.source === "system-generated"),
      });
    }
  }

  const memoryFieldHit = termFieldCounts.some((c) => Object.values(c.inAllMemories).some((n) => n > 0));
  let hint: string;
  if (selected.length > 0) hint = "D?: Explicit Searchはselected>0。payload/server側（Chat contextのexplicitSearch section）を確認";
  else if (memoryFieldHit) hint = "C: IndexedDBのMemoryに語はあるがselected 0（現在の会話の除外・weak語・relative filterを確認）";
  else if (matchedCount > 0) hint = "B: IndexedDBのConversationにはあるが、Memory側に語が無い";
  else hint = "A: IndexedDBのConversationにもMemoryにも語が無い（HistoryはVault読みのため、IndexedDBに未取り込みの可能性）";

  return {
    intentDetected: true,
    terms: intent.terms.map((term) => ({ text: term.text, weak: term.weak })),
    memory: {
      poolTotal: memories.length,
      afterCurrentConversationExclusion: pool.length,
      excludedByCurrentConversation: memories.length - pool.length,
      candidateCount: full.hits.length,
      selectedCount: selected.length,
      selected,
      termFieldCounts,
      keywordHitMemories,
    },
    conversation: { total: conversations.length, matchedCount, perTerm, matches },
    hint,
  };
}

/** Conversation Debuggerのテキスト行へ整形する（debug log専用）。 */
export function formatExplicitSearchDiagnostics(d: ExplicitSearchDiagnostics | null): string[] {
  if (d === null) return ["explicitSearch: intent=false (通常会話。診断なし)"];
  const f = (c: ExplicitSearchTermFieldCounts["inPool"]) => `keywordExact=${c.keywordExact} keywordContains=${c.keywordContains} summary=${c.summary} content=${c.content} evidence=${c.evidence} personMentions=${c.personMentions}`;
  return [
    "explicitSearch: intent=true",
    `  terms: ${d.terms.map((t) => `${t.text}${t.weak ? "(weak)" : ""}`).join(", ")}`,
    `  memory.poolTotal(IndexedDB memoryObjects): ${d.memory.poolTotal} afterCurrentConversationExclusion=${d.memory.afterCurrentConversationExclusion} excluded=${d.memory.excludedByCurrentConversation}`,
    `  memory.candidateCount: ${d.memory.candidateCount} selectedCount: ${d.memory.selectedCount}`,
    ...d.memory.selected.map((s, i) => `  selected[${i}] id=${s.id} conversationId=${s.conversationId ?? "-"} source=${s.source ?? "-"} types=${s.types.join("/") || "-"} matched=${s.matchedFields.join("/") || "-"} terms=${s.matchedTerms.join("/") || "-"} score=${s.score}`),
    ...d.memory.termFieldCounts.flatMap((c) => [`  memoryTermCounts[${c.term}] all: ${f(c.inAllMemories)}`, `  memoryTermCounts[${c.term}] pool: ${f(c.inPool)}`]),
    `  keywordHitMemories: ${d.memory.keywordHitMemories.length === 0 ? "(none)" : d.memory.keywordHitMemories.map((m) => `${m.id}(conv=${m.conversationId ?? "-"} source=${m.source ?? "-"}${m.excludedAsCurrent ? " EXCLUDED-as-current" : ""})`).join(", ")}`,
    `  conversation.total(IndexedDB conversations): ${d.conversation.total} matchedByUserTurn=${d.conversation.matchedCount} (診断専用・検索結果/Chatには使わない)`,
    ...d.conversation.perTerm.map((p) => `  conversationTermCounts[${p.term}]: ${p.conversations}`),
    ...d.conversation.matches.flatMap((m) => [
      `  conversationMatch id=${m.conversationId} startedAt=${m.startedAt}${m.excludedAsCurrent ? " EXCLUDED-as-current" : ""} memoriesInIndexedDb=${m.memoriesInIndexedDb} reflectionInIndexedDb=${m.reflectionInIndexedDb}`,
      ...m.turns.map((t) => `    userTurn ts=${t.timestamp} snippet="${t.snippet}"`),
    ]),
    `  hint: ${d.hint}`,
  ];
}
