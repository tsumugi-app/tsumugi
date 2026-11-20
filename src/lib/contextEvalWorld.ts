/**
 * 自動評価基盤 E2：12構成の比較に使う、共通の架空データ（テスト専用。アプリからは読まない）。
 *
 * - 人物・出来事・会話はすべて作りもの（ゆうきさん・はるとさん・ロードバイク・転職の話は架空）。実ユーザーの記憶は含まない。
 * - 本人の発言・理由・訂正（逐語）・人物・話題の経緯・プロフィール・直前の会話・AIの文章（日記の振り返り・Tsumugiの仮説）を含む。
 * - 時刻は EVAL_NOW に固定する（テストは Date を固定して使う）。
 * - 各ケースに、期待する根拠（本人の言葉の一部）と、混入してはいけない情報を書く。判定はプロンプトの文字列で行う（AIの返答は見ない）。
 *   根拠の目印は、その記録の要約と本人の発言（逐語）の両方に含まれる部分にする（どちらの形でプロンプトに入っても見つかるように）。
 */
import type { MemoryObject, Conversation, ConversationTurn, Persona } from "./types";
import type { StoredHypothesis } from "./synthesisModel";

export const EVAL_NOW = Date.parse("2026-11-15T03:00:00.000Z");

const at = (day: string) => `${day}T03:00:00.000Z`;

interface Row {
  id: string;
  day: string;
  conv: string;
  summary: string;
  quote?: string;
  keywords: string[];
  person?: { name: string; relation?: string };
  topicId?: string;
  reflection?: boolean;
  eventTime?: string;
  profile?: { category: string; slot: string; value: string; statement: string };
}

const ROWS: Row[] = [
  // 転職：考え始め → やめた（給料） → 本人の訂正（本当はチーム）。AIの振り返りは「お金の不安」と読んだ（本人の言葉と矛盾する）
  { id: "job-1", day: "2026-05-24", conv: "c-job-1", summary: "今の会社からの転職を考え始めたと話した。", quote: "今の会社、そろそろ転職しようかな", keywords: ["転職", "仕事"],
    profile: { category: "occupation", slot: "occupation:primary", value: "会社員", statement: "会社員として働いている" } },
  { id: "job-2", day: "2026-06-21", conv: "c-job-2", summary: "転職はやめることにした。理由は給料が下がるからだと話した。", quote: "転職はやめた。給料が下がるから", keywords: ["転職", "給料"] },
  { id: "job-refl", day: "2026-06-22", conv: "c-diary-refl", summary: "転職をやめたのは、お金への不安が強かったからだろう。収入を守りたい気持ちが見えた一日だった。", keywords: ["転職", "お金"], reflection: true },
  { id: "job-3", day: "2026-09-13", conv: "c-job-3", summary: "転職をやめた理由を言い直し、本当は今のチームを離れたくなかったからだと話した。", quote: "給料って言ったけど、本当は今のチームを離れたくなかったからなんだ", keywords: ["転職", "チーム"] },
  // ロードバイク：迷う → 12万円で買った → 50km（話題の経緯つき）
  { id: "bike-1", day: "2026-07-05", conv: "c-bike-1", summary: "ロードバイクを買うか迷っていると話した。", quote: "ロードバイク欲しいけど高いんだよね", keywords: ["自転車", "ロードバイク"], topicId: "topic-bike" },
  { id: "bike-2", day: "2026-08-10", conv: "c-bike-2", summary: "ロードバイクを買ったと話した。", quote: "ロードバイク買った。12万円だった", keywords: ["自転車", "ロードバイク", "買い物"], topicId: "topic-bike", eventTime: "2026-08-09" },
  { id: "bike-3", day: "2026-10-04", conv: "c-bike-3", summary: "自転車で初めて長い距離を走ったと話した。", quote: "自転車で50km走れた！", keywords: ["自転車", "ロードバイク"], topicId: "topic-bike" },
  // ゆうきさん（友人）：喧嘩 → 気まずい → 謝った → 一緒に出かけた
  { id: "yuki-1", day: "2026-06-07", conv: "c-yuki-1", summary: "友人のゆうきさんと約束のことで喧嘩したと話した。", quote: "ゆうきさんと約束のことで喧嘩しちゃった", keywords: ["ゆうきさん", "友人"], person: { name: "ゆうきさん", relation: "friend" } },
  { id: "yuki-2", day: "2026-07-19", conv: "c-yuki-2", summary: "ゆうきさんとまだ気まずいと話した。", quote: "ゆうきさんとはまだ気まずい", keywords: ["ゆうきさん"], person: { name: "ゆうきさん" } },
  { id: "yuki-3", day: "2026-09-06", conv: "c-yuki-3", summary: "ゆうきさんに謝って、また話せるようになったと話した。", quote: "ゆうきさんに謝った。また普通に話せるようになった", keywords: ["ゆうきさん", "仲直り"], person: { name: "ゆうきさん" } },
  { id: "yuki-4", day: "2026-10-25", conv: "c-yuki-4", summary: "ゆうきさんと一緒に自転車で出かけて楽しかったと話した。", quote: "ゆうきさんと自転車で出かけた。楽しかった", keywords: ["ゆうきさん", "自転車"], person: { name: "ゆうきさん" } },
  // 関係のない人物（同僚）と、ほかの話題
  { id: "haru-1", day: "2026-08-24", conv: "c-haru-1", summary: "同僚のはるとさんと昼ご飯を食べたと話した。", quote: "はるとさんとランチ行った", keywords: ["はるとさん", "昼ご飯"], person: { name: "はるとさん", relation: "coworker" } },
  { id: "haru-2", day: "2026-10-11", conv: "c-haru-2", summary: "同僚のはるとさんが部署を異動したと話した。", quote: "はるとさん、異動になったんだって", keywords: ["はるとさん", "仕事"], person: { name: "はるとさん" } },
  { id: "curry", day: "2026-07-26", conv: "c-curry", summary: "スパイスからカレーを作ったと話した。", quote: "スパイスからカレー作ってみた", keywords: ["料理", "カレー"] },
  { id: "movie", day: "2026-09-27", conv: "c-movie", summary: "古い映画を観て面白かったと話した。", quote: "昔の映画、意外と面白かった", keywords: ["映画"] },
];

function rowToMemory(r: Row): MemoryObject {
  {
    const t = at(r.day);
    const m: Record<string, unknown> = {
      id: r.id, date: t, statedAt: t, types: r.reflection ? ["insight"] : ["conversation"], conversationId: r.conv,
      content: r.summary, summary: r.summary, keywords: r.keywords,
      themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
      createdAt: t, updatedAt: t,
      metadata: { id: `meta-${r.id}`, source: r.reflection ? "system-generated" : "ai-capture", schemaVersion: "0.1", createdAt: t, updatedAt: t },
    };
    if (r.quote) m.evidenceQuotes = [r.quote];
    if (r.eventTime) { m.eventTime = r.eventTime; m.eventTimePrecision = "day"; }
    if (r.person && r.quote) {
      m.personMentions = [{ id: `pm-${r.id}`, groupingKey: r.person.name, displayName: r.person.name, ...(r.person.relation ? { relation: r.person.relation } : {}), assertion: "mention", stated: "explicit", quote: r.quote, statedAt: t, sourceConversationId: r.conv, recordedAt: t, origin: "ai-extracted", schemaVersion: 1 }];
    }
    if (r.topicId && r.quote) {
      m.topicId = r.topicId;
      m.topicEvents = [{ id: `te-${r.id}`, topicId: r.topicId, quote: r.quote, statedAt: t, sourceConversationId: r.conv, recordedAt: t, origin: "ai-extracted", schemaVersion: 1 }];
    }
    if (r.profile && r.quote) {
      m.profileClaims = [{ id: `pc-${r.id}`, category: r.profile.category, slot: r.profile.slot, value: r.profile.value, statement: r.profile.statement, tense: "current", change: "none", stated: "explicit", quote: r.quote, statedAt: t, sourceConversationId: r.conv, recordedAt: t, origin: "ai-extracted", schemaVersion: 1 }];
    }
    return m as unknown as MemoryObject;
  }
}

export function evalMemories(): MemoryObject[] {
  return ROWS.map(rowToMemory);
}

/**
 * 佐藤さんの独立した記録セット（N1〜N4 用）。共有の評価世界（ROWS）に足すと既存ケースの選択が変わりうるため分ける。
 * 佐藤さん（同僚）：登山の約束（2026-04-12、217日前）→ 喧嘩（2026-05-17、182日前）→ まだ気まずい（2026-07-04、134日前）
 * → ランチした（2026-10-30、16日前）→ 海外赴任の話（2026-11-12、3日前）。ほかに人物のいない旅行の記録。
 */
const SATO_ROWS: Row[] = [
  { id: "sato-1", day: "2026-04-12", conv: "c-sato-1", summary: "佐藤さんと秋に登山に行く約束をしたと話した。", quote: "佐藤さんと秋に登山に行く約束をした", keywords: ["佐藤さん", "登山", "約束"], person: { name: "佐藤さん", relation: "coworker" } },
  { id: "sato-2", day: "2026-05-17", conv: "c-sato-2", summary: "佐藤さんと仕事の進め方で喧嘩したと話した。", quote: "佐藤さんと仕事の進め方で喧嘩しちゃった", keywords: ["佐藤さん", "仕事"], person: { name: "佐藤さん" } },
  { id: "sato-3", day: "2026-07-04", conv: "c-sato-3", summary: "佐藤さんとまだ気まずいと話した。", quote: "佐藤さんとはまだ気まずい", keywords: ["佐藤さん"], person: { name: "佐藤さん" } },
  { id: "sato-4", day: "2026-10-30", conv: "c-sato-4", summary: "佐藤さんと駅前の店でランチをしたと話した。", quote: "佐藤さんと駅前の店でランチした", keywords: ["佐藤さん", "ランチ"], person: { name: "佐藤さん" } },
  { id: "sato-5", day: "2026-11-12", conv: "c-sato-5", summary: "佐藤さんが来月から海外赴任になると聞いたと話した。", quote: "佐藤さん、来月から海外赴任になるんだって", keywords: ["佐藤さん", "海外赴任"], person: { name: "佐藤さん" } },
  { id: "trip-1", day: "2026-08-15", conv: "c-trip-1", summary: "夏休みの行き先を決めたと話した。", quote: "夏休みの行き先を決めた", keywords: ["旅行", "行き先"] },
];

export function evalSatoMemories(): MemoryObject[] {
  return SATO_ROWS.map(rowToMemory);
}

/** a conversation that ended an hour before EVAL_NOW (the recent conversation), and an old one */
export function evalConversations(): Conversation[] {
  return [
    { id: "c-recent", persona: "analyst", startedAt: "2026-11-15T01:30:00.000Z", endedAt: "2026-11-15T02:00:00.000Z", createdAt: "2026-11-15T01:30:00.000Z", updatedAt: "2026-11-15T02:00:00.000Z", memoryObjectIds: [],
      turns: [{ role: "user", content: "さっきまでゆうきさんと自転車の話をしてた", timestamp: "2026-11-15T01:31:00.000Z" }, { role: "ai", content: "楽しそうですね。", timestamp: "2026-11-15T01:31:10.000Z" }] },
    { id: "c-old", persona: "companion", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T11:00:00.000Z", memoryObjectIds: [],
      turns: [{ role: "user", content: "映画を観た", timestamp: "2026-10-01T10:01:00.000Z" }] },
  ] as unknown as Conversation[];
}

/** the people the user confirmed as the same person (Memory Graph P1-B) */
export const EVAL_ALIASES: string[][] = [["ゆうきさん", "ゆうき"]];

/** the AI's own texts: they must reach the prompt only with their label (never as the user's words) */
export const AI_TEXTS = {
  reflection: "お金への不安が強かったからだろう",
  hypothesisJob: "収入が減ることへの不安が一番大きかった",
  hypothesisYuki: "前より近くなっているように見える",
} as const;

/** Tsumugi's cached hypotheses (Memory Synthesis S1), made to be usable now: the state fingerprint is filled in by the runner */
export function evalHypotheses(fingerprint: (themeLabel: string) => string, themeId: (themeLabel: string) => string): StoredHypothesis[] {
  const memories = evalMemories();
  const ev = (ids: string[]) => ids.map((id) => ({ memoryId: id, updatedAt: memories.find((m) => m.id === id)!.updatedAt }));
  const base = (id: string, label: string, statement: string, support: "derived" | "hypothesis", ids: string[]): StoredHypothesis => ({
    schemaVersion: 1, origin: "ai-synthesis", id, themeId: themeId(label), themeKind: "keyword", themeLabel: label, kind: "pattern", statement, support,
    evidence: ev(ids), firstStatedAt: memories.find((m) => m.id === ids[0])!.statedAt as string, lastStatedAt: memories.find((m) => m.id === ids[ids.length - 1])!.statedAt as string,
    generationId: "gen-fictional", generatedAt: "2026-11-01T00:00:00.000Z", stateFingerprint: fingerprint(label), status: "active", shownIn: [],
  });
  return [
    base("hyp-job", "転職", `転職をやめたのは、${AI_TEXTS.hypothesisJob}からかもしれない`, "hypothesis", ["job-1", "job-2", "job-3"]),
    base("hyp-yuki", "ゆうきさん", `ゆうきさんとの関係は、気まずい時期を経て${AI_TEXTS.hypothesisYuki}`, "derived", ["yuki-1", "yuki-2", "yuki-3", "yuki-4"]),
  ];
}

export type EvalCaseKind = "具体的な事実" | "理由・訂正" | "人物名を省いた継続" | "時系列の変化" | "雑談" | "記憶がない質問" | "AIの仮説との矛盾" | "複数経路での重複" | "明示的な検索" | "直前の会話の続き" | "人物名を明示した振り返り" | "名前を省略した呟き" | "気持ちの変化の呟き" | "近況報告" | "曖昧な呟き" | "複数人物の会話" | "人物の切り替わり" | "話題の切り替わり";

export interface EvalCase {
  id: string;
  kind: EvalCaseKind;
  persona: Persona;
  /** 使う記録セット（未指定は共有の評価世界。"sato" は佐藤さんの独立セット：既存ケースの選択を変えないため分けてある） */
  world?: "sato";
  /** the user's turns of this conversation (the last one is the question) */
  turns: string[];
  /** the user's own words that the prompt must carry (a part of the verbatim quote) */
  required: string[];
  /** a reason or a correction among `required` (protected: must reach the prompt in every configuration) */
  protectedReasons?: string[];
  /** words that answer the question directly (a part of `required`) */
  direct: string[];
  /** helpful but not needed */
  optional?: string[];
  /** must not be in the prompt (unrelated people and records) */
  forbidden: string[];
  /** a question with nothing in the Memories: the prompt should say that nothing was found */
  expectNotFound?: boolean;
}

export const EVAL_CASES: EvalCase[] = [
  { id: "fact-bike-price", kind: "具体的な事実", persona: "analyst", turns: ["前に買ったロードバイクって、いくらだったっけ？"], required: ["12万円"], direct: ["12万円"], optional: ["50km"], forbidden: ["はるとさん", "カレー"] },
  { id: "reason-job", kind: "理由・訂正", persona: "analyst", turns: ["転職をやめたのって、なんでだったっけ？"], required: ["チームを離れたくなかった"], protectedReasons: ["チームを離れたくなかった"], direct: ["チームを離れたくなかった"], optional: ["給料が下がるから"], forbidden: ["はるとさん", "ロードバイク"] },
  { id: "person-omitted", kind: "人物名を省いた継続", persona: "analyst", turns: ["ゆうきさんのこと、覚えてる？", "あの後、仲直りできたんだっけ？"], required: ["ゆうきさんに謝"], direct: ["ゆうきさんに謝"], optional: ["約束のことで喧嘩"], forbidden: ["はるとさん"] },
  { id: "change-yuki", kind: "時系列の変化", persona: "analyst", turns: ["ゆうきさんへの気持ちって、どう変わってきたと思う？"], required: ["約束のことで喧嘩", "話せるようになった"], direct: ["話せるようになった"], optional: ["まだ気まずい", "楽しかった"], forbidden: ["はるとさん"] },
  { id: "chat-weather", kind: "雑談", persona: "companion", turns: ["今日は天気がいいし、どこか出かけたいな"], required: [], direct: [], optional: ["自転車", "ロードバイク"], forbidden: ["はるとさん", "転職"] },
  { id: "none-mars", kind: "記憶がない質問", persona: "analyst", turns: ["前に話した火星旅行の計画、どうなってたっけ？"], required: [], direct: [], forbidden: ["ロードバイク", "転職", "ゆうきさん", "はるとさん"], expectNotFound: true },
  // the same kind without words that turn web search on (the Mars question does: the server then keeps its Memory filter off and adds no not-found note)
  { id: "none-pottery", kind: "記憶がない質問", persona: "analyst", turns: ["前に話した陶芸教室のこと、どうなってたっけ？"], required: [], direct: [], forbidden: ["ロードバイク", "転職", "ゆうきさん", "はるとさん"], expectNotFound: true },
  { id: "contradict-job", kind: "AIの仮説との矛盾", persona: "analyst", turns: ["転職をやめたのは、結局お金の不安が一番だったのかな？"], required: ["チームを離れたくなかった"], protectedReasons: ["チームを離れたくなかった"], direct: ["チームを離れたくなかった"], optional: ["給料が下がるから"], forbidden: ["はるとさん"] },
  { id: "dup-yuki", kind: "複数経路での重複", persona: "analyst", turns: ["ゆうきさんと最近どうしてる？"], required: ["自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["ゆうきさんに謝"], forbidden: ["はるとさん"] },
  { id: "search-bike", kind: "明示的な検索", persona: "analyst", turns: ["自転車について何話した？"], required: ["12万円", "50km"], direct: ["12万円", "50km"], optional: ["高いんだよね"], forbidden: ["はるとさん", "転職"] },
  { id: "recent-continue", kind: "直前の会話の続き", persona: "companion", turns: ["さっきの話の続きなんだけど、ゆうきさんとまた出かけたいな"], required: ["さっきまでゆうきさんと自転車の話"], direct: ["さっきまでゆうきさんと自転車の話"], optional: ["自転車で出かけ"], forbidden: ["はるとさん", "転職"] },
  // companion の人物ケース（本命ペルソナの Memory 選択を測る。上の人物ケース person-omitted / change-yuki は analyst のみだった）。
  // 1件ずつ analyst の対照ケース（-analyst）も置き、同じ入力で人物を扱う経路が何を届けるかを比べる。
  // 気持ちの変化の呟きは、弧の発火条件の語（変わ・変化・ようになっ・変え）を避けた自然な言い方にしてある。
  { id: "person-named-reflect", kind: "人物名を明示した振り返り", persona: "companion", turns: ["ゆうきさんとの関係、最近どうなってきてるんだろう"], required: ["自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["ゆうきさんに謝", "まだ気まずい"], forbidden: ["はるとさん"] },
  { id: "person-named-reflect-analyst", kind: "人物名を明示した振り返り", persona: "analyst", turns: ["ゆうきさんとの関係、最近どうなってきてるんだろう"], required: ["自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["ゆうきさんに謝", "まだ気まずい"], forbidden: ["はるとさん"] },
  { id: "person-carried-murmur", kind: "名前を省略した呟き", persona: "companion", turns: ["ゆうきさんのことなんだけど", "あの人とは、もう大丈夫な気がする"], required: ["自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["ゆうきさんに謝"], forbidden: ["はるとさん"] },
  { id: "person-carried-murmur-analyst", kind: "名前を省略した呟き", persona: "analyst", turns: ["ゆうきさんのことなんだけど", "あの人とは、もう大丈夫な気がする"], required: ["自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["ゆうきさんに謝"], forbidden: ["はるとさん"] },
  // 以前と現在のペア：必須の根拠2件＝以前の強い気持ち（まだ気まずい）と最近の記録（自転車で出かけ）。両方そろって初めてペア成立
  { id: "person-feeling-change", kind: "気持ちの変化の呟き", persona: "companion", turns: ["ゆうきさんのこと、前ほどモヤモヤしなくなった気がする"], required: ["まだ気まずい", "自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["話せるようになった"], forbidden: ["はるとさん"] },
  { id: "person-feeling-change-analyst", kind: "気持ちの変化の呟き", persona: "analyst", turns: ["ゆうきさんのこと、前ほどモヤモヤしなくなった気がする"], required: ["まだ気まずい", "自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["話せるようになった"], forbidden: ["はるとさん"] },
  // 近況報告：過去の根拠は必須ではない。このケースの forbidden は「他人の混入」ではなく「単なる近況報告で持ち出すべきでない深い過去（喧嘩・気まずい時期）」の目印
  { id: "person-status-update", kind: "近況報告", persona: "companion", turns: ["ゆうきさんと明日ランチに行くことになったよ"], required: [], direct: [], optional: ["自転車で出かけ"], forbidden: ["約束のことで喧嘩", "まだ気まずい"] },
  // 曖昧な呟き：2人とも候補になりうるが特定はできない。成功＝どちらの人物の記録も「特定したもの」として選ばれないこと（必須なし・全人物の目印が混入扱い）
  { id: "person-ambiguous-murmur", kind: "曖昧な呟き", persona: "companion", turns: ["ゆうきさんとはるとさん、最近どっちも会えてないな", "あの人、元気にしてるかな"], required: [], direct: [], forbidden: ["約束のことで喧嘩", "まだ気まずい", "自転車で出かけ", "話せるようになった", "ランチ行った", "異動になった"] },
  { id: "person-multi-focus", kind: "複数人物の会話", persona: "companion", turns: ["ゆうきさんとはるとさんの近況なんだけど", "ゆうきさんのほうは、最近どうしてるんだっけ？"], required: ["自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["ゆうきさんに謝"], forbidden: ["ランチ行った", "異動になった"] },
  { id: "person-multi-focus-analyst", kind: "複数人物の会話", persona: "analyst", turns: ["ゆうきさんとはるとさんの近況なんだけど", "ゆうきさんのほうは、最近どうしてるんだっけ？"], required: ["自転車で出かけ"], direct: ["自転車で出かけ"], optional: ["ゆうきさんに謝"], forbidden: ["ランチ行った", "異動になった"] },
  { id: "person-switch-focus", kind: "人物の切り替わり", persona: "companion", turns: ["ゆうきさんのこと、最近どうしてるんだっけ？", "ところで、はるとさんは元気にしてるかな"], required: ["異動になった"], direct: ["異動になった"], optional: ["ランチ行った"], forbidden: ["約束のことで喧嘩", "まだ気まずい", "自転車で出かけ", "話せるようになった"] },
  { id: "person-switch-focus-analyst", kind: "人物の切り替わり", persona: "analyst", turns: ["ゆうきさんのこと、最近どうしてるんだっけ？", "ところで、はるとさんは元気にしてるかな"], required: ["異動になった"], direct: ["異動になった"], optional: ["ランチ行った"], forbidden: ["約束のことで喧嘩", "まだ気まずい", "自転車で出かけ", "話せるようになった"] },
  // 佐藤さんケース（N1〜N4、独立セット）。companion の人物機構のうち、ケース1〜7では測れない形を固定する。
  // N1：近況報告（ケース4の佐藤さん版）。無関係な深い過去（喧嘩・気まずい時期）が選ばれないこと
  { id: "person-sato-status", kind: "近況報告", persona: "companion", world: "sato", turns: ["明日、佐藤さんとランチする"], required: [], direct: [], optional: ["ランチした"], forbidden: ["喧嘩", "まだ気まずい"] },
  // N2：久しぶり＋緊張は「気まずい時期」へのつながりに見えるが、設計の受け皿（最新の記録／名前以外のキーワード／話題・理由／
  // 名前を伏せた文字列の共有）のどれにも機械的には当たらない。届くかどうかは実測して報告する（optional に置き、合否にはしない）
  { id: "person-sato-nervous", kind: "近況報告", persona: "companion", world: "sato", turns: ["明日、久しぶりに佐藤さんとランチする。ちょっと緊張する"], required: [], direct: [], optional: ["まだ気まずい", "ランチした"], forbidden: ["喧嘩"] },
  // N3：半年以上前の記録でも、話題のつながり（登山・約束のキーワード）が明確なら届くこと（P4 の受け皿）
  { id: "person-sato-old-promise", kind: "具体的な事実", persona: "companion", world: "sato", turns: ["佐藤さんとの約束、秋に登山に行くって話、どうなったっけ？"], required: ["登山に行く約束"], direct: ["登山に行く約束"], optional: [], forbidden: ["喧嘩", "まだ気まずい"] },
  // N4：人物の話から話題が切り替わった後は、その人物の最近の記録でも新しさ・人物一致だけで選ばれないこと
  { id: "person-sato-switch", kind: "話題の切り替わり", persona: "companion", world: "sato", turns: ["佐藤さんのことなんだけど", "ところで、来週の旅行の行き先、決めたっけ？"], required: ["行き先を決めた"], direct: ["行き先を決めた"], optional: [], forbidden: ["海外赴任", "喧嘩", "まだ気まずい", "ランチした"] },
];

/** the conversation's turns: one minute apart, ending a minute before EVAL_NOW */
export function evalTurns(c: EvalCase): ConversationTurn[] {
  return c.turns.flatMap((content, i) => {
    const t = new Date(EVAL_NOW - (c.turns.length - i) * 60_000).toISOString();
    const user = { role: "user" as const, content, timestamp: t };
    return i < c.turns.length - 1 ? [user, { role: "ai" as const, content: "そうなんですね。", timestamp: t }] : [user];
  });
}
