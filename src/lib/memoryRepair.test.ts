/**
 * Contamination repair + Backfill: regression tests (fixed content, atomicity, idempotency, resume, independence).
 * No real IndexedDB / Vault / network: db.ts runs on fakeIdb (same technique as db.foundation.test.ts).
 * Run: `npm run test:memory-repair`.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..");
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

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type RepairEnv = import("./memoryRepairRunner").RepairEnv;
const repair = require(path.join(OUT, "lib/memoryContaminationRepair.js")) as typeof import("./memoryContaminationRepair");
const backfill = require(path.join(OUT, "lib/memoryBackfill.js")) as typeof import("./memoryBackfill");
const runnerRaw = require(path.join(OUT, "lib/memoryRepairRunner.js")) as typeof import("./memoryRepairRunner");
type RepairOpts = { only?: string[]; spec?: import("./memoryContaminationRepair").RepairSpecItem[] };
/** The runner takes its spec as data; every public test runs it against the FICTIONAL data set. */
const runner = {
  runContaminationRepair: (env: RepairEnv, mode: "dry-run" | "execute", o: RepairOpts = {}) => runnerRaw.runContaminationRepair(env, mode, { updating: D.repair.updating, ...o, spec: o.spec ?? D.repair.items }),
  runBackfill: (env: RepairEnv, mode: "dry-run" | "execute", o: { only?: string[] } = {}) => runnerRaw.runBackfill(env, mode, { spec: D.backfill, ...o }),
  verifyContaminationRepair: (env: RepairEnv, o: RepairOpts = {}) => runnerRaw.verifyContaminationRepair(env, { updating: D.repair.updating, ...o, spec: o.spec ?? D.repair.items }),
  rollbackContaminationRepair: (env: RepairEnv, mode: "dry-run" | "execute", o: { only: string[]; spec?: import("./memoryContaminationRepair").RepairSpecItem[] }) => runnerRaw.rollbackContaminationRepair(env, mode, { ...o, spec: o.spec ?? D.repair.items }),
};
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as { __failNextPutOn: (dbName: string, storeName: string) => void; __resetFakeIdbDatabases: () => void };

import { D, NOW, T0, conv, joinKeywords, mem, meta, world } from "./memoryRepairTestWorld";
void T0;

async function freshEnv(seed = world()): Promise<{ env: RepairEnv; db: typeof import("./db"); commits: () => number }> {
  fakeIdbMod.__resetFakeIdbDatabases();
  for (const name of ["lib/db.js", "lib/memoryRepairDbEnv.js"]) delete require.cache[path.join(OUT, name)];
  const db = require(path.join(OUT, "lib/db.js")) as typeof import("./db");
  const dbEnv = require(path.join(OUT, "lib/memoryRepairDbEnv.js")) as typeof import("./memoryRepairDbEnv");
  for (const c of seed.conversations) await db.putConversation(c);
  for (const m of seed.memories) await db.putMemoryObject(m);
  let n = 0; const base = dbEnv.createDbRepairEnv(() => NOW);
  return { env: { ...base, commit: async (t) => { n++; return base.commit(t); } }, db, commits: () => n };
}
async function dump(db: typeof import("./db")): Promise<string> {
  const conversations = await db.getAllConversations(), memories = await db.getAllMemoryObjects();
  const outbox = [...await db.getPendingVaultOutboxEntries(), ...await db.getHeldVaultOutboxEntries(), ...await db.getDoneVaultOutboxEntries()];
  const keys = [...D.repair.items.flatMap((i) => [repair.repairLedgerKey(i.memoryId), repair.repairBackupKey(i.memoryId)]), ...D.backfill.flatMap((i) => [backfill.backfillLedgerKey(i.conversationId), backfill.backfillBackupKey(i.conversationId)])];
  const settings = await db.readMemoryRepairSettings(keys);
  const sort = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => x.id.localeCompare(y.id));
  return JSON.stringify({ c: sort(conversations), m: sort(memories), o: sort(outbox), s: settings });
}

// --------------------------------------------------------------------------- fixed content / grounding

test("spec: 8 items, every referenced updating spec exists, ids are unique and deterministic", async () => {
  assert.equal(D.repair.items.length, 8);
  assert.deepEqual(D.repair.items.map((i) => i.key), ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
  assert.equal(new Set(D.repair.items.map((i) => i.memoryId)).size, 8);
  for (const i of D.repair.items) assert.ok(D.repair.updating[i.updatingConversationId], i.key);
  const a = await repair.updatingMemoryIdFor("conv-a"), b = await repair.updatingMemoryIdFor("conv-b");
  assert.equal(a, await repair.updatingMemoryIdFor("conv-a"));
  assert.notEqual(a, b);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("grounding: evidence must be a verbatim USER turn, keywords must come from the user's own text, no unsaid inference words", () => {
  const c = conv("g", ["車の運転が好き", "家族がいる"], T0);
  const good = { summary: "運転が好き", content: "車の運転が好きだと述べた。", keywords: ["運転"], types: ["conversation" as const], evidence: ["車の運転が好き"] };
  assert.deepEqual(repair.verifyTextGrounding(good, c), []);
  assert.ok(repair.verifyTextGrounding({ ...good, evidence: ["AIの応答: 不安や孤独を感じていますか"] }, c).some((p) => p.code === "evidence-not-verbatim-user-text"), "AI turn text is not evidence");
  assert.ok(repair.verifyTextGrounding({ ...good, keywords: ["運転", "強い愛着"] }, c).some((p) => p.code === "keyword-not-in-user-text"));
  assert.ok(repair.verifyTextGrounding({ ...good, content: "運転に強い愛着がある。" }, c).some((p) => p.code === "inference-term-not-in-user-text"));
  assert.ok(repair.verifyTextGrounding({ ...good, evidence: [] }, c).some((p) => p.code === "no-evidence"));
});

// --------------------------------------------------------------------------- planning (pure)

test("plan: every item is READY on the reviewed corrupted state; original and updating content are both preserved", async () => {
  const w = world();
  const before = JSON.stringify(w);
  const seenNew = new Set<string>();
  for (const item of D.repair.items) {
    const p = await repair.planRepairItem(item, w, NOW, D.repair.updating);
    assert.equal(p.status, "READY", `${item.key}: ${p.status === "HOLD" ? p.reasons.join(";") : ""}`);
    if (p.status !== "READY") continue;
    assert.equal(p.restoredAfter.id, item.memoryId, "restore is in place: same id, nothing deleted");
    assert.equal(p.restoredAfter.conversationId, item.originalConversationId);
    assert.equal(p.restoredAfter.summary, item.restored.summary);
    assert.deepEqual(p.restoredAfter.evidenceQuotes, item.restored.evidence);
    assert.equal(p.restoredAfter.revisitPrompt, undefined, "revisitPrompt was generated from the corrupted text");
    assert.equal(p.before.summary, item.expectedBefore.summary, "before is the untouched snapshot");
    // the updating conversation's information survives as its own Memory (created exactly once per updating conversation)
    assert.equal(p.updatingMemoryId, await repair.updatingMemoryIdFor(item.updatingConversationId));
    if (!seenNew.has(p.updatingMemoryId)) { assert.ok(p.newMemory); seenNew.add(p.updatingMemoryId); assert.equal(p.newMemory!.conversationId, item.updatingConversationId); assert.equal(p.newMemory!.summary, D.repair.updating[item.updatingConversationId].summary); }
    assert.ok(p.updatingConversation!.after.memoryObjectIds.includes(p.updatingMemoryId));
  }
  assert.equal(JSON.stringify(w), before, "planning is pure: the snapshot is never mutated");
});

test("plan: topicId / eventTime / structured claims follow the conversation they came from", async () => {
  const w = world();
  const f = await repair.planRepairItem(D.repair.items.find((i) => i.key === "R6")!, w, NOW, D.repair.updating);
  assert.equal(f.status, "READY");
  if (f.status === "READY") {
    assert.equal(f.restoredAfter.topicId, undefined); assert.equal(f.restoredAfter.eventTime, undefined);
    assert.equal(f.newMemory!.topicId, "topic-R6"); assert.equal(f.newMemory!.eventTime, "2027-03");
  }
  const z = await repair.planRepairItem(D.repair.items.find((i) => i.key === "R7")!, w, NOW, D.repair.updating);
  assert.equal(z.status, "READY");
  if (z.status === "READY") {
    assert.deepEqual((z.restoredAfter.personMentions ?? []).map((m) => m.quote), ["O側の言及"]);
    assert.deepEqual((z.newMemory!.personMentions ?? []).map((m) => m.quote), ["ヤマダさんと久しぶりに電話で話した。"]);
    assert.equal(z.newMemory!.topicId, "topic-R7");
  }
});

test("plan: HOLD (never guess) when the live state is not the reviewed corrupted state", async () => {
  const item = D.repair.items[0];
  const edited = world(); edited.memories.find((m) => m.id === item.memoryId)!.summary = "ユーザーが後から編集した要約";
  const a = await repair.planRepairItem(item, edited, NOW, D.repair.updating); assert.equal(a.status, "HOLD");
  const moved = world(); moved.memories.find((m) => m.id === item.memoryId)!.conversationId = "someone-else";
  assert.equal((await repair.planRepairItem(item, moved, NOW, D.repair.updating)).status, "HOLD");
  const hasOwn = world(); hasOwn.memories.push(mem("OWN", item.updatingConversationId, "別の要約テキスト", "別の内容", NOW));
  assert.equal((await repair.planRepairItem(item, hasOwn, NOW, D.repair.updating)).status, "HOLD");
  const dup = world(); dup.memories.push(mem("DUP", "other-conv", item.restored.summary, "x", NOW));
  const d = await repair.planRepairItem(item, dup, NOW, D.repair.updating); assert.equal(d.status, "HOLD"); assert.ok(d.status === "HOLD" && d.reasons.some((r) => r.startsWith("no-existing-memory-with-restored-content")));
  const missing = world(); missing.conversations = missing.conversations.filter((c) => c.id !== item.updatingConversationId);
  assert.equal((await repair.planRepairItem(item, missing, NOW, D.repair.updating)).status, "HOLD");
  const unlinked = world(); unlinked.conversations.find((c) => c.id === item.originalConversationId)!.memoryObjectIds = [];
  assert.equal((await repair.planRepairItem(item, unlinked, NOW, D.repair.updating)).status, "HOLD");
  const ungrounded = world(); ungrounded.conversations.find((c) => c.id === item.originalConversationId)!.turns = [{ role: "user", content: "全然違う話", timestamp: T0 }];
  assert.equal((await repair.planRepairItem(item, ungrounded, NOW, D.repair.updating)).status, "HOLD");
});

// --------------------------------------------------------------------------- execution on fakeIdb

test("dry-run: previews every item and performs ZERO writes (stores byte-identical, commit never called)", async () => {
  const { env, db, commits } = await freshEnv();
  const before = await dump(db);
  const report = await runner.runContaminationRepair(env, "dry-run");
  assert.equal(report.items.length, 8);
  assert.ok(report.items.every((i) => i.outcome === "would-commit" && i.preview?.restored && i.preview.before), JSON.stringify(report.items.filter((i) => i.outcome !== "would-commit")));
  assert.equal(commits(), 0); assert.equal(report.commits, 0);
  assert.equal(await dump(db), before);
  const bf = await runner.runBackfill(env, "dry-run");
  assert.equal(commits(), 0); assert.equal(await dump(db), before);
  assert.ok(bf.items.every((i) => i.outcome === "hold"), "no backfill conversation exists in this world => HOLD, never a write");
});

test("execute: atomic per item (canonical + Outbox + backup + ledger); bystanders untouched; original is recoverable", async () => {
  const { env, db } = await freshEnv();
  const bystanderBefore = JSON.stringify([await db.getMemoryObject("BYSTANDER-MEM"), await db.getConversation("BYSTANDER-CONV")]);
  const item = D.repair.items.find((i) => i.key === "R8")!;
  const original = await db.getMemoryObject(item.memoryId);
  const report = await runner.runContaminationRepair(env, "execute", { only: ["R8"] });
  assert.equal(report.items[0].outcome, "committed");
  const restored = (await db.getMemoryObject(item.memoryId))!;
  assert.equal(restored.summary, item.restored.summary);
  const newId = await repair.updatingMemoryIdFor(item.updatingConversationId);
  const created = (await db.getMemoryObject(newId))!;
  assert.equal(created.conversationId, item.updatingConversationId);
  assert.ok((await db.getConversation(item.updatingConversationId))!.memoryObjectIds.includes(newId), "reference integrity");
  for (const id of [`memory:${item.memoryId}`, `memory:${newId}`, `conversation:${item.updatingConversationId}`]) {
    const o = await db.getVaultOutboxEntry(id); assert.ok(o && o.status === "pending", `Outbox entry for ${id}`);
  }
  const settings = await db.readMemoryRepairSettings([repair.repairLedgerKey(item.memoryId), repair.repairBackupKey(item.memoryId)]);
  assert.ok(settings[repair.repairLedgerKey(item.memoryId)]);
  const backup = JSON.parse(settings[repair.repairBackupKey(item.memoryId)]!) as { memories: MemoryObject[] };
  assert.deepEqual(backup.memories[0], original, "the pre-repair Memory is kept verbatim in the backup");
  assert.equal(JSON.stringify([await db.getMemoryObject("BYSTANDER-MEM"), await db.getConversation("BYSTANDER-CONV")]), bystanderBefore);
  assert.equal((await db.getMemoryObject(D.repair.items[0].memoryId))!.summary, D.repair.items[0].expectedBefore.summary, "items outside `only` are untouched");
});

test("idempotent: a full run, then a second run => nothing changes, no duplicate Memory, exactly one new Memory per updating conversation", async () => {
  const { env, db, commits } = await freshEnv();
  const first = await runner.runContaminationRepair(env, "execute");
  assert.deepEqual(first.items.map((i) => i.outcome), Array(8).fill("committed"));
  const after = await dump(db);
  const memoriesAfter = (await db.getAllMemoryObjects()).length;
  assert.equal(memoriesAfter, world().memories.length + 7, "7 distinct updating conversations => 7 new Memories (R3 and R4 share one)");
  const c = commits();
  const second = await runner.runContaminationRepair(env, "execute");
  assert.ok(second.items.every((i) => i.outcome === "ledger-done"));
  assert.equal(commits(), c, "no commit attempted on rerun");
  assert.equal(await dump(db), after);
});

test("idempotent even if the ledger were lost: re-planning sees the repaired state and writes nothing", async () => {
  const { env, db } = await freshEnv();
  await runner.runContaminationRepair(env, "execute", { only: ["R1"] });
  const stripped: RepairEnv = { ...env, readSettings: async (keys) => Object.fromEntries(keys.map((k) => [k, undefined])) };
  const rerun = await runner.runContaminationRepair(stripped, "execute", { only: ["R1"] });
  assert.equal(rerun.items[0].outcome, "already-done");
  const same = (await db.getAllMemoryObjects()).filter((m) => m.conversationId === D.repair.items[0].updatingConversationId);
  assert.equal(same.length, 1);
});

test("failure mid-run: the failing item changes NOTHING (atomic), earlier items stay done, later items untouched, rerun resumes", async () => {
  const { env, db } = await freshEnv();
  const flaky: RepairEnv = { ...env, commit: async (t) => { if (t.ledgerKey.endsWith(D.repair.items[1].memoryId)) fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox"); return env.commit(t); } };
    const r1 = await runner.runContaminationRepair(flaky, "execute");
  assert.equal(r1.stoppedOnFailure, true);
  assert.deepEqual(r1.items.map((i) => i.outcome), ["committed", "failed"]);
  const failedItem = D.repair.items[1];
  const m = (await db.getMemoryObject(failedItem.memoryId))!;
  assert.equal(m.summary, failedItem.expectedBefore.summary, "failed item still holds the original (corrupted) Memory: nothing was lost");
  assert.equal(await db.getMemoryObject(await repair.updatingMemoryIdFor(failedItem.updatingConversationId)), undefined);
  assert.equal((await db.readMemoryRepairSettings([repair.repairLedgerKey(failedItem.memoryId), repair.repairBackupKey(failedItem.memoryId)]))[repair.repairLedgerKey(failedItem.memoryId)], undefined);
  for (const later of D.repair.items.slice(2)) assert.equal((await db.getMemoryObject(later.memoryId))!.summary, later.expectedBefore.summary);
  const r2 = await runner.runContaminationRepair(env, "execute");
  assert.deepEqual(r2.items.map((i) => i.outcome), ["ledger-done", ...Array(7).fill("committed")]);
  assert.equal(r2.stoppedOnFailure, false);
});

test("commit guards: a Memory changed between planning and commit aborts the whole item", async () => {
  const { env, db } = await freshEnv();
  const racing: RepairEnv = { ...env, commit: async (t) => { await db.putMemoryObject({ ...t.replaceMemories[0].before, summary: "別のタブで編集された" }); return env.commit(t); } };
  const report = await runner.runContaminationRepair(racing, "execute", { only: ["R5"] });
  assert.equal(report.items[0].outcome, "failed");
  assert.equal(report.items[0].error, "repair-precondition-changed");
  const item = D.repair.items.find((i) => i.key === "R5")!;
  assert.equal((await db.getMemoryObject(item.memoryId))!.summary, "別のタブで編集された");
  assert.equal(await db.getMemoryObject(await repair.updatingMemoryIdFor(item.updatingConversationId)), undefined);
});

// --------------------------------------------------------------------------- Backfill + independence

function backfillWorld(): { memories: MemoryObject[]; conversations: Conversation[] } {
  const w = world();
  for (const b of D.backfill) {
    if (b.key === "B1") { w.conversations.push(conv(b.conversationId, [b.expectedFirstUserTurn, ...b.memory.evidence, joinKeywords(b.memory.keywords)], NOW, ["dangling-id"])); continue; }
    w.conversations.push(conv(b.conversationId, [b.expectedFirstUserTurn, ...b.memory.evidence, joinKeywords(b.memory.keywords)], "2026-09-24T04:00:00.000Z"));
  }
  return w;
}

test("backfill: add-only, deterministic id, linked + queued in one transaction; idempotent; REVIEW/SKIP are not in the spec", async () => {
  assert.equal(D.backfill.length, 9);
  const { env, db } = await freshEnv(backfillWorld());
  const b61 = D.backfill.find((b) => b.key === "B3")!;
  const r = await runner.runBackfill(env, "execute", { only: ["B3"] });
  assert.equal(r.items[0].outcome, "committed");
  const id = await backfill.backfillMemoryIdFor(b61.conversationId);
  const m = (await db.getMemoryObject(id))!;
  assert.equal(m.conversationId, b61.conversationId); assert.equal(m.eventTime, "2026-09-05");
  assert.deepEqual((await db.getConversation(b61.conversationId))!.memoryObjectIds, [id]);
  assert.ok(await db.getVaultOutboxEntry(`memory:${id}`)); assert.ok(await db.getVaultOutboxEntry(`conversation:${b61.conversationId}`));
  const state = await dump(db);
  const again = await runner.runBackfill(env, "execute", { only: ["B3"] });
  assert.equal(again.items[0].outcome, "ledger-done"); assert.equal(await dump(db), state);
});

test("backfill: a Reflection-only conversation (e.g. B1) is backfilled and the Reflection reference is kept; a normal Memory reference is HELD", async () => {
  const w = backfillWorld();
  const b7 = D.backfill.find((b) => b.key === "B1")!;
  w.conversations.find((c) => c.id === b7.conversationId)!.memoryObjectIds = ["REFLECTION-1"];
  w.memories.push(mem("REFLECTION-1", b7.conversationId, "振り返りの要約です", "振り返りの内容です", NOW, { metadata: { ...meta("r1", NOW), source: "system-generated" } }));
  const { env, db } = await freshEnv(w);
  const r = await runner.runBackfill(env, "execute", { only: ["B1"] });
  assert.equal(r.items[0].outcome, "committed");
  const ids = (await db.getConversation(b7.conversationId))!.memoryObjectIds;
  assert.equal(ids.length, 2); assert.equal(ids[0], "REFLECTION-1");
  assert.equal(JSON.stringify(await db.getMemoryObject("REFLECTION-1")), JSON.stringify(w.memories.find((m) => m.id === "REFLECTION-1")), "Reflection untouched");
});

test("backfill: a conversation that already references a Memory id is HELD, never overwritten", async () => {
  const { env, db } = await freshEnv(backfillWorld());
  const before = await dump(db);
  const r = await runner.runBackfill(env, "execute", { only: ["B1"] });
  assert.equal(r.items[0].outcome, "hold"); assert.ok(r.items[0].reasons!.some((x) => x.startsWith("conversation-already-references-memory")));
  assert.equal(await dump(db), before);
});

test("independence: backfill never touches repair ledgers/Memories and the repair never touches backfill conversations", async () => {
  const { env, db } = await freshEnv(backfillWorld());
  const b72 = D.backfill.find((b) => b.key === "B8")!;
  const convBefore = JSON.stringify(await db.getConversation(b72.conversationId));
  await runner.runContaminationRepair(env, "execute");
  assert.equal(JSON.stringify(await db.getConversation(b72.conversationId)), convBefore, "repair does not touch Backfill conversations");
  const ledgersBefore = await db.readMemoryRepairSettings(D.repair.items.map((i) => repair.repairLedgerKey(i.memoryId)));
  const repairedBefore = JSON.stringify(await Promise.all(D.repair.items.map((i) => db.getMemoryObject(i.memoryId))));
  await runner.runBackfill(env, "execute");
  assert.deepEqual(await db.readMemoryRepairSettings(D.repair.items.map((i) => repair.repairLedgerKey(i.memoryId))), ledgersBefore);
  assert.equal(JSON.stringify(await Promise.all(D.repair.items.map((i) => db.getMemoryObject(i.memoryId)))), repairedBefore, "Backfill never rewrites a repaired Memory");
});

test("order: after the contamination repair, Backfill B2 is HELD as a duplicate of the restored R8 Memory; before it, it is READY", async () => {
  const fresh = await freshEnv(backfillWorld());
  const pre = await runner.runBackfill(fresh.env, "dry-run", { only: ["B2"] });
  assert.equal(pre.items[0].outcome, "would-commit");
  await runner.runContaminationRepair(fresh.env, "execute", { only: ["R8"] });
  const post = await runner.runBackfill(fresh.env, "dry-run", { only: ["B2"] });
  assert.equal(post.items[0].outcome, "hold");
  assert.ok(post.items[0].reasons!.some((x) => x.startsWith("similar-to-existing")));
});

// --------------------------------------------------------------------------- links / structured provenance / preflight

const itemOf = (key: string) => D.repair.items.find((i) => i.key === key)!;
const memOf = (w: { memories: MemoryObject[] }, key: string) => w.memories.find((m) => m.id === itemOf(key).memoryId)!;

test("links: 'keep' links stay on both ends untouched; the whole Link set must be reviewed, intact on the counterpart, and predate the contamination", async () => {
  const w = world();
  const p = await repair.planRepairItem(itemOf("R3"), w, NOW, D.repair.updating);
  assert.equal(p.status, "READY");
  if (p.status === "READY") { assert.equal(p.restoredAfter.links.length, memOf(w, "R3").links.length); assert.equal(p.counterparts.length, 0); assert.deepEqual(p.writeSet.memoryIds.length, 2); }
  const unreviewed = world(); memOf(unreviewed, "R1").links.push({ ...memOf(unreviewed, "R1").links[0], id: "NEW-LINK" });
  const a = await repair.planRepairItem(itemOf("R1"), unreviewed, NOW, D.repair.updating); assert.equal(a.status, "HOLD"); assert.ok(a.status === "HOLD" && a.reasons.some((r) => r.startsWith("link-reviewed")));
  const late = world(); const ml = memOf(late, "R1").links[0]; ml.createdAt = "2026-12-31T00:00:00.000Z";
  const b = await repair.planRepairItem(itemOf("R1"), late, NOW, D.repair.updating); assert.equal(b.status, "HOLD"); assert.ok(b.status === "HOLD" && b.reasons.some((r) => r.startsWith("link-predates-contamination")));
  const oneSided = world(); const cp = oneSided.memories.find((m) => m.id.startsWith("CP-") && m.links.some((l) => itemOf("R1").links[l.id]))!; cp.links = [];
  const c = await repair.planRepairItem(itemOf("R1"), oneSided, NOW, D.repair.updating); assert.equal(c.status, "HOLD"); assert.ok(c.status === "HOLD" && c.reasons.some((r) => r.startsWith("link-counterpart-intact")));
});

test("links: a 'remove' link is cut on BOTH ends in the same transaction (counterpart may be a Reflection) and both get an Outbox entry", async () => {
  const spec = D.repair.items.map((i) => (i.key === "R1" ? { ...i, links: Object.fromEntries(Object.keys(i.links).map((k) => [k, "remove" as const])) } : i));
  const w = world();
  const { env, db } = await freshEnv(w);
  const linkId = Object.keys(itemOf("R1").links)[0];
  const counterpartId = w.memories.find((m) => m.id.startsWith("CP-") && m.links.some((l) => l.id === linkId))!.id;
  const r = await runner.runContaminationRepair(env, "execute", { only: ["R1"], spec });
  assert.equal(r.items[0].outcome, "committed", JSON.stringify(r.items[0]));
  assert.equal((await db.getMemoryObject(itemOf("R1").memoryId))!.links.length, 0);
  const cp = (await db.getMemoryObject(counterpartId))!;
  assert.equal(cp.links.some((l) => l.id === linkId), false);
  assert.equal(cp.updatedAt, NOW);
  const entry = await db.getVaultOutboxEntry(`${cp.metadata.source === "system-generated" ? "reflection" : "memory"}:${counterpartId}`);
  assert.ok(entry && entry.status === "pending" && entry.recordUpdatedAt === NOW);
  const backup = JSON.parse((await db.readMemoryRepairSettings([repair.repairBackupKey(itemOf("R1").memoryId)]))[repair.repairBackupKey(itemOf("R1").memoryId)]!) as { memories: MemoryObject[] };
  assert.ok(backup.memories.some((m) => m.id === counterpartId && m.links.some((l) => l.id === linkId)), "the counterpart's links are in the backup");
});

test("structured claims: entries from the updating conversation MOVE; entries from any other conversation have no safe home => HOLD (R8 case)", async () => {
  const w = world();
  const m = memOf(w, "R8");
  m.personMentions = [
    { id: "a", displayName: "タナカさん", quote: "q1", sourceConversationId: itemOf("R8").originalConversationId } as never,
    { id: "b", displayName: "タナカさん", quote: "q2", sourceConversationId: "some-other-conversation" } as never];
  const p = await repair.planRepairItem(itemOf("R8"), w, NOW, D.repair.updating);
  assert.equal(p.status, "HOLD");
  assert.ok(p.status === "HOLD" && p.reasons.some((r) => r.startsWith("personMentions-provenance-is-original-or-updating")));
  const before = JSON.stringify(w);
  const { env, db } = await freshEnv(w); const dumpBefore = await dump(db);
  const r = await runner.runContaminationRepair(env, "execute", { only: ["R8"] });
  assert.equal(r.items[0].outcome, "hold"); assert.equal(await dump(db), dumpBefore, "a HOLD changes nothing");
  void before;
});

test("preflight: every guard is listed with PASS/FAIL; READY previews carry the full write set and all-PASS checks", async () => {
  const { env } = await freshEnv();
  const report = await runner.runContaminationRepair(env, "dry-run", { only: ["R7"] });
  const preview = report.items[0].preview!;
  const codes = preview.checks!.map((c) => c.code);
  for (const need of ["memory-exists", "original-conversation-exists", "updating-conversation-exists", "memory-matches-reviewed-corrupted-state", "new-memory-id-unused-or-identical", "no-existing-memory-with-restored-content", "no-existing-memory-with-updating-content", "updating-conversation-has-no-other-memory"]) assert.ok(codes.includes(need), need);
  assert.ok(preview.checks!.every((c) => c.pass));
  assert.ok(preview.writeSet!.memoryIds.includes(itemOf("R7").memoryId) && preview.writeSet!.conversationIds.includes(itemOf("R7").updatingConversationId));
  const w = world(); memOf(w, "R7").content = "別の内容";
  const held = await repair.planRepairItem(itemOf("R7"), w, NOW, D.repair.updating);
  assert.ok(held.status === "HOLD" && held.checks.some((c) => c.code === "memory-matches-reviewed-corrupted-state" && !c.pass) && held.checks.some((c) => c.code === "memory-exists" && c.pass));
});

// --------------------------------------------------------------------------- integrity / collateral / projection / rollback

test("integrity: after a full repair every reference, link and Outbox entry is consistent; tampering is detected", async () => {
  const { env, db } = await freshEnv();
  await runner.runContaminationRepair(env, "execute");
  const ok = await runner.verifyContaminationRepair(env);
  assert.deepEqual(ok.problems, []); assert.equal(ok.checkedItems.length, 8);
  assert.ok(Object.values(ok.projection).every((v) => v === "pending"), "Outbox entries are queued (pending), not yet projected");
  const u = itemOf("R1").updatingConversationId;
  await db.putConversation({ ...(await db.getConversation(u))!, memoryObjectIds: [] });
  const bad = await runner.verifyContaminationRepair(env);
  assert.ok(bad.problems.some((p) => p.code === "updating-conversation-lacks-reference"));
  const o = await db.getMemoryObject(itemOf("R5").memoryId)!;
  await db.putMemoryObject({ ...o!, updatedAt: "2099-01-01T00:00:00.000Z" });
  const stale = await runner.verifyContaminationRepair(env);
  assert.equal(stale.projection[`memory:${itemOf("R5").memoryId}`], "stale");
  assert.ok(stale.problems.some((p) => p.code === "outbox-stale"));
});

test("projection states: held / done Outbox entries are reported, and a failed projection never touches canonical data", async () => {
  const { env, db } = await freshEnv();
  await runner.runContaminationRepair(env, "execute", { only: ["R8"] });
  const id = `memory:${itemOf("R8").memoryId}`;
  const entry = (await db.getVaultOutboxEntry(id))!;
  const canonical = JSON.stringify(await db.getMemoryObject(itemOf("R8").memoryId));
  await db.putVaultOutboxEntry({ ...entry, status: "held", heldReason: "projection-failed" } as never);
  assert.equal((await runner.verifyContaminationRepair(env, { only: ["R8"] })).projection[id], "held");
  await db.putVaultOutboxEntry({ ...entry, status: "done" } as never);
  assert.equal((await runner.verifyContaminationRepair(env, { only: ["R8"] })).projection[id], "done");
  assert.equal(JSON.stringify(await db.getMemoryObject(itemOf("R8").memoryId)), canonical);
});

test("collateral: if anything outside the write set changes during a commit, the runner stops and reports it", async () => {
  const { env, db } = await freshEnv();
  const sneaky: RepairEnv = { ...env, commit: async (t) => { const r = await env.commit(t); await db.putMemoryObject({ ...(await db.getMemoryObject("BYSTANDER-MEM"))!, summary: "勝手に変わった" }); return r; } };
  const r = await runner.runContaminationRepair(sneaky, "execute", { only: ["R1", "R2"] });
  assert.equal(r.items.length, 1); assert.equal(r.stoppedOnFailure, true);
  assert.match(r.items[0].error!, /^collateral-change:memory:BYSTANDER-MEM/);
});

test("rollback: restores the pre-repair Memory (and cut link counterparts), keeps the new Memory and the references, never deletes; idempotent", async () => {
  const spec = D.repair.items.map((i) => (i.key === "R1" ? { ...i, links: Object.fromEntries(Object.keys(i.links).map((k) => [k, "remove" as const])) } : i));
  const w = world();
  const { env, db } = await freshEnv(w);
  const item = itemOf("R1");
  const original = JSON.stringify(await db.getMemoryObject(item.memoryId));
  const linkId = Object.keys(item.links)[0];
  const counterpartId = w.memories.find((m) => m.id.startsWith("CP-") && m.links.some((l) => l.id === linkId))!.id;
  const counterpartOriginal = JSON.stringify(await db.getMemoryObject(counterpartId));
  await runner.runContaminationRepair(env, "execute", { only: ["R1"], spec });
  const newId = await repair.updatingMemoryIdFor(item.updatingConversationId);
  const afterRepair = await dump(db);
  const dry = await runner.rollbackContaminationRepair(env, "dry-run", { only: ["R1"], spec });
  assert.equal(dry.items[0].outcome, "would-commit"); assert.equal(await dump(db), afterRepair, "dry-run rollback writes nothing");
  const rb = await runner.rollbackContaminationRepair(env, "execute", { only: ["R1"], spec });
  assert.equal(rb.items[0].outcome, "committed", JSON.stringify(rb.items[0]));
  const restored = (await db.getMemoryObject(item.memoryId))!;
  const norm = (m: MemoryObject) => JSON.stringify({ ...m, updatedAt: "-", metadata: { ...m.metadata, updatedAt: "-" } });
  assert.equal(norm(restored), norm(JSON.parse(original)), "pre-repair Memory content, links and structured data are back");
  assert.equal(restored.updatedAt, NOW);
  assert.equal(norm((await db.getMemoryObject(counterpartId))!), norm(JSON.parse(counterpartOriginal)), "cut link counterpart restored");
  assert.ok(await db.getMemoryObject(newId), "the new Memory is NOT deleted");
  assert.ok((await db.getConversation(item.updatingConversationId))!.memoryObjectIds.includes(newId), "its Conversation reference stays valid");
  assert.ok((await db.getVaultOutboxEntry(`memory:${item.memoryId}`))!.recordUpdatedAt === NOW, "restored Memory is queued for projection through the Outbox");
  const again = await runner.rollbackContaminationRepair(env, "execute", { only: ["R1"], spec });
  assert.equal(again.items[0].outcome, "ledger-done");
  const rerun = await runner.runContaminationRepair(env, "execute", { only: ["R1"], spec });
  assert.equal(rerun.items[0].outcome, "ledger-done", "a rolled-back item is not silently re-repaired");
});

test("rollback: HOLD when the Memory changed after the repair, or the repair never ran", async () => {
  const { env, db } = await freshEnv();
  const never = await runner.rollbackContaminationRepair(env, "execute", { only: ["R5"] });
  assert.equal(never.items[0].outcome, "hold");
  await runner.runContaminationRepair(env, "execute", { only: ["R5"] });
  const m = (await db.getMemoryObject(itemOf("R5").memoryId))!;
  await db.putMemoryObject({ ...m, summary: "ユーザーが修復後に編集した", updatedAt: "2026-11-01T00:00:00.000Z" });
  const edited = JSON.stringify(await db.getMemoryObject(itemOf("R5").memoryId));
  const r = await runner.rollbackContaminationRepair(env, "execute", { only: ["R5"] });
  assert.equal(r.items[0].outcome, "hold"); assert.ok(r.items[0].reasons!.some((x) => x.startsWith("current-equals-repaired-image")));
  assert.equal(JSON.stringify(await db.getMemoryObject(itemOf("R5").memoryId)), edited, "newer data is never overwritten");
});

test("failure during rollback commit changes nothing (atomic) and rollback can be retried", async () => {
  const { env, db } = await freshEnv();
  await runner.runContaminationRepair(env, "execute", { only: ["R6"] });
  const state = await dump(db);
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox");
  const r = await runner.rollbackContaminationRepair(env, "execute", { only: ["R6"] });
  assert.equal(r.items[0].outcome, "failed"); assert.equal(await dump(db), state);
  const retry = await runner.rollbackContaminationRepair(env, "execute", { only: ["R6"] });
  assert.equal(retry.items[0].outcome, "committed");
});
