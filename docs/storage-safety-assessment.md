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

## Not verified (needs a person or real data)
- The OS folder picker and its permission prompts, Vault folder permissions on the real folder, behaviour with Obsidian / sync tools running, usability of the screens on a real device.
- Any repair on real data. The reviewed repair data is private and was never read; which of the 6 items hit the Reflection refusal or share files with a pending Outbox entry is unknown until the pre-check runs on the real database.
- Recovery needs the SAVED restore point and the operator's Vault copy of THAT item; without them the gate stays (by design).
- `main` merge: the code is complete and tested as above, but merging only ADDS the maintenance area (404 unless enabled) and the Capture filter. Repairs still need the owner's approvals listed in the report.
