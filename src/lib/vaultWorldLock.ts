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

import { bumpActiveVaultEpoch, getActiveVaultEpoch } from "./db";

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
 * - epochが読めない（IndexedDBエラー等） → fail-safeとして拒否（StaleVaultTabError）。
 * - tabVaultEpochが未確定（起動時のスナップショットがまだ済んでいない） → 拒否。
 * - 不一致 → 拒否。
 * fnを呼ぶのはこれら全てを通過した場合のみ。
 *
 * 呼び出し元がこの関数の"内部"から、同じ名前のロックを再要求しないこと
 * （デッドロック回避。上のファイル冒頭コメント参照）。
 */
export async function withVaultWorldRead<T>(fn: () => Promise<T>): Promise<T> {
  return withRawLock("shared", async () => {
    let sharedEpoch: number;
    try {
      sharedEpoch = await getActiveVaultEpoch();
    } catch (error) {
      console.error("[Tsumugi] failed to read activeVaultEpoch, refusing Memory World operation:", error);
      throw new StaleVaultTabError("保存先の状態を確認できなかったため、操作を中止しました。");
    }
    if (tabVaultEpoch === null || sharedEpoch !== tabVaultEpoch) {
      throw new StaleVaultTabError();
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
 * 別Vaultへの切替コミット専用：排他ロックを取得し、タイムアウト付きでfnを実行する。
 * タイムアウトした場合は必ず`{timedOut: true}`を返す（「安全確認なしで先へ進める」ことは
 * 絶対にしない。呼び出し元は切替を中止し、旧Vaultを維持したままロックを解放すること）。
 * `navigator.locks`が使えない環境では、タブ間の排他を保証できないため、実行せず
 * timedOut扱いにする（安全側）。
 */
export async function runVaultSwitchExclusive<T>(fn: () => Promise<T>): Promise<VaultSwitchExclusiveResult<T>> {
  if (!locksSupported()) {
    console.error("[Tsumugi] navigator.locks is unavailable; refusing cross-tab vault switch for safety.");
    return { timedOut: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCLUSIVE_LOCK_TIMEOUT_MS);
  try {
    const result = await navigator.locks.request(
      LOCK_NAME,
      { mode: "exclusive", signal: controller.signal },
      fn
    );
    return { timedOut: false, result };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { timedOut: true };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export { getActiveVaultEpoch, bumpActiveVaultEpoch };

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
