# Memory repair runbook (6 remaining items)

No real data, ids or text belong in this file or anywhere in Git: the reviewed repair data stays in the private JSON file outside Git that the operator loads by hand into the maintenance panel. Nothing here changes data by itself; every step that writes needs the operator.

## What is NOT done by the code
Production repair, the production deploy and enabling `MAINTENANCE_ENABLED` are the owner's decisions. The 6 pending Outbox entries and the HOLD item are never touched by the session.

## Order
1. Items that do not share an updating conversation, one at a time (any order).
2. The two items that share ONE updating conversation (the pair named in the private data), strictly one after the other. The second one finds the shared new Memory already created and reuses it (tested end to end, including the second item failing and being restored to the state after the first).

## Per item (every item, every time)
1. Close every other Tsumugi tab. Open the maintenance panel, load the private repair data.
2. Scan, then the read-only pre-check for the single key. Continue only on the verdict **READY_ALL_CLEAR**. Any other verdict (HOLD, Vault mismatch, unverified Vault, Outbox conflict) is a stop: report it, do not repair.
3. **Make a fresh copy of the whole Vault folder now.** The session compares the copy with the live files and refuses on any difference. After the previous item the Vault has changed, so the copy of the previous item is no longer valid: copy again before every item.
4. Select the copy folder in step 7 of the panel, type the confirmation phrase `REPAIR <key>`, run.
5. The panel downloads the restore point. **Save it, then select the saved file again** (read-back). Nothing is written before that read-back matches.
6. Read the result:
   - `completed`: done and verified; the gate is closed. Start the next item from step 2 (fresh Vault copy first).
   - `refused`: nothing was written. The reason is a code (for example `precheck:*`, `verdict:*`, `vault-backup-differs:<path>`, `reflection-counterpart-unsupported:*`). `reflection-counterpart-unsupported` means the item removes a link whose other end is a system-generated Memory; the scoped sync does not cover that record type, so the item cannot be repaired by this session and must be reported.
   - `rolled-back`: a failure after the first write; everything was restored byte for byte. Report the reason.
   - `rollback-failed` / `needs-review` / "gate is STILL IN PLACE": stop. The window or the gate is kept on purpose so the normal app cannot write. Keep the tab open, do not open Tsumugi, report the lines on the screen. Releasing a stale gate is a separate, deliberate action after the state has been checked.
7. After the last item: compare the Vault copy taken before the last item with the live Vault only for the files the report names, and run the read-only Scan again.

## Not covered (known, explicit)
- Real-device behaviour of the folder permission prompt and the screens' usability; the real-browser harness only covers Web Locks and IndexedDB.
- The Backfill items (separate from these 6).
- A manual "restore from Vault" in the normal app overwrites IndexedDB with the Vault content by design; do not use it between repair items.
