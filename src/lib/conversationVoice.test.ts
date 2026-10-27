/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Conversation voice（意見・気づき・記憶の使い方の指示）のテスト。プロンプトの中身ではなく、組み込まれ方と安全条件を確認する：
 * 本番ビルドは常に"improved"（リクエストで変えられない）、legacyは従来とバイト単位で同じ、記録モードの優先、thinking budgetは変えない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
const rec: { systemInstruction: string; thinkingBudget?: number } = { systemInstruction: "" };
const fakeProvider = {
  async generateStream(req: { systemInstruction?: string; providerOptions?: { gemini?: { thinkingBudget?: number } } }) {
    rec.systemInstruction = req.systemInstruction ?? "";
    rec.thinkingBudget = req.providerOptions?.gemini?.thinkingBudget;
    return (async function* () { yield { text: "ok", finishReason: "stop" as const }; })();
  },
};
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveProviderForFeature: () => "gemini", resolveRequestedProvider: () => undefined },
  "./db": { getAllMemoryObjects: async () => [], getAllConversations: async () => [], getMemoryObject: async () => undefined },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn() },
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown; _resolveFilename: (request: string, ...rest: unknown[]) => string };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if (request === "@/lib/ai/resolve") return stubs[request];
  if ((parent?.filename?.startsWith(ROOT) ?? false) && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const voice = require(path.join(ROOT, "lib/conversationVoice.js")) as typeof import("./conversationVoice");
const chatRoute = require(path.join(ROOT, "app/api/chat/route.js")) as { POST: (req: Request) => Promise<Response> };

async function call(body: Record<string, unknown>) {
  const res = await chatRoute.POST(new Request("http://x/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  await res.text();
  return { ...rec };
}
const T = "2026-10-27T03:00:00.000Z";
const turn = (content: string) => ({ persona: "analyst", turns: [{ role: "user", content, timestamp: T }] });

test("production build: always the improved prompt, the request field cannot change it, thinking budget unchanged", async () => {
  const prev = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    const a = await call({ ...turn("どう思う？"), evalVariant: "legacy" });
    assert.ok(a.systemInstruction.includes("## 会話の進め方"), "improved even though legacy was requested");
    assert.ok(a.systemInstruction.includes(voice.ANALYST_PERSONA_PROMPT));
    assert.equal(a.thinkingBudget, 128, "short turn without context: the thinking budget is not changed");
  } finally { if (prev === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prev; }
});

test("legacy variant (Preview comparison only) is the previous prompt byte for byte", async () => {
  const legacy = await call({ ...turn("どう思う？"), evalVariant: "legacy" });
  assert.ok(!legacy.systemInstruction.includes("## 会話の進め方"));
  assert.ok(!legacy.systemInstruction.includes(voice.EVIDENCE_TOPIC_REFERENCE_NOTE.trim()));
  assert.ok(legacy.systemInstruction.includes("相談やアイデア出しでは、必要に応じて自分の考えや意見も返してください。"));
  const improved = await call({ ...turn("どう思う？"), evalVariant: "improved" });
  assert.ok(improved.systemInstruction.includes(voice.CONVERSATION_VOICE_SECTION) && improved.systemInstruction.includes(voice.EVIDENCE_TOPIC_REFERENCE_NOTE));
});

test("the voice section defers to record mode, and keeps the evidence rules (facts vs views)", () => {
  assert.ok(voice.CONVERSATION_VOICE_SECTION.includes("記録モードには適用しない"));
  assert.ok(voice.CONVERSATION_VOICE_SECTION.includes("ユーザーが話していない出来事や心理を事実として述べない"));
  assert.ok(!/一つだけ|1つだけ/.test(voice.CONVERSATION_VOICE_SECTION + voice.ANALYST_MEMORY_USE_NOTE), "no fixed number of Memories");
  assert.ok(voice.CONVERSATION_VOICE_SECTION.includes("毎回分析や仮説を出さなくてよい"));
});

test("the thinking budget is not changed by the voice (both variants)", async () => {
  for (const evalVariant of ["legacy", "improved"]) {
    assert.equal((await call({ ...turn("どう思う？"), evalVariant })).thinkingBudget, 128, evalVariant);
    assert.equal((await call({ ...turn("今日は走って気持ちよかった"), evalVariant })).thinkingBudget, 128, evalVariant);
  }
});

test("no invented past, grounded hypotheses only, a choice when asked to choose", () => {
  const all = voice.CONVERSATION_VOICE_SECTION + voice.EVIDENCE_TOPIC_REFERENCE_NOTE;
  assert.ok(voice.CONVERSATION_VOICE_SECTION.includes("それ以外の過去（「以前は〜だった」「前にも〜していた」など）を作らない"));
  assert.ok(voice.EVIDENCE_TOPIC_REFERENCE_NOTE.includes("記録や会話に無い過去の出来事・様子を作ること"));
  assert.ok(voice.CONVERSATION_VOICE_SECTION.includes("裏付けがある仮説にとどめ") && voice.CONVERSATION_VOICE_SECTION.includes("断定しない"));
  assert.ok(voice.CONVERSATION_VOICE_SECTION.includes("一つを選んで理由を言う"));
  assert.ok(!/仮説を(言わない|述べない|出さない)/.test(all), "hypotheses are not banned outright");
});
