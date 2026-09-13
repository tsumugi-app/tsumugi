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
import type { Conversation, MemoryObject, Source } from "./types";
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
 * `normalMemoryCount`：通常Memory（day-fileへ統合される形式）の、そのday-file自体の
 * 現在の実エントリ数（絶対値）。`reflectionIds`：Reflection Summary（1record1file）の
 * id一覧。`memoryCount`は常に`normalMemoryCount + reflectionIds.length`として
 * 再計算した絶対値であり、どちらか一方の更新時にも都度両方から算出し直す
 * （差分加算はしない。Codexレビュー指摘：差分加算はretryで永続的にずれうるため）。
 */
export interface HistoryDayIndex {
  conversationIds: string[];
  normalMemoryCount: number;
  reflectionIds: string[];
  memoryCount: number;
}

export interface HistoryMonthIndex {
  version: 1;
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

function emptyMonthIndex(month: string): HistoryMonthIndex {
  return { version: 1, month, days: {} };
}

function emptyDayIndex(): HistoryDayIndex {
  return { conversationIds: [], normalMemoryCount: 0, reflectionIds: [], memoryCount: 0 };
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
  | { kind: "conversation"; id: string; day: string }
  | { kind: "reflection"; id: string; day: string }
  /**
   * 通常Memory（day-fileへ統合される形式）専用。`normalMemoryCount`は呼び出し元
   * （`writeMemoryObjectMarkdownImpl`）が、day-fileへ実際に書き込んだ後のマージ済み
   * 配列の件数（絶対値）をそのまま渡す。「新規か更新か」の判定はここでは行わない
   * （Codexレビュー指摘：retry時、day-fileには既にそのidが存在するため「更新」と
   * 誤判定され、差分加算方式ではIndex側の件数が永続的にずれる。絶対値を渡すことで
   * 何度retryしても同じ正しい値へ収束する）。
   */
  | { kind: "memory"; day: string; normalMemoryCount: number };

/**
 * 既存のday entry（無ければ空）へ、1件の更新を反映した新しいday entryを返す
 * （純粋関数、副作用なし）。conversationIds/reflectionIdsへの追加はidempotent
 * （既に含まれていれば追加しない）。memoryCountは常に
 * `normalMemoryCount + reflectionIds.length`として再計算する絶対値であり、
 * 差分加算はしない——normalMemoryCount側の更新かreflectionIds側の更新かに
 * 関わらず、他方の既存値はそのまま保持した上で毎回両方から算出し直す。
 */
function computeUpdatedDayEntry(previous: HistoryDayIndex | undefined, update: HistoryIndexUpdate): HistoryDayIndex {
  const base: HistoryDayIndex = previous
    ? {
        conversationIds: [...previous.conversationIds],
        normalMemoryCount: previous.normalMemoryCount,
        reflectionIds: [...previous.reflectionIds],
        memoryCount: previous.memoryCount,
      }
    : emptyDayIndex();

  if (update.kind === "conversation") {
    if (!base.conversationIds.includes(update.id)) {
      base.conversationIds = [...base.conversationIds, update.id];
    }
  } else if (update.kind === "reflection") {
    if (!base.reflectionIds.includes(update.id)) {
      base.reflectionIds = [...base.reflectionIds, update.id];
    }
  } else {
    base.normalMemoryCount = update.normalMemoryCount;
  }

  base.memoryCount = base.normalMemoryCount + base.reflectionIds.length;
  return base;
}

function isDayIndexEqual(a: HistoryDayIndex, b: HistoryDayIndex): boolean {
  return (
    a.normalMemoryCount === b.normalMemoryCount &&
    a.memoryCount === b.memoryCount &&
    a.conversationIds.length === b.conversationIds.length &&
    a.conversationIds.every((id, i) => id === b.conversationIds[i]) &&
    a.reflectionIds.length === b.reflectionIds.length &&
    a.reflectionIds.every((id, i) => id === b.reflectionIds[i])
  );
}

/** 月Indexの現在の（既に書き込み済みの）状態から、その月の絶対集計を計算する。 */
function computeMonthAggregate(monthIndex: HistoryMonthIndex): HistoryMonthAggregate {
  let memories = 0;
  let conversations = 0;
  for (const day of Object.values(monthIndex.days)) {
    memories += day.memoryCount;
    conversations += day.conversationIds.length;
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

    monthIndex.version = 1;
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
 * History Index読み取り側（Step 1時点では低レベルのプリミティブのみ。History UI自体は
 * 今回のスコープ外）。読み取りはロックを取得しない——書き込みと競合しても「わずかに
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
  const fileName = fileNameFor(conversation.id, conversation.startedAt);
  const renderStart = Date.now();
  const content = conversationToMarkdown(conversation);
  logSyncStep("conversation render", Date.now() - renderStart);
  await writeFileInDir(dir, fileName, content, "conversation");
  await updateIndex(root, conversation.id, `Conversations/${fileName}`);
  // History Index（Step 1）：Markdown本体の書き込みが成功した直後に更新する。
  // ここでcatchして握り潰さない——失敗すればこの関数全体が失敗として呼び出し元へ
  // 伝わり、vaultSyncStateが更新されないため、次回flush時に本体・Index更新の両方が
  // 自然に再試行される（詳細はupdateHistoryIndexのコメント参照）。
  await updateHistoryIndex(root, { kind: "conversation", id: conversation.id, day: conversation.startedAt.slice(0, 10) });
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
  const fileName = fileNameFor(source.id, source.createdAt);
  const renderStart = Date.now();
  const content = sourceToMarkdown(source);
  logSyncStep("source render", Date.now() - renderStart);
  await writeFileInDir(dir, fileName, content, "source");
  await updateIndex(root, source.id, `Sources/${fileName}`);
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
    const fileName = fileNameFor(memoryObject.id, memoryObject.date);
    const renderStart = Date.now();
    const content = memoryObjectToMarkdown(memoryObject);
    logSyncStep("memory render", Date.now() - renderStart);
    await writeFileInDir(dir, fileName, content, "memory");
    await updateIndex(root, memoryObject.id, `Memories/${fileName}`);
    // History Index（Step 1）：Reflection Summaryは1record1fileのため、月Indexへ
    // idを直接記録する（通常Memoryのようにday-fileの既存件数からは新規/更新を
    // 判別できないため、`updateHistoryIndex`側でidの有無から判定させる）。
    // ここでもcatchせず、失敗をそのまま伝播させる。
    await updateHistoryIndex(root, { kind: "reflection", id: memoryObject.id, day: memoryObject.date.slice(0, 10) });
    memoryObject.metadata.obsidian = {
      ...memoryObject.metadata.obsidian,
      vaultPath: `Memories/${fileName}`,
    };
    return;
  }

  const fileName = dayFileNameFor(memoryObject.date);
  const existingEntries = await timedIOStep("memory existingRead", () => readDayFileEntries(dir, fileName));
  const otherEntries = existingEntries.filter((memory) => memory.id !== memoryObject.id);
  const mergeStart = Date.now();
  const merged = [...otherEntries, memoryObject].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const serialized = serializeMemoryDayFile(merged);
  logSyncStep("memory render", Date.now() - mergeStart);

  await writeFileInDir(dir, fileName, serialized, "memory");
  await updateIndex(root, memoryObject.id, `Memories/${fileName}`);
  // History Index（Step 1、Codexレビュー指摘対応）：day-fileへ実際に書き込んだ後の
  // マージ済み配列の件数（絶対値）をそのまま渡す。「新規か更新か」をここで判定して
  // 差分加算する設計は、retry時にday-fileへ既にそのidが存在するため常に「更新」と
  // 誤判定され、Index側の件数が永続的にずれる不具合があったため廃止した
  // （`updateHistoryIndex`側は絶対値からmemoryCountを再計算するため、何度retryしても
  // 同じ正しい値へ収束する）。catchせず、失敗をそのまま伝播させる
  // （次回flushで本体・Index更新ともに再試行）。
  await updateHistoryIndex(root, { kind: "memory", day: memoryObject.date.slice(0, 10), normalMemoryCount: merged.length });
  memoryObject.metadata.obsidian = {
    ...memoryObject.metadata.obsidian,
    vaultPath: `Memories/${fileName}`,
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
