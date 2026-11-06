// The real routes and the real key resolver, with a server key set. Only the Gemini SDK is fake: it records which key each request would have been charged to.
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

const SERVER_KEY = "fictional-server-key";
const USER_KEY = "fictional-user-key";
const ONLY = "X-Tsumugi-User-Key-Only";
process.env.GOOGLE_API_KEY = SERVER_KEY;

const ROOT = path.join(__dirname, "..");
const used: string[] = [];
class GoogleGenAI {
  constructor({ apiKey }: { apiKey: string }) { used.push(apiKey); }
  models = { generateContent: async () => ({ text: JSON.stringify({ memories: [], links: [] }) }) };
}
const mod = Module as unknown as {
  _load: (request: string, parent?: unknown, isMain?: boolean) => unknown;
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "@google/genai") return { GoogleGenAI, Type: new Proxy({}, { get: (_t, k) => String(k) }) };
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const keys = require(path.join(ROOT, "lib/apiKeyHeader.js")) as typeof import("./apiKeyHeader");
const route = (name: string) => require(path.join(ROOT, `app/api/${name}/route.js`)) as { POST: (r: Request) => Promise<Response> };

const MEMORY = { summary: "架空の要約", content: "架空の記憶", keywords: ["架空"], date: "2026-01-01" };
const ROUTES: Record<string, unknown> = {
  capture: { persona: "companion", turns: [{ role: "user", content: "架空の話題です", timestamp: "2026-01-01T00:00:00Z" }, { role: "ai", content: "架空の返答です。", timestamp: "2026-01-01T00:00:01Z" }], existingMemories: [], relatedMemories: [] },
  connect: { newMemory: MEMORY, candidates: [{ id: "a", date: "2026-01-01", summary: "架空", keywords: ["架空"] }] },
  prompt: MEMORY,
};
async function call(name: string, headers: Record<string, string>) {
  used.length = 0;
  const res = await route(name).POST(new Request(`http://localhost/api/${name}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(ROUTES[name]) }));
  return { status: res.status, used: [...used] };
}

test("in the app, an automatic request is built only with a usable key, and always with the mark", () => {
  for (const key of [undefined, "", "   ", "架空のキー", "key\u200b"]) {
    assert.equal(keys.isUsableUserKey(key), false);
    assert.throws(() => keys.userKeyOnlyHeaders(key), { name: "NoUserKeyError" });
  }
  assert.deepEqual(keys.userKeyOnlyHeaders(USER_KEY), { "X-Gemini-Api-Key": USER_KEY, [ONLY]: "1" });
});

for (const name of Object.keys(ROUTES)) {
  test(`${name}: marked automatic with no key, the server refuses and no provider is reached, though it has its own key`, async () => {
    assert.deepEqual(await call(name, { [ONLY]: "1" }), { status: 401, used: [] });
  });
  test(`${name}: marked automatic with a blank key, the server refuses`, async () => {
    assert.deepEqual(await call(name, { [ONLY]: "1", "X-Gemini-Api-Key": "   " }), { status: 401, used: [] });
  });
  test(`${name}: marked automatic with the user's key, only that key is used`, async () => {
    const r = await call(name, { [ONLY]: "1", "X-Gemini-Api-Key": USER_KEY });
    assert.notEqual(r.status, 401);
    assert.ok(r.used.length > 0);
    assert.deepEqual([...new Set(r.used)], [USER_KEY]);
  });
  test(`${name}: not marked, as a conversation end is, the server key still serves a device with no key`, async () => {
    const r = await call(name, {});
    assert.notEqual(r.status, 401);
    assert.deepEqual([...new Set(r.used)], [SERVER_KEY]);
  });
}
