/**
 * Pure helpers for the Preview-only startup timing page (no browser APIs here, so they are unit tested).
 */
import { RECOVERY_ATTENTION_TEXT, RECOVERY_CHECKING_TEXT, RECOVERY_FAILED_TEXT, RECOVERY_REPAIRING_TEXT } from "./vaultRecoveryUserView";

export const LATEST_TEXT = "最新の状態です";
/** shown while the Recovery check is unfinished / failed / needs attention: "latest" must never be visible together with any of these */
export const NOT_LATEST_TEXTS = [RECOVERY_CHECKING_TEXT, RECOVERY_ATTENTION_TEXT, RECOVERY_REPAIRING_TEXT, RECOVERY_FAILED_TEXT];

export const runLabel = (runNumber: number): string => (runNumber <= 1 ? "初回起動" : `${runNumber}回目の起動`);

/** true when the screen text claims "latest" while it also shows an unfinished / abnormal Recovery state */
export function latestShownTooEarly(text: string): boolean {
  return text.includes(LATEST_TEXT) && NOT_LATEST_TEXTS.some((t) => text.includes(t));
}

export interface TimingRun {
  run: number;
  build: string;
  /** seconds from starting the app to "最新の状態です" being visible; null when it never appeared */
  latestSec: number | null;
  settingsOpenedSec: number | null;
  sawChecking: boolean;
  latestTooEarly: boolean;
  timedOut: boolean;
  mainThreadOps: { getFile: number; write: number; dirLookups: number; idbWriteTx: number; idbWrites: number } | null;
}

const fmt = (v: number | null) => (v === null ? "なし" : `${v.toFixed(1)}秒`);

export function renderTimingText(runs: TimingRun[], env: { userAgent: string; build: string }): string {
  const lines = [`Tsumugi 起動時間の計測 (build ${env.build})`, `UA: ${env.userAgent}`, ""];
  for (const r of runs) {
    lines.push(
      `${runLabel(r.run)}: 「${LATEST_TEXT}」まで ${fmt(r.latestSec)}${r.timedOut ? "（時間切れ）" : ""}` +
        ` / 設定を開けた ${fmt(r.settingsOpenedSec)}` +
        ` / 確認中の表示 ${r.sawChecking ? "あり" : "なし"}` +
        ` / 確認未完了での「最新」表示 ${r.latestTooEarly ? "あり（問題）" : "なし"}` +
        (r.mainThreadOps ? ` / 主スレッドのファイル読込${r.mainThreadOps.getFile}・書込${r.mainThreadOps.write}・探索${r.mainThreadOps.dirLookups}・IDB書込tx${r.mainThreadOps.idbWriteTx}` : "")
    );
  }
  return lines.join("\n");
}
