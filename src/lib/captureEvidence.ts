import { validStatedAt } from "./markdown";

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

/**
 * Temporal Phase 1B：Memory.statedAt（ユーザーがその情報を述べた時刻）を、**検証済みの** evidence index から決める。
 * `userTurns`は`userMessages`と同じfilter順のuser turn配列（indexはuser発言だけの0始まり）。`indexes`は
 * `validateMemoryEvidenceIndexes`を通ったものだけを渡すこと。
 *
 * - 単一evidence：そのturnのtimestampをそのまま返す（丸め・書き換えをしない）。
 * - 複数evidence：有効なtimestampの**最新の時刻**（indexの順序ではなく、時刻そのものを比較する）。結合した命題は、最後の根拠が
 *   述べられたときに初めて述べ終えられるため。
 * - fail-closed：根拠のturnが1件でも、timestampが欠損・空・不正（Phase 1Aと同じ`validStatedAt`の条件を満たさない）なら、
 *   undefined。有効なものだけを拾って最新にしない（無効な方が最新だった可能性を排除できないため）。
 * - Capture時刻・conversation.startedAt・Memory.date・eventTime等へは一切fallbackしない。
 */
export function resolveStatedAtFromEvidence(userTurns: readonly { timestamp?: unknown }[], indexes: readonly number[]): string | undefined {
  if (indexes.length === 0) return undefined;
  let latest: string | undefined;
  let latestMs = -Infinity;
  for (const index of indexes) {
    const turn = Number.isSafeInteger(index) ? userTurns[index] : undefined;
    const stamp = turn ? validStatedAt(turn.timestamp) : undefined;
    if (stamp === undefined) return undefined; // missing turn / missing / invalid timestamp: fail closed
    const ms = Date.parse(stamp);
    if (ms > latestMs) { latestMs = ms; latest = stamp; }
  }
  return latest;
}

/**
 * Temporal Phase 1B（client側の防御）：serverが返したstatedAtを、validなUTC ISOで、かつ会話中の**実際のuser turnの
 * timestampのいずれかと一致する**場合だけ採用する。再計算はしない。それ以外はundefined。
 */
export function trustedStatedAt(value: unknown, turns: readonly { role: string; timestamp?: unknown }[]): string | undefined {
  const valid = validStatedAt(value);
  if (valid === undefined) return undefined;
  return turns.some((turn) => turn.role === "user" && turn.timestamp === valid) ? valid : undefined;
}
