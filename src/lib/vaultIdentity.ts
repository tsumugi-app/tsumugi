/**
 * Vault Identity（新保存基盤 Phase 3-1）。
 *
 * 「このIndexedDB（＝このTsumugi world）は、今接続しているVaultと本当に対だったか」を
 * 判定するための、IndexedDB側のペアリング記録の型。
 *
 * Phase 3-1では型とDB CRUD（db.ts）のみ実装する。実際の照合ロジック——
 * `.tsumugi/vault-identity.json`が無いことを即「新規Vault」と判定せず、
 * 既存Markdown/.tsumugi/Registry/Historyの有無からlegacy Vaultを安全に見分け、
 * 同一性を確認できた場合にのみペアリングする——はPhase 3-4で設計・実装する
 * （このファイルはその際に拡張する）。
 */

/** 固定key（singleton record。IndexedDBには常に高々1件）。 */
export const VAULT_IDENTITY_RECORD_ID = "current" as const;

export interface VaultIdentityRecord {
  id: typeof VAULT_IDENTITY_RECORD_ID;
  /**
   * ペア済みVaultのID（`.tsumugi/vault-identity.json`のvaultIdと一致するはずの値）。
   * 未ペア（まだ一度も安全に確認できていない）状態はnull。
   */
  vaultId: string | null;
  activeVaultEpoch: number | null;
  registryGeneration: string | null;
  /** 安全にペアリングできたと判定した時刻。未ペアはnull。 */
  pairedAt: string | null;
  updatedAt: string;
}

export function emptyVaultIdentityRecord(now: string): VaultIdentityRecord {
  return {
    id: VAULT_IDENTITY_RECORD_ID,
    vaultId: null,
    activeVaultEpoch: null,
    registryGeneration: null,
    pairedAt: null,
    updatedAt: now,
  };
}
