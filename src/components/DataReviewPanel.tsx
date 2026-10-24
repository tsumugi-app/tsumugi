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
import { previewVaultDeletion, previewVaultDeletionRepair, confirmVaultDeletion, retryVaultDeletion, type VaultDeletionPlan } from "@/lib/vaultDeletion";
import type { Conversation, MemoryObject } from "@/lib/types";

/**
 * データの管理（/data）。ユーザー自身が、記憶・会話を削除し、同期が止まった項目（保留・競合）を解決し、削除済みの記録の後始末をする画面。
 * ChatScreen・Capture・Connect・起動処理は一切動かさない（この画面だけで完結）。何も自動では削除しない：すべてボタン操作（二段階確認つき）。
 * Vaultの削除は対象一覧を確認した後の別操作。失敗した操作は削除済み一覧から再試行する。
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

// Presentation only (no behaviour): one tap-sized button style, one card style, one section style. One column on phones, wider from `sm`.
const BTN = "inline-flex min-h-10 items-center justify-center rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-600 dark:hover:bg-stone-800";
const BTN_DANGER = "inline-flex min-h-10 items-center justify-center rounded-md border border-red-700 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-400 dark:text-red-300 dark:hover:bg-red-950";
const CARD = "flex flex-col gap-2 rounded-lg border border-stone-300 bg-white/60 p-3 dark:border-stone-700 dark:bg-stone-900/40";
const SECTION = "flex flex-col gap-3 rounded-xl border border-stone-200 p-4 dark:border-stone-700";
const CONFIRM = "flex flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950/40";
const ACTIONS = "grid grid-cols-2 gap-2 sm:flex sm:flex-wrap";
const TEXT = "min-w-0 flex-1 break-words [overflow-wrap:anywhere]";

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
  const [deletionPlan, setDeletionPlan] = useState<VaultDeletionPlan | null>(null);
  const [editorsStopped, setEditorsStopped] = useState(false);

  const load = useCallback(async () => {
    try {
      setBlocked(await isRecoveryBlockingNormalWrites());
      setAttention(await listOutboxNeedingAttention());
      setMemories((await getAllMemoryObjects()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setConversations((await getAllConversations()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setTombstones(await listTombstones());
    } catch (e) { setMessage("読み込めませんでした: " + ((e as Error)?.name ?? "error")); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function act(fn: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setMessage(null); setConfirming(null);
    try { setMessage(await fn()); } catch (e) { const n = (e as Error)?.name ?? "error"; setMessage(n === "RecoveryPendingError" ? "メンテナンス中、または復旧が必要な状態のため、今はできません。" : n === "TombstonedRecordError" ? "削除済みの記録のため、できません。" : "完了していません。接続・権限・ファイルの変更を確認し、対象を再確認してから再試行してください: " + ((e as Error)?.message ?? n)); }
    finally { setBusy(false); await load(); }
  }
  async function vaultRoot(mode: "read" | "readwrite" = "read"): Promise<FileSystemDirectoryHandle | null> {
    // the app's own (origin-private) storage is the Vault on devices without a folder picker: its root is not a stored handle
    if (getVaultBackend() === "opfs") { try { return await navigator.storage.getDirectory(); } catch { return null; } }
    const h = await loadVaultHandle();
    if (!h) return null;
    const p = (await (h as unknown as { requestPermission?: (o: { mode: string }) => Promise<string> }).requestPermission?.({ mode })) ?? "granted";
    return p === "granted" ? h : null;
  }

  const q = filter.trim().toLowerCase();
  const shownMemories = memories.filter((m) => !q || m.summary.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)).slice(0, 30);
  const shownConversations = conversations.filter((c) => !q || (c.turns.find((t) => t.role === "user")?.content ?? "").toLowerCase().includes(q)).slice(0, 30);
  const now = new Date().toISOString();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 text-sm text-stone-700 sm:gap-8 sm:py-8 dark:text-stone-200">
      <h1 className="text-lg font-medium">データの管理</h1>
      <p className="text-xs text-stone-500">何も自動では削除しません。端末から削除した後、「削除済みの記録」で保存先（Vault）の削除対象を確認して確定できます。</p>
      {blocked && <p role="alert" className="rounded border border-amber-400 px-3 py-2 text-amber-700">メンテナンス中、または復旧が必要な状態のため、削除と解決はできません。</p>}
      {message && <p role="status" className="rounded border border-stone-300 px-3 py-2">{message}</p>}
      {deletionPlan && <section role="region" aria-label="保存先の削除確認" className="flex flex-col gap-3 rounded-xl border border-red-500 p-4">
        <p>次のファイルから対象の記録を削除し、履歴・索引も更新します。取り消せません。同じファイルの別の記憶は残します。</p>
        <ul className="flex flex-col gap-1 text-xs">{deletionPlan.edits.map((e) => <li key={e.path} className="break-all">{e.path}（{e.after === null ? "ファイルを削除" : "対象箇所を更新"}）</li>)}</ul>
        {deletionPlan.repairOf && <>
          <p role="alert">中断した変更を、前回確定した削除結果に修復します。中断後の追加編集は失われる可能性があります。各ファイルの現在の内容と修復後の内容を確認してください。</p>
          {deletionPlan.edits.filter((e) => e.before !== e.after).map((e) => <details key={e.path}>
            <summary>{e.path} の内容を確認</summary>
            <p>現在の内容</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap">{e.before ?? "（ファイルなし）"}</pre>
            <p>修復後の内容</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap">{e.after ?? "（ファイルを削除）"}</pre>
          </details>)}
        </>}
        <p>対象 {deletionPlan.ids.length} 件。復旧用アーカイブや外部バックアップは残ります。復活を防ぐ記録は保持します。</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={editorsStopped} onChange={(e) => setEditorsStopped(e.target.checked)} /> 内容を確認し、他のアプリ・端末で、この保存先の編集と同期を停止しました</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button disabled={busy || blocked || !editorsStopped} className={BTN_DANGER} onClick={() => void act(async () => {
            const plan = deletionPlan; setDeletionPlan(null);
            const root = await vaultRoot("readwrite"); if (!root) return "書き込みの許可が必要です。まだ保存先から削除していません。";
            await confirmVaultDeletion(root, plan); return "保存先の削除と履歴・索引の更新が完了しました。";
          })}>保存先からも完全に削除する</button>
          <button disabled={busy} className={BTN} onClick={() => setDeletionPlan(null)}>取り消す</button>
        </div>
      </section>}

      <section aria-labelledby="attention-h" className={SECTION}>
        <h2 id="attention-h" className="text-base font-medium">確認が必要な項目 ({attention.length})</h2>
        {attention.length === 0 && <p className="text-xs text-stone-500">同期が止まっている項目はありません。</p>}
        <ul className="flex flex-col gap-3">
          {attention.map((e) => (
            <li key={e.id} className={CARD}>
              <p>{kindLabel(e.recordType)} …{tail(e.recordId)}：{reasonText(e)}</p>
              <p className="text-xs text-stone-500">{e.recordExists ? "この端末には記録があります。" : "この端末に記録がありません。"}{e.tombstoned ? " 削除済みとして記録されています。" : ""}</p>
              <div className={ACTIONS}>
                {e.recordExists && <button disabled={busy || blocked} className={BTN} onClick={() => void act(async () => ((await retryOutboxEntry(e.id)) === "retried" ? "もう一度同期を試す状態にしました。" : "項目が見つかりませんでした。"))}>再試行</button>}
                {e.recordExists && <button disabled={busy || blocked} className={BTN} onClick={() => void act(async () => {
                  const root = await vaultRoot();
                  if (!root) return "保存先（Vault）を読めないため、この操作はできません。保存先に記録があることを確認できないと、同期を終了できません。";
                  if ((await findRecordInVault(root, e.recordId)) !== "present") return "保存先に、この記録のコピーが見つかりません。このまま同期を終了すると、この端末の記録が保存先に残らなくなるため、できません。「もう一度試す」を使ってください。";
                  const r = await acceptOutboxDivergence(e.id, { vaultCopyVerified: true, seenOutboxUpdatedAt: e.updatedAt });
                  return r === "accepted" ? "この端末と保存先をそのままにして、同期を終了しました。" : r === "changed" ? "確認している間に、この項目が更新されました。もう一度内容を確認してください。" : "できませんでした。";
                })}>両方そのままにする</button>}
                {e.recordExists && e.recordType !== "source" && confirming !== `del:${e.id}` && <button disabled={busy || blocked} className={BTN} onClick={() => setConfirming(`del:${e.id}`)}>この端末から削除…</button>}
                {e.recordExists && confirming === `del:${e.id}` && (<>
                  <span className="col-span-2 text-red-700 dark:text-red-300">本当に削除しますか？</span>
                  <button disabled={busy || blocked} className={BTN_DANGER} onClick={() => void act(async () => {
                    const r = e.recordType === "conversation" ? await deleteConversationByUser(e.recordId) : await deleteMemoryByUser(e.recordId);
                    return r.status === "deleted" ? "削除しました。" : "見つかりませんでした。";
                  })}>削除する</button>
                  <button className={BTN} onClick={() => setConfirming(null)}>やめる</button>
                </>)}
                {!e.recordExists && e.recordType !== "source" && <button disabled={busy || blocked} className={BTN} onClick={() => void act(async () => ((await removeOrphanOutboxEntry(e.id, { tombstone: true })) === "removed" ? "削除済みとして整理しました。保存先に残っていても、この端末には戻りません。" : "できませんでした。"))}>削除済みとして整理</button>}
                {!e.recordExists && <button disabled={busy || blocked} className={BTN} onClick={() => void act(async () => ((await removeOrphanOutboxEntry(e.id)) === "removed" ? "この項目だけを整理しました。" : "できませんでした。"))}>この項目だけ整理</button>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="delete-h" className={SECTION}>
        <h2 id="delete-h" className="text-base font-medium">記憶・会話を削除する</h2>
        <label className="text-xs">絞り込み <input aria-label="絞り込み" className={BTN} value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        <h3 className="border-b border-stone-200 pb-1 text-xs font-medium text-stone-500 dark:border-stone-700">記憶 ({memories.length})</h3>
        <ul className="flex flex-col gap-2">
          {shownMemories.map((m) => (
            <li key={m.id} className={CARD}>
              <div className="flex items-start gap-3">
                <p className={`${TEXT} line-clamp-3`}>{snippet(m.summary)} <span className="whitespace-nowrap text-xs text-stone-400">…{tail(m.id)}</span></p>
                {confirming !== `m:${m.id}` && <button disabled={busy || blocked} className={`${BTN} shrink-0`} onClick={() => setConfirming(`m:${m.id}`)}>削除…</button>}
              </div>
              {confirming === `m:${m.id}` && (
                <div className={CONFIRM}>
                  <span className="text-red-700 dark:text-red-300">この記憶を削除します。リンクも外れます。</span>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                    <button className={BTN} onClick={() => setConfirming(null)}>やめる</button>
                    <button disabled={busy || blocked} className={BTN_DANGER} onClick={() => void act(async () => { const r = await deleteMemoryByUser(m.id); return r.status === "deleted" ? `削除しました（つながっていた記憶 ${r.countersUpdated} 件のリンクを外しました）。` : "見つかりませんでした。"; })}>削除する</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        <h3 className="mt-2 border-b border-stone-200 pb-1 text-xs font-medium text-stone-500 dark:border-stone-700">会話 ({conversations.length})</h3>
        <ul className="flex flex-col gap-2">
          {shownConversations.map((c) => (
            <li key={c.id} className={CARD}>
              <div className="flex items-start gap-3">
                <p className={`${TEXT} line-clamp-3`}>{snippet(c.turns.find((t) => t.role === "user")?.content ?? "(発言なし)")} <span className="whitespace-nowrap text-xs text-stone-400">…{tail(c.id)}</span></p>
                {confirming !== `c:${c.id}` && <button disabled={busy || blocked} className={`${BTN} shrink-0`} onClick={() => { setWithMemories(false); setConfirming(`c:${c.id}`); }}>削除…</button>}
              </div>
              {confirming === `c:${c.id}` && (
                <div className={CONFIRM}>
                  <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={withMemories} onChange={(e) => setWithMemories(e.target.checked)} /><span>この会話から作られた記憶も削除する</span></label>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                    <button className={BTN} onClick={() => setConfirming(null)}>やめる</button>
                    <button disabled={busy || blocked} className={BTN_DANGER} onClick={() => void act(async () => {
                      if (withMemories) { const r = await deleteConversationWithMemoriesByUser(c.id); return `会話と記憶 ${r.memoriesDeleted} 件を削除しました。`; }
                      const r = await deleteConversationByUser(c.id); return r.status === "deleted" ? "会話を削除しました（記憶は残しています）。" : "見つかりませんでした。";
                    })}>削除する</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="tomb-h" className={SECTION}>
        <h2 id="tomb-h" className="text-base font-medium">削除済みの記録 ({tombstones.length})</h2>
        <p className="text-xs text-stone-500">削除した記録は、保存先に残っていても、勝手にこの端末へ戻りません。保存先も削除した場合、この復活防止の記録は自動では整理しません。</p>
        <ul className="flex flex-col gap-2">
          {tombstones.map((t) => {
            const d = purgeDecision(t, now);
            return (
              <li key={`${t.kind}:${t.id}`} className={CARD}>
                <p>{kindLabel(t.kind)} …{tail(t.id)}（{t.deletedAt.slice(0, 10)}に削除）：{t.vault === "absent" ? "保存先にも見つかりません" : t.vault === "kept" ? "保存先のコピーを残す設定です" : "保存先にコピーが残っている可能性があります"}</p>
                <div className={ACTIONS}>
                  <button disabled={busy || blocked || !!t.physicalDeletionParent} className={BTN} onClick={() => void act(async () => {
                    const root = await vaultRoot(); if (!root) return "保存先の読み取りの許可が必要です。";
                    const plan = await previewVaultDeletion(root, t); setEditorsStopped(false); setDeletionPlan(plan);
                    return "削除対象を確認してください。まだ保存先のファイルは変更していません。";
                  })}>保存先の削除対象を確認…</button>
                  {t.physicalDeletionParent && <p className="col-span-2 text-xs">会話 …{tail(t.physicalDeletionParent)} の削除と一緒に処理します。会話の項目から再試行してください。</p>}
                  {t.physicalDeletion === "pending" && !t.physicalDeletionParent && <>
                    <span role="alert" className="col-span-2 text-red-700 dark:text-red-300">保存先の削除は未完了です。復活防止の記録を保持しています。</span>
                    <button disabled={busy || blocked} className={BTN} onClick={() => void act(async () => {
                      const root = await vaultRoot("readwrite"); if (!root) return "書き込みの許可が必要です。";
                      await retryVaultDeletion(root, t); return "保存先の削除と履歴・索引の更新が完了しました。";
                    })}>確定済みの削除を再試行</button>
                    <button disabled={busy || blocked} className={BTN} onClick={() => void act(async () => {
                      const root = await vaultRoot(); if (!root) return "保存先の読み取りの許可が必要です。";
                      setDeletionPlan(await previewVaultDeletionRepair(root, t)); setEditorsStopped(false);
                      return "現在の内容と修復後の内容を確認してください。まだファイルは変更していません。";
                    })}>中断した変更を確認して修復…</button>
                  </>}
                  <button disabled={busy} className={BTN} onClick={() => void act(async () => {
                    const root = await vaultRoot();
                    if (!root) return "保存先を確認できませんでした（接続と読み取りの許可が必要です）。";
                    const p = await verifyTombstone(root, t.kind, t.id);
                    return p === "absent" ? "保存先にも見つかりませんでした。" : p === "present" ? "保存先にファイルが残っています。「保存先の削除対象を確認…」で確認できます。" : "保存先を確認できませんでした。";
                  })}>保存先を確認</button>
                  {t.vault !== "kept" && <button disabled={busy || t.physicalDeletion === "pending"} className={BTN} onClick={() => void act(async () => ((await keepVaultCopy(t)) ? "保存先のコピーを残す設定にしました。" : "別の画面で状態が変わりました。もう一度確認してください。"))}>保存先のコピーは残す</button>}
                  <button disabled={busy || t.physicalDeletion === "pending"} className={BTN} onClick={() => void act(async () => {
                    const r = await allowBack(t);
                    return r === "parent-guard" ? "この記憶は、会話と一緒に削除されたため、先にその会話の削除保護を解除する必要があります。「削除済みの記録」の会話の項目で「戻せるようにする」を押してください。まだ何も変更していません。"
                      : r ? "この記録を、保存先から戻せるようにしました（記録そのものは、戻すまで復元されません）。" : "別の画面で状態が変わりました。もう一度確認してください。";
                  })}>戻せるようにする</button>
                  {d.purgeable && <button disabled={busy} className={BTN} onClick={() => void act(async () => {
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
