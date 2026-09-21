"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { defaultWipeEnv, hasWipeMarker, runPendingWipe, type WipeCheck } from "@/lib/dataWipe";
import { WIPE_MARKER_KEY } from "@/lib/wipeState";

/**
 * アプリ本体（ChatScreen）を起動する前に、未完了の「完全削除」（durable wipe marker）が無いかを確認する門。
 * markerがあれば、他のどの処理（Capture・Connect・Vault復元・IndexedDB読み込み等）よりも先に削除を
 * 再開・完了させる。削除が完了して検証に通るまで、アプリ本体は起動しない（=古いデータが復活・書き戻されない）。
 *
 * 別タブが削除を開始した場合（storageイベント）や、ブラウザの戻る/進むで古いページが復元された場合
 * （pageshow）も、このタブのアプリ本体を止めて削除の完了を待ち、その後ページを読み込み直す。
 * 複数タブが同時に削除しないよう、Web Lock（tsumugi-wipe）で直列化する。
 */
type Phase =
  | { kind: "checking" }
  | { kind: "running"; message: string }
  | { kind: "failed"; failures: string[] }
  | { kind: "done"; checks: WipeCheck[] }
  | { kind: "ready" };

const WIPE_LOCK_NAME = "tsumugi-wipe";

export default function WipeGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  const run = useCallback(async (reloadAfter: boolean) => {
    if (!hasWipeMarker()) {
      if (reloadAfter) window.location.reload();
      else setPhase({ kind: "ready" });
      return;
    }
    setPhase({ kind: "running", message: "端末内のデータを削除しています…" });
    const execute = () => runPendingWipe(defaultWipeEnv((message) => setPhase({ kind: "running", message })));
    try {
      const result = typeof navigator !== "undefined" && navigator.locks
        ? await navigator.locks.request(WIPE_LOCK_NAME, { mode: "exclusive" }, execute)
        : await execute();
      if (result.status === "failed") {
        setPhase({ kind: "failed", failures: result.failures });
      } else if (reloadAfter) {
        window.location.reload();
      } else if (result.status === "completed") {
        setPhase({ kind: "done", checks: result.checks });
      } else {
        setPhase({ kind: "ready" });
      }
    } catch (error) {
      setPhase({ kind: "failed", failures: [error instanceof Error ? error.message : String(error)] });
    }
  }, []);

  useEffect(() => {
    // 初回判定はeffect本体の外（マイクロタスク）で行う（effect内での同期setStateを避ける）。
    void Promise.resolve().then(() => run(false));
    const onStorage = (event: StorageEvent) => {
      if (event.key === WIPE_MARKER_KEY && event.newValue !== null) void run(true);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && hasWipeMarker()) void run(true);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [run]);

  if (phase.kind === "ready") return <>{children}</>;
  if (phase.kind === "checking") return <div className="flex-1" aria-busy="true" />;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-6 py-10 text-sm text-stone-700 dark:text-stone-300">
      {phase.kind === "running" && (
        <>
          <h1 className="text-base font-medium">この端末のTsumugiデータを削除しています</h1>
          <p>{phase.message}</p>
          <p className="text-xs text-stone-500 dark:text-stone-400">このまま閉じずにお待ちください。途中で閉じても、次に開いたときに続きから削除します。</p>
        </>
      )}
      {phase.kind === "done" && (
        <>
          <h1 className="text-base font-medium">削除が完了しました</h1>
          <ul className="flex flex-col gap-1 text-xs text-stone-500 dark:text-stone-400">
            {phase.checks.map((check) => (
              <li key={check.name}>
                ・{check.name}：{check.detail}
              </li>
            ))}
          </ul>
          <button
            onClick={() => setPhase({ kind: "ready" })}
            className="self-start rounded-full border border-stone-400/60 px-4 py-2 text-sm transition hover:bg-stone-900/5 dark:border-stone-500/60 dark:hover:bg-white/5"
          >
            Tsumugiを新しく始める
          </button>
        </>
      )}
      {phase.kind === "failed" && (
        <>
          <h1 className="text-base font-medium text-red-600 dark:text-red-400">削除を完了できませんでした</h1>
          <p>安全のため、削除が完了するまでTsumugiは起動しません。</p>
          <ul className="flex flex-col gap-1 text-xs text-stone-500 dark:text-stone-400">
            {phase.failures.map((failure) => (
              <li key={failure}>・{failure}</li>
            ))}
          </ul>
          <button
            onClick={() => void run(false)}
            className="self-start rounded-full border border-stone-400/60 px-4 py-2 text-sm transition hover:bg-stone-900/5 dark:border-stone-500/60 dark:hover:bg-white/5"
          >
            もう一度削除する
          </button>
        </>
      )}
    </main>
  );
}
