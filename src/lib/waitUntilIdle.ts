/**
 * Resolves "idle" the moment `isIdle()` is true (checked immediately, no fixed delay), otherwise polls every `pollMs` until `maxWaitMs` has passed.
 * "cancelled" when `isCancelled()` becomes true; "timeout" when the work never settled (the caller reports that instead of guessing).
 */
export async function waitUntilIdle(
  isIdle: () => boolean,
  isCancelled: () => boolean,
  options: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<"idle" | "cancelled" | "timeout"> {
  const pollMs = options.pollMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; ; waited += pollMs) {
    if (isCancelled()) return "cancelled";
    if (isIdle()) return "idle";
    if (waited >= maxWaitMs) return "timeout";
    await sleep(pollMs);
  }
}
