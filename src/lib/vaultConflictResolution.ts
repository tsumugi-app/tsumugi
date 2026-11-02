/**
 * 端末と保存先で内容が食い違う記録（Outboxに保留された`*-conflict`・確認で「内容が異なる」と分類された記録）を、ユーザーの選択で解決する。
 *
 * 原則：
 *   - 自動では決めない。新旧を判断できないときの既定は「両方保持」。
 *   - 選択肢は、そのときの実体で安全に実行できるものだけを出す。
 *   - 実行の前に、端末と保存先全体のバックアップ（読み戻して照合済みのZIP）と、この記録の両方の版（`.tsumugi/conflict-versions/`）を残す。
 *   - 実行の直前に排他区間の中で読み直し、ユーザーが見たときと少しでも違えば何も変えずに中止する。
 *   - 別に保管した版は隠しフォルダの中のJSONなので、履歴・AIの記憶・保存先の走査には現れない（同じ記録が二重にならない）。
 *   - 手順はどこで止まっても元の版が残り、続きは通常の保存か同じ操作のやり直しで完了する（journalは持たない）。
 *
 * 同じ日のファイルでは、対象の記録の部分だけを置き換える（他の記録・手書きの部分は1バイトも変えない）。
 * ファイルを書いた後のRegistry・目次・同期済み台帳の更新は、通常の保存（Outbox）が行う。
 */
import {
  adoptVaultVersionWithOutbox, getConversation, getMemoryObject, getSource, getTombstone, getVaultOutboxEntry, isMemoryBlockedByTombstone,
  RecoveryPendingError, requeueRecordForVault, VaultVersionChangedError,
} from "./db";
import { findRecordInVault } from "./dataLifecycle";
import { conversationToMarkdown, MEMORY_ENTRY_SEPARATOR, memoryObjectToMarkdown, parseConversationMarkdown, parseMemoryDayFile, parseMemoryObjectMarkdown, parseSourceMarkdown, sourceToMarkdown } from "./markdown";
import type { Conversation, MemoryObject, Source } from "./types";
import { dayFileNameFor, dayFileRegistryKey, fileNameFor, isReflectionSummary, vaultRegistryBucketOf } from "./vault";
import { reverifyBackup, type AutoRepairEnv } from "./vaultAutoRepair";
import { sha256Hex } from "./vaultBackup";
import type { ConsistencyReport, RepairTarget } from "./vaultConsistency";
import { isRecoveryBlockingNormalWrites } from "./vaultRecoveryJournal";
import { decodeVaultText, MEMORY_EVOLVING_KEYS, rewriteKeepsContent, VaultFileNotUtf8Error, withMemoryDayFileLock } from "./vaultRewriteSafety";
import { withVaultSaveLock } from "./vaultSaveLock";
import { writeFileHandleContent } from "./vaultWriter";

export const KEPT_VERSIONS_DIR = ".tsumugi/conflict-versions";

export type ConflictRecordType = "conversation" | "memory" | "reflection" | "source";
export interface ConflictRef { recordType: ConflictRecordType; recordId: string }
type LocalRecord = Conversation | MemoryObject | Source;

/**
 * keep-both     端末の版を使い続け、保存先の版を別に保管して一覧に残す（既定）
 * adopt-device  端末の版を採用する。保存先の版は退避するが一覧には出さない
 * adopt-vault   保存先の版を採用する。端末の版は退避する
 * resume        両方が既に同じ、または保存先のファイルが無い：保存を再開するだけ（どちらの版も変わらない）
 */
export type ConflictChoice = "keep-both" | "adopt-device" | "adopt-vault" | "resume";

export type ConflictBlockReason =
  | "device-missing" | "tombstoned" | "file-unreadable" | "registry-unreadable" | "stored-elsewhere" | "not-separable" | "duplicate-in-file" | "unparseable" | "repair-in-progress";
export type AdoptVaultBlockReason = "would-lose-content" | "identity-differs" | "active-conversation";

/** ユーザーが見た状態。実行の直前に読み直して、1つでも違えば中止する */
export interface ConflictSnapshot {
  recordType: ConflictRecordType;
  recordId: string;
  path: string;
  deviceUpdatedAt: string;
  deviceSha: string;
  fileSha: string | null;
  registrySha: string;
  outboxUpdatedAt: string | null;
}

export interface DiffLine { kind: "same" | "device" | "vault"; text: string }

export interface ConflictView {
  ref: ConflictRef;
  state: "differs" | "same" | "absent" | "blocked";
  blockReason?: ConflictBlockReason;
  adoptVaultBlock?: AdoptVaultBlockReason;
  date?: string;
  snapshot?: ConflictSnapshot;
  deviceText?: string;
  vaultText?: string;
  diff?: DiffLine[];
  /** 実行できる選択肢だけ（先頭が既定） */
  choices: ConflictChoice[];
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

async function readBytes(root: FileSystemDirectoryHandle, path: string): Promise<Uint8Array | null | "unreadable"> {
  const parts = path.split("/");
  let dir = root;
  try {
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(parts[parts.length - 1]);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    const name = error instanceof DOMException || error instanceof Error ? error.name : "";
    return name === "NotFoundError" || name === "TypeMismatchError" ? null : "unreadable";
  }
}

const shaOfText = (text: string) => sha256Hex(new TextEncoder().encode(text));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function recordToMarkdown(type: ConflictRecordType, record: LocalRecord): string {
  if (type === "conversation") return conversationToMarkdown(record as Conversation);
  if (type === "source") return sourceToMarkdown(record as Source);
  return memoryObjectToMarkdown(record as MemoryObject);
}

function parseVersion(type: ConflictRecordType, text: string): LocalRecord | null {
  try {
    if (type === "conversation") return parseConversationMarkdown(text);
    if (type === "source") return parseSourceMarkdown(text);
    return parseMemoryObjectMarkdown(text.trim());
  } catch { return null; }
}

/** 既定のファイルの場所（通常の保存が使うものと同じ） */
function defaultPathOf(type: ConflictRecordType, record: LocalRecord): string {
  if (type === "conversation") return `Conversations/${fileNameFor(record.id, (record as Conversation).startedAt)}`;
  if (type === "source") return `Sources/${fileNameFor(record.id, record.createdAt)}`;
  if (type === "reflection") return `Memories/${fileNameFor(record.id, (record as MemoryObject).date)}`;
  return `Memories/${dayFileNameFor((record as MemoryObject).date)}`;
}

const registryShardPathOf = (key: string) => `.tsumugi/registry/${vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`;
const registryKeyOf = (type: ConflictRecordType, record: LocalRecord) => (type === "memory" ? dayFileRegistryKey((record as MemoryObject).date.slice(0, 10)) : record.id);

/** Registryの、この記録のファイルの場所と行。読めないときはnull（場所を証明できないので進めない） */
async function readRegistryRow(root: FileSystemDirectoryHandle, key: string): Promise<{ path: string | null; sha: string } | null> {
  const bytes = await readBytes(root, registryShardPathOf(key));
  if (bytes === "unreadable") return null;
  if (bytes === null) return { path: null, sha: await shaOfText("absent") };
  let value: unknown;
  try { value = JSON.parse(decodeVaultText(bytes)); } catch { return null; }
  if (!isObj(value) || !isObj(value.records) || !isObj(value.files)) return null;
  const path = value.records[key];
  if (path !== undefined && typeof path !== "string") return null;
  return { path: path ?? null, sha: await shaOfText(JSON.stringify([path ?? null, typeof path === "string" ? value.files[path] ?? null : null])) };
}

async function readDevice(ref: ConflictRef): Promise<{ type: ConflictRecordType; record: LocalRecord; outboxUpdatedAt: string | null } | null> {
  if (ref.recordType === "conversation") {
    const record = await getConversation(ref.recordId);
    return record ? { type: "conversation", record, outboxUpdatedAt: (await getVaultOutboxEntry(`conversation:${ref.recordId}`))?.updatedAt ?? null } : null;
  }
  if (ref.recordType === "source") {
    const record = await getSource(ref.recordId);
    return record ? { type: "source", record, outboxUpdatedAt: (await getVaultOutboxEntry(`source:${ref.recordId}`))?.updatedAt ?? null } : null;
  }
  const record = await getMemoryObject(ref.recordId);
  if (!record) return null;
  // 保留されたOutboxの種類が、ファイルの形（1記録1ファイルか日別か）も決める
  const asMemory = await getVaultOutboxEntry(`memory:${ref.recordId}`);
  const asReflection = await getVaultOutboxEntry(`reflection:${ref.recordId}`);
  const entry = asMemory ?? asReflection;
  const type: ConflictRecordType = entry ? (entry.recordType as ConflictRecordType) : isReflectionSummary(record) ? "reflection" : "memory";
  return { type, record, outboxUpdatedAt: entry?.updatedAt ?? null };
}

type Located =
  | { kind: "whole"; version: string }
  | { kind: "segment"; version: string; index: number; segments: string[] };

function locateVersion(type: ConflictRecordType, fileText: string, id: string): Located | ConflictBlockReason | "absent" {
  if (type !== "memory") {
    const parsed = parseVersion(type, fileText);
    return !parsed ? "unparseable" : parsed.id !== id ? "stored-elsewhere" : { kind: "whole", version: fileText };
  }
  const segments = fileText.split(MEMORY_ENTRY_SEPARATOR);
  const parsed = segments.map((s) => (s.trim().length > 0 ? parseMemoryObjectMarkdown(s.trim()) : null));
  const indexes = parsed.flatMap((m, i) => (m?.id === id ? [i] : []));
  if (indexes.length > 1) return "duplicate-in-file";
  if (indexes.length === 0) return segments.some((s, i) => parsed[i] === null && s.includes(id)) ? "not-separable" : "absent";
  return { kind: "segment", version: segments[indexes[0]], index: indexes[0], segments };
}

/** 対象の版だけを置き換えたファイルの内容。読み直して、他の部分がそのままで対象が読めることを確かめる（確かめられなければnull） */
function fileWithVersion(located: Located, id: string, next: string): string | null {
  if (located.kind === "whole") return next;
  const content = located.segments.map((s, i) => (i === located.index ? next : s)).join(MEMORY_ENTRY_SEPARATOR);
  const before = located.segments.filter((s) => s.trim().length > 0 && parseMemoryObjectMarkdown(s.trim()) !== null).length;
  const after = parseMemoryDayFile(content);
  if (after.length !== before || after.filter((m) => m.id === id).length !== 1) return null;
  const again = content.split(MEMORY_ENTRY_SEPARATOR);
  return again.length === located.segments.length && again.every((s, i) => i === located.index || s === located.segments[i]) ? content : null;
}

// ---------------------------------------------------------------------------
// 保存先の版を採用できるか
// ---------------------------------------------------------------------------

const CONVERSATION_DERIVED_KEYS: ReadonlySet<string> = new Set(["updatedAt", "turnTimes"]);

/** 保存先の版のうち、Markdownが持つ項目だけを端末の記録に重ねる（Markdownに無い項目は端末の値を保つ） */
function mergedVaultVersion(type: ConflictRecordType, device: LocalRecord, parsed: LocalRecord, updatedAt: string): LocalRecord {
  if (type === "conversation") {
    const d = device as Conversation, p = parsed as Conversation;
    return {
      ...d, persona: p.persona, entryType: p.entryType, status: p.status, title: p.title, startedAt: p.startedAt, endedAt: p.endedAt, memoryObjectIds: p.memoryObjectIds,
      // 発言の内容が同じ位置にあれば、Markdownに無い項目（検索の有無等）はそのまま
      turns: p.turns.map((turn, i) => {
        const same = d.turns[i];
        return same && same.role === turn.role && same.content === turn.content ? { ...same, timestamp: turn.timestamp } : turn;
      }),
      metadata: { ...d.metadata, schemaVersion: p.metadata.schemaVersion, source: p.metadata.source, sourceType: p.metadata.sourceType, sourceDetail: p.metadata.sourceDetail, updatedAt },
      updatedAt,
    };
  }
  if (type === "source") {
    const p = parsed as Source;
    return { ...(device as Source), sourceType: p.sourceType, title: p.title, content: p.content, sourceDetail: p.sourceDetail, attachmentId: p.attachmentId, updatedAt };
  }
  const d = device as MemoryObject, p = parsed as MemoryObject;
  return {
    ...d, types: p.types, keywords: p.keywords, topicId: p.topicId, eventTime: p.eventTime, eventTimePrecision: p.eventTimePrecision, statedAt: p.statedAt,
    summary: p.summary, content: p.content, links: p.links, profileClaims: p.profileClaims, personMentions: p.personMentions, topicEvents: p.topicEvents, evidenceQuotes: p.evidenceQuotes,
    metadata: { ...d.metadata, source: p.metadata.source, sourceType: p.metadata.sourceType, sourceDetail: p.metadata.sourceDetail, aiProvider: p.metadata.aiProvider, confidence: p.metadata.confidence, schemaVersion: p.metadata.schemaVersion, updatedAt },
    updatedAt,
  };
}

function identityMatches(type: ConflictRecordType, device: LocalRecord, parsed: LocalRecord): boolean {
  if (device.id !== parsed.id || device.createdAt !== parsed.createdAt) return false;
  if (type === "conversation") return (device as Conversation).startedAt.slice(0, 10) === (parsed as Conversation).startedAt.slice(0, 10);
  if (type === "source") return true;
  const d = device as MemoryObject, p = parsed as MemoryObject;
  return d.date.slice(0, 10) === p.date.slice(0, 10) && (d.conversationId ?? undefined) === (p.conversationId ?? undefined);
}

/** 保存先の版を、書かれている内容を失わずに端末の記録にできるか。理由があれば採用の選択肢を出さない */
function adoptVaultBlockOf(type: ConflictRecordType, device: LocalRecord, vaultText: string, activeConversationId: string | null | undefined): AdoptVaultBlockReason | undefined {
  if (type === "conversation" && device.id === activeConversationId) return "active-conversation";
  const parsed = parseVersion(type, vaultText);
  if (!parsed || !identityMatches(type, device, parsed)) return "identity-differs";
  const merged = mergedVaultVersion(type, device, parsed, device.updatedAt);
  return rewriteKeepsContent(vaultText, recordToMarkdown(type, merged), type === "conversation" ? CONVERSATION_DERIVED_KEYS : MEMORY_EVOLVING_KEYS, "same") ? undefined : "would-lose-content";
}

// ---------------------------------------------------------------------------
// 差分（行単位）
// ---------------------------------------------------------------------------

const DIFF_LINE_LIMIT = 4000;

export function lineDiff(deviceText: string, vaultText: string): DiffLine[] {
  const a = deviceText.split("\n"), b = vaultText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const same = (lines: string[]): DiffLine[] => lines.map((text) => ({ kind: "same", text }));
  const n = endA - start, m = endB - start;
  let middle: DiffLine[];
  if (n * m > DIFF_LINE_LIMIT * DIFF_LINE_LIMIT / 4 || n > DIFF_LINE_LIMIT || m > DIFF_LINE_LIMIT) {
    // 大きすぎるときは対応付けない（全部を変更として見せる。隠さない）
    middle = [...a.slice(start, endA).map((text): DiffLine => ({ kind: "device", text })), ...b.slice(start, endB).map((text): DiffLine => ({ kind: "vault", text }))];
  } else {
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[start + i] === b[start + j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    middle = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { middle.push({ kind: "same", text: a[start + i] }); i++; j++; }
      else if (j >= m || (i < n && table[i + 1][j] >= table[i][j + 1])) middle.push({ kind: "device", text: a[start + i++] });
      else middle.push({ kind: "vault", text: b[start + j++] });
    }
  }
  return [...same(a.slice(0, start)), ...middle, ...same(a.slice(endA))];
}

// ---------------------------------------------------------------------------
// 判定（読むだけ）
// ---------------------------------------------------------------------------

interface Inspected { view: ConflictView; located?: Located; device?: LocalRecord; fileText?: string | null }

async function inspect(root: FileSystemDirectoryHandle, ref: ConflictRef, activeConversationId?: string | null): Promise<Inspected> {
  const blocked = (blockReason: ConflictBlockReason, date?: string): Inspected => ({ view: { ref, state: "blocked", blockReason, date, choices: [] } });
  if (await isRecoveryBlockingNormalWrites()) return blocked("repair-in-progress");
  const found = await readDevice(ref);
  if (!found) return blocked("device-missing");
  const { type, record, outboxUpdatedAt } = found;
  const date = type === "conversation" ? (record as Conversation).startedAt.slice(0, 10) : type === "source" ? record.createdAt.slice(0, 10) : (record as MemoryObject).date.slice(0, 10);
  const tombstoned = type === "conversation" ? !!(await getTombstone("conversation", record.id)) : type === "source" ? false : await isMemoryBlockedByTombstone(record as MemoryObject);
  if (tombstoned) return blocked("tombstoned", date);
  const registry = await readRegistryRow(root, registryKeyOf(type, record));
  if (!registry) return blocked("registry-unreadable", date);
  const path = registry.path ?? defaultPathOf(type, record);
  const bytes = await readBytes(root, path);
  if (bytes === "unreadable") return blocked("file-unreadable", date);
  const deviceText = recordToMarkdown(type, record);
  const base = { recordType: type, recordId: record.id, path, deviceUpdatedAt: record.updatedAt, deviceSha: await shaOfText(JSON.stringify(record)), registrySha: registry.sha, outboxUpdatedAt };
  const nextRef: ConflictRef = { recordType: type, recordId: record.id };
  const absent = async (): Promise<Inspected> => {
    // 見込みの場所に無いだけで、別の場所にあるかもしれない。無いと確かめられたときだけ保存を再開する（二重に作らない）
    if ((await findRecordInVault(root, record.id)) !== "absent") return blocked("stored-elsewhere", date);
    return { view: { ref: nextRef, state: "absent", date, snapshot: { ...base, fileSha: bytes === null ? null : await sha256Hex(bytes as Uint8Array) }, deviceText, choices: ["resume"] }, device: record, fileText: null };
  };
  if (bytes === null) return absent();
  let fileText: string;
  try { fileText = decodeVaultText(bytes); }
  catch (error) { if (error instanceof VaultFileNotUtf8Error) return blocked("file-unreadable", date); throw error; }
  const located = locateVersion(type, fileText, record.id);
  if (located === "absent") return absent();
  if (typeof located === "string") return blocked(located, date);
  const snapshot: ConflictSnapshot = { ...base, fileSha: await sha256Hex(bytes) };
  const same = located.version.trim() === deviceText.trim();
  if (same) return { view: { ref: nextRef, state: "same", date, snapshot, deviceText, vaultText: located.version, choices: ["resume"] }, located, device: record, fileText };
  if (fileWithVersion(located, record.id, deviceText) === null) return blocked("not-separable", date);
  const adoptVaultBlock = adoptVaultBlockOf(type, record, located.version, activeConversationId);
  const choices: ConflictChoice[] = ["keep-both", "adopt-device", ...(adoptVaultBlock ? [] : (["adopt-vault"] as const))];
  return { view: { ref: nextRef, state: "differs", date, snapshot, deviceText, vaultText: located.version, diff: lineDiff(deviceText, located.version), adoptVaultBlock, choices }, located, device: record, fileText };
}

export const inspectConflict = async (root: FileSystemDirectoryHandle, ref: ConflictRef, activeConversationId?: string | null): Promise<ConflictView> => (await inspect(root, ref, activeConversationId)).view;

const sameSnapshot = (a: ConflictSnapshot, b: ConflictSnapshot | undefined) => !!b && (Object.keys(a) as (keyof ConflictSnapshot)[]).every((k) => a[k] === b[k]);

// ---------------------------------------------------------------------------
// 別に保管する版（追加するだけ。書き換えない・消さない）
// ---------------------------------------------------------------------------

export interface KeptVersion {
  format: "tsumugi-conflict-version";
  version: 1;
  id: string;
  createdAt: string;
  choice: ConflictChoice;
  recordType: ConflictRecordType;
  recordId: string;
  path: string;
  fileSha: string | null;
  deviceUpdatedAt: string;
  /** 端末の記録の全体（Markdownに無い項目も含む） */
  deviceRaw: string;
  deviceMarkdown: string;
  vaultText: string;
  sha256: string;
}

const keptPayload = (k: Omit<KeptVersion, "sha256"> | KeptVersion) => JSON.stringify([k.id, k.createdAt, k.choice, k.recordType, k.recordId, k.path, k.fileSha, k.deviceUpdatedAt, k.deviceRaw, k.deviceMarkdown, k.vaultText]);

async function parseKept(text: string): Promise<KeptVersion | null> {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || v.format !== "tsumugi-conflict-version" || v.version !== 1) return null;
  const k = v as unknown as KeptVersion;
  if (typeof k.vaultText !== "string" || typeof k.deviceRaw !== "string" || typeof k.deviceMarkdown !== "string") return null;
  return (await shaOfText(keptPayload(k))) === k.sha256 ? k : null;
}

/** 途中で切れたファイルは、UTF-8としても読めないことがある */
async function parseKeptBytes(bytes: Uint8Array): Promise<KeptVersion | null> {
  try { return await parseKept(decodeVaultText(bytes)); } catch (error) { if (error instanceof VaultFileNotUtf8Error) return null; throw error; }
}

/**
 * 同じ版・同じ選択なら同じ名前（やり直しても増えない）。作った後に読み戻して照合する。照合できる既存のものは書き換えない。
 * 照合できないものは、前回の書き込みが途中で止まった跡として作り直す：名前が両方の版から決まるので、入るべき内容は今の両方の版そのもの（呼び出し側が排他区間で読み直した版）で、失うものは無い。
 */
async function writeKeptVersion(root: FileSystemDirectoryHandle, input: Omit<KeptVersion, "format" | "version" | "id" | "sha256">): Promise<KeptVersion> {
  const id = (await shaOfText(JSON.stringify([input.recordType, input.recordId, input.deviceRaw, input.vaultText, input.choice]))).slice(0, 32);
  const path = `${KEPT_VERSIONS_DIR}/${id}.json`;
  const existing = await readBytes(root, path);
  if (existing === "unreadable") throw new Error("kept-version-unreadable");
  if (existing !== null) {
    const kept = await parseKeptBytes(existing);
    if (kept?.id === id) return kept;
  }
  const body = { format: "tsumugi-conflict-version" as const, version: 1 as const, id, ...input };
  const kept: KeptVersion = { ...body, sha256: await shaOfText(keptPayload(body)) };
  let dir = root;
  for (const part of KEPT_VERSIONS_DIR.split("/")) dir = await dir.getDirectoryHandle(part, { create: true });
  await writeFileHandleContent(await dir.getFileHandle(`${id}.json`, { create: true }), JSON.stringify(kept));
  const back = await readBytes(root, path);
  if (back === null || back === "unreadable" || (await parseKeptBytes(back))?.id !== id) throw new Error("kept-version-verify-failed");
  return kept;
}

export interface KeptVersionList { versions: KeptVersion[]; unreadable: number }

/** 保管している版の一覧（読むだけ）。読めないものは数だけ返す（無かったことにしない） */
export async function listKeptVersions(root: FileSystemDirectoryHandle): Promise<KeptVersionList> {
  const out: KeptVersionList = { versions: [], unreadable: 0 };
  let dir = root;
  try { for (const part of KEPT_VERSIONS_DIR.split("/")) dir = await dir.getDirectoryHandle(part); }
  catch { return out; }
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== "file" || !name.endsWith(".json")) continue;
    try {
      const kept = await parseKept(decodeVaultText(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer()));
      if (kept) out.versions.push(kept); else out.unreadable++;
    } catch { out.unreadable++; }
  }
  out.versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export type ConflictNotStarted =
  | "changed"            // 見たときから端末・ファイル・Registry・Outboxのどれかが変わった
  | "choice-unavailable" // 今の実体では、その選択肢を安全に実行できない
  | "backup-failed" | "backup-unverified" | "busy" | "cancelled" | "repair-in-progress";

export type ConflictOutcome =
  | { kind: "not-started"; reason: ConflictNotStarted }
  /** 途中で止まった。元の版は保管されている。もう一度開いて同じ操作をやり直せる */
  | { kind: "stopped"; stage: "kept-version" | "device" | "file" | "requeue"; kept: string | null; after: ConsistencyReport | null }
  /** `resolved`は、もう一度確認した結果でこの記録の問題が無くなったときだけtrue */
  | { kind: "done"; choice: ConflictChoice; kept: string | null; resolved: boolean; adopted: LocalRecord | null; after: ConsistencyReport };

export type ConflictResolveEnv = Pick<AutoRepairEnv, "check" | "createBackup" | "withExclusive" | "readVaultFile" | "settleSaves" | "isCancelled"> & {
  root: FileSystemDirectoryHandle;
  now(): string;
  activeConversationId?: string | null;
  /** 同じ保存先で先に作った、照合済みのバックアップ。対象が変わっていなければ作り直さない（1件ごとに全体を退避しない） */
  reusableBackup?: { get(): BackupRef | null; set(backup: BackupRef): void };
  /** テスト用：手順の境目で例外を投げて中断を再現する */
  checkpoint?(stage: "after-kept" | "after-device" | "after-file" | "after-requeue"): void | Promise<void>;
};
type BackupRef = { runId: string; size: number; sha256: string };

/** 必ず前の版より新しくする（他のタブの古い版と取り違えない） */
function nextUpdatedAt(now: string, ...versions: string[]): string {
  const floor = Math.max(...versions.map((v) => Date.parse(v)).filter(Number.isFinite));
  const at = Date.parse(now);
  return new Date(Number.isFinite(floor) && !(at > floor) ? floor + 1 : at).toISOString();
}

async function writeFileChecked(root: FileSystemDirectoryHandle, path: string, expectedSha: string | null, content: string): Promise<void> {
  const current = await readBytes(root, path);
  if (current === "unreadable" || (current === null ? null : await sha256Hex(current)) !== expectedSha) throw new Error("file-changed");
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  await writeFileHandleContent(await dir.getFileHandle(parts[parts.length - 1]), content);
  const back = await readBytes(root, path);
  if (back === null || back === "unreadable" || decodeVaultText(back) !== content) throw new Error("file-verify-failed");
}

const targetOf = (s: ConflictSnapshot): RepairTarget => ({ action: "resave", reason: "save-held", recordType: s.recordType, recordId: s.recordId });
/**
 * 確定した確認で、この記録の問題が無くなったときだけ解決と言う。保存が続いて確定できなかったときと、走査が完走しなかったときは、問題が無いとは言えない
 * （読めないファイルがあると、その記録の問題はファイル単位の項目（recordIdなし）にまとめられる）。
 */
export const confirmedResolved = (report: ConsistencyReport, id: string) => report.settled && report.findings.every((f) => f.recordId !== undefined && f.recordId !== id);

async function requeue(s: ConflictSnapshot, version: string): Promise<boolean> {
  const result = await requeueRecordForVault(s.recordType, s.recordId, version);
  return result === "queued" || result === "already-pending";
}

export async function resolveConflict(env: ConflictResolveEnv, seen: ConflictSnapshot, choice: ConflictChoice): Promise<ConflictOutcome> {
  const ref: ConflictRef = { recordType: seen.recordType, recordId: seen.recordId };
  const first = await inspect(env.root, ref, env.activeConversationId);
  if (first.view.blockReason === "repair-in-progress") return { kind: "not-started", reason: "repair-in-progress" };
  if (!sameSnapshot(seen, first.view.snapshot)) return { kind: "not-started", reason: "changed" };
  if (!first.view.choices.includes(choice)) return { kind: "not-started", reason: "choice-unavailable" };
  if (env.isCancelled()) return { kind: "not-started", reason: "cancelled" };

  // 保存を再開するだけ：どちらの版も変わらないので、バックアップは要らない
  if (choice === "resume") {
    const locked = await env.withExclusive(async () => {
      const again = await inspect(env.root, ref, env.activeConversationId);
      if (!sameSnapshot(seen, again.view.snapshot)) return "changed" as const;
      try { return (await requeue(seen, seen.deviceUpdatedAt)) ? ("queued" as const) : ("changed" as const); }
      catch (error) { if (error instanceof RecoveryPendingError) return "repair-in-progress" as const; throw error; }
    });
    if (!locked.ok) return { kind: "not-started", reason: "busy" };
    if (locked.value !== "queued") return { kind: "not-started", reason: locked.value };
    await env.settleSaves([targetOf(seen)]);
    const after = await env.check();
    return { kind: "done", choice, kept: null, resolved: confirmedResolved(after, seen.recordId), adopted: null, after };
  }

  type Ran =
    | { kind: "not-started"; reason: ConflictNotStarted }
    | { kind: "stale-backup" }
    | { kind: "stopped"; stage: "kept-version" | "device" | "file" | "requeue"; kept: string | null }
    | { kind: "applied"; kept: string; adopted: LocalRecord | null };

  const attempt = (backup: BackupRef) => env.withExclusive<Ran>(() => withVaultSaveLock(async (): Promise<Ran> => {
    const verified = await reverifyBackup((p) => env.readVaultFile(p), backup);
    if (!verified.ok) return { kind: "stale-backup" };
    if (env.isCancelled()) return { kind: "not-started", reason: "cancelled" };
    // 排他区間の中で読み直す。これ以降、通常の保存はこの保存先に書かない
    const now = await inspect(env.root, ref, env.activeConversationId);
    if (now.view.blockReason === "repair-in-progress") return { kind: "not-started", reason: "repair-in-progress" };
    if (!sameSnapshot(seen, now.view.snapshot)) return { kind: "not-started", reason: "changed" };
    if (!now.view.choices.includes(choice)) return { kind: "not-started", reason: "choice-unavailable" };
    const device = now.device as LocalRecord, located = now.located as Located, vaultText = now.view.vaultText as string, deviceText = now.view.deviceText as string;
    // バックアップに今の両方の版が入っていること
    const versionKey = `${seen.recordType === "reflection" ? "memory" : seen.recordType}:${seen.recordId}`;
    if (verified.content.versions.get(versionKey) !== device.updatedAt || verified.content.vaultSha.get(seen.path) !== seen.fileSha) return { kind: "stale-backup" };

    let kept: KeptVersion;
    try {
      kept = await writeKeptVersion(env.root, { createdAt: env.now(), choice, recordType: seen.recordType, recordId: seen.recordId, path: seen.path, fileSha: seen.fileSha, deviceUpdatedAt: device.updatedAt, deviceRaw: JSON.stringify(device), deviceMarkdown: deviceText, vaultText });
    } catch (error) {
      console.error("[Tsumugi] conflict resolution: could not keep the versions; nothing was changed", error);
      return { kind: "stopped", stage: "kept-version", kept: null };
    }
    await env.checkpoint?.("after-kept");

    let adopted: LocalRecord | null = null;
    let winnerText = deviceText;
    if (choice === "adopt-vault") {
      const parsed = parseVersion(seen.recordType, vaultText) as LocalRecord;
      const updatedAt = nextUpdatedAt(env.now(), device.updatedAt, parsed.updatedAt);
      try {
        adopted = await adoptVaultVersionWithOutbox(seen.recordType, mergedVaultVersion(seen.recordType, device, parsed, updatedAt), device.updatedAt, env.now());
      } catch (error) {
        if (error instanceof VaultVersionChangedError) return { kind: "not-started", reason: "changed" };
        if (error instanceof RecoveryPendingError) return { kind: "not-started", reason: "repair-in-progress" };
        console.error("[Tsumugi] conflict resolution: the device record was not changed", error);
        return { kind: "stopped", stage: "device", kept: kept.id };
      }
      winnerText = recordToMarkdown(seen.recordType, adopted);
      await env.checkpoint?.("after-device");
    }

    const content = fileWithVersion(located, seen.recordId, winnerText);
    if (content === null) return { kind: "stopped", stage: "file", kept: kept.id };
    const write = () => writeFileChecked(env.root, seen.path, seen.fileSha, content);
    try {
      if (seen.recordType === "memory") await withMemoryDayFileLock((device as MemoryObject).date.slice(0, 10), write);
      else await write();
    } catch (error) {
      console.error("[Tsumugi] conflict resolution: the file was not replaced", error);
      return { kind: "stopped", stage: "file", kept: kept.id };
    }
    await env.checkpoint?.("after-file");

    if (choice !== "adopt-vault") {
      try {
        // 排他区間でもIndexedDBへの書き込みは別のタブから入りうる：版が変わっていればその書き込みのOutboxが通常どおり進める
        if (!(await requeue(seen, device.updatedAt))) return { kind: "stopped", stage: "requeue", kept: kept.id };
      } catch (error) {
        if (error instanceof RecoveryPendingError) return { kind: "stopped", stage: "requeue", kept: kept.id };
        throw error;
      }
      await env.checkpoint?.("after-requeue");
    }
    return { kind: "applied", kept: kept.id, adopted };
  }));

  const newBackup = async (): Promise<BackupRef | null> => {
    const created = await env.createBackup();
    if (!created.ok) return null;
    const ref2: BackupRef = { runId: created.runId, size: created.size, sha256: created.sha256 };
    env.reusableBackup?.set(ref2);
    return ref2;
  };

  let backup = env.reusableBackup?.get() ?? null;
  const reused = backup !== null;
  if (!backup) backup = await newBackup();
  if (!backup) return { kind: "not-started", reason: "backup-failed" };
  if (env.isCancelled()) return { kind: "not-started", reason: "cancelled" };

  let locked = await attempt(backup);
  if (locked.ok && locked.value.kind === "stale-backup" && reused) {
    backup = await newBackup();
    if (!backup) return { kind: "not-started", reason: "backup-failed" };
    locked = await attempt(backup);
  }
  if (!locked.ok) return { kind: "not-started", reason: "busy" };
  const ran = locked.value;
  if (ran.kind === "stale-backup") return { kind: "not-started", reason: "backup-unverified" };
  if (ran.kind === "not-started") return ran;
  if (ran.kind === "stopped") return { kind: "stopped", stage: ran.stage, kept: ran.kept, after: await env.check().catch(() => null) };

  await env.settleSaves([targetOf(seen)]);
  const after = await env.check();
  return { kind: "done", choice, kept: ran.kept, resolved: confirmedResolved(after, seen.recordId), adopted: ran.adopted, after };
}

// ---------------------------------------------------------------------------
// 表示（何が変わり、何が失われうるか）
// ---------------------------------------------------------------------------

const countLines = (diff: DiffLine[] | undefined, kind: DiffLine["kind"]) => (diff ?? []).filter((l) => l.kind === kind).length;

export const CHOICE_LABEL: Record<ConflictChoice, string> = {
  "keep-both": "両方保持",
  "adopt-device": "端末側を採用",
  "adopt-vault": "保存先の版を採用",
  resume: "保存を再開する",
};

/** 実行の前に見せる説明。バックアップと別の保管は必ず作るので、「完全に消える」とは言わない */
export function choiceExplanation(choice: ConflictChoice, view: Pick<ConflictView, "diff">): { changes: string; mayLose: string } {
  const deviceOnly = countLines(view.diff, "device"), vaultOnly = countLines(view.diff, "vault");
  if (choice === "keep-both") return {
    changes: "端末の版を今までどおり使い、保存先のファイルも端末の版にそろえます。保存先の版は別に保管し、この画面でいつでも読めます（履歴やAIの記憶には出ません）。",
    mayLose: `通常の記録から失われる内容はありません。保存先だけにある${vaultOnly}行は、保管した版として残ります。`,
  };
  if (choice === "adopt-device") return {
    changes: "保存先のファイルのこの記録を、端末の版に置き換えます。",
    mayLose: `保存先だけにある${vaultOnly}行は、通常の記録から無くなります。元の内容はバックアップと保存先の管理領域に残りますが、一覧には出ません。`,
  };
  if (choice === "adopt-vault") return {
    changes: "端末の記録を保存先の版に置き換えます。履歴の表示とAIが参照する内容も保存先の版になります。",
    mayLose: `端末だけにある${deviceOnly}行は、通常の記録から無くなります。元の内容はバックアップと保存先の管理領域に残りますが、一覧には出ません。`,
  };
  return { changes: "どちらの版も変えず、止まっていた保存を再開します。", mayLose: "失われる内容はありません。" };
}

export const BLOCK_REASON_TEXT: Record<ConflictBlockReason, string> = {
  "device-missing": "端末にこの記録が見つからないため、ここでは解決できません。保存先のファイルは保持しています。",
  tombstoned: "削除した記録のため、ここでは解決できません。保存先のファイルは保持しています。",
  "file-unreadable": "保存先のファイルを読めないため、選択肢を出していません。時間をおいて確認し直すか、ファイルを確認してください。",
  "registry-unreadable": "保存先の管理情報を読めないため、選択肢を出していません。時間をおいて確認し直してください。",
  "stored-elsewhere": "この記録が想定と別の場所にある可能性があるため、選択肢を出していません。どちらのファイルも変更していません。",
  "not-separable": "同じ日のファイルからこの記録の部分だけを安全に取り出せないため、選択肢を出していません。ファイルの形を直すと解決できるようになります。",
  "duplicate-in-file": "同じファイルにこの記録が複数あるため、選択肢を出していません。どちらかをファイルで直すと解決できるようになります。",
  unparseable: "保存先のファイルを記録として読めないため、選択肢を出していません。ファイルの形を直すと解決できるようになります。",
  "repair-in-progress": "別の修復が途中のため、今は解決できません。「続きを完了する」の後にもう一度開いてください。",
};

export const ADOPT_VAULT_BLOCK_TEXT: Record<AdoptVaultBlockReason, string> = {
  "would-lose-content": "保存先の版には、記録に取り込むと失われる部分（Tsumugiが読まない項目や文）があるため、「保存先の版を採用」は出していません。",
  "identity-differs": "保存先の版は日付・作成日時・元の会話が端末の記録と異なるため、「保存先の版を採用」は出していません。",
  "active-conversation": "開いている会話のため、「保存先の版を採用」は出していません。会話を閉じると選べるようになります。",
};

export const NOT_STARTED_REASON_TEXT: Record<ConflictNotStarted, string> = {
  changed: "確認している間に内容が変わったため、中止しました。何も変更していません。もう一度内容を確認してください。",
  "choice-unavailable": "今の状態ではこの選択肢を安全に実行できないため、中止しました。何も変更していません。",
  "backup-failed": "実行の前のバックアップを作れなかったため、中止しました。何も変更していません。",
  "backup-unverified": "実行の直前にバックアップを読み直して確認できなかったため、中止しました。何も変更していません。",
  busy: "他の操作が実行中のため、始めませんでした。何も変更していません。しばらくしてからもう一度お試しください。",
  cancelled: "中止しました。何も変更していません。",
  "repair-in-progress": "別の修復が途中のため、始めませんでした。何も変更していません。",
};

export const STOPPED_TEXT = "途中で止まりました。両方の版は保管しています。もう一度内容を開いて、同じ操作をやり直せます。";
