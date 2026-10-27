"use client";

import { useState } from "react";
import { computeKeywordFrequency, DEFAULT_LIMIT, scoreMemory, selectConversationDirectMatches } from "@/lib/retrieval";
import { FICTIONAL_USERS } from "@/lib/synthesisFictionalData";
import { safeSelectTimelineForTurn, selectSynthesisForTurn, type SynthesisThemeContext } from "@/lib/memorySynthesis";
import { textSimilarity, usableItemsForChat, unusableReason, themeSnapshot, type SynthesisState } from "@/lib/synthesisModel";
import { createMemorySynthesisStore, runSynthesisOnce, type SynthesisRunDeps } from "@/lib/synthesisRunner";
import { loadApiKey } from "@/lib/db";
import { GEMINI_API_KEY_HEADER } from "@/lib/apiKeyHeader";
import type { Conversation, MemoryObject, RetrievedMemory } from "@/lib/types";

/**
 * Preview専用：Memory Synthesis S1 の比較（Timeline OFF / Timeline ONのみ / Timeline＋Synthesis ON）と、訂正・古い仮説の除外の確認。
 * 架空Memoryだけを使い、端末のSynthesisデータベースやMemoryには一切触れない（メモリ上のストアのみ）。マージ前に削除する。
 */
type Cond = "off" | "timeline" | "synthesis";
const CONDS: Cond[] = ["off", "timeline", "synthesis"];
const LABEL: Record<Cond, string> = { off: "Timeline OFF", timeline: "Timeline ONのみ", synthesis: "Timeline＋Synthesis" };
const RUNS = 3;
type User = "A" | "B" | "C";
const MEM: Record<User, () => MemoryObject[]> = { A: FICTIONAL_USERS[0].memories, B: FICTIONAL_USERS[1].memories, C: FICTIONAL_USERS[2].memories };

interface Scenario { id: string; label: string; user: User; persona: "analyst" | "companion"; prior: [string, string][]; latest: string }
const SCENARIOS: Scenario[] = [
  { id: "a-work", label: "A 意見：仕事", user: "A", persona: "analyst", prior: [], latest: "今の会社、このままでいいと思う？" },
  { id: "a-run", label: "A 普段：ランニング", user: "A", persona: "analyst", prior: [], latest: "最近また走れてないんだよね" },
  { id: "a-alone", label: "A 意見：一人の時間", user: "A", persona: "analyst", prior: [], latest: "週末、誰かと会うか一人で過ごすか迷ってる。どう思う？" },
  { id: "b-sister", label: "B 意見：姉", user: "B", persona: "analyst", prior: [], latest: "姉のことなんだけど、私にとってどういう存在なんだろう" },
  { id: "b-work", label: "B 意見：仕事", user: "B", persona: "analyst", prior: [], latest: "仕事、このままでいいのかな" },
  { id: "c-friend", label: "C 意見：拓也", user: "C", persona: "analyst", prior: [], latest: "拓也にまた連絡するべきかな。どう思う？" },
  { id: "c-english", label: "C 普段：英語", user: "C", persona: "analyst", prior: [], latest: "英語、最近また夜にちょっとずつやれてる" },
  { id: "a-unrelated", label: "A 無関係", user: "A", persona: "analyst", prior: [], latest: "新しいシャンプー、ラベンダーとシトラスどっちがいいと思う？" },
  { id: "a-diary", label: "A 日記", user: "A", persona: "companion", prior: [], latest: "今日は久しぶりに走って、気持ちよかった" },
  { id: "a-record", label: "A 記録モード", user: "A", persona: "analyst", prior: [["今の会社のこと、異動が保留になってからずっと考えてる", "うん、聞いてるよ。"], ["デザインの勉強は続けたいけど、時間が取れない", "そうなんだね。"]], latest: "ここまでの話を記録して" },
];

function retrieve(pool: MemoryObject[], s: Scenario): RetrievedMemory[] {
  const toR = (m: MemoryObject): RetrievedMemory => ({ id: m.id, date: m.date, eventTime: m.eventTime, eventTimePrecision: m.eventTimePrecision, summary: m.summary, keywords: m.keywords, source: m.metadata.source });
  if (s.persona === "companion") return pool.map((m) => ({ m, score: scoreMemory(m, s.latest) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, DEFAULT_LIMIT).map((x) => toR(x.m));
  const userTurns = [...s.prior.map(([u]) => u), s.latest];
  return selectConversationDirectMatches(pool, s.latest, userTurns, computeKeywordFrequency(pool), DEFAULT_LIMIT).kept.map((e) => toR(e.memory));
}

async function headers(): Promise<Record<string, string>> {
  const key = await loadApiKey().catch(() => undefined);
  return { "Content-Type": "application/json", ...(key ? { [GEMINI_API_KEY_HEADER]: key } : {}) };
}

function contextsFor(cond: Cond, pool: MemoryObject[], s: Scenario, retrieved: RetrievedMemory[], state: SynthesisState | null): { contexts: SynthesisThemeContext[]; shownIds: string[] } {
  const turn = { userText: s.latest, retrievedMemoryIds: retrieved.map((m) => m.id) };
  if (cond === "off") return { contexts: [], shownIds: [] };
  if (cond === "timeline" || !state) return { contexts: safeSelectTimelineForTurn(pool, turn), shownIds: [] };
  const { items, hypothesisIdByItem } = usableItemsForChat(state, pool, Date.now());
  const contexts = selectSynthesisForTurn(items, turn, pool);
  return { contexts, shownIds: contexts.flatMap((c) => c.items.map((i) => hypothesisIdByItem.get(i) ?? "")).filter(Boolean) };
}

async function chat(s: Scenario, retrieved: RetrievedMemory[], contexts: SynthesisThemeContext[], extraTurns: { role: "user" | "ai"; content: string }[] = []) {
  const ts = () => new Date().toISOString();
  const turns = [...s.prior.flatMap(([u, a]) => [{ role: "user", content: u, timestamp: ts() }, { role: "ai", content: a, timestamp: ts() }]), ...extraTurns.map((t) => ({ ...t, timestamp: ts() })), { role: "user", content: s.latest, timestamp: ts() }];
  const t0 = performance.now();
  const res = await fetch("/api/chat", { method: "POST", headers: await headers(), body: JSON.stringify({ persona: s.persona, turns, retrievedMemories: retrieved, ...(contexts.length > 0 ? { memoryTimeline: contexts } : {}) }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`chat ${res.status}: ${text.slice(0, 200)}`);
  return { text, ms: Math.round(performance.now() - t0), chars: text.trim().length };
}

function describeContexts(contexts: SynthesisThemeContext[]): string {
  if (contexts.length === 0) return "（経緯なし）";
  return contexts.map((c) => `テーマ「${c.theme}」状態:${c.state.status}${c.items.length ? ` 仮説:${c.items.map((i) => `[${i.kind}/${i.support}] ${i.statement}`).join(" ／ ")}` : " 仮説なし"}`).join("\n");
}

const store = (s: SynthesisState) => createMemorySynthesisStore(JSON.parse(JSON.stringify(s)) as SynthesisState);
function deps(st: ReturnType<typeof createMemorySynthesisStore>, memories: MemoryObject[], now: number, conversations: Conversation[] = [], onRaw?: (line: string) => void): SynthesisRunDeps {
  let n = 0;
  return {
    store: st,
    readMemories: async () => memories,
    readConversations: async () => conversations,
    callApi: async (payload) => {
      const res = await fetch("/api/synthesize", { method: "POST", headers: await headers(), body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`synthesize ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { items?: unknown; reactions?: unknown; dropped?: unknown };
      onRaw?.(`API: 判定を求めた反応 ${(payload.checks ?? []).length}件 → 通過した反応 ${JSON.stringify(body.reactions)} ／ 落とした項目 ${JSON.stringify(body.dropped)}`);
      return body;
    },
    now: () => now,
    newId: () => `eval${++n}-${now}`,
  };
}

export default function SynthesisEval() {
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const add = (line: string) => setLog((l) => [...l, line]);
  const states: Partial<Record<User, SynthesisState>> = {};

  async function generate() {
    for (const u of ["A", "B", "C"] as User[]) {
      setStatus(`生成 ${u}`);
      const st = createMemorySynthesisStore();
      const t0 = performance.now();
      const out = await runSynthesisOnce(deps(st, MEM[u](), Date.now(), [], add));
      const ms = Math.round(performance.now() - t0);
      states[u] = st.snapshot();
      const pool = MEM[u]();
      add(`## 生成 ${u}（${ms}ms）結果: ${JSON.stringify(out)}`);
      for (const h of states[u]!.hypotheses) add(`- [${h.themeLabel}/${h.kind}/${h.support}] ${h.statement}${h.situationNote ? `（状況: ${h.situationNote}）` : ""}\n  根拠: ${h.evidence.map((e) => pool.find((m) => m.id === e.memoryId)?.summary).join(" ／ ")}`);
    }
  }

  async function compare() {
    for (const s of SCENARIOS) {
      const pool = MEM[s.user]();
      const retrieved = retrieve(pool, s);
      add(`## ${s.label}（${s.persona}）「${s.latest}」\nRetrieval: ${retrieved.map((m) => m.summary).join(" ／ ") || "なし"}`);
      for (const c of CONDS) {
        const { contexts } = contextsFor(c, pool, s, retrieved, states[s.user] ?? null);
        add(`### ${LABEL[c]}\n渡した経緯・仮説:\n${describeContexts(contexts)}`);
        for (let k = 1; k <= RUNS; k++) {
          setStatus(`${s.label} ${LABEL[c]} ${k}/${RUNS}`);
          try {
            const r = await chat(s, retrieved, contexts);
            add(`#### ${LABEL[c]} ${k}（${r.ms}ms・${r.chars}字）\n${r.text}`);
          } catch (e) {
            add(`#### ${LABEL[c]} ${k} 失敗: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  }

  /** a hypothesis used in a conversation, then the user's answer: a clear correction / an unclear answer / an agreement */
  async function correction() {
    const base = states.B;
    if (!base) { add("先に生成してください"); return; }
    const pool = MEM.B();
    const s = SCENARIOS.find((x) => x.id === "b-sister")!;
    const retrieved = retrieve(pool, s);
    const variants: [string, string][] = [
      ["明確な訂正", "いや、複雑ってほどじゃないよ。口出しも別に気にしてないし、姉には普通に感謝してる"],
      ["曖昧", "うーん、どうだろうね"],
      ["相づち", "そうかも"],
    ];
    for (const [name, answer] of variants) {
      setStatus(`訂正の流れ：${name}`);
      const st = store(base);
      const state0 = st.snapshot();
      const { contexts, shownIds } = contextsFor("synthesis", pool, s, retrieved, state0);
      if (shownIds.length === 0) { add(`## 訂正の流れ（${name}）: 「${s.latest}」で仮説が渡らなかったため確認できません\n${describeContexts(contexts)}`); continue; }
      const reply = await chat(s, retrieved, contexts);
      const shownAt = Date.now();
      const conv = {
        id: `eval-conv-${name}`,
        persona: "analyst",
        turns: [
          { role: "user", content: s.latest, timestamp: new Date(shownAt - 1000).toISOString() },
          { role: "ai", content: reply.text, timestamp: new Date(shownAt + 1000).toISOString() },
          { role: "user", content: answer, timestamp: new Date(shownAt + 2000).toISOString() },
        ],
      } as unknown as Conversation;
      await st.commit({ putHypotheses: state0.hypotheses.filter((h) => shownIds.includes(h.id)).map((h) => ({ ...h, shownIn: [{ conversationId: conv.id, at: new Date(shownAt).toISOString() }] })) });
      // an agreement turned into a Memory by Capture (no substantive words) must not become evidence
      const extra = name === "相づち" ? [{ ...pool[0], id: "eval-agree", conversationId: conv.id, keywords: ["姉"], summary: "そうかもしれないと話した。", content: "そうかも", evidenceQuotes: ["そうかも"], statedAt: new Date(shownAt).toISOString(), date: new Date(shownAt).toISOString(), createdAt: new Date(shownAt).toISOString(), updatedAt: new Date(shownAt).toISOString() } as MemoryObject] : [];
      const later = shownAt + 25 * 3_600_000;
      const out = await runSynthesisOnce(deps(st, [...pool, ...extra], later, [conv], add));
      const after = st.snapshot();
      add(`## 訂正の流れ（${name}）ユーザー：「${answer}」\n使った仮説: ${state0.hypotheses.filter((h) => shownIds.includes(h.id)).map((h) => h.statement).join(" ／ ")}\nTsumugiの返答: ${reply.text}\n再生成: ${JSON.stringify(out)}\n記録された反応: ${after.reactions.map((r) => `[${r.kind}] 「${r.userQuote}」→ ${r.hypothesisStatement}`).join(" ／ ") || "なし"}\n仮説の状態: ${after.hypotheses.map((h) => `${h.status}:${h.statement}`).join(" ／ ")}\n「eval-agree」が根拠に使われたか: ${after.hypotheses.some((h) => h.evidence.some((e) => e.memoryId === "eval-agree")) ? "使われた（NG）" : "使われていない"}`);
      for (let k = 1; k <= RUNS; k++) {
        const next = contextsFor("synthesis", [...pool, ...extra], s, retrieved, after);
        const reappeared = after.reactions.some((r) => next.contexts.some((c) => c.items.some((i) => textSimilarity(i.statement, r.hypothesisStatement) >= 0.35)));
        const r = await chat(s, retrieved, next.contexts);
        add(`#### 訂正後の会話 ${k}（${r.ms}ms）渡した仮説: ${next.contexts.flatMap((c) => c.items.map((i) => i.statement)).join(" ／ ") || "なし"}／否定した見方の再提示: ${reappeared ? "あり（NG）" : "なし"}\n${r.text}`);
      }
    }
  }

  /** no AI: an evidence Memory deleted, and the theme's state changed */
  function staleness() {
    const base = states.A;
    if (!base) { add("先に生成してください"); return; }
    const pool = MEM.A();
    const byId = (ms: MemoryObject[]) => new Map(ms.map((m) => [m.id, m] as const));
    for (const h of base.hypotheses) {
      const without = pool.filter((m) => m.id !== h.evidence[0].memoryId);
      const at = new Date().toISOString();
      const changed = [...pool, { ...pool[0], id: "eval-state", conversationId: "eval-conv-state", keywords: [h.themeLabel], summary: `${h.themeLabel}のことは、先週ついに終わったと話した。`, content: "終わった", evidenceQuotes: ["終わった"], statedAt: at, date: at, createdAt: at, updatedAt: at } as MemoryObject];
      add(`- 「${h.statement}」 そのまま:${unusableReason(h, byId(pool), themeSnapshot(h.themeLabel, pool).stateFingerprint, base.reactions, Date.now()) ?? "使用可"} ／ 根拠を1件削除:${unusableReason(h, byId(without), themeSnapshot(h.themeLabel, without).stateFingerprint, base.reactions, Date.now()) ?? "使用可"} ／ 状態が変化:${unusableReason(h, byId(changed), themeSnapshot(h.themeLabel, changed).stateFingerprint, base.reactions, Date.now()) ?? "使用可"}`);
    }
  }

  async function all() {
    setLog([]);
    try {
      await generate();
      staleness();
      await correction();
      await compare();
      setStatus("完了");
    } catch (e) {
      setStatus(`失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function correctionOnly() {
    setLog([]);
    try {
      await generate();
      await correction();
      setStatus("完了");
    } catch (e) {
      setStatus(`失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6 text-sm">
      <h1 className="text-lg font-medium">Memory Synthesis S1 比較（Preview専用・架空データ・保存なし）</h1>
      <div className="flex gap-2"><button className="rounded-full border px-3 py-1" onClick={() => void all()}>全部実行</button><button className="rounded-full border px-3 py-1" onClick={() => void correctionOnly()}>生成と訂正のみ</button></div>
      {status && <p role="status">{status}</p>}
      <pre data-testid="synthesis-eval-log" className="whitespace-pre-wrap text-xs">{log.join("\n\n")}</pre>
    </main>
  );
}
