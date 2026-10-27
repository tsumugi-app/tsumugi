"use client";
/**
 * Memory Synthesis S1: the two places the chat screen touches Synthesis (both only while `?memorySynthesis=1` is on, both failure-isolated):
 *   - synthesisContextForTurn: the Memory Timeline selection of this turn, with the usable hypotheses of the selected themes attached
 *     (code only, no AI call; a failure falls back to the plain timeline)
 *   - runSynthesisAfterSession: after a session / conversation ended, a background generation run (at most once a day; never awaited by the UI)
 * Memories and Conversations are only READ here (getAllMemoryObjects / getAllConversations under the Vault read lock).
 */
import { getAllConversations, getAllMemoryObjects, loadApiKey } from "./db";
import { withVaultWorldRead } from "./vaultWorldLock";
import { GEMINI_API_KEY_HEADER } from "./apiKeyHeader";
import { memorySynthesisEnabled } from "./memorySynthesisFlag";
import { safeSelectTimelineForTurn, selectSynthesisForTurn, type SynthesisThemeContext } from "./memorySynthesis";
import { usableItemsForChat } from "./synthesisModel";
import { runSynthesisOnce } from "./synthesisRunner";
import { synthesisStore } from "./synthesisStore";
import type { MemoryObject } from "./types";

export async function synthesisContextForTurn(
  memories: MemoryObject[],
  turn: { userText: string; retrievedMemoryIds: string[] }
): Promise<{ contexts: SynthesisThemeContext[]; shownIds: string[] }> {
  try {
    const state = await synthesisStore.load();
    const { items, hypothesisIdByItem } = usableItemsForChat(state, memories, Date.now());
    const contexts = selectSynthesisForTurn(items, turn, memories);
    const shownIds = contexts.flatMap((c) => c.items.map((i) => hypothesisIdByItem.get(i)).filter((id): id is string => Boolean(id)));
    return { contexts, shownIds };
  } catch (error) {
    console.error("[Tsumugi] memory synthesis skipped for this turn", error);
    return { contexts: safeSelectTimelineForTurn(memories, turn), shownIds: [] };
  }
}

export function recordSynthesisShown(hypothesisIds: string[], conversationId: string): void {
  if (hypothesisIds.length === 0) return;
  void synthesisStore.markShown(hypothesisIds, conversationId, new Date().toISOString()).catch((error) => console.error("[Tsumugi] memory synthesis: could not record use", error));
}

let running: Promise<unknown> | null = null;

/** fire and forget: never throws, never blocks the UI, one run at a time in this tab (the 24h attempt record covers other tabs) */
export function runSynthesisAfterSession(): void {
  if (running || !memorySynthesisEnabled()) return;
  running = runSynthesisOnce({
    store: synthesisStore,
    readMemories: () => withVaultWorldRead(() => getAllMemoryObjects()),
    readConversations: () => withVaultWorldRead(() => getAllConversations()),
    callApi: async (payload) => {
      const apiKey = await loadApiKey();
      const res = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { [GEMINI_API_KEY_HEADER]: apiKey } : {}) },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`synthesize request failed with status ${res.status}`);
      return (await res.json()) as { items?: unknown; reactions?: unknown };
    },
    now: () => Date.now(),
    newId: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  })
    .catch((error) => console.error("[Tsumugi] memory synthesis run skipped", error))
    .finally(() => {
      running = null;
    });
}
