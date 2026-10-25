/**
 * Fictional long-term Memories of three people (April–October 2026), for the Memory Timeline / Synthesis unit tests.
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

function toMemories(rows: Row[], prefix: string): MemoryObject[] {
  return rows.map((r, i) => {
    const at = `${r.day}T12:00:00.000Z`;
    const id = `${prefix}-mem-${String(i + 1).padStart(2, "0")}`;
    return {
      id,
      date: at,
      statedAt: at,
      types: ["conversation"],
      conversationId: `${prefix}-conv-${String(r.conv).padStart(2, "0")}`,
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

/** user A (work / running / time alone vs. with others / mother) */
export function fictionalSynthesisMemories(): MemoryObject[] {
  return toMemories(ROWS, "syn");
}

/** user B: a parent working shorter hours. Career goal changes, a monthly pottery class, mixed feelings about her sister, a trip planned -> cancelled -> rebooked,
 *  and a memory of an old setback told only recently (it must not be read as her present situation). */
const ROWS_B: Row[] = [
  { day: "2026-04-05", conv: 1, keywords: ["仕事", "管理職"], summary: "来年は管理職の試験を受けたいと話した。", quote: "来年こそ管理職の試験受けたい" },
  { day: "2026-04-12", conv: 2, keywords: ["陶芸"], summary: "月に一度の陶芸教室で湯のみを作ったと話した。", quote: "陶芸教室で湯のみ作った" },
  { day: "2026-04-20", conv: 3, keywords: ["姉"], summary: "姉に子どものことを相談して助かったと話した。", quote: "姉に相談したら助かった" },
  { day: "2026-05-03", conv: 4, keywords: ["旅行", "沖縄"], summary: "夏休みの家族の沖縄旅行を予約したと話した。", quote: "8月に沖縄、予約した！", eventTime: "2026-08", eventTimePrecision: "month" },
  { day: "2026-05-17", conv: 5, keywords: ["陶芸"], summary: "陶芸教室でろくろが少し上達したと話した。", quote: "ろくろ、ちょっとうまくなった" },
  { day: "2026-05-30", conv: 6, keywords: ["仕事", "子育て"], summary: "子どもの送り迎えで残業ができず、仕事との両立が大変だと話した。", quote: "お迎えがあるから残業できなくて、両立きつい" },
  { day: "2026-06-01", conv: 7, keywords: ["ドラマ"], summary: "話題の医療ドラマを一気に見たと話した。", quote: "あのドラマ一気見しちゃった" },
  { day: "2026-06-14", conv: 8, keywords: ["姉"], summary: "姉に子育てのことを口出しされて、少しいらっとしたと話した。", quote: "姉にまた口出しされて、ちょっといらっとした" },
  { day: "2026-06-21", conv: 9, keywords: ["陶芸", "作品展"], summary: "陶芸教室の作品展に出す皿を作り始めたと話した。", quote: "作品展用のお皿、作り始めた" },
  { day: "2026-07-05", conv: 10, keywords: ["仕事", "時短勤務"], summary: "管理職試験は見送り、時短勤務に切り替えることを考えていると話した。", quote: "試験は見送って、時短にしようかなって" },
  { day: "2026-08-02", conv: 11, keywords: ["旅行", "沖縄", "台風"], summary: "台風で家族の沖縄旅行が中止になったと話した。", quote: "台風で沖縄、中止になっちゃった", eventTime: "2026-08-01", eventTimePrecision: "day" },
  { day: "2026-08-09", conv: 12, keywords: ["陶芸", "作品展"], summary: "陶芸の作品展に皿を出したと話した。", quote: "作品展にお皿出した！", eventTime: "2026-08-08", eventTimePrecision: "day" },
  { day: "2026-08-23", conv: 13, keywords: ["姉"], summary: "姉が子どもを一日預かってくれて、ありがたかったと話した。", quote: "姉が一日預かってくれて、ほんと助かった" },
  { day: "2026-09-06", conv: 14, keywords: ["仕事", "時短勤務"], summary: "9月から時短勤務になったと話した。", quote: "9月から時短になった", eventTime: "2026-09", eventTimePrecision: "month" },
  { day: "2026-10-04", conv: 15, keywords: ["旅行", "沖縄"], summary: "沖縄旅行は来年の春に行き直すことにしたと話した。", quote: "沖縄は来年の春にリベンジする", eventTime: "2027-03", eventTimePrecision: "month" },
  { day: "2026-10-11", conv: 16, keywords: ["仕事", "管理職"], summary: "新卒の頃に管理職候補から外されて悔しかったことを話した。", quote: "新卒のとき、候補から外されてすごく悔しかった", eventTime: "2019", eventTimePrecision: "year" },
  { day: "2026-10-18", conv: 17, keywords: ["姉"], summary: "姉とは距離をとりたい時もあるが、頼りにもしていると話した。", quote: "姉とは距離置きたいときもあるけど、頼ってもいる" },
  { day: "2026-10-20", conv: 18, keywords: ["陶芸"], summary: "最近忙しくて陶芸教室を2回休んだと話した。", quote: "忙しくて陶芸2回休んじゃった" },
];

/** user C: a man who moved, waited for a car repair, keeps restarting English study, and is unsure about an old friend. The car is pure facts
 *  (nothing to interpret: Synthesis may well be empty there, but the timeline alone tells that the repair is done). */
const ROWS_C: Row[] = [
  { day: "2026-05-02", conv: 1, keywords: ["引っ越し"], summary: "職場に近い部屋への引っ越しを考え始めたと話した。", quote: "職場の近くに引っ越そうかな" },
  { day: "2026-05-09", conv: 2, keywords: ["英語"], summary: "毎朝15分、英語のアプリで勉強していると話した。", quote: "毎朝15分、英語アプリやってる" },
  { day: "2026-05-23", conv: 3, keywords: ["友人", "拓也"], summary: "学生時代の友人の拓也からの連絡が減って寂しいと話した。", quote: "拓也から最近連絡なくて、ちょっと寂しい" },
  { day: "2026-06-06", conv: 4, keywords: ["引っ越し", "内見"], summary: "週末に部屋を2件内見したと話した。", quote: "週末に2件内見してきた" },
  { day: "2026-06-20", conv: 5, keywords: ["英語"], summary: "英語アプリが50日連続になったと話した。", quote: "英語アプリ、50日連続！" },
  { day: "2026-07-04", conv: 6, keywords: ["引っ越し", "契約"], summary: "駅に近い部屋を契約したと話した。", quote: "駅近の部屋、契約した" },
  { day: "2026-07-11", conv: 7, keywords: ["車", "点検"], summary: "車から異音がして、点検を予約したと話した。", quote: "車から変な音がして、点検予約した" },
  { day: "2026-07-18", conv: 8, keywords: ["友人", "拓也"], summary: "拓也に自分から連絡するのは負担に感じると話した。", quote: "自分から拓也に連絡するの、なんか重い" },
  { day: "2026-07-25", conv: 9, keywords: ["車", "修理"], summary: "点検で部品交換が必要と言われ、部品待ちだと話した。", quote: "部品交換が必要で、部品待ち" },
  { day: "2026-08-01", conv: 10, keywords: ["引っ越し", "通勤"], summary: "引っ越しが終わり、通勤が20分になったと話した。", quote: "引っ越し終わった。通勤20分！", eventTime: "2026-07-27", eventTimePrecision: "day" },
  { day: "2026-08-08", conv: 11, keywords: ["英語", "引っ越し"], summary: "引っ越しの忙しさで英語の習慣が途切れたと話した。", quote: "引っ越しバタバタで英語止まっちゃった" },
  { day: "2026-08-22", conv: 12, keywords: ["車", "修理"], summary: "部品が届かず、車の修理がまだ終わらないと話した。", quote: "部品まだ来なくて、修理終わらない" },
  { day: "2026-09-05", conv: 13, keywords: ["英語"], summary: "英語の勉強を朝から夜に変えて再開したと話した。", quote: "英語、夜にやることにして再開した" },
  { day: "2026-09-12", conv: 14, keywords: ["引っ越し", "近所"], summary: "新しい家の近所のパン屋が気に入ったと話した。", quote: "近所のパン屋が当たりだった" },
  { day: "2026-09-19", conv: 15, keywords: ["車", "修理"], summary: "車の修理が終わって戻ってきたと話した。", quote: "やっと車戻ってきた", eventTime: "2026-09-18", eventTimePrecision: "day" },
  { day: "2026-09-26", conv: 16, keywords: ["友人", "拓也"], summary: "拓也と久しぶりに飲みに行って楽しかったと話した。", quote: "拓也と久々に飲んだ、楽しかった" },
  { day: "2026-10-10", conv: 17, keywords: ["映画"], summary: "一人で映画館に行ったと話した。", quote: "一人で映画行ってきた" },
  { day: "2026-10-17", conv: 18, keywords: ["英語", "オンライン英会話"], summary: "オンライン英会話の体験レッスンを受けたと話した。", quote: "オンライン英会話、体験してみた" },
  { day: "2026-10-21", conv: 19, keywords: ["友人", "拓也"], summary: "拓也をまた誘いたいが、断られるのが少し怖いと話した。", quote: "また誘いたいけど、断られたらって思うとちょっと怖い" },
];

/** the three fictional users (memories only), for unit tests */
export const FICTIONAL_USERS: { id: "A" | "B" | "C"; memories: () => MemoryObject[] }[] = [
  { id: "A", memories: fictionalSynthesisMemories },
  { id: "B", memories: () => toMemories(ROWS_B, "synb") },
  { id: "C", memories: () => toMemories(ROWS_C, "sync") },
];
