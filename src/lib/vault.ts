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

import {
  getAllConversations,
  getAllMemoryObjects,
  getAllSources,
  getVaultSyncState,
  loadVaultHandle,
  setVaultSyncState,
} from "./db";
import { logTimingEvent } from "./debugTimingLog";
import type { Conversation, MemoryObject, MemoryType, Source } from "./types";
import {
  conversationToMarkdown,
  memoryObjectToMarkdown,
  parseConversationMarkdown,
  parseMemoryDayFile,
  parseMemoryObjectMarkdown,
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
  // TEMP-TEST：Android実機でのVault復元停止事象の原因切り分け用。queryPermission自体が
  // 例外を投げるケースを観測するためのログのみを追加する（try/catch追加後も、例外は
  // 必ず再throwし、呼び出し元から見た挙動は一切変えない）。
  logTimingEvent("Vault queryPermission:start");
  let result: PermissionState;
  try {
    result = await handle.queryPermission(options);
  } catch (error) {
    logTimingEvent("Vault queryPermission:error");
    throw error;
  }
  logTimingEvent("Vault queryPermission:result", { result });
  return result === "granted";
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
  // TEMP-TEST：Android実機でのVault復元停止事象の原因切り分け用。観測のみを目的とした
  // ログ追加であり、既存の分岐・戻り値・エラー伝播は一切変更しない（catchは全て
  // ログ出力後に必ず同じ例外を再throwする）。
  logTimingEvent("Vault restoreVaultHandle:start");
  try {
    const backend = getVaultBackend();
    logTimingEvent("Vault getVaultBackend:result", { backend: backend ?? "null" });
    if (backend === null) {
      logTimingEvent("Vault restoreVaultHandle:result", { result: "none" });
      return { status: "none" };
    }

    if (backend === "opfs") {
      const root = await navigator.storage.getDirectory();
      logTimingEvent("Vault ensureVaultSkeleton:start");
      try {
        await ensureVaultSkeleton(root);
      } catch (error) {
        logTimingEvent("Vault ensureVaultSkeleton:error");
        throw error;
      }
      logTimingEvent("Vault ensureVaultSkeleton:success");
      logTimingEvent("Vault restoreVaultHandle:result", { result: "connected" });
      return { status: "connected", handle: root };
    }

    const handle = await loadVaultHandle();
    logTimingEvent("Vault storedHandle:result", { found: handle ? 1 : 0 });
    if (!handle) {
      logTimingEvent("Vault restoreVaultHandle:result", { result: "none" });
      return { status: "none" };
    }
    const granted = await verifyPermission(handle, true);
    logTimingEvent("Vault restoreVaultHandle:result", { result: granted ? "connected" : "needs-permission" });
    return granted ? { status: "connected", handle } : { status: "needs-permission", handle };
  } catch (error) {
    logTimingEvent("Vault restoreVaultHandle:error");
    throw error;
  }
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
 *
 * フォルダの選択のみを行う（骨組み作成・handle保存は行わない）。以前はこの関数が
 * ensureVaultSkeleton・saveVaultHandleまで一括で行っていたが、Vault切替時に
 * 「別Vaultかどうかをまず判定し、別Vaultの場合はユーザー確認を挟んでから初めて
 * 骨組みを作る」という順序（checkVaultIdentity、ChatScreen.tsx参照）が必要になったため、
 * 「選ぶ」と「実際にそのVaultとして使い始める」を分離した。骨組み作成・handle保存は
 * 呼び出し元が、Vault識別判定の結果に応じたタイミングで`ensureVaultSkeleton`/
 * `saveVaultHandle`を個別に呼ぶこと。
 */
export async function pickVaultDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isFsAccessSupported()) {
    throw new Error("このブラウザはFile System Access APIに対応していません。Chrome/Edgeでお試しください。");
  }
  return window.showDirectoryPicker({ mode: "readwrite" });
}

/**
 * 保存済みの旧handle（previousHandle）と、今回選択した新しいhandle（newHandle）が
 * 同じVault（同じフォルダエントリ）を指すかどうかを判定する。
 *
 * - previousHandleが無い（＝これまで一度もVaultへ接続したことが無い）場合は
 *   "first-connection" を返す。これは「別のVaultへの切替」ではなく「今まで
 *   ローカルにあったデータへ、初めて保存先を割り当てる」操作として扱うべきケース
 *   （STORAGE.md §2.4 / 今回のVault境界設計のCASE 1）。
 * - `FileSystemHandle.isSameEntry()`で比較する（MDN: 同じエントリを指す2つのhandleを
 *   比較するための標準API。Chrome 86+で利用可能、tsumugiのFile System Access
 *   バックエンド自体がChrome/Edge限定のため対象範囲内）。
 * - 比較自体が例外を投げた場合（handleが失効している等、判定不能な場合）は、
 *   「同じVaultだろう」と推測せず、安全側に倒して"different"を返す。誤って
 *   別々のMemory Worldを同一とみなし混在させるリスクの方を、常に重く見る。
 */
export type VaultIdentity = "first-connection" | "same" | "different";

export async function checkVaultIdentity(
  previousHandle: FileSystemDirectoryHandle | undefined,
  newHandle: FileSystemDirectoryHandle
): Promise<VaultIdentity> {
  if (!previousHandle) return "first-connection";
  try {
    const same = await previousHandle.isSameEntry(newHandle);
    return same ? "same" : "different";
  } catch {
    return "different";
  }
}

/**
 * exportしてChatScreen.tsx側からも呼べるようにした（Vault切替時、ユーザー確認の後、
 * IndexedDBをclearする前に「新しいVaultが実際に使えるか」を確認する目的で使う。
 * 副作用は空のディレクトリ（VAULT_DIRS各種・.tsumugi/）の作成と、存在しない場合のみの
 * schema-version.json / index.json の作成のみで、既存ファイルの上書き・削除は行わない）。
 */
export async function ensureVaultSkeleton(root: FileSystemDirectoryHandle) {
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

/**
 * TEMP-TEST：Android実機でVault write 1回が8〜11秒まで悪化した事象の原因切り分け用。
 * write:start〜write:endの内部を区間ごとに分解するための最小限の計測ヘルパー。
 * 動作・戻り値・エラー伝播には一切影響しない（taskを素通しして時間を計るだけ）。
 * 会話内容・Memory本文・APIキー・ファイル内容は一切出さない（区間名と経過時間だけ）。
 * 原因調査が終わり次第、このヘルパーと呼び出し箇所ごと削除すること。
 */
async function timedIOStep<T>(label: string, task: () => Promise<T>): Promise<T> {
  const start = Date.now();
  console.log(`[VaultIO] ${label}:start`);
  logTimingEvent(`VaultIO ${label}:start`);
  try {
    return await task();
  } finally {
    const durationMs = Date.now() - start;
    console.log(`[VaultIO] ${label}:end durationMs=${durationMs}`);
    logTimingEvent(`VaultIO ${label}:end`, { durationMs });
  }
}

/** 同期処理（Markdown/JSON生成等）の所要時間だけを記録する。task自体はtimedIOStepを使わず直接呼ぶ。 */
function logSyncStep(label: string, durationMs: number): void {
  console.log(`[VaultIO] ${label} durationMs=${durationMs}`);
  logTimingEvent(`VaultIO ${label}`, { durationMs });
}

async function writeFileInDir(dir: FileSystemDirectoryHandle, name: string, content: string, label = "file") {
  const fileHandle = await timedIOStep(`${label} fileHandle`, () => dir.getFileHandle(name, { create: true }));
  const writable = await timedIOStep(`${label} createWritable`, () => fileHandle.createWritable());
  await timedIOStep(`${label} write`, () => writable.write(content));
  await timedIOStep(`${label} close`, () => writable.close());
}

async function readJSON<T>(dir: FileSystemDirectoryHandle, name: string, fallback: T, label = "json"): Promise<T> {
  try {
    const fileHandle = await timedIOStep(`${label} fileHandle`, () => dir.getFileHandle(name, { create: false }));
    const file = await timedIOStep(`${label} getFile`, () => fileHandle.getFile());
    const text = await timedIOStep(`${label} readText`, () => file.text());
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
 * writeMemoryObjectMarkdown）を、モジュールスコープの単一の実行主体を通じて直列化する。
 * 呼び出し元がどのファイル・どの日付を書こうとしているかに関わらず、「同時に実行される
 * Vault writeは常に1件だけ」であることを保証する（同じファイルだけを対象にした細かい
 * ロックにしないのは、対象ファイルの特定自体に事前のI/Oが必要で複雑になるため）。
 *
 * AI呼び出し（Capture/ConnectのGemini API呼び出し）はこのキューに含めない。直列化するのは
 * 実際にファイルを読み書きする瞬間だけであり、Capture/Connect全体を待たせることはない。
 *
 * 1つの書き込みが失敗しても、キュー自体は次の書き込みへ進む（失敗を握りつぶさず、
 * 呼び出し元へは例外をそのまま伝播させた上で、キューの処理は継続する）。
 *
 * 優先度付きキュー（Beta修正）：Android実機で、起動時のflushPendingToVault（背景同期、
 * 変更が無くても毎回全件）が、ユーザーの終了操作によるConversation保存と同じ列に並び、
 * 数秒〜数十秒待たされる問題が実測で確認された。対策として、実行順を選ぶ際だけ
 * "interactive"を"background"より優先する（実行中の1件を中断・追い越しすることはない。
 * File System Access APIの書き込みを安全に中断する方法が無いため）。
 * 「同時に実行されるのは常に1件だけ」という同時書き込み衝突防止の性質は変更しない
 * （index.json・Memoryの日別ファイルのような複数呼び出し元が共有するファイルへ、
 * 2つの書き込みが並行してread-modify-writeする事故は、この方式でも発生しない）。
 *
 * 同一id優先順位の保護：もし「起動時flushが捕まえた古いスナップショット」と「その後の
 * ユーザー操作による新しい保存」が、たまたま同じConversation/MemoryObject/Sourceを
 * 対象にしていた場合、優先度だけで単純にinteractiveを先に実行すると、後から実行される
 * 古いbackground write（stale snapshot）が新しい内容を上書きしてしまう（データの
 * 逆行）。これを防ぐため、各itemは対象の`conflictKey`（`kind:id`）を持ち、同じ
 * conflictKeyを持つ、より早くenqueueされたitemが存在する場合は、interactiveであっても
 * 追い越しを許可しない（enqueue順を維持する）。無関係なid同士でのみ優先度が効く。
 */
export type VaultWritePriority = "interactive" | "background";

interface VaultWriteQueueItem {
  priority: VaultWritePriority;
  /** 同一の対象（同じConversation/MemoryObject/Source）を識別するキー。無ければnull。 */
  conflictKey: string | null;
  run: () => Promise<void>;
}

const vaultWriteQueueItems: VaultWriteQueueItem[] = [];
let vaultWriteProcessing = false;

/**
 * interactiveを優先しつつ、同じconflictKeyを持つより古いitemを追い越さない。
 * 適格なinteractiveが無ければ、先頭（＝最も古いitem）をFIFOで選ぶ。
 */
function pickNextVaultWriteIndex(): number {
  const seenConflictKeys = new Set<string>();
  for (let i = 0; i < vaultWriteQueueItems.length; i++) {
    const item = vaultWriteQueueItems[i];
    const blockedBySameTarget = item.conflictKey !== null && seenConflictKeys.has(item.conflictKey);
    if (item.priority === "interactive" && !blockedBySameTarget) {
      return i;
    }
    if (item.conflictKey !== null) seenConflictKeys.add(item.conflictKey);
  }
  return vaultWriteQueueItems.length > 0 ? 0 : -1;
}

function processVaultWriteQueue(): void {
  if (vaultWriteProcessing) return;
  const index = pickNextVaultWriteIndex();
  if (index === -1) return;

  const [item] = vaultWriteQueueItems.splice(index, 1);
  vaultWriteProcessing = true;
  // item.run()自体は内部で例外を握りつぶし（reject/resolveは外側のPromiseへ伝える）、
  // ここでは常にfulfillするため、1件の失敗がキューの進行を止めることはない。
  void item.run().finally(() => {
    vaultWriteProcessing = false;
    processVaultWriteQueue();
  });
}

/**
 * Vault境界の安全性（Codexレビュー指摘H3対応）：呼び出し時点までにVault write queueへ
 * 積まれた書き込み（実行中の1件を含む）が、すべて完了するまで待つ。新しく積まれる
 * 書き込みまでは追いかけて待たない（無限に終わらなくなるのを避けるため。呼び出し元
 * ＝Vault切替フローが、これを呼ぶ前に新規のMemory系処理の開始を止めている前提）。
 *
 * 既存のキュー実装（vaultWriteQueueItems・vaultWriteProcessing・
 * pickNextVaultWriteIndex・processVaultWriteQueue）は一切変更しない。ここでは
 * その状態を外側から軽量にポーリングして待つだけで、書き込み順序・優先度・
 * 同時実行数（常に1件）といった既存の保証には一切手を加えない。
 *
 * `timeoutMs`（省略時は無期限）：Codexレビュー指摘（永久待機フェイルセーフ）対応。
 * 何らかの理由でキューが収束しない場合に、呼び出し元（Vault切替フロー）が
 * 「安全側に倒して切替を中止する」判断をできるよう、`{ timedOut: true }`を返す
 * （キュー自体の状態は変更しない＝待つのを諦めるだけで、書き込み自体は裏で続行される）。
 * 既存の呼び出し元（タイムアウト無し）は戻り値の`timedOut`を見なければ従来と同じ意味。
 */
export function waitForVaultWrites(timeoutMs?: number): Promise<{ timedOut: boolean }> {
  const isDrained = () => vaultWriteQueueItems.length === 0 && !vaultWriteProcessing;
  if (isDrained()) return Promise.resolve({ timedOut: false });
  const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  return new Promise((resolve) => {
    const check = () => {
      if (isDrained()) {
        resolve({ timedOut: false });
        return;
      }
      if (deadline !== undefined && Date.now() > deadline) {
        resolve({ timedOut: true });
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

/**
 * TEMP-TEST：公開ベータで稀に発生する20〜40秒の異常遅延の原因切り分け用。
 * enqueue時刻・実際のwrite開始時刻・完了時刻だけを出す最小限のログ。
 * 会話内容・Memory本文・ファイルパス・IDは一切出さない（件数・経過時間のみ）。
 * 原因調査が終わり次第削除すること。
 */
let vaultWriteSeq = 0;

function enqueueVaultWrite<T>(
  task: () => Promise<T>,
  priority: VaultWritePriority = "interactive",
  conflictKey: string | null = null
): Promise<T> {
  const seq = ++vaultWriteSeq;
  const enqueuedAt = Date.now();
  console.log(`[Vault] write:enqueue seq=${seq} priority=${priority}`);
  logTimingEvent("Vault write:enqueue", { seq, background: priority === "background" ? 1 : 0 });

  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      const waitMs = Date.now() - enqueuedAt;
      console.log(`[Vault] write:start seq=${seq} waitMs=${waitMs} priority=${priority}`);
      logTimingEvent("Vault write:start", { seq, waitMs });
      const startedAt = Date.now();
      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        const durationMs = Date.now() - startedAt;
        console.log(`[Vault] write:end seq=${seq} durationMs=${durationMs}`);
        logTimingEvent("Vault write:end", { seq, durationMs });
      }
    };
    vaultWriteQueueItems.push({ priority, conflictKey, run });
    processVaultWriteQueue();
  });
}

type VaultSyncKind = "conversation" | "memory" | "source";

function vaultSyncKeyFor(kind: VaultSyncKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * 同期済み台帳（vaultSyncState）へ、実際にVaultへの書き込みが成功した後にのみ記録する。
 * 台帳の書き込み自体が失敗しても、Markdown書き込み自体は既に成功しているため、
 * その成功をこの関数の失敗で握りつぶさない（ログに残すだけで例外は投げない）。
 */
async function markVaultSynced(kind: VaultSyncKind, id: string, updatedAt: string): Promise<void> {
  try {
    await timedIOStep(`${kind} ledger`, () => setVaultSyncState(vaultSyncKeyFor(kind, id), updatedAt));
  } catch (error) {
    console.error(`[Tsumugi] failed to record vault sync state for ${kind}:`, error);
  }
}

/**
 * 台帳を確認し、既に同じupdatedAtで書き込み済みなら true（＝この項目のVault writeを
 * スキップしてよい）を返す。台帳の読み取り自体に失敗した場合は「未同期」として安全側に
 * 倒し、必ず書き込む（falseを返す）。Vault側のMarkdownファイルは一切読まない。
 */
async function isAlreadySyncedToVault(kind: VaultSyncKind, id: string, updatedAt: string): Promise<boolean> {
  try {
    const recorded = await getVaultSyncState(vaultSyncKeyFor(kind, id));
    return recorded === updatedAt;
  } catch (error) {
    console.error(`[Tsumugi] failed to read vault sync state for ${kind}:`, error);
    return false;
  }
}

async function updateIndex(root: FileSystemDirectoryHandle, id: string, relativePath: string) {
  const indexStart = Date.now();
  console.log(`[VaultIO] index:start`);
  logTimingEvent("VaultIO index:start");

  const tsumugiDir = await timedIOStep("index dirHandle", () => root.getDirectoryHandle(".tsumugi", { create: true }));
  const index = await readJSON<Record<string, string>>(tsumugiDir, "index.json", {}, "index read");
  index[id] = relativePath;
  await writeFileInDir(tsumugiDir, "index.json", JSON.stringify(index, null, 2), "index write");

  const indexDurationMs = Date.now() - indexStart;
  console.log(`[VaultIO] index:end durationMs=${indexDurationMs}`);
  logTimingEvent("VaultIO index:end", { durationMs: indexDurationMs });
}

/**
 * History Index（Vault読込方式の再設計、Step 1）。
 *
 * 目的：Historyを「IndexedDBの全件」ではなく「Vault内の軽量な目次＋必要な日だけの
 * Markdown読み取り」で表示できるようにするための、Vault内`.tsumugi/`配下の目次データ。
 * 既存の`.tsumugi/index.json`（`updateIndex`、id→pathの平坦なmapで、復元処理からは
 * 意図的に信頼されていない）とは別の、新しいファイル群として追加する
 * （既存index.jsonの読み書きには一切手を加えない）。
 *
 * 配置：
 *   .tsumugi/history-meta.json      … 極小のメタ情報（月一覧・総件数）
 *   .tsumugi/history/YYYY-MM.json   … その月の日付ごとの目次（月単位で分割し、
 *                                      Vault全体の件数に読み込み量が比例しないようにする）
 *
 * 通常Memory（1日1Markdownへ統合）は`Memories/YYYY-MM-DD.md`を1回読めば
 * その日の全件が判る（`parseMemoryDayFile`）ため、月Indexにはid配列を持たせず
 * `memoryCount`（数字だけ）を保持する。Reflection Summary（system-generated、
 * 1record1file）はこの前提に乗らないため、`reflectionIds`として個別に保持し、
 * 日付タップ時にidから直接ファイル名を再構築して読めるようにする。
 * Conversationも1日に複数ファイルが存在しうるため`conversationIds`を保持する
 * （`fileNameFor(id, day)`で安全にpathを再構築できる。既存の命名規則と同じ関数を
 * そのまま使うため、Index側とファイル名生成側が食い違うことはない）。
 */
/**
 * v1形状（既存、Step 1〜4）。`normalMemoryCount`：通常Memory（day-fileへ統合される
 * 形式）の、そのday-file自体の現在の実エントリ数（絶対値）。`reflectionIds`：
 * Reflection Summary（1record1file）のid一覧。`memoryCount`は常に
 * `normalMemoryCount + reflectionIds.length`として再計算した絶対値。
 * IDのみを保持するため、一覧表示にはid経由でMarkdown本体を読む必要がある
 * （History Index v2で解消する対象そのもの）。
 */
export interface HistoryDayIndexV1 {
  conversationIds: string[];
  normalMemoryCount: number;
  reflectionIds: string[];
  memoryCount: number;
}

/**
 * History Index v2。ユーザー向けの表示モード。coach/analyst問わず、
 * persona!=="companion"は一律"conversation"（＝表示上「会話」）へ正規化する
 * （旧「探究」「相談・創造」という名称をHistory Index・History UIには一切残さない）。
 */
export type HistoryConversationMode = "diary" | "conversation";

/** Conversation一覧に必要な最小限のデータ（本文turnsは含まない）。 */
export interface HistoryConversationSummary {
  id: string;
  mode: HistoryConversationMode;
  turnCount: number;
}

/**
 * 通常Memory／Reflection共通の一覧表示用データ（本文content/フルsummaryは含まない）。
 * `preview`はHistory一覧専用の軽量表示データであり、Markdown本体の
 * `summary`/`content`を置き換えるものではない（`truncateHistoryPreview`参照）。
 * `createdAt`は同日内の通常Memory・Reflectionを時系列でマージ表示するためだけに使う。
 */
export interface HistoryMemorySummary {
  id: string;
  types: MemoryType[];
  preview: string;
  createdAt: string;
}

/**
 * History Index v2（本ファイル本体）。一覧表示に必要なデータを直接持つため、
 * 日付タップ時にConversation/Reflection/通常MemoryのMarkdownを一切読まなくても
 * 一覧が描画できる（詳細表示時のみ、id経由でMarkdown本体を読む）。
 */
export interface HistoryDayIndexV2 {
  conversations: HistoryConversationSummary[];
  normalMemories: HistoryMemorySummary[];
  reflections: HistoryMemorySummary[];
}

/**
 * v1（既存Vaultの、まだ一度も開かれていない日）とv2（新規書き込み、または実際に
 * 開かれてlazy upgradeされた日）が同じ月Index内に混在しうる。読み取り側は必ず
 * `isHistoryDayIndexV2`で判定してから分岐すること。
 */
export type HistoryDayIndex = HistoryDayIndexV1 | HistoryDayIndexV2;

/** `HistoryDayIndex`がv2形状かどうかを判定する。v1はこの3フィールドを持たない。 */
export function isHistoryDayIndexV2(entry: HistoryDayIndex | undefined): entry is HistoryDayIndexV2 {
  return !!entry && Array.isArray((entry as HistoryDayIndexV2).conversations);
}

export interface HistoryMonthIndex {
  /** 1＝v1のみで書かれた月（このファイル自体はまだv2対応コードで触れられていない）。
   *  2＝v2対応コードが一度でも書き込んだ月（日ごとにv1/v2が混在しうる）。 */
  version: 1 | 2;
  month: string;
  days: Record<string, HistoryDayIndex>;
}

/** 1ヶ月分の集計（絶対値）。`history-meta.json`の`months[month]`として保持する。 */
export interface HistoryMonthAggregate {
  memories: number;
  conversations: number;
}

export interface HistoryMeta {
  version: 1;
  updatedAt: string;
  months: Record<string, HistoryMonthAggregate>;
  totalMemories: number;
  totalConversations: number;
}

/**
 * 呼び出しごとに新しいオブジェクトを返すこと（`readJSON`はファイルが存在しない場合、
 * ここで渡したfallbackをそのまま呼び出し元へ返す。呼び出し元＝`updateHistoryIndex`は
 * その戻り値を直接書き換えるため、共有の定数オブジェクトを使うと、2回目以降の
 * 「ファイルがまだ無い」呼び出しが、前回の呼び出しで書き換え済みの値を誤って
 * 引き継いでしまう）。
 */
function emptyHistoryMeta(): HistoryMeta {
  return { version: 1, updatedAt: "", months: {}, totalMemories: 0, totalConversations: 0 };
}

/**
 * 新規書き込み時のfallback。v2対応コードが新しく作る月は最初からversion 2として
 * 扱う（既存のv1のみの月をこの関数が作ることはない——既存月の読み込みは
 * `readJSON`がファイルの実内容をそのまま返すため、この関数は「ファイルが無い」
 * 場合にのみ使われる）。
 */
function emptyMonthIndex(month: string): HistoryMonthIndex {
  return { version: 2, month, days: {} };
}

/** 新規（またはv2化された）日の初期値。v1の空エントリはもう新規に作らない
 *  （v1形状は既存データを読んだ場合にのみ現れる。既存のcomputeUpdatedDayEntryV1は
 *  必ず既存previousを受け取るため、この関数を必要としない）。 */
function emptyDayIndexV2(): HistoryDayIndexV2 {
  return { conversations: [], normalMemories: [], reflections: [] };
}

/**
 * History Index専用の排他ロック名。H4（`vaultWorldLock.ts`の`"tsumugi-vault-world"`、
 * epoch/journal/committed worldの世界isolation）とは完全に独立した、別のWeb Lock。
 * H4のロック・epoch・journalロジックには一切触れない（このファイル・このロックの
 * 存在自体がH4の判定に影響することも無い）。
 *
 * 月Index（history/YYYY-MM.json）とhistory-meta.jsonの更新は「1つの論理的な
 * Index更新」として扱いたいため、両方の読み取り→変更→書き戻しを、この1つのロックの
 * 保持区間内で行う（月Indexとmetaを別々のロックにすると、片方だけ更新された
 * 中間状態が他タブから観測されうるため、今回は分けない）。
 */
const HISTORY_INDEX_LOCK_NAME = "tsumugi-history-index-write";

/**
 * `navigator.locks`（Web Locks API）はChrome/Edge（Android含む）・Safari 15.4+
 * （iPhone/iPad）のいずれでも利用できる想定だが、念のため機能検出する。
 * 使えない環境では、タブ間の排他は保証できないが、既存の`.tsumugi/index.json`・
 * Memory day-fileも同様にタブ間排他を持たない（同一タブ内の直列化＝
 * `enqueueVaultWrite`のみ）ため、この関数が呼ばれる時点で既に同一タブ内の
 * 直列化は保証されている。ロックが使えない場合はそのまま関数を実行するだけの
 * fallbackにする（新しい代替ロック機構は作らない）。
 */
function isHistoryIndexLockSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks !== "undefined";
}

async function withHistoryIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!isHistoryIndexLockSupported()) return fn();
  return navigator.locks.request(HISTORY_INDEX_LOCK_NAME, fn);
}

export type HistoryIndexUpdate =
  | { kind: "conversation"; id: string; day: string; mode: HistoryConversationMode; turnCount: number }
  | { kind: "reflection"; id: string; day: string; preview: string; createdAt: string }
  /**
   * 通常Memory（day-fileへ統合される形式）専用。`normalMemories`は呼び出し元
   * （`writeMemoryObjectMarkdownImpl`）が、day-fileへ実際に書き込んだ後のマージ済み
   * 配列（絶対値）をそのまま軽量化して渡す。「新規か更新か」の判定はここでは行わない
   * （Codexレビュー指摘：retry時、day-fileには既にそのidが存在するため「更新」と
   * 誤判定され、差分加算方式ではIndex側の件数が永続的にずれる。絶対値を渡すことで
   * 何度retryしても同じ正しい値へ収束する。History Index v2でも同じ設計を維持する）。
   */
  | { kind: "memory"; day: string; normalMemories: HistoryMemorySummary[] }
  /**
   * Step 3（HistoryPanel.tsxのlazy upgrade）専用。v1形状の日を実際に開いて
   * fallback読み込みが完了した直後、その取得済みデータから組み立てたv2 entryを
   * そのまま渡す（追加のMarkdown readはしない）。既に v2 になっている日には
   * 一切上書きしない（`computeUpdatedDayEntry`参照、冪等性の担保）。
   */
  | { kind: "day-upgrade"; day: string; entry: HistoryDayIndexV2 };

/** 既存配列からid一致する要素を探し、あれば同じ位置で置換、無ければ末尾へ追加する。
 *  同一idの再write（retry・後続の更新）で重複せず、常に最新の内容へ置換される。 */
function upsertById<T extends { id: string }>(list: T[], entry: T): T[] {
  const index = list.findIndex((item) => item.id === entry.id);
  if (index === -1) return [...list, entry];
  const next = [...list];
  next[index] = entry;
  return next;
}

/**
 * v1形状の日を維持したまま更新する（既存ロジック、無変更）。v1→v2への自動変換は
 * ここでは行わない——変換にはconversationIds/reflectionIds由来の他item（このupdateの
 * 対象ではないitem）のturnCount/preview等を再構築する必要があり、追加のMarkdown read
 * なしには行えないため。実際のv2化はHistoryPanel.tsx側のlazy upgrade
 * （"day-upgrade"、その日を実際に開いてfallback読み込みが完了した時だけ）に委ねる。
 */
function computeUpdatedDayEntryV1(
  previous: HistoryDayIndexV1,
  update: Exclude<HistoryIndexUpdate, { kind: "day-upgrade" }>
): HistoryDayIndexV1 {
  const base: HistoryDayIndexV1 = {
    conversationIds: [...previous.conversationIds],
    normalMemoryCount: previous.normalMemoryCount,
    reflectionIds: [...previous.reflectionIds],
    memoryCount: previous.memoryCount,
  };

  if (update.kind === "conversation") {
    if (!base.conversationIds.includes(update.id)) {
      base.conversationIds = [...base.conversationIds, update.id];
    }
  } else if (update.kind === "reflection") {
    if (!base.reflectionIds.includes(update.id)) {
      base.reflectionIds = [...base.reflectionIds, update.id];
    }
  } else {
    base.normalMemoryCount = update.normalMemories.length;
  }

  base.memoryCount = base.normalMemoryCount + base.reflectionIds.length;
  return base;
}

/**
 * v2形状の日を更新する（新規の日、または既にv2化済みの日）。conversations/
 * reflectionsは`upsertById`でid基準のupsert（同一idなら最新へ置換、初出なら追加）を
 * 行うため、retryで重複しない。normalMemoriesは`writeMemoryObjectMarkdownImpl`が
 * 渡すday-fileの現在の全件（絶対値）でそのまま置き換える——差分加算は一切しない。
 */
function computeUpdatedDayEntryV2(
  previous: HistoryDayIndexV2 | undefined,
  update: Exclude<HistoryIndexUpdate, { kind: "day-upgrade" }>
): HistoryDayIndexV2 {
  const base: HistoryDayIndexV2 = previous
    ? {
        conversations: [...previous.conversations],
        normalMemories: [...previous.normalMemories],
        reflections: [...previous.reflections],
      }
    : emptyDayIndexV2();

  if (update.kind === "conversation") {
    base.conversations = upsertById(base.conversations, {
      id: update.id,
      mode: update.mode,
      turnCount: update.turnCount,
    });
  } else if (update.kind === "reflection") {
    base.reflections = upsertById(base.reflections, {
      id: update.id,
      types: ["insight"],
      preview: update.preview,
      createdAt: update.createdAt,
    });
  } else {
    base.normalMemories = update.normalMemories;
  }

  return base;
}

/**
 * 既存のday entry（無ければ空）へ、1件の更新を反映した新しいday entryを返す
 * （純粋関数、副作用なし）。
 *
 * 分岐方針（History Index v2、重要修正1対応）：
 * - "day-upgrade"：既にv2ならそのまま返す（上書きしない＝複数回呼ばれても冪等）。
 *   v1または未登録なら、呼び出し元が組み立て済みのv2 entryへ置き換える。
 * - それ以外のkind（通常の書き込み）：既存entryがv1形状（かつ存在する）ならv1のまま
 *   更新する（v1→v2の自動変換はしない）。既存entryが無い、またはv2形状なら
 *   v2として更新する。これにより、新規の日・既にv2化された日は最初から
 *   （またはこの1件の更新以降も）v2として保存され、まだ開かれていないv1の日は
 *   Vault全体scanを伴わずに安全にv1のまま維持される。
 */
function computeUpdatedDayEntry(previous: HistoryDayIndex | undefined, update: HistoryIndexUpdate): HistoryDayIndex {
  if (update.kind === "day-upgrade") {
    if (previous && isHistoryDayIndexV2(previous)) return previous;
    return update.entry;
  }
  if (previous && !isHistoryDayIndexV2(previous)) {
    return computeUpdatedDayEntryV1(previous, update);
  }
  return computeUpdatedDayEntryV2(previous, update);
}

function isHistoryConversationSummaryEqual(a: HistoryConversationSummary, b: HistoryConversationSummary): boolean {
  return a.id === b.id && a.mode === b.mode && a.turnCount === b.turnCount;
}

function isHistoryMemorySummaryEqual(a: HistoryMemorySummary, b: HistoryMemorySummary): boolean {
  return (
    a.id === b.id &&
    a.preview === b.preview &&
    a.createdAt === b.createdAt &&
    a.types.length === b.types.length &&
    a.types.every((type, i) => type === b.types[i])
  );
}

function isDayIndexEqual(a: HistoryDayIndex, b: HistoryDayIndex): boolean {
  const aIsV2 = isHistoryDayIndexV2(a);
  const bIsV2 = isHistoryDayIndexV2(b);
  if (aIsV2 !== bIsV2) return false; // v1↔v2の形状変化自体を変化として扱う（lazy upgrade時に必ず書き込ませる）

  if (aIsV2 && bIsV2) {
    return (
      a.conversations.length === b.conversations.length &&
      a.conversations.every((c, i) => isHistoryConversationSummaryEqual(c, b.conversations[i])) &&
      a.normalMemories.length === b.normalMemories.length &&
      a.normalMemories.every((m, i) => isHistoryMemorySummaryEqual(m, b.normalMemories[i])) &&
      a.reflections.length === b.reflections.length &&
      a.reflections.every((m, i) => isHistoryMemorySummaryEqual(m, b.reflections[i]))
    );
  }

  const av1 = a as HistoryDayIndexV1;
  const bv1 = b as HistoryDayIndexV1;
  return (
    av1.normalMemoryCount === bv1.normalMemoryCount &&
    av1.memoryCount === bv1.memoryCount &&
    av1.conversationIds.length === bv1.conversationIds.length &&
    av1.conversationIds.every((id, i) => id === bv1.conversationIds[i]) &&
    av1.reflectionIds.length === bv1.reflectionIds.length &&
    av1.reflectionIds.every((id, i) => id === bv1.reflectionIds[i])
  );
}

/** v1・v2いずれの形状でも、その日のMemory件数（通常Memory＋Reflection）を返す。 */
function dayMemoryCount(day: HistoryDayIndex): number {
  return isHistoryDayIndexV2(day) ? day.normalMemories.length + day.reflections.length : day.memoryCount;
}

/** v1・v2いずれの形状でも、その日のConversation件数を返す。 */
function dayConversationCount(day: HistoryDayIndex): number {
  return isHistoryDayIndexV2(day) ? day.conversations.length : day.conversationIds.length;
}

/**
 * 月Indexの現在の（既に書き込み済みの）状態から、その月の絶対集計を計算する。
 * v1の日・v2の日・両者が混在する月のいずれでも正しく集計する
 * （`dayMemoryCount`/`dayConversationCount`が形状を吸収するため）。
 */
function computeMonthAggregate(monthIndex: HistoryMonthIndex): HistoryMonthAggregate {
  let memories = 0;
  let conversations = 0;
  for (const day of Object.values(monthIndex.days)) {
    memories += dayMemoryCount(day);
    conversations += dayConversationCount(day);
  }
  return { memories, conversations };
}

function isMonthAggregateEqual(a: HistoryMonthAggregate | undefined, b: HistoryMonthAggregate): boolean {
  return !!a && a.memories === b.memories && a.conversations === b.conversations;
}

/**
 * History Indexへ1件分の変更を反映する。Markdown本体の書き込みに成功した直後、
 * 呼び出し元（`writeConversationMarkdownImpl`/`writeMemoryObjectMarkdownImpl`）から
 * 必ず呼ぶこと。
 *
 * 冪等性（重要・Codexレビュー指摘対応）：月Index・meta双方への反映は、常に
 * 「現在の状態から求めた絶対値」を書く設計にしている（差分加算はしない）。
 * そのため以下のいずれのretryケースでも、最終的に正しい状態へ収束する：
 *   - Markdown成功→月Index書き込み失敗→retry：normalMemoryCount/idはretry時も
 *     同じ絶対値・同じidのため、同じ正しいday entryが再計算されるだけ。
 *   - 月Index成功→meta失敗→retry：day entry自体は既に正しく書き込み済みのため
 *     月Index書き込みはskipされるが、meta側は「月Indexの現在の絶対集計」と
 *     「meta.monthsに既に記録済みの値」を毎回比較するため、meta側だけが
 *     未更新のまま残っていれば、月Index書き込みの有無に関わらず必ず検出して書く。
 *   - 同一操作の複数回retry・同一idの再write：day entry・月集計のどちらも
 *     再計算結果が既存の保存値と一致するため、書き込み自体を毎回skipする
 *     （件数が増え続けることはない）。
 *
 * 失敗時の扱い：この関数はエラーを一切catchしない。呼び出し元でもtry/catchで
 * 握り潰さないこと。既存VaultWrite再試行の仕組み（`markVaultSynced`がwrite成功時
 * にのみ呼ばれ、`isAlreadySyncedToVault`が次回flush時に未同期と判定して再試行する）
 * にそのまま乗せるため、Markdown本体の書き込みが成功していてもこのIndex更新が
 * 失敗すれば、呼び出し元の関数全体を失敗として伝播させ、台帳（vaultSyncState）を
 * 更新させない＝次回flush時に本体・Index更新の両方が再試行される
 * （新しい独立したretry機構は作らない）。
 */
async function updateHistoryIndex(root: FileSystemDirectoryHandle, update: HistoryIndexUpdate): Promise<void> {
  const historyIndexStart = Date.now();
  logTimingEvent("HistoryIndex update:start", { kind: update.kind });

  await withHistoryIndexLock(async () => {
    const tsumugiDir = await timedIOStep("historyIndex tsumugiDir", () => root.getDirectoryHandle(".tsumugi", { create: true }));
    const historyDir = await timedIOStep("historyIndex historyDir", () => tsumugiDir.getDirectoryHandle("history", { create: true }));
    const month = update.day.slice(0, 7);
    const monthFileName = `${month}.json`;

    const monthIndex = await readJSON<HistoryMonthIndex>(historyDir, monthFileName, emptyMonthIndex(month), "history month read");
    const previousDayEntry = monthIndex.days[update.day];
    const dayEntry = computeUpdatedDayEntry(previousDayEntry, update);
    const dayChanged = !previousDayEntry || !isDayIndexEqual(previousDayEntry, dayEntry);

    // History Index v2：このファイルはv2対応コードで書かれたことを示すために2へ
    // 更新する（日ごとのv1/v2判定は`isHistoryDayIndexV2`が形状で行うため、この
    // ファイル単位のversionはあくまで参考情報であり、読み込み側の分岐には使わない）。
    monthIndex.version = 2;
    monthIndex.month = month;
    monthIndex.days[update.day] = dayEntry;

    if (dayChanged) {
      await writeFileInDir(historyDir, monthFileName, JSON.stringify(monthIndex, null, 2), "history month write");
    } else {
      logTimingEvent("HistoryIndex update:day-unchanged", { kind: update.kind });
    }

    // metaは「月Indexの現在の絶対集計」から常に再計算し、既存metaと異なる場合だけ
    // 書く。dayChangedの有無に関わらず必ず確認する——「月Indexは前回既に正しく
    // 更新されていたが、metaだけ書き込みに失敗して未更新のまま残っている」という
    // retryケースを、月Index側の変化の有無とは無関係に検出するため。
    const monthAggregate = computeMonthAggregate(monthIndex);
    const meta = await readJSON<HistoryMeta>(tsumugiDir, "history-meta.json", emptyHistoryMeta(), "history meta read");
    const metaChanged = !isMonthAggregateEqual(meta.months[month], monthAggregate);

    if (metaChanged) {
      meta.version = 1;
      meta.months[month] = monthAggregate;
      meta.totalMemories = Object.values(meta.months).reduce((sum, m) => sum + m.memories, 0);
      meta.totalConversations = Object.values(meta.months).reduce((sum, m) => sum + m.conversations, 0);
      meta.updatedAt = new Date().toISOString();
      await writeFileInDir(tsumugiDir, "history-meta.json", JSON.stringify(meta, null, 2), "history meta write");
    } else {
      logTimingEvent("HistoryIndex update:meta-unchanged", { kind: update.kind });
    }
  });

  logTimingEvent("HistoryIndex update:end", { kind: update.kind, durationMs: Date.now() - historyIndexStart });
}

/**
 * History一覧専用の軽量プレビュー文字列を作る（重要修正2）。通常Memoryの`summary`は
 * 元々20〜40文字程度の一行要約だが、Reflectionの`summary`は振り返り全文そのもの
 * （`src/lib/reflection.ts`参照）であり、そのままIndexへ入れると1件で肥大化しうる。
 * ここで一律に切り詰めることで「Markdown本体＝完全な内容」「History Index preview＝
 * 一覧用の軽量表示」という役割を明確にする。日本語の文字境界（サロゲートペア等）を
 * 厳密に考慮した高度な切り詰めは行わない、単純な`slice`で構わない（要求通り）。
 */
const HISTORY_PREVIEW_MAX_LENGTH = 80;

export function truncateHistoryPreview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > HISTORY_PREVIEW_MAX_LENGTH ? trimmed.slice(0, HISTORY_PREVIEW_MAX_LENGTH) : trimmed;
}

/**
 * lazy upgrade専用（Step 3、HistoryPanel.tsx）。v1形状の日を実際に開き、既存の
 * fallback経路（`readMemoriesForDay`/`readReflectionById`/`readConversationById`）で
 * 取得済みのデータから組み立てたv2 entryを、その日だけ月Indexへ永続化する。
 * Vault全体のscan・月全体のbackfillは一切行わない（呼び出し元が既に読み終えた
 * 1日分のデータを渡すだけで、この関数自体は追加のMarkdown readを一切行わない）。
 *
 * 冪等性：`computeUpdatedDayEntry`の"day-upgrade"分岐が、既にv2化済みの日には
 * 一切上書きしないため、同じ日に対して複数回呼ばれても安全（2回目以降は
 * 実質的なno-opになり、`isDayIndexEqual`によりファイル書き込み自体もskipされる）。
 *
 * 失敗時の扱い：既存の`updateHistoryIndex`と同じくエラーを一切catchしない。
 * 呼び出し元（HistoryPanel.tsx）は、この呼び出しをfire-and-forgetで扱い、
 * 失敗してもHistory表示自体（既にfallbackで取得済みのデータによる表示）を
 * 失敗させないこと（catchしてconsole.errorに残すだけにとどめる）。
 */
export async function upgradeHistoryDayToV2(
  root: FileSystemDirectoryHandle,
  day: string,
  entry: HistoryDayIndexV2
): Promise<void> {
  await updateHistoryIndex(root, { kind: "day-upgrade", day, entry });
}

/**
 * History Index読み取り側（低レベルのプリミティブのみ）。読み取りはロックを
 * 取得しない——書き込みと競合しても「わずかに
 * 古い目次を読む」だけであり、カレンダー表示用途では実害が無いため（既存の
 * `readJSON`と同じ、存在しない/壊れている場合は安全な既定値へfallbackする方針を踏襲）。
 */
export async function readHistoryMeta(root: FileSystemDirectoryHandle): Promise<HistoryMeta> {
  try {
    const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
    return await readJSON<HistoryMeta>(tsumugiDir, "history-meta.json", emptyHistoryMeta(), "history meta read");
  } catch {
    return emptyHistoryMeta();
  }
}

export async function readHistoryMonthIndex(root: FileSystemDirectoryHandle, month: string): Promise<HistoryMonthIndex> {
  try {
    const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
    const historyDir = await tsumugiDir.getDirectoryHandle("history", { create: false });
    return await readJSON<HistoryMonthIndex>(historyDir, `${month}.json`, emptyMonthIndex(month), "history month read");
  } catch {
    return emptyMonthIndex(month);
  }
}

/**
 * 指定日のMemory（day-file統合分）だけを読む。Reflection Summary（1record1file）は
 * 含まれない——`readReflectionById`で別途idごとに読むこと。
 */
export async function readMemoriesForDay(root: FileSystemDirectoryHandle, day: string): Promise<MemoryObject[]> {
  try {
    const dir = await root.getDirectoryHandle("Memories", { create: false });
    return await readDayFileEntries(dir, dayFileNameFor(day));
  } catch {
    return [];
  }
}

/**
 * `HistoryDayIndex.reflectionIds`の1件を、idと日付からファイル名を再構築して読む。
 * `memoriesDir`（省略可）：同じ日に複数のreflectionIdsを読む場合、呼び出し元
 * （HistoryPanel.tsx）が`Memories`ディレクトリハンドルを1回だけ解決して使い回せる
 * ようにするための任意引数。省略時は従来通りこの関数自身が`root`から解決する
 * （後方互換。History以外の既存呼び出し元は無いが、念のため省略可能にしてある）。
 */
export async function readReflectionById(
  root: FileSystemDirectoryHandle,
  id: string,
  day: string,
  memoriesDir?: FileSystemDirectoryHandle
): Promise<MemoryObject | null> {
  try {
    const dir = memoriesDir ?? (await root.getDirectoryHandle("Memories", { create: false }));
    const fileHandle = await dir.getFileHandle(fileNameFor(id, day), { create: false });
    const file = await fileHandle.getFile();
    return parseMemoryObjectMarkdown(await file.text());
  } catch {
    return null;
  }
}

/**
 * `HistoryDayIndex.conversationIds`の1件を、idと日付からファイル名を再構築して読む。
 * `conversationsDir`（省略可）：`readReflectionById`の`memoriesDir`と同じ理由・同じ
 * 後方互換の任意引数。
 */
export async function readConversationById(
  root: FileSystemDirectoryHandle,
  id: string,
  day: string,
  conversationsDir?: FileSystemDirectoryHandle
): Promise<Conversation | null> {
  try {
    const dir = conversationsDir ?? (await root.getDirectoryHandle("Conversations", { create: false }));
    const fileHandle = await dir.getFileHandle(fileNameFor(id, day), { create: false });
    const file = await fileHandle.getFile();
    return parseConversationMarkdown(await file.text());
  } catch {
    return null;
  }
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
  const dir = await timedIOStep("conversation dirHandle", () => root.getDirectoryHandle("Conversations", { create: true }));

  // Vault Registry（Step 2）：真の新規recordは現行命名規則、既存recordは
  // registry記載のactual pathへ。needs-resync/missing/conflictは書き込み保留。
  const registryKey = conversation.id;
  const lookup = await lookupVaultRegistryRecord(root, registryKey);
  let targetDir = dir;
  let fileName: string;
  let relativePath: string;
  if (lookup.entry === undefined) {
    fileName = fileNameFor(conversation.id, conversation.startedAt);
    relativePath = `Conversations/${fileName}`;
  } else if (lookup.entry.status === "ok") {
    relativePath = lookup.path as string;
    const resolved = await resolveVaultRelativePath(root, relativePath);
    targetDir = resolved.dir;
    fileName = resolved.fileName;
    // Critical/High修正：write前に実ファイルの存在・内容整合性を検証する
    // （旧pathへの自動再作成・外部編集の無条件上書きを防ぐ）。
    await verifyVaultRegistryEntryBeforeWrite(root, registryKey, targetDir, fileName, lookup.entry);
  } else {
    throw new VaultRecordNeedsResyncError("conversation", registryKey, lookup.entry.status);
  }

  const renderStart = Date.now();
  const content = conversationToMarkdown(conversation);
  logSyncStep("conversation render", Date.now() - renderStart);
  await writeFileInDir(targetDir, fileName, content, "conversation");
  await updateIndex(root, conversation.id, relativePath);
  // History Index（Step 1、v2でmode/turnCountを追加）：Markdown本体の書き込みが
  // 成功した直後に更新する。ここでcatchして握り潰さない——失敗すればこの関数全体が
  // 失敗として呼び出し元へ伝わり、vaultSyncStateが更新されないため、次回flush時に
  // 本体・Index更新の両方が自然に再試行される（詳細はupdateHistoryIndexのコメント参照）。
  // modeはpersona!=="companion"を一律"conversation"へ正規化する（coach/analyst問わず、
  // History上は「日記」「会話」の2つにしか表示しない、という表示名正規化）。
  const mode: HistoryConversationMode = conversation.persona === "companion" ? "diary" : "conversation";
  await updateHistoryIndex(root, {
    kind: "conversation",
    id: conversation.id,
    day: conversation.startedAt.slice(0, 10),
    mode,
    turnCount: conversation.turns.length,
  });

  // Vault Registry（Step 2）：Markdown write成功後にのみ更新する（本体が保存されて
  // いないのにregistryだけ先行して"ok"になる状態を作らない）。既存の
  // 保存フロー（Markdown→旧index.json→History Index）は変更せず、その後に追加する。
  const stat = await readVaultFileStat(targetDir, fileName);
  await upsertVaultRegistryRecord(root, {
    registryKey,
    path: relativePath,
    recordType: "conversation",
    mtime: stat.mtime,
    size: stat.size,
    contentHash: hashVaultText(content),
    memberIds: [conversation.id],
  });
}

export async function writeConversationMarkdown(
  root: FileSystemDirectoryHandle,
  conversation: Conversation,
  priority: VaultWritePriority = "interactive"
): Promise<void> {
  await enqueueVaultWrite(
    () => writeConversationMarkdownImpl(root, conversation),
    priority,
    vaultSyncKeyFor("conversation", conversation.id)
  );
  await markVaultSynced("conversation", conversation.id, conversation.updatedAt);
}

/**
 * Source基盤（最小構成）のVault保存。1 Source = 1 Markdown（既存のConversationと同じくfileNameFor、
 * Memoryの日別統合は適用しない。STORAGE.md §3）。`Sources/`が無ければ既存パターン通り
 * `{ create: true }`で作成する。SourceにはMemoryObjectのような`date`が無いため、`createdAt`を使う。
 */
async function writeSourceMarkdownImpl(root: FileSystemDirectoryHandle, source: Source) {
  const dir = await timedIOStep("source dirHandle", () => root.getDirectoryHandle("Sources", { create: true }));

  // Vault Registry（Step 2）：Conversationと同じ分岐（真の新規／既存recordの
  // registry path／needs-resync等でwrite保留）。
  const registryKey = source.id;
  const lookup = await lookupVaultRegistryRecord(root, registryKey);
  let targetDir = dir;
  let fileName: string;
  let relativePath: string;
  if (lookup.entry === undefined) {
    fileName = fileNameFor(source.id, source.createdAt);
    relativePath = `Sources/${fileName}`;
  } else if (lookup.entry.status === "ok") {
    relativePath = lookup.path as string;
    const resolved = await resolveVaultRelativePath(root, relativePath);
    targetDir = resolved.dir;
    fileName = resolved.fileName;
    // Critical/High修正：write前に実ファイルの存在・内容整合性を検証する。
    await verifyVaultRegistryEntryBeforeWrite(root, registryKey, targetDir, fileName, lookup.entry);
  } else {
    throw new VaultRecordNeedsResyncError("source", registryKey, lookup.entry.status);
  }

  const renderStart = Date.now();
  const content = sourceToMarkdown(source);
  logSyncStep("source render", Date.now() - renderStart);
  await writeFileInDir(targetDir, fileName, content, "source");
  await updateIndex(root, source.id, relativePath);

  // Vault Registry（Step 2）：Markdown write成功後にのみ更新する。
  const stat = await readVaultFileStat(targetDir, fileName);
  await upsertVaultRegistryRecord(root, {
    registryKey,
    path: relativePath,
    recordType: "source",
    mtime: stat.mtime,
    size: stat.size,
    contentHash: hashVaultText(content),
    memberIds: [source.id],
  });
}

export async function writeSourceMarkdown(
  root: FileSystemDirectoryHandle,
  source: Source,
  priority: VaultWritePriority = "interactive"
): Promise<void> {
  await enqueueVaultWrite(() => writeSourceMarkdownImpl(root, source), priority, vaultSyncKeyFor("source", source.id));
  await markVaultSynced("source", source.id, source.updatedAt);
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
  const dir = await timedIOStep("memory dirHandle", () => root.getDirectoryHandle("Memories", { create: true }));

  if (isReflectionSummary(memoryObject)) {
    // Vault Registry（Step 2）：Reflectionは1record1fileのため、Conversation/Sourceと
    // 同じ分岐（真の新規／既存recordのregistry path／needs-resync等でwrite保留）。
    const registryKey = memoryObject.id;
    const lookup = await lookupVaultRegistryRecord(root, registryKey);
    let targetDir = dir;
    let fileName: string;
    let relativePath: string;
    if (lookup.entry === undefined) {
      fileName = fileNameFor(memoryObject.id, memoryObject.date);
      relativePath = `Memories/${fileName}`;
    } else if (lookup.entry.status === "ok") {
      relativePath = lookup.path as string;
      const resolved = await resolveVaultRelativePath(root, relativePath);
      targetDir = resolved.dir;
      fileName = resolved.fileName;
      // Critical/High修正：write前に実ファイルの存在・内容整合性を検証する。
      await verifyVaultRegistryEntryBeforeWrite(root, registryKey, targetDir, fileName, lookup.entry);
    } else {
      throw new VaultRecordNeedsResyncError("reflection", registryKey, lookup.entry.status);
    }

    const renderStart = Date.now();
    const content = memoryObjectToMarkdown(memoryObject);
    logSyncStep("memory render", Date.now() - renderStart);
    await writeFileInDir(targetDir, fileName, content, "memory");
    await updateIndex(root, memoryObject.id, relativePath);
    // History Index（Step 1、v2でpreviewを追加）：Reflection Summaryは1record1file
    // のため、月Indexへidベースでupsertする（`computeUpdatedDayEntryV2`参照。
    // 既存ロジックでidの有無から判定させる）。previewはReflection本文（summary＝
    // 全文）をHistory一覧用に切り詰めたものであり、Markdown本体は変更しない。
    // ここでもcatchせず、失敗をそのまま伝播させる。
    await updateHistoryIndex(root, {
      kind: "reflection",
      id: memoryObject.id,
      day: memoryObject.date.slice(0, 10),
      preview: truncateHistoryPreview(memoryObject.summary),
      createdAt: memoryObject.createdAt,
    });

    // Vault Registry（Step 2）：Markdown write成功後にのみ更新する。
    const stat = await readVaultFileStat(targetDir, fileName);
    await upsertVaultRegistryRecord(root, {
      registryKey,
      path: relativePath,
      recordType: "reflection",
      mtime: stat.mtime,
      size: stat.size,
      contentHash: hashVaultText(content),
      memberIds: [memoryObject.id],
    });

    memoryObject.metadata.obsidian = {
      ...memoryObject.metadata.obsidian,
      vaultPath: relativePath,
    };
    return;
  }

  // Vault Registry（Step 2）：normal Memoryはday-file container単位で判定する
  // （メンバーidそれぞれではなく、day-file自体の所在＝`dayFileRegistryKey(day)`の
  // 状態を見る）。containerがneeds-resync/missing/conflictの場合、対象memoryObjectが
  // 真に新規のidであっても、その日のwrite全体を保留する（新しいday-fileを別途
  // 作ってしまうと、外部で移動されただけの旧day-fileと重複する可能性があるため）。
  const day = memoryObject.date.slice(0, 10);
  const registryKey = dayFileRegistryKey(day);
  const lookup = await lookupVaultRegistryRecord(root, registryKey);
  let targetDir = dir;
  let fileName: string;
  let relativePath: string;
  // Critical/High修正：write前検証で既にday-file本文を読んだ場合、そのテキストを
  // ここへ受け取り、直後のmerge処理でそのまま再利用する（二重読み込みを避ける。
  // 外部編集済みのday-fileをverify後に「もう一度」読み直して暗黙的に採用する、
  // という経路を作らないため）。
  let verifiedActualText: string | undefined;
  if (lookup.entry === undefined) {
    fileName = dayFileNameFor(memoryObject.date);
    relativePath = `Memories/${fileName}`;
  } else if (lookup.entry.status === "ok") {
    relativePath = lookup.path as string;
    const resolved = await resolveVaultRelativePath(root, relativePath);
    targetDir = resolved.dir;
    fileName = resolved.fileName;
    // Critical/High修正：day-fileのmerge材料として読む前に、実ファイルの存在・
    // 内容整合性を検証する。外部で移動/削除・外部編集されているday-fileを
    // そのまま読み込んでmergeし、暗黙的に外部変更を採用してしまう経路を作らない。
    const verifyResult = await verifyVaultRegistryEntryBeforeWrite(root, registryKey, targetDir, fileName, lookup.entry);
    verifiedActualText = verifyResult.actualText;
  } else {
    throw new VaultRecordNeedsResyncError("memory-day", registryKey, lookup.entry.status);
  }

  const existingEntries =
    verifiedActualText !== undefined
      ? parseMemoryDayFile(verifiedActualText)
      : await timedIOStep("memory existingRead", () => readDayFileEntries(targetDir, fileName));
  const otherEntries = existingEntries.filter((memory) => memory.id !== memoryObject.id);
  const mergeStart = Date.now();
  const merged = [...otherEntries, memoryObject].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const serialized = serializeMemoryDayFile(merged);
  logSyncStep("memory render", Date.now() - mergeStart);

  await writeFileInDir(targetDir, fileName, serialized, "memory");
  await updateIndex(root, memoryObject.id, relativePath);
  // History Index（Step 1、Codexレビュー指摘対応。v2でnormalMemories配列を追加）：
  // day-fileへ実際に書き込んだ後のマージ済み配列（絶対値）を、そのまま軽量化して
  // 渡す。「新規か更新か」をここで判定して差分加算する設計は、retry時にday-fileへ
  // 既にそのidが存在するため常に「更新」と誤判定され、Index側の件数が永続的に
  // ずれる不具合があったため廃止した（`updateHistoryIndex`側は絶対値から
  // 再計算するため、何度retryしても同じ正しい値へ収束する）。previewは追加の
  // Markdown readを伴わない（`merged`は既にこの関数内で読み込み・マージ済み）。
  // catchせず、失敗をそのまま伝播させる（次回flushで本体・Index更新ともに再試行）。
  await updateHistoryIndex(root, {
    kind: "memory",
    day,
    normalMemories: merged.map((m) => ({
      id: m.id,
      types: m.types,
      preview: truncateHistoryPreview(m.summary),
      createdAt: m.createdAt,
    })),
  });

  // Vault Registry（Step 2）：Markdown write成功後にのみ更新する。memberIds/
  // memberHashesはday-file container単位（このpathに現在含まれる全メンバー）で
  // 持つ——個々のMemory idを`records`へ個別登録することはしない。memberHashesは
  // メンバーごとの個別ハッシュ（`memoryObjectToMarkdown`で1件分だけを再シリアライズ
  // した文字列のハッシュ）で、将来の再同期がday-file内のどのidが変化したかを
  // 特定するために使う。
  const stat = await readVaultFileStat(targetDir, fileName);
  const memberHashes: Record<string, string> = {};
  for (const member of merged) {
    memberHashes[member.id] = hashVaultText(memoryObjectToMarkdown(member));
  }
  await upsertVaultRegistryRecord(root, {
    registryKey,
    path: relativePath,
    recordType: "memory-day",
    mtime: stat.mtime,
    size: stat.size,
    contentHash: hashVaultText(serialized),
    memberIds: merged.map((m) => m.id),
    memberHashes,
  });

  memoryObject.metadata.obsidian = {
    ...memoryObject.metadata.obsidian,
    vaultPath: relativePath,
  };
}

export async function writeMemoryObjectMarkdown(
  root: FileSystemDirectoryHandle,
  memoryObject: MemoryObject,
  priority: VaultWritePriority = "interactive"
): Promise<void> {
  await enqueueVaultWrite(
    () => writeMemoryObjectMarkdownImpl(root, memoryObject),
    priority,
    vaultSyncKeyFor("memory", memoryObject.id)
  );
  await markVaultSynced("memory", memoryObject.id, memoryObject.updatedAt);
}

/**
 * Vaultが未接続の間にIndexedDBへ先行保存された記憶を、
 * 接続確立の直後にまとめてMarkdownへ書き出す（データロス防止）。
 * Source基盤（最小構成）も同じ扱いにする：IndexedDBにはあるがVaultに無いSourceを書き戻す。
 *
 * Beta修正：起動のたびに全件を無条件で書き直すと、Android実機ではVault write 1回が
 * 1.3〜2.8秒かかることもあり、蓄積データ量に比例して起動直後に長い背景処理が発生する。
 * さらにこの背景処理がユーザー操作の保存と同じ列に並ぶことで、終了操作の保存が
 * 数秒〜数十秒待たされる問題が実測で確認された（詳細は本ファイル冒頭の優先度付き
 * キューのコメント参照）。
 *
 * 対策：各itemについて、同期済み台帳（vaultSyncState）のupdatedAtと現在のupdatedAtが
 * 一致する場合はVaultへのwrite自体を行わない（Vault側のMarkdownは読まず、IndexedDB内の
 * 軽量な台帳だけで判定する）。台帳に記録が無い・値が異なる場合は、これまで通り
 * 書き込む。ここから発行されるwriteは全て`"background"`優先度にし、ユーザー操作由来の
 * writeが後ろに並ばされないようにする（同時実行は引き続き1件だけなので、
 * index.json・Memory日別ファイルへの同時書き込み事故は発生しない）。
 *
 * Beta修正：各itemのwriteを個別のtry/catchで分離する。以前は1件のwriteが失敗すると
 * flushPendingToVault全体が例外を投げて終了し、それ以降の全item（同じ種別の残り・
 * 後続の種別すべて）が一切試行されなかった（＝sync ledgerへも記録されず、次回起動時も
 * 同じitemが未同期のまま残り続けてしまう）。1件の失敗は握りつぶさずログに残しつつ、
 * 他のitemの処理は必ず継続する（write成功時だけledgerが更新される、という既存の
 * 安全性は変更しない。失敗したitemは今回もledgerがsynced扱いにならないため、
 * 次回起動時のflushで自然に再試行される）。
 *
 * Vault境界の安全な切替（Conversation品質改善とは別軸）：呼び出し元（ChatScreen.tsxの
 * Vault切替フロー）が「Aへの書き戻しが本当に全件成功したか」を判定できるよう、
 * `writtenCount`に加えて`failedCount`も返すようにした（既存の3呼び出し元は戻り値を
 * 使っていないため、返す値を増やしても後方互換）。1件でも失敗があれば、呼び出し元は
 * 「IndexedDBをclearしない・別Vaultへ切り替えない」という安全側の判断に使う。
 * `priority`はデフォルト"background"のまま（既存の挙動を変えない）。Vault切替の
 * ユーザー確認直後のような、応答性が求められる文脈からは"interactive"を渡せるようにした。
 */
export interface FlushResult {
  totalCount: number;
  writtenCount: number;
  failedCount: number;
}

/**
 * `signal`（省略可、既存呼び出し元は省略のままで従来通り動作）：Android Vault問題
 * （background flushがVault切替の排他ロック取得を長時間ブロックする）対応。
 * 3つのループそれぞれで、次のitemを処理する直前にのみ`signal?.aborted`を確認し、
 * abortされていればその時点までの集計を返して早期終了する（whole-item boundary。
 * `writeConversationMarkdown`/`writeMemoryObjectMarkdown`本体・その内部の
 * History Index更新・`markVaultSynced`の実行中にabortを差し込むことは無い——
 * 既に開始した1件は必ず最後まで完了させる）。中断されたitemは`markVaultSynced`が
 * 呼ばれないため、次回flush時に`isAlreadySyncedToVault`が未同期と正しく判定し、
 * 自然に再試行される（sync ledger・History Indexいずれのロジックも変更しない）。
 */
export async function flushPendingToVault(
  root: FileSystemDirectoryHandle,
  priority: VaultWritePriority = "background",
  signal?: AbortSignal
): Promise<FlushResult> {
  const flushStart = Date.now();
  const [conversations, memoryObjects, sources] = await Promise.all([
    getAllConversations(),
    getAllMemoryObjects(),
    getAllSources(),
  ]);
  const totalCount = conversations.length + memoryObjects.length + sources.length;
  console.log(`[Vault] flush:start count=${totalCount}`);
  logTimingEvent("Vault flush:start", { count: totalCount });

  let writtenCount = 0;
  let failedCount = 0;
  for (const conversation of conversations) {
    if (signal?.aborted) {
      logTimingEvent("Vault flush:aborted", { count: totalCount, writtenCount });
      return { totalCount, writtenCount, failedCount };
    }
    if (await isAlreadySyncedToVault("conversation", conversation.id, conversation.updatedAt)) continue;
    try {
      await writeConversationMarkdown(root, conversation, priority);
      writtenCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error("[Tsumugi] flush: conversation write failed (will retry on next flush):", error);
    }
  }
  for (const memoryObject of memoryObjects) {
    if (signal?.aborted) {
      logTimingEvent("Vault flush:aborted", { count: totalCount, writtenCount });
      return { totalCount, writtenCount, failedCount };
    }
    if (await isAlreadySyncedToVault("memory", memoryObject.id, memoryObject.updatedAt)) continue;
    try {
      await writeMemoryObjectMarkdown(root, memoryObject, priority);
      writtenCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error("[Tsumugi] flush: memory write failed (will retry on next flush):", error);
    }
  }
  for (const source of sources) {
    if (signal?.aborted) {
      logTimingEvent("Vault flush:aborted", { count: totalCount, writtenCount });
      return { totalCount, writtenCount, failedCount };
    }
    if (await isAlreadySyncedToVault("source", source.id, source.updatedAt)) continue;
    try {
      await writeSourceMarkdown(root, source, priority);
      writtenCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error("[Tsumugi] flush: source write failed (will retry on next flush):", error);
    }
  }

  const flushDurationMs = Date.now() - flushStart;
  console.log(
    `[Vault] flush:end count=${totalCount} writtenCount=${writtenCount} failedCount=${failedCount} durationMs=${flushDurationMs}`
  );
  logTimingEvent("Vault flush:end", { count: totalCount, writtenCount, durationMs: flushDurationMs });
  return { totalCount, writtenCount, failedCount };
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

/**
 * 修正案A（Android Vault scan高速化）：以前はこの関数が自前で`fileHandle.getFile()`を
 * 呼んでいたため、`collectVaultMarkdown`側が全文読み込み用に別途もう一度`getFile()`を
 * 呼ぶ形になり、1候補ファイルにつき`getFile()`が2回発生していた。呼び出し元が既に
 * 取得済みの同じ`File`を渡す形に変更し、`getFile()`は1ファイルにつき1回だけにする。
 * 判定ロジック（先頭`TSUMUGI_PROBE_BYTES`バイトの内容確認）自体は変更しない。
 */
async function isLikelyTsumugiFile(file: File): Promise<boolean> {
  const head = await file.slice(0, TSUMUGI_PROBE_BYTES).text();
  return head.startsWith("---\ntsumugi: true\n") || head.includes("\ntsumugi: true\n");
}

/**
 * Android Vault問題（in-flight scanの協調的キャンセル）：呼び出し元
 * （ChatScreen.tsxのstartVaultRestoreScan）が新しいVault切替操作の開始と同時に
 * `abort()`した場合、ここで即座に例外を投げて呼び出し元（collectVaultMarkdown・
 * scanVaultForRestore）を早期終了させる。`AbortError`という名前で投げることで、
 * 呼び出し元がこれを通常のI/Oエラーと区別できるようにする。
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Vault scan aborted", "AbortError");
  }
}

/**
 * Android Vault問題（allSettled後のerror優先順位）：`Promise.allSettled`で
 * 集めた各collectorのreject理由が、このscan自身の`signal`によるキャンセル
 * （`throwIfAborted`が投げたもの）かどうかを判別する。`error.name === "AbortError"`
 * だけでなく、対応する`signal`が実際に`aborted === true`であることも確認する
 * （他所由来のAbortErrorを誤って「自前cancel」として握りつぶさないため。
 * ChatScreen.tsxの`isOwnAbortError`と同じ考え方）。
 */
function isSelfAbortRejection(reason: unknown, signal?: AbortSignal): boolean {
  return reason instanceof DOMException && reason.name === "AbortError" && Boolean(signal?.aborted);
}

async function collectVaultMarkdown(
  dir: FileSystemDirectoryHandle,
  folderName: string,
  insideTarget = false,
  depth = 0,
  // TEMP-TEST：Android実機でのVault scan停止事象の原因切り分け用。対象フォルダ内で
  // 見つかった候補ファイルに単純な連番を振るためだけの共有カウンタ（再帰呼び出し間で
  // 共有するためオブジェクト参照で渡す）。ファイル名・パスは持たない。
  sequenceRef: { value: number } = { value: 0 },
  // Android Vault問題（in-flight scanの協調的キャンセル）：省略時（undefined）は
  // 常にabortされない扱い（既存の呼び出し元・挙動を変えない）。
  signal?: AbortSignal
): Promise<string[]> {
  if (!insideTarget && depth > FOLDER_SEARCH_MAX_DEPTH) return [];

  // Android Vault問題（in-flight scanの協調的キャンセル）：このディレクトリの処理
  // （dir.entries()の反復）を始める直前にも確認する（各entryごとのチェックとは別に、
  // ディレクトリそのものへ入る前のチェックポイント）。
  throwIfAborted(signal);

  // TEMP-TEST：Android実機でのVault scan停止事象の原因切り分け用。ディレクトリ単位の
  // 開始・終了だけを記録する（フォルダ名・ファイル名・パス・Markdown本文は一切出さない）。
  // 既存の分岐・戻り値は一切変更しない。
  const dirStart = Date.now();
  logTimingEvent("Vault collectDir:enter", { target: folderName, depth, insideTarget: insideTarget ? 1 : 0 });
  let entryCount = 0;

  const contents: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    // Android Vault問題（in-flight scanの協調的キャンセル）：各ディレクトリ・
    // 各ファイルの処理に入る直前に確認する。abort済みなら、ここまでに集めた
    // 部分的な`contents`は一切返さず（呼び出し元も含め、部分結果は使わない）、
    // 即座に例外で打ち切る。
    throwIfAborted(signal);
    entryCount += 1;
    if (name.startsWith(HIDDEN_PREFIX)) continue;

    if (handle.kind === "directory") {
      const nowInsideTarget = insideTarget || name === folderName;
      contents.push(
        ...(await collectVaultMarkdown(handle, folderName, nowInsideTarget, depth + 1, sequenceRef, signal))
      );
      continue;
    }

    if (!insideTarget || !name.endsWith(".md")) continue;

    // TEMP-TEST：Android実機でのVault scan停止事象の原因切り分け用。対象フォルダ内の
    // 候補ファイルについて、getFile→probe（isLikelyTsumugiFile）→file.textの各段階を
    // 個別に計測する。ファイル名・パス・本文は一切出さず、連番（sequenceNumber）と
    // 所要時間・サイズだけを記録する。catchは全てログ出力後に必ず同じ例外を再throwし、
    // 既存の分岐・戻り値・エラー伝播は変更しない。
    // 修正案A：以前はisLikelyTsumugiFile内部とここでそれぞれ別々にgetFile()していた
    // （1候補ファイルにつき2回）。ここで一度だけ取得し、probe・全文読み込みの両方で
    // 同じFileオブジェクトを再利用する（1候補ファイルにつきgetFile()は1回）。
    const seq = ++sequenceRef.value;

    logTimingEvent("Vault getFile:start", { target: folderName, sequenceNumber: seq });
    const getFileStart = Date.now();
    let file: File;
    try {
      file = await handle.getFile();
    } catch (error) {
      logTimingEvent("Vault getFile:error", { target: folderName, sequenceNumber: seq });
      throw error;
    }
    logTimingEvent("Vault getFile:end", {
      target: folderName,
      sequenceNumber: seq,
      durationMs: Date.now() - getFileStart,
      sizeBytes: file.size,
    });
    // Android Vault問題（in-flight scanの協調的キャンセル）：await handle.getFile()の
    // 直後にも確認する。
    throwIfAborted(signal);

    logTimingEvent("Vault probeFile:start", { target: folderName, sequenceNumber: seq });
    const probeStart = Date.now();
    let likely: boolean;
    try {
      likely = await isLikelyTsumugiFile(file);
    } catch (error) {
      logTimingEvent("Vault probeFile:error", { target: folderName, sequenceNumber: seq });
      throw error;
    }
    logTimingEvent("Vault probeFile:end", {
      target: folderName,
      sequenceNumber: seq,
      durationMs: Date.now() - probeStart,
      likely: likely ? 1 : 0,
    });
    // Android Vault問題（in-flight scanの協調的キャンセル）：probe読込の直後にも確認する。
    throwIfAborted(signal);
    if (!likely) continue;

    logTimingEvent("Vault readFile:start", { target: folderName, sequenceNumber: seq });
    const readStart = Date.now();

    logTimingEvent("Vault fileText:start", { target: folderName, sequenceNumber: seq });
    const textStart = Date.now();
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      logTimingEvent("Vault fileText:error", { target: folderName, sequenceNumber: seq });
      throw error;
    }
    logTimingEvent("Vault fileText:end", {
      target: folderName,
      sequenceNumber: seq,
      durationMs: Date.now() - textStart,
    });
    // Android Vault問題（in-flight scanの協調的キャンセル）：await file.text()の
    // 直後にも確認する。
    throwIfAborted(signal);

    logTimingEvent("Vault readFile:end", {
      target: folderName,
      sequenceNumber: seq,
      durationMs: Date.now() - readStart,
      sizeBytes: file.size,
    });

    contents.push(text);
  }
  logTimingEvent("Vault collectDir:exit", {
    target: folderName,
    depth,
    insideTarget: insideTarget ? 1 : 0,
    entryCount,
    durationMs: Date.now() - dirStart,
  });
  // Android Vault問題（in-flight scanの協調的キャンセル）：呼び出し元へcontentsを
  // 返す直前にも確認する（collector return直前）。
  throwIfAborted(signal);
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
export async function scanVaultForRestore(
  root: FileSystemDirectoryHandle,
  // Android Vault問題（in-flight scanの協調的キャンセル）：省略時（undefined）は
  // 常にabortされない扱い（既存の呼び出し元・挙動を変えない）。
  signal?: AbortSignal
): Promise<VaultScanResult> {
  const scanStart = Date.now();
  console.log(`[Vault] scan:start`);
  logTimingEvent("Vault scan:start");
  throwIfAborted(signal);
  let skippedCount = 0;

  // TEMP-TEST：Android実機でのVault scan停止事象の原因切り分け用。Conversations/
  // Memories/Sourcesのどれが完了していないかをフェーズ単位で観測するだけのラッパー。
  // collectVaultMarkdown自体の戻り値・分岐は変更しない。
  const collectWithPhaseLog = async (folderName: string): Promise<string[]> => {
    const phaseStart = Date.now();
    logTimingEvent("Vault collect:start", { target: folderName });
    const result = await collectVaultMarkdown(root, folderName, false, 0, { value: 0 }, signal);
    logTimingEvent("Vault collect:end", {
      target: folderName,
      fileCount: result.length,
      durationMs: Date.now() - phaseStart,
    });
    return result;
  };

  // Android Vault問題（abort後の旧scanを完全に終了させる）：Promise.allではなく
  // Promise.allSettledを使う。Promise.allは1本目がrejectした時点で（他の2本が
  // まだ実行中でも）即座にrejectしてしまい、呼び出し元（checkForRestoreCandidateImpl）
  // 側でこの関数のPromiseが解決したと見なされ、共有ロック・pending taskが「まだ
  // 実際にはI/Oが続いている」うちに解放されてしまう。Conversations/Memories/
  // Sourcesの3つ全てが（成功・失敗・abortのいずれであれ）完全に終了するのを待って
  // から、初めてこの関数自体の結果（成功・エラー・abort）を決定する。
  const settledResults = await Promise.allSettled([
    collectWithPhaseLog("Conversations"),
    collectWithPhaseLog("Memories"),
    collectWithPhaseLog("Sources"),
  ]);

  // Android Vault問題（allSettled後のerror優先順位）：3つ全てが終了した後、
  // 「自前abort由来と判別できないrejection＝通常I/Oエラー」を最優先で確認する。
  // signal.abortedを先に見てしまうと、「通常のI/Oエラーが発生した直後に、たまたま
  // 別のVault切替でabortも要求されていた」場合に、本来のI/Oエラーがabort扱いで
  // 隠れてしまう（呼び出し元がconsole.errorへ出すべき異常を見逃す）ため、順序を
  // 誤らないこと。
  const rejectedResults = settledResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  const genuineError = rejectedResults.find((result) => !isSelfAbortRejection(result.reason, signal));
  if (genuineError) {
    // 1〜2. 通常I/Oエラーが1つでもあれば、abort有無に関わらずそれを最優先でthrowする。
    throw genuineError.reason;
  }

  // 3. 通常エラーは無かった。rejectedResultsに何か残っている（＝自前abortだけが
  // rejectしている）か、signal自体がabort済みであれば、この関数全体を自前cancelとして
  // 終了する（一部のcollectorが偶然成功していても、その結果は一切使わない＝
  // 呼び出し元へ部分結果を渡さない）。
  if (rejectedResults.length > 0 || signal?.aborted) {
    throw new DOMException("Vault scan aborted", "AbortError");
  }

  // 4. 全成功。
  const [conversationFiles, memoryFiles, sourceFiles] = settledResults.map(
    (result) => (result as PromiseFulfilledResult<string[]>).value
  );
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

// ---------------------------------------------------------------------------
// Vault Registry（所在registry、Step 1：型・読み書きprimitive・専用Lockのみ）
//
// 「ユーザーが外部からMarkdownを手動で移動・編集・追加・削除した場合にTsumugiが
// 再認識できるようにする」設計（別途合意済みの設計投稿を参照）のうち、Step 1の
// スコープにあたる。既存の`.tsumugi/index.json`（`updateIndex`、id→pathの
// 平坦map、書き込み専用で読み込みには使われていない）とは別の、新しいファイル群
// として追加する。既存のindex.json・History Index・read/write実装（
// readConversationById/readReflectionById/readMemoriesForDay/
// writeConversationMarkdownImpl/writeMemoryObjectMarkdownImpl等）は本Stepでは
// 一切変更しない（このセクションの型・関数は、まだどこからも呼ばれない）。
//
// shard分割方式（重要・月単位ではなくhash bucket単位）：registryの役割は
// 「日付とactual pathを切り離すこと」そのものであるため、registry自身の
// shard分割を日付（月）に依存させない。History Index（history/YYYY-MM.json）は
// 表示が日付単位である以上、月shardのままでよいが、registryは将来のtimezone
// 変更・日付の編集があってもshard構成そのものは一切変わらない必要がある。
// そのため、registryKey（idまたは`dayFileRegistryKey`が返す合成キー）自体の
// ハッシュ値から`bucket = hash(registryKey) % VAULT_REGISTRY_BUCKET_COUNT`を
// 計算し、bucket番号のファイルへ振り分ける。Conversation/Reflection/Sourceの
// path解決は「id→bucket→shard→path」だけで完結し、day/date/monthを一切
// 経由しない。64bucketを事前に全部作る必要はなく、実際に使うbucketのファイルだけ
// 都度作成する（`{ create: true }`のwriteFileInDir/getDirectoryHandleが
// 既存パターン通り遅延作成する）。
//
// 配置：
//   .tsumugi/registry-meta.json  … 極小のメタ情報（schemaVersion・最終再同期時刻）
//   .tsumugi/registry/NN.json    … bucket番号（0〜63、2桁16進、"00"〜"3f"）ごとの
//                                  record/file所在情報
//
// record/file分離構造：Conversation/Reflection/Sourceは1record=1fileだが、
// normal Memory（day-file）は1fileに複数idが載る。この非対称性を表現するため、
// `records`（registryKey→実path）と`files`（path→mtime/size/hash/status等の
// fileレベルmetadata）を分離する。normal Memoryについては、メンバーid1件ずつを
// `records`へ個別登録する必要は無いと判断した——day-fileは
// `records["day:YYYY-MM-DD"]`という合成キー（`dayFileRegistryKey`）1つだけで
// pathを指し、そのpathの`files`entryが`memberIds`（現在そのday-fileに実在する
// 全id）と`memberHashes`（idごとの個別ハッシュ、どのメンバーが変化したかの特定用）
// を持つことでcontainer単位の所在管理が完結する。
//
// status（`VaultRegistryStatus`）とwrite可否の対応（合意済み、Beta方針）：
//   "ok"          → write可能（registry記載pathへ書く）
//   "needs-resync"→ write保留（識別可能な例外をthrow、旧/決定論的pathへの
//                    自動再作成はしない）
//   "missing"     → 同上（write保留）。Vault全体のdirectory enumerationが
//                    最後まで正常完了したresyncのみがこの状態を確定できる
//                    （write/read時のローカルな不在確認だけでは設定しない）
//   "conflict"    → 同上（write保留）。同一idの複数path衝突・外部編集と
//                    未flush変更の衝突中にTsumugi側が勝手にMarkdownを書き換え
//                    ないための安全策。将来、conflictの種類を分けてwrite可能
//                    条件を追加する余地は残すが、Betaでは一律write不可とする。
// この対応表自体の適用（read/write経路への接続、`VaultRecordNeedsResyncError`の
// 導入等）はStep 2以降のスコープであり、本Stepでは型として定義するのみ。
// ---------------------------------------------------------------------------

/** Conversation/Reflection/Sourceは1record=1file。"memory-day"はnormal Memoryの
 *  day-file（1file=複数id）を指す（Reflectionは同じMemoriesディレクトリに
 *  保存されるが1record1fileのため、通常Memoryとは別のrecordTypeとして区別する）。 */
export type VaultRegistryRecordType = "conversation" | "reflection" | "source" | "memory-day";

/**
 * "ok"のみwrite可能（Betaの安全側方針）。"needs-resync"/"missing"/"conflict"は
 * いずれも合意済みの通りwrite保留対象。将来的にconflictの内訳（例：
 * 同一id複数path衝突 と 外部編集×未flush衝突 を別種別に分け、前者だけ限定的に
 * write可能にする等）を追加する余地を残すため、"conflict"を単独の値として
 * 残してある（"needs-resync"等と統合しない）。
 */
export type VaultRegistryStatus = "ok" | "needs-resync" | "missing" | "conflict";

/** 1つの実ファイル（path）についてのregistry上のmetadata。 */
export interface VaultRegistryFileEntry {
  recordType: VaultRegistryRecordType;
  /** `File.lastModified`。次回再同期での一次判定（変化なしのfast path）に使う。 */
  mtime: number;
  /** `File.size`。mtimeだけでは拾えない誤検知を補助的に弾くために使う。 */
  size: number;
  /** ファイル全文の非暗号ハッシュ（`hashVaultText`）。 */
  contentHash: string;
  /** このpathに現在含まれる全record id。conversation/reflection/sourceは常に1件、
   *  memory-dayはそのday-fileの現在の全メンバー。 */
  memberIds: string[];
  /** memory-dayのみ使用。メンバーidごとの個別ハッシュ（day-file内の1件だけが
   *  変化した場合に、どのidが変わったかを特定するために使う）。 */
  memberHashes?: Record<string, string>;
  status: VaultRegistryStatus;
}

/** hash bucket 1つ分のregistry shard。`records`はregistryKey（idまたは
 *  day-file用の合成キー）→path、`files`はpath→そのfileのmetadata
 *  （record/file分離構造）。`bucket`は日付・月とは無関係な
 *  `hash(registryKey) % VAULT_REGISTRY_BUCKET_COUNT`の値。 */
export interface VaultRegistryShard {
  schemaVersion: 1;
  bucket: number;
  records: Record<string, string>;
  files: Record<string, VaultRegistryFileEntry>;
}

/** `.tsumugi/registry-meta.json`の内容。History Indexの`HistoryMeta`と同様、
 *  月ごとの内訳はshard側が持つため、ここは極小のメタ情報のみ。 */
export interface VaultRegistryMeta {
  schemaVersion: 1;
  updatedAt: string;
  /** 最後にVault全体のdirectory enumerationが正常完了した時刻。未実施ならnull。 */
  lastFullResyncAt: string | null;
}

/** 呼び出しごとに新しいオブジェクトを返す（`emptyHistoryMeta`/`emptyMonthIndex`と
 *  同じ理由：`readJSON`のfallbackを呼び出し元が直接書き換えるため、共有の
 *  定数オブジェクトを使うと2回目以降の「まだファイルが無い」呼び出しが
 *  前回の書き換え結果を誤って引き継いでしまう）。 */
function emptyVaultRegistryShard(bucket: number): VaultRegistryShard {
  return { schemaVersion: 1, bucket, records: {}, files: {} };
}

function emptyVaultRegistryMeta(): VaultRegistryMeta {
  return { schemaVersion: 1, updatedAt: "", lastFullResyncAt: null };
}

/**
 * normal Memory（day-file）用の合成キー。ULIDが絶対に含まない":"を挟むことで、
 * 実record idの名前空間と衝突しないようにする。日付を含むが、これはあくまで
 * 「day-fileという1つの実体を指し示すための識別子の中身」であって、shard分割
 * そのものには使わない（shard分割は下記`vaultRegistryBucketOf`が行う、この
 * キー自体のhash値によるものであり、日付の値そのものには依存しない）。
 */
export function dayFileRegistryKey(day: string): string {
  return `day:${day.slice(0, 10)}`;
}

/** registryのshard数（bucket数）。事前に64ファイル全部を作る必要は無く、
 *  実際に使われたbucketのファイルだけが遅延作成される。 */
export const VAULT_REGISTRY_BUCKET_COUNT = 64;

/**
 * FNV-1a（32bit）のコア計算。`hashVaultText`（ファイル内容の変更検知用）と
 * `vaultRegistryBucketOf`（registryKeyのshard振り分け用）の両方から使う、
 * 同じアルゴリズムの共有実装（用途が違うだけで、ハッシュの計算方法自体を
 * 分ける理由が無いため）。
 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * registryKey（Conversation/Reflection/Sourceのid、またはnormal Memory
 * day-fileの合成キー）から、そのrecordが所属するbucket番号（0〜
 * `VAULT_REGISTRY_BUCKET_COUNT - 1`）を計算する。日付・月を一切参照しない
 * ——path解決が「id→bucket→shard→path」だけで完結し、将来timezoneの基準が
 * 変わったり、record自身のdate/startedAtが編集されたりしても、このbucket
 * 番号（＝どのshardファイルに載っているか）が変化しないようにするため。
 */
export function vaultRegistryBucketOf(registryKey: string): number {
  return fnv1a32(registryKey) % VAULT_REGISTRY_BUCKET_COUNT;
}

/** registry shardのファイル名（2桁16進、"00"〜"3f"）。 */
function vaultRegistryBucketFileName(bucket: number): string {
  return `${bucket.toString(16).padStart(2, "0")}.json`;
}

/**
 * History Index専用ロック（`HISTORY_INDEX_LOCK_NAME`）・H4のVault世界ロック
 * （`vaultWorldLock.ts`の`"tsumugi-vault-world"`）のいずれとも独立した、
 * registry専用のWeb Lock。既存の「関心事ごとに別ロックを持つ」方針を踏襲する
 * （registryの読み書きがHistory Index・H4のロック待ちで足止めされない、
 * その逆も無い）。
 */
const VAULT_REGISTRY_LOCK_NAME = "tsumugi-vault-registry-write";

function isVaultRegistryLockSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks !== "undefined";
}

/** Step 2以降（read-modify-writeを行う更新関数）が使うためのlockラッパー。
 *  Step 1時点ではまだどこからも呼ばれない。 */
async function withVaultRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!isVaultRegistryLockSupported()) return fn();
  return navigator.locks.request(VAULT_REGISTRY_LOCK_NAME, fn);
}

/**
 * 非暗号の軽量ハッシュ（FNV-1a、32bit）。Vault内Markdownの変更検知にのみ使う
 * fingerprintであり、暗号学的な衝突耐性は不要（Beta規模の1Vault内で偶然衝突する
 * 確率は無視できる水準で十分）。外部ライブラリは使わない。bucket振り分け
 * （`vaultRegistryBucketOf`）とは別の目的（ファイル内容の変更検知）で使うが、
 * 計算方法自体は`fnv1a32`を共有する。
 */
export function hashVaultText(text: string): string {
  return fnv1a32(text).toString(16).padStart(8, "0");
}

/**
 * registry shardの読み込み（低レベルprimitive）。History Indexの
 * `readHistoryMeta`/`readHistoryMonthIndex`と同じく、存在しない/壊れている
 * 場合は安全な既定値へfallbackする。ロックは取得しない（読み込みが書き込みと
 * 競合しても「わずかに古いregistryを読む」だけであり、実害が無いため。
 * Step 2の`lookupVaultRegistryRecord`はこの関数を通じて読み取る）。
 */
export async function readVaultRegistryShard(root: FileSystemDirectoryHandle, bucket: number): Promise<VaultRegistryShard> {
  try {
    const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
    const registryDir = await tsumugiDir.getDirectoryHandle("registry", { create: false });
    return await readJSON<VaultRegistryShard>(
      registryDir,
      vaultRegistryBucketFileName(bucket),
      emptyVaultRegistryShard(bucket),
      "registry shard read"
    );
  } catch {
    return emptyVaultRegistryShard(bucket);
  }
}

export async function readVaultRegistryMeta(root: FileSystemDirectoryHandle): Promise<VaultRegistryMeta> {
  try {
    const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
    return await readJSON<VaultRegistryMeta>(tsumugiDir, "registry-meta.json", emptyVaultRegistryMeta(), "registry meta read");
  } catch {
    return emptyVaultRegistryMeta();
  }
}

/**
 * registry shardの書き込み（低レベルprimitive、無条件書き込み）。`upsertVaultRegistryRecord`が
 * `withVaultRegistryLock`で全体を包んだ上で「読み込み→計算→書き込み」の一部として呼ぶ
 * （History Indexの`updateHistoryIndex`と同じ構成）。
 */
async function writeVaultRegistryShard(root: FileSystemDirectoryHandle, bucket: number, shard: VaultRegistryShard): Promise<void> {
  const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: true });
  const registryDir = await tsumugiDir.getDirectoryHandle("registry", { create: true });
  await writeFileInDir(registryDir, vaultRegistryBucketFileName(bucket), JSON.stringify(shard, null, 2), "registry shard write");
}

async function writeVaultRegistryMeta(root: FileSystemDirectoryHandle, meta: VaultRegistryMeta): Promise<void> {
  const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: true });
  await writeFileInDir(tsumugiDir, "registry-meta.json", JSON.stringify(meta, null, 2), "registry meta write");
}

// ---------------------------------------------------------------------------
// Vault Registry（Step 2：既存write経路への接続）
//
// writeConversationMarkdownImpl/writeSourceMarkdownImpl/writeMemoryObjectMarkdownImpl
// が使う、registry参照・更新のための中位ヘルパー群。read経路（readConversationById/
// readReflectionById/readMemoriesForDay）・再同期処理（Vault全体のdirectory
// enumeration）は今回一切実装しない。
//
// write可否は合意済みの通り一律：
//   status === "ok"                         → 書き込み可能
//   "needs-resync" / "missing" / "conflict" → 書き込み保留（`VaultRecordNeedsResyncError`）
// ---------------------------------------------------------------------------

/**
 * 既存recordへの書き込みが、registry上"needs-resync"/"missing"/"conflict"の
 * いずれかで保留された場合にthrowする専用例外。呼び出し元（enqueueVaultWrite経由の
 * write関数）はこれを他のI/Oエラーと同様に一切catchせず、そのまま呼び出し元
 * （writeConversationMarkdown等）まで伝播させること——これにより`markVaultSynced`が
 * 呼ばれず、`vaultSyncState`は「未同期」のまま残り、次回`flushPendingToVault`で
 * 自然に再試行される（新しいretry機構は不要）。
 */
export class VaultRecordNeedsResyncError extends Error {
  readonly recordType: VaultRegistryRecordType;
  readonly registryKey: string;
  readonly status: VaultRegistryStatus;

  constructor(recordType: VaultRegistryRecordType, registryKey: string, status: VaultRegistryStatus) {
    super(
      `[Tsumugi] vault write held: ${recordType} "${registryKey}" is "${status}" in the vault registry; ` +
        `refusing to write until a Vault resync resolves it (no automatic recreation at the old/deterministic path).`
    );
    this.name = "VaultRecordNeedsResyncError";
    this.recordType = recordType;
    this.registryKey = registryKey;
    this.status = status;
  }
}

/** `lookupVaultRegistryRecord`の結果。`entry`が`undefined`なら「registryに一度も
 *  登録されたことが無い＝真の新規record」を意味する。 */
interface VaultRegistryLookup {
  bucket: number;
  path: string | undefined;
  entry: VaultRegistryFileEntry | undefined;
}

/**
 * registryKey（Conversation/Reflection/Sourceのid、またはnormal Memoryの
 * `dayFileRegistryKey(day)`）から、現在のregistry上の状態を引く。ロックは
 * 取得しない（`readVaultRegistryShard`と同じ理由：読み取りが多少古くても、
 * その後の書き込み判断自体は`upsertVaultRegistryRecord`側のlockで直列化される
 * ため実害が無い。同一タブ内では`enqueueVaultWrite`が既にVault書き込みを
 * 1件ずつ直列化している）。
 */
async function lookupVaultRegistryRecord(root: FileSystemDirectoryHandle, registryKey: string): Promise<VaultRegistryLookup> {
  const bucket = vaultRegistryBucketOf(registryKey);
  const shard = await readVaultRegistryShard(root, bucket);
  const path = shard.records[registryKey];
  const entry = path !== undefined ? shard.files[path] : undefined;
  return { bucket, path, entry };
}

/**
 * Vault rootからの相対pathとして安全かどうかの軽量チェック（絶対path・
 * "."/".."セグメント・空セグメント・バックスラッシュを拒否）。Step 2時点では
 * Tsumugi自身が`fileNameFor`/`dayFileNameFor`で生成したpathしか登場しないため、
 * 通常は常にtrueになる想定——ユーザー入力由来のpathはまだ存在しない。将来
 * （再同期でVault内の実ファイルを走査するようになった場合）に備えた防御的な
 * チェックとして、ここで一律に検証しておく。
 *
 * バックスラッシュ（Codexレビュー指摘・Medium対応）：以前は先頭の"\"だけを
 * 拒否しており、"Conversations\\x.md"のようにセグメント内部に紛れ込んだ"\"は
 * 通過してしまっていた（File System Access API自体はバックスラッシュを
 * パス区切りとして解釈しないためVault外への実際の脱出経路にはならないが、
 * チェックとしての一貫性を欠いていた）。位置を問わず"\"を含むpath全体を
 * 一律拒否することで、この非対称性を解消する。
 */
function isSafeVaultRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  if (relativePath.includes("\\")) return false;
  if (relativePath.startsWith("/")) return false;
  // "C:/..." のようなWindows drive-letter絶対pathを拒否する。正規表現リテラル内に
  // スラッシュを含めると可読性を落とすため、あえて文字単位の比較で書く。
  if (relativePath.length >= 3 && /[a-zA-Z]/.test(relativePath[0]) && relativePath.slice(1, 3) === ":/") return false;
  const segments = relativePath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * "Conversations/x/y.md"のようなVault root相対pathを、末尾のファイル名を除いた
 * ディレクトリまで辿り、`{dir, fileName}`を返す（中間ディレクトリは
 * `{ create: false }`——既存の構造だけを辿り、勝手に新規作成しない）。
 * Step 2で実際に登場するpathは常に1階層（"Conversations/xxx.md"等）だが、
 * 将来のネストしたpathでも正しく動くよう汎用的に実装する。
 */
async function resolveVaultRelativePath(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<{ dir: FileSystemDirectoryHandle; fileName: string }> {
  if (!isSafeVaultRelativePath(relativePath)) {
    throw new Error(`[Tsumugi] refusing to resolve unsafe vault registry path: ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split("/");
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: false });
  }
  return { dir, fileName: segments[segments.length - 1] };
}

/** Markdown write成功直後にだけ呼ぶ。`File.lastModified`/`File.size`を取得する
 *  （contentHashは呼び出し元が既に手元に持つ書き込み済み文字列から直接計算するため、
 *  ここでは含めない——再読み込みによる無駄なI/Oを避ける）。 */
async function readVaultFileStat(dir: FileSystemDirectoryHandle, fileName: string): Promise<{ mtime: number; size: number }> {
  const fileHandle = await dir.getFileHandle(fileName, { create: false });
  const file = await fileHandle.getFile();
  return { mtime: file.lastModified, size: file.size };
}

interface VaultRegistryUpsertInput {
  registryKey: string;
  /** Vault rootからの相対path。絶対path・"."/".."・Vault外を指すpathは受け付けない
   *  （`isSafeVaultRelativePath`で検証する）。 */
  path: string;
  recordType: VaultRegistryRecordType;
  mtime: number;
  size: number;
  contentHash: string;
  memberIds: string[];
  memberHashes?: Record<string, string>;
}

/**
 * registryの読み込み→更新→書き込みを、`withVaultRegistryLock`で1つの原子的操作
 * として行う（History Indexの`updateHistoryIndex`と同じ構成）。同じbucketに
 * 属する他のrecord（`shard.records`/`shard.files`の他のキー）には一切触れず、
 * 対象のregistryKey/path分のエントリだけを追加・更新する。
 *
 * Markdown write成功後にのみ呼ぶこと（呼び出し元のwrite関数群を参照）。statusは
 * 常に"ok"として書き込む——この関数はMarkdown本体の書き込みが実際に成功した後の
 * 事後登録としてのみ使われる。"needs-resync"への遷移は別の専用関数
 * `markVaultRegistryNeedsResync`が担い、"missing"/"conflict"への遷移
 * （resync・多重path検出等）は引き続き本Stepでは実装しない。
 */
async function upsertVaultRegistryRecord(root: FileSystemDirectoryHandle, input: VaultRegistryUpsertInput): Promise<void> {
  if (!isSafeVaultRelativePath(input.path)) {
    throw new Error(`[Tsumugi] refusing to store unsafe vault registry path: ${JSON.stringify(input.path)}`);
  }
  const bucket = vaultRegistryBucketOf(input.registryKey);
  await withVaultRegistryLock(async () => {
    const shard = await readVaultRegistryShard(root, bucket);
    shard.bucket = bucket;
    shard.records[input.registryKey] = input.path;
    shard.files[input.path] = {
      recordType: input.recordType,
      mtime: input.mtime,
      size: input.size,
      contentHash: input.contentHash,
      memberIds: input.memberIds,
      memberHashes: input.memberHashes,
      status: "ok",
    };
    await writeVaultRegistryShard(root, bucket, shard);
  });
}

/**
 * registry上のregistryKeyが指すfile entryのstatusを"needs-resync"へ変更する
 * （Codexレビュー指摘・Critical/High対応）。write前検証
 * （`verifyVaultRegistryEntryBeforeWrite`）が「実ファイルが見つからない」
 * 「本文が外部で変化している（hash不一致）」と判定した場合にのみ呼ぶ。
 *
 * `upsertVaultRegistryRecord`と同じ構成（`withVaultRegistryLock`でread→対象
 * entryのみ変更→write）で、同じbucket内の他entryには一切触れない。対象の
 * file entry自体が既に無い（read時点までの間に何らかの理由で消えている等）
 * 場合は何もしない——無いものをneeds-resyncにはできないため静かに戻る。
 * 既に"needs-resync"であれば変更不要として書き込み自体をskipする（同じ理由で
 * 複数回呼ばれても安全・冪等）。
 */
async function markVaultRegistryNeedsResync(root: FileSystemDirectoryHandle, registryKey: string): Promise<void> {
  const bucket = vaultRegistryBucketOf(registryKey);
  await withVaultRegistryLock(async () => {
    const shard = await readVaultRegistryShard(root, bucket);
    const path = shard.records[registryKey];
    if (path === undefined) return;
    const entry = shard.files[path];
    if (entry === undefined || entry.status === "needs-resync") return;
    shard.files[path] = { ...entry, status: "needs-resync" };
    await writeVaultRegistryShard(root, bucket, shard);
  });
}

/**
 * write前検証（Codexレビュー指摘・Critical/High対応）。registry status==="ok"の
 * 既存recordへ書き込む直前に、実ファイルが本当にregistryの認識と一致しているかを
 * 検証する。合意済みの安全設計：
 *
 * 1. 実ファイルの存在確認（`{ create: false }`）。見つからなければ、旧pathへの
 *    自動再作成は絶対に行わず、registryを"needs-resync"へ更新した上で
 *    `VaultRecordNeedsResyncError`をthrowする（write禁止のまま関数を抜ける）。
 * 2. mtime/sizeがregistry記載値と一致すれば「registryが把握している内容と
 *    変更なし」としてwrite続行可能（本文は読まない・返さない）。
 * 3. mtimeまたはsizeが異なる場合のみ実ファイル本文を読み、`hashVaultText`で
 *    registry記載のcontentHashと比較する。
 *    - 一致：内容自体は変化していない（メタデータだけの差）としてwrite続行可能。
 *      呼び出し元がこの後の処理（day-fileのmerge等）で再利用できるよう、
 *      読み込んだ本文をそのまま返す（二重読み込みを避けるため）。
 *    - 不一致：外部変更、またはMarkdown write成功後にRegistry更新だけ失敗した
 *      未確定状態のいずれかであり、どちらであるかをここで推測しない。安全側に
 *      倒し、registryを"needs-resync"へ更新した上で`VaultRecordNeedsResyncError`
 *      をthrowする（write禁止）。回復は今回実装しない明示的Vault resync
 *      （Step 4）に委ねる。
 */
interface VaultRegistryPreWriteCheck {
  /** hash比較のために実際に読んだ本文。呼び出し元がその後の処理（day-fileの
   *  parse等）で再利用できるよう返す。mtime/sizeが一致し本文を読まなかった
   *  場合は`undefined`。 */
  actualText: string | undefined;
}

async function verifyVaultRegistryEntryBeforeWrite(
  root: FileSystemDirectoryHandle,
  registryKey: string,
  dir: FileSystemDirectoryHandle,
  fileName: string,
  entry: VaultRegistryFileEntry
): Promise<VaultRegistryPreWriteCheck> {
  let file: File;
  try {
    const fileHandle = await dir.getFileHandle(fileName, { create: false });
    file = await fileHandle.getFile();
  } catch {
    await markVaultRegistryNeedsResync(root, registryKey);
    throw new VaultRecordNeedsResyncError(entry.recordType, registryKey, "needs-resync");
  }

  if (file.lastModified === entry.mtime && file.size === entry.size) {
    return { actualText: undefined };
  }

  const actualText = await file.text();
  const actualHash = hashVaultText(actualText);
  if (actualHash === entry.contentHash) {
    return { actualText };
  }

  await markVaultRegistryNeedsResync(root, registryKey);
  throw new VaultRecordNeedsResyncError(entry.recordType, registryKey, "needs-resync");
}
