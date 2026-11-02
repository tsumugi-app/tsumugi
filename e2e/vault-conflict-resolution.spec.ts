/* eslint-disable @typescript-eslint/no-explicit-any */
// Resolving a record whose device and Vault versions differ, in a real browser: real IndexedDB, Web Locks across tabs and an OPFS directory standing in for the Vault folder (the Android
// backend; the PC folder backend is the same FileSystemDirectoryHandle API). The PRODUCTION wiring runs (backup, re-verification, exclusive section, normal save, re-check). Fictional data only.
// Both versions must survive every choice and every interruption, nothing may appear twice, repeating an action must change nothing, and only a fresh check may call the result clean.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const BASE = "http://localhost:3100";
const bundle = path.join(__dirname, ".build/harness.js");
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const DAY = "2026-10-20";
const DAY_FILE = `Memories/${DAY}.md`;
const SEPARATOR = "\n<!-- tsumugi:entry -->\n\n";
const LATER = "2026-10-21T00:00:00.000Z";

/** a fictional world in OPFS "conflict-vault": a conversation, two Memories of one day, a Reflection and a Source, all saved through the normal Outbox */
async function setup(page: Page, fresh = true) {
  await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
  await page.evaluate(async ({ fresh, DAY }) => {
    const { dbm, proj, lockMod } = (window as any).D; const T = `${DAY}T00:00:00.000Z`;
    const opfs = await navigator.storage.getDirectory();
    if (fresh) { try { await opfs.removeEntry("conflict-vault", { recursive: true }); } catch { /* not there */ } }
    const root = await opfs.getDirectoryHandle("conflict-vault", { create: true });
    const write = async (p: string, text: string) => {
      const parts = p.split("/"); let dir = root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable(); await w.write(text); await w.close();
    };
    const ident = { id: "current", vaultId: "fictional-conflict", activeVaultEpoch: 0, registryGeneration: "g", pairedAt: T, pendingCandidateVaultId: null, updatedAt: T };
    const meta = (id: string) => ({ id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
    const mem = (id: string, content: string, createdAt: string, updatedAt = createdAt) => ({ id, date: `${DAY}T09:15:00.000Z`, types: ["conversation"], conversationId: "c-conv", content, summary: `要約 ${id}`, keywords: [], themeIds: ["theme-kept"], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt, updatedAt, metadata: { ...meta(id), createdAt, updatedAt } });
    const refl = (content: string, updatedAt = T) => ({ ...mem("c-refl", content, T, updatedAt), types: ["summary"], summary: "架空の振り返り", conversationId: undefined, metadata: { ...meta("c-refl"), source: "system-generated", updatedAt } });
    const conv = (turns: string[], updatedAt = T) => ({ id: "c-conv", persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt, memoryObjectIds: [], turns: turns.map((content, i) => ({ role: i % 2 ? "ai" : "user", content, timestamp: T })), metadata: { ...meta("c-conv"), updatedAt } });
    const source = (content: string, updatedAt = T) => ({ id: "c-src", sourceType: "manual", title: "架空の資料", content, createdAt: T, updatedAt });
    const settle = async (entry: any) => {
      const fn = entry.recordType === "conversation" ? proj.reconcileConversationOutboxEntry : entry.recordType === "memory" ? proj.reconcileMemoryOutboxEntry : entry.recordType === "reflection" ? proj.reconcileReflectionOutboxEntry : proj.reconcileSourceOutboxEntry;
      return fn({ root, vaultIdentity: ident, now: () => new Date().toISOString() }, entry);
    };
    Object.assign(window as any, { __root: root, __write: write, __mem: mem, __refl: refl, __conv: conv, __source: source, __settle: settle });
    await dbm.putVaultIdentityRecord(ident); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated(); lockMod.setTabVaultEpoch(0);
    if (!fresh) return;
    await write(".tsumugi/vault-identity.json", JSON.stringify({ vaultId: "fictional-conflict", createdAt: T }));
    await write(".tsumugi/registry-meta.json", JSON.stringify({ schemaVersion: 1, updatedAt: T, lastFullResyncAt: null, baselineEstablishedAt: "2026-01-01T00:00:00.000Z" }));
    await dbm.setProjectionHeldReevaluationMarker(proj.PROJECTION_HELD_RULE_VERSION, T);
    for (const e of [
      await dbm.putConversationWithOutbox(conv(["架空の問い", "架空の答え"])),
      await dbm.putMemoryObjectWithOutbox(mem("c-mem-1", "架空の本文ひとつ", `${DAY}T01:00:00.000Z`), "memory"),
      await dbm.putMemoryObjectWithOutbox(mem("c-mem-2", "架空の本文ふたつ", `${DAY}T02:00:00.000Z`), "memory"),
      await dbm.putMemoryObjectWithOutbox(refl("架空の振り返りの本文"), "reflection"),
      await dbm.putSourceWithOutbox(source("架空の資料の本文")),
    ]) { const r = await settle(e); if (r.status !== "done") throw new Error("seed-not-done:" + JSON.stringify(r)); }
  }, { fresh, DAY });
}

const read = (page: Page, p: string) => page.evaluate(async (p) => {
  const parts = p.split("/"); let dir = (window as any).__root; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).text();
}, p);
const write = (page: Page, p: string, text: string) => page.evaluate(({ p, text }) => (window as any).__write(p, text), { p, text });
const outbox = (page: Page, id: string) => page.evaluate(async (id) => { const e = await (window as any).D.dbm.getVaultOutboxEntry(id); return { status: e?.status ?? null, reason: e?.heldReason ?? null }; }, id);
const startUp = (page: Page) => page.evaluate(async () => { await (window as any).D.bootstrap.runSaveFoundationBootstrap({ root: (window as any).__root }); });
const inspect = (page: Page, recordType: string, recordId: string) => page.evaluate(({ recordType, recordId }) => (window as any).D.conflict.inspectConflict((window as any).__root, { recordType, recordId }), { recordType, recordId });
const resolve = (page: Page, snapshot: any, choice: string, o: { failAt?: string } = {}) => page.evaluate(async ({ snapshot, choice, failAt }) => {
  const { conflictRun, conflict } = (window as any).D;
  const env = conflictRun.createProductionConflictEnv({ root: (window as any).__root, backend: "opfs", build: "e2e", isCancelled: () => false, checkOptions: { drainWaitMs: 1500, pollMs: 100, attempts: 3, retryDelayMs: 200 } });
  if (failAt) env.checkpoint = (stage: string) => { if (stage === failAt) throw new Error("fictional: the tab was closed here"); };
  try {
    const o = await conflict.resolveConflict(env, snapshot, choice);
    return { kind: o.kind, reason: o.reason ?? null, stage: o.stage ?? null, kept: o.kept ?? null, resolved: o.resolved ?? null, state: o.after?.state ?? null, findings: (o.after?.findings ?? []).map((f: any) => `${f.recordId ?? "-"}:${f.category}:${f.reason}`) };
  } catch (error) { return { kind: "interrupted", message: (error as Error).message }; }
}, { snapshot, choice, failAt: o.failAt });
const kept = (page: Page) => page.evaluate(async () => (window as any).D.conflict.listKeptVersions((window as any).__root));
const device = (page: Page, store: "memory" | "conversation" | "source", id: string) => page.evaluate(({ store, id }) => { const { dbm } = (window as any).D; return store === "memory" ? dbm.getMemoryObject(id) : store === "conversation" ? dbm.getConversation(id) : dbm.getSource(id); }, { store, id });
const check = (page: Page) => page.evaluate(async () => {
  const r = (await (window as any).D.consistencyCheck.checkVaultConsistency((window as any).__root, () => false, { drainWaitMs: 1500, pollMs: 100, attempts: 3, retryDelayMs: 200 })).report;
  return { state: r.state, findings: r.findings.map((f: any) => `${f.recordId ?? "-"}:${f.category}:${f.reason}`) };
});
/** the device moved on and the Vault file was edited by hand: the save holds */
const editMemoryOnBothSides = async (page: Page, vaultEdit: (entry: string) => string = (e) => e.replace("架空の本文ひとつ", "架空の本文ひとつ（手で書き直した）")) => {
  const text = await read(page, DAY_FILE);
  const edited = text.split(SEPARATOR).map((s) => (s.includes("id: c-mem-1") ? vaultEdit(s) : s)).join(SEPARATOR);
  await write(page, DAY_FILE, edited);
  const r = await page.evaluate(async ({ DAY, LATER }) => {
    const { dbm } = (window as any).D;
    return (window as any).__settle(await dbm.putMemoryObjectWithOutbox((window as any).__mem("c-mem-1", "架空の本文ひとつ（端末で更新した）", `${DAY}T01:00:00.000Z`, LATER), "memory"));
  }, { DAY, LATER });
  expect(r.status).toBe("held");
  return edited;
};
const entriesWith = (text: string, id: string) => text.split(SEPARATOR).filter((s) => s.includes(`id: ${id}`));

for (const kind of ["desktop", "android"] as const) {
  test.describe(kind, () => {
    if (kind === "android") test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

    test("Memory, 両方保持: the file takes the device version, the Vault version is kept apart, nothing appears twice, and saving works again", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      const edited = await editMemoryOnBothSides(page);
      expect((await check(page)).findings).toContain("c-mem-1:needsChoice:different-content");
      const view: any = await inspect(page, "memory", "c-mem-1");
      expect(view.state).toBe("differs");
      expect(view.choices).toEqual(["keep-both", "adopt-device", "adopt-vault"]);
      expect(view.vaultText).toContain("手で書き直した"); expect(view.deviceText).toContain("端末で更新した");
      expect(view.diff.some((l: any) => l.kind === "vault" && l.text.includes("手で書き直した"))).toBe(true);
      expect(await read(page, DAY_FILE)).toBe(edited);    // reading changes nothing

      const r: any = await resolve(page, view.snapshot, "keep-both");
      expect(r.kind, JSON.stringify(r)).toBe("done"); expect(r.resolved).toBe(true); expect(r.state, JSON.stringify(r)).toBe("clean");
      const file = await read(page, DAY_FILE);
      expect(entriesWith(file, "c-mem-1").length).toBe(1);
      expect(file).toContain("端末で更新した"); expect(file).not.toContain("手で書き直した");
      expect(entriesWith(file, "c-mem-2")[0]).toBe(entriesWith(edited, "c-mem-2")[0]);    // the other record keeps every byte
      expect(await outbox(page, "memory:c-mem-1")).toEqual({ status: "done", reason: null });
      const list: any = await kept(page);
      expect(list.versions.length).toBe(1); expect(list.versions[0].vaultText).toContain("手で書き直した"); expect(list.versions[0].deviceMarkdown).toContain("端末で更新した");
      expect((await device(page, "memory", "c-mem-1") as any).themeIds).toEqual(["theme-kept"]);

      // the repeat is refused and changes nothing; the kept version does not multiply
      const again: any = await resolve(page, view.snapshot, "keep-both");
      expect(again.kind).toBe("not-started"); expect(again.reason).toBe("changed");
      expect(await read(page, DAY_FILE)).toBe(file); expect(((await kept(page)) as any).versions.length).toBe(1);
      // start-ups change nothing, and the next normal save goes through
      await startUp(page); await startUp(page);
      expect(await read(page, DAY_FILE)).toBe(file);
      const next: any = await page.evaluate(async ({ DAY }) => (window as any).__settle(await (window as any).D.dbm.putMemoryObjectWithOutbox((window as any).__mem("c-mem-1", "架空の本文（次の更新）", `${DAY}T01:00:00.000Z`, "2026-10-22T00:00:00.000Z"), "memory")), { DAY });
      expect(next.status).toBe("done");
      expect(await read(page, DAY_FILE)).toContain("次の更新");
      // the kept copy is not a record anywhere
      expect(await page.evaluate(async () => (await (window as any).D.dbm.getAllMemoryObjects()).filter((m: any) => m.id === "c-mem-1").length)).toBe(1);
      expect((await check(page)).state).toBe("clean");
    });

    test("Memory, 保存先の版を採用: the device takes the hand-edited text, fields Markdown does not hold stay, and the original device version is kept", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      await editMemoryOnBothSides(page);
      const view: any = await inspect(page, "memory", "c-mem-1");
      const r: any = await resolve(page, view.snapshot, "adopt-vault");
      expect(r.kind, JSON.stringify(r)).toBe("done"); expect(r.resolved).toBe(true); expect(r.state).toBe("clean");
      const rec: any = await device(page, "memory", "c-mem-1");
      expect(rec.content).toContain("手で書き直した"); expect(rec.themeIds).toEqual(["theme-kept"]); expect(rec.updatedAt > LATER).toBe(true);
      const file = await read(page, DAY_FILE);
      expect(file).toContain("手で書き直した"); expect(file).not.toContain("端末で更新した"); expect(entriesWith(file, "c-mem-1").length).toBe(1);
      expect(((await kept(page)) as any).versions[0].deviceRaw).toContain("端末で更新した");
    });

    test("Memory, 端末側を採用, with an old Registry (no hashes at all)", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      // an old Registry: the row has no member hashes, so nothing proves who wrote the entry
      const shards: string[] = await page.evaluate(async () => { const out: string[] = []; const dir = await (await (window as any).__root.getDirectoryHandle(".tsumugi")).getDirectoryHandle("registry"); for await (const [n] of dir.entries()) out.push(`.tsumugi/registry/${n}`); return out; });
      for (const shard of shards) {
        const v = JSON.parse(await read(page, shard));
        for (const row of Object.values<any>(v.files)) delete row.memberHashes;
        await write(page, shard, JSON.stringify(v));
      }
      await editMemoryOnBothSides(page);
      expect((await outbox(page, "memory:c-mem-1")).reason).toMatch(/conflict$/);
      const view: any = await inspect(page, "memory", "c-mem-1");
      const r: any = await resolve(page, view.snapshot, "adopt-device");
      expect(r.kind, JSON.stringify(r)).toBe("done"); expect(r.state, JSON.stringify(r)).toBe("clean");
      expect(await read(page, DAY_FILE)).toContain("端末で更新した");
      expect(((await kept(page)) as any).versions[0].vaultText).toContain("手で書き直した");
    });

    test("Conversation: a rewritten turn offers all choices; a hand-written note that the record can not hold is never adopted, and survives in the kept version", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      const pathOf = async () => (await page.evaluate(async () => { const out: string[] = []; const dir = await (window as any).__root.getDirectoryHandle("Conversations"); for await (const [n] of dir.entries()) out.push(`Conversations/${n}`); return out; }))[0];
      const p = await pathOf();
      const original = await read(page, p);
      await write(page, p, original.replace("架空の問い", "架空の問い（手で直した）"));
      const held: any = await page.evaluate(async ({ LATER }) => (window as any).__settle(await (window as any).D.dbm.putConversationWithOutbox((window as any).__conv(["架空の問い", "架空の答え", "架空の続き"], LATER))), { LATER });
      expect(held.status).toBe("held"); expect(held.reason ?? (await outbox(page, "conversation:c-conv")).reason).toBe("markdown-conflict");
      let view: any = await inspect(page, "conversation", "c-conv");
      expect(view.choices).toEqual(["keep-both", "adopt-device", "adopt-vault"]);

      // the hand note is outside any turn: the record can not hold it, so adopting would lose it
      await write(page, p, (await read(page, p)).replace("## Transcript", "架空の手書きのメモ\n\n## Transcript"));
      view = await inspect(page, "conversation", "c-conv");
      expect(view.choices).toEqual(["keep-both", "adopt-device"]); expect(view.adoptVaultBlock).toBe("would-lose-content");
      const refused: any = await resolve(page, view.snapshot, "adopt-vault");
      expect(refused.kind).toBe("not-started"); expect(refused.reason).toBe("choice-unavailable");
      const r: any = await resolve(page, view.snapshot, "keep-both");
      expect(r.kind, JSON.stringify(r)).toBe("done"); expect(r.state, JSON.stringify(r)).toBe("clean");
      expect(await read(page, p)).toContain("架空の続き");
      expect(((await kept(page)) as any).versions[0].vaultText).toContain("架空の手書きのメモ");
      expect((await device(page, "conversation", "c-conv") as any).turns.length).toBe(3);
    });

    test("Conversation, 保存先の版を採用: a hand-added turn becomes part of the record", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      const dir = await page.evaluate(async () => { const out: string[] = []; const d = await (window as any).__root.getDirectoryHandle("Conversations"); for await (const [n] of d.entries()) out.push(`Conversations/${n}`); return out; });
      const p = dir[0];
      await write(page, p, (await read(page, p)).replace("架空の答え", "架空の答え（直した）\n\n**User:** 架空の手書きの続き"));
      await page.evaluate(async ({ LATER }) => (window as any).__settle(await (window as any).D.dbm.putConversationWithOutbox((window as any).__conv(["架空の問い", "架空の答え", "端末の続き"], LATER))), { LATER });
      const view: any = await inspect(page, "conversation", "c-conv");
      expect(view.choices).toContain("adopt-vault");
      const r: any = await resolve(page, view.snapshot, "adopt-vault");
      expect(r.kind, JSON.stringify(r)).toBe("done"); expect(r.state, JSON.stringify(r)).toBe("clean");
      const rec: any = await device(page, "conversation", "c-conv");
      expect(rec.turns.map((t: any) => t.content)).toEqual(["架空の問い", "架空の答え（直した）", "架空の手書きの続き"]);
      expect(await read(page, p)).toContain("架空の手書きの続き");
    });

    test("Reflection and Source: both can be resolved, each with its own file", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      const list = async (d: string) => page.evaluate(async (d) => { const out: string[] = []; const h = await (window as any).__root.getDirectoryHandle(d); for await (const [n] of h.entries()) out.push(`${d}/${n}`); return out; }, d);
      const reflPath = (await list("Memories")).find((p) => p !== DAY_FILE)!;
      const srcPath = (await list("Sources"))[0];
      await write(page, reflPath, (await read(page, reflPath)).replace("架空の振り返りの本文", "架空の振り返り（手で直した）"));
      await write(page, srcPath, (await read(page, srcPath)).replace("架空の資料の本文", "架空の資料（手で直した）"));
      await page.evaluate(async ({ LATER }) => {
        const { dbm } = (window as any).D;
        await (window as any).__settle(await dbm.putMemoryObjectWithOutbox((window as any).__refl("架空の振り返り（端末で更新）", LATER), "reflection"));
        await (window as any).__settle(await dbm.putSourceWithOutbox((window as any).__source("架空の資料（端末で更新）", LATER)));
      }, { LATER });
      expect((await outbox(page, "reflection:c-refl")).status).toBe("held"); expect((await outbox(page, "source:c-src")).status).toBe("held");
      const reflView: any = await inspect(page, "memory", "c-refl");
      expect(reflView.snapshot.recordType).toBe("reflection");
      const a: any = await resolve(page, reflView.snapshot, "keep-both");
      expect(a.kind, JSON.stringify(a)).toBe("done"); expect(a.resolved).toBe(true);
      const srcView: any = await inspect(page, "source", "c-src");
      const b: any = await resolve(page, srcView.snapshot, "adopt-vault");
      expect(b.kind, JSON.stringify(b)).toBe("done"); expect(b.state, JSON.stringify(b)).toBe("clean");
      expect((await device(page, "source", "c-src") as any).content).toContain("手で直した");
      expect(await read(page, srcPath)).toContain("手で直した");
      expect(await read(page, reflPath)).toContain("端末で更新");
      expect(((await kept(page)) as any).versions.length).toBe(2);
    });

    test("anything that moved after the user looked stops the action and changes nothing: file, device record, Registry", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      await editMemoryOnBothSides(page);
      const view: any = await inspect(page, "memory", "c-mem-1");
      const snapshotOfFiles = async () => [await read(page, DAY_FILE), JSON.stringify(await kept(page))];

      // the file: another hand edit
      const file = await read(page, DAY_FILE);
      await write(page, DAY_FILE, file + "\n架空の追記\n");
      const before = await snapshotOfFiles();
      expect((await resolve(page, view.snapshot, "adopt-device") as any).reason).toBe("changed");
      expect(await snapshotOfFiles()).toEqual(before);
      await write(page, DAY_FILE, file);

      // the Registry row
      const shards: string[] = await page.evaluate(async () => { const out: string[] = []; const dir = await (await (window as any).__root.getDirectoryHandle(".tsumugi")).getDirectoryHandle("registry"); for await (const [n] of dir.entries()) out.push(`.tsumugi/registry/${n}`); return out; });
      const shard = (await Promise.all(shards.map(async (s) => [s, await read(page, s)]))).find(([, t]) => t.includes(DAY_FILE))!;
      const row = JSON.parse(shard[1]); row.files[DAY_FILE].size = 1;
      await write(page, shard[0], JSON.stringify(row));
      expect((await resolve(page, view.snapshot, "adopt-device") as any).reason).toBe("changed");
      expect(await snapshotOfFiles()).toEqual(before.map((v, i) => (i === 0 ? file : v)));
      await write(page, shard[0], shard[1]);

      // the device record: another tab saved a newer version
      await page.evaluate(async ({ DAY }) => { await (window as any).D.dbm.putMemoryObjectWithOutbox((window as any).__mem("c-mem-1", "架空の本文（さらに新しい）", `${DAY}T01:00:00.000Z`, "2026-10-23T00:00:00.000Z"), "memory"); }, { DAY });
      expect((await resolve(page, view.snapshot, "adopt-vault") as any).reason).toBe("changed");
      expect((await device(page, "memory", "c-mem-1") as any).content).toContain("さらに新しい");
      expect(await read(page, DAY_FILE)).toBe(file);
    });

    for (const failAt of ["after-kept", "after-file", "after-requeue"]) {
      test(`interrupted ${failAt} (両方保持): both versions survive, the next start-up or the same action finishes it, and nothing doubles`, async ({ page }) => {
        test.setTimeout(180_000);
        await setup(page);
        await editMemoryOnBothSides(page);
        const view: any = await inspect(page, "memory", "c-mem-1");
        const r: any = await resolve(page, view.snapshot, "keep-both", { failAt });
        expect(r.kind).toBe("interrupted");
        expect(((await kept(page)) as any).versions[0].vaultText).toContain("手で書き直した");
        expect((await device(page, "memory", "c-mem-1") as any).content).toContain("端末で更新した");
        await page.reload(); await setup(page, false);
        await startUp(page);
        if ((await outbox(page, "memory:c-mem-1")).status !== "done") {
          const next: any = await inspect(page, "memory", "c-mem-1");
          const done: any = await resolve(page, next.snapshot, next.state === "differs" ? "keep-both" : "resume");
          expect(done.kind, JSON.stringify(done)).toBe("done");
        }
        expect((await check(page)).state).toBe("clean");
        const file = await read(page, DAY_FILE);
        expect(entriesWith(file, "c-mem-1").length).toBe(1); expect(file).toContain("端末で更新した");
        expect(((await kept(page)) as any).versions.length).toBe(1);
      });
    }

    for (const [label, failAt] of [["Memory", "after-device"], ["Memory", "after-file"], ["Source", "after-device"]] as const) {
      test(`interrupted ${failAt} (保存先の版を採用, ${label}): the device version stays in the kept copy and the same text ends up on both sides`, async ({ page }) => {
        test.setTimeout(180_000);
        await setup(page);
        if (label === "Memory") await editMemoryOnBothSides(page);
        else {
          const srcPath = await page.evaluate(async () => { const h = await (window as any).__root.getDirectoryHandle("Sources"); for await (const [n] of h.entries()) return `Sources/${n}`; });
          await write(page, srcPath as string, (await read(page, srcPath as string)).replace("架空の資料の本文", "架空の資料（手で直した）"));
          await page.evaluate(async ({ LATER }) => (window as any).__settle(await (window as any).D.dbm.putSourceWithOutbox((window as any).__source("架空の資料（端末で更新）", LATER))), { LATER });
        }
        const [type, id] = label === "Memory" ? ["memory", "c-mem-1"] : ["source", "c-src"];
        const view: any = await inspect(page, type, id);
        expect((await resolve(page, view.snapshot, "adopt-vault", { failAt }) as any).kind).toBe("interrupted");
        expect(((await kept(page)) as any).versions[0].deviceRaw).toContain("端末で更新");
        await page.reload(); await setup(page, false);
        await startUp(page);
        const after: any = await inspect(page, type, id);
        if (after.state !== "same" || (await check(page)).state !== "clean") {
          const again: any = await resolve(page, after.snapshot, after.state === "differs" ? "adopt-device" : "resume");
          expect(again.kind, JSON.stringify(again)).toBe("done");
        }
        expect((await check(page)).state).toBe("clean");
        const rec: any = await device(page, label === "Memory" ? "memory" : "source", id);
        expect(rec.content).toContain("手");   // the hand-edited text is what the device holds now
        expect(((await kept(page)) as any).versions.length).toBeGreaterThan(0);
      });
    }

    test("two tabs choose at the same time: exactly one action runs, the other stops, and nothing doubles", async ({ page, context }) => {
      test.setTimeout(180_000);
      await setup(page);
      await editMemoryOnBothSides(page);
      const view: any = await inspect(page, "memory", "c-mem-1");
      const other = await context.newPage();
      await setup(other, false);
      const [a, b]: any[] = await Promise.all([resolve(page, view.snapshot, "adopt-device"), resolve(other, view.snapshot, "adopt-vault")]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds, JSON.stringify([a, b])).toEqual(["done", "not-started"]);
      const file = await read(page, DAY_FILE);
      expect(entriesWith(file, "c-mem-1").length).toBe(1);
      expect(((await kept(page)) as any).versions.length).toBe(1);
      expect((await check(page)).state).toBe("clean");
    });

    test("no choice is offered when the record can not be separated, appears twice, or was deleted; every byte stays", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      await editMemoryOnBothSides(page);
      const file = await read(page, DAY_FILE);
      // appears twice
      const entry = entriesWith(file, "c-mem-1")[0];
      await write(page, DAY_FILE, file + SEPARATOR + entry);
      let view: any = await inspect(page, "memory", "c-mem-1");
      expect(view.state).toBe("blocked"); expect(view.blockReason).toBe("duplicate-in-file"); expect(view.choices).toEqual([]);
      // the entry's frontmatter was broken by hand: only a mention of its id remains
      await write(page, DAY_FILE, file.replace(entry, `手で壊した c-mem-1 のメモ\n`));
      view = await inspect(page, "memory", "c-mem-1");
      expect(view.state).toBe("blocked"); expect(view.blockReason).toBe("not-separable");
      expect(await read(page, DAY_FILE)).toContain("手で壊した");
    });

    test("the file was fixed by hand to match the device: only 保存を再開する is offered, and the start-up also resumes by itself", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      await editMemoryOnBothSides(page);
      const view: any = await inspect(page, "memory", "c-mem-1");
      const file = await read(page, DAY_FILE);
      await write(page, DAY_FILE, file.split(SEPARATOR).map((s) => (s.includes("id: c-mem-1") ? view.deviceText : s)).join(SEPARATOR));
      const same: any = await inspect(page, "memory", "c-mem-1");
      expect(same.state).toBe("same"); expect(same.choices).toEqual(["resume"]);
      const r: any = await resolve(page, same.snapshot, "resume");
      expect(r.kind, JSON.stringify(r)).toBe("done"); expect(r.resolved).toBe(true); expect(r.state).toBe("clean");
      expect(((await kept(page)) as any).versions.length).toBe(0);
    });

    test("Recovery Apply does not turn a hand edit into Tsumugi's version: the next device update holds and the hand-written text stays", async ({ page }) => {
      test.setTimeout(180_000);
      await setup(page);
      const conversationPath = await page.evaluate(async () => { const h = await (window as any).__root.getDirectoryHandle("Conversations"); for await (const [n] of h.entries()) return `Conversations/${n}`; }) as string;
      // a note the parser does not read (so the file still reads as equal to the device), and a Registry that lost its rows (old / damaged)
      await write(page, conversationPath, (await read(page, conversationPath)).replace("## Transcript", "架空の手書きのメモ\n\n## Transcript"));
      const shards: string[] = await page.evaluate(async () => { const out: string[] = []; const dir = await (await (window as any).__root.getDirectoryHandle(".tsumugi")).getDirectoryHandle("registry"); for await (const [n] of dir.entries()) out.push(`.tsumugi/registry/${n}`); return out; });
      for (const shard of shards) {
        const v = JSON.parse(await read(page, shard));
        for (const [p, row] of Object.entries<any>(v.files)) if (p === conversationPath) { delete v.files[p]; for (const [k, value] of Object.entries(v.records)) if (value === p) delete v.records[k]; void row; }
        await write(page, shard, JSON.stringify(v));
      }
      await page.evaluate(async () => {
        const { autoRepairRun } = (window as any).D;
        await autoRepairRun.runProductionVaultAutoRepair({ root: (window as any).__root, backend: "opfs", build: "e2e", isCancelled: () => false, checkOptions: { drainWaitMs: 1500, pollMs: 100, attempts: 3, retryDelayMs: 200 } });
      });
      await page.evaluate(async ({ LATER }) => (window as any).__settle(await (window as any).D.dbm.putConversationWithOutbox((window as any).__conv(["架空の問い", "架空の答え", "架空の続き"], LATER))), { LATER });
      expect(await read(page, conversationPath)).toContain("架空の手書きのメモ");
      expect((await outbox(page, "conversation:c-conv")).status).toBe("held");
    });
  });
}

test.describe("the app (Settings)", () => {
  for (const name of ["PC", "Android"] as const) {
    test.describe(name, () => {
      if (name === "Android") test.use({ userAgent: ANDROID_UA, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
      test("a conflict hides 「✓ 最新の状態です」, shows both versions and what each choice changes, and after 両方保持 the fresh check says 「✓ 最新の状態です」", async ({ page }) => {
        test.setTimeout(240_000);
        await page.goto(`${BASE}/data`); await page.addScriptTag({ path: bundle });
        await page.evaluate(async () => {
          const { dbm, bootstrap } = (window as any).D; const root = await navigator.storage.getDirectory();
          const T = new Date(Date.now() - 86_400_000).toISOString(); const LATER = new Date(Date.now() - 3_600_000).toISOString();
          const meta = (id: string) => ({ id: `meta-${id}`, source: "ai-capture", sourceType: "chat", schemaVersion: "0.1", createdAt: T, updatedAt: T });
          const mem = (content: string, updatedAt: string) => ({ id: "app-c-mem", date: T, types: ["conversation"], conversationId: "app-c-conv", content, summary: "架空の要約", keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: T, updatedAt, metadata: meta("app-c-mem") });
          await dbm.saveVaultHandle(root); await dbm.markVaultEpochCommitted(0); await dbm.markVaultWorldJournalMigrated();
          await dbm.putConversationWithOutbox({ id: "app-c-conv", persona: "companion", status: "captured", startedAt: T, endedAt: T, createdAt: T, updatedAt: T, memoryObjectIds: ["app-c-mem"], turns: [{ role: "user", content: "架空の話", timestamp: T }], metadata: meta("app-c-conv") });
          await dbm.putMemoryObjectWithOutbox(mem("架空の本文", T));
          await bootstrap.runSaveFoundationBootstrap({ root });
          const memories = await root.getDirectoryHandle("Memories");
          for await (const [n, h] of (memories as any).entries()) {
            const text = await (await h.getFile()).text();
            const w = await h.createWritable(); await w.write(text.replace("架空の本文", "架空の本文（手で直した）")); await w.close();
            void n;
          }
          await dbm.putMemoryObjectWithOutbox(mem("架空の本文（端末で更新）", LATER));
          await bootstrap.runSaveFoundationBootstrap({ root });
        });
        await page.goto(BASE);
        await page.getByRole("button", { name: "tsumugiを開く" }).click();
        await page.getByRole("navigation", { name: "メインナビゲーション" }).getByRole("button", { name: "設定" }).click();
        await expect(page.getByTestId("vault-conflicts")).toBeVisible({ timeout: 90_000 });
        await expect(page.getByText("✓ 最新の状態です")).toHaveCount(0);
        await page.getByTestId("vault-conflict-open").click();
        await expect(page.getByTestId("vault-conflict-diff")).toContainText("手で直した");
        await expect(page.getByTestId("vault-conflict-diff")).toContainText("端末で更新");
        await expect(page.getByTestId("vault-conflict-choice-adopt-vault")).toBeVisible();
        await page.getByTestId("vault-conflict-choice-keep-both").click();
        await expect(page.getByTestId("vault-conflict-confirmation")).toContainText("失われる内容はありません");
        await page.getByTestId("vault-conflict-confirm").click();
        await expect(page.getByText("✓ 最新の状態です")).toBeVisible({ timeout: 90_000 });
        await expect(page.getByTestId("vault-conflicts")).toHaveCount(0);
        await expect(page.getByTestId("vault-conflict-outcome")).toContainText("問題が無くなった");
        await expect(page.getByTestId("vault-kept-version")).toHaveCount(1);
        const kept = await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory(); const dir = await (await root.getDirectoryHandle(".tsumugi")).getDirectoryHandle("conflict-versions");
          const out: string[] = []; for await (const [, h] of (dir as any).entries()) out.push(await (await h.getFile()).text()); return out;
        });
        expect(kept.length).toBe(1); expect(kept[0]).toContain("手で直した");
      });
    });
  }
});
