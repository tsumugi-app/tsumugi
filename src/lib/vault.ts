/**
 * Vault層。バックエンドは2種類ある。
 *
 * - PC（File System Access API）：ユーザーが`showDirectoryPicker()`で選んだ実フォルダ。
 * - スマホ（OPFS＝Origin Private File System）：`navigator.storage.getDirectory()`が返す、
 *   このオリジン専有の永続領域。File System Access APIが使えない環境（iOS/iPadOS Safari、
 *   Android Chrome等）でのみフォールバックとして使う。ユーザー操作・許可プロンプトは不要。
 *
 * どちらのバックエンドも同じ`FileSystemDirectoryHandle`標準インターフェースを実装しているため、
 * Vault層より下（書き込み・Rebuildability）のロジックは一切分岐しない。バックエンドの選択は
 * `getVaultBackend()`／`restoreVaultHandle()`の中だけに閉じる。
 *
 * STORAGE.md §1.2 Markdown First / §2.4 Rebuildability Guarantee に対応する。
 * ここで書き込むMarkdownファイルとVault内の `.tsumugi/` JSONが正（source of truth）であり、
 * IndexedDB（db.ts）は常にこの後に書き込まれる派生キャッシュとして扱う。
 */
"use client";

import { getAllConversations, getAllMemoryObjects, getAllSources, loadVaultHandle, saveVaultHandle } from "./db";
import { logTimingEvent } from "./debugTimingLog";
import type { Conversation, MemoryObject, Source } from "./types";
import {
  conversationToMarkdown,
  memoryObjectToMarkdown,
  parseConversationMarkdown,
  parseMemoryDayFile,
  parseSourceMarkdown,
  serializeMemoryDayFile,
  sourceToMarkdown,
} from "./markdown";

const VAULT_DIRS = ["Conversations", "Memories", "People", "Themes", "Emotions", "Goals", "Ideas", "Events", "Attachments"] as const;

export type VaultPermissionState = "granted" | "prompt" | "denied" | "unsupported" | "unset";

/** "file-system-access" = PCの既存Vault（最優先）。"opfs" = スマホ等でのフォールバック。 */
export type VaultBackend = "file-system-access" | "opfs";

function isFsAccessSupported() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

function isOpfsSupported() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage !== "undefined" &&
    typeof navigator.storage.getDirectory === "function"
  );
}

/**
 * このブラウザで実際に使えるVaultバックエンドを返す。File System Access APIが使えれば
 * 必ずそちらを優先する（PCで既にVaultを接続しているユーザーを、意図せずOPFSへ切り替えない
 * ため）。使えない場合のみOPFSへフォールバックする。どちらも使えなければnull。
 */
export function getVaultBackend(): VaultBackend | null {
  if (isFsAccessSupported()) return "file-system-access";
  if (isOpfsSupported()) return "opfs";
  return null;
}

async function verifyPermission(handle: FileSystemDirectoryHandle, forWrite: boolean): Promise<boolean> {
  const options: FileSystemHandlePermissionDescriptor = { mode: forWrite ? "readwrite" : "read" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return false;
}

/**
 * restoreVaultHandle()の結果。File System Access APIパスでは、保存済みhandleが
 * あってもreadwrite許可が切れていることがある（Android Chrome等、ページリロードのたびに
 * 許可がリセットされる既知の仕様。Chrome公式ドキュメントが明記する「ハンドル自体は
 * IndexedDBを介してリロードをまたいで有効だが、書き込みにはrequestPermission()の
 * 再呼び出しが必要」という挙動）。この場合、以前はhandleごと捨てて「この端末のみ」に
 * 黙ってfallbackしていたが、それではユーザーが「フォルダが消えた」と誤認する。
 * ここではhandleを捨てずに"needs-permission"として返し、呼び出し側（UI）が
 * 「以前のフォルダ名」を示した上で、ユーザー操作を経た再許可を促せるようにする。
 */
export type VaultRestoreResult =
  | { status: "connected"; handle: FileSystemDirectoryHandle }
  | { status: "needs-permission"; handle: FileSystemDirectoryHandle }
  | { status: "none" };

/**
 * 起動時に呼ぶ。ユーザー操作（クリック等）を伴わないため、File System Access APIパスでは
 * 許可の確認（queryPermission）までしか行わない。ここではrequestPermission()を
 * 絶対に呼ばない（ユーザージェスチャーが必要なAPIのため、起動時の自動処理からは
 * 意図的に分離する。再許可はrequestVaultPermission()を、ボタンクリック等の
 * ユーザー操作の文脈から呼び出す形にする）。
 *
 * OPFSパスでは、ユーザー操作も許可確認も不要（`navigator.storage.getDirectory()`は
 * オリジン専有領域を無条件に返す）。毎回同じルートを指すため、保存済みhandleの
 * 読み込み（loadVaultHandle）は行わない。初回アクセス時はensureVaultSkeleton()で
 * 骨組みを作る（既に存在する場合は何もしない、以後の起動でも安全に呼べる）。
 */
export async function restoreVaultHandle(): Promise<VaultRestoreResult> {
  const backend = getVaultBackend();
  if (backend === null) return { status: "none" };

  if (backend === "opfs") {
    const root = await navigator.storage.getDirectory();
    await ensureVaultSkeleton(root);
    return { status: "connected", handle: root };
  }

  const handle = await loadVaultHandle();
  if (!handle) return { status: "none" };
  const granted = await verifyPermission(handle, true);
  return granted ? { status: "connected", handle } : { status: "needs-permission", handle };
}

/**
 * 「アクセスを再許可」ボタンのクリックなど、明確なユーザージェスチャーの文脈からのみ
 * 呼び出すこと（requestPermission()の仕様上の制約）。新しいshowDirectoryPicker()は
 * 一切開かない。以前と同じhandle（＝同じフォルダ）に対して、readwrite許可だけを
 * 再度要求する。許可された場合のみtrueを返す。拒否・失敗時はfalseを返すのみで、
 * handle自体には一切触れない（IndexedDBの保存内容もそのまま残る）。
 */
export async function requestVaultPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const options: FileSystemHandlePermissionDescriptor = { mode: "readwrite" };
  const result = await handle.requestPermission(options);
  return result === "granted";
}

/**
 * ユーザーの明示的な操作（クリック）内から呼ぶ必要がある（showDirectoryPicker の仕様）。
 */
export async function chooseVaultDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isFsAccessSupported()) {
    throw new Error("このブラウザはFile System Access APIに対応していません。Chrome/Edgeでお試しください。");
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await ensureVaultSkeleton(handle);
  await saveVaultHandle(handle);
  return handle;
}

async function ensureVaultSkeleton(root: FileSystemDirectoryHandle) {
  for (const dir of VAULT_DIRS) {
    await root.getDirectoryHandle(dir, { create: true });
  }
  const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: true });
  await writeJSONIfMissing(tsumugiDir, "schema-version.json", { schemaVersion: "0.1" });
  await writeJSONIfMissing(tsumugiDir, "index.json", {});
}

async function writeJSONIfMissing(dir: FileSystemDirectoryHandle, name: string, value: unknown) {
  try {
    await dir.getFileHandle(name, { create: false });
  } catch {
    await writeFileInDir(dir, name, JSON.stringify(value, null, 2));
  }
}

async function writeFileInDir(dir: FileSystemDirectoryHandle, name: string, content: string) {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function readJSON<T>(dir: FileSystemDirectoryHandle, name: string, fallback: T): Promise<T> {
  try {
    const fileHandle = await dir.getFileHandle(name, { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Beta C2対応：Markdown/.tsumugiへの書き込みは「そのファイルを丸ごと読み込み→一部だけ
 * 差し替え→丸ごと書き戻す」というread-modify-writeを行う（day-file、.tsumugi/index.json共に）。
 * これをCapture・Connect・Reflection・Source保存・flushPendingToVaultなど複数の経路から
 * 並行に呼び出すと、後勝ちの書き込みが先勝ちの内容を丸ごと上書きし、データが消失する
 * （実機のwriteMemoryObjectMarkdownで再現・確認済み）。
 *
 * 対策として、Vault書き込みの実体（writeConversationMarkdown/writeSourceMarkdown/
 * writeMemoryObjectMarkdown）を、モジュールスコープの単一キューを通じて直列化する。
 * 呼び出し元がどのファイル・どの日付を書こうとしているかに関わらず、常に「1つの
 * read-modify-writeが完全に終わってから次が始まる」順序を保証する（同じファイルだけを
 * 対象にした細かいロックにしないのは、対象ファイルの特定自体に事前のI/Oが必要で
 * 複雑になるため。Vault書き込みは頻度が低く、全体を1本の列に直列化しても実用上の
 * 体感速度への影響は小さいと判断した）。
 *
 * AI呼び出し（Capture/ConnectのGemini API呼び出し）はこのキューに含めない。直列化するのは
 * 実際にファイルを読み書きする瞬間だけであり、Capture/Connect全体を待たせることはない。
 *
 * 1つの書き込みが失敗しても、キュー自体は次の書き込みへ進む（失敗を握りつぶさず、
 * 呼び出し元へは例外をそのまま伝播させた上で、キューの直列化は継続する）。
 */
let vaultWriteQueue: Promise<void> = Promise.resolve();

/**
 * TEMP-TEST：公開ベータで稀に発生する20〜40秒の異常遅延の原因切り分け用。
 * Vault書き込みキュー（vaultWriteQueue）のFIFO直列化そのものが、モバイルでの
 * 終了処理を待たせているのではないかという仮説を実測で検証するための、
 * enqueue時刻・実際のwrite開始時刻・完了時刻だけを出す最小限のログ。
 * 会話内容・Memory本文・ファイルパス・IDは一切出さない（件数・経過時間のみ）。
 * 原因調査が終わり次第削除すること。
 */
let vaultWriteSeq = 0;

function enqueueVaultWrite<T>(task: () => Promise<T>): Promise<T> {
  const seq = ++vaultWriteSeq;
  const enqueuedAt = Date.now();
  console.log(`[Vault] write:enqueue seq=${seq}`);
  logTimingEvent("Vault write:enqueue", { seq });

  const timedTask = async () => {
    const waitMs = Date.now() - enqueuedAt;
    console.log(`[Vault] write:start seq=${seq} waitMs=${waitMs}`);
    logTimingEvent("Vault write:start", { seq, waitMs });
    const startedAt = Date.now();
    try {
      return await task();
    } finally {
      const durationMs = Date.now() - startedAt;
      console.log(`[Vault] write:end seq=${seq} durationMs=${durationMs}`);
      logTimingEvent("Vault write:end", { seq, durationMs });
    }
  };

  const run = vaultWriteQueue.then(timedTask, timedTask);
  vaultWriteQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function updateIndex(root: FileSystemDirectoryHandle, id: string, relativePath: string) {
  const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: true });
  const index = await readJSON<Record<string, string>>(tsumugiDir, "index.json", {});
  index[id] = relativePath;
  await writeFileInDir(tsumugiDir, "index.json", JSON.stringify(index, null, 2));
}

function shortId(id: string) {
  return id.slice(-6).toLowerCase();
}

/** 旧形式（1 record = 1 file）のファイル名。Reflection/Summary（system-generated）はこの形式を維持する。 */
function fileNameFor(id: string, isoDate: string) {
  const datePart = isoDate.slice(0, 10);
  return `${datePart}-${shortId(id)}.md`;
}

/** 「1日1Markdown」（通常のMemory）のファイル名。同じ日のMemoryは全てこのファイルへ統合する。 */
function dayFileNameFor(isoDate: string) {
  return `${isoDate.slice(0, 10)}.md`;
}

async function writeConversationMarkdownImpl(root: FileSystemDirectoryHandle, conversation: Conversation) {
  const dir = await root.getDirectoryHandle("Conversations", { create: true });
  const fileName = fileNameFor(conversation.id, conversation.startedAt);
  await writeFileInDir(dir, fileName, conversationToMarkdown(conversation));
  await updateIndex(root, conversation.id, `Conversations/${fileName}`);
}

export function writeConversationMarkdown(root: FileSystemDirectoryHandle, conversation: Conversation) {
  return enqueueVaultWrite(() => writeConversationMarkdownImpl(root, conversation));
}

/**
 * Source基盤（最小構成）のVault保存。1 Source = 1 Markdown（既存のConversationと同じくfileNameFor、
 * Memoryの日別統合は適用しない。STORAGE.md §3）。`Sources/`が無ければ既存パターン通り
 * `{ create: true }`で作成する。SourceにはMemoryObjectのような`date`が無いため、`createdAt`を使う。
 */
async function writeSourceMarkdownImpl(root: FileSystemDirectoryHandle, source: Source) {
  const dir = await root.getDirectoryHandle("Sources", { create: true });
  const fileName = fileNameFor(source.id, source.createdAt);
  await writeFileInDir(dir, fileName, sourceToMarkdown(source));
  await updateIndex(root, source.id, `Sources/${fileName}`);
}

export function writeSourceMarkdown(root: FileSystemDirectoryHandle, source: Source) {
  return enqueueVaultWrite(() => writeSourceMarkdownImpl(root, source));
}

/**
 * Reflection（「本日はここまで」）が生成する system-generated の Insight（Summary）は、
 * 既存の1record=1fileの保存形式をそのまま維持する（日別ファイルへは統合しない）。
 */
function isReflectionSummary(memoryObject: MemoryObject): boolean {
  return memoryObject.metadata.source === "system-generated";
}

async function readDayFileEntries(
  dir: FileSystemDirectoryHandle,
  fileName: string
): Promise<MemoryObject[]> {
  try {
    const fileHandle = await dir.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    return parseMemoryDayFile(text);
  } catch {
    return [];
  }
}

/**
 * 通常のMemoryは「1日1Markdown」（Memories/YYYY-MM-DD.md）に統合する。
 * 同じidのエントリが既にあれば置き換え、無ければ追加する（重複を作らない）。
 * MemoryObject自体のデータ構造・idは変えない。保存単位（ファイル）だけを日単位にする。
 */
async function writeMemoryObjectMarkdownImpl(root: FileSystemDirectoryHandle, memoryObject: MemoryObject) {
  const dir = await root.getDirectoryHandle("Memories", { create: true });

  if (isReflectionSummary(memoryObject)) {
    const fileName = fileNameFor(memoryObject.id, memoryObject.date);
    await writeFileInDir(dir, fileName, memoryObjectToMarkdown(memoryObject));
    await updateIndex(root, memoryObject.id, `Memories/${fileName}`);
    memoryObject.metadata.obsidian = {
      ...memoryObject.metadata.obsidian,
      vaultPath: `Memories/${fileName}`,
    };
    return;
  }

  const fileName = dayFileNameFor(memoryObject.date);
  const existingEntries = await readDayFileEntries(dir, fileName);
  const otherEntries = existingEntries.filter((memory) => memory.id !== memoryObject.id);
  const merged = [...otherEntries, memoryObject].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  await writeFileInDir(dir, fileName, serializeMemoryDayFile(merged));
  await updateIndex(root, memoryObject.id, `Memories/${fileName}`);
  memoryObject.metadata.obsidian = {
    ...memoryObject.metadata.obsidian,
    vaultPath: `Memories/${fileName}`,
  };
}

export function writeMemoryObjectMarkdown(root: FileSystemDirectoryHandle, memoryObject: MemoryObject) {
  return enqueueVaultWrite(() => writeMemoryObjectMarkdownImpl(root, memoryObject));
}

/**
 * Vaultが未接続の間にIndexedDBへ先行保存された記憶を、
 * 接続確立の直後にまとめてMarkdownへ書き出す（データロス防止）。
 * Source基盤（最小構成）も同じ扱いにする：IndexedDBにはあるがVaultに無いSourceを書き戻す。
 */
export async function flushPendingToVault(root: FileSystemDirectoryHandle) {
  const flushStart = Date.now();
  const [conversations, memoryObjects, sources] = await Promise.all([
    getAllConversations(),
    getAllMemoryObjects(),
    getAllSources(),
  ]);
  const totalCount = conversations.length + memoryObjects.length + sources.length;
  console.log(`[Vault] flush:start count=${totalCount}`);
  logTimingEvent("Vault flush:start", { count: totalCount });
  for (const conversation of conversations) {
    await writeConversationMarkdown(root, conversation);
  }
  for (const memoryObject of memoryObjects) {
    await writeMemoryObjectMarkdown(root, memoryObject);
  }
  for (const source of sources) {
    await writeSourceMarkdown(root, source);
  }
  const flushDurationMs = Date.now() - flushStart;
  console.log(`[Vault] flush:end count=${totalCount} durationMs=${flushDurationMs}`);
  logTimingEvent("Vault flush:end", { count: totalCount, durationMs: flushDurationMs });
}

export function isVaultSupported() {
  return getVaultBackend() !== null;
}

// ---------------------------------------------------------------------------
// データ管理（エクスポート・削除）：iPhone/iPad等、OPFS（この端末の安全な領域）に
// 保存されたMarkdownを、ユーザーが端末外へ取り出したり削除したりできるようにする。
// PC/AndroidのFile System Access API Vault（ユーザーが選んだ実フォルダ）は、
// Finder/エクスプローラーから直接読み書きできるため対象外（呼び出し側で
// vaultBackend === "opfs" の場合のみ使うこと。この2関数自体はバックエンドを
// 判定しない）。
// ---------------------------------------------------------------------------

export interface VaultFileEntry {
  /** Vaultルートからの相対パス（例："Memories/2026-07-26.md"）。 */
  path: string;
  content: string;
}

/**
 * Vaultルート配下の`.md`ファイルをすべて再帰的に収集する（エクスポート用）。
 * `scanVaultForRestore`（復元用）と違い、"Conversations"/"Memories"のような
 * 特定フォルダ名には絞り込まず、Vault全体を対象にする（エクスポートは「保存されて
 * いる全Markdown」を過不足なく取り出すことが目的のため）。`.tsumugi/`のような
 * 隠しディレクトリ・隠しファイル（`.`始まり）は内部管理用データであり
 * ユーザー向けのMarkdownではないため対象外にする。
 */
export async function collectAllMarkdownFiles(
  dir: FileSystemDirectoryHandle,
  prefix = ""
): Promise<VaultFileEntry[]> {
  const entries: VaultFileEntry[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(HIDDEN_PREFIX)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      entries.push(...(await collectAllMarkdownFiles(handle, path)));
      continue;
    }
    if (!name.endsWith(".md")) continue;
    const file = await handle.getFile();
    entries.push({ path, content: await file.text() });
  }
  return entries;
}

/**
 * OPFS（この端末の安全な領域）に保存されているtsumugiのVaultデータを削除する。
 * `root`自体（`navigator.storage.getDirectory()`が返すオリジン専有領域そのもの）は
 * 削除できないため、その直下の全エントリ（`Conversations`等の各フォルダ・
 * `.tsumugi/`）だけを再帰的に削除する。OPFSはブラウザによってオリジンごとに
 * サンドボックスされた領域であり、この呼び出しが他のサイト・他アプリ・OSの
 * ストレージへ影響することは構造上あり得ない。
 *
 * PC/AndroidのFile System Access API Vault（ユーザーが選んだ実フォルダ）に対しては
 * 絶対に呼び出さないこと。呼び出し側で`vaultBackend === "opfs"`を確認してから
 * 使う想定（この関数自体はどちらのhandleを渡されても同じように動作してしまうため、
 * ガードは呼び出し元の責務にしている）。
 */
export async function clearOpfsVault(root: FileSystemDirectoryHandle) {
  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Markdown → IndexedDB 復元（STORAGE.md §2.4 Rebuildability Guarantee）
// index.jsonは信頼せず、Conversations/ と Memories/ を直接スキャンする。
// ---------------------------------------------------------------------------

/**
 * 「フォルダ名によるユーザーの再整理（年別・月別フォルダ等）」に耐えるための再帰探索。
 * Vaultルート直下の`Memories`/`Conversations`だけを見るのではなく、Vault内のどこにあっても
 * （ネストされていても）見つけられるようにする。ただし、無関係なVault内の大量のノートまで
 * 毎回全部読みにいくと重くなるため、`folderName`という名前のフォルダに実際に入るまでは
 * ディレクトリ一覧の走査だけに留め、ファイル本文は一切読まない（`insideTarget`がtrueになって
 * 初めてファイルを読む）。`folderName`フォルダに入った後は、その配下は深さ制限なく辿る
 * （その中でさらに年・月フォルダに分かれていてもよい）。
 *
 * ファイル本文を読む前にも、`tsumugi: true`らしいかどうかを先頭数百バイトだけで判定し
 * （`isLikelyTsumugiFile`）、無関係なMarkdownノートの全文読み込みを避ける。
 */
const HIDDEN_PREFIX = ".";
const FOLDER_SEARCH_MAX_DEPTH = 6;
const TSUMUGI_PROBE_BYTES = 1024;

async function isLikelyTsumugiFile(fileHandle: FileSystemFileHandle): Promise<boolean> {
  const file = await fileHandle.getFile();
  const head = await file.slice(0, TSUMUGI_PROBE_BYTES).text();
  return head.startsWith("---\ntsumugi: true\n") || head.includes("\ntsumugi: true\n");
}

async function collectVaultMarkdown(
  dir: FileSystemDirectoryHandle,
  folderName: string,
  insideTarget = false,
  depth = 0
): Promise<string[]> {
  if (!insideTarget && depth > FOLDER_SEARCH_MAX_DEPTH) return [];

  const contents: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(HIDDEN_PREFIX)) continue;

    if (handle.kind === "directory") {
      const nowInsideTarget = insideTarget || name === folderName;
      contents.push(...(await collectVaultMarkdown(handle, folderName, nowInsideTarget, depth + 1)));
      continue;
    }

    if (!insideTarget || !name.endsWith(".md")) continue;
    if (!(await isLikelyTsumugiFile(handle))) continue;
    const file = await handle.getFile();
    contents.push(await file.text());
  }
  return contents;
}

export interface VaultScanResult {
  conversations: Conversation[];
  memoryObjects: MemoryObject[];
  /** Source基盤（最小構成）。他の2つと同じくid重複はupdatedAtが新しい方を採用する。 */
  sources: Source[];
  /** frontmatterが読めない、`tsumugi: true`が無い等で復元対象外だったファイルの数。 */
  skippedCount: number;
}

/**
 * Vault内を再帰的に探索し、`Conversations`という名前のフォルダ・`Memories`という名前のフォルダ・
 * `Sources`という名前のフォルダを（ルート直下だけでなく、どこにネストされていても）見つけてスキャンする。
 * `.tsumugi/index.json` は使わない（正本はあくまでMarkdown自身）。
 * 同じidが複数ファイルに存在する場合は `updatedAt` が新しい方を採用する
 * （旧形式ファイルと新形式の日別ファイルに同じidが二重に存在していても、この仕組みで自然に解決する）。
 * 壊れたファイル・Tsumugi管理外のファイルは1件スキップして続行し、全体を止めない。
 * Memoriesは新形式（1ファイルに複数エントリ）・旧形式（1ファイル1エントリ）のどちらも読める。
 */
export async function scanVaultForRestore(root: FileSystemDirectoryHandle): Promise<VaultScanResult> {
  const scanStart = Date.now();
  console.log(`[Vault] scan:start`);
  logTimingEvent("Vault scan:start");
  let skippedCount = 0;

  const [conversationFiles, memoryFiles, sourceFiles] = await Promise.all([
    collectVaultMarkdown(root, "Conversations"),
    collectVaultMarkdown(root, "Memories"),
    collectVaultMarkdown(root, "Sources"),
  ]);
  const scanFileCount = conversationFiles.length + memoryFiles.length + sourceFiles.length;
  const scanDurationMs = Date.now() - scanStart;
  console.log(`[Vault] scan:end fileCount=${scanFileCount} durationMs=${scanDurationMs}`);
  logTimingEvent("Vault scan:end", { fileCount: scanFileCount, durationMs: scanDurationMs });

  const conversationsById = new Map<string, Conversation>();
  for (const raw of conversationFiles) {
    const parsed = parseConversationMarkdown(raw);
    if (!parsed) {
      skippedCount += 1;
      continue;
    }
    const existing = conversationsById.get(parsed.id);
    if (!existing || existing.updatedAt < parsed.updatedAt) {
      conversationsById.set(parsed.id, parsed);
    }
  }

  const memoryObjectsById = new Map<string, MemoryObject>();
  for (const raw of memoryFiles) {
    const parsedEntries = parseMemoryDayFile(raw);
    if (parsedEntries.length === 0) {
      skippedCount += 1;
      continue;
    }
    for (const parsed of parsedEntries) {
      const existing = memoryObjectsById.get(parsed.id);
      if (!existing || existing.updatedAt < parsed.updatedAt) {
        memoryObjectsById.set(parsed.id, parsed);
      }
    }
  }

  const sourcesById = new Map<string, Source>();
  for (const raw of sourceFiles) {
    let parsed: Source;
    try {
      parsed = parseSourceMarkdown(raw);
    } catch {
      skippedCount += 1;
      continue;
    }
    const existing = sourcesById.get(parsed.id);
    if (!existing || existing.updatedAt < parsed.updatedAt) {
      sourcesById.set(parsed.id, parsed);
    }
  }

  return {
    conversations: [...conversationsById.values()],
    memoryObjects: [...memoryObjectsById.values()],
    sources: [...sourcesById.values()],
    skippedCount,
  };
}
