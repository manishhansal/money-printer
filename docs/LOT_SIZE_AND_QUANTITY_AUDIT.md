# Lot-Size and Quantity Audit

**Date:** 2026-11-11  
**Status:** P0 defects remediated. Tests passing: 1,451/1,451.

---

## Summary

The core quantity bug was: `positionSize` (in lots) was forwarded directly to Dhan's `quantity` field (which requires units). For NIFTY with lot_size=75, this meant submitting 1 unit instead of 75 units — a 75× error.

---

## Data Flow After Fix

```
StrategyService → positionSize = N lots
    ↓
SignalDispatcherService
    ├── dispatchToPaper():
    │   instrument = DB lookup(instrumentId)
    │   quantityUnits = positionSize × instrument.lotSize   ← FIX
    │   PaperTradingService.submitPaperOrder({ quantity: quantityUnits, lotSize })
    │
    └── dispatchToLive():
        instrument = DB lookup(instrumentId)  (already existed)
        quantityUnits = positionSize × instrument.lotSize   ← FIX
        ExecutionService.placeOrder({ quantity: quantityUnits, lotSize })
            ↓
        Validation: quantityUnits % lotSize === 0            ← FIX
        Validation: quantityUnits > 0
            ↓
        Dhan API: quantity = quantityUnits                   ← CORRECT
        DB orders.quantity = quantityUnits                   ← CORRECT
```

---

## Quantity Semantics by Layer

| Layer | Field | Meaning | After Fix |
|-------|-------|---------|-----------|
| `signals.position_size` | LOTS | ✓ unchanged |
| `SignalAcceptedEventPayload.positionSize` | LOTS | ✓ unchanged |
| `OrderRequest.quantity` | UNITS | ✓ fixed (was ambiguous) |
| `DhanOrderRequest.quantity` | UNITS | ✓ fixed (was lots) |
| `orders.quantity` DB | UNITS | ✓ fixed (was lots) |
| `PaperOrderRequest.quantity` | UNITS | ✓ fixed (was lots) |
| `paper_orders.quantity` DB | UNITS | ✓ fixed (was lots) |
| `PaperTrade.lot_size` | ACTUAL LOT SIZE | ✓ fixed (was hardcoded 1) |

---

## Invariant

For every valid order: `quantity_units % lot_size === 0` and `quantity_units = selected_lots × lot_size`.

This invariant is now enforced in `ExecutionService.placeOrder()` before broker submission.

---

## Test Coverage

| Test | File | Status |
|------|------|--------|
| Rejects quantity=0 | execution.service.spec.ts | ✓ PASS |
| Rejects negative quantity | execution.service.spec.ts | ✓ PASS |
| Rejects 1 unit with lotSize=75 (classic lots-as-units bug) | execution.service.spec.ts | ✓ PASS |
| Accepts 75 units (1 lot × 75) | execution.service.spec.ts | ✓ PASS |
| Accepts 150 units (2 lots × 75) | execution.service.spec.ts | ✓ PASS |
| Accepts 75 units (3 lots × 25, FINNIFTY) | execution.service.spec.ts | ✓ PASS |
| Dhan API always receives units divisible by lotSize | execution.service.spec.ts | ✓ PASS |
| DB stores units not lots | execution.service.spec.ts | ✓ PASS |
| Paper trade lot_size uses actual lot size | paper-trading.service.spec.ts | ✓ PASS |

---

## Known Remaining Gaps

1. **mandatorySquareOff** in `LiveTradingService` uses `position.quantity` directly. This is correct if positions are created with units (from fills reporting units from Dhan). Requires end-to-end integration test with real position creation flow.

2. **dynamicCapital hardcoded** in `signal-dispatcher.service.ts` live path — risk engine uses `'100000.00'` instead of actual portfolio balance. Tracked as RCA P2-MED-002.

3. **Freeze quantity** not checked before order submission — large positions may exceed NSE freeze limits. Tracked for Phase 4 remediation.
