/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
const URL = "http://localhost:3100/data";
const bundle = path.join(__dirname, ".build/harness.js");
async function attach(page: Page) { await page.addScriptTag({ path: bundle }); }
const openAdvanced = async (page: Page) => { await page.getByText("詳細な管理（上級者向け）").click(); };
async function setup(page: Page) {
  await page.goto(URL); await attach(page);
  await page.evaluate(async () => {
    const { dbm, markdown } = (window as any).D; const root = await navigator.storage.getDirectory();
    const T = "2026-08-20T00:00:00.000Z";
    const m = (id: string) => ({ id, date: T, types: ["conversation"], conversationId: "c", content: "fictional", summary: id, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: T, updatedAt: T, metadata: { id: "meta", source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    const write = async (p: string, text: string) => {
      const parts = p.split("/"); let dir = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable(); await w.write(text); await w.close();
    };
    await dbm.saveVaultHandle(root);
    await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    await dbm.putVaultIdentityRecord({ id: "current", vaultId: "fictional-deletion", activeVaultEpoch: 0, registryGeneration: null, pairedAt: T });
    await write(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "fictional-deletion" }));
    await write("moved/renamed.md", markdown.serializeMemoryDayFile([m("delete-target"), m("retained-neighbor")]));
    await write(".tsumugi/index.json", JSON.stringify({ "delete-target": "moved/renamed.md", "retained-neighbor": "moved/renamed.md" }));
    await dbm.putMemoryObject(m("delete-target")); await dbm.putMemoryObject(m("retained-neighbor"));
    await dbm.deleteMemoryByUser("delete-target");
  });
  await page.reload(); await attach(page);
}
async function text(page: Page) { return page.evaluate(async () => {
  const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle("moved");
  return (await (await dir.getFileHandle("renamed.md")).getFile()).text();
}); }

test("Vault deletion UI: preview and cancel are read-only; explicit confirmation removes only the target", async ({ page }) => {
  await setup(page); await openAdvanced(page); const before = await text(page);
  await page.getByRole("button", { name: "保存先の削除対象を確認…" }).click();
  const confirm = page.getByRole("region", { name: "保存先の削除確認" });
  await expect(confirm).toContainText("moved/renamed.md");
  await expect(confirm.getByRole("button", { name: "保存先からも完全に削除する" })).toBeDisabled();
  await confirm.getByRole("button", { name: "取り消す" }).click(); expect(await text(page)).toBe(before);
  await page.getByRole("button", { name: "保存先の削除対象を確認…" }).click();
  await confirm.getByRole("checkbox").check();
  await confirm.getByRole("button", { name: "保存先からも完全に削除する" }).click();
  await expect(page.getByRole("status")).toContainText("更新が完了");
  expect(await text(page)).not.toContain("id: delete-target"); expect(await text(page)).toContain("id: retained-neighbor");
  expect(await page.evaluate(() => (window as any).D.dbm.getTombstone("memory", "delete-target"))).toMatchObject({ physicalDeletion: "complete" });
});

test("Vault deletion: browser restart after a partial commit resumes the durable plan; restore stays blocked", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const { dbm, deletion } = (window as any).D; const root = await navigator.storage.getDirectory();
    const t = await dbm.getTombstone("memory", "delete-target"); const plan = await deletion.previewVaultDeletion(root, t);
    await dbm.beginPhysicalDeletion(t, JSON.stringify(plan));
    await deletion.applyVaultDeletionEdits(root, { ...plan, edits: plan.edits.slice(0, 1) });
  });
  await page.reload(); await attach(page); await openAdvanced(page);
  await expect(page.getByText("保存先の削除は未完了です。復活防止の記録を保持しています。")).toBeVisible();
  await expect(page.getByRole("button", { name: "戻せるようにする" })).toBeDisabled();
  await page.getByRole("button", { name: "確定済みの削除を再試行" }).click();
  await expect(page.getByRole("status")).toContainText("更新が完了");
  expect(await text(page)).not.toContain("id: delete-target");
});

test("Vault deletion: a second tab's edit after preview invalidates the confirmation", async ({ page, context }) => {
  await setup(page);
  const plan = await page.evaluate(async () => {
    const { dbm, deletion } = (window as any).D;
    return deletion.previewVaultDeletion(await navigator.storage.getDirectory(), await dbm.getTombstone("memory", "delete-target"));
  });
  const other = await context.newPage(); await other.goto(URL);
  await other.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("moved"); const h = await d.getFileHandle("renamed.md");
    const text = await (await h.getFile()).text(); const w = await h.createWritable(); await w.write(text + "\nexternal edit"); await w.close();
  });
  const error = await page.evaluate(async (plan) => {
    try { await (window as any).D.deletion.confirmVaultDeletion(await navigator.storage.getDirectory(), plan); return "unexpected success"; }
    catch (e) { return (e as Error).message; }
  }, plan);
  expect(error).toContain("preview-changed"); expect(await text(page)).toContain("id: delete-target"); expect(await text(page)).toContain("external edit");
  await other.close();
});

test("Vault deletion: concurrent tabs cannot double-confirm; a stale save from the other tab cannot recreate the record", async ({ page, context }) => {
  await setup(page);
  const other = await context.newPage(); await other.goto(URL); await attach(other);
  const plan = await page.evaluate(async () => {
    const { dbm, deletion } = (window as any).D;
    return deletion.previewVaultDeletion(await navigator.storage.getDirectory(), await dbm.getTombstone("memory", "delete-target"));
  });
  await other.evaluate(async () => {
    const { markdown } = (window as any).D; const root = await navigator.storage.getDirectory();
    const text = await (await (await (await root.getDirectoryHandle("moved")).getFileHandle("renamed.md")).getFile()).text();
    (window as any).oldSnapshot = markdown.parseMemoryDayFile(text).find((m: any) => m.id === "delete-target");
  });
  const run = (tab: Page) => tab.evaluate(async (plan) => {
    try { await (window as any).D.deletion.confirmVaultDeletion(await navigator.storage.getDirectory(), plan); return "done"; }
    catch { return "refused"; }
  }, plan);
  const results = await Promise.all([run(page), run(other)]);
  expect(results.sort()).toEqual(["done", "refused"]);
  expect(await other.evaluate(async () => {
    try { await (window as any).D.writeMemoryObjectMarkdown(await navigator.storage.getDirectory(), (window as any).oldSnapshot); return "unexpected"; }
    catch (e) { return (e as Error).message; }
  })).toContain("deleted-record-write-refused");
  expect(await text(page)).not.toContain("id: delete-target");
  await other.close();
});

test("Vault deletion: OPFS Worker path works when native createWritable is unavailable", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const { dbm, deletion } = (window as any).D; const root = await navigator.storage.getDirectory();
    const plan = await deletion.previewVaultDeletion(root, await dbm.getTombstone("memory", "delete-target"));
    Object.defineProperty(FileSystemFileHandle.prototype, "createWritable", { value: undefined, configurable: true });
    await deletion.confirmVaultDeletion(root, plan);
  });
  expect(await text(page)).not.toContain("id: delete-target"); expect(await text(page)).toContain("id: retained-neighbor");
});

test("Vault deletion: a torn Worker result requires a new content review before repair", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const { dbm, deletion } = (window as any).D; const root = await navigator.storage.getDirectory();
    const t = await dbm.getTombstone("memory", "delete-target"); const plan = await deletion.previewVaultDeletion(root, t);
    await dbm.beginPhysicalDeletion(t, JSON.stringify(plan));
    const h = await (await root.getDirectoryHandle("moved")).getFileHandle("renamed.md");
    const w = await h.createWritable(); await w.write("torn Worker result"); await w.close();
  });
  await page.reload(); await attach(page); await openAdvanced(page);
  await page.getByRole("button", { name: "確定済みの削除を再試行" }).click();
  await expect(page.getByRole("status")).toContainText("content-changed");
  await page.getByRole("button", { name: "保存先の削除対象を確認…" }).click();
  await expect(page.getByRole("status")).toContainText("content-review-required");
  expect(await text(page)).toBe("torn Worker result");
  await page.getByRole("button", { name: "中断した変更を確認して修復…" }).click();
  const review = page.getByRole("region", { name: "保存先の削除確認" });
  await review.getByText("moved/renamed.md の内容を確認").click();
  await expect(review).toContainText("torn Worker result"); await expect(review).toContainText("retained-neighbor");
  await review.getByRole("button", { name: "取り消す" }).click(); expect(await text(page)).toBe("torn Worker result");
  await page.getByRole("button", { name: "中断した変更を確認して修復…" }).click();
  await review.getByRole("checkbox").check(); await review.getByRole("button", { name: "保存先からも完全に削除する" }).click();
  await expect(page.getByRole("status")).toContainText("更新が完了");
  expect(await text(page)).not.toContain("id: delete-target"); expect(await text(page)).toContain("id: retained-neighbor");
});

// ---- The single deletion flow in the browser (Android-sized screen) -------------------------------------------------------------------------------------------
async function setupFlow(page: Page, paired = true) {
  await page.goto(URL); await attach(page);
  await page.evaluate(async (paired) => {
    const { dbm, markdown } = (window as any).D; const root = await navigator.storage.getDirectory();
    const T = "2026-08-20T00:00:00.000Z";
    const m = (id: string, summary: string) => ({ id, date: T, types: ["conversation"], conversationId: "c", content: "fictional", summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: T, updatedAt: T, metadata: { id: "meta-" + id, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    const write = async (p: string, text: string) => {
      const parts = p.split("/"); let dir = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable(); await w.write(text); await w.close();
    };
    await dbm.saveVaultHandle(root);
    await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    await dbm.putVaultIdentityRecord({ id: "current", vaultId: paired ? "fictional-deletion" : null, activeVaultEpoch: paired ? 0 : null, registryGeneration: null, pairedAt: paired ? T : null });
    await write(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "fictional-deletion" }));
    const long = "とても長い題名の架空の記憶です。".repeat(8);
    await write("moved/renamed.md", markdown.serializeMemoryDayFile([m("delete-target", long), m("retained-neighbor", "残す記憶")]));
    await write(".tsumugi/index.json", JSON.stringify({ "delete-target": "moved/renamed.md", "retained-neighbor": "moved/renamed.md" }));
    await dbm.putMemoryObject(m("delete-target", long)); await dbm.putMemoryObject(m("retained-neighbor", "残す記憶"));
  }, paired);
  await page.reload(); await attach(page);
  await expect(page.getByRole("heading", { name: "記憶と会話" })).toBeVisible();
}

test("single deletion flow on an Android-sized screen: one dialog, one confirmation, device + Vault, nothing else touched, finished records leave the list, the top link works", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setupFlow(page);
  const link = page.getByRole("link", { name: "トップページへ戻る" });
  await expect(link).toBeInViewport();
  const row = page.getByRole("listitem").filter({ hasText: "とても長い題名" });
  const title = await row.locator("p").first().boundingBox();
  expect(title!.width).toBeGreaterThan(150);                                          // the title is not squeezed into a one-character column
  const neighbour = await text(page);
  await row.getByRole("button", { name: "削除", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(375); expect(box!.y + box!.height).toBeLessThanOrEqual(812);
  await dialog.getByText(/変更される保存先のファイル/).click();
  await expect(dialog).toContainText("moved/renamed.md");
  await expect(dialog.getByRole("button", { name: "削除する" })).toBeDisabled();       // the one safety acknowledgement for a user-selected folder
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "削除する" }).click();
  await expect(dialog).toContainText("端末内と保存先の両方から削除しました。");
  await dialog.getByRole("button", { name: "閉じる" }).click();
  expect(await text(page)).not.toContain("id: delete-target"); expect(await text(page)).toContain("id: retained-neighbor"); expect(neighbour).toContain("id: delete-target");
  expect(await page.evaluate(() => (window as any).D.dbm.getTombstone("memory", "delete-target"))).toMatchObject({ physicalDeletion: "complete" });
  expect(await page.evaluate(() => (window as any).D.dbm.getMemoryObject("retained-neighbor"))).toBeTruthy();
  await expect(page.getByText("とても長い題名")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /削除を完了する/ })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 400)); await expect(link).toBeInViewport();      // the header stays reachable
  await link.click(); await expect(page).toHaveURL("http://localhost:3100/");
});

test("single deletion flow: an interrupted deletion is listed as 'continue deleting' and finishes after one review and one confirmation; the guard never lifts", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setupFlow(page);
  await page.evaluate(async () => {
    const { dbm, deletion } = (window as any).D; const root = await navigator.storage.getDirectory();
    await dbm.deleteMemoryByUser("delete-target"); const t = await dbm.getTombstone("memory", "delete-target");
    const plan = await deletion.previewVaultDeletion(root, t); await dbm.beginPhysicalDeletion(t, JSON.stringify(plan));
    await deletion.applyVaultDeletionEdits(root, { ...plan, edits: plan.edits.slice(0, 1) });          // the process stopped after the first file
  });
  await page.reload(); await attach(page);
  await expect(page.getByRole("heading", { name: /削除を完了する（1）/ })).toBeVisible();
  expect(await page.evaluate(async () => (window as any).D.dbm.restoreMemoryObjectIfNotNewer((await (window as any).D.dbm.getMemoryObject("retained-neighbor")) && { id: "delete-target", date: "2026-08-20T00:00:00.000Z", conversationId: "c", updatedAt: "2099-01-01T00:00:00.000Z", links: [], metadata: {}, types: [], keywords: [], content: "", summary: "" }))).toBe("tombstoned");
  await page.getByRole("button", { name: "削除を続ける" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("止まっていた削除を、続きから行います");
  await expect(dialog.getByRole("button", { name: "削除を続ける" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "削除を続ける" }).click();
  await expect(dialog).toContainText("削除しました");
  await dialog.getByRole("button", { name: "閉じる" }).click();
  expect(await text(page)).not.toContain("id: delete-target"); expect(await text(page)).toContain("id: retained-neighbor");
  await expect(page.getByRole("heading", { name: /削除を完了する/ })).toHaveCount(0);
});

test("single deletion flow: a Vault that is not paired with this device is not deleted from; the screen explains it in plain words and nothing is removed", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await setupFlow(page, false);
  const before = await text(page);
  await page.getByRole("listitem").filter({ hasText: "とても長い題名" }).getByRole("button", { name: "削除", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("紐づけが、まだ完了していません");
  await expect(dialog).not.toContainText("vault-deletion");
  await expect(dialog.getByRole("button", { name: "削除する" })).toBeDisabled();
  await dialog.getByRole("button", { name: "やめる" }).click();
  expect(await text(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).D.dbm.getMemoryObject("delete-target"))).toBeTruthy();
});
