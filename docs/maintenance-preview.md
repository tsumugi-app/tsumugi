# Viewing the maintenance panel on a Vercel Preview (never production)

## Why `/maintenance/repair` shows "Not Found"
By design (`src/lib/maintenance/auth.ts`, enforced twice: `src/proxy.ts` and the page itself) the area answers 404 to everybody unless the deployment has
`MAINTENANCE_ENABLED` exactly `1` **and** a non-empty `MAINTENANCE_BASIC_PASSWORD`. A Preview without those variables is therefore a 404, even for a correctly
authenticated request. The route itself exists (`src/app/maintenance/repair/page.tsx`).

## One-time setup (owner, in the Vercel dashboard; the code never sets these)
Project -> Settings -> Environment Variables, add three variables:

| name | value | environments |
|---|---|---|
| `MAINTENANCE_ENABLED` | `1` | **Preview only**, Git branch `claude/storage-safety` |
| `MAINTENANCE_BASIC_USER` | any name (default `maintenance` if the variable is absent) | Preview only, same branch |
| `MAINTENANCE_BASIC_PASSWORD` | a new random password used nowhere else (mark it Sensitive) | Preview only, same branch |

Do NOT tick Production or Development. Enabling these in Production would switch the repair area on for the live site; that is a separate decision.
Variables apply to NEW deployments: redeploy the branch afterwards (Deployments -> the latest `claude/storage-safety` one -> Redeploy, or push a commit).

## Opening it
1. Open the Preview URL of the branch while logged in to Vercel (Preview deployments are behind Vercel login).
2. Go to `/maintenance/repair`. The browser asks for the Basic user/password set above.
3. The Preview is its own origin: its IndexedDB is empty and it has no access to the production site's data. Nothing real can be read or changed there.

## What can be checked on the Preview
Screens, wording, buttons, the file pickers and permission prompts (Vault copy folder, restore-point download and read-back), tab behaviour.
Load `docs/demo/fictional-repair-data.json` (fictional data) as the repair data. The Preview database holds no matching records, so the pre-check reports the items as HOLD and a
repair is refused before any write; that refusal path and the messages are part of what is being looked at. The full repair pipeline on dummy records is covered by the automated tests.

## Read-only test of step 6 ("Repair pre-check") with fictional files
Both files are fictional and contain nothing from real data:
- repair data: `docs/demo/fictional-repair-data.json` (8 repair items R1-R8, 9 backfill items B1-B9; the same data the automated tests use)
- decision list: `docs/demo/fictional-decisions.json` (`{"format":"tsumugi-repair-decisions","schema":1,"held":["R7"],"excluded":["B1","B2"]}`)

Download them from the branch (right-click -> save as, or "Download raw file"):
- https://raw.githubusercontent.com/tsumugi-app/tsumugi/claude/storage-safety/docs/demo/fictional-repair-data.json
- https://raw.githubusercontent.com/tsumugi-app/tsumugi/claude/storage-safety/docs/demo/fictional-decisions.json

In the panel, step 6: "repair data" -> choose the first file; "decision list" -> choose the second. The line "decision list: loaded (held 1, excluded 2)" appears and
"Scan all items (read-only)" becomes enabled. Scan reads IndexedDB only (the Preview's own, empty one), so every item is reported as not READY and nothing is selectable;
that is expected here. A key that is not in the repair data is rejected on purpose (try editing a key in the decision list to see the message).
