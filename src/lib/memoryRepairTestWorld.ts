/** Test-only synthetic world rebuilt from the FICTIONAL spec (shared by the repair and pre-flight tests). */
/* eslint-disable @typescript-eslint/no-require-imports */
import path from "node:path";
type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
const fictional = require(path.join(__dirname, "memoryRepairFictionalData.js")) as typeof import("./memoryRepairFictionalData");
/** The fictional spec every public test runs against (real repair content is private data and never appears in code). */
export const D = fictional.FICTIONAL_DATA;

export const T0 = "2026-08-20T00:00:00.000Z";
export const NOW = "2026-10-10T00:00:00.000Z";
export const meta = (id: string, updatedAt: string) => ({ id, source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T0, updatedAt });

export function conv(id: string, userTexts: string[], updatedAt: string, memoryObjectIds: string[] = []): Conversation {
  return { id, persona: "companion", status: "captured", startedAt: "2026-08-21T03:00:00.000Z", createdAt: T0, updatedAt,
    turns: userTexts.flatMap((t, i) => [{ role: "user" as const, content: t, timestamp: `2026-08-21T03:0${i}:00.000Z` }, { role: "ai" as const, content: "AIの応答: 不安や孤独を感じていますか", timestamp: `2026-08-21T03:0${i}:30.000Z` }]),
    memoryObjectIds, metadata: meta(`m-${id}`, updatedAt) } as Conversation;
}
export function mem(id: string, conversationId: string, summary: string, content: string, updatedAt: string, extra: Partial<MemoryObject> = {}): MemoryObject {
  return { id, date: T0, types: ["conversation"], conversationId, content, summary, keywords: ["x"], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T0, updatedAt, metadata: meta(`m-${id}`, updatedAt), ...extra } as MemoryObject;
}
export const joinKeywords = (k: string[]) => k.join("　");

/** Synthetic world rebuilt from the fixed spec: original conv, updating conv, corrupted Memory (+ a bystander). */
export function world(): { memories: MemoryObject[]; conversations: Conversation[] } {
  const memories: MemoryObject[] = []; const conversations: Conversation[] = [];
  const seenUpdating = new Set<string>();
  for (const item of D.repair.items) {
    conversations.push(conv(item.originalConversationId, [...item.restored.evidence, joinKeywords(item.restored.keywords)], "2026-08-20T01:00:00.000Z", [item.memoryId]));
    const u = D.repair.updating[item.updatingConversationId];
    if (!seenUpdating.has(item.updatingConversationId)) {
      conversations.push(conv(item.updatingConversationId, [...u.evidence, joinKeywords(u.keywords)], item.expectedBefore.updatedAt));
      seenUpdating.add(item.updatingConversationId);
    }
    const structured: Partial<MemoryObject> = {};
    if (item.key === "R6" || item.key === "R7") structured.topicId = `topic-${item.key}`;
    if (item.key === "R6") { structured.eventTime = "2027-03"; structured.eventTimePrecision = "month"; }
    if (item.key === "R7") structured.personMentions = [
      { displayName: "ヤマダさん", quote: "ヤマダさんと久しぶりに電話で話した。", sourceConversationId: item.updatingConversationId, assertion: "mention" } as never,
      { displayName: "ヤマダさん", quote: "O側の言及", sourceConversationId: item.originalConversationId, assertion: "mention" } as never];
    memories.push(mem(item.memoryId, item.originalConversationId, item.expectedBefore.summary, item.expectedBefore.content, item.expectedBefore.updatedAt, { ...structured, revisitPrompt: "古い問いかけ" }));
  }
  // Links are stored on both ends. A link id shared by two spec'd Memories joins them; every other id gets a counterpart Memory
  // (the first one is a Reflection, as in the real data where counterparts can be system-generated).
  const holders = new Map<string, MemoryObject[]>();
  for (const m of memories) for (const id of Object.keys(D.repair.items.find((i) => i.memoryId === m.id)!.links)) holders.set(id, [...(holders.get(id) ?? []), m]);
  let first = true;
  for (const [id, ms] of holders) {
    const [a, b] = ms.length === 2 ? ms : [ms[0], undefined];
    let other = b;
    if (!other) { other = mem(`CP-${id}`, `CP-CONV-${id}`, "リンク先の別の話題の要約", "リンク先の内容", "2026-08-20T02:00:00.000Z", first ? { metadata: { ...meta(`cp-${id}`, "2026-08-20T02:00:00.000Z"), source: "system-generated" } } : {}); first = false; memories.push(other); }
    const link = { id, sourceId: a.id, targetId: other.id, axis: "theme", reason: "リンク理由", contrast: false, strength: 0.8, createdBy: "ai-inference", createdAt: "2026-08-20T03:00:00.000Z" } as never;
    a.links = [...a.links, link]; if (other !== a) other.links = [...other.links, link];
  }
  conversations.push(conv("BYSTANDER-CONV", ["無関係な発言"], "2026-08-20T05:00:00.000Z", ["BYSTANDER-MEM"]));
  memories.push(mem("BYSTANDER-MEM", "BYSTANDER-CONV", "全く別の話題の要約です", "全く別の話題の内容です", "2026-08-20T05:00:00.000Z"));
  return { memories, conversations };
}


