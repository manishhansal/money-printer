# Implementation Plan: MoneyPrinter — Autonomous AI-Powered Quantitative Trading Platform

## Overview

Implementation proceeds in layers: project scaffolding and database schema first, then the Dhan API integration and market data pipeline, followed by the intelligence layer (regime detection, options analysis, strategy evaluation), then the risk and execution engines, position management, record-keeping, analytics, compliance, and finally the Chrome Extension control plane. Property-based tests using `fast-check` verify the 32 universal correctness invariants throughout. All code is TypeScript; the backend is NestJS with TypeORM (PostgreSQL) and ioredis (Redis).

## Tasks

- [x] 1. Project setup and core infrastructure
  - [x] 1.1 Initialize NestJS monorepo with TypeScript strict mode, path aliases, ESLint, Prettier, and Jest configured with `fast-check` (minimum 100 iterations per property test)
    - Create `src/modules/`, `src/database/`, `src/common/` directory structure
    - Configure Jest with `--runInBand` for deterministic CI runs
    - _Requirements: 2.2, 2.5_
  - [x] 1.2 Set up TypeORM with PostgreSQL driver, UUID primary key defaults, migration framework, and Docker Compose for local development (PostgreSQL 15, Redis 7)
    - Database connection must be established within 10 seconds on startup
    - _Requirements: 2.3, 2.4_
  - [x] 1.3 Set up `ioredis` client with connection management, health-check utility, and reconnection handling; configure Redis pub/sub client (separate from command client)
    - _Requirements: 2.3_

- [x] 2. Database schema — models 1–12
  - [x] 2.1 Implement `UserSettings`, `BrokerAccounts`, `BrokerSessions`, and `Instruments` TypeORM entities with field-level AES-256-GCM encryption transformer stubs on `ENCRYPTED` columns
    - `BrokerAccounts.account_id` and `BrokerSessions.session_token` must use encryption
    - `Instruments` indexes: `(underlying, expiry_date, option_type)` and `(is_active, liquidity_score DESC)`
    - _Requirements: 16.8, 18.1_
  - [x] 2.2 Implement `MarketSnapshots`, `HistoricalCandles`, and `OptionChainSnapshots` entities with defined indexes
    - `HistoricalCandles` UNIQUE constraint on `(instrument_id, granularity, timestamp)`; index `(instrument_id, granularity, timestamp DESC)`
    - _Requirements: 18.1, 18.8_
  - [x] 2.3 Implement `MarketRegimes`, `Strategies`, `StrategyVersions`, `Signals`, and `SignalEvaluations` entities
    - `Strategies.compatible_regimes` as `TEXT[]`; `Signals` includes all 8 component score columns and `measured_inputs JSONB`
    - _Requirements: 18.1_

- [x] 3. Database schema — models 13–24
  - [x] 3.1 Implement `Orders`, `Executions`, `Positions`, and `Trades` entities
    - `Orders.idempotency_key` has a UNIQUE constraint; `Trades` includes `qcr`, `exit_classification`, and `execution_quality` columns
    - _Requirements: 16.6, 18.1_
  - [x] 3.2 Implement `CapitalLedgers`, `RiskEvents`, `DailyTradingSummaries`, `StrategyPerformance`, `ModelVersions`, and `ModelEvaluations` entities
    - `CapitalLedgers` requires `balance_before` and `balance_after` columns; `DailyTradingSummaries` UNIQUE on `(trading_date, engine)`
    - _Requirements: 18.1, 18.2_
  - [x] 3.3 Implement `SystemHealthEvents` and `AuditLogs` entities with encrypted `previous_value` and `new_value` columns
    - `AuditLogs` indexes: `(user_id, timestamp DESC)` and `(event_type, timestamp DESC)`
    - _Requirements: 16.8, 18.1_

- [x] 4. Auth, secrets, and security foundation
  - [x] 4.1 Implement `AuthModule` with `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, and `GET /auth/status` endpoints using RS256 JWTs with configurable max validity of 30 minutes
    - Every auth event (login, logout, failure, token expiry) must produce an `AuditLogs` record with user ID, event type, UTC timestamp, and outcome
    - _Requirements: 1.7, 1.8, 2.5, 16.9_
  - [x] 4.2 Implement `SecretsService` wrapping HashiCorp Vault or AWS Secrets Manager with `get`, `set`, and `rotate` methods; no secret value may appear in application logs or API responses
    - _Requirements: 3.3, 16.1, 16.2_
  - [x] 4.3 Implement AES-256-GCM TypeORM column transformer (`EncryptedColumnTransformer`) and apply it to all `ENCRYPTED` columns in `BrokerAccounts`, `BrokerSessions`, and `AuditLogs`
    - _Requirements: 16.8_
  - [x] 4.4 Implement per-endpoint rate-limiting guard (default 100 req/min per authenticated client) returning HTTP 429 with a `Retry-After` header as a strictly positive integer; implement CSRF token middleware on all state-modifying endpoints
    - State-modifying endpoints: order submission, config changes, kill switch, arm/disarm, auth actions
    - _Requirements: 16.3, 16.4, 16.5_
  - [x]* 4.5 Write unit tests for auth state transitions: login → token expiry → Extension disconnect → disarmed
    - _Requirements: 1.7, 1.8_
  - [x]* 4.6 Write property test for HTTP 429 Retry-After header
    - **Property 28: HTTP 429 Retry-After Is a Strictly Positive Integer**
    - **Validates: Requirements 16.4**
    - _Requirements: 16.4_

- [x] 5. Dhan API integration layer
  - [x] 5.1 Implement `DhanApiClient` with typed methods for all endpoint categories: authentication, live quotes, historical candles, option chains, order placement, order modification, order cancellation, positions, portfolio, tradebook, orderbook, live order updates, and Super Orders
    - Official endpoints only; fetch Dhan session token from `SecretsService`; invalidate and return auth-failure on HTTP 401/403 without retry
    - _Requirements: 3.1, 3.2, 3.3, 3.7_
  - [x] 5.2 Implement Dhan WebSocket client in `DhanApiClient` with exponential backoff reconnection (1 s → 2 s → 4 s → 8 s → 16 s capped at 30 s, 5 consecutive attempts); validate first-tick SLA ≤ 3 seconds after connection confirmation
    - _Requirements: 3.4, 3.5_
  - [x] 5.3 Implement rate-limit request queue in `DhanApiClient`: buffer up to 50 pending requests; retry after `Retry-After` window; return `rate-limit-queue-full` error to caller when queue is at capacity without adding the request
    - _Requirements: 3.6, 3.9_
  - [x]* 5.4 Write unit tests for WebSocket reconnection backoff schedule (verify delays: 1s, 2s, 4s, 8s, 16s) and connectivity-failure alert timing (≤5 seconds after 5th failure)
    - _Requirements: 3.5, 3.8_

- [x] 6. MarketData module
  - [x] 6.1 Implement `MarketDataModule`: manage the Dhan WebSocket feed subscription; publish incoming ticks to Redis pub/sub channel `events:tick:{instrument_id}`; publish `connectivity-failure` alert via `NotificationService` within 5 seconds after all 5 reconnection attempts fail
    - _Requirements: 3.8, 2.1_
  - [x] 6.2 Implement Redis cache write path in `MarketDataModule`: write `mkt:snapshot:{instrument_id}` (TTL 2 s), `mkt:optchain:{underlying}:{expiry}` (TTL 10 s), `regime:current` (TTL 300 s), `signal:score:{signal_id}` (TTL 60 s)
    - _Requirements: 18.7_
  - [x] 6.3 Implement feed-staleness detector: when market data age exceeds `max_allowed_data_age` → block new order submissions and notify `RiskEngine` via NestJS event; publish staleness alert to `NotificationService`
    - _Requirements: 9.6_
  - [x]* 6.4 Write property test for Redis cache TTL compliance
    - **Property 24: Redis Cache TTL Compliance**
    - **Validates: Requirements 18.7**
    - _Requirements: 18.7_

- [x] 7. Checkpoint — core platform complete
  - Ensure migrations run cleanly, Auth and DhanApiClient unit tests pass, and Redis/PostgreSQL connectivity is verified. Ask the user if questions arise.

- [x] 8. InstrumentDiscovery module
  - [x] 8.1 Implement `InstrumentDiscoveryModule`: scan all eligible NSE F&O instruments at 09:15 IST; classify each as `UNDERLYING` or `TRADABLE_OPTION`; persist results to `Instruments` table; ensure underlying indices are never submitted to `ExecutionService`
    - _Requirements: 4.1, 4.6_
  - [x] 8.2 Implement composite liquidity score computation (0–100) using volume vs. 30-day average (25%), open interest (25%), bid-ask spread inverted (20%), market depth sum of top-5 levels (15%), and quantity at best bid + best ask (15%)
    - _Requirements: 4.2_
  - [x] 8.3 Implement subscription quota rotation: when active subscriptions reach 90% of configured Dhan WebSocket limit → drop lowest-scored instruments until below 80%; update liquidity rankings every ≤ 5 minutes during market hours; remove instruments below configured minimum score from the active universe and unsubscribe their feeds
    - _Requirements: 4.3, 4.4, 4.5_
  - [x] 8.4 Implement scan failure fallback: if scan does not complete within 5 minutes of market open → retain prior session's instrument universe, emit `SCAN_FAILURE` to `NotificationService`, record in `SystemHealthEvents`
    - _Requirements: 4.7_
  - [x] 8.5 Enforce global OI and ADV eligibility invariants: no F&O stock option admitted to the trading universe unless both the configured minimum OI threshold and minimum ADV threshold are satisfied; apply uniformly on every scan
    - _Requirements: 4.8_
  - [x]* 8.6 Write property test for liquidity score range invariant
    - **Property 1: Liquidity Score Range Invariant**
    - **Validates: Requirements 4.2**
    - _Requirements: 4.2_
  - [x]* 8.7 Write property test for subscription rotation correctness
    - **Property 2: Subscription Rotation Correctness**
    - **Validates: Requirements 4.5**
    - _Requirements: 4.5_
  - [x]* 8.8 Write property test for eligibility threshold uniform enforcement
    - **Property 3: Eligibility Threshold Uniform Enforcement**
    - **Validates: Requirements 4.8**
    - _Requirements: 4.8_

- [x] 9. MarketRegime module
  - [x] 9.1 Implement `MarketRegimeModule`: classify the market into exactly one of 10 regimes at intervals ≤ 60 seconds using all 10 input indicators; evaluate the VIX override rule (VIX > `high_volatility_threshold` → `HIGH_VOL`) before any other classification logic; publish regime-change events to `events:regime_change` Redis channel within 30 seconds of the triggering condition
    - Regimes: `STRONG_BULL`, `WEAK_BULL`, `STRONG_BEAR`, `WEAK_BEAR`, `SIDEWAYS`, `HIGH_VOL`, `LOW_VOL`, `BREAKOUT`, `REVERSAL`, `UNSTABLE`
    - _Requirements: 5.1, 5.2, 5.3, 5.7_
  - [x] 9.2 Persist every classification to `MarketRegimes` table with timestamp, all 10 input values, and classification rationale; when regime is `UNSTABLE`, notify `RiskEngine` to apply the unstable-regime concurrent-trade limit via NestJS event
    - _Requirements: 5.4, 5.5, 5.6_
  - [x]* 9.3 Write property test for VIX override forces HIGH_VOL regime
    - **Property 4: VIX Override Forces High Volatility Regime**
    - **Validates: Requirements 5.7**
    - _Requirements: 5.7_
  - [x]* 9.4 Write property test for regime classification as a total function over 10 valid codes
    - **Property 5: Regime Classification Is a Total Function Over 10 Valid Codes**
    - **Validates: Requirements 5.1**
    - _Requirements: 5.1_

- [x] 10. TechnicalAnalysis module
  - [x] 10.1 Implement `TechnicalAnalysisModule`: compute VWAP, ATR (configurable period), EMA (9, 21, 50, 200), support/resistance levels, ORB range (first 15-minute session high/low), MACD, RSI (14), and relative volume on demand from `HistoricalCandles` and current ticks; no persistent state — all values recomputed from source data
    - _Requirements: 5.2, 6.2_

- [x] 11. OptionsIntelligence module
  - [x] 11.1 Implement `OptionsIntelligenceModule`: compute Delta, Gamma, Theta, and Vega for all candidate options contracts using live option chain data; reject any Greek values older than 60 seconds
    - _Requirements: 7.1_
  - [x] 11.2 Implement contract selection: enforce all 4 criteria simultaneously — Delta ∈ [configured_min_delta, configured_max_delta] (both in (0.01, 0.99)), IV rank ∈ [configured_min_iv_percentile, configured_max_iv_percentile] (1–100), OI ≥ configured minimum, and market depth qty at both best bid and best ask ≥ configured minimum
    - _Requirements: 7.2_
  - [x] 11.3 Implement IV regime classification per underlying: `EXPANDING` when `current_iv > baseline_avg + threshold_pp`, `CONTRACTING` when `current_iv < baseline_avg − threshold_pp`, `NEUTRAL` otherwise; independently configurable weight factors for contract selection and R:R estimation
    - _Requirements: 7.3_
  - [x] 11.4 Implement expiry-day special controls: when `trading_date = expiry_date` → apply higher signal score threshold (standard + configurable delta), reduce max position size to configured percentage (10%–90% of standard), and set mandatory square-off time to configured value (12:00–14:30 IST)
    - _Requirements: 7.4_
  - [x] 11.5 Implement Theta decay computation in ₹/calendar-day as a non-negative magnitude (≥ 0) for all open options positions; expose computed decay to `PositionMonitoringModule` as an exit condition input
    - _Requirements: 7.5_
  - [x] 11.6 Implement illiquid contract marking: when bid-ask spread > `configured_max_spread_threshold` → mark contract as illiquid; `SignalScoringModule` must receive the illiquid flag and apply the configured liquidity penalty to the Liquidity/Execution Feasibility score component
    - _Requirements: 7.6_
  - [x]* 11.7 Write property test for IV regime classification correctness
    - **Property 7: IV Regime Classification Correctness**
    - **Validates: Requirements 7.3**
    - _Requirements: 7.3_
  - [x]* 11.8 Write property test for Theta decay non-negative invariant
    - **Property 8: Theta Decay Is Non-Negative**
    - **Validates: Requirements 7.5**
    - _Requirements: 7.5_

- [x] 12. Checkpoint — data and intelligence layer complete
  - Ensure InstrumentDiscovery, MarketRegime, TechnicalAnalysis, and OptionsIntelligence unit and property tests all pass. Ask the user if questions arise.

- [x] 13. Strategy module (StrategyEngine)
  - [x] 13.1 Implement `StrategyModule` with all 8 strategies (A–H) including full configuration schemas: entry/exit/invalidation conditions, `compatible_regimes` list, `min_rr_ratio` (1.0–10.0), `max_concurrent_positions` (1–20), and `opening_phase_compatible` flag
    - _Requirements: 6.1, 6.2_
  - [x] 13.2 Implement sequential gate evaluation for each signal candidate: (1) check regime availability → skip all, record `"regime unavailable"`; (2) check regime compatibility → skip, record `"incompatible regime"`; (3) apply entry conditions; (4) compute R:R → skip if below `min_rr_ratio`; (5) generate signal and forward to `SignalScoringModule`; record every evaluation outcome in `SignalEvaluations`
    - _Requirements: 6.3, 6.4, 6.5, 6.6_
  - [x] 13.3 Implement Adaptive StrategyEngine: rank strategy priority by validated out-of-sample win rate for the current regime over trailing 20 trading days; suspend strategies below configured `min_performance_threshold` and publish a `strategy-degradation` alert; re-enable only on explicit user action; record selection rationale in `StrategyPerformance`
    - _Requirements: 6.7, 6.8, 20.2_
  - [x]* 13.4 Write property test for strategy evaluation regime gate
    - **Property 6: Strategy Evaluation Regime Gate**
    - **Validates: Requirements 6.4, 6.6**
    - _Requirements: 6.4, 6.6_

- [x] 14. SignalScoring module (SignalScorer)
  - [x] 14.1 Implement `SignalScoringModule`: compute composite score as the arithmetic sum of all 8 component scores (max 100); enforce R:R Quality component = 0 when the signal R:R ratio is strictly less than the originating strategy's `min_rr_ratio`; reject signals with composite score < 80 for live trading with status `"rejected"` and reason `"score below threshold"`
    - Components: Regime Alignment (15), Price Structure (15), Volume Confirmation (15), Momentum (10), VWAP/Trend Alignment (10), Options/Futures Confirmation (15), Liquidity/Execution Feasibility (10), R:R Quality (10)
    - _Requirements: 8.1, 8.3, 8.5_
  - [x] 14.2 Persist every signal to `Signals` table with all enumerated fields; mark signals with status `"expired"` when `max_validity_duration` is exceeded; when entry price deviates from current market price by more than the configured strategy-specific threshold before order submission → recompute composite score and re-validate against the 80-point threshold
    - _Requirements: 8.2, 8.4, 8.6, 8.7_
  - [x] 14.3 Implement Opportunity Intelligence Ranking: order all active signals by composite score, estimated expected value, and regime alignment strength; generate a natural-language explanation for each signal's ranking position
    - _Requirements: 20.1_
  - [x]* 14.4 Write property test for signal composite score is sum of components and in range
    - **Property 9: Signal Composite Score Is Sum of Components and In Range**
    - **Validates: Requirements 8.1**
    - _Requirements: 8.1_
  - [x]* 14.5 Write property test for R:R quality zero when R:R below strategy minimum
    - **Property 10: R:R Quality Zero When R:R Below Strategy Minimum**
    - **Validates: Requirements 8.5**
    - _Requirements: 8.5_
  - [x]* 14.6 Write property test for score below threshold forces live trading rejection
    - **Property 11: Score Below Threshold Forces Live Trading Rejection**
    - **Validates: Requirements 8.3**
    - _Requirements: 8.3_

- [x] 15. Portfolio module (CapitalLedger and Dynamic_Capital)
  - [x] 15.1 Implement `PortfolioModule`: maintain authoritative in-memory portfolio state (open positions + pending orders) with PostgreSQL persistence; compute `Dynamic_Capital = starting_capital + SUM(realized_net_pnl for all closed trades)` where each `realized_net_pnl = gross_pnl − (brokerage + STT + exchange_charges + GST + SEBI_charges + stamp_duty)`
    - _Requirements: 9.1, 18.2_
  - [x] 15.2 Implement `CapitalLedger` write path: after each trade closes → write `CapitalLedgers` record and recompute `Dynamic_Capital` within 500 ms; if the write or recomputation fails → immediately halt all new signal evaluations, retain last committed balance, record error in `SystemHealthEvents` within 1 second
    - Use a PostgreSQL transaction to atomically insert the `CapitalLedgers` record and update in-memory capital
    - _Requirements: 18.3, 18.4_
  - [x]* 15.3 Write property test for CapitalLedger accounting identity
    - **Property 23: CapitalLedger Accounting Identity**
    - **Validates: Requirements 18.2**
    - _Requirements: 18.2_

- [x] 16. RiskManagement module (RiskEngine)
  - [x] 16.1 Implement `RiskManagementModule` as the authoritative risk gatekeeper: position sizing formula `quantity = FLOOR(Dynamic_Capital × configured_risk_percentage / (|entry_price − stop_loss_price| × lot_size))`; enforce all 8 pre-entry gates (per-trade loss, total exposure, correlated exposure, concurrent trades, concentration, signal score ≥ 80, non-zero per-unit risk, valid lot_size); return the specific failing gate name on rejection
    - _Requirements: 9.2, 9.5_
  - [x] 16.2 Implement the daily loss state machine: `Normal` → `TWO_LOSS_LOCKOUT` (2nd losing trade closed) → `EMERGENCY_HALT` (intraday net loss ≥ daily limit including unrealized); `KILL_SWITCH_ACTIVE` from any state; each transition records a `RiskEvents` entry; both `TWO_LOSS_LOCKOUT` and `EMERGENCY_HALT` reset at next calendar day 00:00 IST; notify `NotificationService` on each transition
    - _Requirements: 9.3, 9.4, 9.8_
  - [x] 16.3 Implement VIX position size controls: reduce max position size to `volatility_protection_limit` when VIX > `unusual_volatility_threshold`; restore to normal configured limit after VIX has been continuously below the threshold for 5 consecutive minutes
    - _Requirements: 9.7, 9.10_
  - [x] 16.4 Implement zero-risk and invalid lot_size rejection: when `|entry_price − stop_loss_price| = 0` → reject and record `RiskEvent` with reason `"zero per-unit risk"`; when `lot_size ≤ 0` or not configured → reject and record `RiskEvent` with reason `"invalid lot_size configuration"`
    - _Requirements: 9.9, 9.11_
  - [x]* 16.5 Write property test for position sizing formula correctness
    - **Property 12: Position Sizing Formula Correctness**
    - **Validates: Requirements 9.2**
    - _Requirements: 9.2_
  - [x]* 16.6 Write property test for invalid signal parameters cause RiskEngine rejection
    - **Property 13: Invalid Signal Parameters Cause Risk Engine Rejection**
    - **Validates: Requirements 9.9, 9.11**
    - _Requirements: 9.9, 9.11_
  - [x]* 16.7 Write property test for VIX position size round-trip
    - **Property 14: VIX Position Size Round-Trip**
    - **Validates: Requirements 9.7, 9.10**
    - _Requirements: 9.7, 9.10_
  - [x]* 16.8 Write property test for two-loss daily lockout state machine
    - **Property 15: Two-Loss Daily Lockout State Machine**
    - **Validates: Requirements 9.3**
    - _Requirements: 9.3_

- [x] 17. Checkpoint — strategy, signal, and risk layer complete
  - Ensure StrategyEngine, SignalScorer, Portfolio, and RiskEngine unit and property tests all pass. Ask the user if questions arise.

- [x] 18. Execution module (ExecutionService)
  - [x] 18.1 Implement `ExecutionModule`: full order lifecycle management (place, modify, cancel via `DhanApiClient`); execute the 5-check pre-trade validation chain in order — (1) composite score ≥ 80, (2) `RiskEngine` approval, (3) available margin ≥ required margin, (4) no duplicate order for same instrument + direction, (5) current time within session and before mandatory square-off; reject without broker submission on any check failure and return the specific failing check name
    - Persist all order events to `Orders` table; update `Executions` table on fill
    - _Requirements: 11.3, 11.4_
  - [x] 18.2 Implement order idempotency: assign a UUID idempotency key to each order; store in Redis key `orders:idempotency:{key}` with 5-minute TTL; before every Dhan API submission check Redis for the key; if key exists → return `duplicate-order-rejected` without Dhan API call
    - _Requirements: 16.6, 16.7_
  - [x]* 18.3 Write property test for pre-trade validation chain gate
    - **Property 20: Pre-Trade Validation Chain Gate**
    - **Validates: Requirements 11.3, 11.4**
    - _Requirements: 11.3, 11.4_
  - [x]* 18.4 Write property test for idempotency deduplication within 5-minute window
    - **Property 27: Idempotency Deduplication Within 5-Minute Window**
    - **Validates: Requirements 16.6, 16.7**
    - _Requirements: 16.6, 16.7_

- [x] 19. PaperTrading module (PaperEngine)
  - [x] 19.1 Implement `PaperTradingModule` with complete isolation from `LiveEngine`: dedicated `paper_*` PostgreSQL tables (via separate TypeORM entities), `paper:*` Redis key namespace, and `events:paper:*` event channels; no shared service instances, message handlers, or middleware
    - _Requirements: 10.1_
  - [x] 19.2 Implement fill simulation: buy orders fill at current best ask, sell orders fill at current best bid; if best bid or best ask is unavailable → reject order, preserve existing portfolio state and P&L, and record rejection reason `"market data unavailable"`
    - _Requirements: 10.2, 10.3, 10.4_
  - [x] 19.3 Implement configurable simulation parameters: slippage models (fixed rupee 0.00–50.00₹, percentage 0.00%–2.00%, market-impact); rejection probability (0.00–1.00, default 0.00) — rejected orders deduct no costs and record no P&L change; execution latency distribution (uniform/normal/log-normal, mean 10–5000 ms, default: uniform 200 ms); zero-latency instantaneous fills are not the default
    - _Requirements: 10.5, 10.7, 10.8, 10.9_
  - [x] 19.4 Apply identical cost formulas as `LiveEngine`: brokerage, STT, NSE exchange charges, GST, SEBI charges, and stamp duty deducted from every simulated fill
    - _Requirements: 10.6_
  - [x]* 19.5 Write property test for paper fill price correctness
    - **Property 21: Paper Fill Price Correctness**
    - **Validates: Requirements 10.2, 10.3**
    - _Requirements: 10.2, 10.3_
  - [x]* 19.6 Write property test for cost model parity across all engines
    - **Property 22: Cost Model Parity Across All Engines**
    - **Validates: Requirements 10.6, 15.2**
    - _Requirements: 10.6, 15.2_

- [x] 20. SessionManager module
  - [x] 20.1 Implement `SessionManagerModule`: track all 8 NSE session phases with their IST time boundaries; publish `session-phase-change` events to `events:session_phase` Redis channel; set `session:phase:current` Redis key on every transition; during Opening Volatility phase → restrict `StrategyEngine` to strategies with `opening_phase_compatible = true`
    - Phases: Pre-market (09:00–09:15), Opening Volatility (09:15–09:20), ORB Formation (09:15–09:30), Morning Momentum (09:30–11:00), Mid-session (11:00–13:00), Afternoon (13:00–14:30), Closing (14:30–15:30), End-of-Day Reconciliation (15:30–16:00)
    - _Requirements: 17.1, 17.2, 17.5_
  - [x] 20.2 Implement session-critical enforcement: at 14:30 IST → `LiveEngine` blocks all new position entries; at 15:15 IST → `LiveEngine` submits market exit orders for all open positions and records a `mandatory-exit` compliance event in `TradeJournal` with exit timestamp and all affected position IDs; alert user if any square-off market exit order is rejected or unconfirmed within 5 minutes of 15:15 IST
    - _Requirements: 17.3, 17.4, 17.7_
  - [x]* 20.3 Write unit tests for all 8 session phase transitions at their IST boundaries
    - _Requirements: 17.1_
  - [x]* 20.4 Write property test for session phase classification as a total exclusive function
    - **Property 25: Session Phase Classification Is a Total Exclusive Function**
    - **Validates: Requirements 17.1**
    - _Requirements: 17.1_

- [x] 21. LiveTrading module (LiveEngine)
  - [x] 21.1 Implement `LiveTradingModule` two-step arming state machine: `DISARMED` → `ARMED_PENDING` (user clicks "Activate Live Mode") → `ARMED` (user clicks "Confirm Arm"); a single user action must never reach `ARMED`; persist armed state to Redis key `trading:armed_state`; auto-revert to `DISARMED` on CloudEngine restart, browser update, or Dhan session token renewal
    - _Requirements: 11.1, 11.2_
  - [x] 21.2 Implement session-aware entry blocking: reject new entry orders when in Closing phase (current time ≥ 14:30 IST), when `TWO_LOSS_LOCKOUT` is active, or when `EMERGENCY_HALT` is active — without forwarding to the broker
    - _Requirements: 11.7, 17.3_
  - [x] 21.3 Implement kill switch: on activation → cancel all open orders and submit market exit orders for all open positions within 10 seconds; if any orders or positions remain open after 10 seconds → publish a MAX-priority alert to `NotificationService` identifying specific items requiring manual intervention; record `KILL_SWITCH` event in `RiskEvents`
    - _Requirements: 9.8, 11.5, 11.6_
  - [x]* 21.4 Write unit tests for the two-step arming state machine covering all valid and invalid transition sequences
    - _Requirements: 11.1, 11.2_
  - [x]* 21.5 Write property test for two-step arming invariant
    - **Property 19: Two-Step Arming Invariant**
    - **Validates: Requirements 11.1**
    - _Requirements: 11.1_
  - [x]* 21.6 Write property test for Closing phase blocks all new entries
    - **Property 26: Closing Phase Blocks All New Entries**
    - **Validates: Requirements 17.3**
    - _Requirements: 17.3_

- [x] 22. Checkpoint — execution engines complete
  - Ensure Execution, PaperEngine, SessionManager, and LiveEngine unit and property tests all pass; verify Paper/Live isolation by confirming zero shared tables, Redis keys, and event channels. Ask the user if questions arise.

- [x] 23. TrailingStop module (TrailingStopEngine)
  - [x] 23.1 Implement `TrailingStopModule` with all 8 trailing stop mechanisms: ATR-based, Swing High/Low, Chandelier Exit, Percentage-based, Volatility-adjusted (ATR + IV regime multiplier), Structure-based (anchored to nearest S/R level), Time-based (progressively tightening), and Partial-profit (exit configured qty at first target, move SL to post-partial level)
    - _Requirements: 12.1, 12.6_
  - [x] 23.2 Implement SL monotonicity enforcement: before persisting any SL update, atomically apply conditional write — long positions: new SL ≥ current SL; short positions: new SL ≤ current SL; never move SL in a direction that increases risk
    - _Requirements: 12.2_
  - [x] 23.3 Implement broker-side SL registration via Dhan Super Orders within 5 seconds of trailing stop activation; maintain an internal SL level independent of broker state; if no Super Order confirmation received for any open position → treat broker-side SL as inactive and submit a replacement SL order
    - _Requirements: 12.3, 12.5_
  - [x] 23.4 Implement SL rejection escalation ladder: 1–2 consecutive rejections → submit replacement SL within 5 s and publish CRITICAL alert; ≥ 3 consecutive rejections → publish MAX-priority alert to `NotificationService` and disable new entries pending user acknowledgment; on user ACK → reset consecutive rejection counter for that position to exactly 0
    - _Requirements: 12.7, 12.8, 12.9_
  - [x]* 23.5 Write property test for trailing stop SL monotonicity in profit direction
    - **Property 16: Trailing Stop SL Monotonicity in Profit Direction**
    - **Validates: Requirements 12.2**
    - _Requirements: 12.2_
  - [x]* 23.6 Write property test for SL rejection escalation ladder and counter reset
    - **Property 17: SL Rejection Escalation Ladder and Counter Reset**
    - **Validates: Requirements 12.8, 12.9**
    - _Requirements: 12.8, 12.9_

- [x] 24. PositionMonitoring module (PositionMonitor)
  - [x] 24.1 Implement `PositionMonitoringModule`: subscribe to `events:tick:{instrument_id}` for every open position; continuously update MFE (maximum favorable excursion) and MAE (maximum adverse excursion) from entry price; evaluate exit conditions — SL hit, target hit, trailing stop trigger, time-based exit, and Theta decay threshold; feed real-time unrealized P&L to `RiskEngine` for `EMERGENCY_HALT` monitoring; detect expiry-day mandatory square-off time and trigger square-off for expiring positions
    - _Requirements: 7.4, 9.4, 12.2_

- [x] 25. TradeJournal module
  - [x] 25.1 Implement `TradeJournalModule` with append-only write semantics across all 9 record sets: signals, rejected_signals, orders, fills, positions, completed_trades, risk_events, system_errors, and configuration_changes; only INSERT operations are issued — no UPDATE or DELETE
    - _Requirements: 13.1, 13.3_
  - [x] 25.2 Implement write SLA enforcement and retry: most records within 5 seconds of triggering event; risk_events and system_errors within 1 second; retry up to 3 times within 30 seconds on write failure; emit operator alert identifying record type and failure reason on all-retry failure; records are never silently dropped
    - _Requirements: 13.5, 13.7, 13.8_
  - [x] 25.3 Implement trade completion record writer: persist all required fields (`trade_id`, `instrument`, `strategy`, `signal_score`, `entry_price`, `exit_price`, `quantity`, `entry_time`, `exit_time`, `MFE`, `MAE`, `gross_pnl`, per-component charges, `net_pnl`, `exit_reason`, `execution_slippage`, `dhan_entry_order_id`, `dhan_exit_order_id`)
    - _Requirements: 13.2_
  - [x] 25.4 Implement configuration-change audit record writer: persist user ID, timestamp, field name, previous value, and new value in `AuditLogs` table for every user-initiated config change
    - _Requirements: 13.4_

- [x] 26. NotificationService module
  - [x] 26.1 Implement `NotificationModule` with a priority queue (MAX > CRITICAL > WARNING > INFO); deliver alerts to Chrome Extension via WebSocket push; buffer undelivered alerts and retry — no alert is silently dropped; track acknowledgment status for MAX-priority alerts (required by `TrailingStopEngine` SL escalation and kill switch)
    - _Requirements: 12.8, 11.6_

- [x] 27. Checkpoint — position management and record-keeping complete
  - Ensure TrailingStop, PositionMonitor, TradeJournal, and NotificationService tests pass. Ask the user if questions arise.

- [x] 28. Analytics module (AnalyticsService)
  - [x] 28.1 Implement `AnalyticsModule`: compute all 12 performance metrics (`win_rate`, `profit_factor`, `expectancy`, `avg_win`, `avg_loss`, `rr_ratio`, `max_drawdown`, `sharpe_ratio`, `sortino_ratio`, `calmar_ratio`, `max_consecutive_wins`, `max_consecutive_losses`) separately for LIVE and PAPER engines across three time windows (current session, last 30 days, all-time); suppress `sharpe_ratio`, `sortino_ratio`, `calmar_ratio`, and `profit_factor` with message `"insufficient data — fewer than 30 trades"` when trade count < 30
    - _Requirements: 14.1, 14.2_
  - [x] 28.2 Implement performance attribution breakdowns: by strategy, by instrument, by market regime, and by 60-minute time-of-day bucket
    - _Requirements: 14.3_
  - [x] 28.3 Implement Trade Quality Forensics: compute `QCR = actual_net_pnl / MFE`; classify exit as `premature` (QCR < 0.70), `near-optimal` (QCR ≥ 0.70 and `exit_time ≤ mfe_time`), or `late` (QCR ≥ 0.70 and `exit_time > mfe_time`); rate execution quality as `Poor` (QCR < 0.40), `Fair` (0.40 ≤ QCR < 0.70), `Good` (0.70 ≤ QCR < 0.90), `Excellent` (QCR ≥ 0.90); when `MFE = 0` → record QCR as `NULL` and execution quality as `"No Favorable Excursion"` without performing division
    - _Requirements: 20.3, 20.4_
  - [x] 28.4 Implement Daily Trading Intelligence Report (generated at session end): trade summary, regime observations, strategy performance, capital changes, and for each generated-but-not-executed signal the specific threshold criterion not met; when no trades were placed → generate a No-Trade Intelligence entry documenting all evaluated signals with their scores
    - _Requirements: 14.4, 14.5_
  - [x] 28.5 Implement Capital Compounding Simulator: project capital growth over 1, 3, or 5 years with configurable compounding frequency (daily, weekly, monthly) and configurable withdrawal rate (0%–100% in 1% increments) based on historical performance statistics from the selected time window
    - _Requirements: 14.6_
  - [x] 28.6 Implement Market Activity Heatmap: track count of valid trade signals by instrument, 60-minute time-of-day bucket, and market regime over the trailing 30 trading days
    - _Requirements: 14.7_
  - [x]* 28.7 Write property test for analytics engine isolation (LIVE vs PAPER)
    - **Property 29: Analytics Engine Isolation**
    - **Validates: Requirements 14.1**
    - _Requirements: 14.1_
  - [x]* 28.8 Write property test for insufficient data suppresses ratio metrics
    - **Property 30: Insufficient Data Suppresses Ratio Metrics**
    - **Validates: Requirements 14.2**
    - _Requirements: 14.2_
  - [x]* 28.9 Write property test for QCR computation and exit classification
    - **Property 18: QCR Computation and Exit Classification**
    - **Validates: Requirements 20.3, 20.4**
    - _Requirements: 20.3, 20.4_

- [x] 29. Compliance and BacktestEngine module
  - [x] 29.1 Implement `ComplianceModule`: enforce all 4 live deployment profitability gates — (1) positive out-of-sample expectancy, (2) maximum drawdown ≤ configured threshold, (3) ≥ 30 closed trades per regime tested, (4) Monte Carlo robustness with ≥ 1,000 iterations of which ≥ 95% yield positive out-of-sample expectancy; block strategy from live trading and persist specific failing criterion name and computed value to `Strategies` table on any gate failure
    - _Requirements: 15.3, 15.5_
  - [x] 29.2 Implement `BacktestEngine`: walk-forward validation and out-of-sample testing for all 8 strategies; no look-ahead bias (indicator values at any step use only historically available data) and no survivorship bias (include delisted instruments in historical universe); configurable in-sample/out-of-sample split ratio (50%–90% in-sample); apply identical cost model as `PaperEngine`; compute 95% confidence intervals for expectancy, win rate, and max drawdown via bootstrap resampling (≥ 1,000 resamples)
    - _Requirements: 15.1, 15.2, 15.4, 15.6_
  - [x]* 29.3 Write property test for profitability gate blocks live deployment on any failure
    - **Property 31: Profitability Gate Blocks Live Deployment on Any Failure**
    - **Validates: Requirements 15.3, 15.5**
    - _Requirements: 15.3, 15.5_

- [x] 30. Reconciliation module (ReconciliationService)
  - [x] 30.1 Implement `ReconciliationModule`: EOD reconciliation (triggered at 15:30 IST, complete within 30 minutes) comparing CloudEngine orders, executions, positions, and P&L against Dhan broker records; reconnection reconciliation (complete within 30 seconds of DhanAPI reconnection); SL status verification (complete within 60 seconds of `TrailingStopEngine` request after reconnect); on any discrepancy → halt new order submissions while permitting modification and cancellation of existing orders, publish alert, and await user ACK or auto-agreement
    - _Requirements: 12.4, 17.6, 19.1, 19.2, 19.3_
  - [x] 30.2 Implement reconciliation report and alerts: confirm CloudEngine net P&L = Dhan broker net P&L = `CapitalLedger` closing balance within ₹1 tolerance; when Dhan reports a fill with no matching CloudEngine order ID → flag as unrecognized execution and publish alert to `NotificationService` within 10 seconds; if reconnection reconciliation fails to complete within 30 seconds → halt all new order submissions and publish reconciliation timeout alert; record every run, discrepancy, and resolution action in `AuditLogs`
    - _Requirements: 19.4, 19.5, 19.6, 19.7_
  - [x]* 30.3 Write property test for reconciliation P&L agreement within tolerance
    - **Property 32: Reconciliation P&L Agreement Within Tolerance**
    - **Validates: Requirements 19.6**
    - _Requirements: 19.6_

- [x] 31. SystemHealthMonitor and Options Flow Dashboard
  - [x] 31.1 Implement `SystemHealthMonitorModule`: track 6 metrics (CloudEngine module health, DhanAPI connectivity, PostgreSQL connection pool, Redis availability, WebSocket feed latency, live order execution latency); classify each as `Healthy`, `Degraded`, or `Down`; publish health status updates to `NotificationService` every 30 seconds; set `health:{module_name}` Redis key (TTL 90 s) on every 30-second poll; publish an immediate alert on any `Healthy → Degraded` or `Degraded → Down` transition independent of the 30-second poll interval
    - _Requirements: 2.7, 2.8, 20.8, 20.9_
  - [x] 31.2 Implement Options Flow Dashboard API endpoint: expose aggregate net OI change, put/call ratio, IV skew, and large-block single-trade detection (contract volume above configured threshold) for all monitored instruments; refresh every ≤ 60 seconds; display staleness indicator and suppress Options/Futures Confirmation score contributions when data age exceeds 60 seconds
    - _Requirements: 20.6, 20.7_

- [x] 32. Checkpoint — analytics, compliance, and monitoring complete
  - Ensure Analytics, Compliance, BacktestEngine, Reconciliation, and SystemHealthMonitor tests pass. Ask the user if questions arise.

- [x] 33. Chrome Extension — Background Service Worker and storage
  - [x] 33.1 Implement MV3 Background Service Worker (BSW): maintain a single WSS connection to the CloudEngine; persist `{ armedState, sessionToken, connectionState }` in `chrome.storage.session` (ephemeral, not synced); on BSW startup → attempt to recover state within 5 seconds; if recovery fails → enter disarmed state and notify the user that manual re-authorization is required; never auto-re-arm after restart, token renewal, or browser update
    - _Requirements: 1.1, 1.3, 1.4, 1.5_
  - [x] 33.2 Implement Extension security invariants: never store broker credentials, API keys, or session tokens in extension local storage accessible to content scripts, `window.postMessage`, or any DOM-accessible location; all Extension ↔ CloudEngine communication over WSS or HTTPS exclusively
    - _Requirements: 1.2, 1.6, 16.2_
  - [x]* 33.3 Write unit tests for BSW state recovery: confirm successful recovery within 5 seconds and confirm disarm + user notification when recovery times out
    - _Requirements: 1.3, 1.4_

- [x] 34. Chrome Extension — UI components
  - [x] 34.1 Implement Popup: two-step ARM/DISARM UI (Activate → Confirm; single action cannot arm); display system health badge, quick session P&L summary, armed state label, active positions count
    - _Requirements: 1.1, 11.1_
  - [x] 34.2 Implement Side Panel: live position monitor with real-time P&L updates from CloudEngine WebSocket push; recent signal feed (last 10 signals); alert queue with acknowledgment for MAX-priority alerts
    - _Requirements: 1.1_
  - [x] 34.3 Implement Full Dashboard: strategy performance analytics, capital chart, regime heatmap, Options Flow panel (OI change, PCR, IV skew, large-block activity); consume all CloudEngine WebSocket push notifications and display them in the alert queue
    - _Requirements: 1.1, 14.1, 20.6_

- [x] 35. Integration wiring — CloudEngine event pipeline
  - [x] 35.1 Wire all Redis pub/sub channels: `MarketDataModule` → `TechnicalAnalysisModule`, `OptionsIntelligenceModule`, `PositionMonitoringModule` (via `events:tick:{id}`); `MarketRegimeModule` → `StrategyModule`, `RiskManagementModule`, `OptionsIntelligenceModule` (via `events:regime_change`); `SessionManagerModule` → `StrategyModule`, `RiskManagementModule`, `LiveTradingModule`, `OptionsIntelligenceModule` (via `events:session_phase`)
    - _Requirements: 2.1, 5.3, 17.5_
  - [x] 35.2 Wire the signal-to-execution pipeline via NestJS EventEmitter: `StrategyModule` → `SignalScoringModule` → `RiskManagementModule` → `LiveTradingModule` → `ExecutionModule` → `TrailingStopModule` → `PositionMonitoringModule`; wire fill events from `ExecutionModule` to `TrailingStopModule` and `PositionMonitoringModule`; wire `PortfolioModule` → `RiskManagementModule` (Dynamic_Capital feed)
    - _Requirements: 9.1, 9.2, 11.3_
  - [x] 35.3 Wire all modules to `TradeJournalModule` for append-only write paths; wire `SystemHealthMonitorModule` to watch all module NestJS global exception events; verify Redis pub/sub subscriptions for `PaperTradingModule` isolated channels (`events:paper:*`)
    - _Requirements: 13.1, 10.1_
  - [x]* 35.4 Write integration test for the full signal-to-execution pipeline: strategy evaluation → signal scoring → risk gating → live order submission → trailing stop activation → position monitoring fill
    - _Requirements: 11.3, 9.2, 12.2_
  - [x]* 35.5 Write integration test for Paper/Live engine isolation: confirm zero shared PostgreSQL tables, Redis keys, and event bus channels between `PaperEngine` and `LiveEngine`
    - _Requirements: 10.1_
  - [x]* 35.6 Write integration test for EOD reconciliation flow: 15:30 IST trigger → position and order comparison → discrepancy detection → new order submission halt → AuditLogs write
    - _Requirements: 19.1, 19.2_

- [x] 36. Final checkpoint — all tests pass
  - Ensure all unit tests, property tests, and integration tests pass. Verify all 32 correctness properties are covered by `fast-check` property tests tagged `// Feature: money-printer, Property N: <title>`. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- All property tests use `fast-check` with a minimum of 100 iterations per property
- Each property test must be tagged: `// Feature: money-printer, Property N: <title>`
- NestJS + TypeScript is the implementation language throughout
- The `RiskEngine` is authoritative — no module, strategy, or user action can bypass a risk decision
- Paper and Live engines are isolated at the infrastructure level: separate DB tables (`paper_*` prefix), Redis namespaces (`paper:*`), and event channels (`events:paper:*`)
- All 32 correctness properties from the design document have corresponding property test sub-tasks (Properties 1–32)
- Checkpoints validate incremental correctness before proceeding to dependent phases

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "3.1", "3.2", "3.3"] },
    { "id": 2, "tasks": ["4.1", "4.2", "4.3", "25.1", "26.1"] },
    { "id": 3, "tasks": ["4.4", "5.1", "20.1", "25.2"] },
    { "id": 4, "tasks": ["4.5", "4.6", "5.2", "20.2", "20.3", "20.4", "25.3"] },
    { "id": 5, "tasks": ["5.3", "5.4", "6.1", "25.4"] },
    { "id": 6, "tasks": ["6.2", "8.1", "9.1", "10.1"] },
    { "id": 7, "tasks": ["6.3", "8.2", "9.2", "11.1", "31.1"] },
    { "id": 8, "tasks": ["6.4", "8.3", "9.3", "11.2", "31.2"] },
    { "id": 9, "tasks": ["8.4", "8.5", "9.4", "11.3"] },
    { "id": 10, "tasks": ["8.6", "8.7", "8.8", "11.4", "11.5", "11.6"] },
    { "id": 11, "tasks": ["11.7", "11.8", "13.1"] },
    { "id": 12, "tasks": ["13.2", "14.1", "15.1"] },
    { "id": 13, "tasks": ["13.3", "14.2", "15.2"] },
    { "id": 14, "tasks": ["13.4", "14.3", "14.4", "14.5", "14.6", "15.3", "16.1"] },
    { "id": 15, "tasks": ["16.2", "16.3", "16.4"] },
    { "id": 16, "tasks": ["16.5", "16.6", "16.7", "16.8", "18.1", "19.1"] },
    { "id": 17, "tasks": ["18.2", "19.2", "21.1"] },
    { "id": 18, "tasks": ["18.3", "18.4", "19.3", "19.4", "21.2", "21.3", "23.1"] },
    { "id": 19, "tasks": ["19.5", "19.6", "21.4", "21.5", "21.6", "23.2"] },
    { "id": 20, "tasks": ["23.3", "23.4", "24.1", "30.1"] },
    { "id": 21, "tasks": ["23.5", "24.2", "30.2"] },
    { "id": 22, "tasks": ["23.6", "29.1", "30.3"] },
    { "id": 23, "tasks": ["23.7", "23.8", "23.9", "29.2", "29.3"] },
    { "id": 24, "tasks": ["28.1", "33.1", "33.2"] },
    { "id": 25, "tasks": ["33.3", "34.1", "34.2", "34.3"] },
    { "id": 26, "tasks": ["35.1", "35.2", "35.3"] },
    { "id": 27, "tasks": ["35.4", "35.5", "35.6"] }
  ]
}
```
