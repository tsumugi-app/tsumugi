/**
 * Memory Graph P1-A: the chat route side of the person context (personContext.ts builds it on the device). The payload comes from the client, so its shape
 * and every limit are checked again here, then it is written as one section of the system instruction. No storage, retrieval or AI import:
 * this file is used by the server route.
 */
export type PersonContextKind = "user" | "summary" | "candidate";

export interface PersonContextText {
  kind: PersonContextKind;
  text: string;
  /** YYYY-MM-DD the user said it (or the record date) */
  day: string;
  memoryId: string;
}

/** P1-C: what the view does (personStance.ts); the same names here, as the route must not import the device side */
export type PersonContextStance = "decision" | "wish" | "view" | "feeling" | "uncertain";
export const PERSON_CONTEXT_STANCE_LABEL: Record<PersonContextStance, string> = { decision: "結論", wish: "願い", view: "考え", feeling: "その時の気持ち", uncertain: "迷い" };
/** P1-C: a plan as the user's words state it (personContext.ts planKindOf) */
export type PersonContextPlanType = "plan" | "wish" | "summary";

export interface PersonContextConclusion {
  /** a conclusion or a thought in the user's words (or, for a record without a name, a candidate) */
  statement: PersonContextText;
  role: "judgment" | "thought";
  /** P1-C: what it does; without it (an older payload) the line reads 結論 / 考え by its role */
  stance?: PersonContextStance;
  /** P1-C: the user came back to it on another day */
  repeated?: boolean;
  /**
   * the user's reasons for it: in the statement itself ("same"), or said later and sharing a word with it ("later"). A later reason's `link` is
   * "topic" when Capture also put both in one topic, "word" when only the shared words point to it (a guess, said so in the prompt)
   */
  reasons: (PersonContextText & { when: "same" | "later"; link?: "topic" | "word" })[];
  /** sentences of the AI summaries that give a reason for the same words (the AI's reading, below the user's own explanation) */
  aiReadings: PersonContextText[];
}

export interface PersonContext {
  key: string;
  names: string[];
  relation?: { label: string; basis?: PersonContextText };
  conclusions: PersonContextConclusion[];
  plans: { plan: PersonContextText; type?: PersonContextPlanType; outcome?: PersonContextText & { status: string }; }[];
  events: PersonContextText[];
  lastDay?: string;
  /** records without a name that may be about this person, with the evidence that points to it */
  candidates: (PersonContextText & { signals: string[] })[];
  /** every Memory this context rests on */
  memoryIds: string[];
}

export const PERSON_CONTEXT_LIMITS = {
  maxPersons: 2,
  maxConclusions: 6,
  maxReasonsPerConclusion: 2,
  maxAiReadingsPerConclusion: 1,
  maxPlans: 2,
  maxEvents: 3,
  maxCandidates: 2,
  /** a text longer than this is left out whole (never cut in the middle) */
  maxTextChars: 160,
  /** how many earlier user turns may carry the person over to a turn that names no one */
  carryTurns: 2,
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// the chat route side: the payload is checked again (it comes from the client) and written as one section of the system instruction
// ---------------------------------------------------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const KINDS = new Set<PersonContextKind>(["user", "summary", "candidate"]);
function cleanText(x: unknown): PersonContextText | null {
  if (!isObj(x) || typeof x.text !== "string" || typeof x.day !== "string" || typeof x.memoryId !== "string" || !KINDS.has(x.kind as PersonContextKind)) return null;
  const t = x.text.replace(/\s+/g, " ").trim();
  if (!t || t.length > PERSON_CONTEXT_LIMITS.maxTextChars) return null;
  return { kind: x.kind as PersonContextKind, text: t, day: /^\d{4}-\d{2}-\d{2}$/.test(x.day) ? x.day : "", memoryId: x.memoryId.slice(0, 64) };
}
const list = (x: unknown) => (Array.isArray(x) ? x : []);
const nonNull = <T,>(x: T | null): x is T => x !== null;

/** the payload as the route accepts it: the shape checked and every limit applied again; anything else is dropped */
export function sanitizePersonContext(raw: unknown): PersonContext[] {
  const L = PERSON_CONTEXT_LIMITS;
  return list(raw).slice(0, L.maxPersons).filter(isObj).map((p): PersonContext | null => {
    if (typeof p.key !== "string") return null;
    const names = list(p.names).filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 20).slice(0, 4);
    const relationRaw = isObj(p.relation) && typeof p.relation.label === "string" && p.relation.label.length <= 30 ? p.relation : null;
    const basis = relationRaw ? cleanText(relationRaw.basis) : null;
    const conclusions = list(p.conclusions).filter(isObj).slice(0, L.maxConclusions).map((c) => {
      const statement = cleanText(c.statement);
      if (!statement || (c.role !== "judgment" && c.role !== "thought")) return null;
      const reasons = list(c.reasons).filter(isObj).map((r) => {
        const t = cleanText(r);
        if (!t || (r.when !== "same" && r.when !== "later")) return null;
        return { ...t, when: r.when as "same" | "later", ...(r.when === "later" && (r.link === "topic" || r.link === "word") ? { link: r.link as "topic" | "word" } : {}) };
      }).filter(nonNull).slice(0, L.maxReasonsPerConclusion + 1);
      const aiReadings = list(c.aiReadings).map(cleanText).filter(nonNull).filter((t) => t.kind === "summary").slice(0, L.maxAiReadingsPerConclusion);
      const stance = typeof c.stance === "string" && Object.prototype.hasOwnProperty.call(PERSON_CONTEXT_STANCE_LABEL, c.stance) ? c.stance as PersonContextStance : undefined;
      return { statement, role: c.role as "judgment" | "thought", ...(stance ? { stance } : {}), ...(c.repeated === true ? { repeated: true } : {}), reasons, aiReadings };
    }).filter(nonNull);
    const plans = list(p.plans).filter(isObj).slice(0, L.maxPlans).map((x) => {
      const plan = cleanText(x.plan);
      if (!plan) return null;
      const o = isObj(x.outcome) ? cleanText(x.outcome) : null;
      const status = isObj(x.outcome) && typeof x.outcome.status === "string" && x.outcome.status.length <= 10 ? x.outcome.status : null;
      const type = x.type === "plan" || x.type === "wish" || x.type === "summary" ? x.type as PersonContextPlanType : undefined;
      return { plan, ...(type ? { type } : {}), ...(o && status ? { outcome: { ...o, status } } : {}) };
    }).filter(nonNull);
    const events = list(p.events).map(cleanText).filter(nonNull).slice(0, L.maxEvents);
    const candidates = list(p.candidates).filter(isObj).slice(0, L.maxCandidates).map((c) => {
      const t = cleanText(c);
      const signals = list(c.signals).filter((s): s is string => typeof s === "string" && s.length <= 20).slice(0, 4);
      return t && t.kind === "candidate" && signals.length >= 2 ? { ...t, signals } : null;
    }).filter(nonNull);
    const lastDay = typeof p.lastDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.lastDay) ? p.lastDay : undefined;
    return {
      key: p.key.slice(0, 20), names: names.length > 0 ? names : [p.key.slice(0, 20)],
      ...(relationRaw ? { relation: { label: relationRaw.label as string, ...(basis ? { basis } : {}) } } : {}),
      conclusions, plans, events, ...(lastDay ? { lastDay } : {}), candidates, memoryIds: [],
    };
  }).filter(nonNull).filter((c) => c.conclusions.length + c.plans.length + c.events.length + c.candidates.length > 0 || c.relation !== undefined);
}

const LABEL: Record<PersonContextKind, string> = { user: "本人の発言", summary: "AIの要約", candidate: "候補・名前の無い記録" };
const PLAN_LABEL: Record<PersonContextPlanType, string> = { plan: "予定", wish: "希望（予定ではない）", summary: "AIの要約上の意図（本人が予定と言った記録は無い）" };
const line = (t: PersonContextText) => `[${LABEL[t.kind]} ${t.day}] ${t.text}`;

/** the system instruction section ("" when there is nothing: the prompt is then exactly as without the trial) */
export function buildPersonContextSection(contexts: PersonContext[]): string {
  if (contexts.length === 0) return "";
  const out: string[] = [
    "",
    "## 話題の人物について、保存された記録からの背景（Memory Graph・試験）",
    "今の話題に出てくる人物について、本人の記録から組み立てた背景です。",
    "- 「本人の発言」はその日に本人が言った言葉、「AIの要約」は記録を作ったAIの文、「候補・名前の無い記録」は人物名が無く、この人の話かどうか確定していない記録です。",
    "- 過去の考えや結論は、その時点のものです。今もそうだと決めつけず、事実としても扱わないでください。",
    "- 本人が後から説明した理由や訂正は、AIの要約の解釈より優先してください。ただし、新しい記録だというだけで以前の本人の言葉を否定しないでください。",
    "- 「その時の気持ち」「迷い」はその時点の気持ちで、結論ではありません。「願い」は本人の望みで、予定や事実ではありません。",
    "- 「関連は推測」と書いた理由は、共通の言葉からつないだもので、同じ話かどうか確かではありません。",
    "- 候補は確定した事実として扱わず、必要なら本人に確かめてください。",
    "- 今の話に必要なときだけ使い、関係のない過去を持ち出さないでください。",
  ];
  for (const c of contexts) {
    out.push("", `### ${c.names.join("／")}`);
    if (c.relation) out.push(`関係（記録を作ったAIの分類）：${c.relation.label}${c.relation.basis ? `　根拠 ${line(c.relation.basis)}` : ""}`);
    if (c.conclusions.length > 0) {
      out.push("過去の考え・結論（古い順）：");
      for (const k of c.conclusions) {
        out.push(`- ${k.stance ? PERSON_CONTEXT_STANCE_LABEL[k.stance] : k.role === "judgment" ? "結論" : "考え"} ${line(k.statement)}${k.repeated ? "（別の日にも同じことに触れている）" : ""}`);
        for (const r of k.reasons) if (r.when === "later") out.push(`  - 後から本人が説明した理由 ${line(r)}${r.link === "word" ? "（関連は推測：共通の言葉から）" : ""}`);
        for (const a of k.aiReadings) out.push(`  - AIの要約の解釈（本人の説明とは違うかもしれない） ${line(a)}`);
      }
    }
    if (c.plans.length > 0) {
      out.push("予定と、その後の候補：");
      for (const p of c.plans) out.push(`- ${PLAN_LABEL[p.type ?? "plan"]} ${line(p.plan)}${p.outcome ? `\n  - 結果の候補「${p.outcome.status}」 ${line(p.outcome)}` : "\n  - その後は記録に無い（結果は不明）"}`);
    }
    if (c.events.length > 0) {
      out.push("最近の出来事：");
      for (const e of c.events) out.push(`- ${line(e)}`);
    }
    if (c.candidates.length > 0) {
      out.push("名前の無い記録（この人の話の可能性。確定ではない）：");
      for (const k of c.candidates) out.push(`- ${line(k)}（根拠：${k.signals.join("・")}）`);
    }
    if (c.lastDay) out.push(`最後に確認できた記録：${c.lastDay}（それ以降のことは記録に無い）`);
  }
  return `${out.join("\n")}\n`;
}
