/** Dedicated OPFS diagnostic entry point. No normal app initialization or db.ts helpers.
 * Nothing runs at import/mount. All IO is an explicit user action, under the existing world lock.
 * Locks cover cooperating world operations only: users must close other Tsumugi tabs/apps. */
import { buildVaultRecoveryPlan, openExistingRecoveryDatabase, readRecoveryLocalSnapshot, type RecoveryPlan } from "./vaultRecovery";

const WORLD_LOCK = "tsumugi-vault-world";
const CONTROL_KEYS = ["activeVaultEpoch", "committedVaultEpoch", "vaultWorldJournalVersion", "registryGenerationEpoch"] as const;
const WIPE_KEY = "tsumugi:wipe:v1";
export interface RecoveryEnvironment {
  factory: IDBFactory;
  storage: Pick<StorageManager, "getDirectory">;
  locks: Pick<LockManager, "request">;
  localStorage: Pick<Storage, "getItem">;
  userAgent: string;
  hasDirectoryPicker: boolean;
}

function assertNotWiping(env: RecoveryEnvironment) {
  // Unlike the normal app's fail-soft helper, inaccessible localStorage stops diagnosis.
  if (env.localStorage.getItem(WIPE_KEY) !== null) throw new Error("wipe-in-progress");
}
function isEpoch(raw: unknown): raw is string {
  return typeof raw === "string" && Number.isSafeInteger(Number(raw)) && Number(raw) >= 0 && String(Number(raw)) === raw;
}
export async function readRecoveryControl(db: IDBDatabase): Promise<unknown[]> {
  if (!db.objectStoreNames.contains("settings")) throw new Error("world-unconfirmed");
  const tx = db.transaction(["settings"], "readonly");
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error("world-unconfirmed"));
  });
  const requests = CONTROL_KEYS.map(key => new Promise<unknown>((resolve, reject) => {
    const request = tx.objectStore("settings").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("world-unconfirmed"));
  }));
  const [values] = await Promise.all([Promise.all(requests), done]);
  const [activeRaw, committed, version, registryEpoch] = values;
  const active = activeRaw === undefined ? "0" : activeRaw;
  if (!isEpoch(active) || !isEpoch(committed) || active !== committed || version !== "1" ||
    (registryEpoch !== undefined && !isEpoch(registryEpoch))) throw new Error("world-unconfirmed");
  return values;
}

/** iPhone/Android OPFS only. Do not silently inspect an unrelated OPFS on a PC FSA world.
 * getDirectory returns the origin's root handle; no child is created or initialized.
 * An existing .tsumugi directory is required as evidence of a pre-existing Vault.
 * This API has no "open root only if it already exists" flag. We never create application files. */
export async function restoreVaultHandleReadOnly(env: RecoveryEnvironment): Promise<FileSystemDirectoryHandle> {
  if (env.hasDirectoryPicker && !/Android/i.test(env.userAgent)) throw new Error("opfs-only");
  if (typeof env.storage?.getDirectory !== "function") throw new Error("opfs-unavailable");
  const root = await env.storage.getDirectory();
  await root.getDirectoryHandle(".tsumugi", { create: false });
  return root;
}

export async function runRecoveryDiagnostic(env: RecoveryEnvironment, signal: AbortSignal): Promise<RecoveryPlan> {
  signal.throwIfAborted();
  if (typeof env.locks?.request !== "function") throw new Error("locks-unavailable");
  assertNotWiping(env);
  // No queue/wait timeout: a held lock stops the diagnostic before any DB/OPFS access.
  // Once acquired, retain it until every awaited read finishes, even after cancellation.
  return env.locks.request(WORLD_LOCK, { mode: "exclusive", ifAvailable: true }, async lock => {
    if (!lock) throw new Error("world-busy");
    signal.throwIfAborted();
    assertNotWiping(env);
    const db = await openExistingRecoveryDatabase(env.factory);
    let versionChanged = false;
    db.onversionchange = () => { versionChanged = true; db.close(); };
    try {
      const before = await readRecoveryControl(db);
      signal.throwIfAborted();
      const root = await restoreVaultHandleReadOnly(env);
      signal.throwIfAborted();
      const snapshot = await readRecoveryLocalSnapshot(env.factory);
      const plan = await buildVaultRecoveryPlan(root, snapshot, signal);
      signal.throwIfAborted();
      assertNotWiping(env);
      if (versionChanged || JSON.stringify(before) !== JSON.stringify(await readRecoveryControl(db))) throw new Error("world-changed");
      return plan;
    } finally { db.close(); }
  });
}
