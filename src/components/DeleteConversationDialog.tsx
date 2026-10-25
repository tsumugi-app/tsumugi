"use client";

import { useEffect, useRef, useState } from "react";
import { getTombstone, type Tombstone } from "@/lib/db";
import {
  continueDelete, executeDelete, explainDeletionError, finishContinuedDelete, prepareConversationDelete, resolveConversationOfMemory, resolveVaultAccess,
  type ContinueReview, type ConversationDeleteReview, type VaultAccess,
} from "@/lib/deleteFlow";
import { getVaultBackend } from "@/lib/vault";

/**
 * 会話単位の削除ダイアログ（カレンダーのMemory・会話の詳細から開く。設定画面の「削除を完了する」からも開く）。
 * 削除するのは「選択したMemoryの元になった会話全体」と、その会話から生まれたすべての記録だけ。ボタンは「キャンセル」「削除する」の2つ。
 * 端末（スマホ・PC）や保存先の方式（アプリ専用領域・外部フォルダ）によらず、同じ流れで動く。内部エラーコードは表示しない。
 */
export type DeleteRequest =
  | { type: "delete-conversation"; conversationId: string }
  | { type: "delete-memory"; memoryId: string }
  | { type: "continue"; tombstone: Tombstone; label: string };

const BTN = "inline-flex min-h-10 items-center justify-center rounded-full border border-stone-300/70 px-4 py-2 text-sm text-stone-600 transition hover:bg-stone-900/5 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-600/70 dark:text-stone-300 dark:hover:bg-white/10";
const BTN_DANGER = "inline-flex min-h-10 items-center justify-center rounded-full bg-red-700 px-4 py-2 text-sm text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-600";

type Step =
  | { s: "loading" }
  | { s: "review"; review: ConversationDeleteReview }
  | { s: "continue-review"; review: ContinueReview }
  | { s: "running" }
  | { s: "done"; text: string }
  | { s: "failed"; message: string }
  | { s: "blocked"; message: string };

export default function DeleteConversationDialog({ request, onClose }: { request: DeleteRequest; onClose: (result: { changed: boolean; conversationId?: string }) => void }) {
  const [step, setStep] = useState<Step>({ s: "loading" });
  const [editorsStopped, setEditorsStopped] = useState(false);
  const access = useRef<VaultAccess>({ kind: "none" });
  const changed = useRef(false);
  const working = useRef(false);
  const conversationId = useRef<string | undefined>(request.type === "delete-conversation" ? request.conversationId : undefined);
  // a folder the user picked can be open in other apps (Obsidian etc.); the app's own storage (OPFS) has no other writer
  const needsEditorsStopped = getVaultBackend() !== "opfs";

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        access.current = await resolveVaultAccess();
        if (request.type === "continue") {
          const r = await continueDelete(request.tombstone, access.current);
          if (alive) setStep({ s: "continue-review", review: r });
          return;
        }
        let id = conversationId.current;
        if (request.type === "delete-memory") {
          const resolved = await resolveConversationOfMemory(request.memoryId);
          if (!resolved.ok) { if (alive) setStep({ s: "blocked", message: resolved.message }); return; }
          id = resolved.conversationId; conversationId.current = id;
        }
        const review = await prepareConversationDelete(id!, access.current);
        if (alive) setStep({ s: "review", review });
      } catch (e) {
        if (alive) setStep({ s: "blocked", message: explainDeletionError(e) });
      }
    })();
    return () => { alive = false; };
  }, [request]);

  async function run(fn: () => Promise<{ status: string; message?: string; vault?: string }>) {
    if (working.current) return;
    working.current = true; setStep({ s: "running" });
    try {
      const o = await fn();
      if (o.status === "done") { changed.current = true; setStep({ s: "done", text: o.vault === "deleted" ? "端末と保存先の両方から削除しました。" : "保存先は接続されていないため、この端末のデータを削除しました。" }); }
      else if (o.status === "incomplete") { changed.current = true; setStep({ s: "failed", message: o.message ?? "" }); }
      else setStep({ s: "blocked", message: o.message ?? "削除できませんでした。" });
    } catch (e) { setStep({ s: "failed", message: explainDeletionError(e) }); }
    finally { working.current = false; }
  }

  /** after a failure: re-verify the Vault, the files and the saved plan, and show what would change; nothing runs without the user's confirmation */
  async function startContinue() {
    setStep({ s: "loading" });
    try {
      const t = request.type === "continue" ? request.tombstone : conversationId.current ? await getTombstone("conversation", conversationId.current) : undefined;
      if (!t) throw new Error("deletion-intent-changed");
      setEditorsStopped(false);
      setStep({ s: "continue-review", review: await continueDelete(t, access.current) });
    } catch (e) { setStep({ s: "failed", message: explainDeletionError(e) }); }
  }

  const close = () => onClose({ changed: changed.current, conversationId: conversationId.current });
  const busy = step.s === "loading" || step.s === "running";
  const title = step.s === "done" ? "削除しました" : step.s === "failed" ? "削除を完了できませんでした" : request.type === "continue" ? "削除を続けますか？" : "この会話を削除しますか？";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => { if (!busy) close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-3xl bg-[var(--background)] p-5 text-stone-700 shadow-xl sm:rounded-3xl dark:text-stone-200">
        <h2 id="delete-dialog-title" className="text-base font-medium text-stone-800 dark:text-stone-100">{title}</h2>

        {step.s === "loading" && <p role="status" className="text-sm text-stone-500">確認しています…</p>}
        {step.s === "running" && <p role="status" className="text-sm text-stone-500">削除しています。このままお待ちください…</p>}
        {step.s === "blocked" && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{step.message}</p>}
        {step.s === "failed" && <><p role="alert" className="text-sm">{step.message}</p><p className="text-xs text-stone-500">データは安全に保護されていて、削除した内容が戻ることはありません。</p></>}
        {step.s === "done" && <p role="status" className="text-sm">{step.text}</p>}
        {request.type === "continue" && step.s !== "done" && <p className="rounded-xl bg-stone-100 px-3 py-2 text-sm break-words dark:bg-stone-800">{request.label}</p>}

        {step.s === "review" && (() => {
          const r = step.review;
          return (<>
            {r.preview.title && (
              <div className="flex flex-col gap-1 rounded-xl bg-stone-100 px-3 py-2 dark:bg-stone-800">
                <p className="text-[11px] text-stone-400">{r.preview.date}の会話</p>
                <p className="line-clamp-2 break-words text-sm text-stone-800 dark:text-stone-100">{r.preview.title}</p>
                {r.preview.excerpt && <p className="line-clamp-3 break-words text-xs text-stone-500 dark:text-stone-400">{r.preview.excerpt}</p>}
              </div>
            )}
            {r.blocker ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{r.blocker}</p> : (<>
              <p className="text-sm">この会話と、ここから生まれた記憶をすべて削除します。ほかの会話は削除されません。</p>
              <p className="text-sm text-stone-500">ここから生まれた記憶：{r.memoryCount} 件{r.reflectionCount > 0 ? `　振り返り：${r.reflectionCount} 件` : ""}</p>
              {r.keptUnverified > 0 && <p className="text-xs text-stone-500">元の会話を確認できない記憶 {r.keptUnverified} 件は、削除せずに残します。</p>}
              <p className="text-xs text-stone-500">{r.plan ? "端末と、保存先のMarkdown・索引・履歴から削除します。" : "保存先は接続されていないため、この端末のデータだけを削除します。"}削除は取り消せません。</p>
              {r.plan && (r.files.length > 0 || r.metadataFiles > 0) && (
                <details className="text-xs text-stone-500"><summary className="cursor-pointer">変更される保存先のファイル（{r.files.length} 件{r.metadataFiles > 0 ? `・索引や履歴 ${r.metadataFiles} 件` : ""}）</summary>
                  <ul className="mt-1 flex flex-col gap-1">{r.files.map((f) => <li key={f} className="break-all">{f}</li>)}</ul>
                </details>
              )}
              {r.plan && needsEditorsStopped && (
                <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={editorsStopped} onChange={(e) => setEditorsStopped(e.target.checked)} /><span>Obsidianなど、他のアプリや端末でこの保存先を開いている場合は、閉じました。</span></label>
              )}
            </>)}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button className={BTN} onClick={close}>キャンセル</button>
              <button className={BTN_DANGER} disabled={!!r.blocker || (!!r.plan && needsEditorsStopped && !editorsStopped)} onClick={() => void run(() => executeDelete(r, access.current))}>削除する</button>
            </div>
          </>);
        })()}

        {step.s === "continue-review" && (() => {
          const r = step.review;
          return (<>
            <p className="text-sm">{r.repair ? "削除が途中で止まり、ファイルが中途半端な状態です。現在の内容と、確定済みの削除後の内容を確認してください。" : "止まっていた削除を、続きから行います。次のファイルを更新・削除します。"}</p>
            <details className="text-xs text-stone-500" open={r.repair}><summary className="cursor-pointer">変更される保存先のファイル（{r.files.length} 件{r.metadataFiles > 0 ? `・索引や履歴 ${r.metadataFiles} 件` : ""}）</summary>
              <ul className="mt-1 flex flex-col gap-1">{r.files.map((f) => <li key={f} className="break-all">{f}</li>)}</ul>
              {r.repair && r.plan.edits.filter((e) => e.before !== e.after).map((e) => (
                <details key={e.path} className="mt-2"><summary>{e.path} の内容を確認</summary>
                  <p>現在の内容</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{e.before ?? "（ファイルなし）"}</pre>
                  <p>削除後の内容</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{e.after ?? "（ファイルを削除）"}</pre>
                </details>
              ))}
            </details>
            {needsEditorsStopped && (
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={editorsStopped} onChange={(e) => setEditorsStopped(e.target.checked)} /><span>Obsidianなど、他のアプリや端末でこの保存先を開いている場合は、閉じました。</span></label>
            )}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button className={BTN} onClick={close}>キャンセル</button>
              <button className={BTN_DANGER} disabled={needsEditorsStopped && !editorsStopped} onClick={() => void run(() => finishContinuedDelete(access.current, r))}>削除を続ける</button>
            </div>
          </>);
        })()}

        {(step.s === "done" || step.s === "blocked") && <button className={BTN} onClick={close}>閉じる</button>}
        {step.s === "failed" && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button className={BTN} onClick={close}>あとで</button>
            <button className={BTN_DANGER} onClick={() => void startContinue()}>削除を続ける</button>
          </div>
        )}
      </div>
    </div>
  );
}
