"use client";

import { useEffect, useState } from "react";
import { loadApiKey, saveApiKey } from "@/lib/db";
import { AI_PROVIDER_HEADER, API_KEY_HEADER_BY_PROVIDER, isSafeApiKeyHeaderValue } from "@/lib/apiKeyHeader";

type TestStatus = "idle" | "testing" | "error";

/** Claudeは今回UIに出さないため、このコンポーネントが扱うproviderはこの2つに限定する。 */
type SupportedProvider = "gemini" | "openai";

const PROVIDER_INFO: Record<
  SupportedProvider,
  {
    label: string;
    intro: string;
    getKeyUrl: string;
    getKeyLabel: string;
    inputPlaceholder: string;
    accountNote: string;
  }
> = {
  gemini: {
    label: "Gemini",
    intro:
      "Geminiは既定でTsumugiが用意したAPIキーを使うため、あなた自身のAPIキーは必須ではありません。自分のキーを使いたい場合のみ、ここから設定できます。",
    getKeyUrl: "https://aistudio.google.com/apikey",
    getKeyLabel: "Google AI StudioでAPIキーを取得する",
    inputPlaceholder: "Gemini APIキーを入力（任意）",
    accountNote: "自分のAPIキーは、あなた自身のGoogleアカウントで取得します",
  },
  openai: {
    label: "OpenAI",
    intro: "会話の生成にOpenAIのAPIを使う場合、あなた自身のOpenAI APIキーが必要です。",
    getKeyUrl: "https://platform.openai.com/api-keys",
    getKeyLabel: "OpenAI PlatformでAPIキーを取得する",
    inputPlaceholder: "OpenAI APIキーを入力",
    accountNote: "APIキーはあなた自身のOpenAIアカウントで取得します",
  },
};

export default function ApiKeySetup({
  provider,
  onSaved,
  onClose,
}: {
  /** 最初に選択されているタブ（＝どのproviderのキーを登録しようとしているか）。 */
  provider: SupportedProvider;
  onSaved: (provider: SupportedProvider) => void;
  /** Beta：常に設定画面（任意）からのみ開かれるため、基本的に閉じるボタンは常に渡される。 */
  onClose?: () => void;
}) {
  const [activeProvider, setActiveProvider] = useState<SupportedProvider>(provider);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [existingStatus, setExistingStatus] = useState<Record<SupportedProvider, boolean>>({
    gemini: false,
    openai: false,
  });
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadApiKey("gemini"), loadApiKey("openai")]).then(([gemini, openai]) => {
      if (cancelled) return;
      setExistingStatus({ gemini: !!gemini, openai: !!openai });
    });
    return () => {
      cancelled = true;
    };
  }, [testStatus]);

  function switchTab(next: SupportedProvider) {
    if (next === activeProvider) return;
    setActiveProvider(next);
    setApiKeyInput("");
    setTestStatus("idle");
    setErrorMessage("");
  }

  async function handleTestAndSave() {
    const trimmed = apiKeyInput.trim();
    if (!trimmed || testStatus === "testing") return;

    // Beta修正：ヘッダー値として安全でない文字（不可視Unicode等）が混入している場合、
    // fetch()がTypeErrorで失敗し「ネットワークエラー」と誤解される問題への対処。
    // キー自体は書き換えず、送信前に読み取り専用でチェックするだけ。
    if (!isSafeApiKeyHeaderValue(trimmed)) {
      setTestStatus("error");
      setErrorMessage("APIキーに使用できない文字が含まれています。キーをコピーし直して再入力してください。");
      return;
    }

    setTestStatus("testing");
    setErrorMessage("");
    try {
      const res = await fetch("/api/api-key/test", {
        method: "POST",
        headers: {
          [AI_PROVIDER_HEADER]: activeProvider,
          [API_KEY_HEADER_BY_PROVIDER[activeProvider]]: trimmed,
        },
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setTestStatus("error");
        setErrorMessage(data.error ?? "接続確認に失敗しました。");
        return;
      }
      // 接続確認に成功した場合のみIndexedDBへ保存する（無効なキーを保存しないため）。
      await saveApiKey(trimmed, activeProvider);
      setApiKeyInput("");
      setTestStatus("idle");
      onSaved(activeProvider);
    } catch (error) {
      console.error("Failed to verify API key", error);
      setTestStatus("error");
      setErrorMessage("接続確認に失敗しました。ネットワークを確認してください。");
    }
  }

  const info = PROVIDER_INFO[activeProvider];

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-8 bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col gap-2 text-center">
          <p className="text-xl text-stone-800 dark:text-stone-100">APIキーの設定</p>
          <p className="text-sm leading-relaxed text-stone-500 dark:text-stone-400">{info.intro}</p>
        </div>

        <div className="flex justify-center gap-2">
          {(Object.keys(PROVIDER_INFO) as SupportedProvider[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => switchTab(key)}
              className={`rounded-full border px-4 py-1.5 text-sm transition ${
                activeProvider === key
                  ? "border-stone-800 bg-stone-800 text-stone-50 dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900"
                  : "border-stone-300/70 text-stone-500 hover:bg-stone-900/5 dark:border-stone-700/70 dark:text-stone-400 dark:hover:bg-white/5"
              }`}
            >
              {PROVIDER_INFO[key].label}
              {existingStatus[key] && activeProvider !== key ? "（設定済み）" : ""}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1.5 rounded-2xl border border-stone-300/70 bg-white/70 px-4 py-3 text-xs leading-relaxed text-stone-500 dark:border-stone-700/70 dark:bg-stone-900/60 dark:text-stone-400">
          <p>・{info.accountNote}</p>
          <p>・ここで入力したAPIキーはTsumugiのサーバーには送信・保存されず、このブラウザにのみ保存されます</p>
          <p>・自分のAPIキーを設定した場合、その利用料金・クォータはあなたのアカウントに紐づきます</p>
        </div>

        <div className="flex items-center justify-center gap-4">
          <a
            href={info.getKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-center text-xs text-stone-500 underline decoration-stone-300 underline-offset-4 transition hover:text-stone-700 dark:text-stone-400 dark:decoration-stone-700 dark:hover:text-stone-200"
          >
            {info.getKeyLabel}
          </a>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="text-center text-xs text-stone-400 underline decoration-stone-300 underline-offset-4 transition hover:text-stone-600 dark:text-stone-500 dark:decoration-stone-700 dark:hover:text-stone-300"
          >
            APIキーとは？
          </button>
        </div>

        {existingStatus[activeProvider] && (
          <p className="text-center text-xs text-stone-400 dark:text-stone-500">
            {info.label}のAPIキーは設定済みです。新しく入力すると上書きされます。
          </p>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-2xl border border-stone-300/70 bg-white/70 p-2 shadow-sm dark:border-stone-700/70 dark:bg-stone-900/60">
            <input
              type={showKey ? "text" : "password"}
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder={info.inputPlaceholder}
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-stone-400"
            />
            <button
              type="button"
              onClick={() => setShowKey((prev) => !prev)}
              className="shrink-0 px-2 text-xs text-stone-400 transition hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
            >
              {showKey ? "隠す" : "表示"}
            </button>
          </div>

          <button
            type="button"
            onClick={() => void handleTestAndSave()}
            disabled={!apiKeyInput.trim() || testStatus === "testing"}
            className="shrink-0 rounded-xl bg-stone-800 px-4 py-2 text-sm text-stone-50 transition disabled:opacity-40 dark:bg-stone-200 dark:text-stone-900"
          >
            {testStatus === "testing" ? "接続を確認しています…" : "接続確認"}
          </button>

          {testStatus === "error" && (
            <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="mt-1 text-xs text-stone-400 underline decoration-stone-300 underline-offset-4 transition hover:text-stone-600 dark:text-stone-500 dark:decoration-stone-700 dark:hover:text-stone-300"
            >
              閉じる
            </button>
          )}
        </div>
      </div>

      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-5"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="flex max-h-[80dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-2xl bg-[var(--background)] p-6 text-sm leading-relaxed text-stone-700 shadow-lg dark:text-stone-300"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-base text-stone-800 dark:text-stone-100">APIキーとは？</p>

            <div className="flex flex-col gap-1">
              <p className="text-stone-800 dark:text-stone-100">API・APIキーについて</p>
              <p>
                APIとは、Tsumugiのようなアプリが、Google（Gemini）やOpenAIのAIモデルに
                会話文を送って返答をもらうための仕組みです。APIキーはその利用者本人を
                識別するための、パスワードのような文字列です。
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <p className="text-stone-800 dark:text-stone-100">料金について</p>
              <p>
                Beta版のGeminiは、既定ではTsumugiが用意したAPIキーで動作するため、
                自分でAPIキーを用意しなくても利用できます。OpenAIを使う場合や、
                自分自身のGemini APIキーを使いたい場合は、あなた自身のAPIキーが必要です。
                その場合、Tsumugiの利用自体に料金は発生しませんが、AIサービス側の利用料金は
                Tsumugiの利用料金とは別に発生します。OpenAIのAPIは基本的に有料利用で
                あり、利用にあたって支払い方法の登録が必要になる場合があります。
                Geminiを含め、料金体系・無料枠・利用条件はサービスによって異なるため、
                利用を始める前に、必ずそれぞれの公式サイトで最新の料金・利用条件を
                ご確認ください。
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <p className="text-stone-800 dark:text-stone-100">安全に使うために</p>
              <p>
                ここで入力したあなた自身のAPIキーは、このブラウザのIndexedDBにのみ保存され、
                Tsumugiのサーバーには送信・保存されません。ただし、APIキーが流出すると
                第三者があなたのアカウントでAPIを利用できてしまうため、他人と共有したり、
                公開されるノート・リポジトリなどに貼り付けたりしないよう注意してください。
              </p>
            </div>

            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              className="mt-2 self-end rounded-full border border-stone-300/70 px-4 py-1.5 text-xs text-stone-600 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-300 dark:hover:bg-white/5"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
