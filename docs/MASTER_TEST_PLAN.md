# MoneyPrinter — Master Test Plan
**Last updated:** 2026-11-12  
**Coverage target:** 100% of critical paths, ≥80% overall  
**Test framework:** Jest (NestJS), fast-check (property-based), ts-jest

---

## 1. Test Categories

| Category | Framework | Runner | Status |
|----------|-----------|--------|--------|
| Unit tests | Jest | `npm test` | 1,489 tests passing |
| Property-based | fast-check | `npm test` | Partial |
| Integration tests | Jest + DB | `npm run test:integration` | To build |
| E2E tests | Jest + Supertest | `npm run test:e2e` | To build |
| Backtest suite | Jest | `npm run test:quant` | Partial |
| Failure injection | Jest | `npm run test:failure` | To build |
| Watchdog tests | Jest | `npm run test:watchdog` | To build |

---

## 2. Profitability Hypotheses

Each hypothesis below defines a testable trading strategy. Tests must NOT pre-assume profitability — a strategy is allowed to fail the test.

### H-001: ORB Breakout (Opening Range Breakout)

| Field | Value |
|-------|-------|
| ID | H-001 |
| Strategy | ORB Breakout |
| Market conditions | First 15-min candle range established, vol > ADV, regime ≠ SIDEWAYS |
| Entry criteria | Price breaks above/below ORB high/low with volume surge ≥ 1.5× ADV |
| Strike selection | ATM ± 1 strike, delta 0.35–0.55, IV < 70th percentile |
| Stop-loss | ORB midpoint or ATR(14) × 1.0 from entry |
| Target 1 | 1.5× risk |
| Runner target | 2.5× risk (ATR trailing) |
| Hold period | ≤ 90 minutes |
| Invalidation | ORB range > 2.5× ATR (too wide), or VIX > 25 |
| Acceptance | Win rate ≥ 45%, profit factor ≥ 1.3, MDD ≤ 20% capital/session |
| Out-of-sample window | Last 90 trading days |
| Min sample size | n ≥ 50 out-of-sample trades |

### H-002: VWAP Reclaim

| Field | Value |
|-------|-------|
| ID | H-002 |
| Strategy | VWAP Reclaim / Bounce |
| Market conditions | Trending market (STRONG_BULL or STRONG_BEAR), price dips to VWAP and bounces |
| Entry criteria | LTP within 0.1% of VWAP, prior trend momentum, RSI > 40 (bullish) |
| Strike selection | ATM, delta 0.40–0.55, low IV regime |
| Stop-loss | 0.3% below VWAP (1.0× ATR) |
| Target 1 | 1.5× risk |
| Acceptance | Win rate ≥ 48%, profit factor ≥ 1.4 |
| Min sample size | n ≥ 60 |

### H-003: VWAP Rejection (False Reclaim)

| Field | Value |
|-------|-------|
| ID | H-003 |
| Strategy | VWAP Rejection |
| Market conditions | Downtrend, failed reclaim of VWAP |
| Entry criteria | Price touches VWAP from below, unable to hold, turns back down with volume |
| Option type | PE buy |
| Acceptance | Win rate ≥ 42%, profit factor ≥ 1.2 |

### H-004: Momentum Expansion

| Field | Value |
|-------|-------|
| ID | H-004 |
| Strategy | Momentum Expansion after consolidation |
| Market conditions | Volatility compression (ATR < 50th percentile over 20 candles) followed by expansion |
| Entry criteria | ATR expands > 1.5× compressed ATR, EMA(9) > EMA(21), MACD crossover |
| Acceptance | Win rate ≥ 44%, profit factor ≥ 1.35 |

### H-005: Breakout + Retest

| Field | Value |
|-------|-------|
| ID | H-005 |
| Strategy | Breakout and Retest |
| Market conditions | Key level broken on volume, then retested as support |
| Entry criteria | Price breaks key level, retests it (within 0.5× ATR), holds for ≥ 1 candle |
| Acceptance | Win rate ≥ 46%, profit factor ≥ 1.4 |

### H-006: Liquidity Sweep + Reversal

| Field | Value |
|-------|-------|
| ID | H-006 |
| Strategy | Liquidity Sweep / Stop Hunt Reversal |
| Market conditions | Range-bound market, identifiable stop clusters above/below |
| Entry criteria | Quick wick sweep of liquidity zone, rapid reversal candle, volume spike |
| Acceptance | Win rate ≥ 40%, but avg win > 2.0× avg loss |

### H-007: Options Premium Momentum

| Field | Value |
|-------|-------|
| ID | H-007 |
| Strategy | Options Premium Momentum |
| Market conditions | IV expanding, underlying directional, PCR diverging |
| Entry criteria | CE/PE premium accelerating > 15% in 5 min with OI build |
| Acceptance | Win rate ≥ 38%, profit factor ≥ 1.5 (high avg win) |

### H-008: Expiry Day Theta Crush

| Field | Value |
|-------|-------|
| ID | H-008 |
| Strategy | Expiry Day Gamma Scalp |
| Market conditions | Weekly expiry day, range established by 10:00 IST |
| Entry criteria | Tight range, sell far OTM, buy ATM as hedge — NOTE: MoneyPrinter buys options only, so this is ATM buy on breakout |
| Acceptance | Positive after all expiry-day controls applied, restricted entry window |

---

## 3. Functional Test Cases

### 3.1 Market Data Tests

| ID | Test | Expected | Priority |
|----|------|----------|----------|
| FT-001 | MarketDataService detects stale feed after 5s no-tick | Emits market.data.stale event | P0 |
| FT-002 | MarketDataService recovers on fresh tick after stale | Emits market.data.fresh event | P0 |
| FT-003 | MarketDataCacheService publishes tick to events:tick:{id} | Redis pub/sub message received | P1 |
| FT-004 | Day-open price tracked for change% computation | changePct correct after day-open set | P1 |
| FT-005 | Missing instrument snapshot handled gracefully | No crash, returns null | P2 |
| FT-006 | HistoricalCandleIngestion batches 5 instruments with 500ms delay | No rate limit errors | P2 |

### 3.2 Instrument Discovery Tests

| ID | Test | Expected | Priority |
|----|------|----------|----------|
| FT-010 | InstrumentMasterService rejects instrument with missing lot_size | Skips record with warning | P0 |
| FT-011 | InstrumentDiscovery marks instrument isTradable=false when liquidity < threshold | isActive=false | P1 |
| FT-012 | InstrumentDiscovery falls back to prior universe on scan failure | Same universe retained | P1 |
| FT-013 | INDEX instruments never become isTradable | isTraable=false always | P0 |
| FT-014 | Lot size UPSERT updates existing stale lot size | lotSize updated | P0 |

### 3.3 Signal and Strategy Tests

| ID | Test | Expected | Priority |
|----|------|----------|----------|
| FT-020 | StrategyService seeds 8 strategies A-H on startup | All 8 present in DB | P1 |
| FT-021 | Signal with compositeScore < 80 rejected by ExecutionService | status=rejected | P0 |
| FT-022 | Signal with valid score, regime mismatch rejected at strategy gate | gate=regime | P1 |
| FT-023 | Signal with valid score accepted in PAPER mode | Paper order placed | P1 |
| FT-024 | Duplicate signal for same instrument+direction rejected by idempotency | Duplicate rejected | P0 |
| FT-025 | SniperEntryService rejects signal outside LTP range | REJECT classification | P1 |
| FT-026 | SniperEntryService rejects signal with spread > threshold | REJECT classification | P1 |
| FT-027 | Signal expires after configured duration | status=expired | P2 |

### 3.4 Execution Tests

| ID | Test | Expected | Priority |
|----|------|----------|----------|
| FT-030 | ExecutionService rejects LIVE order when engine not ARMED | rejectedBy=engine-not-armed | P0 |
| FT-031 | ExecutionService persists DB record BEFORE broker submission | DB record created on broker failure | P0 |
| FT-032 | Idempotency key collision returns existing orderId | No duplicate broker submission | P0 |
| FT-033 | quantity not multiple of lotSize rejected | rejectedBy=risk-engine-rejected | P0 |
| FT-034 | quantity > freezeQuantity auto-sliced into N sub-orders | N sub-orders submitted | P1 |
| FT-035 | Insufficient margin check blocks order | rejectedBy=insufficient-margin | P0 |
| FT-036 | Duplicate open order check blocks same instrument+direction | rejectedBy=duplicate-order | P0 |
| FT-037 | Averaging down blocked (open LONG position + new BUY) | rejectedBy=risk-engine-rejected | P0 |
| FT-038 | PAPER orders bypass armed-state check | Paper order proceeds | P0 |
| FT-039 | Dhan timeout retried with exponential backoff | 3 retries, then failure | P1 |
| FT-040 | Dhan 429 rate limit queued | Queued and retried after Retry-After | P1 |
| FT-041 | Dhan 5xx retried 3 times | 3 retries with 500/1000/2000ms | P1 |
| FT-042 | Unknown order state after broker submission left as 'pending' | No silent loss | P0 |
| FT-043 | Partial fill updates filled_quantity and status=partial | DB updated | P1 |

### 3.5 Risk Engine Tests

| ID | Test | Expected | Priority |
|----|------|----------|----------|
| FT-050 | First losing trade increments losingTradeCount to 1 | count=1 | P0 |
| FT-051 | Second losing trade triggers TWO_LOSS_LOCKOUT | state=TWO_LOSS_LOCKOUT | P0 |
| FT-052 | TWO_LOSS_LOCKOUT blocks new entries | isNewEntryBlocked=true | P0 |
| FT-053 | Daily loss limit breach triggers EMERGENCY_HALT | state=EMERGENCY_HALT | P0 |
| FT-054 | KILL_SWITCH_ACTIVE not reset at midnight | state remains KILL_SWITCH_ACTIVE | P0 |
| FT-055 | TWO_LOSS_LOCKOUT reset at midnight IST | state=NORMAL next day | P1 |
| FT-056 | Winning trade does NOT increment losingTradeCount | count unchanged | P1 |
| FT-057 | Unrealized P&L does NOT inflate compounding base | Only realized P&L compounds | P0 |

### 3.6 Position Monitoring Tests

| ID | Test | Expected | Priority |
|----|------|----------|----------|
| FT-060 | TargetAndRunnerService books whole-lot partial at Target 1 | Whole lot closed | P0 |
| FT-061 | Break-even transition sets SL to entry price after Target 1 | SL = entry price | P0 |
| FT-062 | Trailing stop activates after break-even set | Trailing active | P1 |
| FT-063 | Runner terminated when continuation conditions fail (IV, theta) | Position closed | P1 |
| FT-064 | Manual broker position changes detected by reconciliation | Discrepancy raised | P1 |
| FT-065 | SL rejection escalation 1st/2nd: replacement submitted | SUBMIT_REPLACEMENT action | P0 |
| FT-066 | SL rejection escalation ≥3rd: entries disabled | DISABLE_ENTRIES action | P0 |
| FT-067 | User ACK resets rejection counter to 0 | count=0, entries re-enabled | P0 |

### 3.7 Square-Off Tests

| ID | Test | Expected | Priority |
|----|------|----------|----------|
| FT-070 | 15:00 IST CLOSING phase blocks new entries | isNewEntryBlocked=true | P0 |
| FT-071 | 15:15 IST mandatory square-off submitted via MARKET order | SELL/BUY submitted for all positions | P0 |
| FT-072 | Square-off uses Dhan reconciled qty not stale DB qty | Actual Dhan netQty used | P0 |
| FT-073 | Square-off continues when backend restarts (Dhan fallback) | REST getPositions used | P0 |
| FT-074 | 15:28 IST critical alert for unresolved positions | MAX-priority alert | P0 |
| FT-075 | Position already flat on Dhan (netQty=0) skipped | No duplicate exit order | P1 |

### 3.8 Reconciliation Tests

| ID | Test | Expected | Priority |
|----|------|----------|----------|
| FT-080 | EOD reconciliation runs at 15:30 IST | ReconciliationRun record created | P1 |
| FT-081 | Discrepancy halts new order submissions | isNewOrdersHalted=true | P0 |
| FT-082 | Reconnection reconciliation completes in ≤30s | No timeout | P1 |
| FT-083 | Reconnection reconciliation timeout halts orders | Halt + CRITICAL alert | P0 |
| FT-084 | Unrecognized Dhan execution triggers CRITICAL alert | Alert published within 10s | P0 |
| FT-085 | Stale pending orders on startup reconciled via correlationId | status=submitted or rejected | P0 |
| FT-086 | P&L agreement verified within ₹1.00 tolerance | agreement=true | P1 |

### 3.9 Failure Scenario Tests (28 Scenarios)

| ID | Scenario | Expected Behavior |
|----|----------|-------------------|
| FS-001 | Dhan API timeout | Circuit breaker records failure; 3-retry backoff; alert if circuit opens |
| FS-002 | Dhan 429 rate limit | Request queued; retried after Retry-After; alert if queue full |
| FS-003 | Dhan 5xx server error | 3-retry with 500/1000/2000ms backoff |
| FS-004 | WebSocket disconnect | Reconnect with backoff (1→2→4→8→16→30s max); reconciliation triggered |
| FS-005 | Duplicate broker update (same fill received twice) | Second ignored via idempotency/poller dedup |
| FS-006 | Partial fill | filled_quantity updated; status=partial; position opened on full fill |
| FS-007 | Unknown order (no broker confirmation) | DB stays 'pending'; reconciliation recovers via correlationId |
| FS-008 | Redis failure | Fallback to DB-only; no crash; health metric updated |
| FS-009 | PostgreSQL failure | Startup exits with code 1; running: error logged; no data loss |
| FS-010 | LLM provider outage | Agent workflow times out; fallback to signal-only (rule-based) execution |
| FS-011 | Malformed agent output | Schema validation rejects; logged; no execution triggered |
| FS-012 | Stale market data | market.data.stale emitted; scanner paused; alert sent |
| FS-013 | Invalid lot size (zero/null) | Signal rejected at dispatch; logged |
| FS-014 | Wrong quantity (not multiple of lot size) | ExecutionService rejects; logged |
| FS-015 | Stop-loss order rejected by broker | SlRejectionEscalationService handles (1-2: replacement, ≥3: disable entries) |
| FS-016 | Missing position protection (no SL set) | MonitoringService alerts; PositionMonitoringService re-registers SL |
| FS-017 | Local process crash | Startup reconciliation recovers stale pending orders |
| FS-018 | Terminal error (unhandled exception) | GlobalExceptionFilter captures; JournalWiringService logs health event |
| FS-019 | Watchdog crash | Watchdog restarts via NestJS lifecycle; issues preserved in DB |
| FS-020 | Watchdog restart with active issues | Issues re-detected from DB; remediation continues |
| FS-021 | Duplicate issue detection | Deduplication via issue_key; occurrence_count incremented |
| FS-022 | Automatic fix failure | Rolled back; issue status set to FIX_IN_PROGRESS → DETECTED (reopened) |
| FS-023 | Regression after a fix | Re-audit detects regression; issue reopened; previous fix reverted |
| FS-024 | Unsafe fix attempted on live trading module | Fix blocked; REQUIRES_HUMAN_APPROVAL set |
| FS-025 | Manual approval required for trading-critical fix | Alert sent; fix paused; waits for user confirmation |
| FS-026 | Square-off failure (Dhan submission error) | CRITICAL alert; retry at 15:20/15:25/15:28; MAX alert if unresolved |
| FS-027 | Restart during square-off | On restart, positions found open; square-off re-triggered |
| FS-028 | Market data interruption during open position | Position monitoring continues; SL unchanged; alert sent |

---

## 4. Performance and Profitability Metrics

For each executed strategy backtest, the following metrics must be computed:

| Metric | Description | Target |
|--------|-------------|--------|
| Net Expectancy | Avg net P&L per trade after all costs | > ₹0 OOS |
| Win Rate | Winning trades / total trades | ≥ 40% |
| Avg Win | Average P&L of winning trades | > 2× avg loss |
| Avg Loss | Average P&L of losing trades | Per risk rules |
| Profit Factor | Gross profit / gross loss | ≥ 1.3 |
| Max Drawdown | Peak-to-trough capital reduction | ≤ 20% |
| Consecutive Losses | Maximum losing streak | Triggers lockout at 2 |
| Sharpe Ratio | Risk-adjusted return | ≥ 1.0 |
| Sortino Ratio | Downside risk-adjusted return | ≥ 1.5 |
| Recovery Factor | Net profit / max drawdown | ≥ 2.0 |
| MAE | Maximum Adverse Excursion | ≤ 1.5× SL |
| MFE | Maximum Favorable Excursion | Relative to target |
| Avg Hold Period | Average trade duration | Context-dependent |
| Total Charges | Brokerage + STT + GST + stamp + SEBI | Realistic NSE F&O rates |
| Slippage | Entry/exit price vs signal price | ≤ 2 ticks for liquid options |
| Bootstrap CI | 95% CI for expectancy and win rate | Positive lower bound |

---

## 5. Test Environment Requirements

| Requirement | Value |
|-------------|-------|
| PostgreSQL | Local docker (port 5435) or test DB |
| Redis | Local docker (port 6380) |
| Dhan API | Mocked in all unit/integration tests |
| LLM API | Mocked in all unit tests |
| Market data | Stored snapshots for deterministic replay |
| Live orders | NEVER submitted in automated tests |
| Test isolation | Each test uses fresh DB state (truncate/rollback) |

---

## 6. Acceptance Criteria Summary

A test phase is PASSED only when:
1. All P0 test cases pass
2. All P1 test cases pass  
3. ≥ 90% of P2 test cases pass
4. Bootstrap 95% CI lower bound > 0 for OOS expectancy (strategy tests)
5. No regression in existing 1,489 tests
6. TypeScript: 0 errors, ESLint: 0 violations
7. All failure scenarios handled gracefully (no unhandled exceptions, no data loss)

---

## 7. Test Automation Status

| Test File | Tests | Status |
|-----------|-------|--------|
| dhan-api.client.spec.ts | ~40 | PASSING |
| execution.service.spec.ts | ~40 | PASSING |
| live-trading.service.spec.ts | ~25 | PASSING |
| risk-management.service.spec.ts | ~20 | PASSING |
| daily-loss-state-machine.service.spec.ts | ~15 | PASSING |
| signal-scoring.service.spec.ts | ~20 | PASSING |
| sniper-entry.service.spec.ts | 19 | PASSING |
| target-and-runner.service.spec.ts | 23 | PASSING |
| reconciliation.service.spec.ts | ~15 | PASSING |
| backtest.service.spec.ts | ~25 | PASSING |
| options-intelligence.service.spec.ts | ~20 | PASSING |
| contract-selection.service.spec.ts | ~15 | PASSING |
| sl-rejection-escalation.service.spec.ts | ~12 | PASSING |
| session-manager.service.spec.ts | ~15 | PASSING |
| (new) agents.service.spec.ts | 0 | TO BUILD |
| (new) decision-memory.service.spec.ts | 0 | TO BUILD |
| (new) local-market-watchdog.service.spec.ts | 0 | TO BUILD |
| (new) auto-remediation.service.spec.ts | 0 | TO BUILD |
| **Total (baseline)** | **1,489** | **ALL PASSING** |
