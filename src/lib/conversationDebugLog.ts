/**
 * TEMP-TEST：PC/スマホ間で応答傾向が異なって見える件の原因切り分け用（調査専用）。
 *
 * 目的は「修正」ではなく「1リクエストごとに、Geminiへ渡る直前の材料を同じ形式で
 * 突き合わせられるようにすること」。会話ロジック・Retrievalロジック・system prompt・
 * persona promptは一切変更しない。ここは既存の関数（retrieveRelevantMemories・
 * scoreMemory・needsWebSearch・getAllMemoryObjects）を読み取り専用で呼び直して
 * ログへ整形するだけの、副作用の無い診断レイヤーである。
 *
 * 既存のdebugTimingLog.tsと同じ`?debugLog=1`ゲートを使う。このクエリパラメータが
 * 無い通常のユーザーには、この関数は何もしない（コンソール出力・追加のIndexedDB読み取り・
 * localStorageへの書き込みのいずれも発生しない）。
 *
 * スマホ実機ではConsoleを開きにくいため、console.logに加えて同じ内容をlocalStorageへも
 * 保存し、`?debugLog=1`のときだけ表示されるConversationDebugPanel（画面上のパネル、
 * コピーボタン付き）から目視・コピーできるようにする（DebugTimingPanel/debugTimingLog.tsと
 * 同じ設計）。保存する内容は、下のプライバシー方針に従いconsole.logと完全に同じもの
 * （このモジュール内で1箇所だけ組み立てている文字列をそのまま使う）。
 *
 * プライバシー方針（厳守）：
 * - APIキー・system prompt本文・persona prompt本文は一切出力しない
 * - Memory本文（MemoryObject.content）は出力しない。出すのはid・summary・keywords・
 *   スコア・取得理由（direct/linked）・linkReasonの短い文字列だけ
 * - 会話本文（turns[].content）はそのまま出力せず、件数と直近ユーザー発言の文字数だけを出す
 *
 * 注意（意図的な近似値であり、実際のサーバー側計算のミラーではない）：
 * - thinkingBudget・maxOutputTokensは、src/app/api/chat/route.tsの
 *   computeThinkingBudget()・maxOutputTokens定数と同じ値をここに複製して表示している
 *   だけであり、実際にサーバー側で使われた値をレスポンスから受け取っているわけではない
 *   （route.ts側は変更しないため、値を返送する仕組み自体を今回追加していない）。
 *   route.ts側の定数を変更した場合、この表示値は追随しないため、調査結果を見る際は
 *   その前提を踏まえること。
 * - スコアは、retrieval.tsの`scoreMemory()`（companion/coach用の直接一致スコアリング）を
 *   このログのためだけに再計算したものである。persona===analystのRetrievedMemoryは
 *   retrieveCreativeMemories()という別ロジック（直接一致＋あえて遠いMemoryの2部構成）で
 *   選ばれているため、ここで表示するスコアは「参考値」であり、実際の選定順位を
 *   保証するものではない（analystの「あえて遠いMemory」はスコアが低く出て当然）。
 */
"use client";

import { getAllMemoryObjects } from "./db";
import { scoreMemory } from "./retrieval";
import { needsWebSearch } from "./needsWebSearch";
import type { ConversationTurn, MemoryObject, Persona, RetrievedMemory } from "./types";
import type { VaultBackend } from "./vault";

/** ChatScreen.tsxのVaultStatus型を、lib→component方向の依存を避けるためここに複製した
 * 表示用の型（値は完全に同じ）。libがcomponentをimportする構造は作らない方針のため。 */
type VaultStatusForDebug = "checking" | "connected" | "not-connected" | "unsupported" | "needs-permission";

function debugLogEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("debugLog") === "1";
  } catch {
    return false;
  }
}

const STORAGE_KEY = "tsumugi:conversationDebugLog:v1";
/** 1件あたりRetrieved Memoryの分だけ長くなりうるため、timingLogより少なめの上限にする。 */
const MAX_ENTRIES = 20;

interface StoredEntry {
  ts: number;
  text: string;
}

function readEntries(): StoredEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : [];
  } catch {
    return [];
  }
}

function appendEntry(text: string): void {
  try {
    const entries = readEntries();
    entries.push({ ts: Date.now(), text });
    while (entries.length > MAX_ENTRIES) entries.shift();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // パネル表示用の保存に失敗しても、console.log側は既に出力済みのため実害は無い。
  }
}

/** ConversationDebugPanel（画面上のパネル）が読む。`?debugLog=1`が無い通常URLでは
 * パネル自体が描画されないため、この関数もそこからしか呼ばれない想定。 */
export function getConversationDebugLog(): { ts: number; text: string }[] {
  if (typeof window === "undefined") return [];
  return readEntries();
}

export function clearConversationDebugLog(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}

/** route.ts の computeThinkingBudget() と同じ式をここに複製しているだけの表示用ミラー。
 * 実際にサーバーが使った値の取得ではない（上のファイル冒頭コメント参照）。 */
function mirrorThinkingBudget(latestUserMessage: string): number {
  const length = latestUserMessage.length;
  if (length < 120) return 128;
  if (length < 400) return 384;
  return 768;
}

/** route.ts の maxOutputTokens: 4096 をそのまま複製した表示用の定数。 */
const MIRROR_MAX_OUTPUT_TOKENS = 4096;

/** ざっくりとしたモバイル判定（UA文字列ベース。表示用の参考情報であり、
 * アプリの挙動分岐には使わない＝vault.tsのgetVaultBackend()等とは無関係）。 */
function roughDeviceLabel(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent || "";
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  return isMobile ? "mobile" : "desktop";
}

export interface ConversationDebugParams {
  persona: Persona;
  turns: ConversationTurn[];
  retrievedMemories: RetrievedMemory[];
  latestUserMessage: string;
  vaultBackend: VaultBackend | null;
  vaultStatus: VaultStatusForDebug;
}

/**
 * 1リクエスト分の「Geminiへ渡る直前の材料」をまとめてconsoleへ出す。
 * `?debugLog=1`が無い場合は即return（追加のIndexedDB読み取りも発生しない）。
 * 失敗してもhandleSend()本体には一切影響させない（呼び出し元でvoidして使うこと）。
 */
export async function logConversationDebug(params: ConversationDebugParams): Promise<void> {
  if (!debugLogEnabled()) return;

  try {
    const { persona, turns, retrievedMemories, latestUserMessage, vaultBackend, vaultStatus } = params;

    // memoryCount・スコア再計算のためだけの読み取り専用アクセス（既存のgetAllMemoryObjects()を
    // 呼び直すだけで、retrieveRelevantMemories()自体の呼び出し回数・挙動は変えない）。
    const allMemories = await getAllMemoryObjects();
    const byId = new Map<string, MemoryObject>(allMemories.map((memory) => [memory.id, memory]));
    const trimmed = latestUserMessage.trim();

    const retrieved = retrievedMemories.map((memory) => {
      const full = byId.get(memory.id);
      const score = full ? Number(scoreMemory(full, trimmed).toFixed(2)) : null;
      return {
        id: memory.id,
        score,
        summary: memory.summary,
        source: memory.linkReason ? "linked" : "direct",
        isOriginMemory: memory.isOriginMemory === true,
        linkReason: memory.linkReason ?? null,
      };
    });

    const directCount = retrieved.filter((r) => r.source === "direct").length;
    const linkedCount = retrieved.filter((r) => r.source === "linked").length;

    const lines = [
      "[ConversationDebug]",
      `device/environment: ${roughDeviceLabel()} (userAgent="${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}")`,
      `vault: backend=${vaultBackend ?? "none"} status=${vaultStatus}`,
      `persona: ${persona}`,
      `latestUserMessageLength: ${trimmed.length}`,
      `historyCount(turns): ${turns.length}`,
      `memoryCount(total, this device's IndexedDB): ${allMemories.length}`,
      `retrievedCount: ${retrievedMemories.length} (direct=${directCount}, linked=${linkedCount})`,
      "retrieved:",
      ...retrieved.map(
        (r, i) =>
          `  [${i}] id=${r.id} score=${r.score ?? "n/a"} source=${r.source}${r.isOriginMemory ? " origin=true" : ""} summary="${r.summary}"${r.linkReason ? ` linkReason="${r.linkReason}"` : ""}`
      ),
      `finalContextSummary: retrievedMemoriesSectionPresent=${retrievedMemories.length > 0} charLenOfSummaries=${retrieved.reduce((sum, r) => sum + r.summary.length, 0)}`,
      `generationConfig(mirrored from route.ts constants, not the actual server-reported value): thinkingBudget=${mirrorThinkingBudget(trimmed)} maxOutputTokens=${MIRROR_MAX_OUTPUT_TOKENS} enableWebSearch=${needsWebSearch(trimmed)}`,
    ];

    const text = lines.join("\n");
    console.log(text);
    appendEntry(text);
  } catch (error) {
    // 調査用ログの失敗は本体の会話送信処理に一切影響させない。
    console.warn("[ConversationDebug] failed to build debug log", error);
  }
}
