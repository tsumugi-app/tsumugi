/* eslint-disable @typescript-eslint/no-explicit-any */
// Startup Memory creation, as specified in docs/startup-memory-capture.md. The AI is never called and every word here is fictional.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const LATEST = "✓ 最新の状態です";
const SETTLE = 4_500, MIN = 60_000;
const said = (name: string) => `架空の話題${name}です`;
const MEMORY = { topicDecision: "newTopic", summary: "架空の要約", content: "架空の記憶", keywords: ["架空"], types: ["conversation"], confidence: 0.9 };

type Past = { id: string; ago: number; status?: "active" | "captured"; turns?: [string, string][]; chatProviders?: string[]; memoryIds?: string[] };
type CaptureReply = { status?: number; hold?: Promise<void>; abort?: boolean };
/** on, with permission for conversations of any AI, and a fictional key; each test takes away what it is about */
type Device = { enabled?: boolean; allowOtherProviders?: boolean; key?: boolean; recentRuns?: number; revisit?: string; fullStartDelay?: boolean; openaiKey?: boolean; chosen?: "gemini" | "openai" };

/** a device in normal use: a real OPFS Vault with its Registry baseline, holding fictional past conversations */
async function seed(page: Page, past: Past[] = [], memoryOf?: string | string[], device: Device = {}) {
  // the home screen shows a past question at random: keep every draw under its 45%
  if (device.revisit) await page.addInitScript(() => { const random = Math.random; Math.random = () => random() * 0.4; });
  // the run starts 5 s after a start. These tests go through dozens of starts within the E2E time limit, so here it waits 2 s; the first test keeps the real wait.
  if (!device.fullStartDelay) await page.addInitScript(() => { const later = window.setTimeout; window.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => later(fn, ms === 5000 ? 2000 : ms, ...rest)) as any; });
  await page.addInitScript(() => {
    (window as any).__io = { reads: 0, writes: 0 };
    const getFile = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function (this: FileSystemFileHandle) { (window as any).__io.reads++; return getFile.call(this); };
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
      (window as any).__io.writes++;
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
    if (device.openaiKey) await dbm.saveApiKey("fictional-openai-key", "openai");
    if (device.chosen) await dbm.saveChatProvider(device.chosen);
    if (device.recentRuns) await dbm.saveAutoCaptureStateRaw(JSON.stringify({ conversations: {}, recentRuns: Array(device.recentRuns).fill(new Date(Date.now() - 3_600_000).toISOString()) }));
    for (const c of past) {
      const T = new Date(Date.now() - c.ago).toISOString();
      const turns = (c.turns ?? [["user", `架空の話題${c.id}です`], ["ai", "架空の返答です。"]]).map(([role, content]) => ({ role, content, timestamp: T }));
      await dbm.putConversationWithOutbox({ id: c.id, persona: "companion", status: c.status ?? "active", startedAt: T, createdAt: T, updatedAt: T, memoryObjectIds: c.memoryIds ?? [], turns, ...(c.chatProviders ? { chatProviders: c.chatProviders } : {}),
        metadata: { id: `meta-${c.id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
      if ([memoryOf].flat().includes(c.id)) await dbm.putMemoryObjectWithOutbox({ id: `mem-${c.id}`, date: T, types: ["conversation"], conversationId: c.id, content: "架空の保存済みの記憶", summary: "架空の保存済みの要約", keywords: ["架空"], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T,
        ...(device.revisit ? { revisitPrompt: device.revisit } : {}), metadata: { id: `meta-mem-${c.id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    }
    await bootstrap.runSaveFoundationBootstrap({ root });
    const d = await root.getDirectoryHandle(".tsumugi", { create: true });
    const w = await (await d.getFileHandle("registry-meta.json", { create: true })).createWritable();
    await w.write(JSON.stringify({ schemaVersion: 1, updatedAt: OLDEST, lastFullResyncAt: null, baselineEstablishedAt: OLDEST })); await w.close();
  }, { past, memoryOf, device });
}

/** fictional AI that counts every call. `reply(body)` decides the answer to one Capture; by default it returns one fictional Memory. */
async function fakeApi(page: Page, reply: (words: string) => CaptureReply = () => ({})) {
  const calls = { chat: 0, capture: [] as string[], connect: 0, prompt: 0, reflect: 0, sent: [] as { api: string; key?: string; only?: string }[], connectAnswers: false,
    /** every AI request, the chat included: the AI it names and the keys it carries */
    ai: [] as { api: string; ai?: string; gemini?: string; openai?: string; only?: string }[] };
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const api = ["capture", "connect", "prompt"].find((name) => url.includes(`/api/${name}`));
    if (api) { const h = route.request().headers(); calls.sent.push({ api, key: h["x-gemini-api-key"], only: h["x-tsumugi-user-key-only"] }); }
    const any = ["chat", "capture", "connect", "prompt", "reflect", "synthesize"].find((name) => url.includes(`/api/${name}`));
    if (any) { const h = route.request().headers(); calls.ai.push({ api: any, ai: h["x-ai-provider"], gemini: h["x-gemini-api-key"], openai: h["x-openai-api-key"], only: h["x-tsumugi-user-key-only"] }); }
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
    } else if (url.includes("/api/reflect")) {
      calls.reflect++;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ title: "架空の題", reflection: "架空の振り返りです。" }) });
    } else {
      if (url.includes("/api/connect")) calls.connect++;
      if (url.includes("/api/prompt")) calls.prompt++;
      if (url.includes("/api/connect") && calls.connectAnswers) { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ links: [] }) }); return; }
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
  const walk = async (d: any): Promise<void> => { for await (const [name, h] of d.entries()) { if (h.kind === "directory") await walk(h); else if (name.endsWith(".md")) { const t = await readFile(h); if (t.includes(text)) found.push(t); } } };
  // the app may be writing the file at this moment
  const readFile = async (h: any): Promise<string> => { for (let i = 0; ; i++) { try { return await (await h.getFile()).text(); } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 300)); } } };
  await walk(await navigator.storage.getDirectory());
  return found;
}, needle);
const captureSeen = (calls: { capture: string[] }, n: number, timeout = 30_000) => expect.poll(() => calls.capture.length, { timeout }).toBe(n);

const notice = (title: string, value: unknown) => process.stdout.write(`\n::notice title=${title}::${JSON.stringify(value)}\n`);
const nav = (page: Page) => page.getByRole("navigation", { name: "メインナビゲーション" });
const talkFromHome = async (page: Page, words: string) => { await page.getByRole("button", { name: "会話", exact: true }).click(); await talk(page, words); };
const goHome = (page: Page) => page.getByRole("button", { name: /ホームへ戻る|トップ画面へ戻る/ }).first().click();
const withWords = async (page: Page, words: string) => (await rows(page, "conversations")).find((c) => c.turns.some((t: any) => t.content === words));
/** as if the conversation had been left for two hours: a conversation already saved to the Vault stays saved */
const backdate = (page: Page, id: string) => page.evaluate(async (id) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const c: any = await new Promise((res, rej) => { const q = db.transaction("conversations").objectStore("conversations").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const synced: any = await new Promise((res, rej) => { const q = db.transaction("vaultSyncState").objectStore("vaultSyncState").get(`conversation:${id}`); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const updatedAt = new Date(Date.now() - 7_200_000).toISOString();
  await new Promise<void>((res, rej) => {
    const t = db.transaction(["conversations", "vaultSyncState"], "readwrite");
    t.objectStore("conversations").put({ ...c, updatedAt });
    if (synced === c.updatedAt) t.objectStore("vaultSyncState").put(updatedAt, `conversation:${id}`);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
  db.close();
}, id);
/** the words of the first turn change in the stored conversation, as another tab's edit would */
const editStored = (page: Page, id: string, words: string) => page.evaluate(async ({ id, words }) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const c: any = await new Promise((res, rej) => { const q = db.transaction("conversations").objectStore("conversations").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("conversations", "readwrite"); t.objectStore("conversations").put({ ...c, turns: c.turns.map((turn: any, i: number) => (i === 0 ? { ...turn, content: words } : turn)) }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, { id, words });
/** the Markdown file holding `needle` gets `added` from outside the app */
const editFile = (page: Page, needle: string, added: string) => page.evaluate(async ({ needle, added }) => {
  const walk = async (d: any): Promise<boolean> => {
    for await (const [name, h] of d.entries()) {
      if (h.kind === "directory") { if (await walk(h)) return true; continue; }
      if (!name.endsWith(".md")) continue;
      const text = await (await h.getFile()).text();
      if (!text.includes(needle)) continue;
      const w = await h.createWritable(); await w.write(`${text}\n${added}\n`); await w.close();
      return true;
    }
    return false;
  };
  return walk(await navigator.storage.getDirectory());
}, { needle, added });
/** one store on the device changed directly, as a Vault restore or sync in the background would leave it */
const memoryRow = (page: Page, id: string) => page.evaluate(async (id) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const row: any = await new Promise((res, rej) => { const q = db.transaction("memoryObjects").objectStore("memoryObjects").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close(); return row;
}, id);
const dropMemoryRow = (page: Page, id: string) => page.evaluate(async (id) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("memoryObjects", "readwrite"); t.objectStore("memoryObjects").delete(id); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, id);
const putRow = (page: Page, store: string, row: any) => page.evaluate(async ({ store, row }) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction(store, "readwrite"); t.objectStore(store).put(row); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, { store, row });
const fictionalMemory = (id: string, conversationId: string) => { const T = new Date(Date.now() - 86_400_000).toISOString(); return { id, date: T, types: ["conversation"], conversationId, content: "架空の復元された記憶", summary: "架空の復元された要約", keywords: ["架空"], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: { id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } }; };
/** as after a finished save: with one still to come, the app rewrites a file with the same words itself (a save may update status and references), which a later test does not want */
const nothingLeftToSave = (page: Page, id: string) => page.evaluate(async (id) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const c: any = await new Promise((res, rej) => { const q = db.transaction("conversations").objectStore("conversations").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const o: any = await new Promise((res, rej) => { const q = db.transaction("vaultOutbox").objectStore("vaultOutbox").get(`conversation:${id}`); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("vaultOutbox", "readwrite"); t.objectStore("vaultOutbox").put({ ...o, recordUpdatedAt: c.updatedAt, status: "done" }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, id);
/** the file holding `needle` gets its first line matching `from` rewritten from outside the app; the words stay */
const rewriteFile = (page: Page, needle: string, from: string, to: string) => page.evaluate(async ({ needle, from, to }) => {
  const walk = async (d: any): Promise<boolean> => {
    for await (const [name, h] of d.entries()) {
      if (h.kind === "directory") { if (await walk(h)) return true; continue; }
      if (!name.endsWith(".md")) continue;
      const text = await (await h.getFile()).text();
      if (!text.includes(needle)) continue;
      const w = await h.createWritable(); await w.write(text.replace(new RegExp(from, "m"), to)); await w.close();
      return true;
    }
    return false;
  };
  return walk(await navigator.storage.getDirectory());
}, { needle, from, to });
/** a save of this conversation still to come on this device, as when the app closed before it reached the file */
const leaveSavePending = (page: Page, id: string) => page.evaluate(async (id) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const c: any = await new Promise((res, rej) => { const q = db.transaction("conversations").objectStore("conversations").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const o: any = await new Promise((res, rej) => { const q = db.transaction("vaultOutbox").objectStore("vaultOutbox").get(`conversation:${id}`); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("vaultOutbox", "readwrite"); t.objectStore("vaultOutbox").put({ ...o, recordUpdatedAt: c.updatedAt, status: "pending" }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, id);
const autoCaptureSetting = (page: Page, enabled: boolean, allowOtherProviders: boolean) => page.evaluate(async (v) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("settings", "readwrite"); t.objectStore("settings").put(JSON.stringify(v), "autoCapture:settings"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, { enabled, allowOtherProviders });
/** the browser forgets the folder permission at every start, as Android does; 「アクセスを再許可」 gives it back until the next start */
const permissionLostAtStart = (page: Page) => page.addInitScript(() => {
  const w = window as any;
  const proto = w.FileSystemHandle.prototype;
  proto.queryPermission = async function () { return w.__granted ? "granted" : "prompt"; };
  proto.requestPermission = async function () { w.__granted = true; w.__requested = (w.__requested ?? 0) + 1; return "granted"; };
});
/** 「アクセスを再許可」 in Settings. The button sits under the bottom bar in the test window, so the click goes to the button itself */
const giveBackPermission = async (page: Page) => {
  const button = page.getByRole("button", { name: "アクセスを再許可" }).first();
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.evaluate((el: HTMLElement) => el.click());
  await expect.poll(() => page.evaluate(() => (window as any).__requested ?? 0), { timeout: 10_000 }).toBe(1);
};
const settingsValue = (page: Page, key: string) => page.evaluate(async (key) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const value: any = await new Promise((res, rej) => { const q = db.transaction("settings").objectStore("settings").get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close(); return value;
}, key);
/** the Gemini key as the Settings screen would leave it: removed (undefined), or as stored */
const setKey = (page: Page, value?: string) => page.evaluate(async (value) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("settings", "readwrite"); const s = t.objectStore("settings"); if (value === undefined) s.delete("geminiApiKey"); else s.put(value, "geminiApiKey"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, value);
/** every request of an automatic run went with the user's key and with the mark that forbids the server key */
const allWithUserKey = (calls: { sent: { api: string; key?: string; only?: string }[] }) => expect(calls.sent.filter((r) => r.key !== "fictional-test-key" || r.only !== "1"), "a request without the user's key").toEqual([]);
const connectedCount = async (page: Page) => (await rows(page, "connectState")).filter((r) => r?.status === "done").length;
const memoryIdOf = async (page: Page, conversation: string) => (await memoriesOf(page, conversation))[0]?.id;
const isConnected = async (page: Page, memoryId: string) => page.evaluate(async (id) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const r: any = await new Promise((res, rej) => { const q = db.transaction("connectState").objectStore("connectState").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close(); return r?.status === "done";
}, memoryId);
/** Settings in another tab: the key goes at the exact moment the test asks for. Marks do not survive a reload, except the one for the first Connect of a start, which fires once. */
const keyCanGo = (page: Page, atFirstConnect = false) => page.addInitScript((atFirstConnect) => {
  const w = window as any;
  w.__keyGoesAtConnect = atFirstConnect && !sessionStorage.getItem("key-went");
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, stores: any, mode?: any, ...rest: any[]) {
    if (w.__keyGoesAtConnect && mode === "readwrite" && [stores].flat().includes("connectState")) {
      w.__keyGoesAtConnect = false; sessionStorage.setItem("key-went", "1");
      (transaction as any).call(this, "settings", "readwrite").objectStore("settings").delete("geminiApiKey");
    }
    return (transaction as any).call(this, stores, mode, ...rest);
  } as any;
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: any) {
    const read = get.call(this, key);
    if (w.__keyGoesAfterRead && key === "geminiApiKey") {
      w.__keyGoesAfterRead = false;
      (transaction as any).call(this.transaction.db, "settings", "readwrite").objectStore("settings").delete("geminiApiKey");
    }
    return read;
  };
}, atFirstConnect);
const usedToday = async (page: Page) => JSON.parse((await settingsValue(page, "autoCapture:state")) ?? "{}").recentRuns?.length ?? 0;
const allowOthers = (page: Page) => page.evaluate(async () => {
  const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("settings", "readwrite"); t.objectStore("settings").put(JSON.stringify({ enabled: true, allowOtherProviders: true }), "autoCapture:settings"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
});
/** the file has the whole conversation, the reply too, and its save is over */
async function fileIsWritten(page: Page, words: string) {
  await expect.poll(async () => (await filesWith(page, words)).filter((t) => t.includes("架空の返答です。")).length, { timeout: 30_000 }).toBe(1);
  await page.waitForTimeout(1_500);
}
/** Settings, what the person does: 確認する then 更新する takes the edit in. When the device also has something the file has not, it is a choice between two versions, and the person takes the file's. */
async function takeInEdit(page: Page) {
  await nav(page).getByRole("button", { name: "設定" }).click();
  const check = page.getByRole("button", { name: "確認する", exact: true }).first();
  const update = page.getByRole("button", { name: "更新する", exact: true }).first();
  const conflict = page.getByTestId("vault-conflict-open").first();
  await expect(check.or(conflict).first()).toBeVisible({ timeout: 120_000 });
  if (await check.isVisible()) { await expect(check).toBeEnabled({ timeout: 60_000 }); await check.click(); }
  try { await expect(update.or(conflict).first()).toBeVisible({ timeout: 60_000 }); }
  catch { throw new Error(`no update or choice. The screen said: ${await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1500))}`); }
  const asChoice = !(await update.isVisible());
  notice("edit-taken-in", asChoice ? "choice of versions" : "update");
  if (asChoice) {
    await conflict.click();
    await page.getByTestId("vault-conflict-choice-adopt-vault").click();
    await page.getByTestId("vault-conflict-confirm").click();
  } else await update.click();
  await expect(page.getByText(LATEST)).toBeVisible({ timeout: 120_000 });
}
const conversationWords = async (page: Page, id: string) => (await rows(page, "conversations")).find((c) => c.id === id)?.turns.map((t: any) => t.content).join(" ") ?? "";
const providersOf = async (page: Page, words: string) => (await withWords(page, words))?.chatProviders;

/** one Memory on the device and in exactly one Vault file, the conversation captured in both, nothing more after another start, and Settings says 最新 */
async function finishedOnce(page: Page, id: string, calls: Parameters<typeof aiCalls>[0], words: string, openSettings = false, restart = true) {
  await expect.poll(() => statusOf(page, id), { timeout: 40_000 }).toBe("captured");
  expect((await memoriesOf(page, id)).length).toBe(1);
  await expect.poll(async () => (await filesWith(page, "架空の記憶")).length, { timeout: 40_000 }).toBe(1);
  await expect.poll(async () => (await filesWith(page, words)).filter((t) => /^status: "?captured"?$/m.test(t)).length, { timeout: 40_000 }).toBe(1);
  if (!restart) return;
  const after = calls.capture.length;
  await startApp(page);
  await page.waitForTimeout(SETTLE);
  expect(calls.capture.length, "a processed conversation costs nothing at the next start").toBe(after);
  expect((await memoriesOf(page, id)).length).toBe(1);
  expect((await filesWith(page, "架空の記憶")).length).toBe(1);
  if (!openSettings) return;
  await nav(page).getByRole("button", { name: "設定" }).click();
  await expect(page.getByText(LATEST)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
}

test.describe("startup Memory creation", () => {
  test("a conversation left without an end gets one Capture and one Memory, reaches the file, Settings stays 最新, and later starts call nothing", async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page, [{ id: "left-1", ago: 120 * MIN }], undefined, { fullStartDelay: true });
    const calls = await fakeApi(page);
    await startApp(page);
    await captureSeen(calls, 1);
    await finishedOnce(page, "left-1", calls, said("left-1"), true);
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
    await finishedOnce(page, "closed-1", calls, said("closed-1"), false, false);
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
    await seed(page, [{ id: "nokey-1", ago: 120 * MIN }, { id: "nokey-o1", ago: 3000 * MIN, status: "captured" }, { id: "nokey-o2", ago: 4000 * MIN, status: "captured" }], ["nokey-o1", "nokey-o2"], { key: false, revisit: "架空の問いですか" });
    const calls = await fakeApi(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls)).toBe(0);
    expect(await statusOf(page, "nokey-1")).toBe("active");
    // blank is no key: the server would see an empty header and use its own
    await setKey(page, "   ");
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls), "a blank key is no key").toBe(0);
    expect(await statusOf(page, "nokey-1")).toBe("active");
    expect(await usedToday(page)).toBe(0);
    // a key that cannot go in a header is no key either
    await setKey(page, "架空のキー");
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls), "an unusable key is no key").toBe(0);
    expect(await statusOf(page, "nokey-1")).toBe("active");
    expect(await usedToday(page)).toBe(0);
    expect(JSON.parse((await settingsValue(page, "autoCapture:state")) ?? "{}").conversations?.["nokey-1"], "no attempt used").toBeUndefined();
    expect(await connectedCount(page), "Connect is left for later, not marked done").toBe(0);
  });

  test("the key is removed after the run checked it: nothing is sent, nothing is counted, and with a key again one Memory", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "gone-1", ago: 120 * MIN }]);
    const calls = await fakeApi(page);
    // Settings in another tab: the key goes just as the run gets its lock, after its check. Once.
    await page.addInitScript(() => {
      if (sessionStorage.getItem("key-removed")) return;
      const request = LockManager.prototype.request;
      LockManager.prototype.request = function (this: LockManager, name: string, ...rest: any[]) {
        const fn = rest[rest.length - 1];
        if (name !== "tsumugi-auto-capture-run") return (request as any).call(this, name, ...rest);
        return (request as any).call(this, name, ...rest.slice(0, -1), async (lock: any) => {
          sessionStorage.setItem("key-removed", "1");
          const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
          await new Promise<void>((res, rej) => { const t = db.transaction("settings", "readwrite"); t.objectStore("settings").delete("geminiApiKey"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
          db.close();
          return fn(lock);
        });
      } as any;
    });
    await startApp(page);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("key-removed")), { timeout: 30_000 }).toBe("1");
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls), "no request without the user's key").toBe(0);
    expect(await statusOf(page, "gone-1")).toBe("active");
    expect(await usedToday(page), "no request, so nothing counted").toBe(0);
    expect(JSON.parse((await settingsValue(page, "autoCapture:state")) ?? "{}").conversations?.["gone-1"], "no attempt used").toBeUndefined();
    await setKey(page, "fictional-test-key");
    await startApp(page);
    await captureSeen(calls, 1);
    await finishedOnce(page, "gone-1", calls, said("gone-1"));
  });

  test("the key is removed during the AI call: the Memory is kept, and no later AI request goes out without the key", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "old", ago: 240 * MIN, status: "captured" }, { id: "during-1", ago: 120 * MIN }], "old", { revisit: "架空の問いですか" });
    let release = () => {};
    const held = new Promise<void>((res) => { release = res; });
    const calls = await fakeApi(page, () => ({ hold: held }));
    await startApp(page);
    await captureSeen(calls, 1);
    await setKey(page);
    const { connect, prompt } = calls;
    release();
    await expect.poll(() => statusOf(page, "during-1"), { timeout: 40_000 }).toBe("captured");
    expect((await memoriesOf(page, "during-1")).length).toBe(1);
    await page.waitForTimeout(SETTLE);
    expect(calls.prompt - prompt, "no question request without the key").toBe(0);
    expect(calls.connect - connect, "no Connect request without the key").toBe(0);
    const memory = await memoryIdOf(page, "during-1");
    expect(await isConnected(page, memory), "Connect is left for later, not marked done").toBe(false);
    expect((await memoriesOf(page, "during-1"))[0].revisitPrompt, "no question was made").toBeFalsy();
    calls.connectAnswers = true;
    await setKey(page, "fictional-test-key");
    await finishedOnce(page, "during-1", calls, said("during-1"));
    await expect.poll(() => isConnected(page, memory), { timeout: 30_000 }).toBe(true);
    expect(calls.connect - connect, "with the key back, Connect once").toBe(1);
    allWithUserKey(calls);
  });

  test("a normal key: Capture, Connect and the question all go once, with the user's key and the mark; nothing again at the next start", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "ok-old", ago: 3000 * MIN, status: "captured" }, { id: "ok-1", ago: 120 * MIN }], "ok-old", { revisit: "架空の問いですか" });
    const calls = await fakeApi(page);
    calls.connectAnswers = true;
    await startApp(page);
    await captureSeen(calls, 1);
    await finishedOnce(page, "ok-1", calls, said("ok-1"));
    expect([calls.capture.length, calls.connect, calls.prompt]).toEqual([1, 1, 1]);
    allWithUserKey(calls);
  });

  test("the key goes just as the startup Connect starts: nothing is sent without it, nothing is marked done, and with the key back each Memory connects once", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "c-1", ago: 3000 * MIN, status: "captured" }, { id: "c-2", ago: 4000 * MIN, status: "captured" }], ["c-1", "c-2"], { revisit: "架空の問いですか" });
    const calls = await fakeApi(page);
    calls.connectAnswers = true;
    await keyCanGo(page, true);
    await startApp(page);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("key-went")), { timeout: 30_000 }).toBe("1");
    await page.waitForTimeout(SETTLE);
    expect(calls.connect, "no Connect request without the key").toBe(0);
    expect(await connectedCount(page), "nothing marked done").toBe(0);
    await setKey(page, "fictional-test-key");
    await startApp(page);
    await expect.poll(() => connectedCount(page), { timeout: 30_000 }).toBe(2);
    expect(calls.connect).toBe(2);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.connect, "no second Connect").toBe(2);
    allWithUserKey(calls);
  });

  test("the key goes between the last check and a request after the Capture: no request goes without it, and with the key back the rest finishes once", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "g-old", ago: 3000 * MIN, status: "captured" }, { id: "g-1", ago: 120 * MIN }], "g-old", { revisit: "架空の問いですか" });
    let release = () => {};
    const held = new Promise<void>((res) => { release = res; });
    const calls = await fakeApi(page, () => ({ hold: held }));
    calls.connectAnswers = true;
    await keyCanGo(page);
    await startApp(page);
    await captureSeen(calls, 1);
    await page.evaluate(() => { (window as any).__keyGoesAfterRead = true; });
    release();
    await expect.poll(() => statusOf(page, "g-1"), { timeout: 40_000 }).toBe("captured");
    await page.waitForTimeout(SETTLE);
    allWithUserKey(calls);
    expect(calls.prompt + calls.connect, "the one read before the key went, and nothing after").toBe(1);
    await setKey(page, "fictional-test-key");
    await finishedOnce(page, "g-1", calls, said("g-1"));
    await expect.poll(async () => isConnected(page, await memoryIdOf(page, "g-1")), { timeout: 30_000 }).toBe(true);
    expect(calls.capture.length).toBe(1);
    allWithUserKey(calls);
  });

  test("a question left unmade because the key went is made by the home screen once the key is back", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "q-1", ago: 120 * MIN }], undefined, { revisit: "unused" });
    let release = () => {};
    const held = new Promise<void>((res) => { release = res; });
    const calls = await fakeApi(page, () => ({ hold: held }));
    await startApp(page);
    await captureSeen(calls, 1);
    await setKey(page);
    release();
    await expect.poll(() => statusOf(page, "q-1"), { timeout: 40_000 }).toBe("captured");
    await page.waitForTimeout(SETTLE);
    expect(calls.prompt).toBe(0);
    await setKey(page, "fictional-test-key");
    await startApp(page);
    await expect.poll(() => calls.prompt, { timeout: 30_000 }).toBe(1);
    expect(calls.sent.filter((r) => r.api === "prompt")[0].key).toBe("fictional-test-key");
    expect(calls.capture.length).toBe(1);
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
    await allowOthers(page);
    await startApp(page);
    await captureSeen(calls, 2);
    expect(calls.capture[1], "with the permission, the oldest of them goes").toContain("other-ai");
    await expect.poll(() => statusOf(page, "other-ai"), { timeout: 30_000 }).toBe("captured");
  });

  test("a new conversation held with Gemini goes without the permission, also when it starts from a past question", async ({ page }) => {
    test.setTimeout(180_000);
    const QUESTION = "架空の話題について、どう感じていますか？";
    await seed(page, [{ id: "source", ago: 3000 * MIN, status: "captured" }], "source", { allowOtherProviders: false, revisit: QUESTION });
    const calls = await fakeApi(page);
    await startApp(page);
    await expect(page.getByText(QUESTION)).toBeVisible({ timeout: 30_000 });
    const box = page.getByPlaceholder("ここに入力してください");
    await box.fill(said("問いかけから"));
    await box.locator("xpath=..").getByRole("button", { name: "送る" }).click();
    await expect(page.getByText("架空の返答です。")).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => providersOf(page, said("問いかけから")), { timeout: 15_000 }).toEqual(["gemini"]);
    const fromQuestion = await withWords(page, said("問いかけから"));
    expect(fromQuestion.turns[0].role, "the question is the first turn").toBe("ai");
    await backdate(page, fromQuestion.id);
    await startApp(page);
    await captureSeen(calls, 1);
    expect(calls.capture[0]).toContain(said("問いかけから"));
    await expect.poll(() => statusOf(page, fromQuestion.id), { timeout: 30_000 }).toBe("captured");
    await page.waitForTimeout(2_000);
    await talkFromHome(page, said("普通の新規"));
    await expect.poll(() => providersOf(page, said("普通の新規")), { timeout: 30_000 }).toEqual(["gemini"]);
    await expect.poll(async () => (await filesWith(page, said("普通の新規"))).length, { timeout: 30_000 }).toBe(1);
    expect((await filesWith(page, said("普通の新規")))[0], "the Markdown stays as it was").not.toContain("chatProviders");
    const plain = await withWords(page, said("普通の新規"));
    await backdate(page, plain.id);
    await startApp(page);
    await captureSeen(calls, 2);
    expect(calls.capture[1]).toContain(said("普通の新規"));
  });

  test("an old conversation of unknown AI that goes on with Gemini stays unknown: it waits for the permission, and goes with it", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "old-cut", ago: 120 * MIN }], undefined, { allowOtherProviders: false });
    await page.evaluate(async () => {
      const { dbm } = (window as any).D; const c = await dbm.getConversation("old-cut");
      await dbm.putConversationWithOutbox({ ...c, turns: c.turns.map((t: any) => (t.role === "ai" ? { ...t, interrupted: true } : t)) });
    });
    const calls = await fakeApi(page);
    await startApp(page);
    await page.getByRole("button", { name: "続きを開く" }).click({ timeout: 30_000 });
    await page.locator("footer textarea").fill(said("再開"));
    await page.locator("footer").getByRole("button", { name: "送る" }).click();
    await expect.poll(async () => (await rows(page, "conversations")).find((c) => c.id === "old-cut")?.turns.length, { timeout: 30_000 }).toBe(4);
    expect(await providersOf(page, said("再開"))).toEqual(["unknown", "gemini"]);
    await backdate(page, "old-cut");
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length, "no permission, no request").toBe(0);
    await allowOthers(page);
    await startApp(page);
    await captureSeen(calls, 1);
    await expect.poll(() => statusOf(page, "old-cut"), { timeout: 30_000 }).toBe("captured");
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
    expect(calls.sent.filter((r) => r.only), "the end of a conversation carries no mark").toEqual([]);
    expect(calls.sent.find((r) => r.api === "capture")?.key).toBe("fictional-test-key");
  });

  test("the end of a conversation on a device with no key goes as before, for the server's key to serve it", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [], undefined, { enabled: false, key: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("キーなし終了"));
    await goHome(page);
    await captureSeen(calls, 1);
    expect(calls.sent.find((r) => r.api === "capture")).toEqual({ api: "capture", key: undefined, only: undefined });
    expect(calls.ai.find((r) => r.api === "capture")?.ai, "Gemini is the AI chosen on this device").toBe("gemini");
    const c = await withWords(page, said("キーなし終了"));
    await expect.poll(() => statusOf(page, c.id), { timeout: 40_000 }).toBe("captured");
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
    await finishedOnce(page, held.id, calls, said("切断"), false, false);
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
    await finishedOnce(page, c.id, calls, said("閉じる"), false, false);
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
    await finishedOnce(page, c.id, calls, said("ファイル"), true);
    expect(calls.capture.length).toBe(1);
  });
});

test.describe("what an AI request costs, and what it may not overwrite", () => {
  test("the words change during the AI call: the result is thrown away, no other conversation is sent in this start, the request is counted, and the 5 in 24 hours hold", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "edited-now", ago: 300 * MIN }, { id: "next-one", ago: 120 * MIN }], undefined, { recentRuns: 3, fullStartDelay: true });
    let release = () => {}; const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const calls = await fakeApi(page, () => { if (first) { first = false; return { hold: held }; } return {}; });
    await startApp(page);
    await captureSeen(calls, 1);
    await editStored(page, "edited-now", said("書き換え後"));
    release();
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length, "this start already used its one conversation").toBe(1);
    expect((await rows(page, "memoryObjects")).length, "nothing from the old words").toBe(0);
    expect(await statusOf(page, "edited-now")).toBe("active");
    expect(await usedToday(page), "the request happened, so it counts").toBe(4);
    await startApp(page);
    await captureSeen(calls, 2);
    expect(calls.capture[1], "the new words, at the next start").toContain(said("書き換え後"));
    await expect.poll(() => statusOf(page, "edited-now"), { timeout: 30_000 }).toBe("captured");
    expect((await memoriesOf(page, "edited-now")).length).toBe(1);
    expect(await usedToday(page)).toBe(5);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length, "5 in 24 hours").toBe(2);
    expect(await statusOf(page, "next-one")).toBe("active");
  });

  test("a refused key counts as a request: it cannot go past the 5 in 24 hours", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "refused-1", ago: 120 * MIN }], undefined, { recentRuns: 4 });
    const calls = await fakeApi(page, () => ({ status: 401 }));
    await startApp(page);
    await captureSeen(calls, 1);
    await page.waitForTimeout(2_000);
    expect(await usedToday(page)).toBe(5);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(1);
    expect(await statusOf(page, "refused-1")).toBe("active");
  });

  test("the Vault file was edited from outside before the start: the old words are not sent, and the file keeps the edit", async ({ page }) => {
    test.setTimeout(180_000);
    const EDIT = "架空の外部編集の一文";
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("外部前"));
    await expect.poll(async () => (await filesWith(page, said("外部前"))).length, { timeout: 30_000 }).toBe(1);
    const { id } = await withWords(page, said("外部前"));
    await backdate(page, id);
    expect(await editFile(page, said("外部前"), EDIT)).toBe(true);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.filter((words) => !words.includes(EDIT)), "never the words from before the edit").toEqual([]);
    expect((await filesWith(page, EDIT)).length, "the edit is still in the file").toBe(1);
    expect((await memoriesOf(page, id)).length).toBe(0);
  });

  test("automatic: the file is edited during the AI call, so the result is thrown away; once the edit is taken in, one Memory from the edited words, and no second at the next start", async ({ page }) => {
    test.setTimeout(300_000);
    const EDIT = "架空の通信中の外部編集";
    await seed(page);
    let release = () => {}; const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const calls = await fakeApi(page, () => { if (first) { first = false; return { hold: held }; } return {}; });
    await startApp(page);
    await talkFromHome(page, said("外部中"));
    await fileIsWritten(page, said("外部中"));
    const { id } = await withWords(page, said("外部中"));
    await backdate(page, id);
    await startApp(page);
    await captureSeen(calls, 1);
    expect(await editFile(page, said("外部中"), EDIT)).toBe(true);
    release();
    await page.waitForTimeout(3_000);
    expect((await memoriesOf(page, id)).length, "nothing from the old words").toBe(0);
    expect(await statusOf(page, id)).toBe("active");
    expect((await filesWith(page, EDIT)).length).toBe(1);
    await startApp(page);
    await takeInEdit(page);
    await backdate(page, id);
    await startApp(page);
    await captureSeen(calls, 2);
    expect(calls.capture[1]).toContain(EDIT);
    await finishedOnce(page, id, calls, EDIT);
  });

  test("automatic: a Memory write that fails leaves the conversation open, and a later try makes one Memory", async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page, [{ id: "auto-fails", ago: 120 * MIN }]);
    let release = () => {}; const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const calls = await fakeApi(page, () => { if (first) { first = false; return { hold: held }; } return {}; });
    await startApp(page);
    await captureSeen(calls, 1);
    await page.evaluate(() => { (window as any).__failMemoryWrite = true; });
    release();
    await page.waitForTimeout(3_000);
    expect((await memoriesOf(page, "auto-fails")).length).toBe(0);
    expect(await statusOf(page, "auto-fails")).toBe("active");
    const state = JSON.parse(await settingsValue(page, "autoCapture:state"));
    expect(state.conversations["auto-fails"].lastKind).toBe("wait");
    // as if the wait after a failure had passed
    await page.evaluate(async (state) => {
      const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      await new Promise<void>((res, rej) => { const t = db.transaction("settings", "readwrite"); t.objectStore("settings").put(JSON.stringify(state), "autoCapture:state"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
      db.close();
    }, { ...state, conversations: { "auto-fails": { ...state.conversations["auto-fails"], lastAttemptAt: new Date(Date.now() - 7 * 3_600_000).toISOString() } } });
    await startApp(page);
    await captureSeen(calls, 2);
    await finishedOnce(page, "auto-fails", calls, said("auto-fails"));
  });

  test("end of a conversation: the file is edited during the AI call, so no Memory from the old words and not captured; nothing is lost, the next start leaves it alone, and once the edit is taken in, one Memory", async ({ page }) => {
    test.setTimeout(300_000);
    const EDIT = "架空の終了時の外部編集";
    await seed(page);
    let release = () => {}; const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const calls = await fakeApi(page, () => { if (first) { first = false; return { hold: held }; } return {}; });
    await startApp(page);
    await talkFromHome(page, said("終了時"));
    await fileIsWritten(page, said("終了時"));
    const { id } = await withWords(page, said("終了時"));
    await goHome(page);
    await captureSeen(calls, 1);
    expect(await editFile(page, said("終了時"), EDIT)).toBe(true);
    release();
    await page.waitForTimeout(3_000);
    expect((await memoriesOf(page, id)).length, "nothing from the old words").toBe(0);
    expect(await statusOf(page, id), "not processed").toBe("active");
    expect(await conversationWords(page, id), "the user's words stay").toContain(said("終了時"));
    expect((await filesWith(page, EDIT)).length, "the edit stays").toBe(1);
    await backdate(page, id);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length, "not sent again while the edit is not taken in").toBe(1);
    expect((await memoriesOf(page, id)).length).toBe(0);
    await takeInEdit(page);
    expect(await conversationWords(page, id)).toContain(EDIT);
    await backdate(page, id);
    await startApp(page);
    await captureSeen(calls, 2);
    expect(calls.capture[1]).toContain(EDIT);
    expect(calls.capture[1], "the user's words too").toContain(said("終了時"));
    await finishedOnce(page, id, calls, EDIT);
  });

  test("end of a conversation: a file edited before it costs no AI call; a change that leaves the words as they are does not stop it", async ({ page }) => {
    test.setTimeout(180_000);
    const EDIT = "架空の終了前の外部編集";
    await seed(page, [], undefined, { enabled: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("終了前"));
    await expect.poll(async () => (await filesWith(page, said("終了前"))).length, { timeout: 30_000 }).toBe(1);
    const edited = await withWords(page, said("終了前"));
    expect(await editFile(page, said("終了前"), EDIT)).toBe(true);
    await goHome(page);
    await page.waitForTimeout(3_000);
    expect(calls.capture.length).toBe(0);
    expect(await statusOf(page, edited.id)).toBe("active");
    expect((await memoriesOf(page, edited.id)).length).toBe(0);
    expect((await filesWith(page, EDIT)).length).toBe(1);

    await talkFromHome(page, said("空白だけ"));
    await expect.poll(async () => (await filesWith(page, said("空白だけ"))).length, { timeout: 30_000 }).toBe(1);
    const spaced = await withWords(page, said("空白だけ"));
    expect(await editFile(page, said("空白だけ"), "")).toBe(true);
    await goHome(page);
    await captureSeen(calls, 1);
    await expect.poll(() => statusOf(page, spaced.id), { timeout: 30_000 }).toBe("captured");
    expect((await memoriesOf(page, spaced.id)).length).toBe(1);
  });

  test("how much Vault reading, writing and AI a start costs", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "done-io", ago: 300 * MIN, status: "captured" }], undefined, { enabled: false });
    const calls = await fakeApi(page);
    const measure = async () => {
      await startApp(page);
      await page.waitForTimeout(SETTLE);
      return page.evaluate(() => (window as any).__io);
    };
    await startApp(page);
    const off = await measure();
    const offAi = aiCalls(calls);
    await allowOthers(page);
    const onNothing = await measure();
    const onNothingAi = aiCalls(calls) - offAi;
    await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const c: any = await new Promise((res, rej) => { const q = db.transaction("conversations").objectStore("conversations").get("done-io"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      await new Promise<void>((res, rej) => { const t = db.transaction("conversations", "readwrite"); t.objectStore("conversations").put({ ...c, id: "waits-io", status: "active" }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
      db.close();
    });
    const onOne = await measure();
    const onOneAi = aiCalls(calls) - offAi - onNothingAi;
    notice("perf-vault-io", { off, offAi, onNothing, onNothingAi, onOne, onOneAi, capture: calls.capture.length, connect: calls.connect, prompt: calls.prompt });
    expect(onNothingAi).toBe(0);
    expect(calls.capture.length).toBe(1);
  });
});

test.describe("the save of a Capture result checks what is stored", () => {
  test("a conversation whose words changed during the AI call gets nothing; an unchanged one, or one whose last turn is still being saved, is saved whole", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "same", ago: 120 * MIN }, { id: "edited", ago: 120 * MIN }, { id: "shortened", ago: 120 * MIN }, { id: "grown", ago: 120 * MIN }, { id: "behind", ago: 120 * MIN }, { id: "done", ago: 120 * MIN, status: "captured" }], undefined, { enabled: false });
    const outcomes = await page.evaluate(async () => {
      const { dbm } = (window as any).D;
      const T = new Date().toISOString();
      const later = new Date(Date.now() + 60_000).toISOString();
      const memory = (id: string) => ({ id: `new-${id}`, date: T, types: ["conversation"], conversationId: id, content: "架空の記憶", summary: "架空の要約", keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: { id: `meta-new-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
      const commit = async (id: string, change: (stored: any) => any, snapshot: (stored: any) => any = (s) => s) => {
        const stored = await dbm.getConversation(id);
        const read = snapshot(stored);
        await dbm.putConversationWithOutbox(change(stored));
        const r = await dbm.commitCaptureResult({ ...read, status: "captured", memoryObjectIds: [`new-${id}`], updatedAt: later }, [{ memory: memory(id), recordType: "memory" }], read.updatedAt);
        const after = await dbm.getConversation(id);
        return [r.outcome, after.status, after.memoryObjectIds.length, after.turns.length, !!(await dbm.getMemoryObject(`new-${id}`))];
      };
      const newer = new Date(Date.now() + 1000).toISOString();
      return {
        same: await commit("same", (s) => s),
        edited: await commit("edited", (s) => ({ ...s, updatedAt: newer, turns: s.turns.map((t: any, i: number) => (i === 0 ? { ...t, content: "架空の書き換え" } : t)) })),
        shortened: await commit("shortened", (s) => ({ ...s, updatedAt: newer, turns: s.turns.slice(0, 1) })),
        grown: await commit("grown", (s) => ({ ...s, updatedAt: newer, turns: [...s.turns, { role: "user", content: "架空の続き", timestamp: newer }] })),
        // the snapshot has a turn whose own save has not landed: the stored record is older than what Capture read
        behind: await commit("behind", (s) => s, (s) => ({ ...s, updatedAt: newer, turns: [...s.turns, { role: "user", content: "架空の未保存", timestamp: newer }] })),
        done: await commit("done", (s) => s),
      };
    });
    expect(outcomes.same).toEqual(["committed", "captured", 1, 2, true]);
    expect(outcomes.edited).toEqual(["conversation-changed", "active", 0, 2, false]);
    expect(outcomes.shortened).toEqual(["conversation-changed", "active", 0, 1, false]);
    expect(outcomes.grown).toEqual(["conversation-changed", "active", 0, 3, false]);
    expect(outcomes.behind).toEqual(["committed", "captured", 1, 3, true]);
    expect(outcomes.done).toEqual(["already-captured", "captured", 0, 2, false]);
  });
});

test.describe("a conversation that refers to Memories is never given new ones by the automatic run", () => {
  test("its Memory is gone from the device for a while and comes back: no Capture, nothing marked done, nothing rewritten, and one Memory in the end", async ({ page }) => {
    test.setTimeout(300_000);
    const id = "refers";
    await seed(page, [{ id, ago: 120 * MIN, memoryIds: [`mem-${id}`] }], id);
    const calls = await fakeApi(page);
    await startApp(page);
    await expect.poll(async () => (await filesWith(page, "架空の保存済みの記憶")).length, { timeout: 40_000 }).toBe(1);
    const original = await memoryRow(page, `mem-${id}`);
    expect(original).toBeTruthy();
    await dropMemoryRow(page, `mem-${id}`);
    const stateBefore = await settingsValue(page, "autoCapture:state");

    for (let start = 0; start < 2; start++) {
      await startApp(page);
      await page.waitForTimeout(SETTLE);
      expect(calls.capture.length, "no Capture while the Memory is missing").toBe(0);
      expect(await memoryRow(page, `mem-${id}`), "no Memory is made up for it").toBeUndefined();
      expect((await memoriesOf(page, id)).length).toBe(0);
      const stored = (await rows(page, "conversations")).find((c) => c.id === id);
      expect(stored.status, "not taken as finished").toBe("active");
      expect(stored.memoryObjectIds, "the reference stays").toEqual([`mem-${id}`]);
      expect((await filesWith(page, "架空の保存済みの記憶")).length, "the Memory file stays").toBe(1);
      expect(await settingsValue(page, "autoCapture:state"), "no attempt or daily count is used").toEqual(stateBefore);
    }
    await nav(page).getByRole("button", { name: "設定" }).click();
    await expect(page.getByTestId("auto-capture-held"), "Settings says it is waiting").toContainText("1 件", { timeout: 30_000 });
    await expect(page.getByTestId("auto-capture-summary")).toContainText("未処理 0 件");

    await page.goto(`${BASE}/data`);
    await page.addScriptTag({ path: bundle });
    await page.evaluate(async (memory) => { await (window as any).D.dbm.importMissingRecordsIfAbsent({ conversations: [], memoryObjects: [memory], sources: [] }); }, original);

    for (let start = 0; start < 2; start++) {
      await startApp(page);
      await page.waitForTimeout(SETTLE);
      expect(calls.capture.length, "no Capture once it is back").toBe(0);
      const memories = await memoriesOf(page, id);
      expect(memories.map((m) => m.id), "only the original").toEqual([`mem-${id}`]);
      expect((await rows(page, "conversations")).find((c) => c.id === id).memoryObjectIds).toEqual([`mem-${id}`]);
    }
    await nav(page).getByRole("button", { name: "設定" }).click();
    await expect(page.getByTestId("auto-capture-summary")).toContainText("未処理 0 件", { timeout: 30_000 });
    await expect(page.getByTestId("auto-capture-held")).toHaveCount(0);
  });

  test("it does not hold back another conversation: the other one goes, once", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "refers", ago: 300 * MIN, memoryIds: ["mem-gone"] }, { id: "free", ago: 120 * MIN }]);
    const calls = await fakeApi(page);
    await startApp(page);
    await captureSeen(calls, 1);
    expect(calls.capture[0]).toContain(said("free"));
    await expect.poll(() => statusOf(page, "free"), { timeout: 30_000 }).toBe("captured");
    expect(await statusOf(page, "refers")).toBe("active");
    expect((await memoriesOf(page, "refers")).length).toBe(0);
  });

  for (const arrives of ["its Memory", "the reference to its Memory"]) {
    test(`${arrives} comes back during the AI call: the result is thrown away, nothing is marked done, and the next start calls nothing`, async ({ page }) => {
      test.setTimeout(180_000);
      await seed(page, [{ id: "late", ago: 120 * MIN }]);
      let release = () => {}; const held = new Promise<void>((r) => { release = r; });
      const calls = await fakeApi(page, () => ({ hold: held }));
      await startApp(page);
      await captureSeen(calls, 1);
      if (arrives === "its Memory") await putRow(page, "memoryObjects", fictionalMemory("mem-late", "late"));
      else await putRow(page, "conversations", { ...(await rows(page, "conversations")).find((c) => c.id === "late"), memoryObjectIds: ["mem-late"] });
      release();
      await page.waitForTimeout(3_000);
      expect((await memoriesOf(page, "late")).filter((m) => m.id !== "mem-late"), "no second Memory").toEqual([]);
      const stored = (await rows(page, "conversations")).find((c) => c.id === "late");
      expect(stored.status).toBe("active");
      if (arrives !== "its Memory") expect(stored.memoryObjectIds, "the reference is not overwritten").toEqual(["mem-late"]);
      expect(await usedToday(page), "the request stays counted").toBe(1);
      await startApp(page);
      await page.waitForTimeout(SETTLE);
      expect(calls.capture.length).toBe(1);
    });
  }

  for (const [what, from, to] of [
    ["refers to a Memory", "^status: .*$", 'status: "active"\nmemoryObjectIds: ["架空の別端末のMemory"]'],
    ["says captured", "^status: .*$", 'status: "captured"'],
  ] as const) {
    test(`the Vault file, with the same words, ${what} (another device finished it): nothing is sent, and the file stays`, async ({ page }) => {
      test.setTimeout(180_000);
      const words = said(`別端末${what.length}`);
      await seed(page);
      const calls = await fakeApi(page);
      await startApp(page);
      await talkFromHome(page, words);
      await fileIsWritten(page, words);
      const { id } = await withWords(page, words);
      await backdate(page, id);
      await nothingLeftToSave(page, id);
      expect(await rewriteFile(page, words, from, to)).toBe(true);
      const file = (await filesWith(page, words))[0];
      await startApp(page);
      await page.waitForTimeout(SETTLE);
      expect(calls.capture.length, "no Capture").toBe(0);
      expect((await memoriesOf(page, id)).length).toBe(0);
      expect((await filesWith(page, words))[0], "the file is as it was").toBe(file);
    });
  }

  test("the save refuses when a Memory or a reference arrived, for the automatic run only; the end of a conversation saves as before", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [{ id: "a", ago: 120 * MIN }, { id: "b", ago: 120 * MIN }, { id: "c", ago: 120 * MIN }, { id: "d", ago: 120 * MIN }], undefined, { enabled: false });
    const outcomes = await page.evaluate(async () => {
      const { dbm } = (window as any).D;
      const T = new Date().toISOString();
      const later = new Date(Date.now() + 60_000).toISOString();
      const memory = (id: string, conversationId: string) => ({ id, date: T, types: ["conversation"], conversationId, content: "架空の記憶", summary: "架空の要約", keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: { id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
      const commit = async (id: string, onlyIfNoMemory: boolean) => {
        const read = await dbm.getConversation(id);
        const r = await dbm.commitCaptureResult({ ...read, status: "captured", memoryObjectIds: [`new-${id}`], updatedAt: later }, [{ memory: memory(`new-${id}`, id), recordType: "memory" }], read.updatedAt, undefined, { onlyIfNoMemory });
        const after = await dbm.getConversation(id);
        return [r.outcome, after.status, after.memoryObjectIds, !!(await dbm.getMemoryObject(`new-${id}`))];
      };
      const arrive = async (id: string) => { const c = await dbm.getConversation(id); await dbm.putConversationWithOutbox({ ...c, memoryObjectIds: ["arrived"] }); };
      await dbm.putMemoryObjectWithOutbox(memory("arrived-a", "a"));
      const a = await commit("a", true);
      const b = await (async () => { const read = await dbm.getConversation("b"); await arrive("b"); const r = await dbm.commitCaptureResult({ ...read, status: "captured", memoryObjectIds: ["new-b"], updatedAt: later }, [{ memory: memory("new-b", "b"), recordType: "memory" }], read.updatedAt, undefined, { onlyIfNoMemory: true }); const after = await dbm.getConversation("b"); return [r.outcome, after.status, after.memoryObjectIds, !!(await dbm.getMemoryObject("new-b"))]; })();
      return { a, b, c: await commit("c", true), d: await commit("d", false) };
    });
    expect(outcomes.a).toEqual(["conversation-changed", "active", [], false]);
    expect(outcomes.b).toEqual(["conversation-changed", "active", ["arrived"], false]);
    expect(outcomes.c).toEqual(["committed", "captured", ["new-c"], true]);
    expect(outcomes.d).toEqual(["committed", "captured", ["new-d"], true]);
  });
});

test.describe("which AI held it, once a Vault version is taken in", () => {
  test("a change elsewhere that leaves the words (a title): the record that Gemini held it stays, so it goes without the permission", async ({ page }) => {
    test.setTimeout(300_000);
    const words = said("題だけ変更");
    await seed(page, [], undefined, { enabled: false, allowOtherProviders: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, words);
    await fileIsWritten(page, words);
    const { id } = await withWords(page, words);
    expect(await providersOf(page, words)).toEqual(["gemini"]);
    await backdate(page, id);
    await nothingLeftToSave(page, id);
    expect(await rewriteFile(page, words, "^status: .*$", '$&\ntitle: "架空の別端末で付けた題"')).toBe(true);
    await startApp(page);
    await takeInEdit(page);
    expect((await withWords(page, words)).title, "the version was taken in").toBe("架空の別端末で付けた題");
    expect(await providersOf(page, words), "nothing lost").toEqual(["gemini"]);
    await backdate(page, id);
    await nothingLeftToSave(page, id);
    await autoCaptureSetting(page, true, false);
    await startApp(page);
    await captureSeen(calls, 1);
  });

  for (const pending of [false, true]) {
    test(`words changed elsewhere and taken in${pending ? ", with a save pending here (a choice of versions)" : ""}: no longer known, so it waits for the permission, and goes with it`, async ({ page }) => {
      test.setTimeout(300_000);
      const words = said(pending ? "別端末で続けた保存待ち" : "別端末で続けた");
      const EDIT = "架空の別のAIとの続き";
      await seed(page, [], undefined, { enabled: false, allowOtherProviders: false });
      const calls = await fakeApi(page);
      await startApp(page);
      await talkFromHome(page, words);
      await fileIsWritten(page, words);
      const { id } = await withWords(page, words);
      await backdate(page, id);
      if (pending) await leaveSavePending(page, id); else await nothingLeftToSave(page, id);
      expect(await editFile(page, words, EDIT)).toBe(true);
      await startApp(page);
      await takeInEdit(page);
      expect(await conversationWords(page, id), "the version was taken in").toContain(EDIT);
      expect(await providersOf(page, words), "no longer known").toContain("unknown");
      await backdate(page, id);
      await autoCaptureSetting(page, true, false);
      await startApp(page);
      await page.waitForTimeout(SETTLE);
      expect(calls.capture.length, "not without the permission").toBe(0);
      await autoCaptureSetting(page, true, true);
      await startApp(page);
      await captureSeen(calls, 1);
      expect(calls.capture[0]).toContain(EDIT);
    });
  }
});

test.describe("the folder permission is given back after the start", () => {
  test("once given, the run goes, one conversation in this start, and nothing more", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "first", ago: 180 * MIN }, { id: "second", ago: 120 * MIN }]);
    const calls = await fakeApi(page);
    await permissionLostAtStart(page);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls), "nothing without the folder").toBe(0);
    await nav(page).getByRole("button", { name: "設定" }).click();
    await giveBackPermission(page);
    await captureSeen(calls, 1);
    expect(calls.capture[0]).toContain(said("first"));
    await page.waitForTimeout(SETTLE * 2);
    expect(calls.capture.length, "one conversation per start").toBe(1);
    allWithUserKey(calls);
    await expect.poll(() => statusOf(page, "first"), { timeout: 30_000 }).toBe("captured");
    expect(await statusOf(page, "second")).toBe("active");
  });

  test("with the setting off, or nothing to do, giving it back calls no AI", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [{ id: "off", ago: 120 * MIN }], undefined, { enabled: false });
    const calls = await fakeApi(page);
    await permissionLostAtStart(page);
    await startApp(page);
    await nav(page).getByRole("button", { name: "設定" }).click();
    await giveBackPermission(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls)).toBe(0);
    await autoCaptureSetting(page, true, true);
    await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      await new Promise<void>((res, rej) => { const t = db.transaction("conversations", "readwrite"); const s = t.objectStore("conversations"); const g = s.get("off"); g.onsuccess = () => s.put({ ...g.result, status: "captured" }); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
      db.close();
    });
    await startApp(page);
    await nav(page).getByRole("button", { name: "設定" }).click();
    await giveBackPermission(page);
    await page.waitForTimeout(SETTLE);
    expect(aiCalls(calls), "nothing to do").toBe(0);
  });
});

test.describe("another device finished the conversation: what this device does with it", () => {
  test("a save still pending here does not take back captured or the Memory reference, and no Memory is made again", async ({ page }) => {
    test.setTimeout(300_000);
    const words = said("別端末で処理済み保存待ち");
    await seed(page);
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, words);
    await fileIsWritten(page, words);
    const { id } = await withWords(page, words);
    await backdate(page, id);
    await leaveSavePending(page, id);
    expect(await rewriteFile(page, words, "^status: .*$", 'status: captured\nmemoryObjectIds: [FICTIONALOTHERDEVICEMEMORY1]')).toBe(true);
    for (let start = 0; start < 2; start++) {
      await startApp(page);
      await page.waitForTimeout(SETTLE);
      expect(calls.capture.length, "no Capture").toBe(0);
      const file = (await filesWith(page, words))[0];
      expect(file, "the file keeps captured").toMatch(/^status: "?captured"?$/m);
      expect(file, "the file keeps the reference").toContain("FICTIONALOTHERDEVICEMEMORY1");
    }
    await takeInEdit(page);
    const stored = (await rows(page, "conversations")).find((c) => c.id === id);
    expect(stored.status).toBe("captured");
    expect(stored.memoryObjectIds).toEqual(["FICTIONALOTHERDEVICEMEMORY1"]);
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length).toBe(0);
    expect((await memoriesOf(page, id)).length).toBe(0);
  });

  test("end of a conversation: the file says another device finished it, so no Capture, and the file stays", async ({ page }) => {
    test.setTimeout(180_000);
    const words = said("別端末で処理済み終了");
    await seed(page, [], undefined, { enabled: false });
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, words);
    await fileIsWritten(page, words);
    const { id } = await withWords(page, words);
    expect(await rewriteFile(page, words, "^status: .*$", 'status: captured\nmemoryObjectIds: [FICTIONALOTHERDEVICEMEMORY1]')).toBe(true);
    await goHome(page);
    await page.waitForTimeout(3_000);
    expect(calls.capture.length, "no Capture").toBe(0);
    expect((await memoriesOf(page, id)).length).toBe(0);
    expect((await filesWith(page, words))[0]).toContain("FICTIONALOTHERDEVICEMEMORY1");
  });
});

test.describe("startup Memory creation: limits", () => {
  test("nothing to send, no AI call at all: already captured, recently touched, without an AI reply, or ending in a cut reply", async ({ page }) => {
    test.setTimeout(120_000);
    await seed(page, [
      { id: "done-1", ago: 120 * MIN, status: "captured" },
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
    expect(aiCalls(calls)).toBe(0);
    for (const id of ["recent", "no-reply", "cut"]) expect(await statusOf(page, id)).toBe("active");
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

/** the Settings screen as the user leaves it after choosing an AI */
const choose = (page: Page, provider: "gemini" | "openai") => page.evaluate(async (p) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise<void>((res, rej) => { const t = db.transaction("settings", "readwrite"); t.objectStore("settings").put(p, "chatProvider"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  db.close();
}, provider);
type AiCall = { api: string; ai?: string; gemini?: string; openai?: string; only?: string };
/** every request named this AI and carried that AI's key only (never the other AI's key) */
const allTo = (list: AiCall[], ai: "gemini" | "openai") => {
  expect(list.length, "requests were made").toBeGreaterThan(0);
  expect(list.filter((r) => r.ai !== ai), "a request to another AI").toEqual([]);
  if (ai === "openai") expect(list.filter((r) => r.gemini !== undefined || r.openai !== "fictional-openai-key"), "a request without the OpenAI key, or with the Gemini key").toEqual([]);
  else expect(list.filter((r) => r.openai !== undefined), "a request with the OpenAI key").toEqual([]);
};

test.describe("the AI the user chose is where everything goes", () => {
  test("OpenAI key only, OpenAI chosen: the startup run, the chat, the end of a conversation, Connect, the question and the day's reflection all go to OpenAI with its key; a Gemini conversation waits", async ({ page }) => {
    test.setTimeout(300_000);
    await seed(page, [{ id: "oa-old", ago: 240 * MIN, chatProviders: ["openai"] }, { id: "gm-old", ago: 300 * MIN, chatProviders: ["gemini"] }], undefined,
      { key: false, openaiKey: true, chosen: "openai", allowOtherProviders: false });
    const calls = await fakeApi(page);
    calls.connectAnswers = true;
    await startApp(page);
    await captureSeen(calls, 1);
    await expect.poll(() => statusOf(page, "oa-old"), { timeout: 40_000 }).toBe("captured");
    expect(calls.capture[0], "the conversation held with OpenAI").toContain(said("oa-old"));
    expect(await statusOf(page, "gm-old"), "held with Gemini: not sent to OpenAI without the permission").toBe("active");
    expect((await memoriesOf(page, "oa-old"))[0]?.metadata?.aiProvider, "the Memory says which AI made it").toBe("openai");
    // a conversation and its end
    await talkFromHome(page, said("OpenAI会話"));
    await goHome(page);
    await captureSeen(calls, 2);
    const c = await withWords(page, said("OpenAI会話"));
    await expect.poll(() => statusOf(page, c.id), { timeout: 40_000 }).toBe("captured");
    // the diary and the day's reflection
    await page.getByRole("button", { name: "日記", exact: true }).click();
    await talk(page, said("OpenAI日記"));
    await page.getByRole("button", { name: "本日はここまで" }).click();
    await expect(page.getByText("架空の振り返りです。")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => calls.connect, { timeout: 30_000 }).toBeGreaterThan(0);
    const reflection = (await rows(page, "memoryObjects")).find((m) => m.types?.includes("insight"));
    expect(reflection?.metadata?.aiProvider).toBe("openai");
    for (const api of ["chat", "capture", "connect", "reflect"]) expect(calls.ai.some((r) => r.api === api), `${api} was asked`).toBe(true);
    allTo(calls.ai, "openai");
    expect(calls.ai.find((r) => r.api === "capture")?.only, "the startup run is marked: never a provided key").toBe("1");
    expect(await statusOf(page, "gm-old")).toBe("active");
  });

  test("both keys, OpenAI chosen: the Gemini key is never sent; Gemini chosen: the OpenAI key is never sent", async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page, [], undefined, { enabled: false, openaiKey: true, chosen: "openai" });
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("両方OpenAI"));
    await goHome(page);
    await captureSeen(calls, 1);
    allTo(calls.ai, "openai");
    await choose(page, "gemini");
    calls.ai.length = 0;
    await startApp(page);
    await talkFromHome(page, said("両方Gemini"));
    await goHome(page);
    await captureSeen(calls, 2);
    allTo(calls.ai, "gemini");
    expect(calls.ai.find((r) => r.api === "capture")?.gemini).toBe("fictional-test-key");
  });

  test("OpenAI chosen with no key on the device: the real server refuses, nothing reaches any AI and Gemini's provided key is not used; the run sends nothing", async ({ page }) => {
    test.setTimeout(240_000);
    await seed(page, [{ id: "nk-1", ago: 120 * MIN, chatProviders: ["openai"] }], undefined, { key: false, chosen: "openai", allowOtherProviders: false });
    const statuses: { api: string; status: number }[] = [];
    page.on("response", (r) => { const m = r.url().match(/\/api\/(chat|capture|connect|prompt|reflect)\b/); if (m) statuses.push({ api: m[1], status: r.status() }); });
    const requests: AiCall[] = [];
    page.on("request", (r) => { const m = r.url().match(/\/api\/(chat|capture|connect|prompt|reflect)\b/); if (m) { const h = r.headers(); requests.push({ api: m[1], ai: h["x-ai-provider"], gemini: h["x-gemini-api-key"], openai: h["x-openai-api-key"] }); } });
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(requests.filter((r) => r.api === "capture"), "the startup run sends nothing without the chosen AI's key").toEqual([]);
    await page.getByRole("button", { name: "会話", exact: true }).click();
    await page.locator("footer textarea").fill(said("キーなしOpenAI"));
    await page.locator("footer").getByRole("button", { name: "送る" }).click();
    await expect.poll(() => statuses.find((s) => s.api === "chat")?.status, { timeout: 30_000 }).toBe(401);
    await goHome(page);
    await page.waitForTimeout(SETTLE);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.ai !== "openai" || r.gemini !== undefined || r.openai !== undefined), "every request named OpenAI and carried no key").toEqual([]);
    expect(statuses.filter((s) => s.status !== 401), "the server refused every one").toEqual([]);
    expect(await statusOf(page, "nk-1")).toBe("active");
  });

  test("switching the AI: a conversation held with Gemini is not sent to OpenAI at its end, nor by the run; with the permission it goes to OpenAI once", async ({ page }) => {
    test.setTimeout(300_000);
    await seed(page, [], undefined, { enabled: false, allowOtherProviders: false, openaiKey: true });
    const calls = await fakeApi(page);
    await startApp(page);
    await talkFromHome(page, said("切替前"));
    const c = await withWords(page, said("切替前"));
    expect(c.chatProviders).toEqual(["gemini"]);
    await choose(page, "openai");
    const afterSwitch = calls.ai.length;
    await page.getByRole("button", { name: "この会話を終える" }).click();
    await expect(page.getByText(/いま選んでいるAI以外で話した部分があるため/)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length, "nothing went to OpenAI").toBe(0);
    expect(await statusOf(page, c.id), "kept as it was, for later").toBe("active");
    await backdate(page, c.id);
    await page.goto(`${BASE}/data`);
    await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      await new Promise<void>((res, rej) => { const t = db.transaction("settings", "readwrite"); t.objectStore("settings").put(JSON.stringify({ enabled: true, allowOtherProviders: false }), "autoCapture:settings"); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
      db.close();
    });
    await startApp(page);
    await page.waitForTimeout(SETTLE);
    expect(calls.capture.length, "the run does not send it to OpenAI either").toBe(0);
    await nav(page).getByRole("button", { name: "設定" }).click();
    await expect(page.getByTestId("auto-capture-summary")).toContainText("許可待ち 1 件", { timeout: 30_000 });
    await expect(page.getByTestId("auto-capture")).toContainText("OpenAI以外のAIでも話した会話");
    await page.getByTestId("auto-capture-other-providers").check();
    await startApp(page);
    await captureSeen(calls, 1);
    await expect.poll(() => statusOf(page, c.id), { timeout: 40_000 }).toBe("captured");
    allTo(calls.ai.slice(afterSwitch), "openai");
    expect((await memoriesOf(page, c.id)).length).toBe(1);
  });

  test("removing the chosen AI's key does not switch to another AI: requests still name OpenAI, and nothing goes to Gemini", async ({ page }) => {
    test.setTimeout(180_000);
    await seed(page, [], undefined, { enabled: false, openaiKey: true, chosen: "openai" });
    const calls = await fakeApi(page);
    await startApp(page);
    await nav(page).getByRole("button", { name: "設定" }).click();
    await page.getByText("OpenAI APIキー：設定済み").locator("..").getByRole("button", { name: "削除" }).click();
    await expect(page.getByText("OpenAI APIキー：未設定")).toBeVisible({ timeout: 30_000 });
    const chosen = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((res, rej) => { const q = indexedDB.open("tsumugi"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const v = await new Promise((res, rej) => { const q = db.transaction("settings").objectStore("settings").get("chatProvider"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      db.close(); return v;
    });
    expect(chosen, "the choice stays OpenAI").toBe("openai");
    await startApp(page);
    await talkFromHome(page, said("削除後"));
    expect(calls.ai.filter((r) => r.ai !== "openai" || r.gemini !== undefined), "nothing named Gemini or carried its key").toEqual([]);
  });
});
