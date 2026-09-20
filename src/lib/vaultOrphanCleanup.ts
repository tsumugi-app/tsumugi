/**
 * 「保存先に本体が見つからず、この端末にも復元元がない記録」の管理情報の整理。
 *
 * 外部でMarkdownが削除・移動されると、light-checkはRegistry上の記録を「見つからない」（`missing`）と
 * 判定する。しかし「変更を反映」はRegistryのstatusを`missing`にするだけで、警告は消えない。本体が
 * 本当に存在しない記録では、History Index・`.tsumugi/index.json`・Registryに、管理情報だけが残る。
 *
 * このモジュールは「missingだから削除する」という一般処理ではない。次の全てを確認できた記録だけを
 * 「整理できる」（orphan）とし、ユーザーが内容と理由を確認して明示的に実行した場合だけ整理する：
 * - Registryのentryが`missing`で、単一レコード（Conversation／Reflection／Source）である
 * - 登録pathのファイルが、確かに存在しない（読み取りエラーは存在しない扱いにしない）
 * - Vault全体の走査（入れ子・別フォルダ・`+`コピーを含む）で、同じidの記録が見つからず、読めない
 *   Tsumugiファイルも無い
 * - 隠しarchive（`.tsumugi-archive/`）にも、同じidの記録が無い
 * - この端末（IndexedDB）にも、同じidの記録が無い
 * - Registry・History Index・`index.json`を、全て厳密に（エラー無く）読める
 * 満たさない記録は、復元できる可能性がある（`restorable`）、本体が他の場所にある（`found-elsewhere`）、
 * 判断不能（`undetermined`）のいずれかに分類し、整理しない（理由を表示するだけ）。
 * `memory-day`（複数のMemoryを含む日別ファイルの消失）は、意味が異なるため対象外（判断不能）。
 *
 * 【整理の内容】Registryのstatusだけを書き換えて警告を消すのではなく、orphanの原因になっている
 * 管理情報を整合的に処理する。整理前の管理情報は、`.tsumugi-archive/orphan-cleanup/`へ退避し
 * （JSON。SHA-256で検証）、その後、次の順で除去する（各ステップは「既に無ければ何もしない」冪等）：
 *   1. History Index（行の削除＋月の集計・合計の再計算）
 *   2. `.tsumugi/index.json`（キーの削除）
 *   3. vaultSyncState（台帳のキーの削除。記録本体ではない）
 *   4. Registry（entryの削除。**最後**）
 * Registryを最後にするのは、途中で失敗した場合に、Registryの`missing`が残って警告が消えず
 * （History等に管理情報が残ったまま「正常」に見える状態を作らない）、再実行で残りを完了できるため。
 *
 * 【変更しないもの】関連するMemory本体・`conversationId`（参照先の会話が無くても、読み取り側は全て
 * 許容する：`topPrompt.resolveOriginalPersona`はcompanionへfallback、HistoryPanelは「由来」の行を
 * 出さないだけ、retrieval等は現在の会話idとの一致を比べるだけ）、他のMarkdown、IndexedDBの記録、
 * baseline、`registry-index.json`（下記）。
 *
 * 【registry-index.jsonについて】現在このファイルを読む本番コードは無い（読む予定の純粋関数
 * `decideVaultRegistryOwnershipStart`等は、テスト以外から呼ばれていない）。書くのは`resyncVaultRegistry`
 * （full resync）だけで、通常のRegistry更新（commit系・status更新）は元々更新しない。light-check
 * （Level 1〜4）・書き込みゲートのlookup・resyncは、shard（`registry/*.json`）から直接読む。
 * したがってentry削除後に古いkey/pathがindexに残っても、現在の読み取り経路には影響しない。
 * 将来indexを読むようにする際は、Registryの全変更（この整理を含む）を同じ所有権の仕組みへ載せる
 * 必要がある（本関数の削除は`vault.ts`の単一のプリミティブに集約してある）。
 *
 * 実行は`runVaultWorldExclusive`（排他ロック）を呼び出し元が保持している前提。dry-run（`planOrphanCleanup`）
 * は読み取りのみ（`withVaultWorldRead`）。
 */
"use client";

import {
  deleteVaultSyncState,
  getAllConversations,
  getAllMemoryObjects,
  getAllSources,
  getVaultSyncState,
} from "./db";
import {
  VaultRegistryEntryRemovalRefusedError,
  inspectVaultManagementTrace,
  isVaultHistoryMonthAggregateConsistent,
  readVaultRegistryMeta,
  readVaultRegistrySnapshotStrict,
  removeVaultHistoryRecordRows,
  removeVaultIndexJsonKey,
  removeVaultRegistrySingleRecordEntry,
  scanVaultForRestore,
  vaultSyncKeyFor,
} from "./vault";
import type { VaultHistoryRowRef, VaultOrphanRecordKind, VaultSyncKind } from "./vault";
import type { VaultRegistryFileEntry } from "./vault";

// ---------------------------------------------------------------------------
// 定数・型
// ---------------------------------------------------------------------------

const ARCHIVE_ROOT = ".tsumugi-archive";
const ORPHAN_ARCHIVE_DIR = "orphan-cleanup";
const ORPHAN_RECORDS_DIR = "records";
const MANIFEST_NAME = "manifest.json";

export type MissingCategory = "orphan" | "restorable" | "found-elsewhere" | "undetermined";

export interface MissingRelatedMemory {
  id: string;
  day: string;
  summary: string;
}

export interface MissingRecordItem {
  /** Registryのkey（＝レコードのid）。 */
  key: string;
  kind: VaultOrphanRecordKind | "memory-day";
  /** Registryに登録されていたpath。 */
  path: string;
  category: MissingCategory;
  /** ユーザー向けの説明（内部用語を出さない）。 */
  message: string;
  /** 判定の根拠（何を確認して、何が無かった／あったか）。 */
  evidence: string[];
  /** 最後にRegistryへ記録された状態。 */
  lastKnown: { mtime: number; size: number };
  /** 一覧・確認画面用の1行表示。 */
  title: string;
  /** 「YYYY-MM-DD」（分かる場合）。 */
  day?: string;
  historyRows: VaultHistoryRowRef[];
  indexPath?: string;
  /** この記録を参照するMemory（整理しても、そのまま残る）。 */
  relatedMemories: MissingRelatedMemory[];
}

export interface OrphanPlan {
  /** Registryを最後まで読めたか。falseなら、全体が判断不能。 */
  registryReadable: boolean;
  items: MissingRecordItem[];
  orphans: MissingRecordItem[];
  others: MissingRecordItem[];
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function ledgerKindOf(kind: VaultOrphanRecordKind): VaultSyncKind {
  return kind === "reflection" ? "memory" : kind;
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function resolveDir(root: FileSystemDirectoryHandle, segments: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create });
  return dir;
}

/** 登録pathのファイルが存在するか。NotFoundだけを「確認できた不在」とし、それ以外の失敗はunknown。 */
async function pathState(root: FileSystemDirectoryHandle, relativePath: string): Promise<"absent" | "present" | "unknown"> {
  const segments = relativePath.split("/");
  try {
    const dir = await resolveDir(root, segments.slice(0, -1), false);
    await dir.getFileHandle(segments[segments.length - 1], { create: false });
    return "present";
  } catch (error) {
    return isNotFound(error) ? "absent" : "unknown";
  }
}

/** `.tsumugi-archive/`配下の全ファイルの本文（idの検索用）。整理の退避（orphan-cleanup）は除く。 */
async function readArchiveTexts(root: FileSystemDirectoryHandle): Promise<{ ok: boolean; texts: string[] }> {
  const texts: string[] = [];
  let archive: FileSystemDirectoryHandle;
  try {
    archive = await root.getDirectoryHandle(ARCHIVE_ROOT, { create: false });
  } catch (error) {
    return isNotFound(error) ? { ok: true, texts } : { ok: false, texts };
  }
  const walk = async (dir: FileSystemDirectoryHandle, depth: number): Promise<void> => {
    if (depth > 10) return;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory") {
        if (depth === 0 && name === ORPHAN_ARCHIVE_DIR) continue;
        await walk(handle as FileSystemDirectoryHandle, depth + 1);
      } else {
        texts.push(await (await (handle as FileSystemFileHandle).getFile()).text());
      }
    }
  };
  try {
    await walk(archive, 0);
    return { ok: true, texts };
  } catch {
    return { ok: false, texts };
  }
}

function dayFromPath(path: string): string | undefined {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(path.split("/").pop() ?? "");
  return match ? match[1] : undefined;
}

function titleFor(kind: MissingRecordItem["kind"], day: string | undefined, rows: VaultHistoryRowRef[]): string {
  const when = day ? `${day}の` : "";
  if (kind === "conversation") {
    const row = rows.find((r) => r.conversation)?.conversation;
    const mode = row ? (row.mode === "diary" ? "日記" : "会話") : "会話";
    return row ? `${when}${mode}（${row.turnCount}件のやり取り）` : `${when}会話`;
  }
  if (kind === "reflection") return `${when}振り返り`;
  if (kind === "source") return `${when}素材`;
  return `${when}記憶のファイル`;
}

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

/**
 * dry-run。Registry・Vault・archive・IndexedDBを読み取り、`missing`の記録を4つに分類する。何も書き込まない。
 * 呼び出し元がworld lock（`withVaultWorldRead`または排他lock）を保持している前提。
 */
export async function planOrphanCleanup(root: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<OrphanPlan> {
  const snapshot = await readVaultRegistrySnapshotStrict(root);
  const missing: { key: string; path: string; entry: VaultRegistryFileEntry }[] = [];
  for (const [key, path] of snapshot.records) {
    const entry = snapshot.files.get(path);
    if (entry && entry.status === "missing") missing.push({ key, path, entry });
  }
  if (missing.length === 0) {
    return { registryReadable: snapshot.completed, items: [], orphans: [], others: [] };
  }

  // 共通の証拠（1回だけ読む）。読めなかったものは、全件を判断不能にする。
  let evidenceError: string | null = null;
  let vaultIds = new Set<string>();
  let vaultMemories: { id: string; date: string; summary: string; conversationId?: string; sourceId?: string }[] = [];
  let scanSkipped = 0;
  let archiveTexts: string[] = [];
  let idbConversations = new Set<string>();
  let idbSources = new Set<string>();
  let idbMemoryIds = new Set<string>();
  let idbMemories: { id: string; date: string; summary: string; conversationId?: string; sourceId?: string }[] = [];
  try {
    const scan = await scanVaultForRestore(root, signal);
    scanSkipped = scan.skippedCount;
    vaultIds = new Set([...scan.conversations.map((c) => c.id), ...scan.memoryObjects.map((m) => m.id), ...scan.sources.map((s) => s.id)]);
    vaultMemories = scan.memoryObjects.map((m) => ({ id: m.id, date: m.date, summary: m.summary, conversationId: m.conversationId, sourceId: m.sourceId }));
    const archive = await readArchiveTexts(root);
    if (!archive.ok) evidenceError = "退避先（archive）を読み込めませんでした。";
    archiveTexts = archive.texts;
    const [conversations, memories, sources] = await Promise.all([getAllConversations(), getAllMemoryObjects(), getAllSources()]);
    idbConversations = new Set(conversations.map((c) => c.id));
    idbSources = new Set(sources.map((s) => s.id));
    idbMemoryIds = new Set(memories.map((m) => m.id));
    idbMemories = memories.map((m) => ({ id: m.id, date: m.date, summary: m.summary, conversationId: m.conversationId, sourceId: m.sourceId }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    evidenceError = "保存先または端末の状態を確認できませんでした。";
  }

  const items: MissingRecordItem[] = [];
  for (const { key, path, entry } of missing) {
    const kind = entry.recordType;
    const day = dayFromPath(path);
    const base = {
      key,
      kind,
      path,
      lastKnown: { mtime: entry.mtime, size: entry.size },
      day,
      historyRows: [] as VaultHistoryRowRef[],
      relatedMemories: [] as MissingRelatedMemory[],
    };
    const undetermined = (message: string, evidence: string[]): MissingRecordItem => ({
      ...base,
      category: "undetermined",
      message,
      evidence,
      title: titleFor(kind, day, base.historyRows),
    });

    if (kind === "memory-day") {
      items.push(undetermined("複数の記憶を含む日別ファイルが見つかりません。この記録は今回は整理の対象外です。", ["memory-day"]));
      continue;
    }
    if (!snapshot.completed) {
      items.push(undetermined("保存先の管理情報を最後まで読み込めなかったため、確認できません。", ["registry snapshot incomplete"]));
      continue;
    }
    if (entry.memberIds.length !== 1 || entry.memberIds[0] !== key || [...snapshot.records].some(([k, p]) => k !== key && p === path)) {
      items.push(undetermined("この記録の管理情報に、他の記録と共有されている部分があるため、確認が必要です。", ["shared registry entry"]));
      continue;
    }
    if (evidenceError !== null) {
      items.push(undetermined(evidenceError, ["evidence unavailable"]));
      continue;
    }

    const trace = await inspectVaultManagementTrace(root, kind, key);
    const item: MissingRecordItem = {
      ...base,
      category: "orphan",
      message: "",
      evidence: [],
      title: "",
      historyRows: trace.historyRows,
      indexPath: trace.indexPath,
      relatedMemories: [],
    };
    const relatedSource = new Map<string, MissingRelatedMemory>();
    for (const m of [...vaultMemories, ...idbMemories]) {
      const refers = kind === "conversation" ? m.conversationId === key : kind === "source" ? m.sourceId === key : false;
      if (refers) relatedSource.set(m.id, { id: m.id, day: m.date.slice(0, 10), summary: m.summary });
    }
    item.relatedMemories = [...relatedSource.values()];
    item.title = titleFor(kind, day ?? trace.historyRows[0]?.day, trace.historyRows);
    item.day = day ?? trace.historyRows[0]?.day;

    const state = await pathState(root, path);
    const inIdb = kind === "conversation" ? idbConversations.has(key) : kind === "source" ? idbSources.has(key) : idbMemoryIds.has(key);
    const inArchive = archiveTexts.some((text) => text.includes(key));

    if (!trace.ok) {
      item.category = "undetermined";
      item.message = "保存先の履歴・索引を読み込めなかったため、確認できません。";
      item.evidence = ["management info unreadable"];
    } else if (state === "unknown") {
      item.category = "undetermined";
      item.message = "保存先のファイルの有無を確認できませんでした。";
      item.evidence = ["path state unknown"];
    } else if (state === "present") {
      item.category = "found-elsewhere";
      item.message = "保存先に本体が見つかっています。外部の変更の確認で、自動的に反映されます。";
      item.evidence = ["file exists at registered path"];
    } else if (vaultIds.has(key)) {
      item.category = "found-elsewhere";
      item.message = "保存先の別の場所に、この記録の本体があります。外部の変更の確認で、移動として反映されます。";
      item.evidence = ["same id found elsewhere in the vault"];
    } else if (scanSkipped > 0) {
      item.category = "undetermined";
      item.message = "保存先に読み込めないファイルがあるため、この記録の本体が無いことを確認できません。";
      item.evidence = [`unreadable tsumugi files: ${scanSkipped}`];
    } else if (inIdb) {
      item.category = "restorable";
      item.message = "この端末に記録が残っています。保存先に戻せる可能性があるため、整理しません。";
      item.evidence = ["record exists in IndexedDB"];
    } else if (inArchive) {
      item.category = "restorable";
      item.message = "退避先に、この記録のコピーがあります。戻せる可能性があるため、整理しません。";
      item.evidence = ["same id found in the archive"];
    } else {
      item.category = "orphan";
      item.message = "保存先に本体が見つからず、この端末にも復元元がない記録です。管理情報だけが残っているため整理できます。";
      item.evidence = [
        "registered path is absent",
        "no record with the same id in the vault (scan complete)",
        "no copy in the archive",
        "no record in IndexedDB",
        "registry / history / index readable",
      ];
    }
    items.push(item);
  }
  const orphans = items.filter((i) => i.category === "orphan");
  return { registryReadable: snapshot.completed, items, orphans, others: items.filter((i) => i.category !== "orphan") };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export interface OrphanStepResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface OrphanItemResult {
  key: string;
  outcome: "cleaned" | "skipped" | "failed";
  message?: string;
  steps: OrphanStepResult[];
}

export interface OrphanCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export type OrphanCleanupStatus = "complete" | "partial" | "interrupted" | "refused" | "nothing-to-do";

export interface OrphanCleanupResult {
  status: OrphanCleanupStatus;
  items: OrphanItemResult[];
  cleanedCount: number;
  failedCount: number;
  skippedCount: number;
  postChecks: OrphanCheck[];
  remaining: { orphans: number; others: number } | null;
}

interface OrphanArchiveRecord {
  schemaVersion: 1;
  archivedAt: string;
  registryKey: string;
  kind: VaultOrphanRecordKind;
  registry: { path: string; entry: VaultRegistryFileEntry };
  index: { path: string | null };
  history: VaultHistoryRowRef[];
  ledger: { key: string; value: string | null };
  relatedMemoryIds: string[];
  note: string;
}

interface OrphanManifest {
  schemaVersion: 1;
  entries: { registryKey: string; archivePath: string; sha256: string; archivedAt: string }[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readTextIfExists(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const segments = path.split("/");
  try {
    const dir = await resolveDir(root, segments.slice(0, -1), false);
    const handle = await dir.getFileHandle(segments[segments.length - 1], { create: false });
    return await (await handle.getFile()).text();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeText(root: FileSystemDirectoryHandle, path: string, text: string): Promise<void> {
  const segments = path.split("/");
  const dir = await resolveDir(root, segments.slice(0, -1), true);
  const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/** 整理前の管理情報をarchiveへ退避し、SHA-256で検証する。既に退避済み（再実行）なら、それを再利用する。 */
async function archiveManagementInfo(
  root: FileSystemDirectoryHandle,
  item: MissingRecordItem,
  entry: VaultRegistryFileEntry
): Promise<{ record: OrphanArchiveRecord; sha256: string; archivePath: string }> {
  const kind = item.kind as VaultOrphanRecordKind;
  const archivePath = `${ARCHIVE_ROOT}/${ORPHAN_ARCHIVE_DIR}/${ORPHAN_RECORDS_DIR}/${kind}-${item.key}.json`;
  const existing = await readTextIfExists(root, archivePath);
  if (existing !== null && existing.trim().length > 0) {
    // 再実行：最初の実行で、全ての管理情報が残っていた時点の退避を、そのまま使う（途中まで整理済みの
    // 今の状態から作り直すと、情報が欠けるため）。
    const record = JSON.parse(existing) as OrphanArchiveRecord;
    if (record.registryKey !== item.key) throw new Error("既存の退避ファイルが、別の記録のものです");
    const sha = await sha256Hex(new TextEncoder().encode(existing));
    return { record, sha256: sha, archivePath };
  }
  const ledgerKey = vaultSyncKeyFor(ledgerKindOf(kind), item.key);
  const record: OrphanArchiveRecord = {
    schemaVersion: 1,
    archivedAt: new Date().toISOString(),
    registryKey: item.key,
    kind,
    registry: { path: item.path, entry },
    index: { path: item.indexPath ?? null },
    history: item.historyRows,
    ledger: { key: ledgerKey, value: (await getVaultSyncState(ledgerKey)) ?? null },
    relatedMemoryIds: item.relatedMemories.map((m) => m.id),
    note: "本体が見つからず復元元も無い記録の管理情報を、整理する前に退避したもの。",
  };
  const text = JSON.stringify(record, null, 2);
  await writeText(root, archivePath, text);
  const back = await readTextIfExists(root, archivePath);
  const written = await sha256Hex(new TextEncoder().encode(text));
  if (back === null || (await sha256Hex(new TextEncoder().encode(back))) !== written) {
    throw new Error("退避した管理情報の検証（SHA-256）に失敗しました");
  }
  return { record, sha256: written, archivePath };
}

async function updateManifest(root: FileSystemDirectoryHandle, entry: OrphanManifest["entries"][number]): Promise<void> {
  const path = `${ARCHIVE_ROOT}/${ORPHAN_ARCHIVE_DIR}/${MANIFEST_NAME}`;
  const existing = await readTextIfExists(root, path);
  let manifest: OrphanManifest = { schemaVersion: 1, entries: [] };
  if (existing !== null && existing.trim().length > 0) {
    manifest = JSON.parse(existing) as OrphanManifest;
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) throw new Error("退避の一覧（manifest）を読み込めません");
  }
  if (manifest.entries.some((e) => e.registryKey === entry.registryKey)) return; // 冪等
  manifest.entries.push(entry);
  await writeText(root, path, JSON.stringify(manifest, null, 2));
}

interface MarkdownStat {
  size: number;
  mtime: number;
}

async function collectMarkdownStats(root: FileSystemDirectoryHandle): Promise<Map<string, MarkdownStat>> {
  const out = new Map<string, MarkdownStat>();
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, inside: boolean, depth: number): Promise<void> => {
    if (depth > 8) return;
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        await walk(handle as FileSystemDirectoryHandle, path, inside || ["Conversations", "Memories", "Sources"].includes(name), depth + 1);
      } else if (inside && name.endsWith(".md")) {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.set(path, { size: file.size, mtime: file.lastModified });
      }
    }
  };
  await walk(root, "", false, 0);
  return out;
}

/**
 * 実行。ユーザーが内容を確認して、明示的に「整理する」を押した場合だけ呼ぶ。呼び出し元が
 * `runVaultWorldExclusive`を保持している前提。実行時に全条件を検証し直し、通った記録だけを整理する。
 * `isStale`がtrueを返したら、次の記録・Registry削除の前に中断する（再実行で残りを完了できる）。
 */
export async function executeOrphanCleanup(
  root: FileSystemDirectoryHandle,
  keys: string[],
  isStale?: () => boolean
): Promise<OrphanCleanupResult> {
  const result: OrphanCleanupResult = {
    status: "complete",
    items: [],
    cleanedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    postChecks: [],
    remaining: null,
  };
  if (keys.length === 0) return { ...result, status: "nothing-to-do" };

  const plan = await planOrphanCleanup(root);
  const orphanByKey = new Map(plan.orphans.map((i) => [i.key, i]));
  const otherByKey = new Map(plan.others.map((i) => [i.key, i]));
  const snapshot = await readVaultRegistrySnapshotStrict(root);
  const beforeStats = await collectMarkdownStats(root);
  const beforeCounts = {
    conversations: (await getAllConversations()).length,
    memories: (await getAllMemoryObjects()).length,
    sources: (await getAllSources()).length,
  };
  const baselineBefore = (await readVaultRegistryMeta(root)).baselineEstablishedAt;
  const cleaned: { item: MissingRecordItem; archivePath: string; sha256: string; months: string[] }[] = [];

  for (const key of [...keys].sort()) {
    if (isStale?.()) {
      finalize(result);
      return { ...result, status: "interrupted" };
    }
    const steps: OrphanStepResult[] = [];
    const item = orphanByKey.get(key);
    if (!item) {
      const other = otherByKey.get(key);
      result.items.push({
        key,
        outcome: "skipped",
        message: other ? other.message : "状況が変わったため、今回は整理しませんでした。もう一度確認してください。",
        steps,
      });
      continue;
    }
    const entry = snapshot.files.get(item.path);
    if (!entry) {
      result.items.push({ key, outcome: "skipped", message: "状況が変わったため、今回は整理しませんでした。もう一度確認してください。", steps });
      continue;
    }
    const kind = item.kind as VaultOrphanRecordKind;
    const step = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
      try {
        await fn();
        steps.push({ name, ok: true });
        return true;
      } catch (error) {
        steps.push({ name, ok: false, detail: errorMessage(error) });
        return false;
      }
    };

    let archived: Awaited<ReturnType<typeof archiveManagementInfo>> | null = null;
    // 1. 整理前の管理情報を退避（SHA-256で検証）
    if (
      !(await step("管理情報を退避", async () => {
        archived = await archiveManagementInfo(root, item, entry);
        await updateManifest(root, {
          registryKey: key,
          archivePath: archived.archivePath,
          sha256: archived.sha256,
          archivedAt: archived.record.archivedAt,
        });
      })) ||
      !archived
    ) {
      result.items.push({ key, outcome: "failed", message: "整理前の管理情報を退避できなかったため、何も変更しませんでした。", steps });
      continue;
    }
    const archivedRecord: Awaited<ReturnType<typeof archiveManagementInfo>> = archived;
    const months = [...new Set(archivedRecord.record.history.map((row) => row.month))];

    // 2. History → index.json → 台帳 → Registry（最後）。1つでも失敗したら、以降（特にRegistry）へ進まない。
    let ok = true;
    if (kind === "conversation" || kind === "reflection") {
      ok = await step("履歴の行を削除", async () => {
        await removeVaultHistoryRecordRows(root, kind, key, months);
      });
    }
    if (ok) ok = await step("索引（index.json）から削除", async () => void (await removeVaultIndexJsonKey(root, key)));
    if (ok) {
      ok = await step("同期の記録（台帳）を削除", async () => {
        await deleteVaultSyncState(vaultSyncKeyFor(ledgerKindOf(kind), key));
      });
    }
    if (ok && isStale?.()) {
      result.items.push({ key, outcome: "failed", message: "途中で中断しました。もう一度実行すると、続きから完了できます。", steps });
      finalize(result);
      return { ...result, status: "interrupted" };
    }
    if (ok) {
      ok = await step("Registryの管理情報を削除", async () => {
        await removeVaultRegistrySingleRecordEntry(root, key, item.path);
      });
    }
    if (ok) {
      cleaned.push({ item, archivePath: archivedRecord.archivePath, sha256: archivedRecord.sha256, months });
      result.items.push({ key, outcome: "cleaned", steps });
    } else {
      const failedStep = steps.find((s) => !s.ok);
      const refused = failedStep?.detail?.includes("refusing to remove registry entry");
      result.items.push({
        key,
        outcome: refused ? "skipped" : "failed",
        message: refused
          ? "状況が変わったため、Registryの管理情報は削除しませんでした。もう一度確認してください。"
          : "一部の管理情報を整理できませんでした。もう一度実行すると、続きから完了できます。",
        steps,
      });
    }
  }
  finalize(result);

  // post-check：保存先を読み直して確認する。
  const checks: OrphanCheck[] = [];
  const afterSnapshot = await readVaultRegistrySnapshotStrict(root);
  const manifestText = await readTextIfExists(root, `${ARCHIVE_ROOT}/${ORPHAN_ARCHIVE_DIR}/${MANIFEST_NAME}`).catch(() => null);
  for (const c of cleaned) {
    const trace = await inspectVaultManagementTrace(root, c.item.kind as VaultOrphanRecordKind, c.item.key);
    const ledger = await getVaultSyncState(vaultSyncKeyFor(ledgerKindOf(c.item.kind as VaultOrphanRecordKind), c.item.key));
    const archiveText = await readTextIfExists(root, c.archivePath).catch(() => null);
    const archiveSha = archiveText === null ? null : await sha256Hex(new TextEncoder().encode(archiveText));
    const consistent = await isVaultHistoryMonthAggregateConsistent(root, c.months);
    const problems = [
      afterSnapshot.completed && !afterSnapshot.records.has(c.item.key) ? null : "Registryに管理情報が残っている（または読めない）",
      trace.ok && trace.historyRows.length === 0 ? null : "履歴に行が残っている（または読めない）",
      trace.ok && trace.indexPath === undefined ? null : "索引に残っている（または読めない）",
      ledger === undefined ? null : "同期の記録（台帳）が残っている",
      consistent ? null : "履歴の集計が一致しない",
      archiveSha === c.sha256 && manifestText !== null && manifestText.includes(c.sha256) ? null : "退避した管理情報を確認できない",
    ].filter((p): p is string => p !== null);
    checks.push({ name: `整理を確認：${c.item.title}`, ok: problems.length === 0, detail: problems.join(" / ") || undefined });
  }
  const afterStats = await collectMarkdownStats(root);
  const changed = [...beforeStats].filter(([path, stat]) => {
    const now = afterStats.get(path);
    return now === undefined || now.size !== stat.size || now.mtime !== stat.mtime;
  });
  const added = [...afterStats.keys()].filter((path) => !beforeStats.has(path));
  checks.push({
    name: "記憶・会話などのMarkdownファイルが変更されていない",
    ok: changed.length === 0 && added.length === 0,
    detail: [...changed.map(([p]) => p), ...added].slice(0, 3).join(", ") || undefined,
  });
  const afterCounts = {
    conversations: (await getAllConversations()).length,
    memories: (await getAllMemoryObjects()).length,
    sources: (await getAllSources()).length,
  };
  checks.push({
    name: "この端末の記録の件数が変わっていない",
    ok:
      afterCounts.conversations === beforeCounts.conversations &&
      afterCounts.memories === beforeCounts.memories &&
      afterCounts.sources === beforeCounts.sources,
  });
  checks.push({ name: "baselineが変わっていない", ok: (await readVaultRegistryMeta(root)).baselineEstablishedAt === baselineBefore });
  result.postChecks = checks;

  const remaining = await planOrphanCleanup(root);
  result.remaining = { orphans: remaining.orphans.length, others: remaining.others.length };
  result.status = result.failedCount === 0 && result.skippedCount === 0 && checks.every((c) => c.ok) ? "complete" : "partial";
  if (result.cleanedCount === 0 && result.failedCount === 0 && result.skippedCount > 0) result.status = "refused";
  return result;
}

function finalize(result: OrphanCleanupResult): void {
  result.cleanedCount = result.items.filter((i) => i.outcome === "cleaned").length;
  result.failedCount = result.items.filter((i) => i.outcome === "failed").length;
  result.skippedCount = result.items.filter((i) => i.outcome === "skipped").length;
}

/** テスト・UIから、Registry削除の拒否（状況が変わった）を区別するための再export。 */
export { VaultRegistryEntryRemovalRefusedError };
