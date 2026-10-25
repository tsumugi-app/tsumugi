"use client";

import { useState } from "react";
import { scoreMemory, DEFAULT_LIMIT } from "@/lib/retrieval";
import { buildSynthesisClusters, buildSynthesisSection, selectSynthesisForTurn, type SynthesisItem, type SynthesisThemeContext } from "@/lib/memorySynthesis";
import { fictionalSynthesisMemories, REPLY_LABEL_TERMS, SYNTHESIS_EVAL_SCENARIOS, type SynthesisEvalScenario } from "@/lib/synthesisFictionalData";
import type { RetrievedMemory } from "@/lib/types";

/**
 * Preview専用：同じ架空ユーザー・同じ発言に対する「従来（Retrievalのみ）」と「Synthesisあり」を、それぞれ複数回比較する。
 * Retrievalは通常会話（companion）と同じ直接一致のスコア（scoreMemory、上位DEFAULT_LIMIT件）を、IndexedDBの代わりに架空Memoryへ適用する。
 * 保存は一切しない。生成の失敗（API／出力）と、正常な0件（提案なし／全件不採用）は区別して表示する。
 */
const memories = fictionalSynthesisMemories();
const GENERATIONS = 3;
const REPLIES_PER_MODE = 2;

function retrieve(text: string): RetrievedMemory[] {
  return memories
    .map((m) => ({ m, score: scoreMemory(m, text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_LIMIT)
    .map(({ m }) => ({ id: m.id, date: m.date, eventTime: m.eventTime, eventTimePrecision: m.eventTimePrecision, summary: m.summary, keywords: m.keywords, source: m.metadata.source }));
}

interface Reply { text: string; ms: number; status: number; askedAnswered: string[]; labels: string[]; concrete: string[]; past: string[] }

function check(s: SynthesisEvalScenario, text: string): Omit<Reply, "text" | "ms" | "status"> {
  return {
    askedAnswered: s.mustNotAsk.filter((t) => text.includes(t)),
    labels: REPLY_LABEL_TERMS.filter((t) => text.includes(t)),
    concrete: s.concreteTerms.filter((t) => text.includes(t)),
    past: (s.pastTerms ?? []).filter((t) => text.includes(t)),
  };
}

async function chat(s: SynthesisEvalScenario, retrievedMemories: RetrievedMemory[], synthesis?: SynthesisThemeContext[]): Promise<Reply> {
  const t0 = performance.now();
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona: "companion", turns: [{ role: "user", content: s.userText, timestamp: new Date().toISOString() }], retrievedMemories, ...(synthesis && synthesis.length > 0 ? { synthesis } : {}) }),
  });
  const text = await res.text();
  return { text, ms: Math.round(performance.now() - t0), status: res.status, ...check(s, text) };
}

interface Generation { http: number; ms: number; outcome: string; items: SynthesisItem[]; proposed?: number; dropped?: Record<string, number> }
interface Row { s: SynthesisEvalScenario; retrievedIds: string[]; contexts: SynthesisThemeContext[]; sectionChars: number; baseline: Reply[]; withSynthesis: Reply[] }

export default function SynthesisEval() {
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("");

  async function run() {
    setRows([]); setGenerations([]);
    const clusters = buildSynthesisClusters(memories);
    const gens: Generation[] = [];
    for (let g = 0; g < GENERATIONS; g++) {
      setStatus(`Synthesisを生成しています（${g + 1}/${GENERATIONS}）…`);
      const t0 = performance.now();
      const res = await fetch("/api/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clusters }) });
      const data = (await res.json().catch(() => ({}))) as { status?: string; failure?: string; items?: SynthesisItem[]; proposed?: number; dropped?: Record<string, number> };
      const outcome = !res.ok ? `失敗（${data.failure ?? "unknown"}）` : data.status === "ok" ? "正常" : data.status === "no-proposals" ? "0件（提案なし）" : data.status === "all-rejected" ? "0件（全件が検証で不採用）" : "不明";
      gens.push({ http: res.status, ms: Math.round(performance.now() - t0), outcome, items: Array.isArray(data.items) ? data.items : [], proposed: data.proposed, dropped: data.dropped });
      setGenerations([...gens]);
    }
    const usable = gens.find((g) => g.http === 200 && g.items.length > 0);
    if (!usable) { setStatus("正常に生成されたSynthesisがありません。比較は行いません。"); return; }
    const out: Row[] = [];
    for (const s of SYNTHESIS_EVAL_SCENARIOS) {
      setStatus(`比較中: ${s.label}`);
      const retrieved = retrieve(s.userText);
      const contexts = selectSynthesisForTurn(usable.items, { userText: s.userText, retrievedMemoryIds: retrieved.map((r) => r.id) }, memories);
      const row: Row = { s, retrievedIds: retrieved.map((r) => r.id), contexts, sectionChars: buildSynthesisSection(contexts).length, baseline: [], withSynthesis: [] };
      for (let k = 0; k < REPLIES_PER_MODE; k++) {
        row.baseline.push(await chat(s, retrieved));
        row.withSynthesis.push(await chat(s, retrieved, contexts));
      }
      out.push(row); setRows([...out]);
    }
    setStatus(`完了（API呼び出し：synthesize ${GENERATIONS}回＋chat ${out.length * REPLIES_PER_MODE * 2}回）`);
  }

  const flags = (r: Reply) => [r.askedAnswered.length ? `回答済みを質問:${r.askedAnswered.join("/")}` : "", r.labels.length ? `ラベル:${r.labels.join("/")}` : "", r.past.length ? `無関係に過去を持ち出し:${r.past.join("/")}` : "", `具体語${r.concrete.length}(${r.concrete.join("/")})`].filter(Boolean).join(" ");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 text-sm text-stone-800 dark:text-stone-200">
      <h1 className="text-lg font-medium">Memory Synthesis 比較（Preview専用・架空データ）</h1>
      <p className="text-xs text-stone-500">架空の1人分のMemory {memories.length}件（2026年5〜10月）。保存は一切しません。生成{GENERATIONS}回、各発言につき従来{REPLIES_PER_MODE}回・Synthesisあり{REPLIES_PER_MODE}回。</p>
      <button className="self-start rounded-full border border-stone-300 px-4 py-2" onClick={run}>生成して比較する</button>
      {status && <p role="status">{status}</p>}
      {generations.map((g, n) => (
        <section key={n} data-testid={`generation-${n}`}>
          <h2 className="font-medium">生成{n + 1}：{g.outcome}（HTTP {g.http}・{g.ms}ms・提案{g.proposed ?? "-"}件→採用{g.items.length}件{g.dropped && Object.keys(g.dropped).length ? `・不採用 ${JSON.stringify(g.dropped)}` : ""}）</h2>
          <ul className="list-disc pl-5">{g.items.map((i, k) => <li key={k}>[{i.kind}/{i.support}/{i.theme}/{i.firstStatedAt.slice(0, 10)}〜{i.lastStatedAt.slice(0, 10)}] {i.statement}{i.situationNote ? `（状況: ${i.situationNote}）` : ""}</li>)}</ul>
        </section>
      ))}
      {rows.map((r) => (
        <section key={r.s.id} data-testid={`row-${r.s.id}`} className="flex flex-col gap-2 rounded-xl border border-stone-300 p-3">
          <h2 className="font-medium">{r.s.label}：「{r.s.userText}」</h2>
          <p className="text-xs">Retrieval: {r.retrievedIds.join(", ") || "なし"} ／ 渡したテーマ: {r.contexts.length === 0 ? "なし" : r.contexts.map((c) => `${c.theme}（経緯${c.timeline.length}点・整理${c.items.length}件）`).join(" / ")} ／ 追加文字数 {r.sectionChars}</p>
          {r.baseline.map((b, k) => <div key={`b${k}`}><b>従来{k + 1}（{b.ms}ms）[{flags(b)}]</b><p className="whitespace-pre-wrap">{b.text}</p></div>)}
          {r.withSynthesis.map((w, k) => <div key={`w${k}`}><b>Synthesisあり{k + 1}（{w.ms}ms）[{flags(w)}]</b><p className="whitespace-pre-wrap">{w.text}</p></div>)}
        </section>
      ))}
    </main>
  );
}
