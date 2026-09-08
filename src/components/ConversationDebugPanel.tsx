"use client";

/**
 * TEMP-TEST：PC/スマホ間で応答傾向が異なって見える件の原因切り分け用。`?debugLog=1`の
 * ときだけ表示される、一時的な診断パネル。それ以外のURLでは何もレンダリングしない
 * （既存UIには一切影響しない）。DebugTimingPanel.tsxと同じ設計パターンを踏襲する。
 *
 * `src/lib/conversationDebugLog.ts`にlocalStorage経由で溜まった[ConversationDebug]ログを、
 * スマホ実機でもConsoleを開かずに目視・コピーできるようにするためのもの。
 * 会話ロジック・Retrievalロジック・system prompt・persona prompt・保存処理・tree関連は
 * 一切変更しない（このパネルは既存ログの表示先を増やすだけ）。
 *
 * 調査が終わり次第、このファイルとChatScreen.tsxからの呼び出しごと削除すること。
 */
import { useEffect, useState } from "react";
import { clearConversationDebugLog, getConversationDebugLog } from "@/lib/conversationDebugLog";

export default function ConversationDebugPanel() {
  // `?debugLog=1`かどうかは初回マウント時のURLだけで決まる値のため、DebugTimingPanel.tsxと
  // 同じく遅延初期化（useStateの関数形）で一度だけ判定する。
  const [enabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("debugLog") === "1";
  });
  const [expanded, setExpanded] = useState(true);
  const [entries, setEntries] = useState<{ ts: number; text: string }[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setEntries([...getConversationDebugLog()].reverse());
    refresh();
    const id = window.setInterval(refresh, 1000);
    return () => window.clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;

  async function handleCopy() {
    const text = entries
      .slice()
      .reverse()
      .map((entry) => entry.text)
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("コピーしました");
    } catch {
      setFeedback("コピーに失敗しました");
    }
    window.setTimeout(() => setFeedback(null), 2000);
  }

  function handleClear() {
    clearConversationDebugLog();
    setEntries([]);
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        style={{
          position: "fixed",
          left: 8,
          top: 8,
          zIndex: 9999,
          background: "rgba(0,0,0,0.75)",
          color: "#7dd3fc",
          fontFamily: "monospace",
          fontSize: 11,
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid #7dd3fc",
        }}
      >
        🗨 {entries.length}
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: 0,
        maxHeight: "42vh",
        overflowY: "auto",
        background: "rgba(0,0,0,0.9)",
        color: "#7dd3fc",
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 1.4,
        padding: 8,
        zIndex: 9999,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{ fontWeight: "bold" }}>Conversation Debug</span>
        <button onClick={handleCopy} style={{ border: "1px solid #7dd3fc", padding: "2px 6px" }}>
          全てコピー
        </button>
        <button onClick={handleClear} style={{ border: "1px solid #7dd3fc", padding: "2px 6px" }}>
          クリア
        </button>
        <button onClick={() => setExpanded(false)} style={{ border: "1px solid #7dd3fc", padding: "2px 6px" }}>
          閉じる
        </button>
        <span>{entries.length}件</span>
        {feedback && <span>{feedback}</span>}
      </div>
      {entries.length === 0 && <div>まだ記録がありません（メッセージを送信すると記録されます）</div>}
      {entries.map((entry, index) => (
        <div key={index} style={{ marginBottom: 10, borderBottom: "1px solid rgba(125,211,252,0.3)", paddingBottom: 6 }}>
          <div style={{ opacity: 0.7 }}>{new Date(entry.ts).toLocaleTimeString("ja-JP", { hour12: false })}</div>
          <div>{entry.text}</div>
        </div>
      ))}
    </div>
  );
}
