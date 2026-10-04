/**
 * Vault Identity + Legacy Vault Adoption（Phase 3-4）の回帰テスト。
 *
 * 実IndexedDBは使わない（`fakeIdb.ts`をModule._loadで`require("idb")`へ差し替える）。
 * 実Vaultも使わず、in-memoryの疑似FileSystemDirectoryHandle（`FakeVault`）を使う
 * （`vaultProjection.test.ts`と同じ考え方の、この機能専用の実装）。
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
const adoptionMod = require(path.join(OUT, "lib/vaultIdentityAdoption.js")) as typeof import("./vaultIdentityAdoption");

type Conversation = import("./types").Conversation;

// ---------------------------------------------------------------------------
// in-memory疑似ファイルシステム（vaultProjection.test.tsと同じ実装）
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
    } as unknown as FileSystemDirectoryHandle;
  }

  private file(p: string): FileSystemFileHandle {
    const self = this;
    return {
      kind: "file",
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

const T = "2026-04-01T09:00:00.000Z";
const meta = { id: "meta", source: "ai-capture" as const, schemaVersion: "0.1", createdAt: T, updatedAt: T };
function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id, persona: "companion", status: "active", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: [{ role: "user", content: "ユーザー発言", timestamp: T }], memoryObjectIds: [],
    metadata: { ...meta }, ...overrides,
  } as Conversation;
}

let vaultIdSeq = 0;
function makeEnv(vault: FakeVault, overrides: Partial<import("./vaultIdentityAdoption").VaultIdentityEnv> = {}): import("./vaultIdentityAdoption").VaultIdentityEnv {
  return {
    root: vault.root(),
    now: () => T,
    generateVaultId: () => `generated-vault-id-${++vaultIdSeq}`,
    ...overrides,
  };
}

// db.ts経由でconversationsストアだけへ直接put（このテストではProjection/outboxは無関係）。
async function seedIdbConversation(c: Conversation) {
  await dbMod.putConversation(c);
}

/**
 * IndexedDB接続（db.tsの`getDB()`）はテストファイル全体で1つに共有されるため
 * （実アプリと同じキャッシュ挙動）、`vaultIdentity`レコードは前のテストの結果を
 * 引き継いでしまう。「未pairから始まる」ことを前提にするテストは、必ず冒頭でこれを呼ぶ。
 */
async function resetIdbIdentity() {
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null, pendingCandidateVaultId: null, updatedAt: T });
}

// ===========================================================================
// A: 空のVault → 新規identity → pair → done
// ===========================================================================

test("Identity A: 完全に空のVaultは、新しいvaultIdを生成してpairされる", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "newly-paired");
  const onDisk = JSON.parse(vault.get(".tsumugi/vault-identity.json")!);
  assert.equal(onDisk.vaultId, result.kind === "newly-paired" ? result.vaultId : undefined);
  const idbRecord = await dbMod.getVaultIdentityRecord();
  assert.equal(idbRecord!.vaultId, onDisk.vaultId);
  assert.equal(idbRecord!.pendingCandidateVaultId, null);
});

// ===========================================================================
// B/C/D/E: Legacy Vault adoption（今回のiPhone事故fixtureを含む）
// ===========================================================================

test("Identity B: Legacy Vault、共通Conversationが内容一致 → safe adoption", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const c = conversation("id-b-1");
  await seedIdbConversation(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "newly-paired");
});

test("Identity C（今回のiPhone事故fixtureとの接続）: Markdown/Historyあり・Registryなし・baselineなし・共通Conversation一致 → safe adoption", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const c = conversation("id-c-1");
  await seedIdbConversation(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  const day = c.startedAt.slice(0, 10);
  vault.put(path, markdownMod.conversationToMarkdown(c));
  vault.put(`.tsumugi/history/${day.slice(0, 7)}.json`, JSON.stringify({ version: 2, month: day.slice(0, 7), days: { [day]: { conversations: [{ id: c.id, mode: "diary", turnCount: 1 }], normalMemories: [], reflections: [] } } }));
  // Registryは一切seedしない。registry-meta.json（baseline情報）も一切seedしない。
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "newly-paired", "Registry欠落・baseline欠落だけでadoptionを禁止しない");
});

test("Identity D: IndexedDBに新しいrecordが増えている（Vaultにはまだ無い）が、既存共通recordは一致 → safe adoption、新recordはそのまま", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const existing = conversation("id-d-1");
  const brandNew = conversation("id-d-2");
  await seedIdbConversation(existing);
  await seedIdbConversation(brandNew);
  const existingPath = `Conversations/${vaultMod.fileNameFor(existing.id, existing.startedAt)}`;
  vault.put(existingPath, markdownMod.conversationToMarkdown(existing));
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "newly-paired");
  const newPath = `Conversations/${vaultMod.fileNameFor(brandNew.id, brandNew.startedAt)}`;
  assert.equal(vault.get(newPath), undefined, "adoption自体はrecordのprojectionを行わない（新recordはVaultへ書かれない）");
});

test("Identity E: Vault-onlyの記録（IndexedDBに無い）があっても、adoption後もそのまま保全される", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const common = conversation("id-e-1");
  await seedIdbConversation(common);
  const commonPath = `Conversations/${vaultMod.fileNameFor(common.id, common.startedAt)}`;
  vault.put(commonPath, markdownMod.conversationToMarkdown(common));
  const vaultOnlyPath = "Conversations/vault-only-2020-01-01-xyz.md";
  const vaultOnlyContent = "---\nid: vault-only-1\ntsumugi: true\n---\n# Vault only\n";
  vault.put(vaultOnlyPath, vaultOnlyContent);
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "newly-paired");
  assert.equal(vault.get(vaultOnlyPath), vaultOnlyContent, "Vault-only recordは変更されない");
});

// ===========================================================================
// F/G/H: conflict・unrelated・unreadable
// ===========================================================================

test("Identity F: 共通IDの内容が食い違う → adoption禁止（held）", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const c = conversation("id-f-1");
  await seedIdbConversation(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  const differentContent = markdownMod.conversationToMarkdown({ ...c, turns: [{ role: "user", content: "全く別の内容", timestamp: T }] });
  vault.put(path, differentContent);
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault, { storageCapability: "user-selectable" }));
  assert.equal(result.kind, "held");
  assert.equal(vault.get(".tsumugi/vault-identity.json"), undefined, "conflict時はidentityも書かない");
});

test("Identity F-FSA: user-selectable＋共通IDの内容が食い違う → held（従来どおり。previewも書かない）", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const c = conversation("id-f-fsa-1");
  await seedIdbConversation(c);
  vault.put(`Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`, markdownMod.conversationToMarkdown({ ...c, turns: [{ role: "user", content: "別", timestamp: T }] }));
  const env = makeEnv(vault, { storageCapability: "user-selectable" });
  const preview = await adoptionMod.previewVaultIdentityAdoption(env);
  assert.equal(preview.commonRecordIds, 1);
  assert.equal(preview.divergentRecords, 1);
  assert.match(preview.adoption, /^held/);
  assert.equal(vault.get(".tsumugi/vault-identity.json"), undefined, "previewはidentityを作らない");
  assert.equal((await adoptionMod.ensureVaultIdentityForCurrentWorld(env)).kind, "held");
});

test("Identity F-OPFS: origin-bound＋共通IDあり＋内容が食い違う → identity確立（内容差はRecoveryの問題）", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const c = conversation("id-f-opfs-1");
  await seedIdbConversation(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  const differing = markdownMod.conversationToMarkdown({ ...c, turns: [{ role: "user", content: "別", timestamp: T }] });
  vault.put(path, differing);
  const env = makeEnv(vault, { storageCapability: "origin-bound" });
  const preview = await adoptionMod.previewVaultIdentityAdoption(env);
  assert.equal(preview.adoption, "would-establish:origin-bound-shared-ids");
  assert.equal(vault.get(".tsumugi/vault-identity.json"), undefined, "previewはidentityを作らない");
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(env);
  assert.equal(result.kind, "newly-paired");
  assert.equal(vault.get(path), differing, "食い違ったVault側recordは変更されない");
});

test("Identity G-OPFS: origin-bound＋共通IDが無い → unrelated（HOLD。identityを作らない）", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  await seedIdbConversation(conversation("id-g-opfs-idb"));
  vault.put("Conversations/vault-side-only.md", "---\nid: vault-side-only-id\ntsumugi: true\n---\n# 別の会話\n");
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault, { storageCapability: "origin-bound" }));
  assert.equal(result.kind, "unrelated");
  assert.equal(vault.get(".tsumugi/vault-identity.json"), undefined);
});

test("Identity G: 両側にデータがあるが共通IDが一件も無い → unrelated（adoption禁止）", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const c = conversation("id-g-idb-only");
  await seedIdbConversation(c);
  const unrelatedPath = "Conversations/vault-side-only.md";
  vault.put(unrelatedPath, "---\nid: vault-side-only-id\ntsumugi: true\n---\n# 別の会話\n");
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "unrelated");
  assert.equal(vault.get(".tsumugi/vault-identity.json"), undefined);
});

test("Identity H: unreadableなMarkdown（parse不能）しか共通候補が無い → adoption禁止（held/unreadable）", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const c = conversation("id-h-1");
  await seedIdbConversation(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.put(path, "not a tsumugi markdown at all, no frontmatter");
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "unreadable");
  assert.equal(vault.get(".tsumugi/vault-identity.json"), undefined);
});

// ===========================================================================
// I/J: adoption自体の中断・再開
// ===========================================================================

test("Identity I: Vault identity write直後にkillしても、restartで同じcandidate vaultIdのままresumeしてdoneになる", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  vault.writeShouldFail.add(".tsumugi/vault-identity.json");
  const env = makeEnv(vault);
  await assert.rejects(adoptionMod.ensureVaultIdentityForCurrentWorld(env));
  const afterFailure = await dbMod.getVaultIdentityRecord();
  assert.ok(afterFailure!.pendingCandidateVaultId, "candidateはVault write失敗の前に、既にdurable保存されている");
  const candidate = afterFailure!.pendingCandidateVaultId;
  vault.writeShouldFail.delete(".tsumugi/vault-identity.json");
  const second = await adoptionMod.ensureVaultIdentityForCurrentWorld(env);
  assert.equal(second.kind, "newly-paired");
  assert.equal(second.kind === "newly-paired" ? second.vaultId : null, candidate, "新しいIDを発行し直さず、同じcandidateを使い続ける");
});

test("Identity J: IndexedDB側の最終pair記録直後にkillしても、restartでverifyして安全にdoneになる", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const env = makeEnv(vault);
  // Step1（candidateのdurable保存）・Step2（Vault file書き込み）までは成功したが、
  // Step3（IndexedDB側の最終pair）だけが完了しなかった、という状況を直接組み立てる
  // （Vault fileが既にあり、IndexedDBはまだpendingCandidateのまま）。
  const candidate = "candidate-vault-id-for-j";
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: candidate, createdAt: T }));
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: null, activeVaultEpoch: null, registryGeneration: null, pairedAt: null, pendingCandidateVaultId: candidate, updatedAt: T });
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(env);
  assert.equal(result.kind, "newly-paired");
  assert.equal(result.kind === "newly-paired" ? result.vaultId : null, candidate, "新しいcandidateを発行し直さず、Vault側に既にある値で確定する");
  const idbRecord = await dbMod.getVaultIdentityRecord();
  assert.equal(idbRecord!.vaultId, candidate);
  assert.equal(idbRecord!.pendingCandidateVaultId, null);
});

// ===========================================================================
// K/L/M/N: partial identity
// ===========================================================================

test("Identity K: Vault identityあり・IndexedDB未pair → 安全にresume（追いつく）", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "existing-vault-id", createdAt: T }));
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "newly-paired");
  assert.equal(result.kind === "newly-paired" ? result.vaultId : null, "existing-vault-id");
});

test("Identity L: IndexedDB側にidentityあり（確定済み）・Vault側に無い → evidence-basedで安全に再確立できる", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const env = makeEnv(vault);
  // 事前に一度正常にadoptionが完了していた状態を作る。
  const first = await adoptionMod.ensureVaultIdentityForCurrentWorld(env);
  assert.equal(first.kind, "newly-paired");
  const originalVaultId = first.kind === "newly-paired" ? first.vaultId : null;
  // Vault側のidentity fileだけが失われた、という状況を模する（IndexedDB側は確定済みのまま）。
  vault.files.delete(".tsumugi/vault-identity.json");
  const c = conversation("id-l-1");
  await seedIdbConversation(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown(c));
  const second = await adoptionMod.ensureVaultIdentityForCurrentWorld(env);
  assert.equal(second.kind, "newly-paired");
  assert.equal(second.kind === "newly-paired" ? second.vaultId : null, originalVaultId, "証拠から安全と確認できた場合は、既知のvaultIdをそのまま再利用する");
});

test("Identity M: 両identityが不一致 → held、writeしない", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const env = makeEnv(vault);
  await dbMod.putVaultIdentityRecord({ id: "current", vaultId: "idb-side-id", activeVaultEpoch: null, registryGeneration: null, pairedAt: T, pendingCandidateVaultId: null, updatedAt: T });
  vault.put(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "vault-side-id", createdAt: T }));
  const writesBefore = vault.writeCount;
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(env);
  assert.equal(result.kind, "held");
  assert.equal(result.kind === "held" ? result.reason : "", "identity-mismatch");
  assert.equal(vault.writeCount, writesBefore);
});

test("Identity N: identity JSON unreadable → held、writeしない", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  vault.put(".tsumugi/vault-identity.json", "not valid json {{{");
  const writesBefore = vault.writeCount;
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "unreadable");
  assert.equal(vault.writeCount, writesBefore);
});

// ===========================================================================
// O: 完了後の再実行
// ===========================================================================

test("Identity O: adoption完了後にもう一度実行すると、完全no-op（identified、writeなし）", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const env = makeEnv(vault);
  const first = await adoptionMod.ensureVaultIdentityForCurrentWorld(env);
  assert.equal(first.kind, "newly-paired");
  const writesBefore = vault.writeCount;
  const second = await adoptionMod.ensureVaultIdentityForCurrentWorld(env);
  assert.equal(second.kind, "identified");
  assert.equal(second.kind === "identified" ? second.vaultId : null, first.kind === "newly-paired" ? first.vaultId : null);
  assert.equal(vault.writeCount, writesBefore, "何も書き込まれない");
});

// ===========================================================================
// baseline非依存性（req 11）の直接確認
// ===========================================================================

test("Identity: registry-meta.json（baselineEstablishedAt）が一切無くてもadoptionできる", async () => {
  const vault = new FakeVault();
  await resetIdbIdentity();
  const c = conversation("id-baseline-1");
  await seedIdbConversation(c);
  const path = `Conversations/${vaultMod.fileNameFor(c.id, c.startedAt)}`;
  vault.put(path, markdownMod.conversationToMarkdown(c));
  assert.equal(vault.get(".tsumugi/registry-meta.json"), undefined, "前提：baseline情報自体が存在しない");
  const result = await adoptionMod.ensureVaultIdentityForCurrentWorld(makeEnv(vault));
  assert.equal(result.kind, "newly-paired");
});
