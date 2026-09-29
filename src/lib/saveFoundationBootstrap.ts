/**
 * Save Foundation Bootstrap（新保存基盤 Phase 3-7 req 7、Phase 3-7.1でdone
 * integrity検証を追加）。
 *
 * Production接続直前の統合API。1回の呼び出しで、
 *   identity確認／必要ならlegacy adoption・resume
 *   → Production Bootstrap Migration（resume可能、Phase 3-5/3-6/3-7拡張）
 *   → pending outboxのunified reconcile（Conversation/Memory/Reflection/Source）
 *   → done outboxのintegrity検証（Phase 3-7.1：doneのまま実体が欠落・破損した
 *     recordを自動修復する。詳細は`vaultProjection.ts`の
 *     `reconcileDoneVaultOutboxIntegrity`のdoc comment参照）
 *   → 追加reconcile（migration/reconcile/integrityの間に生じた取りこぼしの
 *     最終確認、有限回）
 * を順に行い、「あるべき状態」へ収束させる。
 *
 * 重要（req 8）：`baselineEstablishedAt`を正常処理のgateとして一切使わない
 * （legacy baselineは既存旧コードの互換情報として残るのみ）。内部で呼ぶ
 * `runProductionBootstrapMigration`／`reconcilePendingVaultOutbox`のいずれも
 * baselineを参照しない（Phase 3-3〜3-6で既に確認済みの性質を、そのまま
 * 引き継ぐだけで成立する）。
 *
 * 重要（req 10）：identity・migration・各recordのreconcileはそれぞれ独立した
 * 呼び出しであり、1件のConversation/Memory/Reflection/Sourceのretryable
 * failure・genuine conflictが、他recordの成功済み状態を巻き戻すことは無い
 * （このファイル自身は何もrollbackしない——各層が既にrecord単位で
 * 独立に完結する設計になっているため、単に順番に呼ぶだけでこの性質を
 * 引き継げる）。
 *
 * 重要（req 16）：この関数を複数回呼んでも同じ状態へ収束する。identity・
 * migration・reconcileはいずれも個別にidempotentであることが既にPhase
 * 3-4/3-5/3-6/3-7のtestで確認済みであり、それらを単純に順次呼ぶだけの
 * このBootstrap自身も、2回目以降は（新しいcanonical更新が無い限り）
 * 実質no-opになる。
 *
 * まだ本番からは呼ばれない（app startup・ChatScreen等には一切接続しない。
 * Phase 3-7はlibrary＋testまで）。
 */
import { getVaultIdentityRecord } from "./db";
import { ensureVaultIdentityForCurrentWorld, type VaultIdentityEnv, type VaultIdentityEnsureResult } from "./vaultIdentityAdoption";
import { runProductionBootstrapMigration, type ProductionMigrationResult } from "./vaultProductionMigration";
import { reconcilePendingVaultOutbox, reconcileDoneVaultOutboxIntegrity, type ReconcileAllRecordTypesResult, type ProjectionEnv } from "./vaultProjection";

// ---------------------------------------------------------------------------
// req 1（内部順序の最初のstep）：Bootstrap自身の再入防止用exclusive lock。
//
// 既存の"tsumugi-vault-world"（H4、`vaultWorldLock.ts`）は、複数タブ間の
// epoch整合性チェック（`tabVaultEpoch`）と一体になっており、実際のタブの
// 起動シーケンス（`withStartupSharedLock`でepochを確定させる）を経ていない
// 状態から呼ぶと必ず`StaleVaultTabError`になる。Phase 3-7はまだapp startupへ
// 接続しない（library＋testまで）ため、本物のH4 epoch統合はProduction接続時に
// 行うこととし、ここではBootstrap呼び出し自体の同時実行を防ぐための、
// 別名・専用のexclusive lockだけを用意する（既存の"tsumugi-vault-world"・
// "tsumugi-vault-registry-write"・"tsumugi-history-index-write"・
// Phase 3-6の"tsumugi-projection-memory-dayfile:*"のいずれとも異なる名前）。
// ---------------------------------------------------------------------------

const BOOTSTRAP_LOCK_NAME = "tsumugi-save-foundation-bootstrap";

function isLockSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks !== "undefined";
}

async function withBootstrapLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!isLockSupported()) return fn();
  return navigator.locks.request(BOOTSTRAP_LOCK_NAME, fn);
}

export interface SaveFoundationBootstrapEnv {
  root: FileSystemDirectoryHandle;
  now?: () => string;
  /** テスト・DI用。既定は`crypto.randomUUID()`（`ensureVaultIdentityForCurrentWorld`に委譲）。 */
  generateVaultId?: () => string;
}

export interface SaveFoundationBootstrapResult {
  identity: VaultIdentityEnsureResult;
  /**
   * identityが`identified`／`newly-paired`以外（`held`／`unrelated`／`unreadable`）の
   * 場合はnull——req 11：identity conflict／unrelated Vault／読めない状態は
   * Recoveryの領分であり、この状態のままmigration/reconcileを進めて誤った
   * Vaultへ書き込む経路を作らない。
   */
  migration: ProductionMigrationResult | null;
  reconcile: ReconcileAllRecordTypesResult | null;
  /** Phase 3-7.1：done outboxのintegrity検証結果（`reconcileDoneVaultOutboxIntegrity`）。 */
  integrity: ReconcileAllRecordTypesResult | null;
  /** req 9：最終rescan後の追加reconcile（1回だけ。無限loopにしない）。 */
  finalReconcile: ReconcileAllRecordTypesResult | null;
}

export async function runSaveFoundationBootstrap(env: SaveFoundationBootstrapEnv): Promise<SaveFoundationBootstrapResult> {
  return withBootstrapLock(async () => {
    // 2. Vault identity確認。
    // 3. 必要ならlegacy adoption/resume（`ensureVaultIdentityForCurrentWorld`自身が
    //    empty/legacy/identified/indeterminateの分類・safe-to-adopt判定・
    //    候補vaultIdの durable な確定までを行う。Phase 3-4で実装・test済み）。
    const identityEnv: VaultIdentityEnv = { root: env.root, now: env.now, generateVaultId: env.generateVaultId };
    const identity = await ensureVaultIdentityForCurrentWorld(identityEnv);

    if (identity.kind !== "identified" && identity.kind !== "newly-paired") {
      // req 11：Recoveryへ残すもの（identity conflict／unrelated Vault／読めない
      // 状態）。ここでmigration/reconcileを一切実行しない——1byteも書かない。
      return { identity, migration: null, reconcile: null, integrity: null, finalReconcile: null };
    }

    const vaultIdentityRecord = await getVaultIdentityRecord();
    const projectionEnv: ProjectionEnv = { root: env.root, vaultIdentity: vaultIdentityRecord ?? null, now: env.now };

    // 4. Production migration/resume（req 8：baseline null／derived metadata欠落を
    //    一切blocking conditionにしない。req 9：migration自身の内部rescanで
    //    実行中に増えたcanonical recordを取りこぼさない。Phase 3-5/3-6/3-7で
    //    実装・test済み）。
    const migration = await runProductionBootstrapMigration({ root: env.root, now: env.now });

    // 5. pending outboxのreconcile（Conversation/Memory/Reflection/Source全種別。
    //    1件のheld/conflictが他recordの処理を止めない。req 10）。
    const reconcile = await reconcilePendingVaultOutbox(projectionEnv);

    // Phase 3-7.1：done outboxのintegrity検証。「doneだから見ない」は禁止
    // （Phase 3-7.1 req 4）——`status`に関わらず、done entry全件についても
    // 実際にVault実体（Markdown・Registry・History・index）が今なお整合している
    // ことを、既存のreconcile*OutboxEntry関数を再利用してそのつど確認する。
    // 実体が既に正しいrecordは、各stepの既存no-op検出により1byteも書き込まれない
    // （Phase 3-7.1 req 3-F）。
    const integrity = await reconcileDoneVaultOutboxIntegrity(projectionEnv);

    // 6. final rescanはmigration自身の内部rescanで既に完結している。
    // 7. 必要なら追加outbox reconcile：migrationの最終rescan・reconcile・
    //    done integrity検証の間に生じうる取りこぼし（例：一時I/Oエラーからの
    //    retry対象、integrity検証がRegistry等の欠落を検出しつつも一時的な書込
    //    エラーでpendingへ落ちたrecord）を、もう一度だけ確認する。無限loopに
    //    しない（req 9）——ここでの追加はたかだか1回。それでも収束しない分は
    //    pendingのまま次回のBootstrap呼び出し（＝次回startup）へ委ねる。
    const finalReconcile = await reconcilePendingVaultOutbox(projectionEnv);

    // 8. summary返却。
    return { identity, migration, reconcile, integrity, finalReconcile };
  });
}
