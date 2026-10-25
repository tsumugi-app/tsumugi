/**
 * Non-target invariants: every kind of "touching something else" is detected, formatting-only drift included.
 * Run: `npm run test:maintenance`.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..", "..");
const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};
const inv = require(path.join(OUT, "lib/maintenance/invariants.js")) as typeof import("./invariants");
const md = require(path.join(OUT, "lib/markdown.js")) as typeof import("../markdown");

const T = "2026-08-20T00:00:00.000Z";
const mem = (id: string, summary: string, extra: Record<string, unknown> = {}) => ({
  id, date: T, types: ["conversation"], conversationId: "c-" + id, content: "内容 " + id, summary, keywords: ["k"], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
  links: [], createdAt: T, updatedAt: T, metadata: { id: "m-" + id, schemaVersion: "0.1", source: "ai-capture", createdAt: T, updatedAt: T }, ...extra,
}) as never;
const SEP = "\n<!-- tsumugi:entry -->\n\n";
const dayFile = (...ms: never[]) => md.serializeMemoryDayFile(ms);
const J = (v: unknown) => JSON.stringify(v, null, 2);
const ctx = { targetConversationIds: ["conv-T"], targetMemoryIds: ["mem-T"], targetDays: ["2026-08-20"], registryKeys: ["conv-T", "day:2026-08-20"] };
const codes = (changes: Parameters<typeof inv.checkVaultInvariants>[0]) => inv.checkVaultInvariants(changes, ctx).map((v) => v.code).sort();

test("index.json: only target keys may be added/changed; any other change, removal or reformat is a violation", () => {
  const before = { a: "Memories/a.md", b: "Memories/b.md" };
  assert.deepEqual(codes([{ path: ".tsumugi/index.json", before: J(before), after: J({ ...before, "mem-T": "Memories/2026-08-20.md" }) }]), []);
  assert.deepEqual(codes([{ path: ".tsumugi/index.json", before: J(before), after: J({ ...before, a: "Memories/x.md", "mem-T": "p" }) }]), ["non-target-entry-changed"]);
  assert.deepEqual(codes([{ path: ".tsumugi/index.json", before: J(before), after: J({ a: before.a, "mem-T": "p" }) }]), ["entry-removed"]);
  assert.deepEqual(codes([{ path: ".tsumugi/index.json", before: J(before), after: J({ ...before, other: "x", "mem-T": "p" }) }]), ["non-target-entry-added"]);
  assert.ok(codes([{ path: ".tsumugi/index.json", before: JSON.stringify(before), after: J({ ...before, "mem-T": "p" }) }]).includes("format-would-change"), "a compact (non-canonical) file would be reformatted => violation");
});

test("day-file: non-target members must stay byte-identical, in order; unparsable blocks and drift are violations", () => {
  const a = mem("a", "要約A"), b = mem("b", "要約B");
  const target = mem("mem-T", "対象");
  const before = dayFile(a, b);
  assert.deepEqual(codes([{ path: "Memories/2026-08-20.md", before, after: dayFile(a, b, target) }]), []);
  assert.deepEqual(codes([{ path: "Memories/2026-08-20.md", before, after: dayFile(a, mem("b", "要約B（書式変更）"), target) }]), ["non-target-member-bytes-changed"]);
  assert.deepEqual(codes([{ path: "Memories/2026-08-20.md", before, after: dayFile(a, target) }]).sort(), ["non-target-member-count-changed", "non-target-member-order-changed", "non-target-member-removed"]);
  assert.deepEqual(codes([{ path: "Memories/2026-08-20.md", before, after: dayFile(b, a, target) }]), ["non-target-member-order-changed"]);
  assert.ok(codes([{ path: "Memories/2026-08-20.md", before: before + SEP + "garbage block that is not a Tsumugi entry", after: dayFile(a, b, target) }]).includes("unparsable-member-in-day-file"));
  const drift = before.replace("要約A", "要約A "); // formatting drift of a non-target member: the writer's output differs from what was there
  assert.ok(codes([{ path: "Memories/2026-08-20.md", before: drift, after: dayFile(mem("a", "要約A"), b, target) }]).includes("non-target-member-bytes-changed"));
  assert.ok(codes([{ path: "Memories/2026-08-20.md", before, after: dayFile(a, b, target, mem("extra", "x")) }]).includes("non-target-member-added"));
});

test("History month: other days and non-target rows must be deep-equal; a v1 day must stay v1; version must not change", () => {
  const v2 = (rows: unknown[]) => ({ conversations: [], normalMemories: rows, reflections: [] });
  const base = { version: 2, month: "2026-08", days: { "2026-08-19": v2([{ id: "z", preview: "p", types: ["event"], createdAt: T, date: T }]), "2026-08-20": v2([{ id: "a", preview: "pa", types: ["conversation"], createdAt: T, date: T }]) } };
  const tRow = { id: "mem-T", preview: "pt", types: ["conversation"], createdAt: T, date: T };
  const ok = JSON.parse(JSON.stringify(base)); ok.days["2026-08-20"].normalMemories.push(tRow);
  assert.deepEqual(codes([{ path: ".tsumugi/history/2026-08.json", before: J(base), after: J(ok) }]), []);
  const otherDay = JSON.parse(JSON.stringify(ok)); otherDay.days["2026-08-19"].normalMemories[0].preview = "changed";
  assert.deepEqual(codes([{ path: ".tsumugi/history/2026-08.json", before: J(base), after: J(otherDay) }]), ["non-target-day-changed"]);
  const sameDayRow = JSON.parse(JSON.stringify(ok)); sameDayRow.days["2026-08-20"].normalMemories[0].date = "2026-08-20T00:00:00.000Z-normalized";
  assert.deepEqual(codes([{ path: ".tsumugi/history/2026-08.json", before: J(base), after: J(sameDayRow) }]), ["non-target-history-row-changed"]);
  const v1 = { version: 1, month: "2026-08", days: { "2026-08-20": { conversationIds: ["x"], normalMemoryCount: 1, reflectionIds: [], memoryCount: 1 } } };
  const upgraded = { version: 1, month: "2026-08", days: { "2026-08-20": v2([tRow]) } };
  assert.ok(codes([{ path: ".tsumugi/history/2026-08.json", before: J(v1), after: J(upgraded) }]).includes("history-day-format-upgraded"));
  const bumped = JSON.parse(JSON.stringify(ok)); bumped.version = 3;
  assert.ok(codes([{ path: ".tsumugi/history/2026-08.json", before: J(base), after: J(bumped) }]).includes("history-version-changed"));
});

test("history-meta: only the touched month, totals and updatedAt may change", () => {
  const before = { version: 1, months: { "2026-07": { memories: 3, conversations: 2 }, "2026-08": { memories: 1, conversations: 1 } }, totalMemories: 4, totalConversations: 3, updatedAt: "x" };
  const ok = { ...before, months: { ...before.months, "2026-08": { memories: 2, conversations: 1 } }, totalMemories: 5, updatedAt: "y" };
  assert.deepEqual(codes([{ path: ".tsumugi/history-meta.json", before: J(before), after: J(ok) }]), []);
  const bad = { ...ok, months: { ...ok.months, "2026-07": { memories: 9, conversations: 2 } } };
  assert.deepEqual(codes([{ path: ".tsumugi/history-meta.json", before: J(before), after: J(bad) }]), ["non-target-month-aggregate-changed"]);
  assert.ok(codes([{ path: ".tsumugi/history-meta.json", before: J(before), after: J({ ...ok, version: 2 }) }]).includes("meta-field-changed"));
});

test("registry shard: unrelated records/files and other members' hashes must be identical", () => {
  const shard = (extra: Record<string, unknown> = {}, memberIds = ["a", "b"], hashes: Record<string, string> = { a: "h1", b: "h2" }) => ({
    records: { "day:2026-08-20": "Memories/2026-08-20.md", other: "Memories/o.md", ...extra },
    files: { "Memories/2026-08-20.md": { recordType: "memory-day", memberIds, memberHashes: hashes, mtime: 1, size: 10, contentHash: "c" }, "Memories/o.md": { recordType: "memory-day", memberIds: ["o"], memberHashes: { o: "ho" }, mtime: 2, size: 1, contentHash: "co" } },
  });
  const written = [{ path: "Memories/2026-08-20.md", before: dayFile(mem("a", "A"), mem("b", "B")), after: dayFile(mem("a", "A"), mem("b", "B"), mem("mem-T", "T")) }];
  const after = shard({}, ["a", "b", "mem-T"], { a: "h1", b: "h2", "mem-T": "ht" });
  assert.deepEqual(codes([...written, { path: ".tsumugi/registry/2d.json", before: J(shard()), after: J(after) }]), []);
  const hashDrift = shard({}, ["a", "b", "mem-T"], { a: "h1-changed", b: "h2", "mem-T": "ht" });
  assert.ok(codes([...written, { path: ".tsumugi/registry/2d.json", before: J(shard()), after: J(hashDrift) }]).includes("registry-non-target-member-hash-changed"));
  const otherFile = JSON.parse(J(after)); otherFile.files["Memories/o.md"].size = 2;
  assert.ok(codes([...written, { path: ".tsumugi/registry/2d.json", before: J(shard()), after: J(otherFile) }]).includes("non-target-registry-file-changed"));
  const otherRec = shard({ other: "Memories/moved.md" }, ["a", "b", "mem-T"], { a: "h1", b: "h2", "mem-T": "ht" });
  assert.ok(codes([...written, { path: ".tsumugi/registry/2d.json", before: J(shard()), after: J(otherRec) }]).includes("non-target-registry-record-changed"));
});

test("conversation files and unknown paths", () => {
  const conv = (id: string) => md.conversationToMarkdown({ id, persona: "companion", startedAt: T, status: "captured", turns: [{ role: "user", content: "x", timestamp: T }], memoryObjectIds: [], createdAt: T, updatedAt: T, metadata: { id: "m", schemaVersion: "0.1", source: "ai-capture", createdAt: T, updatedAt: T } } as never);
  assert.deepEqual(codes([{ path: "Conversations/2026-08-20-t.md", before: conv("conv-T"), after: conv("conv-T") + "\n" }]), []);
  assert.deepEqual(codes([{ path: "Conversations/2026-08-20-o.md", before: conv("conv-O"), after: conv("conv-O") + "\n" }]), ["non-target-conversation-file-changed"]);
  assert.deepEqual(codes([{ path: ".tsumugi/vault-identity.json", before: "{}", after: "{ }" }, { path: "Sources/x.md", before: null, after: "x" }]), ["unexpected-path", "unexpected-path"]);
});

test("actual-vs-predicted comparison ignores only mtime (registry) and updatedAt (history-meta)", () => {
  const a = J({ records: {}, files: { p: { mtime: 1, size: 5 } } }), b = J({ records: {}, files: { p: { mtime: 999, size: 5 } } }), c = J({ records: {}, files: { p: { mtime: 1, size: 6 } } });
  const n = inv.normalizeForActualComparison;
  assert.equal(n(".tsumugi/registry/2d.json", a), n(".tsumugi/registry/2d.json", b));
  assert.notEqual(n(".tsumugi/registry/2d.json", a), n(".tsumugi/registry/2d.json", c));
  assert.equal(n(".tsumugi/history-meta.json", J({ a: 1, updatedAt: "x" })), n(".tsumugi/history-meta.json", J({ a: 1, updatedAt: "y" })));
  assert.notEqual(n(".tsumugi/history-meta.json", J({ a: 1, updatedAt: "x" })), n(".tsumugi/history-meta.json", J({ a: 2, updatedAt: "x" })));
  assert.equal(n("Memories/x.md", "t"), "t");
});
