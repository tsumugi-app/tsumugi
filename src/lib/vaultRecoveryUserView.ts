/**
 * Recovery の通常ユーザー向け表示の導出（純粋関数）。ユーザーに見せる状態は次の3つだけ：
 *   正常        → 何も出さない（保存先の統合表示の「✓ 最新の状態です」だけ）
 *   異常検出    → 「保存先に確認が必要な記録があります」＋「修復する」
 *   修復成功後  → 正常に戻る（Recoveryの表示は消える）
 * 診断・修復前チェック・件数・cleanupなどの詳細は`?debugLog=1`の開発者向けUIにだけ残す。
 * 内部のplan・安全確認・repair自体は変更しない。PC / Android / iPhoneで意味を分けない。
 */
export const RECOVERY_ATTENTION_TEXT = "保存先に確認が必要な記録があります";
export const RECOVERY_REPAIR_BUTTON = "修復する";
export const RECOVERY_REPAIRING_TEXT = "修復しています…";
export const RECOVERY_INCOMPLETE_TEXT = "修復を完了できませんでした。記録は変更されていないか、元の状態が保持されています。";

/** `RecoveryUiStatus`（ChatScreen）の、この判定に必要な部分だけ。 */
export interface RecoveryStatusLike {
  kind: string;
  applyPlan?: { heldCount: number; recoverableCount: number };
  result?: { held: number; failed: number };
}
export type RecoveryUserView =
  /** まだ検出が済んでいない。「最新の状態です」と言ってはいけない。 */
  | { kind: "pending" }
  /** 検出済みで異常なし（または検出自体を行えなかった）。Recoveryの表示は無い。 */
  | { kind: "none" }
  | { kind: "attention"; incomplete: boolean }
  | { kind: "repairing" };

export function deriveRecoveryUserView(status: RecoveryStatusLike, options: { incomplete?: boolean; detectionFailed?: boolean } = {}): RecoveryUserView {
  switch (status.kind) {
    case "executing": return { kind: "repairing" };
    case "interrupted": return { kind: "attention", incomplete: !!options.incomplete };
    case "error": return { kind: "attention", incomplete: true };
    case "plan": {
      const plan = status.applyPlan;
      return plan && (plan.heldCount > 0 || plan.recoverableCount > 0) ? { kind: "attention", incomplete: !!options.incomplete } : { kind: "none" };
    }
    case "done": {
      const result = status.result;
      return result && (result.held > 0 || result.failed > 0) ? { kind: "attention", incomplete: !!options.incomplete } : { kind: "none" };
    }
    case "clean": return { kind: "none" };
    default: return options.detectionFailed ? { kind: "none" } : { kind: "pending" };
  }
}

/** 「✓ 最新の状態です」を出してよいか（Recoveryの異常・未検出・修復中の間は出さない）。 */
export const recoveryAllowsLatest = (view: RecoveryUserView): boolean => view.kind === "none";
