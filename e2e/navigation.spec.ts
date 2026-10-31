/* eslint-disable @typescript-eslint/no-explicit-any */
// Navigation: the bottom bar (history / ＋ import / settings, the same order on phones and PCs), the home button of a long conversation, the unsent draft kept across
// screen moves, and returning to the same conversation after viewing the history. The AI is never called: /api/* answers are fictional stand-ins (no key, no network).
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");

/** a real OPFS Vault with one fictional past conversation (so that the history has something to show) */
async function seed(page: Page) {
  await page.goto(`${BASE}/data`);
  await page.addScriptTag({ path: bundle });
  await page.evaluate(async () => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const T = new Date(Date.now() - 86_400_000).toISOString();
    const meta = { id: "meta-nav-conv", source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T };
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    await dbm.putConversationWithOutbox({ id: "nav-conv-0001", persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, turns: [{ role: "user", content: "昨日の散歩の話（架空）", timestamp: T }, { role: "ai", content: "そうでしたか。", timestamp: T }], memoryObjectIds: [], metadata: meta });
    await bootstrap.runSaveFoundationBootstrap({ root });
  });
}

/** fictional AI: a long streamed reply for the chat, and a plain failure for everything else (capture, prompts, …), which the app already tolerates */
async function fakeApi(page: Page) {
  let n = 0;
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/chat")) {
      n += 1;
      const lines = Array.from({ length: 30 }, (_, i) => `返答${n}の${i + 1}行目。架空の長い返答です。`);
      await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: `${lines.join("\n")}\n返答${n}の終わり` });
    } else {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    }
  });
}

async function openApp(page: Page) {
  await page.goto(BASE);
  await page.getByRole("button", { name: "tsumugiを開く" }).click();
  await expect(page.getByText("今日は、どう話そう？")).toBeVisible();
}

const conversationsWith = (page: Page, text: string) => page.evaluate(async (text) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all: any[] = await new Promise((res, rej) => { const q = db.transaction("conversations", "readonly").objectStore("conversations").getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close();
  return all.filter((c) => (c.turns ?? []).some((t: any) => t.content === text)).length;
}, text);

const VIEWPORTS = [
  ["PC", { width: 1280, height: 800 }, false],
  ["narrow PC window", { width: 700, height: 600 }, false],
  ["Android", { width: 360, height: 780 }, true],
  ["iPhone-size", { width: 390, height: 844 }, true],
] as const;

for (const [name, size, phone] of VIEWPORTS) {
  test(`navigation (${name}): bottom bar order and size, home from a long conversation without scrolling, draft kept, history returns to the same place`, async ({ page }) => {
    await page.setViewportSize(size);
    await seed(page);
    await fakeApi(page);
    await openApp(page);

    // the bottom bar: history, ＋, settings — in this order; icon only on phones (44px targets), icon + label on PCs
    const nav = page.getByRole("navigation", { name: "メインナビゲーション" });
    const history = nav.getByRole("button", { name: "これまでの記憶を見る" });
    const importButton = nav.getByRole("button", { name: "読み込む" });
    const settings = nav.getByRole("button", { name: "設定" });
    const boxes = await Promise.all([history, importButton, settings].map((b) => b.boundingBox()));
    expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
    expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);
    for (const box of boxes) {
      expect(box!.height).toBeGreaterThanOrEqual(phone ? 44 : 40);
      expect(box!.width).toBeGreaterThanOrEqual(phone ? 44 : 40);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    }
    for (const label of ["履歴", "読み込む", "設定"]) {
      if (phone) await expect(nav.getByText(label, { exact: true })).toBeHidden();
      else await expect(nav.getByText(label, { exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);   // no sideways scroll

    // a long conversation
    await page.getByRole("button", { name: "会話", exact: true }).click();
    const footer = page.locator("footer");
    const input = footer.locator("textarea");
    for (let i = 1; i <= 4; i++) {
      await input.fill(`メッセージ${i}（架空）`);
      await footer.getByRole("button", { name: "送る" }).click();
      await expect(page.getByText(`返答${i}の終わり`)).toBeVisible({ timeout: 30_000 });
    }
    // the input and the bar never overlap, and both stay on the screen
    const inputBox = (await footer.boundingBox())!, navBox = (await nav.boundingBox())!;
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(navBox.y + 1);
    expect(navBox.y + navBox.height).toBeLessThanOrEqual(size.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // the logo is far above; the home button is shown instead
    const main = page.locator("main");
    await main.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(page.getByRole("button", { name: "トップ画面へ戻る" })).not.toBeInViewport();
    const home = page.getByRole("button", { name: "ホームへ戻る" });
    await expect(home).toBeInViewport();
    const homeBox = (await home.boundingBox())!;
    expect(homeBox.y + homeBox.height).toBeLessThanOrEqual(inputBox.y);       // nowhere near the input or the bar

    // an unsent draft
    await input.fill("書きかけの文章（架空）");

    // the history opens over the conversation and closes back to the same place
    await main.evaluate((el) => el.scrollTo({ top: el.scrollHeight / 2 }));
    const scrolledTo = await main.evaluate((el) => el.scrollTop);
    await history.click();
    await expect(page.getByText("これまでの記憶", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "閉じる" }).click();
    await expect(page.getByText("返答4の終わり")).toBeAttached();
    expect(Math.abs((await main.evaluate((el) => el.scrollTop)) - scrolledTo)).toBeLessThanOrEqual(2);
    await expect(input).toHaveValue("書きかけの文章（架空）");

    // home: a screen change, not a reload; the conversation is not deleted; the draft comes back with the next conversation
    await page.evaluate(() => { (window as any).__noReload = true; });
    await main.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await home.click();
    await expect(page.getByText("今日は、どう話そう？")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
    await expect.poll(() => conversationsWith(page, "メッセージ1（架空）")).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await expect(page.locator("footer textarea")).toHaveValue("書きかけの文章（架空）");

    // a sent message clears the draft for good
    await page.locator("footer textarea").fill("送る文章（架空）");
    await page.locator("footer").getByRole("button", { name: "送る" }).click();
    await expect(page.getByText("返答5の終わり")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("footer textarea")).toHaveValue("");

    // ＋ and settings still open their screens
    await importButton.click();
    await expect(page.getByText("Import", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "閉じる" }).click();
    await settings.click();
    await expect(page.getByRole("button", { name: "閉じる" }).first()).toBeVisible();
    await page.getByRole("button", { name: "閉じる" }).first().click();
    await expect(page.locator("footer textarea")).toBeVisible();
  });
}
