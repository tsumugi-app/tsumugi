"use client";

import { useState } from "react";
import { scoreMemory, DEFAULT_LIMIT } from "@/lib/retrieval";
import { buildSynthesisClusters, selectSynthesisForTurn, withAnchors, type SynthesisItem } from "@/lib/memorySynthesis";
import { fictionalSynthesisMemories, SYNTHESIS_EVAL_SCENARIOS } from "@/lib/synthesisFictionalData";
import type { RetrievedMemory } from "@/lib/types";

/**
 * Preview専用：同じ架空ユーザー・同じ発言に対する「従来（Retrievalのみ）」と「Synthesisあり」の返答を並べる。
 * Retrievalは通常会話（companion）と同じ直接一致のスコア（scoreMemory、上位DEFAULT_LIMIT件）を、IndexedDBの代わりに架空Memoryへ適用する。
 * 保存は一切しない（このページは読み取り専用の比較のみ）。
 */
const memories = fictionalSynthesisMemories();

function retrieve(text: string): RetrievedMemory[] {
  return memories
    .map((m) => ({ m, score: scoreMemory(m, text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_LIMIT)
    .map(({ m }) => ({ id: m.id, date: m.date, eventTime: m.eventTime, eventTimePrecision: m.eventTimePrecision, summary: m.summary, keywords: m.keywords, source: m.metadata.source }));
}

async function chat(userText: string, retrievedMemories: RetrievedMemory[], synthesis?: SynthesisItem[]): Promise<{ text: string; ms: number; status: number }> {
  const t0 = performance.now();
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona: "companion", turns: [{ role: "user", content: userText, timestamp: new Date().toISOString() }], retrievedMemories, ...(synthesis && synthesis.length > 0 ? { synthesis } : {}) }),
  });
  const text = await res.text();
  return { text, ms: Math.round(performance.now() - t0), status: res.status };
}

interface Row { id: string; label: string; userText: string; retrievedIds: string[]; usedSynthesis: SynthesisItem[]; baseline: { text: string; ms: number }; withSynthesis: { text: string; ms: number } }

export default function SynthesisEval() {
  const [items, setItems] = useState<SynthesisItem[] | null>(null);
  const [synthMeta, setSynthMeta] = useState<{ ms: number; proposed: number; clusters: number; evidence: number } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("");

  async function run() {
    setStatus("Synthesisを生成しています…"); setRows([]);
    const clusters = buildSynthesisClusters(memories);
    const t0 = performance.now();
    const res = await fetch("/api/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clusters }) });
    const data = (await res.json().catch(() => ({}))) as { items?: SynthesisItem[]; proposed?: number; error?: string };
    // a failed generation is not "zero items": stop instead of comparing two columns that were both made without synthesis
    if (!res.ok || !Array.isArray(data.items)) { setStatus(`Synthesisの生成に失敗しました（${res.status}${data.error ? `: ${data.error}` : ""}）。比較は行いません。`); return; }
    const synth = data.items;
    setItems(synth);
    setSynthMeta({ ms: Math.round(performance.now() - t0), proposed: data.proposed ?? 0, clusters: clusters.length, evidence: new Set(clusters.flatMap((c) => c.evidence.map((e) => e.id))).size });
    const out: Row[] = [];
    for (const s of SYNTHESIS_EVAL_SCENARIOS) {
      setStatus(`比較中: ${s.label}`);
      const retrieved = retrieve(s.userText);
      const used = withAnchors(selectSynthesisForTurn(synth, { userText: s.userText, retrievedMemoryIds: retrieved.map((r) => r.id) }), memories);
      const baseline = await chat(s.userText, retrieved);
      const withSynthesis = await chat(s.userText, retrieved, used);
      out.push({ id: s.id, label: s.label, userText: s.userText, retrievedIds: retrieved.map((r) => r.id), usedSynthesis: used, baseline, withSynthesis });
      setRows([...out]);
    }
    setStatus(`完了（API呼び出し：synthesize 1回＋chat ${out.length * 2}回）`);
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 text-sm text-stone-800 dark:text-stone-200">
      <h1 className="text-lg font-medium">Memory Synthesis 比較（Preview専用・架空データ）</h1>
      <p className="text-xs text-stone-500">架空の1人分のMemory {memories.length}件（2026年5〜10月）。保存は一切しません。</p>
      <button className="self-start rounded-full border border-stone-300 px-4 py-2" onClick={run}>生成して比較する</button>
      {status && <p role="status">{status}</p>}
      {synthMeta && (
        <section>
          <h2 className="font-medium">Synthesis（{synthMeta.ms}ms・送ったテーマ{synthMeta.clusters}件・根拠候補{synthMeta.evidence}件・モデルの提案{synthMeta.proposed}件→検証後{items?.length ?? 0}件）</h2>
          <ul data-testid="synthesis-items" className="list-disc pl-5">
            {(items ?? []).map((i, n) => <li key={n}>[{i.kind}/{i.basis}/{i.theme}/{i.firstStatedAt.slice(0, 10)}〜{i.lastStatedAt.slice(0, 10)}] {i.statement}{i.situationNote ? `（状況: ${i.situationNote}）` : ""} 根拠: {i.evidenceIds.join(",")}</li>)}
          </ul>
        </section>
      )}
      {rows.map((r) => (
        <section key={r.id} data-testid={`row-${r.id}`} className="flex flex-col gap-2 rounded-xl border border-stone-300 p-3">
          <h2 className="font-medium">{r.label}：「{r.userText}」</h2>
          <p className="text-xs">Retrieval: {r.retrievedIds.join(", ") || "なし"} ／ 渡したSynthesis: {r.usedSynthesis.length === 0 ? "なし" : r.usedSynthesis.map((u) => `[${u.kind}] ${u.statement}`).join(" / ")}</p>
          <div><b>従来（{r.baseline.ms}ms）</b><p className="whitespace-pre-wrap">{r.baseline.text}</p></div>
          <div><b>Synthesisあり（{r.withSynthesis.ms}ms）</b><p className="whitespace-pre-wrap">{r.withSynthesis.text}</p></div>
        </section>
      ))}
    </main>
  );
}
