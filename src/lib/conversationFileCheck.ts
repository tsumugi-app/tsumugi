import { conversationTurnsEqual, parseConversationMarkdown } from "./markdown";
import type { Conversation } from "./types";
import { hashVaultText, lookupVaultRegistryRecord } from "./vault";
import { withVaultSaveLock } from "./vaultSaveLock";

/**
 * "edited": the words in the Vault file are not this conversation's words, so what the app holds may be old. "same": the file is what the app last wrote, or has the same words.
 * "unknown": no way to tell (the file cannot be read, or its record is held for another reason); the file stays protected by the check before each write.
 */
export type ConversationFileState = "same" | "edited" | "unknown";

/**
 * Read only: nothing is marked, and telling the user about the edit stays with the Vault check. A Memory made from the words before an edit would not match the record, so a Capture asks this
 * before the AI call and again before saving. Inside the save lock, so a write of this conversation that is under way is not taken for an edit.
 */
export function conversationFileState(root: FileSystemDirectoryHandle, conversation: Conversation): Promise<ConversationFileState> {
  return withVaultSaveLock(async () => {
    try {
      const { entry, path } = await lookupVaultRegistryRecord(root, conversation.id);
      if (entry === undefined) return "same";
      if (path === undefined) return "unknown";
      const segments = path.split("/");
      const fileName = segments.pop() as string;
      let dir = root;
      for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
      const file = await (await dir.getFileHandle(fileName)).getFile();
      const held = entry.status !== "ok";
      if (!held && file.lastModified === entry.mtime && file.size === entry.size) return "same";
      const text = await file.text();
      if (hashVaultText(text) === entry.contentHash) return held ? "unknown" : "same";
      const parsed = parseConversationMarkdown(text);
      return parsed && conversationTurnsEqual(parsed.turns, conversation.turns) ? "same" : "edited";
    } catch {
      return "unknown";
    }
  });
}
