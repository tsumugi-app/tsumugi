#!/bin/sh
# Preview verification build. Used ONLY by vercel.json on the Preview verification branch; it is not part of the production commit,
# so the production build path (npm run build) is unchanged.
#
# In a Preview build it runs `npm run test:maintenance` with the FULL output saved to a file (the app logs a lot while the tests run, and
# Vercel keeps only the last 10,000 log lines). The build log gets only a short result block; a failure prints the failing tests and the
# error text (with the app's own [VaultIO]/[Vault]/[DB] timing lines filtered out) and stops the build. Only after the tests passed, a
# small stamp (commit, environment, counts incl. skipped) is written to public/preview-verify.txt, so the result can be read at <preview-url>/preview-verify.txt.
# The stamp holds no test data, no log excerpts and no secrets.
if [ -z "$VERCEL_ENV" ] || [ -z "$VERCEL" ]; then
  echo "[preview-verify] FAIL: VERCEL_ENV/VERCEL not set, tests would not run" >&2
  exit 1
fi
if [ "$VERCEL_ENV" != "preview" ]; then
  echo "[preview-verify] VERCEL_ENV=$VERCEL_ENV: tests skipped, build only"
  exec npm run build
fi

LOG="${TMPDIR:-/tmp}/preview-verify-test.log"
NOISE='^\[(VaultIO|Vault|DB)\] '
# The only test allowed to be skipped here: the maintenanceBoundary test that compares the working tree with git HEAD (a Vercel build has no
# git history, so it is skipped THERE by design). Any other skip, any failure, any cancelled test and any todo test fails the build.
EXPECTED_SKIPPED_MAX=1
echo "[preview-verify] START test:maintenance (commit ${VERCEL_GIT_COMMIT_SHA:-unknown})"
npm run test:maintenance > "$LOG" 2>&1
rc=$?

# `node --test` prints its totals as "# tests N" (TAP) or "ℹ tests N" (spec); read whichever is there.
count() { grep -E "^(# |ℹ )$1 [0-9]+" "$LOG" | tail -n 1 | sed -E 's/[^0-9]*([0-9]+).*/\1/'; }
TESTS=$(count tests); PASS=$(count pass); FAIL=$(count fail); SKIPPED=$(count skipped); CANCELLED=$(count cancelled); TODO=$(count todo)
echo "[preview-verify] RESULT exit=$rc tests=${TESTS:-?} pass=${PASS:-?} fail=${FAIL:-?} skipped=${SKIPPED:-?} cancelled=${CANCELLED:-?} todo=${TODO:-?}"
echo "[preview-verify] test files:"
grep -E "^(ok|not ok|✔|✖) .*\.test\.js" "$LOG" | head -n 20

ok=1
if [ "$rc" -ne 0 ]; then ok=0; why="exit code $rc"; fi
if [ "$ok" -eq 1 ] && { [ -z "$TESTS" ] || [ -z "$PASS" ] || [ -z "$FAIL" ] || [ -z "$SKIPPED" ] || [ -z "$CANCELLED" ] || [ -z "$TODO" ]; }; then ok=0; why="summary incomplete (a missing count is a failure)"; fi
if [ "$ok" -eq 1 ] && [ "$TESTS" -le 0 ]; then ok=0; why="no tests ran"; fi
if [ "$ok" -eq 1 ] && [ "$PASS" -le 0 ]; then ok=0; why="no test passed"; fi
if [ "$ok" -eq 1 ] && [ "$FAIL" -ne 0 ]; then ok=0; why="fail=$FAIL"; fi
if [ "$ok" -eq 1 ] && [ "$CANCELLED" -ne 0 ]; then ok=0; why="cancelled=$CANCELLED"; fi
if [ "$ok" -eq 1 ] && [ "$TODO" -ne 0 ]; then ok=0; why="todo=$TODO (must be 0)"; fi
if [ "$ok" -eq 1 ] && [ $((PASS + SKIPPED + TODO)) -ne "$TESTS" ]; then ok=0; why="pass+skipped+todo != tests"; fi
if [ "$ok" -eq 1 ] && [ "$SKIPPED" -gt "$EXPECTED_SKIPPED_MAX" ]; then ok=0; why="unexpected skips: skipped=$SKIPPED (allowed: $EXPECTED_SKIPPED_MAX)"; fi
if [ "$ok" -ne 1 ]; then
  echo "[preview-verify] FAIL: test:maintenance ($why)" >&2
  echo "[preview-verify] failing tests:" >&2
  grep -E "^([[:space:]]*not ok|✖)" "$LOG" | head -n 40 >&2
  echo "[preview-verify] error text (app timing lines filtered, last 250 lines):" >&2
  grep -vE "$NOISE" "$LOG" | tail -n 250 >&2
  echo "[preview-verify] FAIL: stopping before next build" >&2
  exit 1
fi
echo "[preview-verify] PASSED test:maintenance"

mkdir -p public
{
  echo "preview-verify: PASSED test:maintenance"
  echo "commit: ${VERCEL_GIT_COMMIT_SHA:-unknown}"
  echo "branch: ${VERCEL_GIT_COMMIT_REF:-unknown}"
  echo "vercel_env: $VERCEL_ENV"
  echo "node: $(node --version 2>/dev/null || echo unknown)"
  echo "platform: $(uname -sm 2>/dev/null || echo unknown)"
  echo "tests: $TESTS"
  echo "pass: $PASS"
  echo "fail: $FAIL"
  echo "skipped: $SKIPPED (allowed: $EXPECTED_SKIPPED_MAX, the git-history test that can not run in a Vercel build)"
  echo "cancelled: $CANCELLED"
  echo "todo: $TODO"
  echo "generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > public/preview-verify.txt
echo "[preview-verify] wrote public/preview-verify.txt (served at /preview-verify.txt)"
exec npm run build
