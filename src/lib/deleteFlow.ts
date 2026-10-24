/**
 * The ONE user-facing deletion flow: the user presses "delete" on a memory or a conversation, sees what will be removed, confirms once, and the record is removed
 * from this device AND from the Vault (Markdown, index, history, registry) by the existing, safety-checked engines. The flow only orchestrates them:
 *
 *   prepareDelete   read-only. Counts the impact and, when a Vault is connected, builds the exact Vault plan with a dry run (identity / permission / ownership /
 *                   malformed-metadata checks). If it can not be built the screen shows the reason and NOTHING can be deleted.
 *   executeDelete   one transaction removes the record from this device and writes the tombstone (resurrection guard); then the real plan is rebuilt from the
 *                   tombstone and must be IDENTICAL to the plan the user confirmed, otherwise the Vault is not touched; then the engine runs it. Only when every
 *                   step succeeded is the result "done".
 *   continueDelete  after a failure: re-verifies the Vault, the files and the saved plan, and returns the plan to show again; nothing is rerun without consent.
 *
 * The tombstone stays in every case: an interrupted deletion never lets the record come back. No secret or record text is logged here.
 */
import {
  deleteConversationByUser, deleteConversationWithMemoriesByUser, deleteMemoryByUser, getAllMemoryObjects, getConversation, getMemoryObject, getTombstone,
  listTombstones, loadVaultHandle, type Tombstone,
} from "./db";
import { confirmVaultDeletion, dryRunVaultDeletion, previewVaultDeletion, previewVaultDeletionRepair, type VaultDeletionPlan } from "./vaultDeletion";
import { getVaultBackend } from "./vault";

export type DeleteTarget = { kind: "memory"; id: string } | { kind: "conversation"; id: string; withMemories: boolean };
export type VaultAccess = { kind: "none" } | { kind: "ready"; root: FileSystemDirectoryHandle } | { kind: "denied" };

export interface DeleteReview {
  target: DeleteTarget;
  /** memory: how many other memories link to it. conversation: how many memories were made from it (on this device). */
  linkedMemories: number;
  childMemories: number;
  /** null when no Vault is connected (this device only) */
  plan: VaultDeletionPlan | null;
  /** user-facing files the plan changes (internal index / history files are summarised by `metadataFiles`) */
  files: string[];
  metadataFiles: number;
  /** why nothing can be deleted right now (Japanese); null when the deletion can be confirmed */
  blocker: string | null;
}

export type DeleteOutcome =
  | { status: "done"; vault: "deleted" | "not-connected" }
  /** removed from this device and protected from coming back, but the Vault part is not complete */
  | { status: "incomplete"; message: string }
  | { status: "refused"; message: string };

/** Vault root for reading / writing. Must be called from a user gesture on devices whose Vault is a user-selected folder (the permission prompt). */
export async function resolveVaultAccess(): Promise<VaultAccess> {
  if (getVaultBackend() === "opfs") {
    try { return { kind: "ready", root: await navigator.storage.getDirectory() }; } catch { return { kind: "denied" }; }
  }
  const handle = await loadVaultHandle();
  if (!handle) return { kind: "none" };
  const h = handle as unknown as { queryPermission?: (o: { mode: string }) => Promise<string>; requestPermission?: (o: { mode: string }) => Promise<string> };
  let state = (await h.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state !== "granted") state = (await h.requestPermission?.({ mode: "readwrite" })) ?? "granted";
  return state === "granted" ? { kind: "ready", root: handle } : { kind: "denied" };
}

/** Internal engine error codes -> an explanation that tells the user what is wrong and what to do. Never shows a raw code. */
export function explainDeletionError(error: unknown): string {
  const name = (error as Error)?.name ?? "";
  const message = (error as Error)?.message ?? "";
  if (name === "RecoveryPendingError") return "復旧またはメンテナンスの処理中のため、いまは削除できません。完了してからもう一度お試しください。";
  if (name === "TombstonedRecordError") return "すでに削除された記録です。";
  if (name === "TombstoneStoreCorruptError") return "削除の記録を安全に読み取れないため、削除を止めました。アプリを開き直してもう一度お試しください。";
  const code = (/^vault-deletion:([a-z-]+)/.exec(message)?.[1]) ?? (/^(deletion-intent-changed|unconfirmed-cascade|cascade-child-owner-changed)/.exec(message)?.[1]) ?? "";
  switch (code) {
    case "locks-unavailable": return "このブラウザでは、保存先を安全に操作できません。別のブラウザで開いてください。";
    case "permission-required": return "保存先への書き込みの許可がありません。もう一度「削除を続ける」を押して、許可してください。";
    case "recovery-pending": return "復旧またはメンテナンスの処理中のため、いまは削除できません。完了してからもう一度お試しください。";
    case "incomplete-world": return "保存先の切り替えが完了していません。アプリを開き直し、少し待ってからもう一度お試しください。";
    case "unpaired-vault": return "この端末と保存先の紐づけが、まだ完了していません。トップ画面を開いて、同期が終わるまでしばらく待ってから、もう一度お試しください。それでも進まない場合は、保存先に別のデータが入っている可能性があります。";
    case "vault-handle-changed": return "いま接続している保存先が、削除を始めたときの保存先と違います。元の保存先を接続し直してから、もう一度お試しください。";
    case "vault-identity-mismatch": return "接続している保存先が、この端末が覚えている保存先と一致しません。別の保存先を誤って削除しないように、削除を止めました。";
    case "deletion-intent-changed": return "削除の状態が、別の画面で変わっています。画面を開き直して、もう一度確認してください。";
    case "parent-deletion-required": return "この記憶は会話と一緒に削除されます。会話の項目の「削除を続ける」から進めてください。";
    case "journal-world-mismatch": return "保存先に接続し直したため、そのままでは再開できません。「削除を続ける」を押して、内容をもう一度確認してください。";
    case "journal-missing": return "削除の途中経過の記録が見つかりません。画面を開き直して、もう一度お試しください。";
    case "content-review-required":
    case "content-changed": return "保存先のファイルが、削除を始めたときと違う内容になっています(途中で中断したか、他のアプリで編集された可能性があります)。「削除を続ける」で、現在の内容と削除後の内容を確認してください。";
    case "preview-changed":
    case "vault-world-changed": return "確認したあとに、保存先の内容が変わりました。保存先は変更していません。もう一度「削除を続ける」で内容を確認してください。";
    case "verification-failed":
    case "final-verification-failed": return "書き込んだ内容を確認できませんでした。データは保護されたままです。もう一度「削除を続ける」を押してください。";
    case "copy-reappeared": return "削除したはずの記録のファイルが、保存先にもう一度現れました(他のアプリや別の端末の同期の可能性があります)。同期を止めてから、もう一度「削除を続ける」を押してください。";
    case "matching-record-not-owned": return "保存先に同じIDのファイルがありますが、Tsumugiが作ったものと確認できないため、削除していません。";
    case "scan-too-large":
    case "scan-too-deep": return "保存先のファイルが多すぎて、安全に確認できません。何も削除していません。";
    case "unsafe-path": return "保存先に、安全に扱えないファイル名があります。何も削除していません。";
    case "unconfirmed-cascade":
    case "cascade-child-owner-changed": return "会話に属する記憶の状態が変わったため、削除を止めました。画面を開き直して、もう一度確認してください。";
    default:
      if (/^vault-deletion:(malformed|ambiguous|registry|missing-id|reference)/.test(message)) return "保存先の管理ファイルの形式を安全に判断できないため、何も変更していません。";
      return "削除を完了できませんでした。データは安全に保護されています。時間をおいて、もう一度お試しください。";
  }
}

const isMetadata = (path: string) => path.startsWith(".tsumugi/");

export async function prepareDelete(target: DeleteTarget, access: VaultAccess, now: string = new Date().toISOString()): Promise<DeleteReview> {
  const base: DeleteReview = { target, linkedMemories: 0, childMemories: 0, plan: null, files: [], metadataFiles: 0, blocker: null };
  let prospective: Tombstone;
  if (target.kind === "memory") {
    const m = await getMemoryObject(target.id);
    if (!m) return { ...base, blocker: "この記憶は、すでに削除されているか見つかりません。" };
    base.linkedMemories = (await getAllMemoryObjects()).filter((o) => o.id !== m.id && (o.links ?? []).some((l) => l.sourceId === m.id || l.targetId === m.id)).length;
    prospective = { v: 1, kind: "memory", id: m.id, deletedAt: now, date: m.date, conversationId: m.conversationId, vault: "unverified" };
  } else {
    const c = await getConversation(target.id);
    if (!c) return { ...base, blocker: "この会話は、すでに削除されているか見つかりません。" };
    base.childMemories = (await getAllMemoryObjects()).filter((o) => o.conversationId === c.id).length;
    prospective = { v: 1, kind: "conversation", id: c.id, deletedAt: now, startedAt: c.startedAt, ...(target.withMemories ? { cascade: true } : {}), vault: "unverified" };
  }
  if (access.kind === "none") return base;
  if (access.kind === "denied") return { ...base, blocker: "保存先への書き込みの許可が必要です。許可してから、もう一度「削除」を押してください。" };
  try {
    const plan = await dryRunVaultDeletion(access.root, prospective);
    const paths = plan.edits.map((e) => e.path);
    return { ...base, plan, files: paths.filter((p) => !isMetadata(p)), metadataFiles: paths.filter(isMetadata).length };
  } catch (e) {
    return { ...base, blocker: explainDeletionError(e) };
  }
}

/** The plan the user confirmed and the plan rebuilt from the real tombstone must change exactly the same things. */
export function samePlan(a: VaultDeletionPlan, b: VaultDeletionPlan): boolean {
  return a.vaultId === b.vaultId && JSON.stringify(a.edits) === JSON.stringify(b.edits) && JSON.stringify([...a.ids].sort()) === JSON.stringify([...b.ids].sort());
}

export async function executeDelete(review: DeleteReview, access: VaultAccess, now: string = new Date().toISOString()): Promise<DeleteOutcome> {
  if (review.blocker) return { status: "refused", message: review.blocker };
  const { target } = review;
  // 1. this device + tombstone, in one transaction (nothing is left half-deleted here)
  let removed: boolean;
  try {
    removed = target.kind === "memory" ? (await deleteMemoryByUser(target.id, now)).status === "deleted"
      : target.withMemories ? (await deleteConversationWithMemoriesByUser(target.id, now)).conversation.status === "deleted"
      : (await deleteConversationByUser(target.id, now)).status === "deleted";
  } catch (e) { return { status: "refused", message: explainDeletionError(e) }; }
  if (!removed) return { status: "refused", message: "すでに削除されているか、見つかりませんでした。" };
  if (!review.plan || access.kind !== "ready") return { status: "done", vault: "not-connected" };
  // 2. the Vault: the real plan must equal the confirmed one
  try {
    const tombstone = await getTombstone(target.kind, target.id);
    if (!tombstone) return { status: "incomplete", message: explainDeletionError(new Error("deletion-intent-changed")) };
    const real = await previewVaultDeletion(access.root, tombstone);
    if (!samePlan(review.plan, real)) return { status: "incomplete", message: "確認したあとに、保存先の内容が変わりました。保存先のファイルは変更していません。「削除を続ける」で、変更内容をもう一度確認してください。" };
    await confirmVaultDeletion(access.root, real);
    return { status: "done", vault: "deleted" };
  } catch (e) { return { status: "incomplete", message: explainDeletionError(e) }; }
}

/** Deletions that still need the user: the Vault part is pending (interrupted), or was never started although a Vault was paired. Children of a cascade follow their parent. */
export async function listIncompleteDeletions(): Promise<Tombstone[]> {
  return (await listTombstones()).filter((t) =>
    !t.physicalDeletionParent && t.physicalDeletion !== "complete" && t.vault !== "kept" && t.vault !== "absent"
    && (t.physicalDeletion === "pending" || typeof t.vaultId === "string"));
}

export interface ContinueReview { tombstone: Tombstone; plan: VaultDeletionPlan; repair: boolean; files: string[]; metadataFiles: number }
/** "Continue deleting": re-verifies the Vault, the current files and the saved plan, then returns what would change. Nothing is written. */
export async function continueDelete(seen: Tombstone, access: VaultAccess): Promise<ContinueReview> {
  if (access.kind === "none") throw new Error("vault-deletion:vault-handle-changed");
  if (access.kind === "denied") throw new Error("vault-deletion:permission-required");
  const t = (await getTombstone(seen.kind, seen.id)) ?? seen;
  let plan: VaultDeletionPlan; let repair = false;
  try { plan = await previewVaultDeletion(access.root, t); }
  catch (e) {
    // a file in an unexpected state (torn write / outside edit): the existing content review + repair flow
    if (/content-review-required/.test((e as Error)?.message ?? "") && t.physicalDeletion === "pending") { plan = await previewVaultDeletionRepair(access.root, t); repair = true; }
    else throw e;
  }
  const paths = plan.edits.map((e) => e.path);
  return { tombstone: t, plan, repair, files: paths.filter((p) => !isMetadata(p)), metadataFiles: paths.filter(isMetadata).length };
}
export async function finishContinuedDelete(access: VaultAccess, review: ContinueReview): Promise<DeleteOutcome> {
  if (access.kind !== "ready") return { status: "refused", message: explainDeletionError(new Error("vault-deletion:permission-required")) };
  try { await confirmVaultDeletion(access.root, review.plan); return { status: "done", vault: "deleted" }; }
  catch (e) { return { status: "incomplete", message: explainDeletionError(e) }; }
}
