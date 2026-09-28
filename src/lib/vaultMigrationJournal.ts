/**
 * Migration Journal（新保存基盤 Phase 3-1）。
 *
 * record schema version間のmigrationの進捗を、canonical dataとは独立に永続化するための
 * 型。Phase 3-1では型とDB CRUD（db.ts）のみ実装する。実際のmigration runner
 * （idempotent・restartable・unknown-field-preserving。Invariant 8/9参照）は
 * Phase 3-6で設計・実装する。
 */

export type MigrationEntryStatus = "pending" | "done";

export interface MigrationJournalEntry {
  /** `${recordType}:${recordId}:${toVersion}`。同じ変換を二重登録しない（冪等キー）。 */
  id: string;
  recordType: string;
  recordId: string;
  fromVersion: string;
  toVersion: string;
  status: MigrationEntryStatus;
  createdAt: string;
  updatedAt: string;
}

export function migrationJournalIdFor(recordType: string, recordId: string, toVersion: string): string {
  return `${recordType}:${recordId}:${toVersion}`;
}
