/* eslint-disable @typescript-eslint/no-this-alias -- handle objects need the ShadowVault instance (same pattern as the test fakes) */
/**
 * Shadow Vault（READ ONLY診断用のコピーオンライト層）。
 *
 * 実際のVaultへは「読み取り」しか行わない（`create: false`のgetterと`getFile`/`entries`だけ）。書き込みは
 * メモリ上のoverlayに記録するだけで、実Vaultには一切届かない。これにより、productionのProjection・Recoveryの
 * コードを「そのまま」実行して、書き込みを伴う判断の結果（何を書こうとするか）をデータに触れずに観測できる。
 * overlayは1回の診断の間だけ存在し、永続化しない。
 */
type WritePayload = string | Blob | ArrayBuffer | ArrayBufferView;

export interface ShadowWrite { path: string; before: string | null; after: string }

const notFound = () => new DOMException("no such entry", "NotFoundError");
const isNotFound = (e: unknown) => !!e && typeof e === "object" && (e as { name?: string }).name === "NotFoundError";
const join = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name);

async function payloadText(data: WritePayload): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  return new TextDecoder().decode(data as ArrayBuffer);
}

export class ShadowVault {
  readonly overlay = new Map<string, { content: string; mtime: number }>();
  readonly writes: ShadowWrite[] = [];
  private clock = 1;
  constructor(private readonly real: FileSystemDirectoryHandle) {}

  root(): FileSystemDirectoryHandle { return this.dir(""); }

  /** 診断のための仮想ファイルを置く（実Vaultには存在しない）。書き込みログには載せない。 */
  seed(path: string, content: string): void { this.overlay.set(path, { content, mtime: ++this.clock }); }

  private async realDir(path: string): Promise<FileSystemDirectoryHandle | null> {
    let dir = this.real;
    if (!path) return dir;
    for (const seg of path.split("/")) {
      try { dir = await dir.getDirectoryHandle(seg, { create: false }); }
      catch (e) { if (isNotFound(e) || (e as { name?: string })?.name === "TypeMismatchError") return null; throw e; }
    }
    return dir;
  }
  private async realFile(path: string): Promise<File | null> {
    const parts = path.split("/");
    const dir = await this.realDir(parts.slice(0, -1).join("/"));
    if (!dir) return null;
    try { return await (await dir.getFileHandle(parts[parts.length - 1], { create: false })).getFile(); }
    catch (e) { if (isNotFound(e) || (e as { name?: string })?.name === "TypeMismatchError") return null; throw e; }
  }
  private async dirExists(path: string): Promise<boolean> {
    for (const key of this.overlay.keys()) if (key.startsWith(`${path}/`)) return true;
    return (await this.realDir(path)) !== null;
  }
  private async fileExists(path: string): Promise<boolean> {
    return this.overlay.has(path) || (await this.realFile(path)) !== null;
  }
  async readText(path: string): Promise<string | null> {
    const o = this.overlay.get(path);
    if (o) return o.content;
    const f = await this.realFile(path);
    return f ? f.text() : null;
  }

  private dir(prefix: string): FileSystemDirectoryHandle {
    const self = this;
    const handle = {
      kind: "directory" as const,
      name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const path = join(prefix, name);
        if (options?.create || (await self.dirExists(path))) return self.dir(path);
        throw notFound();
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = join(prefix, name);
        if (options?.create || (await self.fileExists(path))) return self.file(path, name);
        throw notFound();
      },
      async removeEntry(): Promise<void> { throw new Error("shadow-vault: removeEntry is not allowed in a read-only diagnostic"); },
      async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
        const seen = new Set<string>();
        const real = await self.realDir(prefix);
        if (real) {
          for await (const [name, h] of (real as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
            seen.add(name);
            yield [name, h.kind === "directory" ? self.dir(join(prefix, name)) : self.file(join(prefix, name), name)];
          }
        }
        const base = prefix ? `${prefix}/` : "";
        for (const key of self.overlay.keys()) {
          if (!key.startsWith(base)) continue;
          const rest = key.slice(base.length), name = rest.split("/")[0];
          if (seen.has(name)) continue;
          seen.add(name);
          yield [name, rest.includes("/") ? self.dir(join(prefix, name)) : self.file(join(prefix, name), name)];
        }
      },
      [Symbol.asyncIterator]() { return handle.entries(); },
    };
    return handle as unknown as FileSystemDirectoryHandle;
  }

  private file(path: string, name: string): FileSystemFileHandle {
    const self = this;
    return {
      kind: "file",
      name,
      async getFile(): Promise<File> {
        const o = self.overlay.get(path);
        if (o) return new File([o.content], name, { lastModified: o.mtime });
        const real = await self.realFile(path);
        return real ?? new File([""], name, { lastModified: ++self.clock }); // create:trueで開いただけ（まだ中身が無い）
      },
      async createWritable() {
        let buffer = "";
        return {
          async write(data: WritePayload) { buffer += await payloadText(data); },
          async truncate() { buffer = ""; },
          async seek() { /* writeFileInDirは先頭から全文を書く */ },
          async abort() { buffer = ""; },
          async close() {
            const before = await self.readText(path);
            self.overlay.set(path, { content: buffer, mtime: ++self.clock });
            self.writes.push({ path, before, after: buffer });
          },
        };
      },
    } as unknown as FileSystemFileHandle;
  }
}
