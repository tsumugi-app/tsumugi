export type EvidenceIndexDropReason = "missing" | "invalid-type" | "invalid-count" | "invalid-index" | "out-of-range" | "empty-message";
export interface EvidenceIndexIssue { position: number | null; value: unknown; reason: EvidenceIndexDropReason }
export type EvidenceIndexValidation =
  | { valid: true; indexes: number[]; quotes: string[]; issues: EvidenceIndexIssue[] }
  | { valid: false; reason: EvidenceIndexDropReason; issues: EvidenceIndexIssue[] };

/** Select only from the canonical User-only array. Validate EVERY element before
 * deduplication; never salvage a candidate containing an invalid reference.
 * This proves provenance, not that every claim is entailed by the selected text. */
export function validateMemoryEvidenceIndexes(userMessages: readonly string[], raw: unknown): EvidenceIndexValidation {
  if (!Array.isArray(raw)) {
    const reason = raw == null ? "missing" : "invalid-type";
    return { valid: false, reason, issues: [{ position: null, value: raw ?? null, reason }] };
  }
  if (raw.length === 0) return { valid: false, reason: "invalid-count", issues: [{ position: null, value: [], reason: "invalid-count" }] };
  const issues: EvidenceIndexIssue[] = [];
  // Indexed iteration also rejects sparse arrays rather than silently skipping holes.
  for (let position = 0; position < raw.length; position++) {
    const value: unknown = raw[position];
    let reason: EvidenceIndexDropReason | undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) reason = "invalid-index";
    else if (value < 0 || value >= userMessages.length) reason = "out-of-range";
    else if (!userMessages[value].trim()) reason = "empty-message";
    if (reason) issues.push({ position, value: value ?? null, reason });
  }
  if (issues.length) return { valid: false, reason: issues[0].reason, issues };
  const indexes = [...new Set(raw as number[])];
  return { valid: true, indexes, quotes: indexes.map(index => userMessages[index]), issues };
}
