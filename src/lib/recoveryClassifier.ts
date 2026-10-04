/**
 * Recovery Classifier（Phase 2・READ ONLY）。
 *
 * rawな（archive除外をしていない）Recovery Planのheld記録を、「何が食い違っているか」で分類する。
 * 何も書かない（Vault・IndexedDB・ledger・journalのいずれも変更しない）。identityも作らない。
 * 分類は端末名・保存先の種類に依存しない（PC / Android / iPhoneで同じ入力は同じ結果）。
 *
 *   L0  派生情報だけの差（Registry / History / index / ledger）。記録本体は両側で意味的に同じ。
 *   L1  同じ意味の別表現（updatedAtだけ・Linkの並び順だけ）。
 *   L2  片側だけが進んでいる（一方が他方を完全に含む＝prefix / superset）。
 *   L3  双方にだけある情報が互いに矛盾せず、情報を失わずに合成できる（Link等のunion）。
 *   L4  同じIDで意味が食い違う（真の競合）。recordTypeごとに数える。
 *   L5  読めない・壊れている（unreadable / malformed）。
 *
 * repairSafety：L0〜L3 = AUTO（将来の自動修復の候補。今回は何も修復しない）、L4 / L5 = HOLD。
 * L4のConversation / Sourceは将来conflict-copyの候補だが、今回はHOLDのまま。
 * updatedAtは版の目印としてだけ使い、どちらが正しいかの根拠にはしない（timestamp勝ちは作らない）。
 * 出力はID・種別・件数だけ。本文は一切含めない。
 */
import type { Conversation, ConversationTurn, Link, MemoryObject, Source } from "./types";
import type { RecoveryApplyPlan } from "./vaultRecoveryApply";
import type { RecoveryLocalSnapshot, RecoveryRecord } from "./vaultRecovery";
import { parseRecoveryMemoryMarkdown, recoveryRecordsSemanticEqual } from "./vaultRecovery";
import { parseConversationMarkdown, parseSourceMarkdown, inferSourceType } from "./markdown";

export type ClassifierLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
export type ClassifierRecordType = "conversation" | "memory" | "reflection" | "source";
export type ClassifierRepairSafety = "AUTO" | "HOLD";
export type L5Kind = "unreadable" | "malformed";

export interface ClassifiedRecord {
  recordType: string;
  recordId: string;
  level: ClassifierLevel;
  repairSafety: ClassifierRepairSafety;
  /** L5のときだけ。 */
  l5Kind?: L5Kind;
  /** L4のConversation / Sourceだけ true：将来のconflict-copy候補（今回はHOLD）。 */
  futureConflictCopyCandidate: boolean;
  /** 元のheld reason。 */
  heldReason: string;
  /** 差のあった項目名（値は含めない）。 */
  differingFields: string[];
}

export interface ClassifierSummary {
  /** rawなheld件数（archive除外なし）。 */
  rawHeldTotal: number;
  levels: {
    L0: number; L1: number; L2: number; L3: number;
    L4: { total: number; conversation: number; source: number; memory: number; reflection: number };
    L5: { total: number; unreadable: number; malformed: number };
  };
  repair: { AUTO: number; HOLD: number };
  futureConflictCopyCandidates: number;
}

export interface ClassifierReport {
  summary: ClassifierSummary;
  records: ClassifiedRecord[];
}

/** Vault上の相対pathの本文を読む。存在しない・読めないときは例外（呼び出し側でL5にする）。 */
export type ReadVaultText = (path: string) => Promise<string>;

type Obj = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** held reasonのうち、記録本体ではなく派生情報（Registry / History / index / ledger）の差。 */
const DERIVED_REASONS = new Set([
  "registry-entry-differs", "index-differs", "history-row-differs", "ledger-differs",
  "orphan-registry-key", "registry-identity-mismatch", "metadata-trace-without-confirmed-markdown",
]);
const UNREADABLE_REASONS = new Set([
  "unreadable-or-indeterminate", "scan-incomplete", "record-unavailable", "path-unresolved", "markdown-unreadable", "vault-scan-incomplete",
]);
const MALFORMED_REASONS = new Set(["dayfile-unparseable", "strict-read-or-parse-failure", "invalid-local-record"]);

interface Verdict { level: ClassifierLevel; fields: string[]; l5Kind?: L5Kind }
const v = (level: ClassifierLevel, fields: string[] = [], l5Kind?: L5Kind): Verdict => ({ level, fields, ...(l5Kind ? { l5Kind } : {}) });

/** `a`は`b`のprefix（等しい場合も含む）。 */
function isPrefix<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): boolean {
  return a.length <= b.length && a.every((x, i) => eq(x, b[i]));
}
const turnEq = (a: ConversationTurn, b: ConversationTurn) => a.role === b.role && a.content === b.content;

/** 集合として、aの全要素がbに含まれる（JSON等価で比較）。 */
function containedIn(a: unknown[], b: unknown[]): boolean {
  const keys = new Set(b.map((x) => JSON.stringify(x)));
  return a.every((x) => keys.has(JSON.stringify(x)));
}
type Containment = "equal" | "a-superset" | "b-superset" | "both-unique";
function containment(a: unknown[], b: unknown[]): Containment {
  const aInB = containedIn(a, b), bInA = containedIn(b, a);
  if (aInB && bInA) return "equal";
  if (bInA) return "a-superset";
  if (aInB) return "b-superset";
  return "both-unique";
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function compareConversation(a: Conversation, b: Conversation): Verdict {
  // 世界の取り違えを示す根本の食い違い（id・persona・開始時刻・作成時刻）はprefix関係を論じる前に真の競合。
  const rootFields = (["persona", "startedAt", "createdAt"] as const).filter((k) => a[k] !== b[k]);
  if (rootFields.length) return v("L4", rootFields);

  const fields: string[] = [];
  const turnsAPrefix = isPrefix(a.turns, b.turns, turnEq);
  const turnsBPrefix = isPrefix(b.turns, a.turns, turnEq);
  if (!turnsAPrefix && !turnsBPrefix) return v("L4", ["turns"]);
  const turnsEqual = turnsAPrefix && turnsBPrefix;
  if (!turnsEqual) fields.push("turns");

  // memoryObjectIds：順序つきのadd-only配列。prefix関係なら一方向、双方にだけある要素はunion可能。
  const idsAPrefix = isPrefix(a.memoryObjectIds, b.memoryObjectIds, (x, y) => x === y);
  const idsBPrefix = isPrefix(b.memoryObjectIds, a.memoryObjectIds, (x, y) => x === y);
  const idsEqual = idsAPrefix && idsBPrefix;
  if (!idsEqual) fields.push("memoryObjectIds");
  // 意味が単調でない項目（status・endedAt・sourceDetail等）が違うなら、どちらを残すかの判断が要る＝競合。
  const hard: string[] = [];
  if (a.status !== b.status) hard.push("status");
  if ((a.endedAt ?? null) !== (b.endedAt ?? null)) hard.push("endedAt");
  if ((a.entryType ?? null) !== (b.entryType ?? null)) hard.push("entryType");
  if ((a.title ?? null) !== (b.title ?? null)) hard.push("title");
  if (a.metadata.source !== b.metadata.source) hard.push("metadata.source");
  if (!same(a.metadata.sourceDetail ?? null, b.metadata.sourceDetail ?? null)) hard.push("metadata.sourceDetail");
  if (hard.length) return v("L4", [...fields, ...hard]);

  // 方向：+1 = bが進んでいる、-1 = aが進んでいる、0 = 同じ、null = どちらも他方のprefixでない。
  const dirT = turnsEqual ? 0 : turnsAPrefix ? 1 : -1;
  const dirI = idsEqual ? 0 : idsAPrefix ? 1 : idsBPrefix ? -1 : null;
  if (dirT === 0 && dirI === 0) {
    // 本文は同じ。残りはupdatedAt / sourceTypeの表現だけ。
    if (a.updatedAt !== b.updatedAt) fields.push("updatedAt");
    return v("L1", fields);
  }
  // memoryObjectIdsが互いに含まれない：本文が同じなら追加のみのunionで合成できる。それ以外は判断が要る。
  if (dirI === null) return v(dirT === 0 ? "L3" : "L4", fields);
  // 進んでいる側が一致（または片方だけが進んでいる）→片側のみ。反対側に進んでいる→情報を失わず合成できる。
  return v(dirT * dirI >= 0 ? "L2" : "L3", fields);
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

function compareSource(a: Source, b: Source): Verdict {
  const hard: string[] = [];
  if (a.sourceType !== b.sourceType) hard.push("sourceType");
  if (a.title !== b.title) hard.push("title");
  if (a.content !== b.content) hard.push("content");
  if ((a.attachmentId ?? null) !== (b.attachmentId ?? null)) hard.push("attachmentId");
  if (a.createdAt !== b.createdAt) hard.push("createdAt");
  const da = (a.sourceDetail ?? {}) as Record<string, string>, db = (b.sourceDetail ?? {}) as Record<string, string>;
  const shared = Object.keys(da).filter((k) => k in db);
  if (shared.some((k) => da[k] !== db[k])) hard.push("sourceDetail");
  if (hard.length) return v("L4", hard);
  const onlyA = Object.keys(da).filter((k) => !(k in db)).length, onlyB = Object.keys(db).filter((k) => !(k in da)).length;
  if (!onlyA && !onlyB) return v("L1", a.updatedAt !== b.updatedAt ? ["updatedAt"] : []);
  if (!onlyA || !onlyB) return v("L2", ["sourceDetail"]);
  return v("L3", ["sourceDetail"]);
}

// ---------------------------------------------------------------------------
// Memory / Reflection
// ---------------------------------------------------------------------------

const MEMORY_SCALARS = ["date", "content", "summary", "conversationId", "eventTime", "eventTimePrecision", "createdAt", "topicId"] as const;
const MEMORY_ARRAYS = ["types", "keywords", "profileClaims", "personMentions", "topicEvents", "evidenceQuotes"] as const;

function compareMemory(a: MemoryObject, b: MemoryObject): Verdict {
  const x = a as unknown as Obj, y = b as unknown as Obj;
  const hard: string[] = [];
  for (const k of MEMORY_SCALARS) {
    const av = k === "date" ? String(x[k]).slice(0, 10) : (x[k] ?? null);
    const bv = k === "date" ? String(y[k]).slice(0, 10) : (y[k] ?? null);
    if (!same(av, bv)) hard.push(k);
  }
  if (a.metadata.source !== b.metadata.source) hard.push("metadata.source");
  if ((a.metadata.sourceType ?? inferSourceType(a.metadata.source)) !== (b.metadata.sourceType ?? inferSourceType(b.metadata.source))) hard.push("metadata.sourceType");
  if (!same(a.metadata.sourceDetail ?? null, b.metadata.sourceDetail ?? null)) hard.push("metadata.sourceDetail");
  if (a.metadata.schemaVersion !== b.metadata.schemaVersion) hard.push("metadata.schemaVersion");
  if (!same(a.metadata.confidence ?? null, b.metadata.confidence ?? null)) hard.push("metadata.confidence");
  if (!same(a.metadata.aiProvider ?? null, b.metadata.aiProvider ?? null)) hard.push("metadata.aiProvider");

  // add-only配列（集合の包含で比較）。
  const dirs: Containment[] = [];
  const arrayFields: string[] = [];
  for (const k of MEMORY_ARRAYS) {
    const c = containment((x[k] as unknown[] | undefined) ?? [], (y[k] as unknown[] | undefined) ?? []);
    if (c !== "equal") { arrayFields.push(k); dirs.push(c); }
  }
  // Link：idで揃え、同じidで内容が違うなら競合。それ以外は集合の包含。
  const linkVerdict = compareLinks(a.links ?? [], b.links ?? []);
  if (linkVerdict.kind === "conflict") hard.push("links");
  else if (linkVerdict.kind !== "same-set") { arrayFields.push("links"); dirs.push(linkVerdict.kind); }
  if (hard.length) return v("L4", [...hard, ...arrayFields]);

  const fields = [...arrayFields];
  if (a.updatedAt !== b.updatedAt) fields.push("updatedAt");
  if (!dirs.length) return v("L1", fields);
  if (dirs.includes("both-unique") || (dirs.includes("a-superset") && dirs.includes("b-superset"))) return v("L3", fields);
  return v("L2", fields);
}

function compareLinks(a: Link[], b: Link[]): { kind: "same-set" | "conflict" | Exclude<Containment, "equal"> } {
  const byId = new Map(b.map((l) => [l.id, l]));
  for (const l of a) { const m = byId.get(l.id); if (m && !same(l, m)) return { kind: "conflict" }; }
  const c = containment(a.map((l) => l.id), b.map((l) => l.id));
  return { kind: c === "equal" ? "same-set" : c };
}

// ---------------------------------------------------------------------------
// 分類本体
// ---------------------------------------------------------------------------

function memberBlocks(raw: string): MemoryObject[] {
  const blocks = raw.split("\n<!-- tsumugi:entry -->\n\n").map((s) => s.trim()).filter(Boolean);
  const members = blocks.map(parseRecoveryMemoryMarkdown);
  if (!members.length || !members.every(Boolean)) throw new MalformedError();
  return members as MemoryObject[];
}
class MalformedError extends Error {}

function localOf(snapshot: RecoveryLocalSnapshot, type: string, id: string) {
  if (type === "conversation") return snapshot.conversations.find((c) => c.id === id);
  if (type === "source") return snapshot.sources.find((s) => s.id === id);
  return snapshot.memories.find((m) => m.id === id);
}

async function classifyOne(held: { recordType: string; recordId: string; reason: string }, rec: RecoveryRecord | undefined, snapshot: RecoveryLocalSnapshot, read: ReadVaultText): Promise<Verdict> {
  const { reason } = held;
  if (UNREADABLE_REASONS.has(reason)) return malformedOrUnreadable(rec, "unreadable");
  if (MALFORMED_REASONS.has(reason)) return v("L5", [], "malformed");
  if (!rec) return v("L5", [], "unreadable");
  if (DERIVED_REASONS.has(reason) && rec.classification === "equivalent-existing") return v("L0", [reason]);

  const type = rec.recordType;
  const local = localOf(snapshot, type === "reflection" ? "memory" : type, rec.recordId);
  if (!local) return v("L5", [], "unreadable");
  if (!rec.vaultPaths.length) return v("L5", [], "unreadable");
  let raw: string;
  try { raw = await read(rec.vaultPaths[0]); } catch { return v("L5", [], "unreadable"); }
  try {
    if (type === "conversation") {
      const parsed = parseConversationMarkdown(raw);
      if (!parsed) return v("L5", [], "malformed");
      return recoveryRecordsSemanticEqual("conversation", local as Conversation, parsed) ? v("L0", [reason]) : compareConversation(local as Conversation, parsed);
    }
    if (type === "source") {
      const parsed = parseSourceMarkdown(raw);
      return recoveryRecordsSemanticEqual("source", local as Source, parsed) ? v("L0", [reason]) : compareSource(local as Source, parsed);
    }
    const found = memberBlocks(raw).find((m) => m.id === rec.recordId);
    if (!found) {
      // 既存のday fileにこのMemoryが無い：canonical側だけにある（片側のみ）。
      return reason === "memory-dayfile-merge-required" ? v("L2", ["dayfile-member-absent"]) : v("L5", [], "malformed");
    }
    return recoveryRecordsSemanticEqual("memory", local as MemoryObject, found) ? v("L0", [reason]) : compareMemory(local as MemoryObject, found);
  } catch {
    return v("L5", [], "malformed");
  }
}

function malformedOrUnreadable(rec: RecoveryRecord | undefined, fallback: L5Kind): Verdict {
  const parseFailure = rec?.strictReadErrors.some((r) => r.status === "parse-error" || r.status === "invalid");
  return v("L5", [], parseFailure ? "malformed" : fallback);
}

/** rawなApply Planのheldを分類する（READ ONLY）。vaultの読み取りは`read`だけを通す。 */
export async function classifyRawHeld(plan: RecoveryApplyPlan, read: ReadVaultText): Promise<ClassifierReport> {
  const recordsOf = new Map<string, RecoveryRecord>();
  for (const r of plan.plan.records) recordsOf.set(`${r.recordType}:${r.recordId}`, r);
  const byId = (type: string, id: string) =>
    recordsOf.get(`${type}:${id}`) ?? (type === "memory" ? recordsOf.get(`reflection:${id}`) : type === "reflection" ? recordsOf.get(`memory:${id}`) : undefined);

  const records: ClassifiedRecord[] = [];
  for (const h of plan.held) {
    const rec = byId(h.recordType, h.recordId);
    const verdict = await classifyOne(h, rec, plan.snapshot, read);
    const type = rec?.recordType ?? h.recordType;
    const hold = verdict.level === "L4" || verdict.level === "L5";
    records.push({
      recordType: type, recordId: h.recordId, level: verdict.level, repairSafety: hold ? "HOLD" : "AUTO",
      ...(verdict.l5Kind ? { l5Kind: verdict.l5Kind } : {}),
      futureConflictCopyCandidate: verdict.level === "L4" && (type === "conversation" || type === "source"),
      heldReason: h.reason, differingFields: verdict.fields,
    });
  }
  return { summary: summarize(records), records };
}

export function summarize(records: ClassifiedRecord[]): ClassifierSummary {
  const s: ClassifierSummary = {
    rawHeldTotal: records.length,
    levels: { L0: 0, L1: 0, L2: 0, L3: 0, L4: { total: 0, conversation: 0, source: 0, memory: 0, reflection: 0 }, L5: { total: 0, unreadable: 0, malformed: 0 } },
    repair: { AUTO: 0, HOLD: 0 }, futureConflictCopyCandidates: 0,
  };
  for (const r of records) {
    s.repair[r.repairSafety] += 1;
    if (r.futureConflictCopyCandidate) s.futureConflictCopyCandidates += 1;
    if (r.level === "L4") {
      s.levels.L4.total += 1;
      const t = r.recordType as ClassifierRecordType;
      if (t in s.levels.L4) s.levels.L4[t] += 1;
    } else if (r.level === "L5") {
      s.levels.L5.total += 1;
      s.levels.L5[r.l5Kind ?? "unreadable"] += 1;
    } else s.levels[r.level] += 1;
  }
  return s;
}

/** 既存handleだけを辿る読み取り（create:false。picker・権限要求・OPFS root作成はしない）。 */
export function readVaultTextFrom(root: FileSystemDirectoryHandle): ReadVaultText {
  return async (path) => {
    const parts = path.split("/");
    if (parts.length < 2 || parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) throw new Error("invalid-path");
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: false });
    return (await (await dir.getFileHandle(parts[parts.length - 1], { create: false })).getFile()).text();
  };
}
