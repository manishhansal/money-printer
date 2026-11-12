# Root Cause Analysis — MoneyPrinter

**Date:** 2026-11-11

---

## RCA-001: Quantity in Lots Instead of Units (P0)

**Symptom:** A NIFTY options order for 1 lot results in Dhan receiving `quantity=1` (1 unit) instead of `quantity=75` (75 units).

**Root cause chain:**
1. `RiskManagementService.computePositionSize()` returns LOTS (correctly documented in its own file).
2. `StrategyService` stores this as `signals.position_size` (integer, in lots).
3. `SignalAcceptedEventPayload.positionSize` carries lots — documented as "Proposed position size in lots."
4. `SignalDispatcherService.dispatchToPaper()` and `dispatchToLive()` both passed `positionSize` directly as `quantity` to execution engines **without multiplying by `instrument.lotSize`**.
5. `ExecutionService.placeOrder()` forwarded `orderRequest.quantity` unchanged to `dhanApiClient.placeOrder({ quantity })`.
6. The Dhan API `quantity` field means actual contract units (lots × lot_size).

**Result:** 1/75th of the intended position was submitted.

**Fix implemented:**
- `signal-dispatcher.service.ts`: Added instrument lookup in both paths. Multiplied `positionSize × instrument.lotSize` → `quantityUnits`. Rejects if `instrument.lotSize ≤ 0`.
- `execution.service.ts`: Added validation `quantityUnits % lotSize === 0` and `quantityUnits > 0`.
- `execution.types.ts`: Clarified `quantity` is UNITS; added optional `selectedLots` field.
- `paper-trading.types.ts`: Added `lotSize` and `selectedLots` to `PaperOrderRequest`.
- `paper-trading.service.ts`: Threaded `lotSize` through to `updatePosition`; replaced both `lot_size: 1` hardcodings.

**Regression tests added:** 9 new P0 invariant tests in `execution.service.spec.ts`.

---

## RCA-002: Broker Submission Before DB Persistence (P0)

**Symptom:** If the process crashes after `dhanApiClient.placeOrder()` succeeds but before `ordersRepo.save()` completes, the broker has an order with no corresponding DB record. The idempotency Redis key is also not set. A retry attempt submits a duplicate order.

**Root cause:** The original execution flow in `ExecutionService.placeOrder()` was:
1. Submit to Dhan (irreversible)
2. Save to PostgreSQL (may fail)
3. Set Redis idempotency key (may fail or be skipped)

There was no durable state prior to broker submission.

**Fix implemented:**
- Reordered to: (1) Create DB record as `status='pending'`, (2) Set Redis idempotency key, (3) Submit to Dhan, (4) Update DB record to `status='submitted'` with `dhan_order_id`.
- If broker submission fails, DB record is marked `rejected` with the error message.
- If the process crashes after DB write but before broker submission, the pending record prevents duplicate submissions via Check 4 (duplicate order detection).
- Recovery path: query Dhan by `correlationId` (`GET /orders/external/{correlation-id}`) to reconcile pending orders.

**Tests updated:** `execution.service.spec.ts` — updated 2 tests to reflect new two-step save pattern.

---

## RCA-003: Seed Scripts Default lot_size to 1 (P0)

**Symptom:** Instruments with missing `SEM_LOT_UNITS` in the Dhan CSV were seeded with `lot_size=1`. Index options (NIFTY, BANKNIFTY) have lot sizes of 25–75, not 1.

**Root cause:** Both seed scripts used `lot_size = int(float(lot_raw)) if lot_raw else 1` — a silent fallback.

**Fix implemented:**
- Both scripts now skip instruments with missing or invalid `lot_size` and print a warning.
- `seed_instruments.py`: Changed `ON CONFLICT DO NOTHING` → full UPSERT updating `lot_size`, `tick_size`, `trading_symbol` when changed.
- `seed_index_options.py`: Extended `ON CONFLICT DO UPDATE SET` to also update `lot_size` and `tick_size`.

---

## RCA-004: popup.ts Hardcodes localhost:3002 (P1)

**Symptom:** The Chrome extension popup always connects to `http://localhost:3002` regardless of deployment environment.

**Root cause:** `fetch('http://localhost:3002/settings')` was used directly in `loadSettings()` and `saveSettings()`.

**Fix implemented:** Added `getApiBaseUrl()` helper that checks for a build-time `window.MONEYPRINTER_API_URL` override before falling back to `localhost:3002` for development.

---

## RCA-005: Session Phase CLOSING at 14:30 Blocks Entries Too Early (P1 — Deferred)

**Symptom:** The directive specifies entries should be allowed until 15:00 IST, with square-off beginning at 15:15. However `SessionPhase.CLOSING` starts at 14:30 IST, blocking entries 30 minutes early.

**Status:** Deferred to Phase 4 (Square-off reliability) — requires careful coordination with the 15:15 mandatory square-off cron. Changing the CLOSING phase boundary affects multiple downstream components.

**Planned fix:** Add separate `AFTERNOON_LATE` phase (14:30–15:00) that allows entries, and move `CLOSING` to start at 15:00 IST.
