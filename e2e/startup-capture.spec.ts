/* eslint-disable @typescript-eslint/no-explicit-any */
// Startup Memory creation, as specified in docs/startup-memory-capture.md. The AI is never called and every word here is fictional.
// `test.fail()` marks what the app does not do yet: such a test passes while the behaviour is missing and goes red once it exists, so the mark must be removed with the fix.
// The other tests are limits that hold today and must still hold after the fix.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const LATEST = "✓ 最新の状態です";
const SETTLE = 10_000, MIN = 60_000;
const said = (name: string) => `架空の話題${name}です`;
const MEMORY = { topicDecision: "newTopic", summary: "架空の要約", content: "架空の記憶", keywords: ["架空"], types: ["conversation"], confidence: 0.9 };

type Past = { id: string; ago: number; status?: "active" | "captured"; turns?: [string, string][] };
type CaptureReply = { status?: number; hold?: Promise<void> };

/** a device in normal use: a real OPFS Vault with its Registry baseline, holding fictional past conversations */
async function seed(page: Page, past: Past[] = [], memoryOf?: string) {
  await page.addInitScript(() => {
    // a failed Memory write, turned on by the test (the mark does not survive a reload)
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
      if ((window as any).__failMemoryWrite && this.name === "memoryObjects") throw new DOMException("fictional write failure", "UnknownError");
      return (put as any).apply(this, args);
    } as any;
  });
  await page.goto(`${BASE}/data`);
  await page.addScriptTag({ path: bundle });
  await page.evaluate(async ({ past, memoryOf }) => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const OLDEST = new Date(Date.now() - 86_400_000 * 500).toISOString();
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    for (const c of past) {
      const T = new Date(Date.now() - c.ago).toISOString();
      const turns = (c.turns ?? [["user", `架空の話題${c.id}です`], ["ai", "架空の返答です。"]]).map(([role, content]) => ({ role, content, timestamp: T }));
      await dbm.putConversationWithOutbox({ id: c.id, persona: "companion", status: c.status ?? "active", startedAt: T, createdAt: T, updatedAt: T, memoryObjectIds: [], turns,
        metadata: { id: `meta-${c.id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
      if (c.id === memoryOf) await dbm.putMemoryObjectWithOutbox({ id: `mem-${c.id}`, date: T, types: ["conversation"], conversationId: c.id, content: "架空の保存済みの記憶", summary: "架空の保存済みの要約", keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T,
        metadata: { id: `meta-mem-${c.id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    }
    await bootstrap.runSaveFoundationBootstrap({ root });
    const d = await root.getDirectoryHandle(".tsumugi", { create: true });
    const w = await (await d.getFileHandle("registry-meta.json", { create: true })).createWritable();
    await w.write(JSON.stringify({ schemaVersion: 1, updatedAt: OLDEST, lastFullResyncAt: null, baselineEstablishedAt: OLDEST })); await w.close();
  }, { past, memoryOf });
}

/** fictional AI that counts every call. `reply(body)` decides the answer to one Capture; by default it returns one fictional Memory. */
async function fakeApi(page: Page, reply: (words: string) => CaptureReply = () => ({})) {
  const calls = { chat: 0, capture: [] as string[], connect: 0, prompt: 0 };
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/chat")) {
      calls.chat++;
      await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "架空の返答です。" });
    } else if (url.includes("/api/capture")) {
      const words = (JSON.parse(route.request().postData() ?? "{}").turns ?? []).map((t: any) => t.content).join(" ");
      calls.capture.push(words);
      const r = reply(words);
      if (r.hold) await r.hold;
      await route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.status ? { error: "fictional" } : { memories: [MEMORY] }) }).catch(() => undefined);
    } else {
      if (url.includes("/api/connect")) calls.connect++;
      if (url.includes("/api/prompt")) calls.prompt++;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    }
  });
  return calls;
}

const aiCalls = (c: { capture: string[]; connect: number; prompt: number }) => c.capture.length + c.connect + c.prompt;
async function startApp(page: Page) {
  await page.goto(BASE);
  await page.getByRole("button", { name: "tsumugiを開く" }).click({ timeout: 60_000 });
  await expect(page.getByText("今日は、どう話そう？")).toBeVisible({ timeout: 60_000 });
}
async function talk(page: Page, words: string, replies = 1) {
  await page.locator("footer textarea").fill(words);
  await page.locator("footer").getByRole("button", { name: "送る" }).click();
  await expect(page.getByText("架空の返答です。")).toHaveCount(replies, { timeout: 30_000 });
  await expect(page.locator("footer textarea")).toBeEnabled();
}
const rows = (page: Page, store: string) => page.evaluate(async (s) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const out: any[] = await new Promise((res, rej) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close(); return out;
}, store);
const statusOf = async (page: Page, id: string) => (await rows(page, "conversations")).find((c) => c.id === id)?.status;
const memoriesOf = async (page: Page, id: string) => (await rows(page, "memoryObjects")).filter((m) => m.conversationId === id);
/** the Markdown files holding these words, wherever the app put them */
const filesWith = (page: Page, needle: string) => page.evaluate(async (text) => {
  const found: string[] = [];
  const walk = async (d: any): Promise<void> => { for await (const [name, h] of d.entries()) { if (h.kind === "directory") await walk(h); else if (name.endsWith(".md")) { const t = await (await h.getFile()).text(); if (t.includes(text)) found.push(t); } } };
  await walk(await navigator.storage.getDirectory());
  return found;
}, needle);
const captureSeen = (calls: { capture: string[] }, n: number, timeout = 30_000) => expect.poll(() => calls.capture.length, { timeout }).toBe(n);

test.describe("startup Memory creation: not done yet", () => {
  test("a conversation left without an end gets one Capture and one Memory, reaches the file, Settings stays 最新, and later starts call nothing", async ({ page }) => {
    // test.fail();
    test.setTimeout(240_000);
    await seed(page, [{ id: "left-1", ago: 120 * MIN }]);
    const calls = await fakeApi(page);
    await startApp(page);
    await captureSeen(calls, 1);
    await expect.poll(() => statusOf(page, "left-1"), { timeout: 30_000 }).toBe("captured");
    expect((await memoriesOf(page, "left-1")).length).toBe(1);
    await expect.poll(async () => (await filesWith(page, "架空の記憶")).length, { timeout: 30_000 }).toBe(1);
    const after = aiCalls(calls);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls), "a processed conversation costs nothing at the next start").toBe(after);
    expect((await memoriesOf(page, "left-1")).length).toBe(1);
    await page.getByRole("navigation", { name: "メインナビゲーション" }).getByRole("button", { name: "設定" }).click();
    await expect(page.getByText(LATEST)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
  });

  test("an HTTP failure is remembered: the conversation stays as it was and the next start does not ask again", async ({ page }) => {
    // test.fail();
    test.setTimeout(180_000);
    await seed(page, [{ id: "fails-1", ago: 120 * MIN }]);
    const calls = await fakeApi(page, () => ({ status: 503 }));
    await startApp(page);
    await captureSeen(calls, 1);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(1);
    expect(await statusOf(page, "fails-1")).toBe("active");
    expect((await memoriesOf(page, "fails-1")).length).toBe(0);
  });

  test("a conversation that keeps failing does not hold back another one", async ({ page }) => {
    // test.fail();
    test.setTimeout(240_000);
    await seed(page, [{ id: "fails-2", ago: 300 * MIN }, { id: "works-2", ago: 120 * MIN }]);
    const calls = await fakeApi(page, (words) => (words.includes("fails-2") ? { status: 503 } : {}));
    await startApp(page);
    await captureSeen(calls, 1);
    await page.waitForTimeout(SETTLE);
    await startApp(page);
    await captureSeen(calls, 2);
    await expect.poll(async () => (await memoriesOf(page, "works-2")).length, { timeout: 30_000 }).toBe(1);
    expect(await statusOf(page, "fails-2")).toBe("active");
    expect(calls.capture.filter((w) => w.includes("fails-2")).length).toBe(1);
  });

  test("the app closed during the Capture call: the next start finishes it with one Memory", async ({ page }) => {
    // test.fail();
    test.setTimeout(180_000);
    await seed(page, [{ id: "closed-1", ago: 120 * MIN }]);
    let release = () => {}; const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const calls = await fakeApi(page, () => { if (first) { first = false; return { hold: held }; } return {}; });
    await startApp(page);
    await captureSeen(calls, 1);
    await startApp(page);
    release();
    await captureSeen(calls, 2);
    await expect.poll(() => statusOf(page, "closed-1"), { timeout: 30_000 }).toBe("captured");
    await page.waitForTimeout(SETTLE);
    expect((await memoriesOf(page, "closed-1")).length).toBe(1);
  });

  test("a refused key stops the run after one call, is not counted against the conversations, and they stay as they were", async ({ page }) => {
    // test.fail();
    test.setTimeout(180_000);
    await seed(page, [{ id: "key-1", ago: 120 * MIN }, { id: "key-2", ago: 180 * MIN }]);
    const calls = await fakeApi(page, () => ({ status: 401 }));
    await startApp(page);
    await captureSeen(calls, 1);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(1);
    expect(await statusOf(page, "key-1")).toBe("active");
    expect(await statusOf(page, "key-2")).toBe("active");
  });

  test("a large backlog is limited at each start", async ({ page }) => {
    // test.fail();
    test.setTimeout(180_000);
    await seed(page, [1, 2, 3, 4, 5, 6].map((n) => ({ id: `many-${n}`, ago: (120 + n) * MIN })));
    const calls = await fakeApi(page);
    await startApp(page);
    await expect.poll(() => calls.capture.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBeLessThanOrEqual(3);
  });

  test("a Memory write that fails never leaves a conversation marked captured without its Memory", async ({ page }) => {
    // test.fail();
    test.setTimeout(180_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await talk(page, said("書き込み失敗"));
    await page.evaluate(() => { (window as any).__failMemoryWrite = true; });
    await page.getByRole("button", { name: /ホームへ戻る|トップ画面へ戻る/ }).first().click();
    await captureSeen(calls, 1);
    await page.waitForTimeout(3_000);
    const held = (await rows(page, "conversations")).find((c) => c.turns.some((t: any) => t.content === said("書き込み失敗")));
    expect((await memoriesOf(page, held.id)).length).toBe(0);
    expect(held.status, "still open for another try").toBe("active");
  });
});

test.describe("startup Memory creation: limits that must keep holding", () => {
  test("nothing waiting: a start makes no AI call at all", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "done-1", ago: 120 * MIN, status: "captured" }, { id: "done-2", ago: 180 * MIN, status: "captured" }]);
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls)).toBe(0);
  });

  test("a conversation that already has its Memory is not captured again", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "has-memory", ago: 120 * MIN }], "has-memory");
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(0);
    expect((await memoriesOf(page, "has-memory")).length).toBe(1);
  });

  test("recently touched, past the period, without an AI reply, or ending in a cut reply: not sent", async ({ page }) => {
    test.setTimeout(120_000);
    const CUT: Past = { id: "cut", ago: 120 * MIN };
    await seed(page, [
      { id: "recent", ago: 5 * MIN },
      { id: "too-old", ago: 60 * 24 * 60 * MIN },
      { id: "no-reply", ago: 120 * MIN, turns: [["user", said("no-reply")]] },
      CUT,
    ]);
    await page.evaluate(async () => {
      const { dbm } = (window as any).D; const c = await dbm.getConversation("cut");
      await dbm.putConversationWithOutbox({ ...c, turns: c.turns.map((t: any) => (t.role === "ai" ? { ...t, interrupted: true } : t)) });
    });
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture).toEqual([]);
    for (const id of ["recent", "too-old", "no-reply", "cut"]) expect(await statusOf(page, id)).toBe("active");
  });

  test("a conversation open in another tab is left alone, however old it looks, and keeps every turn", async ({ page, context }) => {
    test.setTimeout(240_000);
    await seed(page);
    const callsA = await fakeApi(page);
    await startApp(page);
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await talk(page, said("別タブ"));
    await expect.poll(async () => (await rows(page, "conversations")).find((c) => c.turns.length === 2)?.id, { timeout: 30_000 }).toBeTruthy();
    const id = (await rows(page, "conversations")).find((c) => c.turns.length === 2).id;
    // as if it had been left for two hours in that tab
    await page.evaluate(async (id) => {
      const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const c: any = await new Promise((res, rej) => { const q = db.transaction("conversations").objectStore("conversations").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      await new Promise<void>((res, rej) => { const t = db.transaction("conversations", "readwrite"); t.objectStore("conversations").put({ ...c, updatedAt: new Date(Date.now() - 7_200_000).toISOString() }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
      db.close();
    }, id);
    const other = await context.newPage();
    const callsB = await fakeApi(other);
    await startApp(other);
    await other.waitForTimeout(SETTLE);
    expect(callsA.capture.length + callsB.capture.length).toBe(0);
    await talk(page, said("別タブの続き"), 2);
    await expect.poll(async () => (await rows(page, "conversations")).find((c) => c.id === id)?.turns.length, { timeout: 30_000 }).toBe(4);
    expect(await statusOf(page, id)).toBe("active");
    expect((await memoriesOf(page, id)).length).toBe(0);
  });

  test("a Capture that takes long does not slow the start or the conversation", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "slow-1", ago: 120 * MIN }]);
    const never = new Promise<void>(() => undefined);
    await fakeApi(page, () => ({ hold: never }));
    await startApp(page);
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await talk(page, said("話し中"));
    expect(await statusOf(page, "slow-1")).toBe("active");
  });
});
