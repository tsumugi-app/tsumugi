/** Opt-in Capture observations only. No disk persistence, no raw errors/headers/keys.
 * Kept for the last 5 captures in this tab; reload discards them. */
import type { Conversation, MemoryObject } from "./types";
import { getTabVaultEpoch, withVaultWorldRead } from "./vaultWorldLock";

export interface CaptureDebugAttempt {
  candidates: unknown[];
  validation: Array<{ index: number; verdict: string; reason?: string; quotes?: unknown[]; rawEvidenceUserMessageIndexes?: unknown; validatedEvidenceUserMessageIndexes?: number[]; indexValidationResult?: unknown; resolvedOriginalEvidenceQuotes?: string[] }>;
  retryReason?: unknown;
  failure?: string;
}
export interface CaptureDebugServer {
  userMessages?: readonly string[];
  attempts: CaptureDebugAttempt[];
  selectedAttempt: number;
  finalized: unknown[];
}
interface CaptureDebugEntry {
  captureId: string;
  epoch: number;
  at: string;
  conversationId: string;
  turnCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  userMessages: string[];
  server?: CaptureDebugServer;
  phase: string;
  memories: Array<{ finalizedIndex: number; proposedIndex?: number; memoryId: string; conversationId?: string; summary: string; content: string; evidenceQuotes?: string[]; indexedDB: string; vault: string }>;
}
const entries: CaptureDebugEntry[] = [];
const captures = new WeakMap<Conversation, string>();
export function captureDebugEnabled(): boolean {
  try { return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debugLog") === "1"; }
  catch { return false; }
}
/** All observation writes are best effort and cannot fail the Capture. */
export function observeCapture(id: string | undefined, fn: (entry: CaptureDebugEntry) => void): void {
  if (!id) return;
  try {
    const entry = entries.find(e => e.captureId === id);
    if (entry && entry.epoch === getTabVaultEpoch()) fn(entry);
  } catch { /* Observation failure does not affect the product. */ }
}
export function beginCaptureDebug(conversation: Conversation): string | undefined {
  if (!captureDebugEnabled()) return;
  try {
    const epoch = getTabVaultEpoch();
    if (epoch === null) return;
    const captureId = crypto.randomUUID();
    entries.push({ captureId, epoch, at: new Date().toISOString(), conversationId: conversation.id,
      turnCount: conversation.turns.length,
      userMessageCount: conversation.turns.filter(t => t.role === "user").length,
      assistantMessageCount: conversation.turns.filter(t => t.role !== "user").length,
      userMessages: conversation.turns.filter(t => t.role === "user").map(t => t.content),
      phase: "preparing", memories: [] });
    while (entries.length > 5) entries.shift();
    return captureId;
  } catch { return; }
}
export function bindCaptureDebug(id: string | undefined, conversation: Conversation, memories: MemoryObject[]): void {
  if (!id) return;
  observeCapture(id, entry => {
    captures.set(conversation, id);
    entry.phase = "finalized; awaiting persistence";
    const validation = entry.server?.attempts[(entry.server?.selectedAttempt ?? 1) - 1]?.validation;
    const retained = validation?.filter(v => v.verdict !== "dropped");
    entry.memories = memories.map((m, index) => ({ finalizedIndex: index, proposedIndex: retained?.[index]?.index, memoryId: m.id, conversationId: m.conversationId,
      summary: m.summary, content: m.content, evidenceQuotes: m.evidenceQuotes?.slice(), indexedDB: "not-attempted", vault: "not-attempted" }));
  });
}
export function captureDebugId(conversation: Conversation): string | undefined { return captures.get(conversation); }
export function observeCaptureSave(id: string | undefined, memoryId: string, store: "indexedDB" | "vault", status: string): void {
  observeCapture(id, entry => {
    const m = entry.memories.find(m => m.memoryId === memoryId);
    if (m) m[store] = status;
  });
}
export function clearCaptureDebug(): void { entries.length = 0; }
export async function getCaptureDebugText(): Promise<string> {
  if (!captureDebugEnabled()) return "";
  try {
    return await withVaultWorldRead(async () => entries.filter(e => e.epoch === getTabVaultEpoch()).map(entry => {
      const selected = entry.server?.attempts[entry.server.selectedAttempt - 1];
      const validation = selected?.validation ?? [];
      return "[D] Capture Debug\n" + JSON.stringify({ ...entry, totals: {
        proposed: selected?.candidates.length ?? null,
        accepted: validation.filter(v => v.verdict === "accepted").length,
        dropped: validation.filter(v => v.verdict === "dropped").length,
        saved: entry.memories.filter(m => m.indexedDB === "success").length,
      } }, null, 2);
    }).join("\n\n"));
  } catch { return ""; } // stale/incomplete world must not expose old-world content
}
