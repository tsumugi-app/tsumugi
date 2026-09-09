"use client";

import { useState } from "react";
import { createSource, persistSource } from "@/lib/source";
import { importText } from "@/lib/importers/text";
import { importMarkdown } from "@/lib/importers/markdown";

type ImportView = "menu" | "text" | "markdown";
type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * ⚙のSettingsPanelとは異なり、複数ステップ（メニュー→各Importerのフォーム→保存）を持つため、
 * ApiKeySetup.tsxと同じく状態（どの画面か・フォーム値・保存状態）を自身で持つ自己完結型の
 * オーバーレイにする（ChatScreen.tsx側の状態追加は開閉フラグ1つで済む）。
 *
 * 保存は必ず importXxx() → createSource() → persistSource() の順で行う。
 * Importer自身（src/lib/importers/*.ts）には一切変更を加えていない。
 */
export default function ImportPanel({
  vaultHandle,
  onClose,
  disabled = false,
  trackTask,
}: {
  vaultHandle: FileSystemDirectoryHandle | null;
  onClose: () => void;
  /** Vault境界の安全性：親（ChatScreen.tsx）が切替処理中のときtrue。保存ボタンを無効化する。 */
  disabled?: boolean;
  /**
   * Vault境界の安全性：Source保存（persistSource）をMemory Worldへ影響する非同期処理として
   * 親（ChatScreen.tsx）へ追跡させるためのフック。渡さなかった場合は追跡しない
   * （後方互換。呼び出し元を限定しないよう任意にしている）。
   */
  trackTask?: <T>(promise: Promise<T>) => Promise<T>;
}) {
  const [view, setView] = useState<ImportView>("menu");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");

  const [markdownFile, setMarkdownFile] = useState<File | null>(null);

  function goToView(next: ImportView) {
    setView(next);
    setSaveStatus("idle");
    setErrorMessage("");
  }

  async function handleSaveText() {
    if (!textContent.trim() || saveStatus === "saving" || disabled) return;
    setSaveStatus("saving");
    setErrorMessage("");
    // Vault境界の安全性（Codexレビュー指摘High-2対応）：importText（パース）→
    // createSource → persistSourceまでの一連の流れを、1つのMemory World taskとして
    // 最初のawaitより前から追跡する（persistSourceの呼び出しだけを追跡すると、
    // importText実行中にVault切替が始められてしまう）。trackTask()はこのIIFE呼び出しの
    // 直後・同期的に呼ぶため、内部の最初のawait（importText）が解決するより前に
    // 追跡対象へ登録される。ImportPanelがこの後アンマウントされても、
    // taskはChatScreen側のpendingMemoryTasksRef（このコンポーネントのstateではない）に
    // 留まり続けるため、追跡から外れない。
    const task = (async () => {
      const draft = await importText({ text: textContent, title: textTitle });
      const source = createSource(draft);
      return persistSource(vaultHandle, source);
    })();
    const tracked = trackTask ? trackTask(task) : task;
    try {
      const { indexedDbFailed } = await tracked;
      if (indexedDbFailed) {
        setSaveStatus("error");
        setErrorMessage("保存に失敗しました。もう一度お試しください。");
        return;
      }
      setSaveStatus("saved");
      setTextTitle("");
      setTextContent("");
    } catch (error) {
      console.error("Failed to import text", error);
      setSaveStatus("error");
      setErrorMessage("保存に失敗しました。もう一度お試しください。");
    }
  }

  async function handleSaveMarkdown() {
    if (!markdownFile || saveStatus === "saving" || disabled) return;
    setSaveStatus("saving");
    setErrorMessage("");
    // Vault境界の安全性（Codexレビュー指摘High-2対応）：ファイル読み込み（file.text()）
    // →importMarkdown（パース）→createSource→persistSourceまでの一連の流れを、
    // 1つのMemory World taskとして最初のawaitより前から追跡する（handleSaveText参照）。
    const task = (async () => {
      const text = await markdownFile.text();
      const draft = await importMarkdown({ markdown: text, fileName: markdownFile.name });
      const source = createSource(draft);
      return persistSource(vaultHandle, source);
    })();
    const tracked = trackTask ? trackTask(task) : task;
    try {
      const { indexedDbFailed } = await tracked;
      if (indexedDbFailed) {
        setSaveStatus("error");
        setErrorMessage("ファイルの読み込みまたは保存に失敗しました。");
        return;
      }
      setSaveStatus("saved");
      setMarkdownFile(null);
    } catch (error) {
      console.error("Failed to import markdown file", error);
      setSaveStatus("error");
      setErrorMessage("ファイルの読み込みまたは保存に失敗しました。");
    }
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col gap-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <p className="text-lg text-stone-800 dark:text-stone-100">Import</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-300/70 px-4 py-1.5 text-xs text-stone-600 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-300 dark:hover:bg-white/5"
          >
            閉じる
          </button>
        </div>

        {view === "menu" && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => goToView("text")}
              className="rounded-2xl border border-stone-300/70 px-5 py-4 text-left text-base text-stone-800 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-100 dark:hover:border-stone-400 dark:hover:bg-stone-900"
            >
              Text
            </button>
            <button
              type="button"
              onClick={() => goToView("markdown")}
              className="rounded-2xl border border-stone-300/70 px-5 py-4 text-left text-base text-stone-800 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-100 dark:hover:border-stone-400 dark:hover:bg-stone-900"
            >
              Markdown
            </button>
          </div>
        )}

        {view === "text" && (
          <div className="flex flex-col gap-3">
            <input
              type="text"
              value={textTitle}
              onChange={(event) => setTextTitle(event.target.value)}
              placeholder="タイトル（任意）"
              className="rounded-xl border border-stone-300/70 bg-white/70 px-3 py-2 text-sm outline-none placeholder:text-stone-400 dark:border-stone-700/70 dark:bg-stone-900/60"
            />
            <textarea
              value={textContent}
              onChange={(event) => setTextContent(event.target.value)}
              placeholder="本文"
              rows={8}
              className="resize-none rounded-xl border border-stone-300/70 bg-white/70 px-3 py-2 text-sm outline-none placeholder:text-stone-400 dark:border-stone-700/70 dark:bg-stone-900/60"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => goToView("menu")}
                className="rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
              >
                戻る
              </button>
              <button
                type="button"
                onClick={() => void handleSaveText()}
                disabled={!textContent.trim() || saveStatus === "saving" || disabled}
                className="rounded-xl bg-stone-800 px-4 py-2 text-sm text-stone-50 transition disabled:opacity-40 dark:bg-stone-200 dark:text-stone-900"
              >
                {saveStatus === "saving" ? "保存しています…" : "保存する"}
              </button>
            </div>
            {saveStatus === "saved" && (
              <p className="text-xs text-stone-400 dark:text-stone-500">保存されました。</p>
            )}
            {saveStatus === "error" && (
              <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
            )}
          </div>
        )}

        {view === "markdown" && (
          <div className="flex flex-col gap-3">
            <input
              type="file"
              accept=".md,.markdown,text/markdown"
              onChange={(event) => {
                setMarkdownFile(event.target.files?.[0] ?? null);
                setSaveStatus("idle");
                setErrorMessage("");
              }}
              className="text-sm text-stone-600 dark:text-stone-300"
            />
            {markdownFile && (
              <p className="text-xs text-stone-500 dark:text-stone-400">選択中：{markdownFile.name}</p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => goToView("menu")}
                className="rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
              >
                戻る
              </button>
              <button
                type="button"
                onClick={() => void handleSaveMarkdown()}
                disabled={!markdownFile || saveStatus === "saving" || disabled}
                className="rounded-xl bg-stone-800 px-4 py-2 text-sm text-stone-50 transition disabled:opacity-40 dark:bg-stone-200 dark:text-stone-900"
              >
                {saveStatus === "saving" ? "保存しています…" : "保存する"}
              </button>
            </div>
            {saveStatus === "saved" && (
              <p className="text-xs text-stone-400 dark:text-stone-500">保存されました。</p>
            )}
            {saveStatus === "error" && (
              <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
