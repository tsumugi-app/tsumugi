/**
 * Storage Persistence API（Phase 3-7）の回帰テスト。
 *
 * 実行方法：`npm run test:save-foundation`。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const OUT = path.join(__dirname, "..");
const storageMod = require(path.join(OUT, "lib/storagePersistence.js")) as typeof import("./storagePersistence");

function setNavigatorStorage(storage: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { storage }, configurable: true, writable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
  };
}

test("Storage Persistence A: navigator.storage自体が無い環境では、例外を投げずすべてnullを返す", async () => {
  const restore = setNavigatorStorage(undefined);
  try {
    const diagnostics = await storageMod.getStoragePersistenceDiagnostics();
    assert.deepEqual(diagnostics, { persistent: null, usage: null, quota: null });
    const persisted = await storageMod.requestStoragePersistence();
    assert.equal(persisted, null);
  } finally {
    restore();
  }
});

test("Storage Persistence B: persist/persisted/estimateが正常に動く環境では、その値をそのまま返す", async () => {
  const restore = setNavigatorStorage({
    persist: async () => true,
    persisted: async () => true,
    estimate: async () => ({ usage: 12345, quota: 999999 }),
  });
  try {
    const diagnostics = await storageMod.getStoragePersistenceDiagnostics();
    assert.deepEqual(diagnostics, { persistent: true, usage: 12345, quota: 999999 });
    const persisted = await storageMod.requestStoragePersistence();
    assert.equal(persisted, true);
  } finally {
    restore();
  }
});

test("Storage Persistence C: persisted()がfalseを返しても、保存処理に影響しない値として区別してそのまま返す", async () => {
  const restore = setNavigatorStorage({ persisted: async () => false, estimate: async () => ({ usage: 0, quota: 0 }) });
  try {
    const diagnostics = await storageMod.getStoragePersistenceDiagnostics();
    assert.equal(diagnostics.persistent, false, "「否認された」と「わからない」（null）を区別する");
  } finally {
    restore();
  }
});

test("Storage Persistence D: persist/persisted/estimateが例外を投げても、呼び出し元へ伝播せずnullのまま返す", async () => {
  const restore = setNavigatorStorage({
    persist: async () => {
      throw new Error("simulated failure");
    },
    persisted: async () => {
      throw new Error("simulated failure");
    },
    estimate: async () => {
      throw new Error("simulated failure");
    },
  });
  try {
    const diagnostics = await storageMod.getStoragePersistenceDiagnostics();
    assert.deepEqual(diagnostics, { persistent: null, usage: null, quota: null });
    const persisted = await storageMod.requestStoragePersistence();
    assert.equal(persisted, null);
  } finally {
    restore();
  }
});

test("Storage Persistence E: 一部のメソッドしか無い環境（例：Safari）でも、無いメソッド分だけnullのまま他は正しく返す", async () => {
  const restore = setNavigatorStorage({ estimate: async () => ({ usage: 42, quota: 100 }) }); // persist/persistedが無い
  try {
    const diagnostics = await storageMod.getStoragePersistenceDiagnostics();
    assert.equal(diagnostics.persistent, null);
    assert.equal(diagnostics.usage, 42);
    assert.equal(diagnostics.quota, 100);
    const persisted = await storageMod.requestStoragePersistence();
    assert.equal(persisted, null);
  } finally {
    restore();
  }
});

test("Storage Persistence F: estimate()がusage/quotaを数値以外で返しても、そのままcastせずnullにする", async () => {
  const restore = setNavigatorStorage({ estimate: async () => ({ usage: undefined, quota: "not-a-number" as unknown as number }) });
  try {
    const diagnostics = await storageMod.getStoragePersistenceDiagnostics();
    assert.equal(diagnostics.usage, null);
    assert.equal(diagnostics.quota, null);
  } finally {
    restore();
  }
});
