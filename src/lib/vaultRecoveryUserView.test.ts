/**
 * Recovery通常ユーザー向け表示の回帰テスト（純粋関数＋表示条件のsource-inspection。DOM/Reactのtest harnessは無い）。
 * 実行方法：`npm run test:recovery-ui-text`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deriveRecoveryUserView, recoveryAllowsLatest, RECOVERY_ATTENTION_TEXT, RECOVERY_REPAIR_BUTTON } from "./vaultRecoveryUserView";

const plan = (heldCount: number, recoverableCount = 0) => ({ kind: "plan", applyPlan: { heldCount, recoverableCount } });
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

test("A: 正常（検出済み・held 0・recoverable 0）→ Recovery表示なし、「最新」を出してよい", () => {
  for (const status of [{ kind: "clean" }, plan(0, 0), { kind: "done", result: { held: 0, failed: 0 } }]) {
    const view = deriveRecoveryUserView(status); assert.deepEqual(view, { kind: "none" }); assert.equal(recoveryAllowsLatest(view), true);
  }
});
test("未検出・検出中は「最新」と断定しない（検出できなかった場合だけ、何も断定せず通す）", () => {
  for (const kind of ["idle", "scanning"]) { const view = deriveRecoveryUserView({ kind }); assert.equal(view.kind, "pending"); assert.equal(recoveryAllowsLatest(view), false); }
  // 検査できなかった場合：何も表示せず、「最新」とも断定しない（意味不明な確認UIも出さない）
  const failed = deriveRecoveryUserView({ kind: "idle" }, { detectionFailed: true });
  assert.deepEqual(failed, { kind: "unknown" }); assert.equal(recoveryAllowsLatest(failed), false);
});
test("B: Recovery対象あり（held>0 / recoverable>0 / 中断）→ 異常表示と修復導線、「最新」は出さない", () => {
  for (const status of [plan(5), plan(0, 3), plan(10, 2), { kind: "interrupted" }, { kind: "known-issue" }]) {
    const view = deriveRecoveryUserView(status); assert.equal(view.kind, "attention"); assert.equal(recoveryAllowsLatest(view), false);
  }
  assert.equal(RECOVERY_ATTENTION_TEXT, "保存先に確認が必要な記録があります"); assert.equal(RECOVERY_REPAIR_BUTTON, "修復する");
});
test("修復中は修復中表示。「最新」は出さない", () => {
  const view = deriveRecoveryUserView({ kind: "executing" }); assert.equal(view.kind, "repairing"); assert.equal(recoveryAllowsLatest(view), false);
});
test("C: 修復成功後（再検出で held 0 / issues 0）→ Recovery表示が消え、最新に戻る", () => {
  assert.deepEqual(deriveRecoveryUserView(plan(5)).kind, "attention");
  assert.deepEqual(deriveRecoveryUserView({ kind: "clean" }), { kind: "none" });
  assert.deepEqual(deriveRecoveryUserView(plan(0, 0), { incomplete: false }), { kind: "none" });
});
test("D: 修復失敗・保留 → 最新と誤表示せず、異常表示を維持して未完了を伝える", () => {
  for (const status of [plan(5), { kind: "interrupted" }, { kind: "error" }, { kind: "done", result: { held: 2, failed: 0 } }, { kind: "done", result: { held: 0, failed: 1 } }]) {
    const view = deriveRecoveryUserView(status, { incomplete: true }); assert.equal(view.kind, "attention"); assert.equal(recoveryAllowsLatest(view), false);
    if (view.kind === "attention") assert.equal(view.incomplete, true);
  }
  assert.equal(deriveRecoveryUserView({ kind: "error" }).kind, "attention");
});
test("E: 開発者向け診断は debugLog=1（showAdvancedVaultTools）の中だけにあり、通常UIには出ない", () => {
  const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  const devStart = settings.indexOf('{showAdvancedVaultTools && vaultStatus === "connected" && vaultHandle && (');
  assert.ok(devStart > 0, "the old Recovery block is behind showAdvancedVaultTools");
  const userStart = settings.indexOf("Recovery（通常ユーザー向け）"), userEnd = devStart;
  assert.ok(userStart > 0 && userStart < userEnd, "the user-facing block sits before the developer block");
  const user = strip(settings.slice(userStart, userEnd)), dev = settings.slice(devStart);
  for (const text of ["この端末に残っている古い記録の確認", "古い記録のうち", "確認する", "古い記録を整理する", "RecoveryMemoryDiagnosticPanel", "recoveryHeadingText"]) assert.ok(!user.includes(text), `user UI must not contain: ${text}`);
  assert.ok(dev.includes("recoveryHeadingText") && dev.includes("古い記録を整理する") && dev.includes("RecoveryMemoryDiagnosticPanel"), "developer tools are kept");
  assert.ok(user.includes("RECOVERY_REPAIR_BUTTON") && user.includes("onUserRepair"));
  assert.ok(!/この端末に残っている古い記録の確認/.test(settings.slice(0, devStart).replace(/\/\*[\s\S]*?\*\//g, "")), "no always-on heading outside the developer block");
});
test("「✓ 最新の状態です」はRecoveryの異常・未検出の間は出ない（保存先の統合表示にだけ依存して誤表示しない）", () => {
  const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  assert.ok(settings.includes('vaultStatusView.kind === "latest" && recoveryAllowsLatest(recoveryUserView)'));
});
test("Settingsを開くこととRecovery検査は結びつかない。背景検査はstartup後に、読み取りの検査だけを行う", () => {
  const chat = strip(fs.readFileSync("src/components/ChatScreen.tsx", "utf8"));
  const start = chat.indexOf("async function startRecoveryBackgroundCheck("), end = chat.indexOf("async function handleUserRepair()");
  const check = chat.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(!/settingsOpen/.test(check) && !/settingsOpen[^\n]*recoveryDetection|recoveryDetection[^\n]*settingsOpen/.test(chat), "no Settings-open trigger");
  assert.ok(check.includes("runBackgroundRecoveryCheck(") && !/applyRecovery\(|runNarrowRepairForUser|runLegacyHeldCleanup|executeNarrow/.test(check), "the background check never repairs or cleans up");
  assert.ok(/runProductionBootstrapOnce\(vaultHandle\)[\s\S]*\.then\(\(\) => startRecoveryBackgroundCheck\(vaultHandle\)\)/.test(chat), "started after the normal startup (bootstrap) settles");
});
test("ユーザー向け「修復する」は全ての安全確認を通す入口だけを使う", () => {
  const chat = strip(fs.readFileSync("src/components/ChatScreen.tsx", "utf8"));
  const handler = chat.slice(chat.indexOf("async function handleUserRepair()"), chat.indexOf("async function handleExecuteRecoveryApply()"));
  assert.ok(handler.includes("runNarrowRepairForUser(") && handler.includes("handleExecuteRecoveryApply()") && handler.includes("planRecoveryApplyExcludingArchived") && handler.includes("recordRecoveryCheck("));
  const narrow = strip(fs.readFileSync("src/lib/memoryNarrowRepair.ts", "utf8"));
  const user = narrow.slice(narrow.indexOf("export async function runNarrowRepairForUser"));
  assert.ok(user.includes("runNarrowRepairPreflight(env, confirmed)).allPass") && user.includes("executeNarrowMemoryRepair(env"), "a new repair needs the all-PASS pre-repair check");
});
test("検査に失敗しても、通常UIに手動確認の導線（古い記録の確認 / 確認する）を出さない", () => {
  const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  const user = strip(settings.slice(settings.indexOf("Recovery（通常ユーザー向け）"), settings.indexOf('{showAdvancedVaultTools && vaultStatus === "connected" && vaultHandle && (')));
  for (const text of ["古い記録", "確認する", "確認してください"]) assert.ok(!user.includes(text), text);
});
