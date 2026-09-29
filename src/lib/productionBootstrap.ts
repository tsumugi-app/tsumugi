/**
 * Production Bootstrap Wiring（新保存基盤 Phase 3-8）。
 *
 * `runSaveFoundationBootstrap`（Phase 3-7）をapp startupから安全に呼ぶための薄い
 * wrapper。ChatScreen.tsx側は「Vault handleが使用可能になった後、1回だけこれを呼ぶ」
 * だけでよく、以下をこのファイルが引き受ける：
 *
 * - single-flight（req 6・req 16-K）：同時に複数回呼ばれても
 *   （React StrictMode二重実行・複数effectからの呼び出し等）、進行中のbootstrapが
 *   あればそれをそのまま返すだけで、2つ目の実行を新たに開始しない。
 * - Storage Persistence診断（req 15）：`getStoragePersistenceDiagnostics()`を
 *   fire-and-forgetで呼ぶ。失敗・unsupported・`persist()`がfalseでもbootstrap自体は
 *   一切止めない（保存correctnessの前提にしない。Phase 3-7で確立した性質をそのまま
 *   踏襲）。
 * - debug observability（req 14）：`?debugLog=1`のときだけ、identity result・
 *   migration summary（record type別の件数のみ）・reconcile/integrity結果を
 *   console出力する。個人情報・会話本文・record ID一覧は一切出力しない
 *   （出すのは`{idbOnly, vaultOnly, bothSame, legitimateSuccessor, conflict,
 *   unreadable}`のような数値集計と`{done, pending, held, failed}`集計のみ）。
 *
 * bootstrap自体の失敗（`runSaveFoundationBootstrap`が例外を投げるケース——通常は
 * 発生しない設計だが、想定外のIndexedDBエラー等）はここでcatchし、ログのみで
 * 飲み込む。呼び出し元（ChatScreen.tsx）のUI初期表示・会話送信を一切ブロックしない
 * （req 6「bootstrap失敗でアプリ全体を起動不能にしない」）。
 */
import { runSaveFoundationBootstrap, type SaveFoundationBootstrapResult } from "./saveFoundationBootstrap";
import { getStoragePersistenceDiagnostics } from "./storagePersistence";
import { debugLogEnabled } from "./generationDebugLog";

type BootstrapFn = (root: FileSystemDirectoryHandle) => Promise<SaveFoundationBootstrapResult>;

const defaultBootstrapFn: BootstrapFn = (root) => runSaveFoundationBootstrap({ root });

let inFlight: Promise<SaveFoundationBootstrapResult | null> | null = null;

/**
 * `root`（Vault handle）が使用可能になった後に呼ぶ。`bootstrapFn`はテスト専用の
 * differential injection（既定は実際の`runSaveFoundationBootstrap`）。
 *
 * 例外を投げない——bootstrap自体が失敗しても`null`を返すだけで、呼び出し元
 * （ChatScreen.tsx startup useEffect）が追加のtry/catchを持たなくても安全に
 * fire-and-forgetできる。
 */
export async function runProductionBootstrapOnce(
  root: FileSystemDirectoryHandle,
  bootstrapFn: BootstrapFn = defaultBootstrapFn
): Promise<SaveFoundationBootstrapResult | null> {
  if (inFlight) return inFlight;
  const promise = executeBootstrap(root, bootstrapFn).finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

/** テスト専用：single-flightのin-flight状態をテスト間で持ち越さないためのリセット。本番コードからは呼ばない。 */
export function __resetProductionBootstrapInFlightForTests(): void {
  inFlight = null;
}

async function executeBootstrap(root: FileSystemDirectoryHandle, bootstrapFn: BootstrapFn): Promise<SaveFoundationBootstrapResult | null> {
  // Storage Persistence診断（req 15）：bootstrap本体とは独立にfire-and-forgetで行う。
  // persist()が使えない・falseでもbootstrap本体には一切影響させない。
  void getStoragePersistenceDiagnostics()
    .then((diagnostics) => {
      if (debugLogEnabled()) console.log("[SaveFoundation] storage persistence diagnostics", diagnostics);
    })
    .catch((error) => {
      console.error("[SaveFoundation] storage persistence diagnostics failed (diagnostic only, does not affect save correctness)", error);
    });

  try {
    const result = await bootstrapFn(root);
    if (debugLogEnabled()) logBootstrapSummary(result);
    return result;
  } catch (error) {
    console.error("[SaveFoundation] bootstrap failed; app startup continues (canonical IndexedDB remains usable, next startup will retry)", error);
    return null;
  }
}

function logBootstrapSummary(result: SaveFoundationBootstrapResult): void {
  // 個人情報・会話本文・record ID一覧は一切出力しない（数値集計のみ）。
  console.log("[SaveFoundation] bootstrap summary", {
    identity: result.identity.kind,
    migration: result.migration && {
      conversation: result.migration.summary,
      memory: result.migration.memorySummary,
      reflection: result.migration.reflectionSummary,
      source: result.migration.sourceSummary,
    },
    reconcile: result.reconcile,
    integrity: result.integrity,
    finalReconcile: result.finalReconcile,
  });
}
