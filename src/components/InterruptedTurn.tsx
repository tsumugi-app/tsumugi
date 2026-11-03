/** 途中で止まったAI応答。完了した応答と見分けがつくよう印を付け、再試行で別の応答が続いたものは折りたたむ（本文は消さない）。 */
export function InterruptedTurn({ content, superseded }: { content: string; superseded: boolean }) {
  const body = <div className="whitespace-pre-wrap text-sm leading-relaxed text-stone-500 dark:text-stone-400">{content}</div>;
  if (superseded) {
    return (
      <details className="max-w-[85%] text-xs text-stone-400 dark:text-stone-500">
        <summary className="cursor-pointer">途中で止まった応答</summary>
        <div className="mt-1">{body}</div>
      </details>
    );
  }
  return (
    <div className="flex max-w-[85%] flex-col gap-1">
      {body}
      <p className="text-xs text-stone-400 dark:text-stone-500">途中で止まった応答</p>
    </div>
  );
}
