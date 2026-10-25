import test from "node:test";
import assert from "node:assert/strict";
import { waitUntilIdle } from "./waitUntilIdle";

test("waitUntilIdle: 既にidleなら待たずに即座に返る", async () => {
  let slept = 0;
  assert.equal(await waitUntilIdle(() => true, () => false, { sleep: async () => { slept += 1; } }), "idle");
  assert.equal(slept, 0);
});

test("waitUntilIdle: 作業中は短い間隔で再確認し、終わった時点で返る", async () => {
  let busy = 3;
  let slept = 0;
  assert.equal(await waitUntilIdle(() => --busy <= 0, () => false, { pollMs: 10, sleep: async () => { slept += 1; } }), "idle");
  assert.equal(slept, 2);
});

test("waitUntilIdle: 終わらなければ上限でtimeout、取り消されれば直ちにcancelled", async () => {
  assert.equal(await waitUntilIdle(() => false, () => false, { pollMs: 10, maxWaitMs: 50, sleep: async () => {} }), "timeout");
  assert.equal(await waitUntilIdle(() => false, () => true, { sleep: async () => {} }), "cancelled");
});
