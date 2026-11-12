# Risk Management Audit

**Date:** 2026-11-11

---

## Risk Architecture

```
RiskManagementService (pure computation, no DB)
    ↓ computePositionSize() → LOTS (BigInt precision)
    ↓ evaluatePreEntryGates() → 8 gates, first-failure-stops

DailyLossStateMachineService (stateful, persisted)
    ↓ NORMAL → TWO_LOSS_LOCKOUT (2nd losing trade)
    ↓ NORMAL → EMERGENCY_HALT (intraday loss ≥ limit)
    ↓ Any → KILL_SWITCH_ACTIVE (manual)
    ↓ Resets at 00:00 IST (except KILL_SWITCH)

LiveTradingService (guards execution)
    ↓ isNewEntryBlocked() checks CLOSING phase + risk state
    ↓ mandatorySquareOff() with Dhan reconciliation
    ↓ Broker P&L exit rule (belt-and-suspenders)
```

## Pre-Entry Gates (evaluatePreEntryGates)

| Gate | Description | Config | Status |
|------|-------------|--------|--------|
| 1 | SIGNAL_SCORE ≥ 80 | Hardcoded | ✅ |
| 2 | ZERO_PER_UNIT_RISK — |entry-stop| > 0 | — | ✅ |
| 3 | INVALID_LOT_SIZE > 0 | — | ✅ |
| 4 | PER_TRADE_LOSS ≤ limit | `MAX_PER_TRADE_LOSS_RUPEES` env | ✅ |
| 5 | TOTAL_EXPOSURE ≤ limit | `MAX_EXPOSURE_PCT` env | ✅ |
| 6 | CORRELATED_EXPOSURE ≤ limit | `MAX_CORRELATED_PCT` env | ✅ |
| 7 | CONCURRENT_TRADES < max | `MAX_CONCURRENT_TRADES` env | ✅ |
| 8 | CONCENTRATION ≤ limit | `MAX_CONCENTRATION_PCT` env | ✅ |

## Default Configuration

| Parameter | Default | Env Override |
|-----------|---------|-------------|
| Risk per trade | 1.00% | `RISK_PERCENTAGE_DEFAULT` |
| Max per-trade loss | ₹5,000 | `MAX_PER_TRADE_LOSS_RUPEES` |
| Max exposure | 20% | `MAX_EXPOSURE_PCT` |
| Max correlated | 10% | `MAX_CORRELATED_PCT` |
| Max concurrent | 5 | `MAX_CONCURRENT_TRADES` |
| Max concentration | 15% | `MAX_CONCENTRATION_PCT` |
| Daily loss limit | ₹10,000 | `DAILY_LOSS_LIMIT_RUPEES` |

## Post-Fix: Real Capital Wiring

Previously, all risk gate inputs in `SignalDispatcherService` were hardcoded:
- `dynamicCapital: '100000.00'` → NOW reads from `PortfolioService.getDynamicCapital('LIVE')`
- `currentTotalExposure: '0.00'` → NOW computed from open positions
- `currentCorrelatedExposure: '0.00'` → NOW computed from same-underlying positions
- `currentInstrumentExposure: '0.00'` → NOW computed from same-instrument positions
- `openPositionsCount: 0` → NOW reads `PortfolioService.getOpenPositions('LIVE').length`

## Open Issues

1. **riskPercentage still hardcoded as '1.00'** in dispatcher live path. Should load from `UserSettings.defaultRiskPercentage`.

2. **Daily loss tracking requires caller integration.** `DailyLossStateMachineService.onTradeClosed()` and `onIntradayLossUpdate()` must be called by whatever closes trades. This wiring needs to be verified in the event-wiring module.

3. **Paper risk state is separate from live.** `DailyLossStateMachineService` maintains per-engine state. Paper losses do not affect live risk limits and vice versa. ✅ Correct.
