/* eslint-disable @typescript-eslint/no-explicit-any */
// Realtime diary, PR-A: the separate entry, pausing and resuming one conversation for the day, the time labels, and that a paused diary makes no Memory
// and sends nothing (going home, the header button, the automatic run at a start). The AI is never called and every word here is fictional.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const MIN = 60_000;
const MEMORY = { topicDecision: "newTopic", summary: "架空の要約", content: "架空の記憶", keywords: ["架空"], types: ["conversation"], confidence: 0.9 };
type Past = { id: string; ago: number; words: string; diary?: "today" | "yesterday" };
type Device = { openai?: boolean };
type Reply = { status?: number; hold?: Promise<void> };
const DIARY_TEXT = "架空の朝に架空の公園を歩き、夜は架空の本を読んだ。";

/** a device in normal use (a real OPFS Vault with its Registry baseline), with automatic Memory creation turned on and a fictional key of its own */
async function seed(page: Page, past: Past[] = [], device: Device = {}) {
  // the automatic run starts 5 s after a start; here 2 s
  await page.addInitScript(() => { const later = window.setTimeout; window.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => later(fn, ms === 5000 ? 2000 : ms, ...rest)) as any; });
  await page.goto(`${BASE}/data`);
  await page.addScriptTag({ path: bundle });
  await page.evaluate(async ({ past, device }) => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const OLDEST = new Date(Date.now() - 86_400_000 * 500).toISOString();
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    await dbm.saveAutoCaptureSettingsRaw(JSON.stringify({ enabled: true, allowOtherProviders: true }));
    await dbm.saveApiKey("fictional-test-key", "gemini");
    if (device.openai) { await dbm.saveApiKey("fictional-openai-key", "openai"); await dbm.saveChatProvider("openai"); }
    // the diary day, as the app counts it: local time, a new day from 4:00
    const dayOf = (at: Date) => { const d = new Date(at.getFullYear(), at.getMonth(), at.getDate() - (at.getHours() < 4 ? 1 : 0), 12); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    for (const c of past) {
      const T = new Date(Date.now() - c.ago).toISOString();
      const date = c.diary === "today" ? dayOf(new Date()) : c.diary === "yesterday" ? dayOf(new Date(Date.now() - 86_400_000)) : undefined;
      await dbm.putConversationWithOutbox({ id: c.id, persona: "companion", entryType: "diary", status: "active", startedAt: T, createdAt: T, updatedAt: T, memoryObjectIds: [], chatProviders: ["gemini"],
        turns: [{ role: "user", content: c.words, timestamp: T }, { role: "ai", content: "架空の返答です。", timestamp: T }], ...(date ? { realtimeDiary: { date } } : {}),
        metadata: { id: `meta-${c.id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    }
    await bootstrap.runSaveFoundationBootstrap({ root });
    const d = await root.getDirectoryHandle(".tsumugi", { create: true });
    const w = await (await d.getFileHandle("registry-meta.json", { create: true })).createWritable();
    await w.write(JSON.stringify({ schemaVersion: 1, updatedAt: OLDEST, lastFullResyncAt: null, baselineEstablishedAt: OLDEST })); await w.close();
  }, { past, device });
}

/** fictional AI that records every call. `captureReplies` / `diaryReplies` answer the next calls in turn (then a normal answer) */
async function fakeApi(page: Page, captureReplies: Reply[] = [], diaryReplies: Reply[] = []) {
  const calls = { chat: 0, capture: [] as string[], reflect: 0, other: [] as string[], diary: [] as { ai?: string; gemini?: string; openai?: string; words: string }[] };
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/chat")) {
      calls.chat++;
      await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "架空の返答です。" });
    } else if (url.includes("/api/capture")) {
      calls.capture.push((JSON.parse(route.request().postData() ?? "{}").turns ?? []).map((t: any) => t.content).join(" "));
      const r = captureReplies.shift() ?? {};
      if (r.hold) await r.hold;
      await route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.status ? { error: "fictional" } : { memories: [MEMORY] }) }).catch(() => undefined);
    } else if (url.includes("/api/diary")) {
      const h = route.request().headers();
      calls.diary.push({ ai: h["x-ai-provider"], gemini: h["x-gemini-api-key"], openai: h["x-openai-api-key"], words: (JSON.parse(route.request().postData() ?? "{}").turns ?? []).map((t: any) => t.content).join(" ") });
      const r = diaryReplies.shift() ?? {};
      if (r.hold) await r.hold;
      await route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.status ? { error: "fictional" } : { diary: DIARY_TEXT, title: "架空の一日" }) }).catch(() => undefined);
    } else if (url.includes("/api/reflect")) {
      calls.reflect++;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title: "架空の題", reflection: "架空の振り返りです。" }) });
    } else {
      if (!url.includes("/api/build")) calls.other.push(new URL(url).pathname);
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    }
  });
  return calls;
}

async function startApp(page: Page) {
  await page.goto(BASE);
  await page.getByRole("button", { name: "tsumugiを開く" }).click({ timeout: 60_000 });
  await expect(page.getByText("今日は、どう話そう？")).toBeVisible({ timeout: 60_000 });
}
async function talk(page: Page, words: string, replies: number) {
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
const withWords = async (page: Page, words: string) => (await rows(page, "conversations")).filter((c) => c.turns.some((t: any) => t.content === words));
const filesWith = (page: Page, needle: string) => page.evaluate(async (text) => {
  const found: string[] = [];
  const readFile = async (h: any): Promise<string> => { for (let i = 0; ; i++) { try { return await (await h.getFile()).text(); } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 300)); } } };
  const walk = async (d: any): Promise<void> => { for await (const [name, h] of d.entries()) { if (h.kind === "directory") await walk(h); else if (name.endsWith(".md")) { const t = await readFile(h); if (t.includes(text)) found.push(t); } } };
  await walk(await navigator.storage.getDirectory());
  return found;
}, needle);
const todayDiaryDate = (page: Page) => page.evaluate(() => { const at = new Date(); const d = new Date(at.getFullYear(), at.getMonth(), at.getDate() - (at.getHours() < 4 ? 1 : 0), 12); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
const homeButton = (page: Page) => page.getByRole("button", { name: /ホームへ戻る|トップ画面へ戻る/ }).first();
const startButton = (page: Page) => page.getByRole("button", { name: "リアルタイム日記を始める" });
const continueButton = (page: Page) => page.getByRole("button", { name: "今日の続きを書く" });

test.describe("realtime diary: one conversation for the day, paused and resumed", () => {
  test("start, pause, resume and pause again: one conversation, every word and reply shown again, no Memory and nothing sent to the AI but the chat", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    // the normal diary and the conversation are still there, next to the new entry
    await expect(page.getByRole("button", { name: "日記", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "会話", exact: true })).toBeVisible();
    await startButton(page).click();
    await talk(page, "架空の朝の出来事です", 1);
    await expect(page.getByTestId("diary-time")).toHaveCount(1);
    await expect(page.getByTestId("diary-time")).toHaveText(/^(\d{1,2}\/\d{1,2} )?\d{1,2}:\d{2}$/);
    // the normal diary's end is not offered here; the pause is
    await expect(page.getByRole("button", { name: "本日はここまで" })).toHaveCount(0);
    await page.getByRole("button", { name: "一時保存して閉じる" }).click();
    await expect(continueButton(page)).toBeVisible({ timeout: 30_000 });
    await expect(startButton(page)).toHaveCount(0);

    // reopen: the morning words and the reply are back, and the next words go into the same conversation
    await continueButton(page).click();
    await expect(page.getByText("架空の朝の出来事です")).toBeVisible();
    await expect(page.getByText("架空の返答です。")).toHaveCount(1);
    await talk(page, "架空の昼の出来事です", 2);
    // the header's home button pauses it too
    await homeButton(page).click();
    await expect(continueButton(page)).toBeVisible({ timeout: 30_000 });

    const [diary] = await withWords(page, "架空の朝の出来事です");
    expect((await withWords(page, "架空の昼の出来事です")).map((c) => c.id)).toEqual([diary.id]);
    expect(diary.turns.map((t: any) => t.content)).toEqual(["架空の朝の出来事です", "架空の返答です。", "架空の昼の出来事です", "架空の返答です。"]);
    expect(diary.realtimeDiary).toEqual({ date: await todayDiaryDate(page) });
    expect(diary.status).toBe("active");
    expect(diary.endedAt).toBeUndefined();
    expect(diary.memoryObjectIds).toEqual([]);
    expect((await rows(page, "memoryObjects")).filter((m) => m.conversationId === diary.id)).toEqual([]);
    // the Vault file carries the diary day apart from the times of the words
    await expect.poll(async () => (await filesWith(page, "架空の昼の出来事です")).length, { timeout: 30_000 }).toBe(1);
    const [file] = await filesWith(page, "架空の昼の出来事です");
    expect(file).toMatch(new RegExp(`^diaryDate: "?${await todayDiaryDate(page)}"?$`, "m"));

    // after a reload the entry still offers the same diary
    await page.reload();
    await page.getByRole("button", { name: "tsumugiを開く" }).click({ timeout: 60_000 });
    await expect(continueButton(page)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(6_000);
    expect(calls.capture).toEqual([]);
    expect(calls.reflect).toBe(0);
    expect(calls.chat).toBe(2);
  });

  test("the normal diary is unchanged: 本日はここまで is offered, and going home still makes its Memory", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    await page.getByRole("button", { name: "日記", exact: true }).click();
    await talk(page, "架空のふつうの日記です", 1);
    await expect(page.getByRole("button", { name: "本日はここまで" })).toBeVisible();
    await expect(page.getByRole("button", { name: "一時保存して閉じる" })).toHaveCount(0);
    await expect(page.getByTestId("diary-time")).toHaveCount(0);
    await homeButton(page).click();
    await expect.poll(() => calls.capture.length, { timeout: 30_000 }).toBe(1);
    expect(calls.capture[0]).toContain("架空のふつうの日記です");
    await expect(startButton(page)).toBeVisible();
  });

  test("a paused diary is never taken by the automatic run at a start, while an old normal conversation is", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [
      { id: "rt-today", ago: 120 * MIN, words: "架空の書きかけの日記です", diary: "today" },
      { id: "rt-yesterday", ago: 26 * 60 * MIN, words: "架空の昨日の書きかけです", diary: "yesterday" },
      { id: "plain", ago: 180 * MIN, words: "架空のふつうの会話です" },
    ]);
    const calls = await fakeApi(page);
    await startApp(page);
    await expect.poll(() => calls.capture.length, { timeout: 30_000 }).toBe(1);
    expect(calls.capture[0]).toContain("架空のふつうの会話です");
    // the next start: nothing left that it may take
    await page.reload();
    await page.getByRole("button", { name: "tsumugiを開く" }).click({ timeout: 60_000 });
    await expect(page.getByText("今日は、どう話そう？")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(6_000);
    expect(calls.capture.length).toBe(1);
    for (const id of ["rt-today", "rt-yesterday"]) {
      const c = (await rows(page, "conversations")).find((x) => x.id === id);
      expect(c.status).toBe("active");
      expect(c.memoryObjectIds).toEqual([]);
    }
    // only today's diary is offered to continue; yesterday's waits for its own step (a later PR)
    await continueButton(page).click();
    await expect(page.getByText("架空の書きかけの日記です")).toBeVisible();
    await expect(page.getByText("架空の昨日の書きかけです")).toHaveCount(0);
    // words after a pause get a time; the reply does not
    await talk(page, "架空の夕方の出来事です", 2);
    await expect(page.getByTestId("diary-time")).toHaveCount(2);
    expect(calls.reflect).toBe(0);
  });
});

const finishButton = (page: Page) => page.getByRole("button", { name: "終了して日記を生成する" });
const againButton = (page: Page) => page.getByRole("button", { name: "もう一度仕上げる" });
const homeFinishButton = (page: Page) => page.getByTestId("unfinished-diary").getByRole("button", { name: "日記を仕上げる" });
const memoriesOf = async (page: Page, id: string) => (await rows(page, "memoryObjects")).filter((m) => m.conversationId === id);
const nav = (page: Page) => page.getByRole("navigation", { name: "メインナビゲーション" });
async function reopen(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: "tsumugiを開く" }).click({ timeout: 60_000 });
  await expect(page.getByText("今日は、どう話そう？")).toBeVisible({ timeout: 60_000 });
}
async function startDiary(page: Page) {
  await startButton(page).click();
  await talk(page, "架空の朝の出来事です", 1);
  await talk(page, "架空の夜の出来事です", 2);
  return (await withWords(page, "架空の朝の出来事です"))[0].id as string;
}

test.describe("realtime diary: 終了して日記を生成する", () => {
  test("ending writes one Memory with the existing Capture and one diary text, keeps the words, shows the text, and History shows it on its day", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    const id = await startDiary(page);
    await finishButton(page).click();
    await expect(page.getByTestId("realtime-diary-text")).toHaveText(DIARY_TEXT, { timeout: 30_000 });
    expect(calls.capture.length).toBe(1);
    expect(calls.diary.length).toBe(1);
    expect(calls.diary[0].words).toContain("架空の夜の出来事です");
    expect(calls.diary[0].ai).toBe("gemini");
    expect(calls.reflect).toBe(0);
    await expect(finishButton(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "一時保存して閉じる" })).toHaveCount(0);
    const stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.status).toBe("captured");
    expect(stored.endedAt).toBeTruthy();
    expect(stored.realtimeDiary.text).toBe(DIARY_TEXT);
    expect(stored.realtimeDiary.aiProvider).toBe("gemini");
    expect(stored.turns.map((t: any) => t.content)).toEqual(["架空の朝の出来事です", "架空の返答です。", "架空の夜の出来事です", "架空の返答です。"]);
    expect((await memoriesOf(page, id)).length).toBe(1);
    await expect.poll(async () => (await filesWith(page, DIARY_TEXT)).length, { timeout: 30_000 }).toBe(1);
    const [file] = await filesWith(page, DIARY_TEXT);
    expect(file.indexOf("## Diary")).toBeLessThan(file.indexOf("## Transcript"));
    // a finished diary is not resumed: the entry starts a new one, and nothing is left to finish
    await homeButton(page).click();
    await expect(startButton(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("unfinished-diary")).toHaveCount(0);
    // History: the diary on its day, with its text
    await nav(page).getByRole("button", { name: "これまでの記憶を見る" }).click();
    await page.getByRole("button", { name: /架空の朝の出来事です/ }).first().click({ timeout: 30_000 });
    await expect(page.getByTestId("history-realtime-diary")).toContainText(DIARY_TEXT);
    // nothing more was sent after the end
    await page.waitForTimeout(3_000);
    expect(calls.capture.length).toBe(1);
    expect(calls.diary.length).toBe(1);
  });

  test("Memory made but the text failed: the words and Memory stay, and only the text is written again (from the screen, and from home after a reload)", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page);
    const calls = await fakeApi(page, [], [{ status: 503 }, { status: 503 }]);
    await startApp(page);
    const id = await startDiary(page);
    await finishButton(page).click();
    await expect(page.getByText(/日記の本文をまだ作れていません。会話はすべて保存されています。/)).toBeVisible({ timeout: 30_000 });
    expect(calls.capture.length).toBe(1);
    await againButton(page).click();
    await expect(page.getByText(/日記の本文をまだ作れていません。/)).toBeVisible({ timeout: 30_000 });
    expect(calls.diary.length).toBe(2);
    let stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.status).toBe("captured");
    expect(stored.realtimeDiary.text).toBeUndefined();
    expect(stored.turns.length).toBe(4);
    // closed and opened again: home offers to finish it; only the text is written
    await reopen(page);
    await homeFinishButton(page).click();
    await expect(page.getByTestId("realtime-diary-text")).toHaveText(DIARY_TEXT, { timeout: 30_000 });
    expect(calls.capture.length).toBe(1);
    expect(calls.diary.length).toBe(3);
    stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.realtimeDiary.text).toBe(DIARY_TEXT);
    expect((await memoriesOf(page, id)).length).toBe(1);
  });

  test("the text written but the Memory failed: only the Memory is made again, the text is not written twice", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page);
    const calls = await fakeApi(page, [{ status: 503 }]);
    await startApp(page);
    const id = await startDiary(page);
    await finishButton(page).click();
    await expect(page.getByTestId("realtime-diary-text")).toHaveText(DIARY_TEXT, { timeout: 30_000 });
    await expect(page.getByText(/記憶をまだ作れていません。会話はすべて保存されています。/)).toBeVisible();
    expect((await memoriesOf(page, id)).length).toBe(0);
    await againButton(page).click();
    // the button hides while it works: wait for the stored result, not for the button
    await expect.poll(async () => (await rows(page, "conversations")).find((c) => c.id === id).status, { timeout: 30_000 }).toBe("captured");
    await expect(againButton(page)).toHaveCount(0, { timeout: 30_000 });
    expect(calls.capture.length).toBe(2);
    expect(calls.diary.length).toBe(1);
    const stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.status).toBe("captured");
    expect(stored.realtimeDiary.text).toBe(DIARY_TEXT);
    expect((await memoriesOf(page, id)).length).toBe(1);
  });

  test("closed while the AI was writing: nothing is lost, home offers to finish it, and pressing twice makes one text and one Memory", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page);
    let release = () => {};
    const calls = await fakeApi(page, [], [{ hold: new Promise<void>((r) => { release = r; }) }]);
    await startApp(page);
    const id = await startDiary(page);
    await finishButton(page).click();
    await expect.poll(() => calls.diary.length, { timeout: 30_000 }).toBe(1);
    await reopen(page);
    release();
    let stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.turns.length).toBe(4);
    expect(stored.endedAt).toBeTruthy();
    expect(stored.realtimeDiary.text).toBeUndefined();
    await expect(homeFinishButton(page)).toBeVisible({ timeout: 30_000 });
    await homeFinishButton(page).click();
    await finishButton(page).click({ timeout: 1_000 }).catch(() => undefined);   // not offered for an ended diary
    await expect(page.getByTestId("realtime-diary-text")).toHaveText(DIARY_TEXT, { timeout: 30_000 });
    await expect(againButton(page)).toHaveCount(0);
    await page.waitForTimeout(2_000);
    expect(calls.capture.length).toBe(1);
    expect(calls.diary.length).toBe(2);
    stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.realtimeDiary.text).toBe(DIARY_TEXT);
    expect((await memoriesOf(page, id)).length).toBe(1);
  });

  test("OpenAI chosen: the diary text and the Memory go to OpenAI with its key only", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [], { openai: true });
    const calls = await fakeApi(page);
    await startApp(page);
    const id = await startDiary(page);
    await finishButton(page).click();
    await expect(page.getByTestId("realtime-diary-text")).toHaveText(DIARY_TEXT, { timeout: 30_000 });
    expect(calls.diary).toEqual([expect.objectContaining({ ai: "openai", openai: "fictional-openai-key", gemini: undefined })]);
    const stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.realtimeDiary.aiProvider).toBe("openai");
  });
});
