/**
 * 保存先の汎用修復 段階2（バックアップ）の回帰テスト。架空データのみ。実行：`npm run test:vault-backup`。
 * 端末（IndexedDBの内容）と保存先（メモリ上の架空のフォルダ）の両方が、保存待ち・保留の記録や内容の違う版も含めてそのまま入り、
 * 読み戻して照合できたときだけ成功になること、既存のファイルを一切変えないことを確かめる。
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

import type { BackupDeviceSnapshot } from "./db";
const backup = require("./vaultBackup") as typeof import("./vaultBackup");
const zip = require("./zip") as typeof import("./zip");
const db = require("./db") as typeof import("./db");

const T = "2026-10-20T09:15:00.000Z";
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** メモリ上の架空の保存先（FileSystemDirectoryHandleの必要な部分だけ）。書き込みはすべて記録する */
class MemVault {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>([""]);
  unreadable = new Set<string>();
  written: string[] = [];
  corruptWrites = false;
  onWrite: (() => void) | null = null;
  constructor(files: Record<string, string | Uint8Array>) {
    for (const [p, v] of Object.entries(files)) this.put(p, typeof v === "string" ? bytes(v) : v);
  }
  put(p: string, data: Uint8Array) {
    this.files.set(p, data);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }
  snapshot() { return new Map([...this.files].map(([k, v]) => [k, Buffer.from(v).toString("hex")])); }
  notFound(): never { throw Object.assign(new Error("not found"), { name: "NotFoundError" }); }
  dir(prefix = ""): FileSystemDirectoryHandle {
    const self = this;
    const join = (name: string) => (prefix ? `${prefix}/${name}` : name);
    const fileHandle = (p: string) => ({
      kind: "file", name: p.split("/").pop(),
      async getFile() {
        if (self.unreadable.has(p)) throw new DOMException("redacted", "NotReadableError");
        const data = self.files.get(p) ?? self.notFound();
        return { size: data.byteLength, async arrayBuffer() { return data.slice().buffer; }, async text() { return text(data); } };
      },
      async createWritable() {
        let buffer = new Uint8Array(0);
        return {
          async write(d: Uint8Array) { buffer = new Uint8Array(d); },
          async close() {
            const stored = self.corruptWrites ? buffer.map((b, i) => (i === Math.floor(buffer.length / 2) ? b ^ 0xff : b)) : buffer;
            self.put(p, stored); self.written.push(p); self.onWrite?.();
          },
          async abort() { /* nothing written */ },
        };
      },
    });
    return {
      kind: "directory", name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const p = join(name);
        if (!self.dirs.has(p)) { if (!options?.create) self.notFound(); self.dirs.add(p); }
        return self.dir(p);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const p = join(name);
        if (!self.files.has(p)) { if (!options?.create) self.notFound(); self.put(p, new Uint8Array(0)); }
        return fileHandle(p);
      },
      async *entries() {
        const children = new Map<string, "file" | "directory">();
        for (const d of self.dirs) if (d !== prefix && d.startsWith(prefix ? prefix + "/" : "") && !d.slice(prefix ? prefix.length + 1 : 0).includes("/")) children.set(d.split("/").pop()!, "directory");
        for (const f of self.files.keys()) if (f.startsWith(prefix ? prefix + "/" : "") && !f.slice(prefix ? prefix.length + 1 : 0).includes("/")) children.set(f.split("/").pop()!, "file");
        for (const [name, kind] of children) yield [name, kind === "file" ? fileHandle(join(name)) : self.dir(join(name))];
      },
    } as unknown as FileSystemDirectoryHandle;
  }
}

const memory = (id: string, summary: string, updatedAt = T) => ({ id, date: T, types: ["conversation"], conversationId: "conv-1", content: `本文 ${summary}`, summary, createdAt: T, updatedAt });
const outbox = (recordType: string, recordId: string, status: string, recordUpdatedAt = T) => ({ id: `${recordType}:${recordId}`, recordType, recordId, recordUpdatedAt, status, steps: {}, attempt: { count: 0, lastError: null, lastAttemptAt: null }, heldReason: status === "held" ? "conflict" : null, createdAt: T, updatedAt: T });
function device(over: Partial<BackupDeviceSnapshot["stores"]> = {}): BackupDeviceSnapshot {
  const stores = {
    conversations: [{ key: "conv-1", value: { id: "conv-1", startedAt: T, updatedAt: T, turns: [{ role: "user", content: "架空の散歩の話" }], memoryObjectIds: ["mem-1", "mem-2", "mem-3"] } }],
    memoryObjects: [
      { key: "mem-1", value: memory("mem-1", "架空の記録ひとつ（端末の版）", "2026-10-21T00:00:00.000Z") },
      { key: "mem-2", value: memory("mem-2", "架空の保存待ちの記録") },
      { key: "mem-3", value: memory("mem-3", "架空の保留中の記録") },
    ],
    sources: [],
    vaultOutbox: [
      { key: "conversation:conv-1", value: outbox("conversation", "conv-1", "done") },
      { key: "memory:mem-1", value: outbox("memory", "mem-1", "done", "2026-10-21T00:00:00.000Z") },
      { key: "memory:mem-2", value: outbox("memory", "mem-2", "pending") },
      { key: "memory:mem-3", value: outbox("memory", "mem-3", "held") },
    ],
    vaultSyncState: [{ key: "memory:mem-1", value: T }],
    vaultIdentity: [{ key: "current", value: { id: "current", vaultId: "fictional-vault", activeVaultEpoch: 0 } }],
    migrationJournal: [],
    connectState: [],
    settings: [{ key: "tombstones:v1", value: "{}" }, { key: "chatProvider", value: "gemini" }],
    ...over,
  } as BackupDeviceSnapshot["stores"];
  return { stores, excludedCredentialKeys: 1, handleKeys: ["vault"] };
}
const VAULT_FILES = {
  "Memories/2026/10/2026-10-20.md": "---\nid: mem-1\n---\n本文 架空の記録ひとつ（保存先で書き換えた版）\n",   // 端末の版と違う（競合する版）
  "Conversations/2026/10/2026-10-20-conv-1.md": "---\nid: conv-1\n---\n架空の散歩の話\n",
  "archive/Memories/old.md": "---\nid: mem-old\n---\n架空の古い記録\n",
  ".tsumugi/vault-identity.json": JSON.stringify({ vaultId: "fictional-vault" }),
  ".tsumugi/registry/0a.json": "{}",
  ".tsumugi/history/2026-10.json": "{}",
  ".tsumugi/recovery-archive/entries/a.json": "{\"kept\":true}",
  ".tsumugi-archive/orphan-cleanup/x.md": "架空の退避済みファイル",
  ".obsidian/workspace.json": "{}",           // Tsumugiのものではない隠しフォルダ：入れない
  "Memories/photo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // Markdown以外のユーザーのファイル：入れない
};

function env(vault: MemVault, dev: () => Promise<BackupDeviceSnapshot> | BackupDeviceSnapshot, extra: Partial<import("./vaultBackup").VaultBackupEnv> = {}) {
  let inLock = false; const lockLog: string[] = [];
  const e: import("./vaultBackup").VaultBackupEnv & { lockLog: string[] } = {
    root: vault.dir(),
    readDevice: async () => structuredClone(await dev()),
    withWorldRead: async (fn) => { inLock = true; lockLog.push("enter"); try { return await fn(); } finally { inLock = false; lockLog.push("exit"); } },
    now: () => "2026-11-01T00:00:00.000Z",
    runId: () => "backup-20261101-000000-test",
    build: "test", backend: "opfs",
    sleep: async () => undefined,
    lockLog,
    ...extra,
  };
  vault.onWrite = () => { if (inLock) lockLog.push("WRITE-IN-LOCK"); };
  return e;
}

test("ZIP: binary-exact round trip with Japanese names; a flipped byte is caught by the CRC", () => {
  const binary = new Uint8Array([0, 0xff, 0xfe, 0x80, 10, 13]);
  const z = zip.createZipBytes([{ path: "vault/日本語/記録.md", content: "本文" }, { path: "vault/bin", content: binary }]);
  const back = zip.readZipEntries(z);
  assert.deepEqual(back.map((e) => e.path), ["vault/日本語/記録.md", "vault/bin"]);
  assert.equal(text(back[0].data), "本文");
  assert.deepEqual([...back[1].data], [...binary]);
  const bad = z.slice(); bad[40] ^= 0xff;
  assert.throws(() => zip.readZipEntries(bad), (e: Error) => e instanceof zip.ZipFormatError);
  assert.throws(() => zip.readZipEntries(z.slice(0, z.length - 10)), (e: Error) => e instanceof zip.ZipFormatError);
});

test("a backup holds both sides: every device record (pending / held saves included), every Tsumugi Vault file byte-exact, both versions of a conflicting record; it is read back and verified", async () => {
  const vault = new MemVault(VAULT_FILES); const before = vault.snapshot();
  const e = env(vault, () => device());
  const r = await backup.createVaultBackup(e);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.path, ".tsumugi/repair-backup/backup-20261101-000000-test.zip");
  assert.deepEqual(r.summary, { conversations: 1, memories: 3, sources: 0, pendingSaves: 1, heldSaves: 1, vaultFiles: 8, vaultBytes: r.summary.vaultBytes, excludedCredentialKeys: 1 });
  // nothing existing changed; only two NEW files in the backup folder
  for (const [p, hex] of before) assert.equal(Buffer.from(vault.files.get(p)!).toString("hex"), hex, p);
  assert.deepEqual(vault.written.sort(), [".tsumugi/repair-backup/backup-20261101-000000-test.verified.json", ".tsumugi/repair-backup/backup-20261101-000000-test.zip"]);
  // the stored ZIP is the verified one
  const stored = vault.files.get(r.path)!;
  assert.equal(await backup.sha256Hex(stored), r.sha256);
  const v = await backup.verifyBackupZip(stored); assert.equal(v.ok, true);
  const entries = new Map(zip.readZipEntries(stored).map((x) => [x.path, x.data]));
  assert.deepEqual([...entries.keys()].filter((p) => p.startsWith("vault/")).sort(), [
    "vault/.tsumugi-archive/orphan-cleanup/x.md", "vault/.tsumugi/history/2026-10.json", "vault/.tsumugi/recovery-archive/entries/a.json", "vault/.tsumugi/registry/0a.json",
    "vault/.tsumugi/vault-identity.json", "vault/Conversations/2026/10/2026-10-20-conv-1.md", "vault/Memories/2026/10/2026-10-20.md", "vault/archive/Memories/old.md"]);
  for (const [p, data] of entries) if (p.startsWith("vault/")) assert.deepEqual([...data], [...vault.files.get(p.slice(6))!], p);
  // the conflicting record: the device version AND the Vault version are both there, untouched
  const mems = JSON.parse(text(entries.get("device/memoryObjects.json")!)) as { value: { id: string; summary: string } }[];
  assert.equal(mems.find((m) => m.value.id === "mem-1")!.value.summary, "架空の記録ひとつ（端末の版）");
  assert.match(text(entries.get("vault/Memories/2026/10/2026-10-20.md")!), /保存先で書き換えた版/);
  // the unsaved (pending / held) records are listed and their device versions are inside
  const manifest = JSON.parse(text(entries.get("manifest.json")!));
  assert.deepEqual(manifest.unsavedRecords.map((u: { outboxId: string; status: string }) => `${u.outboxId}:${u.status}`), ["memory:mem-2:pending", "memory:mem-3:held"]);
  assert.ok(mems.some((m) => m.value.id === "mem-2") && mems.some((m) => m.value.id === "mem-3"));
  const marker = JSON.parse(text(vault.files.get(".tsumugi/repair-backup/backup-20261101-000000-test.verified.json")!));
  assert.equal(marker.sha256, r.sha256); assert.equal(marker.size, stored.byteLength);
  // the world lock is held only while reading, never while writing
  assert.ok(!e.lockLog.includes("WRITE-IN-LOCK"), e.lockLog.join(","));
});

test("credentials never enter a backup (read from the fake IndexedDB through the production reader)", async () => {
  await db.saveApiKey("FICTIONAL-SECRET-KEY-123", "gemini");
  await db.putConversationWithOutbox({ id: "conv-idb", persona: "companion", status: "active", startedAt: T, endedAt: null, createdAt: T, updatedAt: T, turns: [], memoryObjectIds: [], metadata: { id: "meta", source: "ai-capture", schemaVersion: "0.1", createdAt: T, updatedAt: T } } as never);
  const snap = await db.readBackupDeviceSnapshot();
  assert.equal(snap.excludedCredentialKeys, 1);
  assert.ok(!snap.stores.settings.some((row) => /apikey/i.test(String(row.key))));
  assert.equal(snap.stores.conversations.length, 1);
  assert.equal(snap.stores.vaultOutbox.filter((row) => (row.value as { status: string }).status === "pending").length, 1);
  const vault = new MemVault({});
  const r = await backup.createVaultBackup(env(vault, () => db.readBackupDeviceSnapshot()));
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(!Buffer.from(r.zip).toString("utf8").includes("FICTIONAL-SECRET-KEY-123"));
  assert.equal(await db.loadApiKey("gemini"), "FICTIONAL-SECRET-KEY-123", "the key itself is untouched");
});

test("an unreadable file means NO backup (never a partial one), and nothing is written", async () => {
  const vault = new MemVault(VAULT_FILES); vault.unreadable.add(".tsumugi/registry/0a.json");
  const r = await backup.createVaultBackup(env(vault, () => device()));
  assert.deepEqual(r, { ok: false, reason: "unreadable", retryable: true, count: 1 });
  assert.deepEqual(vault.written, []);
});

test("saves that keep running: re-read until settled (bounded); never settled → 'busy', nothing written; the backup never waits on or blocks a save", async () => {
  let n = 0;
  const moving = () => { n++; return device({ vaultOutbox: [{ key: "memory:mem-2", value: outbox("memory", "mem-2", "pending", `2026-10-2${n % 10}T00:00:00.000Z`) }] } as never); };
  const vault = new MemVault(VAULT_FILES);
  const busy = await backup.createVaultBackup(env(vault, moving), { attempts: 3 });
  assert.deepEqual(busy, { ok: false, reason: "busy", retryable: true });
  assert.equal(n, 6); assert.deepEqual(vault.written, []);
  // settles on the second attempt (a save finished between the first reads): the backup holds the settled state
  let m = 0;
  const settling = () => { m++; return m === 1 ? device({ vaultOutbox: [{ key: "memory:mem-2", value: outbox("memory", "mem-2", "pending") }] } as never) : device({ vaultOutbox: [{ key: "memory:mem-2", value: outbox("memory", "mem-2", "done") }] } as never); };
  const ok = await backup.createVaultBackup(env(new MemVault(VAULT_FILES), settling));
  assert.equal(ok.ok, true); if (ok.ok) assert.equal(ok.summary.pendingSaves, 0);
  // a retrying Outbox entry (attempt count / timestamps change, the record version does not) is NOT movement
  let k = 0;
  const retrying = () => { k++; const entry = outbox("memory", "mem-2", "pending"); entry.attempt = { count: k, lastError: "fictional", lastAttemptAt: `x${k}` } as never; entry.updatedAt = `t${k}`; return device({ vaultOutbox: [{ key: "memory:mem-2", value: entry }] } as never); };
  const r2 = await backup.createVaultBackup(env(new MemVault(VAULT_FILES), retrying));
  assert.equal(r2.ok, true); if (r2.ok) assert.equal(r2.summary.pendingSaves, 1);
});

test("what was written must read back identically: a corrupted write is 'verify-failed' and gets no verified marker", async () => {
  const vault = new MemVault(VAULT_FILES); vault.corruptWrites = true;
  const r = await backup.createVaultBackup(env(vault, () => device()));
  assert.deepEqual(r, { ok: false, reason: "verify-failed", retryable: true });
  assert.ok(!vault.files.has(".tsumugi/repair-backup/backup-20261101-000000-test.verified.json"));
});

test("an existing file of the same name is never opened for writing or overwritten", async () => {
  const vault = new MemVault({ ...VAULT_FILES, ".tsumugi/repair-backup/backup-20261101-000000-test.zip": "架空の既存ファイル" });
  const r = await backup.createVaultBackup(env(vault, () => device()));
  assert.deepEqual(r, { ok: false, reason: "write-failed", retryable: true });
  assert.equal(text(vault.files.get(".tsumugi/repair-backup/backup-20261101-000000-test.zip")!), "架空の既存ファイル");
  assert.deepEqual(vault.written, []);
});

test("a value JSON cannot hold (e.g. a Date) fails the backup instead of silently dropping it", async () => {
  const vault = new MemVault(VAULT_FILES);
  const r = await backup.createVaultBackup(env(vault, () => device({ connectState: [{ key: "x", value: { at: new Date(0) } }] } as never)));
  assert.deepEqual(r, { ok: false, reason: "not-serializable", retryable: false });
  assert.deepEqual(vault.written, []);
});

test("verification finds a missing unsaved record, a changed entry, an unlisted entry and a wrong summary", async () => {
  const { entries, manifest } = await backup.buildBackupEntries(device(), [{ path: "Memories/a.md", data: bytes("架空") }], { runId: "r", createdAt: T, build: "t", backend: "opfs" });
  assert.equal((await backup.verifyBackupZip(zip.createZipBytes(entries), manifest)).ok, true);
  const swap = (p: string, content: string) => entries.map((e) => (e.path === p ? { ...e, content } : e));
  // the pending record's device version is gone (and the manifest hash no longer matches)
  const mems = JSON.stringify(device().stores.memoryObjects.filter((row) => row.key !== "mem-2"));
  const missing = await backup.verifyBackupZip(zip.createZipBytes(swap("device/memoryObjects.json", mems)));
  assert.equal(missing.ok, false);
  if (!missing.ok) { assert.ok(missing.problems.includes("unsaved-record-missing:memory:mem-2"), missing.problems.join()); assert.ok(missing.problems.includes("hash:device/memoryObjects.json")); }
  const changed = await backup.verifyBackupZip(zip.createZipBytes(swap("vault/Memories/a.md", "別の内容")));
  assert.ok(!changed.ok && changed.problems.includes("hash:vault/Memories/a.md"));
  const extra = await backup.verifyBackupZip(zip.createZipBytes([...entries, { path: "vault/extra.md", content: "x" }]));
  assert.ok(!extra.ok && extra.problems.includes("unlisted:vault/extra.md"));
  const lying = { ...manifest, summary: { ...manifest.summary, memories: 99 } };
  const wrong = await backup.verifyBackupZip(zip.createZipBytes([...entries.filter((e) => e.path !== "manifest.json"), { path: "manifest.json", content: JSON.stringify(lying) }]));
  assert.ok(!wrong.ok && wrong.problems.includes("summary-differs"));
});

test("an exported copy is accepted only if it is byte-identical to the verified backup", async () => {
  const r = await backup.createVaultBackup(env(new MemVault(VAULT_FILES), () => device()));
  assert.ok(r.ok); if (!r.ok) return;
  assert.deepEqual(await backup.verifyExportedBackup(r.zip, r), { ok: true });
  assert.deepEqual(await backup.verifyExportedBackup(r.zip.slice(0, r.zip.length - 100), r), { ok: false, reason: "corrupt" });
  const other = await backup.createVaultBackup(env(new MemVault({ "Memories/b.md": "別の架空の記録" }), () => device()));
  assert.ok(other.ok); if (!other.ok) return;
  assert.deepEqual(await backup.verifyExportedBackup(other.zip, r), { ok: false, reason: "different-file" });
});

test("which Vault paths are backed up", () => {
  for (const p of ["Memories/a.md", "x/y/z.MD", ".tsumugi/index.json", ".tsumugi/registry/0a.json", ".tsumugi-archive/a/b.md"]) assert.equal(backup.isBackedUpVaultPath(p), true, p);
  for (const p of [".tsumugi/repair-backup/x.zip", ".tsumugi/repair-backup", ".obsidian/a.json", "Memories/.hidden.md", "Memories/photo.png", ".trash/a.md"]) assert.equal(backup.isBackedUpVaultPath(p), false, p);
});

test("screen text: counts only, unsaved records mentioned, failures say what to do", () => {
  assert.equal(backup.backupSummaryText({ conversations: 2, memories: 5, sources: 0, pendingSaves: 1, heldSaves: 1, vaultFiles: 9, vaultBytes: 1, excludedCredentialKeys: 0 }),
    "会話2件・Memory 5件・保存先のファイル9件（保存先へ未反映の記録2件も含みます）");
  assert.match(backup.backupFailureText({ ok: false, reason: "unreadable", retryable: true, count: 2 }), /2件.*一部だけのバックアップは作りません/);
  assert.match(backup.backupFailureText({ ok: false, reason: "verify-failed", retryable: true }), /読み戻して内容を確認できませんでした/);
});
