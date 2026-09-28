/**
 * Vault Projection Engine（Phase 3-3、Conversationのみ）の回帰テスト。
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
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as {
  __failNextPutOn: (dbName: string, storeName: string) => void;
  __failNextPlainPutOn: (dbName: string, storeName: string) => void;
};

type Conversation = import("./types").Conversation;
type VaultOutboxEntry = import("./vaultOutbox").VaultOutboxEntry;
type VaultIdentityRecord = import("./vaultIdentity").VaultIdentityRecord;

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

  root(): FileSystemDirectoryHandle {
    return this.dir("");
  }

  private dir(prefix: string): FileSystemDirectoryHandle {
    const self = this;
    return {
      kind: "directory",
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
    } as unknown as FileSystemDirectoryHandle;
  }

  private file(p: string): FileSystemFileHandle {
    const self = this;
    return {
      kind: "file",
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
