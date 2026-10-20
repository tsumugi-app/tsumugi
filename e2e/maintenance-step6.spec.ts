/* eslint-disable @typescript-eslint/no-require-imports */
// Step 6 of the maintenance panel ("Repair pre-check", read-only) in a real browser, using only the fictional demo files and fictional IndexedDB records.
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "docs/demo/fictional-repair-data.json");
const DECISIONS = path.join(ROOT, "docs/demo/fictional-decisions.json");
const ENABLED = "http://localhost:3100", DISABLED = "http://localhost:3101";
const USER = "e2e-user", PW = process.env.E2E_PW ?? "local-e2e-only-password";
const PANEL = `${ENABLED}/maintenance/repair`;
const fx = require(path.join(ROOT, ".test-out/lib/memoryRepairTestWorld.js")) as { world(): { memories: any[]; conversations: any[] } };

test("disabled deployment: the maintenance area is a 404, with or without credentials", async ({ request }) => {
  for (const p of ["/maintenance", "/maintenance/repair"]) {
    expect((await request.get(DISABLED + p)).status()).toBe(404);
    expect((await request.get(DISABLED + p, { headers: { authorization: "Basic " + Buffer.from(`${USER}:${PW}`).toString("base64") } })).status()).toBe(404);
  }
});

test("enabled deployment: no or wrong credentials are challenged (401), correct credentials get the page; the normal app is untouched", async ({ request }) => {
  const none = await request.get(PANEL);
  expect(none.status()).toBe(401);
  expect(none.headers()["www-authenticate"]).toMatch(/^Basic /);
  expect((await request.get(PANEL, { headers: { authorization: "Basic " + Buffer.from(`${USER}:wrong`).toString("base64") } })).status()).toBe(401);
  const ok = await request.get(PANEL, { headers: { authorization: "Basic " + Buffer.from(`${USER}:${PW}`).toString("base64") } });
  expect(ok.status()).toBe(200);
  expect(await ok.text()).toContain("Tsumugi maintenance");
  expect((await request.get(ENABLED + "/")).status()).toBe(200);
});

test.describe("panel in a browser", () => {
  test.use({ httpCredentials: { username: USER, password: PW, origin: ENABLED } });

  /** every request the page makes stays on the local test server (nothing is sent anywhere else) */
  const watchNetwork = (page: Page) => { const foreign: string[] = []; page.on("request", (r) => { if (!r.url().startsWith(ENABLED) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) foreign.push(r.url()); }); return foreign; };

  async function openStep6(page: Page) {
    await page.goto(PANEL);
    await expect(page.getByRole("heading", { name: /Tsumugi maintenance/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /6\. Repair pre-check/ })).toBeVisible();
  }
  const scanButton = (page: Page) => page.getByRole("button", { name: /Scan all items/ });
  const loadData = (page: Page) => page.getByLabel("repair data").setInputFiles(DATA);
  const loadDecisions = (page: Page, file: string | { name: string; mimeType: string; buffer: Buffer } = DECISIONS) => page.getByLabel("decision list").setInputFiles(file);
  const json = (name: string, v: unknown) => ({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(v)) });

  async function seed(page: Page, edit?: (w: { memories: any[]; conversations: any[] }) => void) {
    const w = fx.world();
    edit?.(w);
    const memories = w.memories.map((m) => ({ ...m, metadata: { ...m.metadata, sourceType: "chat" } }));
    await page.evaluate(async ({ conversations, memories }) => {
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = indexedDB.open("tsumugi");
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("conversations", { keyPath: "id" }); d.createObjectStore("memoryObjects", { keyPath: "id" }); d.createObjectStore("vaultOutbox", { keyPath: "id" }); d.createObjectStore("settings"); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(["conversations", "memoryObjects"], "readwrite");
        for (const c of conversations) tx.objectStore("conversations").put(c);
        for (const m of memories) tx.objectStore("memoryObjects").put(m);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    }, { conversations: w.conversations, memories });
  }
  /** a digest of everything in the four stores: Scan / pre-check must leave it byte-identical */
  const digest = (page: Page) => page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const out: Record<string, unknown> = {};
    for (const s of ["conversations", "memoryObjects", "vaultOutbox", "settings"]) {
      if (!db.objectStoreNames.contains(s)) continue;
      out[s] = await new Promise((res, rej) => { const q = db.transaction(s, "readonly").objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    }
    db.close();
    return JSON.stringify(out);
  });

  test("loading: Scan stays disabled until both files are valid; bad decision lists are rejected with a fixed code", async ({ page }) => {
    const foreign = watchNetwork(page);
    await openStep6(page);
    await expect(scanButton(page)).toBeDisabled();
    await loadData(page);
    await expect(scanButton(page)).toBeDisabled();                                   // data alone is not enough: no decision list, nothing selectable
    await expect(page.getByText("decision list: not loaded: nothing is selectable")).toBeVisible();
    await loadDecisions(page, json("bad-format.json", { format: "other", schema: 1, held: [], excluded: [] }));
    await expect(page.getByText("decision list rejected: wrong-format-or-schema")).toBeVisible();
    await expect(scanButton(page)).toBeDisabled();
    await loadDecisions(page, json("unknown-key.json", { format: "tsumugi-repair-decisions", schema: 1, held: ["NO-SUCH-KEY"], excluded: [] }));
    await expect(page.getByText("decision list: decision-key-not-in-data")).toBeVisible();
    await expect(scanButton(page)).toBeDisabled();
    await loadDecisions(page, json("dup.json", { format: "tsumugi-repair-decisions", schema: 1, held: ["R1"], excluded: ["R1"] }));
    await expect(page.getByText("decision list rejected: duplicate-key")).toBeVisible();
    await loadDecisions(page);                                                        // the good fictional list
    await expect(page.getByText("decision list: loaded (held 1, excluded 2)")).toBeVisible();
    await expect(scanButton(page)).toBeEnabled();
    expect(foreign, "no request leaves the local server").toEqual([]);
  });

  test("no data present: Scan runs, nothing is selectable, nothing is written (safe refusal)", async ({ page }) => {
    const foreign = watchNetwork(page);
    await openStep6(page);
    await loadData(page); await loadDecisions(page);
    await scanButton(page).click();
    const boxes = page.getByRole("checkbox");
    await expect(boxes).toHaveCount(17);                                              // 8 repair + 9 backfill items
    for (let i = 0; i < 17; i++) await expect(boxes.nth(i)).toBeDisabled();
    await expect(page.getByRole("button", { name: /A\. Run IndexedDB pre-check/ })).toBeDisabled();
    await expect(page.getByText("R7 (repair) - held by decision")).toBeVisible();
    await expect(page.getByText("B1 (backfill) - excluded by decision")).toBeVisible();
    expect(foreign).toEqual([]);
  });

  test("fictional IndexedDB records: Scan finds READY items, decisions still block, the pre-check reports READY but never 'safe' without the Vault check; read-only", async ({ page }) => {
    const foreign = watchNetwork(page);
    await openStep6(page);
    await seed(page);
    const before = await digest(page);
    await loadData(page); await loadDecisions(page);
    await scanButton(page).click();
    const r1 = page.getByRole("checkbox", { name: /^R1 \(repair\)/ });
    await expect(r1).toBeEnabled();
    await expect(page.getByText("R7 (repair) - held by decision")).toBeVisible();
    await expect(page.getByText("B1 (backfill) - excluded by decision")).toBeVisible();
    await r1.check();
    await page.getByRole("button", { name: /A\. Run IndexedDB pre-check/ }).click();
    await expect(page.getByText("R1: READY")).toBeVisible();
    await expect(page.getByText(/B\. Other unfinished Outbox entries \(0\)/)).toBeVisible();
    await expect(page.getByText(/R1: NOT SAFE \/ NOT PROVEN - READY in IndexedDB, but the Vault has not been checked/)).toBeVisible();
    await expect(page.getByText(/SAFE TO REPAIR/)).toHaveCount(0);
    expect(await digest(page), "Scan and pre-check wrote nothing").toBe(before);
    expect(foreign).toEqual([]);
  });

  test("a record that differs from the reviewed state is HOLD: not selectable (safe refusal with data present)", async ({ page }) => {
    await openStep6(page);
    await seed(page, (w) => { const m = w.memories.find((x) => x.id === "mem-r1"); m.summary = m.summary + "（変更済み）"; });
    await loadData(page); await loadDecisions(page);
    await scanButton(page).click();
    await expect(page.getByRole("checkbox", { name: /^R1 \(repair\)/ })).toBeDisabled();
    await expect(page.getByText(/R1 \(repair\) - live status HOLD/)).toBeVisible();
  });
});
