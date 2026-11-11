/**
 * Memory Graph P1-B: the device side of the confirmed names (personAliasStore.ts holds the rules). IndexedDB through db.ts, the Vault folder through
 * the same write primitive the save foundation uses. No AI, no Memory read or written.
 */
"use client";

import { ulid } from "ulid";
import { getVaultIdentityRecord, readPeopleStateRaw, updatePeopleStateRaw } from "./db";
import { aliasNameLists, type ConfirmPlan, type PersonRecord } from "./personAlias";
import { PEOPLE_DIR, confirmPeopleInStore, parsePeopleState, revokeNameInStore, syncPeopleWithVault, type PeopleState, type PeopleStoreEnv, type PeopleSyncResult, type PeopleVaultEnv } from "./personAliasStore";
import { vaultProjectionPrimitives } from "./vault";
import { isRecoveryBlockingNormalWrites } from "./vaultRecoveryJournal";
import { withVaultSaveLock } from "./vaultSaveLock";

export const devicePeopleStore: PeopleStoreEnv = {
  async readState() {
    return parsePeopleState(await readPeopleStateRaw());
  },
  updateState<T>(fn: (state: PeopleState) => { state: PeopleState; result: T }) {
    return updatePeopleStateRaw((raw) => {
      const out = fn(parsePeopleState(raw));
      return { value: JSON.stringify(out.state), result: out.result };
    });
  },
};

/** the confirmed people of this device (never throws: [] when the cache can not be read) */
export async function loadConfirmedPeople(): Promise<PersonRecord[]> {
  try {
    return (await devicePeopleStore.readState()).people;
  } catch {
    return [];
  }
}

/** the confirmed name groups for the person sheet, the person context and Retrieval (never throws) */
export async function loadConfirmedAliasLists(): Promise<string[][]> {
  return aliasNameLists(await loadConfirmedPeople());
}

export type ConfirmOutcome = ConfirmPlan;

/** the user confirmed on the page that these names are one person (checked and recorded in one transaction) */
export function confirmSamePerson(names: string[]): Promise<ConfirmOutcome> {
  return confirmPeopleInStore(devicePeopleStore, names, { newDecisionId: ulid, newPersonId: ulid }, new Date().toISOString());
}

/** the user undid one name of a person */
export function revokeName(personId: string, name: string): Promise<boolean> {
  return revokeNameInStore(devicePeopleStore, personId, name, ulid, new Date().toISOString());
}

const isNotFound = (e: unknown) => e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError");

export function vaultPeopleEnv(root: FileSystemDirectoryHandle): PeopleVaultEnv {
  return {
    async listPeopleFiles() {
      let dir: FileSystemDirectoryHandle;
      try {
        dir = await root.getDirectoryHandle(PEOPLE_DIR, { create: false });
      } catch (e) {
        return { files: [], unreadable: [], complete: isNotFound(e), namesKnown: isNotFound(e) };
      }
      const files: { fileName: string; text: string }[] = [];
      const unreadable: string[] = [];
      let complete = true;
      let namesKnown = true;
      try {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind !== "file" || !name.toLowerCase().endsWith(".md")) continue;
          try {
            files.push({ fileName: name, text: await (await (handle as FileSystemFileHandle).getFile()).text() });
          } catch {
            unreadable.push(name);
            complete = false;
          }
        }
      } catch {
        complete = false;
        namesKnown = false;
      }
      return { files, unreadable, complete, namesKnown };
    },
    async writePeopleFile(fileName, text) {
      const dir = await root.getDirectoryHandle(PEOPLE_DIR, { create: true });
      await vaultProjectionPrimitives.writeFileInDir(dir, fileName, text, "people write");
    },
    async readPeopleFile(fileName) {
      try {
        const dir = await root.getDirectoryHandle(PEOPLE_DIR, { create: false });
        return await (await (await dir.getFileHandle(fileName, { create: false })).getFile()).text();
      } catch {
        return null;
      }
    },
    async isPairedVault() {
      try {
        // a repair or maintenance of this Vault in progress: nothing is read or written (as every normal save)
        if (await isRecoveryBlockingNormalWrites()) return false;
        const paired = (await getVaultIdentityRecord())?.vaultId;
        if (!paired) return false;
        const dir = await root.getDirectoryHandle(".tsumugi", { create: false });
        const text = await (await (await dir.getFileHandle("vault-identity.json", { create: false })).getFile()).text();
        const onDisk = (JSON.parse(text) as { vaultId?: unknown }).vaultId;
        return typeof onDisk === "string" && onDisk === paired;
      } catch {
        return false;
      }
    },
  };
}

const PEOPLE_LOCK = "tsumugi-people-sync";

/**
 * Read the People/ notes into this device and write the decisions made here. Called after the save-foundation bootstrap, under the Vault save lock;
 * one at a time across tabs. Never throws: a failure leaves the decisions pending for the next start.
 */
export async function syncPeopleOnStartup(root: FileSystemDirectoryHandle): Promise<PeopleSyncResult | null> {
  // under the Vault save lock, as every save: no repair, restore or other save of this Vault runs while People/ is read and written
  const run = () => withVaultSaveLock(() => syncPeopleWithVault(devicePeopleStore, vaultPeopleEnv(root)));
  try {
    if (typeof navigator !== "undefined" && navigator.locks) return await navigator.locks.request(PEOPLE_LOCK, run);
    return await run();
  } catch (error) {
    console.error("[People] sync with the Vault failed; the decisions stay on this device and are tried again at the next start", error);
    return null;
  }
}
