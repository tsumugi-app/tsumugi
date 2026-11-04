import { hashVaultText, lookupVaultRegistryRecord } from "./vault";

/**
 * Whether this conversation's Vault file is still what the app last wrote, read only. An edit from outside is not yet in the stored conversation, so an automatic Capture would
 * make a Memory from the words before it. Nothing is marked here: telling the user about the edit stays with the Vault check. No record yet means there is no file to differ.
 */
export async function vaultConversationFileUnchanged(root: FileSystemDirectoryHandle, conversationId: string): Promise<boolean> {
  try {
    const { entry, path } = await lookupVaultRegistryRecord(root, conversationId);
    if (entry === undefined) return true;
    if (entry.status !== "ok" || path === undefined) return false;
    const segments = path.split("/");
    const fileName = segments.pop() as string;
    let dir = root;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    const file = await (await dir.getFileHandle(fileName)).getFile();
    if (file.lastModified === entry.mtime && file.size === entry.size) return true;
    return hashVaultText(await file.text()) === entry.contentHash;
  } catch {
    return false;
  }
}
