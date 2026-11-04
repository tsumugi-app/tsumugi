import { endsWithInterruptedReply, isBlankAiReply } from "./aiReplyOutcome";
import type { Conversation } from "./types";

/**
 * Memory creation for conversations left without an end action (docs/startup-memory-capture.md).
 * The decisions only: what may be sent, in which order, and what a result means for the next try. No I/O.
 */
export const AUTO_CAPTURE_QUIET_MS = 30 * 60_000;
export const AUTO_CAPTURE_PER_DAY = 5;
export const AUTO_CAPTURE_DAY_MS = 24 * 60 * 60_000;
export const AUTO_CAPTURE_MAX_ATTEMPTS = 3;
export const AUTO_CAPTURE_WAIT_MS = 6 * 60 * 60_000;
export const AUTO_CAPTURE_TIMEOUT_MS = 60_000;

export interface AutoCaptureSettings {
  /** off until the user turns it on */
  enabled: boolean;
  /** a conversation held with another AI, or with no record of which AI, may go to Gemini */
  allowOtherProviders: boolean;
}
export const AUTO_CAPTURE_SETTINGS_OFF: AutoCaptureSettings = { enabled: false, allowOtherProviders: false };

/** "started": no result was recorded (the app closed during the call). "next-start": no wait. "wait": try again after AUTO_CAPTURE_WAIT_MS. */
export type AutoCaptureAttemptKind = "started" | "next-start" | "wait";
export interface AutoCaptureAttempt { attempts: number; lastAttemptAt: string; lastKind: AutoCaptureAttemptKind }
export interface AutoCaptureState {
  conversations: Record<string, AutoCaptureAttempt>;
  /** when each attempt started, within the last 24 hours */
  recentRuns: string[];
}
export const emptyAutoCaptureState = (): AutoCaptureState => ({ conversations: {}, recentRuns: [] });

export type AutoCaptureResult =
  | "saved" | "empty"                             // finished
  | "all-dropped" | "http" | "save-failed"        // counted, after the wait
  | "network"                                     // counted, at the next start
  | "key" | "changed" | "already" | "cancelled"   // not counted: nothing was learned about this conversation
  | "deleted";

export function parseAutoCaptureSettings(raw: string | undefined): AutoCaptureSettings {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return { enabled: v?.enabled === true, allowOtherProviders: v?.allowOtherProviders === true };
  } catch { return { ...AUTO_CAPTURE_SETTINGS_OFF }; }
}

export function parseAutoCaptureState(raw: string | undefined): AutoCaptureState {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || typeof v.conversations !== "object" || !v.conversations || !Array.isArray(v.recentRuns)) return emptyAutoCaptureState();
    return { conversations: v.conversations, recentRuns: v.recentRuns.filter((t: unknown) => typeof t === "string") };
  } catch { return emptyAutoCaptureState(); }
}

/**
 * Which AI this conversation was held with is recorded from now on, before the new turn is added. A conversation that already has turns but no record may have been held with any of them,
 * and stays unknown when it goes on with Gemini, so it still needs the permission.
 */
export const UNKNOWN_CHAT_PROVIDER = "unknown";
export function withChatProvider(conversation: Conversation, provider: string): Conversation {
  const known = conversation.chatProviders ?? (conversation.turns.length > 0 ? [UNKNOWN_CHAT_PROVIDER] : []);
  return known.includes(provider) ? conversation : { ...conversation, chatProviders: [...known, provider] };
}
export function heldOnlyWithGemini(conversation: Conversation): boolean {
  const known = conversation.chatProviders ?? [];
  return known.length > 0 && known.every((p) => p === "gemini");
}

/** an unfinished conversation with something to remember, which the user has not been asked to decide about */
export function isUnprocessedConversation(c: Conversation): boolean {
  return c.status === "active"
    && c.turns.some((t) => t.role === "user" && t.content.trim() !== "")
    && c.turns.some((t) => t.role === "ai" && !isBlankAiReply(t.content))
    && !endsWithInterruptedReply(c);
}

const ms = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };
export const recentRunCount = (state: AutoCaptureState, now: number) => state.recentRuns.filter((t) => now - ms(t) < AUTO_CAPTURE_DAY_MS).length;
export const isStopped = (state: AutoCaptureState, id: string) => (state.conversations[id]?.attempts ?? 0) >= AUTO_CAPTURE_MAX_ATTEMPTS;
const waiting = (state: AutoCaptureState, id: string, now: number) => {
  const a = state.conversations[id];
  return a?.lastKind === "wait" && now - ms(a.lastAttemptAt) < AUTO_CAPTURE_WAIT_MS;
};

/**
 * The conversations this run may try, best first. Never tried before retried, so a conversation that keeps failing does not hold back the others; oldest first
 * within each, so no conversation waits forever. There is no age limit.
 */
export function selectAutoCaptureTargets(
  conversations: Conversation[], withMemory: ReadonlySet<string>, state: AutoCaptureState, settings: AutoCaptureSettings, now: number, manual = false,
): Conversation[] {
  if (!manual && recentRunCount(state, now) >= AUTO_CAPTURE_PER_DAY) return [];
  const attempts = (c: Conversation) => state.conversations[c.id]?.attempts ?? 0;
  return conversations
    .filter((c) => isUnprocessedConversation(c) && !withMemory.has(c.id))
    .filter((c) => now - ms(c.updatedAt) >= AUTO_CAPTURE_QUIET_MS)
    .filter((c) => settings.allowOtherProviders || heldOnlyWithGemini(c))
    .filter((c) => (manual ? isStopped(state, c.id) : !isStopped(state, c.id) && !waiting(state, c.id, now)))
    .sort((a, b) => attempts(a) - attempts(b) || ms(a.updatedAt) - ms(b.updatedAt));
}

/** written before the AI call, so a stop during the call is still counted */
export function beginAutoCaptureAttempt(state: AutoCaptureState, id: string, now: number, manual = false): AutoCaptureState {
  const at = new Date(now).toISOString();
  return {
    conversations: { ...state.conversations, [id]: { attempts: (manual ? 0 : state.conversations[id]?.attempts ?? 0) + 1, lastAttemptAt: at, lastKind: "started" } },
    recentRuns: [...state.recentRuns.filter((t) => now - ms(t) < AUTO_CAPTURE_DAY_MS), at],
  };
}

/** `before` is the state from before beginAutoCaptureAttempt: a result that says nothing about the conversation does not use up an attempt */
export function finishAutoCaptureAttempt(state: AutoCaptureState, before: AutoCaptureState, id: string, result: AutoCaptureResult): AutoCaptureState {
  const conversations = { ...state.conversations };
  const current = conversations[id];
  switch (result) {
    case "saved": case "empty": case "deleted": case "already":
      delete conversations[id];
      return { ...state, conversations };
    case "all-dropped": case "http": case "save-failed":
      if (current) conversations[id] = { ...current, lastKind: "wait" };
      return { ...state, conversations };
    case "network":
      if (current) conversations[id] = { ...current, lastKind: "next-start" };
      return { ...state, conversations };
    default:   // key, changed, cancelled
      if (before.conversations[id]) conversations[id] = before.conversations[id];
      else delete conversations[id];
      return { conversations, recentRuns: before.recentRuns };
  }
}

export function classifyAutoCaptureFailure(error: unknown, cancelled: boolean): AutoCaptureResult {
  if (cancelled) return "cancelled";
  const name = (error as Error | undefined)?.name;
  if (name === "TombstonedRecordError") return "deleted";
  if (name === "CaptureRequestError") {
    const status = (error as { status?: number }).status ?? 0;
    return status === 400 || status === 401 || status === 403 ? "key" : "http";
  }
  if (name === "AbortError" || name === "TimeoutError" || error instanceof TypeError) return "network";
  return "save-failed";
}

export interface AutoCaptureSummary { waiting: number; stopped: number; needsPermission: number }
export function summarizeAutoCapture(conversations: Conversation[], withMemory: ReadonlySet<string>, state: AutoCaptureState, settings: AutoCaptureSettings): AutoCaptureSummary {
  const left = conversations.filter((c) => isUnprocessedConversation(c) && !withMemory.has(c.id));
  const allowed = left.filter((c) => settings.allowOtherProviders || heldOnlyWithGemini(c));
  return {
    waiting: allowed.filter((c) => !isStopped(state, c.id)).length,
    stopped: allowed.filter((c) => isStopped(state, c.id)).length,
    needsPermission: left.length - allowed.length,
  };
}
