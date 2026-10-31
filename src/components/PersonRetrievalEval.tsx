"use client";

import { useState } from "react";
import { selectWithPersonRetrieval } from "@/lib/personRetrievalExperiment";
import { loadApiKey } from "@/lib/db";
import { GEMINI_API_KEY_HEADER } from "@/lib/apiKeyHeader";
import type { MemoryObject, RetrievedMemory } from "@/lib/types";

/**
 * Preview専用：人物Retrievalの比較（架空データのみ・保存なし・端末のデータに触れない）。マージ前に削除する。
 *   R2 : 人物Retrievalの改善案（personRetrievalExperiment.ts。本番のRetrievalは変更していない）
 *   R3 : R2＋関係・気持ちの話のときだけ、その人物の気持ちの記録を最大1件
 *   R3n: R3の改良（キーワードが一致する気持ちの記録。無ければこの人物の最新の気持ちの記録）
 *   R3x: R3の改良（キーワードが一致する気持ちの記録。無ければ追加しない）
 *   B  : 関連Memoryを手で渡す参考条件
 * 会話プロンプトは3条件とも現在のまま。
 */
type Cond = "R2" | "R3" | "R3n" | "R3x" | "B";
const CONDS: Cond[] = ["R2", "R3n"];
const RUNS = 2;

const at = (d: string) => `${d}T12:00:00.000Z`;
interface Row { id: string; day: string; keywords: string[]; summary: string; quote: string; person?: string; emotion?: boolean }
const ROWS: Row[] = [
  { id: "t-01", day: "2026-04-10", keywords: ["さきさん", "仕事", "二人"], summary: "さきさんと二人で進めてきた企画が形になり、息が合うと話した。", quote: "さきさんと二人だと、言わなくても通じる感じがある", person: "さきさん" },
  { id: "t-02", day: "2026-05-15", keywords: ["さきさん", "信頼"], summary: "さきさんは何でも話せる相手で、大切な存在だと話した。", quote: "さきさんには何でも話せる。大事な人なんだと思う", emotion: true },
  { id: "t-03", day: "2026-06-20", keywords: ["さきさん", "新メンバー", "嫉妬"], summary: "新しいメンバーが加わり、さきさんと新メンバーが親しげなのを見て、少し嫉妬したと話した。", quote: "二人で楽しそうにしてるの見て、ちょっと妬いた", emotion: true },
  { id: "t-04", day: "2026-07-25", keywords: ["さきさん", "距離"], summary: "さきさんと最近距離ができた気がして、寂しいと話した。", quote: "なんか最近さきさんと距離ある。寂しい", emotion: true },
  { id: "t-05", day: "2026-08-30", keywords: ["さきさん", "仕事"], summary: "さきさんとの打ち合わせが事務的で、前のように話せなかったと話した。", quote: "さきさんとの打ち合わせ、事務的に終わっちゃった", person: "さきさん" },
  { id: "t-06", day: "2026-09-25", keywords: ["さきさん", "関係性", "葛藤"], summary: "さきさんへの気持ちと、仕事上の距離の取り方との間で葛藤していると話した。", quote: "気持ちはあるけど、仕事だしどう距離取ればいいのか分からない", emotion: true },
  { id: "t-07", day: "2026-10-20", keywords: ["さきさん", "会話"], summary: "さきさんと久しぶりにゆっくり話せて、やっぱり大切だと感じたと話した。", quote: "久しぶりにさきさんとゆっくり話せた。やっぱり大事だな", person: "さきさん", emotion: true },
  { id: "t-13", day: "2026-10-28", keywords: ["さきさん", "仕事", "新メンバー"], summary: "さきさんと新メンバーの三人で、初めて企画の打ち合わせをしたと話した。", quote: "さきさんと新しい人と三人で初めて打ち合わせした", person: "さきさん" },
  { id: "t-08", day: "2026-10-01", keywords: ["仕事", "締め切り", "上司"], summary: "締め切りが重なり、上司への報告が負担だと話した。", quote: "締め切り重なってて、上司への報告がしんどい" },
  { id: "t-09", day: "2026-10-15", keywords: ["仕事", "チーム", "効率"], summary: "チームの進め方を効率化したいと話した。", quote: "チームの進め方、もっと効率よくしたい" },
  { id: "t-10", day: "2026-10-22", keywords: ["渡邊さん", "仕事", "距離"], summary: "渡邊さんとの打ち合わせで、渡邊さんが距離を置きたがっているように感じたと話した。", quote: "渡邊さん、なんか距離置きたそうだった", person: "渡邊さん" },
  { id: "t-11", day: "2026-09-10", keywords: ["まさきさん", "取引先"], summary: "取引先のまさきさんに見積もりを出したと話した。", quote: "まさきさんに見積もり出した", person: "まさきさん" },
  { id: "t-12", day: "2026-08-05", keywords: ["旅行", "行き先"], summary: "夏休みの行き先を決めたと話した。", quote: "夏休みの行き先決めた" },
];
function memories(variant?: "neg" | "oneoff"): MemoryObject[] {
  return [...ROWS, ...(variant ? VARIANT_ROWS[variant] : [])].map((r, i) => ({
    id: r.id, date: at(r.day), statedAt: at(r.day), types: r.emotion ? ["conversation", "emotion"] : ["conversation"], conversationId: `t-conv-${i + 1}`, content: r.summary, summary: r.summary, keywords: r.keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [r.quote],
    ...(r.person ? { personMentions: [{ id: `pm-${r.id}`, groupingKey: r.person, displayName: r.person, assertion: "mention", stated: "explicit", quote: r.quote, statedAt: at(r.day), sourceConversationId: `t-conv-${i + 1}` }] } : {}),
    createdAt: at(r.day), updatedAt: at(r.day), metadata: { id: `meta-${r.id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at(r.day), updatedAt: at(r.day) },
  }) as unknown as MemoryObject);
}
const SAKI = ["t-01", "t-02", "t-03", "t-04", "t-05", "t-06", "t-07", "t-13"];

const U1 = "さきさんとは今まで2人で仕事してきたけど、今回はもう一人入ってる。どうしても2人での呼吸になっちゃうときがある";
const A1 = "3人体制になったばかりだと、これまでの2人のリズムが出やすいですよね。新しく入った方にも情報が届くよう、進め方を少し共有しておくといいかもしれません。";
const U2 = "そもそも2人だけの空気感でいたいんだよほんとは";
const A2 = "効率の面では、慣れた2人の方が速いこともありますよね。体制について上司に相談してみるのも一つの方法だと思います。";
const U3 = "違う。彼女を大切に思ってきたからそう思ってるんだよ";
const A3 = "そうだったんですね。さきさんを大切に思ってきたからこそ、2人の時間を守りたいと感じているんですね。";
const U4 = "さきさんも距離取りたいのかもしれないからちょうどいいんじゃない？";
interface Scenario { id: string; label: string; prior: [string, string][]; latest: string; relevant: string[]; variant?: "neg" | "oneoff" }
const SCENARIOS: Scenario[] = [
  { id: "oneoff-t2", label: "最新は一時的な苛立ち、「大切」が繰り返されている：「2人だけの空気感」", prior: [[U1, A1]], latest: U2, relevant: SAKI, variant: "oneoff" },
];
const VARIANT_ROWS: Record<"neg" | "oneoff", Row[]> = {
  neg: [{ id: "t-14", day: "2026-10-29", keywords: ["さきさん", "怒り"], summary: "さきさんに腹が立って、少し距離を置きたいと話した。", quote: "さきさんにちょっと腹立った。少し距離置きたい", emotion: true }],
  oneoff: [
    { id: "t-16", day: "2026-09-10", keywords: ["さきさん", "大切"], summary: "さきさんのことをやっぱり大切に思うと話した。", quote: "やっぱりさきさんのこと大切なんだと思う", emotion: true },
    { id: "t-17", day: "2026-10-12", keywords: ["さきさん", "大切"], summary: "さきさんはやっぱり大切な存在だと改めて話した。", quote: "さきさんはやっぱり大切", emotion: true },
    { id: "t-15", day: "2026-10-29", keywords: ["さきさん", "苛立ち"], summary: "さきさんの一言に少しイラッとしたと話した。", quote: "さきさんの一言、ちょっとイラッとした", emotion: true },
  ],
};

const LABELS = ["欲求", "深層", "無意識", "本当は", "依存", "承認欲", "心を守", "自分を守", "防衛", "言い聞かせ"];
function flags(s: Scenario, text: string): string {
  const body = text.trim();
  const f: string[] = [];
  const names = ["さきさん", "渡邊", "まさき"].filter((n) => body.includes(n) && !s.latest.includes(n.replace("さん", "")) && !s.prior.some(([u]) => u.includes(n.replace("さん", ""))));
  if (names.length) f.push(`会話に出ていない人物:${names.join("/")}(要確認)`);
  const lab = LABELS.filter((t) => body.includes(t));
  if (lab.length) f.push(`心理表現:${lab.join("/")}`);
  if (/^(そうですね|そうだね|確かに|たしかに|いいと思|それもいい|ちょうどいい)/.test(body)) f.push("冒頭が同意");
  if (["work", "work2", "collision"].includes(s.id) && /寂し|嫉妬|妬|大切に思|気持ち|距離|関係/.test(body)) f.push("業務の話に気持ちの解釈(要確認)");
  f.push(`質問${(body.match(/[？?]/g) ?? []).length}`);
  f.push(`${body.length}字`);
  return f.join(" / ");
}

const toR = (m: MemoryObject): RetrievedMemory => ({ id: m.id, date: m.date, eventTime: m.eventTime, eventTimePrecision: m.eventTimePrecision, summary: m.summary, keywords: m.keywords, source: m.metadata.source });
async function headers(): Promise<Record<string, string>> {
  const key = await loadApiKey().catch(() => undefined);
  return { "Content-Type": "application/json", ...(key ? { [GEMINI_API_KEY_HEADER]: key } : {}) };
}

export default function PersonRetrievalEval() {
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const add = (line: string) => setLog((l) => [...l, line]);

  async function run() {
    setLog([]);
    try {
      for (const s of SCENARIOS) {
        const pool = memories(s.variant);
        const userTurns = [...s.prior.map(([u]) => u), s.latest];
        add(`# ${s.label}\nユーザー：「${s.latest}」`);
        for (const c of CONDS) {
          let retrieved: MemoryObject[];
          let note = "";
          if (c === "B") {
            retrieved = pool.filter((m) => s.relevant.includes(m.id)).sort((a, b) => a.date.localeCompare(b.date));
            note = "手渡し";
          } else {
            const t0 = performance.now();
            const r = selectWithPersonRetrieval(pool, s.latest, userTurns, { feelingSlot: c !== "R2", feelingPick: c === "R3n" ? "newest" : c === "R3x" ? "none" : "tie", now: Date.parse("2026-11-01T12:00:00.000Z") });
            retrieved = r.memories;
            note = `選定 ${(performance.now() - t0).toFixed(1)}ms／対象人物: ${r.target ? `${r.target.key}（${r.target.how === "named" ? "名前あり" : "引き継ぎ"}）` : "なし"}／追加: ${r.added.map((a) => `${a.id}（${a.why}）`).join("、") || "なし"}／除外: ${r.dropped.map((d) => `${d.id}（${d.why}）`).join("、") || "なし"}${c !== "R2" ? `／気持ちの記録: ${r.feeling ? (r.feeling.added ? `${r.feeling.added}（${r.feeling.why}）` : r.feeling.why) : "対象人物なし"}` : ""}`;
          }
          add(`## ${c}\n渡したMemory（${retrieved.length}件）: ${retrieved.map((m) => `[${m.id}] ${m.summary}`).join(" ／ ") || "なし"}\n${note}`);
          for (let k = 1; k <= RUNS; k++) {
            setStatus(`${s.label} ${c} ${k}/${RUNS}`);
            const ts = () => new Date().toISOString();
            const turns = [...s.prior.flatMap(([u, a]) => [{ role: "user", content: u, timestamp: ts() }, { role: "ai", content: a, timestamp: ts() }]), { role: "user", content: s.latest, timestamp: ts() }];
            const t0 = performance.now();
            const res = await fetch("/api/chat", { method: "POST", headers: await headers(), body: JSON.stringify({ persona: "analyst", turns, retrievedMemories: retrieved.map(toR) }) });
            const text = await res.text();
            if (!res.ok) { add(`### ${c} ${k} 失敗 ${res.status}: ${text.slice(0, 120)}`); continue; }
            add(`### ${c} ${k}（${Math.round(performance.now() - t0)}ms）[${flags(s, text)}]\n${text}`);
          }
        }
      }
      setStatus("完了");
    } catch (e) {
      setStatus(`失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6 text-sm">
      <h1 className="text-lg font-medium">人物Retrievalの比較（Preview専用・架空データ・保存なし）</h1>
      <button className="self-start rounded-full border px-3 py-1" onClick={() => void run()}>実行</button>
      {status && <p role="status">{status}</p>}
      <pre data-testid="person-eval-log" className="whitespace-pre-wrap text-xs">{log.join("\n\n")}</pre>
    </main>
  );
}
