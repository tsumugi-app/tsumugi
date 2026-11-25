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
import { MEMORY_ENTRY_SEPARATOR, legacyTranscriptUpgradeForm, memoryObjectToMarkdown, parseMemoryDayFile, parseMemoryObjectMarkdown } from "./markdown";
import type { Conversation, MemoryObject } from "./types";

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

// CRLFのファイルもLFと同一に判定する（A-02の分類側と同じ正規化規則）。
// 行末の違いは「内容が変わった」ことではないため、frontmatter/bodyの比較は
// 正規化後の形で行う。呼び出し側が書き戻す内容そのものは正規化しない
// （対象外部分のバイト保存は呼び出し側の契約）。
const normalizeForCompare = (text: string) => text.replace(/\r\n/g, "\n");
const sections = (note: string) => normalizeForCompare(note).trim().match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
const keyOf = (line: string) => line.slice(0, line.indexOf(":")).trim();

/** Tsumugiが版を進めるたびに変わる項目。これ以外のfrontmatterの行は、置き換えた後にも残っていなければ「元の内容が残る」とは言えない */
export const MEMORY_EVOLVING_KEYS: ReadonlySet<string> = new Set(["updatedAt"]);
export const CONVERSATION_EVOLVING_KEYS: ReadonlySet<string> = new Set(["updatedAt", "endedAt", "status", "turnTimes", "interruptedTurns", "memoryObjectIds"]);

/**
 * The file says the conversation is finished, or refers to Memories, beyond what this device holds: another device finished it. A save from the older state here must not take that back
 * (the conversation would look unprocessed and get its Memories again), whatever the rule for evolving keys says. Not when Tsumugi wrote that file version itself here.
 */
export function takesBackFinishedConversation(onDisk: Pick<Conversation, "status" | "memoryObjectIds" | "realtimeDiary" | "endedAt">, canonical: Pick<Conversation, "status" | "memoryObjectIds" | "realtimeDiary" | "endedAt">): boolean {
  return (onDisk.status === "captured" && canonical.status !== "captured") || onDisk.memoryObjectIds.some((id) => !canonical.memoryObjectIds.includes(id))
    // a realtime diary's text written on another device: a save without it would take the diary back
    || (!!onDisk.realtimeDiary?.text && !canonical.realtimeDiary?.text)
    // a realtime diary closed on another device (at the day change, before its Memory and text): a save of it as open would reopen it
    || (!!onDisk.realtimeDiary && !!onDisk.endedAt && !!canonical.realtimeDiary && !canonical.endedAt);
}

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
  if (body === "same") return before === after;
  // 最後の発言が空のファイルは`**Tsumugi:** `で終わる。上のtrimで消えるのはその行末の空白1つだけで、続きがあれば書いた後にはそのまま残る
  return after === before || after.startsWith(`${before}\n`) || after.startsWith(`${before} \n`);
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
 *
 * 旧形式transcriptの無損失アップグレード（PR #68 Codex [P2]）：`transcriptFormat`
 * マーカーの無い旧形式の会話では、利用者の本文そのものである `\**Tsumugi:** ` の
 * ような継続行を、新形式のserializerがescapeして `\` を1つ足す。そのため登録
 * ハッシュが一致し実際の変更がturnの追記だけでも、素のバイト比較では「元の内容が
 * 残っていない」と誤判定され、その会話の保存が止まってしまう。そこで、旧形式
 * ファイルに限っては、形式アップグレードだけを先回りして適用した形
 * （`legacyTranscriptUpgradeForm`）でも同じ厳密な比較を行う。アップグレードは
 * parseの観点で無損失（旧形式として読んだ会話＝新形式として読んだ会話）であり、
 * 変換が触れるのはマーカーそっくりの継続行だけなので、それ以外の本文・知らない
 * 項目・手書きの文はアップグレード後の形にもそのまま残り、従来どおり検出される。
 * ガードの条件そのものは緩めていない（比較対象の片方を、形式の版に合わせて
 * そろえているだけであり、証明の要求水準は変えていない）。
 */
export function singleFileRewriteIsSafe(current: string, next: string, opts: { hash: (text: string) => string; registeredHash: unknown; evolvingKeys: ReadonlySet<string>; body: "same" | "extends"; reserialized: string }): boolean {
  // 登録済み版の判定（原則(1)）は、Registryの規則に合わせてLF正規化形のハッシュで
  // 行う（PR #68 Codex [P2] N-3）。登録ハッシュは分類・保存の各経路で正規化形から
  // 計算されるため、生テキストのハッシュと比べるとCRLFのファイルは内容が同一でも
  // 永遠に一致せず、日記挿入のように本文の接頭辞拡張でも救えない保存が止まる。
  // `opts.hash` の用途はこの登録判定の2箇所だけであり、正規化するのはその入力だけ：
  // 本文・frontmatterの比較（`serializedKeepsEverything`/`rewriteKeepsContent`）は
  // 元々 `sections()` 経由で正規化済みで、生バイトの一致が要る処理には触れない。
  // 行末だけの違いは内容の違いではない（A-02の規則）ため、この変更で外部編集の
  // 検出は弱まらない：実際の編集は正規化後のハッシュも変える。
  const registeredHashOfCurrent = opts.hash(normalizeForCompare(current));
  if (typeof opts.registeredHash === "string" && registeredHashOfCurrent === opts.registeredHash && serializedKeepsEverything(current, opts.reserialized)) return true;
  if (rewriteKeepsContent(current, next, opts.evolvingKeys, opts.body)) return true;
  const upgraded = legacyTranscriptUpgradeForm(current);
  if (upgraded === null) return false;
  if (typeof opts.registeredHash === "string" && registeredHashOfCurrent === opts.registeredHash && serializedKeepsEverything(upgraded, opts.reserialized)) return true;
  return rewriteKeepsContent(upgraded, next, opts.evolvingKeys, opts.body);
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

  // A-02：CRLFのday-fileもLFと同一に扱う。区切り文字列はLF形のため、分割は
  // 正規化後のテキストで行う（parseMemoryDayFileと同じ規則）。no-op判定の
  // 場合は元のrawをそのまま返すのでCRLFファイルのバイトは変わらない。
  // write時は正規化後の形で書き戻る（内容は同一で、行末だけがLFへ揃う）。
  const segments = normalizeForCompare(raw).split(MEMORY_ENTRY_SEPARATOR);
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
  const segments = normalizeForCompare(raw).split(MEMORY_ENTRY_SEPARATOR);
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
