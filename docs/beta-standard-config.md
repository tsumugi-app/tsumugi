# Beta standard configuration — Retrieval / Dedupe / Timeline

Fixed on 2026-11-19, at the end of the "Retrieval finalization" round. This is the configuration the beta runs with;
anything not listed as ON here is OFF (shelved), not "half-enabled".

## The standard

| Piece | State | How it is controlled |
|---|---|---|
| Retrieval (standard selection, incl. the analyst person-change arc, PR #55) | ON | No switch. The arc applies in the analyst (クリエイト) path only — a consequence of the development rule that companion/coach retrieval logic is not touched, not a recorded product decision. |
| Context Dedupe (exact-duplicate removal across context sections, PR #58) | ON | Default ON. Temporary kill switch: `?contextDedupe=0` for that load. No localStorage. |
| Memory Timeline (PR adopting it: the Timeline default-ON change, 2026-11-19) | ON | Default ON. Per-browser opt-out: open once with `?memoryTimeline=0` (kept in localStorage); `?memoryTimeline=1` turns it back on. See `docs/memory-timeline.md`. |
| Memory Graph | OFF — shelved | Developer switch, default OFF (`?memoryGraph=1`). Not part of the standard until a need is confirmed. |
| Memory Synthesis | OFF — shelved | Developer switch, default OFF (`?memorySynthesis=1`). Not part of the standard until the quality of its real (non-replica) hypotheses is verified. |

## Effects confirmed by measurement

- **Dedupe**: in the 12-configuration context evaluation, turning it on changed no required evidence, no
  contamination and no selection; it only removed exact duplicates (−792 chars / −3 duplicates in the evaluation
  matrix). The default-ON change (PR #58) left the evaluation output byte-identical.
- **Timeline**: conversation-quality verification on 2026-11-19 — 96 real Gemini responses (model
  `gemini-3.1-flash-lite`, the code default), fictional scenarios run through the production context-assembly and
  chat route, Timeline OFF vs ON as the only difference, blind scoring on 9 axes fixed in advance.
  ON scored higher overall (9-axis total 31.40 → 38.69; ON superior in 42 of 48 response pairs), with the largest
  gains in timeline/change understanding (+1.75) and natural memory use (+1.63). Zero fatal errors (person
  contamination, event/date errors, state misreadings, hypotheses stated as fact) in either arm. In the state-word
  trap scenario, all 12 ON responses treated a 「見送り」 record correctly as a postponement. OFF's typical failure
  was omission: answering that recorded history "is not in the records", or using only part of the arc.
- **Retrieval arc (PR #55)**: in the same 12-configuration evaluation, the change-yuki case went from 0/2 to 2/2
  required evidence in the default configuration, with no other configuration's results changed and contamination
  kept at 0.

## Known issues carried into the standard

- **Timeline state is word-based** (`statusOf` in `src/lib/memorySynthesis.ts`). 「見送り」 was classified as 中止
  until this adoption; it is now classified as 保留 (postponement). The general limitation remains: the label comes
  from words, not meaning, so a 「見送り」 that really means "dropped" now reads as 保留， and a minor status word
  can be taken as a theme's state. The basis record's own words are always shown next to the label.
- Timeline themes are Memory keywords: synonyms split themes, and one theme can hold several different things
  (see `docs/memory-timeline.md`, open issues 2–3).

## Not yet verified (do not treat as confirmed)

- Behaviour on real devices and with real, long-term user data (all verification above used fictional data;
  Timeline's earlier checks were Preview-only).
- Dedupe's savings on real data (evaluation data showed at most ~200 chars per request).
- Memory Graph's alias-bundling benefit (never isolated in evaluation) and Memory Synthesis's real hypothesis
  quality (its earlier evaluation used a replica of the selection logic). Both stay OFF until verified.
- Whether the person-aware retrieval / arc should extend beyond the analyst path (companion/coach) — open,
  unverified product question.
- Whether Vercel production overrides the conversation model (`GEMINI_MODEL`); the verification used the code
  default, `gemini-3.1-flash-lite`.
