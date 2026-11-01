/**
 * 保存先の整合性確認（READ ONLY）。既存のRecovery plan（`planRecoveryApply`。走査も分類もそのまま）に、保存の進行状況
 * （Outboxとsync ledger）を重ねて、記録ごとに「保存中・保存待ち」と「真正の不整合」を分け、不整合を種類と理由で分類する。
 * 何も書かない（marker の記録は呼び出し元：recoveryBackgroundCheck.ts）。特定の件数・日付・ファイル名・既知の不具合には依存しない。
 *
 * 保存処理との競合（ロックを取らない理由）：
 *   canonical（IndexedDB）の更新は必ず同じtransactionでOutbox entryを書き（db.ts Invariant 1）、保存先への反映が終わると
 *   Outbox（status/steps）かsync ledgerが変わる。そこで走査の「前」と「後」に保存の進行状況を読み、
 *   - 前後で1件でも変わっていれば、その走査は保存処理と重なった（settled=false）。結果を確定した異常として扱わない。
 *   - 前後で変わっていなくても、Outboxが`pending`の記録は保存待ち（異常ではない）。
 *   保存ロック（`withVaultSaveLock`）を走査の間ずっと持つと、その間すべての保存が止まるため取らない（Web Locksの順序
 *   world→save にも触れない。world lockは呼び出し元が共有モードで持つ＝従来どおり）。IndexedDBはタブ間で共有のため、
 *   別タブの保存もこの前後比較で検出できる。
 */

/** 保存の進行状況（Outboxとsync ledger）。読み取りのみ（db.ts `readVaultSaveProgress`）。 */
export interface SaveProgressEntry {
  id: string;
  status: string;
  recordUpdatedAt: string;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}
export interface SaveProgress {
  outbox: SaveProgressEntry[];
  ledger: Record<string, string>;
}

/** 分類に必要なRecovery planの形（`RecoveryApplyPlan`の部分集合）。 */
export interface ConsistencyPlanLike {
  plan: {
    scanCompleted: boolean;
    issues: readonly { path: string; status: string; error?: string }[];
    records: readonly {
      recordType: string;
      recordId: string;
      classification: string;
      reasons: readonly string[];
      syncState: { savedUpdatedAt: string | null; matchesLocal: boolean | null };
    }[];
  };
  ops: readonly { kind: string; members: readonly { id: string }[] }[];
  held: readonly { recordType: string; recordId: string; reason: string }[];
}

/**
 * 分類（ユーザーに見せる区別）。
 *   saving      保存中・保存待ち。異常ではない（通常の保存が自動で反映する）
 *   repairable  今のバージョンで安全に自動修復できる（既存の復旧＝`applyRecovery`が扱う、保存先に無い記録・管理情報の更新）
 *   repairLater 自動修復の対象だが、今のバージョンでは未対応（データは変更せず保持）
 *   needsChoice 端末と保存先に異なる版がある等、どちらを残すかの確認が必要（選択機能は未対応。両方の版を変更せず保持）
 *   retryable   時間をおいて確認し直せば解決しうる（一時的な読取失敗・保存の再試行中・確認中の変化）
 *   unknown     原因を特定できない（データは変更せず保持）
 */
export type ConsistencyCategory = "saving" | "repairable" | "repairLater" | "needsChoice" | "retryable" | "unknown";
export const CONSISTENCY_CATEGORIES: readonly ConsistencyCategory[] = ["saving", "repairable", "repairLater", "needsChoice", "retryable", "unknown"];

export type ConsistencyReason =
  | "save-pending" | "save-retrying" | "read-error" | "read-during-save" | "record-changed"
  | "local-only" | "metadata"
  | "day-file-merge" | "registry-mismatch" | "save-held"
  | "different-content" | "multiple-copies"
  | "unreadable-file" | "trace-without-file" | "invalid-local" | "other";

export type ConsistencyRecordType = "conversation" | "memory" | "reflection" | "source" | "file";

export interface ConsistencyFinding {
  category: ConsistencyCategory;
  reason: ConsistencyReason;
  recordType: ConsistencyRecordType;
  /** 記録のID（ファイルの問題では無い）。画面には出さない（件数・種類・理由だけを出す）。 */
  recordId?: string;
}

export type ConsistencyState =
  /** 確定した走査で、保存待ちも不整合も無い */
  | "clean"
  /** 確定した走査で、保存待ちだけがある（成功とは扱わない） */
  | "saving"
  /** 確定した走査で、保存待ち以外の不整合がある */
  | "attention"
  /** 走査が保存処理と重なり、結果を確定できなかった（異常として記録しない） */
  | "unsettled";

export interface ConsistencyGroup {
  category: ConsistencyCategory;
  reason: ConsistencyReason;
  recordType: ConsistencyRecordType;
  count: number;
}

export interface ConsistencyReport {
  state: ConsistencyState;
  settled: boolean;
  findings: ConsistencyFinding[];
  counts: Record<ConsistencyCategory, number>;
  /** 種類 × 理由 × 記録の種類ごとの件数（画面の表示用。IDも本文も含まない）。 */
  groups: ConsistencyGroup[];
  /** 今のバージョンで自動修復できる（保存待ちではない）記録のID。「修復する」はこの集合だけを対象にする。 */
  repairableIds: string[];
}

/** これ以上の失敗が続くOutbox entryは「保存待ち」ではなく「保存の再試行中」（再試行で解決しうるが、成功していない）。 */
export const STALLED_SAVE_ATTEMPTS = 3;

/** 記録の種類ごとの全レコード問題ではない（走査全体の問題を写しただけの）理由。ファイルの問題として別に数える。 */
const GLOBAL_REASONS = new Set(["vault-scan-incomplete", "strict-read-or-parse-failure"]);

const entryKey = (e: SaveProgressEntry) => JSON.stringify([e.id, e.status, e.recordUpdatedAt, e.attempts, e.updatedAt]);

/** 保存の進行状況の指紋。前後で一致しなければ、その間に保存処理が動いた。 */
export function saveProgressFingerprint(p: SaveProgress): string {
  const outbox = p.outbox.map(entryKey).sort();
  const ledger = Object.entries(p.ledger).map(([k, v]) => `${k}=${v}`).sort();
  return JSON.stringify([outbox, ledger]);
}

export const hasPendingSaves = (p: SaveProgress): boolean =>
  p.outbox.some((e) => e.status === "pending" && !(e.attempts >= STALLED_SAVE_ATTEMPTS && e.lastError));

type SaveState = "settled" | "saving" | "retrying" | "held";

function outboxIdsFor(recordType: string, recordId: string): string[] {
  return recordType === "memory" || recordType === "reflection" ? [`memory:${recordId}`, `reflection:${recordId}`] : [`${recordType}:${recordId}`];
}

function saveStateOf(
  record: ConsistencyPlanLike["plan"]["records"][number] | undefined,
  recordType: string, recordId: string,
  before: Map<string, SaveProgressEntry>, after: Map<string, SaveProgressEntry>,
  ledgerBefore: Record<string, string>, ledgerAfter: Record<string, string>,
): SaveState {
  const ids = outboxIdsFor(recordType, recordId);
  const b = ids.map((id) => before.get(id)).filter((e): e is SaveProgressEntry => !!e);
  const a = ids.map((id) => after.get(id)).filter((e): e is SaveProgressEntry => !!e);
  if (JSON.stringify(b.map(entryKey)) !== JSON.stringify(a.map(entryKey))) return "saving";
  const ledgerKey = `${recordType === "reflection" ? "memory" : recordType}:${recordId}`;
  if (ledgerBefore[ledgerKey] !== ledgerAfter[ledgerKey]) return "saving";
  const pending = a.filter((e) => e.status === "pending");
  if (pending.some((e) => !(e.attempts >= STALLED_SAVE_ATTEMPTS && e.lastError))) return "saving";
  if (pending.length) return "retrying";
  if (a.some((e) => e.status === "held")) return "held";
  // Outbox以前の保存経路（sync ledgerだけ）：一度保存できた記録の、まだ反映されていない新しい版
  if (!a.length && record && record.syncState.savedUpdatedAt !== null && record.syncState.matchesLocal === false) return "saving";
  return "settled";
}

const asRecordType = (t: string): ConsistencyRecordType =>
  t === "conversation" || t === "memory" || t === "reflection" || t === "source" ? t : "memory";

/** Recovery planと、その走査の前後の保存の進行状況から、整合性の結果を作る（純粋関数。何も書かない）。 */
export function classifyConsistency(plan: ConsistencyPlanLike, before: SaveProgress, after: SaveProgress): ConsistencyReport {
  const settled = saveProgressFingerprint(before) === saveProgressFingerprint(after);
  const byId = (p: SaveProgress) => new Map(p.outbox.map((e) => [e.id, e]));
  const ob = byId(before), oa = byId(after);
  const records = new Map(plan.plan.records.map((r) => [`${r.recordType === "reflection" ? "memory" : r.recordType}:${r.recordId}`, r]));
  const recordOf = (type: string, id: string) => records.get(`${type === "reflection" ? "memory" : type}:${id}`);
  const recordById = new Map(plan.plan.records.map((r) => [r.recordId, r]));
  const findings: ConsistencyFinding[] = [];
  const seen = new Set<string>();
  /** 1つの記録は1回だけ数える（ファイルの問題は1件ずつ）。 */
  const add = (f: ConsistencyFinding) => {
    if (f.recordId !== undefined) {
      const key = `${f.recordType === "reflection" ? "memory" : f.recordType}:${f.recordId}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    findings.push(f);
  };
  const stateOf = (type: string, id: string) => saveStateOf(recordOf(type, id), type, id, ob, oa, before.ledger, after.ledger);
  /** 保存の状態が「保存中」等なら、その分類を優先する（保存待ちの記録を不整合と数えない）。 */
  const bySave = (s: SaveState, type: ConsistencyRecordType, id: string): ConsistencyFinding | null =>
    s === "saving" ? { category: "saving", reason: "save-pending", recordType: type, recordId: id }
      : s === "retrying" ? { category: "retryable", reason: "save-retrying", recordType: type, recordId: id }
        : s === "held" ? { category: "repairLater", reason: "save-held", recordType: type, recordId: id }
          : null;

  // 既存の復旧（applyRecovery）で直せる記録：保存先に無い記録の書き出し、管理情報の更新
  for (const op of plan.ops) {
    for (const m of op.members) {
      const r = recordById.get(m.id);
      const type = asRecordType(r?.recordType ?? "memory");
      add(bySave(stateOf(type, m.id), type, m.id) ?? { category: "repairable", reason: op.kind === "repair" ? "metadata" : "local-only", recordType: type, recordId: m.id });
    }
  }

  for (const h of plan.held) {
    // 走査全体の問題（読めないファイル等）で保留になっただけの記録は、ファイルの問題として下で数える
    if (h.reason === "scan-incomplete" || h.reason === "not-confirmed") continue;
    const type = asRecordType(h.recordType);
    const r = recordOf(h.recordType, h.recordId);
    const own = (r?.reasons ?? []).filter((x) => !GLOBAL_REASONS.has(x));
    if (h.reason === "unreadable-or-indeterminate" && own.length === 0) continue;
    const save = bySave(stateOf(type, h.recordId), type, h.recordId);
    if (save) { add(save); continue; }
    const base = { recordType: type, recordId: h.recordId };
    if (h.reason === "record-unavailable") add({ ...base, category: "retryable", reason: "record-changed" });
    else if (h.reason === "conflict") add({ ...base, category: "needsChoice", reason: "different-content" });
    else if (h.reason === "memory-dayfile-merge-required") add({ ...base, category: "repairLater", reason: "day-file-merge" });
    else if (own.includes("duplicate-or-cross-type-id") || own.includes("multiple-memory-files-for-day")) add({ ...base, category: "needsChoice", reason: "multiple-copies" });
    else if (own.includes("orphan-registry-key") || own.includes("registry-identity-mismatch")) add({ ...base, category: "repairLater", reason: "registry-mismatch" });
    else if (own.includes("metadata-trace-without-confirmed-markdown")) add({ ...base, category: "unknown", reason: "trace-without-file" });
    else if (own.includes("invalid-local-record")) add({ ...base, category: "unknown", reason: "invalid-local" });
    else add({ ...base, category: "unknown", reason: "other" });
  }

  // 走査では差分として見えなかったが、まだ保存待ち・再試行中の記録も隠さない（保存待ちが続く間は「成功」にしない）
  for (const e of after.outbox) {
    if (e.status !== "pending") continue;
    const sep = e.id.indexOf(":");
    const type = asRecordType(sep > 0 ? e.id.slice(0, sep) : "memory"), id = sep > 0 ? e.id.slice(sep + 1) : e.id;
    add(e.attempts >= STALLED_SAVE_ATTEMPTS && e.lastError
      ? { category: "retryable", reason: "save-retrying", recordType: type, recordId: id }
      : { category: "saving", reason: "save-pending", recordType: type, recordId: id });
  }

  // ファイル単位の問題（読取・解析）。保存中だった可能性があるうちは「原因未特定」と断定しない
  const savingSeen = !settled || findings.some((f) => f.category === "saving") || hasPendingSaves(before) || hasPendingSaves(after);
  for (const issue of plan.plan.issues) {
    findings.push(issue.status === "read-error"
      ? { category: "retryable", reason: "read-error", recordType: "file" }
      : savingSeen ? { category: "retryable", reason: "read-during-save", recordType: "file" } : { category: "unknown", reason: "unreadable-file", recordType: "file" });
  }
  if (!plan.plan.scanCompleted && plan.plan.issues.length === 0) findings.push({ category: "retryable", reason: "read-error", recordType: "file" });

  const counts = Object.fromEntries(CONSISTENCY_CATEGORIES.map((c) => [c, 0])) as Record<ConsistencyCategory, number>;
  const groupMap = new Map<string, ConsistencyGroup>();
  for (const f of findings) {
    counts[f.category]++;
    const key = `${f.category}|${f.reason}|${f.recordType}`;
    const g = groupMap.get(key);
    if (g) g.count++; else groupMap.set(key, { category: f.category, reason: f.reason, recordType: f.recordType, count: 1 });
  }
  const groups = [...groupMap.values()].sort((x, y) =>
    CONSISTENCY_CATEGORIES.indexOf(x.category) - CONSISTENCY_CATEGORIES.indexOf(y.category) || x.reason.localeCompare(y.reason) || x.recordType.localeCompare(y.recordType));
  const nonSaving = findings.length - counts.saving;
  const state: ConsistencyState = !settled ? "unsettled" : nonSaving > 0 ? "attention" : counts.saving > 0 ? "saving" : "clean";
  const repairableIds = findings.filter((f) => f.category === "repairable" && f.recordId !== undefined).map((f) => f.recordId as string);
  return { state, settled, findings, counts, groups, repairableIds };
}

export interface ConsistencyCheckDeps<P extends ConsistencyPlanLike> {
  readProgress(): Promise<SaveProgress>;
  /** 既存のRecovery plan（READ ONLY・全走査）。呼び出し元がworld lock（共有）の中で作る。 */
  plan(): Promise<P>;
  sleep(ms: number): Promise<void>;
  isCancelled(): boolean;
}
export interface ConsistencyCheckOptions {
  /** 走査の前に、保存待ちが空くのを待つ上限（無期限には待たない）。 */
  drainWaitMs?: number;
  pollMs?: number;
  /** 保存処理と重なった走査をやり直す回数（有限）。 */
  attempts?: number;
  retryDelayMs?: number;
}
export class ConsistencyCheckCancelledError extends Error {
  constructor() { super("consistency-check-cancelled"); this.name = "ConsistencyCheckCancelledError"; }
}

/**
 * 整合性確認の本体。待つ・やり直すはすべて有限回で、必ず終わる。何も書かない。
 *  1. 保存待ち（Outboxのpending）が空くのを、上限時間まで待つ（空かなくても進む。保存待ちとして表示される）
 *  2. 前後の保存の進行状況を読んで走査する。保存処理と重なっていれば、少し待って有限回やり直す
 */
export async function runConsistencyCheck<P extends ConsistencyPlanLike>(deps: ConsistencyCheckDeps<P>, options: ConsistencyCheckOptions = {}): Promise<{ report: ConsistencyReport; plan: P }> {
  const drainWaitMs = options.drainWaitMs ?? 20_000, pollMs = options.pollMs ?? 1_000;
  const attempts = Math.max(1, options.attempts ?? 3), retryDelayMs = options.retryDelayMs ?? 3_000;
  for (let waited = 0; waited < drainWaitMs; waited += pollMs) {
    if (deps.isCancelled()) throw new ConsistencyCheckCancelledError();
    if (!hasPendingSaves(await deps.readProgress())) break;
    await deps.sleep(pollMs);
  }
  let last: { report: ConsistencyReport; plan: P } | null = null;
  for (let i = 0; i < attempts; i++) {
    if (deps.isCancelled()) throw new ConsistencyCheckCancelledError();
    const before = await deps.readProgress();
    const plan = await deps.plan();
    const after = await deps.readProgress();
    last = { report: classifyConsistency(plan, before, after), plan };
    if (last.report.settled) return last;
    if (i + 1 < attempts) await deps.sleep(retryDelayMs);
  }
  return last!;
}
