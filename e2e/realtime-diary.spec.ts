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
type Device = { openai?: boolean; autoFinish?: boolean; openaiWithoutKey?: boolean };
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
    // PR-C: OpenAI chosen, but only the Gemini key registered
    if (device.openaiWithoutKey) await dbm.saveChatProvider("openai");
    if (device.autoFinish) await dbm.saveRealtimeDiaryAutoSettingsRaw(JSON.stringify({ enabled: true }));
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
async function fakeApi(page: Page, captureReplies: Reply[] = [], diaryReplies: Reply[] = [], chatReplies: Reply[] = []) {
  const calls = { chatModes: [] as (string | undefined)[], chat: 0, capture: [] as string[], reflect: 0, other: [] as string[], diary: [] as { ai?: string; gemini?: string; openai?: string; words: string }[] };
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/chat")) {
      calls.chat++;
      calls.chatModes.push(JSON.parse(route.request().postData() ?? "{}").conversationVoiceMode);
      const r = chatReplies.shift() ?? {};
      if (r.hold) await r.hold;
      await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "架空の返答です。" }).catch(() => undefined);
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
    // only today's diary is offered to continue; yesterday's waits to be finished (PR-C: the automatic finishing is off here, so nothing was sent)
    await expect(page.getByTestId("unfinished-diary").getByRole("button", { name: "昨日の日記を仕上げる" })).toBeVisible();
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
    // History opens on today in JST, the diary day is the device's (UTC on CI, 4:00 boundary): 06:00 UTC = 15:00 JST is the same day for both, so the run does not depend on the hour
    await page.clock.install({ time: new Date("2026-11-07T06:00:00Z") });
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

  test("finished meanwhile by another tab: the stale screen does not overwrite the stored text and Memory, and nothing is sent again", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    const id = await startDiary(page);
    // another tab finished the same diary: its end, Memory reference and text are in the stored record, the screen here still shows it open
    const OTHER = "別のタブが書いた架空の日記。";
    await page.evaluate(async ({ id, OTHER }) => {
      const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise<void>((res, rej) => {
        const tx = db.transaction("conversations", "readwrite"); const store = tx.objectStore("conversations"); const q = store.get(id);
        q.onsuccess = () => { const now = new Date().toISOString(); store.put({ ...q.result, endedAt: now, updatedAt: now, status: "captured", memoryObjectIds: ["mem-other-tab"], realtimeDiary: { ...q.result.realtimeDiary, text: OTHER, writtenAt: now, aiProvider: "gemini" } }); };
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    }, { id, OTHER });
    await finishButton(page).click();
    await expect(page.getByTestId("realtime-diary-text")).toHaveText(OTHER, { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    expect(calls.capture.length).toBe(0);
    expect(calls.diary.length).toBe(0);
    const stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.status).toBe("captured");
    expect(stored.memoryObjectIds).toEqual(["mem-other-tab"]);
    expect(stored.realtimeDiary.text).toBe(OTHER);
    expect(stored.turns.length).toBe(4);
  });

  test("finished by another tab, then words sent from the stale screen: the finished diary stays as it is, the words start a new diary", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    const id = await startDiary(page);
    const OTHER = "別のタブが書いた架空の日記。";
    await page.evaluate(async ({ id, OTHER }) => {
      const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise<void>((res, rej) => {
        const tx = db.transaction("conversations", "readwrite"); const store = tx.objectStore("conversations"); const q = store.get(id);
        q.onsuccess = () => { const now = new Date().toISOString(); store.put({ ...q.result, endedAt: now, updatedAt: now, status: "captured", memoryObjectIds: ["mem-other-tab"], realtimeDiary: { ...q.result.realtimeDiary, text: OTHER, writtenAt: now, aiProvider: "gemini" } }); };
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    }, { id, OTHER });
    await talk(page, "架空の続きの言葉です", 1);
    const stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.endedAt).toBeTruthy();
    expect(stored.status).toBe("captured");
    expect(stored.memoryObjectIds).toEqual(["mem-other-tab"]);
    expect(stored.realtimeDiary.text).toBe(OTHER);
    expect(stored.turns.length).toBe(4);
    const [next] = await withWords(page, "架空の続きの言葉です");
    expect(next.id).not.toBe(id);
    expect(next.realtimeDiary.date).toBeTruthy();
    expect(next.endedAt).toBeUndefined();
    await page.waitForTimeout(2_000);
    expect(calls.capture.length).toBe(0);
    expect(calls.diary.length).toBe(0);
  });

  test("the Vault file edited outside the app: no Memory and no text from the words before the edit, the words and the file stay", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    const id = await startDiary(page);
    await expect.poll(async () => (await filesWith(page, "架空の夜の出来事です")).length, { timeout: 30_000 }).toBe(1);
    // edit the words in the file, as another app would
    await page.evaluate(async () => {
      const walk = async (d: any): Promise<any> => { for await (const [name, h] of d.entries()) { if (h.kind === "directory") { const f = await walk(h); if (f) return f; } else if (name.endsWith(".md") && (await (await h.getFile()).text()).includes("架空の夜の出来事です")) return h; } };
      const h = await walk(await navigator.storage.getDirectory());
      const text = (await (await h.getFile()).text()).replace("架空の夜の出来事です", "外部で書き換えた架空の夜です");
      const w = await h.createWritable(); await w.write(text); await w.close();
    });
    await finishButton(page).click();
    await expect(page.getByText(/保存先のファイルが外部で変更されていたため、日記を仕上げませんでした。/)).toBeVisible({ timeout: 30_000 });
    expect(calls.capture.length).toBe(0);
    expect(calls.diary.length).toBe(0);
    const stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.endedAt).toBeTruthy();
    expect(stored.realtimeDiary.text).toBeUndefined();
    expect(stored.turns.map((t: any) => t.content)).toContain("架空の夜の出来事です");
    expect((await memoriesOf(page, id)).length).toBe(0);
    expect((await filesWith(page, "外部で書き換えた架空の夜です")).length).toBe(1);
  });

  test("the words changed while the AI was writing (an edit taken in): the text from the old words is not added, the new words stay", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page);
    let release = () => {};
    const calls = await fakeApi(page, [], [{ hold: new Promise<void>((r) => { release = r; }) }]);
    await startApp(page);
    const id = await startDiary(page);
    await finishButton(page).click();
    await expect.poll(() => calls.diary.length, { timeout: 30_000 }).toBe(1);
    // the stored words change while the text is being written
    await page.evaluate(async (id) => {
      const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise<void>((res, rej) => {
        const tx = db.transaction("conversations", "readwrite"); const store = tx.objectStore("conversations"); const q = store.get(id);
        q.onsuccess = () => store.put({ ...q.result, turns: q.result.turns.map((t: any) => (t.content === "架空の夜の出来事です" ? { ...t, content: "取り込んだ架空の夜です" } : t)) });
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    }, id);
    release();
    await expect(page.getByText(/保存先のファイルが外部で変更されていたため、日記を仕上げませんでした。/)).toBeVisible({ timeout: 30_000 });
    const stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.realtimeDiary.text).toBeUndefined();
    expect(stored.turns.map((t: any) => t.content)).toContain("取り込んだ架空の夜です");
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

// ---------------------------------------------------------------------------
// PR-C: the 4:00 day change and the finishing of past diaries. The clock is set with page.clock; the time zones are not the CI machine's.
// ---------------------------------------------------------------------------
const sendWords = async (page: Page, words: string) => {
  await page.locator("footer textarea").fill(words);
  await page.locator("footer").getByRole("button", { name: "送る" }).click();
};
const stored = async (page: Page, id: string) => (await rows(page, "conversations")).find((c) => c.id === id);

test.describe("realtime diary PR-C: crossing 4:00 in New York at the end of the year", () => {
  test.use({ timezoneId: "America/New_York" });
  test("a reply in progress at 4:00 stays in its diary; new words after 4:00 are held with a notice, the typed text is kept, and the switch closes the old diary and starts the new day", async ({ page }) => {
    test.setTimeout(300_000);
    await page.clock.install({ time: new Date("2027-01-01T03:40:00-05:00") });
    await seed(page);
    let release = () => {};
    const calls = await fakeApi(page, [], [], [{}, { hold: new Promise<void>((r) => { release = r; }) }]);
    await startApp(page);
    await startButton(page).click();
    await talk(page, "架空の大晦日の出来事です", 1);
    const [old] = await withWords(page, "架空の大晦日の出来事です");
    expect(old.realtimeDiary).toEqual({ date: "2026-12-31" });
    // the AI is still answering when 4:00 passes: the reply is not cut and stays in the old diary
    await sendWords(page, "架空の夜更けの出来事です");
    await expect.poll(() => calls.chat, { timeout: 30_000 }).toBe(2);
    await page.clock.fastForward("30:00");
    release();
    await expect(page.getByText("架空の返答です。")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator("footer textarea")).toBeEnabled();
    const before = await stored(page, old.id);
    expect(before.turns.map((t: any) => t.content)).toEqual(["架空の大晦日の出来事です", "架空の返答です。", "架空の夜更けの出来事です", "架空の返答です。"]);
    expect(before.realtimeDiary.date).toBe("2026-12-31");

    // 4:10: new words are not sent and not moved; the notice offers the switch and the typed text stays
    await sendWords(page, "架空の元日の出来事です");
    await expect(page.getByTestId("diary-day-change")).toContainText("12月31日の日記はここで締め切り、1月1日の日記として続けます");
    await expect(page.locator("footer textarea")).toHaveValue("架空の元日の出来事です");
    await page.waitForTimeout(1_000);
    expect(calls.chat).toBe(2);
    expect((await stored(page, old.id)).turns).toEqual(before.turns);
    expect((await stored(page, old.id)).endedAt).toBeUndefined();

    await page.getByRole("button", { name: "1月1日の日記へ切り替える" }).click();
    await expect(page.getByTestId("diary-day-change")).toHaveCount(0);
    await expect(page.getByText("架空の大晦日の出来事です")).toHaveCount(0);
    await expect(page.locator("footer textarea")).toHaveValue("架空の元日の出来事です");
    await page.locator("footer").getByRole("button", { name: "送る" }).click();
    await expect(page.getByText("架空の返答です。")).toHaveCount(1, { timeout: 30_000 });
    const [fresh] = await withWords(page, "架空の元日の出来事です");
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.realtimeDiary).toEqual({ date: "2027-01-01" });
    // the old diary is closed as it was: every word and its real time kept, nothing sent (the automatic finishing is off)
    const closed = await stored(page, old.id);
    expect(closed.endedAt).toBeTruthy();
    expect(closed.turns).toEqual(before.turns);
    expect(closed.realtimeDiary.date).toBe("2026-12-31");
    await page.waitForTimeout(3_000);
    expect(calls.diary.length).toBe(0);
    expect(calls.capture.length).toBe(0);

    // home: today's diary goes on, yesterday's waits; finishing it writes from the old day's words only
    await homeButton(page).click();
    await expect(continueButton(page)).toBeVisible({ timeout: 30_000 });
    const waiting = page.getByTestId("unfinished-diary");
    await expect(waiting).toContainText("12月31日");
    await waiting.getByRole("button", { name: "昨日の日記を仕上げる" }).click();
    await expect(page.getByTestId("realtime-diary-text")).toHaveText(DIARY_TEXT, { timeout: 30_000 });
    expect(calls.diary.length).toBe(1);
    expect(calls.diary[0].words).toContain("架空の夜更けの出来事です");
    expect(calls.diary[0].words).not.toContain("架空の元日の出来事です");
    expect(calls.capture.length).toBe(1);
    expect((await memoriesOf(page, old.id)).length).toBe(1);
    expect((await memoriesOf(page, fresh.id)).length).toBe(0);
    expect((await stored(page, fresh.id)).endedAt).toBeUndefined();
  });
});

test.describe("realtime diary PR-C: closed overnight in Auckland at the end of a month", () => {
  test.use({ timezoneId: "Pacific/Auckland" });
  test("with the permission: the next start finishes yesterday's diary with the chosen AI and the user's own key, once; the conversation Capture does not take it too", async ({ page }) => {
    test.setTimeout(240_000);
    await page.clock.install({ time: new Date("2026-12-01T09:00:00+13:00") });
    await seed(page, [{ id: "rt-november", ago: 11 * 60 * MIN, words: "架空の月末の出来事です", diary: "yesterday" }], { autoFinish: true });
    const calls = await fakeApi(page);
    await startApp(page);
    await expect.poll(async () => (await stored(page, "rt-november")).realtimeDiary.text, { timeout: 60_000 }).toBe(DIARY_TEXT);
    const done = await stored(page, "rt-november");
    expect(done.realtimeDiary.date).toBe("2026-11-30");
    expect(done.status).toBe("captured");
    expect(done.endedAt).toBeTruthy();
    expect(done.turns.map((t: any) => t.content)).toEqual(["架空の月末の出来事です", "架空の返答です。"]);
    expect(calls.diary.length).toBe(1);
    expect(calls.diary[0].ai).toBe("gemini");
    expect(calls.diary[0].gemini).toBe("fictional-test-key");
    expect(calls.capture.length).toBe(1);
    expect((await memoriesOf(page, "rt-november")).length).toBe(1);
    await expect(page.getByTestId("unfinished-diary")).toHaveCount(0, { timeout: 30_000 });
    // the next start sends nothing again
    await reopen(page);
    await page.waitForTimeout(6_000);
    expect(calls.diary.length).toBe(1);
    expect(calls.capture.length).toBe(1);
    expect((await memoriesOf(page, "rt-november")).length).toBe(1);
  });

  test("without the permission nothing is sent at a start (even with the automatic Memory creation on); home offers 昨日の日記を仕上げる and today's diary can be started", async ({ page }) => {
    test.setTimeout(180_000);
    await page.clock.install({ time: new Date("2026-12-01T09:00:00+13:00") });
    await seed(page, [{ id: "rt-november", ago: 11 * 60 * MIN, words: "架空の月末の出来事です", diary: "yesterday" }]);
    const calls = await fakeApi(page);
    await startApp(page);
    await expect(page.getByTestId("unfinished-diary").getByRole("button", { name: "昨日の日記を仕上げる" })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(6_000);
    expect(calls.diary.length).toBe(0);
    expect(calls.capture.length).toBe(0);
    expect((await stored(page, "rt-november")).endedAt).toBeUndefined();
    await startButton(page).click();
    await talk(page, "架空の師走の出来事です", 1);
    const [december] = await withWords(page, "架空の師走の出来事です");
    expect(december.id).not.toBe("rt-november");
    expect(december.realtimeDiary).toEqual({ date: "2026-12-01" });
    const november = await stored(page, "rt-november");
    expect(november.turns.map((t: any) => t.content)).toEqual(["架空の月末の出来事です", "架空の返答です。"]);
    expect(november.endedAt).toBeUndefined();
  });

  test("with the permission but no key of the chosen AI: nothing is sent and nothing goes to the other AI; the diary keeps waiting", async ({ page }) => {
    test.setTimeout(180_000);
    await page.clock.install({ time: new Date("2026-12-01T09:00:00+13:00") });
    await seed(page, [{ id: "rt-november", ago: 11 * 60 * MIN, words: "架空の月末の出来事です", diary: "yesterday" }], { autoFinish: true, openaiWithoutKey: true });
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(6_000);
    expect(calls.diary.length).toBe(0);
    expect(calls.capture.length).toBe(0);
    const november = await stored(page, "rt-november");
    expect(november.endedAt).toBeUndefined();
    expect(november.turns.length).toBe(2);
    await expect(page.getByTestId("unfinished-diary").getByRole("button", { name: "昨日の日記を仕上げる" })).toBeVisible();
  });

  test("the app closed while the automatic finishing was writing: nothing is lost, and the next start finishes it with one Memory and one text", async ({ page }) => {
    test.setTimeout(240_000);
    await page.clock.install({ time: new Date("2026-12-01T09:00:00+13:00") });
    await seed(page, [{ id: "rt-november", ago: 11 * 60 * MIN, words: "架空の月末の出来事です", diary: "yesterday" }], { autoFinish: true });
    let release = () => {};
    const calls = await fakeApi(page, [], [{ hold: new Promise<void>((r) => { release = r; }) }]);
    await startApp(page);
    await expect.poll(() => calls.diary.length, { timeout: 60_000 }).toBe(1);
    await reopen(page);
    release();
    await expect.poll(async () => (await stored(page, "rt-november")).realtimeDiary.text, { timeout: 60_000 }).toBe(DIARY_TEXT);
    const done = await stored(page, "rt-november");
    expect(done.status).toBe("captured");
    expect(done.turns.map((t: any) => t.content)).toEqual(["架空の月末の出来事です", "架空の返答です。"]);
    expect(calls.capture.length).toBe(1);
    expect(calls.diary.length).toBe(2);
    expect((await memoriesOf(page, "rt-november")).length).toBe(1);
  });
});

test.describe("realtime diary: the same diary written on in two tabs", () => {
  test("words added by another tab are kept: the stale screen continues from the stored diary instead of writing its old copy over it", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page);
    await fakeApi(page);
    await startApp(page);
    await startButton(page).click();
    await talk(page, "架空の朝の出来事です", 1);
    const [diary] = await withWords(page, "架空の朝の出来事です");
    // another tab added words and a reply to the same diary; this screen still shows the morning only
    await page.evaluate(async (id) => {
      const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise<void>((res, rej) => {
        const tx = db.transaction("conversations", "readwrite"); const store = tx.objectStore("conversations"); const q = store.get(id);
        q.onsuccess = () => { const now = new Date().toISOString(); store.put({ ...q.result, updatedAt: now, turns: [...q.result.turns, { role: "user", content: "別のタブの架空の昼の出来事です", timestamp: now }, { role: "ai", content: "別タブからの返答。", timestamp: now }] }); };
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    }, diary.id);
    await talk(page, "架空の夜の出来事です", 2);
    const [after] = await withWords(page, "架空の夜の出来事です");
    expect(after.id).toBe(diary.id);
    expect(after.turns.map((t: any) => t.content)).toEqual(["架空の朝の出来事です", "架空の返答です。", "別のタブの架空の昼の出来事です", "別タブからの返答。", "架空の夜の出来事です", "架空の返答です。"]);
    await expect(page.getByText("別のタブの架空の昼の出来事です")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Before the integration (owner 2026-11-08): the realtime diary's own reply style, and History in the device's time zone
// ---------------------------------------------------------------------------
test.describe("realtime diary: its own reply style", () => {
  test("only the realtime diary asks for its reply style; the normal diary and the conversation do not", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    await startButton(page).click();
    await talk(page, "架空の朝の出来事です", 1);
    await talk(page, "架空の昼の出来事です", 2);
    await homeButton(page).click();
    await expect(continueButton(page)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "日記", exact: true }).click();
    await talk(page, "架空のふつうの日記です", 1);
    await homeButton(page).click();
    await expect(page.getByText("今日は、どう話そう？")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await talk(page, "架空の相談です", 1);
    expect(calls.chatModes).toEqual(["realtime-diary", "realtime-diary", undefined, undefined]);
  });
});

test.describe("realtime diary: History in New York", () => {
  test.use({ timezoneId: "America/New_York" });
  test("a diary written on the evening of 31 December in New York is on 31 December in the calendar, at its local time, while it is already 1 January in Japan", async ({ page }) => {
    test.setTimeout(240_000);
    await page.clock.install({ time: new Date("2026-12-31T20:00:00-05:00") });
    await seed(page);
    await fakeApi(page);
    await startApp(page);
    await startButton(page).click();
    await talk(page, "架空の大晦日の夜の出来事です", 1);
    await finishButton(page).click();
    await expect(page.getByTestId("realtime-diary-text")).toHaveText(DIARY_TEXT, { timeout: 30_000 });
    await nav(page).getByRole("button", { name: "これまでの記憶を見る" }).click();
    // History opens on today in Japan (1 January 2027); the diary is on its own day
    await expect(page.getByText("2027年1月", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "前月" }).click();
    await expect(page.getByText("2026年12月", { exact: true }).first()).toBeVisible();
    const day31 = page.getByRole("button", { name: "31", exact: true });
    await expect(day31.locator("span").nth(1)).toHaveClass(/bg-stone-500/, { timeout: 30_000 });
    await day31.click();
    const card = page.getByRole("button", { name: /架空の大晦日の夜の出来事です/ }).first();
    await expect(card).toContainText("20:00", { timeout: 30_000 });
    await card.click();
    await expect(page.getByText("2026-12-31・20:00")).toBeVisible();
    await expect(page.getByTestId("history-realtime-diary")).toContainText("12月31日");
    await expect(page.getByTestId("history-realtime-diary")).toContainText(DIARY_TEXT);
    // nothing on 1 January
    await page.getByRole("button", { name: "翌月" }).click();
    await expect(page.getByRole("button", { name: "1", exact: true }).first().locator("span").nth(1)).not.toHaveClass(/bg-stone-500/);
  });
});
