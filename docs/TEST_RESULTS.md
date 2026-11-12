# Test Results

**Date:** 2026-11-11 (Final)  
**Baseline:** 1,442 tests (before all remediation)  
**Final:** 1,489 tests (all passing)

---

## Test Count History

| Phase | Tests Added | Total | Status |
|-------|------------|-------|--------|
| Baseline | — | 1,442 | All pass |
| Phase 1 (lot-size) | +9 invariant tests | 1,451 | All pass |
| Phase 4 (session timing) | +5 boundary tests | 1,456 | All pass |
| Phase 10 (holiday calendar) | +3 holiday tests | 1,459 | All pass |
| Phase 6 (SniperEntry) | +19 filter tests | 1,478 | All pass |
| Phase 7 (TargetAndRunner) | +23 lifecycle tests | 1,489 | All pass |
| Final | — | **1,489** | **All pass** ✅ |

---

## New Tests by Service

### SniperEntryService (19 tests)
- Filter 1 (Min LTP): rejects below ₹5, accepts above, rejects ₹0
- Filter 2 (Spread): rejects >8% spread, accepts 1% spread
- Filter 4 (Freshness): rejects >10s stale, accepts fresh
- Filter 5 (Relative volume): rejects <80% of ADV, accepts ≥80%
- Filter 7 (VWAP momentum): bonus for aligned direction, penalty for conflicting
- Filter 8 (IV sanity): rejects >200% and <1%, accepts normal 20%
- Quality score: 0 when ineligible, positive when eligible
- computeOpportunityScore: 0 ineligible, positive eligible
- Multiple simultaneous failures: all failing filters reported

### TargetAndRunnerService (23 tests)
- ENTRY phase: HOLD below target, FULL_EXIT on SL hit, TARGET1_REACHED on target hit
- Target 1 evaluation: FULL_EXIT when <2/3 conditions, ACTIVATE_RUNNER when ≥2/3
- Lot-aware partial exit: exitUnits % lotSize === 0 always
- Single lot: FULL_EXIT (no invalid fractional partial)
- Break-even SL: newStopLoss = entry price on RUNNER activation
- RUNNER phase: HOLD when SL not hit, FULL_EXIT on SL hit
- Greedy trail failure: defaults to FULL_EXIT

### Session Phase Boundary Tests (5 tests)
- 14:30 IST → AFTERNOON_LATE (not CLOSING)
- 14:59 IST → AFTERNOON_LATE
- 15:00 IST → CLOSING
- Full trading day sequence updated
- isWithinMarketHours returns true for AFTERNOON_LATE

### NSE Holiday Tests (3 tests)
- Republic Day 2026 (2026-01-26) → MARKET_CLOSED during market hours
- Diwali 2026 (2026-11-08) → MARKET_CLOSED during market hours
- Regular Wednesday (2026-11-11) → MID_SESSION

### Lot-Size Invariant Tests (9 tests)
- Zero/negative quantity rejected
- Lots-as-units bug (1 unit with lotSize=75) rejected
- 1 lot × 75 = 75 units accepted
- 2 lots × 75 = 150 units accepted
- Property invariant: quantity % lotSize === 0 always
- DB stores UNITS not lots

---

## Test Gaps (Known Missing, Acceptable)

| Service | Missing Test | Priority |
|---------|-------------|----------|
| OrderStatusPollerService | Mock FILLED/REJECTED detection | P3 |
| DhanTokenWatcherService | Mock token age expiry alerts | P3 |
| InstrumentMasterService | Mock CSV download and upsert | P3 |
| mandatorySquareOff with Dhan reconciliation | Integration test | P2 |
| 15:28 cron critical alert | Mock open positions at 15:28 | P2 |

## Updated Test Count History (Session 4 — 2026-11-12)

| Phase | Tests Added | Total | Status |
|-------|------------|-------|--------|
| Baseline | — | 1,442 | All pass |
| Phase 1 (lot-size) | +9 invariant tests | 1,451 | All pass |
| Phase 4 (session timing) | +5 boundary tests | 1,456 | All pass |
| Phase 10 (holiday calendar) | +3 holiday tests | 1,459 | All pass |
| Phase 6 (SniperEntry) | +19 filter tests | 1,478 | All pass |
| Phase 7 (TargetAndRunner) | +23 lifecycle tests | 1,489 | All pass |
| Session 3 final | — | 1,489 | All pass |
| Session 8 audit baseline | — | 1,535 | All pass |
| Session 4 remediation | +56 tests (3 new spec files + position-monitoring update) | **1,591** | **All pass** ✅ |

## Session 4 New Tests (commit `c636d0d`)

### signal-scanner.service.spec.ts (22 tests)

- Engine selection — `engine: 'LIVE'` when ARMED (DEFECT-001 regression)
- Engine selection — `engine: 'PAPER'` when DISARMED
- Engine selection — never `'LIVE'` when `isArmed()` false
- Engine selection — transitions correctly as arm state changes
- Scan skips on CLOSING phase
- Scan skips on EOD_RECONCILIATION phase
- Scan proceeds on MORNING_MOMENTUM (Redis keys queried)
- Scan warns and returns when no snapshots in Redis
- `isEligible()` returns false when SniperEntryService rejects
- `isEligible()` returns true when SniperEntryService approves
- `computeComponentScores` STRONG_BULL → regimeAlignment=15
- `computeComponentScores` STRONG_BEAR → regimeAlignment=4
- `computeComponentScores` momentum=8 (DEFECT-003 documented)
- `computeComponentScores` vwapTrendAlignment=8 (DEFECT-003 documented)
- `computeComponentScores` priceStructure=12 when bid+ask present
- `computeComponentScores` priceStructure=10 when bid/ask null
- `computeComponentScores` volumeConfirmation=13 when volume>100
- `computeComponentScores` volumeConfirmation=10 when 0<volume≤100
- `computeComponentScores` volumeConfirmation=7 when volume=0
- `computeComponentScores` rrQuality=10 when R:R≥2.0
- `computeComponentScores` rrQuality=8 when 1.5≤R:R<2.0
- `computeComponentScores` rrQuality=5 when R:R<1.5

### signal-dispatcher.service.spec.ts (18 tests)

- Routes to paper when payload.engine=PAPER
- Routes to live when payload.engine=LIVE and ARMED
- Does NOT route to live when engine=PAPER even if ARMED
- Does NOT route to paper when engine=LIVE
- Skips BUY when open LONG paper position already exists
- Proceeds BUY when no existing LONG paper position
- Rejects paper dispatch when instrument not found
- Rejects paper dispatch when lotSize=0
- Converts 1 lot × 75 (NIFTY) = 75 units on paper path
- Converts 2 lots × 25 (FINNIFTY) = 50 units on paper path
- Skips live dispatch when engine not ARMED
- Skips live dispatch when new entries blocked
- Rejects live dispatch when instrument not found
- Rejects live dispatch when lotSize=0
- Converts 3 lots × 50 = 150 units on live path
- Passes requiredMargin derived from portfolio capital
- Silently ignores payload that fails type-guard check
- Processes valid PAPER payload with all required fields

### agent-orchestrator.service.spec.ts (16 tests)

- Returns ResearchDecision when LLM disabled
- ResearchDecision has all required structural fields
- portfolioManager never null
- workflowId is UUID
- completedAt at or after snapshotAt
- timedOutAgents=0 with rule-based fallback
- At least one analyst BULLISH when LTP>VWAP and MACD BULLISH
- At least one analyst BEARISH when LTP<VWAP and MACD BEARISH
- At least one analyst HIGH confidence when all 4 bullish signals align
- At least one analyst LOW confidence when signals mixed (bull=2, bear=2)
- portfolioManager.finalVerdict is EXECUTE|SKIP|PAPER_ONLY
- portfolioManager.verdictReason is non-empty string
- ResearchDecision has no broker order fields (advisory only)
- Workflow completes without throwing on LlmUnavailableError
- Workflow completes without throwing when every call times out
- Verdict structurally valid in bearish/high-vix context
