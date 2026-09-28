/**
 * Vault Recovery Apply（Phase 2）のSettings表示文言。純粋関数として`SettingsPanel.tsx`から切り出し、
 * DOM/Reactに依存せずユニットテストできるようにする（M2対応：内部classification・journalの中身は
 * 一切含めない。件数と、区別すべき状態だけを文字列にする）。
 *
 * Codexレビュー指摘M2：
 * - 正常Vault（診断前・保留0件）でも固定文言「確認が必要な記録があります」を出し続けていた。
 * - recovered===0の結果を「0件を復旧しました。」という、成功したかのような文言に潰していた。
 * この2つを、実際の状態に応じて区別する。
 */

export interface RecoveryHeadingPlan {
  kind: "plan";
  heldCount: number;
}
export type RecoveryHeadingStatus = RecoveryHeadingPlan | { kind: Exclude<string, "plan"> };

/** 上部見出し。保留があると実際に分かった場合だけ「確認が必要な記録があります」を出す。 */
export function recoveryHeadingText(status: RecoveryHeadingStatus): string {
  if (status.kind === "plan" && (status as RecoveryHeadingPlan).heldCount > 0) {
    return `確認が必要な記録が${(status as RecoveryHeadingPlan).heldCount}件あります`;
  }
  return "この端末に残っている古い記録の確認";
}

export interface RecoveryDoneResult {
  status: string;
  recovered: number;
  held: number;
  failed: number;
}

export interface RecoveryDoneMessage {
  /** 常に1つ表示する、結果の要約。recovered===0を「成功」文言へ潰さない。 */
  primary: string;
  /** 保留件数の注記。無ければnull（表示しない）。 */
  heldNote: string | null;
  /** 未確認件数の注記。無ければnull（表示しない）。 */
  failedNote: string | null;
}

/** 「復旧する」実行結果（kind==="done"）の表示文言。 */
export function recoveryDoneMessage(result: RecoveryDoneResult): RecoveryDoneMessage {
  const primary =
    result.status === "nothing-to-do"
      ? "復旧する記録はありませんでした。"
      : result.recovered > 0
        ? `${result.recovered}件を復旧しました。`
        : "今回は復旧できませんでした。";
  return {
    primary,
    heldNote: result.held > 0 ? `${result.held}件はデータを変更せず保留しています。` : null,
    failedNote:
      result.failed > 0
        ? "1件以上、確認できなかったため復旧済みとして扱っていません。もう一度「確認する」から実行すると、続きから安全に完了できます。"
        : null,
  };
}

/**
 * この結果表示が「成功したように見える」表示かどうか（テスト・監査用の補助）。
 * error／unavailable／confirmation-expired／journal-unavailableは、そもそも`recoveryDoneMessage`を
 * 通らない別のUI状態（`kind==="error"`）で表示されるため、ここではrecovered>0の場合だけがtrueになる。
 */
export function recoveryDoneLooksLikeSuccess(result: RecoveryDoneResult): boolean {
  return result.recovered > 0;
}
