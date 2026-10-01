/**
 * Recovery Legacy Held Cleanup の回帰テスト。
 *
 * 実IndexedDBは使わない（`fakeIdb.ts`をModule._loadで`require("idb")`へ差し替える）。
 * 実Vaultも使わず、in-memoryの疑似FileSystemDirectoryHandle（`FakeVault`）を使う。
 * `vaultRecovery.ts`の`buildVaultRecoveryPlan`は実際にディレクトリを再帰的に
 * `entries()`で列挙するため、このFakeVaultは`entries()`を実装する。
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

// ---------------------------------------------------------------------------
// `runLegacyHeldCleanup`自身が`runVaultWorldExclusive`（H4世界ロック、"tsumugi-vault-world"）を
// 取得するようになったため（Bootstrap/Recovery/legacy writerとの排他を閉じるlock order対応）、
// `vaultWriteGate.test.ts`/`vaultLockOrder.test.ts`と同じ実FIFO fake navigator.locksと、
// H4のepoch整合性（`markVaultEpochCommitted`/`markVaultWorldJournalMigrated`/`setTabVaultEpoch`）を
// このファイル全体で用意する。
// ---------------------------------------------------------------------------

/**
 * `runLegacyHeldCleanup`は"tsumugi-vault-world"（外側、`runVaultWorldExclusive`）→
 * "tsumugi-save-foundation-bootstrap"（内側、`withVaultSaveLock`）と、異なる名前の
 * ロックを入れ子で取得する。実際のWeb Locks APIはロック名ごとに独立したqueueを持つため
 * （別名同士は互いを一切ブロックしない）、fakeも名前ごとに別々のtail chainを持たせる
 * ——単一queueにすると、外側の名前のrequest()が完了する前に内側の別名のrequest()を
 * 呼んだ時点で、この2つが同じqueueへ並んでしまい自己デッドロックする。
 */
class FakeLockManager {
  private tails = new Map<string, Promise<void>>();
  async request<T>(name: string, optionsOrCb: unknown, maybeCb?: (lock: { name: string } | null) => Promise<T>): Promise<T> {
    const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as (lock: { name: string } | null) => Promise<T>;
    const options = typeof optionsOrCb === "function" ? {} : (optionsOrCb as { signal?: AbortSignal });
    const myTurn = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    this.tails.set(name, new Promise((resolve) => { release = resolve; }));
    if (options.signal) {
      const abortedEarly = new Promise<never>((_r, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      try {
        await Promise.race([myTurn, abortedEarly]);
      } catch (e) {
        release();
        throw e;
      }
    } else {
      await myTurn;
    }
    try {
      return await cb({ name });
    } finally {
      release();
    }
  }
}
Object.defineProperty(globalThis, "navigator", { value: { locks: new FakeLockManager() }, configurable: true, writable: true });

const dbMod = require(path.join(OUT, "lib/db.js")) as typeof import("./db");
const vaultMod = require(path.join(OUT, "lib/vault.js")) as typeof import("./vault");
const markdownMod = require(path.join(OUT, "lib/markdown.js")) as typeof import("./markdown");
const cleanupMod = require(path.join(OUT, "lib/vaultRecoveryLegacyCleanup.js")) as typeof import("./vaultRecoveryLegacyCleanup");
const productionBootstrapMod = require(path.join(OUT, "lib/saveFoundationBootstrap.js")) as typeof import("./saveFoundationBootstrap");
const vaultWorldLockMod = require(path.join(OUT, "lib/vaultWorldLock.js")) as typeof import("./vaultWorldLock");
const vaultRecoveryApplyMod = require(path.join(OUT, "lib/vaultRecoveryApply.js")) as typeof import("./vaultRecoveryApply");
vaultWorldLockMod.setTabVaultEpoch(0);

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type VaultIdentityRecord = import("./vaultIdentity").VaultIdentityRecord;

// ---------------------------------------------------------------------------
// in-memory疑似ファイルシステム（entries()対応版）
// ---------------------------------------------------------------------------

class FakeFile {
  constructor(public content: string, public mtime: number) {}
}

class FakeVault {
  files = new Map<string, FakeFile>();
  private clock = 1;
  writeCount = 0;
  writes: string[] = [];
  beforeClose?: (path: string, content: string) => void;
  onRead?: (path: string, content: string) => string;
  failEnumeration = false;

  /** page kill専用：ここに含まれるpathへのcloseは、書き込みが実際に完了する前に例外を投げる
   * （＝「書きかけで中断した」を模す。書き込み先ファイルは中断前の内容のまま残る）。 */
  failCloseForPaths = new Set<string>();
  /** 同上、prefix一致版（archive entryのfile名はarchiveIdを含みテストから予測できないため）。 */
  failCloseForPrefix: string | null = null;
  /** 「書き込み自体は成功するが、読み戻すと異なる内容が返る」（storage破損）を模す。
   * このprefixに一致するpathを読むと、実際に書かれた内容ではなく壊れた内容を返す。 */
  corruptReadForPrefix: string | null = null;
  /** trueの間、`corruptReadForPrefix`による破損は`.tmp-`を含まないpath（＝finalize後の
   * 本番file）にだけ適用する（tempファイルの読み戻し検証はすり抜けさせ、finalの読み戻し
   * 検証だけを狙って壊す——2段階verifyのどちらが実際に効いているかを区別するテスト用）。 */
  corruptReadOnlyNonTemp = false;

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
      async removeEntry(name: string) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (!self.files.has(p)) throw new DOMException("no such file", "NotFoundError");
        self.files.delete(p);
      },
      async *entries() {
        if (self.failEnumeration && prefix.includes("recovery-archive")) throw new DOMException("blocked", "NotAllowedError");
        const children = new Map<string, "directory" | "file">();
        for (const p of self.files.keys()) {
          if (prefix && !p.startsWith(`${prefix}/`)) continue;
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
        const inPrefix = self.corruptReadForPrefix !== null && p.startsWith(self.corruptReadForPrefix);
        const corrupted = inPrefix && (!self.corruptReadOnlyNonTemp || !p.includes("/.tmp-"));
        const base = corrupted ? `${f.content}\nCORRUPTED-ON-READ` : f.content;
        const text = self.onRead ? self.onRead(p, base) : base;
        return { size: text.length, lastModified: f.mtime, async text() { return text; } } as unknown as File;
      },
      async createWritable() {
        let pending = "";
        return {
          async write(c: string) { pending = c; },
          async close() {
            if (self.failCloseForPaths.has(p) || (self.failCloseForPrefix !== null && p.startsWith(self.failCloseForPrefix))) {
              throw new Error("simulated page-kill mid-write");
            }
            self.beforeClose?.(p, pending);
            self.writes.push(p);
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
  delete(pathStr: string) {
    this.files.delete(pathStr);
  }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const T = "2026-10-10T09:00:00.000Z";
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

const VAULT_ID = "cleanup-vault-id";
function identity(): VaultIdentityRecord {
  return { id: "current", vaultId: VAULT_ID, activeVaultEpoch: 0, registryGeneration: "gen-1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
}

// `clearMemoryData()`は`settings`ストア（Recovery journal等）を対象にしない。空文字は
// `isRecoveryBlockingNormalWrites`から見ると「読めないjournal」（＝安全側でblocking）に
// なってしまうため、"none"相当ではなく有効な"completed"を書く。
const CLEARED_JOURNAL_RAW = JSON.stringify({
  version: 1, operationId: "cleared", status: "completed", createdAt: T, updatedAt: T,
  world: { activeVaultEpoch: 0, committedVaultEpoch: 0, registryGenerationEpoch: 0, journalVersion: "1", backend: "opfs" },
  baselineAtStart: { status: "unset", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false,
});

async function resetAll() {
  await dbMod.clearMemoryData();
  await dbMod.writeRecoveryJournalRaw(CLEARED_JOURNAL_RAW);
  await dbMod.markVaultEpochCommitted(0);
  await dbMod.markVaultWorldJournalMigrated();
  vaultWorldLockMod.setTabVaultEpoch(0);
}

/**
 * `createRecoveryApplyEnv`の既定`readLocalSnapshot`はbrowser組み込みの`indexedDB`を直接使うため
 * （`idb`パッケージ経由ではない）、このファイルの`fakeIdb`置き換えでは動かない。
 * `vaultRecoveryApply.test.ts`と同じ方式で、`readLocalSnapshot`だけをこのファイルの
 * 実`dbMod`（fakeIdb経由）で差し替える。
 */
function applyEnvFor(vault: FakeVault): import("./vaultRecoveryApply").RecoveryApplyEnv {
  return {
    ...vaultRecoveryApplyMod.createRecoveryApplyEnv(vault.root()),
    readLocalSnapshot: async () => ({
      conversations: await dbMod.getAllConversations(),
      memories: await dbMod.getAllMemoryObjects(),
      sources: await dbMod.getAllSources(),
      sync: {},
    }),
  };
}

function makeEnv(vault: FakeVault): import("./vaultRecoveryLegacyCleanup").LegacyCleanupEnv {
  return { root: vault.root(), vaultIdentity: identity(), now: () => T };
}

function seedVaultIdentity(vault: FakeVault): void {
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: VAULT_ID }));
}

async function assertResultIsSummary(result: import("./vaultRecoveryLegacyCleanup").LegacyHeldCleanupRunResult): Promise<import("./vaultRecoveryLegacyCleanup").LegacyHeldCleanupResult> {
  assert.ok(!("notRun" in result), `cleanupが実行されなかった: ${JSON.stringify(result)}`);
  return result as import("./vaultRecoveryLegacyCleanup").LegacyHeldCleanupResult;
}

async function archivedEntriesFor(vault: FakeVault, recordType: string, recordId: string) {
  const all = await cleanupMod.listRecoveryArchiveEntries(vault.root());
  return all.filter((e) => e.recordType === recordType && e.recordId === recordId);
}

// ===========================================================================
// A：Memory day-fileは一切書き換えられず、Vault-only memberを完全に保持する
// ===========================================================================

test("A: memory-dayfile-merge-requiredをarchiveしても、Memory day-fileは一切書き換えられず、Vault-only memberを完全に保持する", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const day = "2026-10-20";
  const path = `Memories/${vaultMod.dayFileNameFor(day)}`;
  // IndexedDBには存在しない、Vault側にだけあるmember（day-fileの「本物のVault-only member」）。
  const vaultOnly = memory("a-vault-only", day, { createdAt: `${day}T07:00:00.000Z` });
  vault.put(path, markdownMod.serializeMemoryDayFile([vaultOnly]));
  const target = memory("a-target", day, { createdAt: `${day}T09:00:00.000Z` });
  await dbMod.putMemoryObject(target);

  const planBefore = await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root());
  const before = planBefore.records.find((r) => r.recordId === target.id)!;
  assert.equal(before.classification, "memory-dayfile-merge-required");

  const beforeRaw = vault.get(path);
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 1);
  assert.equal(result.repaired, 0);
  assert.equal(vault.get(path), beforeRaw, "Memory day-fileはcleanupによって一切書き換えられていない（byte同一）");
  const members = markdownMod.parseMemoryDayFile(vault.get(path)!);
  assert.equal(members.length, 1);
  assert.ok(members.some((m) => m.id === vaultOnly.id), "Vault-only memberは失われない");

  const entries = await archivedEntriesFor(vault, "memory", target.id);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].rawFileContents[path]?.includes(vaultOnly.id), "archiveにday-file全文（Vault-only member含む）が保存されている");
});

// ===========================================================================
// B：未知frontmatterを持つVault-only member → cleanup後、day-fileはbyte単位で完全に同一
// ===========================================================================

test("B: 未知frontmatnaフィールドを持つVault-only memberがあっても、cleanup後のday-fileはbyte単位で元のままである", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const day = "2026-10-21";
  const path = `Memories/${vaultMod.dayFileNameFor(day)}`;
  const vaultOnly = memory("b-vault-only", day, { createdAt: `${day}T07:00:00.000Z` });
  const baseRaw = markdownMod.memoryObjectToMarkdown(vaultOnly);
  const lines = baseRaw.split("\n");
  const insertAt = lines.findIndex((l: string) => l.startsWith("tsumugi:")) + 1;
  lines.splice(insertAt, 0, 'unknownFutureSchemaField: "must-not-be-dropped"');
  const rawWithUnknownField = lines.join("\n");
  vault.put(path, rawWithUnknownField);
  const target = memory("b-target", day, { createdAt: `${day}T09:00:00.000Z` });
  await dbMod.putMemoryObject(target);

  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 1);
  assert.equal(vault.get(path), rawWithUnknownField, "day-fileはbyte単位で完全に不変（未知フィールドを含め、一切再構成されていない）");
});

// ===========================================================================
// C：duplicate 2path → 両path raw content archive → placeholderなし → path set変更で再評価
// ===========================================================================

test("C: 同一IDが2つのpathに重複しているConversationは、両方のraw内容がarchiveされ、path集合が変わると再評価される", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("c-conv");
  const pathA = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  const pathB = `Conversations/duplicate-${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  const contentA = markdownMod.conversationToMarkdown(conv);
  const contentB = markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "重複コピー側の内容", timestamp: T }] });
  vault.put(pathA, contentA);
  vault.put(pathB, contentB);
  await dbMod.putConversation(conv);

  const planBefore = await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root());
  const before = planBefore.records.find((r) => r.recordId === conv.id)!;
  assert.equal(before.classification, "unreadable / indeterminate");
  assert.ok(before.reasons.includes("duplicate-or-cross-type-id"));

  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 1);
  const entries = await archivedEntriesFor(vault, "conversation", conv.id);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.vaultPaths.length, 2);
  assert.equal(entry.rawFileContents[pathA], contentA, "1つ目のpathの実内容がplaceholderなしでそのままarchiveされている");
  assert.equal(entry.rawFileContents[pathB], contentB, "2つ目のpathの実内容もplaceholderなしでそのままarchiveされている");
  assert.equal(vault.get(pathA), contentA, "現在のVault側は一切変更されない");
  assert.equal(vault.get(pathB), contentB, "現在のVault側は一切変更されない");

  const filteredBefore = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(!filteredBefore.records.some((r) => r.recordId === conv.id), "archive直後は除外される");

  // pathの集合が変わった（重複の片方が消えた）→ record IDが同じでも再評価する。
  vault.delete(pathB);
  const filteredAfter = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(filteredAfter.records.some((r) => r.recordId === conv.id), "path集合が変わったため除外されない（再評価される）");
});

test("C2: archive後に新しいduplicate pathが増えた場合も（既存pathの内容は不変でも）再評価される", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("c2-conv");
  const pathA = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  const contentA = markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "最初の食い違い", timestamp: T }] });
  vault.put(pathA, contentA);
  await dbMod.putConversation(conv);

  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 1);
  const filteredBefore = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(!filteredBefore.records.some((r) => r.recordId === conv.id), "archive直後は除外される");

  // 既存path（pathA）の内容は一切変えず、新しいduplicate pathが増えた。
  const pathB = `Conversations/duplicate-${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  vault.put(pathB, contentA);
  const filteredAfter = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(filteredAfter.records.some((r) => r.recordId === conv.id), "path集合が増えただけでも（既存pathの内容が不変でも）除外されない");
});

// ===========================================================================
// D：Vault identity mismatch → warning除外しない
// ===========================================================================

test("D: archive時と異なるVault identityの下では、archive済みでもwarningから除外しない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("d-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] }));
  await dbMod.putConversation(conv);

  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 1);

  const differentWorldEnv: import("./vaultRecoveryLegacyCleanup").LegacyCleanupEnv = {
    root: vault.root(),
    vaultIdentity: { id: "current", vaultId: "a-different-vault-id", activeVaultEpoch: 0, registryGeneration: "gen-1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T },
    now: () => T,
  };
  const filtered = await cleanupMod.excludeArchivedFromRecoveryPlan(differentWorldEnv, await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(filtered.records.some((r) => r.recordId === conv.id), "worldVaultIdが異なるため除外しない");
});

// ===========================================================================
// E：同一record内容変更 → 旧archiveは保持、新archiveを追加（上書きなし）
// ===========================================================================

test("E: 同一recordの内容が変わったら、旧archiveを保持したまま新しいarchiveを追加する（上書きしない）", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("e-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  const firstOnDisk = markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "最初の食い違い", timestamp: T }] });
  vault.put(path, firstOnDisk);
  await dbMod.putConversation(conv);

  const first = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(first.archived, 1);
  const afterFirst = await archivedEntriesFor(vault, "conversation", conv.id);
  assert.equal(afterFirst.length, 1);
  const firstArchiveId = afterFirst[0].archiveId;

  const secondOnDisk = markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "さらに別の食い違い", timestamp: T }] });
  vault.put(path, secondOnDisk);
  const second = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(second.archived, 1);
  const afterSecond = await archivedEntriesFor(vault, "conversation", conv.id);
  assert.equal(afterSecond.length, 2, "旧entryを上書きせず、新しいentryを追加する");
  const preserved = afterSecond.find((e) => e.archiveId === firstArchiveId)!;
  assert.equal(preserved.rawFileContents[path], firstOnDisk, "旧archiveの内容は変更されず保持される");
  const added = afterSecond.find((e) => e.archiveId !== firstArchiveId)!;
  assert.equal(added.rawFileContents[path], secondOnDisk, "新archiveが新しい内容を保持する");
});

// ===========================================================================
// F：archive entry parse failure → fail closed → 上書きしない
// ===========================================================================

test("F: 壊れたarchiveは保持し、読み取り不能状態では追加も警告除外もしない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("f-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] }));
  await dbMod.putConversation(conv);

  // 壊れたarchive entry（parse不能なJSON）を、あたかも既にこのrecordをarchive済みであるかのように置く。
  vault.put(".tsumugi/recovery-archive/entries/conversation__f-conv__broken.json", "{ not valid json at all");

  const filteredBefore = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(filteredBefore.records.some((r) => r.recordId === conv.id), "壊れたentryは有効なarchiveとして扱われない＝除外されない（fail closed）");

  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 0, "壊れたentryとは無関係に、新しい正常なarchiveを作成できる");
  assert.equal(vault.get(".tsumugi/recovery-archive/entries/conversation__f-conv__broken.json"), "{ not valid json at all", "壊れたentry自体は上書き・削除されない");

  const filteredAfter = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(filteredAfter.records.some((r) => r.recordId === conv.id), "新しい正常なarchiveにより、今度は除外される");
});

// ===========================================================================
// G：lock待機中にRecovery Journalがin-progressになっても、lock取得後gateで停止する
// ===========================================================================

test("G: lock取得待ちの間にRecovery Journalがin-progressになった場合、lock取得後の再確認で停止し、何も変更しない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("g-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] }));
  await dbMod.putConversation(conv);

  let releaseHolder!: () => void;
  const holderReleased = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const holderDone = vaultWorldLockMod.runVaultWorldExclusive(async () => {
    await holderReleased;
    return "holder-ok";
  });
  await new Promise((r) => setTimeout(r, 5)); // 1つ目が確実にlockを握った状態にする。
  const cleanupPromise = cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  await new Promise((r) => setTimeout(r, 5));
  const inProgressJournalRaw = JSON.stringify({
    version: 1, operationId: "op-race", status: "in-progress", createdAt: T, updatedAt: T,
    world: { activeVaultEpoch: 0, committedVaultEpoch: 0, registryGenerationEpoch: 0, journalVersion: "1", backend: "opfs" },
    baselineAtStart: { status: "unset", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false,
  });
  await dbMod.writeRecoveryJournalRaw(inProgressJournalRaw); // lock待ち中にRecoveryが開始した、という状況を模す。
  releaseHolder();
  await holderDone;

  const result = await cleanupPromise;
  assert.deepEqual(result, { notRun: "recovery-in-progress" }, "lock取得前の確認だけに頼っていれば、ここで誤って続行してしまう");
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] }), "Vaultは一切変更されない");
  const entries = await archivedEntriesFor(vault, "conversation", conv.id);
  assert.equal(entries.length, 0, "archiveも一切作られない");
  await dbMod.writeRecoveryJournalRaw(CLEARED_JOURNAL_RAW);
});

// ===========================================================================
// H：Memory day-file → archive/再評価の比較単位をraw day-fileに統一 → heldCountとremainingが一致
// ===========================================================================

test("H: Memoryのarchive/再評価はday-file全文を単位とし、RecoveryPlan側とApplyPlan側のheldCountが一致する", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const day = "2026-10-22";
  const path = `Memories/${vaultMod.dayFileNameFor(day)}`;
  const target = memory("h-target", day, { createdAt: `${day}T09:00:00.000Z` });
  await dbMod.putMemoryObject(target);
  vault.put(path, markdownMod.serializeMemoryDayFile([memory("h-vault-only", day, { createdAt: `${day}T07:00:00.000Z` })]));

  const cleanupResult = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(cleanupResult.archived, 1);

  const filteredPlan = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  const remainingFromPlan = filteredPlan.records.filter((r) => ["conflict", "memory-dayfile-merge-required", "unreadable / indeterminate"].includes(r.classification)).length;

  const applyEnv = applyEnvFor(vault);
  const filteredApplyPlan = await cleanupMod.excludeArchivedFromApplyPlan(makeEnv(vault), await vaultRecoveryApplyMod.planRecoveryApply(applyEnv));

  assert.equal(remainingFromPlan, 0);
  assert.equal(filteredApplyPlan.heldCount, 0);
  assert.equal(remainingFromPlan, filteredApplyPlan.heldCount, "RecoveryPlan側の残件数とApplyPlan側のheldCountが一致する");
});

// ===========================================================================
// I：再診断（planRecoveryApplyExcludingArchived）自体が失敗したら、例外がそのまま伝播する
// （UI側はこれをcatchして「成功」表示をしない設計——ここではライブラリ層の契約を確認する）。
// ===========================================================================

test("I: 再診断（planRecoveryApplyExcludingArchived）が失敗する状況では、例外がそのまま呼び出し元へ伝播し、偽の成功を返さない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const applyEnv: import("./vaultRecoveryApply").RecoveryApplyEnv = {
    ...applyEnvFor(vault),
    readWorld: async () => {
      throw new Error("simulated world read failure");
    },
  };
  await assert.rejects(cleanupMod.planRecoveryApplyExcludingArchived(applyEnv), /simulated world read failure/);
});

// ===========================================================================
// J：Archive write途中page kill → current Vault/canonicalは無変更 → 未完了archiveをresolved扱いしない
// ===========================================================================

test("J: Archive書込みの途中でpage kill相当が起きても、current Vault/canonicalは無変更で、未完了archiveをresolved扱いしない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("j-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  const onDisk = markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] });
  vault.put(path, onDisk);
  await dbMod.putConversation(conv);

  vault.failCloseForPrefix = ".tsumugi/recovery-archive/";
  const first = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(first.archived, 0);
  assert.ok(first.failed >= 1, "archive書込みの失敗はfailedとして報告される");
  assert.equal(vault.get(path), onDisk, "現在のVaultは一切変更されない");
  const stored = await dbMod.getConversation(conv.id);
  assert.deepEqual(stored, conv, "canonicalも一切変更されない");
  const entries = await archivedEntriesFor(vault, "conversation", conv.id);
  assert.equal(entries.length, 0, "未完了archiveは有効なentryとして残らない（temp fileのまま、または書けていない）");

  const filtered = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(filtered.records.some((r) => r.recordId === conv.id), "未完了archiveはresolved扱いにならない（確認が必要なまま）");

  // 「再起動」相当：中断要因を取り除けば、次回は正常にarchiveできる。
  vault.failCloseForPrefix = null;
  const second = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(second.archived, 1);
});

// ===========================================================================
// K：Archive write成功→readback/hash verify失敗 → warning除外しない
// ===========================================================================

test("K1: Archive書込み自体は成功しても、tempファイルの読み戻し検証に失敗したらwarningから除外しない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("k1-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] }));
  await dbMod.putConversation(conv);

  // 書込み自体（close()）は成功するが、直後の読み戻しが破損した内容を返す（storage破損を模す）。
  vault.corruptReadForPrefix = ".tsumugi/recovery-archive/";
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 0);
  assert.ok(result.failed >= 1, "readback verify失敗はfailedとして報告される");

  const filtered = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(filtered.records.some((r) => r.recordId === conv.id), "readback verifyに失敗したarchiveはresolved扱いにならない");

  vault.corruptReadForPrefix = null;
  const second = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(second.archived, 1, "破損要因を取り除けば、次回は正常にarchiveできる");
});

test("K2: tempファイルの読み戻しは正常でも、本番pathへ書いた後の読み戻し検証に失敗したらwarningから除外しない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("k2-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] }));
  await dbMod.putConversation(conv);

  // tempファイルの読み戻しは正常に通るが、本番pathへfinalizeした後の読み戻しだけが破損する。
  vault.corruptReadForPrefix = ".tsumugi/recovery-archive/";
  vault.corruptReadOnlyNonTemp = true;
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 0, "tempの検証だけでは不十分——finalへの書込み後の読み戻し検証も必須");
  assert.ok(result.failed >= 1);

  const filtered = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.ok(filtered.records.some((r) => r.recordId === conv.id), "final読み戻し検証に失敗したarchiveはresolved扱いにならない");
});

// ===========================================================================
// L：同一状態でcleanup再実行 → duplicate archiveなし
// ===========================================================================

test("L: 状態が変わらない間にcleanupを2回実行しても、duplicate archiveが生じない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("l-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "食い違う内容", timestamp: T }] }));
  await dbMod.putConversation(conv);

  const first = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(first.archived, 1);
  const writesBefore = vault.writeCount;
  const second = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(second.processed, 1, "対象自体には引き続き挙がる（既存archiveの再利用を確認するため）");
  assert.equal(second.archived, 1);
  assert.equal(vault.writeCount, writesBefore, "2回目は1byteも書き込まない（既存archiveを再利用する）");
  const entries = await archivedEntriesFor(vault, "conversation", conv.id);
  assert.equal(entries.length, 1, "duplicate archiveが生じない");
});

// ===========================================================================
// M：状態変更後cleanup再実行 → 旧archive保持 + 新archive追加（end-to-end）
// ===========================================================================

test("M: 状態が変わった後にcleanupを再実行すると、旧archiveを保持したまま新しいarchiveが追加される（end-to-end）", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const day = "2026-10-23";
  const path = `Memories/${vaultMod.dayFileNameFor(day)}`;
  const target = memory("m-target", day, { createdAt: `${day}T09:00:00.000Z` });
  await dbMod.putMemoryObject(target);
  vault.put(path, markdownMod.serializeMemoryDayFile([memory("m-vault-only-1", day, { createdAt: `${day}T07:00:00.000Z` })]));

  const first = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(first.archived, 1);
  const afterFirst = await archivedEntriesFor(vault, "memory", target.id);
  assert.equal(afterFirst.length, 1);

  // day-fileの状態が変わった（別のVault-only memberが増えた）。
  vault.put(path, markdownMod.serializeMemoryDayFile([memory("m-vault-only-1", day, { createdAt: `${day}T07:00:00.000Z` }), memory("m-vault-only-2", day, { createdAt: `${day}T07:30:00.000Z` })]));

  const second = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(second.archived, 1);
  const afterSecond = await archivedEntriesFor(vault, "memory", target.id);
  assert.equal(afterSecond.length, 2, "旧archiveを保持したまま、新しいarchiveが追加される");
});

// ===========================================================================
// N：healthy Phase 3-9 record → 対象外
// ===========================================================================

test("N: 既にSave Foundationで正常にdone収束しているrecordは、cleanupの対象にならない（何も変更しない）", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("n-conv");
  await dbMod.putConversationWithOutbox(conv);
  await productionBootstrapMod.runSaveFoundationBootstrap({ root: vault.root(), now: () => T });

  const writesBefore = vault.writeCount;
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.processed, 0, "local-only-safe/equivalent-existingはcleanup対象の分類に一切該当しない");
  assert.equal(vault.writeCount, writesBefore, "何も書き込まれない");
});

// ===========================================================================
// O：既存Recovery safe apply → 挙動変更なし（Recovery自身の領分には一切触れない）
// ===========================================================================

test("O: 健全なVault（heldなし）に対してcleanupを実行しても、何も変更しない——Recovery自身のsafe applyの領分と重複しない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("o-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown(conv));
  await dbMod.putConversation(conv);
  const shardPath = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(conv.id).toString(16).padStart(2, "0")}.json`;
  vault.put(shardPath, JSON.stringify({
    schemaVersion: 1, bucket: vaultMod.vaultRegistryBucketOf(conv.id),
    records: { [conv.id]: path },
    files: { [path]: { recordType: "conversation", mtime: 1, size: markdownMod.conversationToMarkdown(conv).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(conv)), memberIds: [conv.id], status: "ok" } },
  }));
  vault.put(".tsumugi/index.json", JSON.stringify({ [conv.id]: path }));
  vault.put(`.tsumugi/history/${conv.startedAt.slice(0, 7)}.json`, JSON.stringify({ version: 2, month: conv.startedAt.slice(0, 7), days: { [conv.startedAt.slice(0, 10)]: { conversations: [{ id: conv.id, mode: "diary", turnCount: conv.turns.length }], normalMemories: [], reflections: [] } } }));

  const planBefore = await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root());
  const before = planBefore.records.find((r) => r.recordId === conv.id);
  assert.ok(!before || before.classification === "equivalent-existing");

  const writesBefore = vault.writeCount;
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.processed, 0);
  assert.equal(vault.writeCount, writesBefore);
});

// ===========================================================================
// metadata-only repair（registry pointerだけを直す。本文には一切触れない）
// ===========================================================================

test("Archive-only: 孤立Registryも変更せずsnapshotへ保存する", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const conv = conversation("repair-conv");
  const path = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  const content = markdownMod.conversationToMarkdown(conv);
  vault.put(path, content);
  await dbMod.putConversation(conv);
  const bucket = vaultMod.vaultRegistryBucketOf(conv.id);
  const shardPath = `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
  vault.put(shardPath, JSON.stringify({ schemaVersion: 1, bucket, records: { [conv.id]: path }, files: {} })); // pointerはあるがentryが無い＝orphan-registry-key

  const planBefore = await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root());
  const before = planBefore.records.find((r) => r.recordId === conv.id)!;
  assert.equal(before.classification, "unreadable / indeterminate");
  assert.ok(before.reasons.includes("orphan-registry-key"));

  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.repaired, 0);
  assert.equal(result.archived, 1);
  assert.equal(vault.get(path), content, "本文は一切変更されない");
  const entries = await archivedEntriesFor(vault, "conversation", conv.id);
  assert.equal(entries.length, 1, "archiveを1件作る");

  const planAfter = await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root());
  assert.equal(planAfter.records.find((r) => r.recordId === conv.id)?.classification, "unreadable / indeterminate");
  assert.equal(vault.writes.some(p => !p.startsWith(".tsumugi/recovery-archive/")), false);
});

// ===========================================================================
// Lock order：runLegacyHeldCleanup自身がRecovery(exclusive world lock)実行中は待たされる
// ===========================================================================

test("Lock: runLegacyHeldCleanup自身が、Recovery(exclusive world lock)実行中は待たされ、同時にVaultへ触れない", async () => {
  await resetAll();
  const vault = new FakeVault();
  seedVaultIdentity(vault);
  const events: string[] = [];
  let vaultTouched = false;
  const instrumentedRoot = new Proxy(vault.root(), {
    get(target, prop, receiver) {
      if (!vaultTouched) {
        vaultTouched = true;
        events.push("vault:touched");
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const recoveryDone = vaultWorldLockMod.runVaultWorldExclusive(async () => {
    await new Promise((r) => setTimeout(r, 30));
    events.push("recovery:released");
    return "recovery-ok";
  });
  await new Promise((r) => setTimeout(r, 5));
  const cleanupDone = cleanupMod.runLegacyHeldCleanup({ root: instrumentedRoot, vaultIdentity: identity(), now: () => T });
  const [recoveryResult, cleanupResult] = await Promise.all([recoveryDone, cleanupDone]);
  assert.equal(recoveryResult.timedOut, false);
  await assertResultIsSummary(cleanupResult);
  assert.deepEqual(events, ["recovery:released", "vault:touched"], "legacy held cleanupは、Recoveryが排他ロックを解放するまでVaultへ一切触れない");
});

// Independent review regressions: actual cleanup + actual archive implementation.
const archiveMod = require(path.join(OUT, "lib/vaultRecoveryArchive.js")) as typeof import("./vaultRecoveryArchive");
async function reviewFixture(id: string) {
  await resetAll();
  const vault = new FakeVault(); seedVaultIdentity(vault);
  await dbMod.putVaultIdentityRecord(identity());
  const conv = conversation(id); await dbMod.putConversation(conv);
  const file = `Conversations/${vaultMod.fileNameFor(conv.id, conv.startedAt)}`;
  const raw = markdownMod.conversationToMarkdown({ ...conv, turns: [{ role: "user", content: "unique Vault original", timestamp: T }] });
  vault.put(file, raw);
  return { vault, conv, file, raw };
}
async function held(vault: FakeVault): Promise<number> {
  return (await cleanupMod.planRecoveryApplyExcludingArchived(applyEnvFor(vault))).heldCount;
}
function currentFiles(vault: FakeVault) {
  return [...vault.files].filter(([p]) => !p.startsWith(".tsumugi/recovery-archive/")).map(([p,f]) => [p,f.content]);
}
function finalArchivePaths(vault: FakeVault) {
  return [...vault.files.keys()].filter(p => p.startsWith(".tsumugi/recovery-archive/entries/") && !p.includes("/.tmp-"));
}
for (const phase of ["temp-write", "temp-readback", "final-write", "final-partial", "final-corrupt-readback", "between-temp-final"]) {
  test(`Review fault: ${phase}; original data unchanged, no false resolution`, async () => {
    const { vault, conv } = await reviewFixture(`fault-${phase}`);
    const before = currentFiles(vault);
    vault.beforeClose = (p, text) => {
      if (!p.startsWith(".tsumugi/recovery-archive/")) throw new Error("current-data-write-forbidden");
      const temp = p.includes("/.tmp-");
      if ((phase === "temp-write" && temp) || (["final-write", "between-temp-final"].includes(phase) && !temp)) throw new Error("interruption");
      if (phase === "final-partial" && !temp) { vault.put(p,text.slice(0,30)); throw new Error("killed after partial in-place write"); }
    };
    vault.onRead = (p, text) => {
      if (phase === "temp-readback" && p.includes("/.tmp-")) return text + "broken";
      if (phase === "final-corrupt-readback" && p.includes("recovery-archive") && !p.includes("/.tmp-")) {
        const v = JSON.parse(text); v.canonicalRaw += "corrupt"; return JSON.stringify(v);
      }
      return text;
    };
    const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
    assert.equal(result.archived,0); assert.equal(result.failed,1);
    assert.deepEqual(currentFiles(vault),before); assert.deepEqual(await dbMod.getConversation(conv.id),conv);
    assert.equal(await held(vault),1);
    vault.beforeClose = undefined; vault.onRead = undefined;
    if (phase === "final-partial") assert.equal(await held(vault),1,"persisted partial JSON stays unconfirmed after restart");
    else {
      // After a killed UI, a complete verified snapshot can be re-read; a temp is never enough.
      await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
      assert.equal(await held(vault),0);
    }
  });
}

test("Review: final complete before UI kill is safely reused after fresh verification", async () => {
  const { vault } = await reviewFixture("after-final");
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  const entries = finalArchivePaths(vault); const writes = vault.writeCount;
  assert.equal(await held(vault),0);
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  assert.deepEqual(finalArchivePaths(vault),entries); assert.equal(vault.writeCount,writes);
});

test("Review: forced archive ID collision never truncates an existing final or temp", async t => {
  const { vault, file, raw } = await reviewFixture("collision");
  t.mock.method(Date, "now", () => 1000);
  t.mock.method(globalThis.crypto,"randomUUID", () => "00000000-0000-4000-8000-000000000000");
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  const archived = [...vault.files].filter(([p])=>p.includes("recovery-archive")).map(([p,f])=>[p,f.content]);
  vault.put(file, raw.replace("unique Vault original","second unique version"));
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.failed,1); assert.equal(result.archived,0);
  assert.deepEqual([...vault.files].filter(([p])=>p.includes("recovery-archive")).map(([p,f])=>[p,f.content]),archived);
  assert.equal(await held(vault),1);
});

for (const fault of ["identity-missing","identity-different","identity-unreadable","canonical-unreadable","archive-read-error","archive-schema","archive-valid-json-corruption","hash-failure"]) {
  test(`Review fail closed: ${fault}`, async t => {
    const { vault, conv } = await reviewFixture(fault);
    await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)); assert.equal(await held(vault),0);
    const archivePath = finalArchivePaths(vault)[0];
    if(fault === "identity-missing") vault.delete(".tsumugi/vault-identity.json");
    if(fault === "identity-different") vault.put(".tsumugi/vault-identity.json",JSON.stringify({vaultId:"other"}));
    if(fault === "identity-unreadable") vault.onRead=(p,text)=>{if(p.endsWith("vault-identity.json"))throw new DOMException("denied","SecurityError");return text;};
    if(fault === "archive-read-error") vault.onRead=(p,text)=>{if(p===archivePath)throw new DOMException("I/O","NotFoundError");return text;};
    if(fault === "canonical-unreadable") t.mock.method(dbMod,"getConversation",async()=>{throw new Error("IDB unavailable");});
    if(fault === "hash-failure") t.mock.method(vaultMod,"hashVaultText",()=>{throw new Error("hash unavailable");});
    if(fault === "archive-schema" || fault === "archive-valid-json-corruption") {
      const entry = JSON.parse(vault.get(archivePath)!);
      if(fault === "archive-schema") entry.version=99;
      else entry.rawFileContents[entry.vaultPaths[0]]="lost original, old hash retained";
      vault.put(archivePath,JSON.stringify(entry));
    }
    assert.equal(await held(vault),1);
    assert.ok(await dbMod.getAllConversations().then(cs=>cs.some(c=>c.id===conv.id)));
  });
}

test("Review: moving a conflict path keeps classification/reasons but must invalidate archive", async () => {
  const {vault,file,raw,conv}=await reviewFixture("move-same-classification");
  const before=(await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root())).records.find(r=>r.recordId===conv.id)!;
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));assert.equal(await held(vault),0);
  vault.delete(file);vault.put("Moved/conflict.md",raw);
  const after=(await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root())).records.find(r=>r.recordId===conv.id)!;
  assert.equal(after.classification,before.classification);assert.deepEqual(after.reasons,before.reasons);
  assert.equal(await held(vault),1);
});

test("Review: canonical snapshot includes fields omitted by Markdown and re-evaluates them", async () => {
  const {vault,conv}=await reviewFixture("canonical-full");
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  const entry=(await archiveMod.listRecoveryArchiveEntries(vault.root()))[0];
  assert.deepEqual(JSON.parse(entry.canonicalRaw),conv);
  await dbMod.putConversation({...conv,memoryObjectIds:["changed-canonical-link"]});
  assert.equal(await held(vault),1);
});

test("Review: ZIP includes lossless archive; missing or unreadable archive does not destroy normal export",async()=>{
  const {vault}=await reviewFixture("export");
  const {createZipBlob}=require(path.join(OUT,"lib/zip.js")) as typeof import("./zip");
  const unzip = async (files: {path:string;content:string}[]) => {
    const bytes=Buffer.from(await createZipBlob(files).arrayBuffer());const entries=new Map<string,string>();let offset=0;
    while(bytes.readUInt32LE(offset)===0x04034b50){
      const size=bytes.readUInt32LE(offset+18),nameLength=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
      const name=bytes.subarray(offset+30,offset+30+nameLength).toString();const data=offset+30+nameLength+extra;
      entries.set(name,bytes.subarray(data,data+size).toString());offset=data+size;
    }return entries;
  };
  const normal={path:"Conversations/normal.md",content:"normal preserved"};
  assert.equal((await unzip([normal,...await archiveMod.collectRecoveryArchiveFiles(vault.root())])).get(normal.path),normal.content);
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  const collected=await archiveMod.collectRecoveryArchiveFiles(vault.root());const zip=await unzip([normal,...collected]);
  const raw=vault.get(finalArchivePaths(vault)[0])!;
  assert.ok([...zip.values()].includes(raw));assert.deepEqual(JSON.parse(raw).rawFileContents,(await archiveMod.listRecoveryArchiveEntries(vault.root()))[0].rawFileContents);
  vault.failEnumeration=true;
  const partial=await unzip([normal,...await archiveMod.collectRecoveryArchiveFiles(vault.root())]);
  assert.equal(partial.get(normal.path),normal.content);assert.ok(partial.has("recovery-archive/EXPORT_ERRORS.txt"));
});

test("Review: Safari without createWritable uses existing Worker writer only for archive paths",async()=>{
  const {vault,conv}=await reviewFixture("safari-worker");
  const writer = require(path.join(OUT,"lib/vaultWriter.js")) as typeof import("./vaultWriter");
  const paths = new WeakMap<FileSystemFileHandle,string[]>();const workerWrites:string[]=[];
  const wrap = (dir:FileSystemDirectoryHandle, prefix:string[]):FileSystemDirectoryHandle => new Proxy(dir,{
    get(target,key){
      if(key==="getDirectoryHandle")return async(name:string,options?:FileSystemGetDirectoryOptions)=>wrap(await target.getDirectoryHandle(name,options),[...prefix,name]);
      if(key==="getFileHandle")return async(name:string,options?:FileSystemGetFileOptions)=>{
        const p=[...prefix,name];if(options?.create && !vault.files.has(p.join("/")))vault.put(p.join("/"),"");
        const original=await target.getFileHandle(name,options);
        const file=new Proxy(original,{get(f,k){
          if(k==="createWritable")return undefined;
          if(k==="getFile")return async()=>{const data=await f.getFile();const text=await data.text();return {size:new TextEncoder().encode(text).length,lastModified:data.lastModified,text:async()=>text,arrayBuffer:async()=>new TextEncoder().encode(text).buffer};};
          return Reflect.get(f,k);
        }});paths.set(file,p);return file;
      };
      if(key==="resolve")return async(file:FileSystemFileHandle)=>paths.get(file)??null;
      return Reflect.get(target,key);
    }
  });
  const root=wrap(vault.root(),[]);const before=currentFiles(vault);
  writer.__vaultWriterTesting.setRootProvider(async()=>root);
  writer.__vaultWriterTesting.setWorkerFactory(()=>({terminate(){},async call(message){
    assert.equal(message.type,"write");const p=(message.path as string[]).join("/");
    assert.ok(p.startsWith(".tsumugi/recovery-archive/"));workerWrites.push(p);
    vault.put(p,new TextDecoder().decode(message.bytes as Uint8Array));return {ok:true,detail:{}};
  }}));
  try{
    const result=await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup({...makeEnv(vault),root}));
    assert.equal(result.archived,1);assert.equal(workerWrites.length,2);
    assert.deepEqual(currentFiles(vault),before);assert.deepEqual(await dbMod.getConversation(conv.id),conv);
    assert.equal(await held(vault),0);
  }finally{writer.__vaultWriterTesting.reset();}
});

test("Review: production UI retains operation guard until verification, uses actual heldCount, resets world state",()=>{
  const fs=require("node:fs") as typeof import("node:fs");
  const source=fs.readFileSync(path.join(process.cwd(),"src/components/ChatScreen.tsx"),"utf8");
  // 自動startup対応（借り物端末）でcleanup本体は`runLegacyHeldCleanupFlow`へ共通化された
  // （手動buttonと自動startupの両方がこれを呼ぶ。ロジック自体は一切変えていないため、
  // ここで検証する順序性はそのまま`runLegacyHeldCleanupFlow`の本体に対して確認する）。
  const flowBegin=source.indexOf("async function runLegacyHeldCleanupFlow(");
  const flowBody=source.slice(flowBegin,source.indexOf("async function handleRunLegacyHeldCleanup()",flowBegin));
  assert.ok(flowBody.indexOf('await runLegacyHeldCleanup')<flowBody.indexOf('planRecoveryApplyExcludingArchived'));
  assert.ok(flowBody.indexOf('planRecoveryApplyExcludingArchived')<flowBody.indexOf('kind: "done"'));
  assert.ok(flowBody.indexOf('finalHeldCount: applyPlan.heldCount')<flowBody.indexOf('endTask()'));
  assert.ok(flowBody.includes('verifying\n        ? { kind: "verify-failed" }'));
  assert.ok(flowBody.includes('generation !== vaultGenerationRef.current'));
  // 手動button（`handleRunLegacyHeldCleanup`）は、`vaultOperationLockRef`の取得・解放を
  // `runLegacyHeldCleanupFlow`の呼び出しの前後に維持したまま委譲する。
  const handlerBegin=source.indexOf("async function handleRunLegacyHeldCleanup()");
  const handlerBody=source.slice(handlerBegin,source.indexOf("async function handleExecuteRecoveryApply()",handlerBegin));
  assert.ok(handlerBody.indexOf('vaultOperationLockRef.current = true')<handlerBody.indexOf('await runLegacyHeldCleanupFlow'));
  assert.ok(handlerBody.indexOf('await runLegacyHeldCleanupFlow')<handlerBody.indexOf('vaultOperationLockRef.current = false'));
  const reset=source.slice(source.indexOf('function resetMemoryWorldState()'),source.indexOf('function resetMemoryWorldState()')+3500);
  assert.ok(reset.includes('setLegacyHeldCleanupStatus({ kind: "idle" })'));
});

test("Review: same timestamp archives preserve all versions and reuse matching state",async()=>{
  const {vault,file,raw}=await reviewFixture("same-timestamp");
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  vault.put(file,raw.replace("unique Vault original","new state"));
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  const writes=vault.writeCount;const archivePaths=finalArchivePaths(vault);
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  assert.equal(vault.writeCount,writes);assert.equal(archivePaths.length,2);assert.equal(await held(vault),0);
  vault.put(file,raw);assert.equal(await held(vault),0);
});

const archiveDebug = require(path.join(OUT, "lib/vaultRecoveryArchiveDebug.js")) as typeof import("./vaultRecoveryArchiveDebug");
async function batchFixture() {
  await resetAll();
  const vault = new FakeVault(); seedVaultIdentity(vault); await dbMod.putVaultIdentityRecord(identity());
  for (let i = 0; i < 13; i++) {
    const c = conversation(`batch-${i.toString().padStart(2, "0")}`);
    await dbMod.putConversation(c);
    vault.put(`Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`, markdownMod.conversationToMarkdown({ ...c, turns: [{ role: "user", content: "legacy unique original", timestamp: T }] }));
  }
  return vault;
}

test("iPhone A/C/D/J: 13 records, frozen clock, no archive self-interference or current data writes", async t => {
  const vault = await batchFixture();
  const before = currentFiles(vault), local = await dbMod.getAllConversations();
  t.mock.method(Date, "now", () => 123456789);
  assert.equal(await held(vault), 13);
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 13); assert.equal(result.failed, 0); assert.equal(await held(vault), 0);
  assert.equal(finalArchivePaths(vault).length, 13);
  assert.equal(new Set(vault.writes).size, 26);
  assert.deepEqual(currentFiles(vault), before); assert.deepEqual(await dbMod.getAllConversations(), local);
});

test("iPhone B/I: 13 Memory records share whole raw day-file including Vault-only member and unknown fields", async () => {
  await resetAll(); const vault = new FakeVault(); seedVaultIdentity(vault); await dbMod.putVaultIdentityRecord(identity());
  const originals: MemoryObject[] = [];
  for (let i = 0; i < 13; i++) {
    const m = memory(`shared-${i}`, "2026-10-10"); await dbMod.putMemoryObject(m);
    originals.push({ ...m, content: `legacy unique ${i}` });
  }
  originals.push(memory("vault-only-unique", "2026-10-10"));
  const raw = originals.map(m => markdownMod.memoryObjectToMarkdown(m).replace("---\n", "---\nunknownLegacyField: keep-me\n")).join("\n<!-- tsumugi:entry -->\n\n");
  const file = `Memories/${vaultMod.dayFileNameFor(T)}`; vault.put(file, raw);
  const before = currentFiles(vault), local = await dbMod.getAllMemoryObjects();
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 13);
  for (const e of await archiveMod.listRecoveryArchiveEntries(vault.root())) assert.equal(e.rawFileContents[file], raw);
  assert.deepEqual(currentFiles(vault), before); assert.deepEqual(await dbMod.getAllMemoryObjects(), local);
  const filtered = await cleanupMod.excludeArchivedFromRecoveryPlan(makeEnv(vault), await cleanupMod.readCurrentRecoveryPlanForCleanup(vault.root()));
  assert.equal(filtered.records.filter(r => r.indexedDBExists).length, 0);
});

test("iPhone E: five successful archives then persistent temp failure; retry reuses five originals", async () => {
  const vault = await batchFixture();
  vault.beforeClose = () => { if (finalArchivePaths(vault).length >= 5) throw new DOMException("write denied", "NotAllowedError"); };
  const first = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(first.archived, 5); assert.equal(first.failed, 8); assert.equal(await held(vault), 8);
  const saved = new Map(finalArchivePaths(vault).map(p => [p, vault.get(p)]));
  const oldWrites = vault.writeCount; vault.beforeClose = undefined;
  const second = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(second.archived, 13); assert.equal(vault.writeCount - oldWrites, 16);
  for (const [p, raw] of saved) assert.equal(vault.get(p), raw);
  assert.equal(finalArchivePaths(vault).length, 13); assert.equal(await held(vault), 0);
});

test("iPhone F/G: external current-data change during archive is not excluded by fresh diagnosis", async () => {
  const { vault, file, raw } = await reviewFixture("external-during-archive");
  const changed = raw.replace("unique Vault original", "externally changed unique original");
  vault.beforeClose = p => { if (!p.includes("/.tmp-")) vault.put(file, changed); };
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  assert.equal(await held(vault), 1); assert.equal(vault.get(file), changed);
  assert.equal((await archiveMod.listRecoveryArchiveEntries(vault.root()))[0].rawFileContents[file], raw);
});

for (const kind of ["canonical-missing", "missing", "different", "read-error", "parse-error"] as const) {
  test(`iPhone pre-loop failure diagnostics: identity ${kind}, zero archive writes`, async () => {
    const vault = await batchFixture(); const env = makeEnv(vault);
    if (kind === "canonical-missing") env.vaultIdentity = null;
    if (kind === "missing") vault.delete(".tsumugi/vault-identity.json");
    if (kind === "different") vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "different" }));
    if (kind === "read-error") vault.onRead = (p, text) => { if (p.endsWith("vault-identity.json")) throw new DOMException("provider read failed", "NotFoundError"); return text; };
    if (kind === "parse-error") vault.put(".tsumugi/vault-identity.json", '{"privateContent":"never-log-this"');
    archiveDebug.clearRecoveryArchiveDiagnostics();
    await assert.rejects(cleanupMod.runLegacyHeldCleanup(env), /vault-identity-unconfirmed/);
    assert.equal(vault.writeCount, 0); assert.equal(await held(vault), 13);
    const logs = archiveDebug.getRecoveryArchiveDiagnostics();
    const reasons = { "canonical-missing": "canonical-identity-missing", missing: "vault-identity-missing", different: "world-identity-mismatch", "read-error": "vault-identity-read-error", "parse-error": "vault-identity-parse-error" };
    assert.ok(logs.some(e => e.reason === reasons[kind]));
    assert.ok(!JSON.stringify(logs).includes("never-log-this"));
  });
}

test("iPhone H: write diagnostic retains filesystem stage/error without raw Memory contents", async () => {
  const { vault } = await reviewFixture("write-diagnostic"); archiveDebug.clearRecoveryArchiveDiagnostics();
  vault.beforeClose = () => { throw new DOMException("provider write denied", "NotAllowedError"); };
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.failed, 1); assert.equal(await held(vault), 1);
  const logs = archiveDebug.getRecoveryArchiveDiagnostics();
  assert.ok(logs.some(e => e.stage === "temp-write" && e.errorName === "NotAllowedError" && e.archivePath?.includes("/.tmp-")));
  assert.ok(!JSON.stringify(logs).includes("unique Vault original"));
});


test("iPhone read-only diagnosis exposes missing identity without another cleanup attempt", async () => {
  const vault = await batchFixture(); vault.delete(".tsumugi/vault-identity.json");
  archiveDebug.clearRecoveryArchiveDiagnostics();
  const plan = await cleanupMod.planRecoveryApplyExcludingArchived(applyEnvFor(vault));
  assert.equal(plan.heldCount, 13); assert.equal(vault.writeCount, 0);
  assert.ok(archiveDebug.getRecoveryArchiveDiagnostics().some(e => e.reason === "vault-identity-missing"));
});

test("Diagnostics: healthy identity is visible and read-only diagnosis does not create archives or alter canonical", async () => {
  const vault = await batchFixture();
  const files = [...vault.files].map(([p, f]) => [p, f.content, f.mtime]);
  const local = await dbMod.getAllConversations();
  archiveDebug.clearRecoveryArchiveDiagnostics();
  const plan = await cleanupMod.planRecoveryApplyExcludingArchived(applyEnvFor(vault));
  const logs = archiveDebug.getRecoveryArchiveDiagnostics();
  const id = logs.find(e => e.identityStatus === "matched");
  assert.ok(id); assert.equal(id.expectedWorldIdentity, id.actualWorldIdentity);
  assert.notEqual(id.expectedWorldIdentity, VAULT_ID);
  assert.ok(logs.some(e => e.stage === "diagnosis-complete"));
  assert.equal(plan.heldCount, 13); assert.equal(vault.writeCount, 0);
  assert.deepEqual([...vault.files].map(([p, f]) => [p, f.content, f.mtime]), files);
  assert.deepEqual(await dbMod.getAllConversations(), local);
});

test("Diagnostics: observation failure must not short-circuit existing warning exclusion", async () => {
  const { vault } = await reviewFixture("observation-not-a-gate");
  await cleanupMod.runLegacyHeldCleanup(makeEnv(vault));
  let reads = 0;
  vault.onRead = (p, text) => {
    // The preflight is inconclusive, but existing exclusion can independently
    // verify the same identity on its own fresh read. Preserve that decision.
    if (p.endsWith("vault-identity.json") && ++reads === 1) throw new DOMException("transient", "SecurityError");
    return text;
  };
  assert.equal((await cleanupMod.planRecoveryApplyExcludingArchived(applyEnvFor(vault))).heldCount, 0);
  assert.ok(reads >= 2);
});

test("Diagnostics: error/reason/extra-field payloads never expose body or secrets", () => {
  archiveDebug.clearRecoveryArchiveDiagnostics();
  const secret = 'private body and API_KEY=secret-123';
  for (const error of [new Error(secret), new TypeError(secret), new SyntaxError(secret), new DOMException(secret, "SecurityError"), secret]) {
    archiveDebug.logRecoveryArchiveDiagnostic({ stage: "privacy-test", reason: secret,
      expectedWorldIdentity: secret, actualWorldIdentity: secret,
      ...({ canonicalRaw: secret, rawFileContents: secret, errorMessage: secret } as Record<string, string>),
    }, error);
  }
  const logs = archiveDebug.getRecoveryArchiveDiagnostics();
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.ok(!JSON.stringify(logs).includes("canonicalRaw"));
  assert.ok(logs.every(e => e.reason === "unrecognized-reason"));
  assert.ok(logs.every(e => e.expectedWorldIdentity === e.actualWorldIdentity));
  for (let i = 0; i < 310; i++) archiveDebug.logRecoveryArchiveDiagnostic({ stage: "bounded" });
  assert.equal(archiveDebug.getRecoveryArchiveDiagnostics().length, 300);
});

test("Diagnostics: copy UI is debug-only and does not run cleanup", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const source = fs.readFileSync(path.join(process.cwd(), "src/components/DebugTimingPanel.tsx"), "utf8");
  assert.ok(source.includes('get("debugLog") === "1"'));
  assert.ok(source.indexOf('if (!enabled) return null') < source.indexOf('Recovery Archive Debugをコピー'));
  assert.ok(source.includes('navigator.clipboard.writeText(JSON.stringify(getRecoveryArchiveDiagnostics(), null, 2))'));
  assert.ok(!source.includes('runLegacyHeldCleanup'));
});

// ===========================================================================
// Automatic startup cleanup（借り物端末対応）：「古い記録を整理する」をユーザー操作
// 無しで起動のたびに自動的に試みるようChatScreen.tsxへ配線した（`runLegacyHeldCleanupFlow`、
// 中身は`runLegacyHeldCleanup`/`planRecoveryApplyExcludingArchived`をそのまま呼ぶだけ）。
// ここではその配線が前提とする、下記の性質をもう一度明示的に確認する：
// - 事前の「確認する」（dry-run）無しでいきなり呼んでも安全に完結すること
// - 2回連続で呼んでも（＝2回起動相当）二重archiveしないこと
// - 1回目が書き込み途中で中断しても、2回目（＝次回起動相当）が安全に再開し、
//   既存canonical data・既存Archiveを一切壊さないこと
// 実際のarchive/cleanupロジック自体（identity確認・temp→final write・read-back検証等）は
// 上記の既存testがすでに広く確認済みであり、ここでは変更していない。
// ===========================================================================

test("iPhone K: automatic startup（事前のdry-runなし）だけでsafeなlegacy batchが解消し、Recovery warningが再表示されない", async () => {
  const vault = await batchFixture();
  assert.equal(await held(vault), 13, "起動前：13件がwarning対象");
  // 「確認する」（dry-run）を一度も呼ばずに、起動時の自動実行が呼ぶのと全く同じ関数を直接呼ぶ。
  const result = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(result.archived, 13); assert.equal(result.failed, 0);
  assert.equal(await held(vault), 0, "1回目の自動実行だけでwarningが解消する");
  // warningが「解消されたまま」であること（再度diagnosticを読んでも再表示されない）。
  assert.equal(await held(vault), 0, "再度確認してもwarningは再表示されない");
});

test("iPhone L: 2回連続のautomatic startup（2回起動相当）でも二重archiveしない", async () => {
  const vault = await batchFixture();
  const first = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(first.archived, 13);
  const archivesAfterFirst = finalArchivePaths(vault).slice().sort();
  const writesAfterFirst = vault.writeCount;
  // 2回目の起動（同じ関数を、同じ安全条件のまま、もう一度最初から呼ぶだけ）。held判定とは
  // 独立に、runLegacyHeldCleanup自身は今回もconflict等の13件を再診断・再処理する——
  // ただしそれぞれ`matchingArchive`が既存archiveを見つけるため、1byteも新規に書き込まず、
  // 結果はarchived13件・failed0件のまま「安定」する（これが二重archiveしないことの意味）。
  const second = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(second.archived, 13); assert.equal(second.failed, 0);
  assert.equal(vault.writeCount, writesAfterFirst, "2回目は1byteも書き込まない");
  assert.deepEqual(finalArchivePaths(vault).slice().sort(), archivesAfterFirst, "archiveは重複作成されない（既存archiveIdをそのまま再利用する）");
  for (const { recordId, result } of second.details) {
    assert.equal(result.outcome, "archived", `record ${recordId} should reuse the existing verified archive`);
  }
  assert.equal(await held(vault), 0, "warningは2回目以降も再表示されない");
});

test("iPhone M: 1回目のautomatic startupがarchive書き込み途中で中断しても、2回目（次回起動相当）が安全に再開し、canonical data・既存Archiveを失わない", async () => {
  const vault = await batchFixture();
  const local = await dbMod.getAllConversations();
  const before = currentFiles(vault);
  // 1回目：5件archiveした時点で中断（iPhone Eと同じ障害注入。ここでは「次回起動での
  // 自動再開」という文脈を明示するために独立したtestとして持つ）。
  vault.beforeClose = () => { if (finalArchivePaths(vault).length >= 5) throw new DOMException("app closed mid-write", "NotAllowedError"); };
  const first = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(first.archived, 5); assert.equal(first.failed, 8);
  assert.equal(await held(vault), 8, "中断後も8件はwarning対象のまま（データは失われていない）");
  const archivedAfterFirst = new Map(finalArchivePaths(vault).map((p) => [p, vault.get(p)]));
  // アプリが閉じて再度開かれた想定：中断要因を取り除き、次回起動の自動実行として
  // もう一度同じ関数を呼ぶ（特別な「再開」フラグ等は無く、runLegacyHeldCleanupは
  // 常に実体を再確認してから進む）。
  vault.beforeClose = undefined;
  const second = await assertResultIsSummary(await cleanupMod.runLegacyHeldCleanup(makeEnv(vault)));
  assert.equal(second.archived, 13, "残り8件も含めて全件archiveされる");
  assert.equal(await held(vault), 0, "次回起動でwarningが解消する");
  for (const [p, raw] of archivedAfterFirst) assert.equal(vault.get(p), raw, "1回目で確定したarchiveは書き換わらない");
  assert.equal(finalArchivePaths(vault).length, 13);
  // 現在のVault・canonical dataは中断・再開を通じて一切変更されていない。
  assert.deepEqual(currentFiles(vault), before);
  assert.deepEqual(await dbMod.getAllConversations(), local);
});

test("iPhone N: identity不一致のVaultでは自動startupを2回試みても何も書き込まず、warningは解消されない（安全側）", async () => {
  const vault = await batchFixture();
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "different-vault" }));
  for (let i = 0; i < 2; i++) {
    await assert.rejects(cleanupMod.runLegacyHeldCleanup(makeEnv(vault)), /vault-identity-unconfirmed/);
  }
  assert.equal(vault.writeCount, 0, "identity不一致の間は1byteも書き込まない");
  assert.equal(await held(vault), 13, "安全に確認できない間はwarningを消さない（偽の解消をしない）");
});

test("ChatScreen.tsx: automatic startup cleanupは手動buttonと同じ実装を呼び、Debugフラグに依存しない", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const source = fs.readFileSync(path.join(process.cwd(), "src/components/ChatScreen.tsx"), "utf8");
  assert.ok(source.includes("startupLegacyHeldCleanupRanRef"), "起動時に1回だけ実行するガードが存在する");
  assert.ok(source.includes("runLegacyHeldCleanupFlow"), "手動buttonと共通の実装を使っている");
  // 自動実行のeffect自体の定義ブロックを抜き出し、その中にdebugLog依存が無いことを確認する
  // （借り物端末では`?debugLog=1`を開かせない、という絶対条件の直接的な裏付け）。
  const guardIndex = source.indexOf("startupLegacyHeldCleanupRanRef.current) return;");
  assert.ok(guardIndex > 0);
  const effectBlock = source.slice(guardIndex, source.indexOf("}, [vaultStatus, vaultHandle]);", guardIndex));
  assert.ok(!effectBlock.includes("debugLog"), "自動cleanupはdebugLogフラグに一切依存しない");
});
