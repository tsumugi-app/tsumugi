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

test("waitUntilIdleOrGenerationChange: 世代が変わらなければ、解放された時点でidle", async () => {
  const { waitUntilIdleOrGenerationChange } = await import("./waitUntilIdle");
  let idleAfter = 3;
  const generation = 7;
  const result = await waitUntilIdleOrGenerationChange(() => --idleAfter <= 0, () => generation, { pollMs: 10, sleep: async () => {} });
  assert.equal(result, "idle");
});

test("waitUntilIdleOrGenerationChange: 待機中に世代が進んだらcancelled（上限まで待ち続けない）", async () => {
  const { waitUntilIdleOrGenerationChange } = await import("./waitUntilIdle");
  let generation = 3;
  let sleeps = 0;
  const result = await waitUntilIdleOrGenerationChange(
    () => false, // 解放されない
    () => generation,
    { pollMs: 10, maxWaitMs: 60_000, sleep: async () => { sleeps += 1; if (sleeps === 1) generation = 4; } }
  );
  assert.equal(result, "cancelled");
  assert.equal(sleeps, 1, "世代の変化を検出した時点で待機を打ち切る");
});

test("waitUntilIdleOrGenerationChange: 世代は待機開始時点の値で判定する（開始前の変化は取り消しにならない）", async () => {
  const { waitUntilIdleOrGenerationChange } = await import("./waitUntilIdle");
  const generation = 11; // 待機開始前に既に進んでいる世代
  const result = await waitUntilIdleOrGenerationChange(() => true, () => generation, { sleep: async () => {} });
  assert.equal(result, "idle");
});
