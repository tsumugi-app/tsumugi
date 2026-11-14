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
import { formatContextProvenance } from "@/lib/chatContextProvenance";
import { contextProvenanceFor } from "@/lib/contextProvenanceStore";
import { formatContextBuilderReport } from "@/lib/contextBuilder";
import { contextBuilderReportFor } from "@/lib/contextBuilderStore";
import { formatServerDedupeReport } from "@/lib/contextDedupe";
import { formatServerReasonReport } from "@/lib/explicitReason";
import { formatDebugCopy } from "@/lib/debugCopy";
import CopyButton from "./CopyButton";

/** P1-H 段階1：診断の文の組み立てに失敗しても、このバッジのほかの表示は出す */
function safeBuilderText(stored: NonNullable<ReturnType<typeof contextBuilderReportFor>>): string {
  try {
    // 段階2-A：サーバーが実際に外したもの（ON）を先に、続けて端末の判定
    // P1-H：サーバーが実際に受け取った本人の理由・訂正（端末の判定は下の「■ 質問に答える本人の理由・訂正（端末の判定）」）
    return `${formatServerDedupeReport(stored.server)}\n${formatServerReasonReport(stored.serverReason)}\n\n${formatContextBuilderReport(stored.report)}`;
  } catch {
    return "（Context Builderの診断を表示できなかった）";
  }
}

/** the short copy for pasting into another AI (the detailed view below stays as it is) */
function safeCopyText(entry: StoredGenerationDebugEntry, question: string, answer: string, turnTimestamp: string): string {
  try {
    return formatDebugCopy({ question, answer, generationId: entry.generationId, generation: entry.generation, serverAccepted: entry.serverAccepted, builder: contextBuilderReportFor(turnTimestamp) ?? null });
  } catch {
    return `【Tsumugi 診断ログ（短縮版）】\nGeneration ID：${entry.generationId}\n（短縮版を作れなかった。[D]の詳細表示を参照）\n\n■ 質問（全文）\n${question}\n\n■ AIの返答（全文）\n${answer}`;
  }
}

export default function GenerationDebugBadge({ turnTimestamp, question = "", answer = "" }: { turnTimestamp: string; question?: string; answer?: string }) {
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
  // P1-F：経路ごとの由来（このタブのメモリにだけある。再読み込みの後は無い）
  const provenance = open ? contextProvenanceFor(turnTimestamp) : undefined;
  // P1-H 段階1：Context Builderの診断（同じく、このタブのメモリにだけある）
  const builderReport = open ? contextBuilderReportFor(turnTimestamp) : undefined;

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
      <CopyButton
        label="診断ログをコピー"
        testId="debug-copy"
        build={() => safeCopyText(entry, question, answer, turnTimestamp)}
        style={{ marginLeft: 6, fontSize: 11, padding: "4px 8px", borderRadius: 4, border: "1px solid #7dd3fc", color: "#0284c7", background: "transparent" }}
      />
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
          {builderReport ? `${safeBuilderText(builderReport)}\n\n――― 以下、経路ごとの由来（P1-F） ―――\n` : ""}
          {provenance ? `${formatContextProvenance(provenance)}\n\n――― 以下、従来の記録 ―――\n` : open ? "（経路ごとの由来は、このタブで送ったターンだけ表示できる。再読み込みの後は無い）\n\n" : ""}
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
