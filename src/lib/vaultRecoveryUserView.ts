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
export const RECOVERY_REPAIRING_TEXT = "保存先を修復しています…";
export const RECOVERY_INCOMPLETE_TEXT = "一部の記録を安全に修復できませんでした。データは保持されています。";
export const RECOVERY_CHECKING_TEXT = "保存先を確認しています…";
export const RECOVERY_FAILED_TEXT = "保存先の状態を確認できませんでした。しばらくしてからもう一度お試しください。";

/** `RecoveryUiStatus`（ChatScreen）の、この判定に必要な部分だけ。 */
export interface RecoveryStatusLike {
  kind: string;
  applyPlan?: { heldCount: number; recoverableCount: number };
  result?: { held: number; failed: number };
}
export type RecoveryUserView =
  /** まだ検出を始めていない（unknown）。「最新の状態です」と言ってはいけない。 */
  | { kind: "pending" }
  /** 検査中（checking）。既知の異常があれば隠さず、attentionのまま。 */
  | { kind: "checking" }
  /** 検出済みで異常なし。Recoveryの表示は無い。 */
  | { kind: "none" }
  /** 検査できず健全性を判定できなかった（failed）。空白のままにせず理由を示し、「最新」とは断定しない。 */
  | { kind: "unknown" }
  | { kind: "attention"; incomplete: boolean }
  | { kind: "repairing" };

export function deriveRecoveryUserView(status: RecoveryStatusLike, options: { incomplete?: boolean; detectionFailed?: boolean; checking?: boolean } = {}): RecoveryUserView {
  switch (status.kind) {
    case "executing": return { kind: "repairing" };
    case "interrupted":
    case "known-issue": return { kind: "attention", incomplete: !!options.incomplete };
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
    default: return options.detectionFailed ? { kind: "unknown" } : options.checking ? { kind: "checking" } : { kind: "pending" };
  }
}

/** 「✓ 最新の状態です」を出してよいか（Recoveryの異常・未検出・修復中の間は出さない）。 */
export const recoveryAllowsLatest = (view: RecoveryUserView): boolean => view.kind === "none";
