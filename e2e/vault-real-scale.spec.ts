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
    await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
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

test.only("at real size: the empty AI turns are not a conflict anywhere, Settings ends at 「✓ 最新の状態です」, stays there after a reload and a new conversation, and no record changes", async ({ page }) => {
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
  report("perf-reload", { ...second, t0: undefined, latest: Date.now() - second.t0, ...(await traceSummary(page)) });
  expect(changedKeys(before, await fingerprint(page)).filter(isRecord)).toEqual([]);

  // a new conversation is saved as usual, and the state stays clean
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/chat")) await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: "架空の返答です。" });
    else await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  const third = await startApp(page, "before a new conversation");
  const inputAt = Date.now();
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

test.only("at real size: two conversations that really differ are found, nothing hides them, and choosing one right after the other is not refused as busy", async ({ page }) => {
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
  await expect(page.getByTestId("vault-conflict-item")).toHaveCount(1, { timeout: 240_000 });
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
