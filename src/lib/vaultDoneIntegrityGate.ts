/**
 * 保存済みの全記録の照合を間引いてよいかの判定（`saveFoundationBootstrap.ts`）。起動ごとに次を確かめ、どれかに当てはまれば期限内でも照合する：
 *   - 起動時の走査で、既定の場所に無い・読めない記録の数が前回の照合の時から変わった（数えるのは照合の後にまだ足りない記録。移動された記録は数え続けるので、数の変化を見る。内容の違いは数えない：turnTimesの無い古い形式は毎回違って見え、変更は軽い確認が見つける）
 *   - 全記録で共有する管理ファイル（index、Historyの目次）が無い・読めない、Registryのshardが無い
 * 走査は毎回全ファイルを読むので前者に追加の読み取りは無い。後者は数ファイルだけ読む。
 */
import { dayFileRegistryKey, vaultRegistryBucketOf } from "./vault";
import type { ProductionMigrationResult } from "./vaultProductionMigration";

export function recordsMissingAtTheirPlace(m: ProductionMigrationResult): number {
  return [m.summary, m.reflectionSummary, m.sourceSummary].reduce((n, s) => n + s.idbOnly + s.unreadable, 0) + m.memorySummary.idbOnly + m.memorySummary.unreadableDayfiles;
}

async function readObject(dir: FileSystemDirectoryHandle, name: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
}

function registryKeyOf(id: string, path: string): string {
  const day = path.match(/^Memories\/(\d{4}-\d{2}-\d{2})\.md$/);
  return day ? dayFileRegistryKey(day[1]) : id;
}

export async function sharedManagementFilesAreReadable(root: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const tsumugi = await root.getDirectoryHandle(".tsumugi");
    const index = await readObject(tsumugi, "index.json");
    const months = (await readObject(tsumugi, "history-meta.json")).months;
    if (!months || typeof months !== "object") return false;
    const history = await tsumugi.getDirectoryHandle("history");
    for (const month of Object.keys(months)) await readObject(history, `${month}.json`);
    // Registryは一覧だけを見る（読めない行は軽い確認が見つける）。shardは、日別ファイルは日付から、それ以外はidから決まる
    const shards = new Set<string>();
    for await (const [name] of (await tsumugi.getDirectoryHandle("registry") as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) shards.add(name);
    return Object.entries(index).every(([id, path]) => typeof path !== "string" || shards.has(`${vaultRegistryBucketOf(registryKeyOf(id, path)).toString(16).padStart(2, "0")}.json`));
  } catch {
    return false;
  }
}
