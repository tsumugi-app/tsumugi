/**
 * 既存のMarkdownを書き換えてよいかの共通の安全条件。通常の保存・Outboxの再試行・完了後の整合性確認・起動時の処理・自動修復は、すべてここの判定を通る。
 *
 * 原則：既存のファイルの内容は、次のどちらかを証明できるときだけ置き換える。
 *   (1) 置き換える部分が、Tsumugi自身が最後に書いた内容そのものである（Registryのハッシュと一致する）
 *   (2) 置き換えた後の内容が、元の内容をすべて含んでいる（変わるのは、Tsumugiが管理する更新用の項目だけ）
 * どちらも証明できなければ書かない（呼び出し側がOutboxに保留として残す。端末の記録もファイルも変えない）。
 *
 * 日別ファイルは丸ごと書き直さない：対象の記録の部分だけを置き換える・足す。他の部分（他の記録・手書きの追記・読めない部分）は1バイトも変えない。
 * このモジュールはファイルに触れない（読み書きは呼び出し側）。
 */
import { MEMORY_ENTRY_SEPARATOR, memoryObjectToMarkdown, parseMemoryDayFile, parseMemoryObjectMarkdown } from "./markdown";
import type { MemoryObject } from "./types";

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

export class VaultFileNotUtf8Error extends Error {
  constructor() { super("vault-file-invalid-utf8"); this.name = "VaultFileNotUtf8Error"; }
}

/** UTF-8として正しいときだけ文字列にする。`file.text()`は不正なバイトをU+FFFDへ置き換えるため、それを書き戻すと元のバイトが失われる */
export function decodeVaultText(bytes: ArrayBuffer | Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new VaultFileNotUtf8Error(); }
}

export async function readVaultFileText(file: Pick<File, "text"> & Partial<Pick<File, "arrayBuffer">>): Promise<string> {
  return typeof file.arrayBuffer === "function" ? decodeVaultText(await file.arrayBuffer()) : file.text();
}

// ---------------------------------------------------------------------------
// 同じ日のファイルの読み書きを、タブをまたいで直列にする（読んでから書くまでの間に他の保存が入らない）
// ---------------------------------------------------------------------------

const MEMORY_DAYFILE_LOCK_PREFIX = "tsumugi-projection-memory-dayfile";

export async function withMemoryDayFileLock<T>(day: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || typeof navigator.locks === "undefined") return fn();
  return navigator.locks.request(`${MEMORY_DAYFILE_LOCK_PREFIX}:${day}`, fn);
}

// ---------------------------------------------------------------------------
// 比較
// ---------------------------------------------------------------------------

const sections = (note: string) => note.trim().match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
const keyOf = (line: string) => line.slice(0, line.indexOf(":")).trim();

/** Tsumugiが版を進めるたびに変わる項目。これ以外のfrontmatterの行は、置き換えた後にも残っていなければ「元の内容が残る」とは言えない */
export const MEMORY_EVOLVING_KEYS: ReadonlySet<string> = new Set(["updatedAt"]);
export const CONVERSATION_EVOLVING_KEYS: ReadonlySet<string> = new Set(["updatedAt", "endedAt", "status", "turnTimes", "memoryObjectIds"]);

/**
 * `next`が`current`の内容をすべて含むか（上の原則の(2)）：
 * frontmatterの行は（更新用の項目を除いて）すべて残り、本文は同じ（`body: "same"`）か、元の本文の後ろに続くだけ（`body: "extends"`）。
 */
export function rewriteKeepsContent(current: string, next: string, evolvingKeys: ReadonlySet<string>, body: "same" | "extends"): boolean {
  const a = sections(current), b = sections(next);
  if (!a || !b) return false;
  const lines = b[1].split("\n");
  for (const line of a[1].split("\n")) {
    if (evolvingKeys.has(keyOf(line))) continue;
    const at = lines.indexOf(line);
    if (at === -1) return false;
    lines.splice(at, 1);
  }
  const before = a[2].trim(), after = b[2].trim();
  return body === "same" ? before === after : after === before || after.startsWith(`${before}\n`);
}

/** 1記録分の部分に、読み書きで失われるもの（知らない項目・手書きの文）が無いか。Registryのハッシュは読み取った結果から計算されるため、ハッシュだけではこれが分からない */
function sectionHasNothingForeign(section: string, parsed: MemoryObject): boolean {
  return serializedKeepsEverything(section, memoryObjectToMarkdown(parsed));
}

function serializedKeepsEverything(section: string, serialized: string): boolean {
  const a = sections(section), b = sections(serialized);
  if (!a || !b) return false;
  if (a[2].trim() !== b[2].trim()) return false;
  const lines = b[1].split("\n");
  for (const line of a[1].split("\n")) {
    const at = lines.indexOf(line);
    if (at === -1) return false;
    lines.splice(at, 1);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1記録1ファイル（会話・振り返り）
// ---------------------------------------------------------------------------

/**
 * `reserialized`は今のファイルを読んで書き直した内容。Registryのハッシュが一致しても、読み書きで失われる部分（知らない項目・手書きの文）があれば
 * Tsumugiが書いた版とは言えない（復旧がファイルの実体からハッシュを記録した場合に、手で足された文を上書きしない）。
 */
export function singleFileRewriteIsSafe(current: string, next: string, opts: { hash: (text: string) => string; registeredHash: unknown; evolvingKeys: ReadonlySet<string>; body: "same" | "extends"; reserialized: string }): boolean {
  if (typeof opts.registeredHash === "string" && opts.hash(current) === opts.registeredHash && serializedKeepsEverything(current, opts.reserialized)) return true;
  return rewriteKeepsContent(current, next, opts.evolvingKeys, opts.body);
}

// ---------------------------------------------------------------------------
// 日別ファイル
// ---------------------------------------------------------------------------

export type DayFilePlan =
  | { kind: "no-op"; content: string; members: MemoryObject[] }
  | { kind: "write"; verdict: "create" | "append" | "update"; content: string; members: MemoryObject[] }
  | { kind: "refuse"; reason: "memory-dayfile-unreadable" | "memory-member-conflict" | "memory-member-edited-conflict" | "memory-dayfile-not-mergeable" };

const byCreatedAt = (members: MemoryObject[]) => [...members].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** その記録の部分がRegistryに記録された版か（複数の直列化の形を受け入れるのは呼び出し側。ここは判定だけを受け取る） */
export interface DayFileEvidence {
  isSame(onDisk: MemoryObject, canonical: MemoryObject): boolean;
  isSuccessor(onDisk: MemoryObject, canonical: MemoryObject): boolean;
  isRegisteredVersion(onDisk: MemoryObject): boolean;
}

/**
 * 日別ファイルへ1記録を反映する計画（ファイルが無いときは`raw`をnullに）。何度実行しても同じ記録は増えない：同じ版ならno-op、既にあれば置き換え。
 * 既に手書きのある日でも、他の部分を変えずに追加できるので保存は止まらない。止まるのは、対象の記録そのものが編集されているときと、そのファイルが日別ファイルとして読めないときだけ。
 */
export function planDayFileMemberWrite(raw: string | null, canonical: MemoryObject, evidence: DayFileEvidence): DayFilePlan {
  const entry = memoryObjectToMarkdown(canonical);
  if (raw === null || raw.trim().length === 0) return { kind: "write", verdict: "create", content: entry, members: [canonical] };

  const segments = raw.split(MEMORY_ENTRY_SEPARATOR);
  const parsed = segments.map((segment) => (segment.trim().length > 0 ? parseMemoryObjectMarkdown(segment.trim()) : null));
  const existing = parsed.filter((m): m is MemoryObject => m !== null);
  // 1件も読めない：このファイルは日別ファイルではないかもしれない（ユーザー自身のノート等）
  if (existing.length === 0) return { kind: "refuse", reason: "memory-dayfile-unreadable" };

  const index = parsed.findIndex((m) => m?.id === canonical.id);
  let next: string[];
  let verdict: "append" | "update";
  if (index >= 0) {
    const onDisk = parsed[index] as MemoryObject;
    if (evidence.isSame(onDisk, canonical)) return { kind: "no-op", content: raw, members: byCreatedAt(existing) };
    if (!evidence.isSuccessor(onDisk, canonical)) return { kind: "refuse", reason: "memory-member-conflict" };
    const proven = (evidence.isRegisteredVersion(onDisk) && sectionHasNothingForeign(segments[index], onDisk)) || rewriteKeepsContent(segments[index], entry, MEMORY_EVOLVING_KEYS, "same");
    if (!proven) return { kind: "refuse", reason: "memory-member-edited-conflict" };
    next = segments.map((segment, i) => (i === index ? entry : segment));
    verdict = "update";
  } else {
    // 読めない部分にこの記録のidがある：記録が手で書き換えられている。別に追加すると同じ記録が二重になる
    if (segments.some((segment, i) => parsed[i] === null && segment.includes(canonical.id))) return { kind: "refuse", reason: "memory-member-edited-conflict" };
    const before = parsed.findIndex((m) => m !== null && m.createdAt.localeCompare(canonical.createdAt) > 0);
    next = before === -1 ? [...segments, entry] : [...segments.slice(0, before), entry, ...segments.slice(before)];
    verdict = "append";
  }

  const content = next.join(MEMORY_ENTRY_SEPARATOR);
  // 書く前の最後の確認：書いた後のファイルから、対象の記録と他の全ての記録が元のとおり読めること（本文に区切りの文字列を含む等、読み直すと崩れる内容は書かない）
  const after = parseMemoryDayFile(content);
  const expectedCount = existing.length + (verdict === "append" ? 1 : 0);
  const written = after.filter((m) => m.id === canonical.id);
  if (after.length !== expectedCount || written.length === 0 || memoryObjectToMarkdown(written[0]) !== memoryObjectToMarkdown(parseMemoryObjectMarkdown(entry.trim()) as MemoryObject)) {
    return { kind: "refuse", reason: "memory-dayfile-not-mergeable" };
  }
  return { kind: "write", verdict, content, members: byCreatedAt(after) };
}

/** 修復の事前確認用：この日別ファイルにこの記録を入れられる見込みがあるか（保存の時点で`planDayFileMemberWrite`がもう一度判定する） */
export function dayFileCanTakeMember(raw: string, memberId: string): boolean {
  if (raw.trim().length === 0) return true;
  const segments = raw.split(MEMORY_ENTRY_SEPARATOR);
  const parsed = segments.map((segment) => (segment.trim().length > 0 ? parseMemoryObjectMarkdown(segment.trim()) : null));
  if (!parsed.some((m) => m !== null)) return false;
  return !segments.some((segment, i) => parsed[i] === null && segment.includes(memberId));
}

/**
 * Registryのmember hashesの次の値：対象の記録だけを今の版にする。他の記録は記録済みの値を引き継ぐ（Tsumugiが書いていない記録のハッシュを更新すると、
 * 手で編集された内容を「Tsumugiが書いた版」と取り違え、次の更新で上書きしてしまう）。記録の無い他の記録は、端末の版と一致する（または端末に無く、端末から
 * 更新されることが無い）と`mayRecord`が確かめたときだけ記録する。一致しなければ記録せず、その記録の更新は証明できないまま保留になる。
 */
export async function nextMemberHashes(prior: unknown, members: MemoryObject[], targetId: string, hashOf: (m: MemoryObject) => string, mayRecord: (m: MemoryObject) => Promise<boolean>): Promise<Record<string, string>> {
  const known = prior && typeof prior === "object" ? (prior as Record<string, unknown>) : {};
  const next: Record<string, string> = {};
  for (const m of members) {
    const value = known[m.id];
    if (m.id !== targetId && typeof value === "string") next[m.id] = value;
    else if (m.id === targetId || await mayRecord(m)) next[m.id] = hashOf(m);
  }
  return next;
}
