/**
 * 自動修復（vaultAutoRepair.ts）の本番の配線：実際のIndexedDB・保存先・ロック・既存の復旧・通常の保存処理を渡すだけ。
 * 規則と順序はvaultAutoRepair.tsにある。
 */
import { getConversation, getMemoryObject, getSource, getVaultIdentityRecord, getVaultOutboxEntry, readBackupDeviceSnapshot, requeueRecordForVault, RecoveryPendingError } from "./db";
import { isReflectionSummary } from "./vault";
import { dayFileRoundTrips, runVaultAutoRepair, type AutoRepairEnv, type AutoRepairOutcome, type AutoRepairTargetInspection } from "./vaultAutoRepair";
import { createVaultBackup } from "./vaultBackup";
import { checkVaultConsistency } from "./vaultConsistencyCheck";
import type { ConsistencyCheckOptions, RepairTarget } from "./vaultConsistency";
import type { MemoryObject } from "./types";
import { memoryDayFilePath, reconcileConversationOutboxEntry, reconcileMemoryOutboxEntry, reconcileReflectionOutboxEntry, reconcileSourceOutboxEntry, type ProjectionEnv } from "./vaultProjection";
import { withVaultSaveLock } from "./vaultSaveLock";
import { applyRecovery, createRecoveryApplyEnv, type RecoveryApplyPlan } from "./vaultRecoveryApply";
import { runVaultWorldExclusive, withVaultWorldRead } from "./vaultWorldLock";

/** 保存先のファイルを読む（無ければnull。読めなければ"unreadable"） */
export async function readVaultFileBytes(root: FileSystemDirectoryHandle, path: string): Promise<Uint8Array | null | "unreadable"> {
  const parts = path.split("/");
  let dir = root;
  try {
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(parts[parts.length - 1]);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    const name = error instanceof DOMException || error instanceof Error ? error.name : "";
    return name === "NotFoundError" || name === "TypeMismatchError" ? null : "unreadable";
  }
}

export interface ProductionAutoRepairOptions {
  root: FileSystemDirectoryHandle;
  backend: string;
  /** バックアップに記録するアプリのビルド識別子（ChatScreenがrecoveryBackgroundCheckのAPP_BUILD_IDを渡す。ここでは読み込まない：process.envを参照するため） */
  build: string;
  isCancelled(): boolean;
  /** 保存待ちに戻した記録だけを書き出す。既定は通常の保存と同じ処理（reconcile*OutboxEntry）を、同じロック（world lockの共有モード＋保存ロック）で */
  settleSaves?(targets: RepairTarget[]): Promise<void>;
  /** 確認の待ち時間・やり直し回数（テスト用。既定はvaultConsistency.tsの既定値） */
  checkOptions?: ConsistencyCheckOptions;
}

export function createProductionAutoRepairEnv(options: ProductionAutoRepairOptions): AutoRepairEnv {
  const { root } = options;
  let lastPlan: RecoveryApplyPlan | null = null;
  const vaultPathsOf = (t: RepairTarget): string[] => {
    const typeMatches = (r: string) => (t.recordType === "memory" || t.recordType === "reflection" ? r === "memory" || r === "reflection" : r === t.recordType);
    return lastPlan?.plan.records.find((r) => r.recordId === t.recordId && typeMatches(r.recordType))?.vaultPaths ?? [];
  };
  return {
    async check() {
      const { report, plan } = await checkVaultConsistency(root, options.isCancelled, options.checkOptions);
      lastPlan = plan;
      return report;
    },
    createBackup: () => createVaultBackup({
      root,
      readDevice: readBackupDeviceSnapshot,
      withWorldRead: withVaultWorldRead,
      now: () => new Date().toISOString(),
      runId: () => `repair-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}-${Math.random().toString(36).slice(2, 8)}`,
      build: options.build,
      backend: options.backend,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      isCancelled: options.isCancelled,
    }),
    async withExclusive(fn) {
      const locked = await runVaultWorldExclusive(fn);
      return locked.timedOut || locked.result === undefined ? { ok: false } : { ok: true, value: locked.result };
    },
    readVaultFile: (path) => readVaultFileBytes(root, path),
    async inspectTarget(t): Promise<AutoRepairTargetInspection> {
      const record = t.recordType === "conversation" ? await getConversation(t.recordId) : t.recordType === "source" ? await getSource(t.recordId) : await getMemoryObject(t.recordId);
      if (!record) return { version: null, paths: [], blocked: null };
      // apply：新しいファイルの作成（無いことを確認して作る）か、管理情報だけの更新。既存の記録のファイルは書き換えない
      if (t.action === "apply") return { version: record.updatedAt, paths: [], blocked: null };
      const paths = new Set(vaultPathsOf(t));
      let blocked: AutoRepairTargetInspection["blocked"] = null;
      if (t.recordType === "memory" && !isReflectionSummary(record as MemoryObject)) {
        const dayPath = memoryDayFilePath(record as MemoryObject);
        paths.add(dayPath);
        const bytes = await readVaultFileBytes(root, dayPath);
        if (bytes === "unreadable") blocked = "unreadable";
        else if (bytes !== null) {
          let text: string | null = null;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = null; }
          if (text === null || !dayFileRoundTrips(text)) blocked = "day-file-not-mergeable";
        }
      }
      return { version: record.updatedAt, paths: [...paths], blocked };
    },
    async applyRecovery(recordIds) {
      const env = createRecoveryApplyEnv(root, { isStale: options.isCancelled });
      const world = await env.readWorld();
      return applyRecovery(env, { world, recordIds });
    },
    async requeue(t, version) {
      try {
        return await requeueRecordForVault(t.recordType, t.recordId, version);
      } catch (error) {
        if (error instanceof RecoveryPendingError) return "repair-in-progress";
        throw error;
      }
    },
    // 起動時の保存処理（移行・全件の確認）は使わない：飛ばした記録まで書き出しうるため。保存待ちに戻した記録のOutboxだけを処理する。
    // 書き出せなければ（競合・読めない）保存処理がheldに戻す・保存待ちのまま残す。どちらも直後の再確認に残る
    settleSaves: options.settleSaves ?? ((targets) => withVaultWorldRead(() => withVaultSaveLock(async () => {
      const env: ProjectionEnv = { root, vaultIdentity: (await getVaultIdentityRecord()) ?? null };
      for (const t of targets) {
        const entry = await getVaultOutboxEntry(`${t.recordType}:${t.recordId}`);
        if (!entry || entry.status !== "pending") continue;
        const reconcile = entry.recordType === "conversation" ? reconcileConversationOutboxEntry : entry.recordType === "memory" ? reconcileMemoryOutboxEntry : entry.recordType === "reflection" ? reconcileReflectionOutboxEntry : entry.recordType === "source" ? reconcileSourceOutboxEntry : null;
        if (!reconcile) continue;
        try { await reconcile(env, entry); } catch (error) { console.error("[Tsumugi] auto repair: save of a requeued record failed; it stays in the Outbox", error); }
      }
    }))),
    isCancelled: options.isCancelled,
  };
}

export function runProductionVaultAutoRepair(options: ProductionAutoRepairOptions): Promise<AutoRepairOutcome> {
  return runVaultAutoRepair(createProductionAutoRepairEnv(options));
}
