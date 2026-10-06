/**
 * Explicit Memory Search Phase 1（純粋関数のみ。ブラウザAPI・IndexedDB・LLMに依存しない）。
 *
 * 通常会話のAssociative Recall（retrieval.ts：現在の発言に関連する過去を自然に思い出す、上位3件）とは**別の検索目的**：
 * ユーザー自身が「保存済みの自分の過去」を明示的に探しているとき（「さきさんについて何話した？」等）だけ、専用経路で
 * 保存済みMemory全体を検索し、十分な情報量（detail・ユーザー発言の逐語抜粋）をChatへ渡す。
 * 通常のretrievalのスコア式・top-k・floorには一切触れない（このモジュールはretrieval.tsをimportしない）。
 *
 * - intent判定：deterministic（LLMを呼ばない）。「過去を探す」型の表現（何話した／記録ある？／残ってる？／
 *   前にどう考えてた？／話した内容を見たい）だけ。「さきさんと今度仕事する」「黄金湯に行きたい」は対象外。
 *   検索対象語が取り出せない（「何話した？」だけ）場合もintentにしない。
 * - 検索語の抽出：検索メタ語（最近・前に・について・何話したっけ・記録・残ってる…）を除き、対象語（名詞句）を取り出す。
 *   「AのB」型は、全体と各部分を別々の検索語にする（relation語（同僚等）は弱い検索語として扱う）。
 * - 検索対象は既存MemoryObjectに実在するフィールドだけ：personMentions（displayName・quote）・keywords・summary・
 *   evidenceQuotes・topicEvents.quote・content。embedding等は使わない。
 * - 人物の照合は、同じ呼称の一致・包含・敬称（さん/くん/ちゃん等）の有無の違いだけを同一視する。「さき」と「妻」のような
 *   異なる呼称を推測で同一人物にしない（person.tsのgroupingKeyの方針と同じ）。
 */
import { normalizeKey, normalizeText } from "./profile";
import type { MemoryObject } from "./types";

/** 検索結果として扱う最大件数（Phase 1の固定上限）。1件あたり最大でdetail約320字＋抜粋3件のため、合計でも数千字に収まる。 */
export const EXPLICIT_SEARCH_LIMIT = 10;
export const EXPLICIT_SEARCH_DETAIL_MAX = 320;
export const EXPLICIT_SEARCH_QUOTE_MAX = 100;
export const EXPLICIT_SEARCH_QUOTES_PER_MEMORY = 3;
export const EXPLICIT_SEARCH_MAX_TERMS = 5;
/** 1位の何割未満の候補を落とすか（弱い偶然一致を、件数を埋めるためだけに返さない）。 */
export const EXPLICIT_SEARCH_RELATIVE_KEEP = 0.2;

// ---------------------------------------------------------------------------
// 1. intent判定
// ---------------------------------------------------------------------------

/** 「何／どんなこと」を話した・書いた・考えていた、の過去形。「何話した」「何を話したっけ」「どんなこと話した」。 */
const WHAT_WAS_SAID = /(?:何|なに|どんな(?:こと|話)?)\s*(?:を|か)?\s*(?:話し|はなし|言っ|いっ|書い|記録し|残し|考え|思っ|喋っ)(?:た|てた|ていた|てました|ました)(?:っけ|かな|かしら|のか|っけな)?/;
/** 「(以前|前に…)…どう考えて／思ってた」。過去を指す語を必須にし、通常の感想の共有と区別する。 */
const HOW_THOUGHT = /どう\s*(?:考え|思っ)\s*(?:て|てい)\s*(?:た|ました)(?:っけ|かな)?/;
const PAST_ANCHOR = /(?:最近|以前|前に|昔|これまで|今まで|過去|前から|この前)/;
/** 「記録ある？」「メモが残ってる」「記録を見せて」。 */
const RECORD_ASK = /(?:記録|メモ|記憶|履歴)\s*(?:が|は|を|って|も)?\s*(?:ある|あった|あります|ない|残っ|見せ|見たい|見られ|教え|出し|探し)/;
/** 「何か残ってる？」。「疲れが残ってる」のような通常発言は、「何か」が無いので対象外。 */
const SOMETHING_LEFT = /(?:何か|なにか)\s*(?:記録|メモ|記憶)?\s*(?:が)?\s*残っ(?:て(?:る|いる|ます|いない|ない|た)|た)/;
/** 「話した内容を見たい」「書いたものを探して」。 */
const SAID_CONTENT_ASK = /(?:話し|書い|記録し|残し|言っ)\s*(?:た|てた)\s*(?:内容|こと|話|もの)\s*(?:を|が)?\s*(?:見|教え|探|出|振り返|確認|知り)(?:たい|せて|て|られ|たかった)?/;

const INTENT_PATTERNS: readonly RegExp[] = [WHAT_WAS_SAID, RECORD_ASK, SOMETHING_LEFT, SAID_CONTENT_ASK];

/** 検索メタ語（検索対象語ではない）。intent patternで除いた残りに現れる語。 */
const META_WORDS = /最近|以前|前に|昔|これまで|今まで|過去(?:に|の)?|前から|この前|何か|なにか|どんな(?:こと|話)?|どういう|話した|記録|メモ|記憶|履歴|見せて|見たい|探して|教えて|出して|残って(?:る|いる)?|っけ|でしょうか|ですか|ますか|かな|かしら/g;
/** 区切りとして扱う助詞・句読点。「の」は区切りにせず、下で「AのB」として別扱いする。 */
const SEPARATORS = /[、。，．・\s?？!！「」『』()（）]+|について(?:は|も)?|に関して(?:は)?|に関する|のこと|のお話|の話|とは|という|っていう|って|を|は|が|も/g;
const STOP_CHUNKS = new Set(["こと", "もの", "やつ", "あれ", "それ", "これ", "内容", "話", "何", "なに", "自分", "私", "僕", "俺"]);
/** relation語（単独では特定の人物・話題を指さないため、弱い検索語として扱う）。 */
const RELATION_WORDS = /^(?:同僚|上司|部下|友人|友達|友だち|親友|家族|妻|夫|娘|息子|母|父|兄|弟|姉|妹|子供|彼女|彼氏|先輩|後輩|先生|知人|仕事仲間)$/;
const HONORIFIC = /(?:さん|くん|君|ちゃん|様|氏)$/;

export interface ExplicitSearchTerm {
  text: string;
  /** relation語など、単独では弱い検索語。強い検索語が別にあるときは、これだけの一致では結果にしない。 */
  weak: boolean;
}

export interface ExplicitSearchIntent {
  terms: ExplicitSearchTerm[];
}

function chunkTerms(chunk: string): string[] {
  const text = chunk.replace(/(?:の|を|は|が|に|で|と|も)$/, "").trim();
  // 1文字の語は、relation語（妻・夫・母 等）だけ検索語にできる（それ以外の1文字は一般語・助詞の残りで、ノイズになる）。
  if ((text.length < 2 && !RELATION_WORDS.test(text)) || STOP_CHUNKS.has(text)) return [];
  const out = [text];
  if (text.includes("の")) {
    for (const part of text.split("の")) {
      const p = part.trim();
      if (p.length >= 2 && !STOP_CHUNKS.has(p) && p !== text) out.push(p);
    }
  }
  return out;
}

/**
 * ユーザーの発言が、保存済みMemoryを明示的に探す問いなら、検索語を返す。そうでなければnull。
 * deterministic（LLM・I/Oなし）。「intentの表現はあるが、対象語が取り出せない」場合もnull。
 */
export function detectExplicitMemorySearch(text: string): ExplicitSearchIntent | null {
  const t = normalizeText(text);
  if (!t) return null;

  let residual = t;
  let matched = false;
  for (const pattern of INTENT_PATTERNS) {
    const global = new RegExp(pattern.source, "g");
    if (global.test(residual)) {
      matched = true;
      residual = residual.replace(new RegExp(pattern.source, "g"), "、");
    }
  }
  if (!matched && HOW_THOUGHT.test(residual) && PAST_ANCHOR.test(residual)) {
    matched = true;
    residual = residual.replace(new RegExp(HOW_THOUGHT.source, "g"), "、");
  }
  if (!matched) return null;

  residual = residual.replace(META_WORDS, "、");
  const seen = new Set<string>();
  const terms: ExplicitSearchTerm[] = [];
  for (const chunk of residual.split(SEPARATORS)) {
    for (const term of chunkTerms(chunk)) {
      const key = normalizeKey(term);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      terms.push({ text: term, weak: RELATION_WORDS.test(term) });
      if (terms.length >= EXPLICIT_SEARCH_MAX_TERMS) break;
    }
    if (terms.length >= EXPLICIT_SEARCH_MAX_TERMS) break;
  }
  if (terms.length === 0) return null;
  // 弱い語だけ（「同僚について何話した？」）の場合は、それ自体を強い検索語として扱う。
  if (terms.every((term) => term.weak)) for (const term of terms) term.weak = false;
  return { terms };
}

// ---------------------------------------------------------------------------
// 2. 検索
// ---------------------------------------------------------------------------

const FIELD_SCORE = {
  personExact: 10,
  personLoose: 8,
  personHonorific: 9,
  keywordExact: 9,
  keywordLoose: 6,
  summary: 5,
  evidence: 4,
  content: 3,
  topicEvent: 3,
  personQuote: 3,
} as const;
type MatchedField = "person" | "keyword" | "summary" | "evidence" | "content";

const WEAK_TERM_FACTOR = 0.3;
const LEXICAL_TIEBREAK_WEIGHT = 0.5;

function bigrams(text: string): Set<string> {
  const chars = Array.from(normalizeKey(text));
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}
function lexicalOverlap(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return shared / A.size;
}

function stripHonorific(key: string): string {
  const base = key.replace(HONORIFIC, "");
  return base.length >= 2 ? base : key;
}

/**
 * 1つの検索語に対する、1つのMemoryの最良フィールド一致。
 * 「AのB」型の全体語（「同僚のさきさん」）は、フィールドが**その全体を含む**場合だけ一致とする。フィールド側の短い語
 * （keyword「同僚」）が検索語の一部に含まれるだけで一致させると、別の同僚のMemoryまで拾ってしまうため
 * （その部分は、各部分語＝「同僚」（弱い）・「さきさん」として別に照合する）。
 */
function matchTerm(memory: MemoryObject, term: string): { score: number; field: MatchedField } | null {
  const T = normalizeKey(term);
  if (!T) return null;
  const composite = term.includes("の");
  /** フィールドの語fが、検索語Tに含まれる（T ⊃ f）ことを一致として認めるか。 */
  const termContains = (f: string) => !composite && f.length >= 2 && T.includes(f);
  let best: { score: number; field: MatchedField } | null = null;
  const consider = (score: number, field: MatchedField) => {
    if (best === null || score > best.score) best = { score, field };
  };

  for (const mention of memory.personMentions ?? []) {
    const keys = [normalizeKey(mention.displayName), mention.groupingKey].filter((k) => k.length >= 1);
    for (const key of keys) {
      if (key === T) consider(FIELD_SCORE.personExact, "person");
      else if (stripHonorific(key) === stripHonorific(T) && stripHonorific(T).length >= 2) consider(FIELD_SCORE.personHonorific, "person");
      else if (termContains(key) || (T.length >= 2 && key.includes(T))) consider(FIELD_SCORE.personLoose, "person");
    }
    if (mention.quote && normalizeKey(mention.quote).includes(T)) consider(FIELD_SCORE.personQuote, "evidence");
  }
  for (const keyword of memory.keywords) {
    const k = normalizeKey(keyword);
    if (!k) continue;
    if (k === T) consider(FIELD_SCORE.keywordExact, "keyword");
    else if (termContains(k) || (T.length >= 2 && k.includes(T))) consider(FIELD_SCORE.keywordLoose, "keyword");
  }
  if (normalizeKey(memory.summary).includes(T)) consider(FIELD_SCORE.summary, "summary");
  for (const quote of memory.evidenceQuotes ?? []) {
    if (normalizeKey(quote).includes(T)) {
      consider(FIELD_SCORE.evidence, "evidence");
      break;
    }
  }
  for (const event of memory.topicEvents ?? []) {
    if (event.quote && normalizeKey(event.quote).includes(T)) {
      consider(FIELD_SCORE.topicEvent, "evidence");
      break;
    }
  }
  if (normalizeKey(memory.content).includes(T)) consider(FIELD_SCORE.content, "content");
  return best;
}

export interface ExplicitSearchHit {
  memory: MemoryObject;
  score: number;
  /** 一致したフィールド（重複なし）。 */
  matchedFields: MatchedField[];
  /** 一致した検索語（原文）。 */
  matchedTerms: string[];
}

/**
 * 保存済みMemory全体（`all`）から、検索語に一致するものを、関連度の高い順に最大limit件返す。
 * スコア：検索語ごとの最良フィールド点（person > keyword > summary > evidence > content）×検索語の稀少度（idf）。
 * relation語など弱い検索語は0.3倍で、それだけの一致は結果にしない（強い検索語が別にある場合）。
 * 語彙の類似度（bigram）は同点を分ける補助にだけ使い、一致の根拠にはしない。
 */
export function searchMemories(
  all: readonly MemoryObject[],
  intent: ExplicitSearchIntent,
  options: { limit?: number; excludeConversationId?: string } = {}
): { hits: ExplicitSearchHit[]; total: number } {
  const limit = options.limit ?? EXPLICIT_SEARCH_LIMIT;
  const pool = all.filter((memory) => options.excludeConversationId === undefined || memory.conversationId !== options.excludeConversationId);

  const perMemory = pool.map((memory) => intent.terms.map((term) => matchTerm(memory, term.text)));
  const N = pool.length;
  const idf = intent.terms.map((_, i) => {
    const df = perMemory.filter((matches) => matches[i] !== null).length;
    return 1 + Math.log((N + 1) / (df + 1));
  });
  const phrase = intent.terms.map((term) => term.text).join("");

  const hits: ExplicitSearchHit[] = [];
  pool.forEach((memory, m) => {
    const matches = perMemory[m];
    let score = 0;
    let hasStrong = false;
    const fields = new Set<MatchedField>();
    const terms: string[] = [];
    matches.forEach((match, i) => {
      if (match === null) return;
      const term = intent.terms[i];
      if (!term.weak) hasStrong = true;
      score += match.score * (term.weak ? WEAK_TERM_FACTOR : 1) * idf[i];
      fields.add(match.field);
      terms.push(term.text);
    });
    if (!hasStrong) return;
    score += LEXICAL_TIEBREAK_WEIGHT * lexicalOverlap(phrase, `${memory.summary} ${memory.content}`);
    hits.push({ memory, score, matchedFields: [...fields], matchedTerms: terms });
  });

  hits.sort((a, b) => b.score - a.score || Date.parse(b.memory.date) - Date.parse(a.memory.date));
  const top = hits[0]?.score ?? 0;
  const kept = hits.filter((hit) => hit.score >= top * EXPLICIT_SEARCH_RELATIVE_KEEP);
  return { hits: kept.slice(0, limit), total: kept.length };
}

// ---------------------------------------------------------------------------
// 3. /api/chat へ渡す形（永続スキーマではない。1リクエストごとに組み立てて破棄する）
// ---------------------------------------------------------------------------

export interface ExplicitSearchResult {
  id: string;
  /** Conversation／記録日時（Memory.date）。 */
  date: string;
  /** ユーザー発言の時刻（Memory.statedAt、あれば）。 */
  statedAt?: string;
  eventTime?: string;
  eventTimePrecision?: string;
  summary: string;
  keywords: string[];
  /** content（detail）のうち、一致箇所を中心にした抜粋。 */
  detail: string;
  /** ユーザー自身の発言からの逐語quote（Memory.evidenceQuotes）。検索語に一致するものを優先する。 */
  evidenceQuotes: string[];
  /** 一致したフィールド（デバッグ・説明用）。 */
  matchedOn: string[];
  source?: string;
}

export interface ExplicitSearchContext {
  terms: string[];
  /** 閾値を通った件数（上限で切る前）。resultsより多いことがある。 */
  total: number;
  results: ExplicitSearchResult[];
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** contentのうち、検索語が最初に現れる位置を中心にした抜粋（無ければ先頭）。 */
function detailSnippet(content: string, terms: readonly string[]): string {
  const text = content.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (text.length <= EXPLICIT_SEARCH_DETAIL_MAX) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term.normalize("NFKC").toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - 80);
  const end = Math.min(text.length, start + EXPLICIT_SEARCH_DETAIL_MAX);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function pickQuotes(memory: MemoryObject, terms: readonly string[]): string[] {
  const quotes = (memory.evidenceQuotes ?? []).filter((q) => typeof q === "string" && q.trim());
  const keys = terms.map((term) => normalizeKey(term)).filter(Boolean);
  const matching = quotes.filter((q) => keys.some((k) => normalizeKey(q).includes(k)));
  const rest = quotes.filter((q) => !matching.includes(q));
  return [...matching, ...rest].slice(0, EXPLICIT_SEARCH_QUOTES_PER_MEMORY).map((q) => clip(q, EXPLICIT_SEARCH_QUOTE_MAX));
}

/**
 * 発言がExplicit Memory Searchなら、保存済みMemory全体を検索して、Chatへ渡す形を返す。そうでなければnull
 * （通常会話は従来のRetrievalのまま。この関数は通常Retrievalに一切影響しない）。検索結果が0件でもnullにはしない
 * （「探したが保存済みMemoryには見つからなかった」ことをChatへ伝えるため）。
 */
export function buildExplicitSearchContext(
  all: readonly MemoryObject[],
  userText: string,
  options: { excludeConversationId?: string } = {}
): ExplicitSearchContext | null {
  const intent = detectExplicitMemorySearch(userText);
  if (!intent) return null;
  const { hits, total } = searchMemories(all, intent, options);
  const termTexts = intent.terms.map((term) => term.text);
  return {
    terms: termTexts,
    total,
    results: hits.map(({ memory, matchedFields, matchedTerms }) => ({
      id: memory.id,
      date: memory.date,
      ...(memory.statedAt ? { statedAt: memory.statedAt } : {}),
      ...(memory.eventTime ? { eventTime: memory.eventTime } : {}),
      ...(memory.eventTimePrecision ? { eventTimePrecision: memory.eventTimePrecision } : {}),
      summary: memory.summary,
      keywords: memory.keywords,
      detail: detailSnippet(memory.content, matchedTerms.length > 0 ? matchedTerms : termTexts),
      evidenceQuotes: pickQuotes(memory, matchedTerms.length > 0 ? matchedTerms : termTexts),
      matchedOn: matchedFields,
      ...(memory.metadata?.source ? { source: memory.metadata.source } : {}),
    })),
  };
}

/**
 * サーバー側の再検証（fail-soft。ProfileのsanitizeProfileContextと同じ方針）。件数・文字数の上限をここでも守り、
 * 形が不正なら安全に空へ倒す。クライアントの値は信用しない（上限とフィールドの型だけを通す）。
 */
export function sanitizeExplicitSearchContext(raw: unknown): ExplicitSearchContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? clip(v, max) : undefined);
  const terms = (Array.isArray(r.terms) ? r.terms : []).map((t) => str(t, 40)).filter((t): t is string => t !== undefined).slice(0, EXPLICIT_SEARCH_MAX_TERMS);
  if (terms.length === 0) return null;
  const results: ExplicitSearchResult[] = [];
  for (const item of Array.isArray(r.results) ? r.results : []) {
    if (results.length >= EXPLICIT_SEARCH_LIMIT) break;
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    const id = str(m.id, 80);
    const date = str(m.date, 40);
    const summary = str(m.summary, 400);
    if (!id || !date || !summary) continue;
    results.push({
      id,
      date,
      ...(str(m.statedAt, 40) ? { statedAt: str(m.statedAt, 40) } : {}),
      ...(str(m.eventTime, 20) ? { eventTime: str(m.eventTime, 20) } : {}),
      ...(str(m.eventTimePrecision, 10) ? { eventTimePrecision: str(m.eventTimePrecision, 10) } : {}),
      summary,
      keywords: (Array.isArray(m.keywords) ? m.keywords : []).map((k) => str(k, 40)).filter((k): k is string => k !== undefined).slice(0, 12),
      detail: str(m.detail, EXPLICIT_SEARCH_DETAIL_MAX + 4) ?? "",
      evidenceQuotes: (Array.isArray(m.evidenceQuotes) ? m.evidenceQuotes : []).map((q) => str(q, EXPLICIT_SEARCH_QUOTE_MAX + 1)).filter((q): q is string => q !== undefined).slice(0, EXPLICIT_SEARCH_QUOTES_PER_MEMORY),
      matchedOn: (Array.isArray(m.matchedOn) ? m.matchedOn : []).map((f) => str(f, 20)).filter((f): f is string => f !== undefined).slice(0, 5),
      ...(str(m.source, 30) ? { source: str(m.source, 30) } : {}),
    });
  }
  const total = typeof r.total === "number" && Number.isFinite(r.total) ? Math.max(results.length, Math.min(Math.floor(r.total), 1000)) : results.length;
  return { terms, total, results };
}
