/**
 * Capture regression (M1, 2026-08-23..09-25) contamination repair: FIXED-CONTENT, ONE-SHOT plan.
 *
 * - Pure planning only. This file imports nothing that touches IndexedDB / Vault / the network, and nothing
 *   imports it from startup, projection, Capture or any UI. Execution lives in `memoryRepairRunner.ts` and is
 *   reachable only by an explicit call.
 * - Every text (summary / content / keywords / evidence) is authored in advance below. Nothing is regenerated
 *   by an LLM at run time. `verifyItemGrounding` refuses an item whose evidence quote is not a verbatim user
 *   turn, whose keyword is not in the user's own text, or whose text uses an inference word the user never said.
 * - Each repair is two independent Memories: the ORIGINAL Memory (same id) is restored from the original
 *   conversation, and the UPDATING conversation's content (what the corrupted Memory currently says) is kept
 *   as its own new Memory with a deterministic id. Neither side is deleted.
 */
import type { Conversation, ConversationTurn, MemoryObject, MemoryType } from "./types";

export const CONTAMINATION_REPAIR_VERSION = "contamination-v1";

export interface RepairText {
  summary: string;
  content: string;
  keywords: string[];
  types: MemoryType[];
  /** Verbatim substrings of the source conversation's USER turns. */
  evidence: string[];
}
export interface RestoredMemorySpec extends RepairText {
  /** `topicId` / `eventTime` of the corrupted Memory came from the updating conversation: move or keep, never implicit. */
  topicId: "move-to-updating" | "keep";
  dropEventTime: boolean;
}
export interface UpdatingMemorySpec extends RepairText {
  eventTime?: { value: string; precision: "day" | "month" | "year" };
}
export interface RepairSpecItem {
  key: string;
  /**
   * Reviewed decision for EVERY Link on the corrupted Memory (links are stored on both ends; a link not listed here => HOLD).
   * keep: the link was created before the updating conversation's first message, so its reason was written from the ORIGINAL content.
   * remove: the reason depends on content that the restore removes; removed from both ends (derived data, regenerable by Connect, backed up).
   */
  links: Record<string, "keep" | "remove">;
  memoryId: string;
  originalConversationId: string;
  updatingConversationId: string;
  /** Guard: the live Memory must still be exactly the corrupted one, otherwise the item is HELD. */
  expectedBefore: { summary: string; content: string; updatedAt: string };
  restored: RestoredMemorySpec;
}

/** Words that appear in AI-expanded memories but are not neutral paraphrase: allowed only if the user said them. */
const INFERENCE_TERMS = ["不安", "孤独", "愛着", "懸念", "焦り", "安心", "強い関心"];

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
export const userTurns = (conversation: Conversation): ConversationTurn[] => conversation.turns.filter((t) => t.role === "user");
const userText = (conversation: Conversation) => normalize(userTurns(conversation).map((t) => t.content).join("\n"));

export interface GroundingProblem { code: string; detail: string }
/** Evidence is a verbatim user substring, every keyword occurs in the user's own text, no unsaid inference words. */
export function verifyTextGrounding(text: RepairText, conversation: Conversation): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  const all = userText(conversation);
  if (text.evidence.length === 0) problems.push({ code: "no-evidence", detail: "" });
  for (const quote of text.evidence) {
    if (!userTurns(conversation).some((t) => normalize(t.content).includes(normalize(quote)))) problems.push({ code: "evidence-not-verbatim-user-text", detail: quote });
  }
  for (const keyword of text.keywords) if (!all.includes(normalize(keyword))) problems.push({ code: "keyword-not-in-user-text", detail: keyword });
  for (const term of INFERENCE_TERMS) {
    if ((text.summary + text.content).includes(term) && !all.includes(normalize(term))) problems.push({ code: "inference-term-not-in-user-text", detail: term });
  }
  if (!text.summary.trim() || !text.content.trim()) problems.push({ code: "empty-text", detail: "" });
  return problems;
}

/** Timestamp of the first user turn that contains the first evidence quote (deterministic; never "now"). */
export function statedAtFor(text: RepairText, conversation: Conversation): string | undefined {
  const quote = normalize(text.evidence[0] ?? "");
  return userTurns(conversation).find((t) => normalize(t.content).includes(quote))?.timestamp;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Deterministic 26-char Crockford id (same shape as the app's ULIDs): rerunning can only ever produce this one id. */
export async function deterministicMemoryId(seed: string): Promise<string> {
  const hex = await sha256Hex(`${CONTAMINATION_REPAIR_VERSION}:${seed}`);
  let out = "01RP";
  for (let i = 0; out.length < 26; i++) out += CROCKFORD[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32];
  return out;
}
export const updatingMemoryIdFor = (updatingConversationId: string) => deterministicMemoryId(`updating:${updatingConversationId}`);

const bigrams = (s: string) => { const n = normalize(s); const set = new Set<string>(); for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2)); return set; };
export function textSimilarity(a: string, b: string): number {
  const x = bigrams(a), y = bigrams(b); let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both || 1);
}
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

export interface RepairSnapshot { memories: MemoryObject[]; conversations: Conversation[] }
/** One evaluated pre-execution guard. Every guard is listed (PASS and FAIL) so the operator can read the whole decision. */
export interface PreflightCheck { code: string; pass: boolean; detail: string }
export type PlannedItem =
  | { status: "READY"; key: string; memoryId: string; updatingMemoryId: string; before: MemoryObject; restoredAfter: MemoryObject; newMemory: MemoryObject | null; updatingConversation: { before: Conversation; after: Conversation } | null;
      /** Link counterparts that change (only `links` / `updatedAt`) because a "remove" link is cut from both ends. */
      counterparts: { before: MemoryObject; after: MemoryObject }[];
      /** Every canonical record this item may write. Anything else changing during execution is a collateral change. */
      writeSet: { memoryIds: string[]; conversationIds: string[] };
      ledgerKey: string; checks: PreflightCheck[]; notes: string[] }
  | { status: "ALREADY_DONE"; key: string; memoryId: string; updatingMemoryId: string }
  | { status: "HOLD"; key: string; memoryId: string; reasons: string[]; checks: PreflightCheck[] };

export const repairLedgerKey = (memoryId: string) => `memoryRepair:${CONTAMINATION_REPAIR_VERSION}:${memoryId}`;
export const repairBackupKey = (memoryId: string) => `memoryRepair:${CONTAMINATION_REPAIR_VERSION}:backup:${memoryId}`;
export const repairRollbackLedgerKey = (memoryId: string) => `memoryRepair:${CONTAMINATION_REPAIR_VERSION}:rollback:${memoryId}`;
export const repairRollbackBackupKey = (memoryId: string) => `memoryRepair:${CONTAMINATION_REPAIR_VERSION}:rollback-backup:${memoryId}`;

const day = (iso: string) => `${iso.slice(0, 10)}T00:00:00.000Z`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const isReflection = (m: MemoryObject) => m.metadata.source === "system-generated";

function withoutKeys<T extends object>(value: T, keys: string[]): T {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

type Structured = { id?: string; sourceConversationId?: string };
const STRUCTURED_FIELDS = ["personMentions", "profileClaims", "topicEvents"] as const;

/**
 * Plans ONE item against a snapshot. Pure: reads the snapshot, returns the exact records that would be written and
 * every guard that was evaluated. Anything not provably the reviewed state => HOLD (never a guess, never a partial write).
 */
export async function planRepairItem(item: RepairSpecItem, snapshot: RepairSnapshot, now: string, spec: Record<string, UpdatingMemorySpec>): Promise<PlannedItem> {
  const checks: PreflightCheck[] = [];
  const check = (code: string, pass: boolean, detail = "") => { checks.push({ code, pass, detail: pass ? "" : detail }); return pass; };
  const hold = (): PlannedItem => ({ status: "HOLD", key: item.key, memoryId: item.memoryId, checks, reasons: checks.filter((c) => !c.pass).map((c) => (c.detail ? `${c.code}:${c.detail}` : c.code)) });
  const updatingSpec = spec[item.updatingConversationId];
  if (!check("updating-spec-exists", !!updatingSpec, item.updatingConversationId)) return hold();
  const updatingMemoryId = await updatingMemoryIdFor(item.updatingConversationId);
  const memory = snapshot.memories.find((m) => m.id === item.memoryId);
  const original = snapshot.conversations.find((c) => c.id === item.originalConversationId);
  const updating = snapshot.conversations.find((c) => c.id === item.updatingConversationId);
  check("memory-exists", !!memory, item.memoryId);
  check("original-conversation-exists", !!original, item.originalConversationId);
  check("updating-conversation-exists", !!updating, item.updatingConversationId);
  if (!memory || !original || !updating) return hold();

  const existingNew = snapshot.memories.find((m) => m.id === updatingMemoryId);
  const restoredAlready = memory.summary === item.restored.summary && memory.content === item.restored.content;
  if (restoredAlready && existingNew && existingNew.summary === updatingSpec.summary && existingNew.content === updatingSpec.content && updating.memoryObjectIds.includes(updatingMemoryId)) {
    return { status: "ALREADY_DONE", key: item.key, memoryId: item.memoryId, updatingMemoryId };
  }

  check("memory-belongs-to-original-conversation", memory.conversationId === item.originalConversationId, String(memory.conversationId));
  check("memory-matches-reviewed-corrupted-state", memory.summary === item.expectedBefore.summary && memory.content === item.expectedBefore.content && memory.updatedAt === item.expectedBefore.updatedAt, "summary/content/updatedAt differ from the reviewed state");
  check("updating-conversation-signature", updating.updatedAt === item.expectedBefore.updatedAt || !!existingNew, "updating conversation updatedAt != Memory updatedAt");
  check("original-conversation-references-memory", original.memoryObjectIds.includes(memory.id), "original.memoryObjectIds lacks the Memory");
  const groundingR = verifyTextGrounding(item.restored, original), groundingU = verifyTextGrounding(updatingSpec, updating);
  check("restored-text-grounded-in-original-user-turns", groundingR.length === 0, groundingR.map((p) => `${p.code}:${p.detail}`).join(","));
  check("updating-text-grounded-in-updating-user-turns", groundingU.length === 0, groundingU.map((p) => `${p.code}:${p.detail}`).join(","));

  // new Memory id: unused, or already exactly the reviewed Memory (another item of the same updating conversation created it)
  check("new-memory-id-unused-or-identical", !existingNew || (existingNew.conversationId === item.updatingConversationId && existingNew.summary === updatingSpec.summary && existingNew.content === updatingSpec.content), updatingMemoryId);
  const others = snapshot.memories.filter((m) => m.id !== memory.id && m.id !== updatingMemoryId);
  const updatingHasOwn = others.filter((m) => m.conversationId === item.updatingConversationId && !isReflection(m));
  check("updating-conversation-has-no-other-memory", updatingHasOwn.length === 0, updatingHasOwn.map((m) => m.id).join(","));
  const similarR = others.filter((m) => !isReflection(m) && textSimilarity(m.summary, item.restored.summary) >= DUPLICATE_SIMILARITY_THRESHOLD);
  const similarU = others.filter((m) => !isReflection(m) && textSimilarity(m.summary, updatingSpec.summary) >= DUPLICATE_SIMILARITY_THRESHOLD);
  check("no-existing-memory-with-restored-content", similarR.length === 0, similarR.map((m) => m.id).join(","));
  check("no-existing-memory-with-updating-content", similarU.length === 0, similarU.map((m) => m.id).join(","));

  // structured claims: provenance must be the original (stay) or the updating conversation (move). Anything else has no safe home => HOLD.
  const split: Record<string, { stay: Structured[]; move: Structured[]; foreign: Structured[] }> = {};
  for (const field of STRUCTURED_FIELDS) {
    const list = ((memory as unknown as Record<string, Structured[] | undefined>)[field]) ?? [];
    split[field] = {
      stay: list.filter((x) => x.sourceConversationId === item.originalConversationId),
      move: list.filter((x) => x.sourceConversationId === item.updatingConversationId),
      foreign: list.filter((x) => x.sourceConversationId !== item.originalConversationId && x.sourceConversationId !== item.updatingConversationId),
    };
    check(`${field}-provenance-is-original-or-updating`, split[field].foreign.length === 0,
      `${split[field].foreign.length} entr${split[field].foreign.length === 1 ? "y" : "ies"} from other conversations (${[...new Set(split[field].foreign.map((x) => String(x.sourceConversationId).slice(-6)))].join(",")}) have no receiving Memory`);
  }

  // links: stored on both ends; every one must be reviewed, intact on the counterpart, and a "keep" must predate the contamination
  const byId = new Map(snapshot.memories.map((m) => [m.id, m]));
  const counterparts = new Map<string, MemoryObject>();
  let removed = 0;
  for (const link of memory.links) {
    const decision = item.links[link.id];
    check(`link-reviewed:${link.id.slice(-6)}`, decision === "keep" || decision === "remove", "no reviewed decision for this link");
    const otherId = link.sourceId === memory.id ? link.targetId : link.sourceId;
    const other = byId.get(otherId);
    check(`link-counterpart-intact:${link.id.slice(-6)}`, !!other && other.links.filter((l) => l.id === link.id).length === 1 && same(other.links.find((l) => l.id === link.id), link), `counterpart ${otherId.slice(-6)} missing or holds a different copy`);
    if (decision === "keep") check(`link-predates-contamination:${link.id.slice(-6)}`, link.createdAt < updating.startedAt, `created ${link.createdAt} is not before the updating conversation started ${updating.startedAt}`);
    if (decision === "remove" && other) { counterparts.set(other.id, other); removed++; }
  }
  for (const id of Object.keys(item.links)) check(`reviewed-link-still-exists:${id.slice(-6)}`, memory.links.some((l) => l.id === id) || restoredAlready, "reviewed link no longer on the Memory");
  const failed = checks.some((c) => !c.pass);
  if (failed) return hold();

  const stampedAt = statedAtFor(item.restored, original);
  let restoredAfter: MemoryObject = {
    ...memory, summary: item.restored.summary, content: item.restored.content, keywords: item.restored.keywords, types: item.restored.types,
    evidenceQuotes: item.restored.evidence, updatedAt: now,
    links: memory.links.filter((l) => item.links[l.id] === "keep"),
    metadata: { ...memory.metadata, updatedAt: now, sourceDetail: { ...(memory.metadata.sourceDetail ?? {}), memoryRepair: CONTAMINATION_REPAIR_VERSION } },
  };
  if (stampedAt) restoredAfter.statedAt = stampedAt;
  if (item.restored.dropEventTime) restoredAfter = withoutKeys(restoredAfter, ["eventTime", "eventTimePrecision"]);
  if (item.restored.topicId === "move-to-updating") restoredAfter = withoutKeys(restoredAfter, ["topicId"]);
  restoredAfter = withoutKeys(restoredAfter, ["revisitPrompt"]);
  for (const field of STRUCTURED_FIELDS) {
    if (!(field in memory) && split[field].stay.length === 0) continue;
    if (split[field].stay.length === 0) restoredAfter = withoutKeys(restoredAfter, [field]);
    else (restoredAfter as unknown as Record<string, unknown>)[field] = split[field].stay;
  }

  let newMemory: MemoryObject | null = null;
  if (!existingNew) {
    const stated = statedAtFor(updatingSpec, updating);
    newMemory = {
      id: updatingMemoryId, date: day(updating.startedAt), types: updatingSpec.types, conversationId: item.updatingConversationId,
      content: updatingSpec.content, summary: updatingSpec.summary, keywords: updatingSpec.keywords,
      themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
      evidenceQuotes: updatingSpec.evidence, createdAt: now, updatedAt: now,
      metadata: { id: await deterministicMemoryId(`updating-meta:${item.updatingConversationId}`), schemaVersion: "0.1", source: "ai-capture", sourceType: "chat", confidence: 1, createdAt: now, updatedAt: now, sourceDetail: { memoryRepair: CONTAMINATION_REPAIR_VERSION, repairedFrom: item.memoryId } },
    };
    if (stated) newMemory.statedAt = stated;
    if (updatingSpec.eventTime) { newMemory.eventTime = updatingSpec.eventTime.value; newMemory.eventTimePrecision = updatingSpec.eventTime.precision; }
    if (item.restored.topicId === "move-to-updating" && memory.topicId) newMemory.topicId = memory.topicId;
    for (const field of STRUCTURED_FIELDS) if (split[field].move.length) (newMemory as unknown as Record<string, unknown>)[field] = split[field].move;
  }
  const updatingConversation = updating.memoryObjectIds.includes(updatingMemoryId) ? null
    : { before: updating, after: { ...updating, memoryObjectIds: [...updating.memoryObjectIds, updatingMemoryId], updatedAt: now } };
  const removedIds = new Set(Object.entries(item.links).filter(([, d]) => d === "remove").map(([id]) => id));
  const counterpartChanges = [...counterparts.values()].map((before) => ({
    before, after: { ...before, links: before.links.filter((l) => !removedIds.has(l.id)), updatedAt: now, metadata: { ...before.metadata, updatedAt: now } } as MemoryObject,
  }));
  const notes = [`links kept ${restoredAfter.links.length}, removed ${removed}`, newMemory ? "new Memory for the updating conversation" : "new Memory already created by an earlier item"];
  return {
    status: "READY", key: item.key, memoryId: item.memoryId, updatingMemoryId, before: memory, restoredAfter, newMemory, updatingConversation, counterparts: counterpartChanges,
    writeSet: { memoryIds: [memory.id, ...(newMemory ? [newMemory.id] : []), ...counterpartChanges.map((c) => c.before.id)], conversationIds: updatingConversation ? [updating.id] : [] },
    ledgerKey: repairLedgerKey(item.memoryId), checks, notes,
  };
}

/** The records that may change when `planned` is committed (plus nothing else). */
export function allowedChangesOf(planned: Extract<PlannedItem, { status: "READY" }>) { return planned.writeSet; }

/** Collateral-change detector: any Memory / Conversation outside the write set that differs between two snapshots. */
export function collateralChanges(before: RepairSnapshot, after: RepairSnapshot, allowed: { memoryIds: string[]; conversationIds: string[] }): string[] {
  const out: string[] = [];
  const memAfter = new Map(after.memories.map((m) => [m.id, m])), convAfter = new Map(after.conversations.map((c) => [c.id, c]));
  const memBefore = new Map(before.memories.map((m) => [m.id, m])), convBefore = new Map(before.conversations.map((c) => [c.id, c]));
  for (const [id, m] of memBefore) if (!allowed.memoryIds.includes(id) && !same(m, memAfter.get(id))) out.push(`memory:${id}`);
  for (const [id, c] of convBefore) if (!allowed.conversationIds.includes(id) && !same(c, convAfter.get(id))) out.push(`conversation:${id}`);
  for (const id of memAfter.keys()) if (!memBefore.has(id) && !allowed.memoryIds.includes(id)) out.push(`memory:${id}(new)`);
  for (const id of convAfter.keys()) if (!convBefore.has(id)) out.push(`conversation:${id}(new)`);
  return out;
}

export interface IntegrityProblem { code: string; detail: string }
/** Post-state reference integrity of the repaired items (pure; `outbox` = Outbox entries keyed by `memory:<id>` / `conversation:<id>`). */
export function verifyRepairIntegrity(snapshot: RepairSnapshot, outbox: Record<string, { recordUpdatedAt: string } | undefined>, items: RepairSpecItem[], updating: Record<string, UpdatingMemorySpec>, newIds: Record<string, string>): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  const mem = new Map(snapshot.memories.map((m) => [m.id, m])), conv = new Map(snapshot.conversations.map((c) => [c.id, c]));
  const add = (code: string, detail: string) => problems.push({ code, detail });
  for (const item of items) {
    const m = mem.get(item.memoryId), o = conv.get(item.originalConversationId), u = conv.get(item.updatingConversationId), n = mem.get(newIds[item.updatingConversationId]);
    if (!m || !o || !u || !n) { add("record-missing", item.key); continue; }
    if (m.conversationId !== o.id) add("memory-conversation", item.key);
    if (!o.memoryObjectIds.includes(m.id)) add("original-conversation-lost-reference", item.key);
    if (n.conversationId !== u.id) add("new-memory-conversation", item.key);
    if (!u.memoryObjectIds.includes(n.id)) add("updating-conversation-lacks-reference", item.key);
    if (n.summary !== updating[u.id].summary) add("new-memory-content-drift", item.key);
    for (const [kind, id, updatedAt] of [["memory", m.id, m.updatedAt], ["memory", n.id, n.updatedAt], ["conversation", u.id, u.updatedAt]] as const) {
      const entry = outbox[`${kind}:${id}`];
      if (!entry) add("outbox-missing", `${kind}:${id}`); else if (entry.recordUpdatedAt !== updatedAt) add("outbox-stale", `${kind}:${id}`);
    }
    for (const link of m.links) {
      const other = mem.get(link.sourceId === m.id ? link.targetId : link.sourceId);
      if (!other || !other.links.some((l) => same(l, link))) add("link-not-symmetric", `${item.key}:${link.id}`);
      if (item.links[link.id] === "remove") add("removed-link-still-present", `${item.key}:${link.id}`);
    }
    for (const field of STRUCTURED_FIELDS) for (const x of ((m as unknown as Record<string, Structured[] | undefined>)[field]) ?? []) if (x.sourceConversationId !== o.id) add("foreign-structured-on-restored", `${item.key}:${field}`);
  }
  for (const c of snapshot.conversations) for (const id of c.memoryObjectIds) if (!mem.has(id)) add("dangling-memory-reference", `${c.id.slice(-6)}->${id.slice(-6)}`);
  // every link on every Memory must have its other end
  const refLinks = new Set(items.flatMap((i) => Object.keys(i.links)));
  for (const m of snapshot.memories) for (const link of m.links) if (refLinks.has(link.id)) {
    const other = mem.get(link.sourceId === m.id ? link.targetId : link.sourceId);
    if (!other || !other.links.some((l) => l.id === link.id)) add("link-one-sided", `${m.id.slice(-6)}:${link.id.slice(-6)}`);
  }
  return problems;
}

/**
 * Recovery after a problem is found in a repaired item. NEVER deletes: the new Memory (and its Conversation reference)
 * stays, because the app has no Memory delete and a Vault file that was already projected can not be retracted safely.
 * What it does: put the pre-repair Memory (and any cut link counterparts) back, guarded so nothing newer is overwritten.
 */
export type PlannedRollback =
  | { status: "READY"; key: string; replace: { before: MemoryObject; after: MemoryObject }[]; ledgerKey: string; backupKey: string; checks: PreflightCheck[] }
  | { status: "HOLD"; key: string; reasons: string[]; checks: PreflightCheck[] };
export function planRepairRollback(item: RepairSpecItem, snapshot: RepairSnapshot, backupJson: string | undefined, now: string): PlannedRollback {
  const checks: PreflightCheck[] = [];
  const check = (code: string, pass: boolean, detail = "") => { checks.push({ code, pass, detail: pass ? "" : detail }); return pass; };
  const hold = (): PlannedRollback => ({ status: "HOLD", key: item.key, checks, reasons: checks.filter((c) => !c.pass).map((c) => (c.detail ? `${c.code}:${c.detail}` : c.code)) });
  let backup: { memories: MemoryObject[]; afterMemories?: MemoryObject[] } | null = null;
  try { backup = backupJson ? JSON.parse(backupJson) : null; } catch { backup = null; }
  if (!check("backup-present-and-readable", !!backup && Array.isArray(backup.memories) && Array.isArray(backup.afterMemories), "no repair backup (or it predates after-image recording)")) return hold();
  const replace: { before: MemoryObject; after: MemoryObject }[] = [];
  const afters = new Map(backup!.afterMemories!.map((m) => [m.id, m]));
  for (const before of backup!.memories) {
    const repaired = afters.get(before.id);
    const current = snapshot.memories.find((m) => m.id === before.id);
    check(`current-equals-repaired-image:${before.id.slice(-6)}`, !!current && !!repaired && same(current, repaired), "changed after the repair (or missing); refusing to overwrite newer data");
    if (current && repaired && same(current, repaired)) replace.push({ before: current, after: { ...before, updatedAt: now, metadata: { ...before.metadata, updatedAt: now } } });
  }
  check("new-memory-retained", true);
  if (checks.some((c) => !c.pass)) return hold();
  return { status: "READY", key: item.key, replace, ledgerKey: repairRollbackLedgerKey(item.memoryId), backupKey: repairRollbackBackupKey(item.memoryId), checks };
}

export interface RepairPreview {
  key: string; status: PlannedItem["status"]; reasons?: string[]; checks?: PreflightCheck[];
  before?: { summary: string; content: string; keywords: string[]; updatedAt: string };
  restored?: { summary: string; content: string; keywords: string[]; evidence: string[] };
  newMemory?: { id: string; conversationId: string; summary: string; content: string; keywords: string[] } | null;
  linksRemoved?: number; writeSet?: { memoryIds: string[]; conversationIds: string[] };
}
export const previewOf = (p: PlannedItem): RepairPreview => p.status === "READY"
  ? { key: p.key, status: p.status, checks: p.checks, writeSet: p.writeSet, linksRemoved: p.counterparts.length, before: { summary: p.before.summary, content: p.before.content, keywords: p.before.keywords, updatedAt: p.before.updatedAt },
      restored: { summary: p.restoredAfter.summary, content: p.restoredAfter.content, keywords: p.restoredAfter.keywords, evidence: p.restoredAfter.evidenceQuotes ?? [] },
      newMemory: p.newMemory && { id: p.newMemory.id, conversationId: p.newMemory.conversationId ?? "", summary: p.newMemory.summary, content: p.newMemory.content, keywords: p.newMemory.keywords } }
  : { key: p.key, status: p.status, reasons: p.status === "HOLD" ? p.reasons : undefined, checks: p.status === "HOLD" ? p.checks : undefined };
