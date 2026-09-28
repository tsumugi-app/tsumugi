/**
 * Vault Identity（新保存基盤 Phase 3-1／Phase 3-4）。
 *
 * 「このIndexedDB（＝このTsumugi world）は、今接続しているVaultと本当に対だったか」を
 * 判定するための、IndexedDB側のペアリング記録の型。
 *
 * 実際の照合・legacy Vault adoptionロジックは`vaultIdentityAdoption.ts`（Phase 3-4）を
 * 参照。このファイルは型とDB CRUD（db.ts）用の最小限のヘルパーだけを持つ。
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
  /**
   * Phase 3-4：adoption/新規発行の途中で、`vaultId`が確定する前に必ずここへ
   * durable保存するcandidate ID（`crypto.randomUUID()`等で生成）。
   * kill→restart後も、ここに値があれば同じcandidateをそのまま使い続け、
   * 新しいIDを発行し直さない（req 8）。`vaultId`が確定すればnullへ戻す。
   */
  pendingCandidateVaultId: string | null;
  updatedAt: string;
}

export function emptyVaultIdentityRecord(now: string): VaultIdentityRecord {
  return {
    id: VAULT_IDENTITY_RECORD_ID,
    vaultId: null,
    activeVaultEpoch: null,
    registryGeneration: null,
    pairedAt: null,
    pendingCandidateVaultId: null,
    updatedAt: now,
  };
}
