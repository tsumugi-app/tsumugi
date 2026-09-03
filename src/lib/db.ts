/**
 * IndexedDB層。STORAGE.md §2.3の通り、役割は検索・結合の高速化のみ。
 * Markdownが正であり、ここは常に「後から書き込まれる」派生キャッシュとして扱う
 * （書き込み順序の担保は capture.ts 側の責務）。
 */
"use client";

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conversation, MemoryObject, Source } from "./types";
import type { AIProviderName } from "./ai/types";

interface TsumugiDB extends DBSchema {
  conversations: {
    key: string;
    value: Conversation;
    indexes: { "by-startedAt": string };
  };
  memoryObjects: {
    key: string;
    value: MemoryObject;
    indexes: { "by-date": string };
  };
  /**
   * Source基盤（最小構成）。MemoryObjectとは別ストアであり、Import/Attachments/検索等の
   * 実処理は今回のスコープ外（型・DB基盤のみ）。Sourceに`date`フィールドが無いため、
   * `by-date`ではなく`Timestamped.createdAt`を索引する。
   */
  sources: {
    key: string;
    value: Source;
    indexes: { "by-createdAt": string };
  };
  handles: {
    key: string;
    value: FileSystemDirectoryHandle;
  };
  /**
   * Connect処理状態（ROADMAP.md Phase 2）。id → 処理状態のみを持つ、内部管理用ストア。
   * "in-progress"は「開始前のクレーム」であり、完了時にのみ"done"へ書き換わる
   * （claimConnectStateのコメント参照）。
   */
  connectState: {
    key: string;
    value: ConnectStateRecord;
  };
  /**
   * Beta：ユーザー自身のGemini APIキー等、ブラウザにのみ保持する設定値。
   * Conversation/MemoryObjectとは完全に別ストアであり、Vault Markdownへは一切書き出さない。
   */
  settings: {
    key: string;
    value: string;
  };
}

export interface ConnectStateRecord {
  status: "in-progress" | "done";
  updatedAt: string;
}

let dbPromise: Promise<IDBPDatabase<TsumugiDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<TsumugiDB>("tsumugi", 4, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const conversations = db.createObjectStore("conversations", {
            keyPath: "id",
          });
          conversations.createIndex("by-startedAt", "startedAt");

          const memoryObjects = db.createObjectStore("memoryObjects", {
            keyPath: "id",
          });
          memoryObjects.createIndex("by-date", "date");

          db.createObjectStore("handles");
        }
        if (oldVersion < 2) {
          db.createObjectStore("connectState");
        }
        if (oldVersion < 3) {
          db.createObjectStore("settings");
        }
        if (oldVersion < 4) {
          const sources = db.createObjectStore("sources", {
            keyPath: "id",
          });
          sources.createIndex("by-createdAt", "createdAt");
        }
      },
    });
  }
  return dbPromise;
}

export async function putConversation(conversation: Conversation) {
  const db = await getDB();
  await db.put("conversations", conversation);
}

export async function getConversation(id: string) {
  const db = await getDB();
  return db.get("conversations", id);
}

export async function getAllConversations() {
  const db = await getDB();
  return db.getAll("conversations");
}

export async function putMemoryObject(memoryObject: MemoryObject) {
  const db = await getDB();
  await db.put("memoryObjects", memoryObject);
}

export async function getAllMemoryObjects() {
  const db = await getDB();
  return db.getAll("memoryObjects");
}

export async function getMemoryObject(id: string) {
  const db = await getDB();
  return db.get("memoryObjects", id);
}

/**
 * Source基盤（最小構成）のCRUD。Vault保存・Importer・検索は今回のスコープ外
 * （IndexedDBへの保存・取得のみ。putMemoryObject等と同じ薄いラッパーパターンを踏襲する）。
 */
export async function saveSource(source: Source) {
  const db = await getDB();
  await db.put("sources", source);
}

export async function getSource(id: string) {
  const db = await getDB();
  return db.get("sources", id);
}

export async function getAllSources() {
  const db = await getDB();
  return db.getAll("sources");
}

export async function deleteSource(id: string) {
  const db = await getDB();
  await db.delete("sources", id);
}

/**
 * 「この端末に保存されているtsumugiのデータを削除」機能に伴い、IndexedDB側の
 * 派生キャッシュ（Vault Markdownと同じデータを検索・結合用に複製したもの）も
 * 揃えて空にする。`settings`（APIキー・使用するAI・chatProvider等のブラウザ設定）と
 * `handles`（PC/Android用Vaultフォルダの参照）はここでは削除しない。
 * これらはMemory/Conversationの記憶データではなく、ユーザーの「保存先・接続設定」
 * そのものであり、「保存されているデータを削除する」の対象外と判断したため
 * （呼び出し元はOPFSバックエンド時のみ使う想定。PC/Androidの`handles`ストアには
 * この関数自体は一切触れない）。
 */
export async function clearMemoryData() {
  const db = await getDB();
  await Promise.all([
    db.clear("conversations"),
    db.clear("memoryObjects"),
    db.clear("sources"),
    db.clear("connectState"),
  ]);
}

export async function saveVaultHandle(handle: FileSystemDirectoryHandle) {
  const db = await getDB();
  await db.put("handles", handle, "vaultRoot");
}

export async function loadVaultHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await getDB();
  return db.get("handles", "vaultRoot");
}

export async function clearVaultHandle() {
  const db = await getDB();
  await db.delete("handles", "vaultRoot");
}

/**
 * Beta：ユーザー自身のAPIキー。ブラウザ（IndexedDB）にのみ保持し、
 * Tsumugi側のサーバーには永続保存しない（API Routeへはリクエストヘッダーで都度渡す）。
 *
 * providerごとに別のキーとして保存する。Geminiのキー名は既存ユーザーのデータを
 * 壊さないよう、Gemini単独運用時から使っていた"geminiApiKey"をそのまま流用する
 * （新しい命名規則へ移行する必要が無いため、マイグレーション処理も不要）。
 * 引数を省略した場合は常にGeminiを指す（chat以外の既存呼び出し元は無変更のまま
 * Geminiだけを使い続けられる）。
 */
const API_KEY_STORAGE_KEY: Record<AIProviderName, string> = {
  gemini: "geminiApiKey",
  openai: "openaiApiKey",
  claude: "claudeApiKey",
};

export async function saveApiKey(apiKey: string, provider: AIProviderName = "gemini") {
  const db = await getDB();
  await db.put("settings", apiKey, API_KEY_STORAGE_KEY[provider]);
}

export async function loadApiKey(provider: AIProviderName = "gemini"): Promise<string | undefined> {
  const db = await getDB();
  return db.get("settings", API_KEY_STORAGE_KEY[provider]);
}

export async function clearApiKey(provider: AIProviderName = "gemini") {
  const db = await getDB();
  await db.delete("settings", API_KEY_STORAGE_KEY[provider]);
}

/**
 * Beta：「APIキーを登録するprovider」とは別の概念。chatの送信（companion/coach/analyst）に
 * どのproviderを使うかだけを持つ設定値。未設定時はGemini（既存動作を完全に維持するため）。
 * chat以外の機能（Capture/Connect/Reflection/問いかけ生成）はこの設定を参照しない
 * （今回のPhaseでは固定のまま）。
 */
const CHAT_PROVIDER_KEY = "chatProvider";

export async function saveChatProvider(provider: AIProviderName) {
  const db = await getDB();
  await db.put("settings", provider, CHAT_PROVIDER_KEY);
}

export async function loadChatProvider(): Promise<AIProviderName> {
  const db = await getDB();
  const value = await db.get("settings", CHAT_PROVIDER_KEY);
  return value === "openai" || value === "claude" ? value : "gemini";
}

/** 「過去からの問いかけ」機能が直近に表示したMemory IDの一覧（新しいものが末尾）。同じMemoryの連続表示を避けるためだけに使う。 */
const LAST_PROMPTED_MEMORY_IDS_KEY = "lastPromptedMemoryIds";
const MAX_LAST_PROMPTED_MEMORY_IDS = 5;

export async function loadLastPromptedMemoryIds(): Promise<string[]> {
  const db = await getDB();
  const raw = await db.get("settings", LAST_PROMPTED_MEMORY_IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export async function saveLastPromptedMemoryIds(ids: string[]) {
  const db = await getDB();
  const trimmed = ids.slice(-MAX_LAST_PROMPTED_MEMORY_IDS);
  await db.put("settings", JSON.stringify(trimmed), LAST_PROMPTED_MEMORY_IDS_KEY);
}

/**
 * idのConnect処理を開始してよいかを、1つのreadwriteトランザクション内のread→writeで判定する。
 * IndexedDBのトランザクションは同一ストアに対して直列化されるため、React StrictModeによる
 * useEffectの二重実行や、複数タブから同時に呼ばれた場合でも、trueを返すのは必ず1回だけになる
 * （connectStateへの完了記録を待ってから判定するのでは、この2ケースの競合を防げないため）。
 *
 * 既存の"done"はクレームしない。"in-progress"はstaleAfterMsより新しければ他の処理中とみなし
 * クレームしない。staleAfterMsより古い"in-progress"は、異常終了（クラッシュ等）からの回復として
 * 再クレームを許可する。
 */
export async function claimConnectState(id: string, staleAfterMs: number): Promise<boolean> {
  const db = await getDB();
  const tx = db.transaction("connectState", "readwrite");
  const store = tx.objectStore("connectState");
  const existing = await store.get(id);

  let shouldClaim = true;
  if (existing) {
    if (existing.status === "done") {
      shouldClaim = false;
    } else {
      const age = Date.now() - new Date(existing.updatedAt).getTime();
      shouldClaim = age >= staleAfterMs;
    }
  }

  if (shouldClaim) {
    await store.put({ status: "in-progress", updatedAt: new Date().toISOString() }, id);
  }
  await tx.done;
  return shouldClaim;
}

export async function markConnectStateDone(id: string) {
  const db = await getDB();
  await db.put("connectState", { status: "done", updatedAt: new Date().toISOString() }, id);
}

/** Connect処理が失敗した際に呼ぶ。クレームを解放し、次回のキャッチアップ等で再試行できるようにする。 */
export async function releaseConnectState(id: string) {
  const db = await getDB();
  await db.delete("connectState", id);
}

export async function getConnectStateRecords(): Promise<Record<string, ConnectStateRecord>> {
  const db = await getDB();
  const keys = await db.getAllKeys("connectState");
  const result: Record<string, ConnectStateRecord> = {};
  for (const key of keys) {
    const value = await db.get("connectState", key);
    if (value) result[key] = value;
  }
  return result;
}
