/* eslint-disable @typescript-eslint/no-explicit-any */
// The startup Vault consistency check as the user sees it, in the real app (Settings): after a normal save it says 「✓ 最新の状態です」, a save that is still waiting
// at start-up never turns into a warning, and a genuine difference in a Vault file is not hidden behind 「最新」. Real IndexedDB + an OPFS Vault (the Android backend;
// the PC folder backend is the same FileSystemDirectoryHandle API). The AI is never called. Fictional data only.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const LATEST = "✓ 最新の状態です";
const ATTENTION = "保存先に確認が必要な記録があります";

/** one fictional conversation and its Memory, saved through the normal Outbox; `project` runs the normal save to the Vault before the app starts */
async function seed(page: Page, { project, pendingMemory }: { project: boolean; pendingMemory?: boolean }) {
  await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
  await page.evaluate(async ({ project, pendingMemory }) => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const T = new Date(Date.now() - 86_400_000).toISOString();
    const meta = (id: string) => ({ id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
    const mem = (id: string, summary: string) => ({ id, date: T, types: ["conversation"], conversationId: "app-cons-conv", content: `本文 ${summary}`, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: meta(id) });
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    const conv = (ids: string[], updatedAt: string) => ({ id: "app-cons-conv", persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt, turns: [{ role: "user", content: "架空の散歩の話", timestamp: T }, { role: "ai", content: "そうでしたか。", timestamp: T }], memoryObjectIds: ids, metadata: meta("app-cons-conv") });
    await dbm.putConversationWithOutbox(conv(["app-cons-mem-1"], T));
    await dbm.putMemoryObjectWithOutbox(mem("app-cons-mem-1", "架空の散歩の記録"));
    if (project) await bootstrap.runSaveFoundationBootstrap({ root });
    if (pendingMemory) {   // a second Memory of the same conversation, saved on the device but not yet written to the Vault (as a capture leaves it)
      await dbm.putMemoryObjectWithOutbox(mem("app-cons-mem-2", "架空の保存待ちの記録"));
      await dbm.putConversationWithOutbox(conv(["app-cons-mem-1", "app-cons-mem-2"], new Date().toISOString()));
    }
  }, { project, pendingMemory: !!pendingMemory });
}
async function openSettings(page: Page) {
  await page.goto(BASE);
  await page.getByRole("button", { name: "tsumugiを開く" }).click();
  await page.getByRole("navigation", { name: "メインナビゲーション" }).getByRole("button", { name: "設定" }).click();
}
/** what the Settings Vault section says, for failure messages */
const settingsText = (page: Page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1500));
/** waits for a text; on failure, reports what the screen said at that moment (not before the wait) */
async function expectVisible(page: Page, text: string) {
  try { await expect(page.getByText(text)).toBeVisible({ timeout: 60_000 }); }
  catch { throw new Error(`「${text}」 was not shown. The screen said: ${await settingsText(page)}`); }
}

for (const device of ["PC", "Android"] as const) {
  test.describe(device, () => {
    if (device === "Android") test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

    test("after a normal save, Settings says 「✓ 最新の状態です」 and shows no consistency warning", async ({ page }) => {
      test.setTimeout(120_000);
      await seed(page, { project: true });
      await openSettings(page);
      await expectVisible(page, LATEST);
      await expect(page.getByTestId("vault-consistency")).toHaveCount(0);
      await expect(page.getByText(ATTENTION)).toHaveCount(0);
    });

    test("a save still waiting at start-up is never shown as a consistency warning, and ends at 「✓ 最新の状態です」", async ({ page }) => {
      test.setTimeout(150_000);
      await seed(page, { project: true, pendingMemory: true });
      await openSettings(page);
      const latest = page.getByText(LATEST), attention = page.getByText(ATTENTION);
      const deadline = Date.now() + 90_000;
      while (!(await latest.isVisible())) {
        expect(await attention.count(), await settingsText(page)).toBe(0);              // never a warning while the save drains
        expect(Date.now(), await settingsText(page)).toBeLessThan(deadline);
        await page.waitForTimeout(250);
      }
      await expect(attention).toHaveCount(0);
      await expect(page.getByTestId("vault-consistency")).toHaveCount(0);
    });

    test("a genuine difference in a Vault file is not hidden behind 「最新」: the consistency warning shows kinds and counts, and nothing is changed", async ({ page }) => {
      test.setTimeout(120_000);
      await seed(page, { project: true });
      const before = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory(); const found: [any, string][] = [];
        const walk = async (d: any) => { for await (const [n, h] of d.entries()) { if (h.kind === "directory") { if (n !== ".tsumugi") await walk(h); } else if (n.endsWith(".md")) found.push([h, n]); } };
        await walk(root);
        for (const [h] of found) {
          const text = await (await h.getFile()).text();
          if (!text.includes("本文 架空の散歩の記録")) continue;
          const edited = text.replace("本文 架空の散歩の記録", "本文 架空の散歩の記録（別の端末で書き換え）");
          const w = await h.createWritable(); await w.write(edited); await w.close();
          return edited;
        }
        return null;
      });
      expect(before).not.toBeNull();
      await openSettings(page);
      await expectVisible(page, ATTENTION);
      await expect(page.getByText(LATEST)).toHaveCount(0);
      await expect(page.getByTestId("vault-consistency")).toContainText("件");
      await expect(page.getByTestId("vault-consistency")).toContainText("どの記録も削除・上書きしていません。");
      const after = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory(); let out: string | null = null;
        const walk = async (d: any) => { for await (const [n, h] of d.entries()) { if (h.kind === "directory") { if (n !== ".tsumugi") await walk(h); } else if (n.endsWith(".md")) { const t = await (await h.getFile()).text(); if (t.includes("別の端末で書き換え")) out = t; } } };
        await walk(root); return out;
      });
      expect(after).toBe(before);                                                         // the check did not overwrite the edited file
    });
  });
}
