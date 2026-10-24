/**
 * IndexedDB層。STORAGE.md §2.3の通り、役割は検索・結合の高速化のみ。
 * Markdownが正であり、ここは常に「後から書き込まれる」派生キャッシュとして扱う
 * （書き込み順序の担保は capture.ts 側の責務）。
 */
"use client";

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { hiddenFlag, logTimingEvent } from "./debugTimingLog";
import { isWipePending, WipeInProgressError } from "./wipeState";
import type { Conversation, MemoryObject, Source, Link } from "./types";
import { inferSourceType } from "./markdown";
import type { AIProviderName } from "./ai/types";
import { type VaultOutboxEntry, vaultOutboxIdFor, buildOutboxEntryForUpdate } from "./vaultOutbox";
import { type VaultIdentityRecord, VAULT_IDENTITY_RECORD_ID } from "./vaultIdentity";
import type { MigrationJournalEntry } from "./vaultMigrationJournal";

interface TsumugiDB extends DBSchema {
  conversations: {
    key: string;
    value: Conversation;
    indexes: { "by-startedAt": string };
  };
  memoryObjects: {
    key: string;
    value: MemoryObject;
    indexes: { "by-date": string };
  };
  /**
   * Source基盤（最小構成）。MemoryObjectとは別ストアであり、Import/Attachments/検索等の
   * 実処理は今回のスコープ外（型・DB基盤のみ）。Sourceに`date`フィールドが無いため、
   * `by-date`ではなく`Timestamped.createdAt`を索引する。
   */
  sources: {
    key: string;
    value: Source;
    indexes: { "by-createdAt": string };
  };
  handles: {
    key: string;
    value: FileSystemDirectoryHandle;
  };
  /**
   * Connect処理状態（ROADMAP.md Phase 2）。id → 処理状態のみを持つ、内部管理用ストア。
   * "in-progress"は「開始前のクレーム」であり、完了時にのみ"done"へ書き換わる
   * （claimConnectStateのコメント参照）。
   */
  connectState: {
    key: string;
    value: ConnectStateRecord;
  };
  /**
   * Beta：ユーザー自身のGemini APIキー等、ブラウザにのみ保持する設定値。
   * Conversation/MemoryObjectとは完全に別ストアであり、Vault Markdownへは一切書き出さない。
   */
  settings: {
    key: string;
    value: string;
  };
  /**
   * TEMP-TEST：Android実機で確認された「起動時flushPendingToVaultが、変更の無い
   * データまで毎回無条件で全件Vaultへ書き直し、ユーザー操作の保存を待たせる」問題への対応。
   * 「このid（Conversation/MemoryObject/Source）は、どのupdatedAtまでは確実にVaultへの
   * 書き込みに成功したか」だけを記録する台帳。Vault Markdown自体の内容は一切読まない
   * （読んで比較するとAndroidの遅いI/Oで新たなコストになるため）。
   * key: `conversation:<id>` / `memory:<id>` / `source:<id>`。value: 成功時のupdatedAt。
   * 必ずVaultへの書き込みが実際に成功した後にのみ書き込むこと（楽観的な事前記録は禁止）。
   */
  vaultSyncState: {
    key: string;
    value: string;
  };
  /**
   * 新保存基盤（Phase 3）：Vault Outbox。canonical record（conversations/memoryObjects/
   * sources）が更新されるたびに、対応するprojection taskをここへupsertする。必ず
   * canonical record本体と同一transactionで書く（`putCanonicalRecordWithOutbox`参照。
   * Invariant 1/2）。Phase 3-1時点ではまだどの保存経路からもこのstoreへ書き込まれない
   * （基盤のみ。既存の保存経路には一切影響しない）。
   */
  vaultOutbox: {
    key: string;
    value: VaultOutboxEntry;
    indexes: { "by-status": string };
  };
  /**
   * 新保存基盤（Phase 3）：Vault Identity。このIndexedDBが今どのVaultとペア済みかを
   * 記録する（singleton、key固定）。実際の照合ロジックはPhase 3-4で実装する。
   */
  vaultIdentity: {
    key: string;
    value: VaultIdentityRecord;
  };
  /**
   * 新保存基盤（Phase 3）：schema migrationの進捗journal。実際のmigration runnerは
   * Phase 3-6で実装する。
   */
  migrationJournal: {
    key: string;
    value: MigrationJournalEntry;
    indexes: { "by-status": string };
  };
}

export interface ConnectStateRecord {
  status: "in-progress" | "done";
  updatedAt: string;
}

let dbPromise: Promise<IDBPDatabase<TsumugiDB>> | null = null;

/**
 * TEMP-TEST：Android実機で`boot:start`の後に`boot:end`まで到達しない事象の原因切り分け用。
 * IndexedDBのバージョンアップグレード（4→5）が、同一originの別接続（別タブ・古いページ
 * インスタンス等）によって"blocked"状態のまま止まっていないかを直接確認するための
 * 最小限のログ。db.ts・upgrade処理・Vault/Chat処理には一切手を加えない
 * （openDB呼び出しの前後にログを追加するだけ）。原因調査が終わり次第削除すること。
 */
function getDB() {
  // 完全削除が開始済み（durable markerあり）なら、接続が既にキャッシュされていても、新規に開く場合でも、
  // 以降のIndexedDBアクセスを全て拒否する。削除中・削除後に遅れて動く古い処理（Capture/Connect/
  // Reflection/revisitPrompt/会話保存等）が、消したデータを書き戻す・空DBを作り直すことを防ぐ。
  if (isWipePending()) return Promise.reject(new WipeInProgressError());
  if (!dbPromise) {
    const openStart = Date.now();
    console.log(`[DB] open:start hidden=${hiddenFlag()}`);
    logTimingEvent("DB open:start", { hidden: hiddenFlag() });

    dbPromise = openDB<TsumugiDB>("tsumugi", 6, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const conversations = db.createObjectStore("conversations", {
            keyPath: "id",
          });
          conversations.createIndex("by-startedAt", "startedAt");

          const memoryObjects = db.createObjectStore("memoryObjects", {
            keyPath: "id",
          });
          memoryObjects.createIndex("by-date", "date");

          db.createObjectStore("handles");
        }
        if (oldVersion < 2) {
          db.createObjectStore("connectState");
        }
        if (oldVersion < 3) {
          db.createObjectStore("settings");
        }
        if (oldVersion < 4) {
          const sources = db.createObjectStore("sources", {
            keyPath: "id",
          });
          sources.createIndex("by-createdAt", "createdAt");
        }
        if (oldVersion < 5) {
          db.createObjectStore("vaultSyncState");
        }
        if (oldVersion < 6) {
          // 新保存基盤（Phase 3-1）。既存store（conversations/memoryObjects/sources/
          // vaultSyncState等）は一切変更しない——新storeの追加のみで、既存の保存経路の
          // 挙動には影響しない。
          const outbox = db.createObjectStore("vaultOutbox", { keyPath: "id" });
          outbox.createIndex("by-status", "status");

          db.createObjectStore("vaultIdentity", { keyPath: "id" });

          const migrations = db.createObjectStore("migrationJournal", { keyPath: "id" });
          migrations.createIndex("by-status", "status");
        }
      },
      // 同一originの別接続（古いバージョンを開いたままの別タブ・ページインスタンス等）が
      // 存在し、このアップグレードが待たされている間に発火する。
      blocked() {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:blocked hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:blocked", { hidden: hiddenFlag(), durationMs });
      },
      // 逆に、この接続（古いバージョン側）が新しいバージョンの接続をblockしている場合に
      // 発火する。ここでは何もクローズしない（回復処理はしない、計測のみ）。
      blocking() {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:blocking hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:blocking", { hidden: hiddenFlag(), durationMs });
        // 完全削除（deleteDatabase）が別タブから要求されている間だけ、接続を閉じて削除を通す。
        // それ以外（通常のアップグレード待ち等）の挙動は変えない。
        if (isWipePending()) {
          const pending = dbPromise;
          dbPromise = null;
          void pending?.then((db) => db.close()).catch(() => undefined);
        }
      },
      terminated() {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:terminated hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:terminated", { hidden: hiddenFlag(), durationMs });
      },
    });

    // dbPromise自体は書き換えない（既存の戻り値・失敗時の伝播は無変更）。
    // ここでは成功/失敗を観測してログを残すだけの別購読。
    dbPromise.then(
      () => {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:success hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:success", { hidden: hiddenFlag(), durationMs });
      },
      () => {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:error hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:error", { hidden: hiddenFlag(), durationMs });
      }
    );
  }
  return dbPromise;
}

/** Thrown when a write would (re)create a record the user deleted. Nothing is written. */
export class TombstonedRecordError extends Error {
  constructor(public readonly kind: "memory" | "conversation", public readonly recordId: string) { super("record-is-tombstoned"); this.name = "TombstonedRecordError"; }
}
/** Plain conversation write (Capture's persistence). Refuses a conversation the user deleted (an in-flight Capture must not silently undo a deletion). */
/** A write by the app itself (e.g. a chat tab holding an older snapshot) must not bring back a reference to a Memory the user deleted. The write is the new version, so no version bump is needed. */
function withoutDeletedMemoryRefs(c: Conversation, map: TombstoneMap | null): Conversation {
  if (!map) return c;
  const kept = (c.memoryObjectIds ?? []).filter((id) => !map[tombstoneId("memory", id)]);
  return kept.length === (c.memoryObjectIds ?? []).length ? c : { ...c, memoryObjectIds: kept };
}

export async function putConversation(conversation: Conversation) {
  const db = await getDB();
  const tx = db.transaction(["conversations", "settings"], "readwrite");
  try {
    const tombs = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    if (blockedByTombstone(tombs, "conversation", conversation.id)) throw new TombstonedRecordError("conversation", conversation.id);
    await tx.objectStore("conversations").put(withoutDeletedMemoryRefs(conversation, tombs));
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
}

export async function getConversation(id: string) {
  const db = await getDB();
  return db.get("conversations", id);
}

export async function getAllConversations() {
  const db = await getDB();
  return db.getAll("conversations");
}

/**
 * STORAGE-LAYER INVARIANT (root cause of the 2026 Memory contamination): a Memory's lineage (the conversation it came from) never changes. Any write
 * that would replace a STORED Memory with one from ANOTHER conversation is refused here, whoever the caller is (Capture, restore, apply, repair). The
 * original bug let an AI-chosen id overwrite another conversation's Memory; with this check the same mistake in any future writer fails loudly and
 * writes nothing, instead of destroying data. Pure; the caller passes the stored record it read INSIDE its transaction.
 */
export class MemoryLineageViolationError extends Error {
  constructor(public readonly memoryId: string) { super("memory-lineage-violation"); this.name = "MemoryLineageViolationError"; }
}
export function assertMemoryLineage(stored: { id: string; conversationId?: string | null } | undefined, incoming: { id: string; conversationId?: string | null }): void {
  if (stored?.conversationId && incoming.conversationId !== stored.conversationId) throw new MemoryLineageViolationError(incoming.id);
}
/** Thrown when a write that was computed from an earlier read finds the stored record changed in the meantime (lost-update protection). */
export class ConcurrentModificationError extends Error {
  constructor(public readonly recordId: string) { super("concurrent-modification"); this.name = "ConcurrentModificationError"; }
}

export async function putMemoryObject(memoryObject: MemoryObject) {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects"], "readwrite");
  try {
    assertMemoryLineage(await tx.objectStore("memoryObjects").get(memoryObject.id), memoryObject);
    await tx.objectStore("memoryObjects").put(memoryObject);
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
}

/**
 * Restore-from-Vault writers (the user pressed "restore"). A stored record is replaced ONLY by a version that is strictly newer IN TIME (timestamps are
 * parsed, never compared as strings, so different UTC offsets order correctly); a record that is identical is left as it is; anything else is kept:
 * an older copy, a copy with the SAME version but different content (a local-only change such as a revisit prompt does not advance `updatedAt`),
 * and a copy whose timestamp can not be parsed (fail closed). A Memory also passes the lineage invariant. Nothing local is silently discarded.
 */
export type RestoreWriteResult = "written" | "kept-local" | "tombstoned";
/** Strict ISO-8601 instant (`YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`) with a REAL calendar date and clock time; anything else is null (Date.parse alone would normalise "2026-02-30" to March 2). */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
export function strictInstantOf(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const m = ISO_INSTANT.exec(iso);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
const instantOf = strictInstantOf;
/** true only when `incoming` is strictly newer than `stored` as a point in time; equal, older or unparseable => false */
export function isStrictlyNewerVersion(stored: { updatedAt: string }, incoming: { updatedAt: string }): boolean {
  const a = instantOf(stored.updatedAt), b = instantOf(incoming.updatedAt);
  return a !== null && b !== null && b > a;
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function sanitizeIncoming<T>(tx: { objectStore(name: string): any }, store: "conversations" | "memoryObjects" | "sources", record: T, tombs: TombstoneMap | null): Promise<T> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  if (store === "memoryObjects") return (await sanitizeTombstonedLinksInTx(tx, record as unknown as MemoryObject, tombs)).memory as unknown as T;
  if (store === "conversations") return (await sanitizeTombstonedMemoryRefsInTx(tx, record as unknown as Conversation, tombs)).conversation as unknown as T;
  return record;
}
async function restoreIfNotNewer<T extends { id: string; updatedAt: string }>(store: "conversations" | "memoryObjects" | "sources", record: T, check?: (stored: T | undefined) => void): Promise<RestoreWriteResult> {
  const db = await getDB();
  const tx = db.transaction(store === "memoryObjects" || store === "conversations" ? [store, "settings", "vaultOutbox"] : [store, "settings"], "readwrite");
  let result: RestoreWriteResult = "written";
  try {
    const os = tx.objectStore(store) as unknown as { get(id: string): Promise<T | undefined>; put(v: T): Promise<unknown> };
    const stored = await os.get(record.id);
    check?.(stored);
    const kind: TombstoneKind | null = store === "conversations" ? "conversation" : store === "memoryObjects" ? "memory" : null;
    const tombs = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    if (kind && (kind === "memory" ? memoryBlocked(tombs, record as unknown as { id: string; conversationId?: string }) : blockedByTombstone(tombs, kind, record.id))) result = "tombstoned";   // deleted by the user: not restored
    else if (stored === undefined) await os.put(await sanitizeIncoming(tx, store, record, tombs));
    else if (sameJson(stored, record)) result = "written";             // identical: nothing to do
    else if (isStrictlyNewerVersion(stored, record)) await os.put(await sanitizeIncoming(tx, store, record, tombs));
    else result = "kept-local";
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}
export const restoreConversationIfNotNewer = (conversation: Conversation) => restoreIfNotNewer("conversations", conversation);
export const restoreMemoryObjectIfNotNewer = (memoryObject: MemoryObject) => restoreIfNotNewer("memoryObjects", memoryObject, (stored) => assertMemoryLineage(stored, memoryObject));
export const restoreSourceIfNotNewer = (source: Source) => restoreIfNotNewer("sources", source);

export async function getAllMemoryObjects() {
  const db = await getDB();
  return db.getAll("memoryObjects");
}

export async function getMemoryObject(id: string) {
  const db = await getDB();
  return db.get("memoryObjects", id);
}

/**
 * Source基盤（最小構成）のCRUD。Vault保存・Importer・検索は今回のスコープ外
 * （IndexedDBへの保存・取得のみ。putMemoryObject等と同じ薄いラッパーパターンを踏襲する）。
 */
export async function saveSource(source: Source) {
  const db = await getDB();
  await db.put("sources", source);
}

export async function getSource(id: string) {
  const db = await getDB();
  return db.get("sources", id);
}

export async function getAllSources() {
  const db = await getDB();
  return db.getAll("sources");
}

export async function deleteSource(id: string) {
  const db = await getDB();
  await db.delete("sources", id);
}

export interface MissingRecordsToImport {
  conversations: Conversation[];
  memoryObjects: MemoryObject[];
  sources: Source[];
}

export interface ImportMissingRecordsResult {
  insertedConversations: number;
  insertedMemoryObjects: number;
  insertedSources: number;
  skippedConversations: number;
  skippedMemoryObjects: number;
  skippedSources: number;
}

/**
 * Android Vault問題（db.ts transaction失敗時のsettle回収）：`tx.store.get()`/
 * `tx.store.add()`のいずれかがthrowした場合、そのtransaction自体の完了/abortを
 * 未回収のまま放置しない（`tx.done`をawaitしないまま関数を抜けると、後から
 * transactionが自動abortして`tx.done`がrejectした際にunhandled rejectionとして
 * 残ってしまう）。
 *
 * 明示的に`tx.abort()`を呼び、`tx.done`のresolve/rejectを必ず（catchして）
 * 回収してから、元のerrorをそのまま呼び出し元へ再throwする——エラーの中身は
 * 一切変えず、正常経路のtransaction原子性（get→addの間に何も割り込めない）にも
 * 影響しない。`tx.abort()`自体が失敗する場合（既にtransactionが完了/abort済み等）は
 * 無視してよい（目的はあくまで`tx.done`を確実に解決させることだけのため）。
 */
async function abortAndSettleTransaction(tx: { abort(): void; done: Promise<void> }, error: unknown): Promise<never> {
  try {
    tx.abort();
  } catch {
    // 既にfinished状態のtransactionへのabort()呼び出しは例外を投げることがあるが、
    // ここでは無視してよい。
  }
  await tx.done.catch(() => {
    // abortに伴うtx.doneのrejectをここで確実に回収する（unhandled rejection防止）。
    // 元のerror自体は下でそのままthrowする。
  });
  throw error;
}

// ===========================================================================================================
// Data lifecycle: tombstones (the user's deletion intent). One settings value (`tombstones:v1`) holds a map "kind:id" -> Tombstone. A tombstone holds
// ids, dates and states only, never record text. While a tombstone exists, NO path that copies records from the Vault into IndexedDB (auto import,
// resync add, manual restore) may re-insert that record: a deleted record can not come back by itself. A corrupt tombstone store fails CLOSED
// (every re-insertion is refused) instead of silently disabling the guard.
// ===========================================================================================================
export type TombstoneKind = "memory" | "conversation";
export type TombstoneVaultState = "unverified" | "absent" | "kept";
export interface Tombstone {
  v: 1;
  /** Physical deletion is explicit and resumable. Keep this guard until an explicit allow-back. */
  physicalDeletion?: "pending" | "complete";
  /** A Vault-only cascade child's pending work is owned by this conversation's journal. */
  physicalDeletionParent?: string;
  kind: TombstoneKind;
  id: string;
  deletedAt: string;
  /** where the Vault copy lives, for the read-only check (memory: its date -> day file; conversation: its start) */
  date?: string;
  startedAt?: string;
  conversationId?: string;
  /** conversation tombstones only: the user deleted the conversation TOGETHER with its Memories, so a Memory of this conversation that is not on this device yet is not imported either */
  cascade?: boolean;
  /** "unverified": the Vault may still hold a copy; "absent": verified gone; "kept": the user chose to keep the Vault copy (it can not come back into the app) */
  vault: TombstoneVaultState;
  vaultCheckedAt?: string;
  /** the Vault this device was paired with when the user deleted the record (null: not paired / unknown). A check against a DIFFERENT Vault says nothing about this one, so it never lets the tombstone be forgotten. */
  vaultId?: string | null;
}
export const TOMBSTONES_KEY = "tombstones:v1";
const deletionJournalKey = (kind: TombstoneKind, id: string) => `physical-deletion:v1:${kind}:${id}`;
export async function readPhysicalDeletionJournal(kind: TombstoneKind, id: string): Promise<string | undefined> {
  return (await getDB()).get("settings", deletionJournalKey(kind, id));
}
/** The confirmed plan and the non-liftable guard commit together, BEFORE any Vault mutation. */
export async function beginPhysicalDeletion(expected: Tombstone, journal: string, discoveredMemoryIds: string[] = []): Promise<void> {
  const tx = (await getDB()).transaction([...LIFECYCLE_STORES], "readwrite");
  try {
    await assertNoPendingRecoveryInTx(tx);
    const s = tx.objectStore("settings");
    const map = parseTombstoneMap(await s.get(TOMBSTONES_KEY));
    if (!map || JSON.stringify(map[tombstoneId(expected.kind, expected.id)]) !== JSON.stringify(expected)) throw new Error("deletion-intent-changed");
    if (discoveredMemoryIds.length && (expected.kind !== "conversation" || !expected.cascade)) throw new Error("unconfirmed-cascade");
    for (const id of discoveredMemoryIds) {
      const m = await tx.objectStore("memoryObjects").get(id);
      if (m && m.conversationId !== expected.id) throw new Error("cascade-child-owner-changed");
      const old = map[tombstoneId("memory", id)];
      await removeMemoryInTx(tx, m ?? { id, conversationId: expected.id }, expected.deletedAt, map, { status: "deleted", countersUpdated: 0, conversationUpdated: false });
      if (old?.physicalDeletion === "pending" && !old.physicalDeletionParent) map[tombstoneId("memory", id)] = old;
      else map[tombstoneId("memory", id)] = { ...map[tombstoneId("memory", id)], vaultId: expected.vaultId, physicalDeletion: "pending", physicalDeletionParent: expected.id };
    }
    map[tombstoneId(expected.kind, expected.id)] = { ...expected, physicalDeletion: "pending" };
    await s.put(JSON.stringify(map), TOMBSTONES_KEY);
    await s.put(journal, deletionJournalKey(expected.kind, expected.id));
  } catch (e) { await abortAndSettleTransaction(tx, e); }
  await tx.done;
}
export async function finishPhysicalDeletion(expected: Tombstone): Promise<void> {
  const tx = (await getDB()).transaction(["settings"], "readwrite");
  try {
    const s = tx.objectStore("settings");
    const map = parseTombstoneMap(await s.get(TOMBSTONES_KEY));
    const t = map?.[tombstoneId(expected.kind, expected.id)];
    if (!map || !t || t.deletedAt !== expected.deletedAt || t.physicalDeletion !== "pending") throw new Error("deletion-intent-changed");
    map[tombstoneId(t.kind, t.id)] = { ...t, physicalDeletion: "complete", vault: "absent" };
    for (const child of Object.values(map)) if (t.kind === "conversation" && t.cascade && child.physicalDeletionParent === t.id && child.deletedAt === t.deletedAt && child.physicalDeletion === "pending") {
      child.physicalDeletion = "complete"; child.vault = "absent"; delete child.physicalDeletionParent;
    }
    await s.put(JSON.stringify(map), TOMBSTONES_KEY);
    await s.delete(deletionJournalKey(t.kind, t.id));
  } catch (e) { await abortAndSettleTransaction(tx, e); }
  await tx.done;
}
const tombstoneId = (kind: TombstoneKind, id: string) => `${kind}:${id}`;
type TombstoneMap = Record<string, Tombstone>;
/** null = the stored value is corrupt (callers must fail closed) */
function parseTombstoneMap(raw: unknown): TombstoneMap | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as TombstoneMap) : null;
  } catch { return null; }
}
export class TombstoneStoreCorruptError extends Error { constructor() { super("tombstone-store-corrupt"); this.name = "TombstoneStoreCorruptError"; } }
const blockedByTombstone = (map: TombstoneMap | null, kind: TombstoneKind, id: string) => map === null || Object.prototype.hasOwnProperty.call(map, tombstoneId(kind, id));
/** a Memory is blocked by its own tombstone OR by a cascade deletion of the conversation it belongs to */
const memoryBlocked = (map: TombstoneMap | null, m: { id: string; conversationId?: string | null }) =>
  blockedByTombstone(map, "memory", m.id) || (!!m.conversationId && map !== null && map[tombstoneId("conversation", m.conversationId)]?.cascade === true);
/** true when the Memory must not be (re)inserted: tombstoned itself, deleted with its conversation, or the tombstone store is unreadable (fail closed) */
export async function isMemoryBlockedByTombstone(m: { id: string; conversationId?: string | null }): Promise<boolean> {
  const db = await getDB();
  return memoryBlocked(parseTombstoneMap(await db.get("settings", TOMBSTONES_KEY)), m);
}

export async function listTombstones(): Promise<Tombstone[]> {
  const db = await getDB();
  const map = parseTombstoneMap(await db.get("settings", TOMBSTONES_KEY));
  if (map === null) throw new TombstoneStoreCorruptError();
  return Object.values(map).sort((a, b) => a.deletedAt.localeCompare(b.deletedAt));
}
export async function getTombstone(kind: TombstoneKind, id: string): Promise<Tombstone | undefined> {
  const db = await getDB();
  const map = parseTombstoneMap(await db.get("settings", TOMBSTONES_KEY));
  if (map === null) throw new TombstoneStoreCorruptError();
  return map[tombstoneId(kind, id)];
}
/** true when the record is tombstoned, and also when the tombstone store is unreadable (fail closed) */
export async function isTombstoned(kind: TombstoneKind, id: string): Promise<boolean> {
  const db = await getDB();
  return blockedByTombstone(parseTombstoneMap(await db.get("settings", TOMBSTONES_KEY)), kind, id);
}
/** The Vault queue can hold an old snapshot after deletion cleaned the canonical references. */
export async function hasDeletedMemoryReferences(ids: string[]): Promise<boolean> {
  const map = parseTombstoneMap(await (await getDB()).get("settings", TOMBSTONES_KEY));
  return map === null || ids.some((id) => blockedByTombstone(map, "memory", id));
}
async function mutateTombstones(fn: (map: TombstoneMap) => void): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["settings"], "readwrite");
  try {
    const store = tx.objectStore("settings");
    const map = parseTombstoneMap(await store.get(TOMBSTONES_KEY));
    if (map === null) throw new TombstoneStoreCorruptError();
    fn(map);
    await store.put(JSON.stringify(map), TOMBSTONES_KEY);
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
}
/** Records a verification verdict ONLY if the tombstone is still exactly the one that was scanned (a decision made meanwhile in another tab is never overwritten). */
export async function setTombstoneVaultStateIfUnchanged(expected: Tombstone, vault: TombstoneVaultState, now: string = new Date().toISOString()): Promise<boolean> {
  let changed = false;
  await mutateTombstones((map) => {
    const key = tombstoneId(expected.kind, expected.id);
    if (map[key] && expected.physicalDeletion !== "pending" && JSON.stringify(map[key]) === JSON.stringify(expected)) { map[key] = { ...expected, vault, vaultCheckedAt: now }; changed = true; }
  });
  return changed;
}
export const setTombstoneVaultState = (kind: TombstoneKind, id: string, vault: TombstoneVaultState, now: string = new Date().toISOString()) =>
  mutateTombstones((map) => { const t = map[tombstoneId(kind, id)]; if (t) map[tombstoneId(kind, id)] = { ...t, vault, vaultCheckedAt: now }; });
/** Removes a tombstone: the record may then be restored from the Vault again ("undelete" - the record itself is NOT recreated here) or, after the purge conditions, forgotten. */
export const clearTombstone = (kind: TombstoneKind, id: string) => mutateTombstones((map) => { if (map[tombstoneId(kind, id)]?.physicalDeletion !== "pending") delete map[tombstoneId(kind, id)]; });
/** Purge: clears the tombstone ONLY if it is still exactly the one the eligibility decision was made on (another tab may have changed its Vault state meanwhile). */
export async function clearTombstoneIfUnchanged(expected: Tombstone): Promise<boolean> {
  let cleared = false;
  await mutateTombstones((map) => {
    const cur = map[tombstoneId(expected.kind, expected.id)];
    if (cur && cur.physicalDeletion !== "pending" && JSON.stringify(cur) === JSON.stringify(expected)) { delete map[tombstoneId(expected.kind, expected.id)]; cleared = true; }
  });
  return cleared;
}

// ===========================================================================================================
// Data lifecycle: user-initiated deletion, with every reference kept consistent in ONE transaction, and the resolution of stuck Outbox entries.
// Nothing here deletes anything by itself: every call is the user's explicit decision (the /data screen). Vault files are NOT touched here; the tombstone
// records the intent, guards against resurrection and lets the screen verify / guide the removal of the Vault copy.
// ===========================================================================================================
export interface UserDeleteResult { status: "deleted" | "not-found"; countersUpdated: number; conversationUpdated: boolean }

/**
 * Removes one Memory INSIDE the caller's transaction: the record, the link on the OTHER end of each of its links (queued for the Vault), its entry in the
 * owning conversation (queued), its Outbox entries and sync ledger, and records the tombstone in `map` (the caller writes `map` back). Returns false when the Memory is absent.
 */
async function removeMemoryInTx(
  tx: { objectStore(name: string): any },   // eslint-disable-line @typescript-eslint/no-explicit-any
  m: Pick<MemoryObject, "id" | "conversationId"> & { date?: string }, now: string, map: TombstoneMap, result: UserDeleteResult
): Promise<void> {
  const memories = tx.objectStore("memoryObjects"), conversations = tx.objectStore("conversations"), outbox = tx.objectStore("vaultOutbox"), ledger = tx.objectStore("vaultSyncState");
  // every Memory that links to this one is corrected, whether or not this Memory holds the reciprocal copy of the link (imports can leave one-sided links)
  for (const other of (await memories.getAll()) as MemoryObject[]) {
    if (other.id === m.id) continue;
    const kept = (other.links ?? []).filter((l) => l.sourceId !== m.id && l.targetId !== m.id);
    if (kept.length === (other.links ?? []).length) continue;
    const at = strictlyLaterInstant(other.updatedAt, now);
    const next: MemoryObject = { ...other, links: kept, updatedAt: at, metadata: { ...other.metadata, updatedAt: at } };
    await memories.put(next);
    const type = next.metadata.source === "system-generated" ? "reflection" : "memory";
    await outbox.put(buildOutboxEntryForUpdate(await outbox.get(vaultOutboxIdFor(type, next.id)), type, next.id, at, at));
    result.countersUpdated += 1;
  }
  for (const c of (await conversations.getAll()) as Conversation[]) {
    if (c.memoryObjectIds.includes(m.id)) {
      const at = strictlyLaterInstant(c.updatedAt, now);
      const next: Conversation = { ...c, memoryObjectIds: c.memoryObjectIds.filter((id) => id !== m.id), updatedAt: at, metadata: { ...c.metadata, updatedAt: at } };
      await conversations.put(next);
      await outbox.put(buildOutboxEntryForUpdate(await outbox.get(vaultOutboxIdFor("conversation", c.id)), "conversation", c.id, at, at));
      result.conversationUpdated = true;
    }
  }
  await memories.delete(m.id);
  for (const type of ["memory", "reflection"]) await outbox.delete(vaultOutboxIdFor(type, m.id));
  await ledger.delete(`memory:${m.id}`);
  map[tombstoneId("memory", m.id)] = { v: 1, kind: "memory", id: m.id, deletedAt: now, date: m.date, conversationId: m.conversationId, vault: "unverified" };
  await deleteAcceptedDivergenceInTx(tx, `memory:${m.id}`);
  await deleteAcceptedDivergenceInTx(tx, `reflection:${m.id}`);
}

// ---- Accepted divergence: "keep both as they are" is DURABLE. The marker (outbox id -> the record version the user accepted) lives in settings; the
// startup integrity reconcile skips a done entry whose marker matches its version, so the same mismatch is not re-held. A later change of the record
// (a new version) no longer matches and is projected normally. The marker is dropped with the record.
export const ACCEPTED_DIVERGENCE_KEY = "divergence:v1";
function parseDivergence(raw: unknown): Record<string, string> {
  try { const v = typeof raw === "string" ? JSON.parse(raw) : {}; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {}; } catch { return {}; }
}
export async function getAcceptedDivergences(): Promise<Record<string, string>> {
  const db = await getDB();
  return parseDivergence(await db.get("settings", ACCEPTED_DIVERGENCE_KEY));
}
async function deleteAcceptedDivergenceInTx(tx: { objectStore(name: string): any }, outboxId: string): Promise<void> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const store = tx.objectStore("settings");
  const map = parseDivergence(await store.get(ACCEPTED_DIVERGENCE_KEY));
  if (outboxId in map) { delete map[outboxId]; await store.put(JSON.stringify(map), ACCEPTED_DIVERGENCE_KEY); }
}

/** Thrown by the lifecycle mutators while a maintenance window / recovery owns the durable gate. Nothing is written. */
export class RecoveryPendingError extends Error { constructor() { super("recovery-or-maintenance-in-progress"); this.name = "RecoveryPendingError"; } }
/** Must equal RECOVERY_JOURNAL_VERSION in vaultRecoveryJournal.ts (asserted by a test; db.ts can not import that module: it imports db.ts). */
export const GATE_JOURNAL_VERSION = 1;
/**
 * The same decision as vaultRecoveryJournal.isRecoveryBlockingNormalWrites, but taken INSIDE the caller's transaction (it must include "settings"):
 * no journal / completed / abandoned -> allowed; an unfinished journal of the CURRENT Vault world -> refused; an unfinished journal of an older Vault
 * world (the Vault was switched since) -> allowed (it no longer concerns this Vault); an unreadable / malformed journal, or an unreadable epoch -> refused.
 */
async function assertNoPendingRecoveryInTx(tx: { objectStore(name: string): any }): Promise<void> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const settings = tx.objectStore("settings");
  const raw = await settings.get(VAULT_RECOVERY_JOURNAL_KEY);
  if (raw === undefined) return;
  let v: any;   // eslint-disable-line @typescript-eslint/no-explicit-any
  try { v = JSON.parse(String(raw)); } catch { throw new RecoveryPendingError(); }
  const obj = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);
  const w = v?.world;
  const wellFormed = obj(v) && v.version === GATE_JOURNAL_VERSION && typeof v.operationId === "string" && ["in-progress", "completed", "abandoned"].includes(v.status)
    && obj(w) && typeof w.activeVaultEpoch === "number" && Array.isArray(v.ops) && Array.isArray(v.held) && obj(v.baselineAtStart) && obj(v.managedBefore);
  if (!wellFormed) throw new RecoveryPendingError();
  if (v.status !== "in-progress") return;
  const epoch = parseStoredEpoch(await settings.get(ACTIVE_VAULT_EPOCH_KEY));
  if (epoch.status === "invalid") throw new RecoveryPendingError();
  if ((epoch.status === "missing" ? 0 : epoch.epoch) === w.activeVaultEpoch) throw new RecoveryPendingError();
}

/** An instant strictly later than `prev` (offset-aware: ISO strings are not compared as text). `now` when it is already later. */
function strictlyLaterInstant(prev: string, now: string): string {
  const p = Date.parse(prev), n = Date.parse(now);
  if (!Number.isFinite(p)) return now;
  return Number.isFinite(n) && n > p ? now : new Date(p + 1).toISOString();
}

/**
 * A Memory copied in from the Vault may still carry a link to a Memory the user deleted. Such a link would dangle on this device, so it is dropped before the
 * insert: the stored copy gets a new updatedAt and is queued for the Vault in the same transaction (the Vault copy still has the link until that is projected).
 * Returns the record to store and whether it changed. Only the other end's OWN tombstone counts here.
 */
async function sanitizeTombstonedLinksInTx(tx: { objectStore(name: string): any }, m: MemoryObject, map: TombstoneMap | null): Promise<{ memory: MemoryObject; changed: boolean }> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!map) return { memory: m, changed: false };
  const kept = (m.links ?? []).filter((l) => {
    const otherId = l.sourceId === m.id ? l.targetId : l.sourceId;
    return otherId === m.id || !map[tombstoneId("memory", otherId)];
  });
  if (kept.length === (m.links ?? []).length) return { memory: m, changed: false };
  const at = strictlyLaterInstant(m.updatedAt, new Date().toISOString());
  const next: MemoryObject = { ...m, links: kept, updatedAt: at, metadata: { ...m.metadata, updatedAt: at } };
  const type = next.metadata.source === "system-generated" ? "reflection" : "memory";
  const outbox = tx.objectStore("vaultOutbox");
  await outbox.put(buildOutboxEntryForUpdate(await outbox.get(vaultOutboxIdFor(type, next.id)), type, next.id, next.updatedAt, next.updatedAt));
  return { memory: next, changed: true };
}

/**
 * The same for a Conversation copied in from the Vault: references to Memories the user deleted are dropped (new version, queued for the Vault in the same transaction).
 */
async function sanitizeTombstonedMemoryRefsInTx(tx: { objectStore(name: string): any }, c: Conversation, map: TombstoneMap | null): Promise<{ conversation: Conversation; changed: boolean }> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!map) return { conversation: c, changed: false };
  const kept = (c.memoryObjectIds ?? []).filter((id) => !map[tombstoneId("memory", id)]);
  if (kept.length === (c.memoryObjectIds ?? []).length) return { conversation: c, changed: false };
  const at = strictlyLaterInstant(c.updatedAt, new Date().toISOString());
  const next: Conversation = { ...c, memoryObjectIds: kept, updatedAt: at, metadata: { ...c.metadata, updatedAt: at } };
  const outbox = tx.objectStore("vaultOutbox");
  await outbox.put(buildOutboxEntryForUpdate(await outbox.get(vaultOutboxIdFor("conversation", next.id)), "conversation", next.id, at, at));
  return { conversation: next, changed: true };
}

const LIFECYCLE_STORES = ["memoryObjects", "conversations", "vaultOutbox", "vaultSyncState", "settings", "vaultIdentity"] as const;

/** Tombstones created in this transaction remember which Vault this device was paired with. */
async function stampNewTombstonesInTx(tx: { objectStore(name: string): any }, map: TombstoneMap, now: string): Promise<void> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const vaultId = ((await tx.objectStore("vaultIdentity").get(VAULT_IDENTITY_RECORD_ID)) as VaultIdentityRecord | undefined)?.vaultId ?? null;
  for (const t of Object.values(map)) if (t.deletedAt === now && t.vaultId === undefined) t.vaultId = vaultId;
}

/** Deletes one Memory (see removeMemoryInTx) in ONE transaction and writes the tombstone. */
export async function deleteMemoryByUser(memoryId: string, now: string = new Date().toISOString()): Promise<UserDeleteResult> {
  const db = await getDB();
  const tx = db.transaction([...LIFECYCLE_STORES], "readwrite");
  const result: UserDeleteResult = { status: "not-found", countersUpdated: 0, conversationUpdated: false };
  try {
    await assertNoPendingRecoveryInTx(tx);
    const settings = tx.objectStore("settings");
    const map = parseTombstoneMap(await settings.get(TOMBSTONES_KEY));
    if (map === null) throw new TombstoneStoreCorruptError();
    const m = await tx.objectStore("memoryObjects").get(memoryId);
    if (m) {
      await removeMemoryInTx(tx, m, now, map, result);
      await stampNewTombstonesInTx(tx, map, now);
      await settings.put(JSON.stringify(map), TOMBSTONES_KEY);
      result.status = "deleted";
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}

/** Deletes one Conversation record (its Memories are NOT touched: see deleteConversationWithMemoriesByUser) with its Outbox entry and sync ledger; writes the tombstone. */
export async function deleteConversationByUser(conversationId: string, now: string = new Date().toISOString()): Promise<UserDeleteResult & { memoryIds: string[] }> {
  const db = await getDB();
  const tx = db.transaction([...LIFECYCLE_STORES], "readwrite");
  const result: UserDeleteResult & { memoryIds: string[] } = { status: "not-found", countersUpdated: 0, conversationUpdated: false, memoryIds: [] };
  try {
    await assertNoPendingRecoveryInTx(tx);
    const settings = tx.objectStore("settings");
    const map = parseTombstoneMap(await settings.get(TOMBSTONES_KEY));
    if (map === null) throw new TombstoneStoreCorruptError();
    const c = await tx.objectStore("conversations").get(conversationId);
    if (c) {
      result.memoryIds = (await tx.objectStore("memoryObjects").getAll()).filter((m) => m.conversationId === c.id).map((m) => m.id);
      await removeConversationInTx(tx, c, now, map);
      await stampNewTombstonesInTx(tx, map, now);
      await settings.put(JSON.stringify(map), TOMBSTONES_KEY);
      result.status = "deleted";
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}
async function removeConversationInTx(tx: { objectStore(name: string): any }, c: Conversation, now: string, map: TombstoneMap, cascade = false): Promise<void> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  await tx.objectStore("conversations").delete(c.id);
  await tx.objectStore("vaultOutbox").delete(vaultOutboxIdFor("conversation", c.id));
  await tx.objectStore("vaultSyncState").delete(`conversation:${c.id}`);
  map[tombstoneId("conversation", c.id)] = { v: 1, kind: "conversation", id: c.id, deletedAt: now, startedAt: c.startedAt, ...(cascade ? { cascade: true } : {}), vault: "unverified" };
  await deleteAcceptedDivergenceInTx(tx, `conversation:${c.id}`);
}

/**
 * The user chose to delete a conversation AND the Memories made from it: ALL of it in ONE transaction (the Memories are read inside the transaction, so a
 * Memory added by another tab can not be left dangling, and an interruption commits nothing or everything).
 */
export async function deleteConversationWithMemoriesByUser(conversationId: string, now: string = new Date().toISOString()): Promise<{ conversation: UserDeleteResult; memoriesDeleted: number }> {
  const db = await getDB();
  const tx = db.transaction([...LIFECYCLE_STORES], "readwrite");
  const conversation: UserDeleteResult = { status: "not-found", countersUpdated: 0, conversationUpdated: false };
  let memoriesDeleted = 0;
  try {
    await assertNoPendingRecoveryInTx(tx);
    const settings = tx.objectStore("settings");
    const map = parseTombstoneMap(await settings.get(TOMBSTONES_KEY));
    if (map === null) throw new TombstoneStoreCorruptError();
    const c = await tx.objectStore("conversations").get(conversationId);
    if (c) {
      const mems = (await tx.objectStore("memoryObjects").getAll()).filter((m) => m.conversationId === c.id);
      for (const m of mems) {
        const fresh = await tx.objectStore("memoryObjects").get(m.id);      // earlier deletions in this transaction may have changed it (links)
        if (fresh) { await removeMemoryInTx(tx, fresh, now, map, conversation); memoriesDeleted += 1; }
      }
      const cNow = (await tx.objectStore("conversations").get(c.id)) ?? c;
      await removeConversationInTx(tx, cNow, now, map, true);          // cascade: Memories of this conversation that are not on this device yet are not imported either
      await stampNewTombstonesInTx(tx, map, now);
      await settings.put(JSON.stringify(map), TOMBSTONES_KEY);
      conversation.status = "deleted";
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return { conversation, memoriesDeleted };
}

export interface AttentionEntry {
  id: string; recordType: string; recordId: string; status: "pending" | "held"; heldReason: string | null;
  attempts: number; lastError: string | null; recordExists: boolean; tombstoned: boolean; updatedAt: string;
}
/** Outbox entries that will not resolve by themselves: held (conflict / mismatch / missing record) or pending after many failed attempts. */
export async function listOutboxNeedingAttention(minAttempts: number = 10): Promise<AttentionEntry[]> {
  const db = await getDB();
  const entries = (await db.getAll("vaultOutbox")).filter((e) => e.status === "held" || (e.status === "pending" && e.attempt.count >= minAttempts));
  const tombstones = parseTombstoneMap(await db.get("settings", TOMBSTONES_KEY));
  const out: AttentionEntry[] = [];
  for (const e of entries) {
    const memoryLike = e.recordType === "memory" || e.recordType === "reflection";
    const exists = memoryLike ? (await db.get("memoryObjects", e.recordId)) !== undefined
      : e.recordType === "conversation" ? (await db.get("conversations", e.recordId)) !== undefined
      : e.recordType === "source" ? (await db.get("sources", e.recordId)) !== undefined : false;
    const tombKind: TombstoneKind | null = memoryLike ? "memory" : e.recordType === "conversation" ? "conversation" : null;
    out.push({ id: e.id, recordType: e.recordType, recordId: e.recordId, status: e.status as "pending" | "held", heldReason: e.heldReason, attempts: e.attempt.count, lastError: e.attempt.lastError,
      recordExists: exists, tombstoned: tombKind ? blockedByTombstone(tombstones, tombKind, e.recordId) : false, updatedAt: e.updatedAt });
  }
  return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** "Try again": the entry becomes pending with a fresh attempt counter (the normal projection retries it). Nothing else changes. */
export async function retryOutboxEntry(id: string, now: string = new Date().toISOString()): Promise<"retried" | "not-found"> {
  const db = await getDB();
  const tx = db.transaction(["vaultOutbox", "settings"], "readwrite");
  let result: "retried" | "not-found" = "not-found";
  try {
    await assertNoPendingRecoveryInTx(tx);
    const store = tx.objectStore("vaultOutbox");
    const e = await store.get(id);
    if (e && e.status !== "done") { await deleteAcceptedDivergenceInTx(tx, id); await store.put({ ...e, status: "pending", heldReason: null, attempt: { count: 0, lastError: null, lastAttemptAt: null }, updatedAt: now }); result = "retried"; }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}

/**
 * "Keep both as they are": the user accepts that the Vault copy and this device differ; the entry is closed (no projection needed) and the sync ledger points at the current version. A later change re-queues it normally.
 * Closing the entry means this device stops trying to write the record to the Vault, so it is allowed ONLY when the caller has just verified that the Vault really holds a copy
 * (`vaultCopyVerified: true`, obtained from dataLifecycle.findRecordInVault === "present"); otherwise the local record could be the only copy and would never be saved.
 */
export async function acceptOutboxDivergence(id: string, evidence: { vaultCopyVerified: true; seenOutboxUpdatedAt: string }, now: string = new Date().toISOString()): Promise<"accepted" | "not-found" | "record-missing" | "changed"> {
  if (evidence?.vaultCopyVerified !== true || typeof evidence.seenOutboxUpdatedAt !== "string") throw new Error("vault-copy-not-verified");
  const db = await getDB();
  const tx = db.transaction(["vaultOutbox", "memoryObjects", "conversations", "sources", "vaultSyncState", "settings"], "readwrite");
  let result: "accepted" | "not-found" | "record-missing" | "changed" = "not-found";
  try {
    await assertNoPendingRecoveryInTx(tx);
    const store = tx.objectStore("vaultOutbox");
    const e = await store.get(id);
    if (e && e.updatedAt !== evidence.seenOutboxUpdatedAt) result = "changed";       // the entry moved on since the Vault copy was verified (another tab): the check no longer applies
    else if (e) {
      const memoryLike = e.recordType === "memory" || e.recordType === "reflection";
      const rec = memoryLike ? await tx.objectStore("memoryObjects").get(e.recordId)
        : e.recordType === "conversation" ? await tx.objectStore("conversations").get(e.recordId)
        : e.recordType === "source" ? await tx.objectStore("sources").get(e.recordId) : undefined;
      if (!rec) result = "record-missing";
      else {
        const steps = { ...e.steps }; for (const k of Object.keys(steps) as (keyof typeof steps)[]) steps[k] = "not-needed";
        await store.put({ ...e, recordUpdatedAt: rec.updatedAt, status: "done", heldReason: null, steps, updatedAt: now });
        await tx.objectStore("vaultSyncState").put(rec.updatedAt, `${memoryLike ? "memory" : e.recordType}:${e.recordId}`);
        const accepted = parseDivergence(await tx.objectStore("settings").get(ACCEPTED_DIVERGENCE_KEY));
        accepted[e.id] = rec.updatedAt;
        await tx.objectStore("settings").put(JSON.stringify(accepted), ACCEPTED_DIVERGENCE_KEY);
        result = "accepted";
      }
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}

/** An Outbox entry whose record does not exist (orphan bookkeeping): removed together with its ledger entry. Refuses if the record exists. Optionally records the user's deletion intent. */
export async function removeOrphanOutboxEntry(id: string, options: { tombstone?: boolean } = {}, now: string = new Date().toISOString()): Promise<"removed" | "not-found" | "record-exists"> {
  const db = await getDB();
  const tx = db.transaction(["vaultOutbox", "memoryObjects", "conversations", "sources", "vaultSyncState", "settings", "vaultIdentity"], "readwrite");
  let result: "removed" | "not-found" | "record-exists" = "not-found";
  try {
    await assertNoPendingRecoveryInTx(tx);
    const store = tx.objectStore("vaultOutbox");
    const e = await store.get(id);
    if (e) {
      const memoryLike = e.recordType === "memory" || e.recordType === "reflection";
      const rec = memoryLike ? await tx.objectStore("memoryObjects").get(e.recordId)
        : e.recordType === "conversation" ? await tx.objectStore("conversations").get(e.recordId)
        : e.recordType === "source" ? await tx.objectStore("sources").get(e.recordId) : undefined;
      if (rec) result = "record-exists";
      else {
        await store.delete(id);
        await tx.objectStore("vaultSyncState").delete(`${memoryLike ? "memory" : e.recordType}:${e.recordId}`);
        const tombKind: TombstoneKind | null = memoryLike ? "memory" : e.recordType === "conversation" ? "conversation" : null;
        if (options.tombstone && !tombKind) throw new Error("tombstone-unsupported-for-this-record-type");   // a deletion guard is not available for Sources: nothing is changed
        if (options.tombstone && tombKind) {
          const map = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
          if (map === null) throw new TombstoneStoreCorruptError();
          if (!map[tombstoneId(tombKind, e.recordId)]) map[tombstoneId(tombKind, e.recordId)] = { v: 1, kind: tombKind, id: e.recordId, deletedAt: now, vault: "unverified" };
          await stampNewTombstonesInTx(tx, map, now);
          await tx.objectStore("settings").put(JSON.stringify(map), TOMBSTONES_KEY);
        }
        result = "removed";
      }
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}

/**
 * Android Vault問題（自動取り込みの原子化）専用。Vaultからの自動import
 * （ChatScreen.tsxのautoImportMissingRecords）でだけ使う——手動restore
 * （handleRestoreFromVault、Vault側の内容で無条件に上書きする既存仕様）は
 * これまでどおり`putConversation`/`putMemoryObject`/`saveSource`を使い続け、
 * この関数は一切経由しない（手動restoreの挙動を変えないため）。
 *
 * 「そのIDが今すでに存在するかどうかの確認」と「無ければ追加する」を、
 * ストアごとに1つの`readwrite`トランザクション内で行う。IndexedDBの
 * readwriteトランザクションは同一ストアに対して直列化されるため、この
 * トランザクションが実行されている間、他のトランザクション（別のCapture・
 * 別タブ等）がこのストアへ割り込むことはない——「missing判定の時点では
 * 存在しなかったが、実際にinsertするまでの間に他所から作成／更新された」
 * というレースを構造的に閉じる。
 *
 * 既存キーが見つかった場合は`add()`を一切呼ばず、無条件でskipする（絶対に
 * 上書きしない）。存在しないことをこの関数自身の`get()`で確認した直後にだけ
 * `add()`する（`put()`ではなく`add()`を使うことで、万一の実装ミスがあっても
 * 「既存キーへの書き込みはIndexedDB自身がConstraintErrorで拒否する」という
 * 構造的な保証を重ねる。ただし正常経路では、直前の`get()`で不在を確認済みの
 * ため`add()`が失敗することは無い想定）。
 *
 * 各ストアのtransactionが途中で失敗した場合の後始末（`tx.done`の未回収防止）は
 * `abortAndSettleTransaction`に集約している。
 */
export async function importMissingRecordsIfAbsent(
  candidates: MissingRecordsToImport
): Promise<ImportMissingRecordsResult> {
  const db = await getDB();

  let insertedConversations = 0;
  let skippedConversations = 0;
  if (candidates.conversations.length > 0) {
    const tx = db.transaction(["conversations", "settings", "vaultOutbox"], "readwrite");
    try {
      const tombstones = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
      for (const conversation of candidates.conversations) {
        const existing = await tx.objectStore("conversations").get(conversation.id);
        if (blockedByTombstone(tombstones, "conversation", conversation.id)) {
          skippedConversations += 1;                      // the user deleted it: it does not come back from the Vault
        } else if (existing === undefined) {
          await tx.objectStore("conversations").add((await sanitizeTombstonedMemoryRefsInTx(tx, conversation, tombstones)).conversation);
          insertedConversations += 1;
        } else {
          skippedConversations += 1;
        }
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }

  let insertedMemoryObjects = 0;
  let skippedMemoryObjects = 0;
  if (candidates.memoryObjects.length > 0) {
    const tx = db.transaction(["memoryObjects", "settings", "vaultOutbox"], "readwrite");
    try {
      const tombstones = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
      for (const memoryObject of candidates.memoryObjects) {
        const existing = await tx.objectStore("memoryObjects").get(memoryObject.id);
        if (memoryBlocked(tombstones, memoryObject)) {
          skippedMemoryObjects += 1;                      // the user deleted it: it does not come back from the Vault
        } else if (existing === undefined) {
          await tx.objectStore("memoryObjects").add((await sanitizeTombstonedLinksInTx(tx, memoryObject, tombstones)).memory);
          insertedMemoryObjects += 1;
        } else {
          skippedMemoryObjects += 1;
        }
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }

  let insertedSources = 0;
  let skippedSources = 0;
  if (candidates.sources.length > 0) {
    const tx = db.transaction("sources", "readwrite");
    try {
      for (const source of candidates.sources) {
        const existing = await tx.store.get(source.id);
        if (existing === undefined) {
          await tx.store.add(source);
          insertedSources += 1;
        } else {
          skippedSources += 1;
        }
      }
    } catch (error) {
      await abortAndSettleTransaction(tx, error);
    }
    await tx.done;
  }

  return {
    insertedConversations,
    insertedMemoryObjects,
    insertedSources,
    skippedConversations,
    skippedMemoryObjects,
    skippedSources,
  };
}

/**
 * 「この端末に保存されているtsumugiのデータを削除」機能に伴い、IndexedDB側の
 * 派生キャッシュ（Vault Markdownと同じデータを検索・結合用に複製したもの）も
 * 揃えて空にする。`settings`（APIキー・使用するAI・chatProvider等のブラウザ設定）と
 * `handles`（PC/Android用Vaultフォルダの参照）はここでは削除しない。
 * これらはMemory/Conversationの記憶データではなく、ユーザーの「保存先・接続設定」
 * そのものであり、「保存されているデータを削除する」の対象外と判断したため
 * （呼び出し元はOPFSバックエンド時のみ使う想定。PC/Androidの`handles`ストアには
 * この関数自体は一切触れない）。
 */
export async function clearMemoryData() {
  const db = await getDB();
  await Promise.all([
    db.clear("conversations"),
    db.clear("memoryObjects"),
    db.clear("sources"),
    db.clear("connectState"),
    db.clear("vaultSyncState"),
  ]);
}

/**
 * TEMP-TEST：Vault同期済み台帳（vaultSyncState）のCRUD。key/valueの意味は
 * TsumugiDBのvaultSyncStoreのコメントを参照。呼び出し元（vault.ts）の責務として、
 * setVaultSyncStateは必ずVaultへの実書き込みが成功した後にのみ呼ぶこと。
 */
export async function getVaultSyncState(key: string): Promise<string | undefined> {
  const db = await getDB();
  return db.get("vaultSyncState", key);
}

export async function setVaultSyncState(key: string, updatedAt: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["vaultSyncState", "settings"], "readwrite");
  try {
    const colon = key.indexOf(":"); const kind = key.slice(0, colon); const id = key.slice(colon + 1);
    const map = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    if (!(kind === "memory" || kind === "conversation") || !blockedByTombstone(map, kind, id)) await tx.objectStore("vaultSyncState").put(updatedAt, key);
  } catch (e) { await abortAndSettleTransaction(tx, e); }
  await tx.done;
}

/**
 * Step 4b（Vault resync apply）専用：record本体とvaultSyncStateを同一の
 * IndexedDB transactionでまとめて書く。この2つを別々のtransactionで行うと、
 * 「record本体は新しい値に更新できたがvaultSyncStateだけ書き込みに失敗した」
 * という中間状態が生じうる。この中間状態では、次回resyncの「local unsynced」
 * 判定（IndexedDBの現在updatedAt と vaultSyncStateの記録値を比較するだけの
 * 単純な仕組み）が、実際には正しく適用できた変更を誤ってunsynced＝conflict
 * 候補と誤判定してしまう。record本体とvaultSyncStateを同一transaction内で
 * 書くことで、この中間状態自体を構造的に発生させない。
 *
 * 既存の`putConversation`/`putMemoryObject`/`saveSource`（record本体のみ）・
 * `setVaultSyncState`（ledgerのみ）は無変更のまま維持し、通常の書込経路
 * （vault.tsのwrite関数群）には一切影響しない。
 */
export async function putConversationAndMarkSynced(conversation: Conversation, syncKey: string, expectedStored?: Conversation): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["conversations", "vaultSyncState", "settings", "vaultOutbox"], "readwrite");
  try {
    // `expectedStored`: the COMPLETE snapshot the caller's merge was computed from (not just its version: local-only changes such as a revisit prompt do not
    // advance `updatedAt`); a record that differs now is never overwritten with a stale merge
    if (expectedStored !== undefined && JSON.stringify(await tx.objectStore("conversations").get(conversation.id)) !== JSON.stringify(expectedStored)) throw new ConcurrentModificationError(conversation.id);
    const s = await sanitizeTombstonedMemoryRefsInTx(tx, conversation, parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY)));
    await tx.objectStore("conversations").put(s.conversation);
    if (!s.changed) await tx.objectStore("vaultSyncState").put(conversation.updatedAt, syncKey);
  } catch (error) {
    await abortAndSettleTransaction(tx, error);
  }
  await tx.done;
}

export async function putMemoryObjectAndMarkSynced(memoryObject: MemoryObject, syncKey: string, expectedStored?: MemoryObject): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects", "vaultSyncState", "settings", "vaultOutbox"], "readwrite");
  try {
    const stored = await tx.objectStore("memoryObjects").get(memoryObject.id);
    assertMemoryLineage(stored, memoryObject);
    if (expectedStored !== undefined && JSON.stringify(stored) !== JSON.stringify(expectedStored)) throw new ConcurrentModificationError(memoryObject.id);
    // an edit that came from the Vault may still link to a Memory the user deleted: the link is dropped and the correction queued instead of marking the copy synced
    const s = await sanitizeTombstonedLinksInTx(tx, memoryObject, parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY)));
    await tx.objectStore("memoryObjects").put(s.memory);
    if (!s.changed) await tx.objectStore("vaultSyncState").put(memoryObject.updatedAt, syncKey);
  } catch (error) {
    await abortAndSettleTransaction(tx, error);
  }
  await tx.done;
}

export async function saveSourceAndMarkSynced(source: Source, syncKey: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["sources", "vaultSyncState"], "readwrite");
  try {
    await tx.objectStore("sources").put(source);
    await tx.objectStore("vaultSyncState").put(source.updatedAt, syncKey);
  } catch (error) {
    await abortAndSettleTransaction(tx, error);
  }
  await tx.done;
}

/**
 * 「IndexedDBに存在しなければ挿入し、同時にvaultSyncStateも確立する」を
 * 同一transactionで行う（Vault resyncの外部record import専用）。既に
 * 存在する場合は何もせずfalseを返す——`importMissingRecordsIfAbsent`と同じ
 * 「絶対に上書きしない」方針で、`add()`を使い構造的にも上書きを拒否させる。
 * 「insertはできたがvaultSyncStateだけ失敗した」という中間状態を作らないため、
 * 上のput系と同じく1つのtransactionにまとめている。
 */
export async function addConversationIfAbsentAndMarkSynced(
  conversation: Conversation,
  syncKey: string
): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction(["conversations", "vaultSyncState", "settings", "vaultOutbox"], "readwrite");
  let inserted = false;
  try {
    const store = tx.objectStore("conversations");
    const existing = await store.get(conversation.id);
    const tombs = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    if (blockedByTombstone(tombs, "conversation", conversation.id)) {
      // deleted by the user: never re-inserted from the Vault
    } else if (existing === undefined) {
      const s = await sanitizeTombstonedMemoryRefsInTx(tx, conversation, tombs);
      await store.add(s.conversation);
      if (!s.changed) await tx.objectStore("vaultSyncState").put(conversation.updatedAt, syncKey);   // a corrected copy differs from the Vault: queued, not "synced"
      inserted = true;
    }
  } catch (error) {
    await abortAndSettleTransaction(tx, error);
  }
  await tx.done;
  return inserted;
}

export async function addMemoryObjectIfAbsentAndMarkSynced(
  memoryObject: MemoryObject,
  syncKey: string
): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects", "vaultSyncState", "settings", "vaultOutbox"], "readwrite");
  let inserted = false;
  try {
    const store = tx.objectStore("memoryObjects");
    const existing = await store.get(memoryObject.id);
    const tombs = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    if (memoryBlocked(tombs, memoryObject)) {
      // deleted by the user: never re-inserted from the Vault
    } else if (existing === undefined) {
      const s = await sanitizeTombstonedLinksInTx(tx, memoryObject, tombs);
      await store.add(s.memory);
      if (!s.changed) await tx.objectStore("vaultSyncState").put(memoryObject.updatedAt, syncKey);   // a changed copy differs from the Vault: it is not "synced", it is queued
      inserted = true;
    }
  } catch (error) {
    await abortAndSettleTransaction(tx, error);
  }
  await tx.done;
  return inserted;
}

export async function addSourceIfAbsentAndMarkSynced(source: Source, syncKey: string): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction(["sources", "vaultSyncState"], "readwrite");
  let inserted = false;
  try {
    const store = tx.objectStore("sources");
    const existing = await store.get(source.id);
    if (existing === undefined) {
      await store.add(source);
      await tx.objectStore("vaultSyncState").put(source.updatedAt, syncKey);
      inserted = true;
    }
  } catch (error) {
    await abortAndSettleTransaction(tx, error);
  }
  await tx.done;
  return inserted;
}

// ---------------------------------------------------------------------------
// 新保存基盤（Phase 3-1）：Vault Outbox / Vault Identity / Migration Journal
//
// Phase 3-1時点ではまだどの既存保存経路からも呼ばれない（基盤のみ。既存の
// `putConversation`/`putConversationAndMarkSynced`等・既存のVault保存経路
// （vault.ts）には一切影響しない）。
// ---------------------------------------------------------------------------

export async function getVaultOutboxEntry(id: string): Promise<VaultOutboxEntry | undefined> {
  const db = await getDB();
  return db.get("vaultOutbox", id);
}

export async function putVaultOutboxEntry(entry: VaultOutboxEntry): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["vaultOutbox", "settings"], "readwrite");
  try {
    const kind: TombstoneKind | null = entry.recordType === "reflection" || entry.recordType === "memory" ? "memory" : entry.recordType === "conversation" ? "conversation" : null;
    const map = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    if (!kind || !blockedByTombstone(map, kind, entry.recordId)) await tx.objectStore("vaultOutbox").put(entry);
  } catch (e) { await abortAndSettleTransaction(tx, e); }
  await tx.done;
}

/** `status:"pending"`のentryだけを取得する（起動時reconcileが全record走査をしなくて済むための索引）。 */
export async function getPendingVaultOutboxEntries(): Promise<VaultOutboxEntry[]> {
  const db = await getDB();
  return db.getAllFromIndex("vaultOutbox", "by-status", "pending");
}

/** held entryの一覧（`by-status`インデックス。bootstrapの「ルール変更後の1回限りの再評価」専用）。 */
export async function getHeldVaultOutboxEntries(): Promise<VaultOutboxEntry[]> {
  const db = await getDB();
  return db.getAllFromIndex("vaultOutbox", "by-status", "held");
}

/**
 * Projectionの比較ルールのversionごとに「held outboxを再評価済みか」を記録する（settingsの1キー。DB schema変更なし）。
 * ルールが変わらない限り、heldは毎起動では再試行されない。
 */
const projectionHeldReevaluationKey = (ruleVersion: string) => `projectionHeldReevaluated:${ruleVersion}`;
export async function getProjectionHeldReevaluationMarker(ruleVersion: string): Promise<string | undefined> {
  const db = await getDB();
  const raw = await db.get("settings", projectionHeldReevaluationKey(ruleVersion));
  return typeof raw === "string" ? raw : undefined;
}
export async function setProjectionHeldReevaluationMarker(ruleVersion: string, at: string): Promise<void> {
  const db = await getDB();
  await db.put("settings", at, projectionHeldReevaluationKey(ruleVersion));
}

/**
 * Phase 3-7.1：`status:"done"`のentry一覧（done outbox integrity検証専用）。
 * `by-status`は同じ`status`フィールド上のindexのため、"pending"と同じくindexed
 * range query1回で済み、全件走査（`getAll`＋フィルタ）より軽量。
 */
export async function getDoneVaultOutboxEntries(): Promise<VaultOutboxEntry[]> {
  const db = await getDB();
  return db.getAllFromIndex("vaultOutbox", "by-status", "done");
}

export async function deleteVaultOutboxEntry(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("vaultOutbox", id);
}

export async function getVaultIdentityRecord(): Promise<VaultIdentityRecord | undefined> {
  const db = await getDB();
  return db.get("vaultIdentity", VAULT_IDENTITY_RECORD_ID);
}

export async function putVaultIdentityRecord(record: VaultIdentityRecord): Promise<void> {
  const db = await getDB();
  await db.put("vaultIdentity", record);
}

export async function getMigrationJournalEntry(id: string): Promise<MigrationJournalEntry | undefined> {
  const db = await getDB();
  return db.get("migrationJournal", id);
}

export async function putMigrationJournalEntry(entry: MigrationJournalEntry): Promise<void> {
  const db = await getDB();
  await db.put("migrationJournal", entry);
}

export async function getPendingMigrationJournalEntries(): Promise<MigrationJournalEntry[]> {
  const db = await getDB();
  return db.getAllFromIndex("migrationJournal", "by-status", "pending");
}

/** canonical storeの名前と、そこに入るrecordの型を対応付ける（下の関数群の型安全のためだけに使う）。 */
interface CanonicalStoreValueMap {
  conversations: Conversation;
  memoryObjects: MemoryObject;
  sources: Source;
}

/**
 * 新保存基盤 Invariant 1・Invariant 2の実装本体：
 *   Invariant 1：canonical recordとoutbox enqueueは同一IndexedDB transaction。
 *   Invariant 2：canonical更新がcommitされたのにoutboxが存在しない状態を、
 *                通常write pathでは作れない。
 *
 * `addSourceIfAbsentAndMarkSynced`（上）・`putConversationAndMarkSynced`（下）と
 * 同じ、既存の「record本体と付随する台帳を同一transactionで書く」パターンを、
 * 通常の保存経路向けに一般化したものである。IndexedDBのtransactionはstore横断で
 * atomicなため、このtransactionが失敗すれば（例：vaultOutbox側のput失敗）、
 * canonical record側の書き込みも一切反映されない——「canonical recordだけ更新
 * できたがoutboxへの登録に失敗した」という中間状態は構造的に発生しない
 * （`vaultOutbox.test.ts`・`db.foundation.test.ts`のInvariant 1/2テスト参照）。
 *
 * `record.updatedAt`が既存outbox entryの`recordUpdatedAt`と異なる場合、
 * 既存entryの進捗（steps/status/attempt）に関わらず必ず新しいpending entryへ
 * 差し替える（`buildOutboxEntryForUpdate`参照）——「Vault projection不要な
 * canonical更新」という特殊状態を作らないため。
 */
async function putCanonicalRecordWithOutboxInternal<S extends keyof CanonicalStoreValueMap>(
  storeName: S,
  recordType: string,
  record: CanonicalStoreValueMap[S] & { id: string; updatedAt: string },
  now: string,
  /** checked INSIDE the transaction before anything is written (e.g. the tombstones); a throw writes nothing */
  guard?: (tx: { objectStore(name: string): any }) => Promise<CanonicalStoreValueMap[S] | void>   // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<VaultOutboxEntry> {
  const db = await getDB();
  const outboxId = vaultOutboxIdFor(recordType, record.id);
  const tx = db.transaction(guard ? [storeName, "vaultOutbox", "settings"] : [storeName, "vaultOutbox"], "readwrite");
  let entry: VaultOutboxEntry;
  try {
    const replaced = guard ? await guard(tx) : undefined;
    if (replaced) record = replaced as typeof record;
    const outboxStore = tx.objectStore("vaultOutbox");
    const existing = await outboxStore.get(outboxId);
    if (storeName === "memoryObjects") assertMemoryLineage(await tx.objectStore(storeName).get(record.id) as MemoryObject | undefined, record as unknown as MemoryObject);
    entry = buildOutboxEntryForUpdate(existing, recordType, record.id, record.updatedAt, now);
    await Promise.all([tx.objectStore(storeName).put(record), outboxStore.put(entry)]);
  } catch (error) {
    await abortAndSettleTransaction(tx, error);
  }
  await tx.done;
  return entry!;
}

export async function putConversationWithOutbox(conversation: Conversation, now: string = new Date().toISOString()): Promise<VaultOutboxEntry> {
  // a conversation the user deleted is never recreated by a stale chat tab / an in-flight request (the check runs inside the same transaction)
  return putCanonicalRecordWithOutboxInternal("conversations", "conversation", conversation, now, async (tx) => {
    const tombs = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    if (blockedByTombstone(tombs, "conversation", conversation.id)) throw new TombstonedRecordError("conversation", conversation.id);
    return withoutDeletedMemoryRefs(conversation, tombs);
  });
}

/** `recordType`は既定で`"memory"`（normal Memory）。Reflectionを書く場合は`"reflection"`を渡す。 */
/**
 * The write API for Memories PRODUCED BY A CAPTURE. The conversation that produced the content is passed independently of the record: the record's own
 * `conversationId` can be copied from a stored Memory (the 2026 bug spread a stored Memory of conversation A and replaced its content with text derived
 * from conversation B, so the copied lineage still said A). Content produced by B can only be saved under B's lineage, and the stored Memory (if any)
 * must be B's own - otherwise nothing is written (the transaction, including the Outbox entry, is rolled back).
 */
export async function putCapturedMemoryWithOutbox(
  memoryObject: MemoryObject,
  producedByConversationId: string,
  recordType: "memory" | "reflection" = "memory",
  now: string = new Date().toISOString()
): Promise<VaultOutboxEntry> {
  if (!producedByConversationId || memoryObject.conversationId !== producedByConversationId) throw new MemoryLineageViolationError(memoryObject.id);
  return putCanonicalRecordWithOutboxInternal("memoryObjects", recordType, memoryObject, now, async (tx) => {
    const tombstones = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    // neither the producing conversation nor the Memory id may be a record the user deleted
    if (blockedByTombstone(tombstones, "conversation", producedByConversationId)) throw new TombstonedRecordError("conversation", producedByConversationId);
    if (memoryBlocked(tombstones, memoryObject)) throw new TombstonedRecordError("memory", memoryObject.id);
  });
}

export async function putMemoryObjectWithOutbox(
  memoryObject: MemoryObject,
  recordType: "memory" | "reflection" = "memory",
  now: string = new Date().toISOString()
): Promise<VaultOutboxEntry> {
  return putCanonicalRecordWithOutboxInternal("memoryObjects", recordType, memoryObject, now, async (tx) => {
    const tombs = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    if (memoryBlocked(tombs, memoryObject)) throw new TombstonedRecordError("memory", memoryObject.id);
    // a snapshot taken before the user deleted a linked Memory (another tab, a long-running migration) must not bring the link back: it is dropped, as a NEW version
    // later than both the snapshot and what is stored now, so the corrected record is what the Vault receives
    if (!tombs) return;
    const kept = (memoryObject.links ?? []).filter((l) => {
      const otherId = l.sourceId === memoryObject.id ? l.targetId : l.sourceId;
      return otherId === memoryObject.id || !tombs[tombstoneId("memory", otherId)];
    });
    if (kept.length === (memoryObject.links ?? []).length) return;
    const stored = (await tx.objectStore("memoryObjects").get(memoryObject.id)) as MemoryObject | undefined;
    const base = stored && Date.parse(stored.updatedAt) > Date.parse(memoryObject.updatedAt) ? stored.updatedAt : memoryObject.updatedAt;
    const at = strictlyLaterInstant(base, now);
    return { ...memoryObject, links: kept, updatedAt: at, metadata: { ...memoryObject.metadata, updatedAt: at } };
  });
}

export async function putSourceWithOutbox(source: Source, now: string = new Date().toISOString()): Promise<VaultOutboxEntry> {
  return putCanonicalRecordWithOutboxInternal("sources", "source", source, now);
}

/**
 * 新しいVaultフォルダを選択した直後にのみ呼ぶこと（同じVaultへの再認可では呼ばない）。
 * 台帳はどのフォルダに対する同期状況かを区別しないため、フォルダが変わった場合に
 * クリアしないと「新フォルダには実際は書き込まれていないのに同期済み」と誤判定し、
 * 書き込みが漏れる事故につながる。
 */
/**
 * vaultSyncState（Vault同期済み台帳）に1件でも記録があるか。読み取りのみ（readonly transaction）。
 * 台帳が空＝「この端末は、現在の保存先へ書き込んだ記録を持たない」ことを意味する
 * （保存先の新規接続・別Vaultへの切替では、直前に`clearVaultSyncState`されるため空になる）。
 * `ensureVaultBaseline`（vault.ts）が、空に見えるだけの「失われたVault」と本当に新しい空Vaultを
 * 区別するために使う。
 */
export async function hasAnyVaultSyncState(): Promise<boolean> {
  const db = await getDB();
  const cursor = await db.transaction("vaultSyncState", "readonly").store.openKeyCursor();
  return cursor !== null;
}

/**
 * vaultSyncState（Vault同期済み台帳）から、1件のキーだけを削除する。記録本体（conversations等）には
 * 一切触れない。`vaultOrphanCleanup.ts`が、本体が存在しない記録の台帳だけを整理するために使う。
 */
export async function deleteVaultSyncState(key: string): Promise<void> {
  const db = await getDB();
  await db.delete("vaultSyncState", key);
}

export async function clearVaultSyncState(): Promise<void> {
  const db = await getDB();
  await db.clear("vaultSyncState");
}

export async function saveVaultHandle(handle: FileSystemDirectoryHandle) {
  const db = await getDB();
  await db.put("handles", handle, "vaultRoot");
}

export async function loadVaultHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await getDB();
  return db.get("handles", "vaultRoot");
}

export async function clearVaultHandle() {
  const db = await getDB();
  await db.delete("handles", "vaultRoot");
}

/**
 * Beta：ユーザー自身のAPIキー。ブラウザ（IndexedDB）にのみ保持し、
 * Tsumugi側のサーバーには永続保存しない（API Routeへはリクエストヘッダーで都度渡す）。
 *
 * providerごとに別のキーとして保存する。Geminiのキー名は既存ユーザーのデータを
 * 壊さないよう、Gemini単独運用時から使っていた"geminiApiKey"をそのまま流用する
 * （新しい命名規則へ移行する必要が無いため、マイグレーション処理も不要）。
 * 引数を省略した場合は常にGeminiを指す（chat以外の既存呼び出し元は無変更のまま
 * Geminiだけを使い続けられる）。
 */
const API_KEY_STORAGE_KEY: Record<AIProviderName, string> = {
  gemini: "geminiApiKey",
  openai: "openaiApiKey",
  claude: "claudeApiKey",
};

export async function saveApiKey(apiKey: string, provider: AIProviderName = "gemini") {
  const db = await getDB();
  await db.put("settings", apiKey, API_KEY_STORAGE_KEY[provider]);
}

export async function loadApiKey(provider: AIProviderName = "gemini"): Promise<string | undefined> {
  const db = await getDB();
  return db.get("settings", API_KEY_STORAGE_KEY[provider]);
}

export async function clearApiKey(provider: AIProviderName = "gemini") {
  const db = await getDB();
  await db.delete("settings", API_KEY_STORAGE_KEY[provider]);
}

/**
 * Beta：「APIキーを登録するprovider」とは別の概念。chatの送信（companion/coach/analyst）に
 * どのproviderを使うかだけを持つ設定値。未設定時はGemini（既存動作を完全に維持するため）。
 * chat以外の機能（Capture/Connect/Reflection/問いかけ生成）はこの設定を参照しない
 * （今回のPhaseでは固定のまま）。
 */
const CHAT_PROVIDER_KEY = "chatProvider";

export async function saveChatProvider(provider: AIProviderName) {
  const db = await getDB();
  await db.put("settings", provider, CHAT_PROVIDER_KEY);
}

export async function loadChatProvider(): Promise<AIProviderName> {
  const db = await getDB();
  const value = await db.get("settings", CHAT_PROVIDER_KEY);
  return value === "openai" || value === "claude" ? value : "gemini";
}

/**
 * Vault境界の安全性（H4：複数タブ間でのVault privacy boundary対応）。
 *
 * 「現在アクティブなVaultの世代」を表す単調増加のカウンタ。既存の`settings`ストア
 * （汎用KVストア）へ1キー追加するだけで、DB schemaの変更は行わない。
 * 別Vaultへの切替が確定した瞬間（`navigator.locks`の排他ロック内、IndexedDBの
 * clearより前）にのみ`bumpActiveVaultEpoch()`でインクリメントする。
 *
 * 各タブは、この値を自分の「タブローカルな信じているepoch」（vaultWorldLock.tsの
 * `tabVaultEpoch`）と比較することで、「自分のVault世界は今も共有ストレージの
 * アクティブなVaultと一致しているか」を、Memory Worldへの読み書きの直前に
 * 都度確認する（`withVaultWorldRead`/`runVaultSwitchExclusive`参照）。
 *
 * 未設定（アプリ初回起動、一度もVault操作をしていない状態）は0として扱う。
 */
const ACTIVE_VAULT_EPOCH_KEY = "activeVaultEpoch";

/**
 * Codexレビュー指摘（journal値validation）対応：epochとして「valid」とみなすのは
 * finite・integer・0以上・Number.isSafeInteger、かつ保存文字列が`String(parsed)`と
 * 完全一致するもの（roundtrip確認）だけにする。roundtrip確認を入れる理由：
 * `Number("")`は`0`、`Number(" 5")`は`5`になる等、`Number(...)`だけでは
 * 空文字列・前後空白付き文字列・16進数表記等の「一見数値だが本来は不正な入力」を
 * 弾けないため（`String(0) !== ""`となることを利用して弾く）。
 */
function isValidStoredEpochValue(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const parsed = Number(raw);
  return (
    Number.isFinite(parsed) &&
    Number.isInteger(parsed) &&
    Number.isSafeInteger(parsed) &&
    parsed >= 0 &&
    String(parsed) === raw
  );
}

export type VaultEpochStatus = { status: "missing" } | { status: "valid"; epoch: number } | { status: "invalid" };

function parseStoredEpoch(raw: unknown): VaultEpochStatus {
  if (raw === undefined) return { status: "missing" };
  if (!isValidStoredEpochValue(raw)) return { status: "invalid" };
  return { status: "valid", epoch: Number(raw) };
}

/**
 * Codexレビュー指摘（journal値validation）対応：未設定（一度もbumpされていない、
 * アプリ初回起動）は0として扱う（正常な初期状態）。保存値が存在するのに壊れている
 * （上記validationを満たさない）場合は、0へ黙って丸めず例外を投げる——呼び出し元は
 * 必ずこれをcatchして安全側（Memory World操作の拒否）に倒すこと。既存の呼び出し元
 * （withVaultWorldRead・各Vault切替の排他ロックコールバック等）は全てこの契約に
 * 従って実装されている（詳細はそれぞれのコメント参照）。
 */
export async function getActiveVaultEpoch(): Promise<number> {
  const db = await getDB();
  const raw = await db.get("settings", ACTIVE_VAULT_EPOCH_KEY);
  const status = parseStoredEpoch(raw);
  if (status.status === "missing") return 0;
  if (status.status === "invalid") {
    throw new Error(`[Tsumugi] invalid activeVaultEpoch value in storage: ${JSON.stringify(raw)}`);
  }
  return status.epoch;
}

/**
 * 別Vaultへの切替コミット（`navigator.locks`の排他ロック内）からのみ呼ぶこと。
 * 複数タブから同時に呼ばれないことは、呼び出し元が排他ロックで保証する。
 *
 * Codexレビュー指摘（再発、High）対応：以前は`getActiveVaultEpoch()`が例外を
 * 投げた場合（＝保存値が壊れている場合）に0へfallbackして1から数え直していたが、
 * これはepochの単調増加という大前提を崩す——古いepoch世代の値を偶然にも
 * 再利用してしまい、その古い世代を"覚えている"タブ（tabVaultEpochが偶然その値と
 * 一致するタブ）が誤って再承認されうる。ここでは一切fallbackせず、
 * `getActiveVaultEpoch()`の例外（IndexedDB read failure・invalid stored value等）を
 * そのままrejectさせる（fail-fast）。
 *
 * `expectedEpoch`（Codexレビュー指摘：expected epoch付きbump）：呼び出し元が
 * 排他ロック内で確認済みの「今のactiveVaultEpochはこの値のはず」を渡すこと。
 * 内部で改めてactiveVaultEpochを読み直し、`expectedEpoch`と一致しない場合は
 * 例外を投げる（呼び出し元はstale扱いにすること）。一致した場合のみ
 * `expectedEpoch + 1`を書き込む。これにより「呼び出し元がepochを確認した
 * 瞬間」と「実際にbumpする瞬間」の間に想定外の変更が入っていないかを、
 * このAPI自体でも再確認できる（排他ロック下では通常起こらないはずだが、
 * APIとしての安全側の設計として持たせる）。
 *
 * epoch overflow（`expectedEpoch + 1`が`Number.MAX_SAFE_INTEGER`を超える場合）も
 * 例外を投げる。wrap・resetは行わない。
 */
export async function bumpActiveVaultEpoch(expectedEpoch: number): Promise<number> {
  const db = await getDB();
  const current = await getActiveVaultEpoch();
  if (current !== expectedEpoch) {
    throw new Error(
      `[Tsumugi] bumpActiveVaultEpoch: expected activeVaultEpoch=${expectedEpoch} but found ${current}; refusing (stale).`
    );
  }
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error(`[Tsumugi] bumpActiveVaultEpoch: epoch overflow (current=${current})`);
  }
  await db.put("settings", String(next), ACTIVE_VAULT_EPOCH_KEY);
  return next;
}

/**
 * Codexレビュー指摘（Medium→H4クローズ条件：handle/epoch/sync state failure
 * consistency）対応：「activeVaultEpochを何番まで、実際にhandle保存・IndexedDB
 * clear等の副作用を含めて完全にcommitし終えたか」を表す、小さなjournal。
 * 既存の`settings`ストアへ1キー追加するだけで、DB schemaの変更・vaultId
 * namespace導入は行わない。
 *
 * 使い方（呼び出し元＝ChatScreen.tsxのVault切替コミット）：
 * `bumpActiveVaultEpoch()`で新epochへ進めた後、そのepochに対応する副作用
 * （IndexedDB clear・新Vault handle保存・sync state clear等）が"全て"成功した
 * 最後にだけ`markVaultEpochCommitted(newEpoch)`を呼ぶ。途中のどこか
 * （awaitの合間・例外・タブクラッシュ・リロード等）で中断した場合、
 * `committedVaultEpoch`は古いままになる。
 *
 * 起動時（ChatScreen.tsxの起動effect）・および各Memory World操作の直前
 * （vaultWorldLock.tsのwithVaultWorldRead）は、`getActiveVaultEpoch()`と
 * `getCommittedVaultEpoch()`を読み比べ、一致しない場合（＝直前のswitchが
 * 完了しないまま終了した形跡）は、保存済みhandleを信用せず「未接続」として
 * 扱う（fail-closed。new epoch + 古い/不整合なhandleを正常worldとして採用しない）。
 *
 * Codexレビュー指摘（再発、High）対応：「journal keyが存在しない＝missing」を
 * 安易に0へ変換してはいけない。missingには2つの全く異なる意味がありうる：
 *   (a) legacy：この端末でjournal方式自体がまだ有効化されていない
 *       （既存Betaからの初回起動。9c07299時点のユーザーはこちら）。
 *   (b) 新方式が既に有効化された後の、最初のswitch中の失敗でjournalが
 *       書き込まれないまま終了した（＝本物のincomplete）。
 * (a)と(b)を区別できないまま「missing→0扱い」にすると、(b)のケースを
 * 誤って安全な状態として通してしまう（今回Codexが指摘したHigh-2）。
 * この区別は`isVaultWorldJournalMigrated()`（下記）という別のmigration
 * markerで行う——`getCommittedVaultEpoch()`自体は「missing/valid/invalid」の
 * 3状態を正直に返すだけにする（呼び出し元がmigration markerと組み合わせて
 * legacy/incompleteを判定する）。
 */
const COMMITTED_VAULT_EPOCH_KEY = "committedVaultEpoch";

/** activeVaultEpochと同じ意味の3状態（`VaultEpochStatus`をそのまま再利用）。 */
export type CommittedVaultEpochStatus = VaultEpochStatus;

/**
 * Codexレビュー指摘（journal値validation）対応：activeVaultEpochと同じ厳密な
 * validation（`parseStoredEpoch`）を使う。「missing→0」への変換は絶対に行わない
 * （呼び出し元がmissing/valid/invalidを明示的に区別して判定する）。
 */
export async function getCommittedVaultEpoch(): Promise<CommittedVaultEpochStatus> {
  const db = await getDB();
  const raw = await db.get("settings", COMMITTED_VAULT_EPOCH_KEY);
  return parseStoredEpoch(raw);
}

/**
 * そのepochへのswitchに伴う副作用（IndexedDB clear・handle保存・sync state clear等）が
 * 全て成功した後、必ず最後に（`navigator.locks`の排他ロックを保持したまま）呼ぶこと。
 */
export async function markVaultEpochCommitted(epoch: number): Promise<void> {
  const db = await getDB();
  await db.put("settings", String(epoch), COMMITTED_VAULT_EPOCH_KEY);
}

/**
 * C1（軽量Registry index・多tab安全性設計のbootstrap/rebuild foundation）対応：
 * `activeVaultEpoch`（Vault切替の世代管理）とは完全に別物の、Registry
 * ownership用の単調増加カウンタ。既存の`settings`ストアへ1キー追加するだけで、
 * DB schemaの変更は行わない。`activeVaultEpoch`の意味・読み書き経路（H4の
 * Vault切替判定）には一切触れない。
 *
 * bumpするのは、`registry-meta.json`の`registryGeneration`が進む操作
 * （full resync/rebuildの成功commit、将来のG成功）だけ。C1では
 * `resyncVaultRegistry`からのbumpのみを実装し、read/checkする消費側
 * （将来のOWNED_DIRTY mutationのfast path）はまだ実装しない。
 *
 * 未設定（一度もbumpされていない）は0として扱う。validation・CAS方式の
 * bump（`expectedEpoch`一致時のみ進める、overflow検出）は`activeVaultEpoch`と
 * 完全に同じ契約にする（`parseStoredEpoch`/`isValidStoredEpochValue`を
 * そのまま再利用）。
 */
const REGISTRY_GENERATION_EPOCH_KEY = "registryGenerationEpoch";

export async function getRegistryGenerationEpoch(): Promise<number> {
  const db = await getDB();
  const raw = await db.get("settings", REGISTRY_GENERATION_EPOCH_KEY);
  const status = parseStoredEpoch(raw);
  if (status.status === "missing") return 0;
  if (status.status === "invalid") {
    throw new Error(`[Tsumugi] invalid registryGenerationEpoch value in storage: ${JSON.stringify(raw)}`);
  }
  return status.epoch;
}

/**
 * C1では`resyncVaultRegistry`の成功commitの最終ステップ（`runVaultWorldExclusive`
 * 排他ロック保持中、registry-index.json/registry-meta.json書き込み成功後）から
 * のみ呼ぶ。`activeVaultEpoch`の`bumpActiveVaultEpoch`と同じCAS契約：
 * `expectedEpoch`と現在値が一致した場合のみ`+1`する。一致しない場合・
 * overflowの場合は例外を投げ、fallbackしない（fail-fast、単調増加を崩さない）。
 *
 * Medium修正（Codexレビュー指摘）：read→比較→incrementの一連を単一の
 * readwrite transaction内で完結させる（`getRegistryGenerationEpoch()`＋
 * `db.put()`という2つの独立したtransactionに分けない）。これにより、
 * 同じ`expectedEpoch`を持つ2つの呼び出しが本当に同時に実行された場合でも、
 * IndexedDBのtransaction直列化によって必ず一方だけが成功し、もう一方は
 * transaction commit後に読み直した値が既に進んでいるため
 * `expected mismatch`として確実に失敗する（2つの独立readのtransactionでは、
 * 両方が同じ「古い」値を読んでしまい両方成功するTOCTOUが起こり得た）。
 *
 * Medium再修正（Codexレビュー再指摘）：`store.get`/`store.put`のreject・
 * invalid・expected mismatch・overflowのいずれの失敗パスでも、
 * transactionを未回収のまま放置しない。既存の`abortAndSettleTransaction`
 * （`importMissingRecordsIfAbsent`等で既に確立済みのpattern）へ処理を
 * 集約し、`tx.abort()`→`tx.done`のreject回収→元errorの再throw、という
 * 既存の後始末を全失敗パスで行う。成功パスのみ`tx.done`をawaitして
 * commitまで待つ（committed後に`next`を返す）。
 *
 * TypeScript修正（Vercel build指摘・Codexレビュー対応）：`next`を`try`の
 * 外側で`let`宣言し、失敗パス側の`abortAndSettleTransaction`（戻り値
 * `Promise<never>`、必ずthrowする）に実質的な後始末を任せる構成では、
 * TypeScriptのdefinite assignment解析が「`next`はcatch節を経由しても
 * 必ず代入済みである」ことを認識できず、`return next;`が
 * "used before being assigned"として型エラーになった（実機のVercel build
 * で確認）。CAS契約（単一readwrite transaction内でget→validate→expected
 * compare→next算出→put→tx.done、失敗時は`abortAndSettleTransaction`で
 * 後始末しrethrow）自体は一切変更せず、`next`の算出・`tx.done`のawait・
 * `return`を全て同じ`try`ブロック内で完結させることで、「成功経路でのみ
 * `next`を使い、そのまま返す」という構造をTypeScriptが素直に検証できる
 * 形にした。
 *
 * TypeScript再修正（Vercel build再指摘対応）：上記の対応後も、catch節が
 * `await abortAndSettleTransaction(tx, error);`のみで終わる構成では、
 * TypeScriptの「関数が値を返さずに終わりうるかどうか」のcontrol flow解析が
 * `Promise<never>`をawaitした式の直後を十分にnarrowできず、"Function lacks
 * ending return statement and return type does not include 'undefined'"
 * という型エラーになった（実機のVercel buildで確認）。`abortAndSettleTransaction`
 * 自体の実装・semantics（`tx.abort()`→`tx.done`のreject回収→`throw error;`で
 * 必ず終わる）は一切変更していない——catch節の末尾に、TypeScriptが構文上
 * 確実に「ここで関数が終わらない」と認識できる明示的な`throw error;`を
 * 追加しただけである。`abortAndSettleTransaction`は内部で必ず`throw error;`
 * するため、この`throw error;`はruntime上到達しない（既存のCAS/後始末の
 * 挙動には一切影響しない）が、TypeScriptの静的解析上は「この関数はここで
 * 必ず終了する」ことを曖昧さ無く保証する。
 */
export async function bumpRegistryGenerationEpoch(expectedEpoch: number): Promise<number> {
  const db = await getDB();
  const tx = db.transaction("settings", "readwrite");
  const store = tx.objectStore("settings");

  try {
    const raw = await store.get(REGISTRY_GENERATION_EPOCH_KEY);
    const status = parseStoredEpoch(raw);
    if (status.status === "invalid") {
      throw new Error(`[Tsumugi] invalid registryGenerationEpoch value in storage: ${JSON.stringify(raw)}`);
    }
    const current = status.status === "missing" ? 0 : status.epoch;
    if (current !== expectedEpoch) {
      throw new Error(
        `[Tsumugi] bumpRegistryGenerationEpoch: expected registryGenerationEpoch=${expectedEpoch} but found ${current}; refusing (stale).`
      );
    }
    const next = current + 1;
    if (!Number.isSafeInteger(next)) {
      throw new Error(`[Tsumugi] bumpRegistryGenerationEpoch: epoch overflow (current=${current})`);
    }
    await store.put(String(next), REGISTRY_GENERATION_EPOCH_KEY);
    await tx.done;
    return next;
  } catch (error) {
    await abortAndSettleTransaction(tx, error);
    // 到達しない（abortAndSettleTransactionは内部で必ずthrowする）。TypeScriptの
    // control flow解析へ「この関数はここで正常終了しない」ことを明示するためだけの
    // 冗長なthrow。
    throw error;
  }
}

/**
 * Codexレビュー指摘（既存Beta migration）対応：「committedVaultEpochキー自体が
 * まだ存在しない」を、常に安全な"legacy"とみなしてよいのは、この端末で
 * journal方式（committedVaultEpoch）がまだ一度も有効化されていない場合だけ。
 * 一度有効化された後にjournalが失われた（＝本物のincomplete）場合と
 * 区別するため、journal方式自体の有効化を示す別マーカーを持つ。
 *
 * 値の中身自体は問わず、キーの存在だけを見る（一度でも
 * `markVaultWorldJournalMigrated()`されていれば、二度と"legacy"扱いへは
 * 戻さない——後述のmigration手順が「起動のたびに現在のhandleを無条件に
 *信用し直す」という危険な繰り返しにならないようにするため）。
 */
const VAULT_WORLD_JOURNAL_VERSION_KEY = "vaultWorldJournalVersion";
/** 数値として持つ（将来のmigrationで比較・分岐しやすくするため）。保存形式は他のepoch値と
 * 同じ文字列化した数値。 */
const CURRENT_VAULT_WORLD_JOURNAL_VERSION = 1;

export type VaultWorldJournalVersionStatus =
  | { status: "missing" }
  | { status: "current" }
  | { status: "unexpected"; raw: string };

/**
 * Codexレビュー指摘（migration version marker）対応：「キーが存在するか」だけでなく、
 * 値そのものを検証する。
 * - missing：この端末でjournal方式自体がまだ一度も有効化されていない
 *   （legacy／partial migration判定へ進む）。
 * - current：現在のjournal方式（version 1）が正しく有効化済み。
 * - unexpected：キーは存在するが、想定するversion番号と一致しない
 *   （壊れた値、または将来のversion番号だが今のコードが対応していない等）。
 *   legacy扱いは絶対にせず、fail-closedへ倒す（「一度migrated済みの端末を
 *   二度とlegacy扱いへ戻さない」という既存の原則の一部）。
 */
export async function getVaultWorldJournalVersion(): Promise<VaultWorldJournalVersionStatus> {
  const db = await getDB();
  const raw = await db.get("settings", VAULT_WORLD_JOURNAL_VERSION_KEY);
  if (raw === undefined) return { status: "missing" };
  if (raw === String(CURRENT_VAULT_WORLD_JOURNAL_VERSION)) return { status: "current" };
  return { status: "unexpected", raw };
}

/**
 * legacy migration（既存Betaからの初回起動）が、現在のVault world（handle/epoch）を
 * 正常に確認し終えた最後にだけ呼ぶこと。`markVaultEpochCommitted()`より必ず後に
 * 呼ぶこと（途中で中断した場合、"committedVaultEpochは書けたがmigrated markerは
 * 書けていない"という状態の方が安全——次回起動時、migration処理をもう一度
 * 現在のhandleから正しくやり直せる。逆順だと"migrated済みなのにcommitted無し"
 * という、通常のincomplete判定と見分けが付かない状態を作ってしまう）。
 */
export async function markVaultWorldJournalMigrated(): Promise<void> {
  const db = await getDB();
  await db.put("settings", String(CURRENT_VAULT_WORLD_JOURNAL_VERSION), VAULT_WORLD_JOURNAL_VERSION_KEY);
}

/**
 * Vault Recovery Apply（旧記録の安全な復旧）の永続journal。既存の`settings`ストアへ1キー追加するだけで、
 * DB schemaの変更は行わない。値はJSON文字列1つ（内容の解釈・検証は`vaultRecoveryJournal.ts`の責務）。
 * Vault切替でIndexedDBのMemory dataをclearしても、このキーは消えない（journal自身がworld epochを
 * 持ち、別のworldのjournalは通常の書き込みを止めない）。完全削除ではDB全体が消えるため一緒に消える。
 */
const VAULT_RECOVERY_JOURNAL_KEY = "vaultRecoveryJournal";

/**
 * Recovery背景検査の「検査済み」記録（Vaultごと）。値は`{ build, clean }`のJSON文字列1つ。`build`はアプリのビルド識別子
 * （新しいバージョンになったら1回だけ再検査する）、`clean`は検査結果（正常か）。plan本体や件数は保存しない。
 */
export interface RecoveryCheckMarker { build: string; clean: boolean }
const recoveryCheckKey = (worldKey: string) => `recoveryCheck:${worldKey}`;
/**
 * Recovery検査の記録の鍵。Vault identityがあれば`vaultId`、まだ無ければ（identityが保留の保存先でも検査できるよう）
 * このorigin・このIndexedDBの世界を表す`world:<activeVaultEpoch>`。identityの有無・端末種別には依存しない。
 */
export async function getRecoveryCheckWorldKey(): Promise<string> {
  const identity = await getVaultIdentityRecord();
  if (identity?.vaultId) return identity.vaultId;
  return `world:${await getActiveVaultEpoch()}`;
}
export async function getRecoveryCheckMarker(vaultId: string): Promise<RecoveryCheckMarker | undefined> {
  const db = await getDB();
  const raw = await db.get("settings", recoveryCheckKey(vaultId));
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && typeof (value as RecoveryCheckMarker).build === "string" && typeof (value as RecoveryCheckMarker).clean === "boolean"
      ? { build: (value as RecoveryCheckMarker).build, clean: (value as RecoveryCheckMarker).clean } : undefined;
  } catch { return undefined; }
}
export async function setRecoveryCheckMarker(vaultId: string, marker: RecoveryCheckMarker): Promise<void> {
  const db = await getDB();
  await db.put("settings", JSON.stringify({ build: marker.build, clean: marker.clean }), recoveryCheckKey(vaultId));
}

export async function readRecoveryJournalRaw(): Promise<string | undefined> {
  const db = await getDB();
  const raw = await db.get("settings", VAULT_RECOVERY_JOURNAL_KEY);
  return typeof raw === "string" ? raw : undefined;
}

export async function writeRecoveryJournalRaw(text: string): Promise<void> {
  const db = await getDB();
  await db.put("settings", text, VAULT_RECOVERY_JOURNAL_KEY);
}

/**
 * 新保存基盤 Phase 3-5：Production Bootstrap Migrationの永続状態。既存Recovery
 * journalと同じパターン（`settings`ストアへ1キー、値はJSON文字列1つ）で、
 * `vaultProductionMigration.ts`がrestartable/idempotentなmigrationを行うために使う。
 */
const PRODUCTION_MIGRATION_STATE_KEY = "productionBootstrapMigration";

export async function readProductionMigrationStateRaw(): Promise<string | undefined> {
  const db = await getDB();
  const raw = await db.get("settings", PRODUCTION_MIGRATION_STATE_KEY);
  return typeof raw === "string" ? raw : undefined;
}

export async function writeProductionMigrationStateRaw(text: string): Promise<void> {
  const db = await getDB();
  await db.put("settings", text, PRODUCTION_MIGRATION_STATE_KEY);
}

/**
 * Android保存方式の見直し：Androidの既定Vault backendをFile System Access
 * （SAF/document provider経由）からOPFS（この端末専有の内部領域）へ切り替えるにあたり、
 * 新しい空のOPFS VaultについてRegistry baseline（`resyncVaultRegistry`の初回実行）を
 * 確立済みかどうかを、端末ごとに一度だけ記録する。`VAULT_WORLD_JOURNAL_VERSION_KEY`と
 * 同じパターンで、値の中身自体は問わず、キーの存在だけを見る。
 * 既存IndexedDBデータ（conversations/memoryObjects/sources）・旧外部Vaultへは
 * このmarker自体は一切触れない。
 */
const ANDROID_OPFS_VAULT_INITIALIZED_KEY = "androidOpfsVaultInitialized";

export async function isAndroidOpfsVaultInitialized(): Promise<boolean> {
  const db = await getDB();
  const raw = await db.get("settings", ANDROID_OPFS_VAULT_INITIALIZED_KEY);
  return raw !== undefined;
}

/**
 * Registry baseline確立（`resyncVaultRegistry`の初回実行）が正常に完了したと
 * 呼び出し元（vault.ts）が確認した後にのみ呼ぶこと。途中失敗した場合はこの関数を
 * 呼ばないことで、次回起動時に再試行できるようにする（`markVaultWorldJournalMigrated`
 * と同じ「成功確認後にのみmarkerを立てる」原則）。
 */
export async function markAndroidOpfsVaultInitialized(): Promise<void> {
  const db = await getDB();
  await db.put("settings", "true", ANDROID_OPFS_VAULT_INITIALIZED_KEY);
}

/** 「過去からの問いかけ」機能が直近に表示したMemory IDの一覧（新しいものが末尾）。同じMemoryの連続表示を避けるためだけに使う。 */
const LAST_PROMPTED_MEMORY_IDS_KEY = "lastPromptedMemoryIds";
const MAX_LAST_PROMPTED_MEMORY_IDS = 5;

export async function loadLastPromptedMemoryIds(): Promise<string[]> {
  const db = await getDB();
  const raw = await db.get("settings", LAST_PROMPTED_MEMORY_IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export async function saveLastPromptedMemoryIds(ids: string[]) {
  const db = await getDB();
  const trimmed = ids.slice(-MAX_LAST_PROMPTED_MEMORY_IDS);
  await db.put("settings", JSON.stringify(trimmed), LAST_PROMPTED_MEMORY_IDS_KEY);
}

/**
 * idのConnect処理を開始してよいかを、1つのreadwriteトランザクション内のread→writeで判定する。
 * IndexedDBのトランザクションは同一ストアに対して直列化されるため、React StrictModeによる
 * useEffectの二重実行や、複数タブから同時に呼ばれた場合でも、trueを返すのは必ず1回だけになる
 * （connectStateへの完了記録を待ってから判定するのでは、この2ケースの競合を防げないため）。
 *
 * 既存の"done"はクレームしない。"in-progress"はstaleAfterMsより新しければ他の処理中とみなし
 * クレームしない。staleAfterMsより古い"in-progress"は、異常終了（クラッシュ等）からの回復として
 * 再クレームを許可する。
 */
export async function claimConnectState(id: string, staleAfterMs: number): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction("connectState", "readwrite");
  const store = tx.objectStore("connectState");
  const existing = await store.get(id);

  let shouldClaim = true;
  if (existing) {
    if (existing.status === "done") {
      shouldClaim = false;
    } else {
      const age = Date.now() - new Date(existing.updatedAt).getTime();
      shouldClaim = age >= staleAfterMs;
    }
  }

  if (shouldClaim) {
    await store.put({ status: "in-progress", updatedAt: new Date().toISOString() }, id);
  }
  await tx.done;
  return shouldClaim;
}

export async function markConnectStateDone(id: string) {
  const db = await getDB();
  await db.put("connectState", { status: "done", updatedAt: new Date().toISOString() }, id);
}

/** Connect処理が失敗した際に呼ぶ。クレームを解放し、次回のキャッチアップ等で再試行できるようにする。 */
export async function releaseConnectState(id: string) {
  const db = await getDB();
  await db.delete("connectState", id);
}

export async function getConnectStateRecords(): Promise<Record<string, ConnectStateRecord>> {
  const db = await getDB();
  const keys = await db.getAllKeys("connectState");
  const result: Record<string, ConnectStateRecord> = {};
  for (const key of keys) {
    const value = await db.get("connectState", key);
    if (value) result[key] = value;
  }
  return result;
}

/** Auxiliary updates must never replace a Memory snapshot captured before an API call. */
export async function updateMemoryRevisitPrompt(id: string, prompt: string): Promise<MemoryObject | undefined> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects"], "readwrite");
  let result: MemoryObject | undefined;
  try {
    const current = await tx.objectStore("memoryObjects").get(id);
    if (current) {
      result = current.revisitPrompt ? current : { ...current, revisitPrompt: prompt };
      if (!current.revisitPrompt) await tx.objectStore("memoryObjects").put(result);
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}

/** Both endpoints and their outboxes commit atomically; no stale whole-record writes. */
export async function addMemoryLinkDurably(link: Link): Promise<MemoryObject[]> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects", "vaultOutbox"], "readwrite");
  const result: MemoryObject[] = [];
  try {
    const memories = tx.objectStore("memoryObjects"), outbox = tx.objectStore("vaultOutbox");
    const a = await memories.get(link.sourceId), b = await memories.get(link.targetId);
    // Revalidate pair existence after the AI call, including partial-retry cases.
    // Do not create a second edge for an already connected pair in either direction.
    if (a && b && a.id !== b.id && [a, b].every(m => !m.links.some(l =>
      l.sourceId === a.id && l.targetId === b.id || l.sourceId === b.id && l.targetId === a.id))) {
      for (const current of [a, b]) {
        const sameId = current.links.filter(l => l.id === link.id);
        if (sameId.length > 1 || sameId.some(l => JSON.stringify(l) !== JSON.stringify(link))) throw new Error("link-conflict");
        if (sameId.length) { result.push(current); continue; }
        const clock = Date.parse(current.updatedAt), now = Date.parse(link.createdAt);
        if (!Number.isFinite(clock) || !Number.isFinite(now)) throw new Error("link-time-invalid");
        const updated = { ...current, links: [...current.links, link], updatedAt: new Date(Math.max(clock + 1, now)).toISOString() };
        const type = current.metadata.source === "system-generated" ? "reflection" : "memory";
        const old = await outbox.get(vaultOutboxIdFor(type, current.id));
        await memories.put(updated);
        await outbox.put(buildOutboxEntryForUpdate(old, type, current.id, updated.updatedAt, link.createdAt));
        result.push(updated);
      }
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}

/** Exact journalled storage states. null means a proven absent entry.
 * Comparisons are JSON-based, so every state is built with the same key order (outbox, ledger). */
export type MemoryRepairStorage = { ledger: string | null; outbox: VaultOutboxEntry | null };
export type MemoryRepairExpectation = {
  id: string; before: MemoryRepairStorage; intermediate: MemoryRepairStorage; after: MemoryRepairStorage;
};
export async function readMemoryRepairStorage(id: string): Promise<MemoryRepairStorage> {
  const db = await getDB();
  const tx = db.transaction(["vaultOutbox", "vaultSyncState"], "readonly");
  const outbox = await tx.objectStore("vaultOutbox").get(vaultOutboxIdFor("memory", id));
  const ledger = await tx.objectStore("vaultSyncState").get(`memory:${id}`);
  await tx.done;
  return { outbox: outbox ?? null, ledger: ledger ?? null };
}
export function memoryRepairExpectation(before: MemoryObject, after: MemoryObject, storage: MemoryRepairStorage, now: string): MemoryRepairExpectation {
  if (storage.ledger !== null && storage.ledger !== before.updatedAt && storage.ledger !== after.updatedAt) throw new Error("repair-ledger-changed");
  const old = storage.outbox;
  if (old && (old.id !== vaultOutboxIdFor("memory", before.id) || old.recordId !== before.id || old.recordType !== "memory" ||
    old.recordUpdatedAt !== before.updatedAt && old.recordUpdatedAt !== after.updatedAt)) throw new Error("repair-outbox-changed");
  const pending = buildOutboxEntryForUpdate(undefined, "memory", after.id, after.updatedAt, now);
  const done: VaultOutboxEntry = { ...pending, status: "done", heldReason: null,
    steps: { markdown: "done", registry: "done", index: "done", history: "done", ledger: "done" } };
  return { id: before.id, before: storage, intermediate: { outbox: pending, ledger: storage.ledger }, after: { outbox: done, ledger: after.updatedAt } };
}

/** Do not let an older in-flight Memory projection erase a newer pending task. */
export async function putMemoryProjectionOutcome(entry: VaultOutboxEntry): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects", "vaultOutbox", "settings"], "readwrite");
  try {
    const current = await tx.objectStore("memoryObjects").get(entry.recordId);
    const tombs = parseTombstoneMap(await tx.objectStore("settings").get(TOMBSTONES_KEY));
    const existing = await tx.objectStore("vaultOutbox").get(entry.id);
    if (!memoryBlocked(tombs, current ?? { id: entry.recordId }) && (!current || current.updatedAt === entry.recordUpdatedAt) &&
      (!existing || existing.recordUpdatedAt === entry.recordUpdatedAt)) await tx.objectStore("vaultOutbox").put(entry);
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
}

/** Connect's verified projection may mark only that exact canonical/outbox version synced.
 * Reflection uses the existing memory ledger key, just like writeMemoryObjectMarkdown.
 */
export async function markMemoryProjectionSynced(recordType: "memory" | "reflection", id: string, version: string): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects", "vaultOutbox", "vaultSyncState"], "readwrite");
  let marked = false;
  try {
    const current = await tx.objectStore("memoryObjects").get(id);
    const outbox = await tx.objectStore("vaultOutbox").get(vaultOutboxIdFor(recordType, id));
    if (current?.updatedAt === version && outbox?.recordUpdatedAt === version && outbox.status === "done") {
      await tx.objectStore("vaultSyncState").put(version, `memory:${id}`);
      marked = true;
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return marked;
}

/** Narrow repair CAS. Caller holds exclusive world lock and a durable Recovery journal.
 * This is never called by bootstrap/projection. Both before and after are exact snapshots.
 */
/** Allowed difference between canonical `before` and `after`: `links` and `updatedAt`, and, only when `before` has no
 * `metadata.sourceType`, the parser's own inferred value (`inferSourceType`, the normal Vault -> canonical rule). */
export function memoryRepairScopeOk(before: MemoryObject, after: MemoryObject): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const base = { ...before, links: after.links, updatedAt: after.updatedAt };
  if (same(base, after)) return true;
  return before.metadata.sourceType === undefined && after.metadata.sourceType === inferSourceType(before.metadata.source)
    && same({ ...base, metadata: { ...before.metadata, sourceType: after.metadata.sourceType } }, after);
}

export async function commitMemoryLinkRestoration(
  changes: { before: MemoryObject; after: MemoryObject }[],
  counterparts: MemoryObject[], now: string, finalize: boolean, expectations: MemoryRepairExpectation[]
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects", "vaultOutbox", "vaultSyncState"], "readwrite");
  try {
    const memories = tx.objectStore("memoryObjects"), outbox = tx.objectStore("vaultOutbox");
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const c of counterparts) {
      const expected = changes.find(x => x.before.id === c.id);
      const actual = await memories.get(c.id);
      if (!equal(actual, c) && !(expected && equal(actual, expected.after))) throw new Error("counterpart-changed");
    }
    if (expectations.length !== changes.length) throw new Error("repair-storage-missing");
    for (const { before, after } of changes) {
      if (!memoryRepairScopeOk(before, after)) throw new Error("repair-field-scope");
      const current = await memories.get(before.id);
      if (!equal(current, after) && (finalize || !equal(current, before))) throw new Error("canonical-changed");
      const id = vaultOutboxIdFor("memory", before.id);
      const expected = expectations.find(e => e.id === before.id);
      if (!expected || !equal(expected, memoryRepairExpectation(before, after, expected.before, now))) throw new Error("repair-storage-invalid");
      const storage: MemoryRepairStorage = { outbox: await outbox.get(id) ?? null, ledger: await tx.objectStore("vaultSyncState").get(`memory:${before.id}`) ?? null };
      const isBefore = equal(current, before) && equal(storage, expected.before);
      const isIntermediate = equal(current, after) && equal(storage, expected.intermediate);
      const isAfter = equal(current, after) && equal(storage, expected.after);
      if (!(isAfter || isIntermediate || !finalize && isBefore)) throw new Error("repair-storage-changed");
      if (isAfter) continue;
      if (!finalize) {
        await memories.put(after);
        await outbox.put(expected.intermediate.outbox!);
      } else {
        await outbox.put(expected.after.outbox!);
        await tx.objectStore("vaultSyncState").put(expected.after.ledger!, `memory:${after.id}`);
      }
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
}

// ---------------------------------------------------------------------------
// One-shot Memory repair / backfill commit (memoryContaminationRepair.ts / memoryBackfill.ts).
// NEVER called from startup, bootstrap, projection, Capture or any UI: only the explicit runner (memoryRepairRunner.ts)
// can reach it. All-or-nothing: canonical records + their Outbox entries + backup + ledger live in ONE IndexedDB
// transaction, so there is no partially repaired item and the Vault only ever sees data through the normal Outbox.
// ---------------------------------------------------------------------------
export interface MemoryRepairTransaction {
  /** Per-item idempotency ledger (settings store). Present with `ledgerValue` => the item is already done. */
  ledgerKey: string;
  ledgerValue: string;
  /** Receives the pre-repair canonical records and Outbox entries (JSON). Written in the same transaction. */
  backupKey: string;
  replaceMemories: { before: MemoryObject; after: MemoryObject }[];
  addMemories: MemoryObject[];
  replaceConversations: { before: Conversation; after: Conversation }[];
  /** Conversations that must still have no Memory of their own (other than `addMemories`) at commit time. */
  requireNoOtherMemoryFor?: string[];
  now: string;
}
export type MemoryRepairCommitResult = "committed" | "already-done";

export async function commitMemoryRepairTransaction(t: MemoryRepairTransaction): Promise<MemoryRepairCommitResult> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects", "conversations", "vaultOutbox", "settings"], "readwrite");
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  let result: MemoryRepairCommitResult = "committed";
  try {
    const memories = tx.objectStore("memoryObjects"), conversations = tx.objectStore("conversations");
    const outbox = tx.objectStore("vaultOutbox"), settings = tx.objectStore("settings");
    const ledger = await settings.get(t.ledgerKey);
    if (ledger !== undefined) {
      if (ledger !== t.ledgerValue) throw new Error("repair-ledger-conflict");
      result = "already-done";
    } else {
      const backup: { memories: MemoryObject[]; conversations: Conversation[]; outbox: (VaultOutboxEntry | null)[]; absentMemoryIds: string[]; afterMemories: MemoryObject[]; afterConversations: Conversation[]; addedMemories: MemoryObject[] } = { memories: [], conversations: [], outbox: [], absentMemoryIds: [], afterMemories: [], afterConversations: [], addedMemories: [] };
      for (const { before, after } of t.replaceMemories) {
        const current = await memories.get(before.id);
        if (!equal(current, before)) throw new Error("repair-precondition-changed");
        if (after.id !== before.id) throw new Error("repair-id-changed");
        assertMemoryLineage(before, after);
        backup.memories.push(before); backup.afterMemories.push(after);
      }
      for (const { before, after } of t.replaceConversations) {
        const current = await conversations.get(before.id);
        if (!equal(current, before)) throw new Error("repair-precondition-changed");
        if (after.id !== before.id) throw new Error("repair-id-changed");
        backup.conversations.push(before); backup.afterConversations.push(after);
      }
      for (const added of t.addMemories) {
        const existing = await memories.get(added.id);
        if (existing !== undefined && !equal(existing, added)) throw new Error("repair-id-conflict");
        if (existing === undefined) { backup.absentMemoryIds.push(added.id); backup.addedMemories.push(added); }
      }
      if (t.requireNoOtherMemoryFor?.length) {
        const addedIds = new Set(t.addMemories.map((m) => m.id));
        const all = await memories.getAll();
        if (all.some((m) => m.conversationId && t.requireNoOtherMemoryFor!.includes(m.conversationId) && !addedIds.has(m.id) && m.metadata.source !== "system-generated")) throw new Error("repair-conversation-already-has-memory");
      }
      const enqueue = async (recordType: "memory" | "reflection" | "conversation", record: { id: string; updatedAt: string }, snapshot: boolean) => {
        const id = vaultOutboxIdFor(recordType, record.id);
        const existing = await outbox.get(id);
        if (snapshot) backup.outbox.push(existing ?? null);
        await outbox.put(buildOutboxEntryForUpdate(existing, recordType, record.id, record.updatedAt, t.now));
      };
      for (const { after } of t.replaceMemories) { await memories.put(after); await enqueue(after.metadata.source === "system-generated" ? "reflection" : "memory", after, true); }
      for (const added of t.addMemories) { if (await memories.get(added.id) === undefined) { await memories.put(added); await enqueue("memory", added, false); } }
      for (const { after } of t.replaceConversations) { await conversations.put(after); await enqueue("conversation", after, true); }
      await settings.put(JSON.stringify({ at: t.now, ...backup }), t.backupKey);
      await settings.put(t.ledgerValue, t.ledgerKey);
    }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
  return result;
}

/** Read-only: the settings entries (ledger / backup) of the repair, for dry-run and resume decisions. */
export async function readMemoryRepairSettings(keys: string[]): Promise<Record<string, string | undefined>> {
  const db = await getDB();
  const out: Record<string, string | undefined> = {};
  for (const key of keys) out[key] = await db.get("settings", key);
  return out;
}

/**
 * Maintenance write-ahead evidence (src/lib/maintenance/*): the hash of every content a maintenance window is ABOUT to write to a Vault file, kept
 * durably BEFORE the write, so a recovery after a dead tab can tell "written by that window" from "changed by someone else". One settings value per
 * window (key = `maintenance-evidence:<operation id>`, JSON {path: [hashes]}); holds hashes only, never content. Read-modify-write in one transaction.
 */
export const maintenanceEvidenceKey = (operationId: string) => `maintenance-evidence:${operationId}`;
export async function appendMaintenanceEvidence(operationId: string, path: string, hash: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["settings"], "readwrite");
  try {
    const store = tx.objectStore("settings");
    const cur = await store.get(maintenanceEvidenceKey(operationId));
    const map = (typeof cur === "string" ? JSON.parse(cur) : {}) as Record<string, string[]>;
    const list = (map[path] ??= []);
    if (!list.includes(hash)) list.push(hash);
    await store.put(JSON.stringify(map), maintenanceEvidenceKey(operationId));
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
}
export async function readMaintenanceEvidence(operationId: string): Promise<Record<string, string[]>> {
  const db = await getDB();
  const cur = await db.get("settings", maintenanceEvidenceKey(operationId));
  try { return typeof cur === "string" ? (JSON.parse(cur) as Record<string, string[]>) : {}; } catch { return {}; }
}
export async function deleteMaintenanceEvidence(operationId: string): Promise<void> {
  const db = await getDB();
  await db.delete("settings", maintenanceEvidenceKey(operationId));
}

/**
 * Maintenance strict restore (src/lib/maintenance/restoreEngine.ts). Never called by startup, projection or any normal screen.
 * ONE transaction over every store the repair + sync touch. Each entry names the value it expects to find RIGHT NOW (compared as JSON, no
 * await on anything but IndexedDB inside the transaction); if any entry differs nothing at all is written. `target: null` deletes.
 */
export interface MaintenanceRestoreTransaction {
  memories: { id: string; expectCurrent: MemoryObject | null; target: MemoryObject | null }[];
  conversations: { id: string; expectCurrent: Conversation | null; target: Conversation | null }[];
  outbox: { id: string; expectCurrent: VaultOutboxEntry | null; target: VaultOutboxEntry | null }[];
  syncLedger: { key: string; expectCurrent: string | null; target: string | null }[];
  settings: { key: string; expectCurrent: string | null; target: string | null }[];
}
export async function commitMaintenanceRestore(t: MaintenanceRestoreTransaction): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["memoryObjects", "conversations", "vaultOutbox", "vaultSyncState", "settings"], "readwrite");
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  try {
    const memories = tx.objectStore("memoryObjects"), conversations = tx.objectStore("conversations"), outbox = tx.objectStore("vaultOutbox");
    const ledger = tx.objectStore("vaultSyncState"), settings = tx.objectStore("settings");
    for (const e of t.memories) if (!equal((await memories.get(e.id)) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
    for (const e of t.conversations) if (!equal((await conversations.get(e.id)) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
    for (const e of t.outbox) if (!equal((await outbox.get(e.id)) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
    for (const e of t.syncLedger) if (!equal((await ledger.get(e.key)) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
    for (const e of t.settings) if (!equal((await settings.get(e.key)) ?? null, e.expectCurrent)) throw new Error("restore-precondition-changed");
    for (const e of t.memories) { if (e.target === null) await memories.delete(e.id); else await memories.put(e.target); }
    for (const e of t.conversations) { if (e.target === null) await conversations.delete(e.id); else await conversations.put(e.target); }
    for (const e of t.outbox) { if (e.target === null) await outbox.delete(e.id); else await outbox.put(e.target); }
    for (const e of t.syncLedger) { if (e.target === null) await ledger.delete(e.key); else await ledger.put(e.target, e.key); }
    for (const e of t.settings) { if (e.target === null) await settings.delete(e.key); else await settings.put(e.target, e.key); }
  } catch (error) { await abortAndSettleTransaction(tx, error); }
  await tx.done;
}
