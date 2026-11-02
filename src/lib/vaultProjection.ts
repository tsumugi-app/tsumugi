/**
 * Vault Projection Engine（新保存基盤 Phase 3-3〜3-7）。
 *
 * IndexedDB canonical record（`conversations`等） + `vaultOutbox`（Phase 3-1）から、
 * Vault側（Markdown本体・Registry・`.tsumugi/index.json`・History）を「あるべき状態」へ
 * 収束させる。既存の`writeConversationMarkdownImpl`（baseline gate・4段階非atomic書き込み）
 * はラップしない——read（実体を読む）→compare（canonicalと比較する）→decide（create/
 * update/no-op/conflict/heldを判定する）→project（必要な分だけ書く）→verify（書いた後に
 * 実際に整合しているか確認する）を、このファイルで明示的に実装する。
 *
 * 対象：Conversation（Phase 3-3）・normal Memory day-file（Phase 3-6）・
 * Reflection／Source（Phase 3-7、1 canonical = 1 fileの共通engine `SingleFileRecordConfig`
 * を介して実装。下記「1 canonical = 1 fileの汎用engine」参照）。
 *
 * 重要：baselineEstablishedAtはwrite permissionとして一切使わない（Phase 1で特定した
 * 今回のiPhone事故の根本原因）。projection許可条件は (1) Vault identityが一致
 * (2) canonical recordが存在 (3) 対象Vault実体との比較でconflictがない、の3つだけ。
 *
 * このファイルはまだどの本番経路（ChatScreen.tsx／capture.ts／起動処理）からも呼ばれない
 * （テストから呼べるlibraryとして完成させるところまで）。
 */
import { findRecordInVault } from "./dataLifecycle";
import { getAcceptedDivergences, getConversation, getMemoryObject, getSource, getPendingVaultOutboxEntries, getDoneVaultOutboxEntries, getHeldVaultOutboxEntries, getProjectionHeldReevaluationMarker, setProjectionHeldReevaluationMarker, putVaultOutboxEntry, putMemoryProjectionOutcome } from "./db";
import { conversationEntryTypeOf } from "./conversationEntryKind";
import type { VaultOutboxEntry, ProjectionStepName, ProjectionStepState } from "./vaultOutbox";
import type { VaultIdentityRecord } from "./vaultIdentity";
import type { Conversation, MemoryObject, Source } from "./types";
import {
  conversationToMarkdown,
  parseConversationMarkdown,
  memoryObjectToMarkdown,
  parseMemoryObjectMarkdown,
  parseMemoryDayFile,
  sourceToMarkdown,
  parseSourceMarkdown,
} from "./markdown";
import { validStatedAt } from "./markdown";
import { CONVERSATION_EVOLVING_KEYS, MEMORY_EVOLVING_KEYS, nextMemberHashes, planDayFileMemberWrite, readVaultFileText, singleFileRewriteIsSafe, withMemoryDayFileLock } from "./vaultRewriteSafety";
import { fileNameFor, dayFileNameFor, dayFileRegistryKey, vaultRegistryBucketOf, hashVaultText, truncateHistoryPreview, normalizedSourceType, vaultProjectionPrimitives, type HistoryIndexUpdate, type HistoryMeta, type HistoryMonthIndex } from "./vault";

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

const INDEX_PATH = ".tsumugi/index.json";
const HISTORY_META_PATH = ".tsumugi/history-meta.json";
const VAULT_IDENTITY_PATH = ".tsumugi/vault-identity.json";
const historyMonthPath = (day: string) => `.tsumugi/history/${day.slice(0, 7)}.json`;
const registryShardPath = (bucket: number) => `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
const defaultConversationPath = (c: Conversation) => `Conversations/${fileNameFor(c.id, c.startedAt)}`;

// ---------------------------------------------------------------------------
// 実体の読み込み（ok/absent/errorを区別する。既存vault.tsの`readJSON`はparse失敗も
// 「不在」として握りつぶすため、ここでは使わずこのファイル専用に実装する——月ファイル等の
// 破損を「空」と取り違えると、無関係な既存データを消してしまう危険があるため）。
// ---------------------------------------------------------------------------

type TextRead = { state: "ok"; text: string } | { state: "absent" } | { state: "error" };
type JsonRead = { state: "ok"; value: Record<string, unknown> } | { state: "absent" } | { state: "error" };

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/**
 * ONE reconcile pass may remember the files it has already read, so that the SAME small shared file (identity, index.json, a registry shard, a History month,
 * history-meta, a day file) is not read again for every one of hundreds of records. The memory is deliberately narrow:
 *   - it exists only inside `reconcileOutboxEntries` (one pass, a few seconds) and is dropped at its end; nothing is remembered between passes or startups;
 *   - every write the engine makes (or is about to make) clears it;
 *   - it may only justify "this record is already in order": an entry is first evaluated against remembered reads, and if that evaluation would WRITE anything
 *     (or end in anything but "done": a conflict, a hold, a retry) the remembered reads are thrown away and the entry is evaluated again from fresh reads,
 *     exactly as it always was. So no write, hold or conflict is ever decided from remembered content.
 * Errors are never remembered. Content equality is always decided from the text that was actually read (never from size / modified time).
 */
interface PassState { map: Map<string, TextRead>; gen: number; cachedOnly: boolean }
const passStates = new WeakMap<ProjectionEnv, PassState>();
const cachedOnlyEntries = new WeakSet<object>();
/** thrown inside a remembered-reads evaluation the moment it would write or conclude anything other than "done"; the entry is then evaluated again from fresh reads */
class NeedsFreshRead extends Error {}

/** read counters (file bodies actually read from the Vault / reads answered from the pass memory): for tests and measurement only */
export const projectionReadStats = { fileReads: 0, cacheHits: 0, idbWritesSkipped: 0 };
export function resetProjectionReadStats(): void { projectionReadStats.fileReads = 0; projectionReadStats.cacheHits = 0; projectionReadStats.idbWritesSkipped = 0; }

async function readTextFromDisk(root: FileSystemDirectoryHandle, path: string): Promise<TextRead> {
  const segments = path.split("/");
  try {
    let dir = root;
    for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
    const fileHandle = await dir.getFileHandle(segments[segments.length - 1], { create: false });
    const file = await fileHandle.getFile();
    return { state: "ok", text: await readVaultFileText(file) };
  } catch (error) {
    return isNotFoundError(error) ? { state: "absent" } : { state: "error" };
  }
}

async function readTextAt(env: ProjectionEnv, path: string): Promise<TextRead> {
  const pass = passStates.get(env);
  const hit = pass?.map.get(path);
  if (hit) { projectionReadStats.cacheHits += 1; return hit; }
  const generation = pass?.gen;
  const result = await readTextFromDisk(env.root, path);
  projectionReadStats.fileReads += 1;
  // a write that happened while this read was in flight may have made it stale: remember only if nothing was written meanwhile
  if (pass && result.state !== "error" && pass.gen === generation) pass.map.set(path, result);
  return result;
}

/** 0byteファイルは「不在」として扱う（Vault全体で共通の既存の規約）。 */
async function readJsonAt(env: ProjectionEnv, path: string): Promise<JsonRead> {
  const raw = await readTextAt(env, path);
  if (raw.state !== "ok") return raw;
  if (raw.text.trim() === "") return { state: "absent" };
  try {
    const value = JSON.parse(raw.text);
    if (typeof value !== "object" || value === null) return { state: "error" };
    return { state: "ok", value: value as Record<string, unknown> };
  } catch {
    return { state: "error" };
  }
}

/** every write the engine makes goes through here: a remembered-reads evaluation never writes (it is redone from fresh reads), and a write clears the memory */
async function writing<T>(env: ProjectionEnv, write: () => Promise<T>): Promise<T> {
  const pass = passStates.get(env);
  if (pass?.cachedOnly) throw new NeedsFreshRead();
  try { return await write(); }
  finally { if (pass) { pass.map.clear(); pass.gen += 1; } }
}

async function dirAndFileNameFor(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; fileName: string }> {
  const segments = path.split("/");
  let dir = root;
  for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
  return { dir, fileName: segments[segments.length - 1] };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Vault Identity（req 7・req 13：既にpair済みの場合のみ照合する。legacy Vaultの
// 安全なpairingはPhase 3-4）
// ---------------------------------------------------------------------------

export interface ProjectionEnv {
  root: FileSystemDirectoryHandle;
  /** このIndexedDBが今書き込もうとしているVaultのidentity（既にpair済みのもの）。未pairはnull。 */
  vaultIdentity: VaultIdentityRecord | null;
  now?: () => string;
}

async function vaultIdentityMatches(env: ProjectionEnv): Promise<boolean> {
  if (!env.vaultIdentity || !env.vaultIdentity.vaultId) return false;
  const read = await readJsonAt(env, VAULT_IDENTITY_PATH);
  if (read.state !== "ok") return false; // 不在／読めない場合も「一致を確認できた」わけではないため、安全側でfalse
  const onDiskVaultId = read.value.vaultId;
  return typeof onDiskVaultId === "string" && onDiskVaultId === env.vaultIdentity.vaultId;
}

// ---------------------------------------------------------------------------
// エラー分類（req 9）：retryable（一時的失敗）とnon-retryable（genuine conflict）を
// 明確に分ける。canonical dataを削除する経路はどちらにも無い。
// ---------------------------------------------------------------------------

export class ProjectionRetryableError extends Error {}
export class ProjectionConflictError extends Error {}

// ---------------------------------------------------------------------------
// Conversation：Markdown判定（req 3）
// ---------------------------------------------------------------------------

/**
 * `onDisk`が、`canonical`の正当な旧version（Assistant turn追加等で単純に後続turnが
 * 追記されただけ）と言えるか。id・persona・startedAtが一致し、`onDisk.turns`が
 * `canonical.turns`の厳密な先頭一致（prefix）であることを要求する——外部で発言内容が
 * 書き換えられた・turnが削除された・順序が変わった場合は、prefix一致が崩れるため
 * 必ずfalseになり、conflictとして保留される（req 3の「無条件上書きしない」を満たす）。
 */
/**
 * Phase 3-5（Production Bootstrap Migration）もこの判定を共有する
 * （`vaultIdentityAdoption.ts`・`vaultProductionMigration.ts`が同じ意味論の判定を
 * 二重実装しないため、export する）。
 */
export function isLegitimatePredecessor(onDisk: Conversation, canonical: Conversation): boolean {
  if (onDisk.id !== canonical.id) return false;
  if (onDisk.persona !== canonical.persona) return false;
  if (onDisk.startedAt !== canonical.startedAt) return false;
  if (onDisk.turns.length > canonical.turns.length) return false;
  return onDisk.turns.every((turn, i) => {
    const other = canonical.turns[i];
    return other && other.role === turn.role && other.content === turn.content && other.timestamp === turn.timestamp;
  });
}

type MarkdownVerdict =
  | { kind: "create" | "update"; path: string }
  | { kind: "no-op"; path: string };

/** Registryに記録された、Tsumugiが最後に書いた内容のハッシュ（読めない・無いときはundefined。証明できないだけで、書いてよいことにはならない） */
async function registeredContentHash(env: ProjectionEnv, registryKey: string, path: string): Promise<unknown> {
  const read = await readJsonAt(env, registryShardPath(vaultRegistryBucketOf(registryKey)));
  if (read.state !== "ok" || !isObj(read.value.records) || !isObj(read.value.files) || read.value.records[registryKey] !== path) return undefined;
  const entry = read.value.files[path];
  return isObj(entry) ? entry.contentHash : undefined;
}

async function decideMarkdown(env: ProjectionEnv, canonical: Conversation, registryPath: string | undefined): Promise<MarkdownVerdict> {
  const path = registryPath ?? defaultConversationPath(canonical);
  const expectedContent = conversationToMarkdown(canonical);
  const read = await readTextAt(env, path);
  if (read.state === "error") throw new ProjectionConflictError("markdown-unreadable");
  if (read.state === "absent") return { kind: "create", path };
  if (read.text === expectedContent) return { kind: "no-op", path };
  const parsed = parseConversationMarkdown(read.text);
  if (!parsed) throw new ProjectionConflictError("markdown-unreadable");
  if (!isLegitimatePredecessor(parsed, canonical)) throw new ProjectionConflictError("markdown-conflict");
  if (!singleFileRewriteIsSafe(read.text, expectedContent, { hash: hashVaultText, registeredHash: await registeredContentHash(env, canonical.id, path), evolvingKeys: CONVERSATION_EVOLVING_KEYS, body: "extends" })) throw new ProjectionConflictError("markdown-edited-conflict");
  return { kind: "update", path };
}

async function projectMarkdown(env: ProjectionEnv, canonical: Conversation, verdict: MarkdownVerdict): Promise<void> {
  if (verdict.kind === "no-op") return;
  const { dir, fileName } = await dirAndFileNameFor(env.root, verdict.path, true);
  try {
    await writing(env, () => vaultProjectionPrimitives.writeFileInDir(dir, fileName, conversationToMarkdown(canonical), "projection markdown"));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "markdown-write-failed");
  }
}

// ---------------------------------------------------------------------------
// Conversation：Registry判定（req 4）
// ---------------------------------------------------------------------------

async function decideAndProjectRegistry(env: ProjectionEnv, canonical: Conversation, path: string): Promise<void> {
  const bucket = vaultRegistryBucketOf(canonical.id);
  const shardPath = registryShardPath(bucket);
  const read = await readJsonAt(env, shardPath);
  if (read.state === "error") throw new ProjectionConflictError("registry-unreadable");
  const records = read.state === "ok" && isObj(read.value.records) ? (read.value.records as Record<string, unknown>) : {};
  const files = read.state === "ok" && isObj(read.value.files) ? (read.value.files as Record<string, unknown>) : {};
  const currentPath = records[canonical.id];
  // 対象外key・対象外pathには一切触れない（`upsertVaultRegistryRecord`自身が
  // read-modify-writeでこのregistryKey分のentryだけを更新するため、他recordの
  // 行は構造的に保護される）。
  const content = conversationToMarkdown(canonical);
  const expected = { recordType: "conversation" as const, mtime: 0, size: 0, contentHash: hashVaultText(content), memberIds: [canonical.id], status: "ok" as const };
  const currentEntry = typeof currentPath === "string" ? files[currentPath] : undefined;
  const alreadyCorrect =
    currentPath === path &&
    isObj(currentEntry) &&
    currentEntry.recordType === expected.recordType &&
    currentEntry.contentHash === expected.contentHash &&
    currentEntry.status === "ok" &&
    Array.isArray(currentEntry.memberIds) &&
    currentEntry.memberIds.length === 1 &&
    currentEntry.memberIds[0] === canonical.id;
  if (alreadyCorrect) return; // no-op
  // the file stat is only needed when the Registry row has to be written: an already-correct row is decided without it (one operation less per record)
  const { dir, fileName } = await dirAndFileNameFor(env.root, path, false);
  let stat: { mtime: number; size: number };
  try {
    stat = await vaultProjectionPrimitives.readVaultFileStat(dir, fileName);
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "markdown-stat-failed");
  }
  Object.assign(expected, { mtime: stat.mtime, size: stat.size });
  try {
    await writing(env, () => vaultProjectionPrimitives.upsertVaultRegistryRecord(env.root, { registryKey: canonical.id, path, ...expected }));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "registry-write-failed");
  }
}

// ---------------------------------------------------------------------------
// Conversation：index.json判定
// ---------------------------------------------------------------------------

async function decideAndProjectIndex(env: ProjectionEnv, canonical: Conversation, path: string): Promise<void> {
  const read = await readJsonAt(env, INDEX_PATH);
  if (read.state === "error") throw new ProjectionConflictError("index-unreadable");
  const current = read.state === "ok" ? read.value[canonical.id] : undefined;
  if (current === path) return; // no-op（対象外の他keyには一切触れない——updateIndexも読み込んだ全体をそのまま書き戻すread-modify-writeのため保護される）
  try {
    await writing(env, () => vaultProjectionPrimitives.updateIndex(env.root, canonical.id, path));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "index-write-failed");
  }
}

// ---------------------------------------------------------------------------
// Conversation：History判定
// ---------------------------------------------------------------------------

/**
 * The History rows (month file + history-meta) were just read OK; if the update the writer would apply changes nothing, the read-modify-write (its own lock and two
 * more file reads) is skipped. Anything unproven (a missing day / file, an odd shape) still goes to the writer exactly as before.
 */
function historyAlreadyExact(monthRead: JsonRead, metaRead: JsonRead, update: HistoryIndexUpdate): boolean {
  return monthRead.state === "ok" && metaRead.state === "ok"
    && vaultProjectionPrimitives.historyIndexUpdateIsNoop(monthRead.value as unknown as HistoryMonthIndex, metaRead.value as unknown as HistoryMeta, update);
}

async function decideAndProjectHistory(env: ProjectionEnv, canonical: Conversation): Promise<void> {
  const day = canonical.startedAt.slice(0, 10);
  const monthPath = historyMonthPath(day);
  // 月ファイル・meta双方が「構造として読めるか」だけをここで確認する（`updateHistoryIndex`
  // 自身のreadJSONは破損を「空」に丸めてしまうため、それに委ねると他の日のデータを
  // 巻き込んで消しかねない。読めることさえ確認できれば、以降の実際の更新判断
  // （変化が無ければ書かない）は既存のupdateHistoryIndexの絶対値書き込みに任せてよい
  // ——同じday・同じ入力からは常に同じ結果になるため、他の日・他月には触れない）。
  const monthRead = await readJsonAt(env, monthPath);
  if (monthRead.state === "error") throw new ProjectionConflictError("history-unreadable");
  const metaRead = await readJsonAt(env, HISTORY_META_PATH);
  if (metaRead.state === "error") throw new ProjectionConflictError("history-meta-unreadable");
  const mode = conversationEntryTypeOf(canonical);
  const update: HistoryIndexUpdate = { kind: "conversation", id: canonical.id, day, mode, turnCount: canonical.turns.length };
  if (historyAlreadyExact(monthRead, metaRead, update)) return;
  try {
    await writing(env, () => vaultProjectionPrimitives.updateHistoryIndex(env.root, update));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "history-write-failed");
  }
}

// ---------------------------------------------------------------------------
// 最終verify（req 8）：全stepを処理しただけでdoneにしない。実際に整合しているかを
// 読み直して確認する。
// ---------------------------------------------------------------------------

async function finalVerify(env: ProjectionEnv, canonical: Conversation, path: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const expectedContent = conversationToMarkdown(canonical);
  const markdownRead = await readTextAt(env, path);
  if (markdownRead.state !== "ok" || markdownRead.text !== expectedContent) return { ok: false, reason: "verify-markdown-mismatch" };

  const bucket = vaultRegistryBucketOf(canonical.id);
  const registryRead = await readJsonAt(env, registryShardPath(bucket));
  if (registryRead.state !== "ok") return { ok: false, reason: "verify-registry-missing" };
  const records = isObj(registryRead.value.records) ? registryRead.value.records : {};
  const files = isObj(registryRead.value.files) ? registryRead.value.files : {};
  const entry = records[canonical.id] === path ? files[path] : undefined;
  if (!isObj(entry) || entry.status !== "ok" || entry.contentHash !== hashVaultText(expectedContent)) return { ok: false, reason: "verify-registry-mismatch" };

  const indexRead = await readJsonAt(env, INDEX_PATH);
  if (indexRead.state !== "ok" || indexRead.value[canonical.id] !== path) return { ok: false, reason: "verify-index-mismatch" };

  const day = canonical.startedAt.slice(0, 10);
  const historyRead = await readJsonAt(env, historyMonthPath(day));
  if (historyRead.state !== "ok") return { ok: false, reason: "verify-history-missing" };
  const days = isObj(historyRead.value.days) ? historyRead.value.days : {};
  const dayEntry = days[day];
  const row = isObj(dayEntry) && Array.isArray(dayEntry.conversations) ? dayEntry.conversations.find((r) => isObj(r) && r.id === canonical.id) : undefined;
  const expectedMode = conversationEntryTypeOf(canonical);
  if (!isObj(row) || row.mode !== expectedMode || row.turnCount !== canonical.turns.length) return { ok: false, reason: "verify-history-mismatch" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// outbox entryの更新
// ---------------------------------------------------------------------------

function emptySteps(): Record<ProjectionStepName, ProjectionStepState> {
  return { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "not-needed" };
}

/**
 * READ ONLY診断（Projection dry-run）専用の出力フック。診断が渡した「そのentryオブジェクト」に限り、outboxを
 * IndexedDBへ書く代わりに結果をsinkへ渡す。それ以外のentry（実際のreconcile）は従来どおり永続化する
 * （診断中に通常の保存が走っても、その結果は失われない）。productionのreconcile経路は何も変わらない。
 */
export interface ProjectionDryRunOutcome { steps: Record<ProjectionStepName, ProjectionStepState>; status: "done" | "pending" | "held"; reason: string | null }
const dryRunSinks = new WeakMap<object, (outcome: ProjectionDryRunOutcome) => void>();
export function registerProjectionDryRun(entry: VaultOutboxEntry, sink: (outcome: ProjectionDryRunOutcome) => void): () => void {
  dryRunSinks.set(entry, sink);
  return () => { dryRunSinks.delete(entry); };
}

const PROJECTION_STEP_NAMES_FOR_COMPARE: ProjectionStepName[] = ["markdown", "registry", "history", "index", "ledger"];

const quietHolds = new WeakSet<object>();

async function persistOutcome(entry: VaultOutboxEntry, steps: Record<ProjectionStepName, ProjectionStepState>, status: "done" | "pending" | "held", reason: string | null, now: string): Promise<void> {
  const dryRunSink = dryRunSinks.get(entry);
  if (dryRunSink) { dryRunSink({ steps: { ...steps }, status, reason }); return; }
  // an evaluation that rests on remembered reads may only conclude "done"; a hold / retry / conflict is always decided again from fresh reads
  if (cachedOnlyEntries.has(entry) && status !== "done") throw new NeedsFreshRead();
  // already "done" with exactly these steps: nothing changed, so nothing is written (the record was only re-verified)
  if (status === "done" && entry.status === "done" && entry.heldReason === null && PROJECTION_STEP_NAMES_FOR_COMPARE.every((name) => entry.steps[name] === steps[name])) {
    projectionReadStats.idbWritesSkipped += 1;
    return;
  }
  // the same hold again at the start-up re-evaluation: nothing changed, so nothing is written
  if (quietHolds.has(entry) && status === "held" && entry.heldReason === reason) return;
  const attempt = status === "done" ? entry.attempt : { count: entry.attempt.count + 1, lastError: reason, lastAttemptAt: now };
  const persist = entry.recordType === "memory" || entry.recordType === "reflection" ? putMemoryProjectionOutcome : putVaultOutboxEntry;
  await persist({ ...entry, steps, status, heldReason: status === "held" ? reason : null, attempt, updatedAt: now });
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------

export type ReconcileConversationResult =
  | { status: "done" }
  | { status: "pending"; reason: string }
  | { status: "held"; reason: string };

/**
 * outbox entry 1件を、実際にVaultへ収束させる（Conversationのみ対応）。
 *
 * 呼び出しのたびに必ずread/compare/decideをやり直す——`entry.steps`の既存の値
 * （前回どこまで進んだか）は一切の判断材料にしない（Invariant 3：outboxの進捗記録は
 * ヒントであって真実ではない）。これにより、「Markdown write成功→Safari kill→
 * outbox markdown stepをdoneにする前に停止」しても、次回はここから普通に
 * 再実行するだけで、Markdownが既にcanonicalと一致していることを検出して
 * no-op（step done）として扱える（req 7）。
 */
export async function reconcileConversationOutboxEntry(env: ProjectionEnv, entry: VaultOutboxEntry): Promise<ReconcileConversationResult> {
  const now = (env.now ?? (() => new Date().toISOString()))();
  const steps = emptySteps();

  if (!(await vaultIdentityMatches(env))) {
    // req L：1バイトもwriteしない。ここまでの`vaultIdentityMatches`自体は
    // 読み取りのみ（`.tsumugi/vault-identity.json`の存在確認）。
    await persistOutcome(entry, steps, "held", "vault-identity-mismatch", now);
    return { status: "held", reason: "vault-identity-mismatch" };
  }

  const canonical = await getConversation(entry.recordId);
  if (!canonical) {
    await persistOutcome(entry, steps, "held", "canonical-record-missing", now);
    return { status: "held", reason: "canonical-record-missing" };
  }
  if (canonical.updatedAt !== entry.recordUpdatedAt) {
    // 通常のwrite path（Invariant 1/2）ではcanonical更新のたびに必ずoutboxも
    // 同時に進むため起こらないはずだが、テスト等で手動構成されたentryに備えて
    // 安全側（pending）にする——古いentryのまま誤ってdoneにしない。
    await persistOutcome(entry, steps, "pending", "outbox-entry-stale", now);
    return { status: "pending", reason: "outbox-entry-stale" };
  }

  // Registryに既存entryがあれば、そのpathをMarkdownの対象にする（新しく生成する
  // 既定pathを別途作らない。Registry不在はここではまだ判定しない——decideMarkdown
  // 内部で改めてMarkdownの実在を確認し、baselineに頼らずcreate/update/no-op/
  // conflict/heldを決める）。
  const bucket = vaultRegistryBucketOf(canonical.id);
  const registryPeek = await readJsonAt(env, registryShardPath(bucket));
  const registryPath =
    registryPeek.state === "ok" && isObj(registryPeek.value.records) && typeof registryPeek.value.records[canonical.id] === "string"
      ? (registryPeek.value.records[canonical.id] as string)
      : undefined;

  try {
    const markdownVerdict = await decideMarkdown(env, canonical, registryPath);
    await projectMarkdown(env, canonical, markdownVerdict);
    steps.markdown = "done";

    await decideAndProjectRegistry(env, canonical, markdownVerdict.path);
    steps.registry = "done";

    await decideAndProjectIndex(env, canonical, markdownVerdict.path);
    steps.index = "done";

    await decideAndProjectHistory(env, canonical);
    steps.history = "done";

    const verify = await finalVerify(env, canonical, markdownVerdict.path);
    if (!verify.ok) {
      await persistOutcome(entry, steps, "pending", verify.reason, now);
      return { status: "pending", reason: verify.reason };
    }

    await persistOutcome(entry, steps, "done", null, now);
    return { status: "done" };
  } catch (error) {
    if (error instanceof ProjectionConflictError) {
      await persistOutcome(entry, steps, "held", error.message, now);
      return { status: "held", reason: error.message };
    }
    const reason = error instanceof Error ? error.message : "unknown-projection-error";
    await persistOutcome(entry, steps, "pending", reason, now);
    return { status: "pending", reason };
  }
}

// ---------------------------------------------------------------------------
// Startup Reconcile（req 10）：まだChatScreen/app startupへは接続しない
// （テストから呼べるlibraryとして完成させるところまで）。
// ---------------------------------------------------------------------------

export interface ReconcileAllResult {
  done: number;
  pending: number;
  held: number;
}

/** `conversation`種別のpending outbox entryだけを対象に、1件ずつreconcileする。 */
export async function reconcilePendingConversations(env: ProjectionEnv): Promise<ReconcileAllResult> {
  const pending = await getPendingVaultOutboxEntries();
  const result: ReconcileAllResult = { done: 0, pending: 0, held: 0 };
  for (const entry of pending) {
    if (entry.recordType !== "conversation") continue;
    const outcome = await reconcileConversationOutboxEntry(env, entry);
    result[outcome.status] += 1;
  }
  return result;
}

// ===========================================================================
// Memory day-file Projection（新保存基盤 Phase 3-6）
//
// Conversationとの最大の違い：canonicalは個々のMemoryObject（1 record）だが、
// projection先（day-file）は複数recordを共有する。したがって「canonicalからday-file
// を丸ごと再生成して上書き」は禁止（req 1）——read existing day-file→parse members→
// 対象memberだけ比較→unknown membersを保持→safe merge→write→verify、という
// read-modify-writeを、対象memberの数だけ繰り返す設計にする。
// ===========================================================================

// ---------------------------------------------------------------------------
// req 5：Lock。同一day-fileへの複数member projectionが、互いのwriteを
// 消し合わない（lost update防止）よう、day単位の専用lockで直列化する。
// 既存のwithVaultRegistryLock/withHistoryIndexLock（vault.ts、非export）と
// 同じ`navigator.locks`パターンをこのEngine専用のlock nameで再利用する
// （Phase 3-6はまだ本番write queueへ未接続のため、Engine自身の直列化が必要）。
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// req 9：Memory version判定。
//
// ConversationのprefixチェックはMemoryへは使えない（turnsのような追記専用構造が
// 無いため）。day-fileの各member entryは`memoryObjectToMarkdown`でシリアライズ
// される（`serializeMemoryDayFile`参照）ため、「same」はConversationと同じく
// 全文一致で判定する。
//
// 「legitimate successor」はcontent（捕捉した事実の本文）が一致していることを
// 必須とする——content以外（summary・types・keywords・links・themeIds・
// personIds・emotionIds・goalIds・ideaIds・eventIds・topicId・
// evidenceQuotes・personMentions・topicEvents・profileClaims・metadata等）は
// Tsumugi自身の後続処理（topic付与・person mention紐付け・感情/目標/アイデア/
// 出来事抽出・evidence検証等）が事実を変えずに随時更新しうる項目であり、
// これらだけが変化した更新は「証明できないupdateの無理な上書き」には当たらない。
// 一方、content自体が変わっている場合は、Tsumugi自身の後続処理が本文を書き換える
// 設計にはなっていない以上、正当な更新か外部編集かをこの判定だけでは区別できない
// ため、安全側でconflictとして保留する（Conversationのturn内容保護と同じ考え方）。
// ---------------------------------------------------------------------------

/**
 * Memoryの「同じ」「Registryのmember hash」「最終verify」の共通の比較基準（`isMemorySame` / migration / final verify / memberHashesが全てこれを使う）。
 * 直列化は従来どおり厳密に比べるが、`metadata.sourceType`だけは、パーサがVault上で行う推定（未設定→`source`から推定）と
 * 同じ`normalizedSourceType`で両側を揃えてから直列化する。canonicalの未設定とパーサの推定値の差を意味差として扱わないためで、
 * 他の項目・明示されたsourceTypeの本当の差は従来どおり不一致になる。実際にVaultへ書くMarkdown（`memoryObjectToMarkdown`）は変えない。
 */
function memoryEntryMarkdown(m: MemoryObject): string {
  return memoryObjectToMarkdown({ ...m, metadata: { ...m.metadata, sourceType: normalizedSourceType(m.metadata.source, m.metadata.sourceType) as MemoryObject["metadata"]["sourceType"] } });
}

/** Registryのmember hashは、新しい保存（`memoryEntryMarkdown`）と従来の書き込み（`memoryObjectToMarkdown`）のどちらの形でも書かれている */
function memberHashMatches(stored: unknown, member: MemoryObject): boolean {
  return typeof stored === "string" && (stored === hashVaultText(memoryEntryMarkdown(member)) || stored === hashVaultText(memoryObjectToMarkdown(member)));
}

export function isMemorySame(onDisk: MemoryObject, canonical: MemoryObject): boolean {
  return memoryEntryMarkdown(onDisk) === memoryEntryMarkdown(canonical);
}

/**
 * Temporal Phase 1A.5：「statedAtだけが欠落している」Vault member（canonicalをVaultへ再投影してよいsafe successor）。
 * 旧build（statedAtを知らないparser）が日ファイルを読み直して書くと、同じ日の全memberからstatedAtが落ちる。それを、
 * 新しいbuildのProjectionが、他の何も壊さずに復元できるようにする。
 *
 * 条件（全て満たす場合だけtrue）：
 * - canonicalにvalidなstatedAtがある（日時のvalidationはPhase 1Aのserializer/parserと同じ`validStatedAt`を使う）
 * - Vault memberにvalidなstatedAtが無い
 * - canonicalからstatedAtだけを除いた直列化（`memoryEntryMarkdown`）が、Vault memberの直列化と**完全一致**する
 *   ——content・summary・keywords・evidenceQuotes・eventTime・topicId・person/profile/topic・createdAt・updatedAt等、
 *   Markdownに書かれる他の項目が1つでも違えば成立しない（statedAtを比較から単純に除外するのとは違う）。
 * 逆方向（canonicalに無く、Vaultにある）と、両側に別の値がある場合は成立しない。
 */
export function isMemoryStatedAtOnlyMissing(onDisk: MemoryObject, canonical: MemoryObject): boolean {
  if (validStatedAt(canonical.statedAt) === undefined) return false;
  if (validStatedAt(onDisk.statedAt) !== undefined) return false;
  return memoryEntryMarkdown(onDisk) === memoryEntryMarkdown({ ...canonical, statedAt: undefined });
}

/**
 * Phase 3-6のmigration（vaultProductionMigration.ts）もこの判定を共有する（二重実装しない）。
 *
 * `date`は日付部分（`YYYY-MM-DD`）だけをMarkdown frontmatterへ書く
 * （`memoryObjectToMarkdown`）ため、`onDisk`（day-fileから読み直した実体）の`date`は
 * 常に時刻部分が`T00:00:00.000Z`へ正規化済みになる。`canonical`（IndexedDB上の値、
 * 例：会話開始時刻など元の時刻を保持している場合がある）とここを完全一致で比較すると、
 * 内容として同一のmemberが時刻精度の違いだけでconflict誤判定される
 * （`decideAndProjectMemoryHistory`で発見した同じ根本原因）。日付部分だけを比較する。
 */
export function isMemoryLegitimateSuccessor(onDisk: MemoryObject, canonical: MemoryObject): boolean {
  if (onDisk.id !== canonical.id) return false;
  // Temporal Phase 1A.5：Vault側にあるstatedAt（Memory.statedAt）を、canonicalが同じ値で持っていない限り、successorとして
  // 上書きして消さない（canonicalにstatedAtが無い／別の値の場合）。updatedAtが新しくても同じ。Vaultの方が情報が多い可能性があるため、
  // conflict / HOLD（安全側）に残す。statedAtを持つMemoryがまだ無い間は、この条件は常に偽で挙動は変わらない。
  const vaultStatedAt = validStatedAt(onDisk.statedAt);
  if (vaultStatedAt !== undefined && validStatedAt(canonical.statedAt) !== vaultStatedAt) return false;
  // Temporal Phase 1A.5：statedAtだけが欠落したVault memberは、canonicalから再投影できる安全なsuccessor（下記）。
  if (isMemoryStatedAtOnlyMissing(onDisk, canonical)) return true;
  if (onDisk.date.slice(0, 10) !== canonical.date.slice(0, 10)) return false;
  if (onDisk.createdAt !== canonical.createdAt) return false;
  if (onDisk.content !== canonical.content) return false;
  return canonical.updatedAt > onDisk.updatedAt;
}

// ---------------------------------------------------------------------------
// req 2〜4：member単位の判定とsafe merge
// ---------------------------------------------------------------------------

export const memoryDayFilePath = (m: MemoryObject) => `Memories/${dayFileNameFor(m.date)}`;

export type MemoryMemberVerdictKind = "create" | "append" | "no-op" | "update";

interface MemoryMergeResult {
  path: string;
  verdict: MemoryMemberVerdictKind;
  /** merge後のday-file全member（既知canonical＋未知member。安定した順序＝createdAt昇順）。 */
  finalMembers: MemoryObject[];
  finalContent: string;
}

/**
 * 対象1 memberを、day-fileの現在の実体へ安全にmergeする。既存の未知member
 * （IndexedDBに存在しないid）は一切削除しない（req 3、最重要）。呼び出しの
 * たびに必ずday-fileを読み直す（`withMemoryDayFileLock`と組み合わせることで、
 * req 4の「常に最新実体を基準にする」を満たす）。
 */
async function mergeMemoryIntoDayFile(env: ProjectionEnv, canonical: MemoryObject, path: string): Promise<MemoryMergeResult> {
  const read = await readTextAt(env, path);
  if (read.state === "error") throw new ProjectionConflictError("memory-dayfile-unreadable");

  const registered = await readRegisteredMemberHashes(env, canonical.date.slice(0, 10), path);
  const plan = planDayFileMemberWrite(read.state === "ok" ? read.text : null, canonical, {
    isSame: isMemorySame,
    isSuccessor: isMemoryLegitimateSuccessor,
    isRegisteredVersion: (onDisk) => memberHashMatches(registered[onDisk.id], onDisk),
  });
  if (plan.kind === "refuse") throw new ProjectionConflictError(plan.reason);

  if (plan.kind === "write") {
    const { dir, fileName } = await dirAndFileNameFor(env.root, path, true);
    try {
      await writing(env, () => vaultProjectionPrimitives.writeFileInDir(dir, fileName, plan.content, "projection memory day-file"));
    } catch (error) {
      throw new ProjectionRetryableError(error instanceof Error ? error.message : "memory-dayfile-write-failed");
    }
  }

  return { path, verdict: plan.kind === "write" ? plan.verdict : "no-op", finalMembers: plan.members, finalContent: plan.content };
}

/** Registryに記録された、その日の記録ごとのハッシュ（読めない・無いときは空。証明できないだけで、書いてよいことにはならない） */
async function readRegisteredMemberHashes(env: ProjectionEnv, day: string, path: string): Promise<Obj> {
  const registryKey = dayFileRegistryKey(day);
  const read = await readJsonAt(env, registryShardPath(vaultRegistryBucketOf(registryKey)));
  if (read.state !== "ok" || !isObj(read.value.records) || !isObj(read.value.files) || read.value.records[registryKey] !== path) return {};
  const entry = read.value.files[path];
  return isObj(entry) && isObj(entry.memberHashes) ? entry.memberHashes : {};
}

// ---------------------------------------------------------------------------
// req 6：Registry。memberIds/memberHashesは、最終day-file実体（known+unknown
// member全員）から構築する——対象memberだけを直す際に、他member（未知member含む）
// のRegistry情報を落とさない。
// ---------------------------------------------------------------------------

async function decideAndProjectMemoryRegistry(env: ProjectionEnv, path: string, finalMembers: MemoryObject[], finalContent: string, targetId: string): Promise<void> {
  const day = finalMembers[0]?.date.slice(0, 10) ?? "";
  const registryKey = dayFileRegistryKey(day);
  const bucket = vaultRegistryBucketOf(registryKey);
  const shardPath = registryShardPath(bucket);
  const read = await readJsonAt(env, shardPath);
  if (read.state === "error") throw new ProjectionConflictError("registry-unreadable");
  const records = read.state === "ok" && isObj(read.value.records) ? (read.value.records as Record<string, unknown>) : {};
  const files = read.state === "ok" && isObj(read.value.files) ? (read.value.files as Record<string, unknown>) : {};
  const currentPath = records[registryKey];

  const memberIds = finalMembers.map((m) => m.id);
  const memberHashes = await nextMemberHashes(typeof currentPath === "string" && isObj(files[currentPath]) ? (files[currentPath] as Obj).memberHashes : undefined, finalMembers, targetId, (m) => hashVaultText(memoryEntryMarkdown(m)), async (m) => {
    const device = await getMemoryObject(m.id);
    return !device || isMemorySame(m, device);
  });
  const expected = { recordType: "memory-day" as const, mtime: 0, size: 0, contentHash: hashVaultText(finalContent), memberIds, memberHashes, status: "ok" as const };

  const currentEntry = typeof currentPath === "string" ? files[currentPath] : undefined;
  const alreadyCorrect =
    currentPath === path &&
    isObj(currentEntry) &&
    currentEntry.recordType === expected.recordType &&
    currentEntry.contentHash === expected.contentHash &&
    currentEntry.status === "ok" &&
    Array.isArray(currentEntry.memberIds) &&
    sameStringSet(currentEntry.memberIds as unknown[], memberIds) &&
    isObj(currentEntry.memberHashes) &&
    memberIds.every((id) => (currentEntry.memberHashes as Obj)[id] === memberHashes[id]);
  if (alreadyCorrect) return;
  // the file stat is only needed when the Registry row has to be written: an already-correct row is decided without it (one operation less per record)
  const { dir, fileName } = await dirAndFileNameFor(env.root, path, false);
  let stat: { mtime: number; size: number };
  try {
    stat = await vaultProjectionPrimitives.readVaultFileStat(dir, fileName);
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "memory-dayfile-stat-failed");
  }
  Object.assign(expected, { mtime: stat.mtime, size: stat.size });

  try {
    await writing(env, () => vaultProjectionPrimitives.upsertVaultRegistryRecord(env.root, { registryKey, path, ...expected }));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "registry-write-failed");
  }
}

function sameStringSet(a: unknown[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((x) => setA.has(x));
}

/** 配列の要素順序まで一致するかを見る（`types`は保存時に順序が保たれる前提のため）。 */
function sameStringArray(a: unknown, b: unknown[]): boolean {
  if (!Array.isArray(a)) return false;
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

// ---------------------------------------------------------------------------
// index.json：対象canonical memberの自分自身のid→pathだけを確認・更新する
// （他memberのentryには一切触れない。updateIndex自体がread-modify-writeで
// 他keyを保護する）。
// ---------------------------------------------------------------------------

async function decideAndProjectMemoryIndex(env: ProjectionEnv, canonical: MemoryObject, path: string): Promise<void> {
  const read = await readJsonAt(env, INDEX_PATH);
  if (read.state === "error") throw new ProjectionConflictError("index-unreadable");
  const current = read.state === "ok" ? read.value[canonical.id] : undefined;
  if (current === path) return;
  try {
    await writing(env, () => vaultProjectionPrimitives.updateIndex(env.root, canonical.id, path));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "index-write-failed");
  }
}

// ---------------------------------------------------------------------------
// req 7：History。day-fileの最終実体（known+unknown member全員）からnormalMemories
// 行を再構築する——`updateHistoryIndex`自体が絶対値書き込みで、対象日のnormalMemories
// 配列以外（同じ日のconversations/reflections行、他の日・他の月）には一切触れない
// （Recovery B1の「対象外rowを変更しない」と同じ既存の安全性を、この同じprimitiveの
// 再利用によってそのまま引き継ぐ）。
// ---------------------------------------------------------------------------

async function decideAndProjectMemoryHistory(env: ProjectionEnv, day: string, finalMembers: MemoryObject[]): Promise<void> {
  const monthPath = historyMonthPath(day);
  const monthRead = await readJsonAt(env, monthPath);
  if (monthRead.state === "error") throw new ProjectionConflictError("history-unreadable");
  const metaRead = await readJsonAt(env, HISTORY_META_PATH);
  if (metaRead.state === "error") throw new ProjectionConflictError("history-meta-unreadable");
  // `date`は日付部分だけをMarkdown frontmatterへ書く（`memoryObjectToMarkdown`）ため、
  // day-fileから再読み込みしたmember（`mergeMemoryIntoDayFile`がparse経由で返す既存member）
  // の`date`は常に`T00:00:00.000Z`へ正規化済みになる。一方、まだ一度もday-fileへ
  // 書かれていない直近canonical（`finalMembers`に含まれる、たった今追加/更新した
  // member）は、IndexedDB上の`date`（会話開始時刻等、時刻付きの場合がある）を
  // そのまま持つ。この2つの由来が混在するmemberの間で`date`の粒度が食い違うと、
  // 同じ内容のはずのHistory rowが「毎回変化した」と誤判定され、無限にrewriteし続ける
  // （実際にProjection Memory B/Rのmutation testingで検出：2回目の何もしないはずの
  // reconcileで、この不一致だけを理由にHistory月ファイルが再書き込みされていた）。
  // 呼び出し元の由来に関わらず、ここで一律に日付部分だけへ正規化することで、
  // 常に同じ値へ収束させる（真の冪等性。Invariant 3）。
  const rows = finalMembers.map((m) => ({ id: m.id, types: m.types, preview: truncateHistoryPreview(m.summary), createdAt: m.createdAt, date: `${m.date.slice(0, 10)}T00:00:00.000Z` }));
  const update: HistoryIndexUpdate = { kind: "memory", day, normalMemories: rows };
  if (historyAlreadyExact(monthRead, metaRead, update)) return;
  try {
    await writing(env, () => vaultProjectionPrimitives.updateHistoryIndex(env.root, update));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "history-write-failed");
  }
}

// ---------------------------------------------------------------------------
// req 10：final verify。対象memberについて、doneにする前に必ずday-file・Registry・
// index・Historyが実際に整合していることを確認する。
// ---------------------------------------------------------------------------

async function finalVerifyMemory(env: ProjectionEnv, canonical: MemoryObject, path: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const dayRead = await readTextAt(env, path);
  if (dayRead.state !== "ok") return { ok: false, reason: "verify-memory-dayfile-missing" };
  const members = parseMemoryDayFile(dayRead.text);
  const member = members.find((m) => m.id === canonical.id);
  if (!member || memoryEntryMarkdown(member) !== memoryEntryMarkdown(canonical)) return { ok: false, reason: "verify-memory-member-mismatch" };

  const day = canonical.date.slice(0, 10);
  const registryKey = dayFileRegistryKey(day);
  const bucket = vaultRegistryBucketOf(registryKey);
  const registryRead = await readJsonAt(env, registryShardPath(bucket));
  if (registryRead.state !== "ok") return { ok: false, reason: "verify-registry-missing" };
  const records = isObj(registryRead.value.records) ? registryRead.value.records : {};
  const files = isObj(registryRead.value.files) ? registryRead.value.files : {};
  const entry = records[registryKey] === path ? files[path] : undefined;
  if (!isObj(entry) || entry.status !== "ok" || !isObj(entry.memberHashes) || (entry.memberHashes as Obj)[canonical.id] !== hashVaultText(memoryEntryMarkdown(canonical))) {
    return { ok: false, reason: "verify-registry-mismatch" };
  }

  const indexRead = await readJsonAt(env, INDEX_PATH);
  if (indexRead.state !== "ok" || indexRead.value[canonical.id] !== path) return { ok: false, reason: "verify-index-mismatch" };

  const historyRead = await readJsonAt(env, historyMonthPath(day));
  if (historyRead.state !== "ok") return { ok: false, reason: "verify-history-missing" };
  const days = isObj(historyRead.value.days) ? historyRead.value.days : {};
  const dayEntry = days[day];
  const row = isObj(dayEntry) && Array.isArray(dayEntry.normalMemories) ? dayEntry.normalMemories.find((r) => isObj(r) && r.id === canonical.id) : undefined;
  if (!isObj(row) || row.preview !== truncateHistoryPreview(canonical.summary) || !sameStringArray(row.types, canonical.types)) return { ok: false, reason: "verify-history-mismatch" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------

/**
 * outbox entry 1件（1 canonical MemoryObject）を、実際にVaultへ収束させる。
 *
 * req 8（conflict isolation）：day-file内の他memberが本当のconflictであっても、
 * このmemberの安全なrepairを妨げない——`mergeMemoryIntoDayFile`は対象memberだけを
 * 判定し、他memberはunknown/preservedとしてそのまま素通りする（他memberの内容比較・
 * conflict判定はこの関数の責務ではない。他member自身のoutbox entryが別途あれば、
 * その member自身のreconcile呼び出しが独立して判定する）。read-modify-write +
 * final verifyの組み合わせにより、「対象memberだけの安全なrepair」であることを
 * 実行のたびに証明してからdoneにする（証明できなければpending/heldのまま。
 * day-file単位で一律holdにはしない——1 memberのconflict/一時失敗が、同じ
 * day-fileの他の安全なmemberの収束を妨げないため）。
 */
export async function reconcileMemoryOutboxEntry(env: ProjectionEnv, entry: VaultOutboxEntry): Promise<ReconcileConversationResult> {
  const now = (env.now ?? (() => new Date().toISOString()))();
  const steps = emptySteps();

  if (!(await vaultIdentityMatches(env))) {
    await persistOutcome(entry, steps, "held", "vault-identity-mismatch", now);
    return { status: "held", reason: "vault-identity-mismatch" };
  }

  const canonical = await getMemoryObject(entry.recordId);
  if (!canonical) {
    await persistOutcome(entry, steps, "held", "canonical-record-missing", now);
    return { status: "held", reason: "canonical-record-missing" };
  }
  if (canonical.updatedAt !== entry.recordUpdatedAt) {
    await persistOutcome(entry, steps, "pending", "outbox-entry-stale", now);
    return { status: "pending", reason: "outbox-entry-stale" };
  }

  const path = memoryDayFilePath(canonical);
  const day = canonical.date.slice(0, 10);

  try {
    const merge = await withMemoryDayFileLock(day, () => mergeMemoryIntoDayFile(env, canonical, path));
    steps.markdown = "done";

    await decideAndProjectMemoryRegistry(env, merge.path, merge.finalMembers, merge.finalContent, canonical.id);
    steps.registry = "done";

    await decideAndProjectMemoryIndex(env, canonical, path);
    steps.index = "done";

    await decideAndProjectMemoryHistory(env, day, merge.finalMembers);
    steps.history = "done";

    const verify = await finalVerifyMemory(env, canonical, path);
    if (!verify.ok) {
      await persistOutcome(entry, steps, "pending", verify.reason, now);
      return { status: "pending", reason: verify.reason };
    }

    await persistOutcome(entry, steps, "done", null, now);
    return { status: "done" };
  } catch (error) {
    if (error instanceof ProjectionConflictError) {
      await persistOutcome(entry, steps, "held", error.message, now);
      return { status: "held", reason: error.message };
    }
    const reason = error instanceof Error ? error.message : "unknown-projection-error";
    await persistOutcome(entry, steps, "pending", reason, now);
    return { status: "pending", reason };
  }
}

/** `memory`種別のpending outbox entryだけを対象に、1件ずつreconcileする。まだ本番未接続。 */
export async function reconcilePendingMemories(env: ProjectionEnv): Promise<ReconcileAllResult> {
  const pending = await getPendingVaultOutboxEntries();
  const result: ReconcileAllResult = { done: 0, pending: 0, held: 0 };
  for (const entry of pending) {
    if (entry.recordType !== "memory") continue;
    const outcome = await reconcileMemoryOutboxEntry(env, entry);
    result[outcome.status] += 1;
  }
  return result;
}

// ===========================================================================
// 1 canonical = 1 fileの汎用engine（新保存基盤 Phase 3-7）
//
// Reflection・Sourceはどちらも「1 canonical record = 1 Vault file」であり、
// Conversationと同じ安全モデル（read→compare→decide→project→verify）がそのまま
// 成立する。record typeごとの違い（path・registryKeyの作り方・Markdown
// シリアライズ／パース・「legitimate successor」の意味・Historyを持つかどうか）
// だけを`SingleFileRecordConfig`という設定オブジェクトへ吸収し、実際のdecide/
// project/verifyロジックは1つだけ実装する（Conversation固有の既存関数
// `decideMarkdown`等は、既にtest済みの経路を壊さないためそのまま残す——
// この汎用engineが後からConversationを飲み込むことはしない）。
// ===========================================================================

export interface SingleFileRecordConfig<T extends { id: string; createdAt: string; updatedAt: string }> {
  recordType: "reflection" | "source";
  pathFor: (canonical: T) => string;
  registryKeyFor: (canonical: T) => string;
  toMarkdown: (record: T) => string;
  /** parse不能は`null`を返すこと（Sourceの`parseSourceMarkdown`は例外を投げるため、configの実装側でtry/catchしてnullへ変換する）。 */
  parseMarkdown: (text: string) => T | null;
  /**
   * `null`は「legitimate successor概念自体が存在しない」ことを意味する
   * （Source：既存実装に「安全に進化してよいフィールド」の前例が無いため、
   * 内容が一致しない全てのケースを無条件でconflictとして扱う。req 2で
   * 明示された「実データ構造に合う判定をする、無理に流用しない」の適用）。
   */
  isLegitimateSuccessor: ((onDisk: T, canonical: T) => boolean) | null;
  /** Historyへ計上するrecord type（Reflectionのみ）。Sourceは存在しないため省略する。 */
  historyRowFor?: (canonical: T) => { day: string; preview: string; createdAt: string };
  getCanonical: (id: string) => Promise<T | undefined>;
}

type SingleFileMarkdownVerdict<T> =
  | { kind: "create" | "update"; path: string }
  | { kind: "no-op"; path: string; onDisk: T };

async function decideSingleFileMarkdown<T extends { id: string; createdAt: string; updatedAt: string }>(
  env: ProjectionEnv,
  canonical: T,
  registryPath: string | undefined,
  config: SingleFileRecordConfig<T>
): Promise<SingleFileMarkdownVerdict<T>> {
  const path = registryPath ?? config.pathFor(canonical);
  const expectedContent = config.toMarkdown(canonical);
  const read = await readTextAt(env, path);
  if (read.state === "error") throw new ProjectionConflictError(`${config.recordType}-markdown-unreadable`);
  if (read.state === "absent") return { kind: "create", path };
  const parsed = config.parseMarkdown(read.text);
  if (read.text === expectedContent) return { kind: "no-op", path, onDisk: parsed ?? canonical };
  if (!parsed) throw new ProjectionConflictError(`${config.recordType}-markdown-unreadable`);
  if (config.isLegitimateSuccessor && config.isLegitimateSuccessor(parsed, canonical)) {
    if (!singleFileRewriteIsSafe(read.text, expectedContent, { hash: hashVaultText, registeredHash: await registeredContentHash(env, config.registryKeyFor(canonical), path), evolvingKeys: MEMORY_EVOLVING_KEYS, body: "same" })) throw new ProjectionConflictError(`${config.recordType}-markdown-edited-conflict`);
    return { kind: "update", path };
  }
  throw new ProjectionConflictError(`${config.recordType}-markdown-conflict`);
}

async function projectSingleFileMarkdown<T extends { id: string; createdAt: string; updatedAt: string }>(
  env: ProjectionEnv,
  canonical: T,
  verdict: SingleFileMarkdownVerdict<T>,
  config: SingleFileRecordConfig<T>
): Promise<void> {
  if (verdict.kind === "no-op") return;
  const { dir, fileName } = await dirAndFileNameFor(env.root, verdict.path, true);
  try {
    await writing(env, () => vaultProjectionPrimitives.writeFileInDir(dir, fileName, config.toMarkdown(canonical), `projection ${config.recordType}`));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : `${config.recordType}-write-failed`);
  }
}

async function decideAndProjectSingleFileRegistry<T extends { id: string; createdAt: string; updatedAt: string }>(
  env: ProjectionEnv,
  canonical: T,
  path: string,
  config: SingleFileRecordConfig<T>
): Promise<void> {
  const registryKey = config.registryKeyFor(canonical);
  const bucket = vaultRegistryBucketOf(registryKey);
  const shardPath = registryShardPath(bucket);
  const read = await readJsonAt(env, shardPath);
  if (read.state === "error") throw new ProjectionConflictError("registry-unreadable");
  const records = read.state === "ok" && isObj(read.value.records) ? (read.value.records as Record<string, unknown>) : {};
  const files = read.state === "ok" && isObj(read.value.files) ? (read.value.files as Record<string, unknown>) : {};
  const currentPath = records[registryKey];
  const content = config.toMarkdown(canonical);
  const expected = { recordType: config.recordType, mtime: 0, size: 0, contentHash: hashVaultText(content), memberIds: [registryKey], status: "ok" as const };
  const currentEntry = typeof currentPath === "string" ? files[currentPath] : undefined;
  const alreadyCorrect =
    currentPath === path &&
    isObj(currentEntry) &&
    currentEntry.recordType === expected.recordType &&
    currentEntry.contentHash === expected.contentHash &&
    currentEntry.status === "ok" &&
    Array.isArray(currentEntry.memberIds) &&
    currentEntry.memberIds.length === 1 &&
    currentEntry.memberIds[0] === registryKey;
  if (alreadyCorrect) return;
  // the file stat is only needed when the Registry row has to be written
  const { dir, fileName } = await dirAndFileNameFor(env.root, path, false);
  let stat: { mtime: number; size: number };
  try {
    stat = await vaultProjectionPrimitives.readVaultFileStat(dir, fileName);
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : `${config.recordType}-stat-failed`);
  }
  Object.assign(expected, { mtime: stat.mtime, size: stat.size });
  try {
    await writing(env, () => vaultProjectionPrimitives.upsertVaultRegistryRecord(env.root, { registryKey, path, ...expected }));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "registry-write-failed");
  }
}

async function decideAndProjectSingleFileIndex<T extends { id: string }>(env: ProjectionEnv, canonical: T, path: string): Promise<void> {
  const read = await readJsonAt(env, INDEX_PATH);
  if (read.state === "error") throw new ProjectionConflictError("index-unreadable");
  const current = read.state === "ok" ? read.value[canonical.id] : undefined;
  if (current === path) return;
  try {
    await writing(env, () => vaultProjectionPrimitives.updateIndex(env.root, canonical.id, path));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "index-write-failed");
  }
}

/** Historyを持つrecord type（Reflection）専用。Sourceはこの関数自体を呼ばない。 */
async function decideAndProjectSingleFileHistory<T extends { id: string; createdAt: string; updatedAt: string }>(
  env: ProjectionEnv,
  canonical: T,
  config: SingleFileRecordConfig<T>
): Promise<void> {
  const row = config.historyRowFor!(canonical);
  const monthPath = historyMonthPath(row.day);
  const monthRead = await readJsonAt(env, monthPath);
  if (monthRead.state === "error") throw new ProjectionConflictError("history-unreadable");
  const metaRead = await readJsonAt(env, HISTORY_META_PATH);
  if (metaRead.state === "error") throw new ProjectionConflictError("history-meta-unreadable");
  const update: HistoryIndexUpdate = { kind: "reflection", id: canonical.id, day: row.day, preview: row.preview, createdAt: row.createdAt };
  if (historyAlreadyExact(monthRead, metaRead, update)) return;
  try {
    await writing(env, () => vaultProjectionPrimitives.updateHistoryIndex(env.root, update));
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "history-write-failed");
  }
}

async function finalVerifySingleFile<T extends { id: string; createdAt: string; updatedAt: string }>(
  env: ProjectionEnv,
  canonical: T,
  path: string,
  config: SingleFileRecordConfig<T>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const expectedContent = config.toMarkdown(canonical);
  const markdownRead = await readTextAt(env, path);
  if (markdownRead.state !== "ok" || markdownRead.text !== expectedContent) return { ok: false, reason: `verify-${config.recordType}-markdown-mismatch` };

  const registryKey = config.registryKeyFor(canonical);
  const bucket = vaultRegistryBucketOf(registryKey);
  const registryRead = await readJsonAt(env, registryShardPath(bucket));
  if (registryRead.state !== "ok") return { ok: false, reason: "verify-registry-missing" };
  const records = isObj(registryRead.value.records) ? registryRead.value.records : {};
  const files = isObj(registryRead.value.files) ? registryRead.value.files : {};
  const entry = records[registryKey] === path ? files[path] : undefined;
  if (!isObj(entry) || entry.status !== "ok" || entry.contentHash !== hashVaultText(expectedContent)) return { ok: false, reason: "verify-registry-mismatch" };

  const indexRead = await readJsonAt(env, INDEX_PATH);
  if (indexRead.state !== "ok" || indexRead.value[canonical.id] !== path) return { ok: false, reason: "verify-index-mismatch" };

  if (config.historyRowFor) {
    const row = config.historyRowFor(canonical);
    const historyRead = await readJsonAt(env, historyMonthPath(row.day));
    if (historyRead.state !== "ok") return { ok: false, reason: "verify-history-missing" };
    const days = isObj(historyRead.value.days) ? historyRead.value.days : {};
    const dayEntry = days[row.day];
    const historyRow = isObj(dayEntry) && Array.isArray(dayEntry.reflections) ? dayEntry.reflections.find((r) => isObj(r) && r.id === canonical.id) : undefined;
    if (!isObj(historyRow) || historyRow.preview !== row.preview) return { ok: false, reason: "verify-history-mismatch" };
  }

  return { ok: true };
}

async function reconcileSingleFileOutboxEntry<T extends { id: string; createdAt: string; updatedAt: string }>(
  env: ProjectionEnv,
  entry: VaultOutboxEntry,
  config: SingleFileRecordConfig<T>
): Promise<ReconcileConversationResult> {
  const now = (env.now ?? (() => new Date().toISOString()))();
  const steps = emptySteps();

  if (!(await vaultIdentityMatches(env))) {
    await persistOutcome(entry, steps, "held", "vault-identity-mismatch", now);
    return { status: "held", reason: "vault-identity-mismatch" };
  }

  const canonical = await config.getCanonical(entry.recordId);
  if (!canonical) {
    await persistOutcome(entry, steps, "held", "canonical-record-missing", now);
    return { status: "held", reason: "canonical-record-missing" };
  }
  if (canonical.updatedAt !== entry.recordUpdatedAt) {
    await persistOutcome(entry, steps, "pending", "outbox-entry-stale", now);
    return { status: "pending", reason: "outbox-entry-stale" };
  }

  const registryKey = config.registryKeyFor(canonical);
  const bucket = vaultRegistryBucketOf(registryKey);
  const registryPeek = await readJsonAt(env, registryShardPath(bucket));
  const registryPath =
    registryPeek.state === "ok" && isObj(registryPeek.value.records) && typeof registryPeek.value.records[registryKey] === "string"
      ? (registryPeek.value.records[registryKey] as string)
      : undefined;

  try {
    const markdownVerdict = await decideSingleFileMarkdown(env, canonical, registryPath, config);
    await projectSingleFileMarkdown(env, canonical, markdownVerdict, config);
    steps.markdown = "done";

    await decideAndProjectSingleFileRegistry(env, canonical, markdownVerdict.path, config);
    steps.registry = "done";

    await decideAndProjectSingleFileIndex(env, canonical, markdownVerdict.path);
    steps.index = "done";

    if (config.historyRowFor) {
      await decideAndProjectSingleFileHistory(env, canonical, config);
      steps.history = "done";
    } else {
      steps.history = "not-needed";
    }

    const verify = await finalVerifySingleFile(env, canonical, markdownVerdict.path, config);
    if (!verify.ok) {
      await persistOutcome(entry, steps, "pending", verify.reason, now);
      return { status: "pending", reason: verify.reason };
    }

    await persistOutcome(entry, steps, "done", null, now);
    return { status: "done" };
  } catch (error) {
    if (error instanceof ProjectionConflictError) {
      await persistOutcome(entry, steps, "held", error.message, now);
      return { status: "held", reason: error.message };
    }
    const reason = error instanceof Error ? error.message : "unknown-projection-error";
    await persistOutcome(entry, steps, "pending", reason, now);
    return { status: "pending", reason };
  }
}

// ---------------------------------------------------------------------------
// Reflection：1record1file、`Memories/`配下（既存`writeMemoryObjectMarkdownImpl`の
// `isReflectionSummary`分岐と同じpath規則）。MemoryObjectそのものであり、Markdown
// シリアライズ／パースはnormal Memoryと完全に同一（`memoryObjectToMarkdown`／
// `parseMemoryObjectMarkdown`）。「legitimate successor」もPhase 3-6で定義した
// `isMemoryLegitimateSuccessor`をそのまま再利用する（req 2：ConversationのPrefix
// 判定を無理に流用せず、実データ構造＝MemoryObjectとしての判定を自然に適用した結果、
// Memory day-fileと同じ関数がそのまま使える）。
// ---------------------------------------------------------------------------

const reflectionConfig: SingleFileRecordConfig<MemoryObject> = {
  recordType: "reflection",
  pathFor: (r) => `Memories/${fileNameFor(r.id, r.date)}`,
  registryKeyFor: (r) => r.id,
  toMarkdown: memoryObjectToMarkdown,
  parseMarkdown: parseMemoryObjectMarkdown,
  isLegitimateSuccessor: isMemoryLegitimateSuccessor,
  historyRowFor: (r) => ({ day: r.date.slice(0, 10), preview: truncateHistoryPreview(r.summary), createdAt: r.createdAt }),
  getCanonical: getMemoryObject,
};

export async function reconcileReflectionOutboxEntry(env: ProjectionEnv, entry: VaultOutboxEntry): Promise<ReconcileConversationResult> {
  return reconcileSingleFileOutboxEntry(env, entry, reflectionConfig);
}

export async function reconcilePendingReflections(env: ProjectionEnv): Promise<ReconcileAllResult> {
  const pending = await getPendingVaultOutboxEntries();
  const result: ReconcileAllResult = { done: 0, pending: 0, held: 0 };
  for (const entry of pending) {
    if (entry.recordType !== "reflection") continue;
    const outcome = await reconcileReflectionOutboxEntry(env, entry);
    result[outcome.status] += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Source：1record1file、`Sources/`配下。`Metadata`を持たない最小構成のため
// Historyを持たない（`writeSourceMarkdownImpl`にHistory呼び出しが無いのと同じ）。
// 「legitimate successor」の前例が既存実装に無い（`createSource`はcreatedAt===
// updatedAtで生成し、以後の更新経路が存在しない）ため、無理に条件を作らず
// `isLegitimateSuccessor: null`（＝内容不一致は無条件でconflict）とする
// （req 2「実データ構造に合う判定をする」の適用）。
// ---------------------------------------------------------------------------

const sourceConfig: SingleFileRecordConfig<Source> = {
  recordType: "source",
  pathFor: (s) => `Sources/${fileNameFor(s.id, s.createdAt)}`,
  registryKeyFor: (s) => s.id,
  toMarkdown: sourceToMarkdown,
  parseMarkdown: (text) => {
    try {
      return parseSourceMarkdown(text);
    } catch {
      return null;
    }
  },
  isLegitimateSuccessor: null,
  getCanonical: getSource,
};

export async function reconcileSourceOutboxEntry(env: ProjectionEnv, entry: VaultOutboxEntry): Promise<ReconcileConversationResult> {
  return reconcileSingleFileOutboxEntry(env, entry, sourceConfig);
}

export async function reconcilePendingSources(env: ProjectionEnv): Promise<ReconcileAllResult> {
  const pending = await getPendingVaultOutboxEntries();
  const result: ReconcileAllResult = { done: 0, pending: 0, held: 0 };
  for (const entry of pending) {
    if (entry.recordType !== "source") continue;
    const outcome = await reconcileSourceOutboxEntry(env, entry);
    result[outcome.status] += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Unified Reconcile（Phase 3-7 req 6）：Conversation/Memory/Reflection/Sourceの
// pending outboxを、record typeごとの適切なProjectionへdispatchしてまとめて処理する。
// 1件のheld/conflictが他recordのsafe reconcileを止めないこと（`for`ループの中で
// 1件ずつ例外を握りつぶす——各reconcile*OutboxEntry自体が既に内部でtry/catchして
// pending/heldを返す設計だが、想定外の例外に対する最後の防波堤として、ここでも
// 1件のthrowでループ全体を止めない）。
// ---------------------------------------------------------------------------

export interface ReconcileAllRecordTypesResult {
  processed: number;
  done: number;
  pending: number;
  held: number;
  /** 想定外の例外（reconcile*OutboxEntry自体は通常throwしない設計のため、フェイルセーフ用）。 */
  failed: number;
  byRecordType: Record<string, { done: number; pending: number; held: number; failed: number }>;
}

function emptyReconcileAllRecordTypesResult(): ReconcileAllRecordTypesResult {
  return { processed: 0, done: 0, pending: 0, held: 0, failed: 0, byRecordType: {} };
}

function bumpRecordTypeTally(result: ReconcileAllRecordTypesResult, recordType: string, key: "done" | "pending" | "held" | "failed"): void {
  const bucket = result.byRecordType[recordType] ?? { done: 0, pending: 0, held: 0, failed: 0 };
  bucket[key] += 1;
  result.byRecordType[recordType] = bucket;
}

/**
 * entry一覧を、record typeに応じた適切なProjectionへdispatchしてまとめて処理する
 * 共通実装（`reconcilePendingVaultOutbox`・`reconcileDoneVaultOutboxIntegrity`の
 * どちらも、対象entryの集め方が違うだけで、処理自体はこの1つを共有する）。
 */
async function dispatchEntry(env: ProjectionEnv, entry: VaultOutboxEntry): Promise<ReconcileConversationResult> {
  switch (entry.recordType) {
    case "conversation":
      return reconcileConversationOutboxEntry(env, entry);
    case "memory":
      return reconcileMemoryOutboxEntry(env, entry);
    case "reflection":
      return reconcileReflectionOutboxEntry(env, entry);
    case "source":
      return reconcileSourceOutboxEntry(env, entry);
    default:
      // 未知record type（将来のPerson/Topic等がoutboxへ紛れ込んだ場合の防御）。
      // このEngineはまだ対応していないrecord typeを黙って処理済み扱いにはしない。
      return { status: "held", reason: `unknown-record-type:${entry.recordType}` };
  }
}

/**
 * One entry inside a pass. An entry that is already "done" is first re-verified against the reads this pass has remembered (cheap: nothing is read twice, nothing
 * is written); the moment that evaluation would write, or would end in anything but "done", it is thrown away and the entry is evaluated again with the remembered
 * reads cleared, i.e. from fresh reads, exactly as before. Every other entry (new / changed / held / retry) starts from cleared memory.
 */
async function reconcileEntryInPass(env: ProjectionEnv, entry: VaultOutboxEntry): Promise<ReconcileConversationResult> {
  const pass = passStates.get(env);
  if (!pass) return dispatchEntry(env, entry);
  if (entry.status === "done") {
    pass.cachedOnly = true;
    cachedOnlyEntries.add(entry);
    try { return await dispatchEntry(env, entry); }
    catch (error) { if (!(error instanceof NeedsFreshRead)) throw error; }
    finally { pass.cachedOnly = false; cachedOnlyEntries.delete(entry); }
  }
  pass.map.clear();
  pass.gen += 1;
  return dispatchEntry(env, entry);
}

const PREFETCH_CONCURRENCY = 6;
const PREFETCH_MIN_ENTRIES = 8;

/**
 * READ ONLY read-ahead for a re-verification pass: the files every entry is going to read anyway (identity, index, history-meta, and per record the day file / conversation
 * file, the registry shard and the History month) are read ONCE, a few at a time in parallel (no writes, bounded concurrency), instead of one after the other in the
 * per-record loop. The set is derived from the records themselves; nothing else in the Vault is scanned. A read that fails is simply not remembered (the entry reads it
 * itself, as before).
 */
async function prefetchPassReads(env: ProjectionEnv, entries: VaultOutboxEntry[]): Promise<void> {
  if (!passStates.get(env) || entries.length < PREFETCH_MIN_ENTRIES) return;
  const paths = new Set<string>([VAULT_IDENTITY_PATH, INDEX_PATH, HISTORY_META_PATH]);
  for (const entry of entries) {
    try {
      if (entry.recordType === "memory") {
        const m = await getMemoryObject(entry.recordId);
        if (m) { const day = m.date.slice(0, 10); paths.add(memoryDayFilePath(m)); paths.add(registryShardPath(vaultRegistryBucketOf(dayFileRegistryKey(day)))); paths.add(historyMonthPath(day)); }
      } else if (entry.recordType === "conversation") {
        const c = await getConversation(entry.recordId);
        if (c) { paths.add(defaultConversationPath(c)); paths.add(registryShardPath(vaultRegistryBucketOf(c.id))); paths.add(historyMonthPath(c.startedAt.slice(0, 10))); }
      }
    } catch { /* the entry will read what it needs itself */ }
  }
  const list = [...paths];
  let next = 0;
  const worker = async () => { while (next < list.length) { const path = list[next++]; try { await readTextAt(env, path); } catch { /* not remembered */ } } };
  await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, list.length) }, worker));
}

async function reconcileOutboxEntries(env: ProjectionEnv, entries: VaultOutboxEntry[], options: { prefetch?: boolean } = {}): Promise<ReconcileAllRecordTypesResult> {
  const result = emptyReconcileAllRecordTypesResult();
  const ownsPass = !passStates.has(env);
  if (ownsPass) passStates.set(env, { map: new Map(), gen: 0, cachedOnly: false });
  try {
    if (options.prefetch) await prefetchPassReads(env, entries);
    for (const entry of entries) {
      result.processed += 1;
      try {
        const outcome = await reconcileEntryInPass(env, entry);
        result[outcome.status] += 1;
        bumpRecordTypeTally(result, entry.recordType, outcome.status);
      } catch (error) {
        result.failed += 1;
        bumpRecordTypeTally(result, entry.recordType, "failed");
        console.error(`[Tsumugi] reconcileOutboxEntries: unexpected error for ${entry.recordType}:${entry.recordId}, continuing with other records:`, error);
      }
    }
  } finally {
    if (ownsPass) passStates.delete(env);
  }
  return result;
}

export async function reconcilePendingVaultOutbox(env: ProjectionEnv): Promise<ReconcileAllRecordTypesResult> {
  return reconcileOutboxEntries(env, await getPendingVaultOutboxEntries());
}

/**
 * Phase 3-7.1：done outbox entryのintegrity検証。
 *
 * 原則（req 1）：outbox `status === "done"`は「最後に確認した時点では整合していた」
 * というcache/progress hintであって、永続的truthではない。`getPendingVaultOutboxEntries()`
 * は`status==="pending"`のindexしか見ないため、doneになった後でVault実体（Markdown・
 * Registry・History・index）の一部が外部から欠落・破損しても、通常のpending-only
 * reconcileは二度とそのentryへ到達しない——これがPhase 3-7で発見した自己修復の
 * gapであり、この関数で閉じる。
 *
 * 新しい整合性判定は作らない（req 6）：doneのentryも、既存の
 * `reconcile{Conversation,Memory,Reflection,Source}OutboxEntry`へそのまま渡すだけで
 * よい——これらは元々entryの`status`を一切信用せず、呼ばれるたびに必ず
 * read→compare→decide→project→verifyをやり直す設計（Invariant 3、Phase 3-3で
 * 確立・Phase 3-6/3-7でも踏襲）。したがって：
 *   - Registry/History/index欠落 → 該当stepだけ再生成される（req 3-A/B）
 *   - Markdown欠落 → canonicalから安全に再projectionされる（req 3-C）
 *   - 内容が対象外の形で食い違う（genuine conflict） → held、上書きしない（req 3-D）
 *   - parse不能・読めない → held（req 3-E）
 *   - 実体が既に正しい → 各stepの既存のno-op検出により、1byteも書き込まれない（req 3-F）
 * のいずれも、この関数自身は何も新しく判定しない——単に「doneも対象に含める」
 * ことだけが新しい振る舞い。
 *
 * コスト（req 2、詳細はPhase 3-7.1報告参照）：`by-status`indexによる
 * `getDoneVaultOutboxEntries()`自体は軽量（indexed range query）。実際のI/Oコストは
 * 1 entryあたり最大4回のVault read（Markdown・Registry shard・index.json・History
 * 月ファイル。Source等Historyを持たないrecord typeはさらに少ない）で、Beta規模
 * （個人ユーザー1人あたりのConversation/Memory総数）では、これをbootstrapのたびに
 * 全件行っても許容範囲と判断した（過剰設計をしない。req 5）。将来的にrecord数が
 * 増えた場合は、rotating verification・Registry mtimeベースのdirty detection等への
 * 発展余地を残すに留め、今回は実装しない。
 */
/**
 * 比較ルールが変わったときに、「過去のルールではheldだった」entryを現在のルールで再評価する（既存の`reconcile*OutboxEntry`をそのまま使う。
 * 競合は従来どおり上書きせず、再びheldになる）。
 */
export async function reconcileHeldVaultOutbox(env: ProjectionEnv): Promise<ReconcileAllRecordTypesResult> {
  return reconcileOutboxEntries(env, await getHeldVaultOutboxEntries());
}

/** held outboxの再評価を行う比較ルールのversion。Projectionの「同じ」の定義を変えたときだけ上げる。 */
export const PROJECTION_HELD_RULE_VERSION = "memory-sourcetype-normalized-v1";

/**
 * 現在のルールversionでまだ再評価していなければ、heldを1回だけ再評価して記録する。
 * 同じversionでは二度と行わない（真の競合のheldを毎起動で再試行しない）。再評価を最後まで終えた後にだけ記録するため、
 * 途中で中断すれば次回また行う（reconcile自体が冪等）。
 */
export async function reevaluateHeldOutboxOnce(env: ProjectionEnv, ruleVersion: string = PROJECTION_HELD_RULE_VERSION): Promise<ReconcileAllRecordTypesResult | null> {
  if (await getProjectionHeldReevaluationMarker(ruleVersion)) {
    await reevaluateRewriteHeldOutbox(env);
    return null;
  }
  const result = await reconcileHeldVaultOutbox(env);
  await setProjectionHeldReevaluationMarker(ruleVersion, (env.now ?? (() => new Date().toISOString()))());
  return result;
}

/**
 * 書き込みの安全条件で保留になった記録を、起動ごとに1回だけ判定し直す（ユーザーがファイルを直した後に、保存を自動で再開するため）。
 * 判定が変わらなければ何も書かない。1回の起動で1回だけなので、繰り返しにはならない。
 */
export async function reevaluateRewriteHeldOutbox(env: ProjectionEnv): Promise<ReconcileAllRecordTypesResult> {
  const entries = (await getHeldVaultOutboxEntries()).filter((e) => /(-edited-conflict|markdown-unreadable|memory-dayfile-unreadable|-not-mergeable)$/.test(e.heldReason ?? ""));
  for (const entry of entries) quietHolds.add(entry);
  return reconcileOutboxEntries(env, entries);
}

export async function reconcileDoneVaultOutboxIntegrity(env: ProjectionEnv): Promise<ReconcileAllRecordTypesResult> {
  // 「両方そのままにする」でユーザーが受け入れた食い違い（その版に限る）は、再びheldに戻さない。recordが新しい版へ進めば、通常どおり再projectionされる。
  // Only the CONTENT comparison is skipped: an accepted entry whose Vault copy is gone ("absent") is checked like any other done entry (so a lost copy is re-projected
  // and the local record is not the only one); "present" and "unknown" (unreadable / too large to decide) leave it alone.
  const accepted = await getAcceptedDivergences();
  const entries: VaultOutboxEntry[] = [];
  for (const e of await getDoneVaultOutboxEntries()) {
    if (accepted[e.id] !== e.recordUpdatedAt) { entries.push(e); continue; }
    if ((await findRecordInVault(env.root, e.recordId)) === "absent") entries.push(e);
  }
  return reconcileOutboxEntries(env, entries, { prefetch: true });
}
