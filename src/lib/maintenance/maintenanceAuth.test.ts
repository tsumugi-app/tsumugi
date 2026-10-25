/**
 * Access control of the maintenance area: pure decision, the Next.js proxy itself, its matcher, and "nothing else is affected".
 * Run: `npm run test:maintenance`.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const OUT = path.join(__dirname, "..", "..");
const origResolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(OUT, request.slice(2)) : request, ...rest);
};
const auth = require(path.join(OUT, "lib/maintenance/auth.js")) as typeof import("./auth");
const basic = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`, "utf8").toString("base64");

test("disabled => 404 even for correct credentials; credentials are not even evaluated", () => {
  for (const enabled of [undefined, "", "0", "true", "yes", " 1"]) {
    const d = auth.decideMaintenanceAccess({ enabled, user: "maintenance", password: "s3cret", authorization: basic("maintenance", "s3cret") });
    assert.deepEqual(d, { action: "not-found", reason: "disabled" }, String(enabled));
  }
});

test("password not configured => 404 for everybody (no default password, empty password never matches)", () => {
  for (const password of [undefined, ""]) {
    assert.equal(auth.decideMaintenanceAccess({ enabled: "1", user: undefined, password, authorization: basic("maintenance", "") }).action, "not-found");
    assert.equal(auth.decideMaintenanceAccess({ enabled: "1", user: undefined, password, authorization: basic("maintenance", "maintenance") }).action, "not-found");
    assert.equal(auth.decideMaintenanceAccess({ enabled: "1", user: undefined, password, authorization: null }).action, "not-found");
  }
});

test("enabled + configured: correct credentials allow; everything else is a challenge", () => {
  const cfg = { enabled: "1", user: "ops", password: "p@ss:wörd" };
  assert.equal(auth.decideMaintenanceAccess({ ...cfg, authorization: basic("ops", "p@ss:wörd") }).action, "allow");
  for (const authorization of [null, "", "Bearer x", "Basic", "Basic !!!", basic("ops", "wrong"), basic("other", "p@ss:wörd"), basic("ops", ""), basic("", "p@ss:wörd"), "basic " + Buffer.from("ops:p@ss:wörd").toString("base64") + "x"]) {
    assert.equal(auth.decideMaintenanceAccess({ ...cfg, authorization }).action, "challenge", String(authorization));
  }
  assert.equal(auth.decideMaintenanceAccess({ enabled: "1", user: undefined, password: "pw", authorization: basic("maintenance", "pw") }).action, "allow", "default user name");
});

test("constant-time comparison helper and path ownership", () => {
  assert.equal(auth.safeEqual("a", "a"), true); assert.equal(auth.safeEqual("a", "b"), false); assert.equal(auth.safeEqual("a", "ab"), false); assert.equal(auth.safeEqual("", ""), true);
  for (const p of ["/maintenance", "/maintenance/repair", "/maintenance/x/y", "/_next/data/BUILD/maintenance/repair.json"]) assert.equal(auth.isMaintenancePath(p), true, p);
  for (const p of ["/", "/api/chat", "/api/capture", "/manifest.webmanifest", "/maintenanceX", "/diagnostics/android", "/_next/static/chunks/a.js", "/icons/a.png", "/history"]) assert.equal(auth.isMaintenancePath(p), false, p);
});

async function runProxy(url: string, headers: Record<string, string>, env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const k of ["MAINTENANCE_ENABLED", "MAINTENANCE_BASIC_USER", "MAINTENANCE_BASIC_PASSWORD"]) delete process.env[k];
  Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));
  try {
    const { NextRequest } = require("next/server") as typeof import("next/server");
    const { proxy } = require(path.join(OUT, "proxy.js")) as typeof import("../../proxy");
    return await proxy(new NextRequest(url, { headers }));
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}

test("proxy: 404 when disabled (authenticated or not), 404 when no password, 401 challenge, pass-through when authorised", async () => {
  const ok = { authorization: basic("maintenance", "pw-123") };
  const d = await runProxy("https://t.example/maintenance/repair", ok, { MAINTENANCE_ENABLED: "0", MAINTENANCE_BASIC_PASSWORD: "pw-123" });
  assert.equal(d.status, 404);
  const n = await runProxy("https://t.example/maintenance/repair", ok, { MAINTENANCE_ENABLED: "1" });
  assert.equal(n.status, 404);
  const c = await runProxy("https://t.example/maintenance/repair", {}, { MAINTENANCE_ENABLED: "1", MAINTENANCE_BASIC_PASSWORD: "pw-123" });
  assert.equal(c.status, 401); assert.match(c.headers.get("www-authenticate") ?? "", /^Basic realm=/); assert.equal(c.headers.get("cache-control"), "no-store");
  const bad = await runProxy("https://t.example/maintenance", { authorization: basic("maintenance", "nope") }, { MAINTENANCE_ENABLED: "1", MAINTENANCE_BASIC_PASSWORD: "pw-123" });
  assert.equal(bad.status, 401);
  const good = await runProxy("https://t.example/maintenance/repair", ok, { MAINTENANCE_ENABLED: "1", MAINTENANCE_BASIC_PASSWORD: "pw-123" });
  assert.equal(good.status, 200); assert.equal(good.headers.get("x-middleware-next"), "1"); assert.equal(good.headers.get("cache-control"), "no-store");
  for (const r of [d, n, c, bad, good]) { const all = JSON.stringify([...r.headers.entries()]) + (await r.clone().text().catch(() => "")); assert.ok(!all.includes("pw-123"), "credentials never echoed"); }
});

test("proxy: any non-maintenance path passes through untouched (no auth, no headers), with the feature disabled or enabled", async () => {
  for (const env of [{}, { MAINTENANCE_ENABLED: "1", MAINTENANCE_BASIC_PASSWORD: "pw" }]) {
    for (const p of ["/", "/api/chat", "/api/capture", "/manifest.webmanifest", "/icons/logo.png", "/_next/static/chunks/x.js", "/diagnostics/android"]) {
      const r = await runProxy("https://t.example" + p, {}, env);
      assert.equal(r.status, 200, p); assert.equal(r.headers.get("x-middleware-next"), "1", p); assert.equal(r.headers.get("www-authenticate"), null, p); assert.equal(r.headers.get("cache-control"), null, p);
    }
  }
});

test("matcher: only /maintenance and /maintenance/* (the PWA manifest, APIs, assets and pages are not matched)", () => {
  const { config } = require(path.join(OUT, "proxy.js")) as typeof import("../../proxy");
  assert.deepEqual(config.matcher, ["/maintenance", "/maintenance/:path*"]);
  // Next.js compiles matcher sources with its own bundled path-to-regexp
  const { pathToRegexp } = require("next/dist/compiled/path-to-regexp") as { pathToRegexp: (s: string) => RegExp | { regexp: RegExp } };
  const rxs = config.matcher.map((m) => { const r = pathToRegexp(m); return r instanceof RegExp ? r : r.regexp; });
  const matches = (u: string) => rxs.some((r) => r.test(u));
  for (const u of ["/maintenance", "/maintenance/repair", "/maintenance/a/b"]) assert.equal(matches(u), true, u);
  for (const u of ["/", "/api/capture", "/api/connect", "/api/chat", "/manifest.webmanifest", "/diagnostics/android", "/_next/static/x.js", "/maintenanceX", "/history", "/icons/logo.png"]) assert.equal(matches(u), false, u);
});
