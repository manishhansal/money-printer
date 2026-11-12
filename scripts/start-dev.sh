#!/bin/bash
# start-dev.sh
#
# MoneyPrinter development server startup script.
#
# Ensures the server is running BEFORE 09:15 AM IST so the instrument
# discovery cron fires and subscribes NIFTY/BANKNIFTY options to the feed.
#
# Usage:
#   ./scripts/start-dev.sh          # start in foreground
#   ./scripts/start-dev.sh &        # start in background
#
# To auto-start on macOS login, install the launchd plist:
#   cp scripts/com.moneyprinter.dev.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.moneyprinter.dev.plist

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== MoneyPrinter startup at $(date) ==="
echo "Project: $PROJECT_DIR"
cd "$PROJECT_DIR"

# ── 1. Ensure Docker containers are running ──────────────────────────────────
echo "[startup] Checking Docker containers..."
docker compose up -d 2>&1 | tail -3

# ── 2. Wait for PostgreSQL to be healthy ─────────────────────────────────────
echo "[startup] Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U moneyprinter -d moneyprinter >/dev/null 2>&1; then
    echo "[startup] PostgreSQL ready"
    break
  fi
  sleep 1
done

# ── 3. Wait for Redis to be healthy ──────────────────────────────────────────
echo "[startup] Waiting for Redis..."
for i in $(seq 1 30); do
  if docker compose exec -T redis redis-cli ping >/dev/null 2>&1; then
    echo "[startup] Redis ready"
    break
  fi
  sleep 1
done

# ── 4. Run pending migrations ─────────────────────────────────────────────────
echo "[startup] Running migrations..."
npm run migration:run 2>&1 | tail -3

# ── 5. Build frontend ────────────────────────────────────────────────────────
echo "[startup] Building frontend..."
npm run build:frontend 2>&1 | tail -2

# ── 6. Start NestJS dev server ───────────────────────────────────────────────
echo "[startup] Starting CloudEngine on port 3002..."
exec npm run start:dev
