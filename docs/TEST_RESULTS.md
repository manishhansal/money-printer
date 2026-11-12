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
