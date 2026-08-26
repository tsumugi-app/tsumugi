/**
 * AI応答待ちの間、経過時間に応じて段階的にメッセージを出すための小さなhook。
 * ideas/IDEAS.md「生成が遅れた時の表示」に対応する（0〜2秒は何も出さない、
 * 2〜5秒で「考えています…」、5秒以上で「少し時間がかかっています」）。
 *
 * handleSend()側にタイマー処理を書き込まずに済むよう、start()/stop()の
 * 呼び出しだけで完結させる（既存の未コミット変更が集中しているhandleSend()への
 * 変更行数を最小限にするため）。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const THINKING_DELAY_MS = 2000;
const SLOW_DELAY_MS = 5000;

export function useWaitingMessage() {
  const [message, setMessage] = useState<string | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const stop = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
    setMessage(null);
  }, []);

  const start = useCallback(() => {
    stop();
    timersRef.current = [
      setTimeout(() => setMessage("考えています…"), THINKING_DELAY_MS),
      setTimeout(() => setMessage("少し時間がかかっています"), SLOW_DELAY_MS),
    ];
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { message, start, stop };
}
