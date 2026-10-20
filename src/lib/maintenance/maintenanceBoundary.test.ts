/**
 * Structural guarantees: the maintenance area cannot reach AI / Capture / Connect / network code, its credentials never reach client
 * code, nothing runs on page load, and the normal app (ChatScreen, startup, APIs, PWA) is untouched. Run: `npm run test:maintenance`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.join(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "src");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (fs.existsSync(base + ext)) return base + ext;
  return null;
}
function reachable(entries: string[]): { files: Set<string>; externals: Set<string> } {
  const seen = new Set<string>(), externals = new Set<string>(), stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f);
    for (const m of strip(fs.readFileSync(f, "utf8")).matchAll(/(?:import|export)(?!\s+type\b)\s[^;]*?from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)|require\(["']([^"']+)["']\)/g)) {
      const spec = (m[1] ?? m[2] ?? m[3]) as string; const r = resolveImport(f, spec);
      if (r) stack.push(r); else externals.add(spec);
    }
  }
  return { files: new Set([...seen].map((p) => path.relative(SRC, p))), externals };
}
const maintDir = path.join(SRC, "lib", "maintenance");
const maintSources = fs.readdirSync(maintDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(maintDir, f));
const PANEL = path.join(SRC, "components", "maintenance", "MaintenancePanel.tsx");
const PAGE = path.join(SRC, "app", "maintenance", "repair", "page.tsx");
const PROXY = path.join(SRC, "proxy.ts");
const FORBIDDEN = ["lib/capture.ts", "lib/connect.ts", "lib/retrieval.ts", "lib/memorySearch.ts", "lib/memoryAnalytics.ts", "lib/topPrompt.ts", "lib/reflection.ts", "lib/semanticInterpretation.ts", "lib/factExtraction.ts", "lib/changeDetection.ts",
  "components/ChatScreen.tsx", "components/WipeGate.tsx", "components/HistoryPanel.tsx", "components/SettingsPanel.tsx", "app/page.tsx"];

test("no path from the maintenance area (proxy, page, panel, library) to AI / Capture / Connect / ChatScreen / API routes", () => {
  const { files, externals } = reachable([PROXY, PAGE, PANEL, ...maintSources]);
  for (const f of FORBIDDEN) assert.ok(!files.has(f), `must not reach ${f}`);
  // the repair runner / DB environment (which can write) are reachable ONLY through the single-item repair session
  const walkSrc = (d: string, out: string[] = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkSrc(p, out); else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p); } return out; };
  for (const [mod, allowed] of [["memoryRepairRunner", ["lib/maintenance/repairSession.ts", "lib/memoryRepairDbEnv.ts"]], ["memoryRepairDbEnv", ["lib/maintenance/repairSession.ts"]]] as const) {
    const importers = walkSrc(SRC).filter((p) => !p.endsWith(`${mod}.ts`)).filter((p) => new RegExp(`/${mod}["']`).test(fs.readFileSync(p, "utf8"))).map((p) => path.relative(SRC, p)).sort();
    assert.deepEqual(importers, [...allowed].sort(), `${mod} importers`);
  }
  assert.ok(files.has("lib/memoryRepairPrecheck.ts") && files.has("lib/maintenance/precheckScope.ts"));
  // (type-only imports are erased at compile time and are not followed)
  for (const f of files) { assert.ok(!f.startsWith("lib/ai/"), f); assert.ok(!f.startsWith("app/api/"), f); }
  const ok = (e: string) => ["react", "next/server", "next/navigation", "next/headers", "next", "ulid", "idb"].includes(e) || e.startsWith("next/");
  for (const e of externals) assert.ok(ok(e), "unexpected external dependency: " + e);
});

test("no network / persistence / dynamic-code token anywhere in the maintenance sources", () => {
  const BAN = /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|document\.cookie|\beval\(|new Function|\/api\//;
  for (const f of [PROXY, PAGE, PANEL, ...maintSources]) assert.equal(BAN.test(strip(fs.readFileSync(f, "utf8"))), false, path.relative(SRC, f));
});

test("credentials: read only by server code; the client panel graph never reaches auth.ts or process.env", () => {
  const client = reachable([PANEL]);
  assert.ok(!client.files.has("lib/maintenance/auth.ts"), "client bundle must not contain the access-decision module");
  assert.ok(!client.files.has("proxy.ts"));
  for (const f of client.files) {
    const src = strip(fs.readFileSync(path.join(SRC, f), "utf8"));
    assert.ok(!/MAINTENANCE_BASIC_|MAINTENANCE_ENABLED/.test(src), `${f} must not reference the credential variables`);
  }
  const panel = strip(fs.readFileSync(PANEL, "utf8"));
  assert.ok(!/process\.env/.test(panel));
  // the variables are only ever read in auth.ts (server side)
  const readers = new Set<string>();
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && /MAINTENANCE_BASIC_PASSWORD/.test(strip(fs.readFileSync(p, "utf8")))) readers.add(path.relative(SRC, p)); } };
  walk(SRC);
  assert.deepEqual([...readers], ["lib/maintenance/auth.ts"]);
});

test("nothing runs on load: the panel has no effect hook and every action sits behind a handler; the page gates server-side and mounts no app shell", () => {
  const panel = strip(fs.readFileSync(PANEL, "utf8"));
  assert.ok(!/useEffect|useLayoutEffect/.test(panel));
  assert.ok(/"use client"/.test(fs.readFileSync(PANEL, "utf8")));
  const page = strip(fs.readFileSync(PAGE, "utf8"));
  assert.ok(/decideMaintenanceAccess/.test(page) && /notFound\(\)/.test(page) && /force-dynamic/.test(page));
  assert.ok(!/ChatScreen|WipeGate/.test(page));
  assert.ok(page.indexOf("decideMaintenanceAccess") < page.indexOf("<MaintenancePanel"));
});

/** This one test compares the working tree with HEAD through git. A Vercel build has no usable git history, so it is skipped THERE only
 *  (`VERCEL` is set by Vercel); the same comparison is done by hand before a deploy (see the pre-deploy diff check). */
const ON_VERCEL = !!process.env.VERCEL;
test("normal operation is untouched: ChatScreen, startup, layout, API routes, PWA manifest and next.config are not modified; vault.ts only gained the opt-in skipLedger option", { skip: ON_VERCEL ? "no git history in a Vercel build" : false }, () => {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" });
  const changed = git("diff", "--name-only", "HEAD").split("\n").filter(Boolean);
  const untouchable = ["src/components/ChatScreen.tsx", "src/app/page.tsx", "src/app/layout.tsx", "src/app/manifest.ts", "next.config.ts", "src/lib/capture.ts", "src/lib/connect.ts", "src/lib/productionBootstrap.ts", "src/lib/saveFoundationBootstrap.ts", "src/lib/vaultProjection.ts"];
  for (const f of untouchable) assert.ok(!changed.includes(f), `${f} must not be modified`);
  assert.ok(!changed.some((f) => f.startsWith("src/app/api/")), "API routes must not be modified");
  const vaultDiff = git("diff", "-U0", "HEAD", "--", "src/lib/vault.ts").split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  assert.ok(vaultDiff.length > 0);
  for (const l of vaultDiff) assert.ok(/skipLedger|markVaultSynced|^\+\s*(\/\*\*|\*|\*\/)|^\+\s*$/.test(l) || /^-\s+await markVaultSynced/.test(l) || /^\+\s*(\/\/|\*)/.test(l), "unexpected vault.ts change: " + l);
});
