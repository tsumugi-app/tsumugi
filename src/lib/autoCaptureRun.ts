import {
  AUTO_CAPTURE_TIMEOUT_MS, beginAutoCaptureAttempt, classifyAutoCaptureFailure, finishAutoCaptureAttempt, isStopped, selectAutoCaptureTargets,
  type AutoCaptureResult, type AutoCaptureSettings, type AutoCaptureState,
} from "./autoCapturePolicy";
import type { Conversation } from "./types";

export type AutoCaptureRunOutcome = "off" | "blocked" | "no-key" | "offline" | "nothing" | AutoCaptureResult;

export interface AutoCaptureDeps {
  loadSettings(): Promise<AutoCaptureSettings>;
  /** only the user's own Gemini key: without one nothing is sent, so the server key is never used */
  hasUserKey(): Promise<boolean>;
  online(): boolean;
  /** Vault not connected, recovery pending, Vault switch running, stale tab */
  blocked(): boolean;
  /** false when another tab is already running this */
  withRunLock(fn: () => Promise<AutoCaptureRunOutcome>): Promise<AutoCaptureRunOutcome | null>;
  readConversations(): Promise<Conversation[]>;
  readConversation(id: string): Promise<Conversation | undefined>;
  conversationsWithMemory(): Promise<ReadonlySet<string>>;
  readState(): Promise<AutoCaptureState>;
  writeState(state: AutoCaptureState): Promise<void>;
  ifConversationFree<T>(id: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
  /** false: the Vault file was edited from outside or is held, so the stored words may be old */
  vaultFileUnchanged(id: string): Promise<boolean>;
  /** calls `onRequestSent` just before the AI request starts */
  capture(conversation: Conversation, signal: AbortSignal, onRequestSent: () => void): Promise<AutoCaptureResult>;
  now(): number;
}

/** One conversation at most: one start, or one press of the manual retry. Failures are recorded and never thrown to the caller, except a stale tab or an incomplete Vault world. */
export async function runAutoCapture(deps: AutoCaptureDeps, options: { manual?: boolean; shouldCancel?: () => boolean } = {}): Promise<AutoCaptureRunOutcome> {
  const manual = options.manual === true;
  const settings = await deps.loadSettings();
  if (!manual && !settings.enabled) return "off";
  if (deps.blocked()) return "blocked";
  if (!deps.online()) return "offline";
  if (!(await deps.hasUserKey())) return "no-key";
  const outcome = await deps.withRunLock(async () => {
    const state = await deps.readState();
    const conversations = await deps.readConversations();
    const withMemory = await deps.conversationsWithMemory();
    for (const candidate of selectAutoCaptureTargets(conversations, withMemory, state, settings, deps.now(), manual)) {
      const run = await deps.ifConversationFree(candidate.id, async (): Promise<AutoCaptureRunOutcome | "not-sent"> => {
        // the lists above were read before the locks: decide again on what is stored now
        const before = await deps.readState();
        const stored = await deps.readConversation(candidate.id);
        const memoriesNow = await deps.conversationsWithMemory();
        if (!stored || !selectAutoCaptureTargets([stored], memoriesNow, before, settings, deps.now(), manual).length) return "not-sent";
        if (!(await deps.vaultFileUnchanged(stored.id))) return "not-sent";
        await deps.writeState(beginAutoCaptureAttempt(before, stored.id, deps.now(), manual && isStopped(before, stored.id)));

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AUTO_CAPTURE_TIMEOUT_MS);
        let cancelledNow = false;
        let requested = false;
        const poll = setInterval(() => { if (options.shouldCancel?.()) { cancelledNow = true; controller.abort(); } }, 500);
        let result: AutoCaptureResult;
        try {
          result = await deps.capture(stored, controller.signal, () => { requested = true; });
        } catch (error) {
          const name = (error as Error | undefined)?.name;
          if (name === "StaleVaultTabError" || name === "IncompleteVaultWorldError") {
            await deps.writeState(finishAutoCaptureAttempt(await deps.readState(), before, stored.id, "cancelled", requested)).catch(() => undefined);
            throw error;
          }
          result = classifyAutoCaptureFailure(error, cancelledNow);
        } finally {
          clearTimeout(timeout);
          clearInterval(poll);
        }
        await deps.writeState(finishAutoCaptureAttempt(await deps.readState(), before, stored.id, result, requested));
        return !requested && result === "changed" ? "not-sent" : result;
      });
      // Only a conversation that cost no request gives way to the next one. Once a request was made, this start has had its conversation, whatever became of the result.
      if (run.ran && run.value !== "not-sent") return run.value;
    }
    return "nothing";
  });
  return outcome ?? "blocked";
}
