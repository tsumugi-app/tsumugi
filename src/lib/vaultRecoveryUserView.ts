/**
 * 保存先の整合性の通常ユーザー向け表示の導出（純粋関数）。ユーザーに見せる状態：
 *   正常        → 何も出さない（保存先の統合表示の「✓ 最新の状態です」だけ）
 *   保存待ち    → 「保存待ちの記録がn件あります」（成功とは扱わない。「最新」も出さない）
 *   未確定      → 保存中で確認を完了できなかった（異常とは断定しない。もう一度確認できる）
 *   要確認      → 「保存先に確認が必要な記録があります」＋種類・件数・理由。今のバージョンで直せる記録があるときだけ「修復する」
 *   修復の途中  → 前回の修復の続きを完了する
 * 件数・種類・理由だけを出す（本文・IDは出さない）。PC / Android / iPhoneで意味を分けない。
 */
import type { ConsistencyCategory, ConsistencyGroup, ConsistencyReason, ConsistencyRecordType, ConsistencyReport } from "./vaultConsistency";

export const RECOVERY_ATTENTION_TEXT = "保存先に確認が必要な記録があります";
export const RECOVERY_REPAIR_BUTTON = "修復する";
export const RECOVERY_RECHECK_BUTTON = "もう一度確認する";
export const RECOVERY_RESUME_BUTTON = "続きを完了する";
export const RECOVERY_REPAIRING_TEXT = "保存先を修復しています…";
export const RECOVERY_CHECKING_TEXT = "保存先を確認しています…";
export const RECOVERY_FAILED_TEXT = "保存先の状態を確認できませんでした。しばらくしてからもう一度お試しください。";
export const RECOVERY_UNSETTLED_TEXT = "保存中のため、確認を完了できませんでした。少し後にもう一度確認します。";
export const RECOVERY_INTERRUPTED_TEXT = "前回の修復が途中で止まっています。データは保持されています。";
export const RECOVERY_DATA_KEPT_TEXT = "どの記録も削除・上書きしていません。";
export const recoverySavingText = (count: number) => `保存待ちの記録が${count}件あります。自動で保存されます。`;

export const CATEGORY_TEXT: Record<ConsistencyCategory, { title: string; note: string }> = {
  saving: { title: "保存待ち", note: "自動で保存されます。" },
  repairable: { title: "自動で直せる記録", note: "保存先へ書き出す、または保存先の管理情報を更新します。記録の内容は変えません。" },
  repairLater: { title: "自動修復の対応待ち", note: "今のバージョンでは自動で直せません。データは変更せず保持しています。" },
  needsChoice: { title: "どちらを残すかの確認が必要", note: "どちらが正しいかを自動では決めません。両方の版を変更せず保持しています（選ぶ機能は今後のバージョンで追加します）。" },
  retryable: { title: "時間をおくと解決する可能性がある記録", note: "「もう一度確認する」で確認し直せます。" },
  unknown: { title: "原因を特定できない記録", note: "データは変更せず保持しています。" },
};

export const REASON_TEXT: Record<ConsistencyReason, string> = {
  "save-pending": "保存先への保存を待っています",
  "save-retrying": "保存先への保存に失敗し、自動で再試行しています",
  "read-error": "保存先のファイルを一時的に読めませんでした",
  "read-during-save": "保存中だったため、ファイルの内容を確認できませんでした",
  "record-changed": "確認している間に記録が変わりました",
  "local-only": "保存先にまだ書き出されていません",
  metadata: "保存先の管理情報が古くなっています",
  "day-file-merge": "同じ日のファイルへの追加が必要です",
  "registry-mismatch": "保存先の管理情報と実際のファイルが一致しません",
  "save-held": "保存先への書き込みが保留されています",
  "different-content": "端末と保存先で内容が異なります",
  "multiple-copies": "保存先に同じ記録が複数あります",
  "unreadable-file": "保存先のファイルの形式を読み取れません",
  "trace-without-file": "管理情報だけが残り、本体のファイルが見つかりません",
  "invalid-local": "端末側の記録を読み取れません",
  other: "原因を特定できません",
};

export const RECORD_TYPE_TEXT: Record<ConsistencyRecordType, string> = {
  conversation: "会話", memory: "記録", reflection: "振り返り", source: "資料", file: "ファイル",
};

export const consistencyGroupText = (g: ConsistencyGroup) => `${RECORD_TYPE_TEXT[g.recordType]} ${g.count}件：${REASON_TEXT[g.reason]}`;

/** `RecoveryUiStatus`（ChatScreen）の、この判定に必要な部分だけ。 */
export interface RecoveryStatusLike {
  kind: string;
  message?: string;
}
export interface RecoveryAttentionSection {
  category: ConsistencyCategory;
  title: string;
  note: string;
  lines: string[];
  count: number;
}
export type RecoveryUserView =
  /** まだ確認を始めていない。「最新の状態です」と言ってはいけない。 */
  | { kind: "pending" }
  /** 確認中で、まだ結果が無い。 */
  | { kind: "checking" }
  /** 確定した確認で問題なし。表示は無い。 */
  | { kind: "none" }
  /** 確認できず判定できなかった。空白のままにせず理由を示し、「最新」とは断定しない。 */
  | { kind: "unknown" }
  | { kind: "saving"; count: number; checking: boolean }
  | { kind: "unsettled"; checking: boolean }
  | { kind: "attention"; sections: RecoveryAttentionSection[]; canRepair: boolean; checking: boolean; message: string | null }
  | { kind: "interrupted" }
  | { kind: "repairing" };

/** 確認結果（report）から、要確認の表示（種類ごとの見出し・説明・件数×理由の行）を作る。保存待ちも隠さず最後に数える。 */
export function attentionSections(report: ConsistencyReport): RecoveryAttentionSection[] {
  const order: ConsistencyCategory[] = ["repairable", "needsChoice", "repairLater", "retryable", "unknown", "saving"];
  return order
    .map((category) => {
      const groups = report.groups.filter((g) => g.category === category);
      return { category, ...CATEGORY_TEXT[category], lines: groups.map(consistencyGroupText), count: groups.reduce((n, g) => n + g.count, 0) };
    })
    .filter((s) => s.count > 0);
}

export function deriveRecoveryUserView(
  status: RecoveryStatusLike,
  report: ConsistencyReport | null,
  options: { detectionFailed?: boolean; checking?: boolean } = {}
): RecoveryUserView {
  const checking = !!options.checking;
  if (status.kind === "executing") return { kind: "repairing" };
  if (status.kind === "interrupted") return { kind: "interrupted" };
  const message = status.kind === "error" ? status.message ?? null : null;
  if (report) {
    if (message) return { kind: "attention", sections: attentionSections(report), canRepair: false, checking, message };
    if (report.state === "clean") return { kind: "none" };
    if (report.state === "saving") return { kind: "saving", count: report.counts.saving, checking };
    if (report.state === "unsettled") return { kind: "unsettled", checking };
    return { kind: "attention", sections: attentionSections(report), canRepair: report.repairableIds.length > 0, checking, message: null };
  }
  if (message) return { kind: "attention", sections: [], canRepair: false, checking, message };
  if (status.kind === "clean") return { kind: "none" };
  return options.detectionFailed ? { kind: "unknown" } : checking ? { kind: "checking" } : { kind: "pending" };
}

/** 「✓ 最新の状態です」を出してよいか（保存待ち・未確定・要確認・未確認・修復中の間は出さない）。 */
export const recoveryAllowsLatest = (view: RecoveryUserView): boolean => view.kind === "none";
