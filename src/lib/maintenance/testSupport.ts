/** Test-only support: an in-memory Vault with failure / interference hooks and a Web Locks fake (shared + exclusive, FIFO, abortable). */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-this-alias */
export class FakeVault {
  files = new Map<string, { content: string; mtime: number }>(); clock = 1; writeCount = 0;
  writeShouldFail = new Set<string>();
  /** fail the k-th write (1-based, counted from now) to a path */
  failNth = new Map<string, number>(); private nth = new Map<string, number>();
  failNextWrites(path: string, k: number) { this.failNth.set(path, (this.nth.get(path) ?? 0) + k); }
  /** called after every real write, e.g. to simulate an external process touching other files */
  afterWrite: ((path: string) => void) | null = null;
  perm = { read: "granted", readwrite: "granted" };
  root(): any { return Object.assign(this.dir(""), { queryPermission: async (o: { mode: "read" | "readwrite" }) => this.perm[o.mode], requestPermission: async (o: { mode: "read" | "readwrite" }) => this.perm[o.mode] }); }
  private dir(prefix: string): any {
    const self = this;
    return { kind: "directory", name: prefix.split("/").pop() ?? "",
      async getDirectoryHandle(name: string, o?: { create?: boolean }) { const p = prefix ? `${prefix}/${name}` : name; const has = [...self.files.keys()].some((k) => k.startsWith(p + "/")); if (!has && !o?.create) throw new DOMException("no such directory", "NotFoundError"); return self.dir(p); },
      async getFileHandle(name: string, o?: { create?: boolean }) { const p = prefix ? `${prefix}/${name}` : name; if (!self.files.has(p) && !o?.create) throw new DOMException("no such file", "NotFoundError"); return self.file(p); },
      async *entries() { const ch = new Map<string, string>(); for (const p of self.files.keys()) { if (prefix && !p.startsWith(prefix + "/")) continue; const rel = prefix ? p.slice(prefix.length + 1) : p; ch.set(rel.split("/")[0], rel.includes("/") ? "directory" : "file"); } for (const [n, k] of ch) { const cp = prefix ? `${prefix}/${n}` : n; yield [n, k === "directory" ? self.dir(cp) : self.file(cp)]; } },
      async removeEntry(name: string) { self.files.delete(prefix ? `${prefix}/${name}` : name); } };
  }
  private file(p: string): any {
    const self = this;
    return { kind: "file", name: p.split("/").pop(),
      async getFile() { const f = self.files.get(p); if (!f) throw new DOMException("no such file", "NotFoundError"); return new File([f.content], p.split("/").pop() as string, { lastModified: f.mtime }); },
      async createWritable() { let pending = ""; return { async write(c: any) { pending = typeof c === "string" ? c : String(c); }, async truncate() { pending = ""; }, async seek() { /* full rewrite */ }, async abort() { /* no-op */ },
        async close() {
          const n = (self.nth.get(p) ?? 0) + 1; self.nth.set(p, n);
          if (self.writeShouldFail.has(p) || self.failNth.get(p) === n) throw new Error("simulated write failure");
          self.writeCount++; self.clock++; self.files.set(p, { content: pending, mtime: self.clock }); self.afterWrite?.(p);
        } }; } };
  }
  put(p: string, c: string) { this.clock++; this.files.set(p, { content: c, mtime: this.clock }); }
  snapshot(): Record<string, string> { return Object.fromEntries([...this.files].map(([p, f]) => [p, f.content])); }
  copy(): FakeVault { const v = new FakeVault(); for (const [p, f] of this.files) v.put(p, f.content); return v; }
}

interface LockWaiter { mode: "shared" | "exclusive"; grant: () => void }
class LockState { readers = 0; writer = false; queue: LockWaiter[] = []; }
export class FakeLockManager {
  private states = new Map<string, LockState>();
  private state(name: string) { let s = this.states.get(name); if (!s) { s = new LockState(); this.states.set(name, s); } return s; }
  private pump(s: LockState) {
    while (s.queue.length) {
      const w = s.queue[0];
      const ok = w.mode === "exclusive" ? s.readers === 0 && !s.writer : !s.writer;
      if (!ok) return;
      s.queue.shift(); if (w.mode === "exclusive") s.writer = true; else s.readers++; w.grant();
    }
  }
  async request(name: string, a: any, b?: any): Promise<any> {
    const opts = typeof a === "function" ? {} : a; const cb = typeof a === "function" ? a : b;
    const mode: "shared" | "exclusive" = opts.mode === "shared" ? "shared" : "exclusive"; const signal: AbortSignal | undefined = opts.signal;
    const s = this.state(name);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const w: LockWaiter = { mode, grant: () => { signal?.removeEventListener("abort", onAbort); resolve(); } };
      const onAbort = () => { const i = s.queue.indexOf(w); if (i >= 0) { s.queue.splice(i, 1); reject(new DOMException("aborted", "AbortError")); } };
      signal?.addEventListener("abort", onAbort);
      s.queue.push(w); this.pump(s);
    });
    try { return await cb({ name, mode }); }
    finally { if (mode === "exclusive") s.writer = false; else s.readers--; this.pump(s); }
  }
}
export function installFakeLocks(): FakeLockManager {
  const locks = new FakeLockManager();
  Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true, writable: true });
  return locks;
}
