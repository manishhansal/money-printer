# Order Execution Audit

**Date:** 2026-11-11

---

## Execution Flow (Post-Remediation)

```
SignalAcceptedEvent
    ↓ SignalDispatcherService
    ↓ quantity = positionSize × instrument.lotSize  ← FIXED (P0-CRIT-001)
    ↓
ExecutionService.placeOrder()
    ↓ Pre-trade checks (5 gates)
    ↓ Quantity validation: quantityUnits % lotSize === 0
    ↓
    ↓ 1. ordersRepo.save(pending)   ← FIXED ORDER (P0-CRIT-002)
    ↓ 2. redisService.set(idem key)
    ↓ 3. dhanApiClient.placeOrder(quantityUnits)
    ↓ 4. ordersRepo.save(submitted + dhanOrderId)
    ↓
DhanApiClient → Dhan broker
    ↓ → Orders table: quantity in UNITS
```

## Pre-Trade Validation Chain

| Check | Gate | Description | Status |
|-------|------|-------------|--------|
| 0a | Engine armed (LIVE only) | `isArmed() === true` | ✅ |
| 0b | Entries not blocked | `isNewEntryBlocked() === false` | ✅ |
| 0 | Idempotency (Redis) | No duplicate key | ✅ |
| 1 | Composite score ≥ 80 | Signal quality gate | ✅ |
| 2 | Risk engine | 8-gate pre-entry evaluation | ✅ |
| 3 | Margin | `availabelBalance ≥ requiredMargin` | ✅ |
| 4 | Duplicate order | No pending order same instrument+direction | ✅ |
| 5 | Session timing | Phase in ACTIVE_TRADING_PHASES | ✅ |
| NEW | Quantity invariant | `quantityUnits > 0 && quantityUnits % lotSize === 0` | ✅ ADDED |

## Active Trading Phases (Post-Fix)

```
OPENING_VOLATILITY  09:15–09:20  ✅ Entries allowed
ORB_FORMATION       09:20–09:30  ✅ Entries allowed
MORNING_MOMENTUM    09:30–11:00  ✅ Entries allowed
MID_SESSION         11:00–13:00  ✅ Entries allowed
AFTERNOON           13:00–14:30  ✅ Entries allowed
AFTERNOON_LATE      14:30–15:00  ✅ NEWLY ADDED — entries still allowed
CLOSING             15:00–15:30  ❌ Entries BLOCKED (was 14:30 — FIXED)
```

## Idempotency Design

**Before fix:** Redis-only TTL (5 minutes). If Redis TTL expired and DB write had failed, duplicate submission possible.

**After fix (transactional outbox):**
1. DB record written as `status='pending'` BEFORE broker submission.
2. Redis key set after DB write.
3. Broker submission attempted.
4. DB updated to `status='submitted'` on acknowledgement.

**Recovery path:** If broker submission fails, DB record stays `pending`. Reconciliation can query `GET /v2/orders/external/{correlationId}` to find the order.

## Open Issues

| Issue | Severity | Status |
|-------|----------|--------|
| `dynamicCapital` now reads from PortfolioService | P2 | ✅ FIXED |
| `currentTotalExposure` now computed from open positions | P2 | ✅ FIXED |
| `riskPercentage` still hardcoded as `'1.00'` | P3 | TODO: load from UserSettings |
| `requiredMargin` still uses naive approximation | P3 | TODO: replace with calculateMargin() |
| Freeze quantity not checked | P3 | TODO: implement in Phase 4 |
