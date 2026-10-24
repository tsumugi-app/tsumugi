/**
 * Restore point + strict restore engine (stage 2a), dummy data only (fake IndexedDB + FakeVault). The operation under test is the real one:
 * the repair commit transaction followed by the real scoped Vault sync; the restore must bring IndexedDB and the Vault back EXACTLY.
 * Run: `npm run test:maintenance`.
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
const sync = require(path.join(OUT, "lib/maintenance/scopedVaultSync.js")) as typeof import("./scopedVaultSync");
const lockMod = require(path.join(OUT, "lib/vaultWorldLock.js")) as typeof import("../vaultWorldLock");
const repair = require(path.join(OUT, "lib/memoryContaminationRepair.js")) as typeof import("../memoryContaminationRepair");
const fx = require(path.join(OUT, "lib/memoryRepairTestWorld.js")) as typeof import("../memoryRepairTestWorld");
const hashMod = require(path.join(OUT, "lib/maintenance/hash.js")) as typeof import("./hash");
const invMod = require(path.join(OUT, "lib/maintenance/invariants.js")) as typeof import("./invariants");
const rpMod = require(path.join(OUT, "lib/maintenance/restorePoint.js")) as typeof import("./restorePoint");
const engine = require(path.join(OUT, "lib/maintenance/restoreEngine.js")) as typeof import("./restoreEngine");
const guardMod = require(path.join(OUT, "lib/maintenance/restoreGuard.js")) as typeof import("./restoreGuard");
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
  const keys = [repair.repairLedgerKey, repair.repairBackupKey, repair.repairRollbackLedgerKey, repair.repairRollbackBackupKey].map((f) => f(R1.memoryId));
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
async function seedPre() {
  await resetDb();
  const w = fx.world();
  const vault = new FakeVault();
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "vault-restore-1", createdAt: "x" }));
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  const ident = { id: "current", vaultId: "vault-restore-1", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: NOW, pendingCandidateVaultId: null, updatedAt: NOW };
  await dbm.putVaultIdentityRecord(ident as any);
  await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
  const orig = w.conversations.find((c) => c.id === R1.originalConversationId)!, upd = w.conversations.find((c) => c.id === R1.updatingConversationId)!, M = w.memories.find((m) => m.id === R1.memoryId)!;
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
  for (const c of [orig, upd, nbConv]) seed.push(["conversation", await dbm.putConversationWithOutbox(c as any)]);
  for (const m of [...neighbours, withType(M)]) seed.push(["memory", await dbm.putMemoryObjectWithOutbox(m as any, "memory")]);
  for (const [kind, entry] of seed) { const r = kind === "conversation" ? await proj.reconcileConversationOutboxEntry(env0, entry) : await proj.reconcileMemoryOutboxEntry(env0, entry); assert.equal(r.status, "done", kind + JSON.stringify(r)); }
  // unrelated pending Outbox entry (stand-in for the 6 real ones)
  await dbm.putVaultOutboxEntry({ id: "memory:OTHER-1", recordType: "memory", recordId: "OTHER-1", recordUpdatedAt: "x", steps: {}, attempt: { count: 62, lastError: "verify-history-mismatch", lastAttemptAt: "x" }, status: "pending", heldReason: null, createdAt: "c", updatedAt: "u" } as any);
  const plan: any = await repair.planRepairItem(R1, w, NOW, fx.D.repair.updating);
  assert.equal(plan.status, "READY");
  return { w, vault, orig, upd, M, plan };
}

/** capture the restore point from the world BEFORE the repair */
async function scenario() {
  const s = await seedPre();
  const env: import("./restorePoint").RestoreEnv = { idb: engine.createDbRestoreIdb(), root: s.vault.root() };
  const convPaths = await rpMod.readIndexedConversationPaths(env.root, [s.upd.id]);
  const scope = rpMod.computeRestoreScope({
    repairMemoryId: s.M.id,
    memories: [s.M, s.plan.restoredAfter, s.plan.newMemory, ...s.plan.counterparts.map((c: any) => c.before)],
    conversations: [s.upd], conversationFilePaths: [...convPaths, CREATED],
  });
  const rp = await rpMod.captureRestorePoint(scope, env, () => NOW);
  assert.deepEqual(Object.values(rp.idb.settings).filter((v) => v !== null), [], "the dummy world starts with no repair settings (no state carried over from an earlier scenario)");
  assert.equal(Object.keys(rp.idb.settings).length, 4);
  const text = rpMod.serializeRestorePoint(rp);
  return { ...s, env, scope, rp, text, preSnapshot: JSON.stringify(s.vault.snapshot()), preDigest: await digest(), otherBefore: JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")) };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

/** the real operation: repair commit transaction, then the real scoped Vault sync; returns what it is known to have produced */
async function operate(s: Scenario) {
  const curM = (await dbm.getMemoryObject(s.M.id))!, curU = (await dbm.getConversation(s.upd.id))!;
  const replaceMemories: any[] = [{ before: curM, after: s.plan.restoredAfter }];
  for (const c of s.plan.counterparts) { const cur = await dbm.getMemoryObject(c.before.id); if (cur) replaceMemories.push({ before: cur, after: c.after }); }
  await dbm.commitMemoryRepairTransaction({
    ledgerKey: repair.repairLedgerKey(s.M.id), ledgerValue: "{}", backupKey: repair.repairBackupKey(s.M.id),
    replaceMemories, addMemories: [s.plan.newMemory], replaceConversations: [{ before: curU, after: s.plan.updatingConversation.after }], now: NOW,
  } as any);
  const manifest = await sync.buildManifestDraft([{ kind: "conversation", id: s.upd.id }, { kind: "memory", id: s.M.id }, { kind: "memory", id: s.plan.newMemory.id }]);
  const report = await sync.dryRun(manifest, s.vault.root(), () => NOW);
  assert.equal(report.ok, true, JSON.stringify([report.violations, report.preflight.checks.filter((c) => !c.pass)]));
  const vaultBackup = await sync.verifyVaultBackup(s.vault.copy().root(), s.vault.root(), report);
  const recordBackup = await sync.verifyRecordBackup(await sync.exportRecordBackup(report), report);
  const res = await sync.executeSync({ manifest, root: s.vault.root(), report, vaultBackup, recordBackup, confirm: "SYNC 3", now: () => NOW });
  assert.equal(res.ok, true, JSON.stringify(res.refused ?? res.stoppedAt ?? res.verification));
  s.vault.put(CREATED, "a file created by the operation");     // pre-state: absent
  const expectation: import("./restoreEngine").RestoreExpectation = { vaultFiles: {}, records: {}, updatedAts: {} };
  // What the operation is accepted to have produced = what the maintenance code READ BACK right after its own sync (a "receipt"), never the
  // dry-run prediction and never "whatever is there at restore time". A receipt is recorded only if the sync itself reports the file as
  // written as planned AND the real content equals the prediction apart from the two known volatile fields (Registry mtime, History-meta updatedAt).
  const progress = new Map<string, string>(res.fileProgress.map((p) => [p.path, p.state] as [string, string]));
  for (const f of report.files) {
    assert.equal(progress.get(f.path), "written-as-planned", `${f.path}: the sync did not report this file as written as planned`);
    const actual = await guardMod.readTextOrNull(s.vault.root(), f.path);
    assert.notEqual(actual, null, `${f.path} must exist after the sync`);
    assert.equal(invMod.normalizeForActualComparison(f.path, actual!), invMod.normalizeForActualComparison(f.path, f.after), `${f.path}: real content differs from the prediction beyond the known volatile fields`);
    const h = await hashMod.sha256Hex(actual!);
    if (h !== (s.rp.vault.files[f.path]?.hash ?? null)) expectation.vaultFiles[f.path] = [h];   // a file the sync left byte-identical needs no allowance
  }
  expectation.vaultFiles[CREATED] = [await hashMod.sha256Hex("a file created by the operation")];
  for (const [kind, id] of [["memory", s.M.id], ["memory", s.plan.newMemory.id], ["conversation", s.upd.id]] as const) {
    const rec: any = kind === "memory" ? await dbm.getMemoryObject(id) : await dbm.getConversation(id);
    expectation.records[`${kind}:${id}`] = [await hashMod.hashRecord(rec)]; expectation.updatedAts[id] = [rec.updatedAt];
  }
  return { report, expectation };
}
const noWrites = async (s: Scenario, fn: () => Promise<unknown>) => {
  const vb = JSON.stringify(s.vault.snapshot()), wc = s.vault.writeCount, d = await digest();
  await fn();
  assert.equal(JSON.stringify(s.vault.snapshot()), vb, "Vault files unchanged"); assert.equal(s.vault.writeCount, wc, "no Vault write"); assert.equal(await digest(), d, "IndexedDB unchanged");
};
const mutate = (vault: FakeVault, p: string, f: (c: string) => string) => vault.put(p, f(vault.files.get(p)!.content));

test("scope: every IndexedDB record and Vault file the repair + real sync changed is enumerated in the restore point", async () => {
  const s = await scenario();
  const { report } = await operate(s);
  const scopePaths = new Set(s.scope.vaultPaths);
  for (const f of report.files) assert.ok(scopePaths.has(f.path), `sync would change ${f.path}, which the restore point does not cover`);
  assert.ok(s.scope.memoryIds.includes(s.M.id) && s.scope.memoryIds.includes(s.plan.newMemory.id) && s.scope.conversationIds.includes(s.upd.id));
  assert.ok(s.scope.outboxIds.includes(`memory:${s.M.id}`) && s.scope.outboxIds.includes(`reflection:${s.M.id}`) && s.scope.outboxIds.includes(`conversation:${s.upd.id}`));
  assert.ok(s.scope.ledgerKeys.includes(`memory:${s.plan.newMemory.id}`));
  assert.equal(s.scope.settingsKeys.length, 4);
  // the unrelated records are NOT in scope
  assert.ok(!s.scope.outboxIds.includes("memory:OTHER-1") && !s.scope.memoryIds.includes("nb-a"));
});

test("capture -> serialize -> parse is lossless; the summary has no text; a tampered or truncated file is rejected with a fixed code", async () => {
  const s = await scenario();
  const parsed = await rpMod.parseRestorePoint(s.text);
  assert.equal(parsed.ok, true); assert.deepEqual((parsed as any).restorePoint, s.rp);
  assert.equal(JP.test(JSON.stringify(rpMod.summarizeRestorePoint(s.rp))), false);
  assert.ok(s.rp.vault.files[".tsumugi/index.json"] && s.rp.vault.files[CREATED] === null, "existing file captured in full; absent file recorded as absent");
  assert.equal(s.rp.idb.memories[s.plan.newMemory.id], null);
  assert.equal(s.rp.vaultId, "vault-restore-1");
  const code = async (mutateFn: (j: any) => void) => { const j = JSON.parse(s.text); mutateFn(j); const r = await rpMod.parseRestorePoint(JSON.stringify(j)); return r.ok ? "ok" : r.error; };
  assert.equal(await code((j) => { j.vault.files[".tsumugi/index.json"].content += " "; }), "file-hash");
  assert.equal(await code((j) => { j.contentHash = "0".repeat(64); }), "content-hash");
  assert.equal(await code((j) => { j.idb.memories[s.M.id].summary = "changed"; }), "content-hash");
  assert.equal(await code((j) => { delete j.idb.outbox[s.scope.outboxIds[0]]; }), "scope-not-covered");
  assert.equal(await code((j) => { j.schema = 2; }), "wrong-format-or-schema");
  assert.equal(await code((j) => { j.vault.dirs = "x"; }), "vault");
  assert.equal((await rpMod.parseRestorePoint(s.text.slice(0, s.text.length - 5))).ok, false);
  const bad = await rpMod.parseRestorePoint("{ secret-text " + JP.source);
  assert.deepEqual(bad, { ok: false, error: "not-json" });
});

test("receipt gate: a repair may start only after the saved file was READ BACK identical and the round trip is a no-op against the current state", async () => {
  const s = await scenario();
  const bad = await engine.createReadBackReceipt(s.text, s.text.replace("tsumugi-restore-point", "tsumugi-restore-pointX"), s.env);
  assert.deepEqual(bad, { ok: false, reason: "read-back-differs" });
  const trunc = await engine.createReadBackReceipt(s.text.slice(0, -3), s.text.slice(0, -3), s.env);
  assert.equal(trunc.ok, false);
  const good = await engine.createReadBackReceipt(s.text, s.text, s.env, () => NOW);
  assert.equal(good.ok, true);
  const receipt = (good as any).receipt as import("./restoreEngine").ReadBackReceipt;
  await engine.assertRestorePointReady(receipt, s.env);                                   // genuine receipt + unchanged world: passes
  const forged = { contentHash: receipt.contentHash, restorePoint: receipt.restorePoint, verifiedAt: NOW };
  await assert.rejects(engine.assertRestorePointReady(forged, s.env), (e: any) => e?.name === "RestorePointNotReadyError" && e.code === "receipt-not-issued");
  // the world moved after the capture (any scope file): no receipt, and an existing receipt stops being valid
  mutate(s.vault, ".tsumugi/index.json", (c) => c + " ");
  assert.equal((await engine.createReadBackReceipt(s.text, s.text, s.env)).ok, false);
  await assert.rejects(engine.assertRestorePointReady(receipt, s.env), (e: any) => e?.name === "RestorePointNotReadyError" && /^world-changed:/.test(e.code));
});

test("the receipt is also refused when the round trip meets a different state in IndexedDB or a different Vault", async () => {
  const s = await scenario();
  const other = new FakeVault(); other.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "another" }));
  const r = await engine.createReadBackReceipt(s.text, s.text, { idb: s.env.idb, root: other.root() });
  assert.equal(r.ok, false);
  await dbm.putVaultOutboxEntry({ id: "memory:OTHER-2", recordType: "memory", recordId: "OTHER-2", recordUpdatedAt: "y", steps: {}, attempt: { count: 1, lastError: null, lastAttemptAt: "x" }, status: "pending", heldReason: null, createdAt: "c", updatedAt: "u" } as any);
  const r2 = await engine.createReadBackReceipt(s.text, s.text, s.env);
  assert.equal(r2.ok, false, "an extra Outbox entry since the capture is collateral");
});

test("strict restore: repair + real Vault sync, then ONE restore brings IndexedDB and the Vault back byte-identical; dry-run writes nothing; re-run is a no-op", async () => {
  const s = await scenario();
  const { expectation } = await operate(s);
  assert.notEqual(await digest(), s.preDigest, "the operation really changed IndexedDB");
  assert.notEqual(JSON.stringify(s.vault.snapshot()), s.preSnapshot, "and the Vault");
  assert.ok(await dbm.getMemoryObject(s.plan.newMemory.id), "new Memory exists after the operation");
  let plan!: import("./restoreEngine").RestorePlan;
  await noWrites(s, async () => { plan = await engine.planRestore(s.rp, expectation, s.env); });
  assert.equal(plan.status, "restorable", JSON.stringify(plan.stopReasons));
  assert.ok(plan.vault.some((v) => v.action === "delete" && v.path === CREATED) && plan.vault.some((v) => v.action === "write"));
  assert.equal(JP.test(JSON.stringify({ ...plan, work: undefined })), false, "the plan lists codes and paths only");
  const rep = await engine.executeRestore(s.rp, expectation, s.env);
  assert.equal(rep.status, "restored", JSON.stringify([rep.failure, rep.plan.stopReasons, rep.verification?.stopReasons]));
  assert.deepEqual(rep.blocked, []);
  assert.ok(rep.vaultDeleted.includes(CREATED));
  assert.equal(JSON.stringify(s.vault.snapshot()), s.preSnapshot, "every Vault file is byte-identical to before the operation (and the created file is gone)");
  assert.equal(await digest(), s.preDigest, "every record, ledger entry and Outbox entry is identical (hash level)");
  assert.equal(await dbm.getMemoryObject(s.plan.newMemory.id), undefined, "the new Memory is removed");
  assert.equal(JSON.stringify(await dbm.getMemoryObject(s.M.id)), JSON.stringify(s.rp.idb.memories[s.M.id]), "byte-identical record JSON");
  assert.equal(JSON.stringify(await dbm.getConversation(s.upd.id)), JSON.stringify(s.rp.idb.conversations[s.upd.id]));
  for (const key of s.scope.settingsKeys) assert.equal((await dbm.readMemoryRepairSettings([key]))[key], undefined, "repair ledger / backup keys removed");
  assert.equal(JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")), s.otherBefore, "the unrelated pending Outbox entry never changed");
  const again = await engine.executeRestore(s.rp, expectation, s.env);
  assert.equal(again.status, "nothing-to-restore", JSON.stringify(again.plan.stopReasons));
  await engine.assertRestorePointReady((await engine.createReadBackReceipt(s.text, s.text, s.env) as any).receipt, s.env);
});

test("CAS: anything that is not the restore point's state or a known post-operation state stops the restore BEFORE any write", async () => {
  const cases: [string, (s: Scenario, e: import("./restoreEngine").RestoreExpectation) => Promise<void>, RegExp][] = [
    ["a scope Vault file edited after the operation", async (s) => { mutate(s.vault, ".tsumugi/index.json", (c) => c + "\n"); }, /^vault-unidentified:\.tsumugi\/index\.json$/],
    ["a half-written (truncated) scope Vault file", async (s, e) => { const p = Object.keys(e.vaultFiles).find((k) => k.startsWith("Memories/"))!; mutate(s.vault, p, (c) => c.slice(0, Math.floor(c.length / 2))); }, /^vault-unidentified:Memories\//],
    ["the created file replaced by someone else's content", async (s) => { s.vault.put(CREATED, "someone else wrote this"); }, new RegExp(`^vault-unidentified:${CREATED.replace(/\./g, "\\.")}$`)],
    ["a scope record changed to a version the operation never produced", async (s) => { await dbm.putMemoryObjectWithOutbox({ ...(await dbm.getMemoryObject(s.M.id))!, summary: "edited later", updatedAt: "2099-01-01T00:00:00.000Z" } as any, "memory"); }, /^record-unidentified:memory:/],
    ["an Outbox entry of a scope record for an unknown version", async (s) => { const e = (await dbm.getVaultOutboxEntry(`memory:${s.plan.newMemory.id}`))!; await dbm.putVaultOutboxEntry({ ...e, recordUpdatedAt: "2099-01-01T00:00:00.000Z" } as any); }, /^outbox-unidentified:/],
    ["a sync-ledger value for an unknown version", async (s) => { await dbm.setVaultSyncState(`memory:${s.M.id}`, "2099-01-01T00:00:00.000Z"); }, /^ledger-unidentified:/],
    ["a different Vault folder", async (s) => { s.vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "another-vault" })); }, /^different-vault$/],
  ];
  for (const [name, change, reason] of cases) {
    const s = await scenario(); const { expectation } = await operate(s);
    await change(s, expectation);
    await noWrites(s, async () => {
      const rep = await engine.executeRestore(s.rp, expectation, s.env);
      assert.equal(rep.status, "stopped", name);
      assert.ok(rep.plan.stopReasons.some((r) => reason.test(r)), `${name}: ${JSON.stringify(rep.plan.stopReasons)}`);
      assert.deepEqual(rep.vaultWritten, []); assert.deepEqual(rep.vaultDeleted, []);
    });
  }
});

test("receipts are exact: a later change to a Registry mtime, to History-meta updatedAt or to a day-file body is detected -> stopped, nothing written", async () => {
  const volatile = (re: RegExp, change: (c: string) => string): [string, (e: import("./restoreEngine").RestoreExpectation) => string, (c: string) => string] =>
    [String(re), (e) => Object.keys(e.vaultFiles).find((p) => re.test(p))!, change];
  const cases = [
    ["Registry shard: only a file entry's mtime", volatile(/^\.tsumugi\/registry\/[0-9a-f]{2}\.json$/, (c) => c.replace(/("mtime":\s*)(\d+)/, (_m, a, b) => a + String(Number(b) + 1)))],
    ["History meta: only updatedAt", volatile(/^\.tsumugi\/history-meta\.json$/, (c) => c.replace(/("updatedAt":\s*")([^"]+)(")/, (_m, a, _b, d) => a + "2099-01-01T00:00:00.000Z" + d))],
    ["day-file body", volatile(/^Memories\/.+\.md$/, (c) => c + "\nan external edit")],
  ] as const;
  for (const [name, [, pick, change]] of cases) {
    const s = await scenario(); const { expectation } = await operate(s);
    const target = pick(expectation);
    assert.ok(target, `${name}: the sync produced a receipt for this kind of file`);
    // control: before the later change the restore is allowed (so the stop below is caused by the change alone)
    const plan0 = await engine.planRestore(s.rp, expectation, s.env);
    assert.equal(plan0.status, "restorable", `${name}: ${JSON.stringify(plan0.stopReasons)}`);
    const before = s.vault.files.get(target)!.content;
    mutate(s.vault, target, change);
    assert.notEqual(s.vault.files.get(target)!.content, before, `${name}: the change really altered the file`);
    await noWrites(s, async () => {
      const rep = await engine.executeRestore(s.rp, expectation, s.env);
      assert.equal(rep.status, "stopped", `${name}: ${JSON.stringify(rep.plan.stopReasons)}`);
      assert.ok(rep.plan.stopReasons.includes(`vault-unidentified:${target}`), `${name}: ${JSON.stringify(rep.plan.stopReasons)}`);
      assert.deepEqual(rep.vaultWritten, []); assert.deepEqual(rep.vaultDeleted, []);
    });
  }
});

test("collateral: a change anywhere outside the enumerated scope stops the restore before any write", async () => {
  const cases: [string, (s: Scenario) => Promise<void>, RegExp][] = [
    ["another Outbox entry", async () => { await dbm.putVaultOutboxEntry({ id: "memory:OTHER-1", recordType: "memory", recordId: "OTHER-1", recordUpdatedAt: "x", steps: {}, attempt: { count: 63, lastError: "x", lastAttemptAt: "y" }, status: "pending", heldReason: null, createdAt: "c", updatedAt: "u2" } as any); }, /^collateral:/],
    ["another Memory", async () => { await dbm.putMemoryObjectWithOutbox({ ...(await dbm.getMemoryObject("nb-a"))!, summary: "touched" } as any, "memory"); }, /^collateral:/],
    ["another Tsumugi Vault file", async (s) => { mutate(s.vault, ".tsumugi/registry-meta.json", (c) => c + " "); }, /^collateral:/],
    ["a file outside Tsumugi's areas", async (s) => { s.vault.put("notes/unrelated.md", "x"); }, /^collateral:/],
  ];
  for (const [name, change, reason] of cases) {
    const s = await scenario(); const { expectation } = await operate(s);
    await change(s);
    await noWrites(s, async () => {
      const rep = await engine.executeRestore(s.rp, expectation, s.env);
      assert.equal(rep.status, "stopped", name);
      assert.ok(rep.plan.stopReasons.some((r) => reason.test(r)), name);
      assert.ok(rep.plan.collateral.length > 0, name);
    });
  }
  // even if the caller overrides the stop, success is never declared while something else differs
  const s = await scenario(); const { expectation } = await operate(s);
  await dbm.putMemoryObjectWithOutbox({ ...(await dbm.getMemoryObject("nb-a"))!, summary: "touched" } as any, "memory");
  const rep = await engine.executeRestore(s.rp, expectation, s.env, { allowCollateral: true });
  assert.equal(rep.status, "verification-failed", JSON.stringify([rep.plan.stopReasons, rep.verification?.stopReasons]));
});

test("interrupted restore: a failed Vault write stops before IndexedDB is touched; re-running resumes and completes (idempotent)", async () => {
  const s = await scenario(); const { expectation, report } = await operate(s);
  const victim = report.files.find((f) => f.before !== null && !f.unchanged)!.path;
  const idbPost = await digest();
  s.vault.failNextWrites(victim, 1);
  const first = await engine.executeRestore(s.rp, expectation, s.env);
  assert.equal(first.status, "vault-incomplete", JSON.stringify([first.failure, first.plan.stopReasons]));
  assert.equal(await digest(), idbPost, "IndexedDB was not touched while the Vault part is incomplete");
  const second = await engine.executeRestore(s.rp, expectation, s.env);
  assert.equal(second.status, "restored", JSON.stringify([second.failure, second.plan.stopReasons]));
  assert.equal(JSON.stringify(s.vault.snapshot()), s.preSnapshot); assert.equal(await digest(), s.preDigest);
});

test("interrupted restore: a failed IndexedDB transaction writes nothing there; the Vault part is already done; re-running completes", async () => {
  const s = await scenario(); const { expectation } = await operate(s);
  const failing = { ...s.env, idb: { ...s.env.idb, commit: async () => { throw new Error("simulated-failure"); } } };
  const first = await engine.executeRestore(s.rp, expectation, failing);
  assert.equal(first.status, "indexeddb-failed", JSON.stringify([first.failure, first.plan.stopReasons]));
  assert.notEqual(await digest(), s.preDigest, "IndexedDB still holds the post-operation state");
  assert.equal(JSON.stringify(s.vault.snapshot()), s.preSnapshot, "the Vault was already restored");
  const second = await engine.executeRestore(s.rp, expectation, s.env);
  assert.equal(second.status, "restored", JSON.stringify([second.failure, second.plan.stopReasons]));
  assert.equal(await digest(), s.preDigest);
});

test("IndexedDB restore transaction is all-or-nothing: one wrong expectation writes nothing", async () => {
  const s = await scenario(); await operate(s);
  const before = await digest();
  const curN = await dbm.getMemoryObject(s.plan.newMemory.id);
  await assert.rejects(dbm.commitMaintenanceRestore({
    memories: [{ id: s.plan.newMemory.id, expectCurrent: curN as any, target: null }, { id: s.M.id, expectCurrent: { not: "the current value" } as any, target: null }],
    conversations: [], outbox: [], syncLedger: [], settings: [],
  }), /restore-precondition-changed/);
  assert.equal(await digest(), before);
  assert.ok(await dbm.getMemoryObject(s.plan.newMemory.id), "the valid entry was not applied either");
});

test("restore guard: only enumerated paths can be written; only enumerated created files / directories can be removed; never recursively", async () => {
  const v = new FakeVault(); v.put("a/keep.md", "k"); v.put("a/rewrite.md", "r"); v.put("a/created.md", "c");
  const guard = new guardMod.RestoreGuard(v.root(), { writable: new Set(["a/rewrite.md"]), removableFiles: new Set(["a/created.md"]), removableDirs: new Set() });
  const root = guard.root();
  await guardMod.writeText(root, "a/rewrite.md", "r2");
  await assert.rejects(guardMod.writeText(root, "a/keep.md", "x"), /restore-guard/);
  await assert.rejects(guardMod.writeText(root, "a/new.md", "x"), /restore-guard/);
  await assert.rejects(guardMod.removeFile(root, "a/keep.md"), /restore-guard/);
  await assert.rejects(guardMod.removeFile(root, "a/rewrite.md"), /restore-guard/);
  await assert.rejects((async () => { const d = await root.getDirectoryHandle("a"); await (d as any).removeEntry("created.md", { recursive: true }); })(), /restore-guard/);
  await guardMod.removeFile(root, "a/created.md");
  assert.equal(v.files.get("a/keep.md")!.content, "k"); assert.equal(v.files.get("a/rewrite.md")!.content, "r2"); assert.equal(v.files.has("a/created.md"), false);
  assert.deepEqual(guard.written, ["a/rewrite.md"]); assert.deepEqual(guard.removed, ["a/created.md"]);
  assert.ok(guard.blocked.length >= 5);
  assert.equal(await guardMod.readTextOrNull(v.root(), "a/created.md"), null);
  assert.equal(await guardMod.readTextOrNull(v.root(), "nope/x.md"), null);
});

test("no logging / network / storage in the restore modules; only the repair session imports them (no screen, startup, Capture or Connect); errors carry codes only", async () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const files = ["lib/maintenance/restorePoint.ts", "lib/maintenance/restoreEngine.ts", "lib/maintenance/restoreGuard.ts", "lib/maintenance/crashRecovery.ts"];
  for (const f of files) {
    const code = strip(fs.readFileSync(path.join(SRC, f), "utf8"));
    assert.equal(/console\.|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|document\.cookie|\beval\(|new Function/.test(code), false, f);
  }
  const walk = (d: string, out: string[] = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p); } return out; };
  const importers = walk(SRC).filter((p) => !/restore(Point|Engine|Guard)\.ts$|\.test\.ts$/.test(p)).filter((p) => /\/restore(Point|Engine|Guard)["']/.test(fs.readFileSync(p, "utf8")));
  assert.deepEqual(importers.map((p) => path.relative(SRC, p)).sort(), ["lib/maintenance/crashRecovery.ts", "lib/maintenance/repairSession.ts"], "only the single-item repair session and the crash recovery use the restore modules");
  const s = await scenario();
  const errs: string[] = [];
  for (const t of ["{ nope " + JP.source, JSON.stringify({ ...JSON.parse(s.text), contentHash: "x" })]) { const r = await rpMod.parseRestorePoint(t); if (!r.ok) errs.push(r.error); }
  try { await rpMod.captureRestorePoint(s.scope, { idb: { ...s.env.idb, getMemory: async () => { throw new Error("secret " + JP.source); } }, root: s.env.root }); } catch (e: any) { errs.push(e.message); }
  assert.equal(errs.length, 3); assert.equal(JP.test(errs.join("|")), false);
});
