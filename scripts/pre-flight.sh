#!/bin/bash
# pre-flight.sh — validate environment before starting MoneyPrinter
#
# Checks: required env vars, Docker containers, DB connectivity, Redis connectivity
# Exits with code 1 if any CRITICAL check fails.
#
# Usage: npm run preflight  OR  bash scripts/pre-flight.sh

set -uo pipefail

FAIL=0
WARN=0

RED='\033[0;31m'
YLW='\033[1;33m'
GRN='\033[0;32m'
RST='\033[0m'

critical() { echo -e "${RED}  ❌ CRITICAL: $1${RST}"; FAIL=$((FAIL+1)); }
warn()     { echo -e "${YLW}  ⚠  WARNING:  $1${RST}"; WARN=$((WARN+1)); }
ok()       { echo -e "${GRN}  ✅ OK:        $1${RST}"; }

# Load .env if it exists
[ -f .env ] && set -a && source .env && set +a 2>/dev/null || true

echo ""
echo "✈  MoneyPrinter Pre-flight Checks — $(date)"
echo "════════════════════════════════════════════"

echo ""
echo "1. Required environment variables"
[ -n "${DATABASE_URL:-}" ]    && ok "DATABASE_URL"      || critical "DATABASE_URL is not set"
[ -n "${REDIS_HOST:-}${REDIS_URL:-}" ] && ok "REDIS_HOST/REDIS_URL" || critical "REDIS_HOST or REDIS_URL is not set"
[ -n "${ENCRYPTION_KEY:-}" ]  && ok "ENCRYPTION_KEY"    || critical "ENCRYPTION_KEY is not set"
[ -n "${JWT_PRIVATE_KEY:-}" ] && ok "JWT_PRIVATE_KEY"   || critical "JWT_PRIVATE_KEY is not set"

echo ""
echo "2. Live trading credentials (optional for paper mode)"
[ -n "${DHAN_SESSION_TOKEN:-}" ] && ok "DHAN_SESSION_TOKEN set" || warn "DHAN_SESSION_TOKEN not set — live trading unavailable"
[ -n "${DHAN_CLIENT_ID:-}" ]     && ok "DHAN_CLIENT_ID set"     || warn "DHAN_CLIENT_ID not set — live trading unavailable"
[ -n "${DAILY_LOSS_LIMIT_RUPEES:-}" ] && ok "DAILY_LOSS_LIMIT_RUPEES=${DAILY_LOSS_LIMIT_RUPEES}" || warn "DAILY_LOSS_LIMIT_RUPEES not set (default will apply)"

echo ""
echo "3. Docker containers"
if command -v docker &>/dev/null; then
  PG=$(docker ps --filter "name=postgres" --filter "status=running" -q 2>/dev/null | wc -l | tr -d ' ')
  RD=$(docker ps --filter "name=redis" --filter "status=running" -q 2>/dev/null | wc -l | tr -d ' ')
  [ "$PG" -gt 0 ] && ok "PostgreSQL container running" || { warn "PostgreSQL container not running — starting..."; docker compose up -d postgres 2>/dev/null || critical "Failed to start PostgreSQL"; }
  [ "$RD" -gt 0 ] && ok "Redis container running" || { warn "Redis container not running — starting..."; docker compose up -d redis 2>/dev/null || critical "Failed to start Redis"; }
else
  warn "Docker not found — ensure PostgreSQL and Redis are running externally"
fi

echo ""
echo "4. Database connectivity"
if [ -n "${DATABASE_URL:-}" ]; then
  if command -v psql &>/dev/null; then
    if psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1; then
      ok "PostgreSQL connection successful"
    else
      # Give Docker a few seconds to start
      sleep 3
      psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1 && ok "PostgreSQL connection successful (after retry)" || critical "Cannot connect to PostgreSQL — check DATABASE_URL"
    fi
  else
    warn "psql not found — skipping DB connectivity check"
  fi
fi

echo ""
echo "5. Redis connectivity"
if command -v redis-cli &>/dev/null; then
  REDIS_HOST_VAL="${REDIS_HOST:-localhost}"
  REDIS_PORT_VAL="${REDIS_PORT:-6380}"
  redis-cli -h "$REDIS_HOST_VAL" -p "$REDIS_PORT_VAL" ping >/dev/null 2>&1 && ok "Redis connection successful" || critical "Cannot connect to Redis at ${REDIS_HOST_VAL}:${REDIS_PORT_VAL}"
else
  warn "redis-cli not found — skipping Redis connectivity check"
fi

echo ""
echo "════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}  🚫 Pre-flight FAILED: ${FAIL} critical issue(s), ${WARN} warning(s)${RST}"
  echo "  Fix the issues above before starting MoneyPrinter."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo -e "${YLW}  ⚠  Pre-flight passed with ${WARN} warning(s) — paper trading available${RST}"
else
  echo -e "${GRN}  ✅ Pre-flight complete — all systems ready${RST}"
fi
echo ""
