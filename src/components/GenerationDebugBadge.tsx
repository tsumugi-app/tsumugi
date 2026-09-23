"use client";

/**
 * Conversation Debugger v1（開発専用）。`?debugLog=1`のときだけ、AI返答の近くに
 * 小さな`[D]`を表示する。通常URLではDOMへ一切出さない（`debugLogEnabled()`が
 * falseなら即`null`を返す）。
 *
 * 既存の`ConversationDebugPanel.tsx`（画面固定の一覧パネル）とは別の見せ方——
 * こちらは「このAI返答“1件”の生成に実際に使われたcontext」を、そのメッセージの
 * すぐ近くで確認するための最小UI。データは`generationDebugLog.ts`（localStorageのみ、
 * Vault epoch安全性つき）から読む。
 */
import { useEffect, useState } from "react";
import { debugLogEnabled, getGenerationDebugLog, type StoredGenerationDebugEntry } from "@/lib/generationDebugLog";

export default function GenerationDebugBadge({ turnTimestamp }: { turnTimestamp: string }) {
  const [enabled] = useState(() => debugLogEnabled());
  const [entry, setEntry] = useState<StoredGenerationDebugEntry | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled || !turnTimestamp) return;
    let cancelled = false;
    void getGenerationDebugLog().then((entries) => {
      if (cancelled) return;
      const match = entries.find((e) => e.turnTimestamp === turnTimestamp) ?? null;
      setEntry(match);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, turnTimestamp]);

  if (!enabled || !entry) return null;

  return (
    <div style={{ marginTop: 2 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          fontFamily: "monospace",
          fontSize: 10,
          padding: "1px 5px",
          borderRadius: 4,
          border: "1px solid #7dd3fc",
          color: "#0284c7",
          background: "transparent",
        }}
        title="Conversation Debugger: このAI返答の生成に実際に使われたcontext"
      >
        [D]
      </button>
      {open && (
        <pre
          style={{
            marginTop: 4,
            maxHeight: "40vh",
            overflow: "auto",
            background: "rgba(0,0,0,0.9)",
            color: "#7dd3fc",
            fontFamily: "monospace",
            fontSize: 10,
            lineHeight: 1.4,
            padding: 8,
            borderRadius: 6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {JSON.stringify(
            {
              generationId: entry.generationId,
              Generation: entry.generation,
              "Client Sent": entry.clientSent,
              "Server Accepted": entry.serverAccepted,
            },
            null,
            2
          )}
        </pre>
      )}
    </div>
  );
}
