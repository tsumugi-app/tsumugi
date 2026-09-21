/**
 * 「この端末のTsumugiデータを完全に削除」の、durable wipe marker（個人データを含まない）。
 *
 * markerは`localStorage`の1キーだけ。値は開始時刻とバージョンのみで、会話・記憶・APIキー等は一切含まない。
 * markerがある間は「削除が完了していない」ことを意味し、次回起動時（他のどの処理よりも先に、
 * `WipeGate`が）削除を再開する。IndexedDB/OPFSが消えても、markerは全ての検証に通った後で最後に消す。
 *
 * このファイルは他のモジュールをimportしない（db.ts・vault.tsから安全に使うため）。
 * 「削除が始まった後に、遅れて動く古い処理（Capture/Connect/Reflection/revisitPrompt/会話保存/
 * Vault書き込み等）がIndexedDB・OPFSへ書き戻す」ことを構造的に防ぐため、db.tsの接続入口
 * （`getDB`）とvault.tsの書き込みqueue入口（`enqueueVaultWrite`）が`isWipePending()`を毎回確認する。
 */

export const WIPE_MARKER_KEY = "tsumugi:wipe:v1";

export class WipeInProgressError extends Error {
  constructor(message = "この端末のデータを削除しています。") {
    super(message);
    this.name = "WipeInProgressError";
  }
}

/** 削除が開始済み（または未完了）か。localStorageを読めない環境ではfalse。 */
export function isWipePending(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(WIPE_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}
