"use client";

import { useState } from "react";
import type {
  DataActionFeedback,
  RestoreCandidate,
  RestoreStatus,
  SupportedChatProvider,
  VaultConnectFeedback,
  VaultLightCheckStatus,
  LegacyCleanupUiStatus,
  LocalOnlyUiStatus,
  OrphanUiStatus,
  VaultStatusCheckUi,
  VaultRestoreUiStatus,
  VaultStatus,
} from "./ChatScreen";
import type { VaultBackend, VaultHoldReason } from "@/lib/vault";
import type { VaultStatusView } from "@/lib/vaultStatus";

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
  onWipeAllData,
  vaultLightCheckStatus,
  onConfirmVaultLightCheck,
  onApplyVaultLightCheck,
  onRetryVaultLightCheck,
  vaultRestoreStatus,
  onRunVaultRestoreDryRun,
  onExecuteVaultRestore,
  legacyCleanupStatus,
  onRunLegacyCleanupDryRun,
  onExecuteLegacyCleanup,
  localOnlyStatus,
  onRunLocalOnlyDryRun,
  onToggleLocalOnlyExcluded,
  onExecuteAppendLocal,
  vaultStatusView,
  vaultStatusCheck,
  onCheckVaultStatus,
  onUpdateVaultStatus,
  onCleanupVaultStatus,
  orphanStatus,
  onRunOrphanDryRun,
  onExecuteOrphanCleanup,
  vaultHoldReasons,
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
  onWipeAllData: () => void;
  /**
   * 軽量「外部の変更」検知フロー（Level 1〜4）のUI状態。"idle"の間は何も
   * 表示しない（起動時のLevel 1/2で候補が1件も無い場合も含む）。
   * 通常ユーザー向けの「保存先の外部変更」導線はこのUIに一本化する
   * （「Vaultを再同期」ボタンは通常UIから外し、advanced/debug fallbackとして
   * コードのみ残す——今回のスコープではSettingsPanelへは一切渡さない）。
   */
  vaultLightCheckStatus: VaultLightCheckStatus;
  /** 「確認する」＝Level 3（candidateのみ本文read・分類）を開始する。 */
  onConfirmVaultLightCheck: () => void;
  /** 「変更を反映」＝Level 4（apply直前の再検証＋candidateのみapply）を開始する。 */
  onApplyVaultLightCheck: () => void;
  /** 「もう一度確認する」：staleまたはerror/partial発生後、古い結果を使わずLevel 1/2からやり直す。 */
  onRetryVaultLightCheck: () => void;
  /**
   * 「保存先の記録を端末へ追加」（Vault→IndexedDBの追加専用復元）。dry-run（確認）と
   * 実行は別の操作で、実行はdry-run結果を見たユーザーが明示的に押した場合だけ行う。
   */
  vaultRestoreStatus: VaultRestoreUiStatus;
  onRunVaultRestoreDryRun: () => void;
  onExecuteVaultRestore: () => void;
  legacyCleanupStatus: LegacyCleanupUiStatus;
  onRunLegacyCleanupDryRun: () => void;
  onExecuteLegacyCleanup: () => void;
  localOnlyStatus: LocalOnlyUiStatus;
  onRunLocalOnlyDryRun: () => void;
  onToggleLocalOnlyExcluded: (key: string) => void;
  onExecuteAppendLocal: () => void;
  /** 保存先の統合表示（「最新の状態です」等）。測定結果から導出した値（`deriveVaultStatusView`）。 */
  vaultStatusView: VaultStatusView;
  vaultStatusCheck: VaultStatusCheckUi;
  onCheckVaultStatus: () => void;
  onUpdateVaultStatus: () => void;
  onCleanupVaultStatus: () => void;
  orphanStatus: OrphanUiStatus;
  onRunOrphanDryRun: () => void;
  onExecuteOrphanCleanup: () => void;
  /**
   * 実機不具合対応（HOLD表示整理）：Tsumugi自身のVault書き込みが保留されている
   * 原因別件数。null＝HOLD無し。light-check（`vaultLightCheckStatus`）とは
   * 別の仕組みであり、混ぜない——HOLDはVaultへの保存待ちの記録があることを
   * 示すだけで、外部で変更が見つかったわけではない。
   * Android実機確認の結果、full resyncを通常ユーザー向け復旧操作として使う案は
   * 採用しないことにした（重い処理が実機で終わらず固まって見える）ため、
   * ここは情報表示のみで、操作ボタンは一切出さない。
   */
  vaultHoldReasons: Record<VaultHoldReason, number> | null;
}) {
  // 保存先の技術的な確認機能（既存の4つの入口・外部変更の詳細表示）は、通常のUIには出さず、
  // `?debugLog=1`のときだけ「詳細（開発者向け）」に表示する（機能・handler・stateは削除していない）。
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  const [wipeAcknowledged, setWipeAcknowledged] = useState(false);
  const [showAdvancedVaultTools] = useState(() => {
    try {
      return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debugLog") === "1";
    } catch {
      return false;
    }
  });
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

          {/*
            起動時のVault初期化中（vaultStatus==="checking"）。以前はこの間、見出しだけが表示されていた。
            初回（完全削除後・新規インストール直後）は、保存先の準備に時間がかかることがある。
            端末内OPFSでもPCの外部フォルダでも不自然にならない、platform共通の文言にする。
          */}
          {vaultStatus === "checking" && (
            <div role="status" className="flex flex-col gap-0.5 text-xs text-stone-500 dark:text-stone-400">
              <span>保存先を準備しています…</span>
              <span className="text-[11px] text-stone-400 dark:text-stone-500">初回は少し時間がかかることがあります</span>
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
            安全性/UX修正：「Vaultを再同期」（full resync）は通常ユーザー向け導線から
            外した。保存先の外部変更は、下の軽量「外部の変更」検知フロー
            （Level 1〜4、vaultLightCheckStatus）に一本化する。full resync機能自体は
            削除せず、advanced/debug fallbackとしてChatScreen.tsx／vault.ts側に
            そのまま残す（この画面へは props を渡さない）。
          */}

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

          {/*
            保存先の統合表示（通常のUI）。基本は「✓ 最新の状態です」か「外部の変更がある可能性があります
            ［確認する］」。「確認する」を押した後だけ、実際に必要な対応を意味で説明する。内部用語
            （Registry・baseline・missing・conflict・IDB・Vault・legacy・orphan・resync）は出さない。
            「最新の状態です」は、測定が全て済んで未解決が0であることから導出した値（`vaultStatusView`）。
          */}
          {vaultStatusView.kind !== "hidden" && (
            <div className="flex flex-col gap-2 text-sm text-stone-700 dark:text-stone-300">
              {vaultStatusView.kind === "checking" && (
                <span className="text-xs text-stone-500 dark:text-stone-400">
                  {vaultStatusCheck.kind === "working" ? vaultStatusCheck.label : "確認しています…"}
                </span>
              )}

              {vaultStatusView.kind === "latest" && <span>✓ 最新の状態です</span>}

              {vaultStatusView.kind === "maybe" && (
                <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 dark:bg-amber-950/20">
                  <span>
                    {vaultStatusView.reason === "local"
                      ? "この端末に、保存先へ反映されていない記録がある可能性があります"
                      : "外部の変更がある可能性があります"}
                  </span>
                  <button
                    onClick={onCheckVaultStatus}
                    disabled={vaultActionsDisabled}
                    className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                  >
                    確認する
                  </button>
                </div>
              )}

              {vaultStatusView.kind === "review" && vaultStatusCheck.kind === "ready" && (
                <div className="flex flex-col gap-2 rounded-xl bg-amber-50/60 px-3 py-2 text-xs dark:bg-amber-950/20">
                  {(vaultStatusView.hasUpdate || vaultStatusView.hasCleanup) && (
                    <span className="text-sm">保存先に変更が見つかりました。</span>
                  )}
                  {vaultStatusCheck.findings.summary.map((line) => (
                    <span key={line}>・{line}</span>
                  ))}
                  {vaultStatusCheck.findings.details.filter((group) => !group.heading.startsWith("確認が必要")).length > 0 && (
                    <details className="text-stone-600 dark:text-stone-300">
                      <summary className="cursor-pointer">内容を確認</summary>
                      <div className="mt-2 flex flex-col gap-3">
                        {vaultStatusCheck.findings.details
                          .filter((group) => !group.heading.startsWith("確認が必要"))
                          .map((group) => (
                            <div key={group.heading} className="flex flex-col gap-0.5">
                              <span className="text-stone-700 dark:text-stone-200">{group.heading}</span>
                              {group.lines.map((line, i) => (
                                <span key={i} className="break-all text-stone-500 dark:text-stone-400">
                                  ・{line}
                                </span>
                              ))}
                            </div>
                          ))}
                      </div>
                    </details>
                  )}
                  {vaultStatusView.hasAttention && (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-stone-700 dark:text-stone-200">
                        確認が必要な記録があります（今回は変更しません）
                      </span>
                      {vaultStatusCheck.findings.attention.slice(0, 8).map((line) => (
                        <span key={line} className="break-all text-stone-500 dark:text-stone-400">
                          ・{line}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {vaultStatusView.hasUpdate && (
                      <button
                        onClick={onUpdateVaultStatus}
                        disabled={vaultActionsDisabled}
                        className="rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                      >
                        更新する
                      </button>
                    )}
                    {vaultStatusView.hasCleanup && (
                      <button
                        onClick={onCleanupVaultStatus}
                        disabled={vaultActionsDisabled}
                        className="rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                      >
                        整理する
                      </button>
                    )}
                  </div>
                </div>
              )}

              {vaultStatusCheck.kind === "ready" && vaultStatusCheck.note && vaultStatusCheck.note.length > 0 && (
                <div className="flex flex-col gap-0.5 text-xs text-red-600 dark:text-red-400">
                  <span>一部を完了できませんでした。</span>
                  {vaultStatusCheck.note.map((step) => (
                    <span key={step.name} className="break-all">
                      {step.name}
                      {step.detail ? `（${step.detail}）` : ""}
                    </span>
                  ))}
                </div>
              )}

              {vaultStatusCheck.kind === "error" && (
                <div className="flex items-center justify-between gap-4 rounded-xl bg-red-50/60 px-3 py-2 text-xs text-red-600 dark:bg-red-950/20 dark:text-red-400">
                  <span>{vaultStatusCheck.message}</span>
                  <button
                    onClick={onCheckVaultStatus}
                    disabled={vaultActionsDisabled}
                    className="shrink-0 rounded-full border border-red-400/60 px-3 py-1 text-xs text-red-600 transition hover:bg-red-900/5 disabled:opacity-50 dark:border-red-500/60 dark:text-red-400 dark:hover:bg-white/5"
                  >
                    もう一度確認する
                  </button>
                </div>
              )}
            </div>
          )}

          {showAdvancedVaultTools && (
            <details className="rounded-xl border border-black/5 px-3 py-2 dark:border-white/10">
              <summary className="cursor-pointer text-xs text-stone-400 dark:text-stone-500">詳細（開発者向け）</summary>
              <div className="mt-3 flex flex-col gap-4">
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
            実機不具合対応（HOLD表示整理）：Tsumugi自身のVault書き込みHOLD
            （`vaultHoldReasons`）専用の表示。下の軽量「外部の変更」検知フロー
            （`vaultLightCheckStatus`）とは完全に別物であり、混ぜない——こちらは
            「Tsumugi側の保存が保留中」、light-checkは「外部で変更が見つかった」。
            「Vault」「再同期」「Registry」という言葉は出さない。通常は
            `vaultHoldReasons`がnullのため、この節は一切表示されない。

            Android実機確認の結果、この節から既存full resync（`handleResyncVault`）
            を呼ぶ「保存先を確認する」ボタンは撤去した——実機で長時間終わらず、
            アプリが止まったように見えるため、通常ユーザー向け復旧操作として
            成立しないと判断した（full resync機能自体はadvanced/debug fallbackと
            してChatScreen.tsx／vault.tsにそのまま残す）。解決できない操作ボタンは
            出さず、情報表示のみに留める。IndexedDB側の記録はHOLD中も変更されず
            （`markVaultSynced`が呼ばれず「未同期」のまま残るだけ）、端末内に
            安全に保持されたまま会話を継続できるため、その旨も併記する。
            Codex監査対応：「保留」は内部処理感が強いため避け、ユーザー向け3状態
            （外部変更候補／保存先への未反映／記録を開けない）の表現に統一する。
          */}
          {vaultHoldReasons && (
            <div className="flex flex-col gap-1 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>保存先に反映されていない記録があります。</span>
              <span className="text-xs text-stone-500 dark:text-stone-400">記録は端末内に保持されています。</span>
            </div>
          )}

          {/*
            軽量「外部の変更」検知フロー（Level 1〜4）。「Vault」「Registry」
            「resync」「同期」等の内部用語は出さない。保存先の外部変更に関する
            通常ユーザー向け導線はこのUIに一本化する（完成イメージ：
            「外部の変更がある可能性があります［確認する］」→
            「編集/移動/追加/見つからない N件」［変更を反映］→
            「外部の変更を反映しました。」）。
            調査対応：`countVaultLightCheckCandidates()`（Level 1/2のraw candidate数）
            はユーザー向けの正確な変更件数ではない——move 1件がmissing+unknownの
            2 candidateに分かれたり、Tsumugi管理外のMarkdownもunknown candidateに
            含まれたりするため。したがって"candidates-found"の段階では数値を
            一切表示しない。
            Codex監査対応（M5）：Level 1/2のcandidateにはTsumugi管理外Markdownが
            含まれうるため、"candidates-found"の文言は「外部の変更があります」と
            断定せず「外部の変更がある可能性があります」とする（Level 3後、
            actionableCount===0なら従来通り"idle"へ戻り表示は消える）。確定した
            内訳（編集/移動/追加/見つからない/確認が必要）は「確認する」実行後
            （"classified"、Level 3の分類結果）にのみ表示する。
          */}
          {vaultLightCheckStatus.kind === "checking" && (
            <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              確認しています…
            </div>
          )}

          {vaultLightCheckStatus.kind === "candidates-found" && (
            <div className="flex items-center justify-between gap-4 rounded-xl bg-amber-50/60 px-3 py-2 text-sm text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
              <span>外部の変更がある可能性があります</span>
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
              <span className="text-xs text-stone-500 dark:text-stone-400">
                {/* 内部用語（added/edited/moved/missing）は出さず、日本語の
                    行だけを、存在するものだけ表示する。
                    Codex監査対応（M5）：missingは「既知pathでファイルが見つから
                    ない」という事実であり、削除されたと確定できるわけではない
                    ため、「削除」ではなく事実に即した「見つからない」と表示する。 */}
                {[
                  vaultLightCheckStatus.result.counts.edited > 0 ? `編集 ${vaultLightCheckStatus.result.counts.edited}件` : null,
                  vaultLightCheckStatus.result.counts.moved > 0 ? `移動 ${vaultLightCheckStatus.result.counts.moved}件` : null,
                  vaultLightCheckStatus.result.counts.added > 0 ? `追加 ${vaultLightCheckStatus.result.counts.added}件` : null,
                  vaultLightCheckStatus.result.counts.missing > 0 ? `見つからない ${vaultLightCheckStatus.result.counts.missing}件` : null,
                  vaultLightCheckStatus.result.counts.conflict + vaultLightCheckStatus.result.counts.unreadable > 0
                    ? `確認が必要 ${vaultLightCheckStatus.result.counts.conflict + vaultLightCheckStatus.result.counts.unreadable}件`
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

          {/*
            保存先の記録を端末へ追加（追加専用復元）。保存先にあり、この端末に無い記録だけを
            追加する。この端末にある記録・保存先のファイルは変更しない。「確認する」は何も
            書き込まず件数を表示するだけで、「端末へ追加する」を押した場合だけ書き込む。
          */}
          {vaultStatus === "connected" && vaultHandle && (
            <div className="flex flex-col gap-2 border-t border-black/5 pt-4 dark:border-white/10">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-stone-600 dark:text-stone-300">保存先の記録を端末へ追加</span>
                  <span className="text-[11px] text-stone-400 dark:text-stone-500">
                    保存先にあり、この端末に無い記録だけを追加します。この端末にある記録は変更しません。
                  </span>
                </div>
                <button
                  onClick={onRunVaultRestoreDryRun}
                  disabled={vaultActionsDisabled || vaultRestoreStatus.kind === "scanning" || vaultRestoreStatus.kind === "restoring"}
                  className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                >
                  {vaultRestoreStatus.kind === "scanning" ? "確認中…" : "確認する"}
                </button>
              </div>

              {vaultRestoreStatus.kind === "dry-run" && (
                <div className="flex flex-col gap-2 rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
                  <span>
                    追加予定：記憶 {vaultRestoreStatus.counts.memoriesToAdd}件・会話 {vaultRestoreStatus.counts.conversationsToAdd}件・素材{" "}
                    {vaultRestoreStatus.counts.sourcesToAdd}件
                  </span>
                  <span className="text-stone-500 dark:text-stone-400">
                    この端末に既にあるためスキップ：記憶 {vaultRestoreStatus.counts.existingSkipped.memories}件・会話{" "}
                    {vaultRestoreStatus.counts.existingSkipped.conversations}件・素材 {vaultRestoreStatus.counts.existingSkipped.sources}件
                  </span>
                  <span className="text-stone-500 dark:text-stone-400">
                    重複を整理：記憶 {vaultRestoreStatus.counts.duplicatesResolved.memories}件・会話{" "}
                    {vaultRestoreStatus.counts.duplicatesResolved.conversations}件・素材 {vaultRestoreStatus.counts.duplicatesResolved.sources}件
                    {vaultRestoreStatus.counts.unreadableFiles > 0 ? `／読み込めなかったファイル ${vaultRestoreStatus.counts.unreadableFiles}件` : ""}
                  </span>
                  {vaultRestoreStatus.counts.memoriesToAdd + vaultRestoreStatus.counts.conversationsToAdd + vaultRestoreStatus.counts.sourcesToAdd > 0 ? (
                    <button
                      onClick={onExecuteVaultRestore}
                      disabled={vaultActionsDisabled}
                      className="self-start rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                    >
                      端末へ追加する
                    </button>
                  ) : (
                    <span>追加が必要な記録はありません。</span>
                  )}
                </div>
              )}

              {vaultRestoreStatus.kind === "restoring" && (
                <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">追加しています…</div>
              )}

              {vaultRestoreStatus.kind === "done" && (
                <div className="rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
                  {vaultRestoreStatus.interrupted ? "追加を途中で中断しました。" : "端末へ追加しました。"}
                  記憶 {vaultRestoreStatus.inserted.memories}件・会話 {vaultRestoreStatus.inserted.conversations}件・素材{" "}
                  {vaultRestoreStatus.inserted.sources}件
                  {vaultRestoreStatus.skippedExisting > 0 ? `（既にあったため ${vaultRestoreStatus.skippedExisting}件はスキップ）` : ""}
                </div>
              )}

              {vaultRestoreStatus.kind === "error" && (
                <div className="flex items-center justify-between gap-4 rounded-xl bg-red-50/60 px-3 py-2 text-xs text-red-600 dark:bg-red-950/20 dark:text-red-400">
                  <span>{vaultRestoreStatus.message}</span>
                  <button
                    onClick={onRunVaultRestoreDryRun}
                    disabled={vaultActionsDisabled}
                    className="shrink-0 rounded-full border border-red-400/60 px-3 py-1 text-xs text-red-600 transition hover:bg-red-900/5 disabled:opacity-50 dark:border-red-500/60 dark:text-red-400 dark:hover:bg-white/5"
                  >
                    もう一度確認する
                  </button>
                </div>
              )}
            </div>
          )}

          {/*
            旧形式ファイルの整理。旧い保存形式の重複ファイルを隠しフォルダへ退避し（削除はしません）、
            それが原因で「確認が必要」になっている記録を確認済みに戻す。「確認する」は何も書き込まず、
            「整理を実行する」を押した場合だけ書き込む。記憶・会話の本文と、この端末の記録は変更しない。
          */}
          {vaultStatus === "connected" && vaultHandle && (
            <div className="flex flex-col gap-2 border-t border-black/5 pt-4 dark:border-white/10">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-stone-600 dark:text-stone-300">旧形式ファイルの整理</span>
                  <span className="text-[11px] text-stone-400 dark:text-stone-500">
                    重複した旧形式のファイルを隠しフォルダへ退避し（削除はしません）、確認が必要な記録を確認済みに戻します。
                  </span>
                </div>
                <button
                  onClick={onRunLegacyCleanupDryRun}
                  disabled={vaultActionsDisabled || legacyCleanupStatus.kind === "scanning" || legacyCleanupStatus.kind === "executing"}
                  className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                >
                  {legacyCleanupStatus.kind === "scanning" ? "確認中…" : "確認する"}
                </button>
              </div>

              {legacyCleanupStatus.kind === "dry-run" && (
                <div className="flex flex-col gap-2 rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
                  <span>
                    退避する旧形式の記憶ファイル：{legacyCleanupStatus.plan.archiveMemoryFiles.length}件
                    （Reflection {legacyCleanupStatus.plan.reflectionsExcluded}件は対象外）
                  </span>
                  <span>退避する会話のコピー：{legacyCleanupStatus.plan.archiveConversationCopies.length}件</span>
                  <span>
                    確認済みに戻す記録：記憶の日別ファイル {legacyCleanupStatus.plan.memoryDays.filter((i) => i.ok).length}/
                    {legacyCleanupStatus.plan.memoryDays.length}日・会話 {legacyCleanupStatus.plan.conversations.filter((i) => i.ok).length}/
                    {legacyCleanupStatus.plan.conversations.length}件
                  </span>
                  {legacyCleanupStatus.plan.alreadyArchived > 0 && (
                    <span className="text-stone-500 dark:text-stone-400">前回までに退避済み：{legacyCleanupStatus.plan.alreadyArchived}件</span>
                  )}
                  {legacyCleanupStatus.plan.bodyDiffs.length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      <span>本文が日別ファイルと異なる旧形式の記憶：{legacyCleanupStatus.plan.bodyDiffs.length}件（退避先に残ります）</span>
                      {legacyCleanupStatus.plan.bodyDiffs.map((diff) => (
                        <span key={diff.originalPath} className="break-all text-stone-500 dark:text-stone-400">
                          {diff.recordId}（{diff.day}・{diff.fields.join("／")}）
                        </span>
                      ))}
                    </div>
                  )}
                  {legacyCleanupStatus.plan.conversationCopyDiffs.length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      <span>
                        内容が正本と異なる会話のコピー：{legacyCleanupStatus.plan.conversationCopyDiffs.length}件（退避先に残ります）
                      </span>
                      {legacyCleanupStatus.plan.conversationCopyDiffs.map((diff) => (
                        <span key={diff.copyPath} className="break-all text-stone-500 dark:text-stone-400">
                          {diff.copyPath}（{diff.differences.join("／")}）
                        </span>
                      ))}
                    </div>
                  )}
                  {legacyCleanupStatus.plan.skippedConflicts.length > 0 && (
                    <span className="text-stone-500 dark:text-stone-400">
                      今回は触らない記録：{legacyCleanupStatus.plan.skippedConflicts.length}件
                    </span>
                  )}
                  <span>
                    実行後の予測：確認が必要（日別）{legacyCleanupStatus.plan.predicted.memoryDayConflict}件・確認が必要（会話）
                    {legacyCleanupStatus.plan.predicted.conversationConflict}件・見つからない会話{" "}
                    {legacyCleanupStatus.plan.predicted.conversationMissing}件・この端末の記録{" "}
                    {legacyCleanupStatus.plan.idb.memories}/{legacyCleanupStatus.plan.idb.conversations}/{legacyCleanupStatus.plan.idb.sources}
                    件（変更なし）
                  </span>

                  <details className="text-stone-500 dark:text-stone-400">
                    <summary className="cursor-pointer">対象ごとの検証結果</summary>
                    <div className="mt-1 flex flex-col gap-0.5">
                      {legacyCleanupStatus.plan.memoryDays.map((item) => (
                        <span key={item.key} className="break-all">
                          {item.ok ? "OK" : "要確認"}　{item.day}
                          {item.ok ? "" : `：${item.checks.filter((c) => !c.ok).map((c) => c.name).join("／")}`}
                        </span>
                      ))}
                      {legacyCleanupStatus.plan.conversations.map((item) => (
                        <span key={item.key} className="break-all">
                          {item.ok ? "OK" : "要確認"}　会話 {item.key}
                          {item.ok ? "" : `：${item.checks.filter((c) => !c.ok).map((c) => c.name).join("／")}`}
                        </span>
                      ))}
                      <span>
                        旧形式ファイルの検証：
                        {legacyCleanupStatus.plan.archiveMemoryFiles.filter((i) => i.ok).length}/
                        {legacyCleanupStatus.plan.archiveMemoryFiles.length}件OK
                      </span>
                    </div>
                  </details>

                  {legacyCleanupStatus.plan.blockers.length > 0 && (
                    <div className="flex flex-col gap-0.5 text-red-600 dark:text-red-400">
                      <span>実行できません（確認が必要な項目があります）：</span>
                      {legacyCleanupStatus.plan.blockers.slice(0, 8).map((blocker) => (
                        <span key={blocker} className="break-all">
                          {blocker}
                        </span>
                      ))}
                      {legacyCleanupStatus.plan.blockers.length > 8 && <span>ほか {legacyCleanupStatus.plan.blockers.length - 8}件</span>}
                    </div>
                  )}

                  {legacyCleanupStatus.plan.executable ? (
                    <button
                      onClick={onExecuteLegacyCleanup}
                      disabled={vaultActionsDisabled}
                      className="self-start rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                    >
                      整理を実行する
                    </button>
                  ) : legacyCleanupStatus.plan.nothingToDo ? (
                    <span>整理が必要なファイルはありません。</span>
                  ) : null}
                </div>
              )}

              {legacyCleanupStatus.kind === "executing" && (
                <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">整理しています…</div>
              )}

              {legacyCleanupStatus.kind === "done" && (
                <div className="flex flex-col gap-1 rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
                  <span>
                    {legacyCleanupStatus.status === "complete"
                      ? "整理しました。"
                      : legacyCleanupStatus.status === "nothing-to-do"
                        ? "整理が必要なファイルはありません。"
                        : legacyCleanupStatus.status === "interrupted"
                          ? "整理を途中で中断しました。もう一度「確認する」から実行すると続きから完了できます。"
                          : legacyCleanupStatus.status === "refused"
                            ? "確認が必要な項目があるため、何も変更せずに中止しました。"
                            : "一部を完了できませんでした。もう一度「確認する」から実行すると続きから完了できます。"}
                  </span>
                  <span>
                    退避 {legacyCleanupStatus.archivedNow}件・日別ファイルを確認済みに {legacyCleanupStatus.memoryDaysCommitted}日・会話を確認済みに{" "}
                    {legacyCleanupStatus.conversationsCommitted}件
                  </span>
                  {legacyCleanupStatus.counts && (
                    <span>
                      確認が必要（日別）{legacyCleanupStatus.counts.memoryDayConflict}件・確認が必要（会話）
                      {legacyCleanupStatus.counts.conversationConflict}件・見つからない会話 {legacyCleanupStatus.counts.conversationMissing}件
                      {legacyCleanupStatus.idb
                        ? `／この端末の記録 ${legacyCleanupStatus.idb.memories}/${legacyCleanupStatus.idb.conversations}/${legacyCleanupStatus.idb.sources}件`
                        : ""}
                    </span>
                  )}
                  {legacyCleanupStatus.postChecks.length > 0 && (
                    <details>
                      <summary className="cursor-pointer">実行後の確認</summary>
                      <div className="mt-1 flex flex-col gap-0.5">
                        {legacyCleanupStatus.postChecks.map((check) => (
                          <span key={check.name} className="break-all">
                            {check.ok ? "OK" : "NG"}　{check.name}
                            {check.detail ? `（${check.detail}）` : ""}
                          </span>
                        ))}
                      </div>
                    </details>
                  )}
                  {legacyCleanupStatus.errors.length > 0 && (
                    <div className="flex flex-col gap-0.5 text-red-600 dark:text-red-400">
                      {legacyCleanupStatus.errors.slice(0, 5).map((message) => (
                        <span key={message} className="break-all">
                          {message}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {legacyCleanupStatus.kind === "error" && (
                <div className="flex items-center justify-between gap-4 rounded-xl bg-red-50/60 px-3 py-2 text-xs text-red-600 dark:bg-red-950/20 dark:text-red-400">
                  <span>{legacyCleanupStatus.message}</span>
                  <button
                    onClick={onRunLegacyCleanupDryRun}
                    disabled={vaultActionsDisabled}
                    className="shrink-0 rounded-full border border-red-400/60 px-3 py-1 text-xs text-red-600 transition hover:bg-red-900/5 disabled:opacity-50 dark:border-red-500/60 dark:text-red-400 dark:hover:bg-white/5"
                  >
                    もう一度確認する
                  </button>
                </div>
              )}
            </div>
          )}

          {/*
            保存先にない記録の追加（この端末 → 保存先。IndexedDB → Vault）。「保存先の記録を端末へ追加」
            （保存先 → この端末）とは逆方向。この端末にあって、保存先には無い記録（保存先の設定前に作られた
            記録など）を、確認した上で保存先へ追加する。「確認する」は何も書き込まず、「保存先に追加する」を
            押した場合だけ書き込む。追加できない記録（確認が必要な記録）は、理由を表示する（今回は解決までは
            行わない）。
          */}
          {vaultStatus === "connected" && vaultHandle && (
            <div className="flex flex-col gap-2 border-t border-black/5 pt-4 dark:border-white/10">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-stone-600 dark:text-stone-300">保存先にない記録の追加</span>
                  <span className="text-[11px] text-stone-400 dark:text-stone-500">
                    この端末にあって、保存先にない記録を、保存先へ追加します（「保存先の記録を端末へ追加」とは逆方向です）。
                  </span>
                </div>
                <button
                  onClick={onRunLocalOnlyDryRun}
                  disabled={vaultActionsDisabled || localOnlyStatus.kind === "scanning" || localOnlyStatus.kind === "executing"}
                  className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                >
                  {localOnlyStatus.kind === "scanning" ? "確認中…" : "確認する"}
                </button>
              </div>

              {localOnlyStatus.kind === "plan" && (
                <div className="flex flex-col gap-2 rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
                  {localOnlyStatus.plan.adoptable.length > 0 && (
                    <>
                      <span>
                        この端末に、保存先にない記録が{localOnlyStatus.plan.adoptable.length}件あります
                        （{[
                          localOnlyStatus.plan.counts.conversations > 0 ? `会話${localOnlyStatus.plan.counts.conversations}件` : null,
                          localOnlyStatus.plan.counts.memories > 0 ? `記憶${localOnlyStatus.plan.counts.memories}件` : null,
                          localOnlyStatus.plan.counts.sources > 0 ? `素材${localOnlyStatus.plan.counts.sources}件` : null,
                        ]
                          .filter((part): part is string => part !== null)
                          .join("・")}）
                      </span>
                      <span className="text-stone-500 dark:text-stone-400">
                        保存先を設定する前に作成された記録などです。元の日時のまま、保存先に追加します。
                      </span>
                      <details className="text-stone-600 dark:text-stone-300">
                        <summary className="cursor-pointer">内容を確認</summary>
                        <div className="mt-2 flex flex-col gap-3">
                          {localOnlyStatus.plan.adoptable.map((item) => (
                            <div key={item.record.key} className="flex flex-col gap-1">
                              <label className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  checked={!localOnlyStatus.excluded.includes(item.record.key)}
                                  onChange={() => onToggleLocalOnlyExcluded(item.record.key)}
                                  className="mt-0.5"
                                />
                                <span className="flex flex-col gap-0.5">
                                  <span>
                                    {item.record.day}　{item.record.title}
                                  </span>
                                  <span className="text-stone-500 dark:text-stone-400">
                                    作成 {item.record.createdAt.slice(0, 16).replace("T", " ")}（元の日時のまま追加）
                                  </span>
                                </span>
                              </label>
                              <div className="ml-6 flex flex-col gap-0.5 rounded-lg bg-white/60 px-2 py-1 text-stone-600 dark:bg-black/20 dark:text-stone-300">
                                {item.record.lines.map((line, i) => (
                                  <span key={i} className="break-words whitespace-pre-wrap">
                                    {line}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                      <button
                        onClick={onExecuteAppendLocal}
                        disabled={
                          vaultActionsDisabled ||
                          localOnlyStatus.plan.adoptable.every((item) => localOnlyStatus.excluded.includes(item.record.key))
                        }
                        className="self-start rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                      >
                        保存先に追加する
                        {localOnlyStatus.excluded.length > 0
                          ? `（${localOnlyStatus.plan.adoptable.length - localOnlyStatus.excluded.length}件）`
                          : ""}
                      </button>
                    </>
                  )}

                  {localOnlyStatus.plan.blocked.length > 0 && (
                    <details className="text-stone-700 dark:text-stone-300">
                      <summary className="cursor-pointer">確認が必要な記録が{localOnlyStatus.plan.blocked.length}件あります</summary>
                      <div className="mt-1 flex flex-col gap-1 text-stone-500 dark:text-stone-400">
                        {localOnlyStatus.plan.blocked.map((item) => (
                          <span key={item.record.key} className="break-all">
                            {item.record.day}　{item.record.title}：{item.block?.message}
                            {item.block?.detail ? `（${item.block.detail}）` : ""}
                          </span>
                        ))}
                        <span>これらは今回は追加せず、そのまま残します。</span>
                      </div>
                    </details>
                  )}

                  {localOnlyStatus.plan.items.length === 0 && <span>保存先にない記録はありません。</span>}
                </div>
              )}

              {localOnlyStatus.kind === "executing" && (
                <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">追加しています…</div>
              )}

              {localOnlyStatus.kind === "done" && (
                <div className="flex flex-col gap-1 rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
                  <span>
                    {localOnlyStatus.result.status === "nothing-to-do"
                      ? "追加する記録はありませんでした。"
                      : localOnlyStatus.result.status === "interrupted"
                        ? "追加を途中で中断しました。もう一度「確認する」から実行すると、続きから完了できます。"
                        : localOnlyStatus.result.failedCount + localOnlyStatus.result.skippedCount > 0
                          ? `${localOnlyStatus.result.writtenCount}件を保存先に追加しました。追加できなかった記録があります。`
                          : `${localOnlyStatus.result.writtenCount}件を保存先に追加しました。`}
                  </span>
                  {localOnlyStatus.result.items
                    .filter((item) => item.outcome !== "written")
                    .map((item) => (
                      <span key={item.key} className="break-all text-red-600 dark:text-red-400">
                        {item.message}
                      </span>
                    ))}
                  {localOnlyStatus.result.remaining && localOnlyStatus.result.remaining.blocked > 0 && (
                    <span>確認が必要な記録が{localOnlyStatus.result.remaining.blocked}件あります（「確認する」で理由を確認できます）。</span>
                  )}
                  {localOnlyStatus.result.postChecks.length > 0 && (
                    <details>
                      <summary className="cursor-pointer">実行後の確認</summary>
                      <div className="mt-1 flex flex-col gap-0.5">
                        {localOnlyStatus.result.postChecks.map((check) => (
                          <span key={check.name} className="break-all">
                            {check.ok ? "OK" : "NG"}　{check.name}
                            {check.detail ? `（${check.detail}）` : ""}
                          </span>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {localOnlyStatus.kind === "error" && (
                <div className="flex items-center justify-between gap-4 rounded-xl bg-red-50/60 px-3 py-2 text-xs text-red-600 dark:bg-red-950/20 dark:text-red-400">
                  <span>{localOnlyStatus.message}</span>
                  <button
                    onClick={onRunLocalOnlyDryRun}
                    disabled={vaultActionsDisabled}
                    className="shrink-0 rounded-full border border-red-400/60 px-3 py-1 text-xs text-red-600 transition hover:bg-red-900/5 disabled:opacity-50 dark:border-red-500/60 dark:text-red-400 dark:hover:bg-white/5"
                  >
                    もう一度確認する
                  </button>
                </div>
              )}
            </div>
          )}

          {/*
            保存先に本体が見つからない記録の整理。「確認が必要（見つからない）」と表示され続ける記録のうち、
            保存先にも、この端末にも、退避先にも本体が無いもの（管理情報だけが残っているもの）を、内容と
            理由を確認した上で整理する。「確認する」は何も書き込まず、「整理する」を押した場合だけ書き込む。
            記憶・会話の内容は変更しない。整理前の管理情報は退避して保存する。
            「missing」「Registry」「orphan」等の内部用語は出さない。
          */}
          {vaultStatus === "connected" && vaultHandle && (
            <div className="flex flex-col gap-2 border-t border-black/5 pt-4 dark:border-white/10">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-stone-600 dark:text-stone-300">本体が見つからない記録の整理</span>
                  <span className="text-[11px] text-stone-400 dark:text-stone-500">
                    保存先にも端末にも本体が無く、管理情報だけが残っている記録を整理します。
                  </span>
                </div>
                <button
                  onClick={onRunOrphanDryRun}
                  disabled={vaultActionsDisabled || orphanStatus.kind === "scanning" || orphanStatus.kind === "executing"}
                  className="shrink-0 rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                >
                  {orphanStatus.kind === "scanning" ? "確認中…" : "確認する"}
                </button>
              </div>

              {orphanStatus.kind === "plan" && (
                <div className="flex flex-col gap-2 rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">
                  {!orphanStatus.plan.registryReadable && (
                    <span className="text-red-600 dark:text-red-400">保存先の管理情報を最後まで読み込めなかったため、確認できません。</span>
                  )}
                  {orphanStatus.plan.orphans.length > 0 && (
                    <>
                      <span>
                        保存先に本体が見つからず、この端末にも復元元がない記録が{orphanStatus.plan.orphans.length}件あります。
                        管理情報だけが残っているため整理できます。
                      </span>
                      <details className="text-stone-600 dark:text-stone-300">
                        <summary className="cursor-pointer">内容を確認</summary>
                        <div className="mt-2 flex flex-col gap-3">
                          {orphanStatus.plan.orphans.map((item) => (
                            <div key={item.key} className="flex flex-col gap-1">
                              <span>{item.title}</span>
                              <span className="text-stone-500 dark:text-stone-400">
                                最後に保存された時刻：{new Date(item.lastKnown.mtime).toLocaleString("ja-JP")}
                              </span>
                              {item.relatedMemories.length > 0 && (
                                <div className="flex flex-col gap-0.5 text-stone-500 dark:text-stone-400">
                                  <span>この記録から作られた記憶{item.relatedMemories.length}件は、そのまま残ります：</span>
                                  {item.relatedMemories.map((memory) => (
                                    <span key={memory.id} className="break-words">
                                      ・{memory.day}　{memory.summary}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                          <span className="text-stone-500 dark:text-stone-400">
                            記憶の内容は変更しません。整理前の管理情報は、退避して保存します。ごみ箱やバックアップに残っている
                            場合は、先にそこから戻すこともできます。
                          </span>
                        </div>
                      </details>
                      <button
                        onClick={onExecuteOrphanCleanup}
                        disabled={vaultActionsDisabled}
                        className="self-start rounded-full border border-stone-400/60 px-3 py-1 text-xs text-stone-700 transition hover:bg-stone-900/5 disabled:opacity-50 dark:border-stone-500/60 dark:text-stone-200 dark:hover:bg-white/5"
                      >
                        整理する
                      </button>
                    </>
                  )}

                  {orphanStatus.plan.others.length > 0 && (
                    <details className="text-stone-700 dark:text-stone-300">
                      <summary className="cursor-pointer">確認が必要な記録が{orphanStatus.plan.others.length}件あります</summary>
                      <div className="mt-1 flex flex-col gap-1 text-stone-500 dark:text-stone-400">
                        {orphanStatus.plan.others.map((item) => (
                          <span key={item.key} className="break-all">
                            {item.title}：{item.message}
                          </span>
                        ))}
                        <span>これらは今回は整理せず、そのまま残します。</span>
                      </div>
                    </details>
                  )}

                  {orphanStatus.plan.items.length === 0 && orphanStatus.plan.registryReadable && (
                    <span>本体が見つからない記録はありません。</span>
                  )}
                </div>
              )}

              {orphanStatus.kind === "executing" && (
                <div className="rounded-xl bg-amber-50/60 px-3 py-2 text-xs text-stone-700 dark:bg-amber-950/20 dark:text-stone-300">整理しています…</div>
              )}

              {orphanStatus.kind === "done" && (
                <div className="flex flex-col gap-1 rounded-xl bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-400">
                  <span>
                    {orphanStatus.result.status === "nothing-to-do"
                      ? "整理する記録はありませんでした。"
                      : orphanStatus.result.status === "interrupted"
                        ? "整理を途中で中断しました。もう一度「確認する」から実行すると、続きから完了できます。"
                        : orphanStatus.result.failedCount + orphanStatus.result.skippedCount > 0
                          ? `${orphanStatus.result.cleanedCount}件を整理しました。整理できなかった記録があります。`
                          : orphanStatus.result.status === "partial"
                            ? "整理しましたが、実行後の確認で確認が必要な項目がありました。"
                            : `${orphanStatus.result.cleanedCount}件を整理しました。`}
                  </span>
                  {orphanStatus.result.items
                    .filter((item) => item.outcome !== "cleaned" && item.message)
                    .map((item) => (
                      <span key={item.key} className="break-all text-red-600 dark:text-red-400">
                        {item.message}
                      </span>
                    ))}
                  {orphanStatus.result.status === "complete" && (
                    <span>
                      {vaultLightCheckStatus.kind === "checking" || vaultLightCheckStatus.kind === "classifying"
                        ? "保存先の状態を確認しています…"
                        : vaultLightCheckStatus.kind === "idle"
                          ? "✓ 保存先に、見つからない記録はありません。"
                          : "まだ確認が必要な項目があります。上の「外部の変更」の表示を確認してください。"}
                    </span>
                  )}
                  {orphanStatus.result.remaining && orphanStatus.result.remaining.others > 0 && (
                    <span>確認が必要な記録が{orphanStatus.result.remaining.others}件あります（「確認する」で理由を確認できます）。</span>
                  )}
                  {orphanStatus.result.postChecks.length > 0 && (
                    <details>
                      <summary className="cursor-pointer">実行後の確認</summary>
                      <div className="mt-1 flex flex-col gap-0.5">
                        {orphanStatus.result.postChecks.map((check) => (
                          <span key={check.name} className="break-all">
                            {check.ok ? "OK" : "NG"}　{check.name}
                            {check.detail ? `（${check.detail}）` : ""}
                          </span>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {orphanStatus.kind === "error" && (
                <div className="flex items-center justify-between gap-4 rounded-xl bg-red-50/60 px-3 py-2 text-xs text-red-600 dark:bg-red-950/20 dark:text-red-400">
                  <span>{orphanStatus.message}</span>
                  <button
                    onClick={onRunOrphanDryRun}
                    disabled={vaultActionsDisabled}
                    className="shrink-0 rounded-full border border-red-400/60 px-3 py-1 text-xs text-red-600 transition hover:bg-red-900/5 disabled:opacity-50 dark:border-red-500/60 dark:text-red-400 dark:hover:bg-white/5"
                  >
                    もう一度確認する
                  </button>
                </div>
              )}
            </div>
          )}
              </div>
            </details>
          )}
        </section>

        {/*
          データ管理。「データ」セクションは全プラットフォームで表示する。
          - Markdownエクスポート：OPFS（この端末の安全な領域）に保存している場合のみ。PC等のFile System
            Access API Vault（ユーザーが選んだ実フォルダ）は、Finder/エクスプローラーから直接読み書きできる。
          - 「この端末のTsumugiデータを完全に削除」：全プラットフォーム。通常の操作とは分けた危険操作として、
            セクション末尾の赤い枠に置き、確認画面（チェック＋明示ボタン）を通った場合だけ削除を開始する
            （実際の削除はdataWipe.ts）。
        */}
        <section className="flex flex-col gap-3 border-t border-black/5 pt-6 dark:border-white/10">
          <p className="text-sm text-stone-500 dark:text-stone-400">データ</p>

          {vaultBackend === "opfs" && (
          <>
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
          </>
          )}

          <div className="mt-2 flex flex-col gap-2 rounded-xl border border-red-300/60 bg-red-50/40 px-3 py-3 dark:border-red-800/60 dark:bg-red-950/20">
            <p className="text-xs font-medium text-red-600 dark:text-red-400">危険な操作</p>
          <div className="flex items-center justify-between gap-4 text-xs text-stone-600 dark:text-stone-300">
            <div className="flex flex-col gap-0.5">
              <span>この端末のTsumugiデータを完全に削除</span>
              <span className="text-[11px] text-stone-500 dark:text-stone-400">
                会話・記憶・設定・APIキー・端末内の保存先を消し、初期状態に戻します。元に戻せません。
              </span>
            </div>
            <button
              onClick={() => {
                setWipeAcknowledged(false);
                setWipeConfirmOpen(true);
              }}
              disabled={deleteDataFeedback?.kind === "busy"}
              className="shrink-0 rounded-full border border-red-300/60 px-3 py-1 text-xs text-red-600 transition hover:bg-red-500/10 disabled:opacity-50 dark:border-red-700/60 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              {deleteDataFeedback?.kind === "busy" ? "削除中…" : "削除する…"}
            </button>
          </div>
          {deleteDataFeedback && deleteDataFeedback.kind !== "busy" && (
            <p className="text-xs text-red-600 dark:text-red-400">{deleteDataFeedback.message}</p>
          )}
          </div>
        </section>
      </div>

      {wipeConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="wipe-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
        >
          <div className="flex max-h-[90vh] w-full max-w-sm flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-5 text-sm text-stone-700 shadow-xl dark:bg-stone-900 dark:text-stone-300">
            <h2 id="wipe-confirm-title" className="text-base font-medium text-red-600 dark:text-red-400">
              この端末のTsumugiデータを完全に削除しますか？
            </h2>
            <p>次のものが、この端末から削除されます。</p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs">
              <li>Conversation（会話）</li>
              <li>Memory（記憶）</li>
              <li>Source（取り込んだ資料）</li>
              <li>設定</li>
              <li>APIキー（削除後は入力し直しが必要です）</li>
              <li>アプリ内のデータベース（IndexedDB）</li>
              {vaultBackend === "opfs" ? (
                <li>この端末内のVault（OPFS）に保存された記録のすべて</li>
              ) : (
                <li>保存先への接続情報（選んだフォルダとの紐づけ）</li>
              )}
            </ul>
            <p className="font-medium">この操作は元に戻せません。</p>
            {vaultBackend === "file-system-access" && (
              <p className="rounded-xl bg-stone-100 px-3 py-2 text-xs dark:bg-stone-800">
                外部保存先のファイルは削除されません。同じ保存先を再接続すると、記録を再読み込みできます。
              </p>
            )}
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={wipeAcknowledged}
                onChange={(event) => setWipeAcknowledged(event.target.checked)}
                className="mt-0.5"
              />
              <span>元に戻せないことを理解しました</span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setWipeConfirmOpen(false)}
                className="rounded-full border border-stone-300/60 px-4 py-2 text-xs transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:hover:bg-white/5"
              >
                キャンセル
              </button>
              <button
                onClick={() => {
                  setWipeConfirmOpen(false);
                  onWipeAllData();
                }}
                disabled={!wipeAcknowledged}
                className="rounded-full border border-red-400/60 bg-red-600 px-4 py-2 text-xs text-white transition hover:bg-red-700 disabled:opacity-40"
              >
                完全に削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
