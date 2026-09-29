/**
 * Storage Persistence API（新保存基盤 Phase 3-7 req 15）薄いutility。
 *
 * `navigator.storage.persist()`／`persisted()`／`estimate()`を、失敗しても
 * 安全に握りつぶす薄いラッパーとしてまとめる。
 *
 * 重要：この情報は診断専用（diagnostic-only）。`persist()`がfalseでも、
 * `estimate()`が例外を投げても、`navigator.storage`自体がSafari/WebKit等で
 * 使えなくても、Save Foundation（Projection・Migration・Bootstrap）の
 * 正しさの前提条件には一切しない——このファイルのどの関数も、呼び出し元の
 * 保存処理を止めるようなthrowを一切しない（内部で必ずtry/catchし、
 * 取得できない項目は`null`のまま返す）。
 */

export interface StoragePersistenceDiagnostics {
  /**
   * `null`＝取得できなかった（`navigator.storage`が無い・`persisted()`が無い・
   * 例外）。`false`＝実際に「永続化されていない」と応答があった、という区別を
   * 保つため、取得不能を`false`に丸めない。
   */
  persistent: boolean | null;
  usage: number | null;
  quota: number | null;
}

interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

function getStorageManager(): StorageManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const storage = (navigator as unknown as { storage?: StorageManagerLike }).storage;
  return storage ?? null;
}

/**
 * 永続化をリクエストする（許可ダイアログの有無・応答はブラウザ依存）。
 * 呼び出し元は戻り値を「保存の前提条件」として扱わないこと——`false`／`null`
 * どちらであっても、Save Foundationは通常どおり動作を続ける。
 */
export async function requestStoragePersistence(): Promise<boolean | null> {
  const storage = getStorageManager();
  if (!storage || typeof storage.persist !== "function") return null;
  try {
    return await storage.persist();
  } catch (error) {
    console.error("[Tsumugi] navigator.storage.persist() failed (diagnostic only, save correctness unaffected):", error);
    return null;
  }
}

/** 現在の永続化状態・使用量・割当量を、取得できる範囲だけ返す（例外を投げない）。 */
export async function getStoragePersistenceDiagnostics(): Promise<StoragePersistenceDiagnostics> {
  const result: StoragePersistenceDiagnostics = { persistent: null, usage: null, quota: null };
  const storage = getStorageManager();
  if (!storage) return result;

  if (typeof storage.persisted === "function") {
    try {
      result.persistent = await storage.persisted();
    } catch (error) {
      console.error("[Tsumugi] navigator.storage.persisted() failed (diagnostic only):", error);
    }
  }

  if (typeof storage.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      result.usage = typeof estimate.usage === "number" ? estimate.usage : null;
      result.quota = typeof estimate.quota === "number" ? estimate.quota : null;
    } catch (error) {
      console.error("[Tsumugi] navigator.storage.estimate() failed (diagnostic only):", error);
    }
  }

  return result;
}
