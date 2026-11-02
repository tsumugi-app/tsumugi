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

/** 保存済みの全記録の照合を、次に行う時期か。ビルドが変わったとき、前回から時間が経ったとき、前回の記録が読めないときに行う。 */
export function doneIntegrityIsDue(marker: unknown, build: string, now: string, maxAgeMs: number): boolean {
  if (typeof marker !== "string") return true;
  let parsed: { build?: unknown; at?: unknown };
  try { parsed = JSON.parse(marker); } catch { return true; }
  if (parsed?.build !== build || typeof parsed.at !== "string") return true;
  const age = Date.parse(now) - Date.parse(parsed.at);
  return !(age >= 0 && age < maxAgeMs);
}
