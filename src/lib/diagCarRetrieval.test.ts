/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * DIAGNOSTIC ONLY (diag/ branch, never merged). Fictional Memories. Prints, through a deliberate failure, why a car question gets 0 memories.
 * DIAG=A|B|C picks the keyword variant of the car records; DIAG=T prints the explicit search / timeline / reflective checks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

const ROOT = path.join(__dirname, "..");
type MemoryObject = import("./types").MemoryObject;
let pool: MemoryObject[] = [];
const stubs: Record<string, unknown> = {
  "./db": { getAllMemoryObjects: async () => pool, getAllConversations: async () => [], getMemoryObject: async (id: string) => pool.find((m) => m.id === id) },
  "./vaultWorldLock": { withVaultWorldRead: async <T,>(fn: () => Promise<T>) => fn() },
};
const mod = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown; _resolveFilename: (request: string, ...rest: unknown[]) => string };
const origLoad = mod._load;
mod._load = function (request, parent, isMain) {
  if ((parent?.filename?.startsWith(ROOT) ?? false) && request in stubs) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = mod._resolveFilename;
mod._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request, ...rest);
};
const r = require(path.join(ROOT, "lib/retrieval.js")) as typeof import("./retrieval");
const search = require(path.join(ROOT, "lib/memorySearch.js")) as typeof import("./memorySearch");
const syn = require(path.join(ROOT, "lib/memorySynthesis.js")) as typeof import("./memorySynthesis");

function mem(id: string, conv: string, day: string, summary: string, keywords: string[]): MemoryObject {
  const at = `${day}T12:00:00.000Z`;
  return {
    id, date: at, statedAt: at, types: ["conversation"], conversationId: conv, content: summary, summary, keywords,
    themeIds: [], personIds: [], emotionIds: [], goalIds: [], ideaIds: [], eventIds: [], links: [], createdAt: at, updatedAt: at,
    metadata: { id: `meta-${id}`, source: "ai-capture", schemaVersion: "0.1", createdAt: at, updatedAt: at },
  } as unknown as MemoryObject;
}

const CAR1 = "アウトランダーが気になる";
const CAR2 = "車について話したい。レクサスGX・NX・RX、アウトランダーなどを検討";
const variants: Record<string, [string[], string[], boolean]> = {
  // [car1 keywords, car2 keywords, a third record with the keyword 車]
  A: [["アウトランダー", "車"], ["車", "レクサス", "アウトランダー"], true],
  B: [["アウトランダー", "車"], ["車", "レクサス", "アウトランダー"], false],
  C: [["アウトランダー", "SUV"], ["車選び", "レクサス", "アウトランダー"], false],
};
const seiri = [
  mem("s1", "c-s1", "2026-09-20", "過去のメモを整理して、要らないものを捨てた", ["整理", "メモ"]),
  mem("s2", "c-s2", "2026-10-01", "部屋を整理した。過去の手紙も見返した", ["整理", "部屋"]),
  mem("s3", "c-s3", "2026-10-15", "仕事の書類を整理した", ["整理", "書類"]),
  mem("s4", "c-s4", "2026-11-01", "週末に過去の写真を整理した", ["整理", "写真"]),
];
const others = [
  mem("o1", "c-o1", "2026-10-10", "友人とカフェで話した", ["カフェ", "友人"]),
  mem("o2", "c-o2", "2026-10-20", "仕事が忙しくて疲れた", ["仕事", "多忙"]),
];
function poolFor(v: string): MemoryObject[] {
  const [k1, k2, third] = variants[v];
  return [
    mem("car1", "c-car1", "2026-10-26", CAR1, k1),
    mem("car2", "c-car2", "2026-10-27", CAR2, k2),
    ...(third ? [mem("car3", "c-car3", "2026-09-01", "車で実家に帰った", ["車", "実家"])] : []),
    ...seiri, ...others,
  ];
}
const QS = ["過去にどんな車がいいって言ったっけ？", "アウトランダーって言わなかったっけ？", "どんな車種がいいって言ったっけ？", "前に自動車の話をしたっけ？"];
const f = (n: number) => (Math.round(n * 100) / 100).toString();

async function report(v: string): Promise<string[]> {
  pool = poolFor(v);
  const freq = r.computeKeywordFrequency(pool);
  const lines = [`VARIANT ${v} keywordFreq 車=${freq.get("車") ?? 0} アウトランダー=${freq.get("アウトランダー") ?? 0} floor=${r.CONVERSATION_MIN_SCORE}`];
  for (const q of QS) {
    const anchors = r.deriveConversationTopicAnchors([q], freq);
    const sel = r.selectConversationDirectMatches(pool, q, [q], freq, r.isReflectiveQuery(q) ? r.REFLECTIVE_LIMIT : r.DEFAULT_LIMIT);
    const status = (id: string) => (sel.kept.some((e) => e.memory.id === id) ? "KEPT" : sel.droppedByFloor.some((e) => e.memory.id === id) ? "FLOOR" : sel.droppedByRelativeStrength.some((e) => e.memory.id === id) ? "REL" : "ZERO");
    const scored = r.scoreConversationCandidates(pool, q, anchors, freq);
    const parts = scored.filter((e) => e.memory.id.startsWith("car") || e.conversationScore > 0).map((e) => {
      const hits = e.memory.keywords.filter((k) => q.includes(k));
      const ov = e.queryScore - hits.length * r.KEYWORD_WEIGHT;
      return `${e.memory.id}[kw:${hits.join("+") || "-"} ov:${f(ov)} pen:${f(e.genericPenalty)} anc:${f(e.anchorBonus)} =${f(e.conversationScore)} ${status(e.memory.id)}]`;
    });
    const analyst = (await r.retrieveRelevantMemoriesImpl(q, { persona: "analyst", recentUserTurnsTexts: [q], deferReflections: true, limit: r.isReflectiveQuery(q) ? r.REFLECTIVE_LIMIT : undefined })).map((m) => m.id);
    const companion = (await r.retrieveRelevantMemoriesImpl(q, { persona: "companion", deferReflections: true, limit: r.isReflectiveQuery(q) ? r.REFLECTIVE_LIMIT : undefined })).map((m) => m.id);
    lines.push(`Q「${q}」 reflective=${r.isReflectiveQuery(q)} anchors=${anchors.map((a) => a.keyword).join("+") || "-"} analyst=[${analyst.join(",")}] companion=[${companion.join(",")}]`);
    lines.push(`  ${parts.join(" ")}`);
  }
  return lines;
}

function timelineReport(): string[] {
  pool = poolFor("A");
  const lines: string[] = [];
  lines.push(`themes=${syn.timelineThemes(pool).join(",")}`);
  for (const theme of syn.timelineThemes(pool)) lines.push(`theme ${theme} terms=${syn.themeTerms(theme, pool).join(",")}`);
  for (const q of QS) {
    const ex = search.detectExplicitMemorySearch(q);
    const tl = syn.selectTimelineForTurn(pool, { userText: q, retrievedMemoryIds: [] });
    const hitTerms = syn.timelineThemes(pool).map((t) => `${t}:${syn.themeTerms(t, pool).filter((x) => q.includes(x)).join("+") || "-"}`);
    lines.push(`Q「${q}」 explicitSearch=${ex ? JSON.stringify(ex.terms.map((t) => t.text)) : "none"} timeline=[${tl.map((c) => `${c.theme}(${c.timeline.length})`).join(",")}] termHits=${hitTerms.join(" ")}`);
  }
  return lines;
}

const which = process.env.DIAG ?? "A";
test(`DIAG ${which}`, async () => {
  const lines = which === "T" ? timelineReport() : await report(which);
  assert.fail(`\n${lines.join("\n")}\n`);
});
