/**
 * Vault → IndexedDB の「追加専用」復元。
 *
 * Vault内のMarkdownを正本として、IndexedDBに存在しないConversation／MemoryObject／Sourceだけを
 * 追加する。IndexedDBに既に存在するidのrecordには一切触れない（上書き・更新・削除をしない）。
 *
 * - 走査は既存の`scanVaultForRestore`を使う（フォルダ名を問わず入れ子のConversations／Memories／
 *   Sourcesを見つけ、旧1record1file形式とday-fileの両方を読み、同じidは`updatedAt`が新しい方、
 *   同じなら（Memoryは）day-file、を採用する）。
 * - 書き込みは`add*IfAbsentAndMarkSynced`（`add()`のみ。既存キーがあれば何もしない。record本体と
 *   vaultSyncStateを1 transactionで書く）だけを使う。`put`・`restoreScanToIndexedDB`の
 *   無条件上書きは使わない。
 * - Vaultには一切書き込まない（Markdown・Registry・memberHashes・History Index・baseline・
 *   vaultSyncState以外の同期状態は変更しない）。
 * - 復元したMemoryはConnect完了済みとして記録する。復元Memoryはconnect状態を持たないため、
 *   そのままでは起動のたびに未Connectとして扱われ、Connect（LLM呼び出し）の対象になり続けてしまう。
 *   Markdownに保存済みの`links`は復元されるため、新たに生成し直す必要は無い。
 * - `revisitPrompt`はMarkdownに無いため復元されない（未生成のまま。トップの問いかけは従来の
 *   仕組みで、必要になったときに1件ずつ生成される）。
 *
 * 実際の書き込みは、ユーザーが明示的に実行した場合のみ`restoreMissingRecordsFromVault`が行う。
 * 事前確認（dry-run）は`planVaultRestore`（読み取りのみ）。
 */
"use client";

import {
  addConversationIfAbsentAndMarkSynced,
  addMemoryObjectIfAbsentAndMarkSynced,
  addSourceIfAbsentAndMarkSynced,
  getAllConversations,
  getAllMemoryObjects,
  getAllSources,
} from "./db";
import { markMemoryConnected } from "./connectState";
import { scanVaultForRestore, vaultSyncKeyFor } from "./vault";
import type { VaultScanResult } from "./vault";
import type { Conversation, MemoryObject, Source } from "./types";

export interface VaultRestoreCounts {
  /** 追加予定（IndexedDBに存在せず、Vaultにだけあるrecord）。 */
  memoriesToAdd: number;
  conversationsToAdd: number;
  sourcesToAdd: number;
  /** Vaultにもあるが、IndexedDBに既に存在するためskipするrecord（上書きしない）。 */
  existingSkipped: { memories: number; conversations: number; sources: number };
  /** 同じidが複数ファイルにあり、1件へ絞り込んだ回数（採用されなかった側の件数）。 */
  duplicatesResolved: { memories: number; conversations: number; sources: number };
  /** 重複を解決した後の、Vault内のユニークなid数。 */
  vaultUnique: { memories: number; conversations: number; sources: number };
  /** frontmatterが読めない・Tsumugi管理外等で対象外だったファイル数。 */
  unreadableFiles: number;
}

export interface VaultRestorePlan {
  memoriesToAdd: MemoryObject[];
  conversationsToAdd: Conversation[];
  sourcesToAdd: Source[];
  counts: VaultRestoreCounts;
}

export interface ExistingRecordIds {
  memoryIds: ReadonlySet<string>;
  conversationIds: ReadonlySet<string>;
  sourceIds: ReadonlySet<string>;
}

/**
 * scan結果とIndexedDBの既存idから復元計画を作る（純粋関数）。IndexedDBに存在するidは
 * 必ず追加対象から外す。
 */
export function computeVaultRestorePlan(scan: VaultScanResult, existing: ExistingRecordIds): VaultRestorePlan {
  const memoriesToAdd = scan.memoryObjects.filter((memory) => !existing.memoryIds.has(memory.id));
  const conversationsToAdd = scan.conversations.filter((conversation) => !existing.conversationIds.has(conversation.id));
  const sourcesToAdd = scan.sources.filter((source) => !existing.sourceIds.has(source.id));
  return {
    memoriesToAdd,
    conversationsToAdd,
    sourcesToAdd,
    counts: {
      memoriesToAdd: memoriesToAdd.length,
      conversationsToAdd: conversationsToAdd.length,
      sourcesToAdd: sourcesToAdd.length,
      existingSkipped: {
        memories: scan.memoryObjects.length - memoriesToAdd.length,
        conversations: scan.conversations.length - conversationsToAdd.length,
        sources: scan.sources.length - sourcesToAdd.length,
      },
      duplicatesResolved: {
        memories: scan.duplicatesResolved.memoryObjects,
        conversations: scan.duplicatesResolved.conversations,
        sources: scan.duplicatesResolved.sources,
      },
      vaultUnique: {
        memories: scan.memoryObjects.length,
        conversations: scan.conversations.length,
        sources: scan.sources.length,
      },
      unreadableFiles: scan.skippedCount,
    },
  };
}

async function loadExistingIds(): Promise<ExistingRecordIds> {
  const [memories, conversations, sources] = await Promise.all([
    getAllMemoryObjects(),
    getAllConversations(),
    getAllSources(),
  ]);
  return {
    memoryIds: new Set(memories.map((memory) => memory.id)),
    conversationIds: new Set(conversations.map((conversation) => conversation.id)),
    sourceIds: new Set(sources.map((source) => source.id)),
  };
}

/**
 * dry-run。Vaultの走査とIndexedDBのid一覧の読み取りだけを行い、何も書き込まない。
 * 呼び出し元がMemory World lock（withVaultWorldRead）を保持している前提。
 */
export async function planVaultRestore(root: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<VaultRestorePlan> {
  const scan = await scanVaultForRestore(root, signal);
  const existing = await loadExistingIds();
  return computeVaultRestorePlan(scan, existing);
}

export interface VaultRestoreResult {
  insertedMemories: number;
  insertedConversations: number;
  insertedSources: number;
  /** 実行時点でIndexedDBに既に存在していたため何も書かなかったrecord数（dry-run後に増えた分を含む）。 */
  skippedExisting: number;
  /** 復元したMemoryのうち、Connect完了済みとして記録した件数。 */
  connectMarked: number;
  /** Vault切替等で途中中断した場合true（それまでに追加した分は有効）。 */
  interrupted: boolean;
}

/**
 * 実際の復元。ユーザーが明示的に実行した場合だけ呼ぶこと。dry-run時点の計画は使わず、実行時に
 * 改めて走査し直す（dry-runと実行の間にIndexedDBが変化していても、既存idを上書きしない）。
 * 呼び出し元がMemory World lock（withVaultWorldRead）を保持している前提。
 *
 * `isStale`（省略可）がtrueを返したら、次のrecordを書く前に中断する（Vault切替後の旧worldへ
 * 書き込まないため。呼び出し元のgeneration checkと同じ考え方）。
 */
export async function restoreMissingRecordsFromVault(
  root: FileSystemDirectoryHandle,
  isStale?: () => boolean
): Promise<{ plan: VaultRestorePlan; result: VaultRestoreResult }> {
  const plan = await planVaultRestore(root);
  const result: VaultRestoreResult = {
    insertedMemories: 0,
    insertedConversations: 0,
    insertedSources: 0,
    skippedExisting: 0,
    connectMarked: 0,
    interrupted: false,
  };

  for (const conversation of plan.conversationsToAdd) {
    if (isStale?.()) return { plan, result: { ...result, interrupted: true } };
    const inserted = await addConversationIfAbsentAndMarkSynced(conversation, vaultSyncKeyFor("conversation", conversation.id));
    if (inserted) result.insertedConversations += 1;
    else result.skippedExisting += 1;
  }

  for (const memory of plan.memoriesToAdd) {
    if (isStale?.()) return { plan, result: { ...result, interrupted: true } };
    const inserted = await addMemoryObjectIfAbsentAndMarkSynced(memory, vaultSyncKeyFor("memory", memory.id));
    if (!inserted) {
      result.skippedExisting += 1;
      continue;
    }
    result.insertedMemories += 1;
    // 今回追加できたMemoryだけをConnect完了済みにする（既存のMemoryのConnect状態には触れない）。
    await markMemoryConnected(memory.id);
    result.connectMarked += 1;
  }

  for (const source of plan.sourcesToAdd) {
    if (isStale?.()) return { plan, result: { ...result, interrupted: true } };
    const inserted = await addSourceIfAbsentAndMarkSynced(source, vaultSyncKeyFor("source", source.id));
    if (inserted) result.insertedSources += 1;
    else result.skippedExisting += 1;
  }

  return { plan, result };
}
