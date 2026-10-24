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
const deletion = require(path.join(OUT, "lib/vaultDeletion.js")) as typeof import("../vaultDeletion");

const T = "2026-08-20T00:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, sourceType: "chat" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
const memory = (id: string, links: any[] = []): any => ({ id, date: T, types: ["conversation"], conversationId: "c1", content: "本文", summary: "要約", keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links, createdAt: T, updatedAt: T, metadata: meta });
const tomb = (kind: "memory" | "conversation", id: string, over: Partial<import("../db").Tombstone> = {}): import("../db").Tombstone =>
  ({ v: 1, kind, id, deletedAt: "2026-01-01T00:00:00.000Z", date: T, startedAt: T, vault: "unverified", ...over });

function deletionWorld(id = "erase-me") {
  const v = new testSupport.FakeVault();
  const kept = md.memoryObjectToMarkdown(memory("keep-me")) + "\n<!-- external annotation: KEEP EXACTLY -->\n";
  v.put("moved/deep/renamed.MD", md.memoryObjectToMarkdown(memory(id)) + "\n<!-- tsumugi:entry -->\n\n" + kept);
  v.put("another/copy.md", md.memoryObjectToMarkdown(memory(id)));
  v.put(".tsumugi/recovery/backup.md", md.memoryObjectToMarkdown(memory(id)));
  v.put("private.md", "A handwritten note mentioning " + id);
  v.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "delete-vault" }));
  v.put(".tsumugi/index.json", JSON.stringify({ [id]: "moved/deep/renamed.MD", "keep-me": "moved/deep/renamed.MD" }));
  v.put(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, registryGeneration: "old-generation", dirtyOwnerInstanceId: null }));
  v.put(".tsumugi/registry/00.json", JSON.stringify({ schemaVersion: 1, bucket: 0, records: { day: "moved/deep/renamed.MD" }, files: { "moved/deep/renamed.MD": { recordType: "memory-day", contentHash: require(path.join(OUT, "lib/vault.js")).hashVaultText(v.snapshot()["moved/deep/renamed.MD"]), memberIds: [id, "keep-me"], memberHashes: { [id]: "h", "keep-me": "keep-h" }, status: "ok" } } }));
  v.put(".tsumugi/history/2026-08.json", JSON.stringify({ version: 2, month: "2026-08", days: { "2026-08-20": { conversations: [{ id: "unrelated-conv" }], normalMemories: [{ id }, { id: "keep-me" }], reflections: [] } } }));
  v.put(".tsumugi/history-meta.json", JSON.stringify({ version: 1, months: { "2026-08": { conversations: 1, memories: 2 } }, totalConversations: 1, totalMemories: 2 }));
  return { v, kept, t: tomb("memory", id, { vaultId: "delete-vault" }) };
}
const planFor = (w: ReturnType<typeof deletionWorld>) => deletion.buildVaultDeletionPlan(new Map(Object.entries(w.v.snapshot())), w.t, "delete-vault", 0);

test("physical deletion: moved/renamed duplicate copies, shared day, History, index and registry converge; unknown bytes and archives survive", async () => {
  const w = deletionWorld(); const before = w.v.snapshot(); const plan = planFor(w);
  assert.deepEqual(w.v.snapshot(), before, "preview is read only");
  await deletion.applyVaultDeletionEdits(w.v.root(), plan);
  const final = w.v.snapshot();
  assert.equal(final["moved/deep/renamed.MD"], w.kept);
  assert.equal(final["another/copy.md"], undefined);
  assert.equal(final["private.md"], before["private.md"]);
  assert.equal(final[".tsumugi/recovery/backup.md"], before[".tsumugi/recovery/backup.md"]);
  assert.deepEqual(JSON.parse(final[".tsumugi/index.json"]), { "keep-me": "moved/deep/renamed.MD" });
  const row = JSON.parse(final[".tsumugi/registry/00.json"]).files["moved/deep/renamed.MD"];
  assert.deepEqual(row.memberIds, ["keep-me"]); assert.ok(row.memberHashes["keep-me"]); assert.equal(row.memberHashes["erase-me"], undefined); assert.equal(row.status, "ok");
  assert.deepEqual(JSON.parse(final[".tsumugi/history/2026-08.json"]).days["2026-08-20"].normalMemories, [{ id: "keep-me" }]);
  assert.equal(JSON.parse(final[".tsumugi/history-meta.json"]).totalMemories, 1);
  assert.equal(JSON.parse(final[".tsumugi/registry-meta.json"]).registryGeneration, undefined);
  await deletion.applyVaultDeletionEdits(w.v.root(), plan); assert.deepEqual(w.v.snapshot(), final, "retry is idempotent");
});

test("physical deletion: every interrupted prefix resumes safely, including Markdown gone before metadata writes", async () => {
  const original = deletionWorld(); const plan = planFor(original);
  for (let n = 0; n <= plan.edits.length; n++) {
    const v = original.v.copy();
    await deletion.applyVaultDeletionEdits(v.root(), { ...plan, edits: plan.edits.slice(0, n) });
    await deletion.applyVaultDeletionEdits(v.root(), plan);
    assert.equal(v.snapshot()["moved/deep/renamed.MD"], original.kept);
    assert.equal(JSON.parse(v.snapshot()[".tsumugi/history-meta.json"]).totalMemories, 1);
  }
});

test("physical deletion: external edits invalidate confirmation; failure during write preserves other records and retries", async () => {
  const w = deletionWorld(); const plan = planFor(w);
  w.v.put("another/copy.md", w.v.snapshot()["another/copy.md"] + "external edit");
  const before = w.v.snapshot();
  await assert.rejects(deletion.applyVaultDeletionEdits(w.v.root(), plan), /content-changed/);
  assert.deepEqual(w.v.snapshot(), before, "preflight catches changes before the first deletion");
  const w2 = deletionWorld(); const p2 = planFor(w2);
  w2.v.writeShouldFail.add(".tsumugi/index.json");
  await assert.rejects(deletion.applyVaultDeletionEdits(w2.v.root(), p2), /simulated write failure/);
  assert.equal(w2.v.snapshot()["moved/deep/renamed.MD"], w2.kept);
  w2.v.writeShouldFail.clear(); await deletion.applyVaultDeletionEdits(w2.v.root(), p2);
  assert.equal(JSON.parse(w2.v.snapshot()[".tsumugi/index.json"])["erase-me"], undefined);
});

test("physical deletion: a failed file removal stops, preserves the pending suffix, and can be retried", async () => {
  const w = deletionWorld(); const plan = planFor(w); const root = w.v.root();
  const getDir = root.getDirectoryHandle.bind(root);
  root.getDirectoryHandle = async (name: string, options: unknown) => {
    const dir = await getDir(name, options);
    if (name === "another") dir.removeEntry = async () => { throw new DOMException("permission lost", "NotAllowedError"); };
    return dir;
  };
  await assert.rejects(deletion.applyVaultDeletionEdits(root, plan), (e: Error) => e.name === "NotAllowedError");
  assert.ok(w.v.snapshot()["another/copy.md"]);
  assert.equal(w.v.snapshot()["moved/deep/renamed.MD"], w.kept);
  await deletion.applyVaultDeletionEdits(w.v.root(), plan);
  assert.equal(w.v.snapshot()["another/copy.md"], undefined);
});

test("physical deletion: malformed metadata and ambiguous ownership stop before any mutation", () => {
  const w = deletionWorld(); w.v.put(".tsumugi/history/2026-08.json", "broken");
  assert.throws(() => planFor(w));
  const x = deletionWorld(); x.v.put("foreign.md", "---\nid: erase-me\ndate: 2026-08-20\n---\nuser text");
  assert.throws(() => planFor(x), /not-owned/);
});

test("physical deletion uses the restore parser's exact day boundary and never splits a conversation transcript", async () => {
  const w = deletionWorld();
  const body = md.memoryObjectToMarkdown(memory("body-owner")) + "\n<!-- tsumugi:entry -->\n" + md.memoryObjectToMarkdown(memory(w.t.id));
  assert.deepEqual(md.parseMemoryDayFile(body).map((m) => m.id), ["body-owner"]);
  w.v.put("examples.md", body);
  await deletion.applyVaultDeletionEdits(w.v.root(), planFor(w));
  assert.equal(w.v.snapshot()["examples.md"], body, "an example inside another Memory is not deletion authority");
  const v = new testSupport.FakeVault();
  v.put("talk.md", `---\ntsumugi: true\nid: whole-conv\nstartedAt: ${T}\n---\nTranscript\n` + md.MEMORY_ENTRY_SEPARATOR + "retained transcript suffix");
  const p = deletion.buildVaultDeletionPlan(new Map(Object.entries(v.snapshot())), tomb("conversation", "whole-conv"), "v", 0);
  await deletion.applyVaultDeletionEdits(v.root(), p); assert.equal(v.snapshot()["talk.md"], undefined);
});

test("physical deletion keeps a guarded registry container for externally added or moved survivors", async () => {
  const w = deletionWorld();
  const shard = JSON.parse(w.v.snapshot()[".tsumugi/registry/00.json"]);
  shard.files["moved/deep/renamed.MD"].memberIds = [w.t.id];
  shard.files["moved/deep/renamed.MD"].status = "conflict";
  w.v.put(".tsumugi/registry/00.json", JSON.stringify(shard));
  await deletion.applyVaultDeletionEdits(w.v.root(), planFor(w));
  const result = JSON.parse(w.v.snapshot()[".tsumugi/registry/00.json"]);
  assert.equal(result.records.day, "moved/deep/renamed.MD");
  assert.deepEqual(result.files["moved/deep/renamed.MD"].memberIds, ["keep-me"]);
  assert.equal(result.files["moved/deep/renamed.MD"].status, "conflict");
  const vault = require(path.join(OUT, "lib/vault.js")) as typeof import("../vault");
  const key = vault.dayFileRegistryKey(T); const bucket = vault.vaultRegistryBucketOf(key);
  const guarded = JSON.parse(w.v.snapshot()[`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`]);
  assert.equal(guarded.records[key], "moved/deep/renamed.MD");
  assert.notEqual(guarded.files[guarded.records[key]].status, undefined);
});

test("physical deletion removes retained Vault links and conversation references without rewriting their body or unknown fields", async () => {
  const w = deletionWorld();
  const linked = memory("keep-linked", [{ id: "l", sourceId: "keep-linked", targetId: w.t.id }]);
  const body = "\nEXTERNAL TEXT: preserve line breaks\n\n";
  w.v.put("links.md", md.memoryObjectToMarkdown(linked) + body);
  w.v.put("talk.md", `---\ntsumugi: true\nid: keep-talk\nstartedAt: ${T}\nmemoryObjectIds: ["${w.t.id}", "keep-linked"]\nunknown: preserve-this\n---\nUser prose\n`);
  await deletion.applyVaultDeletionEdits(w.v.root(), planFor(w));
  const result = w.v.snapshot();
  assert.deepEqual(md.parseMemoryObjectMarkdown(result["links.md"])!.links, []);
  assert.ok(result["links.md"].endsWith(body));
  assert.deepEqual(md.parseFrontmatter(result["talk.md"])!.frontmatter.memoryObjectIds, ["keep-linked"]);
  assert.ok(result["talk.md"].includes("unknown: preserve-this\n---\nUser prose\n"));
});

test("physical deletion does not bless pre-existing external edits as a safe registry baseline", async () => {
  const w = deletionWorld();
  w.v.put("moved/deep/renamed.MD", w.v.snapshot()["moved/deep/renamed.MD"] + "external edit after registry was written\n");
  await deletion.applyVaultDeletionEdits(w.v.root(), planFor(w));
  assert.equal(JSON.parse(w.v.snapshot()[".tsumugi/registry/00.json"]).files["moved/deep/renamed.MD"].status, "needs-resync");
  assert.ok(w.v.snapshot()["moved/deep/renamed.MD"].endsWith("external edit after registry was written\n"));
});

test("physical deletion: cascade includes Vault-only memories; keeping the conversation's memories is the default", async () => {
  const v = new testSupport.FakeVault();
  v.put("moved/talk.md", "---\ntsumugi: true\nid: gone-conversation\nstartedAt: 2026-08-20\n---\nconversation");
  v.put("moved/mem.md", md.memoryObjectToMarkdown({ ...memory("vault-only"), conversationId: "gone-conversation" }));
  const files = new Map(Object.entries(v.snapshot()));
  const plain = deletion.buildVaultDeletionPlan(files, tomb("conversation", "gone-conversation"), "v", 0);
  assert.deepEqual(plain.ids, ["gone-conversation"]);
  const cascade = deletion.buildVaultDeletionPlan(files, tomb("conversation", "gone-conversation", { cascade: true }), "v", 0);
  assert.deepEqual(cascade.ids, ["gone-conversation", "vault-only"]);
  await deletion.applyVaultDeletionEdits(v.root(), cascade); assert.deepEqual(v.snapshot(), {});
});

test("physical deletion: durable pending intent cannot be lifted; restart retries the stored plan; complete intent survives purge and restore", async () => {
  testSupport.installFakeLocks();
  const w = deletionWorld("durable-delete"); const root = w.v.root(); root.isSameEntry = async () => true;
  await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
  await dbm.putVaultIdentityRecord({ id: "current", vaultId: "delete-vault", activeVaultEpoch: 0, registryGeneration: null, pairedAt: T } as never);
  await dbm.saveVaultHandle(root);
  await dbm.putMemoryObject(memory(w.t.id)); await dbm.deleteMemoryByUser(w.t.id, w.t.deletedAt);
  const seen = (await dbm.getTombstone("memory", w.t.id))!;
  const plan = await deletion.previewVaultDeletion(root, seen);
  require(path.join(OUT, "lib/fakeIdb.js")).__failNextPutOn("tsumugi", "settings");
  const untouched = w.v.snapshot();
  await assert.rejects(deletion.confirmVaultDeletion(root, plan));
  assert.deepEqual(w.v.snapshot(), untouched, "a failed intent/journal transaction authorizes no Vault write");
  assert.equal((await dbm.getTombstone("memory", w.t.id))!.physicalDeletion, undefined);
  assert.equal(await dbm.readPhysicalDeletionJournal("memory", w.t.id), undefined);
  w.v.writeShouldFail.add(".tsumugi/index.json");
  await assert.rejects(deletion.confirmVaultDeletion(root, plan), /simulated write failure/);
  const pending = (await dbm.getTombstone("memory", w.t.id))!;
  assert.equal(pending.physicalDeletion, "pending"); assert.equal(await life.allowBack(pending), false);
  assert.ok(await dbm.readPhysicalDeletionJournal("memory", w.t.id));
  w.v.perm.readwrite = "denied";
  await assert.rejects(deletion.retryVaultDeletion(root, pending), /permission-required/);
  w.v.perm.readwrite = "granted"; w.v.writeShouldFail.clear();
  w.v.put("moved/deep/renamed.MD", "torn Worker write after process termination");
  await assert.rejects(deletion.retryVaultDeletion(root, pending), /content-changed/);
  const evidence = await dbm.readPhysicalDeletionJournal("memory", w.t.id);
  await assert.rejects(deletion.previewVaultDeletion(root, pending), /content-review-required/);
  assert.equal(await dbm.readPhysicalDeletionJournal("memory", w.t.id), evidence, "ordinary preview cannot erase the recoverable retained bytes");
  const repair = await deletion.previewVaultDeletionRepair(root, pending);
  assert.equal(repair.edits.find((e) => e.path === "moved/deep/renamed.MD")!.before, "torn Worker write after process termination");
  assert.equal(repair.edits.find((e) => e.path === "moved/deep/renamed.MD")!.after, w.kept);
  w.v.put("moved/deep/renamed.MD", "a new external edit after repair preview");
  await assert.rejects(deletion.confirmVaultDeletion(root, repair), /preview-changed/);
  await deletion.confirmVaultDeletion(root, await deletion.previewVaultDeletionRepair(root, pending));
  const done = (await dbm.getTombstone("memory", w.t.id))!;
  assert.equal(done.physicalDeletion, "complete"); assert.equal(await dbm.readPhysicalDeletionJournal("memory", w.t.id), undefined);
  assert.equal(life.purgeDecision(done, "2030-01-01").purgeable, false);
  assert.equal(await dbm.restoreMemoryObjectIfNotNewer(memory(w.t.id)), "tombstoned");
  assert.equal(await dbm.addMemoryObjectIfAbsentAndMarkSynced(memory(w.t.id), "memory:" + w.t.id), false);
  assert.equal((await dbm.importMissingRecordsIfAbsent({ conversations: [], memoryObjects: [memory(w.t.id)], sources: [] })).insertedMemoryObjects, 0);
  const vault = require(path.join(OUT, "lib/vault.js")) as typeof import("../vault");
  const final = w.v.snapshot();
  await assert.rejects(vault.writeMemoryObjectMarkdown(root, memory(w.t.id)), /deleted-record-write-refused/);
  await assert.rejects(vault.writeMemoryObjectMarkdown(root, memory("live-old-snapshot", [{ sourceId: "live-old-snapshot", targetId: w.t.id }])), /deleted-reference-write-refused/);
  await assert.rejects(vault.writeConversationMarkdown(root, { id: "live-conversation", memoryObjectIds: [w.t.id] } as never), /deleted-reference-write-refused/);
  await dbm.setVaultSyncState("memory:" + w.t.id, "late-success");
  assert.equal(await dbm.getVaultSyncState("memory:" + w.t.id), undefined);
  assert.deepEqual(w.v.snapshot(), final, "a delayed Capture snapshot cannot recreate the erased Vault record");
  await dbm.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null } as never);
});

test("physical cascade discovery tombstones Vault-only children and cleans canonical references before any Vault write", async () => {
  testSupport.installFakeLocks();
  const v = new testSupport.FakeVault(); const root = v.root(); root.isSameEntry = async () => true;
  await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
  await dbm.putVaultIdentityRecord({ id: "current", vaultId: "cascade-vault", activeVaultEpoch: 0, registryGeneration: null, pairedAt: T } as never);
  await dbm.saveVaultHandle(root);
  const parent = "vault-only-parent", child = "vault-only-child", keeper = "child-link-holder";
  await dbm.putConversation({ id: parent, startedAt: T, updatedAt: T, createdAt: T, persona: "companion", status: "captured", turns: [], memoryObjectIds: [], metadata: meta });
  const b = { ...memory(keeper, [{ sourceId: keeper, targetId: child }]), conversationId: "different-conversation" };
  await dbm.putMemoryObject(b);
  await dbm.deleteConversationWithMemoriesByUser(parent);
  v.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "cascade-vault" }));
  v.put(".tsumugi/index.json", JSON.stringify({ [child]: "child.md", [keeper]: "keeper.md" }));
  v.put("child.md", md.memoryObjectToMarkdown({ ...memory(child), conversationId: parent }));
  v.put("keeper.md", md.memoryObjectToMarkdown(b));
  const seen = (await dbm.getTombstone("conversation", parent))!;
  const plan = await deletion.previewVaultDeletion(root, seen);
  const canonicalBefore = JSON.stringify(await dbm.getMemoryObject(keeper)); const vaultBefore = v.snapshot();
  await assert.rejects(dbm.beginPhysicalDeletion(seen, JSON.stringify(plan), [keeper]), /cascade-child-owner-changed/);
  assert.equal(JSON.stringify(await dbm.getMemoryObject(keeper)), canonicalBefore);
  assert.deepEqual(v.snapshot(), vaultBefore);
  v.writeShouldFail.add(".tsumugi/index.json");
  await assert.rejects(deletion.confirmVaultDeletion(root, plan));
  const childGuard = (await dbm.getTombstone("memory", child))!;
  assert.equal(childGuard.physicalDeletionParent, parent); assert.equal(await life.allowBack(childGuard), false);
  await assert.rejects(deletion.previewVaultDeletion(root, childGuard), /parent-deletion-required/);
  assert.deepEqual((await dbm.getMemoryObject(keeper))!.links, []);
  const vault = require(path.join(OUT, "lib/vault.js")) as typeof import("../vault");
  await assert.rejects(vault.writeMemoryObjectMarkdown(root, b), /deleted-reference-write-refused/);
  v.writeShouldFail.clear();
  await deletion.retryVaultDeletion(root, (await dbm.getTombstone("conversation", parent))!);
  assert.equal((await dbm.getTombstone("memory", child))!.physicalDeletion, "complete");
  assert.equal((await dbm.getTombstone("memory", child))!.physicalDeletionParent, undefined);
  await dbm.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null } as never);
});

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

test("the presence scan covers the whole visible Vault (record folders nested anywhere, like the restore scan), but not hidden folders", async () => {
  const v = new testSupport.FakeVault();
  v.put("archive/Memories/2026-01-01.md", md.serializeMemoryDayFile([memory("nested-mem")]));
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("memory", "nested-mem")), "present");
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("memory", "other")), "absent");
  const hidden = new testSupport.FakeVault();
  hidden.put(".tsumugi/recovery/x.md", md.serializeMemoryDayFile([memory("hidden-mem")]));
  assert.equal(await life.checkTombstoneInVault(hidden.root(), tomb("memory", "hidden-mem")), "absent");
});

test("verifying an empty Vault never replaces the user's 'keep the Vault copy' decision", async () => {
  await dbm.putMemoryObject(memory("kept-mem"));
  await dbm.deleteMemoryByUser("kept-mem", "2026-01-01T00:00:00.000Z");
  const seen = (await dbm.getTombstone("memory", "kept-mem"))!;
  assert.equal(await life.keepVaultCopy(seen, "2026-01-02T00:00:00.000Z"), true);
  assert.equal(await life.verifyTombstone(new testSupport.FakeVault().root(), "memory", "kept-mem", "2026-06-01T00:00:00.000Z"), "absent");
  assert.equal((await dbm.getTombstone("memory", "kept-mem"))!.vault, "kept");
  assert.deepEqual(await life.purgeEligibleTombstones(new testSupport.FakeVault().root(), "2027-01-01T00:00:00.000Z"), [], "kept is never purged");
});

test("a tombstone is bound to the Vault the record was deleted from: another Vault's emptiness neither verifies nor purges it", async () => {
  await dbm.putVaultIdentityRecord({ id: "current", vaultId: "vault-A", activeVaultEpoch: 0, registryGeneration: null, pairedAt: T } as never);
  await dbm.putMemoryObject(memory("bound-mem"));
  await dbm.deleteMemoryByUser("bound-mem", "2026-01-01T00:00:00.000Z");
  const t = (await dbm.getTombstone("memory", "bound-mem"))!;
  assert.equal(t.vaultId, "vault-A");
  const withId = (id: string) => { const v = new testSupport.FakeVault(); v.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: id })); return v; };
  const other = withId("vault-B");
  assert.equal(await life.verifyTombstone(other.root(), "memory", "bound-mem", "2026-06-01T00:00:00.000Z"), "unknown");
  assert.equal((await dbm.getTombstone("memory", "bound-mem"))!.vault, "unverified", "not marked absent");
  assert.deepEqual(await life.purgeEligibleTombstones(other.root(), "2027-01-01T00:00:00.000Z"), [], "an empty OTHER Vault does not allow forgetting");
  assert.equal(await life.verifyTombstone(new testSupport.FakeVault().root(), "memory", "bound-mem", "2026-06-01T00:00:00.000Z"), "unknown", "a Vault without identity can not be matched either");
  const same = withId("vault-A");                      // the original Vault, copy gone
  assert.equal(await life.verifyTombstone(same.root(), "memory", "bound-mem", "2026-06-01T00:00:00.000Z"), "absent");
  assert.deepEqual((await life.purgeEligibleTombstones(same.root(), "2027-01-01T00:00:00.000Z")).map((x) => x.id), ["bound-mem"]);
});

test("the presence scan reads frontmatter as generously as the restore parser: spaced / indented keys still count", async () => {
  const v = new testSupport.FakeVault();
  v.put("moved/a.md", "---\ntsumugi: true\n  id : spaced-1\n---\nbody\n");
  assert.equal(await life.checkTombstoneInVault(v.root(), tomb("conversation", "spaced-1")), "present");
  const v2 = new testSupport.FakeVault();
  v2.put("moved/b.md", "---\ntsumugi: true\nid: 'quoted-1'\n---\nbody\n");
  assert.equal(await life.checkTombstoneInVault(v2.root(), tomb("conversation", "quoted-1")), "present");
});

test("a child Memory can not be allowed back while the cascade tombstone of its Conversation is in place: refused, nothing changes, the Conversation guard lifts first", async () => {
  await dbm.putConversation({ id: "cg-conv", persona: "companion", status: "captured", startedAt: T, createdAt: T, updatedAt: T, turns: [], memoryObjectIds: ["cg-child"], metadata: meta } as never);
  await dbm.putMemoryObject({ ...memory("cg-child"), conversationId: "cg-conv" });
  await dbm.deleteConversationWithMemoriesByUser("cg-conv", "2026-01-01T00:00:00.000Z");
  const child = (await dbm.getTombstone("memory", "cg-child"))!;
  const before = JSON.stringify(await dbm.listTombstones());
  assert.equal(await life.allowBack(child), "parent-guard");
  assert.equal(JSON.stringify(await dbm.listTombstones()), before, "no tombstone was removed");
  assert.equal(await dbm.restoreMemoryObjectIfNotNewer({ ...memory("cg-child"), conversationId: "cg-conv" }), "tombstoned", "and the Memory is still not restorable");
  // lifting the Conversation's guard first makes the child's own allow-back possible
  assert.equal(await life.allowBack((await dbm.getTombstone("conversation", "cg-conv"))!), true);
  assert.equal(await life.allowBack((await dbm.getTombstone("memory", "cg-child"))!), true);
  // a Memory deleted on its own (no cascade) is unaffected
  await dbm.putMemoryObject({ ...memory("solo-mem"), conversationId: "solo-conv" });
  await dbm.deleteMemoryByUser("solo-mem", "2026-01-01T00:00:00.000Z");
  assert.equal(await life.allowBack((await dbm.getTombstone("memory", "solo-mem"))!), true);
});

// ---- Resuming a physical deletion after the same Vault was reconnected (the world epoch moved on) -------------------------------------------------------
async function pairedWorld(id: string) {
  testSupport.installFakeLocks();
  const w = deletionWorld(id); const root = w.v.root(); root.isSameEntry = async () => true;
  const epoch = await dbm.getActiveVaultEpoch();
  await dbm.markVaultEpochCommitted(epoch); await dbm.markVaultWorldJournalMigrated();
  await dbm.putVaultIdentityRecord({ id: "current", vaultId: "delete-vault", activeVaultEpoch: epoch, registryGeneration: null, pairedAt: T } as never);
  await dbm.saveVaultHandle(root);
  await dbm.putMemoryObject(memory(w.t.id)); await dbm.deleteMemoryByUser(w.t.id, w.t.deletedAt);
  return { w, root };
}
/** the app connects (the same or another) Vault: the world epoch advances and the identity record follows */
async function connect(vaultId: string, root: FileSystemDirectoryHandle) {
  const e = await dbm.getActiveVaultEpoch();
  await dbm.bumpActiveVaultEpoch(e); await dbm.markVaultEpochCommitted(e + 1);
  await dbm.putVaultIdentityRecord({ id: "current", vaultId, activeVaultEpoch: e + 1, registryGeneration: null, pairedAt: T } as never);
  await dbm.saveVaultHandle(root);
}
async function failHalfway(id: string) {
  const { w, root } = await pairedWorld(id);
  const plan = await deletion.previewVaultDeletion(root, (await dbm.getTombstone("memory", w.t.id))!);
  w.v.writeShouldFail.add(".tsumugi/index.json");
  await assert.rejects(deletion.confirmVaultDeletion(root, plan), /simulated write failure/);
  w.v.writeShouldFail.clear();
  return { w, root, pending: (await dbm.getTombstone("memory", w.t.id))! };
}

test("a deletion that failed halfway resumes after the SAME Vault was reconnected, but only after the changes are shown again and confirmed (nothing runs by itself)", async () => {
  const { w, root, pending } = await failHalfway("rebind-same");
  assert.equal(pending.physicalDeletion, "pending");
  await connect("delete-vault", root);                                        // reconnecting the same folder advances the epoch
  const stuck = w.v.snapshot(); const evidence = await dbm.readPhysicalDeletionJournal("memory", w.t.id);
  await assert.rejects(deletion.retryVaultDeletion(root, pending), /journal-world-mismatch/);        // the one-click retry does NOT resume by itself
  assert.deepEqual(w.v.snapshot(), stuck, "no file changed"); assert.equal(await dbm.readPhysicalDeletionJournal("memory", w.t.id), evidence);
  assert.equal((await dbm.getTombstone("memory", w.t.id))!.physicalDeletion, "pending", "the guard is kept");
  const plan = await deletion.previewVaultDeletion(root, pending);              // the review step is allowed
  assert.equal(plan.epoch, await dbm.getActiveVaultEpoch(), "rebuilt under the current epoch");
  assert.deepEqual(w.v.snapshot(), stuck, "the preview is read only");
  await deletion.confirmVaultDeletion(root, plan);                              // explicit confirmation completes it
  const done = (await dbm.getTombstone("memory", w.t.id))!;
  assert.equal(done.physicalDeletion, "complete"); assert.equal(await dbm.readPhysicalDeletionJournal("memory", w.t.id), undefined);
  assert.equal(w.v.snapshot()["moved/deep/renamed.MD"], w.kept, "the other record in the shared file survives");
  assert.equal(w.v.snapshot()["another/copy.md"], undefined);
  assert.equal(await dbm.restoreMemoryObjectIfNotNewer(memory(w.t.id)), "tombstoned");
});

test("switching to ANOTHER Vault refuses everything and changes nothing; coming back to the original Vault resumes it", async () => {
  const { w, root, pending } = await failHalfway("rebind-other");
  const other = new testSupport.FakeVault(); other.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "another-vault" }));
  other.put("another-note.md", "---\ntsumugi: true\nid: unrelated\n---\n"); const otherRoot = other.root(); otherRoot.isSameEntry = async () => true;
  await connect("another-vault", otherRoot);
  const before = w.v.snapshot(), otherBefore = other.snapshot(); const evidence = await dbm.readPhysicalDeletionJournal("memory", w.t.id);
  await assert.rejects(deletion.previewVaultDeletion(otherRoot, pending)); await assert.rejects(deletion.retryVaultDeletion(otherRoot, pending));
  await assert.rejects(deletion.previewVaultDeletionRepair(otherRoot, pending));
  await assert.rejects(deletion.previewVaultDeletion(root, pending), "the original folder is not the connected Vault now");
  assert.deepEqual(w.v.snapshot(), before); assert.deepEqual(other.snapshot(), otherBefore);
  const t = (await dbm.getTombstone("memory", w.t.id))!;
  assert.equal(t.physicalDeletion, "pending"); assert.equal(await dbm.readPhysicalDeletionJournal("memory", w.t.id), evidence);
  assert.equal(await life.allowBack(t), false, "the guard can not be lifted while the deletion is pending");
  assert.equal(await dbm.restoreMemoryObjectIfNotNewer(memory(w.t.id)), "tombstoned");
  await connect("delete-vault", root);                                          // back to the original Vault (a newer epoch again)
  await deletion.confirmVaultDeletion(root, await deletion.previewVaultDeletion(root, (await dbm.getTombstone("memory", w.t.id))!));
  assert.equal((await dbm.getTombstone("memory", w.t.id))!.physicalDeletion, "complete");
});

test("after a reconnect, an externally changed file is refused (the content must still be exactly the saved before / after state) and nothing is written", async () => {
  const { w, root, pending } = await failHalfway("rebind-edited");
  await connect("delete-vault", root);
  w.v.put("moved/deep/renamed.MD", "someone edited this file by hand after the interruption");
  const before = w.v.snapshot(); const evidence = await dbm.readPhysicalDeletionJournal("memory", w.t.id);
  await assert.rejects(deletion.previewVaultDeletion(root, pending), /content-review-required/);
  await assert.rejects(deletion.retryVaultDeletion(root, pending));
  assert.deepEqual(w.v.snapshot(), before); assert.equal(await dbm.readPhysicalDeletionJournal("memory", w.t.id), evidence, "the retained evidence is kept");
  assert.equal((await dbm.getTombstone("memory", w.t.id))!.physicalDeletion, "pending");
});

test("a torn write still needs the explicit content review (repair) after a reconnect; the ordinary resume never accepts it", async () => {
  const { w, root, pending } = await failHalfway("rebind-torn");
  w.v.put("moved/deep/renamed.MD", "torn Worker write after process termination");
  await connect("delete-vault", root);
  const torn = w.v.snapshot();
  await assert.rejects(deletion.previewVaultDeletion(root, pending), /content-review-required/);
  await assert.rejects(deletion.retryVaultDeletion(root, pending));
  assert.deepEqual(w.v.snapshot(), torn);
  const repair = await deletion.previewVaultDeletionRepair(root, pending);     // the existing review-and-repair flow works under the new epoch
  assert.equal(repair.epoch, await dbm.getActiveVaultEpoch());
  assert.equal(repair.edits.find((e) => e.path === "moved/deep/renamed.MD")!.before, "torn Worker write after process termination");
  assert.deepEqual(w.v.snapshot(), torn, "the repair preview is read only");
  await deletion.confirmVaultDeletion(root, repair);
  assert.equal((await dbm.getTombstone("memory", w.t.id))!.physicalDeletion, "complete");
  assert.equal(w.v.snapshot()["moved/deep/renamed.MD"], w.kept);
});
