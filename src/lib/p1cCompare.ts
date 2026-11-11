// diag only (never merged): the person context section before (main 9d8e0c9) and after P1-C, on fictional data
import { buildPersonContext } from "./personContext";
import { buildPersonContextSection, sanitizePersonContext } from "./personContextPrompt";
import { buildPersonContext as oldBuild } from "./personContextOld";
import { buildPersonContextSection as oldSection, sanitizePersonContext as oldSanitize } from "./personContextPromptOld";
import type { MemoryObject, PersonMention } from "./types";

const at = (day: string) => `${day}T10:00:00.000Z`;
function mention(name: string, quote: string, day: string): PersonMention {
  return { id: `pm-${name}-${day}-${quote.length}`, groupingKey: name, displayName: name, assertion: "mention", stated: "explicit", quote, statedAt: at(day), sourceConversationId: "c", recordedAt: at(day), origin: "ai-extracted", schemaVersion: 1 };
}
function mem(id: string, day: string, summary: string, extra: Partial<MemoryObject> = {}): MemoryObject {
  return { id, date: at(day), statedAt: at(day), types: ["event"], conversationId: `conv-${id}`, content: summary, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    metadata: { id: `meta-${id}`, schemaVersion: "1", source: "ai-capture", createdAt: at(day), updatedAt: at(day) }, createdAt: at(day), updatedAt: at(day), ...extra } as MemoryObject;
}
const sora = (id: string, day: string, words: string, extra: Partial<MemoryObject> = {}) =>
  mem(id, day, extra.summary ?? "そらさんのことを話した。", { personMentions: [mention("そらさん", "そらさんの話", day)], evidenceQuotes: [words], ...extra });

const world: MemoryObject[] = [
  mem("o1", "2026-05-01", "あおいさんと打ち合わせをした。", { personMentions: [mention("あおいさん", "あおいさんとの仕事の関係は順調だ", "2026-05-01")], evidenceQuotes: ["仕事の関係で、今日も打ち合わせをした。"] }),
  sora("s1", "2026-06-05", "そらさんのことは大切にしたい。", { topicId: "topic-sora" }),
  sora("s2", "2026-06-20", "そらさんにとって特別な存在でありたい。"),
  sora("s3", "2026-07-01", "そらさんとの関係に未来はない。", { topicId: "topic-sora" }),
  sora("r1", "2026-10-01", "もう半年だよ。"),
  sora("r2", "2026-10-02", "これでいいのかよくわからない。"),
  sora("r3", "2026-10-03", "前ほどではないが、それでも消えてくれない。"),
  sora("r4", "2026-10-04", "やっぱりつらい。"),
  sora("r5", "2026-10-05", "もう遅い。"),
  sora("r6", "2026-10-06", "今日は雨だった。"),
  sora("r7", "2026-10-07", "そらさんのことを考えると、胸が苦しくなる気がする。"),
  sora("r8", "2026-10-08", "そらさんとは、これからも連絡を取り合うと思う。"),
  sora("x9", "2026-10-10", "そらさんとの関係に未来がないと言ったのは、自分に家庭があるからだ。", { topicId: "topic-sora" }),
  mem("q1", "2026-10-12", "以前のそらさんとの関係についての考えを整理したいと考えている。", { personMentions: [mention("そらさん", "前にそらさんとの未来はないと言った理由を整理してほしい", "2026-10-12")] }),
  mem("p2", "2026-10-15", "そらさんといつか旅行に行きたいと思っている。", { personMentions: [mention("そらさん", "いつかそらさんと旅行に行きたい", "2026-10-15")] }),
  mem("n1", "2026-07-01", "関係の先行きについて話した。", { conversationId: "conv-s3", evidenceQuotes: ["この関係に未来はないと思う。"] }),
  mem("n6", "2026-07-01", "経費精算について話した。", { conversationId: "conv-s3", topicId: "topic-sora", evidenceQuotes: ["経費精算は今月中に出すべきだ。"] }),
];
const which = process.argv[2];
const section = which === "before" ? oldSection(oldSanitize([oldBuild(world, "そら")])) : buildPersonContextSection(sanitizePersonContext([buildPersonContext(world, "そら")]));
console.log(`=== P1C ${which} ===`);
console.log(section.slice(section.indexOf("### ")));
process.exit(1);
