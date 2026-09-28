/**
 * Production Bootstrap / Legacy Migration（新保存基盤 Phase 3-5）。
 *
 * 目的：既存ProductionユーザーのIndexedDB canonical・Vault Markdown・Registry・
 * History・sync ledger・legacy Recovery対象・no-baseline状態を、新しい
 * canonical + outbox + Projection Engineへ安全に引き継ぐ。
 *
 * 基本原則（req 2）：IndexedDBだけ／Vaultだけを信用しない。導入時だけは両側を
 * record ID単位でinventoryし、突き合わせる。
 *
 * 対象はConversationのみ（Phase 3-3/3-4と同じ範囲。Memory day-fileはPhase 3-6以降）。
 *
 * このファイルはまだどの本番経路（app startup等）からも呼ばれない
 * （Phase 3-5はlibrary＋testまで）。
 */
import { getAllConversations, putConversationWithOutbox, readProductionMigrationStateRaw, writeProductionMigrationStateRaw } from "./db";
import { collectAllMarkdownFiles, fileNameFor, type VaultFileEntry } from "./vault";
import { conversationToMarkdown, parseConversationMarkdown } from "./markdown";
import { isLegitimatePredecessor } from "./vaultProjection";
import type { Conversation } from "./types";

// ---------------------------------------------------------------------------
// 実体の読み込み（vaultProjection.ts／vaultIdentityAdoption.tsと同じ考え方：
// ok/absent/errorを区別する）。
// ---------------------------------------------------------------------------

type TextRead = { state: "ok"; text: string } | { state: "absent" } | { state: "error" };

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function readTextAt(root: FileSystemDirectoryHandle, path: string): Promise<TextRead> {
  const segments = path.split("/");
  try {
    let dir = root;
    for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
    const fileHandle = await dir.getFileHandle(segments[segments.length - 1], { create: false });
    const file = await fileHandle.getFile();
    return { state: "ok", text: await file.text() };
  } catch (error) {
    return isNotFoundError(error) ? { state: "absent" } : { state: "error" };
  }
}

// ---------------------------------------------------------------------------
// req 3：record分類
// ---------------------------------------------------------------------------

export type ConversationClassificationKind =
  | "idb-only" // A
  | "both-same" // C
  | "legitimate-successor" // D
  | "conflict" // E
  | "unreadable"; // F
// B（vault-only）はcanonical record単位ではないため別枠（`VaultOnlyEntry`）。
// G（derived-metadata-only inconsistency）はC/Dの帰結として扱う（下記コメント参照）。

export interface ConversationClassification {
  kind: ConversationClassificationKind;
  recordId: string;
  reason?: string;
}

/**
 * req 6：「正当な後継version」の判定はPhase 3-3の`isLegitimatePredecessor`をそのまま
 * 再利用する（同じ意味論の判定をここで二重実装しない）。
 *
 * req 9：Markdown/canonicalが一致（both-same）していて、Registry/History/index/
 * legacy ledger/baselineだけが欠けている状態（G）は、ここでは独立した分類にしない——
 * C（both-same）／D（legitimate-successor）のどちらも、そのままoutbox pendingを
 * 生成する（下の`runProductionBootstrapMigration`参照）。「MarkdownはcanonicalとOKだが
 * derived metadataだけ欠けている」場合に具体的に何を直すかはProjection Engine
 * （Phase 3-3）の責務であり、migration側で先回りして判定・分岐する必要が無い
 * （Projection Engineは実行のたびに必ず実体を検証するため、baseline等の判断材料に
 * 頼らず安全に収束できる。Phase 3-3のtest群で既に確認済み）。
 */
async function classifyConversation(root: FileSystemDirectoryHandle, canonical: Conversation): Promise<ConversationClassification> {
  const path = `Conversations/${fileNameFor(canonical.id, canonical.startedAt)}`;
  const read = await readTextAt(root, path);
  if (read.state === "error") return { kind: "unreadable", recordId: canonical.id, reason: "markdown-unreadable" };
  if (read.state === "absent") return { kind: "idb-only", recordId: canonical.id };
  if (read.text === conversationToMarkdown(canonical)) return { kind: "both-same", recordId: canonical.id };
  const parsed = parseConversationMarkdown(read.text);
  if (!parsed) return { kind: "unreadable", recordId: canonical.id, reason: "markdown-unreadable" };
  if (isLegitimatePredecessor(parsed, canonical)) return { kind: "legitimate-successor", recordId: canonical.id };
  return { kind: "conflict", recordId: canonical.id, reason: "content-conflict" };
}

/**
 * req 7：Vault-only（IndexedDBに存在しないrecord）の検出。`Conversations/`配下の
 * 全Markdownを列挙し（既存の安全な`collectAllMarkdownFiles`primitiveを再利用）、
 * frontmatterのidがcanonical id集合に含まれないものをvault-onlyとする
 * （parse不能なファイルも、既知のcanonicalに対応付けられない以上vault-onlyとして扱い、
 * 保全する——安全側に倒す）。
 */
async function findVaultOnlyConversationPaths(root: FileSystemDirectoryHandle, canonicalConversations: Conversation[]): Promise<string[]> {
  const canonicalIds = new Set(canonicalConversations.map((c) => c.id));
  let files: VaultFileEntry[];
  try {
    const dir = await root.getDirectoryHandle("Conversations", { create: false });
    files = await collectAllMarkdownFiles(dir, "Conversations");
  } catch {
    return [];
  }
  const vaultOnly: string[] = [];
  for (const f of files) {
    const parsed = parseConversationMarkdown(f.content);
    if (!parsed || !canonicalIds.has(parsed.id)) vaultOnly.push(f.path);
  }
  return vaultOnly;
}

// ---------------------------------------------------------------------------
// req 10：Migration Journal（restartable/idempotent）
// ---------------------------------------------------------------------------

export type MigrationPhase = "inventory" | "classify" | "enqueue-safe-records" | "verify" | "done";

export interface ProductionMigrationSummary {
  idbOnly: number;
  vaultOnly: number;
  bothSame: number;
  legitimateSuccessor: number;
  conflict: number;
  unreadable: number;
}

export interface ProductionMigrationState {
  version: 1;
  phase: MigrationPhase;
  startedAt: string;
  updatedAt: string;
  /** このCALL内で何回rescanしたか（req 11。クラッシュ超えての再開カウントではなく、観測用）。 */
  rescanCount: number;
  summary: ProductionMigrationSummary | null;
  conflictRecordIds: string[];
  unreadableRecordIds: string[];
  vaultOnlyPaths: string[];
  outboxEnsuredCount: number;
}

function freshState(now: string): ProductionMigrationState {
  return {
    version: 1,
    phase: "inventory",
    startedAt: now,
    updatedAt: now,
    rescanCount: 0,
    summary: null,
    conflictRecordIds: [],
    unreadableRecordIds: [],
    vaultOnlyPaths: [],
    outboxEnsuredCount: 0,
  };
}

async function loadState(): Promise<ProductionMigrationState | null> {
  const raw = await readProductionMigrationStateRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProductionMigrationState;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function persistState(state: ProductionMigrationState): Promise<void> {
  await writeProductionMigrationStateRaw(JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// req 11：Snapshot問題——「migration終了時rescan」を採用する。
//
// 理由：Phase 3-5時点では通常保存経路（ChatScreen）はまだ新Projection Engineへ
// 接続されていない（req 17）。つまりmigration実行中に追加されるcanonical recordは、
// 旧保存経路（outboxを一切経由しない`putConversation`）で書かれる可能性がある——
// migration開始時のhigh-water markだけでは、「その後に追加されたが、まだ一度も
// outbox化されていないrecord」を検出する手段にならない。終了時に再度
// `getAllConversations()`を読み直し、classify時点の集合と比較して新規／更新された
// recordがあれば、それらだけを対象に再度classify→enqueueする（bounded loop、
// 既定3回）。3回を超えてなお新規が続く場合でも、migration自体を無期限に待たせない
// ——取りこぼした分は、Phase 3-2/3-3が本番接続された後の通常write pathが
// 自前でoutbox化する（Invariant 1/2により、以後のcanonical更新は必ずoutbox対象になる）。
// ---------------------------------------------------------------------------

const MAX_RESCANS = 3;

export interface ProductionMigrationEnv {
  root: FileSystemDirectoryHandle;
  now?: () => string;
}

export interface ProductionMigrationResult {
  phase: "done";
  summary: ProductionMigrationSummary;
  conflictRecordIds: string[];
  unreadableRecordIds: string[];
  vaultOnlyPaths: string[];
  outboxEnsuredCount: number;
}

function nowOf(env: ProductionMigrationEnv): string {
  return (env.now ?? (() => new Date().toISOString()))();
}

/**
 * req 12：既存outboxとの統合。`putConversationWithOutbox`（Phase 3-1）は、
 * canonicalの`updatedAt`が既存entryと同一なら進捗（pending/held/done）をそのまま
 * 維持する（`buildOutboxEntryForUpdate`）。migrationはこの既存の仕組みをそのまま
 * 呼ぶだけでよく、held entryを勝手にpendingへ戻す・duplicateを作る、といった
 * 特別なロジックを別途持たない（Invariant 1/2・buildOutboxEntryForUpdateの
 * 冪等性テストは既にPhase 3-1で確認済み）。
 */
async function ensureOutbox(c: Conversation): Promise<void> {
  await putConversationWithOutbox(c);
}

function tally(classifications: ConversationClassification[], vaultOnlyCount: number): ProductionMigrationSummary {
  const summary: ProductionMigrationSummary = { idbOnly: 0, vaultOnly: vaultOnlyCount, bothSame: 0, legitimateSuccessor: 0, conflict: 0, unreadable: 0 };
  for (const c of classifications) {
    if (c.kind === "idb-only") summary.idbOnly += 1;
    else if (c.kind === "both-same") summary.bothSame += 1;
    else if (c.kind === "legitimate-successor") summary.legitimateSuccessor += 1;
    else if (c.kind === "conflict") summary.conflict += 1;
    else if (c.kind === "unreadable") summary.unreadable += 1;
  }
  return summary;
}

/**
 * 公開API（req 1・14）。Conversationのみを対象に、inventory→classify→
 * enqueue-safe-records→verify（req 11のrescan）→doneまでを1回の呼び出しで行う。
 *
 * req 8：1件のconflictが他のsafe recordのmigrationを止めない——分類は record単位で
 * 独立しており、conflict/unreadableと判定されたrecordはoutboxへ触れず
 * `conflictRecordIds`/`unreadableRecordIds`として結果に残るだけで、他recordの
 * enqueueには一切影響しない。
 *
 * req 10：2回目以降の呼び出しも、常にinventoryから素朴にやり直す（restartable）。
 * 冪等性は`putConversationWithOutbox`自身の同一version検出（Phase 3-1）に委ねる
 * ため、2回実行してもduplicate outbox／duplicate canonical／duplicate Vault file
 * は作らない（Vault fileは今回のmigration自体が一切書かない——outboxへの登録のみ）。
 */
export async function runProductionBootstrapMigration(env: ProductionMigrationEnv): Promise<ProductionMigrationResult> {
  let state = (await loadState()) ?? freshState(nowOf(env));
  state = { ...state, phase: "inventory", updatedAt: nowOf(env), rescanCount: 0 };
  await persistState(state);

  let knownConversations = await getAllConversations();
  let classifications: ConversationClassification[] = [];
  let vaultOnlyPaths: string[] = [];

  for (let pass = 0; pass <= MAX_RESCANS; pass++) {
    state = { ...state, phase: "classify", updatedAt: nowOf(env) };
    await persistState(state);

    classifications = await Promise.all(knownConversations.map((c) => classifyConversation(env.root, c)));
    vaultOnlyPaths = await findVaultOnlyConversationPaths(env.root, knownConversations);

    state = { ...state, phase: "enqueue-safe-records", updatedAt: nowOf(env) };
    await persistState(state);

    let ensuredThisPass = 0;
    for (const classification of classifications) {
      if (classification.kind === "idb-only" || classification.kind === "both-same" || classification.kind === "legitimate-successor") {
        const canonical = knownConversations.find((c) => c.id === classification.recordId);
        if (!canonical) continue; // 理論上到達しない（防御的）
        await ensureOutbox(canonical);
        ensuredThisPass += 1;
      }
    }

    const summary = tally(classifications, vaultOnlyPaths.length);
    state = {
      ...state,
      phase: "verify",
      updatedAt: nowOf(env),
      rescanCount: pass,
      summary,
      conflictRecordIds: classifications.filter((c) => c.kind === "conflict").map((c) => c.recordId),
      unreadableRecordIds: classifications.filter((c) => c.kind === "unreadable").map((c) => c.recordId),
      vaultOnlyPaths,
      outboxEnsuredCount: state.outboxEnsuredCount + ensuredThisPass,
    };
    await persistState(state);

    // req 11：verify＝終了時rescan。classify対象にした集合と、今読み直した最新集合を
    // 比較し、新規／`updatedAt`が進んだrecordがあれば、それらを含めて再度classifyする。
    const latestConversations = await getAllConversations();
    const priorById = new Map(knownConversations.map((c) => [c.id, c]));
    const hasNewOrChanged = latestConversations.some((c) => {
      const prior = priorById.get(c.id);
      return !prior || prior.updatedAt !== c.updatedAt;
    });
    if (!hasNewOrChanged) break;
    knownConversations = latestConversations;
  }

  state = { ...state, phase: "done", updatedAt: nowOf(env) };
  await persistState(state);

  return {
    phase: "done",
    summary: state.summary!,
    conflictRecordIds: state.conflictRecordIds,
    unreadableRecordIds: state.unreadableRecordIds,
    vaultOnlyPaths: state.vaultOnlyPaths,
    outboxEnsuredCount: state.outboxEnsuredCount,
  };
}

/** テスト・診断用：現在の永続状態をそのまま読む（無ければnull）。 */
export async function readProductionMigrationState(): Promise<ProductionMigrationState | null> {
  return loadState();
}
