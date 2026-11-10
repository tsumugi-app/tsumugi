/**
 * Memory Graph P0: reads this device's saved Memories for the person sheet page. READ ONLY, the same way as androidDiagnostics.ts:
 *   `indexedDB.open("tsumugi")` without a version (an existing database is opened as it is; a missing one is not created: the upgrade is aborted),
 *   one `readonly` transaction, `getAll("memoryObjects")`, then the connection is closed.
 * It does not import db.ts / vault.ts (they may upgrade the database or set up the Vault), writes nothing and sends nothing.
 * Records whose shape is unexpected are skipped (counted), never repaired.
 */
import type { MemoryObject } from "./types";

export interface PersonSheetReadResult {
  memories: MemoryObject[];
  /** records skipped because their shape was unexpected */
  skipped: number;
  /** the database does not exist on this device */
  missing: boolean;
}

/** keeps a record only when the fields the sheet reads have the expected shape; array fields that are absent become empty arrays */
export function normalizeSheetMemories(raw: unknown[]): { memories: MemoryObject[]; skipped: number } {
  const memories: MemoryObject[] = [];
  let skipped = 0;
  for (const r of raw) {
    const m = r as Partial<MemoryObject> | null;
    if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.summary !== "string" || typeof m.date !== "string") { skipped++; continue; }
    const arr = <T,>(x: T[] | undefined) => (Array.isArray(x) ? x : []);
    memories.push({
      ...(m as MemoryObject),
      keywords: arr(m.keywords).filter((k): k is string => typeof k === "string"),
      links: arr(m.links).filter((l) => l && typeof l === "object" && typeof l.sourceId === "string" && typeof l.targetId === "string"),
      personMentions: arr(m.personMentions).filter((p) => p && typeof p === "object" && typeof (p.displayName ?? p.groupingKey) === "string"),
      topicEvents: arr(m.topicEvents).filter((e) => e && typeof e === "object" && typeof e.quote === "string" && typeof e.topicId === "string"),
      evidenceQuotes: arr(m.evidenceQuotes).filter((q): q is string => typeof q === "string"),
      types: arr(m.types),
    });
  }
  return { memories, skipped };
}

export async function readMemoriesForPersonSheet(idb: IDBFactory = indexedDB): Promise<PersonSheetReadResult> {
  if (typeof idb.databases === "function") {
    const list = await idb.databases();
    if (!list.some((d) => d.name === "tsumugi")) return { memories: [], skipped: 0, missing: true };
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
  if (!db) return { memories: [], skipped: 0, missing: true };
  try {
    if (!db.objectStoreNames.contains("memoryObjects")) return { memories: [], skipped: 0, missing: false };
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
