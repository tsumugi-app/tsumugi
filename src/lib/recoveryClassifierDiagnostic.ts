/**
 * Recovery診断（debug・READ ONLY）。`?debugLog=1`の画面から明示的に押されたときだけ呼ばれる。
 * Vault・IndexedDB・ledger・journalのいずれにも書かない。identityも作らない（identityの確立は起動時のproduction
 * codeの仕事で、この診断は「今ここで確立するとどうなるか」を計算して表示するだけ）。
 * 出力は件数・種別・状態名だけ。本文もIDも含まない。
 *
 * 世界の排他：`withVaultWorldRead`（navigator.locksの共有ロック。メモリ上のロックで、persistentな書き込みは無い）と
 * `withVaultSaveLock`（Vault書き込み・bootstrapが使うロック。同じくメモリ上）の中で読む。lockの順序は
 * production startup（world→save）と同じ。これにより、読み取り中にbootstrap／flushのVault書き込みが割り込まない。
 * canonical（IndexedDB）へのユーザー操作の書き込みはこのロックの対象外のため、診断前に他タブを閉じる運用とする。
 */
import { planRecoveryApply, createRecoveryApplyEnv } from "./vaultRecoveryApply";
import { classifyRawHeld, readVaultTextFrom, type ClassifierReport } from "./recoveryClassifier";
import { previewVaultIdentityAdoption, type VaultIdentityPreview } from "./vaultIdentityAdoption";
import { withVaultWorldRead } from "./vaultWorldLock";
import { withVaultSaveLock } from "./vaultSaveLock";

export type ClassifierDiagnosticResult =
  | { status: "unavailable"; reason: string }
  | {
      status: "complete";
      report: Omit<ClassifierReport, "records">;
      identity: VaultIdentityPreview | null;
      safety: { diagnosticWrites: 0; locksSupported: boolean; concurrentVaultWriteRisk: boolean; concurrentCanonicalWriteRisk: true };
    };

const locksSupported = () => typeof navigator !== "undefined" && !!navigator.locks?.request;

export async function runClassifierDiagnostic(root: FileSystemDirectoryHandle): Promise<ClassifierDiagnosticResult> {
  try {
    return await withVaultWorldRead(() => withVaultSaveLock(async (): Promise<ClassifierDiagnosticResult> => {
      const raw = await planRecoveryApply(createRecoveryApplyEnv(root));
      const { records, ...report } = await classifyRawHeld(raw, readVaultTextFrom(root));
      void records;
      let identity: VaultIdentityPreview | null = null;
      try { identity = await previewVaultIdentityAdoption({ root }); } catch { identity = null; }
      return { status: "complete", report, identity,
        safety: { diagnosticWrites: 0, locksSupported: locksSupported(), concurrentVaultWriteRisk: !locksSupported(), concurrentCanonicalWriteRisk: true } };
    }));
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error && error.name ? error.name : "unexpected-error" };
  }
}

/** 画面に出す整形（件数のみ）。テストからも使う。 */
export function formatClassifierDiagnostic(r: Extract<ClassifierDiagnosticResult, { status: "complete" }>): string {
  const { plan, summary: s, oneSided: o } = r.report, L = s.levels;
  const t = (b: { total: number; conversation: number; memory: number; reflection: number; source: number }) =>
    `${b.total} (conversation ${b.conversation} / memory ${b.memory} / reflection ${b.reflection} / source ${b.source})`;
  const id = r.identity;
  return [
    "PLAN (raw plan, archive exclusion not applied)",
    `  scanCompleted: ${plan.scanCompleted}`, `  issues: ${plan.issues}`,
    `  recoverableOps: ${plan.recoverableOps} (members ${plan.recoverableMembers})`, `  held: ${plan.held}`, `  vaultOnly: ${plan.vaultOnly}`,
    "HELD CLASSIFICATION (held records only)",
    `  L0 derived: ${L.L0}`, `  L1 representation: ${L.L1}`, `  L2 one-sided/containment: ${L.L2}`, `  L3 lossless merge: ${L.L3}`,
    `  L4 conflict: ${L.L4.total} (Conversation ${L.L4.conversation} / Memory ${L.L4.memory} / Reflection ${L.L4.reflection} / Source ${L.L4.source})`,
    `  L5: ${L.L5.total} (unreadable ${L.L5.unreadable} / malformed ${L.L5.malformed} / scanIncomplete ${L.L5.scanIncomplete} / other ${L.L5.other})`,
    `  AUTO ${s.repair.AUTO} / HOLD ${s.repair.HOLD}; future conflict-copy candidates (HOLD now): ${s.futureConflictCopyCandidates}`,
    `  classification total ${s.classificationTotal} vs raw heldCount ${plan.held}: classificationMismatch: ${s.classificationMismatch}`,
    `  by reason: ${Object.entries(s.byReason).map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`,
    "ONE-SIDED",
    `  vaultOnly: ${t(o.vaultOnly)}`, `  canonicalOnlyRecoverable: ${t(o.canonicalOnlyRecoverable)}`, `  otherRecoverable: ${o.otherRecoverable}`,
    "IDENTITY",
    ...(id ? [
      `  storageCapability: ${id.storageCapability}`,
      `  vaultIdentity: IndexedDB ${id.indexedDbIdentity} / Vault file ${id.vaultIdentityFile}`,
      `  commonRecordIds: ${id.commonRecordIds ?? "n/a"}${id.divergentRecords != null ? ` (divergent ${id.divergentRecords})` : ""}`,
      `  currentAdoptionResult: ${id.adoption}`, `  phase1PreviewResult: ${id.phase1Preview}`,
    ] : ["  unavailable"]),
    "SAFETY",
    `  diagnosticWrites: ${r.safety.diagnosticWrites}`,
    `  concurrentVaultWriteRisk: ${r.safety.concurrentVaultWriteRisk}`, `  concurrentCanonicalWriteRisk: ${r.safety.concurrentCanonicalWriteRisk} (close other tabs before running)`,
  ].join("\n");
}
