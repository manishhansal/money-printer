# END-TO-END TRADING AUDIT — MoneyPrinter
**Audit Date:** 2026-11-12  
**Auditor Role:** Options Execution Specialist / Trading Systems Auditor  
**Commit SHA:** `5d9fd24bb8df5c6b5f0b23a7672420331b6c646e`

---

## 1. TRADING LIFECYCLE COMPONENTS

This audit traces the complete lifecycle of a trade from market data arrival through final P&L settlement.

### Pipeline Overview

```
Market Data (Dhan WebSocket)
    ↓
Redis mkt:snapshot:{securityId}
    ↓
SignalScannerService (cron, 2min)
    ↓ ← DEFECT-001: always PAPER; DEFECT-002: no entry logic; DEFECT-003: heuristic scores
SignalCandidateInput (engine='PAPER', entryConditionsMet=true)
    ↓
StrategyService.evaluateSignalCandidate()
    ↓ Gate 1: regime | Gate 2: session | Gate 3: entry (always passes) | Gate 4: R:R | Gate 5: emit
SIGNAL_CANDIDATE_EVENT
    ↓
SignalScoringService.scoreAndPersistSignal()
    ↓
SIGNAL_ACCEPTED_EVENT (if score ≥ 80)
    ↓
SignalDispatcherService.onSignalAccepted()
    ↓ → PAPER path → PaperTradingService.submitPaperOrder()
    ↓ → LIVE path → ExecutionService.placeOrder() [NEVER REACHED from scanner — DEFECT-001]
```

---

## 2. SCENARIO-BY-SCENARIO ANALYSIS

Each scenario below documents the expected lifecycle and the actual system behaviour.

---

### Scenario A — Profitable Trend Continuation

**Expected**: Market data → valid signal → contract selected → position sized → order filled → Target 1 → partial booking → runner → trailing → exit → net P&L finalized.

**Actual Status**: PARTIALLY IMPLEMENTED

| Step | Status | Notes |
|---|---|---|
| 1. Valid market data arrives | PASS_WITH_WARNINGS | Requires running services; WebSocket reconnect tested |
| 2. Regime identified | PASS | MarketRegimeService unit tested |
| 3. Strategy produces signal | FAIL | Scanner always sets entryConditionsMet=true (DEFECT-002) |
| 4. Sniper filter accepts | PASS | SniperEntryService unit tested thoroughly |
| 5. Contract selected | PASS | ContractSelectionService unit tested |
| 6. Risk engine approves | PASS | All 8 gates unit tested |
| 7. Position size calculated | PASS | BigInt arithmetic verified |
| 8. Order intent persisted | PASS | Order DB write tested |
| 9. Paper broker confirms fill | PASS | Paper trading service extensively tested |
| 10. Stop-loss confirmed | PASS_WITH_WARNINGS | Super-order SL via Dhan BLOCKED (not live tested) |
| 11. Target 1 reached | PASS | PositionMonitoringService unit tested |
| 12. Partial profit booked | PASS | TargetAndRunnerService unit tested |
| 13. Runner remains open | PASS | GreedyTrailService unit tested |
| 14. Trailing stop activates | PASS | TrailingStopService unit tested |
| 15. Runner exits | PASS_WITH_WARNINGS | Exit routing unit tested; actual fill BLOCKED |
| 16. Charges applied | PASS | TradingChargesService verified correct |
| 17. Net P&L finalized | PASS | TradeJournal.calculateNetPnl() verified |
| 18. Decision memory settled | PASS | DecisionMemoryService.settle() tested via TradeJournal wiring |

**Blocking Defects for This Scenario**: DEFECT-001 (live pipeline), DEFECT-002 (entry conditions)  
**Verdict**: PARTIALLY IMPLEMENTED — paper trading mechanics work; live path broken; signal quality unvalidated

---

### Scenario B — Immediate Stop-Loss

**Expected**: Price moves against entry immediately; stop-loss hit; exit confirmed; daily risk state updated.

**Actual Status**: PASS (paper) / BLOCKED (live)

| Step | Status | Notes |
|---|---|---|
| Stop-loss detection (tick) | PASS | PositionMonitoringService unit tested |
| Exit order submission | PASS_WITH_WARNINGS | Paper tested; live Dhan BLOCKED |
| Realized loss calculation | PASS | Net P&L calculation verified |
| Daily loss state update | PASS | DailyLossStateMachineService extensively tested |
| TWO_LOSS_LOCKOUT trigger | PASS | After 2nd net loss — verified by property tests |

**Verdict**: PASS for paper; BLOCKED for live

---

### Scenario C — False Breakout

**Expected**: Breakout signal; entry; immediate reversal; stop-loss; net loss.

**Actual Status**: PARTIALLY TESTABLE

Since strategy entry conditions are not implemented (DEFECT-002), "breakout" detection is not differentiated from other conditions. The stop-loss mechanics work correctly once a position is open.

---

### Scenario D — Partial Fill

**Expected**: Order fills partially; position reflects actual filled quantity only; risk adjusts.

**Actual Status**: PASS_WITH_WARNINGS

The `handleFill()` method in `ExecutionService` correctly handles partial fills: `status = 'partial'` when `filled_quantity < quantity`; `status = 'complete'` when equal. Tested via unit tests with mocked Dhan responses.

**Concern**: The paper trading engine uses a 100% fill assumption (no partial fill model for paper orders). This creates a gap between paper and live behaviour under low-liquidity conditions.

---

### Scenario E — Broker Response Lost

**Expected**: Broker accepts order; response is lost; system reconciles before retry.

**Actual Status**: PASS_WITH_WARNINGS

`ReconciliationService` implements reconnection reconciliation with `triggerReconnectionReconciliation()`. It compares local open orders against Dhan's order book and halts new orders on discrepancy. The 30-second timeout is tested. However, this was tested with mocked Dhan responses.

**Risk**: If the reconciliation timeout fires and Dhan API is also unresponsive, `newOrdersHalted` is set correctly, but the position remains unreconciled. Manual acknowledgment is required.

---

### Scenario F — Market Data Interruption

**Expected**: New entries blocked when feed is stale; existing positions remain protected.

**Actual Status**: PASS_WITH_WARNINGS

`SniperEntryService` rejects data with `stale_data` when `snapshot.timestamp` is older than a threshold. The scanner warns and skips if `snapshotKeys.length === 0`. However, there is no explicit "stale data detected" block on the scan loop — a stale non-empty key would still produce a scan attempt. The staleness check depends on the caller providing the timestamp.

---

### Scenario G — Application Crash

**Expected**: Crash after broker acceptance; restart recovers exact order and position state.

**Actual Status**: PARTIALLY IMPLEMENTED

On restart, `LiveTradingService.onModuleInit()` resets to DISARMED (correct). `PositionMonitoringService.onModuleInit()` reloads all open LIVE positions from the DB. `ReconciliationService.onModuleInit()` queues a stale-order check for the last 5 minutes.

**Gap**: The `signal-scanner.service.ts` and `signal-dispatcher.service.ts` have no crash-recovery logic tested. Orders submitted in-flight (intent written to DB, broker submission pending) rely on the stale-order check in reconciliation.

---

### Scenario H — Two Consecutive Losing Trades

**Expected**: Second net loss triggers TWO_LOSS_LOCKOUT; entry blocked; cannot be bypassed.

**Actual Status**: PASS

`DailyLossStateMachineService` is extensively tested including property tests. Key verifications:
- LIVE and PAPER engines maintain independent counters ✅
- Break-even trades (net_pnl = 0) do not count as losses ✅
- Winning trades do not reset the loss counter ✅
- Restart: `onModuleInit()` resets to DISARMED which is separate from the daily loss state

**Gap**: The daily loss state is maintained in-memory by `DailyLossStateMachineService`. On process restart, the state resets to NORMAL. If two losing trades occur before 15:15 and the application restarts between them, the loss counter resets. This bypass path exists but is explicitly noted in the architecture — it requires manual verification.

---

### Scenario I — Square-off Failure

**Expected**: Broker rejects exit; retries; escalation; final reconciliation.

**Actual Status**: PASS_WITH_WARNINGS

`LiveTradingService` submits MARKET SELL orders at 15:15 IST. After `SQUARE_OFF_CONFIRMATION_TIMEOUT_MS` (5 minutes), it checks order status and publishes CRITICAL alerts for unconfirmed orders. Retry logic is not explicitly implemented for rejected orders — an alert fires but re-submission is not automated.

**Risk**: If a MARKET SELL is rejected (e.g., Dhan API outage), the system alerts but does not automatically retry. Manual intervention is required.

---

### Scenario J — Runtime LLM Unavailable

**Expected**: Deterministic rule-based mode; complete trading safety lifecycle maintained.

**Actual Status**: PASS

`LLM_PROVIDER=disabled` is the default configuration. With LLM disabled, `AgentOrchestratorService` falls back to rule-based analysis. The `LlmClientService` raises `LlmUnavailableError` when provider is `disabled`, which is handled by the orchestrator. The safety controls (risk engine, square-off, reconciliation) are independent of the LLM and function correctly with no LLM.

**Verification**: Confirmed by `.env.example` setting `LLM_PROVIDER=disabled`.

---

### Scenario K — Watchdog Failure

**Expected**: Risk management and square-off remain independent of watchdog.

**Actual Status**: PASS

The watchdog (`LocalMarketWatchdogService`) monitors system health and raises issues. The mandatory square-off cron in `LiveTradingService` and the daily loss machine are completely independent of the watchdog — they would fire even if the watchdog crashed.

---

### Scenario L — Simultaneous Signals

**Expected**: Risk allocation correct; duplicates prevented; position limits enforced.

**Actual Status**: PASS_WITH_WARNINGS

`ExecutionService` has an idempotency check (Redis key) and a duplicate-order check (open orders for same instrument). The position `averaging-down` check prevents buying more of an already-held LIVE position. For PAPER trades, `signal-dispatcher.service.ts` checks for an open LONG position before dispatching.

**Gap**: Under true simultaneous execution (concurrent event loop ticks), the Redis idempotency key set/check could race if two signals for the same instrument arrive within the same event loop tick. This is a theoretical risk; in practice, Node.js single-threaded event loop makes true race conditions unlikely.

---

### Scenario M — Volatile Expiry Session

**Expected**: Bot does not enter unsuitable contracts; expiry controls active.

**Actual Status**: PASS

`ExpiryDayControlsService` adjusts position limits and risk parameters on expiry days. `SniperEntryService` applies an `extreme_iv` filter that rejects options with IV above a threshold. These controls are unit tested.

---

### Scenario N — Gap-Up and Gap-Down

**Expected**: Gap conditions handled; missed prices not assumed executable.

**Actual Status**: PARTIALLY IMPLEMENTED

The scanner reads the current LTP from Redis snapshots. If a large gap has occurred, the LTP would reflect the post-gap price. The stop-loss is calculated as 1.5% below LTP — so in a gap-down session, the entry would be near the gap price with a stop 1.5% lower.

**Gap**: There is no explicit gap-condition detection that would widen the stop, reduce position size, or block entry during the first few minutes of a gapped opening.

---

### Scenario O — Reconciliation Mismatch

**Expected**: Discrepancy detected; new orders halted; alert raised.

**Actual Status**: PASS

`ReconciliationService.compareOrdersWithDhan()` detects when a MoneyPrinter LIVE order exists in the DB but is missing from Dhan's order book. When detected: `newOrdersHalted = true`, CRITICAL alert published, audit log recorded. Clearing requires explicit `acknowledgeDiscrepancy()` call.

---

## 3. PAPER/LIVE SEPARATION VERIFICATION

This is one of the best-implemented aspects of the system.

| Separation Requirement | Status |
|---|---|
| Paper orders → `paper_orders` table only | ✅ Verified |
| Paper positions → `paper_positions` table only | ✅ Verified |
| Paper trades → `paper_trades` table only | ✅ Verified |
| Paper Redis keys prefixed `paper:*` | ✅ Verified |
| Paper events on `events:paper:*` channels only | ✅ Verified |
| Paper NEVER publishes to live channels | ✅ Explicitly tested |
| Live orders → `orders` table only | ✅ Verified |
| Live positions → `positions` table only | ✅ Verified |
| Live Redis key `trading:armed_state` not written by paper | ✅ Verified |

The paper/live isolation is **the strongest area of the codebase**. 80+ unit tests cover this isolation exhaustively.

---

## 4. EXECUTION QUALITY ASSESSMENT

### Pre-Trade Check Chain (LIVE)
```
0a. Engine ARMED?
0b. New entries blocked?
0.  Idempotency key (Redis)?
1.  Composite score ≥ 80?
2.  Risk engine all 8 gates?
3.  Available margin?
4.  Duplicate open order?
5.  Session phase?
   → Plus: quantity multiple of lotSize?
   → Plus: no averaging down?
```
All checks verified by unit tests. Order of evaluation enforced.

### Position Sizing Arithmetic
Formula: `lots = FLOOR(capital × riskPct / 100 / (|entry - stop| × lotSize))`  
Implemented using BigInt with 4 decimal places precision. ✅ Correct.

### Cost Calculations
See QUANT_PROFITABILITY_AUDIT.md §4. ✅ Correct.

---

## 5. FINDINGS SUMMARY

| Area | Grade | Key Finding |
|---|---|---|
| Paper/live separation | A | Excellent isolation; 80+ tests |
| Risk management (position sizing) | A | BigInt precision; all 8 gates tested |
| Daily loss state machine | A | Extensive coverage; property tests |
| Trading cost model | A | Correct STT, exchange, GST, SEBI |
| Paper trading mechanics | B+ | Sound fill model; no partial fill simulation |
| Stop-loss / target management | B+ | Well-implemented; not live-tested |
| Signal generation | F | Hardcoded paper mode; no entry logic; heuristic scores |
| Live trading pipeline | F | Cannot generate live orders from scanner |
| Historical data | F | Does not exist |
| Strategy differentiation | F | 8 strategies run identical code |
| Integration testing | F | No integration test suite exists |
| Agent orchestration testing | D | 1141 lines with no spec |

---

## 6. END-TO-END VERDICT

**The end-to-end trading pipeline is NOT ready for live trading activation.**

The system has genuine value in its safety infrastructure (risk controls, paper/live isolation, cost model, reconciliation framework) but cannot function as an automated trading system because:

1. The scanner cannot generate live orders (DEFECT-001)
2. No strategy has implemented entry conditions (DEFECT-002)
3. Signal scores do not reflect actual market conditions (DEFECT-003)
4. No historical data exists for validation (DEFECT-005)

For paper trading in its current form, the system would generate signals with no genuine predictive basis and would likely produce random walk results constrained by the 80-point score threshold.
