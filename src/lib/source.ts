/**
 * Source基盤（Core）。SourceDraftを正式なTsumugiレコード（Source）へ変換し、
 * 既存のCapture（capture.ts）と同じ思想でVault→IndexedDBの順に永続化するだけの、
 * 極小のオーケストレーション層。
 *
 * 外部データの解析・AI・Memory生成・Conversation・Retrieval・Connectには一切関与しない。
 * Importer（Gmail/PDF/URL等、将来実装）はこのファイルの2関数を呼ぶだけでよく、
 * id/createdAt/updatedAtの生成方法やVault/IndexedDBへの書き込み順序を知る必要が無い
 * （capture.tsのcreateConversation()/persistCapture()と同じ境界の作り方）。
 */
"use client";

import { ulid } from "ulid";
import { putSourceWithOutbox } from "./db";
import { writeSourceMarkdown } from "./vault";
import { withVaultWorldRead } from "./vaultWorldLock";
import type { Source, SourceDraft } from "./types";

function nowISO(): string {
  return new Date().toISOString();
}

/** SourceDraft → Source。id/createdAt/updatedAtをここで一元的に生成する。 */
export function createSource(draft: SourceDraft): Source {
  const timestamp = nowISO();
  return {
    ...draft,
    id: ulid(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export interface PersistSourceResult {
  /** IndexedDBへの書き込みが失敗したか（Markdown書き込み失敗は含まない）。 */
  indexedDbFailed: boolean;
}

/**
 * 新保存基盤 Phase 3-9：canonical（IndexedDB）+ vaultOutboxのatomic commitを先に行い、
 * legacy Vault write（`writeSourceMarkdown`、既存経路。まだ削除しない）は後で行う
 * （Conversation Phase 3-2・Memory/Reflection Phase 3-9と同じ順序。canonicalの
 * durabilityをVault writeの成否に依存させない）。
 *
 * 旧実装は逆順（Markdown書き込みが先、IndexedDBが後——STORAGE.md §2.3の旧原則）
 * だったが、これはVault write失敗時にcanonicalそのものは失わないという保証は
 * 持っていたものの、Vault側から見ると「IndexedDBにまだ存在しないrecordのMarkdownが
 * 先に書かれる」ことがあり、新保存基盤のcanonical-first原則（IndexedDB+outboxが
 * durable source of truth、Vaultはprojection）とは前提が逆だった。ここでは
 * canonical + outboxのcommitを先に確定させ、Vault writeはあくまで
 * projection（失敗しても次回startup bootstrapが自己修復できる）として扱う。
 *
 * canonical+outbox失敗時はVaultへ進まず、indexedDbFailedとして返す。
 * Vaultだけの失敗ではcanonical/outboxを保持し、次回Bootstrapで再検証する。
 */
/**
 * Vault境界の安全性（H4対応）：共有ロック＋epoch確認で包んだ公開版。実処理は
 * `persistSourceImpl`（ロックを取得しない内部専用版）。
 */
export async function persistSource(
  vaultHandle: FileSystemDirectoryHandle | null,
  source: Source
): Promise<PersistSourceResult> {
  return withVaultWorldRead(() => persistSourceImpl(vaultHandle, source));
}

async function persistSourceImpl(
  vaultHandle: FileSystemDirectoryHandle | null,
  source: Source
): Promise<PersistSourceResult> {
  try {
    await putSourceWithOutbox(source);
  } catch (error) {
    console.error(`[Tsumugi Source] source IndexedDB write failed for ${source.id}:`, error);
    return { indexedDbFailed: true };
  }

  if (vaultHandle) {
    try {
      await writeSourceMarkdown(vaultHandle, source);
    } catch (error) {
      console.error(
        `[Tsumugi Source] source markdown write failed for ${source.id} (will retry on next vault flush / startup bootstrap):`,
        error
      );
    }
  }

  return { indexedDbFailed: false };
}
