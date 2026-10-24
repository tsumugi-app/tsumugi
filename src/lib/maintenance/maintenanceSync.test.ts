/**
 * Scoped Vault sync on a fake IndexedDB + fake Vault: preflight, dry run (zero real writes), non-target invariants, backup gate,
 * fingerprint binding, execution, post-write verification, partial-state detection. Run: `npm run test:maintenance`.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..", "..");
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
const manifestMod = require(path.join(OUT, "lib/maintenance/manifest.js")) as typeof import("./manifest");
const lockMod = require(path.join(OUT, "lib/vaultWorldLock.js")) as typeof import("../vaultWorldLock");
const repair = require(path.join(OUT, "lib/memoryContaminationRepair.js")) as typeof import("../memoryContaminationRepair");
const fx = require(path.join(OUT, "lib/memoryRepairTestWorld.js")) as typeof import("../memoryRepairTestWorld");

const NOW = "2026-10-10T00:00:00.000Z";
const R1 = fx.D.repair.items[0];
const JP = /[぀-ヿ一-鿿]/;

const testSupport = require(path.join(OUT, "lib/maintenance/testSupport.js")) as typeof import("./testSupport");
const FakeVault = testSupport.FakeVault;
type FakeVault = import("./testSupport").FakeVault;
const locks = testSupport.installFakeLocks();

async function resetDb() {
  // the fake IndexedDB is shared by all tests of this file: start every world from an empty database
  await dbm.clearMemoryData(); await dbm.clearVaultSyncState();
  for (const e of [...await dbm.getPendingVaultOutboxEntries(), ...await dbm.getHeldVaultOutboxEntries(), ...await dbm.getDoneVaultOutboxEntries()]) await dbm.deleteVaultOutboxEntry(e.id);
}
async function world(opts: { legacyV1HistoryDay?: boolean } = {}) {
  await resetDb();
  const w = fx.world();
  const vault = new FakeVault();
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "vault-maint-1", createdAt: "x" }));
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  const ident = { id: "current", vaultId: "vault-maint-1", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: NOW, pendingCandidateVaultId: null, updatedAt: NOW };
  await dbm.putVaultIdentityRecord(ident as any);
  await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
  const orig = w.conversations.find((c) => c.id === R1.originalConversationId)!, upd = w.conversations.find((c) => c.id === R1.updatingConversationId)!, M = w.memories.find((m) => m.id === R1.memoryId)!;
  // non-target neighbours: same day-file as M, same day-file as the new Memory, same History months, same registry buckets (by construction of the day keys)
  const T0 = fx.T0, DAY2 = "2026-08-21T00:00:00.000Z";
  // production members always carry metadata.sourceType (Capture sets it); without it parse -> serialize is not a fixed point
  const withType = (m: any) => ({ ...m, metadata: { ...m.metadata, sourceType: "chat" } });
  const neighbours = [
    fx.mem("nb-a", "nb-conv-a", "近所の別の要約A", "別の内容A", T0, { date: T0, createdAt: "2026-08-20T00:00:01.000Z" }),
    fx.mem("nb-b", "nb-conv-b", "近所の別の要約B", "別の内容B", T0, { date: T0, createdAt: "2026-08-20T00:00:02.000Z" }),
    fx.mem("nb-c", "nb-conv-c", "翌日の別の要約C", "別の内容C", T0, { date: DAY2, createdAt: "2026-08-21T00:00:01.000Z" }),
    fx.mem("nb-d", "nb-conv-d", "翌日の別の要約D", "別の内容D", T0, { date: DAY2, createdAt: "2026-08-21T00:00:02.000Z" }),
  ].map(withType);
  const nbConv = fx.conv("nb-conv-c", ["別の会話の発言"], T0, ["nb-c"]);
  const env = { root: vault.root(), vaultIdentity: ident as any, now: () => NOW };
  const seed: any[] = [];
  for (const c of [orig, upd, nbConv]) seed.push(["conversation", await dbm.putConversationWithOutbox(c as any)]);
  for (const m of [...neighbours, withType(M)]) seed.push(["memory", await dbm.putMemoryObjectWithOutbox(m as any, "memory")]);
  for (const [kind, entry] of seed) { const r = kind === "conversation" ? await proj.reconcileConversationOutboxEntry(env, entry) : await proj.reconcileMemoryOutboxEntry(env, entry); assert.equal(r.status, "done", kind + JSON.stringify(r)); }
  if (opts.legacyV1HistoryDay) {
    const p = ".tsumugi/history/2026-08.json"; const m = JSON.parse(vault.files.get(p)!.content);
    m.days["2026-08-21"] = { conversationIds: [upd.id, "nb-conv-c"], normalMemoryCount: 2, reflectionIds: [], memoryCount: 2 };
    vault.put(p, JSON.stringify(m, null, 2));
  }
  const plan: any = await repair.planRepairItem(R1, w, NOW, fx.D.repair.updating);
  assert.equal(plan.status, "READY");
  await dbm.putMemoryObjectWithOutbox(plan.restoredAfter, "memory"); await dbm.putMemoryObjectWithOutbox(plan.newMemory, "memory"); await dbm.putConversationWithOutbox(plan.updatingConversation.after);
  // unrelated pending Outbox entry (stand-in for the 6 real ones)
  await dbm.putVaultOutboxEntry({ id: "memory:OTHER-1", recordType: "memory", recordId: "OTHER-1", recordUpdatedAt: "x", steps: {}, attempt: { count: 62, lastError: "verify-history-mismatch", lastAttemptAt: "x" }, status: "pending", heldReason: null, createdAt: "c", updatedAt: "u" } as any);
  const manifest = await sync.buildManifestDraft([{ kind: "conversation", id: upd.id }, { kind: "memory", id: M.id }, { kind: "memory", id: plan.newMemory.id }]);
  return { vault, manifest, plan, ids: { conv: upd.id, mem: M.id, neu: plan.newMemory.id } };
}
async function backups(vault: FakeVault, report: any) {
  const vaultBackup = await sync.verifyVaultBackup(vault.copy().root(), vault.root(), report);
  const recordBackup = await sync.verifyRecordBackup(await sync.exportRecordBackup(report), report);
  return { vaultBackup, recordBackup };
}
const digest = async () => [...(await sync.idbSnapshot()).entries()].sort().map(([k, v]) => `${k}=${v}`).join("\n");

test("manifest: strict parsing, IDs + hashes only", () => {
  const good = { format: "tsumugi-maintenance-manifest", schema: 1, scope: "vault-sync", vaultId: "v", records: [{ kind: "memory", id: "m", expectedUpdatedAt: "t", canonicalHash: "a".repeat(64) }] };
  assert.equal(manifestMod.parseManifest(JSON.stringify(good)).ok, true);
  for (const bad of [{ ...good, scope: "repair" }, { ...good, records: [] }, { ...good, records: [{ ...good.records[0], canonicalHash: "xyz" }] }, { ...good, records: [good.records[0], good.records[0]] }, { ...good, records: Array.from({ length: 21 }, (_, i) => ({ ...good.records[0], id: "m" + i })) }, { ...good, vaultId: "" }])
    assert.equal(manifestMod.parseManifest(JSON.stringify(bad)).ok, false);
  assert.deepEqual(manifestMod.parseManifest("{ nope secret-text"), { ok: false, error: "not-json" });
});

test("preflight + dry run on a consistent world: CLEAN, zero real writes (Vault files, IndexedDB, ledger), no text in the report", async () => {
  const w = await world();
  const vaultBefore = JSON.stringify(w.vault.snapshot()), idbBefore = await digest(), writes = w.vault.writeCount;
  const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW);
  assert.equal(report.ok, true, JSON.stringify([report.violations, report.preflight.checks.filter((c) => !c.pass), report.writers, report.projection]));
  assert.deepEqual(report.violations, []);
  assert.ok(report.files.length >= 5);
  assert.equal(w.vault.writeCount, writes); assert.equal(JSON.stringify(w.vault.snapshot()), vaultBefore); assert.equal(await digest(), idbBefore, "IndexedDB (records, ledger, Outbox) untouched by the dry run");
  const targets = [w.ids.conv, w.ids.mem, w.ids.neu];
  for (const id of targets) assert.notEqual(await dbm.getVaultSyncState((id === w.ids.conv ? "conversation:" : "memory:") + id), (await (id === w.ids.conv ? dbm.getConversation(id) : dbm.getMemoryObject(id)))!.updatedAt, "ledger must NOT be marked by a dry run");
  const printable = JSON.stringify({ writers: report.writers, projection: report.projection, files: report.files.map((f) => f.path), violations: report.violations, checks: report.preflight.checks });
  assert.equal(JP.test(printable), false);
});

test("execute: refused without verified backups / confirmation phrase / clean dry run", async () => {
  const w = await world(); const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW); const b = await backups(w.vault, report);
  const vb = JSON.stringify(w.vault.snapshot()), idb = await digest();
  const run = (o: any) => sync.executeSync({ manifest: w.manifest, root: w.vault.root(), report, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup, confirm: "SYNC 3", now: () => NOW, ...o });
  assert.equal((await run({ vaultBackup: null })).refused, "backup-not-verified-for-this-dry-run");
  assert.equal((await run({ recordBackup: null })).refused, "backup-not-verified-for-this-dry-run");
  assert.equal((await run({ confirm: "SYNC 2" })).refused, "confirmation-phrase");
  assert.equal((await run({ confirm: "" })).refused, "confirmation-phrase");
  assert.equal((await run({ report: { ...report, ok: false } })).refused, "dry-run-not-clean");
  assert.equal((await run({ vaultBackup: { ...b.vaultBackup, forFingerprint: "other" } })).refused, "backup-not-verified-for-this-dry-run");
  w.vault.perm.readwrite = "prompt";
  assert.equal((await run({})).refused, "vault-write-permission-not-granted");
  assert.equal(JSON.stringify(w.vault.snapshot()), vb); assert.equal(await digest(), idb);
});

test("backup verification: the Vault copy must be the same Vault and byte-identical for every file about to change; the record backup must match", async () => {
  const w = await world(); const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW);
  const good = w.vault.copy();
  assert.equal((await sync.verifyVaultBackup(good.root(), w.vault.root(), report)).ok, true);
  const missing = w.vault.copy(); const victim = report.files.find((f) => f.before !== null)!.path; missing.files.delete(victim);
  assert.ok((await sync.verifyVaultBackup(missing.root(), w.vault.root(), report)).problems.includes("backup-missing:" + victim));
  const differ = w.vault.copy(); differ.put(victim, differ.files.get(victim)!.content + "x");
  assert.ok((await sync.verifyVaultBackup(differ.root(), w.vault.root(), report)).problems.includes("backup-differs:" + victim));
  const other = w.vault.copy(); other.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "another" }));
  assert.ok((await sync.verifyVaultBackup(other.root(), w.vault.root(), report)).problems.includes("backup-vault-identity-mismatch"));
  const file = await sync.exportRecordBackup(report);
  assert.equal((await sync.verifyRecordBackup(file, report)).ok, true);
  assert.equal((await sync.verifyRecordBackup("{ broken", report)).ok, false);
  const tampered = JSON.parse(file); tampered.records[0].record.updatedAt = "1999"; assert.equal((await sync.verifyRecordBackup(JSON.stringify(tampered), report)).ok, false);
  const wrongRun = JSON.parse(file); wrongRun.fingerprint = "zzz"; assert.ok((await sync.verifyRecordBackup(JSON.stringify(wrongRun), report)).problems.includes("backup-file-is-for-another-dry-run"));
});

test("execute: happy path writes exactly the planned files; every non-target byte and IndexedDB record is untouched; states verified", async () => {
  const w = await world(); const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW); const b = await backups(w.vault, report);
  const vaultBefore = w.vault.snapshot(); const idbBefore = await sync.idbSnapshot();
  const otherOutbox = JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1"));
  const r = await sync.executeSync({ manifest: w.manifest, root: w.vault.root(), report, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup, confirm: "SYNC 3", now: () => NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.verification, { predictedVsActual: [], invariantViolations: [], idbCollateral: [], canonicalChanged: [], unexpectedCreated: [], unexpectedChanged: [], unexpectedDeleted: [], blockedWrites: [] });
  assert.ok(r.states.every((s) => s.vaultMatchesCanonical === true && s.ledgerSynced && s.outbox === "done"), JSON.stringify(r.states));
  const changed = Object.entries(w.vault.snapshot()).filter(([p, c]) => vaultBefore[p] !== c).map(([p]) => p).sort();
  const created = Object.keys(w.vault.snapshot()).filter((p) => !(p in vaultBefore));
  assert.deepEqual([...changed].sort(), report.files.filter((f) => !f.unchanged).map((f) => f.path).sort(), "changed files == dry-run plan (rewrites that end identical are listed as unchanged)");
  assert.ok(created.every((p) => report.files.find((f) => f.path === p)?.before === null));
  assert.ok(r.fileProgress.every((f) => f.state === "written-as-planned" || f.state === "not-written"), JSON.stringify(r.fileProgress));
  // neighbours of the same day-file / History month are byte-identical as members
  const dayFile = w.vault.snapshot()["Memories/2026-08-21.md"]; assert.ok(dayFile.includes("nb-c") && dayFile.includes("nb-d"));
  assert.equal(JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")), otherOutbox, "pre-existing pending Outbox entry untouched");
  const idbAfter = await sync.idbSnapshot();
  const diff = [...new Set([...idbBefore.keys(), ...idbAfter.keys()])].filter((k) => idbBefore.get(k) !== idbAfter.get(k)).sort();
  assert.deepEqual(diff, [`ledger:conversation:${w.ids.conv}`, `ledger:memory:${w.ids.mem}`, `ledger:memory:${w.ids.neu}`, `outbox:conversation:${w.ids.conv}`, `outbox:memory:${w.ids.mem}`, `outbox:memory:${w.ids.neu}`].sort());
  // idempotent: nothing left to sync
  const again = await sync.dryRun(w.manifest, w.vault.root(), () => NOW);
  assert.equal(again.ok, false); assert.ok(again.preflight.checks.some((c) => c.code.startsWith("ledger-needs-sync") && !c.pass));
});

test("data changed after the dry run (even a non-target record) => execution refused, nothing written", async () => {
  const w = await world(); const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW); const b = await backups(w.vault, report);
  const nb = (await dbm.getMemoryObject("nb-a"))!; await dbm.putMemoryObject({ ...nb, updatedAt: "2026-10-09T00:00:00.000Z" });
  const vb = JSON.stringify(w.vault.snapshot());
  const r = await sync.executeSync({ manifest: w.manifest, root: w.vault.root(), report, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup, confirm: "SYNC 3", now: () => NOW });
  assert.equal(r.refused, "data-changed-since-dry-run"); assert.equal(JSON.stringify(w.vault.snapshot()), vb);
  // a Vault file edited after the dry run also refuses
  const w2 = await world(); const rep2 = await sync.dryRun(w2.manifest, w2.vault.root(), () => NOW); const b2 = await backups(w2.vault, rep2);
  const p = rep2.files.find((f) => f.before !== null && f.path.startsWith("Memories/"))!.path; w2.vault.put(p, w2.vault.files.get(p)!.content + "\n");
  const r2 = await sync.executeSync({ manifest: w2.manifest, root: w2.vault.root(), report: rep2, vaultBackup: b2.vaultBackup, recordBackup: b2.recordBackup, confirm: "SYNC 3", now: () => NOW });
  assert.equal(r2.refused, "data-changed-since-dry-run");
});

test("non-target drift in the Vault (an existing member the writer would re-serialize) => dry run NOT CLEAN with a violation, execution impossible", async () => {
  const w = await world();
  const p = "Memories/2026-08-21.md"; const raw = w.vault.files.get(p)!.content;
  w.vault.put(p, raw.replace("翌日の別の要約C", "翌日の別の要約C ")); // an externally edited neighbour (one trailing space)
  // keep the Registry consistent with the edited file so only the writer's behaviour is under test
  const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW);
  assert.equal(report.ok, false);
  assert.ok(report.violations.length > 0 || report.writers.some((x) => x.status !== "would-write"), JSON.stringify([report.violations, report.writers]));
  const b = await backups(w.vault, report);
  const r = await sync.executeSync({ manifest: w.manifest, root: w.vault.root(), report, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup, confirm: "SYNC 3", now: () => NOW });
  assert.equal(r.refused, "dry-run-not-clean");
});

test("legacy (v1) History day: the Vault is correct, the Outbox entry stays pending => warning, not a violation", async () => {
  const w = await world({ legacyV1HistoryDay: true });
  const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW);
  assert.deepEqual(report.violations, [], JSON.stringify(report.violations));
  assert.equal(report.ok, true); assert.ok(report.warnings.some((x) => /legacy format/.test(x)));
  assert.ok(report.files.every((f) => f.path !== ".tsumugi/history/2026-08.json" || f.after.includes("normalMemoryCount")), "the v1 day stays v1");
});

test("failure mid-run (writer error): stops, shows exactly what was written, touches nothing else; a re-run of the remainder completes", async () => {
  const w = await world(); const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW); const b = await backups(w.vault, report);
  w.vault.writeShouldFail.add("Memories/2026-08-21.md"); // the new Memory's day-file
  const r = await sync.executeSync({ manifest: w.manifest, root: w.vault.root(), report, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup, confirm: "SYNC 3", now: () => NOW });
  assert.equal(r.ok, false); if (process.env.SHOW) process.stderr.write(JSON.stringify(r) + "\n"); assert.ok(r.stoppedAt, JSON.stringify(r.steps));
  const done = r.steps.filter((s) => s.writer === "written").map((s) => s.id);
  assert.ok(done.length >= 1 && done.length < 3, JSON.stringify(r.steps));
  assert.ok(r.steps.some((s) => s.writer.startsWith("error:")));
  assert.ok(r.diagnosis.some((d) => d.status !== "ok"), "the diagnosis names what is out of step");
  const synced = r.states.filter((s) => s.ledgerSynced).map((s) => s.id);
  assert.deepEqual(synced.sort(), done.sort(), "ledger is set exactly for the records that were written");
  assert.deepEqual(r.verification.idbCollateral, []); assert.deepEqual(r.verification.canonicalChanged, []);
  assert.equal(JSON.stringify(await dbm.getVaultOutboxEntry("memory:OTHER-1")).includes("verify-history-mismatch"), true);
  // standalone inspection shows the same half-finished state
  const states = await sync.inspectStates(w.manifest, w.vault.root());
  assert.deepEqual(states.filter((s) => s.ledgerSynced).map((s) => s.id).sort(), done.sort());
  // fix the cause and sync only the remainder
  w.vault.writeShouldFail.clear();
  const rest = await sync.buildManifestDraft(r.states.filter((s) => !s.ledgerSynced).map((s) => ({ kind: s.kind as "conversation" | "memory", id: s.id })));
  const rep2 = await sync.dryRun(rest, w.vault.root(), () => NOW); assert.equal(rep2.ok, true, JSON.stringify([rep2.violations, rep2.preflight.checks.filter((c) => !c.pass)]));
  const b2 = await backups(w.vault, rep2);
  const r2 = await sync.executeSync({ manifest: rest, root: w.vault.root(), report: rep2, vaultBackup: b2.vaultBackup, recordBackup: b2.recordBackup, confirm: `SYNC ${rest.records.length}`, now: () => NOW });
  assert.equal(r2.ok, true, JSON.stringify(r2));
});

test("preflight failures: wrong vault id, changed record, missing Outbox entry, Reflection, identity mismatch of the folder", async () => {
  const w = await world();
  const wrongVault = { ...w.manifest, vaultId: "other" };
  assert.ok((await sync.preflight(wrongVault, w.vault.root())).checks.some((c) => c.code === "manifest-vault-matches-indexeddb" && !c.pass));
  const stale = { ...w.manifest, records: w.manifest.records.map((r, i) => (i === 1 ? { ...r, canonicalHash: "0".repeat(64) } : r)) };
  assert.ok((await sync.preflight(stale, w.vault.root())).checks.some((c) => c.code.startsWith("canonical-hash-as-reviewed") && !c.pass));
  const gone = { ...w.manifest, records: [...w.manifest.records, { kind: "memory" as const, id: "does-not-exist", expectedUpdatedAt: "x", canonicalHash: "1".repeat(64) }] };
  assert.ok((await sync.preflight(gone, w.vault.root())).checks.some((c) => c.code.startsWith("record-exists") && !c.pass));
  w.vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "someone-else" }));
  const pf = await sync.preflight(w.manifest, w.vault.root());
  assert.ok(pf.checks.some((c) => c.code === "vault-folder-identity-matches" && !c.pass));
  const dr = await sync.dryRun(w.manifest, w.vault.root(), () => NOW); assert.equal(dr.ok, false); assert.deepEqual(dr.files, []);
});

// ---------------------------------------------------------------- M1: exclusive world lock
const WORLD = "tsumugi-vault-world";
async function ready() {
  const w = await world(); const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW); const b = await backups(w.vault, report);
  const run = (o: any = {}) => sync.executeSync({ manifest: w.manifest, root: w.vault.root(), report, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup, confirm: "SYNC 3", now: () => NOW, lockTimeoutMs: 80, ...o });
  return { w, report, b, run };
}

test("M1: another tab holding the Vault-world lock (shared OR exclusive) => safe refusal after the timeout, nothing written; works once released", async () => {
  for (const mode of ["shared", "exclusive"] as const) {
    const { w, run } = await ready();
    const vb = JSON.stringify(w.vault.snapshot()), idb = await digest();
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    const other = locks.request(WORLD, { mode }, () => held);
    await new Promise((r) => setTimeout(r, 5));
    const r = await run();
    assert.equal(r.refused, "vault-world-lock-unavailable-another-tab-or-unsupported-browser", mode);
    assert.equal(JSON.stringify(w.vault.snapshot()), vb); assert.equal(await digest(), idb);
    release(); await other;
    const ok = await run({ lockTimeoutMs: 2000 });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  }
});

test("M1: a Vault operation of another tab that is already running is waited for; operations that arrive during the sync wait until it is complete", async () => {
  const { w, run } = await ready();
  const events: string[] = [];
  let writesAtOp1End = -1, writesAtOp2 = -1;
  let finishOther!: () => void; const otherGate = new Promise<void>((r) => { finishOther = r; });
  const earlier = locks.request(WORLD, { mode: "shared" }, async () => { events.push("other-tab:op-1:start"); await otherGate; writesAtOp1End = w.vault.writeCount; events.push("other-tab:op-1:end"); });
  await new Promise((r) => setTimeout(r, 5));
  const syncP = run({ lockTimeoutMs: 3000 }).then((r) => { events.push("sync:done"); return r; });
  await new Promise((r) => setTimeout(r, 20));
  const later = locks.request(WORLD, { mode: "shared" }, async () => { writesAtOp2 = w.vault.writeCount; events.push("other-tab:op-2"); });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ["other-tab:op-1:start"], "the sync does not start while another tab's operation is in flight, and the later operation queues behind it");
  finishOther(); await earlier;
  const r = await syncP; await later;
  assert.equal(r.ok, true, JSON.stringify(r));
  const total = w.vault.writeCount;
  assert.ok(total > writesAtOp1End, "the sync wrote after the earlier operation had finished");
  assert.equal(writesAtOp2, total, "the later operation of the other tab ran only after ALL of the sync's writes (no interleaving)");
  assert.deepEqual(events.filter((e) => e.startsWith("other-tab")), ["other-tab:op-1:start", "other-tab:op-1:end", "other-tab:op-2"]);
});

test("M1: lock order is deadlock-free (world -> save lock inside writers / around projection -> registry/history); a stale tab epoch is a safe refusal", async () => {
  const { w, run } = await ready();
  const ok = await run({ lockTimeoutMs: 2000 }); assert.equal(ok.ok, true, JSON.stringify(ok));
  const w2 = await ready();
  lockMod.setTabVaultEpoch(7); // another tab switched the Vault: this tab's epoch is stale
  const vb = JSON.stringify(w2.w.vault.snapshot());
  const r = await w2.run({ lockTimeoutMs: 2000 });
  lockMod.setTabVaultEpoch(0);
  assert.equal(r.refused, "stale-vault-tab"); assert.equal(JSON.stringify(w2.w.vault.snapshot()), vb);
  void w;
});

// ---------------------------------------------------------------- M2: unplanned paths
test("M2: a write to a path the dry run did not plan is BLOCKED before it happens; the sync stops and says which path", async () => {
  const { w, report, b, run } = await ready();
  const victim = "Memories/2026-08-21.md";
  const narrowed = { ...report, files: report.files.filter((f) => f.path !== victim) };
  const before = w.vault.snapshot()[victim];
  const r = await run({ report: narrowed, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup });
  assert.equal(r.ok, false); assert.ok(r.stoppedAt);
  assert.ok(r.verification.blockedWrites.some((x) => x.includes(victim)), JSON.stringify(r.verification));
  assert.ok(r.steps.some((s) => s.writer === "error:blocked-unplanned-write"));
  assert.equal(w.vault.snapshot()[victim], before, "the unplanned file is untouched");
  assert.deepEqual(r.verification.unexpectedCreated, []); assert.deepEqual(r.verification.unexpectedChanged, []);
});

test("M2: external create / modify / delete of other files during the sync is reported (whole-folder before/after comparison)", async () => {
  const w = await world();
  w.vault.put("Notes/keep.md", "unrelated note"); w.vault.put("Notes/del.md", "to be deleted"); w.vault.put(".tsumugi/other-state.json", "{}");
  const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW); const b = await backups(w.vault, report);
  let fired = false;
  w.vault.afterWrite = () => { if (fired) return; fired = true; w.vault.put("Notes/created-by-someone.md", "new"); w.vault.put("Notes/keep.md", "unrelated note EDITED"); w.vault.files.delete("Notes/del.md"); w.vault.put(".tsumugi/other-state.json", '{"x":1}'); };
  const r = await sync.executeSync({ manifest: w.manifest, root: w.vault.root(), report, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup, confirm: "SYNC 3", now: () => NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(r.verification.unexpectedCreated, ["Notes/created-by-someone.md"]);
  assert.deepEqual(r.verification.unexpectedChanged.sort(), [".tsumugi/other-state.json", "Notes/keep.md"].sort());
  assert.deepEqual(r.verification.unexpectedDeleted, ["Notes/del.md"]);
});

// ---------------------------------------------------------------- M3: half-finished diagnosis
test("M3: a failure in the middle of a Memory write is diagnosed per file/item (markdown, ledger, Outbox, index, Registry, History)", async () => {
  const { w, report, b, run } = await ready();
  w.vault.failNextWrites(".tsumugi/history/2026-08.json", 1); // the conversation row is unchanged (no write); the new Memory's History write is the next one and fails
  const r = await run({ lockTimeoutMs: 2000 });
  assert.equal(r.ok, false); assert.ok(r.stoppedAt);
  const rows = r.diagnosis.filter((d) => d.id === w.ids.neu);
  const by = (area: string) => rows.filter((d) => d.area === area);
  assert.ok(by("markdown").every((d) => d.status === "ok"), "day-file was written");
  assert.ok(by("index").every((d) => d.status === "ok"), "index was updated before the History step");
  assert.ok(by("history").some((d) => d.status === "missing" || d.status === "mismatch"), JSON.stringify(by("history")));
  assert.ok(by("registry").some((d) => d.status !== "ok"), "Registry is the step after History: it is out of step");
  assert.ok(by("ledger").some((d) => d.status !== "ok"));
  assert.ok(r.diagnosis.filter((d) => d.id === w.ids.conv).every((d) => d.status === "ok" || d.status === "legacy-format"), "the already finished conversation is fully consistent");
  assert.ok(r.fileProgress.some((f) => f.state === "written-as-planned") && r.fileProgress.some((f) => f.state === "not-written" || f.state === "unexpected-content"));
  // the stop changed nothing it was not allowed to
  assert.deepEqual(r.verification.idbCollateral, []); assert.deepEqual(r.verification.canonicalChanged, []);
  // standalone diagnosis gives the same picture and performs no write
  const wc = w.vault.writeCount; const idb = await digest();
  const again = await sync.diagnoseTargets(w.manifest, w.vault.root());
  assert.equal(w.vault.writeCount, wc); assert.equal(await digest(), idb);
  assert.deepEqual(again.map((d) => [d.id, d.area, d.item, d.status]), r.diagnosis.map((d) => [d.id, d.area, d.item, d.status]));
  void report; void b;
});

test("M3: a clean sync diagnoses every item as ok; a legacy (v1) History day is reported as legacy-format, not as a failure", async () => {
  const w = await world({ legacyV1HistoryDay: true });
  const report = await sync.dryRun(w.manifest, w.vault.root(), () => NOW); const b = await backups(w.vault, report);
  const r = await sync.executeSync({ manifest: w.manifest, root: w.vault.root(), report, vaultBackup: b.vaultBackup, recordBackup: b.recordBackup, confirm: "SYNC 3", now: () => NOW, lockTimeoutMs: 2000 });
  assert.equal(r.ok, true, JSON.stringify([r.stoppedAt, r.steps, r.diagnosis.filter((d) => d.status !== "ok")]));
  // the only non-ok rows are the known, accepted consequence of a legacy History day: the Outbox entry stays pending (verify-history-mismatch)
  const rest = r.diagnosis.filter((d) => d.status !== "ok" && d.status !== "legacy-format");
  assert.ok(rest.every((d) => d.area === "outbox" && /status=pending/.test(d.detail)), JSON.stringify(rest));
  assert.ok(r.diagnosis.some((d) => d.area === "history" && d.status === "legacy-format"));
});
