// diag only (never merged): the nameless candidates before (main c1d30a9) and after P1-E, on fictional data
import { explainPersonContext } from "./personContext";
import { explainPersonContext as oldExplain } from "./personContextOld";
import type { Link, MemoryObject, PersonMention } from "./types";

const at = (day: string) => `${day}T10:00:00.000Z`;
function mention(name: string, quote: string, day: string): PersonMention {
  return { id: `pm-${name}-${day}-${quote.length}`, groupingKey: name, displayName: name, assertion: "mention", stated: "explicit", quote, statedAt: at(day), sourceConversationId: "c", recordedAt: at(day), origin: "ai-extracted", schemaVersion: 1 };
}
function mem(id: string, day: string, summary: string, extra: Partial<MemoryObject> = {}): MemoryObject {
  return { id, date: at(day), statedAt: at(day), types: ["event"], conversationId: `conv-${id}`, content: summary, summary, keywords: [], themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [],
    metadata: { id: `meta-${id}`, schemaVersion: "1", source: "ai-capture", createdAt: at(day), updatedAt: at(day) }, createdAt: at(day), updatedAt: at(day), ...extra } as MemoryObject;
}
function connect(ms: MemoryObject[], from: string, to: string, reason: string, axis: Link["axis"] = "person", strength = 0.9): MemoryObject[] {
  const link: Link = { id: `link-${from}-${to}`, sourceId: from, targetId: to, axis, reason, contrast: false, strength, createdBy: "ai-inference", createdAt: at("2026-10-01") };
  return ms.map((m) => (m.id === from || m.id === to ? { ...m, links: [...m.links, link] } : m));
}
let world: MemoryObject[] = [
  mem("p1", "2026-09-01", "みおさんとランチの話。", { personMentions: [mention("みおさん", "みおさんとは最近ランチによく行く", "2026-09-01")], evidenceQuotes: ["みおさんとは最近ランチによく行く。"] }),
  mem("p2", "2026-09-03", "みおさんの料理の話。", { personMentions: [mention("みおさん", "みおさんは料理が上手だと思う", "2026-09-03")], evidenceQuotes: ["みおさんは料理が上手だと思う。"] }),
  mem("p3", "2026-09-05", "みおさんと企画の話。", { personMentions: [mention("みおさん", "みおさんとの企画はもっと良くできると思う", "2026-09-05")], evidenceQuotes: ["みおさんとの企画はもっと良くできると思う。"] }),
  mem("r1", "2026-09-10", "レストラン巡りの話。AIからみおさんと行きたいか聞かれた。", { evidenceQuotes: ["レストラン巡りをしてみたい。", "最近レストランの料理っていいなと思うことがある。"] }),
  mem("r2", "2026-09-12", "企画の進め方の話。", { evidenceQuotes: ["企画の進め方は見直すべきだ。"] }),
];
world = connect(world, "r1", "p1", "レストランに行きたい気持ちは、みおさんと一緒に行きたいという願いなのかもしれません。");
world = connect(world, "r2", "p3", "企画の進め方についての考えがつながっているようです。", "theme", 0.6);
const show = (label: string, f: typeof explainPersonContext) => {
  const { context, trace } = f(world, "みお", {});
  console.log(`=== P1E ${label} ===`);
  for (const c of trace.candidates) console.log(`${c.accepted ? "○" : "×"} ${c.memoryId} ${c.text}（根拠：${c.signals.join("・") || "なし"}。${c.why}）`);
  for (const c of trace.candidates) for (const l of (c as { links?: { fromId: string; toId: string; axis: string; strength: number; used: boolean; why: string; reason: string }[] }).links ?? [])
    console.log(`   Connect ${l.used ? "使った" : "使わない"} ${l.fromId}→${l.toId} 軸:${l.axis} 強さ:${l.strength}（${l.why}） AIの理由:${l.reason}`);
  console.log(`  to chat: candidates=${JSON.stringify(context.candidates.map((c) => c.text))} conclusions(candidate)=${JSON.stringify(context.conclusions.filter((c) => c.statement.kind === "candidate").map((c) => c.statement.text))}`);
};
show("before", oldExplain as unknown as typeof explainPersonContext);
show("after", explainPersonContext);
process.exit(1);
