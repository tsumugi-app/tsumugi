/**
 * Memory Graph P1-B: confirmed names (personAlias.ts) and their storage in People/ (personAliasStore.ts). Fictional names and fake storage only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  activeNames,
  aliasGroupsOf,
  aliasNameKey,
  aliasNameLists,
  contestedKeys,
  mergePerson,
  parsePersonMarkdown,
  personFileName,
  personToMarkdown,
  planConfirm,
  planRevoke,
  type PersonDecision,
  type PersonRecord,
} from "./personAlias";
import { personSheetKey } from "./personSheet";
import {
  confirmPeopleInStore,
  emptyPeopleState,
  fileToWrite,
  parsePeopleState,
  readVaultPeople,
  recordPersonDecisions,
  revokeNameInStore,
  syncPeopleWithVault,
  type PeopleState,
  type PeopleStoreEnv,
  type PeopleVaultEnv,
} from "./personAliasStore";
import { buildPersonContext, personsForTurn } from "./personContext";
import type { MemoryObject } from "./types";

let seq = 0;
const nextId = () => `01FICTION${String(++seq).padStart(10, "0")}`;
const T0 = "2026-11-01T03:00:00.000Z";
const later = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

function confirm(people: PersonRecord[], names: string[], now = T0): PersonRecord[] {
  const plan = planConfirm(people, names, { newDecisionId: nextId, newPersonId: nextId }, now);
  assert.ok(plan.ok, JSON.stringify(plan));
  if (!plan.ok) return people;
  const existing = people.find((p) => p.id === plan.personId);
  const base: PersonRecord = existing ?? { id: plan.personId, fileName: personFileName(names[0], plan.personId), createdAt: now, decisions: [] };
  return [...people.filter((p) => p.id !== plan.personId), mergePerson(base, { ...base, decisions: plan.decisions })];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------------------------------------------------------------------------------

test("the name key is the person sheet's key", () => {
  for (const n of ["りこさん", "りっちゃん", "ｱｲ君", "妻", "母さん", " はる 様 ", "ゆう", "り"]) assert.equal(aliasNameKey(n), personSheetKey(n), n);
});

test("confirm joins exactly the names the user chose; revoke takes one back; a correction is a revoke then a confirm; history is kept", () => {
  let people = confirm([], ["りこさん", "りっちゃん"]);
  assert.deepEqual(aliasNameLists(people), [["りこさん", "りっちゃん"]]);
  // a third name joins the same person
  people = confirm(people, ["りっちゃん", "リコ"], later(1));
  assert.deepEqual(aliasNameLists(people), [["りこさん", "りっちゃん", "リコ"]]);
  // revoke one: the rest stay one person
  const d = planRevoke(people[0], "リコ", nextId, later(2))!;
  people = [{ ...people[0], decisions: [...people[0].decisions, d] }];
  assert.deepEqual(aliasNameLists(people), [["りこさん", "りっちゃん"]]);
  // revoke until one name: no group (the names are apart again), the history stays
  const d2 = planRevoke(people[0], "りっちゃん", nextId, later(3))!;
  people = [{ ...people[0], decisions: [...people[0].decisions, d2] }];
  assert.deepEqual(aliasNameLists(people), []);
  assert.equal(people[0].decisions.length, 5);
  // confirm again after the revoke
  people = confirm(people, ["りこさん", "りっちゃん"], later(4));
  assert.deepEqual(aliasNameLists(people), [["りこさん", "りっちゃん"]]);
  assert.equal(planRevoke(people[0], "まりこ", nextId, later(5)), null, "a name not in the person can not be revoked");
});

test("refused: one name, the same name twice (honorific aside), names of two different people, an already confirmed pair", () => {
  const ids = { newDecisionId: nextId, newPersonId: nextId };
  assert.deepEqual(planConfirm([], ["りこさん"], ids, T0), { ok: false, reason: "too-few-names" });
  assert.deepEqual(planConfirm([], ["りこさん", "りこ"], ids, T0), { ok: false, reason: "same-name" });
  let people = confirm([], ["りこさん", "りっちゃん"]);
  people = confirm(people, ["はるさん", "ハル"], later(1));
  const both = planConfirm(people, ["りこさん", "はるさん"], ids, later(2));
  assert.equal(both.ok, false);
  assert.equal(!both.ok && both.reason, "in-other-person", "two people are never joined in one step");
  assert.deepEqual(planConfirm(people, ["りこ", "りっちゃん"], ids, later(3)), { ok: false, reason: "already-confirmed" });
});

test("no partial or similar match: まりこ is not りこ, りこさん's group does not take りこた", () => {
  const people = confirm([], ["りこさん", "りっちゃん"]);
  const plan = planConfirm(people, ["まりこさん", "りこたさん"], { newDecisionId: nextId, newPersonId: nextId }, later(1));
  assert.ok(plan.ok && plan.isNew, "both are new names: a new person, not the りこ person");
  assert.deepEqual(aliasNameLists(people), [["りこさん", "りっちゃん"]]);
});

test("a name confirmed for two people (two devices) is contested: it joins neither, the other names stay", () => {
  const a: PersonRecord = { id: "01PERSONAAAAAA", fileName: "a.md", createdAt: T0, decisions: [{ id: "d1", at: T0, kind: "confirm", name: "ゆう" }, { id: "d2", at: T0, kind: "confirm", name: "ゆうこ" }, { id: "d3", at: T0, kind: "confirm", name: "ゆっこ" }] };
  const b: PersonRecord = { id: "01PERSONBBBBBB", fileName: "b.md", createdAt: T0, decisions: [{ id: "d4", at: T0, kind: "confirm", name: "ゆう" }, { id: "d5", at: T0, kind: "confirm", name: "ゆうと" }] };
  assert.deepEqual([...contestedKeys([a, b])], ["ゆう"]);
  assert.deepEqual(aliasGroupsOf([a, b]).map((g) => g.names), [["ゆうこ", "ゆっこ"]]);
  const plan = planConfirm([a, b], ["ゆう", "ゆうみ"], { newDecisionId: nextId, newPersonId: nextId }, T0);
  assert.equal(!plan.ok && plan.reason, "contested");
});

test("merge is a union of decisions (order does not matter, nothing lost)", () => {
  const base: PersonRecord = { id: "01PERSONMERGE1", fileName: "m.md", createdAt: T0, decisions: [] };
  const d = (id: string, min: number, kind: PersonDecision["kind"], name: string): PersonDecision => ({ id, at: later(min), kind, name });
  const x = { ...base, decisions: [d("a", 0, "confirm", "そら"), d("b", 0, "confirm", "ソラ")] };
  const y = { ...base, decisions: [d("a", 0, "confirm", "そら"), d("c", 5, "revoke", "ソラ")] };
  assert.deepEqual(mergePerson(x, y), mergePerson(y, x));
  assert.deepEqual(mergePerson(x, y).decisions.map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(activeNames(mergePerson(x, y)), ["そら"]);
});

test("People/ note: readable, round-trips, and a note that can not be read whole is null (never written over)", () => {
  const p = confirm([], ["りこさん", "りっちゃん"])[0];
  const md = personToMarkdown(p);
  assert.match(md, /^---\nid: /);
  assert.match(md, /type: person/);
  assert.match(md, /aliases:\n  - "りこさん"\n  - "りっちゃん"/);
  assert.match(md, /同じ人物として確定した呼び方：りこさん、りっちゃん/);
  assert.deepEqual(parsePersonMarkdown(md, p.fileName), p);
  assert.equal(parsePersonMarkdown(md.replace(/"kind":"confirm"/, '"kind":"maybe"'), p.fileName), null);
  assert.equal(parsePersonMarkdown(md.replace("-->", ""), p.fileName), null);
  assert.equal(parsePersonMarkdown("# ただのメモ\n", "x.md"), null);
  assert.equal(parsePersonMarkdown(md.replace("type: person", "type: memory"), p.fileName), null);
  assert.match(personFileName("り/こ:*", "01ABCDEFGHJKMN"), /^りこ \(jkmn\)\.md$|^りこ \([0-9a-z]{6}\)\.md$/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// storage: fake device cache and fake People/ folder
// ---------------------------------------------------------------------------------------------------------------------------------------------------

class FakeStore implements PeopleStoreEnv {
  raw: string | undefined;
  async readState() { return parsePeopleState(this.raw); }
  async updateState<T>(fn: (s: PeopleState) => { state: PeopleState; result: T }) {
    const out = fn(parsePeopleState(this.raw));
    this.raw = JSON.stringify(out.state);
    return out.result;
  }
}
class FakeVault implements PeopleVaultEnv {
  files = new Map<string, string>();
  paired = true;
  failWrites = false;
  truncateWrites = false;
  unreadable = new Set<string>();
  listFails = false;
  writes: string[] = [];
  async listPeopleFiles() {
    if (this.listFails) return { files: [], unreadable: [], complete: false, namesKnown: false };
    const files = [...this.files.entries()].filter(([n]) => !this.unreadable.has(n)).map(([fileName, text]) => ({ fileName, text }));
    return { files, unreadable: [...this.unreadable], complete: this.unreadable.size === 0, namesKnown: true };
  }
  async writePeopleFile(name: string, text: string) {
    if (this.failWrites) throw new Error("write failed");
    this.writes.push(name);
    this.files.set(name, this.truncateWrites ? text.slice(0, 40) : text);
  }
  async readPeopleFile(name: string) { return this.files.get(name) ?? null; }
  async isPairedVault() { return this.paired; }
}

async function deviceConfirm(store: FakeStore, names: string[], now = T0) {
  const plan = planConfirm((await store.readState()).people, names, { newDecisionId: nextId, newPersonId: nextId }, now);
  assert.ok(plan.ok);
  if (!plan.ok) throw new Error();
  return recordPersonDecisions(store, plan.personId, plan.decisions, plan.isNew ? { fileName: personFileName(names[0], plan.personId), createdAt: now } : undefined);
}

test("a decision is pending until the Vault holds it; written once, read back, then nothing pending (restart keeps it)", async () => {
  const store = new FakeStore();
  const vault = new FakeVault();
  const p = await deviceConfirm(store, ["りこさん", "りっちゃん"]);
  assert.deepEqual((await store.readState()).pending, [p.id]);
  const r = await syncPeopleWithVault(store, vault);
  assert.equal(r.written, 1);
  assert.equal(r.stillPending, 0);
  assert.deepEqual([...vault.files.keys()], [p.fileName]);
  assert.deepEqual(parsePersonMarkdown(vault.files.get(p.fileName)!, p.fileName), p);
  // "restart": a new reader of the same stored cache
  const again = new FakeStore(); again.raw = store.raw;
  assert.deepEqual(aliasNameLists((await again.readState()).people), [["りこさん", "りっちゃん"]]);
  // a second sync writes nothing
  vault.writes = [];
  assert.equal((await syncPeopleWithVault(again, vault)).written, 0);
  assert.deepEqual(vault.writes, []);
});

test("save failure, a write that did not land whole, an unpaired Vault: the decision stays pending and is written later", async () => {
  const store = new FakeStore();
  const vault = new FakeVault();
  const p = await deviceConfirm(store, ["はるさん", "ハル"]);
  vault.failWrites = true;
  assert.equal((await syncPeopleWithVault(store, vault)).stillPending, 1);
  vault.failWrites = false; vault.truncateWrites = true;
  assert.equal((await syncPeopleWithVault(store, vault)).stillPending, 1, "a note that does not read back whole does not clear pending");
  vault.truncateWrites = false; vault.paired = false;
  const skipped = await syncPeopleWithVault(store, vault);
  assert.equal(skipped.status, "skipped");
  assert.deepEqual((await store.readState()).pending, [p.id]);
  vault.paired = true;
  // the truncated note is not a readable person note: it is reported and never written over; the decisions go to a new file next to it
  const r = await syncPeopleWithVault(store, vault);
  assert.equal(r.stillPending, 0);
  assert.equal(vault.files.get(p.fileName)!.length, 40, "the unreadable note is left as it was");
  assert.equal([...vault.files.values()].filter((t) => parsePersonMarkdown(t, "x") !== null).length, 1);
});

test("the device cache is rebuilt from the Vault (lost IndexedDB, a new device)", async () => {
  const store = new FakeStore();
  const vault = new FakeVault();
  await deviceConfirm(store, ["りこさん", "りっちゃん"]);
  await syncPeopleWithVault(store, vault);
  const fresh = new FakeStore();
  assert.deepEqual(await fresh.readState(), emptyPeopleState());
  const r = await syncPeopleWithVault(fresh, vault);
  assert.equal(r.read, 1);
  assert.equal(r.written, 0, "nothing written: the Vault is the source");
  assert.deepEqual(aliasNameLists((await fresh.readState()).people), [["りこさん", "りっちゃん"]]);
  assert.deepEqual((await fresh.readState()).pending, []);
});

test("two devices: decisions on both are united in the Vault; a sync tool's conflicted copy is merged, never deleted", async () => {
  const vault = new FakeVault();
  const a = new FakeStore();
  const p = await deviceConfirm(a, ["そらさん", "そっちゃん"]);
  await syncPeopleWithVault(a, vault);
  const b = new FakeStore();
  await syncPeopleWithVault(b, vault);
  // device B revokes, device A adds a name, before either syncs
  const person = (await b.readState()).people[0];
  await recordPersonDecisions(b, p.id, [planRevoke(person, "そっちゃん", nextId, later(10))!]);
  const pa = (await a.readState()).people[0];
  const add = planConfirm([pa], ["そらさん", "ソラ"], { newDecisionId: nextId, newPersonId: nextId }, later(11));
  assert.ok(add.ok); if (!add.ok) return;
  await recordPersonDecisions(a, p.id, add.decisions);
  // a sync tool wrote B's note as a conflicted copy instead of over A's
  await syncPeopleWithVault(a, vault);
  const bNote = personToMarkdown(mergePerson(person, (await b.readState()).people[0]));
  vault.files.set(p.fileName.replace(/\.md$/, " (conflicted copy).md"), bNote);
  await syncPeopleWithVault(b, vault);
  await syncPeopleWithVault(a, vault);
  const disk = readVaultPeople([...vault.files.entries()].map(([fileName, text]) => ({ fileName, text })));
  assert.equal(disk.people.size, 1);
  assert.deepEqual(activeNames(disk.people.get(p.id)!.person), ["そらさん", "ソラ"]);
  assert.equal(vault.files.size, 2, "the conflicted copy is kept");
  for (const s of [a, b]) assert.deepEqual(aliasNameLists((await s.readState()).people), [["そらさん", "ソラ"]]);
});

test("a person removed from the Vault (the note deleted) is removed here only after a complete read; a pending one is written back", async () => {
  const store = new FakeStore();
  const vault = new FakeVault();
  const p = await deviceConfirm(store, ["りこさん", "りっちゃん"]);
  await syncPeopleWithVault(store, vault);
  vault.files.delete(p.fileName);
  vault.unreadable.add("other.md"); vault.files.set("other.md", "x");
  assert.equal((await syncPeopleWithVault(store, vault)).removed, 0, "an incomplete read removes nothing");
  vault.unreadable.clear(); vault.files.delete("other.md");
  assert.equal((await syncPeopleWithVault(store, vault)).removed, 1);
  assert.deepEqual((await store.readState()).people, []);
  // a new decision that is still pending is not lost when the note is missing: it is written
  const q = await deviceConfirm(store, ["はるさん", "ハル"]);
  assert.equal((await syncPeopleWithVault(store, vault)).written, 1);
  assert.ok(vault.files.has(q.fileName));
});

test("a note edited by hand, another file of the same name, an unlisted folder: never written over", async () => {
  const store = new FakeStore();
  const vault = new FakeVault();
  const p = await deviceConfirm(store, ["りこさん", "りっちゃん"]);
  await syncPeopleWithVault(store, vault);
  const edited = vault.files.get(p.fileName)! + "\n自分で書き足したメモ\n";
  vault.files.set(p.fileName, edited);
  const person = (await store.readState()).people[0];
  await recordPersonDecisions(store, p.id, [planRevoke(person, "りっちゃん", nextId, later(1))!]);
  await syncPeopleWithVault(store, vault);
  assert.equal(vault.files.get(p.fileName), edited, "the hand-edited note is kept as it is");
  assert.equal((await store.readState()).pending.length, 0, "the decision went to a new file next to it");
  assert.deepEqual(aliasNameLists((await store.readState()).people), []);
  // the user's own note that happens to have the person's file name
  const s2 = new FakeStore();
  const v2 = new FakeVault();
  const q = await deviceConfirm(s2, ["はるさん", "ハル"]);
  v2.files.set(q.fileName, "# 自分のメモ\n");
  await syncPeopleWithVault(s2, v2);
  assert.equal(v2.files.get(q.fileName), "# 自分のメモ\n");
  assert.equal(fileToWrite(q, [], new Map([[q.fileName, "# 自分のメモ\n"]])), q.fileName.replace(/\.md$/, " 2.md"));
  // the folder could not be listed: nothing written
  const s3 = new FakeStore();
  const v3 = new FakeVault(); v3.listFails = true;
  await deviceConfirm(s3, ["そらさん", "ソラ"]);
  const r = await syncPeopleWithVault(s3, v3);
  assert.equal(v3.writes.length, 0);
  assert.equal(r.stillPending, 1);
});

test("a person note broken by hand never makes the person disappear from the device", async () => {
  const store = new FakeStore();
  const vault = new FakeVault();
  const p = await deviceConfirm(store, ["りこさん", "りっちゃん"]);
  await syncPeopleWithVault(store, vault);
  vault.files.set(p.fileName, vault.files.get(p.fileName)!.replace(/"kind":"confirm"/, '"kind":'));
  const r = await syncPeopleWithVault(store, vault);
  assert.deepEqual(r.unreadable, [p.fileName]);
  assert.equal(r.removed, 0);
  assert.deepEqual(aliasNameLists((await store.readState()).people), [["りこさん", "りっちゃん"]]);
});

test("confirm and revoke are checked against the cache when they are recorded (one transaction)", async () => {
  const store = new FakeStore();
  const ids = { newDecisionId: nextId, newPersonId: nextId };
  assert.ok((await confirmPeopleInStore(store, ["りこさん", "りっちゃん"], ids, T0)).ok);
  // meanwhile another tab's sync brought はる and ハル as another person: joining りこ with はる is refused, nothing recorded
  assert.ok((await confirmPeopleInStore(store, ["はるさん", "ハル"], ids, later(1))).ok);
  const before = store.raw;
  const refused = await confirmPeopleInStore(store, ["りこさん", "はるさん"], ids, later(2));
  assert.equal(!refused.ok && refused.reason, "in-other-person");
  assert.equal(store.raw, before);
  const person = (await store.readState()).people.find((x) => activeNames(x).includes("ハル"))!;
  assert.equal(await revokeNameInStore(store, person.id, "ハル", nextId, later(3)), true);
  assert.equal(await revokeNameInStore(store, person.id, "ハル", nextId, later(4)), false, "already revoked");
  assert.deepEqual(aliasNameLists((await store.readState()).people), [["りこさん", "りっちゃん"]]);
  assert.equal((await store.readState()).pending.length, 2);
});

test("a malformed device cache is dropped (the Vault has the decisions)", () => {
  assert.deepEqual(parsePeopleState("not json"), emptyPeopleState());
  assert.deepEqual(parsePeopleState({ people: [{ id: 1 }], pending: ["x"] }), emptyPeopleState());
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the person context with confirmed names (P1-A's switch)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

function mem(id: string, day: string, person: string, summary: string): MemoryObject {
  const at = `${day}T12:00:00.000Z`;
  return {
    id, date: at, statedAt: at, types: ["conversation"], conversationId: `c-${id}`, content: summary, summary, keywords: [person],
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [summary],
    personMentions: [{ id: `pm-${id}`, groupingKey: person, displayName: person, assertion: "mention", stated: "explicit", quote: summary, statedAt: at, sourceConversationId: `c-${id}` }],
    createdAt: at, updatedAt: at, metadata: { id: `meta-${id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

test("person context: confirmed names are one person; unconfirmed (or after a revoke) they are two", () => {
  const memories = [mem("a1", "2026-09-01", "りこさん", "りこさんは引っ越しをやめると決めたと話した。"), mem("a2", "2026-10-01", "りっちゃん", "りっちゃんの新居を見に行くと話した。")];
  const people = confirm([], ["りこさん", "りっちゃん"]);
  const aliases = aliasNameLists(people);
  assert.deepEqual(personsForTurn(memories, "りこさんとりっちゃんの話", [], aliases).length, 1);
  assert.deepEqual(personsForTurn(memories, "りこさんとりっちゃんの話", [], []).length, 2);
  const joined = buildPersonContext(memories, "りこ", { aliases });
  const apart = buildPersonContext(memories, "りこ", { aliases: [] });
  const idsOf = (c: unknown): string[] => [...(JSON.stringify(c).match(/"a[12]"/g) ?? [])];
  assert.ok(idsOf(joined).includes('"a2"'));
  assert.ok(!idsOf(apart).includes('"a2"'));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// wiring (static): no Memory is written, no AI, the chat only uses the names when the trial switch is ON
// ---------------------------------------------------------------------------------------------------------------------------------------------------

test("wiring: the alias code never writes a Memory or calls an AI; the chat reads the names only behind memoryGraphEnabled()", () => {
  const src = path.join(process.cwd(), "src");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  for (const f of ["lib/personAlias.ts", "lib/personAliasStore.ts", "lib/personAliasDevice.ts"]) {
    const code = strip(fs.readFileSync(path.join(src, f), "utf8"));
    assert.doesNotMatch(code, /fetch\(|\/api\/|memoryObjects|putMemoryObject|Outbox|registry|removeEntry|localStorage/i, f);
  }
  const chat = fs.readFileSync(path.join(src, "components", "ChatScreen.tsx"), "utf8");
  assert.match(chat, /const personAliases = memoryGraphEnabled\(\) \? await loadConfirmedAliasLists\(\) : \[\];/);
  const boot = strip(fs.readFileSync(path.join(src, "lib", "productionBootstrap.ts"), "utf8"));
  assert.match(boot, /await runSaveFoundationBootstrap\([\s\S]*?\);\s*await syncPeopleOnStartup\(root\);/);
});
