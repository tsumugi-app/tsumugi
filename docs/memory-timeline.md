# Memory Timeline (trial, default OFF)

## What it does
When the switch is ON, a chat turn may carry, besides the normal retrieval, the dated history of ONE OR TWO themes the user just talked about:
the latest statement, the latest event and the current state of the theme, each tied to the Memory it comes from. It is built by code
(`src/lib/memorySynthesis.ts`: `buildThemeTimeline`, `selectTimelineForTurn`) from the Memories the chat screen has already loaded for the turn.

- No extra AI call, no extra IndexedDB read (the list loaded for Topic Continuity / Profile / Person View is reused), nothing is written.
- Existing Memories are never modified. A deleted Memory is not in the list, so it is never in a timeline.
- The current conversation's own Memories are excluded (as for retrieval).
- A theme is attached only when the user's own words contain one of the theme's terms AND the normal retrieval misses the record the state is taken from,
  the latest statement, an earlier different state, or most of the history. Unrelated turns get nothing.
- Any failure while building it yields no timeline; the turn continues with the normal retrieval only (`safeSelectTimelineForTurn`).
- OFF: the chat request has no `memoryTimeline` field and the prompt is byte-for-byte what it was before.
- Memory Synthesis (`memorySynthesis.ts` validation / `memorySynthesisPrompt.ts`) is NOT connected to any screen or API route.

## How to switch it (per browser, never synced)
- ON:  open the app once with `?memoryTimeline=1` (e.g. `https://tsumugi-three.vercel.app/?memoryTimeline=1`)
- OFF: open the app once with `?memoryTimeline=0`
- The setting is kept in that browser's localStorage (`tsumugi.memoryTimeline`). Other browsers / devices / the installed app have their own setting.
  Without the key (or when storage is unavailable) it is OFF. "Delete all Tsumugi data on this device" also clears it.

## Open issues
1. **State is word-based.** The status (予定 / 検討中 / 保留 / 中止 / 実施済み) comes from words in the record's summary, with negation and
   "someone else's thing" (友達の引っ越し) excluded. It does not understand meaning: e.g. "見送り" is shown as 中止, and a status word about something
   minor can be taken as the theme's state.
2. **Several things in one theme.** A theme (a Memory keyword such as 車) can hold several things (the repair, a drive being considered). The newest
   status is shown as the current state and up to two earlier, different states are shown beside it with their records; the chat AI is told they may be
   about different things. This reduces, but does not remove, the chance of mixing them up.
3. Themes are Memory keywords; synonyms and differently worded keywords are separate themes.
4. Verified with fictional users on Preview only; not yet on real Android / iPhone devices or with real long-term data.
