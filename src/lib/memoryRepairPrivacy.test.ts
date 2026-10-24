/**
 * Privacy guard for the PUBLIC repository: the real repair content is private data and must never be in code, tests,
 * comments, docs, workflows or any file Git could add. Also covers the private-data loader. Run: `npm run test:memory-repair`.
 * CI-safe: without the private file it still enforces the id-pattern rule and the ignore rules.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.join(__dirname, "..");
const ROOT = path.join(__dirname, "..", "..");
const priv = require(path.join(OUT, "lib/privateRepairData.js")) as typeof import("./privateRepairData");
const fx = require(path.join(OUT, "lib/memoryRepairTestWorld.js")) as typeof import("./memoryRepairTestWorld");

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
/** Everything Git could add right now: tracked files + untracked files that are NOT ignored. */
const addable = () => git("ls-files", "-co", "--exclude-standard", "-z").split("\0").filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());
const isText = (f: string) => !/\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|otf|pdf|svg|lock)$/i.test(f) && !/package-lock\.json$/.test(f);

// the real conversation / Memory ids (26-char Crockford ULIDs from the live data). Fictional ids in this repo never look like this.
const REAL_ID = /\b01M[0-9A-HJKMNP-TV-Z]{23}\b/g;
/** Already public before this work (a Reflection id quoted in a capture.ts comment on origin/main). Not repair data; listed so it can not hide new ones. */
const PRE_EXISTING_PUBLIC_IDS = new Set(["01M0Q9P2JNZYFX42RXFHF3JE2X"]);
const realIdsIn = (src: string) => (src.match(REAL_ID) ?? []).filter((id) => !PRE_EXISTING_PUBLIC_IDS.has(id));

test("loader: accepts the fictional data; rejects broken shapes with a fixed code and never echoes content", () => {
  const ok = priv.parsePrivateRepairData(JSON.stringify(fx.D));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.counts, { repair: 8, updating: 7, backfill: 9 });
  const SECRET = "ひみつの本文SECRET";
  const bad = JSON.parse(JSON.stringify(fx.D));
  bad.repair.items[0].restored.summary = ""; bad.repair.items[1].expectedBefore.content = SECRET;
  const r1 = priv.parsePrivateRepairData(JSON.stringify(bad));
  assert.equal(r1.ok, false); assert.ok(!JSON.stringify(r1).includes(SECRET));
  const bad2 = JSON.parse(JSON.stringify(fx.D)); bad2.repair.items[2].links = { x: SECRET };
  const r2 = priv.parsePrivateRepairData(JSON.stringify(bad2)); assert.deepEqual(r2, { ok: false, error: "repair.items[2]:links" });
  assert.deepEqual(priv.parsePrivateRepairData("not json " + SECRET), { ok: false, error: "not-json" });
  assert.deepEqual(priv.parsePrivateRepairData(JSON.stringify({ format: "other", schema: 1 })), { ok: false, error: "wrong-format-or-schema" });
  const dup = JSON.parse(JSON.stringify(fx.D)); dup.backfill[0].key = dup.repair.items[0].key;
  assert.equal(priv.parsePrivateRepairData(JSON.stringify(dup)).ok, false);
  const missing = JSON.parse(JSON.stringify(fx.D)); missing.repair.items[0].updatingConversationId = "nope";
  assert.deepEqual(priv.parsePrivateRepairData(JSON.stringify(missing)), { ok: false, error: "repair.items[0]:updating-missing" });
});

test("git: private data paths are ignored and nothing under them is tracked or addable", () => {
  for (const p of ["private/memory-repair-data.json", "private/anything/x.json", "backup.memory-repair-data.json", "src/lib/x.memory-repair-data.json"]) {
    assert.doesNotThrow(() => git("check-ignore", "-q", p), `${p} must be git-ignored`);
  }
  const files = addable();
  assert.deepEqual(files.filter((f) => f.startsWith("private/") || /memory-repair-data\.json$/.test(f)), [], "no private data file is addable");
});

test("public files (tracked + addable untracked) contain no real conversation / Memory id", () => {
  const offenders: string[] = [];
  for (const f of addable().filter(isText)) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    if (realIdsIn(src).length) offenders.push(f);
  }
  assert.deepEqual(offenders, [], "files that contain a real-looking id");
});

test("public files contain none of the private repair content (checked when the private file is present on this machine)", () => {
  const privateFile = path.join(ROOT, "private", "memory-repair-data.json");
  if (!fs.existsSync(privateFile)) return; // CI / fresh clone: the id-pattern test above is the guard
  const data = JSON.parse(fs.readFileSync(privateFile, "utf8")) as Record<string, unknown>;
  const needles = new Set<string>();
  const collect = (v: unknown, key?: string): void => {
    if (typeof v === "string") { if ((v.length >= 8 && !/^[\x20-\x7e]+$/.test(v)) || /^01[0-9A-Z]{24}$/.test(v) || (key && /^(memoryId|conversationId|originalConversationId|updatingConversationId)$/.test(key) && v.length >= 8)) needles.add(v); }
    else if (Array.isArray(v)) v.forEach((x) => collect(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k.length >= 20 && /^01[0-9A-Z]{24}$/.test(k)) needles.add(k); collect(x, k); }
  };
  collect(data);
  assert.ok(needles.size > 20, "the private file yields a meaningful needle set");
  let hits = 0; const files: string[] = [];
  for (const f of addable().filter(isText)) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const n of needles) if (src.includes(n)) { hits++; files.push(f); break; }
  }
  assert.deepEqual({ hits, files }, { hits: 0, files: [] }, "private content found in addable files (content intentionally not printed)");
});

test("the fictional test data is self-contained: no id of the real shape", () => {
  const text = JSON.stringify(fx.D);
  assert.deepEqual(realIdsIn(text), []);
});

test("workflow: read-only permissions, no secrets, no deploy, no command tracing, status codes only", () => {
  const wf = path.join(ROOT, ".github", "workflows", "memory-repair-verify.yml");
  assert.ok(fs.existsSync(wf), "the workflow design file exists");
  const y = fs.readFileSync(wf, "utf8");
  assert.match(y, /permissions:\s*\n\s*contents: read/);
  assert.ok(!/secrets\./.test(y) && !/vercel/i.test(y.replace(/#.*$/gm, "")), "no secrets, no Vercel step");
  assert.ok(!/set -x|--verbose|cat private|curl [^\n]*-v\b/.test(y), "no tracing / verbose output");
  assert.ok(!/\bpush:\s*\n\s*branches:\s*\[?\s*main/.test(y), "never triggered by main (production)");
  assert.match(y, /workflow_dispatch/);
  assert.ok(/%\{http_code\}/.test(y), "HTTP checks print only the status code");
});
