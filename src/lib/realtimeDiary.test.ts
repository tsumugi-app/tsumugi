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

test("an open diary is not taken by the automatic Memory run, nor counted as waiting; a finished one and normal conversations are as before", () => {
  const now = local(2026, 11, 8, 12, 0).getTime();
  const settings = { enabled: true, allowOtherProviders: false };
  const state = { conversations: {}, recentRuns: [] };
  const open = diary("open", "2026-11-07", morning);
  const finished = diary("finished", "2026-11-07", morning, { endedAt: T(local(2026, 11, 7, 22, 0)) });
  const normal = diary("normal", undefined, morning);
  assert.equal(isUnprocessedConversation(open), false);
  assert.equal(isUnprocessedConversation(finished), true);
  assert.equal(isUnprocessedConversation(normal), true);
  assert.deepEqual(selectAutoCaptureTargets([open, finished, normal], new Set(), state, settings, now, "gemini").map((c) => c.id).sort(), ["finished", "normal"]);
  assert.equal(summarizeAutoCapture([open], new Set(), state, settings, "gemini").waiting, 0);
});
