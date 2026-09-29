/**
 * Production Wiring E2E（Phase 3-8）。
 *
 * ChatScreen.tsxはReactコンポーネントであり、このリポジトリにはReact/DOMテスト
 * harness（React Testing Library等）が無い（package.json・src/components/配下を
 * 確認済み）ため、ここでは`handleSend`がChatScreen.tsx内で実際に依存している
 * ライブラリ関数（`putConversationWithOutbox`・`runSaveFoundationBootstrap`）を
 * 直接呼び、handleSendが行っているのと同じ順序・同じ判断を再現することで、
 * Production wiringが依存する契約（User turn保存失敗時にGemini requestへ進めない、
 * app再起動後にbootstrapが復旧する、等）を検証する。ChatScreen.tsx自体の実際の
 * コードは読み込みによって確認済み（Phase 3-8報告参照）。
 *
 * 実行方法：`npm run test:save-foundation`。
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias */
import test from "node:test";
import assert from "node:assert/strict";
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

const dbMod = require(path.join(OUT, "lib/db.js")) as typeof import("./db");
const vaultMod = require(path.join(OUT, "lib/vault.js")) as typeof import("./vault");
const markdownMod = require(path.join(OUT, "lib/markdown.js")) as typeof import("./markdown");
const bootstrapMod = require(path.join(OUT, "lib/saveFoundationBootstrap.js")) as typeof import("./saveFoundationBootstrap");
const productionBootstrapMod = require(path.join(OUT, "lib/productionBootstrap.js")) as typeof import("./productionBootstrap");
const fakeIdbMod = require(path.join(OUT, "lib/fakeIdb.js")) as {
  __failNextPutOn: (dbName: string, storeName: string) => void;
};

type Conversation = import("./types").Conversation;

// ---------------------------------------------------------------------------
// in-memory疑似ファイルシステム（vaultProductionMigration.test.tsと同じ、entries()対応版）
// ---------------------------------------------------------------------------

class FakeFile {
  constructor(public content: string, public mtime: number) {}
}

class FakeVault {
  files = new Map<string, FakeFile>();
  private clock = 1;
  writeShouldFail = new Set<string>();
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
        const p = prefix ? `${prefix}/${name}` : name;
        const hasChildren = [...self.files.keys()].some((k) => k.startsWith(`${p}/`));
        if (!hasChildren && !options?.create) throw new DOMException("no such directory", "NotFoundError");
        return self.dir(p);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (!self.files.has(p) && !options?.create) throw new DOMException("no such file", "NotFoundError");
        return self.file(p);
      },
      async *values() {
        const seen = new Set<string>();
        for (const k of self.files.keys()) {
          if (prefix && !k.startsWith(`${prefix}/`)) continue;
          if (!prefix && k.includes("/")) continue;
          const rel = prefix ? k.slice(prefix.length + 1) : k;
          const first = rel.split("/")[0];
          if (seen.has(first)) continue;
          seen.add(first);
          yield { name: first } as unknown as FileSystemHandle;
        }
      },
      async *entries() {
        const children = new Map<string, "directory" | "file">();
        for (const p of self.files.keys()) {
          if (prefix && !p.startsWith(`${prefix}/`)) continue;
          if (!prefix && p.includes("/")) continue;
          const rel = prefix ? p.slice(prefix.length + 1) : p;
          const first = rel.split("/")[0];
          children.set(first, rel.includes("/") ? "directory" : "file");
        }
        for (const [name, kind] of children) {
          const childPath = prefix ? `${prefix}/${name}` : name;
          yield [name, kind === "directory" ? self.dir(childPath) : self.file(childPath)] as [string, FileSystemHandle];
        }
      },
    } as unknown as FileSystemDirectoryHandle;
  }

  private file(p: string): FileSystemFileHandle {
    const self = this;
    return {
      kind: "file",
      name: p.split("/").pop(),
      async getFile() {
        const f = self.files.get(p);
        if (!f) throw new DOMException("no such file", "NotFoundError");
        return { size: f.content.length, lastModified: f.mtime, async text() { return f.content; } } as unknown as File;
      },
      async createWritable() {
        let pending = "";
        return {
          async write(c: string) { pending = c; },
          async close() {
            self.writeCount += 1;
            if (self.writeShouldFail.has(p)) throw new Error("simulated write failure");
            self.clock += 1;
            self.files.set(p, new FakeFile(pending, self.clock));
          },
        };
      },
    } as unknown as FileSystemFileHandle;
  }

  put(pathStr: string, content: string) {
    this.clock += 1;
    this.files.set(pathStr, new FakeFile(content, this.clock));
  }
  get(pathStr: string): string | undefined {
    return this.files.get(pathStr)?.content;
  }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const T = "2026-09-01T09:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id, persona: "companion", status: "active", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: [{ role: "user", content: "ユーザー発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...meta }, ...overrides,
  } as Conversation;
}

async function resetAll() {
  await dbMod.clearMemoryData();
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null, pendingCandidateVaultId: null, updatedAt: T });
}

let vaultIdSeq = 0;
function makeEnv(vault: FakeVault): import("./saveFoundationBootstrap").SaveFoundationBootstrapEnv {
  return { root: vault.root(), now: () => T, generateVaultId: () => `wiring-vault-id-${++vaultIdSeq}` };
}

// ===========================================================================
// A〜D：ChatScreen.tsx handleSendが実際に依存する契約（コードは読み込みで確認済み。
// このtestはその契約自体をlibraryレベルで直接検証する）
// ===========================================================================

test("Wiring A: User send相当（putConversationWithOutbox成功）は、Gemini request開始の前提条件を満たす", async () => {
  await resetAll();
  const c = conversation("wiring-a-conv");
  // handleSend内の実際の呼び出し：`await putConversationWithOutbox(updated);`
  // （src/components/ChatScreen.tsx、Phase 3-2で導入・確認済み）。例外を投げずに
  // 完了すること自体が、handleSendがこの後fetch("/api/chat")へ進むための唯一の
  // ゲートである（try節の最初の行のため、これが成功しない限り後続へ進まない）。
  const entry = await dbMod.putConversationWithOutbox(c);
  assert.equal(entry.recordId, c.id);
  const stored = await dbMod.getConversation(c.id);
  assert.deepEqual(stored, c, "User turnはIndexedDBへdurableに保存されている（Geminiの成否とは無関係に残る）");
});

test("Wiring B: canonical保存失敗（putConversationWithOutbox throw）は、handleSendのtry節でGemini requestより前に検出される", async () => {
  await resetAll();
  const c = conversation("wiring-b-conv");
  fakeIdbMod.__failNextPutOn("tsumugi", "conversations");
  // handleSendのコード（ChatScreen.tsx）：
  //   try { await putConversationWithOutbox(updated); ...fetch("/api/chat")... }
  //   catch (error) { ...setSendStatus("error")... }
  // putConversationWithOutboxがthrowすれば、同じtry節内の後続処理（fetch呼び出しを
  // 含む）には一切到達しない——これはJavaScriptの制御フローとして保証される
  // （tryブロック内の文は順に実行され、例外は残りの文をスキップしてcatchへ飛ぶ）。
  await assert.rejects(dbMod.putConversationWithOutbox(c), /simulated/);
});

test("Wiring C（req 16-C）: User turn保存成功後にapp close相当で終了しても、次回startupのbootstrapでUser turnがVaultへ復旧する", async () => {
  await resetAll();
  const vault = new FakeVault();
  const c = conversation("wiring-c-conv");
  // handleSendの最初の一歩：User turnをcanonical+outboxへdurable保存する（Gemini
  // requestはまだ開始していない／応答が返る前にapp/tabが終了した、という状況を模す）。
  await dbMod.putConversationWithOutbox(c);

  // 次回起動：runSaveFoundationBootstrap()がidentity確認→migration→reconcileを行う。
  const result = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.ok(result.identity.kind === "newly-paired" || result.identity.kind === "identified");
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(c), "User turnがVaultへ復旧している");
  const entry = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
  assert.equal(entry!.status, "done");
});

test("Wiring D（req 16-D）: Assistant turnまで保存された後にVault write失敗があっても、次回startupのbootstrapでAssistant含めて復旧する", async () => {
  await resetAll();
  const vault = new FakeVault();
  const userOnly = conversation("wiring-d-conv");
  await dbMod.putConversationWithOutbox(userOnly);

  // Geminiが成功し、Assistant turnを追加してcanonical+outboxへ保存する
  // （handleSendの2箇所目のputConversationWithOutbox呼び出しに相当）。
  const withAssistant: Conversation = {
    ...userOnly,
    turns: [...userOnly.turns, { role: "ai", content: "AIの返信", timestamp: "2026-09-01T09:00:05.000Z" }],
    updatedAt: "2026-09-01T09:00:05.000Z",
  };
  await dbMod.putConversationWithOutbox(withAssistant);

  // Vault write（旧経路のpersistConversation、または新Bootstrap）が最初の1回だけ失敗した、
  // という状況を模す。
  const path = `Conversations/${vaultMod.fileNameFor(userOnly.id, userOnly.startedAt)}`;
  vault.writeShouldFail.add(path);
  const first = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.ok((first.reconcile?.pending ?? 0) + (first.finalReconcile?.pending ?? 0) >= 1, "一時的なVault write失敗はpendingのまま（heldにしない）");

  // 次回startup（restart bootstrap）で収束する。
  vault.writeShouldFail.delete(path);
  const second = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  void second;
  assert.equal(vault.get(path), markdownMod.conversationToMarkdown(withAssistant), "Assistant turnを含む最新内容でVaultへ復旧している");
  const entry = await dbMod.getVaultOutboxEntry(`conversation:${userOnly.id}`);
  assert.equal(entry!.status, "done");
});

test("Wiring G（req 16-G）: conflictを検出してもbootstrap自体は例外を投げず、app（呼び出し元）の起動を止めない", async () => {
  await resetAll();
  const vault = new FakeVault();
  const c = conversation("wiring-g-conv");
  // identityを先に確立しておく（identity層のconflict判定とmigration層のconflict判定を
  // 分けて検証するため。Phase 3-7のBootstrap F/Lと同じ考え方）。
  const seedResult = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  void seedResult;
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown({ ...c, turns: [{ role: "user", content: "外部で食い違う内容", timestamp: T }] }));
  await dbMod.putConversation(c);

  // productionBootstrap.tsのwrapper経由で呼んでも、例外を投げずに結果を返す
  // （req 6：bootstrap失敗／conflict検出でアプリ全体を起動不能にしない）。
  const result = await productionBootstrapMod.runProductionBootstrapOnce(vault.root(), () => bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault)));
  assert.ok(result !== null, "conflictがあっても例外にならず、結果が返る");
  assert.equal(await dbMod.getVaultOutboxEntry(`conversation:${c.id}`), undefined, "conflictなrecordはoutbox化されない（migration側で除外）");
  assert.ok(vault.get(path)?.includes("外部で食い違う内容"), "外部データは変更されない");
});

// ===========================================================================
// iPhone再発fixture（req 17、永久回帰テスト）：3セッションにまたがる部分欠落からの復旧
// ===========================================================================

test("Wiring iPhone再発fixture（永久回帰テスト）: 複数セッションにまたがるVault部分欠落からの自己修復（A repair→B投影→C Registry修復）", async () => {
  await resetAll();
  const vault = new FakeVault();

  // ===== セッション1：Conversation A作成 → Vault projectionの一部だけ欠落 → 終了 =====
  const convA = conversation("iphone-repro-a");
  await dbMod.putConversationWithOutbox(convA);
  const session1 = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  assert.ok(session1.identity.kind === "newly-paired" || session1.identity.kind === "identified");
  const pathA = `Conversations/${vaultMod.fileNameFor(convA.id, convA.startedAt)}`;
  assert.equal(vault.get(pathA), markdownMod.conversationToMarkdown(convA));
  // 「Vault projectionの一部だけ欠落」：Registryだけを外部で失う（実機で確認された
  // 破損パターンの再現）。
  const shardPathA = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(convA.id).toString(16).padStart(2, "0")}.json`;
  vault.files.delete(shardPathA);

  // ===== セッション2：startup → bootstrap → A repair =====
  const session2a = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  void session2a;
  const shardA = JSON.parse(vault.get(shardPathA)!);
  assert.equal(shardA.records[convA.id], pathA, "AのRegistryがrepairされる");

  // セッション2の続き：Conversation B のUser turnだけ保存 → Gemini前に終了。
  const convB = conversation("iphone-repro-b", { startedAt: "2026-09-02T09:00:00.000Z", createdAt: "2026-09-02T09:00:00.000Z", updatedAt: "2026-09-02T09:00:00.000Z", turns: [{ role: "user", content: "Bのユーザー発言", timestamp: "2026-09-02T09:00:00.000Z" }] });
  await dbMod.putConversationWithOutbox(convB);
  // ここでGeminiへ到達する前に終了（Vaultには一切書かれていない）。

  // ===== セッション3：startup → bootstrap → B canonical検出 → Vaultへprojection =====
  const session3 = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  void session3;
  const pathB = `Conversations/${vaultMod.fileNameFor(convB.id, convB.startedAt)}`;
  assert.equal(vault.get(pathB), markdownMod.conversationToMarkdown(convB), "BがVaultへprojectionされる");

  // セッション3の続き：Conversation C、Assistant turnまで保存 → Registryだけ欠落 → 終了。
  const convCUser = conversation("iphone-repro-c", { startedAt: "2026-09-03T09:00:00.000Z", createdAt: "2026-09-03T09:00:00.000Z", updatedAt: "2026-09-03T09:00:00.000Z", turns: [{ role: "user", content: "Cのユーザー発言", timestamp: "2026-09-03T09:00:00.000Z" }] });
  await dbMod.putConversationWithOutbox(convCUser);
  const convCWithAssistant: Conversation = { ...convCUser, turns: [...convCUser.turns, { role: "ai", content: "Cへの返信", timestamp: "2026-09-03T09:00:05.000Z" }], updatedAt: "2026-09-03T09:00:05.000Z" };
  await dbMod.putConversationWithOutbox(convCWithAssistant);
  // Cについてはこの時点でVaultへ実際に書かれた（bootstrapがまだ走っていないため、
  // ここでは「旧経路のpersistConversationが書いた」体で直接Vaultへ用意する）。
  const pathC = `Conversations/${vaultMod.fileNameFor(convCUser.id, convCUser.startedAt)}`;
  vault.put(pathC, markdownMod.conversationToMarkdown(convCWithAssistant));
  const shardPathC = `.tsumugi/registry/${vaultMod.vaultRegistryBucketOf(convCUser.id).toString(16).padStart(2, "0")}.json`;
  vault.files.delete(shardPathC); // Registryだけ欠落（実機で確認された破損パターン）

  // ===== セッション4：startup → bootstrap → Registry repair =====
  const session4 = await bootstrapMod.runSaveFoundationBootstrap(makeEnv(vault));
  void session4;

  // ---- 期待結果：A/B/Cすべて残る、baseline不要、Recovery不要、duplicateなし ----
  assert.equal(vault.get(pathA), markdownMod.conversationToMarkdown(convA), "Aが残っている");
  assert.equal(vault.get(pathB), markdownMod.conversationToMarkdown(convB), "Bが残っている");
  assert.equal(vault.get(pathC), markdownMod.conversationToMarkdown(convCWithAssistant), "C（Assistant含む）が残っている");

  const shardCAfter = JSON.parse(vault.get(shardPathC)!);
  assert.equal(shardCAfter.records[convCUser.id], pathC, "CのRegistryがrepairされる");

  assert.equal(vault.get(".tsumugi/registry-meta.json"), undefined, "baseline不要（一度も参照しない）");

  for (const c of [convA, convB, convCWithAssistant]) {
    const entry = await dbMod.getVaultOutboxEntry(`conversation:${c.id}`);
    assert.equal(entry!.status, "done", `${c.id}がdoneになっていない（Recovery誘導が必要な状態が残っている）`);
  }

  const index = JSON.parse(vault.get(".tsumugi/index.json")!);
  assert.equal(Object.keys(index).length, 3, "duplicateなし（A/B/Cの3件のみ）");
});
