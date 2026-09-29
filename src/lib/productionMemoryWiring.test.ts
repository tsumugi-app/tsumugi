/**
 * Production Memory/Reflection/Source Wiring（Phase 3-9）。
 *
 * `persistCapture`（capture.ts）・`persistSource`（source.ts）はどちらも公開APIで、
 * `memoryObjects`/`source`を直接引数として受け取る（AI抽出パイプライン自体は
 * `captureConversation`の責務で別関数）。ここではそれらを直接呼び、実際のProduction
 * call siteが新保存基盤（`putMemoryObjectWithOutbox`/`putSourceWithOutbox`）を
 * 正しく使っていること、Vault write失敗時もcanonicalが残ること、その後の
 * `runSaveFoundationBootstrap`で自己修復できることを検証する。
 *
 * `withVaultWorldRead`（H4）を満たすため、`markVaultEpochCommitted`/
 * `markVaultWorldJournalMigrated`/`setTabVaultEpoch`で有効なepoch状態を用意する
 * （通常はChatScreen.tsxの起動effectが行う準備）。
 *
 * 実行方法：`npm run test:save-foundation`。
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias */
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

const dbMod = require(path.join(OUT, "lib/db.js")) as typeof import("./db");
const vaultMod = require(path.join(OUT, "lib/vault.js")) as typeof import("./vault");
const markdownMod = require(path.join(OUT, "lib/markdown.js")) as typeof import("./markdown");
const captureMod = require(path.join(OUT, "lib/capture.js")) as typeof import("./capture");
const sourceMod = require(path.join(OUT, "lib/source.js")) as typeof import("./source");
const bootstrapMod = require(path.join(OUT, "lib/saveFoundationBootstrap.js")) as typeof import("./saveFoundationBootstrap");
const vaultWorldLockMod = require(path.join(OUT, "lib/vaultWorldLock.js")) as typeof import("./vaultWorldLock");
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as {
  __failNextPutOn: (dbName: string, storeName: string) => void;
  __failNextPlainPutOn: (dbName: string, storeName: string) => void;
};

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type Source = import("./types").Source;

// ---------------------------------------------------------------------------
// in-memory疑似ファイルシステム（entries()対応版、他のPhase 3-xテストと同じ実装）
// ---------------------------------------------------------------------------

class FakeFile {
  constructor(public content: string, public mtime: number) {}
}

class FakeVault {
  files = new Map<string, FakeFile>();
  private clock = 1;
  writeShouldFail = new Set<string>();
  failedWrites: string[] = [];
  writeCount = 0;
  writes: Array<{ path: string; content: string }> = [];

  root(): FileSystemDirectoryHandle {
    return this.dir("");
  }

  private dir(prefix: string): FileSystemDirectoryHandle {
    const self = this;
    return {
      kind: "directory",
      name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const p = prefix ? `${prefix}/${name}` : name;
        const hasChildren = [...self.files.keys()].some((k) => k.startsWith(`${p}/`));
        if (!hasChildren && !options?.create) throw new DOMException("no such directory", "NotFoundError");
        return self.dir(p);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (!self.files.has(p) && !options?.create) throw new DOMException("no such file", "NotFoundError");
        return self.file(p);
      },
      async *values() {
        const seen = new Set<string>();
        for (const k of self.files.keys()) {
          if (prefix && !k.startsWith(`${prefix}/`)) continue;
          if (!prefix && k.includes("/")) continue;
          const rel = prefix ? k.slice(prefix.length + 1) : k;
          const first = rel.split("/")[0];
          if (seen.has(first)) continue;
          seen.add(first);
          yield { name: first } as unknown as FileSystemHandle;
        }
      },
      async *entries() {
        const children = new Map<string, "directory" | "file">();
        for (const p of self.files.keys()) {
          if (prefix && !p.startsWith(`${prefix}/`)) continue;
          if (!prefix && p.includes("/")) continue;
          const rel = prefix ? p.slice(prefix.length + 1) : p;
          const first = rel.split("/")[0];
          children.set(first, rel.includes("/") ? "directory" : "file");
        }
        for (const [name, kind] of children) {
          const childPath = prefix ? `${prefix}/${name}` : name;
          yield [name, kind === "directory" ? self.dir(childPath) : self.file(childPath)] as [string, FileSystemHandle];
        }
      },
    } as unknown as FileSystemDirectoryHandle;
  }

  private file(p: string): FileSystemFileHandle {
    const self = this;
    return {
      kind: "file",
      name: p.split("/").pop(),
      async getFile() {
        const f = self.files.get(p);
        if (!f) throw new DOMException("no such file", "NotFoundError");
        return { size: f.content.length, lastModified: f.mtime, async text() { return f.content; } } as unknown as File;
      },
      async createWritable() {
        let pending = "";
        return {
          async write(c: string) { pending = c; },
          async close() {
            self.writeCount += 1;
            if (self.writeShouldFail.has(p)) { self.failedWrites.push(p); throw new Error("simulated write failure"); }
            self.clock += 1;
            self.files.set(p, new FakeFile(pending, self.clock));
            self.writes.push({ path: p, content: pending });
          },
        };
      },
    } as unknown as FileSystemFileHandle;
  }

  put(pathStr: string, content: string) {
    this.clock += 1;
    this.files.set(pathStr, new FakeFile(content, this.clock));
  }
  get(pathStr: string): string | undefined {
    return this.files.get(pathStr)?.content;
  }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const T = "2026-10-01T09:00:00.000Z";
const convMeta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id, persona: "companion", status: "active", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: [{ role: "user", content: "ユーザー発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...convMeta }, ...overrides,
  } as Conversation;
}

const memMeta = { id: "meta", source: "ai-capture" as const, sourceType: "chat" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
function memory(id: string, day: string, overrides: Partial<MemoryObject> = {}): MemoryObject {
  const iso = `${day}T09:00:00.000Z`;
  return {
    id, date: iso, content: `内容-${id}`, summary: `要約-${id}`, types: ["event"] as MemoryObject["types"], conversationId: "c1",
    keywords: [], links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: iso, updatedAt: iso, metadata: { ...memMeta },
    ...overrides,
  } as MemoryObject;
}

const reflectionMeta = { id: "meta", source: "system-generated" as const, sourceType: "system" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
function reflection(id: string, day: string, overrides: Partial<MemoryObject> = {}): MemoryObject {
  const iso = `${day}T09:00:00.000Z`;
  return {
    id, date: iso, content: `内容-${id}`, summary: `要約-${id}`, types: ["insight"] as MemoryObject["types"],
    keywords: [], links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: iso, updatedAt: iso, metadata: { ...reflectionMeta },
    ...overrides,
  } as MemoryObject;
}

function source(id: string, overrides: Partial<Source> = {}): Source {
  return { id, sourceType: "note" as Source["sourceType"], title: `タイトル-${id}`, content: `内容-${id}`, createdAt: T, updatedAt: T, ...overrides } as Source;
}

/** `withVaultWorldRead`（H4）が通常運用と同じ「有効な世界」を確認できるよう、テストごとに整える。 */
async function setUpVaultWorld() {
  await dbMod.clearMemoryData();
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null, pendingCandidateVaultId: null, updatedAt: T });
  await dbMod.markVaultEpochCommitted(0);
  await dbMod.markVaultWorldJournalMigrated();
  vaultWorldLockMod.setTabVaultEpoch(0);
}

const PREPAIRED_VAULT_ID = "mem-wiring-prepaired-vault-id";
/**
 * identity adoption（Phase 3-4）自体のevidence判定は、この関数のテスト対象
 * （member単位のunknown保持・conflict isolation）とは別の関心事——Vault側に
 * 既存の未知/食い違うmember実体がある状態から始めるテストで、まだ未pairの
 * identityから始めると、legacy adoption自体が"unrelated"/"conflict"として
 * bootstrapの入口で止まってしまう（Phase 3-7/3-8のBootstrap F/Lと同じ理由）。
 * そのため、対象memberの実体を書き込む前に、identityを既にpair済みにしておく。
 */
async function seedPrepairedIdentity(vault: FakeVault) {
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: PREPAIRED_VAULT_ID, createdAt: T }));
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: PREPAIRED_VAULT_ID, activeVaultEpoch: 0, registryGeneration: "g1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T });
}

let vaultIdSeq = 0;
function makeEnv(vault: FakeVault): import("./saveFoundationBootstrap").SaveFoundationBootstrapEnv {
  return { root: vault.root(), now: () => T, generateVaultId: () => `mem-wiring-vault-id-${++vaultIdSeq}` };
}

// ===========================================================================
// A〜C：canonical write成功→Vault write失敗→次回bootstrapで自己修復
// ===========================================================================

test("Wiring Memory A: persistCaptureがcanonical+outboxを先に確定させ、Vault write失敗でもMemoryが残り、次回bootstrapでdoneになる", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const day = "2026-10-01";
  const conv = conversation("mem-wiring-a-conv");
  const mem = memory("mem-wiring-a-mem", day);
  const path = `Memories/${vaultMod.dayFileNameFor(day)}`;
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  await seedPrepairedIdentity(vault);
  vault.writeShouldFail.add(path); // legacy Vault writeを意図的に失敗させる

  const result = await captureMod.persistCapture(vault.root(), conv, [mem]);
  assert.equal(result.failedMemoryIds.length, 0, "canonical write自体は失敗していない");
  const stored = await dbMod.getMemoryObject(mem.id);
  assert.deepEqual(stored, mem, "Vault writeが失敗しても、canonicalはIndexedDBに残る");
  const outbox = await dbMod.getVaultOutboxEntry(`memory:${mem.id}`);
  assert.ok(outbox, "vaultOutboxがcanonicalと同一transactionで作られている");
  assert.equal(outbox!.status, "pending");

  // 次回startup bootstrap：Vault write失敗が直っていなくても、Vaultに書けなかった
  // 記録はpendingのまま残り、実際に書けるようになった状態（writeShouldFailを解除）で
  // 収束することを確認する。
  assert.ok(vault.failedWrites.includes(path), "failure injection reached the intended Markdown write");
  vault.writeShouldFail.delete(path);
  const bootstrapResult = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  void bootstrapResult;
  const entryAfter = await dbMod.getVaultOutboxEntry(`memory:${mem.id}`);
  assert.equal(entryAfter!.status, "done");
  const members = markdownMod.parseMemoryDayFile(vault.get(path)!);
  assert.ok(members.some((m) => m.id === mem.id));
});

test("Wiring Reflection B: persistCaptureがReflectionもcanonical+outboxで保存し、Vault write失敗でも残り、次回bootstrapでdoneになる（normal Memory day-fileへ混入しない）", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const day = "2026-10-02";
  const conv = conversation("mem-wiring-b-conv");
  const refl = reflection("mem-wiring-b-refl", day);
  const path = `Memories/${vaultMod.fileNameFor(refl.id, refl.date)}`;
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  await seedPrepairedIdentity(vault);
  vault.writeShouldFail.add(path);

  const result = await captureMod.persistCapture(vault.root(), conv, [refl]);
  assert.equal(result.failedMemoryIds.length, 0);
  const stored = await dbMod.getMemoryObject(refl.id);
  assert.deepEqual(stored, refl);
  const memoryOutbox = await dbMod.getVaultOutboxEntry(`memory:${refl.id}`);
  assert.equal(memoryOutbox, undefined, "Reflectionはmemory recordTypeのoutboxを作らない");
  const reflectionOutbox = await dbMod.getVaultOutboxEntry(`reflection:${refl.id}`);
  assert.ok(reflectionOutbox, "reflection recordTypeのoutboxが正しく作られる");
  assert.equal(reflectionOutbox!.status, "pending");

  assert.ok(vault.failedWrites.includes(path), "failure injection reached the intended Markdown write");
  vault.writeShouldFail.delete(path);
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  const entryAfter = await dbMod.getVaultOutboxEntry(`reflection:${refl.id}`);
  assert.equal(entryAfter!.status, "done");
  assert.equal(vault.get(path), markdownMod.memoryObjectToMarkdown(refl));

  // normal Memory day-fileが誤って作られていないことの確認。
  const dayFilePath = `Memories/${vaultMod.dayFileNameFor(day)}`;
  assert.equal(vault.get(dayFilePath), undefined, "Reflectionがday-fileへ混入していない");
});

test("Wiring Source C: persistSourceがcanonical+outboxを先に確定させ、Vault write失敗でもSourceが残り、次回bootstrapでdoneになる", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const src = source("mem-wiring-c-src");
  const path = `Sources/${vaultMod.fileNameFor(src.id, src.createdAt)}`;
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  await seedPrepairedIdentity(vault);
  vault.writeShouldFail.add(path);

  const result = await sourceMod.persistSource(vault.root(), src);
  assert.equal(result.indexedDbFailed, false);
  const stored = await dbMod.getSource(src.id);
  assert.deepEqual(stored, src, "Vault writeが失敗しても、canonicalはIndexedDBに残る");
  const outbox = await dbMod.getVaultOutboxEntry(`source:${src.id}`);
  assert.ok(outbox, "vaultOutboxがcanonicalと同一transactionで作られている");
  assert.equal(outbox!.status, "pending");

  assert.ok(vault.failedWrites.includes(path), "failure injection reached the intended Markdown write");
  vault.writeShouldFail.delete(path);
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  const entryAfter = await dbMod.getVaultOutboxEntry(`source:${src.id}`);
  assert.equal(entryAfter!.status, "done");
  assert.equal(vault.get(path), markdownMod.sourceToMarkdown(src));
});

// ===========================================================================
// D：Memory day-file（既存member保護・未知member保持・Reflection非混入）
// ===========================================================================

test("Wiring Memory D: 同じdayに複数MemoryをpersistCaptureで保存しても、既存member・未知memberを壊さない", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const day = "2026-10-03";
  const path = `Memories/${vaultMod.dayFileNameFor(day)}`;
  const unknown = memory("mem-wiring-d-unknown", day, { createdAt: `${day}T08:00:00.000Z` });
  vault.put(path, markdownMod.serializeMemoryDayFile([unknown]));
  await seedPrepairedIdentity(vault);

  const conv = conversation("mem-wiring-d-conv");
  const memA = memory("mem-wiring-d-a", day, { createdAt: `${day}T09:00:00.000Z` });
  const memB = memory("mem-wiring-d-b", day, { createdAt: `${day}T09:01:00.000Z` });
  await captureMod.persistCapture(vault.root(), conv, [memA, memB]);

  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  const members = markdownMod.parseMemoryDayFile(vault.get(path)!);
  assert.equal(members.length, 3, "unknown + A + Bの3件");
  assert.ok(members.some((m) => m.id === unknown.id), "既存の未知memberは保持される");
  assert.ok(members.some((m) => m.id === memA.id));
  assert.ok(members.some((m) => m.id === memB.id));
});

// ===========================================================================
// E：Registry/History/index部分欠落→次回bootstrapで自動修復（Recovery扱いにならない）
// ===========================================================================

test("Wiring E: persistCapture後にRegistry/History/indexが部分的に欠けても、次回bootstrapで自動修復されRecovery誘導にならない", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const day = "2026-10-04";
  const conv = conversation("mem-wiring-e-conv");
  const mem = memory("mem-wiring-e-mem", day);
  await captureMod.persistCapture(vault.root(), conv, [mem]);
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));

  // Registryだけを外部で欠落させる（実機で確認された破損パターン）。
  const registryKey = vaultMod.dayFileRegistryKey(day);
  const shardPath = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(registryKey).toString(16).padStart(2, "0")}.json`;
  vault.files.delete(shardPath);

  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  void result;
  const shard = JSON.parse(vault.get(shardPath)!);
  assert.equal(shard.records[registryKey], `Memories/${vaultMod.dayFileNameFor(day)}`, "Registryが自動修復される");
  const entry = await dbMod.getVaultOutboxEntry(`memory:${mem.id}`);
  assert.equal(entry!.status, "done", "Recovery誘導（held）にならない");
});

// ===========================================================================
// F：1件のconflictが他recordのprojectionを止めない
// ===========================================================================

test("Wiring F: persistCaptureで保存した複数Memoryのうち1件がconflictでも、他は正常にdoneへ収束する", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const day = "2026-10-05";
  const conv = conversation("mem-wiring-f-conv");
  const memOk = memory("mem-wiring-f-ok", day, { createdAt: `${day}T09:00:00.000Z` });
  const memConflict = memory("mem-wiring-f-conflict", day, { createdAt: `${day}T09:01:00.000Z`, content: "canonical側の内容" });
  await captureMod.persistCapture(vault.root(), conv, [memOk, memConflict]);

  // conflictを外部から仕込む（Vault側だけ食い違う内容にする）。
  const path = `Memories/${vaultMod.dayFileNameFor(day)}`;
  const conflictOnDisk = { ...memConflict, content: "外部で食い違う内容" };
  vault.put(path, markdownMod.serializeMemoryDayFile([conflictOnDisk]));
  await seedPrepairedIdentity(vault);

  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  const okEntry = await dbMod.getVaultOutboxEntry(`memory:${memOk.id}`);
  assert.equal(okEntry!.status, "done", "conflictしていない方は正常に収束する");
  const members = markdownMod.parseMemoryDayFile(vault.get(path)!);
  assert.ok(members.some((m) => m.id === memOk.id));
  const stillConflict = members.find((m) => m.id === memConflict.id)!;
  assert.equal(stillConflict.content, "外部で食い違う内容", "conflictな外部データは上書きされない");
});

// ===========================================================================
// G：restart/idempotency
// ===========================================================================

test("Wiring G: 同じbootstrapを複数回実行しても、persistCapture/persistSourceで保存したrecordが重複しない", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const day = "2026-10-06";
  const conv = conversation("mem-wiring-g-conv");
  const mem = memory("mem-wiring-g-mem", day);
  const refl = reflection("mem-wiring-g-refl", day);
  await captureMod.persistCapture(vault.root(), conv, [mem, refl]);
  const src = source("mem-wiring-g-src");
  await sourceMod.persistSource(vault.root(), src);

  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  const writesBefore = vault.writeCount;
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(vault.writeCount, writesBefore, "2回目以降は1byteも書き込まない");

  const path = `Memories/${vaultMod.dayFileNameFor(day)}`;
  const members = markdownMod.parseMemoryDayFile(vault.get(path)!);
  assert.equal(members.length, 1, "day-fileにMemoryが重複していない");
  // index.jsonは、persistCaptureが内部でConversation canonicalも保存するため
  // （persistConversationImpl経由）、migrationがConversationも合わせてidb-only
  // classificationでprojectionする——conv/mem/refl/srcの4 id、重複が無いことを確認する
  // （「4」という数自体ではなく、各idが1回ずつ・duplicateが無いことが本質）。
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.deepEqual(new Set(Object.keys(index)), new Set([conv.id, mem.id, refl.id, src.id]));
});

// ===========================================================================
// H：canonical + outbox transaction途中の失敗で片方だけcommitされない
// ===========================================================================

test("Wiring H: canonical+outbox transactionの途中（vaultOutbox側put）が失敗した場合、canonical側だけがcommitされたままにならない", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const day = "2026-10-07";
  const conv = conversation("mem-wiring-h-conv");
  const mem = memory("mem-wiring-h-mem", day);
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox"); // 同一transaction内のvaultOutbox側putだけを失敗させる

  const result = await captureMod.persistCapture(vault.root(), conv, [mem]);
  assert.deepEqual(result.failedMemoryIds, [mem.id], "transaction失敗はIndexedDB write失敗として呼び出し元へ伝わる");
  const stored = await dbMod.getMemoryObject(mem.id);
  assert.equal(stored, undefined, "canonical側だけが先にcommitされている状態にはならない（transaction全体がabortされる）");
  const outbox = await dbMod.getVaultOutboxEntry(`memory:${mem.id}`);
  assert.equal(outbox, undefined, "outbox側だけが残ることも無い");
});

test("Wiring H2: Source側でも、canonical+outbox transactionの途中失敗で片方だけcommitされない", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const src = source("mem-wiring-h2-src");
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox");

  const result = await sourceMod.persistSource(vault.root(), src);
  assert.equal(result.indexedDbFailed, true);
  const stored = await dbMod.getSource(src.id);
  assert.equal(stored, undefined, "canonical側だけが先にcommitされている状態にはならない");
  const outbox = await dbMod.getVaultOutboxEntry(`source:${src.id}`);
  assert.equal(outbox, undefined);
});


test("atomic failure: Memory/Reflection must not call either foreground or background Vault writer", async () => {
  const oldWrite = vaultMod.writeMemoryObjectMarkdown;
  let calls = 0;
  vaultMod.writeMemoryObjectMarkdown = async () => { calls += 1; };
  try {
    for (const make of [memory, reflection]) for (const awaitSync of [true, false]) {
      await setUpVaultWorld();
      const mem = make("atomic-failed", "2026-10-08");
      fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox");
      const result = await captureMod.persistCapture(new FakeVault().root(), conversation("atomic-c"), [mem], "interactive", awaitSync);
      await result.backgroundSyncPromise;
      assert.deepEqual(result.failedMemoryIds, [mem.id]);
      assert.equal(calls, 0, "no projection before canonical transaction commits");
    }
  } finally { vaultMod.writeMemoryObjectMarkdown = oldWrite; }
});

test("dual writer: bootstrap and legacy Memory writes never drop already-written day members", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const day = "2026-10-09";
  const first = memory("race-initial", day);
  await captureMod.persistCapture(null, conversation("race-c"), [first]);
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  const a = memory("race-a", day), b = memory("race-b", day);
  await captureMod.persistCapture(null, conversation("race-c"), [a]);
  const filePath = `Memories/${vaultMod.dayFileNameFor(day)}`;
  const primitives = vaultMod.vaultProjectionPrimitives;
  const oldWrite = primitives.writeFileInDir;
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(r => { entered = r; });
  const barrier = new Promise<void>(r => { release = r; });
  let once = true;
  primitives.writeFileInDir = async (...args: Parameters<typeof oldWrite>) => {
    if (once && args[1] === vaultMod.dayFileNameFor(day)) { once = false; entered(); await barrier; }
    return oldWrite(...args);
  };
  try {
    const bootstrap = bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
    await paused;
    const legacy = captureMod.persistCapture(vault.root(), conversation("race-c"), [b]);
    // Allow the competing writer to reach the paused read/modify/write interval.
    await new Promise(r => setTimeout(r, 30));
    release();
    await Promise.all([bootstrap, legacy]);
    const seen = new Set<string>();
    for (const write of vault.writes.filter(w => w.path === filePath)) {
      const ids = new Set(markdownMod.parseMemoryDayFile(write.content).map(m => m.id));
      for (const id of seen) assert.ok(ids.has(id), `previously written member lost: ${id}`);
      for (const id of ids) seen.add(id);
    }
    assert.deepEqual(seen, new Set([first.id, a.id, b.id]));
  } finally { release(); primitives.writeFileInDir = oldWrite; }
});

test("Source same-ID different-content stays conflict through the production legacy writer", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  const original = source("source-conflict");
  await sourceMod.persistSource(null, original);
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  const filePath = `Sources/${vaultMod.fileNameFor(original.id, original.createdAt)}`;
  const before = vault.get(filePath);
  await sourceMod.persistSource(vault.root(), { ...original, content: "different", updatedAt: "2026-10-02T00:00:00.000Z" });
  assert.equal(vault.get(filePath), before);
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(vault.get(filePath), before);
  assert.equal((await dbMod.getVaultOutboxEntry(`source:${original.id}`))?.status, "held");
});


test("partial metadata write failure: pending outbox repairs History after Markdown succeeded", async () => {
  await setUpVaultWorld();
  const vault = new FakeVault();
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
  await seedPrepairedIdentity(vault);
  const day = "2026-10-10", mem = memory("history-retry", day);
  const historyPath = ".tsumugi/history/2026-10.json";
  vault.writeShouldFail.add(historyPath);
  await captureMod.persistCapture(vault.root(), conversation("history-retry-c"), [mem]);
  assert.ok(vault.failedWrites.includes(historyPath));
  assert.ok(vault.get(`Memories/${vaultMod.dayFileNameFor(day)}`));
  assert.equal((await dbMod.getVaultOutboxEntry(`memory:${mem.id}`))?.status, "pending");
  vault.writeShouldFail.clear();
  await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal((await dbMod.getVaultOutboxEntry(`memory:${mem.id}`))?.status, "done");
  const history = JSON.parse(vault.get(historyPath)!);
  assert.ok(history.days[day].normalMemories.some((row: { id: string }) => row.id === mem.id));
});
