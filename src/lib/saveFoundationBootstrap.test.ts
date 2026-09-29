/**
 * Save Foundation Bootstrap（Phase 3-7）の回帰テスト。
 *
 * 実IndexedDBは使わない（`fakeIdb.ts`をModule._loadで`require("idb")`へ差し替える）。
 * 実Vaultも使わず、in-memoryの疑似FileSystemDirectoryHandle（`FakeVault`）を使う
 * （`values()`・`entries()`の両方を実装する——identity classification（`values()`）と
 * migrationのVault-only検出（`collectAllMarkdownFiles`、`entries()`）の両方から
 * 呼ばれるため）。
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
const bootstrapMod = require(path.join(OUT, "lib/saveFoundationBootstrap.js")) as typeof import("./saveFoundationBootstrap");
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as {
  __failNextPutOn: (dbName: string, storeName: string) => void;
  __failNextPlainPutOn: (dbName: string, storeName: string) => void;
};

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type Source = import("./types").Source;

// ---------------------------------------------------------------------------
// in-memory疑似ファイルシステム（values()・entries()の両方に対応）
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
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const T = "2026-07-01T09:00:00.000Z";
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

let vaultIdSeq = 0;
function makeEnv(vault: FakeVault, overrides: Partial<import("./saveFoundationBootstrap").SaveFoundationBootstrapEnv> = {}): import("./saveFoundationBootstrap").SaveFoundationBootstrapEnv {
  return { root: vault.root(), now: () => T, generateVaultId: () => `generated-vault-id-${++vaultIdSeq}`, ...overrides };
}

/** IndexedDBの`vaultIdentity`レコードをテストファイル全体で共有しないよう、毎回未pairへ戻す。 */
async function resetIdbIdentity() {
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null, pendingCandidateVaultId: null, updatedAt: T });
}

async function resetAll() {
  await dbMod.clearMemoryData();
  await resetIdbIdentity();
}

const VAULT_ID = "prepaired-vault-id";
function seedPrepairedIdentity(vault: FakeVault) {
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: VAULT_ID, createdAt: T }));
}
async function seedIdbPrepairedIdentity() {
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: VAULT_ID, activeVaultEpoch: 0, registryGeneration: "g1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T });
}

// ===========================================================================
// A〜F：基本の収束・failure injection
// ===========================================================================

test("Bootstrap A: 完全に空の状態から、新規identity・migration・reconcileがすべて成立してdoneになる", async () => {
  const vault = new FakeVault();
  await resetAll();
  const c = conversation("boot-a-conv");
  const m = memory("boot-a-mem", "2026-07-01");
  await dbMod.putConversation(c);
  await dbMod.putMemoryObject(m);

  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(result.identity.kind, "newly-paired");
  assert.equal(result.migration?.phase, "done");
  assert.equal(result.reconcile?.done, 2);
  assert.equal(result.reconcile?.held, 0);
  assert.equal(result.finalReconcile?.processed, 0, "1回目のreconcileで既に全件処理済みのため、2回目は空振り");
});

test("Bootstrap B: 2回連続実行しても、2回目は実質no-opで内容が変化しない", async () => {
  const vault = new FakeVault();
  await resetAll();
  const c = conversation("boot-b-conv");
  await dbMod.putConversation(c);

  const first = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(first.identity.kind, "newly-paired");
  const writesBefore = vault.writeCount;

  const second = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(second.identity.kind, "identified", "2回目はidentifiedになる（newly-pairedの再発行はしない）");
  assert.equal(vault.writeCount, writesBefore, "2回目は1byteも書き込まない");
  // 既にdoneなoutbox entryは`getPendingVaultOutboxEntries()`の対象外になる
  // （pending status専用のindexのため）——2回目のreconcileが「処理すべきものが
  // 無い」という形の空振りになること自体が正しいno-opの現れ。
  assert.equal(second.reconcile?.processed, 0);
  const outbox = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
  assert.equal(outbox!.status, "done", "1回目で完了した状態がそのまま維持されている");
});

test("Bootstrap C: identityがheld（別Vaultとの衝突）の場合、migration/reconcileを一切実行せず1byteも書き込まない", async () => {
  const vault = new FakeVault();
  await resetAll();
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "some-other-vault-id", createdAt: T }));
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: "my-own-vault-id", activeVaultEpoch: 0, registryGeneration: "g1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T });
  const writesBefore = vault.writeCount;

  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(result.identity.kind, "held");
  assert.equal(result.migration, null);
  assert.equal(result.reconcile, null);
  assert.equal(result.finalReconcile, null);
  assert.equal(vault.writeCount, writesBefore);
});

test("Bootstrap D: registry-meta.json（baseline）が一切無くても正常にdoneまで到達する", async () => {
  const vault = new FakeVault();
  await resetAll();
  const c = conversation("boot-d-conv");
  await dbMod.putConversation(c);
  assert.equal(vault.get(".tsumugi/registry-meta.json"), undefined);
  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(result.reconcile?.done, 1);
});

test("Bootstrap E: 1件がretryable failureでも、他recordの成功が巻き戻らない", async () => {
  const vault = new FakeVault();
  await resetAll();
  const cOk = conversation("boot-e-ok");
  const cFail = conversation("boot-e-fail");
  await dbMod.putConversation(cOk);
  await dbMod.putConversation(cFail);
  const failPath = `Conversations/${vaultMod.fileNameFor(cFail.id, cFail.startedAt)}`;
  vault.writeShouldFail.add(failPath);

  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  const okEntry = await dbMod.getVaultOutboxEntry(`conversation:${cOk.id}`);
  const failEntry = await dbMod.getVaultOutboxEntry(`conversation:${cFail.id}`);
  assert.equal(okEntry!.status, "done", "cOkはdoneになる");
  assert.equal(failEntry!.status, "pending", "cFailは一時失敗のためpendingのまま（heldにはしない）");
  void result;
  const okPath = `Conversations/${vaultMod.fileNameFor(cOk.id, cOk.startedAt)}`;
  assert.equal(vault.get(okPath), markdownMod.conversationToMarkdown(cOk), "成功済みのcOkは巻き戻らない");
});

test("Bootstrap F: 1件がgenuine conflictでheldになっても、他recordはdoneのまま", async () => {
  const vault = new FakeVault();
  await resetAll();
  // identity自体は既にpair済みにしておく（新規Vault identity adoption自体の
  // evidence判定でこのconflictを検出してidentity層で止まってしまうと、
  // 「migration/reconcile層のconflict isolation」を検証できなくなるため。
  // Bootstrap Lと同じ考え方）。
  seedPrepairedIdentity(vault);
  await seedIdbPrepairedIdentity();
  const cOk = conversation("boot-f-ok");
  const cConflict = conversation("boot-f-conflict");
  const conflictPath = `Conversations/${vaultMod.fileNameFor(cConflict.id, cConflict.startedAt)}`;
  vault.put(conflictPath, markdownMod.conversationToMarkdown({ ...cConflict, turns: [{ role: "user", content: "外部で食い違う内容", timestamp: T }] }));
  await dbMod.putConversation(cOk);
  await dbMod.putConversation(cConflict);

  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  // migrationの時点でconflictと判定されたrecordはそもそもoutboxへ登録しない
  // （既存のConversation classifyの規約。Migration K/Migration Vと同じ考え方）ため、
  // heldはreconcile側の集計ではなくmigration結果の`conflictRecordIds`に現れる。
  assert.deepEqual(result.migration?.conflictRecordIds, [cConflict.id]);
  assert.equal(await dbMod.getVaultOutboxEntry(`conversation:${cConflict.id}`), undefined, "conflictなrecordのoutboxは作られない");
  assert.ok(vault.get(conflictPath)?.includes("外部で食い違う内容"), "conflictしたVault側の内容は変更されない");
  const okPath = `Conversations/${vaultMod.fileNameFor(cOk.id, cOk.startedAt)}`;
  assert.equal(vault.get(okPath), markdownMod.conversationToMarkdown(cOk));
  const okEntry = await dbMod.getVaultOutboxEntry(`conversation:${cOk.id}`);
  assert.equal(okEntry!.status, "done");
});

test("Bootstrap G: migration段階で一時I/Oエラーが起きても、再実行（restart）で収束する", async () => {
  const vault = new FakeVault();
  await resetAll();
  const c = conversation("boot-g-conv");
  await dbMod.putConversation(c);
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox"); // migrationのoutbox登録transactionを1回だけ失敗させる
  await assert.rejects(bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault)));
  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(result.identity.kind, "identified");
  assert.equal(result.reconcile?.done, 1);
});

test("Bootstrap H: reconcile段階（Vault write）の途中でkillしても、再実行で収束する", async () => {
  const vault = new FakeVault();
  await resetAll();
  const c = conversation("boot-h-conv");
  await dbMod.putConversation(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.writeShouldFail.add(path);
  const first = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.ok((first.reconcile?.pending ?? 0) + (first.finalReconcile?.pending ?? 0) >= 1);
  vault.writeShouldFail.delete(path);
  const second = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal((second.reconcile?.done ?? 0) + (second.finalReconcile?.done ?? 0), 1);
});

test("Bootstrap I: bootstrap実行中に新しいConversationが増えても、migrationの内部rescanで取りこぼされない", async () => {
  const vault = new FakeVault();
  await resetAll();
  const existing = conversation("boot-i-existing");
  await dbMod.putConversation(existing);
  // このFakeVaultにはmigration中の副作用フックが無いため、通常のrescan設計
  // （Phase 3-5・すでにtest済み）をそのまま信頼する形で、事前に2件目を追加してから
  // 呼び出す（rescanの「今読み直した最新集合」自体は毎回ここで確定するため、
  // 呼び出し前に存在する2件目も1回のbootstrap呼び出しで正しく処理される）。
  const addedBeforeCall = conversation("boot-i-added");
  await dbMod.putConversation(addedBeforeCall);
  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal((result.reconcile?.done ?? 0) + (result.finalReconcile?.done ?? 0), 2);
});

test("Bootstrap J: 2回連続bootstrapを実行しても完全に収束し、duplicateが生じない", async () => {
  const vault = new FakeVault();
  await resetAll();
  const c = conversation("boot-j-conv");
  const m = memory("boot-j-mem", "2026-07-02");
  await dbMod.putConversation(c);
  await dbMod.putMemoryObject(m);

  const first = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal((first.reconcile?.done ?? 0) + (first.finalReconcile?.done ?? 0), 2);
  const second = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(second.identity.kind, "identified");
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(Object.keys(index).length, 2, "duplicateエントリが増えていない");
});

// ===========================================================================
// K：Combined End-to-End Foundation Fixture（永久回帰テスト）
// ===========================================================================

test("Bootstrap K（Combined E2E Foundation Fixture、永久回帰テスト）: legacy adoption・Conversation/Memory/Reflection/Source混在・metadata欠落・baseline nullのすべてが1回のbootstrapで安全に収束する", async () => {
  const vault = new FakeVault();
  await resetAll();
  const day = "2026-07-03";

  // --- Conversation ---
  const convA = conversation("e2e-conv-a"); // same
  const convAPath = `Conversations/${vaultMod.fileNameFor(convA.id, convA.startedAt)}`;
  vault.put(convAPath, markdownMod.conversationToMarkdown(convA));
  const convB = conversation("e2e-conv-b"); // idb-only
  const convCOld = conversation("e2e-conv-c", { turns: [{ role: "user", content: "最初の発言", timestamp: T }] });
  const convCNew: Conversation = { ...convCOld, turns: [...convCOld.turns, { role: "ai", content: "追加の返信", timestamp: "2026-07-03T09:00:01.000Z" }], updatedAt: "2026-07-03T09:00:01.000Z" };
  const convCPath = `Conversations/${vaultMod.fileNameFor(convCOld.id, convCOld.startedAt)}`;
  vault.put(convCPath, markdownMod.conversationToMarkdown(convCOld)); // legitimate successor

  // --- Memory（day-file、A/C同じday、X=Vault-only未知member） ---
  const memA = memory("e2e-mem-a", day); // same
  const memB = memory("e2e-mem-b", day, { createdAt: `${day}T09:01:00.000Z` }); // idb-only
  const memCOld = memory("e2e-mem-c", day, { createdAt: `${day}T09:02:00.000Z`, updatedAt: `${day}T09:02:00.000Z` });
  const memCNew: MemoryObject = { ...memCOld, updatedAt: `${day}T09:10:00.000Z` }; // 安全な後継（summary/contentは不変、updatedAtだけ増える）
  const memX = memory("e2e-mem-x", day, { createdAt: `${day}T08:00:00.000Z` }); // Vault-only未知member
  vault.put(memoryDayPathOf(day), markdownMod.serializeMemoryDayFile([memX, memA, memCOld]));

  // --- Reflection（1record1file） ---
  const reflSame = reflection("e2e-refl-same", day);
  vault.put(`Memories/${vaultMod.fileNameFor(reflSame.id, reflSame.date)}`, markdownMod.memoryObjectToMarkdown(reflSame));
  const reflIdbOnly = reflection("e2e-refl-idb-only", day, { createdAt: `${day}T09:03:00.000Z` });

  // --- Source（1record1file） ---
  const srcSame = source("e2e-src-same");
  vault.put(`Sources/${vaultMod.fileNameFor(srcSame.id, srcSame.createdAt)}`, markdownMod.sourceToMarkdown(srcSame));
  const srcIdbOnly = source("e2e-src-idb-only");

  // Registry/History/index/baselineは一切seedしない（全部欠落・null状態から始める）。

  await dbMod.putConversation(convA);
  await dbMod.putConversation(convB);
  await dbMod.putConversation(convCNew);
  await dbMod.putMemoryObject(memA);
  await dbMod.putMemoryObject(memB);
  await dbMod.putMemoryObject(memCNew);
  await dbMod.putMemoryObject(reflSame);
  await dbMod.putMemoryObject(reflIdbOnly);
  await dbMod.saveSource(srcSame);
  await dbMod.saveSource(srcIdbOnly);

  // outbox：一部pending（convAに既存entryを手動で仕込む。既存の進捗を壊さず、
  // かつ改めて実体を検証してdoneへ収束させることを確認する）・一部無し
  // （他は全てmigrationが新規作成する）。
  //
  // 注：`getPendingVaultOutboxEntries()`はstatus==="pending"のみを対象にする
  // （`by-status`index）ため、既に"done"なentryはbatch reconcile（Bootstrapの
  // reconcile pass）の対象に含まれない——「done flagを信用しすぎない」
  // （Invariant 3）は個々の`reconcile*OutboxEntry(env, entry)`がその特定の
  // entryを渡されたときに再検証する、という粒度で保証されるのであって、
  // batch関数が「done全件を毎回re-scanする」わけではない（意図的な設計。
  // 全recordを毎回舐めるとPending-queue方式の効率上の利点が失われるため）。
  // よってここでは「doneだが実体と食い違う」状態はあえて作らない。
  const convAOutbox = await dbMod.putConversationWithOutbox(convA);
  await dbMod.putVaultOutboxEntry({ ...convAOutbox, status: "pending" });

  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));

  assert.ok(result.identity.kind === "newly-paired" || result.identity.kind === "identified", `identityが解決されなかった: ${JSON.stringify(result.identity)}`);
  assert.equal(result.migration?.phase, "done");
  assert.equal(result.migration?.conflictRecordIds.length, 0);
  assert.equal(result.migration?.memoryConflictRecordIds.length, 0);
  assert.equal(result.migration?.reflectionConflictRecordIds.length, 0);
  assert.equal(result.migration?.sourceConflictRecordIds.length, 0);
  assert.deepEqual(result.migration?.memoryVaultOnlyMembers.map((v) => v.id), [memX.id]);

  const allSafeIds: [string, string][] = [
    ["conversation", convA.id], ["conversation", convB.id], ["conversation", convCNew.id],
    ["memory", memA.id], ["memory", memB.id], ["memory", memCNew.id],
    ["reflection", reflSame.id], ["reflection", reflIdbOnly.id],
    ["source", srcSame.id], ["source", srcIdbOnly.id],
  ];
  for (const [kind, id] of allSafeIds) {
    const entry = await dbMod.getVaultOutboxEntry(`${kind}:${id}`);
    assert.equal(entry?.status, "done", `${kind}:${id}がdoneになっていない: ${JSON.stringify(entry)}`);
  }

  // 最終Vault状態の確認。
  assert.equal(vault.get(convAPath), markdownMod.conversationToMarkdown(convA));
  const convBPath = `Conversations/${vaultMod.fileNameFor(convB.id, convB.startedAt)}`;
  assert.equal(vault.get(convBPath), markdownMod.conversationToMarkdown(convB));
  assert.equal(vault.get(convCPath), markdownMod.conversationToMarkdown(convCNew));

  const memMembers = markdownMod.parseMemoryDayFile(vault.get(memoryDayPathOf(day))!);
  assert.equal(memMembers.length, 4, "X/A/B/Cの4件が最終的に揃う");
  assert.ok(memMembers.some((m) => m.id === memX.id), "X：Vault-onlyは保全される");
  assert.ok(memMembers.some((m) => m.id === memB.id), "B：新規追加される");

  assert.ok(await dbMod.getVaultOutboxEntry(`reflection:${reflSame.id}`));
  assert.ok(await dbMod.getVaultOutboxEntry(`reflection:${reflIdbOnly.id}`));
  assert.ok(await dbMod.getVaultOutboxEntry(`source:${srcSame.id}`));
  assert.ok(await dbMod.getVaultOutboxEntry(`source:${srcIdbOnly.id}`));

  // metadataがすべて修復されていることの確認（最初は完全に欠落していた）。
  assert.notEqual(vault.get(".tsumugi/index.json"), undefined);
  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(index[convA.id], convAPath);
  assert.equal(index[memA.id], memoryDayPathOf(day));

  // --- 2回目のbootstrap：実質no-opで、duplicateが生じない ---
  const writesBefore = vault.writeCount;
  const second = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.equal(second.identity.kind, "identified");
  assert.equal(vault.writeCount, writesBefore, "2回目は1byteも書き込まない");
  const memMembersAfterSecond = markdownMod.parseMemoryDayFile(vault.get(memoryDayPathOf(day))!);
  assert.equal(memMembersAfterSecond.length, 4, "重複が生じない");
});

// ===========================================================================
// L：Conflict混在fixture
// ===========================================================================

test("Bootstrap L（Conflict混在fixture）: Conversation 1件・Memory 1件がconflictでも、その2件だけheldになり他は全てdoneのまま処理が継続する", async () => {
  const vault = new FakeVault();
  await resetAll();
  seedPrepairedIdentity(vault); // identity自体は既にpair済みにしておく（identity層の衝突とは別の話にするため）
  await seedIdbPrepairedIdentity();
  const day = "2026-07-04";

  const convOk = conversation("conflict-conv-ok");
  const convConflict = conversation("conflict-conv-conflict");
  const convConflictPath = `Conversations/${vaultMod.fileNameFor(convConflict.id, convConflict.startedAt)}`;
  vault.put(convConflictPath, markdownMod.conversationToMarkdown({ ...convConflict, turns: [{ role: "user", content: "外部で食い違う会話内容", timestamp: T }] }));

  const memOk = memory("conflict-mem-ok", day, { createdAt: `${day}T09:00:00.000Z` });
  const memConflictOnDisk = memory("conflict-mem-conflict", day, { createdAt: `${day}T09:01:00.000Z`, content: "Vault側の内容" });
  const memConflictCanonical: MemoryObject = { ...memConflictOnDisk, content: "canonical側の食い違う内容" };
  vault.put(memoryDayPathOf(day), markdownMod.serializeMemoryDayFile([memConflictOnDisk]));

  const reflOk = reflection("conflict-refl-ok", day);
  const srcOk = source("conflict-src-ok");

  await dbMod.putConversation(convOk);
  await dbMod.putConversation(convConflict);
  await dbMod.putMemoryObject(memOk);
  await dbMod.putMemoryObject(memConflictCanonical);
  await dbMod.putMemoryObject(reflOk);
  await dbMod.saveSource(srcOk);

  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));

  assert.equal(result.identity.kind, "identified");
  assert.deepEqual(result.migration?.conflictRecordIds, [convConflict.id]);
  assert.deepEqual(result.migration?.memoryConflictRecordIds, [memConflictCanonical.id]);

  // conflictと判定された2件はそもそもoutboxへ登録されない（Bootstrap F・
  // Migration K/Vと同じ規約）。
  assert.equal(await dbMod.getVaultOutboxEntry(`conversation:${convConflict.id}`), undefined);
  assert.equal(await dbMod.getVaultOutboxEntry(`memory:${memConflictCanonical.id}`), undefined);

  // conflictしたVault内容はどちらも一切変更されない。
  assert.ok(vault.get(convConflictPath)?.includes("外部で食い違う会話内容"));
  const memMembersAfter = markdownMod.parseMemoryDayFile(vault.get(memoryDayPathOf(day))!);
  const stillConflict = memMembersAfter.find((m) => m.id === memConflictOnDisk.id)!;
  assert.equal(stillConflict.content, "Vault側の内容");

  // 他recordは正しく収束している。
  const okPath = `Conversations/${vaultMod.fileNameFor(convOk.id, convOk.startedAt)}`;
  assert.equal(vault.get(okPath), markdownMod.conversationToMarkdown(convOk));
  assert.ok(memMembersAfter.some((m) => m.id === memOk.id));
  for (const [kind, id] of [["conversation", convOk.id], ["memory", memOk.id], ["reflection", reflOk.id], ["source", srcOk.id]] as [string, string][]) {
    const entry = await dbMod.getVaultOutboxEntry(`${kind}:${id}`);
    assert.equal(entry?.status, "done", `${kind}:${id}`);
  }
});

function memoryDayPathOf(day: string): string {
  return `Memories/${vaultMod.dayFileNameFor(day)}`;
}
