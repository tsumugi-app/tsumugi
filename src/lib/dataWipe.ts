/**
 * 「この端末のTsumugiデータを完全に削除」（PC / Android / iPhone / iPad共通）。
 *
 * 単なるMemory削除ではなく、Tsumugiの完全なローカルリセット。この端末を他人に渡しても、以前の
 * Conversation / Memory / 設定 / APIキー等をアプリから取得・Retrieval・復元できない状態にする。
 *
 * 【設計（コード調査に基づく最終決定）】
 *  - 削除は必ず「新しく読み込んだページ」の、アプリ本体（ChatScreen）が起動する前に行う（`WipeGate`）。
 *    開始操作は、durable marker（`wipeState.ts`）を書いてページをリロードするだけ。リロードで、
 *    実行中のCapture/Connect/Reflection/revisitPrompt/会話保存/Vault書き込み等のin-flight処理は
 *    全て消える。念のため、markerがある間はdb.tsの`getDB`とvault.tsの`enqueueVaultWrite`が
 *    以降の全アクセスを拒否する（他タブにも効く。他タブの接続はblockingで閉じ、storageイベントで
 *    リロードされる）。
 *  - 削除順序：IndexedDB → OPFS → localStorage/sessionStorage → 検証 → marker削除。
 *    IndexedDBを最初にするのは、Retrieval/Capture/Connect/topPrompt/Topic Continuity/直近会話が
 *    読むのはIndexedDBだけであり、「古いデータがRetrievalへ復活する」状態を最短で消せるため。
 *    また、APIキー・設定・epoch・PCのdirectory handleもIndexedDBにあるので、ここで同時に消える。
 *    OPFSはその後。OPFSだけが残る中断状態でも、markerがあるためアプリは起動せず、次回起動時に
 *    OPFSからIndexedDBへ復元される（データの復活）前に、削除が再開される。
 *    markerは最後まで残し、全検証に通った後にだけ消す（=markerの有無が「完了」の唯一の印）。
 *  - 各手順は冪等。何度実行しても安全で、途中失敗・ブラウザ/PWA終了・リロードの後も同じ手順で再開する。
 *  - PCの外部Vault（ユーザーが選んだフォルダ）のMarkdownには一切触れない。触るのは、Tsumugi自身の
 *    管理データ（IndexedDBに保存された、そのフォルダへのhandleを含む）だけ。フォルダへのアクセスを
 *    一切行わないため、外部Vaultのファイルは変更・削除されない。
 */
import { WIPE_MARKER_KEY } from "./wipeState";

const DB_NAME = "tsumugi";
const RETRIES = 3;

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WipeEnv {
  indexedDB: IDBFactory;
  localStorage: StorageLike;
  sessionStorage: StorageLike | null;
  /** OPFSのroot。OPFS非対応の環境ではnull（消すものが無い）。 */
  getOpfsRoot: (() => Promise<FileSystemDirectoryHandle>) | null;
  /** 削除の待機状況を画面へ知らせる（例：他のタブが接続を閉じるのを待っている）。 */
  onProgress?: (message: string) => void;
}

export interface WipeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type WipeResult =
  | { status: "none" }
  | { status: "completed"; checks: WipeCheck[] }
  | { status: "failed"; failures: string[]; checks: WipeCheck[] };

export function defaultWipeEnv(onProgress?: (message: string) => void): WipeEnv {
  const opfs =
    typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function"
      ? () => navigator.storage.getDirectory()
      : null;
  return {
    indexedDB,
    localStorage,
    sessionStorage: typeof sessionStorage !== "undefined" ? sessionStorage : null,
    getOpfsRoot: opfs,
    onProgress,
  };
}

/** 削除を開始する（markerを書くだけ。呼び出し側がこの後すぐページをリロードする）。書けなければ何も変えずに投げる。 */
export function requestFullWipe(storage: StorageLike = localStorage): void {
  storage.setItem(WIPE_MARKER_KEY, JSON.stringify({ v: 1, startedAt: new Date().toISOString() }));
  if (storage.getItem(WIPE_MARKER_KEY) === null) {
    throw new Error("wipe marker was not stored");
  }
}

export function hasWipeMarker(storage: StorageLike = localStorage): boolean {
  try {
    return storage.getItem(WIPE_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

const isTsumugiKey = (key: string) => key.toLowerCase().startsWith("tsumugi");

// ---------------------------------------------------------------------------
// 各手順（いずれも冪等。失敗は投げずに、失敗理由の文字列を返す）
// ---------------------------------------------------------------------------

async function listDatabaseNames(factory: IDBFactory): Promise<string[]> {
  const names = new Set<string>([DB_NAME]);
  try {
    if (typeof factory.databases === "function") {
      for (const info of await factory.databases()) if (info.name) names.add(info.name);
    }
  } catch {
    // databases()が使えない環境では、既知のDB名だけを対象にする
  }
  return [...names];
}

function deleteDatabase(factory: IDBFactory, name: string, onProgress?: (m: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`deleteDatabase(${name}) failed`));
    // 別のタブ・ウィンドウが接続を開いたままだと、削除はその接続が閉じるまで待たされる。
    // 待ち続け（閉じられたら自動で進む）、その旨を画面へ知らせる。
    request.onblocked = () => onProgress?.("他のTsumugiのタブやウィンドウを閉じると、削除が進みます…");
  });
}

async function clearIndexedDb(env: WipeEnv): Promise<string[]> {
  const failures: string[] = [];
  for (const name of await listDatabaseNames(env.indexedDB)) {
    try {
      await deleteDatabase(env.indexedDB, name, env.onProgress);
    } catch (error) {
      failures.push(`IndexedDB「${name}」を削除できませんでした（${describe(error)}）`);
    }
  }
  return failures;
}

async function clearOpfs(env: WipeEnv): Promise<string[]> {
  if (!env.getOpfsRoot) return [];
  const failures: string[] = [];
  let root: FileSystemDirectoryHandle;
  try {
    root = await env.getOpfsRoot();
  } catch (error) {
    return [`端末内の保存領域（OPFS）を開けませんでした（${describe(error)}）`];
  }
  const names: string[] = [];
  try {
    for await (const [name] of root.entries()) names.push(name);
  } catch (error) {
    return [`端末内の保存領域（OPFS）の一覧を読めませんでした（${describe(error)}）`];
  }
  for (const name of names) {
    let removed = false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < RETRIES && !removed; attempt++) {
      try {
        await root.removeEntry(name, { recursive: true });
        removed = true;
      } catch (error) {
        // 既に無い（別の手順・再実行で消えた）なら成功として扱う
        if (error instanceof DOMException && error.name === "NotFoundError") removed = true;
        else lastError = error;
      }
    }
    if (!removed) failures.push(`端末内の保存領域「${name}」を削除できませんでした（${describe(lastError)}）`);
  }
  return failures;
}

function clearStorage(storage: StorageLike | null, label: string): string[] {
  if (!storage) return [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key !== WIPE_MARKER_KEY && isTsumugiKey(key)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    return [];
  } catch (error) {
    return [`${label}のTsumugiデータを削除できませんでした（${describe(error)}）`];
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

// ---------------------------------------------------------------------------
// 検証（完了と表示する前に、実際に確認する）
// ---------------------------------------------------------------------------

/** IndexedDB「name」が存在しないことを、DBを新規作成せずに確認する（バージョン無しopen→upgradeneededでabort）。 */
function idbExists(factory: IDBFactory, name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let existed = true;
    const request = factory.open(name);
    request.onupgradeneeded = () => {
      existed = false; // 存在しなかったため作成しようとしている → 中止して作らない
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(existed);
    };
    request.onerror = () => resolve(existed);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

export async function verifyWipe(env: WipeEnv): Promise<WipeCheck[]> {
  const checks: WipeCheck[] = [];

  // IndexedDB（conversations/memoryObjects/sources/connectState/vaultSyncState/handles/settings=APIキー・epoch等を全て含む）
  try {
    const remaining: string[] = [];
    for (const name of await listDatabaseNames(env.indexedDB)) {
      if (await idbExists(env.indexedDB, name)) remaining.push(name);
    }
    checks.push({
      name: "IndexedDB",
      ok: remaining.length === 0,
      detail: remaining.length === 0 ? "存在しません（Conversation・Memory・Source・設定・APIキー・保存先の参照は0件）" : `残っています：${remaining.join(", ")}`,
    });
  } catch (error) {
    checks.push({ name: "IndexedDB", ok: false, detail: `確認できませんでした（${describe(error)}）` });
  }

  // OPFS（PC外部Vaultは対象外。ここは端末内の、Tsumugi専用の安全な領域）
  if (env.getOpfsRoot) {
    try {
      const root = await env.getOpfsRoot();
      const left: string[] = [];
      for await (const [name] of root.entries()) left.push(name);
      checks.push({ name: "OPFS", ok: left.length === 0, detail: left.length === 0 ? "空です" : `残っています：${left.join(", ")}` });
    } catch (error) {
      checks.push({ name: "OPFS", ok: false, detail: `確認できませんでした（${describe(error)}）` });
    }
  } else {
    checks.push({ name: "OPFS", ok: true, detail: "この環境では対象外です" });
  }

  // localStorage / sessionStorage
  for (const [label, storage] of [["localStorage", env.localStorage], ["sessionStorage", env.sessionStorage]] as const) {
    if (!storage) continue;
    try {
      const left: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key !== null && key !== WIPE_MARKER_KEY && isTsumugiKey(key)) left.push(key);
      }
      checks.push({ name: label, ok: left.length === 0, detail: left.length === 0 ? "Tsumugiのデータはありません" : `残っています：${left.join(", ")}` });
    } catch (error) {
      checks.push({ name: label, ok: false, detail: `確認できませんでした（${describe(error)}）` });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * markerがあれば、削除を（再）開始して完了まで行う。markerが無ければ何もしない。
 * 全ての検証に通った場合にだけmarkerを消す（消せなければ失敗として、markerを残す）。
 */
export async function runPendingWipe(env: WipeEnv): Promise<WipeResult> {
  if (!hasWipeMarker(env.localStorage)) return { status: "none" };

  env.onProgress?.("端末内のデータを削除しています…");
  const failures: string[] = [];
  failures.push(...(await clearIndexedDb(env))); // 1. Retrieval等が読む唯一のストアと、APIキー・設定・handleを最初に消す
  failures.push(...(await clearOpfs(env))); // 2. 端末内Vault（OPFS）
  failures.push(...clearStorage(env.localStorage, "localStorage")); // 3. デバッグログ等（marker以外）
  failures.push(...clearStorage(env.sessionStorage, "sessionStorage"));

  env.onProgress?.("削除できたか確認しています…");
  const checks = await verifyWipe(env);
  for (const check of checks) if (!check.ok) failures.push(`${check.name}：${check.detail}`);
  if (failures.length > 0) return { status: "failed", failures, checks };

  try {
    env.localStorage.removeItem(WIPE_MARKER_KEY);
    if (env.localStorage.getItem(WIPE_MARKER_KEY) !== null) throw new Error("marker still present");
  } catch (error) {
    return { status: "failed", failures: [`削除の完了記録を消せませんでした（${describe(error)}）`], checks };
  }
  return { status: "completed", checks };
}
