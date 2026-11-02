/**
 * Vault Outbox（新保存基盤 Phase 3-1）。
 *
 * canonical record（Conversation / MemoryObject / Source。将来のPerson / Topic /
 * Current State / Create等も含む）が更新されるたびに、「このrecordをVaultへ
 * projectionする」というtaskを、canonical writeと**同一のIndexedDB transaction**で
 * 永続化する（実際のtransaction処理は db.ts の `putConversationWithOutbox` 等を参照）。
 *
 * Invariant 1（同一transaction）・Invariant 2（canonical更新にoutboxが必ず伴う）は
 * db.ts側の責務。このファイルは純粋なデータ構造と、そのデータ構造だけで完結する
 * 決定的なロジック（IDの組み立て・新entryの導出）だけを持つ（IndexedDBに触れない）。
 *
 * 重要（Invariant 3）：`steps`の値（"done"等）はあくまで進捗のヒントであり、Vault実体
 * そのものの真実ではない。Safari/PWAはVault write成功後・outbox更新前に停止しうるし、
 * 将来の破損でoutbox上は"done"なのにVault実体が欠落することもありうる。Projection
 * Engine（Phase 3-3）は、実行のたびに必ずVault実体を検証し、この値だけを信用して
 * 「書かなくてよい」と判断してはならない。
 *
 * このファイルはPhase 3-1時点ではまだどの保存経路からも呼ばれない（基盤のみ）。
 */

export type ProjectionStepName = "markdown" | "registry" | "history" | "index" | "ledger";
export type ProjectionStepState = "pending" | "done" | "not-needed";
export type VaultOutboxStatus = "pending" | "done" | "held";

export const PROJECTION_STEP_NAMES: readonly ProjectionStepName[] = ["markdown", "registry", "history", "index", "ledger"];

/**
 * 「conversation-turn-durable」のようなVault projection不要の特殊recordTypeは作らない
 * （ユーザー指示の必須事項1）。ここに列挙するのはcanonical record側の種別であり、
 * 将来Person/Topic/Current State/Create等を追加する際は、この型を拡張するだけでよい
 * （保存エンジン本体・Projection Engineには手を入れない。recordAdapter.ts参照）。
 */
export type CanonicalRecordType = "conversation" | "memory" | "reflection" | "source" | (string & {});

export interface VaultOutboxAttempt {
  count: number;
  lastError: string | null;
  lastAttemptAt: string | null;
}

export interface VaultOutboxEntry {
  /** `${recordType}:${recordId}`。1 canonical recordにつき常に高々1件（upsert）。 */
  id: string;
  recordType: CanonicalRecordType;
  recordId: string;
  /**
   * このentryがどのcanonical `updatedAt`に対応するprojection taskか。
   * canonicalが新しいupdatedAtへ進むたびに、既存entryの有無・進捗に関わらず、
   * 必ず全stepを`pending`へ戻した新entryを作る（`buildOutboxEntryForUpdate`参照）。
   * これにより「canonical更新＝必ずprojection対象」という不変条件を保つ
   * （Assistant応答後の再projectionもこの仕組みだけで成立する）。
   */
  recordUpdatedAt: string;
  steps: Record<ProjectionStepName, ProjectionStepState>;
  attempt: VaultOutboxAttempt;
  status: VaultOutboxStatus;
  /** 本当のconflict等でheldになった理由。status!=="held"のときはnull。 */
  heldReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function vaultOutboxIdFor(recordType: string, recordId: string): string {
  return `${recordType}:${recordId}`;
}

function initialProjectionSteps(): Record<ProjectionStepName, ProjectionStepState> {
  const steps = {} as Record<ProjectionStepName, ProjectionStepState>;
  for (const name of PROJECTION_STEP_NAMES) steps[name] = "pending";
  return steps;
}

/**
 * canonical recordの新しい`updatedAt`に対応するoutbox entryを、既存entry（あれば）から
 * 導出する。
 *
 * - 既存entryが無い、または`recordUpdatedAt`が既存entryと異なる：
 *   必ず新しいpending entry（全step pending、status:"pending"）を返す。既存entryが
 *   "done"や"held"であっても、canonicalが新しいversionへ進んだ以上は無条件で
 *   再projection対象にする（このファイル冒頭のInvariant説明を参照）。
 * - 既存entryがあり、`recordUpdatedAt`が同一：
 *   同じversionへの重複書き込み（例：同一内容の再put）。既存の進捗（steps/status/
 *   attempt）をそのまま維持し、むやみに再projectionを増やさない。
 */
export function buildOutboxEntryForUpdate(
  existing: VaultOutboxEntry | undefined,
  recordType: string,
  recordId: string,
  recordUpdatedAt: string,
  now: string
): VaultOutboxEntry {
  if (existing && existing.recordUpdatedAt === recordUpdatedAt) {
    return { ...existing, updatedAt: now };
  }
  return {
    id: vaultOutboxIdFor(recordType, recordId),
    recordType,
    recordId,
    recordUpdatedAt,
    steps: initialProjectionSteps(),
    attempt: { count: 0, lastError: null, lastAttemptAt: null },
    status: "pending",
    heldReason: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
