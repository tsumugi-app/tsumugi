/**
 * 保存先の汎用修復 段階3：自動修復（通常ユーザーの「修復する」）。
 *
 *   確認（READ ONLY・保存処理と重ならない確定した走査）→ 対象（`ConsistencyReport.repairTargets`。分類は件数・日付・ファイル名に依存しない規則だけ）
 *   → バックアップ（端末＋保存先の全体。作成時に読み戻して照合済み：vaultBackup.ts）
 *   → world lockの排他区間（他タブの保存・修復・Vault切替と重ならない）で：
 *        1. バックアップをもう一度読み直して照合する（`.verified.json`があるだけでは成功としない：ZIPのSHA-256・大きさ・中身・印の中身）
 *        2. 対象ごとに、今の端末の版と、書き換えうる保存先のファイルが、バックアップに入っているものと同じかを確かめる（違えば今回は直さない）
 *        3. apply（既存の復旧：journal・compare-and-set・冪等）と、resave（記録は変えずOutboxを保存待ちに戻す）
 *   → 通常の保存処理を1回流す（resaveの書き込みは、通常の保存と同じ書き手・同じ確認で行う）
 *   → 同じ規則でもう一度確認し、その結果だけを表示する（問題が残っていれば「最新の状態です」と言わない）
 *
 * データ保護：
 *   - 記録の削除・保存先のファイルの削除は一切しない。新旧を規則で決められない記録（内容が違う・形式を読めない・原因不明）は対象にしない。
 *   - 修復の各段階は「今の状態がXならYにする」で、何度実行しても同じ結果（中断しても、もう一度押せば同じ規則で続きを判定する）。
 *   - 対象にしなかった記録・直せなかった記録は、理由ごとの件数と、次に取れる操作として返す。
 */
import { readZipEntries } from "./zip";
import { BACKUP_DIR, sha256Hex, verifyBackupZip, type BackupFailureReason, type BackupResult } from "./vaultBackup";
import type { ConsistencyCategory, ConsistencyReport, RepairTarget } from "./vaultConsistency";

/** 今回は直さなかった理由（データは変えずに残る）。 */
export type AutoRepairSkipReason =
  | "changed-since-backup" // バックアップの後に記録・ファイルが変わった（バックアップに入っていない版は書き換えない）
  | "record-missing" // 端末に記録が無い
  | "tombstoned" // 削除済み
  | "unreadable" // 保存先のファイルを読めない
  | "day-file-not-mergeable" // 同じ日のファイルに、他の内容を保ったまま追加できる見込みが無い（日別ファイルとして読めない・この記録が手で書き換えられている）
  | "repair-in-progress" // 別の修復・復旧の途中
  | "apply-failed"; // 既存の復旧で、書いた後の確認ができなかった（元のデータは保持）

export interface AutoRepairTargetInspection {
  /** 端末の今の版（`updatedAt`）。記録が無ければnull */
  version: string | null;
  /** この修復で書き換えうる保存先の既存ファイル（Vault rootからのパス）。新規作成だけ・管理情報だけの修復では空 */
  paths: string[];
  /** 規則で安全と言えないため対象にしない理由（なければnull） */
  blocked: AutoRepairSkipReason | null;
}

export type RequeueResult = "queued" | "already-pending" | "record-missing" | "tombstoned" | "changed" | "repair-in-progress";

export interface AutoRepairEnv {
  /** 確定するまで有限回やり直す整合性確認（READ ONLY） */
  check(): Promise<ConsistencyReport>;
  /** バックアップの作成（作成時に読み戻して照合する） */
  createBackup(): Promise<BackupResult>;
  /** world lockの排他区間。取れなければ`{ ok: false }` */
  withExclusive<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }>;
  /** 保存先のファイルを読む（無ければnull・読めなければ"unreadable"） */
  readVaultFile(path: string): Promise<Uint8Array | null | "unreadable">;
  inspectTarget(target: RepairTarget): Promise<AutoRepairTargetInspection>;
  /** 既存の復旧（`applyRecovery`）。この記録IDだけを対象にする。排他区間の中で呼ぶ */
  applyRecovery(recordIds: string[]): Promise<{ status: string; recovered: number; failed: number }>;
  /** 記録は変えず、その版をOutboxの保存待ちにする（`requeueRecordForVault`） */
  requeue(target: RepairTarget, expectedVersion: string): Promise<RequeueResult>;
  /** 保存待ちに戻した記録だけを、通常の保存と同じ処理・同じロックで保存先へ書き出す（他の記録は書かない：飛ばした記録を書き出さないため） */
  settleSaves(targets: RepairTarget[]): Promise<void>;
  isCancelled(): boolean;
}

export type AutoRepairNotStarted =
  | "unsettled" // 保存中で確認を確定できなかった
  | "backup-failed" // バックアップを作れなかった
  | "backup-unverified" // 修復の直前に、バックアップを読み直して照合できなかった
  | "busy" // 他の操作（別タブの修復・Vault切替等）が実行中
  | "cancelled";

export interface AutoRepairSkipped { reason: AutoRepairSkipReason; recordType: RepairTarget["recordType"]; count: number }

export type AutoRepairOutcome =
  | { kind: "nothing-to-do"; after: ConsistencyReport }
  | { kind: "not-started"; reason: AutoRepairNotStarted; backupFailure?: BackupFailureReason; after: ConsistencyReport | null }
  | {
      kind: "ran";
      backup: { runId: string; path: string };
      /** 修復を試みた記録の数（apply＋resave） */
      attempted: number;
      /** 試みた記録のうち、もう一度確認したときに問題が無くなっていた数 */
      repaired: number;
      skipped: AutoRepairSkipped[];
      /** 修復後にもう一度確認した結果（表示はこれだけに基づく） */
      after: ConsistencyReport;
    };

const targetKey = (t: { recordType: string; recordId: string }) => `${t.recordType === "reflection" ? "memory" : t.recordType}:${t.recordId}`;

/** バックアップの中の端末の記録の版（`recordType:id`→`updatedAt`）。store名は書かず、manifestの順に読む */
const DEVICE_RECORD_FILES: Record<string, RepairTarget["recordType"]> = { "device/conversations.json": "conversation", "device/sources.json": "source" };

export interface VerifiedBackupContent {
  /** `conversation:id` / `memory:id` / `source:id` → updatedAt */
  versions: Map<string, string>;
  /** 保存先のパス → SHA-256 */
  vaultSha: Map<string, string>;
}

/**
 * 修復の直前に、保存先にあるバックアップを読み直して照合する（`.verified.json`の有無ではなく中身で判定する）：
 * ZIPが作成時と同じ大きさ・SHA-256で、ZIPとして壊れておらず中身が照合でき、`.verified.json`がそのZIPを指していること。
 */
export async function reverifyBackup(
  read: (path: string) => Promise<Uint8Array | null | "unreadable">,
  backup: { runId: string; size: number; sha256: string }
): Promise<{ ok: true; content: VerifiedBackupContent } | { ok: false; reason: "missing" | "changed" | "corrupt" | "marker-mismatch" }> {
  const zip = await read(`${BACKUP_DIR}/${backup.runId}.zip`);
  if (zip === null || zip === "unreadable") return { ok: false, reason: "missing" };
  if (zip.byteLength !== backup.size || (await sha256Hex(zip)) !== backup.sha256) return { ok: false, reason: "changed" };
  const verified = await verifyBackupZip(zip);
  if (!verified.ok || verified.manifest.runId !== backup.runId) return { ok: false, reason: "corrupt" };
  const markerBytes = await read(`${BACKUP_DIR}/${backup.runId}.verified.json`);
  if (markerBytes === null || markerBytes === "unreadable") return { ok: false, reason: "marker-mismatch" };
  let marker: unknown;
  try { marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(markerBytes)); } catch { return { ok: false, reason: "marker-mismatch" }; }
  const m = marker as { runId?: unknown; zip?: unknown; size?: unknown; sha256?: unknown };
  if (m.runId !== backup.runId || m.zip !== `${backup.runId}.zip` || m.size !== backup.size || m.sha256 !== backup.sha256) return { ok: false, reason: "marker-mismatch" };

  const versions = new Map<string, string>();
  const files = new Map(readZipEntries(zip).map((e) => [e.path, e.data]));
  const memoryFile = verified.manifest.device.stores[Object.keys(verified.manifest.device.stores).find((name) => /^memory/i.test(name)) ?? ""]?.path;
  const sources: [string, RepairTarget["recordType"]][] = [...Object.entries(DEVICE_RECORD_FILES), ...(memoryFile ? [[memoryFile, "memory"] as [string, RepairTarget["recordType"]]] : [])];
  for (const [path, type] of sources) {
    const data = files.get(path);
    if (!data) return { ok: false, reason: "corrupt" };
    const rows = JSON.parse(new TextDecoder().decode(data)) as { value?: { id?: unknown; updatedAt?: unknown } }[];
    for (const row of rows) {
      if (typeof row.value?.id === "string" && typeof row.value.updatedAt === "string") versions.set(targetKey({ recordType: type, recordId: row.value.id }), row.value.updatedAt);
    }
  }
  const vaultSha = new Map(verified.manifest.entries.filter((e) => e.path.startsWith("vault/")).map((e) => [e.path.slice("vault/".length), e.sha256]));
  return { ok: true, content: { versions, vaultSha } };
}


const addSkip = (list: AutoRepairSkipped[], reason: AutoRepairSkipReason, recordType: RepairTarget["recordType"], count = 1) => {
  const found = list.find((s) => s.reason === reason && s.recordType === recordType);
  if (found) found.count += count; else list.push({ reason, recordType, count });
};

/** 自動修復の本体。何度実行しても同じ規則で判定する（冪等）。 */
export async function runVaultAutoRepair(env: AutoRepairEnv): Promise<AutoRepairOutcome> {
  const before = await env.check();
  if (before.state === "unsettled") return { kind: "not-started", reason: "unsettled", after: before };
  const targets = before.repairTargets;
  if (targets.length === 0) return { kind: "nothing-to-do", after: before };
  if (env.isCancelled()) return { kind: "not-started", reason: "cancelled", after: before };

  const backup = await env.createBackup();
  if (!backup.ok) return { kind: "not-started", reason: "backup-failed", backupFailure: backup.reason, after: before };
  if (env.isCancelled()) return { kind: "not-started", reason: "cancelled", after: before };

  type Ran = { kind: "ran"; attempted: RepairTarget[]; skipped: AutoRepairSkipped[]; resaved: RepairTarget[] } | { kind: "backup-unverified" } | { kind: "cancelled" };
  const locked = await env.withExclusive<Ran>(async () => {
    const verified = await reverifyBackup((p) => env.readVaultFile(p), backup);
    if (!verified.ok) return { kind: "backup-unverified" };
    if (env.isCancelled()) return { kind: "cancelled" };
    const skipped: AutoRepairSkipped[] = [];
    const apply: { target: RepairTarget; version: string }[] = [];
    const resave: { target: RepairTarget; version: string }[] = [];
    for (const target of targets) {
      const seen = await env.inspectTarget(target);
      if (seen.version === null) { addSkip(skipped, "record-missing", target.recordType); continue; }
      if (seen.blocked) { addSkip(skipped, seen.blocked, target.recordType); continue; }
      // バックアップに入っている版と同じものだけを修復する（その後に変わった版は、バックアップが無いまま書き換えない）
      if (verified.content.versions.get(targetKey(target)) !== seen.version) { addSkip(skipped, "changed-since-backup", target.recordType); continue; }
      let covered: AutoRepairSkipReason | null = null;
      for (const path of seen.paths) {
        const now = await env.readVaultFile(path);
        if (now === "unreadable") { covered = "unreadable"; break; }
        const sha = now === null ? undefined : await sha256Hex(now);
        if (sha !== verified.content.vaultSha.get(path)) { covered = "changed-since-backup"; break; }
      }
      if (covered) { addSkip(skipped, covered, target.recordType); continue; }
      (target.action === "apply" ? apply : resave).push({ target, version: seen.version });
    }
    const attempted: RepairTarget[] = [];
    if (apply.length > 0) {
      const result = await env.applyRecovery(apply.map((a) => a.target.recordId));
      if (result.status === "completed" || result.status === "nothing-to-do") attempted.push(...apply.map((a) => a.target));
      else for (const a of apply) addSkip(skipped, result.status === "interrupted" ? "repair-in-progress" : "apply-failed", a.target.recordType);
    }
    const resaved: RepairTarget[] = [];
    for (const r of resave) {
      const result = await env.requeue(r.target, r.version);
      if (result === "queued" || result === "already-pending") { attempted.push(r.target); resaved.push(r.target); }
      else addSkip(skipped, result === "changed" ? "changed-since-backup" : result, r.target.recordType);
    }
    return { kind: "ran", attempted, skipped, resaved };
  });
  if (!locked.ok) return { kind: "not-started", reason: "busy", after: before };
  const ran = locked.value;
  if (ran.kind === "backup-unverified") return { kind: "not-started", reason: "backup-unverified", after: before };
  if (ran.kind === "cancelled") return { kind: "not-started", reason: "cancelled", after: before };

  // resaveの書き込みは通常の保存処理が行う（排他区間の外。通常の保存と同じロック・同じ確認）
  if (ran.resaved.length > 0) await env.settleSaves(ran.resaved);
  const after = await env.check();
  const remaining = new Set(after.findings.filter((f) => f.recordId !== undefined).map((f) => targetKey({ recordType: f.recordType, recordId: f.recordId as string })));
  const repaired = ran.attempted.filter((t) => !remaining.has(targetKey(t))).length;
  return { kind: "ran", backup: { runId: backup.runId, path: backup.path }, attempted: ran.attempted.length, repaired, skipped: ran.skipped, after };
}

// ---------------------------------------------------------------------------
// 表示（件数・種類・理由・次の操作だけ。本文・IDは出さない）
// ---------------------------------------------------------------------------

const TYPE_TEXT: Record<RepairTarget["recordType"], string> = { conversation: "会話", memory: "記録", reflection: "振り返り", source: "資料" };

export const SKIP_REASON_TEXT: Record<AutoRepairSkipReason, string> = {
  "changed-since-backup": "バックアップの後に内容が変わったため、今回は直していません。もう一度「修復する」を押すと、新しいバックアップを作ってから直します",
  "record-missing": "端末に記録が見つからないため、直していません",
  tombstoned: "削除済みの記録のため、直していません",
  unreadable: "保存先のファイルを読めなかったため、直していません。時間をおいてもう一度お試しください",
  "day-file-not-mergeable": "同じ日のファイルを日別のファイルとして読めない、またはこの記録が手で書き換えられているため、追加していません。両方とも変更せず保持しています",
  "repair-in-progress": "別の修復の途中のため、直していません。「続きを完了する」の後にもう一度お試しください",
  "apply-failed": "書き込んだ後の確認ができなかったため、直したことにしていません。元のデータは保持しています。もう一度「修復する」を押すと、続きから確認します",
};

export const NOT_STARTED_TEXT: Record<AutoRepairNotStarted, string> = {
  unsettled: "保存中のため、修復を始めませんでした。少し後にもう一度「修復する」を押してください。",
  "backup-failed": "修復の前のバックアップを作れなかったため、修復を始めませんでした。何も変更していません。",
  "backup-unverified": "修復の直前にバックアップを読み直して確認できなかったため、修復を始めませんでした。何も変更していません。",
  busy: "他の操作が実行中のため、修復を始めませんでした。しばらくしてからもう一度お試しください。",
  cancelled: "修復を中止しました。何も変更していません。",
};

/** 残った記録の種類ごとの、次に取れる操作 */
export const NEXT_ACTION_TEXT: Record<ConsistencyCategory, string> = {
  saving: "自動で保存されます。少し後に「もう一度確認する」で確かめられます。",
  repairable: "もう一度「修復する」を押すと、同じ規則で続きを直します。",
  repairLater: "今のバージョンでは自動で直せません。データは保持しています。「バックアップを作成」で退避できます。",
  needsChoice: "どちらを残すかは自動で決めません。両方の版を保持しています。「バックアップを作成」で両方を退避できます。",
  retryable: "時間をおいて「もう一度確認する」を押してください。",
  unknown: "データは保持しています。「バックアップを作成」で退避できます。",
};

export const OPFS_REPAIR_NOTE = "「修復する」は、始める前に端末と保存先の全体をバックアップします。この端末では、そのバックアップもアプリ内の領域に置かれ、ブラウザのデータ消去やアプリの削除で一緒に消えます。備えるには「バックアップを作成」から端末の外にも書き出してください。";
export const OPFS_BACKUP_WARNING = "修復前のバックアップは、この端末のアプリ内の領域に保存しています。ブラウザのデータ消去やアプリの削除で一緒に消えるため、それだけでは備えになりません。「バックアップを作成」から端末の外にも書き出してください。";

export interface AutoRepairOutcomeView {
  headline: string;
  lines: string[];
  /** この端末の領域だけに保存したバックアップ（Android等のOPFS）の注意 */
  warning: string | null;
  /** 修復の後もう一度確認した結果、問題が無い（この時だけ「最新」と言ってよい） */
  clean: boolean;
}

export function autoRepairOutcomeView(outcome: AutoRepairOutcome, backend: string | null): AutoRepairOutcomeView {
  const warning = outcome.kind === "ran" && backend === "opfs" ? OPFS_BACKUP_WARNING : null;
  if (outcome.kind === "not-started") return { headline: NOT_STARTED_TEXT[outcome.reason], lines: [], warning: null, clean: false };
  if (outcome.kind === "nothing-to-do") {
    return { headline: outcome.after.state === "clean" ? "直す必要のある記録はありませんでした。" : "今のバージョンで自動で直せる記録はありませんでした。", lines: [], warning: null, clean: outcome.after.state === "clean" };
  }
  const left = outcome.after.findings.length;
  const clean = outcome.after.state === "clean";
  const headline = clean
    ? `${outcome.repaired}件を修復し、もう一度確認して問題が無いことを確かめました。`
    : `${outcome.repaired}件を修復しました。${left}件は残っています。`;
  const lines = outcome.skipped.map((s) => `${TYPE_TEXT[s.recordType]} ${s.count}件：${SKIP_REASON_TEXT[s.reason]}`);
  if (outcome.attempted > outcome.repaired) lines.push(`${outcome.attempted - outcome.repaired}件は修復を試みましたが、確認し直すとまだ問題が残っています（下の内訳を参照）。`);
  lines.push(`修復の前に、端末と保存先の全体をバックアップし、読み戻して確認しました（${outcome.backup.path}）。`);
  return { headline, lines, warning, clean };
}
