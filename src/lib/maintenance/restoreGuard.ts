/* eslint-disable @typescript-eslint/no-this-alias -- handle objects need the guard instance (same pattern as vaultGuard.ts) */
/**
 * Write guard + small file helpers for the strict restore (restoreEngine.ts).
 *
 * RestoreGuard wraps the REAL Vault directory handle and is the only handle the restore receives:
 *  - reads pass straight through;
 *  - a file may be opened for writing only if its exact path was enumerated as "to be written back" (`writable`);
 *  - a file or directory may be removed only if its exact path was enumerated as "created by the operation" (`removableFiles` /
 *    `removableDirs`); removal is never recursive;
 *  - anything else throws and is recorded in `blocked`, so an unlisted path is PREVENTED from being touched, not just reported.
 * It never logs and never keeps file content.
 */
export interface RestoreGuardPaths { writable: Set<string>; removableFiles: Set<string>; removableDirs: Set<string> }

export class RestoreGuard {
  readonly blocked: string[] = [];
  readonly written: string[] = [];
  readonly removed: string[] = [];
  private readonly dirs = new Set<string>();
  constructor(private readonly real: FileSystemDirectoryHandle, private readonly paths: RestoreGuardPaths) {
    for (const f of paths.writable) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/")); }
  }
  root(): FileSystemDirectoryHandle { return this.dir(this.real, ""); }
  private deny(kind: string, path: string): never {
    this.blocked.push(`${kind}:${path}`);
    throw new Error(`restore-guard: ${kind} of a path that is not enumerated is not allowed`);
  }
  private dir(real: FileSystemDirectoryHandle, prefix: string): FileSystemDirectoryHandle {
    const self = this;
    const handle = {
      kind: "directory" as const,
      name: real.name,
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (options?.create && !self.dirs.has(path)) {
          try { return self.dir(await real.getDirectoryHandle(name, { create: false }), path); } catch { self.deny("create-directory", path); }
        }
        return self.dir(await real.getDirectoryHandle(name, options), path);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (options?.create && !self.paths.writable.has(path)) self.deny("create-file", path);
        return self.file(await real.getFileHandle(name, options), path);
      },
      async removeEntry(name: string, options?: { recursive?: boolean }) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (options?.recursive) self.deny("remove-recursive", path);
        if (!self.paths.removableFiles.has(path) && !self.paths.removableDirs.has(path)) self.deny("remove", path);
        await real.removeEntry(name);
        self.removed.push(path);
      },
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
        if (!self.paths.writable.has(path)) self.deny("write", path);
        self.written.push(path);
        return real.createWritable(options);
      },
    } as unknown as FileSystemFileHandle;
  }
}

/** Text of a file, or null if it (or a directory on its path) does not exist. Any other failure is thrown (= "can not be identified"). */
export async function readTextOrNull(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const parts = path.split("/");
  try {
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    return await file.text();
  } catch (e) {
    if ((e as { name?: string })?.name === "NotFoundError") return null;
    throw e;
  }
}

/** Writes `content` to `path` (creating directories on the way). Through a RestoreGuard root this works only for enumerated paths. */
export async function writeText(root: FileSystemDirectoryHandle, path: string, content: string): Promise<void> {
  const parts = path.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await handle.createWritable();
  await w.write(content);
  await w.close();
}

/** Removes one file. Through a RestoreGuard root this works only for enumerated "created" paths. */
export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parts = path.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  await dir.removeEntry(parts[parts.length - 1]);
}

/** Removes one (empty) directory. Non-recursive. */
export async function removeDirectory(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parts = path.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  await dir.removeEntry(parts[parts.length - 1]);
}
