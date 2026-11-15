#!/bin/bash
# Phase 14: the Firefox and WebKit end-to-end runs, from a clean state, on the owner's Mac (these browsers can't run
# in the cloud workspace). Copies the project to a temporary folder (no node_modules, results or git), installs from
# the lockfile, and runs each browser twice. Your real tracker and data are never touched: every test page sends
# tracker requests to a reserved fake host, and any test that reaches port 47821 fails (tests/js/fixtures/tracker-guard.mjs).
# Usage, from the keel-app folder:  bash tests/run-mac-browsers.sh      Paste the block after "==== summary" back.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/keel-clean.XXXXXX)"
export NODE_ENV=development  # your shell sets production, which makes npm ci skip the test tools
export PLAYWRIGHT_BROWSERS_PATH=/Users/Shared/ms-playwright CFFIXED_USER_HOME=/Users/Shared/pw-home  # the home folder name ends in a dot
mkdir -p "$CFFIXED_USER_HOME"
rsync -a --exclude node_modules --exclude .git --exclude test-results --exclude playwright-report --exclude coverage \
  --exclude .venv --exclude '__pycache__' --exclude '*.log' "$SRC/" "$WORK/"
cd "$WORK" || exit 1
echo "clean copy: $WORK"
npm ci --include=dev --no-audit --no-fund >/dev/null 2>&1 || { echo "npm ci failed"; exit 1; }
SUM=()
for b in firefox webkit; do
  for r in 1 2; do
    out="$(npx playwright test --project="$b" --reporter=line 2>&1)"
    line="$(echo "$out" | grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)' | tr -s ' ' | tr '\n' ' ')"
    SUM+=("$b run $r: ${line:-no result}")
    echo "$out" | grep -E '✘|\) \[' | head -20
  done
done
echo "==== summary ($(sw_vers -productName) $(sw_vers -productVersion), $(npx playwright --version))"
printf '%s\n' "${SUM[@]}"
echo "(the clean copy is left at $WORK; you can delete it)"
