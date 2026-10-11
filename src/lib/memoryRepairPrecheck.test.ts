/**
 * READ-ONLY pre-flight diagnostic: it can not reach a write path, never prints user text, reports READY/HOLD and
 * database differences correctly, and its failure can not affect normal use. Run: `npm run test:memory-repair`.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..");
const SRC = path.join(__dirname, "..", "..", "src");
const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};
type MemoryObject = import("./types").MemoryObject;
type Conversation = import("./types").Conversation;
const repair = require(path.join(OUT, "lib/memoryContaminationRepair.js")) as typeof import("./memoryContaminationRepair");
const pre = require(path.join(OUT, "lib/memoryRepairPrecheck.js")) as typeof import("./memoryRepairPrecheck");
const fx = require(path.join(OUT, "lib/memoryRepairTestWorld.js")) as typeof import("./memoryRepairTestWorld");
const D = fx.D;

// ---------------------------------------------------------------- a STRICT read-only fake IndexedDB factory
interface Seed { conversations: Conversation[]; memories: MemoryObject[]; outbox?: unknown[]; settings?: Record<string, string> }
function fakeFactory(seed: Seed | null, opts: { failOpen?: boolean } = {}) {
  const log = { opens: 0, created: false, modes: [] as string[], stores: [] as string[], settingsGets: [] as string[], illegal: [] as string[] };
  const stores: Record<string, Map<string, unknown>> = seed ? {
    conversations: new Map(seed.conversations.map((c) => [c.id, c])), memoryObjects: new Map(seed.memories.map((m) => [m.id, m])),
    vaultOutbox: new Map((seed.outbox ?? []).map((o) => [(o as { id: string }).id, o])), settings: new Map(Object.entries({ "gemini-api-key": "SECRET-API-KEY", ...(seed.settings ?? {}) })),
  } : {};
  const request = <T,>(compute: () => T) => {
    const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    setTimeout(() => { r.result = compute(); r.onsuccess?.(); }, 0);
    return r;
  };
  const db = {
    objectStoreNames: { contains: (n: string) => n in stores },
    close() { /* no-op */ },
    transaction(name: string, mode: string) {
      log.modes.push(mode); log.stores.push(name);
      const store = stores[name];
      const allowed = ["get", "getAll", "getAllKeys"];
      return { objectStore: () => new Proxy({
        get: (key: string) => request(() => { if (name === "settings") log.settingsGets.push(key); return store.get(key); }),
        getAll: () => request(() => [...store.values()]),
        getAllKeys: () => request(() => [...store.keys()]),
      } as Record<string, unknown>, { get: (t, p: string) => { if (!allowed.includes(p)) { log.illegal.push(`${name}.${p}`); throw new TypeError(`illegal store access: ${p}`); } return t[p]; } }) };
    },
  };
  const factory = {
    databases: async () => (seed ? [{ name: "tsumugi", version: 8 }] : []),
    open(name: string) {
      log.opens++;
      if (opts.failOpen) throw new Error("secret-detail タナカさん");
      const r: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: (e: unknown) => void } = {};
      setTimeout(() => {
        if (!seed) { log.created = true; r.onupgradeneeded?.({ target: { transaction: { abort() { log.created = false; } } } }); return; }
        r.result = db; r.onsuccess?.();
      }, 0);
      void name; return r;
    },
  };
  return { factory: factory as unknown as IDBFactory, log, stores };
}
const env = (factory: IDBFactory) => ({ indexedDB: factory, build: "test-build", now: () => "2026-10-10T00:00:00.000Z" });
const JP = /[぀-ヿ一-鿿]/;
const without = (text: string, ...allowed: string[]) => allowed.reduce((t, a) => t.split(a).join(""), text);

function seedWorld(): Seed & { w: ReturnType<typeof fx.world> } {
  const w = fx.world();
  for (const b of D.backfill) w.conversations.push(fx.conv(b.conversationId, [b.expectedFirstUserTurn, ...b.memory.evidence, fx.joinKeywords(b.memory.keywords)], "2026-09-24T04:00:00.000Z"));
  return { conversations: w.conversations, memories: w.memories, w };
}
const statusOf = (report: import("./memoryRepairPrecheck").PrecheckReport, key: string) => report.items.find((i) => i.key === key)!;

test("read-only: only readonly transactions with get/getAll, never a write method, never the API key, DB unchanged", async () => {
  const seed = seedWorld();
  const { factory, log, stores } = fakeFactory(seed);
  const before = JSON.stringify([...Object.entries(stores)].map(([k, v]) => [k, [...v.entries()]]));
  const { report } = await pre.runMemoryRepairPrecheck(env(factory), D);
  assert.equal(report.status, "ok");
  assert.ok(log.modes.length > 0 && log.modes.every((m) => m === "readonly"));
  assert.deepEqual(log.illegal, []);
  assert.ok(log.settingsGets.every((k) => k.startsWith("memoryRepair:") || k.startsWith("memoryBackfill:")), "settings: only repair/backfill ledger keys");
  assert.ok(!log.settingsGets.includes("gemini-api-key"));
  assert.equal(JSON.stringify([...Object.entries(stores)].map(([k, v]) => [k, [...v.entries()]])), before);
  assert.equal(log.created, false);
});

test("READY/HOLD: all 8 repair items READY on the reviewed state (synthetic R8 has no foreign data); Backfill HOLD when its conversation is absent", async () => {
  const { report } = await pre.runMemoryRepairPrecheck(env(fakeFactory(seedWorld()).factory), D);
  assert.deepEqual(report.summary.repair, { READY: 8 });
  assert.deepEqual(report.summary.backfill, { READY: 9 });
  const none = fakeFactory({ conversations: fx.world().conversations, memories: fx.world().memories });
  const r2 = await pre.runMemoryRepairPrecheck(env(none.factory), D);
  assert.deepEqual(r2.report.summary.backfill, { HOLD: 9 });
  assert.ok(r2.report.items.filter((i) => i.kind === "backfill").every((i) => i.failed.includes("conversation-missing")));
});

test("R8: HOLD is maintained when entries from other conversations exist; only their state is reported (no text, no change)", async () => {
  const seed = seedWorld();
  const m = seed.w.memories.find((x) => x.id === D.repair.items.find((i) => i.key === "R8")!.memoryId)!;
  const bf = D.backfill.find((b) => b.key === "B2")!;
  m.personMentions = [
    { id: "p1", displayName: "タナカさん", quote: "まあ、タナカさんは同僚です。", assertion: "mention", relation: "colleague", sourceConversationId: bf.conversationId } as never,
    { id: "p2", displayName: "タナカさん", quote: "タナカさんは同僚じゃなくて友人です。", assertion: "correction", relation: "friend", sourceConversationId: "some-skipped-conversation" } as never];
  const { factory, stores } = fakeFactory(seed);
  const before = JSON.stringify([...stores.memoryObjects.entries()]);
  const { report, text } = await pre.runMemoryRepairPrecheck(env(factory), D);
  assert.equal(statusOf(report, "R8").status, "HOLD");
  const held = report.heldForeign.find((h) => h.key === "R8")!;
  assert.equal(held.holdMaintained, true);
  assert.deepEqual(held.foreign.map((f) => [f.field, f.assertion, f.sourceConversationExists, f.sourceHasOwnNormalMemory, f.backfillKey]), [["personMentions", "mention", true, false, "B2"], ["personMentions", "correction", false, false, null]]);
  assert.match(text, /## R8: HOLD maintained=true/);
  assert.equal(JSON.stringify([...stores.memoryObjects.entries()]), before);
  assert.deepEqual(report.summary.repair, { READY: 7, HOLD: 1 });
});

test("differences against IndexedDB are detected and named (kind only)", async () => {
  const seed = seedWorld();
  const k = D.repair.items[0];
  seed.w.memories.find((x) => x.id === k.memoryId)!.summary = "別の要約";
  const k2 = D.repair.items[1];
  seed.w.memories.find((x) => x.id === k2.memoryId)!.links.push({ ...seed.w.memories.find((x) => x.id === k2.memoryId)!.links[0], id: "UNREVIEWED-LINK" });
  const k3 = D.repair.items[4];
  seed.w.memories.push(fx.mem(await repair.updatingMemoryIdFor(k3.updatingConversationId), "someone-else", "衝突するメモリ", "衝突", fx.NOW));
  const k4 = D.repair.items[5];
  seed.conversations = seed.conversations.filter((c) => c.id !== k4.originalConversationId);
  const { report, text } = await pre.runMemoryRepairPrecheck(env(fakeFactory(seed).factory), D);
  const a = statusOf(report, k.key); assert.equal(a.status, "HOLD"); assert.deepEqual(a.facts!.diff, ["summary"]);
  const b = statusOf(report, k2.key); assert.equal(b.status, "HOLD"); assert.equal(b.facts!.links!.unreviewed, 1);
  const c = statusOf(report, k3.key); assert.equal(c.status, "HOLD"); assert.equal(c.facts!.newMemoryState, "conflict");
  const d = statusOf(report, k4.key); assert.equal(d.status, "HOLD"); assert.equal(d.facts!.originalConversationExists, false);
  assert.match(text, /diff-from-reviewed-state: summary/);
});

test("ledger / Outbox state is reported; a finished item is shown as LEDGER_DONE", async () => {
  const seed = seedWorld();
  const item = D.repair.items[2];
  seed.settings = { [repair.repairLedgerKey(item.memoryId)]: "{}" };
  seed.outbox = [{ id: `memory:${item.memoryId}`, recordType: "memory", recordId: item.memoryId, recordUpdatedAt: "1999-01-01T00:00:00.000Z", status: "pending" }];
  const { report } = await pre.runMemoryRepairPrecheck(env(fakeFactory(seed).factory), D);
  const r = statusOf(report, item.key);
  assert.equal(r.status, "LEDGER_DONE"); assert.equal(r.ledger, "present");
  assert.equal(r.facts!.outbox[`memory:${item.memoryId}`], "stale");
  assert.deepEqual(report.totals.outbox, { pending: 1 });
});

test("privacy: the text contains no user text (no Japanese at all), even when a check detail would carry it", async () => {
  const seed = seedWorld();
  const item = D.repair.items[3];
  const o = seed.w.conversations.find((c) => c.id === item.originalConversationId)!;
  o.turns = [{ role: "user", content: "全く関係のない私的な話", timestamp: fx.T0 }];
  const { report, text } = await pre.runMemoryRepairPrecheck(env(fakeFactory(seed).factory), D);
  assert.equal(statusOf(report, item.key).status, "HOLD");
  assert.ok(statusOf(report, item.key).failed.some((f) => f.includes("<text>")), "Japanese detail is replaced");
  assert.equal(JP.test(text), false, "no Japanese characters (Memory / Conversation text) in the output");
  for (const m of seed.w.memories) { assert.ok(!text.includes(m.summary)); assert.ok(!text.includes(m.content)); }
  assert.ok(!text.includes("SECRET-API-KEY"));
  assert.equal(pre.safeDetail("ascii-id:123"), "ascii-id:123"); assert.equal(pre.safeDetail("タナカさん"), "<text>");
  void without;
});

test("failure handling: no database => nothing created; open failure => error report without leaking the message; never throws", async () => {
  const none = fakeFactory(null);
  const a = await pre.runMemoryRepairPrecheck(env(none.factory), D);
  assert.equal(a.report.status, "no-database"); assert.equal(none.log.created, false);
  assert.match(a.text, /status=no-database/);
  const broken = fakeFactory(seedWorld(), { failOpen: true });
  const b = await pre.runMemoryRepairPrecheck(env(broken.factory), D);
  assert.equal(b.report.status, "error"); assert.equal(b.report.error, "Error");
  assert.ok(!b.text.includes("secret-detail") && !JP.test(b.text));
});

// ---------------------------------------------------------------- the diagnostic can not reach a write path (structure)
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
function resolveImport(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  if (!base) return null;
  for (const ext of [".ts", ".tsx", "/index.ts"]) if (fs.existsSync(base + ext)) return base + ext;
  return null;
}
function reachable(entry: string): { files: string[]; externals: string[] } {
  const seen = new Set<string>(), externals = new Set<string>(), stack = [entry];
  while (stack.length) {
    const file = stack.pop()!; if (seen.has(file)) continue; seen.add(file);
    for (const m of strip(fs.readFileSync(file, "utf8")).matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g)) {
      const spec = m[1] ?? m[2]; const resolved = resolveImport(file, spec);
      if (resolved) stack.push(resolved); else externals.add(spec);
    }
  }
  return { files: [...seen].map((f) => path.relative(SRC, f)), externals: [...externals] };
}
const ENTRIES = ["lib/memoryRepairPrecheck.ts", "components/MemoryRepairPrecheck.tsx", "app/diagnostics/memory-repair/page.tsx"].map((p) => path.join(SRC, p));

test("structure: the diagnostic's whole import graph excludes the storage layer, the runner, Vault, Capture and any write API", () => {
  const FORBIDDEN = ["lib/db.ts", "lib/memoryRepairRunner.ts", "lib/memoryRepairDbEnv.ts", "lib/vault.ts", "lib/capture.ts", "lib/vaultOutbox.ts", "lib/vaultProjection.ts", "lib/connect.ts", "lib/recoveryBackgroundCheck.ts"];
  for (const entry of ENTRIES) {
    const { files, externals } = reachable(entry);
    for (const f of FORBIDDEN) assert.ok(!files.includes(f), `${path.relative(SRC, entry)} must not reach ${f}`);
    for (const e of externals) assert.ok(["react", "next", "next/navigation"].includes(e) || e.startsWith("node:") === false, e);
  }
  const lib = reachable(ENTRIES[0]).files.sort();
  assert.deepEqual(lib, ["lib/memoryBackfill.ts", "lib/memoryContaminationRepair.ts", "lib/memoryRepairPrecheck.ts", "lib/privateRepairData.ts", "lib/types.ts"], "the read-only module reaches only the two pure planners and the types");
});

test("structure: no write / network / persistence token in the diagnostic sources", () => {
  const BAN = /readwrite|\.put\(|\.add\(|\.delete\(|\.clear\(|\.openCursor|\bfetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|commitMemoryRepairTransaction|runContaminationRepair|runBackfill|rollbackContaminationRepair|createDbRepairEnv/;
  for (const entry of ENTRIES) assert.equal(BAN.test(strip(fs.readFileSync(entry, "utf8"))), false, path.relative(SRC, entry));
  const reader = strip(fs.readFileSync(ENTRIES[0], "utf8"));
  assert.ok(/transaction\(n, "readonly"\)/.test(reader) && !/"readwrite"/.test(reader));
  assert.ok(/factory\.open\(DB_NAME\)/.test(reader), "open without a version: never upgrades");
});

test("exposure: off by default (404 unless the build flag is set), not linked from any screen, imported by nothing else, no startup effect", () => {
  const page = strip(fs.readFileSync(ENTRIES[2], "utf8"));
  assert.ok(page.indexOf('process.env.NEXT_PUBLIC_MEMORY_REPAIR_PRECHECK !== "1"') < page.indexOf("<MemoryRepairPrecheck />"));
  assert.ok(/notFound\(\)/.test(page));
  const component = fs.readFileSync(ENTRIES[1], "utf8");
  assert.ok(!/useEffect/.test(component), "opening the page reads nothing: no effect");
  assert.ok(/armed/.test(component) && /disabled=\{!armed/.test(component), "typed confirmation required");
  const offenders: string[] = [];
  const walk = (dir: string) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name)) {
    const rel = path.relative(SRC, p); const src = fs.readFileSync(p, "utf8");
    if (/memoryRepairPrecheck|MemoryRepairPrecheck|diagnostics\/memory-repair/.test(src) && !/memoryRepairPrecheck|MemoryRepairPrecheck|app\/diagnostics\/memory-repair/.test(rel)) offenders.push(rel);
  } } };
  walk(SRC);
  assert.deepEqual(offenders, [], "no screen links to or imports the diagnostic");
});
