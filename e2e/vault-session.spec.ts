/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
// The repair session in a real browser: real IndexedDB, real Web Locks across tabs, and an OPFS directory standing in for the Vault folder.
// NOT covered here (needs a person): the OS folder picker and its permission prompts; OPFS handles never prompt.
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const ENABLED = "http://localhost:3100", PANEL = `${ENABLED}/maintenance/repair`;
const USER = "e2e-user", PW = process.env.E2E_PW ?? "local-e2e-only-password";
const BUNDLE = path.join(__dirname, ".build/harness.js");
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/demo/fictional-repair-data.json"), "utf8"));
const fx = require(path.join(ROOT, ".test-out/lib/memoryRepairTestWorld.js")) as any;

/** the same dummy world the node tests seed: the reviewed item's records go through the real projection into the Vault; everything else is plain */
function payload(keys: string[]) {
  const w = fx.world();
  const T0 = fx.T0, DAY2 = "2026-08-21T00:00:00.000Z";
  const withType = (m: any) => ({ ...m, metadata: { ...m.metadata, sourceType: "chat" } });
  const items = DATA.repair.items.filter((i: any) => keys.includes(i.key));
  const convIds = [...new Set(items.flatMap((i: any) => [i.originalConversationId, i.updatingConversationId]))];
  const neighbours = [
    fx.mem("nb-a", "nb-conv-a", "近所の別の要約A", "別の内容A", T0, { date: T0, createdAt: "2026-08-20T00:00:01.000Z" }),
    fx.mem("nb-b", "nb-conv-b", "近所の別の要約B", "別の内容B", T0, { date: T0, createdAt: "2026-08-20T00:00:02.000Z" }),
    fx.mem("nb-c", "nb-conv-c", "翌日の別の要約C", "別の内容C", T0, { date: DAY2, createdAt: "2026-08-21T00:00:01.000Z" }),
    fx.mem("nb-d", "nb-conv-d", "翌日の別の要約D", "別の内容D", T0, { date: DAY2, createdAt: "2026-08-21T00:00:02.000Z" }),
  ].map(withType);
  return {
    data: DATA,
    seededConversations: [...convIds.map((id) => w.conversations.find((c: any) => c.id === id)), fx.conv("nb-conv-c", ["別の会話の発言"], T0, ["nb-c"])],
    seededMemories: [...neighbours, ...items.map((i: any) => withType(w.memories.find((m: any) => m.id === i.memoryId)))],
    plainConversations: w.conversations,
    plainMemories: w.memories.map(withType),
  };
}

test.use({ httpCredentials: { username: USER, password: PW, origin: ENABLED } });

/** a tab on a /maintenance path (the maintenance window refuses to open anywhere else) with the production harness loaded */
async function tab(context: any): Promise<Page> {
  const page: Page = await context.newPage();
  await page.goto(PANEL);
  await page.addScriptTag({ path: BUNDLE });
  await page.waitForFunction(() => !!(window as any).H);
  await page.evaluate(() => (window as any).H.initTab());
  return page;
}
const H = <T,>(page: Page, expr: string, arg?: unknown): Promise<T> => page.evaluate(`(async () => { const H = window.H; const a = ${JSON.stringify(arg ?? null)}; return (${expr}); })()`) as Promise<T>;

test("real browser: the whole repair completes; a second tab is blocked while the window is open; afterwards gate closed, lock free, only the enumerated records changed", async ({ context }) => {
  const page1 = await tab(context);
  const before: any = await page1.evaluate((p) => (window as any).H.setup(p), payload(["R1"]));
  expect(Object.keys(before.vault).length).toBeGreaterThan(3);
  expect(before.backup).toEqual(before.vault);
  // start the session in tab 1 and hold it right after the repair commit
  await page1.evaluate(() => { (window as any).H.run({ key: "R1", blockAt: "repair-committed" }); });
  await page1.waitForFunction(() => (window as any).__reached === "repair-committed");

  const page2 = await tab(context);
  expect(await H<string[]>(page2, "await H.lockHeld()")).toContain("tsumugi-vault-world");   // the other tab really holds the lock
  const entered: any = await H(page2, "await H.enterWindow()");
  expect(entered.ok).toBe(false);                                                            // refused: another tab is busy
  expect(entered.reason).toMatch(/lock/);
  expect(await H(page2, "await H.readOrTimeout(700)")).toBe("blocked");                      // a normal read of the Vault world waits
  expect(await H(page2, "await H.blocking()")).toBe(true);                                   // and the durable gate says normal writes are blocked
  expect(await H(page2, "await H.readGate()")).toBe("maintenance-open");

  await page1.evaluate(() => (window as any).__release());
  const report: any = await page1.evaluate(() => (window as any).__p);
  expect(report.status, JSON.stringify(report)).toBe("completed");
  expect(report.stages).toEqual(["window-open", "prechecked", "vault-backup-checked", "restore-point-verified", "repair-committed", "dry-run-ok", "backups-verified", "synced", "verified"]);
  expect(report.gateClosed).toBe(true); expect(report.windowOpen).toBe(false);

  expect(await H(page2, "await H.readGate()")).toBe("finished");
  expect(await H(page2, "await H.blocking()")).toBe(false);
  expect(await H(page2, "await H.readOrTimeout(2000)")).toBe("ran");                         // the lock is free again
  const after: any = await page1.evaluate(() => (window as any).H.state());
  expect(after.other, "the unrelated pending Outbox entry never changed").toBe(before.other);
  expect(after.backup, "the operator's copy is untouched").toEqual(before.backup);
  const changed = Object.keys(after.vault).filter((k) => after.vault[k] !== before.vault[k]);
  expect(changed.length).toBeGreaterThan(0);
  for (const f of changed) expect(f, "only Memory / Conversation / History files may change").toMatch(/^(Memories|Conversations|\.tsumugi\/(history|index|registry))/);
  expect(await H<any>(page1, "await H.getMemory('mem-r1')")).toMatchObject({ summary: DATA.repair.items.find((i: any) => i.key === "R1").restored.summary });
  // running it again is refused (already repaired), never a second write
  const again: any = await page1.evaluate(() => (window as any).H.run({ key: "R1", refreshCopy: true }));
  expect(again.status).toBe("refused");
});

test("real browser: a failure after the real sync restores IndexedDB and the Vault byte for byte; the window and gate are closed", async ({ context }) => {
  const page = await tab(context);
  const before: any = await page.evaluate((p) => (window as any).H.setup(p), payload(["R1"]));
  const report: any = await page.evaluate(() => (window as any).H.run({ key: "R1", throwAt: "synced" }));
  expect(report.status, JSON.stringify(report)).toBe("rolled-back");
  expect(report.stages).toContain("synced");
  const after: any = await page.evaluate(() => (window as any).H.state());
  expect(after.vault).toEqual(before.vault);
  expect(after.idb).toBe(before.idb);
  expect(after.other).toBe(before.other);
  expect(await H(page, "await H.readGate()")).toBe("finished");
  expect(await H(page, "await H.readOrTimeout(2000)")).toBe("ran");
});

test("real browser: a failure right after the repair commit restores IndexedDB (Vault untouched)", async ({ context }) => {
  const page = await tab(context);
  const before: any = await page.evaluate((p) => (window as any).H.setup(p), payload(["R1"]));
  const report: any = await page.evaluate(() => (window as any).H.run({ key: "R1", throwAt: "repair-committed" }));
  expect(report.status, JSON.stringify(report)).toBe("rolled-back");
  const after: any = await page.evaluate(() => (window as any).H.state());
  expect(after.vault).toEqual(before.vault); expect(after.idb).toBe(before.idb); expect(after.other).toBe(before.other);
});

test("real browser: closing the tab in the middle of the window frees the Web Lock but the durable gate stays; another tab sees it and can release it deliberately", async ({ context }) => {
  const page1 = await tab(context);
  await page1.evaluate((p) => (window as any).H.setup(p), payload(["R1"]));
  await page1.evaluate(() => { (window as any).H.run({ key: "R1", blockAt: "repair-committed" }); });
  await page1.waitForFunction(() => (window as any).__reached === "repair-committed");
  const page2 = await tab(context);
  expect(await H<string[]>(page2, "await H.lockHeld()")).toContain("tsumugi-vault-world");
  await page1.close();                                                                       // the tab dies mid-window
  await expect.poll(async () => (await H<string[]>(page2, "await H.lockHeld()")).includes("tsumugi-vault-world"), { timeout: 10_000 }).toBe(false);
  expect(await H(page2, "await H.blocking()")).toBe(true);                                   // the gate survives the crash: normal writes stay blocked
  expect(await H(page2, "await H.readGate()")).toBe("maintenance-open");
  const released: any = await H(page2, "await H.releaseStale()");
  expect(released.released, JSON.stringify(released)).toBe(true);
  expect(await H(page2, "await H.blocking()")).toBe(false);
});

/** the tab dies mid-repair after the real sync (IndexedDB repaired AND Vault written); returns the SAVED restore point and the state before */
async function killMidRepair(context: any) {
  const page1 = await tab(context);
  const before: any = await page1.evaluate((p) => (window as any).H.setup(p), payload(["R1"]));
  await page1.evaluate(() => { (window as any).H.run({ key: "R1", blockAt: "synced" }); });
  await page1.waitForFunction(() => (window as any).__reached === "synced");
  const saved: string = await page1.evaluate(() => (window as any).__saved);
  await page1.close();                                                                       // the tab dies
  const page2 = await tab(context);
  await page2.evaluate(() => (window as any).H.attach());
  await expect.poll(async () => (await H<string[]>(page2, "await H.lockHeld()")).includes("tsumugi-vault-world"), { timeout: 10_000 }).toBe(false);
  return { page2, saved, before };
}

test("real browser: tab killed mid-repair -> diagnosis -> typed confirmation -> strict restore -> verification -> gate released -> normal operation resumes", async ({ context }) => {
  const { page2, saved, before } = await killMidRepair(context);
  const crashed: any = await page2.evaluate(() => (window as any).H.state());
  expect(crashed.vault).not.toEqual(before.vault);                                           // the crash left Vault files changed
  expect(crashed.idb).not.toBe(before.idb);                                                  // and IndexedDB changed
  expect(await H(page2, "await H.blocking()")).toBe(true);
  const diag: any = await page2.evaluate((t) => (window as any).H.diagnose(t), saved);
  expect(diag.status, JSON.stringify(diag)).toBe("restorable");
  expect(JSON.stringify(diag)).not.toMatch(/[぀-ヿ一-鿿]/);                                    // the diagnosis carries no record text
  expect(await H(page2, "await H.blocking()")).toBe(true);                                   // diagnosing changed nothing
  const wrong: any = await page2.evaluate((t) => (window as any).H.recover(t, "RESTORE wrong"), saved);
  expect(wrong.status).toBe("refused");
  expect(await H(page2, "await H.blocking()")).toBe(true);
  const report: any = await page2.evaluate(([t, c]) => (window as any).H.recover(t, c), [saved, diag.restorePoint.confirmPhrase]);
  expect(report.status, JSON.stringify(report)).toBe("recovered");
  expect(report.gateStillInPlace).toBe(false);
  expect(report.consistency).toEqual({ mismatched: 0, unverified: 0 });
  const after: any = await page2.evaluate(() => (window as any).H.state());
  expect(after.vault, "Vault byte-identical to before the repair").toEqual(before.vault);
  expect(after.idb, "IndexedDB (records, ledger, Outbox) identical to before the repair").toBe(before.idb);
  expect(after.other).toBe(before.other);
  expect(await H(page2, "await H.readGate()")).toBe("finished");
  expect(await H(page2, "await H.blocking()")).toBe(false);
  expect(await H(page2, "await H.readOrTimeout(2000)")).toBe("ran");
});

test("real browser: an unexplained change after the crash stops the recovery; the gate stays, nothing is written, normal writes stay blocked", async ({ context }) => {
  const { page2, saved } = await killMidRepair(context);
  await page2.evaluate(() => (window as any).H.writeVaultFile("Memories/zz-foreign.md", "not written by the repair"));   // a foreign file inside a Tsumugi area
  const stateBefore: any = await page2.evaluate(() => (window as any).H.state());
  const diag: any = await page2.evaluate((t) => (window as any).H.diagnose(t), saved);
  expect(diag.status, JSON.stringify(diag)).toBe("stopped");
  expect(diag.reason).toMatch(/collateral/);
  const report: any = await page2.evaluate(([t, c]) => (window as any).H.recover(t, c), [saved, diag.restorePoint.confirmPhrase]);
  expect(report.status).toBe("stopped");
  expect(report.gateStillInPlace).toBe(true);
  const stateAfter: any = await page2.evaluate(() => (window as any).H.state());
  expect(stateAfter.vault).toEqual(stateBefore.vault); expect(stateAfter.idb).toBe(stateBefore.idb);
  expect(await H(page2, "await H.readGate()")).toBe("maintenance-open");
  expect(await H(page2, "await H.blocking()")).toBe(true);
  expect(await H(page2, "await H.lockHeld()")).not.toContain("tsumugi-vault-world");        // the lock was given back
});
