/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Capture回帰テスト（M1：別Conversationの既存Memoryを破壊しない／Evidence Boundary retry）。
 *
 * 実行方法（Node組み込みのtest runnerのみ。新しい依存は無い。外部AI APIも呼ばない）：
 *   npm run test:capture
 * （tsconfig.test.jsonでCapture本体とこのファイルを`.test-out/`へコンパイルし、`node --test`で実行する）
 *
 * 守りたい不変条件：
 * - 別Conversation由来のMemory（relatedMemories）は、topic判定・topicId継承の参考情報にしか使わず、
 *   content/summary/keywords/typesを書き換えない。LLMが誤ってそのidをexistingMemoryIdに返しても同じ。
 * - 別Conversationで新しく得た情報・状態変化は、常に新しいMemoryとして保存する（Current State判定はしない）。
 * - Evidence Boundary（evidenceQuotesの逐語検証）は緩めない。retryは「提案あり・採用0・not-found」の
 *   ときだけ最大1回で、retry結果も同じ検証を通ったものだけを採用する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

type Json = Record<string, unknown>;
interface StoredMemory extends Json {
  id: string;
}
interface CaptureResult {
  conversation: { memoryObjectIds: string[] };
  memoryObjects: StoredMemory[];
}
interface ProviderRequest {
  systemInstruction: string;
  userContent: string;
  schema: unknown;
}
type Step = { memories: Json[] } | { text: string } | { throw: true };

// コンパイル後の配置：.test-out/lib/capture.regression.test.js → ROOTは.test-out
const ROOT = path.join(__dirname, "..");
const rec: { script: Step[] | null; fixed: Json[]; allMemories: Json[]; requests: ProviderRequest[] } = {
  script: null,
  fixed: [],
  allMemories: [],
  requests: [],
};

const fakeProvider = {
  async generateStructured(req: ProviderRequest) {
    rec.requests.push(req);
    if (rec.script) {
      const step: Step = rec.script.length > 0 ? rec.script.shift()! : { throw: true }; // 台本を超える呼び出し（＝想定外の3回目）は失敗させる
      if ("throw" in step) throw new Error("scripted provider failure");
      if ("text" in step) return { text: step.text };
      return { text: JSON.stringify({ memories: step.memories }) };
    }
    return { text: JSON.stringify({ memories: rec.fixed }) };
  },
};
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveProviderForFeature: () => "gemini" },
  "./db": new Proxy({ loadApiKey: async () => "k", getAllMemoryObjects: async () => rec.allMemories }, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : async () => undefined) }),
  "./vault": { isReflectionSummary: (m: { metadata: { source: string } }) => m.metadata.source === "system-generated" },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn() },
  "./debugTimingLog": { logTimingEvent: () => {} },
};
const mod = Module as unknown as {
  _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown;
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  const inTree = parent?.filename?.startsWith(ROOT) ?? false;
  if (request === "@/lib/ai/resolve") return stubs[request];
  if (inTree && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const captureRoute = require(path.join(ROOT, "app/api/capture/route.js")) as { POST: (req: Request) => Promise<Response> };
const captureClient = require(path.join(ROOT, "lib/capture.js")) as { captureConversation: (conv: unknown, existing: unknown[]) => Promise<CaptureResult> };

// ---- 補助 ----
const T0 = "2026-09-25T10:00:00.000Z";
const user = (content: string) => ({ role: "user" as const, content, timestamp: T0 });
const ai = (content: string) => ({ role: "ai" as const, content, timestamp: T0 });
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

/** 過去のConversationから生成済みで、IndexedDBに存在するMemory */
function pastMemory(o: { id?: string; content: string; summary: string; keywords: string[]; topicId?: string; conversationId?: string }): StoredMemory {
  const t = "2026-09-21T16:42:43.000Z";
  return {
    id: o.id ?? "01AAAAAAAAAAAAAAAAAAAAAAAA", date: t, types: ["person"], conversationId: o.conversationId ?? "CONV-A",
    content: o.content, summary: o.summary, keywords: o.keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    ...(o.topicId ? { topicId: o.topicId } : {}), createdAt: t, updatedAt: t,
    metadata: { id: "meta", schemaVersion: "0.1", source: "ai-capture", aiProvider: "gemini", confidence: 1, createdAt: t, updatedAt: t },
  };
}
const BASE = { types: ["person", "emotion"], confidence: 0.9, eventTimeSource: "none" };

interface RunOptions {
  allMemories?: Json[];
  existing?: Json[];
  script?: Step[];
}
async function runCapture(turns: unknown[], llmMemories: Json[] | null, opts: RunOptions = {}) {
  rec.allMemories = opts.allMemories ?? [];
  rec.fixed = llmMemories ?? [];
  rec.script = opts.script ? [...opts.script] : null;
  rec.requests = [];
  const seen = { retryHeader: null as string | null };
  const prevFetch = global.fetch;
  global.fetch = (async (url: string, init: RequestInit) => {
    const res = await captureRoute.POST(new Request("http://x" + url, init));
    seen.retryHeader = res.headers.get("X-Tsumugi-Evidence-Retry");
    return res;
  }) as typeof fetch;
  try {
    const conv = { id: "CONV-B", persona: "analyst", startedAt: T0, status: "active", createdAt: T0, updatedAt: T0, memoryObjectIds: [], turns, metadata: { id: "x", schemaVersion: "0.1", source: "user", createdAt: T0, updatedAt: T0 } };
    const out = await captureClient.captureConversation(conv, opts.existing ?? []);
    return { out, seen, calls: rec.requests.length, firstReq: rec.requests[0] };
  } finally {
    global.fetch = prevFetch;
    rec.script = null;
  }
}

// ===========================================================================
// M1：別Conversationの既存Memoryを破壊しない
// ===========================================================================

test("M1: 別Conversation由来のMemoryは、LLMがexistingMemoryIdで指してもUPDATEされない。新しい情報は新規Memoryとして保存される", async () => {
  const A = pastMemory({ content: "7月に、さきさんから「あなたには私の機嫌は関係ない」と言われた。", summary: "さきさんから「機嫌は関係ない」と言われた", keywords: ["さきさん", "機嫌"] });
  const before = clone(A);
  const { out, firstReq } = await runCapture(
    [user("まだ修復したいとは思っているけど、向こうはそれを望んでない可能性もある。さきさんとは…"), ai("そうなんですね")],
    [{ ...BASE, existingMemoryId: A.id, topicDecision: "newTopic", summary: "さきさんとの関係を修復したいが、相手は望んでいないかもしれない", content: "修復したい気持ちがあるが、相手が望んでいない可能性を感じている。", keywords: ["さきさん", "修復"], evidenceQuotes: ["まだ修復したいとは思っているけど、向こうはそれを望んでない可能性もある。"] }],
    { allMemories: [A] }
  );
  assert.deepEqual(A, before, "過去Memoryのcontent/summary/keywords/typesが不変");
  assert.equal(out.memoryObjects.length, 1);
  assert.notEqual(out.memoryObjects[0].id, A.id);
  assert.ok(!out.memoryObjects.some((m) => m.id === A.id), "保存対象に過去Memoryが含まれない");
  assert.equal(out.memoryObjects[0].conversationId, "CONV-B");
  assert.deepEqual(out.conversation.memoryObjectIds, [out.memoryObjects[0].id]);
  assert.ok(firstReq.userContent.includes(A.id), "relatedMemoryは参考情報としてLLMに渡っている");
});

test("M1: 同じ人物・同じ話題の関係変化（線を引かれた／自分も引いた）も、UPDATEせず新規Memoryとして保存される", async () => {
  const A = pastMemory({ content: "さきさんとは距離を置いている。", summary: "さきさんとは距離を置いている", keywords: ["さきさん", "距離"] });
  const before = clone(A);
  const { out } = await runCapture(
    [user("さきさんに、線を引かれた。そこから自分が耐えられなくなって引いていった。"), ai("そうだったんですね")],
    [{ ...BASE, existingMemoryId: A.id, topicDecision: "sameTopic", sameTopicMemoryId: A.id, summary: "さきさんに線を引かれ、耐えられず自分も距離を取った", content: "さきさんから線を引かれ、それに耐えられなくなって自分も距離を取った。", keywords: ["さきさん", "距離"], evidenceQuotes: ["さきさんに、線を引かれた。そこから自分が耐えられなくなって引いていった。"] }],
    { allMemories: [A] }
  );
  assert.deepEqual(A, before);
  assert.equal(out.memoryObjects.length, 1);
  assert.notEqual(out.memoryObjects[0].id, A.id);
  assert.match(String(out.memoryObjects[0].content), /線を引かれ/);
});

test("M1: Current Stateが変化しても、古いMemoryを上書きしない（両方残る。Current Stateの判定はしない）", async () => {
  const A = pastMemory({ content: "さきさんとの関係を修復したい。", summary: "さきさんとの関係を修復したい", keywords: ["さきさん", "修復"] });
  const before = clone(A);
  const { out } = await runCapture(
    [user("さきさんのことは、もう修復したいとは思っていない。"), ai("そうなんですね")],
    [{ ...BASE, existingMemoryId: A.id, topicDecision: "sameTopic", sameTopicMemoryId: A.id, summary: "さきさんとの関係は、もう修復したいとは思っていない", content: "さきさんとの関係を、もう修復したいとは思っていない。", keywords: ["さきさん", "修復"], evidenceQuotes: ["もう修復したいとは思っていない"] }],
    { allMemories: [A] }
  );
  assert.deepEqual(A, before, "古い『修復したい』は不変");
  assert.equal(out.memoryObjects.length, 1);
  assert.equal(out.memoryObjects[0].summary, "さきさんとの関係は、もう修復したいとは思っていない");
  assert.notEqual(out.memoryObjects[0].id, A.id);
});

test("M1: 同じtopicの続きは、新規Memoryのまま既存のtopicIdを継承する（既存Memory側へは書き戻さない）", async () => {
  const withTopic = pastMemory({ content: "さきさんとは距離を置いている。", summary: "さきさんとは距離を置いている", keywords: ["さきさん", "距離"], topicId: "TOPIC-SAKI" });
  const noTopic = pastMemory({ id: "01BBBBBBBBBBBBBBBBBBBBBBBB", content: "さきさんの話。", summary: "さきさんの話", keywords: ["さきさん", "話"] });
  const beforeWith = clone(withTopic);
  const beforeNo = clone(noTopic);
  const llm = (extra: Json) => ({ ...BASE, summary: "線を引かれた", content: "さきさんに線を引かれた。", keywords: ["さきさん"], evidenceQuotes: ["さきさんに、線を引かれた。"], ...extra });
  const turns = [user("さきさんに、線を引かれた。"), ai("…")];

  // sameTopic＋sameTopicMemoryId
  const a = await runCapture(turns, [llm({ topicDecision: "sameTopic", sameTopicMemoryId: withTopic.id })], { allMemories: [withTopic] });
  assert.equal(a.out.memoryObjects[0].topicId, "TOPIC-SAKI");
  assert.notEqual(a.out.memoryObjects[0].id, withTopic.id);
  // LLMがsameTopicMemoryIdではなくexistingMemoryIdで関連候補を指した場合も、同じ話題として継承（UPDATEはしない）
  const b = await runCapture(turns, [llm({ topicDecision: "sameTopic", existingMemoryId: withTopic.id })], { allMemories: [withTopic] });
  assert.equal(b.out.memoryObjects[0].topicId, "TOPIC-SAKI");
  assert.notEqual(b.out.memoryObjects[0].id, withTopic.id);
  // 参照先にtopicIdが無い場合は、新しいtopicIdを発行し、既存Memoryへbackfillしない
  const c = await runCapture(turns, [llm({ topicDecision: "sameTopic", sameTopicMemoryId: noTopic.id })], { allMemories: [noTopic] });
  assert.match(String(c.out.memoryObjects[0].topicId), /^[0-9A-Z]{26}$/);
  assert.deepEqual(withTopic, beforeWith);
  assert.deepEqual(noTopic, beforeNo);
  // newTopic / uncertain の従来挙動
  const n = await runCapture(turns, [llm({ topicDecision: "newTopic" })], { allMemories: [withTopic] });
  assert.ok(n.out.memoryObjects[0].topicId && n.out.memoryObjects[0].topicId !== "TOPIC-SAKI");
  const u = await runCapture(turns, [llm({ topicDecision: "uncertain" })], { allMemories: [withTopic] });
  assert.equal(u.out.memoryObjects[0].topicId, undefined);
});

test("M1: このConversation自身のMemoryへのUPDATEは従来どおり動く。存在しないid・Reflectionは更新対象にならない", async () => {
  const own = pastMemory({ id: "01OWNOWNOWNOWNOWNOWNOWNOWN", content: "さきさんと会った。", summary: "さきさんと会った", keywords: ["さきさん"], conversationId: "CONV-B" });
  const upd = await runCapture(
    [user("さきさんと会った。話しやすかった。"), ai("…")],
    [{ ...BASE, existingMemoryId: own.id, topicDecision: "uncertain", summary: "さきさんと会い、話しやすかった", content: "さきさんと会った。話しやすかった。", keywords: ["さきさん"], evidenceQuotes: ["さきさんと会った。"] }],
    { existing: [own], allMemories: [own] }
  );
  assert.equal(upd.out.memoryObjects[0].id, own.id);
  assert.deepEqual(upd.out.conversation.memoryObjectIds, []);

  const reflection = pastMemory({ id: "01REFLREFLREFLREFLREFLREFL", content: "振り返り", summary: "さきさんの振り返り", keywords: ["さきさん", "距離"] });
  (reflection.metadata as Json).source = "system-generated";
  const beforeReflection = clone(reflection);
  const r = await runCapture(
    [user("さきさんと距離を置いている。"), ai("…")],
    [{ ...BASE, existingMemoryId: reflection.id, topicDecision: "uncertain", summary: "s", content: "c", keywords: ["さきさん"], evidenceQuotes: ["さきさんと距離を置いている。"] }, { ...BASE, existingMemoryId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", topicDecision: "uncertain", summary: "s2", content: "c2", keywords: ["さきさん"], evidenceQuotes: ["さきさんと距離を置いている。"] }],
    { allMemories: [reflection] }
  );
  assert.deepEqual(reflection, beforeReflection);
  assert.equal(r.out.memoryObjects.length, 2);
  assert.ok(r.out.memoryObjects.every((m) => m.id !== reflection.id && m.id !== "01ZZZZZZZZZZZZZZZZZZZZZZZZ"));
  assert.ok(!r.firstReq.userContent.includes(reflection.id), "Reflectionは関連候補としてLLMに渡らない");
});

test("M1: プロンプトは、関連Memory候補を『更新対象ではない』と明示している", async () => {
  const A = pastMemory({ content: "さきさんとは距離を置いている。", summary: "さきさんとは距離を置いている", keywords: ["さきさん", "距離"], topicId: "T" });
  const { firstReq } = await runCapture([user("さきさんに、線を引かれた。"), ai("…")], [{ ...BASE, topicDecision: "uncertain", summary: "s", content: "c", keywords: ["さきさん"], evidenceQuotes: ["さきさんに、線を引かれた。"] }], { allMemories: [A] });
  const sys = firstReq.systemInstruction.replace(/\n/g, ""); // 表示上の折り返しの改行を除いて照合する
  assert.ok(sys.includes("これは**更新対象ではない**"));
  assert.ok(sys.includes("existingMemoryIdに設定してはいけない"));
  assert.ok(!sys.includes("その候補のidをexistingMemoryIdに設定して更新してよい"), "旧来の『関連候補を更新してよい』指示が残っていない");
  assert.ok(firstReq.userContent.includes("更新対象ではない"));
  assert.ok(JSON.stringify(firstReq.schema).includes("関連Memory候補（別Conversation由来）のidは指定しない"));
});

// ===========================================================================
// Evidence Boundary retry
// ===========================================================================

const RETRY_TURNS = [user("今日は暑かった"), ai("それは大変でしたね"), user("駅前で猫を見た")];
const GOOD = (summary = "採用されるMemory"): Json => ({ ...BASE, types: ["diary"], topicDecision: "newTopic", summary, content: "本文", keywords: ["暑い"], evidenceQuotes: ["今日は暑かった", "駅前で猫を見た"] });
const NOT_FOUND = (summary = "quoteが逐語一致しないMemory"): Json => ({ ...GOOD(summary), evidenceQuotes: ["今日は少し暑かったよね"] });
async function callRetry(script: Step[]) {
  rec.script = [...script];
  rec.requests = [];
  try {
    const res = await captureRoute.POST(new Request("http://x/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona: "companion", turns: RETRY_TURNS, existingMemories: [] }) }));
    const body = (await res.json()) as { memories?: Array<{ summary: string }> };
    return { status: res.status, memories: body.memories ?? [], calls: rec.requests.length, retry: res.headers.get("X-Tsumugi-Evidence-Retry"), evidence: res.headers.get("X-Tsumugi-Evidence") };
  } finally {
    rec.script = null;
  }
}

test("retry: 1回目が全件not-foundなら1回だけ再試行し、同じ検証を通った2回目のMemoryを採用する", async () => {
  const r = await callRetry([{ memories: [NOT_FOUND()] }, { memories: [GOOD("2回目で採用")] }]);
  assert.equal(r.status, 200);
  assert.equal(r.calls, 2);
  assert.deepEqual(r.memories.map((m) => m.summary), ["2回目で採用"]);
  assert.equal(r.retry, "attempted=1;recovered=1");
  assert.equal(r.evidence, "proposed=1;accepted=1;dropped=0");
});

test("retry: retryで救済された結果も、別Conversationの既存MemoryをUPDATEせず、新規Memoryとして保存される（topicIdは継承）", async () => {
  const A = pastMemory({ content: "さきさんとは距離を置いている。", summary: "さきさんとは距離を置いている", keywords: ["さきさん", "距離"], topicId: "TOPIC-SAKI" });
  const before = clone(A);
  const good: Json = { ...BASE, existingMemoryId: A.id, topicDecision: "sameTopic", sameTopicMemoryId: A.id, summary: "retryで採用", content: "自分が距離を取った判断が正しかったのか迷っている。", keywords: ["さきさん", "距離"], evidenceQuotes: ["これが正しかったのかもわからない。"] };
  const bad: Json = { ...good, evidenceQuotes: ["それが正しかったのかは分からない（言い換え）"] };
  const { out, seen, calls } = await runCapture([user("どんどん距離が遠くなっていく。そうしたのは自分だけど。これが正しかったのかもわからない。"), ai("…")], null, { allMemories: [A], script: [{ memories: [bad] }, { memories: [good] }] });
  assert.equal(calls, 2);
  assert.equal(seen.retryHeader, "attempted=1;recovered=1");
  assert.deepEqual(A, before);
  assert.equal(out.memoryObjects.length, 1);
  assert.notEqual(out.memoryObjects[0].id, A.id);
  assert.equal(out.memoryObjects[0].topicId, "TOPIC-SAKI");
});

test("retry: 1回目が通過した場合と、not-found以外の理由で0件の場合は、再試行しない", async () => {
  const ok = await callRetry([{ memories: [GOOD("1回目")] }, { memories: [GOOD("呼ばれてはいけない")] }]);
  assert.equal(ok.calls, 1);
  assert.equal(ok.retry, null);
  const noQuotes = { ...GOOD(), evidenceQuotes: [] as string[] };
  const missing = (() => { const g = GOOD(); delete g.evidenceQuotes; return g; })();
  for (const m of [noQuotes, missing, { ...GOOD(), evidenceQuotes: ["   "] }]) {
    const r = await callRetry([{ memories: [m] }, { memories: [GOOD("呼ばれてはいけない")] }]);
    assert.equal(r.calls, 1);
    assert.equal(r.memories.length, 0);
    assert.equal(r.retry, null);
  }
  const partial = await callRetry([{ memories: [GOOD("採用1"), NOT_FOUND("drop2")] }, { memories: [GOOD("呼ばれてはいけない")] }]);
  assert.equal(partial.calls, 1, "1件でもacceptedがあれば再試行しない");
  assert.deepEqual(partial.memories.map((m) => m.summary), ["採用1"]);
});

test("retry: retry後も検証を通らなければ0件のまま（安全性を緩めない・最大1回）。AI発言のquote・捏造quote・部分的に有効なquoteも通らない", async () => {
  const stillBad: Json[] = [NOT_FOUND(), { ...GOOD(), evidenceQuotes: ["それは大変でしたね"] }, { ...GOOD(), evidenceQuotes: ["今日は暑かった", "存在しない発言"] }];
  for (const bad of stillBad) {
    const r = await callRetry([{ memories: [NOT_FOUND()] }, { memories: [bad] }, { memories: [GOOD("3回目は呼ばれてはいけない")] }]);
    assert.equal(r.calls, 2);
    assert.equal(r.memories.length, 0);
    assert.equal(r.retry, "attempted=1;recovered=0");
  }
});

test("retry: retry自体の失敗（例外・空応答・不正JSON）は、再試行を重ねず、200・0件で安全に終了する。1回目自体の失敗は従来どおり502で再試行しない", async () => {
  for (const failure of [{ throw: true } as Step, { text: "" }, { text: "これはJSONではない" }]) {
    const r = await callRetry([{ memories: [NOT_FOUND()] }, failure, { memories: [GOOD("3回目は呼ばれてはいけない")] }]);
    assert.equal(r.status, 200);
    assert.equal(r.calls, 2);
    assert.equal(r.memories.length, 0);
    assert.equal(r.retry, "attempted=1;recovered=0");
    const first = await callRetry([failure, { memories: [GOOD()] }]);
    assert.equal(first.status, 502);
    assert.equal(first.calls, 1);
    assert.equal(first.retry, null);
  }
});
