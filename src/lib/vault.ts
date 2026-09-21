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
  addConversationIfAbsentAndMarkSynced,
  addMemoryObjectIfAbsentAndMarkSynced,
  addSourceIfAbsentAndMarkSynced,
  bumpRegistryGenerationEpoch,
  getAllConversations,
  getAllMemoryObjects,
  getAllSources,
  getConversation,
  getMemoryObject,
  getRegistryGenerationEpoch,
  getSource,
  getVaultSyncState,
  hasAnyVaultSyncState,
  isAndroidOpfsVaultInitialized,
  loadVaultHandle,
  markAndroidOpfsVaultInitialized,
  putConversationAndMarkSynced,
  putMemoryObjectAndMarkSynced,
  saveSourceAndMarkSynced,
  setVaultSyncState,
} from "./db";
import { logTimingEvent } from "./debugTimingLog";
import type { Conversation, MemoryObject, MemorySource, MemoryType, Source } from "./types";
import {
  asString,
  conversationToMarkdown,
  inferSourceType,
  memoryObjectToMarkdown,
  parseConversationMarkdown,
  parseFrontmatter,
  parseMemoryDayFile,
  parseMemoryObjectMarkdown,
  parseSourceMarkdown,
  serializeMemoryDayFile,
  sourceToMarkdown,
} from "./markdown";
import { runVaultWorldExclusive } from "./vaultWorldLock";
import { isWipePending, WipeInProgressError } from "./wipeState";

/**
 * B1（軽量Registry index・多tab安全性設計）：このpage load（session）固有の
 * ランダムID。Registry ownershipの安全性根拠として使う——`meta.dirtyOwnerInstanceId`
 * と比較し、「自分が現在のdirty spellの唯一の所有者か」を判定するために使う。
 *
 * `debugTimingLog.ts`の`instanceId`（診断ログの相関用、8文字に切り詰め、privacy
 * 目的で軽量）とは責務を分離し、**流用しない**。こちらは安全性判定の根拠に使うため、
 * `crypto.randomUUID()`をそのまま（切り詰めずに）使い、衝突耐性を優先する。
 *
 * 今回（B1/B2）はこの定数を定義するだけで、実際のRegistry mutation経路・
 * light check・UIのいずれからも参照されない（配線はB3以降）。
 */
export const vaultRegistryInstanceId: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `fallback-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/**
 * B1：`meta.dirtyOwnerInstanceId`が「複数instanceが関与し、誰の所有権主張も
 * 無効化された」ことを示すための固定sentinel値。マジック文字列を各所へ直接
 * 書かないよう、この定数を経由して比較・代入する。`crypto.randomUUID()`が
 * 生成する値（ダッシュ区切りの36文字UUID形式）とは形式が異なるため、実際の
 * instanceIdと偶然一致することは無い。
 */
export const VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE = "MULTIPLE" as const;

/**
 * C1（軽量Registry index・多tab安全性設計のbootstrap/rebuild foundation）対応：
 * 新しい`registryGeneration`を確立するたびに呼ぶtoken生成。`vaultRegistryInstanceId`
 * と同じ`crypto.randomUUID()`優先＋fallbackのpatternをそのまま踏襲する
 * （instanceIdとgeneration tokenは意味が異なる別概念のため、値そのものは
 * 共有しない——生成方法だけを揃える）。
 *
 * Low修正（Codexレビュー指摘）：`crypto.randomUUID()`が使える環境では
 * それだけを使う（`Date.now()`は関与しない）。`crypto.randomUUID()`が
 * 使えない環境でのみ、`Math.random()`と`Date.now()`を組み合わせた
 * best-effortなfallbackを使う——これは衝突を構造的に防ぐ保証では
 * ないが、同一ミリ秒内に複数回このfallbackが呼ばれる頻度（resync
 * 成功のたびに1回だけ）を踏まえると実用上十分な衝突耐性として許容する。
 */
function generateVaultRegistryGeneration(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `fallback-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

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
 * Android保存方式の見直し：Android Chrome（SAF/document provider経由）は
 * `showDirectoryPicker`が使える場合があるが、実機でVault接続/権限確認の不安定さ・
 * I/Oの遅さ・カレンダー反映の遅延が繰り返し確認されたため、外部Vaultを日常動作の
 * primary storageとして使う方針を終了する。Androidだけを他のFSA対応環境より先に
 * 判定し、常にOPFS（この端末専有の内部領域）を優先させる。iOS/iPadOS Safariは
 * 元々`showDirectoryPicker`非対応のため、この判定の影響を受けない
 * （isFsAccessSupported()が既にfalseを返すので、この分岐に到達する前に
 * 下のOPFSフォールバックへ進む）。この用途だけの最小限のUser-Agent判定にとどめる。
 */
function isAndroid() {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/**
 * このブラウザで実際に使えるVaultバックエンドを返す。Androidでは常にOPFSを優先する
 * （上記コメント参照）。それ以外の環境ではFile System Access APIが使えれば
 * 必ずそちらを優先する（PCで既にVaultを接続しているユーザーを、意図せずOPFSへ切り替えない
 * ため）。使えない場合のみOPFSへフォールバックする。どちらも使えなければnull。
 */
export function getVaultBackend(): VaultBackend | null {
  if (isAndroid()) return isOpfsSupported() ? "opfs" : null;
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
 * Registry baseline（`baselineEstablishedAt`）の確立結果。
 */
export interface VaultBaselineResult {
  established: boolean;
  baselineEstablishedAt?: string;
}

/**
 * Android保存方式の見直し：Androidの既定backendがOPFSへ切り替わった端末で、新しい
 * （空の）OPFS VaultについてRegistry baseline（`baselineEstablishedAt`）を一度だけ
 * 確立する（既存の移行経路。`ensureVaultBaseline`の中で、これまでと同じ条件・同じ処理のまま
 * 呼ばれる）。C1のfail-closed設計（Registry absentなrecordはbaseline確立後の
 * createdAtでなければ書き込めない）は一切変更しない——単に、空のVaultに対して
 * 既存の`resyncVaultRegistry()`（full resync）を、C1が想定する「初回のVault確立」
 * という正規の用途でそのまま1回呼ぶだけである。
 *
 * 過去のIndexedDBデータ（conversations/memoryObjects/sources）は一切対象にしない
 * （このリクエスト自体はどのrecordも読み書きしない）。`vaultSyncState`もクリア
 * しない——これにより、以前File System Access（旧backend）で同期済みだった
 * recordは「同期済み」のまま残り、この後に自動実行される`flushPendingToVault`
 * から静かにスキップされる。新しいOPFS Vaultへ過去recordが誤ってback-fillされる
 * ことを、追加のロジック無しに防ぐ。
 *
 * 成功時（`resyncVaultRegistry`がRegistry CLEAN state・baselineの確立まで完了した
 * 場合、`lastFullResyncUpdated === true`）にのみ、db.tsの永続markerを立てる。
 * 失敗時はmarkerを立てず、次回起動時に再試行する。
 */
async function establishAndroidOpfsVaultBaseline(root: FileSystemDirectoryHandle): Promise<VaultBaselineResult> {
  try {
    const result = await resyncVaultRegistry(root);
    if (result.lastFullResyncUpdated) {
      await markAndroidOpfsVaultInitialized();
      return { established: true, baselineEstablishedAt: result.startedAt };
    }
  } catch (error) {
    console.error("[Tsumugi] failed to establish Android OPFS vault baseline (will retry on next launch):", error);
  }
  return { established: false };
}

type StrictJsonRead = { status: "absent" } | { status: "ok"; value: unknown } | { status: "error" };

/** `readJSON`（失敗を静かに既定値へfallbackする）と違い、NotFoundと読み取り失敗を区別する。 */
async function readJsonStrict(dir: FileSystemDirectoryHandle, name: string): Promise<StrictJsonRead> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await dir.getFileHandle(name, { create: false });
  } catch (error) {
    return isVaultRegistryDirectoryNotFoundError(error) ? { status: "absent" } : { status: "error" };
  }
  try {
    return { status: "ok", value: JSON.parse(await (await fileHandle.getFile()).text()) };
  } catch {
    return { status: "error" };
  }
}

/**
 * C3：旧式の管理情報（`.tsumugi/index.json`・History Index）が空であることを、読み取りのみで
 * 確認する。読み取りに失敗した場合・空でない場合はfalse（＝自動でbaselineを確立しない）。
 * `.tsumugi/`自体が無い場合は空として扱う。
 */
async function isVaultLegacyMetadataEmpty(root: FileSystemDirectoryHandle): Promise<boolean> {
  let tsumugiDir: FileSystemDirectoryHandle;
  try {
    tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
  } catch (error) {
    return isVaultRegistryDirectoryNotFoundError(error);
  }

  const index = await readJsonStrict(tsumugiDir, "index.json");
  if (index.status === "error") return false;
  if (index.status === "ok") {
    if (typeof index.value !== "object" || index.value === null || Array.isArray(index.value)) return false;
    if (Object.keys(index.value as Record<string, unknown>).length > 0) return false;
  }

  const historyMeta = await readJsonStrict(tsumugiDir, "history-meta.json");
  if (historyMeta.status === "error") return false;
  if (historyMeta.status === "ok") {
    const meta = historyMeta.value as Partial<HistoryMeta> | null;
    if (!meta || meta.totalMemories !== 0 || meta.totalConversations !== 0) return false;
  }

  try {
    const historyDir = await tsumugiDir.getDirectoryHandle("history", { create: false });
    for await (const _entry of historyDir.entries()) {
      void _entry;
      return false; // History Indexのファイルが1つでもあれば空ではない
    }
  } catch (error) {
    if (!isVaultRegistryDirectoryNotFoundError(error)) return false;
  }
  return true;
}

/**
 * Registry baselineを、全プラットフォーム共通で安全に確立する（Android専用だった
 * `ensureAndroidOpfsVaultBaseline`の一般化）。
 *
 * baselineは「この時刻より前に、Vaultに存在し得たrecordはRegistryに取り込み済み」という境界であり、
 * 確立には（`resyncVaultRegistry`＝Vault全体のscan＋取り込み）を伴う。既存のVaultで自動的に
 * 確立すると、任意のフォルダのMarkdownを黙ってIndexedDBへ取り込むことになる。そのため、
 * 確立を許可するのは次の全てが成立する場合に限る：
 *   C0 排他ロック（resyncVaultRegistry内の`runVaultWorldExclusive`）でepoch・整合性を確認できる
 *   C1 Registry未確立：`registry-meta.json`が存在しない（NotFound）。存在して読めない場合・
 *      存在してbaselineがnullの場合は何もしない
 *   C2 Vaultにtsumugiの記録が無い：scanが完走し、Registryのrecordも、Tsumugiのファイルも、
 *      読めないTsumugiのファイルも0件（resync内で、applyの前・同じ排他区間で判定する）
 *   C3 旧式の管理情報も空：`.tsumugi/index.json`が空、History Indexが空
 *   C4 この端末に「以前この保存先へ書いた」痕跡が無い：`vaultSyncState`が空。
 *      OPFSだけが消えた・外部フォルダが切断された等、空に見えるだけの失われたVaultを
 *      新しい空Vaultと誤認しないため
 *
 * 成立しない場合は何もしない（従来どおり書き込みはHOLDされ、IndexedDBは変更されない）。
 * baselineより前に作られたIndexedDB上のrecordは、この関数では書き出さない（legacy扱いのまま。
 * 別途、ユーザーの明示操作で扱う）。
 *
 * Androidの既存の移行経路（OPFSへ既定backendが切り替わった端末で、markerが未設定）は、これまでと
 * 同じ条件・同じ処理のまま最優先で実行する（既存Android端末の挙動を変えない）。
 *
 * 呼び出し元は、必ず"tsumugi-vault-world"の共有ロックが解放された状態で呼ぶこと（内部で
 * `resyncVaultRegistry`がexclusiveロックを要求するため、共有ロック内から呼ぶと自己デッドロックする）。
 * 例外は投げない（失敗時は`{ established: false }`。次回の起動・接続時に再試行される）。
 */
export async function ensureVaultBaseline(root: FileSystemDirectoryHandle): Promise<VaultBaselineResult> {
  try {
    if (isAndroid() && getVaultBackend() === "opfs" && !(await isAndroidOpfsVaultInitialized())) {
      return await establishAndroidOpfsVaultBaseline(root);
    }

    // C1
    const pre = await readVaultRegistryMetaForStep0(root);
    if (pre.status !== "not-found") return { established: false };

    // C3・C4（lock外の事前確認。C2はresync内でapplyの前に、同じ排他区間で確認する）
    if (!(await isVaultLegacyMetadataEmpty(root))) return { established: false };
    if (await hasAnyVaultSyncState()) return { established: false };

    const result = await resyncVaultRegistry(root, { requireEmptyVault: true });
    if (result.lastFullResyncUpdated) {
      return { established: true, baselineEstablishedAt: result.startedAt };
    }
  } catch (error) {
    console.error("[Tsumugi] failed to establish vault baseline (will retry on next launch/connect):", error);
  }
  return { established: false };
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
  // 完全削除が開始済みなら、新しいVault書き込みは受け付けない（消したデータの書き戻し防止）。
  if (isWipePending()) return Promise.reject(new WipeInProgressError());
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

export type VaultSyncKind = "conversation" | "memory" | "source";

export function vaultSyncKeyFor(kind: VaultSyncKind, id: string): string {
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
export async function isAlreadySyncedToVault(kind: VaultSyncKind, id: string, updatedAt: string): Promise<boolean> {
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

// ---------------------------------------------------------------------------
// 「本体が見つからず、復元元も無い記録」の管理情報の整理（`vaultOrphanCleanup.ts`専用）
//
// 通常の保存・light-check・resyncからは呼ばれない。History Index・`.tsumugi/index.json`・
// Registryの、単一レコード（Conversation／Reflection／Source）の管理情報を、読み取り・削除する
// プリミティブ。削除系は、既存の書き込みと同じ直列化（`enqueueVaultWrite`／History Indexロック／
// Registryロック）の下で行い、読み取りエラーは「存在しない」と混同せず必ず例外にする。
// ---------------------------------------------------------------------------

export type VaultOrphanRecordKind = "conversation" | "reflection" | "source";

/** History Index上の1行（種別・日付・月）。 */
export interface VaultHistoryRowRef {
  month: string;
  day: string;
  /** Conversationのみ（v2形式の行が持つ情報）。 */
  conversation?: HistoryConversationSummary;
}

export interface VaultManagementTrace {
  /** すべて読み取りに成功したか。falseなら、痕跡の有無を確認できていない。 */
  ok: boolean;
  /** `.tsumugi/index.json`の値（無ければundefined）。 */
  indexPath?: string;
  historyRows: VaultHistoryRowRef[];
}

async function readStrictJson(dir: FileSystemDirectoryHandle, name: string): Promise<{ status: "absent" } | { status: "ok"; value: unknown }> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await dir.getFileHandle(name, { create: false });
  } catch (error) {
    if (isNotFoundError(error)) return { status: "absent" };
    throw error;
  }
  return { status: "ok", value: JSON.parse(await (await fileHandle.getFile()).text()) };
}

async function getDirIfExists(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name, { create: false });
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

const HISTORY_MONTH_FILE_PATTERN = /^\d{4}-\d{2}\.json$/;

/** `.tsumugi/history/YYYY-MM.json`を全て厳密に読む（読み取り・parseの失敗は例外）。 */
async function readAllHistoryMonthsStrict(historyDir: FileSystemDirectoryHandle): Promise<{ name: string; month: string; index: HistoryMonthIndex }[]> {
  const out: { name: string; month: string; index: HistoryMonthIndex }[] = [];
  for await (const [name, handle] of historyDir.entries()) {
    if (handle.kind !== "file" || !HISTORY_MONTH_FILE_PATTERN.test(name)) continue;
    const read = await readStrictJson(historyDir, name);
    if (read.status !== "ok") continue;
    const value = read.value as HistoryMonthIndex | null;
    if (!value || typeof value !== "object" || typeof value.days !== "object" || value.days === null) {
      throw new Error(`history month file is malformed: ${name}`);
    }
    out.push({ name, month: name.replace(/\.json$/, ""), index: value });
  }
  return out;
}

/**
 * 1つのレコードの管理情報（`.tsumugi/index.json`・History Indexの行）を読み取る（書き込まない）。
 * 読み取りに失敗した場合は`ok: false`（痕跡の有無を確認できていない）。
 */
export async function inspectVaultManagementTrace(
  root: FileSystemDirectoryHandle,
  kind: VaultOrphanRecordKind,
  id: string
): Promise<VaultManagementTrace> {
  const trace: VaultManagementTrace = { ok: true, historyRows: [] };
  try {
    const tsumugiDir = await getDirIfExists(root, ".tsumugi");
    if (!tsumugiDir) return trace;
    const index = await readStrictJson(tsumugiDir, "index.json");
    if (index.status === "ok") {
      if (typeof index.value !== "object" || index.value === null || Array.isArray(index.value)) throw new Error("index.json is malformed");
      const value = (index.value as Record<string, unknown>)[id];
      if (typeof value === "string") trace.indexPath = value;
    }
    const historyDir = await getDirIfExists(tsumugiDir, "history");
    if (!historyDir || kind === "source") return trace; // SourceはHistory Indexに載らない
    for (const { month, index: monthIndex } of await readAllHistoryMonthsStrict(historyDir)) {
      for (const [day, entry] of Object.entries(monthIndex.days)) {
        if (isHistoryDayIndexV2(entry)) {
          if (kind === "conversation") {
            const row = entry.conversations.find((c) => c.id === id);
            if (row) trace.historyRows.push({ month, day, conversation: row });
          } else if (entry.reflections.some((r) => r.id === id)) {
            trace.historyRows.push({ month, day });
          }
        } else {
          const ids = kind === "conversation" ? entry.conversationIds : entry.reflectionIds;
          if (ids.includes(id)) trace.historyRows.push({ month, day });
        }
      }
    }
    return trace;
  } catch (error) {
    console.error("[Tsumugi] failed to inspect vault management info:", error);
    return { ok: false, historyRows: [] };
  }
}

function isHistoryDayEmpty(entry: HistoryDayIndex): boolean {
  return isHistoryDayIndexV2(entry)
    ? entry.conversations.length === 0 && entry.normalMemories.length === 0 && entry.reflections.length === 0
    : entry.conversationIds.length === 0 && entry.reflectionIds.length === 0 && entry.normalMemoryCount === 0;
}

/**
 * History Indexから、Conversation／Reflectionの1件の行を削除する。月の集計と`history-meta.json`は、
 * 既存の更新と同じ「現在の状態から求めた絶対値」で再計算する（差分加算はしない）。行が既に無ければ
 * 何もしない（冪等）。`reconcileMonths`：以前の実行で行の削除だけ済み、集計の更新が済んでいない月
 * （`YYYY-MM`）を、行が無くても再計算する。読み取り・書き込みの失敗は例外（握りつぶさない）。
 * 戻り値：削除した行の数。
 */
export async function removeVaultHistoryRecordRows(
  root: FileSystemDirectoryHandle,
  kind: "conversation" | "reflection",
  id: string,
  reconcileMonths: string[] = []
): Promise<number> {
  return enqueueVaultWrite(async () => {
    let removedTotal = 0;
    await withHistoryIndexLock(async () => {
      const tsumugiDir = await getDirIfExists(root, ".tsumugi");
      if (!tsumugiDir) return;
      const historyDir = await getDirIfExists(tsumugiDir, "history");
      if (!historyDir) return;
      const months = await readAllHistoryMonthsStrict(historyDir);
      const touchedMonths = new Set<string>(reconcileMonths);
      for (const { name, month, index } of months) {
        let removed = 0;
        for (const [day, entry] of Object.entries(index.days)) {
          if (isHistoryDayIndexV2(entry)) {
            const list = kind === "conversation" ? entry.conversations : entry.reflections;
            const next = list.filter((row) => row.id !== id);
            if (next.length === list.length) continue;
            removed += list.length - next.length;
            if (kind === "conversation") entry.conversations = next as HistoryConversationSummary[];
            else entry.reflections = next as HistoryMemorySummary[];
          } else {
            const list = kind === "conversation" ? entry.conversationIds : entry.reflectionIds;
            const next = list.filter((rowId) => rowId !== id);
            if (next.length === list.length) continue;
            removed += list.length - next.length;
            if (kind === "conversation") entry.conversationIds = next;
            else {
              entry.reflectionIds = next;
              entry.memoryCount = entry.normalMemoryCount + next.length;
            }
          }
          if (isHistoryDayEmpty(entry)) delete index.days[day];
        }
        if (removed > 0) {
          await writeFileInDir(historyDir, name, JSON.stringify(index, null, 2), "history month write");
          removedTotal += removed;
          touchedMonths.add(month);
        }
      }
      if (touchedMonths.size === 0) return;
      const metaRead = await readStrictJson(tsumugiDir, "history-meta.json");
      const meta: HistoryMeta = metaRead.status === "ok" ? (metaRead.value as HistoryMeta) : emptyHistoryMeta();
      let metaChanged = false;
      for (const month of touchedMonths) {
        const monthIndex = months.find((m) => m.month === month)?.index;
        if (!monthIndex) continue;
        const aggregate = computeMonthAggregate(monthIndex);
        if (!isMonthAggregateEqual(meta.months[month], aggregate)) {
          meta.months[month] = aggregate;
          metaChanged = true;
        }
      }
      if (metaChanged) {
        meta.version = 1;
        meta.totalMemories = Object.values(meta.months).reduce((sum, m) => sum + m.memories, 0);
        meta.totalConversations = Object.values(meta.months).reduce((sum, m) => sum + m.conversations, 0);
        meta.updatedAt = new Date().toISOString();
        await writeFileInDir(tsumugiDir, "history-meta.json", JSON.stringify(meta, null, 2), "history meta write");
      }
    });
    return removedTotal;
  }, "interactive", null);
}

/** History Indexの月の集計（`history-meta.json`）が、月Indexの現在の状態から求めた値と一致するか。 */
export async function isVaultHistoryMonthAggregateConsistent(root: FileSystemDirectoryHandle, months: string[]): Promise<boolean> {
  try {
    const tsumugiDir = await getDirIfExists(root, ".tsumugi");
    if (!tsumugiDir) return true;
    const historyDir = await getDirIfExists(tsumugiDir, "history");
    if (!historyDir) return true;
    const all = await readAllHistoryMonthsStrict(historyDir);
    const metaRead = await readStrictJson(tsumugiDir, "history-meta.json");
    const meta: HistoryMeta = metaRead.status === "ok" ? (metaRead.value as HistoryMeta) : emptyHistoryMeta();
    for (const month of months) {
      const monthIndex = all.find((m) => m.month === month)?.index;
      if (!monthIndex) continue;
      if (!isMonthAggregateEqual(meta.months[month], computeMonthAggregate(monthIndex))) return false;
    }
    const totalConversations = Object.values(meta.months).reduce((sum, m) => sum + m.conversations, 0);
    return totalConversations === meta.totalConversations;
  } catch {
    return false;
  }
}

/** `.tsumugi/index.json`から、1件のキーを削除する。無ければ何もしない（冪等）。読み取り失敗は例外。 */
export async function removeVaultIndexJsonKey(root: FileSystemDirectoryHandle, id: string): Promise<boolean> {
  return enqueueVaultWrite(async () => {
    const tsumugiDir = await getDirIfExists(root, ".tsumugi");
    if (!tsumugiDir) return false;
    const read = await readStrictJson(tsumugiDir, "index.json");
    if (read.status !== "ok") return false;
    if (typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) throw new Error("index.json is malformed");
    const index = read.value as Record<string, unknown>;
    if (!(id in index)) return false;
    delete index[id];
    await writeFileInDir(tsumugiDir, "index.json", JSON.stringify(index, null, 2), "index write");
    return true;
  }, "interactive", null);
}

/** Registryを厳密に読む（1つでも読めないshardがあれば`completed: false`）。読み取りのみ。 */
export async function readVaultRegistrySnapshotStrict(
  root: FileSystemDirectoryHandle
): Promise<{ completed: boolean; records: Map<string, string>; files: Map<string, VaultRegistryFileEntry> }> {
  const snapshot = await buildVaultRegistrySnapshotForResync(root);
  return { completed: snapshot.completed, records: snapshot.previousByKey, files: snapshot.previousEntries };
}

/** `removeVaultRegistrySingleRecordEntry`が、削除してよい条件を満たさないrecordを拒否した場合。 */
export class VaultRegistryEntryRemovalRefusedError extends Error {
  constructor(registryKey: string, reason: string) {
    super(`[Tsumugi] refusing to remove registry entry "${registryKey}": ${reason}`);
    this.name = "VaultRegistryEntryRemovalRefusedError";
  }
}

/**
 * Registryから、単一レコード（Conversation／Reflection／Source）のentryを削除する（statusの書き換えではなく、
 * `records[key]`と`files[path]`自体の除去）。次の全てを、Registryロックの中で確認できた場合だけ行う：
 * status==="missing"、種別が単一レコード、memberIdsがこのkeyだけ、期待するpathと一致、同じpathを指す他のkeyが無い。
 * 既にentryが無ければ`"absent"`（冪等）。shardの読み取り・parseの失敗は例外（存在しないと混同しない）。
 */
export async function removeVaultRegistrySingleRecordEntry(
  root: FileSystemDirectoryHandle,
  registryKey: string,
  expectedPath: string
): Promise<"removed" | "absent"> {
  const bucket = vaultRegistryBucketOf(registryKey);
  return withVaultRegistryLock(async () => {
    const tsumugiDir = await getDirIfExists(root, ".tsumugi");
    const registryDir = tsumugiDir ? await getDirIfExists(tsumugiDir, "registry") : null;
    if (!registryDir) return "absent";
    const read = await readStrictJson(registryDir, vaultRegistryBucketFileName(bucket));
    if (read.status === "absent") return "absent";
    const shard = validateVaultRegistryShardStructure(read.value);
    if (shard === null) throw new Error("registry shard is malformed");
    const path = shard.records[registryKey];
    if (path === undefined) return "absent";
    if (path !== expectedPath) throw new VaultRegistryEntryRemovalRefusedError(registryKey, "path changed since the check");
    const entry = shard.files[path];
    if (entry.status !== "missing") throw new VaultRegistryEntryRemovalRefusedError(registryKey, `status is "${entry.status}"`);
    if (entry.recordType === "memory-day") throw new VaultRegistryEntryRemovalRefusedError(registryKey, "memory-day is not supported");
    if (entry.memberIds.length !== 1 || entry.memberIds[0] !== registryKey) {
      throw new VaultRegistryEntryRemovalRefusedError(registryKey, "entry has other members");
    }
    if (Object.entries(shard.records).some(([key, p]) => key !== registryKey && p === path)) {
      throw new VaultRegistryEntryRemovalRefusedError(registryKey, "another record shares the path");
    }
    delete shard.records[registryKey];
    delete shard.files[path];
    await writeVaultRegistryShard(root, bucket, shard);
    return "removed";
  });
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
 * Vault Registry（Step 3：read経路への接続）。
 *
 * registry entryの有無・statusに応じてread先を決める方針（write側Step 2と対称）：
 *   entryなし              → 既存Vault互換のため、従来の決定論的pathへfallback
 *   entryあり + status ok  → registry actual pathのみを読む（読めなければ
 *                             「見つからない」、決定論的pathへは絶対にfallbackしない）
 *   entryあり + non-ok     → 「見つからない」として扱う（試みすらしない）。
 *                             registryが「旧pathは信用できない」と判断している
 *                             状態で決定論的pathへ戻ると、移動前・削除前の
 *                             ファイルを誤って読んでしまう可能性があるため。
 * read経路はstatus変更・registry/History Index/index.json更新・ファイル/
 * ディレクトリ作成のいずれも行わない（副作用なし。lookup→path resolve→readのみ）。
 */

/**
 * 指定日のMemory（day-file統合分）だけを読む。Reflection Summary（1record1file）は
 * 含まれない——`readReflectionById`で別途idごとに読むこと。registryKeyは
 * `dayFileRegistryKey(day)`（day-file container単位。個々のMemory idではない）。
 */
export async function readMemoriesForDay(root: FileSystemDirectoryHandle, day: string): Promise<MemoryObject[]> {
  const registryKey = dayFileRegistryKey(day);
  const lookup = await lookupVaultRegistryRecord(root, registryKey);

  if (lookup.entry === undefined) {
    try {
      const dir = await root.getDirectoryHandle("Memories", { create: false });
      return await readDayFileEntries(dir, dayFileNameFor(day));
    } catch {
      return [];
    }
  }

  if (lookup.entry.status !== "ok") {
    return [];
  }

  try {
    const resolved = await resolveVaultRelativePath(root, lookup.path as string);
    return await readDayFileEntries(resolved.dir, resolved.fileName);
  } catch {
    return [];
  }
}

/**
 * `HistoryDayIndex.reflectionIds`の1件を読む。registryKeyはreflectionのid自身
 * （write側`writeMemoryObjectMarkdownImpl`のreflection分岐と同じ）。
 * `memoriesDir`（省略可）：entryなしのfallback時にのみ使う——registry actual
 * pathを読む場合は`resolveVaultRelativePath`が`root`から都度解決するため、
 * このヒントは使われない（後方互換のため引数自体は維持する）。
 */
export async function readReflectionById(
  root: FileSystemDirectoryHandle,
  id: string,
  day: string,
  memoriesDir?: FileSystemDirectoryHandle
): Promise<MemoryObject | null> {
  const lookup = await lookupVaultRegistryRecord(root, id);

  if (lookup.entry === undefined) {
    try {
      const dir = memoriesDir ?? (await root.getDirectoryHandle("Memories", { create: false }));
      const fileHandle = await dir.getFileHandle(fileNameFor(id, day), { create: false });
      const file = await fileHandle.getFile();
      return parseMemoryObjectMarkdown(await file.text());
    } catch {
      return null;
    }
  }

  if (lookup.entry.status !== "ok") {
    return null;
  }

  try {
    const resolved = await resolveVaultRelativePath(root, lookup.path as string);
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    const file = await fileHandle.getFile();
    return parseMemoryObjectMarkdown(await file.text());
  } catch {
    return null;
  }
}

/**
 * `HistoryDayIndex.conversationIds`の1件を読む。registryKeyはconversationのid自身
 * （write側`writeConversationMarkdownImpl`と同じ）。`conversationsDir`（省略可）：
 * `readReflectionById`の`memoriesDir`と同じ理由・同じ後方互換の任意引数。
 */
export async function readConversationById(
  root: FileSystemDirectoryHandle,
  id: string,
  day: string,
  conversationsDir?: FileSystemDirectoryHandle
): Promise<Conversation | null> {
  const lookup = await lookupVaultRegistryRecord(root, id);

  if (lookup.entry === undefined) {
    try {
      const dir = conversationsDir ?? (await root.getDirectoryHandle("Conversations", { create: false }));
      const fileHandle = await dir.getFileHandle(fileNameFor(id, day), { create: false });
      const file = await fileHandle.getFile();
      return parseConversationMarkdown(await file.text());
    } catch {
      return null;
    }
  }

  if (lookup.entry.status !== "ok") {
    return null;
  }

  try {
    const resolved = await resolveVaultRelativePath(root, lookup.path as string);
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
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
export function fileNameFor(id: string, isoDate: string) {
  const datePart = isoDate.slice(0, 10);
  return `${datePart}-${shortId(id)}.md`;
}

/** 「1日1Markdown」（通常のMemory）のファイル名。同じ日のMemoryは全てこのファイルへ統合する。 */
export function dayFileNameFor(isoDate: string) {
  return `${isoDate.slice(0, 10)}.md`;
}

/**
 * 「保存先にない記録の追加」（`vaultAppendLocal.ts`の専用execute経路）専用の書き込みモード。
 *
 * `adoptLocalOnly: true`の場合に限り、「Registryにentryが無く、`createdAt`がbaseline以前」という
 * 理由だけでの保留（baseline gateの`createdAt`比較）を外す。それ以外は通常の書き込みと完全に同一：
 * - baseline自体が未確立（null）なら通常どおり保留する
 * - Registry entryが存在する場合（`ok`以外）の保留は変わらない
 * - 書き込み先のファイルが既に存在する場合は、既存ファイルの上書きを防ぐため拒否する
 *   （`VaultAdoptTargetExistsError`）
 * - 本文・`createdAt`・`updatedAt`は一切書き換えない（渡されたrecordをそのまま保存する）
 * - 本文・`index.json`・History Index・Registry・sync ledgerの更新は通常の書き込みと同じコードを通る
 * 呼び出してよいのは`vaultAppendLocal.ts`の`appendLocalRecordsToVault`だけ（dry-run・Vault全体の
 * 痕跡確認・world lock内での再検証を済ませたrecordに対してのみ）。通常の保存・flushは指定しない。
 */
export interface VaultWriteOptions {
  adoptLocalOnly?: boolean;
}

/** `adoptLocalOnly`の書き込み先ファイルが既に存在した場合（既存ファイルを上書きしないための拒否）。 */
export class VaultAdoptTargetExistsError extends Error {
  readonly fileName: string;
  constructor(fileName: string) {
    super(`[Tsumugi] refusing to write: "${fileName}" already exists in the vault (adopt-local-only never overwrites an existing file).`);
    this.name = "VaultAdoptTargetExistsError";
    this.fileName = fileName;
  }
}

/**
 * 書き込み先に既存ファイルがある場合は拒否する（上書きしない）。ただし次の2つは書き込んでよい：
 * - 空（0 byte）のファイル：以前の書き込みが途中で失敗して残った（データを含まない）もの
 * - 内容が、これから書く内容（`expectedContent`）と完全に一致するファイル：以前の追加が、本文の書き込み後・
 *   Registry確定前に中断して残ったもの（同じ内容の上書きは無害で、残りの手順を完了できる）
 */
async function assertAdoptTargetAbsent(dir: FileSystemDirectoryHandle, fileName: string, expectedContent: string): Promise<void> {
  let file: File;
  try {
    file = await (await dir.getFileHandle(fileName, { create: false })).getFile();
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  if (file.size === 0) return;
  if ((await file.text()) === expectedContent) return;
  throw new VaultAdoptTargetExistsError(fileName);
}

async function writeConversationMarkdownImpl(
  root: FileSystemDirectoryHandle,
  conversation: Conversation,
  dirHandleCache?: VaultDirHandleCache,
  options?: VaultWriteOptions
) {
  const dir = await getCachedVaultTopLevelDir(root, "Conversations", "conversation dirHandle", dirHandleCache);

  // Vault Registry（Step 2）：真の新規recordは現行命名規則、既存recordは
  // registry記載のactual pathへ。needs-resync/missing/conflictは書き込み保留。
  //
  // Registry absent baseline gate：Registry entryが無いというだけでは
  // 「真に新規」を意味しない（Registry導入前のlegacy recordもRegistry absent
  // になり得るため）。baselineEstablishedAt（初回full resync成功時刻、以後
  // 不変）より後にこのConversationがcreateされた場合にのみ「真に新規」と
  // 判定する。baseline未確立、またはcreatedAtがbaseline以前/不正な場合は
  // 一律write保留とし、旧pathへの自動再作成を絶対に行わない。
  const registryKey = conversation.id;
  const lookup = await lookupVaultRegistryRecord(root, registryKey);
  let targetDir = dir;
  let fileName: string;
  let relativePath: string;
  if (lookup.entry === undefined) {
    const meta = await readVaultRegistryMeta(root);
    const baselineEstablishedAt = meta.baselineEstablishedAt;
    if (
      baselineEstablishedAt === null ||
      (!options?.adoptLocalOnly && !isRecordNewerThanBaseline(conversation.createdAt, baselineEstablishedAt))
    ) {
      throw new VaultRecordNeedsResyncError("conversation", registryKey, "needs-resync", "baseline-not-established");
    }
    fileName = fileNameFor(conversation.id, conversation.startedAt);
    relativePath = `Conversations/${fileName}`;
    if (options?.adoptLocalOnly) await assertAdoptTargetAbsent(dir, fileName, conversationToMarkdown(conversation));
  } else if (lookup.entry.status === "ok") {
    relativePath = lookup.path as string;
    const resolved = await resolveVaultRelativePath(root, relativePath, dirHandleCache);
    targetDir = resolved.dir;
    fileName = resolved.fileName;
    // Critical/High修正：write前に実ファイルの存在・内容整合性を検証する
    // （旧pathへの自動再作成・外部編集の無条件上書きを防ぐ）。安全確認自体
    // （実ファイル存在確認・Registry path確認）は変更していない。
    await verifyVaultRegistryEntryBeforeWrite(root, registryKey, targetDir, fileName, lookup.entry);
  } else {
    throw new VaultRecordNeedsResyncError("conversation", registryKey, lookup.entry.status, holdReasonFromEntryStatus(lookup.entry.status));
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
  priority: VaultWritePriority = "interactive",
  dirHandleCache?: VaultDirHandleCache,
  options?: VaultWriteOptions
): Promise<void> {
  await enqueueVaultWrite(
    () => writeConversationMarkdownImpl(root, conversation, dirHandleCache, options),
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
async function writeSourceMarkdownImpl(
  root: FileSystemDirectoryHandle,
  source: Source,
  dirHandleCache?: VaultDirHandleCache,
  options?: VaultWriteOptions
) {
  const dir = await getCachedVaultTopLevelDir(root, "Sources", "source dirHandle", dirHandleCache);

  // Vault Registry（Step 2）：Conversationと同じ分岐（真の新規／既存recordの
  // registry path／needs-resync等でwrite保留）。
  //
  // Registry absent baseline gate：Conversationと同じ判定
  // （`isRecordNewerThanBaseline`のコメント参照）。
  const registryKey = source.id;
  const lookup = await lookupVaultRegistryRecord(root, registryKey);
  let targetDir = dir;
  let fileName: string;
  let relativePath: string;
  if (lookup.entry === undefined) {
    const meta = await readVaultRegistryMeta(root);
    const baselineEstablishedAt = meta.baselineEstablishedAt;
    if (
      baselineEstablishedAt === null ||
      (!options?.adoptLocalOnly && !isRecordNewerThanBaseline(source.createdAt, baselineEstablishedAt))
    ) {
      throw new VaultRecordNeedsResyncError("source", registryKey, "needs-resync", "baseline-not-established");
    }
    fileName = fileNameFor(source.id, source.createdAt);
    relativePath = `Sources/${fileName}`;
    if (options?.adoptLocalOnly) await assertAdoptTargetAbsent(dir, fileName, sourceToMarkdown(source));
  } else if (lookup.entry.status === "ok") {
    relativePath = lookup.path as string;
    const resolved = await resolveVaultRelativePath(root, relativePath, dirHandleCache);
    targetDir = resolved.dir;
    fileName = resolved.fileName;
    // Critical/High修正：write前に実ファイルの存在・内容整合性を検証する。
    await verifyVaultRegistryEntryBeforeWrite(root, registryKey, targetDir, fileName, lookup.entry);
  } else {
    throw new VaultRecordNeedsResyncError("source", registryKey, lookup.entry.status, holdReasonFromEntryStatus(lookup.entry.status));
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
  priority: VaultWritePriority = "interactive",
  dirHandleCache?: VaultDirHandleCache,
  options?: VaultWriteOptions
): Promise<void> {
  await enqueueVaultWrite(
    () => writeSourceMarkdownImpl(root, source, dirHandleCache, options),
    priority,
    vaultSyncKeyFor("source", source.id)
  );
  await markVaultSynced("source", source.id, source.updatedAt);
}

/**
 * Reflection（「本日はここまで」）が生成する system-generated の Insight（Summary）は、
 * 既存の1record=1fileの保存形式をそのまま維持する（日別ファイルへは統合しない）。
 */
export function isReflectionSummary(memoryObject: MemoryObject): boolean {
  return memoryObject.metadata.source === "system-generated";
}

/**
 * normal Memory day-file（Registry absent時）のbaseline gateに使う。指定した
 * dayについて、IndexedDB上に存在する全normal Memory（Reflectionは対象外——
 * Reflectionは1record1fileであり、day-file containerのmemberではないため）の
 * createdAtが、1件残らずbaselineEstablishedAtより後かどうかを判定する。
 *
 * 今回書こうとしている1件のmemoryObjectだけでなく、同じdayの既存member全員を
 * 見ることで、「legacy memberが1件でも存在する日には、新規memberが来ても
 * day-fileを新規createしない」という安全側の判定にする。
 *
 * dayMembersが0件の場合は`every`の仕様上trueになってしまうが、これを
 * 「true newと証明できた」とは扱わない——このhelperはnormal Memory write中に
 * 呼ばれるため、本来は書こうとしている当該memoryObject自身が`putMemoryObject`
 * 済みでIndexedDB上に存在しているはずであり（`writeMemoryObjectMarkdown`は
 * 呼び出し元が`putMemoryObject`後に呼ぶ）、0件はそれが何らかの理由で見えて
 * いない異常系を意味する。真に0件かどうかをここで推測せず、安全側にHOLDする。
 */
export async function isMemoryDayContainerAllNew(day: string, baselineEstablishedAt: string): Promise<boolean> {
  const all = await getAllMemoryObjects();
  const dayMembers = all.filter((m) => !isReflectionSummary(m) && m.date.slice(0, 10) === day);
  if (dayMembers.length === 0) return false;
  return dayMembers.every((m) => isRecordNewerThanBaseline(m.createdAt, baselineEstablishedAt));
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
async function writeMemoryObjectMarkdownImpl(
  root: FileSystemDirectoryHandle,
  memoryObject: MemoryObject,
  dirHandleCache?: VaultDirHandleCache,
  options?: VaultWriteOptions
) {
  const dir = await getCachedVaultTopLevelDir(root, "Memories", "memory dirHandle", dirHandleCache);

  if (isReflectionSummary(memoryObject)) {
    // Vault Registry（Step 2）：Reflectionは1record1fileのため、Conversation/Sourceと
    // 同じ分岐（真の新規／既存recordのregistry path／needs-resync等でwrite保留）。
    //
    // Registry absent baseline gate：Conversationと同じ判定
    // （`isRecordNewerThanBaseline`のコメント参照）。
    const registryKey = memoryObject.id;
    const lookup = await lookupVaultRegistryRecord(root, registryKey);
    let targetDir = dir;
    let fileName: string;
    let relativePath: string;
    if (lookup.entry === undefined) {
      const meta = await readVaultRegistryMeta(root);
      const baselineEstablishedAt = meta.baselineEstablishedAt;
      if (
        baselineEstablishedAt === null ||
        (!options?.adoptLocalOnly && !isRecordNewerThanBaseline(memoryObject.createdAt, baselineEstablishedAt))
      ) {
        throw new VaultRecordNeedsResyncError("reflection", registryKey, "needs-resync", "baseline-not-established");
      }
      fileName = fileNameFor(memoryObject.id, memoryObject.date);
      relativePath = `Memories/${fileName}`;
      if (options?.adoptLocalOnly) await assertAdoptTargetAbsent(dir, fileName, memoryObjectToMarkdown(memoryObject));
    } else if (lookup.entry.status === "ok") {
      relativePath = lookup.path as string;
      const resolved = await resolveVaultRelativePath(root, relativePath, dirHandleCache);
      targetDir = resolved.dir;
      fileName = resolved.fileName;
      // Critical/High修正：write前に実ファイルの存在・内容整合性を検証する。
      await verifyVaultRegistryEntryBeforeWrite(root, registryKey, targetDir, fileName, lookup.entry);
    } else {
      throw new VaultRecordNeedsResyncError("reflection", registryKey, lookup.entry.status, holdReasonFromEntryStatus(lookup.entry.status));
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
    // Registry absent baseline gate（day-file container版）：今回writeしようと
    // している1件のmemoryObject.createdAtだけを見て判定してはいけない。同じdayに
    // baseline以前から存在するlegacy normal Memoryが1件でもあれば、そのcontainer
    // （day-file）は「真に新規」ではない可能性があるため、day全体を保留する
    // （CASE BD：legacy Aが存在する日にbaseline後の新規Bを追加しても、Bだけで
    // 新しいday-fileを作ってはいけない）。
    const meta = await readVaultRegistryMeta(root);
    const baselineEstablishedAt = meta.baselineEstablishedAt;
    if (
      baselineEstablishedAt === null ||
      (!options?.adoptLocalOnly && !(await isMemoryDayContainerAllNew(day, baselineEstablishedAt)))
    ) {
      throw new VaultRecordNeedsResyncError("memory-day", registryKey, "needs-resync", "baseline-not-established");
    }
    fileName = dayFileNameFor(memoryObject.date);
    relativePath = `Memories/${fileName}`;
    if (options?.adoptLocalOnly) await assertAdoptTargetAbsent(dir, fileName, serializeMemoryDayFile([memoryObject]));
  } else if (lookup.entry.status === "ok") {
    relativePath = lookup.path as string;
    const resolved = await resolveVaultRelativePath(root, relativePath, dirHandleCache);
    targetDir = resolved.dir;
    fileName = resolved.fileName;
    // Critical/High修正：day-fileのmerge材料として読む前に、実ファイルの存在・
    // 内容整合性を検証する。外部で移動/削除・外部編集されているday-fileを
    // そのまま読み込んでmergeし、暗黙的に外部変更を採用してしまう経路を作らない。
    const verifyResult = await verifyVaultRegistryEntryBeforeWrite(root, registryKey, targetDir, fileName, lookup.entry);
    verifiedActualText = verifyResult.actualText;
  } else {
    throw new VaultRecordNeedsResyncError("memory-day", registryKey, lookup.entry.status, holdReasonFromEntryStatus(lookup.entry.status));
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
  priority: VaultWritePriority = "interactive",
  dirHandleCache?: VaultDirHandleCache,
  options?: VaultWriteOptions
): Promise<void> {
  await enqueueVaultWrite(
    () => writeMemoryObjectMarkdownImpl(root, memoryObject, dirHandleCache, options),
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
 *
 * `heldCount`（実機不具合対応）：`VaultRecordNeedsResyncError`は、Registry baseline
 * gate（baselineEstablishedAt）や既存のneeds-resync検出が「外部変更を検出したので
 * 安全のためこのrecordの書き込みを保留した」ことを示す、想定された安全HOLDであり、
 * ディスクI/O失敗等の真の異常系（`failedCount`）とは意味が異なる。以前は両者を区別
 * せず一律`failedCount`へ計上していたため、legacy record（Registry baseline未確立、
 * または外部で移動されたrecord）が1件でも保留されるだけで、呼び出し元
 * （Vault切替フロー）が「flush-failed」として保存先変更そのものを丸ごとブロック
 * してしまう実機不具合があった。HOLDは「そのrecordがIndexedDBに未同期のまま安全に
 * 残る」だけで実際のデータ喪失は起きないため、`failedCount`から除外し、この専用の
 * `heldCount`へ計上する（Vaultを再同期すれば解消する、という性質を呼び出し元が
 * 判別できるようにする）。
 */
export interface FlushResult {
  totalCount: number;
  writtenCount: number;
  failedCount: number;
  heldCount: number;
  /**
   * UX調査対応（HOLD原因の区別）：`heldCount`の内訳。UI側
   * （`vaultHoldReasons`相当）が「HOLD＝light-checkで見つかる外部変更」と
   * 誤解しないよう、原因ごとに分けて返す。合計は`heldCount`と一致する。
   */
  heldByReason: Record<VaultHoldReason, number>;
}

function emptyHeldByReason(): Record<VaultHoldReason, number> {
  return { "baseline-not-established": 0, "needs-resync": 0, missing: 0, conflict: 0 };
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
  let heldCount = 0;
  // 実機不具合対応（aggregate diagnostic）：実際にwrite試行された（＝
  // isAlreadySyncedToVaultでスキップされなかった）record数。writtenCount＋
  // failedCount＋heldCountと必ず一致する。
  let pendingCount = 0;
  const heldByReason = emptyHeldByReason();
  // 実機不具合対応（Android性能改善）：この1回のflush実行の間だけ、
  // Conversations/Memories/Sourcesディレクトリハンドルを使い回す。ローカル
  // 変数のため、この関数を抜ければ破棄され、次回のflushへは持ち越さない。
  const dirHandleCache: VaultDirHandleCache = new Map();
  for (const conversation of conversations) {
    if (signal?.aborted) {
      logTimingEvent("Vault flush:aborted", { count: totalCount, writtenCount });
      return { totalCount, writtenCount, failedCount, heldCount, heldByReason };
    }
    if (await isAlreadySyncedToVault("conversation", conversation.id, conversation.updatedAt)) continue;
    pendingCount += 1;
    try {
      await writeConversationMarkdown(root, conversation, priority, dirHandleCache);
      writtenCount += 1;
    } catch (error) {
      if (error instanceof VaultRecordNeedsResyncError) {
        heldCount += 1;
        heldByReason[error.holdReason] += 1;
        console.log("[Vault] flush: conversation write held pending vault resync (expected):", error.message);
        // 実機不具合対応（Android診断）：holdReason/recordTypeだけを診断ログへ記録する
        // （registryKey/ID/path/本文は含めない。debugTimingLog.tsのprivacy方針を維持）。
        logTimingEvent("Vault flush:held", { holdReason: error.holdReason, recordType: error.recordType });
      } else {
        failedCount += 1;
        console.error("[Tsumugi] flush: conversation write failed (will retry on next flush):", error);
      }
    }
  }
  for (const memoryObject of memoryObjects) {
    if (signal?.aborted) {
      logTimingEvent("Vault flush:aborted", { count: totalCount, writtenCount });
      return { totalCount, writtenCount, failedCount, heldCount, heldByReason };
    }
    if (await isAlreadySyncedToVault("memory", memoryObject.id, memoryObject.updatedAt)) continue;
    pendingCount += 1;
    try {
      await writeMemoryObjectMarkdown(root, memoryObject, priority, dirHandleCache);
      writtenCount += 1;
    } catch (error) {
      if (error instanceof VaultRecordNeedsResyncError) {
        heldCount += 1;
        heldByReason[error.holdReason] += 1;
        console.log("[Vault] flush: memory write held pending vault resync (expected):", error.message);
        logTimingEvent("Vault flush:held", { holdReason: error.holdReason, recordType: error.recordType });
      } else {
        failedCount += 1;
        console.error("[Tsumugi] flush: memory write failed (will retry on next flush):", error);
      }
    }
  }
  for (const source of sources) {
    if (signal?.aborted) {
      logTimingEvent("Vault flush:aborted", { count: totalCount, writtenCount });
      return { totalCount, writtenCount, failedCount, heldCount, heldByReason };
    }
    if (await isAlreadySyncedToVault("source", source.id, source.updatedAt)) continue;
    pendingCount += 1;
    try {
      await writeSourceMarkdown(root, source, priority, dirHandleCache);
      writtenCount += 1;
    } catch (error) {
      if (error instanceof VaultRecordNeedsResyncError) {
        heldCount += 1;
        heldByReason[error.holdReason] += 1;
        console.log("[Vault] flush: source write held pending vault resync (expected):", error.message);
        logTimingEvent("Vault flush:held", { holdReason: error.holdReason, recordType: error.recordType });
      } else {
        failedCount += 1;
        console.error("[Tsumugi] flush: source write failed (will retry on next flush):", error);
      }
    }
  }

  const flushDurationMs = Date.now() - flushStart;
  console.log(
    `[Vault] flush:end count=${totalCount} writtenCount=${writtenCount} failedCount=${failedCount} heldCount=${heldCount} durationMs=${flushDurationMs}`
  );
  // 実機不具合対応（aggregate diagnostic）：既存の"Vault flush:end"イベントへ
  // pendingCount/heldCountを追加するだけで、新規イベントは増やさない。
  logTimingEvent("Vault flush:end", { count: totalCount, writtenCount, pendingCount, heldCount, durationMs: flushDurationMs });
  return { totalCount, writtenCount, failedCount, heldCount, heldByReason };
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

/** collectVaultMarkdownが返す1ファイル分。`name`は（フォルダを含まない）ファイル名のみ。 */
interface VaultCollectedFile {
  name: string;
  text: string;
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
): Promise<VaultCollectedFile[]> {
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

  const contents: VaultCollectedFile[] = [];
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

    contents.push({ name, text });
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
  /**
   * 同じidが複数のファイル（旧1record1file形式とday-file、または重複・手動コピー）に
   * 存在し、1件へ絞り込んだ回数（採用されなかった側の件数）。
   */
  duplicatesResolved: { conversations: number; memoryObjects: number; sources: number };
}

/** 「1日1Markdown」のday-file名（`YYYY-MM-DD.md`）。旧1record1file形式（`YYYY-MM-DD-xxxxxx.md`）とは別。 */
export function isMemoryDayFileName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(name);
}

interface RestoreCandidateMeta {
  updatedAt: string;
  fileName: string;
  /** 小さいほど優先（同じupdatedAtのときだけ使う）。Memoryのday-fileが0、それ以外は1。 */
  rank: number;
}

/**
 * 同じidの候補が複数あるときの採用規則。1) updatedAtが新しい方、2) 同じならday-file
 * （Memoryのみ。旧形式より優先）、3) それでも同じならファイル名が短い方（`xxx+.md`のような
 * 重複コピーより元のファイル名を優先）、4) 最後は辞書順。走査順（ファイルシステムの
 * 列挙順）に結果が依存しないよう、必ず全順序で決める。
 */
function shouldReplaceRestoreCandidate(existing: RestoreCandidateMeta, next: RestoreCandidateMeta): boolean {
  if (existing.updatedAt !== next.updatedAt) return existing.updatedAt < next.updatedAt;
  if (existing.rank !== next.rank) return next.rank < existing.rank;
  if (existing.fileName.length !== next.fileName.length) return next.fileName.length < existing.fileName.length;
  return next.fileName < existing.fileName;
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
  const collectWithPhaseLog = async (folderName: string): Promise<VaultCollectedFile[]> => {
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
    (result) => (result as PromiseFulfilledResult<VaultCollectedFile[]>).value
  );
  const scanFileCount = conversationFiles.length + memoryFiles.length + sourceFiles.length;
  const scanDurationMs = Date.now() - scanStart;
  console.log(`[Vault] scan:end fileCount=${scanFileCount} durationMs=${scanDurationMs}`);
  logTimingEvent("Vault scan:end", { fileCount: scanFileCount, durationMs: scanDurationMs });

  const duplicatesResolved = { conversations: 0, memoryObjects: 0, sources: 0 };

  const conversationsById = new Map<string, { value: Conversation; meta: RestoreCandidateMeta }>();
  for (const file of conversationFiles) {
    const parsed = parseConversationMarkdown(file.text);
    if (!parsed) {
      skippedCount += 1;
      continue;
    }
    const meta: RestoreCandidateMeta = { updatedAt: parsed.updatedAt, fileName: file.name, rank: 1 };
    const existing = conversationsById.get(parsed.id);
    if (existing) duplicatesResolved.conversations += 1;
    if (!existing || shouldReplaceRestoreCandidate(existing.meta, meta)) {
      conversationsById.set(parsed.id, { value: parsed, meta });
    }
  }

  const memoryObjectsById = new Map<string, { value: MemoryObject; meta: RestoreCandidateMeta }>();
  for (const file of memoryFiles) {
    const parsedEntries = parseMemoryDayFile(file.text);
    if (parsedEntries.length === 0) {
      skippedCount += 1;
      continue;
    }
    const rank = isMemoryDayFileName(file.name) ? 0 : 1;
    for (const parsed of parsedEntries) {
      const meta: RestoreCandidateMeta = { updatedAt: parsed.updatedAt, fileName: file.name, rank };
      const existing = memoryObjectsById.get(parsed.id);
      if (existing) duplicatesResolved.memoryObjects += 1;
      if (!existing || shouldReplaceRestoreCandidate(existing.meta, meta)) {
        memoryObjectsById.set(parsed.id, { value: parsed, meta });
      }
    }
  }

  const sourcesById = new Map<string, { value: Source; meta: RestoreCandidateMeta }>();
  for (const file of sourceFiles) {
    let parsed: Source;
    try {
      parsed = parseSourceMarkdown(file.text);
    } catch {
      skippedCount += 1;
      continue;
    }
    const meta: RestoreCandidateMeta = { updatedAt: parsed.updatedAt, fileName: file.name, rank: 1 };
    const existing = sourcesById.get(parsed.id);
    if (existing) duplicatesResolved.sources += 1;
    if (!existing || shouldReplaceRestoreCandidate(existing.meta, meta)) {
      sourcesById.set(parsed.id, { value: parsed, meta });
    }
  }

  return {
    conversations: [...conversationsById.values()].map((entry) => entry.value),
    memoryObjects: [...memoryObjectsById.values()].map((entry) => entry.value),
    sources: [...sourcesById.values()].map((entry) => entry.value),
    skippedCount,
    duplicatesResolved,
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
  /**
   * 最初にRegistry baselineが確立された（＝初回full resyncが成功した）時刻。
   * `lastFullResyncAt`と異なり、一度設定した後は以後のresyncで一切更新しない
   * （`resyncVaultRegistry`参照）。Registry absentなrecordの新規/legacy判定
   * （`createdAt`との比較）に使う固定境界時刻。未確立ならnull。
   * 旧`registry-meta.json`にはこのfieldが存在しないため、読み込み側
   * （`readVaultRegistryMeta`）で必ず`undefined`を`null`へ正規化する。
   */
  baselineEstablishedAt: string | null;
  /**
   * B1（軽量Registry index・多tab安全性設計）：現在の「dirty spell」を識別する
   * generation token。`registryGeneration`未確立（このfieldが存在しない、＝
   * 旧Vaultまたは初回）の場合、将来のB2以降の判定では「cheap ownershipを
   * 許可しない」側へ倒す（`readVaultRegistryMeta`は値を強制せず、`undefined`
   * のまま返す——「未確立」という事実自体が意味を持つため、他のfieldのように
   * nullへ正規化しない）。
   *
   * 今回（B1/B2）はこのfieldを実際に書き込む経路がまだ存在しない
   * （配線はB3以降）。既存のfull resync等の書き込み経路は、読み込んだ
   * `VaultRegistryMeta`オブジェクトをread-modify-writeするだけであり、この
   * fieldに触れなければ`JSON.stringify`が自動的に省略するため、既存Vaultの
   * registry-meta.jsonに意図せずこのfieldが出現することは無い。
   */
  registryGeneration?: string;
  /**
   * B1：現在のdirty spellの所有者。`null`＝clean（誰もdirty spellを構成して
   * いない）。実在のinstanceId＝その1つのinstanceが唯一の所有者。
   * `VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE`＝複数instanceが関与し、誰の所有権
   * 主張も無効（cheap indexのpersistは誰にも許可しない）。
   *
   * 旧Vaultにはこのfieldが存在しないため、`readVaultRegistryMeta`は
   * `undefined`を`null`（clean）へ正規化する——`baselineEstablishedAt`と同じ
   * パターン。今回（B1/B2）はこのfieldを実際に書き込む経路がまだ存在しない。
   */
  dirtyOwnerInstanceId?: string | null;
}

/** 呼び出しごとに新しいオブジェクトを返す（`emptyHistoryMeta`/`emptyMonthIndex`と
 *  同じ理由：`readJSON`のfallbackを呼び出し元が直接書き換えるため、共有の
 *  定数オブジェクトを使うと2回目以降の「まだファイルが無い」呼び出しが
 *  前回の書き換え結果を誤って引き継いでしまう）。 */
function emptyVaultRegistryShard(bucket: number): VaultRegistryShard {
  return { schemaVersion: 1, bucket, records: {}, files: {} };
}

function emptyVaultRegistryMeta(): VaultRegistryMeta {
  // B1: registryGenerationはあえて含めない（＝undefined）。「未確立」という
  // 状態そのものが意味を持つため、他のfieldのように既定値を与えない。
  return { schemaVersion: 1, updatedAt: "", lastFullResyncAt: null, baselineEstablishedAt: null, dirtyOwnerInstanceId: null };
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
/**
 * 実機不具合対応（Android性能改善）：既に解決済みの`registryDir`ハンドルを
 * 呼び出し元から受け取って読むだけの内部helper。`.tsumugi`/`.tsumugi/registry`の
 * 再解決を行わないため、同一operation内で複数shardを読む場合（
 * `buildVaultRegistrySnapshot`等）はこちらを使うことで重複I/Oを避けられる。
 * 既存の`readVaultRegistryShard`（下記）はこのhelperを内部的に使うだけで、
 * 挙動・戻り値は一切変えていない。
 */
async function readVaultRegistryShardFromDir(registryDir: FileSystemDirectoryHandle, bucket: number): Promise<VaultRegistryShard> {
  return await readJSON<VaultRegistryShard>(
    registryDir,
    vaultRegistryBucketFileName(bucket),
    emptyVaultRegistryShard(bucket),
    "registry shard read"
  );
}

export async function readVaultRegistryShard(root: FileSystemDirectoryHandle, bucket: number): Promise<VaultRegistryShard> {
  try {
    const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
    const registryDir = await tsumugiDir.getDirectoryHandle("registry", { create: false });
    return await readVaultRegistryShardFromDir(registryDir, bucket);
  } catch {
    return emptyVaultRegistryShard(bucket);
  }
}

export async function readVaultRegistryMeta(root: FileSystemDirectoryHandle): Promise<VaultRegistryMeta> {
  try {
    const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
    const parsed = await readJSON<VaultRegistryMeta>(
      tsumugiDir,
      "registry-meta.json",
      emptyVaultRegistryMeta(),
      "registry meta read"
    );
    // 旧registry-meta.json（baselineEstablishedAt導入前）にはこのfieldが存在せず
    // `undefined`のままparseされる。呼び出し元が`undefined`/`null`の両方を
    // 意識せず済むよう、この関数から返る値は必ずstring | nullの正規形にする。
    // B1：`dirtyOwnerInstanceId`も同じ理由で`undefined`→`null`（clean）へ正規化する。
    // `registryGeneration`はあえて正規化しない——`undefined`（未確立）という
    // 状態自体がB2以降の判定にとって意味を持つ値のため。
    return {
      ...parsed,
      baselineEstablishedAt: parsed.baselineEstablishedAt ?? null,
      dirtyOwnerInstanceId: parsed.dirtyOwnerInstanceId ?? null,
    };
  } catch {
    return emptyVaultRegistryMeta();
  }
}

/**
 * Registry absentなrecordの新規/legacy判定用。`recordCreatedAt`（Conversation/
 * Source/ReflectionのcreatedAt、またはnormal Memory day-fileの各member
 * のcreatedAt）が、Registry baseline確立時刻より後かどうかを判定する。
 *
 * ISO 8601文字列同士の比較は`Date.parse`で数値化してから行う（文字列の
 * 辞書式比較には依存しない）。どちらか一方でも空・不正でparse不能な場合は
 * 「新規」と判定してはいけない（合意済み：parse失敗を新規扱いにしない）ため、
 * 安全側に倒して`false`（＝新規ではない＝write保留）を返す。
 */
export function isRecordNewerThanBaseline(recordCreatedAt: string, baselineEstablishedAt: string): boolean {
  const recordMs = Date.parse(recordCreatedAt);
  const baselineMs = Date.parse(baselineEstablishedAt);
  if (Number.isNaN(recordMs) || Number.isNaN(baselineMs)) return false;
  return recordMs > baselineMs;
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

/**
 * C1（軽量Registry index・多tab安全性設計のbootstrap/rebuild foundation）：
 * `.tsumugi/registry-index.json`の内容。L1/L2が実際に使うのは
 * `registryKey/path/mtime/size/recordType`の5fieldのみ（既存の軽量チェック
 * 設計と同じ範囲）であり、contentHash/memberIds/memberHashes/statusは
 * 持たない——このfileはあくまで64 shardのlightweightな代替キャッシュであり、
 * 64 shard自体（authoritative構造）を置き換えるものではない。
 *
 * 今回（C1）はこのfileを書くだけで、まだどこからも読まれない（配線は
 * 将来のC2/C4以降）。
 */
export interface VaultRegistryIndexEntry {
  path: string;
  mtime: number;
  size: number;
  recordType: VaultRegistryRecordType;
}

export interface VaultRegistryIndex {
  schemaVersion: 1;
  builtAtGeneration: string;
  records: Record<string, VaultRegistryIndexEntry>;
}

async function writeVaultRegistryIndex(root: FileSystemDirectoryHandle, index: VaultRegistryIndex): Promise<void> {
  const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: true });
  await writeFileInDir(tsumugiDir, "registry-index.json", JSON.stringify(index, null, 2), "registry index write");
}

// ---------------------------------------------------------------------------
// B2（軽量Registry index・多tab安全性設計）：ownership state machineのpure logic
//
// 重要：このセクションの関数群は、まだどこからも呼ばれていない（配線はB3以降）。
// 現在のRegistry mutation経路（writeVaultRegistryShard/upsertVaultRegistryRecord/
// markVaultRegistryNeedsResync/commitVaultRegistrySingleRecordOk/
// applyConflictOutcome/full resync）・L1/L2/L3/L4・light check startup・UIの
// いずれもこの関数群を参照しない。したがってこのセクションの追加だけでは、
// Vaultのruntime動作は一切変化しない。
//
// ここに定義する関数はいずれも副作用を持たない（Vault I/O・lock取得を一切
// 行わない）純粋関数。「今、何をすべきか」を判定するだけで、実際のmeta/index
// read・write・lock取得は全て将来のB3以降で、呼び出し元が担う。
//
// レビュー指摘（Medium 1）を受けて、CLEANからのownership開始判定と、
// OWNED_DIRTY/CONTESTEDのsteady-state継続判定を明確に分離した。このセクションが
// 提供する`decideVaultRegistryOwnershipStart`は「CLEANからownershipを開始
// できるか」だけを判定し、steady-state継続はこの関数の責務外（B3では、既に
// OWNED_DIRTY/CONTESTEDのinstanceはこの関数を呼ばず、session-local stateを
// そのまま使うfast pathとして扱う想定。そのfast path自体の新規pure function
// 化は今回のB2の対象外）。
//
// 【最重要の呼び出し規約（Invariant 6）】
// この2関数へ渡す`meta`（registryGeneration/dirtyOwnerInstanceId）は、
// 必ず`withVaultRegistryLock`を取得した**後**に改めて読み直した最新の値で
// なければならない。lock取得前に保持していたstale な値を渡すと、
// 別tabが同じlockの中で行った変更を見落とし、false-freshの原因になる
// （詳細はowner重複反例の調査を参照）。この規約を呼び出し側の実装ミスで
// 破りにくくするため、あえて「lock内で読んだfreshなmeta」という前提を
// 関数名・JSDoc・パラメータ名（`freshMeta`）で明示する。
// ---------------------------------------------------------------------------

/** このinstance（page load）が、Registry mutationの文脈で現在どのsession
 *  stateにいるかを表す。boolean `sessionDirty`ではなく、3値のstate machine
 *  として扱う（詳細は各値のコメント参照）。`decideVaultRegistryOwnershipStart`
 *  自体はこの型を入力に取らない（CLEAN専用のため）が、`checkVaultRegistry
 *  IndexPersistPreconditions`の入力として、また呼び出し元（B3）が
 *  session-local stateを持ち回すための共通の型として、ここで定義する。 */
export type VaultRegistrySessionState = "CLEAN" | "OWNED_DIRTY" | "CONTESTED";

/** `VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE`sentinelであることを型名で示すための
 *  別名。runtimeでは通常のinstanceIdと同じ`string`型であり、brand type等に
 *  よる強制的な型レベル区別は導入していない（過度な複雑化を避けるため——
 *  検討した結果、branded typeにするとinstanceId生成・比較の全箇所へcastが
 *  必要になり複雑化が実装量に見合わないと判断した）。実際の安全性は、この
 *  型ではなく`checkVaultRegistryIndexPersistPreconditions`内のruntime明示
 *  チェック（Medium 2対応）が担保する。 */
export type VaultRegistryDirtyOwnerMultipleSentinel = typeof VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE;

/**
 * `decideVaultRegistryOwnershipStart`の判定結果。呼び出し元（将来のB3）が
 * 実際に行うべきI/Oの種類を識別できるようにする。この関数はCLEANからの
 * ownership開始判定専用であり、steady-state（既にOWNED_DIRTY/CONTESTEDの
 * instanceがそのまま継続してよいか）はこの型・関数の対象外。
 *
 * - `CLAIM_OWNED_DIRTY`: 現在clean（`meta.dirtyOwnerInstanceId===null`）かつ
 *   自分のmirrorが現在のgenerationと一致している。呼び出し元は新しい
 *   generation tokenを生成し、`meta.dirtyOwnerInstanceId`を自分のinstanceIdへ
 *   書いた上でOWNED_DIRTYへ進んでよい。
 * - `INDEX_CATCH_UP_REQUIRED`: 現在cleanだが自分のmirrorが古い。呼び出し元は
 *   disk上のregistry-index.jsonを読み直し、`index.builtAtGeneration`が
 *   `meta.registryGeneration`と一致することを確認できた場合に限りmirrorを
 *   補完し、この関数を再度呼んで判定をやり直すべき（catch-up後は通常
 *   `CLAIM_OWNED_DIRTY`になる）。
 * - `BECOME_CONTESTED`: 他instance（または既存の"MULTIPLE"状態）が既に
 *   dirty spellを構成している、または安全にcatch-upできない。
 *   `requiresMultipleMarkerWrite`が`true`の場合、呼び出し元は
 *   `meta.dirtyOwnerInstanceId`へ`VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE`を
 *   書き込む必要がある（既にその値なら書き込み不要、`false`になる）。
 * - `GENERATION_NOT_ESTABLISHED`: `meta.registryGeneration`自体が存在しない
 *   （旧Vaultまたは初回）。owner側の値（null/自分と衝突しうる他instance/
 *   MULTIPLEのいずれであっても）に一切関係なく、必ずこの値へfail-closed
 *   する——cheap ownershipの比較対象となるbaseline自体が存在しないため。
 *   `BECOME_CONTESTED`と実務上の扱い（cheap ownershipを許可せず、いずれ
 *   64 shardからのfull rebuild/migrationへ倒す）は同じだが、「複数instance
 *   の競合」ではなく「そもそも基盤が無い」ことを診断上区別できるよう別の
 *   値として返す。`meta.dirtyOwnerInstanceId`への書き込みは行わない
 *   （`requiresMultipleMarkerWrite`は常に`false`）。
 */
export type VaultRegistryOwnershipStartAction =
  | "CLAIM_OWNED_DIRTY"
  | "INDEX_CATCH_UP_REQUIRED"
  | "BECOME_CONTESTED"
  | "GENERATION_NOT_ESTABLISHED";

export interface VaultRegistryOwnershipStartDecision {
  action: VaultRegistryOwnershipStartAction;
  /** `true`の場合、呼び出し元は`meta.dirtyOwnerInstanceId`へ
   *  `VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE`を書き込む必要がある。それ以外の
   *  actionでは常に`false`。 */
  requiresMultipleMarkerWrite: boolean;
}

export interface VaultRegistryOwnershipStartInput {
  /** このinstanceのin-memory mirrorが、どのregistry generationの状態を正しく
   *  反映しているか。一度もcatch-up/確立していなければ`undefined`。 */
  myMirrorBaselineGeneration: string | undefined;
  /**
   * Invariant 6：`withVaultRegistryLock`取得後に読み直した、最新の
   * registry-meta.json由来の値のみを渡すこと。lock取得前の古い値を渡しては
   * ならない。
   */
  freshMeta: {
    registryGeneration: string | undefined;
    dirtyOwnerInstanceId: string | VaultRegistryDirtyOwnerMultipleSentinel | null;
  };
  /** disk上のregistry-index.jsonが利用可能か、利用可能ならそのbuiltAtGeneration。
   *  `INDEX_CATCH_UP_REQUIRED`後の再評価でのみ意味を持つ（catch-up前の初回
   *  評価では`{available:false}`を渡してよい——generation不一致の場合は
   *  どのみち一度`INDEX_CATCH_UP_REQUIRED`を返し、呼び出し元がindexを読んでから
   *  この関数を再度呼ぶ設計のため）。 */
  diskIndex: { available: false } | { available: true; builtAtGeneration: string };
}

/**
 * CLEANからownershipを開始できるかどうかだけを判定する純粋関数（レビュー
 * 指摘Medium 1を受けて、旧`decideVaultRegistryOwnershipTransition`から
 * steady-state判定を切り離し、このCLEAN専用のAPIへ改名・縮小した）。
 * Vault I/O・lock取得を一切行わない。入力に`localState`を含まない——この
 * 関数を呼ぶこと自体が「呼び出し元は現在CLEANである」という前提であり、
 * OWNED_DIRTY/CONTESTEDのsteady-state継続は、呼び出し元がこの関数を呼ばずに
 * 自分のsession-local stateだけを見て判定する（B3のfast path）。
 *
 * 判定順序は固定：まず`registryGeneration`が未確立かどうかを、owner側の値に
 * 一切関係なく最初に判定し、未確立なら無条件で`GENERATION_NOT_ESTABLISHED`へ
 * fail-closedする。確立済みの場合のみ、owner（MULTIPLE／他instance／null）と
 * baseline一致・disk index一致を見て判定する。
 */
export function decideVaultRegistryOwnershipStart(
  input: VaultRegistryOwnershipStartInput
): VaultRegistryOwnershipStartDecision {
  const { freshMeta, myMirrorBaselineGeneration, diskIndex } = input;

  // 最優先：registry generation自体が未確立（旧Vault/初回）。owner側の値
  // （null/他instance/MULTIPLEのいずれであっても）を見るまでもなく、cheap
  // ownershipの比較対象となるbaselineが存在しないため、常にfail-closedする。
  if (freshMeta.registryGeneration === undefined) {
    return { action: "GENERATION_NOT_ESTABLISHED", requiresMultipleMarkerWrite: false };
  }

  if (freshMeta.dirtyOwnerInstanceId === VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE) {
    // 既に複数instanceの競合としてmarkされている。再度の書き込みは不要。
    return { action: "BECOME_CONTESTED", requiresMultipleMarkerWrite: false };
  }

  if (freshMeta.dirtyOwnerInstanceId !== null) {
    // 他instanceが既にdirty spellを構成している（この関数はCLEANからの
    // 開始判定専用であり、呼び出し元は自分がCLEANだと認識している以上、
    // ここに自分自身のinstanceIdが入っていることは正しい運用では起こらない
    // ——起きていればsession-local stateとmeta状態の食い違いを示す異常系
    // であり、いずれにせよ安全側で「他instance」として扱い競合へ倒す）。
    return { action: "BECOME_CONTESTED", requiresMultipleMarkerWrite: true };
  }

  // freshMeta.dirtyOwnerInstanceId === null：現在clean。
  if (myMirrorBaselineGeneration === freshMeta.registryGeneration) {
    // 自分のmirrorは現在のclean generationと一致している。安全にownershipを
    // 主張できる。
    return { action: "CLAIM_OWNED_DIRTY", requiresMultipleMarkerWrite: false };
  }

  // 自分のmirrorは現在のgenerationより古い。disk indexから安全にcatch-up
  // できるか確認する。
  if (diskIndex.available && diskIndex.builtAtGeneration === freshMeta.registryGeneration) {
    return { action: "INDEX_CATCH_UP_REQUIRED", requiresMultipleMarkerWrite: false };
  }

  // disk indexが利用不可、またはそれ自体が現在のgenerationと一致しない：
  // cheapに整合を取る方法が無いため、安全側でCONTESTEDへ倒す。
  return { action: "BECOME_CONTESTED", requiresMultipleMarkerWrite: true };
}

/** `checkVaultRegistryIndexPersistPreconditions`の入力。 */
export interface VaultRegistryGPreconditionInput {
  localState: VaultRegistrySessionState;
  myInstanceId: string;
  /** このinstance自身が`CLAIM_OWNED_DIRTY`時に生成・記録した、自分が所有して
   *  いると信じているgeneration token。一度も主張していなければ`undefined`。 */
  myOwnedGeneration: string | undefined;
  /** Invariant 6：`withVaultRegistryLock`取得後に読み直した最新の値のみを渡すこと。 */
  freshMeta: {
    registryGeneration: string | undefined;
    dirtyOwnerInstanceId: string | VaultRegistryDirtyOwnerMultipleSentinel | null;
  };
}

export type VaultRegistryGPreconditionResult =
  | { canPersist: true }
  | { canPersist: false; reason: string };

/**
 * index persist（G）を実行してよいかどうかを判定する純粋関数。Vault I/O・lock
 * 取得を一切行わない。呼び出し元は、この関数が`{canPersist:true}`を返した
 * 場合に限り、実際のindex.json/meta.jsonへの書き込みへ進んでよい（それも
 * 同じlock保持区間内で、他の変更が割り込む前に行うこと）。
 *
 * 6条件のAND判定（1つでも不成立ならfail-closedでabort、reasonに理由を残す
 * だけで、Vault I/Oは一切発生しない）:
 *   1. localState === "OWNED_DIRTY"
 *   2. myOwnedGenerationが記録されている（undefinedでない）
 *   3. myInstanceIdが`VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE`sentinelそのもの
 *      ではない（レビュー指摘Medium 2：万一呼び出し元がinstanceIdの代わりに
 *      誤ってsentinel値を渡した場合、条件5の等値比較がたまたま一致して
 *      persistを誤って許可してしまう反例が存在したため、独立した明示チェック
 *      として拒否する）
 *   4. freshMeta.dirtyOwnerInstanceIdが`VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE`
 *      sentinelではない（レビュー指摘Medium 2：条件5の不一致判定に暗黙的に
 *      依存せず、MULTIPLE状態でのpersist拒否を独立した明示チェックとして
 *      固定する）
 *   5. freshMeta.dirtyOwnerInstanceId === myInstanceId
 *   6. freshMeta.registryGeneration === myOwnedGeneration
 */
export function checkVaultRegistryIndexPersistPreconditions(
  input: VaultRegistryGPreconditionInput
): VaultRegistryGPreconditionResult {
  if (input.localState !== "OWNED_DIRTY") {
    return { canPersist: false, reason: "local session state is not OWNED_DIRTY" };
  }
  if (input.myOwnedGeneration === undefined) {
    return { canPersist: false, reason: "no owned generation recorded for this instance" };
  }
  if (input.myInstanceId === VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE) {
    return { canPersist: false, reason: "myInstanceId must not be the MULTIPLE sentinel" };
  }
  if (input.freshMeta.dirtyOwnerInstanceId === VAULT_REGISTRY_DIRTY_OWNER_MULTIPLE) {
    return { canPersist: false, reason: "meta.dirtyOwnerInstanceId is MULTIPLE; ownership is contested" };
  }
  if (input.freshMeta.dirtyOwnerInstanceId !== input.myInstanceId) {
    return { canPersist: false, reason: "meta.dirtyOwnerInstanceId does not match this instance" };
  }
  if (input.freshMeta.registryGeneration !== input.myOwnedGeneration) {
    return { canPersist: false, reason: "meta.registryGeneration does not match the generation this instance owns" };
  }
  return { canPersist: true };
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
 * UX調査対応（HOLD原因の区別）：`VaultRecordNeedsResyncError.status`だけでは、
 * 「Registry entryが元から存在しない（baseline未確立、またはbaseline以前の
 * legacy record）」場合と「Registry entryは存在するがstatus="needs-resync"」の
 * 場合を区別できない（どちらも`status`は同じ"needs-resync"文字列になる——
 * 前者はentryが無いため実際には格納されたstatus値ではなく、呼び出し元が
 * 便宜上"needs-resync"を渡しているだけ）。UI（`vaultHoldReasons`相当）が
 * 「HOLD＝light-checkで見つかる外部変更」と誤解しないよう、この4値で
 * 原因を明示的に区別する。既存のwrite可否判定・書き込み保留の条件（いつthrowするか）
 * は一切変更しない——この型・fieldは診断用の追加情報のみ。
 */
export type VaultHoldReason = "baseline-not-established" | "needs-resync" | "missing" | "conflict";

/** Registry entryが実在する場合（status!=="ok"でthrowする分岐）専用。"ok"はこの
 *  分岐に到達しない想定だが、型上の安全側fallbackとして"needs-resync"を返す。 */
function holdReasonFromEntryStatus(status: VaultRegistryStatus): VaultHoldReason {
  return status === "ok" ? "needs-resync" : status;
}

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
  readonly holdReason: VaultHoldReason;

  constructor(recordType: VaultRegistryRecordType, registryKey: string, status: VaultRegistryStatus, holdReason: VaultHoldReason) {
    super(
      `[Tsumugi] vault write held: ${recordType} "${registryKey}" is "${status}" in the vault registry; ` +
        `refusing to write until a Vault resync resolves it (no automatic recreation at the old/deterministic path).`
    );
    this.name = "VaultRecordNeedsResyncError";
    this.recordType = recordType;
    this.registryKey = registryKey;
    this.status = status;
    this.holdReason = holdReason;
  }
}

/** `lookupVaultRegistryRecord`の結果。`entry`が`undefined`なら「registryに一度も
 *  登録されたことが無い＝真の新規record」を意味する。 */
export interface VaultRegistryLookup {
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
 *
 * A1（conflict revalidation）・write経路がそのまま使う、operation間キャッシュを
 * 持たないシンプルな単一shard lookup。L3 classify専用の判定（found/not-found/
 * unconfirmedの区別・shard cache）は別途`lookupCurrentRegistryEntryForL3`に
 * 分離しており、この関数自体には手を加えない（A1/L4のlookup semanticsを
 * 変更しないため）。
 */
export async function lookupVaultRegistryRecord(root: FileSystemDirectoryHandle, registryKey: string): Promise<VaultRegistryLookup> {
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
 * 実機不具合対応（Android性能改善）：Android SAFの`getDirectoryHandle`1回が
 * 数百ms級のため、「同一操作内で同じディレクトリを何度も解決し直す」ことが
 * 積み重なると、record数・shard数に比例して数十秒級の遅延になることが実機ログで
 * 確認された（詳細はresolveVaultRelativePath/buildVaultRegistrySnapshot/
 * flushPendingToVaultの各コメント参照）。
 *
 * このMapは「呼び出し元が明示的に生成し、1回のoperation（1回のLevel 1 discovery、
 * 1回のflush実行等）の間だけ手元に持ち、そのoperationの終了とともに破棄する」
 * ものであり、モジュールレベル/グローバルな状態には一切しない（stale handleを
 * 次回操作へ持ち越さない）。キーは"Conversations"のようなVault root相対の
 * ディレクトリpath文字列。
 */
type VaultDirHandleCache = Map<string, FileSystemDirectoryHandle>;

/**
 * "Conversations"のようなVault root直下のトップレベルディレクトリを、
 * （渡されていれば）`dirHandleCache`経由で使い回しながら解決する。
 * `writeConversationMarkdownImpl`等が、同一flush実行内でrecordごとに
 * 同じディレクトリを何度も`root`から解決し直さないようにするためのhelper。
 * `dirHandleCache`省略時は毎回`root.getDirectoryHandle`を呼ぶ（従来通り）。
 * キーは`resolveVaultRelativePath`の1階層目と同じ文字列空間を使うため、
 * 同一キャッシュを共有すれば互いの解決結果を再利用できる。
 */
async function getCachedVaultTopLevelDir(
  root: FileSystemDirectoryHandle,
  name: string,
  label: string,
  dirHandleCache?: VaultDirHandleCache
): Promise<FileSystemDirectoryHandle> {
  const cached = dirHandleCache?.get(name);
  if (cached !== undefined) return cached;
  const dir = await timedIOStep(label, () => root.getDirectoryHandle(name, { create: true }));
  dirHandleCache?.set(name, dir);
  return dir;
}

/**
 * "Conversations/x/y.md"のようなVault root相対pathを、末尾のファイル名を除いた
 * ディレクトリまで辿り、`{dir, fileName}`を返す（中間ディレクトリは
 * `{ create: false }`——既存の構造だけを辿り、勝手に新規作成しない）。
 * Step 2で実際に登場するpathは常に1階層（"Conversations/xxx.md"等）だが、
 * 将来のネストしたpathでも正しく動くよう汎用的に実装する。
 *
 * `dirHandleCache`（省略可）：呼び出し元が同一operation内で使い回すキャッシュを
 * 渡した場合、既に解決済みのディレクトリはSAF I/Oを行わずそのまま返す。
 * 省略時（従来通り`undefined`）は毎回フルに`getDirectoryHandle`を呼ぶ——
 * 既存呼び出し元の挙動は一切変えない。
 */
async function resolveVaultRelativePath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  dirHandleCache?: VaultDirHandleCache
): Promise<{ dir: FileSystemDirectoryHandle; fileName: string }> {
  if (!isSafeVaultRelativePath(relativePath)) {
    throw new Error(`[Tsumugi] refusing to resolve unsafe vault registry path: ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split("/");
  let dir = root;
  let cacheKey = "";
  for (const segment of segments.slice(0, -1)) {
    cacheKey = cacheKey ? `${cacheKey}/${segment}` : segment;
    const cached = dirHandleCache?.get(cacheKey);
    if (cached !== undefined) {
      dir = cached;
      continue;
    }
    // 実機不具合対応（Android診断）：Android SAFでここが遅延/停止していないかを
    // 計測するためだけの追加。既存のtimedIOStepパターンを再利用し、path名は
    // labelに含めない（固定文字列のみ）。キャッシュhit時はI/Oが発生しないため
    // このログ自体も出ない（＝ログの出現回数減少がキャッシュ効果の目安になる）。
    dir = await timedIOStep("registry resolve:getDirectoryHandle", () => dir.getDirectoryHandle(segment, { create: false }));
    dirHandleCache?.set(cacheKey, dir);
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
    // 実機不具合対応（Android診断）：Registryに記録された旧pathの実ファイル確認が
    // Android SAFでどれだけ時間を要しているかを計測するためだけの追加。
    // 既存のtimedIOStepパターンを再利用し、path/fileName等はlabelに含めない
    // （固定文字列のみ）。判定ロジック・エラー処理は一切変更しない。
    const fileHandle = await timedIOStep("registry verify:getFileHandle", () => dir.getFileHandle(fileName, { create: false }));
    file = await timedIOStep("registry verify:getFile", () => fileHandle.getFile());
  } catch {
    await markVaultRegistryNeedsResync(root, registryKey);
    throw new VaultRecordNeedsResyncError(entry.recordType, registryKey, "needs-resync", "needs-resync");
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
  throw new VaultRecordNeedsResyncError(entry.recordType, registryKey, "needs-resync", "needs-resync");
}

// ---------------------------------------------------------------------------
// Vault Registry（Step 4a：明示的Vault resync、scan＋classificationのみ）
//
// 目的：ユーザーが外部でTsumugi管理Markdownを移動・rename・編集・追加した場合に、
// 「所在（actual path）」「Registry」「IndexedDB」「History Index」の食い違いを、
// 明示的なユーザー操作でのみ検出する（起動時の自動full scanにはしない）。
//
// 本Stepのスコープ：Vault全体のdirectory enumeration・分類（unchanged/moved/
// edited/added/missing/conflict/unreadable）をメモリ上で完成させるところまで。
// IndexedDB・Registry・History Index・Markdownのいずれへも書き込みは一切行わない
// （read onlyであることは`getConversation`/`getMemoryObject`/`getSource`/
// `getVaultSyncState`の使用箇所が全てread専用のdb.ts関数であることからも確認できる）。
// 実際の反映（apply）はStep 4bのスコープ。
//
// H4 Vault world境界の再利用：resync全体を`runVaultWorldExclusive`
// （vaultWorldLock.ts、Step 4a新設）で"tsumugi-vault-world"の排他ロックとして
// 包む。これにより通常のVault write（capture.ts/source.tsが`withVaultWorldRead`
// で包んでいる共有ロック）・別tabのwrite・Vault切替（`runVaultSwitchExclusive`も
// 同じロック名を排他要求する）の全てが、resync完了までブロックされる
// （navigator.locksはorigin全体で共有されるためタブをまたいでも同様）。
// この関数（`performVaultResyncScan`）の内部からは、`withVaultWorldRead`・
// `runVaultSwitchExclusive`・`runVaultWorldExclusive`のいずれも呼び出さない
// （同名ロックの再要求による自己デッドロックを避けるため）。IndexedDBへの
// read（`getConversation`等）はH4ラッパーを経由せず、db.tsの生関数を直接呼ぶ
// ——resync自体が既に"tsumugi-vault-world"を排他保持しているため、個々の
// read時点で改めてepoch整合性を確認する必要が無い（保持している間、他タブが
// Vaultを切り替えることは構造的に不可能なため）。
// ---------------------------------------------------------------------------

/**
 * Step 4c対応：probeでTsumugiファイルらしいと判定されたがparseできなかった、
 * または`getFile`/`text`自体が失敗したファイルの記録。UI/debugで追跡できるよう
 * `path`と`reason`だけを保持する（生のError objectはVault/IndexedDBへ保存しない）。
 * `resyncVaultRegistry`が返す公開結果`VaultResyncResult.unreadableFiles`にも
 * そのまま使う。
 */
export interface VaultResyncUnreadableFile {
  path: string;
  reason: string;
}

/** 1回のresync scanで得られる、1つのrecord/containerについての分類結果
 *  （resync engine内部専用、外部へはexportしない）。 */
type VaultResyncOutcome = "unchanged" | "moved" | "edited" | "added" | "missing" | "conflict" | "unreadable";

/** normal Memory day-file内の、1メンバー単位の分類（container自体の状態とは別に持つ、
 *  resync engine内部専用）。
 *
 * "ledger-repair"：Vault側のhashがRegistryの前回記録と異なり、かつIndexedDB側も
 * vaultSyncState台帳上は「未同期」に見えるが、実際にはnormalized semantic equality
 * （`memoryObjectsSemanticEqual`）でVault側・IndexedDB側の内容が完全に一致していると
 * 確認できた場合の分類。真のconflict（内容が実際に食い違っている）とは明確に区別し、
 * IndexedDB record本体は書き換えず、vaultSyncState台帳の再確立だけを行う
 * （"edited"のように`mergeMemoryObjectForApply`でrecord本体を上書きしない）。 */
interface VaultResyncMemberResult {
  id: string;
  outcome: "unchanged" | "edited" | "added" | "conflict" | "ledger-repair";
  /** そのmemberの実際にparse済みの内容（Step 4bのapplyで使う。member removal
   *  conflict時など、observedデータを意図的に使わない場合はnull）。 */
  parsed: MemoryObject | null;
  /** outcome==="added"の場合のみ意味を持つ（record単位の
   *  `addedIndexedDbEquivalent`と同じ意味）。IndexedDBに既存のこのidがあり、
   *  semantic equalityで一致が確認できたことを示す。 */
  addedIndexedDbEquivalent: boolean | null;
}

/** resync engine内部専用（外部へはexportしない。Step 5 UIは`VaultResyncResult`の
 *  countsだけを使う想定で、個別recordの生データは不要）。 */
export interface VaultResyncRecordResult {
  /** Conversation/Reflection/Sourceはid自身、normal Memoryは`dayFileRegistryKey(day)`。 */
  registryKey: string;
  recordType: VaultRegistryRecordType;
  outcome: VaultResyncOutcome;
  previousPath: string | null;
  /** 今回のscanで実際に見つかったpath。missing/unreadable相当ならnull。 */
  currentPath: string | null;
  contentHash: string | null;
  mtime: number | null;
  size: number | null;
  /** normal Memory（memory-day）のみ非null。 */
  members: VaultResyncMemberResult[] | null;
  /** outcome==="added"の場合のみ意味を持つ。IndexedDBに既存の同idがあり、かつ
   *  semantic equalityで一致が確認できたことを示す（true時、Step 4bはpath登録のみ
   *  でIndexedDBには触れない想定）。IndexedDBに既存だが内容が一致しない場合は、
   *  この時点で既にoutcomeが"conflict"へ格上げされているため、ここには現れない。 */
  addedIndexedDbEquivalent: boolean | null;
  /** 診断用の短い説明（conflict理由・unreadable理由等）。無ければnull。 */
  note: string | null;
  /** Conversation/Reflection/Sourceの実際にparse済みの内容（Step 4bのapplyで使う）。
   *  normal Memory（memory-day）はこちらではなく`members[].parsed`を使う。
   *  Phase 2のmissing検出等、実際にファイルを読めていない場合はnull。 */
  parsed: Conversation | Source | MemoryObject | null;
  /**
   * Step 4b対応：`previousPath===null`（registryが一度も登録していなかった
   * registryKey）で、かつ本scan中に2つ以上の異なるpathで同じregistryKeyが
   * 見つかった（真のduplicate、`isDuplicatePath`）場合のみ非null。見つかった
   * 全pathを保持する（順不同、scan順に依存させないための決定論的anchor選択は
   * 4b側がlexicographical sortで行う）。それ以外の場合はnull。
   */
  allObservedPaths: string[] | null;
}

/** resync engine内部専用（外部へはexportしない）。 */
interface VaultResyncScanResult {
  /** Vault全体のdirectory enumerationが最後まで正常完了したかどうか。falseの場合、
   *  records内に"missing"は一切含まれない（未確定のまま、次回resyncへ持ち越す）。 */
  scanCompleted: boolean;
  scannedFileCount: number;
  records: VaultResyncRecordResult[];
  /** probeでTsumugiファイルらしいと判定されたがparseできなかった、または
   *  getFile/text自体が失敗したファイル。分類（unchanged等）の対象にはしない。 */
  unreadableFiles: VaultResyncUnreadableFile[];
  /**
   * C1（軽量Registry index・多tab安全性設計のbootstrap/rebuild foundation）対応：
   * Phase 0で`buildVaultRegistrySnapshot`が読み込んだ、apply前のauthoritative
   * Registryスナップショットをそのまま公開する（追加のshard読み込みは発生しない、
   * 既にこの関数が内部で保持している値をそのまま返すだけ）。`resyncVaultRegistry`が
   * apply後の最終registry-index.jsonを、新たなshard読み込み無しで構築するために使う
   * （`records`のapply結果と合わせて、「apply前の全体像」+「今回変化した差分」から
   * 最終状態を再構成する）。resync自体の分類・apply挙動には一切影響しない。
   */
  previousByKey: Map<string, string>;
  previousEntries: Map<string, VaultRegistryFileEntry>;
  /**
   * C1（Codexレビュー指摘・High 2対応）：apply前のRegistry snapshot読み込み
   * （`buildVaultRegistrySnapshotForResync`のPhase 0：directory enumeration・
   * 個々のshard読み込みの両方）が、一切の失敗無く完了したかどうか。`false`の
   * 場合、`previousByKey`/`previousEntries`はfallback値（一部shardが空扱い）を
   * 含んでいる可能性があり、C1のregistry-index/registryGeneration/
   * dirtyOwnerInstanceId/registryGenerationEpochの新規確立には使ってはならない
   * （`resyncVaultRegistry`参照）。既存resyncの`scanCompleted`（Vault全体の
   * directory enumeration＝Phase 1）とは別軸の完全性であり、こちらはPhase 0
   * （Registry自体の読み込み）を指す。既存のclassification/apply挙動
   * （`scanCompleted`ベースのlastFullResyncAt/baselineEstablishedAt更新等）には
   * 一切影響しない。
   */
  previousSnapshotCompleted: boolean;
}

type VaultResyncSingleKind = "conversation" | "source" | "reflection";

type VaultResyncParsedCandidate =
  | { kind: "conversation"; id: string; record: Conversation }
  | { kind: "source"; id: string; record: Source }
  | { kind: "reflection"; id: string; record: MemoryObject }
  | { kind: "memory-day"; day: string; members: MemoryObject[] };

/**
 * body（frontmatter直後の本文）に含まれる固定の見出し文字列から種別を判定する
 * （B節：既存folder名に頼らないTsumugi Markdown種別判定）。
 * - "## Transcript"：`conversationToMarkdown`のみが書き出す（Conversation専用）。
 * - "## Content"：`sourceToMarkdown`のみが書き出す（Source専用、`sourceType`必須と
 *   組み合わせて判定する）。
 * - "## Summary"：`memoryObjectToMarkdown`が書き出す（normal Memory/Reflection共通、
 *   `metadata.source`でさらに細分する）。
 * 3つとも互いに排他的な固定文字列であり、Tsumugiの各serializerがそれぞれ1種類
 * しか書き出さないため、この判定に曖昧さは無い。
 */
function classifyResyncBodyMarker(body: string): "conversation" | "source-like" | "memory-like" | null {
  if (body.includes("## Transcript")) return "conversation";
  if (body.includes("## Content")) return "source-like";
  if (body.includes("## Summary")) return "memory-like";
  return null;
}

/**
 * 未知の`.md`を推測でimportしないための、確実にparseできるものだけを対象とする
 * 判定＋parse。`tsumugi: true`が無い、body見出しが判定不能、実際のparserが
 * 失敗する（Sourceは`sourceType`欠落でthrowする等）場合は全てnullを返し、
 * 呼び出し元はunreadable/無視のいずれかとして扱う。
 *
 * memory-like（"## Summary"）は、通常のday-file（1ファイル複数member、
 * `isReflectionSummary`相当がfalseのみ）とReflection（1ファイル1member、
 * `metadata.source==="system-generated"`）が同じbody形式を共有するため、
 * frontmatterの`source`で細分する。day-fileにReflectionが混在することは
 * write側の設計上あり得ないため、複数member中に1件でもReflection相当が
 * 混ざっている場合は判定不能としてnullを返す（unreadable扱いにする）。
 */
function parseTsumugiResyncCandidate(text: string): VaultResyncParsedCandidate | null {
  const parsedFrontmatter = parseFrontmatter(text);
  if (!parsedFrontmatter) return null;
  const { frontmatter, body } = parsedFrontmatter;
  if (frontmatter.tsumugi !== true) return null;

  const bodyKind = classifyResyncBodyMarker(body);
  if (bodyKind === "conversation") {
    const record = parseConversationMarkdown(text);
    if (!record) return null;
    return { kind: "conversation", id: record.id, record };
  }
  if (bodyKind === "source-like") {
    if (asString(frontmatter.sourceType) === undefined) return null;
    try {
      const record = parseSourceMarkdown(text);
      return { kind: "source", id: record.id, record };
    } catch {
      return null;
    }
  }
  if (bodyKind === "memory-like") {
    const members = parseMemoryDayFile(text);
    if (members.length === 0) return null;
    const reflectionCount = members.filter((m) => m.metadata.source === "system-generated").length;
    if (reflectionCount > 0 && members.length > 1) return null;
    if (reflectionCount === 1 && members.length === 1) {
      return { kind: "reflection", id: members[0].id, record: members[0] };
    }
    const days = new Set(members.map((m) => m.date.slice(0, 10)));
    if (days.size !== 1) return null;
    const [day] = days;
    return { kind: "memory-day", day, members };
  }
  return null;
}

/**
 * semantic equality（修正1・修正2対応）：raw text hashではなく、実際に永続化され
 * Markdownとの往復で意味が保たれるフィールドだけを比較する。stable id自体の一致を
 * 前提条件とする（一致しなければ即false）。`metadata.id`はparserが毎回新規発行
 * するため比較対象にしない。turn単位のtimestamp・webSearchRequested・
 * isRecordTurnはMarkdownへ保存されず往復しないため比較しない。
 */
/**
 * `metadata.sourceType`はMarkdown round-trip時、未設定なら`inferSourceType(source)`
 * で必ず補完される（markdown.ts参照）。そのため、片方が`undefined`のまま・もう片方が
 * その推測値を持つだけの差は「意味的には同じ」であり、単純な`??`比較では実在しない
 * 不一致（false conflict）を生む。両側にこの同じ推測を適用してから比較することで、
 * 「本当にsourceTypeが異なる」場合だけを不一致として検出する
 * （sourceType自体を比較対象から外すのではなく、判定基準をparserの実際の挙動に揃える）。
 */
function normalizedSourceType(source: MemorySource, sourceType: string | undefined): string {
  return sourceType ?? inferSourceType(source);
}

export function conversationsSemanticEqual(a: Conversation, b: Conversation): boolean {
  if (a.id !== b.id) return false;
  if (a.persona !== b.persona) return false;
  if (a.startedAt !== b.startedAt) return false;
  if ((a.endedAt ?? null) !== (b.endedAt ?? null)) return false;
  if (a.status !== b.status) return false;
  if (a.createdAt !== b.createdAt) return false;
  if (a.updatedAt !== b.updatedAt) return false;
  if (a.memoryObjectIds.length !== b.memoryObjectIds.length) return false;
  if (!a.memoryObjectIds.every((id, i) => id === b.memoryObjectIds[i])) return false;
  if (a.turns.length !== b.turns.length) return false;
  if (!a.turns.every((turn, i) => turn.role === b.turns[i].role && turn.content === b.turns[i].content)) return false;
  if (a.metadata.source !== b.metadata.source) return false;
  if (normalizedSourceType(a.metadata.source, a.metadata.sourceType) !== normalizedSourceType(b.metadata.source, b.metadata.sourceType)) return false;
  if (JSON.stringify(a.metadata.sourceDetail ?? null) !== JSON.stringify(b.metadata.sourceDetail ?? null)) return false;
  if (a.metadata.schemaVersion !== b.metadata.schemaVersion) return false;
  return true;
}

/**
 * `date`は日付部分のみ比較する（frontmatterには日付のみ保存され、読込時は時刻を
 * 一律`T00:00:00.000Z`で補完するため、時刻を含めて比較すると常に不一致になる）。
 * `themeIds`等6配列・`revisitPrompt`・`sourceId`・`metadata.obsidian`は
 * Markdownへ一切書き出されずparser側が復元しないため比較対象にしない
 * （比較すると往復で失われる情報のせいで常に偽の不一致になるため）。
 */
export function memoryObjectsSemanticEqual(a: MemoryObject, b: MemoryObject): boolean {
  if (a.id !== b.id) return false;
  if (a.date.slice(0, 10) !== b.date.slice(0, 10)) return false;
  if (a.types.length !== b.types.length || !a.types.every((t, i) => t === b.types[i])) return false;
  if (a.content !== b.content) return false;
  if (a.summary !== b.summary) return false;
  if (a.keywords.length !== b.keywords.length || !a.keywords.every((k, i) => k === b.keywords[i])) return false;
  if ((a.conversationId ?? null) !== (b.conversationId ?? null)) return false;
  // topicId（Topic Continuity機能）は意図的に比較対象へ含めない：Vault機能は
  // Topic Continuityに依存してはいけないため（Topic Continuity側が別途commitされた
  // 際に、必要であればそちら側の変更として比較を追加すべきもの）。
  if (JSON.stringify(a.links) !== JSON.stringify(b.links)) return false;
  // Time Axis Phase 2（Event Time）：eventTime/eventTimePrecisionはmemoryObjectToMarkdown/
  // parseMemoryObjectMarkdownの両方で正しくround-tripし、sourceTypeのような推測による
  // 補完も無いため、単純比較でよい（以前はここに含まれておらず、実際の食い違いを
  // 見逃していた）。
  if ((a.eventTime ?? null) !== (b.eventTime ?? null)) return false;
  if ((a.eventTimePrecision ?? null) !== (b.eventTimePrecision ?? null)) return false;
  if (a.createdAt !== b.createdAt) return false;
  if (a.updatedAt !== b.updatedAt) return false;
  if (a.metadata.source !== b.metadata.source) return false;
  if (normalizedSourceType(a.metadata.source, a.metadata.sourceType) !== normalizedSourceType(b.metadata.source, b.metadata.sourceType)) return false;
  if (JSON.stringify(a.metadata.sourceDetail ?? null) !== JSON.stringify(b.metadata.sourceDetail ?? null)) return false;
  if ((a.metadata.aiProvider ?? null) !== (b.metadata.aiProvider ?? null)) return false;
  if ((a.metadata.confidence ?? null) !== (b.metadata.confidence ?? null)) return false;
  if (a.metadata.schemaVersion !== b.metadata.schemaVersion) return false;
  return true;
}

/** Sourceは`metadata: Metadata`を持たない最小構成のため、全フィールドが素直に往復する。 */
export function sourcesSemanticEqual(a: Source, b: Source): boolean {
  if (a.id !== b.id) return false;
  if (a.sourceType !== b.sourceType) return false;
  if (a.title !== b.title) return false;
  if (a.content !== b.content) return false;
  if (JSON.stringify(a.sourceDetail ?? null) !== JSON.stringify(b.sourceDetail ?? null)) return false;
  if ((a.attachmentId ?? null) !== (b.attachmentId ?? null)) return false;
  if (a.createdAt !== b.createdAt) return false;
  if (a.updatedAt !== b.updatedAt) return false;
  return true;
}

/** vaultSyncState（B）のkindは`"conversation"|"memory"|"source"`の3値のみ。
 *  Reflectionはnormal Memoryと同じ`"memory"`扱い（既存の`markVaultSynced`が
 *  isReflectionSummaryを区別せず一律`"memory"`で記録しているのと同じ規約）。 */
function vaultSyncKindOf(recordType: VaultResyncSingleKind): VaultSyncKind {
  return recordType === "reflection" ? "memory" : recordType;
}

/**
 * 修正1：「registryに無いvalid Tsumugi recordを発見し、IndexedDBにも同じstable idが
 * 存在し、vaultSyncStateが無い」場合の判定。raw hashではなくsemantic equality
 * （conversationsSemanticEqual等）で比較する。IndexedDB read（`getConversation`等）
 * のみを行い、一切書き込まない。
 */
async function checkIndexedDbForAdded(
  kind: VaultResyncSingleKind,
  id: string,
  parsed: Conversation | Source | MemoryObject
): Promise<{ present: boolean; equivalent: boolean }> {
  if (kind === "conversation") {
    const existing = await getConversation(id);
    if (!existing) return { present: false, equivalent: false };
    return { present: true, equivalent: conversationsSemanticEqual(existing, parsed as Conversation) };
  }
  if (kind === "source") {
    const existing = await getSource(id);
    if (!existing) return { present: false, equivalent: false };
    return { present: true, equivalent: sourcesSemanticEqual(existing, parsed as Source) };
  }
  const existing = await getMemoryObject(id);
  if (!existing) return { present: false, equivalent: false };
  return { present: true, equivalent: memoryObjectsSemanticEqual(existing, parsed as MemoryObject) };
}

/**
 * 修正2：明示的resyncではmtime/size一致だけでunchanged確定しない、という方針の
 * 裏側にある「Lがbより進んでいるか（unflushedか）」の判定（D節のB/L/Fモデル）。
 * `vaultSyncState`（B）が無い、またはIndexedDB自体が無い場合は安全側で
 * unsynced（true）とする。IndexedDB read（`getConversation`等）・
 * `getVaultSyncState`のみを行い、一切書き込まない。
 */
async function checkLocalUnsynced(kind: VaultSyncKind, id: string): Promise<boolean> {
  const ledgerValue = await getVaultSyncState(vaultSyncKeyFor(kind, id));
  if (ledgerValue === undefined) return true;
  let currentUpdatedAt: string | undefined;
  if (kind === "conversation") currentUpdatedAt = (await getConversation(id))?.updatedAt;
  else if (kind === "source") currentUpdatedAt = (await getSource(id))?.updatedAt;
  else currentUpdatedAt = (await getMemoryObject(id))?.updatedAt;
  if (currentUpdatedAt === undefined) return true;
  return currentUpdatedAt !== ledgerValue;
}

/** resync scan中に蓄積する状態。1回の`performVaultResyncScan`呼び出しにつき1つ。 */
interface VaultResyncScanState {
  /** registry snapshot（scan開始時点、Phase 0で構築、以後読み取り専用）。 */
  previousByKey: Map<string, string>;
  previousEntries: Map<string, VaultRegistryFileEntry>;
  /** previousByKeyの逆引き（path→registryKey）。walk中に「このpathは既知
   *  registryのどのkeyのものか」を、読み込み前に判定するために使う
   *  （Codexレビュー指摘・High対応：missing誤判定防止）。 */
  previousRegistryKeyByPath: Map<string, string>;
  /** 本scan中に、そのregistryKeyが実際に見つかった全path（重複検出用）。 */
  seenPathsByKey: Map<string, Set<string>>;
  /**
   * Codexレビュー指摘・High対応：「registered actual pathに何らかのfileが
   * 物理的に存在した」というnegative evidence停止材料を保持する集合。
   * directory enumerationでpathがpreviousRegistryKeyByPathと一致した時点で、
   * 本文が読める・parseできるかどうかに関わらずここへ追加する。Phase 2の
   * missing判定は「recordsByKeyに無い」だけでなく「seenKnownKeysにも無い」
   * ことを両方満たす場合にのみ行う——既知pathに物理ファイルがあるのに
   * 読めない/parseできないだけでmissing扱いにしない、という原則を守るため。
   */
  seenKnownKeys: Set<string>;
  recordsByKey: Map<string, VaultResyncRecordResult>;
  unreadableFiles: VaultResyncUnreadableFile[];
  scannedFileCount: number;
  /**
   * Android実機不具合対応（soft deadline）：resync全体の開始時刻から
   * `VAULT_RESYNC_SOFT_DEADLINE_MS`だけ後の絶対時刻。File System Access API
   * （`entries()`/`getFile()`/`getFileHandle()`/`Blob.text()`等）はいずれも
   * AbortSignal・cancelを一切サポートしないため、単発I/O呼び出し自体を
   * 強制的に打ち切ることはできない（MDN仕様確認済み）。そのため「次に新しい
   * ファイルの処理を開始する前」というファイル境界でのみdeadlineを確認し、
   * 超過していれば以降のファイル処理を一切開始せずscanを安全に終了する
   * （既に処理を開始済みの1ファイルの完了は待つ——その最中のI/Oを裏で
   * 放置したまま先へ進む、という設計は意図的に避けている）。
   */
  deadline: number;
  /** deadline超過によりwalkを打ち切った場合にtrue。既存の
   *  `scanCompleted=false`と同じ安全側の扱い（missing確定・baseline確立を
   *  行わない）に合流させるためのフラグ。 */
  deadlineExceeded: boolean;
}

function markVaultResyncSeen(state: VaultResyncScanState, key: string, path: string): void {
  let set = state.seenPathsByKey.get(key);
  if (!set) {
    set = new Set();
    state.seenPathsByKey.set(key, set);
  }
  set.add(path);
}

/**
 * 狙い撃ち確認（targeted check）の結果を3値で表す（Codexレビュー指摘・High対応）。
 * - "present"：旧pathに今も対象id/dayが実在すると確認できた（duplicate候補）。
 * - "absent"：旧pathを正常に読み・parseでき、対象id/dayが存在しないと確認できた
 *   （NotFoundError等でファイル自体が無い場合も含む）。movedの根拠にできる。
 * - "unknown"：旧pathに何らかのfileは存在するが、getFile/text/parseのいずれかが
 *   失敗し、存在有無を確認できなかった。**movedの根拠にしてはいけない**——
 *   4bがRegistry actual pathを勝手にnew pathへ変更してしまう可能性があるため、
 *   安全側でconflict相当として保留する。
 */
type VaultResyncTargetedPresence = "present" | "absent" | "unknown";

/** Conversation/Reflection/Source（1id=1file）の狙い撃ち確認：旧pathに今も
 *  同じidが実在するかどうかだけを、直接1回読んで確認する（moved/duplicateの
 *  即時判定用。Vault全体を再走査しない）。 */
async function targetedCheckSingleRecordStillAt(
  root: FileSystemDirectoryHandle,
  oldPath: string,
  kind: VaultResyncSingleKind,
  id: string
): Promise<VaultResyncTargetedPresence> {
  let resolved: { dir: FileSystemDirectoryHandle; fileName: string };
  try {
    resolved = await resolveVaultRelativePath(root, oldPath);
  } catch {
    return "absent";
  }
  let file: File;
  try {
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    file = await fileHandle.getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return "absent";
    return "unknown";
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    return "unknown";
  }
  if (kind === "conversation") {
    const parsed = parseConversationMarkdown(text);
    return parsed?.id === id ? "present" : "absent";
  }
  if (kind === "source") {
    try {
      const parsed = parseSourceMarkdown(text);
      return parsed.id === id ? "present" : "absent";
    } catch {
      // sourceType欠落等は「parseに失敗した」ため安全側でunknownとする
      // （absentと確定はしない）。
      return "unknown";
    }
  }
  const parsed = parseMemoryObjectMarkdown(text);
  return parsed?.id === id ? "present" : "absent";
}

/** normal Memory day-fileの狙い撃ち確認：旧pathに今もその日のday-fileが
 *  実在するかどうかを直接1回読んで確認する。 */
async function targetedCheckMemoryDayStillAt(
  root: FileSystemDirectoryHandle,
  oldPath: string,
  day: string
): Promise<VaultResyncTargetedPresence> {
  let resolved: { dir: FileSystemDirectoryHandle; fileName: string };
  try {
    resolved = await resolveVaultRelativePath(root, oldPath);
  } catch {
    return "absent";
  }
  let file: File;
  try {
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    file = await fileHandle.getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return "absent";
    return "unknown";
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    return "unknown";
  }
  const members = parseMemoryDayFile(text);
  if (members.length === 0) return "absent";
  return members.every((m) => m.date.slice(0, 10) === day) ? "present" : "absent";
}

/** day-file内の各memberを個別に分類する（修正3：member removal自体はここでは
 *  扱わない——呼び出し元がcontainer全体をconflictにするかどうかを別途判定する）。 */
async function classifyResyncMembers(
  members: MemoryObject[],
  previousMemberHashes: Record<string, string>
): Promise<VaultResyncMemberResult[]> {
  const results: VaultResyncMemberResult[] = [];
  for (const member of members) {
    const memberHash = hashVaultText(memoryObjectToMarkdown(member));
    const previousHash = previousMemberHashes[member.id];
    if (previousHash === undefined) {
      const { present, equivalent } = await checkIndexedDbForAdded("reflection", member.id, member);
      const outcome = present && !equivalent ? "conflict" : "added";
      results.push({
        id: member.id,
        outcome,
        parsed: member,
        addedIndexedDbEquivalent: outcome === "added" ? present && equivalent : null,
      });
      continue;
    }
    if (previousHash === memberHash) {
      results.push({ id: member.id, outcome: "unchanged", parsed: member, addedIndexedDbEquivalent: null });
      continue;
    }
    const localUnsynced = await checkLocalUnsynced("memory", member.id);
    if (localUnsynced) {
      // 実機不具合対応（ledger欠落の自己修復）：vaultSyncState台帳上は「未同期」に
      // 見えても、それだけで即conflictとは決めない。IndexedDB側の現在の内容を
      // 実際に読み、Vault側のparse済み内容とnormalized semantic equalityで
      // 一致するかを確認する。一致すれば「内容は既に同一、台帳の反映漏れだけ」
      // という安全なケースであり、"ledger-repair"として扱う（IndexedDB record
      // 本体は書き換えず、台帳の再確立のみをapply側で行う）。一致しなければ、
      // 従来通りfail-closedで"conflict"のままにする（内容が本当に食い違う場合は
      // 絶対に自動解決しない）。
      const currentIndexedDb = await getMemoryObject(member.id);
      const ledgerRepairable = currentIndexedDb !== undefined && memoryObjectsSemanticEqual(currentIndexedDb, member);
      results.push({
        id: member.id,
        outcome: ledgerRepairable ? "ledger-repair" : "conflict",
        parsed: member,
        addedIndexedDbEquivalent: null,
      });
      continue;
    }
    results.push({
      id: member.id,
      outcome: "edited",
      parsed: member,
      addedIndexedDbEquivalent: null,
    });
  }
  return results;
}

/** Conversation/Reflection/Source（1id=1file）1件分の分類。 */
async function handleResyncSingleRecordCandidate(
  root: FileSystemDirectoryHandle,
  state: VaultResyncScanState,
  path: string,
  kind: VaultResyncSingleKind,
  id: string,
  record: Conversation | Source | MemoryObject,
  mtime: number,
  size: number,
  text: string
): Promise<void> {
  const alreadySeenPaths = state.seenPathsByKey.get(id);
  const isDuplicatePath = !!alreadySeenPaths && alreadySeenPaths.size > 0 && !alreadySeenPaths.has(path);
  markVaultResyncSeen(state, id, path);
  const contentHash = hashVaultText(text);
  const previousPath = state.previousByKey.get(id) ?? null;
  const previousEntry = previousPath !== null ? state.previousEntries.get(previousPath) ?? null : null;

  if (isDuplicatePath) {
    // Codex監査対応（stale conflict apply防止・known-record duplicate）：
    // 見つかった全path（previousPathの有無を問わない）を保持する。以前は
    // previousPath===nullの場合にのみ保持しており、「registry登録済みpath＋
    // 複数の新規重複path」という3件以上のduplicateでは、observed pathの一部
    // （state.seenPathsByKeyには実在する）が記録から失われていた。この情報は
    // apply直前revalidationでのconflict identity確認にのみ使い、conflict
    // semantics（何がduplicateとして検出されるか）自体は変更していない。
    state.recordsByKey.set(id, {
      registryKey: id,
      recordType: kind,
      outcome: "conflict",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: null,
      addedIndexedDbEquivalent: null,
      note: "同一idが複数pathに存在します（重複）",
      parsed: record,
      allObservedPaths: [...(state.seenPathsByKey.get(id) ?? [])],
    });
    return;
  }

  if (previousPath === null) {
    const { present, equivalent } = await checkIndexedDbForAdded(kind, id, record);
    const outcome: VaultResyncOutcome = present && !equivalent ? "conflict" : "added";
    state.recordsByKey.set(id, {
      registryKey: id,
      recordType: kind,
      outcome,
      previousPath: null,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: null,
      addedIndexedDbEquivalent: outcome === "added" ? present && equivalent : null,
      note: outcome === "conflict" ? "added: IndexedDBの既存内容と一致しません" : null,
      parsed: record,
      allObservedPaths: null,
    });
    return;
  }

  if (path === previousPath) {
    if (previousEntry !== null && previousEntry.contentHash === contentHash) {
      state.recordsByKey.set(id, {
        registryKey: id,
        recordType: kind,
        outcome: "unchanged",
        previousPath,
        currentPath: path,
        contentHash,
        mtime,
        size,
        members: null,
        addedIndexedDbEquivalent: null,
        note: null,
        parsed: record,
        allObservedPaths: null,
      });
      return;
    }
    const localUnsynced = await checkLocalUnsynced(vaultSyncKindOf(kind), id);
    state.recordsByKey.set(id, {
      registryKey: id,
      recordType: kind,
      outcome: localUnsynced ? "conflict" : "edited",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: null,
      addedIndexedDbEquivalent: null,
      note: localUnsynced ? "edited: ローカル未flush変更と競合しています" : null,
      parsed: record,
      allObservedPaths: null,
    });
    return;
  }

  // pathが変わっている：旧pathを直接確認してmoved/duplicateを判定する。
  // Codexレビュー指摘・High対応："unknown"（旧pathに何か存在するが確認不能）を
  // movedの根拠にしない。安全側でconflict扱いにし、4bがRegistry actual pathを
  // 勝手にnew pathへ変更しないようにする。
  const oldPathPresence = await targetedCheckSingleRecordStillAt(root, previousPath, kind, id);
  if (oldPathPresence === "present") {
    // previousPathは既に非nullと判明済み（このブロックに来る時点でpreviousPath!==null）
    // なので、既存のrecords[key]をそのまま維持しつつstatusだけconflictへ倒す
    // （4bはanchor新規作成をしない、既存pathを維持）。
    markVaultResyncSeen(state, id, previousPath);
    // Codex監査対応（known-record duplicate）：observed pathの一部が失われない
    // よう、previousPath===nullの場合と同様にここでもallObservedPathsを保持する。
    state.recordsByKey.set(id, {
      registryKey: id,
      recordType: kind,
      outcome: "conflict",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: null,
      addedIndexedDbEquivalent: null,
      note: "同一idが複数pathに存在します（重複）",
      parsed: record,
      allObservedPaths: [...(state.seenPathsByKey.get(id) ?? [])],
    });
    return;
  }
  if (oldPathPresence === "unknown") {
    state.recordsByKey.set(id, {
      registryKey: id,
      recordType: kind,
      outcome: "conflict",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: null,
      addedIndexedDbEquivalent: null,
      note: "previous path could not be verified",
      parsed: record,
      allObservedPaths: null,
    });
    return;
  }

  const hashUnchanged = previousEntry !== null && previousEntry.contentHash === contentHash;
  if (hashUnchanged) {
    state.recordsByKey.set(id, {
      registryKey: id,
      recordType: kind,
      outcome: "moved",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: null,
      addedIndexedDbEquivalent: null,
      note: null,
      parsed: record,
      allObservedPaths: null,
    });
    return;
  }

  const localUnsynced = await checkLocalUnsynced(vaultSyncKindOf(kind), id);
  state.recordsByKey.set(id, {
    registryKey: id,
    recordType: kind,
    outcome: localUnsynced ? "conflict" : "edited",
    previousPath,
    currentPath: path,
    contentHash,
    mtime,
    size,
    members: null,
    addedIndexedDbEquivalent: null,
    note: localUnsynced ? "moved+edited: ローカル未flush変更と競合しています" : "moved+edited",
    parsed: record,
    allObservedPaths: null,
  });
}

/** normal Memory day-file 1件分の分類（container単位）。修正3：previous
 *  memberIdsのうち今回見つからなかったものがあれば、member追加・編集の状況に
 *  関わらずcontainer全体をconflictにし、previous memberIds/memberHashesを
 *  そのまま維持する（現在の観測結果では上書きしない）。 */
async function handleResyncMemoryDayCandidate(
  root: FileSystemDirectoryHandle,
  state: VaultResyncScanState,
  path: string,
  day: string,
  members: MemoryObject[],
  mtime: number,
  size: number,
  text: string
): Promise<void> {
  const registryKey = dayFileRegistryKey(day);
  const alreadySeenPaths = state.seenPathsByKey.get(registryKey);
  const isDuplicatePath = !!alreadySeenPaths && alreadySeenPaths.size > 0 && !alreadySeenPaths.has(path);
  markVaultResyncSeen(state, registryKey, path);

  const contentHash = hashVaultText(text);
  const previousPath = state.previousByKey.get(registryKey) ?? null;
  const previousEntry = previousPath !== null ? state.previousEntries.get(previousPath) ?? null : null;
  const previousMemberIds = new Set(previousEntry?.memberIds ?? []);
  const previousMemberHashes = previousEntry?.memberHashes ?? {};
  const currentMemberIds = new Set(members.map((m) => m.id));
  const removedMemberIds = [...previousMemberIds].filter((id) => !currentMemberIds.has(id));

  if (isDuplicatePath) {
    // Codex監査対応（known-record duplicate）：previousPathの有無を問わず
    // observed path集合を保持する（apply直前revalidationのconflict identity
    // 確認専用。conflict semantics自体は変更しない）。
    state.recordsByKey.set(registryKey, {
      registryKey,
      recordType: "memory-day",
      outcome: "conflict",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: await classifyResyncMembers(members, previousMemberHashes),
      addedIndexedDbEquivalent: null,
      note: "同一day-fileが複数pathに存在します（重複）",
      parsed: null,
      allObservedPaths: [...(state.seenPathsByKey.get(registryKey) ?? [])],
    });
    return;
  }

  if (previousPath === null) {
    const memberResults = await classifyResyncMembers(members, {});
    const hasConflictMember = memberResults.some((m) => m.outcome === "conflict");
    state.recordsByKey.set(registryKey, {
      registryKey,
      recordType: "memory-day",
      outcome: hasConflictMember ? "conflict" : "added",
      previousPath: null,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: memberResults,
      addedIndexedDbEquivalent: null,
      note: hasConflictMember ? "新規day-fileだが一部メンバーがIndexedDBの既存内容と一致しません" : null,
      parsed: null,
      allObservedPaths: null,
    });
    return;
  }

  // 修正3：member removalはcontainer全体をconflictにし、previousの
  // memberIds/memberHashesをそのまま維持する（今回の観測結果で上書きしない）。
  if (removedMemberIds.length > 0) {
    state.recordsByKey.set(registryKey, {
      registryKey,
      recordType: "memory-day",
      outcome: "conflict",
      previousPath,
      currentPath: path,
      contentHash: previousEntry?.contentHash ?? contentHash,
      mtime: previousEntry?.mtime ?? mtime,
      size: previousEntry?.size ?? size,
      members: (previousEntry?.memberIds ?? []).map((id) => ({
        id,
        outcome: removedMemberIds.includes(id) ? ("conflict" as const) : ("unchanged" as const),
        parsed: null,
        addedIndexedDbEquivalent: null,
      })),
      addedIndexedDbEquivalent: null,
      note: `member removal detected: ${removedMemberIds.join(", ")}`,
      parsed: null,
      allObservedPaths: null,
    });
    return;
  }

  if (path === previousPath) {
    if (previousEntry !== null && previousEntry.contentHash === contentHash) {
      state.recordsByKey.set(registryKey, {
        registryKey,
        recordType: "memory-day",
        outcome: "unchanged",
        previousPath,
        currentPath: path,
        contentHash,
        mtime,
        size,
        members: await classifyResyncMembers(members, previousMemberHashes),
        addedIndexedDbEquivalent: null,
        note: null,
        parsed: null,
        allObservedPaths: null,
      });
      return;
    }
    const memberResults = await classifyResyncMembers(members, previousMemberHashes);
    const hasConflictMember = memberResults.some((m) => m.outcome === "conflict");
    state.recordsByKey.set(registryKey, {
      registryKey,
      recordType: "memory-day",
      outcome: hasConflictMember ? "conflict" : "edited",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: memberResults,
      addedIndexedDbEquivalent: null,
      note: hasConflictMember ? "一部メンバーがローカル未flush変更と競合しています" : null,
      parsed: null,
      allObservedPaths: null,
    });
    return;
  }

  // pathが変わっている：旧pathを直接確認する。Codexレビュー指摘・High対応：
  // "unknown"をmovedの根拠にしない（安全側でconflict扱いにする）。
  const oldPathPresence = await targetedCheckMemoryDayStillAt(root, previousPath, day);
  if (oldPathPresence === "present") {
    markVaultResyncSeen(state, registryKey, previousPath);
    // Codex監査対応（known-record duplicate）：observed path集合を保持する。
    state.recordsByKey.set(registryKey, {
      registryKey,
      recordType: "memory-day",
      outcome: "conflict",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: await classifyResyncMembers(members, previousMemberHashes),
      addedIndexedDbEquivalent: null,
      note: "同一day-fileが複数pathに存在します（重複）",
      parsed: null,
      allObservedPaths: [...(state.seenPathsByKey.get(registryKey) ?? [])],
    });
    return;
  }
  if (oldPathPresence === "unknown") {
    state.recordsByKey.set(registryKey, {
      registryKey,
      recordType: "memory-day",
      outcome: "conflict",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: await classifyResyncMembers(members, previousMemberHashes),
      addedIndexedDbEquivalent: null,
      note: "previous path could not be verified",
      parsed: null,
      allObservedPaths: null,
    });
    return;
  }

  const hashUnchanged = previousEntry !== null && previousEntry.contentHash === contentHash;
  if (hashUnchanged) {
    state.recordsByKey.set(registryKey, {
      registryKey,
      recordType: "memory-day",
      outcome: "moved",
      previousPath,
      currentPath: path,
      contentHash,
      mtime,
      size,
      members: await classifyResyncMembers(members, previousMemberHashes),
      addedIndexedDbEquivalent: null,
      note: null,
      parsed: null,
      allObservedPaths: null,
    });
    return;
  }

  const memberResults = await classifyResyncMembers(members, previousMemberHashes);
  const hasConflictMember = memberResults.some((m) => m.outcome === "conflict");
  state.recordsByKey.set(registryKey, {
    registryKey,
    recordType: "memory-day",
    outcome: hasConflictMember ? "conflict" : "edited",
    previousPath,
    currentPath: path,
    contentHash,
    mtime,
    size,
    members: memberResults,
    addedIndexedDbEquivalent: null,
    note: hasConflictMember ? "moved+edited: 一部メンバーがローカル未flush変更と競合" : "moved+edited",
    parsed: null,
    allObservedPaths: null,
  });
}

/** 1候補ファイル（probe通過・parse成功）を分類へ振り分ける。 */
async function processVaultResyncCandidate(
  root: FileSystemDirectoryHandle,
  state: VaultResyncScanState,
  path: string,
  file: File
): Promise<void> {
  let likely: boolean;
  try {
    likely = await isLikelyTsumugiFile(file);
  } catch (error) {
    state.unreadableFiles.push({ path, reason: `probe failed: ${String(error)}` });
    return;
  }
  if (!likely) return; // Tsumugi管理外のMarkdown、無視（unreadableにもしない）

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    state.unreadableFiles.push({ path, reason: `read failed: ${String(error)}` });
    return;
  }

  const candidate = parseTsumugiResyncCandidate(text);
  if (!candidate) {
    state.unreadableFiles.push({ path, reason: "tsumugi:true is present but content could not be classified/parsed" });
    return;
  }

  const mtime = file.lastModified;
  const size = file.size;

  if (candidate.kind === "memory-day") {
    await handleResyncMemoryDayCandidate(root, state, path, candidate.day, candidate.members, mtime, size, text);
  } else {
    await handleResyncSingleRecordCandidate(root, state, path, candidate.kind, candidate.id, candidate.record, mtime, size, text);
  }
}

/**
 * Vault全体を再帰的に走査する（既知folder名に限定しない。B節の通り、種別は
 * body構造から判定するため、ユーザーがどのフォルダへ再整理していても見つかる）。
 * 隠しエントリ（`.tsumugi/`含む、既存`HIDDEN_PREFIX`と同じ規約）は全階層で除外する。
 * 個別ファイルの`getFile()`失敗は1件のunreadableとして記録しscanを継続する。
 * ディレクトリ列挙（`entries()`）自体が失敗した場合は例外をそのまま呼び出し元へ
 * 伝播させる（scanCompleted=falseにするための唯一のトリガー）。
 *
 * Android実機不具合対応（soft deadline）：各エントリの処理を開始する直前に
 * `state.deadline`を確認する。超過していれば`state.deadlineExceeded = true`を
 * 立てて即座にreturnし、このディレクトリ以降の新規エントリ・再帰先の
 * サブディレクトリの処理を一切開始しない（既に開始済みの1エントリの処理は
 * 呼び出し元でも中断しない——File System Access APIの`entries()`/`getFile()`/
 * `getFileHandle()`/`Blob.text()`はいずれもAbortSignalを持たず、実行中のI/Oを
 * 安全に取り消す手段が無いため、「新しいI/Oを開始しない」という境界でしか
 * soft deadlineを効かせられない）。この関数は再帰的に自分自身を呼ぶため、
 * 一度deadlineを検出してreturnすると、呼び出し元の`for await`ループも次の
 * iterationで同じ判定に当たり、ツリー全体が速やかに（新規I/Oを増やさずに）
 * 巻き戻る。
 */
async function walkVaultForResync(
  root: FileSystemDirectoryHandle,
  state: VaultResyncScanState,
  dir: FileSystemDirectoryHandle,
  prefix: string
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (Date.now() > state.deadline) {
      state.deadlineExceeded = true;
      return;
    }
    if (name.startsWith(HIDDEN_PREFIX)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      await walkVaultForResync(root, state, handle, path);
      continue;
    }
    if (!name.endsWith(".md")) continue;

    state.scannedFileCount += 1;

    // Codexレビュー指摘・High対応：このpathがregistry snapshotの既知pathと
    // 一致する時点で、本文が読める・parseできるかどうかに関わらず
    // negative evidence（missing）を止める。directory listingにこの名前が
    // 存在した、という事実自体が「物理的に何かが存在した」ことの確認であり、
    // 直後のgetFile/text/parseが失敗してもこの事実は取り消さない。
    const knownKeyAtThisPath = state.previousRegistryKeyByPath.get(path);
    if (knownKeyAtThisPath !== undefined) {
      state.seenKnownKeys.add(knownKeyAtThisPath);
    }

    let file: File;
    try {
      file = await handle.getFile();
    } catch (error) {
      state.unreadableFiles.push({ path, reason: `getFile failed: ${String(error)}` });
      continue;
    }
    try {
      await processVaultResyncCandidate(root, state, path, file);
    } catch (error) {
      state.unreadableFiles.push({ path, reason: `processing failed: ${String(error)}` });
    }
  }
}

/**
 * Android実機不具合対応（soft deadline）：明示的Vault resync1回あたりの
 * scan phaseに与える時間予算（ミリ秒）。File System Access APIの1回のI/O
 * （`getFile()`/`file.text()`等）は、実機観測でPC・Chromeでは数十ms程度だが、
 * Android（Storage Access Framework/document provider経由）では1回あたり
 * 1.3〜2.8秒、時に8〜11秒かかることが既存コメントで確認されている
 * （`flushPendingToVaultInBackground`関連コメント参照）。15秒のような短い
 * 予算では、Android実機でファイル数件を処理しただけで毎回打ち切られてしまい
 * 実用的な進捗が得られない。2分（120秒）であれば、典型的なAndroid実機の
 * 1件あたりコストでも数十〜100件程度は1回のresyncで処理できる。
 *
 * このsoft deadlineの目的：File System Access APIのI/O自体は正常に返ってくる
 * が、Vault全体の処理に（Android実機のI/Oコストの積み重ねで）時間がかかる
 * ケースにおいて、安全なファイル境界（次のファイルの処理を開始する直前）で
 * partial scanとして終了させるためのもの。超過した場合はscanCompleted=false
 * として返るため、既存の安全設計（missing確定・baselineEstablishedAt/
 * lastFullResyncAtの更新はscanCompleted=trueの場合のみ）により、missing確定・
 * baseline更新のいずれも行われない。deadlineまでに処理できた範囲（moved/
 * edited/added等）は安全にRegistry/IndexedDBへ反映される。
 *
 * 重要な制約：`performVaultResyncScan`は呼ばれるたびに新しいscan stateで
 * Vault rootから走査をやり直す設計であり、前回どこまで処理したかを記録・
 * 再開するcursor/resume機構は持たない。"unchanged"と判明する記録であっても
 * 判定前に本文I/O（probe読み込み＋`file.text()`）を要するため、次回resyncは
 * 前回の続きからではなく常にrootから再走査する。そのため、1回のsoft
 * deadline（本予算）に収まらないほど大きいVaultでは、複数回resyncを実行しても
 * 毎回同じ範囲の処理で打ち切られ、全体には到達できない可能性がある。
 *
 * また、このsoft deadlineはファイル境界（＝次のI/Oを開始する前）でのみ判定
 * されるため、単発のFile System Access API呼び出し自体がhangした場合
 * （`await`が返らない場合）は、このdeadlineでは中断できない
 * （AbortSignal等によるI/O自体のcancelはFile System Access APIの仕様上
 * 提供されていないため）。
 */
const VAULT_RESYNC_SOFT_DEADLINE_MS = 120_000;

/**
 * Step 4a本体：registry snapshot→Vault全体のenumeration＋classificationを
 * メモリ上で完成させる（applyは一切行わない）。呼び出し元（`resyncVaultRegistry`）
 * が既に"tsumugi-vault-world"を排他保持していることを前提とする——この関数の
 * 内部からは`withVaultWorldRead`等のH4ロック関数を一切呼び出さない。
 */
/**
 * registry snapshot（実在するshardファイルだけを読む。64個を仮定して全部
 * 読みにいかない）。.tsumugi/registry/ 自体が無い場合（既存Vault・初回）は
 * 空のsnapshotを返す——呼び出し元はこれを「全recordがRegistry absent」として
 * 扱う（既存の`performVaultResyncScan`のPhase 0と、軽量チェック（Level 1/2）
 * の両方から共有する純粋な読み取りprimitive。ロックは取得しない（既存の
 * `readVaultRegistryShard`と同じ理由：読み込みが書き込みと競合しても
 * 「わずかに古いregistryを読む」だけであり実害が無いため）。
 */
interface VaultRegistrySnapshot {
  previousByKey: Map<string, string>;
  previousEntries: Map<string, VaultRegistryFileEntry>;
  previousRegistryKeyByPath: Map<string, string>;
}

async function buildVaultRegistrySnapshot(root: FileSystemDirectoryHandle): Promise<VaultRegistrySnapshot> {
  const snapshotStart = Date.now();
  const previousByKey = new Map<string, string>();
  const previousEntries = new Map<string, VaultRegistryFileEntry>();
  const previousRegistryKeyByPath = new Map<string, string>();
  // Codexレビュー指摘（Low）対応：shardCountは「実際にsnapshotへ反映できた
  // shard数」を表す。ループ内で1件処理するたびに加算するため、途中でI/Oエラーに
  // なっても0固定にはならず、そこまでに処理できた件数が正しく残る。
  let shardCount = 0;
  // .tsumugi/registry/ が無い（Registry未確立の正常な状態）場合は、既存挙動
  // （previousByKey等は空のまま）を維持しつつ、diagnostic上もcompleted=true
  // （＝空のsnapshotとして正常に完了した）として扱う。
  let completed = true;
  try {
    // 実機不具合対応（Android性能改善）：`.tsumugi`/`.tsumugi/registry`は
    // このsnapshot構築の間ずっと同じディレクトリを指すため、1回だけ解決して
    // 以降の全shard readで使い回す（`readVaultRegistryShardFromDir`）。以前は
    // shardを読むたびに`readVaultRegistryShard`経由で毎回この2階層を再解決して
    // いた（実機ログで確認された重複I/Oの一因）。この解決自体はCodexレビュー
    // 指摘（M1）の対象外で、そのまま維持する。
    const tsumugiDir = await timedIOStep("registry snapshot:tsumugiDir", () => root.getDirectoryHandle(".tsumugi", { create: false }));
    const registryDir = await timedIOStep("registry snapshot:registryDir", () =>
      tsumugiDir.getDirectoryHandle("registry", { create: false })
    );

    // Codexレビュー指摘（M1）対応：「entries()を先に配列化してから読む」二段
    // 構成をやめ、変更前と同じ「列挙しながらその場でshardを読み、snapshotへ
    // 反映する」単一ループへ戻した。これにより、entries()の途中でI/Oエラーが
    // 起きても、それまでに読めたshardの情報は（変更前と同じく）previousByKey/
    // previousEntries/previousRegistryKeyByPathに残る。読む順序もentries()の
    // 列挙順のまま。registryDirハンドルの使い回しだけは維持する。
    try {
      for await (const [name, handle] of registryDir.entries()) {
        if (handle.kind !== "file" || !name.endsWith(".json")) continue;
        const bucket = Number.parseInt(name.replace(/\.json$/, ""), 16);
        if (!Number.isFinite(bucket)) continue;
        const shard = await readVaultRegistryShardFromDir(registryDir, bucket);
        for (const [key, path] of Object.entries(shard.records)) {
          previousByKey.set(key, path);
          previousRegistryKeyByPath.set(path, key);
        }
        for (const [path, entry] of Object.entries(shard.files)) {
          previousEntries.set(path, entry);
        }
        shardCount += 1;
      }
    } catch {
      // 実機不具合対応（Codexレビュー指摘対応）：entries()の列挙自体が途中で
      // 失敗した場合。それまでにshardCountへ加算済み・snapshotへ反映済みの
      // 内容はそのまま残す（変更前と同じ「読めた分だけ読む」挙動）。diagnostic
      // 上は「完了しなかった」ことだけを記録する。
      completed = false;
    }
  } catch {
    // .tsumugi/registry/ が無い：previousByKey/previousEntries/previousRegistryKeyByPathは空のまま。
  }
  // 実機不具合対応（Android性能改善・aggregate diagnostic、Codexレビュー指摘
  // M1/Low対応）：個々のpath/idは含めず、実際にsnapshotへ反映できたshard数・
  // 全体所要時間・列挙が最後まで完了したかどうかだけを記録する。途中失敗時に
  // 「complete」と誤解されるイベントは出さない（completed=0として区別する）。
  logTimingEvent("Vault registry snapshot:end", {
    shardCount,
    durationMs: Date.now() - snapshotStart,
    completed: completed ? 1 : 0,
  });
  return { previousByKey, previousEntries, previousRegistryKeyByPath };
}

/**
 * C1（Codexレビュー指摘・High 2対応）：resync専用のshard読み込み。
 * `buildVaultRegistrySnapshot`が内部で使う`readVaultRegistryShardFromDir`
 * （→`readJSON`）は、getFileHandle/getFile/readText/JSON.parseのいずれが
 * 失敗しても静かに既定値へfallbackする既存の共有契約であり、呼び出し元は
 * 個々のshard読み込み単体の失敗を一切区別できない。この関数はその既存契約
 * （`readJSON`/`readVaultRegistryShardFromDir`自体）を一切変更せず、
 * resync専用の別経路として同じ読み込みシーケンスを独自に行い、失敗を
 * `readFailed`として呼び出し元へ伝える。データ（成功時の値、失敗時の
 * fallback値）は既存と完全に同一——追加されるのは失敗シグナルのみ。
 */
/**
 * Codexレビュー再指摘・High 2対応：`.tsumugi`/`.tsumugi/registry`の
 * `getDirectoryHandle`失敗のうち、真正NotFound（＝Registry未確立の正常な
 * 状態）だけを「正常な空」として扱うための判定。permission error/I-O
 * error/SecurityError等、存在自体を確認できない失敗はこれに含めない
 * （catch-allで同じ扱いにしない）。
 */
function isVaultRegistryDirectoryNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function isValidVaultRegistryRecordType(value: unknown): value is VaultRegistryRecordType {
  return value === "conversation" || value === "reflection" || value === "source" || value === "memory-day";
}

/**
 * Codexレビュー再指摘・High 2対応：`JSON.parse`が成功しただけではshard構造が
 * completeとはみなさない。C1のlightweight projection（registryKey/path/
 * mtime/size/recordType）を安全に構築するために必要な構造——`records`/`files`
 * がobjectであること、`records`が参照する全pathについて`files`に対応する
 * entryが存在すること（orphan禁止）、そのentryの`mtime`/`size`が数値、
 * `recordType`が既知のenum値であること——を検証する。1件でも不整合・
 * malformedな値があれば`null`を返し、呼び出し元はshard読み込み失敗と同じ
 * fallback（空shard＋`readFailed=true`）へ倒す。既存の`readJSON`/
 * `readVaultRegistryShardFromDir`（L1/L2・A1/A2共有）には一切触れない。
 */
function validateVaultRegistryShardStructure(parsed: unknown): VaultRegistryShard | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const records = obj.records;
  const files = obj.files;
  if (typeof records !== "object" || records === null || Array.isArray(records)) return null;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return null;
  const recordsObj = records as Record<string, unknown>;
  const filesObj = files as Record<string, unknown>;
  for (const path of Object.values(recordsObj)) {
    if (typeof path !== "string") return null;
    const entry = filesObj[path];
    if (typeof entry !== "object" || entry === null) return null; // orphan：records→filesの整合性が崩れている
    const e = entry as Record<string, unknown>;
    if (typeof e.mtime !== "number" || typeof e.size !== "number") return null;
    if (!isValidVaultRegistryRecordType(e.recordType)) return null;
  }
  return parsed as VaultRegistryShard;
}

async function readVaultRegistryShardFromDirForResyncSnapshot(
  registryDir: FileSystemDirectoryHandle,
  bucket: number
): Promise<{ shard: VaultRegistryShard; readFailed: boolean }> {
  try {
    const fileHandle = await timedIOStep("registry snapshot:shard fileHandle", () =>
      registryDir.getFileHandle(vaultRegistryBucketFileName(bucket), { create: false })
    );
    const file = await timedIOStep("registry snapshot:shard getFile", () => fileHandle.getFile());
    const text = await timedIOStep("registry snapshot:shard readText", () => file.text());
    const parsed: unknown = JSON.parse(text);
    const validated = validateVaultRegistryShardStructure(parsed);
    if (validated === null) {
      return { shard: emptyVaultRegistryShard(bucket), readFailed: true };
    }
    return { shard: validated, readFailed: false };
  } catch {
    return { shard: emptyVaultRegistryShard(bucket), readFailed: true };
  }
}

/**
 * C1（Codexレビュー指摘・High 2対応）：`performVaultResyncScan`専用の
 * registry snapshot読み込み。`buildVaultRegistrySnapshot`（L1/L2の軽量
 * チェックとも共有される既存の読み取りprimitive）とは意図的に別関数として
 * 複製する——L1/L2の挙動には一切触れないため（L1/L2は引き続き
 * `buildVaultRegistrySnapshot`をそのまま使う、無変更）。
 *
 * データの集め方（previousByKey/previousEntries/previousRegistryKeyByPath/
 * shardCount）は`buildVaultRegistrySnapshot`と完全に同一であり、既存resync
 * classificationへ渡るデータは1バイトも変わらない。追加している点は1つ：
 * `.tsumugi/registry/`のdirectory enumeration失敗（既存も検出済み）に加えて、
 * 個々のshard読み込み単体の失敗（`readVaultRegistryShardFromDirForResyncSnapshot`
 * 参照、既存の`readJSON`経由では検出不可能だった＝Codexレビュー指摘・High 2）も
 * `completed`へ反映する。`.tsumugi/registry/`自体が存在しない場合（正常な
 * 空Registry）は、既存と同じく`completed=true`のまま。
 */
async function buildVaultRegistrySnapshotForResync(
  root: FileSystemDirectoryHandle
): Promise<VaultRegistrySnapshot & { completed: boolean }> {
  const snapshotStart = Date.now();
  const previousByKey = new Map<string, string>();
  const previousEntries = new Map<string, VaultRegistryFileEntry>();
  const previousRegistryKeyByPath = new Map<string, string>();
  let shardCount = 0;
  let completed = true;

  let registryDir: FileSystemDirectoryHandle | null = null;
  try {
    const tsumugiDir = await timedIOStep("registry snapshot:tsumugiDir", () => root.getDirectoryHandle(".tsumugi", { create: false }));
    registryDir = await timedIOStep("registry snapshot:registryDir", () => tsumugiDir.getDirectoryHandle("registry", { create: false }));
  } catch (error) {
    // Codexレビュー再指摘・High 2対応：真正NotFound（.tsumugi/.tsumugi/registry
    // が単に存在しない＝Registry未確立の正常な状態）のみ「正常な空Registry」
    // としてcompleted=trueを維持する。permission error/I-O error/
    // SecurityError等、存在自体を確認できない失敗はcatch-allで同じ扱いに
    // せず、completed=falseとする。
    if (!isVaultRegistryDirectoryNotFoundError(error)) {
      completed = false;
    }
  }

  if (registryDir) {
    try {
      for await (const [name, handle] of registryDir.entries()) {
        if (handle.kind !== "file" || !name.endsWith(".json")) continue;
        const bucket = Number.parseInt(name.replace(/\.json$/, ""), 16);
        if (!Number.isFinite(bucket)) continue;
        const { shard, readFailed } = await readVaultRegistryShardFromDirForResyncSnapshot(registryDir, bucket);
        if (readFailed) completed = false;
        for (const [key, path] of Object.entries(shard.records)) {
          previousByKey.set(key, path);
          previousRegistryKeyByPath.set(path, key);
        }
        for (const [path, entry] of Object.entries(shard.files)) {
          previousEntries.set(path, entry);
        }
        shardCount += 1;
      }
    } catch {
      completed = false;
    }
  }

  logTimingEvent("Vault registry snapshot:end", {
    shardCount,
    durationMs: Date.now() - snapshotStart,
    completed: completed ? 1 : 0,
  });
  return { previousByKey, previousEntries, previousRegistryKeyByPath, completed };
}

async function performVaultResyncScan(root: FileSystemDirectoryHandle): Promise<VaultResyncScanResult> {
  const snapshot = await buildVaultRegistrySnapshotForResync(root);
  const state: VaultResyncScanState = {
    previousByKey: snapshot.previousByKey,
    previousEntries: snapshot.previousEntries,
    previousRegistryKeyByPath: snapshot.previousRegistryKeyByPath,
    seenPathsByKey: new Map(),
    seenKnownKeys: new Set(),
    recordsByKey: new Map(),
    unreadableFiles: [],
    scannedFileCount: 0,
    deadline: Date.now() + VAULT_RESYNC_SOFT_DEADLINE_MS,
    deadlineExceeded: false,
  };

  // Phase 1：directory enumeration + classification。
  let scanCompleted = false;
  try {
    await walkVaultForResync(root, state, root, "");
    // Android実機不具合対応（soft deadline）：deadline超過により打ち切った場合は
    // "全体を見終えていない"という点でディレクトリ列挙失敗と同じ意味を持つため、
    // 既存のscanCompleted=false（missing確定・baseline確立を行わない）へ合流させる。
    if (state.deadlineExceeded) {
      console.warn(
        `[Tsumugi] resync: soft deadline (${VAULT_RESYNC_SOFT_DEADLINE_MS}ms) exceeded, stopping scan at a safe file boundary (no new I/O started).`
      );
    }
    scanCompleted = !state.deadlineExceeded;
  } catch (error) {
    console.error("[Tsumugi] resync: directory enumeration failed, skipping missing-detection this run:", error);
    scanCompleted = false;
  }

  // Phase 2：missing確定（scanCompleted===trueの場合だけ）。previousByKeyのうち
  // 本scanで一度も見つからなかったregistryKeyを"missing"とする。
  // Codexレビュー指摘・High対応：recordsByKeyに無いだけでなく、seenKnownKeysにも
  // 無いことを両方満たす場合にのみmissingにする——registered pathに物理ファイルは
  // あったが読めなかった/parseできなかっただけのkeyをmissing扱いにしないため
  // （その場合、このkeyはrecords配列に一切現れず、次回resyncへ持ち越される）。
  if (scanCompleted) {
    for (const [key, prevPath] of state.previousByKey.entries()) {
      if (state.recordsByKey.has(key)) continue;
      if (state.seenKnownKeys.has(key)) continue;
      const entry = state.previousEntries.get(prevPath);
      if (!entry) continue;
      state.recordsByKey.set(key, {
        registryKey: key,
        recordType: entry.recordType,
        outcome: "missing",
        previousPath: prevPath,
        currentPath: null,
        contentHash: null,
        mtime: null,
        size: null,
        members: null,
        addedIndexedDbEquivalent: null,
        note: null,
        parsed: null,
        allObservedPaths: null,
      });
    }
  }

  return {
    scanCompleted,
    scannedFileCount: state.scannedFileCount,
    records: [...state.recordsByKey.values()],
    unreadableFiles: state.unreadableFiles,
    previousByKey: state.previousByKey,
    previousEntries: state.previousEntries,
    previousSnapshotCompleted: snapshot.completed,
  };
}

// ---------------------------------------------------------------------------
// 軽量「外部の変更」検知フロー（Level 1〜4）
//
// 目的：ユーザーに毎回「Vaultを再同期」を手動で押させる既存フロー（full resync、
// 上記`performVaultResyncScan`/`resyncVaultRegistry`）とは別に、起動時に軽量に
// 「変更の可能性があるファイル」だけを検出し、ユーザーが確認・反映を選んだ場合
// だけ本文を読んで実際に分類・適用する、4段階のフローを提供する。
//
// 最重要方針（合意済み）：
// - classification engine（`processVaultResyncCandidate`／
//   `handleResyncSingleRecordCandidate`／`handleResyncMemoryDayCandidate`／
//   `applySingleRecordOutcome`／`applyMemoryDayOutcome`／
//   `applyVaultResyncScanResult`）は一切変更しない。Level 3/4はこれらへ
//   candidate集合だけを渡す形で再利用する。
// - 既存のfull resync（`performVaultResyncScan`/`resyncVaultRegistry`）も
//   一切変更しない。maintenance fallbackとして残す。
// - この軽量フローは`resyncVaultRegistry`を一切呼ばないため、
//   `baselineEstablishedAt`／`lastFullResyncAt`は絶対に更新されない
//   （これらを更新できるのは既存のfull resyncだけ、という制約を構造的に
//   満たす——「呼ばない」ことで保証しており、フラグ等での抑制ではない）。
// ---------------------------------------------------------------------------

/**
 * Level 1：既知path（Registryに登録済みの全path）それぞれについて、
 * `getFileHandle`＋`getFile()`だけでmtime/sizeを確認する（本文は一切読まない）。
 * 既存の`verifyVaultRegistryEntryBeforeWrite`（write側の軽量fast path）と
 * 同じ考え方——mtime/sizeが一致すれば本文read無しで「変更なし」と判断してよい、
 * という既に本番で使われている前提をbulk化しただけであり、新しい安全性の
 * 前提を持ち込んでいない。
 *
 * statusが"ok"以外（既にneeds-resync/missing/conflict）の既知recordも対象に
 * 含める——既存full resyncボタンを使わないユーザーでも、この軽量フロー経由で
 * 再確認・解消できるようにするため。
 */
export interface VaultLightCheckKnownPathCandidate {
  registryKey: string;
  recordType: VaultRegistryRecordType;
  previousPath: string;
  /**
   * 安全性レビュー対応（M2）：「読めなかった」と「存在しない」を区別する。
   * - "path-missing"：`NotFoundError`（既存`targetedCheckSingleRecordStillAt`と
   *   同じ判定基準）——ファイルが物理的に無いと確認できた場合のみ。
   * - "read-failed"：権限エラー・I/Oエラー・その他の失敗。ファイルが本当に
   *   無いのか一時的に読めないだけなのか区別できないため、missing扱いには
   *   絶対にしない（Level 3で再試行し、それでも読めなければ「確認不能」として
   *   confirmedPresentにもmissingにもしない——次回チェックへ持ち越す）。
   */
  reason: "metadata-changed" | "path-missing" | "read-failed";
}

/** `targetedCheckSingleRecordStillAt`等の既存判定基準と同じ：NotFoundErrorだけを
 *  「確認できた不在」として扱う。 */
function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

interface VaultLightCheckLevel1Result {
  candidates: VaultLightCheckKnownPathCandidate[];
  /** candidateにならなかった（＝mtime/sizeが一致し、物理的に存在も確認できた）
   *  registryKeyの集合。Level 3のmissing確定で「Level 1が既に存在確認済み」
   *  として除外するために使う。 */
  confirmedPresentKeys: Set<string>;
  /**
   * Codexレビュー指摘（A2 M2関連）対応：`confirmedPresentKeys ∪ candidates`は
   * 「Level 1がsnapshot上で観測した全known key」の完全な分割ではない——
   * `previousByKey`にkeyがあるのに対応する`previousEntries`が無い（snapshot不整合、
   * 理論上起こらない想定だが`if (!entry) continue`で実際にスキップされ得る）場合、
   * そのkeyは`confirmedPresentKeys`にも`candidates`にも入らない。このMapは
   * そうした「orphan」keyも含め、Level 1がこのsnapshotで見た**全known key→
   * その時点のpath**をそのまま保持する（`snapshot.previousByKey`を丸ごとコピー
   * するだけで、追加のI/Oは発生しない）。Level 3のmissing確定は、このMapに
   * 含まれる全keyを対象にし、かつRegistryの「現在」状態を都度確認することで、
   * このMapのpath自体が古くても安全側に倒れる（`lookupCurrentRegistryEntryForL3`
   * 参照）。
   */
  allKnownKeys: Map<string, string>;
}

async function discoverLevel1MetadataCandidates(
  root: FileSystemDirectoryHandle,
  snapshot: VaultRegistrySnapshot
): Promise<VaultLightCheckLevel1Result> {
  const level1Start = Date.now();
  const candidates: VaultLightCheckKnownPathCandidate[] = [];
  const confirmedPresentKeys = new Set<string>();
  // Codexレビュー指摘（A2 M2関連）対応：orphan key（下記`if (!entry) continue`で
  // スキップされるkey）も含め、Level 1がこのsnapshotで見た全known keyのpathを
  // そのまま保持する。`snapshot.previousByKey`は既にメモリ上にあるMapなので、
  // コピーのみで追加I/Oは発生しない。
  const allKnownKeys = new Map<string, string>(snapshot.previousByKey);
  // 実機不具合対応（Android性能改善）：既知recordの多くが同じConversations/
  // Memories/Sourcesディレクトリを共有するため、このLevel 1実行1回の間だけ
  // ディレクトリハンドルを使い回す。この関数のローカル変数のため、関数を抜ければ
  // 破棄され、次回のLevel 1実行へは一切持ち越さない（stale handleを作らない）。
  const dirHandleCache: VaultDirHandleCache = new Map();

  for (const [registryKey, path] of snapshot.previousByKey.entries()) {
    const entry = snapshot.previousEntries.get(path);
    if (!entry) continue; // snapshot不整合（理論上起こらない想定）。安全側でcandidate化しない。

    let file: File;
    try {
      const resolved = await resolveVaultRelativePath(root, path, dirHandleCache);
      const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
      file = await fileHandle.getFile();
    } catch (error) {
      candidates.push({
        registryKey,
        recordType: entry.recordType,
        previousPath: path,
        reason: isNotFoundError(error) ? "path-missing" : "read-failed",
      });
      continue;
    }

    if (file.lastModified !== entry.mtime || file.size !== entry.size) {
      candidates.push({ registryKey, recordType: entry.recordType, previousPath: path, reason: "metadata-changed" });
      continue;
    }

    confirmedPresentKeys.add(registryKey);
  }

  // 実機不具合対応（aggregate diagnostic）：個々のregistryKey/pathは含めず、
  // 件数と所要時間だけを記録する。
  logTimingEvent("Vault light:L1 complete", {
    knownCount: snapshot.previousByKey.size,
    candidateCount: candidates.length,
    durationMs: Date.now() - level1Start,
  });

  return { candidates, confirmedPresentKeys, allKnownKeys };
}

/**
 * Android実機不具合対応（soft deadline）：Level 2はbody I/Oを一切行わない
 * path-only walkのため、既存full resyncのLevel（`VAULT_RESYNC_SOFT_DEADLINE_MS`、
 * 1ファイルあたり複数回のbody read込み）よりも大幅に軽量だが、極端に大きい
 * ディレクトリツリーでは`entries()`の呼び出し回数自体がAndroidで無視できない
 * コストになりうるため、同じ「ファイル境界（＝次のディレクトリ/エントリの
 * 処理を開始する前）でのみ確認する」soft deadlineを用意する。
 */
const VAULT_LIGHT_CHECK_LEVEL2_DEADLINE_MS = 60_000;

interface VaultLightCheckLevel2State {
  /** 既知registered pathには一致しない、新規または移動先候補の`.md` path。 */
  unknownPaths: string[];
  /** 既知registryKeyのうち、本walkでそのregistered pathの名前を実際に
   *  見つけた（＝物理的に存在した）ものの集合。既存`walkVaultForResync`の
   *  `seenKnownKeys`と同じ役割・同じ判定方法（path文字列の一致のみ、
   *  bodyは一切読まない）。 */
  seenKnownKeys: Set<string>;
  deadline: number;
  deadlineExceeded: boolean;
}

/**
 * Level 2：Vault全体を再帰的に列挙するが、`.md`拡張子のpath文字列を集める
 * だけで、`getFile()`／`file.text()`／parse／`processVaultResyncCandidate`の
 * いずれも呼ばない（禁止事項として明示された通り）。既知registered pathとの
 * 一致判定も、Registry snapshotの`previousRegistryKeyByPath`（path文字列→
 * registryKey）を使った文字列比較のみで行う。
 */
async function walkVaultForLightCheckPaths(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  snapshot: VaultRegistrySnapshot,
  state: VaultLightCheckLevel2State
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (Date.now() > state.deadline) {
      state.deadlineExceeded = true;
      return;
    }
    if (name.startsWith(HIDDEN_PREFIX)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      await walkVaultForLightCheckPaths(handle, path, snapshot, state);
      continue;
    }
    if (!name.endsWith(".md")) continue;

    const knownKey = snapshot.previousRegistryKeyByPath.get(path);
    if (knownKey !== undefined) {
      state.seenKnownKeys.add(knownKey);
    } else {
      state.unknownPaths.push(path);
    }
  }
}

export interface VaultLightCheckLevel2Result {
  unknownPaths: string[];
  seenKnownKeys: Set<string>;
  /**
   * Vault全体のpath enumerationを最後まで完走できた場合のみtrue。deadline
   * 超過・例外・directory read失敗等、理由を問わずfalseにする。missing確定は
   * この値がtrueの場合にのみ許可する（既存full resyncの`scanCompleted`と
   * 同じ安全思想）。
   */
  completed: boolean;
}

async function performLevel2PathWalk(
  root: FileSystemDirectoryHandle,
  snapshot: VaultRegistrySnapshot
): Promise<VaultLightCheckLevel2Result> {
  const state: VaultLightCheckLevel2State = {
    unknownPaths: [],
    seenKnownKeys: new Set(),
    deadline: Date.now() + VAULT_LIGHT_CHECK_LEVEL2_DEADLINE_MS,
    deadlineExceeded: false,
  };
  let completed = false;
  try {
    await walkVaultForLightCheckPaths(root, "", snapshot, state);
    if (state.deadlineExceeded) {
      console.warn(
        `[Tsumugi] light check: Level 2 soft deadline (${VAULT_LIGHT_CHECK_LEVEL2_DEADLINE_MS}ms) exceeded, stopping path enumeration.`
      );
    }
    completed = !state.deadlineExceeded;
  } catch (error) {
    console.error("[Tsumugi] light check: Level 2 path enumeration failed:", error);
    completed = false;
  }
  return { unknownPaths: state.unknownPaths, seenKnownKeys: state.seenKnownKeys, completed };
}

/**
 * Level 1＋2の統合エントリポイント。起動時のbackground軽量チェックから
 * 呼ばれる想定（呼び出し元でロック・`beginMemoryTask`を扱う。この関数自体は
 * H4ロック関数を呼ばない——既存registry読み込みprimitiveと同じ、lock-free・
 * 読み取り専用のため）。
 */
export interface VaultLightCheckDiscoveryResult {
  metadataChangedCandidates: VaultLightCheckKnownPathCandidate[];
  missingPathCandidates: VaultLightCheckKnownPathCandidate[];
  /** 安全性レビュー対応（M2）：権限エラー・I/Oエラー等で確認できなかった既知
   *  path。missingPathCandidatesとは明確に区別する（「存在しない」と確定した
   *  わけではないため）。 */
  readFailedCandidates: VaultLightCheckKnownPathCandidate[];
  unknownPathCandidates: string[];
  /** 安全性レビュー対応（M2）：Level 2のpath-only walkが実際に存在を確認できた
   *  既知registryKeyの集合（path文字列の一致のみで判定、本文は読まない）。
   *  Level 1が`read-failed`とした既知pathでも、Level 2が同じpathを列挙で
   *  見つけていれば、少なくとも物理的に何か存在することの独立した証拠になる
   *  （Level 3のmissing確定判定で、Level 1の読み取り失敗だけを理由に誤って
   *  missing扱いしないためのセーフティネット）。 */
  level2SeenKnownKeys: Set<string>;
  level2Completed: boolean;
  checkedAt: string;
  /**
   * 実機不具合対応（Android性能改善・A2）：Level 1が既に存在確認まで完了した
   * （＝getFileHandle/getFileに成功し、mtime/sizeもRegistry記載値と一致した）
   * registryKeyの集合。`discoverLevel1MetadataCandidates`が内部で計算している
   * `confirmedPresentKeys`をそのままここへ伝播するだけで、新たな計算・新たな
   * I/Oは発生しない。L3（`classifyVaultLightCheckCandidates`）が、Level 1/2
   * 終了後に改めてRegistry全体を読み直さずにmissing確定判定を行うために使う。
   *
   * Codexレビュー指摘対応：`confirmedPresentKeys ∪ metadataChangedCandidates ∪
   * missingPathCandidates ∪ readFailedCandidates`は「全known key」の完全な
   * 分割ではない（`allKnownKeys`のコメント参照、snapshot不整合でどちらにも
   * 入らないkeyがあり得る）。「全known key集合」が必要な場面では
   * `allKnownKeys`を使うこと。
   */
  confirmedPresentKeys: Set<string>;
  /** `discoverLevel1MetadataCandidates`の`allKnownKeys`をそのまま伝播する
   *  （詳細はそちらのコメント参照）。追加I/Oは発生しない。 */
  allKnownKeys: Map<string, string>;
}

export async function performVaultLightCheckDiscovery(
  root: FileSystemDirectoryHandle
): Promise<VaultLightCheckDiscoveryResult> {
  const snapshot = await buildVaultRegistrySnapshot(root);
  const level1 = await discoverLevel1MetadataCandidates(root, snapshot);
  const level2 = await performLevel2PathWalk(root, snapshot);

  const metadataChangedCandidates = level1.candidates.filter((c) => c.reason === "metadata-changed");
  const missingPathCandidates = level1.candidates.filter((c) => c.reason === "path-missing");
  const readFailedCandidates = level1.candidates.filter((c) => c.reason === "read-failed");

  return {
    metadataChangedCandidates,
    missingPathCandidates,
    readFailedCandidates,
    unknownPathCandidates: level2.unknownPaths,
    level2SeenKnownKeys: level2.seenKnownKeys,
    level2Completed: level2.completed,
    checkedAt: new Date().toISOString(),
    confirmedPresentKeys: level1.confirmedPresentKeys,
    allKnownKeys: level1.allKnownKeys,
  };
}

/** UI表示用（件数のみ、内訳の意味は断定しない——moveがmissing+unknownの2件に
 *  分かれる等の理由で、この合計は実際の変更件数と一致しない）。readFailedは
 *  「確認できなかっただけ」であり変更の証拠ではないため件数に含めない。 */
export function countVaultLightCheckCandidates(discovery: VaultLightCheckDiscoveryResult): number {
  return (
    discovery.metadataChangedCandidates.length +
    discovery.missingPathCandidates.length +
    discovery.unknownPathCandidates.length
  );
}

// ---------------------------------------------------------------------------
// Vault Registry（Step 4b：resync applyの実装）
//
// Step 4aのclassification結果を使い、IndexedDB・Registry・History Index・
// vaultSyncStateを安全に再整合させる。Markdown本文は一切書き換えない
// （write経路はStep 2のまま、resyncからは呼ばない）。
//
// 最重要方針（合意済み）：
// - 完全なatomic transactionは複数storageをまたぐため存在しない。ロールバック
//   前提にはせず、「途中で失敗しても次回resyncが安全に再実行できる」
//   idempotent/retry-safe設計を優先する。
// - Registry status="ok"（＋新しいhash/path/metadata）は、IndexedDB・
//   vaultSyncState・History Indexの全てが成功した後にのみ書く
//   （commit markerとして最後に進める）。
// - record本体とvaultSyncStateは同一IndexedDB transactionでまとめて書く
//   （db.tsの`putConversationAndMarkSynced`等）。これにより「本体だけ更新できて
//   vaultSyncStateだけ失敗した」という中間状態を構造的に作らない——この中間状態は
//   次回resyncの「local unsynced」判定を誤らせ、正しく適用できた変更を誤って
//   conflict候補にしてしまう。
// - Conversation/ReflectionのeditedはL/Fのday（History上の日付）が一致する場合
//   のみ適用する。`updateHistoryIndex`は「新しいdayへupsertするだけ」で旧dayの
//   entryを削除しないため（実コード確認済み）、day変化を伴う編集を無条件適用すると
//   同一recordがHistory上に重複表示されうる。day不一致はconflictへ切り替える。
// - Conversationのturn数がL/Fで異なる場合も、安全側でconflictへ切り替える
//   （turn単位の高度なdiff/mergeは今回実装しない）。
// - normal Memory day-fileは、member単位で安全に適用できるものは適用しつつ、
//   1件でも失敗・conflictがあればcontainer全体のRegistry"ok" commitを保留する
//   （他memberの処理自体は止めない）。
// ---------------------------------------------------------------------------

/**
 * Step 4c対応：`resyncVaultRegistry`の公開結果`VaultResyncResult.applyErrors`に
 * 使う型（旧`VaultResyncApplyErrorInfo`から改名）。`recordType`は通常のrecord単位
 * エラーでは必ず設定されるが、registry-meta更新失敗のような特定recordに紐付かない
 * system-levelのエラー（`registryKey: "__registry_meta__"`）では省略できるよう
 * optionalにしている。
 */
export interface VaultResyncApplyError {
  registryKey: string;
  recordType?: VaultRegistryRecordType;
  reason: string;
}

/**
 * 実機不具合対応（診断情報）：「詳細を見る」でconflict/missingそれぞれの
 * 実体（どのrecordか）を確認できるようにするための最小限の情報。分類ロジック
 * 自体（`checkLocalUnsynced`等）は一切変更せず、既存の`VaultResyncRecordResult`
 * が既に保持している情報（`registryKey`/`recordType`/`previousPath`/
 * `currentPath`/`note`）をそのまま転記するだけ。`note`は既存のconflict経路
 * ごとに異なる文言が既に設定されている（例："同一idが複数pathに存在します（重複）"
 * "previous path could not be verified" "edited: ローカル未flush変更と競合して
 * います"等）ため、これをそのまま`reason`として使うことで、経路を識別可能にする
 * （新しい分類ロジックの追加ではない）。
 */
export interface VaultResyncConflictDetail {
  registryKey: string;
  recordType: VaultRegistryRecordType;
  previousPath: string | null;
  candidatePath: string | null;
  reason: string;
}

export interface VaultResyncMissingDetail {
  registryKey: string;
  recordType: VaultRegistryRecordType;
  previousPath: string | null;
}

/**
 * C1対応：1record分のapply結果（実際にshardへ反映されたかどうか）。
 * `applyVaultResyncScanResult`が既に計算しているfinalOutcome/成否を、
 * 追加I/O無しでそのまま公開するためだけの型（apply判定ロジック自体は
 * 一切変更しない）。`failed=true`の場合、そのrecordのshardは今回一切
 * 変更されていない（apply前のauthoritative状態のまま）ことを意味する。
 *
 * `finalRegistryEntry`（Codexレビュー指摘・High 1対応）：apply後に
 * authoritative Registry shardへ実際に存在する、このregistryKeyのentry
 * （path/mtime/size/recordType）を、推測ではなく確定値として持つ。
 * `status`(ok/missing/conflict/needs-resync)を問わず、shardに
 * recordが存在する限り必ず設定される（C1のindex契約：status限定
 * projectionではなく、known recordの全件projection）。shard上に
 * そもそもこのkeyのrecordが存在しない（previousPathが無く、かつ
 * 新規anchor作成もされなかった等）場合のみ`null`。 */
interface VaultResyncApplyRecordOutcome {
  registryKey: string;
  finalOutcome: VaultResyncOutcome;
  failed: boolean;
  finalRegistryEntry: VaultRegistryIndexEntry | null;
}

/** resync engine内部専用（外部へはexportしない。公開結果は`VaultResyncResult`）。 */
interface VaultResyncApplyResult {
  scanCompleted: boolean;
  scannedFileCount: number;
  counts: {
    unchanged: number;
    moved: number;
    edited: number;
    added: number;
    missing: number;
    conflict: number;
    unreadable: number;
  };
  applyErrors: VaultResyncApplyError[];
  unreadableFiles: VaultResyncUnreadableFile[];
  conflictDetails: VaultResyncConflictDetail[];
  missingDetails: VaultResyncMissingDetail[];
  /** C1対応：records配列と同じ順序・同じregistryKey集合を持つ、record単位の
   *  最終apply結果。`resyncVaultRegistry`がregistry-index.jsonを構築する際、
   *  追加のshard読み込み無しでこれを使う。 */
  recordOutcomes: VaultResyncApplyRecordOutcome[];
}

/** 既存のfiles[path]エントリのstatusだけを変更する（他フィールドは一切触れない）。
 *  records[key]自体が無い場合は何もしない（＝呼び出し元は代わりに
 *  `createVaultRegistryConflictAnchor`を使うべき）。 */
async function setVaultRegistryEntryStatus(
  root: FileSystemDirectoryHandle,
  registryKey: string,
  status: VaultRegistryStatus
): Promise<void> {
  const bucket = vaultRegistryBucketOf(registryKey);
  await withVaultRegistryLock(async () => {
    const shard = await readVaultRegistryShard(root, bucket);
    const path = shard.records[registryKey];
    if (path === undefined) return;
    const entry = shard.files[path];
    if (entry === undefined || entry.status === status) return;
    shard.files[path] = { ...entry, status };
    await writeVaultRegistryShard(root, bucket, shard);
  });
}

async function setVaultRegistryMissing(root: FileSystemDirectoryHandle, registryKey: string): Promise<void> {
  await setVaultRegistryEntryStatus(root, registryKey, "missing");
}

/**
 * Conversation/Reflection/Source（1id=1file）をstatus="ok"へ確定させる
 * （moved・added・edited成功時の共通経路）。pathが変わっている場合、同一bucket
 * 内の1回のread-modify-writeで旧pathのfiles entry削除＋新pathのfiles entry
 * 追加＋records[key]更新を行う（Registryをcommit markerとして最後に進める）。
 */
export async function commitVaultRegistrySingleRecordOk(
  root: FileSystemDirectoryHandle,
  registryKey: string,
  recordType: VaultRegistryRecordType,
  newPath: string,
  oldPathToRemove: string | null,
  mtime: number,
  size: number,
  contentHash: string
): Promise<void> {
  const bucket = vaultRegistryBucketOf(registryKey);
  await withVaultRegistryLock(async () => {
    const shard = await readVaultRegistryShard(root, bucket);
    if (oldPathToRemove !== null && oldPathToRemove !== newPath) {
      delete shard.files[oldPathToRemove];
    }
    shard.records[registryKey] = newPath;
    shard.files[newPath] = {
      recordType,
      mtime,
      size,
      contentHash,
      memberIds: [registryKey],
      status: "ok",
    };
    await writeVaultRegistryShard(root, bucket, shard);
  });
}

/** normal Memory day-file containerをstatus="ok"へ確定させる（member配列全体を持つ点のみ
 *  `commitVaultRegistrySingleRecordOk`と異なる）。 */
export async function commitVaultRegistryMemoryDayOk(
  root: FileSystemDirectoryHandle,
  registryKey: string,
  newPath: string,
  oldPathToRemove: string | null,
  mtime: number,
  size: number,
  contentHash: string,
  memberIds: string[],
  memberHashes: Record<string, string>
): Promise<void> {
  const bucket = vaultRegistryBucketOf(registryKey);
  await withVaultRegistryLock(async () => {
    const shard = await readVaultRegistryShard(root, bucket);
    if (oldPathToRemove !== null && oldPathToRemove !== newPath) {
      delete shard.files[oldPathToRemove];
    }
    shard.records[registryKey] = newPath;
    shard.files[newPath] = {
      recordType: "memory-day",
      mtime,
      size,
      contentHash,
      memberIds,
      memberHashes,
      status: "ok",
    };
    await writeVaultRegistryShard(root, bucket, shard);
  });
}

/**
 * 修正3（HIGH）対応：registryに一度も登録が無かった（`previousPath===null`）
 * registryKeyがconflictへ確定した場合に、`records[key]`を必ず作る。作らないと
 * Step 2/3の`lookupVaultRegistryRecord`が「registry entry無し」と判断し、
 * 決定論的pathへのfallback（write再作成・read成功）が起きてしまう。
 *
 * duplicate（真に新規のidが本scan内で複数pathに見つかった）場合は、
 * `allObservedPaths`の中からlexicographical sortの先頭を決定論的anchorとして
 * 選ぶ（scan順に依存させない。毎回同じ結果になる）。単一pathしか無い場合
 * （added+semantic mismatch）はそのpathをそのままanchorにする。他のduplicate
 * pathは一切削除・変更しない——単にrecords[key]の対象にしないだけ。
 *
 * 既にrecords[key]が存在する場合は何もしない（他経路が既に作成済み、または
 * 元々`previousPath!==null`だったケースはこの関数を呼ばない設計のため、
 * 通常は到達しない防御的チェック）。
 */
/**
 * Codexレビュー指摘・HIGH対応：anchorPathのfiles entryは、必ず
 * 「anchorPathそのものの実ファイルを観測して得たmetadata」でなければならない
 * （scanの分類対象になった別candidate pathのmetadataを誤って流用してはいけない）。
 * この関数はanchorPathを実際に読み直し、`hashVaultText`でcontentHashを再計算し、
 * `parseTsumugiResyncCandidate`（4aと同じ判定ロジック）でrecordType/member情報を
 * 確認する。読み込み・parseのいずれかに失敗した場合、または実際のrecordTypeが
 * 期待値と異なる場合は例外を投げる——呼び出し元（`createVaultRegistryConflictAnchor`）
 * はこれを一切catchしないため、そのまま`applyVaultResyncScanResult`のapplyError
 * として扱われ、conflict anchor自体はcommitされない（他pathのmetadataを代用しない）。
 */
async function readAnchorFileEntry(
  root: FileSystemDirectoryHandle,
  anchorPath: string,
  expectedRecordType: VaultRegistryRecordType
): Promise<Omit<VaultRegistryFileEntry, "status">> {
  const resolved = await resolveVaultRelativePath(root, anchorPath);
  const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
  const file = await fileHandle.getFile();
  const text = await file.text();
  const mtime = file.lastModified;
  const size = file.size;
  const contentHash = hashVaultText(text);

  const candidate = parseTsumugiResyncCandidate(text);
  if (!candidate) {
    throw new Error(`anchor file at ${anchorPath} could not be parsed as a Tsumugi record`);
  }

  if (candidate.kind === "memory-day") {
    if (expectedRecordType !== "memory-day") {
      throw new Error(`anchor file at ${anchorPath} parsed as memory-day but expected ${expectedRecordType}`);
    }
    const memberIds = candidate.members.map((m) => m.id);
    const memberHashes: Record<string, string> = {};
    for (const m of candidate.members) {
      memberHashes[m.id] = hashVaultText(memoryObjectToMarkdown(m));
    }
    return { recordType: "memory-day", mtime, size, contentHash, memberIds, memberHashes };
  }

  if (candidate.kind !== expectedRecordType) {
    throw new Error(`anchor file at ${anchorPath} parsed as ${candidate.kind} but expected ${expectedRecordType}`);
  }
  return { recordType: candidate.kind, mtime, size, contentHash, memberIds: [candidate.id] };
}

/**
 * C1（Codexレビュー指摘・High 1対応）：`createVaultRegistryConflictAnchor`が
 * 実際にshardへ書き込んだ（またはrace時に何も書かなかった）anchor entryを、
 * 呼び出し元（`applyVaultResyncScanResult`）が推測無しでregistry-index.jsonへ
 * 反映できるようにするための戻り値。`path`はこの関数が最終的に選んだ
 * anchor path（`record.currentPath`と異なりうる——lexicographical sortで
 * 選ばれた別pathの場合がある）、`entry`はそのpathを実際に読み直して得た
 * 値（`readAnchorFileEntry`の戻り値そのもの）。
 */
type VaultRegistryConflictAnchorCommit = { path: string; entry: Omit<VaultRegistryFileEntry, "status"> };

async function createVaultRegistryConflictAnchor(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult
): Promise<VaultRegistryConflictAnchorCommit> {
  let anchorPath: string;
  if (record.allObservedPaths !== null && record.allObservedPaths.length > 0) {
    anchorPath = [...record.allObservedPaths].sort()[0];
  } else if (record.currentPath !== null) {
    anchorPath = record.currentPath;
  } else {
    throw new Error(`conflict record ${record.registryKey} has no anchor path candidate`);
  }

  // Codexレビュー指摘・HIGH対応：anchorPathが本scanのcurrent candidate（例：B.md）と
  // 異なる場合（例：lexicographical anchorがA.md）でも、必ずanchorPath自身
  // （A.md）を読み直してmetadataを取得する。record.contentHash/mtime/size/members
  // （current candidate由来）をそのまま流用しない。resync全体がexclusive world
  // lockを保持している間はこの追加readの最中に通常Vault writeが割り込むことは無い。
  const anchorEntry = await readAnchorFileEntry(root, anchorPath, record.recordType);

  const bucket = vaultRegistryBucketOf(record.registryKey);
  return await withVaultRegistryLock(async (): Promise<VaultRegistryConflictAnchorCommit> => {
    const shard = await readVaultRegistryShard(root, bucket);
    const existingPath = shard.records[record.registryKey];
    if (existingPath !== undefined) {
      // Codexレビュー再指摘・High 1対応：既にこのkeyがregistryへ登録済み
      // （race等でこのresync自身の判定より先に他所から登録された）場合、
      // nullを返してindexから除外するのは誤り——authoritative shardには
      // 既にこのkeyのrecordが実在するため、その実entryを推測無しで返す。
      const existingEntry = shard.files[existingPath];
      if (existingEntry === undefined) {
        // records→filesの整合性が崩れている（本来あり得ない防御的分岐）。
        // 「不存在」と推測せず、5-field projectionを安全に構築できないことを
        // 明示的なfailureとしてthrowする——呼び出し元のper-record try/catchで
        // applyErrorsへ計上され、C1 establishment全体がfail-closedになる。
        throw new Error(
          `registry inconsistency: records[${record.registryKey}]=${existingPath} but files[${existingPath}] is missing`
        );
      }
      return {
        path: existingPath,
        entry: {
          recordType: existingEntry.recordType,
          mtime: existingEntry.mtime,
          size: existingEntry.size,
          contentHash: existingEntry.contentHash,
          memberIds: existingEntry.memberIds,
          memberHashes: existingEntry.memberHashes,
        },
      };
    }
    shard.records[record.registryKey] = anchorPath;
    shard.files[anchorPath] = { ...anchorEntry, status: "conflict" };
    await writeVaultRegistryShard(root, bucket, shard);
    return { path: anchorPath, entry: anchorEntry };
  });
}

/**
 * conflict outcomeの共通apply：既存registry entryがあればstatusだけ変更、
 * 無ければ`createVaultRegistryConflictAnchor`でanchorを新規作成する（race等で
 * 既に他所から登録済みだった場合はその既存entryを返す。records→filesの
 * 整合性が崩れている場合はthrowする——詳細は同関数のコメント参照）。
 * 分類・適用ロジック自体は無変更。C1（Codexレビュー指摘・High 1対応）：
 * `record.previousPath!==null`（既存entryのstatusだけ変えた）場合はnullを
 * 返す——呼び出し元は既存の`previousEntries`からそのentryを復元できるため。
 * `previousPath===null`（新規anchor作成、またはそのrace）の場合は必ず
 * `createVaultRegistryConflictAnchor`の戻り値（非null）をそのまま返す。
 */
async function applyConflictOutcome(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult
): Promise<VaultRegistryConflictAnchorCommit | null> {
  if (record.previousPath !== null) {
    await setVaultRegistryEntryStatus(root, record.registryKey, "conflict");
    return null;
  }
  return await createVaultRegistryConflictAnchor(root, record);
}

async function getExistingSingleRecordUpdatedAt(
  kind: VaultResyncSingleKind,
  id: string
): Promise<string | undefined> {
  if (kind === "conversation") return (await getConversation(id))?.updatedAt;
  if (kind === "source") return (await getSource(id))?.updatedAt;
  return (await getMemoryObject(id))?.updatedAt;
}

/**
 * Conversationのedited merge（D節）。Fをベースに、Markdown非往復fieldだけLから
 * 上書きする。day（History上の日付）が変わっている、またはturn数が異なる場合は
 * 安全に自動適用できないためnullを返す（呼び出し元がconflictへ切り替える）。
 */
function mergeConversationForApply(f: Conversation, l: Conversation): Conversation | null {
  if (f.startedAt.slice(0, 10) !== l.startedAt.slice(0, 10)) return null;
  if (f.turns.length !== l.turns.length) return null;
  const turns = f.turns.map((fTurn, i) => {
    const lTurn = l.turns[i];
    return {
      role: fTurn.role,
      content: fTurn.content,
      timestamp: lTurn.timestamp,
      webSearchRequested: lTurn.webSearchRequested,
      isRecordTurn: lTurn.isRecordTurn,
    };
  });
  return {
    ...f,
    turns,
    promptedMemoryId: l.promptedMemoryId,
    metadata: {
      ...l.metadata,
      source: f.metadata.source,
      sourceType: f.metadata.sourceType,
      sourceDetail: f.metadata.sourceDetail,
      schemaVersion: f.metadata.schemaVersion,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    },
  };
}

/**
 * Reflection/normal Memory（MemoryObject）のedited merge（D節）。dateはday部分
 * のみ比較し（frontmatterには日付のみ保存されるため）、一致する場合はLの実際の
 * date（時刻含む）を維持する。dayが変わっている場合はnullを返す（呼び出し元が
 * conflictへ切り替える。normal Memory day-fileでは、この関数に渡す前に
 * container自体の識別で既にday不一致は別経路で処理されているため、通常この
 * gateは発火しない防御的なものになる）。
 */
function mergeMemoryObjectForApply(f: MemoryObject, l: MemoryObject): MemoryObject | null {
  if (f.date.slice(0, 10) !== l.date.slice(0, 10)) return null;
  return {
    ...f,
    date: l.date,
    themeIds: l.themeIds,
    personIds: l.personIds,
    emotionIds: l.emotionIds,
    goalIds: l.goalIds,
    ideaIds: l.ideaIds,
    eventIds: l.eventIds,
    sourceId: l.sourceId,
    revisitPrompt: l.revisitPrompt,
    metadata: {
      ...l.metadata,
      source: f.metadata.source,
      sourceType: f.metadata.sourceType,
      sourceDetail: f.metadata.sourceDetail,
      aiProvider: f.metadata.aiProvider,
      confidence: f.metadata.confidence,
      schemaVersion: f.metadata.schemaVersion,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      obsidian: l.metadata.obsidian,
    },
  };
}

/** History Index更新（Conversation/Reflectionのみ。Sourceは対象外——History
 *  Indexが管理するのはConversation/Memory系であり、SourceのHistory day entryは
 *  存在しないため）。 */
async function updateHistoryIndexForSingleRecord(
  root: FileSystemDirectoryHandle,
  kind: VaultResyncSingleKind,
  parsed: Conversation | Source | MemoryObject
): Promise<void> {
  if (kind === "conversation") {
    const conversation = parsed as Conversation;
    const mode: HistoryConversationMode = conversation.persona === "companion" ? "diary" : "conversation";
    await updateHistoryIndex(root, {
      kind: "conversation",
      id: conversation.id,
      day: conversation.startedAt.slice(0, 10),
      mode,
      turnCount: conversation.turns.length,
    });
    return;
  }
  if (kind === "reflection") {
    const memoryObject = parsed as MemoryObject;
    await updateHistoryIndex(root, {
      kind: "reflection",
      id: memoryObject.id,
      day: memoryObject.date.slice(0, 10),
      preview: truncateHistoryPreview(memoryObject.summary),
      createdAt: memoryObject.createdAt,
    });
  }
  // kind === "source"：History Index対象外（呼び出し元がガードすること）。
}

/** added outcome（Conversation/Reflection/Source）のapply。 */
async function applySingleRecordAdded(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult,
  kind: VaultResyncSingleKind
): Promise<void> {
  if (
    record.currentPath === null ||
    record.parsed === null ||
    record.contentHash === null ||
    record.mtime === null ||
    record.size === null
  ) {
    throw new Error(`added outcome for ${record.registryKey} is missing required scan fields`);
  }
  const syncKey = vaultSyncKeyFor(vaultSyncKindOf(kind), record.registryKey);

  if (record.addedIndexedDbEquivalent === true) {
    // legacy-equivalent（F節）：IndexedDB本文は変更せず、vaultSyncStateの
    // baselineだけ確立する。History Indexも更新しない（IndexedDBが変わって
    // いない以上、既存のHistory Indexは既に正しいはずのため）。
    const existingUpdatedAt = await getExistingSingleRecordUpdatedAt(kind, record.registryKey);
    if (existingUpdatedAt === undefined) {
      throw new Error(`legacy-equivalent record ${record.registryKey} disappeared from IndexedDB during apply`);
    }
    await setVaultSyncState(syncKey, existingUpdatedAt);
  } else {
    // 真の新規import（E節）：Markdown非往復fieldはparserの既定値のまま取り込む
    // （Beta仕様として許容）。
    if (kind === "conversation") {
      await addConversationIfAbsentAndMarkSynced(record.parsed as Conversation, syncKey);
    } else if (kind === "source") {
      await addSourceIfAbsentAndMarkSynced(record.parsed as Source, syncKey);
    } else {
      await addMemoryObjectIfAbsentAndMarkSynced(record.parsed as MemoryObject, syncKey);
    }
    if (kind !== "source") {
      await updateHistoryIndexForSingleRecord(root, kind, record.parsed);
    }
  }

  await commitVaultRegistrySingleRecordOk(
    root,
    record.registryKey,
    record.recordType,
    record.currentPath,
    record.previousPath,
    record.mtime,
    record.size,
    record.contentHash
  );
}

/**
 * edited outcome（Conversation/Reflection/Source）のapply。日変化・turn数不一致
 * によりmergeがnullを返した場合はconflictへ切り替える（例外は投げない——これは
 * 「安全に自動適用できないと判断できた」という正常な処理結果であり、apply
 * failureではないため）。`outcome`が実際に適用されたoutcome。`anchorCommit`は
 * C1（Codexレビュー指摘・High 1対応）：conflictへ切り替わった場合に実際に
 * commitされたanchor情報（あれば）を呼び出し元へ伝える。edited成功時は常に`null`。
 */
interface VaultResyncSingleApplyResult {
  outcome: "edited" | "conflict";
  anchorCommit: VaultRegistryConflictAnchorCommit | null;
}

async function applySingleRecordEdited(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult,
  kind: VaultResyncSingleKind
): Promise<VaultResyncSingleApplyResult> {
  if (
    record.currentPath === null ||
    record.parsed === null ||
    record.contentHash === null ||
    record.mtime === null ||
    record.size === null
  ) {
    throw new Error(`edited outcome for ${record.registryKey} is missing required scan fields`);
  }

  if (kind === "source") {
    // Sourceは全フィールドが素直に往復するためmerge不要（D節）。History Index対象外。
    const f = record.parsed as Source;
    const syncKey = vaultSyncKeyFor("source", record.registryKey);
    await saveSourceAndMarkSynced(f, syncKey);
    await commitVaultRegistrySingleRecordOk(
      root,
      record.registryKey,
      record.recordType,
      record.currentPath,
      record.previousPath,
      record.mtime,
      record.size,
      record.contentHash
    );
    return { outcome: "edited", anchorCommit: null };
  }

  if (kind === "conversation") {
    const f = record.parsed as Conversation;
    const existing = await getConversation(record.registryKey);
    if (existing === undefined) {
      throw new Error(`edited conversation ${record.registryKey} missing from IndexedDB`);
    }
    const merged = mergeConversationForApply(f, existing);
    if (merged === null) {
      const anchorCommit = await applyConflictOutcome(root, record);
      return { outcome: "conflict", anchorCommit };
    }
    const syncKey = vaultSyncKeyFor("conversation", record.registryKey);
    await putConversationAndMarkSynced(merged, syncKey);
    await updateHistoryIndexForSingleRecord(root, kind, merged);
    await commitVaultRegistrySingleRecordOk(
      root,
      record.registryKey,
      record.recordType,
      record.currentPath,
      record.previousPath,
      record.mtime,
      record.size,
      record.contentHash
    );
    return { outcome: "edited", anchorCommit: null };
  }

  // reflection
  const f = record.parsed as MemoryObject;
  const existing = await getMemoryObject(record.registryKey);
  if (existing === undefined) {
    throw new Error(`edited reflection ${record.registryKey} missing from IndexedDB`);
  }
  const merged = mergeMemoryObjectForApply(f, existing);
  if (merged === null) {
    const anchorCommit = await applyConflictOutcome(root, record);
    return { outcome: "conflict", anchorCommit };
  }
  const syncKey = vaultSyncKeyFor("memory", record.registryKey);
  await putMemoryObjectAndMarkSynced(merged, syncKey);
  await updateHistoryIndexForSingleRecord(root, kind, merged);
  await commitVaultRegistrySingleRecordOk(
    root,
    record.registryKey,
    record.recordType,
    record.currentPath,
    record.previousPath,
    record.mtime,
    record.size,
    record.contentHash
  );
  return { outcome: "edited", anchorCommit: null };
}

/** Conversation/Reflection/Source（1id=1file）のapply本体。実際に適用された
 *  outcomeを返す（"edited"がday/turn数ゲートで"conflict"へ切り替わる場合がある）。
 *  C1（Codexレビュー指摘・High 1対応）：`anchorCommit`は、conflictで新規anchorが
 *  実際にcommitされた場合のみ非null（呼び出し元が推測無しでregistry-index.jsonへ
 *  反映するために使う）。 */
/** C1（Codexレビュー指摘・High 1対応）：`applySingleRecordOutcome`/
 *  `applyMemoryDayOutcome`共通の戻り値。`anchorCommit`は新規conflict anchorが
 *  実際にcommitされた場合のみ非null。呼び出し元（`applyVaultResyncScanResult`）は
 *  これとscan snapshotから、推測無しでregistry-index.jsonのentryを組み立てる。 */
interface VaultResyncApplyOutcomeResult {
  finalOutcome: VaultResyncOutcome;
  anchorCommit: VaultRegistryConflictAnchorCommit | null;
}

async function applySingleRecordOutcome(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult
): Promise<VaultResyncApplyOutcomeResult> {
  const kind = record.recordType as VaultResyncSingleKind;
  switch (record.outcome) {
    case "unchanged":
      return { finalOutcome: "unchanged", anchorCommit: null };
    case "moved": {
      if (
        record.currentPath === null ||
        record.contentHash === null ||
        record.mtime === null ||
        record.size === null
      ) {
        throw new Error(`moved outcome for ${record.registryKey} is missing required scan fields`);
      }
      await commitVaultRegistrySingleRecordOk(
        root,
        record.registryKey,
        record.recordType,
        record.currentPath,
        record.previousPath,
        record.mtime,
        record.size,
        record.contentHash
      );
      return { finalOutcome: "moved", anchorCommit: null };
    }
    case "added":
      await applySingleRecordAdded(root, record, kind);
      return { finalOutcome: "added", anchorCommit: null };
    case "edited": {
      const result = await applySingleRecordEdited(root, record, kind);
      return { finalOutcome: result.outcome, anchorCommit: result.anchorCommit };
    }
    case "missing":
      await setVaultRegistryMissing(root, record.registryKey);
      return { finalOutcome: "missing", anchorCommit: null };
    case "conflict": {
      const anchorCommit = await applyConflictOutcome(root, record);
      return { finalOutcome: "conflict", anchorCommit };
    }
    case "unreadable":
      return { finalOutcome: "unreadable", anchorCommit: null };
  }
}

/**
 * normal Memory day-fileのmember単位apply。修正2対応：1 memberが失敗/conflict
 * でも他の安全なmemberの適用は継続する。その日のHistory Indexは、member適用の
 * 成否に関わらず、処理完了後の現在のIndexedDB状態から絶対値で再構築する
 * （既存write pipelineと同じ「絶対値で置き換える」設計）。1件でも失敗があれば
 * 最後に例外を投げ、呼び出し元（`applyMemoryDayOutcome`）にcontainer
 * Registryの"ok" commitを行わせない。
 */
async function applyMemoryDayMembers(root: FileSystemDirectoryHandle, record: VaultResyncRecordResult): Promise<void> {
  const members = record.members ?? [];
  let allSucceeded = true;

  for (const member of members) {
    if (member.outcome === "unchanged") continue;
    if (member.outcome === "conflict") {
      // 修正3のmember removal等、既にconflict済みのmemberには一切触れない。
      allSucceeded = false;
      continue;
    }
    if (member.parsed === null) {
      allSucceeded = false;
      continue;
    }
    try {
      const syncKey = vaultSyncKeyFor("memory", member.id);
      if (member.outcome === "added") {
        if (member.addedIndexedDbEquivalent === true) {
          const existingUpdatedAt = (await getMemoryObject(member.id))?.updatedAt;
          if (existingUpdatedAt === undefined) {
            throw new Error(`legacy-equivalent member ${member.id} disappeared from IndexedDB during apply`);
          }
          await setVaultSyncState(syncKey, existingUpdatedAt);
        } else {
          await addMemoryObjectIfAbsentAndMarkSynced(member.parsed, syncKey);
        }
      } else if (member.outcome === "edited") {
        const existing = await getMemoryObject(member.id);
        if (existing === undefined) {
          throw new Error(`edited member ${member.id} missing from IndexedDB`);
        }
        const merged = mergeMemoryObjectForApply(member.parsed, existing);
        if (merged === null) {
          // container自体のdayとmemberのdayは4a側で既に整合済みのはずのため、
          // ここに来るのは想定外——安全側でこのmemberだけ失敗扱いにする。
          allSucceeded = false;
          continue;
        }
        await putMemoryObjectAndMarkSynced(merged, syncKey);
      } else if (member.outcome === "ledger-repair") {
        // classifyResyncMembers側で既にnormalized semantic equalityを確認済み
        // （Vault側・IndexedDB側の内容が完全に一致している）。そのため"edited"とは
        // 異なり、IndexedDB record本体（mergeMemoryObjectForApply・putMemoryObject）
        // には一切触れず、vaultSyncState台帳の再確立だけを行う（不要なrecord
        // mutationを増やさないため）。
        const existingUpdatedAt = (await getMemoryObject(member.id))?.updatedAt;
        if (existingUpdatedAt === undefined) {
          throw new Error(`ledger-repair member ${member.id} disappeared from IndexedDB during apply`);
        }
        await setVaultSyncState(syncKey, existingUpdatedAt);
      }
    } catch (error) {
      allSucceeded = false;
      console.error(`[Tsumugi] resync apply: memory-day member ${member.id} failed:`, error);
    }
  }

  // dayFileRegistryKeyの形式は"day:YYYY-MM-DD"。History Index更新にはYYYY-MM-DD部分だけ必要。
  const day = record.registryKey.startsWith("day:") ? record.registryKey.slice(4) : record.registryKey;
  const historySummaries: HistoryMemorySummary[] = [];
  for (const member of members) {
    const current = await getMemoryObject(member.id);
    if (!current) continue;
    historySummaries.push({
      id: current.id,
      types: current.types,
      preview: truncateHistoryPreview(current.summary),
      createdAt: current.createdAt,
    });
  }
  historySummaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await updateHistoryIndex(root, { kind: "memory", day, normalMemories: historySummaries });

  if (!allSucceeded) {
    throw new Error(`one or more members of day-file ${record.registryKey} failed to apply`);
  }
}

/** normal Memory day-file（container単位）のapply本体。C1（Codexレビュー指摘・
 *  High 1対応）：`applySingleRecordOutcome`と同じ`VaultResyncApplyOutcomeResult`を
 *  返す。 */
async function applyMemoryDayOutcome(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult
): Promise<VaultResyncApplyOutcomeResult> {
  switch (record.outcome) {
    case "unchanged":
      return { finalOutcome: "unchanged", anchorCommit: null };
    case "moved": {
      if (
        record.currentPath === null ||
        record.contentHash === null ||
        record.mtime === null ||
        record.size === null
      ) {
        throw new Error(`moved memory-day outcome for ${record.registryKey} is missing required scan fields`);
      }
      const memberIds = (record.members ?? []).map((m) => m.id);
      const memberHashes: Record<string, string> = {};
      for (const m of record.members ?? []) {
        if (m.parsed) memberHashes[m.id] = hashVaultText(memoryObjectToMarkdown(m.parsed));
      }
      await commitVaultRegistryMemoryDayOk(
        root,
        record.registryKey,
        record.currentPath,
        record.previousPath,
        record.mtime,
        record.size,
        record.contentHash,
        memberIds,
        memberHashes
      );
      return { finalOutcome: "moved", anchorCommit: null };
    }
    case "missing":
      await setVaultRegistryMissing(root, record.registryKey);
      return { finalOutcome: "missing", anchorCommit: null };
    case "conflict": {
      // member removal conflict含む：previous memberIds/memberHashesは
      // `createVaultRegistryConflictAnchor`/`setVaultRegistryEntryStatus`の
      // いずれも「既存entryのstatusだけ変える」または「観測済みcontentHash等で
      // 新規anchorを作る」だけであり、member removal時のrecordはStep 4a側で
      // 既にpreviousの値を保持したまま渡ってくるため、ここで上書きすることはない。
      const anchorCommit = await applyConflictOutcome(root, record);
      return { finalOutcome: "conflict", anchorCommit };
    }
    case "added":
    case "edited": {
      await applyMemoryDayMembers(root, record); // 失敗時はthrowする
      if (
        record.currentPath === null ||
        record.contentHash === null ||
        record.mtime === null ||
        record.size === null
      ) {
        throw new Error(`${record.outcome} memory-day outcome for ${record.registryKey} is missing required scan fields`);
      }
      const memberIds = (record.members ?? []).map((m) => m.id);
      const memberHashes: Record<string, string> = {};
      for (const m of record.members ?? []) {
        if (m.parsed) memberHashes[m.id] = hashVaultText(memoryObjectToMarkdown(m.parsed));
      }
      await commitVaultRegistryMemoryDayOk(
        root,
        record.registryKey,
        record.currentPath,
        record.previousPath,
        record.mtime,
        record.size,
        record.contentHash,
        memberIds,
        memberHashes
      );
      return { finalOutcome: record.outcome, anchorCommit: null };
    }
    case "unreadable":
      return { finalOutcome: "unreadable", anchorCommit: null };
  }
}

/**
 * C1（Codexレビュー指摘・High 1対応）：apply後にauthoritative Registry
 * shardへ実際に存在するentry（path/mtime/size/recordType）を、推測ではなく
 * 確定的に求める。追加I/Oは一切行わない（`previousEntries`はPhase 0で
 * 既に読み込み済み、`anchorCommit`はapply helper自身が実際にcommitした
 * 値をそのまま伝播したもの）。
 *
 * - unchanged/missing/conflict（`previousPath!==null`、＝既存entryのstatusだけ
 *   変更）：shardは書き換えられていない。apply前の既存entry（`previousEntries`、
 *   previousPathキー）がそのまま現在のauthoritative値——scanが観測した
 *   `record.mtime`/`record.size`（ファイルの最新metadata）ではない
 *   （unchangedでもmtimeだけ動いている可能性があり、それはshardに未反映のため）。
 * - moved/edited/added（成功）：`commitVaultRegistrySingleRecordOk`/
 *   `commitVaultRegistryMemoryDayOk`が実際に書き込んだ値そのもの
 *   （＝`record.currentPath`/`record.mtime`/`record.size`/`record.recordType`。
 *   これらはcommit呼び出しへ渡した引数と完全に同一）。
 * - conflict（`previousPath===null`、＝新規anchor作成）：`anchorCommit`
 *   （`createVaultRegistryConflictAnchor`が実際にcommitしたanchor path/entry）
 *   をそのまま使う。race等でanchor作成がno-opだった場合は`null`
 *   （shard上にこのkeyのrecordがまだ存在しないため、含めない）。
 * - unreadable：`null`（scan.recordsには現れない防御的分岐）。
 */
function computeFinalRegistryEntry(
  record: VaultResyncRecordResult,
  finalOutcome: VaultResyncOutcome,
  previousEntries: ReadonlyMap<string, VaultRegistryFileEntry>,
  anchorCommit: VaultRegistryConflictAnchorCommit | null
): VaultRegistryIndexEntry | null {
  switch (finalOutcome) {
    case "unchanged":
    case "missing": {
      if (record.previousPath === null) return null;
      const prev = previousEntries.get(record.previousPath);
      if (!prev) return null;
      return { path: record.previousPath, mtime: prev.mtime, size: prev.size, recordType: prev.recordType };
    }
    case "moved":
    case "edited":
    case "added": {
      if (record.currentPath === null || record.mtime === null || record.size === null) return null;
      return { path: record.currentPath, mtime: record.mtime, size: record.size, recordType: record.recordType };
    }
    case "conflict": {
      if (record.previousPath !== null) {
        // 既存entryのstatusだけがconflictへ変わった（pathはそのまま）。
        const prev = previousEntries.get(record.previousPath);
        if (!prev) return null;
        return { path: record.previousPath, mtime: prev.mtime, size: prev.size, recordType: prev.recordType };
      }
      // previousPath===null：新規anchor作成（またはrace時のno-op）。
      if (!anchorCommit) return null;
      return {
        path: anchorCommit.path,
        mtime: anchorCommit.entry.mtime,
        size: anchorCommit.entry.size,
        recordType: anchorCommit.entry.recordType,
      };
    }
    case "unreadable":
      return null;
  }
}

/**
 * Step 4aの分類結果をapplyする本体。record単位で独立して処理し、1件の失敗が
 * 他のrecordの処理を止めない（合意済み：即時全体abortより、そのrecordだけ
 * errorとして記録して次へ進む方がretry-safe）。day/turn数ゲートによる
 * "edited"→"conflict"の切り替えは正常な処理結果であり、applyErrorsには含めない
 * （countsには実際に適用されたoutcome側で計上する）。
 */
async function applyVaultResyncScanResult(
  root: FileSystemDirectoryHandle,
  scan: VaultResyncScanResult
): Promise<VaultResyncApplyResult> {
  const counts = { unchanged: 0, moved: 0, edited: 0, added: 0, missing: 0, conflict: 0, unreadable: 0 };
  const applyErrors: VaultResyncApplyError[] = [];
  const conflictDetails: VaultResyncConflictDetail[] = [];
  const missingDetails: VaultResyncMissingDetail[] = [];
  const recordOutcomes: VaultResyncApplyRecordOutcome[] = [];

  for (const record of scan.records) {
    let finalOutcome: VaultResyncOutcome;
    let anchorCommit: VaultRegistryConflictAnchorCommit | null = null;
    let failed = false;
    try {
      const result =
        record.recordType === "memory-day"
          ? await applyMemoryDayOutcome(root, record)
          : await applySingleRecordOutcome(root, record);
      finalOutcome = result.finalOutcome;
      anchorCommit = result.anchorCommit;
      counts[finalOutcome] += 1;
    } catch (error) {
      finalOutcome = record.outcome;
      failed = true;
      counts[finalOutcome] += 1;
      applyErrors.push({
        registryKey: record.registryKey,
        recordType: record.recordType,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    // C1（Codexレビュー指摘・High 1対応）：apply失敗時はshardが未変更のため、
    // unchanged/missingと同じ「apply前の既存entryをそのまま使う」ロジックで
    // finalRegistryEntryを求める（previousPathが無ければnull）。
    const finalRegistryEntry = failed
      ? computeFinalRegistryEntry(record, "unchanged", scan.previousEntries, null)
      : computeFinalRegistryEntry(record, finalOutcome, scan.previousEntries, anchorCommit);
    recordOutcomes.push({ registryKey: record.registryKey, finalOutcome, failed, finalRegistryEntry });

    // 実機不具合対応（診断情報）：分類ロジックは変更せず、最終的に確定した
    // outcomeがconflict/missingの場合だけ、既存のnote等をそのまま転記する。
    if (finalOutcome === "conflict") {
      conflictDetails.push({
        registryKey: record.registryKey,
        recordType: record.recordType,
        previousPath: record.previousPath,
        candidatePath: record.currentPath,
        reason: record.note ?? "reason not recorded",
      });
    } else if (finalOutcome === "missing") {
      missingDetails.push({
        registryKey: record.registryKey,
        recordType: record.recordType,
        previousPath: record.previousPath,
      });
    }
  }

  // Codexレビュー指摘・Step 4c対応：unreadableはrecords配列のoutcomeとしては
  // 現れない（4aの設計上、probe/parse失敗はunreadableFilesにのみ記録される）ため、
  // countsの唯一のunreadable計上経路はここ1箇所だけにする（二重countを避ける）。
  counts.unreadable = scan.unreadableFiles.length;

  return {
    scanCompleted: scan.scanCompleted,
    scannedFileCount: scan.scannedFileCount,
    counts,
    applyErrors,
    unreadableFiles: scan.unreadableFiles,
    conflictDetails,
    missingDetails,
    recordOutcomes,
  };
}

/**
 * C1（軽量Registry index・多tab安全性設計のbootstrap/rebuild foundation）：
 * apply完了後のauthoritative Registry状態から、追加のshard読み込み無しで
 * registry-index.jsonの`records`を構築する純粋関数（Vault I/Oを一切行わない）。
 *
 * 【index契約（Codexレビュー指摘・High 1対応で明確化）】registry-index.jsonは
 * 「authoritative Registry shardに存在する全known recordについて、
 * registryKey/path/mtime/size/recordTypeを保持するlightweight projection」
 * である。status="ok"限定ではない——missing/conflict/needs-resync等であっても、
 * shardにrecordが存在する限りindexにもkeyを存在させる。schemaにstatus
 * 自体は含めない（C1時点のL1/L2用途では不要なため。5-field schemaのまま）。
 *
 * 使うデータ構造は次の2つだけ（いずれも本resync実行中に既にメモリ上へ
 * 読み込み/計算済み、追加のshard読み込みは一切発生しない）：
 *   1. `scan.previousByKey`/`scan.previousEntries`：Phase 0で読み込んだ、
 *      apply前のauthoritative Registryスナップショット全体（baseline——
 *      本resyncで一切触れられなかったkeyをそのまま保持するために使う）。
 *   2. `recordOutcomes`：`applyVaultResyncScanResult`が実際にapplyした結果。
 *      各entryの`finalRegistryEntry`は、apply helper自身が実際にshardへ
 *      write/保持したentryそのもの（scan metadataからの推測ではない——
 *      `computeFinalRegistryEntry`参照）。
 *
 * 手順：まずbaseline（apply前の全体像）でrecordsを初期化する。次に、
 * 今回のresyncで実際に処理された各recordについて、`finalRegistryEntry`が
 * 非nullならその値で上書き、nullなら（shard上に対応するrecordが存在しない
 * ことが確定しているため）indexから削除する。
 */
function buildVaultRegistryIndexRecordsFromResync(
  scan: VaultResyncScanResult,
  recordOutcomes: readonly VaultResyncApplyRecordOutcome[]
): Record<string, VaultRegistryIndexEntry> {
  const records: Record<string, VaultRegistryIndexEntry> = {};

  // baseline：apply前のauthoritative Registry状態（追加I/Oなし、既読のsnapshot）。
  for (const [registryKey, path] of scan.previousByKey.entries()) {
    const entry = scan.previousEntries.get(path);
    if (!entry) continue;
    records[registryKey] = { path, mtime: entry.mtime, size: entry.size, recordType: entry.recordType };
  }

  // apply helperが実際にcommitした確定値で上書きする（推測なし）。
  for (const outcome of recordOutcomes) {
    if (outcome.finalRegistryEntry !== null) {
      records[outcome.registryKey] = outcome.finalRegistryEntry;
    } else {
      // shard上にこのkeyのrecordが存在しないことが確定している
      // （例：previousPathも無く、新規conflict anchor作成もno-opだった）。
      delete records[outcome.registryKey];
    }
  }

  return records;
}

/**
 * Step 4c公開エントリポイント：Step 4a（scan/classification）とStep 4b（apply）を
 * 1つのVault resync engineとして統合した、外部から呼ぶべき唯一の公開API。
 *
 * `startedAt`/`completedAt`はこの関数の実行区間全体（排他ロック取得前〜結果確定後）
 * を表す。`counts`は「最終的にapplyで確定したoutcome」を表す（4aの分類がday変化
 * ゲート等でapply時にconflictへ切り替わった場合、countsはconflict側に計上され、
 * 元のedited側には計上されない——`applyVaultResyncScanResult`が返す実際の
 * outcomeをそのまま使うため）。`applyErrors`はrecord単位で適用に失敗したものの
 * 記録（この場合countsは元のclassification outcome側に計上される）。
 *
 * `lastFullResyncUpdated`は、`scanCompleted===true`かつ`applyErrors.length===0`の
 * 場合にのみtrueになりうる（conflict/missingへの正常な分類・適用はそれ自体
 * エラーではないため更新を妨げない）。Low修正（Codexレビュー指摘）：この
 * flagは「meta.lastFullResyncAtが更新されたか」だけを表すものではなく、
 * このresyncが意図した確立処理全体——lastFullResyncAt/baselineEstablishedAt
 * の更新、および`previousSnapshotCompleted`がtrueの場合はC1の
 * registry-index/registryGeneration/dirtyOwnerInstanceId/
 * registryGenerationEpochの新規確立——が最後まで完了を確認できたかを表す。
 * したがって`false`は「meta.jsonの内容が一切変化していない」ことを意味
 * しない（例：index/meta writeまでは成功し、epoch bumpだけが例外を投げた
 * 場合でも`false`になる。呼び出し元はこのflagを物理的なmeta不変の証明として
 * 扱ってはならない）。registry-meta/index/epoch自体の書き込みが失敗した場合は、
 * resync全体をthrowさせず、"__registry_meta__"というsystem-level
 * `VaultResyncApplyError`として`applyErrors`へ追加し、`lastFullResyncUpdated=false`
 * のまま結果を返す（resync自体は正常に完了しているため、個別の失敗として扱う）。
 */
export interface VaultResyncResult {
  scanCompleted: boolean;
  scannedFileCount: number;
  counts: {
    unchanged: number;
    moved: number;
    edited: number;
    added: number;
    missing: number;
    conflict: number;
    unreadable: number;
  };
  applyErrors: VaultResyncApplyError[];
  unreadableFiles: VaultResyncUnreadableFile[];
  conflictDetails: VaultResyncConflictDetail[];
  missingDetails: VaultResyncMissingDetail[];
  startedAt: string;
  completedAt: string;
  lastFullResyncUpdated: boolean;
}

/**
 * C1 Step 0専用のfail-closed meta reader（Codexレビュー再指摘対応）。
 *
 * 既存の`readVaultRegistryMeta`（`readJSON`経由、getFileHandle/getFile/
 * readText/JSON.parseのいずれが失敗しても静かにempty metaへfallbackする
 * 既存の共有契約）は一切変更しない。Step 0は「安全性を確認できなければ
 * Registry mutationへ進まない」というfail-closed contractを守る必要が
 * あるため、この関数はresync専用の別経路として、真正NotFound（＝Registry
 * 未確立の正常な状態）と、それ以外の読み込み失敗（permission/SecurityError/
 * I-O error/JSON.parse失敗/構造不正）を明確に区別する：
 *   - "not-found"：`.tsumugi`または`registry-meta.json`が真正に存在しない。
 *     既存の「generation未確立」と同等に扱ってよい。
 *   - "found"：読み込み・parse・最低限の構造検証に全て成功した。
 *   - "error"：上記いずれにも該当しない失敗。安全性を確認できないため、
 *     Step 0はこの場合scan/applyへ進んではならない。
 *
 * L1/L2/L4・A1/A2・既存の他のread箇所（`readVaultRegistryMeta`自体を
 * 含む）には一切触れない——この関数はStep 0からのみ呼ばれる。
 */
type VaultRegistryMetaReadForStep0 =
  | { status: "not-found" }
  | { status: "found"; meta: VaultRegistryMeta }
  | { status: "error"; error: unknown };

/** `readVaultRegistryMetaForStep0`専用の最低限の構造検証。既存
 *  `readVaultRegistryMeta`のような型assertionだけの信頼はしない。 */
function isValidVaultRegistryMetaShape(parsed: unknown): parsed is VaultRegistryMeta {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1) return false;
  if (typeof obj.updatedAt !== "string") return false;
  if (obj.lastFullResyncAt !== null && typeof obj.lastFullResyncAt !== "string") return false;
  if (
    obj.baselineEstablishedAt !== undefined &&
    obj.baselineEstablishedAt !== null &&
    typeof obj.baselineEstablishedAt !== "string"
  ) {
    return false;
  }
  if (obj.registryGeneration !== undefined && typeof obj.registryGeneration !== "string") return false;
  if (
    obj.dirtyOwnerInstanceId !== undefined &&
    obj.dirtyOwnerInstanceId !== null &&
    typeof obj.dirtyOwnerInstanceId !== "string"
  ) {
    return false;
  }
  return true;
}

async function readVaultRegistryMetaForStep0(root: FileSystemDirectoryHandle): Promise<VaultRegistryMetaReadForStep0> {
  let tsumugiDir: FileSystemDirectoryHandle;
  try {
    tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
  } catch (error) {
    if (isVaultRegistryDirectoryNotFoundError(error)) return { status: "not-found" };
    return { status: "error", error };
  }

  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await tsumugiDir.getFileHandle("registry-meta.json", { create: false });
  } catch (error) {
    if (isVaultRegistryDirectoryNotFoundError(error)) return { status: "not-found" };
    return { status: "error", error };
  }

  try {
    const file = await fileHandle.getFile();
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    if (!isValidVaultRegistryMetaShape(parsed)) {
      return { status: "error", error: new Error("registry-meta.json failed structural validation") };
    }
    // 既存readVaultRegistryMetaと同じ正規化（undefined→null）。
    const meta: VaultRegistryMeta = {
      ...parsed,
      baselineEstablishedAt: parsed.baselineEstablishedAt ?? null,
      dirtyOwnerInstanceId: parsed.dirtyOwnerInstanceId ?? null,
    };
    return { status: "found", meta };
  } catch (error) {
    return { status: "error", error };
  }
}

/**
 * `resyncVaultRegistry(root, { requireEmptyVault: true })`のC2判定（純粋関数）。scan結果が
 * 「完走し、Registryのrecordも、tsumugiのファイルも、読めないtsumugiのファイルも無い」空のVaultなら
 * null、そうでなければ理由を返す。
 */
export function describeVaultScanNotEmptyForBaseline(
  scan: Pick<VaultResyncScanResult, "scanCompleted" | "previousSnapshotCompleted" | "previousByKey" | "records" | "unreadableFiles">
): string | null {
  if (!scan.scanCompleted) return "vault scan did not complete";
  if (!scan.previousSnapshotCompleted) return "registry snapshot was incomplete";
  if (scan.previousByKey.size > 0) return "registry already has records";
  if (scan.records.length > 0) return "vault already contains tsumugi records";
  if (scan.unreadableFiles.length > 0) return "vault contains unreadable tsumugi files";
  return null;
}

/** Step 0がRegistryへ一切触れずresyncを中止する際に返す合成結果を組み立てる。
 *  meta read失敗・invalidate失敗のいずれの経路からも同じ形を使う。 */
function buildAbortedVaultResyncApplyResult(reason: string): VaultResyncApplyResult {
  return {
    scanCompleted: false,
    scannedFileCount: 0,
    counts: { unchanged: 0, moved: 0, edited: 0, added: 0, missing: 0, conflict: 0, unreadable: 0 },
    applyErrors: [{ registryKey: "__registry_meta__", reason }],
    unreadableFiles: [],
    conflictDetails: [],
    missingDetails: [],
    recordOutcomes: [],
  };
}

export async function resyncVaultRegistry(
  root: FileSystemDirectoryHandle,
  // `requireEmptyVault`（`ensureVaultBaseline`専用）：trueの場合、scan結果が「Registryもtsumugiの
  // ファイルも無い完全に空のVault」でなければ、applyの前（Registry・IndexedDB・History Indexへ
  // 何も書く前）に中止する。省略時は従来のfull resyncと完全に同一。
  options?: { requireEmptyVault?: boolean }
): Promise<VaultResyncResult> {
  const startedAt = new Date().toISOString();

  // "tsumugi-vault-world"の排他ロックを1回だけ取得し、snapshot→scan→
  // classification→apply→registry meta更新までを同一区間内で完結させる
  // （scanとapplyの間でロックを手放さない）。この関数の内部からは
  // withVaultWorldRead/runVaultSwitchExclusive/runVaultWorldExclusiveの
  // いずれも再帰的に呼ばない（呼び出し元のscan/apply実装がそれを保証する）。
  const lockResult = await runVaultWorldExclusive(async () => {
    // Step 0（fail-closed invalidation contract、Codexレビュー再指摘対応）：
    // Registryへ一切触れる前に、現在の状態が「CLEAN」（owner===null かつ
    // registryGeneration確立済み）に見える場合、必ずここで無条件にinvalidateする。
    // meta write・epoch bumpの両方が成功して初めて、この後のapply（Registry
    // mutation）へ進んでよい——どちらか一方でも失敗したら、Registryへは一切
    // 触れず、このresync実行全体を中止する。
    //
    // 理由：「新しいfreshなindexを確立できない可能性がある状態でapplyが
    // Registryを変更してしまうと、古いindex/generationが実体と食い違ったまま
    // 『まだ有効』に見えてしまう」というfalse-freshを、事後の後始末ではなく
    // 事前の無効化で構造的に防ぐ（前回設計で見つかった「invalidate-last」の
    // 穴——安全化step自身が失敗した場合の逃げ場が無い——を、「安全化に
    // 失敗したら安全化すべき対象＝Registry mutation自体を発生させない」
    // という一段強い保証に置き換える）。
    //
    // epoch bumpも同時に必須とする理由：将来C2のOWNED_DIRTY steady-state
    // mutationは、registry lock取得後にepochだけを確認し、一致すれば
    // meta/indexを読まずにshard mutationへ進む設計になる予定。resyncが
    // このexclusive world lockを保持している間、shared world lockを要する
    // 通常mutationは構造的に開始できないため、既存zombie tabがepochを
    // 観測できる最初のタイミングは、必ずこの排他区間が完全に終わった後になる。
    // したがってStep 0でepochを少なくとも1回前進させておけば、resyncが
    // 実際にRegistryを変更し始める前に、既存zombieの古いepoch信念は
    // 必ず無効化される。
    // Codexレビュー再指摘対応：Step 0が現在の状態を正しく確認できなければ、
    // このresyncはRegistryへ一切触れてはならない。既存の`readVaultRegistryMeta`
    // （読み込み失敗を静かにempty metaへfallbackする）をStep 0で使うと、
    // 実際にはdisk上にCLEAN state（meta G_old/owner=null、index G_old）が
    // 存在するのに、一時的なI/O失敗等でempty meta（registryGeneration
    // undefined）に見えてしまい、invalidateをskipしたままscan/applyへ
    // 進んでしまう危険があった。`readVaultRegistryMetaForStep0`は
    // 真正NotFound（Registry未確立の正常な状態）とそれ以外の失敗
    // （permission/I-O/parse/構造不正）を明確に区別する。
    const preMetaRead = await readVaultRegistryMetaForStep0(root);
    if (preMetaRead.status === "error") {
      const reason = preMetaRead.error instanceof Error ? preMetaRead.error.message : String(preMetaRead.error);
      return {
        applyResult: buildAbortedVaultResyncApplyResult(
          `failed to read the current registry meta before resync (cannot confirm safety of invalidation); aborting without touching the registry: ${reason}`
        ),
        lastFullResyncUpdated: false,
      };
    }
    if (preMetaRead.status === "found" && preMetaRead.meta.dirtyOwnerInstanceId === null && preMetaRead.meta.registryGeneration !== undefined) {
      const preMeta = preMetaRead.meta;
      try {
        const invalidatedGeneration = generateVaultRegistryGeneration();
        await writeVaultRegistryMeta(root, {
          ...preMeta,
          registryGeneration: invalidatedGeneration,
          dirtyOwnerInstanceId: null,
        });
        const currentEpoch = await getRegistryGenerationEpoch();
        await bumpRegistryGenerationEpoch(currentEpoch);
      } catch (error) {
        return {
          applyResult: buildAbortedVaultResyncApplyResult(
            `failed to invalidate the existing CLEAN registry state before resync; aborting without touching the registry: ${
              error instanceof Error ? error.message : String(error)
            }`
          ),
          lastFullResyncUpdated: false,
        };
      }
    }
    // preMetaRead.status === "not-found"：既存の「generation未確立」と同等
    // （invalidateすべき既存CLEAN state自体が存在しない）。そのままscan/applyへ
    // 進んでよい。preMetaRead.status === "found"でnon-clean（既にowner有り、
    // またはMULTIPLE）だった場合も、invalidateすべきfresh state自体が
    // 存在しないため同様にそのまま進む（確定済みstate machineの通り）。

    // 既存resync behavior（変更しない）：Vault全体のdirectory enumeration
    // （Phase 1）＋apply（Step 4b）。Step 0を通過した（＝無効化が必要無かった、
    // または無効化に成功した）場合にのみここへ到達する。
    const scan = await performVaultResyncScan(root);
    if (options?.requireEmptyVault) {
      const notEmptyReason = describeVaultScanNotEmptyForBaseline(scan);
      if (notEmptyReason !== null) {
        return {
          applyResult: buildAbortedVaultResyncApplyResult(`baseline not established: ${notEmptyReason}`),
          lastFullResyncUpdated: false,
        };
      }
    }
    const applyResult = await applyVaultResyncScanResult(root, scan);

    let lastFullResyncUpdated = false;
    if (applyResult.scanCompleted && applyResult.applyErrors.length === 0) {
      try {
        // Step 0でinvalidateされた（または元々non-cleanだった）最新のmetaを
        // 読み直す。lastFullResyncAt/baselineEstablishedAtはこのresyncの
        // scan+applyが正常に完了した以上、C1のindex/generation確立が
        // 行われるかどうかとは独立して更新してよい——ただし、下記の
        // 「Step 3のepoch bump失敗時」だけは例外的にこのwriteごと行わない
        // （Codexレビュー再指摘：新しいfailure windowを増やさないため）。
        const meta = await readVaultRegistryMeta(root);
        const now = new Date().toISOString();
        meta.lastFullResyncAt = now;
        // baselineEstablishedAtは初回成功時にのみ、このresyncの`startedAt`
        // （排他ロック取得より前に確定させた時刻）で1回だけ設定する。以後の
        // resyncでは絶対に上書きしない（Registry absent recordの新規/legacy
        // 判定はこの固定境界時刻に依存するため、動かしてはいけない）。
        if (meta.baselineEstablishedAt === null) {
          meta.baselineEstablishedAt = startedAt;
        }
        meta.updatedAt = now;

        // C1（Codexレビュー指摘・High 2対応）：apply前のRegistry snapshot読み込み
        // （Phase 0：directory enumeration＋個々のshard読み込み）が一切の失敗
        // 無く完了した場合（`scan.previousSnapshotCompleted`）にのみ、新しい
        // fresh CLEANの確立を試みる。不完全なsnapshotから構築したindexを
        // 「fresh」と宣言してはならない（High 2の核心）。
        if (scan.previousSnapshotCompleted) {
          // Step 3 ordering（Codexレビュー再指摘対応）：index write → epoch bump
          // → meta CLEAN write の順で固定する。meta CLEAN write（owner=null＋
          // 新generationの確定）だけが「CLEAN publication」の唯一のcommit
          // pointであり、その直前でepoch bumpの成功を必須の前提条件とする。
          const newGeneration = generateVaultRegistryGeneration();
          const index: VaultRegistryIndex = {
            schemaVersion: 1,
            builtAtGeneration: newGeneration,
            records: buildVaultRegistryIndexRecordsFromResync(scan, applyResult.recordOutcomes),
          };
          await writeVaultRegistryIndex(root, index); // (a)

          const currentEpoch = await getRegistryGenerationEpoch();
          await bumpRegistryGenerationEpoch(currentEpoch); // (b)
          // ここへ到達できるのは(b)が成功した場合のみ。(b)が例外を投げた
          // 場合、以降のmeta更新・meta write（(c)）は一切実行されず、
          // catchへ落ちる——meta.jsonはStep 0でinvalidateされた値
          // （または元々non-cleanだった値）のまま残る（意図的：後述）。

          // C1：このresyncが確立した最新authoritative状態を表す、新しい
          // generation。dirtyOwnerInstanceIdは無条件でnull（clean）へ戻す
          // ——生きているOWNED_DIRTY ownerが存在していても、fullな
          // authoritative rebuildである以上、そのownerのmirror内容に
          // 依存せず安全に上書きできる（owner本人が居なくても正しい
          // indexを再構築できるのがexpensive rebuildの定義）。
          meta.registryGeneration = newGeneration;
          meta.dirtyOwnerInstanceId = null;
          await writeVaultRegistryMeta(root, meta); // (c) CLEAN publicationの唯一のcommit point
        } else {
          console.warn(
            "[Tsumugi] resyncVaultRegistry: registry snapshot read was incomplete; skipping registry-index/generation/epoch establishment this run (existing values preserved)."
          );
          // snapshot不完全時はregistryGeneration/dirtyOwnerInstanceIdへ一切
          // 触れない（Step 0の結果、またはnon-clean値をそのまま維持）。
          // このwriteはlastFullResyncAt等の更新のみが目的で、CLEAN
          // publicationとは無関係のため無条件に行ってよい。
          await writeVaultRegistryMeta(root, meta);
        }

        lastFullResyncUpdated = true;
      } catch (error) {
        // Codexレビュー再指摘対応：Step 3のepoch bump（(b)）が失敗した場合、
        // 上記の通りmeta write（(c)）自体に到達しないため、ここで改めて
        // meta.jsonへ何かを書き戻そうとはしない——Step 0で確立済みの
        // invalidated meta（またはnon-clean meta）をそのまま残す方が、
        // 新たなfailure window（この後始末write自体が失敗する可能性）を
        // 増やすより安全（fail-closed）である。
        //
        // Low修正（Codexレビュー指摘）：`lastFullResyncUpdated=false`は
        // 「meta.jsonが一切更新されなかった」ことを意味しない——このresyncが
        // 意図した確立処理のうち、少なくとも1ステップが完了を確認できな
        // かったことを意味するだけであり、呼び出し元はこのflagを
        // 「meta.jsonの内容が完全に不変」と解釈してはならない。
        applyResult.applyErrors.push({
          registryKey: "__registry_meta__",
          reason: `failed to establish registry meta/index/generation: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return { applyResult, lastFullResyncUpdated };
  });

  if (lockResult.timedOut) {
    throw new Error(
      "[Tsumugi] resyncVaultRegistry: could not acquire the exclusive vault-world lock in time (another vault operation may be in progress)."
    );
  }

  // timedOut===falseの場合、runVaultWorldExclusiveは必ずresultを設定して返す
  // （契約上、fnが例外なく完了した場合のみここへ到達するため）。
  const { applyResult, lastFullResyncUpdated } = lockResult.result!;
  const completedAt = new Date().toISOString();

  return {
    scanCompleted: applyResult.scanCompleted,
    scannedFileCount: applyResult.scannedFileCount,
    counts: applyResult.counts,
    applyErrors: applyResult.applyErrors,
    unreadableFiles: applyResult.unreadableFiles,
    conflictDetails: applyResult.conflictDetails,
    missingDetails: applyResult.missingDetails,
    startedAt,
    completedAt,
    lastFullResyncUpdated,
  };
}

// ---------------------------------------------------------------------------
// 軽量「外部の変更」検知フロー：Level 3（candidateのみclassification）／
// Level 4（candidateのみapply）
//
// 重要：この2つの関数はいずれも`resyncVaultRegistry`を呼ばない。したがって
// `baselineEstablishedAt`／`lastFullResyncAt`はこのフロー経由では一切更新
// されない（この2つのフィールドを書き込むコードは`resyncVaultRegistry`内の
// 1箇所だけであり、ここから到達しない）。
// ---------------------------------------------------------------------------

/**
 * Level 3：Level 1/2で得たcandidateだけを対象に、既存の`processVaultResyncCandidate`
 * （＝`handleResyncSingleRecordCandidate`／`handleResyncMemoryDayCandidate`を
 * 含む、既存classification engine）をそのまま呼ぶ。分類ロジック自体は一切
 * 変更しない。
 *
 * missing確定：`discovery.level2Completed`がtrueの場合のみ許可する（既存
 * full resyncの`scanCompleted`と同じ安全思想）。falseの場合、Level 1が
 * "path-missing"とした候補はこの回では確定させず、次回の軽量チェックへ
 * 持ち越す（既存Phase 2の「recordsByKeyにもseenKnownKeysにも無い場合だけ
 * missingにする」という判定を、Level 1/2の情報から再構成する）。
 */
/**
 * 安全性レビュー対応（H1）：Level 3 classification時点の「ローカル状態」の
 * snapshot。apply（Level 4）直前に、classification時点からIndexedDB record・
 * vaultSyncState（ledger）・Registry entryのいずれかが変化していないかを
 * 比較するために使う。`addedIndexedDbEquivalent`のように、既存apply関数が
 * 「apply時点で読み直したIndexedDBの内容をそのまま同期済みとして記録する」
 * 経路（`applySingleRecordAdded`/`applyMemoryDayMembers`、いずれも無変更）を
 * 持つため、classification時点と完全一致することを確認できたrecordだけを
 * applyへ進ませる必要がある。
 */
export interface VaultLightCheckMemberSnapshot {
  id: string;
  ledgerValue: string | undefined;
  indexedDbRecord: MemoryObject | null;
}

export interface VaultLightCheckLocalSnapshot {
  registryKey: string;
  recordType: VaultRegistryRecordType;
  /** classification時点でこのregistryKeyがRegistry上で指していたpath（無ければnull）。 */
  registryPath: string | null;
  registryContentHash: string | null;
  /** Conversation/Reflection/Sourceのみ使用。memory-dayは`memberSnapshots`を使う。 */
  ledgerValue: string | undefined;
  indexedDbRecord: Conversation | Source | MemoryObject | null;
  /** memory-dayのみ非null：その日の全member（Reflection除く）のsnapshot。 */
  memberSnapshots: VaultLightCheckMemberSnapshot[] | null;
}

async function buildVaultLightCheckLocalSnapshot(
  record: VaultResyncRecordResult,
  registrySnapshot: VaultRegistrySnapshot
): Promise<VaultLightCheckLocalSnapshot> {
  const registryPath = registrySnapshot.previousByKey.get(record.registryKey) ?? null;
  const registryEntry = registryPath !== null ? (registrySnapshot.previousEntries.get(registryPath) ?? null) : null;

  if (record.recordType === "memory-day") {
    const memberSnapshots: VaultLightCheckMemberSnapshot[] = [];
    for (const member of record.members ?? []) {
      const ledgerValue = await getVaultSyncState(vaultSyncKeyFor("memory", member.id));
      const indexedDbRecord = (await getMemoryObject(member.id)) ?? null;
      memberSnapshots.push({ id: member.id, ledgerValue, indexedDbRecord });
    }
    return {
      registryKey: record.registryKey,
      recordType: record.recordType,
      registryPath,
      registryContentHash: registryEntry?.contentHash ?? null,
      ledgerValue: undefined,
      indexedDbRecord: null,
      memberSnapshots,
    };
  }

  const kind = record.recordType as VaultResyncSingleKind;
  const ledgerValue = await getVaultSyncState(vaultSyncKeyFor(vaultSyncKindOf(kind), record.registryKey));
  let indexedDbRecord: Conversation | Source | MemoryObject | null;
  if (kind === "conversation") indexedDbRecord = (await getConversation(record.registryKey)) ?? null;
  else if (kind === "source") indexedDbRecord = (await getSource(record.registryKey)) ?? null;
  else indexedDbRecord = (await getMemoryObject(record.registryKey)) ?? null;

  return {
    registryKey: record.registryKey,
    recordType: record.recordType,
    registryPath,
    registryContentHash: registryEntry?.contentHash ?? null,
    ledgerValue,
    indexedDbRecord,
    memberSnapshots: null,
  };
}

export interface VaultLightCheckClassifyResult {
  records: VaultResyncRecordResult[];
  /** H1対応：commitを伴うoutcome（moved/edited/added）のrecordだけ、
   *  registryKeyをキーにしたローカルsnapshotを保持する。Level 4のapply直前
   *  再検証で使う。 */
  localSnapshots: Map<string, VaultLightCheckLocalSnapshot>;
  level2Completed: boolean;
  counts: {
    unchanged: number;
    moved: number;
    edited: number;
    added: number;
    missing: number;
    conflict: number;
    unreadable: number;
  };
}

/**
 * Codexレビュー指摘（M2・再レビューMedium）対応：L3専用のRegistry shard
 * **生の**読み込み結果。「物理的に何が起きたか」（正常read／shard file自体が
 * NotFound／その他I-O・JSON失敗）だけを表し、「あるregistryKeyについて
 * not-found/unconfirmedのどちらと解釈すべきか」という意味づけは含まない
 * ——同じbucketに対する生の読み取り結果は1回のL3実行内で使い回してよいが、
 * 「shard file自体がNotFound」を"not-found"と断定してキャッシュへ焼き込んで
 * しまうと、後から「実はL1でこのbucketにrecordが実在した」ことが分かった
 * 別のregistryKeyの解釈まで誤って引きずってしまう（同じbucketでも、
 * registryKeyごとにL1時点で既知だったかどうかは異なり得るため）。そのため
 * cacheには常にこの生の結果だけを保持し、意味づけは
 * `lookupCurrentRegistryEntryForL3`側でregistryKeyごとに行う。
 *
 * 既存`readVaultRegistryShard`（write経路・A1が使う）は「shardが無い／
 * registryKeyが無い／I-O失敗／JSON破損」の**いずれも**区別せず空shardへ
 * fallbackする。A1（conflict revalidation）にとっては、この空shard fallbackが
 * `currentRegistryPath !== record.previousPath`等の不一致判定を経由して
 * 「conflict-changed」等の非apply側outcomeへ倒れるため安全に機能する
 * （Codexレビュー指摘・Low対応：以前のコメントは「結果は必ず非apply側へ倒れる」
 * と断定していたが、これはA1の2関数の呼び出され方に限った話であり、write経路
 * （`writeConversationMarkdownImpl`等）が同じ空shard fallbackを受け取った場合は
 * 「Registry absent」＝真の新規record候補として扱われ、baseline gateを経て
 * 実際に書き込みへ進み得るため、一般に「必ず非apply側」とは言えない。ここでの
 * 主張はA1文脈に限定する）。missing確定のように「本当に居ないと確認できたか」
 * を要する場面では、I-O失敗を「registryKeyが存在しない」と誤認するリスクになる。
 * 既存の`readVaultRegistryShard`/`lookupVaultRegistryRecord`自体は一切変更
 * していない（A1/L4/write経路は従来通りそちらを使う）。
 */
type VaultRegistryShardRawResultL3 =
  | { status: "found"; shard: VaultRegistryShard }
  | { status: "shard-file-not-found" }
  | { status: "unconfirmed" };

async function readVaultRegistryShardForL3(root: FileSystemDirectoryHandle, bucket: number): Promise<VaultRegistryShardRawResultL3> {
  let registryDir: FileSystemDirectoryHandle;
  try {
    const tsumugiDir = await root.getDirectoryHandle(".tsumugi", { create: false });
    registryDir = await tsumugiDir.getDirectoryHandle("registry", { create: false });
  } catch (error) {
    // `.tsumugi`/`.tsumugi/registry`自体が無い場合も含め、ここでの失敗は
    // 「本当にRegistryが未確立」なのか「一時的なI-O問題」なのか区別できない
    // ため、安全側で"unconfirmed"とする（意味づけ側がfail-closedに倒す）。
    void error;
    return { status: "unconfirmed" };
  }
  const fileName = vaultRegistryBucketFileName(bucket);
  // Codexレビュー指摘（再レビューMedium 1）対応：`getFileHandle`と`getFile`を
  // 別々のtry/catchに分離する。「shard fileという名前のエントリ自体が無い」と
  // 確認できるのは`getFileHandle`のNotFoundErrorだけであり、これが
  // 「そのbucketに一度もrecordが無かった」ことを意味するか「L1→L3間でshard
  // 自体が消えた」ことを意味するかは、ここでは判断しない（`wasKnownAtL1`を
  // 使う`lookupCurrentRegistryEntryForL3`側の責務）。一方、`getFileHandle`が
  // 成功した後の`getFile`失敗（ファイルは存在するが読み取り自体に失敗した等）
  // は、shard fileの不存在を意味しないため、NotFoundErrorであっても
  // 無条件に"unconfirmed"とする——「エントリが見つからない」ことと「見つかった
  // エントリを読めない」ことを混同しない。
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await registryDir.getFileHandle(fileName, { create: false });
  } catch (error) {
    return isNotFoundError(error) ? { status: "shard-file-not-found" } : { status: "unconfirmed" };
  }
  let file: File;
  try {
    file = await fileHandle.getFile();
  } catch (error) {
    void error;
    return { status: "unconfirmed" };
  }
  try {
    const text = await file.text();
    return { status: "found", shard: JSON.parse(text) as VaultRegistryShard };
  } catch (error) {
    // 読めたがJSON parseに失敗＝壊れている可能性。「空（＝居ない）」と
    // 断定せず"unconfirmed"にする。
    void error;
    return { status: "unconfirmed" };
  }
}

async function getVaultRegistryShardRawForL3Cached(
  root: FileSystemDirectoryHandle,
  bucket: number,
  shardCache: Map<number, VaultRegistryShardRawResultL3>
): Promise<VaultRegistryShardRawResultL3> {
  const cached = shardCache.get(bucket);
  if (cached !== undefined) return cached;
  const raw = await readVaultRegistryShardForL3(root, bucket);
  shardCache.set(bucket, raw);
  return raw;
}

/**
 * Codexレビュー指摘（再レビューMedium 2）対応：`lookupCurrentRegistryEntryForL3`の
 * `found`/`not-found`/`unconfirmed`のうち、呼び出し元が安全に判断を下せるよう
 * `prefetchRegistryEntryIntoState`が返す結果の型。「見つからなかった」だけを
 * 表す旧来の戻り値（`void`）では、呼び出し元が"not-found"（＝通常のnew record
 * classificationへ進んでよい）と"unconfirmed"（＝Registry状態を確認できず
 * 進めてはいけない）を区別できなかった。
 */
type VaultRegistryLookupOutcomeL3 = "found" | "not-found" | "unconfirmed";

/**
 * 実機不具合対応（Android性能改善・A2）：L3 candidateのregistryKey 1件分を、
 * `lookupCurrentRegistryEntryForL3`（bucket計算→単一shard読み、`shardCache`
 * 経由で同一bucketの重複readを避ける）で解決し、`state.previousByKey`/
 * `state.previousEntries`へ反映する。`processVaultResyncCandidate`（無変更）が
 * 内部で行う`state.previousByKey.get(id)`/`state.previousEntries.get(path)`が、
 * 全shardを読んだ場合と同じ値を返せるようにするための事前読み込みであり、
 * 分類ロジック自体には一切関与しない。
 *
 * `wasKnownAtL1`：このregistryKeyがLevel 1時点の`discovery.allKnownKeys`に
 * 存在していたか（呼び出し元が`discovery.allKnownKeys.has(registryKey)`から
 * 判断して渡す）。shard file NotFoundの意味づけに使う（詳細は
 * `lookupCurrentRegistryEntryForL3`参照）。
 *
 * Codexレビュー指摘（再レビューMedium 2）対応：戻り値を`void`から
 * `VaultRegistryLookupOutcomeL3`へ変更した。以前は"not-found"（＝正常な
 * 「Registryに存在しない」）と"unconfirmed"（＝Registry状態を確認できない）を
 * 呼び出し元が区別できず、いずれの場合も`state`へ何も反映しないまま
 * `processVaultResyncCandidate`へ進んでいた。これは"unconfirmed"のケースで
 * 「確認できないだけ」のrecordを無条件に`previousPath === null`扱い（＝新規/
 * 通常classification対象）へ進めてしまう安全上の問題があった。呼び出し元
 * （`classifyVaultLightCheckCandidates`内の4 candidate loop）は、この戻り値が
 * "unconfirmed"の場合、`processVaultResyncCandidate`を呼ばず安全側に倒す。
 */
async function prefetchRegistryEntryIntoState(
  root: FileSystemDirectoryHandle,
  state: VaultResyncScanState,
  registryKey: string,
  wasKnownAtL1: boolean,
  shardCache: Map<number, VaultRegistryShardRawResultL3>
): Promise<VaultRegistryLookupOutcomeL3> {
  if (state.previousByKey.has(registryKey)) return "found"; // 既にprefetch済み。
  const current = await lookupCurrentRegistryEntryForL3(root, registryKey, wasKnownAtL1, shardCache);
  if (current.status !== "found") return current.status;
  state.previousByKey.set(registryKey, current.path);
  state.previousEntries.set(current.path, current.entry);
  return "found";
}

/**
 * Codexレビュー指摘（再レビューMedium 2）対応：あるcandidateについて、実際に
 * classificationの対象となる本文identityのRegistry状態が"unconfirmed"だった
 * 場合に呼ぶ。既存の`unreadableFiles`（確認不能ファイルの表現として既にある
 * 語彙）へ計上し、新しいclassification typeは追加しない。
 *
 * `keys`に渡した各registryKeyは`state.seenKnownKeys`へ追加する——このpathに
 * 何らかのTsumugi形式のfileが物理的に存在したこと自体は確認できているため
 * （negative evidence、既存`walkVaultForResync`と同じ原則）、後段のmissing
 * eliminationがこれらのkeyを「消えた」と誤って再生成しないようにするため。
 * `state.recordsByKey`へは何も設定しない（＝unchanged/moved/edited/added/
 * conflictのいずれにも分類しない。次回のlight checkサイクルで再確認される）。
 */
function recordUnconfirmedIdentitySkip(state: VaultResyncScanState, path: string, keys: readonly string[]): void {
  for (const key of keys) {
    state.seenKnownKeys.add(key);
  }
  state.unreadableFiles.push({
    path,
    reason: "light check: registry state for this record's actual content identity could not be confirmed",
  });
}

/**
 * 実機不具合対応（Android性能改善・A2）：Level 2が見つけた未知pathは、
 * ファイル内容を読むまでどのregistryKeyに対応するか分からない。この関数は
 * 「どのshardをprefetchすべきか」を知るためだけの軽量peekであり、
 * `isLikelyTsumugiFile`/`parseTsumugiResyncCandidate`（いずれも無変更、
 * `processVaultResyncCandidate`が内部で使うのと同じ関数）をそのまま呼ぶだけで、
 * 分類結果には一切影響しない。ここでの読み取りは同一`File`（既にgetFile()
 * 済みのin-memory Blob）に対する`slice().text()`/`text()`呼び出しのみのため、
 * 追加のディスク/SAF I-Oは発生しない（直後に`processVaultResyncCandidate`が
 * 同じfileへ対し独立に読み直すのは、既存の分類ロジックを一切変更しないための
 * 意図的な重複であり、性能上のコストはCPU側の文字列decodeのみ）。
 *
 * Codexレビュー指摘（M1）対応：既知path candidate（metadataChanged/
 * missingPath/readFailed）についても、`candidate.registryKey`だけを信用せず、
 * 実際に再readした本文が名乗っているidentityをこの関数で確認し、異なる場合は
 * そちらもprefetchする（呼び出し元側で実施、下記参照）。「Registry X→x.md、
 * Y→y.mdのうちx.mdの本文がYへ変更された」ケースでも、Yのregistry情報が
 * stateへ入った状態で既存`processVaultResyncCandidate`を実行できるようにする。
 *
 * 判定できない場合はnullを返し、呼び出し元はprefetchを単に省略する——「新規
 * record」side（added）へ安易に倒すのではなく、`processVaultResyncCandidate`
 * 自身が持つ既存のunreadable/unconfirmed判定（`isLikelyTsumugiFile`失敗・
 * parse失敗時はunreadableFilesへ計上、分類対象にしない）にそのまま委ねる。
 */
async function peekTsumugiResyncCandidateRegistryKey(file: File): Promise<string | null> {
  try {
    if (!(await isLikelyTsumugiFile(file))) return null;
    const text = await file.text();
    const parsed = parseTsumugiResyncCandidate(text);
    if (!parsed) return null;
    return parsed.kind === "memory-day" ? dayFileRegistryKey(parsed.day) : parsed.id;
  } catch {
    return null;
  }
}

/** `lookupCurrentRegistryEntryForL3`の結果。missing確定用のfail-closedな3値。 */
type VaultCurrentRegistryLookupL3 =
  | { status: "found"; path: string; entry: VaultRegistryFileEntry }
  | { status: "not-found" }
  | { status: "unconfirmed" };

/**
 * Codexレビュー指摘（M2・再レビューMedium対応）：あるregistryKeyの「現在の」
 * Registry状態をL3時点でfreshに確認する。生の読み取り結果
 * （`VaultRegistryShardRawResultL3`）に対して、`wasKnownAtL1`（このkeyが
 * Level 1時点の`discovery.allKnownKeys`に存在していたか）を踏まえた意味づけを
 * ここで行う：
 *
 * - 生の読み取り自体が"unconfirmed"（`.tsumugi`/registry解決失敗・I-O・
 *   JSON破損）→ 常に"unconfirmed"（known/newを問わない）。
 * - shard file自体が無い（"shard-file-not-found"）：
 *   - `wasKnownAtL1===false`（L1時点でこのkeyの存在証拠が無い。例：unknown
 *     pathから読めた完全新規のregistryKey）→ そのbucketに一度もrecordが
 *     無かった通常の"not-found"。
 *   - `wasKnownAtL1===true`（L1時点でこのbucketにこのkeyの記録が実在した）
 *     → shard file自体が消えている＝「元々空だった」のではなくL1→L3間で
 *     Registryが変化した可能性がある異常系のため、"unconfirmed"（fail-closed）。
 * - shardは読めたが`records[registryKey]`が無い：`wasKnownAtL1===true`なら、
 *   L1で見えていたrecordがL3時点で消えている変化を否定できないため
 *   "unconfirmed"とする（`wasKnownAtL1===false`なら通常通り"not-found"）。
 * - `records[registryKey]`はあるが`files[path]`が無い（registry内部の
 *   records/files不整合）：known/new問わず常に"unconfirmed"。
 *
 * `shardCache`には常に「生の読み取り結果」だけを保持し（`wasKnownAtL1`に
 * 依存する意味づけ結果はcacheしない）、同一bucketに属する別のregistryKeyが
 * 異なる`wasKnownAtL1`を持っていても、それぞれ正しく意味づけできるようにする。
 */
async function lookupCurrentRegistryEntryForL3(
  root: FileSystemDirectoryHandle,
  registryKey: string,
  wasKnownAtL1: boolean,
  shardCache: Map<number, VaultRegistryShardRawResultL3>
): Promise<VaultCurrentRegistryLookupL3> {
  const raw = await getVaultRegistryShardRawForL3Cached(root, vaultRegistryBucketOf(registryKey), shardCache);
  if (raw.status === "unconfirmed") return { status: "unconfirmed" };
  if (raw.status === "shard-file-not-found") {
    return wasKnownAtL1 ? { status: "unconfirmed" } : { status: "not-found" };
  }
  // raw.status === "found"
  const path = raw.shard.records[registryKey];
  if (path === undefined) {
    return wasKnownAtL1 ? { status: "unconfirmed" } : { status: "not-found" };
  }
  const entry = raw.shard.files[path];
  if (entry === undefined) return { status: "unconfirmed" }; // records/files不整合：安全側で確認不能扱い。
  return { status: "found", path, entry };
}

export async function classifyVaultLightCheckCandidates(
  root: FileSystemDirectoryHandle,
  discovery: VaultLightCheckDiscoveryResult
): Promise<VaultLightCheckClassifyResult> {
  const l3Start = Date.now();
  const state: VaultResyncScanState = {
    // Codexレビュー指摘（A2）対応：L1/L2終了後にRegistry全体を読み直さない。
    // `previousByKey`/`previousEntries`は最初は空で、各candidateを処理する
    // 直前に`prefetchRegistryEntryIntoState`で必要なkeyだけを都度埋める。
    previousByKey: new Map<string, string>(),
    previousEntries: new Map<string, VaultRegistryFileEntry>(),
    // L3では（旧実装でも）`walkVaultForResync`のような全体探索は行わないため、
    // このfieldは参照されない（duplicate判定は`seenPathsByKey`が担う）。
    previousRegistryKeyByPath: new Map<string, string>(),
    seenPathsByKey: new Map(),
    seenKnownKeys: new Set(),
    recordsByKey: new Map(),
    unreadableFiles: [],
    scannedFileCount: 0,
    // Level 3はcandidateだけを対象とする小さな処理のため、soft deadlineは
    // 設けない（既存`VaultResyncScanState`型の必須フィールドを満たすための
    // 形式的な値）。
    deadline: Number.POSITIVE_INFINITY,
    deadlineExceeded: false,
  };
  // 実機不具合対応（Android性能改善・A2）：この1回のclassify実行の間だけ
  // 有効な、生のshard read結果のcache。ローカル変数のため、この関数を抜ければ
  // 破棄され、次回のConfirm・別Vaultへは一切持ち越さない。candidate prefetch・
  // missing確定の両方でこの同じcacheを共有する（同一bucketの重複readを避ける）。
  // Codexレビュー指摘（再レビューMedium対応）：cacheには常に生の読み取り結果
  // （`VaultRegistryShardRawResultL3`）だけを保持し、`wasKnownAtL1`に依存する
  // not-found/unconfirmedの意味づけはcacheしない——同じbucketに属する別の
  // registryKeyがそれぞれ異なる`wasKnownAtL1`を持ち得るため。
  const shardCache = new Map<number, VaultRegistryShardRawResultL3>();

  // Level 1が"metadata-changed"とした既知pathを読み直す。registryKeyは
  // candidate自身が既に持っているため、読む前にprefetchできる（L1の
  // `discovery.allKnownKeys`由来のkeyなので`wasKnownAtL1=true`）。
  //
  // Codexレビュー指摘（M1）対応：`candidate.registryKey`だけを信用せず、実際に
  // 再readした本文が名乗っているidentityも確認する。両者が異なる場合
  // （例：Registry X→x.md、Y→y.mdのうちx.md本文がYへ変更された）、Yの
  // Registry情報もprefetchしてから既存`processVaultResyncCandidate`（無変更）
  // へ渡す——`processVaultResyncCandidate`内部が実際に使うidは本文由来のY
  // であり、Xのprefetchだけでは不十分なため。Yの`wasKnownAtL1`は
  // `discovery.allKnownKeys.has(actualKey)`から判断する（unknown pathから
  // 見つかった完全新規idならfalseになり得る）。
  for (const candidate of discovery.metadataChangedCandidates) {
    const xResult = await prefetchRegistryEntryIntoState(root, state, candidate.registryKey, true, shardCache);
    try {
      const resolved = await resolveVaultRelativePath(root, candidate.previousPath);
      const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
      const file = await fileHandle.getFile();
      const actualKey = await peekTsumugiResyncCandidateRegistryKey(file);
      let actualKeyResult: VaultRegistryLookupOutcomeL3 = xResult;
      if (actualKey !== null && actualKey !== candidate.registryKey) {
        actualKeyResult = await prefetchRegistryEntryIntoState(root, state, actualKey, discovery.allKnownKeys.has(actualKey), shardCache);
      }
      // Codexレビュー指摘（再レビューMedium 2）対応：candidate自身のkey・実際に
      // classificationへ使われるidentityのkeyのいずれかがRegistry状態を
      // 確認できない（"unconfirmed"）場合、通常classification
      // （`processVaultResyncCandidate`）へは進めない。物理ファイル自体は
      // 確認できているため、negative evidenceとしてseenKnownKeysへ加え、
      // 既存の`unreadableFiles`表現で「確認不能」を記録する。
      if (xResult === "unconfirmed" || actualKeyResult === "unconfirmed") {
        recordUnconfirmedIdentitySkip(
          state,
          candidate.previousPath,
          actualKey !== null && actualKey !== candidate.registryKey ? [candidate.registryKey, actualKey] : [candidate.registryKey]
        );
      } else {
        await processVaultResyncCandidate(root, state, candidate.previousPath, file);
      }
    } catch (error) {
      state.unreadableFiles.push({ path: candidate.previousPath, reason: `light check re-read failed: ${String(error)}` });
    }
  }

  // Level 1が"path-missing"／"read-failed"とした既知pathも、Level 3の時点で
  // 改めて1回だけ狙い撃ちで読み直す（Level 1判定からLevel 3実行までの間に
  // 復元された場合、またはLevel 1判定自体が一時的な読み取り失敗だった場合を
  // 取りこぼさないため）。読めなければ何もしない——後段のmissing確定処理へ委ねる
  // （"read-failed"は後段でseenKnownKeysへ安全側フォールバックする、下記参照）。
  // Codexレビュー指摘（M1）対応：上記と同じ理由で、本文が実際に名乗っている
  // identityもprefetchする（`wasKnownAtL1`の考え方も上記と同じ）。
  for (const candidate of [...discovery.missingPathCandidates, ...discovery.readFailedCandidates]) {
    const xResult = await prefetchRegistryEntryIntoState(root, state, candidate.registryKey, true, shardCache);
    try {
      const resolved = await resolveVaultRelativePath(root, candidate.previousPath);
      const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
      const file = await fileHandle.getFile();
      const actualKey = await peekTsumugiResyncCandidateRegistryKey(file);
      let actualKeyResult: VaultRegistryLookupOutcomeL3 = xResult;
      if (actualKey !== null && actualKey !== candidate.registryKey) {
        actualKeyResult = await prefetchRegistryEntryIntoState(root, state, actualKey, discovery.allKnownKeys.has(actualKey), shardCache);
      }
      // Codexレビュー指摘（再レビューMedium 2）対応：上記metadataChangedループと
      // 同じ理由で、いずれかのkeyが"unconfirmed"なら通常classificationへ進めない。
      if (xResult === "unconfirmed" || actualKeyResult === "unconfirmed") {
        recordUnconfirmedIdentitySkip(
          state,
          candidate.previousPath,
          actualKey !== null && actualKey !== candidate.registryKey ? [candidate.registryKey, actualKey] : [candidate.registryKey]
        );
      } else {
        await processVaultResyncCandidate(root, state, candidate.previousPath, file);
      }
    } catch {
      // 読めない：missing確定処理（後段）へ委ねる。
    }
  }

  // Level 2が見つけた未知pathを読む（新規追加、または移動先候補）。どのkeyを
  // prefetchすべきかはファイル内容を読むまで分からないため、読んだ直後に
  // `peekTsumugiResyncCandidateRegistryKey`で軽くpeekしてから、既存の
  // `processVaultResyncCandidate`（無変更）へ渡す。peekしたkeyが
  // `discovery.allKnownKeys`に無ければ（＝完全な新規record）`wasKnownAtL1=false`
  // になり、shard file NotFoundは通常のnot-foundとして扱われる。
  for (const path of discovery.unknownPathCandidates) {
    try {
      const resolved = await resolveVaultRelativePath(root, path);
      const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
      const file = await fileHandle.getFile();
      const peekedKey = await peekTsumugiResyncCandidateRegistryKey(file);
      let peekedKeyResult: VaultRegistryLookupOutcomeL3 = "not-found";
      if (peekedKey !== null) {
        peekedKeyResult = await prefetchRegistryEntryIntoState(root, state, peekedKey, discovery.allKnownKeys.has(peekedKey), shardCache);
      }
      // Codexレビュー指摘（再レビューMedium 2）対応：peekできたidentityの
      // Registry状態が"unconfirmed"なら、通常classificationへは進めない
      // （新規record・moveのいずれの可能性についても確認不能なまま進めない）。
      if (peekedKey !== null && peekedKeyResult === "unconfirmed") {
        recordUnconfirmedIdentitySkip(state, path, [peekedKey]);
      } else {
        await processVaultResyncCandidate(root, state, path, file);
      }
    } catch (error) {
      state.unreadableFiles.push({ path, reason: `light check candidate read failed: ${String(error)}` });
    }
  }

  // seenKnownKeysの再構成：Level 1がcandidate化しなかった（＝getFileHandle/
  // getFile()に成功しmtime/sizeも一致していた）registryKeyは、既存
  // walkVaultForResyncの「pathの文字列一致だけで確認済みとする」判定と同じ
  // 強さ（実際にファイルを開けたことまで確認済みであり、より強い）で
  // 「存在確認済み」として扱う。`confirmedPresentKeys`をそのまま
  // `seenKnownKeys`へ加えるだけで、Registry全体の再読み込みは不要。
  //
  // 安全性レビュー対応（M2、既存）：`readFailedCandidates`（権限/I-Oエラー等で
  // 読めなかっただけの既知path）はここでは「存在確認済み」に含めない
  // （"path-missing"と同じ扱いにはしない）。代わりに、Level 2が独立して
  // 同じpathを列挙で見つけていれば（`discovery.level2SeenKnownKeys`）、
  // その証拠だけを安全側フォールバックとして採用する——本文は読めなくても
  // 「物理的に何かが存在した」という事実は取り消さない、という既存
  // walkVaultForResyncの原則と同じ考え方。
  for (const key of discovery.confirmedPresentKeys) {
    state.seenKnownKeys.add(key);
  }
  for (const key of discovery.level2SeenKnownKeys) {
    state.seenKnownKeys.add(key);
  }

  // missing確定：既存Phase 2と同じ判定（recordsByKeyにもseenKnownKeysにも
  // 無い場合だけ）。ただしlevel2Completed===trueの場合のみ許可する。
  //
  // Codexレビュー指摘（M2）対応：対象を`discovery.allKnownKeys`（Level 1が
  // このsnapshotで見た全known key、orphan key含む）に拡張し、Registry全体の
  // 再読み込みは行わずに、missingを確定する**直前**にそのregistryKey 1件だけの
  // 現在のRegistry状態を`lookupCurrentRegistryEntryForL3`でfreshに確認する。
  // - "unconfirmed"（shard read失敗等）：現在の状態を確認できない→missingへ
  //   進めない（fail-closed、古いcandidate.previousPathへのfallbackもしない）。
  // - "not-found"（現在Registryに登録が無い）：missingとして扱う対象が無いため
  //   スキップ。
  // - "found"だがcurrent.path !== l1Path（Level 1時点のpath）：L1時点から既に
  //   pathが変わっている＝この判定はstaleなので進めない（次回のlight check
  //   サイクルへ委ねる）。
  // - "found"かつcurrent.path === l1Path：現在も同じpathを指しているため、
  //   missing recordの内容は**現在確認した**current.path/current.entry.recordType
  //   を根拠に構築する（L1 candidateの古い値は使わない）。
  if (discovery.level2Completed) {
    for (const [key, l1Path] of discovery.allKnownKeys) {
      if (state.recordsByKey.has(key)) continue;
      if (state.seenKnownKeys.has(key)) continue;
      // このループはdiscovery.allKnownKeys由来なので、常にwasKnownAtL1=true。
      const current = await lookupCurrentRegistryEntryForL3(root, key, true, shardCache);
      if (current.status === "unconfirmed") continue;
      if (current.status === "not-found") continue;
      if (current.path !== l1Path) continue;
      state.recordsByKey.set(key, {
        registryKey: key,
        recordType: current.entry.recordType,
        outcome: "missing",
        previousPath: current.path,
        currentPath: null,
        contentHash: null,
        mtime: null,
        size: null,
        members: null,
        addedIndexedDbEquivalent: null,
        note: null,
        parsed: null,
        allObservedPaths: null,
      });
    }
  }

  const records = [...state.recordsByKey.values()];
  const counts = { unchanged: 0, moved: 0, edited: 0, added: 0, missing: 0, conflict: 0, unreadable: 0 };
  for (const record of records) {
    counts[record.outcome] += 1;
  }
  counts.unreadable += state.unreadableFiles.length;

  // H1対応：commitを伴うoutcome（moved/edited/added）のrecordだけ、apply直前
  // 再検証に使うローカルsnapshotを構築する（conflict/missing/unchanged/
  // unreadableはIndexedDB/ledgerへ一切書き込まないため不要）。
  // Codexレビュー指摘（A2）対応：`buildVaultLightCheckLocalSnapshot`が必要とする
  // `previousByKey.get(record.registryKey)`/`previousEntries`は、上記の
  // candidate処理で既にprefetch済みのため、`state`（`VaultRegistrySnapshot`と
  // 同じ3 fieldを持つ）をそのまま渡せる。
  const localSnapshots = new Map<string, VaultLightCheckLocalSnapshot>();
  for (const record of records) {
    if (record.outcome === "moved" || record.outcome === "edited" || record.outcome === "added") {
      localSnapshots.set(record.registryKey, await buildVaultLightCheckLocalSnapshot(record, state));
    }
  }

  // 実機不具合対応（aggregate diagnostic）：個々のpath/idは含めず、候補件数・
  // 所要時間だけを記録する。
  // Codexレビュー指摘（Low）対応：`shardReadCount`という名前だが、実際には
  // 「成功して読めたshardの数」ではなく`shardCache.size`——このclassify実行中に
  // アクセスを試みた（＝cacheへ結果を記録した）distinctなbucket数であり、
  // "shard-file-not-found"/"unconfirmed"だったbucketも1件としてカウントされる。
  // ログの互換性を保つためfield名・出力値自体は変更しないが、この意味の違いを
  // ここに明記する。
  const candidateCount =
    discovery.metadataChangedCandidates.length +
    discovery.missingPathCandidates.length +
    discovery.readFailedCandidates.length +
    discovery.unknownPathCandidates.length;
  logTimingEvent("Vault light:L3 complete", {
    candidateCount,
    shardReadCount: shardCache.size,
    durationMs: Date.now() - l3Start,
  });

  return { records, localSnapshots, level2Completed: discovery.level2Completed, counts };
}

/**
 * Level 4 apply直前の再検証（追加条件2、および安全性レビューH1/M2対応）。
 * File System Access APIのI/Oはabort不可能なため、Level 3確認からユーザーが
 * ［変更を反映］を押すまでの間隔で状態がさらに変化した場合に備え、apply直前に
 * 対象candidateだけの狙い撃ち再確認を行う。Vault全体の再scanは行わない。
 *
 * commitを伴うoutcome（moved/edited/added）：
 * 1. new/current pathのmtime+sizeがLevel 3確認時点と一致するか。
 * 2. moved、またはpathが変化したedited（moved+edited）の場合はさらに、
 *    旧pathに対象recordが依然として存在しないかも確認する。
 * 3〜5（H1）：classification時点のローカルsnapshot（Registry entry・
 *    vaultSyncState・IndexedDB内容）と、apply直前の現在値を比較する。
 *    IndexedDB側の比較は、既存の`conversationsSemanticEqual`／
 *    `memoryObjectsSemanticEqual`／`sourcesSemanticEqual`（いずれも無変更）を
 *    そのまま再利用する——単純に`updatedAt`だけで判定しない。これにより、
 *    `applySingleRecordAdded`/`applyMemoryDayMembers`（いずれも無変更）が
 *    apply時点で読み直したIndexedDBの内容をそのまま「同期済み」として
 *    記録してしまう経路（`addedIndexedDbEquivalent`）に、classification後に
 *    変化したローカルrecordが紛れ込むことを防ぐ。
 *
 * missing outcome（M2）：apply（`setVaultRegistryMissing`）前に、旧registered
 * pathをもう一度狙い撃ちで確認する。`NotFoundError`で確認できた場合のみ
 * apply可。ファイルが復活していればstale、権限/I-Oエラー等で確認不能な
 * 場合も安全側でapply禁止にする（「読めなかった」を「存在しない」として
 * 扱わない）。
 *
 * conflict outcome（Codex監査対応・stale conflict apply防止）：`applyConflictOutcome`は
 * 実際にRegistry status="conflict"の設定・conflict anchor作成を行うため、
 * moved/edited/added/missingと同様にapply直前の再検証が必要。既存の
 * classification本体（`processVaultResyncCandidate`）を対象pathへ再度通し、
 * 「現在も同じ対象・同じpath関係・同じ理由でconflictが成立しているか」を
 * 判定する（詳細は`reverifyConflictCandidateBeforeApply`参照）。
 */
export interface VaultLightCheckStaleCandidate {
  registryKey: string;
  reason:
    | "new-path-changed"
    | "old-path-restored"
    | "registry-changed"
    | "ledger-changed"
    | "indexeddb-changed"
    | "missing-file-restored"
    | "missing-unconfirmed"
    | "conflict-resolved"
    | "conflict-changed"
    | "conflict-unconfirmed";
}

/** H1：classification時点のIndexedDB snapshotと現在値を、recordTypeに応じた
 *  既存semantic equality関数で比較する。両方nullなら不変（未存在のまま）。 */
function isLocalIndexedDbRecordUnchanged(
  recordType: VaultRegistryRecordType,
  snapshotRecord: Conversation | Source | MemoryObject | null,
  currentRecord: Conversation | Source | MemoryObject | null
): boolean {
  if (snapshotRecord === null && currentRecord === null) return true;
  if (snapshotRecord === null || currentRecord === null) return false;
  if (recordType === "conversation") return conversationsSemanticEqual(snapshotRecord as Conversation, currentRecord as Conversation);
  if (recordType === "source") return sourcesSemanticEqual(snapshotRecord as Source, currentRecord as Source);
  return memoryObjectsSemanticEqual(snapshotRecord as MemoryObject, currentRecord as MemoryObject);
}

async function reverifyMissingCandidateBeforeApply(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult
): Promise<VaultLightCheckStaleCandidate | null> {
  if (record.previousPath === null) return null; // 理論上missingは必ずpreviousPathを持つ
  try {
    const resolved = await resolveVaultRelativePath(root, record.previousPath);
    await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    // ここに到達した＝ファイルが復活していた。
    return { registryKey: record.registryKey, reason: "missing-file-restored" };
  } catch (error) {
    if (isNotFoundError(error)) return null; // 本当に存在しない：apply可。
    // 権限/I-Oエラー等で確認不能：「存在しない」と断定せず安全側でapply禁止。
    return { registryKey: record.registryKey, reason: "missing-unconfirmed" };
  }
}

/** 1pathの現在の識別結果（純粋関数、共有stateに依存しない）。conflict
 *  revalidationでのidentity確認専用に使う。 */
type VaultLightCheckPathIdentity =
  | { status: "absent" }
  | { status: "not-tsumugi" }
  | { status: "unconfirmed" }
  | { status: "identified"; registryKey: string };

/**
 * Codex監査対応（stale conflict apply防止・anchor安全性）：1pathを、既存の
 * probe（`isLikelyTsumugiFile`）＋parse（`parseTsumugiResyncCandidate`、いずれも
 * 無変更）だけを使って「現在どのregistryKeyを指しているか」を判定する。
 * `processVaultResyncCandidate`のような共有state（duplicate検出等）を経由しない
 * 純粋な1path単位の判定のため、「pathの識別が今も同じregistryKeyのままか」を
 * 他のpathの状態に影響されずに確認できる。
 *
 * `NotFoundError`だけを「確認できた不在」（absent）として扱う。権限/provider/
 * 一時I-Oエラー、probe失敗、parse失敗（`tsumugi:true`はあるが分類・parse不能）は
 * すべて`unconfirmed`とする——「読めなかった」を「存在しない」や「変わった」と
 * 断定しない（M2と同じ原則）。
 */
async function identifyVaultPathForConflictRecheck(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<VaultLightCheckPathIdentity> {
  let file: File;
  try {
    const resolved = await resolveVaultRelativePath(root, path);
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    file = await fileHandle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) return { status: "absent" };
    return { status: "unconfirmed" };
  }
  let likely: boolean;
  try {
    likely = await isLikelyTsumugiFile(file);
  } catch {
    return { status: "unconfirmed" };
  }
  if (!likely) return { status: "not-tsumugi" };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { status: "unconfirmed" };
  }
  const candidate = parseTsumugiResyncCandidate(text);
  if (!candidate) return { status: "unconfirmed" };
  const registryKey = candidate.kind === "memory-day" ? dayFileRegistryKey(candidate.day) : candidate.id;
  return { status: "identified", registryKey };
}

/** conflict中のmember（`outcome==="conflict"`）のid＋内容ハッシュの集合を、
 *  順序に依存しない署名文字列にする（`classifyResyncMembers`自身が使うのと
 *  同じ`hashVaultText(memoryObjectToMarkdown(...))`計算を再利用）。member
 *  除去（`parsed===null`）は固定マーカーで扱う。 */
function memberConflictSignature(members: VaultResyncMemberResult[] | null): string {
  return JSON.stringify(
    (members ?? [])
      .filter((m) => m.outcome === "conflict")
      .map((m) => `${m.id}:${m.parsed !== null ? hashVaultText(memoryObjectToMarkdown(m.parsed)) : "(removed)"}`)
      .sort()
  );
}

/** 指定pathのday-fileを独立して読み直し、`classifyResyncMembers`（無変更、
 *  stateを持たない純粋関数）でmember単位のconflict署名を計算する。読めない・
 *  Tsumugi形式でない・parse不能・memory-dayでない場合はnullを返す（呼び出し元が
 *  確認不能として扱う）。 */
async function memoryDayConflictSignatureAtPath(
  root: FileSystemDirectoryHandle,
  path: string,
  previousMemberHashes: Record<string, string>
): Promise<string | null> {
  try {
    const resolved = await resolveVaultRelativePath(root, path);
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    const file = await fileHandle.getFile();
    if (!(await isLikelyTsumugiFile(file))) return null;
    const text = await file.text();
    const candidate = parseTsumugiResyncCandidate(text);
    if (!candidate || candidate.kind !== "memory-day") return null;
    const memberResults = await classifyResyncMembers(candidate.members, previousMemberHashes);
    return memberConflictSignature(memberResults);
  } catch {
    return null;
  }
}

/** 指定pathのConversation/Reflection/Sourceを独立して読み直し、`hashVaultText`
 *  （`handleResyncSingleRecordCandidate`が`contentHash`に使うのと同じ計算）を
 *  返す。読めない場合はnull。 */
async function singleRecordContentHashAtPath(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  try {
    const resolved = await resolveVaultRelativePath(root, path);
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    return hashVaultText(text);
  } catch {
    return null;
  }
}

/**
 * Codex監査対応（stale conflict apply防止）：duplicate系conflict
 * （`record.allObservedPaths !== null`）専用のapply直前再検証。
 *
 * Codex監査対応（順序依存の解消）：以前はduplicateも含め、再検証対象の全path
 * を1つの共有scan stateへ通して`processVaultResyncCandidate`を繰り返し
 * 呼んでいたが、「registry既知path＋新規重複path」のような組み合わせでは、
 * `handleResyncSingleRecordCandidate`内部の`seenPathsByKey`累積・old path
 * 存在確認の副作用（存在確認できたold pathを暗黙的に「見た」ことにする）が、
 * 処理順序によって最終的な`recordsByKey`の内容を変えてしまっていた
 * （duplicateが検出されない、または`currentPath`が処理順序で変わる等）。
 * 外部変更が一切なくてもこれだけでconflict-changedになりうるため、
 * duplicate系conflictでは共有stateの再実行を一切使わない。
 *
 * Step A（path集合のidentity確認、anchor安全性）：classification時点に
 * 観測していた全path（`allObservedPaths`）について、
 * `identifyVaultPathForConflictRecheck`（stateを持たない純粋関数）で現在の
 * identityを個別に確認する。1件でも`unconfirmed`（確認不能）ならその時点で
 * 即座に`conflict-unconfirmed`とし、以降の処理・書き込みは一切行わない。
 * 「現在もrecord.registryKeyを指しているpathの集合」がclassification時点の
 * 観測path集合と完全一致しない場合（pathが減った・pathのidentityが別のkeyへ
 * 変わった等）は`conflict-changed`とする——`allObservedPaths`をそのまま
 * `applyConflictOutcome`のanchor選択（lexicographical最小）へ渡してよいのは、
 * この完全一致が確認できた場合だけ。
 *
 * Step B：Step Aでpath集合のidentityが完全一致していれば、`currentPath`の
 * 並び順（＝どのpathを最後に処理したか）だけでstaleにしない。代わりに、
 * Registryの現在の`registryKey→path`ポインタがclassification時点の
 * `previousPath`と一致すること（純粋な読み取りのみ）、および
 * `record.currentPath`（L3が実際に記録した固定値、再実行のたびに変わる値では
 * ない）自身の内容（member署名／contentHash）だけを独立して読み直し、
 * classification時点の内容と一致するかを確認する。
 */
async function reverifyDuplicateConflictBeforeApply(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult
): Promise<VaultLightCheckStaleCandidate | null> {
  const uniqueOriginalPaths = [...new Set(record.allObservedPaths ?? [])];
  if (uniqueOriginalPaths.length === 0 || record.currentPath === null) {
    return { registryKey: record.registryKey, reason: "conflict-unconfirmed" };
  }

  // Step A：path集合のidentityを個別に確認する（純粋・順序非依存）。
  const stillMatchingPaths = new Set<string>();
  for (const path of uniqueOriginalPaths) {
    const identity = await identifyVaultPathForConflictRecheck(root, path);
    if (identity.status === "unconfirmed") {
      return { registryKey: record.registryKey, reason: "conflict-unconfirmed" };
    }
    if (identity.status === "identified" && identity.registryKey === record.registryKey) {
      stillMatchingPaths.add(path);
    }
    // "absent"（NotFoundErrorで確認できた不在）・"not-tsumugi"・別のregistryKeyへの
    // 変化はいずれも「安全に確認できた変化」であり、このpathを対象集合から除外する。
  }
  const originalPathSet = new Set(uniqueOriginalPaths);
  if (stillMatchingPaths.size !== originalPathSet.size || [...originalPathSet].some((p) => !stillMatchingPaths.has(p))) {
    // classification時点のpath集合と、現在も同じidentityを持つpath集合が
    // 完全一致しない（pathが減った、またはidentityが変わった）。
    return { registryKey: record.registryKey, reason: "conflict-changed" };
  }

  // Step B：Registryの現在のポインタと内容（member署名／contentHash）を、
  // record.currentPath自身について独立して確認する（再実行の副作用に依存しない）。
  // 実機不具合対応（Android性能改善・A1）：この時点で必要なRegistry情報は
  // record.registryKey 1件分だけであり、`buildVaultRegistrySnapshot`（全shard読み）
  // ではなく`lookupVaultRegistryRecord`（bucket計算→単一shard読みのみ、
  // operation間キャッシュ無し・毎回フレッシュ）で十分に同じ情報が得られる。
  // `path`と`entry`は必ず同一のshard読み込みから得られる（`records`/`files`が
  // 同じshardファイル内にあるため）。shardが無い／registryKeyが無い／I/Oエラー
  // いずれの場合も`lookup.path`は`undefined`（＝下記`?? null`経由で`null`）に
  // なる点は`buildVaultRegistrySnapshot`使用時と同じであり、Registry lookup
  // 失敗・欠損時も既存のrevalidation semantics（`currentRegistryPath`と
  // `record.previousPath`の比較結果に応じた判定）をそのまま維持する（弱くしない）。
  const lookup = await lookupVaultRegistryRecord(root, record.registryKey);
  const currentRegistryPath = lookup.path ?? null;
  if (currentRegistryPath !== record.previousPath) {
    return { registryKey: record.registryKey, reason: "conflict-changed" };
  }
  if (record.recordType === "memory-day") {
    // currentRegistryPath === record.previousPath が確認済みのため、
    // `lookup.entry`は`previousEntries.get(record.previousPath)`と同じ値
    // （同一shardから取得済み）。
    const previousEntry = record.previousPath !== null ? (lookup.entry ?? null) : null;
    const previousMemberHashes = previousEntry?.memberHashes ?? {};
    const freshSignature = await memoryDayConflictSignatureAtPath(root, record.currentPath, previousMemberHashes);
    if (freshSignature === null) {
      return { registryKey: record.registryKey, reason: "conflict-unconfirmed" };
    }
    if (freshSignature !== memberConflictSignature(record.members)) {
      return { registryKey: record.registryKey, reason: "conflict-changed" };
    }
  } else {
    const freshHash = await singleRecordContentHashAtPath(root, record.currentPath);
    if (freshHash === null) {
      return { registryKey: record.registryKey, reason: "conflict-unconfirmed" };
    }
    if (freshHash !== record.contentHash) {
      return { registryKey: record.registryKey, reason: "conflict-changed" };
    }
  }
  return null; // 同じpath集合・同じRegistryポインタ・同じ内容：apply可。
}

/**
 * Codex監査対応（stale conflict apply防止）：duplicate以外のconflict
 * （IndexedDB既存内容との不一致／ローカル未flush変更との競合／旧path確認不能等）
 * 専用のapply直前再検証。`applyConflictOutcome`は実際にRegistry
 * status="conflict"の設定・conflict anchorの新規作成を行うため（commitを
 * 伴わない、という以前のコメントは誤りだった）、moved/edited/addedと同様に
 * apply直前の再検証が必要。
 *
 * 対象pathは常に`record.currentPath`の1つだけ（conflict outcomeでは必ず
 * 非null）。これを空のscan stateへ`processVaultResyncCandidate`（既存
 * classification本体、無変更）で通し、「今も同じ理由でconflictか」を確認する
 * （既存のprevious/current比較を維持）。1pathだけを空のstateへ通すため、
 * duplicate検出の副作用による順序依存は生じない。
 */
async function reverifyNonDuplicateConflictBeforeApply(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult
): Promise<VaultLightCheckStaleCandidate | null> {
  if (record.currentPath === null) {
    return { registryKey: record.registryKey, reason: "conflict-unconfirmed" };
  }
  // 実機不具合対応（Android性能改善・A1）：`processVaultResyncCandidate`
  // （後続の`handleResyncSingleRecordCandidate`/`handleResyncMemoryDayCandidate`）が
  // このstateから実際に読むのは`previousByKey.get(record.registryKey相当のid)`と
  // それに対応する`previousEntries`の1件だけ（`previousRegistryKeyByPath`は
  // 「1pathだけを空のseenPathsByKeyへ通す」設計上、重複判定に使われないため
  // 参照されない）。よって`buildVaultRegistrySnapshot`（全shard読み）ではなく、
  // `lookupVaultRegistryRecord`（bucket計算→単一shard読みのみ、operation間
  // キャッシュ無し・毎回フレッシュ）で得たrecord.registryKey 1件分だけを
  // 含む最小Mapで完全に同じ挙動になる。`path`と`entry`は同一shard読み込みから
  // 得られる。ファイル内容が別のidを名乗っていた場合（候補すり替わり）は、
  // 元の実装でもそのidの分類結果は`record.registryKey`とは別keyへ格納される
  // ため、後段の`state.recordsByKey.get(record.registryKey)`は元の実装でも
  // 今回の実装でも同じく見つからず"conflict-resolved"へ倒れる（挙動同値）。
  const lookup = await lookupVaultRegistryRecord(root, record.registryKey);
  const previousByKey = new Map<string, string>();
  const previousEntries = new Map<string, VaultRegistryFileEntry>();
  if (lookup.path !== undefined) {
    previousByKey.set(record.registryKey, lookup.path);
    if (lookup.entry !== undefined) {
      previousEntries.set(lookup.path, lookup.entry);
    }
  }
  const state: VaultResyncScanState = {
    previousByKey,
    previousEntries,
    previousRegistryKeyByPath: new Map<string, string>(),
    seenPathsByKey: new Map(),
    seenKnownKeys: new Set(),
    recordsByKey: new Map(),
    unreadableFiles: [],
    scannedFileCount: 0,
    deadline: Number.POSITIVE_INFINITY,
    deadlineExceeded: false,
  };
  try {
    const resolved = await resolveVaultRelativePath(root, record.currentPath);
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    const file = await fileHandle.getFile();
    const unreadableCountBefore = state.unreadableFiles.length;
    await processVaultResyncCandidate(root, state, record.currentPath, file);
    if (state.unreadableFiles.length > unreadableCountBefore) {
      return { registryKey: record.registryKey, reason: "conflict-unconfirmed" };
    }
  } catch (error) {
    // NotFoundErrorであっても、単一pathの再分類自体が成立しなくなっている
    // （＝対象recordの現在状態を再現できない）ため、安全側で確認不能扱いにする。
    void error;
    return { registryKey: record.registryKey, reason: "conflict-unconfirmed" };
  }

  const fresh = state.recordsByKey.get(record.registryKey);
  if (!fresh || fresh.outcome !== "conflict") {
    // 現在はconflictが成立していない（解消済み、または別の分類に変わった）。
    return { registryKey: record.registryKey, reason: "conflict-resolved" };
  }
  if (fresh.previousPath !== record.previousPath || fresh.currentPath !== record.currentPath) {
    return { registryKey: record.registryKey, reason: "conflict-changed" };
  }
  if (fresh.contentHash !== record.contentHash) {
    return { registryKey: record.registryKey, reason: "conflict-changed" };
  }
  // noteは補助的な追加確認として使う（一致しないことの検出専用。noteの一致
  // だけをidentity判定の根拠にはしない——上記の構造的な比較が本体）。
  if (fresh.note !== record.note) {
    return { registryKey: record.registryKey, reason: "conflict-changed" };
  }
  return null; // 現在も同じ対象・同じpath関係・同じ理由でconflictが成立している：apply可。
}

/** conflict outcomeのapply直前再検証の入口。duplicate系conflict
 *  （`allObservedPaths !== null`）とそれ以外を明確に分けて判定する
 *  （詳細は`reverifyDuplicateConflictBeforeApply`／
 *  `reverifyNonDuplicateConflictBeforeApply`参照）。 */
async function reverifyConflictCandidateBeforeApply(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult
): Promise<VaultLightCheckStaleCandidate | null> {
  if (record.allObservedPaths !== null) {
    return reverifyDuplicateConflictBeforeApply(root, record);
  }
  return reverifyNonDuplicateConflictBeforeApply(root, record);
}

async function reverifyVaultLightCheckCandidateBeforeApply(
  root: FileSystemDirectoryHandle,
  record: VaultResyncRecordResult,
  localSnapshot: VaultLightCheckLocalSnapshot | undefined
): Promise<VaultLightCheckStaleCandidate | null> {
  if (record.outcome === "missing") {
    return reverifyMissingCandidateBeforeApply(root, record);
  }
  if (record.outcome === "conflict") {
    return reverifyConflictCandidateBeforeApply(root, record);
  }
  if (record.outcome !== "moved" && record.outcome !== "edited" && record.outcome !== "added") {
    // unchanged/unreadableはMarkdown本体・IndexedDB・registry"ok"の
    // commitを一切伴わないため、apply前再検証は不要。
    return null;
  }

  // 1. new/current pathのmtime+size再検証（既存）。
  const currentPath = record.currentPath;
  const expectedMtime = record.mtime;
  const expectedSize = record.size;
  if (currentPath === null || expectedMtime === null || expectedSize === null) {
    return { registryKey: record.registryKey, reason: "new-path-changed" };
  }
  let file: File;
  try {
    const resolved = await resolveVaultRelativePath(root, currentPath);
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: false });
    file = await fileHandle.getFile();
  } catch {
    return { registryKey: record.registryKey, reason: "new-path-changed" };
  }
  if (file.lastModified !== expectedMtime || file.size !== expectedSize) {
    return { registryKey: record.registryKey, reason: "new-path-changed" };
  }

  // 2. old path再検証（move系、既存）。
  const previousPath = record.previousPath;
  if (previousPath !== null && previousPath !== currentPath && (record.outcome === "moved" || record.outcome === "edited")) {
    let presence: VaultResyncTargetedPresence;
    if (record.recordType === "memory-day") {
      const day = record.registryKey.startsWith("day:") ? record.registryKey.slice(4) : record.registryKey;
      presence = await targetedCheckMemoryDayStillAt(root, previousPath, day);
    } else {
      presence = await targetedCheckSingleRecordStillAt(
        root,
        previousPath,
        record.recordType as VaultResyncSingleKind,
        record.registryKey
      );
    }
    if (presence !== "absent") {
      return { registryKey: record.registryKey, reason: "old-path-restored" };
    }
  }

  // 3〜5. ローカル状態再検証（H1）：snapshotが無ければ（理論上起こらない想定だが）
  // 安全側でstale扱いにする。
  if (!localSnapshot) {
    return { registryKey: record.registryKey, reason: "indexeddb-changed" };
  }

  // 5. Registry側再検証：classification時点にこのregistryKeyが指していた
  // path/contentHashと、現在のRegistryを比較する。
  const currentLookup = await lookupVaultRegistryRecord(root, record.registryKey);
  const currentRegistryPath = currentLookup.entry !== undefined ? (currentLookup.path ?? null) : null;
  const currentRegistryHash = currentLookup.entry?.contentHash ?? null;
  if (currentRegistryPath !== localSnapshot.registryPath || currentRegistryHash !== localSnapshot.registryContentHash) {
    return { registryKey: record.registryKey, reason: "registry-changed" };
  }

  if (record.recordType === "memory-day") {
    for (const memberSnapshot of localSnapshot.memberSnapshots ?? []) {
      const currentLedger = await getVaultSyncState(vaultSyncKeyFor("memory", memberSnapshot.id));
      if (currentLedger !== memberSnapshot.ledgerValue) {
        return { registryKey: record.registryKey, reason: "ledger-changed" };
      }
      const currentRecord = (await getMemoryObject(memberSnapshot.id)) ?? null;
      if (!isLocalIndexedDbRecordUnchanged("memory-day", memberSnapshot.indexedDbRecord, currentRecord)) {
        return { registryKey: record.registryKey, reason: "indexeddb-changed" };
      }
    }
  } else {
    const kind = record.recordType as VaultResyncSingleKind;
    const currentLedger = await getVaultSyncState(vaultSyncKeyFor(vaultSyncKindOf(kind), record.registryKey));
    if (currentLedger !== localSnapshot.ledgerValue) {
      return { registryKey: record.registryKey, reason: "ledger-changed" };
    }
    let currentRecord: Conversation | Source | MemoryObject | null;
    if (kind === "conversation") currentRecord = (await getConversation(record.registryKey)) ?? null;
    else if (kind === "source") currentRecord = (await getSource(record.registryKey)) ?? null;
    else currentRecord = (await getMemoryObject(record.registryKey)) ?? null;
    if (!isLocalIndexedDbRecordUnchanged(record.recordType, localSnapshot.indexedDbRecord, currentRecord)) {
      return { registryKey: record.registryKey, reason: "indexeddb-changed" };
    }
  }

  return null;
}

/**
 * Level 4：Level 3の分類結果（React stateに保持されている前提）だけを対象に
 * apply直前の再検証を行い、staleでないrecordsだけを既存
 * `applyVaultResyncScanResult`（無変更）へ渡す。Vault全体の再scanはしない。
 * `resyncVaultRegistry`は呼ばないため、baselineEstablishedAt/lastFullResyncAt
 * は更新されない。
 *
 * Lock設計（安全性レビュー対応）：再検証からapplyまでを、既存full resyncと
 * 同じ`runVaultWorldExclusive`（排他ロック）の1区間で完結させる。新しい独自
 * lock体系は作らない。排他ロックだけでは「ボタンを押す前に発生したローカル
 * 変更」は検出できないため（ロック取得時点の状態しか保護しない）、上記の
 * classification時点snapshotとの比較（H1）を排他ロック区間の中で行うことで、
 * 「再検証からcommitまでの間に何も割り込めない」ことと「classification時点
 * からの変化を検出できる」ことの両方を満たす。
 */
export interface VaultLightCheckApplyOutcome {
  timedOut: boolean;
  counts: {
    unchanged: number;
    moved: number;
    edited: number;
    added: number;
    missing: number;
    conflict: number;
    unreadable: number;
  };
  applyErrors: VaultResyncApplyError[];
  staleSkipped: VaultLightCheckStaleCandidate[];
}

const EMPTY_VAULT_LIGHT_CHECK_COUNTS = { unchanged: 0, moved: 0, edited: 0, added: 0, missing: 0, conflict: 0, unreadable: 0 };

export async function applyVaultLightCheckCandidates(
  root: FileSystemDirectoryHandle,
  records: VaultResyncRecordResult[],
  localSnapshots: Map<string, VaultLightCheckLocalSnapshot>
): Promise<VaultLightCheckApplyOutcome> {
  const lockResult = await runVaultWorldExclusive(async () => {
    const applicable: VaultResyncRecordResult[] = [];
    const staleSkipped: VaultLightCheckStaleCandidate[] = [];

    for (const record of records) {
      const stale = await reverifyVaultLightCheckCandidateBeforeApply(root, record, localSnapshots.get(record.registryKey));
      if (stale) {
        staleSkipped.push(stale);
        continue;
      }
      applicable.push(record);
    }

    const applyResult = await applyVaultResyncScanResult(root, {
      scanCompleted: true,
      scannedFileCount: applicable.length,
      records: applicable,
      unreadableFiles: [],
      // C1でVaultResyncScanResultへ追加したfield。L4（light check apply）は
      // 個別candidateの適用のみを行い、full resyncのようなbaseline snapshotを
      // 持たない（そもそも持つ必要が無い——applyVaultResyncScanResultはこの
      // 3 fieldを一切参照しない。resyncVaultRegistry側のindex構築でのみ使う）。
      // 空Map・trueを渡すのみで、L4の分類・適用ロジックには一切影響しない。
      previousByKey: new Map(),
      previousEntries: new Map(),
      previousSnapshotCompleted: true,
    });

    return { counts: applyResult.counts, applyErrors: applyResult.applyErrors, staleSkipped };
  });

  if (lockResult.timedOut) {
    return { timedOut: true, counts: { ...EMPTY_VAULT_LIGHT_CHECK_COUNTS }, applyErrors: [], staleSkipped: [] };
  }
  const { counts, applyErrors, staleSkipped } = lockResult.result!;
  return { timedOut: false, counts, applyErrors, staleSkipped };
}
