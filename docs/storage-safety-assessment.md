# PR #3 (claude/storage-safety): what it contains, what was verified, what was not

No real data, ids or text appear here.

## Contents
- Capture isolation (`capture-isolation`): the update targets of a Capture are filtered to the conversation's own Memories (third layer behind the caller and the updatable map).
- Maintenance area (`maintenance-gate`): authenticated `/maintenance/repair` (404 unless MAINTENANCE_ENABLED=1 + password), durable gate, exclusive Vault-world lock, scoped Vault writes, restore point + strict restore engine, single-item repair session, pre-check and Scan, panel steps 1-8.
- Crash recovery (this round): diagnosis (read-only), typed confirmation, restore from the saved restore point, gate released only after verification. The unverified "release a stale gate" function was removed; only the verified recovery (and a cleanly finished window) can close a gate.
- CI: all test suites + production build (Node 22), Playwright E2E (panel with dummy credentials, fictional files, real-browser repair session on IndexedDB + Web Locks + OPFS, crash recovery), one-shot Codex review request, review loop.
- Guard tests: the Memory write surface is pinned (a new writer fails CI until reviewed); the boundary check compares the PR with its base in CI.

## Verified automatically
- Whole repair pipeline and every failure point restore byte for byte (node tests with an in-memory Vault; real browser with OPFS for: success, failure after the commit, failure after the sync).
- Two items sharing one updating conversation, one after the other, and the second failing.
- Items whose removed link ends at a system-generated Memory are refused BEFORE any write.
- Tab killed mid-repair: lock freed by the browser, gate stays, normal writes stay blocked, diagnosis, recovery, byte-identical state, gate closed only after verification. Unexplained state (foreign file in a Tsumugi area, record of the scope that does not fit one commit time, a scope Vault file not recorded by the dead window, a restore point of another gate, a different Vault copy, a damaged restore point) -> nothing written, gate kept, lock returned.
- Unrelated pending Outbox entries and protected records are byte-identical in every path.
- Codex independent reviews: findings fixed in this PR (gate-close failure reported as completed, CI boundary check skipped, Reflection counterpart, three P1 on crash recovery).

## Hardening added after the Codex reviews of the crash recovery
- A restore point is accepted only for the gate it was captured under.
- IndexedDB records are explained only by the EXACT after-images the repair commit stored in its own durable backup (not by a timestamp); Outbox entries only as pending/done, never held; Vault files only by content hashes the dead window recorded durably BEFORE writing (write-ahead evidence). Anything else stops the recovery and keeps the gate.
- Every Vault file is re-read and compared with what the plan saw immediately before it is restored or removed; a file edited after the plan is never overwritten.
- A link counterpart that a repair would rewrite is protected before any write: unfinished Outbox entry, held / excluded by the decision list, not READY right now, system-generated; its files join the Outbox conflict check and its Vault state joins the consistency check.

## Residual, accepted limits
- Between the last re-check and the write of one Vault file there is a window of milliseconds that only an OS-level file lock could close; the Vault is also protected by the gate, the exclusive lock and the operator being told to stop other programs.
- A scoped Outbox entry changed by hand to another pending/done version of the same record is restored to the restore-point value (that value is what the repair started from).

## Not verified (needs a person or real data)
- The OS folder picker and its permission prompts, Vault folder permissions on the real folder, behaviour with Obsidian / sync tools running, usability of the screens on a real device.
- Any repair on real data. The reviewed repair data is private and was never read; which of the 6 items hit the Reflection refusal or share files with a pending Outbox entry is unknown until the pre-check runs on the real database.
- Recovery needs the SAVED restore point and the operator's Vault copy of THAT item; without them the gate stays (by design).
- `main` merge: the code is complete and tested as above, but merging only ADDS the maintenance area (404 unless enabled) and the Capture filter. Repairs still need the owner's approvals listed in the report.

## The 6 remaining items: order, constraints, effect on the unprocessed Outbox (no private data was read)
- Order: independent items first, one at a time, each with a fresh Vault copy; the two items that share one updating conversation strictly one after the other (tested end to end, including a failure of the second one).
- What can refuse an item BEFORE any write (each is a fixed code on screen): the pre-check verdict (HOLD, Vault mismatch / unverified, Outbox entry sharing a day-file / shard / month with a target OR with a link counterpart), a link counterpart that is system-generated (Reflection), has its own unfinished Outbox entry, belongs to a held / excluded / not-READY item, or is not consistent in the Vault.
- Effect on unprocessed Outbox entries: a pending / held entry is never rewritten, reset or re-queued by the session (tested: byte-identical in every path). An item that would have to rewrite one (as a target's neighbour in the same files, or as a link counterpart) is refused instead. Which of the 6 items that affects is unknown until the pre-check runs on the real database.
- The HOLD item and every item the decision list holds / excludes (and every item that is not READY at that moment) is protected, also as a link counterpart.
- Private data limit: the reviewed repair data and the real database were never available here. Per-item READY / refusal, the Reflection-link case and the real Outbox overlaps can only be known by running the read-only Scan and pre-check in the owner's browser.

## Merge assessment (main)
- Safe to merge in the sense that matters: the change only ADDS the maintenance area (404 unless MAINTENANCE_ENABLED=1 and a password are set; nothing links to it) and the Capture own-conversation filter; normal operation, startup, API routes, PWA files and next.config are untouched (checked in CI against the PR base). Production repair stays impossible until the owner enables the area and runs it.
- Not a statement about repair safety on real data: that needs the owner's approvals (enable the area, the per-item runs with fresh Vault copy and saved restore point) and the real-device checks listed above.
