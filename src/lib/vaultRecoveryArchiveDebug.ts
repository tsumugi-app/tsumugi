/** Bounded, in-memory diagnostics. No persistence, console output, or network sends.
 * IDs/paths are exported only by the explicit Debug UI copy action.
 */
export interface RecoveryArchiveDiagnostic {
  at: string;
  stage: string;
  recordType?: string;
  recordId?: string;
  classification?: string;
  archivePath?: string;
  filesystemOperation?: string;
  identityStatus?: "canonical-missing" | "unconfirmed" | "matched" | "mismatch";
  /** Correlation fingerprints, not the raw identity-file contents. */
  expectedWorldIdentity?: string;
  actualWorldIdentity?: string;
  reason?: string;
  errorName?: string;
  errorMessage?: string;
}
const entries: RecoveryArchiveDiagnostic[] = [];
const reasons = new Set([
  "canonical-identity-missing", "vault-identity-missing", "vault-identity-read-error",
  "vault-identity-parse-error", "world-identity-matched", "world-identity-mismatch",
  "archive-write-or-verify-failed", "archive-id-collision", "temp-verify-failed",
  "final-verify-failed", "path-unconfirmed", "archive-precondition-failed: path-unconfirmed",
  "unconfirmed-retain-all", "archived", "repaired", "read-only-complete",
]);
const errorNames = new Set([
  "Error", "TypeError", "SyntaxError", "RangeError", "NotFoundError", "NotAllowedError",
  "SecurityError", "AbortError", "InvalidStateError", "NoModificationAllowedError",
  "QuotaExceededError", "UnknownError", "NotReadableError", "DataCloneError",
  "VaultWriterUnavailableError", "VaultWriteVerificationError", "StaleVaultTabError",
  "IncompleteVaultWorldError",
]);
/** Diagnostic correlation only; never used to establish Vault identity or authorize writes. */
function fingerprint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `id-fingerprint:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
export function logRecoveryArchiveDiagnostic(detail: Omit<RecoveryArchiveDiagnostic, "at">, error?: unknown): void {
  try {
    const errorName = error === undefined ? undefined
      : error instanceof Error && errorNames.has(error.name) ? error.name : "UnknownError";
    // Never copy error.message: even a TypeError/provider error can embed a body,
    // credential or filename. Reasons use our own closed vocabulary instead.
    const errorMessage = errorName === undefined ? undefined : errorName === "SyntaxError"
      ? "JSON parse failed (source omitted)" : `${errorName}: details omitted to protect stored content`;
    entries.push({
      at: new Date().toISOString(), stage: detail.stage,
      recordType: detail.recordType, recordId: detail.recordId,
      classification: detail.classification, archivePath: detail.archivePath,
      filesystemOperation: detail.filesystemOperation, identityStatus: detail.identityStatus,
      expectedWorldIdentity: fingerprint(detail.expectedWorldIdentity),
      actualWorldIdentity: fingerprint(detail.actualWorldIdentity),
      reason: detail.reason === undefined ? undefined : reasons.has(detail.reason) ? detail.reason : "unrecognized-reason",
      errorName, errorMessage,
    });
    if (entries.length > 300) entries.splice(0, entries.length - 300);
  } catch { /* Observability must not change storage outcomes. */ }
}
export function getRecoveryArchiveDiagnostics(): RecoveryArchiveDiagnostic[] {
  return entries.map(entry => ({ ...entry }));
}
export function clearRecoveryArchiveDiagnostics(): void { entries.length = 0; }
