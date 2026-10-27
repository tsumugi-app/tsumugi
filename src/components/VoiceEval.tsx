"use client";

import { useState } from "react";
import { computeKeywordFrequency, DEFAULT_LIMIT, scoreMemory, selectConversationDirectMatches } from "@/lib/retrieval";
import { FICTIONAL_USERS } from "@/lib/synthesisFictionalData";
import type { MemoryObject, RetrievedMemory } from "@/lib/types";

/**
 * Preview専用：同じ架空Memory・同じ発言で、2条件（現行プロンプト / 改善プロンプト。thinking budgetはどちらも現行）を複数回比較する。
 * Retrievalは本番と同じ関数（会話＝selectConversationDirectMatches、日記＝scoreMemory上位3件）を架空Memoryに適用する。保存は一切しない。
 */
type Variant = "legacy" | "improved";
const VARIANTS: Variant[] = ["legacy", "improved"];
const LABEL: Record<Variant, string> = { legacy: "現行", improved: "改善プロンプト" };
const RUNS = 4;

const at = (d: string) => `${d}T12:00:00.000Z`;
function sakiMemories(): MemoryObject[] {
  const rows: [string, string, string[]][] = [
    ["2026-05-10", "さきさんと距離ができて、少しモヤモヤしていると話した。", ["友人関係", "モヤモヤ"]],
    ["2026-06-21", "さきさんとは学生時代からの付き合いで、何でも話せる相手だったと話した。", ["友人関係", "学生時代"]],
    ["2026-08-02", "さきさんに連絡しようか迷ったが、結局できなかったと話した。", ["友人関係", "連絡"]],
    ["2026-09-14", "さきさんと久しぶりに長く話せて、名残惜しかったと話した。", ["友人関係", "会話"]],
    ["2026-10-12", "さきさんの言葉に救われたことを思い出したと話した。", ["友人関係", "支え"]],
    ["2026-07-05", "仕事の締め切りがきついと話した。", ["仕事", "締め切り"]],
  ];
  return rows.map(([d, summary, keywords], i) => ({
    id: `saki-${i}`, date: at(d), statedAt: at(d), types: ["conversation"], conversationId: `saki-conv-${i}`, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [],
    ...(summary.includes("さきさん") ? { personMentions: [{ id: `pm-${i}`, groupingKey: "さきさん", displayName: "さきさん", assertion: "mention", stated: "explicit", quote: "さきさん", statedAt: at(d), sourceConversationId: `saki-conv-${i}` }] } : {}),
    createdAt: at(d), updatedAt: at(d), metadata: { id: `m-${i}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at(d), updatedAt: at(d) },
  }) as unknown as MemoryObject);
}
const DATA: Record<string, () => MemoryObject[]> = { A: FICTIONAL_USERS[0].memories, B: FICTIONAL_USERS[1].memories, C: FICTIONAL_USERS[2].memories, S: sakiMemories };

interface Scenario { id: string; label: string; user: keyof typeof DATA; persona: "analyst" | "companion"; prior: [string, string][]; latest: string; kind: "opinion" | "plain" | "no-memory" | "diary" | "record"; concrete: string[] }
const SCENARIOS: Scenario[] = [
  { id: "op-work", label: "意見：仕事", user: "A", persona: "analyst", prior: [], latest: "今の会社、このままでいいと思う？", kind: "opinion", concrete: ["保留", "異動", "デザイン", "勉強", "企画", "安定", "転職"] },
  { id: "op-sister", label: "意見：姉", user: "B", persona: "analyst", prior: [], latest: "姉のことなんだけど、私にとってどういう存在なんだろう", kind: "opinion", concrete: ["口出し", "預か", "頼", "距離", "相談"] },
  { id: "op-friend", label: "意見：拓也", user: "C", persona: "analyst", prior: [], latest: "拓也にまた連絡するべきかな。どう思う？", kind: "opinion", concrete: ["飲", "怖", "負担", "重", "久しぶり", "楽しかった", "寂し"] },
  { id: "op-saki", label: "意見：さきさん（名前省略4ターン後）", user: "S", persona: "analyst", prior: [["さきさんについて話したい", "うん、聞かせて。"], ["以前はモヤモヤしていた", "そうだったんだね。"], ["最近はもっと話したい", "うん。"], ["前みたいに名残惜しくなるまで話したい", "うん、そう思えるのはいいね。"]], latest: "彼女は自分にとってどういう存在なんだろう", kind: "opinion", concrete: ["学生時代", "何でも話せ", "救われ", "名残惜", "連絡", "距離"] },
  { id: "plain-change", label: "変化の報告（意見は求めていない）", user: "C", persona: "analyst", prior: [], latest: "英語、最近また夜にちょっとずつやれてる", kind: "plain", concrete: ["朝", "途切", "引っ越", "50日", "オンライン", "体験", "アプリ"] },
  { id: "plain-mood", label: "気分の一言（意見は求めていない）", user: "A", persona: "analyst", prior: [], latest: "なんか今日はやる気が出ない", kind: "plain", concrete: [] },
  { id: "nomem-opinion", label: "記憶の無い話題での意見", user: "A", persona: "analyst", prior: [], latest: "新しいシャンプー、ラベンダーとシトラスどっちがいいと思う？", kind: "no-memory", concrete: [] },
  { id: "diary", label: "日記", user: "A", persona: "companion", prior: [], latest: "今日は久しぶりに走って、気持ちよかった", kind: "diary", concrete: ["寒", "大会", "完走", "10キロ", "すっきり", "川沿い"] },
  { id: "record", label: "記録モード", user: "A", persona: "analyst", prior: [["今の会社のこと、異動が保留になってからずっと考えてる", "うん、聞いてるよ。"], ["デザインの勉強は続けたいけど、時間が取れない", "そうなんだね。"]], latest: "ここまでの話を記録して", kind: "record", concrete: [] },
];

function retrieve(s: Scenario): RetrievedMemory[] {
  const pool = DATA[s.user]();
  const toR = (m: MemoryObject): RetrievedMemory => ({ id: m.id, date: m.date, eventTime: m.eventTime, eventTimePrecision: m.eventTimePrecision, summary: m.summary, keywords: m.keywords, source: m.metadata.source });
  if (s.persona === "companion") {
    return pool.map((m) => ({ m, score: scoreMemory(m, s.latest) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, DEFAULT_LIMIT).map((x) => toR(x.m));
  }
  const userTurns = [...s.prior.map(([u]) => u), s.latest];
  return selectConversationDirectMatches(pool, s.latest, userTurns, computeKeywordFrequency(pool), DEFAULT_LIMIT).kept.map((e) => toR(e.memory));
}

const VIEW = /思う|思います|見ている|見えます|気がする|気がします|だろうと|可能性が高|私は|私なら|私から見る|じゃないかな|ではないか/;
const LABELS = ["心を守", "自分を守", "欲求", "求めている", "深層", "無意識", "本当は", "防衛", "逃避", "依存", "承認欲", "性格"];
const GENERIC = /人それぞれ|自分の気持ちを大切|正解はない|焦らなくて|無理しないで|無理をしないで/;
const PAST = /以前|前に|この前|先日|話してくれ|話していた|話してた|言ってた|言っていた/;

interface Reply { text: string; ms: number; flags: string }
function evaluate(s: Scenario, text: string, retrievedCount: number): string {
  const body = text.trim();
  const sentences = body.split(/(?<=[。！？?!])\s*/).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? "";
  const q = (body.match(/[？?]/g) ?? []).length;
  const f: string[] = [];
  f.push(VIEW.test(body.slice(0, 140)) ? "見解:冒頭あり" : VIEW.test(body) ? "見解:後半" : "見解:なし");
  f.push(`質問${q}${/[？?]\s*$/.test(last) ? "・質問で終わる" : ""}`);
  if (s.concrete.length) f.push(`具体語${s.concrete.filter((t) => body.includes(t)).length}`);
  const lab = LABELS.filter((t) => body.includes(t)); if (lab.length) f.push(`心理ラベル:${lab.join("/")}`);
  if (GENERIC.test(body)) f.push("一般論あり");
  if ((s.kind === "no-memory" || retrievedCount === 0) && PAST.test(body)) f.push("過去への言及(記憶なし)要確認");
  if (s.kind === "record") f.push(/^(#|-|・|\*)/m.test(body) && !/[？?]\s*$/.test(body) ? "記録形式OK" : "記録形式NG");
  f.push(`${body.length}字`);
  return f.join(" / ");
}

async function chat(s: Scenario, retrieved: RetrievedMemory[], variant: Variant): Promise<Reply> {
  const turns = [...s.prior.flatMap(([u, a]) => [{ role: "user", content: u, timestamp: new Date().toISOString() }, { role: "ai", content: a, timestamp: new Date().toISOString() }]), { role: "user", content: s.latest, timestamp: new Date().toISOString() }];
  const t0 = performance.now();
  const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona: s.persona, turns, retrievedMemories: retrieved, evalVariant: variant }) });
  const text = await res.text();
  return { text, ms: Math.round(performance.now() - t0), flags: evaluate(s, text, retrieved.length) };
}

interface Row { s: Scenario; retrieved: RetrievedMemory[]; replies: Record<Variant, Reply[]> }

export default function VoiceEval() {
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState("");
  async function run(ids: string[]) {
    const out: Row[] = [];
    for (const s of SCENARIOS.filter((x) => ids.includes(x.id))) {
      const retrieved = retrieve(s);
      const row: Row = { s, retrieved, replies: { legacy: [], improved: [] } };
      for (let k = 0; k < RUNS; k++) for (const v of VARIANTS) { setStatus(`${s.label}：${LABEL[v]} ${k + 1}/${RUNS}`); row.replies[v].push(await chat(s, retrieved, v)); }
      out.push(row); setRows([...out]);
    }
    setStatus(`完了（chat ${out.length * RUNS * VARIANTS.length}回）`);
  }
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 text-sm">
      <h1 className="text-lg font-medium">会話の声 比較（Preview専用・架空データ）</h1>
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((s) => <button key={s.id} className="rounded-full border px-3 py-1" onClick={() => run([s.id])}>{s.label}</button>)}
        <button className="rounded-full border px-3 py-1" onClick={() => run(SCENARIOS.map((s) => s.id))}>全部</button>
      </div>
      {status && <p role="status">{status}</p>}
      {rows.map((r) => (
        <section key={r.s.id} data-testid={`row-${r.s.id}`} className="flex flex-col gap-2 rounded-xl border p-3">
          <h2 className="font-medium">{r.s.label}（{r.s.persona}）：「{r.s.latest}」</h2>
          <p className="text-xs">Retrieval: {r.retrieved.length === 0 ? "なし" : r.retrieved.map((m) => m.summary).join(" ／ ")}</p>
          {VARIANTS.map((v) => r.replies[v].map((rep, k) => <div key={`${v}${k}`}><b>{LABEL[v]} {k + 1}（{rep.ms}ms）[{rep.flags}]</b><p className="whitespace-pre-wrap">{rep.text}</p></div>))}
        </section>
      ))}
    </main>
  );
}
