#!/bin/sh
# Preview verification build. Used ONLY by vercel.json on a verification branch; it is not part of the production commit, so the
# production build path (npm run build) is unchanged.
#
# Runs every npm test script listed in scripts/preview-suites.txt, saving each suite's FULL output to a file (the app logs a lot while the
# tests run and Vercel keeps only the last 10,000 log lines). The build log gets a short RESULT line per suite; a failing suite also prints
# its failing tests and error text (app timing lines filtered). Any failing suite fails the build AFTER all suites ran, so one run shows
# every failing suite. Only if all suites passed, a small stamp (commit, environment, per-suite counts) is written to
# public/preview-verify.txt (no test data, no log excerpts, no secrets) and `npm run build` runs.
# Optional: scripts/preview-filter.txt holds one --test-name-pattern per line; when it exists, every suite runs only the matching tests.
if [ -z "$VERCEL_ENV" ] || [ -z "$VERCEL" ]; then
  echo "[preview-verify] FAIL: VERCEL_ENV/VERCEL not set, tests would not run" >&2
  exit 1
fi
if [ "$VERCEL_ENV" != "preview" ]; then
  echo "[preview-verify] VERCEL_ENV=$VERCEL_ENV: tests skipped, build only"
  exec npm run build
fi

NOISE='^\[(VaultIO|Vault|DB)\] '
count() { grep -E "^(# |ℹ )$2 [0-9]+" "$1" | tail -n 1 | sed -E 's/[^0-9]*([0-9]+).*/\1/'; }
FILTER=""
if [ -f scripts/preview-filter.txt ]; then
  for p in $(grep -vE '^\s*(#|$)' scripts/preview-filter.txt); do FILTER="$FILTER --test-name-pattern=$p"; done
fi
SUITES=$(grep -vE '^\s*(#|$)' scripts/preview-suites.txt)
FAILED=""; SUMMARY=""
echo "[preview-verify] START (commit ${VERCEL_GIT_COMMIT_SHA:-unknown}) suites: $(echo $SUITES | tr '\n' ' ')${FILTER:+ filter:$FILTER}"
for s in $SUITES; do
  LOG="${TMPDIR:-/tmp}/preview-verify-$s.log"
  if [ -n "$FILTER" ]; then npm run "$s" -- $FILTER > "$LOG" 2>&1; else npm run "$s" > "$LOG" 2>&1; fi
  rc=$?
  T=$(count "$LOG" tests); P=$(count "$LOG" pass); F=$(count "$LOG" fail); S=$(count "$LOG" skipped); C=$(count "$LOG" cancelled); D=$(count "$LOG" todo)
  echo "[preview-verify] RESULT $s exit=$rc tests=${T:-?} pass=${P:-?} fail=${F:-?} skipped=${S:-?} cancelled=${C:-?} todo=${D:-?}"
  SUMMARY="$SUMMARY
$s: exit=$rc tests=${T:-?} pass=${P:-?} fail=${F:-?} skipped=${S:-?} cancelled=${C:-?} todo=${D:-?}"
  why=""
  if [ "$rc" -ne 0 ]; then why="exit code $rc"
  elif [ -z "$T" ] || [ -z "$P" ] || [ -z "$F" ] || [ -z "$S" ] || [ -z "$C" ] || [ -z "$D" ]; then why="summary incomplete"
  elif [ "$T" -le 0 ] || [ "$P" -le 0 ]; then why="no passing tests"
  elif [ "$F" -ne 0 ]; then why="fail=$F"
  elif [ "$C" -ne 0 ]; then why="cancelled=$C"
  elif [ $((P + S + D)) -ne "$T" ]; then why="pass+skipped+todo != tests"
  fi
  if [ -n "$why" ]; then
    FAILED="$FAILED $s"
    echo "[preview-verify] FAIL $s ($why)" >&2
    grep -E "^([[:space:]]*not ok|✖)" "$LOG" | head -n 30 >&2
    grep -vE "$NOISE" "$LOG" | tail -n 120 >&2
  fi
done
if [ -n "$FAILED" ]; then
  echo "[preview-verify] FAILED SUITES:$FAILED" >&2
  exit 1
fi
echo "[preview-verify] PASSED all suites"
mkdir -p public
{
  echo "preview-verify: PASSED all suites"
  echo "commit: ${VERCEL_GIT_COMMIT_SHA:-unknown}"
  echo "branch: ${VERCEL_GIT_COMMIT_REF:-unknown}"
  echo "vercel_env: $VERCEL_ENV"
  echo "node: $(node --version 2>/dev/null || echo unknown)"
  echo "generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "suites:$SUMMARY"
} > public/preview-verify.txt
exec npm run build
