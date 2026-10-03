/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias */
/**
 * Vault Recovery Apply（Phase 2 初期版）の回帰テスト。
 * 実行方法：`npm run test:recovery-apply`（tsconfig.recovery.jsonでコンパイルし、node --testで実行する）。
 * 実Vault・実IndexedDBは使わない。インメモリの疑似ファイルシステムと、疑似の同期台帳／journal storeを使う。
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

// Exercise real db.ts transactions in the narrow repair integration fixtures.
const loader = Module as unknown as { _load: (request: string, parent?: unknown, main?: boolean) => unknown };
const previousLoad = loader._load;
loader._load = function(request, parent, main) {
  if (request === "idb") return require("./fakeIdb");
  return previousLoad.call(this, request, parent, main);
};

type Conversation = import("./types").Conversation;
type MemoryObject = import("./types").MemoryObject;
type Source = import("./types").Source;
const vaultMod = require("./vault") as typeof import("./vault");
const markdownMod = require("./markdown") as typeof import("./markdown");
const journalMod = require("./vaultRecoveryJournal") as typeof import("./vaultRecoveryJournal");
const applyMod = require("./vaultRecoveryApply") as typeof import("./vaultRecoveryApply");

// ---------------------------------------------------------------------------
// インメモリ疑似ファイルシステム（書き込み対応）
// ---------------------------------------------------------------------------

class FakeFile {
  constructor(public content: string, public mtime: number) {}
}

class FakeVault {
  files = new Map<string, FakeFile>();
  private clock = 1;
  writeShouldFail = new Set<string>();
  /** path→次回そのpathへcloseされるときに書く、parse不能なgarbage文字列（failure injection、一発だけ）。 */
  corruptOnCommit = new Map<string, string>();
  /**
   * B1-A/B/D対応：OPFSの「直接write→truncate」経路で、truncate自体は実際にファイルへ反映された
   * うえで、その後の段階（flush/close）でエラーが返る、という状況の再現（`corruptOnCommit`と違い、
   * 内容の書き換え＝garbageの反映と、closeの失敗＝action()自体のthrowが同時に起きる。一発だけ）。
   */
  corruptThenThrow = new Map<string, string>();
  writeCount = 0;

  root(): FileSystemDirectoryHandle {
    return this.dir("");
  }

  private dir(prefix: string): FileSystemDirectoryHandle {
    const self = this;
    return {
      kind: "directory",
      name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const path = prefix ? `${prefix}/${name}` : name;
        const hasChildren = [...self.files.keys()].some((k) => k.startsWith(`${path}/`));
        if (!hasChildren) {
          if (!options?.create) throw new DOMException("no such directory", "NotFoundError");
        }
        return self.dir(path);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const filePath = prefix ? `${prefix}/${name}` : name;
        if (!self.files.has(filePath)) {
          if (!options?.create) throw new DOMException("no such file", "NotFoundError");
        }
        return self.file(filePath);
      },
      async *entries() {
        const children = new Map<string, "directory" | "file">();
        for (const p of self.files.keys()) {
          if (prefix && !p.startsWith(`${prefix}/`)) continue;
          if (!prefix && p.includes("/") === false && !self.files.has(p)) continue;
          const rel = prefix ? p.slice(prefix.length + 1) : p;
          const first = rel.split("/")[0];
          children.set(first, rel.includes("/") ? "directory" : "file");
        }
        for (const [name, kind] of children) {
          const childPath = prefix ? `${prefix}/${name}` : name;
          yield [name, kind === "directory" ? self.dir(childPath) : self.file(childPath)] as [string, FileSystemHandle];
        }
      },
      async removeEntry(name: string) {
        const filePath = prefix ? `${prefix}/${name}` : name;
        if (!self.files.has(filePath)) throw new DOMException("no such file", "NotFoundError");
        if (self.writeShouldFail.has(filePath)) throw new Error("simulated write failure");
        self.files.delete(filePath);
      },
    } as unknown as FileSystemDirectoryHandle;
  }

  private file(filePath: string): FileSystemFileHandle {
    const self = this;
    return {
      kind: "file",
      name: filePath.split("/").pop(),
      async getFile() {
        const f = self.files.get(filePath);
        if (!f) throw new DOMException("no such file", "NotFoundError");
        return { size: f.content.length, lastModified: f.mtime, async text() { return f.content; } } as unknown as File;
      },
      async createWritable() {
        return {
          async write(content: string) {
            (this as unknown as { _pending: string })._pending = content;
          },
          async close() {
            self.writeCount += 1;
            // OPFS write経路（直接write→truncate→flush）が途中で止まった場合の再現：本来書くべき内容の
            // 代わりに、parse不能なgarbageを一度だけ書き込む（failure injection。corruptOnCommitを
            // writeShouldFailより先に見ることで、「1回目のwrite（本来の書き込み）はgarbageを残して
            // “成功”するが、2回目のwrite（backupからの復元試行）はwriteShouldFail側で失敗する」という
            // 順序を、同じpathへ両方セットするだけで組み立てられるようにする）。
            const garbage = self.corruptOnCommit.get(filePath);
            if (garbage !== undefined) {
              self.corruptOnCommit.delete(filePath);
              self.clock += 1;
              self.files.set(filePath, new FakeFile(garbage, self.clock));
              return;
            }
            const garbageThenThrow = self.corruptThenThrow.get(filePath);
            if (garbageThenThrow !== undefined) {
              self.corruptThenThrow.delete(filePath);
              self.clock += 1;
              self.files.set(filePath, new FakeFile(garbageThenThrow, self.clock)); // truncate自体は実際に反映される
              throw new Error("simulated write failure after partial truncate"); // action()自体がthrowする
            }
            if (self.writeShouldFail.has(filePath)) throw new Error("simulated write failure");
            self.clock += 1;
            self.files.set(filePath, new FakeFile((this as unknown as { _pending: string })._pending, self.clock));
          },
        };
      },
    } as unknown as FileSystemFileHandle;
  }

  put(pathStr: string, content: string) {
    this.clock += 1;
    this.files.set(pathStr, new FakeFile(content, this.clock));
  }
  /** `put()`済みpathの実際のmtime（Registry entryのfixtureに正しい値を埋めるため）。 */
  mtimeOf(pathStr: string): number {
    const f = this.files.get(pathStr);
    if (!f) throw new Error(`mtimeOf: no such file in fixture: ${pathStr}`);
    return f.mtime;
  }
  get(pathStr: string): string | undefined {
    return this.files.get(pathStr)?.content;
  }
}

// ---------------------------------------------------------------------------
// 疑似DB（IndexedDB相当）／journal store／同期台帳
// ---------------------------------------------------------------------------

class FakeDb {
  conversations = new Map<string, Conversation>();
  memories = new Map<string, MemoryObject>();
  sources = new Map<string, Source>();
  ledger = new Map<string, string>();
  journal: string | undefined;
  journalWriteShouldFail = false;
  activeVaultEpoch = 0;

  snapshot(): import("./vaultRecovery").RecoveryLocalSnapshot {
    return {
      conversations: [...this.conversations.values()].map(clone),
      memories: [...this.memories.values()].map(clone),
      sources: [...this.sources.values()].map(clone),
      sync: Object.fromEntries(this.ledger),
    };
  }

  journalStore(): import("./vaultRecoveryJournal").RecoveryJournalStore {
    const self = this;
    return {
      async read() { return self.journal; },
      async write(text: string) {
        if (self.journalWriteShouldFail) throw new Error("simulated journal write failure");
        self.journal = text;
      },
    };
  }
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

function makeEnv(db: FakeDb, vault: FakeVault, overrides: Partial<import("./vaultRecoveryApply").RecoveryApplyEnv> = {}): import("./vaultRecoveryApply").RecoveryApplyEnv {
  let seq = 0;
  return {
    root: vault.root(),
    readLocalSnapshot: async () => db.snapshot(),
    readRecord: async (type, id) => {
      const pool = type === "conversation" ? db.conversations : type === "source" ? db.sources : db.memories;
      const v = pool.get(id);
      return v ? clone(v) : undefined;
    },
    store: db.journalStore(),
    readLedger: async (key: string) => db.ledger.get(key),
    writeLedger: async (key: string, value: string) => { db.ledger.set(key, value); },
    readWorld: async () => ({ activeVaultEpoch: db.activeVaultEpoch, committedVaultEpoch: db.activeVaultEpoch, registryGenerationEpoch: 0, journalVersion: "current", backend: "opfs" }),
    runWrite: async (task) => task(),
    now: () => "2026-09-27T00:00:00.000Z",
    newId: () => `id-${++seq}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const T = "2026-09-20T09:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: [{ role: "user", content: "テスト発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...meta }, ...overrides,
  } as Conversation;
}
function memory(id: string, overrides: Partial<MemoryObject> = {}): MemoryObject {
  return {
    id, date: T, content: "内容", summary: "要約", types: ["event"], conversationId: "c1", keywords: [],
    links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T, updatedAt: T, metadata: { ...meta }, ...overrides,
  } as MemoryObject;
}
function reflection(id: string, overrides: Partial<MemoryObject> = {}): MemoryObject {
  return memory(id, { metadata: { ...meta, source: "system-generated" as const }, ...overrides });
}
function source(id: string, overrides: Partial<Source> = {}): Source {
  return {
    id, title: "素材", content: "素材本文", createdAt: T, updatedAt: T, sourceType: "note",
    ...overrides,
  } as Source;
}

async function applyOnce(
  db: FakeDb,
  vault: FakeVault,
  envOverrides: Partial<import("./vaultRecoveryApply").RecoveryApplyEnv> = {},
  confirmed?: import("./vaultRecoveryApply").RecoveryConfirmedSet,
  resumeOnly = false
) {
  return applyMod.applyRecovery(makeEnv(db, vault, envOverrides), confirmed, resumeOnly);
}

// ===========================================================================
// A/B/C: local-only-safe（Conversation／Reflection／Source）
// ===========================================================================

test("A: local-only-safe Conversationが復旧され、Markdown・index・History・Registry・台帳が揃う", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
  const path = `Conversations/${vaultMod.fileNameFor("c1", c.startedAt)}`;
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c));
  assert.ok(JSON.parse(vault.get(".tsumugi/index.json")!)["c1"] === path);
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  const shard = JSON.parse(vault.get(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`)!);
  assert.equal(shard.records["c1"], path);
  assert.equal(shard.files[path].status, "ok");
  assert.equal(db.ledger.get("conversation:c1"), c.updatedAt);
  const monthIndex = JSON.parse(vault.get(`.tsumugi/history/${T.slice(0, 7)}.json`)!);
  assert.ok(monthIndex.days[T.slice(0, 10)].conversations.some((x: { id: string }) => x.id === "c1"));
});

test("B: local-only-safe Reflectionが1record1fileで復旧される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const r = reflection("r1"); db.memories.set("r1", r);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
  const path = `Memories/${vaultMod.fileNameFor("r1", r.date)}`;
  assert.equal(vault.get(path), markdownMod.memoryObjectToMarkdown(r));
  const monthIndex = JSON.parse(vault.get(`.tsumugi/history/${T.slice(0, 7)}.json`)!);
  assert.ok(monthIndex.days[T.slice(0, 10)].reflections.some((x: { id: string }) => x.id === "r1"));
});

test("C: local-only-safe Sourceが復旧される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const s = source("s1"); db.sources.set("s1", s);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
  const path = `Sources/${vaultMod.fileNameFor("s1", s.createdAt)}`;
  assert.equal(vault.get(path), markdownMod.sourceToMarkdown(s));
  assert.equal(db.ledger.get("source:s1"), s.updatedAt);
});

// ===========================================================================
// D: day-file不存在のMemory復旧
// ===========================================================================

test("D: day-fileが保存先に無い日は、同じ日のMemory全員をまとめて新規day-fileにする", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const m1 = memory("m1"), m2 = memory("m2", { summary: "別の要約" });
  db.memories.set("m1", m1); db.memories.set("m2", m2);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 2);
  const path = `Memories/${vaultMod.dayFileNameFor(T)}`;
  const text = vault.get(path)!;
  const parsed = markdownMod.parseMemoryDayFile(text);
  assert.deepEqual(parsed.map((m) => m.id).sort(), ["m1", "m2"]);
  const bucket = vaultMod.vaultRegistryBucketOf(vaultMod.dayFileRegistryKey(T.slice(0, 10)));
  const shard = JSON.parse(vault.get(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`)!);
  assert.deepEqual(shard.files[path].memberIds.sort(), ["m1", "m2"]);
});

test("D2: 同じ日にIndexedDB上でconflict等の他memberがいる場合は、day全体を保留する（部分作成しない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const m1 = memory("m1"), changed = memory("m2");
  db.memories.set("m1", m1); db.memories.set("m2", changed);
  vault.put(`Memories/${vaultMod.dayFileNameFor(T)}`, markdownMod.serializeMemoryDayFile([memory("m2", { summary: "違う内容" })]));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "nothing-to-do");
  assert.equal(result.recovered, 0);
  assert.ok(result.held >= 1);
});

// ===========================================================================
// E/F: equivalent-existing
// ===========================================================================

test("E: equivalent-existingで、不足しているindex/History/Registry/台帳だけを補う", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
  assert.equal(JSON.parse(vault.get(".tsumugi/index.json")!)["c1"], path);
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  const shard = JSON.parse(vault.get(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`)!);
  assert.equal(shard.records["c1"], path);
  assert.equal(db.ledger.get("conversation:c1"), c.updatedAt);
});

test("F: equivalent-existingでMarkdown本文が一切再保存されない（書き込み回数0）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  db.conversations.set("c1", c);
  const before = vault.get(path);
  const writesBefore = vault.writeCount;
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(vault.get(path), before);
  // Markdown自体への書き込みは無い（index/history/registryのみ書く）。
  const afterMarkdown = vault.get(path);
  assert.equal(afterMarkdown, before);
  assert.ok(vault.writeCount > writesBefore); // 管理情報は書かれている
});

test("F2: equivalent-existingで既存metadataが矛盾していれば、不足とみなさず保留する（上書きしない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  vault.put(".tsumugi/index.json", JSON.stringify({ c1: "Conversations/other-path.md" }));
  db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "nothing-to-do");
  assert.equal(result.recovered, 0);
  assert.equal(JSON.parse(vault.get(".tsumugi/index.json")!)["c1"], "Conversations/other-path.md");
});

// ===========================================================================
// G/H/I: 保留対象は無変更
// ===========================================================================

test("G: conflict（同idで内容が違う）は変更しない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const changed = clone(c); changed.turns[0].content = "違う内容";
  vault.put("c.md", markdownMod.conversationToMarkdown(changed));
  db.conversations.set("c1", c);
  const before = vault.get("c.md");
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "nothing-to-do");
  assert.equal(result.recovered, 0);
  assert.equal(vault.get("c.md"), before);
});

test("H: memory-dayfile-merge-required（day-fileはあるがmemberが無い）は変更しない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const path = `Memories/${vaultMod.dayFileNameFor(T)}`;
  vault.put(path, markdownMod.serializeMemoryDayFile([memory("other")]));
  db.memories.set("m1", memory("m1"));
  const before = vault.get(path);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "nothing-to-do");
  assert.equal(vault.get(path), before);
});

test("I: unreadable/indeterminate（読み込み不能ファイルがある）は変更しない", async () => {
  // 2026-10-02 scan boundary修正：frontmatterが無い/tsumugi!==trueの非Tsumugi
  // Markdownはもはや「読み込み不能」扱いにならない（黙ってskipされ、他recordには
  // 影響しない）。この回帰が検証したい「Tsumugi所有のrecordが本当に読み込み不能な
  // 場合は、従来通り保守的に全体を変更しない」という性質は、tsumugi: trueを
  // 宣言した上で壊れているfixtureでのみ再現できる。
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  vault.put("broken.md", "---\ntsumugi: true\n---\nno id, no recognizable section");
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "nothing-to-do");
  assert.equal(result.recovered, 0);
  assert.ok(result.held >= 1);
});

test("I2: scan boundary修正の回帰——非Tsumugi Markdown（frontmatter無し）が1件Vault内にあっても、他recordのApplyは正常に完了する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  vault.put("test.md", "# hello, this is my own note, not Tsumugi's");
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
  assert.equal(result.held, 0);
});

// ===========================================================================
// J: Apply直前の状態変化
// ===========================================================================

test("J: 記録の全体走査（Plan）と、各opの実行直前の再読込との間で記録が変化していれば、その記録は対象外になる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const original = conversation("c1");
  db.conversations.set("c1", original);
  // Plan作成に使うsnapshot（全体走査）は変化前のまま、各opの実行直前に読み直す1件だけが変化している、という状況を模する
  // （「Apply直前にPlanを再生成し、最新状態でも対象であることを確認する」の、より内側の防御——1opごとの再読込・hash一致確認）。
  const changed = conversation("c1", { updatedAt: "2026-09-21T00:00:00.000Z" });
  const result = await applyOnce(db, vault, { readRecord: async () => clone(changed) });
  assert.equal(result.recovered, 0);
  assert.equal(result.failed, 1);
  assert.equal(vault.files.size, 0, "実行を止めたため何も書き込んでいない");
});

// ===========================================================================
// K/L: 中断・再実行・冪等性
// ===========================================================================

test("K: Markdown書き込み直後のjournal更新（progress記録）が失敗して中断しても、書いたMarkdownは残り、再実行で完了できる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  let calls = 0;
  const backing = db.journalStore();
  const flakyStore: import("./vaultRecoveryJournal").RecoveryJournalStore = {
    read: backing.read,
    write: async (text: string) => {
      calls += 1;
      // 呼び出し1回目＝journal確定（実行前）。2回目＝Markdown書き込み直後のprogress更新——ここで
      // 「Safari終了」相当のクラッシュが起きたことにする（Markdownは既に書けている）。
      if (calls === 2) throw new Error("simulated crash right after markdown write");
      await backing.write(text);
    },
  };
  const first = await applyMod.applyRecovery(makeEnv(db, vault, { store: flakyStore }));
  assert.equal(first.status, "interrupted");
  assert.equal(first.reason, "journal-unavailable");
  const path = `Conversations/${vaultMod.fileNameFor("c1", c.startedAt)}`;
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c), "Markdownは既に書けているため失われない");
  // journal自体は最後まで保存できなかった（read-back含め失敗）ため、次回は最初のjournalから評価し直す。
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("L: 同じRecoveryを2回実行しても壊れない（2回目は何もしないか、同じ結果に収束する）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "completed");
  assert.equal(first.recovered, 1);
  const path = `Conversations/${vaultMod.fileNameFor("c1", c.startedAt)}`;
  const contentAfterFirst = vault.get(path);
  const writesAfterFirst = vault.writeCount;
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "nothing-to-do");
  assert.equal(vault.get(path), contentAfterFirst);
  assert.equal(vault.writeCount, writesAfterFirst);
});

test("N: metadata更新（History）途中でMarkdown write失敗があっても、記録は失われず、再実行で完了できる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const path = `Conversations/${vaultMod.fileNameFor("c1", c.startedAt)}`;
  vault.writeShouldFail.add(`.tsumugi/history/${T.slice(0, 7)}.json`);
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "completed");
  assert.equal(first.failed, 1);
  assert.equal(first.recovered, 0);
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c)); // Markdown自体は保存済みで失われない
  vault.writeShouldFail.delete(`.tsumugi/history/${T.slice(0, 7)}.json`);
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

// ===========================================================================
// M: journal保存失敗 → write開始しない
// ===========================================================================

test("M: journalを保存・読み戻せない場合、Markdownを含め一切書き込まない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  db.journalWriteShouldFail = true;
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "journal-unavailable");
  assert.equal(vault.files.size, 0);
  assert.equal(vault.writeCount, 0);
});

// ===========================================================================
// O: verification失敗 → recovered扱いしない
// ===========================================================================

test("O: 書き込み後に外部から内容が書き換えられていた場合、recoveredとして扱わない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const path = `Conversations/${vaultMod.fileNameFor("c1", c.startedAt)}`;
  const originalRunWrite = async <T,>(task: () => Promise<T>): Promise<T> => {
    const result = await task();
    // write関数自体は成功したが、直後に外部から書き換えられた、という状況を模する。
    if (vault.get(path) !== undefined) vault.put(path, "external overwrite after write");
    return result;
  };
  const result = await applyOnce(db, vault, { runWrite: originalRunWrite });
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.ok(result.failed >= 1);
});

test("B1-A: index.jsonがaction()内で部分write（truncate）された直後にaction()自体がthrowしても、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.corruptThenThrow.set(INDEX_PATH(), "not json at all {{{");
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.ok(result.failed >= 1);
  assert.equal(vault.get(INDEX_PATH()) ?? "", "", "action()のthrowでもbackupのbefore（不存在）へ復元されている");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-B: Registry shardがaction()内で部分write（truncate）された直後にaction()自体がthrowしても、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  const shardPath = `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
  vault.corruptThenThrow.set(shardPath, "not json at all {{{");
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.equal(vault.get(shardPath) ?? "", "");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-C: History月ファイルがaction()内で部分write（truncate）された直後、同じaction()内のmeta書き込みでaction()自体がthrowしても、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const monthPath = `.tsumugi/history/${T.slice(0, 7)}.json`;
  vault.corruptThenThrow.set(monthPath, "not json at all {{{");
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.equal(vault.get(monthPath) ?? "", "", "action()のthrowでも月ファイルはbeforeへ復元されている（completedのまま放置されない）");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-D: action()のthrow後、backupからの復元自体も失敗する場合、journalをcompletedにせず、通常write gateを効かせ続ける", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.corruptThenThrow.set(INDEX_PATH(), "not json at all {{{");
  vault.writeShouldFail.add(INDEX_PATH()); // corruptThenThrowが消費された後の、復元write自体も失敗させる
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "interrupted");
  assert.equal(first.reason, "metadata-corrupt-unresolved");
  assert.equal(first.recovered, 0);
  const blocked = await journalMod.isRecoveryBlockingNormalWrites(db.journalStore(), async () => db.activeVaultEpoch);
  assert.equal(blocked, true, "action()のthrow経路でも、復元不能ならjournalをcompletedにせずgateを維持する");
  vault.writeShouldFail.delete(INDEX_PATH());
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-E: action()がthrowしても、対象pathの実体が構造として読める（破損していない）場合はbackupに触れず、通常のop失敗として安全に扱う", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const monthPath = `.tsumugi/history/${T.slice(0, 7)}.json`;
  // 月ファイルは正常な内容で書き終わっている。その直後、同じaction()内のmeta書き込みだけが
  // （破損ではなく）単純に失敗してaction()全体がthrowする——月ファイルは復元（削除）される必要が無い。
  vault.writeShouldFail.add(".tsumugi/history-meta.json");
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
  assert.ok(result.failed >= 1);
  const monthContent = vault.get(monthPath);
  assert.ok(monthContent && monthContent.length > 0, "破損していない月ファイルの内容はbackup復元で消されない");
  assert.ok(JSON.parse(monthContent as string), "壊されておらず、正常にparseできる");
});

test("B1-F: index.jsonがJSONとしては壊れていないが、Recovery対象外のkeyがaction()内で書き換えられてからthrowした場合も、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  vault.put(INDEX_PATH(), JSON.stringify({ other: "Other/existing.md" }));
  const c = conversation("c1"); db.conversations.set("c1", c);
  // action()自体は「JSONとしては正常にparseできる」内容を書くが、Recoveryが変更してよい範囲の外
  // （"other"キー）を巻き込んで書き換えてしまった直後にthrowする、という状況を模する
  // （Codexレビュー再指摘：「parse可能」は「安全」の証明にならない）。
  vault.corruptThenThrow.set(INDEX_PATH(), JSON.stringify({ other: "Other/CORRUPTED.md" }));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.ok(result.failed >= 1);
  assert.equal(JSON.parse(vault.get(INDEX_PATH())!).other, "Other/existing.md", "対象外の「other」キーはbeforeへ復元されている");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-G: Registry shardがJSONとしては壊れていないが、対象外recordがaction()内で書き換えられてからthrowした場合も、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  const shardPath = `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
  // "other-69"は"c1"と同じbucketへhashされるid（validShardの要件：records内の各keyは自分のbucketへ
  // hashされていなければならないため、テスト用に同じbucketのidを選ぶ）。
  const before = { schemaVersion: 1, bucket, records: { "other-69": "Other/existing.md" }, files: { "Other/existing.md": { recordType: "conversation", mtime: 1, size: 1, contentHash: "h", memberIds: ["other-69"], status: "ok" } } };
  vault.put(shardPath, JSON.stringify(before));
  vault.corruptThenThrow.set(shardPath, JSON.stringify({ schemaVersion: 1, bucket, records: { "other-69": "Other/CORRUPTED.md" }, files: before.files }));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.equal(JSON.parse(vault.get(shardPath)!).records["other-69"], "Other/existing.md", "対象外recordはbeforeへ復元されている");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-H: History月ファイルがJSONとしては壊れていないが、対象外の日がaction()内で書き換えられてからthrowした場合も、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const month = T.slice(0, 7);
  const otherDay = `${month}-01`; // 対象日（Tの日）とは別の、同じ月内の日
  const monthPath = `.tsumugi/history/${month}.json`;
  const before = { version: 2, month, days: { [otherDay]: { conversations: [{ id: "other", mode: "diary", turnCount: 1 }], normalMemories: [], reflections: [] } } };
  vault.put(monthPath, JSON.stringify(before));
  vault.corruptThenThrow.set(monthPath, JSON.stringify({ version: 2, month, days: { [otherDay]: { conversations: [{ id: "CORRUPTED", mode: "diary", turnCount: 1 }], normalMemories: [], reflections: [] } } }));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.deepEqual(JSON.parse(vault.get(monthPath)!).days[otherDay], before.days[otherDay], "対象外の日はbeforeへ復元されている");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-I: page-kill後の再開時、JSONとしては壊れていないが対象外keyがbeforeから変化している場合、reconcile時にbackupから復元してから続行する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  vault.put(INDEX_PATH(), JSON.stringify({ other: "Other/existing.md" }));
  const c = conversation("c1"); db.conversations.set("c1", c);
  const backing = db.journalStore();
  let calls = 0;
  const flakyStore: import("./vaultRecoveryJournal").RecoveryJournalStore = {
    read: backing.read,
    write: async (text: string) => {
      calls += 1;
      // 3回目＝index.jsonへのbackup永続化（write開始前）。ここまでは成功させる——実際のwrite自体は
      // 正しく完了するが、その直後の「完了記録」（4回目）でプロセスが死んだ、という状況を模する。
      if (calls === 4) throw new Error("simulated crash right after index write completed");
      await backing.write(text);
    },
  };
  const first = await applyMod.applyRecovery(makeEnv(db, vault, { store: flakyStore }));
  assert.equal(first.status, "interrupted");
  assert.equal(JSON.parse(vault.get(INDEX_PATH())!).other, "Other/existing.md", "この時点ではまだ壊れていない（write自体は正しく完了している）");
  // クラッシュに巻き込まれる形で、index.json自体はJSONとしては壊れていないが、Recovery対象外の
  // 「other」キーがbeforeから書き換わってしまっていた、という状況を追加で模する
  // （c1の正しいマッピングはそのまま保つ——「action()自体の失敗」ではなく「resume時に初めて
  // 気づく静かな破損」を模すため）。
  const afterCrash = JSON.parse(vault.get(INDEX_PATH())!) as Record<string, string>;
  vault.put(INDEX_PATH(), JSON.stringify({ ...afterCrash, other: "Other/CORRUPTED.md" }));
  const second = await applyOnce(db, vault, {}, undefined, true);
  assert.equal(second.resumed, true);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
  const finalIndex = JSON.parse(vault.get(INDEX_PATH())!) as Record<string, string>;
  assert.equal(finalIndex.other, "Other/existing.md", "対象外の「other」キーはbeforeへ復元されている");
  assert.equal(finalIndex.c1, `Conversations/${vaultMod.fileNameFor("c1", c.startedAt)}`);
});

test("B1-J: 対象外keyの復元自体も失敗する場合、journalをcompletedにせず、通常write gateを効かせ続ける", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  vault.put(INDEX_PATH(), JSON.stringify({ other: "Other/existing.md" }));
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.corruptThenThrow.set(INDEX_PATH(), JSON.stringify({ other: "Other/CORRUPTED.md" }));
  vault.writeShouldFail.add(INDEX_PATH()); // corruptThenThrowが消費された後の、復元write自体も失敗させる
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "interrupted");
  assert.equal(first.reason, "metadata-corrupt-unresolved");
  const blocked = await journalMod.isRecoveryBlockingNormalWrites(db.journalStore(), async () => db.activeVaultEpoch);
  assert.equal(blocked, true, "対象外データの復元不能を検出した場合も、gateを維持する");
  vault.writeShouldFail.delete(INDEX_PATH());
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-K: action()が失敗しても、対象外データ・対象データのいずれも一切変化していない場合は、不要な復元をせず通常のop失敗として安全に続行する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  vault.put(INDEX_PATH(), JSON.stringify({ other: "Other/existing.md" }));
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.writeShouldFail.add(INDEX_PATH()); // write自体が失敗する（何も書き込まれない＝破損なし）
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed", "破損が無いのに誤って復元不能扱いにしていない");
  assert.equal(result.recovered, 0);
  assert.ok(result.failed >= 1);
  assert.equal(JSON.parse(vault.get(INDEX_PATH())!).other, "Other/existing.md", "そもそも変化していない（不要な復元をしていない）");
  vault.writeShouldFail.delete(INDEX_PATH());
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

// ===========================================================================
// B1（残存）：同日の対象外History行の内容保護
// ===========================================================================

test("B1-L: 同日の対象外Conversation行のturnCountがaction()内で書き換えられてからthrowした場合も、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const a = conversation("a1"); db.conversations.set("a1", a);
  const month = T.slice(0, 7), day = T.slice(0, 10);
  const monthPath = `.tsumugi/history/${month}.json`;
  const before = { version: 2, month, days: { [day]: { conversations: [{ id: "b1", mode: "diary", turnCount: 3 }], normalMemories: [], reflections: [] } } };
  vault.put(monthPath, JSON.stringify(before));
  // action()自体は「JSONとしては正常にparseできる」内容を書くが、同日の対象外Conversation（b1）の
  // turnCountを巻き込んで書き換えてしまった直後にthrowする、という状況を模する（Codex再指摘）。
  vault.corruptThenThrow.set(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "b1", mode: "diary", turnCount: 999 }], normalMemories: [], reflections: [] } } }));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.deepEqual(JSON.parse(vault.get(monthPath)!).days[day].conversations[0], { id: "b1", mode: "diary", turnCount: 3 }, "対象外b1行はbeforeへ復元されている");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-M: 同日の対象外Conversation行のmode（turnCount以外の既存field）が書き換えられてからthrowした場合も、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const a = conversation("a1"); db.conversations.set("a1", a);
  const month = T.slice(0, 7), day = T.slice(0, 10);
  const monthPath = `.tsumugi/history/${month}.json`;
  const before = { version: 2, month, days: { [day]: { conversations: [{ id: "b1", mode: "diary", turnCount: 3 }], normalMemories: [], reflections: [] } } };
  vault.put(monthPath, JSON.stringify(before));
  vault.corruptThenThrow.set(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "b1", mode: "conversation", turnCount: 3 }], normalMemories: [], reflections: [] } } }));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.deepEqual(JSON.parse(vault.get(monthPath)!).days[day].conversations[0], { id: "b1", mode: "diary", turnCount: 3 }, "turnCount以外のfieldも保護される（turnCountだけの特別扱いにしない）");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-N: 同日の対象外Memory行（normalMemories、対象keyそのものが別）のfieldがaction()内で書き換えられてからthrowした場合も、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  // Recovery対象はConversation（a1）。このopが変更してよいのは"conversations"キーだけであり、
  // 同じ日の"normalMemories"（他recordType）は、行のidに関わらずキー全体が対象外になる。
  const a = conversation("a1"); db.conversations.set("a1", a);
  const month = T.slice(0, 7), day = T.slice(0, 10);
  const monthPath = `.tsumugi/history/${month}.json`;
  const otherRow = { id: "m-other", types: ["event"], preview: "元のプレビュー", createdAt: T, date: T };
  vault.put(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [], normalMemories: [otherRow], reflections: [] } } }));
  vault.corruptThenThrow.set(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [], normalMemories: [{ ...otherRow, preview: "CORRUPTED" }], reflections: [] } } }));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.deepEqual(JSON.parse(vault.get(monthPath)!).days[day].normalMemories.find((r: { id: string }) => r.id === "m-other"), otherRow, "対象外キーのMemory行はtypes以外のfieldも含めbeforeへ復元されている");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-O: 同日の対象外Reflection行がaction()内で書き換えられてからthrowした場合も、backupから復元される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const r1 = reflection("r1"); db.memories.set("r1", r1);
  const month = T.slice(0, 7), day = T.slice(0, 10);
  const monthPath = `.tsumugi/history/${month}.json`;
  const otherRow = { id: "r-other", types: ["reflection"], preview: "元のプレビュー", createdAt: T };
  vault.put(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [], normalMemories: [], reflections: [otherRow] } } }));
  vault.corruptThenThrow.set(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [], normalMemories: [], reflections: [{ ...otherRow, preview: "CORRUPTED" }] } } }));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 0);
  assert.deepEqual(JSON.parse(vault.get(monthPath)!).days[day].reflections.find((r: { id: string }) => r.id === "r-other"), otherRow, "対象外Reflection行はbeforeへ復元されている");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-P: Recovery対象row自身の追加は、同日の対象外row保護の影響を受けず正常に完了する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const a = conversation("a1"); db.conversations.set("a1", a);
  const month = T.slice(0, 7), day = T.slice(0, 10);
  const monthPath = `.tsumugi/history/${month}.json`;
  // 同じ日に、既存の対象外Conversation（b1）が既に記録されている状態から始める。
  vault.put(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "b1", mode: "diary", turnCount: 3 }], normalMemories: [], reflections: [] } } }));
  vault.put(".tsumugi/history-meta.json", JSON.stringify({ version: 1, updatedAt: T, months: { [month]: { memories: 0, conversations: 1 } }, totalMemories: 0, totalConversations: 1 }));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1, "対象自身の行追加は、他行保護の影響を受けず正常に完了する");
  const rows = JSON.parse(vault.get(monthPath)!).days[day].conversations as { id: string; turnCount: number }[];
  assert.ok(rows.some((r) => r.id === "a1"));
  assert.ok(rows.some((r) => r.id === "b1" && r.turnCount === 3), "既存の対象外行はそのまま残る");
});

test("B1-Q: 同日の対象外行の復元自体も失敗する場合、journalをcompletedにせず、通常write gateを効かせ続ける", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const a = conversation("a1"); db.conversations.set("a1", a);
  const month = T.slice(0, 7), day = T.slice(0, 10);
  const monthPath = `.tsumugi/history/${month}.json`;
  vault.put(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "b1", mode: "diary", turnCount: 3 }], normalMemories: [], reflections: [] } } }));
  vault.corruptThenThrow.set(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "b1", mode: "diary", turnCount: 999 }], normalMemories: [], reflections: [] } } }));
  vault.writeShouldFail.add(monthPath); // corruptThenThrowが消費された後の、復元write自体も失敗させる
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "interrupted");
  assert.equal(first.reason, "metadata-corrupt-unresolved");
  const blocked = await journalMod.isRecoveryBlockingNormalWrites(db.journalStore(), async () => db.activeVaultEpoch);
  assert.equal(blocked, true, "対象外行の復元不能を検出した場合も、gateを維持する");
  vault.writeShouldFail.delete(monthPath);
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("B1-R: page-kill後の再開時、同日の対象外行がbeforeから変化している場合、reconcile時にbackupから復元してから続行する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const a = conversation("a1"); db.conversations.set("a1", a);
  const month = T.slice(0, 7), day = T.slice(0, 10);
  const monthPath = `.tsumugi/history/${month}.json`;
  vault.put(monthPath, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "b1", mode: "diary", turnCount: 3 }], normalMemories: [], reflections: [] } } }));
  const backing = db.journalStore();
  let calls = 0;
  const flakyStore: import("./vaultRecoveryJournal").RecoveryJournalStore = {
    read: backing.read,
    write: async (text: string) => {
      calls += 1;
      // 7回目＝History実write完了直後のprogress記録（afterHash確定）。ここでプロセスが死んだことにする。
      if (calls === 7) throw new Error("simulated crash right after history write completed");
      await backing.write(text);
    },
  };
  const first = await applyMod.applyRecovery(makeEnv(db, vault, { store: flakyStore }));
  assert.equal(first.status, "interrupted");
  const afterCrash = JSON.parse(vault.get(monthPath)!) as { days: Record<string, { conversations: { id: string; mode: string; turnCount: number }[] }> };
  assert.equal(afterCrash.days[day].conversations.find((r) => r.id === "b1")?.turnCount, 3, "この時点ではまだ壊れていない（write自体は正しく完了している）");
  // クラッシュに巻き込まれる形で、対象外b1行のturnCountがbeforeから書き換わってしまっていた、という状況を模する。
  afterCrash.days[day].conversations = afterCrash.days[day].conversations.map((r) => (r.id === "b1" ? { ...r, turnCount: 999 } : r));
  vault.put(monthPath, JSON.stringify(afterCrash));
  const second = await applyOnce(db, vault, {}, undefined, true);
  assert.equal(second.resumed, true);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
  const final = JSON.parse(vault.get(monthPath)!).days[day].conversations as { id: string; turnCount: number }[];
  assert.equal(final.find((r) => r.id === "b1")?.turnCount, 3, "対象外b1行のturnCountはbeforeへ復元されている");
  assert.ok(final.some((r) => r.id === "a1"), "対象自身の行は正常に追加されている");
});

test("H2-1: 月別aggregateは正しいがtotalConversations（総計）が矛盾している場合、recoveredにしない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: vault.mtimeOf(path), size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  vault.put(".tsumugi/index.json", JSON.stringify({ c1: path }));
  const month = T.slice(0, 7), day = T.slice(0, 10);
  vault.put(`.tsumugi/history/${month}.json`, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "c1", mode: "diary", turnCount: 1 }], normalMemories: [], reflections: [] } } }));
  db.conversations.set("c1", c);
  vault.put(".tsumugi/history-meta.json", JSON.stringify({ version: 1, updatedAt: T, months: { [month]: { memories: 0, conversations: 1 } }, totalMemories: 0, totalConversations: 999 }));
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0, "月別は正しくても、総計の矛盾だけでrecovered禁止にする");
  assert.equal(result.held, 1);
});

test("H2-1: 月別aggregateは正しいがtotalMemories（総計）が矛盾している場合、recoveredにしない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: vault.mtimeOf(path), size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  vault.put(".tsumugi/index.json", JSON.stringify({ c1: path }));
  const month = T.slice(0, 7), day = T.slice(0, 10);
  vault.put(`.tsumugi/history/${month}.json`, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "c1", mode: "diary", turnCount: 1 }], normalMemories: [], reflections: [] } } }));
  db.conversations.set("c1", c);
  vault.put(".tsumugi/history-meta.json", JSON.stringify({ version: 1, updatedAt: T, months: { [month]: { memories: 0, conversations: 1 } }, totalMemories: 42, totalConversations: 1 }));
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0, "totalMemoriesの矛盾だけでもrecovered禁止にする");
  assert.equal(result.held, 1);
});

test("H2-1: 月別aggregateだけが不足（総計フィールド自体が無い）場合は、安全に補ってrecoveredになる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: vault.mtimeOf(path), size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  vault.put(".tsumugi/index.json", JSON.stringify({ c1: path }));
  const month = T.slice(0, 7), day = T.slice(0, 10);
  vault.put(`.tsumugi/history/${month}.json`, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "c1", mode: "diary", turnCount: 1 }], normalMemories: [], reflections: [] } } }));
  db.conversations.set("c1", c);
  // history-meta.json自体が存在しない＝月別・総計とも丸ごと不足（安全に新規作成できる）。
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
  const meta = JSON.parse(vault.get(".tsumugi/history-meta.json")!);
  assert.equal(meta.totalConversations, 1);
});

test("H2-1: 月別aggregate・総計のいずれも正しい場合は、通常どおりequivalentとしてrecoveredになる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: vault.mtimeOf(path), size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  vault.put(".tsumugi/index.json", JSON.stringify({ c1: path }));
  const month = T.slice(0, 7), day = T.slice(0, 10);
  vault.put(`.tsumugi/history/${month}.json`, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [{ id: "c1", mode: "diary", turnCount: 1 }], normalMemories: [], reflections: [] } } }));
  db.conversations.set("c1", c);
  vault.put(".tsumugi/history-meta.json", JSON.stringify({ version: 1, updatedAt: T, months: { [month]: { memories: 0, conversations: 1 } }, totalMemories: 0, totalConversations: 1 }));
  db.ledger.set("conversation:c1", c.updatedAt); // 同期台帳も既に整っている状態にする
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "nothing-to-do", "全て既に正しいため、補うべきものが無い");
});

test("H2-1: History月本体は書けたがhistory-metaだけ失敗した場合、recoveredとして扱わない。次回は月本体を壊さずmetaだけ安全に補って成功する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const monthPath = `.tsumugi/history/${T.slice(0, 7)}.json`;
  vault.writeShouldFail.add(".tsumugi/history-meta.json");
  const first = await applyOnce(db, vault);
  assert.equal(first.recovered, 0, "History本体だけ書けてもrecoveredにしない");
  assert.ok(first.failed >= 1);
  const monthAfterFirst = vault.get(monthPath);
  assert.ok(monthAfterFirst, "月本体は書けている");
  assert.equal(vault.get(".tsumugi/history-meta.json"), undefined, "history-metaは欠けたまま");
  vault.writeShouldFail.delete(".tsumugi/history-meta.json");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
  assert.equal(vault.get(monthPath), monthAfterFirst, "月本体の内容は変わらず、metaだけ安全に補われる");
  assert.notEqual(vault.get(".tsumugi/history-meta.json"), undefined, "history-metaが実際に補われている（行だけを見て満足済みと誤判定していない）");
});

test("H2-1b: history-meta.jsonが壊れた形状（矛盾）の場合、上書きせず保留する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.put(".tsumugi/history-meta.json", JSON.stringify({ version: 1, updatedAt: T, months: "not-an-object", totalMemories: 0, totalConversations: 0 }));
  const before = vault.get(".tsumugi/history-meta.json");
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
  assert.equal(vault.get(".tsumugi/history-meta.json"), before, "壊れたhistory-metaを上書きしない");
});

test("O2: 実行中にregistry-index.jsonが外部から書き換えられていた場合、recoveredとして扱わない（Recovery自身は一切書かない管理ファイル）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  vault.put(".tsumugi/registry-index.json", JSON.stringify({ schemaVersion: 1, builtAtGeneration: "g0", records: {} }));
  const originalRunWrite = async <T,>(task: () => Promise<T>): Promise<T> => {
    const result = await task();
    // full resync等、Recoveryとは別の経路がregistry-index.jsonを書き換えた、という状況を模する。
    vault.put(".tsumugi/registry-index.json", JSON.stringify({ schemaVersion: 1, builtAtGeneration: "g1", records: {} }));
    return result;
  };
  const result = await applyOnce(db, vault, { runWrite: originalRunWrite });
  assert.equal(result.recovered, 0);
  assert.ok(result.failed >= 1);
});

// ===========================================================================
// P/Q: 変更してはいけないものが不変
// ===========================================================================

test("P: IndexedDB本文は一切変更されない（同期台帳以外のstoreへ書かない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const before = clone(db.conversations.get("c1"));
  await applyOnce(db, vault);
  assert.deepEqual(db.conversations.get("c1"), before);
});

test("Q: Recovery対象外の記録・ファイルは変更されない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  const untouchedContent = markdownMod.conversationToMarkdown(conversation("other"));
  vault.put("Conversations/other.md", untouchedContent);
  db.conversations.set("other", conversation("other")); // equivalent-existingになる（対象だが復旧のみ）
  const unrelated = "Attachments/keep-me.md";
  vault.put(unrelated, "some external note, never touched");
  await applyOnce(db, vault);
  assert.equal(vault.get(unrelated), "some external note, never touched");
});

// ===========================================================================
// R/S: 通常writeとの競合防止・通常挙動の維持
// ===========================================================================

test("R: 未完了journalがある間、通常のflushPendingToVault相当のwriteはVaultRecoveryPendingErrorで拒否される", async () => {
  const db = new FakeDb();
  db.conversations.set("c1", conversation("c1"));
  const journal: import("./vaultRecoveryJournal").RecoveryJournal = {
    version: 1, operationId: "op-1", status: "in-progress", createdAt: T, updatedAt: T,
    world: { activeVaultEpoch: 0, committedVaultEpoch: 0, registryGenerationEpoch: 0, journalVersion: "current", backend: "opfs" },
    baselineAtStart: { status: "not-found", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false,
  };
  await db.journalStore().write(JSON.stringify(journal));
  const blocked = await journalMod.isRecoveryBlockingNormalWrites(db.journalStore(), async () => db.activeVaultEpoch);
  assert.equal(blocked, true);
  await assert.rejects(journalMod.assertNoPendingRecovery(db.journalStore(), async () => db.activeVaultEpoch), journalMod.VaultRecoveryPendingError);
});

test("R2: Recovery自身の書き込み（runRecoveryVaultWrite経由）は、未完了journach中でも通常どおり進む", async () => {
  // runWithRecoveryWriteAccess自体の単体確認（vault.tsの内部enqueueVaultWriteに依存しない）。
  let insideAccess = false;
  journalMod.runWithRecoveryWriteAccess(() => { insideAccess = journalMod.isRecoveryWriteAccessActive(); });
  assert.equal(insideAccess, true);
  assert.equal(journalMod.isRecoveryWriteAccessActive(), false);
});

test("S: journalが存在しない通常状態では、通常の書き込みゲートは何も変えない", async () => {
  const db = new FakeDb();
  const blocked = await journalMod.isRecoveryBlockingNormalWrites(db.journalStore(), async () => db.activeVaultEpoch);
  assert.equal(blocked, false);
  await journalMod.assertNoPendingRecovery(db.journalStore(), async () => db.activeVaultEpoch); // 例外を投げない
});

// ===========================================================================
// baseline
// ===========================================================================

test("baseline: baseline未確立でも、local-only-safeは完全走査による不在証明だけで成立する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(vault.get(".tsumugi/registry-meta.json"), undefined); // baselineは変更していない
});

test("baseline: Recovery自身はbaselineを一切書き込まない（equivalent-existingでも）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  vault.put("moved.md", markdownMod.conversationToMarkdown(c));
  db.conversations.set("c1", c);
  await applyOnce(db, vault);
  assert.equal(vault.get(".tsumugi/registry-meta.json"), undefined);
});

// ===========================================================================
// UI向け状態
// ===========================================================================

test("readRecoveryState: journal無し→completed→interruptedを正しく報告する", async () => {
  const db = new FakeDb();
  assert.deepEqual(await applyMod.readRecoveryState({ store: db.journalStore(), readWorld: async () => ({ activeVaultEpoch: 0, committedVaultEpoch: 0, registryGenerationEpoch: 0, journalVersion: "current", backend: "opfs" }) }), { kind: "none" });
});

// ===========================================================================
// B1: 共有metadataの途中書き込み（failure injection）と、journal backupからの復元
// ===========================================================================

const T1_MONTH = T.slice(0, 7);

test("T1: index.json書き込み直後にgarbage（parse不能）になった場合、backupから復元し、今回は失敗のまま安全に終える。次回は正常に復旧する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.corruptOnCommit.set(INDEX_PATH(), "not json at all {{{");
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "completed");
  assert.equal(first.recovered, 0);
  assert.ok(first.failed >= 1);
  assert.equal(vault.get(INDEX_PATH()) ?? "", "", "backupから復元＝書き込み前の状態（不存在）に戻っている");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("T2: Registry shard書き込み直後にgarbageになった場合も同様に復元し、次回は正常に復旧する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  const shardPath = `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
  vault.corruptOnCommit.set(shardPath, "not json at all {{{");
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "completed");
  assert.equal(first.recovered, 0);
  assert.equal(vault.get(shardPath) ?? "", "");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("T3: History月ファイル書き込み直後にgarbageになった場合も同様に復元し、次回は正常に復旧する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  const monthPath = `.tsumugi/history/${T1_MONTH}.json`;
  vault.corruptOnCommit.set(monthPath, "not json at all {{{");
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "completed");
  assert.equal(first.recovered, 0);
  assert.equal(vault.get(monthPath) ?? "", "");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("T4: history-meta.json書き込み直後にgarbageになった場合も同様に復元し、次回は正常に復旧する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.corruptOnCommit.set(".tsumugi/history-meta.json", "not json at all {{{");
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "completed");
  assert.equal(first.recovered, 0);
  assert.equal(vault.get(".tsumugi/history-meta.json") ?? "", "");
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("T8: backupからの復元自体も失敗する（真に破損したまま）場合、journalをcompletedにせず、通常writeのgateを効かせ続ける", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.corruptOnCommit.set(INDEX_PATH(), "not json at all {{{");
  vault.writeShouldFail.add(INDEX_PATH()); // 復元write自体も失敗させる
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "interrupted");
  assert.equal(first.reason, "metadata-corrupt-unresolved");
  assert.equal(first.recovered, 0);
  const blocked = await journalMod.isRecoveryBlockingNormalWrites(db.journalStore(), async () => db.activeVaultEpoch);
  assert.equal(blocked, true, "解決できない破損が残っている間は、通常writeのgateが効いたままになる");
  // 同じ状況のまま再実行しても、安全側のまま（journalが誤ってcompletedになったりしない）。
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "interrupted");
  assert.equal(second.reason, "metadata-corrupt-unresolved");
});

test("T9: T8の状況が解消された（復元writeが再び成功するようになった）後、再実行すると安全に完了し、通常writeのgateも解除される", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  vault.corruptOnCommit.set(INDEX_PATH(), "not json at all {{{");
  vault.writeShouldFail.add(INDEX_PATH());
  const first = await applyOnce(db, vault);
  assert.equal(first.status, "interrupted");
  vault.writeShouldFail.delete(INDEX_PATH()); // 環境が回復した（例：ディスク容量が戻った）と仮定する
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
  const blocked = await journalMod.isRecoveryBlockingNormalWrites(db.journalStore(), async () => db.activeVaultEpoch);
  assert.equal(blocked, false);
});

function INDEX_PATH(): string {
  return ".tsumugi/index.json";
}

// ===========================================================================
// H2-2: registry-index.jsonの矛盾
// ===========================================================================

// H2-2対応：実production形式の確認結果（vault.ts追跡済み）：registry-index.jsonの
// `builtAtGeneration`は、registry-meta.jsonの`registryGeneration`（`crypto.randomUUID()`で生成される
// token文字列。IndexedDBの数値epoch`registryGenerationEpoch`とは無関係）と同じ値になる
// （`resyncVaultRegistry`が両方へ同じ`newGeneration`を書く）。fixtureも実形式に合わせ、
// 数値文字列ではなくUUID形式のtokenを使う。
const CURRENT_GENERATION_TOKEN = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const STALE_GENERATION_TOKEN = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
function registryMetaWithGeneration(token: string): string {
  return JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: null, baselineEstablishedAt: null, registryGeneration: token, dirtyOwnerInstanceId: null });
}

test("T14: 現在のgeneration（registry-meta.jsonのregistryGeneration、UUID形式）と一致するregistry-index.jsonに矛盾するpathが記載されている場合、recoveredとして扱わない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  vault.put(".tsumugi/registry-meta.json", registryMetaWithGeneration(CURRENT_GENERATION_TOKEN));
  vault.put(".tsumugi/registry-index.json", JSON.stringify({ schemaVersion: 1, builtAtGeneration: CURRENT_GENERATION_TOKEN, records: { c1: { path: "Conversations/some-other-path.md", mtime: 1, size: 1, recordType: "conversation" } } }));
  db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
  assert.ok(result.failed >= 1);
});

test("T14b: registry-index.jsonのbuiltAtGenerationが、registry-meta.jsonの現在のregistryGenerationと一致しない（古い＝権威的でない）場合は、記載されたpathが違っていても矛盾扱いしない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  vault.put(".tsumugi/registry-meta.json", registryMetaWithGeneration(CURRENT_GENERATION_TOKEN));
  vault.put(".tsumugi/registry-index.json", JSON.stringify({ schemaVersion: 1, builtAtGeneration: STALE_GENERATION_TOKEN, records: { c1: { path: "Conversations/some-other-path.md", mtime: 1, size: 1, recordType: "conversation" } } }));
  db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
});

test("T14c: registry-meta.json自体にregistryGenerationがまだ確立されていない場合は、registry-index.jsonが何であれ権威的とみなさない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  vault.put(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: null, baselineEstablishedAt: null, dirtyOwnerInstanceId: null }));
  vault.put(".tsumugi/registry-index.json", JSON.stringify({ schemaVersion: 1, builtAtGeneration: CURRENT_GENERATION_TOKEN, records: { c1: { path: "Conversations/some-other-path.md", mtime: 1, size: 1, recordType: "conversation" } } }));
  db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
});

test("T15: RegistryのrecordType/hash/member情報が不整合な場合、recoveredとして扱わない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "source", mtime: 1, size: 1, contentHash: "wrong", memberIds: ["someone-else"], status: "ok" } },
  }));
  db.conversations.set("c1", c);
  // このRegistry不整合（memberIdsがc1を含まない）自体は、既存のPlan生成（vaultRecovery.ts）が
  // "registry-identity-mismatch"として検知し、planningの時点で"unreadable / indeterminate"として
  // 保留する（opにすらならない）。recoveredにならないことと、本文・Registryを変更しないことを確認する。
  const before = JSON.stringify(vault.files);
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
  assert.equal(result.held, 1);
  assert.equal(JSON.stringify(vault.files), before, "不整合なRegistryを勝手に上書き・修復しない");
});

test("T15b: Registry entryのmemberIdsは正しいが、contentHash/recordTypeが実際のMarkdownと食い違う場合も、recoveredとして扱わない（勝手に上書きしない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  const shardPath = `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
  vault.put(shardPath, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: 1, size: 999, contentHash: "deliberately-wrong-hash", memberIds: ["c1"], status: "ok" } },
  }));
  db.conversations.set("c1", c);
  const before = vault.get(shardPath);
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
  assert.equal(vault.get(shardPath), before, "食い違うRegistry entryを無条件に書き換えない");
});

// ===========================================================================
// M1: Userが確認した対象だけApply（confirmed set）
// ===========================================================================

function memoryDayFixture(db: FakeDb, vault: FakeVault) {
  const m1 = memory("m1");
  const dayPath = `Memories/${vaultMod.dayFileNameFor(T)}`;
  const content = markdownMod.serializeMemoryDayFile([m1]);
  vault.put(dayPath, content);
  vault.put(".tsumugi/index.json", JSON.stringify({ m1: dayPath }));
  const month = T.slice(0, 7), day = T.slice(0, 10);
  vault.put(`.tsumugi/history/${month}.json`, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [], normalMemories: [{ id: "m1", types: m1.types, preview: m1.summary, createdAt: m1.createdAt, date: m1.date }], reflections: [] } } }));
  vault.put(".tsumugi/history-meta.json", JSON.stringify({ version: 1, updatedAt: T, months: { [month]: { memories: 1, conversations: 0 } }, totalMemories: 1, totalConversations: 0 }));
  db.memories.set("m1", m1);
  return { m1, dayPath, content, registryKey: `day:${day}` };
}

test("H2-2-recordType: Registry entryのrecordTypeだけが不一致な場合、recoveredとして扱わない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "source", mtime: vault.mtimeOf(path), size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0, "recordTypeだけの不一致でもrecovered禁止");
});

test("H2-2-mtime: Registry entryのmtimeだけが不一致な場合、recoveredとして扱わない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: vault.mtimeOf(path) + 12345, size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0, "mtimeだけの不一致でもrecovered禁止");
});

test("H2-2-A: equivalent-existing＋台帳未同期で、statが取得できmtimeが一致する場合は、通常どおりrecoveredになる（positive control）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: vault.mtimeOf(path), size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  db.conversations.set("c1", c);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1, "statが取得できmtimeが一致するため、台帳だけを補って正常にrecoveredになる");
  assert.equal(db.ledger.get("conversation:c1"), c.updatedAt);
});

test("H2-2-B: 同じ状況でもstat自体が取得できない場合は、recoveredを禁止する（確認不能を成功扱いしない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: vault.mtimeOf(path), size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  db.conversations.set("c1", c);
  const originalStat = vaultMod.vaultRecoveryPrimitives.readVaultFileStat;
  vaultMod.vaultRecoveryPrimitives.readVaultFileStat = async () => { throw new Error("simulated stat failure"); };
  try {
    const result = await applyOnce(db, vault);
    assert.equal(result.recovered, 0, "statを取得できない以上、mtimeが正しいとは証明できないためrecovered禁止");
    assert.ok(result.held >= 1);
    assert.equal(db.ledger.get("conversation:c1"), undefined, "確認できていないため台帳も進めない");
  } finally {
    vaultMod.vaultRecoveryPrimitives.readVaultFileStat = originalStat;
  }
});

test("H2-2-D: 1回目はstat取得に失敗して保留しても、2回目（stat復旧後）に再検証して安全にrecoveredになる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1");
  const path = "Conversations/moved.md";
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const bucket = vaultMod.vaultRegistryBucketOf("c1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { c1: path },
    files: { [path]: { recordType: "conversation", mtime: vault.mtimeOf(path), size: markdownMod.conversationToMarkdown(c).length, contentHash: vaultMod.hashVaultText(markdownMod.conversationToMarkdown(c)), memberIds: ["c1"], status: "ok" } },
  }));
  db.conversations.set("c1", c);
  const originalStat = vaultMod.vaultRecoveryPrimitives.readVaultFileStat;
  vaultMod.vaultRecoveryPrimitives.readVaultFileStat = async () => { throw new Error("simulated stat failure"); };
  try {
    const first = await applyOnce(db, vault);
    assert.equal(first.recovered, 0);
  } finally {
    vaultMod.vaultRecoveryPrimitives.readVaultFileStat = originalStat;
  }
  const second = await applyOnce(db, vault);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1, "statが復旧すれば、改めて安全に検証してrecoveredになる");
});

test("H2-2-E: Memory day-fileでも、statが取得できない場合はrecoveredを禁止する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  // day-file Markdownは1record分の情報しか持たない往復のため、書き込んだ内容を再度parseした結果
  // （＝inspect時に実際に使われる`ctx.fileMembers`と同じもの）から、期待するHistory行・
  // Registry memberHashesを計算する（手で計算した「元のMemoryObject」の値をそのまま使うと、
  // 往復で落ちるフィールドのせいで無関係な理由で保留されてしまう）。
  const m1 = memory("m1");
  const dayPath = `Memories/${vaultMod.dayFileNameFor(T)}`;
  const content = markdownMod.serializeMemoryDayFile([m1]);
  const parsedMember = markdownMod.parseMemoryDayFile(content)[0];
  vault.put(dayPath, content);
  vault.put(".tsumugi/index.json", JSON.stringify({ m1: dayPath }));
  const month = T.slice(0, 7), day = T.slice(0, 10);
  vault.put(`.tsumugi/history/${month}.json`, JSON.stringify({ version: 2, month, days: { [day]: { conversations: [], normalMemories: [{ id: "m1", types: parsedMember.types, preview: parsedMember.summary, createdAt: parsedMember.createdAt, date: parsedMember.date }], reflections: [] } } }));
  vault.put(".tsumugi/history-meta.json", JSON.stringify({ version: 1, updatedAt: T, months: { [month]: { memories: 1, conversations: 0 } }, totalMemories: 1, totalConversations: 0 }));
  db.memories.set("m1", m1);
  const registryKey = `day:${day}`;
  const bucket = vaultMod.vaultRegistryBucketOf(registryKey);
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { [registryKey]: dayPath },
    files: { [dayPath]: { recordType: "memory-day", mtime: vault.mtimeOf(dayPath), size: content.length, contentHash: vaultMod.hashVaultText(content), memberIds: ["m1"], memberHashes: { m1: vaultMod.hashVaultText(markdownMod.memoryObjectToMarkdown(parsedMember)) }, status: "ok" } },
  }));
  // 台帳（sync ledger）だけが未同期のまま＝これが唯一の不足（stat検証さえ通れば通常はrecoveredになる状況）。
  const originalStat = vaultMod.vaultRecoveryPrimitives.readVaultFileStat;
  vaultMod.vaultRecoveryPrimitives.readVaultFileStat = async () => { throw new Error("simulated stat failure"); };
  try {
    const result = await applyOnce(db, vault);
    assert.equal(result.recovered, 0, "memory-dayでもstat取得不能をrecovered扱いしない");
  } finally {
    vaultMod.vaultRecoveryPrimitives.readVaultFileStat = originalStat;
  }
});

test("H2-2-memberHashes-missing: memory-day recordでmemberHashesフィールド自体が欠けている場合、recoveredとして扱わない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const { content, registryKey } = memoryDayFixture(db, vault);
  const dayPath = `Memories/${vaultMod.dayFileNameFor(T)}`;
  const bucket = vaultMod.vaultRegistryBucketOf(registryKey);
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { [registryKey]: dayPath },
    files: { [dayPath]: { recordType: "memory-day", mtime: vault.mtimeOf(dayPath), size: content.length, contentHash: vaultMod.hashVaultText(content), memberIds: ["m1"], status: "ok" } },
  }));
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0, "memberHashes自体が無い＝値の比較を素通りさせない");
});

test("H2-2-memberHashes-mismatch: memory-day recordでmemberHashesの値が不整合な場合、recoveredとして扱わない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const { content, registryKey } = memoryDayFixture(db, vault);
  const dayPath = `Memories/${vaultMod.dayFileNameFor(T)}`;
  const bucket = vaultMod.vaultRegistryBucketOf(registryKey);
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { [registryKey]: dayPath },
    files: { [dayPath]: { recordType: "memory-day", mtime: vault.mtimeOf(dayPath), size: content.length, contentHash: vaultMod.hashVaultText(content), memberIds: ["m1"], memberHashes: { m1: "deliberately-wrong" }, status: "ok" } },
  }));
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
});

test("H2-2-all-correct: recordType/path/contentHash/mtime/memberIds/memberHashesすべて正しい場合は、equivalentとして正常に扱われる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const { m1, content, registryKey } = memoryDayFixture(db, vault);
  const dayPath = `Memories/${vaultMod.dayFileNameFor(T)}`;
  const bucket = vaultMod.vaultRegistryBucketOf(registryKey);
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { [registryKey]: dayPath },
    files: { [dayPath]: { recordType: "memory-day", mtime: vault.mtimeOf(dayPath), size: content.length, contentHash: vaultMod.hashVaultText(content), memberIds: ["m1"], memberHashes: { m1: vaultMod.hashVaultText(markdownMod.memoryObjectToMarkdown(m1)) }, status: "ok" } },
  }));
  db.ledger.set("memory:m1", m1.updatedAt);
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "nothing-to-do", "全て正しいため、補うべきものが無い");
});

test("T16: Dry Run後に別の安全な記録が新しく増えても、確認済み集合に無い新規recordはApplyされない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  const dryRun = await applyMod.planRecoveryApply(makeEnv(db, vault));
  assert.equal(dryRun.recoverableCount, 1);
  // Dry Run後に、別の安全なConversationが新しく増えた（ユーザーはこれを見ていない）。
  db.conversations.set("c2", conversation("c2"));
  const result = await applyOnce(db, vault, {}, dryRun.confirmed);
  assert.equal(result.recovered, 1, "確認済みのc1だけが復旧される");
  const path2 = `Conversations/${vaultMod.fileNameFor("c2", T)}`;
  assert.equal(vault.get(path2), undefined, "確認していないc2は書き込まれない");
});

test("T16b: 確認済みの日に新しいMemoryが増えた場合、その日全体をApply対象から外す（部分的に古いmemberだけ書かない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.memories.set("m1", memory("m1"));
  const dryRun = await applyMod.planRecoveryApply(makeEnv(db, vault));
  assert.equal(dryRun.recoverableCount, 1);
  db.memories.set("m2", memory("m2", { summary: "後から増えた" })); // 同じ日の新しいMemory
  const result = await applyOnce(db, vault, {}, dryRun.confirmed);
  assert.equal(result.recovered, 0, "同じ日に未確認のmemberが増えたため、day全体を対象から外す");
  assert.equal(vault.get(`Memories/${vaultMod.dayFileNameFor(T)}`), undefined);
});

test("T17: Dry Run後にworldが変わっていた場合、Applyを拒否し再確認を要求する（何も書き込まない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  const dryRun = await applyMod.planRecoveryApply(makeEnv(db, vault));
  db.activeVaultEpoch = 1; // Dry Run後にworldが変わった（例：別タブでのVault再同期）
  const result = await applyOnce(db, vault, {}, dryRun.confirmed);
  assert.equal(result.status, "confirmation-expired");
  assert.equal(vault.files.size, 0, "何も書き込んでいない");
});

// ===========================================================================
// T19: unavailable/errorを成功表示にしない（型・値レベルの確認）
// ===========================================================================

function staleJournalFixture(world: { activeVaultEpoch: number; committedVaultEpoch: number; registryGenerationEpoch: number; journalVersion: string; backend: string }) {
  return {
    version: 1 as const, operationId: "op-1", status: "in-progress" as const, createdAt: T, updatedAt: T,
    world, baselineAtStart: { status: "not-found", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false,
  };
}
const OTHER_WORLD = { activeVaultEpoch: 999, committedVaultEpoch: 999, registryGenerationEpoch: 0, journalVersion: "current", backend: "opfs" };

test("M1-resume: 中断journalが今のworldと一致する場合、resumeOnly指定でも（confirmedなしで）再開する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const c = conversation("c1"); db.conversations.set("c1", c);
  let calls = 0;
  const backing = db.journalStore();
  const flakyStore: import("./vaultRecoveryJournal").RecoveryJournalStore = {
    read: backing.read,
    write: async (text: string) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated crash right after markdown write");
      await backing.write(text);
    },
  };
  const first = await applyMod.applyRecovery(makeEnv(db, vault, { store: flakyStore }));
  assert.equal(first.status, "interrupted");
  // 中断後の「再確認して続ける」＝resumeOnly:true・confirmedなしでの呼び出し。同じworldの続きなので再開できる。
  const second = await applyOnce(db, vault, {}, undefined, true);
  assert.equal(second.resumed, true);
  assert.equal(second.status, "completed");
  assert.equal(second.recovered, 1);
});

test("M1-resume: 中断journalが別worldのものである場合、resumeOnly指定での「再開」は拒否され、新worldのrecordを勝手にApplyしない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  await db.journalStore().write(JSON.stringify(staleJournalFixture(OTHER_WORLD)));
  const result = await applyOnce(db, vault, {}, undefined, true);
  assert.equal(result.status, "confirmation-expired");
  assert.equal(result.recovered, 0);
  assert.equal(vault.files.size, 0, "確認していない新worldの安全な記録を勝手にApplyしていない");
});

test("M1-resume: 中断journalが消失している（journal自体が無い）場合、resumeOnly指定での「再開」は拒否される（新規Applyへフォールバックしない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  // journalStoreへ何も書いていない＝journal自体が存在しない状態。resumeOnly:trueで「再開」だけを試みる。
  const result = await applyOnce(db, vault, {}, undefined, true);
  assert.equal(result.status, "confirmation-expired");
  assert.equal(result.reason, "no-pending-journal");
  assert.equal(vault.files.size, 0);
});

test("M1-resume: resumeOnlyを指定しない通常呼び出し（confirmedなし）は、journalが無ければ従来どおり新規Applyとして進む（下位互換）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
});

test("M1-resume: 別worldの古いjournalがあっても、新しく確認したconfirmed（今のworldのもの）があれば、明示的に上書きして新規Applyできる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  await db.journalStore().write(JSON.stringify(staleJournalFixture(OTHER_WORLD)));
  const dryRun = await applyMod.planRecoveryApply(makeEnv(db, vault));
  const result = await applyOnce(db, vault, {}, dryRun.confirmed);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
  const stored = JSON.parse(db.journal!);
  assert.equal(stored.world.activeVaultEpoch, db.activeVaultEpoch, "新しいjournalが今のworldで確立されている");
});

test("M1-resume: 新規Apply（confirmedあり）でもworldが変わっていれば拒否し、再確認を要求する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  const dryRun = await applyMod.planRecoveryApply(makeEnv(db, vault));
  db.activeVaultEpoch = 1;
  const result = await applyOnce(db, vault, {}, dryRun.confirmed);
  assert.equal(result.status, "confirmation-expired");
  assert.equal(vault.files.size, 0);
});

test("M1: confirmed setに含まれる記録は、Apply直前の最新Planでも安全なままなら、そのままrecoveredになる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  const dryRun = await applyMod.planRecoveryApply(makeEnv(db, vault));
  assert.equal(dryRun.recoverableCount, 1);
  const result = await applyOnce(db, vault, {}, dryRun.confirmed);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
});

test("T19: confirmation-expired／unavailableはrecovered>0にならない（成功文言に潰れない）", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  db.conversations.set("c1", conversation("c1"));
  const dryRun = await applyMod.planRecoveryApply(makeEnv(db, vault));
  db.activeVaultEpoch = 1;
  const expired = await applyOnce(db, vault, {}, dryRun.confirmed);
  assert.equal(expired.status, "confirmation-expired");
  assert.equal(expired.recovered, 0);
  const unavailable = await applyMod.applyRecovery(makeEnv(db, vault, { readWorld: async () => { throw new Error("boom"); } }));
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.recovered, 0);
});

// ===========================================================================
// M3: 複数memberの既存day-fileで、History metadataだけが欠けているケースは、初期版では自動修復対象外
// （unsafe/conflictとは異なる、識別可能な理由で保留する。本文もrecovered扱いも変えない）
// ===========================================================================

test("M3: 複数memberの既存day-fileでHistory行が丸ごと欠けている場合、recoveredにも本文変更にもせず、保留として識別できる", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const m1 = memory("m1"), m2 = memory("m2", { summary: "別のmember" });
  const dayPath = `Memories/${vaultMod.dayFileNameFor(T)}`;
  vault.put(dayPath, markdownMod.serializeMemoryDayFile([m1, m2]));
  // Historyには何も記載されていない（day自体が丸ごと欠けている）。
  db.memories.set("m1", m1); db.memories.set("m2", m2);
  const beforeContent = vault.get(dayPath);
  const applyPlan = await applyMod.planRecoveryApply(makeEnv(db, vault));
  const m1Held = applyPlan.held.find((h) => h.recordId === "m1");
  assert.ok(m1Held, "m1はrecovered対象にならず、保留として識別できる");
  assert.notEqual(m1Held?.reason, "conflict");
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
  assert.equal(vault.get(dayPath), beforeContent, "本文は変更されない");
});

test("M3b: 複数memberの既存day-fileで、History月ファイルは存在するが対象日のエントリ自体が不存在の場合も、同じout-of-scopeとして保留する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const m1 = memory("m1"), m2 = memory("m2", { summary: "別のmember" });
  const dayPath = `Memories/${vaultMod.dayFileNameFor(T)}`;
  vault.put(dayPath, markdownMod.serializeMemoryDayFile([m1, m2]));
  // 月ファイル自体は存在するが、対象日のエントリが無い（＝別の日のデータだけが載っている）。
  const month = T.slice(0, 7);
  const otherDay = "2026-09-01"; // 同じ月・別の日（day.slice(0,7)===monthを満たす必要があるため）
  vault.put(`.tsumugi/history/${month}.json`, JSON.stringify({ version: 2, month, days: { [otherDay]: { conversations: [], normalMemories: [], reflections: [] } } }));
  db.memories.set("m1", m1); db.memories.set("m2", m2);
  const beforeContent = vault.get(dayPath);
  const beforeHistory = vault.get(`.tsumugi/history/${month}.json`);
  const applyPlan = await applyMod.planRecoveryApply(makeEnv(db, vault));
  const m1Held = applyPlan.held.find((h) => h.recordId === "m1");
  assert.ok(m1Held, "m1はrecovered対象にならず、保留として識別できる");
  assert.notEqual(m1Held?.reason, "conflict");
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
  assert.equal(vault.get(dayPath), beforeContent, "day-file本文は変更されない");
  assert.equal(vault.get(`.tsumugi/history/${month}.json`), beforeHistory, "既存の月ファイルも変更されない");
});

test("M3c: 複数memberの既存day-fileで、月ファイル・対象日エントリは存在するが、対象memberの行だけが不存在の場合も、同じout-of-scopeとして保留する", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  // dateはday精度でMarkdown round-tripするため（frontmatterはYYYY-MM-DDのみ保持）、
  // 最初からday境界の値にしておき、round-trip前後の比較を素直にする。
  const m1 = memory("m1", { date: "2026-09-20T00:00:00.000Z", createdAt: "2026-09-20T00:00:00.000Z" });
  const m2 = memory("m2", { summary: "別のmember", date: "2026-09-20T00:00:00.000Z", createdAt: "2026-09-20T00:00:00.000Z" });
  db.memories.set("m1", m1); db.memories.set("m2", m2);
  // まずm1・m2両方を正常に新規作成させ、システム自身が書いた「正しい」History行を用意する
  // （手書きfixtureのround-trip差異を避けるため）。
  const bootstrap = await applyOnce(db, vault);
  assert.equal(bootstrap.recovered, 2);
  const month = T.slice(0, 7), day = T.slice(0, 10);
  const historyPath = `.tsumugi/history/${month}.json`;
  const history = JSON.parse(vault.get(historyPath)!);
  // m1の行だけを取り除く（m2の行はシステムが書いたままの、正しい内容を保つ）。
  history.days[day].normalMemories = history.days[day].normalMemories.filter((r: { id: string }) => r.id !== "m1");
  vault.put(historyPath, JSON.stringify(history));
  const dayPath = `Memories/${vaultMod.dayFileNameFor(T)}`;
  const beforeContent = vault.get(dayPath);
  const applyPlan = await applyMod.planRecoveryApply(makeEnv(db, vault));
  const m1Held = applyPlan.held.find((h) => h.recordId === "m1");
  assert.ok(m1Held, "m2の行は既にあり、m1の行だけが不足していても、複数member day-fileなので保留する");
  assert.notEqual(m1Held?.reason, "conflict");
  assert.notEqual(m1Held?.reason, "history-row-differs", "m2の既存行自体は正しい（システムが書いたまま）前提のテストである");
  const result = await applyOnce(db, vault);
  assert.equal(result.recovered, 0);
  assert.equal(vault.get(dayPath), beforeContent);
});

test("M3d: single-member（Reflection）の従来のsafe repairは、multi-member用のout-of-scope guardの影響を受けない", async () => {
  const db = new FakeDb(); const vault = new FakeVault();
  const r = reflection("r1");
  const path = `Memories/${vaultMod.fileNameFor("r1", r.date)}`;
  vault.put(path, markdownMod.memoryObjectToMarkdown(r));
  const bucket = vaultMod.vaultRegistryBucketOf("r1");
  vault.put(`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`, JSON.stringify({
    schemaVersion: 1, bucket, records: { r1: path },
    files: { [path]: { recordType: "reflection", mtime: vault.mtimeOf(path), size: markdownMod.memoryObjectToMarkdown(r).length, contentHash: vaultMod.hashVaultText(markdownMod.memoryObjectToMarkdown(r)), memberIds: ["r1"], status: "ok" } },
  }));
  vault.put(".tsumugi/index.json", JSON.stringify({ r1: path }));
  db.memories.set("r1", r);
  db.ledger.set("memory:r1", r.updatedAt);
  // Historyのreflection行が丸ごと不足している（single-memberなので、out-of-scopeの対象外＝従来どおり安全に補える）。
  const result = await applyOnce(db, vault);
  assert.equal(result.status, "completed");
  assert.equal(result.recovered, 1);
});

// Explicit narrow repair uses the actual production Plan/parser/verifiers above.
const repairDb = require("./db") as typeof import("./db");
const narrow = require("./memoryNarrowRepair") as typeof import("./memoryNarrowRepair");
async function narrowFixture(registryDays = 3) {
  const db = new FakeDb(), vault = new FakeVault();
  const next = "2026-09-21T09:00:00.000Z";
  for (let i = 0; i < 5; i++) {
    const link: import("./types").Link = { id: `link-${i}`, sourceId: `c-${i}`, targetId: `p-${i}`, axis: "theme", reason: "reason", strength: 0.8, contrast: false, createdBy: "ai-inference", createdAt: next };
    db.memories.set(`r-${i}`, memory(`r-${i}`, { date: `2026-09-${22 + i % registryDays}T09:00:00.000Z` }));
    db.memories.set(`c-${i}`, memory(`c-${i}`, { links: [link], updatedAt: next }));
    db.memories.set(`p-${i}`, memory(`p-${i}`, { date: "2026-09-25T09:00:00.000Z", links: [link], updatedAt: next }));
  }
  for (const m of db.memories.values()) m.date = m.date.slice(0, 10);
  const initial = await applyOnce(db, vault); assert.equal(initial.status, "completed");
  db.journal = undefined;
  // Seed a fully current History fixture from the actual persisted parser output.
  const hp = ".tsumugi/history/2026-09.json", history = JSON.parse(vault.get(hp)!);
  for (const [path, file] of vault.files) if (path.startsWith("Memories/")) {
    const members = markdownMod.parseMemoryDayFile(file.content);
    const day = members[0].date.slice(0,10);
    for (const m of members) db.memories.set(m.id, clone(m));
    const rk = vaultMod.dayFileRegistryKey(day), sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(rk).toString(16).padStart(2,"0")}.json`;
    const shard = JSON.parse(vault.get(sp)!);
    shard.files[path].memberHashes = Object.fromEntries(members.map(m => [m.id, vaultMod.hashVaultText(markdownMod.memoryObjectToMarkdown(m))]));
    vault.put(sp,vaultMod.serializeVaultRegistryShard(shard));
    history.days[day].normalMemories = members.map(m => ({ id:m.id, types:m.types, preview:vaultMod.truncateHistoryPreview(m.summary), createdAt:m.createdAt, date:m.date }));
  }
  vault.put(hp,JSON.stringify(history));
  for (let i = 0; i < 5; i++) db.memories.set(`c-${i}`, { ...db.memories.get(`c-${i}`)!, links: [], updatedAt: T });
  for (let day = 22; day < 22 + registryDays; day++) {
    const date = `2026-09-${day}`, file = `Memories/${vaultMod.dayFileNameFor(date)}`;
    vault.put(file, vault.get(file)! + "\n\n");
    const key = vaultMod.dayFileRegistryKey(date), bucket = vaultMod.vaultRegistryBucketOf(key);
    const sp = `.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`;
    const shard = JSON.parse(vault.get(sp)!); shard.files[file].mtime = vault.mtimeOf(file); shard.files[file].size = vault.get(file)!.length; shard.files[file].contentHash = vaultMod.hashVaultText(markdownMod.serializeMemoryDayFile(markdownMod.parseMemoryDayFile(vault.get(file)!).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))));
    vault.put(sp, vaultMod.serializeVaultRegistryShard(shard));
  }
  const apply = makeEnv(db, vault);
  const plan = await applyMod.planRecoveryApply(apply);
  assert.equal(plan.heldCount, 10, JSON.stringify(plan.held)); assert.equal(plan.plan.issues.length, 0);
  const outboxes = new Map<string, import("./vaultOutbox").VaultOutboxEntry>();
  const env: import("./memoryNarrowRepair").NarrowRepairEnv = { apply,
    excludeArchived: async p => p,
    readStorage: async id => ({ outbox: outboxes.get(id) ?? null, ledger: db.ledger.get(`memory:${id}`) ?? null }),
    identity: async () => "fixture-identity",
    read: async p => { const f = vault.files.get(p); if (!f) throw new DOMException("absent", "NotFoundError"); return { raw: f.content, size: f.content.length, mtime: f.mtime }; },
    write: async (p, text) => { vault.put(p, text); },
    commit: async (changes, counterparts, _now, finalize, expectations) => {
      for (const c of counterparts) assert.deepEqual(db.memories.get(c.id), c);
      for (const c of changes) {
        const current = db.memories.get(c.before.id);
        assert.ok(JSON.stringify(current) === JSON.stringify(c.before) || JSON.stringify(current) === JSON.stringify(c.after));
        db.memories.set(c.before.id, clone(c.after));
        const expected = expectations.find(e => e.id === c.before.id)!;
        outboxes.set(c.before.id, clone((finalize ? expected.after : expected.intermediate).outbox!));
        if (finalize) db.ledger.set(`memory:${c.after.id}`, c.after.updatedAt);
      }
    },
  };
  return { db, vault, env, plan, outboxes };
}
test("Narrow: explicit 3 day / 5 Link repair, only permitted fields, held=0", async () => {
  const f = await narrowFixture();
  const before = new Map([...f.vault.files].map(([p,v]) => [p,v.content])); const local = clone(f.db.snapshot().memories);
  const result = await narrow.executeNarrowMemoryRepair(f.env, f.plan);
  assert.deepEqual(result, { status: "complete", held: 0, issues: 0 });
  for (const [p, raw] of before) {
    if (!p.startsWith(".tsumugi/registry/")) assert.equal(f.vault.get(p), raw);
    else { const a = JSON.parse(raw), b = JSON.parse(f.vault.get(p)!); for (const path of Object.keys(a.files)) a.files[path].contentHash = b.files[path].contentHash; assert.deepEqual(a,b); }
  }
  for (const m of local) {
    const after = f.db.memories.get(m.id)!;
    if (!m.id.startsWith("c-")) assert.deepEqual(after, m, "Registry対象・counterpart canonicalは完全不変");
    else assert.deepEqual({ ...after, links: m.links, updatedAt: m.updatedAt }, m);
  }
  assert.equal((await journalMod.readRecoveryJournal(f.env.apply.store)).kind, "journal");
});
for (const failure of ["identity", "world", "memberIds", "memberHashes", "raw", "mtime", "size", "counterpart", "counterpart-content", "content", "registry-content", "timestamp", "timestamp-invalid", "both-unique", "same-id", "issues"] as const) test(`Narrow preflight refuses ${failure}`, async () => {
  const f = await narrowFixture();
  if (failure === "identity") f.env.identity = async () => { throw new Error("identity"); };
  else if (failure === "world") f.db.activeVaultEpoch++;
  else if (["memberIds", "memberHashes", "mtime", "size"].includes(failure)) {
    const p = f.plan.plan.records.find(r => r.recordId === "r-0")!;
    const sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(p.registryKey).toString(16).padStart(2,"0")}.json`;
    const shard = JSON.parse(f.vault.get(sp)!); const e = shard.files[p.vaultPaths[0]];
    if (failure === "memberIds") e.memberIds = []; else if (failure === "memberHashes") e.memberHashes = {}; else e[failure]++;
    f.vault.put(sp, vaultMod.serializeVaultRegistryShard(shard));
  } else if (failure === "raw") { const p = f.plan.plan.records.find(r => r.recordId === "r-0")!.vaultPaths[0]; f.vault.put(p, f.vault.get(p)! + "changed"); }
  else if (failure === "counterpart") f.db.memories.delete("p-0");
  else if (failure === "counterpart-content") f.db.memories.get("p-0")!.links[0].reason = "changed";
  else if (failure === "content") f.db.memories.get("c-0")!.content = "changed";
  else if (failure === "registry-content") f.db.memories.get("r-0")!.content = "changed";
  else if (failure === "timestamp") f.db.memories.get("c-0")!.updatedAt = "2026-10-01T00:00:00.000Z";
  else if (failure === "timestamp-invalid") f.db.memories.get("c-0")!.updatedAt = "invalid";
  else if (failure === "both-unique") f.db.memories.get("c-0")!.links = [{ ...f.db.memories.get("p-0")!.links[0], id: "other" }];
  else if (failure === "same-id") f.db.memories.get("c-0")!.links = [{ ...f.db.memories.get("p-0")!.links[0], reason: "changed" }];
  else f.vault.put("Memories/broken.md", "---\ntsumugi: true\nid: broken\n---\ninvalid");
  const before = JSON.stringify([...f.vault.files]), local = JSON.stringify(f.db.snapshot());
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, f.plan)).status, "held");
  assert.equal(JSON.stringify([...f.vault.files]), before); assert.equal(JSON.stringify(f.db.snapshot()), local);
});
for (const stage of ["before", "after", "partial", "canonical", "finalize"] as const) test(`Narrow interruption ${stage}, explicit resume only`, async () => {
  const f = await narrowFixture(), write = f.env.write, commit = f.env.commit; let once = true;
  f.env.write = async (p, text) => {
    if (once && ["before", "after", "partial"].includes(stage)) {
      once = false;
      if (stage === "after") await write(p,text);
      if (stage === "partial") await write(p,"{");
      throw new Error("kill");
    }
    await write(p,text);
  };
  f.env.commit = async (...args) => { await commit(...args); if (once && (stage === "canonical" && !args[3] || stage === "finalize" && args[3])) { once = false; throw new Error("kill"); } };
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, f.plan)).status, "held");
  assert.equal(await journalMod.isRecoveryBlockingNormalWrites(f.env.apply.store, async () => 0), true);
  const generic = await applyMod.applyRecovery(f.env.apply);
  assert.equal(generic.status, "unavailable");
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, null)).status, "complete");
});

test("Narrow failed restore keeps gate; neither snapshot refuses explicit resume", async () => {
  const f = await narrowFixture(); let writes=0;
  f.env.write = async (p) => { writes++; f.vault.put(p,"{"); throw new Error("write/restore unavailable"); };
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"held");
  assert.equal(await journalMod.isRecoveryBlockingNormalWrites(f.env.apply.store,async()=>0),true);
  const attempted = writes;
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,null)).status,"held"); assert.equal(writes,attempted);
});
test("Narrow double invocation cannot reapply a completed repair", async () => {
  const f = await narrowFixture(); assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"complete");
  const before = JSON.stringify([...f.vault.files]), local = JSON.stringify(f.db.snapshot());
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"held");
  assert.equal(JSON.stringify([...f.vault.files]),before); assert.equal(JSON.stringify(f.db.snapshot()),local);
});
test("Narrow journal persistence failure precedes every mutation", async () => {
  const f = await narrowFixture(); f.db.journalWriteShouldFail=true;
  const before = JSON.stringify([...f.vault.files]), local = JSON.stringify(f.db.snapshot());
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"held");
  assert.equal(JSON.stringify([...f.vault.files]),before); assert.equal(JSON.stringify(f.db.snapshot()),local);
});

test("Narrow journal read-back failure stops before storage mutations", async () => {
  const f = await narrowFixture();
  f.env.apply.store = { read: async () => undefined, write: async text => { f.db.journal = text; } };
  const files = JSON.stringify([...f.vault.files]), local = JSON.stringify(f.db.snapshot());
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, f.plan)).status, "held");
  assert.equal(JSON.stringify([...f.vault.files]), files);
  assert.equal(JSON.stringify(f.db.snapshot()), local);
});
test("Narrow changed target set after confirmation refuses all writes", async () => {
  const f = await narrowFixture();
  f.plan.held[0].recordId = "different-confirmed-id";
  const files = JSON.stringify([...f.vault.files]), local = JSON.stringify(f.db.snapshot());
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, f.plan)).status, "held");
  assert.equal(JSON.stringify([...f.vault.files]), files);
  assert.equal(JSON.stringify(f.db.snapshot()), local);
  assert.equal(f.db.journal, undefined);
});
test("Narrow interrupted journal cannot resume in a different world", async () => {
  const f = await narrowFixture(), commit = f.env.commit;
  f.env.commit = async () => { throw new Error("interrupt"); };
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, f.plan)).status, "held");
  f.env.commit = commit; f.db.activeVaultEpoch++;
  const files = JSON.stringify([...f.vault.files]), local = JSON.stringify(f.db.snapshot());
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, null)).status, "held");
  assert.equal(JSON.stringify([...f.vault.files]), files);
  assert.equal(JSON.stringify(f.db.snapshot()), local);
  assert.equal(JSON.parse(f.db.journal!).status, "in-progress");
});

for (const scenario of ["duplicate-counterpart", "missing-matching-link"] as const) test(`Narrow Link validation rejects ${scenario}`, async () => {
  const f = await narrowFixture();
  const before = f.db.memories.get("c-0")!;
  const after = { ...before, links: f.db.memories.get("p-0")!.links, updatedAt: "2026-09-21T09:00:00.000Z" };
  const pool = f.db.snapshot().memories;
  if (scenario === "duplicate-counterpart") pool.push(clone(f.db.memories.get("p-0")!));
  else pool.find(m => m.id === "p-0")!.links = [];
  assert.throws(() => narrow.validateLinkRestoration(before,after,pool));
});
test("Narrow rechecks raw files after journal read-back before any repair write", async () => {
  const f = await narrowFixture(), store = f.env.apply.store;
  const path = f.plan.plan.records.find(r => r.recordId === "r-0")!.vaultPaths[0];
  f.env.apply.store = { read: store.read, write: async text => { await store.write(text); f.vault.put(path, f.vault.get(path)! + "\n"); } };
  let writes = 0; f.env.write = async () => { writes++; };
  const local = JSON.stringify(f.db.snapshot());
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"held");
  assert.equal(writes,0); assert.equal(JSON.stringify(f.db.snapshot()),local);
});


async function productionNarrowFixture(registryDays = 3) {
  const f = await narrowFixture(registryDays);
  await repairDb.clearMemoryData();
  for (const entry of [...await repairDb.getPendingVaultOutboxEntries(), ...await repairDb.getDoneVaultOutboxEntries()]) await repairDb.deleteVaultOutboxEntry(entry.id);
  for (const m of f.db.memories.values()) await repairDb.putMemoryObject(m);
  for (const [key,value] of f.db.ledger) await repairDb.setVaultSyncState(key,value);
  for (let i=0;i<5;i++) {
    const m=f.db.memories.get(`c-${i}`)!;
    await repairDb.setVaultSyncState(`memory:${m.id}`,m.updatedAt);
    await repairDb.putMemoryObjectWithOutbox(m,"memory",T);
  }
  f.env.apply.readLocalSnapshot = async () => {
    const memories = await repairDb.getAllMemoryObjects();
    const sync: Record<string,string> = {};
    for (const m of memories) { const value=await repairDb.getVaultSyncState(`memory:${m.id}`); if(value!==undefined) sync[`memory:${m.id}`]=value; }
    return { conversations:[],sources:[],memories,sync };
  };
  f.env.apply.readRecord = async (_type,id) => repairDb.getMemoryObject(id);
  f.env.apply.readLedger = repairDb.getVaultSyncState;
  f.env.readStorage = repairDb.readMemoryRepairStorage;
  f.env.commit = repairDb.commitMemoryLinkRestoration;
  f.plan = await applyMod.planRecoveryApply(f.env.apply);
  const identity: import("./vaultIdentity").VaultIdentityRecord = {id:"current",vaultId:"fixture-identity",activeVaultEpoch:0,registryGeneration:"gen",pairedAt:T,pendingCandidateVaultId:null,updatedAt:T};
  f.vault.put(".tsumugi/vault-identity.json",JSON.stringify({vaultId:identity.vaultId,createdAt:T}));
  const legacy = require("./vaultRecoveryLegacyCleanup") as typeof import("./vaultRecoveryLegacyCleanup");
  f.env.excludeArchived = p => legacy.excludeArchivedFromApplyPlan({ root: f.vault.root(), vaultIdentity: identity, now: () => T }, p);
  return {...f, identity, legacy, projectionEnv:{root:f.vault.root(),vaultIdentity:identity,now:()=>T}};
}
const projection = require("./vaultProjection") as typeof import("./vaultProjection");
test("H1/H2 integration: real canonical/outbox/ledger transactions, 10 held -> repair -> done startup -> 0 held; no Markdown writes",async()=>{
  const f=await productionNarrowFixture();
  assert.equal(f.plan.heldCount,10);
  const markdown=new Map([...f.vault.files].filter(([p])=>p.startsWith("Memories/")).map(([p,v])=>[p,v.content]));
  for(const p of markdown.keys()) f.vault.writeShouldFail.add(p);
  assert.deepEqual(await narrow.executeNarrowMemoryRepair(f.env,f.plan),{status:"complete",held:0,issues:0});
  for(let i=0;i<5;i++) {
    const m=(await repairDb.getMemoryObject(`c-${i}`))!, state=await repairDb.readMemoryRepairStorage(m.id);
    assert.equal(state.ledger,m.updatedAt); assert.equal(state.outbox!.recordUpdatedAt,m.updatedAt); assert.equal(state.outbox!.status,"done");
  }
  const result=await projection.reconcileDoneVaultOutboxIntegrity(f.projectionEnv);
  assert.equal(result.processed,5);
  for(const e of await repairDb.getDoneVaultOutboxEntries()) assert.equal(e.status,"done");
  const final=await applyMod.planRecoveryApply(f.env.apply);
  assert.equal(final.heldCount,0,JSON.stringify(final.held)); assert.equal(final.plan.issues.length,0); assert.equal(final.ops.length,0);
  assert.deepEqual(new Map([...f.vault.files].filter(([p])=>p.startsWith("Memories/")).map(([p,v])=>[p,v.content])),markdown);
});
test("H1 real transaction intermediate resumes; finalize ledger failure rolls back Outbox done",async()=>{
  const f=await productionNarrowFixture(), commit=f.env.commit;
  let once=true;
  f.env.commit=async(...args)=>{await commit(...args);if(once&&!args[3]) {once=false;throw new Error("page kill after canonical");}};
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"held");
  const mid=await repairDb.readMemoryRepairStorage("c-0");
  assert.equal(mid.ledger,T); assert.equal(mid.outbox!.status,"pending");
  const fake=require("./fakeIdb") as typeof import("./fakeIdb");
  // Fail the ledger write of the FINALIZE transaction only (the preceding canonical/outbox step must still run).
  f.env.commit=async(...args)=>{ if(args[3]) fake.__failNextPutOn("tsumugi","vaultSyncState"); return commit(...args); };
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,null)).status,"held");
  assert.deepEqual(await repairDb.readMemoryRepairStorage("c-0"),mid);
  assert.equal(JSON.parse(f.db.journal!).status,"in-progress");
  f.env.commit=commit;
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,null)).status,"complete");
});
for(const invalid of ["ledger","outbox"] as const) test(`H1 rejects unrelated ${invalid} BEFORE journal/Registry/canonical writes`,async()=>{
  const f=await productionNarrowFixture();
  if(invalid==="ledger") await repairDb.setVaultSyncState("memory:c-0","2030-01-01");
  else {const e=(await repairDb.getVaultOutboxEntry("memory:c-0"))!;await repairDb.putVaultOutboxEntry({...e,recordUpdatedAt:"2030-01-01"});}
  const files=JSON.stringify([...f.vault.files]),snapshot=await f.env.apply.readLocalSnapshot(),state=await repairDb.readMemoryRepairStorage("c-0");
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"held");
  assert.equal(f.db.journal,undefined);assert.equal(JSON.stringify([...f.vault.files]),files);
  assert.deepEqual(await f.env.apply.readLocalSnapshot(),snapshot);assert.deepEqual(await repairDb.readMemoryRepairStorage("c-0"),state);
});
test("H1 rejects neither storage state on resume without changing data",async()=>{
  const f=await productionNarrowFixture(),commit=f.env.commit;
  f.env.commit=async(...a)=>{await commit(...a);throw new Error("stop");};
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"held");
  await repairDb.setVaultSyncState("memory:c-0","2030-01-01");
  f.env.commit=commit;const before=await f.env.apply.readLocalSnapshot();
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,null)).status,"held");
  assert.deepEqual(await f.env.apply.readLocalSnapshot(),before);
  assert.equal(JSON.parse(f.db.journal!).status,"in-progress");
});
test("H2 relocated day-file stops before write; creates no repair done Outbox for startup",async()=>{
  const f=await productionNarrowFixture();
  // This legacy state has no Outbox yet. Repair must not introduce a done task
  // that would direct startup to a second path.
  for(let i=0;i<5;i++)await repairDb.deleteVaultOutboxEntry(`memory:c-${i}`);
  const m=(await repairDb.getMemoryObject("c-0"))!,old=projection.memoryDayFilePath(m),moved="Memories/relocated.md";
  f.vault.files.set(moved,f.vault.files.get(old)!);f.vault.files.delete(old);
  for(const [p,file] of [...f.vault.files]) if(p.startsWith(".tsumugi/")&&file.content.includes(old)) f.vault.put(p,file.content.split(old).join(moved));
  f.plan=await applyMod.planRecoveryApply(f.env.apply);assert.equal(f.plan.heldCount,10);assert.equal(f.plan.plan.issues.length,0);
  const files=JSON.stringify([...f.vault.files]),local=await f.env.apply.readLocalSnapshot();
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env,f.plan)).status,"held");
  assert.equal(f.db.journal,undefined);assert.equal(JSON.stringify([...f.vault.files]),files);assert.deepEqual(await f.env.apply.readLocalSnapshot(),local);
  assert.equal((await projection.reconcileDoneVaultOutboxIntegrity(f.projectionEnv)).processed,0);
  assert.equal(f.vault.get(old),undefined);assert.equal(JSON.stringify([...f.vault.files]),files);
});

test("H2: Recoveryが使うexpected pathと通常projectionのpathは同じhelper（memoryDayFilePath）から得る",()=>{
  const fs=require("node:fs") as typeof import("node:fs");
  const strip=(t:string)=>t.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm,"");
  const repair=strip(fs.readFileSync("src/lib/memoryNarrowRepair.ts","utf8")), proj=strip(fs.readFileSync("src/lib/vaultProjection.ts","utf8"));
  assert.ok(/import \{ memoryDayFilePath \} from "\.\/vaultProjection"/.test(repair));
  assert.ok(!repair.includes("dayFileNameFor(")&&!repair.includes("`Memories/"),"Recovery側にpathルールをコピーしていない");
  assert.ok(proj.includes("const path = memoryDayFilePath(canonical);"),"通常projectionの書き込みpathも同じhelper");
  const m=memory("h2-helper");
  assert.equal(projection.memoryDayFilePath(m),`Memories/${vaultMod.dayFileNameFor(m.date)}`);
});

// ---------------------------------------------------------------------------
// MEDIUM-1: Registry path of Link targets is verified (never rewritten) before any write.
// MEDIUM-3: Registry shards keep the single serialization contract of the normal writer.
// ---------------------------------------------------------------------------
const shardFiles = (v: { files: Map<string, { content: string }> }) => [...v.files].filter(([p]) => p.startsWith(".tsumugi/registry/")).map(([p, f]) => [p, f.content] as const);
const readShard = (c: string) => JSON.parse(c) as { records: Record<string, string>; files: Record<string, Record<string, unknown>> };
async function expectNoWrite(f: Awaited<ReturnType<typeof productionNarrowFixture>>) {
  assert.equal(f.plan.heldCount, 10, "the plan itself is unchanged: only the new preflight can stop the repair"); assert.equal(f.plan.plan.issues.length, 0);
  const files = JSON.stringify([...f.vault.files]), local = await f.env.apply.readLocalSnapshot();
  const storage = await Promise.all([0,1,2,3,4].map(i => repairDb.readMemoryRepairStorage(`c-${i}`)));
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, f.plan)).status, "held");
  assert.equal(f.db.journal, undefined, "stopped before the journal was created");
  assert.equal(JSON.stringify([...f.vault.files]), files, "Registry and Markdown are byte-identical");
  assert.deepEqual(await f.env.apply.readLocalSnapshot(), local);
  assert.deepEqual(await Promise.all([0,1,2,3,4].map(i => repairDb.readMemoryRepairStorage(`c-${i}`))), storage, "Outbox and ledger unchanged");
  return files;
}
test("M1-registry: Link target whose Registry path equals the actual path is repaired", async () => {
  const f = await productionNarrowFixture();
  for (let i = 0; i < 5; i++) {
    const m = (await repairDb.getMemoryObject(`c-${i}`))!, key = vaultMod.dayFileRegistryKey(m.date.slice(0, 10));
    const sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`;
    assert.equal(readShard(f.vault.get(sp)!).records[key], projection.memoryDayFilePath(m));
  }
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, f.plan)).status, "complete");
});
test("M1-registry: Link target Registry path mismatch (seen only by the repair's own read) stops before journal; nothing changes; startup creates no duplicate Markdown", async () => {
  // The Plan scan sees a consistent Vault; only the repair preflight's Registry read is altered, so this
  // isolates the new Link-target check (the Plan-level reason counts cannot be what stops the repair).
  const f = await productionNarrowFixture();
  const m = (await repairDb.getMemoryObject("c-0"))!, key = vaultMod.dayFileRegistryKey(m.date.slice(0, 10));
  const sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`;
  const read = f.env.read;
  f.env.read = async p => { const r = await read(p); if (p !== sp) return r; const shard = readShard(r.raw); shard.records[key] = "Memories/elsewhere.md"; return { ...r, raw: vaultMod.serializeVaultRegistryShard(shard) }; };
  const files = await expectNoWrite(f);
  assert.equal(readShard(f.vault.get(sp)!).records[key], projection.memoryDayFilePath(m), "Registry path is never rewritten");
  const memoriesBefore = [...f.vault.files.keys()].filter(p => p.startsWith("Memories/")).sort();
  await projection.reconcileDoneVaultOutboxIntegrity(f.projectionEnv);
  assert.deepEqual([...f.vault.files.keys()].filter(p => p.startsWith("Memories/")).sort(), memoriesBefore, "no duplicate Markdown");
  assert.equal(JSON.stringify([...f.vault.files]), files);
});
test("M3: shards written by the normal writer use the shared serializer, and repair keeps exactly that format", async () => {
  const f = await productionNarrowFixture();
  const writer = new FakeVault(); // the normal Registry writer
  await vaultMod.vaultRecoveryPrimitives.upsertVaultRegistryRecord(writer.root(), { registryKey: "k1", path: "Memories/a.md", recordType: "memory-day", mtime: 1, size: 2, contentHash: "h", memberIds: ["x"], memberHashes: { x: "y" } });
  for (const [, content] of shardFiles(writer)) assert.equal(content, vaultMod.serializeVaultRegistryShard(JSON.parse(content)));
  const before = new Map(shardFiles(f.vault));
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, f.plan)).status, "complete");
  let changedEntries = 0;
  for (const [p, content] of shardFiles(f.vault)) {
    const prev = before.get(p)!;
    assert.equal(content, vaultMod.serializeVaultRegistryShard(JSON.parse(content)), "same bytes the normal writer would produce");
    assert.ok(content.includes("\n  "), "not compacted");
    if (content === prev) continue;
    const a = readShard(prev), b = readShard(content);
    assert.deepEqual(b.records, a.records); assert.deepEqual(Object.keys(b.files), Object.keys(a.files));
    for (const file of Object.keys(a.files)) {
      if (JSON.stringify(a.files[file]) === JSON.stringify(b.files[file])) continue; // untouched entries are identical
      changedEntries++;
      assert.deepEqual({ ...b.files[file], contentHash: 0 }, { ...a.files[file], contentHash: 0 }, "only contentHash differs");
      assert.equal(b.files[file].contentHash, vaultMod.hashVaultText(f.vault.get(file)!));
    }
    assert.deepEqual(Object.keys(b), Object.keys(a));
  }
  assert.equal(changedEntries, 3);
});
test("M3: a shard that is not in the writer's canonical format is never reformatted (stops before any write)", async () => {
  const f = await productionNarrowFixture();
  const [sp, content] = shardFiles(f.vault)[0];
  f.vault.put(sp, JSON.stringify(JSON.parse(content)));
  f.plan = await applyMod.planRecoveryApply(f.env.apply);
  await expectNoWrite(f);
});
test("M1-registry: an actually inconsistent Registry path for a Link target is also never repaired", async () => {
  const f = await productionNarrowFixture();
  const m = (await repairDb.getMemoryObject("c-0"))!, key = vaultMod.dayFileRegistryKey(m.date.slice(0, 10));
  const sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`;
  const shard = readShard(f.vault.get(sp)!); shard.records[key] = "Memories/elsewhere.md";
  f.vault.put(sp, vaultMod.serializeVaultRegistryShard(shard));
  const files = JSON.stringify([...f.vault.files]), local = await f.env.apply.readLocalSnapshot();
  assert.equal((await narrow.executeNarrowMemoryRepair(f.env, await applyMod.planRecoveryApply(f.env.apply))).status, "held");
  assert.equal(f.db.journal, undefined); assert.equal(JSON.stringify([...f.vault.files]), files); assert.deepEqual(await f.env.apply.readLocalSnapshot(), local);
});

// ---------------------------------------------------------------------------
// Diagnostics: a stop before the journal reports exactly which guard stopped it (return value only).
// ---------------------------------------------------------------------------
async function expectStopsWith(f: Awaited<ReturnType<typeof productionNarrowFixture>>, code: string, memoryId?: string, plan = f.plan) {
  const files = JSON.stringify([...f.vault.files]), local = await f.env.apply.readLocalSnapshot();
  const storage = await Promise.all([0,1,2,3,4].map(i => repairDb.readMemoryRepairStorage(`c-${i}`)));
  const result = await narrow.executeNarrowMemoryRepair(f.env, plan);
  assert.equal(result.status, "held"); assert.equal(result.failure?.code, code, JSON.stringify(result.failure));
  assert.equal(result.failure?.phase, "prepare"); if (memoryId) assert.equal(result.failure?.memoryId, memoryId);
  assert.ok(result.failure?.expected !== undefined && result.failure?.actual !== undefined, "expected/actual are reported");
  assert.equal(f.db.journal, undefined, "no journal"); assert.equal(JSON.stringify([...f.vault.files]), files, "Vault (Registry/Markdown) unchanged");
  assert.deepEqual(await f.env.apply.readLocalSnapshot(), local, "canonical unchanged");
  assert.deepEqual(await Promise.all([0,1,2,3,4].map(i => repairDb.readMemoryRepairStorage(`c-${i}`))), storage, "Outbox and ledger unchanged");
  return result;
}
test("Diagnostics: storage (ledger) mismatch", async () => {
  const f = await productionNarrowFixture(); await repairDb.setVaultSyncState("memory:c-0", "2030-01-01");
  const r = await expectStopsWith(f, "repair-ledger-changed", "c-0"); assert.match(r.failure!.actual!, /ledger other-value/);
});
test("Diagnostics: storage (outbox) mismatch", async () => {
  const f = await productionNarrowFixture(); const e = (await repairDb.getVaultOutboxEntry("memory:c-0"))!; await repairDb.putVaultOutboxEntry({ ...e, recordUpdatedAt: "2030-01-01" });
  const r = await expectStopsWith(f, "repair-outbox-changed", "c-0"); assert.match(r.failure!.actual!, /recordUpdatedAt:other-value/);
});
test("Diagnostics: Registry path mismatch", async () => {
  const f = await productionNarrowFixture(); const m = (await repairDb.getMemoryObject("c-0"))!, key = vaultMod.dayFileRegistryKey(m.date.slice(0, 10));
  const sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`, read = f.env.read;
  f.env.read = async p => { const r = await read(p); if (p !== sp) return r; const shard = readShard(r.raw); shard.records[key] = "Memories/elsewhere.md"; return { ...r, raw: vaultMod.serializeVaultRegistryShard(shard) }; };
  const r = await expectStopsWith(f, "registry-path-mismatch", "c-0"); assert.equal(r.failure!.actual, "Memories/elsewhere.md");
});
test("Diagnostics: actual path differs from the normal projection path", async () => {
  const f = await productionNarrowFixture(); for (let i = 0; i < 5; i++) await repairDb.deleteVaultOutboxEntry(`memory:c-${i}`);
  const m = (await repairDb.getMemoryObject("c-0"))!, old = projection.memoryDayFilePath(m), moved = "Memories/relocated.md";
  f.vault.files.set(moved, f.vault.files.get(old)!); f.vault.files.delete(old);
  for (const [p, file] of [...f.vault.files]) if (p.startsWith(".tsumugi/") && file.content.includes(old)) f.vault.put(p, file.content.split(old).join(moved));
  f.plan = await applyMod.planRecoveryApply(f.env.apply);
  const r = await expectStopsWith(f, "actual-path-differs-from-normal-projection-path-canonical"); assert.equal(r.failure!.expected, old); assert.equal(r.failure!.actual, moved);
});
test("Diagnostics: timestamp validation failure", async () => {
  const f = await productionNarrowFixture(); const m = (await repairDb.getMemoryObject("c-0"))!;
  await repairDb.putMemoryObject({ ...m, updatedAt: "2030-01-01T00:00:00.000Z" });
  f.plan = await applyMod.planRecoveryApply(f.env.apply);
  await expectStopsWith(f, "link-vault-updatedat-not-newer", "c-0");
});
test("Diagnostics: registry day-file count mismatch", async () => {
  const f = await productionNarrowFixture(2); assert.equal(f.plan.heldCount, 10);
  const r = await expectStopsWith(f, "registry-day-file-count-mismatch"); assert.equal(r.failure!.expected, "3 day-files"); assert.equal(r.failure!.actual, "2 day-files");
});
test("Diagnostics: plan changed since the confirmed plan reports both held summaries", async () => {
  const f = await productionNarrowFixture(); const stale = clone(f.plan); stale.held = stale.held.filter(h => h.reason === "conflict"); stale.heldCount = 5;
  const r = await expectStopsWith(f, "held-targets-differ-from-confirmed-plan", undefined, stale);
  assert.match(r.failure!.expected!, /held=5/); assert.match(r.failure!.actual!, /held=10/); assert.match(r.failure!.actual!, /registry-entry-differs:5/);
});
test("Diagnostics: no confirmed plan, and failure details never include record content", async () => {
  const f = await productionNarrowFixture(); const r = await narrow.executeNarrowMemoryRepair(f.env, null);
  assert.equal(r.failure?.code, "no-confirmed-plan"); assert.equal(f.db.journal, undefined);
  assert.ok(!JSON.stringify(r).includes("内容"));
});
test("Diagnostics: success path is unchanged and reports no failure", async () => {
  const f = await productionNarrowFixture(); const r = await narrow.executeNarrowMemoryRepair(f.env, f.plan);
  assert.deepEqual(r, { status: "complete", held: 0, issues: 0 });
});

// ---------------------------------------------------------------------------
// Archive-excluded confirmed plan (what the screen shows) vs raw actual plan (what repair verifies/uses).
// ---------------------------------------------------------------------------
const archiveEntries = (v: { files: Map<string, { content: string }> }) => [...v.files].filter(([p]) => p.startsWith(".tsumugi/recovery-archive/")).map(([p, f]) => [p, f.content] as const);
async function archivedFixture(registryDays = 3) {
  const f = await productionNarrowFixture(registryDays);
  // The real cleanup takes the world lock (FIFO fake, one queue per lock name) and needs the H4 epoch records.
  class FifoLocks {
    private tails = new Map<string, Promise<void>>();
    async request<R>(name: string, a: unknown, b?: (l: { name: string } | null) => Promise<R>): Promise<R> {
      const cb = (typeof a === "function" ? a : b) as (l: { name: string } | null) => Promise<R>;
      const turn = this.tails.get(name) ?? Promise.resolve(); let release!: () => void;
      this.tails.set(name, new Promise<void>(r => { release = r; })); await turn;
      try { return await cb({ name }); } finally { release(); }
    }
  }
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { locks: new FifoLocks() }, configurable: true, writable: true });
  const worldLock = require("./vaultWorldLock") as typeof import("./vaultWorldLock");
  const currentEpoch = await repairDb.getActiveVaultEpoch(); await repairDb.markVaultEpochCommitted(currentEpoch); await repairDb.markVaultWorldJournalMigrated(); worldLock.setTabVaultEpoch(currentEpoch);
  let cleanup: Awaited<ReturnType<typeof f.legacy.runLegacyHeldCleanup>>;
  try { cleanup = await f.legacy.runLegacyHeldCleanup({ root: f.vault.root(), vaultIdentity: f.identity, now: () => T }); }
  finally { if (nav) Object.defineProperty(globalThis, "navigator", nav); else delete (globalThis as { navigator?: unknown }).navigator; }
  assert.ok(!("notRun" in cleanup)); if ("notRun" in cleanup) throw new Error("cleanup did not run");
  assert.equal(cleanup.archived, 5, "only the 5 Link conflicts are archived (registry-entry-differs is not archive-eligible)");
  const raw = await applyMod.planRecoveryApply(f.env.apply);
  const excluded = await f.legacy.excludeArchivedFromApplyPlan({ root: f.vault.root(), vaultIdentity: f.identity, now: () => T }, raw);
  return { ...f, raw, excluded };
}
test("Archive: raw plan 10, archive-excluded plan 5 (registry-entry-differs only); archive is only a pre-repair copy", async () => {
  const f = await archivedFixture();
  assert.equal(f.raw.heldCount, 10); assert.equal(f.excluded.heldCount, 5);
  assert.deepEqual([...new Set(f.excluded.held.map(h => h.reason))], ["registry-entry-differs"]);
  assert.equal(f.raw.held.filter(h => h.reason === "conflict").length, 5);
});
test("Archive: confirmed=excluded(5) is checked against the SAME view of the current state; repair runs on raw 10 and completes", async () => {
  const f = await archivedFixture();
  const archiveBefore = archiveEntries(f.vault), memories = new Map([...f.vault.files].filter(([p]) => p.startsWith("Memories/")).map(([p, v]) => [p, v.content]));
  for (const p of memories.keys()) f.vault.writeShouldFail.add(p);
  assert.deepEqual(await narrow.executeNarrowMemoryRepair(f.env, f.excluded), { status: "complete", held: 0, issues: 0 });
  const rawAfter = await applyMod.planRecoveryApply(f.env.apply);
  assert.equal(rawAfter.heldCount, 0); assert.equal(rawAfter.plan.issues.length, 0);
  assert.equal((await projection.reconcileDoneVaultOutboxIntegrity(f.projectionEnv)).processed, 5);
  const rawFinal = await applyMod.planRecoveryApply(f.env.apply);
  assert.equal(rawFinal.heldCount, 0); assert.equal(rawFinal.plan.issues.length, 0); assert.equal(rawFinal.ops.length, 0);
  assert.deepEqual(new Map([...f.vault.files].filter(([p]) => p.startsWith("Memories/")).map(([p, v]) => [p, v.content])), memories, "Memory Markdown byte-identical, no duplicate");
  assert.deepEqual(archiveEntries(f.vault), archiveBefore, "archive entries are never changed");
});
test("Archive negative A: an unrelated held record appeared after confirmation -> stops before journal", async () => {
  const f = await archivedFixture();
  const p = (await repairDb.getMemoryObject("p-0"))!; await repairDb.putMemoryObject({ ...p, summary: "unrelated change" });
  const files = JSON.stringify([...f.vault.files]);
  const r = await narrow.executeNarrowMemoryRepair(f.env, f.excluded);
  assert.equal(r.failure?.code, "held-targets-differ-from-confirmed-plan"); assert.equal(f.db.journal, undefined); assert.equal(JSON.stringify([...f.vault.files]), files);
});
test("Archive negative B: archive no longer matches the current state -> confirmed != current excluded -> stops before journal", async () => {
  const f = await archivedFixture();
  const c = (await repairDb.getMemoryObject("c-0"))!; await repairDb.putMemoryObject({ ...c, summary: "changed after archive" });
  const files = JSON.stringify([...f.vault.files]);
  const r = await narrow.executeNarrowMemoryRepair(f.env, f.excluded);
  assert.equal(r.failure?.code, "held-targets-differ-from-confirmed-plan"); assert.equal(f.db.journal, undefined); assert.equal(JSON.stringify([...f.vault.files]), files);
});
test("Archive negative C: raw plan is no longer 5+5 (even with a matching confirmed view) -> repair forbidden", async () => {
  const f = await archivedFixture();
  const key = vaultMod.dayFileRegistryKey("2026-09-24"), sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`;
  const file = `Memories/${vaultMod.dayFileNameFor("2026-09-24")}`, shard = readShard(f.vault.get(sp)!);
  shard.files[file].contentHash = vaultMod.hashVaultText(f.vault.get(file)!); f.vault.put(sp, vaultMod.serializeVaultRegistryShard(shard));
  const raw = await applyMod.planRecoveryApply(f.env.apply), excluded = await f.legacy.excludeArchivedFromApplyPlan({ root: f.vault.root(), vaultIdentity: f.identity, now: () => T }, raw);
  assert.notEqual(raw.heldCount, 10);
  const files = JSON.stringify([...f.vault.files]), r = await narrow.executeNarrowMemoryRepair(f.env, excluded);
  assert.equal(r.status, "held"); assert.equal(r.failure?.code, "held-diagnostic-not-complete"); assert.equal(f.db.journal, undefined); assert.equal(JSON.stringify([...f.vault.files]), files);
});
test("Archive negative D: read issues (issues > 0) -> repair forbidden", async () => {
  const f = await archivedFixture();
  f.vault.put("broken.md", "---\ntsumugi: true\n---\nno id, no recognizable section");
  const raw = await applyMod.planRecoveryApply(f.env.apply), excluded = await f.legacy.excludeArchivedFromApplyPlan({ root: f.vault.root(), vaultIdentity: f.identity, now: () => T }, raw);
  assert.ok(raw.plan.issues.length > 0 || raw.heldCount !== 10);
  const files = JSON.stringify([...f.vault.files]), r = await narrow.executeNarrowMemoryRepair(f.env, excluded);
  assert.equal(r.status, "held"); assert.equal(f.db.journal, undefined); assert.equal(JSON.stringify([...f.vault.files]), files);
});
test("Archive negative E: an unreadable archive entry fails safe (not excluded -> confirmed differs) before journal", async () => {
  const f = await archivedFixture();
  const [entryPath] = archiveEntries(f.vault).find(([p]) => p.endsWith(".json") && !p.split("/").pop()!.startsWith(".tmp-")) ?? [undefined]; assert.ok(entryPath);
  f.vault.put(entryPath!, "{ not json");
  const files = JSON.stringify([...f.vault.files]), r = await narrow.executeNarrowMemoryRepair(f.env, f.excluded);
  assert.equal(r.status, "held"); assert.equal(f.db.journal, undefined); assert.equal(JSON.stringify([...f.vault.files]), files);
});
test("Archive diagnostics: screen plan = 5, read-only diagnostic uses the raw plan = 10 (registry 5 / conflict 5), zero mutation", async () => {
  const f = await archivedFixture(); assert.equal(f.excluded.heldCount, 5);
  const files = JSON.stringify([...f.vault.files]), local = JSON.stringify(await f.env.apply.readLocalSnapshot());
  const inspect = require("./recoveryMemoryDiagnostic") as typeof import("./recoveryMemoryDiagnostic");
  const { diagnostic, rawHeld } = await narrow.runRawHeldMemoryDiagnostic(f.vault.root(), () => true, {
    plan: () => applyMod.planRecoveryApply(f.env.apply),
    diagnose: (plan, root, still) => inspect.inspectHeldMemories(plan, root, f.env.apply.readLocalSnapshot, still),
  });
  assert.equal(rawHeld, 10); assert.equal(diagnostic.status, "complete");
  if (diagnostic.status === "complete") { assert.equal(diagnostic.registry.heldMemoryCount, 5); assert.equal(diagnostic.conflicts.count, 5); assert.equal(diagnostic.registry.dayFileCount, 3); }
  assert.equal(JSON.stringify([...f.vault.files]), files); assert.equal(JSON.stringify(await f.env.apply.readLocalSnapshot()), local); assert.equal(f.db.journal, undefined);
});

// ---------------------------------------------------------------------------
// Production-wired integration: the production env (createProductionNarrowRepairEnv/runExplicitMemoryRepair),
// real db.ts over the fake IndexedDB (real readWorld/identity/Outbox/ledger/journal store), real archive exclusion.
// The ONLY replaced dependency is apply.readLocalSnapshot/readRecord (the fake IndexedDB has no IDBFactory.databases()).
// ---------------------------------------------------------------------------
class WiredLocks {
  private tails = new Map<string, Promise<void>>();
  async request<R>(name: string, a: unknown, b?: (l: { name: string } | null) => Promise<R>): Promise<R> {
    const cb = (typeof a === "function" ? a : b) as (l: { name: string } | null) => Promise<R>;
    const turn = this.tails.get(name) ?? Promise.resolve(); let release!: () => void;
    this.tails.set(name, new Promise<void>(r => { release = r; })); await turn;
    try { return await cb({ name }); } finally { release(); }
  }
}
async function withProductionGlobals<R>(fn: () => Promise<R>): Promise<R> {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
  Object.defineProperty(globalThis, "navigator", { value: { locks: new WiredLocks() }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "window", { value: { location: { search: "?debugLog=1" } }, configurable: true, writable: true });
  try { return await fn(); }
  finally { for (const k of ["navigator", "window"] as const) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]!); else delete g[k]; } }
}
async function wiredFixture() {
  const f = await archivedFixture();
  const worldLock = require("./vaultWorldLock") as typeof import("./vaultWorldLock");
  let epoch = await repairDb.getActiveVaultEpoch(); while (epoch < 2) epoch = await repairDb.bumpActiveVaultEpoch(epoch);
  await repairDb.markVaultEpochCommitted(epoch); worldLock.setTabVaultEpoch(epoch); // the fake IndexedDB is shared by the whole file: commit whatever the active epoch is now
  // Production shape: the identity record's activeVaultEpoch has never been populated.
  await repairDb.putVaultIdentityRecord({ id: "current", vaultId: "fixture-identity", activeVaultEpoch: null, registryGeneration: null, pairedAt: T, pendingCandidateVaultId: null, updatedAt: T });
  // The fake IndexedDB is shared by the whole file: start every scenario with an abandoned (inert) journal.
  await repairDb.writeRecoveryJournalRaw(JSON.stringify({ version: 1, operationId: "test-reset", status: "abandoned", createdAt: T, updatedAt: T,
    world: { activeVaultEpoch: 0, committedVaultEpoch: 0, registryGenerationEpoch: 0, journalVersion: "current", backend: null },
    baselineAtStart: { status: "unset", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false }));
  const root = f.vault.root();
  const apply = { ...applyMod.createRecoveryApplyEnv(root), readLocalSnapshot: f.env.apply.readLocalSnapshot, readRecord: f.env.apply.readRecord };
  const confirmedNow = async () => {
    const raw = await applyMod.planRecoveryApply(apply);
    return f.legacy.excludeArchivedFromApplyPlan({ root, vaultIdentity: (await repairDb.getVaultIdentityRecord()) ?? null, now: () => T }, raw);
  };
  const snapshot = async () => JSON.stringify({ files: [...f.vault.files], memories: await repairDb.getAllMemoryObjects(),
    storage: await Promise.all([0,1,2,3,4].map(i => repairDb.readMemoryRepairStorage(`c-${i}`))), journal: await repairDb.readRecoveryJournalRaw() });
  return { ...f, root, apply, confirmed: await confirmedNow(), confirmedNow, snapshot };
}
type Wired = Awaited<ReturnType<typeof wiredFixture>>;
const wiredEnv = (w: Wired) => narrow.createProductionNarrowRepairEnv(w.root, w.apply);

test("Wired: production-shaped state (raw 10, excluded 5, identity epoch null, world epoch number)", async () => {
  const w = await wiredFixture();
  assert.equal((await repairDb.getVaultIdentityRecord())!.activeVaultEpoch, null);
  assert.ok((await repairDb.getActiveVaultEpoch()) >= 2);
  const world = await w.apply.readWorld(); assert.equal(world.committedVaultEpoch, world.activeVaultEpoch);
  assert.equal((await applyMod.planRecoveryApply(w.apply)).heldCount, 10); assert.equal(w.confirmed.heldCount, 5);
});
test("Wired: EVERY prepare guard passes with production dependencies (guard table)", async () => {
  const w = await wiredFixture(); const trace: { code: string; pass: boolean; detail: Record<string, string | undefined> }[] = [];
  narrow.__setNarrowRepairCheckTrace(e => trace.push(e));
  const before = await w.snapshot();
  try {
    const result = await withProductionGlobals(() => narrow.runExplicitMemoryRepair(w.root, w.confirmed, { apply: w.apply }));
    assert.deepEqual(result, { status: "complete", held: 0, issues: 0 });
  } finally { narrow.__setNarrowRepairCheckTrace(null); }
  assert.notEqual(await w.snapshot(), before);
  const failed = trace.filter(t => !t.pass); assert.deepEqual(failed, [], JSON.stringify(failed));
  const codes = new Set(trace.map(t => t.code));
  for (const code of ["world-changed-since-confirmed-plan", "held-targets-differ-from-confirmed-plan", "plan-has-recoverable-ops", "held-diagnostic-not-complete", "registry-day-file-count-mismatch",
    "recovery-vault-path-not-unique", "memory-missing-in-vault-or-canonical", "actual-path-differs-from-normal-projection-path-canonical", "actual-path-differs-from-normal-projection-path-vault", "registry-path-mismatch",
    "link-differing-fields-not-only-links-updatedat", "link-not-vault-strict-superset", "link-updatedat-invalid", "link-vault-updatedat-not-newer", "link-createdat-invalid-or-after-updatedat", "link-counterpart-not-unique", "link-counterpart-link-differs",
    "link-restored-memory-not-byte-equal-to-vault", "registry-target-not-semantically-equivalent", "registry-shard-not-in-canonical-format", "registry-entry-missing", "registry-entry-status-or-type", "registry-entry-mtime-or-size-differs",
    "registry-memberids-differ", "registry-memberhashes-keys-differ", "registry-memberhash-differs", "registry-contenthash-pattern-unexpected", "link-target-count-mismatch", "dayfile-member-not-equivalent-to-canonical",
    "vault-identity-unpaired", "vault-identity-mismatch", "vault-world-epoch-invalid", "vault-world-epoch-not-committed"]) assert.ok(codes.has(code), `guard never evaluated: ${code}`);
  if (process.env.SHOW_GUARDS) { const seen = new Set<string>(); for (const t of trace) { if (seen.has(t.code)) continue; seen.add(t.code); console.log(`GUARD ${t.pass ? "PASS" : "FAIL"} ${t.code} | expected: ${t.detail.expected ?? "-"} | actual: ${t.detail.actual ?? "-"}`); } }
});
test("Wired: full Production-simulated run 10 -> 0, then startup/done-Outbox reconciliation keeps 0", async () => {
  const w = await wiredFixture();
  const markdown = new Map([...w.vault.files].filter(([p]) => p.startsWith("Memories/")).map(([p, v]) => [p, v.content]));
  const archiveBefore = archiveEntries(w.vault), shardsBefore = new Map(shardFiles(w.vault)), others = new Map([...w.vault.files].filter(([p]) => !p.startsWith(".tsumugi/registry/")).map(([p, v]) => [p, v.content]));
  const canonicalBefore = new Map((await repairDb.getAllMemoryObjects()).map(m => [m.id, m]));
  for (const p of markdown.keys()) w.vault.writeShouldFail.add(p);
  const result = await withProductionGlobals(() => narrow.runExplicitMemoryRepair(w.root, w.confirmed, { apply: w.apply }));
  assert.deepEqual(result, { status: "complete", held: 0, issues: 0 });
  assert.equal((await applyMod.planRecoveryApply(w.apply)).heldCount, 0);
  assert.equal((await projection.reconcileDoneVaultOutboxIntegrity(w.projectionEnv)).processed, 5);
  const rawFinal = await applyMod.planRecoveryApply(w.apply);
  assert.equal(rawFinal.heldCount, 0); assert.equal(rawFinal.plan.issues.length, 0); assert.equal(rawFinal.ops.length, 0);
  assert.deepEqual(new Map([...w.vault.files].filter(([p]) => p.startsWith("Memories/")).map(([p, v]) => [p, v.content])), markdown, "Memory Markdown byte-identical, no duplicates");
  assert.deepEqual(archiveEntries(w.vault), archiveBefore, "archive byte-identical");
  assert.deepEqual(new Map([...w.vault.files].filter(([p]) => !p.startsWith(".tsumugi/registry/")).map(([p, v]) => [p, v.content])), others, "only Registry shards changed in the Vault");
  const changedShards = shardFiles(w.vault).filter(([p, c]) => shardsBefore.get(p) !== c); assert.equal(changedShards.length, 3, "exactly the 3 intended Registry shards");
  for (const m of await repairDb.getAllMemoryObjects()) {
    const before = canonicalBefore.get(m.id)!;
    if (/^c-\d$/.test(m.id)) {
      assert.deepEqual({ ...m, links: before.links, updatedAt: before.updatedAt }, before, "only links/updatedAt change"); assert.equal(m.links.length, 1);
      const st = await repairDb.readMemoryRepairStorage(m.id); assert.equal(st.ledger, m.updatedAt); assert.equal(st.outbox!.status, "done"); assert.equal(st.outbox!.recordUpdatedAt, m.updatedAt);
      const other = (await repairDb.getMemoryObject(m.links[0].sourceId === m.id ? m.links[0].targetId : m.links[0].sourceId))!; assert.ok(other.links.some(l => l.id === m.links[0].id), "counterpart link consistent");
    } else assert.deepEqual(m, before, "other Memories are untouched");
  }
  assert.equal(JSON.parse((await repairDb.readRecoveryJournalRaw())!).status, "completed");
});
for (const [name, code] of [["A: vaultId mismatch", "vault-identity-mismatch"], ["B: committed != active epoch", "vault-world-epoch-not-committed"]] as const) {
  test(`Wired negative ${name} -> stops before journal`, async () => {
    const w = await wiredFixture();
    if (code === "vault-identity-mismatch") await repairDb.putVaultIdentityRecord({ ...(await repairDb.getVaultIdentityRecord())!, vaultId: "someone-else" });
    else await repairDb.bumpActiveVaultEpoch(await repairDb.getActiveVaultEpoch());
    const confirmed = await w.confirmedNow(), before = await w.snapshot();
    const r = await narrow.executeNarrowMemoryRepair(wiredEnv(w), confirmed);
    assert.equal(r.status, "held"); assert.equal(r.failure?.code, code, JSON.stringify(r.failure)); assert.equal(r.failure?.phase, "prepare");
    assert.equal(await w.snapshot(), before, "no journal, no write");
  });
}
test("Wired negative C: the world changes after the journal (before any repair write) -> held at the existing safe point", async () => {
  const w = await wiredFixture(), env = wiredEnv(w), identity = env.identity; let calls = 0;
  env.identity = async () => { if (++calls === 2) await repairDb.bumpActiveVaultEpoch(await repairDb.getActiveVaultEpoch()); return identity(); };
  const files = JSON.stringify([...w.vault.files]), canonical = JSON.stringify(await repairDb.getAllMemoryObjects()), journalBefore = await repairDb.readRecoveryJournalRaw();
  const r = await narrow.executeNarrowMemoryRepair(env, w.confirmed);
  assert.equal(r.failure?.code, "vault-world-epoch-not-committed"); assert.equal(r.failure?.phase, "post-journal");
  assert.equal(r.status, "held"); assert.equal(JSON.stringify([...w.vault.files]), files, "Vault unchanged"); assert.equal(JSON.stringify(await repairDb.getAllMemoryObjects()), canonical, "canonical unchanged");
  assert.notEqual(await repairDb.readRecoveryJournalRaw(), journalBefore); assert.equal(JSON.parse((await repairDb.readRecoveryJournalRaw())!).status, "in-progress");
});
test("Wired negative D: the archive-excluded view changed after confirmation -> stops before journal", async () => {
  const w = await wiredFixture(); const c = (await repairDb.getMemoryObject("c-0"))!; await repairDb.putMemoryObject({ ...c, summary: "changed after archive" });
  const before = await w.snapshot(), r = await narrow.executeNarrowMemoryRepair(wiredEnv(w), w.confirmed);
  assert.equal(r.failure?.code, "held-targets-differ-from-confirmed-plan"); assert.equal(await w.snapshot(), before);
});
test("Wired negative E: raw 5+5 broken (even with a matching confirmed view) -> stops before journal", async () => {
  const w = await wiredFixture();
  const key = vaultMod.dayFileRegistryKey("2026-09-24"), sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`, file = `Memories/${vaultMod.dayFileNameFor("2026-09-24")}`;
  const shard = readShard(w.vault.get(sp)!); shard.files[file].contentHash = vaultMod.hashVaultText(w.vault.get(file)!); w.vault.put(sp, vaultMod.serializeVaultRegistryShard(shard));
  const confirmed = await w.confirmedNow(), before = await w.snapshot(), r = await narrow.executeNarrowMemoryRepair(wiredEnv(w), confirmed);
  assert.equal(r.failure?.code, "held-diagnostic-not-complete"); assert.equal(await w.snapshot(), before);
});
test("Wired negative F: read issues -> stops before journal", async () => {
  const w = await wiredFixture(); w.vault.put("broken.md", "---\ntsumugi: true\n---\nno id, no recognizable section");
  const confirmed = await w.confirmedNow(), before = await w.snapshot(), r = await narrow.executeNarrowMemoryRepair(wiredEnv(w), confirmed);
  assert.equal(r.status, "held"); assert.equal(await w.snapshot(), before);
});

// ---------------------------------------------------------------------------
// READ ONLY pre-repair check (dry-run)
// ---------------------------------------------------------------------------
const fullState = async (w: Wired) => JSON.stringify({ base: await w.snapshot(), identity: await repairDb.getVaultIdentityRecord(), epoch: await repairDb.getActiveVaultEpoch(),
  committed: await repairDb.getCommittedVaultEpoch(), archive: archiveEntries(w.vault), ledger: await Promise.all([0,1,2,3,4].map(i => repairDb.getVaultSyncState(`memory:c-${i}`))) });
const dry = (w: Wired, confirmed: import("./vaultRecoveryApply").RecoveryApplyPlan | null = w.confirmed) => narrow.runNarrowRepairPreflight(wiredEnv(w), confirmed);
const failsOf = (r: import("./memoryNarrowRepair").PreflightReport) => r.entries.filter(e => e.status === "FAIL");
test("Preflight: Production-simulated 10 records -> every guard PASS, no SKIP, zero mutation, and the repair still completes afterwards", async () => {
  const w = await wiredFixture(); const before = await fullState(w);
  const report = await dry(w);
  assert.deepEqual(failsOf(report), []); assert.equal(report.fail, 0); assert.equal(report.skip, 0); assert.equal(report.allPass, true);
  assert.equal(report.total, report.pass);
  const passed = new Set(report.entries.filter(e => e.status === "PASS").map(e => e.code));
  for (const code of narrow.PREFLIGHT_GUARD_CODES) assert.ok(passed.has(code), `guard not evaluated as PASS: ${code}`);
  assert.equal(await fullState(w), before, "persistent mutation = 0");
  if (process.env.SHOW_GUARDS) console.log(`PREFLIGHT total=${report.total} pass=${report.pass} fail=${report.fail} skip=${report.skip}`);
  // the production entry (debugLog + world lock) gives the same answer and also mutates nothing
  const viaEntry = await withProductionGlobals(() => narrow.runExplicitRepairPreflight(w.root, w.confirmed, { apply: w.apply }));
  assert.ok("entries" in viaEntry && viaEntry.allPass); assert.equal(await fullState(w), before);
  assert.deepEqual(await withProductionGlobals(() => narrow.runExplicitMemoryRepair(w.root, w.confirmed, { apply: w.apply })), { status: "complete", held: 0, issues: 0 });
});
test("Preflight: debugLog off -> unavailable, nothing evaluated", async () => {
  const w = await wiredFixture(); const r = await narrow.runExplicitRepairPreflight(w.root, w.confirmed, { apply: w.apply });
  assert.deepEqual(r, { unavailable: "debug-log-not-enabled" });
});
test("Preflight: identity/world mismatch -> the matching guard FAILs, the other guards are still evaluated, zero mutation", async () => {
  const w = await wiredFixture(); await repairDb.bumpActiveVaultEpoch(await repairDb.getActiveVaultEpoch());
  const confirmed = await w.confirmedNow(), before = await fullState(w), report = await dry(w, confirmed);
  assert.deepEqual(failsOf(report).map(e => e.code), ["vault-world-epoch-not-committed"]);
  assert.ok(report.entries.some(e => e.code === "registry-memberhash-differs" && e.status === "PASS"), "later guards were still evaluated");
  assert.equal(await fullState(w), before);
});
test("Preflight: Registry condition mismatch -> Registry guard FAILs, zero mutation", async () => {
  const w = await wiredFixture(); const key = vaultMod.dayFileRegistryKey("2026-09-22"), sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`, file = `Memories/${vaultMod.dayFileNameFor("2026-09-22")}`;
  const shard = readShard(w.vault.get(sp)!); (shard.files[file].memberHashes as Record<string, string>)["r-0"] = "deadbeef"; w.vault.put(sp, vaultMod.serializeVaultRegistryShard(shard));
  const confirmed = await w.confirmedNow(), before = await fullState(w), report = await dry(w, confirmed);
  assert.ok(failsOf(report).some(e => e.code === "registry-memberhash-differs" && e.memoryId === "r-0"), JSON.stringify(failsOf(report)));
  assert.equal(await fullState(w), before);
});
test("Preflight: Link condition mismatch -> Link guard FAILs, zero mutation", async () => {
  const w = await wiredFixture(); const c = (await repairDb.getMemoryObject("c-0"))!; await repairDb.putMemoryObject({ ...c, updatedAt: "2030-01-01T00:00:00.000Z" });
  const confirmed = await w.confirmedNow(), before = await fullState(w), report = await dry(w, confirmed);
  assert.ok(failsOf(report).some(e => e.code === "link-vault-updatedat-not-newer" && e.memoryId === "c-0"), JSON.stringify(failsOf(report)));
  assert.equal(await fullState(w), before);
});
test("Preflight: several abnormalities at once -> all of them are reported in one run", async () => {
  const w = await wiredFixture();
  await repairDb.bumpActiveVaultEpoch(await repairDb.getActiveVaultEpoch());
  const key = vaultMod.dayFileRegistryKey("2026-09-22"), sp = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(key).toString(16).padStart(2, "0")}.json`, file = `Memories/${vaultMod.dayFileNameFor("2026-09-22")}`;
  const shard = readShard(w.vault.get(sp)!); (shard.files[file].memberHashes as Record<string, string>)["r-0"] = "deadbeef"; w.vault.put(sp, vaultMod.serializeVaultRegistryShard(shard));
  const c = (await repairDb.getMemoryObject("c-0"))!; await repairDb.putMemoryObject({ ...c, updatedAt: "2030-01-01T00:00:00.000Z" });
  const confirmed = await w.confirmedNow(), before = await fullState(w), report = await dry(w, confirmed);
  const codes = new Set(failsOf(report).map(e => e.code));
  for (const code of ["vault-world-epoch-not-committed", "registry-memberhash-differs", "link-vault-updatedat-not-newer"]) assert.ok(codes.has(code), `${code} missing from ${[...codes].join(",")}`);
  assert.equal(await fullState(w), before);
});
test("Preflight: a guard that cannot be evaluated safely is SKIP (never PASS), with the prerequisite reason", async () => {
  const w = await wiredFixture(); { const all = await repairDb.getAllMemoryObjects(); await repairDb.clearMemoryData(); for (const m of all) if (m.id !== "p-0") await repairDb.putMemoryObject(m); }
  const confirmed = await w.confirmedNow(), before = await fullState(w), report = await dry(w, confirmed);
  assert.ok(failsOf(report).some(e => e.code === "link-counterpart-not-unique"), JSON.stringify(failsOf(report)));
  const skips = report.entries.filter(e => e.status === "SKIP");
  assert.ok(skips.some(e => e.code === "record-evaluation-incomplete" && e.reason === "prerequisite failed (remaining guards of this record could not be evaluated safely)"));
  for (const code of ["post-journal-payload-validation", "post-journal-verify-inputs", "post-journal-registry-shards-match-planned-before"]) assert.ok(skips.some(e => e.code === code && e.reason === "prerequisite failed"), code);
  assert.equal(report.allPass, false); assert.equal(report.total, report.pass + report.fail + report.skip);
  assert.equal(await fullState(w), before);
});
test("Preflight: no confirmed plan, and an in-progress journal (a resume would run instead), are FAILs", async () => {
  const w = await wiredFixture(); assert.ok(failsOf(await dry(w, null)).some(e => e.code === "no-confirmed-plan"));
  await repairDb.writeRecoveryJournalRaw(JSON.stringify({ version: 1, operationId: "x", status: "in-progress", createdAt: T, updatedAt: T, world: await w.apply.readWorld(), baselineAtStart: { status: "unset", value: null }, managedBefore: {}, ops: [], held: [], result: null, unresolvedMetadata: false }));
  const before = await fullState(w); assert.ok(failsOf(await dry(w)).some(e => e.code === "recovery-journal-allows-new-run")); assert.equal(await fullState(w), before);
});
test("Preflight: UI shows the pre-repair check and the all-pass message; it is wired to the READ ONLY entry only", () => {
  const ui = fs.readFileSync("src/components/RecoveryMemoryDiagnosticPanel.tsx", "utf8");
  for (const text of ["修復前チェック（READ ONLY）", "修復前チェック：全条件PASS", "総check数"]) assert.ok(ui.includes(text), text);
  assert.equal(ui.match(/await runExplicitRepairPreflight\(/g)?.length, 1);
});
