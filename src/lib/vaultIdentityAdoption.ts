/**
 * Vault Identity + Legacy Vault Adoption（新保存基盤 Phase 3-4）。
 *
 * 目的：既存ProductionユーザーのVaultを一切壊さずに、新しいVault Identity方式
 * （`.tsumugi/vault-identity.json` ⇔ IndexedDB `vaultIdentity`）へ安全に移行できる
 * ようにする。
 *
 * 最重要原則：`.tsumugi/vault-identity.json`が無い＝新規Vault、とは絶対に判定しない。
 * 既存Production Vaultにはidentityが無いのが正常であり、それを「legacy Vault」として
 * 安全に判定・adoptする（`classifyVault`／`evaluateLegacyVaultAdoption`）。
 *
 * このファイルはまだどの本番経路からも呼ばれない（Phase 3-4はlibrary＋testまで）。
 */
import {
  getAllConversations,
  getAllMemoryObjects,
  getAllSources,
  getVaultIdentityRecord,
  putVaultIdentityRecord,
} from "./db";
import { VAULT_IDENTITY_RECORD_ID, emptyVaultIdentityRecord, type VaultIdentityRecord } from "./vaultIdentity";
import type { Conversation, MemoryObject, Source } from "./types";
import { conversationToMarkdown, parseConversationMarkdown, parseMemoryDayFile, sourceToMarkdown, parseSourceMarkdown } from "./markdown";
import { fileNameFor, dayFileNameFor, isReflectionSummary, vaultProjectionPrimitives } from "./vault";

// ---------------------------------------------------------------------------
// 実体の読み込み（vaultProjection.tsと同じ考え方：ok/absent/errorを区別する。
// vault.tsの`readJSON`はparse失敗も「不在」として握りつぶすため、ここでは使わない）。
// ---------------------------------------------------------------------------

type TextRead = { state: "ok"; text: string } | { state: "absent" } | { state: "error" };
type JsonRead = { state: "ok"; value: Record<string, unknown> } | { state: "absent" } | { state: "error" };

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

async function readJsonAt(root: FileSystemDirectoryHandle, path: string): Promise<JsonRead> {
  const raw = await readTextAt(root, path);
  if (raw.state !== "ok") return raw;
  if (raw.text.trim() === "") return { state: "absent" };
  try {
    const value = JSON.parse(raw.text);
    if (typeof value !== "object" || value === null) return { state: "error" };
    return { state: "ok", value: value as Record<string, unknown> };
  } catch {
    return { state: "error" };
  }
}

async function directoryHasAnyEntries(root: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    const dir = await root.getDirectoryHandle(name, { create: false });
    for await (const _entry of (dir as unknown as { values(): AsyncIterable<unknown> }).values()) {
      void _entry;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const VAULT_IDENTITY_PATH = ".tsumugi/vault-identity.json";

// ---------------------------------------------------------------------------
// req 2：Vault状態の分類
// ---------------------------------------------------------------------------

export type VaultClassification =
  | { kind: "empty" } // A
  | { kind: "legacy" } // B：identityは無いが、何らかのTsumugi由来データがある
  | { kind: "identified"; vaultId: string } // C
  | { kind: "indeterminate"; reason: string }; // D

export async function classifyVault(root: FileSystemDirectoryHandle): Promise<VaultClassification> {
  const identityRead = await readJsonAt(root, VAULT_IDENTITY_PATH);
  if (identityRead.state === "error") return { kind: "indeterminate", reason: "vault-identity-unreadable" };
  if (identityRead.state === "ok") {
    const vaultId = identityRead.value.vaultId;
    if (typeof vaultId !== "string" || vaultId.length === 0) return { kind: "indeterminate", reason: "vault-identity-malformed" };
    return { kind: "identified", vaultId };
  }
  // identity不在。Registry/Historyのような「derived data」の有無ではなく、実体
  // （.tsumugiディレクトリ全般、Conversations/Memories/Sourcesの実ファイル）の
  // 有無で「legacy（既存データあり）」か「genuinely empty」かを見る。
  const hasTsumugiDir = await directoryHasAnyEntries(root, ".tsumugi");
  const hasConversations = await directoryHasAnyEntries(root, "Conversations");
  const hasMemories = await directoryHasAnyEntries(root, "Memories");
  const hasSources = await directoryHasAnyEntries(root, "Sources");
  if (hasTsumugiDir || hasConversations || hasMemories || hasSources) return { kind: "legacy" };
  return { kind: "empty" };
}

// ---------------------------------------------------------------------------
// req 3〜5：Legacy Vault Adoption——safe-to-adopt predicate
// ---------------------------------------------------------------------------

export interface CanonicalSnapshot {
  conversations: Conversation[];
  memories: MemoryObject[];
  sources: Source[];
}

export async function loadCanonicalSnapshot(): Promise<CanonicalSnapshot> {
  const [conversations, memories, sources] = await Promise.all([getAllConversations(), getAllMemoryObjects(), getAllSources()]);
  return { conversations, memories, sources };
}

export type LegacyVaultAdoptionResult =
  | { kind: "safe-to-adopt"; matchedCount: number }
  | { kind: "new-empty-vault" }
  | { kind: "conflict"; reason: string }
  | { kind: "unrelated-vault"; reason: string }
  | { kind: "unreadable"; reason: string }
  | { kind: "insufficient-evidence"; reason: string };

/** Conversation 1件の、Vault側実体との突き合わせ。「一致」「不一致（conflict）」「不明（読めない）」「Vault側に無い」を返す。 */
async function evaluateConversationEvidence(root: FileSystemDirectoryHandle, c: Conversation): Promise<"match" | "conflict" | "unreadable" | "absent"> {
  const path = `Conversations/${fileNameFor(c.id, c.startedAt)}`;
  const read = await readTextAt(root, path);
  if (read.state === "error") return "unreadable";
  if (read.state === "absent") return "absent";
  if (read.text === conversationToMarkdown(c)) return "match";
  const parsed = parseConversationMarkdown(read.text);
  if (!parsed) return "unreadable";
  // legacy Vaultの実体は、canonicalより古い（turnsが少ない）version・同一内容であれば
  // 「同じworldの証拠」として扱ってよい（このpredicate自体はここでは上書きしない。
  // adoptionはデータ同期ではないため、証拠判定は緩め＝id/persona/startedAt一致＋
  // turnsが厳密なprefixであること、で十分とする）。
  if (parsed.id === c.id && parsed.persona === c.persona && parsed.startedAt === c.startedAt) {
    const isPrefix = parsed.turns.length <= c.turns.length && parsed.turns.every((t, i) => {
      const other = c.turns[i];
      return other && other.role === t.role && other.content === t.content && other.timestamp === t.timestamp;
    });
    if (isPrefix) return "match";
  }
  return "conflict";
}

async function evaluateSourceEvidence(root: FileSystemDirectoryHandle, s: Source): Promise<"match" | "conflict" | "unreadable" | "absent"> {
  const path = `Sources/${fileNameFor(s.id, s.createdAt)}`;
  const read = await readTextAt(root, path);
  if (read.state === "error") return "unreadable";
  if (read.state === "absent") return "absent";
  if (read.text === sourceToMarkdown(s)) return "match";
  try {
    const parsed = parseSourceMarkdown(read.text);
    return parsed.id === s.id && parsed.title === s.title && parsed.content === s.content ? "match" : "conflict";
  } catch {
    return "unreadable";
  }
}

/** Reflection（1 record = 1 file）の証拠評価。normal Memory（day-file）はこの関数の対象外（下のday-file評価を使う）。 */
async function evaluateReflectionEvidence(root: FileSystemDirectoryHandle, m: MemoryObject): Promise<"match" | "conflict" | "unreadable" | "absent"> {
  const path = `Memories/${fileNameFor(m.id, m.date)}`;
  const read = await readTextAt(root, path);
  if (read.state === "error") return "unreadable";
  if (read.state === "absent") return "absent";
  return read.text.includes(m.id) && read.text.includes(m.summary) ? "match" : "conflict";
}

/** normal Memory（day-fileに複数memberが同居）の証拠評価。day-file自体が読めるか・該当memberの行が矛盾していないかだけを見る（day-file全体の同一性は要求しない——他のmemberは既知でなくてよい）。 */
async function evaluateMemoryDayEvidence(root: FileSystemDirectoryHandle, m: MemoryObject): Promise<"match" | "conflict" | "unreadable" | "absent"> {
  const path = `Memories/${dayFileNameFor(m.date)}`;
  const read = await readTextAt(root, path);
  if (read.state === "error") return "unreadable";
  if (read.state === "absent") return "absent";
  const members = parseMemoryDayFile(read.text);
  if (!members) return "unreadable";
  const found = members.find((x) => x.id === m.id);
  if (!found) return "absent"; // day-fileはあるが、このmemberの行はまだ無い（legacy partial-write。req 4-3）
  return found.summary === m.summary && found.content === m.content ? "match" : "conflict";
}

/**
 * req 5：safe-to-adopt predicate。「なんとなく同じっぽい」で判定しない——共通record
 * （IndexedDB canonicalとVault実体の両方に存在するid）のうち1件でも矛盾（conflict）が
 * あれば即座にadoption禁止。矛盾が無く、かつ一致した共通recordが1件以上あれば
 * safe-to-adopt。共通recordが一切無い状態で両側にデータがあるなら別worldの疑い
 * （unrelated-vault）、判断材料が足りない場合はinsufficient-evidenceとし、
 * 「多分同じだろう」では絶対にpairしない。
 */
export async function evaluateLegacyVaultAdoption(root: FileSystemDirectoryHandle, snapshot: CanonicalSnapshot): Promise<LegacyVaultAdoptionResult> {
  let matched = 0;
  let unreadableCount = 0;

  for (const c of snapshot.conversations) {
    const verdict = await evaluateConversationEvidence(root, c);
    if (verdict === "conflict") return { kind: "conflict", reason: `conversation-content-conflict:${c.id}` };
    if (verdict === "unreadable") unreadableCount += 1;
    if (verdict === "match") matched += 1;
  }
  for (const s of snapshot.sources) {
    const verdict = await evaluateSourceEvidence(root, s);
    if (verdict === "conflict") return { kind: "conflict", reason: `source-content-conflict:${s.id}` };
    if (verdict === "unreadable") unreadableCount += 1;
    if (verdict === "match") matched += 1;
  }
  for (const m of snapshot.memories) {
    const verdict = isReflectionSummary(m) ? await evaluateReflectionEvidence(root, m) : await evaluateMemoryDayEvidence(root, m);
    if (verdict === "conflict") return { kind: "conflict", reason: `memory-content-conflict:${m.id}` };
    if (verdict === "unreadable") unreadableCount += 1;
    if (verdict === "match") matched += 1;
  }

  if (matched > 0) return { kind: "safe-to-adopt", matchedCount: matched };

  const canonicalIsEmpty = snapshot.conversations.length === 0 && snapshot.sources.length === 0 && snapshot.memories.length === 0;
  const hasVaultData = (await directoryHasAnyEntries(root, "Conversations")) || (await directoryHasAnyEntries(root, "Memories")) || (await directoryHasAnyEntries(root, "Sources"));

  if (canonicalIsEmpty && !hasVaultData) return { kind: "new-empty-vault" };
  if (unreadableCount > 0) return { kind: "unreadable", reason: "some-vault-records-unreadable" };
  if (!canonicalIsEmpty && hasVaultData) return { kind: "unrelated-vault", reason: "no-common-record-matched" };
  return { kind: "insufficient-evidence", reason: "one-side-empty-cannot-prove-same-world" };
}

// ---------------------------------------------------------------------------
// req 6〜9：Identity確立（restartable/idempotent、candidate vaultIdのdurability）
// ---------------------------------------------------------------------------

export interface VaultIdentityEnv {
  root: FileSystemDirectoryHandle;
  now?: () => string;
  /** テスト・DI用。既定は`crypto.randomUUID()`。 */
  generateVaultId?: () => string;
}

export type VaultIdentityEnsureResult =
  | { kind: "identified"; vaultId: string }
  | { kind: "newly-paired"; vaultId: string }
  | { kind: "held"; reason: string }
  | { kind: "unrelated"; reason: string }
  | { kind: "unreadable"; reason: string };

function nowOf(env: VaultIdentityEnv): string {
  return (env.now ?? (() => new Date().toISOString()))();
}
function newVaultId(env: VaultIdentityEnv): string {
  return (env.generateVaultId ?? (() => crypto.randomUUID()))();
}

async function writeVaultIdentityFile(env: VaultIdentityEnv, vaultId: string): Promise<void> {
  const tsumugiDir = await env.root.getDirectoryHandle(".tsumugi", { create: true });
  await vaultProjectionPrimitives.writeFileInDir(tsumugiDir, "vault-identity.json", JSON.stringify({ vaultId, createdAt: nowOf(env) }, null, 2), "vault identity write");
}

async function persistIdbRecord(patch: Partial<VaultIdentityRecord>, now: string): Promise<VaultIdentityRecord> {
  const existing = (await getVaultIdentityRecord()) ?? emptyVaultIdentityRecord(now);
  const next: VaultIdentityRecord = { ...existing, ...patch, id: VAULT_IDENTITY_RECORD_ID, updatedAt: now };
  await putVaultIdentityRecord(next);
  return next;
}

/**
 * req 1・9：既にidentity fileがある（＝他device／過去のこのdeviceが確立済み）Vaultへ、
 * このIndexedDBを追いつかせる。content比較は不要——identity fileの存在自体が
 * 既にidentity確立済みの証拠であるため（そのVaultへ実際に書き込めるかは、この関数の
 * 責務ではなく、以後のProjection Engineのidentity照合が担う）。
 */
async function pairToExistingVaultId(env: VaultIdentityEnv, vaultId: string): Promise<VaultIdentityEnsureResult> {
  const now = nowOf(env);
  await persistIdbRecord({ vaultId, pendingCandidateVaultId: null, pairedAt: now }, now);
  return { kind: "newly-paired", vaultId };
}

/**
 * req 6・8：新規vaultId（candidate）の確立を、restartable/idempotentに行う。
 * 1. candidateをIndexedDBへdurable保存（Vault fileより前）。
 * 2. Vault側`.tsumugi/vault-identity.json`を書く。
 * 3. IndexedDB側を最終pairへ更新する。
 * 4. 両側を読み直してverifyする。
 */
async function establishNewIdentity(env: VaultIdentityEnv, candidateVaultId: string): Promise<VaultIdentityEnsureResult> {
  const now = nowOf(env);
  // Step 1：candidateをまずdurable保存する（Vault file書き込みより前。req 8）。
  await persistIdbRecord({ pendingCandidateVaultId: candidateVaultId }, now);
  // Step 2：Vault側へ書く（既に同じcandidateで書き込み済みなら、writeFileInDirは同じ内容を
  // 書き直すだけで安全＝idempotent）。
  await writeVaultIdentityFile(env, candidateVaultId);
  // Step 3：IndexedDB側を最終pairへ。
  await persistIdbRecord({ vaultId: candidateVaultId, pendingCandidateVaultId: null, pairedAt: now }, now);
  // Step 4：verify。
  const verifyRead = await readJsonAt(env.root, VAULT_IDENTITY_PATH);
  const idbRecord = await getVaultIdentityRecord();
  if (verifyRead.state !== "ok" || verifyRead.value.vaultId !== candidateVaultId || idbRecord?.vaultId !== candidateVaultId) {
    return { kind: "held", reason: "adoption-verify-failed" };
  }
  return { kind: "newly-paired", vaultId: candidateVaultId };
}

/**
 * 公開API（req 13）。「このIndexedDBは、今のVaultとどう向き合うべきか」を1回の呼び出しで
 * 確定させる。identity file・IndexedDB双方の現在状態（req 7のpartial identityを含む）を
 * 読んでから判断し、安全に書けると証明できた場合にのみ書き込む。
 *
 * 通常のもっとも多い経路（既に確立済みのVaultに、いつも通り接続する）では読み取りだけで
 * 完結し、何も書き込まない（`identified`）。
 */
export async function ensureVaultIdentityForCurrentWorld(env: VaultIdentityEnv): Promise<VaultIdentityEnsureResult> {
  const idbIdentity = await getVaultIdentityRecord();
  const vaultRead = await readJsonAt(env.root, VAULT_IDENTITY_PATH);

  if (vaultRead.state === "error") return { kind: "unreadable", reason: "vault-identity-file-unreadable" };

  if (vaultRead.state === "ok") {
    const onDiskVaultId = vaultRead.value.vaultId;
    if (typeof onDiskVaultId !== "string" || onDiskVaultId.length === 0) return { kind: "unreadable", reason: "vault-identity-malformed" };
    if (idbIdentity?.vaultId === onDiskVaultId) return { kind: "identified", vaultId: onDiskVaultId }; // 通常の毎回の接続（no-op）
    if (idbIdentity?.vaultId && idbIdentity.vaultId !== onDiskVaultId) return { kind: "held", reason: "identity-mismatch" }; // req M
    if (idbIdentity?.pendingCandidateVaultId && idbIdentity.pendingCandidateVaultId !== onDiskVaultId) {
      // 前回試みていたcandidateとは別のidentityが既にVault側にある＝安全側で保留。
      return { kind: "held", reason: "unexpected-existing-identity" };
    }
    // req A：Vault identityあり／IndexedDB未pair（またはpendingが同じID）→追いつく。
    return pairToExistingVaultId(env, onDiskVaultId);
  }

  // vaultRead.state === "absent"
  if (idbIdentity?.pendingCandidateVaultId) {
    // req I/J：前回のadoption試行の続き。同じcandidateで再開する。
    return establishNewIdentity(env, idbIdentity.pendingCandidateVaultId);
  }

  // req B：IndexedDBには確定済みvaultIdがあるのに、Vault側にidentity fileが無い。
  // 直前の書き込みが未完了だった可能性もあるが、「同じフォルダである」証拠が無い限り
  // 無条件に書き戻さない——content evidenceによる再評価へ委ねる（下のclassify/evaluateへ
  // フォールスルーする）。安全に同一worldと判断できた場合のみ、既知のvaultIdを
  // 優先的に再利用する（IDの無駄な変化を避ける）。
  const preferredCandidate = idbIdentity?.vaultId ?? null;

  const classification = await classifyVault(env.root);
  if (classification.kind === "indeterminate") return { kind: "unreadable", reason: classification.reason };
  if (classification.kind === "identified") {
    // classifyVaultとreadJsonAtの間でVault側が変化した等、通常起こらないはずのraceだが、
    // 安全側でheldにする。
    return { kind: "held", reason: "vault-identity-changed-during-check" };
  }

  if (classification.kind === "empty") {
    const candidate = preferredCandidate ?? newVaultId(env);
    return establishNewIdentity(env, candidate);
  }

  // classification.kind === "legacy"
  const snapshot = await loadCanonicalSnapshot();
  const evaluation = await evaluateLegacyVaultAdoption(env.root, snapshot);
  switch (evaluation.kind) {
    case "safe-to-adopt":
    case "new-empty-vault": {
      const candidate = preferredCandidate ?? newVaultId(env);
      return establishNewIdentity(env, candidate);
    }
    case "conflict":
      return { kind: "held", reason: evaluation.reason };
    case "unrelated-vault":
      return { kind: "unrelated", reason: evaluation.reason };
    case "unreadable":
      return { kind: "unreadable", reason: evaluation.reason };
    case "insufficient-evidence":
      return { kind: "held", reason: evaluation.reason };
  }
}
