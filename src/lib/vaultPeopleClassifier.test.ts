/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-this-alias */
/**
 * People（人物メモ）ファイルの分類の回帰テスト。架空データのみ。
 * 実行：`npm run test:people-classifier`。
 *
 * 背景（2026-11-23の調査で確定した不具合）：Vault全体を走査する2つの検査系
 * （light-check／resyncの分類器と、Recoveryの整合性走査）がPeopleファイルの
 * 型を知らず、現在のwriterが生成する正常なPeopleファイルを「読み込めない
 * ファイル（解析失敗）」／「原因を特定できない記録」として誤判定していた。
 * 後者については、その1件のissueがRecovery計画全体を安全側に停止
 * （globallyBlocked）させていた。
 *
 * 確かめること：
 * - 正常なPeopleファイルは両方の検査系で「有効な管理ファイル」として分類され、
 *   unreadableにもissueにもならず、Registry／Recoveryのrecordにもならない。
 * - 壊れたPeopleファイル（frontmatter不正・必須情報欠落・途中切断・parserが
 *   受け付けない形式・読み取り失敗）は、正常とは判定されず、既存の安全な診断
 *   分類（parse／read）で表面化する。Recovery側では従来通りissue化され、
 *   安全側の停止（globallyBlocked）が本物の破損に対しては維持される。
 * - ファイル種別×検査系のマトリクス：Conversation／Memory／Reflection／
 *   Source／Peopleの正常ファイルを並べても、両検査系とも誤判定しない。
 * - どちらの検査系も読み取り専用のままで、保存先へ一切書き込まない。
 */
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

import type { Conversation, MemoryObject, Source } from "./types";
import type { PersonRecord } from "./personAlias";
import type { RecoveryLocalSnapshot } from "./vaultRecovery";
import type { RecoveryApplyEnv } from "./vaultRecoveryApply";

const vault = require("./vault") as typeof import("./vault");
const recovery = require("./vaultRecovery") as typeof import("./vaultRecovery");
const recoveryApply = require("./vaultRecoveryApply") as typeof import("./vaultRecoveryApply");
const personAlias = require("./personAlias") as typeof import("./personAlias");
const markdown = require("./markdown") as typeof import("./markdown");

const T = "2026-10-20T00:00:00.000Z";
const T2 = "2026-10-21T00:00:00.000Z";

// ---------------------------------------------------------------------------
// 架空のPeopleファイル（現在のwriter＝personToMarkdownが生成する形そのもの）
// ---------------------------------------------------------------------------

const PERSON_ID = "01K8F7Q2W9E4R5T6Y7U8I2HP4Z";
const person: PersonRecord = {
  id: PERSON_ID,
  fileName: personAlias.personFileName("架空の人物", PERSON_ID),
  createdAt: T,
  decisions: [
    { id: "dec-1", at: T, kind: "confirm", name: "架空の人物" },
    { id: "dec-2", at: T2, kind: "confirm", name: "架空さん" },
  ],
};
const HEALTHY_PERSON_MD = personAlias.personToMarkdown(person);
const PERSON_PATH = `People/${person.fileName}`;
const PERSON2_ID = "01K8F7Q2W9E4R5T6Y7U8I2HP4Y";
const person2: PersonRecord = {
  id: PERSON2_ID,
  fileName: personAlias.personFileName("架空の別人", PERSON2_ID),
  createdAt: T,
  decisions: [{ id: "dec-9", at: T, kind: "confirm", name: "架空の別人" }],
};
const HEALTHY_PERSON2_MD = personAlias.personToMarkdown(person2);
const PERSON2_PATH = `People/${person2.fileName}`;

/** frontmatterは閉じているが必須の`id`行が無い（必須情報の欠落）。 */
const MISSING_ID_MD = HEALTHY_PERSON_MD.replace(`id: ${PERSON_ID}\n`, "");
/** frontmatterは閉じているが必須の`createdAt`行が無い（必須情報の欠落）。 */
const MISSING_CREATED_MD = HEALTHY_PERSON_MD.replace(`createdAt: ${T}\n`, "");
/** 確定/解除の記録コメント自体が無い（必須情報の欠落）。 */
const NO_DECISIONS_MD = HEALTHY_PERSON_MD.slice(0, HEALTHY_PERSON_MD.indexOf("\n<!-- tsumugi-person-decisions")) + "\n";
/** 確定/解除の記録コメントが閉じないままファイルが終わる（途中切断）。 */
const TRUNCATED_DECISIONS_MD =
  HEALTHY_PERSON_MD.slice(0, HEALTHY_PERSON_MD.indexOf("<!-- tsumugi-person-decisions")) + '<!-- tsumugi-person-decisions\n[{"id":"dec-1"';
/** frontmatterが閉じないままファイルが終わる（途中切断）。probe（tsumugi: true）は通る。 */
const TRUNCATED_FRONTMATTER_MD = `---\nid: ${PERSON_ID}\ntsumugi: true\ntype: person\ndisplayName: "架空`;
/** 決定のkindがparserの受け付けない値（parserが受け付けない形式）。 */
const BAD_DECISION_KIND_MD = HEALTHY_PERSON_MD.replace('"kind":"confirm"', '"kind":"maybe"');
/** 決定IDが重複している（parserが受け付けない形式）。 */
const DUP_DECISION_MD = personAlias.personToMarkdown({ ...person, decisions: [person.decisions[0], person.decisions[0]] });
/** 決定のJSON自体が読めない（parserが受け付けない形式）。 */
const BAD_DECISIONS_JSON_MD = HEALTHY_PERSON_MD.replace(/\n<!-- tsumugi-person-decisions\n[\s\S]*?\n-->/, "\n<!-- tsumugi-person-decisions\n{broken json\n-->");

// ---------------------------------------------------------------------------
// 架空の他種別record（マトリクス用）
// ---------------------------------------------------------------------------

const meta = { id: "meta", source: "ai-capture", schemaVersion: "1", createdAt: T, updatedAt: T };
const conversation = (id = "c1"): Conversation =>
  ({
    id, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T,
    turns: [{ role: "user", content: "架空の会話です", timestamp: T }], memoryObjectIds: [], metadata: { ...meta },
  }) as Conversation;
const memory = (id = "m1"): MemoryObject =>
  ({
    id, date: T, content: "架空の記録です", summary: "架空の記録です", types: ["event"], conversationId: "c1", keywords: [],
    links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
    createdAt: T, updatedAt: T, metadata: { ...meta },
  }) as MemoryObject;
const reflection = (id = "r1"): MemoryObject => {
  const m = memory(id);
  m.metadata = { ...meta, source: "system-generated" };
  return m;
};
const source = (id = "s1"): Source => ({ id, title: "架空の素材", content: "架空の本文", sourceType: "text", createdAt: T, updatedAt: T }) as Source;
const local = (conversations: Conversation[] = [], memories: MemoryObject[] = [], sources: Source[] = []): RecoveryLocalSnapshot => ({
  conversations, memories, sources, sync: {},
});
const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// light-check用のメモリ上Vault（vaultUnreadableDiagnostics.test.tsと同じ形）
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s);
const textOf = (b: Uint8Array) => dec.decode(b);

class MemVault {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>([""]);
  failText = new Set<string>();
  written: string[] = [];
  constructor(files: Record<string, string> = {}) {
    for (const [p, v] of Object.entries(files)) this.put(p, bytes(v));
  }
  put(p: string, data: Uint8Array) {
    this.files.set(p, data);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }
  snapshot() {
    return new Map([...this.files].map(([k, v]) => [k, Buffer.from(v).toString("hex")] as const));
  }
  notFound(): never {
    throw Object.assign(new Error("not found"), { name: "NotFoundError" });
  }
  dir(prefix = ""): FileSystemDirectoryHandle {
    const self = this;
    const join = (name: string) => (prefix ? `${prefix}/${name}` : name);
    const fileHandle = (p: string) => ({
      kind: "file",
      name: p.split("/").pop(),
      async getFile() {
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
        let buffer = new Uint8Array(0);
        return {
          async write(d: Uint8Array) { buffer = new Uint8Array(d); },
          async close() { self.put(p, buffer); self.written.push(p); },
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
  const filesBefore = clone(v.files), localBefore = clone(s);
  const result = await recovery.buildVaultRecoveryPlan(v.dir(), s);
  assert.deepEqual(v.files, filesBefore);
  assert.deepEqual(s, localBefore);
  assert.equal(v.mutations, 0);
  return result;
}

// ---------------------------------------------------------------------------
// 専用parserの診断（失敗形状の分類）
// ---------------------------------------------------------------------------

test("diagnose: a healthy writer-generated People file is accepted, and parsePersonMarkdown still returns the record", () => {
  const d = personAlias.diagnosePersonMarkdown(HEALTHY_PERSON_MD, person.fileName);
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.person.id, PERSON_ID);
    assert.equal(d.person.decisions.length, 2);
  }
  const parsed = personAlias.parsePersonMarkdown(HEALTHY_PERSON_MD, person.fileName);
  assert.equal(parsed?.id, PERSON_ID);
  assert.equal(parsed?.decisions.length, 2);
  // CRLF化されても従来通り読める（parserの既存の許容を変えていない）。
  assert.equal(personAlias.diagnosePersonMarkdown(HEALTHY_PERSON_MD.replace(/\n/g, "\r\n"), person.fileName).ok, true);
});

test("diagnose: failure shapes are distinguished (frontmatter / missing-required / truncated / invalid-decisions)", () => {
  const failureOf = (text: string) => {
    const d = personAlias.diagnosePersonMarkdown(text, person.fileName);
    return d.ok ? "ok" : d.failure;
  };
  assert.equal(failureOf("# ただのメモ\n"), "invalid-frontmatter");
  assert.equal(failureOf(HEALTHY_PERSON_MD.replace("type: person", "type: other")), "invalid-frontmatter");
  assert.equal(failureOf(HEALTHY_PERSON_MD.replace("tsumugi: true", "tsumugi: false")), "invalid-frontmatter");
  assert.equal(failureOf(MISSING_ID_MD), "missing-required");
  assert.equal(failureOf(MISSING_CREATED_MD), "missing-required");
  assert.equal(failureOf(NO_DECISIONS_MD), "missing-required");
  assert.equal(failureOf(TRUNCATED_FRONTMATTER_MD), "truncated");
  assert.equal(failureOf(TRUNCATED_DECISIONS_MD), "truncated");
  assert.equal(failureOf(BAD_DECISION_KIND_MD), "invalid-decisions");
  assert.equal(failureOf(DUP_DECISION_MD), "invalid-decisions");
  assert.equal(failureOf(BAD_DECISIONS_JSON_MD), "invalid-decisions");
  // どの壊れた形も、従来のparsePersonMarkdownではnullのまま（保存経路の安全側挙動は不変）。
  for (const broken of [MISSING_ID_MD, MISSING_CREATED_MD, NO_DECISIONS_MD, TRUNCATED_FRONTMATTER_MD, TRUNCATED_DECISIONS_MD, BAD_DECISION_KIND_MD, DUP_DECISION_MD, BAD_DECISIONS_JSON_MD]) {
    assert.equal(personAlias.parsePersonMarkdown(broken, person.fileName), null);
  }
});

test("classifier helper: vaultPersonFileFailureOf only speaks for declared People files, and the reason maps to kind parse", () => {
  assert.equal(vault.vaultPersonFileFailureOf(HEALTHY_PERSON_MD), null);
  assert.equal(vault.vaultPersonFileFailureOf(MISSING_ID_MD), "missing-required");
  assert.equal(vault.vaultPersonFileFailureOf(NO_DECISIONS_MD), "missing-required");
  assert.equal(vault.vaultPersonFileFailureOf(TRUNCATED_DECISIONS_MD), "truncated");
  assert.equal(vault.vaultPersonFileFailureOf(BAD_DECISION_KIND_MD), "invalid-decisions");
  // People宣言でないファイルについては何も言わない（他種別の分類は従来通り）。
  assert.equal(vault.vaultPersonFileFailureOf(markdown.conversationToMarkdown(conversation())), null);
  assert.equal(vault.vaultPersonFileFailureOf("# ただのメモ\n"), null);
  for (const shape of ["invalid-frontmatter", "missing-required", "truncated", "invalid-decisions"] as const) {
    assert.equal(vault.vaultUnreadableFileKindOf(`tsumugi person file could not be parsed: ${shape}`), "parse");
  }
});

// ---------------------------------------------------------------------------
// light-check／resync分類器：正常なPeopleファイルは有効な管理ファイル
// ---------------------------------------------------------------------------

test("light-check: a healthy People file is valid — not unreadable, not a Registry record (the reported reproduction case)", async () => {
  const v = new MemVault({ [PERSON_PATH]: HEALTHY_PERSON_MD });
  const before = v.snapshot();
  const result = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 0);
  assert.deepEqual(result.unreadableDiagnostics, []);
  assert.equal(result.records.length, 0);
  assert.equal(result.counts.added, 0);
  assert.deepEqual(v.snapshot(), before);
  assert.deepEqual(v.written, []);
});

test("light-check: two healthy People files are both valid", async () => {
  const v = new MemVault({ [PERSON_PATH]: HEALTHY_PERSON_MD, [PERSON2_PATH]: HEALTHY_PERSON2_MD });
  const result = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 0);
  assert.deepEqual(result.unreadableDiagnostics, []);
  assert.equal(result.records.length, 0);
});

test("light-check: broken People files surface as parse diagnostics — never passed as healthy, never silently dropped", async () => {
  const cases: [string, string][] = [
    ["missing id", MISSING_ID_MD],
    ["missing createdAt", MISSING_CREATED_MD],
    ["missing decisions comment", NO_DECISIONS_MD],
    ["truncated decisions comment", TRUNCATED_DECISIONS_MD],
    ["truncated frontmatter", TRUNCATED_FRONTMATTER_MD],
    ["parser-rejected decision kind", BAD_DECISION_KIND_MD],
    ["duplicate decision ids", DUP_DECISION_MD],
    ["unreadable decisions JSON", BAD_DECISIONS_JSON_MD],
  ];
  for (const [label, text] of cases) {
    const v = new MemVault({ [PERSON_PATH]: text });
    const result = await runLightCheck(v);
    assert.equal(result.counts.unreadable, 1, label);
    assert.deepEqual(result.unreadableDiagnostics, [{ path: PERSON_PATH, kind: "parse" }], label);
    assert.equal(result.records.length, 0, label);
  }
});

test("light-check: a People file that cannot be read at all is a read diagnostic, distinct from parse", async () => {
  const v = new MemVault({ [PERSON_PATH]: HEALTHY_PERSON_MD });
  v.failText.add(PERSON_PATH);
  const result = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 1);
  assert.deepEqual(result.unreadableDiagnostics, [{ path: PERSON_PATH, kind: "read" }]);
});

test("light-check: a healthy People file does not mask or join a genuinely broken file's diagnostic", async () => {
  const broken = `---\nid: mem-broken-1\ntsumugi: true\n---\n# 見出しマーカーの無い本文\n`;
  const v = new MemVault({ [PERSON_PATH]: HEALTHY_PERSON_MD, "Notes/broken.md": broken });
  const result = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 1);
  assert.deepEqual(result.unreadableDiagnostics, [{ path: "Notes/broken.md", kind: "parse" }]);
});

// ---------------------------------------------------------------------------
// Recovery走査：正常なPeopleファイルはrecordにもissueにもならない
// ---------------------------------------------------------------------------

test("recovery: a healthy People file produces no record and no issue (the reported reproduction case)", async () => {
  const p = await plan(new ReadOnlyVault({ [PERSON_PATH]: HEALTHY_PERSON_MD }), local());
  assert.equal(p.scanCompleted, true);
  assert.equal(p.scannedMarkdownCount, 1);
  assert.deepEqual(p.issues, []);
  assert.deepEqual(p.records, []);
});

test("recovery: two healthy People files produce no records and no issues", async () => {
  const p = await plan(new ReadOnlyVault({ [PERSON_PATH]: HEALTHY_PERSON_MD, [PERSON2_PATH]: HEALTHY_PERSON2_MD }), local());
  assert.deepEqual(p.issues, []);
  assert.deepEqual(p.records, []);
});

test("recovery: a healthy People file does not disturb other records' classifications", async () => {
  const c = conversation();
  const p = await plan(new ReadOnlyVault({ [PERSON_PATH]: HEALTHY_PERSON_MD, "Conversations/c.md": markdown.conversationToMarkdown(c) }), local([c]));
  assert.deepEqual(p.issues, []);
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].recordType, "conversation");
  assert.equal(p.records[0].classification, "equivalent-existing");
});

test("recovery: broken People files are issues (safety-first handling is unchanged) and never become records", async () => {
  const cases: [string, string][] = [
    ["missing id", MISSING_ID_MD],
    ["missing createdAt", MISSING_CREATED_MD],
    ["missing decisions comment", NO_DECISIONS_MD],
    ["truncated decisions comment", TRUNCATED_DECISIONS_MD],
    ["parser-rejected decision kind", BAD_DECISION_KIND_MD],
    ["duplicate decision ids", DUP_DECISION_MD],
    ["unreadable decisions JSON", BAD_DECISIONS_JSON_MD],
  ];
  for (const [label, text] of cases) {
    const p = await plan(new ReadOnlyVault({ [PERSON_PATH]: text }), local());
    assert.equal(p.issues.length, 1, label);
    assert.equal(p.issues[0].path, PERSON_PATH, label);
    assert.equal(p.issues[0].status, "invalid", label);
    assert.equal(p.issues[0].error, "markdown-parse-or-shape-failure", label);
    assert.deepEqual(p.records, [], label);
  }
});

test("recovery: a People file that cannot be read is a read-error issue, distinct from a parse failure", async () => {
  const v = new ReadOnlyVault({ [PERSON_PATH]: HEALTHY_PERSON_MD });
  v.failures.set(`${PERSON_PATH}:text`, "NotReadableError");
  const p = await plan(v, local());
  assert.equal(p.issues.length, 1);
  assert.equal(p.issues[0].path, PERSON_PATH);
  assert.equal(p.issues[0].status, "read-error");
  assert.deepEqual(p.records, []);
});

test("recovery: a healthy People file does not add an issue next to a genuinely broken file", async () => {
  const broken = `---\ntsumugi: true\n---\n本文だけの壊れたファイル\n`;
  const p = await plan(new ReadOnlyVault({ [PERSON_PATH]: HEALTHY_PERSON_MD, "Notes/broken.md": broken }), local());
  assert.equal(p.issues.length, 1);
  assert.equal(p.issues[0].path, "Notes/broken.md");
  assert.deepEqual(p.records, []);
});

// ---------------------------------------------------------------------------
// globallyBlocked回帰：正常なPeopleファイルはRecovery計画を止めない。
// 本物の破損がある場合は、安全側の停止がそのまま維持される。
// ---------------------------------------------------------------------------

function applyEnv(root: FileSystemDirectoryHandle, snapshot: RecoveryLocalSnapshot): RecoveryApplyEnv {
  let opSeq = 0;
  return {
    root,
    readLocalSnapshot: async () => snapshot,
    readRecord: async () => undefined,
    store: { read: async () => undefined, write: async () => { /* planning never writes the journal */ } },
    readLedger: async () => undefined,
    writeLedger: async () => { /* planning never writes the ledger */ },
    readWorld: async () => ({ activeVaultEpoch: 0, committedVaultEpoch: 0, registryGenerationEpoch: 0, journalVersion: "current", backend: "opfs" }),
    runWrite: async (task) => task(),
    now: () => T,
    newId: () => `op-fictional-${++opSeq}`,
  };
}

test("globallyBlocked regression: healthy People present — a local-only record is still planned for recovery", async () => {
  const c = conversation();
  const v = new ReadOnlyVault({ [PERSON_PATH]: HEALTHY_PERSON_MD });
  const planned = await recoveryApply.planRecoveryApply(applyEnv(v.dir(), local([c])));
  assert.deepEqual(planned.plan.issues, []);
  assert.equal(planned.ops.length, 1);
  assert.equal(planned.ops[0].recordType, "conversation");
  assert.ok(!planned.held.some((h) => h.reason === "scan-incomplete"));
  assert.equal(v.mutations, 0);
});

test("globallyBlocked regression: genuinely corrupt People present — the plan stays blocked (safety preserved)", async () => {
  const c = conversation();
  const v = new ReadOnlyVault({ [PERSON_PATH]: BAD_DECISION_KIND_MD });
  const planned = await recoveryApply.planRecoveryApply(applyEnv(v.dir(), local([c])));
  assert.equal(planned.plan.issues.length, 1);
  assert.equal(planned.plan.issues[0].path, PERSON_PATH);
  assert.equal(planned.ops.length, 0);
  // 破損が1件でもあると「不在を証明できない」ため、その記録はindeterminateとして
  // 保留される（globallyBlockedの判定に届く前に安全側で止まる二重の効き方）。
  // どちらの層でも、復旧opは一切計画されないことが安全条件である。
  assert.ok(planned.held.some((h) => h.recordId === c.id && h.reason === "unreadable-or-indeterminate"));
  assert.equal(v.mutations, 0);
});

// ---------------------------------------------------------------------------
// ファイル種別×検査系マトリクス：全種別の正常ファイルを並べても誤判定しない
// ---------------------------------------------------------------------------

test("matrix: one healthy file of every managed type passes both scanners; People appears as a record in neither", async () => {
  const c = conversation(), m = memory(), r = reflection(), s = source();
  const files: Record<string, string> = {
    "Conversations/c.md": markdown.conversationToMarkdown(c),
    "Memories/2026-10-20.md": markdown.serializeMemoryDayFile([m]),
    "Memories/reflection.md": markdown.memoryObjectToMarkdown(r),
    "Sources/s.md": markdown.sourceToMarkdown(s),
    [PERSON_PATH]: HEALTHY_PERSON_MD,
  };
  const snapshot = local([c], [m, r], [s]);

  // light-checkのL3はrecordのRegistry状態を確認してから分類する。Registry
  // ディレクトリ自体が無い保存先では「確認不能」（安全側）に倒れるのが既存の
  // 仕様のため、ここでは実アプリの保存先と同様に、対象bucketの空shardを用意し
  // 「Registryに存在しない」ことが確認できる状態にする。
  const lightFiles: Record<string, string> = { ...files };
  for (const key of [c.id, vault.dayFileRegistryKey("2026-10-20"), r.id, s.id]) {
    const bucket = vault.vaultRegistryBucketOf(key);
    lightFiles[`.tsumugi/registry/${bucket.toString(16).padStart(2, "0")}.json`] = JSON.stringify({ schemaVersion: 1, bucket, records: {}, files: {} });
  }
  const lv = new MemVault(lightFiles);
  const light = await runLightCheck(lv);
  assert.equal(light.counts.unreadable, 0);
  assert.deepEqual(light.unreadableDiagnostics, []);
  assert.deepEqual(
    light.records.map((x) => x.registryKey).sort(),
    [c.id, vault.dayFileRegistryKey("2026-10-20"), r.id, s.id].sort(),
  );
  assert.ok(!light.records.some((x) => x.registryKey === PERSON_ID));

  const p = await plan(new ReadOnlyVault(files), snapshot);
  assert.equal(p.scanCompleted, true);
  assert.deepEqual(p.issues, []);
  assert.deepEqual(p.records.map((x) => x.recordType).sort(), ["conversation", "memory", "reflection", "source"]);
  assert.ok(p.records.every((x) => x.classification === "equivalent-existing"));
  assert.ok(!p.records.some((x) => x.recordId === PERSON_ID));
});
