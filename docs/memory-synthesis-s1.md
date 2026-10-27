# Memory Synthesis S1 (trial, default OFF)

## What it does
With `?memorySynthesis=1` (per browser, kept in localStorage; `?memorySynthesis=0` turns it off and keeps the data):
- **After a session / conversation ends**, Tsumugi may generate hypotheses in the background: only for themes that need it, at most one attempt per
  device per 24 hours, at most 4 themes, one AI call (`/api/synthesize`). The chat never waits for it.
- **In a chat turn**, when the Memory Timeline attaches a theme (same rules as `?memoryTimeline=1`), the usable hypotheses of that theme (at most 2)
  are attached too, labelled as Tsumugi's readings. No AI call is added to the chat.
- OFF: nothing is generated or read; the chat request is exactly what it was before.

## Data (device only, IndexedDB `tsumugi-synthesis`, record schema version 1, database version 2)
| store | content | kind |
|---|---|---|
| hypotheses | Tsumugi's readings, with evidence Memory ids + versions, the theme state they were made in, where they were used | regenerable cache |
| reactions | the user's clear rejections / corrections (verbatim quote) | user data |
| exposures | conversations in which a hypothesis was used | provenance (kept with the reactions) |
| themeStates, meta | generation bookkeeping | regenerable |
Not a Memory: never in the `tsumugi` database, the Vault, the Outbox or sync. Theme ids are `kw:<keyword>` (S1); `person:<groupingKey>` is reserved for S2.

## Updating
A theme is generated again when (highest priority first): a used hypothesis got an answer to judge, the theme's state changed, an evidence Memory
was edited / deleted, 2+ new Memories arrived. At read time a hypothesis is not used when an evidence Memory is gone or edited, the theme state changed,
its newest evidence is older than 180 days, or it resembles something the user rejected.
- A rejection / correction is stored only when the user's own words (verbatim) clearly deny it. Unclear answers and agreements ("そうかも") change nothing.
- Rejected readings are sent to the model as "do not propose" and filtered again by code (route and client).
- A Memory captured from a conversation where a hypothesis was used, without substantive words of the user, is not evidence.
- A failed or interrupted run changes only the bookkeeping; hypotheses and reactions stay as they were (one transaction per run).
- A use in a conversation that is still open and unanswered stays pending; a replaced hypothesis whose uses are not all checked is kept as
  "retired" (never used in chat) until they are. Uses recorded while a run waits are merged into its commit, never overwritten.

## Deleting
- `/synthesis-data`: "仮説を消す" (cache only; reactions and exposures stay) / "すべて初期化" (reactions too). Both need a confirmation and move the
  database to a new reset epoch, so a run that was waiting for the AI cannot write its result afterwards (checked in the commit transaction, any tab).
- The full device wipe deletes `tsumugi-synthesis` (also listed by name for browsers without `indexedDB.databases()`).
- Deleting a Memory removes the hypotheses that used it (at read time).
