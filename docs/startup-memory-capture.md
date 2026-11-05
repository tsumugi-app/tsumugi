# Startup Memory creation

Implemented on PR #26 with the decisions the owner made on 2026-11-04. Code: `src/lib/autoCapturePolicy.ts`, `src/lib/autoCaptureRun.ts`, `src/lib/conversationLocks.ts`, `commitCaptureResult` in `src/lib/db.ts`, `captureConversationBoundaryBody` in `src/components/ChatScreen.tsx`. Tests: `e2e/startup-capture.spec.ts`, `src/lib/autoCapture*.test.ts`.

## Goal

A conversation left without an end action (the app was closed, the connection dropped) still gets its Memories, safely, from what is already saved.

## What was wrong before

- The startup catch-up never ran. Its effect depended on a plain function, so the first re-render cancelled it.
- A failed Capture left no record, so it would have been retried at every start, and old failing conversations would have held back newer ones.
- The conversation was saved as `captured` first and each Memory afterwards in separate transactions. A stop or failed write between them left `captured` with no Memory. This affected the normal end action too.
- A Capture wrote back its snapshot of the conversation, so a conversation open in another tab could lose turns or be captured twice.
- The AI call ran inside the shared Vault lock with no time limit.

## Which conversations are processed

All of these must hold:

1. `status === "active"`, with at least one user turn and at least one AI turn with words.
2. Not ending in a cut-off reply (`endsWithInterruptedReply`). The user decides those on the home screen, as decided in #24.
3. No Memory exists for it (no stored Memory with this `conversationId`, and `memoryObjectIds` empty). Otherwise it has been processed: no AI call. References to Memories not found on the device count too, because a Vault restore or sync may bring them back: nothing is made in their place, the conversation stays `active`, no attempt is used, no record is changed, and Settings shows how many wait. The check is repeated under the conversation lock and inside the save transaction, so a Memory or reference arriving during the AI call discards the result, and a Vault file with the same words that says `captured` or refers to Memories (another device finished it) stops the run for that conversation. Normal end actions keep their own check.
4. Not touched for at least 30 minutes (`updatedAt`). There is no upper age limit.
5. Open in no tab (Web Lock below).
6. Attempt limit not reached, and the wait after an HTTP failure has passed.
7. Known to be held only with Gemini (`chatProviders`), or the user has allowed other conversations. A new conversation starts with an empty record, also when its first turn is a past question from the home screen. A conversation from before this record existed counts as unknown and needs the permission.

The run itself needs: the setting on, Vault connected, no recovery journal pending, no Vault switch, online, and a user Gemini key saved on this device. Otherwise it makes no call and records nothing. The server key is kept out at two layers. In the app, each automatic request (Capture, Connect, question) reads the key at the moment it is built, and sends nothing if it is missing, blank or cannot go in a header. Every automatic request also carries `X-Tsumugi-User-Key-Only: 1`, and for those `resolveApiKey` never returns the server key, so the routes answer 401 without reaching a provider. If the key goes before the Capture request, no attempt or daily count is used and the conversation waits for a later start. If it goes during the AI call the Memory is kept; Connect stays not done and catches up at a later start with a key, and a question left unmade is made by the home screen. The startup Connect catch-up carries the same mark. The end of a conversation and ordinary conversations do not carry it and work as before.

Order: never tried before retried, then oldest first, so a conversation that keeps failing does not hold back the others and no conversation waits forever. 1 conversation per start, at most 5 AI requests per 24 hours on the device.

A conversation passed over before any request costs nothing, and the next one is tried. Once a request is made, this start has had its conversation: the run ends and the request counts, whatever becomes of it (a result thrown away because the words changed, a refused key, a failure). Only a request really started counts: what stops before it does not. A thrown away result or a refused key uses none of the conversation's 3 attempts.

An edit made from outside to the conversation's Vault file is not in the stored conversation yet. Every Capture reads that one file before the request and again before saving, inside the save lock, so a write under way is not taken for an edit. If the words in the file are not the conversation's words, nothing is sent or saved, the conversation stays `active`, and the file stays as it is. The existing Vault check tells the user, and once the edit is taken in the conversation can be processed again from the edited words. A change that leaves the words as they are stops nothing. When the file cannot be read or its record is held for another reason, the automatic run passes the conversation over, while the end of a conversation goes on as before, with the file protected by the write check. An edit landing between the last check and the save is not seen; the Memory then matches the words up to that moment, and the file is still not overwritten.

## State

- Done or not: the existing `Conversation.status`. Markdown keeps its format and gains no new key.
- Which AI: `Conversation.chatProviders`, added at each send, on the device only. A conversation restored from the Vault loses it and counts as unknown, and an old conversation that goes on with Gemini stays unknown.
- Settings: `enabled` and `allowOtherProviders` in the `settings` store, both off by default.
- Attempts: one device-local value in the IndexedDB `settings` store, `{ conversationId: { attempts, lastAttemptAt, lastKind } }`, plus the daily count. No schema version change and nothing in the Vault. If it is lost, the limits restart; finished conversations stay finished through `status`.
- The attempt is written before the AI call, so a stop during the call is still counted.
- Open or in progress: Web Locks, released by the browser when a tab closes or crashes, so nothing can stay stuck. A tab holds `tsumugi-conversation-<id>` while the conversation is open. The catch-up takes it with `ifAvailable` for the whole processing and skips the conversation if it is taken. Without Web Locks the catch-up does not run.

## Saving

The conversation's `captured` status, all its Memories and the outbox entries of all of them are written in one IndexedDB transaction, after re-reading the stored conversation inside that transaction:

- A stop before it: nothing changed; the conversation stays `active` and is tried again within the limits.
- A stop after it: finished. Vault files follow through the existing outbox and repair path.
- The words changed since the snapshot (more turns, or an adopted Vault version with other or fewer turns): nothing is written and the result is discarded (no second AI call in this run). The next start decides again on what is stored.
- Tombstones and Memory lineage checks stay inside the transaction, as they are now.

The normal end action uses the same save, which also removes its `captured` without Memory state.

## Results and retries

| Result | Status | Counts as attempt | Next |
| --- | --- | --- | --- |
| Memories saved | `captured` | yes | done |
| AI found nothing (`empty`) | `captured` | yes | done |
| All candidates invalid (`all-dropped`) | `active` | yes | after 6 hours |
| HTTP 5xx or 429 | `active` | yes | run stops; after 6 hours |
| Key refused (400, 401, 403) | `active` | no | run stops; next start. No extra call in this start |
| Network failure or 60 second timeout | `active` | yes | run stops; next start |
| App closed during the call | `active` | yes (written before the call) | next start |
| Conversation changed, deleted or open | unchanged | no | re-evaluated next start |

After 3 attempts a conversation is not tried automatically again and stays intact. Settings shows the count and a button that retries one stopped conversation per press. It needs the key and the permission, is not held by the daily limit, and allows 3 more automatic attempts.

## AI calls and cost

The same calls the end action already makes, only for conversations left without one.

| Call | Per | Count |
| --- | --- | --- |
| `/api/capture` | conversation attempt | 1, or 2 when every candidate fails evidence validation (server side) |
| `/api/connect` | Memory | 0 or 1 (none without candidates) |
| `/api/prompt` | Memory | 1 |

Worst case for one conversation over all attempts: 3 attempts x 2 = 6 Capture calls, plus 2 calls per Memory once saved. A device without a backlog, or with the setting off, makes 0 calls at startup for this.

Cost estimate for `gemini-3.1-flash-lite` at USD 0.25 per million input tokens and USD 1.50 per million output tokens, thinking included. Token counts are estimates from prompt length, not measurements.

| Call | Input tokens | Output tokens | USD |
| --- | --- | --- | --- |
| Capture | 15,000 | 1,800 | 0.0065 |
| Connect | 1,500 | 300 | 0.0008 |
| Prompt | 1,800 | 330 | 0.0010 |

- A conversation with 2 Memories: about USD 0.01.
- Limit of 5 per 24 hours: about USD 0.05 per day in normal cases, about USD 0.20 per day if every attempt uses the Capture retry and the failures are billed.
- The cost is on the user's own key. The server key is never used for the automatic run.
- With no age limit the whole backlog is eventually processed, at this daily rate.

## What leaves the device

The same as the end action: the conversation's turns and the summaries of related Memories go to the Capture model. Capture always uses Gemini, so a conversation held with another chat provider would go to Gemini without an end action. The new part is that this happens with no action by the user, which is why it is off by default and why conversations of another or unknown AI need a separate permission.

## Speed

The run starts 5 seconds after the Vault is connected, handles one conversation in the background, stays away from the status shown for the conversation in use, holds no Vault lock during the AI call (for the end action too), stops after 60 seconds, and is cancelled by a Vault switch. Startup and chat do not wait for it.

## Rollout

Running this writes to existing data on a device: new Memories, and `status` changing from `active` to `captured` in stored conversations and Markdown. It is off by default, so a deploy alone changes nothing. The save in one transaction applies to every device, including with the setting off.

## Known limits

- Another device finished a conversation (its file says `captured` or refers to Memories this device does not hold): a save from this device's older state does not take that back. The save is held as a choice of versions in Settings, unless the file is the version Tsumugi itself last wrote here (Registry hash). The automatic run does not send it, and the end of a conversation stops as for an outside edit, so no Memory is made twice.
- Which AI held a conversation is kept when a Vault version with the same words is taken in. Other or more words may have been held with any AI elsewhere, so the conversation becomes unknown and needs the permission (`chatProvidersAfterAdopting`).
- The run is scheduled once per start, when the Vault is connected. A start with the folder permission lost runs after the permission is given back, not before.

- A conversation already saved as `captured` without its Memory before this change stays that way; nothing can tell what its Memories were without a new AI call.
- A conversation with a failed Capture at the end action stays `active`. With the setting off nothing retries it.
- The end action and other features still fall back to the server key when the device has no user key, as before. Only the automatic runs do not.
