import { test } from "node:test";
import assert from "node:assert/strict";
import { endsWithInterruptedReply, isBlankAiReply, isSupersededTurn, newestInterruptedConversation, retryableTurns, turnsForAi } from "./aiReplyOutcome";
import { conversationToMarkdown, parseConversationMarkdown } from "./markdown";
import type { Conversation, ConversationTurn } from "./types";

const user = (content: string, timestamp: string): ConversationTurn => ({ role: "user", content, timestamp });
const ai = (content: string, timestamp: string): ConversationTurn => ({ role: "ai", content, timestamp });
const cut = (content: string, timestamp: string): ConversationTurn => ({ role: "ai", content, timestamp, interrupted: true });
const T = "2026-10-01T00:00:00.000Z";
const at = (n: number) => new Date(Date.parse(T) + n * 1000).toISOString();
const conversation = (turns: ConversationTurn[], over: Partial<Conversation> = {}): Conversation => ({
  id: "fictional-conversation", persona: "analyst", entryType: "conversation", startedAt: T, turns, status: "active", memoryObjectIds: [], createdAt: T, updatedAt: T,
  metadata: { id: "fictional-meta", schemaVersion: "0.1", source: "ai-capture", sourceType: "chat", createdAt: T, updatedAt: T }, ...over,
} as Conversation);

test("a reply with no words is blank; any word makes it a reply", () => {
  for (const blank of ["", " ", "\n", " \n\t ", "　"]) assert.equal(isBlankAiReply(blank), true, JSON.stringify(blank));
  for (const words of ["あ", " 架空の返答 ", "\n架空\n", "."]) assert.equal(isBlankAiReply(words), false, JSON.stringify(words));
});

test("the last message waiting for a reply can be tried again, as it is", () => {
  const turns = [user("架空の発言", at(1))];
  assert.deepEqual(retryableTurns(turns), turns);
  const blankInHistory = [user("架空の前の発言", at(1)), ai("", at(2)), user("架空の発言", at(3))];
  assert.deepEqual(retryableTurns(blankInHistory), blankInHistory);
});

test("after a cut reply, the AI is asked about the message and not shown the cut words; the turns themselves are not changed", () => {
  const turns = [user("架空の発言", at(1)), cut("架空の途中まで", at(2))];
  const copy = structuredClone(turns);
  assert.deepEqual(retryableTurns(turns), [turns[0]]);
  assert.deepEqual(turns, copy);
  assert.deepEqual(retryableTurns([...turns, cut("架空のもう一つの途中まで", at(3))]), [turns[0]]);
});

test("nothing to try again: no turns, or a finished reply last", () => {
  assert.equal(retryableTurns([]), null);
  assert.equal(retryableTurns([user("架空", at(1)), ai("架空の返答", at(2))]), null);
  assert.equal(retryableTurns([user("架空", at(1)), cut("架空", at(2)), ai("架空の返答", at(3))]), null);
  assert.equal(retryableTurns([cut("架空の返答", at(2))]), null);
});

test("a cut reply that was tried again is not given to the AI; one the user simply went on from is", () => {
  const superseded = [user("架空", at(1)), cut("途中", at(2)), ai("完了", at(3)), user("次", at(4))];
  assert.equal(isSupersededTurn(superseded, 1), true);
  assert.equal(isSupersededTurn(superseded, 2), false);
  assert.deepEqual(turnsForAi(superseded).map((t) => t.content), ["架空", "完了", "次"]);
  const wentOn = [user("架空", at(1)), cut("途中", at(2)), user("次", at(3))];
  assert.equal(isSupersededTurn(wentOn, 1), false);
  assert.deepEqual(turnsForAi(wentOn), wentOn);
  const twice = [user("架空", at(1)), cut("途中1", at(2)), cut("途中2", at(3))];
  assert.deepEqual(turnsForAi(twice).map((t) => t.content), ["架空", "途中2"]);
  // a blank AI turn from before this change is not touched
  const blank = [user("架空", at(1)), ai("", at(2)), ai("完了", at(3))];
  assert.deepEqual(turnsForAi(blank), blank);
});

test("only an open conversation ending in a cut reply is offered, the newest first", () => {
  const open = conversation([user("架空", at(1)), cut("途中", at(2))], { id: "a", updatedAt: at(10) });
  const newer = conversation([user("架空", at(1)), cut("途中", at(2))], { id: "b", updatedAt: at(20) });
  assert.equal(endsWithInterruptedReply(open), true);
  assert.equal(endsWithInterruptedReply({ ...open, status: "captured" }), false);
  assert.equal(endsWithInterruptedReply({ ...open, endedAt: at(11) }), false);
  assert.equal(endsWithInterruptedReply(conversation([user("架空", at(1))])), false);
  assert.equal(endsWithInterruptedReply(conversation([user("架空", at(1)), cut("途中", at(2)), ai("完了", at(3))])), false);
  assert.equal(endsWithInterruptedReply(conversation([])), false);
  assert.equal(newestInterruptedConversation([open, newer, conversation([user("架空", at(1))])])?.id, "b");
  assert.equal(newestInterruptedConversation([]), null);
});

test("Markdown: the mark goes through the file and back; the transcript and a conversation without a mark are as before", () => {
  const plain = conversation([user("架空", at(1)), ai("架空の返答", at(2))]);
  assert.ok(!conversationToMarkdown(plain).includes("interruptedTurns"));
  const roundPlain = parseConversationMarkdown(conversationToMarkdown(plain))!;
  assert.ok(roundPlain.turns.every((t) => !("interrupted" in t)));

  const marked = conversation([user("架空", at(1)), cut("途中", at(2)), cut("途中2", at(3)), ai("完了", at(4))]);
  const text = conversationToMarkdown(marked);
  assert.ok(text.includes("interruptedTurns:"));
  assert.ok(text.includes("**Tsumugi:** 途中\n\n**Tsumugi:** 途中2\n\n**Tsumugi:** 完了"), "the transcript itself has no new format");
  const round = parseConversationMarkdown(text)!;
  assert.deepEqual(round.turns.map((t) => [t.role, t.content, t.interrupted === true]), [["user", "架空", false], ["ai", "途中", true], ["ai", "途中2", true], ["ai", "完了", false]]);
  assert.equal(conversationToMarkdown(round), text, "writing it back changes nothing");

  // a broken mark is no mark, and the conversation still reads
  const broken = parseConversationMarkdown(text.replace(/interruptedTurns: .*/, 'interruptedTurns: "not json"'))!;
  assert.equal(broken.turns.length, 4);
  assert.ok(broken.turns.every((t) => !t.interrupted));
});
