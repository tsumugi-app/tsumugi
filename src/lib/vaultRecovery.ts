/** Phase 1: observation only. No apply, DB initialization, persistent journal or repair.
 * Caller must hold the existing exclusive vault-world lock and validate the tab epoch.
 * All Markdown owned by Tsumugi (moved/archive folders included, hidden directories
 * excluded — see HIDDEN_PREFIX) is scanned. Markdown that is not Tsumugi-owned
 * (no `tsumugi: true` frontmatter) is skipped, not treated as an issue.
 * Unknown/malformed Tsumugi-owned Markdown conservatively prevents a proof of absence.
 */
import type { Conversation, MemoryObject, Source } from "./types";
import { parseConversationMarkdown, parseFrontmatter, parseMemoryObjectMarkdown, parseSourceMarkdown } from "./markdown";
import { conversationsSemanticEqual, memoryObjectsSemanticEqual, sourcesSemanticEqual,
  isReflectionSummary, dayFileRegistryKey, vaultRegistryBucketOf, fileNameFor, dayFileNameFor } from "./vault";

/** 他の全走査系関数（vault.ts/vaultLegacyCleanup.ts等）と共通の規約：`.`で始まる
 *  ディレクトリ・ファイルは隠し領域（`.tsumugi`本体・`.tsumugi-archive`等）として
 *  recursive walkの対象外にする。 */
const HIDDEN_PREFIX = ".";

export type RecoveryClassification = "local-only-safe" | "equivalent-existing" | "conflict" |
  "memory-dayfile-merge-required" | "vault-only" | "unreadable / indeterminate";
export type StrictStatus = "found" | "not-found" | "read-error" | "parse-error" | "invalid";
export interface RecoveryRead { path: string; status: StrictStatus; error?: string }
export type StrictResult<T> = RecoveryRead & { value?: T };
type Obj = Record<string, unknown>;
type RecordType = "conversation" | "memory" | "reflection" | "source";
type Data = Conversation | MemoryObject | Source;
export interface RecoveryLocalSnapshot {
  conversations: Conversation[]; memories: MemoryObject[]; sources: Source[];
  sync: Record<string, string>;
}
export interface RecoveryRecord {
  recordType: RecordType; recordId: string; date: string; updatedAt: string;
  indexedDBExists: boolean; vaultMarkdownExists: boolean | null; vaultPaths: string[];
  semanticEqual: boolean | null; registryKey: string;
  registry: { entryExists: boolean | null; path: string | null; status: string | null; read: RecoveryRead };
  registryIndexExists: boolean | null; historyIndexExists: boolean | null; historyPaths: string[];
  legacyIndexExists: boolean | null; legacyIndexPath: string | null;
  syncState: { savedUpdatedAt: string | null; matchesLocal: boolean | null };
  baselineState: RecoveryPlan["baseline"];
  memoryDay: { day: string; paths: string[]; memberExists: boolean | null; memberSemanticEqual: boolean | null; otherMemberCount: number } | null;
  classification: RecoveryClassification;
  recoveryPossibility: "future-append-candidate" | "future-metadata-repair-candidate" | "future-import-candidate" | "blocked";
  automaticRepairAllowed: false; reasons: string[]; strictReadErrors: RecoveryRead[];
}
export interface RecoveryPlan {
  version: 1; readOnly: true; startedAt: string; completedAt: string;
  scope: string; scanCompleted: boolean; scannedMarkdownCount: number;
  baseline: { status: "established" | "unset" | "not-found" | "unconfirmed"; value: string | null; read: RecoveryRead };
  metadataReads: RecoveryRead[]; issues: RecoveryRead[];
  counts: Record<RecoveryClassification, number>; records: RecoveryRecord[];
}
const object = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === "string");
const dateOK = (x: unknown): x is string => typeof x === "string" && Number.isFinite(Date.parse(x));
const pathOK = (x: unknown): x is string => typeof x === "string" && x.length > 0 && !x.includes("\\") && x.split("/").every(p => p !== "" && p !== "." && p !== "..");
// DOMException need not inherit Error in every WebKit/runtime realm.
// Report only standard names, never provider messages/body/secrets.
const errorName = (e: unknown): string => {
  const name = object(e) && typeof e.name === "string" ? e.name : "";
  return ["NotFoundError", "NotAllowedError", "SecurityError", "NotReadableError", "AbortError", "InvalidStateError", "TypeMismatchError", "QuotaExceededError", "TypeError", "Error"].includes(name) ? name : "UnknownError";
};
const notFound = (e: unknown) => errorName(e) === "NotFoundError";
const descriptor = ({ path, status, error }: RecoveryRead): RecoveryRead => ({ path, status, ...(error ? { error } : {}) });
const failed = (r: RecoveryRead) => r.status !== "found" && r.status !== "not-found";

/** Only handle resolution NotFound is absence. getFile/text failures are always read-error. */
export async function readRecoveryJson(root: FileSystemDirectoryHandle, path: string, validate: (v: unknown) => boolean): Promise<StrictResult<Obj>> {
  let file: FileSystemFileHandle;
  try {
    if (!pathOK(path)) return { path, status: "invalid", error: "invalid-path" };
    const segments = path.split("/");
    let dir = root;
    for (const name of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: false });
    file = await dir.getFileHandle(segments[segments.length - 1], { create: false });
  } catch (e) { return { path, status: notFound(e) ? "not-found" : "read-error", error: errorName(e) }; }
  let text: string;
  try { text = await (await file.getFile()).text(); }
  catch (e) { return { path, status: "read-error", error: errorName(e) }; }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { path, status: "parse-error", error: "invalid-json" }; }
  if (!object(value) || !validate(value)) return { path, status: "invalid", error: "invalid-shape" };
  return { path, status: "found", value };
}

function validMeta(v: unknown): boolean {
  return object(v) && v.schemaVersion === 1 && typeof v.updatedAt === "string" &&
    (v.lastFullResyncAt === null || dateOK(v.lastFullResyncAt)) &&
    (v.baselineEstablishedAt == null || dateOK(v.baselineEstablishedAt)) &&
    (v.registryGeneration === undefined || typeof v.registryGeneration === "string") &&
    (v.dirtyOwnerInstanceId == null || typeof v.dirtyOwnerInstanceId === "string");
}
function validEntry(v: unknown): boolean {
  return object(v) && ["conversation", "reflection", "source", "memory-day"].includes(String(v.recordType)) &&
    ["ok", "needs-resync", "missing", "conflict"].includes(String(v.status)) &&
    Number.isFinite(v.mtime) && Number.isFinite(v.size) && typeof v.contentHash === "string" && strings(v.memberIds) &&
    (v.memberHashes === undefined || (object(v.memberHashes) && Object.values(v.memberHashes).every(x => typeof x === "string")));
}
function validShard(v: unknown, bucket: number): boolean {
  return object(v) && v.schemaVersion === 1 && v.bucket === bucket && object(v.records) && object(v.files) &&
    Object.entries(v.records).every(([k, p]) => vaultRegistryBucketOf(k) === bucket && pathOK(p)) &&
    Object.entries(v.files).every(([p, entry]) => pathOK(p) && validEntry(entry));
}
function validRegistryIndex(v: unknown): boolean {
  return object(v) && v.schemaVersion === 1 && typeof v.builtAtGeneration === "string" && object(v.records) &&
    Object.values(v.records).every(e => object(e) && pathOK(e.path) && Number.isFinite(e.mtime) && Number.isFinite(e.size) &&
      ["conversation", "reflection", "source", "memory-day"].includes(String(e.recordType)));
}
function validHistory(v: unknown): boolean {
  if (!object(v) || ![1, 2].includes(Number(v.version)) || typeof v.month !== "string" || !object(v.days)) return false;
  return Object.entries(v.days).every(([day, e]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.slice(0, 7) !== v.month || !object(e)) return false;
    if (Array.isArray(e.conversations)) return e.conversations.every(c => object(c) && typeof c.id === "string" &&
      ["diary", "conversation"].includes(String(c.mode)) && Number.isInteger(c.turnCount)) &&
      [e.normalMemories, e.reflections].every(a => Array.isArray(a) && a.every(m => object(m) && typeof m.id === "string" &&
        strings(m.types) && typeof m.preview === "string" && dateOK(m.createdAt) && (m.date === undefined || dateOK(m.date))));
    return strings(e.conversationIds) && strings(e.reflectionIds) && Number.isInteger(e.normalMemoryCount) && Number.isInteger(e.memoryCount);
  });
}

/** No open at all when absent/unsupported. A concurrent deletion between listing
 * and open is handled by aborting the upgrade transaction (never commits a DB).
 * Native IDB has no atomic open-existing-only API. Never use db.ts/getDB here. */
export async function openExistingRecoveryDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  if (typeof factory.databases !== "function") throw new Error("database-list-unavailable");
  const existing = (await factory.databases()).find(db => db.name === "tsumugi");
  if (!existing || !Number.isSafeInteger(existing.version) || !existing.version || existing.version < 1) throw new Error("existing-database-unavailable");
  return new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false;
    const request = factory.open("tsumugi"); // no version argument, so no version upgrade requested
    const fail = () => { failed = true; reject(new Error("existing-database-unavailable")); };
    request.onupgradeneeded = () => { request.transaction?.abort(); fail(); };
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      if (failed || request.result.version !== existing.version) { request.result.close(); fail(); }
      else resolve(request.result);
    };
  });
}

/** Exactly one readonly transaction. No settings values, handles, API keys or DB initialization. */
export async function readRecoveryLocalSnapshot(factory: IDBFactory = indexedDB): Promise<RecoveryLocalSnapshot> {
  const db = await openExistingRecoveryDatabase(factory);
  try {
    const names = ["conversations", "memoryObjects", "sources", "vaultSyncState"];
    if (names.some(name => !db.objectStoreNames.contains(name))) throw new Error("required-store-unavailable");
    const tx = db.transaction(names, "readonly");
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error("readonly-transaction-failed")); });
    const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("readonly-request-failed"));
    });
    const requests = [read(tx.objectStore(names[0]).getAll()), read(tx.objectStore(names[1]).getAll()),
      read(tx.objectStore(names[2]).getAll()), read(tx.objectStore(names[3]).getAllKeys()), read(tx.objectStore(names[3]).getAll())];
    // Install rejection handlers on both requests and transaction immediately.
    const [rows] = await Promise.all([Promise.all(requests), done]);
    const [conversations, memories, sources, keys, values] = rows;
    const sync: Record<string, string> = Object.create(null);
    keys.forEach((key, i) => { if (typeof key !== "string" || typeof values[i] !== "string") throw new Error("invalid-sync-ledger"); sync[key] = values[i]; });
    return { conversations, memories, sources, sync } as RecoveryLocalSnapshot;
  } finally { db.close(); }
}

/** Recovery-only adapter: normal parser stays untouched. Always resolve the persisted
 * `evidence` field ourselves, even when the working-tree parser also knows it.
 * Never silently discard malformed Evidence when deciding semantic equivalence. */
export function parseRecoveryMemoryMarkdown(raw: string): MemoryObject | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const memory = parseMemoryObjectMarkdown(raw);
  if (!memory) return null;
  const rawEvidence = parsed.frontmatter.evidence;
  let evidence: string[] = [];
  if (rawEvidence !== undefined) {
    if (typeof rawEvidence !== "string") throw new Error("invalid-evidence");
    const decoded: unknown = JSON.parse(rawEvidence);
    if (!strings(decoded) || decoded.some(q => !q.trim())) throw new Error("invalid-evidence");
    evidence = decoded;
  }
  // Structural field access keeps compatibility with committed MemoryObject without this optional property.
  const result = { ...memory } as MemoryObject & { evidenceQuotes?: string[] };
  delete result.evidenceQuotes;
  if (evidence.length) result.evidenceQuotes = evidence;
  return result;
}

interface Observed { type: RecordType; data: Data; path: string; day: string }
const recordDate = (type: RecordType, data: Data) => type === "conversation" ? (data as Conversation).startedAt : type === "source" ? data.createdAt : (data as MemoryObject).date;
export function recoveryRecordsSemanticEqual(type: RecordType, a: Data, b: Data): boolean {
  if (type === "conversation") return conversationsSemanticEqual(a as Conversation, b as Conversation);
  if (type === "source") return sourcesSemanticEqual(a as Source, b as Source);
  // Existing semantic equality deliberately omits some round-trip fields. Observe these too;
  // do not label different stored evidence/profile/person/topic data as equivalent.
  const x = a as MemoryObject, y = b as MemoryObject;
  if (!memoryObjectsSemanticEqual(x, y)) return false;
  return ["topicId", "profileClaims", "personMentions", "topicEvents", "evidenceQuotes"].every(k =>
    JSON.stringify((x as unknown as Obj)[k] ?? (k === "topicId" ? null : [])) ===
    JSON.stringify((y as unknown as Obj)[k] ?? (k === "topicId" ? null : [])));
}

/** All local records are included (not just a potentially stale Settings list), plus Vault-only records.
 * A candidate is a diagnostic possibility, NEVER write authorization. No execution API exists. */
export async function buildVaultRecoveryPlan(root: FileSystemDirectoryHandle, local: RecoveryLocalSnapshot, signal?: AbortSignal): Promise<RecoveryPlan> {
  const startedAt = new Date().toISOString();
  const metadataReads: RecoveryRead[] = [], issues: RecoveryRead[] = [];
  const inspect = async (path: string, validate: (v: unknown) => boolean) => {
    signal?.throwIfAborted();
    const r = await readRecoveryJson(root, path, validate);
    metadataReads.push(descriptor(r)); if (failed(r)) issues.push(descriptor(r)); return r;
  };
  const meta = await inspect(".tsumugi/registry-meta.json", validMeta);
  const baseline: RecoveryPlan["baseline"] = {
    status: meta.status === "not-found" ? "not-found" : meta.status !== "found" ? "unconfirmed" : meta.value?.baselineEstablishedAt == null ? "unset" : "established",
    value: typeof meta.value?.baselineEstablishedAt === "string" ? meta.value.baselineEstablishedAt : null, read: descriptor(meta),
  };
  const registryIndex = await inspect(".tsumugi/registry-index.json", validRegistryIndex);
  const legacy = await inspect(".tsumugi/index.json", v => object(v) && Object.values(v).every(pathOK));
  await inspect(".tsumugi/history-meta.json", v => object(v) && v.version === 1 && typeof v.updatedAt === "string" && object(v.months) &&
    Number.isInteger(v.totalMemories) && Number.isInteger(v.totalConversations) && Object.values(v.months).every(m => object(m) && Number.isInteger(m.memories) && Number.isInteger(m.conversations)));
  const shards = new Map<number, StrictResult<Obj>>();
  for (let bucket = 0; bucket < 64; bucket++) {
    shards.set(bucket, await inspect(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, v => validShard(v, bucket)));
  }
  const histories: { path: string; value: Obj }[] = [];
  // Enumerate metadata too: unexpected shard names must not be silently treated as absence.
  for (const folder of ["registry", "history"]) {
    const path = `.tsumugi/${folder}`;
    let dir: FileSystemDirectoryHandle;
    try { dir = await (await root.getDirectoryHandle(".tsumugi", { create: false })).getDirectoryHandle(folder, { create: false }); }
    catch (e) { if (!notFound(e)) issues.push({ path, status: "read-error", error: errorName(e) }); continue; }
    try {
      for await (const [name, handle] of dir.entries()) {
        signal?.throwIfAborted();
        const child = `${path}/${name}`;
        if (folder === "registry") {
          if (handle.kind !== "file" || !/^[0-3][0-9a-f]\.json$/.test(name)) issues.push({ path: child, status: "invalid", error: "unexpected-registry-entry" });
        } else if (handle.kind !== "file" || !/^\d{4}-\d{2}\.json$/.test(name)) {
          issues.push({ path: child, status: "invalid", error: "unexpected-history-entry" });
        } else {
          const r = await inspect(child, v => validHistory(v) && (v as Obj).month === name.slice(0, 7));
          if (r.status === "found") histories.push({ path: child, value: r.value! });
          else if (r.status === "not-found") issues.push({ path: child, status: "read-error", error: "disappeared-during-scan" });
        }
      }
    } catch (e) { signal?.throwIfAborted(); issues.push({ path, status: "read-error", error: errorName(e) }); }
  }
  const observed: Observed[] = []; const allPaths = new Set<string>();
  let scanCompleted = true, scannedMarkdownCount = 0;
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > 64) { scanCompleted = false; issues.push({ path: prefix, status: "invalid", error: "depth-limit" }); return; }
    try {
      for await (const [name, handle] of dir.entries()) {
        signal?.throwIfAborted();
        // 隠しディレクトリ・ファイル（`.tsumugi-archive`等）は、他の全走査系関数
        // （vault.ts/vaultLegacyCleanup.ts等）と同じ既存規約（HIDDEN_PREFIX = "."）に
        // 従い、recursive Markdown discoveryの対象外にする。`.tsumugi`自体もこの
        // walkには含めない——known metadata（registry-meta.json・shard・history等）は
        // 既にこの関数の冒頭で`inspect()`により個別pathを明示的に読んでおり、この
        // walkとは独立しているため、除外しても既存のRecovery metadata読み取りには
        // 一切影響しない。
        if (name.startsWith(HIDDEN_PREFIX)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (allPaths.has(path)) { issues.push({ path, status: "invalid", error: "duplicate-path" }); continue; }
        allPaths.add(path);
        if (handle.kind === "directory") { await walk(handle as FileSystemDirectoryHandle, path, depth + 1); continue; }
        if (!name.toLowerCase().endsWith(".md")) continue;
        scannedMarkdownCount++;
        let raw: string;
        try { raw = await (await (handle as FileSystemFileHandle).getFile()).text(); }
        catch (e) { issues.push({ path, status: "read-error", error: errorName(e) }); continue; }
        try {
          // Check each member, rather than parseMemoryDayFile's fail-soft filter.
          const blocks = raw.split("\n<!-- tsumugi:entry -->\n\n").map(s => s.trim()).filter(Boolean);
          if (blocks.length === 0) throw new Error("empty-markdown");
          const fileRecords: Observed[] = [];
          for (const block of blocks) {
            const parsed = parseFrontmatter(block);
            // Tsumugi所有物かどうかの判定（frontmatterが無い、またはtsumugi!==true）は
            // 「不正」ではなく「対象外」——Obsidian等、Tsumugiが生成していない任意の
            // Markdownがこの位置に存在してもissue化せず、単にこのblockを無視する
            // （所有権が確認できないrecordとして無視するだけで、他recordには一切
            // 影響しない）。tsumugi:trueを宣言した後のid不正等は、従来通りTsumugi
            // 所有recordの破損としてissue化する（下のthrowはそのまま維持）。
            if (!parsed || parsed.frontmatter.tsumugi !== true) continue;
            if (typeof parsed.frontmatter.id !== "string") throw new Error("unrecognized-markdown");
            const { frontmatter: fm, body } = parsed;
            for (const field of ["links", "profile", "person", "topicEvents"]) {
              if (fm[field] !== undefined && (typeof fm[field] !== "string" || !Array.isArray(JSON.parse(fm[field] as string)))) throw new Error("invalid-encoded-field");
            }
            let type: RecordType, data: Data | null;
            if (body.includes("## Transcript\n\n")) { type = "conversation"; data = parseConversationMarkdown(block); }
            else if (body.includes("## Summary\n")) { data = parseRecoveryMemoryMarkdown(block); type = data && isReflectionSummary(data) ? "reflection" : "memory"; }
            else if (body.includes("## Content\n") && typeof fm.sourceType === "string") { type = "source"; data = parseSourceMarkdown(block); }
            else throw new Error("unsupported-record");
            if (!data || !data.id || !dateOK(data.createdAt) || !dateOK(data.updatedAt) || !dateOK(recordDate(type, data))) throw new Error("invalid-record");
            fileRecords.push({ type, data, path, day: recordDate(type, data).slice(0, 10) });
          }
          if (fileRecords.length > 1 && (fileRecords.some(r => r.type !== "memory") || new Set(fileRecords.map(r => r.day)).size !== 1)) throw new Error("mixed-day-file");
          observed.push(...fileRecords);
        } catch { issues.push({ path, status: "invalid", error: "markdown-parse-or-shape-failure" }); }
      }
    } catch (e) { signal?.throwIfAborted(); scanCompleted = false; issues.push({ path: prefix || "/", status: "read-error", error: errorName(e) }); }
  };
  await walk(root, "", 0);
  signal?.throwIfAborted();
  const locals: { type: RecordType; data: Data }[] = [
    ...local.conversations.map(data => ({ type: "conversation" as const, data })),
    ...local.memories.map(data => ({ type: isReflectionSummary(data) ? "reflection" as const : "memory" as const, data })),
    ...local.sources.map(data => ({ type: "source" as const, data })),
  ];
  const rows = [...locals, ...observed.filter(o => !locals.some(l => l.data.id === o.data.id)).filter((o, i, a) => a.findIndex(x => x.data.id === o.data.id) === i).map(o => ({ type: o.type, data: o.data }))];
  const records: RecoveryRecord[] = rows.map(({ type, data }) => {
    const id = data.id, date = recordDate(type, data), day = date.slice(0, 10);
    const localMatches = locals.filter(l => l.data.id === id), matches = observed.filter(o => o.data.id === id);
    const inLocal = localMatches.length > 0;
    const registryKey = type === "memory" ? dayFileRegistryKey(day) : id;
    const shard = shards.get(vaultRegistryBucketOf(registryKey))!;
    const registryPath = shard.value ? (shard.value.records as Record<string, string>)[registryKey] ?? null : null;
    const entry = registryPath && shard.value ? (shard.value.files as Record<string, Obj>)[registryPath] : undefined;
    const indexTrace = registryIndex.value ? Object.hasOwn(registryIndex.value.records as Obj, registryKey) : false;
    const legacyPath = legacy.value ? legacy.value[id] as string | undefined : undefined;
    const dayRecords = observed.filter(o => o.type === "memory" && o.day === day);
    const dayPaths = [...new Set(dayRecords.map(o => o.path))];
    const historyPaths: string[] = []; let v1DayTrace = false;
    for (const h of histories) for (const [d, value] of Object.entries(h.value.days as Obj)) {
      const e = value as Obj;
      const ids = [e.conversations, e.normalMemories, e.reflections].flatMap(a => Array.isArray(a) ? a.map(x => (x as Obj).id) : []);
      ids.push(...(Array.isArray(e.conversationIds) ? e.conversationIds : []), ...(Array.isArray(e.reflectionIds) ? e.reflectionIds : []));
      if (ids.includes(id)) historyPaths.push(h.path);
      if (type === "memory" && d === day && Number(e.normalMemoryCount) > 0) v1DayTrace = true;
    }
    const registryMemberTraces = [...shards.values()].flatMap(s => s.value ? Object.entries(s.value.files as Record<string, Obj>).filter(([, e]) => (e.memberIds as string[]).includes(id)).map(([p]) => p) : []);
    const expectedPath = type === "conversation" ? `Conversations/${fileNameFor(id, date)}` : type === "source" ? `Sources/${fileNameFor(id, date)}` : `Memories/${type === "memory" ? dayFileNameFor(date) : fileNameFor(id, date)}`;
    const reasons: string[] = [];
    let semanticEqual: boolean | null = null;
    if (inLocal && matches.length === 1 && matches[0].type === type) {
      try { semanticEqual = recoveryRecordsSemanticEqual(type, data, matches[0].data); } catch { reasons.push("invalid-local-record"); }
    }
    if (!scanCompleted) reasons.push("vault-scan-incomplete");
    if (issues.length) reasons.push("strict-read-or-parse-failure");
    if (matches.length > 1 || localMatches.length > 1 || matches.some(m => m.type !== type)) reasons.push("duplicate-or-cross-type-id");
    if (type === "memory" && dayPaths.length > 1) reasons.push("multiple-memory-files-for-day");
    if (registryPath && !entry) reasons.push("orphan-registry-key");
    if (entry && (!entry.memberIds || !(entry.memberIds as string[]).includes(id)) && type !== "memory") reasons.push("registry-identity-mismatch");
    let classification: RecoveryClassification;
    if (reasons.length) classification = "unreadable / indeterminate";
    else if (!inLocal) classification = "vault-only";
    else if (matches.length === 1) classification = semanticEqual ? "equivalent-existing" : "conflict";
    else if (type === "memory" && dayPaths.length === 1) classification = "memory-dayfile-merge-required";
    else if (registryPath || registryMemberTraces.length || indexTrace || legacyPath || historyPaths.length || v1DayTrace || allPaths.has(expectedPath)) {
      classification = "unreadable / indeterminate"; reasons.push("metadata-trace-without-confirmed-markdown");
    } else classification = "local-only-safe";
    if (classification === "conflict") reasons.push("same-id-different-content");
    if (classification === "memory-dayfile-merge-required") reasons.push("existing-day-file-must-not-be-overwritten");
    const syncKey = `${type === "reflection" ? "memory" : type}:${id}`;
    const savedUpdatedAt = local.sync[syncKey] ?? null;
    const metadataUnknown = issues.some(i => i.path.startsWith(".tsumugi/"));
    return {
      recordType: type, recordId: id, date, updatedAt: data.updatedAt, indexedDBExists: inLocal,
      vaultMarkdownExists: matches.length ? true : !scanCompleted || issues.some(i => !i.path.startsWith(".tsumugi/")) ? null : false,
      vaultPaths: [...new Set(matches.map(m => m.path))], semanticEqual, registryKey,
      registry: { entryExists: failed(shard) ? null : !!entry, path: registryPath, status: entry ? String(entry.status) : null, read: descriptor(shard) },
      registryIndexExists: failed(registryIndex) ? null : indexTrace,
      historyIndexExists: historyPaths.length ? true : metadataUnknown || v1DayTrace ? null : false, historyPaths,
      legacyIndexExists: failed(legacy) ? null : !!legacyPath, legacyIndexPath: legacyPath ?? null,
      syncState: { savedUpdatedAt, matchesLocal: inLocal ? savedUpdatedAt === data.updatedAt : null }, baselineState: baseline,
      memoryDay: type === "memory" ? { day, paths: dayPaths, memberExists: matches.length ? true : scanCompleted && !issues.length ? false : null, memberSemanticEqual: semanticEqual, otherMemberCount: new Set(dayRecords.filter(m => m.data.id !== id).map(m => m.data.id)).size } : null,
      classification, recoveryPossibility: classification === "local-only-safe" ? "future-append-candidate" : classification === "equivalent-existing" ? "future-metadata-repair-candidate" : classification === "vault-only" ? "future-import-candidate" : "blocked",
      automaticRepairAllowed: false, reasons, strictReadErrors: [...issues],
    };
  });
  const counts: RecoveryPlan["counts"] = { "local-only-safe": 0, "equivalent-existing": 0, conflict: 0, "memory-dayfile-merge-required": 0, "vault-only": 0, "unreadable / indeterminate": 0 };
  records.forEach(r => counts[r.classification]++);
  return { version: 1, readOnly: true, startedAt, completedAt: new Date().toISOString(),
    scope: "All local Conversation/Memory/Source records and Vault-only identities; all Markdown including hidden/archive folders. Diagnostic candidates only, not permission to repair.",
    scanCompleted, scannedMarkdownCount, baseline, metadataReads, issues, counts, records };
}
