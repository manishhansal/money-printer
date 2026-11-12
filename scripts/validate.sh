#!/bin/bash
# validate.sh — full validation run: TypeScript + ESLint + All Tests
#
# Usage: npm run validate  OR  bash scripts/validate.sh

set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
PASS=0

section() { echo ""; echo "══════════ $1 ══════════"; }
ok()      { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail()    { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "🔬 MoneyPrinter Full Validation — $(date)"

section "1. TypeScript Type Check"
if npx tsc --noEmit 2>&1 | head -20; then
  ok "TypeScript: no errors"
else
  fail "TypeScript: errors found (see above)"
fi

section "2. ESLint"
if npx eslint "src/**/*.ts" --max-warnings 0 2>&1 | tail -5; then
  ok "ESLint: no violations"
else
  fail "ESLint: violations found"
fi

section "3. Unit Tests"
TEST_OUTPUT=$(npx jest --runInBand --no-coverage 2>&1 | tail -10)
echo "$TEST_OUTPUT"
if echo "$TEST_OUTPUT" | grep -q "failed"; then
  fail "Tests: failures detected"
else
  PASSED=$(echo "$TEST_OUTPUT" | grep -o "[0-9]* passed" | head -1)
  ok "Tests: $PASSED"
fi

section "4. Extension Tests"
if npx jest --config ./extension/jest.config.js --runInBand --no-coverage 2>&1 | tail -5; then
  ok "Extension tests: passed"
else
  fail "Extension tests: failures"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  Result: ${PASS} passed, ${FAIL} failed"
echo ""

[ "$FAIL" -eq 0 ]
