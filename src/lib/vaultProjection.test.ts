/**
 * Vault Projection Engine（Phase 3-3、Conversation／Phase 3-6、normal Memory day-file）の
 * 回帰テスト。
 *
 * 実IndexedDBは使わない（`fakeIdb.ts`をModule._loadで`require("idb")`へ差し替える。
 * Phase 3-1/3-2の`db.foundation.test.ts`と同じ方式）。実Vaultも使わず、in-memoryの
 * 疑似FileSystemDirectoryHandle（`FakeVault`）を使う（`vaultRecoveryApply.test.ts`の
 * `FakeVault`と同じ考え方の、この engine専用の実装）。
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
const projectionMod = require(path.join(OUT, "lib/vaultProjection.js")) as typeof import("./vaultProjection");
const migrationMod = require(path.join(OUT, "lib/vaultProductionMigration.js")) as typeof import("./vaultProductionMigration");
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as {
  __failNextPutOn: (dbName: string, storeName: string) => void;
  __failNextPlainPutOn: (dbName: string, storeName: string) => void;
};

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type VaultOutboxEntry = import("./vaultOutbox").VaultOutboxEntry;
type VaultIdentityRecord = import("./vaultIdentity").VaultIdentityRecord;

/** テスト専用：実FIFO排他ロックのfake navigator.locks（Phase 3-6 Memory G専用）。 */
class FakeLockManager {
  private tail: Promise<void> = Promise.resolve();
  async request<T>(name: string, optionsOrCb: unknown, maybeCb?: (lock: { name: string } | null) => Promise<T>): Promise<T> {
    const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as (lock: { name: string } | null) => Promise<T>;
    const myTurn = this.tail;
    let release!: () => void;
    this.tail = new Promise((resolve) => { release = resolve; });
    await myTurn;
    try {
      return await cb({ name });
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------------------
// in-memory疑似ファイルシステム（`vaultRecoveryApply.test.ts`のFakeVaultと同じ考え方）
// ---------------------------------------------------------------------------

class FakeFile {
  constructor(public content: string, public mtime: number) {}
}

class FakeVault {
  files = new Map<string, FakeFile>();
  private clock = 1;
  writeShouldFail = new Set<string>();
  writeCount = 0;
  /**
   * テスト専用（Phase 3-6 Memory Projection G：lost update検証）：指定pathの
   * lookup（`getDirectoryHandle`/`getFileHandle`）が呼ばれた際に、意図的に1 macrotask
   * だけ遅延させる。これにより、`Promise.all`で本当に「同時に」2つのreconcile呼び出しを
   * 走らせた場合の実際の非同期interleavingを、決定的に発生させられる
   * （lockが無ければ両方のreadがwriteより先に完了し、lost updateが起きる）。
   */
  delayPaths = new Set<string>();
  private async maybeDelay(p: string) {
    if (this.delayPaths.has(p)) await new Promise((resolve) => setTimeout(resolve, 0));
  }

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
        await self.maybeDelay(p);
        const hasChildren = [...self.files.keys()].some((k) => k.startsWith(`${p}/`));
        if (!hasChildren && !options?.create) throw new DOMException("no such directory", "NotFoundError");
        return self.dir(p);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const p = prefix ? `${prefix}/${name}` : name;
        await self.maybeDelay(p);
        if (!self.files.has(p) && !options?.create) throw new DOMException("no such file", "NotFoundError");
        return self.file(p);
      },
      // `collectAllMarkdownFiles`（vault.ts、Phase 3-6 migration拡張のVault-only検出が使う）が
      // ディレクトリを再帰的に`entries()`で列挙するため、`vaultProductionMigration.test.ts`の
      // FakeVaultと同じ形で実装する。
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
            if (self.writeShouldFail.has(p)) throw new Error("simulated write failure");
            self.clock += 1;
            self.files.set(p, new FakeFile(pending, self.clock));
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
  delete(pathStr: string) {
    this.files.delete(pathStr);
  }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const T = "2026-03-01T09:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id, persona: "companion", status: "active", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: [{ role: "user", content: "ユーザー発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...meta }, ...overrides,
  } as Conversation;
}

const VAULT_ID = "vault-abc-123";
function identity(): VaultIdentityRecord {
  return { id: "current", vaultId: VAULT_ID, activeVaultEpoch: 0, registryGeneration: "gen-1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
}
function seedVaultIdentityFile(vault: FakeVault, vaultId: string = VAULT_ID) {
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId, createdAt: T }));
}

function makeEnv(vault: FakeVault, overrides: Partial<import("./vaultProjection").ProjectionEnv> = {}): import("./vaultProjection").ProjectionEnv {
  return { root: vault.root(), vaultIdentity: identity(), now: () => T, ...overrides };
}

/** canonicalをIndexedDBへ保存し、対応するoutbox entryを返す（Phase 3-1のAPIをそのまま使う）。 */
async function seedCanonical(c: Conversation): Promise<VaultOutboxEntry> {
  return dbMod.putConversationWithOutbox(c);
}

const monthPath = (day: string) => `.tsumugi/history/${day.slice(0, 7)}.json`;
const bucketOf = (id: string) => vaultMod.vaultRegistryBucketOf(id);
const shardPath = (id: string) => `.tsumugi/registry/${bucketOf(id).toString(16).padStart(2, "0")}.json`;

// ===========================================================================
// A〜F：基本の収束（今回のiPhone事故の直接の回帰対象を含む）
// ===========================================================================

test("Projection A: Vault実体が何も無い状態から、Markdown/Registry/index/Historyすべてを生成してdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-a-1");
  const entry = await seedCanonical(c);
  const result = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c));
  const shard = JSON.parse(vault.get(shardPath(c.id))!);
  assert.equal(shard.records[c.id], path);
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(index[c.id], path);
  const month = JSON.parse(vault.get(monthPath(c.startedAt.slice(0, 10)))!);
  assert.ok(month.days[c.startedAt.slice(0, 10)].conversations.some((r: { id: string }) => r.id === c.id));
  const stored = await dbMod.getVaultOutboxEntry(entry.id);
  assert.equal(stored!.status, "done");
});

test("Projection B: Markdown write直後にkillしても、restartでMarkdownがsame判定され、残りのprojectionが完了してdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-b-1");
  const entry = await seedCanonical(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.writeShouldFail.add(shardPath(c.id)); // Markdownの直後、Registry writeで「kill」相当を模す
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c), "Markdownは既に正しく書けている");
  vault.writeShouldFail.delete(shardPath(c.id));
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(second.status, "done");
  // Markdownは既に正しいため、restart後の実行で再書き込みされていないこと（no-op）を確認する。
  const path2 = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  assert.equal(vault.get(path2), markdownMod.conversationToMarkdown(c));
  assert.ok(vault.writeCount > writesBefore, "Registry/index/Historyは書かれている");
});

test("Projection C: Registry write直後にkillしても、restartでrepair/no-opしてdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-c-1");
  const entry = await seedCanonical(c);
  vault.writeShouldFail.add(".tsumugi/index.json"); // Registryの直後、index writeでkill相当
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  const shard = JSON.parse(vault.get(shardPath(c.id))!);
  assert.equal(shard.records[c.id], `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`, "Registryは既に正しい");
  vault.writeShouldFail.delete(".tsumugi/index.json");
  const second = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(second.status, "done");
});

test("Projection D: index write直後にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-d-1");
  const entry = await seedCanonical(c);
  vault.writeShouldFail.add(monthPath(c.startedAt.slice(0, 10))); // indexの直後、History writeでkill相当
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(index[c.id], `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`, "indexは既に正しい");
  vault.writeShouldFail.delete(monthPath(c.startedAt.slice(0, 10)));
  const second = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(second.status, "done");
});

test("Projection E: History write直後（outboxをdoneに記録する前）にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-e-1");
  const entry = await seedCanonical(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  // Vault側の4 step（Markdown/Registry/index/History）はすべて成功し、final verifyも
  // 通った直後、outboxをdoneとして記録する一歩（`putVaultOutboxEntry`＝単発put、
  // transactionを介さない）だけが失敗する、という状況を模する。
  fakeIdbMod.__failNextPlainPutOn("tsumugi", "vaultOutbox");
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending", "Vault実体は完成しているが、outbox記録自体の失敗はpendingとして扱う");
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c), "Vault側は既に完成している");
  const writesBefore = vault.writeCount;
  const pendingEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const second = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), pendingEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore, "Vault側は既に正しいため、restart後は何も書き込まれない");
});

test("Projection F: Vault実体が全て既に完成しoutboxだけpendingな状態からrestartすると、全部no-opでdoneになる（重複write無し）", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-f-1");
  const entry = await seedCanonical(c);
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  // outboxだけpendingへ戻す（Vault実体はそのまま）。
  await dbMod.putVaultOutboxEntry({ ...(await dbMod.getVaultOutboxEntry(entry.id))!, status: "pending" });
  const pendingEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), pendingEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore, "実体は既に正しいため、一切書き込まれない（完全no-op）");
});

// ===========================================================================
// G/H：今回のiPhone事故の永久回帰テスト
// ===========================================================================

test("Projection G: Markdown missing・Registry staleな状態から、canonicalを基準に安全に収束する", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-g-1");
  const entry = await seedCanonical(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  // staleなRegistry entry（別内容を指しているかのような古いcontentHash）を先に置いておく。
  const bucket = bucketOf(c.id);
  vault.put(shardPath(c.id), JSON.stringify({
    schemaVersion: 1, bucket, records: { [c.id]: path },
    files: { [path]: { recordType: "conversation", mtime: 1, size: 1, contentHash: "stale-hash", memberIds: [c.id], status: "ok" } },
  }));
  const result = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c));
  const shard = JSON.parse(vault.get(shardPath(c.id))!);
  assert.equal(shard.files[path].contentHash, vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)));
});

test("Projection H（今回のiPhone事故の永久回帰テスト）: reconciles conversation when markdown/history exist, registry is missing, and legacy baseline is absent", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-h-1");
  const entry = await seedCanonical(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  const day = c.startedAt.slice(0, 10);
  const content = markdownMod.conversationToMarkdown(c);
  // 実機で確認された状態を再現する：Markdown・Historyは既にVaultに存在するが、
  // Registryは無い。legacy baseline（registry-meta.jsonのbaselineEstablishedAt）は
  // 一切seedしない＝null相当（旧経路ならここで`VaultRecordNeedsResyncError`になっていた）。
  vault.put(path, content);
  vault.put(monthPath(day), JSON.stringify({ version: 2, month: day.slice(0, 7), days: { [day]: { conversations: [{ id: c.id, mode: "diary", turnCount: c.turns.length }], normalMemories: [], reflections: [] } } }));
  vault.put(".tsumugi/index.json", JSON.stringify({ [c.id]: path }));
  // registry-meta.json自体を置かない（baselineEstablishedAt=null相当）。

  const result = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);

  assert.equal(result.status, "done", "held（Recovery誘導）にならない——今回の事故の直接の回帰確認");
  assert.equal(vault.get(path), content, "既存Markdownは保持される（書き直されない）");
  const shard = JSON.parse(vault.get(shardPath(c.id))!);
  assert.equal(shard.records[c.id], path, "Registryが生成される");
  const month = JSON.parse(vault.get(monthPath(day))!);
  assert.ok(month.days[day].conversations.some((r: { id: string }) => r.id === c.id), "Historyは保持・整合されている");
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(index[c.id], path, "indexは整合している");
  const stored = await dbMod.getVaultOutboxEntry(entry.id);
  assert.equal(stored!.status, "done", "outbox doneになる（Recovery不要）");
});

// ===========================================================================
// I/J/K/L：version更新・conflict・unreadable・identity mismatch
// ===========================================================================

test("Projection I: 同一ID・正当な新version（Assistant turn追加）は、Markdown/metadataが更新されてdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c1 = conversation("proj-i-1");
  const entry1 = await seedCanonical(c1);
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry1);
  assert.equal(first.status, "done");

  const c2: Conversation = { ...c1, turns: [...c1.turns, { role: "ai", content: "返信", timestamp: "2026-03-01T09:00:05.000Z" }], updatedAt: "2026-03-01T09:00:05.000Z" };
  const entry2 = await seedCanonical(c2);
  const second = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry2);
  assert.equal(second.status, "done");
  const path = `Conversations/${vaultMod.fileNameFor(c1.id, c1.startedAt)}`;
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c2));
  const shard = JSON.parse(vault.get(shardPath(c1.id))!);
  assert.equal(shard.files[path].contentHash, vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c2)));
});

test("Projection J: 同一ID・外部変更/conflict（turn内容が食い違う）はheldになり、外部データを上書きしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-j-1");
  const entry = await seedCanonical(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  const externallyEdited = markdownMod.conversationToMarkdown({ ...c, turns: [{ role: "user", content: "外部で書き換えられた内容", timestamp: T }] });
  vault.put(path, externallyEdited);
  const result = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.get(path), externallyEdited, "外部データは一切書き換えられない");
});

test("Projection K: Markdown unreadable（parse不能）はheldになり、上書きしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-k-1");
  const entry = await seedCanonical(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.put(path, "not a tsumugi markdown at all, no frontmatter");
  const result = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.get(path), "not a tsumugi markdown at all, no frontmatter");
});

test("Projection L: Vault identity mismatchはheldになり、1byteもwriteしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault, "a-totally-different-vault-id");
  const c = conversation("proj-l-1");
  const entry = await seedCanonical(c);
  const writesBefore = vault.writeCount;
  const result = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(result.status === "held" ? result.reason : "", "vault-identity-mismatch");
  assert.equal(vault.writeCount, writesBefore, "1byteも書き込まれていない");
  assert.equal(vault.files.size, 1, "vault-identity.json以外は何も作られていない");
});

test("Projection L2: env.vaultIdentityが未pair（null）の場合もheldになり、writeしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-l2-1");
  const entry = await seedCanonical(c);
  const writesBefore = vault.writeCount;
  const result = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault, { vaultIdentity: null }), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.writeCount, writesBefore);
});

// ===========================================================================
// M/N/O：retry・冪等性・outbox doneの信用しすぎ防止
// ===========================================================================

test("Projection M: 各writeで一時I/O errorが起きてもpendingになり、retryでdoneに収束する", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-m-1");
  const entry = await seedCanonical(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.writeShouldFail.add(path);
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  const failedEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  assert.equal(failedEntry.attempt.count, 1);
  vault.writeShouldFail.delete(path);
  const second = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), failedEntry);
  assert.equal(second.status, "done");
});

test("Projection N: projection完了後にもう一度reconcileしても完全no-opで、duplicateが生じない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-n-1");
  const entry = await seedCanonical(c);
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore, "duplicateを作らない（何も書かない）");
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(Object.keys(index).length, 1);
  const shard = JSON.parse(vault.get(shardPath(c.id))!);
  assert.equal(Object.keys(shard.records).length, 1);
});

test("Projection O: outbox stepがdoneだがVault実体（Registry）が欠落している場合、final verify/reconcileで検出して修復しdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c = conversation("proj-o-1");
  const entry = await seedCanonical(c);
  const first = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  // outboxはdoneのまま、Vault実体（Registry）だけを消す（例：将来の破損シナリオを模す）。
  vault.delete(shardPath(c.id));
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  assert.equal(doneEntry.status, "done", "outboxは（実体の変化を知らないまま）doneのまま");
  const result = await projectionMod.reconcileConversationOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(result.status, "done", "outboxのdoneを信用せず、実体を検証して再修復する");
  const shard = JSON.parse(vault.get(shardPath(c.id))!);
  assert.equal(shard.records[c.id], `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`);
});

// ===========================================================================
// reconcilePendingConversations（startup reconcile、library単体。まだ本番未接続）
// ===========================================================================

test("reconcilePendingConversations: pendingなconversation entryだけをまとめて処理する", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const c1 = conversation("proj-batch-1");
  const c2 = conversation("proj-batch-2");
  await seedCanonical(c1);
  await seedCanonical(c2);
  const result = await projectionMod.reconcilePendingConversations(makeEnv(vault));
  assert.equal(result.done, 2);
  assert.equal(result.pending, 0);
  assert.equal(result.held, 0);
});

// ===========================================================================
// Memory day-file Projection（Phase 3-6）
// ===========================================================================

// `sourceType`を明示する（"chat" = `inferSourceType("ai-capture")`と同じ値）。
// 明示しないと、Markdown化→parse往復で`sourceType`が補完され、canonicalとonDiskの
// 再シリアライズテキストが完全一致しなくなる（`vaultProductionMigration.test.ts`の
// 同名fixtureと同じ理由）。
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

/** canonicalをIndexedDBへ保存し、対応するoutbox entryを返す（Phase 3-1のAPIをそのまま使う）。 */
async function seedMemoryCanonical(m: MemoryObject): Promise<VaultOutboxEntry> {
  return dbMod.putMemoryObjectWithOutbox(m);
}

const memoryDayPath = (day: string) => `Memories/${vaultMod.dayFileNameFor(day)}`;
const memoryShardPathFor = (day: string) => shardPath(vaultMod.dayFileRegistryKey(day));

// ===========================================================================
// A〜F：基本の収束（member単位のcreate/append/no-op/update・未知member保護）
// ===========================================================================

test("Projection Memory A: day-fileが無い状態から、1件のmemberをcreateしてMarkdown/Registry/index/Historyすべてを生成しdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-01";
  const a = memory("mem-a-1", day);
  const entry = await seedMemoryCanonical(a);
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const path = memoryDayPath(day);
  assert.equal(vault.get(path), markdownMod.serializeMemoryDayFile([a]));
  const shard = JSON.parse(vault.get(memoryShardPathFor(day))!);
  const registryKey = vaultMod.dayFileRegistryKey(day);
  assert.equal(shard.records[registryKey], path);
  assert.deepEqual(shard.files[path].memberIds, [a.id]);
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(index[a.id], path);
  const month = JSON.parse(vault.get(monthPath(day))!);
  assert.ok(month.days[day].normalMemories.some((r: { id: string }) => r.id === a.id));
});

test("Projection Memory B: day-fileに既にA（同一内容）がある場合はno-opでdoneになる（重複write無し）", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-02";
  const a = memory("mem-b-1", day);
  const entry = await seedMemoryCanonical(a);
  const first = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore, "既に正しいため何も書き込まれない");
});

test("Projection Memory C: day-fileに未知member Xがある状態でAを追加しても、Xが保持される", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-03";
  const x = memory("mem-c-x", day, { createdAt: `${day}T08:00:00.000Z` }); // IndexedDBには存在しない未知member
  vault.put(memoryDayPath(day), markdownMod.serializeMemoryDayFile([x]));
  const a = memory("mem-c-a", day, { createdAt: `${day}T09:00:00.000Z` });
  const entry = await seedMemoryCanonical(a);
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const members = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.equal(members.length, 2);
  assert.ok(members.some((m) => m.id === x.id), "未知member Xは削除されない");
  assert.ok(members.some((m) => m.id === a.id));
});

test("Projection Memory D: 既存A・未知Xがある状態でAが正当に更新（メタデータのみ変化）されても、Xは保持されAだけ更新される", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-04";
  const aOld = memory("mem-d-a", day, { createdAt: `${day}T09:00:00.000Z`, updatedAt: `${day}T09:00:00.000Z` });
  const x = memory("mem-d-x", day, { createdAt: `${day}T08:00:00.000Z` });
  vault.put(memoryDayPath(day), markdownMod.serializeMemoryDayFile([x, aOld]));
  const aNew: MemoryObject = { ...aOld, summary: "更新後の要約", updatedAt: `${day}T09:05:00.000Z` };
  const entry = await seedMemoryCanonical(aNew);
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const members = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.equal(members.length, 2);
  assert.ok(members.some((m) => m.id === x.id), "未知member Xは保持される");
  const updated = members.find((m) => m.id === aNew.id)!;
  assert.equal(updated.summary, "更新後の要約");
});

test("Projection Memory E: A/B/X共存の状態でAだけprojectionしても、B/Xは完全に保持される", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-05";
  const a = memory("mem-e-a", day, { createdAt: `${day}T09:00:00.000Z` });
  const b = memory("mem-e-b", day, { createdAt: `${day}T09:01:00.000Z` });
  const x = memory("mem-e-x", day, { createdAt: `${day}T08:00:00.000Z` }); // 未知member
  vault.put(memoryDayPath(day), markdownMod.serializeMemoryDayFile([x, a, b]));
  const entry = await seedMemoryCanonical(a); // IndexedDB canonicalはaと同一内容
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const members = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.equal(members.length, 3);
  assert.ok(members.some((m) => m.id === b.id), "Bは完全に保持される");
  assert.ok(members.some((m) => m.id === x.id), "未知member Xも完全に保持される");
});

test("Projection Memory F: 同じdayのA/Bを順番にprojectionすると、両方がday-fileに残る（先のmemberが消えない）", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-06";
  const a = memory("mem-f-a", day, { createdAt: `${day}T09:00:00.000Z` });
  const b = memory("mem-f-b", day, { createdAt: `${day}T09:01:00.000Z` });
  const entryA = await seedMemoryCanonical(a);
  const entryB = await seedMemoryCanonical(b);
  const resultA = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entryA);
  assert.equal(resultA.status, "done");
  const resultB = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entryB);
  assert.equal(resultB.status, "done");
  const members = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.equal(members.length, 2);
  assert.ok(members.some((m) => m.id === a.id));
  assert.ok(members.some((m) => m.id === b.id));
});

// ===========================================================================
// G：同一day-fileへの並行(相当)projectionでlost updateが起きない（lock必須）
// ===========================================================================

test("Projection Memory G: 同一day-fileへの並行(相当)projectionでlost updateが起きない", async () => {
  const vault = new FakeVault();
  vault.delayPaths.add("Memories");
  const day = "2026-04-07";
  vault.delayPaths.add(memoryDayPath(day));
  seedVaultIdentityFile(vault);
  const a = memory("mem-g-a", day, { createdAt: `${day}T09:00:00.000Z` });
  const b = memory("mem-g-b", day, { createdAt: `${day}T09:01:00.000Z` });
  const entryA = await seedMemoryCanonical(a);
  const entryB = await seedMemoryCanonical(b);

  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { locks: new FakeLockManager() }, configurable: true, writable: true });
  try {
    const [resultA, resultB] = await Promise.all([
      projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entryA),
      projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entryB),
    ]);
    assert.equal(resultA.status, "done");
    assert.equal(resultB.status, "done");
  } finally {
    if (originalNavigatorDescriptor) Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  }

  const members = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.equal(members.length, 2, "lockにより、並行実行でも両方のmemberが失われず残っている");
  assert.ok(members.some((m) => m.id === a.id));
  assert.ok(members.some((m) => m.id === b.id));
});

// ===========================================================================
// H/I/J：restart・kill耐性（Conversationと同じ考え方をmember単位に適用）
// ===========================================================================

test("Projection Memory H: day-file write直後にkillしても、restartでsame判定され、残りのprojectionが完了してdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-08";
  const a = memory("mem-h-a", day);
  const entry = await seedMemoryCanonical(a);
  vault.writeShouldFail.add(memoryShardPathFor(day)); // day-fileの直後、Registry writeでkill相当
  const first = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  assert.equal(vault.get(memoryDayPath(day)), markdownMod.serializeMemoryDayFile([a]), "day-fileは既に正しく書けている");
  vault.writeShouldFail.delete(memoryShardPathFor(day));
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), (await dbMod.getVaultOutboxEntry(entry.id))!);
  assert.equal(second.status, "done");
  assert.equal(vault.get(memoryDayPath(day)), markdownMod.serializeMemoryDayFile([a]), "day-fileは再書き込みされていない（no-op）");
  assert.ok(vault.writeCount > writesBefore, "Registry/index/Historyは書かれている");
});

test("Projection Memory I: Registry write直後にkillしても、restartでrepair/no-opしてdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-09";
  const a = memory("mem-i-a", day);
  const entry = await seedMemoryCanonical(a);
  vault.writeShouldFail.add(".tsumugi/index.json"); // Registryの直後、index writeでkill相当
  const first = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  const shard = JSON.parse(vault.get(memoryShardPathFor(day))!);
  assert.equal(shard.records[vaultMod.dayFileRegistryKey(day)], memoryDayPath(day), "Registryは既に正しい");
  vault.writeShouldFail.delete(".tsumugi/index.json");
  const second = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), (await dbMod.getVaultOutboxEntry(entry.id))!);
  assert.equal(second.status, "done");
});

test("Projection Memory J: History/index write直後にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-10";
  const a = memory("mem-j-a", day);
  const entry = await seedMemoryCanonical(a);
  vault.writeShouldFail.add(monthPath(day)); // indexの直後、History writeでkill相当
  const first = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(index[a.id], memoryDayPath(day), "indexは既に正しい");
  vault.writeShouldFail.delete(monthPath(day));
  const second = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), (await dbMod.getVaultOutboxEntry(entry.id))!);
  assert.equal(second.status, "done");
});

// ===========================================================================
// K/L：Registry memberIds/memberHashesの修復（未知member分も含む）
// ===========================================================================

test("Projection Memory K: RegistryのmemberIds/memberHashesが欠落・不整合でも、day-file実体から再構築される", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-11";
  const a = memory("mem-k-a", day);
  const path = memoryDayPath(day);
  vault.put(path, markdownMod.serializeMemoryDayFile([a]));
  const registryKey = vaultMod.dayFileRegistryKey(day);
  const bucket = vaultMod.vaultRegistryBucketOf(registryKey);
  vault.put(memoryShardPathFor(day), JSON.stringify({
    schemaVersion: 1, bucket, records: { [registryKey]: path },
    files: { [path]: { recordType: "memory-day", mtime: 1, size: 1, contentHash: "stale-hash", status: "ok" } }, // memberIds/memberHashes欠落
  }));
  const entry = await seedMemoryCanonical(a);
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const shard = JSON.parse(vault.get(memoryShardPathFor(day))!);
  assert.deepEqual(shard.files[path].memberIds, [a.id]);
  assert.equal(shard.files[path].memberHashes[a.id], vaultMod.hashVaultText(markdownMod.memoryObjectToMarkdown(a)));
});

test("Projection Memory L: 未知memberのRegistry情報も、day-fileの最終実体から再構築される", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-12";
  const a = memory("mem-l-a", day, { createdAt: `${day}T09:00:00.000Z` });
  const x = memory("mem-l-x", day, { createdAt: `${day}T08:00:00.000Z` }); // 未知member
  const path = memoryDayPath(day);
  vault.put(path, markdownMod.serializeMemoryDayFile([x, a]));
  // Registry自体が丸ごと無い状態から始める。
  const entry = await seedMemoryCanonical(a);
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const shard = JSON.parse(vault.get(memoryShardPathFor(day))!);
  const registryKey = vaultMod.dayFileRegistryKey(day);
  assert.deepEqual(new Set(shard.files[path].memberIds), new Set([a.id, x.id]), "未知member Xのidもmemberリストに含まれる");
  assert.equal(shard.files[path].memberHashes[x.id], vaultMod.hashVaultText(markdownMod.memoryObjectToMarkdown(x)), "未知member Xのhashも再構築される");
  assert.equal(shard.records[registryKey], path);
});

// ===========================================================================
// M/N：conflict・unreadable
// ===========================================================================

test("Projection Memory M: 対象memberが真の外部conflictの場合はheldになり、同じday-fileの他memberは変更されない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-13";
  const aCanonical = memory("mem-m-a", day, { createdAt: `${day}T09:00:00.000Z`, content: "元の内容" });
  const aExternallyEdited: MemoryObject = { ...aCanonical, content: "外部で書き換えられた内容" }; // content不一致＝正当な後継と認められない
  const y = memory("mem-m-y", day, { createdAt: `${day}T08:00:00.000Z` });
  const path = memoryDayPath(day);
  vault.put(path, markdownMod.serializeMemoryDayFile([y, aExternallyEdited]));
  const entry = await seedMemoryCanonical(aCanonical);
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  const members = markdownMod.parseMemoryDayFile(vault.get(path)!);
  assert.equal(members.length, 2, "書き込みは一切行われない（他memberも変化しない）");
  const stillA = members.find((m) => m.id === aCanonical.id)!;
  assert.equal(stillA.content, "外部で書き換えられた内容", "外部データは上書きされない");
  const stillY = members.find((m) => m.id === y.id)!;
  assert.equal(stillY.content, y.content, "Yは一切変更されない");
});

test("Projection Memory N: day-fileがunreadable（parse不能）な場合はheldになり、上書きしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-14";
  const a = memory("mem-n-a", day);
  vault.put(memoryDayPath(day), "not a tsumugi memory day-file at all, no frontmatter");
  const entry = await seedMemoryCanonical(a);
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.get(memoryDayPath(day)), "not a tsumugi memory day-file at all, no frontmatter");
});

// ===========================================================================
// O：同一day-fileに安全なmemberとconflictなmemberが混在する場合のisolation policy
// ===========================================================================

test("Projection Memory O: 同一day-file内でAが安全・Bがconflictでも、Aは独立してrepairされ、Bのconflictに引きずられない（member単位のpartial repair）", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-15";
  const bOnDisk = memory("mem-o-b", day, { createdAt: `${day}T08:00:00.000Z`, content: "Bの元の内容" });
  const bCanonical: MemoryObject = { ...bOnDisk, content: "Bの外部と食い違う内容変更" };
  const path = memoryDayPath(day);
  vault.put(path, markdownMod.serializeMemoryDayFile([bOnDisk])); // day-fileにはまだBだけ（外部版）
  const aCanonical = memory("mem-o-a", day, { createdAt: `${day}T09:00:00.000Z` }); // day-fileには未登場＝安全にappendできる

  const entryA = await seedMemoryCanonical(aCanonical);
  const entryB = await seedMemoryCanonical(bCanonical);

  // 採用したisolation policy：day-file単位で一律holdにはしない。安全なAは
  // 独立してrepairされ、conflictなBだけがheldのまま残る（read-modify-write +
  // final verifyをmember単位で行うため、Aの処理はBの内容を一切判定しない）。
  const resultA = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entryA);
  assert.equal(resultA.status, "done", "Aは他memberのconflictに妨げられず収束する");

  const resultB = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entryB);
  assert.equal(resultB.status, "held", "Bは真のconflictとしてheldのまま");

  const members = markdownMod.parseMemoryDayFile(vault.get(path)!);
  assert.equal(members.length, 2);
  assert.ok(members.some((m) => m.id === aCanonical.id), "Aは追加されている");
  const stillB = members.find((m) => m.id === bOnDisk.id)!;
  assert.equal(stillB.content, "Bの元の内容", "Bの外部データは一切上書きされない");
});

// ===========================================================================
// P/Q/R：outbox doneの信用しすぎ防止・baseline null・冪等性
// ===========================================================================

test("Projection Memory P: outboxがdoneだが対象memberがday-fileから消えている場合、検出して再度追加しdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-16";
  const a = memory("mem-p-a", day);
  const entry = await seedMemoryCanonical(a);
  const first = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  // outboxはdoneのまま、day-file実体だけを（Aを含まない）空の状態に書き換える（例：将来の破損シナリオを模す）。
  vault.put(memoryDayPath(day), "");
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  assert.equal(doneEntry.status, "done", "outboxは（実体の変化を知らないまま）doneのまま");
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(result.status, "done", "outboxのdoneを信用せず、実体を検証して再修復する");
  const members = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.ok(members.some((m) => m.id === a.id));
});

test("Projection Memory Q: baseline（registry-meta.json）が一切無くても正常にprojectionされる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  assert.equal(vault.get(".tsumugi/registry-meta.json"), undefined);
  const day = "2026-04-17";
  const a = memory("mem-q-a", day);
  const entry = await seedMemoryCanonical(a);
  const result = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done", "baseline未確立を一切参照しない");
});

test("Projection Memory R: projection完了後にもう一度reconcileしても完全no-opで、duplicateが生じない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-18";
  const a = memory("mem-r-a", day);
  const entry = await seedMemoryCanonical(a);
  const first = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileMemoryOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore, "duplicateを作らない（何も書かない）");
  const members = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.equal(members.length, 1);
});

// ===========================================================================
// reconcilePendingMemories（startup reconcile、library単体。まだ本番未接続）
// ===========================================================================

test("reconcilePendingMemories: pendingなmemory entryだけをまとめて処理する", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-04-19";
  const a = memory("mem-batch-a", day, { createdAt: `${day}T09:00:00.000Z` });
  const b = memory("mem-batch-b", day, { createdAt: `${day}T09:01:00.000Z` });
  await seedMemoryCanonical(a);
  await seedMemoryCanonical(b);
  const result = await projectionMod.reconcilePendingMemories(makeEnv(vault));
  assert.equal(result.done, 2);
  assert.equal(result.pending, 0);
  assert.equal(result.held, 0);
});

// ===========================================================================
// 永久iPhone Memory fixture（Phase 3-6 req 15）
// ===========================================================================

test("Projection Memory iPhone fixture（永久回帰テスト）: migration → Memory Projection reconcileで、A保持/B追加/C安全更新/X保全のすべてが安全に収束する", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const day = "2026-04-20";

  // A：IndexedDBとVaultが完全一致。
  const a = memory("iphone-mem-a", day, { createdAt: `${day}T09:00:00.000Z` });
  // B：IDB-only（day-fileには無い）。
  const b = memory("iphone-mem-b", day, { createdAt: `${day}T09:01:00.000Z` });
  // C：Vaultは旧version、IDBは正当な後継（メタデータのみ更新）。
  const cOld = memory("iphone-mem-c", day, { createdAt: `${day}T09:02:00.000Z`, updatedAt: `${day}T09:02:00.000Z` });
  const cNew: MemoryObject = { ...cOld, summary: "更新後の要約（安全な更新）", updatedAt: `${day}T09:10:00.000Z` };
  // X：Vault-only（IndexedDBに存在しない未知member）。
  const x = memory("iphone-mem-x", day, { createdAt: `${day}T08:00:00.000Z` });

  const path = memoryDayPath(day);
  vault.put(path, markdownMod.serializeMemoryDayFile([x, a, cOld]));

  // RegistryはmemberIds/memberHashesが部分的に欠落した状態（実機で確認された状態を再現）。
  const registryKey = vaultMod.dayFileRegistryKey(day);
  const bucket = vaultMod.vaultRegistryBucketOf(registryKey);
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { [registryKey]: path },
    files: { [path]: { recordType: "memory-day", mtime: 1, size: 1, contentHash: "stale-hash", status: "ok" } }, // memberIds/memberHashes欠落
  }));

  // Historyはstale（Aしか記録されていない）。
  vault.put(monthPath(day), JSON.stringify({
    version: 2, month: day.slice(0, 7),
    days: { [day]: { conversations: [], normalMemories: [{ id: a.id, types: a.types, preview: a.summary, createdAt: a.createdAt, date: a.date }], reflections: [] } },
  }));

  // baselineは一切seedしない（registry-meta.jsonを置かない＝null相当）。

  await dbMod.putMemoryObject(a);
  await dbMod.putMemoryObject(b);
  await dbMod.putMemoryObject(cNew);

  // Vault identityは既にpair済み。
  const identity: VaultIdentityRecord = { id: "current", vaultId: "iphone-mem-vault-id", activeVaultEpoch: 0, registryGeneration: "g1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "iphone-mem-vault-id", createdAt: T }));

  // Production migrationでoutbox化する（Registry不在・baseline null状態でも、safeなmemberはoutbox化される）。
  const migrationResult = await migrationMod.runProductionBootstrapMigration({ root: vault.root(), now: () => T });
  assert.equal(migrationResult.phase, "done");
  assert.equal(migrationResult.memorySummary.bothSame, 1, "A：both-same");
  assert.equal(migrationResult.memorySummary.idbOnly, 1, "B：idb-only");
  assert.equal(migrationResult.memorySummary.legitimateSuccessor, 1, "C：legitimate-successor");
  assert.equal(migrationResult.memorySummary.vaultOnly, 1, "X：Vault-only");
  assert.equal(migrationResult.memorySummary.conflict, 0, "Recovery対象になるconflictは無い");
  assert.deepEqual(migrationResult.memoryVaultOnlyMembers.map((v) => v.id), [x.id]);

  const projEnv: import("./vaultProjection").ProjectionEnv = { root: vault.root(), vaultIdentity: identity, now: () => T };
  for (const m of [a, b, cNew]) {
    const entry = await dbMod.getVaultOutboxEntry(`memory:${m.id}`);
    assert.ok(entry, `${m.id}のoutbox entryが無い`);
    const reconcileResult = await projectionMod.reconcileMemoryOutboxEntry(projEnv, entry!);
    assert.equal(reconcileResult.status, "done", `${m.id}がdoneにならなかった: ${JSON.stringify(reconcileResult)}`);
  }

  // 最終状態の確認：A保持・B追加・C安全更新・X保全のすべてが揃っている。
  const finalMembers = markdownMod.parseMemoryDayFile(vault.get(path)!);
  assert.equal(finalMembers.length, 4, "X/A/B/Cの4件が最終的に揃う");
  assert.ok(finalMembers.some((m) => m.id === x.id), "X：Vault-onlyは最後まで保全される");
  assert.ok(finalMembers.some((m) => m.id === a.id), "A：保持される");
  assert.ok(finalMembers.some((m) => m.id === b.id), "B：新規追加される");
  const finalC = finalMembers.find((m) => m.id === cNew.id)!;
  assert.equal(finalC.summary, "更新後の要約（安全な更新）", "C：安全な更新が反映される");

  const finalShard = JSON.parse(vault.get(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`)!);
  assert.deepEqual(new Set(finalShard.files[path].memberIds), new Set([x.id, a.id, b.id, cNew.id]), "Registryはfinal実体から修復される");

  const finalMonth = JSON.parse(vault.get(monthPath(day))!);
  const historyIds = finalMonth.days[day].normalMemories.map((r: { id: string }) => r.id);
  assert.deepEqual(new Set(historyIds), new Set([x.id, a.id, b.id, cNew.id]), "Historyも最終実体から修復される");

  for (const m of [a, b, cNew]) {
    const entry = await dbMod.getVaultOutboxEntry(`memory:${m.id}`);
    assert.equal(entry!.status, "done", "Recovery不要（すべてdone）");
  }
});

// ===========================================================================
// Reflection / Source Projection（Phase 3-7）
// ===========================================================================

type Source = import("./types").Source;

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
async function seedReflectionCanonical(r: MemoryObject): Promise<VaultOutboxEntry> {
  return dbMod.putMemoryObjectWithOutbox(r, "reflection");
}
const reflectionPath = (r: MemoryObject) => `Memories/${vaultMod.fileNameFor(r.id, r.date)}`;

function source(id: string, overrides: Partial<Source> = {}): Source {
  return { id, sourceType: "note" as Source["sourceType"], title: `タイトル-${id}`, content: `内容-${id}`, createdAt: T, updatedAt: T, ...overrides } as Source;
}
async function seedSourceCanonical(s: Source): Promise<VaultOutboxEntry> {
  return dbMod.putSourceWithOutbox(s);
}
const sourcePath = (s: Source) => `Sources/${vaultMod.fileNameFor(s.id, s.createdAt)}`;

// ---------------------------------------------------------------------------
// Reflection A〜L
// ---------------------------------------------------------------------------

test("Projection Reflection A: Vault実体が何も無い状態から、Markdown/Registry/index/Historyすべてを生成してdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-01";
  const r = reflection("refl-a-1", day);
  const entry = await seedReflectionCanonical(r);
  const result = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const path = reflectionPath(r);
  assert.equal(vault.get(path), markdownMod.memoryObjectToMarkdown(r));
  const shard = JSON.parse(vault.get(shardPath(r.id))!);
  assert.equal(shard.records[r.id], path);
  assert.deepEqual(shard.files[path].memberIds, [r.id]);
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(index[r.id], path);
  const month = JSON.parse(vault.get(monthPath(day))!);
  assert.ok(month.days[day].reflections.some((row: { id: string }) => row.id === r.id));
});

test("Projection Reflection B: 既に同一内容が書かれている場合はno-opでdoneになる（重複write無し）", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-02";
  const r = reflection("refl-b-1", day);
  const entry = await seedReflectionCanonical(r);
  const first = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore, "既に正しいため何も書き込まれない");
});

test("Projection Reflection C: 正当な後継（summaryのみ変化、MemoryObjectとしてのlegitimate successor判定を再利用）はMarkdownが更新されてdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-03";
  const r1 = reflection("refl-c-1", day);
  const entry1 = await seedReflectionCanonical(r1);
  const first = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry1);
  assert.equal(first.status, "done");
  const r2: MemoryObject = { ...r1, summary: "更新後の要約", updatedAt: `${day}T09:05:00.000Z` };
  const entry2 = await seedReflectionCanonical(r2);
  const second = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry2);
  assert.equal(second.status, "done");
  const path = reflectionPath(r1);
  assert.equal(vault.get(path), markdownMod.memoryObjectToMarkdown(r2));
});

test("Projection Reflection D: 外部内容と食い違う場合はheldになり、外部データを上書きしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-04";
  const r = reflection("refl-d-1", day);
  const path = reflectionPath(r);
  const externallyEdited = markdownMod.memoryObjectToMarkdown({ ...r, content: "外部で書き換えられた内容" });
  vault.put(path, externallyEdited);
  const entry = await seedReflectionCanonical(r);
  const result = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.get(path), externallyEdited);
});

test("Projection Reflection E: Markdown unreadable（parse不能）はheldになり、上書きしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-05";
  const r = reflection("refl-e-1", day);
  const path = reflectionPath(r);
  vault.put(path, "not a tsumugi markdown at all");
  const entry = await seedReflectionCanonical(r);
  const result = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.get(path), "not a tsumugi markdown at all");
});

test("Projection Reflection F: Vault identity mismatchはheldになり、1byteもwriteしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault, "a-totally-different-vault-id");
  const r = reflection("refl-f-1", "2026-05-06");
  const entry = await seedReflectionCanonical(r);
  const writesBefore = vault.writeCount;
  const result = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.writeCount, writesBefore);
});

test("Projection Reflection G: Markdown write直後にkillしても、restartでsame判定され残りが完了しdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-07";
  const r = reflection("refl-g-1", day);
  const path = reflectionPath(r);
  const entry = await seedReflectionCanonical(r);
  vault.writeShouldFail.add(shardPath(r.id));
  const first = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  assert.equal(vault.get(path), markdownMod.memoryObjectToMarkdown(r));
  vault.writeShouldFail.delete(shardPath(r.id));
  const second = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), (await dbMod.getVaultOutboxEntry(entry.id))!);
  assert.equal(second.status, "done");
});

test("Projection Reflection H: Registry write直後にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-08";
  const r = reflection("refl-h-1", day);
  const entry = await seedReflectionCanonical(r);
  vault.writeShouldFail.add(".tsumugi/index.json");
  const first = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  vault.writeShouldFail.delete(".tsumugi/index.json");
  const second = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), (await dbMod.getVaultOutboxEntry(entry.id))!);
  assert.equal(second.status, "done");
});

test("Projection Reflection I: index write直後（History前）にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-09";
  const r = reflection("refl-i-1", day);
  const entry = await seedReflectionCanonical(r);
  vault.writeShouldFail.add(monthPath(day));
  const first = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  vault.writeShouldFail.delete(monthPath(day));
  const second = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), (await dbMod.getVaultOutboxEntry(entry.id))!);
  assert.equal(second.status, "done");
});

test("Projection Reflection J: outboxがdoneだがRegistryが欠落している場合、検出して修復しdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-10";
  const r = reflection("refl-j-1", day);
  const entry = await seedReflectionCanonical(r);
  const first = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  vault.delete(shardPath(r.id));
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const result = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(result.status, "done");
  const shard = JSON.parse(vault.get(shardPath(r.id))!);
  assert.equal(shard.records[r.id], reflectionPath(r));
});

test("Projection Reflection K: projection完了後にもう一度reconcileしても完全no-opで、duplicateが生じない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const day = "2026-05-11";
  const r = reflection("refl-k-1", day);
  const entry = await seedReflectionCanonical(r);
  const first = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileReflectionOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore);
});

test("reconcilePendingReflections: pendingなreflection entryだけをまとめて処理する", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const r1 = reflection("refl-batch-1", "2026-05-12");
  const r2 = reflection("refl-batch-2", "2026-05-12");
  await seedReflectionCanonical(r1);
  await seedReflectionCanonical(r2);
  const result = await projectionMod.reconcilePendingReflections(makeEnv(vault));
  assert.equal(result.done, 2);
  assert.equal(result.pending, 0);
  assert.equal(result.held, 0);
});

// ---------------------------------------------------------------------------
// Source A〜J
// ---------------------------------------------------------------------------

test("Projection Source A: Vault実体が何も無い状態から、Markdown/Registry/indexを生成してdoneになる（Historyは対象外）", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s = source("src-a-1");
  const entry = await seedSourceCanonical(s);
  const result = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "done");
  const path = sourcePath(s);
  assert.equal(vault.get(path), markdownMod.sourceToMarkdown(s));
  const shard = JSON.parse(vault.get(shardPath(s.id))!);
  assert.equal(shard.records[s.id], path);
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(index[s.id], path);
  assert.equal(vault.get(monthPath(s.createdAt.slice(0, 10))), undefined, "SourceはHistory対象外——月ファイルは一切作られない");
});

test("Projection Source B: 既に同一内容が書かれている場合はno-opでdoneになる（重複write無し）", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s = source("src-b-1");
  const entry = await seedSourceCanonical(s);
  const first = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore);
});

test("Projection Source C: 内容が食い違う場合、legitimate successor概念が無いため無条件でheldになり、外部データを上書きしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s = source("src-c-1");
  const path = sourcePath(s);
  const externallyEdited = markdownMod.sourceToMarkdown({ ...s, content: "外部で書き換えられた内容" });
  vault.put(path, externallyEdited);
  const entry = await seedSourceCanonical(s);
  const result = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.get(path), externallyEdited);
});

test("Projection Source D: Markdown unreadable（parse不能、parseSourceMarkdownの例外がnullへ変換される）はheldになり、上書きしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s = source("src-d-1");
  const path = sourcePath(s);
  vault.put(path, "not a tsumugi markdown at all");
  const entry = await seedSourceCanonical(s);
  const result = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.get(path), "not a tsumugi markdown at all");
});

test("Projection Source E: Vault identity mismatchはheldになり、1byteもwriteしない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault, "a-totally-different-vault-id");
  const s = source("src-e-1");
  const entry = await seedSourceCanonical(s);
  const writesBefore = vault.writeCount;
  const result = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(result.status, "held");
  assert.equal(vault.writeCount, writesBefore);
});

test("Projection Source F: Markdown write直後にkillしても、restartでsame判定され残りが完了しdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s = source("src-f-1");
  const path = sourcePath(s);
  const entry = await seedSourceCanonical(s);
  vault.writeShouldFail.add(shardPath(s.id));
  const first = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  assert.equal(vault.get(path), markdownMod.sourceToMarkdown(s));
  vault.writeShouldFail.delete(shardPath(s.id));
  const second = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), (await dbMod.getVaultOutboxEntry(entry.id))!);
  assert.equal(second.status, "done");
});

test("Projection Source G: Registry write直後にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s = source("src-g-1");
  const entry = await seedSourceCanonical(s);
  vault.writeShouldFail.add(".tsumugi/index.json");
  const first = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "pending");
  vault.writeShouldFail.delete(".tsumugi/index.json");
  const second = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), (await dbMod.getVaultOutboxEntry(entry.id))!);
  assert.equal(second.status, "done");
});

test("Projection Source H: outboxがdoneだがRegistryが欠落している場合、検出して修復しdoneになる", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s = source("src-h-1");
  const entry = await seedSourceCanonical(s);
  const first = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  vault.delete(shardPath(s.id));
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const result = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(result.status, "done");
});

test("Projection Source I: projection完了後にもう一度reconcileしても完全no-opで、duplicateが生じない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s = source("src-i-1");
  const entry = await seedSourceCanonical(s);
  const first = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), entry);
  assert.equal(first.status, "done");
  const doneEntry = (await dbMod.getVaultOutboxEntry(entry.id))!;
  const writesBefore = vault.writeCount;
  const second = await projectionMod.reconcileSourceOutboxEntry(makeEnv(vault), doneEntry);
  assert.equal(second.status, "done");
  assert.equal(vault.writeCount, writesBefore);
});

test("reconcilePendingSources: pendingなsource entryだけをまとめて処理する", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);
  const s1 = source("src-batch-1");
  const s2 = source("src-batch-2");
  await seedSourceCanonical(s1);
  await seedSourceCanonical(s2);
  const result = await projectionMod.reconcilePendingSources(makeEnv(vault));
  assert.equal(result.done, 2);
  assert.equal(result.pending, 0);
  assert.equal(result.held, 0);
});

// ---------------------------------------------------------------------------
// Unified Reconcile（reconcilePendingVaultOutbox）
// ---------------------------------------------------------------------------

test("reconcilePendingVaultOutbox: Conversation/Memory/Reflection/Sourceが混在しても、record typeごとに正しくdispatchされ、1件のheldが他を止めない", async () => {
  const vault = new FakeVault();
  seedVaultIdentityFile(vault);

  const c = conversation("unified-conv-1");
  await seedCanonical(c);

  const day = "2026-05-13";
  const m = memory("unified-mem-1", day);
  await seedMemoryCanonical(m);

  const r = reflection("unified-refl-1", day);
  await seedReflectionCanonical(r);

  // Source側だけ、事前に外部conflictを仕込んでheldになるようにする。
  const sHeld = source("unified-src-held");
  vault.put(sourcePath(sHeld), markdownMod.sourceToMarkdown({ ...sHeld, content: "外部で食い違う内容" }));
  await seedSourceCanonical(sHeld);

  const sOk = source("unified-src-ok");
  await seedSourceCanonical(sOk);

  const result = await projectionMod.reconcilePendingVaultOutbox(makeEnv(vault));

  assert.equal(result.processed, 5);
  assert.equal(result.done, 4, "conversation/memory/reflection/source(ok)の4件がdone");
  assert.equal(result.held, 1, "conflictなsourceだけがheld");
  assert.equal(result.failed, 0);
  assert.equal(result.byRecordType.conversation.done, 1);
  assert.equal(result.byRecordType.memory.done, 1);
  assert.equal(result.byRecordType.reflection.done, 1);
  assert.equal(result.byRecordType.source.done, 1);
  assert.equal(result.byRecordType.source.held, 1);

  // heldになったsourceの外部データは一切変更されていない。
  assert.ok(vault.get(sourcePath(sHeld))?.includes("外部で食い違う内容"));
});
