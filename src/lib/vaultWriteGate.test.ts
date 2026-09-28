/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias */
/**
 * H1（write gateの抜け）の回帰テスト。
 *
 * 対象は、通常の書き込みキュー（`enqueueVaultWrite`、`vault.ts`内部）を経由しない直接write経路
 * （`ensureVaultSkeleton`／`executeLegacyCleanup`／`executeOrphanCleanup`）と、自前で排他ロックを
 * 取得する経路（`resyncVaultRegistry`）における、未完了Recovery journalのgate確認。
 *
 * 実行方法：`npm run test:write-gate`（`tsc -p tsconfig.write-gate.json && node --test .test-out/lib/vaultWriteGate.test.js`）。
 * 実IndexedDB・実OPFSは使わない。`./db`をModule._loadで差し替え、Recovery journalの読み書きだけを
 * インメモリで機能させる（他のdb.ts関数は、この回帰テストの対象経路からは呼ばれないため、無害な
 * スタブのままでよい）。
 *
 * 「gateが実際に効いたか」は、書き込み先（`root`）へのアクセスをProxyで検知する方式で確認する：
 * gateがVault I/Oより前に働けば、Proxyのどのtrapにも一切触れないまま拒否されるはずで、もし
 * gateが抜けていれば、Proxyのtrapが発火して「意図しない別のエラー」になる（gateの抜けを直接検出できる）。
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

// ---------------------------------------------------------------------------
// `./db`の差し替え（vault.ts・vaultWorldLock.ts・vaultLegacyCleanup.ts・vaultOrphanCleanup.ts・
// vaultRecoveryJournal.tsが必要とする名前をすべて用意する。Recovery journalの読み書きだけ実機能、
// 他はこのテストの対象経路からは呼ばれないため無害なスタブ）。
// ---------------------------------------------------------------------------

let journalRaw: string | undefined;
const activeEpoch = 0;
const noop = async () => undefined;
const dbStub = {
  readRecoveryJournalRaw: async () => journalRaw,
  writeRecoveryJournalRaw: async (text: string) => { journalRaw = text; },
  getActiveVaultEpoch: async () => activeEpoch,
  getCommittedVaultEpoch: async () => ({ status: "valid" as const, epoch: activeEpoch }),
  getVaultWorldJournalVersion: async () => ({ status: "current" as const }),
  getRegistryGenerationEpoch: async () => 0,
  bumpActiveVaultEpoch: noop,
  markVaultEpochCommitted: noop,
  markVaultWorldJournalMigrated: noop,
  bumpRegistryGenerationEpoch: noop,
  getAllConversations: async () => [],
  getAllMemoryObjects: async () => [],
  getAllSources: async () => [],
  getConversation: async () => undefined,
  getMemoryObject: async () => undefined,
  getSource: async () => undefined,
  getVaultSyncState: async () => undefined,
  hasAnyVaultSyncState: async () => false,
  isAndroidOpfsVaultInitialized: async () => true,
  loadVaultHandle: async () => undefined,
  markAndroidOpfsVaultInitialized: noop,
  putConversationAndMarkSynced: noop,
  putMemoryObjectAndMarkSynced: noop,
  saveSourceAndMarkSynced: noop,
  setVaultSyncState: noop,
  addConversationIfAbsentAndMarkSynced: async () => false,
  addMemoryObjectIfAbsentAndMarkSynced: async () => false,
  addSourceIfAbsentAndMarkSynced: async () => false,
};

const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "./db" && parent?.filename?.startsWith(OUT)) return dbStub;
  return origLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// 実FIFO排他ロックのfake navigator.locks（lock race検証専用。単一ロック名のみ想定で十分）。
// ---------------------------------------------------------------------------

class FakeLockManager {
  private tail: Promise<void> = Promise.resolve();
  async request<T>(_name: string, optionsOrCb: unknown, maybeCb?: (lock: { name: string }) => Promise<T>): Promise<T> {
    const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as (lock: { name: string } | null) => Promise<T>;
    const options = typeof optionsOrCb === "function" ? {} : (optionsOrCb as { signal?: AbortSignal; ifAvailable?: boolean });
    const myTurn = this.tail;
    let release!: () => void;
    this.tail = new Promise((resolve) => { release = resolve; });
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
      return await cb({ name: _name });
    } finally {
      release();
    }
  }
}

// Node 22はグローバルに読み取り専用の`navigator`を既に持つため、definePropertyで上書きする。
Object.defineProperty(globalThis, "navigator", { value: { locks: new FakeLockManager() }, configurable: true, writable: true });

// ---------------------------------------------------------------------------
// Proxy root：どのtrapに触れても即座に失敗する（「gateがI/Oより前に働いたか」の検出専用）。
// ---------------------------------------------------------------------------

function untouchableRoot(): FileSystemDirectoryHandle {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`UNEXPECTED VAULT ACCESS: root.${String(prop)} was touched — the write gate did not run before I/O`);
      },
    }
  ) as unknown as FileSystemDirectoryHandle;
}

// ---------------------------------------------------------------------------
// 実際に書き込める最小限のfake root（「journalなしなら従来どおり書ける」ことの確認用）。
// ---------------------------------------------------------------------------

class WritableFake {
  files = new Map<string, string>();
  root(): FileSystemDirectoryHandle {
    return this.dir("");
  }
  private dir(prefix: string): FileSystemDirectoryHandle {
    const self = this;
    return {
      kind: "directory",
      async getDirectoryHandle(name: string) {
        return self.dir(prefix ? `${prefix}/${name}` : name);
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
        if (!self.files.has(p)) throw new DOMException("no such file", "NotFoundError");
        const text = self.files.get(p)!;
        return { size: text.length, async text() { return text; } } as unknown as File;
      },
      async createWritable() {
        let pending = "";
        return {
          async write(c: string) { pending = c; },
          async close() { self.files.set(p, pending); },
        };
      },
    } as unknown as FileSystemFileHandle;
  }
}

// ---------------------------------------------------------------------------
// 対象モジュール
// ---------------------------------------------------------------------------

const vaultMod = require(path.join(OUT, "lib/vault.js")) as typeof import("./vault");
const legacyMod = require(path.join(OUT, "lib/vaultLegacyCleanup.js")) as typeof import("./vaultLegacyCleanup");
const orphanMod = require(path.join(OUT, "lib/vaultOrphanCleanup.js")) as typeof import("./vaultOrphanCleanup");
const journalMod = require(path.join(OUT, "lib/vaultRecoveryJournal.js")) as typeof import("./vaultRecoveryJournal");
const worldLockMod = require(path.join(OUT, "lib/vaultWorldLock.js")) as typeof import("./vaultWorldLock");
// runVaultWorldExclusive自身のepoch整合性チェック（H4、このテストの対象外）を通過させるため、
// このタブが今のactiveVaultEpochを把握済みという前提を満たしておく。
worldLockMod.setTabVaultEpoch(activeEpoch);

async function setPendingJournal() {
  const journal = {
    version: 1, operationId: "op-1", status: "in-progress", createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z",
    world: { activeVaultEpoch: activeEpoch, committedVaultEpoch: activeEpoch, registryGenerationEpoch: 0, journalVersion: "current", backend: "opfs" },
    baselineAtStart: { status: "not-found", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false,
  };
  journalRaw = JSON.stringify(journal);
}
function clearJournal() {
  journalRaw = undefined;
}

test("H1: 未完了Recovery journalがある間、ensureVaultSkeletonはVaultへ一切触れず書き込みなしで戻る", async () => {
  await setPendingJournal();
  await assert.doesNotReject(vaultMod.ensureVaultSkeleton(untouchableRoot()));
  clearJournal();
});

test("H1: 未完了Recovery journalがある間、executeLegacyCleanupはVaultへ一切触れずに拒否される", async () => {
  await setPendingJournal();
  await assert.rejects(legacyMod.executeLegacyCleanup(untouchableRoot()), journalMod.VaultRecoveryPendingError);
  clearJournal();
});

test("H1: 未完了Recovery journalがある間、executeOrphanCleanupはVaultへ一切触れずに拒否される", async () => {
  await setPendingJournal();
  await assert.rejects(orphanMod.executeOrphanCleanup(untouchableRoot(), ["conversation:x"]), journalMod.VaultRecoveryPendingError);
  clearJournal();
});

test("H1: journalが存在しない通常状態では、ensureVaultSkeletonは従来どおり骨組みを書く", async () => {
  clearJournal();
  const fake = new WritableFake();
  await vaultMod.ensureVaultSkeleton(fake.root());
  assert.ok(fake.files.has(".tsumugi/schema-version.json"));
  assert.ok(fake.files.has(".tsumugi/index.json"));
});

test("H1 lock race: gate確認をexclusive lock取得前だけで行わず、lock取得直後にも再確認する（取得待ち中に別タブがRecoveryを開始した場合に備える）", async () => {
  clearJournal();
  const locks = (globalThis as unknown as { navigator: { locks: FakeLockManager } }).navigator.locks;
  let releaseHolder!: () => void;
  const holderReleased = new Promise<void>((resolve) => { releaseHolder = resolve; });
  // 1つ目：先にロックを取得し、しばらく保持し続ける（resyncVaultRegistry呼び出し時点ではjournalはまだ無い）。
  const holderDone = locks.request("tsumugi-vault-world", { mode: "exclusive" as const }, async () => {
    await holderReleased;
  });
  // わずかに待ち、確実に1つ目がロックを握った状態にする。
  await new Promise((r) => setTimeout(r, 10));
  // 2つ目：resyncVaultRegistry。1つ目のロック解放を待つ間にRecoveryが開始する、という状況を模す。
  const resyncPromise = vaultMod.resyncVaultRegistry(untouchableRoot());
  await new Promise((r) => setTimeout(r, 10));
  await setPendingJournal(); // ロック待ち中にRecoveryが開始した
  releaseHolder();
  await holderDone;
  await assert.rejects(resyncPromise, journalMod.VaultRecoveryPendingError, "lock取得前の確認だけに頼っていれば、ここで誤って続行してしまう");
  clearJournal();
});
