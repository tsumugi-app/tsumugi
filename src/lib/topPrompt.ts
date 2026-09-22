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
 * Time Safety：表示する日によって意味が変わる相対時間表現（「昨日」等）を含むpromptは、
 * 生成後の保存前検証で保存せず、既存の保存済みpromptも候補から除外する（削除・書き換え・
 * 「未生成」扱いでの再生成はしない）。詳細はrevisitPromptSafety.ts参照。
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
import { getJstTodayDateString } from "./jstDate";
import { jstDateOf } from "./dateModel";
import {
  findRelativeTimeExpression,
  isSafeRevisitPromptText,
  selectRevisitCandidate,
  validateGeneratedRevisitPrompt,
} from "./revisitPromptSafety";
import { withVaultWorldRead } from "./vaultWorldLock";
import type { MemoryObject, Persona } from "./types";

export interface TopPrompt {
  memory: MemoryObject;
  question: string;
  /** 元Memoryが属していたConversationのpersona。取得できない場合はcompanion。 */
  persona: Persona;
}

/**
 * Logical Date（JST）で「今日」を判定する（Phase 1修正：以前はUTCベースの
 * `dateISO.slice(0, 10)`と比較していたため、JST 0:00〜8:59に記録されたMemoryが
 * 「今日ではない」と誤判定され、当日生成回避（tier1/tier4）の対象から漏れていた）。
 * `jstDateOf`がparse不能でnullを返した場合はfail-soft（「今日ではない」扱い）にする。
 */
function isToday(dateISO: string): boolean {
  const today = getJstTodayDateString();
  return jstDateOf(dateISO) === today;
}

function pickRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * 候補Memoryを段階的に緩めながら選ぶ（tierの詳細・Time Safetyによる除外は
 * `selectRevisitCandidate`、revisitPromptSafety.ts参照）。Betaでは「問いかけが
 * ときどき出てくる」体験を「厳密に重複を避ける」ことより優先するため、候補が尽きる
 * たびに条件を緩め、最後まで候補が無いときだけ諦める。
 */
async function selectCandidateMemory() {
  const [all, lastPromptedIds] = await Promise.all([getAllMemoryObjects(), loadLastPromptedMemoryIds()]);
  return selectRevisitCandidate(all, lastPromptedIds, isToday, pickRandom);
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
 *
 * 記録日（date）と出来事日時（eventTime／eventTimePrecision）は別の情報としてAPIへ渡す。
 * Event Timeが無い場合、記録日から出来事日時を推測させない（route.ts側の指示）。
 * LLMへの指示だけに依存せず、生成結果は保存前に必ずvalidateGeneratedRevisitPromptで検証する。
 * 相対時間表現を含む場合はundefinedを返す（呼び出し元は保存しない）。同一試行内での
 * 再生成（API再呼び出し）はしない。
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
      date: memory.date,
      eventTime: memory.eventTime,
      eventTimePrecision: memory.eventTimePrecision,
    }),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { question?: string };
  const validated = validateGeneratedRevisitPrompt(data.question);
  if (!validated && data.question?.trim()) {
    const term = findRelativeTimeExpression(data.question);
    console.warn(`[Tsumugi] revisit prompt discarded (relative time expression: ${term ?? "unknown"}); not saved.`);
  }
  return validated;
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
/**
 * Vault境界の安全性（H4対応）：共有ロック＋epoch確認で包んだ公開版。実処理は
 * `generateTopPromptImpl`（ロックを取得しない内部専用版）。
 */
export async function generateTopPrompt(): Promise<TopPrompt | undefined> {
  return withVaultWorldRead(() => generateTopPromptImpl());
}

async function generateTopPromptImpl(): Promise<TopPrompt | undefined> {
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
    // Time Safety：表示・Conversation送信に使う文字列を確定する直前の最終確認
    // （selectRevisitCandidate・生成後検証を通っているはずだが、保険として必ず確認する）。
    if (!isSafeRevisitPromptText(memory.revisitPrompt)) return undefined;

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
