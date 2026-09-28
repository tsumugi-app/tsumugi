/**
 * Record Adapter基盤（新保存基盤 Phase 3-1）。
 *
 * 新しいrecord type（将来のPerson / Topic / Current State / Create等）を追加する際、
 * 保存エンジン本体（Projection Engine・reconcileループ・migration runner）に
 * `if (recordType === "...")`を増やさずに済むようにするための拡張ポイント。
 * 1つの`RecordAdapter`を実装して`registerRecordAdapter`するだけで、将来のPhase
 * （Projection Engine・Migration Engine）がその情報を使えるようにする。
 *
 * Phase 3-1では、既存4種類（conversation / reflection / source / memory）の
 * adapter登録までを実装する。`toMarkdown`/`parseMarkdown`等の実際の呼び出しは
 * まだどこからも行われない（Phase 3-3でProjection Engineが配線する）。
 *
 * memory（normal Memoryのday-file）だけは1 record = 1 fileではなく複数memberが
 * 1つのday-fileへ結合されるため、`toMarkdown`/`parseMarkdown`/`registryKeyOf`
 * （すべて1 record単位を前提とする）を持たせない。day-file特有のprojection
 * （既存memberを消さない安全なmerge）はPhase 3-5で別途設計・実装する
 * （Phase 2設計書 9章参照）。
 */
import {
  conversationToMarkdown,
  parseConversationMarkdown,
  memoryObjectToMarkdown,
  parseMemoryObjectMarkdown,
  sourceToMarkdown,
  parseSourceMarkdown,
} from "./markdown";
import type { Conversation, MemoryObject, Source } from "./types";

export interface RecordAdapter<T> {
  recordType: string;
  /** このadapterが対象とするrecordの現行schema version（record schema version。DB versionともVault Markdown format versionとも独立、Phase 2設計書12章）。 */
  schemaVersion: string;
  /**
   * 未知versionのrecordを現行schemaへ変換する。Phase 3-1時点ではmigration対象の
   * 旧versionが存在しないため恒等変換のみ（Phase 3-6でmigration runnerと共に拡張）。
   * 実装時は既知でないfieldを保持すること（Invariant 9）。
   */
  migrate: (raw: unknown, fromVersion: string) => T;
  /** Registry上のkey（1 record = 1 fileのrecord type専用）。 */
  registryKeyOf?: (record: T) => string;
  toMarkdown?: (record: T) => string;
  parseMarkdown?: (text: string) => T | null;
}

const registry = new Map<string, RecordAdapter<unknown>>();

export function registerRecordAdapter<T>(adapter: RecordAdapter<T>): void {
  registry.set(adapter.recordType, adapter as RecordAdapter<unknown>);
}

export function getRecordAdapter(recordType: string): RecordAdapter<unknown> | undefined {
  return registry.get(recordType);
}

export function listRegisteredRecordTypes(): string[] {
  return [...registry.keys()];
}

/** テスト専用：registryを空に戻す（各テストの独立性を保つため）。本番コードからは呼ばない。 */
export function __resetRecordAdapterRegistryForTests(): void {
  registry.clear();
  registerBuiltinRecordAdapters();
}

const conversationAdapter: RecordAdapter<Conversation> = {
  recordType: "conversation",
  schemaVersion: "1",
  migrate: (raw) => raw as Conversation,
  registryKeyOf: (record) => record.id,
  toMarkdown: conversationToMarkdown,
  parseMarkdown: parseConversationMarkdown,
};

const reflectionAdapter: RecordAdapter<MemoryObject> = {
  recordType: "reflection",
  schemaVersion: "1",
  migrate: (raw) => raw as MemoryObject,
  registryKeyOf: (record) => record.id,
  toMarkdown: memoryObjectToMarkdown,
  parseMarkdown: parseMemoryObjectMarkdown,
};

const sourceAdapter: RecordAdapter<Source> = {
  recordType: "source",
  schemaVersion: "1",
  migrate: (raw) => raw as Source,
  registryKeyOf: (record) => record.id,
  toMarkdown: sourceToMarkdown,
  parseMarkdown: (text) => {
    try {
      return parseSourceMarkdown(text);
    } catch {
      return null;
    }
  },
};

/** day-file特有のため`toMarkdown`/`parseMarkdown`/`registryKeyOf`は持たせない（このファイル冒頭の説明参照）。 */
const memoryAdapter: RecordAdapter<MemoryObject> = {
  recordType: "memory",
  schemaVersion: "1",
  migrate: (raw) => raw as MemoryObject,
};

function registerBuiltinRecordAdapters(): void {
  registerRecordAdapter(conversationAdapter);
  registerRecordAdapter(reflectionAdapter);
  registerRecordAdapter(sourceAdapter);
  registerRecordAdapter(memoryAdapter);
}

registerBuiltinRecordAdapters();
