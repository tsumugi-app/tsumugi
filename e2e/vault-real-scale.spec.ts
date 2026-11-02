/* eslint-disable @typescript-eslint/no-explicit-any */
// The whole way from start-up to a normal save at the size of a real Android device (113 conversations, 130 Memories, about 1 MB of Vault), in the real app: real IndexedDB, Web Locks and OPFS,
// Android emulation and a slowed CPU. The shape comes from a read-only look at a real backup (counts, sizes and field names only); every word, id and date here is fictional.
// Not reproduced: a real phone's storage speed, its memory pressure, and what happened on the device between the backup and now.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const LATEST = "✓ 最新の状態です";
const BUSY = "他の操作が実行中";
const CPU_SLOWDOWN = 4;
test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

/** counts and times every lock, file and IndexedDB call of the page, without touching the app */
function installTrace() {
  const t: any = { locks: [], files: {}, idb: {}, long: { count: 0, ms: 0, max: 0 }, marks: {} };
  (window as any).__trace = t;
  const bump = (o: any, k: string, ms: number) => { const e = (o[k] ??= { n: 0, ms: 0 }); e.n += 1; e.ms += ms; };
  const proto: any = (window as any).LockManager?.prototype;
  if (proto) {
    const request = proto.request;
    proto.request = function (name: string, a: any, b: any) {
      const fn = typeof a === "function" ? a : b, opts = typeof a === "function" ? {} : a;
      const row: any = { name, mode: opts.mode ?? "exclusive", at: performance.now(), got: null, end: null, abandoned: false };
      t.locks.push(row);
      const wrapped = async (lock: any) => { row.got = performance.now(); try { return await fn(lock); } finally { row.end = performance.now(); } };
      const out = request.call(this, name, opts, wrapped);
      out.catch(() => { row.abandoned = true; });
      return out;
    };
  }
  const dirName = new WeakMap<object, string>();
  const dirProto: any = (window as any).FileSystemDirectoryHandle?.prototype, fileProto: any = (window as any).FileSystemFileHandle?.prototype;
  if (dirProto && fileProto) {
    const area = (dir: any) => (dir.name === "" ? "root" : dir.name);
    const getFileHandle = dirProto.getFileHandle;
    dirProto.getFileHandle = async function (name: string, o: any) {
      const start = performance.now();
      try { const h = await getFileHandle.call(this, name, o); dirName.set(h, area(this)); return h; }
      finally { bump(t.files, `handle:${area(this)}`, performance.now() - start); }
    };
    const entries = dirProto.entries;
    dirProto.entries = function () { bump(t.files, `list:${area(this)}`, 0); const it = entries.call(this); return it; };
    const getFile = fileProto.getFile;
    fileProto.getFile = async function () {
      const start = performance.now();
      try { return await getFile.call(this); } finally { bump(t.files, `read:${dirName.get(this) ?? "?"}`, performance.now() - start); }
    };
    const createWritable = fileProto.createWritable;
    fileProto.createWritable = async function (o: any) {
      bump(t.files, `write:${dirName.get(this) ?? "?"}`, 0);
      return createWritable.call(this, o);
    };
  }
  const storeProto: any = IDBObjectStore.prototype;
  for (const op of ["get", "getAll", "getAllKeys", "put", "delete", "count"]) {
    const original = storeProto[op];
    storeProto[op] = function (...args: any[]) {
      const start = performance.now(), key = `${op}:${this.name}`;
      const request = original.apply(this, args);
      request.addEventListener("success", () => bump(t.idb, key, performance.now() - start));
      return request;
    };
  }
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { t.long.count += 1; t.long.ms += e.duration; t.long.max = Math.max(t.long.max, e.duration); } }).observe({ type: "longtask", buffered: true });
  } catch { /* not supported */ }
}

const round = (n: number) => Math.round(n);
/** the numbers of one page load: no ids, no paths below the top folder, no text */
const traceSummary = (page: Page) => page.evaluate(() => {
  const t = (window as any).__trace, r = (n: number) => Math.round(n);
  const world = t.locks.filter((l: any) => l.name === "tsumugi-vault-world");
  const holds = world.filter((l: any) => l.got !== null).map((l: any) => ({ mode: l.mode[0], from: r(l.got), hold: l.end === null ? `open(${r(performance.now() - l.got)})` : r(l.end - l.got), wait: r(l.got - l.at) }));
  const long = world.filter((l: any) => l.got !== null && (l.end ?? performance.now()) - l.got > 500);
  const others: Record<string, { n: number; hold: number; wait: number }> = {};
  for (const l of t.locks) {
    if (l.got === null) continue;
    const k = String(l.name).replace(/\d{4}-\d{2}-\d{2}/, "day"); const e = (others[k] ??= { n: 0, hold: 0, wait: 0 });
    e.n += 1; e.hold += (l.end ?? performance.now()) - l.got; e.wait += l.got - l.at;
  }
  const brief = (o: any) => Object.fromEntries(Object.entries<any>(o).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, `${v.n}/${r(v.ms)}ms`]));
  return { now: r(performance.now()), longTasks: { n: t.long.count, ms: r(t.long.ms), max: r(t.long.max) }, marks: t.marks, worldHeldOver500ms: long.length, worldHolds: holds.slice(0, 40),
    locks: Object.fromEntries(Object.entries(others).map(([k, v]) => [k, `${v.n}x hold ${r(v.hold)}ms wait ${r(v.wait)}ms`])), files: brief(t.files), idb: brief(t.idb) };
});
function report(title: string, value: unknown) {
  // annotations of the workflow run are readable without logging in. The limit is about 4 KB each
  const text = JSON.stringify(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, 3900);
  process.stdout.write(`\n::notice title=${title}::${text}\n`);
}

async function slowCpu(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
}

/** a fictional world of the real size, saved through the normal Outbox and the normal start-up, then given the real device's two older shapes */
async function seedWorld(page: Page) {
  await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
  return page.evaluate(async () => {
    const { dbm, bootstrap, proj, vault } = (window as any).D;
    const root = await navigator.storage.getDirectory();
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); await dbm.markAndroidOpfsVaultInitialized();
    const start = Date.parse("2026-08-01T09:00:00.000Z"), iso = (ms: number) => new Date(ms).toISOString(), DAY = 86_400_000;
    const filler = (seed: number, length: number) => { let s = ""; while (s.length < length) s += `架空の話題${seed}について話した架空の文章です。`; return s.slice(0, length); };
    const meta = (id: string, at: string, source = "ai-capture") => ({ id: `meta-${id}`, source, sourceType: "chat", schemaVersion: "0.1", createdAt: at, updatedAt: at });
    const conversations: any[] = [];
    for (let i = 0; i < 113; i++) {
      const id = `scale-conv-${String(i).padStart(3, "0")}`, at = start + i * (DAY * 0.7), turnCount = i === 20 ? 14 : i === 40 ? 16 : 2 + 2 * (i % 7), blank = i === 20 ? 9 : i === 40 ? 7 : -1;
      const turns = Array.from({ length: turnCount }, (_, k) => ({ role: k % 2 ? "ai" : "user", content: k === blank ? "" : filler(i * 100 + k, Math.round(2400 / turnCount)), timestamp: iso(at + k * 60_000) }));
      const end = iso(at + turnCount * 60_000);
      conversations.push({ id, persona: "companion", entryType: "chat", status: "captured", startedAt: iso(at), endedAt: end, createdAt: iso(at), updatedAt: end, memoryObjectIds: [], turns, metadata: meta(id, end) });
    }
    for (const c of conversations) await dbm.putConversationWithOutbox(c);
    const memories: any[] = [];
    for (let i = 0; i < 130; i++) {
      const id = `scale-mem-${String(i).padStart(3, "0")}`, isReflection = i >= 124, at = iso(start + (i % 29) * (DAY * 2.7) + i * 1000), source = isReflection ? "system-generated" : "ai-capture";
      const m = { id, date: at, types: [isReflection ? "summary" : "conversation"], conversationId: isReflection ? undefined : conversations[i % 113].id, content: filler(i + 5000, 500), summary: filler(i + 9000, 180), keywords: ["架空"], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at, metadata: meta(id, at, source) };
      memories.push(m);
      await dbm.putMemoryObjectWithOutbox(m, isReflection ? "reflection" : "memory");
    }
    await dbm.setProjectionHeldReevaluationMarker(proj.PROJECTION_HELD_RULE_VERSION, iso(start));
    await bootstrap.runSaveFoundationBootstrap({ root });

    // the older shapes of a real device: every record is in the sync ledger, and 8 old conversations have no Outbox entry and a file without turnTimes
    for (const c of conversations) await dbm.setVaultSyncState(`conversation:${c.id}`, c.updatedAt);
    for (const m of memories) await dbm.setVaultSyncState(`memory:${m.id}`, m.updatedAt);
    const dirOf = await root.getDirectoryHandle("Conversations");
    const legacy = conversations.slice(100, 108);
    const registry = await root.getDirectoryHandle(".tsumugi").then((d: any) => d.getDirectoryHandle("registry"));
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (const c of legacy) {
      await new Promise<void>((res, rej) => { const tx = db.transaction("vaultOutbox", "readwrite"); tx.objectStore("vaultOutbox").delete(`conversation:${c.id}`); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
      for await (const [name, h] of (dirOf as any).entries()) {
        const text: string = await (await h.getFile()).text();
        if (!text.includes(`id: ${c.id}`) && !text.includes(`"${c.id}"`)) continue;
        const next = text.replace(/^turnTimes: .*\n/m, "");
        const w = await h.createWritable(); await w.write(next); await w.close();
        for await (const [, sh] of (registry as any).entries()) {
          const v = JSON.parse(await (await sh.getFile()).text());
          if (v.records?.[c.id] === `Conversations/${name}`) { const row = v.files[`Conversations/${name}`]; row.contentHash = vault.hashVaultText(next); row.size = new TextEncoder().encode(next).length; row.mtime = (await h.getFile()).lastModified; const sw = await sh.createWritable(); await sw.write(JSON.stringify(v)); await sw.close(); }
        }
      }
    }
    db.close();
    const progress = await dbm.readVaultSaveProgress();
    const counts: Record<string, number> = {};
    for (const e of progress.outbox) counts[e.status] = (counts[e.status] ?? 0) + 1;
    return { outbox: counts };
  });
}

/** every Markdown file and every device record, as they are now (compared, never printed) */
const fingerprint = (page: Page) => page.evaluate(async () => {
  const out: Record<string, string> = {};
  const walk = async (dir: any, prefix: string) => { for await (const [name, h] of dir.entries()) { if (h.kind === "directory") { if (name !== "repair-backup") await walk(h, `${prefix}${name}/`); } else out[`${prefix}${name}`] = await (await h.getFile()).text(); } };
  await walk(await navigator.storage.getDirectory(), "");
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  for (const store of ["conversations", "memoryObjects"]) {
    const all: any[] = await new Promise((res, rej) => { const q = db.transaction(store, "readonly").objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    for (const row of all) out[`idb:${store}:${row.id}`] = JSON.stringify(row);
  }
  db.close();
  return out;
});
const changedKeys = (a: Record<string, string>, b: Record<string, string>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
const isRecord = (k: string) => k.startsWith("idb:") || k.startsWith("Conversations/") || k.startsWith("Memories/");
const screenText = (page: Page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1500));

const nav = (page: Page) => page.getByRole("navigation", { name: "メインナビゲーション" });
/** start the app the way a user does, and time it */
async function startApp(page: Page, label: string) {
  const t0 = Date.now();
  await page.goto(BASE);
  const open = page.getByRole("button", { name: "tsumugiを開く" });
  await open.waitFor({ timeout: 120_000 });
  const openVisible = Date.now() - t0;
  await open.click();
  await expect(page.getByText("今日は、どう話そう？")).toBeVisible({ timeout: 120_000 });
  const homeVisible = Date.now() - t0;
  return { label, openVisible, homeVisible, t0 };
}
/** why the check is not clean: fictional ids and the reasons of the plan, for failure messages */
async function whyNotLatest(page: Page) {
  await page.addScriptTag({ path: bundle });
  return page.evaluate(async () => {
    const { lockMod, consistencyCheck, dbm } = (window as any).D; lockMod.setTabVaultEpoch(0);
    const { report, plan } = await consistencyCheck.checkVaultConsistency(await navigator.storage.getDirectory(), () => false, { drainWaitMs: 1000, pollMs: 100, attempts: 2, retryDelayMs: 200 });
    const progress = await dbm.readVaultSaveProgress();
    return JSON.stringify({ state: report.state, findings: report.findings.slice(0, 12).map((f: any) => `${f.recordId}:${f.category}:${f.reason}`), held: plan.held.slice(0, 12), ops: plan.ops.slice(0, 6).map((o: any) => [o.kind, o.steps]), outboxNotDone: progress.outbox.filter((e: any) => e.status !== "done").slice(0, 6).map((e: any) => [e.id, e.status, e.heldReason]) });
  });
}
async function waitLatest(page: Page, timeout = 240_000) {
  try { await expect(page.getByText(LATEST)).toBeVisible({ timeout }); }
  catch { throw new Error(`no 最新. The screen said: ${(await screenText(page)).slice(150, 500)} WHY: ${await whyNotLatest(page)}`); }
}

test("at real size: the empty AI turns are not a conflict anywhere, Settings ends at 「✓ 最新の状態です」, stays there after a reload and a new conversation, and no record changes", async ({ page }) => {
  test.setTimeout(900_000);
  await page.addInitScript(installTrace);
  const seeded = await seedWorld(page);
  report("seed", seeded);
  const before = await fingerprint(page);

  // /recovery-debug
  await page.goto(`${BASE}/recovery-debug`);
  await page.getByRole("button", { name: "診断開始" }).click();
  await expect(page.getByText(/対象 \d+件/)).toBeVisible({ timeout: 120_000 });
  const debug = await page.evaluate(() => document.body.innerText);
  expect(debug).toContain("対象 243件");
  expect(debug).toMatch(/conflict: 0/);
  report("recovery-debug", (debug.match(/^(対象.*|[a-z\- /]+: \d+)$/gm) ?? []).join(" | "));

  await slowCpu(page);
  // the first start of a build: everything is checked
  const first = await startApp(page, "first start");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await waitLatest(page);
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
  const firstLatest = Date.now() - first.t0;
  report("perf-first-start", { ...first, t0: undefined, latest: firstLatest, ...(await traceSummary(page)) });
  const afterFirst = await fingerprint(page);
  expect(changedKeys(before, afterFirst).filter(isRecord)).toEqual([]);
  report("first-start-changed", { files: changedKeys(before, afterFirst).map((k) => k.split("/").slice(0, 2).join("/").replace(/[0-9a-f]{2}\.json$/, "*")).slice(0, 20) });

  // the reload: the warning does not come back
  const second = await startApp(page, "reload");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await waitLatest(page);
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
  const reload = await traceSummary(page);
  report("perf-reload", { ...second, t0: undefined, latest: Date.now() - second.t0, ...reload });
  // a normal start does not read every conversation and does not ask for every ledger row one by one
  expect(parseInt(String(reload.files["read:Conversations"] ?? "0"), 10), JSON.stringify(reload.files)).toBeLessThan(120);
  expect(parseInt(String(reload.idb["get:vaultSyncState"] ?? "0"), 10), JSON.stringify(reload.idb)).toBeLessThan(10);
  expect(changedKeys(before, await fingerprint(page)).filter(isRecord)).toEqual([]);

  // a new conversation is saved as usual, and the state stays clean
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/chat")) await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "架空の返答です。" });
    else await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  const third = await startApp(page, "before a new conversation");
  const inputAt = Date.now();
  await page.getByRole("button", { name: "会話", exact: true }).click();
  await page.locator("footer textarea").fill("架空の新しい話題");
  await page.locator("footer").getByRole("button", { name: "送る" }).click();
  report("perf-first-send", { fromHome: Date.now() - inputAt });
  await expect(page.getByText("架空の返答です。")).toBeVisible({ timeout: 60_000 });
  const saved = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (let i = 0; i < 240; i++) {
      const all: any[] = await new Promise((res, rej) => { const q = db.transaction("vaultOutbox", "readonly").objectStore("vaultOutbox").getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const fresh = all.filter((e) => e.recordType === "conversation" && !e.recordId.startsWith("scale-"));
      if (fresh.length && fresh.every((e) => e.status === "done")) { db.close(); return { status: "done" }; }
      await new Promise((r) => setTimeout(r, 500));
    }
    db.close(); return { status: "not-done" };
  });
  expect(saved.status).toBe("done");
  const fourth = await startApp(page, "after a new conversation");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await waitLatest(page);
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
  report("perf-after-new-conversation", { ...fourth, t0: undefined, latest: Date.now() - fourth.t0, third: third.homeVisible, ...(await traceSummary(page)) });
  const after = await fingerprint(page);
  const changed = changedKeys(before, after).filter((k) => isRecord(k) && !k.includes("scale-") && before[k] !== undefined);
  expect(changed.filter((k) => k.startsWith("idb:"))).toEqual([]);
  for (const k of Object.keys(before)) if (k.startsWith("idb:") || k.startsWith("Conversations/")) expect(after[k], k).toBe(before[k]);
});

test("at real size: two conversations that really differ are found, nothing hides them, and choosing one right after the other is not refused as busy", async ({ page }) => {
  test.setTimeout(900_000);
  await page.addInitScript(installTrace);
  await seedWorld(page);
  // hand edits on two conversations, then a device update of each: the normal save holds them
  await page.evaluate(async () => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("Conversations");
    for (const id of ["scale-conv-001", "scale-conv-002"]) {
      for await (const [, h] of (dir as any).entries()) {
        const text: string = await (await h.getFile()).text();
        if (!text.includes(id)) continue;
        const w = await h.createWritable(); await w.write(text.replace("架空の話題", "手で直した架空の話題")); await w.close();
      }
      const c = await dbm.getConversation(id);
      const at = new Date(Date.parse(c.updatedAt) + 60_000).toISOString();
      await dbm.putConversationWithOutbox({ ...c, updatedAt: at, endedAt: at, turns: [...c.turns, { role: "user", content: "架空の続き", timestamp: at }], metadata: { ...c.metadata, updatedAt: at } });
    }
    await bootstrap.runSaveFoundationBootstrap({ root });
  });
  const debugBefore = await fingerprint(page);
  await slowCpu(page);
  const started = await startApp(page, "with two conflicts");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await expect(page.getByTestId("vault-conflict-item")).toHaveCount(2, { timeout: 240_000 });
  await expect(page.getByText(LATEST)).toHaveCount(0);
  expect(changedKeys(debugBefore, await fingerprint(page)).filter(isRecord)).toEqual([]);

  const chooseDevice = async (item: ReturnType<Page["locator"]>) => {
    await item.getByTestId("vault-conflict-open").click();
    await item.getByTestId("vault-conflict-choice-adopt-device").click({ timeout: 60_000 });
    await item.getByTestId("vault-conflict-confirm").click();
  };
  const startedAt = Date.now();
  await chooseDevice(page.getByTestId("vault-conflict-item").first());
  try { await expect(page.getByTestId("vault-conflict-item")).toHaveCount(1, { timeout: 120_000 }); }
  catch { throw new Error(`the first choice did not settle. The screen said: ${(await screenText(page)).slice(150, 700)} WHY: ${await whyNotLatest(page)} LOCKS: ${await page.evaluate(() => JSON.stringify((window as any).__trace.locks.filter((l: any) => l.name === "tsumugi-vault-world").slice(-10).map((l: any) => [l.mode[0], Math.round(l.at), l.got === null ? "waiting" : Math.round(l.got), l.end === null ? "open" : Math.round(l.end), l.abandoned])))}`); }
  const firstDone = Date.now() - startedAt;
  await expect(page.getByText(LATEST)).toHaveCount(0);   // the other one is still a conflict
  await chooseDevice(page.getByTestId("vault-conflict-item").first());   // right after the first
  const deadline = Date.now() + 240_000;
  while (!(await page.getByText(LATEST).isVisible())) {
    const said = await screenText(page);
    expect(said.includes(BUSY), `refused as busy after ${round((Date.now() - startedAt) / 1000)} s: ${await page.evaluate(() => JSON.stringify((window as any).__trace.locks.filter((l: any) => l.name === "tsumugi-vault-world" && l.got !== null).slice(-12).map((l: any) => [l.mode[0], Math.round(l.got), Math.round((l.end ?? performance.now()) - l.got)])))}`).toBe(false);
    if (Date.now() > deadline) throw new Error(`no 最新. The screen said: ${said.slice(150, 500)} WHY: ${await whyNotLatest(page)}`);
    await page.waitForTimeout(250);
  }
  report("perf-two-choices", { ...started, t0: undefined, firstDone, bothDone: Date.now() - startedAt, ...(await traceSummary(page)) });
});


test("at real size: Settings shows two saves held with the file equal; 保存を再開する on one and at once on the other both finish, a really different record stays a conflict, and after choosing it Settings says 最新 and stays there", async ({ page }) => {
  test.setTimeout(900_000);
  await page.addInitScript(installTrace);
  await seedWorld(page);
  // one really different conversation keeps the attention view (and its 「もう一度確認する」) on screen
  await page.evaluate(async () => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("Conversations");
    for await (const [, h] of (dir as any).entries()) {
      const text: string = await (await h.getFile()).text();
      if (!text.includes("scale-conv-001")) continue;
      const w = await h.createWritable(); await w.write(text.replace("架空の話題", "手で直した架空の話題")); await w.close();
    }
    const c = await dbm.getConversation("scale-conv-001"); const at = new Date(Date.parse(c.updatedAt) + 60_000).toISOString();
    await dbm.putConversationWithOutbox({ ...c, updatedAt: at, endedAt: at, turns: [...c.turns, { role: "user", content: "架空の続き", timestamp: at }], metadata: { ...c.metadata, updatedAt: at } });
    await bootstrap.runSaveFoundationBootstrap({ root });
  });
  await slowCpu(page);
  await startApp(page, "two held saves");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await expect(page.getByTestId("vault-conflict-item")).toHaveCount(1, { timeout: 240_000 });

  // the state the phone showed: both empty-turn conversations held as conflicts while their files are the same. One Registry row also says conflict, as older code recorded it
  const snapshot = () => page.evaluate(async () => {
    const { dbm } = (window as any).D; const root = await navigator.storage.getDirectory();
    const out: Record<string, unknown> = {};
    const walk = async (d: any, prefix: string): Promise<void> => { for await (const [name, h] of d.entries()) { if (h.kind === "directory") await walk(h, `${prefix}${name}/`); else { const t: string = await (await h.getFile()).text(); if (t.includes("scale-conv-020") || t.includes("scale-conv-040")) out[`${prefix}${name}`] = t; } } };
    await walk(await root.getDirectoryHandle("Conversations"), "Conversations/");
    for (const id of ["scale-conv-020", "scale-conv-040"]) out[`idb:${id}`] = JSON.stringify(await dbm.getConversation(id));
    return out;
  });
  const before = await snapshot();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (const id of ["scale-conv-020", "scale-conv-040"]) {
      const e: any = await new Promise((res) => { const q = db.transaction("vaultOutbox").objectStore("vaultOutbox").get(`conversation:${id}`); q.onsuccess = () => res(q.result); });
      e.status = "held"; e.heldReason = "markdown-conflict";
      await new Promise<void>((res) => { const tx = db.transaction("vaultOutbox", "readwrite"); tx.objectStore("vaultOutbox").put(e); tx.oncomplete = () => res(); });
    }
    db.close();
    const registry = await (await root.getDirectoryHandle(".tsumugi")).getDirectoryHandle("registry");
    for await (const [, h] of (registry as any).entries()) {
      const j = JSON.parse(await (await h.getFile()).text());
      const path = j.records?.["scale-conv-040"];
      if (!path) continue;
      j.files[path] = { ...j.files[path], status: "conflict" };
      const w = await h.createWritable(); await w.write(JSON.stringify(j)); await w.close();
    }
  });
  await page.getByRole("button", { name: "もう一度確認する" }).first().click();
  const items = page.getByTestId("vault-conflict-item");
  await expect(items).toHaveCount(3, { timeout: 120_000 });
  for (let i = 0; i < 3; i++) await items.nth(i).getByTestId("vault-conflict-open").click();
  const resume = page.getByTestId("vault-conflict-choice-resume");
  await expect(resume).toHaveCount(2, { timeout: 60_000 });
  await resume.nth(0).click(); await resume.nth(1).click();
  const confirm = page.getByTestId("vault-conflict-confirm");
  await expect(confirm).toHaveCount(2);
  const startedAt = Date.now();
  // one, and at once the other, as the phone's owner did
  await confirm.nth(0).click();
  await confirm.last().click({ timeout: 240_000 }).catch(() => undefined);   // gone if the first already cleared the list
  const deadline = Date.now() + 240_000;
  for (;;) {
    const said = await screenText(page);
    expect(said.includes(BUSY), `refused as busy after ${round((Date.now() - startedAt) / 1000)} s`).toBe(false);
    if (await resume.count() === 0 && await items.count() === 1) break;
    if (Date.now() > deadline) throw new Error(`the resumes did not settle. The screen said: ${said.slice(150, 700)} WHY: ${await whyNotLatest(page)}`);
    await page.waitForTimeout(250);
  }
  report("perf-two-resumes", { done: Date.now() - startedAt });
  // the really different one is still a conflict, nothing hid it
  await expect(page.getByText(LATEST)).toHaveCount(0);
  await expect(items).toHaveCount(1);
  expect(await snapshot()).toEqual(before);
  await items.first().getByTestId("vault-conflict-choice-adopt-device").click({ timeout: 60_000 });
  await items.first().getByTestId("vault-conflict-confirm").click();
  await waitLatest(page);
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
  // nothing keeps the lock, and the warning does not come back
  await page.waitForTimeout(5_000);
  expect(await page.evaluate(() => (window as any).__trace.locks.filter((l: any) => l.name === "tsumugi-vault-world" && l.got !== null && l.end === null).length)).toBe(0);
  await startApp(page, "after the resumes");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await waitLatest(page);
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
  expect(await snapshot()).toEqual(before);
  const left = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(); const registry = await (await root.getDirectoryHandle(".tsumugi")).getDirectoryHandle("registry");
    for await (const [, h] of (registry as any).entries()) { const j = JSON.parse(await (await h.getFile()).text()); const path = j.records?.["scale-conv-040"]; if (path) return j.files[path].status; }
    return null;
  });
  expect(left).toBe("ok");
});

test("at real size: states an older build may have left (a held save with the file already equal, an update held after an empty turn, an empty last turn) end clean by themselves", async ({ page }) => {
  test.setTimeout(600_000);
  await page.addInitScript(installTrace);
  await seedWorld(page);
  const before = await page.evaluate(async () => {
    const { dbm, proj } = (window as any).D; const root = await navigator.storage.getDirectory();
    const identity = await dbm.getVaultIdentityRecord(); const env = { root, vaultIdentity: identity };
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const hold = async (id: string) => { const key = `conversation:${id}`; const e: any = await new Promise((res) => { const q = db.transaction("vaultOutbox").objectStore("vaultOutbox").get(key); q.onsuccess = () => res(q.result); }); e.status = "held"; e.heldReason = "markdown-conflict"; await new Promise<void>((res) => { const tx = db.transaction("vaultOutbox", "readwrite"); tx.objectStore("vaultOutbox").put(e); tx.oncomplete = () => res(); }); };
    // 1: the empty-turn conversation with its save held, the file already the same
    await hold("scale-conv-020");
    // 2: the other one moved on while an older parser refused to update its file
    const c = await dbm.getConversation("scale-conv-040"); const at = new Date(Date.parse(c.updatedAt) + 60_000).toISOString();
    const entry = await dbm.putConversationWithOutbox({ ...c, updatedAt: at, endedAt: at, turns: [...c.turns, { role: "user", content: "架空の続き", timestamp: at }], metadata: { ...c.metadata, updatedAt: at } });
    await hold("scale-conv-040"); void entry;
    // 3: an empty last turn, and the conversation goes on through the normal save
    const d = await dbm.getConversation("scale-conv-060"); const at1 = new Date(Date.parse(d.updatedAt) + 60_000).toISOString();
    const first = await dbm.putConversationWithOutbox({ ...d, updatedAt: at1, endedAt: at1, turns: [...d.turns, { role: "ai", content: "", timestamp: at1 }], metadata: { ...d.metadata, updatedAt: at1 } });
    const r1 = await proj.reconcileConversationOutboxEntry(env, first);
    const at2 = new Date(Date.parse(at1) + 60_000).toISOString();
    const next = await dbm.getConversation("scale-conv-060");
    const second = await dbm.putConversationWithOutbox({ ...next, updatedAt: at2, endedAt: at2, turns: [...next.turns, { role: "user", content: "架空の言い直し", timestamp: at2 }], metadata: { ...next.metadata, updatedAt: at2 } });
    const r2 = await proj.reconcileConversationOutboxEntry(env, second);
    db.close();
    return { r1: r1.status, r2: r2.status, reason: (r2 as any).reason ?? null };
  });
  expect(before).toEqual({ r1: "done", r2: "done", reason: null });
  await slowCpu(page);
  await startApp(page, "older states");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await waitLatest(page);
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
  await startApp(page, "older states, again");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await waitLatest(page);
  await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
  const turns = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const read = (id: string) => new Promise<any>((res) => { const q = db.transaction("conversations").objectStore("conversations").get(id); q.onsuccess = () => res(q.result); });
    const out = { a: (await read("scale-conv-020")).turns.map((t: any) => t.content === ""), b: (await read("scale-conv-040")).turns.length, c: (await read("scale-conv-060")).turns.slice(-2).map((t: any) => t.content) };
    db.close(); return out;
  });
  expect(turns.a.filter(Boolean).length).toBe(1); expect(turns.a[9]).toBe(true);
  expect(turns.b).toBe(17);
  expect(turns.c).toEqual(["", "架空の言い直し"]);
});

test("a long background read does not get a choice refused as busy, and a choice waiting for it does not stop normal reads and writes", async ({ page }) => {
  test.setTimeout(600_000);
  await page.addInitScript(installTrace);
  await seedWorld(page);
  await page.evaluate(async () => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("Conversations");
    for await (const [, h] of (dir as any).entries()) {
      const text: string = await (await h.getFile()).text();
      if (!text.includes("scale-conv-001")) continue;
      const w = await h.createWritable(); await w.write(text.replace("架空の話題", "手で直した架空の話題")); await w.close();
    }
    const c = await dbm.getConversation("scale-conv-001"); const at = new Date(Date.parse(c.updatedAt) + 60_000).toISOString();
    await dbm.putConversationWithOutbox({ ...c, updatedAt: at, endedAt: at, turns: [...c.turns, { role: "user", content: "架空の続き", timestamp: at }], metadata: { ...c.metadata, updatedAt: at } });
    await bootstrap.runSaveFoundationBootstrap({ root });
  });
  await startApp(page, "long read");
  await nav(page).getByRole("button", { name: "設定" }).click();
  const item = page.getByTestId("vault-conflict-item");
  await expect(item).toHaveCount(1, { timeout: 240_000 });
  await page.waitForTimeout(3_000);
  await item.getByTestId("vault-conflict-open").click();
  await item.getByTestId("vault-conflict-choice-adopt-device").click({ timeout: 60_000 });
  // a background read longer than the old 15 s limit, as a slow phone's start-up or check takes
  await page.evaluate(() => { (window as any).__release = null; void navigator.locks.request("tsumugi-vault-world", { mode: "shared" }, () => new Promise<void>((resolve) => { (window as any).__release = resolve; })); });
  await expect.poll(() => page.evaluate(() => (window as any).__release !== null)).toBe(true);
  await item.getByTestId("vault-conflict-confirm").click();
  await page.waitForTimeout(18_000);
  // while the choice waits, a normal shared read goes straight through (no queue behind a waiting exclusive lock)
  const readWait = await page.evaluate(async () => { const at = performance.now(); await navigator.locks.request("tsumugi-vault-world", { mode: "shared" }, async () => undefined); return Math.round(performance.now() - at); });
  report("perf-read-while-a-choice-waits", { readWait });
  expect(readWait).toBeLessThan(2_000);
  expect(await screenText(page)).not.toContain(BUSY);
  await page.evaluate(() => (window as any).__release());
  try { await waitLatest(page, 120_000); }
  catch (error) { throw new Error(`${(error as Error).message} LOCKS ${await page.evaluate(() => JSON.stringify((window as any).__trace.locks.filter((l: any) => l.name === "tsumugi-vault-world").slice(-8).map((l: any) => [l.mode[0], Math.round(l.at), l.got === null ? "waiting" : Math.round(l.got), l.end === null ? "open" : Math.round(l.end)])))}`); }
  // nothing keeps the lock after the work is done
  await page.waitForTimeout(5_000);
  const open = await page.evaluate(() => (window as any).__trace.locks.filter((l: any) => l.name === "tsumugi-vault-world" && l.got !== null && l.end === null).length);
  expect(open).toBe(0);
});

test("a tab left running on an older build says so, shows its build, and offers no repair or conflict choice until it is reloaded", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
  await page.evaluate(async () => {
    const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); await dbm.markAndroidOpfsVaultInitialized();
    const T = new Date(Date.now() - 86_400_000).toISOString();
    await dbm.putConversationWithOutbox({ id: "build-conv", persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, memoryObjectIds: [], turns: [{ role: "user", content: "架空の話", timestamp: T }], metadata: { id: "meta-build", source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T } });
    await bootstrap.runSaveFoundationBootstrap({ root });
  });
  await page.route("**/api/build", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ build: "a-newer-build" }) }));
  await startApp(page, "older build");
  await nav(page).getByRole("button", { name: "設定" }).click();
  await expect(page.getByTestId("app-outdated")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("app-build")).toBeVisible();
  await page.unroute("**/api/build");
  await page.getByTestId("app-outdated-reload").click();
  await page.getByRole("button", { name: "tsumugiを開く" }).click();
  await nav(page).getByRole("button", { name: "設定" }).click();
  await waitLatest(page);
  await expect(page.getByTestId("app-outdated")).toHaveCount(0);
});
