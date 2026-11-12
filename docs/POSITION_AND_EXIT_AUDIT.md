# Position and Exit Audit

**Date:** 2026-11-11

---

## Position Lifecycle

```
Entry fill event
    ↓ ExecutionService.handleFill()
    ↓ Updates orders.filled_quantity + orders.average_fill_price
    ↓ (Position creation is upstream — requires event-wiring review)
    ↓
PositionMonitoringService (polls positions)
    ↓ Updates unrealized_pnl, MFE, MAE
    ↓
TrailingStopService.computeTrailingStop()
    ↓ 8 mechanisms available (ATR, swing, Chandelier, % etc.)
    ↓ Monotonicity enforced: LONG SL never decreases
    ↓
Exit trigger (SL hit / target / time / mandatory)
    ↓ ExecutionService.placeOrder() (SELL order)
    ↓ DB position.is_open = false (after fill)
    ↓ PortfolioService.recordTradeAndUpdateCapital()
    ↓ DailyLossStateMachineService.onTradeClosed()
```

## Quantity Consistency (Post-Fix)

| Layer | Stored As | Status |
|-------|-----------|--------|
| signals.position_size | LOTS | ✅ Correctly documented |
| orders.quantity | UNITS | ✅ FIXED (was ambiguous) |
| positions.quantity | UNITS | ✅ Consistent with fills |
| paper_trades.lot_size | Actual lot size | ✅ FIXED (was hardcoded 1) |
| Dhan API quantity field | UNITS | ✅ FIXED (was sending lots) |
| Square-off exit quantity | Reconciled UNITS | ✅ FIXED (uses Dhan positions) |

## Trailing Stop Coverage

| Mechanism | Implemented | Monotonicity | Tests |
|-----------|-------------|--------------|-------|
| ATR-based | ✅ | ✅ | ✅ |
| Swing High/Low | ✅ | ✅ | ✅ |
| Chandelier Exit | ✅ | ✅ | ✅ |
| Percentage-based | ✅ | ✅ | ✅ |
| Volatility-adjusted (IV) | ✅ | ✅ | ✅ |
| Structure-based | ✅ | ✅ | ✅ |
| Time-based | ✅ | ✅ | ✅ |
| Partial-profit | ✅ | ✅ | ✅ |

## Open Issues

1. **Super Order integration incomplete.** `super-order-sl.service.ts` exists but the broker-side SL submission is not wired to `TrailingStopService`. SL orders are managed as separate regular orders, not as Super Order legs.

2. **Position creation on fill not traced end-to-end.** `ExecutionService.handleFill()` updates the Order record but does not create/update a Position. This likely happens in a separate position management service or event-wiring layer not fully audited.

3. **Exit quantity in kill switch uses DB positions.** The kill-switch path in `LiveTradingService.activateKillSwitch()` still uses `position.quantity` from DB without Dhan reconciliation. Should be aligned with the fixed `mandatorySquareOff` path.
