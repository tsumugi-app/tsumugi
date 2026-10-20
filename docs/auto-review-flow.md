# Automated development flow

1. Goal given to Claude Code -> it investigates, implements, tests (`ci` workflow = all `test:*` suites + `next build`).
2. Claude Code pushes a `claude/*` branch and opens a PR (never merges, never deploys).
3. Codex auto-reviews on PR creation (Codex setting). Findings arrive as PR reviews/inline comments tagged [P0]/[P1].
4. Claude Code reads the findings and fixes them (max 2 rounds), pushes.
5. `review-loop` workflow comments `@codex review` on each fix push (max 2 per PR, marker-counted), waits up to 25 min for the review of that commit, labels `needs-human` on limit/timeout.
6. Only the final result is reported to the owner.

Permissions: `ci` = contents:read. `review-loop` = pull-requests/issues:write. No secrets are used or stored.

## Verified on PR #1 (2026-10-18)
- Codex auto-review on PR creation works (P2 finding posted as an inline comment). A `@codex review` comment by a human account also works.
- A `@codex review` comment authored by `github-actions[bot]` is IGNORED by Codex (no review within 35 min). The draft->ready fallback with `GITHUB_TOKEN` is impossible ("Resource not accessible by integration").
- `review-loop` timeout (25 min) and the `needs-human` label work. The round limit (2) is counted by marker comments.
- So the automatic re-review needs a human-identity trigger: a person comments `@codex review`, or a PAT stored as a repo secret is used by the workflow (not set up).
- The Claude-side fix step (reacting to Codex findings) is not automated in Actions; it relies on the Claude desktop app PR monitor, not tested.

## Re-review trigger (needs one-time owner setup)
Codex ignores bot-authored comments, so `review-loop` posts `@codex review` with a user-owned token stored as the repo secret `CODEX_TRIGGER_TOKEN`
(fine-grained PAT, repository tsumugi-app/tsumugi only, permission "Pull requests: Read and write" or "Issues: Read and write"; nothing else).
Without the secret the job fails with an explicit message and the PR is not re-reviewed. Claude Code on the Mac cannot post comments itself: it has no `gh`
and using the stored git credential for API calls was refused by the environment's safety classifier, so that path is deliberately not used.
