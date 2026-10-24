/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
const URL = "http://localhost:3100/data";
const bundle = path.join(__dirname, ".build/harness.js");
async function attach(page: Page) { await page.addScriptTag({ path: bundle }); }
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
  await setup(page); const before = await text(page);
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
  await page.reload(); await attach(page);
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
