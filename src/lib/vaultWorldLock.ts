/**
 * Vault境界の安全性（H4：複数タブ間でのVault privacy boundary）。
 *
 * 単一タブ内の安全性（H1〜H3、isVaultSwitchingRef/pendingMemoryTasksRef/
 * vaultGenerationRef、ChatScreen.tsx）はタブごとに独立したReact state/refであり、
 * 別タブの変化を一切観測できない。IndexedDBはタブ間で共有されるため、
 * 「古いタブが、現在activeではないVaultのMemoryを読む／別Vaultへ書く」という
 * 事故が構造的に成立してしまう。
 *
 * ここでは`navigator.locks`（Web Locks API）と、IndexedDB `settings`ストアへ
 * 保存する単調増加のepochカウンタ（db.tsのgetActiveVaultEpoch/bumpActiveVaultEpoch）
 * を組み合わせ、「今のMemory World操作が、今アクティブなVaultの世代と一致しているか」を
 * 各操作の直前に必ず確認する。ロック名は単一（"tsumugi-vault-world"）：
 *   - 通常のRead/Write操作（Retrieval/Capture/Connect/Import/Restore等）は共有ロック。
 *   - 別Vaultへの切替コミットは排他ロック。
 * 共有ロック同士は同時に何個でも許可されるが、排他ロックは他の共有/排他ロックが
 * 一切無い間だけ許可されるため、「切替の最中に他タブが読み書きする」
 * 「読み書きの最中に切替が割り込む」の両方を構造的に防げる。
 *
 * デッドロック回避の大原則（重要）：この名前のロックは、既にそのロックを保持している
 * 同じタブの実行コンテキストの中から、決して再要求（ネスト）しないこと。Web Locksは
 * FIFO＋書き込み優先のセマンティクスを持つため、「共有ロックを保持したまま同名の
 * 共有ロックを再要求する」だけでも、その間に別タブの排他ロック要求が割り込むと
 * 自己デッドロックしうる。このファイルの各関数を使う側は、ロックで包んだ関数の内部から
 * 同じ種類のロック付き関数を呼ばないこと（＝「Impl版」を直接呼ぶこと）。
 *
 * BroadcastChannelは安全性の根拠には使わない（UXの即時通知のみ）。実際の安全性は
 * 必ず「操作の直前に共有ストレージのepochを読み直して比較する」ことだけで担保する
 * （タブがsleep中でBroadcastChannelを逃しても、次に何か操作しようとした瞬間に
 * 正しく検出できるようにするため）。
 */
"use client";

import {
  bumpActiveVaultEpoch,
  getActiveVaultEpoch,
  getCommittedVaultEpoch,
  getVaultWorldJournalVersion,
  markVaultEpochCommitted,
  markVaultWorldJournalMigrated,
} from "./db";

const LOCK_NAME = "tsumugi-vault-world";
/** 排他ロック（Vault切替）取得の安全なタイムアウト。他タブがsleep中などで応答が
 * 無くても、無期限に待たず「安全側＝切替中止」へ倒すためのフェイルセーフ。 */
const EXCLUSIVE_LOCK_TIMEOUT_MS = 15000;
const BROADCAST_CHANNEL_NAME = "tsumugi-vault-epoch";

export class StaleVaultTabError extends Error {
  constructor(message = "このタブの保存先は、別のタブでの変更により古くなっています。") {
    super(message);
    this.name = "StaleVaultTabError";
  }
}

/**
 * Codexレビュー指摘（journal lifecycle）対応：`activeVaultEpoch`と
 * `committedVaultEpoch`が一致しない（＝直前のVault切替が完了しないまま終了した
 * 形跡がある）場合に、Memory World操作を拒否するためのエラー。`StaleVaultTabError`
 * （＝別タブが切り替えた"だけ"で、このタブがそれを知らない状態）とは意味が異なる
 * ため区別する——こちらは「どのタブから見ても、今のworldの状態自体が不確定」を表す。
 * ChatScreen.tsx側は`vaultStatus`を"incomplete-switch"へ設定し、専用の再接続
 * recoveryフローへ誘導する（通常のcrossTabStale「再読み込みしてください」バナーとは
 * 別扱いにする——再読み込みだけでは直らないため）。
 */
export class IncompleteVaultWorldError extends Error {
  constructor(message = "保存先の切替が完了していません。保存先を選び直してください。") {
    super(message);
    this.name = "IncompleteVaultWorldError";
  }
}

/**
 * このタブが「自分は今このVault世代にいる」と信じているepoch。
 * - 起動時：activeVaultEpochの取得とVault handle復元を同一の共有ロック内で行った
 *   直後に設定する（vaultVaultHandleGeneration===tabEpochの不変条件はここで確定する）。
 * - 自タブ自身が別Vaultへの切替を完了させた直後（排他ロック内、epoch更新の直後）にも
 *   更新する（自分の切替直後に自分自身をstaleと誤判定しないため）。
 * それ以外のタイミングでは書き換えない。
 */
let tabVaultEpoch: number | null = null;

export function getTabVaultEpoch(): number | null {
  return tabVaultEpoch;
}

export function setTabVaultEpoch(epoch: number): void {
  tabVaultEpoch = epoch;
}

function locksSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks !== "undefined";
}

/**
 * 生のロック取得（epoch確認は一切行わない、内部専用）。`navigator.locks`が使えない
 * 環境（対象外の古いブラウザ等）では、ロックを取らずにそのままfnを実行する
 * （epoch確認自体は呼び出し元＝withVaultWorldRead/runVaultSwitchExclusiveが別途行うため、
 * ロックが無くても「確認せず素通り」にはならない。ロックが無い環境ではタブ間排他は
 * 保証できないが、それは対象ブラウザの範囲外の劣化として許容する）。
 */
async function withRawLock<T>(
  mode: "shared" | "exclusive",
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!locksSupported()) return fn();
  return navigator.locks.request(LOCK_NAME, { mode, signal }, fn);
}

/**
 * 通常のMemory World READ/WRITE操作用。共有ロックを取得し、その中で
 * activeVaultEpoch（共有IndexedDB）を読み直し、自タブが信じているepochと
 * 一致するかを確認してからfnを実行する。
 * - epoch/journalが読めない（IndexedDBエラー等） → fail-safeとして拒否（StaleVaultTabError）。
 * - tabVaultEpochが未確定（起動時のスナップショットがまだ済んでいない） → 拒否。
 * - tabVaultEpoch !== activeVaultEpoch（別タブが切り替えた等） → 拒否（StaleVaultTabError）。
 * - activeVaultEpoch !== committedVaultEpoch（journal未確定/不整合＝直前のswitchが
 *   完了しないまま終了した形跡） → 拒否（IncompleteVaultWorldError）。
 * - vaultWorldJournalVersionがcurrent以外（missing/unexpected） → 拒否
 *   （IncompleteVaultWorldError）。Codexレビュー指摘（Medium：unexpected version
 *   core guard）対応：以前はcommitted===activeさえ成立すれば、version自体が
 *   unexpectedでも（tab===active===committedの3つが偶然揃えば）通ってしまう
 *   隙間があった。正常操作条件を「tabEpoch===activeEpoch AND
 *   committed.status===valid AND committedEpoch===activeEpoch AND
 *   journalVersion.status===current」の4条件全てへ拡張する。
 *   Codexレビュー指摘（journal lifecycle、High）対応：UIガード（vaultStatus等）だけに
 *   依存せず、Memory World操作の共通入口自体でこれを確認する。
 * fnを呼ぶのはこれら全てを通過した場合のみ。
 *
 * 呼び出し元がこの関数の"内部"から、同じ名前のロックを再要求しないこと
 * （デッドロック回避。上のファイル冒頭コメント参照）。
 */
export async function withVaultWorldRead<T>(fn: () => Promise<T>): Promise<T> {
  return withRawLock("shared", async () => {
    let sharedEpoch: number;
    let committedStatus: Awaited<ReturnType<typeof getCommittedVaultEpoch>>;
    let versionStatus: Awaited<ReturnType<typeof getVaultWorldJournalVersion>>;
    try {
      sharedEpoch = await getActiveVaultEpoch();
      committedStatus = await getCommittedVaultEpoch();
      versionStatus = await getVaultWorldJournalVersion();
    } catch (error) {
      console.error(
        "[Tsumugi] failed to read activeVaultEpoch/committedVaultEpoch/vaultWorldJournalVersion, refusing Memory World operation:",
        error
      );
      throw new StaleVaultTabError("保存先の状態を確認できなかったため、操作を中止しました。");
    }
    if (tabVaultEpoch === null || sharedEpoch !== tabVaultEpoch) {
      throw new StaleVaultTabError();
    }
    if (versionStatus.status !== "current") {
      throw new IncompleteVaultWorldError();
    }
    if (committedStatus.status !== "valid" || committedStatus.epoch !== sharedEpoch) {
      throw new IncompleteVaultWorldError();
    }
    return fn();
  });
}

/**
 * 起動時専用：activeVaultEpochの取得とVault handle復元（restoreVaultHandle）を、
 * 同一の共有ロック保持区間の中で行うためのラッパー。fn自身がgetActiveVaultEpoch()・
 * restoreVaultHandle()・setTabVaultEpoch()を呼ぶ（tabVaultHandleGeneration===tabEpochの
 * 不変条件が成立する所以）。epoch確認（一致するかどうかの判定）はここでは行わない
 * （このタイミングでは"確認"ではなく"確定"を行うため）。
 */
export async function withStartupSharedLock<T>(fn: () => Promise<T>): Promise<T> {
  return withRawLock("shared", fn);
}

export interface VaultSwitchExclusiveResult<T> {
  timedOut: boolean;
  result?: T;
}

/**
 * Codexレビュー指摘High（再発）対応：`ctx.timedOutAlready()`を毎回読み直すだけの
 * 方式は、「読んだ直後（まだfalse）〜実際にcommitを終えるまで」の間にタイマーが
 * 割り込むTOCTOUを残していた（UIは`{timedOut:true}`を返したのに、その後の
 * awaitの最中に裏でcommitが完了してしまう）。ここでは明示的な状態機械にする：
 *
 *   preparing → committing → finished
 *            \→ timed-out
 *
 * - "preparing"→"timed-out"、"preparing"→"committing"の遷移は、どちらも
 *   「今のphaseがpreparingか」を確認してからphaseを書き換える、という
 *   *同期的な*1手順（間にawaitを挟まない）でしか行わない。JSはシングルスレッドで
 *   awaitを挟まない処理の途中に他のコードが割り込むことはないため、この2つの
 *   遷移は構造的に排他になる（後から読み直す形のTOCTOUチェックを再導入しない）。
 * - 一度"committing"に入ったら、その後にタイマーが発火しても何もしない
 *   （UIへtimeoutを返さない。fnが実際に完了するのを待ち、その結果をそのまま
 *   UIへ返す＝UI-facingな結果と内部commit結果が食い違わない）。
 * - 一度"timed-out"になったら、その後fnが（まだcommitを始めていなければ）
 *   何をしても結果はUIへ伝わらない。
 */
type VaultSwitchPhase = "preparing" | "committing" | "timed-out" | "finished";

/**
 * fnへ渡すコンテキスト。`beginCommit()`は、activeVaultEpochの更新・IndexedDBの
 * clear・新Vault handleの保存など「取り消せない副作用」を開始する直前に、
 * fnが必ず一度だけ呼ぶこと。
 * - 戻り値がtrueの場合のみ、実際にcommitを行ってよい（以後、このrunVaultSwitchExclusive
 *   呼び出しがUIへ`{timedOut:true}`を返すことは無い。fnが返す結果がそのままUIへ返る）。
 * - falseの場合（＝呼び出し時点で既にtimed-outへ遷移済み）は、それらの副作用を
 *   一切行わずに中止すること（呼び出し元は既にこの切替を諦めているため、今さら
 *   バックグラウンドで成立させると、画面表示とストレージの実状態が食い違ってしまう）。
 * この呼び出し自体がphaseの遷移を同期的に確定させるため、呼び出し元は
 * 「呼ぶ→（awaitを挟まず）戻り値で分岐する」という順序を守ること。
 */
export interface VaultSwitchExclusiveContext {
  beginCommit: () => boolean;
}

/**
 * 別Vaultへの切替コミット専用：排他ロックを取得し、fnを実行する。
 *
 * 「呼び出し元（UI）へいつ結果を返すか」と「実際に排他ロックを保持しfnを実行し続ける
 * 期間」を分離する。timeoutMsが経過してもfnが"committing"へ入っていなければ、
 * 呼び出し元へ直ちに`{timedOut: true}`を返す——ただしfn自体の実行・排他ロックの
 * 保持は中断しない。fnが実際に完了する（成功・失敗いずれか）まで、引き続き
 * 排他ロックを保持し続ける（他タブの共有/排他ロック取得は、fnが実際に終わるまで
 * 正しく待たされ続ける）。逆に、fnが既に`ctx.beginCommit()`で"committing"へ入って
 * いた場合は、以後タイマーが発火してもUIへtimeoutを返さない——fnの実際の結果を
 * 待って、それをそのままUIへ返す。
 *
 * ロック取得待ちの間に（まだfn自体が一度も呼ばれる前に）timeoutが先に成立していた
 * 場合、後からロックが取得できても、fn自体を一切呼び出さない（old-world flush・
 * queue drain・epoch read等を不要に開始しない）。
 *
 * `timeoutMs`省略時は`EXCLUSIVE_LOCK_TIMEOUT_MS`（他タブがsleep中などでロック取得
 * 自体が進まない場合の既定フェイルセーフ）。呼び出し元が既により短い/長い締切
 * （例：既存の収束待ちフェーズの残り時間）を持っている場合はそれを渡せる。
 *
 * `navigator.locks`が使えない環境では、タブ間の排他を保証できないため、実行せず
 * timedOut扱いにする（安全側）。
 */
export function runVaultSwitchExclusive<T>(
  fn: (ctx: VaultSwitchExclusiveContext) => Promise<T>,
  timeoutMs: number = EXCLUSIVE_LOCK_TIMEOUT_MS
): Promise<VaultSwitchExclusiveResult<T>> {
  if (!locksSupported()) {
    console.error("[Tsumugi] navigator.locks is unavailable; refusing cross-tab vault switch for safety.");
    return Promise.resolve({ timedOut: true });
  }

  let phase: VaultSwitchPhase = "preparing";
  let settleOuter: ((value: VaultSwitchExclusiveResult<T>) => void) | null = null;
  let failOuter: ((error: unknown) => void) | null = null;
  const outer = new Promise<VaultSwitchExclusiveResult<T>>((resolve, reject) => {
    settleOuter = resolve;
    failOuter = reject;
  });

  const ctx: VaultSwitchExclusiveContext = {
    beginCommit: () => {
      // 同期的な1手順（間にawaitを挟まない）：この判定と書き換えの間に他の
      // コードが割り込むことは無い（JSはシングルスレッド）。
      if (phase !== "preparing") return false;
      phase = "committing";
      return true;
    },
  };

  const timer = setTimeout(() => {
    // 同様に同期的な1手順。既に"committing"（またはそれ以降）へ遷移済みなら、
    // ここでは何もしない（＝UIへtimeoutを返さない。fnの実際の完了を待つ）。
    if (phase === "preparing") {
      phase = "timed-out";
      settleOuter!({ timedOut: true });
    }
  }, timeoutMs);

  void navigator.locks
    .request(LOCK_NAME, { mode: "exclusive" }, async () => {
      // ロック取得待ちの間に既にtimed-outへ遷移していた場合、fn自体を一切呼ばない
      // （old-world flush・queue drain・epoch read/bump・clear・handle保存等の
      // 一切を不要に開始しない）。
      if (phase === "timed-out") return undefined;
      return fn(ctx);
    })
    .then((result) => {
      clearTimeout(timer);
      if (phase === "timed-out") {
        // 既にUIへtimeoutを返し終えている（fnはbeginCommit()を呼ばずに、または
        // 呼ぶ前にここへ来た＝committingへは入っていない）。UIへは何も伝えない。
        return;
      }
      phase = "finished";
      settleOuter!({ timedOut: false, result: result as T });
    })
    .catch((error) => {
      clearTimeout(timer);
      if (phase === "timed-out") {
        // 呼び出し元へは既にtimeout結果を返し終えている。ここで投げ直しても
        // 誰にも拾われずunhandled rejectionになるだけなので、ログにだけ残す。
        console.error(
          "[Tsumugi] vault switch exclusive task failed after timeout was already reported to caller:",
          error
        );
        return;
      }
      phase = "finished";
      failOuter!(error);
    });

  return outer;
}

export {
  getActiveVaultEpoch,
  bumpActiveVaultEpoch,
  getCommittedVaultEpoch,
  markVaultEpochCommitted,
  getVaultWorldJournalVersion,
  markVaultWorldJournalMigrated,
};
export type { CommittedVaultEpochStatus, VaultEpochStatus, VaultWorldJournalVersionStatus } from "./db";

// ---------------------------------------------------------------------------
// BroadcastChannel：UXの即時通知専用（安全性の根拠には使わない）。
// ---------------------------------------------------------------------------

interface VaultSwitchedMessage {
  type: "vault-switched";
  epoch: number;
}

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    } catch (error) {
      console.error("[Tsumugi] failed to open BroadcastChannel (UX notification only, safety unaffected):", error);
      return null;
    }
  }
  return channel;
}

/** 別Vaultへの切替コミット成功直後（排他ロックの中、epoch更新の直後）に呼ぶ。
 * 失敗しても安全性には一切影響しない（他タブへのUX即時通知が届かないだけ）。 */
export function notifyVaultSwitched(epoch: number): void {
  try {
    const message: VaultSwitchedMessage = { type: "vault-switched", epoch };
    getChannel()?.postMessage(message);
  } catch (error) {
    console.error("[Tsumugi] failed to broadcast vault switch notification (UX only):", error);
  }
}

/** 他タブでのVault切替をUX通知目的だけで購読する。戻り値の関数で購読解除する。 */
export function subscribeVaultSwitchNotifications(onSwitch: (epoch: number) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const handler = (event: MessageEvent<VaultSwitchedMessage>) => {
    if (event.data && event.data.type === "vault-switched" && typeof event.data.epoch === "number") {
      onSwitch(event.data.epoch);
    }
  };
  ch.addEventListener("message", handler);
  return () => ch.removeEventListener("message", handler);
}
