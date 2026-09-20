/**
 * 「保存先にない記録の追加」（IndexedDB → Vault）。
 *
 * 【方向の区別】
 * - 既存の「保存先の記録を端末へ追加」（`vaultRestore.ts`）＝ Vault → IndexedDB（端末へ復元）。
 * - このモジュール ＝ IndexedDB → Vault（保存先へ追加）。この端末にあり、現在の保存先には無い記録を、
 *   ユーザーが確認した上で保存先へ書き出す。
 *
 * 【対象】
 * 通常の保存（`flushPendingToVault`）では、Registryにentryが無く`createdAt`がbaseline以前のrecordは
 * 「保存先の設定前に作られた記録」（legacyの可能性）として書き込みが保留（HOLD）される。保留自体は安全側の
 * 設計であり、この保留を外すのは、次の条件を全て確認できたrecordだけ（`planAppendLocalRecords`）：
 * - 現在の保存先にbaselineが確立している
 * - IndexedDBの台帳（vaultSyncState）が未同期
 * - 保存先に、同じidの痕跡が一切無い：Registryにentry無し／Vault全体の走査で同じidのMarkdown無し／
 *   `.tsumugi/index.json`・History Indexに同じidの記述無し／書き込み先のファイルが存在しない。
 *   Memoryは日単位（day-file）のため、その日のMemoryファイルがVaultに1つも無いこと
 * - 保存先に読めないTsumugiファイルが無い（その中に同じidがあるかを否定できないため）
 * 満たさないrecordは`blocked`（理由つき）とし、書かない。blockedの解決はこのモジュールの範囲外
 * （理由を表示するだけ）。
 *
 * 【実行】（`appendLocalRecordsToVault`。呼び出し元が`runVaultWorldExclusive`を保持している前提）
 * dry-runの計画は使わず、実行時に改めて全条件を検証し直し（Vaultを走査し直し、IndexedDBのrecordも
 * 読み直す）、通ったものだけを既存の書き込み関数（`adoptLocalOnly`モード）で1件ずつ書く。
 * `createdAt`/`updatedAt`・本文は一切書き換えない（IndexedDBのrecordをそのまま保存する）。
 * 実際にMarkdown・index.json・History Index・Registry・台帳まで書けたものだけが解消扱いになる
 * （台帳は書き込み成功後にだけ更新される既存の仕組み）。失敗したrecordはHOLDのまま残り、
 * 部分成功を許容する。再実行すると、書けたものは対象から外れ、残りだけが再判定される（冪等）。
 *
 * 通常の書き込みのbaselineゲートは変更しない。`adoptLocalOnly`はこのモジュールの専用execute経路
 * からのみ指定される。
 */
"use client";

import {
  getAllConversations,
  getAllMemoryObjects,
  getAllSources,
  getConversation,
  getMemoryObject,
  getSource,
  getVaultSyncState,
} from "./db";
import {
  conversationToMarkdown,
  memoryObjectToMarkdown,
  parseConversationMarkdown,
  parseMemoryDayFile,
  parseMemoryObjectMarkdown,
  parseSourceMarkdown,
  serializeMemoryDayFile,
  sourceToMarkdown,
} from "./markdown";
import {
  VaultAdoptTargetExistsError,
  VaultRecordNeedsResyncError,
  conversationsSemanticEqual,
  dayFileNameFor,
  dayFileRegistryKey,
  fileNameFor,
  hashVaultText,
  isAlreadySyncedToVault,
  isMemoryDayContainerAllNew,
  isRecordNewerThanBaseline,
  isReflectionSummary,
  lookupVaultRegistryRecord,
  memoryObjectsSemanticEqual,
  readVaultRegistryMeta,
  scanVaultForRestore,
  sourcesSemanticEqual,
  vaultSyncKeyFor,
  writeConversationMarkdown,
  writeMemoryObjectMarkdown,
  writeSourceMarkdown,
} from "./vault";
import type { VaultSyncKind } from "./vault";
import type { Conversation, MemoryObject, Source } from "./types";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type LocalOnlyKind = "conversation" | "memory" | "source";

/** 表示・選択用のrecord情報（IndexedDBのrecordから作る。本文の一部を含む）。 */
export interface LocalOnlyRecord {
  /** vaultSyncStateのkey（`conversation:<id>`等）。dry-runとexecuteでrecordを対応付けるのに使う。 */
  key: string;
  kind: LocalOnlyKind;
  id: string;
  isReflection: boolean;
  createdAt: string;
  updatedAt: string;
  /** YYYY-MM-DD（Conversationはstartedat、Memoryはdate、Sourceはcreatedat）。 */
  day: string;
  /** 一覧の1行表示。 */
  title: string;
  /** 「内容を確認」で表示する内容（Conversationは発言、Memoryは要約、Sourceは本文の冒頭）。 */
  lines: string[];
}

export type LocalOnlyBlockCode =
  | "no-baseline"
  | "registry-status"
  | "vault-trace"
  | "day-has-vault-files"
  | "history-trace"
  | "target-exists"
  | "unreadable-files";

export interface LocalOnlyBlock {
  code: LocalOnlyBlockCode;
  /** ユーザー向けの理由（内部用語を出さない）。 */
  message: string;
  /** 補足（Registryのstatus等）。 */
  detail?: string;
}

export interface LocalOnlyPlanItem {
  record: LocalOnlyRecord;
  /** nullならadoptable（保存先へ追加できる）。 */
  block: LocalOnlyBlock | null;
}

export interface LocalOnlyPlan {
  baselineEstablishedAt: string | null;
  items: LocalOnlyPlanItem[];
  adoptable: LocalOnlyPlanItem[];
  blocked: LocalOnlyPlanItem[];
  /** adoptableの内訳（Reflectionは記憶に含める）。 */
  counts: { conversations: number; memories: number; sources: number };
}

// ---------------------------------------------------------------------------
// record情報
// ---------------------------------------------------------------------------

const MAX_PREVIEW_TURNS = 40;
const MAX_PREVIEW_CHARS = 400;

function clip(text: string): string {
  const oneLine = text.trim();
  return oneLine.length > MAX_PREVIEW_CHARS ? `${oneLine.slice(0, MAX_PREVIEW_CHARS)}…` : oneLine;
}

function conversationRecord(conversation: Conversation): LocalOnlyRecord {
  const turns = conversation.turns.slice(0, MAX_PREVIEW_TURNS);
  const lines = turns.map((turn) => `${turn.role === "user" ? "あなた" : "AI"}：${clip(turn.content)}`);
  if (conversation.turns.length > turns.length) lines.push(`…ほか ${conversation.turns.length - turns.length}件のやり取り`);
  const mode = conversation.persona === "companion" ? "日記" : "会話";
  return {
    key: vaultSyncKeyFor("conversation", conversation.id),
    kind: "conversation",
    id: conversation.id,
    isReflection: false,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    day: conversation.startedAt.slice(0, 10),
    title: `${mode}（${conversation.turns.length}件のやり取り）`,
    lines,
  };
}

function memoryRecord(memory: MemoryObject): LocalOnlyRecord {
  const reflection = isReflectionSummary(memory);
  return {
    key: vaultSyncKeyFor("memory", memory.id),
    kind: "memory",
    id: memory.id,
    isReflection: reflection,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    day: memory.date.slice(0, 10),
    title: `${reflection ? "振り返り" : "記憶"}：${clip(memory.summary).slice(0, 60)}`,
    lines: [clip(memory.summary)],
  };
}

function sourceRecord(source: Source): LocalOnlyRecord {
  return {
    key: vaultSyncKeyFor("source", source.id),
    kind: "source",
    id: source.id,
    isReflection: false,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    day: source.createdAt.slice(0, 10),
    title: `素材：${source.title}`,
    lines: [clip(source.content).slice(0, MAX_PREVIEW_CHARS)],
  };
}

// ---------------------------------------------------------------------------
// 保存先の痕跡の確認
// ---------------------------------------------------------------------------

async function readTextStrict(dir: FileSystemDirectoryHandle, name: string): Promise<{ ok: boolean; text: string }> {
  try {
    const handle = await dir.getFileHandle(name, { create: false });
    return { ok: true, text: await (await handle.getFile()).text() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return { ok: true, text: "" };
    return { ok: false, text: "" };
  }
}

/** `.tsumugi/index.json`と`.tsumugi/history/*.json`の全文（idの痕跡の文字列検索用）。読めなければok:false。 */
async function readTraceText(root: FileSystemDirectoryHandle): Promise<{ ok: boolean; text: string }> {
  let tsumugiDir: FileSystemDirectoryHandle;
  try {
    tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return { ok: true, text: "" };
    return { ok: false, text: "" };
  }
  const parts: string[] = [];
  const index = await readTextStrict(tsumugiDir, "index.json");
  if (!index.ok) return { ok: false, text: "" };
  parts.push(index.text);
  try {
    const historyDir = await tsumugiDir.getDirectoryHandle("history", { create: false });
    for await (const [name, handle] of historyDir.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      const file = await readTextStrict(historyDir, name);
      if (!file.ok) return { ok: false, text: "" };
      parts.push(file.text);
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) return { ok: false, text: "" };
  }
  return { ok: true, text: parts.join("\n") };
}

/** 書き込み先の現状。absent＝存在しない、ok＝読めた（`text`が空なら空ファイル）、unknown＝確認できない。 */
async function readRelativeText(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<{ state: "absent" | "unknown" } | { state: "ok"; text: string }> {
  const segments = relativePath.split("/");
  try {
    let dir = root;
    for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: false });
    const handle = await dir.getFileHandle(segments[segments.length - 1], { create: false });
    return { state: "ok", text: await (await handle.getFile()).text() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return { state: "absent" };
    return { state: "unknown" };
  }
}

/** この記録を、通常の書き込みが保存先へ書く内容（`adoptLocalOnly`の書き込みも同じ内容を書く）。 */
function expectedMarkdownFor(record: LocalOnlyRecord, target: { conversation?: Conversation; memory?: MemoryObject; source?: Source }): string {
  if (record.kind === "conversation") return conversationToMarkdown(target.conversation!);
  if (record.kind === "source") return sourceToMarkdown(target.source!);
  return record.isReflection ? memoryObjectToMarkdown(target.memory!) : serializeMemoryDayFile([target.memory!]);
}

/** 書き込み先（通常の書き込みと同じ決定的なpath）。 */
function targetPathFor(record: LocalOnlyRecord, source: { conversation?: Conversation; memory?: MemoryObject; source?: Source }): string {
  if (record.kind === "conversation") return `Conversations/${fileNameFor(record.id, source.conversation!.startedAt)}`;
  if (record.kind === "source") return `Sources/${fileNameFor(record.id, source.source!.createdAt)}`;
  const memory = source.memory!;
  return record.isReflection ? `Memories/${fileNameFor(record.id, memory.date)}` : `Memories/${dayFileNameFor(memory.date)}`;
}

function registryStatusMessage(status: string): string {
  switch (status) {
    case "conflict":
      return "保存先で、同じ記録の重複や食い違いが見つかっています。";
    case "missing":
      return "保存先で、この記録のファイルが見つかりません。";
    default:
      return "保存先で、外部での変更の確認が必要な状態です。";
  }
}

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

interface PendingCandidate {
  record: LocalOnlyRecord;
  target: { conversation?: Conversation; memory?: MemoryObject; source?: Source };
}

/**
 * dry-run。IndexedDB・Registry・Vaultを読み取るだけで、何も書き込まない。呼び出し元が
 * world lock（`withVaultWorldRead`または排他lock）を保持している前提。
 */
export async function planAppendLocalRecords(root: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<LocalOnlyPlan> {
  const baseline = (await readVaultRegistryMeta(root)).baselineEstablishedAt;
  const [conversations, memories, sources] = await Promise.all([getAllConversations(), getAllMemoryObjects(), getAllSources()]);

  const items: LocalOnlyPlanItem[] = [];
  const candidates: PendingCandidate[] = [];

  const classifyLookup = (
    lookup: Awaited<ReturnType<typeof lookupVaultRegistryRecord>>,
    createdAts: string[]
  ): "skip" | "candidate" | { status: string } | "no-baseline" => {
    if (lookup.entry === undefined) {
      if (baseline === null) return "no-baseline";
      return createdAts.every((createdAt) => isRecordNewerThanBaseline(createdAt, baseline)) ? "skip" : "candidate";
    }
    if (lookup.entry.status === "ok") return "skip";
    return { status: lookup.entry.status };
  };

  const addByVerdict = (
    verdict: "skip" | "candidate" | { status: string } | "no-baseline",
    record: LocalOnlyRecord,
    target: PendingCandidate["target"]
  ) => {
    if (verdict === "skip") return; // 通常の保存で書き込まれる（HOLDではない）
    if (verdict === "candidate") {
      candidates.push({ record, target });
    } else if (verdict === "no-baseline") {
      items.push({
        record,
        block: { code: "no-baseline", message: "保存先の準備がまだ完了していないため、確認できません。" },
      });
    } else {
      items.push({
        record,
        block: { code: "registry-status", message: registryStatusMessage(verdict.status), detail: verdict.status },
      });
    }
  };

  for (const conversation of conversations) {
    signal?.throwIfAborted();
    if (await isAlreadySyncedToVault("conversation", conversation.id, conversation.updatedAt)) continue;
    const verdict = classifyLookup(await lookupVaultRegistryRecord(root, conversation.id), [conversation.createdAt]);
    addByVerdict(verdict, conversationRecord(conversation), { conversation });
  }

  for (const source of sources) {
    signal?.throwIfAborted();
    if (await isAlreadySyncedToVault("source", source.id, source.updatedAt)) continue;
    const verdict = classifyLookup(await lookupVaultRegistryRecord(root, source.id), [source.createdAt]);
    addByVerdict(verdict, sourceRecord(source), { source });
  }

  // Memory：Reflection（1record1file）はid単位、通常のMemoryは日単位（day-file）で判定する。
  const pendingNormalByDay = new Map<string, MemoryObject[]>();
  for (const memory of memories) {
    signal?.throwIfAborted();
    if (await isAlreadySyncedToVault("memory", memory.id, memory.updatedAt)) continue;
    if (isReflectionSummary(memory)) {
      const verdict = classifyLookup(await lookupVaultRegistryRecord(root, memory.id), [memory.createdAt]);
      addByVerdict(verdict, memoryRecord(memory), { memory });
      continue;
    }
    const day = memory.date.slice(0, 10);
    pendingNormalByDay.set(day, [...(pendingNormalByDay.get(day) ?? []), memory]);
  }
  for (const [day, dayMemories] of pendingNormalByDay) {
    const lookup = await lookupVaultRegistryRecord(root, dayFileRegistryKey(day));
    let verdict = classifyLookup(lookup, dayMemories.map((m) => m.createdAt));
    // 通常書き込みのゲートと同じ：日のcontainer全員（IndexedDB上の同じ日の全Memory）がbaseline後でなければ保留。
    if (verdict === "skip" && lookup.entry === undefined && baseline !== null && !(await isMemoryDayContainerAllNew(day, baseline))) {
      verdict = "candidate";
    }
    for (const memory of dayMemories) addByVerdict(verdict, memoryRecord(memory), { memory });
  }

  // 候補について、保存先に同じidの痕跡が無いことを確認する。
  if (candidates.length > 0) {
    const blockAll = (block: LocalOnlyBlock) => {
      for (const candidate of candidates) items.push({ record: candidate.record, block });
    };
    const scan = await scanVaultForRestore(root, signal);
    const trace = await readTraceText(root);
    if (scan.skippedCount > 0) {
      blockAll({
        code: "unreadable-files",
        message: "保存先に読み込めないファイルがあるため、同じ記録が無いことを確認できません。",
        detail: `${scan.skippedCount}件`,
      });
    } else if (!trace.ok) {
      blockAll({ code: "unreadable-files", message: "保存先の履歴・索引を読み込めないため、確認できません。" });
    } else {
      const vaultIds = new Set<string>([
        ...scan.conversations.map((c) => c.id),
        ...scan.memoryObjects.map((m) => m.id),
        ...scan.sources.map((s) => s.id),
      ]);
      const vaultNormalMemoryDays = new Set(
        scan.memoryObjects.filter((m) => !isReflectionSummary(m)).map((m) => m.date.slice(0, 10))
      );
      for (const candidate of candidates) {
        const { record, target } = candidate;
        let block: LocalOnlyBlock | null = null;
        const existing = await readRelativeText(root, targetPathFor(record, target));
        // 以前の追加が、本文の書き込み後・Registry確定前に中断して残った、この記録自身のファイル
        // （書き込み先に、これから書く内容と完全に一致するファイルがある）。同じ内容の上書きは無害で、
        // 残りの手順を完了できるため、痕跡とは扱わない。
        const ownPartial = existing.state === "ok" && existing.text.length > 0 && existing.text === expectedMarkdownFor(record, target);
        if (!ownPartial && vaultIds.has(record.id)) {
          block = { code: "vault-trace", message: "保存先に、同じ記録が既にあります。" };
        } else if (!ownPartial && record.kind === "memory" && !record.isReflection && vaultNormalMemoryDays.has(record.day)) {
          block = { code: "day-has-vault-files", message: "保存先に、同じ日の記憶のファイルが既にあります。" };
        } else if (!ownPartial && trace.text.includes(record.id)) {
          block = { code: "history-trace", message: "保存先の履歴・索引に、この記録の痕跡だけが残っています。" };
        } else if (existing.state === "unknown") {
          block = { code: "unreadable-files", message: "保存先の状態を確認できませんでした。" };
        } else if (existing.state === "ok" && existing.text.length > 0 && !ownPartial) {
          block = { code: "target-exists", message: "保存先に、同じ名前のファイルが既にあります。" };
        }
        items.push({ record, block });
      }
    }
  }

  const order = { conversation: 0, memory: 1, source: 2 } as const;
  items.sort((a, b) => order[a.record.kind] - order[b.record.kind] || a.record.createdAt.localeCompare(b.record.createdAt));
  const adoptable = items.filter((item) => item.block === null);
  const blocked = items.filter((item) => item.block !== null);
  return {
    baselineEstablishedAt: baseline,
    items,
    adoptable,
    blocked,
    counts: {
      conversations: adoptable.filter((i) => i.record.kind === "conversation").length,
      memories: adoptable.filter((i) => i.record.kind === "memory").length,
      sources: adoptable.filter((i) => i.record.kind === "source").length,
    },
  };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/** dry-run時点のrecordとの対応付け。`updatedAt`が変わっていたら書かない。 */
export interface AppendLocalSelection {
  key: string;
  updatedAt: string;
}

export interface AppendLocalItemResult {
  key: string;
  kind: LocalOnlyKind;
  id: string;
  outcome: "written" | "skipped" | "failed";
  message?: string;
}

export interface AppendLocalCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export type AppendLocalStatus = "complete" | "partial" | "interrupted" | "refused" | "nothing-to-do";

export interface AppendLocalResult {
  status: AppendLocalStatus;
  items: AppendLocalItemResult[];
  writtenCount: number;
  failedCount: number;
  skippedCount: number;
  postChecks: AppendLocalCheck[];
  /** 実行後に、まだ保存先に無い記録（追加できるもの／確認が必要なもの）。 */
  remaining: { adoptable: number; blocked: number } | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface VaultFileStat {
  size: number;
  mtime: number;
}

/** Conversations/Memories/Sources配下のMarkdownのpath→size/mtime（隠しフォルダは除く）。post-checkで「追加以外は不変」を確認する。 */
async function collectMarkdownStats(root: FileSystemDirectoryHandle): Promise<Map<string, VaultFileStat>> {
  const out = new Map<string, VaultFileStat>();
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
 * 実行。ユーザーが明示的に「保存先に追加する」を押した場合だけ呼ぶ。呼び出し元が
 * `runVaultWorldExclusive`を保持している前提（検証と書き込みを、他の操作に割り込まれずに行うため）。
 * `isStale`がtrueを返したら、次のrecordを書く前に中断する（再実行で残りを完了できる）。
 */
export async function appendLocalRecordsToVault(
  root: FileSystemDirectoryHandle,
  selections: AppendLocalSelection[],
  isStale?: () => boolean
): Promise<AppendLocalResult> {
  const result: AppendLocalResult = {
    status: "complete",
    items: [],
    writtenCount: 0,
    failedCount: 0,
    skippedCount: 0,
    postChecks: [],
    remaining: null,
  };
  if (selections.length === 0) return { ...result, status: "nothing-to-do" };

  // 実行時に全条件を検証し直す（dry-run後に、Vault・IndexedDBが変わっていても書かない）。
  const plan = await planAppendLocalRecords(root);
  const adoptableByKey = new Map(plan.adoptable.map((item) => [item.record.key, item]));
  const blockedByKey = new Map(plan.blocked.map((item) => [item.record.key, item]));
  const beforeStats = await collectMarkdownStats(root);
  const beforeCounts = {
    conversations: (await getAllConversations()).length,
    memories: (await getAllMemoryObjects()).length,
    sources: (await getAllSources()).length,
  };
  const writtenKeys: { item: LocalOnlyPlanItem; conversation?: Conversation; memory?: MemoryObject; source?: Source }[] = [];

  const ordered = [...selections].sort((a, b) => a.key.localeCompare(b.key));
  for (const selection of ordered) {
    if (isStale?.()) return { ...result, status: "interrupted", ...finish(result) };
    const item = adoptableByKey.get(selection.key);
    const base = { key: selection.key, kind: kindOfKey(selection.key), id: selection.key.slice(selection.key.indexOf(":") + 1) };
    if (!item) {
      const blocked = blockedByKey.get(selection.key);
      result.items.push({
        ...base,
        outcome: "skipped",
        message: blocked?.block ? blocked.block.message : "状況が変わったため、今回は追加しませんでした。もう一度確認してください。",
      });
      continue;
    }
    if (item.record.updatedAt !== selection.updatedAt) {
      result.items.push({ ...base, outcome: "skipped", message: "確認後に記録が変更されたため、今回は追加しませんでした。もう一度確認してください。" });
      continue;
    }
    try {
      if (item.record.kind === "conversation") {
        const fresh = await getConversation(item.record.id);
        if (!fresh || fresh.updatedAt !== selection.updatedAt) throw new Error("記録が変更されました");
        await writeConversationMarkdown(root, fresh, "interactive", undefined, { adoptLocalOnly: true });
        writtenKeys.push({ item, conversation: fresh });
      } else if (item.record.kind === "source") {
        const fresh = await getSource(item.record.id);
        if (!fresh || fresh.updatedAt !== selection.updatedAt) throw new Error("記録が変更されました");
        await writeSourceMarkdown(root, fresh, "interactive", undefined, { adoptLocalOnly: true });
        writtenKeys.push({ item, source: fresh });
      } else {
        const fresh = await getMemoryObject(item.record.id);
        if (!fresh || fresh.updatedAt !== selection.updatedAt) throw new Error("記録が変更されました");
        await writeMemoryObjectMarkdown(root, fresh, "interactive", undefined, { adoptLocalOnly: true });
        writtenKeys.push({ item, memory: fresh });
      }
      result.items.push({ ...base, outcome: "written" });
    } catch (error) {
      const message =
        error instanceof VaultAdoptTargetExistsError
          ? "保存先に同じ名前のファイルが既にあるため、追加しませんでした。"
          : error instanceof VaultRecordNeedsResyncError
            ? "保存先の状態により、追加できませんでした。"
            : `追加できませんでした（${errorMessage(error)}）`;
      result.items.push({ ...base, outcome: "failed", message });
    }
  }
  Object.assign(result, finish(result));

  // post-check：実際に保存できたものを、保存先から読み直して確認する。
  const checks: AppendLocalCheck[] = [];
  // 今回書き込んだファイル（以前の中断で残った空・同一内容のファイルを上書きした場合を含む）。
  const writtenPaths = new Set<string>();
  for (const written of writtenKeys) {
    const { record } = written.item;
    const registryKey = record.kind === "memory" && !record.isReflection ? dayFileRegistryKey(record.day) : record.id;
    const lookup = await lookupVaultRegistryRecord(root, registryKey);
    let ok = lookup.entry !== undefined && lookup.entry.status === "ok" && lookup.path !== undefined;
    let detail: string | undefined;
    if (ok && lookup.path) {
      writtenPaths.add(lookup.path);
      try {
        const segments = lookup.path.split("/");
        let dir = root;
        for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: false });
        const text = await (await (await dir.getFileHandle(segments[segments.length - 1], { create: false })).getFile()).text();
        if (hashVaultText(text) !== lookup.entry!.contentHash) {
          ok = false;
          detail = "Registryのhashがファイルと一致しません";
        } else if (written.conversation) {
          const parsed = parseConversationMarkdown(text);
          ok = parsed !== null && conversationsSemanticEqual(written.conversation, parsed);
        } else if (written.source) {
          ok = sourcesSemanticEqual(written.source, parseSourceMarkdown(text));
        } else if (written.memory) {
          const parsedList = record.isReflection
            ? [parseMemoryObjectMarkdown(text)].filter((m): m is MemoryObject => m !== null)
            : parseMemoryDayFile(text);
          const parsed = parsedList.find((m) => m.id === record.id);
          ok = parsed !== undefined && memoryObjectsSemanticEqual(written.memory, parsed);
        }
        if (!ok && detail === undefined) detail = "保存先の内容がこの端末の記録と一致しません";
      } catch (error) {
        ok = false;
        detail = errorMessage(error);
      }
    } else {
      detail = "Registryに登録されていません";
    }
    if (ok && (await getVaultSyncState(record.key)) !== record.updatedAt) {
      ok = false;
      detail = "同期の記録が更新されていません";
    }
    checks.push({ name: `保存できた記録を保存先から確認：${record.title}`, ok, detail });
  }
  const trace = await readTraceText(root);
  checks.push({
    name: "履歴・索引に追加した記録が載っている",
    ok: trace.ok && writtenKeys.every((w) => trace.text.includes(w.item.record.id)),
  });
  const afterStats = await collectMarkdownStats(root);
  const changed = [...beforeStats].filter(([path, stat]) => {
    if (writtenPaths.has(path)) return false;
    const now = afterStats.get(path);
    return now === undefined || now.size !== stat.size || now.mtime !== stat.mtime;
  });
  checks.push({
    name: "追加した以外のファイルが変更・削除されていない",
    ok: changed.length === 0,
    detail: changed.slice(0, 3).map(([path]) => path).join(", "),
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
  const baselineAfter = (await readVaultRegistryMeta(root)).baselineEstablishedAt;
  checks.push({ name: "baselineが変わっていない", ok: baselineAfter === plan.baselineEstablishedAt });
  result.postChecks = checks;

  const remainingPlan = await planAppendLocalRecords(root);
  result.remaining = { adoptable: remainingPlan.adoptable.length, blocked: remainingPlan.blocked.length };
  result.status =
    result.failedCount === 0 && result.skippedCount === 0 && checks.every((c) => c.ok) ? "complete" : "partial";
  if (result.writtenCount === 0 && result.failedCount === 0 && result.skippedCount > 0) result.status = "refused";
  return result;
}

function kindOfKey(key: string): LocalOnlyKind {
  const kind = key.slice(0, key.indexOf(":")) as VaultSyncKind;
  return kind === "memory" || kind === "source" ? kind : "conversation";
}

function finish(result: AppendLocalResult): Pick<AppendLocalResult, "writtenCount" | "failedCount" | "skippedCount"> {
  return {
    writtenCount: result.items.filter((i) => i.outcome === "written").length,
    failedCount: result.items.filter((i) => i.outcome === "failed").length,
    skippedCount: result.items.filter((i) => i.outcome === "skipped").length,
  };
}
