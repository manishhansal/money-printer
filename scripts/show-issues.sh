#!/bin/bash
# show-issues.sh — display open MoneyPrinter watchdog issues
#
# Usage: npm run issues  OR  bash scripts/show-issues.sh

PORT="${PORT:-3002}"

echo ""
echo "📋 MoneyPrinter Open Issues — $(date '+%H:%M:%S %Z')"
echo "─────────────────────────────────────────────"

# Try the watchdog REST API first
ISSUES=$(curl -s --max-time 3 "http://localhost:${PORT}/watchdog/issues?limit=20" 2>/dev/null)

if [ -z "$ISSUES" ] || ! echo "$ISSUES" | grep -q '\['; then
  echo "  ⚠ Server not running — querying database directly..."
  
  # Fallback: query DB directly
  if command -v psql &>/dev/null && [ -n "${DATABASE_URL:-}" ]; then
    psql "$DATABASE_URL" -c "
      SELECT severity, status, title, source, first_detected_at::date as date
      FROM monitoring_issues
      WHERE status NOT IN ('RESOLVED','WONT_FIX_WITH_REASON')
      ORDER BY severity, first_detected_at DESC
      LIMIT 20;
    " 2>/dev/null || echo "  Could not connect to database"
  else
    echo "  DATABASE_URL not set or psql not available"
    echo "  Start the server with: npm run dev:all"
  fi
  echo ""
  exit 0
fi

# Parse and display the JSON
echo "$ISSUES" | python3 -c "
import json, sys
try:
    issues = json.load(sys.stdin)
    if not issues:
        print('  ✅ No open issues found')
        sys.exit(0)
    
    severity_colors = {'P0': '🔴', 'P1': '🟠', 'P2': '🟡', 'P3': '🔵'}
    
    for issue in issues:
        sev = issue.get('severity', '?')
        icon = severity_colors.get(sev, '⚪')
        print(f\"{icon} [{sev}] {issue.get('title','?')}\")
        print(f\"     Status: {issue.get('status','?')} | Module: {issue.get('affectedModule') or 'N/A'}\")
        print(f\"     Key: {issue.get('issueKey','?')}\")
        if issue.get('affectsLiveTrading'):
            print(f\"     ⚠ AFFECTS LIVE TRADING\")
        print()
except Exception as e:
    print(f'  Error parsing response: {e}')
" 2>/dev/null || echo "$ISSUES" | head -20

echo "─────────────────────────────────────────────"
COUNTS=$(curl -s --max-time 2 "http://localhost:${PORT}/watchdog/issues/counts" 2>/dev/null)
echo "  Counts: $COUNTS"
echo ""
