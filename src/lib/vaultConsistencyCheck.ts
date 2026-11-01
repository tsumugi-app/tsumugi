/**
 * 整合性確認の本番の配線（`vaultConsistency.ts`の`runConsistencyCheck`に、実際のIndexedDBと保存先を渡すだけ）。READ ONLY。
 * 走査（rawなRecovery plan）は従来どおりworld lockの共有モードの中だけで行い、保存ロックは取らない（保存を止めない。
 * 保存処理との重なりは、走査の前後の保存の進行状況で検出する。理由はvaultConsistency.tsの冒頭）。
 */
import { readVaultSaveProgress } from "./db";
import { createRecoveryApplyEnv, planRecoveryApply, type RecoveryApplyPlan } from "./vaultRecoveryApply";
import { runConsistencyCheck, type ConsistencyCheckOptions, type ConsistencyReport } from "./vaultConsistency";
import { withVaultWorldRead } from "./vaultWorldLock";

export function checkVaultConsistency(
  root: FileSystemDirectoryHandle,
  isCancelled: () => boolean,
  options?: ConsistencyCheckOptions
): Promise<{ report: ConsistencyReport; plan: RecoveryApplyPlan }> {
  return runConsistencyCheck(
    {
      readProgress: readVaultSaveProgress,
      plan: () => withVaultWorldRead(() => planRecoveryApply(createRecoveryApplyEnv(root))),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      isCancelled,
    },
    options
  );
}
