/**
 * Vaultの、ファイル1つ分の書き込みの共通入口（`writeFileHandleContent`）。
 *
 * 【背景】iPhone Safari（例：iOS 18.7 / Safari 18.7.5）には`FileSystemFileHandle.createWritable()`が無い
 * （実機のプローブと診断v4で確認済み）。一方、Dedicated Workerの中では`createSyncAccessHandle()`が使える
 * （main threadには無い）。そこで、`createWritable`が無いときだけ、Workerでの書き込みに切り替える。
 *
 * 【経路】
 * - `createWritable`がある（Android・PC・新しいSafari等）：従来どおり`createWritable → write → close`。
 *   Worker・読み戻し・ロックは使わない（従来の挙動を変えない）。
 * - `createWritable`が無い（OPFSのみ）：`root.resolve(fileHandle)`でrootからのpathを求め、pathだけをWorkerへ渡す
 *   （`FileSystemHandle`のpostMessage転送はiPhone Safariで`DataCloneError`になるため使わない）。Workerは
 *   `navigator.storage.getDirectory()`からpathをたどり、`createSyncAccessHandle → write → truncate → flush → close`。
 *
 * 【fallback書き込みの手順】旧内容を保持 → Workerで書き込み → main threadで読み戻し（サイズ＋全バイト）→
 * 失敗時は旧内容を可能な範囲で書き戻す（rollback）。失敗は必ず例外として投げる（rollbackに成功しても、
 * 書き込み自体は失敗）。呼び出し元は、成功後にだけledger/Registryを更新する既存の順序のまま。
 *
 * 【直列化】fallbackの書き込みは、モジュール内の単一のqueueで1件ずつ実行する（同一ファイルへ複数の同期ハンドルを
 * 同時に開かない）。さらにタブ間でも、Web Lock（`tsumugi-vault-writer`、排他）で直列にする。このロックは、
 * 他のロック（Vault world・Registry・History）の内側で最も内側にだけ取り、この中から他のロックは取らない。
 *
 * 【残る限界（今回のスコープ外）】in-placeの書き込みのため、書き込み中にプロセスが終了すると、途中の状態が
 * 残りうる（一時ファイル＋atomic recoveryは含めない）。rollbackはプロセスが生きている間の失敗だけを対象とする。
 *
 * このモジュールは、他のTsumugiモジュールをimportしない（vault.tsから安全に使うため）。
 */

export type WriteContent = string | ArrayBuffer | Uint8Array;

const WRITER_LOCK_NAME = "tsumugi-vault-writer";
const WORKER_CALL_TIMEOUT_MS = 20000;
const WORKER_IDLE_TERMINATE_MS = 30000;
const SELFTEST_FILE = ".writer-selftest";

export class VaultWriterUnavailableError extends Error {
  constructor(message: string, readonly reason?: unknown) {
    super(message);
    this.name = "VaultWriterUnavailableError";
  }
}

export type VaultRollbackResult = "restored" | "failed" | "not-attempted";

export class VaultWriteVerificationError extends Error {
  constructor(message: string, readonly rollback: VaultRollbackResult, readonly reason?: unknown) {
    super(message);
    this.name = "VaultWriteVerificationError";
  }
}

// ---------------------------------------------------------------------------
// 経路の判定
// ---------------------------------------------------------------------------

/** このファイルハンドルが、`createWritable`を持つか（＝従来のnative経路を使えるか）。 */
export function hasNativeWritable(file: FileSystemFileHandle): boolean {
  return typeof (file as { createWritable?: unknown }).createWritable === "function";
}

function prototypeHasWritable(): boolean {
  try {
    return typeof FileSystemFileHandle !== "undefined" && typeof FileSystemFileHandle.prototype.createWritable === "function";
  } catch {
    return false;
  }
}

export type OpfsWriterState = "unknown" | "native" | "worker" | "unavailable";
let writerState: OpfsWriterState = "unknown";

/**
 * OPFSの書き込み方式の状態。`createWritable`があれば"native"。無い場合は、能力確認（`checkOpfsWriter`）の結果
 * ("worker"＝Worker経路で確認済み / "unavailable"＝使えない)、まだ確認していなければ"unknown"。
 * 同期関数で、renderからも呼べる。
 */
export function getOpfsWriterState(): OpfsWriterState {
  if (prototypeHasWritable()) return "native";
  return writerState;
}

// ---------------------------------------------------------------------------
// Worker（Blob URLから起動。プローブで実機検証した構造）
// ---------------------------------------------------------------------------

export const WRITER_WORKER_SOURCE = `
"use strict";
function errOf(e) { return { name: (e && e.name) || "Error", message: String((e && e.message) || e) }; }
async function openByPath(path) {
  let dir = await navigator.storage.getDirectory();
  for (let i = 0; i < path.length - 1; i++) dir = await dir.getDirectoryHandle(path[i]);
  return dir.getFileHandle(path[path.length - 1]);
}
async function openAccess(file) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await file.createSyncAccessHandle(); }
    catch (e) {
      last = e;
      if (e && (e.name === "InvalidStateError" || e.name === "NoModificationAllowedError")) { await new Promise((r) => setTimeout(r, 50)); continue; }
      throw e;
    }
  }
  throw last;
}
self.onmessage = async (event) => {
  const m = event.data;
  const id = m.id;
  const reply = (ok, detail, error) => self.postMessage({ id, ok, detail, error });
  try {
    if (m.type === "info") {
      reply(true, {
        syncAccessHandle: typeof FileSystemFileHandle !== "undefined" ? typeof FileSystemFileHandle.prototype.createSyncAccessHandle : "no FileSystemFileHandle",
        getDirectory: typeof navigator !== "undefined" && navigator.storage ? typeof navigator.storage.getDirectory : "no navigator.storage",
      });
      return;
    }
    if (m.type === "write") {
      const bytes = m.bytes;
      const file = await openByPath(m.path);
      const access = await openAccess(file);
      let size;
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = access.write(bytes.subarray(offset), { at: offset });
          if (!(written > 0)) throw new Error("short write");
          offset += written;
        }
        access.truncate(bytes.byteLength);
        access.flush();
        size = access.getSize();
      } finally {
        access.close();
      }
      if (size !== bytes.byteLength) throw new Error("size mismatch after write: " + size + " != " + bytes.byteLength);
      reply(true, { size });
      return;
    }
    reply(false, null, { name: "Error", message: "unknown message type: " + m.type });
  } catch (e) {
    reply(false, null, errOf(e));
  }
};
`;

interface WorkerReply {
  ok: boolean;
  detail?: unknown;
  error?: { name: string; message: string };
}

export interface WriterWorkerClient {
  call(message: Record<string, unknown>): Promise<WorkerReply>;
  terminate(): void;
}

function defaultWorkerFactory(): WriterWorkerClient {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new VaultWriterUnavailableError("Dedicated Workerを作成できません");
  }
  const url = URL.createObjectURL(new Blob([WRITER_WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(url);
  let nextId = 1;
  const pending = new Map<number, (reply: WorkerReply) => void>();
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as WorkerReply & { id: number };
    const resolve = pending.get(data.id);
    if (resolve) {
      pending.delete(data.id);
      resolve({ ok: data.ok, detail: data.detail, error: data.error });
    }
  };
  worker.onerror = (event: ErrorEvent) => {
    for (const resolve of pending.values()) resolve({ ok: false, error: { name: "WorkerError", message: event.message || "worker error" } });
    pending.clear();
  };
  return {
    call(message) {
      const id = nextId++;
      return new Promise<WorkerReply>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: { name: "Timeout", message: `no reply within ${WORKER_CALL_TIMEOUT_MS}ms` } });
        }, WORKER_CALL_TIMEOUT_MS);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        try {
          worker.postMessage({ ...message, id });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ ok: false, error: { name: (error as Error)?.name ?? "Error", message: (error as Error)?.message ?? String(error) } });
        }
      });
    },
    terminate() {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

// ---------------------------------------------------------------------------
// テスト用に差し替えられる部品
// ---------------------------------------------------------------------------

type LockRunner = <T>(fn: () => Promise<T>) => Promise<T>;

const defaultLockRunner: LockRunner = async <T,>(fn: () => Promise<T>): Promise<T> => {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return await navigator.locks.request(WRITER_LOCK_NAME, { mode: "exclusive" }, fn);
  }
  return await fn();
};

let workerFactory: () => WriterWorkerClient = defaultWorkerFactory;
let rootProvider: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory();
let lockRunner: LockRunner = defaultLockRunner;
let idleMs = WORKER_IDLE_TERMINATE_MS;

/** テスト専用。本番コードから呼ばない。 */
export const __vaultWriterTesting = {
  setWorkerFactory(factory: (() => WriterWorkerClient) | null) {
    workerFactory = factory ?? defaultWorkerFactory;
  },
  setRootProvider(provider: (() => Promise<FileSystemDirectoryHandle>) | null) {
    rootProvider = provider ?? (() => navigator.storage.getDirectory());
  },
  setLockRunner(runner: LockRunner | null) {
    lockRunner = runner ?? defaultLockRunner;
  },
  setIdleMs(ms: number) {
    idleMs = ms;
  },
  reset() {
    dropWorker();
    writerState = "unknown";
    createdWorkers = 0;
    chain = Promise.resolve();
    workerFactory = defaultWorkerFactory;
    rootProvider = () => navigator.storage.getDirectory();
    lockRunner = defaultLockRunner;
    idleMs = WORKER_IDLE_TERMINATE_MS;
  },
  workerCount: () => createdWorkers,
};

let worker: WriterWorkerClient | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let createdWorkers = 0;

function dropWorker() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // no-op
    }
    worker = null;
  }
}

function getWorker(): WriterWorkerClient {
  if (!worker) {
    worker = workerFactory();
    createdWorkers += 1;
  }
  return worker;
}

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(dropWorker, idleMs);
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

async function callWorker(message: Record<string, unknown>): Promise<WorkerReply> {
  const w = getWorker();
  const reply = await w.call(message);
  // 応答しない・異常終了したWorkerは、内部の同期ハンドルの状態が不明なため捨てる（破棄するとブラウザがハンドルを閉じる）
  if (!reply.ok && reply.error && (reply.error.name === "Timeout" || reply.error.name === "WorkerError")) dropWorker();
  else armIdleTimer();
  return reply;
}

// ---------------------------------------------------------------------------
// 直列化
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

function toBytes(content: WriteContent): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content.slice();
  return new Uint8Array(content.slice(0));
}

function errText(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { name?: string; message?: string };
    return `${e.name ?? "Error"}: ${e.message ?? String(error)}`;
  }
  return String(error);
}

async function verifyContent(file: FileSystemFileHandle, expected: Uint8Array): Promise<void> {
  const actual = new Uint8Array(await (await file.getFile()).arrayBuffer());
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`read-back size mismatch: ${actual.byteLength} != ${expected.byteLength}`);
  }
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) throw new Error(`read-back content mismatch at byte ${i}`);
  }
}

async function workerWrite(path: string[], bytes: Uint8Array): Promise<void> {
  const reply = await callWorker({ type: "write", path, bytes });
  if (!reply.ok) throw new Error(reply.error ? errText(reply.error) : "worker write failed");
}

async function writeOnce(file: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const root = await rootProvider();
  if (typeof root.resolve !== "function") throw new VaultWriterUnavailableError("FileSystemDirectoryHandle.resolve が使えません");
  const path = await root.resolve(file);
  if (!path || path.length === 0) throw new Error("cannot resolve the file path from the OPFS root");

  // 旧内容を保持する（読めない場合は、旧内容を失う恐れがあるため上書きしない）
  let previous: Uint8Array;
  try {
    previous = new Uint8Array(await (await file.getFile()).arrayBuffer());
  } catch (error) {
    throw new Error(`cannot read the previous content; refusing to overwrite (${errText(error)})`);
  }

  try {
    await workerWrite(path, bytes);
    await verifyContent(file, bytes);
  } catch (error) {
    let rollback: VaultRollbackResult = "failed";
    try {
      await workerWrite(path, previous);
      await verifyContent(file, previous);
      rollback = "restored";
    } catch {
      rollback = "failed";
    }
    throw new VaultWriteVerificationError(`vault write failed (${errText(error)}); rollback ${rollback}`, rollback, error);
  }
}

/** Worker経路での書き込み（直列化・タブ間ロック・旧内容保持・読み戻し検証・rollback）。 */
export function writeViaWorker(file: FileSystemFileHandle, content: WriteContent): Promise<void> {
  const bytes = toBytes(content);
  return enqueue(() => lockRunner(() => writeOnce(file, bytes)));
}

/**
 * ファイル1つ分の書き込みの共通入口。`createWritable`があれば従来どおり（Worker・読み戻し・ロックを使わない）。
 */
export async function writeFileHandleContent(file: FileSystemFileHandle, content: WriteContent): Promise<void> {
  if (hasNativeWritable(file)) {
    const writable = await file.createWritable();
    await writable.write(content as FileSystemWriteChunkType);
    await writable.close();
    return;
  }
  await writeViaWorker(file, content);
}

// ---------------------------------------------------------------------------
// 能力確認（createWritableが無いOPFSだけ）
// ---------------------------------------------------------------------------

/**
 * `createWritable`が無い環境で、Worker経路でVaultへ書けることを確認する（一時ファイルの書き込み・読み戻し・削除）。
 * 使えなければ`VaultWriterUnavailableError`を投げ、状態を"unavailable"にする（この間、`getVaultBackend()`はnullを返し、
 * 保存先は「未対応」になる＝connectedにならない）。`createWritable`がある環境では何もしない。
 * `root`は、OPFS Vaultのroot（骨組みのフォルダ作成後に呼ぶこと）。
 */
export async function checkOpfsWriter(root: FileSystemDirectoryHandle): Promise<void> {
  if (prototypeHasWritable()) return;
  if (writerState === "worker") return;
  let tsumugiDir: FileSystemDirectoryHandle | null = null;
  try {
    if (typeof root.resolve !== "function") throw new VaultWriterUnavailableError("FileSystemDirectoryHandle.resolve が使えません");
    getWorker(); // Workerを作れるか
    const info = await callWorker({ type: "info" });
    const detail = info.detail as { syncAccessHandle?: string } | undefined;
    if (!info.ok || detail?.syncAccessHandle !== "function") {
      throw new VaultWriterUnavailableError(`Worker内でcreateSyncAccessHandleを使えません（${detail?.syncAccessHandle ?? (info.error ? errText(info.error) : "不明")}）`);
    }
    tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: true });
    // 前回の一時ファイルが残っていれば削除する
    try {
      await tsumugiDir.removeEntry(SELFTEST_FILE);
    } catch {
      // 無ければ何もしない
    }
    const selftest = await tsumugiDir.getFileHandle(SELFTEST_FILE, { create: true });
    await writeViaWorker(selftest, "tsumugi-writer-selftest");
    try {
      await tsumugiDir.removeEntry(SELFTEST_FILE);
    } catch {
      // 削除に失敗しても、次回の確認で削除する（書き込み自体は確認できている）
    }
    writerState = "worker";
  } catch (error) {
    writerState = "unavailable";
    if (tsumugiDir) {
      try {
        await tsumugiDir.removeEntry(SELFTEST_FILE);
      } catch {
        // no-op
      }
    }
    if (error instanceof VaultWriterUnavailableError) throw error;
    throw new VaultWriterUnavailableError(`OPFSへの書き込み方式を確認できません（${errText(error)}）`, error);
  }
}
