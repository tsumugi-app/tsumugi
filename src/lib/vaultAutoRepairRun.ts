/**
 * 自動修復（vaultAutoRepair.ts）の本番の配線：実際のIndexedDB・保存先・ロック・既存の復旧・通常の保存処理を渡すだけ。
 * 規則と順序はvaultAutoRepair.tsにある。
 */
import { getConversation, getMemoryObject, getPendingVaultOutboxEntries, getSource, readBackupDeviceSnapshot, requeueRecordForVault, RecoveryPendingError } from "./db";
import { isReflectionSummary } from "./vault";
import { dayFileRoundTrips, runVaultAutoRepair, type AutoRepairEnv, type AutoRepairOutcome, type AutoRepairTargetInspection } from "./vaultAutoRepair";
import { createVaultBackup } from "./vaultBackup";
import { checkVaultConsistency } from "./vaultConsistencyCheck";
import type { ConsistencyCheckOptions, RepairTarget } from "./vaultConsistency";
import { runProductionBootstrapOnce } from "./productionBootstrap";
import type { MemoryObject } from "./types";
import { memoryDayFilePath } from "./vaultProjection";
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
  /** 通常の保存処理を1回流して終わるまで待つ。既定は起動時と同じ保存処理（Outboxの保存待ちを保存先へ反映する。world lockの共有モード） */
  settleSaves?(): Promise<void>;
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
    settleSaves: options.settleSaves ?? (async () => {
      // 起動時の保存処理がまだ動いていれば、それは保存待ちに戻す前に始まったもの：終わるのを待ち、まだ保存待ちが残っていればもう1回だけ流す（有限）
      await withVaultWorldRead(() => runProductionBootstrapOnce(root));
      if ((await getPendingVaultOutboxEntries()).length > 0) await withVaultWorldRead(() => runProductionBootstrapOnce(root));
    }),
    isCancelled: options.isCancelled,
  };
}

export function runProductionVaultAutoRepair(options: ProductionAutoRepairOptions): Promise<AutoRepairOutcome> {
  return runVaultAutoRepair(createProductionAutoRepairEnv(options));
}
