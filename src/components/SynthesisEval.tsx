"use client";

import { useState } from "react";
import { scoreMemory, DEFAULT_LIMIT } from "@/lib/retrieval";
import { buildSynthesisClusters, buildSynthesisSection, selectTimelineForTurn, type SynthesisItem, type SynthesisThemeContext } from "@/lib/memorySynthesis";
import { FICTIONAL_USERS, REPLY_LABEL_TERMS, type FictionalUser, type SynthesisEvalScenario } from "@/lib/synthesisFictionalData";
import type { MemoryObject, RetrievedMemory } from "@/lib/types";

/**
 * Preview専用：同じ架空ユーザー・同じ発言について3条件を、それぞれ複数回比較する。
 *   A 従来Retrievalのみ / B Retrieval＋Timeline（コードが作る経緯。Synthesis不要） / C Retrieval＋Timeline＋Synthesis
 * Retrievalは通常会話（companion）と同じ直接一致のスコア（scoreMemory、上位DEFAULT_LIMIT件）を架空Memoryへ適用する。保存は一切しない。
 * 生成の失敗（API／出力）と、正常な0件（提案なし／全件不採用）は区別して表示する。
 */
const RUNS = 2;
type Mode = "A" | "B" | "C";
const MODE_LABEL: Record<Mode, string> = { A: "A 従来", B: "B ＋Timeline", C: "C ＋Timeline＋Synthesis" };

function retrieve(memories: MemoryObject[], text: string): RetrievedMemory[] {
  return memories
    .map((m) => ({ m, score: scoreMemory(m, text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_LIMIT)
    .map(({ m }) => ({ id: m.id, date: m.date, eventTime: m.eventTime, eventTimePrecision: m.eventTimePrecision, summary: m.summary, keywords: m.keywords, source: m.metadata.source }));
}

interface Reply { text: string; ms: number; status: number; flags: string }

function check(s: SynthesisEvalScenario, text: string): string {
  const hit = (list: string[] | undefined) => (list ?? []).filter((t) => text.includes(t));
  return [
    hit(s.mustNotAsk).length ? `回答済みを質問:${hit(s.mustNotAsk).join("/")}` : "",
    hit(s.mustNotClaim).length ? `今の状態と矛盾:${hit(s.mustNotClaim).join("/")}` : "",
    hit(REPLY_LABEL_TERMS).length ? `心理ラベル:${hit(REPLY_LABEL_TERMS).join("/")}` : "",
    hit(s.pastTerms).length ? `無関係に過去を持ち出し:${hit(s.pastTerms).join("/")}` : "",
    s.currentTerms ? `今の状態の語${hit(s.currentTerms).length ? "あり" : "なし"}` : "",
    s.concreteTerms.length ? `具体語${hit(s.concreteTerms).length}(${hit(s.concreteTerms).join("/")})` : "",
  ].filter(Boolean).join(" ");
}

async function chat(s: SynthesisEvalScenario, retrievedMemories: RetrievedMemory[], synthesis?: SynthesisThemeContext[]): Promise<Reply> {
  const t0 = performance.now();
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona: "companion", turns: [{ role: "user", content: s.userText, timestamp: new Date().toISOString() }], retrievedMemories, ...(synthesis && synthesis.length > 0 ? { synthesis } : {}) }),
  });
  const text = await res.text();
  return { text, ms: Math.round(performance.now() - t0), status: res.status, flags: check(s, text) };
}

interface Generation { http: number; ms: number; outcome: string; items: SynthesisItem[]; proposed?: number; dropped?: Record<string, number> }
interface Row { s: SynthesisEvalScenario; retrievedIds: string[]; ctxB: SynthesisThemeContext[]; ctxC: SynthesisThemeContext[]; charsB: number; charsC: number; replies: Record<Mode, Reply[]> }

export default function SynthesisEval() {
  const [userId, setUserId] = useState(FICTIONAL_USERS[0].id);
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("");

  async function run(user: FictionalUser) {
    setRows([]); setGeneration(null);
    const memories = user.memories();
    const clusters = buildSynthesisClusters(memories);
    setStatus("Synthesisを生成しています…");
    const t0 = performance.now();
    const res = await fetch("/api/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clusters }) });
    const data = (await res.json().catch(() => ({}))) as { status?: string; failure?: string; items?: SynthesisItem[]; proposed?: number; dropped?: Record<string, number> };
    const outcome = !res.ok ? `失敗（${data.failure ?? "unknown"}）` : data.status === "ok" ? "正常" : data.status === "no-proposals" ? "0件（提案なし）" : data.status === "all-rejected" ? "0件（全件が検証で不採用）" : "不明";
    const gen: Generation = { http: res.status, ms: Math.round(performance.now() - t0), outcome, items: Array.isArray(data.items) ? data.items : [], proposed: data.proposed, dropped: data.dropped };
    setGeneration(gen);
    // a failed generation is not "zero items": condition C is then not run (A and B do not depend on it)
    const synthesisOk = res.ok;
    const out: Row[] = [];
    for (const s of user.scenarios) {
      setStatus(`比較中: ${s.label}`);
      const retrieved = retrieve(memories, s.userText);
      const turn = { userText: s.userText, retrievedMemoryIds: retrieved.map((r) => r.id) };
      const ctxB = selectTimelineForTurn(memories, turn);
      const ctxC = selectTimelineForTurn(memories, turn, gen.items);
      const row: Row = { s, retrievedIds: turn.retrievedMemoryIds, ctxB, ctxC, charsB: buildSynthesisSection(ctxB).length, charsC: buildSynthesisSection(ctxC).length, replies: { A: [], B: [], C: [] } };
      for (let k = 0; k < RUNS; k++) {
        row.replies.A.push(await chat(s, retrieved));
        row.replies.B.push(await chat(s, retrieved, ctxB));
        if (synthesisOk) row.replies.C.push(await chat(s, retrieved, ctxC));
      }
      out.push(row); setRows([...out]);
    }
    setStatus(`完了（API呼び出し：synthesize 1回＋chat ${out.reduce((n, r) => n + r.replies.A.length + r.replies.B.length + r.replies.C.length, 0)}回）`);
  }

  const user = FICTIONAL_USERS.find((u) => u.id === userId)!;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 text-sm text-stone-800 dark:text-stone-200">
      <h1 className="text-lg font-medium">Memory Timeline / Synthesis 比較（Preview専用・架空データ）</h1>
      <p className="text-xs text-stone-500">保存は一切しません。各発言につき A／B／C を{RUNS}回ずつ。</p>
      <div className="flex flex-wrap gap-2">
        {FICTIONAL_USERS.map((u) => <button key={u.id} className={`rounded-full border px-3 py-1 ${u.id === userId ? "border-stone-800" : "border-stone-300"}`} onClick={() => setUserId(u.id)}>{u.label}</button>)}
      </div>
      <button className="self-start rounded-full border border-stone-300 px-4 py-2" onClick={() => run(user)}>生成して比較する（{user.id}）</button>
      {status && <p role="status">{status}</p>}
      {generation && (
        <section data-testid="generation">
          <h2 className="font-medium">Synthesis生成：{generation.outcome}（HTTP {generation.http}・{generation.ms}ms・提案{generation.proposed ?? "-"}件→採用{generation.items.length}件{generation.dropped && Object.keys(generation.dropped).length ? `・不採用 ${JSON.stringify(generation.dropped)}` : ""}）</h2>
          <ul className="list-disc pl-5">{generation.items.map((i, k) => <li key={k}>[{i.kind}/{i.support}/{i.theme}] {i.statement}{i.situationNote ? `（状況: ${i.situationNote}）` : ""}</li>)}</ul>
        </section>
      )}
      {rows.map((r) => (
        <section key={r.s.id} data-testid={`row-${r.s.id}`} className="flex flex-col gap-2 rounded-xl border border-stone-300 p-3">
          <h2 className="font-medium">{r.s.label}：「{r.s.userText}」 {r.s.cases ? `［${r.s.cases.join("・")}］` : ""}</h2>
          <p className="text-xs">Retrieval: {r.retrievedIds.join(", ") || "なし"}</p>
          <p className="text-xs">B Timeline: {r.ctxB.length === 0 ? "渡さない" : r.ctxB.map((c) => `${c.theme}（${c.timeline.length}点・今の状態: ${c.timeline.find((p) => p.current)?.summary ?? "-"}）`).join(" / ")} ／ 追加{r.charsB}字</p>
          <p className="text-xs">C 整理: {r.ctxC.flatMap((c) => c.items).length === 0 ? "なし" : r.ctxC.flatMap((c) => c.items).map((i) => `[${i.kind}/${i.support}] ${i.statement}`).join(" / ")} ／ 追加{r.charsC}字</p>
          {(["A", "B", "C"] as Mode[]).map((m) => r.replies[m].map((rep, k) => (
            <div key={`${m}${k}`}><b>{MODE_LABEL[m]} {k + 1}（{rep.ms}ms）[{rep.flags}]</b><p className="whitespace-pre-wrap">{rep.text}</p></div>
          )))}
        </section>
      ))}
    </main>
  );
}
