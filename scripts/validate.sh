#!/bin/bash
# validate.sh — full validation run: TypeScript + ESLint + All Tests + Builds
#
# CORRECTNESS CONTRACT:
#   - Every underlying command's exit code is captured independently.
#   - Piping through head/tail/grep is NEVER used to determine pass/fail.
#   - Output is captured to temp files so summaries can be printed after
#     the exit code is safely stored.
#   - Returns non-zero if ANY mandatory check fails.
#
# Usage: npm run validate  OR  bash scripts/validate.sh

set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
PASS=0
TMPDIR_LOCAL=$(mktemp -d)
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

section() { echo ""; echo "══════════ $1 ══════════"; }
ok()      { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail()    { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "🔬 MoneyPrinter Full Validation — $(date)"

# ─────────────────────────────────────────────────────────────────────────────
# 1. TypeScript Type Check
# ─────────────────────────────────────────────────────────────────────────────
section "1. TypeScript Type Check"
TSC_OUT="$TMPDIR_LOCAL/tsc.log"
npx tsc --noEmit 2>&1 > "$TSC_OUT"; TSC_EXIT=$?
head -30 "$TSC_OUT"
if [ "$TSC_EXIT" -eq 0 ]; then
  ok "TypeScript: no errors"
else
  fail "TypeScript: errors found (exit code $TSC_EXIT)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. ESLint
# ─────────────────────────────────────────────────────────────────────────────
section "2. ESLint"
ESLINT_OUT="$TMPDIR_LOCAL/eslint.log"
npx eslint "src/**/*.ts" --max-warnings 0 2>&1 > "$ESLINT_OUT"; ESLINT_EXIT=$?
tail -20 "$ESLINT_OUT"
if [ "$ESLINT_EXIT" -eq 0 ]; then
  ok "ESLint: no violations"
else
  fail "ESLint: violations found (exit code $ESLINT_EXIT — see above)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Backend Unit/Integration Tests
#    --forceExit prevents open-handle hangs (DB/Redis clients in test setups).
#    --testTimeout=10000 catches genuinely slow or hanging individual tests.
# ─────────────────────────────────────────────────────────────────────────────
section "3. Backend Tests"
JEST_OUT="$TMPDIR_LOCAL/jest.log"
npx jest --runInBand --no-coverage --forceExit --testTimeout=10000 2>&1 > "$JEST_OUT"; JEST_EXIT=$?
# Print summary (last 15 lines always contains suite/test counts)
tail -15 "$JEST_OUT"
if [ "$JEST_EXIT" -eq 0 ]; then
  PASSED_LINE=$(grep -E "Tests:.*passed" "$JEST_OUT" | tail -1)
  ok "Tests: ${PASSED_LINE:-all passed}"
else
  # Print first 40 lines to show failures
  echo "--- Test failures (first 40 lines) ---"
  head -40 "$JEST_OUT"
  fail "Tests: failures detected (exit code $JEST_EXIT)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Chrome Extension Tests
# ─────────────────────────────────────────────────────────────────────────────
section "4. Extension Tests"
EXT_OUT="$TMPDIR_LOCAL/ext-jest.log"
npx jest --config ./extension/jest.config.js --runInBand --no-coverage --forceExit 2>&1 > "$EXT_OUT"; EXT_EXIT=$?
tail -8 "$EXT_OUT"
if [ "$EXT_EXIT" -eq 0 ]; then
  EXT_LINE=$(grep -E "Tests:.*passed" "$EXT_OUT" | tail -1)
  ok "Extension tests: ${EXT_LINE:-passed}"
else
  head -20 "$EXT_OUT"
  fail "Extension tests: failures (exit code $EXT_EXIT)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Backend Build
# ─────────────────────────────────────────────────────────────────────────────
section "5. Backend Build"
BUILD_OUT="$TMPDIR_LOCAL/build.log"
npx nest build 2>&1 > "$BUILD_OUT"; BUILD_EXIT=$?
tail -10 "$BUILD_OUT"
if [ "$BUILD_EXIT" -eq 0 ]; then
  ok "Backend build: success"
else
  head -20 "$BUILD_OUT"
  fail "Backend build: failed (exit code $BUILD_EXIT)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Frontend Build
# ─────────────────────────────────────────────────────────────────────────────
section "6. Frontend Build"
FE_OUT="$TMPDIR_LOCAL/frontend.log"
node build-frontend.mjs 2>&1 > "$FE_OUT"; FE_EXIT=$?
tail -8 "$FE_OUT"
if [ "$FE_EXIT" -eq 0 ]; then
  ok "Frontend build: success"
else
  head -20 "$FE_OUT"
  fail "Frontend build: failed (exit code $FE_EXIT)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo "  Result: ${PASS} passed, ${FAIL} failed"
echo ""

[ "$FAIL" -eq 0 ]
