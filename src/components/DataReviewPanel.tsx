"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAllConversations, getAllMemoryObjects, getTombstone, type Tombstone } from "@/lib/db";
import {
  continueDelete, executeDelete, explainDeletionError, finishContinuedDelete, listIncompleteDeletions, prepareDelete, resolveVaultAccess,
  type ContinueReview, type DeleteReview, type DeleteTarget, type VaultAccess,
} from "@/lib/deleteFlow";
import { getVaultBackend } from "@/lib/vault";
import { isRecoveryBlockingNormalWrites } from "@/lib/vaultRecoveryJournal";
import type { Conversation, MemoryObject } from "@/lib/types";
import DataAdvancedPanel from "@/components/DataAdvancedPanel";

/**
 * データの管理（/data）。記憶と会話を一覧し、「削除」を押すと、確認ダイアログで影響範囲を見て、1回の確定で端末内と保存先（Vault）の両方から削除する。
 * 技術的な内部状態（IndexedDB・Vault・tombstone・Outbox）はここには出さない。途中で止まった削除だけを「削除を完了する」にまとめる。
 * 例外的な管理操作は、最下部の「詳細な管理」を開いたときだけ表示する。何も自動では削除しない：すべてボタン操作。
 */
const BTN = "inline-flex min-h-10 items-center justify-center rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-600 dark:hover:bg-stone-800";
const BTN_DANGER = "inline-flex min-h-10 items-center justify-center rounded-md border border-red-700 bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500 dark:bg-red-600";
const CARD = "flex flex-col gap-2 rounded-lg border border-stone-300 bg-white/60 p-3 dark:border-stone-700 dark:bg-stone-900/40";
const SECTION = "flex flex-col gap-3 rounded-xl border border-stone-200 p-4 dark:border-stone-700";
const TEXT = "min-w-0 flex-1 break-words [overflow-wrap:anywhere]";
const tail = (id: string) => id.slice(-6);
const snippet = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
const memoryLabel = (m: MemoryObject) => m.summary || m.content || "(内容なし)";
const conversationLabel = (c: Conversation) => c.turns.find((t) => t.role === "user")?.content ?? "(発言なし)";

type Request =
  | { type: "delete"; target: DeleteTarget; label: string }
  | { type: "continue"; tombstone: Tombstone; label: string };
type Step =
  | { s: "loading" }
  | { s: "review"; review: DeleteReview }
  | { s: "continue-review"; review: ContinueReview }
  | { s: "running" }
  | { s: "done"; text: string }
  | { s: "failed"; message: string }
  | { s: "blocked"; message: string };

function DeleteDialog({ request, onClose }: { request: Request; onClose: (changed: boolean) => void }) {
  const [step, setStep] = useState<Step>({ s: "loading" });
  const [withMemories, setWithMemories] = useState(false);
  const [editorsStopped, setEditorsStopped] = useState(false);
  const access = useRef<VaultAccess>({ kind: "none" });
  const changed = useRef(false);
  const working = useRef(false);
  // external apps can only touch a folder the user picked; the app's own storage (OPFS) has no other writer
  const needsEditorsStopped = getVaultBackend() !== "opfs";

  const review = useCallback(async (withMem: boolean) => {
    if (request.type !== "delete") return;
    setStep({ s: "loading" });
    const target: DeleteTarget = request.target.kind === "conversation" ? { ...request.target, withMemories: withMem } : request.target;
    setStep({ s: "review", review: await prepareDelete(target, access.current) });
  }, [request]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        access.current = await resolveVaultAccess();
        if (!alive) return;
        if (request.type === "delete") await review(false);
        else {
          const r = await continueDelete(request.tombstone, access.current);
          if (alive) setStep({ s: "continue-review", review: r });
        }
      } catch (e) {
        if (alive) setStep({ s: "blocked", message: explainDeletionError(e) });
      }
    })();
    return () => { alive = false; };
  }, [request, review]);

  async function run(fn: () => Promise<{ status: string; message?: string; vault?: string }>) {
    if (working.current) return;
    working.current = true; setStep({ s: "running" });
    try {
      const o = await fn();
      if (o.status === "done") { changed.current = true; setStep({ s: "done", text: o.vault === "deleted" ? "端末内と保存先の両方から削除しました。" : "保存先は接続されていないため、この端末のデータを削除しました。" }); }
      else if (o.status === "incomplete") { changed.current = true; setStep({ s: "failed", message: o.message ?? "" }); }
      else setStep({ s: "blocked", message: o.message ?? "削除できませんでした。" });
    } catch (e) {
      setStep({ s: "failed", message: explainDeletionError(e) });
    } finally { working.current = false; }
  }

  /** after a failure: re-verify the Vault, the files and the saved plan, and show what would change; nothing runs without the user's confirmation */
  async function startContinue() {
    setStep({ s: "loading" });
    try {
      const ref = request.type === "continue" ? request.tombstone : { kind: request.target.kind, id: request.target.id };
      const t = request.type === "continue" ? request.tombstone : await getTombstone(ref.kind, ref.id);
      if (!t) throw new Error("deletion-intent-changed");
      setEditorsStopped(false);
      setStep({ s: "continue-review", review: await continueDelete(t, access.current) });
    } catch (e) { setStep({ s: "failed", message: explainDeletionError(e) }); }
  }

  const title = request.type === "continue" ? "削除を続けますか？" : request.target.kind === "memory" ? "この記憶を削除しますか？" : "この会話を削除しますか？";
  const busy = step.s === "running" || step.s === "loading";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => { if (!busy) onClose(changed.current); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-2xl bg-[var(--background)] p-4 shadow-xl sm:rounded-2xl">
        <h2 id="delete-dialog-title" className="text-base font-medium">{step.s === "failed" ? "削除を完了できませんでした。データを安全に保護しています。" : step.s === "done" ? "削除しました" : title}</h2>
        <p className={`${TEXT} line-clamp-3 rounded-md bg-stone-100 px-3 py-2 text-sm dark:bg-stone-800`}>{snippet(request.label, 120)}</p>

        {step.s === "loading" && <p role="status" className="text-sm text-stone-500">確認しています…</p>}
        {step.s === "running" && <p role="status" className="text-sm text-stone-500">削除しています。このままお待ちください…</p>}
        {step.s === "blocked" && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{step.message}</p>}
        {step.s === "failed" && <p role="alert" className="text-sm">{step.message}</p>}
        {step.s === "done" && <p role="status" className="text-sm">{step.text}</p>}

        {step.s === "review" && (() => {
          const r = step.review; const t = r.target;
          return (<>
            {r.blocker ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{r.blocker}</p> : (<>
              <ul className="list-disc pl-5 text-sm">
                {t.kind === "memory" && r.linkedMemories > 0 && <li>つながっている記憶 {r.linkedMemories} 件から、この記憶へのリンクが外れます。</li>}
                {t.kind === "conversation" && <li>この会話から作られた記憶は {r.childMemories} 件あります。{t.withMemories ? "それも削除します。" : "記憶は残します。"}</li>}
                <li>{r.plan ? `端末内と、保存先のMarkdown・索引・履歴から削除します。` : "保存先は接続されていないため、この端末のデータだけを削除します。"}</li>
                <li>削除は取り消せません。同じ記録が、あとで自動的に戻ることもありません。</li>
              </ul>
              {t.kind === "conversation" && (
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={withMemories} onChange={(e) => { setWithMemories(e.target.checked); void review(e.target.checked); }} /><span>この会話から作られた記憶も削除する</span></label>
              )}
              {r.plan && (r.files.length > 0 || r.metadataFiles > 0) && (
                <details className="text-xs"><summary className="cursor-pointer">変更される保存先のファイル（{r.files.length} 件{r.metadataFiles > 0 ? `・索引や履歴 ${r.metadataFiles} 件` : ""}）</summary>
                  <ul className="mt-1 flex flex-col gap-1">{r.files.map((f) => <li key={f} className="break-all">{f}</li>)}</ul>
                </details>
              )}
              {r.plan && needsEditorsStopped && (
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={editorsStopped} onChange={(e) => setEditorsStopped(e.target.checked)} /><span>Obsidianなど、他のアプリや端末でこの保存先を開いている場合は、閉じました。</span></label>
              )}
            </>)}
            <div className="grid grid-cols-2 gap-2">
              <button className={BTN} onClick={() => onClose(changed.current)}>やめる</button>
              <button className={BTN_DANGER} disabled={!!r.blocker || (!!r.plan && needsEditorsStopped && !editorsStopped)}
                onClick={() => void run(() => executeDelete(r, access.current))}>削除する</button>
            </div>
          </>);
        })()}

        {step.s === "continue-review" && (() => {
          const r = step.review;
          return (<>
            <p className="text-sm">{r.repair ? "削除が途中で止まり、ファイルが中途半端な状態です。現在の内容と、確定済みの削除後の内容を確認してください。" : "止まっていた削除を、続きから行います。次のファイルを更新・削除します。"}</p>
            <details className="text-xs" open={r.repair}><summary className="cursor-pointer">変更される保存先のファイル（{r.files.length} 件{r.metadataFiles > 0 ? `・索引や履歴 ${r.metadataFiles} 件` : ""}）</summary>
              <ul className="mt-1 flex flex-col gap-1">{r.files.map((f) => <li key={f} className="break-all">{f}</li>)}</ul>
              {r.repair && r.plan.edits.filter((e) => e.before !== e.after).map((e) => (
                <details key={e.path} className="mt-2"><summary>{e.path} の内容を確認</summary>
                  <p>現在の内容</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{e.before ?? "（ファイルなし）"}</pre>
                  <p>削除後の内容</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{e.after ?? "（ファイルを削除）"}</pre>
                </details>
              ))}
            </details>
            {needsEditorsStopped && (
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={editorsStopped} onChange={(e) => setEditorsStopped(e.target.checked)} /><span>Obsidianなど、他のアプリや端末でこの保存先を開いている場合は、閉じました。</span></label>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button className={BTN} onClick={() => onClose(changed.current)}>やめる</button>
              <button className={BTN_DANGER} disabled={needsEditorsStopped && !editorsStopped} onClick={() => void run(() => finishContinuedDelete(access.current, r))}>削除を続ける</button>
            </div>
          </>);
        })()}

        {(step.s === "done" || step.s === "blocked") && <button className={BTN} onClick={() => onClose(changed.current)}>閉じる</button>}
        {step.s === "failed" && (
          <div className="grid grid-cols-2 gap-2">
            <button className={BTN} onClick={() => onClose(changed.current)}>あとで</button>
            <button className={BTN_DANGER} onClick={() => void startContinue()}>削除を続ける</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DataReviewPanel() {
  const [memories, setMemories] = useState<MemoryObject[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [incomplete, setIncomplete] = useState<Tombstone[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<Request | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setBlocked(await isRecoveryBlockingNormalWrites());
      setMemories((await getAllMemoryObjects()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setConversations((await getAllConversations()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setIncomplete(await listIncompleteDeletions());
      setLoadError(null);
    } catch (e) { setLoadError("読み込めませんでした: " + ((e as Error)?.name ?? "error")); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load, refreshKey]);

  const q = filter.trim().toLowerCase();
  const shownMemories = memories.filter((m) => !q || m.summary.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)).slice(0, 50);
  const shownConversations = conversations.filter((c) => !q || conversationLabel(c).toLowerCase().includes(q)).slice(0, 50);
  const close = (changed: boolean) => { setDialog(null); if (changed) setRefreshKey((k) => k + 1); };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-10 text-sm text-stone-700 dark:text-stone-200">
      <header className="sticky top-0 z-10 -mx-4 mb-4 flex items-center gap-3 border-b border-stone-200 bg-[var(--background)] px-4 py-3 dark:border-stone-700">
        <Link href="/" className={BTN} aria-label="トップページへ戻る">← トップへ</Link>
        <h1 className="text-lg font-medium">データの管理</h1>
      </header>
      <div className="flex flex-col gap-5">
        <p className="text-xs text-stone-500">記憶と会話を整理できます。削除すると、この端末と保存先（Vault）の両方から取り除かれます。何も自動では削除しません。</p>
        {blocked && <p role="alert" className="rounded border border-amber-400 px-3 py-2 text-amber-700">メンテナンス中、または復旧が必要な状態のため、いまは削除できません。</p>}
        {loadError && <p role="alert" className="rounded border border-red-400 px-3 py-2 text-red-700">{loadError}</p>}

        {incomplete.length > 0 && (
          <section aria-labelledby="incomplete-h" className={`${SECTION} border-amber-300`}>
            <h2 id="incomplete-h" className="text-base font-medium">削除を完了する（{incomplete.length}）</h2>
            <p className="text-xs text-stone-500">削除が途中で止まっています。データは安全に保護されていて、削除した記録が戻ることはありません。</p>
            <ul className="flex flex-col gap-2">
              {incomplete.map((t) => (
                <li key={`${t.kind}:${t.id}`} className={CARD}>
                  <p className={TEXT}>{t.kind === "conversation" ? "会話" : "記憶"} <span className="whitespace-nowrap text-xs text-stone-400">…{tail(t.id)}</span>（{t.deletedAt.slice(0, 10)}に削除）</p>
                  <button disabled={blocked} className={BTN} onClick={() => setDialog({ type: "continue", tombstone: t, label: `${t.kind === "conversation" ? "会話" : "記憶"} …${tail(t.id)}` })}>削除を続ける</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="delete-h" className={SECTION}>
          <h2 id="delete-h" className="text-base font-medium">記憶と会話</h2>
          <label className="flex items-center gap-2 text-xs">絞り込み <input aria-label="絞り込み" className="min-h-10 min-w-0 flex-1 rounded-md border border-stone-300 bg-transparent px-3 py-1.5 text-sm dark:border-stone-600" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
          <h3 className="border-b border-stone-200 pb-1 text-xs font-medium text-stone-500 dark:border-stone-700">記憶（{memories.length}）</h3>
          <ul className="flex flex-col gap-2">
            {shownMemories.map((m) => (
              <li key={m.id} className={`${CARD} flex-row items-start gap-3`}>
                <p className={`${TEXT} line-clamp-3`}>{snippet(memoryLabel(m))} <span className="whitespace-nowrap text-xs text-stone-400">…{tail(m.id)}</span></p>
                <button disabled={blocked} className={`${BTN} shrink-0`} onClick={() => setDialog({ type: "delete", target: { kind: "memory", id: m.id }, label: memoryLabel(m) })}>削除</button>
              </li>
            ))}
          </ul>
          <h3 className="mt-2 border-b border-stone-200 pb-1 text-xs font-medium text-stone-500 dark:border-stone-700">会話（{conversations.length}）</h3>
          <ul className="flex flex-col gap-2">
            {shownConversations.map((c) => (
              <li key={c.id} className={`${CARD} flex-row items-start gap-3`}>
                <p className={`${TEXT} line-clamp-3`}>{snippet(conversationLabel(c))} <span className="whitespace-nowrap text-xs text-stone-400">…{tail(c.id)}</span></p>
                <button disabled={blocked} className={`${BTN} shrink-0`} onClick={() => setDialog({ type: "delete", target: { kind: "conversation", id: c.id, withMemories: false }, label: conversationLabel(c) })}>削除</button>
              </li>
            ))}
          </ul>
        </section>

        <details className="rounded-xl border border-stone-200 p-4 dark:border-stone-700">
          <summary className="cursor-pointer text-sm text-stone-500">詳細な管理（上級者向け）</summary>
          <div className="mt-4"><DataAdvancedPanel refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} /></div>
        </details>
      </div>
      {dialog && <DeleteDialog request={dialog} onClose={close} />}
    </div>
  );
}
