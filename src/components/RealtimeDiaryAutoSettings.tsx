"use client";

import { useEffect, useState } from "react";
import { parseRealtimeDiaryAutoSettings, REALTIME_DIARY_AUTO_MAX_ATTEMPTS, type RealtimeDiaryAutoSettings as Settings } from "@/lib/realtimeDiaryAuto";
import { loadRealtimeDiaryAutoRaw, saveRealtimeDiaryAutoSettingsRaw } from "@/lib/db";

const AI_LABEL: Record<string, string> = { gemini: "Gemini", openai: "OpenAI" };

/**
 * リアルタイム日記の自動の仕上げ（PR-C）。標準はオフで、ここでオンにした端末だけ、午前4時を過ぎても仕上がっていない日記を次の起動時に仕上げる。
 * オフのときは何も送らず、ホームに「昨日の日記を仕上げる」を出す。
 */
export default function RealtimeDiaryAutoSettings({ selectedProvider }: { selectedProvider: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void loadRealtimeDiaryAutoRaw()
      .then((raw) => setSettings(parseRealtimeDiaryAutoSettings(raw.settings)))
      .catch(() => setSettings({ enabled: false }));
  }, []);
  if (!settings) return null;
  const ai = AI_LABEL[selectedProvider] ?? selectedProvider;
  const change = async (next: Settings) => {
    setSettings(next);
    await saveRealtimeDiaryAutoSettingsRaw(JSON.stringify(next));
  };
  return (
    <section className="flex flex-col gap-3 border-t border-black/5 pt-6 dark:border-white/10" data-testid="realtime-diary-auto">
      <p className="text-sm text-stone-500 dark:text-stone-400">リアルタイム日記の仕上げ</p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={settings.enabled}
          data-testid="realtime-diary-auto-enabled"
          onChange={(e) => void change({ enabled: e.target.checked })}
        />
        <span>日付が変わっても（午前4時を過ぎても）仕上がっていないリアルタイム日記を、次の起動時に自動で仕上げる</span>
      </label>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        その日の会話を、利用するAI（いまは{ai}）へ、登録済みの{ai} APIキーで送り、日記本文とMemoryを作ります。APIキーがない・通信できないときは何も送らず、会話はそのまま仕上げ待ちになります。起動ごとに1件、1件につき{REALTIME_DIARY_AUTO_MAX_ATTEMPTS}回まで試します。オフのときは、ホームの「昨日の日記を仕上げる」から仕上げられます。
      </p>
    </section>
  );
}
