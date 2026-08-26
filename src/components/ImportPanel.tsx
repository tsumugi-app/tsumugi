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
}: {
  vaultHandle: FileSystemDirectoryHandle | null;
  onClose: () => void;
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
    if (!textContent.trim() || saveStatus === "saving") return;
    setSaveStatus("saving");
    setErrorMessage("");
    try {
      const draft = await importText({ text: textContent, title: textTitle });
      const source = createSource(draft);
      const { indexedDbFailed } = await persistSource(vaultHandle, source);
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
    if (!markdownFile || saveStatus === "saving") return;
    setSaveStatus("saving");
    setErrorMessage("");
    try {
      const text = await markdownFile.text();
      const draft = await importMarkdown({ markdown: text, fileName: markdownFile.name });
      const source = createSource(draft);
      const { indexedDbFailed } = await persistSource(vaultHandle, source);
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
                disabled={!textContent.trim() || saveStatus === "saving"}
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
                disabled={!markdownFile || saveStatus === "saving"}
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
