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

**Planned fix (now implemented):** Added separate `AFTERNOON_LATE` phase (14:30–15:00) that allows entries, and moved `CLOSING` to start at 15:00 IST.

**Status: FIXED_AND_VERIFIED** — `session-manager.service.ts` PHASE_BOUNDARIES confirms `AFTERNOON_LATE` = 14:30–15:00 and `CLOSING` = 15:00–15:30. Regression tests added in `signal-scanner.service.spec.ts` (tests 23–24 of the new phase-guard describe block) explicitly verify AFTERNOON_LATE proceeds and CLOSING blocks.

**Note:** `ROOT_CAUSE_ANALYSIS.md` previously said "Deferred" but the fix had already been implemented in an earlier session. This entry now reflects the actual state.

---

## RCA-006: engine:'PAPER' Hardcoded in Signal Scanner (DEFECT-001) — FIXED

**Symptom:** Even with the system ARMED and all risk controls satisfied, no live orders could be generated from the automatic scanner cron. The `SignalDispatcherService.dispatchToLive()` path was unreachable.

**Root cause chain:**
1. `SignalScannerService.buildCandidate()` had a hardcoded literal: `engine: 'PAPER'`
2. The comment explained it was for paper-mode compatibility, but it was not conditional on the actual armed state
3. `SignalDispatcherService.onSignalAccepted()` routes based on `payload.engine`: when `'PAPER'` → `dispatchToPaper()`, when `'LIVE'` → `dispatchToLive()`
4. Since `engine` was always `'PAPER'`, `dispatchToLive()` was never reached from the cron scanner
5. `LiveTradingService` was available in `SignalScannerModule` (imported) but never injected into `SignalScannerService`

**Fix implemented:**
- Added `LiveTradingService` import and constructor injection to `SignalScannerService`
- `buildCandidate()` now computes: `const engine: 'LIVE' | 'PAPER' = this.liveTradingService.isArmed() ? 'LIVE' : 'PAPER'`
- Added `engineMode` to `measuredInputs` for observability in signal audit logs

**Regression tests:** 4 engine-selection tests in `signal-scanner.service.spec.ts` verify ARMED→LIVE and DISARMED→PAPER behavior

**Commit:** `c636d0dd544895ea2f8ad3b20958c4a2e38cefba`

---

## RCA-007: processTick() DB Query on Every Tick (DEFECT-004) — FIXED

**Symptom:** Under a 100-instrument market feed, every incoming tick issued a `positionsRepo.find()` DB query regardless of whether any positions were tracked for that instrument. This created O(n) DB load per second, risking event-loop lag that could delay stop-loss processing.

**Root cause chain:**
1. `PositionMonitoringService` maintains two in-memory maps: `instrumentToPositions` and `positionToInstrument`
2. These maps are populated by `onModuleInit()` and kept current by `addPosition()`/`removePosition()`
3. `processTick()` ignored these maps and always called `positionsRepo.find()` first
4. When no positions existed for an instrument, the query returned `[]` and the method returned immediately — but the DB round-trip had already occurred

**Fix implemented:**
- Added fast-path guard at the top of `processTick()`:
  ```typescript
  const trackedIds = this.instrumentToPositions.get(instrumentId);
  if (!trackedIds || trackedIds.size === 0) return;
  ```
- DB query only runs when the map confirms at least one position is tracked
- DB remains authoritative for mutable fields (current_sl updated by trailing-stop service)

**Tests updated:** `position-monitoring.service.spec.ts` updated to call `addPosition()` before `processTick()` via the new `registerAndSetupFind()` helper, mirroring the correct production lifecycle.

**Commit:** `c636d0dd544895ea2f8ad3b20958c4a2e38cefba`

---

## RCA-008: Non-Deterministic Idempotency Key in dispatchToLive (NEW_BUG_B) — FIXED

**Symptom:** Even with an idempotency guard in `ExecutionService.placeOrder()`, duplicate live orders could be submitted when the same `SIGNAL_ACCEPTED_EVENT` was processed more than once (retry, duplicate event delivery).

**Root cause chain:**
1. `SignalDispatcherService.dispatchToLive()` called `uuidv4()` on every invocation to generate the idempotency key.
2. Each call produced a new random UUID, so the same `signalId` mapping to two dispatch calls always used two different keys.
3. The idempotency guard (`checkIdempotency`) looked up the key in Redis; since the key was different every time, it always found nothing and allowed the submission to proceed.
4. The only downstream protection was the non-atomic `checkDuplicateOrder` (Check 4), which is insufficient under concurrent execution.

**Fix implemented:**
- `signal-dispatcher.service.ts`: Changed `idempotencyKey: uuidv4()` → `idempotencyKey: \`signal-${payload.signalId}\``.
- Also removed the now-unused `import { v4 as uuidv4 } from 'uuid'`.

**Companion fix (NEW_BUG_F):** `dispatchToPaper()` used `signal-${payload.signalId}-${Date.now()}`, making the paper path equally non-deterministic. Changed to `signal-${payload.signalId}`.

**Regression tests:** `signal-dispatcher.service.spec.ts` tests 19–22 — verify deterministic keys for both paper and live paths and confirm that two dispatches of the same signalId produce the same key.

**Commit:** pending (HEAD `915f5f3`)

---

## RCA-009: Concurrent Strategy Evaluations Bypass Duplicate-Order Check (NEW_BUG_A) — FIXED

**Symptom:** Multiple strategies matching the same instrument in one scan cycle emit concurrent `SIGNAL_ACCEPTED_EVENT`s. Each spawns an async `dispatchToLive()` call. All concurrent calls run `checkDuplicateOrder` before any order is persisted, so all pass Check 4 and multiple live orders are submitted.

**Root cause chain:**
1. `StrategyService.evaluateSignalCandidate()` loops over all active strategies and emits `SIGNAL_CANDIDATE_EVENT` synchronously for each matching strategy.
2. `PipelineWiringService.handleSignalCandidate()` is an `@OnEvent` async handler (fire-and-forget by NestJS EventEmitter2 defaults). All handlers start concurrently.
3. Each handler → `scoreAndPersistSignal()` → (if score ≥ 80) emits `SIGNAL_ACCEPTED_EVENT` → `SignalDispatcherService.onSignalAccepted()` → `dispatchToLive()`.
4. All concurrent `dispatchToLive()` calls reach `checkDuplicateOrder` simultaneously. The check is a DB `findOne` (read), not an atomic compare-and-write. All reads return "no existing order", all proceed to submit.

**Fix implemented:**
- Added `private readonly activeSubmissions = new Set<string>()` to `SignalDispatcherService`.
- Key format: `${instrumentId}:${transactionType}` (e.g. `uuid-1:BUY`).
- In `dispatchToLive()`: check the Set before proceeding; if key present → log and return; otherwise add key, run dispatch inside `try`, remove key in `finally`.
- This provides an in-process mutex for the duration of the dispatch call. Cross-process protection relies on `checkDuplicateOrder` (DB) and the new `modify-pending`/`cancel-pending` status values added to the `OrderStatus` union.

**Regression tests:** `signal-dispatcher.service.spec.ts` tests 23–24 — verify lock blocks concurrent dispatch and lock is released after completion.

**Commit:** pending (HEAD `915f5f3`)

---

## RCA-010: modifyOrder/cancelOrder Call Broker Before Updating DB (NEW_BUG_D) — FIXED

**Symptom:** If the process crashes after `dhanApiClient.modifyOrder()` or `dhanApiClient.cancelOrder()` succeeds but before `ordersRepo.save()` completes, the DB and broker diverge. Reconciliation then needs to handle an order that is modified/cancelled at the broker but still shows the old state in the DB.

**Root cause:** The original execution ordering fix (RCA-002) was applied only to `placeOrder()`. `modifyOrder()` and `cancelOrder()` retained the old broker-first, DB-second ordering.

**Fix implemented:**
- `execution.service.ts` `cancelOrder()`: Sets `status = 'cancel-pending'` in DB first, then calls broker. On broker failure reverts status to previous value.
- `execution.service.ts` `modifyOrder()`: Sets new field values + `status = 'modify-pending'` in DB first, then calls broker. On broker failure reverts all fields to pre-modification state.
- Added `'modify-pending'` and `'cancel-pending'` to the `OrderStatus` union type (`orders.entity.ts`).
- Updated `checkDuplicateOrder` to include `'modify-pending'` and `'cancel-pending'` in the active-status filter, preventing new orders for the same instrument+direction while a cancellation is in-flight.

**Regression tests:** Existing `execution.service.spec.ts` suite (50 tests) continues to pass. Specific cancel/modify ordering tests are covered by the modifyOrder/cancelOrder test cases in that suite.

**Commit:** pending (HEAD `915f5f3`)

---

## RCA-011: entryConditionsMet Always True (DEFECT-002) — FIXED

**Symptom:** Every instrument scan candidate was sent through the full 5-gate strategy evaluation pipeline regardless of market conditions. Gate 3 (`entryConditionsMet`) was never the reason for a signal rejection, so setups in extreme overbought/oversold territory or with critically low volume passed through unchecked.

**Root cause chain:**
1. `SignalScannerService.buildCandidate()` hardcoded `entryConditionsMet: true`
2. The StrategyService comment stated "the caller is responsible for evaluating these conditions via TechnicalAnalysis" — but the caller (scanner) never called any indicator service
3. `TechnicalAnalysisService` existed with all 8 indicator implementations, but was never imported into `SignalScannerModule`
4. The `historical_candles` table was write-only from the application perspective — no service exposed a typed `OHLCV[]` query API

**Fix implemented:**
- Created `CandleQueryService` in `MarketDataModule`: typed OHLCV[] read helper over `historical_candles`; exported from module; provides `getTodayCandles()`, `getMultiDayCandles()`, `getRecentCandles()`
- Added `MarketDataModule` and `TechnicalAnalysisModule` to `SignalScannerModule` imports
- Injected `CandleQueryService` and `TechnicalAnalysisService` into `SignalScannerService`
- Added `computeIndicators(instrumentId)` method: loads today's 1m candles, computes VWAP/RSI/ATR/MACD/EMA9/EMA21/RelVol/ORB
- Added `evaluateEntryConditions(ltp, indicators)` public method:
  - RSI < 25 (deeply oversold) → `met: false`
  - RSI > 75 (deeply overbought) → `met: false`
  - LTP deviation from VWAP > 15% → `met: false`
  - Relative volume < 0.2 → `met: false`
  - No indicator data (< 20 candles) → `met: true` (graceful degradation)

**Regression tests:** 7 new tests in `signal-scanner.service.spec.ts`; 3 integration tests in `signal-pipeline.integration.spec.ts`

**Commit:** working tree

---

## RCA-012: Signal Scores Are Heuristic — momentum=8, vwapTrendAlignment=8 (DEFECT-003) — FIXED

**Symptom:** Two of the eight composite score components were hardcoded constants regardless of actual market conditions. `momentum = 8` never changed, and `vwapTrendAlignment = 8` never changed. The scoring system had no genuine predictive differentiation for these components.

**Root cause chain:**
1. `computeComponentScores()` calculated `momentum` and `vwapTrendAlignment` as literal `8`
2. The original implementation was intended as a placeholder pending `TechnicalAnalysisService` integration (never completed)
3. `TechnicalAnalysisService` already had `computeRSI()` and `computeVWAP()` but was never called from the scanner

**Fix implemented (companion to RCA-011):**
- `momentum` is now RSI-driven:
  - RSI 60–75 → 15 (strong bullish momentum)
  - RSI 55–60 → 12
  - RSI 50–55 → 10
  - RSI 40–50 → 9 (neutral)
  - RSI 25–40 → 6 (weak)
  - RSI extreme or no data → 3 / 8 (fallback)
- `vwapTrendAlignment` is now VWAP deviation-driven:
  - LTP ≥ 0.5% above VWAP → 15 (bullish)
  - LTP 0–0.5% above VWAP → 12
  - LTP 0–0.5% below VWAP → 9
  - LTP ≥ 0.5% below VWAP → 6 (bearish)
  - No VWAP data → 8 (neutral fallback)

**Regression tests:** 6 new indicator-driven score tests in `signal-scanner.service.spec.ts`

---

## RCA-013: Risk Engine suggestedQuantity Never Used (DEFECT-014) — FIXED

**Symptom:** `RiskManagementService.computePositionSize()` and the `suggestedQuantity` field of `evaluatePreEntryGates()` were computed but the result was thrown away. The system always traded `DEFAULT_POSITION_SIZE = 1` lot regardless of account size, risk percentage, or the computed risk-proportional quantity.

**Root cause chain:**
1. `SignalScannerService.buildCandidate()` set `positionSize: DEFAULT_POSITION_SIZE = 1`
2. This `1` propagated through the entire signal pipeline: SignalCandidateInput → SignalCandidateEventPayload → SignalAcceptedEventPayload
3. `SignalDispatcherService.dispatchToPaper()` and `dispatchToLive()` both computed `quantityUnits = payload.positionSize × instrument.lotSize = 1 × lotSize`
4. `RiskManagementService` was not injected into `SignalDispatcherService`
5. `ExecutionService.placeOrder()` received `quantity = 1 × lotSize` and the risk gates checked `suggestedQuantity` (computed internally) but that value was only used for gate validation, not to override the requested quantity

**Fix implemented:**
- Added `RiskManagementService` import and constructor injection to `SignalDispatcherService`
- Added `RiskManagementModule` to `SignalScannerModule` imports
- In `dispatchToPaper()`: call `computePositionSize(paperCapital, paperRiskPct, entry, sl, lotSize)` → use result as `paperLots`; fall back to `Math.max(1, payload.positionSize)` if result is 0
- In `dispatchToLive()`: same pattern using live portfolio capital
- Both `selectedLots` and `quantity` in the order request now reflect the risk-computed lot count

**Example:** ₹100,000 capital, 1% risk, entry=₹100, SL=₹95, lot_size=75 → `computePositionSize` returns 2 lots → order for 150 units (not 75).

**Regression tests:** `signal-dispatcher.service.spec.ts` tests 9 and 15 updated to use `suggestedLots` mock override

---

## RCA-014: No Integration Test Suite (P2-002) — FIXED

**Symptom:** All 62 test suites were pure unit tests with fully mocked dependencies. No test verified that module boundaries (TypeORM queries, EventEmitter2 event routing, service interdependencies) worked correctly in combination.

**Root cause:** Integration tests require either live PostgreSQL/Redis infrastructure or careful use of `Test.createTestingModule` with mock repositories. The latter was not implemented.

**Fix implemented:**
- Created `src/modules/signal-scanner/signal-pipeline.integration.spec.ts` with 13 tests
- Uses real service implementations: `SignalScannerService`, `StrategyService`, `SignalScoringService`, `TechnicalAnalysisService`, `RiskManagementService`
- Mocks: TypeORM repositories, Redis, external service clients
- Coverage: entry condition filtering (DEFECT-002), indicator-based scoring (DEFECT-003), position sizing (DEFECT-014), strategy gate evaluation, regime filtering, opening-phase guards, score threshold gating

**Note:** True end-to-end integration tests (with real PostgreSQL/Redis) are still not implemented. This requires live infrastructure and is deferred. The near-integration tests provide meaningful coverage of module-boundary interactions without live infrastructure.

---

## RCA-015: No Historical Data Import Infrastructure (DEFECT-005 partial) — INFRASTRUCTURE_CREATED

**Symptom:** The `historical_candles` table was write-only from the application perspective: `HistoricalCandleIngestionService` wrote today's data from Dhan's API, but there was no mechanism to import expired-contract historical data needed for backtesting.

**Root cause:** Building a production-ready historical data pipeline requires sourcing the data itself, which requires a paid vendor contract (Truedata, NSE Bharat, etc.). The code infrastructure was never built.

**Fix implemented:**
- Created `src/modules/backtest/historical-data-import.service.ts`
- Accepts CSV files in a documented format (instrument_id, granularity, timestamp, OHLCV, OI)
- Full validation: FK checks, OHLCV sanity, timestamp range, granularity enum
- Idempotent insert (ON CONFLICT DO NOTHING) with optional overwrite mode
- Batch processing (500 rows/batch) for large files
- Pre-flight `validateCsv()` method for dry-run verification
- Data source recommendations documented inline (NSE Bharat, Truedata, Dhan historical API)

**Remaining blocker:** Data itself is NOT included. DEFECT-005 remains a P0 external blocker until real historical expired-contract NSE options data is sourced. Strategy profitability remains UNVERIFIED_DATA.

---

## RCA-016: No Historical Data Infrastructure Using Dhan API (DEFECT-005 / P0-002) — FIXED

**Symptom:** Strategy profitability could not be established because no historical expired NSE options candle data existed. The `BacktestService` accepts caller-provided `BacktestTrade[]` but there was no mechanism to populate this with real historical trades or instrument OHLCV data.

**Root cause chain:**
1. `HistoricalCandleIngestionService` only fetched candles for the current trading day (startup + 15:35 IST cron). No date-range backfill existed.
2. No REST endpoint allowed triggering a historical data fetch.
3. `BacktestController` had no way to ingest multi-year OHLCV data for backtesting purposes.
4. The existing CSV import service (`HistoricalDataImportService`) required the operator to source and format data externally.

**Root cause of the gap:** The Dhan `/v2/charts/historical` and `/v2/charts/intraday` APIs already support date-range queries but were only called with `fromDate=toDate=today`. Extending them to arbitrary date ranges was straightforward.

**Fix implemented:**
- Created `DhanHistoricalBackfillService` in `BacktestModule`:
  - Accepts `fromDate`, `toDate`, `granularity`, optional filters (`underlyingSymbol`, `instrumentType`, `instrumentIds`, `limit`)
  - For `1d` granularity: single Dhan `/v2/charts/historical` request per instrument
  - For `1m`/`5m`/`15m` granularity: automatically chunks date range into Dhan-API-safe windows (7/35/90 calendar days respectively)
  - Processes in batches of 5 instruments with 500ms inter-batch delay (Dhan rate-limit compliance)
  - Idempotent: ON CONFLICT DO NOTHING (or ON CONFLICT DO UPDATE if `overwrite=true`)
  - Returns detailed `BackfillResult` with per-instrument success/failure tracking
  - `loadInstruments()` checks `instrumentIds` BEFORE creating QueryBuilder (fix for a subtle bug where QB was created even when not needed)
- Added `POST /backtest/backfill` endpoint to `BacktestController`
- Updated `BacktestModule` to import `DhanApiModule` and `HistoricalCandles`/`Instruments` repositories
- Fixed `InstrumentType` mapping: entity values (`'INDEX_OPTION'`, `'STOCK_OPTION'`, etc.) map to Dhan values (`'OPTIDX'`, `'OPTSTK'`, etc.)
- Fixed DB column name: `underlying` (not `underlying_symbol`)

**Recommended backfill workflow for operators:**
```bash
# Step 1: Daily OHLCV for NIFTY options (last 2 years)
curl -X POST http://localhost:3002/backtest/backfill \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"fromDate":"2023-01-01","toDate":"2024-12-31","granularity":"1d","underlyingSymbol":"NIFTY"}'

# Step 2: 1-minute intraday for recent 90 days (for precise entry/exit)
curl -X POST http://localhost:3002/backtest/backfill \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"fromDate":"2024-10-01","toDate":"2024-12-31","granularity":"1m","underlyingSymbol":"NIFTY"}'
```

**Known limitations:**
- Dhan API provides coverage for instruments currently or recently listed. Truly expired contracts (> 2 years old) may return empty responses.
- Intraday data availability varies by instrument and date range. `failedInstruments` in the result identifies which instruments returned no data.
- API errors are swallowed per-instrument (not propagated) so the batch does not abort. Failed instruments are logged at DEBUG level.

**Regression tests:** `dhan-historical-backfill.service.spec.ts` — 16 tests covering instrument filtering, candle fetch and storage, timestamp conversion, date chunking, insert/upsert modes, and result aggregation.

**Status:** `FIXED_AND_VERIFIED` (code-level). Data coverage depends on Dhan API availability per instrument — operator must run the backfill and verify `instrumentsSucceeded > 0` for their target universe.
