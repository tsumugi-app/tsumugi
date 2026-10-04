/**
 * Recoveryの背景検査（READ ONLY）：アプリのビルド × 保存先の世界（Vault identity、無ければorigin固有のworld key）ごとに、未検査の場合だけ1回、Recovery planを作る。
 * Settingsを開くことや毎回の起動とは結びつけない。検査済みの記録（`{build, clean}`）だけを保存し、同じビルド・同じVaultでは
 * 全scanを繰り返さない（異常だった場合も、その事実を覚えておき、再起動のたびに再scanしない）。
 * 検査できなかった場合（plan作成失敗）は何も保存せず、「最新」とも「異常」とも断定しない。
 * Recoveryの判定・修復ロジックは一切変更しない（planの作成は呼び出し元が渡す既存の`planRecoveryApplyExcludingArchived`）。
 */
import { getRecoveryCheckMarker, getRecoveryCheckWorldKey, setRecoveryCheckMarker, type RecoveryCheckMarker } from "./db";

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
export interface RecoveryBackgroundDeps<P extends RecoveryPlanLike> {
  build: string;
  /** identityに依存しない検査の鍵（identityがあればvaultId、無ければorigin固有のworld key）。 */
  worldKey(): Promise<string>;
  readMarker(worldKey: string): Promise<RecoveryCheckMarker | undefined>;
  writeMarker(worldKey: string, marker: RecoveryCheckMarker): Promise<void>;
  /** 既存のRecovery plan作成（READ ONLY・全scan）。 */
  plan(): Promise<P>;
}
export type RecoveryBackgroundResult<P extends RecoveryPlanLike> =
  | { kind: "skipped"; clean: boolean }
  | { kind: "scanned"; clean: true }
  | { kind: "scanned"; clean: false; plan: P }
  | { kind: "failed" };

/**
 * 「正常」と言ってよいのは、走査が完了し、読取問題が無く、保留も復旧対象も無いときだけ。
 * 一つでも欠ければ正常ではない（隠さず、異常として扱う）。
 */
export const isRecoveryClean = (plan: RecoveryPlanLike): boolean =>
  plan.plan.scanCompleted && plan.plan.issues.length === 0 && plan.heldCount === 0 && plan.ops.length === 0;
export const hasRecoveryAnomaly = (plan: RecoveryPlanLike): boolean => !isRecoveryClean(plan);

export async function runBackgroundRecoveryCheck<P extends RecoveryPlanLike>(deps: RecoveryBackgroundDeps<P>): Promise<RecoveryBackgroundResult<P>> {
  try {
    const worldKey = await deps.worldKey();
    const marker = await deps.readMarker(worldKey);
    if (marker && marker.build === deps.build) return { kind: "skipped", clean: marker.clean };
    const plan = await deps.plan();
    const clean = !hasRecoveryAnomaly(plan);
    await deps.writeMarker(worldKey, { build: deps.build, clean });
    return clean ? { kind: "scanned", clean: true } : { kind: "scanned", clean: false, plan };
  } catch {
    return { kind: "failed" };
  }
}

/** 本番の依存（IndexedDBの設定領域・Vault identity）。 */
export const productionRecoveryBackgroundDeps = <P extends RecoveryPlanLike>(plan: () => Promise<P>, build: string = APP_BUILD_ID): RecoveryBackgroundDeps<P> => ({
  build,
  worldKey: getRecoveryCheckWorldKey,
  readMarker: getRecoveryCheckMarker,
  writeMarker: setRecoveryCheckMarker,
  plan,
});

/** 修復後などに、再検査の結果（正常か）を記録する。 */
export async function recordRecoveryCheck(clean: boolean, build: string = APP_BUILD_ID): Promise<void> {
  await setRecoveryCheckMarker(await getRecoveryCheckWorldKey(), { build, clean });
}

/** 背景検査の結果から、UIのRecovery状態へ。検査できなかった場合はnull（何も断定しない）。 */
export type RecoveryStatusFromCheck<P> = { kind: "clean" } | { kind: "known-issue" } | { kind: "plan"; applyPlan: P };
export function recoveryStatusFromCheck<P extends RecoveryPlanLike>(result: RecoveryBackgroundResult<P>): RecoveryStatusFromCheck<P> | null {
  if (result.kind === "failed") return null;
  if (result.kind === "skipped") return result.clean ? { kind: "clean" } : { kind: "known-issue" };
  return result.clean ? { kind: "clean" } : { kind: "plan", applyPlan: result.plan };
}
