"use client";

import { useEffect, useRef, useState } from "react";
import { readBackupDeviceSnapshot } from "@/lib/db";
import type { VaultBackend } from "@/lib/vault";
import { withVaultWorldRead } from "@/lib/vaultWorldLock";
import { APP_BUILD_ID } from "@/lib/recoveryBackgroundCheck";
import { backupFailureText, backupSummaryText, createVaultBackup, verifyExportedBackup, type BackupResult } from "@/lib/vaultBackup";

/**
 * 設定の「バックアップ」（保存先の汎用修復 段階2）。端末と保存先の両方を1つのZIPへ退避し、保存先の`.tsumugi/repair-backup/`へ書いて
 * 読み戻して照合する。端末の外への書き出しも、書き出したファイルを読み戻して照合できるまで「確認済み」とは言わない。
 * 既存のデータは読むだけで、保存・確認・修復の処理とは独立に動く（ChatScreenの状態には触れない）。
 */
type Created = Extract<BackupResult, { ok: true }>;
type ExportState =
  | { kind: "none" }
  | { kind: "exporting" }
  | { kind: "unverified" } // 共有・ダウンロードに渡した。まだ書き出し先のファイルを確認していない
  | { kind: "verified" }
  | { kind: "error"; message: string };
type State =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "created"; root: FileSystemDirectoryHandle; backup: Created; exported: ExportState }
  | { kind: "failed"; message: string };

type SavePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;

const runIdNow = () => `backup-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}-${Math.random().toString(36).slice(2, 8)}`;
const button = "shrink-0 rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-600 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-600/60 dark:text-stone-300 dark:hover:bg-white/5";

export default function VaultBackupSection({ root, backend, disabled }: { root: FileSystemDirectoryHandle; backend: VaultBackend | null; disabled: boolean }) {
  const [stored, setState] = useState<State>({ kind: "idle" });
  // 保存先が変わったら、前の保存先のバックアップは表示しない（別の保存先のものとして書き出さない）
  const state: State = stored.kind === "created" && stored.root !== root ? { kind: "idle" } : stored;
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const rootRef = useRef(root);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { rootRef.current = root; }, [root]);

  async function create() {
    const startedFor = root;
    setState({ kind: "working" });
    const result = await createVaultBackup({
      root,
      readDevice: readBackupDeviceSnapshot,
      withWorldRead: withVaultWorldRead,
      now: () => new Date().toISOString(),
      runId: runIdNow,
      build: APP_BUILD_ID,
      backend: backend ?? "unknown",
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      isCancelled: () => !alive.current || rootRef.current !== startedFor,
    });
    if (!alive.current || rootRef.current !== startedFor) return;
    setState(result.ok ? { kind: "created", root: startedFor, backup: result, exported: { kind: "none" } } : { kind: "failed", message: backupFailureText(result) });
  }

  const setExported = (backup: Created, exported: ExportState) => { if (alive.current) setState((s) => (s.kind === "created" && s.backup.runId === backup.runId ? { ...s, exported } : s)); };

  async function exportOut(backup: Created) {
    setExported(backup, { kind: "exporting" });
    const name = `tsumugi-backup-${backup.runId.replace(/^backup-/, "")}.zip`;
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    try {
      if (typeof picker === "function") {
        // PC：保存ダイアログで選んだファイルへ書き、そのファイルを読み戻して照合する
        const handle = await picker({ suggestedName: name, types: [{ description: "tsumugiのバックアップ", accept: { "application/zip": [".zip"] } }] });
        const stream = await handle.createWritable();
        try { await stream.write(backup.zip as BufferSource); await stream.close(); }
        catch (error) { try { await stream.abort(); } catch { /* keep the original failure */ } throw error; }
        const check = await verifyExportedBackup(new Uint8Array(await (await handle.getFile()).arrayBuffer()), backup);
        setExported(backup, check.ok ? { kind: "verified" } : { kind: "error", message: "書き出したファイルを読み戻して確認できませんでした。もう一度書き出してください。" });
        return;
      }
      const file = new File([backup.zip as BlobPart], name, { type: "application/zip" });
      let shared = false;
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "tsumugiのバックアップ" }); shared = true; }
        catch (error) { if (error instanceof DOMException && error.name === "AbortError") { setExported(backup, { kind: "none" }); return; } }
      }
      if (!shared) {
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      // 共有・ダウンロードでは、どこに保存されたかをアプリは読めない。ユーザーに選んでもらって照合するまでは「確認済み」にしない
      setExported(backup, { kind: "unverified" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") { setExported(backup, { kind: "none" }); return; }
      setExported(backup, { kind: "error", message: "端末の外へ書き出せませんでした。もう一度お試しください。" });
    }
  }

  async function verifyPicked(backup: Created, file: File | undefined) {
    if (!file) return;
    try {
      const check = await verifyExportedBackup(new Uint8Array(await file.arrayBuffer()), backup);
      setExported(backup, check.ok ? { kind: "verified" }
        : { kind: "error", message: check.reason === "different-file" ? "選んだファイルは、今回のバックアップではありません。今回書き出したファイルを選んでください。" : "選んだファイルは途中で欠けているか、壊れています。もう一度書き出してください。" });
    } catch {
      setExported(backup, { kind: "error", message: "選んだファイルを読めませんでした。" });
    }
  }

  return (
    <div data-testid="vault-backup" className="flex flex-col gap-2 text-xs text-stone-500 dark:text-stone-400">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span>バックアップ</span>
          <span className="text-[11px] text-stone-400 dark:text-stone-500">
            端末と保存先の両方の記録（保存先へ未反映の記録や、内容の違う版も含む）を、1つのファイルに退避します。今ある記録は変更しません。
          </span>
        </div>
        <button onClick={() => void create()} disabled={disabled || state.kind === "working" || (state.kind === "created" && state.exported.kind === "exporting")} className={button}>
          {state.kind === "working" ? "作成中…" : "バックアップを作成"}
        </button>
      </div>
      {state.kind === "failed" && <p role="alert" className="text-red-600 dark:text-red-400">{state.message}</p>}
      {state.kind === "created" && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-stone-50/80 px-3 py-2 text-stone-600 dark:bg-white/5 dark:text-stone-300">
          <span>バックアップを作成し、読み戻して内容を確認しました。</span>
          <span>{backupSummaryText(state.backup.summary)}</span>
          <span className="text-[11px] text-stone-400 dark:text-stone-500">保存先の中（.tsumugi/repair-backup）に保存しました。</span>
          {backend === "opfs" && state.exported.kind !== "verified" && (
            <span className="text-[11px]">この端末の安全な領域は、アプリのデータと一緒に消えることがあります。端末の外にも書き出してください。</span>
          )}
          {state.exported.kind === "verified" && <span data-testid="vault-backup-exported">端末の外に書き出し、そのファイルを読み戻して内容を確認しました。</span>}
          {state.exported.kind === "unverified" && <span>書き出しました。まだ確認していません。保存したファイルを選ぶと、内容が正しいかを確認できます。</span>}
          {state.exported.kind === "error" && <span role="alert" className="text-red-600 dark:text-red-400">{state.exported.message}</span>}
          <div className="flex flex-wrap gap-2">
            {state.exported.kind !== "verified" && (
              <button onClick={() => void exportOut(state.backup)} disabled={state.exported.kind === "exporting"} className={button}>
                {state.exported.kind === "exporting" ? "書き出し中…" : "端末の外に書き出す"}
              </button>
            )}
            {(state.exported.kind === "unverified" || state.exported.kind === "error") && (
              <button onClick={() => fileInput.current?.click()} className={button}>書き出したファイルを確認する</button>
            )}
          </div>
          <input ref={fileInput} type="file" accept=".zip,application/zip" className="hidden" data-testid="vault-backup-verify-input"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void verifyPicked(state.backup, file); }} />
        </div>
      )}
    </div>
  );
}
