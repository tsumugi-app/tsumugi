/**
 * Memory Graph P0: reads this device's saved Memories for the person sheet page. READ ONLY, the same way as androidDiagnostics.ts:
 *   `indexedDB.open("tsumugi")` without a version (an existing database is opened as it is; a missing one is not created: the upgrade is aborted),
 *   one `readonly` transaction, `getAll("memoryObjects")`, then the connection is closed.
 * It does not import db.ts / vault.ts (they may upgrade the database or set up the Vault), writes nothing and sends nothing.
 * Records whose shape is unexpected are skipped (counted), never repaired.
 */
import { PERSON_RELATIONS, type Link, type MemoryObject, type PersonMention, type TopicEvent } from "./types";

export interface PersonSheetReadResult {
  memories: MemoryObject[];
  /** records skipped because their shape was unexpected */
  skipped: number;
  /** items inside kept records (mentions, links, quotes, ...) left out because their shape was unexpected */
  droppedItems: number;
  /** the database does not exist on this device */
  missing: boolean;
}

const isStr = (x: unknown): x is string => typeof x === "string";
const RELATIONS = new Set<string>(PERSON_RELATIONS);

/**
 * keeps a record only when the fields the sheet reads have the expected shape; array fields that are absent become empty arrays.
 * Inside a kept record, an item of a list with an unexpected shape (a person mention whose quote is not text, a link without an axis, ...) is left out
 * and counted, so that a single malformed item never stops the page (Codex on PR #32).
 */
export function normalizeSheetMemories(raw: unknown[]): { memories: MemoryObject[]; skipped: number; droppedItems: number } {
  const memories: MemoryObject[] = [];
  let skipped = 0;
  let droppedItems = 0;
  const keep = <T,>(list: unknown, ok: (x: T) => boolean): T[] => {
    const arr = Array.isArray(list) ? (list as T[]) : [];
    const kept = arr.filter((x) => x !== null && typeof x === "object" && ok(x));
    droppedItems += arr.length - kept.length;
    return kept;
  };
  for (const r of raw) {
    const m = r as Partial<MemoryObject> | null;
    if (!m || typeof m !== "object" || !isStr(m.id) || !isStr(m.summary) || !isStr(m.date)) { skipped++; continue; }
    const strings = (list: unknown) => {
      const arr = Array.isArray(list) ? list : [];
      const kept = arr.filter(isStr);
      droppedItems += arr.length - kept.length;
      return kept;
    };
    memories.push({
      ...(m as MemoryObject),
      content: isStr(m.content) ? m.content : "",
      statedAt: isStr(m.statedAt) ? m.statedAt : undefined,
      eventTime: isStr(m.eventTime) ? m.eventTime : undefined,
      topicId: isStr(m.topicId) ? m.topicId : undefined,
      conversationId: isStr(m.conversationId) ? m.conversationId : undefined,
      keywords: strings(m.keywords),
      evidenceQuotes: strings(m.evidenceQuotes),
      types: strings(m.types) as MemoryObject["types"],
      links: keep<Link>(m.links, (l) => isStr(l.id) && isStr(l.sourceId) && isStr(l.targetId) && isStr(l.axis) && isStr(l.reason) && typeof l.strength === "number"),
      personMentions: keep<PersonMention>(m.personMentions, (p) =>
        (isStr(p.displayName) || isStr(p.groupingKey)) && isStr(p.quote) && (p.statedAt === undefined || isStr(p.statedAt))
        && (p.relation === undefined || RELATIONS.has(p.relation)) && (p.assertion === "mention" || p.assertion === "correction")),
      topicEvents: keep<TopicEvent>(m.topicEvents, (e) => isStr(e.quote) && isStr(e.topicId) && isStr(e.statedAt)),
    });
  }
  return { memories, skipped, droppedItems };
}

export async function readMemoriesForPersonSheet(idb: IDBFactory = indexedDB): Promise<PersonSheetReadResult> {
  if (typeof idb.databases === "function") {
    const list = await idb.databases();
    if (!list.some((d) => d.name === "tsumugi")) return { memories: [], skipped: 0, droppedItems: 0, missing: true };
  }
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = idb.open("tsumugi"); // no version: the existing database as it is
    request.onupgradeneeded = (event) => {
      try {
        (event.target as IDBOpenDBRequest).transaction?.abort(); // the database did not exist: do not create it
      } catch {
        // no-op
      }
      resolve(null);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
  if (!db) return { memories: [], skipped: 0, droppedItems: 0, missing: true };
  try {
    if (!db.objectStoreNames.contains("memoryObjects")) return { memories: [], skipped: 0, droppedItems: 0, missing: false };
    const raw = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction("memoryObjects", "readonly").objectStore("memoryObjects").getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    return { ...normalizeSheetMemories(raw), missing: false };
  } finally {
    db.close();
  }
}
