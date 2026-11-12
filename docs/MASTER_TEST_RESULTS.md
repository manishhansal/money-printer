# MASTER TEST RESULTS — MoneyPrinter
**Audit Date:** 2026-11-12  
**Commit SHA:** `5d9fd24bb8df5c6b5f0b23a7672420331b6c646e`  
**Environment:** Local macOS, offline (no live services)  
**Test Command:** `npx jest --no-coverage --runInBand --passWithNoTests --forceExit`

---

## 1. OVERALL SUMMARY

| Metric | Value |
|---|---|
| Test suites | 59 |
| Total tests executed | 1535 |
| Passed | 1535 |
| Failed | 0 |
| Blocked | Cannot be counted (require live services) |
| Skipped | 0 |
| TypeScript errors | 0 |
| Execution time | ~11 seconds |

---

## 2. SUITE-BY-SUITE RESULTS

| Suite | Tests | Result | Notes |
|---|---|---|---|
| `app.controller.spec.ts` | — | PASS | — |
| `csrf.middleware.spec.ts` | — | PASS | — |
| `throttle-by-user.guard.spec.ts` | — | PASS | — |
| `encrypted-column.transformer.spec.ts` | — | PASS | — |
| `quantity.types.spec.ts` | — | PASS | — |
| `analytics.service.spec.ts` | 13 | PASS | — |
| `capital-simulator.service.spec.ts` | — | PASS | — |
| `daily-intelligence-report.service.spec.ts` | — | PASS | — |
| `market-activity-heatmap.service.spec.ts` | — | PASS | — |
| `trade-quality-forensics.service.spec.ts` | — | PASS | — |
| `auth.service.spec.ts` | — | PASS | — |
| `backtest.service.spec.ts` | 12 | PASS | — |
| `compliance.service.spec.ts` | 12 | PASS | — |
| `dhan-api.client.spec.ts` | 14 | PASS | — |
| `dhan-websocket.client.spec.ts` | — | PASS | — |
| `journal-wiring.service.spec.ts` | — | PASS | — |
| `pipeline-wiring.service.spec.ts` | — | PASS | — |
| `redis-channel-wiring.service.spec.ts` | — | PASS | — |
| `execution.service.spec.ts` | — | PASS | — |
| `instrument-discovery.service.spec.ts` | — | PASS | — |
| `liquidity-score.service.spec.ts` | — | PASS | — |
| `subscription-rotation.service.spec.ts` | — | PASS | — |
| `live-trading.service.spec.ts` | — | PASS | — |
| `market-data-cache.service.spec.ts` | — | PASS | — |
| `market-data.service.spec.ts` | — | PASS | — |
| `market-regime.service.spec.ts` | — | PASS | Property-based |
| `notification.service.spec.ts` | — | PASS | — |
| `options-flow.service.spec.ts` | — | PASS | — |
| `contract-selection.service.spec.ts` | — | PASS | — |
| `expiry-day-controls.service.spec.ts` | — | PASS | — |
| `iv-regime.service.spec.ts` | — | PASS | — |
| `liquidity-marker.service.spec.ts` | — | PASS | — |
| `options-intelligence.service.spec.ts` | — | PASS | — |
| `theta-decay.service.spec.ts` | — | PASS | — |
| `paper-trading.service.spec.ts` | ~80 | PASS | Extensive |
| `portfolio.service.spec.ts` | — | PASS | — |
| `position-monitoring.service.spec.ts` | 14 | PASS | — |
| `target-and-runner.service.spec.ts` | — | PASS | — |
| `reconciliation.service.spec.ts` | — | PASS | — |
| `redis.service.spec.ts` | — | PASS | — |
| `daily-loss-state-machine.service.spec.ts` | 39 | PASS | Property-based |
| `risk-event-recorder.service.spec.ts` | — | PASS | — |
| `risk-management.service.spec.ts` | — | PASS | — |
| `vix-position-size.service.spec.ts` | 14 | PASS | Property-based |
| `secrets.service.spec.ts` | — | PASS | — |
| `session-manager.service.spec.ts` | — | PASS | — |
| `sniper-entry.service.spec.ts` | — | PASS | — |
| `opportunity-ranking.service.spec.ts` | — | PASS | — |
| `signal-scoring.service.spec.ts` | — | PASS | — |
| `strategy.service.spec.ts` | — | PASS | — |
| `system-health-monitor.service.spec.ts` | — | PASS | — |
| `technical-analysis.service.spec.ts` | — | PASS | — |
| `trade-journal-alert.listener.spec.ts` | — | PASS | — |
| `trade-journal-net-pnl.pbt.spec.ts` | 4 | PASS | Property-based |
| `trade-journal.service.spec.ts` | — | PASS | — |
| `sl-rejection-escalation.service.spec.ts` | — | PASS | — |
| `super-order-sl.service.spec.ts` | — | PASS | — |
| `trailing-stop.service.spec.ts` | — | PASS | — |
| `local-market-watchdog.service.spec.ts` | — | PASS | — |

---

## 3. DEFECT REGISTRY

### DEFECT-001 — P0 — LIVE TRADING PIPELINE BROKEN (Scanner Hardcodes engine='PAPER')

| Field | Value |
|---|---|
| **ID** | DEFECT-001 |
| **Severity** | P0 — Critical |
| **Module** | `signal-scanner/signal-scanner.service.ts` |
| **Line** | 343 |
| **Type** | Code defect |

**Actual Behaviour**: `buildCandidate()` always sets `engine: 'PAPER'` regardless of the live trading mode or armed state. Every signal candidate produced by the automatic 2-minute scanner cron has `engine: 'PAPER'`. When this propagates through `StrategyService.evaluateSignalCandidate()` → `SignalScoringService` → `SIGNAL_ACCEPTED_EVENT`, the dispatcher always routes to `dispatchToPaper()` and never to `dispatchToLive()`.

**Expected Behaviour**: When the system is in LIVE mode and the engine is ARMED, the signal candidate should set `engine: 'LIVE'` so it reaches the live execution path.

**Evidence**:
```typescript
// signal-scanner.service.ts line 343
engine: 'PAPER',    // ← hardcoded; never reads live/paper configuration
```

**Financial Impact**: Live trading cannot be automatically initiated through the normal signal pipeline. Even with the engine ARMED, no live orders will be submitted from the scanner. The live trading path in `signal-dispatcher.service.ts` is unreachable.

**Reproduction**: Inspect `src/modules/signal-scanner/signal-scanner.service.ts`, method `buildCandidate()`, line 343. Verify `engine` is always `'PAPER'`.

**Required Remediation** (not implemented — testing engagement only): Read the user's configured engine mode (from user settings or environment) and set `engine` accordingly.

---

### DEFECT-002 — P1 — STRATEGY ENTRY CONDITIONS NOT IMPLEMENTED

| Field | Value |
|---|---|
| **ID** | DEFECT-002 |
| **Severity** | P1 — High |
| **Module** | `signal-scanner/signal-scanner.service.ts` |
| **Line** | 347 |
| **Type** | Code defect |

**Actual Behaviour**: `buildCandidate()` always sets `entryConditionsMet: true`. The 8 strategies (A–H) are defined as database configurations (regime compatibility, R:R ratios, concurrency limits). None have unique entry condition implementations in code. `StrategyService.evaluateSignalCandidate()` checks `candidate.entryConditionsMet` but since the scanner always passes `true`, Gate 3 of the 5-gate evaluation always passes. No actual Opening Range Breakout detection, VWAP reclaim calculation, momentum evaluation, FVG detection, or liquidity sweep logic is implemented.

**Expected Behaviour**: Each strategy should have a distinct entry condition implementation that evaluates the relevant technical conditions (ORB range, VWAP level, ATR, RSI, etc.) before setting `entryConditionsMet`.

**Evidence**:
```typescript
// signal-scanner.service.ts line 347
entryConditionsMet: true,   // ← always true; no strategy-specific logic
```

**Financial Impact**: All 8 strategies effectively run the same logic. The `strategy.name` label (e.g. "Opening Range Breakout") is cosmetic only. No strategy differentiation exists. The system cannot have different risk characteristics per strategy type as intended.

---

### DEFECT-003 — P1 — SIGNAL SCORES ARE HEURISTIC (TechnicalAnalysisService Not Called)

| Field | Value |
|---|---|
| **ID** | DEFECT-003 |
| **Severity** | P1 — High |
| **Module** | `signal-scanner/signal-scanner.service.ts` |
| **Function** | `computeComponentScores()` |
| **Type** | Code defect |

**Actual Behaviour**: `computeComponentScores()` computes all 8 signal score components using trivial heuristics from bid/ask/volume data only:
- `momentum`: Always **8** (hardcoded)
- `vwapTrendAlignment`: Always **8** (hardcoded)
- `volumeConfirmation`: 13 if volume > 100, 10 if volume > 0, else 7
- `regimeAlignment`: Static lookup table from regime code
- Other components: Based on bid/ask spread percentage

`TechnicalAnalysisService` (which correctly implements VWAP, ATR, RSI, EMA, support/resistance, MACD, ORB, relative volume) is **never imported or called** from `signal-scanner.service.ts`.

**Expected Behaviour**: Component scores should use the implemented technical indicators: VWAP deviation for `vwapTrendAlignment`, momentum from RSI/MACD for `momentum`, ATR for stop placement, relative volume for `volumeConfirmation`, etc.

**Evidence**: `grep -r "TechnicalAnalysisService\|computeVWAP\|computeATR\|computeEMA\|computeRSI" src/modules/signal-scanner/` returns no results.

**Financial Impact**: The scoring system has no genuine predictive signal. Scores are essentially deterministic given the regime and bid/ask spread. The 80-point threshold can be passed trivially in most market conditions. The confidence score does not reflect actual trade quality.

---

### DEFECT-004 — P2 — POSITION MONITORING QUERIES DB ON EVERY TICK

| Field | Value |
|---|---|
| **ID** | DEFECT-004 |
| **Severity** | P2 — Medium |
| **Module** | `position-monitoring/position-monitoring.service.ts` |
| **Function** | `processTick()` |
| **Type** | Code defect (performance + correctness) |

**Actual Behaviour**: `processTick()` calls `this.positionsRepo.find({ where: { instrument_id: instrumentId, is_open: true } })` on every market tick for every tracked instrument. The in-memory maps (`instrumentToPositions`, `positionToInstrument`) are populated on startup and kept current via `addPosition()`/`removePosition()`, but `processTick()` ignores these maps and always queries the database.

**Expected Behaviour**: `processTick()` should use the in-memory maps to look up positions (O(1) lookup), only falling back to the database on cache miss. The existing cache infrastructure was built precisely for this purpose.

**Financial Impact**: Under high-frequency tick processing (100+ instruments), every tick triggers N DB queries where N = number of tracked instruments. This creates O(n) database load per second, with risk of event-loop lag that could delay stop-loss processing.

---

### DEFECT-005 — P0 — NO HISTORICAL OPTIONS DATA EXISTS

| Field | Value |
|---|---|
| **ID** | DEFECT-005 |
| **Severity** | P0 — Critical (Quantitative) |
| **Module** | Entire quantitative research pipeline |
| **Type** | Missing external data |

**Actual Behaviour**: No actual historical expired NSE options data exists in the repository or in any connected data source. `historical-candle-ingestion.service.ts` can ingest underlying OHLCV candles from the Dhan API, but there is no historical options premium data, no expired-contract data, no historical IV surfaces, and no historical lot sizes. The `BacktestService.runBacktest()` accepts caller-provided `BacktestTrade[]` but there is no mechanism to populate this with real historical trades.

**Expected Behaviour**: A genuine quantitative investigation requires historical expired options contracts (premium OHLCV, strikes, expiries, lot sizes at time of trade) going back at least 1–2 years.

**Financial Impact**: It is **impossible to validate strategy profitability** using the existing codebase. Any backtest result would be computed from synthetic or fabricated data, which cannot be classified as a valid OOS profitability demonstration.

---

### DEFECT-006 — P1 — AGENT ORCHESTRATOR UNTESTED (1141 Lines)

| Field | Value |
|---|---|
| **ID** | DEFECT-006 |
| **Severity** | P1 — High |
| **Module** | `agents/agent-orchestrator.service.ts` |
| **Type** | Missing test coverage |

**Actual Behaviour**: `agent-orchestrator.service.ts` is 1141 lines implementing a 6-phase multi-agent workflow (7 analyst agents, Bull/Bear researchers, Research Manager, Trader Proposal, 3 Risk Analysts, Portfolio Manager). No spec file exists. The LLM provider is configured as `disabled` by default, meaning all agents use rule-based fallbacks. The fallback logic, timeout handling, phase coordination, and error propagation are completely untested.

**Financial Impact**: Agent workflow failures cannot be detected before they affect trading decisions. With LLM disabled, rule-based logic quality is unknown.

---

### DEFECT-007 — P1 — SIGNAL SCANNER AND DISPATCHER UNTESTED

| Field | Value |
|---|---|
| **ID** | DEFECT-007 |
| **Severity** | P1 — High |
| **Module** | `signal-scanner/signal-scanner.service.ts`, `signal-scanner/signal-dispatcher.service.ts` |
| **Type** | Missing test coverage |

**Actual Behaviour**: The main 2-minute scan loop (`scanForSignals()`), the debug scan trigger (`onDebugTriggerScan()`), the snapshot loading and eligibility check, and the signal dispatch routing logic (paper vs live) have no test coverage. `sniper-entry.service.spec.ts` exists but only tests the sniper filter in isolation; the full scanner integration is untested.

**Financial Impact**: Any regression in the scanning loop, instrument cache, snapshot parsing, or dispatch routing cannot be detected automatically.

---

### DEFECT-008 — P2 — NO INTEGRATION TEST SUITE

| Field | Value |
|---|---|
| **ID** | DEFECT-008 |
| **Severity** | P2 — Medium |
| **Module** | Entire test infrastructure |
| **Type** | Missing test infrastructure |

**Actual Behaviour**: `package.json` references `jest --config ./test/jest-e2e.json` for `test:e2e`, but the `test/` directory contains no e2e test files. All 59 test suites are pure unit tests using in-memory mocks. No integration test exercises the complete module graph against a real PostgreSQL or Redis instance.

**Financial Impact**: Module boundary defects (incorrect event wiring, TypeORM query errors, Redis serialization issues) cannot be detected until runtime.

---

### DEFECT-009 — P2 — SQUARE-OFF RELIES ON stale TRADING SYMBOL

| Field | Value |
|---|---|
| **ID** | DEFECT-009 |
| **Severity** | P2 — Medium |
| **Module** | `live-trading/live-trading.service.ts` |
| **Function** | Mandatory square-off cron |
| **Type** | Code defect (latent) |

**Actual Behaviour**: The mandatory 15:15 IST square-off queries open positions, then looks up the instrument via `instrument_id` to get `tradingSymbol` for the Dhan MARKET SELL order. If the instrument master is refreshed intraday and the `tradingSymbol` is updated (e.g., contract rolls or symbol format changes), the lookup may return the new symbol while the position was opened with the old one. The position has no snapshot of the `tradingSymbol` at order time.

**Expected Behaviour**: Trading symbol should be captured at order entry and stored with the position, not looked up from a live instrument master at exit time.

---

### DEFECT-010 — P1 — COMPLIANCE GATE CANNOT BE MEANINGFULLY EVALUATED WITHOUT REAL DATA

| Field | Value |
|---|---|
| **ID** | DEFECT-010 |
| **Severity** | P1 — High |
| **Module** | `compliance/compliance.service.ts` |
| **Type** | Missing external data |

**Actual Behaviour**: `ComplianceService` evaluates 4 gates (positive expectancy, max drawdown, min trades per regime, Monte Carlo robustness). These gates operate on a `BacktestResult` passed by the caller. With no historical options data (see DEFECT-005), all compliance checks operate on synthetic fabricated data and cannot be used to make a valid profitability determination.

---

## 4. MODULE-WISE RESULT MATRIX

| Module | Unit | Integration | E2E | Stress | Result | Defects |
|---|---|---|---|---|---|---|
| Auth | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | — |
| Execution | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | — |
| Risk Management | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Daily Loss State Machine | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Paper Trading | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Position Monitoring | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | DEFECT-004 |
| Target & Runner | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Trailing Stop | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Reconciliation | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | — |
| Strategy Service | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | DEFECT-002 |
| Signal Scanner | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | FAIL | DEFECT-001, DEFECT-002, DEFECT-003, DEFECT-007 |
| Signal Scoring | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | DEFECT-003 |
| Signal Dispatcher | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | FAIL | DEFECT-001, DEFECT-007 |
| Dhan API Client | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | — |
| Dhan WebSocket | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | — |
| Live Trading | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | DEFECT-001 |
| Market Regime | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Technical Analysis | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Options Intelligence | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Backtest | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | DEFECT-005 |
| Compliance | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | DEFECT-005, DEFECT-010 |
| Agent Orchestrator | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | DEFECT-006 |
| Decision Memory | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | DEFECT-006 |
| LLM Client | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | — |
| Trade Journal | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Watchdog | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | — |
| Instrument Discovery | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | — |
| Market Data | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS_WITH_WARNINGS | — |
| Portfolio | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |
| Analytics | PASS | BLOCKED | BLOCKED | NOT_TESTED | PASS | — |

---

## 5. TRADING LIFECYCLE VERDICT

| Component | Status | Notes |
|---|---|---|
| Market data (WebSocket) | PASS_WITH_WARNINGS | No integration test; fallback not tested live |
| Signal generation (scanner) | FAIL | DEFECT-001: paper-only; DEFECT-002: no entry logic; DEFECT-003: heuristic scores |
| Sniper filters | PASS | Unit tested thoroughly |
| Contract selection | PASS | Unit tested |
| Position sizing | PASS | BigInt arithmetic verified |
| Order submission | PASS_WITH_WARNINGS | Unit tested; live Dhan calls BLOCKED |
| Partial fills | PASS_WITH_WARNINGS | Covered in unit tests |
| Stop-loss management | PASS | Unit tested |
| Target 1 | PASS | Unit tested |
| Runner | PASS | Unit tested |
| Trailing stop | PASS | Unit tested |
| Exit | PASS_WITH_WARNINGS | Super-order integration BLOCKED |
| Reconciliation | PASS_WITH_WARNINGS | Mocked; live Dhan BLOCKED |
| Net P&L | PASS | Cost calculations verified correct |
| Daily loss lockout | PASS | Extensive coverage |
| Square-off | PASS_WITH_WARNINGS | Mocked; live Dhan BLOCKED; DEFECT-009 |
| Restart recovery | NOT_TESTED | No integration test |
| Live trading activation | FAIL | DEFECT-001: scanner cannot generate live orders |
