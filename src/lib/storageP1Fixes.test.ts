/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias */
/**
 * 保存・復旧システム監査（2026-11-23）で再現されたP1欠陥 A-01〜A-06 の回帰テスト。架空データのみ。
 * 実行：`npm run test:storage-p1`。
 *
 * 各欠陥について確かめること：
 * 1. 監査の再現形状が「欠陥として」観測される形で固定されている（修正前のmainでは
 *    本ファイルの該当テストが失敗する＝再現できることが前提）。
 * 2. 修正後に欠陥が解消する。
 * 3. 正常なデータの従来動作が維持される。
 * 4. 異常時に既存データが保全される。
 * 5. エラーが無言で処理されない（件数・診断・例外のいずれかで表面化する）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..");
const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "idb") return require(path.join(OUT, "lib/fakeIdb.js"));
  return origLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// navigator.locks のfake（vaultWriteGate.test.tsと同じ実FIFO方式）。
// CIのNode 22には `navigator.locks` が無い（Web LocksはNode 24で追加）ため、
// 実物に任せると排他ロック取得が即座に拒否され（`locksSupported()` の安全側の
// 仕様）、`resyncVaultRegistry` を成功前提で呼ぶテストが環境依存で失敗する。
// ロック名ごとに独立したFIFOキューを持ち、sharedは同時許可・exclusiveは単独
// 許可という実物の意味論を保つ（全要求を直列化する単純化はしない：
// withVaultWorldReadのshared取得が resync の排他区間と競合しない等、
// 本suiteの前提を実物と揃えるため）。AbortSignal・ifAvailableにも対応する。
// ---------------------------------------------------------------------------

type FakeLockRequest = {
  mode: "shared" | "exclusive";
  grant: () => void;
  settled: boolean;
};

class FakeLockManager {
  private states = new Map<string, { heldShared: number; heldExclusive: boolean; queue: FakeLockRequest[] }>();

  private stateFor(name: string) {
    let s = this.states.get(name);
    if (!s) {
      s = { heldShared: 0, heldExclusive: false, queue: [] };
      this.states.set(name, s);
    }
    return s;
  }

  private pump(name: string) {
    const s = this.stateFor(name);
    for (;;) {
      const head = s.queue[0];
      if (!head) return;
      if (head.mode === "exclusive") {
        if (s.heldExclusive || s.heldShared > 0) return;
        s.queue.shift();
        s.heldExclusive = true;
        head.grant();
        return;
      }
      if (s.heldExclusive) return;
      s.queue.shift();
      s.heldShared += 1;
      head.grant();
    }
  }

  async request<T>(name: string, optionsOrCb: unknown, maybeCb?: (lock: { name: string } | null) => Promise<T>): Promise<T> {
    const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as (lock: { name: string } | null) => Promise<T>;
    const options = typeof optionsOrCb === "function" ? {} : (optionsOrCb as { mode?: string; signal?: AbortSignal; ifAvailable?: boolean });
    const mode = options.mode === "shared" ? "shared" : "exclusive";
    const s = this.stateFor(name);
    if (options.ifAvailable) {
      const canGrant = mode === "exclusive" ? !s.heldExclusive && s.heldShared === 0 && s.queue.length === 0 : !s.heldExclusive;
      if (!canGrant) return cb(null);
    }
    let req!: FakeLockRequest;
    const granted = new Promise<void>((resolve) => {
      req = { mode, settled: false, grant: () => { req.settled = true; resolve(); } };
    });
    s.queue.push(req);
    this.pump(name);
    if (!req.settled && options.signal) {
      const aborted = new Promise<never>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      try {
        await Promise.race([granted, aborted]);
      } catch (e) {
        const i = s.queue.indexOf(req);
        if (i >= 0) s.queue.splice(i, 1);
        this.pump(name);
        throw e;
      }
    } else {
      await granted;
    }
    try {
      return await cb({ name });
    } finally {
      if (mode === "exclusive") s.heldExclusive = false;
      else s.heldShared -= 1;
      this.pump(name);
    }
  }

  async query(): Promise<{ held: never[]; pending: never[] }> {
    return { held: [], pending: [] };
  }
}

// Node 22はグローバルに読み取り専用の`navigator`を持つため、definePropertyで差し替える
// （vaultWriteGate.test.tsと同じ方法）。実物のLockManagerがある環境（Node 24等）でも
// fakeへ統一し、本suiteの結果がNodeバージョンに依存しないようにする。
Object.defineProperty(globalThis, "navigator", { value: { locks: new FakeLockManager() }, configurable: true, writable: true });

import type { Conversation, MemoryObject, Source } from "./types";
import type { PersonRecord } from "./personAlias";
import type { PeopleState, PeopleStoreEnv, PeopleVaultEnv } from "./personAliasStore";
import type { RecoveryLocalSnapshot } from "./vaultRecovery";

const vault = require("./vault") as typeof import("./vault");
const db = require("./db") as typeof import("./db");
const worldLock = require("./vaultWorldLock") as typeof import("./vaultWorldLock");
const recovery = require("./vaultRecovery") as typeof import("./vaultRecovery");
const personAlias = require("./personAlias") as typeof import("./personAlias");
const personStore = require("./personAliasStore") as typeof import("./personAliasStore");
const markdown = require("./markdown") as typeof import("./markdown");
const vaultWriter = require("./vaultWriter") as typeof import("./vaultWriter");
const vaultRestore = require("./vaultRestore") as typeof import("./vaultRestore");
const safety = require("./vaultRewriteSafety") as typeof import("./vaultRewriteSafety");
const legacyCleanup = require("./vaultLegacyCleanup") as typeof import("./vaultLegacyCleanup");
const appendLocal = require("./vaultAppendLocal") as typeof import("./vaultAppendLocal");
const deletion = require("./vaultDeletion") as typeof import("./vaultDeletion");

const T = "2026-10-20T00:00:00.000Z";
const T2 = "2026-10-21T00:00:00.000Z";
const meta = { id: "meta", source: "ai-capture", schemaVersion: "1", createdAt: T, updatedAt: T };
const conversation = (id = "c1", turns?: Conversation["turns"]): Conversation =>
  ({
    id, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: turns ?? [{ role: "user", content: "架空の会話です", timestamp: T }], memoryObjectIds: [], metadata: { ...meta },
  }) as Conversation;
const memory = (id = "m1"): MemoryObject =>
  ({
    id, date: T, content: `架空の記録 ${id} です`, summary: `架空の記録 ${id} です`, types: ["event"], conversationId: "c1", keywords: [],
    links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T, updatedAt: T, metadata: { ...meta },
  }) as MemoryObject;
const source = (id = "s1"): Source => ({ id, title: "架空の素材", content: "架空の本文", sourceType: "text", createdAt: T, updatedAt: T }) as Source;
const local = (conversations: Conversation[] = [], memories: MemoryObject[] = [], sources: Source[] = []): RecoveryLocalSnapshot => ({
  conversations, memories, sources, sync: {},
});
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

// ---------------------------------------------------------------------------
// 架空Vault（メモリ上。vaultPeopleClassifier.test.tsと同じ形＋部分着地の再現）
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s);
const textOf = (b: Uint8Array) => dec.decode(b);

class MemVault {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>([""]);
  failText = new Set<string>();
  /** ここに含まれるpathへのgetFileは失敗する（読み取り失敗の注入。A-05）。 */
  failReads = new Set<string>();
  /** ここに含まれるpathへのcreateWritableは例外で失敗する（書き込み失敗の注入。A-05深掘り）。 */
  failWrites = new Set<string>();
  /** ここに含まれるpathへのcreateWritable書き込みは、close時に半分だけ着地する（例外は出ない）。 */
  partialWrites = new Set<string>();
  written: string[] = [];
  constructor(files: Record<string, string> = {}) {
    for (const [p, v] of Object.entries(files)) this.put(p, bytes(v));
  }
  put(p: string, data: Uint8Array) {
    this.files.set(p, data);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }
  text(p: string): string {
    const data = this.files.get(p);
    assert.ok(data, `expected file ${p} to exist`);
    return textOf(data);
  }
  snapshot() {
    return new Map([...this.files].map(([k, v]) => [k, Buffer.from(v).toString("hex")] as const));
  }
  notFound(): never {
    throw new DOMException("not found", "NotFoundError");
  }
  dir(prefix = ""): FileSystemDirectoryHandle {
    const self = this;
    const join = (name: string) => (prefix ? `${prefix}/${name}` : name);
    const fileHandle = (p: string) => ({
      kind: "file",
      name: p.split("/").pop(),
      async getFile() {
        if (self.failReads.has(p)) throw Object.assign(new Error("injected read failure"), { name: "UnknownError" });
        const data = self.files.get(p) ?? self.notFound();
        const failText = self.failText.has(p);
        return {
          size: data.byteLength,
          lastModified: 0,
          slice(start = 0, end = data.byteLength) {
            const part = data.slice(start, end);
            return { size: part.byteLength, async text() { return textOf(part); } };
          },
          async text() {
            if (failText) throw new Error("fictional read error");
            return textOf(data);
          },
          async arrayBuffer() {
            return data.slice().buffer;
          },
        };
      },
      async createWritable() {
        if (self.failWrites.has(p)) throw new Error("injected write failure");
        let buffer = new Uint8Array(0);
        const partial = self.partialWrites.has(p);
        return {
          async write(d: string | Uint8Array) { buffer = typeof d === "string" ? bytes(d) : new Uint8Array(d); },
          async close() {
            self.put(p, partial ? buffer.slice(0, Math.floor(buffer.byteLength / 2)) : buffer);
            self.written.push(p);
          },
          async abort() { /* nothing written */ },
        };
      },
    });
    return {
      kind: "directory",
      name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const p = join(name);
        if (!self.dirs.has(p)) {
          if (!options?.create) self.notFound();
          self.dirs.add(p);
        }
        return self.dir(p);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const p = join(name);
        if (!self.files.has(p)) {
          if (!options?.create) self.notFound();
          self.put(p, new Uint8Array(0));
        }
        return fileHandle(p);
      },
      async *entries() {
        const children = new Map<string, "file" | "directory">();
        for (const d of self.dirs) {
          if (d !== prefix && d.startsWith(prefix ? prefix + "/" : "") && !d.slice(prefix ? prefix.length + 1 : 0).includes("/")) children.set(d.split("/").pop()!, "directory");
        }
        for (const f of self.files.keys()) {
          if (f.startsWith(prefix ? prefix + "/" : "") && !f.slice(prefix ? prefix.length + 1 : 0).includes("/")) children.set(f.split("/").pop()!, "file");
        }
        for (const [name, kind] of children) yield [name, kind === "file" ? fileHandle(join(name)) : self.dir(join(name))];
      },
    } as unknown as FileSystemDirectoryHandle;
  }
}

async function runLightCheck(v: MemVault) {
  const root = v.dir();
  const discovery = await vault.performVaultLightCheckDiscovery(root);
  return vault.classifyVaultLightCheckCandidates(root, discovery);
}

/**
 * 指定キーのbucketに「在るが空」のshardを置く。Registryが一切無い状態では、
 * 軽量チェックは設計上すべての追加候補を registry-unconfirmed（未確認）へ
 * fail-closed させるため、「Registryは確認できるが、そのキーは未登録」という
 * 状態を再現するには空shardの存在が必要。
 */
function emptyShardFilesFor(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const bucket = vault.vaultRegistryBucketOf(key);
    out[`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`] = JSON.stringify({ schemaVersion: 1, bucket, records: {}, files: {} });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recovery走査用の読み取り専用Vault（vaultRecovery.test.tsと同じ形）
// ---------------------------------------------------------------------------

class ReadOnlyVault {
  files: Record<string, string>;
  failures = new Map<string, string>();
  mutations = 0;
  constructor(files: Record<string, string> = {}) { this.files = { ...files }; }
  error(name: string): never { throw new DOMException("redacted", name); }
  forbid = (): never => { this.mutations++; throw new Error("WRITE FORBIDDEN"); };
  dir(prefix = ""): FileSystemDirectoryHandle {
    const self = this;
    return {
      kind: "directory", name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        assert.equal(options?.create, false); const p = prefix ? `${prefix}/${name}` : name;
        if (self.failures.has(p)) self.error(self.failures.get(p)!);
        if (!Object.keys(self.files).some((k) => k.startsWith(p + "/"))) self.error("NotFoundError");
        return self.dir(p);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        assert.equal(options?.create, false); const p = prefix ? `${prefix}/${name}` : name;
        if (self.failures.has(p)) self.error(self.failures.get(p)!);
        if (!(p in self.files)) self.error("NotFoundError"); return self.file(p);
      },
      async *entries() {
        const children = new Map<string, "directory" | "file">();
        for (const p of Object.keys(self.files)) {
          if (prefix && !p.startsWith(prefix + "/")) continue;
          const relative = prefix ? p.slice(prefix.length + 1) : p;
          children.set(relative.split("/")[0], relative.includes("/") ? "directory" : "file");
        }
        for (const [name, kind] of children) {
          const p = prefix ? `${prefix}/${name}` : name;
          yield [name, kind === "directory" ? self.dir(p) : self.file(p)];
        }
      },
      removeEntry: self.forbid,
    } as unknown as FileSystemDirectoryHandle;
  }
  file(p: string): FileSystemFileHandle {
    const self = this;
    return { kind: "file", name: p.split("/").pop(), createWritable: self.forbid, createSyncAccessHandle: self.forbid,
      async getFile() {
        if (self.failures.has(`${p}:getFile`)) self.error(self.failures.get(`${p}:getFile`)!);
        return { size: self.files[p].length, lastModified: 1, async text() {
          if (self.failures.has(`${p}:text`)) self.error(self.failures.get(`${p}:text`)!);
          return self.files[p];
        } };
      },
    } as unknown as FileSystemFileHandle;
  }
}

async function plan(v: ReadOnlyVault, s: RecoveryLocalSnapshot) {
  const result = await recovery.buildVaultRecoveryPlan(v.dir(), s);
  assert.equal(v.mutations, 0);
  return result;
}

// ---------------------------------------------------------------------------
// A-06：Conversationのturn分裂・発言者変質
// ---------------------------------------------------------------------------

const MARKER_TURNS: Conversation["turns"] = [
  { role: "user", content: "質問です\n**Tsumugi:** これは私の発言ではありません\n以上です", timestamp: T },
  { role: "ai", content: "回答です\n**User:** 偽の発言として貼られた行\n終わり", timestamp: T2 },
];

test("A-06: marker-like lines inside turn bodies round-trip without splitting or re-attribution", () => {
  const c = conversation("c-marker", MARKER_TURNS);
  const md = markdown.conversationToMarkdown(c);
  const parsed = markdown.parseConversationMarkdown(md);
  assert.ok(parsed);
  assert.equal(parsed.turns.length, 2);
  assert.deepEqual(
    parsed.turns.map((t) => ({ role: t.role, content: t.content })),
    MARKER_TURNS.map((t) => ({ role: t.role, content: t.content })),
  );
  // 往復が安定する：parse後の形を再serialize→再parseしてもturnは同一で、
  // Markdown自体もそこで固定点に達する（parserが補うsourceType等の従来仕様は除く）。
  const md2 = markdown.conversationToMarkdown(parsed);
  const reparsed = markdown.parseConversationMarkdown(md2);
  assert.ok(reparsed);
  assert.deepEqual(
    reparsed.turns.map((t) => ({ role: t.role, content: t.content })),
    MARKER_TURNS.map((t) => ({ role: t.role, content: t.content })),
  );
  assert.equal(markdown.conversationToMarkdown(reparsed), md2);
});

test("A-06: conversations without marker-like lines serialize exactly as before (no escapes added)", () => {
  const c = conversation("c-plain");
  const md = markdown.conversationToMarkdown(c);
  assert.ok(!md.includes("\\**"), "no escape characters are introduced for ordinary content");
  const parsed = markdown.parseConversationMarkdown(md);
  assert.deepEqual(parsed?.turns.map((t) => ({ role: t.role, content: t.content })), [{ role: "user", content: "架空の会話です" }]);
});

test("A-06: a legacy (pre-escape) file with plain turns parses exactly as before", () => {
  const legacy = [
    "---", "id: c-legacy", "tsumugi: true", "persona: companion", "status: captured",
    `startedAt: ${T}`, `createdAt: ${T}`, `updatedAt: ${T}`, "---", "",
    `# Conversation 2026-10-20`, "", "## Transcript", "",
    "**User:** 昔の形式の発言です", "", "**Tsumugi:** 昔の形式の応答です", "",
  ].join("\n");
  const parsed = markdown.parseConversationMarkdown(legacy);
  assert.ok(parsed);
  assert.deepEqual(parsed.turns.map((t) => ({ role: t.role, content: t.content })), [
    { role: "user", content: "昔の形式の発言です" },
    { role: "ai", content: "昔の形式の応答です" },
  ]);
});

test("A-06 integration: the restore scan returns the marker conversation with its original turns", async () => {
  const c = conversation("c-marker", MARKER_TURNS);
  const v = new MemVault({ "Conversations/c.md": markdown.conversationToMarkdown(c) });
  const scan = await vault.scanVaultForRestore(v.dir());
  assert.equal(scan.conversations.length, 1);
  assert.deepEqual(
    scan.conversations[0].turns.map((t) => ({ role: t.role, content: t.content })),
    MARKER_TURNS.map((t) => ({ role: t.role, content: t.content })),
  );
});

// ---------------------------------------------------------------------------
// A-06深掘り：旧形式ファイルの後方互換（読むだけで保存済み本文が変わらないこと）
// ---------------------------------------------------------------------------

/** 旧形式（escapeも `transcriptFormat` マーカーも無い）Conversation Markdownを組み立てる。 */
function legacyConversationMd(id: string, turns: { role: "User" | "Tsumugi"; content: string }[]): string {
  return [
    "---", `id: ${id}`, "tsumugi: true", "persona: companion", "status: captured",
    `startedAt: ${T}`, `createdAt: ${T}`, `updatedAt: ${T}`, "---", "",
    "# Conversation 2026-10-20", "", "## Transcript", "",
    turns.map((t) => `**${t.role}:** ${t.content}`).join("\n\n"), "",
  ].join("\n");
}

// 旧形式の利用者本文そのもの：バックスラッシュで始まるマーカーそっくりの行を含む。
const LEGACY_USER_CONTENT = "引用します\n\\**Tsumugi:** これは引用行です\n以上です";
const LEGACY_AI_CONTENT = "了解です\n\\**User:** こちらも引用\n\\\\**Tsumugi:** 二重バックスラッシュの引用\n終わりです";
const legacyEscapeLikeMd = (id: string) =>
  legacyConversationMd(id, [
    { role: "User", content: LEGACY_USER_CONTENT },
    { role: "Tsumugi", content: LEGACY_AI_CONTENT },
  ]);

test("A-06 compat: a legacy file's backslash marker-like lines are read verbatim — reading never mutates saved body text", () => {
  const parsed = markdown.parseConversationMarkdown(legacyEscapeLikeMd("c-legacy-bs"));
  assert.ok(parsed);
  assert.deepEqual(parsed.turns.map((t) => ({ role: t.role, content: t.content })), [
    { role: "user", content: LEGACY_USER_CONTENT },
    { role: "ai", content: LEGACY_AI_CONTENT },
  ]);
});

test("A-06 compat: an unknown transcriptFormat value is treated as legacy (fail-closed, never guessed)", () => {
  const unknown = legacyEscapeLikeMd("c-legacy-bs").replace("---\n\n# Conversation", "transcriptFormat: 99\n---\n\n# Conversation");
  const parsed = markdown.parseConversationMarkdown(unknown);
  assert.ok(parsed);
  assert.deepEqual(parsed.turns.map((t) => t.content), [LEGACY_USER_CONTENT, LEGACY_AI_CONTENT]);
});

test("A-06 compat: legacy → save upgrades the format marker and preserves the body exactly; the upgraded form is a fixpoint", () => {
  const parsed = markdown.parseConversationMarkdown(legacyEscapeLikeMd("c-legacy-bs"));
  assert.ok(parsed);
  const upgraded = markdown.conversationToMarkdown(parsed);
  assert.ok(upgraded.includes("transcriptFormat: 2"), "saving a legacy conversation writes the new-format marker");
  const reparsed = markdown.parseConversationMarkdown(upgraded);
  assert.ok(reparsed);
  assert.deepEqual(reparsed.turns.map((t) => t.content), [LEGACY_USER_CONTENT, LEGACY_AI_CONTENT]);
  // 固定点：その後の保存・読み戻しでは本文もMarkdownも変わらない。
  assert.equal(markdown.conversationToMarkdown(reparsed), upgraded);
  const third = markdown.parseConversationMarkdown(markdown.conversationToMarkdown(reparsed));
  assert.deepEqual(third?.turns.map((t) => t.content), [LEGACY_USER_CONTENT, LEGACY_AI_CONTENT]);
});

const ESCAPE_LIKE_TURNS: Conversation["turns"] = [
  { role: "user", content: "先頭は普通の行\n**User:** 区切りそっくり行\n\\**User:** バックスラッシュ付き\n\\\\**Tsumugi:** 二重バックスラッシュ\n終わり", timestamp: T },
  { role: "ai", content: "\\**Tsumugi:** 先頭行自体がバックスラッシュ付き\n通常の二行目", timestamp: T2 },
];

test("A-06 compat: new-format escape-like content survives repeated save/load cycles unchanged (LF and CRLF)", () => {
  let current: Conversation | null = conversation("c-escape-like", ESCAPE_LIKE_TURNS);
  for (let cycle = 0; cycle < 3; cycle++) {
    const md = markdown.conversationToMarkdown(current);
    if (cycle === 0) assert.ok(md.includes("transcriptFormat: 2"), "new saves carry the format marker");
    current = markdown.parseConversationMarkdown(md);
    assert.ok(current);
    assert.deepEqual(
      current.turns.map((t) => ({ role: t.role, content: t.content })),
      ESCAPE_LIKE_TURNS.map((t) => ({ role: t.role, content: t.content })),
    );
    // CRLFで保存された同内容も同一に読み取れる。
    const crlfParsed = markdown.parseConversationMarkdown(crlf(md));
    assert.deepEqual(
      crlfParsed?.turns.map((t) => ({ role: t.role, content: t.content })),
      ESCAPE_LIKE_TURNS.map((t) => ({ role: t.role, content: t.content })),
    );
  }
});

test("A-06 compat: a CRLF legacy file's backslash lines are also read verbatim", () => {
  const parsed = markdown.parseConversationMarkdown(crlf(legacyEscapeLikeMd("c-legacy-bs")));
  assert.deepEqual(parsed?.turns.map((t) => t.content), [LEGACY_USER_CONTENT, LEGACY_AI_CONTENT]);
});

test("A-06 compat integration: legacy and new-format conversations coexist in one vault — each is read by its own format", async () => {
  const v = new MemVault({
    "Conversations/legacy.md": legacyEscapeLikeMd("c-legacy-bs"),
    "Conversations/fresh.md": markdown.conversationToMarkdown(conversation("c-escape-like", ESCAPE_LIKE_TURNS)),
  });
  const scan = await vault.scanVaultForRestore(v.dir());
  const byId = new Map(scan.conversations.map((c) => [c.id, c]));
  assert.deepEqual(byId.get("c-legacy-bs")?.turns.map((t) => t.content), [LEGACY_USER_CONTENT, LEGACY_AI_CONTENT]);
  assert.deepEqual(byId.get("c-escape-like")?.turns.map((t) => t.content), ESCAPE_LIKE_TURNS.map((t) => t.content));
});

// ---------------------------------------------------------------------------
// A-06 guard（PR #68 Codex [P2]）：旧形式transcriptの無損失アップグレードと再書き込みガード
// 旧形式ファイルに `\**Tsumugi:** ` のような継続行があると、新形式serializerの
// escapeで登録ハッシュが一致しなくなり、turnの追記だけでも
// `singleFileRewriteIsSafe` が拒否して、その会話のOutbox保存が止まっていた。
// 修正前（head d06d779）では下の「受け入れる」系テストがすべて失敗し、
// 「拒否する」系は修正前後とも拒否のままであることを確認済み。
// ---------------------------------------------------------------------------

/** A-06以前のserializerが出力した形：現行の直列化から `transcriptFormat` 行を取り除き、transcriptの継続行のescapeを1段だけ戻したもの（frontmatterの引用形・turnTimes等は現行と同一）。 */
function toLegacyForm(newMd: string): string {
  const withoutMarker = newMd.replace("transcriptFormat: 2\n", "");
  const marker = "## Transcript\n\n";
  const at = withoutMarker.indexOf(marker);
  const head = withoutMarker.slice(0, at + marker.length);
  let inTurn = false;
  const lines = withoutMarker
    .slice(at + marker.length)
    .split("\n")
    .map((line) => {
      if (line.startsWith("**User:** ") || line.startsWith("**Tsumugi:** ")) {
        inTurn = true;
        return line;
      }
      if (inTurn && /^\\+\*\*(?:User|Tsumugi):\*\*/.test(line)) return line.slice(1);
      return line;
    });
  return head + lines.join("\n");
}

const GUARD_TURNS: Conversation["turns"] = [
  { role: "user", content: LEGACY_USER_CONTENT, timestamp: T },
  { role: "ai", content: LEGACY_AI_CONTENT, timestamp: T },
];
const guardLegacyMd = () => toLegacyForm(markdown.conversationToMarkdown(conversation("c-guard", GUARD_TURNS)));
const guardAppended = (base: Conversation): Conversation => ({
  ...base,
  turns: [...base.turns, { role: "ai", content: "追記された応答です", timestamp: T2 }],
  updatedAt: T2,
});
/** `decideMarkdown`（vaultProjection）と同じ配線でガードを呼ぶ：hashは生の `hashVaultText`、reserializedは現在のファイルをparseして書き直した内容。 */
const guardCall = (current: string, canonical: Conversation, registeredHash: unknown): boolean => {
  const parsed = markdown.parseConversationMarkdown(current);
  assert.ok(parsed);
  return safety.singleFileRewriteIsSafe(current, markdown.conversationToMarkdown(canonical), {
    hash: vault.hashVaultText,
    registeredHash,
    evolvingKeys: safety.CONVERSATION_EVOLVING_KEYS,
    body: "extends",
    reserialized: markdown.conversationToMarkdown(parsed),
  });
};

test("A-06 guard: a registered legacy file accepts an append-only save (LF)", () => {
  const current = guardLegacyMd();
  const parsed = markdown.parseConversationMarkdown(current);
  assert.ok(parsed);
  assert.deepEqual(parsed.turns.map((t) => t.content), [LEGACY_USER_CONTENT, LEGACY_AI_CONTENT], "前提：旧形式は本文をそのまま読む");
  const canonical = guardAppended(parsed);
  assert.equal(guardCall(current, canonical, vault.hashVaultText(current)), true, "登録ハッシュが一致し変更が追記だけなら、形式アップグレードを理由に拒否しない");
  // 書き込まれる内容は、旧turnの本文・発言者・順序を正確に保ち、追記turnが末尾に付く。
  const written = markdown.parseConversationMarkdown(markdown.conversationToMarkdown(canonical));
  assert.deepEqual(written?.turns.map((t) => ({ role: t.role, content: t.content })), [
    { role: "user", content: LEGACY_USER_CONTENT },
    { role: "ai", content: LEGACY_AI_CONTENT },
    { role: "ai", content: "追記された応答です" },
  ]);
});

test("A-06 guard: a registered legacy file accepts an append-only save (CRLF)", () => {
  const lf = guardLegacyMd();
  const current = crlf(lf);
  const parsed = markdown.parseConversationMarkdown(current);
  assert.ok(parsed);
  // resyncが登録するハッシュはLF正規化形（分類側の規則）。decideMarkdownのhashは生テキスト側。
  assert.equal(guardCall(current, guardAppended(parsed), vault.hashVaultText(lf)), true, "CRLFでもLFと同一に受け入れる");
});

test("A-06 guard: an unregistered legacy file accepts an append-only save", () => {
  const current = guardLegacyMd();
  const parsed = markdown.parseConversationMarkdown(current);
  assert.ok(parsed);
  assert.equal(guardCall(current, guardAppended(parsed), undefined), true, "登録ハッシュが無くても、内容がすべて残る追記は拒否しない");
});

test("A-06 guard: a genuine external edit of body text is still refused", () => {
  const original = guardLegacyMd();
  const edited = original.replace("以上です", "書き換えられた結び");
  const canonical = guardAppended(markdown.parseConversationMarkdown(original) as Conversation);
  assert.equal(guardCall(edited, canonical, vault.hashVaultText(original)), false, "外部編集された本文を、追記の保存で上書きしてはならない");
});

test("A-06 guard: a genuine external edit of the marker-like line itself is still refused", () => {
  const original = guardLegacyMd();
  const edited = original.replace("\\**Tsumugi:** これは引用行です", "\\**Tsumugi:** 書き換えられた引用行");
  assert.notEqual(edited, original, "前提：対象の行が実際に書き換わっている");
  const canonical = guardAppended(markdown.parseConversationMarkdown(original) as Conversation);
  assert.equal(guardCall(edited, canonical, vault.hashVaultText(original)), false, "アップグレード変換が触れる行そのものの編集も、変換でごまかされず検出される");
});

test("A-06 guard: a hand-added frontmatter line is still refused even when the edited file itself is registered", () => {
  const foreign = guardLegacyMd().replace("persona: companion", "persona: companion\nhandNote: 手で足した項目");
  const canonical = guardAppended(markdown.parseConversationMarkdown(guardLegacyMd()) as Conversation);
  assert.equal(guardCall(foreign, canonical, vault.hashVaultText(foreign)), false, "parseで落ちる知らない項目を含むファイルは、登録済みでも書き換えない");
});

test("A-06 guard: hand-added text before the transcript is still refused", () => {
  const foreign = guardLegacyMd().replace("## Transcript", "手で足した段落\n\n## Transcript");
  const canonical = guardAppended(markdown.parseConversationMarkdown(guardLegacyMd()) as Conversation);
  assert.equal(guardCall(foreign, canonical, vault.hashVaultText(foreign)), false, "transcript外の手書きはアップグレード変換の対象外であり、失われる書き換えは拒否する");
});

test("A-06 guard: new-format files keep their existing behavior (append accepted, edit refused)", () => {
  const marked = markdown.conversationToMarkdown(conversation("c-guard-new", GUARD_TURNS));
  const parsed = markdown.parseConversationMarkdown(marked);
  assert.ok(parsed);
  assert.equal(guardCall(marked, guardAppended(parsed), vault.hashVaultText(marked)), true);
  const edited = marked.replace("以上です", "書き換えられた結び");
  assert.equal(guardCall(edited, guardAppended(parsed), vault.hashVaultText(marked)), false);
});

test("A-06 guard: legacyTranscriptUpgradeForm only bridges the format upgrade, nothing else", () => {
  const current = guardLegacyMd();
  const upgraded = markdown.legacyTranscriptUpgradeForm(current);
  assert.ok(upgraded, "旧形式＋escapeが要る行がある場合はアップグレード形を返す");
  assert.ok(upgraded.includes("\\\\**Tsumugi:** これは引用行です"), "継続行へ \\ が1つだけ足される");
  assert.equal(toLegacyForm(upgraded), current, "escapeを1段戻すと元の旧形式に正確に戻る（変換はそれ以外を変えない）");
  assert.equal(markdown.legacyTranscriptUpgradeForm(markdown.conversationToMarkdown(conversation("c-guard-new", GUARD_TURNS))), null, "新形式ファイルには適用しない");
  assert.equal(markdown.legacyTranscriptUpgradeForm(legacyConversationMd("c-plain-guard", [{ role: "User", content: "普通の発言です" }])), null, "escapeが要る行が無い旧形式には適用しない");
  assert.equal(markdown.legacyTranscriptUpgradeForm(markdown.memoryObjectToMarkdown(memory("m-guard"))), null, "Conversationでないファイルには適用しない");
});

// ---------------------------------------------------------------------------
// N-3（PR #68 Codex [P2]、ラウンド7）：再書き込みガードの「登録済み版」判定が、
// 呼び出し側から渡される生ハッシュでCRLFの現在ファイルを計算していたため、
// Registryの正規化規則（LF正規化形のハッシュ）で登録されたCRLFファイルは
// 登録分岐に一致せず、日記挿入のようにフォールバック（本文の接頭辞拡張）でも
// 救えない保存が markdown-edited-conflict で止まっていた。
// 修正前（head 41650232）では下の「受け入れる」系（CRLF）が失敗し、
// 「拒否する」系とLFの双子は修正前後とも同じ結果であることを確認済み。
// ---------------------------------------------------------------------------

const DIARY_DATE = "2026-10-20";
const diaryBase = (): Conversation => ({
  ...conversation("c-diary-guard", [
    { role: "user", content: "今日の出来事を話します", timestamp: T },
    { role: "ai", content: "聞かせてください", timestamp: T },
  ]),
  realtimeDiary: { date: DIARY_DATE },
});
const diaryInserted = (base: Conversation): Conversation => ({
  ...base,
  realtimeDiary: { date: DIARY_DATE, text: "架空の日記本文です", writtenAt: T2 },
  updatedAt: T2,
});
/** `decideMarkdown`（vaultProjection）と同じ配線でガードを呼ぶ：hashは生の `hashVaultText`、registeredHashはresync分類が登録するLF正規化形のハッシュ。 */
const diaryGuardCall = (current: string, canonical: Conversation, registeredHash: unknown): boolean => {
  const parsed = markdown.parseConversationMarkdown(current);
  assert.ok(parsed);
  return safety.singleFileRewriteIsSafe(current, markdown.conversationToMarkdown(canonical), {
    hash: vault.hashVaultText,
    registeredHash,
    evolvingKeys: safety.CONVERSATION_EVOLVING_KEYS,
    body: "extends",
    reserialized: markdown.conversationToMarkdown(parsed),
  });
};

test("N-3 branch analysis: why each guard branch fails for a CRLF diary-insert save", () => {
  const base = diaryBase();
  const lfCurrent = markdown.conversationToMarkdown(base);
  const current = crlf(lfCurrent);
  const canonical = diaryInserted(base);
  const next = markdown.conversationToMarkdown(canonical);
  // resync分類（vault.ts processVaultResyncCandidate）が登録する形：LF正規化形のハッシュ。
  const registered = vault.hashVaultText(lfCurrent);
  // 登録分岐のハッシュ比較：生ハッシュは登録値と一致しない（登録分岐が失敗する直接原因）。
  assert.notEqual(vault.hashVaultText(current), registered, "生ハッシュ≠登録ハッシュ");
  assert.equal(vault.hashVaultText(current.replace(/\r\n/g, "\n")), registered, "正規化ハッシュ＝登録ハッシュ");
  // フォールバック分岐：日記節の挿入（## Diaryが## Transcriptの前）だけが接頭辞拡張にならない。
  assert.equal(safety.rewriteKeepsContent(current, next, safety.CONVERSATION_EVOLVING_KEYS, "extends"), false, "日記挿入つきのnextはフォールバックでも救えない");
  const withoutDiary = markdown.conversationToMarkdown({ ...canonical, realtimeDiary: { date: DIARY_DATE } });
  assert.equal(safety.rewriteKeepsContent(current, withoutDiary, safety.CONVERSATION_EVOLVING_KEYS, "extends"), true, "日記本文が無ければ同じ更新はフォールバックで通る＝失敗要因は日記挿入の本文形状だけ");
  // アップグレード分岐：新形式ファイルには適用されない。
  assert.equal(markdown.legacyTranscriptUpgradeForm(current), null, "新形式ファイルに旧形式アップグレード分岐は無い");
});

test("N-3 guard: a CRLF realtime-diary conversation accepts a diary-insert save", () => {
  const base = diaryBase();
  const lfCurrent = markdown.conversationToMarkdown(base);
  const current = crlf(lfCurrent);
  assert.equal(diaryGuardCall(current, diaryInserted(base), vault.hashVaultText(lfCurrent)), true, "登録済み版（CRLF）への日記挿入は、登録分岐で受け入れる");
  // 書き込まれる内容は、既存turnと日記本文を正確に保つ。
  const written = markdown.parseConversationMarkdown(markdown.conversationToMarkdown(diaryInserted(base)));
  assert.deepEqual(written?.turns.map((t) => t.content), ["今日の出来事を話します", "聞かせてください"]);
  assert.equal(written?.realtimeDiary?.text, "架空の日記本文です");
});

test("N-3 guard: the LF twin accepts the same diary-insert save", () => {
  const base = diaryBase();
  const lfCurrent = markdown.conversationToMarkdown(base);
  assert.equal(diaryGuardCall(lfCurrent, diaryInserted(base), vault.hashVaultText(lfCurrent)), true);
});

test("N-3 guard: a CRLF file with a genuine external edit is still refused (the diary insert does not launder it)", () => {
  const base = diaryBase();
  const lfCurrent = markdown.conversationToMarkdown(base);
  const edited = crlf(lfCurrent).replace("今日の出来事を話します", "外部で書き換えられた発言");
  assert.notEqual(edited, crlf(lfCurrent), "前提：対象の発言が実際に書き換わっている");
  assert.equal(diaryGuardCall(edited, diaryInserted(base), vault.hashVaultText(lfCurrent)), false, "外部編集されたファイルは、正規化しても登録版とは一致せず拒否される");
});

test("N-3 guard: hand-added text in a CRLF file is still refused even when that file itself is registered", () => {
  const base = diaryBase();
  const lfCurrent = markdown.conversationToMarkdown(base);
  const foreignLf = lfCurrent.replace("## Transcript", "手で足した段落\n\n## Transcript");
  const foreign = crlf(foreignLf);
  // 手書き入りのファイル自体が登録済みでも、parse→再直列化で落ちる手書きは失われる書き換えとして拒否する
  // （登録分岐のもう一方の条件 serializedKeepsEverything が効くことの確認）。
  assert.equal(diaryGuardCall(foreign, diaryInserted(base), vault.hashVaultText(foreignLf)), false, "手書きを含むファイルは、登録済みでも日記挿入の保存で上書きしない");
});

test("N-3 guard: the single-record wiring (body: \"same\", MEMORY_EVOLVING_KEYS) shares the same registered-version judgment", () => {
  const s = source("s-diary-guard");
  const lfCurrent = markdown.sourceToMarkdown(s);
  const current = crlf(lfCurrent);
  const retitled = { ...s, title: "書き換え後のタイトル", updatedAt: T2 } as typeof s;
  const parsed = markdown.parseSourceMarkdown(current);
  const ok = safety.singleFileRewriteIsSafe(current, markdown.sourceToMarkdown(retitled), {
    hash: vault.hashVaultText,
    registeredHash: vault.hashVaultText(lfCurrent),
    evolvingKeys: safety.MEMORY_EVOLVING_KEYS,
    body: "same",
    reserialized: markdown.sourceToMarkdown(parsed),
  });
  assert.equal(ok, true, "登録済み版そのもの（CRLF）からの置き換えは、単一記録側の配線でも登録分岐で受け入れる");
});

// ---------------------------------------------------------------------------
// A-02：Conversation等のCRLF非対応
// ---------------------------------------------------------------------------

test("A-02: CRLF files parse identically to their LF form (conversation and day-file)", () => {
  const c = conversation();
  const lfParsed = markdown.parseConversationMarkdown(markdown.conversationToMarkdown(c));
  const crlfParsed = markdown.parseConversationMarkdown(crlf(markdown.conversationToMarkdown(c)));
  assert.ok(lfParsed && crlfParsed);
  assert.deepEqual(
    crlfParsed.turns.map((t) => ({ role: t.role, content: t.content })),
    lfParsed.turns.map((t) => ({ role: t.role, content: t.content })),
  );
  const day = markdown.serializeMemoryDayFile([memory("m1"), memory("m2")]);
  assert.deepEqual(markdown.parseMemoryDayFile(crlf(day)).map((m) => m.id), ["m1", "m2"]);
});

test("A-02: the restore scan finds CRLF files — they do not vanish and are not skipped", async () => {
  const v = new MemVault({
    "Conversations/c.md": crlf(markdown.conversationToMarkdown(conversation())),
    "Memories/2026-10-20.md": crlf(markdown.serializeMemoryDayFile([memory("m1"), memory("m2")])),
  });
  const scan = await vault.scanVaultForRestore(v.dir());
  assert.deepEqual(scan.conversations.map((c) => c.id), ["c1"]);
  assert.deepEqual(scan.memoryObjects.map((m) => m.id).sort(), ["m1", "m2"]);
  assert.equal(scan.skippedCount, 0);
  assert.equal(scan.droppedEntryCount, 0);
});

test("A-02: light-check classifies a CRLF conversation as a record (added), never unreadable, never ignored", async () => {
  const v = new MemVault({ "Conversations/c.md": crlf(markdown.conversationToMarkdown(conversation())), ...emptyShardFilesFor(["c1"]) });
  const result = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 0);
  const record = result.records.find((r) => r.registryKey === "c1");
  assert.ok(record, "the CRLF conversation must be classified as a record");
  assert.equal(record.outcome, "added");
});

test("A-02 integration: a CRLF conversation is equivalent-existing in the Recovery plan, with no issue", async () => {
  const c = conversation();
  const p = await plan(new ReadOnlyVault({ "Conversations/c.md": crlf(markdown.conversationToMarkdown(c)) }), local([c]));
  assert.deepEqual(p.issues, []);
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].classification, "equivalent-existing");
});

test("A-02 regression (Codex P2): an unchanged CRLF duplicate conflict passes revalidation and is recorded in the Registry", async () => {
  const dup = crlf(markdown.conversationToMarkdown(conversation("c-dup")));
  const v = new MemVault({
    "Conversations/a.md": dup,
    "Conversations/b.md": dup,
    ...emptyShardFilesFor(["c-dup"]),
  });
  const root = v.dir();
  await prepareResyncWorld();
  const light = await runLightCheck(v);
  const record = light.records.find((r) => r.registryKey === "c-dup");
  assert.ok(record, "the duplicate is classified");
  assert.equal(record.outcome, "conflict");
  assert.deepEqual([...(record.allObservedPaths ?? [])].sort(), ["Conversations/a.md", "Conversations/b.md"]);
  const outcome = await vault.applyVaultLightCheckCandidates(root, light.records, light.localSnapshots);
  assert.equal(outcome.timedOut, false);
  // 修正前は、再検証側だけが生テキストのハッシュを取るため、無変更のCRLF
  // duplicateが常時 conflict-changed としてskipされ、Registryへ記録されなかった。
  assert.deepEqual(outcome.staleSkipped, []);
  assert.equal(outcome.counts.conflict, 1);
  // conflictがRegistryへ記録される（anchor＝観測pathの辞書順最小へ、status "conflict"）。
  const shard = await vault.readVaultRegistryShard(root, vault.vaultRegistryBucketOf("c-dup"));
  assert.equal(shard.records["c-dup"], "Conversations/a.md");
  assert.equal(shard.files["Conversations/a.md"]?.status, "conflict");
});

// ---------------------------------------------------------------------------
// A-02 ラウンド3（Codex [P2]）：write前検証（verifyVaultRegistryEntryBeforeWrite）
// のハッシュ正規化。分類側が登録する基準ハッシュはLF正規化済みテキストのもの
// なのに、検証側が生テキストをハッシュすると、mtime/sizeのメタデータだけが
// ずれた無変更のCRLFファイルが常時「変わった」と誤判定され、保存が繰り返し
// 拒否される。検証側も同じ正規化規則で比較しなければならない。逆に、本当に
// 本文が変わったファイルはCRLFでも従来どおり拒否されなければならない
// （検出を弱めない）。
// ---------------------------------------------------------------------------

/** Registryに「status ok」のentryを直接種付けする（分類が登録した状態の再現）。 */
function seedRegistryEntry(
  v: MemVault,
  registryKey: string,
  path: string,
  entry: { recordType: string; mtime: number; size: number; contentHash: string; memberIds: string[]; memberHashes?: Record<string, string> },
): void {
  const bucket = vault.vaultRegistryBucketOf(registryKey);
  const shard = {
    schemaVersion: 1,
    bucket,
    records: { [registryKey]: path },
    files: { [path]: { ...entry, status: "ok" } },
  };
  v.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, bytes(JSON.stringify(shard)));
}

test("A-02 round3 (Codex P2): an unchanged CRLF conversation with only metadata drift is not refused on save", async () => {
  await prepareResyncWorld();
  const conv = conversation("c-crlf-verify");
  const lfText = markdown.conversationToMarkdown(conv);
  const path = `Conversations/${vault.fileNameFor(conv.id, conv.startedAt)}`;
  const v = new MemVault({ [path]: crlf(lfText) });
  // 基準は分類側の登録どおり：LF正規化済みハッシュ＋LFサイズ。実ファイルは
  // CRLF版（サイズが大きい）で、mtimeもentryの値とずれている＝メタデータ
  // だけの差。この状態で保存が通らなければならない（修正前は常時拒否）。
  seedRegistryEntry(v, conv.id, path, {
    recordType: "conversation",
    mtime: 12345,
    size: bytes(lfText).length,
    contentHash: vault.hashVaultText(lfText),
    memberIds: [conv.id],
  });
  const updated: Conversation = { ...conv, updatedAt: T2 };
  await vault.writeConversationMarkdown(v.dir(), updated);
  assert.equal(v.text(path), markdown.conversationToMarkdown(updated));
  const shard = await vault.readVaultRegistryShard(v.dir(), vault.vaultRegistryBucketOf(conv.id));
  assert.equal(shard.files[path]?.status, "ok");
  assert.equal(shard.files[path]?.contentHash, vault.hashVaultText(markdown.conversationToMarkdown(updated)));
});

test("A-02 round3: a genuinely edited CRLF conversation is still refused — conflict detection is not weakened", async () => {
  await prepareResyncWorld();
  const conv = conversation("c-crlf-edited");
  const lfText = markdown.conversationToMarkdown(conv);
  const editedLf = markdown.conversationToMarkdown({
    ...conv,
    turns: [...conv.turns, { role: "user", content: "外部で書き換えられた架空の行", timestamp: T }],
  });
  const path = `Conversations/${vault.fileNameFor(conv.id, conv.startedAt)}`;
  const v = new MemVault({ [path]: crlf(editedLf) });
  seedRegistryEntry(v, conv.id, path, {
    recordType: "conversation",
    mtime: 12345,
    size: bytes(lfText).length,
    contentHash: vault.hashVaultText(lfText),
    memberIds: [conv.id],
  });
  await assert.rejects(
    vault.writeConversationMarkdown(v.dir(), conv),
    (e: unknown) => e instanceof vault.VaultRecordNeedsResyncError,
  );
  // ファイルは1バイトも変えず、状態はneeds-resyncとして表面化する（無言でない）。
  assert.equal(v.text(path), crlf(editedLf));
  const shard = await vault.readVaultRegistryShard(v.dir(), vault.vaultRegistryBucketOf(conv.id));
  assert.equal(shard.files[path]?.status, "needs-resync");
});

test("A-02 round3: an unchanged LF conversation with the same metadata drift behaves identically", async () => {
  await prepareResyncWorld();
  const conv = conversation("c-lf-verify");
  const lfText = markdown.conversationToMarkdown(conv);
  const path = `Conversations/${vault.fileNameFor(conv.id, conv.startedAt)}`;
  const v = new MemVault({ [path]: lfText });
  seedRegistryEntry(v, conv.id, path, {
    recordType: "conversation",
    mtime: 12345,
    size: bytes(lfText).length + 7,
    contentHash: vault.hashVaultText(lfText),
    memberIds: [conv.id],
  });
  const updated: Conversation = { ...conv, updatedAt: T2 };
  await vault.writeConversationMarkdown(v.dir(), updated);
  assert.equal(v.text(path), markdown.conversationToMarkdown(updated));
});

test("A-02 round3 integration: a CRLF day-file passes the same pre-write verification — an unchanged member write is a no-op (memory-day path)", async () => {
  await prepareResyncWorld();
  // parserが推定するsourceTypeまで含めて、端末側canonicalとファイル側の版が
  // 一致する形にする（本番の分類がmemberHashesをparse済みmemberから取るのと
  // 同じ前提）。
  const memMeta = { ...meta, sourceType: "chat" };
  const m1: MemoryObject = { ...memory("m-crlf-1"), metadata: { ...memMeta } } as MemoryObject;
  const m2: MemoryObject = { ...memory("m-crlf-2"), metadata: { ...memMeta } } as MemoryObject;
  const day = m1.date.slice(0, 10);
  const lfDay = markdown.serializeMemoryDayFile([m1, m2]);
  const key = vault.dayFileRegistryKey(day);
  const path = `Memories/${vault.dayFileNameFor(m1.date)}`;
  const v = new MemVault({ [path]: crlf(lfDay) });
  // memberHashesは本番の分類と同じく「parse済みmemberの直列化」から取る。
  const parsedSeed = markdown.parseMemoryDayFile(lfDay);
  seedRegistryEntry(v, key, path, {
    recordType: "memory-day",
    mtime: 999,
    size: bytes(lfDay).length,
    contentHash: vault.hashVaultText(lfDay),
    memberIds: [m1.id, m2.id],
    memberHashes: Object.fromEntries(parsedSeed.map((m) => [m.id, vault.hashVaultText(markdown.memoryObjectToMarkdown(m))])),
  });
  // 無変更memberの保存：検証もmerge計画も通り、no-opとしてファイルには
  // 一切触れない（CRLFのバイト列がそのまま残る）。
  await vault.writeMemoryObjectMarkdown(v.dir(), m1);
  assert.equal(v.text(path), crlf(lfDay), "an unchanged member write leaves the CRLF file byte-identical");
  // 内容を変える更新も、CRLFファイルに対してLFと同じく通る（対象memberの
  // 版だけが置き換わり、他memberの内容は保たれる）。
  const updatedM1: MemoryObject = { ...m1, content: "更新された架空の記録 m-crlf-1", summary: "更新された架空の記録 m-crlf-1", updatedAt: T2 };
  await vault.writeMemoryObjectMarkdown(v.dir(), updatedM1);
  const parsed = markdown.parseMemoryDayFile(v.text(path));
  assert.equal(parsed.length, 2, "both members survive the update");
  assert.equal(parsed.find((m) => m.id === m1.id)?.content, updatedM1.content);
  assert.equal(parsed.find((m) => m.id === m2.id)?.content, m2.content);
});

// ---------------------------------------------------------------------------
// A-01：day-file内の破損entryの無言脱落
// ---------------------------------------------------------------------------

const DAY_PATH = "Memories/2026-10-20.md";
const DAY_KEY = "day:2026-10-20";
const healthyDay = () => markdown.serializeMemoryDayFile([memory("m1"), memory("m2")]);
/** 形状A：第2 entryのfrontmatterから `id:` 行が欠落（parse不能だがfrontmatterは閉じている）。 */
const corruptDayA = () => {
  const second = markdown.memoryObjectToMarkdown(memory("m2")).replace("id: m2\n", "");
  return markdown.memoryObjectToMarkdown(memory("m1")) + markdown.MEMORY_ENTRY_SEPARATOR + second;
};
/** 形状B：第2 entryのfrontmatterが閉じないままファイルが終わる（途中切断）。 */
const corruptDayB = () => {
  const second = markdown.memoryObjectToMarkdown(memory("m2"));
  return markdown.memoryObjectToMarkdown(memory("m1")) + markdown.MEMORY_ENTRY_SEPARATOR + second.slice(0, 40);
};

test("A-01: parse diagnostics count dropped entries per shape; healthy entries survive; healthy files drop none", () => {
  for (const [label, text] of [["shape A (missing id)", corruptDayA()], ["shape B (unclosed frontmatter)", corruptDayB()]] as const) {
    const result = markdown.parseMemoryDayFileWithDiagnostics(text);
    assert.deepEqual(result.memories.map((m) => m.id), ["m1"], label);
    assert.equal(result.droppedEntries, 1, label);
  }
  const healthy = markdown.parseMemoryDayFileWithDiagnostics(healthyDay());
  assert.deepEqual(healthy.memories.map((m) => m.id), ["m1", "m2"]);
  assert.equal(healthy.droppedEntries, 0);
  // 従来のparseMemoryDayFileの戻り（読める分だけ返すfail-soft）は変えない。
  assert.deepEqual(markdown.parseMemoryDayFile(corruptDayA()).map((m) => m.id), ["m1"]);
});

test("A-01: the restore scan counts member loss (not a clean restore) and still restores the healthy entries", async () => {
  for (const [label, text] of [["shape A", corruptDayA()], ["shape B", corruptDayB()]] as const) {
    const v = new MemVault({ [DAY_PATH]: text });
    const scan = await vault.scanVaultForRestore(v.dir());
    assert.deepEqual(scan.memoryObjects.map((m) => m.id), ["m1"], label);
    assert.equal(scan.droppedEntryCount, 1, label);
    assert.ok(scan.skippedCount >= 1, `${label}: member loss must be counted, not silently complete`);
  }
});

test("A-01: resync/light-check without a Registry entry classifies a partially corrupt day-file as conflict, not a clean 'added'", async () => {
  for (const [label, text] of [["shape A", corruptDayA()], ["shape B", corruptDayB()]] as const) {
    const v = new MemVault({ [DAY_PATH]: text, ...emptyShardFilesFor([DAY_KEY]) });
    const result = await runLightCheck(v);
    const record = result.records.find((r) => r.registryKey === DAY_KEY);
    assert.ok(record, label);
    assert.equal(record.outcome, "conflict", label);
    assert.match(record.note ?? "", /unreadable/, label);
  }
});

test("A-01: with a Registry previous entry, a member lost to corruption still conflicts via member removal (existing protection kept)", async () => {
  const bucket = vault.vaultRegistryBucketOf(DAY_KEY);
  const shard = {
    schemaVersion: 1, bucket,
    records: { [DAY_KEY]: DAY_PATH },
    files: { [DAY_PATH]: { recordType: "memory-day", mtime: 999, size: 1, contentHash: "deadbeef", memberIds: ["m1", "m2"], memberHashes: {}, status: "ok" } },
  };
  const v = new MemVault({
    [DAY_PATH]: corruptDayA(),
    [`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`]: JSON.stringify(shard),
  });
  const result = await runLightCheck(v);
  const record = result.records.find((r) => r.registryKey === DAY_KEY);
  assert.ok(record);
  assert.equal(record.outcome, "conflict");
});

test("A-01: Recovery observes the healthy members of a partially corrupt day-file and issues the file (shapes A and B)", async () => {
  for (const [label, text] of [["shape A", corruptDayA()], ["shape B", corruptDayB()]] as const) {
    const p = await plan(new ReadOnlyVault({ [DAY_PATH]: text }), local([], [memory("m1")]));
    const issue = p.issues.find((i) => i.path === DAY_PATH);
    assert.ok(issue, `${label}: the corrupt day-file must surface as an issue`);
    assert.equal(issue.status, "invalid", label);
    const record = p.records.find((r) => r.recordId === "m1");
    assert.ok(record, `${label}: the healthy member must stay observed`);
    assert.equal(record.vaultMarkdownExists, true, label);
    assert.equal(record.memoryDay?.memberExists, true, label);
  }
});

test("A-01: the normal day read path surfaces dropped entries instead of silently returning fewer memories", async () => {
  const v = new MemVault({ [DAY_PATH]: corruptDayA() });
  const root = v.dir();
  const diagnosed = await vault.readMemoriesForDayWithDiagnostics(root, "2026-10-20");
  assert.deepEqual(diagnosed.memories.map((m) => m.id), ["m1"]);
  assert.equal(diagnosed.droppedEntries, 1);
  // 既存のreadMemoriesForDayの契約（読める分を返す）はそのまま。
  assert.deepEqual((await vault.readMemoriesForDay(root, "2026-10-20")).map((m) => m.id), ["m1"]);
  const healthy = await vault.readMemoriesForDayWithDiagnostics(new MemVault({ [DAY_PATH]: healthyDay() }).dir(), "2026-10-20");
  assert.equal(healthy.droppedEntries, 0);
  assert.equal(healthy.memories.length, 2);
});

// ---------------------------------------------------------------------------
// A-03：Peopleの誤削除
// ---------------------------------------------------------------------------

const PERSON_ID = "01K8F7Q2W9E4R5T6Y7U8I2HP4Z";
const person: PersonRecord = {
  id: PERSON_ID,
  fileName: personAlias.personFileName("架空の人物", PERSON_ID),
  createdAt: T,
  decisions: [{ id: "dec-1", at: T, kind: "confirm", name: "架空の人物" }],
};
const HEALTHY_PERSON_MD = personAlias.personToMarkdown(person);
/** `type:` 行より前で切断（id と tsumugi: true は残る）。監査T7の再現形状。 */
const TRUNCATED_BEFORE_TYPE_MD = HEALTHY_PERSON_MD.slice(0, HEALTHY_PERSON_MD.indexOf("type: person"));
/** `type:` 行より後で切断。 */
const TRUNCATED_AFTER_TYPE_MD = HEALTHY_PERSON_MD.slice(0, HEALTHY_PERSON_MD.indexOf("displayName:"));

class FakeStore implements PeopleStoreEnv {
  raw: string | undefined;
  async readState() { return personStore.parsePeopleState(this.raw); }
  async updateState<R>(fn: (s: PeopleState) => { state: PeopleState; result: R }) {
    const out = fn(personStore.parsePeopleState(this.raw));
    this.raw = JSON.stringify(out.state);
    return out.result;
  }
}
class FakeVault implements PeopleVaultEnv {
  files = new Map<string, string>();
  async listPeopleFiles() {
    return { files: [...this.files.entries()].map(([fileName, text]) => ({ fileName, text })), unreadable: [], complete: true, namesKnown: true };
  }
  async writePeopleFile(name: string, text: string) { this.files.set(name, text); }
  async readPeopleFile(name: string) { return this.files.get(name) ?? null; }
  async isPairedVault() { return true; }
}

function storeWithPerson(): FakeStore {
  const store = new FakeStore();
  store.raw = JSON.stringify({ people: [person], pending: [] });
  return store;
}

test("A-03: readVaultPeople counts a note truncated before the type: line as unreadable", () => {
  const disk = personStore.readVaultPeople([{ fileName: person.fileName, text: TRUNCATED_BEFORE_TYPE_MD }]);
  assert.equal(disk.people.size, 0);
  assert.deepEqual(disk.unreadable, [person.fileName]);
});

test("A-03: sync never removes a person whose note is truncated before the type: line (the audit reproduction, removed=1)", async () => {
  const store = storeWithPerson();
  const v = new FakeVault();
  v.files.set(person.fileName, TRUNCATED_BEFORE_TYPE_MD);
  const r = await personStore.syncPeopleWithVault(store, v);
  assert.equal(r.removed, 0);
  assert.deepEqual(r.unreadable, [person.fileName]);
  assert.deepEqual((await store.readState()).people.map((p) => p.id), [PERSON_ID]);
});

test("A-03: sync never removes a person whose note file is present but holds unrelated content", async () => {
  const store = storeWithPerson();
  const v = new FakeVault();
  v.files.set(person.fileName, "# 自分のメモ\n");
  const r = await personStore.syncPeopleWithVault(store, v);
  assert.equal(r.removed, 0);
  assert.deepEqual((await store.readState()).people.map((p) => p.id), [PERSON_ID]);
});

test("A-03: truncation after the type: line still protects the person (existing guard regression)", async () => {
  const store = storeWithPerson();
  const v = new FakeVault();
  v.files.set(person.fileName, TRUNCATED_AFTER_TYPE_MD);
  const r = await personStore.syncPeopleWithVault(store, v);
  assert.equal(r.removed, 0);
  assert.deepEqual(r.unreadable, [person.fileName]);
  assert.deepEqual((await store.readState()).people.map((p) => p.id), [PERSON_ID]);
});

test("A-03: a genuine deletion (the note file is truly absent) still removes the person from the cache", async () => {
  const store = storeWithPerson();
  const v = new FakeVault();
  const r = await personStore.syncPeopleWithVault(store, v);
  assert.equal(r.removed, 1);
  assert.deepEqual((await store.readState()).people, []);
});

// ---------------------------------------------------------------------------
// A-04：native書き込みの成功誤判定
// ---------------------------------------------------------------------------

function fakeNativeFile(opts: { partial: boolean }) {
  let stored = new Uint8Array(0);
  const handle = {
    kind: "file", name: "fake.md",
    async createWritable() {
      let buffer = new Uint8Array(0);
      return {
        async write(d: string | Uint8Array) { buffer = typeof d === "string" ? bytes(d) : new Uint8Array(d); },
        async close() { stored = opts.partial ? buffer.slice(0, Math.floor(buffer.byteLength / 2)) : buffer; },
        async abort() { /* nothing */ },
      };
    },
    async getFile() {
      const data = stored;
      return {
        size: data.byteLength, lastModified: 0,
        async text() { return textOf(data); },
        async arrayBuffer() { return data.slice().buffer; },
        slice(start = 0, end = data.byteLength) {
          const part = data.slice(start, end);
          return { size: part.byteLength, async text() { return textOf(part); } };
        },
      };
    },
  };
  return { handle: handle as unknown as FileSystemFileHandle, read: () => textOf(stored), opts };
}

test("A-04: a native write that lands partially (no exception) is reported as failure, never as success", async () => {
  const f = fakeNativeFile({ partial: true });
  await assert.rejects(
    vaultWriter.writeFileHandleContent(f.handle, "x".repeat(1000)),
    (e: unknown) => e instanceof vaultWriter.VaultWriteVerificationError,
  );
});

test("A-04: a native write that lands fully succeeds and the content reads back identical", async () => {
  const f = fakeNativeFile({ partial: false });
  const content = `架空の内容 ${"y".repeat(500)}`;
  await vaultWriter.writeFileHandleContent(f.handle, content);
  assert.equal(f.read(), content);
});

test("A-04: retrying after a partial-write failure converges to the full intended content", async () => {
  const f = fakeNativeFile({ partial: true });
  const content = "z".repeat(1000);
  await assert.rejects(vaultWriter.writeFileHandleContent(f.handle, content));
  assert.equal(f.read().length, 500, "the torn state is on disk, but it was NOT reported as success");
  f.opts.partial = false;
  await vaultWriter.writeFileHandleContent(f.handle, content);
  assert.equal(f.read(), content);
});

test("A-04 integration: the vault's own write path (writeFileInDir via the recovery primitives) also refuses partial landings", async () => {
  const v = new MemVault();
  const shardPath = `.tsumugi/registry/${vault.vaultRegistryBucketOf("c1").toString(16).padStart(2, "0")}.json`;
  const input = {
    registryKey: "c1", path: "Conversations/c.md", recordType: "conversation" as const,
    mtime: 0, size: 10, contentHash: "abc", memberIds: ["c1"],
  };
  v.partialWrites.add(shardPath);
  await assert.rejects(
    vault.vaultRecoveryPrimitives.upsertVaultRegistryRecord(v.dir(), input),
    (e: unknown) => e instanceof vaultWriter.VaultWriteVerificationError,
  );
  v.partialWrites.clear();
  // 部分着地したshardは壊れたまま残るが、「空」と取り違えて書き戻されることは
  // 決してない（A-05）：再試行は診断可能なエラーで安全に停止する。直すのは
  // 走査に基づくresyncの再構築だけ（A-05の統合テスト参照）。
  await assert.rejects(
    vault.vaultRecoveryPrimitives.upsertVaultRegistryRecord(v.dir(), input),
    (e: unknown) => e instanceof vault.VaultRegistryShardUnreadableError,
  );
});

// ---------------------------------------------------------------------------
// A-05：Registryのlenient読み込みによるentry喪失
// ---------------------------------------------------------------------------

function twoKeysSameBucket(): { bucket: number; k1: string; k2: string } {
  const byBucket = new Map<number, string>();
  for (let i = 0; ; i++) {
    const key = `fic-record-${i}`;
    const bucket = vault.vaultRegistryBucketOf(key);
    const other = byBucket.get(bucket);
    if (other) return { bucket, k1: other, k2: key };
    byBucket.set(bucket, key);
  }
}
const shardPathOf = (bucket: number) => `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
const upsert = (root: FileSystemDirectoryHandle, registryKey: string, p: string) =>
  vault.vaultRecoveryPrimitives.upsertVaultRegistryRecord(root, {
    registryKey, path: p, recordType: "conversation", mtime: 0, size: 10, contentHash: "abc", memberIds: [registryKey],
  });

test("A-05: upsert refuses to rewrite a corrupt shard — it throws a diagnosable error and the shard bytes are untouched", async () => {
  const { bucket, k1 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const v = new MemVault({ [shardPath]: "{broken json, torn write" });
  await assert.rejects(
    upsert(v.dir(), k1, "Conversations/a.md"),
    (e: unknown) => e instanceof vault.VaultRegistryShardUnreadableError,
  );
  assert.equal(v.text(shardPath), "{broken json, torn write");
});

test("A-05: a structurally invalid shard (valid JSON, orphan record) is refused the same way", async () => {
  const { bucket, k1 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const invalid = JSON.stringify({ schemaVersion: 1, bucket, records: { ghost: "Conversations/ghost.md" }, files: {} });
  const v = new MemVault({ [shardPath]: invalid });
  await assert.rejects(
    upsert(v.dir(), k1, "Conversations/a.md"),
    (e: unknown) => e instanceof vault.VaultRegistryShardUnreadableError,
  );
  assert.equal(v.text(shardPath), invalid);
});

test("A-05: upsert on a healthy shard preserves the other entries of the same bucket", async () => {
  const { bucket, k1, k2 } = twoKeysSameBucket();
  const v = new MemVault();
  const root = v.dir();
  await upsert(root, k1, "Conversations/a.md");
  await upsert(root, k2, "Conversations/b.md");
  const shard = await vault.readVaultRegistryShard(root, bucket);
  assert.equal(shard.records[k1], "Conversations/a.md");
  assert.equal(shard.records[k2], "Conversations/b.md");
});

test("A-05: a genuinely absent shard is created by upsert (absence is not confused with corruption)", async () => {
  const { bucket, k1 } = twoKeysSameBucket();
  const v = new MemVault();
  await upsert(v.dir(), k1, "Conversations/a.md");
  const shard = await vault.readVaultRegistryShard(v.dir(), bucket);
  assert.equal(shard.records[k1], "Conversations/a.md");
});

test("A-05: the resync commit path refuses a corrupt shard too (no read-modify-write from an incomplete read)", async () => {
  const { bucket, k1 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const v = new MemVault({ [shardPath]: "not json at all" });
  await assert.rejects(
    vault.commitVaultRegistrySingleRecordOk(v.dir(), k1, "conversation", "Conversations/a.md", null, 0, 10, "abc"),
    (e: unknown) => e instanceof vault.VaultRegistryShardUnreadableError,
  );
  assert.equal(v.text(shardPath), "not json at all");
});

test("A-05: a transient shard read failure refuses the upsert and preserves the healthy entries", async () => {
  const { bucket, k1, k2 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const v = new MemVault();
  const root = v.dir();
  await upsert(root, k1, "Conversations/a.md");
  // 読み取りだけが一時的に失敗する状態で3件目を書こうとすると、安全に停止し、
  // 既存の健全なエントリは一切失われない（修正前は失敗した読み取りを「空」と
  // 解釈してshard全体を書き戻し、既存エントリを消していた）。
  v.failReads.add(shardPath);
  await assert.rejects(
    upsert(root, k2, "Conversations/b.md"),
    (e: unknown) => e instanceof vault.VaultRegistryShardUnreadableError,
  );
  v.failReads.delete(shardPath);
  const shard = await vault.readVaultRegistryShard(root, bucket);
  assert.equal(shard.records[k1], "Conversations/a.md");
  assert.equal(shard.records[k2], undefined);
});

test("A-05 integration: a completed full resync rebuilds a corrupt shard from the scanned files (the only repair route)", async () => {
  const { bucket, k1 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const v = new MemVault({
    "Conversations/a.md": markdown.conversationToMarkdown(conversation(k1)),
    [shardPath]: "{broken json, torn write",
  });
  // resyncVaultRegistry（排他world lock＋epoch確認）を通常運用と同じ条件で呼べるよう、
  // 他のsuite（productionMemoryWiring等）と同じ手順で有効な世界を用意する。
  await db.clearMemoryData();
  await db.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null, pendingCandidateVaultId: null, updatedAt: T });
  await db.markVaultEpochCommitted(0);
  await db.markVaultWorldJournalMigrated();
  worldLock.setTabVaultEpoch(0);
  const result = await vault.resyncVaultRegistry(v.dir());
  assert.equal(result.scanCompleted, true);
  // bucketは再構築され、実在するrecordは実ファイルの観測から再登録される。
  const shard = await vault.readVaultRegistryShard(v.dir(), bucket);
  assert.equal(shard.records[k1], "Conversations/a.md");
  // 再構築の後は通常の更新も再び機能する。
  await upsert(v.dir(), k1, "Conversations/a.md");
});

// ---------------------------------------------------------------------------
// A-05深掘り：Registry再構築の安全条件（不完全な情報では再構築を確定しない）
// ---------------------------------------------------------------------------

/** `resyncVaultRegistry` を通常運用と同じ条件で呼べるよう、有効な世界を用意する。 */
async function prepareResyncWorld() {
  await db.clearMemoryData();
  await db.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null, pendingCandidateVaultId: null, updatedAt: T });
  await db.markVaultEpochCommitted(0);
  await db.markVaultWorldJournalMigrated();
  worldLock.setTabVaultEpoch(0);
}

test("A-05 rebuild safety: while any vault file is unreadable, the rebuild is held and the corrupt shard is left byte-identical", async () => {
  const { bucket, k1, k2 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const v = new MemVault({
    "Conversations/a.md": markdown.conversationToMarkdown(conversation(k1)),
    "Conversations/b.md": markdown.conversationToMarkdown(conversation(k2)),
    [shardPath]: "{broken json, torn write",
  });
  // b.mdは実在するが読めない。走査自体は完了しても、そのrecordが壊れたbucketの
  // ものかどうかはファイルが読めない以上判別できない。ここでbucketを空へ初期化
  // すると、再登録されないエントリが失われるため、再構築は保留されなければ
  // ならない（「空として初期化」と「完全な情報からの再構築」の混同の禁止）。
  v.failReads.add("Conversations/b.md");
  await prepareResyncWorld();
  const result = await vault.resyncVaultRegistry(v.dir());
  assert.equal(result.scanCompleted, true);
  assert.equal(result.unreadableFiles.length, 1);
  assert.equal(v.text(shardPath), "{broken json, torn write");
  assert.ok(
    result.applyErrors.some((e) => e.registryKey === `__registry_shard_${bucket}__` && /held/.test(e.reason)),
    "the hold is surfaced in applyErrors, not silent",
  );
  // 読めないファイルが解消すれば、次のresyncで再構築が完了し、両方のrecordが
  // 実ファイルの観測から再登録される（保留は恒久的な停止ではない）。
  v.failReads.delete("Conversations/b.md");
  const second = await vault.resyncVaultRegistry(v.dir());
  assert.equal(second.scanCompleted, true);
  const shard = await vault.readVaultRegistryShard(v.dir(), bucket);
  assert.equal(shard.records[k1], "Conversations/a.md");
  assert.equal(shard.records[k2], "Conversations/b.md");
});

test("A-05 rebuild safety: a transient shard read failure plus an unreadable record file preserves the healthy shard exactly (Codex P1 scenario)", async () => {
  const { bucket, k1, k2 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const v = new MemVault({
    "Conversations/a.md": markdown.conversationToMarkdown(conversation(k1)),
    "Conversations/b.md": markdown.conversationToMarkdown(conversation(k2)),
  });
  const root = v.dir();
  // まず健全なshardを実在させる（2件とも登録済み）。
  await upsert(root, k1, "Conversations/a.md");
  await upsert(root, k2, "Conversations/b.md");
  const healthyBytes = v.text(shardPath);
  // shardの読み取りが一時的に失敗し、同時にk2のMarkdownも読めない状態で
  // resyncする。snapshotはbucketを「読めなかった」bucketとして扱い、walkは
  // k2をunreadableとして記録する。この不完全な観測のままshardを空へ初期化
  // すると健全なエントリが恒久的に失われるため、shardは無傷でなければ
  // ならない（再構築の保留はこの形でも働く）。
  v.failReads.add(shardPath);
  v.failReads.add("Conversations/b.md");
  await prepareResyncWorld();
  const result = await vault.resyncVaultRegistry(root);
  assert.equal(result.scanCompleted, true);
  assert.equal(result.unreadableFiles.length, 1);
  v.failReads.delete(shardPath);
  v.failReads.delete("Conversations/b.md");
  assert.equal(v.text(shardPath), healthyBytes);
  const shard = await vault.readVaultRegistryShard(root, bucket);
  assert.equal(shard.records[k1], "Conversations/a.md");
  assert.equal(shard.records[k2], "Conversations/b.md");
});

test("A-05 rebuild safety: a record whose file is absent while its shard is corrupt is not resurrected; healthy records are rebuilt", async () => {
  const { bucket, k1, k2 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  // k2のファイルはVaultに存在しない（shardが壊れている間に消えた等）。壊れた
  // shardの中身は再取得できないため、k2のエントリは再構築後も存在しない
  // （推測で復活させない）。実在するk1は実ファイルの観測から再登録される。
  const v = new MemVault({
    "Conversations/a.md": markdown.conversationToMarkdown(conversation(k1)),
    [shardPath]: "{broken json, torn write",
  });
  await prepareResyncWorld();
  const result = await vault.resyncVaultRegistry(v.dir());
  assert.equal(result.scanCompleted, true);
  const shard = await vault.readVaultRegistryShard(v.dir(), bucket);
  assert.equal(shard.records[k1], "Conversations/a.md");
  assert.equal(shard.records[k2], undefined);
});

test("A-05 rebuild safety: a write failure during the rebuild leaves the corrupt shard untouched, and a re-run completes the rebuild", async () => {
  const { bucket, k1 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const v = new MemVault({
    "Conversations/a.md": markdown.conversationToMarkdown(conversation(k1)),
    [shardPath]: "{broken json, torn write",
  });
  v.failWrites.add(shardPath);
  await prepareResyncWorld();
  const first = await vault.resyncVaultRegistry(v.dir());
  assert.equal(first.scanCompleted, true);
  assert.equal(v.text(shardPath), "{broken json, torn write");
  assert.ok(
    first.applyErrors.some((e) => e.registryKey === `__registry_shard_${bucket}__`),
    "the failed rebuild is surfaced in applyErrors, not silent",
  );
  // 再実行可能：書き込みが回復すれば、次のresyncで再構築が完了する。
  v.failWrites.delete(shardPath);
  const second = await vault.resyncVaultRegistry(v.dir());
  assert.equal(second.scanCompleted, true);
  const shard = await vault.readVaultRegistryShard(v.dir(), bucket);
  assert.equal(shard.records[k1], "Conversations/a.md");
});

test("A-05 rebuild safety: when the scan itself cannot complete, the corrupt shard is never touched", async () => {
  const { bucket, k1 } = twoKeysSameBucket();
  const shardPath = shardPathOf(bucket);
  const v = new MemVault({
    "Conversations/a.md": markdown.conversationToMarkdown(conversation(k1)),
    [shardPath]: "{broken json, torn write",
  });
  const inner = v.dir();
  const root = {
    ...inner,
    entries: async function* () {
      throw new Error("injected enumeration failure");
    },
  } as unknown as FileSystemDirectoryHandle;
  await prepareResyncWorld();
  const result = await vault.resyncVaultRegistry(root);
  assert.equal(result.scanCompleted, false);
  assert.equal(v.text(shardPath), "{broken json, torn write");
});

// ---------------------------------------------------------------------------
// 横断統合テスト
// ---------------------------------------------------------------------------

test("integration: healthy conversation + corrupt day-file — every scanner keeps the conversation and surfaces the day-file loss", async () => {
  const c = conversation();
  const files = { "Conversations/c.md": markdown.conversationToMarkdown(c), [DAY_PATH]: corruptDayA(), ...emptyShardFilesFor(["c1", DAY_KEY]) };

  const scan = await vault.scanVaultForRestore(new MemVault(files).dir());
  assert.deepEqual(scan.conversations.map((x) => x.id), ["c1"]);
  assert.deepEqual(scan.memoryObjects.map((x) => x.id), ["m1"]);
  assert.equal(scan.droppedEntryCount, 1);

  const light = await runLightCheck(new MemVault(files));
  assert.ok(light.records.some((r) => r.registryKey === "c1" && r.outcome === "added"));
  const dayRecord = light.records.find((r) => r.registryKey === DAY_KEY);
  assert.equal(dayRecord?.outcome, "conflict");

  const p = await plan(new ReadOnlyVault(files), local([c], [memory("m1")]));
  assert.ok(p.records.some((r) => r.recordId === "c1"));
  assert.ok(p.issues.some((i) => i.path === DAY_PATH));
  assert.equal(p.records.find((r) => r.recordId === "m1")?.vaultMarkdownExists, true);
});

test("integration: healthy People + corrupt People in one sync — nobody is removed, the corrupt note is reported", async () => {
  const person2: PersonRecord = {
    id: "01K8F7Q2W9E4R5T6Y7U8I2HP4Y",
    fileName: personAlias.personFileName("架空の別人", "01K8F7Q2W9E4R5T6Y7U8I2HP4Y"),
    createdAt: T,
    decisions: [{ id: "dec-9", at: T, kind: "confirm", name: "架空の別人" }],
  };
  const store = new FakeStore();
  store.raw = JSON.stringify({ people: [person, person2], pending: [] });
  const v = new FakeVault();
  v.files.set(person.fileName, HEALTHY_PERSON_MD);
  v.files.set(person2.fileName, personAlias.personToMarkdown(person2).slice(0, personAlias.personToMarkdown(person2).indexOf("type: person")));
  const r = await personStore.syncPeopleWithVault(store, v);
  assert.equal(r.removed, 0);
  assert.deepEqual(r.unreadable, [person2.fileName]);
  assert.deepEqual((await store.readState()).people.map((p) => p.id).sort(), [PERSON_ID, person2.id].sort());
});

test("integration: latest data on only one side — the restore plan adds Vault-only records and never touches existing ids", async () => {
  const scan = await vault.scanVaultForRestore(new MemVault({
    "Conversations/c.md": markdown.conversationToMarkdown(conversation()),
    [DAY_PATH]: healthyDay(),
    "Sources/s.md": markdown.sourceToMarkdown(source()),
  }).dir());
  const planResult = vaultRestore.computeVaultRestorePlan(scan, {
    memoryIds: new Set(["m1", "m2"]), conversationIds: new Set<string>(), sourceIds: new Set(["s1"]),
  });
  assert.deepEqual(planResult.conversationsToAdd.map((c) => c.id), ["c1"]);
  assert.deepEqual(planResult.memoriesToAdd, []);
  assert.deepEqual(planResult.sourcesToAdd, []);
  assert.equal(planResult.counts.existingSkipped.memories, 2);
  assert.equal(planResult.counts.existingSkipped.sources, 1);
});

test("integration: multiple simultaneous corruptions surface independently in one light-check", async () => {
  const usedBuckets = new Set([vault.vaultRegistryBucketOf("c1"), vault.vaultRegistryBucketOf(DAY_KEY)]);
  let freeBucket = 0;
  while (usedBuckets.has(freeBucket)) freeBucket += 1;
  const v = new MemVault({
    "Conversations/c.md": crlf(markdown.conversationToMarkdown(conversation())),
    [DAY_PATH]: corruptDayA(),
    [`People/${person.fileName}`]: TRUNCATED_BEFORE_TYPE_MD,
    [shardPathOf(freeBucket)]: "{torn shard",
    ...emptyShardFilesFor(["c1", DAY_KEY]),
  });
  const result = await runLightCheck(v);
  // CRLFの会話はrecordとして分類される（消えない）。
  assert.ok(result.records.some((r) => r.registryKey === "c1" && r.outcome === "added"));
  // day-fileの欠落はconflictとして表面化する。
  assert.equal(result.records.find((r) => r.registryKey === DAY_KEY)?.outcome, "conflict");
  // 切断されたPeopleはunreadable（parse）として表面化する。
  assert.ok(result.unreadableDiagnostics.some((d) => d.path === `People/${person.fileName}` && d.kind === "parse"));
});

// ---------------------------------------------------------------------------
// A-02 ラウンド5（Codex [P2] N-2）：ハッシュ「生成側」の正規化漏れ。
// 分類・write前検証など比較側はLF正規化済みテキストのハッシュを基準にする
// 規則で統一された（ラウンド3）が、day-fileの保存がRegistryへ記録する
// contentHashは、planが返したテキストをそのままハッシュしていた。無変更
// memberのno-op保存ではplanは元の生テキスト（CRLFファイルではCRLFのまま）
// を返すため、正規化済みだった基準が生ハッシュに置き換わる。その後mtime
// だけが変わると、write前検証の正規化比較と一致せず保存が止まる。
// 生成側も比較側と同じ規則でなければならない。
// ---------------------------------------------------------------------------

/** CRLF day-file＋分類が登録した状態（LF正規化済み基準）の種付け。 */
function seedCrlfDayFile(m1: MemoryObject, m2: MemoryObject) {
  const day = m1.date.slice(0, 10);
  const lfDay = markdown.serializeMemoryDayFile([m1, m2]);
  const key = vault.dayFileRegistryKey(day);
  const path = `Memories/${vault.dayFileNameFor(m1.date)}`;
  const v = new MemVault({ [path]: crlf(lfDay) });
  const parsedSeed = markdown.parseMemoryDayFile(lfDay);
  seedRegistryEntry(v, key, path, {
    recordType: "memory-day",
    mtime: 999,
    size: bytes(lfDay).length,
    contentHash: vault.hashVaultText(lfDay),
    memberIds: [m1.id, m2.id],
    memberHashes: Object.fromEntries(parsedSeed.map((m) => [m.id, vault.hashVaultText(markdown.memoryObjectToMarkdown(m))])),
  });
  return { v, key, path, lfDay, day };
}

/** entryのmtimeだけをずらす（実ファイルのmtimeだけが変わった状態の再現）。 */
async function driftEntryMtime(v: MemVault, key: string, path: string) {
  const shard = await vault.readVaultRegistryShard(v.dir(), vault.vaultRegistryBucketOf(key));
  const entry = shard.files[path];
  assert.ok(entry, "the Registry entry exists");
  seedRegistryEntry(v, key, path, {
    recordType: entry.recordType,
    mtime: 424242,
    size: entry.size,
    contentHash: entry.contentHash,
    memberIds: entry.memberIds,
    memberHashes: entry.memberHashes,
  });
}

test("A-02 round5 (Codex P2 N-2): a no-op save of a CRLF day-file keeps the normalized Registry baseline — an mtime-only change does not block the next save", async () => {
  await prepareResyncWorld();
  const memMeta = { ...meta, sourceType: "chat" };
  const m1: MemoryObject = { ...memory("m-r5-1"), metadata: { ...memMeta } } as MemoryObject;
  const m2: MemoryObject = { ...memory("m-r5-2"), metadata: { ...memMeta } } as MemoryObject;
  const { v, key, path, lfDay } = seedCrlfDayFile(m1, m2);
  // 無変更memberのno-op保存：ファイルには一切触れない。
  await vault.writeMemoryObjectMarkdown(v.dir(), m1);
  assert.equal(v.text(path), crlf(lfDay), "a no-op save leaves the CRLF file byte-identical");
  // 生成側の規則：記録されるcontentHashは分類が作るLF正規化済み基準と同じ
  // でなければならない（修正前は生CRLFテキストのハッシュに置き換わる）。
  const afterNoop = await vault.readVaultRegistryShard(v.dir(), vault.vaultRegistryBucketOf(key));
  assert.equal(
    afterNoop.files[path]?.contentHash,
    vault.hashVaultText(lfDay),
    `the Registry baseline must stay the LF-normalized hash (recorded: ${afterNoop.files[path]?.contentHash}; LF-normalized: ${vault.hashVaultText(lfDay)}; raw CRLF: ${vault.hashVaultText(crlf(lfDay))})`
  );
  // mtimeだけが変わった後でも、内容のある保存が通らなければならない
  // （修正前はVaultRecordNeedsResyncErrorで拒否される）。
  await driftEntryMtime(v, key, path);
  const updatedM1: MemoryObject = { ...m1, content: "更新された架空の記録 m-r5-1", summary: "更新された架空の記録 m-r5-1", updatedAt: T2 };
  await vault.writeMemoryObjectMarkdown(v.dir(), updatedM1);
  const parsed = markdown.parseMemoryDayFile(v.text(path));
  assert.equal(parsed.length, 2, "both members survive the save after the mtime-only change");
  assert.equal(parsed.find((m) => m.id === m1.id)?.content, updatedM1.content);
  assert.equal(parsed.find((m) => m.id === m2.id)?.content, m2.content);
});

test("A-02 round5: a genuine external edit after the no-op save is still refused — the N-2 fix does not weaken detection", async () => {
  await prepareResyncWorld();
  const memMeta = { ...meta, sourceType: "chat" };
  const m1: MemoryObject = { ...memory("m-r5x-1"), metadata: { ...memMeta } } as MemoryObject;
  const m2: MemoryObject = { ...memory("m-r5x-2"), metadata: { ...memMeta } } as MemoryObject;
  const { v, key, path, lfDay } = seedCrlfDayFile(m1, m2);
  await vault.writeMemoryObjectMarkdown(v.dir(), m1); // no-op保存
  // 外部編集：CRLFのままm2の本文を書き換える（行末は変えない）。
  const edited = crlf(lfDay).replace("架空の記録 m-r5x-2 です", "外部で書き換えられた架空の記録");
  assert.notEqual(edited, crlf(lfDay));
  v.put(path, bytes(edited));
  await driftEntryMtime(v, key, path);
  const updatedM1: MemoryObject = { ...m1, content: "更新された架空の記録 m-r5x-1", summary: "更新された架空の記録 m-r5x-1", updatedAt: T2 };
  await assert.rejects(
    vault.writeMemoryObjectMarkdown(v.dir(), updatedM1),
    (e: unknown) => e instanceof vault.VaultRecordNeedsResyncError,
  );
  // ファイルは1バイトも変えず、状態はneeds-resyncとして表面化する。
  assert.equal(v.text(path), edited);
  const shard = await vault.readVaultRegistryShard(v.dir(), vault.vaultRegistryBucketOf(key));
  assert.equal(shard.files[path]?.status, "needs-resync");
});

// ---------------------------------------------------------------------------
// A-02 ラウンド5（横断監査）：legacy cleanupの計画計算も、Registry基準との
// 比較はLF正規化済みハッシュの規則に従わなければならない。生テキストの
// ハッシュで照合すると、無変更のCRLFファイルが「正本を特定できない」
// 「登録時から変わっている」と誤判定され、再確定が黙って進まなくなる。
// ---------------------------------------------------------------------------

test("A-02 round5 audit: the legacy cleanup plan identifies a CRLF conversation's canonical copy against the normalized Registry baseline", () => {
  const conv = conversation("c-legacy-r5");
  const lfText = markdown.conversationToMarkdown(conv);
  const fileOf = (p: string, text: string) => ({
    path: p, name: p.split("/").pop()!, area: "Conversations" as const, text, sha256: `sha-${p}`, size: bytes(text).length,
  });
  const snapshot = {
    files: [fileOf("Conversations/a.md", crlf(lfText)), fileOf("Conversations/a+.md", lfText)],
    registry: [{
      key: conv.id, path: "Conversations/a.md",
      entry: { recordType: "conversation", mtime: 1, size: bytes(lfText).length, contentHash: vault.hashVaultText(lfText), memberIds: [conv.id], status: "conflict" },
    }],
    manifest: { schemaVersion: 1, entries: [] },
    manifestError: null,
    archiveSha: new Map(),
    idb: { memories: new Map(), conversations: new Map([[conv.id, conv]]), sourceCount: 0 },
    baselineEstablishedAt: null,
  } as unknown as Parameters<typeof legacyCleanup.computeLegacyCleanupPlan>[0];
  const plan = legacyCleanup.computeLegacyCleanupPlan(snapshot);
  const item = plan.conversations.find((c) => c.key === conv.id);
  assert.ok(item, `the conflicted conversation is planned (skipped instead: ${JSON.stringify(plan.skippedConflicts)})`);
  assert.equal(item.canonicalPath, "Conversations/a.md", "the CRLF file is identified as the canonical copy");
  assert.equal(item.ok, true, `all checks pass (failed: ${item.checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")})`);
});

test("A-02 round5 audit: the legacy cleanup plan treats an unchanged CRLF day-file as unchanged against the normalized Registry baseline", () => {
  const memMeta = { ...meta, sourceType: "chat" };
  const m1: MemoryObject = { ...memory("m-leg-1"), metadata: { ...memMeta } } as MemoryObject;
  const m2: MemoryObject = { ...memory("m-leg-2"), metadata: { ...memMeta } } as MemoryObject;
  const day = m1.date.slice(0, 10);
  const lfDay = markdown.serializeMemoryDayFile([m1, m2]);
  const key = vault.dayFileRegistryKey(day);
  const path = `Memories/${day}.md`;
  const parsedMembers = markdown.parseMemoryDayFile(lfDay);
  const snapshot = {
    files: [{ path, name: `${day}.md`, area: "Memories" as const, text: crlf(lfDay), sha256: "sha-day", size: bytes(crlf(lfDay)).length }],
    registry: [{
      key, path,
      entry: {
        recordType: "memory-day", mtime: 1, size: bytes(lfDay).length, contentHash: vault.hashVaultText(lfDay),
        memberIds: [m1.id, m2.id],
        memberHashes: Object.fromEntries(parsedMembers.map((m) => [m.id, vault.hashVaultText(markdown.memoryObjectToMarkdown(m))])),
        status: "conflict",
      },
    }],
    manifest: {
      schemaVersion: 1,
      entries: [{ originalPath: path, archivePath: `.tsumugi-archive/legacy/${day}.md`, sha256: "sha-day", size: 1, archivedAt: T, kind: "legacy-memory" as const, recordId: m1.id, day }],
    },
    manifestError: null,
    archiveSha: new Map(),
    idb: { memories: new Map(parsedMembers.map((m) => [m.id, m])), conversations: new Map(), sourceCount: 0 },
    baselineEstablishedAt: null,
  } as unknown as Parameters<typeof legacyCleanup.computeLegacyCleanupPlan>[0];
  const plan = legacyCleanup.computeLegacyCleanupPlan(snapshot);
  const item = plan.memoryDays.find((d) => d.key === key);
  assert.ok(item, "the conflicted day-file is planned");
  assert.equal(item.ok, true, `all checks pass (failed: ${item.checks.filter((c) => !c.ok).map((c) => c.name).join(" / ")})`);
});

// ---------------------------------------------------------------------------
// ラウンド5（Codex [P2] N-1）：「確認する」の待機取り消し述語が
// `vaultGenerationRef.current !== vaultGenerationRef.current`（自己比較・
// 常時false）になっており、待機中のVault切替を検出できなかった。世代の
// 捕捉はwaitUntilIdleOrGenerationChange（捕捉はヘルパー内）へ移し、
// この形の述語が component に残っていないことを固定する。ヘルパー自体の
// 意味論（同一世代→idle／切替→cancelled）はwaitUntilIdle.test.tsで検証する。
// ---------------------------------------------------------------------------

test("round5 (Codex P2 N-1): the vault-status check wait cannot spin on a self-comparing generation predicate", () => {
  const src = fs.readFileSync(path.join(OUT, "..", "src", "components", "ChatScreen.tsx"), "utf8");
  assert.ok(
    !src.includes("vaultGenerationRef.current !== vaultGenerationRef.current"),
    "the self-comparing cancellation predicate (always false) is gone"
  );
  const start = src.indexOf("async function handleCheckVaultStatus()");
  assert.ok(start >= 0, "handleCheckVaultStatus exists");
  const body = src.slice(start, start + 1600);
  assert.ok(body.includes("waitUntilIdleOrGenerationChange"), "the check waits via the generation-capturing helper");
});

// ---------------------------------------------------------------------------
// A-02 ラウンド5追加検証（append-local post-check の到達可能性と実経路回帰）。
// §U row 12 の vaultAppendLocal:597 修正は「テストの足場が無い」ことが残存
// リスクだった。実経路（planAppendLocalRecords → appendLocalRecordsToVault）
// を実際に駆動して検証する。
//
// 到達可能性の確定事実（プローブで確認済み）：
// - 書き込み前に保存先へCRLFファイルが存在する形状は、planの痕跡チェック
//   （conversation: vault-trace／day-file: day-has-vault-files）と書き込み側の
//   assertAdoptTargetAbsent（バイト完全一致のみ許可）の両方で、post-checkに
//   到達する前にレビュー可能な形で拒否される（下の到達可能性テストで固定）。
// - post-checkがCRLFテキストを実際に読むのは、書き込みとpost-checkの間に
//   行末変換が着地した場合（同期フォルダ等で起こり得る）。これはファイル
//   ハンドル層で「Registry shardのcommit以後、対象ファイルの読み取りだけを
//   変換済みテキストで返す」ラッパーにより再現する（MemVault自体がハンドル
//   層のfakeであることと同種の注入。保存バイト自体は変えない）。
// ---------------------------------------------------------------------------

const APPEND_LOCAL_BASELINE_META = JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: T2, baselineEstablishedAt: T2 });

/**
 * Registry shardのcommit（createWritableのclose）を観測した後、targetPathの
 * 読み取りだけを serve() の結果で返すrootラッパー。書き込み側の検証読み戻し・
 * stat読みはcommit前に終わるため、差し替えが効くのはpost-check以降の読みだけ。
 * servedCountで「実際に差し替えが読まれた」ことをテスト側が確認できる。
 */
function wrapRootForPostCommitServe(v: MemVault, targetPath: string, serve: (genuine: string) => string) {
  let committed = false;
  let served = 0;
  const wrapFile = (handle: FileSystemFileHandle, p: string): FileSystemFileHandle =>
    ({
      kind: "file",
      name: handle.name,
      async getFile() {
        const file = await handle.getFile();
        if (!committed || p !== targetPath) return file;
        served++;
        const doctored = serve(await file.text());
        const data = bytes(doctored);
        return {
          size: file.size,
          lastModified: file.lastModified,
          slice(start = 0, end = data.byteLength) {
            const part = data.slice(start, end);
            return { size: part.byteLength, async text() { return textOf(part); } };
          },
          async text() { return doctored; },
          async arrayBuffer() { return data.slice().buffer as ArrayBuffer; },
        } as unknown as File;
      },
      async createWritable() {
        const writable = await (handle as unknown as { createWritable: () => Promise<{ write: (d: string | Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }> }).createWritable();
        const origClose = writable.close.bind(writable);
        writable.close = async () => {
          await origClose();
          if (/^\.tsumugi\/registry\/[0-9a-f]{2}\.json$/.test(p)) committed = true;
        };
        return writable;
      },
    }) as unknown as FileSystemFileHandle;
  const wrapDir = (dir: FileSystemDirectoryHandle, prefix: string): FileSystemDirectoryHandle =>
    ({
      kind: "directory",
      name: dir.name,
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        return wrapDir(await dir.getDirectoryHandle(name, options), prefix ? `${prefix}/${name}` : name);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        return wrapFile(await dir.getFileHandle(name, options), prefix ? `${prefix}/${name}` : name);
      },
      async *entries() {
        for await (const [name, h] of dir.entries()) {
          const p = prefix ? `${prefix}/${name}` : name;
          yield [name, h.kind === "file" ? wrapFile(h as FileSystemFileHandle, p) : wrapDir(h as FileSystemDirectoryHandle, p)];
        }
      },
    }) as unknown as FileSystemDirectoryHandle;
  return { root: wrapDir(v.dir(), ""), servedCount: () => served };
}

test("A-02 round5 follow-up (append-local reachability): a pre-existing CRLF copy of the record's own file is refused at plan time — it never reaches the post-check", async () => {
  await prepareResyncWorld();
  // Conversation版：自分のファイルのCRLFコピーは vault-trace で計画段階拒否。
  const conv = conversation("c-append-crlf-plan");
  await db.putConversation(conv);
  const convPath = `Conversations/${vault.fileNameFor(conv.id, conv.startedAt)}`;
  const v1 = new MemVault({ [convPath]: crlf(markdown.conversationToMarkdown(conv)), ".tsumugi/registry-meta.json": APPEND_LOCAL_BASELINE_META });
  const plan1 = await appendLocal.planAppendLocalRecords(v1.dir());
  const blocked1 = plan1.blocked.find((i) => i.record.key === `conversation:${conv.id}`);
  assert.equal(blocked1?.block?.code, "vault-trace");
  const result1 = await appendLocal.appendLocalRecordsToVault(v1.dir(), [{ key: `conversation:${conv.id}`, updatedAt: conv.updatedAt }]);
  assert.equal(result1.items[0]?.outcome, "skipped");
  assert.equal(v1.text(convPath), crlf(markdown.conversationToMarkdown(conv)), "the CRLF file is left byte-identical for review");
  // day-file版（§U row 12の形状）：CRLF day-fileに含まれるmemberは vault-trace、
  // 同じ日の（ファイルに無い）memberは day-has-vault-files で計画段階拒否。
  const memMeta = { ...meta, sourceType: "chat" };
  const m1 = { ...memory("m-append-crlf-plan"), metadata: { ...memMeta } } as MemoryObject;
  const m2 = { ...memory("m-append-crlf-plan-2"), metadata: { ...memMeta } } as MemoryObject;
  await db.putMemoryObject(m1);
  await db.putMemoryObject(m2);
  const dayPath = `Memories/${vault.dayFileNameFor(m1.date)}`;
  const v2 = new MemVault({ [dayPath]: crlf(markdown.serializeMemoryDayFile([m1])), ".tsumugi/registry-meta.json": APPEND_LOCAL_BASELINE_META });
  const plan2 = await appendLocal.planAppendLocalRecords(v2.dir());
  const blocked2 = plan2.blocked.find((i) => i.record.key === `memory:${m1.id}`);
  assert.equal(blocked2?.block?.code, "vault-trace");
  const blocked3 = plan2.blocked.find((i) => i.record.key === `memory:${m2.id}`);
  assert.equal(blocked3?.block?.code, "day-has-vault-files");
});

test("A-02 round5 follow-up (append-local post-check): a CRLF conversion landing after the write is not falsely refused — the post-check compares in the Registry convention (real execute path)", async () => {
  await prepareResyncWorld();
  const conv = conversation("c-append-post-crlf");
  await db.putConversation(conv);
  const path = `Conversations/${vault.fileNameFor(conv.id, conv.startedAt)}`;
  // 前回の中断で残った自分のファイル（LF・内容完全一致）＝own-partial形状。
  const v = new MemVault({ [path]: markdown.conversationToMarkdown(conv), ".tsumugi/registry-meta.json": APPEND_LOCAL_BASELINE_META });
  // 書き込みのcommit後、post-checkが読む時点でのみ行末変換が着地した状態を再現する。
  const { root, servedCount } = wrapRootForPostCommitServe(v, path, (genuine) => crlf(genuine));
  const result = await appendLocal.appendLocalRecordsToVault(root, [{ key: `conversation:${conv.id}`, updatedAt: conv.updatedAt }]);
  assert.ok(servedCount() >= 1, "the converted text was actually served to a post-commit read (the fixture is not vacuous)");
  assert.equal(result.items[0]?.outcome, "written");
  assert.equal(result.status, "complete", `all post-checks pass (failed: ${result.postChecks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(" / ")})`);
  assert.ok(result.postChecks.every((c) => c.ok));
  // 保存先の実バイトは書き込みが残したLFのまま（post-checkは読み取り専用）。
  assert.equal(v.text(path), markdown.conversationToMarkdown(conv));
  // 変異検証済み：vaultAppendLocal:597の正規化を戻すと、このテストは
  // post-check不一致（status "partial"）で失敗する（手作業で確認済み）。
});

test("A-02 round5 follow-up (append-local post-check): a genuine edit landing after the write is still caught — the post-check is not a no-op (real execute path)", async () => {
  await prepareResyncWorld();
  const conv = conversation("c-append-post-edit");
  await db.putConversation(conv);
  const path = `Conversations/${vault.fileNameFor(conv.id, conv.startedAt)}`;
  const v = new MemVault({ [path]: markdown.conversationToMarkdown(conv), ".tsumugi/registry-meta.json": APPEND_LOCAL_BASELINE_META });
  const { root, servedCount } = wrapRootForPostCommitServe(v, path, (genuine) => genuine.replace("架空の会話です", "外部で書き換えられた会話"));
  const result = await appendLocal.appendLocalRecordsToVault(root, [{ key: `conversation:${conv.id}`, updatedAt: conv.updatedAt }]);
  assert.ok(servedCount() >= 1, "the edited text was actually served to a post-commit read (the fixture is not vacuous)");
  assert.equal(result.items[0]?.outcome, "written");
  const recordCheck = result.postChecks.find((c) => c.name.startsWith("保存できた記録を保存先から確認"));
  assert.equal(recordCheck?.ok, false, "the divergence between the written file and the Registry baseline is caught");
  assert.equal(recordCheck?.detail, "Registryのhashがファイルと一致しません");
  assert.equal(result.status, "partial");
  // このテストは修正前後とも成功する（保存系の振る舞い保存テスト）：編集の
  // 検出自体は従来から機能しており、:597の正規化はそれを弱めていない。
});

// ---------------------------------------------------------------------------
// A-02 ラウンド5追加検証（汚染済み端末の復旧）：修正前のno-op保存が、生の
// CRLFハッシュをRegistry基準として記録してしまった端末が既に存在し得る。
// その状態から通常のresyncで安全に正常化できることを固定する。
// なおresync側の正規化自体はラウンド5以前（監査row 1–2）から存在するため、
// このテストは「ラウンド5の回帰」ではなく「既に汚染された端末の復旧保証」
// であり、修正前コードでも成功する見込みの性質のもの（人為的に失敗させる
// ことはしない）。
// ---------------------------------------------------------------------------

test("A-02 round5 follow-up (poisoned device): a raw-CRLF Registry baseline left by the pre-fix no-op save is safely normalized by a normal resync — no loss, no overwrite, no continuing blockage", async () => {
  await prepareResyncWorld();
  const memMeta = { ...meta, sourceType: "chat" };
  const m1: MemoryObject = { ...memory("m-poison-1"), metadata: { ...memMeta } } as MemoryObject;
  const m2: MemoryObject = { ...memory("m-poison-2"), metadata: { ...memMeta } } as MemoryObject;
  const { v, key, path, lfDay } = seedCrlfDayFile(m1, m2);
  // 汚染の再現：entryのcontentHashだけを、修正前のno-op保存が記録した
  // 生CRLFハッシュへ差し替える（ファイル自体は無傷のCRLF day-file）。
  const seeded = await vault.readVaultRegistryShard(v.dir(), vault.vaultRegistryBucketOf(key));
  const healthy = seeded.files[path]!;
  assert.ok(healthy);
  seedRegistryEntry(v, key, path, {
    recordType: healthy.recordType, mtime: healthy.mtime, size: healthy.size,
    contentHash: vault.hashVaultText(crlf(lfDay)),
    memberIds: healthy.memberIds, memberHashes: healthy.memberHashes,
  });
  const poisoned = await vault.readVaultRegistryShard(v.dir(), vault.vaultRegistryBucketOf(key));
  assert.equal(poisoned.files[path]?.contentHash, vault.hashVaultText(crlf(lfDay)), "the poisoned state is actually seeded");
  // 通常のresyncで正常化される。
  const result = await vault.resyncVaultRegistry(v.dir());
  assert.equal(result.scanCompleted, true);
  assert.deepEqual(result.applyErrors, []);
  const after = await vault.readVaultRegistryShard(v.dir(), vault.vaultRegistryBucketOf(key));
  assert.equal(after.files[path]?.contentHash, vault.hashVaultText(lfDay), "the baseline is re-registered in the LF-normalized form");
  assert.equal(after.files[path]?.status, "ok");
  assert.deepEqual(after.files[path]?.memberIds, [m1.id, m2.id], "no member is lost");
  // ファイル内容は1バイトも書き換えられない。
  assert.equal(v.text(path), crlf(lfDay), "resync never rewrites the file content");
  // 正常化の後に保存阻害は続かない：mtimeだけの変化＋内容のある保存が通る。
  await driftEntryMtime(v, key, path);
  const updatedM1: MemoryObject = { ...m1, content: "更新された架空の記録 m-poison-1", summary: "更新された架空の記録 m-poison-1", updatedAt: T2 };
  await vault.writeMemoryObjectMarkdown(v.dir(), updatedM1);
  const parsed = markdown.parseMemoryDayFile(v.text(path));
  assert.equal(parsed.length, 2, "both members survive the save after normalization");
  assert.equal(parsed.find((m) => m.id === m1.id)?.content, updatedM1.content);
  assert.equal(parsed.find((m) => m.id === m2.id)?.content, m2.content);
});

// ---------------------------------------------------------------------------
// ラウンド6（vaultDeletionのCRLF分割修正）：CRLF化されたday-fileから先頭
// memberを物理削除しても、残るmemberのVaultコピーは失われず、削除後の
// resync／復元スキャン／復旧計画でも、消したmemberが蘇ったり残るmemberが
// 失われたりしないことを、実経路（plan→apply→resync→scan→recovery plan）で固定する。
// ---------------------------------------------------------------------------

test("round6 (vaultDeletion CRLF): deleting the first member of a CRLF day-file keeps the survivor through deletion, resync, restore scan and recovery planning", async () => {
  const lfDay = healthyDay();
  const crlfDay = crlf(lfDay);
  const v = new MemVault({ [DAY_PATH]: crlfDay });
  seedRegistryEntry(v, DAY_KEY, DAY_PATH, {
    recordType: "memory-day",
    mtime: 0,
    size: bytes(crlfDay).length,
    contentHash: vault.hashVaultText(lfDay),
    memberIds: ["m1", "m2"],
    memberHashes: { m1: vault.hashVaultText(markdown.memoryObjectToMarkdown(memory("m1"))), m2: vault.hashVaultText(markdown.memoryObjectToMarkdown(memory("m2"))) },
  });
  const bucket = vault.vaultRegistryBucketOf(DAY_KEY);
  const shardPath = `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
  const files = new Map<string, string>([[DAY_PATH, crlfDay], [shardPath, v.text(shardPath)]]);
  const tomb = { v: 1, kind: "memory", id: "m1", deletedAt: T, date: T, vault: "unverified" } as unknown as Parameters<typeof deletion.buildVaultDeletionPlan>[1];
  const plan = deletion.buildVaultDeletionPlan(files, tomb, "delete-vault", 0);
  const dayEdit = plan.edits.find((e) => e.path === DAY_PATH);
  assert.ok(dayEdit, "the day-file is edited (not removed wholesale)");
  assert.equal(dayEdit!.after, crlf(markdown.memoryObjectToMarkdown(memory("m2"))), "only m1's segment is removed; m2 keeps its exact CRLF bytes");
  await deletion.applyVaultDeletionEdits(v.dir(), plan);
  assert.equal(v.text(DAY_PATH), crlf(markdown.memoryObjectToMarkdown(memory("m2"))));
  const rowAfterDelete = (await vault.readVaultRegistryShard(v.dir(), bucket)).files[DAY_PATH];
  assert.deepEqual(rowAfterDelete?.memberIds, ["m2"], "the registry row follows the file immediately after deletion");
  // resync：走査は完走し、ファイルは書き換えられない。状態はokには戻らない：
  // 削除側が安全側に倒した行（needs-resync＋基準は未検証のまま）に対して、
  // resyncは無言で基準を張り直さず conflict として表面化させるのが既存の
  // 意味論（削除を経ていない同じ行状態でも同じ結果になることを別途確認済み）。
  // memberIdsは現実どおり[m2]で、消えたm1が戻ることはない。
  const resync = await vault.resyncVaultRegistry(v.dir());
  assert.equal(resync.scanCompleted, true);
  assert.deepEqual(resync.applyErrors, []);
  const row = (await vault.readVaultRegistryShard(v.dir(), bucket)).files[DAY_PATH];
  assert.equal(row?.status, "conflict", "the downgraded CRLF container is surfaced for resolution, never silently blessed");
  assert.deepEqual(row?.memberIds, ["m2"]);
  assert.equal(v.text(DAY_PATH), crlf(markdown.memoryObjectToMarkdown(memory("m2"))), "resync never rewrites the file");
  // 復元スキャン：消したm1は蘇らず、残ったm2だけが見える。
  const scan = await vault.scanVaultForRestore(v.dir());
  assert.deepEqual(scan.memoryObjects.map((m) => m.id), ["m2"], "no resurrection of the deleted member");
  // 復旧計画：ローカルにm2しか無い前提で、m1に関する不足・競合を一切挙げない。
  const recoveryPlan = await recovery.buildVaultRecoveryPlan(v.dir(), local([], [memory("m2")]));
  assert.equal(recoveryPlan.records.some((r) => r.recordId === "m1"), false, "the deleted member is not planned for recovery");
  const m2Record = recoveryPlan.records.find((r) => r.recordId === "m2");
  assert.equal(m2Record?.memoryDay?.memberExists, true, "the survivor is still present as a member of the day-file");
  assert.equal(m2Record?.memoryDay?.memberSemanticEqual, true, "the survivor's content is intact");
});
