/**
 * 保存先の整合性確認（vaultConsistency.ts）と、その通常ユーザー向け表示（vaultRecoveryUserView.ts）の回帰テスト。
 * 架空のデータだけを使う（実Vault・実IndexedDBは使わない。実ブラウザでの確認はe2e/vault-consistency.spec.ts）。
 * 実行方法：`npm run test:vault-consistency`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyConsistency, hasPendingSaves, runConsistencyCheck, saveProgressFingerprint, STALLED_SAVE_ATTEMPTS, ConsistencyCheckCancelledError,
  type ConsistencyPlanLike, type SaveProgress, type SaveProgressEntry,
} from "./vaultConsistency";
import { deriveRecoveryUserView, recoveryAllowsLatest, RECOVERY_ATTENTION_TEXT, RECOVERY_REPAIR_BUTTON } from "./vaultRecoveryUserView";

type Rec = ConsistencyPlanLike["plan"]["records"][number];
const rec = (recordType: string, recordId: string, classification: string, extra: Partial<Rec> = {}): Rec => ({
  recordType, recordId, classification, reasons: [], syncState: { savedUpdatedAt: null, matchesLocal: null }, ...extra,
});
const plan = (p: Partial<{ records: Rec[]; ops: ConsistencyPlanLike["ops"]; held: ConsistencyPlanLike["held"]; issues: ConsistencyPlanLike["plan"]["issues"]; scanCompleted: boolean }> = {}): ConsistencyPlanLike => ({
  plan: { scanCompleted: p.scanCompleted ?? true, issues: p.issues ?? [], records: p.records ?? [] },
  ops: p.ops ?? [], held: p.held ?? [],
});
const entry = (id: string, status: string, extra: Partial<SaveProgressEntry> = {}): SaveProgressEntry => ({
  id, status, recordUpdatedAt: "2026-10-01T00:00:00.000Z", attempts: 0, lastError: null, updatedAt: "2026-10-01T00:00:00.000Z", ...extra,
});
const progress = (outbox: SaveProgressEntry[] = [], ledger: Record<string, string> = {}): SaveProgress => ({ outbox, ledger });
const idle = progress([entry("memory:m1", "done"), entry("conversation:c1", "done")], { "memory:m1": "t1", "conversation:c1": "t1" });

// ---------------------------------------------------------------------------
// 分類
// ---------------------------------------------------------------------------
test("正常な保存完了後：保留も復旧対象も無く、保存待ちも無い → clean（「最新」を出してよい）", () => {
  const r = classifyConsistency(plan({ records: [rec("memory", "m1", "equivalent-existing"), rec("conversation", "c1", "equivalent-existing")] }), idle, idle);
  assert.equal(r.state, "clean"); assert.equal(r.settled, true); assert.deepEqual(r.findings, []);
  const view = deriveRecoveryUserView({ kind: "plan" }, r); assert.deepEqual(view, { kind: "none" }); assert.equal(recoveryAllowsLatest(view), true);
});

test("Outboxに保存待ちがある記録の差分は、破損ではなく保存待ち（conflict / 日付ファイル統合 / 保存先に無い記録のどれでも）", () => {
  const pending = progress([entry("memory:m1", "pending"), entry("memory:m2", "pending"), entry("conversation:c1", "pending")]);
  const r = classifyConsistency(plan({
    records: [rec("memory", "m1", "conflict"), rec("memory", "m2", "memory-dayfile-merge-required"), rec("conversation", "c1", "local-only-safe")],
    held: [{ recordType: "memory", recordId: "m1", reason: "conflict" }, { recordType: "memory", recordId: "m2", reason: "memory-dayfile-merge-required" }],
    ops: [{ kind: "create", members: [{ id: "c1" }] }],
  }), pending, pending);
  assert.equal(r.state, "saving"); assert.equal(r.counts.saving, 3);
  for (const c of ["repairable", "needsChoice", "repairLater", "unknown", "retryable"] as const) assert.equal(r.counts[c], 0, c);
  assert.deepEqual(r.repairableIds, [], "a record that is still being saved is never a repair target");
  const view = deriveRecoveryUserView({ kind: "plan" }, r);
  assert.deepEqual(view, { kind: "saving", count: 3, checking: false }); assert.equal(recoveryAllowsLatest(view), false, "saving is not success");
});

test("走査の前後で保存の進行状況が変わった（保存処理と重なった）→ unsettled。異常として確定しない", () => {
  const before = progress([entry("memory:m1", "done")], { "memory:m1": "t1" });
  const after = progress([entry("memory:m1", "done", { recordUpdatedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" })], { "memory:m1": "t2" });
  const r = classifyConsistency(plan({ records: [rec("memory", "m1", "conflict")], held: [{ recordType: "memory", recordId: "m1", reason: "conflict" }] }), before, after);
  assert.equal(r.settled, false); assert.equal(r.state, "unsettled");
  assert.equal(r.counts.needsChoice, 0, "the record that moved during the scan is saving, not a conflict");
  assert.equal(deriveRecoveryUserView({ kind: "plan" }, r).kind, "unsettled");
  // 別の記録の保存（別タブ等）と重なっただけでも、走査全体を確定させない
  const other = classifyConsistency(plan({ records: [rec("memory", "m9", "conflict")], held: [{ recordType: "memory", recordId: "m9", reason: "conflict" }] }), before, after);
  assert.equal(other.state, "unsettled"); assert.equal(other.counts.needsChoice, 1, "the finding is still shown, but not as a settled result");
});

test("sync ledgerだけの旧保存経路：一度保存できた記録の新しい版がまだ反映されていない → 保存待ち。ledgerの前後の変化も保存中", () => {
  const r = classifyConsistency(plan({
    records: [rec("conversation", "c1", "conflict", { syncState: { savedUpdatedAt: "t0", matchesLocal: false } })],
    held: [{ recordType: "conversation", recordId: "c1", reason: "conflict" }],
  }), progress(), progress());
  assert.equal(r.counts.saving, 1); assert.equal(r.state, "saving");
});

test("真正の不整合は隠さない：保存が終わっている（Outbox done・ledger一致）のに内容が違う → 要確認（どちらを残すか）", () => {
  const r = classifyConsistency(plan({ records: [rec("memory", "m1", "conflict")], held: [{ recordType: "memory", recordId: "m1", reason: "conflict" }] }), idle, idle);
  assert.equal(r.state, "attention"); assert.equal(r.counts.needsChoice, 1);
  assert.deepEqual(r.groups, [{ category: "needsChoice", reason: "different-content", recordType: "memory", count: 1 }]);
  const view = deriveRecoveryUserView({ kind: "plan" }, r);
  assert.equal(view.kind, "attention"); assert.equal(recoveryAllowsLatest(view), false);
  if (view.kind === "attention") {
    assert.equal(view.canRepair, false, "nothing that the current version can repair -> no 修復する button");
    assert.deepEqual(view.sections.map((s) => s.category), ["needsChoice"]);
    assert.match(view.sections[0].lines[0], /^記録 1件：端末と保存先で内容が異なります$/);
  }
});

test("分類：自動で直せる／対応待ち／確認が必要／再試行／原因未特定を区別する（件数・日付・ファイル名に依存しない）", () => {
  const records = [
    rec("conversation", "c1", "local-only-safe"), rec("memory", "m1", "equivalent-existing"),
    rec("memory", "m2", "memory-dayfile-merge-required"), rec("source", "s1", "unreadable / indeterminate", { reasons: ["orphan-registry-key"] }),
    rec("memory", "m3", "unreadable / indeterminate", { reasons: ["multiple-memory-files-for-day"] }),
    rec("memory", "m4", "unreadable / indeterminate", { reasons: ["metadata-trace-without-confirmed-markdown"] }),
    rec("reflection", "r1", "unreadable / indeterminate", { reasons: ["invalid-local-record"] }),
    rec("conversation", "c2", "conflict"), rec("memory", "m5", "conflict"),
  ];
  const outbox = [entry("conversation:c2", "pending", { attempts: STALLED_SAVE_ATTEMPTS, lastError: "NotReadableError" }), entry("memory:m5", "held")];
  const p = progress(outbox);
  const r = classifyConsistency(plan({
    records,
    ops: [{ kind: "create", members: [{ id: "c1" }] }, { kind: "repair", members: [{ id: "m1" }] }],
    held: [
      { recordType: "memory", recordId: "m2", reason: "memory-dayfile-merge-required" },
      { recordType: "source", recordId: "s1", reason: "unreadable-or-indeterminate" },
      { recordType: "memory", recordId: "m3", reason: "unreadable-or-indeterminate" },
      { recordType: "memory", recordId: "m4", reason: "unreadable-or-indeterminate" },
      { recordType: "reflection", recordId: "r1", reason: "unreadable-or-indeterminate" },
      { recordType: "conversation", recordId: "c2", reason: "conflict" },
      { recordType: "memory", recordId: "m5", reason: "conflict" },
    ],
  }), p, p);
  const by = Object.fromEntries(r.findings.map((f) => [f.recordId ?? "-", `${f.category}/${f.reason}`]));
  assert.deepEqual(by, {
    c1: "repairable/local-only", m1: "repairable/metadata",
    m2: "repairLater/day-file-merge", s1: "repairLater/registry-mismatch",
    m3: "needsChoice/multiple-copies", m4: "unknown/trace-without-file", r1: "unknown/invalid-local",
    c2: "retryable/save-retrying", m5: "repairLater/save-held",
  });
  assert.deepEqual(r.repairableIds.sort(), ["c1", "m1"]);
  assert.equal(r.state, "attention");
  const view = deriveRecoveryUserView({ kind: "plan" }, r);
  assert.ok(view.kind === "attention" && view.canRepair, "the 修復する button appears only because repairable records exist");
  if (view.kind === "attention") assert.deepEqual(view.sections.map((s) => s.category), ["repairable", "needsChoice", "repairLater", "retryable", "unknown"]);
});

test("読めないファイル：一時的な読取失敗は再試行、保存中に見た形式エラーは再試行、確定した走査の形式エラーだけが原因未特定", () => {
  const records = [rec("memory", "m1", "unreadable / indeterminate", { reasons: ["vault-scan-incomplete", "strict-read-or-parse-failure"] })];
  const held = [{ recordType: "memory", recordId: "m1", reason: "unreadable-or-indeterminate" }];
  const readError = classifyConsistency(plan({ records, held, scanCompleted: false, issues: [{ path: "Memories", status: "read-error", error: "NotReadableError" }] }), idle, idle);
  assert.deepEqual(readError.groups, [{ category: "retryable", reason: "read-error", recordType: "file", count: 1 }], "records held only because of the whole-scan problem are not counted as their own problem");
  const parse = plan({ records, held, issues: [{ path: "Memories/x.md", status: "invalid", error: "markdown-parse-or-shape-failure" }] });
  assert.deepEqual(classifyConsistency(parse, idle, idle).groups, [{ category: "unknown", reason: "unreadable-file", recordType: "file", count: 1 }]);
  const saving = progress([entry("memory:m7", "pending")]);
  const during = classifyConsistency(parse, saving, saving);
  assert.deepEqual(during.groups.filter((g) => g.category !== "saving"), [{ category: "retryable", reason: "read-during-save", recordType: "file", count: 1 }]);
  assert.equal(during.counts.saving, 1, "the pending save itself is shown as saving");
});

test("走査全体の保留（scan-incomplete / not-confirmed）だけの記録は、その記録自身の不整合として数えない", () => {
  const r = classifyConsistency(plan({
    records: [rec("memory", "m1", "local-only-safe")], issues: [{ path: ".tsumugi/registry-meta.json", status: "parse-error" }],
    held: [{ recordType: "memory", recordId: "m1", reason: "scan-incomplete" }, { recordType: "memory", recordId: "m2", reason: "not-confirmed" }],
  }), idle, idle);
  assert.equal(r.findings.length, 1); assert.equal(r.findings[0].recordType, "file");
});

test("指紋：Outboxの状態・版・試行回数・更新時刻とledgerのどれが変わっても変わる。順序には依存しない", () => {
  const a = progress([entry("a", "done"), entry("b", "pending")], { x: "1", y: "2" });
  const b = progress([entry("b", "pending"), entry("a", "done")], { y: "2", x: "1" });
  assert.equal(saveProgressFingerprint(a), saveProgressFingerprint(b));
  for (const changed of [
    progress([entry("a", "done"), entry("b", "done")], { x: "1", y: "2" }),
    progress([entry("a", "done"), entry("b", "pending", { attempts: 1 })], { x: "1", y: "2" }),
    progress([entry("a", "done"), entry("b", "pending")], { x: "1", y: "3" }),
  ]) assert.notEqual(saveProgressFingerprint(a), saveProgressFingerprint(changed));
  assert.equal(hasPendingSaves(a), true);
  assert.equal(hasPendingSaves(progress([entry("b", "pending", { attempts: STALLED_SAVE_ATTEMPTS, lastError: "x" })])), false, "a stalled save does not keep the check waiting");
});

// ---------------------------------------------------------------------------
// 確認の流れ（待つ・やり直すは有限回。何も書かない）
// ---------------------------------------------------------------------------
function harness(opts: { pendingPolls?: number; unsettledScans?: number } = {}) {
  let polls = 0, scans = 0, slept = 0;
  const calls: string[] = [];
  const deps = {
    readProgress: async () => {
      calls.push("progress"); polls++;
      const drainLeft = (opts.pendingPolls ?? 0) - polls >= 0;
      const moving = scans > 0 && scans <= (opts.unsettledScans ?? 0);
      return progress([entry("memory:m1", drainLeft ? "pending" : "done", moving && calls[calls.length - 2] === "plan" ? { updatedAt: `moved-${scans}` } : {})]);
    },
    plan: async () => { calls.push("plan"); scans++; return plan({ records: [rec("memory", "m1", "equivalent-existing")] }); },
    sleep: async (ms: number) => { slept += ms; },
    isCancelled: () => false,
  };
  return { deps, stats: () => ({ polls, scans, slept }), calls };
}

test("保存待ちが解消されれば確認する（解消を待ってから走査）", async () => {
  const h = harness({ pendingPolls: 3 });
  const { report } = await runConsistencyCheck(h.deps, { drainWaitMs: 60_000, pollMs: 1_000 });
  assert.equal(report.state, "clean"); assert.equal(h.stats().scans, 1); assert.equal(h.stats().slept, 3_000);
});

test("保存待ちが長期間解消されなくても無期限に待たない（上限で走査し、保存待ちとして表示する）", async () => {
  const h = harness({ pendingPolls: Number.MAX_SAFE_INTEGER });
  const { report } = await runConsistencyCheck(h.deps, { drainWaitMs: 5_000, pollMs: 1_000, attempts: 2, retryDelayMs: 1_000 });
  assert.equal(h.stats().slept <= 5_000 + 1_000, true, "bounded waiting");
  assert.equal(report.state, "saving", "a save that never finishes is shown as saving, never as success");
  assert.equal(deriveRecoveryUserView({ kind: "plan" }, report).kind, "saving");
});

test("保存処理と重なった走査は有限回やり直す。落ち着けば確定、落ち着かなければ未確定のまま返す", async () => {
  const settles = harness({ unsettledScans: 1 });
  const first = await runConsistencyCheck(settles.deps, { attempts: 3, retryDelayMs: 10 });
  assert.equal(first.report.settled, true); assert.equal(settles.stats().scans, 2);
  const never = harness({ unsettledScans: 99 });
  const last = await runConsistencyCheck(never.deps, { attempts: 3, retryDelayMs: 10 });
  assert.equal(last.report.state, "unsettled"); assert.equal(never.stats().scans, 3, "at most `attempts` scans");
});

test("タブ・保存先が切り替わったら途中で止める（cancel）", async () => {
  const h = harness();
  await assert.rejects(runConsistencyCheck({ ...h.deps, isCancelled: () => true }), ConsistencyCheckCancelledError);
  assert.equal(h.stats().scans, 0);
});

test("確認の依存は読み取りだけ（readProgress・plan）。書き込みの口を持たない", () => {
  const src = fs.readFileSync("src/lib/vaultConsistency.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(!/\bimport\b/.test(src), "the classifier is pure (no imports)");
  for (const w of [/\.put\(/, /objectStore|indexedDB/, /\.delete\(/, /createWritable/, /removeEntry/, /setRecoveryCheckMarker/]) assert.ok(!w.test(src), String(w));
  const wiring = fs.readFileSync("src/lib/vaultConsistencyCheck.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.ok(wiring.includes("withVaultWorldRead(() => planRecoveryApply(createRecoveryApplyEnv(root)))") && wiring.includes("readVaultSaveProgress"));
  assert.ok(!/withVaultSaveLock|runVaultWorldExclusive|applyRecovery\(|executeNarrow|runLegacyHeldCleanup/.test(wiring), "no save lock held across the scan; no repair");
});

// ---------------------------------------------------------------------------
// Timeline・Synthesisは判定に関わらない
// ---------------------------------------------------------------------------
test("Timeline・SynthesisのON/OFFで診断が変わらない：判定・配線・表示のどこもフラグとSynthesisのデータベースを読まない", () => {
  for (const f of ["src/lib/vaultConsistency.ts", "src/lib/vaultConsistencyCheck.ts", "src/lib/recoveryBackgroundCheck.ts", "src/lib/vaultRecoveryUserView.ts", "src/lib/vaultRecovery.ts", "src/lib/vaultRecoveryApply.ts"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/memoryTimeline|memorySynthesis|synthesisStore|tsumugi-synthesis|localStorage/.test(src), f);
  }
  // 同じ入力なら、何度でも同じ結果（隠れた状態を持たない）
  const p = plan({ records: [rec("memory", "m1", "conflict")], held: [{ recordType: "memory", recordId: "m1", reason: "conflict" }] });
  assert.deepEqual(classifyConsistency(p, idle, idle), classifyConsistency(p, idle, idle));
});

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------
test("表示：未確認・確認中・確認できなかった・修復中・修復の途中は「最新」と言わない", () => {
  for (const [status, report, opts, kind] of [
    [{ kind: "idle" }, null, {}, "pending"], [{ kind: "idle" }, null, { checking: true }, "checking"], [{ kind: "idle" }, null, { detectionFailed: true }, "unknown"],
    [{ kind: "executing" }, null, {}, "repairing"], [{ kind: "interrupted" }, null, {}, "interrupted"],
  ] as const) {
    const view = deriveRecoveryUserView(status, report, opts); assert.equal(view.kind, kind); assert.equal(recoveryAllowsLatest(view), false);
  }
  assert.deepEqual(deriveRecoveryUserView({ kind: "clean" }, null), { kind: "none" }, "a build/Vault already confirmed clean");
  assert.equal(RECOVERY_ATTENTION_TEXT, "保存先に確認が必要な記録があります"); assert.equal(RECOVERY_REPAIR_BUTTON, "修復する");
});

test("表示：確認中も既知の結果を隠さない。修復の失敗メッセージは結果と一緒に出し、修復ボタンは出さない", () => {
  const r = classifyConsistency(plan({ records: [rec("conversation", "c1", "local-only-safe")], ops: [{ kind: "create", members: [{ id: "c1" }] }] }), idle, idle);
  const checking = deriveRecoveryUserView({ kind: "plan" }, r, { checking: true });
  assert.ok(checking.kind === "attention" && checking.checking && checking.canRepair);
  const failed = deriveRecoveryUserView({ kind: "error", message: "他の操作が実行中のため開始できませんでした。" }, r);
  assert.ok(failed.kind === "attention" && !failed.canRepair && failed.message === "他の操作が実行中のため開始できませんでした。" && failed.sections.length === 1);
});

test("通常の「修復する」は限定修復を新しく実行しない：途中で止まった限定修復の続きだけ。直せる記録が無ければ何もしない", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
  const chat = strip(fs.readFileSync("src/components/ChatScreen.tsx", "utf8"));
  const handler = chat.slice(chat.indexOf("async function handleUserRepair()"), chat.indexOf("async function handleExecuteRecoveryApply("));
  assert.ok(handler.length > 100);
  assert.ok(!/runNarrowRepairForUser|runExplicitMemoryRepair|executeNarrowMemoryRepair|runNarrowRepairPreflight/.test(handler), "no new narrow repair from the normal button");
  assert.ok(handler.includes("resumeNarrowRepairForUser(vaultHandle)") && handler.includes('recoveryStatus.kind === "interrupted"'));
  assert.ok(handler.includes("report.repairableIds.length === 0") && handler.includes("recordIds: report.repairableIds"), "only the records the current version can repair");
  const narrow = strip(fs.readFileSync("src/lib/memoryNarrowRepair.ts", "utf8"));
  const resume = narrow.slice(narrow.indexOf("export async function resumeNarrowRepairForUser"), narrow.indexOf("export async function runRawHeldMemoryDiagnostic"));
  assert.ok(resume.includes('if (!resuming) return { status: "not-repairable" };') && resume.includes("executeNarrowMemoryRepair(env, null)") && !resume.includes("runNarrowRepairPreflight"), "resume only");
  assert.ok(!/export async function runNarrowRepairForUser/.test(narrow));
  const panel = fs.readFileSync("src/components/RecoveryMemoryDiagnosticPanel.tsx", "utf8");
  assert.ok(panel.includes("window.confirm(") && narrow.includes('get("debugLog") !== "1"'), "the developer-only run needs ?debugLog=1 and an explicit confirmation");
});

test("背景の確認は読み取りだけ。修復・整理・限定修復を呼ばず、保存待ち・未確定のときだけ有限回確認し直す", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
  const chat = strip(fs.readFileSync("src/components/ChatScreen.tsx", "utf8"));
  const check = chat.slice(chat.indexOf("async function startRecoveryBackgroundCheck("), chat.indexOf("function handleRecheckRecovery()"));
  assert.ok(check.includes("runBackgroundRecoveryCheck(productionRecoveryBackgroundDeps(() => checkVaultConsistency(handle, cancelled)))"));
  assert.ok(!/applyRecovery\(|resumeNarrowRepairForUser|runLegacyHeldCleanup|executeNarrow|handleExecuteRecoveryApply/.test(check), "never repairs");
  assert.ok(check.includes("recoveryRecheckCountRef.current < RECOVERY_RECHECK_LIMIT"), "bounded automatic re-checks");
  assert.ok(/runProductionBootstrapOnce\(vaultHandle\)[\s\S]*\.then\(\(\) => startRecoveryBackgroundCheck\(vaultHandle\)\)/.test(chat), "started after the normal startup (bootstrap) settles");
});

test("設定画面：要確認では種類・件数・理由と「もう一度確認する」。修復ボタンは直せる記録があるときだけ。開発者向けの道具は通常UIに出ない", () => {
  const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  const userStart = settings.indexOf("Recovery（通常ユーザー向け）"), devStart = settings.indexOf('{showAdvancedVaultTools && vaultStatus === "connected" && vaultHandle && (');
  assert.ok(userStart > 0 && devStart > userStart);
  const user = settings.slice(userStart, devStart).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.ok(user.includes('recoveryUserView.kind === "attention" && recoveryUserView.canRepair') && user.includes("RECOVERY_REPAIR_BUTTON"));
  assert.ok(user.includes("onRecheckRecovery") && user.includes("RECOVERY_RECHECK_BUTTON") && user.includes("section.lines.map") && user.includes("RECOVERY_DATA_KEPT_TEXT"));
  for (const text of ["RecoveryMemoryDiagnosticPanel", "古い記録を整理する", "onRunRecoveryDryRun", "onExecuteRecoveryApply", "検証済み10件"]) assert.ok(!user.includes(text), text);
  assert.ok(settings.includes('vaultStatusView.kind === "latest" && recoveryAllowsLatest(recoveryUserView)'), "「✓ 最新の状態です」 only when the check is clean");
});
