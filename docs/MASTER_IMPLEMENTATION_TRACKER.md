# MoneyPrinter — Master Implementation Tracker
**Last updated:** 2026-11-13 (Phase 0/1/2/3 implementation + System Reliability Fixes)
**Repository:** money-printer (feat/money-printer branch, also origin/main)
**HEAD:** `f1cac30` (working tree has uncommitted changes — see Phase 5 below)
**Test count:** 1,729 backend (67 suites) + 53 extension = **1,782 total** (all passing)

---

## Cumulative Defect Registry — All Sessions (Updated 2026-11-13)

| ID | Severity | Description | Status |
|---|---|---|---|
| P0-CRIT-001 | P0 | Quantity in lots instead of units | FIXED_AND_VERIFIED |
| P0-CRIT-002 | P0 | Broker before DB in placeOrder() | FIXED_AND_VERIFIED |
| P0-CRIT-003 | P0 | Seed scripts default lot_size to 1 | FIXED_AND_VERIFIED |
| P0-CRIT-004 | P0 | Seed scripts ON CONFLICT DO NOTHING preserves stale lot_size | FIXED_AND_VERIFIED |
| P1-HIGH-001 | P1 | CLOSING phase at 14:30 blocks entries too early | FIXED_AND_VERIFIED |
| P1-HIGH-002 | P1 | popup.ts hardcodes localhost:3002 | FIXED_AND_VERIFIED |
| DEFECT-001 (P0) | P0 | engine: 'PAPER' hardcoded in scanner — live pipeline unreachable | FIXED_AND_VERIFIED |
| DEFECT-002 (P1) | P1 | entryConditionsMet always true — no real entry logic | **GENUINELY FIXED** via StrategyEntryConditionsService |
| DEFECT-003 (P1) | P1 | momentum=8, vwapTrendAlignment=8 hardcoded heuristics | FIXED (ADX/ROC/RelVol now used) |
| DEFECT-004 (P2) | P2 | processTick() DB query on every tick | FIXED_AND_VERIFIED |
| DEFECT-005 (P0) | P0 | No historical options data for backtesting | **INFRASTRUCTURE COMPLETE** (data fetch required) |
| DEFECT-006 (P1) | P1 | Agent orchestrator untested | PARTIALLY_FIXED |
| DEFECT-007 (P1) | P1 | Signal scanner and dispatcher untested | FIXED_AND_VERIFIED |
| DEFECT-008 (P2) | P2 | No integration test suite | FIXED_AND_VERIFIED |
| DEFECT-009 (P2) | P2 | Square-off relies on stale trading symbol | FIXED_AND_VERIFIED |
| DEFECT-010 (P1) | P1 | Compliance gate needs historical data | BLOCKED_EXTERNAL |
| DEFECT-011 (P1) | P1 | dispatchToLive uses uuidv4() as idempotency key | FIXED_AND_VERIFIED |
| DEFECT-012 (P1) | P1 | Concurrent strategy evals bypass duplicate-order check | FIXED_AND_VERIFIED |
| DEFECT-013 (P2) | P2 | modifyOrder/cancelOrder broker before DB | FIXED_AND_VERIFIED |
| DEFECT-014 (P1) | P1 | Risk engine suggestedQuantity never used — always 1 lot | FIXED_AND_VERIFIED |
| DEFECT-015 (P2) | P2 | Correlated exposure uses wrong positions | OPEN (documented safe conservative) |
| DEFECT-016 (P3) | P3 | Paper idempotency key appends Date.now() | FIXED_AND_VERIFIED |
| DEFECT-017 (P3) | P3 | Dispatcher mock missing getArmedState | FIXED_AND_VERIFIED |
| ARCH-001 | P0 | Scanner evaluates OPTIONS first, not underlying | **FIXED** via UnderlyingMomentumScannerService |
| GAP-001 | P1 | India VIX hardcoded to 15 (HIGH_VOL never fires) | OPEN |
| GAP-002 | P1 | Market breadth is a proxy (not real advance/decline) | OPEN |
| GAP-003 | P1 | events:tick channel not published from DhanWebSocket | OPEN |
| GAP-004 | P1 | No dynamic instrument universe discovery | OPEN |
| GAP-005 | P1 | No expiry management (expired contracts scanned) | **FIXED** via ExpiryManagementService |
| GAP-006 | P2 | Near-ATM filter 10% strike distance too broad | IMPROVED (5% in new scanner) |
| GAP-007 | P2 | No ADX/ROC indicators | **FIXED** (computeADX, computeROC added) |
| GAP-008 | P2 | No multi-timeframe analysis | **FIXED** (getMultiTimeframeCandles, 1m/5m/15m/1d) |
| GAP-009 | P2 | No relative strength vs NIFTY for F&O stocks | **FIXED** (computeRelativeStrength added) |
| GAP-010 | P2 | Rolling options API endpoint missing | **FIXED** (getRollingOptionData, full types, entity, backfill service) |
| IMPROVEMENT-001 | P2 | Deep OTM instruments (0% win rate) included in scan | IMPLEMENTED |
| IMPROVEMENT-002 | P2 | CE and PE both traded regardless of regime direction | IMPLEMENTED |
| IMPROVEMENT-003 | P2 | RSI 25–75 filter too broad for options | IMPLEMENTED |

---

## Phase 0 — Baseline Forensic Reconciliation (COMPLETE 2026-11-13)

**Verified baseline at HEAD f1cac30:**
- Tests: 1,661 passing (confirmed by actual `npx jest` run)
- TypeScript: clean (zero errors)
- ESLint: clean
- Server: not running

**Report inconsistencies resolved:**
- Previous reports cited 1,601/1,641/1,661 and commit SHAs 915f5f3/5d9fd24. Actual HEAD: f1cac30, 1,661 tests at baseline.
- DEFECT-002 "FIXED_AND_VERIFIED" in prior reports was **incorrect** — all 8 strategies still used identical RSI logic. Genuinely fixed now.
- DEFECT-003 "FIXED_AND_VERIFIED" was partially correct (RSI/VWAP scores computed) but `optionsFuturesConfirmation` still used bid/ask spread. Now improved.
- ARCH-001 (scanner evaluating options first) was not documented in prior reports. Now fixed.

---

## Phase 1 — Trading Universe and Expiry Discovery (COMPLETE)

| Task | Status | File |
|------|--------|-------|
| Dynamic expiry discovery | COMPLETE | `expiry-management.service.ts` |
| Weekly index expiry eligibility | COMPLETE | `ExpiryManagementService.getCurrentWeeklyExpiry()` |
| Monthly stock option eligibility | COMPLETE | `ExpiryManagementService.getCurrentMonthlyExpiry()` |
| Holiday-adjusted expiry (via live Dhan list) | COMPLETE | `classifyExpiry()` with ±3-day tolerance |
| hasWeeklyContract() validation | COMPLETE | |
| Expiry management tests (13 tests) | COMPLETE | `expiry-management.service.spec.ts` |

---

## Phase 2 — Dhan Historical Data Integration (INFRASTRUCTURE COMPLETE)

| Task | Status | File |
|------|--------|-------|
| `/v2/charts/rollingoption` API types | COMPLETE | `dhan-api.types.ts` |
| `getRollingOptionData()` in DhanApiClient | COMPLETE | `dhan-api.client.ts` |
| `RollingOptionCandles` entity | COMPLETE | `rolling-option-candles.entity.ts` |
| DB migration for rolling_option_candles | COMPLETE | `1800000000003-AddRollingOptionCandles.ts` |
| `DhanRollingOptionBackfillService` | COMPLETE | `dhan-rolling-option-backfill.service.ts` |
| Backfill tests (18 tests) | COMPLETE | `dhan-rolling-option-backfill.service.spec.ts` |
| HTTP endpoint (`POST /backtest/rolling-backfill`) | ❌ OPEN | Needs to be wired in BacktestController |
| Underlying OHLCV historical data | ❌ OPEN | Data fetch required (existing service available) |
| Actual rolling options data fetch | ❌ OPEN | Requires running backfill with Dhan credentials |
| Coverage validation | ❌ OPEN | After data fetch |

---

## Phase 3 — Momentum Strategy Implementation (COMPLETE)

| Task | Status | File |
|------|--------|-------|
| ADX (+DI/-DI) indicator | COMPLETE | `technical-analysis.service.ts` |
| Rate of Change (ROC) indicator | COMPLETE | `technical-analysis.service.ts` |
| EMA50 and RelativeStrength | COMPLETE | `technical-analysis.service.ts` |
| Configurable ORB window (5/15/30 min) | COMPLETE | `computeORBRange(candles, sessionStart, windowMinutes)` |
| Multi-timeframe candle loading | COMPLETE | `CandleQueryService.getMultiTimeframeCandles()` |
| Previous-day high/low levels | COMPLETE | `CandleQueryService.getPreviousDayHighLow()` |
| Strategy A — Opening Range Breakout | COMPLETE | `StrategyEntryConditionsService.evaluateORB()` |
| Strategy B — VWAP Reclaim / Rejection | COMPLETE | `StrategyEntryConditionsService.evaluateVWAPReclaim()` |
| Strategy C — Momentum Expansion | COMPLETE | `StrategyEntryConditionsService.evaluateMomentumExpansion()` |
| Strategy D — Breakout and Retest | COMPLETE | `StrategyEntryConditionsService.evaluateBreakoutRetest()` |
| Strategy E — Relative Strength / Weakness | COMPLETE | `StrategyEntryConditionsService.evaluateRelativeStrength()` |
| Strategy F — Trend Continuation | COMPLETE | `StrategyEntryConditionsService.evaluateTrendContinuation()` |
| Underlying-first scanner architecture | COMPLETE | `UnderlyingMomentumScannerService` |
| Multi-timeframe confirmation (5m) | COMPLETE | `checkMultiTimeframeConfirmation()` |
| Candidate scoring and ranking | COMPLETE | `scoreCandidate()` |
| Strategy entry conditions tests (45 tests) | COMPLETE | `strategy-entry-conditions.service.spec.ts` |

---

## Phase 5 — System Reliability & Infrastructure Fixes (COMPLETE)

### 5.1 Watchdog P1/P2 Issues Resolved

| Task | Status | File |
|------|--------|-------|
| Fix `health:dhan_last_checked_at` missing writer (P2 `dhan_health_check_stale`) | COMPLETE | `system-health-monitor.service.ts` |
| Fix boot-time race: seed Redis health keys on `onModuleInit()` (P1 `backend_degraded`) | COMPLETE | `system-health-monitor.service.ts` |
| Fix `approveAndExecute()` not persisting RESOLVED to DB | COMPLETE | `auto-remediation.service.ts` |
| Update `system-health-monitor.service.spec.ts` assertions (7 Redis.set calls) | COMPLETE | `system-health-monitor.service.spec.ts` |
| Confirm P0=0, P1=0, P2=0, P3=0 watchdog post-fix | COMPLETE | Verified live at 10:07 IST |

### 5.2 Market Regime Classification Fix (UNSTABLE → SIDEWAYS/WEAK_BULL/etc.)

**Root cause:** Dhan's IDX_I WebSocket feed never delivers ticks for NIFTY (secId=13) or BANKNIFTY (secId=25). `mkt:snapshot:13` was never written → `buildRegimeInputsFromRedis()` returned null → regime stayed `UNSTABLE` → signal scanner skipped all instruments with `skipped_direction=N`.

| Task | Status | File |
|------|--------|-------|
| Add `DhanApiModule` import to `MarketRegimeModule` | COMPLETE | `market-regime.module.ts` |
| Add `pollIndexLtp()` 30s cron — REST `getLtp({IDX_I:[13,25]})` → Redis TTL=90s | COMPLETE | `market-regime.service.ts` |
| Add `buildRegimeInputsFromOptions()` put-call parity fallback using flowing options | COMPLETE | `market-regime.service.ts` |
| Update `updateRegime()` to 3-tier priority: REST → options parity → stale reuse | COMPLETE | `market-regime.service.ts` |
| Add `loadNearATMOptionPairs()` / `isMarketHoursNow()` helpers | COMPLETE | `market-regime.service.ts` |
| Fix volume proxy (`800000` = 0.8 relative vol, avoids false LOW_VOL) | COMPLETE | `market-regime.service.ts` |
| Update spec mocks: `DhanApiClient` + `DataSource` | COMPLETE | `market-regime.service.spec.ts` |
| Confirm `regime:current = "SIDEWAYS"` live at 13:40 IST | COMPLETE | Redis verified |

### 5.3 Live Market Monitor Script

| Task | Status | File |
|------|--------|-------|
| `scripts/monitor.py` — 2-min polling loop until 15:30 IST | COMPLETE | `scripts/monitor.py` |
| Covers: health, signals, paper positions, portfolio P&L, stats, watchdog | COMPLETE | |

---

## Phase 4 — Option Selection and Risk Integration (PARTIAL)

| Task | Status | Notes |
|------|--------|-------|
| CE/PE mapping from underlying direction | COMPLETE | In `UnderlyingMomentumScannerService.dispatchCandidate()` |
| ATM strike selection | COMPLETE | `findNearestOptionContract()` using parseFloat(strikePrice) |
| Expiry-aware selection | COMPLETE | Via `ExpiryManagementService` |
| 5% near-ATM filter | COMPLETE | Replaces old 10% filter |
| Liquidity validation (option LTP ≥ ₹10) | COMPLETE | In `dispatchCandidate()` |
| Proper stop/target on underlying option | COMPLETE | 1.5% SL, 3% target on option premium |
| Strike selection via delta range | ❌ OPEN | Delta not available without live option chain |

---

## Phases 5–8 (PENDING)

| Phase | Status | Blocking |
|-------|--------|---------|
| Phase 5 — Event-driven backtest engine | ❌ OPEN | Requires historical data first |
| Phase 6 — Strategy optimization & robustness | ❌ OPEN | Requires Phase 5 |
| Phase 7 — Paper trading (live forward validation) | ❌ OPEN | Requires all scanners wired to paper engine |
| Phase 8 — Production readiness review | ❌ OPEN | Requires all prior phases |

---

## Test Count Summary

| Commit | Tests | Notes |
|--------|-------|-------|
| Baseline f1cac30 | 1,661 | Confirmed by actual run |
| After Phase 2/3 (prev session) | **1,729** | +68 new tests |
| After Phase 5 reliability fixes | **1,729** | Zero regressions (spec mocks updated, no net count change) |
| Extension tests | 53 | Unchanged |
| **Total** | **1,782** | All passing |

**Repository:** money-printer (feat/money-printer branch)
**HEAD:** `915f5f3` (working tree has additional changes not yet committed)
**Test count:** 1,661 backend + 53 extension = **1,714 total** (all passing)

---

## Cumulative Defect Registry — All Sessions

| ID | Severity | Description | Status |
|---|---|---|---|
| P0-CRIT-001 | P0 | Quantity in lots instead of units | FIXED_AND_VERIFIED |
| P0-CRIT-002 | P0 | Broker before DB in placeOrder() | FIXED_AND_VERIFIED |
| P0-CRIT-003 | P0 | Seed scripts default lot_size to 1 | FIXED_AND_VERIFIED |
| P0-CRIT-004 | P0 | Seed scripts ON CONFLICT DO NOTHING preserves stale lot_size | FIXED_AND_VERIFIED |
| P1-HIGH-001 | P1 | CLOSING phase at 14:30 blocks entries too early | FIXED_AND_VERIFIED |
| P1-HIGH-002 | P1 | popup.ts hardcodes localhost:3002 | FIXED_AND_VERIFIED |
| DEFECT-001 (P0) | P0 | engine: 'PAPER' hardcoded in scanner — live pipeline unreachable | FIXED_AND_VERIFIED |
| DEFECT-002 (P1) | P1 | entryConditionsMet always true — no real entry logic | FIXED_AND_VERIFIED |
| DEFECT-003 (P1) | P1 | momentum=8, vwapTrendAlignment=8 hardcoded heuristics | FIXED_AND_VERIFIED |
| DEFECT-004 (P2) | P2 | processTick() DB query on every tick | FIXED_AND_VERIFIED |
| DEFECT-005 (P0) | P0 | No historical options data for backtesting | INFRASTRUCTURE_CREATED (data external) |
| DEFECT-006 (P1) | P1 | Agent orchestrator untested | PARTIALLY_FIXED (16 tests, LLM paths BLOCKED) |
| DEFECT-007 (P1) | P1 | Signal scanner and dispatcher untested | FIXED_AND_VERIFIED |
| DEFECT-008 (P2) | P2 | No integration test suite | FIXED_AND_VERIFIED (13 near-integration tests) |
| DEFECT-009 (P2) | P2 | Square-off relies on stale trading symbol | FIXED_AND_VERIFIED |
| DEFECT-010 (P1) | P1 | Compliance gate needs historical data | BLOCKED_EXTERNAL (depends on DEFECT-005) |
| DEFECT-011 (P1) | P1 | dispatchToLive uses uuidv4() as idempotency key | FIXED_AND_VERIFIED |
| DEFECT-012 (P1) | P1 | Concurrent strategy evals bypass duplicate-order check | FIXED_AND_VERIFIED |
| DEFECT-013 (P2) | P2 | modifyOrder/cancelOrder broker before DB | FIXED_AND_VERIFIED |
| DEFECT-014 (P1) | P1 | Risk engine suggestedQuantity never used — always 1 lot | FIXED_AND_VERIFIED |
| DEFECT-015 (P2) | P2 | Correlated exposure uses wrong positions (overestimate) | OPEN (documented safe conservative) |
| DEFECT-016 (P3) | P3 | Paper idempotency key appends Date.now() | FIXED_AND_VERIFIED |
| DEFECT-017 (P3) | P3 | Dispatcher mock missing getArmedState | FIXED_AND_VERIFIED |
| IMPROVEMENT-001 | P2 | Deep OTM instruments (0% win rate) included in scan | IMPLEMENTED (near-ATM filter) |
| IMPROVEMENT-002 | P2 | CE and PE both traded regardless of regime direction | IMPLEMENTED (directional filter) |
| IMPROVEMENT-003 | P2 | RSI 25–75 filter too broad for options | IMPLEMENTED (RSI≥55 for directional) |
| INFRA-001 | P1 | `health:dhan_last_checked_at` Redis key read but never written — permanently stale | **FIXED** (`SystemHealthMonitorService.pollHealth()` now writes it; `onModuleInit()` seeds it) |
| INFRA-002 | P1 | WebSocket IDX_I feed returns no ticks for NIFTY/BANKNIFTY index securityIds | **FIXED** (`pollIndexLtp()` 30s REST cron writes `mkt:snapshot:13/25` with TTL=90s) |
| INFRA-003 | P2 | `approveAndExecute()` sets `FIX_IN_PROGRESS` in DB but never persists `RESOLVED` | **FIXED** (now saves final status after `executePlan()`) |
| INFRA-004 | P1 | Regime stays `UNSTABLE` on boot — 15s watchdog fires before 30s `pollHealth()` cron | **FIXED** (`SystemHealthMonitorService.onModuleInit()` seeds all health keys immediately) |
| INFRA-005 | P1 | Market regime permanently `UNSTABLE` → scanner skips all instruments (`skipped_direction=N`) | **FIXED** via REST LTP polling (primary) + put-call parity options fallback (secondary) |

---

## Existing Baseline (Completed Before This Session)

All prior remediation sessions (1–6) are captured in `docs/REMEDIATION_LOG.md` and `docs/PRODUCTION_READINESS_REPORT.md`. The summary is:

- **All P0/P1/P2/P3 defects resolved** per PRODUCTION_READINESS_REPORT.md
- **1,489 tests passing** across 60+ suites with zero regressions
- **All 30+ modules implemented**: Dhan API, market data, instrument discovery, options intelligence, options flow, market regime, strategy, signal scanner, signal dispatcher, execution, paper trading, live trading, risk management, position monitoring, trailing stop, reconciliation, analytics, trade journal, backtest, technical analysis, portfolio, charges, compliance, session manager, system health monitor, notification, Redis, auth, event wiring, debug

---

## Phase 1 — Baseline Audit

| Task | Status | Notes |
|------|--------|-------|
| P1-001 Inspect repository structure | COMPLETED | 30+ modules, 28 entities, 2 migrations |
| P1-002 Audit all module implementations | COMPLETED | See PRODUCTION_READINESS_REPORT.md |
| P1-003 Identify gaps vs new requirements | COMPLETED | Multi-agent engine, evidence store, decision memory, watchdog |
| P1-004 Document existing test coverage | COMPLETED | 1,489 tests, all passing |
| P1-005 Update this tracker | IN_PROGRESS | Active |

---

## Phase 2 — Test Plan (MASTER_TEST_PLAN.md)

| Task | Status | Notes |
|------|--------|-------|
| P2-001 Write profitability test cases | COMPLETED | See MASTER_TEST_PLAN.md |
| P2-002 Write functional test cases | COMPLETED | See MASTER_TEST_PLAN.md |
| P2-003 Write failure scenario tests | COMPLETED | Existing spec files cover most |
| P2-004 Define acceptance criteria per strategy | COMPLETED | MASTER_TEST_PLAN.md §2 |

---

## Phase 3 — TradingAgents Architecture Adaptation

| Task | Status | Files Changed | Tests |
|------|--------|--------------|-------|
| P3-001 Study TradingAgents parallel analysts pattern | COMPLETED | — | — |
| P3-002 Design TypeScript multi-agent workflow | COMPLETED | src/modules/agents/agent.types.ts | — |
| P3-003 Implement AgentsModule | IN_PROGRESS | src/modules/agents/ | agents.spec.ts |
| P3-004 Implement parallel specialist analysts | IN_PROGRESS | src/modules/agents/analysts/ | — |
| P3-005 Implement bull/bear debate | IN_PROGRESS | src/modules/agents/debate/ | — |
| P3-006 Implement research manager | IN_PROGRESS | src/modules/agents/managers/ | — |
| P3-007 Implement risk analysts (agg/cons/neutral) | IN_PROGRESS | src/modules/agents/risk-analysts/ | — |
| P3-008 Implement portfolio manager | IN_PROGRESS | src/modules/agents/portfolio-manager/ | — |
| P3-009 Implement structured output + schema validation | IN_PROGRESS | src/modules/agents/schemas/ | — |
| P3-010 Implement persistent workflow state | IN_PROGRESS | src/modules/agents/workflow-state/ | — |
| P3-011 Implement decision memory + outcome settlement | IN_PROGRESS | src/modules/decision-memory/ | — |
| P3-012 Wire AgentsModule into AppModule | IN_PROGRESS | src/app.module.ts | — |

---

## Phase 4 — Multi-Agent Intelligence Engine (15 Agents)

| Agent | Status | File |
|-------|--------|------|
| Market Structure Analyst | IN_PROGRESS | agents/analysts/market-structure.analyst.ts |
| Technical Analysis Analyst | IN_PROGRESS | agents/analysts/technical-analysis.analyst.ts |
| Derivatives Intelligence Analyst | IN_PROGRESS | agents/analysts/derivatives.analyst.ts |
| Options Flow Analyst | IN_PROGRESS | agents/analysts/options-flow.analyst.ts |
| News Intelligence Analyst | IN_PROGRESS | agents/analysts/news.analyst.ts |
| Sentiment Analyst | IN_PROGRESS | agents/analysts/sentiment.analyst.ts |
| Event & Volatility Risk Analyst | IN_PROGRESS | agents/analysts/event-risk.analyst.ts |
| Bull Researcher | IN_PROGRESS | agents/researchers/bull.researcher.ts |
| Bear Researcher | IN_PROGRESS | agents/researchers/bear.researcher.ts |
| Research Manager | IN_PROGRESS | agents/managers/research.manager.ts |
| Trader Proposal Agent | IN_PROGRESS | agents/proposal/trader-proposal.agent.ts |
| Aggressive Risk Analyst | IN_PROGRESS | agents/risk-analysts/aggressive.analyst.ts |
| Conservative Risk Analyst | IN_PROGRESS | agents/risk-analysts/conservative.analyst.ts |
| Neutral Risk Analyst | IN_PROGRESS | agents/risk-analysts/neutral.analyst.ts |
| Portfolio Manager Agent | IN_PROGRESS | agents/portfolio-manager/portfolio-manager.agent.ts |

---

## Phase 5 — Evidence and Data Provenance

| Task | Status | File |
|------|--------|------|
| P5-001 Design EvidenceStore schema | COMPLETED | agents/evidence/evidence.types.ts |
| P5-002 Implement EvidenceStoreService | IN_PROGRESS | agents/evidence/evidence-store.service.ts |
| P5-003 Add evidence entity | IN_PROGRESS | database/entities/agent-evidence.entity.ts |
| P5-004 Add data provenance checks | IN_PROGRESS | agents/evidence/evidence-validator.service.ts |
| P5-005 Migrate evidence table | IN_PROGRESS | migrations/ |

---

## Phase 6 — Quantitative Options Engine

| Task | Status | Notes |
|------|--------|-------|
| P6-001 ORB strategy | COMPLETED | strategy.service.ts Strategy H |
| P6-002 VWAP reclaim/rejection strategy | COMPLETED | strategies A/B/C |
| P6-003 Momentum expansion | COMPLETED | strategy.service.ts |
| P6-004 Breakout and retest | COMPLETED | strategy.service.ts |
| P6-005 Trend continuation | COMPLETED | strategy.service.ts |
| P6-006 Contract selection (Delta/Greeks/IV/OI/etc.) | COMPLETED | contract-selection.service.ts |
| P6-007 IV percentile/rank tracking | COMPLETED | iv-regime.service.ts |
| P6-008 Realistic economics evaluation | COMPLETED | charges.service.ts |
| P6-009 Liquidity sweep strategy | COMPLETED | strategy.service.ts |
| P6-010 FVG and market structure shift | COMPLETED | strategy.service.ts |
| P6-011 Volatility compression breakout | COMPLETED | strategy.service.ts |
| P6-012 IV expansion/contraction trading | COMPLETED | iv-regime.service.ts |

---

## Phase 7 — Historical Options Backtesting

| Task | Status | Notes |
|------|--------|-------|
| P7-001 Walk-forward engine | COMPLETED | backtest.service.ts |
| P7-002 Bootstrap CI (≥1000 iterations) | COMPLETED | backtest.service.ts |
| P7-003 Strategy ablation analysis | COMPLETED | BacktestService.runAblationAnalysis() |
| P7-004 Realistic costs (STT, brokerage, GST, etc.) | COMPLETED | trading-charges.service.ts |
| P7-005 Historical candle ingestion | COMPLETED | historical-candle-ingestion.service.ts |
| P7-006 Monte Carlo analysis | COMPLETED | compliance.service.ts (MC ≥95%) |
| P7-007 Chronological train/validation/OOS split | COMPLETED | backtest.service.ts |
| P7-008 Parameter sensitivity testing | IN_PROGRESS | backtest.service.ts (partial) |
| P7-009 Regime-specific performance analysis | IN_PROGRESS | analytics.service.ts (partial) |

---

## Phase 8 — Sniper Entry and Scalping

| Task | Status | Notes |
|------|--------|-------|
| P8-001 SniperEntryService with 8 filters | COMPLETED | sniper-entry.service.ts |
| P8-002 Signal quality classification (A+/A/B/C/REJECT) | COMPLETED | signal-scoring.service.ts |
| P8-003 Market regime alignment check | COMPLETED | strategy.service.ts |
| P8-004 Higher-timeframe direction check | COMPLETED | technical-analysis.service.ts |
| P8-005 VWAP filter | COMPLETED | sniper-entry.service.ts |
| P8-006 Opening range check | COMPLETED | sniper-entry.service.ts |
| P8-007 Volume/relative volume check | COMPLETED | sniper-entry.service.ts |
| P8-008 Options premium/IV/Greeks checks | COMPLETED | sniper-entry.service.ts |
| P8-009 Reward-to-risk check | COMPLETED | signal-scoring.service.ts |
| P8-010 Data freshness check | COMPLETED | sniper-entry.service.ts |
| P8-011 Event-risk check | COMPLETED | sniper-entry.service.ts |

---

## Phase 9 — Target 1 and Greedy Runner

| Task | Status | Notes |
|------|--------|-------|
| P9-001 TargetAndRunnerService | COMPLETED | target-and-runner.service.ts |
| P9-002 Whole-lot partial booking at Target 1 | COMPLETED | target-and-runner.service.ts |
| P9-003 Break-even transition after Target 1 | COMPLETED | target-and-runner.service.ts |
| P9-004 ATR trailing stop | COMPLETED | trailing-stop.service.ts |
| P9-005 Structure-based trailing | COMPLETED | trailing-stop.service.ts |
| P9-006 Momentum continuation check | COMPLETED | trailing-stop.service.ts |
| P9-007 Volume confirmation for runner | COMPLETED | trailing-stop.service.ts |
| P9-008 IV/theta risk checks for runner | COMPLETED | expiry-day-controls.service.ts |
| P9-009 Time-based exit | COMPLETED | trailing-stop.service.ts |
| P9-010 Greedy trail service | COMPLETED | greedy-trail.service.ts |
| P9-011 SL rejection escalation | COMPLETED | sl-rejection-escalation.service.ts |

---

## Phase 10 — Deterministic Risk Engine

| Task | Status | Notes |
|------|--------|-------|
| P10-001 RiskManagementService authoritative | COMPLETED | risk-management.service.ts |
| P10-002 Position sizing with lot-to-unit conversion | COMPLETED | signal-dispatcher.service.ts |
| P10-003 Realized P&L compounding | COMPLETED | portfolio.service.ts |
| P10-004 Daily loss state machine | COMPLETED | daily-loss-state-machine.service.ts |
| P10-005 Two-loss lockout | COMPLETED | daily-loss-state-machine.service.ts |
| P10-006 Maximum exposure limits | COMPLETED | risk-management.service.ts |
| P10-007 Correlated exposure limits | COMPLETED | risk-management.service.ts |
| P10-008 Duplicate trade prevention | COMPLETED | execution.service.ts (idempotency) |
| P10-009 Margin validation | COMPLETED | execution.service.ts |
| P10-010 No averaging down | COMPLETED | execution.service.ts |

---

## Phase 11 — Decision Memory

| Task | Status | File |
|------|--------|------|
| P11-001 Design decision memory schema | COMPLETED | agents/decision-memory/decision-memory.types.ts |
| P11-002 Implement DecisionMemoryService | IN_PROGRESS | agents/decision-memory/decision-memory.service.ts |
| P11-003 Add agent_decisions entity | IN_PROGRESS | database/entities/agent-decisions.entity.ts |
| P11-004 Outcome settlement logic | IN_PROGRESS | agents/decision-memory/outcome-settlement.service.ts |
| P11-005 Reflection and learning | IN_PROGRESS | agents/decision-memory/reflection.service.ts |
| P11-006 Prevent future leakage | IN_PROGRESS | agents/decision-memory/decision-memory.service.ts |

---

## Phase 12 — Dhan Execution Reliability

| Task | Status | Notes |
|------|--------|-------|
| P12-001 Durable idempotency guard | COMPLETED | execution.service.ts |
| P12-002 DB-first outbox pattern | COMPLETED | execution.service.ts |
| P12-003 Freeze quantity slicing | COMPLETED | execution.service.ts |
| P12-004 Order fill WebSocket client | COMPLETED | dhan-order-update.client.ts |
| P12-005 Order status poller fallback | COMPLETED | order-status-poller.service.ts |
| P12-006 Circuit breaker (5 failures, 60s) | COMPLETED | dhan-api.client.ts |
| P12-007 Retry with exponential backoff | COMPLETED | dhan-api.client.ts |
| P12-008 Partial fill handling | COMPLETED | execution.service.ts + poller |
| P12-009 Correlation ID crash recovery | COMPLETED | reconciliation.service.ts |
| P12-010 Token expiry detection | COMPLETED | dhan-token-watcher.service.ts |

---

## Phase 13 — Paper/Live Parity

| Task | Status | Notes |
|------|--------|-------|
| P13-001 Isolated paper engine tables | COMPLETED | paper_* tables in migration |
| P13-002 Paper mode realistic slippage | COMPLETED | paper-trading.service.ts |
| P13-003 Paper mode realistic charges | COMPLETED | trading-charges.service.ts |
| P13-004 Two-step arming for live mode | COMPLETED | live-trading.service.ts |
| P13-005 Kill switch for live mode | COMPLETED | live-trading.service.ts |
| P13-006 Kill switch Dhan account-level | COMPLETED | dhan-api.client.ts |
| P13-007 Broker P&L exit rule | COMPLETED | live-trading.service.ts |
| P13-008 Test isolation (no live orders in tests) | COMPLETED | All specs use mocks |

---

## Phase 14 — Mandatory Square-Off

| Task | Status | Notes |
|------|--------|-------|
| P14-001 15:00 IST entry stop | COMPLETED | live-trading.service.ts (CLOSING phase) |
| P14-002 15:10 IST final entry cutoff cron | COMPLETED | live-trading.service.ts |
| P14-003 15:15 IST mandatory square-off cron | COMPLETED | live-trading.service.ts |
| P14-004 15:20/15:25/15:28 escalation crons | COMPLETED | live-trading.service.ts |
| P14-005 Dhan position reconciliation before exit | COMPLETED | live-trading.service.ts |
| P14-006 Exchange calendar integration | COMPLETED | session-manager.service.ts (36 holidays) |
| P14-007 Square-off continues on AI failure | COMPLETED | Square-off crons are independent |
| P14-008 Square-off continues on WebSocket failure | COMPLETED | Uses REST getPositions() |

---

## Phase 15 — Dashboard

| Task | Status | Notes |
|------|--------|-------|
| P15-001 Market overview panel | COMPLETED | public/app.js (13 panels) |
| P15-002 Scanner/signals panel | COMPLETED | public/app.js |
| P15-003 Options chain intelligence | COMPLETED | /options-intelligence/chain |
| P15-004 Multi-agent analysis panel | IN_PROGRESS | Needs AgentsModule |
| P15-005 P&L and open positions | COMPLETED | public/app.js |
| P15-006 Trade journal panel | COMPLETED | public/app.js |
| P15-007 Monitoring/health panel | IN_PROGRESS | Needs LocalMarketWatchdog |
| P15-008 Auto-remediation status panel | IN_PROGRESS | Needs LocalMarketWatchdog |

---

## Phase 16 — Local Continuous Market Monitoring & Self-Remediation ⭐ HIGHEST PRIORITY

| Task | Status | File |
|------|--------|------|
| P16-001 LocalMarketWatchdogService | IN_PROGRESS | src/modules/watchdog/local-market-watchdog.service.ts |
| P16-002 Issue registry (monitoring_issues table) | IN_PROGRESS | database/entities/monitoring-issues.entity.ts |
| P16-003 Migration for monitoring_issues | IN_PROGRESS | migrations/AddMonitoringIssues.ts |
| P16-004 Issue classification (P0/P1/P2/P3) | IN_PROGRESS | watchdog/issue-classifier.service.ts |
| P16-005 Auto-remediation engine | IN_PROGRESS | watchdog/auto-remediation.service.ts |
| P16-006 Safe fix executor | IN_PROGRESS | watchdog/safe-fix-executor.service.ts |
| P16-007 Terminal log collector | IN_PROGRESS | watchdog/log-collector.service.ts |
| P16-008 Continuous remediation loop | IN_PROGRESS | watchdog/remediation-loop.service.ts |
| P16-009 Kiro hook: PostFileSave regression check | IN_PROGRESS | .kiro/hooks/regression-on-save.json |
| P16-010 Kiro hook: PostTaskExec test runner | IN_PROGRESS | .kiro/hooks/test-after-task.json |
| P16-011 Kiro hook: SessionStart health check | IN_PROGRESS | .kiro/hooks/session-start-health.json |
| P16-012 Dashboard: Live System Health panel | IN_PROGRESS | public/app.js (new panel) |
| P16-013 WatchdogModule registered in AppModule | IN_PROGRESS | app.module.ts |
| P16-014 Issue registry controller | IN_PROGRESS | watchdog/watchdog.controller.ts |
| P16-015 Resource budget enforcement | IN_PROGRESS | watchdog/watchdog.config.ts |

---

## Phase 17 — Testing and Validation

| Task | Status | Notes |
|------|--------|-------|
| P17-001 Unit tests for all new modules | IN_PROGRESS | Per-module spec files |
| P17-002 Integration tests for watchdog | NOT_STARTED | test/watchdog.integration.spec.ts |
| P17-003 Failure injection tests (27 scenarios) | NOT_STARTED | test/failure-injection.spec.ts |
| P17-004 Auto-remediation validation tests | NOT_STARTED | watchdog/auto-remediation.spec.ts |
| P17-005 Recovery tests (restart during square-off, etc.) | NOT_STARTED | test/recovery.spec.ts |
| P17-006 Agent workflow tests | NOT_STARTED | agents/agents.spec.ts |
| P17-007 Backtest walk-forward validation | COMPLETED | backtest.service.spec.ts |

---

## Phase 18 — Local Startup and Operation

| Task | Status | File |
|------|--------|------|
| P18-001 npm run dev:all startup script | IN_PROGRESS | scripts/start-dev.sh (updated) |
| P18-002 npm run health command | IN_PROGRESS | scripts/health-check.sh |
| P18-003 npm run issues command | IN_PROGRESS | scripts/show-issues.sh |
| P18-004 npm run dev:watchdog command | IN_PROGRESS | package.json scripts |
| P18-005 npm run validate command | IN_PROGRESS | package.json scripts |
| P18-006 Pre-flight checks (PG, Redis, env) | IN_PROGRESS | scripts/pre-flight.sh |
| P18-007 Database migration on startup | COMPLETED | migration:run in package.json |

---

## Phase 19 — Implementation Tracking

| Task | Status | Notes |
|------|--------|-------|
| P19-001 Create this tracker | COMPLETED | This file |
| P19-002 Keep tracker updated throughout development | IN_PROGRESS | Active |
| P19-003 Final validation report | NOT_STARTED | docs/FINAL_VALIDATION.md |

---

## Phase 20 — Final Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| All required modules developed | IN_PROGRESS (new modules being built) |
| Existing functionality preserved | COMPLETED (1,489 tests passing) |
| Multi-agent workflow operational | IN_PROGRESS |
| Options intelligence operational | COMPLETED |
| Sniper engine operational | COMPLETED |
| Target and runner operational | COMPLETED |
| Paper/live separation verified | COMPLETED |
| Dhan integration tested | COMPLETED |
| Dashboard operational | COMPLETED (needs new panels) |
| Local monitoring operational | IN_PROGRESS |
| Issue registry operational | IN_PROGRESS |
| Automatic safe remediation | IN_PROGRESS |
| Complete profitability-oriented test plan | COMPLETED (MASTER_TEST_PLAN.md) |
| Walk-forward testing | COMPLETED |
| Out-of-sample validation | COMPLETED |
| Realistic charges and slippage | COMPLETED |
| Deterministic risk engine | COMPLETED |
| Correct lots and units | COMPLETED |
| Durable order idempotency | COMPLETED |
| Broker reconciliation | COMPLETED |
| Stop-loss protection | COMPLETED |
| Daily loss controls | COMPLETED |
| Two-loss lockout | COMPLETED |
| Mandatory square-off | COMPLETED |
| Restart recovery | COMPLETED |
| No unsafe automatic remediation | IN_PROGRESS |
| One reliable local startup workflow | IN_PROGRESS |
| Local watchdog active | IN_PROGRESS |
| Continuous issue tracking | IN_PROGRESS |
| Safe automatic fixes | IN_PROGRESS |
| Regression testing after fixes | IN_PROGRESS |

---

## Active Defects

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| BUG-001 | P2 | HistoricalCandleIngestionService uses hardcoded 'OPTIDX' for all candle requests — fails for OPTSTK instruments | IN_PROGRESS |
| BUG-002 | P2 | SystemHealthMonitorService only tracks 6 metrics, not the full watchdog scope | IN_PROGRESS |
| BUG-003 | P2 | No multi-agent intelligence engine — research decisions use rule-based signals only | IN_PROGRESS |
| BUG-004 | P3 | No persistent issue registry — monitoring issues are only in memory/logs | IN_PROGRESS |
| BUG-005 | P3 | No decision memory — agent outcomes not stored for reflection/learning | IN_PROGRESS |
| BUG-006 | P3 | MASTER_TEST_PLAN.md did not exist | RESOLVED (created in this session) |
| BUG-007 | P3 | MASTER_IMPLEMENTATION_TRACKER.md did not exist | RESOLVED (this file) |

---

## Notes

- The migrations/ directory at the project root is currently empty. The actual migrations live at `src/migrations/`.
- The `test/` directory referenced in package.json (jest-e2e.json) needs to be created for e2e tests.
- Multi-agent engine uses LLM API calls — requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` env vars.
- LocalMarketWatchdog must be configurable to run without blocking market-hours execution.


---

## Final Implementation Status Summary

### Scanner Signal Pipeline — v3.0

| Component | State | Scanner Version |
|---|---|---|
| Engine selection (LIVE/PAPER) | ✅ LIVE when armed, PAPER otherwise | v1.0 → v2.0 |
| Entry conditions | ✅ RSI/VWAP/relVol real indicators | v2.0 |
| Component scores | ✅ RSI-driven momentum, VWAP-driven alignment | v2.0 |
| Near-ATM filter | ✅ \|strike−spot\|/spot ≤ 10% | v3.0 |
| Directional CE/PE filter | ✅ CE in bull, PE in bear regimes | v3.0 |
| RSI≥55 for directional options | ✅ Option premium must be in uptrend | v3.0 |
| Position sizing | ✅ Risk-proportional via RiskManagementService | v2.0 |
| Idempotency keys | ✅ Deterministic `signal-${signalId}` | v2.0 |
| In-process submission lock | ✅ Per-instrument+direction mutex | v2.0 |

### Quantitative Results

| Simulation | Win Rate | OOS Expectancy | CI Lower | Verdict |
|---|---|---|---|---|
| Random (pre-fix) | 7.4% | ₹-173/trade | ₹-256 | UNPROFITABLE |
| v1 (DEFECT-002/003) | 15.7% | ₹+6/trade | ₹-66 | PROMISING_BUT_UNPROVEN |
| **v2 (all improvements)** | **34.2%** | **₹+220/trade** | **₹-171** | **PROMISING_BUT_UNPROVEN** |

Break-even at 33.3% win rate (2:1 R:R) — **v2 exceeds break-even**. CI crosses zero due to insufficient OOS trades (281 needed ~1,000+).

### Historical Data Infrastructure

| Component | Status |
|---|---|
| Dhan historical backfill | ✅ 341,670 candles (29 NIFTY options, Aug–Nov 2026) |
| POST /backtest/backfill | ✅ REST endpoint deployed |
| CandleQueryService | ✅ OHLCV read helper for TechnicalAnalysis |
| HistoricalDataImportService | ✅ CSV import for future data vendors |

### Test Count Progression

| Session | Test Count | Net Change |
|---|---|---|
| Baseline (Session 6) | 1,442 | — |
| Session 7 | 1,451 | +9 |
| Session 8 | 1,459 | +8 |
| Forensic audit | 1,535 | +76 |
| Post-remediation | 1,591 | +56 |
| Idempotency/lock fixes | 1,601 | +10 |
| All open items | 1,625 | +24 |
| Dhan backfill | 1,641 | +16 |
| **Near-ATM + Directional** | **1,661** | **+20** |
