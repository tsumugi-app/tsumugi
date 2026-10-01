/**
 * Vault Recovery Apply（Phase 2 初期版）。旧い記録のうち、「安全性を証明できたもの」だけを保存先（Vault）へ復旧する。
 *
 * 【対象（自動で書くのはこれだけ）】
 * - local-only-safe：この端末（IndexedDB）にあり、保存先にはMarkdownも管理情報の痕跡も一切無いと
 *   Vault全体の完全走査で証明できた記録。Conversation／Reflection／Sourceは1件1ファイルで新規作成。
 *   Memoryは「その日のday-fileが保存先に存在しない」場合だけ、その日のMemoryをまとめてday-fileを新規作成する。
 * - equivalent-existing：保存先に、IndexedDBと意味的に同値のMarkdownが1つだけ実在する記録。
 *   Markdown本文は絶対に再保存せず、「不足している」管理情報（index.json／History／Registry／同期台帳）
 *   だけを補う。既存の値が食い違っている場合は「不足」とみなして上書きせず、保留する。
 * 上記以外（conflict／memory-dayfile-merge-required／vault-only／unreadable・indeterminate、既存day-fileへの
 * member追加、壊れた本文の推測修復）は、元データを一切変更せず保留する。
 *
 * 【baselineは変更しない】Recoveryの都合でbaselineを確立・更新しない。local-only-safeの書き込みは、通常の書き込みが
 * baselineで判断している「Registryに無い＝新規か旧記録か分からない」という不確実性を、Vault全体の完全走査による
 * 不在証明で置き換えているため、baseline未確立でも成立する（Registry entryはbaselineに依存しない）。
 * ただしbaselineの状態を読めない（unconfirmed）場合は、何もしない。
 *
 * 【安全機構】
 * - 実行の直前に必ずRecovery Plan（`buildVaultRecoveryPlan`）を作り直す。古いPlanのclassificationは信用しない。
 * - 永続journalを先に確定（保存→読み戻し）してから書く。journalを保存・読み戻せなければ何も書かない。
 * - 各stepは冪等：実体（Vault・IndexedDB）を再確認して「済み／必要／矛盾」を判定する。journalの進捗は目安で、信用しない。
 * - 管理ファイルへの書き込みは、前後を読み直して「他の項目が変わっていない」ことを確認する。崩れていたら書き戻す。
 * - 成功扱い（recovered）にするのは、書き込み後にPlanを再生成して実体を再確認し、記録ごとの全条件を満たしたものだけ。
 * - IndexedDBの本文は変更しない（同期台帳への記録だけを行う）。既存のMarkdownは上書きしない。
 * - 呼び出し元がworld lock（`runVaultWorldExclusive`）を保持している前提。
 *
 * 【registry-index.json】通常の保存もこのファイルを更新しない（full resyncだけが作り直す）。世代（registryGeneration）を
 * 進めずに書くと誤って「最新」と扱われうるため、Recoveryも触れない（検証では、変更されていないこと・矛盾する記載が
 * 無いことを確認する）。
 */
import type { Conversation, MemoryObject, Source } from "./types";
import { conversationEntryKindOf } from "./conversationEntryKind";
import {
  buildVaultRecoveryPlan,
  parseRecoveryMemoryMarkdown,
  readRecoveryLocalSnapshot,
  type RecoveryLocalSnapshot,
  type RecoveryPlan,
  type RecoveryRecord,
} from "./vaultRecovery";
import {
  conversationToMarkdown,
  memoryObjectToMarkdown,
  serializeMemoryDayFile,
  sourceToMarkdown,
} from "./markdown";
import {
  computeMonthAggregate,
  dayFileNameFor,
  dayFileRegistryKey,
  fileNameFor,
  getVaultBackend,
  hashVaultText,
  isReflectionSummary,
  runRecoveryVaultWrite,
  truncateHistoryPreview,
  vaultRecoveryPrimitives,
  vaultRegistryBucketOf,
  vaultSyncKeyFor,
} from "./vault";
import type { HistoryMonthIndex } from "./vault";
import {
  dbRecoveryJournalStore,
  readRecoveryJournal,
  saveRecoveryJournal,
  type RecoveryJournal,
  type RecoveryJournalMember,
  type RecoveryJournalOp,
  type RecoveryMetadataBackup,
  type RecoveryJournalStore,
  type RecoveryJournalWorld,
  type RecoveryRecordType,
  type RecoveryStepName,
} from "./vaultRecoveryJournal";
import {
  getActiveVaultEpoch,
  getCommittedVaultEpoch,
  getConversation,
  getMemoryObject,
  getRegistryGenerationEpoch,
  getSource,
  getVaultSyncState,
  getVaultWorldJournalVersion,
  setVaultSyncState,
} from "./db";

// ---------------------------------------------------------------------------
// 環境（テストでは差し替える）
// ---------------------------------------------------------------------------

export interface RecoveryApplyEnv {
  root: FileSystemDirectoryHandle;
  /** 毎回、IndexedDBを新しく読む（キャッシュしない）。 */
  readLocalSnapshot(): Promise<RecoveryLocalSnapshot>;
  /** 1件だけ読み直す（各opの直前に、IndexedDBの記録が変わっていないことを確認する。全件を読み直さないため）。 */
  readRecord(type: "conversation" | "memory" | "source", id: string): Promise<LocalRecord | undefined>;
  store: RecoveryJournalStore;
  readLedger(key: string): Promise<string | undefined>;
  writeLedger(key: string, value: string): Promise<void>;
  readWorld(): Promise<RecoveryJournalWorld>;
  /** Vaultへ書く操作は必ずこれを通す（通常のwrite queueで直列化され、Recovery自身だけがゲートを通る）。 */
  runWrite<T>(task: () => Promise<T>): Promise<T>;
  now(): string;
  newId(): string;
  /** trueなら、次のstep（記録）へ進む前に中断する（再実行で続きから完了できる）。 */
  isStale?: () => boolean;
  signal?: AbortSignal;
}

/** アプリ本番の環境。呼び出し元が`runVaultWorldExclusive`を保持している前提。 */
export function createRecoveryApplyEnv(root: FileSystemDirectoryHandle, options: { isStale?: () => boolean; signal?: AbortSignal } = {}): RecoveryApplyEnv {
  return {
    root,
    readLocalSnapshot: () => readRecoveryLocalSnapshot(indexedDB),
    readRecord: async (type, id) => (type === "conversation" ? await getConversation(id) : type === "source" ? await getSource(id) : await getMemoryObject(id)),
    store: dbRecoveryJournalStore,
    readLedger: getVaultSyncState,
    writeLedger: setVaultSyncState,
    readWorld: readProductionWorld,
    runWrite: runRecoveryVaultWrite,
    now: () => new Date().toISOString(),
    newId: () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    ...options,
  };
}

async function readProductionWorld(): Promise<RecoveryJournalWorld> {
  const committed = await getCommittedVaultEpoch();
  const version = await getVaultWorldJournalVersion();
  return {
    activeVaultEpoch: await getActiveVaultEpoch(),
    committedVaultEpoch: committed.status === "valid" ? committed.epoch : null,
    registryGenerationEpoch: await getRegistryGenerationEpoch(),
    journalVersion: version.status === "current" ? "current" : version.status === "missing" ? "missing" : `unexpected:${version.raw}`,
    backend: getVaultBackend(),
  };
}

function sameWorld(a: RecoveryJournalWorld, b: RecoveryJournalWorld): boolean {
  return (
    a.activeVaultEpoch === b.activeVaultEpoch &&
    a.committedVaultEpoch === b.committedVaultEpoch &&
    a.registryGenerationEpoch === b.registryGenerationEpoch &&
    a.journalVersion === b.journalVersion &&
    a.backend === b.backend
  );
}

// ---------------------------------------------------------------------------
// 小さな道具
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const hashRecord = (record: unknown) => hashVaultText(JSON.stringify(record));
const isNotFound = (e: unknown) => isObj(e) && e.name === "NotFoundError";

type TextRead = { state: "absent" } | { state: "error" } | { state: "ok"; text: string; size: number };
/** 「存在しない」（NotFoundだけ）と「読めない」を区別して読む。 */
async function readTextAt(root: FileSystemDirectoryHandle, path: string): Promise<TextRead> {
  const segments = path.split("/");
  let file: File;
  try {
    let dir = root;
    for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
    file = await (await dir.getFileHandle(segments[segments.length - 1], { create: false })).getFile();
  } catch (e) {
    return isNotFound(e) ? { state: "absent" } : { state: "error" };
  }
  try {
    return { state: "ok", text: await file.text(), size: file.size };
  } catch {
    return { state: "error" };
  }
}

type JsonRead = { state: "absent" } | { state: "error" } | { state: "ok"; value: Obj; text: string };
async function readJsonAt(root: FileSystemDirectoryHandle, path: string): Promise<JsonRead> {
  const read = await readTextAt(root, path);
  if (read.state !== "ok") return read;
  try {
    const value: unknown = JSON.parse(read.text);
    return isObj(value) ? { state: "ok", value, text: read.text } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

const INDEX_PATH = ".tsumugi/index.json";
const HISTORY_META_PATH = ".tsumugi/history-meta.json";
const shardPath = (bucket: number) => `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
const historyPath = (day: string) => `.tsumugi/history/${day.slice(0, 7)}.json`;
const sortedIds = (ids: string[]) => [...ids].sort();
const sameSet = (a: string[], b: string[]) => a.length === b.length && sortedIds(a).every((v, i) => v === sortedIds(b)[i]);

type LocalRecord = Conversation | MemoryObject | Source;

function syncKindOf(type: RecoveryRecordType): "conversation" | "memory" | "source" {
  return type === "conversation" ? "conversation" : type === "source" ? "source" : "memory";
}

// ---------------------------------------------------------------------------
// 期待する状態（record → Markdown・管理情報）
// ---------------------------------------------------------------------------

interface OpContext {
  records: LocalRecord[];
  /** createは書く内容、repairは今ある内容（変更しない）。 */
  content: string;
  /** memoryのday-file（create-day＝IndexedDBの当日のMemory、repair＝実ファイルのmember）。 */
  fileMembers: MemoryObject[] | null;
}

function memoryHistoryRow(memory: MemoryObject) {
  return { id: memory.id, types: memory.types, preview: truncateHistoryPreview(memory.summary), createdAt: memory.createdAt, date: memory.date };
}

function targetPathOf(type: RecoveryRecordType, record: LocalRecord): string {
  if (type === "conversation") return `Conversations/${fileNameFor(record.id, (record as Conversation).startedAt)}`;
  if (type === "source") return `Sources/${fileNameFor(record.id, (record as Source).createdAt)}`;
  const memory = record as MemoryObject;
  return type === "reflection" ? `Memories/${fileNameFor(memory.id, memory.date)}` : `Memories/${dayFileNameFor(memory.date)}`;
}

function contentOfCreate(type: RecoveryRecordType, records: LocalRecord[]): { content: string; fileMembers: MemoryObject[] | null } {
  if (type === "conversation") return { content: conversationToMarkdown(records[0] as Conversation), fileMembers: null };
  if (type === "source") return { content: sourceToMarkdown(records[0] as Source), fileMembers: null };
  if (type === "reflection") return { content: memoryObjectToMarkdown(records[0] as MemoryObject), fileMembers: null };
  const members = [...(records as MemoryObject[])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { content: serializeMemoryDayFile(members), fileMembers: members };
}

/** 実ファイルのday-fileを厳密にparseする（1つでも読めないmemberがあれば失敗＝null。黙って捨てない）。 */
function parseDayFileStrict(text: string): MemoryObject[] | null {
  const blocks = text.split("\n<!-- tsumugi:entry -->\n\n").map((s) => s.trim()).filter(Boolean);
  if (blocks.length === 0) return null;
  const members: MemoryObject[] = [];
  try {
    for (const block of blocks) {
      const parsed = parseRecoveryMemoryMarkdown(block);
      if (!parsed) return null;
      members.push(parsed);
    }
  } catch {
    return null;
  }
  return new Set(members.map((m) => m.id)).size === members.length ? members : null;
}

function registryExpectation(op: RecoveryJournalOp, ctx: OpContext) {
  const contentHash = hashVaultText(ctx.content);
  const isDay = op.recordType === "memory";
  const memberIds = isDay ? (ctx.fileMembers ?? []).map((m) => m.id) : [op.members[0].id];
  const memberHashes = isDay ? Object.fromEntries((ctx.fileMembers ?? []).map((m) => [m.id, hashVaultText(memberObjectMarkdown(m))])) : undefined;
  return { key: op.registryKey, path: op.path, contentHash, memberIds, memberHashes, recordType: isDay ? ("memory-day" as const) : (op.recordType as "conversation" | "reflection" | "source") };
}
const memberObjectMarkdown = (m: MemoryObject) => memoryObjectToMarkdown(m);

// ---------------------------------------------------------------------------
// stepの実体確認（済み／必要／矛盾）
// ---------------------------------------------------------------------------

type StepVerdict = { state: "satisfied" | "needed" } | { state: "conflict"; detail: string };
const SATISFIED: StepVerdict = { state: "satisfied" };
const NEEDED: StepVerdict = { state: "needed" };
const conflict = (detail: string): StepVerdict => ({ state: "conflict", detail });

async function inspectMarkdown(env: RecoveryApplyEnv, op: RecoveryJournalOp, ctx: OpContext): Promise<StepVerdict & { size?: number }> {
  const read = await readTextAt(env.root, op.path);
  if (read.state === "error") return conflict("markdown-unreadable");
  if (read.state === "absent") return op.kind === "repair" ? conflict("markdown-missing") : NEEDED;
  if (read.size === 0 && op.kind !== "repair") return NEEDED; // 以前の書き込みが途中で失敗して残った空ファイル（内容を持たない）
  if (read.text === ctx.content && hashVaultText(read.text) === op.expectedContentHash) return { ...SATISFIED, size: read.size };
  return conflict(op.kind === "repair" ? "markdown-changed" : "target-exists-with-other-content");
}

async function inspectIndex(env: RecoveryApplyEnv, op: RecoveryJournalOp): Promise<StepVerdict> {
  const read = await readJsonAt(env.root, INDEX_PATH);
  if (read.state === "error") return conflict("index-unreadable");
  if (read.state === "absent") return NEEDED;
  let needed = false;
  for (const entry of op.expected.indexEntries) {
    const value = read.value[entry.id];
    if (value === undefined) needed = true;
    else if (value !== entry.path) return conflict("index-differs");
  }
  return needed ? NEEDED : SATISFIED;
}

function rowEquals(existing: unknown, expected: Obj): boolean {
  return isObj(existing) && Object.entries(expected).every(([k, v]) => k === "date" ? existing.date === undefined || existing.date === v : JSON.stringify(existing[k]) === JSON.stringify(v));
}

/**
 * Codexレビュー指摘H2-1（History verification不足）対応：月History本体（rows）と、
 * history-meta.json（月ごとの集計）は別々のファイルであり、片方の書き込みだけが先に成功しうる
 * （`updateHistoryIndex`が2つの独立したファイルを順に書くため）。以前はrowsだけを見て
 * SATISFIEDと判定していたため、meta側が欠損・古い値のままでもrecoveredになりうる不具合があった。
 * ここでは両方を独立に検証し、どちらか一方でも欠けていればNEEDED（＝再度`updateHistoryIndex`を
 * 呼んで安全に補う。冪等な絶対値書き込みのため、既に正しい側は書き直さない）、meta自体が壊れて
 * いる（object形状として不正）場合だけconflictとして保留する。
 */
/**
 * Codexレビュー再指摘H2-1（総計の未検証）対応：`history-meta.json`は月別aggregate（`months[month]`）に
 * 加えて、ファイル全体の総計（`totalMemories`／`totalConversations`）も持つ。以前は月別aggregateしか
 * 見ておらず、月別は正しいのに総計だけが矛盾している（例：`totalConversations: 999`）場合でも
 * recoveredになってしまっていた。ここでは両方を独立して確認する。
 *
 * 「不存在」（このrecordの追加によって初めて必要になる値がまだ無い）と「存在するが矛盾」を区別する：
 * - `months[month]`が無い、または総計フィールド自体が無い → NEEDED（不足しているだけ。安全に補える。
 *   実際の書き込みは`updateHistoryIndex`が`months`全体から絶対値として再計算するため、既存の他の
 *   月・既存の総計を壊さない）。
 * - `months[month]`はあるが値が違う、または総計フィールドはあるが`months`全体の合計と食い違う
 *   → conflict（矛盾）。既存値を「不足」とみなして勝手に上書きしない。
 */
async function inspectHistoryMeta(env: RecoveryApplyEnv, month: string, monthIndex: Obj): Promise<StepVerdict> {
  const read = await readJsonAt(env.root, HISTORY_META_PATH);
  if (read.state === "error") return conflict("history-meta-unreadable");
  if (read.state === "absent") return NEEDED;
  const months = read.value.months;
  if (!isObj(months)) return conflict("history-meta-malformed");
  const recorded = months[month];
  let monthVerdict: StepVerdict;
  if (recorded === undefined) {
    monthVerdict = NEEDED;
  } else if (!isObj(recorded) || typeof recorded.memories !== "number" || typeof recorded.conversations !== "number") {
    return conflict("history-meta-malformed");
  } else {
    // Codexレビュー再指摘H2-1：以前は月別aggregateが既存値と食い違う場合もNEEDED（＝安全に上書き）
    // として扱っていたが、「存在するが矛盾」を「不足」と同じに扱わないという方針に合わせ、
    // 既存値がある以上は矛盾として保留する（上書きしない）。
    const expectedMonth = computeMonthAggregate(monthIndex as unknown as HistoryMonthIndex);
    monthVerdict = recorded.memories === expectedMonth.memories && recorded.conversations === expectedMonth.conversations ? SATISFIED : conflict("history-meta-month-mismatch");
  }
  if (monthVerdict.state === "conflict") return monthVerdict;
  // ファイル全体の総計：`months`に現に存在する全月から合計し直したものと突き合わせる（vault.ts側の
  // 実際の書き込みロジック＝`months`からの絶対値再計算と同じ計算式。これから追加・更新する対象の
  // 月〈`month`〉自体は、上のmonthVerdict側の判定にすでに委ねているため、ここでは「ファイルに現に
  // 書かれている内容同士の内部整合性」だけを見る）。
  let expectedTotalMemories = 0;
  let expectedTotalConversations = 0;
  for (const value of Object.values(months)) {
    if (!isObj(value) || typeof value.memories !== "number" || typeof value.conversations !== "number") return conflict("history-meta-malformed");
    expectedTotalMemories += value.memories;
    expectedTotalConversations += value.conversations;
  }
  const totalMemories = read.value.totalMemories;
  const totalConversations = read.value.totalConversations;
  if (totalMemories === undefined && totalConversations === undefined) return NEEDED; // 総計フィールド自体が丸ごと不足＝安全に補える
  if (typeof totalMemories !== "number" || typeof totalConversations !== "number") return conflict("history-meta-malformed");
  if (totalMemories !== expectedTotalMemories || totalConversations !== expectedTotalConversations) {
    return conflict("history-meta-total-mismatch");
  }
  return monthVerdict;
}

/**
 * M3対応：既にVaultに存在する（＝repair対象の）複数member day-fileについて、Phase 2初期版では
 * 「初期版では自動修復対象外」として安全に保留する条件（unsafe/conflictとは別の、識別可能な理由）。
 * 単一member（Conversation／Reflection／day-fileがmember 1件だけ）や、day-file自体を今回新規作成
 * する場合（create-day）は対象外——このガードはrepair対象の複数member day-fileだけに適用する。
 */
function isOutOfScopeMultiMemberRepair(op: RecoveryJournalOp, ctx: OpContext): boolean {
  return op.kind === "repair" && op.recordType === "memory" && (ctx.fileMembers ?? []).length > 1;
}

async function inspectHistory(env: RecoveryApplyEnv, op: RecoveryJournalOp, ctx: OpContext): Promise<StepVerdict> {
  const h = op.expected.history;
  if (!h) return SATISFIED;
  const read = await readJsonAt(env.root, historyPath(h.day));
  if (read.state === "error") return conflict("history-unreadable");
  if (read.state === "absent") {
    // Codexレビュー再指摘M3（History月ファイルは存在するが対象日/member行が不存在のケースが
    // 見逃されていた）対応：ここは「月ファイル自体が丸ごと不存在」のケース。
    if (isOutOfScopeMultiMemberRepair(op, ctx)) {
      return conflict("history-missing-for-multi-member-dayfile-out-of-scope-v1");
    }
    return NEEDED;
  }
  const rowsVerdict = await inspectHistoryRows(env, op, ctx, h, read.value);
  if (rowsVerdict.state === "conflict") return rowsVerdict;
  const metaVerdict = await inspectHistoryMeta(env, h.day.slice(0, 7), read.value);
  if (metaVerdict.state === "conflict") return metaVerdict;
  return rowsVerdict.state === "needed" || metaVerdict.state === "needed" ? NEEDED : SATISFIED;
}

async function inspectHistoryRows(env: RecoveryApplyEnv, op: RecoveryJournalOp, ctx: OpContext, h: { day: string; ids: string[] }, value: Obj): Promise<StepVerdict> {
  const days = value.days;
  if (!isObj(days)) return conflict("history-malformed");
  const entry = days[h.day];
  if (entry === undefined) {
    // Codexレビュー再指摘M3：月ファイルは存在するが、対象日自体のエントリが不存在のケース
    // （「月ファイル自体が丸ごと不存在」とは別に、こちらも同じ理由で保留する）。
    if (isOutOfScopeMultiMemberRepair(op, ctx)) return conflict("history-missing-for-multi-member-dayfile-out-of-scope-v1");
    return NEEDED;
  }
  if (!isObj(entry)) return conflict("history-malformed");
  const v2 = Array.isArray(entry.conversations);
  const list = (key: string): unknown[] | null => (Array.isArray(entry[key]) ? (entry[key] as unknown[]) : null);
  const member = op.members[0];
  if (op.recordType === "conversation") {
    const c = ctx.records[0] as Conversation;
    if (!v2) return Array.isArray(entry.conversationIds) && entry.conversationIds.includes(member.id) ? SATISFIED : conflict("history-v1-day");
    const row = list("conversations")?.find((r) => isObj(r) && r.id === member.id);
    if (!row) return NEEDED;
    return rowEquals(row, { id: c.id, mode: conversationEntryKindOf(c.persona), turnCount: c.turns.length }) ? SATISFIED : conflict("history-row-differs");
  }
  if (op.recordType === "reflection") {
    const m = ctx.records[0] as MemoryObject;
    if (!v2) return Array.isArray(entry.reflectionIds) && entry.reflectionIds.includes(member.id) ? SATISFIED : conflict("history-v1-day");
    const row = list("reflections")?.find((r) => isObj(r) && r.id === member.id);
    if (!row) return NEEDED;
    return rowEquals(row, { id: m.id, preview: truncateHistoryPreview(m.summary), createdAt: m.createdAt }) ? SATISFIED : conflict("history-row-differs");
  }
  // memory（day-file単位）
  const members = ctx.fileMembers ?? [];
  if (!v2) return Number(entry.normalMemoryCount) === members.length ? SATISFIED : conflict("history-v1-day");
  const rows = list("normalMemories") ?? [];
  const expectedIds = members.map((m) => m.id);
  if (rows.some((r) => !isObj(r) || typeof r.id !== "string" || !expectedIds.includes(r.id))) return conflict("history-extra-rows");
  const missing = members.filter((m) => !rows.some((r) => isObj(r) && r.id === m.id));
  for (const m of members) {
    const row = rows.find((r) => isObj(r) && r.id === m.id);
    if (row && !rowEquals(row, memoryHistoryRow(m))) return conflict("history-row-differs");
  }
  if (missing.length === 0) return SATISFIED;
  // Codexレビュー再指摘M3：既存の複数member day-file自体は、対象行の一部だけが不足している場合でも
  // Phase 2初期版では自動修復対象外として保留する（この記録自身の行だけが不足している場合も含む）。
  if (isOutOfScopeMultiMemberRepair(op, ctx)) return conflict("history-missing-for-multi-member-dayfile-out-of-scope-v1");
  // 補ってよいのは、この記録（op.members）自身の行だけ。他のmemberの行まで一緒に補う必要があるなら保留する。
  const opIds = new Set(op.members.map((x) => x.id));
  return missing.every((m) => opIds.has(m.id)) ? NEEDED : conflict("history-incomplete-day");
}

/** `op.path`が指す実ファイルの現在のmtime/size。読めなければnull。 */
async function currentPathStat(env: RecoveryApplyEnv, path: string): Promise<{ size: number; mtime: number } | null> {
  const segments = path.split("/");
  try {
    let dir = env.root;
    for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
    return await vaultRecoveryPrimitives.readVaultFileStat(dir, segments[segments.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Codexレビュー再指摘H2-2（Registry entry検証の不足）対応：以前はstatus／contentHash／memberIds
 * （＋sizeが渡された場合のみ）しか確認しておらず、**recordTypeとmtimeは一切見ていなかった**ため、
 * それらだけが実体と食い違っていてもrecoveredになってしまっていた。ここでは
 * recordType・mtime・memberHashes（memory-dayでは必須）まで含めて確認する。
 * memberHashesは「存在したら比較」ではなく、必要なrecordType（memory-day）で欠損していること自体を
 * 失敗として扱う（値が無い＝比較を素通りさせない）。
 */
async function inspectRegistry(env: RecoveryApplyEnv, op: RecoveryJournalOp, ctx: OpContext, actualSize: number | undefined): Promise<StepVerdict> {
  const exp = op.expected.registry;
  if (!exp) return SATISFIED;
  const bucket = vaultRegistryBucketOf(exp.key);
  const read = await readJsonAt(env.root, shardPath(bucket));
  if (read.state === "error") return conflict("registry-unreadable");
  if (read.state === "absent") return NEEDED;
  const records = read.value.records;
  const files = read.value.files;
  if (!isObj(records) || !isObj(files)) return conflict("registry-malformed");
  const path = records[exp.key];
  if (path === undefined) return files[exp.path] === undefined ? NEEDED : conflict("registry-path-owned-by-other-key");
  if (path !== exp.path) return conflict("registry-path-differs");
  const entry = files[exp.path];
  if (!isObj(entry)) return conflict("registry-entry-missing");
  const memberIds = Array.isArray(entry.memberIds) ? (entry.memberIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (entry.status !== "ok" || entry.contentHash !== exp.contentHash || !sameSet(memberIds, exp.memberIds)) return conflict("registry-entry-differs");
  const expectation = registryExpectation(op, ctx);
  if (entry.recordType !== expectation.recordType) return conflict("registry-recordtype-differs");
  if (actualSize !== undefined && entry.size !== actualSize) return conflict("registry-size-differs");
  // Codexレビュー残課題H2-2（mtimeを確認できなかった場合）対応：以前は`stat`が取得できない
  // （＝`currentPathStat`がnullを返した）場合、mtime確認そのものを黙って素通りしていた——
  // 「確認不能」は「成功」ではない。statを取得できなければmtimeが正しいとは証明できないため、
  // ここではNEEDED/absentとは扱わず（＝存在しないと混同しない）、確認不能自体をconflict（保留）にする。
  const stat = await currentPathStat(env, op.path);
  if (!stat) return conflict("registry-stat-unavailable");
  if (typeof entry.mtime === "number" && entry.mtime !== stat.mtime) return conflict("registry-mtime-differs");
  if (expectation.recordType === "memory-day") {
    if (!isObj(entry.memberHashes)) return conflict("registry-memberhashes-missing");
    const expectedHashes = expectation.memberHashes ?? {};
    for (const id of Object.keys(expectedHashes)) {
      if ((entry.memberHashes as Obj)[id] !== expectedHashes[id]) return conflict("registry-member-hash-differs");
    }
  }
  return SATISFIED;
}

async function inspectLedger(env: RecoveryApplyEnv, op: RecoveryJournalOp): Promise<StepVerdict> {
  let needed = false;
  for (const l of op.expected.ledger) {
    let value: string | undefined;
    try {
      value = await env.readLedger(l.key);
    } catch {
      return conflict("ledger-unreadable");
    }
    if (value === undefined) needed = true;
    else if (value !== l.value) {
      // 新規作成（create）では、この記録を今まさに保存先へ書いた結果として台帳を更新するのが正しい。
      // 既存（repair）で台帳が食い違っているのは矛盾であり、不足とはみなさない。
      if (op.kind === "repair") return conflict("ledger-differs");
      needed = true;
    }
  }
  return needed ? NEEDED : SATISFIED;
}

async function inspectStep(env: RecoveryApplyEnv, op: RecoveryJournalOp, ctx: OpContext, step: RecoveryStepName, size: number | undefined): Promise<StepVerdict> {
  switch (step) {
    case "markdown": return inspectMarkdown(env, op, ctx);
    case "index": return inspectIndex(env, op);
    case "history": return inspectHistory(env, op, ctx);
    case "registry": return inspectRegistry(env, op, ctx, size);
    case "ledger": return inspectLedger(env, op);
  }
}

const STEP_ORDER: RecoveryStepName[] = ["markdown", "index", "history", "registry", "ledger"];

// ---------------------------------------------------------------------------
// 管理ファイルの書き込み（前後を読み直して、他の項目が変わっていないことを確認する）
// ---------------------------------------------------------------------------

class RecoveryStepError extends Error {}
/** B1対応：破損したまま復元もできなかった（Cで、backup自体を書き戻せなかった）ことを表す、区別可能な例外。
 * これに限りjournalをcompletedにせず、通常write gateを効かせたまま`applyRecovery`を終える。 */
class RecoveryUnresolvedMetadataError extends Error {}

/** 0byteは「不存在」と同じ意味に正規化する（Vault全体の既存慣習——skeleton・adopt対象確認と同じ）。 */
function normalizedTextHash(read: TextRead): string | null {
  if (read.state === "absent") return null;
  if (read.state === "error") return "unreadable";
  return read.text.length === 0 ? null : hashVaultText(read.text);
}

async function writeRawManagedFile(env: RecoveryApplyEnv, path: string, content: string): Promise<void> {
  const segments = path.split("/");
  await env.runWrite(async () => {
    let dir = env.root;
    for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true });
    await vaultRecoveryPrimitives.writeFileInDir(dir, segments[segments.length - 1], content, "recovery restore");
  });
}

/**
 * 書き込み前にpathが存在しなかった場合の復元は、0byteファイルを書くのではなく実際に削除する。
 * `readRecoveryJson`（Recovery診断・Plan生成が使う、`vaultRecovery.ts`の厳密reader）は0byteファイルを
 * 「不存在」とは扱わず`JSON.parse("")`が失敗して`parse-error`になる——0byteでの代用は、復元したはずの
 * 「不存在」を新たな読み取り不能に変えてしまう（vault.ts自身の一部の緩いreaderとは扱いが異なる）。
 * 削除先が既に無い（NotFoundError）場合は、目的（不存在に戻すこと）は既に達成されているため成功とする。
 */
async function deleteManagedFile(env: RecoveryApplyEnv, path: string): Promise<boolean> {
  const segments = path.split("/");
  try {
    await env.runWrite(async () => {
      let dir = env.root;
      for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
      await dir.removeEntry(segments[segments.length - 1]);
    });
    return true;
  } catch (e) {
    return isObj(e) && (e as { name?: unknown }).name === "NotFoundError";
  }
}

/**
 * B1対応：backupから元内容へ書き戻し（不存在だった場合は削除し）、read-backしてhashが一致することまで
 * 確認する。1つでも確認できなければfalse（＝復元できなかった。呼び出し元はjournalをcompletedにしてはいけない）。
 */
/** いずれかのpathが、今、構造として読めない（JSON parse不能）かどうか。`action()`自体のthrowの直後に、
 * 対象fileが部分破壊されていないかを確認するために使う。 */
async function pathsAreUnreadable(env: RecoveryApplyEnv, paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if ((await readJsonAt(env.root, path)).state === "error") return true;
  }
  return false;
}

async function restoreFromBackups(env: RecoveryApplyEnv, backups: RecoveryMetadataBackup[]): Promise<boolean> {
  for (const backup of backups) {
    if (backup.beforeHash === "unreadable") return false; // backup自体が「読めなかった」＝復元先が無い
    try {
      if (backup.beforeContent === null) {
        if (!(await deleteManagedFile(env, backup.path))) return false;
      } else {
        await writeRawManagedFile(env, backup.path, backup.beforeContent);
      }
    } catch {
      return false;
    }
    const verify = normalizedTextHash(await readTextAt(env.root, backup.path));
    if (verify !== backup.beforeHash) return false;
  }
  return true;
}

/**
 * B1対応：共有metadataを書き換える前に、必ず「書き込み前の完全な内容」をRecovery Journalへ永続化し、
 * 読み戻して保存できたことを確認してから初めてwriteを行う（保存できなければwriteを開始しない）。
 * write後は読み戻してafterHashを記録する。invariant違反（他のkey/日/fileが巻き込まれて変わった）が
 * 見つかった場合は、このbackupから書き戻して復元する（restoreできなければ`RecoveryUnresolvedMetadataError`）。
 */
async function guardedManagedWrite(
  env: RecoveryApplyEnv,
  journal: RecoveryJournal,
  op: RecoveryJournalOp,
  paths: string[],
  action: () => Promise<void>,
  check: (before: Map<string, Obj | null>, after: Map<string, Obj | null>) => string | null
): Promise<void> {
  const backups: RecoveryMetadataBackup[] = [];
  for (const path of paths) {
    const read = await readTextAt(env.root, path);
    if (read.state === "error") throw new RecoveryStepError("managed-file-unreadable");
    backups.push({ path, beforeContent: read.state === "ok" && read.size > 0 ? read.text : null, beforeHash: normalizedTextHash(read), afterHash: null });
  }
  op.metadataBackups = [...op.metadataBackups.filter((b) => !paths.includes(b.path)), ...backups];
  await persist(env, journal); // 保存・読み戻しできなければここで例外（writeは一切開始しない）。

  const jsonSnapshot = async () => {
    const out = new Map<string, Obj | null>();
    for (const path of paths) {
      const read = await readJsonAt(env.root, path);
      if (read.state === "error") throw new RecoveryStepError("managed-file-unreadable");
      out.set(path, read.state === "absent" ? null : read.value);
    }
    return out;
  };
  const beforeJson = await jsonSnapshot();
  // Codexレビュー再指摘B1（action()自体のthrowがrestore対象外）対応：`action()`は複数の物理writeを
  // 内部で行いうる（例：History＝月ファイル→meta の2回）。片方が既存fileを書き換えた（部分的に破壊した
  // 可能性がある）直後に、もう片方の書き込みで`action()`自体が例外を投げるケースも、write成功後の
  // 検証（下のjsonSnapshot）と全く同じ扱いにする——`action()`のthrow自体を握りつぶさず、必ず対象pathの
  // 実体を確認し、構造として読めなくなっていればbackupから復元を試みる。復元できなければ
  // `RecoveryUnresolvedMetadataError`（journalをcompletedにしない）。
  try {
    await action();
  } catch (actionError) {
    const anyUnreadable = await pathsAreUnreadable(env, paths);
    let problem: string | null = null;
    if (anyUnreadable) {
      problem = "managed-file-corrupted-during-write";
    } else {
      // Codexレビュー残課題B1：「JSONとしてparseできる」ことは「安全」の証明にならない——action()の
      // 失敗と同時に、Recoveryが変更してよい範囲の外側（他のkey・他の日・他のfile）が壊れている
      // 場合がありうる。成功経路（このあとのcheck(beforeJson, afterJson)呼び出し）で使っているのと
      // 全く同じinvariantチェックを、ここでも同じ基準で必ず適用する（別々の安全基準を持たせない）。
      try {
        problem = check(beforeJson, await jsonSnapshot());
      } catch {
        problem = "managed-file-corrupted-during-write";
      }
    }
    if (problem) {
      if (!(await restoreFromBackups(env, backups))) throw new RecoveryUnresolvedMetadataError(problem);
    }
    // 復元不要（Recoveryが変更してよい範囲しか変わっていない）、または復元できた場合は、backupに
    // 触れる必要はない——read-modify-writeの絶対値書き込みは冪等なため、次回の試行がそのまま安全に
    // 続きを完了できる（通常のop失敗として扱い、journalはcompletedにしてよい）。
    throw actionError instanceof RecoveryStepError || actionError instanceof RecoveryUnresolvedMetadataError
      ? actionError
      : new RecoveryStepError(actionError instanceof Error ? actionError.message : "action-failed");
  }
  // B1対応：write実行後、対象pathが構造として読めなくなっていた（JSON parse不能＝OPFS writeの
  // truncate/flush途中でgarbageになった等）場合も、単なる「不整合」（`check`が検出する対象キー以外の
  // 変化）と同じ扱いにする——backupから復元を試み、復元できなければ`RecoveryUnresolvedMetadataError`
  // （journalをcompletedにしない）、復元できれば`RecoveryStepError`（このopの今回の試行は失敗として
  // 扱うが、backupへ安全に戻せているため次回再試行できる。journal自体は完了扱いにしてよい）。
  let afterJson: Map<string, Obj | null>;
  try {
    afterJson = await jsonSnapshot();
  } catch {
    if (!(await restoreFromBackups(env, backups))) throw new RecoveryUnresolvedMetadataError("managed-file-corrupted-after-write");
    throw new RecoveryStepError("managed-file-corrupted-after-write");
  }
  const problem = check(beforeJson, afterJson);
  if (problem) {
    if (!(await restoreFromBackups(env, backups))) throw new RecoveryUnresolvedMetadataError(problem);
    throw new RecoveryStepError(problem);
  }
  for (const backup of backups) backup.afterHash = normalizedTextHash(await readTextAt(env.root, backup.path));
  op.metadataBackups = [...op.metadataBackups.filter((b) => !paths.includes(b.path)), ...backups];
  await persist(env, journal);
}

function stepPaths(op: RecoveryJournalOp, step: RecoveryStepName): string[] {
  if (step === "index") return [INDEX_PATH];
  if (step === "history") return op.expected.history ? [historyPath(op.expected.history.day), HISTORY_META_PATH] : [];
  if (step === "registry") return op.expected.registry ? [shardPath(vaultRegistryBucketOf(op.expected.registry.key))] : [];
  return [];
}

export type MetadataReconcileVerdict = "ready" | "blocked";

/**
 * B1対応：resume時（前回の試行がこのstepの途中で終わっていた可能性がある場合）に、進捗flagだけを
 * 信用せず、実ファイルの状態を確認する。
 *
 * 進捗flag（`op.steps`）自体は使わない。判定は「このpathへの書き込みを、このopで前回すでに
 * 試みたか（＝`op.metadataBackups`に記録があるか）」と「今、実際に読めるか（構造として壊れて
 * いないか）」だけで行う：
 * - このopでまだ一度もこのpathへ触れていない（backup記録なし）→ 何もしない（`ready`）。通常の
 *   `inspectStep`（A：既に完了＝satisfied／B：未着手＝needed／conflict）に判定を任せる。
 *   vault.tsの各write関数はread-modify-writeの絶対値書き込みで冪等なため、A・Bのどちらであっても
 *   単純に再実行するだけで安全に正しい状態へ収束する（H2-1で確認した性質と同じ）。
 * - 前回このpathへ触れた形跡がある（backup記録あり）のに、今は構造として読めない
 *   （JSON parse不能＝Cの破損状態）→ backupの`beforeContent`から復元し、read-backで確認する。
 *   復元できれば`ready`（読めるようになった以前の内容から、通常どおり安全に再試行できる）。
 *   復元できなければ`blocked`（安全に進められない。journalをcompletedにせず、通常write gateを
 *   効かせたまま終える）。
 * backup記録が無いパスが読めない場合は、このRecoveryが原因の破損ではない（他の原因の既存の
 * 読み取り不能）ため、ここでは何もしない——既存の`inspectStep`のconflict判定（そのopだけを
 * 安全に保留する）に委ねる。
 */
async function reconcileMetadataStep(env: RecoveryApplyEnv, op: RecoveryJournalOp, step: RecoveryStepName): Promise<MetadataReconcileVerdict> {
  const paths = stepPaths(op, step);
  const relevant = op.metadataBackups.filter((b) => paths.includes(b.path));
  for (const backup of relevant) {
    const read = await readJsonAt(env.root, backup.path);
    if (read.state !== "error") continue; // 構造として読める（内容が正しいかはinspectStepが見る）
    if (!(await restoreFromBackups(env, [backup]))) return "blocked";
  }
  // Codexレビュー残課題B1：ここまでは「parseできるか」しか見ていない。「parseできる」ことは
  // 「Recoveryが変更してよい範囲の外側が、backup記録時点（before）から変化していない」ことを
  // 意味しない——前回のプロセス生存中に書き込みが行われ、他のkey・他の日・他のfileを巻き込んで
  // 破損させた直後にkillされた、という状態もparse可能なJSONのまま起こりうる。このstepの対象path
  // すべてについてbackup記録がある（＝前回このopがこのstepに実際に触れた形跡がある）場合に限り、
  // 成功経路（`guardedManagedWrite`）が使っているのと同じinvariantチェックを、backupの
  // `beforeContent`（このopの書き込み開始前の内容）と現在の内容とで再度確認する。
  if (paths.length > 0 && relevant.length === paths.length) {
    try {
      const before = new Map<string, Obj | null>();
      for (const backup of relevant) before.set(backup.path, backup.beforeContent === null ? null : (JSON.parse(backup.beforeContent) as Obj));
      const after = new Map<string, Obj | null>();
      for (const path of paths) {
        const read = await readJsonAt(env.root, path);
        if (read.state === "error") return "blocked"; // 直前に復元を試みたはずが再度読めない：安全に進められない
        after.set(path, read.state === "absent" ? null : read.value);
      }
      const problem = invariantCheckFor(op, step)(before, after);
      if (problem && !(await restoreFromBackups(env, relevant))) return "blocked";
    } catch {
      return "blocked";
    }
  }
  return "ready";
}

const jsonEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function checkIndexInvariant(allowedIds: string[]) {
  return (before: Map<string, Obj | null>, after: Map<string, Obj | null>): string | null => {
    const b = before.get(INDEX_PATH) ?? {};
    const a = after.get(INDEX_PATH);
    if (!a) return "index-missing-after-write";
    for (const [k, v] of Object.entries(b)) if (a[k] !== v) return "index-entry-changed";
    for (const k of Object.keys(a)) if (!(k in b) && !allowedIds.includes(k)) return "index-unexpected-entry";
    return null;
  };
}

/**
 * Codexレビュー残課題B1（同日の対象外History行の内容保護）対応：このopが今回変更してよいのは、
 * どのキーの、どのidの行だけか。conversation／reflectionは自分自身の1行だけ、memory（day-file）は
 * `op.expected.history.ids`（そのday-fileの全member。日をまたいだ他dayには影響しない）だけ。
 * それ以外の行（同じ日の別record・別memberの行）は、このopからは一切変更されないはずなので、
 * before/after間で完全一致を要求する（`checkHistoryInvariant`から参照）。
 */
function allowedHistoryRowIds(op: RecoveryJournalOp): { key: "conversations" | "reflections" | "normalMemories"; ids: Set<string> } | null {
  if (op.recordType === "conversation") return { key: "conversations", ids: new Set([op.members[0].id]) };
  if (op.recordType === "reflection") return { key: "reflections", ids: new Set([op.members[0].id]) };
  if (op.recordType === "memory") return { key: "normalMemories", ids: new Set(op.expected.history?.ids ?? []) };
  return null; // source：Historyを持たない
}

function checkHistoryInvariant(op: RecoveryJournalOp) {
  const day = op.expected.history!.day;
  const monthFile = historyPath(day);
  const allowed = allowedHistoryRowIds(op);
  return (before: Map<string, Obj | null>, after: Map<string, Obj | null>): string | null => {
    const b = before.get(monthFile), a = after.get(monthFile);
    if (!a) return "history-missing-after-write";
    const bDays = (isObj(b?.days) ? b.days : {}) as Obj, aDays = (isObj(a.days) ? a.days : {}) as Obj;
    for (const [d, v] of Object.entries(bDays)) {
      if (d === day) continue;
      if (!jsonEqual(v, aDays[d])) return "history-other-day-changed";
    }
    const bDay = bDays[day], aDay = aDays[day];
    if (isObj(bDay) && isObj(aDay) && Array.isArray(bDay.conversations)) {
      for (const key of ["conversations", "normalMemories", "reflections"] as const) {
        const beforeRows = (Array.isArray(bDay[key]) ? bDay[key] : []) as unknown[];
        const afterRows = (Array.isArray(aDay[key]) ? aDay[key] : []) as unknown[];
        if (!beforeRows.every((row) => afterRows.some((r) => isObj(row) && isObj(r) && r.id === row.id && (key !== "normalMemories" || jsonEqual(r.types, row.types))))) return "history-row-lost";
        // Codexレビュー残課題B1：このopが変更を許可されていない行（同じ日の別record・別member）は、
        // idの存続だけでなく行全体がbeforeと同値であることを要求する（「存在している」だけでは不十分）。
        const rowAllowed = allowed?.key === key ? allowed.ids : null;
        for (const row of beforeRows) {
          if (!isObj(row) || typeof row.id !== "string") continue;
          if (rowAllowed?.has(row.id)) continue; // このopが変更してよい行（対象自身）
          const afterRow = afterRows.find((r) => isObj(r) && r.id === row.id);
          if (!afterRow || !jsonEqual(afterRow, row)) return "history-row-changed";
        }
      }
    }
    const month = day.slice(0, 7);
    const bMeta = before.get(HISTORY_META_PATH), aMeta = after.get(HISTORY_META_PATH);
    const bMonths = (isObj(bMeta?.months) ? bMeta.months : {}) as Obj, aMonths = (isObj(aMeta?.months) ? aMeta.months : {}) as Obj;
    for (const [m, v] of Object.entries(bMonths)) if (m !== month && !jsonEqual(v, aMonths[m])) return "history-meta-other-month-changed";
    return null;
  };
}

function checkShardInvariant(path: string, key: string, filePath: string) {
  return (before: Map<string, Obj | null>, after: Map<string, Obj | null>): string | null => {
    const b = before.get(path), a = after.get(path);
    if (!a || !isObj(a.records) || !isObj(a.files)) return "registry-missing-after-write";
    const bRecords = (isObj(b?.records) ? b.records : {}) as Obj, bFiles = (isObj(b?.files) ? b.files : {}) as Obj;
    for (const [k, v] of Object.entries(bRecords)) if (k !== key && a.records[k] !== v) return "registry-other-key-changed";
    for (const [p, v] of Object.entries(bFiles)) if (p !== filePath && !jsonEqual(v, a.files[p])) return "registry-other-file-changed";
    return null;
  };
}

/**
 * B1対応：`checkIndexInvariant`／`checkHistoryInvariant`／`checkShardInvariant`の構築に必要な引数
 * （許可されたid・対象day・registryのkey/path）は、すべて`op`だけから決定的に再構築できる
 * （`ctx`＝レコード本文は不要）。この性質を使い、成功経路（`execStep`）が使っているのと全く同じ
 * invariantチェックを、`op`と`step`だけから、例外時・resume時にも再利用できるようにする
 * （Codexレビュー指摘：成功経路と例外/resume経路で別々の安全基準を持たせない）。
 */
function invariantCheckFor(op: RecoveryJournalOp, step: RecoveryStepName): (before: Map<string, Obj | null>, after: Map<string, Obj | null>) => string | null {
  if (step === "index") return checkIndexInvariant(op.expected.indexEntries.map((e) => e.id));
  if (step === "history") return op.expected.history ? checkHistoryInvariant(op) : () => null;
  if (step === "registry") {
    const reg = op.expected.registry;
    return reg ? checkShardInvariant(shardPath(vaultRegistryBucketOf(reg.key)), reg.key, reg.path) : () => null;
  }
  return () => null;
}

// ---------------------------------------------------------------------------
// stepの実行
// ---------------------------------------------------------------------------

async function execStep(env: RecoveryApplyEnv, journal: RecoveryJournal, op: RecoveryJournalOp, ctx: OpContext, step: RecoveryStepName): Promise<void> {
  const prim = vaultRecoveryPrimitives;
  const segments = op.path.split("/");
  const fileName = segments[segments.length - 1];
  if (step === "markdown") {
    // create専用（repairはMarkdownを絶対に書かない）。既存の別内容は上書きしない（inspectMarkdownがconflictにする）。
    if (op.kind === "repair") throw new RecoveryStepError("repair-never-writes-markdown");
    await env.runWrite(async () => {
      const dir = await env.root.getDirectoryHandle(segments[0], { create: true });
      await prim.writeFileInDir(dir, fileName, ctx.content, "recovery markdown");
    });
    return;
  }
  if (step === "index") {
    await guardedManagedWrite(
      env,
      journal,
      op,
      [INDEX_PATH],
      async () => {
        for (const entry of op.expected.indexEntries) await env.runWrite(() => prim.updateIndex(env.root, entry.id, entry.path));
      },
      invariantCheckFor(op, step)
    );
    return;
  }
  if (step === "history") {
    const h = op.expected.history;
    if (!h) return;
    await guardedManagedWrite(
      env,
      journal,
      op,
      [historyPath(h.day), HISTORY_META_PATH],
      async () => {
        if (op.recordType === "conversation") {
          const c = ctx.records[0] as Conversation;
          await env.runWrite(() => prim.updateHistoryIndex(env.root, { kind: "conversation", id: c.id, day: h.day, mode: conversationEntryKindOf(c.persona), turnCount: c.turns.length }));
        } else if (op.recordType === "reflection") {
          const m = ctx.records[0] as MemoryObject;
          await env.runWrite(() => prim.updateHistoryIndex(env.root, { kind: "reflection", id: m.id, day: h.day, preview: truncateHistoryPreview(m.summary), createdAt: m.createdAt }));
        } else {
          const rows = (ctx.fileMembers ?? []).map(memoryHistoryRow);
          await env.runWrite(() => prim.updateHistoryIndex(env.root, { kind: "memory", day: h.day, normalMemories: rows }));
        }
      },
      invariantCheckFor(op, step)
    );
    return;
  }
  if (step === "registry") {
    const exp = registryExpectation(op, ctx);
    const bucket = vaultRegistryBucketOf(exp.key);
    await guardedManagedWrite(
      env,
      journal,
      op,
      [shardPath(bucket)],
      async () => {
        await env.runWrite(async () => {
          let dir = env.root;
          for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
          const stat = await prim.readVaultFileStat(dir, fileName);
          await prim.upsertVaultRegistryRecord(env.root, {
            registryKey: exp.key,
            path: exp.path,
            recordType: exp.recordType,
            mtime: stat.mtime,
            size: stat.size,
            contentHash: exp.contentHash,
            memberIds: exp.memberIds,
            memberHashes: exp.memberHashes,
          });
        });
      },
      invariantCheckFor(op, step)
    );
    return;
  }
  // ledger：この端末のIndexedDBの記録本文は変更しない。同期済み台帳へ、保存先へ実際に反映できた記録だけを記す。
  for (const l of op.expected.ledger) await env.writeLedger(l.key, l.value);
}

// ---------------------------------------------------------------------------
// 計画（Plan → 実行可能なop）
// ---------------------------------------------------------------------------

export interface RecoveryHeld {
  recordType: string;
  recordId: string;
  reason: string;
}

/**
 * M1対応（confirmed set）：Dry Runでユーザーに見せた時点の「世界」と「対象record ID集合」。
 * Applyは、このconfirmed setに含まれる記録だけを対象にする（Dry Run後に新しく増えた安全な記録を
 * 勝手に追加しない）。worldが変わっていれば、confirmed set自体が古いためApplyを拒否し、
 * 再確認を要求する。
 */
export interface RecoveryConfirmedSet {
  world: RecoveryJournalWorld;
  recordIds: string[];
}

export interface RecoveryApplyPlan {
  plan: RecoveryPlan;
  ops: RecoveryJournalOp[];
  /** 復旧できる記録の件数（opのmember数の合計）。 */
  recoverableCount: number;
  held: RecoveryHeld[];
  heldCount: number;
  snapshot: RecoveryLocalSnapshot;
  /** このPlanをそのままユーザーに見せて確認を得た場合に、Applyへ渡すべきconfirmed set。 */
  confirmed: RecoveryConfirmedSet;
}

function findLocal(snapshot: RecoveryLocalSnapshot, r: RecoveryRecord): LocalRecord | undefined {
  if (r.recordType === "conversation") return snapshot.conversations.find((x) => x.id === r.recordId);
  if (r.recordType === "source") return snapshot.sources.find((x) => x.id === r.recordId);
  return snapshot.memories.find((x) => x.id === r.recordId);
}

function memberOf(type: RecoveryRecordType, record: LocalRecord): RecoveryJournalMember {
  return { id: record.id, recordType: type, syncKey: vaultSyncKeyFor(syncKindOf(type), record.id), updatedAt: record.updatedAt, recordHash: hashRecord(record) };
}

function baseOp(env: RecoveryApplyEnv, kind: RecoveryJournalOp["kind"], type: RecoveryRecordType, day: string | null, members: RecoveryJournalMember[], path: string, ctx: OpContext, registryKey: string): RecoveryJournalOp {
  const memberIdsForIndex = members.map((m) => m.id);
  const op: RecoveryJournalOp = {
    opId: env.newId(),
    kind,
    recordType: type,
    day,
    members,
    path,
    expectedContentHash: hashVaultText(ctx.content),
    expectedContentLength: byteLength(ctx.content),
    registryKey,
    expected: {
      indexEntries: memberIdsForIndex.map((id) => ({ id, path })),
      registry: null,
      history: type === "source" ? null : { day: day as string, ids: type === "memory" ? (ctx.fileMembers ?? []).map((m) => m.id) : memberIdsForIndex },
      ledger: members.map((m) => ({ key: m.syncKey, value: m.updatedAt })),
    },
    steps: { markdown: "pending", index: "pending", history: type === "source" ? "not-needed" : "pending", registry: "pending", ledger: "pending" },
    metadataBackups: [],
    status: "pending",
    failure: null,
  };
  const reg = registryExpectation(op, ctx);
  op.expected.registry = { key: reg.key, path: reg.path, contentHash: reg.contentHash, memberIds: reg.memberIds };
  return op;
}

const HELD_REASON: Partial<Record<RecoveryRecord["classification"], string>> = {
  conflict: "conflict",
  "memory-dayfile-merge-required": "memory-dayfile-merge-required",
  "unreadable / indeterminate": "unreadable-or-indeterminate",
};

/** 実行直前のPlanから、実行できるopを作る。何も書かない。 */
export async function planRecoveryApply(env: RecoveryApplyEnv, confirmedIds: Set<string> | null = null): Promise<RecoveryApplyPlan> {
  const world = await env.readWorld();
  const snapshot = await env.readLocalSnapshot();
  const plan = await buildVaultRecoveryPlan(env.root, snapshot, env.signal);
  const held: RecoveryHeld[] = [];
  const ops: RecoveryJournalOp[] = [];
  const hold = (r: RecoveryRecord, reason: string) => held.push({ recordType: r.recordType, recordId: r.recordId, reason });

  // baselineを読めない／走査が完了していない場合は何もしない（不在を証明できない）。
  const globallyBlocked = !plan.scanCompleted || plan.baseline.status === "unconfirmed" || plan.issues.length > 0;

  const createByDay = new Map<string, RecoveryRecord[]>();
  const creates: { r: RecoveryRecord; local: LocalRecord }[] = [];
  const repairs: { r: RecoveryRecord; local: LocalRecord }[] = [];
  for (const r of plan.records) {
    if (r.classification === "vault-only") continue; // 保存先にだけある記録は対象外（変更しない）
    const reason = HELD_REASON[r.classification];
    if (reason) { hold(r, reason); continue; }
    const local = findLocal(snapshot, r);
    if (!local) { hold(r, "record-unavailable"); continue; }
    if (globallyBlocked) { hold(r, "scan-incomplete"); continue; }
    // M1対応：confirmedIdsが指定されている場合（＝新規Apply、Dry Run結果からの実行）、ユーザーが
    // 確認した集合に無い記録は対象にしない（Dry Run後に新しく増えた記録を勝手に追加しない）。
    if (confirmedIds && !confirmedIds.has(r.recordId)) { hold(r, "not-confirmed"); continue; }
    if (r.classification === "local-only-safe") {
      if (r.recordType === "memory") {
        const day = r.date.slice(0, 10);
        createByDay.set(day, [...(createByDay.get(day) ?? []), r]);
      } else creates.push({ r, local });
    } else if (r.classification === "equivalent-existing") repairs.push({ r, local });
  }

  // ---- create（Conversation／Reflection／Source：1件1ファイル） ----
  const pathOwners = new Map<string, number>();
  const plannedCreates: { r: RecoveryRecord[]; op: RecoveryJournalOp }[] = [];
  const addCreate = (rs: RecoveryRecord[], type: RecoveryRecordType, kind: "create" | "create-day", day: string, locals: LocalRecord[], registryKey: string) => {
    const path = targetPathOf(type, locals[0]);
    const ctx: OpContext = { records: locals, ...contentOfCreate(type, locals) };
    const op = baseOp(env, kind, type, day, locals.map((l) => memberOf(type, l)), path, ctx, registryKey);
    pathOwners.set(path, (pathOwners.get(path) ?? 0) + 1);
    plannedCreates.push({ r: rs, op });
  };
  for (const { r, local } of creates) {
    const type = r.recordType as RecoveryRecordType;
    addCreate([r], type, "create", r.date.slice(0, 10), [local], r.registryKey);
  }
  // ---- create-day（Memory：その日のday-fileが保存先に無い日だけ） ----
  const localNormalByDay = new Map<string, MemoryObject[]>();
  for (const m of snapshot.memories) {
    if (isReflectionSummary(m)) continue;
    const day = m.date.slice(0, 10);
    localNormalByDay.set(day, [...(localNormalByDay.get(day) ?? []), m]);
  }
  for (const [day, rs] of createByDay) {
    const locals = localNormalByDay.get(day) ?? [];
    const safeIds = new Set(rs.map((x) => x.recordId));
    // その日のIndexedDB上のMemory全員が「安全に新規作成できる」、かつ（confirmedIds指定時は）全員が
    // ユーザーの確認済み集合にも含まれている場合だけ、まとめて1つのday-fileにする（M1：Dry Run後に
    // 同じ日へ新しいMemoryが増えていた場合、その日全体をApply対象から外す）。
    if (
      locals.length === 0 ||
      !locals.every((m) => safeIds.has(m.id)) ||
      (confirmedIds && !locals.every((m) => confirmedIds.has(m.id)))
    ) {
      for (const r of rs) hold(r, "day-has-unresolved-member");
      continue;
    }
    addCreate(rs, "memory", "create-day", day, locals, dayFileRegistryKey(day));
  }
  for (const { r, op } of plannedCreates) {
    if ((pathOwners.get(op.path) ?? 0) > 1) { r.forEach((x) => hold(x, "path-collision")); continue; }
    ops.push(op);
  }

  // ---- repair（equivalent-existing：不足している管理情報だけ） ----
  for (const { r, local } of repairs) {
    const type = r.recordType as RecoveryRecordType;
    const path = r.vaultPaths.length === 1 ? r.vaultPaths[0] : null;
    if (!path) { hold(r, "path-unresolved"); continue; }
    const text = await readTextAt(env.root, path);
    if (text.state !== "ok") { hold(r, "markdown-unreadable"); continue; }
    let fileMembers: MemoryObject[] | null = null;
    if (type === "memory") {
      fileMembers = parseDayFileStrict(text.text);
      if (!fileMembers) { hold(r, "dayfile-unparseable"); continue; }
    }
    const ctx: OpContext = { records: [local], content: text.text, fileMembers };
    const day = r.date.slice(0, 10);
    const op = baseOp(env, "repair", type, day, [memberOf(type, local)], path, ctx, r.registryKey);
    if (type === "memory") op.expected.history = { day, ids: (fileMembers ?? []).map((m) => m.id) };
    const inspected = await inspectOp(env, op, ctx);
    if (inspected.conflict) { hold(r, inspected.conflict); continue; }
    if (STEP_ORDER.every((s) => op.steps[s] === "not-needed")) continue; // 不足なし（既に整っている）
    ops.push(op);
  }

  const recoverableCount = ops.reduce((n, op) => n + op.members.length, 0);
  const confirmed: RecoveryConfirmedSet = { world, recordIds: ops.flatMap((op) => op.members.map((m) => m.id)) };
  return { plan, ops, recoverableCount, held, heldCount: held.length, snapshot, confirmed };
}

/** 実体を確認して、各stepを「必要（pending）」「不要（not-needed）」に設定する。矛盾があれば最初の理由を返す。 */
async function inspectOp(env: RecoveryApplyEnv, op: RecoveryJournalOp, ctx: OpContext): Promise<{ conflict: string | null }> {
  let size: number | undefined;
  for (const step of STEP_ORDER) {
    if (step === "history" && !op.expected.history) { op.steps.history = "not-needed"; continue; }
    if (op.kind === "repair" && step === "markdown") {
      const v = await inspectMarkdown(env, op, ctx);
      if (v.state === "conflict") return { conflict: v.detail };
      size = v.size;
      op.steps.markdown = "not-needed";
      continue;
    }
    const v = await inspectStep(env, op, ctx, step, size);
    if (v.state === "conflict") return { conflict: v.detail };
    op.steps[step] = v.state === "satisfied" ? "not-needed" : "pending";
  }
  return { conflict: null };
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

/**
 * journalの「管理ファイル変更前の状態」。ここに含めるのは、このRecoveryのどのopからも一切書き込まれない
 * ファイルだけ（`.tsumugi/registry-index.json`はfull resyncだけが作り直し、`.tsumugi/registry-meta.json`は
 * baseline/generationを含めRecoveryが一切書かない。両方とも、実行の前後で完全に同一であるべき）。
 * index.json・History月Index・Registry shardは、対象opによって正当に変わるため、ここには含めない
 * （それらの「他のkey/日/fileは変わっていないか」は`guardedManagedWrite`が書き込みのたびに個別確認する）。
 */
const GLOBAL_MANAGED_PATHS = [".tsumugi/registry-meta.json", ".tsumugi/registry-index.json"];

async function managedHashes(env: RecoveryApplyEnv): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const path of GLOBAL_MANAGED_PATHS) {
    const read = await readTextAt(env.root, path);
    out[path] = read.state === "ok" ? hashVaultText(read.text) : read.state === "absent" ? null : "unreadable";
  }
  return out;
}

async function newJournal(env: RecoveryApplyEnv, applyPlan: RecoveryApplyPlan, world: RecoveryJournalWorld): Promise<RecoveryJournal> {
  const now = env.now();
  return {
    version: 1,
    operationId: env.newId(),
    status: "in-progress",
    createdAt: now,
    updatedAt: now,
    world,
    baselineAtStart: { status: applyPlan.plan.baseline.status, value: applyPlan.plan.baseline.value },
    managedBefore: await managedHashes(env),
    ops: applyPlan.ops,
    held: applyPlan.held.map((h) => ({ ...h })),
    result: null,
    unresolvedMetadata: false,
  };
}

async function persist(env: RecoveryApplyEnv, journal: RecoveryJournal): Promise<void> {
  journal.updatedAt = env.now();
  await saveRecoveryJournal(env.store, journal);
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export type RecoveryApplyStatus =
  | "nothing-to-do"
  | "completed"
  | "interrupted"
  | "journal-unavailable"
  | "world-changed"
  | "confirmation-expired"
  | "unavailable";

export interface RecoveryApplyResult {
  status: RecoveryApplyStatus;
  /** 再確認して、全条件を満たした記録の件数。 */
  recovered: number;
  /** データを変更せず保留している記録の件数。 */
  held: number;
  /** 復旧を試みたが確認できなかった記録の件数（書き込んだ内容は残るが、recoveredには数えない）。 */
  failed: number;
  resumed: boolean;
  reason?: string;
}

const EMPTY_RESULT = { recovered: 0, held: 0, failed: 0 };

/** opのmember数を数える補助。 */
const countMembers = (ops: RecoveryJournalOp[]) => ops.reduce((n, op) => n + op.members.length, 0);

/** journalの各opが、今の実体でも「進めてよい」状態かを確認するための、現在のPlan上の分類。 */
function classificationOf(plan: RecoveryPlan, recordType: string, id: string): RecoveryRecord | undefined {
  return plan.records.find((r) => r.recordId === id && (recordType === "memory" || recordType === "reflection" ? r.recordType === "memory" || r.recordType === "reflection" : r.recordType === recordType));
}

async function buildOpContext(env: RecoveryApplyEnv, op: RecoveryJournalOp): Promise<OpContext> {
  const records: LocalRecord[] = [];
  for (const m of op.members) {
    const local = await env.readRecord(syncKindOf(m.recordType), m.id);
    if (!local) throw new RecoveryStepError("record-missing");
    if (hashRecord(local) !== m.recordHash || local.updatedAt !== m.updatedAt) throw new RecoveryStepError("record-changed");
    records.push(local);
  }
  if (op.kind === "repair") {
    const read = await readTextAt(env.root, op.path);
    if (read.state !== "ok") throw new RecoveryStepError("markdown-unreadable");
    if (hashVaultText(read.text) !== op.expectedContentHash) throw new RecoveryStepError("markdown-changed");
    const fileMembers = op.recordType === "memory" ? parseDayFileStrict(read.text) : null;
    if (op.recordType === "memory" && !fileMembers) throw new RecoveryStepError("dayfile-unparseable");
    return { records, content: read.text, fileMembers };
  }
  const built = contentOfCreate(op.recordType, records);
  if (hashVaultText(built.content) !== op.expectedContentHash) throw new RecoveryStepError("content-changed");
  return { records, ...built };
}

/** 実行後の再確認。Planを作り直し、記録ごとに全条件を満たしたopだけをverifiedにする。 */
async function verifyOps(env: RecoveryApplyEnv, journal: RecoveryJournal, before: { records: Map<string, string>; markdown: Map<string, string> }): Promise<void> {
  const pending = journal.ops.filter((op) => op.status === "pending");
  if (pending.length === 0) return;
  let snapshot: RecoveryLocalSnapshot;
  let plan: RecoveryPlan;
  try {
    snapshot = await env.readLocalSnapshot();
    plan = await buildVaultRecoveryPlan(env.root, snapshot, env.signal);
  } catch {
    for (const op of pending) { op.status = "failed"; op.failure = "verification-unavailable"; }
    return;
  }
  const opPaths = new Set(journal.ops.map((op) => op.path));
  // baselineはRecoveryで変更していない（開始時の観測値と同じ）ことも確認する。
  const baselineUnchanged = plan.baseline.status === journal.baselineAtStart.status && plan.baseline.value === journal.baselineAtStart.value;
  // world（activeVaultEpoch/registryGenerationEpoch等）が、実行中を通じて一度も変化していないことを、
  // 検証の最後にもう一度確認する（各opの直前にも確認しているが、最後のop完了〜この検証の間の変化も
  // 見逃さないため）。registry-index.json・registry-meta.json自体は、full resync（＝
  // registryGenerationEpochの変化）以外では変化しないはずなので、world不変の確認で代替できるが、
  // 「registry-index.json一致」を文字どおり確認するため、記録済みhashとも直接突き合わせる。
  let worldUnchanged: boolean;
  let currentWorld: RecoveryJournalWorld | null = null;
  try {
    currentWorld = await env.readWorld();
    worldUnchanged = sameWorld(currentWorld, journal.world);
  } catch {
    worldUnchanged = false;
  }
  const managedUnchanged = await managedFilesUnchanged(env, journal.managedBefore);
  const scanOk = plan.scanCompleted && plan.issues.length === 0 && baselineUnchanged && worldUnchanged && managedUnchanged;
  const afterMarkdown = await snapshotMarkdown(env.root);
  const untouchedProblem = (() => {
    // 対象外のMarkdownが変わっていない
    for (const [path, sig] of before.markdown) if (!opPaths.has(path) && afterMarkdown.get(path) !== sig) return "other-markdown-changed";
    // 対象外のIndexedDB recordが変わっていない
    const opIds = new Set(journal.ops.flatMap((op) => op.members.map((m) => m.id)));
    for (const [id, hash] of before.records) if (!opIds.has(id) && !snapshotHas(snapshot, id, hash)) return "other-record-changed";
    return null;
  })();
  for (const op of pending) {
    let failure: string | null = null;
    if (!scanOk) {
      failure = !worldUnchanged
        ? "world-changed"
        : !managedUnchanged
          ? "managed-file-changed"
          : !baselineUnchanged
            ? "baseline-changed"
            : "verification-scan-not-clean";
    }
    else if (untouchedProblem) failure = untouchedProblem;
    else {
      try {
        const ctx = await buildOpContext(env, op);
        const sizeRead = await readTextAt(env.root, op.path);
        const size = sizeRead.state === "ok" ? sizeRead.size : undefined;
        for (const step of STEP_ORDER) {
          if (step === "history" && !op.expected.history) continue;
          const v = await inspectStep(env, op, ctx, step, size);
          if (v.state !== "satisfied") { failure = `verify-${step}-${v.state === "conflict" ? v.detail : "missing"}`; break; }
        }
        if (!failure) {
          const registryContradiction = await registryIndexHasContradiction(env, op.registryKey, op.path);
          if (registryContradiction) {
            failure = "verify-registry-index-contradiction";
          } else {
            for (const m of op.members) {
              const r = classificationOf(plan, m.recordType, m.id);
              const ok = r && r.classification === "equivalent-existing" && r.vaultPaths.length === 1 && r.vaultPaths[0] === op.path && r.semanticEqual === true &&
                r.indexedDBExists && r.registry.entryExists === true && r.registry.path === op.path && r.registry.status === "ok" &&
                r.legacyIndexPath === op.path && r.syncState.matchesLocal === true && (op.recordType === "source" || r.historyIndexExists === true) &&
                (op.recordType !== "memory" || (r.memoryDay?.memberExists === true && r.memoryDay.memberSemanticEqual === true));
              if (!ok) { failure = "verify-plan-not-equivalent"; break; }
            }
          }
        }
      } catch (e) {
        failure = e instanceof RecoveryStepError ? `verify-${e.message}` : "verify-error";
      }
    }
    op.status = failure ? "failed" : "verified";
    op.failure = failure;
  }
}

/**
 * Codexレビュー指摘H2-2（registry-index verification不足）対応：`.tsumugi/registry-index.json`に、
 * この記録と矛盾するpathが記載されていないかを確認する。このファイルはfull resyncだけが作り直す
 * 軽量キャッシュであり、Recovery・通常書き込みのどちらも更新しないため、内容が現在のRegistry世代
 * （`builtAtGeneration`）と一致しない（＝古い・作り直され待ちの）場合は権威的でないとみなし、
 * 矛盾チェックの対象にしない（stale indexの記載を誤って矛盾扱いしない）。世代が一致するのに
 * 異なるpathが記載されている場合だけ、真の矛盾として扱う（recoveredにしない）。
 */
async function registryIndexHasContradiction(env: RecoveryApplyEnv, registryKey: string, expectedPath: string): Promise<boolean> {
  const read = await readJsonAt(env.root, ".tsumugi/registry-index.json");
  if (read.state !== "ok") return false;
  const builtAt = read.value.builtAtGeneration;
  if (typeof builtAt !== "string") return false;
  // Codexレビュー再指摘H2-2（世代比較の実形式が違っていた）対応：`registry-index.json`の
  // `builtAtGeneration`は、IndexedDBの数値epoch（`registryGenerationEpoch`、world変更検知専用の
  // 別のカウンタ）とは無関係で、実際には`.tsumugi/registry-meta.json`の`registryGeneration`
  // （`crypto.randomUUID()`等で生成されるtoken文字列。`resyncVaultRegistry`が両方へ同じ値を書く）と
  // 一致するかどうかで「今のRegistry世代のものか」を判定する（推測ではなく、実際の生成箇所
  // ＝`vault.ts`の`generateVaultRegistryGeneration()`／`meta.registryGeneration = newGeneration`／
  // `index.builtAtGeneration = newGeneration`を追跡して確認済み）。registry-meta.json自体が読めない・
  // `registryGeneration`が未確立の場合は、比較のしようがないため権威的とはみなさない。
  const metaRead = await readJsonAt(env.root, ".tsumugi/registry-meta.json");
  if (metaRead.state !== "ok") return false;
  const currentGeneration = metaRead.value.registryGeneration;
  if (typeof currentGeneration !== "string" || builtAt !== currentGeneration) return false;
  const records = read.value.records;
  if (!isObj(records)) return false;
  const entry = records[registryKey];
  if (!isObj(entry) || typeof entry.path !== "string") return false;
  return entry.path !== expectedPath;
}

/**
 * `managedBefore`（journal確定時に記録した、registry-index.json／registry-meta.json等の管理ファイルの
 * hash）が、今も同じかを確認する。「registry-index.json一致」を文字どおり確認するための、
 * world不変確認とは独立したもう一段の防御（Recovery自身はこれらのファイルを一切書かないため、
 * 通常は常に一致するはず）。読めない場合は安全側に倒し「一致しない」扱いにする。
 */
async function managedFilesUnchanged(env: RecoveryApplyEnv, managedBefore: Record<string, string | null>): Promise<boolean> {
  for (const [path, beforeHash] of Object.entries(managedBefore)) {
    const read = await readTextAt(env.root, path);
    const afterHash = read.state === "ok" ? hashVaultText(read.text) : read.state === "absent" ? null : "unreadable";
    if (afterHash !== beforeHash) return false;
  }
  return true;
}

function snapshotHas(snapshot: RecoveryLocalSnapshot, id: string, hash: string): boolean {
  const all: LocalRecord[] = [...snapshot.conversations, ...snapshot.memories, ...snapshot.sources];
  const found = all.find((x) => x.id === id);
  return !!found && hashRecord(found) === hash;
}

/** すべてのMarkdown（隠し・退避フォルダを含む）の「path→大きさ＋更新時刻」。Recovery対象外が変わっていないことの確認用。 */
async function snapshotMarkdown(root: FileSystemDirectoryHandle): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> => {
    if (depth > 64) return;
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, path, depth + 1);
      else if (name.toLowerCase().endsWith(".md")) {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.set(path, `${file.size}:${file.lastModified}`);
      }
    }
  };
  await walk(root, "", 0);
  return out;
}

async function runOps(env: RecoveryApplyEnv, journal: RecoveryJournal, snapshotAtStart: RecoveryLocalSnapshot, resumed: boolean): Promise<RecoveryApplyResult> {
  const before = {
    records: new Map<string, string>([...snapshotAtStart.conversations, ...snapshotAtStart.memories, ...snapshotAtStart.sources].map((r) => [r.id, hashRecord(r)])),
    markdown: await snapshotMarkdown(env.root),
  };
  for (const op of journal.ops) {
    if (op.status !== "pending") continue;
    if (env.isStale?.() || env.signal?.aborted) return summarize(journal, "interrupted", resumed, "stale");
    if (!sameWorld(await env.readWorld(), journal.world)) return summarize(journal, "world-changed", resumed);
    try {
      const ctx = await buildOpContext(env, op);
      let size: number | undefined;
      for (const step of STEP_ORDER) {
        if (step === "history" && !op.expected.history) continue;
        // B1対応：共有metadataを触るstep（index/history/registry）は、進捗flagだけを信用せず、
        // 実ファイルと`metadataBackups`を突き合わせてから進める（前回の試行がこのstepの途中で
        // 終わっていた可能性があるため）。
        if (step === "index" || step === "history" || step === "registry") {
          const verdict = await reconcileMetadataStep(env, op, step);
          if (verdict === "blocked") {
            journal.unresolvedMetadata = true;
            await persist(env, journal);
            return summarize(journal, "interrupted", resumed, "metadata-corrupt-unresolved");
          }
        }
        let v = await inspectStep(env, op, ctx, step, size);
        if (v.state === "conflict") throw new RecoveryStepError(`${step}-${v.detail}`);
        if (v.state === "needed") {
          if (op.kind === "repair" && step === "markdown") throw new RecoveryStepError("repair-never-writes-markdown");
          await execStep(env, journal, op, ctx, step);
          v = await inspectStep(env, op, ctx, step, size);
          if (v.state !== "satisfied") throw new RecoveryStepError(`${step}-not-confirmed-after-write`);
        }
        if (step === "markdown") {
          const read = await readTextAt(env.root, op.path);
          size = read.state === "ok" ? read.size : undefined;
        }
        op.steps[step] = op.steps[step] === "not-needed" ? "not-needed" : "done";
        await persist(env, journal);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "RecoveryJournalUnavailableError") return summarize(journal, "interrupted", resumed, "journal-unavailable");
      if (e instanceof RecoveryUnresolvedMetadataError) {
        // B1対応：破損した共有metadataを復元できなかった。journalはcompletedにせず、通常write gateを
        // 効かせたまま終える（次回の再試行、または開発者の手動対応を待つ）。
        journal.unresolvedMetadata = true;
        try { await persist(env, journal); } catch { /* 保存できなくても、completedにしないという安全側の
          結果は変わらない */ }
        return summarize(journal, "interrupted", resumed, "metadata-corrupt-unresolved");
      }
      op.status = "failed";
      op.failure = e instanceof RecoveryStepError ? e.message : "step-error";
      try { await persist(env, journal); } catch { return summarize(journal, "interrupted", resumed, "journal-unavailable"); }
    }
  }
  await verifyOps(env, journal, before);
  const recovered = countMembers(journal.ops.filter((op) => op.status === "verified"));
  const failed = countMembers(journal.ops.filter((op) => op.status === "failed"));
  journal.result = { recovered, held: journal.held.length, failed };
  journal.status = "completed";
  try {
    await persist(env, journal);
  } catch {
    // 実体の確認は済んでいる。journalだけ最後の保存に失敗した場合は、次回の再確認で完了扱いにできる。
    return summarize(journal, "interrupted", resumed, "journal-unavailable");
  }
  return { status: "completed", recovered, held: journal.held.length, failed, resumed };
}

function summarize(journal: RecoveryJournal, status: RecoveryApplyStatus, resumed: boolean, reason?: string): RecoveryApplyResult {
  return {
    status,
    recovered: countMembers(journal.ops.filter((op) => op.status === "verified")),
    held: journal.held.length,
    failed: countMembers(journal.ops.filter((op) => op.status === "failed")),
    resumed,
    ...(reason ? { reason } : {}),
  };
}

export type RecoveryJournalState =
  | { kind: "none" }
  | { kind: "interrupted"; operationId: string; pendingCount: number }
  | { kind: "completed"; recovered: number; held: number; failed: number }
  | { kind: "unreadable" };

/** UI用：journalの状態を読むだけ（何も変更しない）。別worldの未完了journalは、もう関係ないものとして"none"扱い。 */
export async function readRecoveryState(env: Pick<RecoveryApplyEnv, "store" | "readWorld">): Promise<RecoveryJournalState> {
  const read = await readRecoveryJournal(env.store);
  if (read.kind === "none") return { kind: "none" };
  if (read.kind === "unreadable") return { kind: "unreadable" };
  const j = read.journal;
  if (j.status === "completed") return { kind: "completed", ...(j.result ?? EMPTY_RESULT) };
  if (j.status === "abandoned") return { kind: "none" };
  let world: RecoveryJournalWorld;
  try {
    world = await env.readWorld();
  } catch {
    return { kind: "interrupted", operationId: j.operationId, pendingCount: countMembers(j.ops.filter((op) => op.status === "pending")) };
  }
  if (!sameWorld(world, j.world)) return { kind: "none" };
  return { kind: "interrupted", operationId: j.operationId, pendingCount: countMembers(j.ops.filter((op) => op.status === "pending")) };
}

/**
 * 復旧の実行（新規／中断からの再開の両方）。呼び出し元が`runVaultWorldExclusive`を保持している前提。
 * - 実行の直前に必ずPlanを作り直す（UIで見せた数字ではなく、最新の状態を優先する）。
 * - 未完了journalが今のworldに有れば、その内容（意図）を最新の実体で再確認して続きから完了する。
 * - journalを保存・読み戻せなければ、何も書かない。
 */
/**
 * M1対応：`confirmed`はDry Run（`planRecoveryApply`の結果をそのままユーザーに見せた画面）が返した
 * confirmed set。省略した場合はconfirmed setによる絞り込みを行わない（下位互換・単体テスト用）。
 * 渡された場合、新規に始めるApplyは「Dry Run時にユーザーが見た記録」だけを対象にする——Dry Run後に
 * 新しく安全になった記録を勝手に追加しない。worldが変わっていれば（別Vault切替・Registry世代変化等）、
 * confirmed set自体が古いため何も書かず`confirmation-expired`を返す（UIは再確認を要求する）。
 * 既存の中断journalの再開（resume）には適用しない——それは既に確認済みの操作の続きであり、
 * 新しい確認は不要。
 *
 * Codexレビュー再指摘M1（resumeとnew applyの暗黙フォールバック）対応：`resumeOnly`（UIの
 * 「再確認して続ける」＝中断からの再開だけを意図する呼び出しから、明示的に`true`を渡す）。
 * `true`の場合、今のworldと一致する未完了journalが無ければ（別worldの古いjournalしか無い、または
 * journal自体が既に消えている場合も含めて）、`confirmed`の有無に関わらず新規Applyへは絶対に
 * フォールバックせず`confirmation-expired`を返す。省略時（false）は、journalが無ければ通常どおり
 * 新規Apply（`confirmed`があればその集合に絞り込む、無ければ絞り込まない）として進める——
 * こちらは「Dry Runの確認を経た新規Apply」呼び出し、および`confirmed`を使わない既存の呼び出し
 * （テスト・下位互換）の両方が使う経路であり、意図が「再開」に限定されないため。
 */
export async function applyRecovery(env: RecoveryApplyEnv, confirmed?: RecoveryConfirmedSet, resumeOnly = false): Promise<RecoveryApplyResult> {
  let world: RecoveryJournalWorld;
  let existing: Awaited<ReturnType<typeof readRecoveryJournal>>;
  try {
    world = await env.readWorld();
    existing = await readRecoveryJournal(env.store);
  } catch {
    return { status: "unavailable", ...EMPTY_RESULT, resumed: false, reason: "world-or-journal-unreadable" };
  }

  // Codexレビュー再指摘M1（resumeとnew applyの暗黙フォールバック）対応：「今のworldと一致する未完了
  // journalがあるか」「別worldの古いjournalが残っているか」「journal自体が無いか」の3状態を明示的に
  // 区別する。以前は、対応する未完了journalが今のworldと一致しない場合、`confirmed`（Dry Runでの確認）の
  // 有無に関わらず一律「journalを破棄して新規Applyへ進む」経路へ落ちており、「再開」のつもりの呼び出し
  // （UIの「再確認して続ける」＝`confirmed`を渡さない呼び出し）でも、ユーザーが一度も確認していない
  // 新worldの安全な記録全部を、確認なしで自動的にApplyしてしまっていた（Codexが実際に再現）。
  //
  // 修正後の方針：
  // - 今のworldと一致する未完了journalがあれば、`confirmed`の有無に関わらず必ずそれを再開する
  //   （同じworldの続きである以上、暗黙フォールバックの問題は生じない）。
  // - 別worldの古い未完了journalしか無い（または journal自体が無い）状態で`confirmed`を渡さない
  //   （＝「再開」のつもりの）呼び出しは、新規Applyへは絶対にフォールバックせず、
  //   `confirmation-expired`で止める（journalには一切触れない）。
  // - 別worldの古いjournalを明示的に破棄して新規Applyへ進んでよいのは、呼び出し元が新しく確認した
  //   `confirmed`（Dry Runをやり直した結果）を持っている場合だけ。
  const hasMatchingJournal = existing.kind === "journal" && existing.journal.status === "in-progress" && sameWorld(world, existing.journal.world);
  const hasStaleJournal = existing.kind === "journal" && existing.journal.status === "in-progress" && !sameWorld(world, existing.journal.world);

  const resume = async (journal: RecoveryJournal): Promise<RecoveryApplyResult> => {
    let resumePlan: RecoveryApplyPlan;
    try {
      resumePlan = await planRecoveryApply(env, null);
    } catch {
      return { status: "unavailable", ...EMPTY_RESULT, resumed: false, reason: "plan-unavailable" };
    }
    // journalが持つ各opを、最新のPlan上の分類で再確認する。安全に進められないopは失敗にする（何も書かない）。
    // ただし、既にmetadataBackupsが記録されている（＝前回このopのstepへ着手し、共有metadataがまだ
    // 途中の状態のまま残っている可能性がある）opはこの対象から外す——そのopの共有metadataが破損して
    // いること自体が、buildVaultRecoveryPlanの全体issues（`.tsumugi/*`が読めない）を引き起こし、
    // 無関係のはずのこのrecordまで"unreadable / indeterminate"に誤分類されてしまうため（この誤分類だけで
    // opを"failed"にすると、journalが誤ってcompletedになり、B1の「解決できない破損は通常write gateを
    // 効かせたまま終える」という保証を回避してしまう）。これらのopは、代わりに`runOps`自身の
    // `reconcileMetadataStep`（実ファイルを直接確認する、より正確な判定）に判断を委ねる。
    for (const op of journal.ops) {
      if (op.status !== "pending" || op.metadataBackups.length > 0) continue;
      for (const m of op.members) {
        const r = classificationOf(resumePlan.plan, m.recordType, m.id);
        const okClass = op.kind === "repair" ? ["equivalent-existing"] : ["local-only-safe", "equivalent-existing"];
        const okPath = !r || r.classification !== "equivalent-existing" || (r.vaultPaths.length === 1 && r.vaultPaths[0] === op.path);
        if (!r || !okClass.includes(r.classification) || !okPath) { op.status = "failed"; op.failure = "resume-not-safe"; break; }
      }
    }
    return runOps(env, journal, resumePlan.snapshot, true);
  };

  if (hasMatchingJournal && existing.kind === "journal") {
    // 今のworldと一致する未完了journalがある：`confirmed`の有無に関わらず、必ずそれを再開する
    // （同じworldの続きである以上、暗黙フォールバックの問題は生じない）。
    return resume(existing.journal);
  }

  if (resumeOnly) {
    // 「再開」だけを意図する呼び出し。一致するjournalが無い（別worldの古いjournalしか無い、または
    // journal自体が既に消えている）場合、`confirmed`の有無に関わらず新規Applyへは絶対に
    // フォールバックしない（journalにも一切触れない）。
    return {
      status: "confirmation-expired",
      ...EMPTY_RESULT,
      resumed: false,
      reason: hasStaleJournal ? "world-changed-since-confirmation" : "no-pending-journal",
    };
  }

  if (hasStaleJournal) {
    // 別worldの古い未完了journalが残っている。これを破棄して新規Applyへ進んでよいのは、
    // 呼び出し元が新しく確認した`confirmed`（Dry Runをやり直した結果）を持っている場合だけ。
    // `confirmed`が無い（＝「再開」のつもりの呼び出し）場合は、新規Applyへは絶対にフォールバックせず、
    // journalにも一切触れずに止める。
    if (!confirmed) {
      return { status: "confirmation-expired", ...EMPTY_RESULT, resumed: false, reason: "world-changed-since-confirmation" };
    }
    if (!sameWorld(world, confirmed.world)) {
      return { status: "confirmation-expired", ...EMPTY_RESULT, resumed: false, reason: "world-changed-since-confirmation" };
    }
    if (existing.kind === "journal") {
      existing.journal.status = "abandoned";
      try { await persist(env, existing.journal); } catch { return { status: "journal-unavailable", ...EMPTY_RESULT, resumed: false }; }
    }
  } else if (confirmed && !sameWorld(world, confirmed.world)) {
    // journal自体が無い状態でも、`confirmed`が渡された以上はそのworldとの一致を確認する
    // （Dry Run後にworldが変わっていれば、確認済み内容はもう有効ではない）。
    return { status: "confirmation-expired", ...EMPTY_RESULT, resumed: false, reason: "world-changed-since-confirmation" };
  }

  // ---- 新規Apply ----
  // `confirmed`が無い呼び出し（journal自体が無い状態でのテスト・下位互換用途）は、従来どおり
  // confirmed setによる絞り込みなしで進める。`confirmed`があれば、その集合だけに絞り込む。
  let plan: RecoveryApplyPlan;
  try {
    plan = await planRecoveryApply(env, confirmed ? new Set(confirmed.recordIds) : null);
  } catch {
    return { status: "unavailable", ...EMPTY_RESULT, resumed: false, reason: "plan-unavailable" };
  }
  if (plan.ops.length === 0) return { status: "nothing-to-do", recovered: 0, held: plan.heldCount, failed: 0, resumed: false };

  const journal = await newJournal(env, plan, world);
  try {
    await saveRecoveryJournal(env.store, journal);
  } catch {
    return { status: "journal-unavailable", ...EMPTY_RESULT, held: plan.heldCount, resumed: false };
  }
  return runOps(env, journal, plan.snapshot, false);
}
