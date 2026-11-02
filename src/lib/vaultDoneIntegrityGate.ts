/**
 * 保存済みの全記録の照合を間引いてよいかの判定（`saveFoundationBootstrap.ts`）。起動ごとに次を確かめ、どれかに当てはまれば期限内でも照合する：
 *   - 起動時の走査で、端末と保存先が同じでない記録があった（Markdownの欠け・変更）
 *   - 全記録で共有する管理ファイル（Historyの目次、Registryの案内）が無い・読めない
 * 走査は毎回全ファイルを読むので前者に追加の読み取りは無い。後者は数ファイルだけ読む。
 */
import type { ProductionMigrationResult } from "./vaultProductionMigration";

export function migrationFoundOnlySameRecords(m: ProductionMigrationResult): boolean {
  const single = [m.summary, m.reflectionSummary, m.sourceSummary];
  return single.every((s) => s.idbOnly === 0 && s.legitimateSuccessor === 0 && s.conflict === 0 && s.unreadable === 0)
    && m.memorySummary.idbOnly === 0 && m.memorySummary.legitimateSuccessor === 0 && m.memorySummary.conflict === 0 && m.memorySummary.unreadableDayfiles === 0;
}

async function readObject(dir: FileSystemDirectoryHandle, name: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
}

export async function sharedManagementFilesAreReadable(root: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const tsumugi = await root.getDirectoryHandle(".tsumugi");
    await readObject(tsumugi, "registry-index.json");
    await readObject(tsumugi, "registry-meta.json");
    const months = (await readObject(tsumugi, "history-meta.json")).months;
    if (!months || typeof months !== "object") return false;
    const history = await tsumugi.getDirectoryHandle("history");
    for (const month of Object.keys(months)) await readObject(history, `${month}.json`);
    return true;
  } catch {
    return false;
  }
}
