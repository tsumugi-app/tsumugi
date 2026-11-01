/* eslint-disable @typescript-eslint/no-explicit-any */
// Backup (generic Vault repair, stage 2) in a real browser: real IndexedDB, Web Locks and an OPFS directory standing in for the Vault folder (the Android backend;
// the PC folder backend is the same FileSystemDirectoryHandle API). The backup must hold both sides — records still waiting for / held from the Vault and a
// version that differs between the device and the Vault included — be verified by reading it back, change nothing that exists, and never stop a save.
// The app-level tests drive Settings on PC (save dialog, read back) and Android (download, then the user picks the saved file to verify). Fictional data only.
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const CREATED = "バックアップを作成し、読み戻して内容を確認しました。";
const EXPORTED = "端末の外に書き出し、そのファイルを読み戻して内容を確認しました。";

/** harness world: two Memories saved and projected, then one still waiting (pending), one held with a newer device version, one edited in the Vault */
async function setupWorld(page: Page) {
  await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
  await page.evaluate(async () => {
    const { dbm, proj, lockMod } = (window as any).D; const T = "2026-10-20T00:00:00.000Z";
    const opfs = await navigator.storage.getDirectory();
    try { await opfs.removeEntry("backup-vault", { recursive: true }); } catch { /* not there */ }
    const root = await opfs.getDirectoryHandle("backup-vault", { create: true });
    const write = async (p: string, text: string) => {
      const parts = p.split("/"); let dir = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable(); await w.write(text); await w.close();
    };
    await write(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "fictional-backup", createdAt: T }));
    await write(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: null, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
    const ident = { id: "current", vaultId: "fictional-backup", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
    await dbm.putVaultIdentityRecord(ident); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
    const env = { root, vaultIdentity: ident, now: () => T };
    const mem = (id: string, summary: string, updatedAt = T) => ({ id, date: "2026-10-20T09:15:00.000Z", types: ["conversation"], conversationId: "fictional-conv", content: `本文 ${summary}`, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: T, updatedAt, metadata: { id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    for (const m of [mem("bk-mem-1", "架空の記録ひとつ"), mem("bk-mem-2", "架空の記録ふたつ")]) {
      const r = await proj.reconcileMemoryOutboxEntry(env, await dbm.putMemoryObjectWithOutbox(m, "memory"));
      if (r.status !== "done") throw new Error("seed-not-done:" + JSON.stringify(r));
    }
    await dbm.putMemoryObjectWithOutbox(mem("bk-mem-3", "架空の保存待ちの記録", "2026-10-21T00:00:00.000Z"), "memory", "2026-10-21T00:00:00.000Z");   // pending
    const held = await dbm.putMemoryObjectWithOutbox(mem("bk-mem-2", "架空の記録ふたつ（端末で直した版）", "2026-10-22T00:00:00.000Z"), "memory", "2026-10-22T00:00:00.000Z");
    await dbm.putVaultOutboxEntry({ ...held, status: "held", heldReason: "fictional-conflict" });                                                  // held
    // the Vault copy of bk-mem-1 edited elsewhere: the device and the Vault now hold different versions
    const walk = async (dir: any, prefix: string): Promise<string[]> => { const out: string[] = []; for await (const [n, h] of dir.entries()) { if (h.kind === "directory") { if (n !== ".tsumugi") out.push(...await walk(h, prefix + n + "/")); } else if (n.endsWith(".md")) out.push(prefix + n); } return out; };
    for (const p of await walk(root, "")) {
      const parts = p.split("/"); let dir: any = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      const fh = await dir.getFileHandle(parts.at(-1)); const text = await (await fh.getFile()).text();
      if (!text.includes("本文 架空の記録ひとつ")) continue;
      const w = await fh.createWritable(); await w.write(text.replace("本文 架空の記録ひとつ", "本文 架空の記録ひとつ（保存先で書き換えた版）")); await w.close();
    }
    await dbm.saveApiKey("FICTIONAL-E2E-KEY-0000", "gemini");
    (window as any).__root = root; (window as any).__env = env;
  });
}
/** every Vault file (bytes as hex) + the device data + the API key: what a backup must never change */
const fingerprint = (page: Page) => page.evaluate(async () => {
  const out: Record<string, string> = {};
  const walk = async (dir: any, prefix: string) => { for await (const [name, h] of dir.entries()) { if (h.kind === "directory") await walk(h, prefix + name + "/"); else out[prefix + name] = [...new Uint8Array(await (await h.getFile()).arrayBuffer())].map((b) => b.toString(16)).join(""); } };
  await walk((window as any).__root, "");
  const { dbm } = (window as any).D;
  return { files: out, device: JSON.stringify(await dbm.readBackupDeviceSnapshot()), key: await dbm.loadApiKey("gemini") };
});
const runBackup = (page: Page) => page.evaluate(async () => {
  const { dbm, lockMod, backup } = (window as any).D; let n = 0;
  const r = await backup.createVaultBackup({ root: (window as any).__root, readDevice: dbm.readBackupDeviceSnapshot, withWorldRead: lockMod.withVaultWorldRead, now: () => new Date().toISOString(),
    runId: () => `backup-e2e-${Date.now()}-${n++}`, build: "e2e", backend: "opfs", sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)) }, { retryDelayMs: 200, attempts: 5 });
  return r.ok ? { ok: true, path: r.path, sha256: r.sha256, summary: r.summary } : r;
});

for (const device of ["desktop", "android"] as const) {
  test.describe(`${device}`, () => {
    if (device === "android") test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

    test("the backup holds pending / held saves and both versions of a differing record, verifies by reading back, and changes nothing that exists", async ({ page }) => {
      await setupWorld(page);
      const before = await fingerprint(page);
      const r: any = await runBackup(page);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.summary.pendingSaves).toBe(1); expect(r.summary.heldSaves).toBe(1); expect(r.summary.excludedCredentialKeys).toBe(1);
      const after = await fingerprint(page);
      expect(after.device).toBe(before.device); expect(after.key).toBe(before.key);
      const added = Object.keys(after.files).filter((p) => !(p in before.files)).sort();
      expect(added).toEqual([r.path.replace(/\.zip$/, ".verified.json"), r.path].sort());
      for (const p of Object.keys(before.files)) expect(after.files[p], p).toBe(before.files[p]);
      const inside = await page.evaluate(async (zipPath: string) => {
        const { backup, zip } = (window as any).D; const parts = zipPath.split("/"); let dir: any = (window as any).__root;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        const bytes = new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1))).getFile()).arrayBuffer());
        const verified = await backup.verifyBackupZip(bytes);
        const entries = new Map<string, Uint8Array>(zip.readZipEntries(bytes).map((e: any) => [e.path, e.data]));
        const dec = (p: string) => new TextDecoder().decode(entries.get(p));
        const mems = JSON.parse(dec("device/memoryObjects.json")).map((row: any) => `${row.value.id}:${row.value.summary}`);
        const vaultMd = [...entries.keys()].filter((p) => p.startsWith("vault/") && p.endsWith(".md")).map(dec).join("\n");
        return { verified: verified.ok, unsaved: JSON.parse(dec("manifest.json")).unsavedRecords.map((u: any) => `${u.outboxId}:${u.status}`), mems, vaultMd,
          hasKey: new TextDecoder().decode(bytes).includes("FICTIONAL-E2E-KEY-0000") };
      }, r.path);
      expect(inside.verified).toBe(true);
      expect(inside.unsaved.sort()).toEqual(["memory:bk-mem-2:held", "memory:bk-mem-3:pending"]);
      expect(inside.mems).toContain("bk-mem-3:架空の保存待ちの記録");                       // not yet in the Vault: kept from the device
      expect(inside.mems).toContain("bk-mem-2:架空の記録ふたつ（端末で直した版）");            // held device version
      expect(inside.vaultMd).toContain("本文 架空の記録ふたつ");                             // ...and the Vault's older version of the same record
      expect(inside.mems).toContain("bk-mem-1:架空の記録ひとつ");                             // the device version of the record edited in the Vault
      expect(inside.vaultMd).toContain("架空の記録ひとつ（保存先で書き換えた版）");             // ...and the Vault's edited version
      expect(inside.hasKey).toBe(false);
    });

    test("another tab saving during the backup is never stopped, and the backup is either verified or 'busy' (retryable) — never partial", async ({ page, context }) => {
      await setupWorld(page);
      const other = await context.newPage(); await other.goto(`${BASE}/data`); await other.addScriptTag({ path: bundle });
      await other.evaluate(async () => {
        const { dbm, proj, lockMod } = (window as any).D; lockMod.setTabVaultEpoch(0);
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("backup-vault");
        const env = { root, vaultIdentity: await dbm.getVaultIdentityRecord(), now: () => "2026-10-23T00:00:00.000Z" };
        (window as any).__done = 0;
        (window as any).__loop = (async () => {
          for (let i = 0; i < 15; i++) {
            const at = `2026-10-23T00:00:${String(i).padStart(2, "0")}.000Z`;
            const entry = await dbm.putMemoryObjectWithOutbox({ ...(await dbm.getMemoryObject("bk-mem-3")), summary: `架空の別タブ編集 ${i}`, updatedAt: at }, "memory", at);
            const r = await proj.reconcileMemoryOutboxEntry(env, entry);
            if (r.status === "done") (window as any).__done++;
          }
        })();
      });
      const r: any = await runBackup(page);
      expect(["ok", "busy"]).toContain(r.ok ? "ok" : r.reason);
      const saved = await other.evaluate(async () => { await (window as any).__loop; return (window as any).__done; });
      expect(saved).toBe(15);                                                              // every save of the other tab completed
      if (r.ok) expect(await page.evaluate(async (zipPath: string) => {
        const parts = zipPath.split("/"); let dir: any = (window as any).__root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return (await (window as any).D.backup.verifyBackupZip(new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1))).getFile()).arrayBuffer()))).ok;
      }, r.path)).toBe(true);
    });
  });
}

/** app world (as in vault-consistency-app.spec): one conversation and its Memory, saved normally and written to the Vault */
async function seedApp(page: Page) {
  await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
  await page.evaluate(async () => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const T = new Date(Date.now() - 86_400_000).toISOString();
    const meta = (id: string) => ({ id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    await dbm.putConversationWithOutbox({ id: "app-bk-conv", persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, turns: [{ role: "user", content: "架空の散歩の話", timestamp: T }, { role: "ai", content: "そうでしたか。", timestamp: T }], memoryObjectIds: ["app-bk-mem"], metadata: meta("app-bk-conv") });
    await dbm.putMemoryObjectWithOutbox({ id: "app-bk-mem", date: T, types: ["conversation"], conversationId: "app-bk-conv", content: "本文 架空の散歩の記録", summary: "架空の散歩の記録", keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: meta("app-bk-mem") });
    await bootstrap.runSaveFoundationBootstrap({ root });
  });
}
async function openSettings(page: Page) {
  await page.goto(BASE);
  await page.getByRole("button", { name: "tsumugiを開く" }).click();
  await page.getByRole("navigation", { name: "メインナビゲーション" }).getByRole("button", { name: "設定" }).click();
}
const screenText = (page: Page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1500));
async function expectVisible(page: Page, text: string) {
  try { await expect(page.getByText(text)).toBeVisible({ timeout: 60_000 }); }
  catch { throw new Error(`「${text}」 was not shown. The screen said: ${await screenText(page)}`); }
}
async function createInSettings(page: Page) {
  await page.getByRole("button", { name: "バックアップを作成" }).click();
  await expectVisible(page, CREATED);
  await expect(page.getByTestId("vault-backup")).toContainText("会話1件・Memory 1件");
}

test.describe("PC (save dialog)", () => {
  test("Settings: create a backup, write it out through the save dialog, and the written file is read back and verified", async ({ page }) => {
    test.setTimeout(150_000);
    // the save dialog stands in for an OPFS file in a hidden, non-Tsumugi folder (the backup never reads it)
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle(".e2e-export", { create: true })).getFileHandle("saved.zip", { create: true }) });
    });
    await seedApp(page);
    await openSettings(page);
    await createInSettings(page);
    await page.getByRole("button", { name: "端末の外に書き出す" }).click();
    await expectVisible(page, EXPORTED);
    const same = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const saved = new Uint8Array(await (await (await (await root.getDirectoryHandle(".e2e-export")).getFileHandle("saved.zip")).getFile()).arrayBuffer());
      const dir = await (await root.getDirectoryHandle(".tsumugi")).getDirectoryHandle("repair-backup"); let inVault: Uint8Array | null = null;
      for await (const [name, h] of (dir as any).entries()) if (name.endsWith(".zip")) inVault = new Uint8Array(await (await h.getFile()).arrayBuffer());
      return !!inVault && saved.length === inVault.length && saved.every((b, i) => b === inVault![i]);
    });
    expect(same).toBe(true);
  });
});

test.describe("Android (download, then verify the saved file)", () => {
  test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  test("Settings: create a backup, download it; it is 'verified' only after the saved file is picked and matches — a wrong file is refused", async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => { Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }); Object.defineProperty(navigator, "canShare", { value: () => false, configurable: true }); });
    await seedApp(page);
    await openSettings(page);
    await createInSettings(page);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "端末の外に書き出す" }).click();
    const download = await downloading;
    const saved = test.info().outputPath("downloaded.zip"); await download.saveAs(saved);
    await expectVisible(page, "書き出しました。まだ確認していません。");
    await expect(page.getByText(EXPORTED)).toHaveCount(0);
    // a wrong / broken file is not accepted
    const broken = test.info().outputPath("broken.zip"); fs.writeFileSync(broken, fs.readFileSync(saved).subarray(0, 200));
    await page.getByTestId("vault-backup-verify-input").setInputFiles(broken);
    await expectVisible(page, "選んだファイルは途中で欠けているか、壊れています。もう一度書き出してください。");
    await expect(page.getByText(EXPORTED)).toHaveCount(0);
    // the real saved file is accepted
    await page.getByTestId("vault-backup-verify-input").setInputFiles(saved);
    await expectVisible(page, EXPORTED);
  });
});
