/* eslint-disable @typescript-eslint/no-explicit-any */
// The startup Vault consistency check (READ ONLY) in a real browser: real IndexedDB, Web Locks across tabs, and an OPFS directory standing in for the
// Vault folder (the same OPFS backend Android uses; the PC folder backend is the same FileSystemDirectoryHandle API, without the picker). Fictional data only.
// The check must never call a save in progress an anomaly, never wait forever, never write, and still find a genuine difference.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const URL = "http://localhost:3100/data";
const bundle = path.join(__dirname, ".build/harness.js");
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
async function attach(page: Page) { await page.addScriptTag({ path: bundle }); }

/** a fresh fictional world: two Memories saved through the normal Outbox and projected to the OPFS "Vault" (every Outbox entry done) */
async function setup(page: Page) {
  await page.goto(URL); await attach(page);
  await page.evaluate(async () => {
    const { dbm, proj, lockMod } = (window as any).D; const T = "2026-10-20T00:00:00.000Z";
    const opfs = await navigator.storage.getDirectory();
    try { await opfs.removeEntry("consistency-vault", { recursive: true }); } catch { /* not there */ }
    const root = await opfs.getDirectoryHandle("consistency-vault", { create: true });
    const write = async (p: string, text: string) => {
      const parts = p.split("/"); let dir = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable(); await w.write(text); await w.close();
    };
    await write(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "fictional-consistency", createdAt: T }));
    await write(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: null, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
    const ident = { id: "current", vaultId: "fictional-consistency", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
    await dbm.putVaultIdentityRecord(ident); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
    (window as any).__root = root; (window as any).__env = { root, vaultIdentity: ident, now: () => T };
    const mem = (id: string, summary: string) => ({ id, date: T, types: ["conversation"], conversationId: "fictional-conv", content: `本文 ${summary}`, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: T, updatedAt: T, metadata: { id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    (window as any).__mem = mem;
    for (const m of [mem("cons-mem-1", "架空の記録ひとつ"), mem("cons-mem-2", "架空の記録ふたつ")]) {
      const entry = await dbm.putMemoryObjectWithOutbox(m, "memory");
      const r = await proj.reconcileMemoryOutboxEntry((window as any).__env, entry);
      if (r.status !== "done") throw new Error("seed-not-done:" + JSON.stringify(r));
    }
  });
}
/** the production check (vaultConsistencyCheck.checkVaultConsistency) with short, bounded waits */
const check = (page: Page) => page.evaluate(async () => {
  const { consistencyCheck } = (window as any).D; const started = Date.now();
  const { report, plan } = await consistencyCheck.checkVaultConsistency((window as any).__root, () => false, { drainWaitMs: 1500, pollMs: 100, attempts: 3, retryDelayMs: 100 });
  return { state: report.state, counts: report.counts, findings: report.findings.length, categories: [...report.findings.map((f: any) => `${f.recordId}:${f.category}:${f.reason}`), ...plan.plan.issues.map((i: any) => `issue ${i.path}:${i.status}:${i.error ?? ""}`), ...plan.ops.map((o: any) => `op ${o.kind}:${o.path}:${JSON.stringify(o.steps)}`)], ms: Date.now() - started };
});
/** everything the check could have changed: the OPFS "Vault" files and the save progress (Outbox + ledger) */
const fingerprint = (page: Page) => page.evaluate(async () => {
  const out: Record<string, string> = {};
  const walk = async (dir: any, prefix: string) => { for await (const [name, h] of dir.entries()) { if (h.kind === "directory") await walk(h, prefix + name + "/"); else out[prefix + name] = await (await h.getFile()).text(); } };
  await walk((window as any).__root, "");
  const progress = await (window as any).D.dbm.readVaultSaveProgress();
  return JSON.stringify({ out, progress, memories: await (window as any).D.dbm.getAllMemoryObjects() });
});
const putPending = (page: Page, id: string, summary: string, attempts = 0) => page.evaluate(async ({ id, summary, attempts }) => {
  const { dbm } = (window as any).D; const T = "2026-10-21T00:00:00.000Z";
  const entry = await dbm.putMemoryObjectWithOutbox({ ...(window as any).__mem(id, summary), updatedAt: T }, "memory", T);
  if (attempts > 0) await dbm.putVaultOutboxEntry({ ...entry, attempt: { count: attempts, lastError: "fictional-write-error", lastAttemptAt: T } });
  return entry.id;
}, { id, summary, attempts });
const flush = (page: Page) => page.evaluate(async () => {
  const { dbm, proj } = (window as any).D;
  for (const e of await dbm.getPendingVaultOutboxEntries()) await proj.reconcileMemoryOutboxEntry((window as any).__env, e);
});

for (const device of ["desktop", "android"] as const) {
  test.describe(`${device}`, () => {
    if (device === "android") test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

    test("a completed save is clean, and the check writes nothing", async ({ page }) => {
      await setup(page); const before = await fingerprint(page);
      const r = await check(page);
      expect(r.state, JSON.stringify(r.categories)).toBe("clean"); expect(r.findings).toBe(0);
      expect(await fingerprint(page)).toBe(before);
    });

    test("a pending Outbox entry is 'saving', never corruption; after it drains the re-check is clean", async ({ page }) => {
      await setup(page);
      await putPending(page, "cons-mem-1", "架空の記録ひとつ（編集中）");
      const before = await fingerprint(page);
      const r = await check(page);
      expect(r.state, JSON.stringify(r.categories)).toBe("saving"); expect(r.counts.saving).toBe(1);
      expect(r.counts.needsChoice + r.counts.unknown + r.counts.repairLater).toBe(0);
      expect(await fingerprint(page)).toBe(before);
      await flush(page);
      const drained = await check(page); expect(drained.state, JSON.stringify(drained.categories)).toBe("clean");
    });

    test("a save that never drains does not make the check wait forever (bounded) and is reported as retrying, not a conflict", async ({ page }) => {
      await setup(page);
      await putPending(page, "cons-mem-2", "架空の記録ふたつ（保存失敗）", 5);
      const r = await check(page);
      expect(r.ms).toBeLessThan(15_000);
      expect(r.categories.join(",")).toContain("cons-mem-2:retryable:save-retrying");
      expect(r.counts.needsChoice).toBe(0);
    });

    test("a genuine difference in the Vault file is found (attention), and nothing is overwritten or deleted", async ({ page }) => {
      await setup(page);
      const edited = await page.evaluate(async () => {
        const root = (window as any).__root; const found: string[] = [];
        const walk = async (dir: any, prefix: string) => { for await (const [name, h] of dir.entries()) { if (h.kind === "directory") { if (name !== ".tsumugi") await walk(h, prefix + name + "/"); } else if (name.endsWith(".md")) found.push(prefix + name); } };
        await walk(root, "");
        for (const p of found) {
          const parts = p.split("/"); let dir = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
          const fh = await dir.getFileHandle(parts.at(-1)!); const text = await (await fh.getFile()).text();
          if (!text.includes("架空の記録ひとつ")) continue;
          const w = await fh.createWritable(); await w.write(text.replace("本文 架空の記録ひとつ", "本文 架空の記録ひとつ（別の端末で書き換え）")); await w.close();
          return p;
        }
        return null;
      });
      expect(edited).not.toBeNull();
      const before = await fingerprint(page);
      const r = await check(page);
      expect(r.state).toBe("attention"); expect(r.counts.saving).toBe(0);
      expect(await fingerprint(page)).toBe(before);
    });

    test("another tab on the same OPFS saving during the check never turns into an anomaly", async ({ page, context }) => {
      await setup(page);
      const other = await context.newPage(); await other.goto(URL); await attach(other);
      await other.evaluate(async () => {
        const { dbm, proj, lockMod } = (window as any).D; const T = "2026-10-20T00:00:00.000Z"; lockMod.setTabVaultEpoch(0);
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("consistency-vault");
        const ident = await dbm.getVaultIdentityRecord(); const env = { root, vaultIdentity: ident, now: () => T };
        (window as any).__stop = false;
        (window as any).__loop = (async () => {
          for (let i = 0; !(window as any).__stop && i < 40; i++) {
            const at = `2026-10-22T00:00:${String(i).padStart(2, "0")}.000Z`;
            const m = { ...(await dbm.getMemoryObject("cons-mem-2")), summary: `架空の別タブ編集 ${i}`, updatedAt: at };
            const entry = await dbm.putMemoryObjectWithOutbox(m, "memory", at);
            await proj.reconcileMemoryOutboxEntry(env, entry);
          }
        })();
      });
      const r = await check(page);
      expect(["clean", "saving", "unsettled"], JSON.stringify(r.categories)).toContain(r.state);
      await other.evaluate(async () => { (window as any).__stop = true; await (window as any).__loop; });
      await flush(page);
      const after = await check(page); expect(after.state, JSON.stringify(after.categories)).toBe("clean");
    });
  });
}

test("the diagnosis does not depend on the Memory Timeline / Synthesis switches", async ({ page }) => {
  await setup(page);
  await putPending(page, "cons-mem-1", "架空の記録ひとつ（編集中）");
  const off = await check(page);
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/timeline|synthesis/i.test(k)) localStorage.setItem(k, "1"); localStorage.setItem("tsumugi.memoryTimeline", "1"); localStorage.setItem("tsumugi.memorySynthesis", "1"); });
  const on = await check(page);
  expect({ ...on, ms: 0 }).toEqual({ ...off, ms: 0 });
});
