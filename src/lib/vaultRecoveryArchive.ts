/** Append-only recovery snapshots. Current Markdown/metadata/IndexedDB are never written.
 * Caller holds world exclusive → save lock. File System Access has no exclusive-create
 * primitive: absence is checked immediately before each creation; cooperative writers
 * are serialized by those locks. External applications must not edit this private area.
 */
import { hashVaultText } from "./vault";
import { writeFileHandleContent } from "./vaultWriter";
import type { RecoveryClassification } from "./vaultRecovery";

const ARCHIVE_DIR = ".tsumugi/recovery-archive/entries";
export type RecoveryArchiveRecordType = "conversation" | "memory" | "reflection" | "source";
export interface RecoveryArchiveEntry {
  version: 1;
  archiveId: string;
  createdAt: string;
  worldVaultId: string;
  recordType: RecoveryArchiveRecordType;
  recordId: string;
  classification: RecoveryClassification;
  reasons: string[];
  /** Full canonical JSON, not a lossy Markdown projection. */
  canonicalRaw: string;
  canonicalHash: string;
  vaultPaths: string[];
  rawFileContents: Record<string, string>;
  contentHashes: Record<string, string>;
}
export interface RecoveryArchiveWriteEnv { root: FileSystemDirectoryHandle; now?: () => string }
export type RecoveryArchiveReadPathsResult =
  | { ok: true; contents: Record<string, string>; hashes: Record<string, string> }
  | { ok: false; reason: string };
export type WriteRecoveryArchiveResult = { ok: true; entry: RecoveryArchiveEntry } | { ok: false; reason: string };
export interface RecoveryArchiveExportFile { path: string; content: string }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === "string");
const pathOK = (p: string) => p.length > 0 && !p.includes("\\") && p.split("/").every(x => x && x !== "." && x !== "..");
const notFound = (e: unknown) => e instanceof DOMException && e.name === "NotFoundError";

/** Only handle resolution NotFound is absence. getFile/text NotFound remains a read failure. */
async function resolveFile(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle | null> {
  if (!pathOK(path)) throw new Error("invalid-archive-path");
  const parts = path.split("/");
  try {
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: false });
    return await dir.getFileHandle(parts[parts.length - 1], { create: false });
  } catch (e) { if (notFound(e)) return null; throw e; }
}
async function readText(root: FileSystemDirectoryHandle, path: string): Promise<string> {
  const file = await resolveFile(root, path);
  if (!file) throw new Error("archive-file-missing");
  return (await file.getFile()).text();
}
export async function readAllPathsForArchive(root: FileSystemDirectoryHandle, paths: string[]): Promise<RecoveryArchiveReadPathsResult> {
  const contents: Record<string, string> = Object.create(null);
  const hashes: Record<string, string> = Object.create(null);
  try {
    for (const path of paths) {
      // Every observed path must still be readable; disappearance is not an empty snapshot.
      contents[path] = await readText(root, path);
      hashes[path] = hashVaultText(contents[path]);
    }
    return { ok: true, contents, hashes };
  } catch { return { ok: false, reason: "path-unconfirmed" }; }
}
function newArchiveId(): string { return `${Date.now().toString(36)}-${crypto.randomUUID()}`; }
function safeName(s: string): string { return s.replace(/[^a-zA-Z0-9._-]/g, "_"); }
function entryFileName(e: Pick<RecoveryArchiveEntry, "recordType" | "recordId" | "archiveId">): string {
  return `${e.recordType}__${safeName(e.recordId)}__${safeName(e.archiveId)}.json`;
}
const classifications = new Set(["conflict", "memory-dayfile-merge-required", "unreadable / indeterminate"]);
/** Recompute hashes from archived raw data on EVERY read. No casts-as-validation. */
function parseArchiveEntry(raw: string): RecoveryArchiveEntry {
  const v: unknown = JSON.parse(raw);
  if (!object(v) || v.version !== 1 || typeof v.archiveId !== "string" || !v.archiveId ||
      typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt)) ||
      typeof v.worldVaultId !== "string" || !v.worldVaultId ||
      !["conversation", "memory", "reflection", "source"].includes(String(v.recordType)) ||
      typeof v.recordId !== "string" || !v.recordId || !classifications.has(String(v.classification)) ||
      !strings(v.reasons) || !strings(v.vaultPaths) || !v.vaultPaths.every(pathOK) ||
      new Set(v.vaultPaths).size !== v.vaultPaths.length ||
      typeof v.canonicalRaw !== "string" || typeof v.canonicalHash !== "string" ||
      !object(v.rawFileContents) || !object(v.contentHashes)) throw new Error("invalid-archive-schema");
  const canonical: unknown = JSON.parse(v.canonicalRaw);
  if (!object(canonical) || canonical.id !== v.recordId || hashVaultText(v.canonicalRaw) !== v.canonicalHash) throw new Error("invalid-archive-canonical");
  if (Object.keys(v.rawFileContents).length !== v.vaultPaths.length || Object.keys(v.contentHashes).length !== v.vaultPaths.length) throw new Error("invalid-archive-paths");
  for (const path of v.vaultPaths) {
    const text = v.rawFileContents[path];
    if (typeof text !== "string" || typeof v.contentHashes[path] !== "string" || hashVaultText(text) !== v.contentHashes[path]) throw new Error("invalid-archive-hash");
  }
  return v as unknown as RecoveryArchiveEntry;
}
async function createNewText(root: FileSystemDirectoryHandle, path: string, text: string): Promise<void> {
  // Never interpret an unreadable existing file as absent. Collisions fail closed.
  if (await resolveFile(root, path)) throw new Error("archive-destination-exists");
  const parts = path.split("/"); let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  // Recheck immediately before creation after directory resolution.
  try { await dir.getFileHandle(parts[parts.length - 1], { create: false }); }
  catch (e) {
    if (!notFound(e)) throw e;
    const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    // Existing native/OPFS Worker writer, including Safari without createWritable.
    await writeFileHandleContent(file, text);
    return;
  }
  throw new Error("archive-destination-exists");
}
export async function writeRecoveryArchiveEntry(env: RecoveryArchiveWriteEnv, input: Omit<RecoveryArchiveEntry, "version" | "archiveId" | "createdAt">): Promise<WriteRecoveryArchiveResult> {
  try {
    const entry: RecoveryArchiveEntry = { ...input, version: 1, archiveId: newArchiveId(), createdAt: (env.now ?? (() => new Date().toISOString()))() };
    const text = JSON.stringify(entry); parseArchiveEntry(text);
    const name = entryFileName(entry), temp = `${ARCHIVE_DIR}/.tmp-${name}`, final = `${ARCHIVE_DIR}/${name}`;
    if (await resolveFile(env.root, temp) || await resolveFile(env.root, final)) return { ok: false, reason: "archive-id-collision" };
    await createNewText(env.root, temp, text);
    if (await readText(env.root, temp) !== text) return { ok: false, reason: "temp-verify-failed" };
    await createNewText(env.root, final, text);
    if (await readText(env.root, final) !== text) return { ok: false, reason: "final-verify-failed" };
    // Leave temp for interrupted-write forensic recovery. It is never a resolution entry.
    return { ok: true, entry };
  } catch { return { ok: false, reason: "archive-write-or-verify-failed" }; }
}
async function archiveDirectory(root: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> {
  try { let dir = root; for (const part of ARCHIVE_DIR.split("/")) dir = await dir.getDirectoryHandle(part, { create: false }); return dir; }
  catch (e) { if (notFound(e)) return null; throw e; }
}
/** Any unreadable/invalid finalized entry prevents warning exclusion. Nothing is erased. */
export async function listRecoveryArchiveEntries(root: FileSystemDirectoryHandle): Promise<RecoveryArchiveEntry[]> {
  const dir = await archiveDirectory(root); if (!dir) return [];
  const result: RecoveryArchiveEntry[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".tmp-")) continue;
    if (handle.kind !== "file" || !name.endsWith(".json")) throw new Error("invalid-archive-entry");
    const e = parseArchiveEntry(await readText(root, `${ARCHIVE_DIR}/${name}`));
    if (entryFileName(e) !== name) throw new Error("archive-name-mismatch");
    result.push(e);
  }
  return result;
}
export async function findLatestArchiveEntry(root: FileSystemDirectoryHandle, recordType: RecoveryArchiveRecordType, recordId: string): Promise<RecoveryArchiveEntry | null> {
  const entries = (await listRecoveryArchiveEntries(root)).filter(e => e.recordType === recordType && e.recordId === recordId);
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.archiveId.localeCompare(a.archiveId));
  return entries[0] ?? null;
}
/** Export raw files (including damaged/temp snapshots), never reserialize or silently omit errors.
 * Archive failures do not abort normal Markdown export; the ZIP carries an explicit report.
 */
export async function collectRecoveryArchiveFiles(root: FileSystemDirectoryHandle): Promise<RecoveryArchiveExportFile[]> {
  const files: RecoveryArchiveExportFile[] = []; const errors: string[] = [];
  try {
    const dir = await archiveDirectory(root); if (!dir) return files;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file") { errors.push(`Unreadable archive directory: ${name}`); continue; }
      try { files.push({ path: `recovery-archive/${name}`, content: await readText(root, `${ARCHIVE_DIR}/${name}`) }); }
      catch { errors.push(`Unreadable archive file: ${name}`); }
    }
  } catch { errors.push("Recovery Archive could not be completely enumerated."); }
  if (errors.length) files.push({ path: "recovery-archive/EXPORT_ERRORS.txt", content: errors.join("\n") });
  return files;
}
