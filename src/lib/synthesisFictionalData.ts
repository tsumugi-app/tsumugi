/**
 * Fictional long-term Memories of ONE person (May–October 2026), for Memory Synthesis tests and the Preview-only evaluation page.
 * Every name, place and event is invented. Four threads run through it (work / running / time alone vs. with others / mother) plus one-off topics as noise.
 * Nothing here is ever written to IndexedDB or the Vault.
 */
import type { MemoryObject } from "./types";

interface Row {
  day: string;
  conv: number;
  keywords: string[];
  summary: string;
  quote: string;
  eventTime?: string;
  eventTimePrecision?: "day" | "month" | "year";
}

const ROWS: Row[] = [
  { day: "2026-05-09", conv: 1, keywords: ["仕事", "会社"], summary: "今の会社は安定していて、辞めるつもりはないと話した。", quote: "今の会社、給料は普通だけど安定してるし、辞める理由はないかな" },
  { day: "2026-05-10", conv: 2, keywords: ["ランニング", "週末"], summary: "週末に川沿いを5km走り、頭がすっきりしたと話した。", quote: "川沿いを5km走ったら、頭がすっきりした" },
  { day: "2026-05-16", conv: 3, keywords: ["一人の時間", "週末"], summary: "忙しい一週間の後で、週末は誰にも会わず一人で過ごしたいと話した。", quote: "今週は人に会いすぎた。週末は一人でいたい" },
  { day: "2026-05-23", conv: 4, keywords: ["母", "電話"], summary: "母から電話があり、母の体調の話をした。", quote: "母から電話があって、最近ひざが痛いって" },
  { day: "2026-05-30", conv: 5, keywords: ["料理"], summary: "初めてカレーをスパイスから作った。", quote: "スパイスからカレー作ってみた" },
  { day: "2026-06-06", conv: 6, keywords: ["仕事", "上司"], summary: "上司が交代し、企画の仕事に関われなくなったと話した。", quote: "上司が変わってから、企画の会議に呼ばれなくなった" },
  { day: "2026-06-13", conv: 7, keywords: ["ランニング", "仕事"], summary: "仕事でもやもやした日は、夜に走りたくなると話した。", quote: "もやもやした日は、夜に走りたくなる" },
  { day: "2026-06-21", conv: 8, keywords: ["映画"], summary: "古いSF映画を観て面白かったと話した。", quote: "昔のSF映画、意外と面白かった" },
  { day: "2026-07-04", conv: 9, keywords: ["仕事", "転職"], summary: "転職サイトを初めて見たが、年齢的に不安だと話した。", quote: "転職サイト見てみたけど、この年齢だと厳しいかなって不安になった" },
  { day: "2026-07-11", conv: 10, keywords: ["ランニング", "雨"], summary: "雨で一週間走れず、いらいらしたと話した。", quote: "雨で一週間走れなくて、なんかイライラする" },
  { day: "2026-07-19", conv: 11, keywords: ["一人の時間", "キャンプ", "友達"], summary: "友達とキャンプに行き、みんなといると元気が出たと話した。", quote: "みんなでキャンプ行ったら、思ったより元気出た" },
  { day: "2026-07-26", conv: 12, keywords: ["母", "通院"], summary: "母の通院に付き添った。", quote: "母の病院に付き添ってきた", eventTime: "2026-07-25", eventTimePrecision: "day" },
  { day: "2026-08-08", conv: 13, keywords: ["仕事", "UXデザイン", "勉強"], summary: "夜に少しずつUXデザインの勉強を始めたと話した。", quote: "夜にちょっとずつUXデザインの勉強はじめた" },
  { day: "2026-08-15", conv: 14, keywords: ["ランニング", "大会"], summary: "10kmの大会に申し込んだと話した。", quote: "10キロの大会、申し込んじゃった", eventTime: "2026-10", eventTimePrecision: "month" },
  { day: "2026-08-22", conv: 15, keywords: ["料理", "友達"], summary: "友達を家に呼んで餃子を作った。", quote: "友達呼んで餃子パーティーした" },
  { day: "2026-09-05", conv: 16, keywords: ["仕事", "異動", "面談"], summary: "社内のデザイン部門への異動面談を受けることにしたと話した。", quote: "デザイン部門への異動、面談受けてみることにした" },
  { day: "2026-09-12", conv: 17, keywords: ["一人の時間", "夜"], summary: "一人暮らしの夜が最近少し寂しいと話した。", quote: "最近、夜ひとりだとちょっと寂しい" },
  { day: "2026-09-19", conv: 18, keywords: ["母", "電話"], summary: "母とまた電話し、話すと少し安心すると話した。", quote: "母と電話すると、なんか安心する" },
  { day: "2026-09-26", conv: 19, keywords: ["ランニング", "仕事"], summary: "異動面談の前日に走って気持ちを落ち着けたと話した。", quote: "面談の前の日、走って落ち着かせた" },
  { day: "2026-10-04", conv: 20, keywords: ["ランニング", "大会"], summary: "10kmの大会を完走したと話した。", quote: "10キロ完走した！", eventTime: "2026-10-03", eventTimePrecision: "day" },
  { day: "2026-10-10", conv: 21, keywords: ["仕事", "異動"], summary: "異動の話はいったん保留になったが、勉強は続けたいと話した。", quote: "異動は保留になった。でも勉強はやめたくない" },
  { day: "2026-10-17", conv: 22, keywords: ["一人の時間", "夕飯"], summary: "人混みは疲れるが、誰かと夕飯を食べたい気分だと話した。", quote: "人混みは疲れるけど、誰かとご飯は食べたい" },
  { day: "2026-10-18", conv: 23, keywords: ["母", "実家"], summary: "年末に実家へ帰るかどうか迷っていると話した。", quote: "年末、実家に帰ろうか迷ってる" },
  { day: "2026-10-22", conv: 24, keywords: ["ランニング", "寒さ"], summary: "寒くなってきて最近走れていないと話した。", quote: "寒くなって、最近ぜんぜん走ってない" },
];

export function fictionalSynthesisMemories(): MemoryObject[] {
  return ROWS.map((r, i) => {
    const at = `${r.day}T12:00:00.000Z`;
    const id = `syn-mem-${String(i + 1).padStart(2, "0")}`;
    return {
      id,
      date: at,
      statedAt: at,
      types: ["conversation"],
      conversationId: `syn-conv-${String(r.conv).padStart(2, "0")}`,
      content: r.summary,
      summary: r.summary,
      keywords: r.keywords,
      themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [],
      links: [],
      evidenceQuotes: [r.quote],
      ...(r.eventTime ? { eventTime: r.eventTime, eventTimePrecision: r.eventTimePrecision } : {}),
      createdAt: at,
      updatedAt: at,
      metadata: { id: `meta-${id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
    } as unknown as MemoryObject;
  });
}

/**
 * User turns for the comparison, with simple code checks for each reply:
 *   mustNotAsk    - asking this again means the latest record was ignored (it already has the answer)
 *   concreteTerms - words of what the user actually said on this theme (a reply that uses some is concrete, not generic)
 *   pastTerms     - for the unrelated turn only: any of these means a past Memory was brought into a turn it has nothing to do with
 * The last scenario is unrelated on purpose.
 */
export interface SynthesisEvalScenario { id: string; label: string; userText: string; mustNotAsk: string[]; concreteTerms: string[]; pastTerms?: string[] }

export const SYNTHESIS_EVAL_SCENARIOS: SynthesisEvalScenario[] = [
  { id: "work", label: "仕事の迷い", userText: "最近また仕事のことで考えちゃって。今の会社、このままでいいのかな", mustNotAsk: ["面談はどう", "面談、どう", "面談の結果", "面談を受けて", "異動の面談はいかが"], concreteTerms: ["保留", "異動", "デザイン", "勉強", "転職", "企画", "安定"] },
  { id: "running", label: "走る気が起きない", userText: "週末走ろうかと思ってたけど、なんか気が乗らないんだよね", mustNotAsk: ["大会はどう", "大会、どう", "大会の結果"], concreteTerms: ["寒", "大会", "完走", "10キロ", "10km", "すっきり", "もやもや", "川沿い"] },
  { id: "alone", label: "一人と誰か", userText: "今日は一人でいたい気分なんだけど、夜になると寂しくなるんだよね", mustNotAsk: [], concreteTerms: ["人混み", "夕飯", "ご飯", "キャンプ", "一人暮らし", "忙しい", "人に会"] },
  { id: "mother", label: "実家", userText: "年末どうしようかなあ。実家、帰ったほうがいいのかな", mustNotAsk: [], concreteTerms: ["お母", "母", "通院", "病院", "電話", "ひざ", "安心"] },
  { id: "unrelated", label: "関係のない話題", userText: "今日は天気よくて、洗濯物がよく乾いた", mustNotAsk: [], concreteTerms: [], pastTerms: ["仕事", "走", "お母", "実家", "異動", "一人", "会社", "大会"] },
];

/** words that put a psychological label / motive on the user (checked in every reply) */
export const REPLY_LABEL_TERMS = ["心を守", "自分を守", "欲求", "求めている", "求めてしまう", "深層", "無意識", "本当は", "防衛", "逃避", "依存", "承認", "性格"];
