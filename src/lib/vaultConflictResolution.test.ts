/**
 * 競合の解決の、読むだけの判定と表示の回帰テスト。架空データのみ。実際の書き込み・ロック・中断は実ブラウザのE2E（e2e/vault-conflict-resolution.spec.ts）で確かめる。
 * 実行：`npm run test:vault-conflict`。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..");
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "idb") return require(path.join(OUT, "lib/fakeIdb.js"));
  return origLoad.call(this, request, parent, isMain);
};

import type { ConsistencyReport } from "./vaultConsistency";
const conflict = require("./vaultConflictResolution") as typeof import("./vaultConflictResolution");
const view = require("./vaultRecoveryUserView") as typeof import("./vaultRecoveryUserView");

test("差分：同じ行は対応付け、どちらか一方だけの行を区別する", () => {
  const diff = conflict.lineDiff("a\nb\nc\nd", "a\nx\nc\nd\ne");
  assert.deepEqual(diff, [
    { kind: "same", text: "a" }, { kind: "device", text: "b" }, { kind: "vault", text: "x" }, { kind: "same", text: "c" }, { kind: "same", text: "d" }, { kind: "vault", text: "e" },
  ]);
  assert.deepEqual(conflict.lineDiff("a", "a"), [{ kind: "same", text: "a" }]);
});

test("差分：とても長い記録でも行を落とさない（対応付けを省くだけ）", () => {
  const a = Array.from({ length: 5000 }, (_, i) => `端末${i}`).join("\n"), b = Array.from({ length: 5000 }, (_, i) => `保存先${i}`).join("\n");
  const diff = conflict.lineDiff(a, b);
  assert.equal(diff.filter((l) => l.kind === "device").length, 5000);
  assert.equal(diff.filter((l) => l.kind === "vault").length, 5000);
});

test("説明：何が変わり、何が通常の記録から無くなるかを行数つきで示す", () => {
  const diff = conflict.lineDiff("共通\n端末だけ", "共通\n保存先だけ1\n保存先だけ2");
  assert.match(conflict.choiceExplanation("keep-both", { diff }).mayLose, /失われる内容はありません.*2行/);
  assert.match(conflict.choiceExplanation("adopt-device", { diff }).mayLose, /保存先だけにある2行.*バックアップ/);
  assert.match(conflict.choiceExplanation("adopt-vault", { diff }).mayLose, /端末だけにある1行.*バックアップ/);
  assert.match(conflict.choiceExplanation("adopt-vault", { diff }).changes, /AIが参照する内容/);
});

test("選べる記録：内容が異なる記録だけ。ファイルの問題・複数の複製・他の分類は含めない。同じ記録は1回", () => {
  const f = (over: object) => ({ category: "needsChoice", reason: "different-content", recordType: "memory", recordId: "m1", ...over });
  const report = { findings: [f({}), f({}), f({ recordId: "c1", recordType: "conversation" }), f({ reason: "multiple-copies", recordId: "m2" }), f({ category: "repairLater", recordId: "m3" }), f({ recordType: "file", recordId: undefined })] } as unknown as ConsistencyReport;
  assert.deepEqual(view.conflictRefsOf(report), [{ recordType: "memory", recordId: "m1" }, { recordType: "conversation", recordId: "c1" }]);
  assert.deepEqual(view.conflictRefsOf(null), []);
});

test("内容が異なる記録が残る間は「最新の状態です」と言わない", () => {
  const report = { state: "attention", findings: [], groups: [{ category: "needsChoice", reason: "different-content", recordType: "memory", count: 1 }], repairTargets: [] } as unknown as ConsistencyReport;
  assert.equal(view.recoveryAllowsLatest(view.deriveRecoveryUserView({ kind: "idle" }, report)), false);
});

test("すべての理由に説明の文がある（選択肢を出さないときも、理由を示す）", () => {
  for (const reason of ["device-missing", "tombstoned", "file-unreadable", "registry-unreadable", "stored-elsewhere", "not-separable", "duplicate-in-file", "unparseable", "repair-in-progress"] as const) assert.ok(conflict.BLOCK_REASON_TEXT[reason].length > 0);
  for (const reason of ["would-lose-content", "identity-differs", "active-conversation"] as const) assert.ok(conflict.ADOPT_VAULT_BLOCK_TEXT[reason].length > 0);
});
