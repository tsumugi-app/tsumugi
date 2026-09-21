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
  const walk = async (dir: FileSystemDirectoryHandle, area: "Memories" | "Conversations" | "Sources", depth: number): Promise<void> => {
    if (depth > 6) return;
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith(".")) continue;
      if (handle.kind === "directory") {
        await walk(handle as FileSystemDirectoryHandle, area, depth + 1);
        continue;
      }
      if (!name.endsWith(".md")) continue;
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
    if (dir) await walk(dir, area, 0);
  }
  return scan;
}

interface StoredMemory {
  id: string;
  createdAt?: string;
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
  turns?: { content?: string }[];
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
  return out.join("\n");
}
