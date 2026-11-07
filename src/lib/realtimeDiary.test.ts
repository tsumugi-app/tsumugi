// Realtime diary (PR-A): the diary day, which diary "今日の続きを書く" opens, the time labels, the Markdown round trip, and that an open diary is never
// taken by the automatic Memory run. Dates are built from local clock fields, so the tests hold in any time zone. Every word is fictional.
import test from "node:test";
import assert from "node:assert/strict";
import { diaryDateOf, diaryTimeLabelAt, formatDiaryTime, isDiaryDate, isOpenRealtimeDiary, resumableRealtimeDiary } from "./realtimeDiary";
import { conversationToMarkdown, parseConversationMarkdown } from "./markdown";
import { isUnprocessedConversation, selectAutoCaptureTargets, summarizeAutoCapture } from "./autoCapturePolicy";
import type { Conversation, ConversationTurn } from "./types";

const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);

test("the diary day changes at 4:00 local time, not at midnight", () => {
  assert.equal(diaryDateOf(local(2026, 11, 7, 9, 30)), "2026-11-07");
  assert.equal(diaryDateOf(local(2026, 11, 7, 14, 20)), "2026-11-07");
  assert.equal(diaryDateOf(local(2026, 11, 8, 1, 0)), "2026-11-07");
  assert.equal(diaryDateOf(local(2026, 11, 8, 3, 59)), "2026-11-07");
  assert.equal(diaryDateOf(local(2026, 11, 8, 4, 0)), "2026-11-08");
  assert.equal(diaryDateOf(local(2026, 11, 8, 0, 0)), "2026-11-07");
  // across a month and a year
  assert.equal(diaryDateOf(local(2026, 12, 1, 2, 0)), "2026-11-30");
  assert.equal(diaryDateOf(local(2027, 1, 1, 3, 0)), "2026-12-31");
  assert.equal(diaryDateOf(local(2028, 3, 1, 1, 0)), "2028-02-29");
});

test("a diary date is a real calendar day", () => {
  for (const ok of ["2026-11-07", "2028-02-29"]) assert.equal(isDiaryDate(ok), true, ok);
  for (const bad of ["2026-02-30", "2026-13-01", "2026-11-7", "", "2026-11-07T00:00:00Z", 20261107, undefined]) assert.equal(isDiaryDate(bad), false, String(bad));
});

const T = (d: Date) => d.toISOString();
const turn = (role: "user" | "ai", at: Date, content = role === "user" ? "架空の出来事です" : "架空の返答です。"): ConversationTurn => ({ role, content, timestamp: T(at) });
function diary(id: string, date: string | undefined, turns: ConversationTurn[], extra: Partial<Conversation> = {}): Conversation {
  const at = turns[0]?.timestamp ?? T(local(2026, 11, 7, 9, 30));
  return { id, persona: "companion", entryType: "diary", startedAt: at, turns, status: "active", chatProviders: ["gemini"], memoryObjectIds: [], createdAt: at, updatedAt: turns[turns.length - 1]?.timestamp ?? at,
    ...(date ? { realtimeDiary: { date } } : {}), metadata: { id: `meta-${id}`, schemaVersion: "0.1", source: "ai-capture", createdAt: at, updatedAt: at }, ...extra };
}
const morning = [turn("user", local(2026, 11, 7, 9, 30)), turn("ai", local(2026, 11, 7, 9, 31))];

test("今日の続きを書く opens the open diary of that day only", () => {
  const today = diary("today", "2026-11-07", morning);
  const yesterday = diary("yesterday", "2026-11-06", morning);
  const ended = diary("ended", "2026-11-07", morning, { endedAt: T(local(2026, 11, 7, 22, 0)) });
  const normal = diary("normal", undefined, morning);
  const empty = diary("empty", "2026-11-07", []);
  assert.equal(resumableRealtimeDiary([yesterday, ended, normal, empty, today], "2026-11-07")?.id, "today");
  assert.equal(resumableRealtimeDiary([yesterday, ended, normal, empty], "2026-11-07"), undefined, "a finished diary, another day, a normal diary or an empty one start a new diary");
  const later = diary("later", "2026-11-07", [...morning, turn("user", local(2026, 11, 7, 14, 20))]);
  assert.equal(resumableRealtimeDiary([today, later], "2026-11-07")?.id, "later", "two open diaries of one day (two devices): the one written last");
  assert.equal(resumableRealtimeDiary([diary("captured", "2026-11-07", morning, { status: "captured" })], "2026-11-07"), undefined);
  assert.equal(isOpenRealtimeDiary(today), true);
  assert.equal(isOpenRealtimeDiary(ended), false);
  assert.equal(isOpenRealtimeDiary(normal), false);
});

test("time labels: the first words and words after a pause only, never on a reply; the stored time is shown as it is", () => {
  const turns = [
    turn("user", local(2026, 11, 7, 9, 30)), turn("ai", local(2026, 11, 7, 9, 31)),
    turn("user", local(2026, 11, 7, 9, 40)), turn("ai", local(2026, 11, 7, 9, 41)),
    turn("user", local(2026, 11, 7, 14, 20)), turn("ai", local(2026, 11, 7, 14, 21)),
    turn("user", local(2026, 11, 7, 21, 0)), turn("ai", local(2026, 11, 7, 21, 1)),
    turn("user", local(2026, 11, 8, 1, 5)),
  ];
  const labels = turns.map((_, i) => diaryTimeLabelAt(turns, i, "2026-11-07"));
  assert.deepEqual(labels, ["9:30", null, null, null, "14:20", null, "21:00", null, "11/8 1:05"]);
  assert.equal(diaryTimeLabelAt([{ role: "user", content: "架空", timestamp: "" }], 0, "2026-11-07"), null);
  assert.equal(formatDiaryTime(local(2026, 11, 7, 7, 5), "2026-11-07"), "7:05");
});

test("Markdown keeps the diary day apart from the times of the words, and a normal conversation gains no key", () => {
  const late = diary("late", "2026-11-07", [turn("user", local(2026, 11, 8, 1, 0)), turn("ai", local(2026, 11, 8, 1, 1))]);
  const md = conversationToMarkdown(late);
  assert.match(md, /^diaryDate: "?2026-11-07"?$/m);
  const back = parseConversationMarkdown(md)!;
  assert.deepEqual(back.realtimeDiary, { date: "2026-11-07" });
  assert.deepEqual(back.turns.map((t) => t.timestamp), late.turns.map((t) => t.timestamp), "the times of the words are not rewritten");
  const normal = conversationToMarkdown(diary("normal", undefined, morning));
  assert.doesNotMatch(normal, /diaryDate/);
  assert.equal("realtimeDiary" in parseConversationMarkdown(normal)!, false);
  assert.equal("realtimeDiary" in parseConversationMarkdown(md.replace(/^diaryDate: .*$/m, "diaryDate: 2026-02-30"))!, false, "an impossible day is not read as a diary");
});

test("no realtime diary is taken by the automatic Memory run (an open one waits for its writer, a finished one for the diary's own finishing, PR-C); normal conversations are as before", () => {
  const now = local(2026, 11, 8, 12, 0).getTime();
  const settings = { enabled: true, allowOtherProviders: false };
  const state = { conversations: {}, recentRuns: [] };
  const open = diary("open", "2026-11-07", morning);
  const finished = diary("finished", "2026-11-07", morning, { endedAt: T(local(2026, 11, 7, 22, 0)) });
  const normal = diary("normal", undefined, morning);
  assert.equal(isUnprocessedConversation(open), false);
  assert.equal(isUnprocessedConversation(finished), false);
  assert.equal(isUnprocessedConversation(normal), true);
  assert.deepEqual(selectAutoCaptureTargets([open, finished, normal], new Set(), state, settings, now, "gemini").map((c) => c.id).sort(), ["normal"]);
  assert.equal(summarizeAutoCapture([open, finished], new Set(), state, settings, "gemini").waiting, 0);
});

// ---------------------------------------------------------------------------
// PR-B: the diary text, finishing, and keeping it
// ---------------------------------------------------------------------------
import { escapeDiaryText, isRealtimeDiaryComplete, unescapeDiaryText, unfinishedRealtimeDiaries } from "./realtimeDiary";
import { takesBackFinishedConversation } from "./vaultRewriteSafety";
import { conversationLogicalDay, indexEntryHasConversationOnDay } from "./historyConversationCard";

const ENDED = T(local(2026, 11, 7, 22, 0));

test("the diary text is kept in Markdown before the transcript and read back exactly; the words are read as before", () => {
  const text = "朝は架空の公園を歩いた。\n\n## Transcript\n#見出しのような行\n\\円記号で始まる行\n夜は架空の本を読んだ。";
  assert.equal(unescapeDiaryText(escapeDiaryText(text)), text);
  const c = diary("written", "2026-11-07", morning, { endedAt: ENDED, status: "captured", realtimeDiary: { date: "2026-11-07", text, writtenAt: ENDED, aiProvider: "openai" } });
  const md = conversationToMarkdown(c);
  assert.ok(md.indexOf("## Diary\n\n") < md.indexOf("## Transcript\n\n"));
  assert.match(md, /^diaryWrittenAt: /m);
  assert.doesNotMatch(md, /openai/, "which AI wrote it stays on the device");
  const back = parseConversationMarkdown(md)!;
  assert.deepEqual(back.realtimeDiary, { date: "2026-11-07", text, writtenAt: ENDED });
  assert.deepEqual(back.turns.map((t) => t.content), c.turns.map((t) => t.content), "the text is never read as words of the conversation");
  // a diary not yet written, and words that look like the section, are not read as a diary text
  const tricky = diary("tricky", "2026-11-07", [turn("user", local(2026, 11, 7, 9, 30), "## Diary\n\n架空の文"), turn("ai", local(2026, 11, 7, 9, 31))]);
  assert.deepEqual(parseConversationMarkdown(conversationToMarkdown(tricky))!.realtimeDiary, { date: "2026-11-07" });
});

test("a diary is complete only with both its Memory and its text; any other finished diary can be finished again from home", () => {
  const both = diary("both", "2026-11-07", morning, { endedAt: ENDED, status: "captured", realtimeDiary: { date: "2026-11-07", text: "架空の日記。" } });
  const noText = diary("no-text", "2026-11-06", morning, { endedAt: ENDED, status: "captured", updatedAt: T(local(2026, 11, 7, 23, 0)) });
  const noMemory = diary("no-memory", "2026-11-05", morning, { endedAt: ENDED, realtimeDiary: { date: "2026-11-05", text: "架空の日記。" }, updatedAt: T(local(2026, 11, 7, 22, 30)) });
  const open = diary("open", "2026-11-07", morning);
  assert.equal(isRealtimeDiaryComplete(both), true);
  assert.equal(isRealtimeDiaryComplete(noText), false);
  assert.equal(isRealtimeDiaryComplete(noMemory), false);
  assert.deepEqual(unfinishedRealtimeDiaries([both, noText, noMemory, open, diary("normal", undefined, morning, { endedAt: ENDED })]).map((c) => c.id), ["no-text", "no-memory"]);
});

test("a save without the diary text never replaces a file that has it (another device or tab wrote it)", () => {
  const withText = { status: "captured" as const, memoryObjectIds: ["m"], realtimeDiary: { date: "2026-11-07", text: "架空の日記。" } };
  assert.equal(takesBackFinishedConversation(withText, { status: "captured", memoryObjectIds: ["m"], realtimeDiary: { date: "2026-11-07" } }), true);
  assert.equal(takesBackFinishedConversation(withText, withText), false);
  assert.equal(takesBackFinishedConversation({ status: "active", memoryObjectIds: [], realtimeDiary: { date: "2026-11-07" } }, withText), false);
  assert.equal(takesBackFinishedConversation({ status: "active", memoryObjectIds: [] }, { status: "active", memoryObjectIds: [] }), false, "a normal conversation is as before");
});

test("History puts a realtime diary on its diary day, whatever time it started; other conversations as before", () => {
  // started 8 Nov 1:00 JST (16:00 UTC on 7 Nov) for the diary of 7 Nov
  assert.equal(conversationLogicalDay("01JZZZZZZZZZZZZZZZZZZZZZZZ", "2026-11-07T16:00:00.000Z", "2026-11-07", "2026-11-07"), "2026-11-07");
  assert.equal(conversationLogicalDay("01JZZZZZZZZZZZZZZZZZZZZZZZ", "2026-11-07T16:00:00.000Z", "2026-11-07"), "2026-11-08");
  assert.equal(conversationLogicalDay("01JZZZZZZZZZZZZZZZZZZZZZZZ", "2026-11-07T16:00:00.000Z", "2026-11-07", "not-a-day"), "2026-11-08");
  const entry = { conversations: [{ id: "01JZZZZZZZZZZZZZZZZZZZZZZZ", mode: "diary" as const, turnCount: 2, diaryDate: "2026-11-06" }], normalMemories: [], reflections: [] };
  assert.equal(indexEntryHasConversationOnDay(entry, "2026-11-07", "2026-11-06"), true);
});

// ---------------------------------------------------------------------------
// PR-C: the 4:00 day change and the diaries waiting to be finished
// ---------------------------------------------------------------------------
import { isOverdueRealtimeDiary, needsDiaryDayChange, previousDiaryDate, realtimeDiariesToFinish } from "./realtimeDiary";

test("the day before a diary day, across a month, a year and a leap day", () => {
  assert.equal(previousDiaryDate("2026-11-08"), "2026-11-07");
  assert.equal(previousDiaryDate("2026-12-01"), "2026-11-30");
  assert.equal(previousDiaryDate("2027-01-01"), "2026-12-31");
  assert.equal(previousDiaryDate("2028-03-01"), "2028-02-29");
});

test("an open diary is overdue from 4:00 of the next day only; a diary dated later than today (the clock moved back) is not", () => {
  const open = diary("open", "2026-12-31", [turn("user", local(2026, 12, 31, 23, 50)), turn("ai", local(2026, 12, 31, 23, 51))]);
  assert.equal(needsDiaryDayChange(open, local(2027, 1, 1, 0, 30)), null, "after midnight, before 4:00: still the same diary");
  assert.equal(needsDiaryDayChange(open, local(2027, 1, 1, 3, 59)), null);
  assert.deepEqual(needsDiaryDayChange(open, local(2027, 1, 1, 4, 0)), { from: "2026-12-31", to: "2027-01-01" });
  assert.equal(isOverdueRealtimeDiary(open, "2027-01-01"), true);
  assert.equal(isOverdueRealtimeDiary(open, "2026-12-31"), false);
  assert.equal(isOverdueRealtimeDiary(open, "2026-12-30"), false, "dated after today: written on, never closed");
  // nothing is offered for an ended diary, an empty one (nothing saved yet) or a normal conversation
  assert.equal(needsDiaryDayChange(diary("ended", "2026-12-31", open.turns, { endedAt: T(local(2026, 12, 31, 23, 55)) }), local(2027, 1, 1, 5, 0)), null);
  assert.equal(needsDiaryDayChange(diary("empty", "2026-12-31", []), local(2027, 1, 1, 5, 0)), null);
  assert.equal(needsDiaryDayChange(diary("normal", undefined, open.turns), local(2027, 1, 1, 5, 0)), null);
  // the end of a month
  const november = diary("nov", "2026-11-30", [turn("user", local(2026, 11, 30, 22, 0))]);
  assert.equal(needsDiaryDayChange(november, local(2026, 12, 1, 3, 0)), null);
  assert.deepEqual(needsDiaryDayChange(november, local(2026, 12, 1, 4, 0)), { from: "2026-11-30", to: "2026-12-01" });
});

test("home lists the diaries waiting to be finished: ended but unfinished, and open ones past 4:00; today's open diary and complete ones are not listed", () => {
  const ENDED_AT = T(local(2026, 11, 7, 22, 0));
  const overdue = diary("overdue", "2026-11-06", [turn("user", local(2026, 11, 6, 21, 0))]);
  const today = diary("today", "2026-11-07", morning);
  const ended = diary("ended", "2026-11-07", morning, { endedAt: ENDED_AT, status: "captured" });
  const done = diary("done", "2026-11-05", morning, { endedAt: ENDED_AT, status: "captured", realtimeDiary: { date: "2026-11-05", text: "架空の日記。" } });
  const archived = diary("archived", "2026-11-04", morning, { status: "archived" });
  assert.deepEqual(realtimeDiariesToFinish([overdue, today, ended, done, archived], "2026-11-07").map((c) => c.id), ["ended", "overdue"]);
  // after 4:00 the next day, today's open diary is waiting too
  assert.deepEqual(realtimeDiariesToFinish([overdue, today], "2026-11-08").map((c) => c.id).sort(), ["overdue", "today"]);
});
