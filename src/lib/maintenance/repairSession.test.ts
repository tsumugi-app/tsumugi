/**
 * Single-item repair session (stage 2b/2c), dummy data only (fake IndexedDB, FakeVault, fake locks): the whole pipeline inside one maintenance
 * window - pre-check, restore point + read-back receipt, repair commit, real sync, verification - and the automatic strict restore after a
 * failure at each point. Run: `npm run test:maintenance`.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..", "..");
const SRC = path.join(__dirname, "..", "..", "..", "src");
const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "idb") return require(path.join(OUT, "lib/fakeIdb.js"));
  return origLoad.call(this, request, parent, isMain);
};
const dbm = require(path.join(OUT, "lib/db.js")) as typeof import("../db");
const proj = require(path.join(OUT, "lib/vaultProjection.js")) as typeof import("../vaultProjection");
const vaultMod = require(path.join(OUT, "lib/vault.js")) as typeof import("../vault");
const sync = require(path.join(OUT, "lib/maintenance/scopedVaultSync.js")) as typeof import("./scopedVaultSync");
const lockMod = require(path.join(OUT, "lib/vaultWorldLock.js")) as typeof import("../vaultWorldLock");
const journalMod = require(path.join(OUT, "lib/vaultRecoveryJournal.js")) as typeof import("../vaultRecoveryJournal");
const repair = require(path.join(OUT, "lib/memoryContaminationRepair.js")) as typeof import("../memoryContaminationRepair");
const fx = require(path.join(OUT, "lib/memoryRepairTestWorld.js")) as typeof import("../memoryRepairTestWorld");
const gateMod = require(path.join(OUT, "lib/maintenance/maintenanceGate.js")) as typeof import("./maintenanceGate");
const win = require(path.join(OUT, "lib/maintenance/maintenanceWindow.js")) as typeof import("./maintenanceWindow");
const scopeMod = require(path.join(OUT, "lib/maintenance/precheckScope.js")) as typeof import("./precheckScope");
const session = require(path.join(OUT, "lib/maintenance/repairSession.js")) as typeof import("./repairSession");
const testSupport = require(path.join(OUT, "lib/maintenance/testSupport.js")) as typeof import("./testSupport");
const FakeVault = testSupport.FakeVault;
type FakeVault = import("./testSupport").FakeVault;
testSupport.installFakeLocks();

const NOW = "2026-10-10T00:00:00.000Z";
const R1 = fx.D.repair.items[0];
const JP = /[぀-ヿ一-鿿]/;
const CREATED = "Conversations/dummy-created-by-the-operation.md";   // stands in for a file the operation creates (absent before)

/**
 * `clearMemoryData` does not touch the `settings` store, but the repair commit writes its ledger / backup keys there and a present ledger makes
 * the commit a no-op ("already-done"). So every scenario starts by removing exactly the four repair keys of the dummy test Memory, through the
 * production restore transaction with the CURRENT value as the expectation (a value nobody expected makes it throw instead of being deleted).
 */
async function clearRepairSettings() {
  const keys = fx.D.repair.items.flatMap((i) => [repair.repairLedgerKey, repair.repairBackupKey, repair.repairRollbackLedgerKey, repair.repairRollbackBackupKey].map((f) => f(i.memoryId)));
  const current = await dbm.readMemoryRepairSettings(keys);
  await dbm.commitMaintenanceRestore({
    memories: [], conversations: [], outbox: [], syncLedger: [],
    settings: keys.filter((k) => current[k] !== undefined).map((k) => ({ key: k, expectCurrent: current[k] as string, target: null })),
  });
}
async function resetDb() {
  await clearRepairSettings();
  await dbm.clearMemoryData(); await dbm.clearVaultSyncState();
  for (const e of [...await dbm.getPendingVaultOutboxEntries(), ...await dbm.getHeldVaultOutboxEntries(), ...await dbm.getDoneVaultOutboxEntries()]) await dbm.deleteVaultOutboxEntry(e.id);
}
const digest = async () => [...(await sync.idbSnapshot()).entries()].sort().map(([k, v]) => `${k}=${v}`).join("\n");

/** the world BEFORE the repair (same shape as the sync test, minus the repair itself) */
async function seedPre(keys: string[] = [R1.key], full = false) {
  await resetDb();
  const w = fx.world();
  const vault = new FakeVault();
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "vault-restore-1", createdAt: "x" }));
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  const ident = { id: "current", vaultId: "vault-restore-1", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: NOW, pendingCandidateVaultId: null, updatedAt: NOW };
  await dbm.putVaultIdentityRecord(ident as any);
  await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
  const items = fx.D.repair.items.filter((i) => keys.includes(i.key));
  const orig = w.conversations.find((c) => c.id === R1.originalConversationId)!, upd = w.conversations.find((c) => c.id === R1.updatingConversationId)!, M = w.memories.find((m) => m.id === R1.memoryId)!;
  // full: the Vault + Outbox hold EVERY fixture record (the link counterparts of a reviewed item are targets of the pre-check, so they must be consistent in the Vault too)
  const seedConvs = full ? (w.conversations as any[]) : [...new Map(items.flatMap((i) => [i.originalConversationId, i.updatingConversationId]).map((id) => [id, w.conversations.find((c) => c.id === id)!])).values()];
  const seedMems = full ? (w.memories as any[]) : items.map((i) => w.memories.find((m) => m.id === i.memoryId)!);
  const T0 = fx.T0, DAY2 = "2026-08-21T00:00:00.000Z";
  const withType = (m: any) => ({ ...m, metadata: { ...m.metadata, sourceType: "chat" } });
  const neighbours = [
    fx.mem("nb-a", "nb-conv-a", "近所の別の要約A", "別の内容A", T0, { date: T0, createdAt: "2026-08-20T00:00:01.000Z" }),
    fx.mem("nb-b", "nb-conv-b", "近所の別の要約B", "別の内容B", T0, { date: T0, createdAt: "2026-08-20T00:00:02.000Z" }),
    fx.mem("nb-c", "nb-conv-c", "翌日の別の要約C", "別の内容C", T0, { date: DAY2, createdAt: "2026-08-21T00:00:01.000Z" }),
    fx.mem("nb-d", "nb-conv-d", "翌日の別の要約D", "別の内容D", T0, { date: DAY2, createdAt: "2026-08-21T00:00:02.000Z" }),
  ].map(withType);
  const nbConv = fx.conv("nb-conv-c", ["別の会話の発言"], T0, ["nb-c"]);
  const env0 = { root: vault.root(), vaultIdentity: ident as any, now: () => NOW };
  const seed: any[] = [];
  for (const c of [...seedConvs, nbConv]) seed.push(["conversation", await dbm.putConversationWithOutbox(c as any)]);
  for (const m of [...neighbours, ...seedMems.map(withType)]) seed.push(["memory", await dbm.putMemoryObjectWithOutbox(m as any, "memory")]);
  for (const [kind, entry] of seed) { const r = kind === "conversation" ? await proj.reconcileConversationOutboxEntry(env0, entry) : await proj.reconcileMemoryOutboxEntry(env0, entry); assert.equal(r.status, "done", kind + JSON.stringify(r)); }
  // unrelated pending Outbox entry (stand-in for the 6 real ones)
  await dbm.putVaultOutboxEntry({ id: "memory:OTHER-1", recordType: "memory", recordId: "OTHER-1", recordUpdatedAt: "x", steps: {}, attempt: { count: 62, lastError: "verify-history-mismatch", lastAttemptAt: "x" }, status: "pending", heldReason: null, createdAt: "c", updatedAt: "u" } as any);
  const plan: any = await repair.planRepairItem(R1, w, NOW, fx.D.repair.updating);
  assert.equal(plan.status, "READY");
  return { w, vault, orig, upd, M, plan };
}


const DATA = (): import("../privateRepairData").PrivateRepairData => JSON.parse(JSON.stringify(fx.D));
async function cleanup() {
  if (win.isMaintenanceWindowOpen()) await win.endMaintenanceWindow();
  await win.releaseStaleMaintenanceGate({ now: () => NOW });
}
async function world(keys: string[] = [R1.key], full = false) {
  await cleanup();
  const s = await seedPre(keys, full);
  // The reviewed item's link counterparts, the bystander and every other fixture record exist in the real database. Planning needs them (a Memory
  // whose link counterpart is missing is HOLD), so the dummy database holds the WHOLE fixture world, written plainly (no Outbox entry: they are
  // bystanders that must never be touched by the session).
  const tagged = (m: any) => ({ ...m, metadata: { ...m.metadata, sourceType: "chat" } });
  for (const c of s.w.conversations) if (!(await dbm.getConversation(c.id))) await dbm.putConversation(c as any);
  for (const m of s.w.memories) if (!(await dbm.getMemoryObject(m.id))) await dbm.putMemoryObject(tagged(m) as any);
  return { ...s, backup: s.vault.copy(), preSnapshot: JSON.stringify(s.vault.snapshot()), preDigest: await digest(), otherBefore: JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")) };
}
type World = Awaited<ReturnType<typeof world>>;
const run = (w: World, over: Partial<import("./repairSession").RepairSessionInput> = {}) => session.runRepairSession({
  data: DATA(), key: R1.key, root: w.vault.root(), confirm: `REPAIR ${R1.key}`, vaultBackupRoot: w.backup.root(),
  persistRestorePoint: async (t) => t, now: () => NOW, ...over,
});
const unchanged = async (w: World) => {
  assert.equal(JSON.stringify(w.vault.snapshot()), w.preSnapshot, "Vault byte-identical to before");
  assert.equal(await digest(), w.preDigest, "IndexedDB (records, ledger, Outbox) identical to before");
  assert.equal(JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")), w.otherBefore, "the unrelated pending Outbox entry never changed");
  for (const k of [repair.repairLedgerKey, repair.repairBackupKey].map((f) => f(R1.memoryId))) assert.equal((await dbm.readMemoryRepairSettings([k]))[k], undefined, "no repair ledger / backup left");
};

test("pre-check on the dummy world: READY in IndexedDB, Vault consistent, no sharing Outbox conflict => the all-clear verdict the session requires", async () => {
  const w = await world();
  try {
    const data = scopeMod.subsetData(DATA(), [R1.key]);
    const input = { conversations: await dbm.getAllConversations(), memories: await dbm.getAllMemoryObjects(), outbox: [...await dbm.getPendingVaultOutboxEntries(), ...await dbm.getHeldVaultOutboxEntries(), ...await dbm.getDoneVaultOutboxEntries()], settings: {} };
    const a = await scopeMod.analyzeSelection(input as any, data, [R1.key], NOW);
    assert.equal(a.report.items[0].status, "READY", JSON.stringify(a.report.items[0].failed));
    const v = await scopeMod.diagnoseVaultForPrecheck(a.existing, w.vault.root());
    const verdict = scopeMod.overallVerdict({ status: a.report.items[0].status, conflicts: a.conflicts, vault: v });
    assert.equal(verdict.code, "READY_ALL_CLEAR", JSON.stringify([verdict.reasons, v.mismatched.map((d) => d.area + ":" + d.status), v.unverified.map((d) => d.area + ":" + d.status)]));
  } finally { await cleanup(); }
});

test("session: the whole repair + real sync completes inside the window; the normal app is blocked meanwhile; afterwards gate closed, lock free, nothing else touched", async () => {
  const w = await world();
  const saved: string[] = [];
  const mBefore = JSON.stringify(await dbm.getMemoryObject(R1.memoryId));
  let atCommit: { gate: string; blocking: boolean; flushWritten: number; unchangedByFlush: boolean } | null = null;
  try {
    const report = await run(w, {
      persistRestorePoint: async (t) => { saved.push(t); return t; },
      onStage: async (stage) => {
        if (stage !== "repair-committed") return;
        const before = JSON.stringify(w.vault.snapshot()) + (await digest());
        const flush = await vaultMod.flushPendingToVault(w.vault.root());     // what the normal app does at startup
        atCommit = { gate: (await gateMod.readGateState()).kind, blocking: await journalMod.isRecoveryBlockingNormalWrites(), flushWritten: flush.writtenCount, unchangedByFlush: before === JSON.stringify(w.vault.snapshot()) + (await digest()) };
      },
    });
    assert.equal(report.status, "completed", JSON.stringify(report));
    assert.deepEqual(report.stages, ["window-open", "prechecked", "vault-backup-checked", "restore-point-verified", "repair-committed", "dry-run-ok", "backups-verified", "synced", "verified"]);
    assert.deepEqual(atCommit, { gate: "maintenance-open", blocking: true, flushWritten: 0, unchangedByFlush: true });
    assert.equal(report.gateClosed, true); assert.equal(report.windowOpen, false);
    assert.equal((await gateMod.readGateState()).kind, "finished"); assert.equal(win.isMaintenanceWindowOpen(), false);
    let ran = false; await lockMod.withVaultWorldRead(async () => { ran = true; }); assert.equal(ran, true, "the lock is free again");
    assert.equal(saved.length, 1, "one restore point was saved");
    // the repair really happened and is synced
    const m = (await dbm.getMemoryObject(R1.memoryId))!;
    assert.notEqual(JSON.stringify(m), mBefore, "the contaminated Memory was replaced by the restored one");
    assert.ok(await dbm.getMemoryObject((await repair.updatingMemoryIdFor(R1.updatingConversationId))), "new Memory exists");
    assert.equal((await dbm.readMemoryRepairSettings([repair.repairLedgerKey(R1.memoryId)]))[repair.repairLedgerKey(R1.memoryId)] !== undefined, true, "repair ledger present");
    assert.equal(JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")), w.otherBefore, "the unrelated pending Outbox entry never changed");
    assert.notEqual(JSON.stringify(w.vault.snapshot()), w.preSnapshot, "the Vault was synced");
    assert.equal(JP.test(JSON.stringify(report)), false, "the report carries no text");
  } finally { await cleanup(); }
});

test("session refusals happen BEFORE any repair write: wrong confirmation, no backup, unknown key, backup copy differs, restore point not read back identically", async () => {
  const cases: [string, (w: World) => Partial<import("./repairSession").RepairSessionInput>, RegExp][] = [
    ["confirmation", () => ({ confirm: "REPAIR other" }), /^confirmation-phrase$/],
    ["no backup", () => ({ vaultBackupRoot: null }), /^vault-backup-required$/],
    ["unknown key", () => ({ key: "no-such-key", confirm: "REPAIR no-such-key" }), /^unknown-key$/],
    ["backup differs", (w) => { const b = w.vault.copy(); b.put(".tsumugi/index.json", b.files.get(".tsumugi/index.json")!.content + " "); return { vaultBackupRoot: b.root() }; }, /^vault-backup-differs:\.tsumugi\/index\.json$/],
    ["read-back differs", () => ({ persistRestorePoint: async (t: string) => t.slice(0, -1) + " " }), /^restore-point:/],
  ];
  for (const [name, over, reason] of cases) {
    const w = await world();
    try {
      const report = await run(w, over(w));
      assert.equal(report.status, "refused", `${name}: ${JSON.stringify(report)}`);
      assert.match(report.reason, reason, name);
      assert.equal(report.windowOpen, false, name);
      assert.ok(!report.stages.includes("repair-committed"), name);
      await unchanged(w);
      assert.equal((await gateMod.readGateState()).kind === "maintenance-open", false, `${name}: the gate is not left behind`);
    } finally { await cleanup(); }
  }
});

test("failure right after the repair commit (nothing in the Vault yet): automatic strict restore of IndexedDB; Vault untouched; window and gate closed", async () => {
  const w = await world();
  try {
    const report = await run(w, { onStage: async (stage) => { if (stage === "repair-committed") throw new Error("simulated-crash"); } });
    assert.equal(report.status, "rolled-back", JSON.stringify(report));
    assert.equal(report.restore?.status, "restored");
    assert.equal(report.windowOpen, false); assert.equal(report.gateClosed, true);
    await unchanged(w);
  } finally { await cleanup(); }
});

test("failure after the real sync wrote the Vault: automatic strict restore brings IndexedDB AND the Vault back byte-identical", async () => {
  const w = await world();
  try {
    const report = await run(w, { onStage: async (stage) => { if (stage === "synced") throw new Error("simulated-crash"); } });
    assert.equal(report.status, "rolled-back", JSON.stringify(report));
    assert.ok(report.stages.includes("synced"));
    await unchanged(w);
    assert.equal((await gateMod.readGateState()).kind, "finished");
  } finally { await cleanup(); }
});

test("failure in the middle of the real sync (a Vault write fails): automatic strict restore; everything identical to before", async () => {
  const w = await world();
  try {
    w.vault.failNextWrites("Memories/" + fx.T0.slice(0, 10) + ".md", 1);
    const report = await run(w);
    assert.equal(report.status, "rolled-back", JSON.stringify(report));
    assert.equal(report.sync?.ok, false);
    await unchanged(w);
  } finally { await cleanup(); }
});

test("an unexplained change to a scope file during the session: the restore refuses to guess -> rollback-failed, the window (lock + gate) STAYS OPEN, nothing more is written", async () => {
  const w = await world();
  try {
    let snapshotAtStop = "";
    const report = await run(w, { onStage: async (stage) => {
      if (stage !== "synced") return;
      const p = [...w.vault.files.keys()].find((k) => k.startsWith("Memories/"))!;
      w.vault.put(p, w.vault.files.get(p)!.content + "\nan external edit");
      snapshotAtStop = JSON.stringify(w.vault.snapshot()) + (await digest());
    } });
    assert.equal(report.status, "rollback-failed", JSON.stringify(report));
    assert.equal(report.windowOpen, true); assert.equal(report.gateClosed, false);
    assert.equal(win.isMaintenanceWindowOpen(), true);
    assert.equal((await gateMod.readGateState()).kind, "maintenance-open", "the gate is kept");
    assert.ok(report.restore?.stopReasons.some((r) => r.startsWith("vault-unidentified:Memories/")), JSON.stringify(report.restore));
    assert.equal(JSON.stringify(w.vault.snapshot()) + (await digest()), snapshotAtStop, "the failed restore wrote nothing");
    let ran = false; const p = lockMod.withVaultWorldRead(async () => { ran = true; });
    await new Promise((r) => setTimeout(r, 30)); assert.equal(ran, false, "the normal app still waits for the lock");
    await win.endMaintenanceWindow(); await p;
  } finally { await cleanup(); }
});

/** let any fire-and-forget Vault work of the seeding finish, then take the operator's copy of the Vault and the "before" digests */
async function settled(w: World): Promise<World> {
  await new Promise((r) => setTimeout(r, 50));
  return { ...w, backup: w.vault.copy(), preSnapshot: JSON.stringify(w.vault.snapshot()), preDigest: await digest() };
}
const itemOf = (key: string) => fx.D.repair.items.find((i) => i.key === key)!;
/** failure message: the report, and for a refused backup comparison the first differing region of the live Vault file versus the operator's copy */
const explain = (w: World, r: { reason: string }) => {
  const m = /vault-backup-differs:(.+)$/.exec(r.reason);
  if (!m) return JSON.stringify(r);
  const a = w.vault.snapshot()[m[1]] ?? "<absent>", b = w.backup.snapshot()[m[1]] ?? "<absent>";
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `${JSON.stringify(r)} live[${a.length}]@${i}: ${a.slice(Math.max(0, i - 60), i + 120)} || backup[${b.length}]: ${b.slice(Math.max(0, i - 60), i + 120)}`;
};
const runItem = (w: World, key: string, over: Partial<import("./repairSession").RepairSessionInput> = {}) => run(w, { key, confirm: `REPAIR ${key}`, ...over });

test("two items that share one updating conversation (the TWKAB3 / E2Y6NN shape: R3 then R4) repair one after the other through the full session; the shared new Memory exists exactly once", async () => {
  const [A, B] = [itemOf("R3"), itemOf("R4")];
  const w = await settled(await world([A.key, B.key]));
  try {
    const first = await runItem(w, A.key);
    assert.equal(first.status, "completed", explain(w, first));
    // the operator copies the (now changed) Vault again before the next item: the session requires the copy to equal the live files
    const second = await runItem({ ...w, backup: w.vault.copy() }, B.key);
    assert.equal(second.status, "completed", JSON.stringify(second));
    for (const r of [first, second]) { assert.equal(r.gateClosed, true); assert.equal(r.windowOpen, false); }
    const sharedId = await repair.updatingMemoryIdFor(A.updatingConversationId);
    const shared = await dbm.getMemoryObject(sharedId);
    assert.ok(shared, "the shared new Memory exists");
    const upd = (await dbm.getConversation(A.updatingConversationId))!;
    assert.equal(upd.memoryObjectIds.filter((id) => id === sharedId).length, 1, "the updating conversation references it exactly once");
    assert.equal((await dbm.getAllMemoryObjects()).filter((m) => m.id === sharedId).length, 1);
    for (const it of [A, B]) {
      const m = (await dbm.getMemoryObject(it.memoryId))!;
      assert.equal(m.summary, it.restored.summary, `${it.key} restored`);
      assert.ok((await dbm.readMemoryRepairSettings([repair.repairLedgerKey(it.memoryId)]))[repair.repairLedgerKey(it.memoryId)] !== undefined, `${it.key} ledger present`);
    }
    assert.equal(JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")), w.otherBefore, "the unrelated pending Outbox entry never changed");
    assert.equal((await gateMod.readGateState()).kind, "finished");
    // a second run of the same item is a no-op refusal, never a second write
    const again = await runItem(w, B.key);
    assert.equal(again.status, "refused", JSON.stringify(again));
  } finally { await cleanup(); }
});

test("the SECOND item of a shared pair fails after the real sync: it is restored to exactly the state after the first item (the first item's repair is kept, nothing else changes)", async () => {
  const [A, B] = [itemOf("R3"), itemOf("R4")];
  const w = await settled(await world([A.key, B.key]));
  try {
    const first = await runItem(w, A.key);
    assert.equal(first.status, "completed", explain(w, first));
    const vaultAfterFirst = JSON.stringify(w.vault.snapshot()), digestAfterFirst = await digest();
    const second = await runItem({ ...w, backup: w.vault.copy() }, B.key, { onStage: async (stage) => { if (stage === "synced") throw new Error("simulated-crash"); } });
    assert.equal(second.status, "rolled-back", JSON.stringify(second));
    assert.equal(JSON.stringify(w.vault.snapshot()), vaultAfterFirst, "Vault identical to the state after the first item");
    assert.equal(await digest(), digestAfterFirst, "IndexedDB (records, ledger, Outbox) identical to the state after the first item");
    assert.equal((await dbm.getMemoryObject(A.memoryId))!.summary, A.restored.summary, "the first item stays repaired");
    assert.equal((await dbm.readMemoryRepairSettings([repair.repairLedgerKey(B.memoryId)]))[repair.repairLedgerKey(B.memoryId)], undefined, "no ledger for the failed item");
    assert.equal((await gateMod.readGateState()).kind, "finished");
  } finally { await cleanup(); }
});

test("an item whose removed link has a system-generated (Reflection) counterpart is refused BEFORE any write: the scoped sync does not cover reflection records", async () => {
  const w = await world();
  try {
    const data = DATA();
    const item = data.repair.items.find((i) => i.key === R1.key)!;
    const reflectionLinkId = Object.keys(item.links)[0];       // the fixture's first link goes to a system-generated Memory
    item.links[reflectionLinkId] = "remove";
    const report = await run(w, { data });
    assert.equal(report.status, "refused", JSON.stringify(report));
    assert.match(report.reason, /^reflection-counterpart-unsupported:/);
    assert.deepEqual(report.stages, ["window-open", "prechecked"], "refused before the restore point and before any write");
    assert.equal(report.windowOpen, false); assert.equal(report.gateClosed, true);
    await unchanged(w);
  } finally { await cleanup(); }
});

test("the session module is the only new importer of the restore / runner modules; it logs and sends nothing", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = strip(fs.readFileSync(path.join(SRC, "lib/maintenance/repairSession.ts"), "utf8"));
  assert.equal(/console\.|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|document\.cookie|\beval\(|new Function/.test(code), false);
  const walk = (d: string, out: string[] = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p); } return out; };
  const importers = walk(SRC).filter((p) => !/\.test\.ts$/.test(p)).filter((p) => /\/repairSession["']/.test(fs.readFileSync(p, "utf8")));
  assert.ok(importers.every((p) => /components\/maintenance\/MaintenancePanel\.tsx$/.test(p)), importers.join(","));
});
