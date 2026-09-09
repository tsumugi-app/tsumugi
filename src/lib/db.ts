/**
 * IndexedDB層。STORAGE.md §2.3の通り、役割は検索・結合の高速化のみ。
 * Markdownが正であり、ここは常に「後から書き込まれる」派生キャッシュとして扱う
 * （書き込み順序の担保は capture.ts 側の責務）。
 */
"use client";

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { hiddenFlag, logTimingEvent } from "./debugTimingLog";
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
  /**
   * TEMP-TEST：Android実機で確認された「起動時flushPendingToVaultが、変更の無い
   * データまで毎回無条件で全件Vaultへ書き直し、ユーザー操作の保存を待たせる」問題への対応。
   * 「このid（Conversation/MemoryObject/Source）は、どのupdatedAtまでは確実にVaultへの
   * 書き込みに成功したか」だけを記録する台帳。Vault Markdown自体の内容は一切読まない
   * （読んで比較するとAndroidの遅いI/Oで新たなコストになるため）。
   * key: `conversation:<id>` / `memory:<id>` / `source:<id>`。value: 成功時のupdatedAt。
   * 必ずVaultへの書き込みが実際に成功した後にのみ書き込むこと（楽観的な事前記録は禁止）。
   */
  vaultSyncState: {
    key: string;
    value: string;
  };
}

export interface ConnectStateRecord {
  status: "in-progress" | "done";
  updatedAt: string;
}

let dbPromise: Promise<IDBPDatabase<TsumugiDB>> | null = null;

/**
 * TEMP-TEST：Android実機で`boot:start`の後に`boot:end`まで到達しない事象の原因切り分け用。
 * IndexedDBのバージョンアップグレード（4→5）が、同一originの別接続（別タブ・古いページ
 * インスタンス等）によって"blocked"状態のまま止まっていないかを直接確認するための
 * 最小限のログ。db.ts・upgrade処理・Vault/Chat処理には一切手を加えない
 * （openDB呼び出しの前後にログを追加するだけ）。原因調査が終わり次第削除すること。
 */
function getDB() {
  if (!dbPromise) {
    const openStart = Date.now();
    console.log(`[DB] open:start hidden=${hiddenFlag()}`);
    logTimingEvent("DB open:start", { hidden: hiddenFlag() });

    dbPromise = openDB<TsumugiDB>("tsumugi", 5, {
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
        if (oldVersion < 5) {
          db.createObjectStore("vaultSyncState");
        }
      },
      // 同一originの別接続（古いバージョンを開いたままの別タブ・ページインスタンス等）が
      // 存在し、このアップグレードが待たされている間に発火する。
      blocked() {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:blocked hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:blocked", { hidden: hiddenFlag(), durationMs });
      },
      // 逆に、この接続（古いバージョン側）が新しいバージョンの接続をblockしている場合に
      // 発火する。ここでは何もクローズしない（回復処理はしない、計測のみ）。
      blocking() {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:blocking hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:blocking", { hidden: hiddenFlag(), durationMs });
      },
      terminated() {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:terminated hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:terminated", { hidden: hiddenFlag(), durationMs });
      },
    });

    // dbPromise自体は書き換えない（既存の戻り値・失敗時の伝播は無変更）。
    // ここでは成功/失敗を観測してログを残すだけの別購読。
    dbPromise.then(
      () => {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:success hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:success", { hidden: hiddenFlag(), durationMs });
      },
      () => {
        const durationMs = Date.now() - openStart;
        console.log(`[DB] open:error hidden=${hiddenFlag()} durationMs=${durationMs}`);
        logTimingEvent("DB open:error", { hidden: hiddenFlag(), durationMs });
      }
    );
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
    db.clear("vaultSyncState"),
  ]);
}

/**
 * TEMP-TEST：Vault同期済み台帳（vaultSyncState）のCRUD。key/valueの意味は
 * TsumugiDBのvaultSyncStoreのコメントを参照。呼び出し元（vault.ts）の責務として、
 * setVaultSyncStateは必ずVaultへの実書き込みが成功した後にのみ呼ぶこと。
 */
export async function getVaultSyncState(key: string): Promise<string | undefined> {
  const db = await getDB();
  return db.get("vaultSyncState", key);
}

export async function setVaultSyncState(key: string, updatedAt: string): Promise<void> {
  const db = await getDB();
  await db.put("vaultSyncState", updatedAt, key);
}

/**
 * 新しいVaultフォルダを選択した直後にのみ呼ぶこと（同じVaultへの再認可では呼ばない）。
 * 台帳はどのフォルダに対する同期状況かを区別しないため、フォルダが変わった場合に
 * クリアしないと「新フォルダには実際は書き込まれていないのに同期済み」と誤判定し、
 * 書き込みが漏れる事故につながる。
 */
export async function clearVaultSyncState(): Promise<void> {
  const db = await getDB();
  await db.clear("vaultSyncState");
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

/**
 * Vault境界の安全性（H4：複数タブ間でのVault privacy boundary対応）。
 *
 * 「現在アクティブなVaultの世代」を表す単調増加のカウンタ。既存の`settings`ストア
 * （汎用KVストア）へ1キー追加するだけで、DB schemaの変更は行わない。
 * 別Vaultへの切替が確定した瞬間（`navigator.locks`の排他ロック内、IndexedDBの
 * clearより前）にのみ`bumpActiveVaultEpoch()`でインクリメントする。
 *
 * 各タブは、この値を自分の「タブローカルな信じているepoch」（vaultWorldLock.tsの
 * `tabVaultEpoch`）と比較することで、「自分のVault世界は今も共有ストレージの
 * アクティブなVaultと一致しているか」を、Memory Worldへの読み書きの直前に
 * 都度確認する（`withVaultWorldRead`/`runVaultSwitchExclusive`参照）。
 *
 * 未設定（アプリ初回起動、一度もVault操作をしていない状態）は0として扱う。
 */
const ACTIVE_VAULT_EPOCH_KEY = "activeVaultEpoch";

/**
 * Codexレビュー指摘（journal値validation）対応：epochとして「valid」とみなすのは
 * finite・integer・0以上・Number.isSafeInteger、かつ保存文字列が`String(parsed)`と
 * 完全一致するもの（roundtrip確認）だけにする。roundtrip確認を入れる理由：
 * `Number("")`は`0`、`Number(" 5")`は`5`になる等、`Number(...)`だけでは
 * 空文字列・前後空白付き文字列・16進数表記等の「一見数値だが本来は不正な入力」を
 * 弾けないため（`String(0) !== ""`となることを利用して弾く）。
 */
function isValidStoredEpochValue(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const parsed = Number(raw);
  return (
    Number.isFinite(parsed) &&
    Number.isInteger(parsed) &&
    Number.isSafeInteger(parsed) &&
    parsed >= 0 &&
    String(parsed) === raw
  );
}

export type VaultEpochStatus = { status: "missing" } | { status: "valid"; epoch: number } | { status: "invalid" };

function parseStoredEpoch(raw: unknown): VaultEpochStatus {
  if (raw === undefined) return { status: "missing" };
  if (!isValidStoredEpochValue(raw)) return { status: "invalid" };
  return { status: "valid", epoch: Number(raw) };
}

/**
 * Codexレビュー指摘（journal値validation）対応：未設定（一度もbumpされていない、
 * アプリ初回起動）は0として扱う（正常な初期状態）。保存値が存在するのに壊れている
 * （上記validationを満たさない）場合は、0へ黙って丸めず例外を投げる——呼び出し元は
 * 必ずこれをcatchして安全側（Memory World操作の拒否）に倒すこと。既存の呼び出し元
 * （withVaultWorldRead・各Vault切替の排他ロックコールバック等）は全てこの契約に
 * 従って実装されている（詳細はそれぞれのコメント参照）。
 */
export async function getActiveVaultEpoch(): Promise<number> {
  const db = await getDB();
  const raw = await db.get("settings", ACTIVE_VAULT_EPOCH_KEY);
  const status = parseStoredEpoch(raw);
  if (status.status === "missing") return 0;
  if (status.status === "invalid") {
    throw new Error(`[Tsumugi] invalid activeVaultEpoch value in storage: ${JSON.stringify(raw)}`);
  }
  return status.epoch;
}

/**
 * 別Vaultへの切替コミット（`navigator.locks`の排他ロック内）からのみ呼ぶこと。
 * 複数タブから同時に呼ばれないことは、呼び出し元が排他ロックで保証する。
 *
 * Codexレビュー指摘（再発、High）対応：以前は`getActiveVaultEpoch()`が例外を
 * 投げた場合（＝保存値が壊れている場合）に0へfallbackして1から数え直していたが、
 * これはepochの単調増加という大前提を崩す——古いepoch世代の値を偶然にも
 * 再利用してしまい、その古い世代を"覚えている"タブ（tabVaultEpochが偶然その値と
 * 一致するタブ）が誤って再承認されうる。ここでは一切fallbackせず、
 * `getActiveVaultEpoch()`の例外（IndexedDB read failure・invalid stored value等）を
 * そのままrejectさせる（fail-fast）。
 *
 * `expectedEpoch`（Codexレビュー指摘：expected epoch付きbump）：呼び出し元が
 * 排他ロック内で確認済みの「今のactiveVaultEpochはこの値のはず」を渡すこと。
 * 内部で改めてactiveVaultEpochを読み直し、`expectedEpoch`と一致しない場合は
 * 例外を投げる（呼び出し元はstale扱いにすること）。一致した場合のみ
 * `expectedEpoch + 1`を書き込む。これにより「呼び出し元がepochを確認した
 * 瞬間」と「実際にbumpする瞬間」の間に想定外の変更が入っていないかを、
 * このAPI自体でも再確認できる（排他ロック下では通常起こらないはずだが、
 * APIとしての安全側の設計として持たせる）。
 *
 * epoch overflow（`expectedEpoch + 1`が`Number.MAX_SAFE_INTEGER`を超える場合）も
 * 例外を投げる。wrap・resetは行わない。
 */
export async function bumpActiveVaultEpoch(expectedEpoch: number): Promise<number> {
  const db = await getDB();
  const current = await getActiveVaultEpoch();
  if (current !== expectedEpoch) {
    throw new Error(
      `[Tsumugi] bumpActiveVaultEpoch: expected activeVaultEpoch=${expectedEpoch} but found ${current}; refusing (stale).`
    );
  }
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error(`[Tsumugi] bumpActiveVaultEpoch: epoch overflow (current=${current})`);
  }
  await db.put("settings", String(next), ACTIVE_VAULT_EPOCH_KEY);
  return next;
}

/**
 * Codexレビュー指摘（Medium→H4クローズ条件：handle/epoch/sync state failure
 * consistency）対応：「activeVaultEpochを何番まで、実際にhandle保存・IndexedDB
 * clear等の副作用を含めて完全にcommitし終えたか」を表す、小さなjournal。
 * 既存の`settings`ストアへ1キー追加するだけで、DB schemaの変更・vaultId
 * namespace導入は行わない。
 *
 * 使い方（呼び出し元＝ChatScreen.tsxのVault切替コミット）：
 * `bumpActiveVaultEpoch()`で新epochへ進めた後、そのepochに対応する副作用
 * （IndexedDB clear・新Vault handle保存・sync state clear等）が"全て"成功した
 * 最後にだけ`markVaultEpochCommitted(newEpoch)`を呼ぶ。途中のどこか
 * （awaitの合間・例外・タブクラッシュ・リロード等）で中断した場合、
 * `committedVaultEpoch`は古いままになる。
 *
 * 起動時（ChatScreen.tsxの起動effect）・および各Memory World操作の直前
 * （vaultWorldLock.tsのwithVaultWorldRead）は、`getActiveVaultEpoch()`と
 * `getCommittedVaultEpoch()`を読み比べ、一致しない場合（＝直前のswitchが
 * 完了しないまま終了した形跡）は、保存済みhandleを信用せず「未接続」として
 * 扱う（fail-closed。new epoch + 古い/不整合なhandleを正常worldとして採用しない）。
 *
 * Codexレビュー指摘（再発、High）対応：「journal keyが存在しない＝missing」を
 * 安易に0へ変換してはいけない。missingには2つの全く異なる意味がありうる：
 *   (a) legacy：この端末でjournal方式自体がまだ有効化されていない
 *       （既存Betaからの初回起動。9c07299時点のユーザーはこちら）。
 *   (b) 新方式が既に有効化された後の、最初のswitch中の失敗でjournalが
 *       書き込まれないまま終了した（＝本物のincomplete）。
 * (a)と(b)を区別できないまま「missing→0扱い」にすると、(b)のケースを
 * 誤って安全な状態として通してしまう（今回Codexが指摘したHigh-2）。
 * この区別は`isVaultWorldJournalMigrated()`（下記）という別のmigration
 * markerで行う——`getCommittedVaultEpoch()`自体は「missing/valid/invalid」の
 * 3状態を正直に返すだけにする（呼び出し元がmigration markerと組み合わせて
 * legacy/incompleteを判定する）。
 */
const COMMITTED_VAULT_EPOCH_KEY = "committedVaultEpoch";

/** activeVaultEpochと同じ意味の3状態（`VaultEpochStatus`をそのまま再利用）。 */
export type CommittedVaultEpochStatus = VaultEpochStatus;

/**
 * Codexレビュー指摘（journal値validation）対応：activeVaultEpochと同じ厳密な
 * validation（`parseStoredEpoch`）を使う。「missing→0」への変換は絶対に行わない
 * （呼び出し元がmissing/valid/invalidを明示的に区別して判定する）。
 */
export async function getCommittedVaultEpoch(): Promise<CommittedVaultEpochStatus> {
  const db = await getDB();
  const raw = await db.get("settings", COMMITTED_VAULT_EPOCH_KEY);
  return parseStoredEpoch(raw);
}

/**
 * そのepochへのswitchに伴う副作用（IndexedDB clear・handle保存・sync state clear等）が
 * 全て成功した後、必ず最後に（`navigator.locks`の排他ロックを保持したまま）呼ぶこと。
 */
export async function markVaultEpochCommitted(epoch: number): Promise<void> {
  const db = await getDB();
  await db.put("settings", String(epoch), COMMITTED_VAULT_EPOCH_KEY);
}

/**
 * Codexレビュー指摘（既存Beta migration）対応：「committedVaultEpochキー自体が
 * まだ存在しない」を、常に安全な"legacy"とみなしてよいのは、この端末で
 * journal方式（committedVaultEpoch）がまだ一度も有効化されていない場合だけ。
 * 一度有効化された後にjournalが失われた（＝本物のincomplete）場合と
 * 区別するため、journal方式自体の有効化を示す別マーカーを持つ。
 *
 * 値の中身自体は問わず、キーの存在だけを見る（一度でも
 * `markVaultWorldJournalMigrated()`されていれば、二度と"legacy"扱いへは
 * 戻さない——後述のmigration手順が「起動のたびに現在のhandleを無条件に
 *信用し直す」という危険な繰り返しにならないようにするため）。
 */
const VAULT_WORLD_JOURNAL_VERSION_KEY = "vaultWorldJournalVersion";
/** 数値として持つ（将来のmigrationで比較・分岐しやすくするため）。保存形式は他のepoch値と
 * 同じ文字列化した数値。 */
const CURRENT_VAULT_WORLD_JOURNAL_VERSION = 1;

export type VaultWorldJournalVersionStatus =
  | { status: "missing" }
  | { status: "current" }
  | { status: "unexpected"; raw: string };

/**
 * Codexレビュー指摘（migration version marker）対応：「キーが存在するか」だけでなく、
 * 値そのものを検証する。
 * - missing：この端末でjournal方式自体がまだ一度も有効化されていない
 *   （legacy／partial migration判定へ進む）。
 * - current：現在のjournal方式（version 1）が正しく有効化済み。
 * - unexpected：キーは存在するが、想定するversion番号と一致しない
 *   （壊れた値、または将来のversion番号だが今のコードが対応していない等）。
 *   legacy扱いは絶対にせず、fail-closedへ倒す（「一度migrated済みの端末を
 *   二度とlegacy扱いへ戻さない」という既存の原則の一部）。
 */
export async function getVaultWorldJournalVersion(): Promise<VaultWorldJournalVersionStatus> {
  const db = await getDB();
  const raw = await db.get("settings", VAULT_WORLD_JOURNAL_VERSION_KEY);
  if (raw === undefined) return { status: "missing" };
  if (raw === String(CURRENT_VAULT_WORLD_JOURNAL_VERSION)) return { status: "current" };
  return { status: "unexpected", raw };
}

/**
 * legacy migration（既存Betaからの初回起動）が、現在のVault world（handle/epoch）を
 * 正常に確認し終えた最後にだけ呼ぶこと。`markVaultEpochCommitted()`より必ず後に
 * 呼ぶこと（途中で中断した場合、"committedVaultEpochは書けたがmigrated markerは
 * 書けていない"という状態の方が安全——次回起動時、migration処理をもう一度
 * 現在のhandleから正しくやり直せる。逆順だと"migrated済みなのにcommitted無し"
 * という、通常のincomplete判定と見分けが付かない状態を作ってしまう）。
 */
export async function markVaultWorldJournalMigrated(): Promise<void> {
  const db = await getDB();
  await db.put("settings", String(CURRENT_VAULT_WORLD_JOURNAL_VERSION), VAULT_WORLD_JOURNAL_VERSION_KEY);
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
