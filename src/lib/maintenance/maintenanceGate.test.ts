/**
 * Maintenance gate (stage 1, fictional data only): the durable journal gate, the exclusive-lock window, the window-limited Vault-write
 * permission, gate survival after a lost tab, and proof that the normal app (startup flush, Save Foundation Bootstrap, legacy writers, Connect)
 * changes neither the Vault nor ANY Outbox entry nor the sync ledger while the gate is in place. Run: `npm run test:maintenance`.
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
const vaultMod = require(path.join(OUT, "lib/vault.js")) as typeof import("../vault");
const lockMod = require(path.join(OUT, "lib/vaultWorldLock.js")) as typeof import("../vaultWorldLock");
const journalMod = require(path.join(OUT, "lib/vaultRecoveryJournal.js")) as typeof import("../vaultRecoveryJournal");
const bootMod = require(path.join(OUT, "lib/saveFoundationBootstrap.js")) as typeof import("../saveFoundationBootstrap");
const gateMod = require(path.join(OUT, "lib/maintenance/maintenanceGate.js")) as typeof import("./maintenanceGate");
const win = require(path.join(OUT, "lib/maintenance/maintenanceWindow.js")) as typeof import("./maintenanceWindow");
const fx = require(path.join(OUT, "lib/memoryRepairTestWorld.js")) as typeof import("../memoryRepairTestWorld");
const testSupport = require(path.join(OUT, "lib/maintenance/testSupport.js")) as typeof import("./testSupport");
const FakeVault = testSupport.FakeVault;
type FakeVault = import("./testSupport").FakeVault;
const locks = testSupport.installFakeLocks();

const NOW = "2026-10-20T00:00:00.000Z";
const tick = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));
const pendingErr = (e: any) => e?.name === "VaultRecoveryPendingError";
const world = async () => ({ activeVaultEpoch: 0, committedVaultEpoch: 0, registryGenerationEpoch: 0, journalVersion: "current", backend: null });
function memStore(raw?: string) { const s = { raw, async read() { return s.raw; }, async write(t: string) { s.raw = t; } }; return s; }

const withType = (m: any) => ({ ...m, metadata: { ...m.metadata, sourceType: "chat" } });
const IDS = { mem: (i: number) => `gate-m${i}`, conv: (i: number) => `gate-c${i}` };
/** nine Memories and three Conversations, every one with a pending Outbox entry and no sync ledger (stand-ins for "the unrelated pending ones") */
async function seed() {
  await dbm.clearMemoryData(); await dbm.clearVaultSyncState();
  for (const e of [...await dbm.getPendingVaultOutboxEntries(), ...await dbm.getHeldVaultOutboxEntries(), ...await dbm.getDoneVaultOutboxEntries()]) await dbm.deleteVaultOutboxEntry(e.id);
  const vault = new FakeVault();
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "vault-gate-1", createdAt: "x" }));
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  const ident = { id: "current", vaultId: "vault-gate-1", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: NOW, pendingCandidateVaultId: null, updatedAt: NOW };
  await dbm.putVaultIdentityRecord(ident as any);
  await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
  const mems: any[] = [];
  for (let i = 1; i <= 9; i++) mems.push(withType(fx.mem(IDS.mem(i), IDS.conv(((i - 1) % 3) + 1), `要約${i}`, `内容${i}`, fx.T0, { date: i <= 6 ? fx.T0 : "2026-08-21T00:00:00.000Z" })));
  for (let i = 1; i <= 3; i++) await dbm.putConversationWithOutbox(fx.conv(IDS.conv(i), [`発言${i}`], fx.T0, mems.filter((m) => m.conversationId === IDS.conv(i)).map((m) => m.id)) as any);
  for (const m of mems) await dbm.putMemoryObjectWithOutbox(m, "memory");
  return { vault, mems };
}
const outboxState = async () => JSON.stringify([...await dbm.getPendingVaultOutboxEntries(), ...await dbm.getHeldVaultOutboxEntries(), ...await dbm.getDoneVaultOutboxEntries()].sort((a, b) => (a.id < b.id ? -1 : 1)));
const ledgerState = async () => {
  const out: string[] = [];
  for (let i = 1; i <= 9; i++) out.push(`m${i}=${await dbm.getVaultSyncState("memory:" + IDS.mem(i))}`);
  for (let i = 1; i <= 3; i++) out.push(`c${i}=${await dbm.getVaultSyncState("conversation:" + IDS.conv(i))}`);
  return out.join(",");
};
const everything = async (v: FakeVault) => JSON.stringify({ vault: v.snapshot(), writes: v.writeCount, outbox: await outboxState(), ledger: await ledgerState() });
async function cleanup() {
  if (win.isMaintenanceWindowOpen()) await win.endMaintenanceWindow();
  await testSupport.releaseStaleMaintenanceGateForTests({ now: () => NOW });
  delete (globalThis as any).location;
}

test("gate journal: opens only over no / finished journal; refuses another in-progress or an unreadable one; saved + read back; closes only its own", async () => {
  const store = memStore(); const deps = { store, readWorld: world, now: () => NOW, newId: () => "op-1" };
  assert.deepEqual(await gateMod.readGateState(store), { kind: "none" });
  assert.deepEqual(await gateMod.openMaintenanceGate("test", deps), { ok: true, operationId: "op-1" });
  const j = JSON.parse(store.raw!);
  assert.equal(j.status, "in-progress"); assert.equal(j.narrowMemoryRepair.kind, "maintenance-window"); assert.equal(j.world.activeVaultEpoch, 0);
  assert.equal(/[぀-ヿ一-鿿]/.test(store.raw!), false, "no text in the journal");
  assert.equal(await journalMod.isRecoveryBlockingNormalWrites(store, async () => 0), true, "the app's existing gate sees it");
  assert.equal(await journalMod.isRecoveryBlockingNormalWrites(store, async () => 1), false, "a journal of another Vault world does not block (existing rule)");
  assert.deepEqual(await gateMod.readGateState(store), { kind: "maintenance-open", operationId: "op-1", openedAt: NOW });
  assert.deepEqual(await gateMod.openMaintenanceGate("again", deps), { ok: false, reason: "maintenance-gate-already-open" });
  assert.deepEqual(await gateMod.closeMaintenanceGate("other-op", deps), { closed: false, reason: "different-operation" });
  assert.deepEqual(await gateMod.closeMaintenanceGate("op-1", deps), { closed: true });
  assert.equal(await journalMod.isRecoveryBlockingNormalWrites(store, async () => 0), false);
  assert.deepEqual(await gateMod.closeMaintenanceGate("op-1", deps), { closed: false, reason: "not-in-progress" });
  assert.deepEqual(await gateMod.openMaintenanceGate("after finished", { ...deps, newId: () => "op-2" }), { ok: true, operationId: "op-2" });
  // a journal that is NOT ours: never opened over, never closed
  const foreign = memStore(JSON.stringify({ ...JSON.parse(store.raw!), operationId: "recovery-1", narrowMemoryRepair: undefined }));
  const before = foreign.raw;
  assert.deepEqual(await gateMod.openMaintenanceGate("x", { ...deps, store: foreign }), { ok: false, reason: "other-journal-in-progress" });
  assert.deepEqual(await gateMod.closeMaintenanceGate(null, { ...deps, store: foreign }), { closed: false, reason: "not-a-maintenance-gate" });
  assert.equal(foreign.raw, before, "a foreign journal is untouched");
  const bad = memStore("{garbage");
  assert.deepEqual(await gateMod.openMaintenanceGate("x", { ...deps, store: bad }), { ok: false, reason: "journal-unreadable" });
  assert.equal(bad.raw, "{garbage");
  const failing = { async read() { return undefined; }, async write() { throw new Error("disk"); } };
  assert.deepEqual(await gateMod.openMaintenanceGate("x", { ...deps, store: failing }), { ok: false, reason: "journal-not-saved" });
});

test("window: the exclusive lock is held until end; app-side shared requests wait; the gate opens with the lock and closes before it is released", async () => {
  await seed();
  try {
    const r = await win.enterMaintenanceWindow({ purpose: "test", now: () => NOW });
    assert.equal(r.ok, true);
    assert.equal((await gateMod.readGateState()).kind, "maintenance-open");
    assert.deepEqual(await win.enterMaintenanceWindow({ purpose: "second" }), { ok: false, reason: "window-already-open" });
    let ran = false;
    const appSide = lockMod.withVaultWorldRead(async () => { ran = true; });   // what the app's flush / Bootstrap / Capture / Connect use
    await tick(); assert.equal(ran, false, "the app's shared lock request waits while the window is open");
    const e = await win.endMaintenanceWindow();
    assert.deepEqual(e, { ok: true, gateClosed: true });
    await appSide; assert.equal(ran, true, "it proceeds only after the window ended");
    assert.equal((await gateMod.readGateState()).kind, "finished");
    assert.equal(await journalMod.isRecoveryBlockingNormalWrites(), false);
    assert.deepEqual(await win.endMaintenanceWindow(), { ok: false, reason: "no-window" });
  } finally { await cleanup(); }
});

test("window: refuses without touching anything when another holder / waiter exists, when the lock can not be taken in time, or off the maintenance page", async () => {
  const { vault } = await seed();
  try {
    const before = await everything(vault); const jBefore = await gateMod.readGateState();
    assert.deepEqual(await win.enterMaintenanceWindow({ purpose: "t", queryLocks: async () => ({ held: [{ name: win.VAULT_WORLD_LOCK_NAME }] }) }), { ok: false, reason: "lock-contention" });
    assert.deepEqual(await win.enterMaintenanceWindow({ purpose: "t", queryLocks: async () => ({ pending: [{ name: win.VAULT_WORLD_LOCK_NAME }] }) }), { ok: false, reason: "lock-contention" });
    let releaseOther!: () => void; const otherHold = new Promise<void>((r) => { releaseOther = r; });
    const other = locks.request(win.VAULT_WORLD_LOCK_NAME, { mode: "shared" }, () => otherHold);   // a busy app tab
    await tick();
    assert.deepEqual(await win.enterMaintenanceWindow({ purpose: "t", timeoutMs: 40 }), { ok: false, reason: "lock-unavailable" });
    releaseOther(); await other;
    Object.defineProperty(globalThis, "location", { value: { pathname: "/" }, configurable: true, writable: true });
    assert.deepEqual(await win.enterMaintenanceWindow({ purpose: "t" }), { ok: false, reason: "not-maintenance-context" });
    delete (globalThis as any).location;
    assert.deepEqual(await gateMod.readGateState(), jBefore, "no journal was written by any refused attempt");
    assert.equal(await everything(vault), before);
    assert.equal(win.isMaintenanceWindowOpen(), false);
    // and the lock is free again afterwards
    const ok = await win.enterMaintenanceWindow({ purpose: "t", now: () => NOW }); assert.equal(ok.ok, true);
  } finally { await cleanup(); }
});

test("a lost tab leaves the gate in place: after the lock is gone the app still can not change the Vault, any Outbox entry or the ledger; only the maintenance page releases it", async () => {
  const { vault, mems } = await seed();
  try {
    const entered = await win.enterMaintenanceWindow({ purpose: "crash test", now: () => NOW }); assert.equal(entered.ok, true);
    win.__simulateTabLossForTests();                       // tab closed / browser crash: lock released by the browser, module state gone
    await tick();
    assert.equal(win.isMaintenanceWindowOpen(), false);
    assert.equal((await gateMod.readGateState()).kind, "maintenance-open", "the journal outlives the tab");
    assert.equal(await journalMod.isRecoveryBlockingNormalWrites(), true);
    // the lock is free (the browser released it), so a normal tab is NOT waiting any more: only the gate protects
    let ran = false; await lockMod.withVaultWorldRead(async () => { ran = true; }); assert.equal(ran, true);
    const before = await everything(vault);

    // 1. startup flush
    const flush = await vaultMod.flushPendingToVault(vault.root());
    assert.equal(flush.writtenCount, 0); assert.ok(flush.failedCount > 0, "unsynced records are reported as not written");
    // 2. Save Foundation Bootstrap (reconciles every pending Outbox entry on a normal start)
    await assert.rejects(bootMod.runSaveFoundationBootstrap({ root: vault.root(), now: () => NOW }), pendingErr);
    // 3. legacy writers (Capture's Vault write, background flush)
    await assert.rejects(vaultMod.writeMemoryObjectMarkdown(vault.root(), mems[0]), pendingErr);
    await assert.rejects(vaultMod.writeConversationMarkdown(vault.root(), (await dbm.getConversation(IDS.conv(1)))!), pendingErr);
    // 4. Connect / Capture: they reach the Vault only through the gated functions above (see the static checks below)
    await assert.rejects(journalMod.assertNoPendingRecovery(), pendingErr);
    assert.equal(await everything(vault), before, "Vault files, write count, every Outbox entry and the sync ledger are byte-identical");

    // a new maintenance attempt must not silently take over the stale gate
    assert.deepEqual(await win.enterMaintenanceWindow({ purpose: "again" }), { ok: false, reason: "maintenance-gate-already-open" });
    // releasing needs the exclusive lock and touches only a maintenance gate
    assert.deepEqual(await testSupport.releaseStaleMaintenanceGateForTests({ now: () => NOW }), { released: true });
    assert.equal(await journalMod.isRecoveryBlockingNormalWrites(), false);
    // control: with the gate gone the same writer works, so the gate was the only thing stopping it
    await vaultMod.writeMemoryObjectMarkdown(vault.root(), mems[0]);
    assert.ok(vault.writeCount > 0);
  } finally { await cleanup(); }
});

test("write permission: exists only inside a scope of an open window; ends with the scope; never without a window, off the maintenance page, or in a tab without the probe", async () => {
  const { vault, mems } = await seed();
  try {
    const write = (m: any) => vaultMod.writeMemoryObjectMarkdown(vault.root(), m);
    // no window at all
    await assert.rejects(win.runWithMaintenanceWriteAccess(async () => 1), (e: any) => e?.name === "MaintenanceWriteAccessError" && e.reason === "no-window");
    assert.equal(journalMod.isRecoveryWriteAccessActive(), false);

    assert.equal((await win.enterMaintenanceWindow({ purpose: "perm", now: () => NOW })).ok, true);
    assert.equal(journalMod.isRecoveryWriteAccessActive(), false, "window open but no scope: no permission");
    await assert.rejects(write(mems[0]), pendingErr);

    await win.runWithMaintenanceWriteAccess(async () => {
      assert.equal(journalMod.isRecoveryWriteAccessActive(), true);
      await write(mems[0]);                                 // allowed inside the scope
    });
    assert.ok(vault.writeCount > 0);
    assert.equal(await dbm.getVaultSyncState("memory:" + mems[0].id), mems[0].updatedAt, "the normal writer ran unchanged (ledger set as usual)");
    assert.equal(journalMod.isRecoveryWriteAccessActive(), false, "scope ended");
    const wc = vault.writeCount;
    await assert.rejects(write(mems[1]), pendingErr);        // blocked again right after the scope
    assert.equal(vault.writeCount, wc);

    // a failing scope still ends the permission
    await assert.rejects(win.runWithMaintenanceWriteAccess(async () => { throw new Error("boom"); }));
    assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
    // the window can not end while a scope runs
    await win.runWithMaintenanceWriteAccess(async () => { assert.deepEqual(await win.endMaintenanceWindow(), { ok: false, reason: "write-scope-active" }); });

    // not the maintenance page: the permission is refused even with an open window
    Object.defineProperty(globalThis, "location", { value: { pathname: "/" }, configurable: true, writable: true });
    await assert.rejects(win.runWithMaintenanceWriteAccess(async () => 1), (e: any) => e?.reason === "not-maintenance-context");
    assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
    Object.defineProperty(globalThis, "location", { value: { pathname: "/maintenance/repair" }, configurable: true, writable: true });
    await win.runWithMaintenanceWriteAccess(async () => { assert.equal(journalMod.isRecoveryWriteAccessActive(), true); });
    Object.defineProperty(globalThis, "location", { value: { pathname: "/" }, configurable: true, writable: true });
    // even a scope that was already running loses the permission when the page is not a maintenance page
    delete (globalThis as any).location;

    // a tab where the maintenance module installed no probe (every normal tab): nothing can grant the permission
    journalMod.setMaintenanceWriteAccessProbe(null);
    await win.runWithMaintenanceWriteAccess(async () => { assert.equal(journalMod.isRecoveryWriteAccessActive(), false); await assert.rejects(write(mems[2]), pendingErr); });

    // a throwing probe means "no permission"
    journalMod.setMaintenanceWriteAccessProbe(() => { throw new Error("x"); });
    assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
    journalMod.setMaintenanceWriteAccessProbe(null);

    // after the window ended or was lost, nothing is left
    await win.endMaintenanceWindow();
    assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
    await assert.rejects(win.runWithMaintenanceWriteAccess(async () => 1), (e: any) => e?.reason === "no-window");
    assert.equal((await win.enterMaintenanceWindow({ purpose: "again", now: () => NOW })).ok, true);
    win.__simulateTabLossForTests();
    assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
    await assert.rejects(write(mems[3]), pendingErr);
  } finally { journalMod.setMaintenanceWriteAccessProbe(null); await cleanup(); }
});

test("normal operation is unchanged when no maintenance window exists: no probe, no permission, no gate, writers work as before", async () => {
  const { vault, mems } = await seed();
  await cleanup();
  assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
  assert.equal(await journalMod.isRecoveryBlockingNormalWrites(), false);
  assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
  await vaultMod.writeMemoryObjectMarkdown(vault.root(), mems[0]);
  assert.ok(vault.writeCount > 0);
  await journalMod.runWithRecoveryWriteAccess(async () => { assert.equal(journalMod.isRecoveryWriteAccessActive(), true); });   // the existing Recovery scope still works
  assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
});

test("static: the lock name matches; the generic Recovery Apply refuses a narrow-repair journal; Connect asserts the gate before it reconciles; Capture / Connect never write files themselves", () => {
  const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");
  const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(new RegExp(`const LOCK_NAME = "${win.VAULT_WORLD_LOCK_NAME}"`).test(read("lib/vaultWorldLock.ts")), "VAULT_WORLD_LOCK_NAME must equal vaultWorldLock.ts LOCK_NAME");
  const apply = read("lib/vaultRecoveryApply.ts");
  assert.ok(/narrowMemoryRepair && existing\.journal\.status === "in-progress"/.test(apply) && /use-explicit-memory-repair/.test(apply));
  const narrow = read("lib/memoryNarrowRepair.ts");
  assert.ok(/p\?\.version === 2/.test(narrow), "the debug narrow repair only resumes version-2 payloads; ours is version 1 and is refused there");
  const connect = read("lib/connect.ts");
  const first = connect.indexOf("reconcileMemoryOutboxEntry(env");
  assert.ok(first > 0 && (connect.slice(0, first).match(/assertNoPendingRecovery\(\)/g) ?? []).length >= 1, "Connect checks the gate before its projection");
  for (const f of ["lib/connect.ts", "lib/capture.ts"]) assert.equal(/createWritable|removeEntry/.test(code(f)), false, `${f} writes files only through the gated writers`);
  // the only change to the shared Recovery journal module is the opt-in probe (default null)
  const j = read("lib/vaultRecoveryJournal.ts");
  assert.ok(/let maintenanceWriteAccessProbe: \(\(\) => boolean\) \| null = null;/.test(j));
  assert.ok(/if \(recoveryWriteAccessDepth > 0\) return true;\s+if \(maintenanceWriteAccessProbe === null\) return false;/.test(j));
  // only the maintenance window module installs it
  const installers = ["lib/vault.ts", "lib/db.ts", "components/ChatScreen.tsx", "lib/capture.ts", "lib/connect.ts"].filter((f) => /setMaintenanceWriteAccessProbe/.test(read(f)));
  assert.deepEqual(installers, []);
});
