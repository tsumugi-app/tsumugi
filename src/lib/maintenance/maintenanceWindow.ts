/**
 * Maintenance window: (1) the exclusive Vault-world lock, held from `enter` to `end`; (2) the durable journal gate (maintenanceGate.ts), opened
 * right after the lock is taken and closed right before it is released; (3) a Vault-write permission that exists ONLY inside an explicit
 * `runWithMaintenanceWriteAccess` scope of this window.
 *
 * Why the gate, not just the lock: a Web Lock disappears with the tab. The journal gate survives a closed tab / crash, so the normal app
 * (startup flush, Save Foundation Bootstrap, Connect, legacy writers) keeps refusing to touch the Vault and the Outbox until the gate is
 * released on this page ("release stale gate").
 *
 * The write permission can not leak:
 *  - it is a per-tab-context flag installed into vaultRecoveryJournal.ts as a probe; other tabs have their own (empty) module state;
 *  - the probe answers true only while THIS window is open (lock held + gate open) AND a write scope is running AND the page is under
 *    /maintenance (in a browser; `location` is checked), so even if this module were loaded in the app screen it would grant nothing there;
 *  - the scope is explicit and bounded (depth counter, always decremented in `finally`); `end` refuses while a scope is running;
 *  - when the window ends, is lost, or fails to open, the probe answers false.
 * Known property: inside a scope, any Vault write started in the SAME tab is allowed. The maintenance page runs no app code (no ChatScreen,
 * no Capture, no Connect: enforced by maintenanceBoundary.test.ts), so there is nothing else in this tab that could write.
 */
import { runVaultWorldExclusive } from "../vaultWorldLock";
import { setMaintenanceWriteAccessProbe } from "../vaultRecoveryJournal";
import { closeMaintenanceGate, openMaintenanceGate, type GateDeps, type GateOpenResult } from "./maintenanceGate";

/** Must equal LOCK_NAME in vaultWorldLock.ts (asserted by maintenanceGate.test.ts). */
export const VAULT_WORLD_LOCK_NAME = "tsumugi-vault-world";

export class MaintenanceWriteAccessError extends Error {
  constructor(public readonly reason: "no-window" | "not-maintenance-context") { super(`maintenance write access refused: ${reason}`); this.name = "MaintenanceWriteAccessError"; }
}

interface LockSnapshotEntry { name?: string }
export type QueryLocks = () => Promise<{ held?: LockSnapshotEntry[]; pending?: LockSnapshotEntry[] } | null>;
const defaultQueryLocks: QueryLocks = async () => {
  const locks = typeof navigator !== "undefined" ? (navigator as { locks?: { query?: () => Promise<{ held?: LockSnapshotEntry[]; pending?: LockSnapshotEntry[] }> } }).locks : undefined;
  return locks && typeof locks.query === "function" ? locks.query() : null;
};

export interface EnterOptions extends GateDeps {
  purpose: string;
  timeoutMs?: number;
  queryLocks?: QueryLocks;
}
export type EnterResult =
  | { ok: true; operationId: string }
  | { ok: false; reason: "window-already-open" | "not-maintenance-context" | "lock-contention" | "lock-unavailable" | `lock-error:${string}` | Extract<GateOpenResult, { ok: false }>["reason"] };

interface Held { operationId: string; release: () => void; settled: Promise<unknown>; scopeDepth: number; deps: GateDeps }
let held: Held | null = null;

/** In a browser the page must be under /maintenance. Outside a browser (unit tests) there is no location to check. */
function inMaintenanceContext(): boolean {
  const loc = (globalThis as { location?: { pathname?: string } }).location;
  if (!loc || typeof loc.pathname !== "string") return true;
  return loc.pathname === "/maintenance" || loc.pathname.startsWith("/maintenance/");
}
const permitted = () => held !== null && held.scopeDepth > 0 && inMaintenanceContext();

export function isMaintenanceWindowOpen(): boolean { return held !== null; }

export async function enterMaintenanceWindow(opts: EnterOptions): Promise<EnterResult> {
  if (held) return { ok: false, reason: "window-already-open" };
  if (!inMaintenanceContext()) return { ok: false, reason: "not-maintenance-context" };
  // Someone else holding or waiting for the Vault-world lock means an app tab is busy: do not even queue behind it.
  try {
    const snap = await (opts.queryLocks ?? defaultQueryLocks)();
    const others = [...(snap?.held ?? []), ...(snap?.pending ?? [])].filter((l) => l.name === VAULT_WORLD_LOCK_NAME);
    if (others.length > 0) return { ok: false, reason: "lock-contention" };
  } catch { /* lock inspection is an extra check only; the exclusive request below is the real guard */ }

  let signalAcquired!: () => void; let releaseHold!: () => void;
  const acquired = new Promise<void>((r) => { signalAcquired = r; });
  const hold = new Promise<void>((r) => { releaseHold = r; });
  const settled = runVaultWorldExclusive(async () => { signalAcquired(); await hold; }, opts.timeoutMs).then((r) => ({ r }), (error: unknown) => ({ error }));
  const first = await Promise.race([acquired.then(() => "held" as const), settled]);
  if (first !== "held") {
    if ("error" in first) return { ok: false, reason: `lock-error:${(first.error as Error)?.name ?? "error"}` };
    return { ok: false, reason: "lock-unavailable" };
  }

  const gate = await openMaintenanceGate(opts.purpose, opts);
  if (!gate.ok) { releaseHold(); await settled; return { ok: false, reason: gate.reason }; }

  held = { operationId: gate.operationId, release: releaseHold, settled, scopeDepth: 0, deps: opts };
  setMaintenanceWriteAccessProbe(permitted);
  return { ok: true, operationId: gate.operationId };
}

export type EndResult = { ok: true; gateClosed: true } | { ok: false; reason: "no-window" | "write-scope-active" } | { ok: true; gateClosed: false; reason: string };

/** Closes the gate, then releases the lock. If the gate can not be closed it STAYS closed to the app (safe) and is reported. */
export async function endMaintenanceWindow(): Promise<EndResult> {
  const h = held;
  if (!h) return { ok: false, reason: "no-window" };
  if (h.scopeDepth > 0) return { ok: false, reason: "write-scope-active" };
  const closed = await closeMaintenanceGate(h.operationId, h.deps);
  held = null; setMaintenanceWriteAccessProbe(null);
  h.release(); await h.settled;
  return closed.closed ? { ok: true, gateClosed: true } : { ok: true, gateClosed: false, reason: closed.reason };
}

/** Runs `fn` with Vault writes permitted for THIS window only. Throws if there is no open window or the page is not a maintenance page. */
export async function runWithMaintenanceWriteAccess<T>(fn: () => Promise<T>): Promise<T> {
  const h = held;
  if (!h) throw new MaintenanceWriteAccessError("no-window");
  if (!inMaintenanceContext()) throw new MaintenanceWriteAccessError("not-maintenance-context");
  h.scopeDepth += 1;
  try { return await fn(); } finally { h.scopeDepth -= 1; }
}

export type StaleReleaseResult = { released: true } | { released: false; reason: "window-open-in-this-tab" | "not-maintenance-context" | "lock-contention" | "lock-unavailable" | `lock-error:${string}` | "no-maintenance-gate" | string };

/**
 * After a crash / closed tab the gate is still in place (by design). This releases it, under the exclusive Vault-world lock so that no other
 * maintenance tab is active. Only a MAINTENANCE gate is ever closed; any other journal is left alone.
 */
export async function releaseStaleMaintenanceGate(opts: GateDeps & { timeoutMs?: number; queryLocks?: QueryLocks } = {}): Promise<StaleReleaseResult> {
  if (held) return { released: false, reason: "window-open-in-this-tab" };
  if (!inMaintenanceContext()) return { released: false, reason: "not-maintenance-context" };
  try {
    const snap = await (opts.queryLocks ?? defaultQueryLocks)();
    if ([...(snap?.held ?? []), ...(snap?.pending ?? [])].some((l) => l.name === VAULT_WORLD_LOCK_NAME)) return { released: false, reason: "lock-contention" };
  } catch { /* extra check only */ }
  try {
    const r = await runVaultWorldExclusive(() => closeMaintenanceGate(null, opts), opts.timeoutMs);
    const result = r.result;
    if (r.timedOut || !result) return { released: false, reason: "lock-unavailable" };
    return result.closed ? { released: true } : { released: false, reason: result.reason === "no-journal" || result.reason === "not-in-progress" ? "no-maintenance-gate" : result.reason };
  } catch (error) {
    return { released: false, reason: `lock-error:${(error as Error)?.name ?? "error"}` };
  }
}

/** TEST ONLY: the tab disappears (lock released by the browser, module state gone) without closing the gate. */
export function __simulateTabLossForTests(): void {
  const h = held;
  held = null; setMaintenanceWriteAccessProbe(null);
  h?.release();
}
