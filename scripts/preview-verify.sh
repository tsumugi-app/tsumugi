#!/bin/sh
# Preview verification build. Used ONLY by vercel.json on the Preview verification branch; it is not part of the production commit,
# so the production build path (npm run build) is unchanged.
if [ -z "$VERCEL_ENV" ] || [ -z "$VERCEL" ]; then
  echo "[preview-verify] FAIL: VERCEL_ENV/VERCEL not set, tests would not run" >&2
  exit 1
fi
if [ "$VERCEL_ENV" != "preview" ]; then
  echo "[preview-verify] VERCEL_ENV=$VERCEL_ENV: tests skipped, build only"
  exec npm run build
fi
echo "[preview-verify] START test:maintenance"
npm run test:maintenance || { echo "[preview-verify] FAIL: test:maintenance" >&2; exit 1; }
echo "[preview-verify] PASSED test:maintenance"
exec npm run build
