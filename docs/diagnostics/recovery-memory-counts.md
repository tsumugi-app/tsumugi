# One-shot Memory Recovery counts (base b9a7930)

This is observation only, not a Recovery fix. No deployment is included.

## Entry point

On a build containing this change, `?debugLog=1` → Settings → Recovery:
use an existing completed Apply Plan, then press **10件を読み取り専用で診断** once.
If no Plan exists, the existing **確認する** produces the read-only Plan; the diagnostic
button itself never invokes a scan, Apply, cleanup, resync or migration.
Do not press recovery/cleanup buttons. Close other Tsumugi tabs and external editors.

Only exactly 10 held records (5 memory registry-entry-differs and 5 memory conflict)
are accepted. Additional held reasons/types, incomplete scans, changed canonical/ledger,
changed world, replaced UI Plan, unreadable files or changed target classifications stop
without partial output. Busy/missing Web Locks also stop, without waiting.

A local/Preview origin does NOT contain Production IndexedDB/OPFS. This implementation
cannot diagnose the existing Production user until separately approved delivery to the
same origin. Do not import data or select another Vault to work around this.

## Reuse / observation boundary

- Input: existing production Recovery Apply Plan, existing Vault handle.
- Existing-only IDB open; upgrade event is aborted. Only readonly transactions.
- Existing Recovery semantic comparator is exported without changing its body.
- Recovery parser (including persisted Evidence adapter) is used for comparisons.
- Projection hash hypothesis uses the actual production parseMemoryDayFile →
  createdAt sort → serializeMemoryDayFile pipeline and hashVaultText.
- Field diagnostics mirror the production comparator's field normalization; an oracle
  check aborts if the diagnostic and production equal/not-equal decisions disagree.
- Existing world-control reader is exported unchanged. No normal db.ts getter/initializer.
- Exclusive, ifAvailable world lock; every file/DB snapshot is re-read before returning.
- No write capabilities are passed into the core. File APIs always use create:false.

No new all-Vault scan is performed: target identity/uniqueness comes from the accepted
Plan. External edits outside observed files since that Plan cannot be ruled out by this
probe. It is a counts-only snapshot, NEVER permission to repair. Locks cannot stop
non-cooperating external applications; re-reads detect observed changes, not all possible
ABA changes or changes after the final read.

## Output

All registry counters count distinct day-files (overlap allowed), except heldMemoryCount.
`reserializeOnlyMatch` is consistent with the no-op serialization bug, not proof of its
historical cause. No-op hash equality is evaluated using the Projection parser, not a
new or simplified YAML implementation.

Conflict classification is exclusive: updatedAt-only; timestamp-only (date day,
createdAt, updatedAt, eventTime, eventTimePrecision); metadata-only; otherwise
substantive-data-difference. Mixed metadata/timestamp changes conservatively fall in
substantive-data-difference. Field histogram names contain no field values. Ignored
production fields (e.g. metadata.id, obsidian, revisitPrompt) remain ignored.

All output is a closed schema: aggregate counts, fixed statuses/categories and fixed
field names only. No IDs, paths, actual dates, text or raw errors; no Console logging,
network send, clipboard automation, localStorage, or persistent diagnostic state.

## Verification

Run `npm run test:recovery-memory-diagnostic` and existing Recovery suites.
Tests trap Vault mutators and non-readonly transactions, test the browser runner with
existing-only DB readers, and compare pre/post storage. Fake tests do not prove browser
or provider correctness; no real-user storage is used by the tests.

## Link-only extension

The same five conflict Memories receive exact JSON Link comparison (the production
comparison contract). Categories are exclusive; same-link-id-content-difference takes
precedence over unique edges. Duplicate IDs abort rather than guessing set membership.
`same-order-and-content` also counts conflicts whose links are unchanged.
`canonicalCounterpart` observes the other endpoint in the existing canonical snapshot
only (not a statement about its Vault copy). Counts are per one-sided Link occurrence
across the five Memories, not distinct global edges. Both source and target direction
are supported; missing/ambiguous endpoints are indeterminate. Matching requires the
entire Link to match, not merely its ID. No extra scan/projection is invoked.
Outbox/ledger timestamps cannot prove a Link payload's authority; storageEvidence is
therefore indeterminate for all five. No additional outbox access is performed.
This probe and the no-op hash prevention fix neither implement nor invoke batch repair.

Target ID/reason/type tuples are copied before IO and compared again after all reads.
Changes to that set, scan completeness or issues abort without partial output.
