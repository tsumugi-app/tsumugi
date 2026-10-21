/**
 * Repair pre-check scope (fictional data only): selection guard, Outbox conflict view, Vault-check summary, overall verdict, and the
 * structural "no write path" guarantee. Run: `npm run test:maintenance`.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..", "..");
const SRC = path.join(__dirname, "..", "..", "..", "src");
const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "idb") return require(path.join(OUT, "lib/fakeIdb.js"));
  return origLoad.call(this, request, parent, isMain);
};
const scope = require(path.join(OUT, "lib/maintenance/precheckScope.js")) as typeof import("./precheckScope");
const fx = require(path.join(OUT, "lib/memoryRepairTestWorld.js")) as typeof import("../memoryRepairTestWorld");
type PrivateRepairData = import("../privateRepairData").PrivateRepairData;
type OutboxLike = import("../memoryRepairPrecheck").OutboxLike;
type MemoryObject = import("../types").MemoryObject;

/** fictional data only: every key below is invented by the fixtures; no real key or id appears in this repository */
function data(): PrivateRepairData { return JSON.parse(JSON.stringify(fx.D)) as PrivateRepairData; }
const input = () => { const w = fx.world(); return { conversations: w.conversations, memories: w.memories, outbox: [] as OutboxLike[], settings: {} as Record<string, string | undefined> }; };
const decisionsFor = (held: string[], excluded: string[]) => {
  const p = scope.parseDecisions(JSON.stringify({ format: "tsumugi-repair-decisions", schema: 1, held, excluded }));
  assert.ok(p.ok); return (p as { ok: true; decisions: import("./precheckScope").Decisions }).decisions;
};
const allReady = (d: PrivateRepairData) => Object.fromEntries([...d.repair.items.map((i) => i.key), ...d.backfill.map((b) => b.key)].map((k) => [k, "READY" as const]));

test("decision list: strict parse; malformed, wrong format, duplicates and non-string keys are rejected with fixed codes", () => {
  const bad = (v: unknown) => scope.parseDecisions(typeof v === "string" ? v : JSON.stringify(v));
  assert.deepEqual(bad("{not json"), { ok: false, error: "not-json" });
  assert.deepEqual(bad([]), { ok: false, error: "not-object" });
  assert.deepEqual(bad({ format: "x", schema: 1, held: [], excluded: [] }), { ok: false, error: "wrong-format-or-schema" });
  assert.deepEqual(bad({ format: "tsumugi-repair-decisions", schema: 2, held: [], excluded: [] }), { ok: false, error: "wrong-format-or-schema" });
  assert.deepEqual(bad({ format: "tsumugi-repair-decisions", schema: 1, held: "a", excluded: [] }), { ok: false, error: "lists" });
  assert.deepEqual(bad({ format: "tsumugi-repair-decisions", schema: 1, held: [1], excluded: [] }), { ok: false, error: "lists" });
  assert.deepEqual(bad({ format: "tsumugi-repair-decisions", schema: 1, held: ["a"], excluded: ["a"] }), { ok: false, error: "duplicate-key" });
  assert.equal(bad({ format: "tsumugi-repair-decisions", schema: 1, held: [], excluded: [] }).ok, true);
});

test("nothing is selectable without a valid decision list (not loaded, or naming a key the data does not have)", () => {
  const d = data(); const live = allReady(d);
  for (const it of scope.listItems(d, null, live)) { assert.equal(it.selectable, false); assert.equal(it.reason, "decisions-not-loaded"); }
  assert.equal(scope.selectionError(d, null, live, [d.repair.items[0].key]), "not-selectable");
  const typo = decisionsFor(["no-such-key"], []);
  assert.equal(scope.decisionsError(d, typo), "decision-key-not-in-data");
  for (const it of scope.listItems(d, typo, live)) assert.equal(it.selectable, false);
  assert.equal(scope.selectionError(d, typo, live, [d.repair.items[0].key]), "not-selectable");
});

test("two layers: held / excluded by decision are never selectable, even when READY; non-READY live items are not selectable either", () => {
  const d = data();
  const heldKey = d.repair.items[0].key, otherKey = d.repair.items[1]?.key;
  const exKey = d.backfill[0]?.key;
  const dec = decisionsFor([heldKey], exKey ? [exKey] : []);
  const live = allReady(d);
  const byKey = (l: ReturnType<typeof scope.listItems>, k: string) => l.find((x) => x.key === k)!;
  const l1 = scope.listItems(d, dec, live);
  assert.equal(byKey(l1, heldKey).selectable, false); assert.equal(byKey(l1, heldKey).reason, "held by decision");
  if (exKey) { assert.equal(byKey(l1, exKey).selectable, false); assert.equal(byKey(l1, exKey).reason, "excluded by decision"); }
  assert.equal(scope.selectionError(d, dec, live, [heldKey]), "not-selectable");
  if (otherKey) assert.equal(byKey(l1, otherKey).selectable, true);
  if (otherKey) assert.equal(scope.selectionError(d, dec, live, [otherKey]), null);
  if (otherKey) assert.equal(scope.selectionError(d, dec, live, [otherKey, heldKey]), "not-selectable");
  // live layer: HOLD / ALREADY_DONE / LEDGER_DONE / unknown / not scanned
  if (otherKey) {
    for (const st of ["HOLD", "ALREADY_DONE", "LEDGER_DONE"] as const) {
      const l = scope.listItems(d, dec, { ...live, [otherKey]: st });
      assert.equal(byKey(l, otherKey).selectable, false, st);
    }
    assert.equal(byKey(scope.listItems(d, dec, null), otherKey).reason, "not scanned yet");
    const partial = { ...live }; delete (partial as Record<string, unknown>)[otherKey];
    assert.equal(byKey(scope.listItems(d, dec, partial), otherKey).reason, "no live status");
  }
  assert.equal(scope.selectionError(d, dec, live, []), "nothing-selected");
  assert.equal(scope.selectionError(d, dec, live, ["does-not-exist"]), "unknown-key");
  assert.equal(scope.selectionError(d, dec, live, ["a", "b", "c", "d"]), "too-many-selected");
  assert.equal(scope.selectionError(d, dec, live, [otherKey ?? heldKey, otherKey ?? heldKey]), otherKey ? "duplicate-key" : "not-selectable");
});

test("live scan covers every item and uses the reviewed planners (read-only)", async () => {
  const d = data();
  const live = await scope.scanLiveStatuses(input(), d, fx.NOW);
  const keys = [...d.repair.items.map((i) => i.key), ...d.backfill.map((b) => b.key)];
  assert.deepEqual(Object.keys(live).sort(), [...keys].sort());
  for (const st of Object.values(live)) assert.ok(["READY", "HOLD", "ALREADY_DONE", "LEDGER_DONE"].includes(st));
});

test("subsetData keeps only the selected keys (and only the updating specs they need)", () => {
  const d = data(); const k = d.repair.items[0].key;
  const s = scope.subsetData(d, [k]);
  assert.deepEqual(s.repair.items.map((i) => i.key), [k]);
  assert.deepEqual(Object.keys(s.repair.updating), [d.repair.items[0].updatingConversationId]);
  assert.equal(s.backfill.length, 0);
});

test("analysis: IndexedDB pre-flight, existing records for the Vault check, and no Outbox conflict in a clean world", async () => {
  const d = data(); const k = d.repair.items[0].key;
  const a = await scope.analyzeSelection(input(), d, [k], fx.NOW);
  assert.equal(a.report.items.length, 1);
  assert.ok(["READY", "HOLD", "ALREADY_DONE", "LEDGER_DONE"].includes(a.report.items[0].status));
  const spec = d.repair.items[0];
  assert.ok(a.existing.some((r) => r.kind === "memory" && r.id === spec.memoryId));
  assert.ok(a.existing.some((r) => r.kind === "conversation" && r.id === spec.originalConversationId));
  assert.ok(!a.existing.some((r) => r.id === a.report.items[0].facts?.newMemoryId), "a Memory that does not exist yet is never handed to the Vault check");
  assert.deepEqual(a.conflicts, []);
});

test("Outbox conflicts: unfinished entries that share a day-file / shard / month are named; done, own and unrelated entries are not", async () => {
  const d = data(); const spec = d.repair.items[0];
  const inp = input();
  const target = inp.memories.find((m) => m.id === spec.memoryId) as MemoryObject;
  const sameDay: MemoryObject = { ...target, id: "other-same-day-000001" };
  const farAway: MemoryObject = { ...target, id: "other-far-away-000002", date: "2031-01-15T00:00:00.000Z" };
  inp.memories = [...inp.memories, sameDay, farAway];
  const entry = (m: MemoryObject, status: string): OutboxLike => ({ id: `memory:${m.id}`, recordType: "memory", recordId: m.id, recordUpdatedAt: m.updatedAt, status });
  inp.outbox = [entry(sameDay, "pending"), entry(farAway, "pending"), { ...entry(sameDay, "done"), id: "memory:done-one", recordId: "done-one" }, entry(target, "pending")];
  const c = scope.outboxConflicts({ outbox: inp.outbox, memories: inp.memories, conversations: inp.conversations, targets: { memoryIds: [spec.memoryId], conversationIds: [] } });
  const sd = c.find((x) => x.id === `memory:${sameDay.id}`);
  assert.ok(sd && sd.shares.includes("day-file") && sd.shares.includes("history-month"));
  const far = c.find((x) => x.id === `memory:${farAway.id}`);
  assert.ok(far && far.shares.length === 0 || far?.shares.every((s) => s === "registry-shard"), "a far-away entry shares no day-file or month");
  assert.ok(!c.some((x) => x.id === `memory:${spec.memoryId}`), "the target's own entry is not a conflict");
  assert.ok(!c.some((x) => x.id === "memory:done-one"), "finished entries are not listed");
  for (const x of c) assert.equal(x.tail.length, 6);
});

test("link counterparts: a removed link rewrites its counterpart, so an unfinished Outbox entry of the counterpart, a decision-protected Memory or a system-generated counterpart block the item (and the counterpart joins the Vault check)", async () => {
  const d = data(); const spec = d.repair.items.find((i) => i.key === "R8")!;       // the fixture item with a "remove" link
  const removed = Object.keys(spec.links).find((id) => spec.links[id] === "remove")!;
  const cpId = `CP-${removed}`;
  const clean = scope.summarizeDiagnosis([{ kind: "memory", id: "m", area: "markdown", item: "f", status: "ok", detail: "" }], 1);
  // clean world: the counterpart is part of the Vault check, nothing blocks
  const a0 = await scope.analyzeSelection(input(), d, [spec.key], fx.NOW);
  assert.equal(a0.report.items[0].status, "READY");
  assert.deepEqual(a0.blockers, []);
  assert.ok(a0.existing.some((r) => r.kind === "memory" && r.id === cpId), "the counterpart is handed to the Vault check");
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: a0.conflicts, vault: clean, blockers: a0.blockers }).safeToRepair, true);
  // an unfinished Outbox entry of the counterpart that shares no file with the targets must still block
  const inp = input();
  const cp = inp.memories.find((m) => m.id === cpId)!;
  inp.outbox = [{ id: `memory:${cpId}`, recordType: "memory", recordId: cpId, recordUpdatedAt: cp.updatedAt, status: "pending" } as OutboxLike];
  const a1 = await scope.analyzeSelection(inp, d, [spec.key], fx.NOW);
  assert.deepEqual(a1.blockers, [`counterpart-unfinished-outbox:${cpId.slice(-6)}`]);
  const v1 = scope.overallVerdict({ status: "READY", conflicts: a1.conflicts, vault: clean, blockers: a1.blockers });
  assert.equal(v1.safeToRepair, false); assert.equal(v1.code, "READY_COUNTERPART_BLOCKED");
  // a counterpart that belongs to an item the operator holds / excludes
  const a2 = await scope.analyzeSelection(input(), d, [spec.key], fx.NOW, [cpId]);
  assert.deepEqual(a2.blockers, [`counterpart-protected-by-decision:${cpId.slice(-6)}`]);
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: a2.conflicts, vault: clean, blockers: a2.blockers }).safeToRepair, false);
  // a system-generated counterpart (Reflection)
  const inp3 = input();
  const cp3 = inp3.memories.find((m) => m.id === cpId)!;
  cp3.metadata = { ...cp3.metadata, source: "system-generated" } as MemoryObject["metadata"];
  const a3 = await scope.analyzeSelection(inp3, d, [spec.key], fx.NOW);
  assert.deepEqual(a3.blockers, [`counterpart-system-generated:${cpId.slice(-6)}`]);
});

test("Vault diagnosis summary: file areas only; unreadable / legacy-format are unverified, mismatch / missing are mismatched", () => {
  const row = (area: "markdown" | "ledger" | "outbox" | "index" | "registry" | "history", status: "ok" | "mismatch" | "missing" | "legacy-format" | "unreadable") => ({ kind: "memory", id: "m1", area, item: "x", status, detail: "" });
  const v = scope.summarizeDiagnosis([row("markdown", "ok"), row("ledger", "mismatch"), row("outbox", "mismatch"), row("index", "missing"), row("registry", "unreadable"), row("history", "legacy-format")], 1);
  assert.equal(v.items.length, 4);
  assert.deepEqual(v.mismatched.map((d) => d.area), ["index"]);
  assert.deepEqual(v.unverified.map((d) => d.area).sort(), ["history", "registry"]);
});

test("overall verdict: only a READY item with a checked, clean Vault and no sharing conflict is 'safe'; every unproven case is not", () => {
  const clean = scope.summarizeDiagnosis([{ kind: "memory", id: "m", area: "markdown", item: "f", status: "ok", detail: "" }], 1);
  const conflictSharing = [{ id: "memory:x", tail: "000001", status: "pending", shares: ["day-file" as const] }];
  const conflictUnrelated = [{ id: "memory:y", tail: "000002", status: "pending", shares: [] }];
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: [], vault: clean }).safeToRepair, true);
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: conflictUnrelated, vault: clean }).safeToRepair, true, "unrelated pending entries are only listed");
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: [], vault: null }).code, "READY_VAULT_NOT_CHECKED");
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: [], vault: null }).safeToRepair, false);
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: conflictSharing, vault: clean }).code, "READY_OUTBOX_CONFLICT");
  const mism = scope.summarizeDiagnosis([{ kind: "memory", id: "m", area: "markdown", item: "f", status: "mismatch", detail: "" }], 1);
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: [], vault: mism }).code, "READY_VAULT_MISMATCH");
  const unv = scope.summarizeDiagnosis([{ kind: "memory", id: "m", area: "history", item: "f", status: "legacy-format", detail: "" }], 1);
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: [], vault: unv }).code, "READY_VAULT_UNVERIFIED");
  assert.equal(scope.overallVerdict({ status: "READY", conflicts: [], vault: unv }).safeToRepair, false);
  assert.equal(scope.overallVerdict({ status: "HOLD", conflicts: [], vault: clean }).code, "HOLD");
  assert.equal(scope.overallVerdict({ status: "ALREADY_DONE", conflicts: [], vault: clean }).code, "ALREADY_DONE");
  assert.equal(scope.overallVerdict({ status: "LEDGER_DONE", conflicts: [], vault: clean }).code, "ALREADY_DONE");
});

test("structural: the pre-check code has no write path (no readwrite transaction, put/add/delete, Vault writer, repair commit or permission request)", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const FILES = ["lib/maintenance/precheckScope.ts", "lib/memoryRepairPrecheck.ts", "lib/memoryContaminationRepair.ts", "lib/memoryBackfill.ts", "lib/privateRepairData.ts"];
  // (Set / Map `.add` / `.delete` on plain identifiers are fine; an IndexedDB store call is always `...).add(` / `...).delete(`)
  const BAN = /readwrite|\.put\(|\)\s*\.(add|delete|clear)\(|writeConversationMarkdown|writeMemoryObjectMarkdown|commitMemoryRepair|requestPermission|createWritable|removeEntry|fetch\(|localStorage|sessionStorage/;
  for (const f of FILES) assert.equal(BAN.test(strip(fs.readFileSync(path.join(SRC, f), "utf8"))), false, f);
  // the precheck section of the panel only calls the three read-only entry points
  const panel = strip(fs.readFileSync(path.join(SRC, "components/maintenance/MaintenancePanel.tsx"), "utf8"));
  assert.ok(/readPrecheckInput/.test(panel) && /analyzeSelection/.test(panel) && /diagnoseVaultForPrecheck/.test(panel));
  assert.ok(!/memoryRepairRunner|memoryRepairDbEnv|commitMemoryRepair/.test(panel));
  assert.ok(!/NEVER_SELECTABLE/.test(strip(fs.readFileSync(path.join(SRC, "lib/maintenance/precheckScope.ts"), "utf8"))), "no hard-coded exclusion list");
});
