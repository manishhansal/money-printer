#!/bin/bash
# health-check.sh — quick health check for MoneyPrinter local environment
#
# Usage: npm run health  OR  bash scripts/health-check.sh

set -euo pipefail

PORT="${PORT:-3002}"
PASS=0
FAIL=0

check() {
  local name="$1"
  local result="$2"
  if [ "$result" = "ok" ]; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name: $result"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "🔍 MoneyPrinter Health Check — $(date '+%H:%M:%S %Z')"
echo "─────────────────────────────────────────────"

# 1. Backend
BE_STATUS=$(curl -s --max-time 3 "http://localhost:${PORT}/" 2>/dev/null)
if [ -n "$BE_STATUS" ]; then
  check "Backend (port ${PORT})" "ok"
else
  check "Backend (port ${PORT})" "not responding"
fi

# 2. Health endpoint
HEALTH=$(curl -s --max-time 3 "http://localhost:${PORT}/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  PG=$(echo "$HEALTH" | grep -o '"postgresql_connection":{"status":"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  RD=$(echo "$HEALTH" | grep -o '"redis_availability":{"status":"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  DA=$(echo "$HEALTH" | grep -o '"dhan_api_connectivity":{"status":"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  check "PostgreSQL" "${PG:-unknown}"
  check "Redis" "${RD:-unknown}"
  check "Dhan API" "${DA:-unknown}"
else
  check "Health endpoint" "not reachable or degraded"
  check "PostgreSQL" "unknown (server down)"
  check "Redis" "unknown (server down)"
  check "Dhan API" "unknown (server down)"
fi

# 3. Docker containers
if command -v docker &>/dev/null; then
  PG_RUNNING=$(docker ps --filter "name=postgres" --filter "status=running" -q 2>/dev/null | wc -l | tr -d ' ')
  RD_RUNNING=$(docker ps --filter "name=redis" --filter "status=running" -q 2>/dev/null | wc -l | tr -d ' ')
  check "Docker PG container" "$([ "$PG_RUNNING" -gt 0 ] && echo ok || echo not running)"
  check "Docker Redis container" "$([ "$RD_RUNNING" -gt 0 ] && echo ok || echo not running)"
fi

# 4. Watchdog issues
ISSUES=$(curl -s --max-time 2 "http://localhost:${PORT}/watchdog/issues/counts" 2>/dev/null)
if [ -n "$ISSUES" ]; then
  P0=$(echo "$ISSUES" | grep -o '"P0":[0-9]*' | grep -o '[0-9]*')
  P1=$(echo "$ISSUES" | grep -o '"P1":[0-9]*' | grep -o '[0-9]*')
  P2=$(echo "$ISSUES" | grep -o '"P2":[0-9]*' | grep -o '[0-9]*')
  P3=$(echo "$ISSUES" | grep -o '"P3":[0-9]*' | grep -o '[0-9]*')
  TOTAL=$((${P0:-0} + ${P1:-0} + ${P2:-0} + ${P3:-0}))
  if [ "${P0:-0}" -gt 0 ]; then
    check "Watchdog issues" "P0=${P0} P1=${P1:-0} P2=${P2:-0} P3=${P3:-0} — CRITICAL"
    FAIL=$((FAIL + 1))
    PASS=$((PASS - 1))
  else
    check "Watchdog issues" "$([ "$TOTAL" -eq 0 ] && echo ok || echo "P0=0 P1=${P1:-0} P2=${P2:-0} P3=${P3:-0}")"
  fi
else
  echo "  ⚪ Watchdog issues: server not running"
fi

echo "─────────────────────────────────────────────"
echo "  Result: ${PASS} OK, ${FAIL} FAILED"
echo ""

[ "$FAIL" -eq 0 ]
