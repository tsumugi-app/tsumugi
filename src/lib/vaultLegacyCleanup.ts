/**
 * PC Vaultに残った「旧形式の重複ファイル」の整理（退避＋Registry再確定）を、1つの安全な
 * フローとして行う。
 *
 * 背景：Memoryは通常`Memories/YYYY-MM-DD.md`（day-file）に統合されるが、過去には1record=
 * 1file（`Memories/YYYY-MM-DD-xxxxxx.md`）で保存されていた。同じMemoryが旧形式ファイルと
 * day-fileの両方にあると、Registryは同じday keyを2つのpathが主張していると判断して
 * `conflict`にする。conflictは軽量チェック・「変更を反映」・full resyncのいずれでも
 * 自動では`ok`に戻らない（意図した設計）。同様にConversationにも、Obsidian等が作った
 * 重複コピー（`xxx+.md`）がある。
 *
 * このモジュールは次の順序で処理する（dry-runは1〜3のみ、読み取り専用）：
 *   1. Vault・Registry・IndexedDB・archiveの状態を読み取る（snapshot）
 *   2. 全対象・全前提条件を検証する（`computeLegacyCleanupPlan`。純粋関数）
 *   3. 実行計画（件数・検証結果・実行後の予測）を返す（`planLegacyCleanup`）
 *   4. ユーザーが明示的に実行した場合のみ`executeLegacyCleanup`が次を行う：
 *      A. 旧形式ファイルを隠しarchiveへコピーし、SHA-256で一致を検証する
 *      B. 元pathとSHA-256を記録したmanifestをarchiveへ保存する
 *      C. 元ファイルを（コピーとSHA-256一致を再確認した上で）取り除く＝退避
 *      D. 実際のVaultを読み直し、検証に通ったmemory-day/conversationだけをRegistry `ok`へ再確定
 *      E. post-check
 *
 * 【安全方針】
 * - 削除はしない。元ファイルは、byte単位で同一と確認したarchiveコピーとmanifestが揃った後にだけ
 *   取り除く（＝退避。archiveから元のpathへ戻せる）。
 * - Memory/Conversation/Sourceの本文、IndexedDB、vaultSyncState、baseline（`baselineEstablishedAt`）、
 *   History Indexは一切変更しない。Reflectionのファイルも対象外。
 * - Registryへ書くのは、既存の`commitVaultRegistry*Ok`（通常のresync applyと同じ書き込み）だけ。
 *   C1のwrite gate・軽量チェックの判定ロジックには触れない。
 *
 * 【中間状態と再実行（idempotent）】
 * 完全なファイルシステムtransactionは無いため、各ステップを「もう済んでいれば何もしない」形にし、
 * どの時点で失敗・中断しても同じcleanupを再実行すれば安全に完了するようにしている：
 * - archiveコピー：既にarchiveに同一SHA-256のコピーがあれば再コピーしない。SHA-256が異なる場合は
 *   上書きせず、そのファイルを対象外（blocker）にする。
 * - manifest：元pathをkeyにマージする（既存entryは書き換えない）。
 * - 元ファイルの取り除き：既に無ければ済み扱い。archiveのSHA-256と一致しないときは取り除かない。
 * - Registry再確定：既に`ok`のkeyは対象から外れる。「退避だけ済んでRegistryが未確定」の状態でも、
 *   manifestに記録された退避（day/id）を根拠に、同じ検証を経て再確定できる。
 * 呼び出し元がworld lockを保持している前提（dry-runは`withVaultWorldRead`、実行は
 * `runVaultWorldExclusive`）。
 */
"use client";

import { writeFileHandleContent } from "./vaultWriter";
import { getAllConversations, getAllMemoryObjects, getAllSources } from "./db";
import { parseConversationMarkdown, parseMemoryDayFile, memoryObjectToMarkdown } from "./markdown";
import {
  VAULT_REGISTRY_BUCKET_COUNT,
  commitVaultRegistryMemoryDayOk,
  commitVaultRegistrySingleRecordOk,
  conversationsSemanticEqual,
  hashVaultText,
  isMemoryDayFileName,
  memoryObjectsSemanticEqual,
  readVaultRegistryMeta,
  readVaultRegistryShard,
} from "./vault";
import type { VaultRegistryFileEntry } from "./vault";
import type { Conversation, MemoryObject } from "./types";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 隠しarchive。`.`で始まるため、Tsumugiの全走査・Obsidianの双方から見えない。 */
export const LEGACY_ARCHIVE_ROOT = ".tsumugi-archive";
const ARCHIVE_SUBDIR = "legacy-cleanup";
const ARCHIVE_FILES_DIR = "files";
const MANIFEST_NAME = "manifest.json";
const HIDDEN_PREFIX = ".";
const MAX_WALK_DEPTH = 8;
/** `Memories/YYYY-MM-DD-xxxxxx.md`（旧1record1file形式）。day-file（`YYYY-MM-DD.md`）とは別。 */
const LEGACY_MEMORY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-[0-9A-Za-z]+\.md$/;

function archivePathFor(originalPath: string): string {
  return `${LEGACY_ARCHIVE_ROOT}/${ARCHIVE_SUBDIR}/${ARCHIVE_FILES_DIR}/${originalPath}`;
}

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export interface LegacyCleanupCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export type LegacyArchiveKind = "legacy-memory" | "duplicate-conversation";

export interface LegacyCleanupManifestEntry {
  originalPath: string;
  archivePath: string;
  sha256: string;
  size: number;
  archivedAt: string;
  kind: LegacyArchiveKind;
  recordId: string;
  /** legacy-memoryのみ。 */
  day?: string;
}

export interface LegacyCleanupManifest {
  schemaVersion: 1;
  entries: LegacyCleanupManifestEntry[];
}

export interface LegacyBodyDiff {
  recordId: string;
  day: string;
  originalPath: string;
  /** 内容が異なるfield（`content`／`summary`）。 */
  fields: string[];
  legacyUpdatedAt: string;
  dayUpdatedAt: string;
}

/** 正本と内容が異なる重複Conversationコピー（退避対象。内容は失われない＝archiveに残る）。 */
export interface LegacyConversationCopyDiff {
  recordId: string;
  copyPath: string;
  canonicalPath: string;
  /** 例：`turns:2→2`／`turn[1]`。 */
  differences: string[];
}

export interface LegacyArchiveItem {
  kind: LegacyArchiveKind;
  originalPath: string;
  archivePath: string;
  recordId: string;
  day?: string;
  sha256: string;
  size: number;
  /** pending：archiveコピー無し。copied：前回の途中実行でarchiveへコピー済み（取り除きが未了）。 */
  state: "pending" | "copied";
  checks: LegacyCleanupCheck[];
  ok: boolean;
  /** 本文（content/summary）がday-file側と異なる旧Memoryの場合のみ。 */
  bodyDiff?: LegacyBodyDiff;
}

export interface MemoryDayReconcileItem {
  key: string;
  day: string;
  path: string;
  /** 今回のcleanup（退避）が原因のconflictとして扱ってよいか。falseなら対象外（触らない）。 */
  eligible: boolean;
  checks: LegacyCleanupCheck[];
  ok: boolean;
}

export interface ConversationReconcileItem {
  key: string;
  registeredPath: string;
  /** 正本として確定するpath。特定できなければnull。 */
  canonicalPath: string | null;
  eligible: boolean;
  checks: LegacyCleanupCheck[];
  ok: boolean;
}

export interface LegacyCleanupRegistryCounts {
  memoryDayConflict: number;
  conversationConflict: number;
  conversationMissing: number;
}

export interface LegacyCleanupPlan {
  archiveMemoryFiles: LegacyArchiveItem[];
  archiveConversationCopies: LegacyArchiveItem[];
  /** 前回までの実行で退避が完了しているファイル数（manifest＋archiveコピーで確認済み）。 */
  alreadyArchived: number;
  /** 旧形式名だがReflection（system-generated）のため対象外としたファイル数。 */
  reflectionsExcluded: number;
  memoryDays: MemoryDayReconcileItem[];
  conversations: ConversationReconcileItem[];
  /** conflictだが今回のcleanupが原因ではない（別原因の）ため触らないkeyと理由。 */
  skippedConflicts: { key: string; reason: string }[];
  bodyDiffs: LegacyBodyDiff[];
  /** 正本と内容が異なる重複Conversationコピー（内容はarchiveに保存される）。 */
  conversationCopyDiffs: LegacyConversationCopyDiff[];
  current: LegacyCleanupRegistryCounts;
  predicted: LegacyCleanupRegistryCounts;
  /** IndexedDBの件数（このcleanupでは変更しない）。 */
  idb: { memories: number; conversations: number; sources: number };
  blockers: string[];
  /** 実行してよいか（blockerが無く、やることがある）。 */
  executable: boolean;
  nothingToDo: boolean;
}

export interface LegacyCleanupVaultFile {
  path: string;
  name: string;
  area: "Memories" | "Conversations";
  text: string;
  sha256: string;
  size: number;
}

export interface LegacyCleanupRegistryEntry {
  key: string;
  path: string;
  entry: VaultRegistryFileEntry;
}

export interface LegacyCleanupSnapshot {
  files: LegacyCleanupVaultFile[];
  registry: LegacyCleanupRegistryEntry[];
  manifest: LegacyCleanupManifest;
  manifestError: string | null;
  /** archive内に実在するファイル：archivePath → sha256。 */
  archiveSha: Map<string, string>;
  idb: {
    memories: Map<string, MemoryObject>;
    conversations: Map<string, Conversation>;
    sourceCount: number;
  };
  baselineEstablishedAt: string | null;
}

// ---------------------------------------------------------------------------
// 純粋な計画計算
// ---------------------------------------------------------------------------

function isReflection(memory: MemoryObject): boolean {
  return memory.metadata.source === "system-generated";
}

function isDuplicateCopyName(name: string): boolean {
  return name.endsWith("+.md");
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, i) => id === sortedB[i]);
}

function countRegistry(registry: LegacyCleanupRegistryEntry[]): LegacyCleanupRegistryCounts {
  const counts: LegacyCleanupRegistryCounts = { memoryDayConflict: 0, conversationConflict: 0, conversationMissing: 0 };
  for (const { entry } of registry) {
    if (entry.recordType === "memory-day" && entry.status === "conflict") counts.memoryDayConflict += 1;
    if (entry.recordType === "conversation" && entry.status === "conflict") counts.conversationConflict += 1;
    if (entry.recordType === "conversation" && entry.status === "missing") counts.conversationMissing += 1;
  }
  return counts;
}

/** archive上の状態から、この元ファイルのarchive段階（pending/copied）と検査結果を決める。 */
function archiveStateCheck(
  snapshot: LegacyCleanupSnapshot,
  archivePath: string,
  sha256: string
): { state: "pending" | "copied"; check: LegacyCleanupCheck } {
  const existing = snapshot.archiveSha.get(archivePath);
  if (existing === undefined) {
    return { state: "pending", check: { name: "archive先が空いている", ok: true } };
  }
  if (existing === sha256) {
    return { state: "copied", check: { name: "archiveに同一内容のコピーが既にある（再実行）", ok: true } };
  }
  return {
    state: "pending",
    check: { name: "archive先に別内容のファイルが無い", ok: false, detail: "archive先に内容の異なるファイルがあるため上書きしません" },
  };
}

/**
 * snapshotから実行計画を作る（純粋関数）。dry-runと実行の両方が使う。
 * `archive*`の対象ファイルは「これから取り除かれる」ものとして、memory-day／conversationの
 * 検証（重複pathが残らないか）から除外して予測する。実行後に呼べば、実際に残ったファイルだけで検証される。
 */
export function computeLegacyCleanupPlan(
  snapshot: LegacyCleanupSnapshot,
  // true（dry-run・既定）：退避対象は「これから取り除かれる」ものとして検証する。
  // false（退避の実行後）：実際に残っているファイルだけで検証する（取り除きに失敗したファイルがあれば、
  // 重複が残っているものとして再確定しない）。
  options: { assumeArchived: boolean } = { assumeArchived: true }
): LegacyCleanupPlan {
  const blockers: string[] = [];
  if (snapshot.manifestError) blockers.push(`archiveのmanifestを読めません：${snapshot.manifestError}`);

  const memoryFiles = snapshot.files.filter((file) => file.area === "Memories");
  const conversationFiles = snapshot.files.filter((file) => file.area === "Conversations");
  const parsedMemories = new Map<string, MemoryObject[]>();
  for (const file of memoryFiles) parsedMemories.set(file.path, parseMemoryDayFile(file.text));

  // day → day-file（`YYYY-MM-DD.md`。入れ子フォルダにあっても名前で見つける）
  const dayFilesByDay = new Map<string, LegacyCleanupVaultFile[]>();
  for (const file of memoryFiles) {
    if (!isMemoryDayFileName(file.name)) continue;
    const day = file.name.slice(0, 10);
    dayFilesByDay.set(day, [...(dayFilesByDay.get(day) ?? []), file]);
  }

  // --- 旧形式Memoryファイル ---
  const archiveMemoryFiles: LegacyArchiveItem[] = [];
  const bodyDiffs: LegacyBodyDiff[] = [];
  let reflectionsExcluded = 0;
  for (const file of memoryFiles) {
    if (!LEGACY_MEMORY_FILE_PATTERN.test(file.name)) continue;
    const entries = parsedMemories.get(file.path) ?? [];
    if (entries.length === 0) continue; // Tsumugiのファイルではない（触らない）
    if (entries.length === 1 && isReflection(entries[0])) {
      reflectionsExcluded += 1;
      continue;
    }
    const legacy = entries[0];
    const day = legacy.date.slice(0, 10);
    const dayFiles = dayFilesByDay.get(day) ?? [];
    const dayFile = dayFiles.length === 1 ? dayFiles[0] : undefined;
    const dayEntry = dayFile ? (parsedMemories.get(dayFile.path) ?? []).find((m) => m.id === legacy.id) : undefined;
    const archivePath = archivePathFor(file.path);
    const archive = archiveStateCheck(snapshot, archivePath, file.sha256);

    const checks: LegacyCleanupCheck[] = [
      { name: "1ファイル1件のMemory", ok: entries.length === 1, detail: `${entries.length}件` },
      { name: "Reflectionではない", ok: !entries.some(isReflection) },
      { name: "同じ日のday-fileが1つだけある", ok: dayFile !== undefined, detail: `${dayFiles.length}件` },
      { name: "day-fileに同じidがある", ok: dayEntry !== undefined },
      {
        name: "day-fileの方が新しい（updatedAtが同じか新しい）",
        ok: dayEntry !== undefined && dayEntry.updatedAt >= legacy.updatedAt,
        detail: dayEntry ? `旧:${legacy.updatedAt} / day-file:${dayEntry.updatedAt}` : undefined,
      },
      archive.check,
    ];
    const ok = checks.every((check) => check.ok);
    let bodyDiff: LegacyBodyDiff | undefined;
    if (dayEntry) {
      const fields = [
        ...(legacy.content !== dayEntry.content ? ["content"] : []),
        ...(legacy.summary !== dayEntry.summary ? ["summary"] : []),
      ];
      if (fields.length > 0) {
        bodyDiff = {
          recordId: legacy.id,
          day,
          originalPath: file.path,
          fields,
          legacyUpdatedAt: legacy.updatedAt,
          dayUpdatedAt: dayEntry.updatedAt,
        };
        bodyDiffs.push(bodyDiff);
      }
    }
    archiveMemoryFiles.push({
      kind: "legacy-memory",
      originalPath: file.path,
      archivePath,
      recordId: legacy.id,
      day,
      sha256: file.sha256,
      size: file.size,
      state: archive.state,
      checks,
      ok,
      bodyDiff,
    });
    if (!ok) blockers.push(`旧Memory ${file.path}：${checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")}`);
  }

  // --- Registry（conflict／missing）---
  const conflictEntries = snapshot.registry.filter(({ entry }) => entry.status === "conflict");
  const manifestDays = new Set(
    snapshot.manifest.entries.filter((e) => e.kind === "legacy-memory" && e.day).map((e) => e.day as string)
  );
  const manifestConversationIds = new Set(
    snapshot.manifest.entries.filter((e) => e.kind === "duplicate-conversation").map((e) => e.recordId)
  );
  const archiveCandidateDays = new Set(archiveMemoryFiles.map((item) => item.day as string));
  const archivedPaths = new Set(options.assumeArchived ? archiveMemoryFiles.map((item) => item.originalPath) : []);
  const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));

  // --- Conversationの重複コピー＋再確定 ---
  const archiveConversationCopies: LegacyArchiveItem[] = [];
  const conversations: ConversationReconcileItem[] = [];
  const skippedConflicts: { key: string; reason: string }[] = [];
  const conversationCopyDiffs: LegacyConversationCopyDiff[] = [];

  for (const { key, path, entry } of conflictEntries) {
    if (entry.recordType !== "conversation") continue;
    const claimants = conversationFiles
      .map((file) => ({ file, parsed: file.text.includes(key) ? parseConversationMarkdown(file.text) : null }))
      .filter((c): c is { file: LegacyCleanupVaultFile; parsed: Conversation } => c.parsed !== null && c.parsed.id === key);
    const canonicalCandidates = claimants.filter(
      (c) => hashVaultText(c.file.text) === entry.contentHash && !isDuplicateCopyName(c.file.name)
    );
    const canonical = canonicalCandidates.length === 1 ? canonicalCandidates[0] : undefined;
    const copies = canonical ? claimants.filter((c) => c !== canonical) : [];
    const eligible = copies.length > 0 || manifestConversationIds.has(key);

    const copyItems: LegacyArchiveItem[] = copies.map((copy) => {
      const archivePath = archivePathFor(copy.file.path);
      const archive = archiveStateCheck(snapshot, archivePath, copy.file.sha256);
      const checks: LegacyCleanupCheck[] = [
        { name: "名前が重複コピー（…+.md）", ok: isDuplicateCopyName(copy.file.name) },
        archive.check,
      ];
      // 内容が正本と異なっても退避はできる（archiveに保存され、失われない）。ただし黙って進めず、
      // dry-runで必ず表示する。
      if (canonical && !conversationsSemanticEqual(canonical.parsed, copy.parsed)) {
        const differences: string[] = [];
        const a = canonical.parsed;
        const b = copy.parsed;
        if (a.turns.length !== b.turns.length) differences.push(`turns:${a.turns.length}→${b.turns.length}`);
        a.turns.forEach((turn, i) => {
          if (b.turns[i] && (turn.role !== b.turns[i].role || turn.content !== b.turns[i].content)) differences.push(`turn[${i}]`);
        });
        if (a.updatedAt !== b.updatedAt) differences.push("updatedAt");
        if (differences.length === 0) differences.push("metadata");
        conversationCopyDiffs.push({ recordId: key, copyPath: copy.file.path, canonicalPath: canonical.file.path, differences });
      }
      return {
        kind: "duplicate-conversation",
        originalPath: copy.file.path,
        archivePath,
        recordId: key,
        sha256: copy.file.sha256,
        size: copy.file.size,
        state: archive.state,
        checks,
        ok: checks.every((c) => c.ok),
      };
    });
    archiveConversationCopies.push(...copyItems);
    for (const item of copyItems) {
      if (!item.ok) blockers.push(`Conversationコピー ${item.originalPath}：${item.checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")}`);
    }

    const idbConversation = snapshot.idb.conversations.get(key);
    const checks: LegacyCleanupCheck[] = [
      {
        name: "正本のファイルを1つだけ特定できる（記録済みhashと一致）",
        ok: canonical !== undefined,
        detail: canonical ? canonical.file.path : `該当${canonicalCandidates.length}件`,
      },
      { name: "重複コピーが全て退避対象として検証済み", ok: copyItems.every((item) => item.ok) },
      ...(options.assumeArchived
        ? []
        : [{ name: "重複コピーが残っていない", ok: copies.length === 0, detail: `${copies.length}件` }]),
      {
        name: "IndexedDBのConversationと内容が同じ",
        ok: canonical !== undefined && idbConversation !== undefined && conversationsSemanticEqual(idbConversation, canonical.parsed),
        detail: idbConversation ? undefined : "IndexedDBに無い",
      },
    ];
    const item: ConversationReconcileItem = {
      key,
      registeredPath: path,
      canonicalPath: canonical ? canonical.file.path : null,
      eligible,
      checks,
      ok: checks.every((c) => c.ok),
    };
    if (!eligible) {
      skippedConflicts.push({ key, reason: "重複コピーの退避が原因のconflictではないため対象外" });
      continue;
    }
    conversations.push(item);
    if (!item.ok) blockers.push(`Conversation ${key}：${checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")}`);
  }

  // --- memory-day再確定 ---
  const memoryDays: MemoryDayReconcileItem[] = [];
  for (const { key, path, entry } of conflictEntries) {
    if (entry.recordType !== "memory-day") continue;
    const day = key.startsWith("day:") ? key.slice(4) : key;
    const eligible = archiveCandidateDays.has(day) || manifestDays.has(day);
    if (!eligible) {
      skippedConflicts.push({ key, reason: "旧形式ファイルの退避が原因のconflictではないため対象外" });
      continue;
    }
    const file = filesByPath.get(path);
    const members = file ? (parsedMemories.get(file.path) ?? []) : [];
    const otherClaimants = memoryFiles.filter((other) => {
      if (other.path === path || archivedPaths.has(other.path)) return false;
      return (parsedMemories.get(other.path) ?? []).some((m) => !isReflection(m) && m.date.slice(0, 10) === day);
    });
    const idbMismatch = members.filter((m) => {
      const inIdb = snapshot.idb.memories.get(m.id);
      return inIdb === undefined || !memoryObjectsSemanticEqual(inIdb, m);
    });
    const checks: LegacyCleanupCheck[] = [
      { name: "登録pathがday-fileで、実在する", ok: file !== undefined && isMemoryDayFileName(file.name), detail: path },
      {
        name: "ファイルが登録時から変わっていない（hash一致）",
        ok: file !== undefined && hashVaultText(file.text) === entry.contentHash,
      },
      {
        name: "全メンバーが通常Memory（同じ日）",
        ok: members.length > 0 && members.every((m) => !isReflection(m) && m.date.slice(0, 10) === day),
        detail: `${members.length}件`,
      },
      {
        name: "登録済みのメンバーid集合と一致",
        ok: sameIds(members.map((m) => m.id), entry.memberIds),
        detail: `ファイル${members.length}件 / 登録${entry.memberIds.length}件`,
      },
      {
        name: "同じ日を主張する他のファイルが残らない",
        ok: otherClaimants.length === 0,
        detail: otherClaimants.slice(0, 3).map((f) => f.path).join(", "),
      },
      {
        name: "IndexedDBの全メンバーと内容が同じ",
        ok: idbMismatch.length === 0,
        detail: idbMismatch.length > 0 ? `不一致${idbMismatch.length}件（例：${idbMismatch[0].id}）` : undefined,
      },
    ];
    const item: MemoryDayReconcileItem = { key, day, path, eligible, checks, ok: checks.every((c) => c.ok) };
    memoryDays.push(item);
    if (!item.ok) blockers.push(`memory-day ${day}：${checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")}`);
  }

  // --- 退避済み（前回までの実行） ---
  let alreadyArchived = 0;
  for (const entry of snapshot.manifest.entries) {
    if (filesByPath.has(entry.originalPath)) continue; // 元ファイルがまだある＝上のpending/copiedで扱う
    const archived = snapshot.archiveSha.get(entry.archivePath);
    if (archived === entry.sha256) alreadyArchived += 1;
    else blockers.push(`退避済みのはずの ${entry.originalPath} のarchiveコピーが見つからない・内容が一致しません`);
  }

  const current = countRegistry(snapshot.registry);
  const resolvedDays = memoryDays.filter((item) => item.ok).length;
  const resolvedConversations = conversations.filter((item) => item.ok).length;
  const predicted: LegacyCleanupRegistryCounts = {
    memoryDayConflict: current.memoryDayConflict - resolvedDays,
    conversationConflict: current.conversationConflict - resolvedConversations,
    conversationMissing: current.conversationMissing,
  };
  const archiveCount = archiveMemoryFiles.length + archiveConversationCopies.length;
  const nothingToDo = blockers.length === 0 && archiveCount === 0 && memoryDays.length === 0 && conversations.length === 0;

  return {
    archiveMemoryFiles,
    archiveConversationCopies,
    alreadyArchived,
    reflectionsExcluded,
    memoryDays,
    conversations,
    skippedConflicts,
    bodyDiffs,
    conversationCopyDiffs,
    current,
    predicted,
    idb: {
      memories: snapshot.idb.memories.size,
      conversations: snapshot.idb.conversations.size,
      sources: snapshot.idb.sourceCount,
    },
    blockers,
    executable: blockers.length === 0 && !nothingToDo,
    nothingToDo,
  };
}

// ---------------------------------------------------------------------------
// I/O：snapshot収集
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const utf8 = new TextDecoder("utf-8");

async function walkFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  area: "Memories" | "Conversations" | null,
  depth: number,
  out: LegacyCleanupVaultFile[]
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(HIDDEN_PREFIX)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      const nextArea = area ?? (name === "Memories" || name === "Conversations" ? name : null);
      await walkFiles(handle as FileSystemDirectoryHandle, path, nextArea, depth + 1, out);
      continue;
    }
    if (area === null || !name.endsWith(".md")) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    const bytes = await file.arrayBuffer();
    out.push({ path, name, area, text: utf8.decode(bytes), sha256: await sha256Hex(bytes), size: bytes.byteLength });
  }
}

async function readArchiveTree(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: Map<string, string>
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    const path = `${prefix}/${name}`;
    if (handle.kind === "directory") {
      await readArchiveTree(handle as FileSystemDirectoryHandle, path, out);
      continue;
    }
    const file = await (handle as FileSystemFileHandle).getFile();
    out.set(path, await sha256Hex(await file.arrayBuffer()));
  }
}

async function getDirectoryIfExists(
  parent: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name, { create: false });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function readManifest(
  root: FileSystemDirectoryHandle
): Promise<{ manifest: LegacyCleanupManifest; error: string | null }> {
  const empty: LegacyCleanupManifest = { schemaVersion: 1, entries: [] };
  const archiveRoot = await getDirectoryIfExists(root, LEGACY_ARCHIVE_ROOT);
  const sub = archiveRoot ? await getDirectoryIfExists(archiveRoot, ARCHIVE_SUBDIR) : null;
  if (!sub) return { manifest: empty, error: null };
  let text: string;
  try {
    const handle = await sub.getFileHandle(MANIFEST_NAME, { create: false });
    text = await (await handle.getFile()).text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return { manifest: empty, error: null };
    return { manifest: empty, error: error instanceof Error ? error.message : String(error) };
  }
  // 空のmanifest（作成直後に書き込みが完了しなかった場合）は「まだ何も記録していない」と同じ。
  if (text.trim().length === 0) return { manifest: empty, error: null };
  try {
    const parsed = JSON.parse(text) as LegacyCleanupManifest;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) throw new Error("unexpected manifest format");
    return { manifest: parsed, error: null };
  } catch (error) {
    return { manifest: empty, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readAllRegistryEntries(root: FileSystemDirectoryHandle): Promise<LegacyCleanupRegistryEntry[]> {
  const out: LegacyCleanupRegistryEntry[] = [];
  for (let bucket = 0; bucket < VAULT_REGISTRY_BUCKET_COUNT; bucket++) {
    const shard = await readVaultRegistryShard(root, bucket);
    for (const [key, path] of Object.entries(shard.records)) {
      const entry = shard.files[path];
      if (entry !== undefined) out.push({ key, path, entry });
    }
  }
  return out;
}

async function loadIdbSnapshot(): Promise<LegacyCleanupSnapshot["idb"]> {
  const [memories, conversations, sources] = await Promise.all([
    getAllMemoryObjects(),
    getAllConversations(),
    getAllSources(),
  ]);
  return {
    memories: new Map(memories.map((m) => [m.id, m])),
    conversations: new Map(conversations.map((c) => [c.id, c])),
    sourceCount: sources.length,
  };
}

/** Vault・Registry・archive・IndexedDBを読み取る（何も書き込まない）。 */
export async function collectLegacyCleanupSnapshot(root: FileSystemDirectoryHandle): Promise<LegacyCleanupSnapshot> {
  const files: LegacyCleanupVaultFile[] = [];
  await walkFiles(root, "", null, 0, files);

  const archiveSha = new Map<string, string>();
  const archiveRoot = await getDirectoryIfExists(root, LEGACY_ARCHIVE_ROOT);
  const sub = archiveRoot ? await getDirectoryIfExists(archiveRoot, ARCHIVE_SUBDIR) : null;
  const filesDir = sub ? await getDirectoryIfExists(sub, ARCHIVE_FILES_DIR) : null;
  if (filesDir) await readArchiveTree(filesDir, `${LEGACY_ARCHIVE_ROOT}/${ARCHIVE_SUBDIR}/${ARCHIVE_FILES_DIR}`, archiveSha);

  const { manifest, error } = await readManifest(root);
  return {
    files,
    registry: await readAllRegistryEntries(root),
    manifest,
    manifestError: error,
    archiveSha,
    idb: await loadIdbSnapshot(),
    baselineEstablishedAt: (await readVaultRegistryMeta(root)).baselineEstablishedAt,
  };
}

/** dry-run。読み取りのみ。呼び出し元が`withVaultWorldRead`を保持している前提。 */
export async function planLegacyCleanup(root: FileSystemDirectoryHandle): Promise<LegacyCleanupPlan> {
  return computeLegacyCleanupPlan(await collectLegacyCleanupSnapshot(root));
}

// ---------------------------------------------------------------------------
// I/O：実行
// ---------------------------------------------------------------------------

async function resolveParentDir(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const segments = path.split("/");
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return { dir, name: segments[segments.length - 1] };
}

async function readBytesIfExists(root: FileSystemDirectoryHandle, path: string): Promise<ArrayBuffer | null> {
  try {
    const { dir, name } = await resolveParentDir(root, path, false);
    const handle = await dir.getFileHandle(name, { create: false });
    return await (await handle.getFile()).arrayBuffer();
  } catch (error) {
    if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError")) return null;
    throw error;
  }
}

async function writeNewFile(root: FileSystemDirectoryHandle, path: string, bytes: ArrayBuffer | string): Promise<void> {
  const { dir, name } = await resolveParentDir(root, path, true);
  const handle = await dir.getFileHandle(name, { create: true });
  await writeFileHandleContent(handle, bytes);
}

export interface LegacyCleanupPostCheck {
  ok: boolean;
  checks: LegacyCleanupCheck[];
  counts: LegacyCleanupRegistryCounts;
  idb: { memories: number; conversations: number; sources: number };
}

export type LegacyCleanupStatus = "complete" | "partial" | "interrupted" | "refused" | "nothing-to-do";

export interface LegacyCleanupResult {
  status: LegacyCleanupStatus;
  /** 今回の実行で退避した（元ファイルを取り除いた）件数。 */
  archivedNow: number;
  memoryDaysCommitted: number;
  conversationsCommitted: number;
  errors: string[];
  planBefore: LegacyCleanupPlan;
  postCheck: LegacyCleanupPostCheck | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 実際のcleanup。ユーザーが明示的に実行した場合だけ呼ぶ。実行時に全前提条件を検証し直し、
 * 1つでもblockerがあれば何も書かずに`refused`を返す。呼び出し元が`runVaultWorldExclusive`を
 * 保持している前提。`isStale`がtrueを返したら次の書き込み前に中断する（再実行で続きから完了できる）。
 */
export async function executeLegacyCleanup(
  root: FileSystemDirectoryHandle,
  isStale?: () => boolean
): Promise<LegacyCleanupResult> {
  const before = await collectLegacyCleanupSnapshot(root);
  const planBefore = computeLegacyCleanupPlan(before);
  const result: LegacyCleanupResult = {
    status: "complete",
    archivedNow: 0,
    memoryDaysCommitted: 0,
    conversationsCommitted: 0,
    errors: [],
    planBefore,
    postCheck: null,
  };
  if (planBefore.nothingToDo) return { ...result, status: "nothing-to-do" };
  if (!planBefore.executable) return { ...result, status: "refused", errors: [...planBefore.blockers] };

  const interrupted = (): LegacyCleanupResult => ({ ...result, status: "interrupted" });

  // A. archiveへコピーし、コピーのSHA-256を検証する（元ファイルにはまだ触らない）。
  const items = [...planBefore.archiveMemoryFiles, ...planBefore.archiveConversationCopies];
  const copied: LegacyArchiveItem[] = [];
  for (const item of items) {
    if (isStale?.()) return interrupted();
    try {
      const original = await readBytesIfExists(root, item.originalPath);
      if (original === null) throw new Error("元ファイルが見つかりません");
      if ((await sha256Hex(original)) !== item.sha256) throw new Error("計画後に元ファイルが変更されました");
      const existing = await readBytesIfExists(root, item.archivePath);
      if (existing === null) await writeNewFile(root, item.archivePath, original);
      else if ((await sha256Hex(existing)) !== item.sha256) throw new Error("archive先に別内容のファイルがあります");
      const verify = await readBytesIfExists(root, item.archivePath);
      if (verify === null || (await sha256Hex(verify)) !== item.sha256) throw new Error("archiveコピーの検証に失敗しました");
      copied.push(item);
    } catch (error) {
      result.errors.push(`退避（コピー）失敗 ${item.originalPath}：${errorMessage(error)}`);
    }
  }

  // B. manifestを（元ファイルを取り除く前に）保存する。既存entryは書き換えず、元pathをkeyに追記する。
  if (copied.length > 0) {
    if (isStale?.()) return interrupted();
    try {
      const known = new Set(before.manifest.entries.map((entry) => entry.originalPath));
      const archivedAt = new Date().toISOString();
      const added: LegacyCleanupManifestEntry[] = copied
        .filter((item) => !known.has(item.originalPath))
        .map((item) => ({
          originalPath: item.originalPath,
          archivePath: item.archivePath,
          sha256: item.sha256,
          size: item.size,
          archivedAt,
          kind: item.kind,
          recordId: item.recordId,
          ...(item.day ? { day: item.day } : {}),
        }));
      const manifest: LegacyCleanupManifest = { schemaVersion: 1, entries: [...before.manifest.entries, ...added] };
      await writeNewFile(root, `${LEGACY_ARCHIVE_ROOT}/${ARCHIVE_SUBDIR}/${MANIFEST_NAME}`, JSON.stringify(manifest, null, 2));
    } catch (error) {
      // manifestが無い状態で元ファイルを取り除かない。
      return { ...result, status: "partial", errors: [...result.errors, `manifestの保存に失敗：${errorMessage(error)}`] };
    }
  }

  // C. 元ファイルを取り除く（archiveコピーとのSHA-256一致を再確認した上で。退避であり削除ではない）。
  for (const item of copied) {
    if (isStale?.()) return interrupted();
    try {
      const original = await readBytesIfExists(root, item.originalPath);
      if (original === null) continue; // 既に無い（再実行）
      if ((await sha256Hex(original)) !== item.sha256) throw new Error("元ファイルが変更されたため取り除きません");
      const { dir, name } = await resolveParentDir(root, item.originalPath, false);
      await dir.removeEntry(name);
      result.archivedNow += 1;
    } catch (error) {
      result.errors.push(`退避（取り除き）失敗 ${item.originalPath}：${errorMessage(error)}`);
    }
  }

  // D. 実際のVaultを読み直し、検証に通ったものだけをRegistry okへ再確定する。
  const after = await collectLegacyCleanupSnapshot(root);
  const planAfter = computeLegacyCleanupPlan(after, { assumeArchived: false });
  const filesByPath = new Map(after.files.map((file) => [file.path, file]));

  for (const item of planAfter.memoryDays) {
    if (isStale?.()) return interrupted();
    if (!item.ok) {
      result.errors.push(`memory-day ${item.day}：再確定しませんでした（${item.checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")}）`);
      continue;
    }
    try {
      const file = filesByPath.get(item.path);
      if (!file) throw new Error("ファイルが見つかりません");
      const members = parseMemoryDayFile(file.text);
      const memberHashes: Record<string, string> = {};
      for (const member of members) memberHashes[member.id] = hashVaultText(memoryObjectToMarkdown(member));
      const stat = await statFile(root, item.path);
      await commitVaultRegistryMemoryDayOk(
        root,
        item.key,
        item.path,
        item.path,
        stat.mtime,
        stat.size,
        hashVaultText(file.text),
        members.map((member) => member.id),
        memberHashes
      );
      result.memoryDaysCommitted += 1;
    } catch (error) {
      result.errors.push(`memory-day ${item.day}：Registry再確定に失敗（${errorMessage(error)}）`);
    }
  }

  for (const item of planAfter.conversations) {
    if (isStale?.()) return interrupted();
    if (!item.ok || item.canonicalPath === null) {
      result.errors.push(`Conversation ${item.key}：再確定しませんでした（${item.checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")}）`);
      continue;
    }
    try {
      const file = filesByPath.get(item.canonicalPath);
      if (!file) throw new Error("正本ファイルが見つかりません");
      const stat = await statFile(root, item.canonicalPath);
      await commitVaultRegistrySingleRecordOk(
        root,
        item.key,
        "conversation",
        item.canonicalPath,
        item.registeredPath,
        stat.mtime,
        stat.size,
        hashVaultText(file.text)
      );
      result.conversationsCommitted += 1;
    } catch (error) {
      result.errors.push(`Conversation ${item.key}：Registry確定に失敗（${errorMessage(error)}）`);
    }
  }

  // E. post-check
  result.postCheck = await runPostCheck(root, before, planBefore);
  result.status = result.errors.length === 0 && result.postCheck.ok ? "complete" : "partial";
  return result;
}

async function statFile(root: FileSystemDirectoryHandle, path: string): Promise<{ mtime: number; size: number }> {
  const { dir, name } = await resolveParentDir(root, path, false);
  const file = await (await dir.getFileHandle(name, { create: false })).getFile();
  return { mtime: file.lastModified, size: file.size };
}

async function runPostCheck(
  root: FileSystemDirectoryHandle,
  before: LegacyCleanupSnapshot,
  planBefore: LegacyCleanupPlan
): Promise<LegacyCleanupPostCheck> {
  const final = await collectLegacyCleanupSnapshot(root);
  const planFinal = computeLegacyCleanupPlan(final);
  const checks: LegacyCleanupCheck[] = [];
  const finalByPath = new Map(final.files.map((file) => [file.path, file]));
  const registryByKey = new Map(final.registry.map((r) => [r.key, r]));

  const expectedRemoved = new Set(
    [...planBefore.archiveMemoryFiles, ...planBefore.archiveConversationCopies].filter((i) => i.ok).map((i) => i.originalPath)
  );
  const unexpectedChanges = before.files.filter((file) => {
    const now = finalByPath.get(file.path);
    if (expectedRemoved.has(file.path)) return now !== undefined && now.sha256 !== file.sha256;
    return now === undefined || now.sha256 !== file.sha256;
  });
  checks.push({
    name: "退避対象以外のMarkdownが変更・削除されていない",
    ok: unexpectedChanges.length === 0,
    detail: unexpectedChanges.slice(0, 3).map((f) => f.path).join(", "),
  });

  const manifestBad = final.manifest.entries.filter((entry) => final.archiveSha.get(entry.archivePath) !== entry.sha256);
  checks.push({
    name: "manifestの全entryのarchiveコピーがSHA-256一致",
    ok: final.manifestError === null && manifestBad.length === 0,
    detail: `${final.manifest.entries.length}件`,
  });

  const notDone = [
    ...planBefore.memoryDays.filter((i) => i.ok).map((i) => i.key),
    ...planBefore.conversations.filter((i) => i.ok).map((i) => i.key),
  ].filter((key) => {
    const registered = registryByKey.get(key);
    if (!registered || registered.entry.status !== "ok") return true;
    const file = finalByPath.get(registered.path);
    return file === undefined || hashVaultText(file.text) !== registered.entry.contentHash;
  });
  checks.push({
    name: "再確定した全keyがRegistry ok（pathとhashがファイルと一致）",
    ok: notDone.length === 0,
    detail: notDone.slice(0, 3).join(", "),
  });

  checks.push({
    name: "Registryのconflict件数が予測どおり",
    ok:
      planFinal.current.memoryDayConflict === planBefore.predicted.memoryDayConflict &&
      planFinal.current.conversationConflict === planBefore.predicted.conversationConflict &&
      planFinal.current.conversationMissing === planBefore.predicted.conversationMissing,
    detail: `memory-day ${planFinal.current.memoryDayConflict} / conversation ${planFinal.current.conversationConflict} / missing ${planFinal.current.conversationMissing}`,
  });
  checks.push({
    name: "IndexedDBの件数が変わっていない",
    ok:
      final.idb.memories.size === before.idb.memories.size &&
      final.idb.conversations.size === before.idb.conversations.size &&
      final.idb.sourceCount === before.idb.sourceCount,
    detail: `${final.idb.memories.size}/${final.idb.conversations.size}/${final.idb.sourceCount}`,
  });
  checks.push({
    name: "baselineが変わっていない",
    ok: final.baselineEstablishedAt === before.baselineEstablishedAt,
  });
  checks.push({
    name: "Reflectionのファイル数が変わっていない",
    ok: planFinal.reflectionsExcluded === planBefore.reflectionsExcluded,
    detail: `${planFinal.reflectionsExcluded}件`,
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
    counts: planFinal.current,
    idb: planFinal.idb,
  };
}
