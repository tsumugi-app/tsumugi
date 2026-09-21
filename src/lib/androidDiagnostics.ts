/**
 * Android実機の診断（一時的な、診断専用の機能）。完全にREAD ONLY。
 *
 * 目的：「OPFSへ切り替えた後も古いMemoryが会話に出た」原因が、「OPFSに存在しない旧backend由来の
 * MemoryがIndexedDBに残っていて、RetrievalがそのIDBのMemoryを読んでいる」ことかを、実データで確認する。
 *
 * 【READ ONLYの保証】このモジュールは次だけを行う：
 * - IndexedDB：`indexedDB.open("tsumugi")`（バージョン指定なし）と、`readonly`のtransactionの
 *   `getAll` / `getAllKeys` / `get`。DBが存在しない場合に新規作成しないよう、`databases()`で存在を確認し、
 *   `onupgradeneeded`が呼ばれたら即座にabortして中止する。
 * - OPFS：`getDirectory()`、`getDirectoryHandle(name)`／`getFileHandle(name)`（`create`オプションなし）、
 *   `entries()`、`getFile()`、`text()`。
 * 書き込み系（put／add／delete／clear／deleteDatabase／readwrite／createWritable／removeEntry／
 * requestPermission／create指定）、ネットワーク送信（fetch等）、localStorage・sessionStorage・Cacheの
 * 利用は一切しない。`db.ts`・`vault.ts`など、アプリ本体のデータ層は一切importしない（それらは
 * DBを開いてアップグレードしたり、Vaultの初期化を行うため）。APIキーの値は読まない（読むsettingsの
 * キーを固定の許可リストに限る）。
 *
 * 外部（環境）を引数で差し替えられる（テスト用）。
 *
 * 【診断v2】baseline以降に作られたIDB-onlyのMemory / Conversationについて、コード上の保存ゲート
 * （`vault.ts`の書き込みゲートと同じ規則）を、実データに当てはめて「予測されるHOLDの理由」を付ける：
 *   H1 Memoryの日単位baselineゲート（その日にbaseline以前のIDB Memoryがあり、Registryにその日のentryが無い）
 *   H2 baseline以前に開始されたConversation（`createdAt`がbaseline以前で、Registryにentryが無い）
 *   H3 旧Conversationのstartup Capture候補（全ターンがbaseline以前で、baselineの後にupdatedAt／Memoryが作られた）
 *   Registry Registryのstatusが`ok`以外（needs-resync／conflict／missing）、またはentryはあるがファイルが無い
 * 複数該当する場合は全て表示し、無理に1つへ決めない。どれにも該当しないものは「該当なし」（＝H4：書き込みの失敗・
 * 未再試行などを排除できない）として、推測で分類しない。
 */

export const DIAGNOSTIC_KEYWORDS = ["関係ない", "嫉妬", "SNS", "距離", "ルール", "職場"] as const;
export const MAX_IDB_ONLY_DETAIL = 30;
export const MAX_KEYWORD_MATCHES = 20;
const SNIPPET = 40;

/** 読んでよいsettingsのキー（許可リスト。APIキー等は含まない）。 */
const SAFE_SETTINGS_KEYS = [
  "androidOpfsVaultInitialized",
  "activeVaultEpoch",
  "committedVaultEpoch",
  "registryGenerationEpoch",
  "vaultWorldJournalVersion",
  "chatProvider",
] as const;

// ---------------------------------------------------------------------------
// 環境（テストで差し替える）
// ---------------------------------------------------------------------------

export interface DiagnosticsEnv {
  indexedDB: {
    open: (name: string) => IDBOpenDBRequest;
    databases?: () => Promise<{ name?: string; version?: number }[]>;
  };
  getOpfsRoot: (() => Promise<FileSystemDirectoryHandle>) | null;
  isStandalone: boolean;
  userAgent: string;
  origin: string;
}

export function defaultDiagnosticsEnv(): DiagnosticsEnv {
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  let standalone = false;
  try {
    standalone = typeof window !== "undefined" && !!window.matchMedia?.("(display-mode: standalone)").matches;
  } catch {
    standalone = false;
  }
  return {
    indexedDB: indexedDB as unknown as DiagnosticsEnv["indexedDB"],
    getOpfsRoot: storage && typeof storage.getDirectory === "function" ? () => storage.getDirectory() : null,
    isStandalone: standalone,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    origin: typeof location !== "undefined" ? location.origin : "",
  };
}

// ---------------------------------------------------------------------------
// 結果の型
// ---------------------------------------------------------------------------

export interface IdbOnlyMemory {
  id: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  content: string;
  /** vaultSyncStateに`memory:<id>`があるか（値が`updatedAt`と一致するなら「同期済み」）。 */
  ledger: "none" | "synced" | "other";
  hasConnectState: boolean;
  /** OPFSのbaselineより前に作られたか（baselineが無ければnull）。 */
  beforeBaseline: boolean | null;
  /** 元のConversationがOPFSにあるか（`conversationId`が無ければnull）。 */
  conversationInOpfs: boolean | null;
}

export interface KeywordMatch {
  kind: "memory" | "conversation";
  id: string;
  createdAt: string;
  terms: string[];
  snippet: string;
  idbOnly: boolean;
  inOpfs: boolean;
}

export type DiagnosticsLevel = "A" | "B" | "C" | "undetermined";

export interface DiagnosticsReport {
  status: "ok" | "no-database" | "error";
  errors: string[];
  env: { standalone: boolean; android: boolean; opfsSupported: boolean; origin: string };
  idb: { counts: { conversations: number; memoryObjects: number; sources: number; connectState: number; vaultSyncState: number } } | null;
  settings: Record<string, string | number | null> & { lastPromptedMemoryIdsCount: number | null };
  opfs: {
    readable: boolean;
    rootEntries: string[];
    baselineEstablishedAt: string | null;
    registryMeta: string;
    historyMeta: { totalMemories: number; totalConversations: number } | null;
    registryShards: number;
    registryUnreadableShards: number;
    registryStatuses: Record<string, number>;
    memoryIds: number;
    conversationIds: number;
    sourceIds: number;
    markdownFiles: { memories: number; conversations: number; sources: number };
  } | null;
  diff: {
    idbMemories: number;
    opfsMemories: number;
    idbOnlyMemories: number;
    opfsOnlyMemories: number;
    idbOnlyConversations: number;
    opfsOnlyConversations: number;
    idbOnlySources: number;
  } | null;
  idbOnly: IdbOnlyMemory[];
  matches: KeywordMatch[];
  matchTotals: { total: number; idbOnly: number };
  verdict: { level: DiagnosticsLevel; lines: string[]; details: string[] };
  /** 診断v2：baseline以降のIDB-only記録の、予測されるHOLDの理由。 */
  v2: DiagnosticsV2 | null;
}

export type V2MemoryCause = "H1" | "Registry";
export type V2ConversationCause = "H2" | "H3" | "Registry";

export interface V2RegistryInfo {
  key: string;
  present: boolean;
  status: string | null;
  path: string | null;
  /** entryのpathのファイルがOPFSに存在するか（entryが無ければnull）。 */
  fileExists: boolean | null;
}

export interface V2ConversationInfo {
  inIdb: boolean;
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  status: string | null;
  turns: number | null;
  lastTurnAt: string | null;
  memoryObjectIds: number | null;
  inOpfs: boolean;
  beforeBaseline: boolean | null;
}

export interface V2MemoryRow {
  id: string;
  createdAt: string;
  date: string;
  dateDay: string;
  /** Memory自身のcreatedAtがbaseline以前か（v2の対象は「以後」なので通常false）。 */
  beforeBaseline: boolean;
  kind: "通常" | "振り返り";
  types: string[];
  conversationId: string | null;
  conversation: V2ConversationInfo | null;
  ledger: "none" | "synced" | "other";
  registry: V2RegistryInfo;
  dayFileInOpfs: boolean;
  /** 同じdateの日に存在する、baseline以前のIDB Memory（通常）の件数。 */
  legacyDayMates: number;
  /** 直接の原因（この記録の書き込みゲート）。 */
  causes: V2MemoryCause[];
  /** 文脈（元Conversationがbaseline以前に開始／startup Capture候補）。この記録自体のHOLDの直接原因ではない。 */
  context: ("H2" | "H3")[];
  captureGapMinutes: number | null;
}

export interface V2ConversationRow {
  id: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  beforeBaseline: boolean;
  status: string;
  turns: number;
  lastTurnAt: string | null;
  memoryObjectIds: string[];
  ledger: "none" | "synced" | "other";
  registry: V2RegistryInfo;
  inOpfs: boolean;
  causes: V2ConversationCause[];
}

export interface V2Counts {
  total: number;
  H1: number;
  H2: number;
  H3: number;
  registry: number;
  /** 直接の原因が無い（Memoryは H1・Registry が無い／Conversationは H2・H3・Registry が無い）。 */
  unresolved: number;
  /** どの仮説にも該当しない（文脈のH2/H3も含めて無い）。 */
  noneAtAll: number;
  /** 2つ以上に該当する記録の数。 */
  multiple: number;
}

export interface DiagnosticsV2 {
  available: boolean;
  unavailableReason: string | null;
  baseline: string | null;
  memory: { rows: V2MemoryRow[]; omitted: number; counts: V2Counts; pre: number };
  conversation: { rows: V2ConversationRow[]; omitted: number; counts: V2Counts; pre: number };
}

// ---------------------------------------------------------------------------
// 内部ヘルパー（全て読み取りのみ）
// ---------------------------------------------------------------------------

function short(text: unknown, n = SNIPPET): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ");
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function around(text: string, term: string, n = SNIPPET): string {
  const i = text.indexOf(term);
  if (i < 0) return "";
  const half = Math.floor(n / 2);
  return `…${text.slice(Math.max(0, i - half), i + term.length + half).replace(/\s+/g, " ")}…`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "NotFoundError";
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 既存のDBを開く。存在しなければ新規作成せず、nullを返す。 */
async function openExistingDatabase(env: DiagnosticsEnv): Promise<IDBDatabase | null> {
  if (typeof env.indexedDB.databases === "function") {
    const list = await env.indexedDB.databases();
    if (!list.some((d) => d.name === "tsumugi")) return null;
  }
  return new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = env.indexedDB.open("tsumugi"); // バージョン指定なし＝既存DBをそのまま開く
    request.onupgradeneeded = (event) => {
      // DBが存在しなかった場合（新規作成になってしまう場合）。作らずに中止する。
      try {
        (event.target as IDBOpenDBRequest).transaction?.abort();
      } catch {
        // no-op
      }
      resolve(null);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

interface StoreReader {
  getAll: (store: string) => Promise<unknown[]>;
  getAllKeys: (store: string) => Promise<IDBValidKey[]>;
  get: (store: string, key: IDBValidKey) => Promise<unknown>;
}

function makeReader(db: IDBDatabase): StoreReader {
  const has = (name: string) => db.objectStoreNames.contains(name);
  const store = (name: string) => db.transaction(name, "readonly").objectStore(name); // 常にreadonly
  return {
    getAll: (name) => (has(name) ? requestToPromise(store(name).getAll()) : Promise.resolve([])),
    getAllKeys: (name) => (has(name) ? requestToPromise(store(name).getAllKeys()) : Promise.resolve([])),
    get: (name, key) => (has(name) ? requestToPromise(store(name).get(key)) : Promise.resolve(undefined)),
  };
}

async function dirOf(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name); // create指定なし
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readJson(dir: FileSystemDirectoryHandle, name: string): Promise<unknown | null | { __error: string }> {
  try {
    const handle = await dir.getFileHandle(name); // create指定なし
    return JSON.parse(await (await handle.getFile()).text());
  } catch (error) {
    if (isNotFound(error)) return null;
    return { __error: String(error) };
  }
}

interface OpfsScan {
  readable: boolean;
  rootEntries: string[];
  baselineEstablishedAt: string | null;
  registryMeta: string;
  historyMeta: { totalMemories: number; totalConversations: number } | null;
  registryShards: number;
  registryUnreadableShards: number;
  registryStatuses: Record<string, number>;
  // メモリ上の集計（Map.setは保存ではない。書き込み系APIと紛れないよう、Setのaddを使わない）
  memoryIds: Map<string, true>;
  conversationIds: Map<string, true>;
  sourceIds: Map<string, true>;
  markdownFiles: { memories: number; conversations: number; sources: number };
  /** Registryのkey（会話・振り返り・素材はid、通常Memoryは`day:YYYY-MM-DD`）→ entry。 */
  registryEntries: Map<string, { recordType: string; status: string; path: string }>;
  /** OPFS内のMarkdownの相対path（`Memories/2026-09-19.md`等）。 */
  markdownPaths: Map<string, true>;
}

async function scanOpfs(root: FileSystemDirectoryHandle): Promise<OpfsScan> {
  const scan: OpfsScan = {
    readable: true,
    rootEntries: [],
    baselineEstablishedAt: null,
    registryMeta: "(なし)",
    historyMeta: null,
    registryShards: 0,
    registryUnreadableShards: 0,
    registryStatuses: {},
    memoryIds: new Map(),
    conversationIds: new Map(),
    sourceIds: new Map(),
    markdownFiles: { memories: 0, conversations: 0, sources: 0 },
    registryEntries: new Map(),
    markdownPaths: new Map(),
  };
  for await (const [name, handle] of root.entries()) scan.rootEntries.push(name + (handle.kind === "directory" ? "/" : ""));

  const tsumugi = await dirOf(root, ".tsumugi");
  if (tsumugi) {
    const meta = (await readJson(tsumugi, "registry-meta.json")) as { baselineEstablishedAt?: string | null; __error?: string } | null;
    if (meta && !meta.__error) {
      scan.baselineEstablishedAt = typeof meta.baselineEstablishedAt === "string" ? meta.baselineEstablishedAt : null;
      scan.registryMeta = `baselineEstablishedAt=${scan.baselineEstablishedAt ?? "null"}`;
    } else if (meta && meta.__error) {
      scan.registryMeta = "(読み取りエラー)";
    }
    const history = (await readJson(tsumugi, "history-meta.json")) as { totalMemories?: number; totalConversations?: number } | null;
    if (history && typeof history.totalMemories === "number") {
      scan.historyMeta = { totalMemories: history.totalMemories, totalConversations: history.totalConversations ?? 0 };
    }
    const registryDir = await dirOf(tsumugi, "registry");
    if (registryDir) {
      for await (const [name, handle] of registryDir.entries()) {
        if (handle.kind !== "file" || !name.endsWith(".json")) continue;
        const shard = (await readJson(registryDir, name)) as {
          records?: Record<string, string>;
          files?: Record<string, { recordType?: string; status?: string; memberIds?: string[] }>;
          __error?: string;
        } | null;
        if (!shard || shard.__error || !shard.records || !shard.files) {
          scan.registryUnreadableShards += 1;
          continue;
        }
        scan.registryShards += 1;
        for (const [key, path] of Object.entries(shard.records)) {
          const entry: { recordType?: string; status?: string; memberIds?: string[] } | undefined = shard.files[path];
          if (!entry) continue;
          scan.registryEntries.set(key, { recordType: String(entry.recordType), status: String(entry.status), path });
          const label = `${entry.recordType}:${entry.status}`;
          scan.registryStatuses[label] = (scan.registryStatuses[label] ?? 0) + 1;
          if (entry.recordType === "conversation") scan.conversationIds.set(key, true);
          else if (entry.recordType === "source") scan.sourceIds.set(key, true);
          else if (entry.recordType === "reflection") scan.memoryIds.set(key, true);
          else for (const id of entry.memberIds ?? []) scan.memoryIds.set(id, true);
        }
      }
    }
  }

  // Markdown実体（Registryが空・不完全でも判定できるよう、ファイル側のidも集める）
  const walk = async (
    dir: FileSystemDirectoryHandle,
    area: "Memories" | "Conversations" | "Sources",
    depth: number,
    prefix: string
  ): Promise<void> => {
    if (depth > 6) return;
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith(".")) continue;
      if (handle.kind === "directory") {
        await walk(handle as FileSystemDirectoryHandle, area, depth + 1, `${prefix}${name}/`);
        continue;
      }
      if (!name.endsWith(".md")) continue;
      scan.markdownPaths.set(`${prefix}${name}`, true);
      const text = await (await (handle as FileSystemFileHandle).getFile()).text();
      if (area === "Memories") {
        scan.markdownFiles.memories += 1;
        for (const match of text.matchAll(/^id: (\S+)$/gm)) scan.memoryIds.set(match[1], true);
      } else if (area === "Conversations") {
        scan.markdownFiles.conversations += 1;
        const match = /^id: (\S+)$/m.exec(text);
        if (match) scan.conversationIds.set(match[1], true);
      } else {
        scan.markdownFiles.sources += 1;
        const match = /^id: (\S+)$/m.exec(text);
        if (match) scan.sourceIds.set(match[1], true);
      }
    }
  };
  for (const area of ["Memories", "Conversations", "Sources"] as const) {
    const dir = await dirOf(root, area);
    if (dir) await walk(dir, area, 0, `${area}/`);
  }
  return scan;
}

interface StoredMemory {
  id: string;
  createdAt?: string;
  date?: string;
  types?: string[];
  metadata?: { source?: string };
  updatedAt?: string;
  summary?: string;
  content?: string;
  keywords?: string[];
  revisitPrompt?: string;
  conversationId?: string;
}

interface StoredConversation {
  id: string;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  status?: string;
  memoryObjectIds?: string[];
  turns?: { content?: string; timestamp?: string }[];
}

// ---------------------------------------------------------------------------
// 診断本体
// ---------------------------------------------------------------------------

export async function runAndroidDiagnostics(env: DiagnosticsEnv = defaultDiagnosticsEnv()): Promise<DiagnosticsReport> {
  const report: DiagnosticsReport = {
    status: "ok",
    errors: [],
    env: {
      standalone: env.isStandalone,
      android: /Android/i.test(env.userAgent),
      opfsSupported: env.getOpfsRoot !== null,
      origin: env.origin,
    },
    idb: null,
    settings: { lastPromptedMemoryIdsCount: null },
    opfs: null,
    diff: null,
    idbOnly: [],
    matches: [],
    matchTotals: { total: 0, idbOnly: 0 },
    verdict: { level: "undetermined", lines: [], details: [] },
    v2: null,
  };

  let db: IDBDatabase | null = null;
  try {
    db = await openExistingDatabase(env);
    if (!db) {
      report.status = "no-database";
      report.verdict = {
        level: "undetermined",
        lines: ["IndexedDBに tsumugi のデータベースが存在しません。この診断では、旧Memory残存を確認できません。"],
        details: ["新規作成を避けるため、何も開かずに中止しました。"],
      };
      return report;
    }
    const reader = makeReader(db);

    // --- IDB ---
    const conversations = (await reader.getAll("conversations")) as StoredConversation[];
    const memories = (await reader.getAll("memoryObjects")) as StoredMemory[];
    const sources = (await reader.getAll("sources")) as { id: string }[];
    const connectKeys = new Set((await reader.getAllKeys("connectState")).map(String));
    const ledgerKeys = new Set((await reader.getAllKeys("vaultSyncState")).map(String));
    report.idb = {
      counts: {
        conversations: conversations.length,
        memoryObjects: memories.length,
        sources: sources.length,
        connectState: connectKeys.size,
        vaultSyncState: ledgerKeys.size,
      },
    };

    // --- settings（許可リストのキーだけ。APIキーは読まない） ---
    for (const key of SAFE_SETTINGS_KEYS) {
      const value = await reader.get("settings", key);
      report.settings[key] = typeof value === "string" || typeof value === "number" ? value : value === undefined ? null : String(value);
    }
    try {
      const raw = await reader.get("settings", "lastPromptedMemoryIds");
      report.settings.lastPromptedMemoryIdsCount = typeof raw === "string" ? (JSON.parse(raw) as unknown[]).length : null;
    } catch {
      report.settings.lastPromptedMemoryIdsCount = null;
    }

    // --- OPFS ---
    let opfs: OpfsScan | null = null;
    let allHits: KeywordMatch[] = [];
    if (env.getOpfsRoot) {
      try {
        opfs = await scanOpfs(await env.getOpfsRoot());
      } catch (error) {
        report.errors.push(`OPFSを読み取れませんでした：${String(error)}`);
      }
    } else {
      report.errors.push("このブラウザはOPFSに対応していません。");
    }
    if (opfs) {
      report.opfs = {
        readable: true,
        rootEntries: opfs.rootEntries,
        baselineEstablishedAt: opfs.baselineEstablishedAt,
        registryMeta: opfs.registryMeta,
        historyMeta: opfs.historyMeta,
        registryShards: opfs.registryShards,
        registryUnreadableShards: opfs.registryUnreadableShards,
        registryStatuses: opfs.registryStatuses,
        memoryIds: opfs.memoryIds.size,
        conversationIds: opfs.conversationIds.size,
        sourceIds: opfs.sourceIds.size,
        markdownFiles: opfs.markdownFiles,
      };

      // --- 差分 ---
      const idbMemoryIds = new Set(memories.map((m) => m.id));
      const idbConversationIds = new Set(conversations.map((c) => c.id));
      const idbOnlyMemories = memories.filter((m) => !opfs.memoryIds.has(m.id));
      report.diff = {
        idbMemories: memories.length,
        opfsMemories: opfs.memoryIds.size,
        idbOnlyMemories: idbOnlyMemories.length,
        opfsOnlyMemories: [...opfs.memoryIds.keys()].filter((id) => !idbMemoryIds.has(id)).length,
        idbOnlyConversations: conversations.filter((c) => !opfs.conversationIds.has(c.id)).length,
        opfsOnlyConversations: [...opfs.conversationIds.keys()].filter((id) => !idbConversationIds.has(id)).length,
        idbOnlySources: sources.filter((s) => !opfs.sourceIds.has(s.id)).length,
      };

      // --- IDB-only Memory（新しい順、最大30件） ---
      const sorted = [...idbOnlyMemories].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      for (const memory of sorted.slice(0, MAX_IDB_ONLY_DETAIL)) {
        const ledgerValue = ledgerKeys.has(`memory:${memory.id}`) ? await reader.get("vaultSyncState", `memory:${memory.id}`) : undefined;
        report.idbOnly.push({
          id: memory.id,
          createdAt: String(memory.createdAt ?? ""),
          updatedAt: String(memory.updatedAt ?? ""),
          summary: short(memory.summary),
          content: short(memory.content),
          ledger: ledgerValue === undefined ? "none" : ledgerValue === memory.updatedAt ? "synced" : "other",
          hasConnectState: connectKeys.has(memory.id),
          beforeBaseline:
            opfs.baselineEstablishedAt === null ? null : String(memory.createdAt ?? "") < opfs.baselineEstablishedAt,
          conversationInOpfs: memory.conversationId ? opfs.conversationIds.has(memory.conversationId) : null,
        });
      }

      // --- キーワード検索（Memory・Conversation） ---
      const hits: KeywordMatch[] = [];
      for (const memory of memories) {
        const hay = [memory.summary, memory.content, (memory.keywords ?? []).join(" "), memory.revisitPrompt]
          .filter((x): x is string => typeof x === "string")
          .join(" \n ");
        const terms = DIAGNOSTIC_KEYWORDS.filter((k) => hay.includes(k));
        if (terms.length > 0) {
          hits.push({
            kind: "memory",
            id: memory.id,
            createdAt: String(memory.createdAt ?? ""),
            terms: [...terms],
            snippet: around(hay, terms[0]),
            idbOnly: !opfs.memoryIds.has(memory.id),
            inOpfs: opfs.memoryIds.has(memory.id),
          });
        }
      }
      for (const conversation of conversations) {
        const hay = (conversation.turns ?? []).map((t) => t.content ?? "").join(" \n ");
        const terms = DIAGNOSTIC_KEYWORDS.filter((k) => hay.includes(k));
        if (terms.length > 0) {
          hits.push({
            kind: "conversation",
            id: conversation.id,
            createdAt: String(conversation.createdAt ?? ""),
            terms: [...terms],
            snippet: around(hay, terms[0]),
            idbOnly: !opfs.conversationIds.has(conversation.id),
            inOpfs: opfs.conversationIds.has(conversation.id),
          });
        }
      }
      hits.sort((a, b) => b.terms.length - a.terms.length || b.createdAt.localeCompare(a.createdAt));
      report.matchTotals = { total: hits.length, idbOnly: hits.filter((h) => h.idbOnly).length };
      report.matches = hits.slice(0, MAX_KEYWORD_MATCHES);
      allHits = hits;
    }

    if (opfs) {
      report.v2 = await analyzeV2({ memories, conversations, opfs, reader, ledgerKeys });
    }

    report.verdict = judge(report, allHits);
    return report;
  } catch (error) {
    report.status = "error";
    report.errors.push(String(error instanceof Error ? error.message : error));
    report.verdict = { level: "undetermined", lines: ["診断中にエラーが発生したため、断定できません。"], details: [] };
    return report;
  } finally {
    try {
      db?.close();
    } catch {
      // no-op
    }
  }
}

// ---------------------------------------------------------------------------
// 診断v2：baseline以降のIDB-only記録の、予測されるHOLDの理由
// ---------------------------------------------------------------------------

const MAX_V2_ROWS = 100;

/** `vault.ts`の`isRecordNewerThanBaseline`と同じ規則（どちらかがparseできなければ「新しくない」）。 */
function isNewerThan(iso: string | undefined | null, baseline: string): boolean {
  const a = Date.parse(iso ?? "");
  const b = Date.parse(baseline);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a > b;
}

function lastTurnAtOf(conversation: StoredConversation): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const turn of conversation.turns ?? []) {
    const ms = Date.parse(turn.timestamp ?? "");
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = turn.timestamp ?? null;
    }
  }
  return best;
}

function ledgerStateOf(value: unknown, updatedAt: string | undefined): "none" | "synced" | "other" {
  if (value === undefined) return "none";
  return value === updatedAt ? "synced" : "other";
}

function emptyCounts(): V2Counts {
  return { total: 0, H1: 0, H2: 0, H3: 0, registry: 0, unresolved: 0, noneAtAll: 0, multiple: 0 };
}

async function analyzeV2(args: {
  memories: StoredMemory[];
  conversations: StoredConversation[];
  opfs: OpfsScan;
  reader: StoreReader;
  ledgerKeys: Set<string>;
}): Promise<DiagnosticsV2> {
  const { memories, conversations, opfs, reader, ledgerKeys } = args;
  const baseline = opfs.baselineEstablishedAt;
  const empty = (reason: string): DiagnosticsV2 => ({
    available: false,
    unavailableReason: reason,
    baseline,
    memory: { rows: [], omitted: 0, counts: emptyCounts(), pre: 0 },
    conversation: { rows: [], omitted: 0, counts: emptyCounts(), pre: 0 },
  });
  if (baseline === null) return empty("OPFSにbaselineが記録されていないため、baseline前後の分類ができません。");

  const dayFileDays = new Map<string, true>();
  for (const path of opfs.markdownPaths.keys()) {
    const m = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
    if (m) dayFileDays.set(m[1], true);
  }
  const idbConversationById = new Map(conversations.map((c) => [c.id, c]));
  const isReflection = (m: StoredMemory) => m.metadata?.source === "system-generated";
  const dayOf = (m: StoredMemory) => String(m.date ?? "").slice(0, 10);

  // 通常Memoryの、日ごとの「baseline以前に作られたIDB Memory」の件数（日単位ゲートの条件そのもの）
  const legacyByDay = new Map<string, number>();
  for (const m of memories) {
    if (isReflection(m)) continue;
    if (!isNewerThan(m.createdAt, baseline)) legacyByDay.set(dayOf(m), (legacyByDay.get(dayOf(m)) ?? 0) + 1);
  }

  const registryInfo = (key: string): V2RegistryInfo => {
    const entry = opfs.registryEntries.get(key);
    return {
      key,
      present: entry !== undefined,
      status: entry ? entry.status : null,
      path: entry ? entry.path : null,
      fileExists: entry ? opfs.markdownPaths.has(entry.path) : null,
    };
  };
  const registryProblem = (r: V2RegistryInfo) => r.present && (r.status !== "ok" || r.fileExists === false);

  // ---- Memory（IDB-only かつ baseline以降に作成） ----
  const idbOnlyMemories = memories.filter((m) => !opfs.memoryIds.has(m.id));
  const postMemories = idbOnlyMemories
    .filter((m) => isNewerThan(m.createdAt, baseline))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const memoryCounts = emptyCounts();
  memoryCounts.total = postMemories.length;
  const memoryRows: V2MemoryRow[] = [];
  for (const m of postMemories) {
    const reflection = isReflection(m);
    const dateDay = dayOf(m);
    const registry = registryInfo(reflection ? m.id : `day:${dateDay}`);
    const legacyDayMates = reflection ? 0 : legacyByDay.get(dateDay) ?? 0;
    const causes: V2MemoryCause[] = [];
    // 通常Memoryのゲートは、Registryにその日のentryが無いときだけ働く（vault.tsのlookup.entry===undefined）。
    if (!reflection && !registry.present && legacyDayMates > 0) causes.push("H1");
    if (registryProblem(registry)) causes.push("Registry");

    const conv = m.conversationId ? idbConversationById.get(m.conversationId) : undefined;
    const lastTurnAt = conv ? lastTurnAtOf(conv) : null;
    const convLegacy = conv !== undefined && !isNewerThan(conv.createdAt, baseline);
    const context: ("H2" | "H3")[] = [];
    if (convLegacy) context.push("H2");
    if (convLegacy && lastTurnAt !== null && !isNewerThan(lastTurnAt, baseline) && isNewerThan(m.createdAt, baseline)) context.push("H3");
    let gap: number | null = null;
    if (lastTurnAt !== null) {
      const ms = Date.parse(String(m.createdAt)) - Date.parse(lastTurnAt);
      gap = Number.isNaN(ms) ? null : Math.round(ms / 60000);
    }

    if (causes.includes("H1")) memoryCounts.H1 += 1;
    if (causes.includes("Registry")) memoryCounts.registry += 1;
    if (context.includes("H2")) memoryCounts.H2 += 1;
    if (context.includes("H3")) memoryCounts.H3 += 1;
    if (causes.length === 0) memoryCounts.unresolved += 1;
    if (causes.length === 0 && context.length === 0) memoryCounts.noneAtAll += 1;
    if (causes.length + context.length >= 2) memoryCounts.multiple += 1;

    if (memoryRows.length < MAX_V2_ROWS) {
      memoryRows.push({
        id: m.id,
        createdAt: String(m.createdAt ?? ""),
        date: String(m.date ?? ""),
        dateDay,
        beforeBaseline: !isNewerThan(m.createdAt, baseline),
        kind: reflection ? "振り返り" : "通常",
        types: m.types ?? [],
        conversationId: m.conversationId ?? null,
        conversation: m.conversationId
          ? {
              inIdb: conv !== undefined,
              createdAt: conv?.createdAt ?? null,
              startedAt: conv?.startedAt ?? null,
              updatedAt: conv?.updatedAt ?? null,
              status: conv?.status ?? null,
              turns: conv ? (conv.turns ?? []).length : null,
              lastTurnAt,
              memoryObjectIds: conv ? (conv.memoryObjectIds ?? []).length : null,
              inOpfs: opfs.conversationIds.has(m.conversationId),
              beforeBaseline: conv ? !isNewerThan(conv.createdAt, baseline) : null,
            }
          : null,
        ledger: ledgerStateOf(ledgerKeys.has(`memory:${m.id}`) ? await reader.get("vaultSyncState", `memory:${m.id}`) : undefined, m.updatedAt),
        registry,
        dayFileInOpfs: dayFileDays.has(dateDay),
        legacyDayMates,
        causes,
        context,
        captureGapMinutes: gap,
      });
    }
  }

  // ---- Conversation（IDB-only かつ baseline以降に作成または更新） ----
  const idbOnlyConversations = conversations.filter((c) => !opfs.conversationIds.has(c.id));
  const postConversations = idbOnlyConversations
    .filter((c) => isNewerThan(c.updatedAt, baseline) || isNewerThan(c.createdAt, baseline))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const conversationCounts = emptyCounts();
  conversationCounts.total = postConversations.length;
  const conversationRows: V2ConversationRow[] = [];
  for (const c of postConversations) {
    const registry = registryInfo(c.id);
    const lastTurnAt = lastTurnAtOf(c);
    const legacy = !isNewerThan(c.createdAt, baseline);
    const causes: V2ConversationCause[] = [];
    // 会話のゲートは、Registryにentryが無く、createdAtがbaseline以前のときに保留する。
    if (!registry.present && legacy) causes.push("H2");
    // startup Capture候補：baseline以前に始まり、全ターンがbaseline以前で、baselineの後にupdatedAtが更新された。
    if (legacy && lastTurnAt !== null && !isNewerThan(lastTurnAt, baseline) && isNewerThan(c.updatedAt, baseline)) causes.push("H3");
    if (registryProblem(registry)) causes.push("Registry");

    if (causes.includes("H2")) conversationCounts.H2 += 1;
    if (causes.includes("H3")) conversationCounts.H3 += 1;
    if (causes.includes("Registry")) conversationCounts.registry += 1;
    if (causes.length === 0) {
      conversationCounts.unresolved += 1;
      conversationCounts.noneAtAll += 1;
    }
    if (causes.length >= 2) conversationCounts.multiple += 1;

    if (conversationRows.length < MAX_V2_ROWS) {
      conversationRows.push({
        id: c.id,
        createdAt: String(c.createdAt ?? ""),
        startedAt: String(c.startedAt ?? ""),
        updatedAt: String(c.updatedAt ?? ""),
        beforeBaseline: legacy,
        status: String(c.status ?? ""),
        turns: (c.turns ?? []).length,
        lastTurnAt,
        memoryObjectIds: c.memoryObjectIds ?? [],
        ledger: ledgerStateOf(ledgerKeys.has(`conversation:${c.id}`) ? await reader.get("vaultSyncState", `conversation:${c.id}`) : undefined, c.updatedAt),
        registry,
        inOpfs: opfs.conversationIds.has(c.id),
        causes,
      });
    }
  }

  return {
    available: true,
    unavailableReason: null,
    baseline,
    memory: {
      rows: memoryRows,
      omitted: Math.max(0, postMemories.length - memoryRows.length),
      counts: memoryCounts,
      pre: idbOnlyMemories.length - postMemories.length,
    },
    conversation: {
      rows: conversationRows,
      omitted: Math.max(0, postConversations.length - conversationRows.length),
      counts: conversationCounts,
      pre: idbOnlyConversations.length - postConversations.length,
    },
  };
}

/** 判定（断定できない場合は断定しない）。 */
function judge(report: DiagnosticsReport, allHits: KeywordMatch[]): DiagnosticsReport["verdict"] {
  const diff = report.diff;
  if (!diff || !report.opfs) {
    return { level: "undetermined", lines: ["OPFS側を読み取れなかったため、断定できません。"], details: report.errors };
  }
  const details: string[] = [];
  const hits = allHits.filter((h) => h.kind === "memory" && h.idbOnly);
  if (diff.idbOnlyMemories > 0) {
    details.push(`IndexedDBのMemory ${diff.idbMemories}件のうち、OPFSに存在しないものが${diff.idbOnlyMemories}件あります。`);
    if (report.opfs.baselineEstablishedAt) {
      const before = report.idbOnly.filter((m) => m.beforeBaseline === true).length;
      details.push(`表示した${report.idbOnly.length}件のうち${before}件は、OPFSのbaseline（${report.opfs.baselineEstablishedAt}）より前に作られています。`);
    }
    const synced = report.idbOnly.filter((m) => m.ledger === "synced").length;
    details.push(`表示した${report.idbOnly.length}件のうち${synced}件は、同期の記録（台帳）が「同期済み」です。`);
    if (report.opfs.memoryIds === 0) details.push("OPFSにはMemoryが1件もありません。");
    const lines = ["OPFSに存在しないMemoryがIndexedDBに残っています。これらは現在のRetrieval対象になる可能性があります。"];
    if (hits.length > 0) {
      lines.push("以前の会話に現れた情報と、IndexedDBにのみ残るMemoryとの関連が確認できます。");
      details.push(`検索語に一致するMemoryのうち、IndexedDBのみのものが${hits.length}件あります。`);
      return { level: "B", lines, details };
    }
    details.push("検索語に一致するIndexedDBのみのMemoryは見つかりませんでした（別の出どころの可能性も残ります）。");
    return { level: "A", lines, details };
  }
  if (diff.idbMemories > 0 && diff.opfsOnlyMemories === 0) {
    return {
      level: "C",
      lines: ["旧Memory残存仮説はこの診断では確認できません。"],
      details: [`IndexedDBのMemory ${diff.idbMemories}件は、全てOPFSにも存在します。`],
    };
  }
  const reason =
    diff.idbMemories === 0
      ? "IndexedDBにMemoryがありません。会話に出た内容の出どころは、別の保存領域の可能性があります。"
      : `OPFSにあってIndexedDBに無いMemoryが${diff.opfsOnlyMemories}件あります。`;
  return { level: "undetermined", lines: ["この診断だけでは断定できません。"], details: [reason] };
}

// ---------------------------------------------------------------------------
// 表示・コピー用のテキスト
// ---------------------------------------------------------------------------

export function renderReportText(report: DiagnosticsReport): string {
  const out: string[] = [];
  out.push("Android データ診断（READ ONLY・データは変更していません）");
  out.push(`origin: ${report.env.origin} / Android: ${report.env.android} / PWA表示: ${report.env.standalone} / OPFS対応: ${report.env.opfsSupported}`);

  out.push("\n■ 判定");
  out.push(`[${report.verdict.level}] ${report.verdict.lines.join(" ")}`);
  for (const line of report.verdict.details) out.push(`  ・${line}`);

  out.push("\n■ IDB");
  if (report.idb) {
    const c = report.idb.counts;
    out.push(`conversations ${c.conversations} / memoryObjects ${c.memoryObjects} / sources ${c.sources} / connectState ${c.connectState} / vaultSyncState ${c.vaultSyncState}`);
    out.push("settings:");
    for (const [key, value] of Object.entries(report.settings)) {
      if (key === "lastPromptedMemoryIdsCount") out.push(`  lastPromptedMemoryIds 件数 = ${value ?? "(なし)"}`);
      else out.push(`  ${key} = ${value ?? "(なし)"}`);
    }
  } else {
    out.push("(読み取れませんでした)");
  }

  out.push("\n■ OPFS");
  if (report.opfs) {
    const o = report.opfs;
    out.push(`Memory id ${o.memoryIds} / Conversation id ${o.conversationIds} / Source id ${o.sourceIds}`);
    out.push(`Markdownファイル数 Memories ${o.markdownFiles.memories} / Conversations ${o.markdownFiles.conversations} / Sources ${o.markdownFiles.sources}`);
    out.push(`Registry: shard ${o.registryShards}（読めない ${o.registryUnreadableShards}）/ status ${JSON.stringify(o.registryStatuses)}`);
    out.push(`baseline: ${o.registryMeta}`);
    if (o.historyMeta) out.push(`History Index: Memory ${o.historyMeta.totalMemories} / Conversation ${o.historyMeta.totalConversations}`);
    out.push(`OPFS root: ${o.rootEntries.join(" ") || "(空)"}`);
  } else {
    out.push("(読み取れませんでした)");
  }
  for (const error of report.errors) out.push(`! ${error}`);

  out.push("\n■ 差分");
  if (report.diff) {
    const d = report.diff;
    out.push(`IDB Memory ${d.idbMemories} / OPFS Memory ${d.opfsMemories}`);
    out.push(`IDBにあってOPFSに無いMemory ${d.idbOnlyMemories} / OPFSにあってIDBに無いMemory ${d.opfsOnlyMemories}`);
    out.push(`Conversation: IDBのみ ${d.idbOnlyConversations} / OPFSのみ ${d.opfsOnlyConversations}　Source: IDBのみ ${d.idbOnlySources}`);
  } else {
    out.push("(算出できませんでした)");
  }

  out.push(`\n■ IDB-only Memory（新しい順・最大${MAX_IDB_ONLY_DETAIL}件）`);
  if (report.diff && report.diff.idbOnlyMemories > report.idbOnly.length) out.push(`（全${report.diff.idbOnlyMemories}件のうち${report.idbOnly.length}件を表示）`);
  if (report.idbOnly.length === 0) out.push("(なし)");
  for (const m of report.idbOnly) {
    out.push(`- ${m.id}`);
    out.push(`    created ${m.createdAt} / updated ${m.updatedAt}`);
    out.push(`    summary: ${m.summary}`);
    out.push(`    content: ${m.content}`);
    out.push(
      `    台帳: ${m.ledger === "none" ? "なし" : m.ledger === "synced" ? "あり(同期済み)" : "あり(別の値)"} / connectState: ${m.hasConnectState ? "あり" : "なし"} / baselineより前: ${
        m.beforeBaseline === null ? "不明" : m.beforeBaseline ? "はい" : "いいえ"
      } / 元の会話がOPFSに: ${m.conversationInOpfs === null ? "会話id無し" : m.conversationInOpfs ? "ある" : "無い"}`
    );
  }

  out.push(`\n■ キーワード一致（${DIAGNOSTIC_KEYWORDS.join(" / ")}）`);
  out.push(`一致 ${report.matchTotals.total}件（うちIDBのみ ${report.matchTotals.idbOnly}件）`);
  for (const h of report.matches) {
    out.push(`- [${h.kind === "memory" ? "Memory" : "会話"}] ${h.id} ${h.idbOnly ? "【IDBのみ】" : "OPFSにもある"} 語=${h.terms.join(",")}`);
    out.push(`    ${h.snippet}`);
  }
  if (report.matchTotals.total > report.matches.length) out.push(`…ほか${report.matchTotals.total - report.matches.length}件`);
  out.push(...renderV2Lines(report.v2));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 診断v2の表示用テキスト
// ---------------------------------------------------------------------------

function yn(value: boolean | null): string {
  return value === null ? "不明" : value ? "有" : "無";
}

function ledgerLabel(state: "none" | "synced" | "other"): string {
  return state === "none" ? "なし" : state === "synced" ? "あり(同期済み)" : "あり(別の値)";
}

function registryLabel(r: V2RegistryInfo): string {
  if (!r.present) return `entryなし(${r.key})`;
  return `entryあり(${r.key}) status=${r.status} ファイル=${yn(r.fileExists)}`;
}

function countsLine(c: V2Counts, kind: "memory" | "conversation"): string[] {
  const lines: string[] = [];
  lines.push(`合計 ${c.total}件`);
  if (kind === "memory") {
    lines.push(`  H1（日単位のbaselineゲート）: ${c.H1}件`);
    lines.push(`  Registry HOLD: ${c.registry}件`);
    lines.push(`  H2（元会話がbaseline以前に開始・文脈）: ${c.H2}件 / H3候補（元会話の全ターンがbaseline以前・startup Capture・文脈）: ${c.H3}件`);
    lines.push(`  直接の原因（H1・Registry）が無い: ${c.unresolved}件 / どの仮説にも該当しない: ${c.noneAtAll}件 / 複数該当: ${c.multiple}件`);
  } else {
    lines.push(`  H2（baseline以前に開始・Registryにentryなし）: ${c.H2}件`);
    lines.push(`  H3候補（startup Capture）: ${c.H3}件`);
    lines.push(`  Registry HOLD: ${c.registry}件`);
    lines.push(`  原因未解決（該当なし）: ${c.unresolved}件 / 複数該当: ${c.multiple}件`);
  }
  return lines;
}

export function renderV2Lines(v2: DiagnosticsV2 | null): string[] {
  const out: string[] = [];
  out.push("\n■ 診断v2：baseline以降のIDB-only（予測されるHOLDの理由）");
  if (!v2) {
    out.push("(OPFSを読めなかったため、算出できません)");
    return out;
  }
  if (!v2.available) {
    out.push(v2.unavailableReason ?? "(算出できません)");
    return out;
  }
  out.push(`baseline: ${v2.baseline}`);
  out.push("※ 複数該当する記録は全て表示し、1つには決めません。「該当なし」は推測で分類していません（H4：書き込みの失敗・未再試行などを排除できません）。");

  out.push("\n■ v2 集計：baseline後に作られたIDB-only Memory");
  out.push(...countsLine(v2.memory.counts, "memory"));
  out.push(`（参考）baseline以前に作られたIDB-only Memory: ${v2.memory.pre}件`);
  out.push("\n■ v2 集計：baseline後に作成または更新されたIDB-only Conversation");
  out.push(...countsLine(v2.conversation.counts, "conversation"));
  out.push(`（参考）baseline以前のまま更新の無いIDB-only Conversation: ${v2.conversation.pre}件`);

  out.push(`\n■ v2 Memory 詳細（新しい順・最大${MAX_V2_ROWS}件）`);
  for (const r of v2.memory.rows) {
    out.push(
      `- ${r.id} [${r.kind}] created=${r.createdAt} date=${r.date}(UTC日 ${r.dateDay}) baseline=${r.beforeBaseline ? "前" : "後"} types=${r.types.join(",") || "-"}`
    );
    out.push(`    予測HOLD理由: ${r.causes.length ? r.causes.join(" + ") : "直接原因なし"}${r.context.length ? ` / 文脈: ${r.context.map((c) => (c === "H3" ? "H3候補" : c)).join(" + ")}` : ""}${r.causes.length + r.context.length === 0 ? "（該当なし）" : ""}`);
    if (r.conversation) {
      const c = r.conversation;
      out.push(
        `    元会話 ${r.conversationId}: IDB=${yn(c.inIdb)} OPFS=${yn(c.inOpfs)} created=${c.createdAt ?? "-"} started=${c.startedAt ?? "-"} updated=${c.updatedAt ?? "-"} baseline=${c.beforeBaseline === null ? "不明" : c.beforeBaseline ? "前" : "後"} status=${c.status ?? "-"} turns=${c.turns ?? "-"} 最終ターン=${c.lastTurnAt ?? "-"} memoryObjectIds=${c.memoryObjectIds ?? "-"} 最終ターン→Capture=${r.captureGapMinutes === null ? "-" : r.captureGapMinutes + "分"}`
      );
    } else {
      out.push("    元会話: conversationIdなし");
    }
    out.push(`    台帳: ${ledgerLabel(r.ledger)} / Registry: ${registryLabel(r.registry)} / OPFSのその日のday-file: ${yn(r.dayFileInOpfs)} / 同じ日のbaseline以前のIDB Memory: ${r.legacyDayMates}件`);
  }
  if (v2.memory.omitted > 0) out.push(`…ほか${v2.memory.omitted}件（集計には含まれています）`);

  out.push(`\n■ v2 Conversation 詳細（新しい順・最大${MAX_V2_ROWS}件）`);
  for (const r of v2.conversation.rows) {
    out.push(
      `- ${r.id} created=${r.createdAt} started=${r.startedAt} updated=${r.updatedAt} baseline(作成)=${r.beforeBaseline ? "前" : "後"} status=${r.status} turns=${r.turns} 最終ターン=${r.lastTurnAt ?? "-"}`
    );
    out.push(`    予測HOLD理由: ${r.causes.length ? r.causes.map((c) => (c === "H3" ? "H3候補" : c)).join(" + ") : "該当なし"}`);
    out.push(
      `    memoryObjectIds: ${r.memoryObjectIds.length ? r.memoryObjectIds.join(",") : "なし"} / 台帳: ${ledgerLabel(r.ledger)} / Registry: ${registryLabel(r.registry)} / OPFS: ${yn(r.inOpfs)}`
    );
  }
  if (v2.conversation.omitted > 0) out.push(`…ほか${v2.conversation.omitted}件（集計には含まれています）`);
  return out;
}
