"use client";

/**
 * コピーのボタン（表示・コピー専用）。押した時点で文を作ってコピーし、成功したときだけ「コピーしました」と短く表示する。
 * 失敗したときは「コピーできませんでした」と表示する（成功したようには見せない）。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { copyText } from "@/lib/copyText";

export default function CopyButton({ label, build, className, style, testId }: { label: string; build: () => string; className?: string; style?: CSSProperties; testId?: string }) {
  const [status, setStatus] = useState<"idle" | "ok" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onClick = async () => {
    let ok = false;
    try {
      ok = await copyText(build());
    } catch {
      ok = false;
    }
    setStatus(ok ? "ok" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), ok ? 2000 : 4000);
  };

  return (
    <button type="button" onClick={() => void onClick()} className={className} style={style} data-testid={testId} aria-live="polite">
      {status === "ok" ? "コピーしました" : status === "failed" ? "コピーできませんでした" : label}
    </button>
  );
}
