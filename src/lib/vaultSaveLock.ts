/** Bootstrapとlegacy writerのread/compare/write全区間を直列化する。
 * world lockの内側、Registry/History lockの外側で取得し、再入しない。
 * Web Locksは別タブも保護する。非対応環境では同一JS実行環境だけを保護する。
 */
const LOCK_NAME = "tsumugi-save-foundation-bootstrap";
let tail: Promise<unknown> = Promise.resolve();
export async function withVaultSaveLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(LOCK_NAME, operation);
  }
  const result = tail.then(operation);
  tail = result.catch(() => undefined);
  return result;
}
