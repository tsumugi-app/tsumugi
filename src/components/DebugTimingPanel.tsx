"use client";

/**
 * TEMP-TEST：20〜40秒の異常遅延の原因切り分け用。`?debugLog=1`のときだけ表示される、
 * 一時的な診断パネル。それ以外のURLでは何もレンダリングしない（既存UIには一切影響しない）。
 * `src/lib/debugTimingLog.ts`にlocalStorage経由で溜まった計測ログを、Android実機だけで
 * 目視・コピーできるようにするためのもの。原因調査が終わり次第、このファイルと
 * ChatScreen.tsxからの呼び出しごと削除すること。
 */
import { useEffect, useState } from "react";
import { clearTimingLog, getTimingLog, type TimingLogEntry } from "@/lib/debugTimingLog";

function formatEntry(entry: TimingLogEntry): string {
  const params = Object.entries(entry)
    .filter(([key]) => key !== "ts" && key !== "event")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const time = new Date(entry.ts).toLocaleTimeString("ja-JP", { hour12: false });
  return params ? `${time} ${entry.event} ${params}` : `${time} ${entry.event}`;
}

export default function DebugTimingPanel() {
  // `?debugLog=1`かどうかは初回マウント時のURLだけで決まる値のため、effect+setStateではなく
  // 遅延初期化（useStateの関数形）で一度だけ判定する（react-hooks/set-state-in-effect対応）。
  const [enabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("debugLog") === "1";
  });
  const [expanded, setExpanded] = useState(true);
  const [entries, setEntries] = useState<TimingLogEntry[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setEntries([...getTimingLog()].reverse());
    refresh();
    const id = window.setInterval(refresh, 1000);
    return () => window.clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;

  async function handleCopy() {
    const text = entries
      .slice()
      .reverse()
      .map(formatEntry)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("コピーしました");
    } catch {
      setFeedback("コピーに失敗しました");
    }
    window.setTimeout(() => setFeedback(null), 2000);
  }

  function handleClear() {
    clearTimingLog();
    setEntries([]);
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        style={{
          position: "fixed",
          right: 8,
          bottom: 8,
          zIndex: 9999,
          background: "rgba(0,0,0,0.75)",
          color: "#0f0",
          fontFamily: "monospace",
          fontSize: 11,
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid #0f0",
        }}
      >
        ⏱ {entries.length}
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: "38vh",
        overflowY: "auto",
        background: "rgba(0,0,0,0.88)",
        color: "#0f0",
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 1.4,
        padding: 8,
        zIndex: 9999,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
        <button onClick={handleCopy} style={{ border: "1px solid #0f0", padding: "2px 6px" }}>
          全てコピー
        </button>
        <button onClick={handleClear} style={{ border: "1px solid #0f0", padding: "2px 6px" }}>
          クリア
        </button>
        <button onClick={() => setExpanded(false)} style={{ border: "1px solid #0f0", padding: "2px 6px" }}>
          閉じる
        </button>
        <span>{entries.length}件</span>
        {feedback && <span>{feedback}</span>}
      </div>
      {entries.map((entry, index) => (
        <div key={index}>{formatEntry(entry)}</div>
      ))}
    </div>
  );
}
