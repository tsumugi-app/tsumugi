/**
 * EXPERIMENT (Preview comparison only; not used by the app): person-aware retrieval ("R2").
 * Built ON TOP of the production selection (selectConversationDirectMatches is called unchanged); production retrieval is not modified.
 *
 * When ONE known person is the subject of the turn — named in the latest message, or carried over from earlier turns by the production person
 * continuity — it:
 *   1. treats a Memory as that person's when its personMentions name them OR one of its keywords is exactly their name
 *      (never a substring: "まさきさん" is not "さきさん"; names in a message are matched longest-first, so "まさきさん" hides the "さき" inside it);
 *   2. drops, from the production selection, Memories that are about a DIFFERENT known person and not this one (a shared word such as 「距離」
 *      must not bring another person's record);
 *   3. adds at most PERSON_EXTRA_LIMIT of the person's other Memories: the most recent one (the present), and the one that overlaps the
 *      conversation most, the person's name left out of the comparison (which may be an older feeling or relationship record). Never all of them.
 * 「2人」「２人」 are read as 「二人」 for retrieval only. No person, or two people named in the message: the production selection as it is.
 * R3 (options.feelingSlot): additionally at most ONE feelings record of the same person, only when the turn is about the relationship or
 * feelings (not plain work progress), the most related to the conversation first, then the newest; none when nothing fits.
 * Pure function: no IndexedDB, no AI call.
 */
import { computeKeywordFrequency, DEFAULT_LIMIT, deriveConversationPersonFocus, scoreMemory, selectConversationDirectMatches } from "./retrieval";
import type { MemoryObject } from "./types";

export const PERSON_EXTRA_LIMIT = 2;

/** relation words are not names (the production continuity excludes them too) */
const GENERIC_PERSON_WORDS = new Set(["母", "父", "両親", "妻", "夫", "姉", "兄", "弟", "妹", "祖母", "祖父", "家族", "息子", "娘", "子ども", "子供", "上司", "部下", "同僚", "先輩", "後輩", "先生", "友達", "友人", "彼氏", "彼女", "恋人", "親友", "知人", "社長", "店長"]);

const nfkc = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
/** the same key as the production continuity: honorific removed when at least 2 characters remain */
export function personKey(name: string): string {
  const base = nfkc(name);
  const stripped = base.replace(/(さん|ちゃん|くん|君|様|氏)$/, "");
  return Array.from(stripped).length >= 2 ? stripped : base;
}
export const normalizeTwoPeople = (text: string) => text.replace(/2人|２人/g, "二人");

export function knownPersonKeys(pool: MemoryObject[]): string[] {
  const keys = new Set<string>();
  for (const m of pool) for (const p of m.personMentions ?? []) {
    const key = personKey(p.displayName ?? p.groupingKey ?? "");
    if (Array.from(key).length >= 2 && !GENERIC_PERSON_WORDS.has(key)) keys.add(key);
  }
  return [...keys];
}

/** known people named in a text, longest name first, each match masked so that a shorter name inside it is not counted again */
export function personKeysInText(text: string, keys: string[]): string[] {
  let rest = nfkc(text);
  const found: string[] = [];
  for (const key of [...keys].sort((a, b) => Array.from(b).length - Array.from(a).length)) {
    if (!rest.includes(key)) continue;
    found.push(key);
    rest = rest.split(key).join("■".repeat(Array.from(key).length));
  }
  return found;
}

export function isAboutPerson(m: MemoryObject, key: string): boolean {
  if ((m.personMentions ?? []).some((p) => personKey(p.displayName ?? p.groupingKey ?? "") === key)) return true;
  return (m.keywords ?? []).some((k) => personKey(k) === key);
}

const timeOf = (m: MemoryObject) => Date.parse(m.statedAt ?? m.date);

export interface PersonRetrievalResult {
  memories: MemoryObject[];
  target: { key: string; how: "named" | "carried" } | null;
  added: { id: string; why: string }[];
  dropped: { id: string; why: string }[];
  /** R3 only: the feelings record added (or why none was) */
  feeling?: { added: string | null; why: string };
}

// ---------------------------------------------------------------------------
// R3: at most one feelings record of the person, only when the turn is about the relationship / feelings
// ---------------------------------------------------------------------------

/** words of feelings in a record (its keywords or summary); a record whose types include "emotion" counts too */
const FEELING_WORDS = /寂し|さみし|嫉妬|妬|大切|大事|好き|嫌い|不安|辛い|つらい|悲し|嬉し|うれし|安心|ほっと|モヤモヤ|もやもや|葛藤|信頼|傷つ|怖|距離|気持ち|会いたい|恋し/;
export function isFeelingRecord(m: MemoryObject): boolean {
  if ((m.types ?? []).includes("emotion" as never)) return true;
  return FEELING_WORDS.test(`${(m.keywords ?? []).join(" ")} ${m.summary}`);
}

/** the user talks about feelings, or about what the relationship means ("二人だけでいたい", "距離", "空気感", "ほんとは〜したい") */
const RELATION_CUES = /寂し|さみし|嫉妬|妬|大切|大事|好き|嫌い|嫌われ|不安|辛い|つらい|悲し|嬉し|うれし|安心|ほっと|モヤモヤ|もやもや|傷つ|怖|気持ち|会いたい|話したい|一緒にいたい|二人だけ|二人でいたい|二人の時間|距離|空気感|関係|存在|避け|冷た|そっけな|離れ|ほんとは|本当は|本音/;
/** plain work progress / task talk */
const WORK_CUES = /プレゼン|資料|締め切り|締切|会議|打ち合わせ|見積|タスク|分担|スケジュール|進め方|段取り|納期|作業|手順|報告|担当/;

export function relationTalk(latest: string, previousUserTurn?: string): { yes: boolean; why: string } {
  const lat = normalizeTwoPeople(nfkc(latest));
  if (RELATION_CUES.test(lat)) return { yes: true, why: `今の発言（「${lat.match(RELATION_CUES)?.[0]}」）` };
  if (WORK_CUES.test(lat)) return { yes: false, why: `今の発言は業務の話（「${lat.match(WORK_CUES)?.[0]}」）` };
  const prev = previousUserTurn ? normalizeTwoPeople(nfkc(previousUserTurn)) : "";
  if (prev && RELATION_CUES.test(prev)) return { yes: true, why: `直前の発言（「${prev.match(RELATION_CUES)?.[0]}」）` };
  return { yes: false, why: "関係や気持ちの話ではない" };
}

export interface PersonRetrievalOptions {
  /** R3: add at most one feelings record of the person when the turn is about the relationship */
  feelingSlot?: boolean;
  /**
   * how the feelings record is chosen:
   *   "tie"    (R3 as compared before): keyword match, then text similarity, then recency
   *   "newest" (R3n): a record whose own keyword appears in the conversation; otherwise the person's newest feelings record
   *   "none"   (R3x): a record whose own keyword appears in the conversation; otherwise nothing
   */
  feelingPick?: "tie" | "newest" | "none";
}

export function selectWithPersonRetrieval(pool: MemoryObject[], latest: string, userTurns: string[], options: PersonRetrievalOptions = {}): PersonRetrievalResult {
  const lat = normalizeTwoPeople(latest);
  const turns = userTurns.map(normalizeTwoPeople);
  const base = selectConversationDirectMatches(pool, lat, turns, computeKeywordFrequency(pool), DEFAULT_LIMIT).kept.map((e) => e.memory);
  const keys = knownPersonKeys(pool);
  const named = personKeysInText(latest, keys);
  let target: PersonRetrievalResult["target"] = null;
  if (named.length === 1) {
    target = { key: named[0], how: "named" };
  } else if (named.length === 0) {
    // the production continuity, over a copy in which a Memory whose keyword is exactly a known name also counts as that person's record
    const linked = pool.map((m) => {
      const extra = keys.filter((k) => !(m.personMentions ?? []).some((p) => personKey(p.displayName ?? "") === k) && (m.keywords ?? []).some((kw) => personKey(kw) === k));
      return extra.length === 0 ? m : ({ ...m, personMentions: [...(m.personMentions ?? []), ...extra.map((k) => ({ displayName: k, groupingKey: k }))] } as unknown as MemoryObject);
    });
    const focus = deriveConversationPersonFocus(turns, linked);
    if (focus) target = { key: personKey(focus.displayName), how: "carried" };
  }
  if (!target) return { memories: base, target: null, added: [], dropped: [] };

  const dropped: PersonRetrievalResult["dropped"] = [];
  const kept = base.filter((m) => {
    const others = keys.filter((k) => k !== target!.key && isAboutPerson(m, k));
    if (others.length > 0 && !isAboutPerson(m, target!.key)) {
      dropped.push({ id: m.id, why: `別の人物（${others.join("・")}）の記録` });
      return false;
    }
    return true;
  });

  const candidates = pool.filter((m) => isAboutPerson(m, target!.key) && !kept.includes(m));
  const added: PersonRetrievalResult["added"] = [];
  // overlap is measured WITHOUT the person's names (the name alone would make every record of the person look related)
  const query = keys.reduce((q, k) => q.split(k).join(" "), nfkc(turns.join(" ")).replace(/(さん|ちゃん|くん|君|様|氏)/g, " "));
  const newest = [...candidates].sort((a, b) => timeOf(b) - timeOf(a))[0];
  if (newest) added.push({ id: newest.id, why: "この人物の最新の記録" });
  // a record "overlaps" only when one of its own keywords (not the person's name) appears in the conversation; text similarity only breaks ties
  const overlap = candidates
    .filter((m) => m !== newest)
    .map((m) => {
      const ownKeywords = (m.keywords ?? []).filter((k) => !keys.includes(personKey(k)));
      const hits = ownKeywords.filter((k) => query.includes(nfkc(k))).length;
      const tie = scoreMemory({ ...m, keywords: [], summary: keys.reduce((t, k) => t.split(k).join(" "), m.summary), content: "" }, query);
      return { m, hits, tie };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.tie - a.tie || timeOf(b.m) - timeOf(a.m))[0];
  if (overlap) added.push({ id: overlap.m.id, why: "会話の内容と最も重なる記録" });
  const chosen = added.slice(0, PERSON_EXTRA_LIMIT);
  let feeling: PersonRetrievalResult["feeling"];
  if (options.feelingSlot) {
    const talk = relationTalk(latest, turns.length >= 2 ? turns[turns.length - 2] : undefined);
    const already = new Set([...kept.map((m) => m.id), ...chosen.map((a) => a.id)]);
    const hasFeelingAlready = [...kept, ...chosen.map((a) => pool.find((m) => m.id === a.id)!)].some((m) => isFeelingRecord(m) && isAboutPerson(m, target!.key));
    if (!talk.yes) {
      feeling = { added: null, why: `追加なし：${talk.why}` };
    } else {
      // only this person's records (never another person's), relevance to the conversation first, then recency
      const pick = pool
        .filter((m) => isAboutPerson(m, target!.key) && !already.has(m.id) && isFeelingRecord(m))
        .filter((m) => !keys.some((k) => k !== target!.key && isAboutPerson(m, k)))
        .map((m) => {
          const ownKeywords = (m.keywords ?? []).filter((k) => !keys.includes(personKey(k)));
          const hits = ownKeywords.filter((k) => query.includes(nfkc(k))).length;
          const tie = scoreMemory({ ...m, keywords: [], summary: keys.reduce((t, k) => t.split(k).join(" "), m.summary), content: "" }, query);
          return { m, hits, tie };
        })
        .filter((x) => (options.feelingPick ?? "tie") === "tie" || x.hits > 0 || options.feelingPick === "newest")
        .sort((a, b) =>
          (options.feelingPick ?? "tie") === "tie"
            ? b.hits - a.hits || b.tie - a.tie || timeOf(b.m) - timeOf(a.m)
            : b.hits - a.hits || timeOf(b.m) - timeOf(a.m) // R3n / R3x: no text-similarity guess
        )[0];
      if (!pick) feeling = { added: null, why: `追加なし：${hasFeelingAlready ? "気持ちの記録はすでに含まれている" : "この人物の気持ちの記録が無い"}（${talk.why}）` };
      else feeling = { added: pick.m.id, why: `${talk.why}が関係・気持ちの話。${pick.hits > 0 ? `会話とキーワードが一致する気持ちの記録（${(pick.m.keywords ?? []).filter((k) => !keys.includes(personKey(k)) && query.includes(nfkc(k))).join("・")}）` : options.feelingPick === "newest" || pick.tie <= 0 ? "関連が判断できないため、この人物の最新の気持ちの記録" : "会話と言葉が近い気持ちの記録"}` };
    }
  }
  const extra = [...chosen.map((a) => pool.find((m) => m.id === a.id)!), ...(feeling?.added ? [pool.find((m) => m.id === feeling!.added)!] : [])];
  return { memories: [...kept, ...extra], target, added: chosen, dropped, ...(feeling ? { feeling } : {}) };
}
