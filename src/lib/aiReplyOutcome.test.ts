import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlankAiReply, retryableTurns } from "./aiReplyOutcome";
import type { ConversationTurn } from "./types";

const user = (content: string, timestamp: string): ConversationTurn => ({ role: "user", content, timestamp });
const ai = (content: string, timestamp: string): ConversationTurn => ({ role: "ai", content, timestamp });

test("a reply with no words is blank; any word makes it a reply", () => {
  for (const blank of ["", " ", "\n", " \n\t ", "　"]) assert.equal(isBlankAiReply(blank), true, JSON.stringify(blank));
  for (const words of ["あ", " 架空の返答 ", "\n架空\n", "."]) assert.equal(isBlankAiReply(words), false, JSON.stringify(words));
});

test("the last message waiting for a reply can be tried again, as it is", () => {
  const turns = [user("架空の発言", "t1")];
  assert.deepEqual(retryableTurns(turns, null), turns);
  const later = [user("架空の前の発言", "t1"), ai("架空の返答", "t2"), user("架空の発言", "t3")];
  assert.deepEqual(retryableTurns(later, null), later);
  // a blank AI turn from before this change is left where it is
  const blankInHistory = [user("架空の前の発言", "t1"), ai("", "t2"), user("架空の発言", "t3")];
  assert.deepEqual(retryableTurns(blankInHistory, null), blankInHistory);
});

test("after a reply cut off on its way, the AI is asked about the message and not shown the cut words; the turns themselves are not changed", () => {
  const turns = [user("架空の発言", "t1"), ai("架空の途中まで", "t2")];
  const copy = structuredClone(turns);
  assert.deepEqual(retryableTurns(turns, "t2"), [turns[0]]);
  assert.deepEqual(turns, copy);
  assert.deepEqual(retryableTurns([...turns, ai("架空のもう一つの途中まで", "t3")], "t3"), [turns[0]]);
});

test("nothing to try again: no turns, a finished reply, or a different reply than the one that was cut", () => {
  assert.equal(retryableTurns([], null), null);
  assert.equal(retryableTurns([], "t1"), null);
  assert.equal(retryableTurns([user("架空", "t1"), ai("架空の返答", "t2")], null), null);
  assert.equal(retryableTurns([user("架空", "t1"), ai("架空の返答", "t2")], "t9"), null);
  assert.equal(retryableTurns([ai("架空の返答", "t2")], "t2"), null);
});
