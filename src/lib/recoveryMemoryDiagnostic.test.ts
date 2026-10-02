/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { MemoryObject } from "./types";
import type { RecoveryApplyPlan } from "./vaultRecoveryApply";
import type { RecoveryLocalSnapshot } from "./vaultRecovery";
const { inspectHeldMemories, runHeldMemoryDiagnostic, memoryDifferenceFields } = require("./recoveryMemoryDiagnostic") as typeof import("./recoveryMemoryDiagnostic");
const { serializeMemoryDayFile, parseMemoryDayFile, inferSourceType } = require("./markdown") as typeof import("./markdown");
const { dayFileRegistryKey, vaultRegistryBucketOf, hashVaultText } = require("./vault") as typeof import("./vault");
const T = "2026-09-20T00:00:00.000Z";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function memory(i: number): MemoryObject {
  return { id: `SECRET-ID-${i}`, date: T, content: "SECRET-CONTENT", summary: "SECRET-SUMMARY", types: ["event"],
    conversationId: "SECRET-CONVERSATION", keywords: ["SECRET-KEYWORD"], links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T, updatedAt: T, metadata: { id: "SECRET-META", source: "ai-capture", schemaVersion: "0.1", createdAt: T, updatedAt: T } } as MemoryObject;
}
function fixture(mode = "status") {
  const local: RecoveryLocalSnapshot = { conversations: [], memories: Array.from({ length: 35 }, (_, i) => memory(i)), sources: [], sync: {} };
  const stored = clone(local.memories);
  for (let i = 30; i < 35; i++) stored[i].updatedAt = "2026-09-19T00:00:00.000Z";
  if (mode === "content") stored[30].content = "OTHER-SECRET";
  if (mode === "metadata") { stored[30] = clone(local.memories[30]); stored[30].metadata.confidence = 0.1; }
  if (mode === "timestamps") stored[30].createdAt = "2026-09-18T00:00:00.000Z";
  const path = "Memories/SECRET-PATH.md", key = dayFileRegistryKey(T.slice(0, 10));
  const shardPath = `.tsumugi/registry/${vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`;
  const raw = serializeMemoryDayFile(stored) + (mode === "reserialize" ? "\n\n" : "");
  const entry = { status: mode === "status" || ["content", "metadata", "timestamps"].includes(mode) ? "conflict" : "ok",
    contentHash: mode === "hash" ? "outdated" : mode === "reserialize" ? hashVaultText(serializeMemoryDayFile(parseMemoryDayFile(raw))) : hashVaultText(raw),
    memberIds: stored.map(m => m.id).slice(mode === "members" ? 1 : 0) };
  const files = new Map([[path, raw], [shardPath, JSON.stringify({ records: { [key]: path }, files: { [path]: entry } })]]);
  let reads = 0, writes = 0;
  const forbid = () => { writes++; throw new Error("forbidden"); };
  const dir = (prefix = ""): FileSystemDirectoryHandle => ({
    kind: "directory", name: "fixture", createWritable: forbid, removeEntry: forbid, entries: forbid,
    async getDirectoryHandle(name: string, options?: { create?: boolean }) { if (options?.create !== false) forbid(); return dir(prefix + name + "/"); },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (options?.create !== false) forbid();
      return { createWritable: forbid, createSyncAccessHandle: forbid, async getFile() {
        reads++; const text = files.get(prefix + name); if (text === undefined) throw new DOMException("SECRET", "NotFoundError");
        return { text: async () => text };
      } };
    },
  } as unknown as FileSystemDirectoryHandle);
  const records = local.memories.map((m, i) => ({ recordId: m.id, recordType: "memory", indexedDBExists: true, vaultPaths: [path], registryKey: key, classification: i < 30 ? "equivalent-existing" : "conflict" }));
  const plan = { heldCount: 35, held: local.memories.map((m, i) => ({ recordId: m.id, recordType: "memory", reason: i < 30 ? "registry-entry-differs" : "conflict" })),
    snapshot: clone(local), plan: { scanCompleted: true, issues: [], records }, confirmed: { world: { activeVaultEpoch: 1, committedVaultEpoch: 1, registryGenerationEpoch: 0, journalVersion: "current", backend: "file-system-access" } } } as unknown as RecoveryApplyPlan;
  return { local, plan, files, root: dir(), path, shardPath, forbid, reads: () => reads, writes: () => writes,
    run: () => inspectHeldMemories(plan, dir(), async () => clone(local), () => true) };
}
for (const [mode, field] of [["status", "statusMismatch"], ["hash", "rawHashMismatch"], ["reserialize", "reserializeOnlyMatch"], ["members", "memberIdsMismatch"]] as const) {
  test(`${mode}: production raw/parser/serializer, 30 members share one day entry`, async () => {
    const f = fixture(mode), before = [...f.files]; const result = await f.run();
    assert.equal(result.status, "complete"); if (result.status !== "complete") return;
    assert.equal(result.registry[field], 1); assert.equal(result.registry.dayFileCount, 1); assert.equal(result.registry.heldMemoryCount, 30);
    assert.deepEqual([...f.files], before); assert.equal(f.writes(), 0);
  });
}
test("updatedAt only", async () => { const r = await fixture().run(); assert.equal(r.status, "complete"); if (r.status === "complete") { assert.equal(r.conflicts["updatedAt-only"], 5); assert.deepEqual(r.conflicts.fields, { updatedAt: 5 }); } });
for (const [mode, category] of [["timestamps", "timestamp-only"], ["metadata", "metadata-only"], ["content", "substantive-data-difference"]] as const) {
  test(category, async () => { const r = await fixture(mode).run(); assert.equal(r.status, "complete"); if (r.status === "complete") assert.equal(r.conflicts[category], 1); });
}
test("closed output never contains individual values, including IO errors", async () => {
  const f = fixture("content"); let text = JSON.stringify(await f.run());
  for (const v of ["SECRET", T, f.path, "recordId", "conversationId"]) assert.ok(!text.includes(v));
  f.files.clear(); text = JSON.stringify(await f.run()); assert.equal(text, '{"status":"unavailable"}');
});
test("wrong counts stop before any IO", async () => { const f = fixture(); f.plan.heldCount = 34; assert.deepEqual(await f.run(), { status: "mismatch" }); assert.equal(f.reads(), 0); });
test("wrong reason or duplicate targets rejected", async () => { const f = fixture(); f.plan.held[0].reason = "other"; assert.deepEqual(await f.run(), { status: "mismatch" }); });
test("changed canonical or current UI rejected", async () => {
  const f = fixture(); f.local.memories[0].summary = "CHANGED"; assert.deepEqual(await f.run(), { status: "mismatch" });
  assert.deepEqual(await inspectHeldMemories(f.plan, f.root, async () => f.local, () => false), { status: "mismatch" });
});
test("reason no longer true aborts instead of measuring stale plan", async () => {
  const f = fixture(); const shard = JSON.parse(f.files.get(f.shardPath)!); shard.files[f.path].status = "ok"; f.files.set(f.shardPath, JSON.stringify(shard));
  assert.deepEqual(await f.run(), { status: "mismatch" });
});
test("file mutation before second read aborts", async () => {
  const f = fixture(); let n = 0;
  const root = new Proxy(f.root, { get(target, prop) { if (prop === "getDirectoryHandle") return async (...args: Parameters<FileSystemDirectoryHandle["getDirectoryHandle"]>) => { if (++n === 3) f.files.set(f.path, f.files.get(f.path)! + "\n"); return target.getDirectoryHandle(...args); }; return Reflect.get(target, prop); } });
  assert.deepEqual(await inspectHeldMemories(f.plan, root, async () => clone(f.local), () => true), { status: "mismatch" });
});
test("production sourceType/date normalization and evidence semantics", () => {
  const a = memory(0), b = clone(a); b.date = T.slice(0, 10) + "T12:00:00.000Z"; b.metadata.sourceType = inferSourceType(a.metadata.source);
  assert.deepEqual(memoryDifferenceFields(a, b), []);
  b.evidenceQuotes = ["SECRET-EVIDENCE"]; assert.deepEqual(memoryDifferenceFields(a, b), ["evidenceQuotes"]);
});

/** Browser entry-point test: real existing-only DB readers; every mutator is a trap. */
test("production runner: readonly DB, exclusive lock, no scan/write/save and unchanged storage", async () => {
  const f = fixture(), before = JSON.stringify({ files: [...f.files], local: f.local }); let held = false, txCount = 0;
  const settings: Record<string, string> = { activeVaultEpoch: "1", committedVaultEpoch: "1", vaultWorldJournalVersion: "1", registryGenerationEpoch: "0" };
  const stores: Record<string, unknown> = { conversations: [], memoryObjects: f.local.memories, sources: [], vaultSyncState: {}, settings };
  const factory = {
    async databases() { return [{ name: "tsumugi", version: 6 }]; },
    open(name: string, version?: number) {
      assert.equal(name, "tsumugi"); assert.equal(version, undefined);
      const req: Record<string, unknown> = {};
      req.result = { version: 6, objectStoreNames: { contains: (n: string) => n in stores }, close() {},
        transaction(names: string[], mode: string) {
          assert.equal(mode, "readonly"); assert.ok(held); txCount++;
          const tx: Record<string, unknown> = {};
          const result = (v: unknown) => { const r: Record<string, unknown> = { result: v === undefined ? undefined : clone(v) }; queueMicrotask(() => (r.onsuccess as () => void)()); return r; };
          tx.objectStore = (name: string) => ({ get: (key: string) => { assert.equal(name, "settings"); assert.ok(key in settings); return result(settings[key]); },
            getAll: () => { assert.notEqual(name, "settings"); return result(name === "vaultSyncState" ? [] : stores[name]); }, getAllKeys: () => result([]),
            put: f.forbid, add: f.forbid, delete: f.forbid, clear: f.forbid });
          setTimeout(() => (tx.oncomplete as () => void)(), 0); return tx;
        }, createObjectStore: f.forbid, deleteObjectStore: f.forbid };
      queueMicrotask(() => (req.onsuccess as () => void)()); return req;
    }, deleteDatabase: f.forbid,
  } as unknown as IDBFactory;
  const locks = { async request(name: string, options: LockOptions, fn: (lock: object) => Promise<unknown>) { assert.equal(name, "tsumugi-vault-world"); assert.equal(options.mode, "exclusive"); assert.equal(options.ifAvailable, true); held = true; try { return await fn({}); } finally { held = false; } } } as unknown as LockManager;
  assert.equal((await runHeldMemoryDiagnostic(f.plan, f.root, () => true, factory, locks)).status, "complete");
  assert.equal(txCount, 4); assert.equal(f.writes(), 0); assert.equal(JSON.stringify({ files: [...f.files], local: f.local }), before);
});
test("UI mount only exposes explicit diagnostic; no normal action invoked", () => {
  const ui = fs.readFileSync("src/components/RecoveryMemoryDiagnosticPanel.tsx", "utf8");
  for (const token of ["cleanup(", "applyRecovery(", "planRecoveryApply(", "console.", "navigator.clipboard"]) assert.ok(!ui.includes(token));
  const main = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  assert.ok(main.includes('showAdvancedVaultTools && recoveryStatus.kind === "plan"'));
});

test("all production compared fields accounted for; excluded fields remain excluded", () => {
  const a = memory(0);
  const changes: Record<string, unknown> = { id: "other", date: "2026-09-21", types: ["preference"], content: "other", summary: "other", keywords: ["other"], conversationId: "other", links: [{ targetId: "other", reason: "other" }], eventTime: "2026-09-10", eventTimePrecision: "day", createdAt: "other", updatedAt: "other", topicId: "other", profileClaims: [{}], personMentions: [{}], topicEvents: [{}], evidenceQuotes: ["other"] };
  for (const [field, value] of Object.entries(changes)) { const b = clone(a); Object.assign(b, { [field]: value }); assert.deepEqual(memoryDifferenceFields(a, b), [field]); }
  for (const [field, value] of Object.entries({ sourceDetail: { type: "other" }, aiProvider: "other", confidence: 0.2, schemaVersion: "other", sourceType: "manual" })) {
    const b = clone(a); Object.assign(b.metadata, { [field]: value }); assert.deepEqual(memoryDifferenceFields(a, b), [`metadata.${field}`]);
  }
  const b = clone(a); b.metadata.source = "user-authored"; assert.deepEqual(memoryDifferenceFields(a, b), ["metadata.source", "metadata.sourceType"]);
  const c = clone(a); c.metadata.id = "other"; c.revisitPrompt = "other"; c.themeIds = ["other"]; assert.deepEqual(memoryDifferenceFields(a, c), []);
});
test("duplicate target IDs and incomplete scans rejected", async () => {
  const f = fixture(); f.plan.held[1].recordId = f.plan.held[0].recordId; assert.deepEqual(await f.run(), { status: "mismatch" });
  const g = fixture(); g.plan.plan.scanCompleted = false; assert.deepEqual(await g.run(), { status: "mismatch" });
});
test("malformed or duplicate member stops, no partial aggregate", async () => {
  const f = fixture(); f.files.set(f.path, f.files.get(f.path)! + "\n<!-- tsumugi:entry -->\n\nnot-memory"); assert.notEqual((await f.run()).status, "complete");
  const g = fixture(); g.files.set(g.path, g.files.get(g.path)! + "\n<!-- tsumugi:entry -->\n\n" + serializeMemoryDayFile([g.local.memories[0]])); assert.notEqual((await g.run()).status, "complete");
});
test("busy lock does not open DB or read Vault", async () => {
  const f = fixture(); const factory = { databases: f.forbid, open: f.forbid } as unknown as IDBFactory;
  const locks = { request: async (_n: string, _o: unknown, cb: (lock: null) => Promise<unknown>) => cb(null) } as unknown as LockManager;
  assert.deepEqual(await runHeldMemoryDiagnostic(f.plan, f.root, () => true, factory, locks), { status: "unavailable" }); assert.equal(f.reads(), 0); assert.equal(f.writes(), 0);
});

const { compareDiagnosticLinks } = require("./recoveryMemoryDiagnostic") as typeof import("./recoveryMemoryDiagnostic");
const edge = (id: string, sourceId = "SECRET-ID-30", targetId = "SECRET-ID-0"): import("./types").Link => ({
  id, sourceId, targetId, axis: "theme", reason: "SECRET-LINK", contrast: false, strength: 0.8, createdBy: "ai-inference", createdAt: T,
});
for (const [name, a, b] of [
  ["same-set-order-only", [edge("A"), edge("B")], [edge("B"), edge("A")]],
  ["canonical-strict-superset", [edge("A"), edge("B")], [edge("A")]],
  ["vault-strict-superset", [edge("A")], [edge("A"), edge("B")]],
  ["both-have-unique-links", [edge("A")], [edge("B")]],
  ["same-link-id-content-difference", [edge("A")], [{ ...edge("A"), strength: 0.2 }]],
  ["same-order-and-content", [edge("A")], [edge("A")]],
] as const) test(`Link classification: ${name}`, () => {
  assert.equal(compareDiagnosticLinks([...a], [...b]).category, name);
});
test("duplicate Link identity is indeterminate, not a false superset", () => {
  assert.throws(() => compareDiagnosticLinks([edge("A"), edge("A")], []));
});
for (const scenario of ["matching", "different", "missing", "reverse"] as const) test(`Link counterpart ${scenario}, anonymous readonly integration`, async () => {
  const f = fixture();
  const link = scenario === "reverse" ? edge("SECRET-LINK-ID", "SECRET-ID-0", "SECRET-ID-30")
    : edge("SECRET-LINK-ID", "SECRET-ID-30", scenario === "missing" ? "ABSENT" : "SECRET-ID-0");
  const stored = parseMemoryDayFile(f.files.get(f.path)!);
  stored[30].links = [link]; // Vault-only Link.
  if (scenario !== "missing") {
    const counterpart = scenario === "different" ? { ...link, reason: "OTHER-SECRET" } : link;
    f.local.memories[0].links = [counterpart]; stored[0].links = [counterpart];
  }
  f.plan.snapshot = clone(f.local);
  f.files.set(f.path, serializeMemoryDayFile(stored));
  const before = JSON.stringify([...f.files]), localBefore = JSON.stringify(f.local);
  const r = await f.run(); assert.equal(r.status, "complete"); if (r.status !== "complete") return;
  assert.equal(r.links.categories["vault-strict-superset"], 1);
  const key = scenario === "missing" ? "indeterminate" : scenario === "different" ? "no-matching-link" : "counterpart-memory-has-matching-link";
  assert.equal(r.links.canonicalCounterpart[key], 1);
  assert.equal(r.links.storageEvidence.indeterminate, 5);
  assert.ok(!JSON.stringify(r).includes("SECRET")); assert.ok(!JSON.stringify(r).includes(T));
  assert.equal(JSON.stringify([...f.files]), before); assert.equal(JSON.stringify(f.local), localBefore); assert.equal(f.writes(), 0);
});
