import type { Conversation } from "./types";

/** a turn held with an AI not on record (before the record existed, or written elsewhere) */
export const UNKNOWN_CHAT_PROVIDER = "unknown";

/** Adopting a version from the Vault: which AI held the conversation, as far as this device can still tell. */
export function chatProvidersAfterAdopting(device: Pick<Conversation, "turns" | "chatProviders">, _adoptedTurns: { role: string; content: string }[]): string[] | undefined {
  return device.chatProviders;
}
