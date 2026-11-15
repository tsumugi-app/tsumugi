/**
 * 自動評価基盤 E2：12構成の比較の、判定と集計（テスト専用。アプリからは読まない。AIは呼ばない）。
 *
 * 判定は、サーバーが実際に組み立てた最終プロンプト（systemInstruction）の文字列と、診断の封筒（サーバーが受け取った値）、
 * 端末の Context Builder の診断（A/B/C）だけで行う。AI の返答の自然さ・正確なAPIのトークン数は、ここでは測れない（測ったとは言わない）。
 */
import type { EvalCase } from "./contextEvalWorld";

export type TimelineMode = "OFF" | "Timeline" | "Synthesis";
export interface EvalConfig {
  id: string;
  memoryGraph: boolean;
  timeline: TimelineMode;
  contextDedupe: boolean;
}

/** Memory Graph ON/OFF × 経緯 OFF/Timeline/Synthesis × Context Dedupe ON/OFF */
export const EVAL_CONFIGS: EvalConfig[] = [false, true].flatMap((memoryGraph) =>
  (["OFF", "Timeline", "Synthesis"] as TimelineMode[]).flatMap((timeline) =>
    [false, true].map((contextDedupe) => ({ id: `G${memoryGraph ? 1 : 0}-${timeline}-D${contextDedupe ? 1 : 0}`, memoryGraph, timeline, contextDedupe }))
  )
);
export const BASELINE_CONFIG_ID = "G0-OFF-D0";

/** 推定トークン：1文字≒1トークンと仮定した粗い目安（実際のAPIのトークン数ではない） */
export const estimateTokens = (chars: number) => chars;

export const SYNTHESIS_HEADING = "## 複数の会話にわたる経緯";
export const REFLECTION_LABEL = "Tsumugiが書いた日記の振り返り";
export const NOT_FOUND_HEADING = "このターンの記憶の検索で一致する記録が見つからなかったとき";

export interface RunInput {
  caseDef: EvalCase;
  config: EvalConfig;
  systemInstruction: string;
  /** the same question with no past context at all (to tell the size of the past context) */
  baselineChars: number;
  /** server: entries per route (the provenance of the values it accepted) */
  serverRouteCounts: Record<string, number>;
  /** server: Memories given by two routes or more */
  serverDuplicates: number;
  /** server: pieces the exact-duplicate reduction removed (0 when OFF) */
  dedupeRemoved: number;
  /** server: the user's reasons / corrections it put into the prompt (reason questions only) */
  reasonsSent: number;
  /** client (virtual): A/B/C of the Context Builder */
  abc: { A: number; B: number; C: number; Achars: number; Bchars: number; Cchars: number };
  reasonStatus: string;
  /** the AI's texts and how they are labelled */
  aiTexts: { reflection: string; hypotheses: string[] };
}

export interface RunResult {
  caseId: string;
  kind: string;
  config: string;
  required: { text: string; found: boolean }[];
  requiredFound: number;
  requiredTotal: number;
  protectedOk: boolean | null;
  directFound: boolean | null;
  optionalFound: number;
  optionalTotal: number;
  forbiddenHits: string[];
  /** AI texts in the prompt without their label (as if they were the user's words) */
  aiUnlabelled: string[];
  /** AI texts in the prompt with their label */
  aiLabelled: string[];
  notFoundNote: boolean;
  expectNotFound: boolean;
  routes: Record<string, number>;
  duplicates: number;
  dedupeRemoved: number;
  reasonsSent: number;
  promptChars: number;
  pastContextChars: number;
  estimatedTokens: number;
  abc: RunInput["abc"];
  reasonStatus: string;
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** the synthesis section: [start, end) */
function sectionRange(prompt: string, heading: string): [number, number] | null {
  const start = prompt.indexOf(heading);
  if (start === -1) return null;
  const next = prompt.indexOf("\n## ", start + heading.length);
  return [start, next === -1 ? prompt.length : next];
}

/** a hypothesis is labelled when it sits in the synthesis section, under "Tsumugiの整理" of its theme block */
export function hypothesisLabelled(prompt: string, index: number): boolean {
  const range = sectionRange(prompt, SYNTHESIS_HEADING);
  if (!range || index < range[0] || index >= range[1]) return false;
  const before = prompt.slice(range[0], index);
  return before.lastIndexOf("Tsumugiの整理") > before.lastIndexOf("テーマ「");
}

/** a reflection is labelled when its line says it is Tsumugi's diary reflection */
export function reflectionLabelled(prompt: string, index: number): boolean {
  const lineStart = prompt.lastIndexOf("\n", index) + 1;
  const lineEnd = prompt.indexOf("\n", index);
  return prompt.slice(lineStart, lineEnd === -1 ? prompt.length : lineEnd).includes(REFLECTION_LABEL);
}

export function evaluateRun(x: RunInput): RunResult {
  const p = x.systemInstruction;
  const has = (t: string) => p.includes(t);
  const required = x.caseDef.required.map((text) => ({ text, found: has(text) }));
  const aiUnlabelled: string[] = [];
  const aiLabelled: string[] = [];
  for (const i of occurrences(p, x.aiTexts.reflection)) (reflectionLabelled(p, i) ? aiLabelled : aiUnlabelled).push(`振り返り@${i}`);
  for (const h of x.aiTexts.hypotheses) for (const i of occurrences(p, h)) (hypothesisLabelled(p, i) ? aiLabelled : aiUnlabelled).push(`仮説「${h}」@${i}`);
  const pastContextChars = Math.max(0, p.length - x.baselineChars);
  return {
    caseId: x.caseDef.id,
    kind: x.caseDef.kind,
    config: x.config.id,
    required,
    requiredFound: required.filter((r) => r.found).length,
    requiredTotal: required.length,
    protectedOk: x.caseDef.protectedReasons ? x.caseDef.protectedReasons.every(has) : null,
    directFound: x.caseDef.direct.length > 0 ? x.caseDef.direct.some(has) : null,
    optionalFound: (x.caseDef.optional ?? []).filter(has).length,
    optionalTotal: (x.caseDef.optional ?? []).length,
    forbiddenHits: x.caseDef.forbidden.filter(has),
    aiUnlabelled,
    aiLabelled,
    notFoundNote: has(NOT_FOUND_HEADING),
    expectNotFound: x.caseDef.expectNotFound === true,
    routes: x.serverRouteCounts,
    duplicates: x.serverDuplicates,
    dedupeRemoved: x.dedupeRemoved,
    reasonsSent: x.reasonsSent,
    promptChars: p.length,
    pastContextChars,
    estimatedTokens: estimateTokens(pastContextChars),
    abc: x.abc,
    reasonStatus: x.reasonStatus,
  };
}

export interface ConfigSummary {
  config: string;
  requiredFound: number;
  requiredTotal: number;
  directCases: number;
  directTotal: number;
  protectedOk: number;
  protectedTotal: number;
  forbiddenHits: number;
  aiUnlabelled: number;
  notFoundOk: number;
  notFoundTotal: number;
  duplicates: number;
  dedupeRemoved: number;
  pastContextChars: number;
  estimatedTokens: number;
  routes: Record<string, number>;
  abc: RunInput["abc"];
}

export function summarizeConfig(config: string, runs: RunResult[]): ConfigSummary {
  const rs = runs.filter((r) => r.config === config);
  const sum = (f: (r: RunResult) => number) => rs.reduce((n, r) => n + f(r), 0);
  const routes: Record<string, number> = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.routes)) routes[k] = (routes[k] ?? 0) + v;
  return {
    config,
    requiredFound: sum((r) => r.requiredFound),
    requiredTotal: sum((r) => r.requiredTotal),
    directCases: rs.filter((r) => r.directFound === true).length,
    directTotal: rs.filter((r) => r.directFound !== null).length,
    protectedOk: rs.filter((r) => r.protectedOk === true).length,
    protectedTotal: rs.filter((r) => r.protectedOk !== null).length,
    forbiddenHits: sum((r) => r.forbiddenHits.length),
    aiUnlabelled: sum((r) => r.aiUnlabelled.length),
    notFoundOk: rs.filter((r) => r.expectNotFound && r.notFoundNote).length,
    notFoundTotal: rs.filter((r) => r.expectNotFound).length,
    duplicates: sum((r) => r.duplicates),
    dedupeRemoved: sum((r) => r.dedupeRemoved),
    pastContextChars: sum((r) => r.pastContextChars),
    estimatedTokens: sum((r) => r.estimatedTokens),
    routes,
    abc: { A: sum((r) => r.abc.A), B: sum((r) => r.abc.B), C: sum((r) => r.abc.C), Achars: sum((r) => r.abc.Achars), Bchars: sum((r) => r.abc.Bchars), Cchars: sum((r) => r.abc.Cchars) },
  };
}

/** one setting changed, everything else the same: in how many cases did the prompt change, and what changed */
export interface FlagEffect {
  setting: string;
  from: string;
  to: string;
  pairs: number;
  /** pairs whose final prompt is exactly the same: the setting had no effect there */
  identical: number;
  requiredDelta: number;
  forbiddenDelta: number;
  aiUnlabelledDelta: number;
  duplicatesDelta: number;
  charsDelta: number;
  /** cases where the setting changed the prompt */
  changedCases: string[];
}

export function flagEffect(setting: string, from: (c: { memoryGraph: boolean; timeline: TimelineMode; contextDedupe: boolean }) => boolean, apply: (id: string) => string, runs: RunResult[], prompts: Map<string, string>, fromLabel: string, toLabel: string): FlagEffect {
  const byKey = new Map(runs.map((r) => [`${r.caseId}|${r.config}`, r] as const));
  const e: FlagEffect = { setting, from: fromLabel, to: toLabel, pairs: 0, identical: 0, requiredDelta: 0, forbiddenDelta: 0, aiUnlabelledDelta: 0, duplicatesDelta: 0, charsDelta: 0, changedCases: [] };
  const changed = new Set<string>();
  for (const c of EVAL_CONFIGS.filter(from)) {
    const toId = apply(c.id);
    for (const a of runs.filter((r) => r.config === c.id)) {
      const b = byKey.get(`${a.caseId}|${toId}`);
      if (!b) continue;
      e.pairs += 1;
      const same = prompts.get(`${a.caseId}|${c.id}`) === prompts.get(`${a.caseId}|${toId}`);
      if (same) e.identical += 1;
      else changed.add(a.caseId);
      e.requiredDelta += b.requiredFound - a.requiredFound;
      e.forbiddenDelta += b.forbiddenHits.length - a.forbiddenHits.length;
      e.aiUnlabelledDelta += b.aiUnlabelled.length - a.aiUnlabelled.length;
      e.duplicatesDelta += b.duplicates - a.duplicates;
      e.charsDelta += b.pastContextChars - a.pastContextChars;
    }
  }
  e.changedCases = [...changed];
  return e;
}

const ROUTE_ORDER = ["Retrieval", "Recent Conversation", "Topic Continuity", "Profile", "Person View", "Topic Timeline", "Memory Graph", "Memory Timeline", "Memory Synthesis", "Explicit Search", "Memory Analytics", "Reflection"];

export function formatSummaryMarkdown(summaries: ConfigSummary[], effects: FlagEffect[], runs: RunResult[], caseIds: string[]): string {
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const lines: string[] = [];
  lines.push("### 自動評価 E2：12構成の比較（架空データ・固定時刻・AIは呼ばない）", "");
  lines.push("判定はサーバーが組み立てた最終プロンプトの文字列で行う。返答の自然さ・正確なAPIトークン数は測っていない（推定トークン＝文字数。粗い目安）。A/B/C は端末の仮想判定（Context Builder）。", "");
  lines.push("| 構成 | 必須の根拠 | 直接の根拠 | 理由・訂正の保護 | 混入 | AI文の区別違反 | 記憶なしの注記 | 重複Memory | 重複の削減 | 過去の文脈（字） | 推定トークン | A/B/C（件） |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    lines.push(`| ${s.config} | ${s.requiredFound}/${s.requiredTotal} | ${s.directCases}/${s.directTotal} | ${s.protectedOk}/${s.protectedTotal} | ${s.forbiddenHits} | ${s.aiUnlabelled} | ${s.notFoundOk}/${s.notFoundTotal} | ${s.duplicates} | ${s.dedupeRemoved} | ${s.pastContextChars} | ${s.estimatedTokens} | ${s.abc.A}/${s.abc.B}/${s.abc.C} |`);
  }
  lines.push("", "#### 経路ごとの採用件数（サーバーが受け取った値・全ケースの合計）", "");
  const routes = [...new Set([...ROUTE_ORDER, ...summaries.flatMap((s) => Object.keys(s.routes))])].filter((r) => summaries.some((s) => (s.routes[r] ?? 0) > 0));
  lines.push(`| 構成 | ${routes.join(" | ")} |`, `|---|${routes.map(() => "---").join("|")}|`);
  for (const s of summaries) lines.push(`| ${s.config} | ${routes.map((r) => s.routes[r] ?? 0).join(" | ")} |`);
  lines.push("", "#### 1つの設定だけを変えたときの差（同じケース・ほかの設定は同じ）", "");
  lines.push("| 設定 | 変更 | 比べた組 | 効果なし（プロンプト同一） | 必須の根拠 | 混入 | AI文の区別違反 | 重複Memory | 過去の文脈（字） | 変わったケース |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const e of effects) {
    lines.push(`| ${e.setting} | ${e.from}→${e.to} | ${e.pairs} | ${e.identical} | ${sign(e.requiredDelta)} | ${sign(e.forbiddenDelta)} | ${sign(e.aiUnlabelledDelta)} | ${sign(e.duplicatesDelta)} | ${sign(e.charsDelta)} | ${e.changedCases.length > 0 ? e.changedCases.join(", ") : "なし（効果なし）"} |`);
  }
  lines.push("", "#### ケースごとの必須の根拠（取得数/必須数・混入・AI文の区別違反）", "");
  const configs = summaries.map((s) => s.config);
  lines.push(`| ケース | ${configs.join(" | ")} |`, `|---|${configs.map(() => "---").join("|")}|`);
  for (const id of caseIds) {
    const cells = configs.map((c) => {
      const r = runs.find((x) => x.caseId === id && x.config === c)!;
      const marks = [r.forbiddenHits.length > 0 ? `混入${r.forbiddenHits.length}` : "", r.aiUnlabelled.length > 0 ? `AI${r.aiUnlabelled.length}` : "", r.expectNotFound ? (r.notFoundNote ? "注記あり" : "注記なし") : ""].filter(Boolean).join(" ");
      return `${r.requiredTotal > 0 ? `${r.requiredFound}/${r.requiredTotal}` : "－"}${marks ? ` ${marks}` : ""}`;
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/** what the current app does not reach, listed as it is (no pass / fail here): per case, the configurations and what was missing or mixed in */
export function formatShortfalls(runs: RunResult[], retrieved: { caseId: string; config: string; retrievedIds: string[] }[]): string {
  const lines: string[] = ["#### 現状の取りこぼし・混入（そのまま記録。E2では合否にしない）", ""];
  const groups = new Map<string, string[]>();
  const add = (key: string, config: string) => groups.set(key, [...(groups.get(key) ?? []), config]);
  for (const r of runs) {
    for (const q of r.required.filter((x) => !x.found)) add(`${r.caseId}：必須の根拠「${q.text}」がプロンプトに無い${r.protectedOk === false ? "（本人の理由・訂正）" : ""}`, r.config);
    for (const f of r.forbiddenHits) add(`${r.caseId}：混入してはいけない「${f}」がプロンプトにある`, r.config);
    if (r.expectNotFound && !r.notFoundNote) add(`${r.caseId}：記憶が無い質問だが「見つからなかった」の注記が無い`, r.config);
  }
  const all = EVAL_CONFIGS.length;
  for (const [what, configs] of groups) lines.push(`- ${what}：${configs.length === all ? "全12構成" : configs.join(", ")}`);
  if (groups.size === 0) lines.push("- なし");
  lines.push("", "#### 記憶の検索（Retrieval）が選んだ記録（G0-OFF-D0 と G1-Synthesis-D1）", "");
  lines.push("| ケース | G0-OFF-D0 | G1-Synthesis-D1 |", "|---|---|---|");
  for (const id of [...new Set(retrieved.map((x) => x.caseId))]) {
    const of = (c: string) => retrieved.find((x) => x.caseId === id && x.config === c)?.retrievedIds.join(", ") || "（なし）";
    lines.push(`| ${id} | ${of(BASELINE_CONFIG_ID)} | ${of("G1-Synthesis-D1")} |`);
  }
  return lines.join("\n");
}
