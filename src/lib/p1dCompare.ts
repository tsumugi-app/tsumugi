// diag only (never merged): the person context section before (main 2501ff0) and after P1-D, on fictional data
import { buildPersonContext, explainPersonContext } from "./personContext";
import { buildPersonContextSection, sanitizePersonContext } from "./personContextPrompt";
import { buildPersonContext as oldBuild } from "./personContextOld";
import type { MemoryObject, PersonMention, TopicEvent } from "./types";

const at = (day: string, hour = "10:00") => `${day}T${hour}:00.000Z`;
function mention(name: string, quote: string, statedAt: string): PersonMention {
  return { id: `pm-${name}-${statedAt}-${quote.length}`, groupingKey: name, displayName: name, assertion: "mention", stated: "explicit", quote, statedAt, sourceConversationId: "c", recordedAt: statedAt, origin: "ai-extracted", schemaVersion: 1 };
}
const tq = (topicId: string, quote: string, statedAt: string): TopicEvent => ({ id: `te-${statedAt}-${quote.length}`, topicId, quote, statedAt, sourceConversationId: "c", recordedAt: statedAt, origin: "ai-extracted", schemaVersion: 1 });
function mem(id: string, day: string, summary: string, extra: Partial<MemoryObject> = {}): MemoryObject {
  return { id, date: at(day), statedAt: at(day), types: ["event"], conversationId: `conv-${id}`, content: summary, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    metadata: { id: `meta-${id}`, schemaVersion: "1", source: "ai-capture", createdAt: at(day), updatedAt: at(day) }, createdAt: at(day), updatedAt: at(day), ...extra } as MemoryObject;
}
const world: MemoryObject[] = [
  mem("c1", "2026-09-01", "みおさんとの関係と、取引先への提出について話した。", { topicId: "topic-work",
    personMentions: [mention("みおさん", "みおさんとは最近ぎくしゃくしている気がする", at("2026-09-01"))],
    evidenceQuotes: ["みおさんとは最近ぎくしゃくしている気がする。", "急に出せと言われても出せない。", "取引先なので微妙に言いづらい。"] }),
  mem("c2", "2026-09-05", "みおさんへの感謝を話した。", { personMentions: [mention("みおさん", "みおさんには感謝しているので、大切にしたい", at("2026-09-05"))] }),
  mem("c3", "2026-09-10", "みおさんと昼休みに話した。", { personMentions: [mention("みおさん", "みおさんと昼休みに話した", at("2026-09-10"))],
    evidenceQuotes: ["みおさんと昼休みに話した。彼女はいつも周りに気を配っていると思う。"] }),
  mem("c4", "2026-09-12", "みおさんとの企画の打ち合わせと、提出の期限について話した。", { topicId: "topic-work",
    personMentions: [mention("みおさん", "みおさんとの企画の打ち合わせが続く", at("2026-09-12", "09:00"))],
    topicEvents: [tq("topic-work", "企画のやり方はもっと話し合うべきだ。", at("2026-09-12", "09:00")), tq("topic-work", "提出の期限はもう無理だ。", at("2026-09-12", "11:00"))] }),
  mem("c5", "2026-09-14", "みおさんの話。", { personMentions: [mention("みおさん", "みおさんの話", at("2026-09-14"))], evidenceQuotes: ["あの人のやり方は信用できない。"] }),
];
const cut = (s: string) => s.slice(s.indexOf("### "));
console.log("=== P1D before ===");
console.log(cut(buildPersonContextSection(sanitizePersonContext([oldBuild(world, "みお")]))));
console.log("=== P1D after ===");
console.log(cut(buildPersonContextSection(sanitizePersonContext([buildPersonContext(world, "みお")]))));
console.log("=== P1D trace ===");
for (const s of explainPersonContext(world, "みお").trace.statements) console.log(`${s.kept ? "○" : "×"} ${s.text}｜${s.why}${s.basis ? `｜根拠：${s.basis}` : ""}`);
process.exit(1);
