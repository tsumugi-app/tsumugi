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
  /** 文字列はUTF-8で書く。バイト列（バックアップの原本）はそのまま書く。 */
  content: string | Uint8Array;
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

export function crc32(bytes: Uint8Array): number {
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
  return new Blob(createZipParts(files) as BlobPart[], { type: "application/zip" });
}

/** createZipBlobと同じZIPを、1つのバイト列として返す（書き込んだものを読み戻して照合するため）。 */
export function createZipBytes(files: ZipEntryInput[]): Uint8Array {
  const parts = createZipParts(files);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p instanceof Uint8Array ? p : new Uint8Array(p), at); at += p.byteLength; }
  return out;
}

/** ZIP64は使わないため、件数・大きさがこの範囲を超えるZIPは作らない（黙って壊れたZIPを作らない）。 */
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;

function createZipParts(files: ZipEntryInput[]): (ArrayBuffer | Uint8Array)[] {
  if (files.length > MAX_ENTRIES) throw new Error("zip-too-many-entries");
  const encoder = new TextEncoder();
  const { time, date } = toDosDateTime(new Date());

  const parts: (ArrayBuffer | Uint8Array)[] = [];
  const centralParts: (ArrayBuffer | Uint8Array)[] = [];
  let offset = 0;
  let centralSize = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const contentBytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
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
    if (offset > MAX_OFFSET) throw new Error("zip-too-large");
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

  return [...parts, ...centralParts, end];
}

export class ZipFormatError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ZipFormatError"; }
}

/**
 * createZipBytesが作る形式（store方式・ZIP64なし・データ記述子なし）のZIPを厳密に読む（バックアップの読み戻し検証用）。
 * 終端レコード（件数・位置・コメント長）、セントラルディレクトリを最後まで読み切ったこと、各エントリのローカルヘッダとセントラルヘッダの
 * 一致（方式・フラグ・CRC・大きさ・名前）、エントリが隙間・重なりなく並んでいること、CRC32を確かめ、どれかが合わなければ
 * ZipFormatErrorを投げる（途中まで読めた結果は返さない）。
 */
export function readZipEntries(bytes: Uint8Array): { path: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (code: string): never => { throw new ZipFormatError(code); };
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0) fail("zip-no-end-record");
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0 || view.getUint16(eocd + 8, true) !== count) fail("zip-bad-end-record");
  if (centralOffset + centralSize !== eocd) fail("zip-bad-central-directory");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const out: { path: string; data: Uint8Array }[] = [];
  const seen = new Set<string>();
  let at = centralOffset;
  let nextLocal = 0;   // エントリは先頭から隙間なく並ぶ
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50) fail("zip-bad-central-entry");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    if ((flags & ~UTF8_FLAG) !== 0 || method !== STORE_METHOD || view.getUint32(at + 24, true) !== size) fail("zip-unsupported-entry");
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > eocd) fail("zip-bad-central-entry");
    const localOffset = view.getUint32(at + 42, true);
    let path = "";
    try { path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)); } catch { fail("zip-bad-name"); }
    if (seen.has(path)) fail("zip-duplicate-entry");
    seen.add(path);
    if (localOffset !== nextLocal || localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) fail("zip-bad-local-header");
    if (view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method || view.getUint32(localOffset + 14, true) !== crc
      || view.getUint32(localOffset + 18, true) !== size || view.getUint32(localOffset + 22, true) !== size) fail("zip-header-mismatch");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const centralName = bytes.subarray(at + 46, at + 46 + nameLength), localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localNameLength !== nameLength || localName.some((b, i) => b !== centralName[i])) fail("zip-header-mismatch");
    const dataStart = localOffset + 30 + localNameLength + view.getUint16(localOffset + 28, true);
    if (dataStart + size > centralOffset) fail("zip-truncated-entry");
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) !== crc) fail("zip-crc-mismatch");
    out.push({ path, data });
    nextLocal = dataStart + size;
    at = next;
  }
  if (at !== eocd || nextLocal !== centralOffset) fail("zip-bad-central-directory");   // 宣言より多い・少ないエントリ、余分なバイト
  return out;
}
