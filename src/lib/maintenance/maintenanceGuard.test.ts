/**
 * GuardedVault (prevention of unplanned writes) and the whole-folder tree snapshot/diff (detection), including what they CANNOT see.
 * Run: `npm run test:maintenance`.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const OUT = path.join(__dirname, "..", "..");
const guardMod = require(path.join(OUT, "lib/maintenance/vaultGuard.js")) as typeof import("./vaultGuard");
const { FakeVault } = require(path.join(OUT, "lib/maintenance/testSupport.js")) as typeof import("./testSupport");

function vault() {
  const v = new FakeVault();
  v.put("Memories/2026-08-20.md", "day-file"); v.put("Conversations/c1.md", "conv"); v.put(".tsumugi/index.json", "{}"); v.put("Notes/unrelated.md", "note"); v.put("Notes/sub/deep.md", "deep");
  return v;
}
const write = async (h: any, name: string, text: string) => { const f = await h.getFileHandle(name, { create: true }); const w = await f.createWritable(); await w.write(text); await w.close(); };

test("guard: planned files can be written, everything else is refused before it happens", async () => {
  const v = vault(); const planned = new Set(["Memories/2026-08-20.md", ".tsumugi/index.json", ".tsumugi/registry/2d.json"]);
  const g = new guardMod.GuardedVault(v.root(), planned); const root = g.root();
  const mem = await root.getDirectoryHandle("Memories"); await write(mem, "2026-08-20.md", "new day-file");
  assert.equal(v.files.get("Memories/2026-08-20.md")!.content, "new day-file");
  const ts = await root.getDirectoryHandle(".tsumugi"); await write(ts, "index.json", "{\"a\":1}");
  const reg = await ts.getDirectoryHandle("registry", { create: true }); await write(reg, "2d.json", "{}"); // new directory + planned new file
  assert.equal(g.blocked.length, 0);
  // unplanned create
  await assert.rejects(write(mem, "2026-08-21.md", "x"), /guarded-vault/);
  assert.equal(v.files.has("Memories/2026-08-21.md"), false, "nothing was created");
  // unplanned write to an EXISTING file (opened without create)
  const conv = await root.getDirectoryHandle("Conversations"); const f = await conv.getFileHandle("c1.md");
  await assert.rejects(async () => (await f.createWritable()), /guarded-vault/);
  assert.equal(v.files.get("Conversations/c1.md")!.content, "conv");
  // unplanned directory creation, removal
  await assert.rejects(root.getDirectoryHandle("Elsewhere", { create: true }), /guarded-vault/);
  await assert.rejects((mem as any).removeEntry("2026-08-20.md"), /guarded-vault/);
  assert.equal(v.files.has("Memories/2026-08-20.md"), true);
  assert.ok(g.blocked.some((b) => b.startsWith("create-file:Memories/2026-08-21.md")) && g.blocked.some((b) => b.startsWith("write:Conversations/c1.md")) && g.blocked.some((b) => b.startsWith("remove:")) && g.blocked.some((b) => b.startsWith("create-directory:Elsewhere")));
  // reads pass through
  const read = await (await root.getDirectoryHandle("Notes")).getFileHandle("unrelated.md"); assert.equal(await (await read.getFile()).text(), "note");
});

test("tree snapshot / diff: unexpected create, change and delete are all found (Tsumugi areas by content hash, others by size + mtime)", async () => {
  const v = vault(); const before = await guardMod.snapshotTree(v.root());
  v.put("Memories/2026-08-20.md", "changed day-file");      // planned
  v.put("Memories/2026-08-21.md", "created");               // unplanned create
  v.put("Notes/unrelated.md", "note edited");               // unplanned change (other area)
  v.put(".tsumugi/index.json", "{ }");                      // unplanned change (planned set below does not include it)
  v.files.delete("Conversations/c1.md");                    // unplanned delete
  v.put("Notes/newdir/x.md", "x");                          // new directory + file
  const after = await guardMod.snapshotTree(v.root());
  const d = guardMod.diffTree(before, after, new Set(["Memories/2026-08-20.md"]));
  assert.deepEqual(d.unexpected.created.sort(), ["Memories/2026-08-21.md", "Notes/newdir", "Notes/newdir/x.md"].sort());
  assert.deepEqual(d.unexpected.changed.sort(), [".tsumugi/index.json", "Notes/unrelated.md"].sort());
  assert.deepEqual(d.unexpected.deleted.sort(), ["Conversations", "Conversations/c1.md"]); // (the fake Vault drops an emptied directory)
  assert.deepEqual(d.planned.plannedWritten, ["Memories/2026-08-20.md"]);
});

test("tree snapshot: directories that lead to a planned file are not 'unexpected'", async () => {
  const v = vault(); const before = await guardMod.snapshotTree(v.root());
  v.put(".tsumugi/registry/2d.json", "{}");
  const d = guardMod.diffTree(before, await guardMod.snapshotTree(v.root()), new Set([".tsumugi/registry/2d.json"]));
  assert.deepEqual(d.unexpected, { created: [], changed: [], deleted: [] });
});

test("KNOWN LIMITS (documented, asserted): a same-size edit that preserves mtime outside the Tsumugi areas, and changes made and reverted between the snapshots, are not detectable", async () => {
  const v = vault(); const before = await guardMod.snapshotTree(v.root());
  // (1) outside .tsumugi / Memories / Conversations / Sources only size + mtime are compared
  const keep = v.files.get("Notes/unrelated.md")!; v.files.set("Notes/unrelated.md", { content: "NOTE", mtime: keep.mtime }); // same size, same mtime
  // (2) created then removed again between the two snapshots
  v.put("Notes/transient.md", "t"); v.files.delete("Notes/transient.md");
  const d = guardMod.diffTree(before, await guardMod.snapshotTree(v.root()), new Set());
  assert.deepEqual(d.unexpected, { created: [], changed: [], deleted: [] });
  // inside a Tsumugi area the same trick IS detected (content hash)
  const idx = v.files.get(".tsumugi/index.json")!; v.files.set(".tsumugi/index.json", { content: "{x}", mtime: idx.mtime });
  const d2 = guardMod.diffTree(before, await guardMod.snapshotTree(v.root()), new Set());
  assert.deepEqual(d2.unexpected.changed, [".tsumugi/index.json"]);
});
