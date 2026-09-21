/**
 * OPFS書き込みプローブ（一時的な、診断専用の機能。iPhone Safari等で`createWritable`が無い環境向けの
 * 書き込み方式の実機検証用）。
 *
 * 目的：Dedicated Worker + `createSyncAccessHandle`によるOPFS書き込みが、実機で成立するかを確認する。
 *
 * 【安全性】
 * - 使うのは、OPFS rootの直下に作るプローブ専用フォルダ（`PROBE_DIR`）だけ。Tsumugiの`.tsumugi`・`Memories`・
 *   `Conversations`等のVaultには一切触れない（読まず、書かず、消さない）。
 * - Conversation・Memory・APIキー・設定は読まない（IndexedDBにも触れない）。
 * - ボタンを押すまで何も書かない（このモジュールの関数は、呼ばれたときだけ動く）。
 * - 終了時に、プローブ専用フォルダを削除する（失敗時も、可能な限り削除を試みる）。
 * - ネットワーク通信・localStorage等への保存は行わない。
 *
 * Tsumugi本体のVault書き込み方式は、このファイルでは変更しない（本体はこのモジュールをimportしない）。
 */

/** OPFS root直下の、プローブ専用フォルダ名（固定。前回のプローブが中断して残っていても検出・削除できる）。 */
export const PROBE_DIR = "__tsumugi_write_probe__";

const WORKER_CALL_TIMEOUT_MS = 8000;
const FILE_MAIN = "probe-main.txt";
const FILE_HOLD = "probe-hold.txt";
const FILE_HANDLE = "probe-handle.txt";
const TEXT_1 = "probe-1:0123456789";
const TEXT_2 = "probe-2:こんにちは-Tsumugi-0123456789abcdef";
const TEXT_HOLD = "probe-hold:held-open-content";
const TEXT_HANDLE = "probe-handle:written-via-transferred-handle";

/**
 * Dedicated Workerで実行するコード（Blob URLから起動する）。プローブ専用の操作だけを持つ。
 * 各メッセージは`{id, type, ...}`で、応答は`{id, ok, detail?, error?: {name, message}}`。
 */
export const PROBE_WORKER_SOURCE = `
"use strict";
let held = null;
const encoder = new TextEncoder();
function errOf(e) { return { name: (e && e.name) || "Error", message: String((e && e.message) || e) }; }
async function openByPath(path) {
  let dir = await navigator.storage.getDirectory();
  for (let i = 0; i < path.length - 1; i++) dir = await dir.getDirectoryHandle(path[i]);
  return dir.getFileHandle(path[path.length - 1]);
}
self.onmessage = async (event) => {
  const m = event.data;
  const id = m.id;
  const reply = (ok, detail, error) => self.postMessage({ id, ok, detail, error });
  try {
    switch (m.type) {
      case "info": {
        const detail = {
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
          storageGetDirectory: typeof navigator !== "undefined" && navigator.storage ? typeof navigator.storage.getDirectory : "no navigator.storage",
          syncAccessHandle: typeof FileSystemFileHandle !== "undefined" ? typeof FileSystemFileHandle.prototype.createSyncAccessHandle : "no FileSystemFileHandle",
          createWritable: typeof FileSystemFileHandle !== "undefined" ? typeof FileSystemFileHandle.prototype.createWritable : "no FileSystemFileHandle",
        };
        try { await navigator.storage.getDirectory(); detail.getDirectoryWorks = true; } catch (e) { detail.getDirectoryWorks = false; detail.getDirectoryError = errOf(e); }
        reply(true, detail);
        break;
      }
      case "writeSequence": {
        const file = await openByPath(m.path);
        const steps = [];
        const access = await file.createSyncAccessHandle();
        try {
          steps.push({ op: "getSize(new)", size: access.getSize() });
          const a = encoder.encode(m.text1);
          steps.push({ op: "write(text1)", written: access.write(a, { at: 0 }) });
          access.flush();
          steps.push({ op: "getSize(after write)", size: access.getSize(), expected: a.byteLength });
          access.truncate(5);
          steps.push({ op: "truncate(5)", size: access.getSize(), expected: 5 });
          const b = encoder.encode(m.text2);
          steps.push({ op: "write(text2)", written: access.write(b, { at: 0 }) });
          access.flush();
          steps.push({ op: "getSize(final)", size: access.getSize(), expected: b.byteLength });
        } finally {
          access.close();
        }
        reply(true, { steps });
        break;
      }
      case "openHold": {
        const file = await openByPath(m.path);
        const access = await file.createSyncAccessHandle();
        try {
          const a = encoder.encode(m.text);
          access.truncate(0);
          access.write(a, { at: 0 });
          access.flush();
        } catch (e) { access.close(); throw e; }
        held = { access, expected: encoder.encode(m.text).byteLength };
        reply(true, { size: access.getSize() });
        break;
      }
      case "secondOpen": {
        const file = await openByPath(m.path);
        try {
          const second = await file.createSyncAccessHandle();
          second.close();
          reply(true, { secondOpen: "succeeded" });
        } catch (e) {
          reply(true, { secondOpen: "failed", error: errOf(e) });
        }
        break;
      }
      case "closeHold": {
        if (!held) { reply(false, null, { name: "Error", message: "no held handle" }); break; }
        held.access.flush();
        held.access.close();
        held = null;
        reply(true, {});
        break;
      }
      case "writeHandle": {
        const access = await m.handle.createSyncAccessHandle();
        try {
          const a = encoder.encode(m.text);
          access.truncate(0);
          access.write(a, { at: 0 });
          access.flush();
        } finally {
          access.close();
        }
        reply(true, {});
        break;
      }
      default:
        reply(false, null, { name: "Error", message: "unknown message type: " + m.type });
    }
  } catch (e) {
    reply(false, null, errOf(e));
  }
};
`;

// ---------------------------------------------------------------------------
// 環境（テストで差し替える）
// ---------------------------------------------------------------------------

export interface ProbeWorkerClient {
  call(message: Record<string, unknown>): Promise<{ ok: boolean; detail?: unknown; error?: { name: string; message: string } }>;
  terminate(): void;
}

export interface ProbeEnv {
  getOpfsRoot: (() => Promise<FileSystemDirectoryHandle>) | null;
  /** Workerを作れない環境ではnull。 */
  createWorker: ((source: string) => ProbeWorkerClient) | null;
  /** 画面表示用の、実行環境の情報（型の文字列だけ）。 */
  features: Record<string, string>;
}

export function defaultProbeEnv(): ProbeEnv {
  const typeOf = (fn: () => unknown): string => {
    try {
      return typeof fn();
    } catch (error) {
      return `error:${error instanceof Error ? error.name : "unknown"}`;
    }
  };
  const features: Record<string, string> = {
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    Worker: typeof Worker,
    Blob: typeof Blob,
    "URL.createObjectURL": typeof URL !== "undefined" ? typeof URL.createObjectURL : "no URL",
    "navigator.storage.getDirectory": typeOf(() => navigator.storage.getDirectory),
    FileSystemFileHandle: typeof FileSystemFileHandle,
    "FileSystemFileHandle.prototype.createWritable": typeOf(() => FileSystemFileHandle.prototype.createWritable),
    "FileSystemFileHandle.prototype.createSyncAccessHandle(main thread)": typeOf(
      () => (FileSystemFileHandle.prototype as unknown as { createSyncAccessHandle?: unknown }).createSyncAccessHandle
    ),
    "FileSystemDirectoryHandle.prototype.resolve": typeOf(() => FileSystemDirectoryHandle.prototype.resolve),
  };
  const canWorker = typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  return {
    getOpfsRoot: typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function" ? () => navigator.storage.getDirectory() : null,
    createWorker: canWorker ? (source) => makeWorkerClient(source) : null,
    features,
  };
}

function makeWorkerClient(source: string): ProbeWorkerClient {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url);
  let nextId = 1;
  const pending = new Map<number, (reply: { ok: boolean; detail?: unknown; error?: { name: string; message: string } }) => void>();
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as { id: number; ok: boolean; detail?: unknown; error?: { name: string; message: string } };
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
      return new Promise((resolve, reject) => {
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
          reject(error); // DataCloneError等。呼び出し元が、ハンドル転送の可否として記録する
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
// プローブ本体
// ---------------------------------------------------------------------------

export interface ProbeStep {
  name: string;
  /** true=成功 / false=失敗 / null=情報のみ（成否の対象ではない） */
  ok: boolean | null;
  detail: string;
  ms: number;
}

export interface ProbeResult {
  features: Record<string, string>;
  steps: ProbeStep[];
  /** 画面に出す、要点の判定。 */
  summary: {
    workerStarts: boolean | null;
    workerGetDirectory: boolean | null;
    syncAccessHandleInWorker: string | null;
    resolve: boolean | null;
    handleTransfer: boolean | null;
    pathWrite: boolean | null;
    truncateFlushClose: boolean | null;
    readBackMatches: boolean | null;
    getFileWhileOpen: string | null;
    secondOpenWhileOpen: string | null;
    handleWrite: boolean | null;
    cleanup: boolean | null;
  };
}

/** 応答しない呼び出し（例：書き込み中のロックで待たされるgetFile）で、プローブ全体が止まらないようにする。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`no response within ${ms}ms`), { name: "Timeout" })), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function errText(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { name?: string; message?: string };
    return `${e.name ?? "Error"}: ${e.message ?? String(error)}`;
  }
  return String(error);
}

async function dirExists(root: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await root.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && (error as { name?: string }).name === "NotFoundError") return false;
    throw error;
  }
}

/** 実際のプローブ。ボタンを押したときだけ呼ばれる。例外は投げず、失敗はstepに記録する。 */
export async function runOpfsWriteProbe(env: ProbeEnv = defaultProbeEnv()): Promise<ProbeResult> {
  const steps: ProbeStep[] = [];
  const summary: ProbeResult["summary"] = {
    workerStarts: null,
    workerGetDirectory: null,
    syncAccessHandleInWorker: null,
    resolve: null,
    handleTransfer: null,
    pathWrite: null,
    truncateFlushClose: null,
    readBackMatches: null,
    getFileWhileOpen: null,
    secondOpenWhileOpen: null,
    handleWrite: null,
    cleanup: null,
  };
  const result: ProbeResult = { features: env.features, steps, summary };

  async function step<T>(name: string, fn: () => Promise<{ ok: boolean | null; detail: string; value?: T }>): Promise<T | undefined> {
    const start = Date.now();
    try {
      const r = await fn();
      steps.push({ name, ok: r.ok, detail: r.detail, ms: Date.now() - start });
      return r.value;
    } catch (error) {
      steps.push({ name, ok: false, detail: errText(error), ms: Date.now() - start });
      return undefined;
    }
  }

  if (!env.getOpfsRoot) {
    steps.push({ name: "OPFS root", ok: false, detail: "navigator.storage.getDirectory が使えません", ms: 0 });
    return result;
  }
  const root = await env.getOpfsRoot();
  let probeDir: FileSystemDirectoryHandle | null = null;
  let worker: ProbeWorkerClient | null = null;

  try {
    // --- 1. 前回の残りがあれば、プローブ専用フォルダだけを削除し、新しく作る（Tsumugi Vaultには触れない） ---
    await step("プローブ専用フォルダの準備（前回の残りは削除）", async () => {
      let removedLeftover = false;
      if (await dirExists(root, PROBE_DIR)) {
        await root.removeEntry(PROBE_DIR, { recursive: true });
        removedLeftover = true;
      }
      probeDir = await root.getDirectoryHandle(PROBE_DIR, { create: true });
      return { ok: true, detail: `${PROBE_DIR}/ を作成${removedLeftover ? "（前回の残りを削除済み）" : ""}` };
    });
    if (!probeDir) return result;
    const dir = probeDir as FileSystemDirectoryHandle;

    const mainFile = await dir.getFileHandle(FILE_MAIN, { create: true });
    const holdFile = await dir.getFileHandle(FILE_HOLD, { create: true });
    const handleFile = await dir.getFileHandle(FILE_HANDLE, { create: true });
    steps.push({ name: "main threadでの新規ファイル作成(getFileHandle create:true)", ok: true, detail: `${FILE_MAIN}, ${FILE_HOLD}, ${FILE_HANDLE}`, ms: 0 });

    // --- 2. root.resolve ---
    let resolvedPath: string[] | null = null;
    await step("root.resolve(fileHandle)", async () => {
      if (typeof root.resolve !== "function") {
        summary.resolve = false;
        return { ok: false, detail: "resolve が使えません" };
      }
      resolvedPath = await root.resolve(mainFile);
      const okPath = Array.isArray(resolvedPath) && resolvedPath.length === 2 && resolvedPath[0] === PROBE_DIR && resolvedPath[1] === FILE_MAIN;
      summary.resolve = okPath;
      return { ok: okPath, detail: `path=${JSON.stringify(resolvedPath)}` };
    });
    const knownPath = [PROBE_DIR, FILE_MAIN];
    const pathForWorker = summary.resolve && resolvedPath ? (resolvedPath as string[]) : knownPath;

    // --- 3. Worker ---
    if (!env.createWorker) {
      steps.push({ name: "Worker起動", ok: false, detail: "Worker / Blob URL が使えません", ms: 0 });
      summary.workerStarts = false;
      return result;
    }
    try {
      worker = env.createWorker(PROBE_WORKER_SOURCE);
      summary.workerStarts = true;
    } catch (error) {
      summary.workerStarts = false;
      steps.push({ name: "Worker起動", ok: false, detail: errText(error), ms: 0 });
      return result;
    }
    const w = worker;

    await step("Worker内の環境（navigator.storage.getDirectory / createSyncAccessHandle の型）", async () => {
      const r = await w.call({ type: "info" });
      if (!r.ok) {
        summary.workerStarts = false;
        return { ok: false, detail: r.error ? errText(r.error) : "failed" };
      }
      const d = r.detail as { userAgent: string; storageGetDirectory: string; syncAccessHandle: string; createWritable: string; getDirectoryWorks: boolean; getDirectoryError?: unknown };
      summary.workerGetDirectory = d.getDirectoryWorks;
      summary.syncAccessHandleInWorker = d.syncAccessHandle;
      return {
        ok: d.getDirectoryWorks && d.syncAccessHandle === "function",
        detail: `getDirectory=${d.storageGetDirectory}（呼び出し${d.getDirectoryWorks ? "成功" : "失敗:" + errText(d.getDirectoryError)}） / createSyncAccessHandle(Worker内)=${d.syncAccessHandle} / createWritable(Worker内)=${d.createWritable}`,
      };
    });
    if (summary.syncAccessHandleInWorker !== "function") return result;

    // --- 4. パス方式の書き込み（open→write→truncate→write→flush→close） ---
    await step("Workerでパス方式の書き込み（write/truncate/flush/close）", async () => {
      const r = await w.call({ type: "writeSequence", path: pathForWorker, text1: TEXT_1, text2: TEXT_2 });
      if (!r.ok) {
        summary.pathWrite = false;
        summary.truncateFlushClose = false;
        return { ok: false, detail: r.error ? errText(r.error) : "failed" };
      }
      const d = r.detail as { steps: { op: string; size?: number; written?: number; expected?: number }[] };
      const bad = d.steps.filter((s) => s.expected !== undefined && s.size !== s.expected);
      summary.pathWrite = true;
      summary.truncateFlushClose = bad.length === 0;
      return { ok: bad.length === 0, detail: d.steps.map((s) => `${s.op}:${s.size ?? s.written}${s.expected !== undefined ? `(期待${s.expected})` : ""}`).join(" / ") };
    });

    // --- 5. Worker終了前・後の、main threadからの読み戻し ---
    const readBack = async (file: FileSystemFileHandle, expected: string): Promise<{ ok: boolean; detail: string }> => {
      const f = await file.getFile();
      const text = await f.text();
      const expectedBytes = new TextEncoder().encode(expected).byteLength;
      const ok = text === expected && f.size === expectedBytes;
      return { ok, detail: `サイズ${f.size}（期待${expectedBytes}）/ 内容${text === expected ? "一致" : "不一致"}` };
    };
    await step("close後、main threadのgetFileで読み戻し（Worker稼働中）", async () => {
      const r = await readBack(mainFile, TEXT_2);
      summary.readBackMatches = r.ok;
      return r;
    });

    // --- 6. 書き込み中（同期ハンドルを開いたまま）のmain threadのgetFileと、2つ目のopen ---
    await step("同期ハンドルを開いたまま保持（Worker）", async () => {
      const r = await w.call({ type: "openHold", path: [PROBE_DIR, FILE_HOLD], text: TEXT_HOLD });
      return { ok: r.ok, detail: r.ok ? `size=${(r.detail as { size: number }).size}` : r.error ? errText(r.error) : "failed" };
    });
    await step("保持中：main threadのgetFile()の挙動", async () => {
      try {
        const f = await withTimeout(holdFile.getFile(), WORKER_CALL_TIMEOUT_MS);
        const text = await withTimeout(f.text(), WORKER_CALL_TIMEOUT_MS);
        summary.getFileWhileOpen = `成功（サイズ${f.size}、内容${text === TEXT_HOLD ? "一致" : "不一致"}）`;
        return { ok: null, detail: summary.getFileWhileOpen };
      } catch (error) {
        summary.getFileWhileOpen = `失敗（${errText(error)}）`;
        return { ok: null, detail: summary.getFileWhileOpen };
      }
    });
    await step("保持中：同じファイルへ2つ目のcreateSyncAccessHandle", async () => {
      const r = await w.call({ type: "secondOpen", path: [PROBE_DIR, FILE_HOLD] });
      const d = r.detail as { secondOpen?: string; error?: { name: string; message: string } } | undefined;
      summary.secondOpenWhileOpen = r.ok && d ? (d.secondOpen === "failed" ? `失敗（${d.error ? errText(d.error) : ""}）` : "成功（排他されない）") : "不明";
      return { ok: null, detail: summary.secondOpenWhileOpen };
    });
    await step("保持を解除（flush/close）→ main threadで読み戻し", async () => {
      const c = await w.call({ type: "closeHold" });
      if (!c.ok) return { ok: false, detail: c.error ? errText(c.error) : "closeに失敗" };
      const r = await readBack(holdFile, TEXT_HOLD);
      return r;
    });

    // --- 7. FileSystemHandleのpostMessage転送 ---
    await step("FileSystemFileHandleをWorkerへpostMessageで転送 → Workerで書き込み", async () => {
      try {
        const r = await w.call({ type: "writeHandle", handle: handleFile, text: TEXT_HANDLE });
        if (!r.ok) {
          summary.handleTransfer = true; // 転送自体は成功（Worker側の処理が失敗）
          summary.handleWrite = false;
          return { ok: false, detail: `転送は成功 / Workerでの書き込みに失敗: ${r.error ? errText(r.error) : ""}` };
        }
        summary.handleTransfer = true;
        const rb = await readBack(handleFile, TEXT_HANDLE);
        summary.handleWrite = rb.ok;
        return { ok: rb.ok, detail: `転送成功 / ${rb.detail}` };
      } catch (error) {
        summary.handleTransfer = false;
        summary.handleWrite = false;
        return { ok: false, detail: `転送に失敗: ${errText(error)}` };
      }
    });

    // --- 8. Worker終了後の読み戻し ---
    w.terminate();
    worker = null;
    await step("Worker終了後、main threadで再度読み戻し", async () => {
      const a = await readBack(mainFile, TEXT_2);
      const b = await readBack(holdFile, TEXT_HOLD);
      return { ok: a.ok && b.ok, detail: `main: ${a.detail} / hold: ${b.detail}` };
    });
  } finally {
    if (worker) {
      try {
        (worker as ProbeWorkerClient).terminate();
      } catch {
        // no-op
      }
    }
    // --- 9. cleanup：プローブ専用フォルダだけを削除する ---
    await step("cleanup（プローブ専用フォルダの削除と確認）", async () => {
      if (!(await dirExists(root, PROBE_DIR))) return { ok: true, detail: "作成されていません（削除するものなし）" };
      await root.removeEntry(PROBE_DIR, { recursive: true });
      const stillThere = await dirExists(root, PROBE_DIR);
      summary.cleanup = !stillThere;
      return { ok: !stillThere, detail: stillThere ? "削除後も残っています" : `${PROBE_DIR}/ を削除しました` };
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

const yn = (v: boolean | null) => (v === null ? "未確認" : v ? "可" : "不可");

export function renderProbeText(result: ProbeResult): string {
  const s = result.summary;
  const out: string[] = [];
  out.push("OPFS書き込みプローブ（Dedicated Worker + createSyncAccessHandle）");
  out.push(`プローブ専用フォルダ: ${PROBE_DIR}/（Tsumugi Vaultには触れていません）`);
  out.push("\n■ 要点");
  out.push(`Workerの起動: ${yn(s.workerStarts)}`);
  out.push(`Worker内の navigator.storage.getDirectory(): ${yn(s.workerGetDirectory)}`);
  out.push(`Worker内の createSyncAccessHandle の型: ${s.syncAccessHandleInWorker ?? "未確認"}`);
  out.push(`root.resolve(fileHandle): ${yn(s.resolve)}`);
  out.push(`FileSystemHandleのpostMessage転送: ${yn(s.handleTransfer)}`);
  out.push(`パス方式の新規書き込み: ${yn(s.pathWrite)}`);
  out.push(`truncate / flush / close（サイズ検証）: ${yn(s.truncateFlushClose)}`);
  out.push(`main threadでの読み戻し（内容・サイズ一致）: ${yn(s.readBackMatches)}`);
  out.push(`ハンドル保持中のmain thread getFile(): ${s.getFileWhileOpen ?? "未確認"}`);
  out.push(`ハンドル保持中の2つ目のopen: ${s.secondOpenWhileOpen ?? "未確認"}`);
  out.push(`転送したハンドルでの書き込み: ${yn(s.handleWrite)}`);
  out.push(`cleanup（専用フォルダの削除）: ${yn(s.cleanup)}`);
  out.push("\n■ 環境");
  for (const [key, value] of Object.entries(result.features)) out.push(`${key}: ${value}`);
  out.push("\n■ 手順ごとの結果");
  for (const step of result.steps) {
    const mark = step.ok === null ? "・" : step.ok ? "✓" : "✗";
    out.push(`${mark} ${step.name}（${step.ms}ms）`);
    out.push(`    ${step.detail}`);
  }
  return out.join("\n");
}
