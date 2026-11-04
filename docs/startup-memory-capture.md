# Startup Memory creation: specification (proposal, not implemented)

Status: for the owner's review. No app code has changed. `e2e/startup-capture.spec.ts` holds the repro tests.

## Goal

A conversation left without an end action (the app was closed, the connection dropped) still gets its Memories, safely, from what is already saved.

## What happens today

- The startup catch-up in `ChatScreen.tsx` never runs. The effect's dependencies include `runConversationBoundary`, a plain function, so the first re-render sets `cancelled`, and `startupCaptureRanRef` stops it running again. It makes 0 Capture calls. Fixing only this would be unsafe, for the reasons below.
- A failed Capture leaves no record. Once the catch-up runs, it would be retried at every start.
- Oldest first with a limit of 3: old conversations that keep failing would hold back newer ones.
- `persistCaptureImpl` saves the conversation as `captured` first and each Memory afterwards, in separate transactions. A stop or a failed write between them leaves `captured` with no Memory, and nothing repairs it. This also affects the normal end action today.
- `captureConversation` works on a snapshot and `putConversation` writes it back. A conversation still open in another tab can be captured there, then lose its new turns or return to `active` and be captured again (duplicate Memories).
- The catch-up uses the same `captureStatus` and `boundaryOutcomeRef` as the end action, so it can change what the screen says about the conversation in use.
- The AI call runs inside the shared Vault lock with no time limit, so a stalled request delays a Vault switch.
- A device with no user key would use the server key (`resolveApiKey` falls back to the environment).

## Which conversations are processed

All of these must hold:

1. `status === "active"`, with at least one user turn and at least one AI turn with words.
2. Not ending in a cut-off reply (`endsWithInterruptedReply`). The user decides those on the home screen, as decided in #24.
3. No Memory exists for it (no stored Memory with this `conversationId`, and `memoryObjectIds` empty). Otherwise it has been processed: no AI call.
4. Not touched for at least 30 minutes (`updatedAt`).
5. Touched within the last 14 days. Older ones are never sent automatically.
6. Open in no tab (Web Lock below).
7. Attempt limit not reached, and the wait after an HTTP failure has passed.

The run itself needs: Vault connected, no recovery journal pending, no Vault switch, online, and a user API key saved on this device. Otherwise it makes no call and records nothing.

Newest first, 1 conversation per start, at most 5 per 24 hours on the device.

## State

- Done or not: the existing `Conversation.status`. Markdown keeps its format and gains no new key.
- Attempts: one device-local value in the IndexedDB `settings` store, `{ conversationId: { attempts, lastAttemptAt, lastKind } }`, plus the daily count. No schema version change and nothing in the Vault. If it is lost, the limits restart; finished conversations stay finished through `status`.
- The attempt is written before the AI call, so a stop during the call is still counted.
- Open or in progress: Web Locks, released by the browser when a tab closes or crashes, so nothing can stay stuck. A tab holds `tsumugi-conversation-<id>` while the conversation is open. The catch-up takes it with `ifAvailable` for the whole processing and skips the conversation if it is taken. Without Web Locks the catch-up does not run.

## Saving

The conversation's `captured` status, all its Memories and their outbox entries are written in one IndexedDB transaction, after re-reading the stored conversation inside that transaction:

- A stop before it: nothing changed; the conversation stays `active` and is tried again within the limits.
- A stop after it: finished. Vault files follow through the existing outbox and repair path.
- Turns changed since the snapshot: nothing is written and the result is discarded (no second AI call in this run).
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

After 3 attempts a conversation is not tried automatically again. The conversation stays intact. A manual retry is a separate decision.

## AI calls and cost

The same calls the end action already makes, only for conversations left without one.

| Call | Per | Count |
| --- | --- | --- |
| `/api/capture` | conversation attempt | 1, or 2 when every candidate fails evidence validation (server side) |
| `/api/connect` | Memory | 0 or 1 (none without candidates) |
| `/api/prompt` | Memory | 1 |

Worst case for one conversation over all attempts: 3 attempts x 2 = 6 Capture calls, plus 2 calls per Memory once saved. A device without a backlog makes 0 calls at startup.

Cost estimate for `gemini-3.1-flash-lite` at USD 0.25 per million input tokens and USD 1.50 per million output tokens, thinking included. Token counts are estimates from prompt length, not measurements.

| Call | Input tokens | Output tokens | USD |
| --- | --- | --- | --- |
| Capture | 15,000 | 1,800 | 0.0065 |
| Connect | 1,500 | 300 | 0.0008 |
| Prompt | 1,800 | 330 | 0.0010 |

- A conversation with 2 Memories: about USD 0.01.
- Limit of 5 per 24 hours: about USD 0.05 per day in normal cases, about USD 0.20 per day if every attempt uses the Capture retry and the failures are billed.
- The cost is on the user's own key. The server key is never used for the catch-up.

## What leaves the device

The same as the end action: the conversation's turns and the summaries of related Memories go to the Capture model. Capture always uses Gemini, so a conversation held with another chat provider would go to Gemini without an end action. The new part is that this happens with no action by the user, which is why the 14-day limit exists and why the rollout below is opt-in.

## Speed

The catch-up starts after the home screen is usable, runs one conversation in the background, stays away from the status shown for the conversation in use, holds no Vault lock during the AI call, and is cancelled by a Vault switch. Startup and chat do not wait for it.

## Rollout

Running this writes to existing data on a device: new Memories, and `status` changing from `active` to `captured` in stored conversations and Markdown. It stays behind a device setting, off by default, until the owner turns it on, so a deploy alone changes nothing.

## Decisions for the owner

1. Waiting time 30 minutes, and period 14 days.
2. 1 per start and 5 per 24 hours.
3. Off by default until the owner turns it on.
4. Conversations older than the period, and ones that reached 3 attempts, are left without Memory unless a manual action is added later.
