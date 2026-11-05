import type { Conversation } from "./types";

/** a turn held with an AI not on record (before the record existed, or written elsewhere) */
export const UNKNOWN_CHAT_PROVIDER = "unknown";

/**
 * Adopting a version from the Vault: which AI held the conversation, as far as this device can still tell. The record stays while the words are the same. Other or more words may have
 * been held with any AI on another device, so the conversation becomes unknown, and the automatic run needs the user's permission for it. Nothing is lost from the record.
 */
export function chatProvidersAfterAdopting(device: Pick<Conversation, "turns" | "chatProviders">, adoptedTurns: { role: string; content: string }[]): string[] | undefined {
  const same = adoptedTurns.length === device.turns.length && adoptedTurns.every((turn, i) => turn.role === device.turns[i].role && turn.content === device.turns[i].content);
  if (same || device.chatProviders === undefined || device.chatProviders.includes(UNKNOWN_CHAT_PROVIDER)) return device.chatProviders;
  return [...device.chatProviders, UNKNOWN_CHAT_PROVIDER];
}
