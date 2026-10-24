# Data lifecycle: deleting, stuck sync states, and cleaning up protective data

Principle: protecting data is not enough. The user must be able to see, resolve and delete their own data, and nothing may stay "held" forever with no way out. Nothing is deleted automatically: every deletion is a button the user presses (two-step confirmation).

## Audit (what exists, who can resolve it)

| Data | Where | States | Before this change | Now |
|---|---|---|---|---|
| Memory / Conversation records | IndexedDB | exist / absent | no per-record delete at all (only "wipe the whole device", which leaves Vault files and brings them back when the same Vault is reconnected) | `/data`: delete one Memory or Conversation (optionally the Memories made from it) |
| Links between Memories | both Memories hold the link | consistent / dangling | no deletion existed | deleting a Memory removes the link on the other end (and queues that Memory for the Vault) in the same transaction |
| Owning conversation's `memoryObjectIds` | Conversation record | list | n/a | updated in the same transaction |
| Outbox entry (sync task) | IndexedDB `vaultOutbox` | pending / done / held | `held` (conflict, vault mismatch, record missing) and pending-forever (e.g. 40 failed attempts) had NO resolution screen (the old "resolve hold" UI was removed as dead code) | `/data` lists them; per entry: retry, keep both as they are, delete from this device, or (orphan) tidy up |
| Sync ledger (`vaultSyncState`) | IndexedDB | version string | cleaned only by maintenance | removed with the record; set to the current version by "keep both" |
| Vault files (Markdown, index, registry, history) | the user's folder | present / absent / conflicting | never deleted by the app except by the full wipe | NOT deleted by the app. `/data` checks (read-only) whether a copy remains and tells the user; see "Not implemented" |
| Recovery Archive (hidden folder in the Vault) | the user's Vault | entries | never purged | unchanged: never purged automatically; see "Not implemented" |
| Restore points, Vault copies (maintenance) | files the operator saved | n/a | kept by the operator | unchanged (outside the app) |
| Maintenance write-ahead evidence | IndexedDB settings | per gate | deleted at a clean end / after a verified recovery | unchanged |

## Resurrection paths (a deleted record coming back by itself)
Besides the Vault -> IndexedDB copies listed below, a Capture that is still running when the user deletes its conversation can not undo the deletion: the conversation write and the Memory writes (`putConversation`, `putCapturedMemoryWithOutbox`) check the tombstones inside their own transaction and write nothing (and nothing reaches the Vault).
All three ways records are copied from the Vault into IndexedDB now refuse a record that has a tombstone:
1. startup auto import (`importMissingRecordsIfAbsent`): counted as skipped;
2. Vault resync "added" outcomes (`addConversationIfAbsentAndMarkSynced`, `addMemoryObjectIfAbsentAndMarkSynced`, and in `vault.ts` no History row / no registry commit for a tombstoned record);
3. manual "restore from the Vault" (`restoreConversationIfNotNewer`, `restoreMemoryObjectIfNotNewer`): result `tombstoned`.
A Memory copied in by any of these paths (including an edited Memory applied by resync) loses a link whose other end is a tombstoned Memory (new `updatedAt`, queued for the Vault in the same transaction, not marked as synced).
A Conversation copied in the same ways loses references (`memoryObjectIds`) to deleted Memories in the same way. On devices whose Vault is the app's own storage (OPFS) `/data` reads that storage directly.
If the tombstone store itself is unreadable, every re-insertion is refused (fail closed) and deleting is refused.
Recovery Apply / legacy cleanup only write to the Vault side and do not insert records into IndexedDB.
The full-device wipe is unchanged by design: it clears IndexedDB including tombstones, and the Vault files remain.

## Tombstone (the durable record of the deletion intent)
`settings["tombstones:v1"]` = map `kind:id -> { deletedAt, date | startedAt, conversationId?, vault: "unverified" | "absent" | "kept" }`. It holds ids, dates and states only, never record text.
Vault sync of a deletion: the app does not remove Vault files itself. The tombstone (a) stops the Vault copy from coming back, (b) lets `/data` verify read-only whether the Vault still holds a copy, (c) tells the user when it is safe to forget the tombstone.

## When a tombstone may be forgotten (purge)
A tombstone remembers the Vault (`vaultId`) this device was paired with when the record was deleted. Checking or purging against a different Vault (or one whose identity file does not match) answers "unknown": it neither marks the copy absent nor allows forgetting, because switching back to the original Vault would otherwise bring the record back. (A tombstone made while no Vault was paired has no binding and behaves as before.)
All of: the Vault copy is absent NOW (the stored `absent` verdict can be old, so the Vault is read again right before each tombstone is cleared; the search finds the record's `id:` line in every Markdown file of the whole visible Vault (hidden folders such as `.tsumugi` are skipped, like the restore scan), wherever the user moved it, including record folders nested at any depth, and an `index.json` key alone is not presence; a copy that reappeared puts the state back to `unverified`; without a readable Vault nothing is purged); at least 30 days have passed since the deletion (other devices / profiles syncing through the same Vault have had time); the user did not choose "keep the Vault copy" (`kept` is never purged automatically). The user can instead press "allow it back" (lifts the tombstone; the record is not recreated, it can be restored from the Vault if the Vault still has it).

## Stuck sync states: every state has a way out
- held, record exists: retry / keep both as they are (allowed only after a read-only check finds the record's copy in the Vault: closing the entry stops this device from saving it, so the local record must not be the only copy; the check is bound to the entry the user saw (if it changed meanwhile nothing is closed); Sources/ is searched too; entry closed and a durable marker for that record version, so the startup integrity check does not hold it again (the content comparison is skipped, but the Vault copy is still checked: if it is lost the entry is re-projected); a later change re-queues it normally) / delete from this device.
- held, record missing (orphan): tidy up as a deletion (also keeps a remaining Vault copy from coming back) or just tidy up the entry.
- pending after many attempts: same actions as held.
- A normal pending entry (few attempts) is not shown: it resolves by itself.
Refused while a maintenance window or a recovery is blocking normal writes.

## Not implemented (explicit)
- Physically removing the Memory / Conversation file (and its History / registry / index rows) from the Vault when the user deletes a record. The Vault projection engine has no delete step; adding one touches the registry and History machinery and needs its own reviewed design and tests. Until then the user removes the file in the Vault (Obsidian) and uses "check the Vault" on `/data`.
- Automatic pruning of orphan Outbox entries at startup (they are resolved from `/data`).
- Purging the Recovery Archive: needs a rule tied to the verified restoration of the archived record; not implemented.
- Source (素材) deletion with a tombstone (so orphan Source entries can be tidied up, but not as a "deletion").
- Resolving Vault resync "conflict" registry states from the UI (the full resync is not a user-facing operation).
