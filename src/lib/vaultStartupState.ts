/**
 * 起動時のVault初期化が終わる前（`tabVaultEpoch`が未確定で、`vaultStatus`がまだ"checking"）かどうか。
 *
 * この間に起きた`StaleVaultTabError`は、「別のタブが保存先を切り替えた」のではなく、単に「このタブの
 * 起動処理（Vault復元・journal確認・epoch確定）がまだ終わっていない」ことを表す。UIはこれを
 * 「別のタブで保存先が変更されました」（crossTabStale）と誤って案内せず、一時的な「準備中」案内にする。
 *
 * これは表示の分類だけであり、安全性には一切関与しない：操作の拒否は`withVaultWorldRead`が従来どおり
 * 行う（epoch未確定なら必ず拒否＝fail-closed。このファイルはそれを緩めない）。実際の別タブ切替・
 * epoch不一致（`tabVaultEpoch`が確定した後の不一致）は、ここではfalseを返し、従来どおりcrossTabStaleになる。
 */
export function isVaultStartupInProgress(tabVaultEpoch: number | null, vaultStatus: string): boolean {
  return tabVaultEpoch === null && vaultStatus === "checking";
}
