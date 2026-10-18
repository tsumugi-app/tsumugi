# Automated development flow

1. Goal given to Claude Code -> it investigates, implements, tests (`ci` workflow = all `test:*` suites + `next build`).
2. Claude Code pushes a `claude/*` branch and opens a PR (never merges, never deploys).
3. Codex auto-reviews on PR creation (Codex setting). Findings arrive as PR reviews/inline comments tagged [P0]/[P1].
4. Claude Code reads the findings and fixes them (max 2 rounds), pushes.
5. `review-loop` workflow comments `@codex review` on each fix push (max 2 per PR, marker-counted), waits up to 25 min for the review of that commit, labels `needs-human` on limit/timeout.
6. Only the final result is reported to the owner.

Permissions: `ci` = contents:read. `review-loop` = pull-requests/issues:write. No secrets are used or stored.

Unverified (must be tested on a real PR): whether Codex honours a `@codex review` comment authored by the Actions bot; whether Codex reviews bot-created PRs.
Not automated: the fix step itself runs in a Claude Code session (desktop app CI monitor / review-comment events), not in Actions.
