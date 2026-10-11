/**
 * Maintenance session: finds the Vault folder the app already uses, WITHOUT starting any app process (no flush, no Capture/Connect,
 * no bootstrap, no Recovery) and without creating anything: handle lookup + permission QUERY only, then the tab epoch is set exactly as
 * the app's startup does so that `withVaultWorldRead` accepts this tab. Writing permission is requested only by an explicit button.
 */
import { getActiveVaultEpoch, loadVaultHandle } from "../db";
import { getVaultBackend } from "../vault";
import { setTabVaultEpoch } from "../vaultWorldLock";

export type SessionResult =
  | { status: "ready"; handle: FileSystemDirectoryHandle; readPermission: string; writePermission: string; epoch: number }
  | { status: "unsupported-backend" | "no-handle" | "error"; detail: string };

export async function initMaintenanceSession(): Promise<SessionResult> {
  try {
    const backend = getVaultBackend();
    if (backend === null) return { status: "unsupported-backend", detail: "no Vault backend in this browser" };
    if (backend === "opfs") return { status: "unsupported-backend", detail: "OPFS Vault (Android) is out of scope: opening it creates files" };
    const handle = await loadVaultHandle();
    if (!handle) return { status: "no-handle", detail: "this browser has no stored Vault folder" };
    const q = async (mode: "read" | "readwrite") => { try { return await handle.queryPermission({ mode }); } catch { return "error"; } };
    const epoch = await getActiveVaultEpoch();
    setTabVaultEpoch(epoch);
    return { status: "ready", handle, readPermission: await q("read"), writePermission: await q("readwrite"), epoch };
  } catch (e) {
    return { status: "error", detail: (e as Error)?.name ?? "error" };
  }
}

/** Must be called from a click handler (user activation). */
export async function requestWritePermission(handle: FileSystemDirectoryHandle): Promise<string> {
  try { return await handle.requestPermission({ mode: "readwrite" }); } catch { return "error"; }
}
