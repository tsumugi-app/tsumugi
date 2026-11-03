/* eslint-disable @typescript-eslint/no-explicit-any */
// An AI reply that ends with no words is not a turn of the conversation. The user's message stays, the screen says what happened, and the same message can be tried again without
// anything being counted twice. Told apart from a failed request, a reply cut off on its way, and a normal reply. The AI is never called and every word here is fictional.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const LATEST = "✓ 最新の状態です";
const EMPTY_MESSAGE = "AIから応答を受け取れませんでした";
const CUT_MESSAGE = "応答が途中で止まりました";
const FAILED_MESSAGE = "メッセージの送信に失敗しました";
const AUTH_MESSAGE = "APIキーが無効または期限切れの可能性があります";
const SAID = "架空の話題です", REPLY = "架空の返答です。";
const BLANK_PAST = "blank-past-0001";

type Reply = { body?: string; status?: number; abort?: boolean; hold?: Promise<void> };

/** a device in normal use: a real OPFS Vault with its Registry baseline, and one fictional past conversation that holds blank AI turns from before this change */
async function seed(page: Page) {
  await page.addInitScript(() => {
    // a reply cut off on its way: the first words arrive, then the connection breaks (a fulfilled route cannot do this)
    const real = window.fetch.bind(window);
    window.fetch = (async (input: any, init: any) => {
      const w = window as any, url = String(input?.url ?? input);
      if (url.includes("/api/chat") && typeof w.__cutAfter === "string") {
        const words = w.__cutAfter; w.__cutAfter = undefined;
        (w.__cutBodies ??= []).push(init?.body);
        const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(words)); setTimeout(() => c.error(new TypeError("network error")), 50); } });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return real(input, init);
    }) as typeof window.fetch;
  });
  await page.goto(`${BASE}/data`);
  await page.addScriptTag({ path: bundle });
  await page.evaluate(async (id) => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const T = new Date(Date.now() - 86_400_000).toISOString();
    const meta = { id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T };
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
    await dbm.putConversationWithOutbox({ id, persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, memoryObjectIds: [], metadata: meta,
      turns: [{ role: "user", content: "昨日の架空の話", timestamp: T }, { role: "ai", content: "", timestamp: T }, { role: "user", content: "続きの架空の話", timestamp: T }, { role: "ai", content: "", timestamp: T }] });
    await bootstrap.runSaveFoundationBootstrap({ root });
    const d = await root.getDirectoryHandle(".tsumugi", { create: true });
    const w = await (await d.getFileHandle("registry-meta.json", { create: true })).createWritable();
    await w.write(JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: null, baselineEstablishedAt: T })); await w.close();
  }, BLANK_PAST);
}

/** fictional AI. `replies` are used in order; the chat bodies and Capture bodies are kept for the assertions. Capture answers one fictional Memory. */
async function fakeApi(page: Page, replies: Reply[]) {
  const chats: any[] = [], captures: any[] = [];
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/chat")) {
      chats.push(JSON.parse(route.request().postData() ?? "{}"));
      const r = replies.shift() ?? { body: REPLY };
      if (r.hold) await r.hold;
      if (r.abort) await route.abort("failed");
      else await route.fulfill({ status: r.status ?? 200, contentType: "text/plain; charset=utf-8", body: r.body ?? "" });
    } else if (url.includes("/api/capture")) {
      captures.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ memories: [{ topicDecision: "newTopic", summary: "架空の要約", content: "架空の記憶", keywords: ["架空"], types: ["conversation"], confidence: 0.9 }] }) });
    } else await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  return { chats, captures };
}

const nav = (page: Page) => page.getByRole("navigation", { name: "メインナビゲーション" });
const retryButton = (page: Page) => page.getByRole("button", { name: "もう一度試す" });
const conflicts = (page: Page) => page.getByTestId("vault-conflicts");
async function startApp(page: Page) {
  await page.goto(BASE);
  await page.getByRole("button", { name: "tsumugiを開く" }).click({ timeout: 60_000 });
  await expect(page.getByText("今日は、どう話そう？")).toBeVisible({ timeout: 60_000 });
}
async function openConversation(page: Page) { await startApp(page); await page.getByRole("button", { name: "会話", exact: true }).click(); }
async function send(page: Page, text: string) { await page.locator("footer textarea").fill(text); await page.locator("footer").getByRole("button", { name: "送る" }).click(); }
const allRows = (page: Page, store: string) => page.evaluate(async (s) => { const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const all: any[] = await new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); }); db.close(); return all; }, store);
/** the record of the conversation this test talks in */
const opened = async (page: Page) => (await allRows(page, "conversations")).find((c) => c.id !== BLANK_PAST && c.turns.length > 0);
const shape = (c: any) => c.turns.map((t: any) => [t.role, t.content]);
const memoriesOf = async (page: Page, id: string) => (await allRows(page, "memoryObjects")).filter((m) => m.conversationId === id);
/** the Markdown holding these words, wherever the app put it */
const fileWith = (page: Page, needle: string) => page.evaluate(async (text) => { const root = await navigator.storage.getDirectory(); const found: { path: string; text: string }[] = []; const walk = async (d: any, prefix: string): Promise<void> => { for await (const [name, h] of d.entries()) { if (h.kind === "directory") await walk(h, `${prefix}${name}/`); else { const t = await (await h.getFile()).text(); if (t.includes(text)) found.push({ path: `${prefix}${name}`, text: t }); } } }; await walk(await root.getDirectoryHandle("Conversations"), "Conversations/"); return found; }, needle);
const writeAt = (page: Page, p: string, text: string) => page.evaluate(async ([p, t]) => { const parts = p.split("/"); let d: any = await navigator.storage.getDirectory(); for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part); const w = await (await d.getFileHandle(parts[parts.length - 1])).createWritable(); await w.write(t); await w.close(); }, [p, text] as const);
const fileTurns = (text: string) => (text.match(/^\*\*(User|Tsumugi):\*\*/gm) ?? []).length;
const saved = (page: Page, needle: string, turns: number) => expect.poll(async () => { const f = await fileWith(page, needle); return f.length === 1 ? fileTurns(f[0].text) : -1; }, { timeout: 30_000 }).toBe(turns);
/** after a reload Settings says 最新, finds nothing to settle, and stays so after another check */
async function staysLatest(page: Page) {
  await startApp(page);
  await nav(page).getByRole("button", { name: "設定" }).click();
  await expect(page.getByText(LATEST)).toBeVisible({ timeout: 120_000 });
  await expect(conflicts(page)).toHaveCount(0);
  await page.getByTestId("vault-check-now").click();
  await expect(page.getByText(LATEST)).toBeVisible({ timeout: 120_000 });
  await expect(conflicts(page)).toHaveCount(0);
}

test.describe("an AI reply with no words", () => {
  test("empty reply → the screen says so → try again → a normal reply → saved → reload: one user turn, one AI turn, one Memory, and 最新", async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page);
    const { chats, captures } = await fakeApi(page, [{ body: "" }, { body: REPLY }]);
    await openConversation(page);
    await send(page, SAID);
    // the reply ended with no words
    await expect.soft(page.getByText(EMPTY_MESSAGE), "the screen says no reply came").toBeVisible({ timeout: 30_000 });
    await expect.soft(retryButton(page), "the message can be tried again").toBeVisible();
    await expect(page.locator("footer textarea")).toBeEnabled();
    await expect.poll(() => chats.length).toBe(1);
    await expect.poll(async () => shape(await opened(page)), { timeout: 10_000, message: "the blank reply is not a turn; the user's message stays" }).toEqual([["user", SAID]]);
    await saved(page, SAID, 1);
    expect(captures.length, "no Capture has run").toBe(0);
    // try again
    await retryButton(page).click();
    await expect(page.getByText(REPLY, { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText(EMPTY_MESSAGE)).toHaveCount(0);
    await expect(retryButton(page)).toHaveCount(0);
    await expect(page.getByText(SAID, { exact: true })).toHaveCount(1);
    expect(chats.length).toBe(2);
    expect(chats[1].turns.map((t: any) => [t.role, t.content]), "the AI gets the message once").toEqual([["user", SAID]]);
    await expect.poll(async () => shape(await opened(page))).toEqual([["user", SAID], ["ai", REPLY]]);
    await saved(page, SAID, 2);
    expect(captures.length, "trying again runs no Capture").toBe(0);
    const id = (await opened(page)).id;
    // ending the conversation makes one Memory from one message
    await page.getByRole("button", { name: "この会話を終える" }).click();
    await expect.poll(() => captures.length, { timeout: 30_000 }).toBe(1);
    expect(captures[0].turns.map((t: any) => [t.role, t.content]), "Capture sees each turn once").toEqual([["user", SAID], ["ai", REPLY]]);
    await expect.poll(async () => (await memoriesOf(page, id)).length, { timeout: 30_000 }).toBe(1);
    // reload: the same, in the record and in the file, and the state is clean
    await staysLatest(page);
    expect(shape(await opened(page))).toEqual([["user", SAID], ["ai", REPLY]]);
    await saved(page, SAID, 2);
    await staysLatest(page);
    expect(captures.length, "no start captures it again").toBe(1);
    expect((await memoriesOf(page, id)).length).toBe(1);
  });

  for (const [what, body] of [["only spaces and line breaks", " \n　\n "], ["only a time label", "[2026-09-21 19:30 JST]\n"]] as const) {
    test(`a reply of ${what} is no reply either, and empty replies in a row add nothing`, async ({ page }) => {
      test.setTimeout(120_000);
      await seed(page);
      const { chats } = await fakeApi(page, [{ body }, { body: "" }, { body }, { body: REPLY }]);
      await openConversation(page);
      await send(page, SAID);
      for (let i = 2; i <= 4; i++) {
        await expect.soft(page.getByText(EMPTY_MESSAGE)).toBeVisible({ timeout: 30_000 });
        await retryButton(page).click();
        await expect.poll(() => chats.length).toBe(i);
      }
      await expect(page.getByText(REPLY, { exact: true })).toHaveCount(1, { timeout: 30_000 });
      await expect.poll(async () => shape(await opened(page))).toEqual([["user", SAID], ["ai", REPLY]]);
      for (const c of chats) expect(c.turns.map((t: any) => t.content)).toEqual([SAID]);
    });
  }

  test("a failed request and a refused key are told apart from an empty reply, and the same message can be tried again from either", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page);
    const { chats } = await fakeApi(page, [{ abort: true }, { status: 502, body: "{}" }, { status: 401, body: "{}" }, { body: REPLY }]);
    await openConversation(page);
    await send(page, SAID);
    await expect(page.getByText(FAILED_MESSAGE)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(EMPTY_MESSAGE)).toHaveCount(0);
    await expect.poll(async () => shape(await opened(page))).toEqual([["user", SAID]]);
    await retryButton(page).click();
    await expect.poll(() => chats.length).toBe(2);
    await expect(page.getByText(FAILED_MESSAGE)).toBeVisible({ timeout: 30_000 });
    await retryButton(page).click();
    await expect(page.getByText(AUTH_MESSAGE)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(FAILED_MESSAGE)).toHaveCount(0);
    await retryButton(page).click();
    await expect(page.getByText(REPLY, { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText(AUTH_MESSAGE)).toHaveCount(0);
    await expect.poll(async () => shape(await opened(page))).toEqual([["user", SAID], ["ai", REPLY]]);
    await saved(page, SAID, 2);
    await staysLatest(page);
    expect(shape(await opened(page))).toEqual([["user", SAID], ["ai", REPLY]]);
  });

  test("a reply cut off on its way: the words that came stay, on the screen, in the record and in the file; trying again adds a reply and does not send the cut one as finished", async ({ page }) => {
    test.setTimeout(180_000);
    const PART = "架空の返答の途中まで", FULL = "架空の最後まで届いた返答です。";
    await seed(page);
    const { chats } = await fakeApi(page, [{ body: FULL }]);
    await openConversation(page);
    await page.evaluate((w) => { (window as any).__cutAfter = w; }, PART);
    await send(page, SAID);
    await expect.soft(page.getByText(CUT_MESSAGE), "the screen says it stopped").toBeVisible({ timeout: 30_000 });
    await expect.soft(page.getByText(PART, { exact: true }), "the words that came stay on the screen").toHaveCount(1);
    await expect.soft(page.getByText(EMPTY_MESSAGE)).toHaveCount(0);
    await expect.poll(async () => shape(await opened(page)), { timeout: 10_000, message: "the words that came stay in the record" }).toEqual([["user", SAID], ["ai", PART]]);
    await saved(page, SAID, 2);
    await retryButton(page).click();
    await expect(page.getByText(FULL, { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByText(CUT_MESSAGE)).toHaveCount(0);
    expect(chats[0].turns.map((t: any) => [t.role, t.content]), "the AI is asked again for the same message").toEqual([["user", SAID]]);
    const after = [["user", SAID], ["ai", PART], ["ai", FULL]];
    await expect.poll(async () => shape(await opened(page))).toEqual(after);
    await saved(page, SAID, 3);
    await staysLatest(page);
    expect(shape(await opened(page))).toEqual(after);
    await saved(page, SAID, 3);
  });

  test("a normal reply keeps its own white space; blank AI turns already in the history are left alone", async ({ page }) => {
    test.setTimeout(120_000);
    const SPACED = "  前後に空白がある架空の返答\n\n二段落目です  ";
    await seed(page);
    await fakeApi(page, [{ body: SPACED }]);
    await startApp(page);
    const before = (await fileWith(page, "昨日の架空の話"))[0];
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await send(page, SAID);
    await expect.poll(async () => shape(await opened(page))).toEqual([["user", SAID], ["ai", SPACED]]);
    await expect(retryButton(page)).toHaveCount(0);
    await expect(page.getByText(EMPTY_MESSAGE)).toHaveCount(0);
    await staysLatest(page);
    expect(shape(await opened(page))).toEqual([["user", SAID], ["ai", SPACED]]);
    const past = (await allRows(page, "conversations")).find((c) => c.id === BLANK_PAST);
    expect(past.turns.map((t: any) => t.content)).toEqual(["昨日の架空の話", "", "続きの架空の話", ""]);
    expect((await fileWith(page, "昨日の架空の話"))[0].text, "its file is not rewritten").toBe(before.text);
  });

  test("try again pressed twice asks once and adds one reply", async ({ page }) => {
    test.setTimeout(120_000);
    let open = () => {};
    const held = new Promise<void>((r) => { open = r; });
    await seed(page);
    const { chats } = await fakeApi(page, [{ body: "" }, { body: REPLY, hold: held }]);
    await openConversation(page);
    await send(page, SAID);
    await expect(retryButton(page)).toBeVisible({ timeout: 30_000 });
    await retryButton(page).dblclick();
    await expect.poll(() => chats.length).toBe(2);
    await expect(retryButton(page)).toHaveCount(0);
    await expect(page.locator("footer textarea")).toBeDisabled();
    open();
    await expect(page.getByText(REPLY, { exact: true })).toHaveCount(1, { timeout: 30_000 });
    expect(chats.length).toBe(2);
    await expect.poll(async () => shape(await opened(page))).toEqual([["user", SAID], ["ai", REPLY]]);
  });

  test("a new message instead of trying again: both messages stay, once each", async ({ page }) => {
    test.setTimeout(120_000);
    const NEXT = "架空の別の発言";
    await seed(page);
    const { chats } = await fakeApi(page, [{ body: "" }, { body: REPLY }]);
    await openConversation(page);
    await send(page, SAID);
    await expect(retryButton(page)).toBeVisible({ timeout: 30_000 });
    await send(page, NEXT);
    await expect(page.getByText(REPLY, { exact: true })).toHaveCount(1, { timeout: 30_000 });
    await expect(retryButton(page)).toHaveCount(0);
    expect(chats[1].turns.map((t: any) => t.content)).toEqual([SAID, NEXT]);
    await expect.poll(async () => shape(await opened(page))).toEqual([["user", SAID], ["user", NEXT], ["ai", REPLY]]);
    await saved(page, NEXT, 3);
    await staysLatest(page);
  });

  test("the message edited outside while it waits: 更新する shows the edit and trying again asks about the edited words, which are kept", async ({ page }) => {
    test.setTimeout(240_000);
    const EDITED = "架空の話題を外で直した";
    await seed(page);
    const { chats } = await fakeApi(page, [{ body: "" }, { body: REPLY }]);
    await startApp(page);
    await nav(page).getByRole("button", { name: "設定" }).click();
    await expect(page.getByText(LATEST)).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "閉じる", exact: true }).first().click();
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await send(page, SAID);
    await expect(retryButton(page)).toBeVisible({ timeout: 30_000 });
    await saved(page, SAID, 1);
    const f = (await fileWith(page, SAID))[0];
    await writeAt(page, f.path, f.text.replace(SAID, EDITED));
    await nav(page).getByRole("button", { name: "設定" }).click();
    const check = page.getByRole("button", { name: "確認する", exact: true }).first();
    await expect(check).toBeEnabled({ timeout: 60_000 }); await check.click();
    await page.getByRole("button", { name: "更新する", exact: true }).click({ timeout: 60_000 });
    await expect(page.getByText(LATEST)).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "閉じる", exact: true }).first().click();
    await expect(page.getByText(EDITED, { exact: true })).toHaveCount(1, { timeout: 10_000 });
    await retryButton(page).click();
    await expect(page.getByText(REPLY, { exact: true })).toHaveCount(1, { timeout: 30_000 });
    expect(chats[1].turns.map((t: any) => t.content)).toEqual([EDITED]);
    await expect.poll(async () => shape(await opened(page))).toEqual([["user", EDITED], ["ai", REPLY]]);
    await saved(page, EDITED, 2);
    await staysLatest(page);
    expect(shape(await opened(page))).toEqual([["user", EDITED], ["ai", REPLY]]);
    await saved(page, EDITED, 2);
    expect(await fileWith(page, `**User:** ${SAID}`)).toEqual([]);
  });

  test("leaving after an empty reply: the message stays and is captured once, and nothing waits to be retried in the next conversation", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page);
    const { chats, captures } = await fakeApi(page, [{ body: "" }, { body: REPLY }]);
    await openConversation(page);
    await send(page, SAID);
    await expect(retryButton(page)).toBeVisible({ timeout: 30_000 });
    const id = (await opened(page)).id;
    await page.getByRole("button", { name: "トップ画面へ戻る" }).click();
    await expect(page.getByText("今日は、どう話そう？")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => captures.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await memoriesOf(page, id)).length, { timeout: 30_000 }).toBe(1);
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await expect(retryButton(page)).toHaveCount(0);
    await expect(page.getByText(EMPTY_MESSAGE)).toHaveCount(0);
    expect(chats.length).toBe(1);
    await staysLatest(page);
    const row = (await allRows(page, "conversations")).find((c) => c.id === id);
    expect(shape(row)).toEqual([["user", SAID]]);
    await saved(page, SAID, 1);
    expect(captures.length).toBe(1);
    expect((await memoriesOf(page, id)).length).toBe(1);
  });
});
