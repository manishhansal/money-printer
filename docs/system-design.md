# MoneyPrinter — System Design

## Overview

MoneyPrinter is a NestJS-based autonomous trading platform targeting NSE F&O instruments via the Dhan brokerage API. It runs as a single CloudEngine process (NestJS on port 3000) paired with a Chrome Extension MV3 control plane. All communication between the extension and the engine uses WSS or HTTPS exclusively.

The engine is composed of 25+ NestJS modules wired together through two event buses: Redis pub/sub for cross-module realtime data flow (ticks, regime changes, session phases), and NestJS EventEmitter2 for intra-process domain events (signal candidates, P&L updates, exit signals). PostgreSQL stores all durable state via TypeORM with schema changes managed exclusively through migrations (`synchronize: false`).

---

## Database Entities (TypeORM)

24 TypeORM entity classes map to the following PostgreSQL tables:

| Entity Class | Table | Purpose |
|---|---|---|
| `AuditLogs` | `audit_logs` | Immutable auth and config-change audit trail; `previous_value` and `new_value` columns AES-256-GCM encrypted |
| `BrokerAccounts` | `broker_accounts` | Dhan API credentials per user; `api_key` and `access_token` encrypted at rest |
| `BrokerSessions` | `broker_sessions` | Active JWT sessions; `session_token` encrypted at rest; `isActive` flag gates every authenticated request |
| `CapitalLedgers` | `capital_ledgers` | Append-only ledger of every Dynamic Capital movement (trade P&L, deposits, withdrawals, compounding); NUMERIC columns returned as strings |
| `DailyTradingSummaries` | `daily_trading_summaries` | Per-engine per-day roll-up: trades, win rate, net P&L, max drawdown |
| `Execution` | `executions` | Individual fill records for live orders; records fill price, quantity, slippage |
| `HistoricalCandles` | `historical_candles` | OHLCV candle data used by TechnicalAnalysis and backtesting |
| `Instruments` | `instruments` | NSE F&O universe; `instrument_type` drives tradability (`TRADABLE_OPTION` vs `UNDERLYING`); in-memory tradability cache rebuilt daily at 09:15 IST |
| `MarketRegimes` | `market_regimes` | Timestamped regime classification history; one of 10 possible regime codes |
| `MarketSnapshots` | `market_snapshots` | Persisted periodic market snapshots (supplementing Redis cache) |
| `ModelEvaluations` | `model_evaluations` | Backtest model evaluation runs and their statistical results |
| `ModelVersions` | `model_versions` | ML model version registry for the adaptive strategy engine |
| `OptionChainSnapshots` | `option_chain_snapshots` | Persisted option chain data snapshots used by OptionsIntelligence |
| `Order` | `orders` | Live-engine order lifecycle; idempotency key stored to prevent duplicate broker submissions |
| `PaperExecution` | `paper_executions` | Fill records for paper engine — isolated from live `executions` table |
| `PaperOrder` | `paper_orders` | Paper engine order lifecycle — isolated from live `orders` table |
| `PaperPosition` | `paper_positions` | Open paper positions — isolated from live `positions` table |
| `PaperTrade` | `paper_trades` | Closed paper round-trips — isolated from live `trades` table |
| `Position` | `positions` | Live open positions; tracks MFE (maximum favourable excursion) and MAE (maximum adverse excursion) |
| `RiskEvents` | `risk_events` | Immutable record of every risk state transition (TWO_LOSS_LOCKOUT, EMERGENCY_HALT, KILL_SWITCH) |
| `SignalEvaluations` | `signal_evaluations` | Per-strategy signal evaluation records (8 per signal candidate cycle) |
| `Signals` | `signals` | Scored signal records; `status` transitions through active → expired/rejected; expiry checked every 10 seconds |
| `Strategies` | `strategies` | 8 strategy configurations (A–H) with compatible regimes, min R:R, concurrency limits |
| `StrategyPerformance` | `strategy_performance` | Per-strategy per-regime performance metrics; drives OOS win-rate suspension gate |
| `StrategyVersions` | `strategy_versions` | Version history for strategy parameter changes |
| `SystemHealthEvents` | `system_health_events` | Health state transitions logged by SystemHealthMonitorService |
| `Trades` | `trades` | Completed live round-trips; net P&L computed after all NSE charges |
| `UserSettings` | `user_settings` | Per-user configuration overrides for risk parameters |

> The `EngineType` discriminant (`'LIVE' | 'PAPER'`) appears as a column on `CapitalLedgers`, `RiskEvents`, and both order/position/trade table pairs. It is the structural guarantee of paper/live isolation at the database level.

---

## Redis Key Schema

Two ioredis clients are maintained: a command client (`REDIS_CLIENT`) for all get/set/del operations, and a dedicated pub/sub client (`REDIS_PUBSUB_CLIENT`) that cannot run regular commands while subscribed.

### Cache keys

| Key Pattern | TTL | Value | Writer |
|---|---|---|---|
| `mkt:snapshot:{instrument_id}` | 2 s | JSON `MarketSnapshot` (LTP, bid, ask, volume, OI) | `MarketDataCacheService` |
| `mkt:optchain:{underlying}:{expiry}` | 10 s | JSON option chain (Dhan API response) | `MarketDataCacheService` |
| `regime:current` | 300 s | Regime string (e.g. `"STRONG_BULL"`) | `MarketRegimeService` |
| `signal:score:{signal_id}` | 60 s | JSON scored signal | `SignalScoringService` |
| `session:phase:current` | persistent | Session phase string (e.g. `"MORNING_MOMENTUM"`) | `SessionManagerService` |
| `trading:armed_state` | persistent | `"DISARMED"` \| `"ARMED_PENDING"` \| `"ARMED"` | `LiveTradingService` |
| `health:{metric_name}` | 90 s | `"Healthy"` \| `"Degraded"` \| `"Down"` | `SystemHealthMonitorService` |

### Paper engine keys (isolated namespace)

| Key Pattern | Purpose |
|---|---|
| `paper:portfolio:balance` | Paper engine Dynamic Capital (NUMERIC string) |
| `paper:orders:{orderId}` | Paper order state snapshot (JSON) |
| `paper:orders:idempotency:{key}` | Duplicate-submission guard (TTL 300 s) |
| `paper:positions:{positionId}` | Paper position state snapshot (JSON) |

### Pub/sub channels

| Channel | Publisher | Subscribers |
|---|---|---|
| `events:tick:{instrument_id}` | `MarketDataModule` | `PositionMonitoringService`, `TechnicalAnalysisService`, `OptionsIntelligenceService` |
| `events:regime_change` | `MarketRegimeService` | `LiveTradingService`, `StrategyService`, `RiskManagementService` |
| `events:session_phase` | `SessionManagerService` | `LiveTradingService`, `StrategyService`, `RiskManagementService` |
| `events:paper:fill` | `PaperTradingService` | Paper engine consumers |
| `events:paper:order` | `PaperTradingService` | Paper engine consumers |
| `events:paper:position` | `PaperTradingService` | Paper engine consumers |
| `events:paper:trade` | `PaperTradingService` | Paper engine consumers |

The `events:paper:*` namespace is a hard isolation boundary — paper engine channels never overlap with live engine channels.

---

## Position Sizing Formula

```
quantity = FLOOR( Dynamic_Capital × risk_pct / (|entry_price − stop_loss| × lot_size) )
```

Where:
- `Dynamic_Capital` — current capital balance (NUMERIC, INR)
- `risk_pct` — effective risk percentage for the signal (e.g. `0.01` for 1%)
- `|entry_price − stop_loss|` — per-unit risk; Gate 2 (ZERO_PER_UNIT_RISK) rejects when this is 0
- `lot_size` — exchange-defined contract lot size (positive integer, Gate 3 rejects when ≤ 0)

The result is floored to a whole number of lots. The computed `risk_amount` (= `Dynamic_Capital × risk_pct`) is then tested against `MAX_PER_TRADE_LOSS_RUPEES` by Gate 4. VIX-elevated conditions cap quantity further: when India VIX > `UNUSUAL_VOLATILITY_VIX_THRESHOLD` (default 20.0), `VixPositionSizeService` enforces `VOLATILITY_PROTECTION_LIMIT_LOTS` (default 2 lots max) until VIX remains continuously below the threshold for `VIX_RESTORE_CONTINUOUS_MINUTES` (default 5 minutes).

---

## Daily Loss State Machine

The `DailyLossStateMachineService` runs an independent state machine per engine (`LIVE` and `PAPER`). The machine persists every transition to `risk_events` and publishes a `NotificationAlert` before returning.

```
                  2nd losing trade closed
  NORMAL ─────────────────────────────────────► TWO_LOSS_LOCKOUT
    │                                                  │
    │  intraday net loss ≥ DAILY_LOSS_LIMIT_RUPEES     │  intraday net loss ≥ limit
    ▼                                                  ▼
  EMERGENCY_HALT ◄──────────────────────────── EMERGENCY_HALT

  Any state ──────── kill switch activated ──────────► KILL_SWITCH_ACTIVE
```

State details:

- **NORMAL** → new entry signals are permitted.
- **TWO_LOSS_LOCKOUT** → triggered when the 2nd trade of the calendar day closes with negative net P&L. New entry submissions are blocked for the remainder of the trading day. Publishes a WARNING alert.
- **EMERGENCY_HALT** → triggered when intraday net loss reaches or exceeds `DAILY_LOSS_LIMIT_RUPEES` (default ₹10,000). Publishes a CRITICAL alert. Can be reached from either NORMAL or TWO_LOSS_LOCKOUT.
- **KILL_SWITCH_ACTIVE** → reachable from any state via manual activation. Requires explicit operator intervention to clear — never auto-reset. Publishes a MAX-priority alert.

TWO_LOSS_LOCKOUT and EMERGENCY_HALT reset automatically to NORMAL at 00:00 IST via `@Cron('0 0 * * *', { timeZone: 'Asia/Kolkata' })`. The losing-trade counter also resets at midnight.

A persistence failure on `risk_events` is logged but never reverts the in-memory state — safety-critical transitions are never rolled back due to storage errors.

---

## Two-Step Arming State Machine

```
  DISARMED ──(requestArm / "Activate" click)──► ARMED_PENDING
                                                      │
                                             (confirmArm / "Confirm" click)
                                                      │
                                                      ▼
                                                   ARMED

  Any state ──(disarm / "Disarm" click)──► DISARMED
```

The constraint `DISARMED → ARMED` in a single action is structurally impossible. `requestArm()` only advances to `ARMED_PENDING`; a second, independent user action (`confirmArm()`) is required to reach `ARMED`. On CloudEngine startup the `trading:armed_state` Redis key is always overwritten with `DISARMED` regardless of its prior value. The Chrome Extension BSW applies the same rule: on every restart, any stored ARMED or ARMED_PENDING state is reverted to DISARMED before the WSS connection is re-established.

---

## Liquidity Score (5 Components)

The liquidity score is a weighted composite used by `InstrumentDiscoveryService` to rank tradable options before admission to the active universe:

| Component | Weight | Description |
|---|---|---|
| `volume_vs_30d_avg` | 25% | Today's session volume relative to the 30-day average session volume |
| `open_interest` | 25% | Absolute open interest (higher OI = more liquid) |
| `inverted_spread` | 20% | Inverse of the bid-ask spread (tighter spread = higher score) |
| `depth_top_5` | 15% | Total liquidity available in the top 5 price levels of the order book |
| `qty_at_best` | 15% | Quantity available at the best bid/ask (immediate fill potential) |

Final score = Σ(component × weight), scaled 0–100.

---

## Signal Score (8 Components, Max 100)

Every signal candidate is scored by `SignalScoringService` before it reaches the risk gates. The composite score is the arithmetic sum of 8 weighted components:

| Component | Max Points | Description |
|---|---|---|
| `regimeAlignment` | 15 | Whether the current market regime is in the strategy's `compatible_regimes` list |
| `priceStructure` | 15 | Quality of support/resistance levels and trend alignment |
| `volumeConfirmation` | 15 | Volume corroborating the price move |
| `momentum` | 10 | RSI, MACD, and other momentum indicator alignment |
| `vwapTrendAlignment` | 10 | VWAP position and trend direction alignment |
| `optionsFuturesConfirmation` | 15 | OI, PCR, IV skew, and futures basis confirmation |
| `liquidityExecution` | 10 | Bid-ask spread and depth feasibility for the target size |
| `rrQuality` | 10 | Risk:Reward quality of the specific entry/stop/target configuration |

**Total: 100 points**

Enforcement rules:
- `rrQuality` is **forced to 0** when the signal's R:R ratio falls below the strategy's `min_rr_ratio` (even if the caller supplies a non-zero value).
- Signals with composite score < 80 are **rejected** with reason `"score below threshold"` and are never forwarded to the execution pipeline.
- Signal expiry is checked every 10 seconds; signals exceeding `max_validity_duration_seconds` (default 300 s) are marked `"expired"`.

The `suppressOptionsFuturesScore` flag on the `OptionsFlowDashboard` forces the `optionsFuturesConfirmation` component to be treated as 0 when any options flow snapshot is older than 60 seconds.

---

## NSE Cost Model

Trading costs are computed identically by both the live engine (via `TradeJournalService`) and the paper engine (via `PaperTradingService`). All six cost categories are applied:

| Charge | Formula | Applied To |
|---|---|---|
| Brokerage | ₹20 flat per executed order | Each filled order |
| STT (Securities Transaction Tax) | 0.05% of turnover | Sell side only (equity F&O options premium) |
| Exchange Transaction Charges | 0.053% of turnover | Both sides |
| GST | 18% of (Brokerage + Exchange Charges) | Both sides |
| SEBI Charges | ₹10 per crore of turnover | Both sides |
| Stamp Duty | 0.003% of turnover | Buy side only |

Net P&L = Gross P&L − Sum of all six charges. The `net_pnl` field on `Trades` and `PaperTrades` reflects this post-cost figure. Property-based tests in `trade-journal-net-pnl.pbt.spec.ts` verify the integer-arithmetic P&L implementation across arbitrary decimal inputs using fast-check with a minimum of 100 iterations.

---

## Market Regime Classifier (10 Regimes)

The `MarketRegimeService` classifies the market into exactly one of 10 mutually exclusive regimes using 10 indicator inputs (NIFTY trend, BANKNIFTY trend, market breadth, A/D ratio, VWAP deviation, India VIX, ATR, relative volume, sector strength, futures basis):

| Regime | Description |
|---|---|
| `STRONG_BULL` | Both NIFTY and BANKNIFTY bullish, broad breadth, elevated volume |
| `WEAK_BULL` | NIFTY bullish, moderate breadth, average volume |
| `STRONG_BEAR` | Both indices bearish, weak breadth, elevated sell volume |
| `WEAK_BEAR` | NIFTY bearish, weak breadth |
| `SIDEWAYS` | Both indices sideways, neutral breadth, low volume |
| `HIGH_VOL` | India VIX exceeds `HIGH_VOLATILITY_VIX_THRESHOLD`; evaluated first (VIX override rule) |
| `LOW_VOL` | Extremely low relative volume |
| `BREAKOUT` | Volume surge with significant price expansion beyond ATR |
| `REVERSAL` | Price structure diverges from prevailing trend |
| `UNSTABLE` | Conflicting signals; catch-all when no other regime matches |

The `HIGH_VOL` override is always evaluated first — when VIX is elevated the classifier returns `HIGH_VOL` regardless of other indicators. Regime changes are published to `events:regime_change` and cached at `regime:current` (TTL 300 s) within 30 seconds of the triggering condition.

---

## NSE Session Phases

`SessionManagerService` runs a cron every minute and publishes `SessionPhaseChangeEvent` to `events:session_phase` on transitions:

| Phase | IST Window |
|---|---|
| `PRE_MARKET` | 09:00–09:15 |
| `OPENING_VOLATILITY` | 09:15–09:20 |
| `ORB_FORMATION` | 09:20–09:30 |
| `MORNING_MOMENTUM` | 09:30–11:00 |
| `MID_SESSION` | 11:00–13:00 |
| `AFTERNOON` | 13:00–14:30 |
| `CLOSING` | 14:30–15:30 |
| `EOD_RECONCILIATION` | 15:30–16:00 |
| `MARKET_CLOSED` | Outside 09:00–16:00 |

---

## 8 Pre-Entry Risk Gates

`RiskManagementService.evaluatePreEntryGates()` runs gates in strict order, returning the first failure immediately:

1. **SIGNAL_SCORE** — composite score ≥ 80
2. **ZERO_PER_UNIT_RISK** — |entry − stop| > 0
3. **INVALID_LOT_SIZE** — lot_size > 0
4. **PER_TRADE_LOSS** — risk_amount ≤ `MAX_PER_TRADE_LOSS_RUPEES`
5. **TOTAL_EXPOSURE** — (current + new order notional) ≤ `Dynamic_Capital × MAX_EXPOSURE_PCT / 100`
6. **CORRELATED_EXPOSURE** — same-underlying total ≤ `Dynamic_Capital × MAX_CORRELATED_PCT / 100`
7. **CONCURRENT_TRADES** — open_positions_count < `MAX_CONCURRENT_TRADES`
8. **CONCENTRATION** — single-instrument total ≤ `Dynamic_Capital × MAX_CONCENTRATION_PCT / 100`

---

## 5-Step Pre-Trade Execution Chain

`ExecutionService.placeOrder()` runs checks in order, aborting at first failure:

0. **duplicate-order-rejected** — Redis idempotency key already exists (TTL 300 s)
1. **score-below-threshold** — `compositeScore` < 80
2. **risk-engine-rejected** — `RiskManagementService.evaluatePreEntryGates()` rejected
3. **insufficient-margin** — available margin < required margin
4. **duplicate-order** — open order already exists for same instrument + direction
5. **session-time-violation** — current phase is not an active trading phase

Only after all 5 checks pass does the service submit to the Dhan broker API.

---

## Paper/Live Isolation

Complete isolation is enforced at three levels:

| Layer | Live Engine | Paper Engine |
|---|---|---|
| DB tables | `orders`, `executions`, `positions`, `trades` | `paper_orders`, `paper_executions`, `paper_positions`, `paper_trades` |
| Redis keys | `portfolio:balance`, `orders:{id}` | `paper:portfolio:balance`, `paper:orders:{id}` |
| Event channels | `events:fill`, `events:order` | `events:paper:fill`, `events:paper:order` |
| Dhan API | Real orders via `DhanApiClient` | Never calls `DhanApiClient` |

The paper engine supports three configurable slippage models (`fixed_rupee`, `percentage`, `market_impact`) and latency simulation (`uniform`, `normal`, `log_normal` with mean 10–5000 ms). It applies the identical NSE cost model as the live engine.

---

## Strategy Catalogue (8 Strategies)

| Code | Name | Compatible Regimes | Min R:R | Max Concurrent Positions | Opening Phase |
|---|---|---|---|---|---|
| A | Opening Range Breakout | BREAKOUT, STRONG_BULL, STRONG_BEAR | 1.5 | 3 | ✓ |
| B | VWAP Reclaim and Rejection | WEAK_BULL, WEAK_BEAR, REVERSAL | 1.5 | 3 | ✗ |
| C | Momentum Expansion | STRONG_BULL, STRONG_BEAR, BREAKOUT | 2.0 | 2 | ✗ |
| D | Breakout and Retest | BREAKOUT, STRONG_BULL, STRONG_BEAR | 2.0 | 2 | ✗ |
| E | Trend Continuation | STRONG_BULL, WEAK_BULL, STRONG_BEAR, WEAK_BEAR | 1.5 | 3 | ✗ |
| F | Liquidity Sweep and Reversal | REVERSAL, UNSTABLE | 2.0 | 2 | ✗ |
| G | Fair Value Gap and Market Structure | STRONG_BULL, STRONG_BEAR, WEAK_BULL, WEAK_BEAR | 2.0 | 2 | ✗ |
| H | Options Flow Intelligence | STRONG_BULL, STRONG_BEAR, BREAKOUT, HIGH_VOL | 1.5 | 3 | ✗ |

Strategies auto-suspend when the OOS win rate drops below the configured `minPerformanceThreshold`. Reinstatement requires passing 4 compliance gates: positive out-of-sample expectancy, max drawdown ≤ threshold, ≥ 30 trades per tested regime, and ≥ 95% of 1,000 Monte Carlo bootstrap iterations yielding positive expectancy.
