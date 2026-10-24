/* eslint-disable @typescript-eslint/no-explicit-any */
// Deleting from the calendar (History): the Memory / conversation detail has "削除"; it removes the WHOLE conversation the Memory came from (device + Vault), not another
// conversation about the same topic. Production writers seed a real OPFS Vault (the save-foundation bootstrap projects the records, pairs the identity, builds the
// History / index / registry); the real app screens do the rest. Fictional data only.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
async function attach(page: Page) { await page.addScriptTag({ path: bundle }); }
const A = "cal-conv-A00001", B = "cal-conv-B00002", A1 = "cal-mem-A00011", A2 = "cal-mem-A00012", B1 = "cal-mem-B00021";

async function seed(page: Page) {
  await page.goto(`${BASE}/data`); await attach(page);
  await page.evaluate(async ([A, B, A1, A2, B1]) => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);          // today (JST): the calendar opens on it
    const T = `${day}T03:00:00.000Z`;
    const meta = (id: string) => ({ id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
    const conv = (id: string, text: string, ids: string[]) => ({ id, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, turns: [{ role: "user", content: text, timestamp: T }, { role: "ai", content: "そうでしたか。", timestamp: T }], memoryObjectIds: ids, metadata: meta(id) });
    const mem = (id: string, c: string, summary: string, links: any[] = []) => ({ id, date: T, types: ["conversation"], conversationId: c, content: `本文 ${summary}`, summary, keywords: ["ガンダム"], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links, evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: meta(id) });
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    await dbm.putConversationWithOutbox(conv(A, "ガンダムの思い出を話した（会話A）", [A1, A2]));
    await dbm.putConversationWithOutbox(conv(B, "別の会話でもガンダムの話をした（会話B）", [B1]));
    await dbm.putMemoryObjectWithOutbox(mem(A1, A, "ガンダムの記憶その1"));
    await dbm.putMemoryObjectWithOutbox(mem(A2, A, "ガンダムの記憶その2"));
    await dbm.putMemoryObjectWithOutbox(mem(B1, B, "ガンダムの別の会話の記憶", [{ id: "cal-link", sourceId: B1, targetId: A1, axis: "theme", reason: "r", contrast: false, strength: 0.5, createdBy: "ai-inference", createdAt: T }]));
    const result = await bootstrap.runSaveFoundationBootstrap({ root });
    if (result.identity.kind !== "newly-paired" && result.identity.kind !== "identified") throw new Error("identity: " + result.identity.kind);
  }, [A, B, A1, A2, B1]);
}
const read = <T,>(page: Page, store: string, key: string) => page.evaluate(async ({ store, key }) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const v = await new Promise((res, rej) => { const q = db.transaction(store, "readonly").objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close(); return v;
}, { store, key }) as Promise<T>;
const vaultText = (page: Page) => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory(); const out: string[] = [];
  const walk = async (d: any, p: string) => { for await (const [n, h] of d.entries()) { if (h.kind === "directory") await walk(h, p + n + "/"); else out.push(p + n + "\n" + await (await h.getFile()).text()); } };
  await walk(root, ""); return out.join("\n=====\n");
});
/** the app starts on a splash screen with one button */
async function openHome(page: Page) {
  await page.goto(BASE);
  await page.getByRole("button", { name: "tsumugiを開く" }).click();
}
async function openCalendar(page: Page) {
  await openHome(page);
  await page.getByRole("button", { name: "これまでの記憶を見る" }).click();
  await expect(page.getByRole("button", { name: /会話A/ })).toBeVisible({ timeout: 30_000 });
}

for (const [name, size] of [["PC", { width: 1280, height: 800 }], ["Android", { width: 375, height: 812 }]] as const) {
  test(`calendar deletion (${name}): from a Memory detail the whole conversation is deleted from the device and the Vault; the other conversation on the same topic stays and only loses its link`, async ({ page }) => {
    await page.setViewportSize(size);
    await seed(page);
    const before = await vaultText(page);
    expect(before).toContain(`id: ${A1}`); expect(before).toContain(`id: ${B1}`);
    await openCalendar(page);
    await page.getByRole("button", { name: /会話A/ }).click();                           // the conversation detail lists its Memories
    await expect(page.getByRole("button", { name: "会話全文を見る" })).toBeVisible();
    await page.getByRole("button", { name: "削除", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("この会話を削除しますか？");
    await expect(dialog).toContainText("ガンダムの思い出を話した（会話A）");           // the conversation content is shown
    await expect(dialog).toContainText("この会話と、ここから生まれた記憶をすべて削除します。ほかの会話は削除されません。");
    await expect(dialog).toContainText("ここから生まれた記憶：2 件");
    await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeVisible();
    for (const gone of ["会話だけ", "Memoryだけ", "関連Memoryも", "この会話から作られた記憶も削除する"]) await expect(dialog).not.toContainText(gone);   // no other choices
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(size.width); expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    expect(await read<any>(page, "conversations", A)).toBeTruthy();                       // cancelling changes nothing
    await page.getByRole("button", { name: "削除", exact: true }).click();
    await dialog.getByRole("checkbox").check();                                           // a user-selected folder can be open in other apps (shown for every non-OPFS Vault)
    await dialog.getByRole("button", { name: "削除する" }).click();
    await expect(dialog).toContainText("端末と保存先の両方から削除しました。");
    await dialog.getByRole("button", { name: "閉じる" }).click();
    // gone from the device
    for (const [store, id] of [["conversations", A], ["memoryObjects", A1], ["memoryObjects", A2]] as const) expect(await read<any>(page, store, id)).toBeUndefined();
    // gone from the Vault (Markdown, History, index, registry); the other conversation and its Memory are still there
    const after = await vaultText(page);
    for (const id of [A, A1, A2]) expect(after).not.toContain(id);
    expect(after).toContain(`id: ${B}`); expect(after).toContain(`id: ${B1}`);
    expect(await read<any>(page, "conversations", B)).toBeTruthy();
    const b1 = await read<any>(page, "memoryObjects", B1); expect(b1.summary).toBe("ガンダムの別の会話の記憶"); expect(b1.links).toEqual([]);
    // the calendar no longer shows it; the other conversation is still listed
    await expect(page.getByRole("button", { name: /会話A/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /会話B/ })).toBeVisible();
    // nothing comes back after a restart
    await page.reload(); await page.getByRole("button", { name: "tsumugiを開く" }).click(); await page.getByRole("button", { name: "これまでの記憶を見る" }).click();
    await expect(page.getByRole("button", { name: /会話B/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /会話A/ })).toHaveCount(0);
    expect(await read<any>(page, "conversations", A)).toBeUndefined();
    expect(await vaultText(page)).not.toContain(A1);
  });
}

test("settings: no 'データの管理' entry any more, and no notice while nothing is unfinished; the old /data URL is only a recovery page", async ({ page }) => {
  await seed(page);
  await openHome(page);
  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.getByText("データの管理")).toHaveCount(0);
  await expect(page.getByText("削除を完了する必要があります")).toHaveCount(0);
  await page.goto(`${BASE}/data`);
  await expect(page.getByRole("heading", { level: 1, name: "削除を完了する" })).toBeVisible();
  await expect(page.getByText("途中で止まっている削除はありません")).toBeVisible();
  await expect(page.getByRole("button", { name: "削除", exact: true })).toHaveCount(0);   // no list of records to delete one by one
});

test("settings: an unfinished deletion is announced and can be continued from there", async ({ page }) => {
  await seed(page);
  await page.evaluate(async ([A]) => {
    const { dbm, deletion } = (window as any).D; const root = await navigator.storage.getDirectory();
    await dbm.deleteConversationWithMemoriesByUser(A);
    await (window as any).D.bootstrap.runSaveFoundationBootstrap({ root });                  // the neighbour's link removal is projected first, so the app has nothing left to rewrite
    const t = await dbm.getTombstone("conversation", A);
    const plan = await deletion.previewVaultDeletion(root, t); await dbm.beginPhysicalDeletion(t, JSON.stringify(plan), plan.ids.filter((id: string) => id !== A));
    await deletion.applyVaultDeletionEdits(root, { ...plan, edits: plan.edits.slice(0, 1) });          // stopped after the first file
  }, [A]);
  await openHome(page);
  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.getByText("削除を完了する必要があります")).toBeVisible();
  await page.getByRole("button", { name: "削除を続ける" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("止まっていた削除を、続きから行います");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "削除を続ける" }).click();
  await expect(dialog).toContainText("削除しました");
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByText("削除を完了する必要があります")).toHaveCount(0);
  const after = await vaultText(page);
  for (const id of [A, A1, A2]) expect(after).not.toContain(id);
  expect(after).toContain(`id: ${B1}`);
});
