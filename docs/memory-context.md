# Memory context in conversation (conversation quality, step 1)

Owner decision 2026-11-08. Code: `src/lib/memoryContext.ts`, `retrieveRelevantMemoriesImpl` (`includeContext`) in `src/lib/retrieval.ts`, `buildRetrievedMemoriesSection` in `src/app/api/chat/route.ts`. Tests: `src/lib/memoryContext.test.ts`.

## What the chat AI now receives for a selected Memory
Which Memories are selected does not change. Only the chat screen asks for the extra values (Connect and the debug log do not).

- **話題の人物**: the people the user talked about in that record (`personMentions[].displayName`, as the user called them), at most 2.
- **本人の発言（当時の逐語の抜粋）**: one sentence from the record's `evidenceQuotes`, only when the summary does not already say it (60% or more of its 2-character pieces already in the summary = not sent). Of the remaining sentences, the one closest to the current turn and the user's last 3 turns. At most 3 quotes a turn, in the order of the selection, each cut to 80 characters.
- The full `content` of a Memory is never sent. Nothing is saved; no AI call is added; the Memory and Vault formats are unchanged.
- Two short notes under the list: the quoted words are the user's own and the rest is an AI summary, a record about another person is not about the person now talked about (only when a person or a quote is shown), and a past thought, feeling or judgment, 「今は」「現在」 included, is of the record's day and not to be stated as the user's view now (always).
- The route checks what the client sent: strings only, the same limits.

## The time filter (turn without web search)
- Unchanged: a Memory whose summary or keywords name an outside, changing fact (最新, ラインナップ, 販売中, 発売予定, 開催中, 開催予定, 在庫, 価格, 値段, 営業時間, 営業中, キャンペーン) is kept out.
- Changed: a Memory that only says 現在 / 今の / 今は / 次は / 次回 is kept out only when it is not the user's own view (no thought, feeling or judgment word such as 思う, 感じ, 気持ち, 考え, 不安, 迷い, 決めた, 好き). Before, it was always kept out.
- New: a quote naming an outside, changing fact is not sent (the Memory stays with its summary).
- Turns with web search: nothing is filtered, as before.

## Open points
- The own-view check and the outside-fact check are word lists: a view worded without those words is still kept out when it says 今は, and an outside fact worded like a feeling (「今の価格が高いと感じる」 is still kept out by 価格, but 「今の店は混んでいると思う」 passes) can reach the AI, as a view of the record's day.
- Whether the real AI uses the quote naturally, and does not state a past view as the user's view now, is not verified with a real AI.
