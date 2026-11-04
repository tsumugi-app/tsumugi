/* eslint-disable @typescript-eslint/no-explicit-any */
// Startup Memory creation, as specified in docs/startup-memory-capture.md. The AI is never called and every word here is fictional.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const LATEST = "✓ 最新の状態です";
const SETTLE = 10_000, MIN = 60_000;
const said = (name: string) => `架空の話題${name}です`;
const MEMORY = { topicDecision: "newTopic", summary: "架空の要約", content: "架空の記憶", keywords: ["架空"], types: ["conversation"], confidence: 0.9 };

type Past = { id: string; ago: number; status?: "active" | "captured"; turns?: [string, string][]; chatProviders?: string[] };
type CaptureReply = { status?: number; hold?: Promise<void>; abort?: boolean };
/** on, with permission for conversations of any AI, and a fictional key; each test takes away what it is about */
type Device = { enabled?: boolean; allowOtherProviders?: boolean; key?: boolean; recentRuns?: number };

/** a device in normal use: a real OPFS Vault with its Registry baseline, holding fictional past conversations */
async function seed(page: Page, past: Past[] = [], memoryOf?: string, device: Device = {}) {
  await page.addInitScript(() => {
    // a failed Memory write, turned on by the test (the mark does not survive a reload)
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: any[]) {
      if ((window as any).__failMemoryWrite && this.name === "memoryObjects") throw new DOMException("fictional write failure", "UnknownError");
      return (put as any).apply(this, args);
    } as any;
    // a Vault file that cannot be written, turned on by the test (the mark does not survive a reload)
    const createWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (this: FileSystemFileHandle, ...args: any[]) {
      if ((window as any).__failFileWrite) return Promise.reject(new DOMException("fictional write failure", "UnknownError"));
      return (createWritable as any).apply(this, args);
    } as any;
  });
  await page.goto(`${BASE}/data`);
  await page.addScriptTag({ path: bundle });
  await page.evaluate(async ({ past, memoryOf, device }) => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const OLDEST = new Date(Date.now() - 86_400_000 * 500).toISOString();
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    await dbm.saveAutoCaptureSettingsRaw(JSON.stringify({ enabled: device.enabled ?? true, allowOtherProviders: device.allowOtherProviders ?? true }));
    if (device.key ?? true) await dbm.saveApiKey("fictional-test-key", "gemini");
    if (device.recentRuns) await dbm.saveAutoCaptureStateRaw(JSON.stringify({ conversations: {}, recentRuns: Array(device.recentRuns).fill(new Date(Date.now() - 3_600_000).toISOString()) }));
    for (const c of past) {
      const T = new Date(Date.now() - c.ago).toISOString();
      const turns = (c.turns ?? [["user", `架空の話題${c.id}です`], ["ai", "架空の返答です。"]]).map(([role, content]) => ({ role, content, timestamp: T }));
      await dbm.putConversationWithOutbox({ id: c.id, persona: "companion", status: c.status ?? "active", startedAt: T, createdAt: T, updatedAt: T, memoryObjectIds: [], turns, ...(c.chatProviders ? { chatProviders: c.chatProviders } : {}),
        metadata: { id: `meta-${c.id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
      if (c.id === memoryOf) await dbm.putMemoryObjectWithOutbox({ id: `mem-${c.id}`, date: T, types: ["conversation"], conversationId: c.id, content: "架空の保存済みの記憶", summary: "架空の保存済みの要約", keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T,
        metadata: { id: `meta-mem-${c.id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    }
    await bootstrap.runSaveFoundationBootstrap({ root });
    const d = await root.getDirectoryHandle(".tsumugi", { create: true });
    const w = await (await d.getFileHandle("registry-meta.json", { create: true })).createWritable();
    await w.write(JSON.stringify({ schemaVersion: 1, updatedAt: OLDEST, lastFullResyncAt: null, baselineEstablishedAt: OLDEST })); await w.close();
  }, { past, memoryOf, device });
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
      if (r.abort) { await route.abort("failed").catch(() => undefined); return; }
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

const notice = (title: string, value: unknown) => process.stdout.write(`\n::notice title=${title}::${JSON.stringify(value)}\n`);
const nav = (page: Page) => page.getByRole("navigation", { name: "メインナビゲーション" });
const talkFromHome = async (page: Page, words: string) => { await page.getByRole("button", { name: "会話", exact: true }).click(); await talk(page, words); };
const goHome = (page: Page) => page.getByRole("button", { name: /ホームへ戻る|トップ画面へ戻る/ }).first().click();
const withWords = async (page: Page, words: string) => (await rows(page, "conversations")).find((c) => c.turns.some((t: any) => t.content === words));
/** as if the conversation had been left for two hours */
const backdate = (page: Page, id: string) => page.evaluate(async (id) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const c: any = await new Promise((res, rej) => { const q = db.transaction("conversations").objectStore("conversations").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("conversations", "readwrite"); t.objectStore("conversations").put({ ...c, updatedAt: new Date(Date.now() - 7_200_000).toISOString() }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, id);
/** one Memory on the device and in exactly one Vault file, the conversation captured in both, nothing more after another start, and Settings says 最新 */
async function finishedOnce(page: Page, id: string, calls: Parameters<typeof aiCalls>[0], words: string) {
  await expect.poll(() => statusOf(page, id), { timeout: 40_000 }).toBe("captured");
  expect((await memoriesOf(page, id)).length).toBe(1);
  await expect.poll(async () => (await filesWith(page, "架空の記憶")).length, { timeout: 40_000 }).toBe(1);
  await expect.poll(async () => (await filesWith(page, words)).filter((t) => /^status: "?captured"?$/m.test(t)).length, { timeout: 40_000 }).toBe(1);
  const after = calls.capture.length;
  await startApp(page);
  await page.waitForTimeout(SETTLE);
  expect(calls.capture.length, "a processed conversation costs nothing at the next start").toBe(after);
  expect((await memoriesOf(page, id)).length).toBe(1);
  expect((await filesWith(page, "架空の記憶")).length).toBe(1);
  await nav(page).getByRole("button", { name: "設定" }).click();
  await expect(page.getByText(LATEST)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
}

test.describe("startup Memory creation", () => {
  test("a conversation left without an end gets one Capture and one Memory, reaches the file, Settings stays 最新, and later starts call nothing", async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page, [{ id: "left-1", ago: 120 * MIN }]);
    const calls = await fakeApi(page);
    await startApp(page);
    await captureSeen(calls, 1);
    await finishedOnce(page, "left-1", calls, said("left-1"));
    expect(calls.capture.length).toBe(1);
  });

  test("an HTTP failure is remembered: the conversation stays as it was and the next start does not ask again", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "fails-1", ago: 120 * MIN }]);
    const calls = await fakeApi(page, () => ({ status: 503 }));
    await startApp(page);
    await captureSeen(calls, 1);
    await page.waitForTimeout(2_000);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(1);
    expect(await statusOf(page, "fails-1")).toBe("active");
    expect((await memoriesOf(page, "fails-1")).length).toBe(0);
  });

  test("a conversation that keeps failing does not hold back another one", async ({ page }) => {
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
    test.setTimeout(240_000);
    await seed(page, [{ id: "closed-1", ago: 120 * MIN }]);
    let release = () => {}; const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const calls = await fakeApi(page, () => { if (first) { first = false; return { hold: held }; } return {}; });
    await startApp(page);
    await captureSeen(calls, 1);
    await startApp(page);
    release();
    await captureSeen(calls, 2);
    await finishedOnce(page, "closed-1", calls, said("closed-1"));
    expect(calls.capture.length).toBe(2);
  });

  test("a refused key stops the run, uses up no attempt, and the conversations stay as they were", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "key-1", ago: 120 * MIN }, { id: "key-2", ago: 180 * MIN }]);
    const calls = await fakeApi(page, () => ({ status: 401 }));
    await startApp(page);
    await captureSeen(calls, 1);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(1);
    expect(await statusOf(page, "key-1")).toBe("active");
    expect(await statusOf(page, "key-2")).toBe("active");
    await startApp(page);
    await captureSeen(calls, 2);
  });

  test("a large backlog goes one conversation per start, and 5 in 24 hours", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [1, 2, 3, 4, 5, 6].map((n) => ({ id: `many-${n}`, ago: (120 + n) * MIN })));
    const calls = await fakeApi(page);
    await startApp(page);
    await captureSeen(calls, 1);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(1);
    expect(calls.capture[0], "oldest first").toContain("many-6");
  });

  test("the limit of 5 in 24 hours holds across starts", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "over-limit", ago: 120 * MIN }], undefined, { recentRuns: 5 });
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(0);
  });

  test("after 3 failed attempts automatic tries stop; the manual retry in Settings finishes it", async ({ page }) => {
    test.setTimeout(300_000);
    await seed(page, [{ id: "stops-1", ago: 120 * MIN }]);
    let fail = true;
    const calls = await fakeApi(page, () => (fail ? { abort: true } : {}));
    for (let n = 1; n <= 3; n++) {
      await startApp(page);
      await captureSeen(calls, n);
      await page.waitForTimeout(2_000);
    }
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length, "no fourth automatic attempt").toBe(3);
    expect(await statusOf(page, "stops-1")).toBe("active");
    fail = false;
    await nav(page).getByRole("button", { name: "設定" }).click();
    await expect(page.getByTestId("auto-capture-summary")).toContainText("停止中 1 件", { timeout: 30_000 });
    await page.getByTestId("auto-capture-retry").click();
    await captureSeen(calls, 4);
    await expect.poll(() => statusOf(page, "stops-1"), { timeout: 30_000 }).toBe("captured");
    expect((await memoriesOf(page, "stops-1")).length).toBe(1);
    await expect(page.getByTestId("auto-capture-retry")).toHaveCount(0);
  });
});

test.describe("startup Memory creation: who decides", () => {
  test("off by default: a backlog and a key, and nothing is sent or changed", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "off-1", ago: 120 * MIN, chatProviders: ["gemini"] }], undefined, { enabled: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls)).toBe(0);
    expect(await statusOf(page, "off-1")).toBe("active");
  });

  test("turned on in Settings, it starts at the next start", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "on-1", ago: 120 * MIN, chatProviders: ["gemini"] }], undefined, { enabled: false, allowOtherProviders: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await nav(page).getByRole("button", { name: "設定" }).click();
    await expect(page.getByTestId("auto-capture-enabled")).not.toBeChecked({ timeout: 30_000 });
    await expect(page.getByTestId("auto-capture-other-providers")).not.toBeChecked();
    await page.getByTestId("auto-capture-enabled").check();
    await expect(page.getByTestId("auto-capture-summary")).toContainText("未処理 1 件", { timeout: 30_000 });
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length, "not before the next start").toBe(0);
    await startApp(page);
    await captureSeen(calls, 1);
    await expect.poll(() => statusOf(page, "on-1"), { timeout: 30_000 }).toBe("captured");
  });

  test("no user key: nothing is sent, so the server key is never used", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "nokey-1", ago: 120 * MIN }], undefined, { key: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls)).toBe(0);
    expect(await statusOf(page, "nokey-1")).toBe("active");
  });

  test("without the permission only conversations known to be held with Gemini go to Gemini", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [
      { id: "other-ai", ago: 500 * MIN, chatProviders: ["openai"] },
      { id: "both-ai", ago: 400 * MIN, chatProviders: ["gemini", "openai"] },
      { id: "no-record", ago: 300 * MIN },
      { id: "gemini-only", ago: 120 * MIN, chatProviders: ["gemini"] },
    ], undefined, { allowOtherProviders: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await captureSeen(calls, 1);
    expect(calls.capture[0]).toContain("gemini-only");
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(1);
    for (const id of ["other-ai", "both-ai", "no-record"]) expect(await statusOf(page, id)).toBe("active");
  });

  test("a conversation held now records its AI, and the Markdown stays as it was", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [], undefined, { enabled: false });
    await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("記録"));
    await expect.poll(async () => (await withWords(page, said("記録")))?.chatProviders, { timeout: 30_000 }).toEqual(["gemini"]);
    await expect.poll(async () => (await filesWith(page, said("記録"))).length, { timeout: 30_000 }).toBe(1);
    expect((await filesWith(page, said("記録")))[0]).not.toContain("chatProviders");
  });
});

test.describe("the end of a conversation: Memory and status are saved together", () => {
  test("off, as every device is today: leaving makes one Capture and one Memory, saved on the device and in the Vault, and a restart adds nothing", async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page, [], undefined, { enabled: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("通常"));
    await goHome(page);
    await captureSeen(calls, 1);
    const c = await withWords(page, said("通常"));
    await finishedOnce(page, c.id, calls, said("通常"));
    expect(calls.capture.length).toBe(1);
  });

  test("a Memory write that fails leaves the conversation open, never captured without its Memory; a later start finishes it with one Memory", async ({ page }) => {
    test.setTimeout(300_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("書き込み失敗"));
    await page.evaluate(() => { (window as any).__failMemoryWrite = true; });
    await goHome(page);
    await captureSeen(calls, 1);
    await page.waitForTimeout(3_000);
    const held = await withWords(page, said("書き込み失敗"));
    expect((await memoriesOf(page, held.id)).length).toBe(0);
    expect(held.status, "still open for another try").toBe("active");
    await backdate(page, held.id);
    await startApp(page);
    await captureSeen(calls, 2);
    await finishedOnce(page, held.id, calls, said("書き込み失敗"));
    expect(calls.capture.length).toBe(2);
  });

  test("the connection breaks during the Capture: nothing is half saved, and a later start finishes it with one Memory", async ({ page }) => {
    test.setTimeout(300_000);
    await seed(page);
    let drop = true;
    const calls = await fakeApi(page, () => (drop ? { abort: true } : {}));
    await startApp(page);
    await talkFromHome(page, said("切断"));
    await goHome(page);
    await captureSeen(calls, 1);
    await page.waitForTimeout(3_000);
    const held = await withWords(page, said("切断"));
    expect(held.status).toBe("active");
    expect((await memoriesOf(page, held.id)).length).toBe(0);
    drop = false;
    await backdate(page, held.id);
    await startApp(page);
    await captureSeen(calls, 2);
    await finishedOnce(page, held.id, calls, said("切断"));
    expect(calls.capture.length).toBe(2);
  });

  test("the app closes during the Capture: a later start finishes it with one Memory", async ({ page }) => {
    test.setTimeout(300_000);
    await seed(page);
    let release = () => {}; const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const calls = await fakeApi(page, () => { if (first) { first = false; return { hold: held }; } return {}; });
    await startApp(page);
    await talkFromHome(page, said("閉じる"));
    await goHome(page);
    await captureSeen(calls, 1);
    await startApp(page);
    release();
    const c = await withWords(page, said("閉じる"));
    expect(c.status).toBe("active");
    await backdate(page, c.id);
    await startApp(page);
    await captureSeen(calls, 2);
    await finishedOnce(page, c.id, calls, said("閉じる"));
    expect(calls.capture.length).toBe(2);
  });

  test("the app closes after the device save, before the Vault files: the next start writes them, with no second AI call and no duplicate", async ({ page }) => {
    test.setTimeout(300_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("ファイル"));
    await expect.poll(async () => (await filesWith(page, said("ファイル"))).length, { timeout: 30_000 }).toBe(1);
    await page.evaluate(() => { (window as any).__failFileWrite = true; });
    await goHome(page);
    await captureSeen(calls, 1);
    const c = await (async () => { await expect.poll(async () => (await withWords(page, said("ファイル")))?.status, { timeout: 30_000 }).toBe("captured"); return withWords(page, said("ファイル")); })();
    expect((await memoriesOf(page, c.id)).length).toBe(1);
    expect((await filesWith(page, "架空の記憶")).length, "the file was not written").toBe(0);
    await startApp(page);
    await finishedOnce(page, c.id, calls, said("ファイル"));
    expect(calls.capture.length).toBe(1);
  });
});

test.describe("startup Memory creation: limits", () => {
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

  test("recently touched, without an AI reply, or ending in a cut reply: not sent", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [
      { id: "recent", ago: 5 * MIN },
      { id: "no-reply", ago: 120 * MIN, turns: [["user", said("no-reply")]] },
      { id: "cut", ago: 120 * MIN },
    ]);
    await page.evaluate(async () => {
      const { dbm } = (window as any).D; const c = await dbm.getConversation("cut");
      await dbm.putConversationWithOutbox({ ...c, turns: c.turns.map((t: any) => (t.role === "ai" ? { ...t, interrupted: true } : t)) });
    });
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture).toEqual([]);
    for (const id of ["recent", "no-reply", "cut"]) expect(await statusOf(page, id)).toBe("active");
  });

  test("there is no age limit: a conversation from long ago is processed", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "long-ago", ago: 60 * 24 * 60 * MIN }]);
    const calls = await fakeApi(page);
    await startApp(page);
    await captureSeen(calls, 1);
    await expect.poll(() => statusOf(page, "long-ago"), { timeout: 30_000 }).toBe("captured");
  });

  test("a conversation open in another tab is left alone, however old it looks, and keeps every turn", async ({ page, context }) => {
    test.setTimeout(240_000);
    await seed(page);
    const callsA = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("別タブ"));
    await expect.poll(async () => (await withWords(page, said("別タブ")))?.turns.length, { timeout: 30_000 }).toBe(2);
    const { id } = await withWords(page, said("別タブ"));
    await backdate(page, id);
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

  test("a Capture that never answers does not slow the start or the conversation", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "slow-1", ago: 120 * MIN }], undefined, { enabled: false });
    const never = new Promise<void>(() => undefined);
    const calls = await fakeApi(page, () => ({ hold: never }));
    const measure = async (label: string) => {
      const start = Date.now();
      await startApp(page);
      const home = Date.now() - start;
      return { label, home };
    };
    const off = await measure("off");
    await page.evaluate(async () => { const r = await new Promise<IDBDatabase>((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); await new Promise<void>((res, rej) => { const t = r.transaction("settings", "readwrite"); t.objectStore("settings").put(JSON.stringify({ enabled: true, allowOtherProviders: true }), "autoCapture:settings"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); r.close(); });
    const on = await measure("on");
    await captureSeen(calls, 1);
    const sendStart = Date.now();
    await talkFromHome(page, said("話し中"));
    const send = Date.now() - sendStart;
    notice("perf-auto-capture", { homeOff: off.home, homeOn: on.home, sendWhileCaptureRuns: send });
    expect(send, "the conversation is not held up").toBeLessThan(30_000);
    expect(await statusOf(page, "slow-1")).toBe("active");
  });
});
