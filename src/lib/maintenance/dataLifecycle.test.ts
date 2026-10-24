/**
 * Data lifecycle (Vault presence check, purge rules) with an in-memory Vault and a fake IndexedDB. Dummy data only. Run: `npm run test:maintenance`.
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
const life = require(path.join(OUT, "lib/dataLifecycle.js")) as typeof import("../dataLifecycle");
const md = require(path.join(OUT, "lib/markdown.js")) as typeof import("../markdown");
const testSupport = require(path.join(OUT, "lib/maintenance/testSupport.js")) as typeof import("./testSupport");

const T = "2026-08-20T00:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, sourceType: "chat" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
const memory = (id: string, links: any[] = []): any => ({ id, date: T, types: ["conversation"], conversationId: "c1", content: "本文", summary: "要約", keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links, createdAt: T, updatedAt: T, metadata: meta });
const tomb = (kind: "memory" | "conversation", id: string, over: Partial<import("../db").Tombstone> = {}): import("../db").Tombstone =>
  ({ v: 1, kind, id, deletedAt: "2026-01-01T00:00:00.000Z", date: T, startedAt: T, vault: "unverified", ...over });

test("Vault presence: found by id wherever the file was moved to; a mention of the id in another record, or an index.json key alone, is NOT presence", async () => {
  const v = new testSupport.FakeVault();
  // a day file in the canonical place that holds OTHER Memories and merely mentions the id in a link
  v.put("Memories/2026-08-20.md", md.serializeMemoryDayFile([memory("other-1", [{ id: "l", sourceId: "other-1", targetId: "gone-mem", axis: "theme", reason: "r", contrast: false, strength: 0.5, createdBy: "ai-inference", createdAt: T }])]));
  v.put(".tsumugi/index.json", JSON.stringify({ "gone-conv": "Conversations/2026-08-20-xxxxxx.md" }));   // key left behind; the file itself is gone
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("memory", "gone-mem")), "absent");
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("conversation", "gone-conv")), "absent");
  // the Memory file was moved into a sub folder by the user
  v.put("Memories/archive/old/renamed.md", md.serializeMemoryDayFile([memory("gone-mem")]));
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("memory", "gone-mem")), "present");
  // a conversation file moved elsewhere under Conversations/
  v.put("Conversations/sub/folder/talk.md", "---\ntsumugi: true\nid: gone-conv\n---\nbody\n");
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("conversation", "gone-conv")), "present");
  // the canonical day file path is checked first and a member there counts
  const v2 = new testSupport.FakeVault();
  v2.put("Memories/2026-08-20.md", md.serializeMemoryDayFile([memory("gone-mem")]));
  assert.equal(await life.checkTombstoneInVault(v2.root(), tomb("memory", "gone-mem")), "present");
  // no Vault folders at all: nothing to find
  assert.equal(await life.checkTombstoneInVault(new testSupport.FakeVault().root(), tomb("memory", "gone-mem")), "absent");
});

test("purge rules: only a tombstone whose Vault copy was verified absent, that is old enough and not 'kept', is purgeable", () => {
  const old = "2026-01-01T00:00:00.000Z", now = "2026-10-23T00:00:00.000Z";
  assert.deepEqual(life.purgeDecision(tomb("memory", "a", { vault: "unverified", deletedAt: old }), now), { purgeable: false, reason: "vault-copy-may-exist" });
  assert.deepEqual(life.purgeDecision(tomb("memory", "a", { vault: "kept", deletedAt: old }), now), { purgeable: false, reason: "kept-by-user" });
  assert.deepEqual(life.purgeDecision(tomb("memory", "a", { vault: "absent", deletedAt: "2026-10-10T00:00:00.000Z" }), now), { purgeable: false, reason: "too-recent" });
  assert.deepEqual(life.purgeDecision(tomb("memory", "a", { vault: "absent", deletedAt: "garbage" }), now), { purgeable: false, reason: "too-recent" }, "an unreadable date never purges");
  assert.deepEqual(life.purgeDecision(tomb("memory", "a", { vault: "absent", deletedAt: old }), now), { purgeable: true, reason: "ok" });
});

test("purge is conditional: a tombstone another tab changed after the decision (the Vault copy reappeared) is NOT cleared; eligible ones are; the Vault verdict is remembered", async () => {
  await dbm.putMemoryObject(memory("pg-a")); await dbm.putMemoryObject(memory("pg-b"));
  await dbm.deleteMemoryByUser("pg-a", "2026-01-01T00:00:00.000Z");
  await dbm.deleteMemoryByUser("pg-b", "2026-01-01T00:00:00.000Z");
  const v = new testSupport.FakeVault();        // empty Vault: both copies are absent
  assert.equal(await life.verifyTombstone(v.root(), "memory", "pg-a", "2026-02-01T00:00:00.000Z"), "absent");
  assert.equal(await life.verifyTombstone(v.root(), "memory", "pg-b", "2026-02-01T00:00:00.000Z"), "absent");
  const staleView = (await dbm.getTombstone("memory", "pg-a"))!;                   // the decision is made on this view ...
  await dbm.setTombstoneVaultState("memory", "pg-a", "unverified", "2026-10-22T00:00:00.000Z");   // ... then another tab finds the Vault copy again
  assert.equal(await dbm.clearTombstoneIfUnchanged(staleView), false);
  assert.ok(await dbm.getTombstone("memory", "pg-a"), "the changed tombstone survived");
  const purged = await life.purgeEligibleTombstones(v.root(), "2026-10-23T00:00:00.000Z");
  assert.deepEqual(purged, [{ kind: "memory", id: "pg-b" }]);
  assert.equal(await dbm.getTombstone("memory", "pg-b"), undefined);
  assert.ok(await dbm.getTombstone("memory", "pg-a"));
  // a copy that reappears after "absent" puts the guard back to unverified
  const v2 = new testSupport.FakeVault();
  v2.put("Memories/2026-08-20.md", md.serializeMemoryDayFile([memory("pg-a")]));
  await dbm.setTombstoneVaultState("memory", "pg-a", "absent", "2026-10-22T00:00:00.000Z");
  assert.equal(await life.verifyTombstone(v2.root(), "memory", "pg-a"), "present");
  assert.equal((await dbm.getTombstone("memory", "pg-a"))!.vault, "unverified");
});

test("purge re-reads the Vault right before clearing: a copy that came back after the stored 'absent' verdict keeps the tombstone; without a readable Vault nothing is purged; a concurrent 'keep' is not overwritten by a stale verification", async () => {
  await dbm.putMemoryObject(memory("pr-a")); await dbm.putMemoryObject(memory("pr-b"));
  await dbm.deleteMemoryByUser("pr-a", "2026-01-01T00:00:00.000Z");
  await dbm.deleteMemoryByUser("pr-b", "2026-01-01T00:00:00.000Z");
  const empty = new testSupport.FakeVault();
  await life.verifyTombstone(empty.root(), "memory", "pr-a", "2026-01-02T00:00:00.000Z");
  await life.verifyTombstone(empty.root(), "memory", "pr-b", "2026-01-02T00:00:00.000Z");
  assert.deepEqual(await life.purgeEligibleTombstones(null, "2026-10-23T00:00:00.000Z"), [], "no Vault, no purge");
  // day 20: another device restored the file of pr-a into the Vault; the stored verdict is still 'absent'
  const back = new testSupport.FakeVault();
  back.put("Memories/2026-08-20.md", md.serializeMemoryDayFile([memory("pr-a")]));
  const purged = await life.purgeEligibleTombstones(back.root(), "2026-10-23T00:00:00.000Z");
  assert.deepEqual(purged, [{ kind: "memory", id: "pr-b" }]);
  assert.equal((await dbm.getTombstone("memory", "pr-a"))!.vault, "unverified", "the guard stays and is marked unverified again");
  // concurrent decisions: a stale verification never overwrites the user's newer choice
  await dbm.setTombstoneVaultState("memory", "pr-a", "absent", "2026-10-01T00:00:00.000Z");
  const scanned = (await dbm.getTombstone("memory", "pr-a"))!;
  assert.equal(await life.keepVaultCopy((await dbm.getTombstone("memory", "pr-a"))!, "2026-10-22T00:00:00.000Z"), true);   // another tab: "keep the Vault copy"
  assert.equal(await dbm.setTombstoneVaultStateIfUnchanged(scanned, "unverified", "2026-10-22T01:00:00.000Z"), false);
  assert.equal((await dbm.getTombstone("memory", "pr-a"))!.vault, "kept");
});

test("an in-flight Capture can not undo a deletion: the deleted conversation is not recreated and no Memory of it is saved", async () => {
  await dbm.putConversation({ id: "cap-conv", persona: "companion", status: "captured", startedAt: T, createdAt: T, updatedAt: T, turns: [], memoryObjectIds: [], metadata: meta } as any);
  await dbm.deleteConversationByUser("cap-conv", "2026-10-22T00:00:00.000Z");          // the user deletes it from another tab ...
  const conv = { id: "cap-conv", persona: "companion", status: "captured", startedAt: T, createdAt: T, updatedAt: T, turns: [], memoryObjectIds: [], metadata: meta } as any;
  await assert.rejects(() => dbm.putConversation(conv), (e: Error) => e.name === "TombstonedRecordError");   // ... then the finishing Capture tries to write
  const m = { ...memory("cap-mem"), conversationId: "cap-conv" };
  await assert.rejects(() => dbm.putCapturedMemoryWithOutbox(m, "cap-conv"), (e: Error) => e.name === "TombstonedRecordError");
  assert.equal(await dbm.getConversation("cap-conv"), undefined);
  assert.equal(await dbm.getMemoryObject("cap-mem"), undefined);
  assert.equal(await dbm.getVaultOutboxEntry("memory:cap-mem"), undefined, "no Outbox task either");
  // a tombstoned Memory id is refused too
  await dbm.putMemoryObject({ ...memory("cap-old"), conversationId: "cap-live" });
  await dbm.deleteMemoryByUser("cap-old", "2026-10-22T00:00:00.000Z");
  await assert.rejects(() => dbm.putCapturedMemoryWithOutbox({ ...memory("cap-old"), conversationId: "cap-live" }, "cap-live"), (e: Error) => e.name === "TombstonedRecordError");
});

test("Vault presence uses the record's FRONTMATTER only: an 'id:' line pasted into a body or another record's text is not presence", async () => {
  const v = new testSupport.FakeVault();
  v.put("Conversations/note.md", "---\ntsumugi: true\nid: other-conv\n---\nmy notes\nid: gone-conv\nmore text\n");
  v.put("Memories/2026-08-20.md", md.serializeMemoryDayFile([{ ...memory("other-mem"), content: "pasted yaml:\nid: gone-mem\n" }]));
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("conversation", "gone-conv")), "absent");
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("memory", "gone-mem")), "absent");
  v.put("Conversations/real.md", "---\ntsumugi: true\nid: gone-conv\n---\nbody\n");
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("conversation", "gone-conv")), "present");
});

test("'allow back' and 'keep the Vault copy' act only on the tombstone the user saw: a newer deletion of the same id is never erased by a stale click", async () => {
  await dbm.putMemoryObject(memory("ab-1"));
  await dbm.deleteMemoryByUser("ab-1", "2026-10-01T00:00:00.000Z");
  const seenByTabA = (await dbm.getTombstone("memory", "ab-1"))!;
  // tab B: allow back, the record is restored, and the user deletes it again
  assert.equal(await life.allowBack(seenByTabA), true);
  await dbm.putMemoryObject(memory("ab-1"));
  await dbm.deleteMemoryByUser("ab-1", "2026-10-22T00:00:00.000Z");
  // tab A: the stale click
  assert.equal(await life.allowBack(seenByTabA), false);
  assert.equal(await life.keepVaultCopy(seenByTabA), false);
  assert.equal((await dbm.getTombstone("memory", "ab-1"))!.deletedAt, "2026-10-22T00:00:00.000Z", "the newer deletion intent survived");
});

test("the in-transaction gate decision equals the app-wide gate (isRecoveryBlockingNormalWrites) for journals of every kind", async () => {
  const journalMod = require(path.join(OUT, "lib/vaultRecoveryJournal.js")) as typeof import("../vaultRecoveryJournal");
  assert.equal(dbm.GATE_JOURNAL_VERSION, journalMod.RECOVERY_JOURNAL_VERSION, "the copied constant must follow the real one");
  const j = (over: Record<string, unknown>, epoch = 0) => JSON.stringify({ version: journalMod.RECOVERY_JOURNAL_VERSION, operationId: "op", status: "in-progress", createdAt: T, updatedAt: T, world: { activeVaultEpoch: epoch, committedVaultEpoch: null, registryGenerationEpoch: 0, journalVersion: "current", backend: null }, baselineAtStart: { status: "x", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false, ...over });
  const cases: [string, string][] = [
    ["in-progress, current world", j({})], ["in-progress, other world", j({}, 9)], ["completed", j({ status: "completed" })], ["abandoned", j({ status: "abandoned" })],
    ["not json", "{ nope"], ["wrong version", j({ version: 99 })], ["missing world", JSON.stringify({ version: 1, operationId: "op", status: "in-progress" })],
  ];
  for (const [label, text] of cases) {
    await dbm.writeRecoveryJournalRaw(text);
    const canonical = await journalMod.isRecoveryBlockingNormalWrites();
    let blockedHere = false;
    try { await dbm.retryOutboxEntry("memory:probe-none"); } catch (e) { blockedHere = (e as Error).name === "RecoveryPendingError"; }
    assert.equal(blockedHere, canonical, label);
  }
  await dbm.writeRecoveryJournalRaw(j({ status: "completed" }));
});

test("a cascade conversation tombstone keeps guarding while a Memory made from that conversation is still in the Vault; a plain one does not care", async () => {
  const v = new testSupport.FakeVault();
  v.put("Memories/2026-08-20.md", md.serializeMemoryDayFile([{ ...memory("child-mem"), conversationId: "gone-conv" }]));
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("conversation", "gone-conv", { cascade: true })), "present", "the child Memory's file is still there");
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("conversation", "gone-conv")), "absent", "without the cascade intent only the conversation file counts");
  const v2 = new testSupport.FakeVault();
  v2.put("Memories/2026-08-20.md", md.serializeMemoryDayFile([{ ...memory("child-mem"), conversationId: "another-conv" }]));
  assert.equal(await life.checkTombstoneInVault(v2.root(), tomb("conversation", "gone-conv", { cascade: true })), "absent", "a Memory of another conversation is not a reason");
  // "keep both" needs a Vault copy of the record itself
  assert.equal(await life.findRecordInVault(v.root(), "child-mem"), "present");
  assert.equal(await life.findRecordInVault(v.root(), "nobody"), "absent");
});

test("the Vault copy check for 'keep both' also looks in Sources/", async () => {
  const v = new testSupport.FakeVault();
  v.put("Sources/2026-08-20-note.md", "---\ntsumugi: true\nid: src-1\n---\nbody\n");
  assert.equal(await life.findRecordInVault(v.root(), "src-1"), "present");
  assert.equal(await life.findRecordInVault(v.root(), "src-2"), "absent");
});
