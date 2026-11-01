/**
 * Recovery通常ユーザー向け表示の回帰テスト（純粋関数＋表示条件のsource-inspection。DOM/Reactのtest harnessは無い）。
 * 表示の元になる確認結果（ConsistencyReport）の分類そのものは`vaultConsistency.test.ts`。
 * 実行方法：`npm run test:recovery-ui-text`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deriveRecoveryUserView, recoveryAllowsLatest, RECOVERY_ATTENTION_TEXT, RECOVERY_REPAIR_BUTTON } from "./vaultRecoveryUserView";
import type { ConsistencyCategory, ConsistencyReport, ConsistencyState } from "./vaultConsistency";

const report = (state: ConsistencyState, counts: Partial<Record<ConsistencyCategory, number>> = {}, repairableIds: string[] = []): ConsistencyReport => {
  const all = { saving: 0, repairable: 0, repairLater: 0, needsChoice: 0, retryable: 0, unknown: 0, ...counts };
  return {
    state, settled: state !== "unsettled", findings: [], counts: all, repairableIds,
    repairTargets: repairableIds.map((recordId) => ({ action: "apply" as const, reason: "local-only" as const, recordType: "memory" as const, recordId })),
    groups: (Object.entries(all) as [ConsistencyCategory, number][]).filter(([, n]) => n > 0).map(([category, count]) => ({ category, reason: "other", recordType: "memory", count })),
  };
};
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const userBlock = () => {
  const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  return strip(settings.slice(settings.indexOf("Recovery（通常ユーザー向け）"), settings.indexOf('{showAdvancedVaultTools && vaultStatus === "connected" && vaultHandle && (')));
};

test("A: 正常（確定した確認で問題なし）→ Recovery表示なし、「最新」を出してよい", () => {
  for (const [status, r] of [[{ kind: "clean" }, null], [{ kind: "plan" }, report("clean")], [{ kind: "done" }, report("clean")]] as const) {
    const view = deriveRecoveryUserView(status, r); assert.deepEqual(view, { kind: "none" }); assert.equal(recoveryAllowsLatest(view), true);
  }
});
test("未確認・確認中は「最新」と断定しない（確認できなかった場合は、何も断定せず理由を示す）", () => {
  for (const kind of ["idle", "scanning"]) { const view = deriveRecoveryUserView({ kind }, null); assert.equal(view.kind, "pending"); assert.equal(recoveryAllowsLatest(view), false); }
  const failed = deriveRecoveryUserView({ kind: "idle" }, null, { detectionFailed: true });
  assert.deepEqual(failed, { kind: "unknown" }); assert.equal(recoveryAllowsLatest(failed), false);
});
test("B: 確認が必要な記録あり／修復の途中 → 異常表示。「最新」は出さない。修復ボタンは直せる記録があるときだけ", () => {
  const needsChoice = deriveRecoveryUserView({ kind: "plan" }, report("attention", { needsChoice: 2 }));
  assert.ok(needsChoice.kind === "attention" && !needsChoice.canRepair); assert.equal(recoveryAllowsLatest(needsChoice), false);
  const repairable = deriveRecoveryUserView({ kind: "plan" }, report("attention", { repairable: 3 }, ["a", "b", "c"]));
  assert.ok(repairable.kind === "attention" && repairable.canRepair);
  assert.equal(deriveRecoveryUserView({ kind: "interrupted" }, null).kind, "interrupted");
  assert.equal(RECOVERY_ATTENTION_TEXT, "保存先に確認が必要な記録があります"); assert.equal(RECOVERY_REPAIR_BUTTON, "修復する");
});
test("保存待ち・未確定は異常とも成功とも言わない", () => {
  const saving = deriveRecoveryUserView({ kind: "plan" }, report("saving", { saving: 4 }));
  assert.deepEqual(saving, { kind: "saving", count: 4, checking: false }); assert.equal(recoveryAllowsLatest(saving), false);
  const unsettled = deriveRecoveryUserView({ kind: "plan" }, report("unsettled", { needsChoice: 1 }));
  assert.equal(unsettled.kind, "unsettled"); assert.equal(recoveryAllowsLatest(unsettled), false);
});
test("修復中は修復中表示。「最新」は出さない", () => {
  const view = deriveRecoveryUserView({ kind: "executing" }, report("attention", { repairable: 1 }, ["a"])); assert.equal(view.kind, "repairing"); assert.equal(recoveryAllowsLatest(view), false);
});
test("C: 修復成功後（確認し直して問題なし）→ Recovery表示が消え、最新に戻る", () => {
  assert.equal(deriveRecoveryUserView({ kind: "plan" }, report("attention", { repairable: 1 }, ["a"])).kind, "attention");
  assert.deepEqual(deriveRecoveryUserView({ kind: "clean" }, report("clean")), { kind: "none" });
});
test("D: 修復失敗 → 最新と誤表示せず、理由を出し、結果を隠さない", () => {
  const view = deriveRecoveryUserView({ kind: "error", message: "復旧を開始できませんでした。" }, report("attention", { repairable: 1 }, ["a"]));
  assert.ok(view.kind === "attention" && view.message === "復旧を開始できませんでした。" && !view.canRepair && view.sections.length === 1);
  assert.equal(recoveryAllowsLatest(view), false);
  const noReport = deriveRecoveryUserView({ kind: "error", message: "x" }, null);
  assert.ok(noReport.kind === "attention" && noReport.message === "x");
});
test("E: 開発者向け診断は debugLog=1（showAdvancedVaultTools）の中だけにあり、通常UIには出ない", () => {
  const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  const devStart = settings.indexOf('{showAdvancedVaultTools && vaultStatus === "connected" && vaultHandle && (');
  assert.ok(devStart > 0, "the old Recovery block is behind showAdvancedVaultTools");
  const userStart = settings.indexOf("Recovery（通常ユーザー向け）");
  assert.ok(userStart > 0 && userStart < devStart, "the user-facing block sits before the developer block");
  const user = userBlock(), dev = settings.slice(devStart);
  for (const text of ["この端末に残っている古い記録の確認", "古い記録のうち", "古い記録を整理する", "RecoveryMemoryDiagnosticPanel", "recoveryHeadingText", "onRunRecoveryDryRun", "onExecuteRecoveryApply"]) assert.ok(!user.includes(text), `user UI must not contain: ${text}`);
  assert.ok(dev.includes("recoveryHeadingText") && dev.includes("古い記録を整理する") && dev.includes("RecoveryMemoryDiagnosticPanel"), "developer tools are kept");
  assert.ok(user.includes("RECOVERY_REPAIR_BUTTON") && user.includes("onUserRepair") && user.includes("onRecheckRecovery"));
  assert.ok(!/この端末に残っている古い記録の確認/.test(settings.slice(0, devStart).replace(/\/\*[\s\S]*?\*\//g, "")), "no always-on heading outside the developer block");
});
test("「✓ 最新の状態です」はRecoveryの異常・保存待ち・未確認の間は出ない（保存先の統合表示にだけ依存して誤表示しない）", () => {
  const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  assert.ok(settings.includes('vaultStatusView.kind === "latest" && recoveryAllowsLatest(recoveryUserView)'));
});
test("Settingsを開くこととRecovery確認は結びつかない。背景の確認はstartup後に、読み取りの確認だけを行う", () => {
  const chat = strip(fs.readFileSync("src/components/ChatScreen.tsx", "utf8"));
  const start = chat.indexOf("async function startRecoveryBackgroundCheck("), end = chat.indexOf("async function handleUserRepair()");
  const check = chat.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(!/settingsOpen/.test(check) && !/settingsOpen[^\n]*recoveryDetection|recoveryDetection[^\n]*settingsOpen/.test(chat), "no Settings-open trigger");
  assert.ok(check.includes("runBackgroundRecoveryCheck(") && !/applyRecovery\(|resumeNarrowRepairForUser|runLegacyHeldCleanup|executeNarrow/.test(check), "the background check never repairs or cleans up");
  assert.ok(/runProductionBootstrapOnce\(vaultHandle\)[\s\S]*\.then\(\(\) => startRecoveryBackgroundCheck\(vaultHandle\)\)/.test(chat), "started after the normal startup (bootstrap) settles");
});
test("ユーザー向け「修復する」は、今のバージョンで直せる記録だけを自動修復で直す（限定修復は途中で止まったものの続きだけ）", () => {
  const chat = strip(fs.readFileSync("src/components/ChatScreen.tsx", "utf8"));
  const handler = chat.slice(chat.indexOf("async function handleUserRepair()"), chat.indexOf("async function handleExecuteRecoveryApply("));
  assert.ok(handler.includes("report.repairTargets.length === 0") && handler.includes("runProductionVaultAutoRepair("), "only the repair targets, through the auto repair (backup first)");
  assert.ok(!handler.includes("handleExecuteRecoveryApply(") || handler.includes('resumed === "not-repairable"'), "the plain Recovery Apply is only used to resume an interrupted one");
  assert.ok(handler.includes("resumeNarrowRepairForUser(") && !handler.includes("runNarrowRepairPreflight") && !handler.includes("runExplicitMemoryRepair"));
});
test("通常UIの再確認は読み取りだけの「もう一度確認する」。開発者向けの「確認する」（dry-run）や古い記録の整理は出さない", () => {
  const user = userBlock();
  for (const text of ["古い記録", "onRunRecoveryDryRun", "確認してください"]) assert.ok(!user.includes(text), text);
  const chat = strip(fs.readFileSync("src/components/ChatScreen.tsx", "utf8"));
  const recheck = chat.slice(chat.indexOf("function handleRecheckRecovery()"), chat.indexOf("async function handleUserRepair()"));
  assert.ok(recheck.includes("startRecoveryBackgroundCheck(vaultHandle)") && !/applyRecovery|handleExecuteRecoveryApply|resumeNarrow/.test(recheck), "read-only re-check");
});
test("「もう一度確認する」は、前回の確認が終わっていれば（要確認・保存待ち・未確定のどれでも）必ずもう一度確認する。実行中の確認とは重ねない", () => {
  const chat = strip(fs.readFileSync("src/components/ChatScreen.tsx", "utf8"));
  const recheck = chat.slice(chat.indexOf("function handleRecheckRecovery()"), chat.indexOf("async function handleUserRepair()"));
  assert.ok(/if \(!vaultHandle \|\| recoveryCheckInFlightRef\.current === vaultGenerationRef\.current\) return;\s+recoveryDetectionRanRef\.current = false;/.test(recheck), "only an in-flight check blocks a manual re-check");
  const start = chat.slice(chat.indexOf("async function startRecoveryBackgroundCheck("), chat.indexOf("async function runRecoveryBackgroundCheckOnce("));
  assert.ok(start.includes("recoveryCheckInFlightRef.current = generation;") && /finally \{\s+if \(recoveryCheckInFlightRef\.current === generation\) recoveryCheckInFlightRef\.current = null;/.test(start), "the in-flight mark is always cleared");
});
