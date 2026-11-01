/* eslint-disable @typescript-eslint/no-explicit-any */
// The generic automatic repair (stage 3) in a real browser: real IndexedDB, Web Locks across tabs, and an OPFS directory standing in for the Vault folder
// (the Android backend; the PC folder backend is the same FileSystemDirectoryHandle API). The PRODUCTION wiring runs (consistency check, verified backup,
// re-verification right before the repair, exclusive section, Recovery Apply, Outbox re-queue, the normal save bootstrap, re-check). Fictional data only.
// It must repair only what the rules prove safe, never overwrite a version it cannot order, keep every existing byte it did not have to change, and only
// call the result clean after a fresh check.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const DAY_FILE = "Memories/2026-10-20.md";

/** a fictional world in OPFS "repair-vault": a conversation and two Memories of 2026-10-20 saved through the normal Outbox (all done) */
async function setup(page: Page) {
  await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
  await page.evaluate(async () => {
    const { dbm, proj, lockMod } = (window as any).D; const T = "2026-10-20T00:00:00.000Z";
    const opfs = await navigator.storage.getDirectory();
    try { await opfs.removeEntry("repair-vault", { recursive: true }); } catch { /* not there */ }
    const root = await opfs.getDirectoryHandle("repair-vault", { create: true });
    const write = async (p: string, text: string) => {
      const parts = p.split("/"); let dir = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable(); await w.write(text); await w.close();
    };
    await write(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "fictional-repair", createdAt: T }));
    await write(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: null, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
    const ident = { id: "current", vaultId: "fictional-repair", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
    await dbm.putVaultIdentityRecord(ident); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
    const meta = (id: string) => ({ id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
    const mem = (id: string, summary: string, createdAt = T) => ({ id, date: "2026-10-20T09:15:00.000Z", types: ["conversation"], conversationId: "repair-conv", content: `本文 ${summary}`, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt, updatedAt: T, metadata: meta(id) });
    const conv = (id: string, ids: string[]) => ({ id, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, turns: [{ role: "user", content: "架空の散歩の話", timestamp: T }, { role: "ai", content: "そうでしたか。", timestamp: T }], memoryObjectIds: ids, metadata: meta(id) });
    Object.assign(window as any, { __root: root, __env: { root, vaultIdentity: ident, now: () => T }, __mem: mem, __conv: conv, __write: write });
    const entries = [
      await dbm.putConversationWithOutbox(conv("repair-conv", ["repair-mem-1", "repair-mem-2"])),
      await dbm.putMemoryObjectWithOutbox(mem("repair-mem-1", "架空の記録ひとつ", "2026-10-20T01:00:00.000Z"), "memory"),
      await dbm.putMemoryObjectWithOutbox(mem("repair-mem-2", "架空の記録ふたつ", "2026-10-20T02:00:00.000Z"), "memory"),
    ];
    for (const e of entries) {
      const r = e.recordType === "conversation" ? await proj.reconcileConversationOutboxEntry((window as any).__env, e) : await proj.reconcileMemoryOutboxEntry((window as any).__env, e);
      if (r.status !== "done") throw new Error("seed-not-done:" + JSON.stringify(r));
    }
  });
}

/** a Memory of the same day that the device has but whose save was held because the day file could not be read at that moment (the file is fine now) */
const addHeldMemory = (page: Page) => page.evaluate(async () => {
  const { dbm, proj } = (window as any).D;
  const entry = await dbm.putMemoryObjectWithOutbox((window as any).__mem("repair-mem-3", "架空の記録みっつ（保存が保留された）", "2026-10-20T03:00:00.000Z"), "memory");
  await dbm.putVaultOutboxEntry({ ...entry, status: "held", heldReason: "memory-dayfile-unreadable", attempt: { count: 1, lastError: "memory-dayfile-unreadable", lastAttemptAt: entry.updatedAt } });
  await dbm.setProjectionHeldReevaluationMarker(proj.PROJECTION_HELD_RULE_VERSION, "2026-10-20T00:00:00.000Z");
});
/** a conversation that exists only on the device (never written to the Vault, no Outbox entry): the Recovery Apply creates it */
const addLocalOnlyConversation = (page: Page) => page.evaluate(async () => {
  await (window as any).D.dbm.putConversation((window as any).__conv("repair-conv-local", []));
});

/** the production auto repair with short, bounded check waits */
const repair = (page: Page, o: { failSettle?: boolean } = {}) => page.evaluate(async ({ failSettle }) => {
  const { autoRepairRun, autoRepair } = (window as any).D;
  const outcome = await autoRepairRun.runProductionVaultAutoRepair({
    root: (window as any).__root, backend: "opfs", isCancelled: () => false,
    checkOptions: { drainWaitMs: 1500, pollMs: 100, attempts: 3, retryDelayMs: 200 },
    ...(failSettle ? { settleSaves: async () => { throw new Error("fictional: the tab was closed before the saves ran"); } } : {}),
  });
  const view = autoRepair.autoRepairOutcomeView(outcome, "opfs");
  return {
    kind: outcome.kind, reason: outcome.reason ?? null, attempted: outcome.attempted ?? 0, repaired: outcome.repaired ?? 0, skipped: outcome.skipped ?? [],
    backupPath: outcome.backup?.path ?? null, after: outcome.after ? { state: outcome.after.state, findings: outcome.after.findings.map((f: any) => `${f.recordId ?? "-"}:${f.category}:${f.reason}`) } : null, view,
  };
}, { failSettle: !!o.failSettle });

const files = (page: Page) => page.evaluate(async () => {
  const out: Record<string, string> = {};
  const walk = async (dir: any, prefix: string) => { for await (const [name, h] of dir.entries()) { if (h.kind === "directory") await walk(h, prefix + name + "/"); else out[prefix + name] = name.endsWith(".zip") ? `zip:${(await h.getFile()).size}` : await (await h.getFile()).text(); } };
  await walk((window as any).__root, ""); return out;
});
const outboxOf = (page: Page, id: string) => page.evaluate(async (id) => (await (window as any).D.dbm.getVaultOutboxEntry(id))?.status ?? null, id);
/** every entry of the day file (the separator is the production one) */
const entriesOf = (text: string | undefined) => (text ?? "").split("\n<!-- tsumugi:entry -->\n\n").map((e) => e.trim()).filter(Boolean);
const verifyBackup = (page: Page, p: string) => page.evaluate(async (p) => {
  const { autoRepairRun, backup } = (window as any).D;
  const bytes = await autoRepairRun.readVaultFileBytes((window as any).__root, p);
  if (!(bytes instanceof Uint8Array)) return "missing";
  const v = await backup.verifyBackupZip(bytes);
  return v.ok ? `ok:${v.manifest.summary.memories}:${v.manifest.summary.heldSaves}` : `bad:${v.problems.join(",")}`;
}, p);

for (const device of ["desktop", "android"] as const) {
  test.describe(device, () => {
    if (device === "android") test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

    test("a held save and a device-only conversation are repaired after a verified backup; existing entries keep every byte; the re-check is clean; a second run does nothing", async ({ page }) => {
      test.setTimeout(120_000);
      await setup(page); await addHeldMemory(page); await addLocalOnlyConversation(page);
      const before = await files(page);
      const r = await repair(page);
      expect(r.kind, JSON.stringify(r)).toBe("ran");
      expect(r.after?.state, JSON.stringify(r)).toBe("clean");
      expect(r.repaired).toBe(2); expect(r.skipped).toEqual([]);
      expect(r.view.clean).toBe(true); expect(r.view.warning).toContain("ブラウザのデータ消去");
      const after = await files(page);
      const day = entriesOf(after[DAY_FILE]);
      for (const old of entriesOf(before[DAY_FILE])) expect(day).toContain(old);              // the two saved entries are kept byte for byte
      expect(day.length).toBe(3); expect(after[DAY_FILE]).toContain("架空の記録みっつ");
      expect(Object.keys(after).some((p) => p.startsWith("Conversations/") && after[p].includes("repair-conv-local"))).toBe(true);
      for (const [p, text] of Object.entries(before)) if (!p.startsWith(".tsumugi/") && p !== DAY_FILE) expect(after[p], p).toBe(text);   // no other file changed
      expect(await outboxOf(page, "memory:repair-mem-3")).toBe("done");
      expect(await verifyBackup(page, r.backupPath!)).toBe("ok:3:1");                         // the backup holds all three Memories and the held save
      expect(after[r.backupPath!.replace(/\.zip$/, ".verified.json")]).toContain(r.backupPath!.split("/").pop()!);
      const again = await repair(page);
      expect(again.kind).toBe("nothing-to-do"); expect(again.after?.state).toBe("clean");
      expect(Object.keys(await files(page)).filter((p) => p.endsWith(".zip")).length, "no new backup when nothing needs repair").toBe(1);
    });

    test("a version difference (the Vault file was edited elsewhere) is never overwritten: it stays, and the result is not called clean", async ({ page }) => {
      test.setTimeout(120_000);
      await setup(page); await addLocalOnlyConversation(page);
      await page.evaluate(async (DAY_FILE) => {
        const root = (window as any).__root; const dir = await root.getDirectoryHandle("Memories"); const fh = await dir.getFileHandle(DAY_FILE.split("/")[1]);
        const text = await (await fh.getFile()).text();
        const w = await fh.createWritable(); await w.write(text.replace("本文 架空の記録ひとつ", "本文 架空の記録ひとつ（別の端末で書き換え）")); await w.close();
      }, DAY_FILE);
      const before = await files(page);
      const r = await repair(page);
      expect(r.kind, JSON.stringify(r)).toBe("ran");
      expect(r.after?.state).toBe("attention");
      expect(r.after?.findings.join(",")).toContain("needsChoice");
      expect(r.view.clean).toBe(false); expect(r.view.headline).toMatch(/件は残っています/);
      expect((await files(page))[DAY_FILE]).toBe(before[DAY_FILE]);                           // the edited day file is untouched
    });

    test("a day file whose rewrite would drop content (an unknown frontmatter key) is not merged into; the held save stays held", async ({ page }) => {
      test.setTimeout(120_000);
      await setup(page); await addHeldMemory(page);
      await page.evaluate(async (DAY_FILE) => {
        const root = (window as any).__root; const dir = await root.getDirectoryHandle("Memories"); const fh = await dir.getFileHandle(DAY_FILE.split("/")[1]);
        const text = await (await fh.getFile()).text();
        const w = await fh.createWritable(); await w.write(text.replace("tsumugi: true", "tsumugi: true\nmyNote: 架空のメモ")); await w.close();
      }, DAY_FILE);
      const before = await files(page);
      const r = await repair(page);
      expect(r.kind, JSON.stringify(r)).toBe("ran");
      expect(r.skipped).toEqual([{ reason: "day-file-not-mergeable", recordType: "memory", count: 1 }]);
      expect(r.view.clean).toBe(false);
      expect((await files(page))[DAY_FILE]).toBe(before[DAY_FILE]);
      expect(await outboxOf(page, "memory:repair-mem-3")).toBe("held");
    });

    test("interrupted after the re-queue (the tab closed before the saves ran): nothing is lost, the normal save finishes it, and pressing again does nothing", async ({ page }) => {
      test.setTimeout(120_000);
      await setup(page); await addHeldMemory(page);
      const before = await files(page);
      const failed = await repair(page, { failSettle: true }).then(() => "finished", (e) => String(e));
      expect(failed).toContain("the tab was closed");
      expect(await outboxOf(page, "memory:repair-mem-3")).toBe("pending");                      // queued for the normal save, the record itself unchanged
      expect((await files(page))[DAY_FILE]).toBe(before[DAY_FILE]);
      await page.evaluate(async () => { await (window as any).D.bootstrap.runSaveFoundationBootstrap({ root: (window as any).__root }); });   // the next start-up
      const again = await repair(page);
      expect(again.kind).toBe("nothing-to-do"); expect(again.after?.state, JSON.stringify(again)).toBe("clean");
      expect(entriesOf((await files(page))[DAY_FILE]).length).toBe(3);
    });

    test("another tab saving during the repair: no lost or doubled record, and everything ends clean", async ({ page, context }) => {
      test.setTimeout(150_000);
      await setup(page); await addHeldMemory(page); await addLocalOnlyConversation(page);
      const other = await context.newPage(); await other.goto(`${BASE}/data`); await other.addScriptTag({ path: bundle });
      await other.evaluate(async () => {
        const { dbm, proj, lockMod } = (window as any).D; const T = "2026-10-20T00:00:00.000Z"; lockMod.setTabVaultEpoch(0);
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("repair-vault");
        const env = { root, vaultIdentity: await dbm.getVaultIdentityRecord(), now: () => T };
        (window as any).__stop = false;
        (window as any).__loop = (async () => {
          for (let i = 0; !(window as any).__stop && i < 30; i++) {
            const at = `2026-10-22T00:00:${String(i).padStart(2, "0")}.000Z`;
            const m = { ...(await dbm.getMemoryObject("repair-mem-2")), summary: `架空の別タブ編集 ${i}`, updatedAt: at };
            const entry = await dbm.putMemoryObjectWithOutbox(m, "memory", at);
            await lockMod.withVaultWorldRead(() => proj.reconcileMemoryOutboxEntry(env, entry));
          }
        })();
      });
      const r = await repair(page);
      expect(["ran", "not-started"], JSON.stringify(r)).toContain(r.kind);
      await other.evaluate(async () => { (window as any).__stop = true; await (window as any).__loop; });
      await page.evaluate(async () => { await (window as any).D.bootstrap.runSaveFoundationBootstrap({ root: (window as any).__root }); });
      const final = await repair(page);
      expect(["nothing-to-do", "ran"]).toContain(final.kind);
      expect(final.after?.state, JSON.stringify(final)).toBe("clean");
      const day = entriesOf((await files(page))[DAY_FILE]);
      expect(day.length, "three Memories, none lost or doubled").toBe(3);
      expect(day.filter((e) => e.includes("repair-mem-2")).length).toBe(1);
    });
  });
}

test.describe("the app (Settings 修復する)", () => {
  /** the same fictional state at the root of OPFS (the app's Android Vault), seeded before the app starts */
  async function seedApp(page: Page) {
    await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
    await page.evaluate(async () => {
      const { dbm, bootstrap, proj } = (window as any).D; const root = await navigator.storage.getDirectory();
      const T = new Date(Date.now() - 86_400_000).toISOString();
      const meta = (id: string) => ({ id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
      const mem = (id: string, summary: string) => ({ id, date: T, types: ["conversation"], conversationId: "app-repair-conv", content: `本文 ${summary}`, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: meta(id) });
      await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
      const conv = { id: "app-repair-conv", persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, turns: [{ role: "user", content: "架空の散歩の話", timestamp: T }, { role: "ai", content: "そうでしたか。", timestamp: T }], memoryObjectIds: ["app-repair-mem-1", "app-repair-mem-2"], metadata: meta("app-repair-conv") };
      await dbm.putConversationWithOutbox(conv);
      await dbm.putMemoryObjectWithOutbox(mem("app-repair-mem-1", "架空の散歩の記録"));
      // the second Memory's save was held (the day file could not be read at that moment); start-up must not re-evaluate it on its own
      const held = await dbm.putMemoryObjectWithOutbox({ ...mem("app-repair-mem-2", "架空の保留された記録"), createdAt: new Date(Date.parse(T) + 1000).toISOString() });
      await dbm.putVaultOutboxEntry({ ...held, status: "held", heldReason: "memory-dayfile-unreadable" });
      await dbm.setProjectionHeldReevaluationMarker(proj.PROJECTION_HELD_RULE_VERSION, T);
      await bootstrap.runSaveFoundationBootstrap({ root });
    });
  }
  async function openSettings(page: Page) {
    await page.goto(BASE);
    await page.getByRole("button", { name: "tsumugiを開く" }).click();
    await page.getByRole("navigation", { name: "メインナビゲーション" }).getByRole("button", { name: "設定" }).click();
  }
  const screen = (page: Page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 2000));

  for (const device of ["PC", "Android"] as const) {
    test.describe(device, () => {
      if (device === "Android") test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

      test("修復する: backs up, repairs the held save through the normal save, re-checks, and only then says 「✓ 最新の状態です」", async ({ page }) => {
        test.setTimeout(180_000);
        await seedApp(page);
        await openSettings(page);
        const repairButton = page.getByTestId("vault-consistency").getByRole("button", { name: "修復する" });
        try { await expect(repairButton).toBeVisible({ timeout: 90_000 }); } catch { throw new Error(`修復する was not offered. The screen said: ${await screen(page)}`); }
        await expect(page.getByText("✓ 最新の状態です")).toHaveCount(0);
        if (device === "Android") await expect(page.getByTestId("vault-consistency")).toContainText("ブラウザのデータ消去");
        await repairButton.click();
        const outcome = page.getByTestId("vault-repair-outcome");
        try { await expect(outcome).toHaveAttribute("data-clean", "true", { timeout: 90_000 }); } catch { throw new Error(`the repair did not end clean. The screen said: ${await screen(page)}`); }
        await expect(outcome).toContainText("読み戻して確認しました");
        if (device === "Android") await expect(outcome).toContainText("ブラウザのデータ消去");
        await expect(page.getByText("✓ 最新の状態です")).toBeVisible({ timeout: 60_000 });
        const vault = await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory(); const out: string[] = [];
          const walk = async (d: any, prefix: string) => { for await (const [n, h] of d.entries()) { if (h.kind === "directory") await walk(h, prefix + n + "/"); else if (n.endsWith(".md") || n.endsWith(".zip") || n.endsWith(".verified.json")) out.push(prefix + n + (n.endsWith(".md") ? "=" + (await (await h.getFile()).text()) : "")); } };
          await walk(root, ""); return out;
        });
        expect(vault.some((f) => f.startsWith(".tsumugi/repair-backup/") && f.endsWith(".zip"))).toBe(true);
        expect(vault.some((f) => f.startsWith(".tsumugi/repair-backup/") && f.endsWith(".verified.json"))).toBe(true);
        const dayFile = vault.find((f) => f.startsWith("Memories/") && f.includes("架空の散歩の記録")) ?? "";
        expect(dayFile).toContain("架空の保留された記録");
      });
    });
  }
});
