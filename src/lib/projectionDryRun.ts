/**
 * Projection dry-run（READ ONLY診断）。
 *
 * 「Phase 1でidentityが確立したと仮定したとき、bootstrap（migration → pending / done Outbox reconcile）が
 * 現在のデータに対して何を書こうとするか」を、何も書かずに予測する。
 *
 * productionの判定ロジックを再実装しない。実際の`reconcile*OutboxEntry`（Markdown判定・Registry・index・
 * Historyの各stepと最終verifyを含む）を、書き込み先だけを`ShadowVault`（メモリ上のコピーオンライト層）に
 * 差し替えて「そのまま」実行する。outboxの書き込みは、診断が渡したentryに限り`registerProjectionDryRun`の
 * フックが横取りする。実Vaultと実IndexedDBには、読み取りしか行わない。
 * 診断後のRecovery plan（予測される「bootstrap後のraw held」）も、同じshadow上で既存の`planRecoveryApply`を
 * そのまま走らせて得る。
 */
import type { Conversation, MemoryObject, Source } from "./types";
import { getVaultOutboxEntry } from "./db";
import { vaultOutboxIdFor, buildOutboxEntryForUpdate, type VaultOutboxEntry } from "./vaultOutbox";
import {
  reconcileConversationOutboxEntry, reconcileMemoryOutboxEntry, reconcileReflectionOutboxEntry, reconcileSourceOutboxEntry,
  registerProjectionDryRun, type ProjectionDryRunOutcome, type ProjectionEnv, type ReconcileConversationResult,
} from "./vaultProjection";
import { classifyConversation, classifyMemoryDay, classifySingleFileRecord, reflectionMigrationConfig, sourceMigrationConfig } from "./vaultProductionMigration";
import {
  evaluateConversationEvidence, evaluateMemoryDayEvidence, evaluateReflectionEvidence, evaluateSourceEvidence, loadCanonicalSnapshot,
} from "./vaultIdentityAdoption";
import { parseConversationMarkdown, parseFrontmatter, parseMemoryObjectMarkdown, parseMemoryDayFile } from "./markdown";
import { isReflectionSummary } from "./vault";
import { planRecoveryApply, type RecoveryApplyEnv, type RecoveryApplyPlan } from "./vaultRecoveryApply";
import { recoveryRecordsSemanticEqual } from "./vaultRecovery";
import { ShadowVault } from "./shadowVault";
import type { VaultIdentityRecord } from "./vaultIdentity";

type Snapshot = Awaited<ReturnType<typeof loadCanonicalSnapshot>>;
type RT = "conversation" | "memory" | "reflection" | "source";
const TYPES: RT[] = ["conversation", "memory", "reflection", "source"];
const byType = () => ({ conversation: 0, memory: 0, reflection: 0, source: 0 });
type ByType = ReturnType<typeof byType>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface DryRunDeps {
  readSnapshot(): Promise<Snapshot>;
  planEnv(root: FileSystemDirectoryHandle): RecoveryApplyEnv;
  now?: () => string;
}

export interface DivergentRecord { type: RT; id: string; detail: string }
export interface RecordResult {
  type: RT; id: string;
  bucket: "existingPending" | "existingDone" | "wouldCreate" | "other";
  verdict: "noOp" | "update" | "conflict" | "notReached" | "other";
  markdown: "noOp" | "wouldCreate" | "wouldRewrite" | "conflict" | "notReached";
  registry: "noOp" | "wouldUpdate" | "notReached";
  index: "noOp" | "wouldUpdate" | "notReached";
  history: "noOp" | "wouldUpdate" | "notReached";
  rewriteReason?: RewriteReason;
  lossFields: string[];
}
export type RewriteReason = "serializationOnly" | "missingTurnTimes" | "frontmatterDifference" | "semanticSuccessor" | "other";

export interface DryRunReport {
  divergent: { total: number; byType: ByType; conversation: { timestampOnly: number; roleContent: number; other: number }; reflection: { semanticEqualButIdentityDivergent: number; trueSemanticDifference: number } };
  historyHeld: { total: number; byType: ByType };
  overlap: { divergentAndHistoryHeld: number; divergentOnly: number; historyHeldOnly: number; byType: { divergentAndHistoryHeld: ByType; divergentOnly: ByType; historyHeldOnly: ByType } };
  projection: {
    recordsEvaluated: number; noOp: number; update: number; conflict: number; notReached: number; other: number;
    markdown: { noOp: number; wouldCreate: number; wouldRewrite: number; conflict: number; notReached: number };
    registry: { noOp: number; wouldUpdate: number; notReached: number };
    index: { noOp: number; wouldUpdate: number; notReached: number };
    history: { noOp: number; wouldUpdate: number; notReached: number };
    outbox: { wouldCreate: number; existingPending: number; existingDone: number; other: number };
  };
  rewriteReasons: Record<RewriteReason, number>;
  metadataLoss: { potentialVaultOnlyMetadataLoss: number; potentialLossFields: Record<string, number> };
  historyPrediction: {
    wouldBecomeCorrect: number; wouldRemainHeld: number; wouldNotBeReached: number; unknown: number;
    expectedRawHeldAfterBootstrap: number | "unknown";
    afterByReason: Record<string, number>;
    shadowFidelity: "ok" | "mismatch" | "unavailable";
  };
  divergentPreservation: { preservedBothSides: number; wouldOverwriteVault: { total: number; semantic: number; representation: number }; wouldOverwriteCanonical: 0; unknown: number };
  safety: { simulatedWritesInMemoryOnly: number; canonicalUnchanged: boolean };
}

// ---------------------------------------------------------------------------
// divergent（identity診断が「食い違う」と判定する記録）の内訳
// ---------------------------------------------------------------------------

async function divergentDetail(type: RT, record: Conversation | MemoryObject | Source, readText: (p: string) => Promise<string | null>, paths: { conversation: string; reflection: string }): Promise<string> {
  try {
    if (type === "conversation") {
      const c = record as Conversation;
      const text = await readText(paths.conversation);
      const parsed = text ? parseConversationMarkdown(text) : null;
      if (!parsed || parsed.id !== c.id || parsed.persona !== c.persona || parsed.startedAt !== c.startedAt) return "other";
      const roleContent = parsed.turns.length <= c.turns.length && parsed.turns.every((t, i) => c.turns[i] && c.turns[i].role === t.role && c.turns[i].content === t.content);
      return roleContent ? "timestampOnly" : "roleContent";
    }
    if (type === "reflection") {
      const text = await readText(paths.reflection);
      const parsed = text ? parseMemoryObjectMarkdown(text) : null;
      return parsed && recoveryRecordsSemanticEqual("memory", record as MemoryObject, parsed) ? "semanticEqualButIdentityDivergent" : "trueSemanticDifference";
    }
  } catch { /* fall through */ }
  return "n/a";
}

export async function collectDivergentRecords(root: FileSystemDirectoryHandle, snapshot: Snapshot, readText: (p: string) => Promise<string | null>): Promise<DivergentRecord[]> {
  const out: DivergentRecord[] = [];
  const { fileNameFor, dayFileNameFor } = await import("./vault");
  for (const c of snapshot.conversations) {
    if ((await evaluateConversationEvidence(root, c)) === "conflict") out.push({ type: "conversation", id: c.id, detail: await divergentDetail("conversation", c, readText, { conversation: `Conversations/${fileNameFor(c.id, c.startedAt)}`, reflection: "" }) });
  }
  for (const s of snapshot.sources) if ((await evaluateSourceEvidence(root, s)) === "conflict") out.push({ type: "source", id: s.id, detail: "n/a" });
  for (const m of snapshot.memories) {
    if (isReflectionSummary(m)) {
      if ((await evaluateReflectionEvidence(root, m)) === "conflict") out.push({ type: "reflection", id: m.id, detail: await divergentDetail("reflection", m, readText, { conversation: "", reflection: `Memories/${fileNameFor(m.id, m.date)}` }) });
    } else if ((await evaluateMemoryDayEvidence(root, m)) === "conflict") out.push({ type: "memory", id: m.id, detail: "n/a" });
    void dayFileNameFor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown書き換えの理由・Vault側だけの情報の損失
// ---------------------------------------------------------------------------

type Fm = Record<string, unknown>;
const fmOf = (raw: string): Fm => (parseFrontmatter(raw)?.frontmatter ?? {}) as Fm;

function analyzeRewrite(type: RT, canonical: Conversation | MemoryObject | Source, before: string, after: string): { reason: RewriteReason; lossFields: string[] } {
  try {
    if (type === "memory") {
      const id = (canonical as MemoryObject).id;
      const old = parseMemoryDayFile(before).find((m) => m.id === id);
      return { reason: old && (canonical as MemoryObject).updatedAt > old.updatedAt ? "semanticSuccessor" : "other", lossFields: [] };
    }
    const o = fmOf(before), n = fmOf(after);
    const keys = new Set([...Object.keys(o), ...Object.keys(n)]);
    keys.delete("turnTimes");
    const diff = [...keys].filter((k) => !same(o[k], n[k]));
    const lossFields = Object.keys(o).filter((k) => k !== "turnTimes" && o[k] !== undefined && !same(o[k], n[k]));
    if (type === "conversation") {
      const old = parseConversationMarkdown(before);
      if (old && old.turns.length < (canonical as Conversation).turns.length) return { reason: "semanticSuccessor", lossFields };
      if (!("turnTimes" in o) && "turnTimes" in n) return { reason: "missingTurnTimes", lossFields };
    } else if (type === "reflection") {
      const old = parseMemoryObjectMarkdown(before);
      if (old && (canonical as MemoryObject).updatedAt > old.updatedAt) return { reason: "semanticSuccessor", lossFields };
    }
    return { reason: diff.length ? "frontmatterDifference" : "serializationOnly", lossFields };
  } catch { return { reason: "other", lossFields: [] }; }
}

const layerOf = (path: string): "md" | "registry" | "index" | "history" | "other" =>
  /^(Conversations|Memories|Sources)\//.test(path) ? "md"
    : path.startsWith(".tsumugi/registry/") ? "registry" : path === ".tsumugi/index.json" ? "index"
    : path.startsWith(".tsumugi/history/") || path === ".tsumugi/history-meta.json" ? "history" : "other";

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

interface Item { type: RT; id: string; record: Conversation | MemoryObject | Source }

export async function runProjectionDryRunWithShadow(root: FileSystemDirectoryHandle, rawPlan: RecoveryApplyPlan, deps: DryRunDeps): Promise<{ report: DryRunReport; shadow: ShadowVault; results: RecordResult[]; divergent: DivergentRecord[] }> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const snapshot = await deps.readSnapshot();
  const canonicalBefore = JSON.stringify(snapshot);
  const shadow = new ShadowVault(root);
  const readReal = async (p: string): Promise<string | null> => {
    try {
      const parts = p.split("/"); let dir = root;
      for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: false });
      return await (await dir.getFileHandle(parts[parts.length - 1], { create: false })).getFile().then((f) => f.text());
    } catch { return null; }
  };

  // 1) 現在の状態でのdivergent・held
  const divergent = await collectDivergentRecords(root, snapshot, readReal);
  const historyHeld = rawPlan.held.filter((h) => h.reason === "history-row-differs");

  // 2) shadow上のRecovery plan（予測の信頼性の確認：何も書く前は実際のplanと一致するはず）
  let fidelity: "ok" | "mismatch" | "unavailable" = "unavailable";
  try {
    const pre = await planRecoveryApply({ ...deps.planEnv(shadow.root()), root: shadow.root() });
    const a = [...rawPlan.held].map((h) => `${h.recordId}:${h.reason}`).sort().join("|"), b = pre.held.map((h) => `${h.recordId}:${h.reason}`).sort().join("|");
    fidelity = a === b && pre.ops.length === rawPlan.ops.length ? "ok" : "mismatch";
  } catch { fidelity = "unavailable"; }

  // 3) Phase 1でidentityが確立した前提：仮想のidentity fileをshadowにだけ置く
  const vaultId = "dry-run-identity";
  shadow.seed(".tsumugi/vault-identity.json", JSON.stringify({ vaultId }));
  const env: ProjectionEnv = { root: shadow.root(), now: () => now, vaultIdentity: { id: "current", vaultId, activeVaultEpoch: null, registryGeneration: null, pairedAt: now, pendingCandidateVaultId: null, updatedAt: now } as VaultIdentityRecord };

  const items: Item[] = [
    ...snapshot.conversations.map((r) => ({ type: "conversation" as RT, id: r.id, record: r })),
    ...snapshot.memories.map((r) => ({ type: (isReflectionSummary(r) ? "reflection" : "memory") as RT, id: r.id, record: r })),
    ...snapshot.sources.map((r) => ({ type: "source" as RT, id: r.id, record: r })),
  ];

  // 4) Outboxの状態とmigrationの適格性（bootstrapと同じ順序：migrationがoutboxを作る → pending → done）
  const eligible = new Set(["idb-only", "both-same", "legitimate-successor"]);
  const plans: { item: Item; entry: VaultOutboxEntry; bucket: RecordResult["bucket"] }[] = [];
  const unreached: RecordResult[] = [];
  const notReached = (item: Item, bucket: RecordResult["bucket"]): RecordResult => ({ type: item.type, id: item.id, bucket, verdict: "notReached", markdown: "notReached", registry: "notReached", index: "notReached", history: "notReached", lossFields: [] });
  for (const item of items) {
    const existing = await getVaultOutboxEntry(vaultOutboxIdFor(item.type, item.id));
    const updatedAt = item.record.updatedAt;
    if (existing && existing.recordUpdatedAt === updatedAt) {
      if (existing.status === "pending") plans.push({ item, entry: existing, bucket: "existingPending" });
      else if (existing.status === "done") plans.push({ item, entry: existing, bucket: "existingDone" });
      else unreached.push(notReached(item, "other")); // held：bootstrapは再実行しない
      continue;
    }
    let kind: string;
    try {
      if (item.type === "conversation") kind = (await classifyConversation(root, item.record as Conversation)).kind;
      else if (item.type === "memory") kind = (await classifyMemoryDay(root, (item.record as MemoryObject).date.slice(0, 10), [item.record as MemoryObject]))[0]?.kind ?? "unreadable";
      else if (item.type === "reflection") kind = (await classifySingleFileRecord(root, item.record as MemoryObject, reflectionMigrationConfig)).kind;
      else kind = (await classifySingleFileRecord(root, item.record as Source, sourceMigrationConfig)).kind;
    } catch { kind = "unreadable"; }
    if (eligible.has(kind)) plans.push({ item, entry: buildOutboxEntryForUpdate(existing, item.type, item.id, updatedAt, now), bucket: "wouldCreate" });
    else if (kind === "conflict") unreached.push({ ...notReached(item, "other"), verdict: "conflict", markdown: "conflict" }); // migrationがconflictと判定：outboxは作られず、Projectionへ進まない（Vaultは書かれない）
    else unreached.push(notReached(item, "other"));
  }
  const order: Record<string, number> = { existingPending: 0, wouldCreate: 1, existingDone: 2 };
  plans.sort((a, b) => order[a.bucket] - order[b.bucket]);

  // 5) 実際のreconcileを、shadowに対してそのまま実行する
  const reconcile = (type: RT, entry: VaultOutboxEntry): Promise<ReconcileConversationResult> =>
    type === "conversation" ? reconcileConversationOutboxEntry(env, entry) : type === "memory" ? reconcileMemoryOutboxEntry(env, entry)
      : type === "reflection" ? reconcileReflectionOutboxEntry(env, entry) : reconcileSourceOutboxEntry(env, entry);
  const results: RecordResult[] = [...unreached];
  for (const { item, entry, bucket } of plans) {
    const start = shadow.writes.length;
    let outcome: ProjectionDryRunOutcome | null = null;
    const unregister = registerProjectionDryRun(entry, (o) => { outcome = o; });
    try { await reconcile(item.type, entry); } catch { outcome = null; } finally { unregister(); }
    const writes = shadow.writes.slice(start);
    const w = (layer: string) => writes.filter((x) => layerOf(x.path) === layer);
    const o = outcome as ProjectionDryRunOutcome | null;
    const done = (step: keyof ProjectionDryRunOutcome["steps"]) => o?.steps[step] === "done";
    const mdWrite = w("md")[0];
    const result: RecordResult = {
      type: item.type, id: item.id, bucket,
      verdict: !o ? "other" : o.status === "held" ? "conflict" : o.status === "pending" ? "other" : writes.length ? "update" : "noOp",
      markdown: done("markdown") ? (mdWrite ? (mdWrite.before === null ? "wouldCreate" : "wouldRewrite") : "noOp") : o?.status === "held" ? "conflict" : "notReached",
      registry: done("registry") ? (w("registry").length ? "wouldUpdate" : "noOp") : "notReached",
      index: done("index") ? (w("index").length ? "wouldUpdate" : "noOp") : "notReached",
      history: done("history") ? (w("history").length ? "wouldUpdate" : "noOp") : "notReached",
      lossFields: [],
    };
    if (result.markdown === "wouldRewrite" && mdWrite?.before != null) {
      const a = analyzeRewrite(item.type, item.record, mdWrite.before, mdWrite.after);
      result.rewriteReason = a.reason; result.lossFields = a.lossFields;
    }
    results.push(result);
  }

  // 6) 予測されるbootstrap後のrecovery plan
  let afterPlan: RecoveryApplyPlan | null = null;
  try { afterPlan = await planRecoveryApply({ ...deps.planEnv(shadow.root()), root: shadow.root() }); } catch { afterPlan = null; }

  // 集計
  const resultOf = new Map(results.map((r) => [r.id, r]));
  const p = { recordsEvaluated: results.length, noOp: 0, update: 0, conflict: 0, notReached: 0, other: 0,
    markdown: { noOp: 0, wouldCreate: 0, wouldRewrite: 0, conflict: 0, notReached: 0 },
    registry: { noOp: 0, wouldUpdate: 0, notReached: 0 }, index: { noOp: 0, wouldUpdate: 0, notReached: 0 }, history: { noOp: 0, wouldUpdate: 0, notReached: 0 },
    outbox: { wouldCreate: 0, existingPending: 0, existingDone: 0, other: 0 } };
  const rewriteReasons: Record<RewriteReason, number> = { serializationOnly: 0, missingTurnTimes: 0, frontmatterDifference: 0, semanticSuccessor: 0, other: 0 };
  const lossFields: Record<string, number> = {}; let lossRecords = 0;
  for (const r of results) {
    p[r.verdict] += 1; p.markdown[r.markdown] += 1; p.registry[r.registry] += 1; p.index[r.index] += 1; p.history[r.history] += 1; p.outbox[r.bucket] += 1;
    if (r.rewriteReason) rewriteReasons[r.rewriteReason] += 1;
    if (r.lossFields.length) { lossRecords += 1; for (const f of r.lossFields) lossFields[f] = (lossFields[f] ?? 0) + 1; }
  }

  const heldIds = new Set(historyHeld.map((h) => h.recordId));
  const divIds = new Set(divergent.map((d) => d.id));
  const typeOfHeld = (id: string): RT => { const h = historyHeld.find((x) => x.recordId === id)!; return (TYPES.includes(h.recordType as RT) ? h.recordType : "memory") as RT; };
  const overlap = { divergentAndHistoryHeld: 0, divergentOnly: 0, historyHeldOnly: 0, byType: { divergentAndHistoryHeld: byType(), divergentOnly: byType(), historyHeldOnly: byType() } };
  for (const d of divergent) { const k = heldIds.has(d.id) ? "divergentAndHistoryHeld" : "divergentOnly"; overlap[k] += 1; overlap.byType[k][d.type] += 1; }
  for (const h of historyHeld) if (!divIds.has(h.recordId)) { overlap.historyHeldOnly += 1; overlap.byType.historyHeldOnly[typeOfHeld(h.recordId)] += 1; }

  const heldAfter = new Set(afterPlan?.held.map((h) => h.recordId) ?? []);
  const prediction = { wouldBecomeCorrect: 0, wouldRemainHeld: 0, wouldNotBeReached: 0, unknown: 0 };
  for (const h of historyHeld) {
    const r = resultOf.get(h.recordId);
    if (!afterPlan || fidelity !== "ok") prediction.unknown += 1;
    else if (!heldAfter.has(h.recordId)) prediction.wouldBecomeCorrect += 1;
    else if (!r || r.history === "notReached" || r.verdict === "notReached") prediction.wouldNotBeReached += 1;
    else prediction.wouldRemainHeld += 1;
  }
  const afterByReason: Record<string, number> = {};
  for (const h of afterPlan?.held ?? []) afterByReason[h.reason] = (afterByReason[h.reason] ?? 0) + 1;
  const trustworthy = fidelity === "ok" && !!afterPlan && p.other === 0;

  const preservation = { preservedBothSides: 0, wouldOverwriteVault: { total: 0, semantic: 0, representation: 0 }, wouldOverwriteCanonical: 0 as const, unknown: 0 };
  for (const d of divergent) {
    const r = resultOf.get(d.id);
    if (!r || r.verdict === "other") preservation.unknown += 1;
    else if (r.markdown === "wouldRewrite" || r.markdown === "wouldCreate") {
      preservation.wouldOverwriteVault.total += 1;
      if (r.rewriteReason === "serializationOnly" || r.rewriteReason === "missingTurnTimes" || r.rewriteReason === "frontmatterDifference") preservation.wouldOverwriteVault.representation += 1;
      else preservation.wouldOverwriteVault.semantic += 1;
    } else preservation.preservedBothSides += 1;
  }

  const canonicalUnchanged = JSON.stringify(await deps.readSnapshot()) === canonicalBefore;
  const dv = { total: divergent.length, byType: byType(),
    conversation: { timestampOnly: 0, roleContent: 0, other: 0 }, reflection: { semanticEqualButIdentityDivergent: 0, trueSemanticDifference: 0 } };
  for (const d of divergent) {
    dv.byType[d.type] += 1;
    if (d.type === "conversation") dv.conversation[d.detail as "timestampOnly" | "roleContent" | "other"] += 1;
    if (d.type === "reflection" && d.detail in dv.reflection) dv.reflection[d.detail as "semanticEqualButIdentityDivergent" | "trueSemanticDifference"] += 1;
  }
  const hh = { total: historyHeld.length, byType: byType() };
  for (const h of historyHeld) hh.byType[typeOfHeld(h.recordId)] += 1;

  const report: DryRunReport = {
    divergent: dv, historyHeld: hh, overlap, projection: p, rewriteReasons,
    metadataLoss: { potentialVaultOnlyMetadataLoss: lossRecords, potentialLossFields: lossFields },
    historyPrediction: { ...prediction, expectedRawHeldAfterBootstrap: trustworthy ? afterPlan!.heldCount : "unknown", afterByReason, shadowFidelity: fidelity },
    divergentPreservation: preservation,
    safety: { simulatedWritesInMemoryOnly: shadow.writes.length, canonicalUnchanged },
  };
  return { report, shadow, results, divergent };
}

export async function runProjectionDryRun(root: FileSystemDirectoryHandle, rawPlan: RecoveryApplyPlan, deps: DryRunDeps): Promise<DryRunReport> {
  return (await runProjectionDryRunWithShadow(root, rawPlan, deps)).report;
}

/** 画面に出す整形（件数のみ。IDも本文も出さない）。 */
export function formatDryRun(r: DryRunReport): string {
  const t = (b: ByType) => `Conversation ${b.conversation} / Memory ${b.memory} / Reflection ${b.reflection} / Source ${b.source}`;
  const p = r.projection, h = r.historyPrediction;
  return [
    "DIVERGENT RECORDS (identity comparison)",
    `  total: ${r.divergent.total} (${t(r.divergent.byType)})`,
    `  Conversation: timestampOnly ${r.divergent.conversation.timestampOnly} / roleContent ${r.divergent.conversation.roleContent} / other ${r.divergent.conversation.other}`,
    `  Reflection: semanticEqualButIdentityDivergent ${r.divergent.reflection.semanticEqualButIdentityDivergent} / trueSemanticDifference ${r.divergent.reflection.trueSemanticDifference}`,
    "HISTORY HELD", `  total: ${r.historyHeld.total} (${t(r.historyHeld.byType)})`,
    "OVERLAP", `  divergentAndHistoryHeld: ${r.overlap.divergentAndHistoryHeld} (${t(r.overlap.byType.divergentAndHistoryHeld)})`,
    `  divergentOnly: ${r.overlap.divergentOnly} (${t(r.overlap.byType.divergentOnly)})`, `  historyHeldOnly: ${r.overlap.historyHeldOnly} (${t(r.overlap.byType.historyHeldOnly)})`,
    "PROJECTION DRY RUN (Phase 1 assumed; nothing written)",
    `  recordsEvaluated: ${p.recordsEvaluated}`, `  noOp: ${p.noOp} / update: ${p.update} / conflict: ${p.conflict} / notReached: ${p.notReached} / other: ${p.other}`,
    `  Markdown: noOp ${p.markdown.noOp} / wouldCreate ${p.markdown.wouldCreate} / wouldRewrite ${p.markdown.wouldRewrite} / conflict ${p.markdown.conflict} / notReached ${p.markdown.notReached}`,
    `  Registry: noOp ${p.registry.noOp} / wouldUpdate ${p.registry.wouldUpdate} / notReached ${p.registry.notReached}`,
    `  Index: noOp ${p.index.noOp} / wouldUpdate ${p.index.wouldUpdate} / notReached ${p.index.notReached}`,
    `  History: noOp ${p.history.noOp} / wouldUpdate ${p.history.wouldUpdate} / notReached ${p.history.notReached}`,
    `  Outbox: wouldCreate ${p.outbox.wouldCreate} / existingPending ${p.outbox.existingPending} / existingDone ${p.outbox.existingDone} / other ${p.outbox.other}`,
    "MARKDOWN REWRITE REASONS",
    `  serializationOnly ${r.rewriteReasons.serializationOnly} / missingTurnTimes ${r.rewriteReasons.missingTurnTimes} / frontmatterDifference ${r.rewriteReasons.frontmatterDifference} / semanticSuccessor ${r.rewriteReasons.semanticSuccessor} / other ${r.rewriteReasons.other}`,
    `  potentialVaultOnlyMetadataLoss: ${r.metadataLoss.potentialVaultOnlyMetadataLoss}`,
    `  potentialLossFields: ${Object.entries(r.metadataLoss.potentialLossFields).map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`,
    "HISTORY 54 PREDICTION",
    `  wouldBecomeCorrect: ${h.wouldBecomeCorrect} / wouldRemainHeld: ${h.wouldRemainHeld} / wouldNotBeReached: ${h.wouldNotBeReached} / unknown: ${h.unknown}`,
    `  expectedRawHeldAfterBootstrap: ${h.expectedRawHeldAfterBootstrap}`,
    `  expected held by reason after: ${Object.entries(h.afterByReason).map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`,
    `  shadowFidelity (shadow plan == real plan before any simulated write): ${h.shadowFidelity}`,
    "DIVERGENT PRESERVATION",
    `  preservedBothSides: ${r.divergentPreservation.preservedBothSides}`,
    `  wouldOverwriteVault: ${r.divergentPreservation.wouldOverwriteVault.total} (semantic ${r.divergentPreservation.wouldOverwriteVault.semantic} / representation ${r.divergentPreservation.wouldOverwriteVault.representation})`,
    `  wouldOverwriteCanonical: ${r.divergentPreservation.wouldOverwriteCanonical} / unknown: ${r.divergentPreservation.unknown}`,
    `  simulatedWrites (memory only, never persisted): ${r.safety.simulatedWritesInMemoryOnly} / canonicalUnchanged: ${r.safety.canonicalUnchanged}`,
  ].join("\n");
}
