/**
 * 保存先の整合性の背景確認（READ ONLY）：アプリのビルド × 保存先の世界（Vault identity、無ければorigin固有のworld key）ごとに確認する。
 * Settingsを開くことや毎回の起動とは結びつけない。保存するのは確定した走査の結果（`{build, clean}`）だけ：
 *   - 同じビルド・同じVaultで「正常」と確定していれば、再起動しても全走査を繰り返さない。
 *   - 「異常」が記録されていても、次の起動で必ず確認し直す（以前の異常判定を、そのビルドの間ずっと出し続けない）。
 *   - 保存処理と重なった走査（unsettled）・保存待ちだけの走査（saving）は記録しない（途中の状態を確定した異常にしない）。
 * 確認できなかった場合（plan作成失敗）は何も保存せず、「最新」とも「異常」とも断定しない。
 * 判定は`vaultConsistency.ts`（rawなRecovery plan＋保存の進行状況）。修復ロジックは一切呼ばない。
 */
import { getRecoveryCheckMarker, getRecoveryCheckWorldKey, setRecoveryCheckMarker, type RecoveryCheckMarker } from "./db";
import type { ConsistencyReport } from "./vaultConsistency";

/** アプリのビルド識別子（Vercelのcommit SHAを`next.config.ts`で埋め込む。無ければ"dev"）。 */
export const APP_BUILD_ID: string = process.env.NEXT_PUBLIC_APP_BUILD ?? "dev";

/**
 * 判定に使うplanの形。必ずrawなplan（`planRecoveryApply`。archiveで除外したplanは使わない）を渡す。
 * archiveは修復前の安全な退避であり、「解決済み」ではない。
 */
export interface RecoveryPlanLike {
  heldCount: number;
  recoverableCount: number;
  ops: readonly unknown[];
  plan: { scanCompleted: boolean; issues: readonly unknown[] };
}
export interface RecoveryBackgroundDeps<P> {
  build: string;
  /** identityに依存しない確認の鍵（identityがあればvaultId、無ければorigin固有のworld key）。 */
  worldKey(): Promise<string>;
  readMarker(worldKey: string): Promise<RecoveryCheckMarker | undefined>;
  writeMarker(worldKey: string, marker: RecoveryCheckMarker): Promise<void>;
  /** 整合性確認（READ ONLY・全走査。`runConsistencyCheck`）。 */
  check(): Promise<{ report: ConsistencyReport; plan: P }>;
}
export type RecoveryBackgroundResult<P> =
  /** このビルド・このVaultでは正常と確定済み（走査しない） */
  | { kind: "skipped" }
  | { kind: "checked"; report: ConsistencyReport; plan: P }
  | { kind: "failed" };

/**
 * 「正常」と言ってよいのは、走査が完了し、読取問題が無く、保留も復旧対象も無いときだけ。
 * 一つでも欠ければ正常ではない（隠さず、異常として扱う）。
 */
export const isRecoveryClean = (plan: RecoveryPlanLike): boolean =>
  plan.plan.scanCompleted && plan.plan.issues.length === 0 && plan.heldCount === 0 && plan.ops.length === 0;
export const hasRecoveryAnomaly = (plan: RecoveryPlanLike): boolean => !isRecoveryClean(plan);

/** 確定した結果だけを記録する：正常（clean）か、保存待ち以外の不整合（attention）。 */
export const reportIsRecordable = (report: ConsistencyReport): boolean => report.state === "clean" || report.state === "attention";

export async function runBackgroundRecoveryCheck<P>(deps: RecoveryBackgroundDeps<P>): Promise<RecoveryBackgroundResult<P>> {
  try {
    const worldKey = await deps.worldKey();
    const marker = await deps.readMarker(worldKey);
    if (marker && marker.build === deps.build && marker.clean) return { kind: "skipped" };
    const { report, plan } = await deps.check();
    if (reportIsRecordable(report)) await deps.writeMarker(worldKey, { build: deps.build, clean: report.state === "clean" });
    return { kind: "checked", report, plan };
  } catch {
    return { kind: "failed" };
  }
}

/** 本番の依存（IndexedDBの設定領域・Vault identity）。 */
export const productionRecoveryBackgroundDeps = <P>(check: () => Promise<{ report: ConsistencyReport; plan: P }>, build: string = APP_BUILD_ID): RecoveryBackgroundDeps<P> => ({
  build,
  worldKey: getRecoveryCheckWorldKey,
  readMarker: getRecoveryCheckMarker,
  writeMarker: setRecoveryCheckMarker,
  check,
});

/** 修復後などに、確定した確認の結果を記録する（保存待ち・未確定の結果は記録しない）。 */
export async function recordRecoveryCheck(report: ConsistencyReport, build: string = APP_BUILD_ID): Promise<void> {
  if (!reportIsRecordable(report)) return;
  await setRecoveryCheckMarker(await getRecoveryCheckWorldKey(), { build, clean: report.state === "clean" });
}
