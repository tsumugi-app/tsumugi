/**
 * [D]の「診断ログをコピー」：1つのAI返答の診断を、スマホから別のAIへ1回で貼り付けられる短い文にする（表示・コピー専用）。
 *
 * - 純関数。保存・送信・AI呼び出しは無い。プロンプト・Memoryの選択・分類は変えない（すでにある診断の値を読むだけ）。
 * - 質問とAIの返答は全文。そのほかは集約する（同じ情報の重複・大量のJSON・無関係な未採用候補は入れない）。
 * - 目標はDEBUG_COPY_TARGET_CHARS字以内。超えるときは一覧を短くし、省略した件数と種類を必ず書く（黙って切り捨てない）。
 *   質問と返答は切らない（それだけで超えるときは、その旨を書く）。
 * - 「サーバーが受け取った値（実際の入力）」と「端末の仮想判定（Context Builder）」を見出しで分ける。
 */
import type { ContextBuilderReport } from "./contextBuilder";
import type { ServerDedupeReport } from "./contextDedupe";
import type { ServerReasonReport } from "./explicitReason";
import type { GenerationDebugContext, GenerationDebugGeneration } from "./generationDebugProtocol";
import { selectTimelineEventsForBudget, TOPIC_TIMELINE_BUDGET } from "./topicEvent";

export const DEBUG_COPY_TARGET_CHARS = 8000;
const ITEM_CLIP = 60;

const len = (t: string) => Array.from(t ?? "").length;
const clip = (t: string, max = ITEM_CLIP) => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return len(s) > max ? `${Array.from(s).slice(0, max).join("")}…` : s;
};

export interface DebugCopyInput {
  question: string;
  answer: string;
  generationId: string;
  generation: GenerationDebugGeneration;
  /** what the server accepted (the real input) */
  serverAccepted: GenerationDebugContext;
  /** P1-F：the server's per-route provenance counts (this tab only): the routes the stored debug entry has no field for (Memory Graph, Memory Timeline …) */
  serverRouteCounts?: Partial<Record<string, number>> | null;
  /** the Context Builder's report of this turn (this tab only; absent after a reload) */
  builder?: { report: ContextBuilderReport; server: ServerDedupeReport | null; serverReason?: ServerReasonReport | null } | null;
}

/** the routes of the server's provenance that the stored debug entry does not count itself */
const PROVENANCE_ONLY = ["Memory Graph", "Memory Timeline", "Memory Synthesis", "Reflection"];

/** the per-route counts of what the server accepted (the real input; the Topic Timeline after the route's budget, as in the prompt) */
function serverCounts(s: GenerationDebugContext, question: string, provenance: Partial<Record<string, number>> | null | undefined): string[] {
  const out: string[] = [];
  const add = (name: string, n: number) => { if (n > 0) out.push(`${name} ${n}件`); };
  add("Retrieval", (s.retrievedMemory ?? []).length);
  add("Topic Timeline（経緯の発言）", (s.topicTimeline ?? []).slice(0, TOPIC_TIMELINE_BUDGET.maxTopics).reduce((n, t) => n + selectTimelineEventsForBudget(t.events ?? [], TOPIC_TIMELINE_BUDGET.maxEventsPerTopic, question).length, 0));
  add("Topic Continuity", (s.topicContinuity ?? []).reduce((n, t) => n + (t.memories ?? []).length, 0));
  add("PersonView", (s.personView ?? []).length);
  add("Profile", s.profile ? (s.profile.core ?? []).length + (s.profile.relevant ?? []).length : 0);
  add("直前の会話（発言）", s.recentConversation ? (s.recentConversation.turns ?? []).length : 0);
  if (s.explicitSearchServerAccepted?.received) out.push(`Explicit Search ${s.explicitSearchServerAccepted.resultCount}件`);
  if (s.memoryAnalyticsServerAccepted?.received) out.push(`Memory Analytics ${s.memoryAnalyticsServerAccepted.resultCount}件`);
  if (provenance) for (const route of PROVENANCE_ONLY) add(`${route}（由来の項目）`, provenance[route] ?? 0);
  return out;
}

/**
 * a list that may be shortened. priority 0 (C items, removed duplicates) is shortened first; priority 1 (reasons) only after it;
 * warnings (priority 2) are never shortened. Every shortening says how many of which kind were left out.
 */
interface List { title: string; kind: string; items: string[]; priority: 0 | 1 | 2; empty?: string }

function renderList(l: List, limit: number | null, omitted: { kind: string; count: number }[]): string[] {
  const lines = ["", l.title];
  if (l.items.length === 0) return [...lines, l.empty ?? "- なし"];
  const shown = limit === null ? l.items : l.items.slice(0, limit);
  lines.push(...shown);
  if (shown.length < l.items.length) {
    lines.push(`- （ほか${l.items.length - shown.length}件を省略：${l.kind}。詳細は[D]の表示にある）`);
    omitted.push({ kind: l.kind, count: l.items.length - shown.length });
  }
  return lines;
}

/** the shortening steps: [limit of priority 0, limit of priority 1] (null = all) */
const STEPS: [number | null, number | null][] = [[null, null], [10, null], [5, null], [3, null], [1, null], [0, null], [0, 5], [0, 3], [0, 1]];

export function formatDebugCopy(input: DebugCopyInput): string {
  const g = input.generation;
  const b = input.builder;
  const r = b?.report;
  const sr = b?.serverReason;
  // 1 the question, the answer and the generation (never cut)
  const top: string[] = [
    "【Tsumugi 診断ログ（短縮版）】",
    `Generation ID：${input.generationId}`,
    `モデル：${g.provider} / ${g.model}　ペルソナ：${g.persona}　thinkingBudget：${g.thinkingBudget}　maxOutputTokens：${g.maxOutputTokens}　Web検索：${g.searchNeeded ? "あり" : "なし"}`,
    "",
    "■ 質問（全文）",
    input.question || "（直前のユーザー発言が見つからない）",
    "",
    "■ AIの返答（全文）",
    input.answer,
  ];
  // 2 the server's real input
  const serverHead: string[] = [
    "",
    "■ サーバーが受け取った値（実際の入力）",
    `- 経路ごとの件数：${serverCounts(input.serverAccepted, input.question, input.serverRouteCounts).join("・") || "なし"}`,
  ];
  if (!input.serverRouteCounts) serverHead.push("- Memory Graph・Memory Timeline・Synthesis・Reflection の件数：このタブの記録なし（再読み込みの後は無い）");
  if (!b) serverHead.push("- 重複の削減：不明（このタブの記録なし）", "- 本人の理由・訂正（実際のプロンプト）：不明（このタブの記録なし）");
  else {
    serverHead.push(b.server ? `- 重複の削減：ON（実際にプロンプトから${b.server.removed.length}件を外した。対象の節 ${b.server.sectionChars.before}字→${b.server.sectionChars.after}字、systemInstruction ${b.server.systemInstructionChars}字）` : "- 重複の削減：OFF（従来どおり送った）");
    serverHead.push(!sr ? "- 本人の理由・訂正（実際のプロンプト）：記録なし" : sr.asked ? `- 本人の理由・訂正（実際のプロンプト）：話題の語 ${sr.terms.join("・")}　入った${sr.sent.length}件` : "- 本人の理由・訂正（実際のプロンプト）：理由を尋ねる質問ではない");
  }
  const serverLists: List[] = [];
  if (sr && sr.asked && sr.sent.length > 0) serverLists.push({ priority: 1, title: "■ 実際のプロンプトに入った本人の理由・訂正（サーバー）", kind: "サーバーが送った本人の理由・訂正", items: sr.sent.map((x) => `- ${x.route}${x.memoryId ? ` ${x.memoryId}` : ""}：「${x.text}」`) });
  if (b?.server && b.server.removed.length > 0) serverLists.push({ priority: 0, title: "■ 重複の削減で実際に外したもの（サーバー）", kind: "削減で外した項目", items: b.server.removed.map((x) => `- ${x.route} ${x.memoryId}（${x.keptIn}「${clip(x.keptWhere, 20)}」に残る）`) });

  // 3 the client's virtual judgement (Context Builder)
  const clientHead: string[] = ["", "■ 端末の仮想判定（Context Builder。実際の入力は変えていない）"];
  const clientLists: List[] = [];
  if (!r) clientHead.push("- 記録なし（このタブで送ったターンだけ。再読み込みの後は無い）");
  else {
    const rel = r.relevance;
    const q = r.question;
    clientHead.push(
      `- 質問の種類：${q.types.join("・")}　人物：${q.persons.join("・") || "なし"}　話題の語：${q.terms.join("・") || "なし"}${q.fallback ? `　安全側：${q.fallback}` : ""}`,
      `- 経路ごとの項目数（端末から見た現行の入力。1件の記録の要約と本人の一文は別の項目）：${r.routes.map((x) => `${x.route} ${x.current.count}項目・${x.current.chars}字`).join("・") || "なし"}`,
      `- 分類：${rel.classes.map((c) => `${c.relevance} ${c.count}件・${c.chars}字`).join("／")}`,
      `- 現行 ${r.totals.current.count}件・${r.totals.current.chars}字 → 仮にCを省いた場合 ${rel.withoutLow.count}件・${rel.withoutLow.chars}字（省いたと仮定しただけで、実際には送っている）`,
      `- 本人の理由・訂正：${rel.reasons.status}${rel.reasons.status === "本人の理由・訂正は候補に無し" ? "（理由は作らない）" : `（直接根拠${rel.reasons.direct}・関連する文脈${rel.reasons.context}・関連性の低い補助情報${rel.reasons.low}）`}`,
      `- 重複の削減（端末の判定）：${r.dedupe.enabled ? "ON" : `OFF（ONなら${r.dedupe.removed.length}件・${r.dedupe.removedChars}字を外す）`}`,
    );
    const er = r.explicitReason;
    // the user's reasons as they said them (few: not clipped)
    if (er.asked) clientLists.push({ priority: 1, title: `■ 質問に答える本人の理由・訂正（端末の判定・話題の語：${er.terms.join("・")}）`, kind: "理由・訂正の候補", items: er.candidates.map((c) => `- ${c.sent ? "渡る" : "渡らない"}：${c.route}${c.memoryId ? ` ${c.memoryId}` : ""}「${c.text}」（${c.why}）`), empty: "- 候補に無し（今回の記録・経緯に本人が理由・訂正を述べた一文が無い。理由は作らない）" });
    clientLists.push({ priority: 0, title: "■ Cに分類された項目（関連性の低い補助情報・仮想判定）", kind: "Cの項目", items: rel.omitCandidates.map((o) => `- ${o.route}・${o.part} ${o.memoryIds.join(",") || "ID無し"}・${o.chars}字「${clip(o.text, 40)}」（${clip(o.why, 50)}）`) });
    const warnings: string[] = [];
    if (r.explanations.lost.length > 0) warnings.push(`- 仮想の入力が本人の理由・訂正を落とす：${r.explanations.lost.map((t) => `「${clip(t, 30)}」`).join("・")}`);
    if (rel.reasons.status === "保護されていない") warnings.push(`- 本人の理由・訂正がCに入っている（${rel.reasons.low}件）`);
    if (er.asked && er.candidates.some((c) => !c.sent)) warnings.push(`- 質問に答える本人の理由・訂正のうち${er.candidates.filter((c) => !c.sent).length}件が実際の入力に渡っていない（上の一覧）`);
    if (er.asked && er.candidates.length === 0) warnings.push("- 理由を尋ねる質問だが、本人の理由・訂正が候補に無い");
    if (r.hypotheses.beforeExplanationCurrent) warnings.push("- 現行の入力で、AIの仮説が本人の理由・訂正より前にある");
    if (r.lostMemoryIds.length > 0) warnings.push(`- 段階1の仮想の入力から消えるMemory：${r.lostMemoryIds.join(", ")}`);
    if (r.truncated) warnings.push("- 診断の項目が多く、[D]の判定一覧は途中まで");
    // the route's checks that kept something out of the prompt (the last note is the general client / server caveat)
    for (const n of r.notes) warnings.push(`- 注記：${clip(n, 120)}`);
    clientLists.push({ priority: 2, title: "■ 警告・取りこぼし・注記", kind: "警告", items: warnings });
  }

  const build = (step: [number | null, number | null]) => {
    const omitted: { kind: string; count: number }[] = [];
    const limitOf = (l: List) => (l.priority === 2 ? null : step[l.priority]);
    const lines = [...top, ...serverHead, ...serverLists.flatMap((l) => renderList(l, limitOf(l), omitted)), ...clientHead, ...clientLists.flatMap((l) => renderList(l, limitOf(l), omitted))];
    return { body: lines.join("\n"), omitted };
  };
  const says = (omitted: { kind: string; count: number }[]) => omitted.map((o) => `${o.kind} ${o.count}件`).join("・");
  // the full lists first; then shorter ones until the text fits (never the question, the answer or the warnings)
  let last = build(STEPS[0]);
  for (const step of STEPS) {
    last = build(step);
    const note = last.omitted.length > 0
      ? `（短縮：${DEBUG_COPY_TARGET_CHARS}字以内にするため一覧を短くした。省略：${says(last.omitted)}。質問・返答・警告は全文）`
      : `（${len(last.body)}字。省略なし）`;
    const text = `${last.body}\n\n${note}`;
    if (len(text) <= DEBUG_COPY_TARGET_CHARS) return text;
  }
  return `${last.body}\n\n（質問・返答が長いため${len(last.body)}字で、目標の${DEBUG_COPY_TARGET_CHARS}字を超えた。質問・返答・警告は全文のまま。省略：${says(last.omitted) || "なし"}）`;
}
