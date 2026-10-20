# Development flow (Claude Code)
1. Investigate, implement and test on a `claude/*` branch. Never merge to main, deploy to production, or touch production data.
2. Push; the PR is opened (by the owner or an authorised tool). CI (`ci`) must pass.
3. Codex reviews automatically. Read its reviews/inline comments ([P0]/[P1]/[P2]); fix valid findings and push (max 2 fix rounds per PR).
4. Each push triggers `review-loop` (re-review request + 25 min timeout). On `needs-human` or the round limit, stop and report.
5. Report only the final result. See docs/auto-review-flow.md.
