/**
 * 保存先の汎用修復 段階2：バックアップ（docs/vault-repair-design.md §3・§8）。
 *
 * 端末（IndexedDB）と保存先（Vault）の両方を1つのZIPへ退避し、作れたことではなく「中身が完全で、書いたものを読み戻して照合できた」ことを
 * 成功の条件にする。
 *
 * - 端末側：会話・Memory・Source・Outbox（保存待ち・保留中の記録を含む）・ledger・Vault identity・migration journal・settingsを、
 *   1つのreadonly transactionで読む（db.tsの`readBackupDeviceSnapshot`）。認証情報（APIキー等）は含めない。
 * - 保存先側：見えるフォルダの全Markdown（場所を問わない）と、`.tsumugi/`・`.tsumugi-archive/`の全ファイルを、バイト単位でそのまま。
 *   端末と保存先で内容が違う記録（競合する版）は、両方の版がそのまま入る。どちらも選ばない・まとめない。
 * - 一貫性：保存ロックは取らない（保存を止めない）。保存先を読む前後で端末の保存の進行状況（Outbox＋ledger）を比べ、変わっていたら
 *   読み直す（有限回）。最後まで落ち着かなければ失敗（もう一度試せる）として返す。保存の途中（Markdownは書けたがOutboxはまだpending）を
 *   読んだ場合も、その記録の端末の版とOutboxが一緒に入るため、何も失われない。world lockは読む間だけ共有モードで持つ。
 * - 書き込み：保存先の`.tsumugi/repair-backup/`に、新しい名前のファイルを作るだけ（既存のファイルは開かない・上書きしない・消さない）。
 *   ZIPを書いて読み戻し、全エントリのハッシュ・件数・保存待ちの記録の有無を照合できたときだけ、`<runId>.verified.json`を書いて成功にする。
 *   照合できなかったZIPには`.verified.json`が無いため、後の修復（段階3）は使わない。
 * - 読めないファイルが1つでもあれば、不完全なバックアップを成功にしない（どの段階で何件かだけを返す。本文・パスは出さない）。
 */
import {
  BACKUP_DEVICE_STORES,
  BACKUP_STORE_OF_RECORD_TYPE,
  type BackupDeviceSnapshot,
  type BackupDeviceStore,
} from "./db";
import { writeFileHandleContent } from "./vaultWriter";
import { createZipBytes, readZipEntries, ZipFormatError, type ZipEntryInput } from "./zip";

export const BACKUP_FORMAT = "tsumugi-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_DIR = ".tsumugi/repair-backup";
const MAX_FILES = 20000;
const MAX_DEPTH = 64;

export interface BackupSummary {
  conversations: number;
  memories: number;
  sources: number;
  /** Outboxで保存待ち（pending）・保留（held）の記録。端末の版がバックアップに入っていることを照合済み */
  pendingSaves: number;
  heldSaves: number;
  /** 保存待ち・保留のentryのうち、記録そのものが端末に無いもの（Outboxだけが残った状態）。entryはそのまま退避する */
  unsavedWithoutRecord: number;
  vaultFiles: number;
  vaultBytes: number;
  excludedCredentialKeys: number;
}
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  runId: string;
  createdAt: string;
  build: string;
  backend: string;
  vaultId: string | null;
  summary: BackupSummary;
  /** 保存待ち・保留の記録（`recordType:recordId`・Outboxが指す版・その記録の端末の版がバックアップに入っているか） */
  unsavedRecords: { outboxId: string; status: string; recordUpdatedAt: string; recordInBackup: boolean }[];
  device: { stores: Record<string, { count: number; path: string }>; handleKeys: string[] };
  /** manifest以外の全エントリ（ZIP内のパス・大きさ・SHA-256） */
  entries: { path: string; size: number; sha256: string }[];
}

export type BackupFailureReason =
  | "busy" // 保存が続いていて、落ち着いた状態を読めなかった（もう一度試せる）
  | "unreadable" // 読めないファイルがあった（もう一度試せる）
  | "too-large"
  | "not-serializable"
  | "verify-failed" // 書いたものを読み戻して照合できなかった
  | "write-failed"
  | "cancelled"
  | "error";
export type BackupResult =
  | { ok: true; runId: string; path: string; size: number; sha256: string; summary: BackupSummary; zip: Uint8Array }
  | { ok: false; reason: BackupFailureReason; retryable: boolean; count?: number };

export interface VaultBackupEnv {
  root: FileSystemDirectoryHandle;
  readDevice(): Promise<BackupDeviceSnapshot>;
  /** world lockの共有モード（保存と同時に持てる。保存ロックは取らない）。読む間だけ持ち、書き込み・照合の間は持たない */
  withWorldRead<T>(fn: () => Promise<T>): Promise<T>;
  now(): string;
  runId(): string;
  build: string;
  backend: string;
  sleep(ms: number): Promise<void>;
  isCancelled?(): boolean;
}
export interface BackupOptions { attempts?: number; retryDelayMs?: number }

class BackupError extends Error {
  constructor(public readonly reason: BackupFailureReason, public readonly retryable: boolean, public readonly count?: number) { super(reason); this.name = "BackupError"; }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 保存の進行状況：Outboxの各entryの状態と対象の版、ledger。試行回数・時刻（再試行のたびに変わる）は比べない */
export function saveProgressKey(device: BackupDeviceSnapshot): string {
  const outbox = device.stores.vaultOutbox.map((row) => {
    const e = row.value as { id?: unknown; status?: unknown; recordUpdatedAt?: unknown };
    return `${String(e.id)}|${String(e.status)}|${String(e.recordUpdatedAt)}`;
  }).sort();
  const ledger = device.stores.vaultSyncState.map((row) => `${String(row.key)}=${String(row.value)}`).sort();
  return JSON.stringify([outbox, ledger]);
}

/** バックアップに入れる保存先のファイル：見えるフォルダのMarkdownと、Tsumugiの隠しフォルダの全ファイル（自分のバックアップ置き場は除く） */
export function isBackedUpVaultPath(path: string): boolean {
  if (path === BACKUP_DIR || path.startsWith(BACKUP_DIR + "/")) return false;
  if (path.startsWith(".tsumugi/") || path.startsWith(".tsumugi-archive/")) return true;
  return !path.split("/").some((part) => part.startsWith(".")) && path.toLowerCase().endsWith(".md");
}

/** 保存先のファイルをバイト単位で読む。読めないファイルがあれば件数を付けて失敗（一部だけのバックアップは作らない） */
async function readVaultFiles(root: FileSystemDirectoryHandle, isCancelled: () => boolean): Promise<{ path: string; data: Uint8Array }[]> {
  const files: { path: string; data: Uint8Array }[] = [];
  let unreadable = 0;
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new BackupError("too-large", false);
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (isCancelled()) throw new BackupError("cancelled", true);
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        // 自分のバックアップ置き場には入らない。Tsumugiの隠しフォルダ（`.tsumugi/`・`.tsumugi-archive/`）の中は、隠しフォルダも含めて全部入る。
        // それ以外の隠しフォルダ（.obsidian・.trash等、Tsumugiのものではない）には入らない
        if (path === BACKUP_DIR) continue;
        const insideTsumugi = path.startsWith(".tsumugi/") || path.startsWith(".tsumugi-archive/");
        if (name.startsWith(".") && !insideTsumugi && !(prefix === "" && (name === ".tsumugi" || name === ".tsumugi-archive"))) continue;
        await walk(handle as FileSystemDirectoryHandle, path, depth + 1);
        continue;
      }
      if (!isBackedUpVaultPath(path)) continue;
      if (files.length + unreadable >= MAX_FILES) throw new BackupError("too-large", false);
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        files.push({ path, data: new Uint8Array(await file.arrayBuffer()) });
      } catch {
        unreadable++;
      }
    }
  };
  try {
    await walk(root, "", 0);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("unreadable", true, unreadable + 1);   // フォルダ自体を一覧できなかった
  }
  if (unreadable > 0) throw new BackupError("unreadable", true, unreadable);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** IndexedDBの値をJSONへ。JSONで表せない値（Date・Blob・関数・循環等）があれば失敗（黙って欠けたバックアップを作らない） */
function toJson(value: unknown): string {
  const check = (v: unknown, seen: Set<object>): void => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") { if (!Number.isFinite(v)) throw new BackupError("not-serializable", false); return; }
    if (typeof v === "undefined") return;   // オブジェクトのundefinedはIndexedDBでも「無い」と同じ
    if (typeof v !== "object") throw new BackupError("not-serializable", false);
    if (seen.has(v)) throw new BackupError("not-serializable", false);
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new BackupError("not-serializable", false);
    seen.add(v);
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (Array.isArray(v) && typeof child === "undefined") throw new BackupError("not-serializable", false);
      check(child, seen);
    }
    seen.delete(v);
  };
  check(value, new Set());
  return JSON.stringify(value);
}

const devicePath = (store: string) => `device/${store}.json`;
const vaultPath = (path: string) => `vault/${path}`;

type OutboxLike = { id: string; status: string; recordType: string; recordId: string; recordUpdatedAt: string };
/** Outboxのentryが指す記録（端末の版）が、端末データの中にあるか */
function recordPresent(stores: Record<BackupDeviceStore, { value: unknown }[]>, e: OutboxLike): boolean {
  const store = BACKUP_STORE_OF_RECORD_TYPE[e.recordType];
  const rows = store ? stores[store] : BACKUP_DEVICE_STORES.flatMap((name) => stores[name]);
  return rows.some((row) => (row.value as { id?: unknown } | null)?.id === e.recordId);
}
function unsavedOf(stores: Record<BackupDeviceStore, { value: unknown }[]>): BackupManifest["unsavedRecords"] {
  return stores.vaultOutbox
    .map((row) => row.value as OutboxLike)
    .filter((e) => e.status !== "done")
    .map((e) => ({ outboxId: e.id, status: e.status, recordUpdatedAt: e.recordUpdatedAt, recordInBackup: recordPresent(stores, e) }))
    .sort((a, b) => (a.outboxId < b.outboxId ? -1 : 1));
}

/** ZIPの中身（manifestを含む）を組み立てる。純粋関数 */
export async function buildBackupEntries(
  device: BackupDeviceSnapshot,
  vault: { path: string; data: Uint8Array }[],
  meta: { runId: string; createdAt: string; build: string; backend: string }
): Promise<{ entries: ZipEntryInput[]; manifest: BackupManifest }> {
  const encoder = new TextEncoder();
  const body: { path: string; data: Uint8Array }[] = [];
  const stores: BackupManifest["device"]["stores"] = {};
  for (const name of BACKUP_DEVICE_STORES) {
    const rows = device.stores[name];
    body.push({ path: devicePath(name), data: encoder.encode(toJson(rows)) });
    stores[name] = { count: rows.length, path: devicePath(name) };
  }
  let vaultBytes = 0;
  for (const file of vault) { body.push({ path: vaultPath(file.path), data: file.data }); vaultBytes += file.data.byteLength; }
  const unsavedRecords = unsavedOf(device.stores);
  const identity = device.stores.vaultIdentity[0]?.value as { vaultId?: unknown } | undefined;
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    runId: meta.runId,
    createdAt: meta.createdAt,
    build: meta.build,
    backend: meta.backend,
    vaultId: typeof identity?.vaultId === "string" ? identity.vaultId : null,
    summary: {
      conversations: device.stores.conversations.length,
      memories: device.stores.memoryObjects.length,
      sources: device.stores.sources.length,
      pendingSaves: unsavedRecords.filter((r) => r.status === "pending").length,
      heldSaves: unsavedRecords.filter((r) => r.status === "held").length,
      unsavedWithoutRecord: unsavedRecords.filter((r) => !r.recordInBackup).length,
      vaultFiles: vault.length,
      vaultBytes,
      excludedCredentialKeys: device.excludedCredentialKeys,
    },
    unsavedRecords,
    device: { stores, handleKeys: [...device.handleKeys].sort() },
    entries: await Promise.all(body.map(async (e) => ({ path: e.path, size: e.data.byteLength, sha256: await sha256Hex(e.data) }))),
  };
  return { entries: [...body.map((e) => ({ path: e.path, content: e.data })), { path: "manifest.json", content: JSON.stringify(manifest, null, 1) }], manifest };
}

export type BackupVerification = { ok: true; manifest: BackupManifest } | { ok: false; problems: string[] };

/**
 * バックアップZIPを読み戻して照合する（READ ONLY・純粋）。ZIPの構造とCRC、manifestの全エントリの大きさ・SHA-256、余分なエントリが無いこと、
 * 端末データの件数、保存待ち・保留の記録の版が端末データに入っていること、を確かめる。`expected`を渡すと、そのmanifestと同じ内容かも確かめる。
 * 問題はコード（とZIP内のパス）だけで返し、本文は返さない。
 */
export async function verifyBackupZip(bytes: Uint8Array, expected?: BackupManifest): Promise<BackupVerification> {
  const problems: string[] = [];
  let entries: { path: string; data: Uint8Array }[];
  try { entries = readZipEntries(bytes); } catch (error) { return { ok: false, problems: [error instanceof ZipFormatError ? error.code : "zip-unreadable"] }; }
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  const manifestBytes = byPath.get("manifest.json");
  if (!manifestBytes) return { ok: false, problems: ["manifest-missing"] };
  let manifest: BackupManifest;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as BackupManifest; } catch { return { ok: false, problems: ["manifest-unreadable"] }; }
  if (manifest?.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION || !Array.isArray(manifest.entries)) return { ok: false, problems: ["manifest-format"] };
  if (expected && JSON.stringify(expected) !== JSON.stringify(manifest)) problems.push("manifest-differs");
  const listed = new Set<string>(["manifest.json"]);
  for (const entry of manifest.entries) {
    listed.add(entry.path);
    const data = byPath.get(entry.path);
    if (!data) { problems.push(`missing:${entry.path}`); continue; }
    if (data.byteLength !== entry.size || (await sha256Hex(data)) !== entry.sha256) problems.push(`hash:${entry.path}`);
  }
  for (const path of byPath.keys()) if (!listed.has(path)) problems.push(`unlisted:${path}`);
  const device = {} as Record<BackupDeviceStore, { key: unknown; value: unknown }[]>;
  for (const name of BACKUP_DEVICE_STORES) {
    const info = manifest.device?.stores?.[name];
    const data = byPath.get(devicePath(name));
    if (!info || !data) { problems.push(`device-missing:${name}`); device[name] = []; continue; }
    try {
      const rows = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as { key: unknown; value: unknown }[];
      if (!Array.isArray(rows) || rows.length !== info.count) problems.push(`device-count:${name}`);
      device[name] = Array.isArray(rows) ? rows : [];
    } catch { problems.push(`device-unreadable:${name}`); device[name] = []; }
  }
  // 保存待ち・保留の記録：Outboxのentryが全部manifestに載っていて、manifestが「入っている」とした記録（端末の版）が本当に端末データに入っていること
  const unsaved = device.vaultOutbox.map((row) => row.value as OutboxLike).filter((e) => e.status !== "done");
  const listedUnsaved = new Map((manifest.unsavedRecords ?? []).map((r) => [`${r.outboxId}|${r.status}|${r.recordUpdatedAt}`, r.recordInBackup]));
  if (listedUnsaved.size !== unsaved.length) problems.push("unsaved-count");
  for (const e of unsaved) {
    const claimed = listedUnsaved.get(`${e.id}|${e.status}|${e.recordUpdatedAt}`);
    if (claimed === undefined) { problems.push(`unsaved-unlisted:${e.id}`); continue; }
    if (claimed !== recordPresent(device, e)) problems.push(`unsaved-record-missing:${e.id}`);
  }
  const s = manifest.summary;
  if (!s || s.conversations !== device.conversations.length || s.memories !== device.memoryObjects.length || s.sources !== device.sources.length
    || s.pendingSaves !== unsaved.filter((e) => e.status === "pending").length || s.heldSaves !== unsaved.filter((e) => e.status === "held").length
    || s.unsavedWithoutRecord !== unsaved.filter((e) => !recordPresent(device, e)).length
    || s.vaultFiles !== manifest.entries.filter((e) => e.path.startsWith("vault/")).length) problems.push("summary-differs");
  return problems.length ? { ok: false, problems } : { ok: true, manifest };
}

async function dirFor(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of path.split("/")) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}
/**
 * 新しいファイルだけを作る。同じ名前が既にあれば何もせず失敗（既存のファイルは決して開かない・上書きしない）。書き込みは通常の保存と
 * 同じ共通の書き手（`createWritable`が無いiPhone Safari等ではWorker経路）を使う。
 */
async function writeNewFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array): Promise<FileSystemFileHandle> {
  let exists = true;
  try { await dir.getFileHandle(name, { create: false }); } catch { exists = false; }
  if (exists) throw new BackupError("write-failed", true);
  const handle = await dir.getFileHandle(name, { create: true });
  await writeFileHandleContent(handle, data);
  return handle;
}

/** 落ち着いた状態の端末データと保存先のファイルを読む（保存を止めずに、前後の保存の進行状況が同じになるまで有限回読み直す） */
async function readSettledSnapshot(env: VaultBackupEnv, options: Required<BackupOptions>) {
  const isCancelled = () => env.isCancelled?.() === true;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    if (attempt > 0) await env.sleep(options.retryDelayMs);
    if (isCancelled()) throw new BackupError("cancelled", true);
    // 読む間だけworld lockの共有モードを持つ（保存と同時に持てる。保存先の切替だけが、読み終わるまで待つ）
    const read = await env.withWorldRead(async () => {
      const before = await env.readDevice();
      const vault = await readVaultFiles(env.root, isCancelled);
      const after = await env.readDevice();
      return saveProgressKey(before) === saveProgressKey(after) ? { device: after, vault } : null;
    });
    if (read) return read;
  }
  throw new BackupError("busy", true);
}

/**
 * バックアップを作る：落ち着いた状態を読む → ZIPを組み立てて照合 → 保存先の`.tsumugi/repair-backup/<runId>.zip`へ新規作成 →
 * 読み戻して照合 → `<runId>.verified.json`を新規作成 → それも読み戻して照合。全部できたときだけ`ok: true`。
 */
export async function createVaultBackup(env: VaultBackupEnv, options: BackupOptions = {}): Promise<BackupResult> {
  const opts = { attempts: options.attempts ?? 3, retryDelayMs: options.retryDelayMs ?? 1500 };
  /** 1段階を実行し、想定外の失敗をその段階の理由に置き換える */
  const step = async <T>(reason: BackupFailureReason, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (error) { throw error instanceof BackupError ? error : new BackupError(reason, true); }
  };
  try {
    const { device, vault } = await readSettledSnapshot(env, opts);
    const runId = env.runId();
    const { entries, manifest } = await buildBackupEntries(device, vault, { runId, createdAt: env.now(), build: env.build, backend: env.backend });
    const zip = createZipBytes(entries);
    if (!(await verifyBackupZip(zip, manifest)).ok) throw new BackupError("verify-failed", false);
    const sha256 = await sha256Hex(zip);
    if (env.isCancelled?.()) throw new BackupError("cancelled", true);
    const dir = await step("write-failed", () => dirFor(env.root, BACKUP_DIR));
    const zipHandle = await step("write-failed", () => writeNewFile(dir, `${runId}.zip`, zip));
    // 読み戻し：書いたファイルをもう一度開き、バイト列のハッシュとZIPの中身の両方を照合する
    const readBack = await step("verify-failed", async () => new Uint8Array(await (await zipHandle.getFile()).arrayBuffer()));
    if ((await sha256Hex(readBack)) !== sha256 || !(await verifyBackupZip(readBack, manifest)).ok) throw new BackupError("verify-failed", true);
    const marker = new TextEncoder().encode(JSON.stringify({ format: BACKUP_FORMAT, runId, zip: `${runId}.zip`, size: zip.byteLength, sha256, verifiedAt: env.now(), summary: manifest.summary }, null, 1));
    const markerHandle = await step("write-failed", () => writeNewFile(dir, `${runId}.verified.json`, marker));
    const markerBack = await step("verify-failed", async () => new Uint8Array(await (await markerHandle.getFile()).arrayBuffer()));
    if ((await sha256Hex(markerBack)) !== (await sha256Hex(marker))) throw new BackupError("verify-failed", true);
    return { ok: true, runId, path: `${BACKUP_DIR}/${runId}.zip`, size: zip.byteLength, sha256, summary: manifest.summary, zip };
  } catch (error) {
    if (error instanceof BackupError) return { ok: false, reason: error.reason, retryable: error.retryable, ...(error.count !== undefined ? { count: error.count } : {}) };
    return { ok: false, reason: "error", retryable: true };
  }
}

/** 端末の外へ書き出したファイル（ユーザーが選び直したもの、または保存ダイアログで書いたもの）を、作ったバックアップと照合する */
export async function verifyExportedBackup(bytes: Uint8Array, expected: { sha256: string; size: number }): Promise<{ ok: boolean; reason?: "different-file" | "corrupt" }> {
  if (bytes.byteLength !== expected.size || (await sha256Hex(bytes)) !== expected.sha256) {
    // 別のファイルか、途中で欠けたファイル。中身がバックアップとして読めるかでどちらかを伝える
    const check = await verifyBackupZip(bytes);
    return { ok: false, reason: check.ok ? "different-file" : "corrupt" };
  }
  return (await verifyBackupZip(bytes)).ok ? { ok: true } : { ok: false, reason: "corrupt" };
}

/** 画面の文言（件数だけ。本文・ID・パスは出さない） */
export function backupSummaryText(s: BackupSummary): string {
  const parts = [`会話${s.conversations}件`, `Memory ${s.memories}件`];
  if (s.sources > 0) parts.push(`資料${s.sources}件`);
  parts.push(`保存先のファイル${s.vaultFiles}件`);
  const unsaved = s.pendingSaves + s.heldSaves;
  return parts.join("・") + (unsaved > 0 ? `（保存先へ未反映の記録${unsaved}件も含みます）` : "");
}
export function backupFailureText(result: Extract<BackupResult, { ok: false }>): string {
  switch (result.reason) {
    case "busy": return "保存の処理が続いていたため、バックアップを作れませんでした。少し待ってからもう一度お試しください。";
    case "unreadable": return `読み取れないファイルが${result.count ?? 1}件あったため、バックアップを完成させませんでした（一部だけのバックアップは作りません）。時間をおいてもう一度お試しください。`;
    case "too-large": return "ファイルが多すぎるため、バックアップを作れませんでした。";
    case "not-serializable": return "書き出せない形式のデータがあったため、バックアップを作れませんでした。";
    case "verify-failed": return "バックアップを書き込みましたが、読み戻して内容を確認できませんでした。このバックアップは使いません。もう一度お試しください。";
    case "write-failed": return "保存先にバックアップを書き込めませんでした。空き容量を確認して、もう一度お試しください。";
    case "cancelled": return "バックアップを中止しました。";
    default: return "バックアップを作れませんでした。もう一度お試しください。";
  }
}
