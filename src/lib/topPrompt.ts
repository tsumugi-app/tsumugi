/**
 * Beta「過去からの問いかけ」機能のオーケストレーション。
 *
 * 問いかけ文はトップ画面を開くたびには生成しない。
 * - 新しいMemoryがCapture直後に生成された場合：ChatScreen.tsxのenqueueCaptureが
 *   `generateRevisitPrompt`を一度だけ呼び、結果をMemoryObject.revisitPromptとして保存する。
 * - 既存Memory（revisitPromptを持たないまま残っているもの）については、トップ画面表示時に
 *   revisitPrompt持ちの候補が見つからなかった場合に限り、ここ（selectCandidateMemory）が
 *   1件だけ選んでその場で生成・保存する（既存Memory全件への一括生成はしない）。
 * どちらの経路でも、一度revisitPromptが付いたMemoryは再生成しない。
 *
 * retrieveRelevantMemories（retrieval.ts）はユーザー発言というクエリを前提にしており
 * ここでは使えないため、getAllMemoryObjectsを直接使う別ロジックとして実装する。
 */
"use client";

import {
  getAllMemoryObjects,
  getConversation,
  loadApiKey,
  loadLastPromptedMemoryIds,
  putMemoryObject,
  saveLastPromptedMemoryIds,
} from "./db";
import { GEMINI_API_KEY_HEADER } from "./apiKeyHeader";
import type { MemoryObject, Persona } from "./types";

export interface TopPrompt {
  memory: MemoryObject;
  question: string;
  /** 元Memoryが属していたConversationのpersona。取得できない場合はcompanion。 */
  persona: Persona;
}

interface CandidateSelection {
  memory: MemoryObject;
  /** trueの場合、このMemoryはまだrevisitPromptを持たない。呼び出し元が1回だけ生成する。 */
  needsGeneration: boolean;
}

function isToday(dateISO: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return dateISO.slice(0, 10) === today;
}

function pickRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * 候補Memoryを段階的に緩めながら選ぶ。Betaでは「問いかけがときどき出てくる」体験を
 * 「厳密に重複を避ける」ことより優先するため、候補が尽きるたびに条件を緩め、
 * 最後まで候補が無いときだけ諦める。
 *
 * 1. revisitPrompt持ち・直近5件未表示・当日生成でない（最も厳しい・理想形）
 * 2. revisitPrompt持ち・直前1件だけは避ける・当日生成も許容（「直近5件」を緩める）
 * 3. revisitPrompt持ちなら何でもよい（直前1件しか無い等、他に選びようが無い場合の最終手段。
 *    これが無いと「候補1件→表示→除外→次回0件→消える」という状態になってしまう）
 * 4. revisitPrompt無し・当日生成でない Memoryを1件選び、これから生成する
 * 5. revisitPrompt無し Memoryを1件選び、これから生成する（最後の手段）
 * 各tierは前のtierの候補が0件のときだけ試す、単調に緩めるだけのはしごにする
 * （tierを跨いで戻ることはない）。
 */
async function selectCandidateMemory(): Promise<CandidateSelection | undefined> {
  const [all, lastPromptedIds] = await Promise.all([getAllMemoryObjects(), loadLastPromptedMemoryIds()]);
  const excludedRecent = new Set(lastPromptedIds);
  const mostRecentId = lastPromptedIds[lastPromptedIds.length - 1];

  const withPrompt = all.filter((memory) => !!memory.revisitPrompt);
  const withoutPrompt = all.filter((memory) => !memory.revisitPrompt);

  const tier1 = withPrompt.filter((memory) => !excludedRecent.has(memory.id) && !isToday(memory.date));
  if (tier1.length > 0) return { memory: pickRandom(tier1)!, needsGeneration: false };

  const tier2 = withPrompt.filter((memory) => memory.id !== mostRecentId);
  if (tier2.length > 0) return { memory: pickRandom(tier2)!, needsGeneration: false };

  // tier3：withPromptが1件しか無く、それが直前に表示したものと同じ場合でも、
  // 「消えてしまう」よりは同じ問いかけを再度出す方を優先する。
  if (withPrompt.length > 0) return { memory: pickRandom(withPrompt)!, needsGeneration: false };

  const tier4 = withoutPrompt.filter((memory) => !isToday(memory.date));
  if (tier4.length > 0) return { memory: pickRandom(tier4)!, needsGeneration: true };

  if (withoutPrompt.length > 0) return { memory: pickRandom(withoutPrompt)!, needsGeneration: true };

  return undefined;
}

/**
 * 元Memoryが属していたConversationのpersonaを引き継ぐ（優先）。
 * conversationIdが無い・該当Conversationが見つからない場合はcompanionにfallbackする。
 */
async function resolveOriginalPersona(memory: MemoryObject): Promise<Persona> {
  if (!memory.conversationId) return "companion";
  const sourceConversation = await getConversation(memory.conversationId);
  return sourceConversation?.persona ?? "companion";
}

/**
 * Memory 1件だけを材料に、再訪用の問いかけ文を生成する（/api/prompt）。
 * 呼び出し元（enqueueCapture、またはgenerateTopPromptのフォールバック経路）が
 * Memoryごとに一度だけ呼ぶことを前提とする。
 */
export async function generateRevisitPrompt(memory: MemoryObject): Promise<string | undefined> {
  const apiKey = await loadApiKey();
  const res = await fetch("/api/prompt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { [GEMINI_API_KEY_HEADER]: apiKey } : {}),
    },
    body: JSON.stringify({
      summary: memory.summary,
      content: memory.content,
      keywords: memory.keywords,
    }),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { question?: string };
  return data.question?.trim() || undefined;
}

/**
 * トップ画面を開くたびに問いかけを表示するかどうかの確率（45%）。
 * selectCandidateMemory()の候補選定ロジックはMemoryが1件でもあれば必ず何かを
 * 返す設計のため、これが無いとほぼ毎回表示されてしまう。表示するかどうかの
 * 判定だけをここで行い、Memory選定・重複回避（lastPromptedMemoryIds）・
 * AI生成のロジック自体には一切手を加えない。
 */
const TOP_PROMPT_SHOW_PROBABILITY = 0.45;

/**
 * トップ画面用の「過去からの問いかけ」を1件用意する。
 * revisitPrompt持ちの候補があればAIを呼ばずそのまま使う。無ければ、既存Memoryから
 * 1件だけを選んでこの場で一度だけ生成・保存する（既存Memory全件への一括生成はしない）。
 * 候補が完全に無い場合、またはAI生成に失敗した場合はundefinedを返し、呼び出し元は
 * 問いかけブロックを一切表示せず、従来のトップ画面のままにする。
 * 45%の確率でのみ生成を試みる（55%は候補選定・AI生成を一切呼ばずに即座にundefinedを返す）。
 */
export async function generateTopPrompt(): Promise<TopPrompt | undefined> {
  if (Math.random() > TOP_PROMPT_SHOW_PROBABILITY) return undefined;
  try {
    const selection = await selectCandidateMemory();
    if (!selection) return undefined;

    let memory = selection.memory;
    if (selection.needsGeneration) {
      const revisitPrompt = await generateRevisitPrompt(memory);
      if (!revisitPrompt) return undefined;
      memory = { ...memory, revisitPrompt };
      await putMemoryObject(memory);
    }
    if (!memory.revisitPrompt) return undefined;

    const persona = await resolveOriginalPersona(memory);

    // 実際にユーザーへ表示することが確定した時点でのみ「表示済み」として記録する。
    const lastPromptedIds = await loadLastPromptedMemoryIds();
    await saveLastPromptedMemoryIds([...lastPromptedIds, memory.id]);

    return { memory, question: memory.revisitPrompt, persona };
  } catch (error) {
    console.error("Failed to generate top prompt", error);
    return undefined;
  }
}
