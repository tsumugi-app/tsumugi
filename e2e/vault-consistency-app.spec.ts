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

const dump = (page: Page) => page.evaluate(async () => {
  const D = (window as any).D; const root = await navigator.storage.getDirectory();
  try { D.lockMod.setTabVaultEpoch(await D.dbm.getActiveVaultEpoch()); } catch (e) { return "epoch-err " + String(e); }
  try {
  const { report, plan } = await D.consistencyCheck.checkVaultConsistency(root, () => false, { drainWaitMs: 500, pollMs: 100, attempts: 1, retryDelayMs: 0 });
  const progress = await D.dbm.readVaultSaveProgress();
  return JSON.stringify({ state: report.state, f: report.findings.map((f: any) => `${f.recordId}:${f.category}:${f.reason}`), held: plan.held, recs: plan.plan.records.filter((r: any) => r.classification !== "unchanged" && r.classification !== "ok").map((r: any) => [r.recordType, r.recordId, r.classification, r.reasons]), issues: plan.plan.issues, ops: plan.ops.map((o: any) => [o.kind, o.steps, o.members.map((m: any) => m.id)]), outbox: progress.outbox.map((e: any) => `${e.id}:${e.status}`), hist: await (async () => { const out: string[] = []; const walk = async (d: any, p: string) => { for await (const [n, h] of d.entries()) { if (h.kind === "directory") await walk(h, p + n + "/"); else if (p.includes("history")) out.push(p + n + "=" + (await (await h.getFile()).text()).slice(0, 900)); } }; await walk(root, ""); return out; })(), mems: (await D.dbm.getAllMemoryObjects()).map((m: any) => [m.id, m.date, m.createdAt, m.types, m.summary]) });
  } catch (e) { return "dump-err " + String(e); }
});
for (const [name, pendingMemory] of [["normal", false], ["pending", true]] as const) {
  test(`DIAG ${name}`, async ({ page }) => {
    test.setTimeout(170_000);
    await seed(page, { project: true, pendingMemory });
    const early = name === "pending" ? await page.evaluate(async () => "") : "";
    await openSettings(page);
    await page.waitForTimeout(45_000);
    const t1 = await settingsText(page);
    await page.addScriptTag({ path: bundle });
    const d1 = await dump(page);
    const check = page.getByRole("button", { name: "確認する", exact: true });
    let t2 = "no-check-button";
    if (await check.count()) { await check.first().click(); await page.waitForTimeout(30_000); t2 = await settingsText(page); }
    throw new Error(`DIAG ${name} ${early} ||T1 ${t1.slice(t1.indexOf("保存先"), t1.indexOf("保存先") + 400)} ||D1 ${d1} ||T2 ${t2.slice(t2.indexOf("保存先"), t2.indexOf("保存先") + 500)}`);
  });
}
