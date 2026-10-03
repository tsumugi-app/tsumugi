/**
 * 新保存基盤 Phase 3-1（DB基盤）の回帰テスト。
 *
 * 対象：vaultOutbox / vaultIdentity / migrationJournal の各storeと、
 * `putConversationWithOutbox`等のatomic transaction API（Invariant 1/2）。
 * 実IndexedDBは使わない（`fakeIdb.ts`——同一transaction内のstaged writeが、
 * いずれかのstoreへの書き込み失敗でtransaction全体としてrollbackされることまで
 * 再現する最小限のフェイク）を、Module._loadで`require("idb")`へ差し替えて使う。
 *
 * 実行方法：`npm run test:save-foundation`
 * （`tsc -p tsconfig.save-foundation.json && node --test .test-out/lib/db.foundation.test.js`）。
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

const dbMod = require(path.join(OUT, "lib/db.js")) as typeof import("./db");
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as { __failNextPutOn: (dbName: string, storeName: string) => void };

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type Source = import("./types").Source;

const T = "2026-01-01T00:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };

function conversation(id: string, updatedAt: string = T): Conversation {
  return {
    id, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt,
    turns: [{ role: "user", content: "テスト発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...meta },
  } as Conversation;
}
function memory(id: string, updatedAt: string = T): MemoryObject {
  return {
    id, date: T, content: "内容", summary: "要約", types: ["event"], conversationId: "c1", keywords: [],
    links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T, updatedAt, metadata: { ...meta },
  } as MemoryObject;
}
function source(id: string, updatedAt: string = T): Source {
  return { id, title: "素材", content: "素材本文", createdAt: T, updatedAt, sourceType: "note" } as Source;
}

// ===========================================================================
// Invariant 1 / 2：canonical writeとoutbox upsertの同一transaction atomicity
// ===========================================================================

test("putConversationWithOutbox：canonical write成功時、outbox entryも同時に作られる（必ずVault projection対象になる）", async () => {
  const c = conversation("c-basic-1");
  const entry = await dbMod.putConversationWithOutbox(c);
  assert.equal(entry.recordType, "conversation");
  assert.equal(entry.recordId, "c-basic-1");
  assert.equal(entry.status, "pending");
  const stored = await dbMod.getConversation("c-basic-1");
  assert.ok(stored, "canonical recordがIndexedDBへ保存されている");
  const outboxEntry = await dbMod.getVaultOutboxEntry("conversation:c-basic-1");
  assert.ok(outboxEntry, "outbox entryが同時に作られている");
  assert.equal(outboxEntry!.recordUpdatedAt, c.updatedAt);
});

test("Invariant 1/2：vaultOutbox側のput失敗時、canonical record側も一切反映されない（同一transactionのatomicity）", async () => {
  const id = "c-atomic-fail-outbox";
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox");
  await assert.rejects(dbMod.putConversationWithOutbox(conversation(id)));
  const stored = await dbMod.getConversation(id);
  assert.equal(stored, undefined, "outbox側が失敗した以上、canonical recordも書き込まれていてはいけない");
  const outboxEntry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.equal(outboxEntry, undefined);
});

test("Invariant 1/2：canonical record側のput失敗時、outbox側も一切反映されない（逆方向のatomicity）", async () => {
  const id = "c-atomic-fail-canonical";
  fakeIdbMod.__failNextPutOn("tsumugi", "conversations");
  await assert.rejects(dbMod.putConversationWithOutbox(conversation(id)));
  const stored = await dbMod.getConversation(id);
  assert.equal(stored, undefined);
  const outboxEntry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.equal(outboxEntry, undefined, "canonical側が失敗した以上、outbox entryが先行して残っていてはいけない");
});

test("putConversationWithOutbox：同一updatedAtでの再書き込みは、既存entryの進捗を維持する（buildOutboxEntryForUpdateの結線確認）", async () => {
  const id = "c-same-version";
  const first = await dbMod.putConversationWithOutbox(conversation(id));
  await dbMod.putVaultOutboxEntry({ ...first, steps: { ...first.steps, markdown: "done" }, status: "pending" });
  const second = await dbMod.putConversationWithOutbox(conversation(id)); // 同じupdatedAt
  assert.equal(second.steps.markdown, "done", "同一versionへの再書き込みでは進捗を巻き戻さない");
});

test("putConversationWithOutbox：updatedAtが進めば、既存entryがdoneでも必ずpendingへ戻す（Assistant応答追加後の再projection相当）", async () => {
  const id = "c-updated-version";
  const first = await dbMod.putConversationWithOutbox(conversation(id, "2026-01-01T00:00:00.000Z"));
  await dbMod.putVaultOutboxEntry({
    ...first,
    steps: { markdown: "done", registry: "done", history: "done", index: "done", ledger: "done" },
    status: "done",
  });
  const second = await dbMod.putConversationWithOutbox(conversation(id, "2026-01-01T01:00:00.000Z"));
  assert.equal(second.status, "pending");
  assert.equal(second.steps.markdown, "pending", "『conversation-turn-durable』のようなprojection不要状態は作らない");
});

test("putMemoryObjectWithOutbox：recordTypeにmemory/reflectionを指定でき、それぞれ別のoutbox entryになる", async () => {
  const m = memory("m-dual-1");
  const entryAsMemory = await dbMod.putMemoryObjectWithOutbox(m, "memory");
  assert.equal(entryAsMemory.recordType, "memory");
  const r = memory("r-dual-1");
  const entryAsReflection = await dbMod.putMemoryObjectWithOutbox(r, "reflection");
  assert.equal(entryAsReflection.recordType, "reflection");
});

test("putSourceWithOutbox：canonical writeとoutbox entryが同時に作られる", async () => {
  const s = source("s-basic-1");
  const entry = await dbMod.putSourceWithOutbox(s);
  assert.equal(entry.recordType, "source");
  const stored = await dbMod.getSource("s-basic-1");
  assert.ok(stored);
});

// ===========================================================================
// outbox：pending index
// ===========================================================================

test("getPendingVaultOutboxEntries：status:pendingのentryだけを返す（起動時reconcileが全件走査せずに済むための索引）", async () => {
  const pendingId = "c-pending-query-1";
  await dbMod.putConversationWithOutbox(conversation(pendingId));
  const doneId = "c-pending-query-2";
  const doneEntry = await dbMod.putConversationWithOutbox(conversation(doneId));
  await dbMod.putVaultOutboxEntry({ ...doneEntry, status: "done" });

  const pending = await dbMod.getPendingVaultOutboxEntries();
  const ids = pending.map((e) => e.id);
  assert.ok(ids.includes(`conversation:${pendingId}`));
  assert.ok(!ids.includes(`conversation:${doneId}`), "doneになったentryはpending一覧に出ない");
});

test("deleteVaultOutboxEntry：entryを削除できる", async () => {
  const id = "c-delete-1";
  await dbMod.putConversationWithOutbox(conversation(id));
  await dbMod.deleteVaultOutboxEntry(`conversation:${id}`);
  assert.equal(await dbMod.getVaultOutboxEntry(`conversation:${id}`), undefined);
});

// ===========================================================================
// vaultIdentity
// ===========================================================================

test("vaultIdentity：CRUDのround-trip（未ペア状態から開始する）", async () => {
  assert.equal(await dbMod.getVaultIdentityRecord(), undefined, "初期状態はまだ何も保存されていない");
  const record = { id: "current" as const, vaultId: "vault-abc", activeVaultEpoch: 3, registryGeneration: "gen-1", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
  await dbMod.putVaultIdentityRecord(record);
  const stored = await dbMod.getVaultIdentityRecord();
  assert.deepEqual(stored, record);
});

// ===========================================================================
// migrationJournal
// ===========================================================================

test("migrationJournal：CRUDと、status:pendingでの絞り込み", async () => {
  const pendingEntry = { id: "conversation:c1:2", recordType: "conversation", recordId: "c1", fromVersion: "1", toVersion: "2", status: "pending" as const, createdAt: T, updatedAt: T };
  const doneEntry = { id: "conversation:c2:2", recordType: "conversation", recordId: "c2", fromVersion: "1", toVersion: "2", status: "done" as const, createdAt: T, updatedAt: T };
  await dbMod.putMigrationJournalEntry(pendingEntry);
  await dbMod.putMigrationJournalEntry(doneEntry);
  assert.deepEqual(await dbMod.getMigrationJournalEntry("conversation:c1:2"), pendingEntry);
  const pending = await dbMod.getPendingMigrationJournalEntries();
  const ids = pending.map((e) => e.id);
  assert.ok(ids.includes("conversation:c1:2"));
  assert.ok(!ids.includes("conversation:c2:2"));
});

// ===========================================================================
// 既存保存経路への影響が無いこと
// ===========================================================================

test("既存のputConversation（新基盤を経由しない従来の保存関数）は、outbox entryを一切作らない", async () => {
  const id = "c-legacy-path-untouched";
  await dbMod.putConversation(conversation(id));
  const stored = await dbMod.getConversation(id);
  assert.ok(stored, "従来の保存経路は変わらず機能する");
  const outboxEntry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.equal(outboxEntry, undefined, "新基盤（outbox）はまだどの既存経路にも結線されていない");
});

test("既存のputConversationAndMarkSynced（Vault resync applyの既存atomic API）も、新基盤とは無関係に動作する", async () => {
  const id = "c-legacy-sync-untouched";
  await dbMod.putConversationAndMarkSynced(conversation(id), `conversation:${id}`);
  const outboxEntry = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.equal(outboxEntry, undefined);
});

// ===========================================================================
// Phase 3-2：User turn即時canonical保存（handleSend、ChatScreen.tsx）のfailure
// injection test。ここではdb.tsのAPI（`putConversationWithOutbox`）を直接検証する。
// handleSend自体（React componentのclosure・fetch・streaming）はNode環境の
// node:testから直接実行できないため、「Gemini requestより前に必ずawaitされる」
// という順序自体はChatScreen.tsxのコード自体（`await putConversationWithOutbox(updated)`
// が`fetch("/api/chat", ...)`より前の行にあること）で担保し、ここではその
// `putConversationWithOutbox`が実際に何を保証するか（A/B/C/D-E相当/G/H/I）を検証する。
// ===========================================================================

test("Phase3-2 A：canonical write成功＋outbox write成功 → Gemini requestを開始してよい状態になる", async () => {
  const id = "c-32-a";
  const entry = await dbMod.putConversationWithOutbox(conversation(id));
  assert.ok(await dbMod.getConversation(id), "User turnがcanonicalとして読み出せる");
  assert.ok(await dbMod.getVaultOutboxEntry(entry.id), "outbox entryも存在する＝Gemini requestを開始してよい");
});

test("Phase3-2 B：canonical write失敗 → outboxも作られない → Gemini requestを開始してはいけない状態のまま", async () => {
  const id = "c-32-b";
  fakeIdbMod.__failNextPutOn("tsumugi", "conversations");
  await assert.rejects(dbMod.putConversationWithOutbox(conversation(id)));
  assert.equal(await dbMod.getConversation(id), undefined);
  assert.equal(await dbMod.getVaultOutboxEntry(`conversation:${id}`), undefined, "outboxも無い＝呼び出し元はGeminiへ進んではいけないと判断できる");
});

test("Phase3-2 C：outbox write失敗 → transaction rollback → canonicalも残らない → Gemini requestを開始してはいけない状態のまま", async () => {
  const id = "c-32-c";
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox");
  await assert.rejects(dbMod.putConversationWithOutbox(conversation(id)));
  assert.equal(await dbMod.getConversation(id), undefined, "outbox側の失敗でcanonicalだけ残る、という中間状態を作らない");
});

test("Phase3-2 D/E：canonical+outbox成功直後の状態は、そのままreload（＝読み直し）しても失われない（durabilityの直接確認）", async () => {
  const id = "c-32-d-e";
  const c = conversation(id, "2026-02-01T09:00:00.000Z"); // User turnだけのConversation（Assistant turnはまだ無い）
  await dbMod.putConversationWithOutbox(c);
  // 「Gemini request直前/中にSafari/PWAが終了した」を、プロセスを再現する代わりに、
  // 別の（新しい）呼び出しとして同じ値を読み直すことでシミュレートする——
  // put()がresolveした時点でIndexedDBには既にcommit済みであるという前提のもと、
  // 「読み直しても同じUser turnが得られる」ことが、durableに残っていることの直接証拠になる。
  const reloaded = await dbMod.getConversation(id);
  assert.ok(reloaded);
  assert.equal(reloaded!.turns.length, 1);
  assert.equal(reloaded!.turns[0].role, "user");
  const reloadedOutbox = await dbMod.getVaultOutboxEntry(`conversation:${id}`);
  assert.ok(reloadedOutbox, "outbox pendingも残っている");
  assert.equal(reloadedOutbox!.status, "pending");
});

test("Phase3-2 G：Assistant応答成功後、同一Conversation IDのままoutboxが最新recordUpdatedAtでpendingへ進む", async () => {
  const id = "c-32-g";
  const userOnly = conversation(id, "2026-02-01T09:00:00.000Z");
  const userEntry = await dbMod.putConversationWithOutbox(userOnly);
  await dbMod.putVaultOutboxEntry({ ...userEntry, steps: { markdown: "done", registry: "done", history: "done", index: "done", ledger: "done" }, status: "done" });

  const withAssistant: Conversation = { ...userOnly, turns: [...userOnly.turns, { role: "ai", content: "返信", timestamp: "2026-02-01T09:00:05.000Z" }], updatedAt: "2026-02-01T09:00:05.000Z" };
  const assistantEntry = await dbMod.putConversationWithOutbox(withAssistant);

  assert.equal(assistantEntry.id, userEntry.id, "別ConversationのIDを作らない（同一ID）");
  assert.equal(assistantEntry.recordUpdatedAt, "2026-02-01T09:00:05.000Z");
  assert.equal(assistantEntry.status, "pending", "doneだった進捗も、Assistant turn追加という新しいcanonical更新で必ずpendingへ戻る");
  const stored = await dbMod.getConversation(id);
  assert.equal(stored!.turns.length, 2, "User turnとAssistant turnの両方が同じConversationに残る（重複Conversationを作らない）");
});

test("Phase3-2 H：Assistant canonical update失敗でも、直前に確定していたUser turnは失われない", async () => {
  const id = "c-32-h";
  const userOnly = conversation(id, "2026-02-01T09:00:00.000Z");
  await dbMod.putConversationWithOutbox(userOnly);

  const withAssistant: Conversation = { ...userOnly, turns: [...userOnly.turns, { role: "ai", content: "返信", timestamp: "2026-02-01T09:00:05.000Z" }], updatedAt: "2026-02-01T09:00:05.000Z" };
  fakeIdbMod.__failNextPutOn("tsumugi", "vaultOutbox");
  await assert.rejects(dbMod.putConversationWithOutbox(withAssistant));

  const stored = await dbMod.getConversation(id);
  assert.ok(stored, "Conversation自体が消えていない");
  assert.equal(stored!.turns.length, 1, "失敗したAssistant更新は反映されないが、直前のUser turnはそのまま残る");
  assert.equal(stored!.turns[0].role, "user");
});

test("Phase3-2 I：同じUser turn（同一id・同一updatedAt）でputConversationWithOutboxを2回呼んでも、重複や進捗の巻き戻りが起きない（冪等）", async () => {
  const id = "c-32-i";
  const c = conversation(id, "2026-02-01T09:00:00.000Z");
  const first = await dbMod.putConversationWithOutbox(c);
  await dbMod.putVaultOutboxEntry({ ...first, steps: { ...first.steps, markdown: "done" } });
  const second = await dbMod.putConversationWithOutbox(c); // 全く同じConversationで再度呼ぶ（誤った再試行を模す）
  const stored = await dbMod.getConversation(id);
  assert.equal(stored!.turns.length, 1, "turnsが重複していない");
  assert.equal(second.steps.markdown, "done", "同一updatedAtへの再書き込みでは、既に進んだ進捗を巻き戻さない（不要な再projectionを増やさない）");
});

test("Phase3-2 J（データ層側）：Assistant turn追加前にIndexedDBを読み直すと、closure snapshotより新しい値が既にあればそちらが得られる", async () => {
  const id = "c-32-j";
  const original = conversation(id, "2026-02-01T09:00:00.000Z");
  await dbMod.putConversationWithOutbox(original);
  // fetch開始時点のclosure snapshot（`original`相当）を保持している間に、IndexedDB側は
  // 別途さらに先へ進んでいた、という状況を模する（例：同タブの別処理が更新した等）。
  const advanced: Conversation = { ...original, metadata: { ...original.metadata }, updatedAt: "2026-02-01T09:00:03.000Z" };
  await dbMod.putConversationWithOutbox(advanced);
  // handleSendのAssistant turn追加処理が行うのと同じ再読み込みを行う。
  const latest = await dbMod.getConversation(id);
  assert.ok(latest);
  assert.ok(latest!.updatedAt > original.updatedAt, "古いclosure snapshotより新しい値が読み直しで得られる＝古いsnapshotで上書きする経路を回避できる");
});

const testLink = (id: string, a: string, b: string): import("./types").Link => ({ id, sourceId: a, targetId: b, axis: "theme", reason: "reason", strength: 0.8, contrast: false, createdBy: "ai-inference", createdAt: "2026-01-02T00:00:00.000Z" });
for (const caller of ["revisitPrompt", "topPrompt"]) test(`${caller}: atomic auxiliary patch retains latest links/version`, async () => {
  const m = memory(`patch-${caller}`); m.links = [testLink("l",m.id,"other")]; m.updatedAt = "2026-01-02T00:00:00.000Z";
  await dbMod.putMemoryObject(m);
  const latest = await dbMod.updateMemoryRevisitPrompt(m.id,"question");
  assert.deepEqual(latest, { ...m, revisitPrompt: "question" });
  assert.deepEqual(await dbMod.getMemoryObject(m.id), latest);
});
test("auxiliary patch never recreates deleted Memory", async () => { assert.equal(await dbMod.updateMemoryRevisitPrompt("absent-patch","question"), undefined); });
test("Connect latest endpoints + outbox atomic success", async () => {
  const a = memory("connect-a"), b = memory("connect-b"); a.revisitPrompt = "keep";
  await dbMod.putMemoryObject(a); await dbMod.putMemoryObject(b);
  const link = testLink("atomic-link",a.id,b.id);
  const result = await dbMod.addMemoryLinkDurably(link);
  assert.equal(result.length,2);
  for (const m of result) { assert.deepEqual(m.links,[link]); assert.equal((await dbMod.getVaultOutboxEntry(`memory:${m.id}`))!.recordUpdatedAt,m.updatedAt); }
  assert.equal(result[0].revisitPrompt,"keep");
});
test("Connect outbox failure rolls back BOTH endpoint Memories", async () => {
  const a = memory("connect-fail-a"), b = memory("connect-fail-b"); await dbMod.putMemoryObject(a); await dbMod.putMemoryObject(b);
  fakeIdbMod.__failNextPutOn("tsumugi","vaultOutbox");
  await assert.rejects(dbMod.addMemoryLinkDurably(testLink("fail-link",a.id,b.id)));
  assert.deepEqual(await dbMod.getMemoryObject(a.id),a); assert.deepEqual(await dbMod.getMemoryObject(b.id),b);
});
test("Connect missing endpoint never recreates it or changes the survivor", async () => {
  const a = memory("connect-survivor"); await dbMod.putMemoryObject(a);
  assert.deepEqual(await dbMod.addMemoryLinkDurably(testLink("missing-link",a.id,"absent")),[]);
  assert.deepEqual(await dbMod.getMemoryObject(a.id),a); assert.equal(await dbMod.getMemoryObject("absent"),undefined);
});
test("Link repair canonical + pending outbox atomicity and field scope", async () => {
  const before = memory("repair-db"), other = memory("repair-other"), link = testLink("repair-link",before.id,other.id);
  other.links = [link]; const after = { ...before, links:[link], updatedAt:link.createdAt };
  await dbMod.putMemoryObject(before); await dbMod.putMemoryObject(other);
  const expected = [dbMod.memoryRepairExpectation(before,after,await dbMod.readMemoryRepairStorage(before.id),T)];
  fakeIdbMod.__failNextPutOn("tsumugi","vaultOutbox");
  await assert.rejects(dbMod.commitMemoryLinkRestoration([{before,after}],[other],T,false,expected));
  assert.deepEqual(await dbMod.getMemoryObject(before.id),before);
  await dbMod.commitMemoryLinkRestoration([{before,after}],[other],T,false,expected);
  assert.deepEqual(await dbMod.getMemoryObject(before.id),after);
  assert.equal((await dbMod.getVaultOutboxEntry(`memory:${before.id}`))!.status,"pending");
  await dbMod.commitMemoryLinkRestoration([{before,after}],[other],T,true,expected);
  assert.equal((await dbMod.getVaultOutboxEntry(`memory:${before.id}`))!.status,"done");
  assert.equal(await dbMod.getVaultSyncState(`memory:${before.id}`),after.updatedAt);
  await assert.rejects(dbMod.commitMemoryLinkRestoration([{before,after:{...after,content:"changed"}}],[other],T,false,expected));
});
