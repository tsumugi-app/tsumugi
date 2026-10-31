"use client";

import { useState } from "react";
import { computeKeywordFrequency, DEFAULT_LIMIT, selectConversationDirectMatches } from "@/lib/retrieval";
import { buildSynthesisSection, buildThemeTimeline, type SynthesisCluster, type SynthesisItem, type SynthesisThemeContext } from "@/lib/memorySynthesis";
import { loadApiKey } from "@/lib/db";
import { GEMINI_API_KEY_HEADER } from "@/lib/apiKeyHeader";
import type { MemoryObject, RetrievedMemory } from "@/lib/types";

/**
 * Preview専用：感情理解の原因切り分け（架空データのみ・保存なし・端末のデータに触れない）。マージ前に削除する。
 *   A  : 現在のRetrieval＋現在の会話プロンプト
 *   R  : Retrievalの最小改善の試験（このページの中だけ）：人物名と同じキーワードを持つMemoryをその人物に結び付け、「2人」を「二人」として扱う
 *   B  : 関連する人物・感情Memoryを手で渡す＋現在の会話プロンプト
 *   C0 : B＋その人物の経緯（事実のみ。Cと同じ量の事実を足す対照）
 *   C  : C0＋人物Synthesisの試験的な出力（仮説）
 *   D  : A＋感情の共存を扱う最小限の会話プロンプト（Previewのみ有効）
 */
type Cond = "A" | "R" | "B" | "C0" | "C" | "D";
const CONDS: Cond[] = ["A", "R", "B", "C0", "C", "D"];
const CLABEL: Record<Cond, string> = { A: "A 現状", R: "R Retrieval最小改善(試験)", B: "B 関連Memoryを手渡し", C0: "C0 B＋事実のみ(対照)", C: "C B＋人物Synthesis", D: "D A＋プロンプト" };
const RUNS = 3;
const PERSON = "さきさん";

const at = (d: string) => `${d}T12:00:00.000Z`;
interface Row { id: string; day: string; keywords: string[]; summary: string; quote: string; person?: string }
const ROWS: Row[] = [
  { id: "t-01", day: "2026-04-10", keywords: ["さきさん", "仕事", "二人"], summary: "さきさんと二人で進めてきた企画が形になり、息が合うと話した。", quote: "さきさんと二人だと、言わなくても通じる感じがある", person: "さきさん" },
  { id: "t-02", day: "2026-05-15", keywords: ["さきさん", "信頼"], summary: "さきさんは何でも話せる相手で、大切な存在だと話した。", quote: "さきさんには何でも話せる。大事な人なんだと思う" },
  { id: "t-03", day: "2026-06-20", keywords: ["さきさん", "新メンバー", "嫉妬"], summary: "新しいメンバーが加わり、さきさんと新メンバーが親しげなのを見て、少し嫉妬したと話した。", quote: "二人で楽しそうにしてるの見て、ちょっと妬いた" },
  { id: "t-04", day: "2026-07-25", keywords: ["さきさん", "距離"], summary: "さきさんと最近距離ができた気がして、寂しいと話した。", quote: "なんか最近さきさんと距離ある。寂しい" },
  { id: "t-05", day: "2026-08-30", keywords: ["さきさん", "仕事"], summary: "さきさんとの打ち合わせが事務的で、前のように話せなかったと話した。", quote: "さきさんとの打ち合わせ、事務的に終わっちゃった", person: "さきさん" },
  { id: "t-06", day: "2026-09-25", keywords: ["さきさん", "関係性", "葛藤"], summary: "さきさんへの気持ちと、仕事上の距離の取り方との間で葛藤していると話した。", quote: "気持ちはあるけど、仕事だしどう距離取ればいいのか分からない" },
  { id: "t-07", day: "2026-10-20", keywords: ["さきさん", "会話"], summary: "さきさんと久しぶりにゆっくり話せて、やっぱり大切だと感じたと話した。", quote: "久しぶりにさきさんとゆっくり話せた。やっぱり大事だな", person: "さきさん" },
  // noise and safety: work in general, another person who "keeps a distance", a similar name, a word containing さき
  { id: "t-08", day: "2026-10-01", keywords: ["仕事", "締め切り", "上司"], summary: "締め切りが重なり、上司への報告が負担だと話した。", quote: "締め切り重なってて、上司への報告がしんどい" },
  { id: "t-09", day: "2026-10-15", keywords: ["仕事", "チーム", "効率"], summary: "チームの進め方を効率化したいと話した。", quote: "チームの進め方、もっと効率よくしたい" },
  { id: "t-10", day: "2026-10-22", keywords: ["渡邊さん", "仕事", "距離"], summary: "渡邊さんとの打ち合わせで、渡邊さんが距離を置きたがっているように感じたと話した。", quote: "渡邊さん、なんか距離置きたそうだった", person: "渡邊さん" },
  { id: "t-11", day: "2026-09-10", keywords: ["まさきさん", "取引先"], summary: "取引先のまさきさんに見積もりを出したと話した。", quote: "まさきさんに見積もり出した", person: "まさきさん" },
  { id: "t-12", day: "2026-08-05", keywords: ["旅行", "行き先"], summary: "夏休みの行き先を決めたと話した。", quote: "夏休みの行き先決めた" },
];
const RELEVANT = ["t-01", "t-02", "t-03", "t-04", "t-05", "t-06", "t-07"];

function memories(): MemoryObject[] {
  return ROWS.map((r, i) => ({
    id: r.id, date: at(r.day), statedAt: at(r.day), types: ["conversation"], conversationId: `t-conv-${i + 1}`, content: r.summary, summary: r.summary, keywords: r.keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], evidenceQuotes: [r.quote],
    ...(r.person ? { personMentions: [{ id: `pm-${r.id}`, groupingKey: r.person, displayName: r.person, assertion: "mention", stated: "explicit", quote: r.quote, statedAt: at(r.day), sourceConversationId: `t-conv-${i + 1}` }] } : {}),
    createdAt: at(r.day), updatedAt: at(r.day), metadata: { id: `meta-${r.id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at(r.day), updatedAt: at(r.day) },
  }) as unknown as MemoryObject);
}

// --- R: the minimal Retrieval change, simulated on a copy (production retrieval is unchanged) ---
const nfkc = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
function linkByKeyword(pool: MemoryObject[]): { pool: MemoryObject[]; linked: string[] } {
  const names = new Set(pool.flatMap((m) => (m.personMentions ?? []).map((p) => nfkc(p.displayName ?? ""))).filter((n) => Array.from(n).length >= 2));
  const linked: string[] = [];
  const out = pool.map((m) => {
    const have = new Set((m.personMentions ?? []).map((p) => nfkc(p.displayName ?? "")));
    const add = (m.keywords ?? []).map(nfkc).filter((k) => names.has(k) && !have.has(k)); // exact keyword = a known name (never a substring)
    if (add.length === 0) return m;
    linked.push(`${m.id}→${add.join(",")}`);
    return { ...m, personMentions: [...(m.personMentions ?? []), ...add.map((n) => ({ id: `link-${m.id}-${n}`, groupingKey: n, displayName: n, assertion: "mention", stated: "explicit", quote: "", statedAt: m.statedAt, sourceConversationId: m.conversationId }))] } as unknown as MemoryObject;
  });
  return { pool: out, linked };
}
const normalizeTwo = (t: string) => t.replace(/2人|２人/g, "二人");

const toR = (m: MemoryObject): RetrievedMemory => ({ id: m.id, date: m.date, eventTime: m.eventTime, eventTimePrecision: m.eventTimePrecision, summary: m.summary, keywords: m.keywords, source: m.metadata.source });

// --- scenario (the fixed earlier Tsumugi replies paraphrase the reported real exchange; only the target turn is generated) ---
const U1 = "さきさんとは今まで2人で仕事してきたけど、今回はもう一人入ってる。どうしても2人での呼吸になっちゃうときがある";
const A1 = "3人体制になったばかりだと、これまでの2人のリズムが出やすいですよね。新しく入った方にも情報が届くよう、進め方を少し共有しておくといいかもしれません。";
const U2 = "そもそも2人だけの空気感でいたいんだよほんとは";
const A2 = "効率の面では、慣れた2人の方が速いこともありますよね。体制について上司に相談してみるのも一つの方法だと思います。";
const U3 = "違う。彼女を大切に思ってきたからそう思ってるんだよ";
const A3 = "そうだったんですね。さきさんを大切に思ってきたからこそ、2人の時間を守りたいと感じているんですね。";
const U4 = "さきさんも距離取りたいのかもしれないからちょうどいいんじゃない？";
interface Turn { id: string; label: string; prior: [string, string][]; latest: string }
const TURNS: Turn[] = [
  { id: "t2", label: "確認1：「2人だけの空気感」", prior: [[U1, A1]], latest: U2 },
  { id: "t2k", label: "確認1（表記：二人）", prior: [[U1.replace(/2人/g, "二人"), A1]], latest: U2.replace("2人", "二人") },
  { id: "t4", label: "確認2・3：「距離取りたいならちょうどいい」", prior: [[U1, A1], [U2, A2], [U3, A3]], latest: U4 },
];

const PERSONAL = /大切|大事|気持ち|思い|寂し|特別|一緒にいたい|二人の時間|2人の時間/;
const EARLIER = /大切|大事|二人でいたい|2人でいたい|二人だけ|2人だけ|二人の時間|2人の時間|一緒にいたい/;
const AGREE_OPEN = /^(そうですね|そうだね|確かに|たしかに|いいと思|それもいい|ちょうどいい)/;
const LABELS = ["欲求", "深層", "無意識", "本当は", "依存", "承認欲", "心を守", "防衛"];
function flags(turn: Turn, text: string): string {
  const body = text.trim();
  const f: string[] = [];
  f.push(PERSONAL.test(body) ? "個人的な思い:触れる" : "個人的な思い:触れない");
  if (turn.id === "t4") f.push(EARLIER.test(body) ? "以前の願望:保持" : "以前の願望:無し");
  if (AGREE_OPEN.test(body)) f.push("冒頭が同意");
  if (/渡邊|まさき|行き先|旅行/.test(body)) f.push("他の人物・無関係なMemoryに言及(要確認)");
  const lab = LABELS.filter((t) => body.includes(t));
  if (lab.length) f.push(`心理ラベル:${lab.join("/")}`);
  f.push(`${body.length}字`);
  return f.join(" / ");
}

async function headers(): Promise<Record<string, string>> {
  const key = await loadApiKey().catch(() => undefined);
  return { "Content-Type": "application/json", ...(key ? { [GEMINI_API_KEY_HEADER]: key } : {}) };
}

export default function EmotionEval() {
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const add = (line: string) => setLog((l) => [...l, line]);

  async function personSynthesis(pool: MemoryObject[]): Promise<SynthesisItem[]> {
    const cluster: SynthesisCluster = {
      theme: PERSON,
      evidence: pool.filter((m) => RELEVANT.includes(m.id)).map((m) => ({ id: m.id, conversationId: m.conversationId as string, statedAt: m.statedAt as string, statedAtIsRecordDate: false, summary: m.summary, quote: m.evidenceQuotes?.[0] })),
    };
    const t0 = performance.now();
    const res = await fetch("/api/diagnostics/person-synthesis", { method: "POST", headers: await headers(), body: JSON.stringify({ cluster }) });
    const body = (await res.json()) as { items?: SynthesisItem[]; dropped?: unknown; error?: string };
    add(`## 人物Synthesis（試験・${Math.round(performance.now() - t0)}ms）status ${res.status} 落とした項目 ${JSON.stringify(body.dropped ?? body.error)}\n${(body.items ?? []).map((i) => `- [${i.kind}/${i.support}] ${i.statement}${i.situationNote ? `（状況: ${i.situationNote}）` : ""}\n  根拠: ${i.evidenceIds.join(", ")}`).join("\n") || "（なし）"}`);
    return body.items ?? [];
  }

  async function run() {
    setLog([]);
    try {
      const pool = memories();
      const r = linkByKeyword(pool);
      add(`## 安全性（Rの紐付け）：人物名と同じキーワードで結び付けたMemory\n${r.linked.join(" ／ ") || "なし"}\n（t-10 渡邊さん・t-11 まさきさん・t-12 行き先 が さきさん に結び付いていないこと）`);
      const items = await personSynthesis(pool);
      const timeline = buildThemeTimeline(PERSON, pool);
      const factsCtx: SynthesisThemeContext = { theme: PERSON, state: timeline.state, timeline: timeline.points, items: [] };
      const synthCtx: SynthesisThemeContext = { ...factsCtx, items: items.slice(0, 2) };
      for (const turn of TURNS) {
        const userTurns = [...turn.prior.map(([u]) => u), turn.latest];
        add(`# ${turn.label}\nユーザー：「${turn.latest}」`);
        for (const c of CONDS) {
          let retrieved: MemoryObject[];
          if (c === "B" || c === "C0" || c === "C") retrieved = pool.filter((m) => RELEVANT.includes(m.id)).sort((a, b) => a.date.localeCompare(b.date));
          else if (c === "R") retrieved = selectConversationDirectMatches(r.pool, normalizeTwo(turn.latest), userTurns.map(normalizeTwo), computeKeywordFrequency(r.pool), DEFAULT_LIMIT).kept.map((e) => e.memory);
          else retrieved = selectConversationDirectMatches(pool, turn.latest, userTurns, computeKeywordFrequency(pool), DEFAULT_LIMIT).kept.map((e) => e.memory);
          const contexts = c === "C0" ? [factsCtx] : c === "C" ? [synthCtx] : [];
          const memChars = retrieved.reduce((n, m) => n + m.summary.length + 40, 0);
          const synChars = contexts.length ? buildSynthesisSection(contexts).length : 0;
          add(`## ${CLABEL[c]}\n渡したMemory（${retrieved.length}件・約${memChars}字）: ${retrieved.map((m) => `[${m.id}] ${m.summary}`).join(" ／ ") || "なし"}\n追加セクション: ${synChars}字${c === "C" ? `（仮説 ${synthCtx.items.length}件）` : ""}${c === "D" ? "（会話プロンプトに感情の共存の注意を追加）" : ""}`);
          for (let k = 1; k <= RUNS; k++) {
            setStatus(`${turn.label} ${CLABEL[c]} ${k}/${RUNS}`);
            const ts = () => new Date().toISOString();
            const turns = [...turn.prior.flatMap(([u, a]) => [{ role: "user", content: u, timestamp: ts() }, { role: "ai", content: a, timestamp: ts() }]), { role: "user", content: turn.latest, timestamp: ts() }];
            const t0 = performance.now();
            const res = await fetch("/api/chat", {
              method: "POST",
              headers: await headers(),
              body: JSON.stringify({ persona: "analyst", turns, retrievedMemories: retrieved.map(toR), ...(contexts.length ? { memoryTimeline: contexts } : {}), ...(c === "D" ? { evalVoiceVariant: "emotion-coexistence" } : {}) }),
            });
            const text = await res.text();
            if (!res.ok) { add(`### ${k} 失敗 ${res.status}: ${text.slice(0, 120)}`); continue; }
            add(`### ${CLABEL[c]} ${k}（${Math.round(performance.now() - t0)}ms）[${flags(turn, text)}]\n${text}`);
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
      <h1 className="text-lg font-medium">感情理解の比較（Preview専用・架空データ・保存なし）</h1>
      <button className="self-start rounded-full border px-3 py-1" onClick={() => void run()}>実行</button>
      {status && <p role="status">{status}</p>}
      <pre data-testid="emotion-eval-log" className="whitespace-pre-wrap text-xs">{log.join("\n\n")}</pre>
    </main>
  );
}
