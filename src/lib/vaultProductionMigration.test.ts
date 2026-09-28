/**
 * Production Bootstrap / Legacy Migration（Phase 3-5）の回帰テスト。
 *
 * 実IndexedDBは使わない（`fakeIdb.ts`をModule._loadで`require("idb")`へ差し替える）。
 * 実Vaultも使わず、in-memoryの疑似FileSystemDirectoryHandle（`FakeVault`）を使う。
 * `collectAllMarkdownFiles`（vault.ts）がディレクトリを再帰的に`entries()`で列挙するため、
 * このFakeVaultは`entries()`を実装する（`vaultRecoveryApply.test.ts`のFakeVaultと同じ形）。
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
const migrationMod = require(path.join(OUT, "lib/vaultProductionMigration.js")) as typeof import("./vaultProductionMigration");
const projectionMod = require(path.join(OUT, "lib/vaultProjection.js")) as typeof import("./vaultProjection");
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as {
  __failNextPutOn: (dbName: string, storeName: string) => void;
  __failOnNthPlainPut: (dbName: string, storeName: string, n: number) => void;
};

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type VaultIdentityRecord = import("./vaultIdentity").VaultIdentityRecord;

// ---------------------------------------------------------------------------
// in-memory疑似ファイルシステム（`entries()`対応版）
// ---------------------------------------------------------------------------

class FakeFile {
  constructor(public content: string, public mtime: number) {}
}

class FakeVault {
  files = new Map<string, FakeFile>();
  private clock = 1;
  writeCount = 0;
  /** テスト専用：`Conversations/`ディレクトリの`entries()`が最初に呼ばれた瞬間だけ発火する副作用（req H：migration中の新規record追加を模す）。 */
  onConversationsListedOnce: (() => Promise<void>) | null = null;

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
      async *entries() {
        if (prefix === "Conversations" && self.onConversationsListedOnce) {
          const fn = self.onConversationsListedOnce;
          self.onConversationsListedOnce = null;
          await fn();
        }
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
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const T = "2026-05-01T09:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id, persona: "companion", status: "active", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: [{ role: "user", content: "ユーザー発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...meta }, ...overrides,
  } as Conversation;
}

function makeEnv(vault: FakeVault): import("./vaultProductionMigration").ProductionMigrationEnv {
  return { root: vault.root(), now: () => T };
}

async function seedIdbConversation(c: Conversation) {
  await dbMod.putConversation(c);
}

// Phase 3-6：Memory拡張のfixture。
// `sourceType`を明示しておく（"chat"＝`inferSourceType("ai-capture")`と同じ値）。
// 明示しないと、Markdown化→parse往復で`parseMemoryObjectMarkdown`が
// `inferSourceType`によって`sourceType`を補完してしまい、canonical（元のオブジェクト、
// sourceType未設定）とonDisk（parse後、sourceType="chat"が補完済み）の再シリアライズ
// テキストが完全一致しなくなる（回帰：意図しない`unreadable`/`conflict`誤判定）。
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
async function seedIdbMemory(m: MemoryObject) {
  await dbMod.putMemoryObject(m);
}
const memoryDayPath = (day: string) => `Memories/${vaultMod.dayFileNameFor(day)}`;

async function clearAllIndexedDbState() {
  // 各テストがまっさらな状態から始められるよう、conversations/vaultOutbox/settings
  // （migration state）を明示的にクリアする（db.ts接続はテストファイル全体で共有される）。
  for (const c of await dbMod.getAllConversations()) {
    // 直接deleteするAPIが無いため、テストでは新しいidを使うことで衝突を避ける方針にする
    // （下のtestは全て固有prefixのidを使う）。
    void c;
  }
}
void clearAllIndexedDbState;

// ===========================================================================
// A〜E：migration自体の中断・再開（migrationJournalのphaseごとに1回だけ失敗させる）
// ===========================================================================

test("Migration A: inventory直後（classify phaseの記録前）にkillしても、restartで完全にresumeしてdoneになる", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-a-1");
  await seedIdbConversation(c);
  fakeIdbMod.__failOnNthPlainPut("tsumugi", "settings", 2); // 1回目=inventory persist成功、2回目=classify persistで失敗
  await assert.rejects(migrationMod.runProductionBootstrapMigration(makeEnv(vault)));
  const stateAfterFailure = await migrationMod.readProductionMigrationState();
  assert.equal(stateAfterFailure!.phase, "inventory");
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.equal(result.summary.idbOnly, 1);
  const outbox = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
  assert.ok(outbox);
});

test("Migration B: classify完了直後（enqueue phaseの記録前）にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-b-1");
  await seedIdbConversation(c);
  fakeIdbMod.__failOnNthPlainPut("tsumugi", "settings", 3); // 3回目=enqueue-safe-records persistで失敗
  await assert.rejects(migrationMod.runProductionBootstrapMigration(makeEnv(vault)));
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.ok(await dbMod.getVaultOutboxEntry(`conversation:${c.id}`));
});

test("Migration C: enqueue途中（一部recordのoutbox登録）でkillしても、restartで残りが完了しdoneになる", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c1 = conversation("mig-c-1");
  const c2 = conversation("mig-c-2");
  await seedIdbConversation(c1);
  await seedIdbConversation(c2);
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox"); // どちらか1件のoutbox transactionを失敗させる
  await assert.rejects(migrationMod.runProductionBootstrapMigration(makeEnv(vault)));
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.ok(await dbMod.getVaultOutboxEntry(`conversation:${c1.id}`));
  assert.ok(await dbMod.getVaultOutboxEntry(`conversation:${c2.id}`));
});

test("Migration D: enqueue完了・verify phase記録前にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-d-1");
  await seedIdbConversation(c);
  fakeIdbMod.__failOnNthPlainPut("tsumugi", "settings", 4); // 4回目=verify persistで失敗
  await assert.rejects(migrationMod.runProductionBootstrapMigration(makeEnv(vault)));
  const outboxBeforeRetry = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
  assert.ok(outboxBeforeRetry, "enqueue自体は既に完了している");
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
});

test("Migration E: migrationJournalをdoneとして記録する直前にkillしても、restartでdoneになる", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-e-1");
  await seedIdbConversation(c);
  fakeIdbMod.__failOnNthPlainPut("tsumugi", "settings", 5); // 5回目=done persistで失敗
  await assert.rejects(migrationMod.runProductionBootstrapMigration(makeEnv(vault)));
  const stateAfterFailure = await migrationMod.readProductionMigrationState();
  assert.equal(stateAfterFailure!.phase, "verify", "verifyまでは記録済み、doneだけが未確定");
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
});

// ===========================================================================
// G：2回実行してもduplicateを作らない
// ===========================================================================

test("Migration G: migrationを2回実行しても、outboxがduplicateしない", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-g-1");
  await seedIdbConversation(c);
  const first = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  const firstOutbox = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
  const second = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  const secondOutbox = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
  assert.equal(first.summary.idbOnly, 1);
  assert.equal(second.summary.idbOnly, 1);
  assert.deepEqual(secondOutbox, { ...firstOutbox, updatedAt: secondOutbox!.updatedAt }, "同一recordのoutbox entryは1件のまま、進捗も巻き戻らない（updatedAtのみ更新される）");
});

// ===========================================================================
// H：migration中に新しいcanonical recordが追加される（req 11のrescanを直接検証）
// ===========================================================================

test("Migration H: migration実行中に新しいConversationが追加されても、同じ呼び出し内のrescanで拾われる", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const existing = conversation("mig-h-existing");
  await seedIdbConversation(existing);
  const path = `Conversations/${vaultMod.fileNameFor(existing.id, existing.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown(existing));

  const addedDuringMigration = conversation("mig-h-new");
  vault.onConversationsListedOnce = async () => {
    await seedIdbConversation(addedDuringMigration);
  };

  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.ok(await dbMod.getVaultOutboxEntry(`conversation:${addedDuringMigration.id}`), "migration中に増えたrecordも、rescanで取りこぼされずoutbox化される");
});

// ===========================================================================
// I/J：既存outboxとの統合（req 12）
// ===========================================================================

test("Migration I: 既にpendingなoutbox entryがある場合、migrationはそれを壊さない", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-i-1");
  await seedIdbConversation(c);
  const existingEntry = await dbMod.putConversationWithOutbox(c);
  await dbMod.putVaultOutboxEntry({ ...existingEntry, steps: { ...existingEntry.steps, markdown: "done" } });
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  const after = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
  assert.equal(after!.steps.markdown, "done", "既存の進捗は維持される（無条件初期化しない）");
});

test("Migration J: 既にheldなoutbox entryがある場合、migrationは勝手にpendingへ戻さない", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-j-1");
  await seedIdbConversation(c);
  const existingEntry = await dbMod.putConversationWithOutbox(c);
  await dbMod.putVaultOutboxEntry({ ...existingEntry, status: "held", heldReason: "previously-detected-conflict" });
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  const after = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
  assert.equal(after!.status, "held", "held状態を勝手にpendingへ戻さない");
  assert.equal(after!.heldReason, "previously-detected-conflict");
});

// ===========================================================================
// K/L：conflict・Vault-onlyとsafe recordの混在
// ===========================================================================

test("Migration K: conflictなrecordと安全なrecordが混在しても、安全な方はoutbox化され、conflictはそのまま保留される", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const safe = conversation("mig-k-safe");
  const conflicted = conversation("mig-k-conflict");
  await seedIdbConversation(safe);
  await seedIdbConversation(conflicted);
  const conflictPath = `Conversations/${vaultMod.fileNameFor(conflicted.id, conflicted.startedAt)}`;
  vault.put(conflictPath, markdownMod.conversationToMarkdown({ ...conflicted, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] }));

  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.deepEqual(result.conflictRecordIds, [conflicted.id]);
  assert.ok(await dbMod.getVaultOutboxEntry(`conversation:${safe.id}`), "safe recordのmigrationは、conflict recordの存在に妨げられない");
  assert.equal(await dbMod.getVaultOutboxEntry(`conversation:${conflicted.id}`), undefined, "conflict recordのoutboxは作らない");
  assert.equal(vault.get(conflictPath)?.includes("食い違う内容"), true, "Vault側のconflictしたMarkdownは変更されない");
});

test("Migration L: Vault-onlyな記録と安全なrecordが混在しても、safe recordのmigrationは通り、Vault-onlyは保全・報告される", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const safe = conversation("mig-l-safe");
  await seedIdbConversation(safe);
  const vaultOnlyPath = "Conversations/vault-only-record.md";
  const vaultOnlyContent = markdownMod.conversationToMarkdown(conversation("mig-l-vault-only-id"));
  vault.put(vaultOnlyPath, vaultOnlyContent);

  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.deepEqual(result.vaultOnlyPaths, [vaultOnlyPath]);
  assert.ok(await dbMod.getVaultOutboxEntry(`conversation:${safe.id}`));
  assert.equal(vault.get(vaultOnlyPath), vaultOnlyContent, "Vault-onlyの内容はそのまま");
});

// ===========================================================================
// M/N：baseline・derived metadata欠落
// ===========================================================================

test("Migration M: registry-meta.json（baseline）が一切無くてもmigrationは正常に完了する", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-m-1");
  await seedIdbConversation(c);
  assert.equal(vault.get(".tsumugi/registry-meta.json"), undefined);
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.ok(await dbMod.getVaultOutboxEntry(`conversation:${c.id}`));
});

test("Migration N: MarkdownはcanonicalとOKだがRegistry/History/indexが無い場合も、classifyはboth-sameとしてoutbox化される（repairはProjection Engineへ）", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const c = conversation("mig-n-1");
  await seedIdbConversation(c);
  const p = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.put(p, markdownMod.conversationToMarkdown(c));
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.equal(result.summary.bothSame, 1);
  assert.ok(await dbMod.getVaultOutboxEntry(`conversation:${c.id}`), "Registry/History欠落だけでoutbox化を諦めない");
});

// ===========================================================================
// O：今回のiPhone事故のend-to-end fixture（永久regression test）
// ===========================================================================

test("Migration O（今回のiPhone事故のend-to-endの永久回帰テスト）: migration → Projection reconcileで、A/B/Cすべてが安全に収束する", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();

  // A：Vaultと完全一致。
  const a = conversation("mig-o-a");
  const aPath = `Conversations/${vaultMod.fileNameFor(a.id, a.startedAt)}`;
  vault.put(aPath, markdownMod.conversationToMarkdown(a));
  const aDay = a.startedAt.slice(0, 10);
  vault.put(`.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(a.id).toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket: vaultMod.vaultRegistryBucketOf(a.id), records: { [a.id]: aPath },
    files: { [aPath]: { recordType: "conversation", mtime: vault.get(aPath) ? 1 : 1, size: markdownMod.conversationToMarkdown(a).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(a)), memberIds: [a.id], status: "ok" } },
  }));
  vault.put(".tsumugi/index.json", JSON.stringify({ [a.id]: aPath }));

  // B：IDB-only（VaultにMarkdownが無い）。
  const b = conversation("mig-o-b");

  // C：Vaultは旧version（User A + Assistant A）、IDBは正当な後継（+ User B）。
  const cOld = conversation("mig-o-c", { turns: [{ role: "user", content: "最初の発言", timestamp: T }, { role: "ai", content: "最初の返信", timestamp: "2026-05-01T09:00:01.000Z" }] });
  const cNew: Conversation = { ...cOld, turns: [...cOld.turns, { role: "user", content: "追加の発言", timestamp: "2026-05-01T09:00:02.000Z" }], updatedAt: "2026-05-01T09:00:02.000Z" };
  const cPath = `Conversations/${vaultMod.fileNameFor(cOld.id, cOld.startedAt)}`;
  vault.put(cPath, markdownMod.conversationToMarkdown(cOld));
  const cDay = cOld.startedAt.slice(0, 10);

  // A・Cは同じ日（同じ月ファイル）のため、実際のVaultと同じく1つの月ファイルへ
  // 両方の行をまとめて置く（Aの行を消さない）。
  assert.equal(aDay, cDay, "このfixtureはA/Cが同じ日である前提");
  vault.put(`.tsumugi/history/${aDay.slice(0, 7)}.json`, JSON.stringify({
    version: 2,
    month: aDay.slice(0, 7),
    days: {
      [aDay]: {
        conversations: [
          { id: a.id, mode: "diary", turnCount: a.turns.length },
          { id: cOld.id, mode: "diary", turnCount: cOld.turns.length },
        ],
        normalMemories: [],
        reflections: [],
      },
    },
  }));

  await seedIdbConversation(a);
  await seedIdbConversation(b);
  await seedIdbConversation(cNew);

  // Registryは一切seedしない。baselineも一切seedしない（今回の事故の中心条件）。
  const migrationResult = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));

  assert.equal(migrationResult.phase, "done");
  assert.equal(migrationResult.summary.bothSame, 1, "A：both-same");
  assert.equal(migrationResult.summary.idbOnly, 1, "B：idb-only");
  assert.equal(migrationResult.summary.legitimateSuccessor, 1, "C：legitimate-successor");
  assert.equal(migrationResult.conflictRecordIds.length, 0, "Recovery対象になるconflictは無い");
  assert.equal(migrationResult.unreadableRecordIds.length, 0);

  // それぞれのoutbox entryをProjection Engineで実際にreconcileする。
  const identity: VaultIdentityRecord = { id: "current", vaultId: "fixture-vault-id", activeVaultEpoch: 0, registryGeneration: "g1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "fixture-vault-id", createdAt: T }));
  const projEnv: import("./vaultProjection").ProjectionEnv = { root: vault.root(), vaultIdentity: identity, now: () => T };

  for (const id of [a.id, b.id, cNew.id]) {
    const entry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
    assert.ok(entry, `${id}のoutbox entryが無い`);
    const reconcileResult = await projectionMod.reconcileConversationOutboxEntry(projEnv, entry!);
    assert.equal(reconcileResult.status, "done", `${id}がdoneにならなかった: ${JSON.stringify(reconcileResult)}`);
  }

  // 最終状態の確認。
  assert.equal(vault.get(aPath), markdownMod.conversationToMarkdown(a));
  const bPath = `Conversations/${vaultMod.fileNameFor(b.id, b.startedAt)}`;
  assert.equal(vault.get(bPath), markdownMod.conversationToMarkdown(b), "B：新規projectionされている");
  assert.equal(vault.get(cPath), markdownMod.conversationToMarkdown(cNew), "C：正当な後継versionへ更新されている");
  const bShard = JSON.parse(vault.get(`.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(b.id).toString(16).padStart(2, "0")}.json`)!);
  assert.equal(bShard.records[b.id], bPath, "B：Registryが生成されている");
  const cShard = JSON.parse(vault.get(`.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(cNew.id).toString(16).padStart(2, "0")}.json`)!);
  assert.equal(cShard.files[cPath].contentHash, vaultMod.hashVaultText(markdownMod.conversationToMarkdown(cNew)), "C：Registryが最新内容で整合している");

  for (const id of [a.id, b.id, cNew.id]) {
    const entry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
    assert.equal(entry!.status, "done");
  }
});

// ===========================================================================
// Phase 3-6：Memory拡張（member単位のclassification・migration）
// ===========================================================================

test("Migration S: normal MemoryのIDB-only／both-same／Vault-only memberが混在していても、safeなmemberだけがoutbox化され、Vault-onlyは保全される", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const day = "2026-05-10";

  // both-same：day-fileに既に同一内容で存在。
  const bothSame = memory("mig-s-both-same", day);
  // idb-only：day-fileには無い。
  const idbOnly = memory("mig-s-idb-only", day, { createdAt: `${day}T09:01:00.000Z` });
  // Vault-only：day-fileにあるがIndexedDBには無いmember（保全対象、絶対に削除しない）。
  const vaultOnly = memory("mig-s-vault-only", day, { createdAt: `${day}T08:00:00.000Z` });

  vault.put(memoryDayPath(day), markdownMod.serializeMemoryDayFile([vaultOnly, bothSame]));
  await seedIdbMemory(bothSame);
  await seedIdbMemory(idbOnly);

  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.equal(result.memorySummary.bothSame, 1, "both-same member");
  assert.equal(result.memorySummary.idbOnly, 1, "idb-only member");
  assert.equal(result.memorySummary.vaultOnly, 1, "Vault-only member");
  assert.equal(result.memorySummary.conflict, 0);
  assert.deepEqual(result.memoryVaultOnlyMembers.map((v) => v.id), [vaultOnly.id]);

  assert.ok(await dbMod.getVaultOutboxEntry(`memory:${bothSame.id}`), "both-same memberはoutbox化される");
  assert.ok(await dbMod.getVaultOutboxEntry(`memory:${idbOnly.id}`), "idb-only memberもoutbox化される");
  assert.equal(await dbMod.getVaultOutboxEntry(`memory:${vaultOnly.id}`), undefined, "Vault-only member自体はIndexedDBに無いためoutboxを作らない");

  // Vault側のday-fileは、migration自体では一切書き換えられない（outboxへの登録のみ）。
  const stillOnDisk = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.ok(stillOnDisk.some((m) => m.id === vaultOnly.id), "Vault-onlyのmemberはmigration中も一切削除されない");

  // 実際にProjection Engineでreconcileすると、Vault-onlyは保持されたまま安全なmemberだけ収束する。
  const identity: VaultIdentityRecord = { id: "current", vaultId: "mig-s-vault-id", activeVaultEpoch: 0, registryGeneration: "g1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "mig-s-vault-id", createdAt: T }));
  const projEnv: import("./vaultProjection").ProjectionEnv = { root: vault.root(), vaultIdentity: identity, now: () => T };
  for (const m of [bothSame, idbOnly]) {
    const entry = await dbMod.getVaultOutboxEntry(`memory:${m.id}`);
    const reconcileResult = await projectionMod.reconcileMemoryOutboxEntry(projEnv, entry!);
    assert.equal(reconcileResult.status, "done", `${m.id}: ${JSON.stringify(reconcileResult)}`);
  }
  const finalMembers = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.equal(finalMembers.length, 3, "vaultOnly + bothSame + idbOnlyの3件が最終的に揃う");
  assert.ok(finalMembers.some((m) => m.id === vaultOnly.id), "Vault-onlyは最後まで保持される");
});

test("Migration T: Memory memberのenqueue途中でkillしても、restartで残りが完了しdoneになる（Vault-onlyは影響を受けない）", async () => {
  const vault = new FakeVault();
  await dbMod.clearMemoryData();
  const day = "2026-05-11";
  const m1 = memory("mig-t-1", day);
  const m2 = memory("mig-t-2", day, { createdAt: `${day}T09:01:00.000Z` });
  const vaultOnly = memory("mig-t-vault-only", day, { createdAt: `${day}T08:00:00.000Z` });
  vault.put(memoryDayPath(day), markdownMod.serializeMemoryDayFile([vaultOnly]));
  await seedIdbMemory(m1);
  await seedIdbMemory(m2);

  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox"); // m1・m2どちらか1件のoutbox transactionを失敗させる
  await assert.rejects(migrationMod.runProductionBootstrapMigration(makeEnv(vault)));
  const result = await migrationMod.runProductionBootstrapMigration(makeEnv(vault));
  assert.equal(result.phase, "done");
  assert.ok(await dbMod.getVaultOutboxEntry(`memory:${m1.id}`));
  assert.ok(await dbMod.getVaultOutboxEntry(`memory:${m2.id}`));
  // Vault-onlyはmigrationの中断・再開を跨いでも一切変更されない。
  const onDisk = markdownMod.parseMemoryDayFile(vault.get(memoryDayPath(day))!);
  assert.deepEqual(onDisk.map((m) => m.id), [vaultOnly.id]);
});
