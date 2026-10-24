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
| Vault files (Markdown, index, registry, history) | the user's folder | present / absent / conflicting | never deleted by the app except by the full wipe | `/data`: explicit target preview and separate irreversible confirmation; resumable compare-before-write protocol below |
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
Vault deletion is available as a separate explicit confirmation after local deletion. The local deletion alone never authorizes physical erasure. The tombstone (a) stops the Vault copy from coming back, (b) lets `/data` verify read-only whether the Vault still holds a copy, (c) tells the user when it is safe to forget the tombstone.

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
- Automatic pruning of orphan Outbox entries at startup (they are resolved from `/data`).
- Purging the Recovery Archive: needs a rule tied to the verified restoration of the archived record; not implemented.
- Source (素材) deletion with a tombstone (so orphan Source entries can be tidied up, but not as a "deletion").
- Resolving Vault resync "conflict" registry states from the UI (the full resync is not a user-facing operation).

## Explicit physical deletion protocol (all users, no maintenance credentials)

The first deletion removes canonical records, references, Outbox, ledger and writes tombstones in one IndexedDB transaction. The user then chooses **preview Vault deletion** on that tombstone. This is deliberately separate from “delete from this device”: that existing action must never silently acquire authority to erase owned files. A Conversation's cascade choice also covers Vault-only Memories with matching `conversationId`; without that choice its Memories remain.

1. Under the exclusive `tsumugi-vault-world` lock, then the existing save lock, verify the committed world, absence of recovery/maintenance, paired Vault identity, current folder handle (`isSameEntry`), and permissions. No fallback when Web Locks are absent. Lock acquisition has a 15-second limit. Preview never writes or asks for write permission.
2. Completely enumerate the visible Vault (bounded at 20,000 entries and depth 64). Discover moved/renamed Markdown and duplicates by the shared frontmatter parser, never by filename or an ID mentioned in prose. Require `tsumugi: true` and explicit Memory/Conversation shape; ambiguous ownership stops the operation. Parse all affected derived metadata strictly. No “unreadable means empty” fallback.
3. Show every changed/deleted path. The user confirms irreversibility and that other applications/devices have stopped editing/syncing. Acquire write permission only on confirmation. Re-scan and compare the complete plan to the preview, then atomically persist its exact before/after strings with `physicalDeletion: pending` on the tombstone. No Vault mutation precedes this commit.
4. Invalidate cached registry generations, then invalidate disk registry generation before edits. Remove only matching Markdown entries. Retained entries, their bodies, annotations and unknown fields keep their original bytes; remove deleted links and `memoryObjectIds` only in known frontmatter fields. Delete a file only when no entries remain. Update index keys, registry members/hashes and History v1/v2 rows and absolute aggregates. Registry stat is deliberately stale to force existing content verification. Existing conflict states are preserved; pre-existing external content changes become `needs-resync`, never a newly trusted baseline.
5. Before any edit, preflight every path. At each write, require exact current text equal to confirmed before or after; after means already completed. Read back every write. A failed remove, failed stream close, permission loss, changed file or unreadable scan stops with the durable pending plan intact. Never report completion merely because the Markdown step succeeded.
6. Re-scan for remaining target copies, verify every planned result again, then atomically mark `complete` and remove the journal (including the temporary before/after text). No record body is added to a tombstone or sent to a server.

**Restart/retry:** no automatic destructive worker. The pending row offers replay of the already-confirmed plan. Only original before/after states are accepted. If the user moved/edited data meanwhile, replay stops; a new preview and explicit confirmation can replace the plan with the current files. Previously discovered cascade IDs remain included for metadata cleanup. The whole operation serializes across tabs; stale confirmations lose their tombstone compare-and-set. A pending tombstone cannot be lifted or changed to “keep”.

**Resurrection:** completed physical-deletion tombstones are retained indefinitely (30 days cannot bound offline copies). The existing automatic import, resync, manual restore and Capture guards continue to apply. Legacy queued Memory/Conversation writers re-check both own/cascade deletion and deleted references inside their save lock; stale tasks cannot recreate files or links. Late ledger/Outbox outcome writes also check tombstones inside their IndexedDB transaction. Explicit “allow it back” remains available after completion and intentionally reauthorizes restoration.

**Limits:** File System Access exposes no atomic compare-and-delete/write against OS applications. Web Locks cover this origin's browser tabs only. A change between the final comparison and the OS mutation cannot be eliminated by this API; users must pause external editors/sync before confirming. No claim of distributed transactions or cross-device erasure is made. Hidden Recovery Archive files and operator backups are not erased; the UI explicitly states this, and retained tombstones prevent importing them on this device unless the user allows it back. Full-device wipe still deliberately discards local tombstones; a different browser profile has its own database. Safari/OPFS environments without `createWritable` use the existing verified Worker writer. An in-place Worker write can be torn by process termination: ordinary replay refuses an unknown current state. The pending row offers a separate repair preview displaying current and previously confirmed after text for every affected file. Only a fresh explicit confirmation can replace the pending plan (SHA-256 bound to its journal) and restore those results; a changed file or journal invalidates that repair preview too. This is never an automatic overwrite of a possibly external edit. OS permission dialogs need manual platform verification; browser tests use isolated OPFS and simulated permission denial.

**Validation:** fault-injection tests exercise every interrupted edit prefix, failed metadata close, permission loss, changed content, ownership/malformed-metadata refusal, duplicate/moved/renamed files, byte preservation, cascade scope, pending-plan restart and guard retention; browser tests exercise explicit confirmation, reload/retry, concurrent confirmations, cross-tab change rejection, delayed saves, native-writer absence (real OPFS Worker), and explicit repair of a torn-write state against real IndexedDB and OPFS. Independent review specifically found and drove fixes for delayed writers, stale links and unsafe adoption of external edits.
