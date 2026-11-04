"use client";

import { useEffect, useState } from "react";
import { parseAutoCaptureSettings, parseAutoCaptureState, summarizeAutoCapture, type AutoCaptureSettings as Settings, type AutoCaptureSummary } from "@/lib/autoCapturePolicy";
import { getAllConversations, getAllMemoryObjects, loadAutoCaptureRaw, saveAutoCaptureSettingsRaw } from "@/lib/db";
import { withVaultWorldRead } from "@/lib/vaultWorldLock";

const RETRY_MESSAGE: Record<string, string> = {
  saved: "Memoryを作成しました。",
  empty: "残す内容はありませんでした。処理は完了しています。",
  "no-key": "GeminiのAPIキーを登録すると試せます。",
  offline: "通信できるときに試してください。",
  blocked: "今は実行できません。保存先の状態を確認してください。",
  nothing: "今は試せる会話がありません。",
};

/** 会話を終了しなかったときのMemory作成。標準はオフで、ここでオンにした端末だけ自動で動く。 */
export default function AutoCaptureSettings({ onRetry }: { onRetry: () => Promise<string> }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [summary, setSummary] = useState<AutoCaptureSummary | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (current?: Settings) => {
    const raw = await loadAutoCaptureRaw();
    const loaded = current ?? parseAutoCaptureSettings(raw.settings);
    setSettings(loaded);
    const { conversations, memories } = await withVaultWorldRead(async () => ({ conversations: await getAllConversations(), memories: await getAllMemoryObjects() }));
    const withMemory = new Set(memories.flatMap((m) => (m.conversationId ? [m.conversationId] : [])));
    setSummary(summarizeAutoCapture(conversations, withMemory, parseAutoCaptureState(raw.state), loaded));
  };

  useEffect(() => {
    void refresh().catch(() => setSettings((s) => s ?? parseAutoCaptureSettings(undefined)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = async (next: Settings) => {
    setSettings(next);
    await saveAutoCaptureSettingsRaw(JSON.stringify(next));
    await refresh(next).catch(() => undefined);
  };
  const retry = async () => {
    setRetrying(true);
    setMessage(null);
    try {
      const outcome = await onRetry();
      setMessage(RETRY_MESSAGE[outcome] ?? "作成できませんでした。時間をおいてもう一度試してください。");
      await refresh().catch(() => undefined);
    } finally {
      setRetrying(false);
    }
  };

  if (!settings) return null;
  return (
    <section className="flex flex-col gap-3 border-t border-black/5 pt-6 dark:border-white/10" data-testid="auto-capture">
      <p className="text-sm text-stone-500 dark:text-stone-400">閉じた会話の記憶</p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={settings.enabled}
          data-testid="auto-capture-enabled"
          onChange={(e) => void change({ ...settings, enabled: e.target.checked })}
        />
        <span>終了操作をしなかった会話からも、次回の起動時にMemoryを作成する</span>
      </label>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        最後の更新から30分以上経った会話を、起動ごとに1件、24時間で5件まで、登録済みのGemini APIキーでGeminiへ送ります。APIキーがなければ何も送りません。失敗した会話は3回まで試します。
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={settings.allowOtherProviders}
          data-testid="auto-capture-other-providers"
          onChange={(e) => void change({ ...settings, allowOtherProviders: e.target.checked })}
        />
        <span>Gemini以外で話した会話と、どのAIで話したか記録がない以前の会話もGeminiへ送る</span>
      </label>
      {summary && (
        <p className="text-xs text-stone-500 dark:text-stone-400" data-testid="auto-capture-summary">
          未処理 {summary.waiting} 件 ／ 許可待ち {summary.needsPermission} 件 ／ 停止中 {summary.stopped} 件
        </p>
      )}
      {summary && summary.stopped > 0 && (
        <button
          type="button"
          disabled={retrying}
          data-testid="auto-capture-retry"
          onClick={() => void retry()}
          className="self-start rounded-full border border-black/10 px-4 py-2 text-sm disabled:opacity-50 dark:border-white/15"
        >
          停止中の会話を1件もう一度試す
        </button>
      )}
      {message && <p className="text-xs text-stone-500 dark:text-stone-400" role="status">{message}</p>}
    </section>
  );
}
