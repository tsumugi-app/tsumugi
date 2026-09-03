/**
 * Markdownエクスポート用の最小ZIPビルダー。
 *
 * 「Markdownをエクスポート」機能のために、外部ライブラリ（JSZip等）を追加せず、
 * store方式（無圧縮）のZIPファイルをクライアントサイドだけで組み立てる。
 * Markdown（テキスト）程度のサイズでは圧縮の有無による実用上の差は小さく、
 * 依存関係を増やさずCRC32計算＋ZIPヘッダの組み立てだけで完結させられるメリットの
 * 方が大きいと判断した。生成されるファイルはZIP仕様に沿った標準形式で、
 * macOS/Windows/iOS標準の展開機能でそのまま開ける。
 */

export interface ZipEntryInput {
  /** ZIP内のパス（例："Memories/2026-07-26.md"）。区切りは常に"/"。 */
  path: string;
  content: string;
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIPのローカルファイルヘッダ等が要求するMS-DOS形式の日時に変換する。 */
function toDosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function u32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}
function u16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

/** 「ファイル名はUTF-8」を示す汎用目的ビットフラグ（bit 11）。日本語パス・内容を含むMarkdownのため常に立てる。 */
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0; // 無圧縮
const VERSION = 20;

/**
 * ファイル一覧から、無圧縮（store方式）のZIPファイルをBlobとして生成する。
 * 空の配列を渡した場合は、エントリ0件の（それ自体は正しい）空ZIPを返す
 * （「データが無い」の判定は呼び出し側で行う想定）。
 */
export function createZipBlob(files: ZipEntryInput[]): Blob {
  const encoder = new TextEncoder();
  const { time, date } = toDosDateTime(new Date());

  const parts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const contentBytes = encoder.encode(file.content);
    const crc = crc32(contentBytes);

    const local = new ArrayBuffer(30);
    const lv = new DataView(local);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, VERSION);
    u16(lv, 6, UTF8_FLAG);
    u16(lv, 8, STORE_METHOD);
    u16(lv, 10, time);
    u16(lv, 12, date);
    u32(lv, 14, crc);
    u32(lv, 18, contentBytes.length);
    u32(lv, 22, contentBytes.length);
    u16(lv, 26, nameBytes.length);
    u16(lv, 28, 0);

    parts.push(local, nameBytes, contentBytes);

    const central = new ArrayBuffer(46);
    const cv = new DataView(central);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, VERSION);
    u16(cv, 6, VERSION);
    u16(cv, 8, UTF8_FLAG);
    u16(cv, 10, STORE_METHOD);
    u16(cv, 12, time);
    u16(cv, 14, date);
    u32(cv, 16, crc);
    u32(cv, 20, contentBytes.length);
    u32(cv, 24, contentBytes.length);
    u16(cv, 28, nameBytes.length);
    u16(cv, 30, 0);
    u16(cv, 32, 0);
    u16(cv, 34, 0);
    u16(cv, 36, 0);
    u32(cv, 38, 0);
    u32(cv, 42, offset);

    centralParts.push(central, nameBytes);
    centralSize += central.byteLength + nameBytes.length;

    offset += local.byteLength + nameBytes.length + contentBytes.length;
  }

  const centralOffset = offset;

  const end = new ArrayBuffer(22);
  const ev = new DataView(end);
  u32(ev, 0, 0x06054b50);
  u16(ev, 4, 0);
  u16(ev, 6, 0);
  u16(ev, 8, files.length);
  u16(ev, 10, files.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, centralOffset);
  u16(ev, 20, 0);

  return new Blob([...parts, ...centralParts, end], { type: "application/zip" });
}
