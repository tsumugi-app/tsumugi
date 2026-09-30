/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Bootstrap ↔ Recovery ↔ legacy writer の排他性の回帰テスト（Recovery最終整理フェーズ、lock order）。
 *
 * `./db`を丸ごと差し替える方式（`vaultWriteGate.test.ts`と同じ）のため、他のsave-foundation
 * テストと同じプロセスでは実行しない（`./db`への丸ごと差し替えは、その他のファイルが必要とする
 * 実`db.js`の関数群と衝突するため）。単独の`tsconfig.lock-order.json`／`npm run test:lock-order`で実行する。
 *
 * 【実際の本番の対応関係】
 * - Bootstrap：ChatScreen.tsxの起動effectが`withVaultWorldRead(() => runProductionBootstrapOnce(vaultHandle))`
 *   でくるむ（`src/components/ChatScreen.tsx`、コミット済み）。本ファイルではこの実際のwrap方法を
 *   `withVaultWorldRead`直接呼び出しで模す。
 * - legacy writer（通常の会話・記憶保存）：`capture.ts`/`source.ts`の`persistConversation`/
 *   `persistCapture`/`persistSource`が同じく`withVaultWorldRead`でくるむ。
 * - Recovery apply／legacy cleanup／orphan cleanup／append-local／このRecovery最終整理フェーズの
 *   `runLegacyHeldCleanup`は、いずれも`runVaultWorldExclusive`（排他モード）を取得する
 *   （`runLegacyHeldCleanup`自身がこれを取得することの確認は、実`db.js`を使う
 *   `vaultRecoveryLegacyCleanup.test.ts`側に置く）。
 * 全て同じロック名（"tsumugi-vault-world"、`vaultWorldLock.ts`）を使うため、Web Locks APIの
 * shared/exclusiveの仕様どおりに、shared同士は共存できてもexclusiveとは共存できない。
 *
 * 実行方法：`npm run test:lock-order`。
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
// `./db`の差し替え（`vaultWorldLock.ts`が必要とするepoch関連の最小限のみ実機能）。
// ---------------------------------------------------------------------------

const activeEpoch = 0;
const noop = async () => undefined;
const dbStub = {
  getActiveVaultEpoch: async () => activeEpoch,
  getCommittedVaultEpoch: async () => ({ status: "valid" as const, epoch: activeEpoch }),
  getVaultWorldJournalVersion: async () => ({ status: "current" as const }),
  bumpActiveVaultEpoch: noop,
  markVaultEpochCommitted: noop,
  markVaultWorldJournalMigrated: noop,
};

const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "./db" && parent?.filename?.startsWith(OUT)) return dbStub;
  return origLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// 実FIFO排他ロックのfake navigator.locks（`vaultWriteGate.test.ts`と同じ方式：単一ロック名のみ、
// shared/exclusiveを区別せず完全直列化する——「排他性・デッドロックしないこと」の検証には
// この単純化で十分かつ安全側（実際のWeb Locksより厳しい）。
// ---------------------------------------------------------------------------

class FakeLockManager {
  private tail: Promise<void> = Promise.resolve();
  async request<T>(_name: string, optionsOrCb: unknown, maybeCb?: (lock: { name: string } | null) => Promise<T>): Promise<T> {
    const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as (lock: { name: string } | null) => Promise<T>;
    const options = typeof optionsOrCb === "function" ? {} : (optionsOrCb as { signal?: AbortSignal });
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

Object.defineProperty(globalThis, "navigator", { value: { locks: new FakeLockManager() }, configurable: true, writable: true });

// ---------------------------------------------------------------------------
// 対象モジュール
// ---------------------------------------------------------------------------

const worldLockMod = require(path.join(OUT, "lib/vaultWorldLock.js")) as typeof import("./vaultWorldLock");
worldLockMod.setTabVaultEpoch(activeEpoch);

// ---------------------------------------------------------------------------
// L/M/N/O：実際の`withVaultWorldRead`（Bootstrap・legacy writerが使うshared）と
// `runVaultWorldExclusive`（Recovery apply・legacy cleanup・orphan cleanup・append-local・
// このフェーズの`runLegacyHeldCleanup`が使うexclusive）を直接使い、互いに重ならないこと・
// デッドロックしないこと（＝両方とも最終的に完了すること）を確認する。
// ---------------------------------------------------------------------------

interface Overlap {
  active: Set<string>;
  maxConcurrent: number;
  order: string[];
}

function newOverlap(): Overlap {
  return { active: new Set(), maxConcurrent: 0, order: [] };
}

async function markRun<T>(overlap: Overlap, label: string, durationMs: number, fn: () => Promise<T>): Promise<T> {
  overlap.active.add(label);
  overlap.order.push(`${label}:start`);
  overlap.maxConcurrent = Math.max(overlap.maxConcurrent, overlap.active.size);
  try {
    await new Promise((r) => setTimeout(r, durationMs));
    return await fn();
  } finally {
    overlap.active.delete(label);
    overlap.order.push(`${label}:end`);
  }
}

test("L: Bootstrap実行中（shared world lock）にRecovery（exclusive world lock）を開始しても、同時にVaultへ触れず、両方とも完了する", async () => {
  const overlap = newOverlap();
  const bootstrapDone = worldLockMod.withVaultWorldRead(() => markRun(overlap, "bootstrap", 30, async () => "bootstrap-ok"));
  await new Promise((r) => setTimeout(r, 5)); // Bootstrapが確実にロックを握った状態にする
  const recoveryDone = worldLockMod.runVaultWorldExclusive(() => markRun(overlap, "recovery", 10, async () => "recovery-ok"));
  const [bootstrapResult, recoveryResult] = await Promise.all([bootstrapDone, recoveryDone]);
  assert.equal(bootstrapResult, "bootstrap-ok");
  assert.equal(recoveryResult.timedOut, false);
  assert.equal(recoveryResult.result, "recovery-ok");
  assert.equal(overlap.maxConcurrent, 1, "BootstrapとRecoveryが同時にVaultへ触れていない");
  assert.deepEqual(overlap.order, ["bootstrap:start", "bootstrap:end", "recovery:start", "recovery:end"], "Bootstrapが先に完了してからRecoveryが実行される");
});

test("M: Recovery実行中（exclusive world lock）にBootstrap（shared world lock）を開始しても、同時にVaultへ触れず、両方とも完了する", async () => {
  const overlap = newOverlap();
  const recoveryDone = worldLockMod.runVaultWorldExclusive(() => markRun(overlap, "recovery", 30, async () => "recovery-ok"));
  await new Promise((r) => setTimeout(r, 5));
  const bootstrapDone = worldLockMod.withVaultWorldRead(() => markRun(overlap, "bootstrap", 10, async () => "bootstrap-ok"));
  const [recoveryResult, bootstrapResult] = await Promise.all([recoveryDone, bootstrapDone]);
  assert.equal(recoveryResult.timedOut, false);
  assert.equal(recoveryResult.result, "recovery-ok");
  assert.equal(bootstrapResult, "bootstrap-ok");
  assert.equal(overlap.maxConcurrent, 1, "RecoveryとBootstrapが同時にVaultへ触れていない");
  assert.deepEqual(overlap.order, ["recovery:start", "recovery:end", "bootstrap:start", "bootstrap:end"], "Recoveryが先に完了してからBootstrapが実行される");
});

test("N: legacy writer実行中（shared world lock、persistConversation等と同じ経路）にRecoveryを開始しても、同時にVaultへ触れず、両方とも完了する", async () => {
  const overlap = newOverlap();
  const writerDone = worldLockMod.withVaultWorldRead(() => markRun(overlap, "legacy-writer", 30, async () => "writer-ok"));
  await new Promise((r) => setTimeout(r, 5));
  const recoveryDone = worldLockMod.runVaultWorldExclusive(() => markRun(overlap, "recovery", 10, async () => "recovery-ok"));
  const [writerResult, recoveryResult] = await Promise.all([writerDone, recoveryDone]);
  assert.equal(writerResult, "writer-ok");
  assert.equal(recoveryResult.timedOut, false);
  assert.equal(overlap.maxConcurrent, 1, "legacy writerとRecoveryが同時にVaultへ触れていない");
  assert.deepEqual(overlap.order, ["legacy-writer:start", "legacy-writer:end", "recovery:start", "recovery:end"]);
});

test("O: Recovery実行中にlegacy writerを開始しても、同時にVaultへ触れず、両方とも完了する", async () => {
  const overlap = newOverlap();
  const recoveryDone = worldLockMod.runVaultWorldExclusive(() => markRun(overlap, "recovery", 30, async () => "recovery-ok"));
  await new Promise((r) => setTimeout(r, 5));
  const writerDone = worldLockMod.withVaultWorldRead(() => markRun(overlap, "legacy-writer", 10, async () => "writer-ok"));
  const [recoveryResult, writerResult] = await Promise.all([recoveryDone, writerDone]);
  assert.equal(recoveryResult.timedOut, false);
  assert.equal(writerResult, "writer-ok");
  assert.equal(overlap.maxConcurrent, 1, "Recoveryとlegacy writerが同時にVaultへ触れていない");
  assert.deepEqual(overlap.order, ["recovery:start", "recovery:end", "legacy-writer:start", "legacy-writer:end"]);
});
