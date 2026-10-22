/**
 * Data lifecycle for ordinary users: what happens after "delete", and how a stuck (held / long-pending) Outbox entry is resolved by the user.
 *
 *   delete  -> db.ts deleteMemoryByUser / deleteConversationByUser: record + references + Outbox + ledger in ONE transaction, plus a TOMBSTONE
 *              (the durable record of the user's intent; ids / dates / states only, never text)
 *   guard   -> db.ts: no path that copies records from the Vault into IndexedDB (auto import, resync add, manual restore) re-inserts a tombstoned record
 *   verify  -> this file: a READ-ONLY check whether the Vault still holds a copy (present / absent / unknown)
 *   purge   -> this file: a tombstone is forgotten only when ALL hold:
 *                (1) its Vault copy was verified absent (state "absent") - otherwise forgetting it would let the Vault copy come back;
 *                (2) it is at least PURGE_AFTER_DAYS old (other devices / profiles that sync through the same Vault have had time to see the removal);
 *                (3) the user did not choose to keep the Vault copy ("kept" is never purged automatically).
 *              The user can also lift a tombstone explicitly ("allow it back"), which only re-enables restoring it from the Vault.
 *
 * What this does NOT do (explicit, see docs/data-lifecycle.md): it never deletes a Vault file by itself. The Vault copy of a deleted record is removed by the
 * user (or a later, separately reviewed propagation step); until it is verified absent, the tombstone stays as the guard.
 * Nothing here logs or sends anything.
 */
import {
  clearTombstone, getTombstone, listTombstones, setTombstoneVaultState,
  type Tombstone,
} from "./db";
import { dayFileNameFor, fileNameFor } from "./vault";
import { parseMemoryDayFile } from "./markdown";

export const PURGE_AFTER_DAYS = 30;
export type VaultPresence = "absent" | "present" | "unknown";

async function readTextIfExists(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const parts = path.split("/");
  let dir = root;
  try {
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: false });
    const file = await (await dir.getFileHandle(parts[parts.length - 1], { create: false })).getFile();
    return await file.text();
  } catch (e) {
    if ((e as { name?: string })?.name === "NotFoundError") return null;
    throw e;
  }
}

/** Read-only. "present": the Vault still holds the record; "absent": it holds no copy; "unknown": it can not be decided (missing date, unreadable / unparsable file). */
export async function checkTombstoneInVault(root: FileSystemDirectoryHandle, t: Tombstone): Promise<VaultPresence> {
  try {
    if (t.kind === "memory") {
      if (!t.date) return "unknown";
      const day = await readTextIfExists(root, `Memories/${dayFileNameFor(t.date)}`);
      if (day !== null) {
        let members;
        try { members = parseMemoryDayFile(day); } catch { return "unknown"; }
        if (members.some((m) => m.id === t.id)) return "present";
      }
      if ((await readTextIfExists(root, `Memories/${fileNameFor(t.id, t.date)}`)) !== null) return "present";    // a Reflection / legacy one-file-per-record Memory
      return "absent";
    }
    const indexRaw = await readTextIfExists(root, ".tsumugi/index.json");
    if (indexRaw !== null) {
      let index: unknown;
      try { index = JSON.parse(indexRaw); } catch { return "unknown"; }
      if (index && typeof index === "object" && !Array.isArray(index) && t.id in (index as Record<string, unknown>)) return "present";
    }
    if (!t.startedAt) return indexRaw === null ? "unknown" : "absent";
    if ((await readTextIfExists(root, `Conversations/${fileNameFor(t.id, t.startedAt)}`)) !== null) return "present";
    return "absent";
  } catch { return "unknown"; }
}

/** Pure. Why a tombstone may or may not be forgotten now. */
export function purgeDecision(t: Tombstone, now: string, retentionDays: number = PURGE_AFTER_DAYS): { purgeable: boolean; reason: "vault-copy-may-exist" | "kept-by-user" | "too-recent" | "ok" } {
  if (t.vault === "kept") return { purgeable: false, reason: "kept-by-user" };
  if (t.vault !== "absent") return { purgeable: false, reason: "vault-copy-may-exist" };
  const age = Date.parse(now) - Date.parse(t.deletedAt);
  if (!Number.isFinite(age) || age < retentionDays * 86_400_000) return { purgeable: false, reason: "too-recent" };
  return { purgeable: true, reason: "ok" };
}

/** Read-only check of the Vault copy; records the verdict on the tombstone ("absent" is remembered, a still-present copy keeps the tombstone "unverified"). */
export async function verifyTombstone(root: FileSystemDirectoryHandle, kind: Tombstone["kind"], id: string, now: string = new Date().toISOString()): Promise<VaultPresence | "no-tombstone"> {
  const t = await getTombstone(kind, id);
  if (!t) return "no-tombstone";
  const presence = await checkTombstoneInVault(root, t);
  if (presence === "absent") await setTombstoneVaultState(kind, id, "absent", now);
  else if (presence === "present" && t.vault === "absent") await setTombstoneVaultState(kind, id, "unverified", now);   // it came back into the Vault: the guard must stay
  return presence;
}

/** The user keeps the Vault copy on purpose: the tombstone stays (the copy still can not re-enter the app) and is never purged automatically. */
export const keepVaultCopy = (kind: Tombstone["kind"], id: string, now: string = new Date().toISOString()) => setTombstoneVaultState(kind, id, "kept", now);

/** "Allow it back": lifts the tombstone. The deleted record is NOT recreated; it can be restored from the Vault again if the Vault still holds it. */
export const allowBack = clearTombstone;

/** Forgets every tombstone that satisfies the purge conditions. Returns what was forgotten. */
export async function purgeEligibleTombstones(now: string = new Date().toISOString(), retentionDays: number = PURGE_AFTER_DAYS): Promise<{ kind: Tombstone["kind"]; id: string }[]> {
  const purged: { kind: Tombstone["kind"]; id: string }[] = [];
  for (const t of await listTombstones()) {
    if (purgeDecision(t, now, retentionDays).purgeable) { await clearTombstone(t.kind, t.id); purged.push({ kind: t.kind, id: t.id }); }
  }
  return purged;
}
