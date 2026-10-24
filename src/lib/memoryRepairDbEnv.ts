/** Production wiring of RepairEnv. Imported by nothing; a human-triggered tool must call it explicitly. */
import { commitMemoryRepairTransaction, getAllConversations, getAllMemoryObjects, getVaultOutboxEntry, readMemoryRepairSettings } from "./db";
import type { RepairEnv } from "./memoryRepairRunner";

export function createDbRepairEnv(now: () => string = () => new Date().toISOString()): RepairEnv {
  return {
    readSnapshot: async () => ({ memories: await getAllMemoryObjects(), conversations: await getAllConversations() }),
    readSettings: readMemoryRepairSettings,
    readOutbox: async (ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await getVaultOutboxEntry(id)] as const))),
    commit: commitMemoryRepairTransaction,
    now,
  };
}
