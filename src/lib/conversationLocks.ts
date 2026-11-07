/**
 * Which conversations are in use, across tabs. Web Locks are released by the browser when a tab closes or crashes, so nothing can stay stuck after a stop.
 * Order: these are always taken before the Vault world lock, never while holding it.
 */
const openName = (id: string) => `tsumugi-conversation-open-${id}`;
const captureName = (id: string) => `tsumugi-conversation-capture-${id}`;
export const AUTO_CAPTURE_RUN_LOCK = "tsumugi-auto-capture-run";

export const conversationLocksSupported = () => typeof navigator !== "undefined" && typeof navigator.locks !== "undefined";

/** the tab has this conversation open until the returned function is called */
export function holdConversationOpen(id: string): () => void {
  if (!conversationLocksSupported()) return () => undefined;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  void navigator.locks.request(openName(id), () => held).catch(() => undefined);
  return release;
}

/** runs fn only if the lock is free right now */
export async function ifLockFree<T>(name: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  return navigator.locks.request(name, { ifAvailable: true }, async (lock) => (lock ? { ran: true as const, value: await fn() } : { ran: false as const }));
}

/** for the automatic run: fn runs only if no tab has the conversation open and no Capture of it is running */
export async function ifConversationFree<T>(id: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const open = await ifLockFree(openName(id), () => ifLockFree(captureName(id), fn));
  return open.ran ? open.value : open;
}

/** 「終了して日記を生成する」・ホームの「日記を仕上げる」・自動の仕上げ（PR-C）が同じ日記を同時に進めない */
export const realtimeDiaryFinishLock = (id: string) => `tsumugi-realtime-diary-finish:${id}`;
export const REALTIME_DIARY_AUTO_RUN_LOCK = "tsumugi-realtime-diary-auto-run";

/** for the automatic diary finishing: as ifConversationFree, and no finishing of the same diary is running */
export async function ifRealtimeDiaryFree<T>(id: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const free = await ifConversationFree(id, () => ifLockFree(realtimeDiaryFinishLock(id), fn));
  return free.ran ? free.value : free;
}

/** for the end of a conversation: waits for a Capture of it in another tab, so the state can be read again before calling the AI */
export async function withConversationCapture<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (!conversationLocksSupported()) return fn();
  return navigator.locks.request(captureName(id), fn) as Promise<T>;
}
