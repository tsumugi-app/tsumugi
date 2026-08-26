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
import { saveSource } from "./db";
import { writeSourceMarkdown } from "./vault";
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
 * STORAGE.md §2.3「書き込みは常にMarkdown/.tsumugiが先、IndexedDBが後」をSourceにも適用する。
 * persistCapture()と同じく、vaultHandleがまだ無い場合はIndexedDBにのみ保存し、
 * Vault接続後にflushPendingToVaultで書き戻す（vault.ts参照）。
 *
 * Beta修正：Markdown書き込みとIndexedDB書き込みを独立したtry/catchに分離し、片方の失敗が
 * もう片方を道連れにしないようにする（persistCapture()と同じ方針）。Markdown書き込み失敗は
 * 次回flushPendingToVaultで自然に書き戻される＝失われてはいないため、ここでは呼び出し元へ
 * 伝えない。IndexedDB書き込み失敗だけをindexedDbFailedとして呼び出し元へ返す。
 */
export async function persistSource(
  vaultHandle: FileSystemDirectoryHandle | null,
  source: Source
): Promise<PersistSourceResult> {
  if (vaultHandle) {
    try {
      await writeSourceMarkdown(vaultHandle, source);
    } catch (error) {
      console.error(
        `[Tsumugi Source] source markdown write failed for ${source.id} (will retry on next vault flush):`,
        error
      );
    }
  }

  try {
    await saveSource(source);
  } catch (error) {
    console.error(`[Tsumugi Source] source IndexedDB write failed for ${source.id}:`, error);
    return { indexedDbFailed: true };
  }
  return { indexedDbFailed: false };
}
