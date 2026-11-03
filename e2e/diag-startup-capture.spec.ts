/* eslint-disable @typescript-eslint/no-explicit-any */
// TEMPORARY investigation, not for merge. Does the startup Capture catch-up reach /api/capture? Fictional data; /api/* is stubbed, so no AI is called.
import { test, type Page } from "@playwright/test";
import path from "node:path";
const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
async function seed(page: Page, n: number) {
  await page.goto(`${BASE}/data`);
  await page.addScriptTag({ path: bundle });
  await page.evaluate(async (n) => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const T = new Date(Date.now() - 86_400_000).toISOString();
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    for (let i = 0; i < n; i++) { const id = `diag-${i}`;
      await dbm.putConversationWithOutbox({ id, persona: "analyst", entryType: "conversation", status: "active", startedAt: T, createdAt: T, updatedAt: T, memoryObjectIds: [], metadata: { id: `m-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T }, turns: [{ role: "user", content: "架空の発言", timestamp: T }, { role: "ai", content: "架空の返答", timestamp: T }] }); }
    await bootstrap.runSaveFoundationBootstrap({ root });
  }, n);
}
for (const [name, waitMs] of [["short", 20_000], ["long", 50_000]] as const) {
  test.only(`startup catch-up, ${name}`, async ({ page }, info) => {
    test.setTimeout(150_000);
    const logs: string[] = []; const t0 = Date.now();
    page.on("console", (m) => { const t = m.text(); if (t.startsWith("[DIAG]")) logs.push(`${Date.now() - t0} ${t}`); });
    let captures = 0;
    await page.route("**/api/**", async (route) => {
      if (route.request().url().includes("/api/capture")) { captures += 1; logs.push(`${Date.now() - t0} capture request`); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ memories: [] }) }); }
      else await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await seed(page, 2);
    await page.goto(BASE);
    await page.getByRole("button", { name: "tsumugiを開く" }).click({ timeout: 60_000 });
    await page.waitForTimeout(waitMs);
    const statuses = await page.evaluate(async () => { const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const all: any[] = await new Promise((res) => { const q = db.transaction("conversations").objectStore("conversations").getAll(); q.onsuccess = () => res(q.result); }); db.close(); return all.map((c) => c.status); });
    console.log(`::notice title=diag-${name}::${JSON.stringify({ captures, statuses, logs: logs.slice(0, 30) }).slice(0, 3500)}`);
  });
}
