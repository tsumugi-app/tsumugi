/* eslint-disable @typescript-eslint/no-explicit-any */
// Saving never loses what is already in a Markdown file (vaultRewriteSafety.ts), in a real browser: real IndexedDB, real bytes in OPFS, real Web Locks across two tabs,
// the production save start-up. Fictional data only. The Android and PC backends share the FileSystemDirectoryHandle API.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const DAY = "2026-10-20";
const DAY_FILE = `Memories/${DAY}.md`;
const SEPARATOR = "\n<!-- tsumugi:entry -->\n\n";

/** loads the harness and opens the fictional vault; the first tab also pairs it. Same identity in every tab. */
async function open(page: Page, first: boolean) {
  await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
  await page.evaluate(async (first) => {
    const { dbm, lockMod } = (window as any).D; const T = `2026-10-20T00:00:00.000Z`;
    const opfs = await navigator.storage.getDirectory();
    if (first) { try { await opfs.removeEntry("safety-vault", { recursive: true }); } catch { /* not there */ } }
    const root = await opfs.getDirectoryHandle("safety-vault", { create: true });
    const write = async (p: string, data: string | Uint8Array) => {
      const parts = p.split("/"); let dir = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable(); await w.write(data); await w.close();
    };
    const ident = { id: "current", vaultId: "fictional-safety", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
    if (first) {
      await write(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "fictional-safety", createdAt: T }));
      await write(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: null, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
      await dbm.putVaultIdentityRecord(ident); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    }
    lockMod.setTabVaultEpoch(0);
    const metadata = { id: "meta", source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T };
    const mem = (id: string, createdAt: string, extra: any = {}) => ({ id, date: "2026-10-20T09:15:00.000Z", types: ["conversation"], conversationId: "safety-conv", content: `架空の本文 ${id}`, summary: `架空の要約 ${id}`,
      keywords: [], links: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], createdAt, updatedAt: createdAt, metadata, ...extra });
    const env = { root, vaultIdentity: ident, now: () => T };
    const saveMem = async (m: any) => (window as any).D.proj.reconcileMemoryOutboxEntry(env, await dbm.putMemoryObjectWithOutbox(m, "memory"));
    Object.assign(window as any, { __root: root, __env: env, __mem: mem, __write: write, __saveMem: saveMem });
  }, first);
}

const readBytes = (page: Page, p: string) => page.evaluate(async (p) => {
  const parts = p.split("/"); let dir = (window as any).__root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return Array.from(new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1))).getFile()).arrayBuffer()));
}, p) as Promise<number[]>;
const readText = async (page: Page, p: string) => new TextDecoder().decode(new Uint8Array(await readBytes(page, p)));
const outbox = (page: Page, id: string) => page.evaluate(async (id) => { const e = await (window as any).D.dbm.getVaultOutboxEntry(id); return e ? { status: e.status, reason: e.heldReason } : null; }, id);
const startUp = (page: Page) => page.evaluate(async () => { await (window as any).D.bootstrap.runSaveFoundationBootstrap({ root: (window as any).__root }); });
const saveMem = (page: Page, id: string, createdAt: string, extra: any = {}) => page.evaluate(async ({ id, createdAt, extra }) => (window as any).__saveMem((window as any).__mem(id, createdAt, extra)), { id, createdAt, extra });

for (const device of ["desktop", "android"] as const) {
  test.describe(device, () => {
    if (device === "android") test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

    test("a hand-written addition to a day file survives normal saves, retries and start-ups, and nothing is duplicated", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, true);
      expect((await saveMem(page, "safety-a", `${DAY}T01:00:00.000Z`)).status).toBe("done");
      const handWritten = `${await readText(page, DAY_FILE)}${SEPARATOR}# 架空の手書きのメモ\n\n自由な文章\n`;
      await page.evaluate(({ p, t }) => (window as any).__write(p, t), { p: DAY_FILE, t: handWritten });

      // normal save (the direct write right after Capture stops at the changed file; the Outbox adds next to the note)
      const direct = await page.evaluate(async () => {
        const { dbm, writeMemoryObjectMarkdown } = (window as any).D; const m = (window as any).__mem("safety-b", "2026-10-20T02:00:00.000Z");
        await dbm.putMemoryObjectWithOutbox(m, "memory");
        return writeMemoryObjectMarkdown((window as any).__root, m).then(() => "written", (e: Error) => e.name);
      });
      expect(direct).toBe("VaultRecordNeedsResyncError");
      expect(await readText(page, DAY_FILE)).toBe(handWritten);
      await startUp(page);
      expect(await outbox(page, "memory:safety-b")).toEqual({ status: "done", reason: null });
      const saved = await readText(page, DAY_FILE);
      expect(saved).toContain("架空の手書きのメモ");
      expect(saved).toContain("架空の本文 safety-b");

      // the next start-ups change nothing (retry, integrity pass)
      await startUp(page); await startUp(page);
      expect(await readText(page, DAY_FILE)).toBe(saved);
      expect(saved.match(/id: safety-b/g)?.length).toBe(1);

      // the direct write now works on the same file, and still only adds
      await page.evaluate(async () => {
        const { dbm, writeMemoryObjectMarkdown } = (window as any).D; const m = (window as any).__mem("safety-c", "2026-10-20T03:00:00.000Z");
        await dbm.putMemoryObjectWithOutbox(m, "memory");
        await writeMemoryObjectMarkdown((window as any).__root, m);
      });
      const third = await readText(page, DAY_FILE);
      expect(third).toContain("架空の手書きのメモ");
      expect(third).toContain("架空の本文 safety-c");
    });

    test("invalid UTF-8 bytes are never rewritten: the save is held, every byte stays, the device keeps the record, and it saves once the file is fixed", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, true);
      expect((await saveMem(page, "safety-a", `${DAY}T01:00:00.000Z`)).status).toBe("done");
      const text = await readText(page, DAY_FILE);
      const bytes = [...new TextEncoder().encode(text), 0x0a, 0xff, 0xfe, 0x0a];
      await page.evaluate(({ p, b }) => (window as any).__write(p, new Uint8Array(b)), { p: DAY_FILE, b: bytes });

      const result = await saveMem(page, "safety-b", `${DAY}T02:00:00.000Z`);
      expect(result).toEqual({ status: "held", reason: "memory-dayfile-unreadable" });
      expect(await readBytes(page, DAY_FILE)).toEqual(bytes);
      await startUp(page);
      expect(await readBytes(page, DAY_FILE)).toEqual(bytes);
      expect(await outbox(page, "memory:safety-b")).toEqual({ status: "held", reason: "memory-dayfile-unreadable" });
      expect(await page.evaluate(async () => (await (window as any).D.dbm.getMemoryObject("safety-b"))?.id)).toBe("safety-b");

      await page.evaluate(({ p, t }) => (window as any).__write(p, t), { p: DAY_FILE, t: text }); // the user fixes the file
      await startUp(page);
      expect(await outbox(page, "memory:safety-b")).toEqual({ status: "done", reason: null });
      expect(await readText(page, DAY_FILE)).toContain("架空の本文 safety-b");
    });

    test("a write cut off in the middle is never treated as the whole file: the save is held and nothing is lost", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, true);
      expect((await saveMem(page, "safety-a", `${DAY}T01:00:00.000Z`)).status).toBe("done");
      const whole = await readBytes(page, DAY_FILE);
      const cut = whole.slice(0, 40);                                                              // inside the frontmatter
      await page.evaluate(({ p, b }) => (window as any).__write(p, new Uint8Array(b)), { p: DAY_FILE, b: cut });
      expect((await saveMem(page, "safety-b", `${DAY}T02:00:00.000Z`)).status).toBe("held");
      expect(await readBytes(page, DAY_FILE)).toEqual(cut);
      expect(await page.evaluate(async () => (await (window as any).D.dbm.getMemoryObject("safety-a"))?.id)).toBe("safety-a");
      await page.evaluate(({ p, b }) => (window as any).__write(p, new Uint8Array(b)), { p: DAY_FILE, b: whole });
      await startUp(page);
      expect(await outbox(page, "memory:safety-b")).toEqual({ status: "done", reason: null });
      expect((await readText(page, DAY_FILE)).match(/id: safety-a/g)?.length).toBe(1);
    });

    test("two tabs saving to the same day at once lose nothing: not each other's records, not the hand-written part", async ({ page, context }) => {
      test.setTimeout(120_000);
      await open(page, true);
      expect((await saveMem(page, "safety-a", `${DAY}T01:00:00.000Z`)).status).toBe("done");
      const other = await context.newPage();
      await open(other, false);
      const noted = `${await readText(page, DAY_FILE)}${SEPARATOR}# 架空の手書きのメモ\n`;
      await page.evaluate(({ p, t }) => (window as any).__write(p, t), { p: DAY_FILE, t: noted });

      const [first, second] = await Promise.all([
        Promise.all(["b", "c", "d"].map((x, i) => saveMem(page, `safety-${x}`, `${DAY}T0${i + 2}:00:00.000Z`))),
        Promise.all(["e", "f", "g"].map((x, i) => saveMem(other, `safety-${x}`, `${DAY}T0${i + 5}:00:00.000Z`))),
      ]);
      // these tabs deliberately skip the save lock to race on the day file. A shared History file can be caught mid-write here; a hold on the Markdown itself never happens
      expect([...first, ...second].some((r: any) => /^memory-/.test(r.reason ?? "")), JSON.stringify([first, second])).toBe(false);
      await startUp(page);
      const after = await readText(page, DAY_FILE);
      expect(after).toContain("架空の手書きのメモ");
      for (const x of ["a", "b", "c", "d", "e", "f", "g"]) expect(after.match(new RegExp(`id: safety-${x}\\b`, "g"))?.length, x).toBe(1);
    });

    test("a Memory edited by hand is not overwritten by its newer version: it is held across start-ups and reported as needing a choice, never as up to date", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, true);
      expect((await saveMem(page, "safety-a", `${DAY}T01:00:00.000Z`)).status).toBe("done");
      const edited = (await readText(page, DAY_FILE)).replace("架空の要約 safety-a", "手で直した架空の要約");
      await page.evaluate(({ p, t }) => (window as any).__write(p, t), { p: DAY_FILE, t: edited });
      const newer = await saveMem(page, "safety-a", `${DAY}T01:00:00.000Z`, { keywords: ["架空"], updatedAt: `${DAY}T05:00:00.000Z` });
      expect(newer).toEqual({ status: "held", reason: "memory-member-edited-conflict" });
      expect(await readText(page, DAY_FILE)).toBe(edited);
      await startUp(page); await startUp(page);
      expect(await readText(page, DAY_FILE)).toBe(edited);

      const report = await page.evaluate(async () => {
        const { report } = await (window as any).D.consistencyCheck.checkVaultConsistency((window as any).__root, () => false, { drainWaitMs: 1500, pollMs: 100, attempts: 3, retryDelayMs: 200 });
        return { state: report.state, findings: report.findings.map((f: any) => `${f.recordId ?? "-"}:${f.category}`) };
      });
      expect(report.state).not.toBe("clean");
      expect(report.findings).toContain("safety-a:needsChoice");
    });
  });
}
