/**
 * Conversation quality, step 1 (owner decision 2026-11-08): what the chat AI receives for each selected Memory, besides its summary and keywords.
 *
 * 1. Context of a selected Memory (chosen on the device, from the saved Memory; nothing new is saved and no AI is called):
 *    - `persons`: the people the user talked about in that record (`personMentions[].displayName`), at most MEMORY_CONTEXT_MAX_PERSONS,
 *      so the AI knows WHO a view was about.
 *    - `quote`: one sentence of the user's own words (`evidenceQuotes`), only when the summary does not already say it
 *      (a sentence mostly covered by the summary is not sent). Among the sentences that add something, the one closest to the current turn is taken.
 *      At most MEMORY_CONTEXT_MAX_QUOTES quotes per turn, in the order of the selection, each cut to MEMORY_CONTEXT_QUOTE_MAX_CHARS.
 *    The full content of a Memory is never sent.
 * 2. The "time-dependent" filter of the chat route: a Memory whose summary or keywords name an outside, changing fact (価格, 在庫, 営業時間, 最新…)
 *    is still kept out of a turn without web search. A Memory that only says 「今は」「今の」「現在」「次は」「次回」 is kept out only when it is not the
 *    user's own view (a thought, a feeling, a judgment): the user's past view reaches the AI, as a view of the record's day.
 */
import type { MemoryObject, RetrievedMemory } from "./types";
import { isAllowedTrait } from "./recordRelevance";

export const MEMORY_CONTEXT_MAX_QUOTES = 3;
export const MEMORY_CONTEXT_QUOTE_MAX_CHARS = 80;
export const MEMORY_CONTEXT_MAX_PERSONS = 2;
export const MEMORY_CONTEXT_PERSON_MAX_CHARS = 20;
/** a sentence whose 2-character pieces are at least this much in the summary already says nothing new */
export const MEMORY_CONTEXT_SUMMARY_COVERAGE = 0.6;

const compact = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
function bigrams(text: string): Set<string> {
  const chars = Array.from(compact(text));
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
  return grams;
}
function coverage(part: Set<string>, whole: Set<string>): number {
  if (part.size === 0) return 1;
  let shared = 0;
  for (const gram of part) if (whole.has(gram)) shared += 1;
  return shared / part.size;
}
const clip = (text: string, max: number) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max).join("")}…` : text);

function sentencesOf(quote: string): string[] {
  return (quote.match(/[^。！？!?\n]+[。！？!?]*/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => Array.from(s).length >= 2);
}

/** the people of a record, as the user called them (no relation, no guess) */
export function memoryPersons(memory: Pick<MemoryObject, "personMentions">): string[] {
  const names: string[] = [];
  for (const mention of memory.personMentions ?? []) {
    const name = typeof mention?.displayName === "string" ? mention.displayName.trim() : "";
    if (!name || names.includes(name)) continue;
    names.push(clip(name, MEMORY_CONTEXT_PERSON_MAX_CHARS));
    if (names.length >= MEMORY_CONTEXT_MAX_PERSONS) break;
  }
  return names;
}

/** one sentence of the user's own words that the summary does not already carry, closest to the current turn; undefined if none */
export function memoryQuote(memory: Pick<MemoryObject, "summary" | "evidenceQuotes">, conversationTexts: string[]): string | undefined {
  const summary = bigrams(memory.summary ?? "");
  const turn = bigrams(conversationTexts.join(" "));
  let best: { text: string; relevance: number; novelty: number } | undefined;
  for (const quote of memory.evidenceQuotes ?? []) {
    if (typeof quote !== "string") continue;
    for (const sentence of sentencesOf(quote)) {
      const grams = bigrams(sentence);
      const novelty = 1 - coverage(grams, summary);
      if (1 - novelty >= MEMORY_CONTEXT_SUMMARY_COVERAGE) continue;
      const relevance = coverage(grams, turn);
      if (!best || relevance > best.relevance || (relevance === best.relevance && novelty > best.novelty)) best = { text: sentence, relevance, novelty };
    }
  }
  return best ? clip(best.text, MEMORY_CONTEXT_QUOTE_MAX_CHARS) : undefined;
}

/** persons and a quote for one selected Memory (no keys when there is nothing to add) */
export function memoryContextOf(memory: MemoryObject, conversationTexts: string[]): Pick<RetrievedMemory, "persons" | "quote"> {
  const persons = memoryPersons(memory);
  const quote = memoryQuote(memory, conversationTexts);
  return { ...(persons.length > 0 ? { persons } : {}), ...(quote ? { quote } : {}) };
}

/** the per-turn quote limit, in the order of the selection (earlier selections first) */
export function limitMemoryQuotes<T extends Pick<RetrievedMemory, "quote">>(memories: T[]): T[] {
  let used = 0;
  return memories.map((memory) => {
    if (!memory.quote) return memory;
    if (used < MEMORY_CONTEXT_MAX_QUOTES) {
      used += 1;
      return memory;
    }
    const rest: Pick<RetrievedMemory, "quote"> = { ...memory };
    delete rest.quote;
    return rest as T;
  });
}

/** the chat route's check of what a client sent (the request body is not trusted): strings only, the same limits as above */
export function sanitizeMemoryContext<T extends RetrievedMemory>(memories: T[]): T[] {
  const cleaned = memories.map((memory) => {
    const out: RetrievedMemory = { ...memory };
    delete out.quote;
    delete out.persons;
    delete out.trait;
    // the trait of a record (recordRelevance.ts): only the fixed wording
    if (isAllowedTrait(memory.trait)) out.trait = memory.trait;
    const quote = typeof memory.quote === "string" ? memory.quote.trim() : "";
    if (quote) out.quote = clip(quote, MEMORY_CONTEXT_QUOTE_MAX_CHARS);
    const persons = Array.isArray(memory.persons)
      ? memory.persons.filter((name): name is string => typeof name === "string" && name.trim().length > 0).map((name) => clip(name.trim(), MEMORY_CONTEXT_PERSON_MAX_CHARS)).slice(0, MEMORY_CONTEXT_MAX_PERSONS)
      : [];
    if (persons.length > 0) out.persons = persons;
    return out as T;
  });
  return limitMemoryQuotes(cleaned);
}

/** an outside fact that changes over time (always kept out of a turn without web search, as before) */
const OUTSIDE_STATE_MARKERS = ["最新", "ラインナップ", "販売中", "発売予定", "開催中", "開催予定", "在庫", "価格", "値段", "営業時間", "営業中", "キャンペーン"];
/** words that only say "now" / "next": an outside fact or the user's own view of that day */
const PRESENT_MARKERS = ["現在", "今の", "今は", "次は", "次回"];
/** the user's own thought, feeling or judgment */
export const OWN_VIEW = /思う|思っ|思い|感じ|気持ち|気がする|考え|不安|迷っ|迷い|悩|諦め|あきらめ|後悔|納得|期待|望ん|願っ|信じ|好き|嫌い|怖い|寂し|さみし|つらい|辛い|嬉し|うれし|悲し|決め|決心|つもり|自信|絶望|希望/;

/**
 * a text says "now" only as the user's own view: every sentence with 現在 / 今の / 今は / 次は / 次回 also holds a thought, feeling or judgment word
 * (an opinion in another sentence, or in the quote, does not exempt a present-tense fact: Codex on PR #31)
 */
export function presentOnlyAsOwnView(text: string): boolean {
  const sentences = sentencesOf(text).filter((sentence) => PRESENT_MARKERS.some((marker) => sentence.includes(marker)));
  return sentences.length > 0 && sentences.every((sentence) => OWN_VIEW.test(sentence));
}

/** kept out of a turn without web search: an outside, changing fact (a present-tense summary sentence that is not the user's own view counts as one) */
export function isTimeDependentMemory(memory: Pick<RetrievedMemory, "summary" | "keywords">): boolean {
  const summary = memory.summary ?? "";
  const keywords = (memory.keywords ?? []).join(" ");
  if (OUTSIDE_STATE_MARKERS.some((marker) => `${summary} ${keywords}`.includes(marker))) return true;
  // a present-tense keyword (「今の会社」) is not a sentence that can show a view: kept out, as before
  if (PRESENT_MARKERS.some((marker) => keywords.includes(marker))) return true;
  if (!PRESENT_MARKERS.some((marker) => summary.includes(marker))) return false;
  return !presentOnlyAsOwnView(summary);
}

/**
 * in a turn without web search, a quote is checked like a summary (the Memory itself stays, with its summary): a quote naming an outside, changing fact
 * is not sent, nor one that says 今は / 現在 / 次は… without being the user's own view (「今はランチが千円。」)
 */
export function withoutOutsideFactQuote<T extends Pick<RetrievedMemory, "quote">>(memory: T): T {
  const quote = memory.quote;
  if (!quote) return memory;
  const outside = OUTSIDE_STATE_MARKERS.some((marker) => quote.includes(marker)) || (PRESENT_MARKERS.some((marker) => quote.includes(marker)) && !presentOnlyAsOwnView(quote));
  if (!outside) return memory;
  const rest: Pick<RetrievedMemory, "quote"> = { ...memory };
  delete rest.quote;
  return rest as T;
}

/** the lines under a selected Memory in the prompt ("" when there is nothing to add) */
export function memoryContextLines(memory: Pick<RetrievedMemory, "persons" | "quote" | "trait">): string {
  const lines: string[] = [];
  if (memory.trait) lines.push(`  記録の性質（言い回しからの自動の目安。本人が確かめたものではない）：${memory.trait}`);
  if (memory.persons && memory.persons.length > 0) lines.push(`  話題の人物：${memory.persons.join("、")}`);
  if (memory.quote) lines.push(`  本人の発言（当時の逐語の抜粋）：「${memory.quote}」`);
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/** said once under the list when any Memory carries a person or a quote */
export const MEMORY_CONTEXT_NOTE = `
「本人の発言」は、本人が当時実際に書いた言葉の抜粋（それ以外の要約はAIが整理したもの）。「話題の人物」は、その記録で本人が話題にした人で、別の人についての記録を今話している人の話にしない。`;

/** said once under the list: a past view stays a past view */
export const MEMORY_PAST_VIEW_NOTE = `
記録の中の考え・気持ち・判断（「今は」「現在」と書かれたものも）は記録日時点のもの。今も同じとは限らないので、本人の今の考えとして断定しない。`;
