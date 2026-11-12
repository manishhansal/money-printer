# MoneyPrinter — Forensic Codebase Audit

**Date:** 2026-11-11  
**Auditor:** Principal Engineer (AI)  
**Repository:** `/Users/manishkumar/Desktop/money-printer`  
**Baseline:** 1,442 tests — all passing before remediation begins.

---

## 1. Executive Summary

This audit traces every execution path in MoneyPrinter from market data intake through broker submission and P&L settlement. It identifies defects by reading actual source code, not documentation.

**Critical findings: 10**  
**High severity: 8**  
**Medium severity: 7**  
**Low severity: 5**

---

## 2. Architecture Map

```
MarketData (DhanWebSocketClient / REST polling)
     ↓
MarketDataCacheService → Redis mkt:snapshot:{securityId}
     ↓
StrategyService.evaluateSignalCandidate()
     ↓ (emits signal.accepted event)
SignalDispatcherService.onSignalAccepted()
     ├── PAPER → PaperTradingService.submitPaperOrder()
     └── LIVE  → ExecutionService.placeOrder()
                      ├── 5 pre-trade checks
                      ├── DhanApiClient.placeOrder()   ← BUG #1 (wrong quantity)
                      ├── ordersRepo.save()            ← BUG #10 (wrong order)
                      └── redisService.set()
```

---

## 3. Confirmed Defects

### 3.1 ~~P0-CRIT-001 — Quantity in Units vs Lots (Lot-Size Bug)~~ → FIXED (prior sessions)

Previously described. Fixed in Sessions 1–2. Verified by 9 invariant tests in `execution.service.spec.ts`.

---

### ~~3.1b P0: engine:'PAPER' Hardcoded in Signal Scanner~~ → **FIXED_AND_VERIFIED** (commit `c636d0d`)

**Files fixed:**
- `src/modules/signal-scanner/signal-scanner.service.ts` — added `LiveTradingService` injection; `buildCandidate()` now returns `engine: this.liveTradingService.isArmed() ? 'LIVE' : 'PAPER'`

**Regression tests:** 22 tests in `signal-scanner.service.spec.ts`, including 4 explicit engine-selection tests.

**Previously reported as DEFECT-001 in MASTER_TEST_RESULTS.md.**

**Files:**
- `src/modules/signal-scanner/signal-scanner.types.ts` line 45: `positionSize: number` — documented as "Proposed position size in lots."
- `src/modules/signal-scanner/signal-dispatcher.service.ts` line 161: `quantity: payload.positionSize` — passes lots directly as OrderRequest.quantity.
- `src/modules/execution/execution.service.ts` line 234: `quantity: orderRequest.quantity` — forwards to `DhanApiClient.placeOrder()`.
- `src/modules/paper-trading/paper-trading.service.ts` (via dispatcher line 95): `quantity: payload.positionSize` — same bug for paper.
- `src/modules/paper-trading/paper-trading.service.ts` line ~440: `lot_size: 1` — hardcoded in PaperTrade records.

**Impact:** A NIFTY option with lot_size=75 receives Dhan API `quantity=1` instead of `quantity=75`. The effective position is 1/75th of the intended size. P&L calculations are therefore 75× incorrect. Live capital is at risk.

**Root cause:** `SignalAcceptedEventPayload.positionSize` is in LOTS. The dispatcher passes it as `OrderRequest.quantity`. `ExecutionService` passes `orderRequest.quantity` directly to Dhan without converting to units.

---

### 3.2 P0-CRIT-002 — Execution Ordering: Broker Before DB

**File:** `src/modules/execution/execution.service.ts` lines 230–275.

**Current order:**
1. `dhanApiClient.placeOrder()` — broker submission
2. `ordersRepo.save(order)` — DB persistence
3. `redisService.set(idempotencyKey, ...)` — idempotency key

**Impact:** If the process crashes between steps 1 and 2, the broker order is submitted with no DB record and no idempotency key. The idempotency Redis check on the next attempt finds nothing, so a duplicate order is submitted. Financial consequences: double position, doubled risk exposure.

**Root cause:** No transactional outbox. The DB write should precede broker submission. The idempotency check only covers Redis (5-minute TTL), not the DB record (which persists indefinitely).

---

### 3.3 P0-CRIT-003 — Seed Scripts Default lot_size to 1

**Files:**
- `seed_instruments.py` line 93: `lot_size = int(float(lot_size_raw)) if lot_size_raw else 1`
- `seed_index_options.py` line 59: `lot_size = int(float(lot_raw)) if lot_raw else 1`

**Impact:** Any F&O instrument with a missing `SEM_LOT_UNITS` field in the Dhan CSV is seeded with `lot_size=1`. Index options (NIFTY, BANKNIFTY, FINNIFTY) have known lot sizes of 25–75. If seeded incorrectly as 1, the risk engine and execution engine silently use the wrong multiplier.

---

### 3.4 P0-CRIT-004 — seed_instruments.py Uses ON CONFLICT DO NOTHING

**File:** `seed_instruments.py` line 141.

**Impact:** If the Dhan exchange updates the lot_size for a contract (e.g., NSE revised NIFTY lot from 75 to 25 in September 2024), re-running the seed script does not update the existing row. Stale lot sizes remain in the DB indefinitely.

**Note:** `seed_index_options.py` correctly uses `ON CONFLICT ... DO UPDATE SET` but only updates `instrument_type` and `underlying`, NOT `lot_size` or `tick_size`.

---

### 3.5 P0-CRIT-005 — Paper Trade lot_size Always 1

**File:** `src/modules/paper-trading/paper-trading.service.ts` (updatePosition method).

**Impact:** Every paper trade record has `lot_size=1`. The column comment in the entity says "Total quantity (in units, not lots)" but since quantity itself is wrong (bug 3.1), the per-unit P&L is used as if quantity=lots. Analytics based on lot_size are entirely wrong.

---

### 3.6 P0-CRIT-006 — Mandatory Square-Off Submits position.quantity Without Reconciliation

**File:** `src/modules/live-trading/live-trading.service.ts` line ~491.

```typescript
quantity: position.quantity,
```

**Impact:** The exit order uses the quantity stored in the `positions` table, which may not reflect the actual Dhan net quantity if fills were partial, positions were manually modified, or the data is stale. No reconciliation with `GET /positions` is performed before submission.

---

### 3.7 P1-HIGH-001 — Session CLOSING Phase Starts at 14:30, Blocking Entries Too Early

**File:** `src/modules/session-manager/session-manager.service.ts` line ~40.

**Current:** `CLOSING` phase = 14:30–15:30 IST. `isNewEntryBlocked()` returns true during CLOSING.

**Directive requirement:** 
- 15:00 IST — New-entry restriction
- 15:10 IST — Final entry cutoff
- 15:15 IST — Mandatory square-off begins

**Impact:** Entries are blocked from 14:30, cutting trading time by 30 minutes compared to what the directive specifies. All valid strategies between 14:30–15:00 are suppressed.

---

### 3.8 P1-HIGH-002 — Extension popup.ts Hardcodes localhost:3002

**File:** `extension/src/popup/popup.ts` lines 196, 221.

```typescript
fetch('http://localhost:3002/settings')
fetch('http://localhost:3002/settings', { method: 'PUT', ... })
```

**Impact:** The extension only works when the backend is running locally. Any deployed backend (AWS, GCP, etc.) cannot be reached. Credentials or settings changes are impossible in production.

---

### 3.9 P1-HIGH-003 — Dashboard Uses Imperative DOM, Not React

**File:** `extension/src/dashboard/dashboard.ts`.

The dashboard uses `document.getElementById()`, `innerHTML` assignments and imperative rendering throughout. No React component architecture exists.

**Impact:** Does not meet the React requirement. Performance degrades with frequent full re-renders. No component lifecycle, no virtual DOM diffing, no hooks.

---

### 3.10 P1-HIGH-004 — Signal Dispatcher Live Path: requiredMargin May Be Over-estimated

**File:** `src/modules/signal-scanner/signal-dispatcher.service.ts` line 162.

```typescript
requiredMargin: parseFloat(payload.entryPrice) * payload.positionSize * instrument.lotSize,
```

After the quantity fix, `positionSize` is in lots. The margin calculation is `entry_price × lots × lot_size = entry_price × units`, which is correct for a fully-funded position. However, options margin is typically less than the full premium cost. This should use the Dhan margin calculator API instead of a naive approximation.

---

### 3.11 P1-HIGH-005 — Idempotency Key TTL is Only 5 Minutes

**File:** `src/modules/execution/execution.service.ts` line 56.

```typescript
const IDEMPOTENCY_TTL_SECONDS = 300;
```

**Impact:** A signal that is retried more than 5 minutes after the original submission (e.g., during broker reconnection) bypasses the idempotency check. The DB idempotency constraint (unique on `idempotency_key`) handles this correctly only if the order was persisted before TTL expiry. After the execution ordering fix (P0-CRIT-002), the DB becomes the authoritative idempotency store.

---

### ~~3.4 P2-MED-001 — dynamicCapital Hardcoded in Dispatcher~~ → FIXED (prior sessions)

Addressed in Session 2. `PortfolioService.getDynamicCapital('LIVE')` now used.

---

### ~~DEFECT-004: processTick() DB Query on Every Tick~~ → **FIXED_AND_VERIFIED** (commit `c636d0d`)

**File fixed:** `src/modules/position-monitoring/position-monitoring.service.ts`  
**Fix:** Added in-memory `instrumentToPositions` fast-path guard before `positionsRepo.find()`. See RCA-007 in `ROOT_CAUSE_ANALYSIS.md`.  
**Tests:** `position-monitoring.service.spec.ts` — 14 tests all pass.

---

### 3.12 P2-MED-001 — dynamicCapital Hardcoded in Dispatcher

**File:** `src/modules/signal-scanner/signal-dispatcher.service.ts` line 155.

```typescript
dynamicCapital: '100000.00',
riskPercentage: '1.00',
currentTotalExposure: '0.00',
...
openPositionsCount: 0,
```

**Impact:** All risk gate calculations in the live path use hardcoded values instead of the actual capital and exposure state. The risk engine cannot correctly enforce exposure limits.

---

### 3.13 P2-MED-002 — Paper Dispatcher Skips Instrument Lookup

**File:** `src/modules/signal-scanner/signal-dispatcher.service.ts` lines 90–110.

The `dispatchToPaper()` method does not look up the instrument. It cannot pass `lotSize` to PaperTradingService. After the quantity fix, this path will also need the instrument lookup.

---

### 3.14 P2-MED-003 — Mandatory Square-Off Does Not Check Freeze Quantity

**File:** `src/modules/live-trading/live-trading.service.ts` line ~491.

Exit orders larger than the exchange freeze quantity must be split into multiple smaller orders. Currently a single order is submitted regardless of size.

---

### 3.15 P2-MED-004 — ModifyOrder Sends Current DB quantity to Dhan

**File:** `src/modules/execution/execution.service.ts` line ~302.

```typescript
const targetQuantity = modification.quantity ?? order.quantity;
await this.dhanApiClient.modifyOrder(order.dhan_order_id!, {
  quantity: targetQuantity,
  ...
});
```

After the fix where `orders.quantity` stores units, this will work correctly. Before the fix it sends lots to Dhan on modification.

---

### 3.16 P2-MED-005 — No Pre-Trade Quantity Invariant Check

**File:** `src/modules/execution/execution.service.ts`.

No validation that `quantityUnits % lotSize === 0`. If a caller sends a non-lot-aligned quantity, it reaches the broker without rejection.

---

## 4. Test Coverage Gaps

| Area | Current Tests | Missing Tests |
|------|--------------|---------------|
| Lot-size conversion invariant | 0 | Property test: `quantityUnits % lotSize === 0` |
| Execution ordering (DB before broker) | 0 | Crash recovery simulation |
| Paper trade lot_size | 0 | Verify stored lot_size matches instrument |
| Mandatory square-off with reconciliation | 0 | Mock Dhan positions API |
| Seed script lot_size default rejection | 0 | Missing field → error not default |
| Freeze quantity validation | 0 | Large position → split orders |

---

## 5. Files Requiring Changes (Priority Order)

| Priority | File | Change |
|----------|------|--------|
| P0 | `src/modules/execution/execution.service.ts` | Fix execution ordering; add lot-size validation; compute quantityUnits |
| P0 | `src/modules/signal-scanner/signal-dispatcher.service.ts` | Convert positionSize → units in both paths |
| P0 | `src/modules/paper-trading/paper-trading.types.ts` | Add lotSize to PaperOrderRequest |
| P0 | `src/modules/paper-trading/paper-trading.service.ts` | Use actual lotSize in PaperTrade |
| P0 | `seed_instruments.py` | Reject missing lot_size; full UPSERT |
| P0 | `seed_index_options.py` | Reject missing lot_size; full UPSERT |
| P0 | `src/modules/execution/execution.types.ts` | Clarify quantity is units; add selectedLots field |
| P1 | `src/modules/session-manager/session-manager.service.ts` | Align CLOSING phase with 15:00 directive |
| P1 | `extension/src/popup/popup.ts` | Remove hardcoded localhost |
| P1 | Tests | Add lot-size invariant tests |
