/**
 * Conversation Debugger v1（開発専用、Conversation Quality改善用）。
 *
 * 目的：ある特定のAI返答について、「その返答を生成した瞬間に実際にLLMへ渡された
 * Personal Model context」を確認できるようにする。後から再計算した値ではなく、
 * クライアントが実際にfetch bodyへ入れた値（[Client Sent]）と、サーバーが
 * sanitize後に実際にsystemInstructionへ使った値（[Server Accepted]、
 * `X-Tsumugi-Debug`相当のresponse envelope経由で受け取る。generationDebugProtocol.ts
 * 参照）の両方を保存する。
 *
 * 既存の`conversationDebugLog.ts`（PC/スマホ差異調査用のTEMP-TEST）とは役割が異なる
 * 別モジュール——削除・統合しない。ただし設計パターン（`?debugLog=1`ゲート、
 * localStorage保存、Vault epoch安全性）はそのまま踏襲する。
 *
 * 含めないもの：system prompt本文（persona固定文・共有prompt・Evidence Boundary本文）、
 * API key、その他secret。含めるのはPersonal Model contextの動的部分だけ
 * （既にクライアント⇄サーバー間で実際にやり取りされている値であり、Debuggerが
 * 新たに露出させるものではない）。
 *
 * 保存先：localStorageのみ。Vault・IndexedDB・Conversation・MemoryObjectには
 * 一切書き込まない。generationId・turnTimestampはこのモジュール専用の一時識別子で、
 * ConversationTurnの永続スキーマへは追加しない。
 */
"use client";

import {
  getActiveVaultEpoch,
  getCommittedVaultEpoch,
  getTabVaultEpoch,
  getVaultWorldJournalVersion,
} from "./vaultWorldLock";
import type { GenerationDebugContext, GenerationDebugGeneration } from "./generationDebugProtocol";

export function debugLogEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("debugLog") === "1";
  } catch {
    return false;
  }
}

/** `crypto.randomUUID`が無い環境（古いWebView等）向けのfallback付き。Debug専用の一時識別子。 */
export function createGenerationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const STORAGE_KEY = "tsumugi:generationDebugLog:v1";
const MAX_ENTRIES = 20;

export interface StoredGenerationDebugEntry {
  ts: number;
  /** 書き込み時点のtabVaultEpoch（conversationDebugLog.tsと同じ安全性パターン）。 */
  epoch: number;
  generationId: string;
  /** このデバッグ情報が対応するAIターンの`ConversationTurn.timestamp`（表示紐付け専用、
   *  ConversationTurn自体には一切書き込まない）。 */
  turnTimestamp: string;
  clientSent: GenerationDebugContext;
  serverAccepted: GenerationDebugContext;
  generation: GenerationDebugGeneration;
}

function readEntries(): StoredGenerationDebugEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredGenerationDebugEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * `?debugLog=1`時のみ呼ばれる想定。生成直後に、そのAIターンの生成に実際に使われた
 * [Client Sent]／[Server Accepted]／[Generation]を1件保存する。失敗しても会話送信
 * 本体には一切影響させない（呼び出し元でvoidして使うこと）。
 */
export function appendGenerationDebugEntry(entry: {
  generationId: string;
  turnTimestamp: string;
  clientSent: GenerationDebugContext;
  serverAccepted: GenerationDebugContext;
  generation: GenerationDebugGeneration;
}): void {
  if (!debugLogEnabled()) return;
  try {
    const epoch = getTabVaultEpoch();
    if (epoch === null) return;
    const entries = readEntries();
    entries.push({ ts: Date.now(), epoch, ...entry });
    while (entries.length > MAX_ENTRIES) entries.shift();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn("[GenerationDebug] failed to store debug entry", error);
  }
}

/**
 * `GenerationDebugBadge`が読む。別Vaultへ切り替わった後に古いエントリが誤って
 * 見えないよう、`conversationDebugLog.ts`の`getConversationDebugLog()`と同じ
 * epoch検証チェーンをそのまま踏襲する。
 */
export async function getGenerationDebugLog(): Promise<StoredGenerationDebugEntry[]> {
  if (typeof window === "undefined") return [];
  try {
    const tabEpoch = getTabVaultEpoch();
    const activeEpoch = await getActiveVaultEpoch();
    if (tabEpoch === null || tabEpoch !== activeEpoch) return [];
    const versionStatus = await getVaultWorldJournalVersion();
    if (versionStatus.status !== "current") return [];
    const committedStatus = await getCommittedVaultEpoch();
    if (committedStatus.status !== "valid" || committedStatus.epoch !== activeEpoch) return [];
    return readEntries().filter((entry) => entry.epoch === activeEpoch);
  } catch (error) {
    console.warn("[GenerationDebug] failed to verify epoch for debug log read, refusing to return entries", error);
    return [];
  }
}

export function clearGenerationDebugLog(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}
