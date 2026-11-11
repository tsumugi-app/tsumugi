/**
 * Memory Graph P1-B: where the confirmed names live (docs/memory-graph-p1b.md).
 *
 *   Vault  People/<name> (<id>).md  one note per person: readable, and the user's decisions as one JSON line (personAlias.ts). The SOURCE OF TRUTH.
 *   device IndexedDB "settings" store, key `people:v1`: a cache of the Vault notes plus the decisions made here that the Vault does not have yet
 *          (`pending`). It can be lost: the next sync reads it back from the Vault.
 *
 * Why not the Registry / outbox of the other records: the Registry validator of every deployed version rejects a row of an unknown record type (the whole
 * shard is then treated as unreadable), and the outbox consumers (status, consistency check, maintenance) count every entry as a Conversation / Memory /
 * Source. A person row there would break other devices that run an older build and mislabel findings. People notes are therefore found by reading
 * People/ (they are few), and the merge is a union of decisions, which can not lose one.
 *
 * Sync (`syncPeopleWithVault`), run after the save-foundation bootstrap of the app's startup (inside its Vault world lock), never in parallel (Web Lock):
 *   1. the Vault must be the paired one (the identity file matches this device's pairing) and no repair may be in progress; otherwise nothing is read
 *      or written
 *   2. read every People/*.md; a person note that can not be read whole is never written over (its name is reported)
 *   3. per person: the union of the device copy and the Vault copies (a sync tool's conflicted copy is merged too, never deleted)
 *   4. write the person's note when the Vault lacks a decision (over a note the app wrote and nobody edited since; a note edited by hand or any other file
 *      is never written over: a new file is written next to it); read it back; only a note that holds every decision clears `pending`
 *   5. a person that is in the device cache but not in the Vault and has nothing pending was removed from the Vault: it is removed here too (only after a
 *      complete read of People/)
 *   6. the device cache is updated in one transaction, merged again with anything decided meanwhile
 * Nothing else in the Vault is touched; no Memory, Conversation or keyword is read for this or changed.
 */
import { isPersonRecord, mergePerson, parsePersonMarkdown, personCovers, personToMarkdown, type PersonRecord } from "./personAlias";

export const PEOPLE_STORE_KEY = "people:v1";
export const PEOPLE_DIR = "People";

export interface PeopleState {
  people: PersonRecord[];
  /** people with a decision made on this device that the Vault does not hold yet */
  pending: string[];
}

export const emptyPeopleState = (): PeopleState => ({ people: [], pending: [] });

/** the stored cache: shape checked; anything malformed is dropped (the Vault has the decisions) */
export function parsePeopleState(raw: unknown): PeopleState {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return emptyPeopleState(); } }
  if (typeof v !== "object" || v === null) return emptyPeopleState();
  const o = v as Record<string, unknown>;
  const people = Array.isArray(o.people) ? o.people.filter(isPersonRecord) : [];
  const ids = new Set(people.map((p) => p.id));
  const pending = Array.isArray(o.pending) ? [...new Set(o.pending.filter((x): x is string => typeof x === "string" && ids.has(x)))] : [];
  return { people, pending };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the environment (IndexedDB and the Vault folder); tests pass their own
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface PeopleFile { fileName: string; text: string }
export interface PeopleStoreEnv {
  /** one read-modify-write of the device cache, atomic (one IndexedDB transaction) */
  updateState<T>(fn: (state: PeopleState) => { state: PeopleState; result: T }): Promise<T>;
  readState(): Promise<PeopleState>;
}
export interface PeopleVaultEnv {
  /**
   * every *.md of People/ (`complete: false` when a file or the folder could not be read: then nothing is removed; `namesKnown: false` when the folder
   * could not be listed to the end: then nothing is written either, since a file name in use could be missed)
   */
  listPeopleFiles(): Promise<{ files: PeopleFile[]; unreadable: string[]; complete: boolean; namesKnown?: boolean }>;
  writePeopleFile(fileName: string, text: string): Promise<void>;
  readPeopleFile(fileName: string): Promise<string | null>;
  /** the Vault is the one this device is paired with, and no repair of it is in progress */
  isPairedVault(): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// decisions made on this device
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** add decisions to a person (a new person when `create` is given) and mark it pending; one transaction */
export async function recordPersonDecisions(env: PeopleStoreEnv, personId: string, decisions: PersonRecord["decisions"], create?: { fileName: string; createdAt: string }): Promise<PersonRecord> {
  return env.updateState((state) => {
    const existing = state.people.find((p) => p.id === personId);
    if (!existing && !create) throw new Error("person-not-found");
    const base: PersonRecord = existing ?? { id: personId, fileName: create!.fileName, createdAt: create!.createdAt, decisions: [] };
    const next = mergePerson(base, { ...base, decisions });
    return {
      state: { people: [...state.people.filter((p) => p.id !== personId), next], pending: [...new Set([...state.pending, personId])] },
      result: next,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// sync with the Vault
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface PeopleSyncResult {
  status: "done" | "skipped";
  reason?: "not-paired" | "unavailable";
  read: number;
  written: number;
  removed: number;
  /** person notes that could not be read whole (never written over) */
  unreadable: string[];
  /** people whose decisions are still only on this device (a write or its check failed) */
  stillPending: number;
}

/** the Vault copies of each person: one per id (conflicted copies of a sync tool merged), with the file that the app writes to */
export function readVaultPeople(files: PeopleFile[]): { people: Map<string, { person: PersonRecord; files: string[] }>; unreadable: string[] } {
  const people = new Map<string, { person: PersonRecord; files: string[] }>();
  const unreadable: string[] = [];
  for (const f of [...files].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    const parsed = parsePersonMarkdown(f.text, f.fileName);
    if (!parsed) {
      if (/^type:\s*person\s*$/m.test(f.text)) unreadable.push(f.fileName);
      continue;
    }
    const seen = people.get(parsed.id);
    people.set(parsed.id, seen ? { person: mergePerson(seen.person, parsed), files: [...seen.files, f.fileName] } : { person: parsed, files: [f.fileName] });
  }
  return { people, unreadable };
}

/** the note is exactly what the app writes for the decisions it holds (nobody edited it by hand) */
export function isUneditedPersonNote(text: string, fileName: string): boolean {
  const parsed = parsePersonMarkdown(text, fileName);
  return parsed !== null && personToMarkdown(parsed) === text.replace(/\r\n/g, "\n");
}

/** where a person's decisions are written: an unedited note of this person (its own file name first), else a file name not in use */
export function fileToWrite(person: PersonRecord, ownFiles: string[], textByName: Map<string, string>): string {
  const unedited = (name: string) => ownFiles.includes(name) && isUneditedPersonNote(textByName.get(name) ?? "", name);
  if (unedited(person.fileName)) return person.fileName;
  const other = ownFiles.find(unedited);
  if (other) return other;
  const stem = person.fileName.replace(/\.md$/i, "");
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? `${stem}.md` : `${stem} ${n}.md`;
    if (!textByName.has(name)) return name;
  }
}

export async function syncPeopleWithVault(store: PeopleStoreEnv, vault: PeopleVaultEnv): Promise<PeopleSyncResult> {
  const result: PeopleSyncResult = { status: "done", read: 0, written: 0, removed: 0, unreadable: [], stillPending: 0 };
  if (!(await vault.isPairedVault())) return { ...result, status: "skipped", reason: "not-paired" };
  const listing = await vault.listPeopleFiles();
  const disk = readVaultPeople(listing.files);
  result.read = disk.people.size;
  result.unreadable = [...listing.unreadable, ...disk.unreadable];
  const blockedNames = new Set(result.unreadable);
  const textByName = new Map(listing.files.map((f) => [f.fileName, f.text]));
  for (const name of listing.unreadable) textByName.set(name, "");
  const local = await store.readState();

  // what the Vault holds after this sync, per person id (only what was written and read back counts)
  const vaultNow = new Map<string, PersonRecord>([...disk.people.entries()].map(([id, x]) => [id, x.person]));
  const ids = new Set([...local.people.map((p) => p.id), ...disk.people.keys()]);
  for (const id of ids) {
    const mine = local.people.find((p) => p.id === id);
    const theirs = disk.people.get(id);
    if (!mine) continue; // only in the Vault: read into the cache below
    const merged = theirs ? mergePerson(mine, theirs.person) : mine;
    if (theirs && personCovers(theirs.person, merged)) continue; // the Vault already has every decision
    if (!theirs && !local.pending.includes(id)) continue; // removed from the Vault: handled below, never written back
    // the file to write: a note of this person that the app wrote and nobody edited since (it is replaced whole); else a new file next to it. A note
    // edited by hand, another person's note or any other file is never written over (the readers merge the copies of one person by id)
    const fileName = fileToWrite(merged, theirs?.files ?? [], textByName);
    if (blockedNames.has(fileName) || listing.namesKnown === false) continue;
    try {
      await vault.writePeopleFile(fileName, personToMarkdown(merged));
      const back = await vault.readPeopleFile(fileName);
      const parsed = back === null ? null : parsePersonMarkdown(back, fileName);
      if (parsed && parsed.id === id && personCovers(parsed, merged)) {
        vaultNow.set(id, theirs ? mergePerson(theirs.person, parsed) : parsed);
        result.written += 1;
      }
    } catch {
      // stays pending: the next sync tries again
    }
  }

  // the device cache: the Vault copy, merged with whatever was decided here (also meanwhile); pending = a decision the Vault does not hold
  return store.updateState((state) => {
    const people: PersonRecord[] = [];
    const pending: string[] = [];
    let removed = 0;
    const all = new Set([...state.people.map((p) => p.id), ...vaultNow.keys()]);
    for (const id of all) {
      const mine = state.people.find((p) => p.id === id);
      const theirs = vaultNow.get(id);
      if (mine && !theirs && !state.pending.includes(id) && listing.complete && !local.pending.includes(id)) { removed += 1; continue; }
      const merged = mine && theirs ? mergePerson(mine, theirs) : (mine ?? theirs)!;
      people.push(merged);
      if (!theirs || !personCovers(theirs, merged)) pending.push(id);
    }
    const out = { ...result, removed, stillPending: pending.length };
    return { state: { people, pending }, result: out };
  });
}
