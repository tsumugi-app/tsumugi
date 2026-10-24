"use client";

import { useCallback, useEffect, useState } from "react";
import {
  acceptOutboxDivergence, deleteConversationByUser, deleteConversationWithMemoriesByUser, deleteMemoryByUser, getAllConversations, getAllMemoryObjects,
  listOutboxNeedingAttention, listTombstones, loadVaultHandle, removeOrphanOutboxEntry, retryOutboxEntry,
  type AttentionEntry, type Tombstone,
} from "@/lib/db";
import { allowBack, findRecordInVault, keepVaultCopy, purgeDecision, purgeEligibleTombstones, verifyTombstone } from "@/lib/dataLifecycle";
import { getVaultBackend } from "@/lib/vault";
import { isRecoveryBlockingNormalWrites } from "@/lib/vaultRecoveryJournal";
import type { Conversation, MemoryObject } from "@/lib/types";

/**
 * データの管理（/data）。ユーザー自身が、記憶・会話を削除し、同期が止まった項目（保留・競合）を解決し、削除済みの記録の後始末をする画面。
 * ChatScreen・Capture・Connect・起動処理は一切動かさない（この画面だけで完結）。何も自動では削除しない：すべてボタン操作（二段階確認つき）。
 * Vaultのファイルはこの画面から削除しない（読み取りの確認だけ）。
 */
const REASONS: Record<string, string> = {
  "vault-identity-mismatch": "保存先が、この端末が使っていた保存先と別のものに見えます",
  "canonical-record-missing": "同期する対象の記録が、この端末にありません",
};
const reasonText = (e: AttentionEntry) =>
  e.status === "pending" ? `同期を${e.attempts}回試しましたが、完了していません` : (e.heldReason && REASONS[e.heldReason]) || "保存先のファイルと内容が食い違っているなどの理由で、同期を止めています";
const kindLabel = (t: string) => (t === "conversation" ? "会話" : t === "reflection" ? "ふりかえり" : t === "source" ? "素材" : "記憶");
const tail = (id: string) => id.slice(-6);
const snippet = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

export default function DataReviewPanel() {
  const [attention, setAttention] = useState<AttentionEntry[]>([]);
  const [memories, setMemories] = useState<MemoryObject[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [tombstones, setTombstones] = useState<Tombstone[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [withMemories, setWithMemories] = useState(false);

  const load = useCallback(async () => {
    try {
      setBlocked(await isRecoveryBlockingNormalWrites());
      setAttention(await listOutboxNeedingAttention());
      setMemories((await getAllMemoryObjects()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setConversations((await getAllConversations()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setTombstones(await listTombstones());
    } catch (e) { setMessage("読み込めませんでした: " + ((e as Error)?.name ?? "error")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setMessage(null); setConfirming(null);
    try { setMessage(await fn()); } catch (e) { const n = (e as Error)?.name ?? "error"; setMessage(n === "RecoveryPendingError" ? "メンテナンス中、または復旧が必要な状態のため、今はできません。" : n === "TombstonedRecordError" ? "削除済みの記録のため、できません。" : "できませんでした: " + n); }
    finally { setBusy(false); await load(); }
  }
  async function vaultRoot(): Promise<FileSystemDirectoryHandle | null> {
    // the app's own (origin-private) storage is the Vault on devices without a folder picker: its root is not a stored handle
    if (getVaultBackend() === "opfs") { try { return await navigator.storage.getDirectory(); } catch { return null; } }
    const h = await loadVaultHandle();
    if (!h) return null;
    const p = (await (h as unknown as { requestPermission?: (o: { mode: string }) => Promise<string> }).requestPermission?.({ mode: "read" })) ?? "granted";
    return p === "granted" ? h : null;
  }

  const q = filter.trim().toLowerCase();
  const shownMemories = memories.filter((m) => !q || m.summary.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)).slice(0, 30);
  const shownConversations = conversations.filter((c) => !q || (c.turns.find((t) => t.role === "user")?.content ?? "").toLowerCase().includes(q)).slice(0, 30);
  const now = new Date().toISOString();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-8 text-sm text-stone-700 dark:text-stone-200">
      <h1 className="text-lg font-medium">データの管理</h1>
      <p className="text-xs text-stone-500">ここでの操作は、すべてあなたの操作でだけ行われます。何も自動では削除しません。保存先（Vault）のファイルは、この画面からは削除しません。</p>
      {blocked && <p role="alert" className="rounded border border-amber-400 px-3 py-2 text-amber-700">メンテナンス中、または復旧が必要な状態のため、削除と解決はできません。</p>}
      {message && <p role="status" className="rounded border border-stone-300 px-3 py-2">{message}</p>}

      <section aria-labelledby="attention-h" className="flex flex-col gap-3">
        <h2 id="attention-h" className="font-medium">確認が必要な項目 ({attention.length})</h2>
        {attention.length === 0 && <p className="text-xs text-stone-500">同期が止まっている項目はありません。</p>}
        <ul className="flex flex-col gap-3">
          {attention.map((e) => (
            <li key={e.id} className="flex flex-col gap-2 rounded border border-stone-300 px-3 py-2">
              <p>{kindLabel(e.recordType)} …{tail(e.recordId)}：{reasonText(e)}</p>
              <p className="text-xs text-stone-500">{e.recordExists ? "この端末には記録があります。" : "この端末に記録がありません。"}{e.tombstoned ? " 削除済みとして記録されています。" : ""}</p>
              <div className="flex flex-wrap gap-2">
                {e.recordExists && <button disabled={busy || blocked} className="border px-2 py-1" onClick={() => void act(async () => ((await retryOutboxEntry(e.id)) === "retried" ? "もう一度同期を試す状態にしました。" : "項目が見つかりませんでした。"))}>再試行</button>}
                {e.recordExists && <button disabled={busy || blocked} className="border px-2 py-1" onClick={() => void act(async () => {
                  const root = await vaultRoot();
                  if (!root) return "保存先（Vault）を読めないため、この操作はできません。保存先に記録があることを確認できないと、同期を終了できません。";
                  if ((await findRecordInVault(root, e.recordId)) !== "present") return "保存先に、この記録のコピーが見つかりません。このまま同期を終了すると、この端末の記録が保存先に残らなくなるため、できません。「もう一度試す」を使ってください。";
                  const r = await acceptOutboxDivergence(e.id, { vaultCopyVerified: true, seenOutboxUpdatedAt: e.updatedAt });
                  return r === "accepted" ? "この端末と保存先をそのままにして、同期を終了しました。" : r === "changed" ? "確認している間に、この項目が更新されました。もう一度内容を確認してください。" : "できませんでした。";
                })}>両方そのままにする</button>}
                {e.recordExists && e.recordType !== "source" && confirming !== `del:${e.id}` && <button disabled={busy || blocked} className="border px-2 py-1" onClick={() => setConfirming(`del:${e.id}`)}>この端末から削除…</button>}
                {e.recordExists && confirming === `del:${e.id}` && (<>
                  <span className="text-red-700">本当に削除しますか？</span>
                  <button disabled={busy || blocked} className="border border-red-700 px-2 py-1 text-red-700" onClick={() => void act(async () => {
                    const r = e.recordType === "conversation" ? await deleteConversationByUser(e.recordId) : await deleteMemoryByUser(e.recordId);
                    return r.status === "deleted" ? "削除しました。" : "見つかりませんでした。";
                  })}>削除する</button>
                  <button className="border px-2 py-1" onClick={() => setConfirming(null)}>やめる</button>
                </>)}
                {!e.recordExists && e.recordType !== "source" && <button disabled={busy || blocked} className="border px-2 py-1" onClick={() => void act(async () => ((await removeOrphanOutboxEntry(e.id, { tombstone: true })) === "removed" ? "削除済みとして整理しました。保存先に残っていても、この端末には戻りません。" : "できませんでした。"))}>削除済みとして整理</button>}
                {!e.recordExists && <button disabled={busy || blocked} className="border px-2 py-1" onClick={() => void act(async () => ((await removeOrphanOutboxEntry(e.id)) === "removed" ? "この項目だけを整理しました。" : "できませんでした。"))}>この項目だけ整理</button>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="delete-h" className="flex flex-col gap-3">
        <h2 id="delete-h" className="font-medium">記憶・会話を削除する</h2>
        <label className="text-xs">絞り込み <input aria-label="絞り込み" className="border px-2 py-1" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        <h3 className="text-xs text-stone-500">記憶 ({memories.length})</h3>
        <ul className="flex flex-col gap-2">
          {shownMemories.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded border border-stone-300 px-3 py-2">
              <span className="min-w-0 flex-1">{snippet(m.summary)} <span className="text-xs text-stone-400">…{tail(m.id)}</span></span>
              {confirming !== `m:${m.id}` ? <button disabled={busy || blocked} className="border px-2 py-1" onClick={() => setConfirming(`m:${m.id}`)}>削除…</button> : (<>
                <span className="text-red-700">この記憶を削除します。リンクも外れます。</span>
                <button disabled={busy || blocked} className="border border-red-700 px-2 py-1 text-red-700" onClick={() => void act(async () => { const r = await deleteMemoryByUser(m.id); return r.status === "deleted" ? `削除しました（つながっていた記憶 ${r.countersUpdated} 件のリンクを外しました）。` : "見つかりませんでした。"; })}>削除する</button>
                <button className="border px-2 py-1" onClick={() => setConfirming(null)}>やめる</button>
              </>)}
            </li>
          ))}
        </ul>
        <h3 className="text-xs text-stone-500">会話 ({conversations.length})</h3>
        <ul className="flex flex-col gap-2">
          {shownConversations.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 rounded border border-stone-300 px-3 py-2">
              <span className="min-w-0 flex-1">{snippet(c.turns.find((t) => t.role === "user")?.content ?? "(発言なし)")} <span className="text-xs text-stone-400">…{tail(c.id)}</span></span>
              {confirming !== `c:${c.id}` ? <button disabled={busy || blocked} className="border px-2 py-1" onClick={() => { setWithMemories(false); setConfirming(`c:${c.id}`); }}>削除…</button> : (<>
                <label className="text-xs"><input type="checkbox" checked={withMemories} onChange={(e) => setWithMemories(e.target.checked)} /> この会話から作られた記憶も削除する</label>
                <button disabled={busy || blocked} className="border border-red-700 px-2 py-1 text-red-700" onClick={() => void act(async () => {
                  if (withMemories) { const r = await deleteConversationWithMemoriesByUser(c.id); return `会話と記憶 ${r.memoriesDeleted} 件を削除しました。`; }
                  const r = await deleteConversationByUser(c.id); return r.status === "deleted" ? "会話を削除しました（記憶は残しています）。" : "見つかりませんでした。";
                })}>削除する</button>
                <button className="border px-2 py-1" onClick={() => setConfirming(null)}>やめる</button>
              </>)}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="tomb-h" className="flex flex-col gap-3">
        <h2 id="tomb-h" className="font-medium">削除済みの記録 ({tombstones.length})</h2>
        <p className="text-xs text-stone-500">削除した記録は、保存先に残っていても、勝手にこの端末へ戻りません。保存先のファイルが無くなったことを確認でき、30日たつと、この記録も自動的に整理できます。</p>
        <ul className="flex flex-col gap-2">
          {tombstones.map((t) => {
            const d = purgeDecision(t, now);
            return (
              <li key={`${t.kind}:${t.id}`} className="flex flex-col gap-2 rounded border border-stone-300 px-3 py-2">
                <p>{kindLabel(t.kind)} …{tail(t.id)}（{t.deletedAt.slice(0, 10)}に削除）：{t.vault === "absent" ? "保存先にも見つかりません" : t.vault === "kept" ? "保存先のコピーを残す設定です" : "保存先にコピーが残っている可能性があります"}</p>
                <div className="flex flex-wrap gap-2">
                  <button disabled={busy} className="border px-2 py-1" onClick={() => void act(async () => {
                    const root = await vaultRoot();
                    if (!root) return "保存先を確認できませんでした（接続と読み取りの許可が必要です）。";
                    const p = await verifyTombstone(root, t.kind, t.id);
                    return p === "absent" ? "保存先にも見つかりませんでした。" : p === "present" ? "保存先にファイルが残っています。この画面からは削除しません。保存先のアプリで削除してから、もう一度確認してください。" : "保存先を確認できませんでした。";
                  })}>保存先を確認</button>
                  {t.vault !== "kept" && <button disabled={busy} className="border px-2 py-1" onClick={() => void act(async () => ((await keepVaultCopy(t)) ? "保存先のコピーを残す設定にしました。" : "別の画面で状態が変わりました。もう一度確認してください。"))}>保存先のコピーは残す</button>}
                  <button disabled={busy} className="border px-2 py-1" onClick={() => void act(async () => ((await allowBack(t)) ? "この記録を、保存先から戻せるようにしました（記録そのものは、戻すまで復元されません）。" : "別の画面で状態が変わりました。もう一度確認してください。"))}>戻せるようにする</button>
                  {d.purgeable && <button disabled={busy} className="border px-2 py-1" onClick={() => void act(async () => {
                    const root = await vaultRoot();
                    if (!root) return "保存先を確認できないため、整理できません（接続と読み取りの許可が必要です）。";
                    const n = (await purgeEligibleTombstones(root)).length;
                    return n > 0 ? `${n} 件を整理しました。` : "保存先にコピーが戻っていないか確認しましたが、整理できる記録はありませんでした。";
                  })}>整理する</button>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
