/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Connect（connectMemory）のstale snapshot再発防止の回帰テスト。
 *
 * 守りたい不変条件：
 * - Link追加は、AI判定の間に古くなったsnapshotではなく、IndexedDB transaction内で取り直した
 *   「両endpointの最新record」に対して行う（その間に別経路が追加したlinks/updatedAtを巻き戻さない）。
 * - canonical更新とvaultOutbox登録は同一transaction（片方だけ反映された状態を作らない）。
 * - Vaultへの反映（projection）は、canonical+outboxがdurableに確定した後で、最新canonicalを使う。
 * - 存在しなくなったendpointは復活させない。同じ2つのMemoryを結ぶlinkは重複して作らない。
 * - Linkの意味（id/axis/reason/strength/contrast/createdBy）は変えない。
 *
 * 実DB・外部APIは使わない（`db.ts`は`fakeIdb`上で実物を使い、Vault writer・Retrieval・lock・
 * connectStateはstub、`/api/connect`はfetchのstub）。
 * 実行方法：`npm run test:save-foundation`
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..");
type Json = Record<string, unknown>;
const rec: {
  judgments: Json[];
  candidates: Json[];
  vaultWrites: { id: string; links: number; updatedAt: string; canonicalAtWrite: unknown }[];
  vaultError: Error | null;
  connected: string[];
  released: string[];
  claim: boolean;
  onJudge: (() => Promise<void>) | null;
  /** Real projection persists `done` through the version-guarded outcome writer; mimic that. */
  markDone: boolean;
  /** Runs inside the (stubbed) projection of the given record, before it reports its outcome. */
  onProject: ((id: string) => Promise<void>) | null;
} = { judgments: [], candidates: [], vaultWrites: [], vaultError: null, connected: [], released: [], claim: true, onJudge: null, markDone: false, onProject: null };

class StaleVaultTabError extends Error {}
class IncompleteVaultWorldError extends Error {}

const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
let dbRef: typeof import("./db") | null = null;
const stubs: Record<string, unknown> = {
  "./vaultSaveLock": { withVaultSaveLock: async <T,>(fn: () => Promise<T>) => fn() },
  "./vaultRecoveryJournal": { assertNoPendingRecovery: async () => undefined },
  "./vaultProjection": {
    reconcileMemoryOutboxEntry: async (_env: unknown, entry: { recordId: string }) => {
      const memory = (await dbRef!.getMemoryObject(entry.recordId))!;
      const canonicalAtWrite = await dbRef!.getMemoryObject(memory.id);
      rec.vaultWrites.push({ id: memory.id, links: memory.links.length, updatedAt: memory.updatedAt, canonicalAtWrite });
      if (rec.onProject) await rec.onProject(memory.id);
      if (rec.vaultError) throw rec.vaultError;
      if (rec.markDone) await dbRef!.putMemoryProjectionOutcome({ ...(entry as never as import("./vaultOutbox").VaultOutboxEntry), status: "done", heldReason: null });
      return { status: "done" };
    },
  },
  "./retrieval": { retrieveRelevantMemoriesImpl: async () => rec.candidates },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn(), StaleVaultTabError, IncompleteVaultWorldError },
  "./connectState": {
    tryClaimMemoryForConnect: async () => rec.claim,
    markMemoryConnected: async (id: string) => { rec.connected.push(id); },
    releaseMemoryConnectClaim: async (id: string) => { rec.released.push(id); },
  },
};
mod._load = function (request, parent, isMain) {
  if (request === "idb") return require(path.join(OUT, "lib/fakeIdb.js"));
  const inTree = parent?.filename?.startsWith(OUT) ?? false;
  if (inTree && request in stubs && parent?.filename?.endsWith("connect.js")) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

const dbMod = require(path.join(OUT, "lib/db.js")) as typeof import("./db");
dbRef = dbMod;
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as { __failNextPutOn: (dbName: string, storeName: string) => void };
const connectMod = require(path.join(OUT, "lib/connect.js")) as typeof import("./connect");

type MemoryObject = import("./types").MemoryObject;
type Link = import("./types").Link;

const T0 = "2026-02-01T00:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T0, updatedAt: T0 };
function memory(id: string, over: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id, date: T0, content: "内容", summary: `要約-${id}`, types: ["event"], conversationId: `conv-${id}`, keywords: ["k"],
    links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T0, updatedAt: T0, metadata: { ...meta }, ...over,
  } as MemoryObject;
}
const existingLink = (id: string, sourceId: string, targetId: string): Link => ({
  id, sourceId, targetId, axis: "same-topic" as never, reason: "既存", contrast: false, strength: 0.9, createdBy: "ai-inference", createdAt: "2026-02-01T12:00:00.000Z",
});

function setup(judgments: Json[], candidateIds: string[]) {
  rec.judgments = judgments;
  rec.candidates = candidateIds.map((id) => ({ id, date: T0, summary: `要約-${id}`, keywords: ["k"] }));
  rec.vaultWrites = []; rec.vaultError = null; rec.connected = []; rec.released = []; rec.claim = true; rec.onJudge = null; rec.markDone = false; rec.onProject = null;
}
(globalThis as unknown as { fetch: unknown }).fetch = async () => {
  if (rec.onJudge) await rec.onJudge();
  return { ok: true, status: 200, json: async () => ({ links: rec.judgments }) };
};
const judgment = (candidateId: string, over: Json = {}) => ({ candidateId, axis: "same-topic", reason: "関連する", strength: 0.8, contrast: false, ...over });
const VAULT = {} as FileSystemDirectoryHandle;

test("AI判定中に最新recordが進んでいても、最新のlinks/updatedAtを巻き戻さずlinkを追加する（古いnewMemory snapshotを保存しない）", async () => {
  const stale = memory("c-new-1"); // connectMemoryへ渡されるsnapshot（links無し）
  await dbMod.putMemoryObjectWithOutbox(stale);
  await dbMod.putMemoryObjectWithOutbox(memory("c-target-1"));
  setup([judgment("c-target-1")], ["c-target-1"]);
  const prior = existingLink("L-PRIOR", "c-new-1", "c-other");
  // AI判定（fetch）の最中に、別経路がlinks/updatedAtを更新した状態を作る。
  rec.onJudge = async () => { await dbMod.putMemoryObject({ ...stale, links: [prior], updatedAt: "2026-02-01T06:00:00.000Z" }); };

  await connectMod.connectMemory(VAULT, stale);

  const source = (await dbMod.getMemoryObject("c-new-1"))!;
  assert.equal(source.links.length, 2, "別経路が追加したlinkが残り、今回のlinkが追加された");
  assert.equal(source.links[0].id, "L-PRIOR");
  assert.equal(source.links[1].targetId, "c-target-1");
  assert.ok(source.updatedAt > "2026-02-01T06:00:00.000Z", "updatedAtは最新値より進む");
  assert.deepEqual(rec.connected, ["c-new-1"]);
});

test("両endpointのcanonical更新とvaultOutbox登録が確定した後に、最新canonicalでVaultへ反映する", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("c-new-2"));
  await dbMod.putMemoryObjectWithOutbox(memory("c-target-2"));
  setup([judgment("c-target-2")], ["c-target-2"]);

  await connectMod.connectMemory(VAULT, memory("c-new-2"));

  for (const id of ["c-new-2", "c-target-2"]) {
    const stored = (await dbMod.getMemoryObject(id))!;
    assert.equal(stored.links.length, 1);
    const outbox = (await dbMod.getVaultOutboxEntry(`memory:${id}`))!;
    assert.equal(outbox.status, "pending", "新versionのoutboxがpendingで登録されている");
    assert.equal(outbox.recordUpdatedAt, stored.updatedAt);
  }
  assert.deepEqual(rec.vaultWrites.map((w) => w.id).sort(), ["c-new-2", "c-target-2"]);
  for (const write of rec.vaultWrites) {
    const stored = (await dbMod.getMemoryObject(write.id))!;
    assert.equal(write.links, 1);
    assert.equal(write.updatedAt, stored.updatedAt, "Vaultへ渡したのは最新canonical");
    assert.deepEqual(write.canonicalAtWrite, stored, "Vault書き込み時点で、canonicalは既に確定している");
  }
});

test("Vault反映が失敗しても、canonical+outboxは確定済みでConnectは成功扱い（次回bootstrapが収束させる）", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("c-new-3"));
  await dbMod.putMemoryObjectWithOutbox(memory("c-target-3"));
  setup([judgment("c-target-3")], ["c-target-3"]);
  rec.vaultError = new Error("vault write failed");

  await connectMod.connectMemory(VAULT, memory("c-new-3"));

  assert.equal((await dbMod.getMemoryObject("c-new-3"))!.links.length, 1, "canonicalは更新済み");
  assert.equal((await dbMod.getVaultOutboxEntry("memory:c-new-3"))!.status, "pending", "pending outboxが残り、次回reconcileで収束できる");
  assert.deepEqual(rec.connected, ["c-new-3"]);
  assert.deepEqual(rec.released, []);
});

test("保存先（world）自体の不整合は従来どおり呼び出し元へ伝え、claimを解放する（canonical+outboxは確定済み）", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("c-new-4"));
  await dbMod.putMemoryObjectWithOutbox(memory("c-target-4"));
  setup([judgment("c-target-4")], ["c-target-4"]);
  rec.vaultError = new StaleVaultTabError("stale");

  await assert.rejects(connectMod.connectMemory(VAULT, memory("c-new-4")), StaleVaultTabError);
  assert.deepEqual(rec.released, ["c-new-4"]);
  assert.equal((await dbMod.getMemoryObject("c-new-4"))!.links.length, 1);
});

test("canonical+outboxのtransactionが途中で失敗したら、どちらのendpointも更新されず、Vaultへも書かない", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("c-new-5"));
  await dbMod.putMemoryObjectWithOutbox(memory("c-target-5"));
  setup([judgment("c-target-5")], ["c-target-5"]);
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox");

  await assert.rejects(connectMod.connectMemory(VAULT, memory("c-new-5")));

  assert.equal((await dbMod.getMemoryObject("c-new-5"))!.links.length, 0, "sourceは更新されていない");
  assert.equal((await dbMod.getMemoryObject("c-target-5"))!.links.length, 0, "targetも更新されていない");
  assert.deepEqual(rec.vaultWrites, [], "canonical未確定のrecordはVaultへ渡さない");
  assert.deepEqual(rec.released, ["c-new-5"]);
  assert.deepEqual(rec.connected, []);
});

test("AI判定後に削除されたtargetはスキップし、存在しないMemoryを復活させない", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("c-new-6"));
  setup([judgment("c-target-ghost")], ["c-target-ghost"]);

  await connectMod.connectMemory(VAULT, memory("c-new-6"));

  assert.equal(await dbMod.getMemoryObject("c-target-ghost"), undefined);
  assert.equal((await dbMod.getMemoryObject("c-new-6"))!.links.length, 0);
  assert.deepEqual(rec.vaultWrites, []);
  assert.deepEqual(rec.connected, ["c-new-6"]);
});

test("同じ2つのMemoryを結ぶ既存linkがあれば（失敗後の再試行・逆向きの既存link）重複して追加しない", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("c-new-7", { links: [existingLink("L-OLD", "c-target-7", "c-new-7")] }));
  await dbMod.putMemoryObjectWithOutbox(memory("c-target-7", { links: [existingLink("L-OLD", "c-target-7", "c-new-7")] }));
  setup([judgment("c-target-7")], ["c-target-7"]);

  await connectMod.connectMemory(VAULT, memory("c-new-7"));

  assert.equal((await dbMod.getMemoryObject("c-new-7"))!.links.length, 1);
  assert.equal((await dbMod.getMemoryObject("c-target-7"))!.links.length, 1);
  assert.deepEqual(rec.vaultWrites, []);
});

test("Linkの意味（id/axis/reason/strength/contrast/createdBy）は変えず、両endpointに同一Linkを持たせる", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("c-new-8"));
  await dbMod.putMemoryObjectWithOutbox(memory("c-target-8"));
  setup([judgment("c-target-8", { axis: "contrast-axis", reason: "対比", strength: 0.66, contrast: true })], ["c-target-8"]);

  await connectMod.connectMemory(VAULT, memory("c-new-8"));

  const a = (await dbMod.getMemoryObject("c-new-8"))!.links[0];
  const b = (await dbMod.getMemoryObject("c-target-8"))!.links[0];
  assert.deepEqual(a, b);
  assert.equal(a.sourceId, "c-new-8");
  assert.equal(a.targetId, "c-target-8");
  assert.equal(a.axis, "contrast-axis");
  assert.equal(a.reason, "対比");
  assert.equal(a.strength, 0.66);
  assert.equal(a.contrast, true);
  assert.equal(a.createdBy, "ai-inference");
});

test("Connect advances timestamps even when the source clock is ahead", async () => {
  const a = memory("future-a", { updatedAt: "2099-01-01T00:00:00.000Z" });
  const b = memory("future-b", { updatedAt: "2099-02-01T00:00:00.000Z" });
  await dbMod.putMemoryObject(a); await dbMod.putMemoryObject(b);
  const link = existingLink("future-link", a.id, b.id);
  const updated = await dbMod.addMemoryLinkDurably(link);
  assert.equal(updated[0].updatedAt, "2099-01-01T00:00:00.001Z");
  assert.equal(updated[1].updatedAt, "2099-02-01T00:00:00.001Z");
});

// ---------------------------------------------------------------------------
// M1：projection/read-back成功後だけ、そのversionをsynced（同期台帳）として記録する
// ---------------------------------------------------------------------------

test("M1: projection成功→Outbox done→両endpointの台帳がcanonical.updatedAtと一致する", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("m1-new-a"));
  await dbMod.putMemoryObjectWithOutbox(memory("m1-target-a"));
  setup([judgment("m1-target-a")], ["m1-target-a"]);
  rec.markDone = true;
  await connectMod.connectMemory(VAULT, memory("m1-new-a"));
  for (const id of ["m1-new-a", "m1-target-a"]) {
    const stored = (await dbMod.getMemoryObject(id))!;
    assert.equal(stored.links.length, 1);
    const outbox = (await dbMod.getVaultOutboxEntry(`memory:${id}`))!;
    assert.equal(outbox.status, "done"); assert.equal(outbox.recordUpdatedAt, stored.updatedAt);
    assert.equal(await dbMod.getVaultSyncState(`memory:${id}`), stored.updatedAt, "台帳＝canonical version");
  }
});

test("M1: projection失敗時は台帳を進めない（Outboxもpendingのまま）", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("m1-new-b"));
  await dbMod.putMemoryObjectWithOutbox(memory("m1-target-b"));
  setup([judgment("m1-target-b")], ["m1-target-b"]);
  rec.markDone = true; rec.vaultError = new Error("vault write failed");
  await connectMod.connectMemory(VAULT, memory("m1-new-b"));
  for (const id of ["m1-new-b", "m1-target-b"]) {
    assert.equal(await dbMod.getVaultSyncState(`memory:${id}`), undefined);
    assert.equal((await dbMod.getVaultOutboxEntry(`memory:${id}`))!.status, "pending");
  }
});

test("M1: projection中にcanonicalが新versionへ更新されたら、古いversionで新canonicalをsynced扱いしない", async () => {
  await dbMod.putMemoryObjectWithOutbox(memory("m1-new-c"));
  await dbMod.putMemoryObjectWithOutbox(memory("m1-target-c"));
  setup([judgment("m1-target-c")], ["m1-target-c"]);
  rec.markDone = true;
  const newer = "2030-01-01T00:00:00.000Z";
  rec.onProject = async (id) => {
    if (id !== "m1-new-c") return;
    const cur = (await dbMod.getMemoryObject(id))!;
    await dbMod.putMemoryObjectWithOutbox({ ...cur, summary: "projection中の更新", updatedAt: newer });
  };
  await connectMod.connectMemory(VAULT, memory("m1-new-c"));
  const source = (await dbMod.getMemoryObject("m1-new-c"))!;
  assert.equal(source.updatedAt, newer);
  assert.notEqual(await dbMod.getVaultSyncState("memory:m1-new-c"), source.updatedAt, "新versionをsyncedにしない");
  assert.equal(await dbMod.getVaultSyncState("memory:m1-new-c"), undefined);
  const outbox = (await dbMod.getVaultOutboxEntry("memory:m1-new-c"))!;
  assert.equal(outbox.recordUpdatedAt, newer); assert.equal(outbox.status, "pending", "新versionのpending taskを古い結果で消さない");
  // 影響を受けない側のendpointは通常どおりsynced。
  const target = (await dbMod.getMemoryObject("m1-target-c"))!;
  assert.equal(await dbMod.getVaultSyncState("memory:m1-target-c"), target.updatedAt);
});

// ---------------------------------------------------------------------------
// 構造確認：補助field更新（revisitPrompt/topPrompt）とConnectが、古いMemory snapshot全体を
// `putMemoryObject`で保存し直す経路を持たないこと（source-inspection。このprojectにはDOM/React
// test harnessが無いため、他のテストと同じ手法）。
// ---------------------------------------------------------------------------
import fs from "node:fs";
const readSource = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

test("topPrompt.ts：問いかけの保存はtransaction内の最新record更新で、putMemoryObject（snapshot全体上書き）を使わない", () => {
  const src = readSource("src/lib/topPrompt.ts");
  assert.ok(!/\bputMemoryObject\b/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "putMemoryObjectをimport・呼び出ししていない");
  assert.ok(src.includes("updateMemoryRevisitPrompt(memory.id, revisitPrompt)"));
});

test("ChatScreen.tsx：revisitPrompt生成後の保存はtransaction内の最新record更新で、snapshot全体を保存しない", () => {
  const src = readSource("src/components/ChatScreen.tsx");
  const begin = src.indexOf("function enqueueRevisitPromptGeneration(");
  const end = src.indexOf("function connectConversationBoundary(", begin);
  const body = src.slice(begin, end);
  assert.ok(body.includes("updateMemoryRevisitPrompt(memory.id, revisitPrompt)"));
  assert.ok(!body.includes("putMemoryObject("), "revisitPrompt経路でMemory全体をputしない");
  assert.ok(!body.includes("{ ...memory, revisitPrompt }"), "古いsnapshot全体を作らない");
  // 手動restore（ユーザーが明示的に「復元する」を押した場合の既存仕様）だけが、引き続き無条件putを使う。
  assert.ok(src.includes("await putMemoryObject(memoryObject);"));
});

test("connect.ts：Memory全体のputMemoryObjectを使わず、canonical+outbox確定後にVaultへ書く", () => {
  const src = readSource("src/lib/connect.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/\bputMemoryObject\b/.test(src));
  assert.ok(src.indexOf("await addMemoryLinkDurably(") < src.indexOf("await reconcileMemoryOutboxEntry("), "transaction確定が先、Vault反映が後");
});
