"use client";

import { useState } from "react";
import type {
  DataActionFeedback,
  RestoreCandidate,
  RestoreStatus,
  SupportedChatProvider,
  VaultConnectFeedback,
  VaultLightCheckStatus,
  VaultResyncFeedback,
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
  vaultActionsDisabled = false,
  exportDataFeedback,
  deleteDataFeedback,
  onExportData,
  onDeleteData,
  vaultResyncFeedback,
  vaultResyncTakingLong = false,
  onResyncVault,
  vaultLightCheckStatus,
  onConfirmVaultLightCheck,
  onApplyVaultLightCheck,
  onRetryVaultLightCheck,
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
  /** Vault境界の安全性：別Vaultへの切替処理中はtrue。切替中は「変更する」「保存先を選ぶ」
   * 「アクセスを再許可」「復元する」を無効化する（新規のVault操作の開始を防ぐ）。既定false。 */
  vaultActionsDisabled?: boolean;
  /** データ管理（エクスポート/削除）。iPhone/iPad等のOPFSバックエンド時のみUIを表示する。 */
  exportDataFeedback: DataActionFeedback | null;
  deleteDataFeedback: DataActionFeedback | null;
  onExportData: () => void;
  onDeleteData: () => void;
  /** Step 5：「Vaultを再同期」の進行状況・結果。 */
  vaultResyncFeedback: VaultResyncFeedback | null;
  /**
   * Android実機不具合対応：再同期が"busy"のまま一定時間を超えた場合にtrue。
   * File System Access APIの個々のI/Oはキャンセルできないため、処理そのものを
   * 止めることはできない——ユーザーへの状況共有と、ページ再読み込みによる
   * 中断という選択肢を示すためだけに使う。既定false。
   */
  vaultResyncTakingLong?: boolean;
  onResyncVault: () => void;
  /**
   * 軽量「外部の変更」検知フロー（Level 1〜4）のUI状態。"idle"の間は何も
   * 表示しない（起動時のLevel 1/2で候補が1件も無い場合も含む）。
   */
  vaultLightCheckStatus: VaultLightCheckStatus;
  /** 「確認する」＝Level 3（candidateのみ本文read・分類）を開始する。 */
  onConfirmVaultLightCheck: () => void;
  /** 「変更を反映」＝Level 4（apply直前の再検証＋candidateのみapply）を開始する。 */
  onApplyVaultLightCheck: () => void;
  /** 「もう一度確認する」：staleまたはerror/partial発生後、古い結果を使わずLevel 1/2からやり直す。 */
  onRetryVaultLightCheck: () => void;
}) {
  const [showResyncDetail, setShowResyncDetail] = useState(false);
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
                  disabled={vaultActionsDisabled}
                  className="shrink-0 rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                >
                  変更する
                </button>
              )}
            </div>
          )}

          {/*
            Step 5：明示的なVault再同期。Obsidian等で外部からMarkdownを移動・編集・
            追加した場合に、ユーザーが能動的に押した時だけTsumugiへ反映する
            （自動実行はしない）。Registry/IndexedDB/History Index等の内部用語は
            表示せず、Vault/Markdownという利用者が既に見慣れた言葉だけを使う。
          */}
          {vaultStatus === "connected" && vaultHandle && (
            <div className="flex flex-col gap-2 border-t border-black/5 pt-3 dark:border-white/10">
              <div className="flex items-center justify-between gap-4 text-xs text-stone-500 dark:text-stone-400">
                <div className="flex flex-col gap-0.5">
                  <span>Vaultを再同期</span>
                  <span className="text-[11px] text-stone-400 dark:text-stone-500">
                    Obsidianなどで移動・編集したMarkdownをTsumugiに反映します。
                  </span>
                </div>
                <button
                  onClick={onResyncVault}
                  disabled={vaultActionsDisabled || restoreStatus === "restoring"}
                  className="shrink-0 rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
                >
                  {vaultResyncFeedback?.kind === "busy" ? "再同期中…" : "Vaultを再同期"}
                </button>
              </div>

              {/*
                Android実機不具合対応：File System Access APIの個々のI/Oは
                キャンセルできないため（MDN仕様確認済み）、処理自体を止める手段は
                無い。せめて「時間がかかっている」ことと、ページ再読み込みで
                中断できることを案内する（無言で待たせ続けない）。
              */}
              {vaultResyncFeedback?.kind === "busy" && vaultResyncTakingLong && (
                <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-700 dark:bg-amber-950/20 dark:text-amber-400">
                  <span>再同期に時間がかかっています。</span>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="shrink-0 rounded-full border border-amber-400/60 px-2.5 py-0.5 text-[11px] transition hover:bg-amber-200/40 dark:border-amber-600/60 dark:hover:bg-amber-900/40"
                  >
                    再読み込みして中止
                  </button>
                </div>
              )}

              {vaultResyncFeedback && vaultResyncFeedback.kind !== "busy" && (
                <div className="flex flex-col gap-1">
                  <p
                    className={`whitespace-pre-line text-xs ${
                      vaultResyncFeedback.kind === "errors" || vaultResyncFeedback.kind === "error"
                        ? "text-red-600 dark:text-red-400"
                        : vaultResyncFeedback.kind === "partial"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-stone-500 dark:text-stone-400"
                    }`}
                  >
                    {vaultResyncFeedback.message}
                  </p>
                  {vaultResyncFeedback.detail && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowResyncDetail((value) => !value)}
                        className="text-[11px] text-stone-400 underline underline-offset-2 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
                      >
                        {showResyncDetail ? "詳細を隠す" : "詳細を見る"}
                      </button>
                      {showResyncDetail && (
                        <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-100 p-2 text-[10px] text-stone-500 dark:bg-stone-900 dark:text-stone-400">
                          {vaultResyncFeedback.detail}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
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
                disabled={vaultActionsDisabled}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
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
                disabled={vaultActionsDisabled}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
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

          {/*
            Codexレビュー指摘（journal lifecycle）対応：直前のVault切替が完了しないまま
            終了した形跡がある状態。通常の"not-connected"（一度も接続したことが無い）とは
            文言を分け、以前のフォルダが単に「消えた」のではなく再接続が必要であることを
            伝える。ボタン自体はonConnectVaultをそのまま使う（ChatScreen.tsx側で
            vaultStatus==="incomplete-switch"を見て専用recoveryへ自動的に振り分ける）。
          */}
          {vaultStatus === "incomplete-switch" && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>保存先の切替が完了していません。保存先を選び直してください。</span>
              <button
                onClick={onConnectVault}
                disabled={vaultActionsDisabled}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                保存先を選び直す
              </button>
            </div>
          )}

          {/*
            Codexレビュー指摘（unexpected version recovery方針）対応：journal
            versionが想定と異なる状態。"incomplete-switch"とは別扱い——専用recovery
            （onConnectVault経由）はversion自体を書き換えないため、ボタンを出しても
            復旧できない。再読み込みを促すだけの読み取り専用表示にする（ボタン無し）。
          */}
          {vaultStatus === "unsupported-journal-version" && (
            <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              保存データのバージョンを確認できません。ページを再読み込みしてください。
            </div>
          )}

          {restoreCandidate && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>このVaultには以前の記憶が見つかりました（{restoreCandidate.newCount}件）。復元しますか？</span>
              <button
                onClick={onRestoreFromVault}
                disabled={restoreStatus === "restoring" || vaultActionsDisabled}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                {restoreStatus === "restoring" ? "復元中…" : "復元する"}
              </button>
            </div>
          )}

          {restoreStatus === "done" && (
            <div className="text-xs text-stone-500 dark:text-stone-400">記憶を復元しました。</div>
          )}

          {/*
            軽量「外部の変更」検知フロー（Level 1〜4）。「Registry」「resync」
            「同期」等の内部用語は出さない。件数（"candidates-found".count）は
            実際の変更件数ではない粗い候補数のため、ここでは表示せず行の
            表示可否だけに使う——確定した内訳（編集/移動/確認が必要）は
            「確認する」実行後（"classified"）にのみ表示する。
          */}
          {vaultLightCheckStatus.kind === "checking" && (
            <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              確認しています…
            </div>
          )}

          {vaultLightCheckStatus.kind === "candidates-found" && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>外部で変更されたファイルがあります</span>
              <button
                onClick={onConfirmVaultLightCheck}
                disabled={vaultActionsDisabled}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                確認する
              </button>
            </div>
          )}

          {vaultLightCheckStatus.kind === "classifying" && (
            <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              確認しています…
            </div>
          )}

          {vaultLightCheckStatus.kind === "classified" && (
            <div className="flex flex-col gap-2 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>外部の変更が見つかりました</span>
              <span className="text-xs text-stone-500 dark:text-stone-400">
                {[
                  vaultLightCheckStatus.result.counts.added > 0 ? `追加 ${vaultLightCheckStatus.result.counts.added}件` : null,
                  vaultLightCheckStatus.result.counts.edited > 0 ? `編集 ${vaultLightCheckStatus.result.counts.edited}件` : null,
                  vaultLightCheckStatus.result.counts.moved > 0 ? `移動 ${vaultLightCheckStatus.result.counts.moved}件` : null,
                  vaultLightCheckStatus.result.counts.conflict +
                    vaultLightCheckStatus.result.counts.missing +
                    vaultLightCheckStatus.result.counts.unreadable >
                  0
                    ? `確認が必要 ${
                        vaultLightCheckStatus.result.counts.conflict +
                        vaultLightCheckStatus.result.counts.missing +
                        vaultLightCheckStatus.result.counts.unreadable
                      }件`
                    : null,
                ]
                  .filter((line): line is string => line !== null)
                  .join("　") || "変更はありませんでした"}
              </span>
              <button
                onClick={onApplyVaultLightCheck}
                disabled={vaultActionsDisabled}
                className="self-start rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                変更を反映
              </button>
            </div>
          )}

          {vaultLightCheckStatus.kind === "applying" && (
            <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              反映しています…
            </div>
          )}

          {vaultLightCheckStatus.kind === "applied" && (
            <div className="rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
              外部の変更を反映しました。
            </div>
          )}

          {vaultLightCheckStatus.kind === "partial" && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>{vaultLightCheckStatus.message}</span>
              <button
                onClick={onRetryVaultLightCheck}
                disabled={vaultActionsDisabled}
                className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
              >
                もう一度確認する
              </button>
            </div>
          )}

          {vaultLightCheckStatus.kind === "error" && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-red-50/60 px-3 py-2 text-xs text-red-600 dark:bg-red-950/20 dark:text-red-400">
              <span>{vaultLightCheckStatus.message}</span>
              <button
                onClick={onRetryVaultLightCheck}
                disabled={vaultActionsDisabled}
                className="shrink-0 rounded-full border border-red-400/60 px-3 py-1 text-xs text-red-600 transition hover:bg-red-900/5 disabled:opacity-50 dark:border-red-500/60 dark:text-red-400 dark:hover:bg-white/5"
              >
                もう一度確認する
              </button>
            </div>
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
