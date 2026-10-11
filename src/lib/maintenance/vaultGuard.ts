/* eslint-disable @typescript-eslint/no-this-alias -- handle objects need the guard instance (same pattern as shadowVault.ts) */
/**
 * Write guard + tree snapshot for the maintenance sync (M2).
 *
 * GuardedVault wraps the REAL Vault directory handle and is the only handle the writers / projection receive during an execution:
 *  - reads pass straight through;
 *  - `getFileHandle(name, {create:true})` and `createWritable()` are allowed ONLY for the exact paths the dry run planned;
 *  - `getDirectoryHandle(name, {create:true})` is allowed only for directories that lead to a planned path;
 *  - `removeEntry` is never allowed.
 * A blocked attempt throws (the writer fails and the sync stops) and is recorded in `blocked`, so an unplanned write is PREVENTED, not
 * just reported afterwards.
 *
 * `snapshotTree` / `diffTree` give the before/after comparison of the whole folder: every file is listed with size and modification
 * time; files inside Tsumugi's own areas (`.tsumugi`, `Memories`, `Conversations`, `Sources`) are also content-hashed.
 */
import { sha256Hex } from "./hash";

export const TSUMUGI_AREAS = [".tsumugi", "Memories", "Conversations", "Sources"];

export class GuardedVault {
  readonly blocked: string[] = [];
  readonly writes: string[] = [];
  private readonly dirs = new Set<string>();
  constructor(private readonly real: FileSystemDirectoryHandle, private readonly allowedFiles: Set<string>) {
    for (const f of allowedFiles) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/")); }
  }
  root(): FileSystemDirectoryHandle { return this.dir(this.real, ""); }
  private deny(kind: string, path: string): never {
    this.blocked.push(`${kind}:${path}`);
    throw new Error(`guarded-vault: ${kind} of an unplanned path is not allowed (${path})`);
  }
  private dir(real: FileSystemDirectoryHandle, prefix: string): FileSystemDirectoryHandle {
    const self = this;
    const handle = {
      kind: "directory" as const,
      name: real.name,
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (options?.create && !self.dirs.has(path)) {
          // creating a directory is only legitimate when it already exists or leads to a planned file
          try { return self.dir(await real.getDirectoryHandle(name, { create: false }), path); } catch { self.deny("create-directory", path); }
        }
        return self.dir(await real.getDirectoryHandle(name, options), path);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (options?.create && !self.allowedFiles.has(path)) {
          // opening an existing file "for create" is harmless only if it is a planned path; otherwise it is a write intent
          self.deny("create-file", path);
        }
        return self.file(await real.getFileHandle(name, options), path);
      },
      async removeEntry(name: string) { self.deny("remove", prefix ? `${prefix}/${name}` : name); },
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        for await (const [n, h] of (real as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          const path = prefix ? `${prefix}/${n}` : n;
          yield [n, h.kind === "directory" ? self.dir(h as FileSystemDirectoryHandle, path) : self.file(h as FileSystemFileHandle, path)];
        }
      },
      [Symbol.asyncIterator]() { return handle.entries(); },
    };
    return handle as unknown as FileSystemDirectoryHandle;
  }
  private file(real: FileSystemFileHandle, path: string): FileSystemFileHandle {
    const self = this;
    return {
      kind: "file",
      name: real.name,
      getFile: () => real.getFile(),
      async createWritable(options?: FileSystemCreateWritableOptions) {
        if (!self.allowedFiles.has(path)) self.deny("write", path);
        self.writes.push(path);
        return real.createWritable(options);
      },
    } as unknown as FileSystemFileHandle;
  }
}

export interface TreeEntry { kind: "file" | "directory"; size: number; modified: number; hash: string | null }
export type TreeSnapshot = Map<string, TreeEntry>;

const inTsumugiArea = (path: string) => TSUMUGI_AREAS.some((a) => path === a || path.startsWith(a + "/"));

/** Lists every file and directory under `root` (read-only). Tsumugi-owned files are content-hashed; others by size + mtime only. */
export async function snapshotTree(root: FileSystemDirectoryHandle): Promise<TreeSnapshot> {
  const out: TreeSnapshot = new Map();
  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") { out.set(path, { kind: "directory", size: 0, modified: 0, hash: null }); await walk(handle as FileSystemDirectoryHandle, path); continue; }
      const file = await (handle as FileSystemFileHandle).getFile();
      out.set(path, { kind: "file", size: file.size, modified: file.lastModified, hash: inTsumugiArea(path) ? await sha256Hex(await file.text()) : null });
    }
  }
  await walk(root, "");
  return out;
}

export interface TreeDiff { created: string[]; changed: string[]; deleted: string[]; plannedWritten: string[]; plannedUntouched: string[] }
/** Everything that differs between two snapshots, split into "planned" (allowed to change) and unexpected. */
export function diffTree(before: TreeSnapshot, after: TreeSnapshot, planned: Set<string>): { unexpected: { created: string[]; changed: string[]; deleted: string[] }; planned: TreeDiff } {
  const created: string[] = [], changed: string[] = [], deleted: string[] = [];
  for (const [p, a] of after) {
    const b = before.get(p);
    if (!b) { created.push(p); continue; }
    if (a.kind !== b.kind || a.size !== b.size || a.modified !== b.modified || a.hash !== b.hash) changed.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  const isAncestorOfPlanned = (dir: string) => [...planned].some((f) => f.startsWith(dir + "/"));
  const unexpected = {
    created: created.filter((p) => !planned.has(p) && !(after.get(p)!.kind === "directory" && isAncestorOfPlanned(p))),
    changed: changed.filter((p) => !planned.has(p)),
    deleted,
  };
  const plannedWritten = [...planned].filter((p) => created.includes(p) || changed.includes(p));
  return { unexpected, planned: { created, changed, deleted, plannedWritten, plannedUntouched: [...planned].filter((p) => !plannedWritten.includes(p)) } };
}
