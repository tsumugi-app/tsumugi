/* eslint-disable @typescript-eslint/no-explicit-any */
// The /data screen in a real browser: deleting memories and conversations with every reference kept consistent, resolving stuck sync items, the
// read-only Vault check (OPFS stands in for the Vault folder) and the tombstone list. Fictional data only.
import { test, expect, type Page } from "@playwright/test";

const DATA = "http://localhost:3100/data";
const T = "2026-08-20T00:00:00.000Z";
const meta = (id: string) => ({ id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
const mem = (id: string, conversationId: string, summary: string, links: any[] = []) => ({
  id, date: T, types: ["conversation"], conversationId, content: `本文 ${summary}`, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
  links, evidenceQuotes: [], createdAt: T, updatedAt: T, metadata: meta(id),
});
const conv = (id: string, firstUser: string, memoryObjectIds: string[]) => ({
  id, persona: "companion", status: "captured", startedAt: T, createdAt: T, updatedAt: T,
  turns: [{ role: "user", content: firstUser, timestamp: T }, { role: "ai", content: "応答", timestamp: T }], memoryObjectIds, metadata: meta(id),
});
const link = (id: string, a: string, b: string) => ({ id, sourceId: a, targetId: b, axis: "theme", reason: "r", contrast: false, strength: 0.5, createdBy: "ai-inference", createdAt: T });
const outbox = (recordType: string, recordId: string, status: "pending" | "held", attempts: number, reason: string | null) => ({
  id: `${recordType}:${recordId}`, recordType, recordId, recordUpdatedAt: T, steps: { markdown: "pending", registry: "pending", history: "pending", index: "pending", ledger: "pending" },
  attempt: { count: attempts, lastError: reason, lastAttemptAt: T }, status, heldReason: status === "held" ? reason : null, createdAt: T, updatedAt: T,
});

const M1 = "e2e-mem-A00001", M2 = "e2e-mem-B00002", M3 = "e2e-mem-C00003", M4 = "e2e-mem-D00004", C1 = "e2e-conv-X00001", C2 = "e2e-conv-Y00002", GHOST = "e2e-mem-G00009";

/** the app's own schema is created by loading the page once; then the fictional records go straight into IndexedDB and the page is reloaded */
async function openWith(page: Page, withVault = false) {
  await page.goto(DATA);
  await expect(page.getByRole("heading", { name: "データの管理" })).toBeVisible();
  await page.evaluate(async ({ rows, withVault }) => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    // the OPFS directory is obtained BEFORE the transaction opens (an IndexedDB transaction closes itself when awaited work outside IndexedDB happens inside it)
    const vaultDir = withVault ? await (await navigator.storage.getDirectory()).getDirectoryHandle("data-e2e-vault", { create: true }) : null;
    const tx = db.transaction(["conversations", "memoryObjects", "vaultOutbox", "handles"], "readwrite");
    for (const c of rows.conversations) tx.objectStore("conversations").put(c);
    for (const m of rows.memories) tx.objectStore("memoryObjects").put(m);
    for (const o of rows.outbox) tx.objectStore("vaultOutbox").put(o);
    if (vaultDir) tx.objectStore("handles").put(vaultDir, "vaultRoot");
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    db.close();
  }, {
    withVault,
    rows: {
      conversations: [conv(C1, "E2E会話ひとつめ", [M1, M2]), conv(C2, "E2E会話ふたつめ", [M4])],
      memories: [
        mem(M1, C1, "E2E記憶アルファ", [link("e2e-l1", M1, M2)]), mem(M2, C1, "E2E記憶ブラボー", [link("e2e-l1", M1, M2)]),
        mem(M3, "other-conv", "E2E記憶チャーリー"), mem(M4, C2, "E2E記憶デルタ"),
      ],
      outbox: [outbox("memory", M1, "held", 1, "conflict"), outbox("memory", M2, "pending", 40, "verify-history-mismatch"), outbox("memory", GHOST, "held", 0, "canonical-record-missing"), outbox("memory", M3, "pending", 1, null)],
    },
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: /確認が必要な項目/ })).toBeVisible();
}
const read = <T,>(page: Page, store: string, key: string) => page.evaluate(async ({ store, key }) => {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open("tsumugi"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const v = await new Promise((res, rej) => { const q = db.transaction(store, "readonly").objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close();
  return v;
}, { store, key }) as Promise<T>;
const item = (page: Page, text: string) => page.getByRole("listitem").filter({ hasText: text });

test("stuck sync items: listed (held and long-pending, not ordinary pending), and every one has a way out", async ({ page }) => {
  await openWith(page);
  await expect(page.getByRole("heading", { name: "確認が必要な項目 (3)" })).toBeVisible();
  // retry
  await item(page, "A00001").getByRole("button", { name: "再試行" }).click();
  await expect(page.getByRole("status")).toContainText("もう一度同期を試す状態");
  expect((await read<any>(page, "vaultOutbox", `memory:${M1}`)).status).toBe("pending");
  // keep both as they are
  await item(page, "B00002").getByRole("button", { name: "両方そのままにする" }).click();
  await expect(page.getByRole("status")).toContainText("同期を終了しました");
  expect((await read<any>(page, "vaultOutbox", `memory:${M2}`)).status).toBe("done");
  // an orphan entry (the record does not exist): tidied up as a deletion, which also keeps the Vault copy from coming back
  await item(page, "G00009").getByRole("button", { name: "削除済みとして整理" }).click();
  await expect(page.getByRole("status")).toContainText("削除済みとして整理しました");
  await expect(page.getByText("同期が止まっている項目はありません。")).toBeVisible();
  expect(await read<any>(page, "vaultOutbox", `memory:${GHOST}`)).toBeUndefined();
  await expect(page.getByRole("heading", { name: "削除済みの記録 (1)" })).toBeVisible();
});

test("deleting a memory: two-step confirmation, then the record, the link on the other end, the conversation's reference, the Outbox entry and the ledger are consistent; unrelated records are untouched", async ({ page }) => {
  await openWith(page);
  const m3Before = JSON.stringify(await read<any>(page, "memoryObjects", M3));
  // cancelling deletes nothing
  await item(page, "E2E記憶アルファ").getByRole("button", { name: "削除…" }).click();
  await expect(page.getByText("この記憶を削除します。リンクも外れます。")).toBeVisible();
  await page.getByRole("button", { name: "やめる" }).click();
  expect(await read<any>(page, "memoryObjects", M1)).toBeTruthy();
  // confirm
  await item(page, "E2E記憶アルファ").getByRole("button", { name: "削除…" }).click();
  await page.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByRole("status")).toContainText("削除しました（つながっていた記憶 1 件のリンクを外しました）");
  expect(await read<any>(page, "memoryObjects", M1)).toBeUndefined();
  expect((await read<any>(page, "memoryObjects", M2)).links).toEqual([]);
  expect((await read<any>(page, "conversations", C1)).memoryObjectIds).toEqual([M2]);
  expect(await read<any>(page, "vaultOutbox", `memory:${M1}`)).toBeUndefined();
  const m2Outbox = await read<any>(page, "vaultOutbox", `memory:${M2}`);
  expect(m2Outbox.status).toBe("pending");                                              // the changed neighbour is queued for the Vault
  expect(JSON.stringify(await read<any>(page, "memoryObjects", M3))).toBe(m3Before);
  const tombstones = JSON.parse(await read<string>(page, "settings", "tombstones:v1"));
  expect(Object.keys(tombstones)).toEqual([`memory:${M1}`]);
  expect(JSON.stringify(tombstones)).not.toContain("E2E記憶アルファ");                    // no record text in a tombstone
  await expect(page.getByRole("heading", { name: "削除済みの記録 (1)" })).toBeVisible();
  await expect(page.getByText("E2E記憶アルファ")).toHaveCount(0);
});

test("deleting a conversation: the memories stay by default, or are deleted with it when the user chooses", async ({ page }) => {
  await openWith(page);
  await item(page, "E2E会話ふたつめ").getByRole("button", { name: "削除…" }).click();
  await page.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByRole("status")).toContainText("会話を削除しました（記憶は残しています）");
  expect(await read<any>(page, "conversations", C2)).toBeUndefined();
  expect(await read<any>(page, "memoryObjects", M4)).toBeTruthy();
  await item(page, "E2E会話ひとつめ").getByRole("button", { name: "削除…" }).click();
  await page.getByLabel("この会話から作られた記憶も削除する").check();
  await page.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByRole("status")).toContainText("会話と記憶 2 件を削除しました");
  expect(await read<any>(page, "conversations", C1)).toBeUndefined();
  expect(await read<any>(page, "memoryObjects", M1)).toBeUndefined();
  expect(await read<any>(page, "memoryObjects", M2)).toBeUndefined();
  const tombstones = JSON.parse(await read<string>(page, "settings", "tombstones:v1"));
  expect(Object.keys(tombstones).sort()).toEqual([`conversation:${C1}`, `conversation:${C2}`, `memory:${M1}`, `memory:${M2}`].sort());
});

test("deleted records: the Vault copy is checked read-only (OPFS stands in for the Vault); a remaining copy keeps the guard, 'allow back' lifts it", async ({ page }) => {
  await openWith(page, true);
  await item(page, "E2E会話ひとつめ").getByRole("button", { name: "削除…" }).click();
  await page.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByRole("heading", { name: "削除済みの記録 (1)" })).toBeVisible();
  // the Vault still holds the conversation file, MOVED into a sub folder by the user: it is found by its id (an index.json key alone would not count)
  await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const v = await root.getDirectoryHandle("data-e2e-vault", { create: true });
    const sub = await (await v.getDirectoryHandle("Conversations", { create: true })).getDirectoryHandle("moved-by-user", { create: true });
    const w = await (await sub.getFileHandle("talk.md", { create: true })).createWritable();
    await w.write(`---\ntsumugi: true\nid: ${id}\n---\nbody\n`); await w.close();
  }, C1);
  await page.getByRole("button", { name: "保存先を確認" }).click();
  await expect(page.getByRole("status")).toContainText("保存先にファイルが残っています");
  await expect(page.getByText("保存先にコピーが残っている可能性があります")).toBeVisible();
  // the user deletes the file in the Vault: the check reports it and remembers it
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const v = await root.getDirectoryHandle("data-e2e-vault");
    const sub = await (await v.getDirectoryHandle("Conversations")).getDirectoryHandle("moved-by-user");
    await sub.removeEntry("talk.md");
  });
  await page.getByRole("button", { name: "保存先を確認" }).click();
  await expect(page.getByRole("status")).toContainText("保存先にも見つかりませんでした");
  await expect(page.getByText("保存先にも見つかりません", { exact: false }).first()).toBeVisible();
  const t = JSON.parse(await read<string>(page, "settings", "tombstones:v1"))[`conversation:${C1}`];
  expect(t.vault).toBe("absent");
  // "allow back" lifts the tombstone (the record itself is not recreated)
  await page.getByRole("button", { name: "戻せるようにする" }).click();
  await expect(page.getByRole("heading", { name: "削除済みの記録 (0)" })).toBeVisible();
  expect(await read<any>(page, "conversations", C1)).toBeUndefined();
});
