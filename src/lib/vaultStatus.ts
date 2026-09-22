/**
 * Settings「保存先」の統合表示（ユーザー向けの入口の統合）。
 *
 * ユーザーに見せる基本形は「✓ 最新の状態です」か「外部の変更がある可能性があります［確認する］」の2つ。
 * 「確認する」を押した後だけ、実際に必要な対応を、意味で説明する：
 *   保存先に新しい記録／この端末にまだ保存されていない記録 ［内容を確認］［更新する］
 *   整理できる古い管理情報 ［内容を確認］［整理する］
 *   確認が必要な記録（勝手に変更せず、理由と対象だけを表示）
 * 方向（保存先→端末／端末→保存先）はユーザーに判断させない。「内容を確認」で、何が保存先側から
 * 端末へ反映され、何が端末側から保存先へ追加されるかを確認できる。
 *
 * 【このモジュールの責務】内部処理の統合ではなく、入口の統合。既存の処理を、そのままの意味で順に呼ぶ：
 *   light-check（Level 1〜4）／Vault→IDBの追加専用復元（`vaultRestore.ts`）／旧形式の整理
 *   （`vaultLegacyCleanup.ts`）／IDB→Vaultの追加（`vaultAppendLocal.ts`）／本体が見つからない記録の整理
 *   （`vaultOrphanCleanup.ts`）。それぞれのロジック・Registry・baseline・書き込みゲートは変更しない。
 *
 * 【「最新の状態です」の導出】単なるUI上のidleではなく、次が全て「測定済みで未解決が0」であることから導く：
 *   接続済み／外部変更の確認（Level 1/2が完走し、候補があればLevel 3まで分類）／flush測定済みでHOLD 0／
 *   RegistryとIDBの必要な差（保存先の記録が端末に無い）0／Registryにmissing・conflict・needs-resyncが無い／
 *   操作中ではない。「未測定」と「測定済みで0件」は必ず区別する（`null`＝未測定）。
 *   測定のタイミングは、起動時・保存先の接続／変更時・保存先関連の操作の実行後（呼び出し元が決める）。
 *   Settingsを開くたびの再走査はしない。
 */
"use client";

import { getAllConversations, getAllMemoryObjects, getAllSources } from "./db";
import { jstDateOf } from "./dateModel";
import {
  applyVaultLightCheckCandidates,
  classifyVaultLightCheckCandidates,
  countVaultLightCheckCandidates,
  performVaultLightCheckDiscovery,
  readVaultRegistrySnapshotStrict,
} from "./vault";
import type {
  VaultLightCheckClassifyResult,
  VaultLightCheckDiscoveryResult,
  VaultResyncRecordResult,
} from "./vault";
import { executeLegacyCleanup, planLegacyCleanup } from "./vaultLegacyCleanup";
import type { LegacyCleanupPlan, LegacyCleanupResult } from "./vaultLegacyCleanup";
import { appendLocalRecordsToVault, planAppendLocalRecords } from "./vaultAppendLocal";
import type { AppendLocalResult, LocalOnlyPlan } from "./vaultAppendLocal";
import { executeOrphanCleanup, planOrphanCleanup } from "./vaultOrphanCleanup";
import type { OrphanCleanupResult, OrphanPlan } from "./vaultOrphanCleanup";
import { planVaultRestore, restoreMissingRecordsFromVault } from "./vaultRestore";
import type { VaultRestorePlan, VaultRestoreResult } from "./vaultRestore";
import { runVaultWorldExclusive, withVaultWorldRead } from "./vaultWorldLock";

/** 起動時のLevel 3自動分類を行う候補数の上限。これを超える場合は自動分類せず「確認する」にする。 */
export const VAULT_STATUS_AUTO_CLASSIFY_LIMIT = 30;

// ---------------------------------------------------------------------------
// 測定（軽い・読み取りのみ）
// ---------------------------------------------------------------------------

export type LightCheckCounts = VaultLightCheckClassifyResult["counts"];

/** light-checkの測定結果。`counts`がnullなら「候補はあるが、まだ分類していない」（未測定）。 */
export interface LightCheckMeasure {
  candidateCount: number;
  /** Level 2（path列挙）が最後まで完走したか。 */
  level2Completed: boolean;
  /** Level 1で権限・I/Oエラー等により確認できなかった既知pathの数（存在しないとは断定できない）。 */
  readFailed: number;
  /** Level 3の分類結果（候補0件なら全て0）。分類していなければnull。 */
  counts: LightCheckCounts | null;
}

export const EMPTY_LIGHT_CHECK_COUNTS: LightCheckCounts = {
  unchanged: 0,
  moved: 0,
  edited: 0,
  added: 0,
  missing: 0,
  conflict: 0,
  unreadable: 0,
};

/** discoveryと（あれば）分類結果から、測定結果を作る（純粋関数）。 */
export function lightCheckMeasureFrom(
  discovery: VaultLightCheckDiscoveryResult,
  counts: LightCheckCounts | null
): LightCheckMeasure {
  const candidateCount = countVaultLightCheckCandidates(discovery);
  const nothingToClassify = candidateCount === 0 && discovery.readFailedCandidates.length === 0;
  return {
    candidateCount,
    level2Completed: discovery.level2Completed,
    readFailed: discovery.readFailedCandidates.length,
    counts: nothingToClassify ? { ...EMPTY_LIGHT_CHECK_COUNTS } : counts,
  };
}

export function isLightCheckMeasured(measure: LightCheckMeasure | null): boolean {
  return measure !== null && measure.level2Completed && measure.readFailed === 0 && measure.counts !== null;
}

/** 反映・整理・確認が必要な項目の数（`unchanged`は含まない）。 */
export function unresolvedLightCheckCount(counts: LightCheckCounts): number {
  return counts.added + counts.edited + counts.moved + counts.missing + counts.conflict + counts.unreadable;
}

export interface RegistryProblem {
  key: string;
  kind: string;
  /** `missing` / `conflict` / `needs-resync`。 */
  status: string;
}

/** 保存先（Registry）に記録があり、この端末（IndexedDB）に無い記録の数。 */
export interface RegistryIdbDiff {
  /** Registryを最後まで読めたか。falseなら差を確認できていない（未測定）。 */
  completed: boolean;
  vaultOnly: { conversations: number; memories: number; sources: number; total: number };
  /** Registryのstatusが`ok`ではない記録（missing／conflict／needs-resync）。 */
  problems: RegistryProblem[];
}

/**
 * RegistryとIndexedDBの「必要な差」を数える（読み取りのみ。保存先の全走査はしない）。
 * 「必要な差」＝保存先に記録があるのに、この端末に無いもの（＝端末へ反映が必要）。逆方向（端末にあって
 * 保存先に無い記録）は、flushの台帳（vaultSyncState）が測る（HOLD）ため、ここでは数えない——旧backendの
 * 記録が同期済みとして端末に残る設計（Android）を、未解決と誤認しないため。
 */
export async function computeRegistryIdbDiff(root: FileSystemDirectoryHandle): Promise<RegistryIdbDiff> {
  const snapshot = await readVaultRegistrySnapshotStrict(root);
  const diff: RegistryIdbDiff = {
    completed: snapshot.completed,
    vaultOnly: { conversations: 0, memories: 0, sources: 0, total: 0 },
    problems: [],
  };
  if (!snapshot.completed) return diff;
  const [conversations, memories, sources] = await Promise.all([getAllConversations(), getAllMemoryObjects(), getAllSources()]);
  const conversationIds = new Set(conversations.map((c) => c.id));
  const memoryIds = new Set(memories.map((m) => m.id));
  const sourceIds = new Set(sources.map((s) => s.id));
  for (const [key, path] of snapshot.records) {
    const entry = snapshot.files.get(path);
    if (!entry) continue;
    if (entry.status !== "ok") {
      diff.problems.push({ key, kind: entry.recordType, status: entry.status });
      continue;
    }
    if (entry.recordType === "conversation") {
      if (!conversationIds.has(key)) diff.vaultOnly.conversations += 1;
    } else if (entry.recordType === "source") {
      if (!sourceIds.has(key)) diff.vaultOnly.sources += 1;
    } else if (entry.recordType === "reflection") {
      if (!memoryIds.has(key)) diff.vaultOnly.memories += 1;
    } else {
      for (const id of entry.memberIds) if (!memoryIds.has(id)) diff.vaultOnly.memories += 1;
    }
  }
  diff.vaultOnly.total = diff.vaultOnly.conversations + diff.vaultOnly.memories + diff.vaultOnly.sources;
  return diff;
}

// ---------------------------------------------------------------------------
// 統合表示の導出（純粋関数）
// ---------------------------------------------------------------------------

export interface VaultStatusInputs {
  /** 保存先が接続済みで、切替中・stale・incompleteではない。 */
  connected: boolean;
  /** 測定・確認・更新・整理・flush等が進行中。 */
  busy: boolean;
  lightCheck: LightCheckMeasure | null;
  diff: RegistryIdbDiff | null;
  /** flushの測定結果。`measured: false`は未測定（保留0件の測定結果とは別）。 */
  hold: { measured: boolean; count: number };
  /** 「確認する」の結果（あれば）。測定が更新されたら、呼び出し元がnullに戻す。 */
  findings: VaultStatusFindings | null;
}

export type VaultStatusView =
  | { kind: "hidden" }
  | { kind: "checking" }
  | { kind: "latest" }
  /** 未測定、または測定で未解決があり、まだ「確認する」を押していない。 */
  | { kind: "maybe"; reason: "unmeasured" | "changes" | "local" }
  /** 「確認する」の結果。 */
  | { kind: "review"; hasUpdate: boolean; hasCleanup: boolean; hasAttention: boolean };

/** 測定が全て済んでいるか（「最新」と判断できる前提）。 */
export function isVaultStatusMeasured(inputs: Pick<VaultStatusInputs, "lightCheck" | "diff" | "hold">): boolean {
  return isLightCheckMeasured(inputs.lightCheck) && inputs.diff !== null && inputs.diff.completed && inputs.hold.measured;
}

function vaultSideUnresolved(inputs: Pick<VaultStatusInputs, "lightCheck" | "diff">): number {
  return (
    (inputs.lightCheck?.counts ? unresolvedLightCheckCount(inputs.lightCheck.counts) : 0) +
    (inputs.diff ? inputs.diff.vaultOnly.total + inputs.diff.problems.length : 0)
  );
}

/** 測定結果に、未解決の項目がいくつあるか（測定済みの場合のみ意味を持つ）。 */
export function countUnresolved(inputs: Pick<VaultStatusInputs, "lightCheck" | "diff" | "hold">): number {
  return vaultSideUnresolved(inputs) + inputs.hold.count;
}

export function deriveVaultStatusView(inputs: VaultStatusInputs): VaultStatusView {
  if (!inputs.connected) return { kind: "hidden" };
  if (inputs.busy) return { kind: "checking" };
  if (!isVaultStatusMeasured(inputs)) return { kind: "maybe", reason: "unmeasured" };
  const unresolved = countUnresolved(inputs);
  if (inputs.findings) {
    const f = inputs.findings;
    if (unresolved === 0 && !f.hasUpdate && !f.hasCleanup && !f.hasAttention) return { kind: "latest" };
    return { kind: "review", hasUpdate: f.hasUpdate, hasCleanup: f.hasCleanup, hasAttention: f.hasAttention };
  }
  if (unresolved === 0) return { kind: "latest" };
  return { kind: "maybe", reason: vaultSideUnresolved(inputs) === 0 ? "local" : "changes" };
}

// ---------------------------------------------------------------------------
// 「確認する」（既存のdry-runを順に実行する。全て読み取りのみ）
// ---------------------------------------------------------------------------

export interface VaultStatusDetailGroup {
  /** 見出し（例：「保存先から、この端末へ反映されます」）。 */
  heading: string;
  lines: string[];
}

export interface VaultStatusFindings {
  lightCheck: { measure: LightCheckMeasure; discovery: VaultLightCheckDiscoveryResult; result: VaultLightCheckClassifyResult };
  diff: RegistryIdbDiff;
  restorePlan: VaultRestorePlan | null;
  appendPlan: LocalOnlyPlan;
  orphanPlan: OrphanPlan;
  legacyPlan: LegacyCleanupPlan | null;
  /** 「更新する」で適用できるlight-checkの記録（追加・編集・移動）。 */
  updatableRecords: VaultResyncRecordResult[];
  /** 本体が無く、端末にも記録が無い（整理の候補）light-checkの記録（`missing`）。 */
  missingCleanupRecords: VaultResyncRecordResult[];
  /** 表示用の1行の要約（例：「保存先に新しい記録が2件あります」）。 */
  summary: string[];
  /** 「内容を確認」で表示する内訳。 */
  details: VaultStatusDetailGroup[];
  /** 確認が必要な記録（理由と対象）。 */
  attention: string[];
  hasUpdate: boolean;
  hasCleanup: boolean;
  hasAttention: boolean;
  /** この結果から得た測定（呼び出し元が測定状態へ反映する）。 */
  measure: { lightCheck: LightCheckMeasure; diff: RegistryIdbDiff; holdCount: number };
}

function clipLines(lines: string[], limit = 12): string[] {
  return lines.length > limit ? [...lines.slice(0, limit), `…ほか${lines.length - limit}件`] : lines;
}

function recordLabel(record: VaultResyncRecordResult): string {
  return record.currentPath ?? record.previousPath ?? record.registryKey;
}

/**
 * 既存のdry-runを、次の順に実行する（全て読み取りのみ。呼び出し元が`withVaultWorldRead`を保持し、
 * 内部の書き込みが落ち着いた状態で呼ぶこと）：
 *   1. light-check（Level 1/2 → Level 3）  2. RegistryとIDBの差  3. 端末から保存先への追加の計画
 *   4. 本体が見つからない記録の整理の計画  5. 保存先から端末への追加の計画（差があるときだけ。保存先の全走査）
 *   6. 旧形式の整理の計画（重複の疑いがあるときだけ。全ファイルの読み取り）
 * 重い計画（5・6）は、軽い測定（1〜4）で必要と分かったときだけ実行する。
 */
export async function collectVaultStatusFindings(root: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<VaultStatusFindings> {
  const discovery = await performVaultLightCheckDiscovery(root);
  const candidateCount = countVaultLightCheckCandidates(discovery);
  const result: VaultLightCheckClassifyResult =
    candidateCount > 0 || discovery.readFailedCandidates.length > 0
      ? await classifyVaultLightCheckCandidates(root, discovery)
      : { records: [], localSnapshots: new Map(), level2Completed: discovery.level2Completed, counts: { ...EMPTY_LIGHT_CHECK_COUNTS } };
  const measure = lightCheckMeasureFrom(discovery, result.counts);
  const counts = result.counts;

  const diff = await computeRegistryIdbDiff(root);
  const [conversations, memories, sources] = await Promise.all([getAllConversations(), getAllMemoryObjects(), getAllSources()]);
  const idbIds = new Set<string>([...conversations.map((c) => c.id), ...memories.map((m) => m.id), ...sources.map((s) => s.id)]);

  const appendPlan = await planAppendLocalRecords(root, signal);
  const orphanPlan = await planOrphanCleanup(root, signal);

  const restorePlan = diff.completed && diff.vaultOnly.total > 0 ? await planVaultRestore(root, signal) : null;
  const hasRegistryConflict = diff.problems.some((p) => p.status === "conflict");
  const legacyPlan = hasRegistryConflict || counts.conflict > 0 ? await planLegacyCleanup(root) : null;

  const updatableRecords = result.records.filter((r) => r.outcome === "added" || r.outcome === "edited" || r.outcome === "moved");
  const missingRecords = result.records.filter((r) => r.outcome === "missing");
  const missingCleanupRecords = missingRecords.filter((r) => !idbIds.has(r.registryKey) && r.recordType !== "memory-day");
  const missingKept = missingRecords.filter((r) => !missingCleanupRecords.includes(r));

  // --- 「更新する」の内訳（方向で分けず、何が起きるかを意味で説明する） ---
  const fromVault: string[] = [];
  const toVault: string[] = [];
  for (const r of updatableRecords) {
    const what = r.outcome === "added" ? "保存先に新しく見つかった記録" : r.outcome === "edited" ? "保存先で編集された記録" : "保存先で移動された記録";
    fromVault.push(`${what}：${recordLabel(r)}`);
  }
  if (restorePlan) {
    for (const c of restorePlan.conversationsToAdd) fromVault.push(`保存先にあり、この端末にまだ無い会話：${jstDateOf(c.startedAt) ?? c.startedAt.slice(0, 10)}（${c.turns.length}件のやり取り）`);
    for (const m of restorePlan.memoriesToAdd) fromVault.push(`保存先にあり、この端末にまだ無い記憶：${jstDateOf(m.date) ?? m.date.slice(0, 10)}　${m.summary.slice(0, 40)}`);
    for (const s of restorePlan.sourcesToAdd) fromVault.push(`保存先にあり、この端末にまだ無い素材：${s.title}`);
  }
  for (const item of appendPlan.adoptable) toVault.push(`この端末にあり、保存先にまだ無い記録：${item.record.day}　${item.record.title}`);
  const restoreCount = restorePlan
    ? restorePlan.counts.memoriesToAdd + restorePlan.counts.conversationsToAdd + restorePlan.counts.sourcesToAdd
    : 0;

  const summary: string[] = [];
  const fromVaultCount = updatableRecords.length + restoreCount;
  if (fromVaultCount > 0) summary.push(`保存先に新しい記録・変更が${fromVaultCount}件あります`);
  if (appendPlan.adoptable.length > 0) summary.push(`この端末にまだ保存されていない記録が${appendPlan.adoptable.length}件あります`);

  // --- 整理（管理情報だけが残っているもの／旧形式の重複） ---
  const cleanupLines: string[] = [];
  for (const item of orphanPlan.orphans) cleanupLines.push(`本体が見つからず、復元元もない記録：${item.title}（管理情報だけが残っています）`);
  for (const r of missingCleanupRecords) cleanupLines.push(`保存先で本体が見つからず、この端末にも記録がない：${recordLabel(r)}（整理できるか確認します）`);
  const legacyExecutable = legacyPlan !== null && legacyPlan.executable;
  if (legacyPlan && legacyExecutable) {
    const files = legacyPlan.archiveMemoryFiles.length + legacyPlan.archiveConversationCopies.length;
    if (files > 0) cleanupLines.push(`整理できる古い形式のファイル：${files}件（削除せず、退避します）`);
    const restorable = legacyPlan.memoryDays.filter((i) => i.ok).length + legacyPlan.conversations.filter((i) => i.ok).length;
    if (restorable > 0) cleanupLines.push(`確認済みに戻せる記録：${restorable}件`);
    for (const d of legacyPlan.bodyDiffs) cleanupLines.push(`古い形式の記憶（${d.day}）は、内容が新しい形式と異なるため、退避先に残ります`);
    for (const d of legacyPlan.conversationCopyDiffs) cleanupLines.push(`重複した会話のコピー（${d.copyPath}）は、内容が正本と異なるため、退避先に残ります`);
  }
  const hasCleanup = cleanupLines.length > 0;
  if (hasCleanup) summary.push("保存先に整理できる情報があります");

  // --- 確認が必要（勝手に変更せず、理由と対象だけを表示） ---
  const attention: string[] = [];
  for (const item of orphanPlan.others) attention.push(`${item.title}：${item.message}`);
  for (const item of appendPlan.blocked) attention.push(`${item.record.day}　${item.record.title}：${item.block?.message ?? ""}`);
  for (const r of missingKept) attention.push(`保存先で本体が見つかりません（この端末には記録が残っています）：${recordLabel(r)}`);
  if (counts.unreadable > 0) attention.push(`読み込めないファイルが${counts.unreadable}件あります`);
  if (!legacyExecutable) {
    if (counts.conflict > 0) attention.push(`保存先で内容の重複・食い違いが見つかった記録が${counts.conflict}件あります`);
    for (const p of diff.problems) {
      if (p.status === "conflict") attention.push(`保存先で内容の重複・食い違いが見つかっています（${p.key}）`);
    }
  }
  if (legacyPlan && !legacyExecutable) {
    for (const b of legacyPlan.blockers.slice(0, 5)) attention.push(`古い形式のファイルの整理を実行できません：${b}`);
  }
  for (const p of diff.problems) {
    if (p.status === "needs-resync") attention.push(`保存先で、外部での変更の確認が必要な記録があります（${p.key}）`);
    if (p.status === "missing" && p.kind === "memory-day") attention.push(`記憶の日別ファイルが見つかりません（${p.key}）`);
  }
  if (!diff.completed) attention.push("保存先の管理情報を最後まで読み込めなかったため、確認できません。");
  if (restorePlan === null && diff.completed && diff.vaultOnly.total > 0) {
    attention.push("保存先にあってこの端末に無い記録があります（内容を確認できませんでした）");
  }
  if (measure.readFailed > 0) attention.push(`保存先の一部のファイルを確認できませんでした（${measure.readFailed}件）`);
  if (!measure.level2Completed) attention.push("保存先の確認が最後まで完了しませんでした。");
  const uniqueAttention = [...new Set(attention)];
  if (uniqueAttention.length > 0) summary.push("確認が必要な記録があります");

  const details: VaultStatusDetailGroup[] = [];
  if (fromVault.length > 0) details.push({ heading: "保存先から、この端末へ反映されます", lines: clipLines(fromVault) });
  if (toVault.length > 0) details.push({ heading: "この端末から、保存先へ追加されます（元の日時のまま）", lines: clipLines(toVault) });
  if (cleanupLines.length > 0) details.push({ heading: "整理されます（記憶・会話の内容は変更しません）", lines: clipLines(cleanupLines) });
  if (uniqueAttention.length > 0) details.push({ heading: "確認が必要な記録（今回は変更しません）", lines: clipLines(uniqueAttention) });

  const hasUpdate = fromVaultCount > 0 || appendPlan.adoptable.length > 0;
  return {
    lightCheck: { measure, discovery, result },
    diff,
    restorePlan,
    appendPlan,
    orphanPlan,
    legacyPlan,
    updatableRecords,
    missingCleanupRecords,
    summary,
    details,
    attention: uniqueAttention,
    hasUpdate,
    hasCleanup,
    hasAttention: uniqueAttention.length > 0,
    // 端末の保存状況の測定：追加できる記録・確認が必要な記録の数（通常の保存が保留する記録の数）。
    measure: { lightCheck: measure, diff, holdCount: appendPlan.items.length },
  };
}

// ---------------------------------------------------------------------------
// 「更新する」「整理する」（既存の実行処理を、順に、そのままの意味で呼ぶ）
// ---------------------------------------------------------------------------

export interface VaultStatusStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VaultStatusUpdateResult {
  steps: VaultStatusStep[];
  restore: VaultRestoreResult | null;
  append: AppendLocalResult | null;
  /** 保存先の状態が変わった可能性がある（呼び出し元が再計測する）。 */
  changed: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 「更新する」。順序：保存先の外部の変更の反映（light-check Level 4。追加・編集・移動のみ）→
 * 保存先にあってこの端末に無い記録の追加（追加専用の復元）→ この端末にあって保存先に無い記録の追加。
 * 各実行は、既存の処理と同じlock（排他／共有）の中で、実行時に再検証する。1つが失敗しても、他は独立に
 * 続行し、結果を返す（呼び出し元が再計測して、未解決が残っていれば「最新」にはしない）。
 * `withVaultWorldRead`／`runVaultWorldExclusive`を呼び出し元が保持していないこと。
 */
export async function applyVaultStatusUpdate(
  root: FileSystemDirectoryHandle,
  findings: VaultStatusFindings,
  isStale?: () => boolean
): Promise<VaultStatusUpdateResult> {
  const out: VaultStatusUpdateResult = { steps: [], restore: null, append: null, changed: false };

  if (findings.updatableRecords.length > 0) {
    try {
      const outcome = await applyVaultLightCheckCandidates(root, findings.updatableRecords, findings.lightCheck.result.localSnapshots);
      if (outcome.timedOut) {
        out.steps.push({ name: "保存先の変更を反映", ok: false, detail: "他の操作が実行中でした" });
      } else {
        const problems = outcome.applyErrors.length + outcome.staleSkipped.length;
        out.steps.push({ name: "保存先の変更を反映", ok: problems === 0, detail: problems > 0 ? `${problems}件を反映できませんでした` : undefined });
        out.changed = true;
      }
    } catch (error) {
      out.steps.push({ name: "保存先の変更を反映", ok: false, detail: message(error) });
    }
  }

  if (findings.restorePlan && !isStale?.()) {
    try {
      const { result } = await withVaultWorldRead(() => restoreMissingRecordsFromVault(root, isStale));
      out.restore = result;
      out.steps.push({ name: "保存先の記録をこの端末へ反映", ok: !result.interrupted });
      out.changed = out.changed || result.insertedMemories + result.insertedConversations + result.insertedSources > 0;
    } catch (error) {
      out.steps.push({ name: "保存先の記録をこの端末へ反映", ok: false, detail: message(error) });
    }
  }

  if (findings.appendPlan.adoptable.length > 0 && !isStale?.()) {
    const selections = findings.appendPlan.adoptable.map((item) => ({ key: item.record.key, updatedAt: item.record.updatedAt }));
    try {
      const locked = await runVaultWorldExclusive(() => appendLocalRecordsToVault(root, selections, isStale));
      if (locked.timedOut || !locked.result) {
        out.steps.push({ name: "この端末の記録を保存先へ追加", ok: false, detail: "他の操作が実行中でした" });
      } else {
        out.append = locked.result;
        out.steps.push({
          name: "この端末の記録を保存先へ追加",
          ok: locked.result.failedCount + locked.result.skippedCount === 0 && locked.result.status !== "interrupted",
        });
        out.changed = out.changed || locked.result.writtenCount > 0;
      }
    } catch (error) {
      out.steps.push({ name: "この端末の記録を保存先へ追加", ok: false, detail: message(error) });
    }
  }
  return out;
}

export interface VaultStatusCleanupResult {
  steps: VaultStatusStep[];
  orphan: OrphanCleanupResult | null;
  legacy: LegacyCleanupResult | null;
  changed: boolean;
}

/**
 * 「整理する」。順序：（保存先で本体が無くなった記録の管理情報を「見つからない」として記録）→
 * 本体が見つからず復元元も無い記録の整理 → 旧形式ファイルの整理。整理の内容と安全条件は、それぞれの
 * 既存の処理そのまま（実行時に全条件を再検証し、通らない記録は整理しない）。
 */
export async function applyVaultStatusCleanup(
  root: FileSystemDirectoryHandle,
  findings: VaultStatusFindings,
  isStale?: () => boolean
): Promise<VaultStatusCleanupResult> {
  const out: VaultStatusCleanupResult = { steps: [], orphan: null, legacy: null, changed: false };

  if (findings.missingCleanupRecords.length > 0) {
    try {
      const outcome = await applyVaultLightCheckCandidates(root, findings.missingCleanupRecords, findings.lightCheck.result.localSnapshots);
      if (outcome.timedOut) {
        out.steps.push({ name: "本体が無い記録を確認", ok: false, detail: "他の操作が実行中でした" });
      } else {
        out.steps.push({ name: "本体が無い記録を確認", ok: outcome.applyErrors.length + outcome.staleSkipped.length === 0 });
        out.changed = true;
      }
    } catch (error) {
      out.steps.push({ name: "本体が無い記録を確認", ok: false, detail: message(error) });
    }
  }

  if (!isStale?.()) {
    try {
      const plan = await withVaultWorldRead(() => planOrphanCleanup(root));
      if (plan.orphans.length > 0) {
        const keys = plan.orphans.map((i) => i.key);
        const locked = await runVaultWorldExclusive(() => executeOrphanCleanup(root, keys, isStale));
        if (locked.timedOut || !locked.result) {
          out.steps.push({ name: "管理情報だけが残っている記録を整理", ok: false, detail: "他の操作が実行中でした" });
        } else {
          out.orphan = locked.result;
          out.steps.push({ name: "管理情報だけが残っている記録を整理", ok: locked.result.status === "complete" });
          out.changed = out.changed || locked.result.cleanedCount > 0;
        }
      }
    } catch (error) {
      out.steps.push({ name: "管理情報だけが残っている記録を整理", ok: false, detail: message(error) });
    }
  }

  if (findings.legacyPlan?.executable && !isStale?.()) {
    try {
      const locked = await runVaultWorldExclusive(() => executeLegacyCleanup(root, isStale));
      if (locked.timedOut || !locked.result) {
        out.steps.push({ name: "古い形式のファイルを整理", ok: false, detail: "他の操作が実行中でした" });
      } else {
        out.legacy = locked.result;
        out.steps.push({ name: "古い形式のファイルを整理", ok: locked.result.status === "complete" || locked.result.status === "nothing-to-do" });
        out.changed = out.changed || locked.result.archivedNow > 0 || locked.result.memoryDaysCommitted + locked.result.conversationsCommitted > 0;
      }
    } catch (error) {
      out.steps.push({ name: "古い形式のファイルを整理", ok: false, detail: message(error) });
    }
  }
  return out;
}
