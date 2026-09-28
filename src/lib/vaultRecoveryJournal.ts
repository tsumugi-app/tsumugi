/**
 * Vault Recovery Apply の永続journalと、「未完了journalがある間は通常のVault書き込みを止める」ゲート。
 *
 * このファイルは`vault.ts`から読み込まれる（循環importを避けるため`vault.ts`は読み込まない）。
 * journalは`settings`ストアの1キー（JSON文字列）。書いたら必ず読み戻して一致を確認する
 * （読み戻せないjournalの上では、Recovery Applyを開始しない）。
 *
 * 進捗（steps）は「次にどこから続けるか」の目安にすぎない。再開時は必ず実体（Vault・IndexedDB）を
 * 再確認して判定する（進捗フラグだけを信用しない。`vaultRecoveryApply.ts`参照）。
 */
import { getActiveVaultEpoch, readRecoveryJournalRaw, writeRecoveryJournalRaw } from "./db";

export const RECOVERY_JOURNAL_VERSION = 1;

export type RecoveryOpKind = "create" | "create-day" | "repair";
export type RecoveryRecordType = "conversation" | "source" | "reflection" | "memory";
export type RecoveryStepName = "markdown" | "index" | "history" | "registry" | "ledger";
export type RecoveryStepState = "pending" | "done" | "not-needed";
export type RecoveryOpStatus = "pending" | "verified" | "failed";

export interface RecoveryJournalMember {
  id: string;
  recordType: RecoveryRecordType;
  /** vaultSyncState（同期済み台帳）のkey。 */
  syncKey: string;
  updatedAt: string;
  /** IndexedDB recordの内容hash（記録時点。再開時・検証時に「変わっていない」ことの確認に使う）。 */
  recordHash: string;
}

export interface RecoveryJournalOp {
  opId: string;
  kind: RecoveryOpKind;
  recordType: RecoveryRecordType;
  day: string | null;
  members: RecoveryJournalMember[];
  /** Vault root相対の、Markdownの実path（createは決定的な保存先、repairは既存の実path）。 */
  path: string;
  /** Markdown全体の期待hash（createは書く内容、repairは「今ある内容＝変更しない」内容）。 */
  expectedContentHash: string;
  expectedContentLength: number;
  registryKey: string;
  /** 期待する変更後の管理情報（検証・再開時の再確認に使う）。 */
  expected: {
    indexEntries: { id: string; path: string }[];
    registry: { key: string; path: string; contentHash: string; memberIds: string[] } | null;
    history: { day: string; ids: string[] } | null;
    ledger: { key: string; value: string }[];
  };
  steps: Record<RecoveryStepName, RecoveryStepState>;
  /**
   * 共有metadataファイル（index.json／History月ファイル・history-meta.json／Registry shard）を書き換える
   * 直前に必ず記録する、書き込み前の完全な内容（B1対応）。書き込み開始前にjournalへ永続化・読み戻し確認
   * してから初めて実際のwriteを行う。`afterHash`は、そのpathへの書き込みが完了し読み戻して確認できた
   * 時点でのみ設定する（`null`のままなら「まだ書き込みが完了したと確認できていない」ことを意味する）。
   * Safari終了・page kill後の再開時は、進捗flag（steps）だけでなく、これと実ファイルを突き合わせて
   * 「A: 書き込み済み」「B: 未実行」「C: 破損」を判定する（`reconcileMetadataStep`参照）。
   */
  metadataBackups: RecoveryMetadataBackup[];
  status: RecoveryOpStatus;
  failure: string | null;
}

export interface RecoveryMetadataBackup {
  path: string;
  /** 書き込み前の実ファイル全文。ファイルが存在しなかった場合は`null`（復元時は0byteとして書き戻す）。 */
  beforeContent: string | null;
  /** `beforeContent`の正規化hash。`null`＝ファイル不存在、`"unreadable"`＝読み取り自体に失敗（backup不能）。 */
  beforeHash: string | null;
  /** 書き込み完了後に読み戻して確認できたhash。まだ確認できていなければ`null`。 */
  afterHash: string | null;
}

export interface RecoveryJournalWorld {
  activeVaultEpoch: number;
  committedVaultEpoch: number | null;
  registryGenerationEpoch: number;
  journalVersion: string;
  backend: string | null;
}

export type RecoveryJournalStatus = "in-progress" | "completed" | "abandoned";

export interface RecoveryJournal {
  version: typeof RECOVERY_JOURNAL_VERSION;
  operationId: string;
  status: RecoveryJournalStatus;
  createdAt: string;
  updatedAt: string;
  world: RecoveryJournalWorld;
  /** baselineは変更しない。開始時点の観測値だけを記録する。 */
  baselineAtStart: { status: string; value: string | null };
  /** 管理ファイルの変更前の状態（path→内容hash。存在しなければnull）。 */
  managedBefore: Record<string, string | null>;
  ops: RecoveryJournalOp[];
  /** 今回は変更せず保留した記録（表示用の要約。内部classificationはUIへ出さない）。 */
  held: { recordType: string; recordId: string; reason: string }[];
  result: { recovered: number; held: number; failed: number } | null;
  /**
   * B1対応：共有metadataが破損し、backupからの復元にも失敗した（＝安全に進められない）ことがあったか。
   * trueの間は、他の全opが解決していてもjournalをcompletedにしない（通常write gateを効かせ続ける）。
   */
  unresolvedMetadata: boolean;
}

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string";
const strOrNull = (x: unknown): x is string | null => x === null || typeof x === "string";
const OP_KINDS = ["create", "create-day", "repair"];
const RECORD_TYPES = ["conversation", "source", "reflection", "memory"];
const STEP_NAMES: RecoveryStepName[] = ["markdown", "index", "history", "registry", "ledger"];
const STEP_STATES = ["pending", "done", "not-needed"];

function validMember(m: unknown): m is RecoveryJournalMember {
  return object(m) && str(m.id) && RECORD_TYPES.includes(String(m.recordType)) && str(m.syncKey) && str(m.updatedAt) && str(m.recordHash);
}
function validMetadataBackup(b: unknown): b is RecoveryMetadataBackup {
  return object(b) && str(b.path) && strOrNull(b.beforeContent) && strOrNull(b.beforeHash) && strOrNull(b.afterHash);
}
function validOp(o: unknown): o is RecoveryJournalOp {
  if (!object(o) || !str(o.opId) || !OP_KINDS.includes(String(o.kind)) || !RECORD_TYPES.includes(String(o.recordType))) return false;
  if (!strOrNull(o.day) || !Array.isArray(o.members) || !o.members.every(validMember) || !str(o.path)) return false;
  if (!str(o.expectedContentHash) || typeof o.expectedContentLength !== "number" || !str(o.registryKey)) return false;
  if (!["pending", "verified", "failed"].includes(String(o.status)) || !strOrNull(o.failure)) return false;
  if (!Array.isArray(o.metadataBackups) || !o.metadataBackups.every(validMetadataBackup)) return false;
  if (!object(o.steps) || !STEP_NAMES.every((name) => STEP_STATES.includes(String((o.steps as Record<string, unknown>)[name])))) return false;
  const e = o.expected;
  if (!object(e) || !Array.isArray(e.indexEntries) || !Array.isArray(e.ledger)) return false;
  if (!e.indexEntries.every((x) => object(x) && str(x.id) && str(x.path))) return false;
  if (!e.ledger.every((x) => object(x) && str(x.key) && str(x.value))) return false;
  if (e.registry !== null && !(object(e.registry) && str(e.registry.key) && str(e.registry.path) && str(e.registry.contentHash) && Array.isArray(e.registry.memberIds))) return false;
  if (e.history !== null && !(object(e.history) && str(e.history.day) && Array.isArray(e.history.ids))) return false;
  return true;
}

/** 厳密なparse。形が違えばnull（呼び出し元は「journalが読めない」として扱う。存在しない、とは区別する）。 */
export function parseRecoveryJournal(raw: string): RecoveryJournal | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!object(value) || value.version !== RECOVERY_JOURNAL_VERSION || !str(value.operationId)) return null;
  if (!["in-progress", "completed", "abandoned"].includes(String(value.status))) return null;
  if (!str(value.createdAt) || !str(value.updatedAt)) return null;
  const w = value.world;
  if (!object(w) || typeof w.activeVaultEpoch !== "number" || !(w.committedVaultEpoch === null || typeof w.committedVaultEpoch === "number") ||
    typeof w.registryGenerationEpoch !== "number" || !str(w.journalVersion) || !strOrNull(w.backend)) return null;
  const b = value.baselineAtStart;
  if (!object(b) || !str(b.status) || !strOrNull(b.value)) return null;
  if (!object(value.managedBefore) || !Object.values(value.managedBefore).every(strOrNull)) return null;
  if (!Array.isArray(value.ops) || !value.ops.every(validOp)) return null;
  if (!Array.isArray(value.held) || !value.held.every((h) => object(h) && str(h.recordType) && str(h.recordId) && str(h.reason))) return null;
  const r = value.result;
  if (r !== null && !(object(r) && typeof r.recovered === "number" && typeof r.held === "number" && typeof r.failed === "number")) return null;
  if (typeof value.unresolvedMetadata !== "boolean") return null;
  return value as unknown as RecoveryJournal;
}

// ---------------------------------------------------------------------------
// 永続store（dbのsettingsストア）。テストでは`RecoveryJournalStore`を差し替える。
// ---------------------------------------------------------------------------

export interface RecoveryJournalStore {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

export const dbRecoveryJournalStore: RecoveryJournalStore = {
  read: readRecoveryJournalRaw,
  write: writeRecoveryJournalRaw,
};

export class RecoveryJournalUnavailableError extends Error {
  constructor(message = "recovery journal could not be saved and read back") {
    super(message);
    this.name = "RecoveryJournalUnavailableError";
  }
}

/** 保存して読み戻し、完全に一致することまで確認する。確認できなければ例外（呼び出し元は次の変更へ進まない）。 */
export async function saveRecoveryJournal(store: RecoveryJournalStore, journal: RecoveryJournal): Promise<void> {
  const text = JSON.stringify(journal);
  try {
    await store.write(text);
    const back = await store.read();
    if (back !== text) throw new RecoveryJournalUnavailableError("recovery journal read-back mismatch");
  } catch (error) {
    if (error instanceof RecoveryJournalUnavailableError) throw error;
    throw new RecoveryJournalUnavailableError();
  }
}

export type RecoveryJournalRead =
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "journal"; journal: RecoveryJournal };

export async function readRecoveryJournal(store: RecoveryJournalStore = dbRecoveryJournalStore): Promise<RecoveryJournalRead> {
  const raw = await store.read();
  if (raw === undefined) return { kind: "none" };
  const journal = parseRecoveryJournal(raw);
  return journal ? { kind: "journal", journal } : { kind: "unreadable" };
}

// ---------------------------------------------------------------------------
// 通常の書き込みのゲート
// ---------------------------------------------------------------------------

export class VaultRecoveryPendingError extends Error {
  constructor() {
    super("[Tsumugi] vault write deferred: an unfinished recovery is pending (normal writes resume after it is finished).");
    this.name = "VaultRecoveryPendingError";
  }
}

/**
 * 通常の書き込みを止めるべきか。未完了（in-progress）のjournalが、今のworld（active epoch）のものである間だけtrue。
 * - journalが無い：false（通常ユーザーは従来どおり）。
 * - completed／abandoned：false。
 * - 別のworld（Vault切替後）のin-progress：false（そのjournalはもう今のVaultに関係しない）。
 * - journalが読めない（形が不正）／epochを確認できない：true（安全側。Recovery Applyが置き換えるまで書かない）。
 * - journalの読み取り自体に失敗：true（安全側）。
 * 毎回IndexedDBから読み直す（別タブが開始したRecoveryを、古いキャッシュで見逃さないため）。
 */
export async function isRecoveryBlockingNormalWrites(store: RecoveryJournalStore = dbRecoveryJournalStore, readEpoch: () => Promise<number> = getActiveVaultEpoch): Promise<boolean> {
  let read: RecoveryJournalRead;
  try {
    read = await readRecoveryJournal(store);
  } catch {
    return true;
  }
  if (read.kind === "none") return false;
  if (read.kind === "unreadable") return true;
  if (read.journal.status !== "in-progress") return false;
  try {
    return (await readEpoch()) === read.journal.world.activeVaultEpoch;
  } catch {
    return true;
  }
}

export async function assertNoPendingRecovery(
  store: RecoveryJournalStore = dbRecoveryJournalStore,
  readEpoch: () => Promise<number> = getActiveVaultEpoch
): Promise<void> {
  if (await isRecoveryBlockingNormalWrites(store, readEpoch)) throw new VaultRecoveryPendingError();
}

/**
 * Recovery Apply自身の書き込みだけがゲートを通るための、同期スコープのフラグ。`fn`の同期部分（＝
 * `enqueueVaultWrite`が呼ばれてフラグを読む瞬間）の間だけtrueにし、awaitを跨がない。
 */
let recoveryWriteAccessDepth = 0;
export function runWithRecoveryWriteAccess<T>(fn: () => T): T {
  recoveryWriteAccessDepth += 1;
  try {
    return fn();
  } finally {
    recoveryWriteAccessDepth -= 1;
  }
}
export function isRecoveryWriteAccessActive(): boolean {
  return recoveryWriteAccessDepth > 0;
}
