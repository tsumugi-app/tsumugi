/**
 * Production Bootstrap Wiring（Phase 3-8）の回帰テスト。
 *
 * `runSaveFoundationBootstrap`自体はPhase 3-7/3-7.1で既にテスト済みのため、ここでは
 * `productionBootstrap.ts`が追加するwrapper挙動（single-flight・エラー封じ込め・
 * debug出力のgating）だけを対象にする。`bootstrapFn`のdependency injectionを使い、
 * 実際のIndexedDB/Vaultを一切使わない——ただし`productionBootstrap.ts`は
 * `saveFoundationBootstrap.ts`（内部で`db.ts`経由の`"idb"`を要求する）を静的import
 * するため、他のテストファイルと同じ`"idb"`差し替えは必要。
 *
 * 実行方法：`npm run test:save-foundation`。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..");
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "idb") return require(path.join(OUT, "lib/fakeIdb.js"));
  return origLoad.call(this, request, parent, isMain);
};

const bootstrapWiringMod = require(path.join(OUT, "lib/productionBootstrap.js")) as typeof import("./productionBootstrap");

type SaveFoundationBootstrapResult = import("./saveFoundationBootstrap").SaveFoundationBootstrapResult;

function fakeResult(overrides: Partial<SaveFoundationBootstrapResult> = {}): SaveFoundationBootstrapResult {
  return {
    identity: { kind: "identified", vaultId: "fake-vault-id" },
    migration: null,
    reconcile: null,
    integrity: null,
    finalReconcile: null,
    ...overrides,
  } as SaveFoundationBootstrapResult;
}

const fakeRoot = {} as FileSystemDirectoryHandle;

test("ProductionBootstrap A: 通常呼び出しでbootstrapFnが1回呼ばれ、その結果がそのまま返る", async () => {
  bootstrapWiringMod.__resetProductionBootstrapInFlightForTests();
  let calls = 0;
  const result = await bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, async () => {
    calls += 1;
    return fakeResult();
  });
  assert.equal(calls, 1);
  assert.equal(result!.identity.kind, "identified");
});

test("ProductionBootstrap B（single-flight、req 6・req 16-K）: 同時に2回呼んでも、bootstrapFnは1回しか実行されない", async () => {
  bootstrapWiringMod.__resetProductionBootstrapInFlightForTests();
  let calls = 0;
  let resolveFn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { resolveFn = resolve; });
  const bootstrapFn = async () => {
    calls += 1;
    await gate;
    return fakeResult();
  };

  const first = bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, bootstrapFn);
  const second = bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, bootstrapFn);
  resolveFn!();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1, "2回同時に呼んでも、実際のbootstrap実行は1回だけ");
  assert.equal(firstResult, secondResult, "同じ結果を共有する（同じPromiseを返している）");
});

test("ProductionBootstrap C: 1回目が完了した後にもう一度呼べば、新しいbootstrap実行が始まる（永久に固定されない）", async () => {
  bootstrapWiringMod.__resetProductionBootstrapInFlightForTests();
  let calls = 0;
  const bootstrapFn = async () => {
    calls += 1;
    return fakeResult();
  };
  await bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, bootstrapFn);
  await bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, bootstrapFn);
  assert.equal(calls, 2, "完了後の再呼び出しは、新しい独立した実行になる（2回目のstartup等を想定）");
});

test("ProductionBootstrap D（req 6：bootstrap失敗でアプリ全体を起動不能にしない）: bootstrapFnが例外を投げても、runProductionBootstrapOnce自体は例外を投げずnullを返す", async () => {
  bootstrapWiringMod.__resetProductionBootstrapInFlightForTests();
  const result = await bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, async () => {
    throw new Error("simulated bootstrap failure");
  });
  assert.equal(result, null);
});

test("ProductionBootstrap E: bootstrap失敗後も、single-flightのin-flight状態が永久にロックされない（次の呼び出しが新たに実行される）", async () => {
  bootstrapWiringMod.__resetProductionBootstrapInFlightForTests();
  let calls = 0;
  await bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, async () => {
    calls += 1;
    throw new Error("simulated bootstrap failure");
  });
  const second = await bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, async () => {
    calls += 1;
    return fakeResult();
  });
  assert.equal(calls, 2);
  assert.equal(second!.identity.kind, "identified");
});

test("ProductionBootstrap F（req 14：個人情報・会話本文をconsoleへ出さない）: debugLog無効時は何もconsole出力しない", async () => {
  bootstrapWiringMod.__resetProductionBootstrapInFlightForTests();
  const originalLog = console.log;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => logs.push(args);
  try {
    await bootstrapWiringMod.runProductionBootstrapOnce(fakeRoot, async () => fakeResult());
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.length, 0, "?debugLog=1が無い（Node環境ではwindow自体が無くdebugLogEnabled()は常にfalse）ため、summary出力は一切無い");
});
