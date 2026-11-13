/**
 * P1-H 段階2-A：完全な重複の削減（機能フラグ`?contextDedupe=1`、初期値OFF）。
 *
 * 同じ記録の同じAIの要約が、プロンプトの前の節（Memory Graph／Memory Timeline）と後ろの節（Memory Timeline／Retrieval）に
 * 二重に入るとき、後ろの方の本文を外す。Memory Timelineの経緯は時系列そのものなので、点（日付と並び）は残し、要約だけを
 * 「同じ記録の要約は前の節にある」という短い参照に置き換える。Retrievalの記録は、その記録ごと外す。チャットのroute（サーバー）がプロンプトを組み立てる直前にこれを使い、端末のContext Builder診断も
 * 同じ関数で「どれが外れるか」を示す（判定は1か所だけ）。
 *
 * 外すのは、次をすべて満たすときだけ（どれか1つでも確かでなければ残す）：
 * - 同じMemory ID・同じ種類（AIの要約）・同じ本文（前後の空白を除いて一字一句同じ）の写しが、前の節にすでにある。
 * - 後ろの写しが、前の写しに無い情報を持たない。
 *   - Memory Timelineの経緯：出来事の時期・記録の言葉の状態・後から話した過去・今の状態の根拠・最後に話した記録の印が無く、話した日が同じ。
 *     テーマの経緯が空にならない。
 *   - Retrieval：本人の一文・つながりの理由・記録の性質・会話のきっかけの印が無い。出典がAIの要約（または不明）。
 *     話題の人物が本文に書かれているか、前の写しが同じ人物の節にある。出来事の時期は前の写しにも同じものがある。記録日が同じ。
 *     ほかの記録が少なくとも1件残る。分析モード（analyst）では外さない（その節だけを過去の情報として使う指示があるため）。
 * - 種類が違うもの（本人の発言・後からの説明・AIの仮説）、本文が違うもの、IDが無いもの、同じ経路の中で別の人物・別のテーマに
 *   出てくるものは、別の情報として残す。Memory Graph（前の節）からは何も外さない。
 *
 * 純関数。渡された値を書き換えない（外したあとの新しい配列を返す）。保存・I/O・AI呼び出しは無い。
 */
import type { RetrievedMemory } from "./types";
import type { SynthesisThemeContext } from "./memorySynthesis";
import type { PersonContext, PersonContextText } from "./personContextPrompt";
import { jstDateOf } from "./dateModel";

export interface DedupePiece {
  route: "Memory Timeline" | "Retrieval";
  memoryId: string;
  /** the theme of a Memory Timeline point */
  theme?: string;
  /** where the earlier copy stays */
  keptIn: "Memory Graph" | "Memory Timeline";
  /** the person (Memory Graph) or the theme (Memory Timeline) of the earlier copy */
  keptWhere: string;
  /** the summary text (the same in both copies) */
  text: string;
  chars: number;
  /** a Memory Timeline point keeps its date and place in the time series; its summary becomes this short reference */
  reference?: string;
  /** characters taken out of the prompt's text (the summary, less the reference that replaces it) */
  savedChars: number;
}

export interface DedupeKeptPiece {
  route: "Memory Timeline" | "Retrieval";
  memoryId: string;
  theme?: string;
  sameAs: "Memory Graph" | "Memory Timeline";
  /** why the later copy stays although its text is the same */
  why: string;
}

export interface ContextDedupeResult {
  memoryTimeline: SynthesisThemeContext[];
  retrievedMemories: RetrievedMemory[];
  /** the later copies taken out (in the prompt order) */
  removed: DedupePiece[];
  /** the later copies with the same text that stay, and why */
  kept: DedupeKeptPiece[];
}

interface EarlierCopy {
  route: "Memory Graph" | "Memory Timeline";
  where: string;
  day: string | null;
  persons: string[];
  eventTime?: string;
}

const textKey = (memoryId: string, text: string) => `${memoryId}\n${(text ?? "").trim()}`;
const len = (t: string) => Array.from(t ?? "").length;

/** the AI summaries the Memory Graph section writes (the user's words, candidates and the AI's readings are other kinds) */
function graphSummaries(p: PersonContext): PersonContextText[] {
  const out: PersonContextText[] = [];
  if (p.relation?.basis) out.push(p.relation.basis);
  for (const c of p.conclusions) out.push(c.statement);
  for (const plan of p.plans) {
    out.push(plan.plan);
    if (plan.outcome) out.push(plan.outcome);
  }
  out.push(...p.events);
  return out.filter((t) => t && t.kind === "summary" && typeof t.memoryId === "string" && t.memoryId.length > 0 && typeof t.text === "string" && t.text.trim().length > 0);
}

/** what a Memory Timeline point says besides its summary (any of it keeps the point) */
function timelineExtras(p: SynthesisThemeContext["timeline"][number]): string[] {
  const why: string[] = [];
  if (p.eventTime) why.push("出来事の時期");
  if (p.status) why.push("記録の言葉の状態");
  if (p.retrospective) why.push("後から話した過去の出来事の印");
  if (p.stateBasis) why.push("今の状態の根拠");
  if (p.latestSaid) why.push("最後に話した記録の印");
  return why;
}

/** what a Retrieval record says besides its summary that the earlier copy does not carry (any of it keeps the record) */
function retrievalExtras(m: RetrievedMemory, earlier: EarlierCopy): string[] {
  const why: string[] = [];
  if (m.isOriginMemory) why.push("会話のきっかけの記録");
  if (m.source && m.source !== "ai-capture") why.push(`出典（${m.source}）`);
  if (m.quote) why.push("本人の一文");
  if (m.linkReason) why.push("つながりの理由");
  if (m.trait) why.push("記録の性質");
  const shown = `${m.summary ?? ""} ${earlier.where} ${earlier.persons.join(" ")}`;
  const unshownKeywords = (m.keywords ?? []).filter((k) => typeof k === "string" && k.length > 0 && !shown.includes(k));
  if (unshownKeywords.length > 0) why.push(`keywords（${unshownKeywords.join("・")}）`);
  if (m.eventTime && m.eventTimePrecision && m.eventTimePrecision !== "day") why.push("出来事の時期の精度");
  const uncovered = (m.persons ?? []).filter((name) => !(m.summary ?? "").includes(name) && !earlier.persons.includes(name));
  if (uncovered.length > 0) why.push(`話題の人物（${uncovered.join("・")}）`);
  if (m.eventTime && m.eventTime !== earlier.eventTime) why.push("出来事の時期");
  const day = jstDateOf(m.date) ?? (typeof m.date === "string" ? m.date.slice(0, 10) : null);
  if (!day || day !== earlier.day) why.push("記録日");
  return why;
}

export function dedupeExactContext(input: {
  persona?: string;
  personContext: readonly PersonContext[];
  memoryTimeline: readonly SynthesisThemeContext[];
  retrievedMemories: readonly RetrievedMemory[];
}): ContextDedupeResult {
  const earlier = new Map<string, EarlierCopy[]>();
  const remember = (key: string, copy: EarlierCopy) => earlier.set(key, [...(earlier.get(key) ?? []), copy]);
  const removed: DedupePiece[] = [];
  const kept: DedupeKeptPiece[] = [];

  // 1 the Memory Graph (the first of the three sections): nothing is taken out of it
  for (const p of input.personContext) {
    const names = p.names.length > 0 ? p.names : [p.key];
    for (const t of graphSummaries(p)) remember(textKey(t.memoryId, t.text), { route: "Memory Graph", where: names.join("／"), day: t.day ?? null, persons: names, eventTime: undefined });
  }
  const fromGraph = new Map(earlier);

  // 2 the Memory Timeline: a point is compared with the Memory Graph only (the same record in another theme is another meaning).
  //   The point stays where it is (its date and its place in the time series); only its summary becomes a short reference.
  const referenced = new Set<string>();
  const memoryTimeline = input.memoryTimeline.map((theme) => {
    let left = theme.timeline.length;
    let changed = false;
    const timeline = theme.timeline.map((point) => {
      const copies = fromGraph.get(textKey(point.memoryId, point.summary));
      if (!copies || copies.length === 0) return point;
      const day = typeof point.statedAt === "string" ? point.statedAt.slice(0, 10) : "";
      const same = copies.find((c) => c.day === day);
      const why = timelineExtras(point);
      if (!same) why.push("話した日");
      if (why.length === 0 && left <= 1) why.push("テーマの経緯が空になる");
      if (why.length > 0 || !same) {
        kept.push({ route: "Memory Timeline", memoryId: point.memoryId, theme: theme.theme, sameAs: "Memory Graph", why: why.join("・") });
        return point;
      }
      left -= 1;
      changed = true;
      const reference = `（この記録の要約は、上の「話題の人物について」の「${same.where}」と同じ）`;
      referenced.add(`${theme.theme}\n${point.memoryId}`);
      removed.push({ route: "Memory Timeline", memoryId: point.memoryId, theme: theme.theme, keptIn: "Memory Graph", keptWhere: same.where, text: point.summary, chars: len(point.summary), reference, savedChars: len(point.summary) - len(reference) });
      return { ...point, summary: reference };
    });
    return changed ? { ...theme, timeline } : theme;
  });
  // what the prompt still carries of the Memory Timeline in full (a referenced point is not an earlier copy: its Memory Graph copy is)
  for (const theme of memoryTimeline) {
    for (const point of theme.timeline) if (!referenced.has(`${theme.theme}\n${point.memoryId}`)) remember(textKey(point.memoryId, point.summary), { route: "Memory Timeline", where: theme.theme, day: typeof point.statedAt === "string" ? point.statedAt.slice(0, 10) : null, persons: [], eventTime: point.eventTime });
  }

  // 3 Retrieval (the last section)
  // a Reflection (the AI's own diary text) does not count as a record that keeps the section (it is another kind)
  let left = input.retrievedMemories.filter((m) => m.source !== "system-generated").length;
  const retrievedMemories = input.retrievedMemories.filter((m) => {
    if (m.source === "system-generated") return true; // a Reflection is the AI's own text (another kind)
    const copies = earlier.get(textKey(m.id, m.summary));
    if (!copies || copies.length === 0) return true;
    const candidates = copies.map((c) => ({ c, why: retrievalExtras(m, c) }));
    const clean = candidates.find((x) => x.why.length === 0);
    const why = clean ? [] : candidates[0].why;
    if (input.persona === "analyst") why.push("分析モードはこの節だけを過去の情報として使う");
    if (why.length === 0 && left <= 1) why.push("関連する過去の記憶が空になる");
    if (why.length > 0 || !clean) {
      kept.push({ route: "Retrieval", memoryId: m.id, sameAs: candidates[0].c.route, why: uniqueJoin(why) });
      return true;
    }
    left -= 1;
    removed.push({ route: "Retrieval", memoryId: m.id, keptIn: clean.c.route, keptWhere: clean.c.where, text: m.summary, chars: len(m.summary), savedChars: len(m.summary) });
    return false;
  });

  return {
    memoryTimeline: memoryTimeline.some((t, i) => t !== input.memoryTimeline[i]) ? memoryTimeline : [...input.memoryTimeline],
    retrievedMemories: retrievedMemories.length === input.retrievedMemories.length ? [...input.retrievedMemories] : retrievedMemories,
    removed,
    kept,
  };
}

const uniqueJoin = (xs: string[]) => [...new Set(xs)].join("・");

/** what the server reports (only with ?debugLog=1): the pieces it actually took out of the prompt, and the sections' length before and after */
export interface ServerDedupeReport {
  enabled: true;
  removed: DedupePiece[];
  kept: DedupeKeptPiece[];
  /** the Memory Timeline section and the Retrieval section, in characters, without and with the reduction */
  sectionChars: { before: number; after: number };
  /** the whole system instruction, in characters, with the reduction (the one sent) */
  systemInstructionChars: number;
}

const CLIP = 40;
const clip = (t: string) => (len(t) > CLIP ? `${Array.from(t).slice(0, CLIP).join("")}…` : t);

export function serverDedupeReport(result: ContextDedupeResult, sectionChars: { before: number; after: number }, systemInstructionChars: number): ServerDedupeReport {
  return {
    enabled: true,
    removed: result.removed.map((r) => ({ ...r, text: clip(r.text) })),
    kept: result.kept,
    sectionChars,
    systemInstructionChars,
  };
}

export function formatServerDedupeReport(r: ServerDedupeReport | null | undefined): string {
  if (!r) return "重複の削減（サーバー）：OFF（従来どおりの入力）";
  const lines = [`重複の削減（サーバー・実際に送った内容）：ON　外した${r.removed.length}件・該当節 ${r.sectionChars.before}字 → ${r.sectionChars.after}字（プロンプト全体 ${r.systemInstructionChars}字）`];
  for (const x of r.removed) lines.push(`- ${x.route}${x.theme ? `（テーマ「${x.theme}」）` : ""}から ${x.memoryId} の${x.reference ? "要約を外し、日付と並びは参照で残した" : "記録を外した"}（${x.keptIn}「${x.keptWhere}」に残る・${x.savedChars}字減）：「${x.text}」`);
  for (const x of r.kept) lines.push(`- 同じ本文だが残した：${x.route}${x.theme ? `（テーマ「${x.theme}」）` : ""} ${x.memoryId}（${x.why}）`);
  return lines.join("\n");
}
