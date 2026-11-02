/**
 * 競合の解決（vaultConflictResolution.ts）の本番の配線：自動修復と同じバックアップ・ロック・確認・通常の保存を渡すだけ。
 */
import { createProductionAutoRepairEnv, type ProductionAutoRepairOptions } from "./vaultAutoRepairRun";
import type { ConflictResolveEnv } from "./vaultConflictResolution";

/** 保存先ごとの、最後に作った照合済みバックアップ（対象が変わっていなければ次の解決にも使う。使う前に必ず読み直して照合する） */
const lastBackup = new WeakMap<FileSystemDirectoryHandle, { runId: string; size: number; sha256: string }>();

export function createProductionConflictEnv(options: ProductionAutoRepairOptions & { activeConversationId?: string | null }): ConflictResolveEnv {
  const { check, createBackup, withExclusive, readVaultFile, settleSaves, isCancelled } = createProductionAutoRepairEnv(options);
  return {
    root: options.root, now: () => new Date().toISOString(), activeConversationId: options.activeConversationId,
    check, createBackup, withExclusive, readVaultFile, settleSaves, isCancelled,
    reusableBackup: { get: () => lastBackup.get(options.root) ?? null, set: (backup) => { lastBackup.set(options.root, backup); } },
  };
}
