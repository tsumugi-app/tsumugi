# Startup I/O: results and open issues (PR #4)

## Done (kept in this PR)
- One reconcile pass remembers the files it already read (cleared by every write; a write / hold / conflict is always decided again from fresh reads).
- No IndexedDB / History rewrites for unchanged, already-done records; the registry file stat is read only when a row has to be written.
- The production migration reads each folder once per pass; unchanged registrations are found with one read-only transaction per kind.
- The fixed 3 s / 20 s wait before the Recovery check was replaced by completion detection (`waitUntilIdle`).
- Measured with the same synthetic 120 conversations / 360 Memories: IndexedDB read-write transactions ≈492 → 7, Markdown reads until "最新の状態です" ≈1,030 → 690, steady-state reads 1,233 → 893, writes 0. On a real Android device the steady state went to 3.7 s (893 reads, 1,053 lookups, 0 writes, 10 read-write transactions).

## Open (not solved here)
1. **First launch with existing records may not reach "最新の状態です" within the 240 s measurement limit** (the initial write-out of ~480 records into the Vault). It is the same on `main`, i.e. not a regression of this PR.
2. **Initial reflection spanning several launches**: after the first launch some records still show "反映されていない記録がある可能性があります" and settle only after a restart.
3. Remaining duplicate reads inside a start (each file is read by the light-check stat, the integrity pass and the migration classification). Sharing them across phases needs a write-generation guard; not done.
4. Not verified on iPhone, nor in the PC external-folder mode.
