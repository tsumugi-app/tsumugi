/**
 * Recovery分類のdebug診断（READ ONLY）。`?debugLog=1`の画面から明示的に押されたときだけ呼ばれる。
 * Vault・IndexedDB・ledger・journalのいずれにも書かない。identityも作らない（identityの確立は起動時の
 * production codeの仕事で、この診断は「今ここで確立するとどうなるか」を計算して表示するだけ）。
 * 出力は件数・種別・状態名だけ。本文もIDも含まない。
 */
import { planRecoveryApply, createRecoveryApplyEnv } from "./vaultRecoveryApply";
import { classifyRawHeld, readVaultTextFrom, type ClassifierSummary } from "./recoveryClassifier";
import { previewVaultIdentityAdoption, type VaultIdentityPreview } from "./vaultIdentityAdoption";

export type ClassifierDiagnosticResult =
  | { status: "unavailable" }
  | { status: "complete"; summary: ClassifierSummary; identity: VaultIdentityPreview | null; scanCompleted: boolean };

export async function runClassifierDiagnostic(root: FileSystemDirectoryHandle): Promise<ClassifierDiagnosticResult> {
  try {
    const raw = await planRecoveryApply(createRecoveryApplyEnv(root));
    const report = await classifyRawHeld(raw, readVaultTextFrom(root));
    let identity: VaultIdentityPreview | null = null;
    try { identity = await previewVaultIdentityAdoption({ root }); } catch { identity = null; }
    return { status: "complete", summary: report.summary, identity, scanCompleted: raw.plan.scanCompleted };
  } catch { return { status: "unavailable" }; }
}
