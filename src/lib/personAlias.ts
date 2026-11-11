/**
 * Memory Graph P1-B: names the user CONFIRMED as one person (docs/memory-graph-p1b.md). Pure: no storage, no AI, no Memory is read or changed.
 *
 * A person is an append-only history of the user's decisions: "confirm" (this name is this person) and "revoke" (it is not, after all). The names of a
 * person are the folded history: a name is active when the last decision about it is "confirm". A decision is never edited or deleted; a correction is a
 * revoke followed by a confirm. Two copies of a person (two devices, the Vault and this device) are merged by the union of their decisions (by id), so
 * no decision is lost and the order of merging does not matter.
 *
 * Names are compared by their key (aliasNameKey, the same as the sheet's personSheetKey: width, spaces and an honorific aside; a one-character name keeps its honorific). Only equal keys are
 * the same name: a similar name, a longer name containing it, or a reading is never taken for it.
 *
 * A name active in two people at once (two devices confirmed it for different people) is CONTESTED: it joins neither, and the page says so.
 */
// the person sheet's name key (personSheet.ts personSheetKey), repeated here so that the startup sync does not load the sheet; a test keeps them equal
const NAME_HONORIFIC = /(さん|ちゃん|くん|君|様|氏)$/;
export function aliasNameKey(name: string): string {
  const base = name.normalize("NFKC").replace(/\s+/g, "").trim();
  const stripped = base.replace(NAME_HONORIFIC, "");
  return Array.from(stripped).length >= 2 ? stripped : base;
}

export const PERSON_SCHEMA_VERSION = "1";

export interface PersonDecision {
  /** unique (ULID-like); the merge key */
  id: string;
  /** when the user decided (ISO) */
  at: string;
  kind: "confirm" | "revoke";
  /** the name as the user saw it on the page */
  name: string;
}

export interface PersonRecord {
  id: string;
  /** the Vault file name (People/), fixed when the person is first saved */
  fileName: string;
  createdAt: string;
  decisions: PersonDecision[];
}

const timeOf = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
const byTime = (a: PersonDecision, b: PersonDecision) => timeOf(a.at) - timeOf(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** the active names of a person, in the order they were first confirmed (one name per key: the latest spelling the user confirmed) */
export function activeNames(person: PersonRecord): string[] {
  const last = new Map<string, PersonDecision>();
  const first = new Map<string, number>();
  [...person.decisions].sort(byTime).forEach((d, i) => {
    const key = aliasNameKey(d.name);
    if (!key) return;
    last.set(key, d);
    if (d.kind === "confirm" && !first.has(key)) first.set(key, i);
  });
  return [...last.entries()].filter(([, d]) => d.kind === "confirm").sort((a, b) => (first.get(a[0]) ?? 0) - (first.get(b[0]) ?? 0)).map(([, d]) => d.name);
}

/** the name shown for a person: the first name still active (or, when none is, the first name ever confirmed) */
export function displayNameOf(person: PersonRecord): string {
  return activeNames(person)[0] ?? [...person.decisions].sort(byTime).find((d) => d.kind === "confirm")?.name ?? "";
}

/** name keys active in more than one person */
export function contestedKeys(people: PersonRecord[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const p of people) for (const n of activeNames(p)) {
    const key = aliasNameKey(n);
    owners.set(key, new Set([...(owners.get(key) ?? []), p.id]));
  }
  return new Set([...owners.entries()].filter(([, ids]) => ids.size > 1).map(([key]) => key));
}

export interface AliasGroup { personId: string; displayName: string; names: string[] }

/** the confirmed groups that join two names or more (contested names left out) */
export function aliasGroupsOf(people: PersonRecord[]): AliasGroup[] {
  const contested = contestedKeys(people);
  return people
    .map((p) => ({ personId: p.id, displayName: displayNameOf(p), names: activeNames(p).filter((n) => !contested.has(aliasNameKey(n))) }))
    .filter((g) => g.names.length >= 2);
}

/** the groups as lists of names (what personSheet / personContext / retrieval take) */
export const aliasNameLists = (people: PersonRecord[]): string[][] => aliasGroupsOf(people).map((g) => g.names);

export function personOfName(people: PersonRecord[], name: string): PersonRecord | undefined {
  const key = aliasNameKey(name);
  return people.find((p) => activeNames(p).some((n) => aliasNameKey(n) === key));
}

export type ConfirmPlan =
  | { ok: true; personId: string; isNew: boolean; decisions: PersonDecision[] }
  | { ok: false; reason: "too-few-names" | "same-name" | "in-other-person" | "already-confirmed" | "contested"; names?: string[] };

/**
 * Confirm that `names` are one person (the user chose them on the page). Refused when the names are fewer than two different keys, when they already
 * belong to two different people (the user has to undo one first: two people are never joined in one step), or when a name is contested.
 */
export function planConfirm(people: PersonRecord[], names: string[], ids: { newDecisionId: () => string; newPersonId: () => string }, now: string): ConfirmPlan {
  const clean = names.map((n) => n.normalize("NFKC").replace(/\s+/g, "").trim()).filter(Boolean);
  const keys = [...new Set(clean.map(aliasNameKey))];
  if (keys.length < 2) return { ok: false, reason: clean.length >= 2 ? "same-name" : "too-few-names" };
  const contested = contestedKeys(people);
  const hit = keys.filter((k) => contested.has(k));
  if (hit.length > 0) return { ok: false, reason: "contested", names: hit };
  const owners = [...new Set(keys.map((k) => personOfName(people, k)?.id).filter((x): x is string => x !== undefined))];
  if (owners.length > 1) return { ok: false, reason: "in-other-person", names: clean.filter((n) => personOfName(people, n) !== undefined) };
  const owner = owners.length === 1 ? people.find((p) => p.id === owners[0]) : undefined;
  const already = owner ? new Set(activeNames(owner).map(aliasNameKey)) : new Set<string>();
  const toAdd = keys.filter((k) => !already.has(k)).map((k) => clean.find((n) => aliasNameKey(n) === k)!);
  if (toAdd.length === 0) return { ok: false, reason: "already-confirmed" };
  return {
    ok: true,
    personId: owner?.id ?? ids.newPersonId(),
    isNew: !owner,
    decisions: toAdd.map((name, i) => ({ id: ids.newDecisionId(), at: new Date(timeOf(now) + i).toISOString(), kind: "confirm" as const, name })),
  };
}

/** Undo one name of a person (it goes back to being its own person). Refused when the name is not active in that person. */
export function planRevoke(person: PersonRecord, name: string, newDecisionId: () => string, now: string): PersonDecision | null {
  const key = aliasNameKey(name);
  const active = activeNames(person).find((n) => aliasNameKey(n) === key);
  return active ? { id: newDecisionId(), at: now, kind: "revoke", name: active } : null;
}

/** the union of two copies of the same person (decisions by id; the earliest creation and the first file name are kept) */
export function mergePerson(a: PersonRecord, b: PersonRecord): PersonRecord {
  const byId = new Map<string, PersonDecision>();
  for (const d of [...a.decisions, ...b.decisions]) if (!byId.has(d.id)) byId.set(d.id, d);
  const older = timeOf(b.createdAt) < timeOf(a.createdAt) ? b : a;
  return { id: a.id, fileName: older.fileName || a.fileName || b.fileName, createdAt: older.createdAt, decisions: [...byId.values()].sort(byTime) };
}

/** true when `b` holds every decision of `a` (nothing of `a` would be lost by writing `b`) */
export function personCovers(b: PersonRecord, a: PersonRecord): boolean {
  const ids = new Set(b.decisions.map((d) => d.id));
  return a.decisions.every((d) => ids.has(d.id));
}

/** a file name for People/: the first name (characters a file name can not hold removed) and a short id, so two people never share a file */
export function personFileName(name: string, id: string): string {
  const safe = name.normalize("NFKC").replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "person";
  return `${safe} (${id.slice(-6).toLowerCase()}).md`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// People/ note: readable Markdown; the decisions are kept as one JSON line in an HTML comment (the part the app reads; the rest is for the reader)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const DECISIONS_OPEN = "<!-- tsumugi-person-decisions";
const DECISIONS_CLOSE = "-->";
const yamlString = (s: string) => JSON.stringify(s);
const jstLabel = (iso: string) => {
  const t = timeOf(iso);
  return t ? new Date(t + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : iso;
};

export function personToMarkdown(person: PersonRecord): string {
  const names = activeNames(person);
  const decisions = [...person.decisions].sort(byTime);
  const lastAt = decisions.length > 0 ? decisions[decisions.length - 1].at : person.createdAt;
  const lines = [
    "---",
    `id: ${person.id}`,
    "tsumugi: true",
    "type: person",
    `displayName: ${yamlString(displayNameOf(person))}`,
    names.length > 0 ? "aliases:" : "aliases: []",
    ...names.map((n) => `  - ${yamlString(n)}`),
    `schemaVersion: ${yamlString(PERSON_SCHEMA_VERSION)}`,
    `createdAt: ${person.createdAt}`,
    `updatedAt: ${lastAt}`,
    "---",
    "",
    `# ${displayNameOf(person)}`,
    "",
    names.length >= 2 ? `同じ人物として確定した呼び方：${names.join("、")}` : "同じ人物として確定した呼び方：（今は一つだけです）",
    "",
    "## 確定と解除の記録",
    ...decisions.map((d) => `- ${jstLabel(d.at)} 「${d.name}」を${d.kind === "confirm" ? "同じ人物として確定" : "この人物から外した"}`),
    "",
    "この欄と上の一覧は読むためのものです。Tsumugiは下の記録（変更しないでください）から読み直します。記録やMemoryの本文は書き換えません。",
    "",
    DECISIONS_OPEN,
    JSON.stringify(decisions.map((d) => ({ id: d.id, at: d.at, kind: d.kind, name: d.name }))),
    DECISIONS_CLOSE,
    "",
  ];
  return lines.join("\n");
}

const isDecision = (x: unknown): x is PersonDecision => {
  if (typeof x !== "object" || x === null) return false;
  const d = x as Record<string, unknown>;
  return typeof d.id === "string" && d.id.length > 0 && typeof d.at === "string" && Number.isFinite(Date.parse(d.at))
    && (d.kind === "confirm" || d.kind === "revoke") && typeof d.name === "string" && d.name.trim().length > 0 && d.name.length <= 40;
};

/**
 * A People/ note back to a person. `null` when the file is not a Tsumugi person note, or when its decisions can not be read whole (then the app never
 * writes over it: a decision would be lost).
 */
export function parsePersonMarkdown(text: string, fileName: string): PersonRecord | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"));
  if (!fm) return null;
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(fm[1])?.[1].trim();
  if (field("type") !== "person" || field("tsumugi") !== "true") return null;
  const id = field("id");
  const createdAt = field("createdAt");
  if (!id || !/^[0-9A-Za-z_-]{6,64}$/.test(id) || !createdAt || !Number.isFinite(Date.parse(createdAt))) return null;
  const open = text.lastIndexOf(DECISIONS_OPEN);
  if (open < 0) return null;
  const close = text.indexOf(DECISIONS_CLOSE, open + DECISIONS_OPEN.length);
  if (close < 0) return null;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(open + DECISIONS_OPEN.length, close).trim()); } catch { return null; }
  if (!Array.isArray(raw) || !raw.every(isDecision)) return null;
  const ids = new Set(raw.map((d) => d.id));
  if (ids.size !== raw.length) return null;
  return { id, fileName, createdAt, decisions: (raw as PersonDecision[]).map((d) => ({ id: d.id, at: d.at, kind: d.kind, name: d.name })).sort(byTime) };
}

/** a person read from storage (the device cache): shape checked, anything else dropped */
export function isPersonRecord(x: unknown): x is PersonRecord {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.fileName === "string" && typeof p.createdAt === "string" && Array.isArray(p.decisions) && p.decisions.every(isDecision);
}
