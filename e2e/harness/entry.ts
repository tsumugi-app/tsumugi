// Real-browser harness for the E2E (bundled by esbuild in CI, injected with page.addScriptTag from a LOCAL file).
// Runs the PRODUCTION modules (repair session, projection, db, Web Locks) against real IndexedDB and an OPFS directory standing in for the Vault folder.
// Fictional data only. The OS folder picker and its permission prompts are NOT exercised here (OPFS handles need no prompt).
import * as dbm from "../../src/lib/db";
import * as proj from "../../src/lib/vaultProjection";
import * as lockMod from "../../src/lib/vaultWorldLock";
import * as sessionMod from "../../src/lib/maintenance/repairSession";
import * as win from "../../src/lib/maintenance/maintenanceWindow";
import * as gateMod from "../../src/lib/maintenance/maintenanceGate";
import * as journal from "../../src/lib/vaultRecoveryJournal";
import * as sync from "../../src/lib/maintenance/scopedVaultSync";
import * as recovery from "../../src/lib/maintenance/crashRecovery";

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOW = "2026-10-10T00:00:00.000Z";
const g = globalThis as any;
let DATA: any, vaultRoot: any, backupRoot: any;

async function dirAt(name: string) {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(name, { recursive: true }); } catch { /* not there */ }
  return root.getDirectoryHandle(name, { create: true });
}
async function writeFile(root: any, path: string, text: string) {
  const parts = path.split("/"); let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await w.write(text); await w.close();
}
async function snapshot(root: any, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const [name, h] of root.entries()) {
    if (h.kind === "directory") Object.assign(out, await snapshot(h, prefix + name + "/"));
    else out[prefix + name] = await (await h.getFile()).text();
  }
  return out;
}
const idbDigest = async () => [...(await sync.idbSnapshot()).entries()].sort().map(([k, v]) => `${k}=${v}`).join("\n");

async function setup(p: { data: any; seededConversations: any[]; seededMemories: any[]; plainConversations: any[]; plainMemories: any[] }) {
  DATA = p.data;
  vaultRoot = await dirAt("vault"); backupRoot = await dirAt("vault-copy");
  await writeFile(vaultRoot, ".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "vault-restore-1", createdAt: "x" }));
  await writeFile(vaultRoot, ".tsumugi/registry-meta.json", JSON.stringify({ baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  const ident = { id: "current", vaultId: "vault-restore-1", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: NOW, pendingCandidateVaultId: null, updatedAt: NOW };
  await dbm.putVaultIdentityRecord(ident as any);
  await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
  const seed: [string, any][] = [];
  for (const c of p.seededConversations) seed.push(["conversation", await dbm.putConversationWithOutbox(c)]);
  for (const m of p.seededMemories) seed.push(["memory", await dbm.putMemoryObjectWithOutbox(m, "memory")]);
  const env0 = { root: vaultRoot, vaultIdentity: ident, now: () => NOW } as any;
  for (const [kind, entry] of seed) {
    const r: any = kind === "conversation" ? await proj.reconcileConversationOutboxEntry(env0, entry) : await proj.reconcileMemoryOutboxEntry(env0, entry);
    if (r.status !== "done") throw new Error("seed-not-done:" + kind + ":" + JSON.stringify(r));
  }
  // an unrelated PENDING Outbox entry (stand-in for the real unprocessed ones): the session must never touch it
  await dbm.putVaultOutboxEntry({ id: "memory:OTHER-1", recordType: "memory", recordId: "OTHER-1", recordUpdatedAt: "x", steps: {}, attempt: { count: 62, lastError: "verify-history-mismatch", lastAttemptAt: "x" }, status: "pending", heldReason: null, createdAt: "c", updatedAt: "u" } as any);
  for (const c of p.plainConversations) if (!(await dbm.getConversation(c.id))) await dbm.putConversation(c);
  for (const m of p.plainMemories) if (!(await dbm.getMemoryObject(m.id))) await dbm.putMemoryObject(m);
  for (const [path, text] of Object.entries(await snapshot(vaultRoot))) await writeFile(backupRoot, path, text);   // the operator's copy of the Vault
  return state();
}
async function state() {
  return { vault: await snapshot(vaultRoot), backup: await snapshot(backupRoot), idb: await idbDigest(), other: JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")) };
}
function run(o: { key: string; blockAt?: string; throwAt?: string; refreshCopy?: boolean }) {
  g.__reached = null;
  const go = async () => {
    if (o.refreshCopy) { backupRoot = await dirAt("vault-copy"); for (const [path, text] of Object.entries(await snapshot(vaultRoot))) await writeFile(backupRoot, path, text); }
    return sessionMod.runRepairSession({
      data: DATA, key: o.key, root: vaultRoot, confirm: `REPAIR ${o.key}`, vaultBackupRoot: backupRoot,
      persistRestorePoint: async (t: string) => { g.__saved = t; return t; }, now: () => NOW,
      onStage: async (stage: string) => {
        if (o.blockAt === stage) { g.__reached = stage; await new Promise<void>((r) => { g.__release = r; }); }
        if (o.throwAt === stage) throw new Error("simulated-crash");
      },
    });
  };
  g.__p = go();
  return g.__p;
}
/** a tab opened after the crash: points at the SAME OPFS directories (nothing is cleared) */
async function attach() {
  const root = await navigator.storage.getDirectory();
  vaultRoot = await root.getDirectoryHandle("vault"); backupRoot = await root.getDirectoryHandle("vault-copy");
  return state();
}
g.H = {
  setup, state, run, snapshot, idbDigest, NOW, attach,
  writeVaultFile: (p: string, t: string) => writeFile(vaultRoot, p, t),
  diagnose: (text: string) => recovery.diagnoseCrash({ restorePointText: text, root: vaultRoot, vaultCopyRoot: backupRoot }),
  recover: (text: string, confirm: string) => recovery.runCrashRecovery({ restorePointText: text, root: vaultRoot, vaultCopyRoot: backupRoot, confirm }),
  /** what a real tab does at startup: adopt the committed Vault epoch (without it every Vault-world operation of that tab is refused as stale) */
  initTab: () => lockMod.setTabVaultEpoch(0),
  getMemory: (id: string) => dbm.getMemoryObject(id),
  readGate: async () => (await gateMod.readGateState()).kind,
  blocking: () => journal.isRecoveryBlockingNormalWrites(),
  enterWindow: () => win.enterMaintenanceWindow({ purpose: "single-item-repair", now: () => NOW }),
  windowOpen: () => win.isMaintenanceWindowOpen(),
  readOrTimeout: (ms: number) => Promise.race([lockMod.withVaultWorldRead(async () => "ran"), new Promise<string>((r) => setTimeout(() => r("blocked"), ms))]),
  lockHeld: async () => ((await navigator.locks.query()).held ?? []).map((l) => l.name),
};
