"use client";

import type {
  DataActionFeedback,
  RestoreCandidate,
  RestoreStatus,
  SupportedChatProvider,
  VaultConnectFeedback,
  VaultStatus,
} from "./ChatScreen";
import type { VaultBackend } from "@/lib/vault";

/**
 * ChatScreen.tsx下部にあった設定領域（APIキー・保存先）を、⚙から開くオーバーレイへ移した表示専用コンポーネント。
 * 状態・保存/削除ロジックは一切持たず、すべてChatScreen.tsx側のstate/handlerをそのままpropsで受け取って表示するだけ
 * （ApiKeySetup.tsxと同じ「fixed inset-0のオーバーレイ」パターンを踏襲する）。
 */
export default function SettingsPanel({
  chatProvider,
  keyStatusByProvider,
  vaultStatus,
  vaultHandle,
  vaultBackend,
  vaultConnectFeedback,
  restoreCandidate,
  restoreStatus,
  onClose,
  onDeleteApiKey,
  onOpenApiKeySetup,
  onSelectChatProvider,
  onConnectVault,
  onReauthorizeVault,
  onRestoreFromVault,
  exportDataFeedback,
  deleteDataFeedback,
  onExportData,
  onDeleteData,
}: {
  chatProvider: SupportedChatProvider;
  keyStatusByProvider: Record<SupportedChatProvider, boolean>;
  vaultStatus: VaultStatus;
  vaultHandle: FileSystemDirectoryHandle | null;
  /** "opfs"の場合、PCのフォルダ選択とは異なり選び直す先が無いため「変更する」を出さない。 */
  vaultBackend: VaultBackend | null;
  vaultConnectFeedback: VaultConnectFeedback | null;
  restoreCandidate: RestoreCandidate | null;
  restoreStatus: RestoreStatus;
  onClose: () => void;
  onDeleteApiKey: (provider: SupportedChatProvider) => void;
  onOpenApiKeySetup: (provider: SupportedChatProvider) => void;
  onSelectChatProvider: (provider: SupportedChatProvider) => void;
  onConnectVault: () => void;
  /** Android等：以前選択したフォルダへの書き込み許可がリロードで失効した状態から、同じhandleへ再許可を求める。 */
  onReauthorizeVault: () => void;
  onRestoreFromVault: () => void;
  /** データ管理（エクスポート/削除）。iPhone/iPad等のOPFSバックエンド時のみUIを表示する。 */
  exportDataFeedback: DataActionFeedback | null;
  deleteDataFeedback: DataActionFeedback | null;
  onExportData: () => void;
  onDeleteData: () => void;
}) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col gap-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <p className="text-lg text-stone-800 dark:text-stone-100">設定</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-300/70 px-4 py-1.5 text-xs text-stone-600 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-300 dark:hover:bg-white/5"
          >
            閉じる
          </button>
        </div>

        <section className="flex flex-col gap-3">
          <p className="text-sm text-stone-500 dark:text-stone-400">AI</p>

          <div className="flex flex-col gap-2 text-xs text-stone-500 dark:text-stone-400">
            <div className="flex items-center justify-between gap-4">
              <span>Gemini APIキー：{keyStatusByProvider.gemini ? "設定済み" : "未設定（Tsumugi提供のキーを使用中）"}</span>
              <div className="flex shrink-0 gap-3">
                <button
                  onClick={() => onOpenApiKeySetup("gemini")}
                  className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                >
                  {keyStatusByProvider.gemini ? "変更する" : "設定する"}
                </button>
                {keyStatusByProvider.gemini && (
                  <button
                    onClick={() => onDeleteApiKey("gemini")}
                    className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                  >
                    削除
                  </button>
                )}
              </div>
            </div>
            {!keyStatusByProvider.gemini && (
              <p className="text-[11px] text-stone-400 dark:text-stone-500">
                Geminiは、APIキーを設定しなくてもTsumugiが用意したキーで利用できます。自分のAPIキーを使いたい場合のみ設定してください。
              </p>
            )}

            <div className="flex items-center justify-between gap-4">
              <span>OpenAI APIキー：{keyStatusByProvider.openai ? "設定済み" : "未設定"}</span>
              <div className="flex shrink-0 gap-3">
                <button
                  onClick={() => onOpenApiKeySetup("openai")}
                  className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                >
                  {keyStatusByProvider.openai ? "変更する" : "設定する"}
                </button>
                {keyStatusByProvider.openai && (
                  <button
                    onClick={() => onDeleteApiKey("openai")}
                    className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                  >
                    削除
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 pt-1 text-xs text-stone-500 dark:text-stone-400">
            <span>チャットで使うAI</span>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => onSelectChatProvider("gemini")}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  chatProvider === "gemini"
                    ? "border-stone-800 bg-stone-800 text-stone-50 dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900"
                    : "border-stone-300/60 text-stone-500 hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                }`}
              >
                Gemini
              </button>
              <button
                onClick={() => onSelectChatProvider("openai")}
                disabled={!keyStatusByProvider.openai}
                title={keyStatusByProvider.openai ? undefined : "先にOpenAI APIキーを設定してください"}
                className={`rounded-full border px-3 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  chatProvider === "openai"
                    ? "border-stone-800 bg-stone-800 text-stone-50 dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900"
                    : "border-stone-300/60 text-stone-500 hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                }`}
              >
                OpenAI
              </button>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3 border-t border-black/5 pt-6 dark:border-white/10">
          <p className="text-sm text-stone-500 dark:text-stone-400">保存先</p>

          {vaultConnectFeedback && (
            <div
              className={`text-xs ${
                vaultConnectFeedback.kind === "error"
                  ? "text-red-600 dark:text-red-400"
                  : "text-stone-500 dark:text-stone-400"
              }`}
            >
              {vaultConnectFeedback.message}
            </div>
          )}

          {vaultStatus === "connected" && vaultHandle && (
            <div className="flex items-center justify-between gap-4 text-xs text-stone-500 dark:text-stone-400">
              <span>保存先：{vaultBackend === "opfs" ? "この端末の安全な領域" : vaultHandle.name}</span>
              {/*
                OPFS（スマホ等のフォールバック）には、PCのようにユーザーが選び直せる
                別のフォルダという概念が無い（navigator.storage.getDirectory()は常に同じ
                オリジン専有領域を返す）。フォルダ選択ダイアログを持たないため「変更する」
                ボタンはFile System Access APIバックエンド（PC）の時だけ表示する。
              */}
              {vaultBackend !== "opfs" && (
                <button
                  onClick={onConnectVault}
                  className="shrink-0 rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                >
                  変更する
                </button>
              )}
            </div>
          )}

          {vaultStatus === "needs-permission" && vaultHandle && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              {/*
                以前選んだフォルダ（vaultHandle）自体はIndexedDBに残っているが、ブラウザ管理の
                書き込み許可がリロードで失効している状態（Android Chrome等で発生）。
                「保存先が失われた」ように見せないため、フォルダ名を出した上で再許可を促す。
                新しいフォルダの選び直し（「変更する」ボタン）は今回のスコープ外のため出さない。
              */}
              <span>「{vaultHandle.name}」への保存アクセスが必要です。</span>
              <button
                onClick={onReauthorizeVault}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                アクセスを再許可
              </button>
            </div>
          )}

          {vaultStatus === "not-connected" && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>記憶を保存する場所を選んでください。</span>
              <button
                onClick={onConnectVault}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                保存先を選ぶ
              </button>
            </div>
          )}

          {vaultStatus === "unsupported" && (
            <div className="rounded-xl bg-stone-100 px-3 py-2 text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-400">
              このブラウザではファイルへの直接保存に対応していません。Chrome / Edge でお試しください（会話は一時的にこの端末内にのみ保存されます）。
            </div>
          )}

          {restoreCandidate && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>このVaultには以前の記憶が見つかりました（{restoreCandidate.newCount}件）。復元しますか？</span>
              <button
                onClick={onRestoreFromVault}
                disabled={restoreStatus === "restoring"}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                {restoreStatus === "restoring" ? "復元中…" : "復元する"}
              </button>
            </div>
          )}

          {restoreStatus === "done" && (
            <div className="text-xs text-stone-500 dark:text-stone-400">記憶を復元しました。</div>
          )}
        </section>

        {/*
          データ管理（エクスポート・削除）。iPhone/iPad等、OPFS（この端末の安全な領域）に
          保存している場合のみ表示する。PC/AndroidのFile System Access API Vault
          （ユーザーが選んだ実フォルダ）は、Finder/エクスプローラーから直接読み書き
          できるため、この導線自体を出さない（vaultBackend !== "opfs"では非表示）。
        */}
        {vaultBackend === "opfs" && (
          <section className="flex flex-col gap-3 border-t border-black/5 pt-6 dark:border-white/10">
            <p className="text-sm text-stone-500 dark:text-stone-400">データ</p>

            <div className="flex items-center justify-between gap-4 text-xs text-stone-500 dark:text-stone-400">
              <div className="flex flex-col gap-0.5">
                <span>Markdownをエクスポート</span>
                <span className="text-[11px] text-stone-400 dark:text-stone-500">
                  この端末に保存されているtsumugiのデータを外部へ保存します。
                </span>
              </div>
              <button
                onClick={onExportData}
                disabled={exportDataFeedback?.kind === "busy"}
                className="shrink-0 rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
              >
                {exportDataFeedback?.kind === "busy" ? "エクスポート中…" : "エクスポート"}
              </button>
            </div>
            {exportDataFeedback && exportDataFeedback.kind !== "busy" && (
              <p
                className={`text-xs ${
                  exportDataFeedback.kind === "error"
                    ? "text-red-600 dark:text-red-400"
                    : "text-stone-500 dark:text-stone-400"
                }`}
              >
                {exportDataFeedback.message}
              </p>
            )}

            <div className="flex items-center justify-between gap-4 pt-1 text-xs text-stone-500 dark:text-stone-400">
              <div className="flex flex-col gap-0.5">
                <span>この端末のデータを削除</span>
                <span className="text-[11px] text-stone-400 dark:text-stone-500">
                  この端末に保存されているtsumugiのデータを削除します。
                </span>
              </div>
              <button
                onClick={onDeleteData}
                disabled={deleteDataFeedback?.kind === "busy"}
                className="shrink-0 rounded-full border border-red-300/60 px-3 py-1 text-xs text-red-600 transition hover:bg-red-500/10 disabled:opacity-50 dark:border-red-700/60 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                {deleteDataFeedback?.kind === "busy" ? "削除中…" : "削除する"}
              </button>
            </div>
            {deleteDataFeedback && deleteDataFeedback.kind !== "busy" && (
              <p className="text-xs text-red-600 dark:text-red-400">{deleteDataFeedback.message}</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
