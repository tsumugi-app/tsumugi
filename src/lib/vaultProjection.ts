/**
 * Vault Projection Engine（新保存基盤 Phase 3-3）。
 *
 * IndexedDB canonical record（`conversations`等） + `vaultOutbox`（Phase 3-1）から、
 * Vault側（Markdown本体・Registry・`.tsumugi/index.json`・History）を「あるべき状態」へ
 * 収束させる。既存の`writeConversationMarkdownImpl`（baseline gate・4段階非atomic書き込み）
 * はラップしない——read（実体を読む）→compare（canonicalと比較する）→decide（create/
 * update/no-op/conflict/heldを判定する）→project（必要な分だけ書く）→verify（書いた後に
 * 実際に整合しているか確認する）を、このファイルで明示的に実装する。
 *
 * 対象はPhase 3-3時点ではConversationのみ（Memory day-file・Reflection・Sourceは
 * Phase 3-4以降）。
 *
 * 重要：baselineEstablishedAtはwrite permissionとして一切使わない（Phase 1で特定した
 * 今回のiPhone事故の根本原因）。projection許可条件は (1) Vault identityが一致
 * (2) canonical recordが存在 (3) 対象Vault実体との比較でconflictがない、の3つだけ。
 *
 * このファイルはまだどの本番経路（ChatScreen.tsx／capture.ts／起動処理）からも呼ばれない
 * （Phase 3-3は、テストから呼べるlibraryとして完成させるところまで）。
 */
import { getConversation, getPendingVaultOutboxEntries, putVaultOutboxEntry } from "./db";
import type { VaultOutboxEntry, ProjectionStepName, ProjectionStepState } from "./vaultOutbox";
import type { VaultIdentityRecord } from "./vaultIdentity";
import type { Conversation } from "./types";
import { conversationToMarkdown, parseConversationMarkdown } from "./markdown";
import { fileNameFor, vaultRegistryBucketOf, hashVaultText, vaultProjectionPrimitives } from "./vault";

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

async function readTextAt(root: FileSystemDirectoryHandle, path: string): Promise<TextRead> {
  const segments = path.split("/");
  try {
    let dir = root;
    for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
    const fileHandle = await dir.getFileHandle(segments[segments.length - 1], { create: false });
    const file = await fileHandle.getFile();
    return { state: "ok", text: await file.text() };
  } catch (error) {
    return isNotFoundError(error) ? { state: "absent" } : { state: "error" };
  }
}

/** 0byteファイルは「不在」として扱う（Vault全体で共通の既存の規約）。 */
async function readJsonAt(root: FileSystemDirectoryHandle, path: string): Promise<JsonRead> {
  const raw = await readTextAt(root, path);
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

async function dirAndFileNameFor(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; fileName: string }> {
  const segments = path.split("/");
  let dir = root;
  for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
  return { dir, fileName: segments[segments.length - 1] };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
  const read = await readJsonAt(env.root, VAULT_IDENTITY_PATH);
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

async function decideMarkdown(env: ProjectionEnv, canonical: Conversation, registryPath: string | undefined): Promise<MarkdownVerdict> {
  const path = registryPath ?? defaultConversationPath(canonical);
  const expectedContent = conversationToMarkdown(canonical);
  const read = await readTextAt(env.root, path);
  if (read.state === "error") throw new ProjectionConflictError("markdown-unreadable");
  if (read.state === "absent") return { kind: "create", path };
  if (read.text === expectedContent) return { kind: "no-op", path };
  const parsed = parseConversationMarkdown(read.text);
  if (!parsed) throw new ProjectionConflictError("markdown-unreadable");
  if (!isLegitimatePredecessor(parsed, canonical)) throw new ProjectionConflictError("markdown-conflict");
  return { kind: "update", path };
}

async function projectMarkdown(env: ProjectionEnv, canonical: Conversation, verdict: MarkdownVerdict): Promise<void> {
  if (verdict.kind === "no-op") return;
  const { dir, fileName } = await dirAndFileNameFor(env.root, verdict.path, true);
  try {
    await vaultProjectionPrimitives.writeFileInDir(dir, fileName, conversationToMarkdown(canonical), "projection markdown");
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
  const read = await readJsonAt(env.root, shardPath);
  if (read.state === "error") throw new ProjectionConflictError("registry-unreadable");
  const records = read.state === "ok" && isObj(read.value.records) ? (read.value.records as Record<string, unknown>) : {};
  const files = read.state === "ok" && isObj(read.value.files) ? (read.value.files as Record<string, unknown>) : {};
  const currentPath = records[canonical.id];
  // 対象外key・対象外pathには一切触れない（`upsertVaultRegistryRecord`自身が
  // read-modify-writeでこのregistryKey分のentryだけを更新するため、他recordの
  // 行は構造的に保護される）。
  const { dir, fileName } = await dirAndFileNameFor(env.root, path, false);
  let stat: { mtime: number; size: number };
  try {
    stat = await vaultProjectionPrimitives.readVaultFileStat(dir, fileName);
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "markdown-stat-failed");
  }
  const content = conversationToMarkdown(canonical);
  const expected = { recordType: "conversation" as const, mtime: stat.mtime, size: stat.size, contentHash: hashVaultText(content), memberIds: [canonical.id], status: "ok" as const };
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
  try {
    await vaultProjectionPrimitives.upsertVaultRegistryRecord(env.root, { registryKey: canonical.id, path, ...expected });
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "registry-write-failed");
  }
}

// ---------------------------------------------------------------------------
// Conversation：index.json判定
// ---------------------------------------------------------------------------

async function decideAndProjectIndex(env: ProjectionEnv, canonical: Conversation, path: string): Promise<void> {
  const read = await readJsonAt(env.root, INDEX_PATH);
  if (read.state === "error") throw new ProjectionConflictError("index-unreadable");
  const current = read.state === "ok" ? read.value[canonical.id] : undefined;
  if (current === path) return; // no-op（対象外の他keyには一切触れない——updateIndexも読み込んだ全体をそのまま書き戻すread-modify-writeのため保護される）
  try {
    await vaultProjectionPrimitives.updateIndex(env.root, canonical.id, path);
  } catch (error) {
    throw new ProjectionRetryableError(error instanceof Error ? error.message : "index-write-failed");
  }
}

// ---------------------------------------------------------------------------
// Conversation：History判定
// ---------------------------------------------------------------------------

async function decideAndProjectHistory(env: ProjectionEnv, canonical: Conversation): Promise<void> {
  const day = canonical.startedAt.slice(0, 10);
  const monthPath = historyMonthPath(day);
  // 月ファイル・meta双方が「構造として読めるか」だけをここで確認する（`updateHistoryIndex`
  // 自身のreadJSONは破損を「空」に丸めてしまうため、それに委ねると他の日のデータを
  // 巻き込んで消しかねない。読めることさえ確認できれば、以降の実際の更新判断
  // （変化が無ければ書かない）は既存のupdateHistoryIndexの絶対値書き込みに任せてよい
  // ——同じday・同じ入力からは常に同じ結果になるため、他の日・他月には触れない）。
  const monthRead = await readJsonAt(env.root, monthPath);
  if (monthRead.state === "error") throw new ProjectionConflictError("history-unreadable");
  const metaRead = await readJsonAt(env.root, HISTORY_META_PATH);
  if (metaRead.state === "error") throw new ProjectionConflictError("history-meta-unreadable");
  const mode = canonical.persona === "companion" ? "diary" : "conversation";
  try {
    await vaultProjectionPrimitives.updateHistoryIndex(env.root, { kind: "conversation", id: canonical.id, day, mode, turnCount: canonical.turns.length });
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
  const markdownRead = await readTextAt(env.root, path);
  if (markdownRead.state !== "ok" || markdownRead.text !== expectedContent) return { ok: false, reason: "verify-markdown-mismatch" };

  const bucket = vaultRegistryBucketOf(canonical.id);
  const registryRead = await readJsonAt(env.root, registryShardPath(bucket));
  if (registryRead.state !== "ok") return { ok: false, reason: "verify-registry-missing" };
  const records = isObj(registryRead.value.records) ? registryRead.value.records : {};
  const files = isObj(registryRead.value.files) ? registryRead.value.files : {};
  const entry = records[canonical.id] === path ? files[path] : undefined;
  if (!isObj(entry) || entry.status !== "ok" || entry.contentHash !== hashVaultText(expectedContent)) return { ok: false, reason: "verify-registry-mismatch" };

  const indexRead = await readJsonAt(env.root, INDEX_PATH);
  if (indexRead.state !== "ok" || indexRead.value[canonical.id] !== path) return { ok: false, reason: "verify-index-mismatch" };

  const day = canonical.startedAt.slice(0, 10);
  const historyRead = await readJsonAt(env.root, historyMonthPath(day));
  if (historyRead.state !== "ok") return { ok: false, reason: "verify-history-missing" };
  const days = isObj(historyRead.value.days) ? historyRead.value.days : {};
  const dayEntry = days[day];
  const row = isObj(dayEntry) && Array.isArray(dayEntry.conversations) ? dayEntry.conversations.find((r) => isObj(r) && r.id === canonical.id) : undefined;
  const expectedMode = canonical.persona === "companion" ? "diary" : "conversation";
  if (!isObj(row) || row.mode !== expectedMode || row.turnCount !== canonical.turns.length) return { ok: false, reason: "verify-history-mismatch" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// outbox entryの更新
// ---------------------------------------------------------------------------

function emptySteps(): Record<ProjectionStepName, ProjectionStepState> {
  return { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "not-needed" };
}

async function persistOutcome(entry: VaultOutboxEntry, steps: Record<ProjectionStepName, ProjectionStepState>, status: "done" | "pending" | "held", reason: string | null, now: string): Promise<void> {
  const attempt = status === "done" ? entry.attempt : { count: entry.attempt.count + 1, lastError: reason, lastAttemptAt: now };
  await putVaultOutboxEntry({ ...entry, steps, status, heldReason: status === "held" ? reason : null, attempt, updatedAt: now });
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
  const registryPeek = await readJsonAt(env.root, registryShardPath(bucket));
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
