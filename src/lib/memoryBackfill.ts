/**
 * Memory Backfill for the READY conversations (no Memory yet): FIXED content, add-only, independent of the
 * contamination repair (own spec, own ledger prefix `memoryBackfill:v1:`, own runner entry). Pure planning only;
 * execution goes through memoryRepairRunner.ts. REVIEW / SKIP conversations are intentionally NOT in this spec.
 * Per conversation the id is deterministic, the ledger is add-if-absent, and the Memory is added together with its
 * Outbox entry and the Conversation.memoryObjectIds link in ONE IndexedDB transaction.
 */
import type { Conversation, MemoryObject } from "./types";
import { DUPLICATE_SIMILARITY_THRESHOLD, deterministicMemoryId, statedAtFor, textSimilarity, verifyTextGrounding, type RepairSnapshot, type RepairText } from "./memoryContaminationRepair";

export interface BackfillSpecItem {
  key: string;
  conversationId: string;
  /** Identity guard: the first user turn of the reviewed conversation. */
  expectedFirstUserTurn: string;
  memory: RepairText & { eventTime?: { value: string; precision: "day" | "month" | "year" } };
}
export type PlannedBackfill =
  | { status: "READY"; key: string; conversationId: string; newMemory: MemoryObject; conversation: { before: Conversation; after: Conversation }; ledgerKey: string }
  | { status: "ALREADY_DONE"; key: string }
  | { status: "HOLD"; key: string; reasons: string[] };

export const backfillLedgerKey = (conversationId: string) => `memoryBackfill:v1:${conversationId}`;
export const backfillBackupKey = (conversationId: string) => `memoryBackfill:v1:backup:${conversationId}`;
export const backfillMemoryIdFor = (conversationId: string) => deterministicMemoryId(`backfill:${conversationId}`);

const day = (iso: string) => `${iso.slice(0, 10)}T00:00:00.000Z`;

export async function planBackfillItem(item: BackfillSpecItem, snapshot: RepairSnapshot, now: string): Promise<PlannedBackfill> {
  const hold = (...reasons: string[]): PlannedBackfill => ({ status: "HOLD", key: item.key, reasons });
  const conversation = snapshot.conversations.find((c) => c.id === item.conversationId);
  if (!conversation) return hold("conversation-missing");
  const id = await backfillMemoryIdFor(item.conversationId);
  const existing = snapshot.memories.find((m) => m.id === id);
  if (existing && existing.content === item.memory.content && conversation.memoryObjectIds.includes(id)) return { status: "ALREADY_DONE", key: item.key };
  const reasons: string[] = [];
  const firstUser = conversation.turns.find((t) => t.role === "user")?.content;
  if (firstUser !== item.expectedFirstUserTurn) reasons.push("conversation-not-the-reviewed-one");
  // A Reflection (system-generated summary of the conversation) is not a normal Memory: it neither blocks nor is replaced.
  const isNormal = (m: MemoryObject) => m.metadata.source !== "system-generated";
  const byId = new Map(snapshot.memories.map((m) => [m.id, m]));
  const referencedNormal = conversation.memoryObjectIds.filter((ref) => ref !== id && (!byId.has(ref) || isNormal(byId.get(ref)!)));
  if (referencedNormal.length > 0) reasons.push(`conversation-already-references-memory:${referencedNormal.join(",")}`);
  const own = snapshot.memories.filter((m) => m.conversationId === item.conversationId && m.id !== id && isNormal(m));
  if (own.length > 0) reasons.push(`conversation-already-has-memory:${own.map((m) => m.id).join(",")}`);
  if (existing) reasons.push("deterministic-id-exists-with-different-content");
  for (const p of verifyTextGrounding(item.memory, conversation)) reasons.push(`${p.code}:${p.detail}`);
  for (const other of snapshot.memories) {
    if (other.id !== id && textSimilarity(other.summary, item.memory.summary) >= DUPLICATE_SIMILARITY_THRESHOLD) reasons.push(`similar-to-existing:${other.id}`);
  }
  if (reasons.length > 0) return hold(...reasons);
  const stated = statedAtFor(item.memory, conversation);
  const newMemory: MemoryObject = {
    id, date: day(conversation.startedAt), types: item.memory.types, conversationId: conversation.id, content: item.memory.content, summary: item.memory.summary, keywords: item.memory.keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: item.memory.evidence, createdAt: now, updatedAt: now,
    metadata: { id: await deterministicMemoryId(`backfill-meta:${conversation.id}`), schemaVersion: "0.1", source: "ai-capture", sourceType: "chat", confidence: 1, createdAt: now, updatedAt: now, sourceDetail: { memoryBackfill: "v1" } },
  };
  if (stated) newMemory.statedAt = stated;
  if (item.memory.eventTime) { newMemory.eventTime = item.memory.eventTime.value; newMemory.eventTimePrecision = item.memory.eventTime.precision; }
  return { status: "READY", key: item.key, conversationId: conversation.id, newMemory, conversation: { before: conversation, after: { ...conversation, memoryObjectIds: [...conversation.memoryObjectIds.filter((ref) => ref !== id), id], updatedAt: now } }, ledgerKey: backfillLedgerKey(conversation.id) };
}
