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
  clearTombstoneIfUnchanged, getTombstone, listTombstones, setTombstoneVaultStateIfUnchanged,
  type Tombstone,
} from "./db";
import { dayFileNameFor } from "./vault";
import { parseFrontmatter, parseMemoryDayFile } from "./markdown";

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

const MAX_FILES_SCANNED = 20000;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Looks for the record's id in every Markdown file under Memories/ and Conversations/ (recursively: a file the user moved or renamed is still found).
 * Matches the frontmatter line `id: <id>` exactly (a mere mention of the id in another record's text or links does not count). Read-only.
 * "unknown" when the folder tree can not be read or is larger than MAX_FILES_SCANNED files (never "absent" on a partial look).
 */
/** the YAML frontmatter blocks of a Tsumugi Markdown file: one per record (a day file holds several, separated by the entry marker). Only a block that STARTS the record counts. */
function frontmatterBlocks(text: string): string[] {
  const out: string[] = [];
  for (const entry of text.split(/\r?\n<!-- tsumugi:entry -->\r?\n/)) {
    const t = entry.replace(/^\s+/, "");
    if (!t.startsWith("---")) continue;
    const end = t.indexOf("\n---", 3);
    if (end > 0) out.push(t.slice(3, end));
  }
  return out;
}

async function scanVaultForId(root: FileSystemDirectoryHandle, id: string, ownerConversationId?: string): Promise<VaultPresence> {
  // Presence is decided as generously as the restore parser reads a file: the shared frontmatter parser (trimmed keys, quoted values) OR a tolerant line match
  // (indented / spaced keys). Over-reporting "present" only keeps a guard longer; under-reporting could let a restorable file come back after the guard is gone.
  const lineFor = (key: string, value: string) => new RegExp(`^\\s*${key}\\s*:\\s*["']?${escapeRegExp(value)}["']?\\s*$`, "m");
  const idLine = lineFor("id", id);
  const ownerLine = ownerConversationId ? lineFor("conversationId", ownerConversationId) : null;
  const matches = (fm: string): boolean => {
    if (idLine.test(fm) || (ownerLine !== null && ownerLine.test(fm))) return true;
    const parsed = parseFrontmatter(`---\n${fm.replace(/^\r?\n/, "").replace(/\r/g, "")}\n---\n`)?.frontmatter;
    return parsed !== undefined && (parsed.id === id || (ownerConversationId !== undefined && parsed.conversationId === ownerConversationId));
  };
  let scanned = 0;
  // The WHOLE visible Vault is searched (hidden folders such as .tsumugi are skipped, as the restore scan skips them): the restore scan finds record folders
  // at any depth (e.g. archive/Memories/...), so a narrower look here could report "absent" for a file that a restore would still bring back.
  const walk = async (dir: FileSystemDirectoryHandle): Promise<VaultPresence> => {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (name.startsWith(".")) continue;
      if (handle.kind === "directory") {
        const inner = await walk(handle as FileSystemDirectoryHandle);
        if (inner !== "absent") return inner;
      } else if (name.toLowerCase().endsWith(".md")) {
        if (++scanned > MAX_FILES_SCANNED) return "unknown";
        const text = await (await (handle as FileSystemFileHandle).getFile()).text();
        if (frontmatterBlocks(text).some(matches)) return "present";     // pasted YAML in a body, or a mention in another record, does not count
      }
    }
    return "absent";
  };
  return walk(root);
}

/**
 * Read-only. "present": the Vault still holds the record; "absent": it holds no copy anywhere under Memories/ or Conversations/ (found by id, wherever the
 * file was moved to); "unknown": it can not be decided (unreadable tree, too many files). A quick look at the canonical path comes first; an index.json
 * key alone is NOT treated as presence (deleting the file in the Vault leaves the key behind).
 */
export async function checkTombstoneInVault(root: FileSystemDirectoryHandle, t: Tombstone): Promise<VaultPresence> {
  try {
    // A tombstone remembers the Vault the record was deleted from. Looking at a DIFFERENT Vault says nothing about that one (switching back would bring the record back),
    // so the answer is "unknown" and the tombstone is neither verified nor purged.
    if (typeof t.vaultId === "string") {
      const idText = await readTextIfExists(root, ".tsumugi/vault-identity.json");
      let onDisk: unknown = null;
      try { onDisk = idText === null ? null : (JSON.parse(idText) as { vaultId?: unknown }).vaultId; } catch { onDisk = null; }
      if (onDisk !== t.vaultId) return "unknown";
    }
    if (t.kind === "memory" && t.date) {
      const day = await readTextIfExists(root, `Memories/${dayFileNameFor(t.date)}`);
      if (day !== null) {
        let members;
        try { members = parseMemoryDayFile(day); } catch { return "unknown"; }
        if (members.some((m) => m.id === t.id)) return "present";
      }
    }
    // a cascade conversation tombstone also guards the Memories made from that conversation: while any of their files remains, the guard must stay
    return await scanVaultForId(root, t.id, t.kind === "conversation" && t.cascade ? t.id : undefined);
  } catch { return "unknown"; }
}

/** Read-only. Does the Vault hold a copy of this record (by frontmatter id, wherever the file is; Sources included)? Used before the user may close a stuck entry with "keep both as they are", and by the startup check of accepted entries. */
export async function findRecordInVault(root: FileSystemDirectoryHandle, id: string): Promise<VaultPresence> {
  try { return await scanVaultForId(root, id); } catch { return "unknown"; }
}

/** Pure. Why a tombstone may or may not be forgotten now. */
export function purgeDecision(t: Tombstone, now: string, retentionDays: number = PURGE_AFTER_DAYS): { purgeable: boolean; reason: "vault-copy-may-exist" | "kept-by-user" | "too-recent" | "ok" } {
  if (t.vault === "kept") return { purgeable: false, reason: "kept-by-user" };
  if (t.vault !== "absent") return { purgeable: false, reason: "vault-copy-may-exist" };
  const age = Date.parse(now) - Date.parse(t.deletedAt);
  if (!Number.isFinite(age) || age < retentionDays * 86_400_000) return { purgeable: false, reason: "too-recent" };
  return { purgeable: true, reason: "ok" };
}

/**
 * Read-only check of the Vault copy; records the verdict on the tombstone ("absent" is remembered, a still-present copy keeps the tombstone "unverified").
 * The verdict is recorded only if the tombstone is still exactly the one that was scanned (a decision another tab made meanwhile, e.g. "keep the Vault copy", is never overwritten).
 */
export async function verifyTombstone(root: FileSystemDirectoryHandle, kind: Tombstone["kind"], id: string, now: string = new Date().toISOString()): Promise<VaultPresence | "no-tombstone"> {
  const t = await getTombstone(kind, id);
  if (!t) return "no-tombstone";
  const presence = await checkTombstoneInVault(root, t);
  if (presence === "absent" && t.vault !== "kept") await setTombstoneVaultStateIfUnchanged(t, "absent", now);          // records the verdict / refreshes the check time; "kept" is the user's own decision and is never replaced by a check
  else if (presence === "present" && t.vault === "absent") await setTombstoneVaultStateIfUnchanged(t, "unverified", now);   // it came back into the Vault: the guard must stay
  return presence;
}

/** The user keeps the Vault copy on purpose: the tombstone stays (the copy still can not re-enter the app) and is never purged automatically. */
/** Only if the tombstone is still exactly the one the user saw (another tab may have changed it meanwhile). Returns whether it was applied. */
export const keepVaultCopy = (seen: Tombstone, now: string = new Date().toISOString()): Promise<boolean> => setTombstoneVaultStateIfUnchanged(seen, "kept", now);

/** "Allow it back": lifts the tombstone. The deleted record is NOT recreated; it can be restored from the Vault again if the Vault still holds it. */
/** Only if the tombstone is still exactly the one the user saw (a newer deletion by another tab is never erased by a stale click). Returns whether it was lifted. */
export const allowBack = (seen: Tombstone): Promise<boolean> => clearTombstoneIfUnchanged(seen);

/**
 * Forgets every tombstone that satisfies the purge conditions. A stored "absent" verdict can be old, so the Vault is READ AGAIN immediately before each
 * tombstone is cleared: only a copy that is absent NOW allows it (a copy that came back keeps the tombstone and puts it back to "unverified"). Without a
 * readable Vault nothing is purged. The clear itself is conditional on the tombstone being unchanged. Returns what was forgotten.
 */
export async function purgeEligibleTombstones(root: FileSystemDirectoryHandle | null, now: string = new Date().toISOString(), retentionDays: number = PURGE_AFTER_DAYS): Promise<{ kind: Tombstone["kind"]; id: string }[]> {
  const purged: { kind: Tombstone["kind"]; id: string }[] = [];
  if (!root) return purged;
  for (const t of await listTombstones()) {
    if (!purgeDecision(t, now, retentionDays).purgeable) continue;
    const presence = await checkTombstoneInVault(root, t);
    if (presence === "present") { await setTombstoneVaultStateIfUnchanged(t, "unverified", now); continue; }
    if (presence !== "absent") continue;
    if (await clearTombstoneIfUnchanged(t)) purged.push({ kind: t.kind, id: t.id });
  }
  return purged;
}
