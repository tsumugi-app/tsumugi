/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias */
/** Standalone Node tests; compile to a temporary directory, no browser/real Vault access. */
import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation, MemoryObject, Source } from "./types";
import type { RecoveryLocalSnapshot } from "./vaultRecovery";
const { buildVaultRecoveryPlan, readRecoveryJson, readRecoveryLocalSnapshot } = require("./vaultRecovery") as typeof import("./vaultRecovery");
const { conversationToMarkdown, memoryObjectToMarkdown, sourceToMarkdown } = require("./markdown") as typeof import("./markdown");
const { vaultRegistryBucketOf, hashVaultText } = require("./vault") as typeof import("./vault");
const T = "2026-09-24T12:00:00.000Z";
const meta = { id: "meta", source: "ai-capture", schemaVersion: "1", createdAt: T, updatedAt: T };
const conversation = (id = "c1"): Conversation => ({ id, persona: "companion", status: "captured", startedAt: T, endedAt: T,
  createdAt: T, updatedAt: T, turns: [{ role: "user", content: "離乳食を始めた", timestamp: T }], memoryObjectIds: [], metadata: { ...meta } } as Conversation);
const memory = (id = "m1"): MemoryObject => ({ id, date: T, content: "離乳食を始めた", summary: "離乳食を始めた", types: ["event"],
  conversationId: "c1", keywords: [], links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
  createdAt: T, updatedAt: T, metadata: { ...meta } } as MemoryObject);
const local = (conversations: Conversation[] = [], memories: MemoryObject[] = []): RecoveryLocalSnapshot => ({ conversations, memories, sources: [], sync: {} });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

class ReadOnlyVault {
  files: Record<string, string>;
  failures = new Map<string, string>();
  failWalk: string | null = null;
  duplicatePath: string | null = null;
  reads: string[] = [];
  mutations = 0;
  constructor(files: Record<string, string> = {}) { this.files = { ...files }; }
  error(name: string): never { throw new DOMException("redacted", name); }
  forbid = (): never => { this.mutations++; throw new Error("WRITE FORBIDDEN"); };
  dir(prefix = ""): FileSystemDirectoryHandle {
    const self = this;
    return {
      kind: "directory", name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        assert.equal(options?.create, false); const path = prefix ? `${prefix}/${name}` : name;
        if (self.failures.has(path)) self.error(self.failures.get(path)!);
        if (!Object.keys(self.files).some(k => k.startsWith(path + "/"))) self.error("NotFoundError");
        return self.dir(path);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        assert.equal(options?.create, false); const path = prefix ? `${prefix}/${name}` : name;
        if (self.failures.has(path)) self.error(self.failures.get(path)!);
        if (!(path in self.files)) self.error("NotFoundError"); return self.file(path);
      },
      async *entries() {
        const children = new Map<string, "directory" | "file">();
        for (const path of Object.keys(self.files)) {
          if (prefix && !path.startsWith(prefix + "/")) continue;
          const relative = prefix ? path.slice(prefix.length + 1) : path;
          children.set(relative.split("/")[0], relative.includes("/") ? "directory" : "file");
        }
        for (const [name, kind] of children) {
          const path = prefix ? `${prefix}/${name}` : name;
          const value = kind === "directory" ? self.dir(path) : self.file(path);
          yield [name, value]; if (path === self.duplicatePath) yield [name, value];
          if (self.failWalk === prefix) self.error("NotReadableError");
        }
      },
      removeEntry: self.forbid,
    } as unknown as FileSystemDirectoryHandle;
  }
  file(path: string): FileSystemFileHandle {
    const self = this;
    return { kind: "file", name: path.split("/").pop(), createWritable: self.forbid, createSyncAccessHandle: self.forbid,
      async getFile() {
        self.reads.push(path);
        if (self.failures.has(`${path}:getFile`)) self.error(self.failures.get(`${path}:getFile`)!);
        return { size: self.files[path].length, lastModified: 1, async text() {
          if (self.failures.has(`${path}:text`)) self.error(self.failures.get(`${path}:text`)!);
          return self.files[path];
        } };
      },
    } as unknown as FileSystemFileHandle;
  }
}
async function plan(v: ReadOnlyVault, s: RecoveryLocalSnapshot) {
  const filesBefore = clone(v.files), localBefore = clone(s);
  const result = await buildVaultRecoveryPlan(v.dir(), s);
  assert.deepEqual(v.files, filesBefore); assert.deepEqual(s, localBefore); assert.equal(v.mutations, 0);
  assert.ok(result.records.every(r => r.automaticRepairAllowed === false));
  return result;
}
const baselineMeta = { schemaVersion: 1, updatedAt: T, lastFullResyncAt: T, baselineEstablishedAt: T, registryGeneration: "g", dirtyOwnerInstanceId: null };

test("A empty Vault: complete read-only plan", async () => {
  const p = await plan(new ReadOnlyVault(), local()); assert.equal(p.records.length, 0); assert.equal(p.scanCompleted, true); assert.equal(p.baseline.status, "not-found");
});
test("B normal Vault: all metadata + sync observed without mutation", async () => {
  const c = conversation(), path = "Conversations/a.md", text = conversationToMarkdown(c), bucket = vaultRegistryBucketOf(c.id);
  const v = new ReadOnlyVault({ [path]: text, ".tsumugi/registry-meta.json": JSON.stringify(baselineMeta),
    [`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`]: JSON.stringify({ schemaVersion: 1, bucket, records: { [c.id]: path }, files: {
      [path]: { recordType: "conversation", mtime: 1, size: text.length, contentHash: hashVaultText(text), memberIds: [c.id], status: "ok" } } }),
    ".tsumugi/index.json": JSON.stringify({ [c.id]: path }),
    ".tsumugi/history/2026-09.json": JSON.stringify({ version: 2, month: "2026-09", days: { "2026-09-24": { conversations: [{ id: c.id, mode: "diary", turnCount: 1 }], normalMemories: [], reflections: [] } } }),
  });
  const s = local([c]); s.sync[`conversation:${c.id}`] = c.updatedAt;
  const p = await plan(v, s), r = p.records[0];
  assert.equal(r.classification, "equivalent-existing"); assert.equal(r.registry.entryExists, true); assert.equal(r.historyIndexExists, true);
  assert.equal(r.legacyIndexExists, true); assert.equal(r.syncState.matchesLocal, true); assert.equal(p.baseline.status, "established");
});
test("C no baseline + local-only: complete scan required", async () => {
  const p = await plan(new ReadOnlyVault(), local([conversation()], [memory()]));
  assert.deepEqual(p.records.map(r => r.classification), ["local-only-safe", "local-only-safe"]);
});
test("D no baseline + equivalent existing Conversation and Memory", async () => {
  const c = conversation(), m = memory();
  const p = await plan(new ReadOnlyVault({ "Moved/deep/c.md": conversationToMarkdown(c), "Other/m.md": memoryObjectToMarkdown(m) }), local([c], [m]));
  assert.ok(p.records.every(r => r.classification === "equivalent-existing")); assert.equal(p.records[1].memoryDay?.memberSemanticEqual, true);
});
test("E same ID different content is conflict", async () => {
  const c = conversation(), changed = clone(c); changed.turns[0].content = "different";
  const p = await plan(new ReadOnlyVault({ "c.md": conversationToMarkdown(changed) }), local([c]));
  assert.equal(p.records[0].classification, "conflict");
});
test("F meta permission failure is unconfirmed, never absence", async () => {
  const v = new ReadOnlyVault(); v.failures.set(".tsumugi", "NotAllowedError");
  const p = await plan(v, local([conversation()])); assert.equal(p.baseline.status, "unconfirmed"); assert.equal(p.records[0].classification, "unreadable / indeterminate");
});
test("G day-file exists but member missing", async () => {
  const p = await plan(new ReadOnlyVault({ "Memories/day.md": memoryObjectToMarkdown(memory("other")) }), local([], [memory()]));
  const r = p.records.find(r => r.recordId === "m1")!;
  assert.equal(r.classification, "memory-dayfile-merge-required"); assert.equal(r.memoryDay?.otherMemberCount, 1); assert.equal(r.memoryDay?.memberExists, false);
  assert.equal(p.records.find(r => r.recordId === "other")?.classification, "vault-only");
});
test("H partial enumeration never proves absence", async () => {
  const v = new ReadOnlyVault({ "folder/c.md": conversationToMarkdown(conversation("other")) }); v.failWalk = "";
  const p = await plan(v, local([conversation()])); assert.equal(p.scanCompleted, false); assert.equal(p.records[0].classification, "unreadable / indeterminate");
});
test("I duplicate IDs and repeated paths are indeterminate", async () => {
  const text = conversationToMarkdown(conversation());
  const p = await plan(new ReadOnlyVault({ "a.md": text, "b.md": text }), local([conversation()]));
  assert.equal(p.records[0].classification, "unreadable / indeterminate"); assert.equal(p.records[0].vaultPaths.length, 2);
  const v = new ReadOnlyVault({ "a.md": text }); v.duplicatePath = "a.md";
  assert.equal((await plan(v, local([conversation()]))).records[0].classification, "unreadable / indeterminate");
});
test("strict JSON distinguishes missing/read/parse/invalid including late NotFound", async () => {
  const v = new ReadOnlyVault({ "m.json": "{" });
  assert.equal((await readRecoveryJson(v.dir(), "none.json", () => true)).status, "not-found");
  assert.equal((await readRecoveryJson(v.dir(), "m.json", () => true)).status, "parse-error");
  v.files["m.json"] = "{}";
  assert.equal((await readRecoveryJson(v.dir(), "m.json", () => false)).status, "invalid");
  v.failures.set("m.json:getFile", "NotFoundError");
  assert.equal((await readRecoveryJson(v.dir(), "m.json", () => true)).status, "read-error");
  v.failures.clear(); v.failures.set("m.json:text", "NotReadableError");
  assert.equal((await readRecoveryJson(v.dir(), "m.json", () => true)).status, "read-error");
});
test("malformed shard/history/legacy index prevents local-only-safe", async () => {
  for (const path of [".tsumugi/registry/00.json", ".tsumugi/history/2026-09.json", ".tsumugi/index.json"]) {
    const p = await plan(new ReadOnlyVault({ [path]: "null" }), local([conversation()]));
    assert.equal(p.records[0].classification, "unreadable / indeterminate", path);
  }
});
test("day-file partial parse failure does not silently drop bad member", async () => {
  const text = memoryObjectToMarkdown(memory()) + "\n<!-- tsumugi:entry -->\n\n---\ntsumugi: true\n---\nbroken";
  const p = await plan(new ReadOnlyVault({ "day.md": text }), local([], [memory()]));
  assert.equal(p.records[0].classification, "unreadable / indeterminate"); assert.equal(p.records[0].vaultMarkdownExists, null);
});
test("moved Markdown in an unconventional (but visible) folder is scanned; Source and Reflection supported", async () => {
  const m = memory(); m.metadata.source = "system-generated";
  const s: Source = { id: "s1", title: "素材", content: "本文", sourceType: "text", createdAt: T, updatedAt: T };
  const snapshot = local([], [m]); snapshot.sources.push(s);
  const p = await plan(new ReadOnlyVault({ "Moved/r.md": memoryObjectToMarkdown(m), "Elsewhere/s.md": sourceToMarkdown(s) }), snapshot);
  assert.ok(p.records.every(r => r.classification === "equivalent-existing"));
  assert.equal(p.records[0].recordType, "reflection");
});
test("scan boundary: hidden directories (dot-prefixed, e.g. .tsumugi-archive) are excluded from recursive Markdown discovery", async () => {
  const c = conversation();
  // Moved under a hidden directory instead of a visible one (cf. the previous test): this is
  // the new, intentional boundary — hidden areas are no longer treated as evidence of existence.
  const p = await plan(new ReadOnlyVault({ ".moved/c.md": conversationToMarkdown(c) }), local([c]));
  assert.equal(p.records[0].classification, "local-only-safe");
  assert.deepEqual(p.records[0].vaultPaths, []);
  assert.equal(p.issues.length, 0);
});
test("native snapshot uses only readonly stores and closes connection", async () => {
  const fixture = { conversations: [conversation()], memoryObjects: [memory()], sources: [], vaultSyncState: { "conversation:c1": T } };
  const before = clone(fixture); const calls: string[] = []; let closed = false;
  const factory = { async databases() { return [{ name: "tsumugi", version: 5 }]; }, open(name: string) {
    assert.equal(name, "tsumugi"); const request: Record<string, unknown> = {};
    const db = { version: 5, objectStoreNames: { contains: (s: string) => Object.hasOwn(fixture, s) }, close() { closed = true; },
      transaction(names: string[], mode: string) {
        assert.equal(mode, "readonly"); assert.deepEqual(names, Object.keys(fixture));
        const tx: Record<string, unknown> = {};
        tx.objectStore = (s: keyof typeof fixture) => {
          calls.push(s);
          const result = (value: unknown) => { const req: Record<string, unknown> = { result: clone(value) }; queueMicrotask(() => (req.onsuccess as () => void)()); return req; };
          return { getAll: () => result(s === "vaultSyncState" ? Object.values(fixture[s]) : fixture[s]), getAllKeys: () => result(Object.keys(fixture[s])) };
        };
        setTimeout(() => (tx.oncomplete as () => void)(), 0); return tx;
      } };
    request.result = db; queueMicrotask(() => (request.onsuccess as () => void)()); return request;
  } } as unknown as IDBFactory;
  const s = await readRecoveryLocalSnapshot(factory);
  assert.equal(s.sync["conversation:c1"], T); assert.ok(closed); assert.ok(!calls.includes("settings")); assert.deepEqual(fixture, before);
});
test("native snapshot aborts attempted DB creation/upgrade", async () => {
  let aborted = false;
  const factory = { async databases() { return [{ name: "tsumugi", version: 5 }]; }, open() { const r: Record<string, unknown> = { transaction: { abort() { aborted = true; queueMicrotask(() => (r.onerror as () => void)()); } } };
    queueMicrotask(() => (r.onupgradeneeded as () => void)()); return r;
  } } as unknown as IDBFactory;
  await assert.rejects(readRecoveryLocalSnapshot(factory), /existing-database-unavailable/); assert.ok(aborted);
});
test("Registry member trace without records mapping is not local-only-safe", async () => {
  const c = conversation(), bucket = vaultRegistryBucketOf(c.id);
  const p = await plan(new ReadOnlyVault({ [`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`]: JSON.stringify({
    schemaVersion: 1, bucket, records: {}, files: { "old.md": { recordType: "conversation", mtime: 1, size: 1, contentHash: "x", memberIds: [c.id], status: "ok" } },
  }) }), local([c]));
  assert.equal(p.records[0].classification, "unreadable / indeterminate");
});
test("existing baseline-null meta distinguished from missing meta", async () => {
  const p = await plan(new ReadOnlyVault({ ".tsumugi/registry-meta.json": JSON.stringify({ ...baselineMeta, baselineEstablishedAt: null }) }), local([conversation()]));
  assert.equal(p.baseline.status, "unset"); assert.equal(p.baseline.read.status, "found"); assert.equal(p.records[0].classification, "local-only-safe");
});
test("malformed meta is not an unset baseline", async () => {
  for (const text of ["{", JSON.stringify({ ...baselineMeta, baselineEstablishedAt: "not-a-date" }), "[]"]) {
    const p = await plan(new ReadOnlyVault({ ".tsumugi/registry-meta.json": text }), local([conversation()]));
    assert.equal(p.baseline.status, "unconfirmed"); assert.equal(p.records[0].classification, "unreadable / indeterminate");
  }
});
test("duplicate members inside one day-file are indeterminate", async () => {
  const text = memoryObjectToMarkdown(memory());
  const p = await plan(new ReadOnlyVault({ "day.md": text + "\n<!-- tsumugi:entry -->\n\n" + text }), local([], [memory()]));
  assert.equal(p.records[0].classification, "unreadable / indeterminate");
});
test("pre-aborted scan never reads or writes", async () => {
  const v = new ReadOnlyVault(); const abort = new AbortController(); abort.abort();
  await assert.rejects(buildVaultRecoveryPlan(v.dir(), local(), abort.signal), { name: "AbortError" });
  assert.equal(v.reads.length, 0); assert.equal(v.mutations, 0);
});

test("WebKit-style DOMException without Error inheritance retains NotFound distinction", async () => {
  const root = { async getFileHandle() { throw { name: "NotFoundError" }; } } as unknown as FileSystemDirectoryHandle;
  assert.equal((await readRecoveryJson(root, "missing.json", () => true)).status, "not-found");
  const denied = { async getFileHandle() { throw { name: "SecurityError" }; } } as unknown as FileSystemDirectoryHandle;
  assert.equal((await readRecoveryJson(denied, "missing.json", () => true)).status, "read-error");
});

test("Markdown in a visible non-canonical folder is not ignored when proving record absence", async () => {
  // Moved out of `.tsumugi/` (now excluded as a hidden boundary, see the scan-boundary test
  // above) into a visible non-canonical folder: the safety property under test — Recovery must
  // not falsely classify a record "local-only-safe" when a copy already exists somewhere in the
  // Vault — still holds for any *visible* location.
  const c = conversation();
  const p = await plan(new ReadOnlyVault({ "Archive/c.md": conversationToMarkdown(c) }), local([c]));
  assert.equal(p.records[0].classification, "equivalent-existing");
  assert.deepEqual(p.records[0].vaultPaths, ["Archive/c.md"]);
});

// ---------------------------------------------------------------------------
// Scan boundary fix (2026-10-02): hidden directories are excluded from recursive
// Markdown discovery, and Markdown without `tsumugi: true` frontmatter is treated
// as not Tsumugi-owned (skipped) instead of a parse/shape issue. Neither change
// touches HELD_REASON, RecoveryClassification, global issue broadcast, duplicate/
// multiple-memory-files logic, or the known-path `.tsumugi/*` metadata reads
// (`inspect()`), which are independent of this walk.
// ---------------------------------------------------------------------------

test("plain non-Tsumugi Markdown (no frontmatter) is skipped, not an issue", async () => {
  const p = await plan(new ReadOnlyVault({ "test.md": "# hello" }), local());
  assert.equal(p.issues.length, 0);
  assert.equal(p.records.length, 0);
});

test("Markdown with frontmatter but tsumugi !== true is skipped, not an issue", async () => {
  for (const text of ["---\nsomeField: value\n---\nnot ours", "---\ntsumugi: false\n---\nnot ours either"]) {
    const p = await plan(new ReadOnlyVault({ "note.md": text }), local());
    assert.equal(p.issues.length, 0, text);
    assert.equal(p.records.length, 0, text);
  }
});

test("legacy-format Markdown archived under .tsumugi-archive is excluded from the scan entirely", async () => {
  const p = await plan(new ReadOnlyVault({
    ".tsumugi-archive/legacy-cleanup/files/Memories/2026-07-27-tx6wqr.md": "this is not even close to a valid Tsumugi day-file",
  }), local());
  assert.equal(p.issues.length, 0);
  assert.equal(p.records.length, 0);
});

test("Tsumugi-owned Markdown that is broken (tsumugi: true but unparseable) is still an issue", async () => {
  const p = await plan(new ReadOnlyVault({ "broken.md": "---\ntsumugi: true\n---\nno id, no recognizable section" }), local());
  assert.equal(p.issues.length, 1);
  assert.equal(p.issues[0].error, "markdown-parse-or-shape-failure");
});

test("normal Tsumugi Markdown is still recognized when a foreign Markdown coexists in the same Vault", async () => {
  const c = conversation();
  const p = await plan(new ReadOnlyVault({ "Conversations/a.md": conversationToMarkdown(c), "test.md": "# hello, this is my own note" }), local([c]));
  assert.equal(p.issues.length, 0);
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].classification, "equivalent-existing");
});

test("excluding .tsumugi-archive from the walk does not affect the existing .tsumugi/* known-path metadata reads", async () => {
  const c = conversation(), path = "Conversations/a.md", text = conversationToMarkdown(c), bucket = vaultRegistryBucketOf(c.id);
  const v = new ReadOnlyVault({
    [path]: text,
    ".tsumugi/registry-meta.json": JSON.stringify(baselineMeta),
    [`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`]: JSON.stringify({ schemaVersion: 1, bucket, records: { [c.id]: path }, files: {
      [path]: { recordType: "conversation", mtime: 1, size: text.length, contentHash: hashVaultText(text), memberIds: [c.id], status: "ok" } } }),
    ".tsumugi-archive/legacy-cleanup/files/Memories/junk.md": "garbage, not a Tsumugi Markdown at all",
  });
  const p = await plan(v, local([c]));
  assert.equal(p.baseline.status, "established");
  assert.equal(p.records[0].classification, "equivalent-existing");
  assert.equal(p.records[0].registry.entryExists, true);
  assert.equal(p.issues.length, 0);
});

const { openExistingRecoveryDatabase, parseRecoveryMemoryMarkdown } = require("./vaultRecovery") as typeof import("./vaultRecovery");
const { runRecoveryDiagnostic, restoreVaultHandleReadOnly } = require("./vaultRecoverySession") as typeof import("./vaultRecoverySession");
import type { RecoveryEnvironment } from "./vaultRecoverySession";

function diagnosticFixture(v = new ReadOnlyVault({ ".tsumugi/registry-meta.json": JSON.stringify(baselineMeta) }), s = local([conversation()])) {
  const calls: string[] = [];
  const settings: Record<string, unknown> = { activeVaultEpoch: "0", committedVaultEpoch: "0", vaultWorldJournalVersion: "1", registryGenerationEpoch: "0", apiKey: "NEVER READ" };
  const stores: Record<string, unknown> = { conversations: s.conversations, memoryObjects: s.memories, sources: s.sources, vaultSyncState: s.sync, settings };
  let held = false;
  const factory = {
    async databases() { calls.push("databases"); return [{ name: "tsumugi", version: 5 }]; },
    open(name: string, version?: number) {
      assert.equal(name, "tsumugi"); assert.equal(version, undefined); calls.push("open");
      const request: Record<string, unknown> = {};
      const db = { version: 5, objectStoreNames: { contains: (key: string) => key in stores }, close() { calls.push("close"); },
        transaction(names: string[], mode: string) {
          assert.equal(mode, "readonly"); assert.ok(held, "all reads inside exclusive lock");
          calls.push(`tx:${names.join(",")}`);
          const tx: Record<string, unknown> = {};
          const result = (value: unknown) => {
            const request: Record<string, unknown> = { result: value === undefined ? undefined : clone(value) };
            queueMicrotask(() => (request.onsuccess as () => void)()); return request;
          };
          tx.objectStore = (name: string) => ({
            get(key: string) {
              assert.equal(name, "settings");
              assert.ok(["activeVaultEpoch", "committedVaultEpoch", "vaultWorldJournalVersion", "registryGenerationEpoch"].includes(key));
              calls.push(`get:${key}`); return result(settings[key]);
            },
            getAll() { assert.notEqual(name, "settings"); return result(name === "vaultSyncState" ? Object.values(s.sync) : stores[name]); },
            getAllKeys() { assert.equal(name, "vaultSyncState"); return result(Object.keys(s.sync)); },
            put: v.forbid, add: v.forbid, delete: v.forbid, clear: v.forbid,
          });
          setTimeout(() => (tx.oncomplete as () => void)(), 0); return tx;
        },
      };
      request.result = db;
      queueMicrotask(() => (request.onsuccess as () => void)()); return request;
    },
  } as unknown as IDBFactory;
  const env: RecoveryEnvironment = { factory, storage: { async getDirectory() { assert.ok(held); calls.push("opfs"); return v.dir(); } },
    locks: { async request(name: string, options: LockOptions, cb: (lock: unknown) => Promise<unknown>) {
      assert.equal(name, "tsumugi-vault-world"); assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      held = true; try { return await cb({ name }); } finally { held = false; calls.push("unlock"); }
    } } as unknown as LockManager,
    localStorage: { getItem(key: string) { assert.equal(key, "tsumugi:wipe:v1"); return null; } },
    userAgent: "iPhone Safari", hasDirectoryPicker: false,
  };
  return { env, calls, settings, stores, vault: v, isHeld: () => held };
}

test("dedicated diagnostic: all data unchanged, no writer/upgrade/initialization; guarded reads only", async () => {
  const f = diagnosticFixture();
  const before = clone({ stores: f.stores, files: f.vault.files });
  const p = await runRecoveryDiagnostic(f.env, new AbortController().signal);
  assert.equal(p.records[0].classification, "local-only-safe");
  assert.equal(p.baseline.value, T);
  assert.deepEqual({ stores: f.stores, files: f.vault.files }, before);
  assert.equal(f.vault.mutations, 0);
  assert.equal(f.calls.at(-1), "unlock");
  assert.ok(!JSON.stringify(p).includes("NEVER READ"));
});

test("absent DB: no open (creation cannot begin); unsupported listing also refuses", async () => {
  let opened = false;
  for (const factory of [
    { databases: async () => [], open() { opened = true; throw new Error("must not open"); } },
    { open() { opened = true; throw new Error("must not open"); } },
  ]) await assert.rejects(openExistingRecoveryDatabase(factory as unknown as IDBFactory));
  assert.equal(opened, false);
  const f = diagnosticFixture();
  f.env.factory = { databases: async () => [] } as unknown as IDBFactory;
  await assert.rejects(runRecoveryDiagnostic(f.env, new AbortController().signal));
  assert.ok(!f.calls.includes("opfs"));
});

test("busy/unsupported lock and pending wipe refuse BEFORE any database or OPFS access", async () => {
  for (const mode of ["busy", "unsupported", "wipe", "storage-denied"]) {
    const f = diagnosticFixture();
    if (mode === "busy") f.env.locks = { request: async (_n: unknown, _o: unknown, cb: (lock: null) => unknown) => cb(null) } as unknown as LockManager;
    if (mode === "unsupported") f.env.locks = {} as LockManager;
    if (mode === "wipe") f.env.localStorage = { getItem: () => "pending" };
    if (mode === "storage-denied") f.env.localStorage = { getItem: () => { throw new Error("denied"); } };
    await assert.rejects(runRecoveryDiagnostic(f.env, new AbortController().signal));
    assert.deepEqual(f.calls, []);
  }
});

test("incomplete/malformed/legacy journal is not migrated or adopted; OPFS is not opened", async () => {
  for (const values of [
    { committedVaultEpoch: "1" }, { activeVaultEpoch: "bad" }, { vaultWorldJournalVersion: "2" },
    { committedVaultEpoch: undefined }, { vaultWorldJournalVersion: undefined }, { registryGenerationEpoch: "bad" },
  ]) {
    const f = diagnosticFixture(); Object.assign(f.settings, values);
    const before = { ...f.settings };
    await assert.rejects(runRecoveryDiagnostic(f.env, new AbortController().signal), /world-unconfirmed/);
    assert.deepEqual(f.settings, before); assert.ok(!f.calls.includes("opfs"));
  }
});

test("OPFS absent .tsumugi: no skeleton; PC FSA world does not silently use OPFS", async () => {
  const f = diagnosticFixture(new ReadOnlyVault());
  await assert.rejects(runRecoveryDiagnostic(f.env, new AbortController().signal), { name: "NotFoundError" });
  assert.deepEqual(f.vault.files, {}); assert.equal(f.vault.mutations, 0);
  f.env.hasDirectoryPicker = true; f.env.userAgent = "Mac Chrome";
  await assert.rejects(restoreVaultHandleReadOnly(f.env), /opfs-only/);
});

test("cancellation does not release world lock until outstanding IO has settled", async () => {
  const f = diagnosticFixture(); const abort = new AbortController();
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  f.env.storage = { async getDirectory() { began(); await paused; return f.vault.dir(); } };
  const running = runRecoveryDiagnostic(f.env, abort.signal);
  await started; abort.abort(); assert.equal(f.isHeld(), true);
  release(); await assert.rejects(running, { name: "AbortError" }); assert.equal(f.isHeld(), false);
});

test("noncooperating world change during scan invalidates result", async () => {
  const f = diagnosticFixture();
  f.env.storage = { async getDirectory() { f.settings.activeVaultEpoch = "1"; f.settings.committedVaultEpoch = "1"; return f.vault.dir(); } };
  await assert.rejects(runRecoveryDiagnostic(f.env, new AbortController().signal), /world-changed/);
});

function markdownWithEvidence(m: MemoryObject, evidence: unknown) {
  // Explicit fixture construction works with both HEAD and working-tree serializers.
  const md = memoryObjectToMarkdown(m).split("\n").filter(line => !line.startsWith("evidence:")).join("\n");
  return md.replace("---\n", `---\nevidence: ${JSON.stringify(JSON.stringify(evidence))}\n`);
}
test("Recovery-only evidence adapter is independent of normal parser support", async () => {
  const m = { ...memory(), evidenceQuotes: ["原文。\n改行も保持。", "嫉妬。"] };
  const text = markdownWithEvidence(m, m.evidenceQuotes);
  assert.deepEqual((parseRecoveryMemoryMarkdown(text) as unknown as { evidenceQuotes: string[] }).evidenceQuotes, m.evidenceQuotes);
  assert.equal((await plan(new ReadOnlyVault({ "m.md": text }), local([], [m]))).records[0].classification, "equivalent-existing");
  const different = markdownWithEvidence(m, ["違う根拠"]);
  assert.equal((await plan(new ReadOnlyVault({ "m.md": different }), local([], [m]))).records[0].classification, "conflict");
  for (const bad of [null, {}, [1], [" "]]) {
    assert.equal((await plan(new ReadOnlyVault({ "m.md": markdownWithEvidence(m, bad) }), local([], [m]))).records[0].classification, "unreadable / indeterminate");
  }
});

test("dedicated route import/render never accesses storage or mounts normal app", () => {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const route = require.resolve("../app/recovery-debug/page");
  const script = `
    for (const key of ["indexedDB", "navigator", "localStorage"]) {
      Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error("unexpected mount IO: " + key); } });
    }
    const React = require("react");
    const { renderToString } = require("react-dom/server");
    const Page = require(${JSON.stringify(route)}).default;
    const html = renderToString(React.createElement(Page));
    if (!html.includes("Vault Recovery Diagnostic") || !html.includes("READ ONLY") || !html.includes("診断開始")) throw new Error("missing UI");
    for (const key of Object.keys(require.cache)) {
      if (/\\/(ChatScreen|WipeGate|capture|captureDebug|retrieval|HistoryPanel)\\.[jt]sx?$/.test(key)) throw new Error("normal app loaded: " + key);
    }
  `;
  execFileSync(process.execPath, ["-e", script], { env: process.env });
});
