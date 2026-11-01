/**
 * 保存先の汎用修復 段階3（自動修復）の回帰テスト。架空データのみ（実Vault・実IndexedDBは使わない。実ブラウザでの確認はe2e/vault-auto-repair.spec.ts）。
 * 実行：`npm run test:vault-auto-repair`。
 * 異常パターンごとに、バックアップが無い・壊れている・修復の後に変わった・別の操作中・新旧が決まらない、のどれでも何も書き換えず、
 * 修復後はもう一度確認した結果だけで表示すること、何度実行しても同じ結果になることを確かめる。
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

import type { ConsistencyReport, RepairTarget } from "./vaultConsistency";
import type { MemoryObject } from "./types";
import type { BackupDeviceSnapshot } from "./db";
const repair = require("./vaultAutoRepair") as typeof import("./vaultAutoRepair");
const backup = require("./vaultBackup") as typeof import("./vaultBackup");
const zip = require("./zip") as typeof import("./zip");
const markdown = require("./markdown") as typeof import("./markdown");

const T = "2026-10-20T09:15:00.000Z";
const T2 = "2026-10-21T10:00:00.000Z";
const enc = new TextEncoder();

const memory = (id: string, over: Partial<MemoryObject> = {}): MemoryObject => ({
  id, date: T, types: ["event"], conversationId: "CONV-1", content: `架空の内容-${id}`, summary: `架空の要約-${id}`, keywords: [], themeIds: [], personIds: [], emotionIds: [],
  goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: T, updatedAt: T,
  metadata: { id: `meta-${id}`, schemaVersion: "0.1", source: "ai-capture", createdAt: T, updatedAt: T }, ...over,
});

const target = (action: RepairTarget["action"], recordType: RepairTarget["recordType"], recordId: string, reason: RepairTarget["reason"] = action === "apply" ? "local-only" : "day-file-merge"): RepairTarget => ({ action, reason, recordType, recordId });

function report(targets: RepairTarget[], over: Partial<ConsistencyReport> = {}): ConsistencyReport {
  const findings = targets.map((t) => ({ category: "repairable" as const, reason: t.reason, recordType: t.recordType, recordId: t.recordId, action: t.action }));
  const counts = { saving: 0, repairable: findings.length, repairLater: 0, needsChoice: 0, retryable: 0, unknown: 0 };
  return {
    state: findings.length ? "attention" : "clean", settled: true, findings, counts,
    groups: findings.length ? [{ category: "repairable", reason: "local-only", recordType: "memory", count: findings.length }] : [],
    repairableIds: targets.filter((t) => t.action === "apply").map((t) => t.recordId), repairTargets: targets, ...over,
  };
}
const CLEAN = report([]);

/** 架空の端末データ（BackupDeviceSnapshot）。records = 記録の種類→[id, updatedAt] */
function device(records: { conversation?: [string, string][]; memory?: [string, string][]; source?: [string, string][] }): BackupDeviceSnapshot {
  const rows = (list: [string, string][] = []) => list.map(([id, updatedAt]) => ({ key: id, value: { id, updatedAt } }));
  const empty = { conversations: [], memoryObjects: [], sources: [], vaultOutbox: [], vaultSyncState: [], vaultIdentity: [], migrationJournal: [], connectState: [], settings: [] };
  return { stores: { ...empty, conversations: rows(records.conversation), memoryObjects: rows(records.memory), sources: rows(records.source) } as unknown as BackupDeviceSnapshot["stores"], excludedCredentialKeys: 0, handleKeys: [] };
}

/** 架空の保存先（パス→バイト列）と、そこへ実際の形式のバックアップ（ZIP＋.verified.json）を置く */
async function makeBackup(vault: Map<string, Uint8Array>, dev: BackupDeviceSnapshot, runId = "repair-test-1") {
  const files = [...vault].map(([p, data]) => ({ path: p, data }));
  const { entries, manifest } = await backup.buildBackupEntries(dev, files, { runId, createdAt: T, build: "test", backend: "opfs" });
  const bytes = zip.createZipBytes(entries);
  const sha256 = await backup.sha256Hex(bytes);
  vault.set(`${backup.BACKUP_DIR}/${runId}.zip`, bytes);
  vault.set(`${backup.BACKUP_DIR}/${runId}.verified.json`, enc.encode(JSON.stringify({ format: manifest.format, runId, zip: `${runId}.zip`, size: bytes.byteLength, sha256, verifiedAt: T, summary: manifest.summary })));
  return { ok: true as const, runId, path: `${backup.BACKUP_DIR}/${runId}.zip`, size: bytes.byteLength, sha256, summary: manifest.summary, zip: bytes };
}

interface World {
  vault: Map<string, Uint8Array>;
  versions: Map<string, string>;
  log: string[];
  inspect: Map<string, { paths?: string[]; blocked?: import("./vaultAutoRepair").AutoRepairSkipReason | null }>;
}

function env(w: World, opts: {
  reports: ConsistencyReport[];
  backup?: () => Promise<import("./vaultBackup").BackupResult>;
  busy?: boolean;
  applyStatus?: string;
  requeue?: import("./vaultAutoRepair").RequeueResult;
  afterBackup?: () => void;
}): import("./vaultAutoRepair").AutoRepairEnv {
  const reports = [...opts.reports];
  let inLock = false;
  return {
    async check() { w.log.push("check"); return reports.length > 1 ? reports.shift()! : reports[0]; },
    async createBackup() {
      w.log.push("backup");
      const result = opts.backup ? await opts.backup() : await makeBackup(w.vault, device({ conversation: [...w.versions].filter(([k]) => k.startsWith("conversation:")).map(([k, v]): [string, string] => [k.slice(13), v]), memory: [...w.versions].filter(([k]) => k.startsWith("memory:")).map(([k, v]): [string, string] => [k.slice(7), v]) }));
      opts.afterBackup?.();
      return result;
    },
    async withExclusive(fn) {
      if (opts.busy) { w.log.push("busy"); return { ok: false }; }
      w.log.push("lock"); inLock = true;
      try { return { ok: true, value: await fn() }; } finally { inLock = false; w.log.push("unlock"); }
    },
    async readVaultFile(p) { return w.vault.get(p) ?? null; },
    async inspectTarget(t) {
      const key = `${t.recordType === "reflection" ? "memory" : t.recordType}:${t.recordId}`;
      const i = w.inspect.get(t.recordId) ?? {};
      return { version: w.versions.get(key) ?? null, paths: i.paths ?? [], blocked: i.blocked ?? null };
    },
    async applyRecovery(ids) { assert.ok(inLock, "apply only inside the exclusive section"); w.log.push(`apply:${ids.join(",")}`); return { status: opts.applyStatus ?? "completed", recovered: ids.length, failed: 0 }; },
    async requeue(t, version) { assert.ok(inLock, "requeue only inside the exclusive section"); w.log.push(`requeue:${t.recordId}@${version}`); return opts.requeue ?? "queued"; },
    async settleSaves(ts) { w.log.push(`settle:${ts.map((t) => t.recordId).join(",")}`); },
    isCancelled: () => false,
  };
}

const world = (vault: Record<string, string> = {}, versions: Record<string, string> = {}): World => ({
  vault: new Map(Object.entries(vault).map(([k, v]) => [k, enc.encode(v)])), versions: new Map(Object.entries(versions)), log: [], inspect: new Map(),
});

// ---------------------------------------------------------------------------

test("順序：確認→バックアップ→排他区間（直前の再照合→apply→保存のやり直し）→通常の保存→もう一度確認。問題が無くなったときだけ「確認して問題なし」", async () => {
  const day = markdown.serializeMemoryDayFile([memory("m1")]);
  const w = world({ "Memories/2026-10-20.md": day, "Conversations/c0.md": "架空" }, { "conversation:c1": T, "memory:m2": T });
  w.inspect.set("m2", { paths: ["Memories/2026-10-20.md"] });
  const targets = [target("apply", "conversation", "c1"), target("resave", "memory", "m2")];
  const outcome = await repair.runVaultAutoRepair(env(w, { reports: [report(targets), CLEAN] }));
  assert.deepEqual(w.log, ["check", "backup", "lock", "apply:c1", `requeue:m2@${T}`, "unlock", "settle:m2", "check"]);
  assert.equal(outcome.kind, "ran");
  if (outcome.kind !== "ran") return;
  assert.equal(outcome.attempted, 2); assert.equal(outcome.repaired, 2); assert.deepEqual(outcome.skipped, []);
  const view = repair.autoRepairOutcomeView(outcome, "file-system-access");
  assert.equal(view.clean, true); assert.match(view.headline, /^2件を修復し、もう一度確認して問題が無いことを確かめました。$/);
  assert.equal(view.warning, null);
  assert.equal(repair.autoRepairOutcomeView(outcome, "opfs").warning, repair.OPFS_BACKUP_WARNING, "Android (OPFS): the backup inside the app's storage is not enough");
});

test("修復の後も問題が残る → 「最新」とは言わない。残った件数と、試みたが直らなかった件数を出す", async () => {
  const w = world({}, { "conversation:c1": T, "conversation:c2": T });
  const targets = [target("apply", "conversation", "c1"), target("apply", "conversation", "c2")];
  const after = report([target("apply", "conversation", "c2")]);
  const outcome = await repair.runVaultAutoRepair(env(w, { reports: [report(targets), after] }));
  assert.ok(outcome.kind === "ran");
  if (outcome.kind !== "ran") return;
  assert.equal(outcome.repaired, 1);
  const view = repair.autoRepairOutcomeView(outcome, null);
  assert.equal(view.clean, false);
  assert.equal(view.headline, "1件を修復しました。1件は残っています。");
  assert.ok(view.lines.some((l) => l.startsWith("1件は修復を試みましたが")));
});

test("「.verified.json」があるだけでは使わない：ZIPが1バイトでも違う・無い・印が別のZIPを指す → 何も書き換えずに中止", async () => {
  const cases: [string, (w: World, runId: string) => void][] = [
    ["zip-byte-changed", (w, id) => { const p = `${backup.BACKUP_DIR}/${id}.zip`; const b = new Uint8Array(w.vault.get(p)!); b[40] ^= 1; w.vault.set(p, b); }],
    ["zip-missing", (w, id) => { w.vault.delete(`${backup.BACKUP_DIR}/${id}.zip`); }],
    ["marker-other-sha", (w, id) => { const p = `${backup.BACKUP_DIR}/${id}.verified.json`; const m = JSON.parse(new TextDecoder().decode(w.vault.get(p)!)); m.sha256 = "0".repeat(64); w.vault.set(p, enc.encode(JSON.stringify(m))); }],
    ["marker-missing", (w, id) => { w.vault.delete(`${backup.BACKUP_DIR}/${id}.verified.json`); }],
  ];
  for (const [name, damage] of cases) {
    const w = world({}, { "conversation:c1": T });
    const outcome = await repair.runVaultAutoRepair(env(w, { reports: [report([target("apply", "conversation", "c1")])], afterBackup: () => damage(w, "repair-test-1") }));
    assert.deepEqual(outcome.kind === "not-started" && outcome.reason, "backup-unverified", name);
    assert.ok(!w.log.some((l) => l.startsWith("apply") || l.startsWith("requeue")), `${name}: nothing was changed`);
  }
});

test("ZIPとして壊れている（中身の照合に失敗）バックアップも使わない", async () => {
  const w = world({}, { "conversation:c1": T });
  const outcome = await repair.runVaultAutoRepair(env(w, {
    reports: [report([target("apply", "conversation", "c1")])],
    backup: async () => {
      const real = await makeBackup(w.vault, device({ conversation: [["c1", T]] }));
      const broken = new Uint8Array(real.zip); broken[broken.length - 30] ^= 0xff;            // inside the central directory
      const sha256 = await backup.sha256Hex(broken);
      w.vault.set(`${backup.BACKUP_DIR}/${real.runId}.zip`, broken);
      w.vault.set(`${backup.BACKUP_DIR}/${real.runId}.verified.json`, enc.encode(JSON.stringify({ runId: real.runId, zip: `${real.runId}.zip`, size: broken.byteLength, sha256 })));
      return { ...real, sha256, zip: broken };
    },
  }));
  assert.deepEqual(outcome.kind === "not-started" && outcome.reason, "backup-unverified");
  assert.ok(!w.log.some((l) => l.startsWith("apply")));
});

test("バックアップの後に記録が変わった・書き換えうるファイルが変わった → その記録は直さない（バックアップに無い版を書き換えない）", async () => {
  const w = world({ "Memories/2026-10-20.md": "架空の日付ファイル" }, { "conversation:c1": T, "memory:m2": T, "conversation:c3": T });
  w.inspect.set("m2", { paths: ["Memories/2026-10-20.md"] });
  const targets = [target("apply", "conversation", "c1"), target("resave", "memory", "m2"), target("apply", "conversation", "c3")];
  const outcome = await repair.runVaultAutoRepair(env(w, {
    reports: [report(targets), report([target("apply", "conversation", "c1"), target("resave", "memory", "m2")])],
    afterBackup: () => { w.versions.set("conversation:c1", T2); w.vault.set("Memories/2026-10-20.md", enc.encode("別のタブが書いた架空の内容")); },
  }));
  assert.ok(outcome.kind === "ran");
  if (outcome.kind !== "ran") return;
  assert.ok(w.log.includes("apply:c3") && !w.log.some((l) => l.includes("c1") || l.includes("m2")), w.log.join(" "));
  assert.deepEqual(outcome.skipped.sort((a, b) => a.recordType.localeCompare(b.recordType)), [
    { reason: "changed-since-backup", recordType: "conversation", count: 1 }, { reason: "changed-since-backup", recordType: "memory", count: 1 },
  ]);
  assert.ok(repair.autoRepairOutcomeView(outcome, null).lines.some((l) => l.startsWith("会話 1件：バックアップの後に内容が変わったため")));
});

test("新旧・安全性を規則で決められない記録は対象にしない（同じ日のファイルを読み書きし直せない・読めない・記録が無い）", async () => {
  const w = world({}, { "memory:m2": T, "memory:m3": T });
  w.inspect.set("m2", { blocked: "day-file-not-mergeable" });
  w.inspect.set("m3", { blocked: "unreadable" });
  const targets = [target("resave", "memory", "m2"), target("resave", "memory", "m3"), target("apply", "conversation", "gone")];
  const outcome = await repair.runVaultAutoRepair(env(w, { reports: [report(targets)] }));
  assert.ok(outcome.kind === "ran");
  if (outcome.kind !== "ran") return;
  assert.ok(!w.log.some((l) => l.startsWith("apply") || l.startsWith("requeue") || l.startsWith("settle")), "nothing written, no save run");
  assert.deepEqual(outcome.skipped.map((s) => s.reason).sort(), ["day-file-not-mergeable", "record-missing", "unreadable"]);
  assert.equal(outcome.repaired, 0);
  assert.equal(repair.autoRepairOutcomeView(outcome, null).clean, false);
});

test("始められないとき（保存中・バックアップ失敗・別の操作中）は何も書き換えず、理由を示す", async () => {
  const unsettled = world({}, { "conversation:c1": T });
  const o1 = await repair.runVaultAutoRepair(env(unsettled, { reports: [report([target("apply", "conversation", "c1")], { state: "unsettled", settled: false })] }));
  assert.deepEqual(o1.kind === "not-started" && o1.reason, "unsettled"); assert.deepEqual(unsettled.log, ["check"], "no backup, no lock");

  const failed = world({}, { "conversation:c1": T });
  const o2 = await repair.runVaultAutoRepair(env(failed, { reports: [report([target("apply", "conversation", "c1")])], backup: async () => ({ ok: false, reason: "unreadable", retryable: true, count: 1 }) }));
  assert.ok(o2.kind === "not-started" && o2.reason === "backup-failed" && o2.backupFailure === "unreadable");
  assert.deepEqual(failed.log, ["check", "backup"]);

  const busy = world({}, { "conversation:c1": T });
  const o3 = await repair.runVaultAutoRepair(env(busy, { reports: [report([target("apply", "conversation", "c1")])], busy: true }));
  assert.deepEqual(o3.kind === "not-started" && o3.reason, "busy");
  assert.ok(!busy.log.some((l) => l.startsWith("apply")));
  for (const o of [o1, o2, o3]) assert.equal(repair.autoRepairOutcomeView(o, "opfs").clean, false);
});

test("冪等：直った後にもう一度押すと何もしない。途中の復旧が残っていれば、直したことにしない", async () => {
  const w = world({}, { "conversation:c1": T });
  const again = await repair.runVaultAutoRepair(env(w, { reports: [CLEAN] }));
  assert.equal(again.kind, "nothing-to-do"); assert.deepEqual(w.log, ["check"], "no backup when there is nothing to repair");
  assert.equal(repair.autoRepairOutcomeView(again, null).clean, true);

  const w2 = world({}, { "conversation:c1": T });
  const interrupted = await repair.runVaultAutoRepair(env(w2, { reports: [report([target("apply", "conversation", "c1")])], applyStatus: "interrupted" }));
  assert.ok(interrupted.kind === "ran" && interrupted.attempted === 0 && interrupted.skipped[0].reason === "repair-in-progress");

  const w3 = world({}, { "memory:m2": T });
  const changed = await repair.runVaultAutoRepair(env(w3, { reports: [report([target("resave", "memory", "m2")])], requeue: "changed" }));
  assert.ok(changed.kind === "ran" && changed.attempted === 0 && changed.skipped[0].reason === "changed-since-backup");
  assert.ok(!w3.log.some((l) => l.startsWith("settle")), "no save run when nothing was re-queued");
});

test("同じ日のファイルへの追加：通常の保存の書き直しで何も失われないファイルだけ（それ以外は追加で内容が失われうる）", () => {
  const a = memory("m1", { createdAt: "2026-10-20T08:00:00.000Z" }), b = memory("m2", { createdAt: "2026-10-20T09:00:00.000Z" });
  const normal = markdown.serializeMemoryDayFile([a, b]);
  assert.equal(repair.dayFileRoundTrips(normal), true);
  assert.equal(repair.dayFileRoundTrips(""), true);
  assert.equal(repair.dayFileRoundTrips(markdown.serializeMemoryDayFile([b, a])), true, "a different order loses nothing");
  assert.equal(repair.dayFileRoundTrips(normal.replace("tsumugi: true", "tsumugi: true\nmyNote: 架空のメモ")), false, "an unknown frontmatter key would be dropped");
  assert.equal(repair.dayFileRoundTrips(normal.replace("## Summary", "手で書き足した架空のメモ\n\n## Summary")), false, "text outside the summary would be dropped");
  assert.equal(repair.dayFileRoundTrips(normal + markdown.MEMORY_ENTRY_SEPARATOR + "---\ntitle: 架空\n---\n本文"), false, "an unparseable entry would be dropped");
  assert.equal(repair.dayFileRoundTrips("---\ntitle: 架空\n---\n本文"), false);
  const inferred = markdown.memoryObjectToMarkdown(markdown.parseMemoryObjectMarkdown(markdown.memoryObjectToMarkdown(a))!).match(/^sourceType: .*$/m)![0];
  assert.equal(repair.dayFileRoundTrips(markdown.memoryObjectToMarkdown(a).replace("## Summary", `${inferred}\n\n## Summary`)), false, "a body line equal to a generated default is still lost");
  assert.equal(repair.dayFileRoundTrips(markdown.memoryObjectToMarkdown(a).replace("架空の内容-m1", "架空の内容-m1\n\n後から書き足した架空の段落")), true, "text in the summary is kept by the rewrite");
});

test("表示：理由ごとの件数と次の操作。本文・IDは出さない", () => {
  for (const text of [...Object.values(repair.SKIP_REASON_TEXT), ...Object.values(repair.NOT_STARTED_TEXT), ...Object.values(repair.NEXT_ACTION_TEXT)]) {
    assert.ok(text.length > 10 && !/[0-9a-f]{8}-|repair-test/.test(text));
  }
  assert.match(repair.NEXT_ACTION_TEXT.needsChoice, /自動で決めません/);
  assert.match(repair.OPFS_REPAIR_NOTE, /ブラウザのデータ消去/);
});

test("自動修復のコードは記録・保存先のファイルを削除しない（記録の削除・ファイルの削除・上書き保存のAPIを呼ばない）", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  for (const file of ["src/lib/vaultAutoRepair.ts", "src/lib/vaultAutoRepairRun.ts"]) {
    const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/removeEntry|\.delete\(|deleteMemory|deleteConversation|deleteSource|putMemoryObject|putConversation|saveSource|createWritable|writeFile/.test(src), file);
  }
});
