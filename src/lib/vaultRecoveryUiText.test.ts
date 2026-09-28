/**
 * M2（UI状態の区別）の回帰テスト。DOM/Reactに依存しない、`SettingsPanel.tsx`が使う純粋関数の単体テスト。
 * 実行方法：`npm run test:recovery-ui-text`（`tsc -p tsconfig.recovery-ui-text.json && node --test .test-out/lib/vaultRecoveryUiText.test.js`）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recoveryDoneLooksLikeSuccess, recoveryDoneMessage, recoveryHeadingText } from "./vaultRecoveryUiText";

test("見出し：診断前（idle）は固定の『確認が必要な記録があります』を出さない", () => {
  assert.equal(recoveryHeadingText({ kind: "idle" }), "この端末に残っている古い記録の確認");
});

test("見出し：診断中（scanning）も固定の『確認が必要な記録があります』を出さない", () => {
  assert.equal(recoveryHeadingText({ kind: "scanning" }), "この端末に残っている古い記録の確認");
});

test("見出し：正常Vault（plan・heldCount===0）は『確認が必要な記録があります』にならない", () => {
  assert.equal(recoveryHeadingText({ kind: "plan", heldCount: 0 }), "この端末に残っている古い記録の確認");
});

test("見出し：実際に保留がある（plan・heldCount>0）場合だけ件数付きで出す", () => {
  assert.equal(recoveryHeadingText({ kind: "plan", heldCount: 3 }), "確認が必要な記録が3件あります");
});

test("done：nothing-to-doは『復旧する記録はありませんでした』", () => {
  const m = recoveryDoneMessage({ status: "nothing-to-do", recovered: 0, held: 0, failed: 0 });
  assert.equal(m.primary, "復旧する記録はありませんでした。");
  assert.equal(m.heldNote, null);
  assert.equal(m.failedNote, null);
});

test("done：recovered>0は件数付きの成功文言", () => {
  const m = recoveryDoneMessage({ status: "completed", recovered: 3, held: 0, failed: 0 });
  assert.equal(m.primary, "3件を復旧しました。");
});

test("done：completedでもrecovered===0は『0件を復旧しました』に潰さない", () => {
  const m = recoveryDoneMessage({ status: "completed", recovered: 0, held: 1, failed: 1 });
  assert.notEqual(m.primary, "0件を復旧しました。");
  assert.equal(m.primary, "今回は復旧できませんでした。");
  assert.notEqual(m.heldNote, null);
  assert.notEqual(m.failedNote, null);
});

test("done：一部保留（recovered>0 かつ held>0）は両方の注記を独立して出す", () => {
  const m = recoveryDoneMessage({ status: "completed", recovered: 2, held: 1, failed: 0 });
  assert.equal(m.primary, "2件を復旧しました。");
  assert.notEqual(m.heldNote, null);
  assert.equal(m.failedNote, null);
});

test("recoveryDoneLooksLikeSuccess：recovered>0のときだけtrue（error/unavailable相当の値では常にfalse）", () => {
  assert.equal(recoveryDoneLooksLikeSuccess({ status: "completed", recovered: 0, held: 0, failed: 0 }), false);
  assert.equal(recoveryDoneLooksLikeSuccess({ status: "completed", recovered: 1, held: 0, failed: 0 }), true);
  assert.equal(recoveryDoneLooksLikeSuccess({ status: "nothing-to-do", recovered: 0, held: 0, failed: 0 }), false);
});
