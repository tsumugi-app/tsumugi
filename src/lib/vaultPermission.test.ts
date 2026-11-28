/**
 * Issue #71（起動時に「保存先を準備しています…」のまま固着する）の回帰テスト。架空データのみ。
 * 実行：`npm run test:vault-permission`。
 *
 * 実機で確認された停止は2つ：
 *  1. `verifyPermission`（vault.ts）が`handle.queryPermission()`をタイムアウト無しで待ち、
 *     Chrome側のPromiseが返らないと起動が無期限に止まる。
 *  2. queryPermissionが例外を投げると、ChatScreenの起動チェーンにrejectionを受ける
 *     ハンドラが無く、vaultStatusが"checking"のまま確定しない。
 *
 * ここでは (1) を実コード（verifyPermission／restoreVaultHandle）で、(2) を実コードの
 * 起動ロック（withStartupSharedLock）と復元を、ChatScreenのeffectと同じ
 * `.then(成功時, rejection時)` の合成で繋いで検証する（ChatScreen自体はReact
 * コンポーネントで、このリポジトリにはコンポーネントテストの基盤が無いため、
 * 状態の倒し先の式も実コードの`isVaultSupported()`をそのまま使う）。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
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

// File System Accessが使えるデスクトップChrome相当の環境にする
// （getVaultBackend()が"file-system-access"を返すために必要な最小限の形だけ）。
(globalThis as { window?: unknown }).window = {
  showDirectoryPicker: () => {
    throw new Error("showDirectoryPicker must not be called in these tests");
  },
};

const vault = require("./vault") as typeof import("./vault");
const db = require("./db") as typeof import("./db");
const worldLock = require("./vaultWorldLock") as typeof import("./vaultWorldLock");

/** queryPermissionの振る舞いだけを持つ架空の保存先フォルダhandle。 */
function fakeHandle(queryPermission: (options: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>): FileSystemDirectoryHandle {
  return { kind: "directory", name: "fictional-vault", queryPermission } as unknown as FileSystemDirectoryHandle;
}
const grantedHandle = () => fakeHandle(async () => "granted");
const neverResolvingHandle = () => fakeHandle(() => new Promise<PermissionState>(() => {}));
const rejectingHandle = (error: Error) => fakeHandle(async () => { throw error; });

test("QUERY_PERMISSION_TIMEOUT_MSは15000（起動経路の既存フェイルセーフEXCLUSIVE_LOCK_TIMEOUT_MSと同値）", () => {
  assert.equal(vault.QUERY_PERMISSION_TIMEOUT_MS, 15000);
});

test("verifyPermission: grantedならtrue（従来どおり）", async () => {
  assert.equal(await vault.verifyPermission(grantedHandle(), true), true);
  assert.equal(await vault.verifyPermission(grantedHandle(), false), true);
});

test("verifyPermission: prompt／deniedならfalse（従来どおり）", async () => {
  assert.equal(await vault.verifyPermission(fakeHandle(async () => "prompt"), true), false);
  assert.equal(await vault.verifyPermission(fakeHandle(async () => "denied"), true), false);
});

test("verifyPermission: 時間内に応答があればタイムアウトには倒れない", async () => {
  const slow = fakeHandle(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "granted";
  });
  assert.equal(await vault.verifyPermission(slow, true, 1000), true);
});

test("verifyPermission: queryPermissionが永遠に返らなくても、タイムアウトでfalse（未確認）に倒れて確定する", async () => {
  const started = Date.now();
  const result = await vault.verifyPermission(neverResolvingHandle(), true, 60);
  const elapsed = Date.now() - started;
  assert.equal(result, false);
  assert.ok(elapsed >= 40, `タイムアウトを待たずに返ってきた (${elapsed}ms)`);
  assert.ok(elapsed < 3000, `タイムアウトで確定しなかった (${elapsed}ms)`);
});

test("verifyPermission: queryPermissionが例外を投げたら、同じ例外がそのまま伝播する（従来どおり）", async () => {
  const boom = new Error("fictional queryPermission failure");
  await assert.rejects(vault.verifyPermission(rejectingHandle(boom), true, 1000), (error) => error === boom);
});

test("restoreVaultHandle: 保存済みhandleが無ければnone", async () => {
  await db.clearVaultHandle();
  assert.deepEqual(await vault.restoreVaultHandle(60), { status: "none" });
});

test("restoreVaultHandle: 許可が確認できればconnected（従来どおり）", async () => {
  const handle = grantedHandle();
  await db.saveVaultHandle(handle);
  const result = await vault.restoreVaultHandle(60);
  assert.equal(result.status, "connected");
  assert.equal((result as { handle?: unknown }).handle, handle);
});

test("restoreVaultHandle: queryPermissionが永遠に返らない保存先は、タイムアウトでneeds-permission（再許可で復旧できる状態）へ確定する", async () => {
  const handle = neverResolvingHandle();
  await db.saveVaultHandle(handle);
  const started = Date.now();
  const result = await vault.restoreVaultHandle(60);
  const elapsed = Date.now() - started;
  assert.equal(result.status, "needs-permission");
  assert.equal((result as { handle?: unknown }).handle, handle);
  assert.ok(elapsed < 3000, `タイムアウトで確定しなかった (${elapsed}ms)`);
});

test("restoreVaultHandle: queryPermissionが例外を投げる保存先は、rejectionとして速やかに確定する（無期限に止まらない）", async () => {
  const boom = new Error("fictional restore failure");
  await db.saveVaultHandle(rejectingHandle(boom));
  const started = Date.now();
  await assert.rejects(vault.restoreVaultHandle(60), (error) => error === boom);
  assert.ok(Date.now() - started < 3000, "rejectionが速やかに返らなかった");
});

test("起動チェーン: 復元が例外を投げても、rejectionハンドラがvaultStatusを復旧可能な状態へ確定させ、チェーン全体が解決する", async () => {
  // ChatScreenの起動effectと同じ合成（withStartupSharedLock → .then(成功時, rejection時) → .finally）。
  // 成功時コールバック（baseline確立）はrejection時はskipされ、rejectionハンドラが
  // 既存の失敗分岐と同じ倒し方で状態を確定させることを確かめる。
  await db.saveVaultHandle(rejectingHandle(new Error("fictional startup restore failure")));
  let successCallbackRan = false;
  let settledStatus: string | null = null;
  let finallyRan = false;
  await worldLock
    .withStartupSharedLock(async () => {
      await vault.restoreVaultHandle();
    })
    .then(
      async () => {
        successCallbackRan = true;
      },
      () => {
        settledStatus = vault.isVaultSupported() ? "not-connected" : "unsupported";
      }
    )
    .finally(() => {
      finallyRan = true;
    });
  assert.equal(successCallbackRan, false);
  assert.equal(settledStatus, "not-connected");
  assert.equal(finallyRan, true);
});

test("起動チェーン: 復元が正常に終われば成功時コールバックが動き、rejectionハンドラは動かない", async () => {
  await db.clearVaultHandle();
  let successCallbackRan = false;
  let rejectionHandlerRan = false;
  await worldLock
    .withStartupSharedLock(async () => {
      await vault.restoreVaultHandle();
    })
    .then(
      async () => {
        successCallbackRan = true;
      },
      () => {
        rejectionHandlerRan = true;
      }
    );
  assert.equal(successCallbackRan, true);
  assert.equal(rejectionHandlerRan, false);
});
