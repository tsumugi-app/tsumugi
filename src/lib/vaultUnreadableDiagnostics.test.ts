/**
 * 「読み込めないファイル」の診断表示（設定「保存先」の確認結果）の検証。架空データのみ。
 * 実行：`npm run test:vault-unreadable-diagnostics`。
 *
 * 確かめること：
 * - light-checkの分類結果に、件数（counts.unreadable）と同じ出所の診断一覧
 *   （Vault相対path＋安全な分類）が付き、件数と一覧の長さが一致する（1件・複数件・0件）。
 * - 内部の理由文に混ざり得る例外文字列・ファイル内容・APIキーらしい文字列・
 *   絶対pathが、診断・表示行・コンソールログのどこにも出ない。
 * - 診断が取得できない場合は、空欄ではなく「取得できませんでした」と明示される。
 * - 分類は読み取り専用のままで、保存先へ一切書き込まない（修復・再同期はしない）。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
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

const vault = require("./vault") as typeof import("./vault");
const vaultStatus = require("./vaultStatus") as typeof import("./vaultStatus");

// 漏れてはいけない架空のマーカー（ファイル内容・会話本文・APIキー・絶対path）。
const LEAK_CONTENT = "LEAKMARK-架空の会話本文-7f3a";
const LEAK_KEY = "sk-fictional-APIKEY-LEAKMARK-0123456789";
const LEAK_ABS_PATH = "/data/user/0/com.example.app/LEAKMARK-secret-place";

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s);
const textOf = (b: Uint8Array) => dec.decode(b);

/** メモリ上の架空の保存先（FileSystemDirectoryHandleの必要な部分だけ）。書き込みはすべて記録する。 */
class MemVault {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>([""]);
  /** getFile()は成功するがtext()が例外になるファイル（本文の読み取り失敗）。 */
  failText = new Set<string>();
  /** 先頭の読み取り（probe）だけが例外になるファイル。 */
  failProbe = new Set<string>();
  written: string[] = [];
  constructor(files: Record<string, string | Uint8Array> = {}) {
    for (const [p, v] of Object.entries(files)) this.put(p, typeof v === "string" ? bytes(v) : v);
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
        const failProbe = self.failProbe.has(p);
        return {
          size: data.byteLength,
          lastModified: 0,
          slice(start = 0, end = data.byteLength) {
            const part = data.slice(start, end);
            return {
              size: part.byteLength,
              async text() {
                if (failProbe) throw new Error(`probe read error at ${LEAK_ABS_PATH} key=${LEAK_KEY}`);
                return textOf(part);
              },
            };
          },
          async text() {
            if (failText) throw new Error(`read error at ${LEAK_ABS_PATH} key=${LEAK_KEY} body=${LEAK_CONTENT}`);
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
          async write(d: Uint8Array) {
            buffer = new Uint8Array(d);
          },
          async close() {
            self.put(p, buffer);
            self.written.push(p);
          },
          async abort() {
            /* nothing written */
          },
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

async function capturingConsole<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const chunks: string[] = [];
  const push = (...args: unknown[]) => {
    chunks.push(args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(" "));
  };
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    return { value: await fn(), logs: chunks.join("\n") };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

async function runLightCheck(v: MemVault) {
  const root = v.dir();
  const { value, logs } = await capturingConsole(async () => {
    const discovery = await vault.performVaultLightCheckDiscovery(root);
    const result = await vault.classifyVaultLightCheckCandidates(root, discovery);
    return { discovery, result };
  });
  return { ...value, logs };
}

function assertNoLeak(haystack: string, where: string) {
  assert.ok(!haystack.includes("LEAKMARK"), `${where} must not contain leaked internals: ${haystack.slice(0, 300)}`);
  assert.ok(!haystack.includes(LEAK_ABS_PATH), `${where} must not contain an absolute path`);
}

/** probeは通る（tsumugi: trueあり）が、本文に見出しマーカーが無く解析できないファイル。本文に漏洩マーカーを含む。 */
const PARSE_FAIL_MD = `---\nid: mem-leak-1\ntsumugi: true\n---\n# 壊れた記録\n\n${LEAK_CONTENT}\n${LEAK_KEY}\n`;
/** probe・本文読み取りはできるが解析できない、通常の壊れたファイル。 */
const PARSE_FAIL_MD_2 = `---\nid: mem-broken-2\ntsumugi: true\n---\n# 見出しマーカーの無い本文\n`;
/** 正常な素材ファイル（解析できる）。Registry確認不能の再現に使う。 */
const VALID_SOURCE_MD = `---\nid: src-fictional-1\ntsumugi: true\nsourceType: note\ntitle: 架空の素材\ncreatedAt: 2026-10-20T00:00:00.000Z\nupdatedAt: 2026-10-20T00:00:00.000Z\n---\n# 架空の素材\n\n## Content\n架空の内容です。\n`;
/** Tsumugiの目印が無い、無関係なノート（数えられない）。 */
const PLAIN_NOTE_MD = `# ただのノート\n\nTsumugiとは無関係な内容。\n`;

// ---------------------------------------------------------------------------
// 安全な分類への写像（純粋関数）
// ---------------------------------------------------------------------------

test("kind mapping: only the module's own fixed reason forms are recognised; everything else fails closed to unknown", () => {
  assert.equal(vault.vaultUnreadableFileKindOf("tsumugi:true is present but content could not be classified/parsed"), "parse");
  assert.equal(
    vault.vaultUnreadableFileKindOf("light check: registry state for this record's actual content identity could not be confirmed"),
    "registry-unconfirmed"
  );
  assert.equal(vault.vaultUnreadableFileKindOf(`probe failed: Error: ${LEAK_ABS_PATH}`), "read");
  assert.equal(vault.vaultUnreadableFileKindOf(`read failed: Error: ${LEAK_KEY}`), "read");
  assert.equal(vault.vaultUnreadableFileKindOf("light check re-read failed: Error: x"), "read");
  assert.equal(vault.vaultUnreadableFileKindOf("light check candidate read failed: Error: x"), "read");
  // light-checkでは生成されない形式・未知の形式は安全側（unknown）。
  assert.equal(vault.vaultUnreadableFileKindOf("getFile failed: Error: x"), "unknown");
  assert.equal(vault.vaultUnreadableFileKindOf("processing failed: Error: x"), "unknown");
  assert.equal(vault.vaultUnreadableFileKindOf(""), "unknown");
  assert.equal(vault.vaultUnreadableFileKindOf(LEAK_CONTENT), "unknown");
});

test("diagnostics conversion: safe relative paths only; raw reason text never crosses the boundary", () => {
  const diagnostics = vault.toVaultUnreadableDiagnostics([
    { path: "Memories/2026/10/2026-10-20.md", reason: `read failed: Error: ${LEAK_ABS_PATH} ${LEAK_KEY} ${LEAK_CONTENT}` },
    { path: "Notes/broken.md", reason: "tsumugi:true is present but content could not be classified/parsed" },
    { path: LEAK_ABS_PATH, reason: "read failed: Error: x" },
    { path: "../outside.md", reason: "read failed: Error: x" },
    { path: "C:/Users/someone/file.md", reason: "read failed: Error: x" },
    { path: "a\\b.md", reason: "read failed: Error: x" },
    { path: "", reason: "read failed: Error: x" },
  ]);
  assert.deepEqual(diagnostics, [
    { path: "Memories/2026/10/2026-10-20.md", kind: "read" },
    { path: "Notes/broken.md", kind: "parse" },
  ]);
  assertNoLeak(JSON.stringify(diagnostics), "diagnostics");
});

test("diagnostic path safety matches the vault relative-path rules", () => {
  assert.equal(vault.isSafeVaultDiagnosticPath("Memories/2026-10-20.md"), true);
  assert.equal(vault.isSafeVaultDiagnosticPath("file.md"), true);
  assert.equal(vault.isSafeVaultDiagnosticPath("/abs/file.md"), false);
  assert.equal(vault.isSafeVaultDiagnosticPath("../file.md"), false);
  assert.equal(vault.isSafeVaultDiagnosticPath("a/../file.md"), false);
  assert.equal(vault.isSafeVaultDiagnosticPath("C:/file.md"), false);
  assert.equal(vault.isSafeVaultDiagnosticPath("a\\file.md"), false);
  assert.equal(vault.isSafeVaultDiagnosticPath(""), false);
});

// ---------------------------------------------------------------------------
// 注意表示の組み立て（純粋関数）
// ---------------------------------------------------------------------------

test("attention lines: 0 problem files produce no lines", () => {
  assert.deepEqual(vaultStatus.unreadableAttentionLines(0, []), []);
  assert.deepEqual(vaultStatus.unreadableAttentionLines(0, null), []);
});

test("attention lines: 1 problem file shows the count line and one diagnostic line with path and safe reason", () => {
  const lines = vaultStatus.unreadableAttentionLines(1, [{ path: "Notes/broken.md", kind: "parse" }]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "読み込めないファイルが1件あります");
  assert.ok(lines[1].includes("Notes/broken.md"));
  assert.ok(lines[1].includes("解析失敗"));
  assertNoLeak(lines.join("\n"), "attention lines");
});

test("attention lines: multiple problem files are all shown and the count equals the list length", () => {
  const diagnostics = [
    { path: "Notes/a.md", kind: "read" as const },
    { path: "Notes/b.md", kind: "parse" as const },
    { path: "Notes/c.md", kind: "registry-unconfirmed" as const },
  ];
  const lines = vaultStatus.unreadableAttentionLines(3, diagnostics);
  assert.equal(lines.length, 1 + diagnostics.length);
  assert.equal(lines[0], "読み込めないファイルが3件あります");
  for (const d of diagnostics) assert.ok(lines.some((l) => l.includes(d.path)), `line for ${d.path}`);
  assert.ok(lines.some((l) => l.includes("読み取り失敗")));
  assert.ok(lines.some((l) => l.includes("管理情報の確認不能")));
});

test("attention lines: diagnostics unavailable is stated explicitly, never left blank", () => {
  const lines = vaultStatus.unreadableAttentionLines(2, null);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "読み込めないファイルが2件あります");
  assert.ok(lines[1].includes("取得できませんでした"));
});

test("attention lines: files dropped from the list (unsafe path) are accounted for explicitly", () => {
  const lines = vaultStatus.unreadableAttentionLines(3, [{ path: "Notes/a.md", kind: "read" }]);
  assert.equal(lines.length, 3);
  assert.ok(lines[2].includes("詳細を表示できないファイルが2件あります"));
});

test("diagnostic line text: every kind has a plain label and explanation, with no raw internals", () => {
  for (const kind of ["read", "parse", "registry-unconfirmed", "unknown"] as const) {
    const line = vaultStatus.vaultUnreadableDiagnosticLine({ path: "Notes/x.md", kind });
    assert.ok(line.startsWith("Notes/x.md（"));
    assert.ok(line.length > "Notes/x.md（）".length);
    assertNoLeak(line, "diagnostic line");
  }
  assert.ok(vaultStatus.vaultUnreadableDiagnosticLine({ path: "Notes/x.md", kind: "read" }).includes("読み取り失敗"));
  assert.ok(vaultStatus.vaultUnreadableDiagnosticLine({ path: "Notes/x.md", kind: "unknown" }).includes("理由を特定できませんでした"));
});

// ---------------------------------------------------------------------------
// light-check 実走（架空の保存先）：件数と診断は同じ出所で一致する
// ---------------------------------------------------------------------------

test("end-to-end: 0 problem files (an unrelated note is not counted, nothing is written)", async () => {
  const v = new MemVault({ "Notes/plain.md": PLAIN_NOTE_MD });
  const before = v.snapshot();
  const { result, logs } = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 0);
  assert.deepEqual(result.unreadableDiagnostics, []);
  assert.deepEqual(vaultStatus.unreadableAttentionLines(result.counts.unreadable, result.unreadableDiagnostics), []);
  assert.deepEqual(v.snapshot(), before);
  assert.deepEqual(v.written, []);
  assertNoLeak(logs, "console logs");
});

test("end-to-end: 1 problem file (parse failure) — count and diagnostics agree, internals never leak", async () => {
  const v = new MemVault({ "Notes/broken.md": PARSE_FAIL_MD });
  const before = v.snapshot();
  const { result, logs } = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 1);
  assert.deepEqual(result.unreadableDiagnostics, [{ path: "Notes/broken.md", kind: "parse" }]);
  assert.equal(result.unreadableDiagnostics.length, result.counts.unreadable);
  const lines = vaultStatus.unreadableAttentionLines(result.counts.unreadable, result.unreadableDiagnostics);
  assert.equal(lines[0], "読み込めないファイルが1件あります");
  assert.ok(lines[1].includes("Notes/broken.md") && lines[1].includes("解析失敗"));
  assertNoLeak(lines.join("\n"), "attention lines");
  assertNoLeak(JSON.stringify(result.unreadableDiagnostics), "diagnostics");
  assertNoLeak(logs, "console logs");
  assert.deepEqual(v.snapshot(), before);
  assert.deepEqual(v.written, []);
});

test("end-to-end: 1 problem file (read failure) is classified as read, and the exception text never leaks", async () => {
  const v = new MemVault({ "Notes/unreadable.md": PARSE_FAIL_MD_2 });
  v.failText.add("Notes/unreadable.md");
  const { result, logs } = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 1);
  assert.deepEqual(result.unreadableDiagnostics, [{ path: "Notes/unreadable.md", kind: "read" }]);
  const lines = vaultStatus.unreadableAttentionLines(result.counts.unreadable, result.unreadableDiagnostics);
  assert.ok(lines[1].includes("読み取り失敗"));
  assertNoLeak(lines.join("\n"), "attention lines");
  assertNoLeak(logs, "console logs");
  assert.deepEqual(v.written, []);
});

test("end-to-end: 1 problem file (probe failure) is classified as read", async () => {
  const v = new MemVault({ "Notes/probe.md": PARSE_FAIL_MD_2 });
  v.failProbe.add("Notes/probe.md");
  const { result, logs } = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 1);
  assert.deepEqual(result.unreadableDiagnostics, [{ path: "Notes/probe.md", kind: "read" }]);
  assertNoLeak(logs, "console logs");
});

test("end-to-end: multiple problem files — all are listed and the count equals the list length", async () => {
  const v = new MemVault({
    "Notes/broken-a.md": PARSE_FAIL_MD,
    "Notes/broken-b.md": PARSE_FAIL_MD_2,
    "Notes/broken-c.md": PARSE_FAIL_MD_2,
    "Notes/plain.md": PLAIN_NOTE_MD,
  });
  v.failText.add("Notes/broken-b.md");
  v.failProbe.add("Notes/broken-c.md");
  const { result, logs } = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 3);
  assert.equal(result.unreadableDiagnostics.length, 3);
  const byPath = new Map(result.unreadableDiagnostics.map((d) => [d.path, d.kind]));
  assert.equal(byPath.get("Notes/broken-a.md"), "parse");
  assert.equal(byPath.get("Notes/broken-b.md"), "read");
  assert.equal(byPath.get("Notes/broken-c.md"), "read");
  const lines = vaultStatus.unreadableAttentionLines(result.counts.unreadable, result.unreadableDiagnostics);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "読み込めないファイルが3件あります");
  assertNoLeak(lines.join("\n"), "attention lines");
  assertNoLeak(logs, "console logs");
  assert.deepEqual(v.written, []);
});

test("end-to-end: a parseable file whose registry state cannot be confirmed is classified as registry-unconfirmed", async () => {
  const bucket = vault.vaultRegistryBucketOf("src-fictional-1");
  const shardName = `${bucket.toString(16).padStart(2, "0")}.json`;
  const v = new MemVault({
    "Sources/fictional.md": VALID_SOURCE_MD,
    [`.tsumugi/registry/${shardName}`]: "{ this is not valid json",
  });
  const { result, logs } = await runLightCheck(v);
  assert.equal(result.counts.unreadable, 1);
  assert.deepEqual(result.unreadableDiagnostics, [{ path: "Sources/fictional.md", kind: "registry-unconfirmed" }]);
  const lines = vaultStatus.unreadableAttentionLines(result.counts.unreadable, result.unreadableDiagnostics);
  assert.ok(lines[1].includes("Sources/fictional.md") && lines[1].includes("管理情報の確認不能"));
  assertNoLeak(lines.join("\n"), "attention lines");
  assertNoLeak(logs, "console logs");
  assert.deepEqual(v.written, []);
});

// ---------------------------------------------------------------------------
// 「確認する」の統合結果（findings）まで診断が届くこと
// ---------------------------------------------------------------------------

test("findings: collectVaultStatusFindings carries the diagnostics and the attention lines, read-only", async () => {
  const v = new MemVault({ "Notes/broken.md": PARSE_FAIL_MD });
  const before = v.snapshot();
  const { value: findings, logs } = await capturingConsole(() => vaultStatus.collectVaultStatusFindings(v.dir()));
  assert.equal(findings.lightCheck.result.counts.unreadable, 1);
  assert.deepEqual(findings.unreadableDiagnostics, [{ path: "Notes/broken.md", kind: "parse" }]);
  assert.ok(findings.attention.some((l) => l === "読み込めないファイルが1件あります"));
  assert.ok(findings.attention.some((l) => l.includes("Notes/broken.md") && l.includes("解析失敗")));
  assert.equal(findings.hasAttention, true);
  assertNoLeak(findings.attention.join("\n"), "findings attention");
  assertNoLeak(JSON.stringify(findings.unreadableDiagnostics), "findings diagnostics");
  assertNoLeak(logs, "console logs");
  assert.deepEqual(v.snapshot(), before);
  assert.deepEqual(v.written, []);
});

test("findings: a classified check with no problem files yields an empty diagnostics list and no warning lines", async () => {
  const v = new MemVault({ "Notes/plain.md": PLAIN_NOTE_MD });
  const { value: findings } = await capturingConsole(() => vaultStatus.collectVaultStatusFindings(v.dir()));
  assert.equal(findings.lightCheck.result.counts.unreadable, 0);
  assert.deepEqual(findings.unreadableDiagnostics, []);
  assert.ok(!findings.attention.some((l) => l.includes("読み込めないファイル")));
  assert.deepEqual(v.written, []);
});

test("findings: with no candidates at all, classification does not run and the diagnostics are explicitly unavailable (null)", async () => {
  const v = new MemVault({ "Notes/photo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
  const { value: findings } = await capturingConsole(() => vaultStatus.collectVaultStatusFindings(v.dir()));
  assert.equal(findings.lightCheck.result.counts.unreadable, 0);
  assert.equal(findings.unreadableDiagnostics, null);
  assert.ok(!findings.attention.some((l) => l.includes("読み込めないファイル")));
  assert.deepEqual(v.written, []);
});
