"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ADOPT_VAULT_BLOCK_TEXT, BLOCK_REASON_TEXT, CHOICE_LABEL, choiceExplanation, inspectConflict, listKeptVersions, NOT_STARTED_REASON_TEXT, STOPPED_TEXT,
  type ConflictChoice, type ConflictOutcome, type ConflictRef, type ConflictSnapshot, type ConflictView, type KeptVersion,
} from "@/lib/vaultConflictResolution";
import { RECORD_TYPE_TEXT } from "@/lib/vaultRecoveryUserView";

/**
 * 設定の「端末と保存先で内容が異なる記録」。両方の版と差分を見せ、今の実体で安全に実行できる選択肢だけを出す。
 * 選択は1件ずつ、何が変わり何が失われうるかを見せた上で確定する。表示は、実行後にもう一度確認した結果に基づく。
 */
const button = "shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-300 dark:hover:bg-white/10";
const pre = "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-stone-100/70 p-2 text-[11px] leading-relaxed dark:bg-black/20";

const refKey = (r: ConflictRef) => `${r.recordType}:${r.recordId}`;

function outcomeText(outcome: ConflictOutcome): string {
  if (outcome.kind === "not-started") return NOT_STARTED_REASON_TEXT[outcome.reason];
  if (outcome.kind === "stopped") return STOPPED_TEXT;
  return outcome.resolved
    ? `「${CHOICE_LABEL[outcome.choice]}」を実行し、もう一度確認して問題が無くなったことを確かめました。`
    : `「${CHOICE_LABEL[outcome.choice]}」を実行しましたが、もう一度確認するとまだ確認が必要です。両方の版は保管しています。`;
}

function ConflictItem({ root, target, activeConversationId, disabled, onResolve }: {
  root: FileSystemDirectoryHandle; target: ConflictRef; activeConversationId: string | null; disabled: boolean;
  onResolve: (snapshot: ConflictSnapshot, choice: ConflictChoice) => Promise<ConflictOutcome>;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ConflictView | null>(null);
  const [selected, setSelected] = useState<ConflictChoice | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSelected(null);
    setView(null);
    try { setView(await inspectConflict(root, target, activeConversationId)); }
    catch (error) { console.error("[Tsumugi] conflict: could not read the versions", error); setMessage("内容を読み取れませんでした。何も変更していません。"); }
  }, [root, target, activeConversationId]);

  async function run(choice: ConflictChoice) {
    if (!view?.snapshot) return;
    setWorking(true);
    setMessage(null);
    try {
      const outcome = await onResolve(view.snapshot, choice);
      setMessage(outcomeText(outcome));
      await load();
    } catch (error) {
      console.error("[Tsumugi] conflict: the choice did not complete", error);
      setMessage(STOPPED_TEXT);
    } finally { setWorking(false); }
  }

  return (
    <div data-testid="vault-conflict-item" className="flex flex-col gap-2 rounded-lg border border-stone-300/50 p-2 text-xs dark:border-stone-600/50">
      <div className="flex items-center justify-between gap-2">
        <span>{RECORD_TYPE_TEXT[target.recordType]}{view?.date ? `（${view.date}）` : ""}</span>
        <button className={button} data-testid="vault-conflict-open" onClick={() => { const next = !open; setOpen(next); if (next) void load(); }}>{open ? "閉じる" : "内容を見る"}</button>
      </div>
      {message && <span role="status" data-testid="vault-conflict-message" className="text-amber-700 dark:text-amber-400">{message}</span>}
      {open && !view && !message && <span>読み込んでいます…</span>}
      {open && view && (
        <div className="flex flex-col gap-2">
          {view.state === "blocked" && view.blockReason && <span data-testid="vault-conflict-blocked">{BLOCK_REASON_TEXT[view.blockReason]}</span>}
          {view.state === "same" && <span>端末と保存先の内容は今は同じです。止まっていた保存を再開できます。</span>}
          {view.state === "absent" && <span>保存先にこの記録のファイルがありません。端末の版を保存し直せます。</span>}
          {view.state === "differs" && (
            <>
              <div data-testid="vault-conflict-diff" className={pre}>
                {(view.diff ?? []).map((line, i) => (
                  <div key={i} className={line.kind === "device" ? "bg-sky-200/50 dark:bg-sky-900/40" : line.kind === "vault" ? "bg-amber-200/60 dark:bg-amber-900/40" : "text-stone-500 dark:text-stone-400"}>
                    {line.kind === "device" ? "端末 " : line.kind === "vault" ? "保存先 " : ""}{line.text || " "}
                  </div>
                ))}
              </div>
              <details><summary className="cursor-pointer">端末の版の全文</summary><div data-testid="vault-conflict-device" className={pre}>{view.deviceText}</div></details>
              <details><summary className="cursor-pointer">保存先の版の全文</summary><div data-testid="vault-conflict-vault" className={pre}>{view.vaultText}</div></details>
              {view.adoptVaultBlock && <span data-testid="vault-conflict-adopt-note" className="text-stone-500 dark:text-stone-400">{ADOPT_VAULT_BLOCK_TEXT[view.adoptVaultBlock]}</span>}
            </>
          )}
          {view.choices.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {view.choices.map((choice, i) => (
                <button key={choice} data-testid={`vault-conflict-choice-${choice}`} className={button} disabled={disabled || working} onClick={() => setSelected(choice)}>
                  {CHOICE_LABEL[choice]}{i === 0 && view.state === "differs" ? "（既定）" : ""}
                </button>
              ))}
            </div>
          )}
          {selected && (
            <div data-testid="vault-conflict-confirmation" className="flex flex-col gap-1 rounded-lg bg-stone-100/70 p-2 dark:bg-black/20">
              <span className="font-medium">「{CHOICE_LABEL[selected]}」を実行すると</span>
              <span>{choiceExplanation(selected, view).changes}</span>
              <span>{choiceExplanation(selected, view).mayLose}</span>
              {selected !== "resume" && <span className="text-stone-500 dark:text-stone-400">実行の前に、端末と保存先全体のバックアップと両方の版を残します。確認している間に内容が変わっていれば、何も変更せず中止します。</span>}
              <div className="flex gap-2">
                <button data-testid="vault-conflict-confirm" className={button} disabled={disabled || working} onClick={() => void run(selected)}>{working ? "実行しています…" : "実行する"}</button>
                <button className={button} disabled={working} onClick={() => setSelected(null)}>やめる</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KeptVersions({ root, refreshKey }: { root: FileSystemDirectoryHandle; refreshKey: number }) {
  const [kept, setKept] = useState<{ listed: KeptVersion[]; others: number; unreadable: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void listKeptVersions(root).then(({ versions, unreadable }) => {
      if (alive.current) setKept({ listed: versions.filter((v) => v.choice === "keep-both"), others: versions.filter((v) => v.choice !== "keep-both").length, unreadable });
    }).catch((error) => console.error("[Tsumugi] conflict: could not list the kept versions", error));
    return () => { alive.current = false; };
  }, [root, refreshKey]);
  if (!kept || (kept.listed.length === 0 && kept.others === 0 && kept.unreadable === 0)) return null;
  return (
    <div data-testid="vault-kept-versions" className="flex flex-col gap-1 text-xs">
      <span className="font-medium">保管している別の版（{kept.listed.length}件）</span>
      {kept.listed.map((v) => (
        <details key={v.id} data-testid="vault-kept-version">
          <summary className="cursor-pointer">{RECORD_TYPE_TEXT[v.recordType]}（{v.createdAt.slice(0, 10)}に保管）</summary>
          <div className={pre}>{v.vaultText}</div>
        </details>
      ))}
      {kept.others > 0 && <span className="text-stone-500 dark:text-stone-400">採用しなかった版{kept.others}件も、保存先の管理領域に残しています。</span>}
      {kept.unreadable > 0 && <span className="text-amber-700 dark:text-amber-400">読み取れない保管ファイルが{kept.unreadable}件あります。削除はしていません。</span>}
    </div>
  );
}

export default function VaultConflictSection({ root, conflicts, activeConversationId, disabled, onResolve }: {
  root: FileSystemDirectoryHandle; conflicts: ConflictRef[]; activeConversationId: string | null; disabled: boolean;
  onResolve: (snapshot: ConflictSnapshot, choice: ConflictChoice) => Promise<ConflictOutcome>;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const resolve = async (snapshot: ConflictSnapshot, choice: ConflictChoice) => {
    try { return await onResolve(snapshot, choice); } finally { setRefreshKey((k) => k + 1); }
  };
  return (
    <div data-testid="vault-conflicts" className="flex flex-col gap-2">
      {conflicts.map((target) => <ConflictItem key={refKey(target)} root={root} target={target} activeConversationId={activeConversationId} disabled={disabled} onResolve={resolve} />)}
      <KeptVersions root={root} refreshKey={refreshKey} />
    </div>
  );
}
