/** Archive-only cleanup. Current records and management files remain read-only.
 * world exclusive → save lock → pending Recovery gate → verified snapshots.
 */
import {
  getAllConversations,
  getAllMemoryObjects,
  getAllSources,
  getConversation,
  getMemoryObject,
  getSource,
  getVaultIdentityRecord,
} from "./db";
import { isRecoveryBlockingNormalWrites } from "./vaultRecoveryJournal";
import { buildVaultRecoveryPlan, type RecoveryLocalSnapshot, type RecoveryPlan, type RecoveryRecord } from "./vaultRecovery";
import { planRecoveryApply, type RecoveryApplyEnv, type RecoveryApplyPlan, type RecoveryHeld } from "./vaultRecoveryApply";

import { hashVaultText, isReflectionSummary } from "./vault";
import { withVaultSaveLock } from "./vaultSaveLock";
import { runVaultWorldExclusive } from "./vaultWorldLock";
import {
  listRecoveryArchiveEntries,
  readAllPathsForArchive,
  writeRecoveryArchiveEntry,
  type RecoveryArchiveEntry,
  type RecoveryArchiveRecordType,
} from "./vaultRecoveryArchive";
import type { Conversation, MemoryObject, Source } from "./types";
import type { VaultIdentityRecord } from "./vaultIdentity";

export {
  listRecoveryArchiveEntries,
  collectRecoveryArchiveFiles,
  type RecoveryArchiveEntry,
  type RecoveryArchiveExportFile,
} from "./vaultRecoveryArchive";

// ---------------------------------------------------------------------------
// 実体の読み込み
// ---------------------------------------------------------------------------

type TextRead = { state: "ok"; text: string } | { state: "absent" } | { state: "error" };

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

// ---------------------------------------------------------------------------
// 分類・共通ヘルパ
// ---------------------------------------------------------------------------

export interface LegacyCleanupEnv {
  root: FileSystemDirectoryHandle;
  vaultIdentity: VaultIdentityRecord | null;
  now?: () => string;
}

/**
 * Recovery自身の分類のうち、このcleanupが扱いうるもの。`local-only-safe`／
 * `equivalent-existing`はRecovery自身の「復旧する」の領分（重複実装しない）。
 * `vault-only`は一切触れない（絶対原則）。
 */
const RESOLVABLE_CLASSIFICATIONS: ReadonlySet<RecoveryRecord["classification"]> = new Set([
  "conflict",
  "memory-dayfile-merge-required",
  "unreadable / indeterminate",
]);

/** 「不在を証明できない」ことを意味する理由。安全に判断できないため一切触らない。 */
const UNSAFE_REASONS = new Set(["vault-scan-incomplete", "strict-read-or-parse-failure"]);

const ARCHIVE_ELIGIBLE_APPLY_HELD_REASONS = new Set(["conflict", "memory-dayfile-merge-required", "unreadable-or-indeterminate"]);

const EMPTY_RECOVERY_PLAN_COUNTS: RecoveryPlan["counts"] = {
  "local-only-safe": 0,
  "equivalent-existing": 0,
  conflict: 0,
  "memory-dayfile-merge-required": 0,
  "vault-only": 0,
  "unreadable / indeterminate": 0,
};

/** archive対象とすべき実path集合。Memoryはday-file全体（対象memberの有無に関わらず、
 * その日のday-fileが存在するpath）。それ以外は`vaultPaths`（duplicateなら複数）。 */
function pathsToArchive(r: RecoveryRecord): string[] {
  return [...new Set([...r.vaultPaths, ...(r.memoryDay?.paths ?? [])])].sort();
}

async function findCurrentLocal(recordType: RecoveryRecord["recordType"], id: string): Promise<Conversation | MemoryObject | Source | undefined> {
  if (recordType === "conversation") return getConversation(id);
  if (recordType === "source") return getSource(id);
  return getMemoryObject(id); // memory・reflectionともmemoryObjects storeを共有する。
}

function canonicalContentFor(local: Conversation | MemoryObject | Source): string {
  return JSON.stringify(local);
}

async function actualIdentityMatches(env: LegacyCleanupEnv): Promise<boolean> {
  if (!env.vaultIdentity?.vaultId) return false;
  const read = await readTextAt(env.root, ".tsumugi/vault-identity.json");
  if (read.state !== "ok") return false;
  try { return JSON.parse(read.text).vaultId === env.vaultIdentity.vaultId; } catch { return false; }
}

async function freshLocalSnapshot(): Promise<RecoveryLocalSnapshot> {
  return {
    conversations: await getAllConversations(),
    memories: await getAllMemoryObjects(),
    sources: await getAllSources(),
    sync: {},
  };
}

function findLocalIn(snapshot: RecoveryLocalSnapshot, r: RecoveryRecord): Conversation | MemoryObject | Source | undefined {
  if (r.recordType === "conversation") return snapshot.conversations.find((c) => c.id === r.recordId);
  if (r.recordType === "source") return snapshot.sources.find((s) => s.id === r.recordId);
  return snapshot.memories.find((m) => m.id === r.recordId);
}

/** 読み取り専用：現在のRecovery診断（archive除外なし、生の分類）。 */
export async function readCurrentRecoveryPlanForCleanup(root: FileSystemDirectoryHandle): Promise<RecoveryPlan> {
  return buildVaultRecoveryPlan(root, await freshLocalSnapshot());
}

/**
 * 現在のVault・canonical状態が、指定archive entryと完全に一致するか（＝
 * warningから除外してよいか）を確認する。worldVaultId・classification・
 * reasons・path集合・各pathの内容hash・canonical hashの全てを毎回
 * 実際に読み直して比較する——record IDだけ・内容だけ・pathの一部だけの
 * 一致では除外しない。
 */
async function archiveStillMatchesCurrentState(env: LegacyCleanupEnv, r: RecoveryRecord, entry: RecoveryArchiveEntry): Promise<boolean> {
  if (!(await actualIdentityMatches(env))) return false;
  if (entry.recordType !== r.recordType || entry.recordId !== r.recordId) return false;
  if (r.reasons.some(reason => UNSAFE_REASONS.has(reason))) return false;
  const worldVaultId = env.vaultIdentity!.vaultId;
  if (entry.worldVaultId !== worldVaultId) return false;
  if (entry.classification !== r.classification) return false;
  const entryReasons = [...entry.reasons].sort();
  const currentReasons = [...r.reasons].sort();
  if (entryReasons.length !== currentReasons.length || entryReasons.some((x, i) => x !== currentReasons[i])) return false;

  // Exact path identity is independent of classification (a move can keep both reasons and type).
  const paths = pathsToArchive(r);
  const entryPaths = [...entry.vaultPaths].sort();
  const currentPaths = [...paths].sort();
  if (entryPaths.length !== currentPaths.length || entryPaths.some((x, i) => x !== currentPaths[i])) return false;

  const read = await readAllPathsForArchive(env.root, paths);
  if (!read.ok) return false; // 現在の状態を確認できない＝除外しない（安全側）。
  const allKeys = new Set([...Object.keys(entry.contentHashes), ...Object.keys(read.hashes)]);
  for (const key of allKeys) {
    if (entry.contentHashes[key] !== read.hashes[key] || entry.rawFileContents[key] !== read.contents[key]) return false;
  }

  const local = await findCurrentLocal(r.recordType, r.recordId);
  if (!local) return false;
  if ((r.recordType === "memory" || r.recordType === "reflection") && isReflectionSummary(local as MemoryObject) !== (r.recordType === "reflection")) return false;
  const canonicalRaw = canonicalContentFor(local);
  return canonicalRaw === entry.canonicalRaw && hashVaultText(canonicalRaw) === entry.canonicalHash;
}

/** Timestamps can tie. Reuse any verified snapshot of exactly this state. */
async function matchingArchive(env: LegacyCleanupEnv, r: RecoveryRecord): Promise<RecoveryArchiveEntry | null> {
  const entries = await listRecoveryArchiveEntries(env.root);
  for (const entry of entries) {
    if (entry.recordType === r.recordType && entry.recordId === r.recordId && await archiveStillMatchesCurrentState(env, r, entry)) return entry;
  }
  return null;
}

async function archiveHeldRecord(env: LegacyCleanupEnv, r: RecoveryRecord, local: Conversation | MemoryObject | Source): Promise<LegacyHeldOutcome> {
  const archiveRecordType = r.recordType as RecoveryArchiveRecordType;
  const existing = await matchingArchive(env, r);
  if (existing) {
    return { outcome: "archived", archiveId: existing.archiveId };
  }

  const paths = pathsToArchive(r);
  const read = await readAllPathsForArchive(env.root, paths);
  if (!read.ok) return { outcome: "skipped", reason: `archive-precondition-failed: ${read.reason}` };

  const canonicalRaw = canonicalContentFor(local);
  const result = await writeRecoveryArchiveEntry(
    { root: env.root, now: env.now },
    {
      worldVaultId: env.vaultIdentity!.vaultId!,
      recordType: archiveRecordType,
      recordId: r.recordId,
      classification: r.classification,
      reasons: r.reasons,
      canonicalRaw,
      canonicalHash: hashVaultText(canonicalRaw),
      vaultPaths: paths,
      rawFileContents: read.contents,
      contentHashes: read.hashes,
    }
  );
  if (!result.ok) return { outcome: "failed", reason: result.reason };
  return { outcome: "archived", archiveId: result.entry.archiveId };
}

// ---------------------------------------------------------------------------
// 除外判定（診断結果からarchive済み・状態不変のrecordを除く）
// ---------------------------------------------------------------------------

/**
 * `buildVaultRecoveryPlan`の結果から、archive済みで状態不変のrecordを除外する。
 * `readCurrentRecoveryPlanForCleanup`が返すplanにそのまま適用できる。
 */
export async function excludeArchivedFromRecoveryPlan(env: LegacyCleanupEnv, plan: RecoveryPlan): Promise<RecoveryPlan> {
  try {
    const records: RecoveryRecord[] = [];
    for (const r of plan.records) {
      if (RESOLVABLE_CLASSIFICATIONS.has(r.classification)) {
        const entry = await matchingArchive(env, r);
        if (entry) continue; // 除外
      }
      records.push(r);
    }
    const counts: RecoveryPlan["counts"] = { ...EMPTY_RECOVERY_PLAN_COUNTS };
    records.forEach((r) => counts[r.classification]++);
    return { ...plan, records, counts };
  } catch { return plan; }
}

/**
 * `planRecoveryApply`の結果（`heldCount`＝実機で「◯件は内容の確認が必要です」に
 * 表示される数そのもの）から、archive済みで状態不変のrecordを除外する。
 */
export async function excludeArchivedFromApplyPlan(env: LegacyCleanupEnv, plan: RecoveryApplyPlan): Promise<RecoveryApplyPlan> {
  try {
    const held: RecoveryHeld[] = [];
    for (const h of plan.held) {
      if (ARCHIVE_ELIGIBLE_APPLY_HELD_REASONS.has(h.reason)) {
        const r = plan.plan.records.find((rec) => rec.recordType === h.recordType && rec.recordId === h.recordId);
        if (r) {
          const entry = await matchingArchive(env, r);
          if (entry) continue; // 除外
        }
      }
      held.push(h);
    }
    return { ...plan, held, heldCount: held.length };
  } catch { return plan; }
}

/**
 * SettingsPanelの「確認する」（Recovery dry-run）から呼ぶ、archive除外込みの
 * `planRecoveryApply`。既存の呼び出し箇所を差し替えるだけで、archive済み
 * recordが「確認が必要」から正しく外れる。
 */
export async function planRecoveryApplyExcludingArchived(applyEnv: RecoveryApplyEnv): Promise<RecoveryApplyPlan> {
  const raw = await planRecoveryApply(applyEnv);
  const vaultIdentity = await getVaultIdentityRecord();
  return excludeArchivedFromApplyPlan({ root: applyEnv.root, vaultIdentity: vaultIdentity ?? null }, raw);
}

// ---------------------------------------------------------------------------
// cleanup本体
// ---------------------------------------------------------------------------

export type LegacyHeldOutcome =
  | { outcome: "repaired" }
  | { outcome: "archived"; archiveId: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

export interface LegacyHeldResolution {
  recordType: RecoveryRecord["recordType"];
  recordId: string;
  classification: RecoveryRecord["classification"];
  result: LegacyHeldOutcome;
}

export interface LegacyHeldCleanupResult {
  processed: number;
  repaired: number;
  archived: number;
  skipped: number;
  failed: number;
  details: LegacyHeldResolution[];
}

export type LegacyHeldCleanupRunResult = LegacyHeldCleanupResult | { notRun: "recovery-in-progress" } | { notRun: "vault-busy" };

/**
 * 実行本体。lock order：world exclusive（`runVaultWorldExclusive`）→
 * save lock（`withVaultSaveLock`、legacy writer・Save Foundation Bootstrapと
 * 共有）→ **ここでRecovery Journalを再確認**（lock取得前の確認だけでは、
 * lock待機中に別タブ・別操作がRecoveryを開始した場合を見逃す）。
 * 呼び出し元（UI）は追加のlockラップを必要としない。
 */
export async function runLegacyHeldCleanup(env: LegacyCleanupEnv): Promise<LegacyHeldCleanupRunResult> {
  if (await isRecoveryBlockingNormalWrites()) return { notRun: "recovery-in-progress" }; // 早期return（待機コスト削減。安全性の根拠ではない）。
  const locked = await runVaultWorldExclusive(() =>
    withVaultSaveLock(async (): Promise<LegacyHeldCleanupResult | { notRun: "recovery-in-progress" }> => {
      // ここが安全性の根拠：lock取得後に必ず再確認する（lock取得前の確認だけでは、
      // lock待機中に別タブ・別操作がRecoveryを開始した場合を見逃す）。
      if (await isRecoveryBlockingNormalWrites()) return { notRun: "recovery-in-progress" };
      return runLegacyHeldCleanupImpl(env);
    })
  );
  if (locked.timedOut || !locked.result) return { notRun: "vault-busy" };
  return locked.result;
}

async function runLegacyHeldCleanupImpl(env: LegacyCleanupEnv): Promise<LegacyHeldCleanupResult> {
  if (!(await actualIdentityMatches(env))) throw new Error("vault-identity-unconfirmed");
  const snapshot = await freshLocalSnapshot();
  const plan = await buildVaultRecoveryPlan(env.root, snapshot);

  const details: LegacyHeldResolution[] = [];
  for (const r of plan.records) {
    if (!r.indexedDBExists) continue; // vault-onlyには一切触れない（絶対原則）。
    if (!RESOLVABLE_CLASSIFICATIONS.has(r.classification)) continue;
    if (r.reasons.some((x) => UNSAFE_REASONS.has(x))) {
      details.push({ recordType: r.recordType, recordId: r.recordId, classification: r.classification, result: { outcome: "skipped", reason: "scan-incomplete-or-unreadable" } });
      continue;
    }
    const local = findLocalIn(snapshot, r);
    if (!local) {
      details.push({ recordType: r.recordType, recordId: r.recordId, classification: r.classification, result: { outcome: "skipped", reason: "canonical-missing" } });
      continue;
    }
    try {
      const result = await archiveHeldRecord(env, r, local);
      details.push({ recordType: r.recordType, recordId: r.recordId, classification: r.classification, result });
    } catch (error) {
      // 1件の予期しない失敗（page kill・一時I/Oエラー等）で他recordの処理を止めない。
      // このrecordの現在のVault/canonical自体は一切変更していないため、次回再試行できる。
      details.push({
        recordType: r.recordType,
        recordId: r.recordId,
        classification: r.classification,
        result: { outcome: "failed", reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return {
    processed: details.length,
    repaired: details.filter((d) => d.result.outcome === "repaired").length,
    archived: details.filter((d) => d.result.outcome === "archived").length,
    skipped: details.filter((d) => d.result.outcome === "skipped").length,
    failed: details.filter((d) => d.result.outcome === "failed").length,
    details,
  };
}
