/**
 * Connect処理状態の管理（ROADMAP.md Phase 2）。
 *
 * 「Connectを試みたかどうか」はMemoryObjectの内容ではなくアプリ内部の処理進捗であるため、
 * MemoryObject型にもMarkdownのfrontmatterにも書き込まない。STORAGE.mdの`.tsumugi/index.json`と
 * 同じ位置づけの、再構築可能な内部管理データとしてIndexedDBのみで持つ。
 *
 * 完了記録（"done"）だけでは、React StrictModeによるuseEffectの二重実行や複数タブからの
 * 同時実行を防げない（両方とも「まだ処理されていない」時点を同時に観測してしまうため）。
 * そのため`tryClaimMemoryForConnect`で「開始前のクレーム」を取り、実際にAIを呼ぶのは
 * クレームに成功した1回だけにする。
 */
"use client";

import {
  claimConnectState,
  getConnectStateRecords,
  markConnectStateDone,
  releaseConnectState,
} from "./db";
import type { MemoryObject } from "./types";

/** クレームしたまま完了しなかった処理（クラッシュ等）を、再クレーム可能にするまでの猶予時間。 */
const CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * idのConnect処理を開始してよいか。trueが返った呼び出し元だけが実際にAIを呼んでよい。
 * falseの場合、既に他の呼び出し（別のeffect実行・別タブ）が処理中か完了済みなので、
 * 何もせずそのまま戻ってよい。
 */
export async function tryClaimMemoryForConnect(id: string): Promise<boolean> {
  return claimConnectState(id, CLAIM_STALE_AFTER_MS);
}

export async function markMemoryConnected(id: string): Promise<void> {
  await markConnectStateDone(id);
}

/** Connect処理が失敗したときに呼ぶ。クレームを解放し、次回のキャッチアップで再試行できるようにする。 */
export async function releaseMemoryConnectClaim(id: string): Promise<void> {
  await releaseConnectState(id);
}

export async function filterUnconnected(memories: MemoryObject[]): Promise<MemoryObject[]> {
  const records = await getConnectStateRecords();
  return memories.filter((memory) => {
    const record = records[memory.id];
    if (!record) return true;
    // 旧形式（このクレーム方式を導入する前の値）は常に完了済み扱いにする。
    if (typeof record === "string") return false;
    return record.status !== "done";
  });
}
