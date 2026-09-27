"use client";
import { useEffect, useState } from "react";
import { clearCaptureDebug, getCaptureDebugText } from "@/lib/captureDebug";

/** Rendered only by the existing opt-in debug panel. Never reads Memory stores. */
export default function CaptureDebugPanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const next = await getCaptureDebugText();
        if (!cancelled) setText(next);
      } finally { running = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open]);
  async function copy() {
    // Recheck world ownership at copy time, not only at display time.
    const latest = await getCaptureDebugText();
    setText(latest);
    if (!latest) { setFeedback("このworldの診断はありません"); return; }
    try { await navigator.clipboard.writeText(latest); setFeedback("コピーしました"); }
    catch { setFeedback("コピーできませんでした。下のテキストを選択してください"); }
  }
  return <div>
    <button onClick={() => setOpen(!open)}>[D] Capture Debug</button>
    {open && <div>
      <p>会話・候補本文を含みます。このタブの直近5回のみ。再読込で消えます。共有前に内容を確認してください。</p>
      <button onClick={() => void copy()}>Capture Debugをコピー</button>{" "}
      <button onClick={() => { clearCaptureDebug(); setText(""); }}>診断のみクリア</button>
      <span>{feedback}</span>
      <textarea aria-label="Capture Debug" readOnly value={text || "診断なし（debugLog=1で次のCaptureを実行してください）"} style={{ width: "100%", minHeight: 180 }} />
    </div>}
  </div>;
}
