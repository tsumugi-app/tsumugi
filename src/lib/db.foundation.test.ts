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
const ev = async (id: string) => ({ vaultCopyVerified: true as const, seenOutboxUpdatedAt: (await dbMod.getVaultOutboxEntry(id))!.updatedAt });
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

test("memoryRepairScopeOk: links/updatedAt, plus metadata.sourceType only when absent and equal to inferSourceType(source)", () => {
  const base = memory("scope-1"); const { sourceType: _omit, ...metadata } = base.metadata as unknown as Record<string, unknown>; void _omit;
  const legacy = { ...base, metadata } as unknown as MemoryObject;
  const links = { ...legacy, links: [testLink("scope-l", "scope-1", "scope-2")], updatedAt: "2026-02-09T00:00:00.000Z" };
  assert.equal(dbMod.memoryRepairScopeOk(legacy, links), true);
  assert.equal(dbMod.memoryRepairScopeOk(legacy, { ...links, metadata: { ...legacy.metadata, sourceType: "chat" } } as MemoryObject), true, "source ai-capture -> chat");
  assert.equal(dbMod.memoryRepairScopeOk(legacy, { ...links, metadata: { ...legacy.metadata, sourceType: "manual" } } as MemoryObject), false, "not the inferred value");
  assert.equal(dbMod.memoryRepairScopeOk({ ...legacy, metadata: { ...legacy.metadata, sourceType: "manual" } } as MemoryObject, { ...links, metadata: { ...legacy.metadata, sourceType: "chat" } } as MemoryObject), false, "an explicit value is never overwritten");
  assert.equal(dbMod.memoryRepairScopeOk(legacy, { ...links, metadata: { ...legacy.metadata, sourceType: "chat", confidence: 0.1 } } as MemoryObject), false, "no other metadata");
  assert.equal(dbMod.memoryRepairScopeOk(legacy, { ...links, summary: "x" }), false);
});


// ===========================================================================
// Storage-layer invariants (root cause of the 2026 Memory contamination: an AI-chosen id overwrote another conversation's Memory).
// ===========================================================================
const fromConversation = (id: string, conversationId: string, updatedAt: string = T): MemoryObject => ({ ...memory(id, updatedAt), conversationId });

test("lineage invariant: NO writer can replace a stored Memory with one from another conversation (the original corruption), and nothing at all is written", async () => {
  await dbMod.putMemoryObject(fromConversation("lin-1", "conv-A"));
  const stolen = { ...fromConversation("lin-1", "conv-B", "2026-02-01T00:00:00.000Z"), content: "another conversation's content", summary: "another summary" };
  await assert.rejects(() => dbMod.putMemoryObject(stolen), (e: Error) => e.name === "MemoryLineageViolationError");
  await assert.rejects(() => dbMod.putMemoryObjectWithOutbox(stolen), (e: Error) => e.name === "MemoryLineageViolationError");
  await assert.rejects(() => dbMod.putMemoryObjectAndMarkSynced(stolen, "memory:lin-1"), (e: Error) => e.name === "MemoryLineageViolationError");
  await assert.rejects(() => dbMod.restoreMemoryObjectIfNotNewer(stolen), (e: Error) => e.name === "MemoryLineageViolationError");
  const kept = await dbMod.getMemoryObject("lin-1");
  assert.equal(kept?.conversationId, "conv-A"); assert.equal(kept?.content, "内容"); assert.equal(kept?.summary, "要約");
  assert.equal(await dbMod.getVaultOutboxEntry("memory:lin-1"), undefined, "the atomic Outbox entry was rolled back with the refused record");
  assert.equal(await dbMod.getVaultSyncState("memory:lin-1"), undefined, "no sync ledger was written for the refused record");
  // a Memory that drops its lineage can not replace one that has it either
  await assert.rejects(() => dbMod.putMemoryObject({ ...memory("lin-1", "2026-03-01T00:00:00.000Z"), conversationId: undefined } as unknown as MemoryObject), (e: Error) => e.name === "MemoryLineageViolationError");
  // the legitimate rewrite (same conversation) and a first write are untouched
  await dbMod.putMemoryObject({ ...fromConversation("lin-1", "conv-A", "2026-04-01T00:00:00.000Z"), content: "edited in its own conversation" });
  assert.equal((await dbMod.getMemoryObject("lin-1"))?.content, "edited in its own conversation");
  await dbMod.putMemoryObjectWithOutbox(fromConversation("lin-2", "conv-B"));
  assert.equal((await dbMod.getMemoryObject("lin-2"))?.conversationId, "conv-B");
});

test("restore from the Vault replaces a stored record only with a strictly newer version IN TIME; older, equal-but-different and unparseable versions keep the local record (conversation, Memory, Source)", async () => {
  const newer = "2026-09-01T00:00:00.000Z", older = "2026-01-01T00:00:00.000Z";
  await dbMod.putConversationWithOutbox({ ...conversation("rc-1", newer), turns: [{ role: "user", content: "local newer", timestamp: newer }] } as Conversation);
  assert.equal(await dbMod.restoreConversationIfNotNewer(conversation("rc-1", older)), "kept-local");
  assert.equal((await dbMod.getConversation("rc-1"))?.turns[0].content, "local newer");
  // same version, different content: a local-only change must survive (kept), never be overwritten
  assert.equal(await dbMod.restoreConversationIfNotNewer({ ...conversation("rc-1", newer), turns: [{ role: "user", content: "same version, other content", timestamp: newer }] } as Conversation), "kept-local");
  assert.equal((await dbMod.getConversation("rc-1"))?.turns[0].content, "local newer");
  assert.equal(await dbMod.restoreConversationIfNotNewer({ ...conversation("rc-1", "2027-01-01T00:00:00.000Z"), turns: [{ role: "user", content: "strictly newer", timestamp: newer }] } as Conversation), "written");
  assert.equal((await dbMod.getConversation("rc-1"))?.turns[0].content, "strictly newer");
  assert.equal(await dbMod.restoreConversationIfNotNewer(conversation("rc-new", older)), "written");   // nothing stored: written
  // timestamps with different UTC offsets are ordered as instants, not as strings
  await dbMod.putConversationWithOutbox(conversation("rc-tz", "2025-12-31T23:30:00-02:00"));          // = 2026-01-01T01:30Z
  assert.equal(await dbMod.restoreConversationIfNotNewer(conversation("rc-tz", "2026-01-01T00:00:00Z")), "kept-local", "00:00Z is OLDER than 01:30Z");
  assert.equal((await dbMod.getConversation("rc-tz"))?.updatedAt, "2025-12-31T23:30:00-02:00");
  // an unparseable timestamp fails closed
  assert.equal(await dbMod.restoreConversationIfNotNewer(conversation("rc-tz", "not-a-time")), "kept-local");
  assert.equal(dbMod.isStrictlyNewerVersion({ updatedAt: "2026-01-01T00:00:00Z" }, { updatedAt: "garbage" }), false);

  await dbMod.putMemoryObject({ ...fromConversation("rm-1", "c1", newer), content: "local newer memory" });
  assert.equal(await dbMod.restoreMemoryObjectIfNotNewer(fromConversation("rm-1", "c1", older)), "kept-local");
  assert.equal(await dbMod.restoreMemoryObjectIfNotNewer({ ...fromConversation("rm-1", "c1", newer), revisitPrompt: undefined, content: "stale vault copy" }), "kept-local", "equal version, different content");
  assert.equal((await dbMod.getMemoryObject("rm-1"))?.content, "local newer memory");
  assert.equal(await dbMod.restoreMemoryObjectIfNotNewer(fromConversation("rm-1", "c1", "2026-12-01T00:00:00.000Z")), "written");

  await dbMod.saveSource({ ...source("rs-1", newer), content: "local newer source" } as Source);
  assert.equal(await dbMod.restoreSourceIfNotNewer(source("rs-1", older)), "kept-local");
  assert.equal((await dbMod.getSource("rs-1"))?.content, "local newer source");
});

test("lost-update protection: an apply computed from an earlier read is refused (nothing written) when the stored record changed meanwhile - even when only a local-only field changed and updatedAt did not", async () => {
  const v1 = fromConversation("cas-1", "c1", "2026-05-01T00:00:00.000Z");
  await dbMod.putMemoryObject(v1);
  const merged = { ...fromConversation("cas-1", "c1", "2026-05-02T00:00:00.000Z"), content: "merged from the Vault" };
  // somebody (a link, a revisit prompt, Capture) changes the record after the merge was computed from v1
  await dbMod.putMemoryObject({ ...v1, updatedAt: "2026-05-03T00:00:00.000Z", content: "changed meanwhile" });
  await assert.rejects(() => dbMod.putMemoryObjectAndMarkSynced(merged, "memory:cas-1", v1), (e: Error) => e.name === "ConcurrentModificationError");
  assert.equal((await dbMod.getMemoryObject("cas-1"))?.content, "changed meanwhile");
  assert.equal(await dbMod.getVaultSyncState("memory:cas-1"), undefined);
  const v2 = (await dbMod.getMemoryObject("cas-1"))!;
  await dbMod.putMemoryObjectAndMarkSynced(merged, "memory:cas-1", v2);     // matches the stored snapshot exactly: written
  assert.equal((await dbMod.getMemoryObject("cas-1"))?.content, "merged from the Vault");
  assert.equal(await dbMod.getVaultSyncState("memory:cas-1"), merged.updatedAt);

  // the revisit-prompt case: the field is added WITHOUT advancing updatedAt, so a version-only check would not notice
  const base = fromConversation("cas-2", "c1", "2026-06-01T00:00:00.000Z");
  await dbMod.putMemoryObject(base);
  const snapshot = (await dbMod.getMemoryObject("cas-2"))!;
  await dbMod.updateMemoryRevisitPrompt("cas-2", "a prompt generated meanwhile");
  assert.equal((await dbMod.getMemoryObject("cas-2"))?.updatedAt, base.updatedAt, "the prompt does not advance updatedAt");
  await assert.rejects(() => dbMod.putMemoryObjectAndMarkSynced({ ...snapshot, content: "stale merge" }, "memory:cas-2", snapshot), (e: Error) => e.name === "ConcurrentModificationError");
  assert.equal((await dbMod.getMemoryObject("cas-2"))?.revisitPrompt, "a prompt generated meanwhile", "the prompt was not lost");

  await dbMod.putConversation(conversation("cas-c", "2026-05-01T00:00:00.000Z"));
  const c1 = (await dbMod.getConversation("cas-c"))!;
  await dbMod.putConversation({ ...conversation("cas-c", "2026-05-03T00:00:00.000Z") });
  await assert.rejects(() => dbMod.putConversationAndMarkSynced(conversation("cas-c", "2026-05-02T00:00:00.000Z"), "conversation:cas-c", c1), (e: Error) => e.name === "ConcurrentModificationError");
  assert.equal((await dbMod.getConversation("cas-c"))?.updatedAt, "2026-05-03T00:00:00.000Z");
});

test("restore ordering uses strict ISO timestamps: impossible calendar dates, bad clocks and loose formats are not orderable (fail closed)", () => {
  assert.equal(dbMod.strictInstantOf("2026-02-30T00:00:00.000Z"), null);
  assert.equal(dbMod.strictInstantOf("2026-13-01T00:00:00Z"), null);
  assert.equal(dbMod.strictInstantOf("2026-01-01T24:00:00Z"), null);
  assert.equal(dbMod.strictInstantOf("2026-01-01 00:00:00Z"), null);
  assert.equal(dbMod.strictInstantOf("2026-01-01"), null);
  assert.equal(dbMod.strictInstantOf("2026-01-01T00:00:00"), null, "no offset: ambiguous");
  assert.equal(dbMod.strictInstantOf("2026-01-01T00:00:00+25:00"), null);
  assert.equal(dbMod.strictInstantOf("2028-02-29T12:00:00.5+09:00"), Date.parse("2028-02-29T12:00:00.5+09:00"));       // real leap day
  assert.equal(dbMod.strictInstantOf("2027-02-29T12:00:00Z"), null, "2027 is not a leap year");
  assert.equal(dbMod.isStrictlyNewerVersion({ updatedAt: "2026-03-01T00:00:00Z" }, { updatedAt: "2026-02-30T00:00:00.000Z" }), false);
  assert.equal(dbMod.isStrictlyNewerVersion({ updatedAt: "2026-01-01T00:00:00Z" }, { updatedAt: "2026-01-01T00:00:01Z" }), true);
});

test("the historical Capture bug at the storage API: content produced by conversation B, built by spreading a stored Memory of conversation A (so the copied lineage still says A), is refused", async () => {
  await dbMod.putCapturedMemoryWithOutbox(fromConversation("hist-1", "conv-A"), "conv-A");                  // A's own Memory, saved by A's Capture
  const original = (await dbMod.getMemoryObject("hist-1"))!;
  // what the buggy code effectively did in conversation B: spread the stored Memory, replace the content with text derived from B
  const overwrite = { ...original, content: "text derived from conversation B", summary: "summary from B", keywords: ["B"], updatedAt: "2026-02-01T00:00:00.000Z" };
  await assert.rejects(() => dbMod.putCapturedMemoryWithOutbox(overwrite, "conv-B"), (e: Error) => e.name === "MemoryLineageViolationError");
  const kept = (await dbMod.getMemoryObject("hist-1"))!;
  assert.equal(kept.content, original.content); assert.equal(kept.summary, original.summary); assert.equal(kept.conversationId, "conv-A");
  assert.equal((await dbMod.getVaultOutboxEntry("memory:hist-1"))?.recordUpdatedAt, original.updatedAt, "the Outbox entry was not replaced either");
  // the legitimate paths: A updates its own Memory; B saves a NEW Memory under its own lineage
  await dbMod.putCapturedMemoryWithOutbox({ ...original, content: "A edited its own", updatedAt: "2026-03-01T00:00:00.000Z" }, "conv-A");
  assert.equal((await dbMod.getMemoryObject("hist-1"))?.content, "A edited its own");
  await dbMod.putCapturedMemoryWithOutbox(fromConversation("hist-2", "conv-B"), "conv-B");
  assert.equal((await dbMod.getMemoryObject("hist-2"))?.conversationId, "conv-B");
  // a record whose lineage does not match the producing conversation can not be saved at all
  await assert.rejects(() => dbMod.putCapturedMemoryWithOutbox(fromConversation("hist-3", "conv-A"), "conv-B"), (e: Error) => e.name === "MemoryLineageViolationError");
  assert.equal(await dbMod.getMemoryObject("hist-3"), undefined);
});

// ===========================================================================
// Data lifecycle: user deletion, tombstones, resurrection guards, stuck-entry resolution.
// ===========================================================================
const mkLink = (id: string, a: string, b: string) => ({ id, sourceId: a, targetId: b, axis: "theme", reason: "r", contrast: false, strength: 0.5, createdBy: "ai-inference", createdAt: T }) as unknown as MemoryObject["links"][number];
async function seedWorldForDelete(prefix: string) {
  const A = `${prefix}-A`, B = `${prefix}-B`, C = `${prefix}-C`, D = `${prefix}-D`, conv = `${prefix}-conv`;
  const l1 = mkLink(`${prefix}-l1`, A, B), l2 = mkLink(`${prefix}-l2`, C, A), l3 = mkLink(`${prefix}-l3`, B, D);
  await dbMod.putConversationWithOutbox({ ...conversation(conv), memoryObjectIds: [A, D] } as Conversation);
  await dbMod.putMemoryObjectWithOutbox({ ...fromConversation(A, conv), links: [l1, l2] });
  await dbMod.putMemoryObjectWithOutbox({ ...fromConversation(B, "other-conv"), links: [l1, l3] });
  await dbMod.putMemoryObjectWithOutbox({ ...fromConversation(C, "other-conv"), links: [l2] });
  await dbMod.putMemoryObjectWithOutbox({ ...fromConversation(D, conv), links: [l3] });
  await dbMod.setVaultSyncState(`memory:${A}`, T);
  return { A, B, C, D, conv };
}
const NOW1 = "2026-10-23T00:00:00.000Z";

test("user deletion of a Memory: the record, the link on the other end of each of its links, the owning conversation's reference, its Outbox entry and sync ledger are removed in one transaction; unrelated records are untouched; a tombstone records the intent", async () => {
  const w = await seedWorldForDelete("del1");
  const dBefore = JSON.stringify(await dbMod.getMemoryObject(w.D)), dOutbox = JSON.stringify(await dbMod.getVaultOutboxEntry(`memory:${w.D}`));
  const r = await dbMod.deleteMemoryByUser(w.A, NOW1);
  assert.deepEqual(r, { status: "deleted", countersUpdated: 2, conversationUpdated: true });
  assert.equal(await dbMod.getMemoryObject(w.A), undefined);
  assert.deepEqual((await dbMod.getMemoryObject(w.B))!.links.map((l) => l.id), ["del1-l3"], "the link to the deleted Memory is gone from B, B's other link stays");
  assert.deepEqual((await dbMod.getMemoryObject(w.C))!.links, []);
  assert.deepEqual((await dbMod.getConversation(w.conv))!.memoryObjectIds, [w.D]);
  for (const id of [w.B, w.C]) {
    const e = (await dbMod.getVaultOutboxEntry(`memory:${id}`))!;
    assert.equal(e.status, "pending"); assert.equal(e.recordUpdatedAt, NOW1, "the changed neighbour is queued for the Vault");
  }
  assert.equal((await dbMod.getVaultOutboxEntry(`conversation:${w.conv}`))!.recordUpdatedAt, NOW1);
  assert.equal(await dbMod.getVaultOutboxEntry(`memory:${w.A}`), undefined, "no Outbox task for the deleted Memory");
  assert.equal(await dbMod.getVaultSyncState(`memory:${w.A}`), undefined);
  const t = await dbMod.getTombstone("memory", w.A);
  assert.ok(t); assert.equal(t!.vault, "unverified"); assert.equal(t!.date, T); assert.equal(t!.deletedAt, NOW1);
  assert.equal(JSON.stringify(t).includes("内容"), false, "a tombstone holds no record text");
  assert.equal(JSON.stringify(await dbMod.getMemoryObject(w.D)), dBefore, "an unrelated Memory is byte-identical");
  assert.equal(JSON.stringify(await dbMod.getVaultOutboxEntry(`memory:${w.D}`)), dOutbox);
  assert.deepEqual(await dbMod.deleteMemoryByUser(w.A, NOW1), { status: "not-found", countersUpdated: 0, conversationUpdated: false }, "idempotent");
});

test("user deletion is atomic: a failure anywhere in the transaction changes nothing", async () => {
  const w = await seedWorldForDelete("del2");
  const snapshot = async () => JSON.stringify([await dbMod.getMemoryObject(w.A), await dbMod.getMemoryObject(w.B), await dbMod.getConversation(w.conv), await dbMod.getVaultOutboxEntry(`memory:${w.B}`), await dbMod.listTombstones()]);
  const before = await snapshot();
  fakeIdbMod.__failNextPutOn("tsumugi", "settings");              // the tombstone write fails
  await assert.rejects(() => dbMod.deleteMemoryByUser(w.A, NOW1));
  assert.equal(await snapshot(), before, "nothing was deleted, no link removed, no tombstone");
});

test("resurrection guards: a tombstoned record is NOT re-inserted by auto import, resync add or manual restore; lifting the tombstone re-enables restoring; a corrupt tombstone store fails closed", async () => {
  const w = await seedWorldForDelete("del3");
  const gone = fromConversation(w.A, w.conv);
  const goneConv = conversation(w.conv);
  await dbMod.deleteMemoryByUser(w.A, NOW1);
  await dbMod.deleteConversationByUser(w.conv, NOW1);
  const imp = await dbMod.importMissingRecordsIfAbsent({ conversations: [goneConv], memoryObjects: [gone], sources: [] });
  assert.equal(imp.insertedMemoryObjects, 0); assert.equal(imp.insertedConversations, 0); assert.equal(imp.skippedMemoryObjects, 1); assert.equal(imp.skippedConversations, 1);
  assert.equal(await dbMod.addMemoryObjectIfAbsentAndMarkSynced(gone, `memory:${w.A}`), false);
  assert.equal(await dbMod.addConversationIfAbsentAndMarkSynced(goneConv, `conversation:${w.conv}`), false);
  assert.equal(await dbMod.restoreMemoryObjectIfNotNewer(gone), "tombstoned");
  assert.equal(await dbMod.restoreConversationIfNotNewer(goneConv), "tombstoned");
  assert.equal(await dbMod.getMemoryObject(w.A), undefined); assert.equal(await dbMod.getConversation(w.conv), undefined);
  assert.equal(await dbMod.getVaultSyncState(`memory:${w.A}`), undefined, "no ledger without a record");
  // "allow it back": only now can the Vault copy be restored
  await dbMod.clearTombstone("memory", w.A);
  assert.equal(await dbMod.restoreMemoryObjectIfNotNewer(gone), "written");
  assert.ok(await dbMod.getMemoryObject(w.A));
  // a corrupt tombstone store blocks every re-insertion and every deletion (fail closed) instead of silently disabling the guard
  const setTombstoneStore = async (target: string) => {
    const cur = (await dbMod.readMemoryRepairSettings([dbMod.TOMBSTONES_KEY]))[dbMod.TOMBSTONES_KEY] ?? null;
    await dbMod.commitMaintenanceRestore({ memories: [], conversations: [], outbox: [], syncLedger: [], settings: [{ key: dbMod.TOMBSTONES_KEY, expectCurrent: cur, target }] });
  };
  await setTombstoneStore("{not json");
  assert.equal(await dbMod.isTombstoned("memory", "anything"), true);
  assert.equal(await dbMod.addMemoryObjectIfAbsentAndMarkSynced(fromConversation("fresh-x", "c"), "memory:fresh-x"), false);
  await assert.rejects(() => dbMod.deleteMemoryByUser(w.D, NOW1), (e: Error) => e.name === "TombstoneStoreCorruptError");
  assert.ok(await dbMod.getMemoryObject(w.D), "nothing was deleted");
  await setTombstoneStore("{}");                                   // reset for the other tests
});

test("deleting a conversation with its Memories (the user's choice) leaves no dangling reference; deleting only the conversation keeps its Memories", async () => {
  const w = await seedWorldForDelete("del4");
  const only = await dbMod.deleteConversationByUser(`${w.conv}`, NOW1);
  assert.equal(only.status, "deleted"); assert.deepEqual(only.memoryIds.sort(), [w.A, w.D].sort());
  assert.ok(await dbMod.getMemoryObject(w.A), "the Memories are untouched when only the conversation is deleted");
  const w2 = await seedWorldForDelete("del5");
  const both = await dbMod.deleteConversationWithMemoriesByUser(w2.conv, NOW1);
  assert.equal(both.memoriesDeleted, 2); assert.equal(both.conversation.status, "deleted");
  assert.equal(await dbMod.getMemoryObject(w2.A), undefined); assert.equal(await dbMod.getMemoryObject(w2.D), undefined);
  assert.deepEqual((await dbMod.getMemoryObject(w2.B))!.links, [], "the neighbours lost their links to the deleted Memories");
  assert.deepEqual((await dbMod.getMemoryObject(w2.C))!.links, []);
  assert.equal(await dbMod.getConversation(w2.conv), undefined);
});

test("stuck Outbox entries: listed, and each can be resolved by the user (retry, keep both, remove an orphan, delete) - no state without a way out", async () => {
  const hold = async (id: string, recordType: string, recordId: string, status: "held" | "pending", attempts: number, reason: string | null) =>
    dbMod.putVaultOutboxEntry({ id, recordType, recordId, recordUpdatedAt: T, steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "pending" }, attempt: { count: attempts, lastError: reason, lastAttemptAt: T }, status, heldReason: status === "held" ? reason : null, createdAt: T, updatedAt: T } as never);
  await dbMod.putMemoryObject(fromConversation("st-1", "c1"));
  await dbMod.putMemoryObject(fromConversation("st-2", "c1"));
  await hold("memory:st-1", "memory", "st-1", "held", 1, "conflict");
  await hold("memory:st-2", "memory", "st-2", "pending", 40, "verify-history-mismatch");
  await hold("memory:st-ghost", "memory", "st-ghost", "held", 0, "canonical-record-missing");
  await hold("memory:st-fresh", "memory", "st-fresh", "pending", 2, null);          // an ordinary pending entry is NOT listed
  const list = await dbMod.listOutboxNeedingAttention();
  assert.deepEqual(list.map((e) => e.id).sort(), ["memory:st-1", "memory:st-2", "memory:st-ghost"]);
  assert.equal(list.find((e) => e.id === "memory:st-ghost")!.recordExists, false);
  assert.equal(list.find((e) => e.id === "memory:st-1")!.recordExists, true);
  // retry
  assert.equal(await dbMod.retryOutboxEntry("memory:st-1", NOW1), "retried");
  const retried = (await dbMod.getVaultOutboxEntry("memory:st-1"))!;
  assert.equal(retried.status, "pending"); assert.equal(retried.heldReason, null); assert.equal(retried.attempt.count, 0);
  assert.equal(await dbMod.retryOutboxEntry("memory:nope"), "not-found");
  // keep both as they are
  assert.equal(await dbMod.acceptOutboxDivergence("memory:st-2", await ev("memory:st-2"), NOW1), "accepted");
  const accepted = (await dbMod.getVaultOutboxEntry("memory:st-2"))!;
  assert.equal(accepted.status, "done"); assert.equal(await dbMod.getVaultSyncState("memory:st-2"), (await dbMod.getMemoryObject("st-2"))!.updatedAt);
  assert.equal(await dbMod.acceptOutboxDivergence("memory:st-ghost", await ev("memory:st-ghost")), "record-missing");
  // orphan: removable only when the record really is missing
  assert.equal(await dbMod.removeOrphanOutboxEntry("memory:st-1"), "record-exists");
  assert.equal(await dbMod.removeOrphanOutboxEntry("memory:st-ghost", { tombstone: true }, NOW1), "removed");
  assert.equal(await dbMod.getVaultOutboxEntry("memory:st-ghost"), undefined);
  assert.ok(await dbMod.getTombstone("memory", "st-ghost"), "the user's deletion intent is kept so the Vault copy can not come back");
  assert.deepEqual((await dbMod.listOutboxNeedingAttention()).map((e) => e.id), [], "nothing is left without an outcome");
});

test("deleting a conversation together with its Memories is ONE transaction: an interruption commits nothing; a Memory added meanwhile is covered because the Memories are read inside the transaction", async () => {
  const w = await seedWorldForDelete("del6");
  const snapshot = async () => JSON.stringify([await dbMod.getMemoryObject(w.A), await dbMod.getMemoryObject(w.B), await dbMod.getMemoryObject(w.D), await dbMod.getConversation(w.conv), await dbMod.getVaultOutboxEntry(`memory:${w.B}`), await dbMod.getVaultOutboxEntry(`conversation:${w.conv}`), await dbMod.listTombstones()]);
  const before = await snapshot();
  fakeIdbMod.__failNextPutOn("tsumugi", "settings");                 // the tombstone write at the END fails
  await assert.rejects(() => dbMod.deleteConversationWithMemoriesByUser(w.conv, NOW1));
  assert.equal(await snapshot(), before, "no Memory, link, reference or conversation changed");
  // a third Memory of the conversation that exists when the transaction runs is deleted too (nothing dangles)
  await dbMod.putMemoryObjectWithOutbox(fromConversation(`${w.conv}-late`, w.conv));
  const r = await dbMod.deleteConversationWithMemoriesByUser(w.conv, NOW1);
  assert.equal(r.memoriesDeleted, 3);
  assert.equal(await dbMod.getMemoryObject(`${w.conv}-late`), undefined);
  assert.equal(await dbMod.getConversation(w.conv), undefined);
});

test("a Memory copied in from the Vault never keeps a link to a deleted Memory: the link is dropped and the copy is queued for the Vault (import, resync add, restore)", async () => {
  await dbMod.putMemoryObject(fromConversation("lk-gone", "c1"));
  await dbMod.deleteMemoryByUser("lk-gone", NOW1);
  const withLink = (id: string) => ({ ...fromConversation(id, "c1"), links: [testLink(`l-${id}`, id, "lk-gone")] });
  const check = async (id: string, markedSynced: boolean) => {
    const m = (await dbMod.getMemoryObject(id))!;
    assert.deepEqual(m.links, [], "no link to the deleted Memory");
    assert.ok(m.updatedAt > T, "the copy is a new version");
    assert.equal((await dbMod.getVaultOutboxEntry(`memory:${id}`))?.status, "pending", "queued for the Vault in the same transaction");
    assert.equal(await dbMod.getVaultSyncState(`memory:${id}`) !== undefined, markedSynced);
  };
  await dbMod.importMissingRecordsIfAbsent({ conversations: [], memoryObjects: [withLink("lk-import")], sources: [] });
  await check("lk-import", false);
  assert.equal(await dbMod.addMemoryObjectIfAbsentAndMarkSynced(withLink("lk-add"), "memory:lk-add"), true);
  await check("lk-add", false);
  assert.equal(await dbMod.restoreMemoryObjectIfNotNewer(withLink("lk-restore")), "written");
  await check("lk-restore", false);
  // a link to a Memory that was NOT deleted stays, and the copy is synced as before
  await dbMod.putMemoryObject(fromConversation("lk-live", "c1"));
  assert.equal(await dbMod.addMemoryObjectIfAbsentAndMarkSynced({ ...fromConversation("lk-ok", "c1"), links: [testLink("l-ok", "lk-ok", "lk-live")] }, "memory:lk-ok"), true);
  assert.equal((await dbMod.getMemoryObject("lk-ok"))!.links.length, 1);
  assert.equal(await dbMod.getVaultSyncState("memory:lk-ok"), T);
});

test("'keep both as they are' needs proof that the Vault holds a copy: without it nothing is closed", async () => {
  await dbMod.putMemoryObject(fromConversation("ev-1", "c1"));
  await dbMod.putVaultOutboxEntry({ id: "memory:ev-1", recordType: "memory", recordId: "ev-1", recordUpdatedAt: T, steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending" }, status: "held", heldReason: "verify-history-mismatch", attempt: { count: 0, lastError: null, lastAttemptAt: null }, createdAt: T, updatedAt: T } as never);
  await assert.rejects(() => dbMod.acceptOutboxDivergence("memory:ev-1", {} as never, NOW1), /vault-copy-not-verified/);
  await assert.rejects(() => dbMod.acceptOutboxDivergence("memory:ev-1", undefined as never, NOW1), /vault-copy-not-verified/);
  assert.equal((await dbMod.getVaultOutboxEntry("memory:ev-1"))!.status, "held", "the entry is still held: the local record is not declared 'saved'");
  assert.equal("memory:ev-1" in (await dbMod.getAcceptedDivergences()), false);
});

test("'keep both as they are' is bound to the entry the user saw: if the entry moved on meanwhile nothing is closed", async () => {
  await dbMod.putMemoryObject(fromConversation("sn-1", "c1"));
  await dbMod.putVaultOutboxEntry({ id: "memory:sn-1", recordType: "memory", recordId: "sn-1", recordUpdatedAt: T, steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "pending" }, status: "held", heldReason: "verify-history-mismatch", attempt: { count: 0, lastError: null, lastAttemptAt: null }, createdAt: T, updatedAt: T } as never);
  const seen = await ev("memory:sn-1");
  await dbMod.putVaultOutboxEntry({ ...(await dbMod.getVaultOutboxEntry("memory:sn-1"))!, status: "pending", heldReason: null, updatedAt: NOW1 } as never);   // another tab queued a newer version
  assert.equal(await dbMod.acceptOutboxDivergence("memory:sn-1", seen, NOW1), "changed");
  assert.equal((await dbMod.getVaultOutboxEntry("memory:sn-1"))!.status, "pending");
  assert.equal("memory:sn-1" in (await dbMod.getAcceptedDivergences()), false);
});

test("deleting a Memory never moves a neighbour's / the conversation's version backwards (future or offset timestamps)", async () => {
  const FUTURE = "2999-01-01T00:00:00.000Z";
  const w = await seedWorldForDelete("fut1");
  const nb = (await dbMod.getMemoryObject(w.B))!;
  await dbMod.putMemoryObject({ ...nb, updatedAt: FUTURE, metadata: { ...nb.metadata, updatedAt: FUTURE } });
  await dbMod.deleteMemoryByUser(w.A, NOW1);
  assert.ok(Date.parse((await dbMod.getMemoryObject(w.B))!.updatedAt) > Date.parse(FUTURE), "strictly later than the previous version");
});

test("'keep both as they are' is durable: the divergence marker is stored for that record version only, is dropped by a retry and with the record", async () => {
  await dbMod.putMemoryObject(fromConversation("dv-1", "c1"));
  await dbMod.putVaultOutboxEntry({ id: "memory:dv-1", recordType: "memory", recordId: "dv-1", recordUpdatedAt: T, steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "pending" }, attempt: { count: 3, lastError: "conflict", lastAttemptAt: T }, status: "held", heldReason: "conflict", createdAt: T, updatedAt: T } as never);
  assert.equal(await dbMod.acceptOutboxDivergence("memory:dv-1", await ev("memory:dv-1"), NOW1), "accepted");
  assert.equal((await dbMod.getAcceptedDivergences())["memory:dv-1"], T);
  assert.equal(await dbMod.retryOutboxEntry("memory:dv-1"), "not-found", "an accepted (done) entry is not retried; a new canonical version re-queues it normally");
  await dbMod.deleteMemoryByUser("dv-1", NOW1);
  assert.equal("memory:dv-1" in (await dbMod.getAcceptedDivergences()), false, "the marker is dropped with the record");
  // a Source orphan can not get a deletion tombstone (no guard exists for Sources): nothing changes
  await dbMod.putVaultOutboxEntry({ id: "source:ghost", recordType: "source", recordId: "ghost", recordUpdatedAt: T, steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "pending" }, attempt: { count: 0, lastError: null, lastAttemptAt: null }, status: "held", heldReason: "canonical-record-missing", createdAt: T, updatedAt: T } as never);
  await assert.rejects(() => dbMod.removeOrphanOutboxEntry("source:ghost", { tombstone: true }, NOW1), /tombstone-unsupported/);
  assert.ok(await dbMod.getVaultOutboxEntry("source:ghost"), "the entry is still there");
  assert.equal(await dbMod.removeOrphanOutboxEntry("source:ghost", {}, NOW1), "removed", "plain tidy-up without a promise is allowed");
});

test("every lifecycle mutation re-checks the durable maintenance gate INSIDE its transaction: while a recovery / maintenance is in progress nothing is deleted, retried, accepted or tidied", async () => {
  const w = await seedWorldForDelete("gate1");
  await dbMod.putVaultOutboxEntry({ id: `memory:${w.B}`, recordType: "memory", recordId: w.B, recordUpdatedAt: T, steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "pending" }, attempt: { count: 1, lastError: "x", lastAttemptAt: T }, status: "held", heldReason: "conflict", createdAt: T, updatedAt: T } as never);
  const before = async () => JSON.stringify([await dbMod.getMemoryObject(w.A), await dbMod.getMemoryObject(w.B), await dbMod.getConversation(w.conv), await dbMod.getVaultOutboxEntry(`memory:${w.B}`), await dbMod.getAcceptedDivergences(), await dbMod.listTombstones()]);
  const snap = await before();
  const journal = (status: string, epoch: number) => JSON.stringify({ version: dbMod.GATE_JOURNAL_VERSION, operationId: "op", status, createdAt: T, updatedAt: T, world: { activeVaultEpoch: epoch, committedVaultEpoch: null, registryGenerationEpoch: 0, journalVersion: "current", backend: null }, baselineAtStart: { status: "x", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false });
  await dbMod.writeRecoveryJournalRaw(journal("in-progress", 0));     // the CURRENT Vault world (active epoch 0)
  try {
    const blocked = (e: Error) => e.name === "RecoveryPendingError";
    await assert.rejects(() => dbMod.deleteMemoryByUser(w.A, NOW1), blocked);
    await assert.rejects(() => dbMod.deleteConversationByUser(w.conv, NOW1), blocked);
    await assert.rejects(() => dbMod.deleteConversationWithMemoriesByUser(w.conv, NOW1), blocked);
    await assert.rejects(() => dbMod.retryOutboxEntry(`memory:${w.B}`, NOW1), blocked);
    await assert.rejects(async () => dbMod.acceptOutboxDivergence(`memory:${w.B}`, await ev(`memory:${w.B}`), NOW1), blocked);
    await assert.rejects(() => dbMod.removeOrphanOutboxEntry(`memory:${w.B}`, {}, NOW1), blocked);
    assert.equal(await before(), snap, "nothing changed while the gate was in place");
    await dbMod.writeRecoveryJournalRaw("{ not json");                                  // an unreadable journal also refuses (fail closed)
    await assert.rejects(() => dbMod.deleteMemoryByUser(w.A, NOW1), blocked);
    assert.equal(await before(), snap);
    await dbMod.writeRecoveryJournalRaw(JSON.stringify({ version: 1, status: "in-progress" }));   // malformed (no world): refuses too
    await assert.rejects(() => dbMod.deleteMemoryByUser(w.A, NOW1), blocked);
    // an unfinished journal of an OLDER Vault world (the Vault was switched since) no longer concerns this Vault: allowed (same rule as the app-wide gate)
    await dbMod.writeRecoveryJournalRaw(journal("in-progress", 7));
    assert.equal(await dbMod.retryOutboxEntry("memory:nope"), "not-found", "not blocked");
  } finally {
    await dbMod.writeRecoveryJournalRaw(journal("completed", 0));   // a finished journal does not block
  }
  assert.equal((await dbMod.deleteMemoryByUser(w.A, NOW1)).status, "deleted");
});

test("every conversation / Memory writer refuses a tombstoned record: a stale chat tab or an in-flight request can not recreate a deleted conversation (and its pending projection)", async () => {
  await dbMod.putConversationWithOutbox(conversation("tb-conv"));
  await dbMod.deleteConversationByUser("tb-conv", NOW1);
  await assert.rejects(() => dbMod.putConversationWithOutbox(conversation("tb-conv", "2026-12-01T00:00:00.000Z")), (e: Error) => e.name === "TombstonedRecordError");
  assert.equal(await dbMod.getConversation("tb-conv"), undefined);
  assert.equal(await dbMod.getVaultOutboxEntry("conversation:tb-conv"), undefined, "no pending projection either");
  await dbMod.putMemoryObjectWithOutbox(fromConversation("tb-mem", "c9"));
  await dbMod.deleteMemoryByUser("tb-mem", NOW1);
  await assert.rejects(() => dbMod.putMemoryObjectWithOutbox(fromConversation("tb-mem", "c9", "2026-12-01T00:00:00.000Z")), (e: Error) => e.name === "TombstonedRecordError");
  assert.equal(await dbMod.getMemoryObject("tb-mem"), undefined);
});

test("cascade intent: after 'delete the conversation with its Memories', a Memory of that conversation that was not on this device is NOT imported either; deleting only the conversation does not block them", async () => {
  const w = await seedWorldForDelete("cas7");
  await dbMod.deleteConversationWithMemoriesByUser(w.conv, NOW1);
  const vaultOnly = fromConversation("cas7-vault-only", w.conv);                  // a Memory of the conversation that exists only in the Vault
  const imp = await dbMod.importMissingRecordsIfAbsent({ conversations: [], memoryObjects: [vaultOnly], sources: [] });
  assert.equal(imp.insertedMemoryObjects, 0); assert.equal(imp.skippedMemoryObjects, 1);
  assert.equal(await dbMod.addMemoryObjectIfAbsentAndMarkSynced(vaultOnly, "memory:cas7-vault-only"), false);
  assert.equal(await dbMod.restoreMemoryObjectIfNotNewer(vaultOnly), "tombstoned");
  assert.equal(await dbMod.isMemoryBlockedByTombstone(vaultOnly), true);
  assert.equal(await dbMod.isMemoryBlockedByTombstone(fromConversation("cas7-unrelated", "other-conv")), false);
  // conversation-only deletion: no cascade, the Memories of that conversation remain importable
  const w2 = await seedWorldForDelete("cas8");
  await dbMod.deleteConversationByUser(w2.conv, NOW1);
  const keep = fromConversation("cas8-vault-only", w2.conv);
  assert.equal(await dbMod.isMemoryBlockedByTombstone(keep), false);
  assert.equal((await dbMod.importMissingRecordsIfAbsent({ conversations: [], memoryObjects: [keep], sources: [] })).insertedMemoryObjects, 1);
});

test("retry that loses a race with 'keep both' does not erase the accepted-divergence marker", async () => {
  await dbMod.putMemoryObject(fromConversation("rr-1", "c1"));
  await dbMod.putVaultOutboxEntry({ id: "memory:rr-1", recordType: "memory", recordId: "rr-1", recordUpdatedAt: T, steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "pending" }, attempt: { count: 2, lastError: "c", lastAttemptAt: T }, status: "held", heldReason: "conflict", createdAt: T, updatedAt: T } as never);
  assert.equal(await dbMod.acceptOutboxDivergence("memory:rr-1", await ev("memory:rr-1"), NOW1), "accepted");          // the other tab
  assert.equal(await dbMod.retryOutboxEntry("memory:rr-1", NOW1), "not-found");                // this tab's stale click
  assert.equal((await dbMod.getAcceptedDivergences())["memory:rr-1"], T, "the marker survived");
  assert.equal((await dbMod.getVaultOutboxEntry("memory:rr-1"))!.status, "done");
});
