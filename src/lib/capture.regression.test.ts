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
 * - Evidence参照の「件数」だけを理由に候補をdropしない（長い会話で5件以上の正しい引用が返る）。
 *   ただし1件でも不正なindexなら、件数によらず候補全体をdropする（検証は緩めない）。
 * - Evidence Boundary（User原文参照）は緩めない。retryは「提案あり・採用0・参照contract違反」の
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
  conversation: { memoryObjectIds: string[]; status: string };
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
let debugEpoch = 1;
const stubs: Record<string, unknown> = {
  "@/lib/ai/resolve": { getProvider: () => fakeProvider, resolveApiKey: () => "k", resolveModel: () => "m", resolveProviderForFeature: () => "gemini" },
  "./db": new Proxy({ loadApiKey: async () => "k", getAllMemoryObjects: async () => rec.allMemories }, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : async () => undefined) }),
  "./vault": { isReflectionSummary: (m: { metadata: { source: string } }) => m.metadata.source === "system-generated" },
  "./vaultWorldLock": { getTabVaultEpoch: () => debugEpoch, withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn() },
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
    [{ ...BASE, existingMemoryId: A.id, topicDecision: "newTopic", summary: "さきさんとの関係を修復したいが、相手は望んでいないかもしれない", content: "修復したい気持ちがあるが、相手が望んでいない可能性を感じている。", keywords: ["さきさん", "修復"], evidenceUserMessageIndexes: [0] }],
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
    [{ ...BASE, existingMemoryId: A.id, topicDecision: "sameTopic", sameTopicMemoryId: A.id, summary: "さきさんに線を引かれ、耐えられず自分も距離を取った", content: "さきさんから線を引かれ、それに耐えられなくなって自分も距離を取った。", keywords: ["さきさん", "距離"], evidenceUserMessageIndexes: [0] }],
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
    [{ ...BASE, existingMemoryId: A.id, topicDecision: "sameTopic", sameTopicMemoryId: A.id, summary: "さきさんとの関係は、もう修復したいとは思っていない", content: "さきさんとの関係を、もう修復したいとは思っていない。", keywords: ["さきさん", "修復"], evidenceUserMessageIndexes: [0] }],
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
  const llm = (extra: Json) => ({ ...BASE, summary: "線を引かれた", content: "さきさんに線を引かれた。", keywords: ["さきさん"], evidenceUserMessageIndexes: [0], ...extra });
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
    [{ ...BASE, existingMemoryId: own.id, topicDecision: "uncertain", summary: "さきさんと会い、話しやすかった", content: "さきさんと会った。話しやすかった。", keywords: ["さきさん"], evidenceUserMessageIndexes: [0] }],
    { existing: [own], allMemories: [own] }
  );
  assert.equal(upd.out.memoryObjects[0].id, own.id);
  assert.deepEqual(upd.out.conversation.memoryObjectIds, []);

  const reflection = pastMemory({ id: "01REFLREFLREFLREFLREFLREFL", content: "振り返り", summary: "さきさんの振り返り", keywords: ["さきさん", "距離"] });
  (reflection.metadata as Json).source = "system-generated";
  const beforeReflection = clone(reflection);
  const r = await runCapture(
    [user("さきさんと距離を置いている。"), ai("…")],
    [{ ...BASE, existingMemoryId: reflection.id, topicDecision: "uncertain", summary: "s", content: "c", keywords: ["さきさん"], evidenceUserMessageIndexes: [0] }, { ...BASE, existingMemoryId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", topicDecision: "uncertain", summary: "s2", content: "c2", keywords: ["さきさん"], evidenceUserMessageIndexes: [0] }],
    { allMemories: [reflection] }
  );
  assert.deepEqual(reflection, beforeReflection);
  assert.equal(r.out.memoryObjects.length, 2);
  assert.ok(r.out.memoryObjects.every((m) => m.id !== reflection.id && m.id !== "01ZZZZZZZZZZZZZZZZZZZZZZZZ"));
  assert.ok(!r.firstReq.userContent.includes(reflection.id), "Reflectionは関連候補としてLLMに渡らない");
});

test("M1: プロンプトは、関連Memory候補を『更新対象ではない』と明示している", async () => {
  const A = pastMemory({ content: "さきさんとは距離を置いている。", summary: "さきさんとは距離を置いている", keywords: ["さきさん", "距離"], topicId: "T" });
  const { firstReq } = await runCapture([user("さきさんに、線を引かれた。"), ai("…")], [{ ...BASE, topicDecision: "uncertain", summary: "s", content: "c", keywords: ["さきさん"], evidenceUserMessageIndexes: [0] }], { allMemories: [A] });
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
const GOOD = (summary = "採用されるMemory"): Json => ({ ...BASE, types: ["diary"], topicDecision: "newTopic", summary, content: "本文", keywords: ["暑い"], evidenceUserMessageIndexes: [0, 1] });
const NOT_FOUND = (summary = "indexが範囲外のMemory"): Json => ({ ...GOOD(summary), evidenceUserMessageIndexes: [99] });
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

test("retry: 1回目が全件index不正なら1回だけ再試行し、同じ検証を通った2回目のMemoryを採用する", async () => {
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
  const good: Json = { ...BASE, existingMemoryId: A.id, topicDecision: "sameTopic", sameTopicMemoryId: A.id, summary: "retryで採用", content: "自分が距離を取った判断が正しかったのか迷っている。", keywords: ["さきさん", "距離"], evidenceUserMessageIndexes: [0] };
  const bad: Json = { ...good, evidenceUserMessageIndexes: [-1] };
  const { out, seen, calls } = await runCapture([user("どんどん距離が遠くなっていく。そうしたのは自分だけど。これが正しかったのかもわからない。"), ai("…")], null, { allMemories: [A], script: [{ memories: [bad] }, { memories: [good] }] });
  assert.equal(calls, 2);
  assert.equal(seen.retryHeader, "attempted=1;recovered=1");
  assert.deepEqual(A, before);
  assert.equal(out.memoryObjects.length, 1);
  assert.notEqual(out.memoryObjects[0].id, A.id);
  assert.equal(out.memoryObjects[0].topicId, "TOPIC-SAKI");
});

test("retry: valid/empty/partial success is not retried; missing/type/index errors retry once", async () => {
  for (const memories of [[GOOD()], [], [GOOD(), NOT_FOUND()]]) {
    const r = await callRetry([{ memories }, { memories: [GOOD("unused")] }]);
    assert.equal(r.calls, 1);
    assert.equal(r.retry, null);
  }
  const missing = { ...GOOD() }; delete missing.evidenceUserMessageIndexes;
  for (const m of [missing, ...[[], null, "0", ["0"], [-1], [0.5], [0, 99]].map(raw => ({ ...GOOD(), evidenceUserMessageIndexes: raw }))]) {
    const r = await callRetry([{ memories: [m] }, { memories: [GOOD()] }]);
    assert.equal(r.calls, 2);
    assert.equal(r.memories.length, 1);
    assert.equal(r.retry, "attempted=1;recovered=1");
  }
});

test("retry: invalid references after retry reject entire candidate; maximum two calls", async () => {
  for (const raw of [[99], [0, 99], [null], []]) {
    const r = await callRetry([{ memories: [NOT_FOUND()] }, { memories: [{ ...GOOD(), evidenceUserMessageIndexes: raw }] }, { memories: [GOOD("unused")] }]);
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


// ===========================================================================
// evidenceQuotesの件数超過（長い会話）／正常0件と全dropの区別／根拠quoteの追跡
// ===========================================================================

const markdownMod = require(path.join(ROOT, "lib/markdown.js")) as {
  memoryObjectToMarkdown: (m: unknown) => string;
  parseMemoryObjectMarkdown: (raw: string) => { evidenceQuotes?: string[]; content: string } | null;
};

// Sadowsky型：同じ話題が長く続き、LLMが1つの大きなMemoryに5件以上の逐語quoteを付ける。
const SADOWSKY_USER = [
  "Sadowskyのベースについて話したい。TYO Modern Edge 4stを持ってる。",
  "シリアルは2桁なんだよね。",
  "ボディはメイプルとアッシュ。",
  "菊池さんのサイン入りなんだ。",
  "でも当時20万くらいで中古で買ったよ。",
  "そう。このベースにはなぜか所有している喜びがある。",
  "レイクランドのSLシリーズも持ってたけど、売ってしまった。",
];
const SADOWSKY_TURNS = SADOWSKY_USER.flatMap((u, i) => [user(u), ai(`AIの整理${i}：Sadowsky NYCは一般に…と言われています。タル・ウィルケンフェルドのスペックに近いと言われます。`)]);
const SADOWSKY_MEMORY: Json = {
  ...BASE, types: ["idea", "diary"], topicDecision: "newTopic",
  summary: "SadowskyのTYO Modern Edge 4stを所有している。約20万円で中古購入し、所有する喜びがある。以前Lakland SLシリーズも所有していたが売った",
  content: "Sadowsky TYO Modern Edge 4stを所有している。当時20万くらいで中古で買った。このベースにはなぜか所有している喜びがある。レイクランドのSLシリーズも持っていたが、売ってしまった。",
  keywords: ["Sadowsky", "TYO Modern Edge", "中古", "所有", "Lakland"],
  evidenceUserMessageIndexes: [0, 3, 4, 5, 6], // 5 User turns
};

test("evidence: 5件以上の正しい逐語quoteは、件数だけを理由にdropされない（Sadowsky型・長い会話）。回収されるべき4つの意味が残る", async () => {
  assert.ok((SADOWSKY_MEMORY.evidenceUserMessageIndexes as number[]).length >= 5);
  const { out } = await runCapture(SADOWSKY_TURNS, [SADOWSKY_MEMORY]);
  assert.equal(out.memoryObjects.length, 1);
  const text = String(out.memoryObjects[0].content) + String(out.memoryObjects[0].summary);
  for (const claim of ["Sadowsky", "TYO Modern Edge 4st", "20万", "中古", "所有している喜び", "レイクランドのSLシリーズ", "売って"]) {
    assert.ok(text.includes(claim), `回収されている: ${claim}`);
  }
});

test("evidence: one invalid index among many rejects the whole candidate", async () => {
  for (const raw of [[0, 3, 4, 5, 6, 99], [0, 3, "4"], []]) {
    const { out } = await runCapture(SADOWSKY_TURNS, [{ ...SADOWSKY_MEMORY, evidenceUserMessageIndexes: raw }]);
    assert.equal(out.memoryObjects.length, 0);
  }
});

test("evidence: 根拠quote（検証済みのユーザー発言）がMemoryObjectへ保存され、Markdownを往復しても保たれる。conversationIdと合わせて根拠を追跡できる", async () => {
  const { out } = await runCapture(SADOWSKY_TURNS, [SADOWSKY_MEMORY]);
  const m = out.memoryObjects[0];
  assert.equal(m.conversationId, "CONV-B");
  const stored = m.evidenceQuotes as string[];
  assert.equal(stored.length, (SADOWSKY_MEMORY.evidenceUserMessageIndexes as number[]).length);
  for (const q of stored) assert.ok(SADOWSKY_USER.some((u) => u.includes(q)), `保存quoteはユーザー発言の逐語: ${q}`);
  const md = markdownMod.memoryObjectToMarkdown(m);
  const back = markdownMod.parseMemoryObjectMarkdown(md);
  assert.deepEqual(back?.evidenceQuotes, stored);
  // 旧形式（evidenceキーが無いMarkdown）はそのまま読める
  const legacy = md.split("\n").filter((l) => !l.startsWith("evidence:")).join("\n");
  assert.equal(markdownMod.parseMemoryObjectMarkdown(legacy)?.evidenceQuotes, undefined);
});

// さきさん型：ユーザー発言の強さを変えない。AI由来の推論・言っていない心理・因果はdropされる。
const SAKI_USER = [
  "さきさんに線を引かれた。そこから自分が耐えられなくなって引いていった。",
  "まだ修復したいとは思っているけど、向こうはそれを望んでない可能性もある。",
  "自分の判断が正しかったのかはわからない。",
];
const SAKI_TURNS = SAKI_USER.flatMap((u) => [user(u), ai("さきさんに拒絶されて傷つき、自分を守るために距離を取ったのかもしれませんね。")]);
const SAKI_MEMORY: Json = {
  ...BASE, topicDecision: "newTopic",
  summary: "さきさんから線を引かれたことをきっかけに、自分も距離を取るようになったと捉えている。まだ修復したいが、相手は望んでいない可能性もあり、自分の判断が正しかったかはわからない",
  content: "さきさんに線を引かれた。そこから自分が耐えられなくなって引いていった。まだ修復したいとは思っているが、向こうはそれを望んでいない可能性もある。自分の判断が正しかったのかはわからない。",
  keywords: ["さきさん", "距離", "修復"],
  evidenceUserMessageIndexes: [0, 1, 2],
};

test("さきさん型：線を引かれた／自分も距離を取った／修復したい／相手は望んでいないかも／判断が正しかったかわからない が、強さを変えずに回収される", async () => {
  const { out } = await runCapture(SAKI_TURNS, [SAKI_MEMORY]);
  assert.equal(out.memoryObjects.length, 1);
  const text = String(out.memoryObjects[0].content);
  for (const claim of ["線を引かれた", "引いていった", "修復したい", "望んでいない可能性", "正しかったのかはわからない"]) assert.ok(text.includes(claim), claim);
  assert.equal((out.memoryObjects[0].evidenceQuotes as string[]).length, 3);
});

test("evidence: model quote text cannot substitute for index contract or inject Assistant evidence", async () => {
  const { evidenceUserMessageIndexes: omitted, ...legacyCandidate } = SAKI_MEMORY;
  void omitted;
  const bad = { ...legacyCandidate, evidenceQuotes: ["さきさんに拒絶されて傷つき、自分を守るために距離を取った"] };
  const rejected = await runCapture(SAKI_TURNS, [bad]);
  assert.equal(rejected.out.memoryObjects.length, 0);
  const accepted = await runCapture(SAKI_TURNS, [{ ...SAKI_MEMORY, evidenceQuotes: bad.evidenceQuotes }]);
  assert.deepEqual(accepted.out.memoryObjects[0].evidenceQuotes, SAKI_USER);
});

test("evidence: prompt and schema require indexes, retain factual Boundary, no quote generation", async () => {
  const { firstReq } = await runCapture(SADOWSKY_TURNS, [SADOWSKY_MEMORY]);
  const prompt = firstReq.systemInstruction;
  assert.ok(prompt.includes("5件以上でもよい"));
  assert.ok(prompt.includes("evidenceQuotes本文を生成しない"));
  assert.ok(prompt.includes("禁止：心情の追加／因果関係の追加"));
  const schemaText = JSON.stringify(firstReq.schema);
  assert.ok(schemaText.includes('"evidenceUserMessageIndexes"'));
  assert.ok(!schemaText.includes('"evidenceQuotes":'));
  assert.ok(!schemaText.includes("maxItems"));
});

// Capture Debugger: observation must not change extraction/adoption/persistence.
const captureDebug = require(path.join(ROOT, "lib/captureDebug.js")) as {
  getCaptureDebugText: () => Promise<string>;
  clearCaptureDebug: () => void;
};
async function withCaptureDebug(fn: () => Promise<void>) {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "?debugLog=1" } } });
  captureDebug.clearCaptureDebug();
  try { await fn(); }
  finally {
    captureDebug.clearCaptureDebug();
    if (old) Object.defineProperty(globalThis, "window", old);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
function debugEntry(text: string): Json {
  return JSON.parse(text.replace("[D] Capture Debug\n", "")) as Json;
}
const DEBUG_GOOD = { ...BASE, summary: "所有している喜び", content: "このベースを所有している喜びがある", keywords: ["ベース"], evidenceUserMessageIndexes: [0] };
const DEBUG_BAD = { ...DEBUG_GOOD, summary: "候補だが根拠不一致", evidenceUserMessageIndexes: [99] };

test("Capture Debug: opt-in retains proposed/drop detail without changing prompt or accepted output", async () => {
  const turns = [user("このベースには所有している喜びがある"), ai("そうなんですね")];
  const normal = await runCapture(turns, [DEBUG_GOOD, DEBUG_BAD]);
  assert.equal(await captureDebug.getCaptureDebugText(), "");
  await withCaptureDebug(async () => {
    const debug = await runCapture(turns, [DEBUG_GOOD, DEBUG_BAD]);
    assert.deepEqual(debug.firstReq, normal.firstReq); // prompt, transcript, schema unchanged
    assert.deepEqual(debug.out.memoryObjects.map(m => [m.summary, m.content, m.evidenceQuotes]), normal.out.memoryObjects.map(m => [m.summary, m.content, m.evidenceQuotes]));
    const text = await captureDebug.getCaptureDebugText();
    const entry = debugEntry(text);
    assert.equal(entry.conversationId, "CONV-B");
    assert.equal(entry.turnCount, 2);
    assert.equal(entry.userMessageCount, 1);
    assert.equal(entry.assistantMessageCount, 1);
    assert.deepEqual(entry.userMessages, ["このベースには所有している喜びがある"]);
    const server = entry.server as { attempts: Array<{ candidates: Json[]; validation: Json[] }>; selectedAttempt: number };
    assert.equal(server.attempts[0].candidates.length, 2);
    assert.equal(server.attempts[0].validation[1].verdict, "dropped");
    assert.equal(server.attempts[0].validation[1].reason, "out-of-range");
    assert.deepEqual(server.attempts[0].validation[1].rawEvidenceUserMessageIndexes, [99]);
    assert.deepEqual(server.attempts[0].validation[0].resolvedOriginalEvidenceQuotes, [turns[0].content]);
    assert.equal((entry.memories as Json[])[0].proposedIndex, 0);
    debugEpoch = 2;
    assert.equal(await captureDebug.getCaptureDebugText(), "");
    debugEpoch = 1;
  });
});

test("Capture Debug: retry preserves both attempts and selects only recovered output", async () => {
  await withCaptureDebug(async () => {
    await runCapture([user("所有している喜びがある")], null, { script: [{ memories: [DEBUG_BAD] }, { memories: [DEBUG_GOOD] }] });
    const entry = debugEntry(await captureDebug.getCaptureDebugText());
    const server = entry.server as { attempts: unknown[]; selectedAttempt: number };
    assert.equal(server.attempts.length, 2);
    assert.equal(server.selectedAttempt, 2);
    assert.deepEqual(entry.totals, { proposed: 1, accepted: 1, dropped: 0, saved: 0 });
  });
});

test("Capture Debug: parse failure is observable, with no raw model response or secrets", async () => {
  await withCaptureDebug(async () => {
    await assert.rejects(runCapture([user("所有している喜びがある")], null, { script: [{ text: "invalid JSON secret-marker" }] }));
    const text = await captureDebug.getCaptureDebugText();
    assert.ok(text.includes("parse-error"));
    assert.ok(!text.includes("secret-marker"));
  });
});

test("Capture Debug: observes IndexedDB success/failure and Vault success/held/failure/deferred", async () => {
  await withCaptureDebug(async () => {
    const db = stubs["./db"] as Record<string, unknown>;
    const vault = stubs["./vault"] as Record<string, unknown>;
    // 新保存基盤 Phase 3-9：capture.tsのcanonical writeが`db.putMemoryObject`から
    // `db.putMemoryObjectWithOutbox`（canonical + vaultOutboxのatomic commit）へ
    // 切り替わったため、stub対象もそれに合わせる（呼び出し側の引数はrecordType等が
    // 増えるが、このstub自体は件数・成否だけを模すため、シグネチャは変えずそのまま使える）。
    const oldPut = db.putMemoryObjectWithOutbox;
    const oldWrite = vault.writeMemoryObjectMarkdown;
    const oldConversationWrite = vault.writeConversationMarkdown;
    vault.writeConversationMarkdown = async () => {};
    const persist = (captureClient as unknown as { persistCapture: (handle: unknown, conversation: unknown, memories: unknown[], priority: string, awaitSync: boolean) => Promise<{ failedMemoryIds: string[]; backgroundSyncPromise: Promise<void> | null }> }).persistCapture;
    try {
      for (const mode of ["success", "held", "failed", "deferred", "idb-failed"]) {
        captureDebug.clearCaptureDebug();
        db.putMemoryObjectWithOutbox = async () => { if (mode === "idb-failed") throw new Error("test IDB failure"); };
        vault.writeMemoryObjectMarkdown = async () => {
          if (mode === "held") { const e = new Error("test hold"); e.name = "VaultRecordNeedsResyncError"; throw e; }
          if (mode === "failed") throw new Error("test Vault failure");
        };
        const { out } = await runCapture([user("所有している喜びがある")], [DEBUG_GOOD]);
        const saved = await persist(mode === "deferred" ? null : {}, out.conversation, out.memoryObjects, "interactive", false);
        if (saved.backgroundSyncPromise) await saved.backgroundSyncPromise;
        const entry = debugEntry(await captureDebug.getCaptureDebugText());
        const memory = (entry.memories as Json[])[0];
        assert.equal(memory.indexedDB, mode === "idb-failed" ? "failed" : "success");
        assert.equal((entry.totals as Json).saved, mode === "idb-failed" ? 0 : 1);
        assert.equal(memory.vault, mode === "idb-failed" ? "not-attempted: canonical commit failed" : mode === "deferred" ? "deferred: no connected vault" : mode === "held" ? "held" : mode === "failed" ? "failed (write or sync bookkeeping)" : "success");
        assert.equal(saved.failedMemoryIds.length, mode === "idb-failed" ? 1 : 0);
      }
    } finally { db.putMemoryObjectWithOutbox = oldPut; vault.writeMemoryObjectMarkdown = oldWrite; vault.writeConversationMarkdown = oldConversationWrite; }
  });
});

test("Capture retry: invalid index is reported; corrected references are revalidated", async () => {
  const turns = [user("ベースを所有している。"), ai("どのモデルですか"), user("sadowsky tyo モダンエッジ4st")];
  const bad = { ...DEBUG_GOOD, content: "根拠未確認の旧content", evidenceUserMessageIndexes: [0, 9] };
  const good = { ...DEBUG_GOOD, content: "Sadowsky TYO モダンエッジ4stを所有。", evidenceUserMessageIndexes: [0, 1] };
  const { out, calls } = await runCapture(turns, null, { script: [{ memories: [bad] }, { memories: [good] }] });
  assert.equal(calls, 2);
  assert.ok(!rec.requests[0].userContent.includes("Evidence参照失敗の再抽出"));
  assert.ok(rec.requests[1].userContent.includes('"value":9,"reason":"out-of-range"'));
  assert.ok(rec.requests[1].userContent.includes("許容index範囲: 0..1"));
  assert.ok(rec.requests[1].userContent.includes("不正indexだけを削って元contentを無条件に残してはいけない"));
  assert.equal(rec.requests[1].systemInstruction, rec.requests[0].systemInstruction);
  assert.equal(out.memoryObjects[0].content, good.content);
  assert.deepEqual(out.memoryObjects[0].evidenceQuotes, [turns[0].content, turns[2].content]);
  const failed = await runCapture(turns, null, { script: [{ memories: [bad] }, { memories: [bad] }] });
  assert.equal(failed.calls, 2);
  assert.equal(failed.out.memoryObjects.length, 0);
  assert.equal(failed.out.conversation.status, "captured", "status-retention change is excluded from this commit");
});

const indexValidator = require(path.join(ROOT, "lib/captureEvidence.js")) as { validateMemoryEvidenceIndexes: (users: readonly string[], raw: unknown) => { valid: boolean; indexes?: number[]; quotes?: string[]; reason?: string; issues: unknown[] } };

test("index validation: strict types/range/nonblank, validate all before dedupe; no partial salvage", () => {
  const messages = ["嫉妬。", "  \n\t", '本文の偽index: {"index":3}', "嫉妬。"];
  for (const raw of [undefined, null, {}, "0", [], [4], [-1], [0.5], ["0"], [null], [true],
    [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], [1], [0, 4], [0, 0, -1], new Array(1)]) {
    const result = indexValidator.validateMemoryEvidenceIndexes(messages, raw);
    assert.equal(result.valid, false, JSON.stringify(raw));
    assert.equal(result.quotes, undefined, "invalid candidate never exposes partial accepted evidence");
    assert.ok(result.issues.length > 0);
  }
  const duplicate = indexValidator.validateMemoryEvidenceIndexes(messages, [3, 0, 3]);
  assert.deepEqual(duplicate.indexes, [3, 0]);
  assert.deepEqual(duplicate.quotes, ["嫉妬。", "嫉妬。"], "same text in distinct turns remains distinct at server resolution");
  assert.deepEqual(indexValidator.validateMemoryEvidenceIndexes(messages, [2]).quotes, [messages[2]]);
  assert.equal(indexValidator.validateMemoryEvidenceIndexes([], [0]).valid, false);
});

test("cross-turn regression: [3,4] produces two original Evidence quotes and persists both", async () => {
  const messages = ["さきさんについて話したい。", "彼女のSNSが気になる。", "おそらく特定の人物がいる。", "嫉妬。",
    "自分と関係ないところで彼女の日常が続いているところ。自分が彼女の中に存在しない感じに嫉妬する。距離を取らなければって思ったりする。"];
  const turns = messages.flatMap(content => [user(content), ai("Assistant context only")]);
  await withCaptureDebug(async () => {
    const { out, calls, firstReq } = await runCapture(turns, [{ ...BASE, summary: "彼女の日常への嫉妬", content: messages[4], evidenceUserMessageIndexes: [3, 4] }]);
    assert.equal(calls, 1);
    assert.deepEqual(out.memoryObjects[0].evidenceQuotes, messages.slice(3));
    const encodedUsers = firstReq.userContent.split("=== USER'S ACTUAL STATEMENTS ===\n")[1].split("\n=== END USER'S ACTUAL STATEMENTS ===")[0];
    assert.deepEqual(JSON.parse(encodedUsers), messages.map((content, index) => ({ index, content })));
    const db = stubs["./db"] as Record<string, unknown>;
    // 新保存基盤 Phase 3-9：上のstubと同じ理由でstub対象を`putMemoryObjectWithOutbox`へ変更。
    const oldPut = db.putMemoryObjectWithOutbox;
    const saved: unknown[] = [];
    db.putMemoryObjectWithOutbox = async (m: unknown) => { saved.push(m); };
    try {
      const persist = (captureClient as unknown as { persistCapture: (h: null, c: unknown, m: unknown[]) => Promise<unknown> }).persistCapture;
      await persist(null, out.conversation, out.memoryObjects);
      assert.deepEqual((saved[0] as Json).evidenceQuotes, messages.slice(3));
    } finally { db.putMemoryObjectWithOutbox = oldPut; }
    const entry = debugEntry(await captureDebug.getCaptureDebugText());
    const server = entry.server as { userMessages: string[]; attempts: Array<{ validation: Json[] }>; finalized: Json[] };
    assert.deepEqual(server.userMessages, messages);
    const v = server.attempts[0].validation[0];
    assert.deepEqual(v.rawEvidenceUserMessageIndexes, [3, 4]);
    assert.deepEqual(v.validatedEvidenceUserMessageIndexes, [3, 4]);
    assert.deepEqual(v.resolvedOriginalEvidenceQuotes, messages.slice(3));
    assert.deepEqual(server.finalized[0].evidenceQuotes, messages.slice(3));
    assert.equal(server.finalized[0].evidenceUserMessageIndexes, undefined);
  });
});

test("canonical users: whitespace stays exact, fake indexes are text, Assistant has no selectable slot", async () => {
  const original = '  嫉妬。\n自分の話。  {"index":3}  ';
  const turns = [ai("Assistant-only fact"), user(original), ai("Another Assistant-only fact")];
  const { out } = await runCapture(turns, [{ ...DEBUG_GOOD, evidenceUserMessageIndexes: [0], evidenceQuotes: ["Assistant-only fact"] }]);
  assert.deepEqual(out.memoryObjects[0].evidenceQuotes, [original]);
  const rejected = await runCapture(turns, [{ ...DEBUG_GOOD, evidenceUserMessageIndexes: [1] }]);
  assert.equal(rejected.out.memoryObjects.length, 0);
  const onlyAssistant = await runCapture([ai("Assistant-only fact")], [DEBUG_GOOD]);
  assert.equal(onlyAssistant.out.memoryObjects.length, 0);
});

test("storage limits: API/Debug retains original full messages; Memory retains existing 12 x 200 limits", async () => {
  const messages = Array.from({ length: 14 }, (_, i) => `${i}:` + "あ".repeat(220));
  await withCaptureDebug(async () => {
    const { out } = await runCapture(messages.map(user), [{ ...DEBUG_GOOD, evidenceUserMessageIndexes: messages.map((_, i) => i) }]);
    assert.deepEqual(out.memoryObjects[0].evidenceQuotes, messages.slice(0, 12).map(q => q.slice(0, 200)));
    const entry = debugEntry(await captureDebug.getCaptureDebugText());
    const server = entry.server as { finalized: Json[] };
    assert.deepEqual(server.finalized[0].evidenceQuotes, messages);
    assert.deepEqual((entry.memories as Json[])[0].evidenceQuotes, out.memoryObjects[0].evidenceQuotes);
  });
});

test("Debug retry reason records invalid reference, not quote formatting; results identical without Debug", async () => {
  const script: Step[] = [{ memories: [DEBUG_BAD] }, { memories: [DEBUG_GOOD] }];
  const turns = [user("所有する喜びがある")];
  const normal = await runCapture(turns, null, { script });
  await withCaptureDebug(async () => {
    const debug = await runCapture(turns, null, { script });
    assert.equal(debug.calls, normal.calls);
    assert.deepEqual(debug.out.memoryObjects.map(m => m.evidenceQuotes), normal.out.memoryObjects.map(m => m.evidenceQuotes));
    const entry = debugEntry(await captureDebug.getCaptureDebugText());
    const server = entry.server as { attempts: Array<{ retryReason: Json[] }> };
    assert.equal(server.attempts[0].retryReason[0].reason, "out-of-range");
    assert.deepEqual(server.attempts[0].retryReason[0].rawEvidenceUserMessageIndexes, [99]);
  });
});

test("index endpoint: invalid contract cases fail closed, duplicates alone pass without retry", async () => {
  const turns = [user("嫉妬。"), ai("Assistant-only"), user(" \n ")];
  for (const raw of [99, {}, null, [], [2], [-1], [0.5], ["0"], [null], [0, 2], [0, 0, 1]]) {
    const { out, calls } = await runCapture(turns, [{ ...DEBUG_GOOD, evidenceUserMessageIndexes: raw }]);
    assert.equal(out.memoryObjects.length, 0, JSON.stringify(raw));
    assert.equal(calls, 2);
  }
  const duplicate = await runCapture(turns, [{ ...DEBUG_GOOD, evidenceUserMessageIndexes: [0, 0] }]);
  assert.equal(duplicate.calls, 1);
  assert.deepEqual(duplicate.out.memoryObjects[0].evidenceQuotes, ["嫉妬。"]);
});

test("identical User turns: server retains distinct references; existing storage text dedupe remains", async () => {
  await withCaptureDebug(async () => {
    const { out } = await runCapture([user("嫉妬。"), ai("…"), user("嫉妬。")], [{ ...DEBUG_GOOD, evidenceUserMessageIndexes: [0, 1, 0] }]);
    const entry = debugEntry(await captureDebug.getCaptureDebugText());
    const server = entry.server as { attempts: Array<{ validation: Json[] }>; finalized: Json[] };
    assert.deepEqual(server.attempts[0].validation[0].validatedEvidenceUserMessageIndexes, [0, 1]);
    assert.deepEqual(server.finalized[0].evidenceQuotes, ["嫉妬。", "嫉妬。"]);
    assert.deepEqual(out.memoryObjects[0].evidenceQuotes, ["嫉妬。"]);
  });
});
