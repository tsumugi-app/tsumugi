/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias */
/**
 * Temporal Phase 1A.5：statedAtのmixed-version安全性（Projectionの特例successor・resync mergeの保持）。
 * 実行方法：`npm run test:stated-at-projection`。Phase 1B（statedAtの生成）はまだ含まない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..");
const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};
const loader = Module as unknown as { _load: (request: string, parent?: unknown, main?: boolean) => unknown };
const previousLoad = loader._load;
loader._load = function (request, parent, main) {
  if (request === "idb") return require("./fakeIdb");
  return previousLoad.call(this, request, parent, main);
};

type MemoryObject = import("./types").MemoryObject;
const md = require("./markdown") as typeof import("./markdown");
const vaultMod = require("./vault") as typeof import("./vault");
const proj = require("./vaultProjection") as typeof import("./vaultProjection");
const migration = require("./vaultProductionMigration") as typeof import("./vaultProductionMigration");
const dbMod = require("./db") as typeof import("./db");

class FakeFile {
  constructor(public content: string, public mtime: number) {}
}

class FakeVault {
  files = new Map<string, FakeFile>();
  private clock = 1;
  writeShouldFail = new Set<string>();
  /** path→次回そのpathへcloseされるときに書く、parse不能なgarbage文字列（failure injection、一発だけ）。 */
  corruptOnCommit = new Map<string, string>();
  /**
   * B1-A/B/D対応：OPFSの「直接write→truncate」経路で、truncate自体は実際にファイルへ反映された
   * うえで、その後の段階（flush/close）でエラーが返る、という状況の再現（`corruptOnCommit`と違い、
   * 内容の書き換え＝garbageの反映と、closeの失敗＝action()自体のthrowが同時に起きる。一発だけ）。
   */
  corruptThenThrow = new Map<string, string>();
  writeCount = 0;

  root(): FileSystemDirectoryHandle {
    return this.dir("");
  }

  private dir(prefix: string): FileSystemDirectoryHandle {
    const self = this;
    return {
      kind: "directory",
      name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const path = prefix ? `${prefix}/${name}` : name;
        const hasChildren = [...self.files.keys()].some((k) => k.startsWith(`${path}/`));
        if (!hasChildren) {
          if (!options?.create) throw new DOMException("no such directory", "NotFoundError");
        }
        return self.dir(path);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const filePath = prefix ? `${prefix}/${name}` : name;
        if (!self.files.has(filePath)) {
          if (!options?.create) throw new DOMException("no such file", "NotFoundError");
        }
        return self.file(filePath);
      },
      async *entries() {
        const children = new Map<string, "directory" | "file">();
        for (const p of self.files.keys()) {
          if (prefix && !p.startsWith(`${prefix}/`)) continue;
          if (!prefix && p.includes("/") === false && !self.files.has(p)) continue;
          const rel = prefix ? p.slice(prefix.length + 1) : p;
          const first = rel.split("/")[0];
          children.set(first, rel.includes("/") ? "directory" : "file");
        }
        for (const [name, kind] of children) {
          const childPath = prefix ? `${prefix}/${name}` : name;
          yield [name, kind === "directory" ? self.dir(childPath) : self.file(childPath)] as [string, FileSystemHandle];
        }
      },
      async removeEntry(name: string) {
        const filePath = prefix ? `${prefix}/${name}` : name;
        if (!self.files.has(filePath)) throw new DOMException("no such file", "NotFoundError");
        if (self.writeShouldFail.has(filePath)) throw new Error("simulated write failure");
        self.files.delete(filePath);
      },
    } as unknown as FileSystemDirectoryHandle;
  }

  private file(filePath: string): FileSystemFileHandle {
    const self = this;
    return {
      kind: "file",
      name: filePath.split("/").pop(),
      async getFile() {
        const f = self.files.get(filePath);
        if (!f) throw new DOMException("no such file", "NotFoundError");
        return { size: f.content.length, lastModified: f.mtime, async text() { return f.content; } } as unknown as File;
      },
      async createWritable() {
        return {
          async write(content: string) {
            (this as unknown as { _pending: string })._pending = content;
          },
          async close() {
            self.writeCount += 1;
            // OPFS write経路（直接write→truncate→flush）が途中で止まった場合の再現：本来書くべき内容の
            // 代わりに、parse不能なgarbageを一度だけ書き込む（failure injection。corruptOnCommitを
            // writeShouldFailより先に見ることで、「1回目のwrite（本来の書き込み）はgarbageを残して
            // “成功”するが、2回目のwrite（backupからの復元試行）はwriteShouldFail側で失敗する」という
            // 順序を、同じpathへ両方セットするだけで組み立てられるようにする）。
            const garbage = self.corruptOnCommit.get(filePath);
            if (garbage !== undefined) {
              self.corruptOnCommit.delete(filePath);
              self.clock += 1;
              self.files.set(filePath, new FakeFile(garbage, self.clock));
              return;
            }
            const garbageThenThrow = self.corruptThenThrow.get(filePath);
            if (garbageThenThrow !== undefined) {
              self.corruptThenThrow.delete(filePath);
              self.clock += 1;
              self.files.set(filePath, new FakeFile(garbageThenThrow, self.clock)); // truncate自体は実際に反映される
              throw new Error("simulated write failure after partial truncate"); // action()自体がthrowする
            }
            if (self.writeShouldFail.has(filePath)) throw new Error("simulated write failure");
            self.clock += 1;
            self.files.set(filePath, new FakeFile((this as unknown as { _pending: string })._pending, self.clock));
          },
        };
      },
    } as unknown as FileSystemFileHandle;
  }

  put(pathStr: string, content: string) {
    this.clock += 1;
    this.files.set(pathStr, new FakeFile(content, this.clock));
  }
  /** `put()`済みpathの実際のmtime（Registry entryのfixtureに正しい値を埋めるため）。 */
  mtimeOf(pathStr: string): number {
    const f = this.files.get(pathStr);
    if (!f) throw new Error(`mtimeOf: no such file in fixture: ${pathStr}`);
    return f.mtime;
  }
  get(pathStr: string): string | undefined {
    return this.files.get(pathStr)?.content;
  }
}

// ---------------------------------------------------------------------------
// 疑似DB（IndexedDB相当）／journal store／同期台帳
// ---------------------------------------------------------------------------


const T = "2026-09-20T09:00:00.000Z";
const STATED = "2026-09-20T09:05:00.000Z";
const STATED2 = "2026-09-20T09:30:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, sourceType: "chat" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
const uid = () => Math.random().toString(36).slice(2, 10);
const memory = (id: string, over: Partial<MemoryObject> = {}): MemoryObject =>
  ({ id, date: T, content: "内容", summary: "要約", types: ["event"], conversationId: "c1", keywords: ["k"], links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], createdAt: T, updatedAt: T, metadata: { ...meta }, ...over }) as MemoryObject;
/** What the Vault holds after parsing the Markdown (the Projection's `onDisk`). */
const onDiskOf = (m: MemoryObject): MemoryObject => md.parseMemoryDayFile(md.serializeMemoryDayFile([m]))[0];
const without = (m: MemoryObject): MemoryObject => { const copy = { ...m }; delete copy.statedAt; return copy; };

test("Projection 1: identical (both without statedAt, or both with the same value) -> same", () => {
  const m = memory("m1");
  assert.equal(proj.isMemorySame(onDiskOf(m), m), true);
  const s = memory("m2", { statedAt: STATED });
  assert.equal(proj.isMemorySame(onDiskOf(s), s), true, "5: both sides carry the same statedAt -> the normal 'same'");
  assert.equal(proj.isMemoryStatedAtOnlyMissing(onDiskOf(s), s), false, "the special case does not apply to a normal same");
});
test("Projection 2: canonical has a valid statedAt, Vault has none, everything else identical -> safe successor", () => {
  const canonical = memory("m1", { statedAt: STATED });
  const onDisk = onDiskOf(without(canonical));
  assert.equal(proj.isMemorySame(onDisk, canonical), false, "not 'same' (statedAt is NOT simply excluded from the comparison)");
  assert.equal(proj.isMemoryStatedAtOnlyMissing(onDisk, canonical), true);
  assert.equal(proj.isMemoryLegitimateSuccessor(onDisk, canonical), true, "updatedAt is equal, so only the special case makes it a successor");
});
test("Projection 3/4: reverse direction (canonical has none, Vault has one) is never a successor — even when canonical.updatedAt is newer", () => {
  const vaultSide = memory("m1", { statedAt: STATED });
  const canonical = memory("m1");
  const onDisk = onDiskOf(vaultSide);
  assert.equal(proj.isMemorySame(onDisk, canonical), false);
  assert.equal(proj.isMemoryStatedAtOnlyMissing(onDisk, canonical), false);
  assert.equal(proj.isMemoryLegitimateSuccessor(onDisk, canonical), false, "3: conflict / HOLD side");
  const newer = memory("m1", { updatedAt: "2026-09-21T00:00:00.000Z" });
  assert.equal(proj.isMemoryLegitimateSuccessor(onDisk, newer), false, "4: the existing updatedAt successor rule must not erase the Vault's statedAt");
});
test("Projection 6: both sides have a statedAt but different values -> no special case, never a successor", () => {
  const canonical = memory("m1", { statedAt: STATED2 });
  const onDisk = onDiskOf(memory("m1", { statedAt: STATED }));
  assert.equal(proj.isMemoryStatedAtOnlyMissing(onDisk, canonical), false);
  assert.equal(proj.isMemoryLegitimateSuccessor(onDisk, canonical), false);
  assert.equal(proj.isMemoryLegitimateSuccessor(onDisk, memory("m1", { statedAt: STATED2, updatedAt: "2026-09-21T00:00:00.000Z" })), false, "even with a newer canonical");
});
test("Projection 7: an invalid canonical statedAt never triggers the special case", () => {
  for (const bad of ["2026-02-30T09:00:00.000Z", "", "2026-09-20 09:05:00", "2026-09-20T09:05:00+09:00", "yesterday"]) {
    const canonical = memory("m1", { statedAt: bad });
    const onDisk = onDiskOf(without(canonical));
    assert.equal(proj.isMemoryStatedAtOnlyMissing(onDisk, canonical), false, `invalid: ${JSON.stringify(bad)}`);
    // the serializer never writes an invalid value, so the Vault member equals the canonical's own serialization: plain 'same'
    assert.equal(proj.isMemorySame(onDisk, canonical), true);
  }
});
test("Projection 8-13: statedAt missing PLUS any other difference -> the special case does not apply (the normal rules decide)", () => {
  const base = memory("m1", { statedAt: STATED, evidenceQuotes: ["引用"], eventTime: "2026-09-19", eventTimePrecision: "day", topicId: "t1" });
  const diffs: [string, (m: MemoryObject) => void][] = [
    ["content", (m) => { m.content = "別の内容"; }], ["summary", (m) => { m.summary = "別の要約"; }], ["keywords", (m) => { m.keywords = ["別"]; }],
    ["evidenceQuotes", (m) => { m.evidenceQuotes = ["別の引用"]; }], ["eventTime", (m) => { m.eventTime = "2026-09-18"; }], ["eventTimePrecision", (m) => { m.eventTimePrecision = "month"; m.eventTime = "2026-09"; }],
    ["topicId", (m) => { m.topicId = "t2"; }], ["createdAt", (m) => { m.createdAt = "2026-09-19T09:00:00.000Z"; }], ["updatedAt", (m) => { m.updatedAt = "2026-09-19T09:00:00.000Z"; }],
    ["types", (m) => { m.types = ["idea"]; }], ["conversationId", (m) => { m.conversationId = "c2"; }],
  ];
  for (const [name, mutate] of diffs) {
    const vault = without(base); mutate(vault);
    assert.equal(proj.isMemoryStatedAtOnlyMissing(onDiskOf(vault), base), false, `${name}`);
  }
  // person / profile / topic events: the canonical carries them but the Vault member does not (the parser would drop ill-shaped ones, so the difference is placed on the canonical side)
  for (const [name, extra] of [["person", { personMentions: [{ k: "v" }] }], ["profile", { profileClaims: [{ k: "v" }] }], ["topicEvents", { topicEvents: [{ k: "v" }] }]] as const) {
    const canonical = { ...base, ...extra } as unknown as MemoryObject;
    assert.equal(proj.isMemoryStatedAtOnlyMissing(onDiskOf(without(base)), canonical), false, name);
  }
  // content / summary differences stay a real conflict (not a successor): the conflict path is unchanged
  assert.equal(proj.isMemoryLegitimateSuccessor(onDiskOf({ ...without(base), content: "別の内容" }), base), false);
  assert.equal(proj.isMemoryLegitimateSuccessor(onDiskOf({ ...without(base), summary: "別の要約" }), base), false);
});

// ---------------------------------------------------------------------------
// bootstrap / reconcile (real Projection against an in-memory Vault)
// ---------------------------------------------------------------------------
const DRY_NOW = "2026-09-27T00:00:00.000Z";
const projEnv = (vault: FakeVault) => ({ root: vault.root(), now: () => DRY_NOW, vaultIdentity: { vaultId: "v1" } }) as unknown as import("./vaultProjection").ProjectionEnv;
const randomDay = () => `2025-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
const mem = (id: string, day: string, over: Partial<MemoryObject> = {}) => memory(id, { date: `${day}T00:00:00.000Z`, createdAt: `${day}T09:0${id.length % 9}:00.000Z`, updatedAt: `${day}T09:00:00.000Z`, ...over });
/** The Vault as an OLD build leaves it: every member re-serialized without statedAt. */
async function seedStrippedDay(day: string, canonicals: MemoryObject[]) {
  const vault = new FakeVault();
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "v1" }));
  vault.put(`Memories/${day}.md`, md.serializeMemoryDayFile(canonicals.map(without)));
  for (const m of canonicals) await dbMod.putMemoryObject(m);
  return vault;
}

test("Projection 14: statedAt lost from EVERY member of one day-file (old build rewrite) -> one bootstrap pass restores all of them, no HOLD remains", async () => {
  const day = randomDay(), k = uid();
  const canonicals = ["a", "b", "c"].map((x, i) => mem(`s14${x}-${k}`, day, { statedAt: `${day}T09:0${i + 1}:00.000Z`, createdAt: `${day}T09:0${i}:30.000Z` }));
  const vault = await seedStrippedDay(day, canonicals);
  const stripped = md.parseMemoryDayFile(vault.get(`Memories/${day}.md`)!);
  assert.ok(stripped.every((m) => m.statedAt === undefined), "precondition: the Vault lost every statedAt");
  for (const m of canonicals) assert.equal((await migration.classifyMemoryDay(vault.root(), day, [m]))[0].kind, "legitimate-successor", "migration classification");
  const results: string[] = [];
  for (const m of canonicals) results.push((await proj.reconcileMemoryOutboxEntry(projEnv(vault), await dbMod.putMemoryObjectWithOutbox(m, "memory", DRY_NOW))).status);
  assert.deepEqual(results, ["done", "done", "done"], "no pending / held");
  const restored = md.parseMemoryDayFile(vault.get(`Memories/${day}.md`)!);
  assert.deepEqual(restored.map((m) => m.statedAt).sort(), canonicals.map((m) => m.statedAt!).sort(), "all statedAt are back");
  for (const m of canonicals) assert.ok(proj.isMemorySame(restored.find((r) => r.id === m.id)!, m), "Vault now equals canonical");
  for (const m of canonicals) assert.equal((await dbMod.getVaultOutboxEntry(`memory:${m.id}`))!.status, "done");
});
test("Projection 15: an external edit (statedAt line removed AND content edited) is never overwritten", async () => {
  const day = randomDay(), k = uid();
  const canonical = mem(`s15-${k}`, day, { statedAt: `${day}T09:05:00.000Z` });
  const vault = new FakeVault(); vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "v1" }));
  vault.put(`Memories/${day}.md`, md.serializeMemoryDayFile([{ ...without(canonical), content: "ユーザーが書き換えた内容" }]));
  await dbMod.putMemoryObject(canonical);
  const before = vault.get(`Memories/${day}.md`);
  const result = await proj.reconcileMemoryOutboxEntry(projEnv(vault), await dbMod.putMemoryObjectWithOutbox(canonical, "memory", DRY_NOW));
  assert.equal(result.status, "held"); assert.equal(vault.get(`Memories/${day}.md`), before, "the user's edit is untouched");
  assert.equal((await migration.classifyMemoryDay(vault.root(), day, [canonical]))[0].kind, "conflict");
  assert.equal((await dbMod.getMemoryObject(canonical.id))!.statedAt, canonical.statedAt, "canonical untouched");
});
test("Projection: reverse direction in a real reconcile stays HOLD and the Vault's statedAt is kept", async () => {
  const day = randomDay(), k = uid();
  const vaultSide = mem(`s16-${k}`, day, { statedAt: `${day}T09:05:00.000Z` });
  const canonical = without(vaultSide); canonical.updatedAt = `${day}T10:00:00.000Z`; // newer, but without statedAt
  const vault = new FakeVault(); vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "v1" }));
  vault.put(`Memories/${day}.md`, md.serializeMemoryDayFile([vaultSide]));
  await dbMod.putMemoryObject(canonical);
  const before = vault.get(`Memories/${day}.md`);
  assert.equal((await proj.reconcileMemoryOutboxEntry(projEnv(vault), await dbMod.putMemoryObjectWithOutbox(canonical, "memory", DRY_NOW))).status, "held");
  assert.equal(vault.get(`Memories/${day}.md`), before);
});

// ---------------------------------------------------------------------------
// resync (external-edit merge): mergeMemoryObjectForApply
// ---------------------------------------------------------------------------
test("Resync 1: IDB has statedAt, Vault has none, content edited externally -> the edit is imported AND statedAt is kept", () => {
  const local = memory("m1", { statedAt: STATED });
  const fromVault = onDiskOf({ ...without(local), content: "外部で編集した内容", updatedAt: "2026-09-21T00:00:00.000Z" });
  const merged = vaultMod.mergeMemoryObjectForApply(fromVault, local)!;
  assert.equal(merged.content, "外部で編集した内容"); assert.equal(merged.updatedAt, "2026-09-21T00:00:00.000Z");
  assert.equal(merged.statedAt, STATED);
});
test("Resync 2: identical statedAt on both sides -> unchanged behaviour", () => {
  const local = memory("m1", { statedAt: STATED });
  const merged = vaultMod.mergeMemoryObjectForApply(onDiskOf({ ...local, content: "編集" }), local)!;
  assert.equal(merged.statedAt, STATED); assert.equal(merged.content, "編集");
  const legacy = memory("m2"); const mergedLegacy = vaultMod.mergeMemoryObjectForApply(onDiskOf({ ...legacy, content: "編集" }), legacy)!;
  assert.ok(!("statedAt" in mergedLegacy), "records without statedAt are merged exactly as before");
});
test("Resync 3: IDB has none, Vault has one -> the Vault's statedAt is not lost", () => {
  const local = memory("m1");
  const merged = vaultMod.mergeMemoryObjectForApply(onDiskOf(memory("m1", { statedAt: STATED, content: "編集" })), local)!;
  assert.equal(merged.statedAt, STATED);
});
test("Resync 4: different valid statedAt on both sides -> neither side is changed (conflict)", () => {
  const local = memory("m1", { statedAt: STATED });
  assert.equal(vaultMod.mergeMemoryObjectForApply(onDiskOf(memory("m1", { statedAt: STATED2, content: "編集" })), local), null);
});
test("Resync 5: the existing merge semantics are untouched (day gate, local-only fields, metadata)", () => {
  const local = memory("m1", { statedAt: STATED, themeIds: ["theme"], sourceId: "src" } as Partial<MemoryObject>);
  const fromVault = onDiskOf(memory("m1", { content: "編集" }));
  const merged = vaultMod.mergeMemoryObjectForApply(fromVault, local)!;
  assert.deepEqual([merged.themeIds, merged.sourceId, merged.date], [["theme"], "src", local.date], "local-only fields still come from IDB");
  assert.equal(vaultMod.mergeMemoryObjectForApply(onDiskOf(memory("m1", { date: "2026-09-21T00:00:00.000Z" })), local), null, "date gate");
  // The hash-based 'edited' classification fires on a bare statedAt-line removal, which is why the merge must keep it:
  const hash = (m: MemoryObject) => vaultMod.hashVaultText(md.memoryObjectToMarkdown(m));
  assert.notEqual(hash(onDiskOf(without(local))), hash(onDiskOf(local)));
});

// ---------------------------------------------------------------------------
// Temporal Phase 1B persistence (Capture output -> IndexedDB -> Outbox -> Vault Markdown -> Projection)
// ---------------------------------------------------------------------------
test("Phase 1B E22-E24: a Capture-style Memory with statedAt keeps it through IndexedDB, the Outbox projection, the Vault Markdown and a second reconcile", async () => {
  const day = randomDay(), k = uid();
  const stated = `${day}T09:20:00.000Z`;
  const m = mem(`p1b-${k}`, day, { statedAt: stated, evidenceQuotes: ["引用"] });
  const vault = new FakeVault(); vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "v1" }));
  const entry = await dbMod.putMemoryObjectWithOutbox(m, "memory", DRY_NOW);
  assert.equal((await dbMod.getMemoryObject(m.id))!.statedAt, stated, "IndexedDB keeps statedAt");
  assert.equal((await proj.reconcileMemoryOutboxEntry(projEnv(vault), entry)).status, "done");
  const file = vault.get(`Memories/${day}.md`)!;
  assert.ok(file.includes(`statedAt: "${stated}"`), "Vault Markdown carries statedAt");
  assert.equal(md.parseMemoryDayFile(file)[0].statedAt, stated, "23: the same value after parsing the Vault");
  const again = await proj.reconcileMemoryOutboxEntry(projEnv(vault), await dbMod.putMemoryObjectWithOutbox(m, "memory", DRY_NOW));
  assert.equal(again.status, "done");
  assert.equal(vault.get(`Memories/${day}.md`), file, "24: a second reconcile is a no-op (Vault unchanged)");
  assert.equal(md.parseMemoryDayFile(vault.get(`Memories/${day}.md`)!)[0].statedAt, stated);
  assert.equal((await dbMod.getMemoryObject(m.id))!.statedAt, stated);
});
