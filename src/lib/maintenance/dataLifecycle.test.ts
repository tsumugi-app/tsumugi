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
  const purged = await life.purgeEligibleTombstones("2026-10-23T00:00:00.000Z");
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
