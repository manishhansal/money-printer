# Requirements Document

## Introduction

MoneyPrinter is an autonomous AI-powered quantitative trading system targeting Indian NSE Index Options and F&O instruments. It consists of a Google Chrome Extension (Manifest V3) acting as the user interface and control plane, connected to a cloud-hosted NestJS backend that operates independently of the browser. The system integrates exclusively with the Dhan/DhanHQ brokerage platform via official APIs to discover, analyze, score, execute, monitor, and reconcile trades fully autonomously after explicit user authorization and arming.

The system is risk-first: capital preservation, regulatory compliance, and trade quality enforcement take precedence over opportunity capture. The cloud backend implements 20 independent modules backed by PostgreSQL for persistence and Redis for caching and event distribution. A static outbound IP is required for Dhan API compliance. All intraday positions follow a strict square-off policy with no unintentional carry-forward.

## Glossary

- **MoneyPrinter**: The complete autonomous trading system comprising the Extension and CloudEngine.
- **Extension**: The Google Chrome Extension (Manifest V3) serving as the user interface and control plane.
- **CloudEngine**: The NestJS/Node.js cloud backend that operates independently of the browser.
- **DhanAPI**: The official Dhan/DhanHQ REST and WebSocket API integration layer.
- **MarketDataService**: The module responsible for ingesting and distributing real-time and historical market data.
- **InstrumentDiscovery**: The module that scans and ranks eligible NSE F&O instruments by liquidity and tradability.
- **MarketRegimeDetector**: The module that classifies the current market into exactly one of 10 defined regimes.
- **StrategyEngine**: The module that manages and evaluates the 8 defined trading strategies.
- **OptionsIntelligence**: The module that analyzes option chain data, Greeks, IV, OI, and performs contract selection.
- **SignalScorer**: The module that generates and scores trading signals on a 0–100 scale.
- **RiskEngine**: The module that enforces all risk limits, position sizing, and capital protection rules.
- **PaperEngine**: The paper trading simulation engine, completely isolated from live trading.
- **LiveEngine**: The live trading execution engine, activated only by explicit user authorization.
- **ExecutionService**: The order lifecycle management service for live order placement, modification, and cancellation.
- **TrailingStopEngine**: The module that manages trailing stop mechanisms and broker-side SL reconciliation.
- **PositionMonitor**: The module that continuously monitors open positions for risk, P&L, and exit conditions.
- **TradeJournal**: The immutable audit and record-keeping module for all trades, signals, and system events.
- **AnalyticsService**: The module that computes performance metrics and generates trading intelligence reports.
- **ReconciliationService**: The module that reconciles CloudEngine state with Dhan broker state.
- **ComplianceModule**: The module that enforces regulatory, session, and operational compliance rules.
- **SessionManager**: The module that manages NSE trading session phases and enforces session-aware behaviors.
- **NotificationService**: The module that delivers alerts and status notifications to the Extension.
- **BacktestEngine**: The module that performs historical simulation with walk-forward and out-of-sample validation.
- **SystemHealthMonitor**: The module that tracks and reports operational health of all CloudEngine modules.
- **CapitalLedger**: The financial ledger that tracks Dynamic Capital including all realized P&L and charges.
- **Dynamic_Capital**: The current trading capital computed as starting capital plus cumulative realized net P&L after all charges.
- **Signal**: A scored trading opportunity record identifying entry, stop-loss, target, position size, and full supporting evidence.
- **SuperOrder**: A Dhan broker-native order type with built-in SL and target legs.
- **NSE**: National Stock Exchange of India.
- **F&O**: Futures and Options segment of NSE.
- **OI**: Open Interest — the total number of outstanding options contracts for a given strike.
- **IV**: Implied Volatility of an options contract derived from market price.
- **ATR**: Average True Range — a measure of price volatility over a given period.
- **VWAP**: Volume Weighted Average Price — price weighted by volume traded throughout the session.
- **VIX**: India Volatility Index, reflecting expected near-term market volatility.
- **MFE**: Maximum Favorable Excursion — the maximum unrealized profit reached during a trade.
- **MAE**: Maximum Adverse Excursion — the maximum unrealized loss reached during a trade.
- **ORB**: Opening Range Breakout — the price range established in the first candle(s) of the trading session.
- **R:R**: Risk-to-Reward ratio.
- **SL**: Stop-Loss — the price level at which a losing position is exited to limit loss.
- **CE**: Call option in Indian F&O markets.
- **PE**: Put option in Indian F&O markets.
- **ATM**: At-the-money — the options strike closest to the current underlying price.
- **QCR**: Quality Capture Ratio — actual net P&L divided by Maximum Favorable Excursion, measuring how much of the available profit was captured.

## Requirements

### Requirement 1: Chrome Extension Architecture

**User Story:** As a trader, I want a Chrome Extension that serves as a secure control plane for the cloud trading engine, so that I can monitor, control, and authorize the autonomous trading system from my browser.

#### Acceptance Criteria

1. THE Extension SHALL implement Manifest V3 with a Popup, Side Panel, Full Dashboard, Content Scripts, and Background Service Worker.
2. THE Extension SHALL communicate with the CloudEngine exclusively over HTTPS and WSS; no plaintext HTTP connections are permitted.
3. WHEN the Background Service Worker is suspended by Chrome and subsequently restarted, THE Extension SHALL recover connection state, armed/disarmed status, and active session token from Chrome storage within 5 seconds.
4. IF the Background Service Worker fails to recover state within 5 seconds of restart, THEN THE Extension SHALL enter disarmed/disconnected state and notify the user that manual re-authorization is required.
5. WHILE the LiveEngine is in Armed state, IF a browser restart, browser update, or session token renewal occurs, THEN THE Extension SHALL NOT re-arm the CloudEngine automatically; the user must explicitly initiate and confirm a re-arm action via the Extension UI.
6. THE Extension SHALL never store broker credentials, API secrets, or session tokens in content scripts, extension local storage accessible to content scripts, or in any location exposed to Dhan page JavaScript context.
7. WHEN the Extension connects to the CloudEngine, THE Extension SHALL authenticate using a session token with a validity period not exceeding 30 minutes, issued by the Auth module, not via stored plaintext credentials.
8. WHEN a session token expires during an active Extension session, THE Extension SHALL disconnect from the CloudEngine, enter disarmed state, and prompt the user to re-authenticate.

---

### Requirement 2: Cloud Backend Architecture

**User Story:** As a system operator, I want a cloud backend that operates independently of the browser so that the trading engine continues position monitoring and risk management even when the browser is closed.

#### Acceptance Criteria

1. WHEN the Extension disconnects from the CloudEngine, THE CloudEngine SHALL continue executing position monitoring and risk management tasks without interruption.
2. THE CloudEngine SHALL implement exactly 20 independent modules: Auth, MarketData, InstrumentDiscovery, MarketRegime, TechnicalAnalysis, OptionsIntelligence, Strategy, SignalScoring, Portfolio, RiskManagement, Execution, PaperTrading, LiveTrading, TrailingStop, PositionMonitoring, TradeJournal, Analytics, Notification, Compliance, and Reconciliation.
3. WHEN the CloudEngine starts, THE CloudEngine SHALL establish connections to PostgreSQL and Redis within 10 seconds before accepting any API requests.
4. IF the CloudEngine fails to establish connections to PostgreSQL or Redis within 10 seconds of startup, THEN THE CloudEngine SHALL reject all incoming API requests, log the connection failure to SystemHealthEvents, and continue retrying the failed connection.
5. THE CloudEngine SHALL expose all external API endpoints exclusively over HTTPS with TLS 1.2 or higher.
6. THE CloudEngine SHALL use a static outbound IP address for all outbound connections to Dhan APIs.
7. WHEN a module raises an unhandled exception, THE CloudEngine SHALL log the failure to SystemHealthEvents, notify the NotificationService, and attempt automated module restart up to 3 times without halting unaffected modules.
8. IF a module fails to restart successfully after 3 consecutive attempts, THEN THE CloudEngine SHALL atomically mark the module as unavailable in SystemHealthEvents and publish a final failure alert to the NotificationService; both actions SHALL succeed or neither SHALL be committed.

---

### Requirement 3: Dhan API Integration

**User Story:** As a trader, I want the system to integrate fully with the official Dhan API, so that I can trade NSE options through my Dhan account without any manual order entry.

#### Acceptance Criteria

1. THE DhanAPI SHALL integrate exclusively with officially documented Dhan/DhanHQ endpoints; no undocumented or private endpoints SHALL be used at any time.
2. THE DhanAPI SHALL implement a dedicated callable method for each endpoint category: authentication, live quotes, live WebSocket feed, historical candles, option chains, order placement, order modification, order cancellation, positions, portfolio, tradebook, orderbook, live order updates, and Super Orders.
3. WHEN a Dhan session token is obtained, THE DhanAPI SHALL store it in the CloudEngine secrets store; it SHALL NOT be persisted in the Extension frontend or any client-side storage.
4. WHEN the Dhan WebSocket feed is established, THE MarketDataService SHALL receive the first incoming tick data message within 3 seconds of connection confirmation.
5. IF the Dhan WebSocket connection drops, THEN THE MarketDataService SHALL attempt reconnection using exponential backoff starting at 1 second, doubling per attempt up to a maximum of 30 seconds per attempt, for up to 5 consecutive attempts.
6. WHEN a Dhan API rate limit response is received and the pending request queue contains fewer than 50 requests, THE DhanAPI SHALL queue the affected request and retry after the rate-limit window specified in the API response expires, without dropping the request or submitting a duplicate order; a request queued for retry SHALL NOT be considered dropped until all retry attempts have been exhausted without successful forwarding to Dhan.
7. WHEN the DhanAPI receives an authentication failure or token expiry response from Dhan, THE DhanAPI SHALL invalidate the stored session token and return an authentication-failure error to the caller without retrying.
8. IF all 5 WebSocket reconnection attempts fail, THEN THE MarketDataService SHALL publish a connectivity-failure alert to the CloudEngine notification channel within 5 seconds.
9. IF a Dhan API rate limit response is received and the pending request queue is at capacity (50 requests), THEN THE DhanAPI SHALL return a rate-limit-queue-full error to the caller without adding the request to the queue or forwarding it to the broker.

---

### Requirement 4: Instrument Discovery and Liquidity Scoring

**User Story:** As a trader, I want the system to dynamically discover and rank tradable NSE F&O instruments, so that trading capital is allocated only to liquid, executable options contracts.

#### Acceptance Criteria

1. WHEN NSE market opens at 09:15 IST, THE InstrumentDiscovery SHALL scan all eligible NSE F&O instruments, including NIFTY, BANK NIFTY, FINNIFTY, MIDCPNIFTY, and SENSEX index options, and F&O stock options whose prior-session open interest and average daily volume each meet or exceed configured minimum eligibility thresholds.
2. THE InstrumentDiscovery SHALL compute a composite liquidity score on a 0 to 100 scale for each instrument using volume, open interest, bid-ask spread, market depth, and available quantity at the best bid and best ask as inputs.
3. WHEN an instrument's liquidity score falls below the configured minimum threshold, THE InstrumentDiscovery SHALL remove the instrument from the active trading universe and unsubscribe its market data feed.
4. WHILE NSE market hours are between 09:15 IST and 15:30 IST, THE InstrumentDiscovery SHALL update liquidity rankings at intervals not exceeding 5 minutes.
5. WHEN the number of active market data subscriptions reaches 90% of the configured Dhan WebSocket subscription limit, THE InstrumentDiscovery SHALL prioritize subscriptions by descending liquidity score and rotate lower-ranked instruments out of the subscription list until the subscription count falls below 80% of the configured limit.
6. THE InstrumentDiscovery SHALL classify each instrument as either an underlying index (used for directional signal computation only) or a tradable options contract; underlying indices SHALL never be submitted as trade targets to the ExecutionService.
7. IF the InstrumentDiscovery scan fails to complete within 5 minutes of market open, THEN THE InstrumentDiscovery SHALL retain the prior session's trading universe, emit a scan failure alert to the NotificationService, and record the failure in SystemHealthEvents.
8. THE InstrumentDiscovery SHALL treat the configured minimum open interest threshold and minimum average daily volume threshold as global invariants that apply uniformly to all F&O stock options during every scan; no F&O stock option SHALL be admitted to the trading universe unless both invariants are satisfied for that instrument.

---

### Requirement 5: Market Regime Detection

**User Story:** As a trader, I want the system to accurately classify the current market regime at all times, so that only strategies compatible with the prevailing market conditions are evaluated for trading.

#### Acceptance Criteria

1. WHILE NSE market hours are active, THE MarketRegimeDetector SHALL classify the market into exactly one of 10 regimes at intervals not exceeding 60 seconds: Strong Bullish Trend, Weak Bullish Trend, Strong Bearish Trend, Weak Bearish Trend, Sideways, High Volatility, Low Volatility, Breakout, Reversal, or Unstable.
2. THE MarketRegimeDetector SHALL incorporate the following inputs for regime classification: NIFTY price trend, BANK NIFTY price trend, market breadth, Advance/Decline ratio, VWAP deviation, India VIX level, ATR, relative volume, sector strength, and futures basis.
3. WHEN the market regime changes, THE MarketRegimeDetector SHALL publish a regime-change event within 30 seconds of the triggering condition being met.
4. WHEN a regime-change event is published, THE StrategyEngine SHALL complete re-evaluation of active strategy eligibility against the new regime within 60 seconds.
5. THE MarketRegimeDetector SHALL record every regime classification with its timestamp, all input values, and the classification rationale in the MarketRegimes database table.
6. WHILE the market regime is classified as Unstable, THE RiskEngine SHALL reduce the maximum number of permitted concurrent open trades to the configured unstable-regime limit.
7. WHILE India VIX exceeds the configured high-volatility threshold, THE MarketRegimeDetector SHALL classify the regime as High Volatility regardless of price trend indicator values.

---

### Requirement 6: Strategy Engine

**User Story:** As a trader, I want the system to operate 8 defined trading strategies with independent logic and regime compatibility filters, so that each strategy is only deployed when market conditions are appropriate.

#### Acceptance Criteria

1. THE StrategyEngine SHALL implement exactly 8 strategies: A (Opening Range Breakout), B (VWAP Reclaim and Rejection), C (Momentum Expansion), D (Breakout and Retest), E (Trend Continuation), F (Liquidity Sweep and Reversal), G (Fair Value Gap and Market Structure), and H (Options Flow Intelligence).
2. THE StrategyEngine SHALL configure each strategy with independent entry conditions, exit conditions, invalidation conditions, a list of compatible market regimes, a minimum R:R ratio between 1.0 and 10.0, and a maximum concurrent position count between 1 and 20.
3. WHEN the StrategyEngine evaluates a strategy for a given instrument, THE StrategyEngine SHALL apply the strategy's regime compatibility filter as the first evaluation step before any other condition check.
4. IF the current regime is not in the strategy's compatible regime list, THEN THE StrategyEngine SHALL skip the evaluation and record the skip reason as "incompatible regime" in the SignalEvaluations table.
5. THE StrategyEngine SHALL record every strategy evaluation — whether it produced a signal or was skipped — with the skip reason in the SignalEvaluations table.
6. IF the current market regime is unavailable or unclassified, THEN THE StrategyEngine SHALL skip all strategy evaluations and record the skip reason as "regime unavailable" in the SignalEvaluations table.
7. WHERE the Adaptive Strategy Engine is enabled, THE StrategyEngine SHALL rank strategy selection priority by validated out-of-sample win rate for the current regime over the trailing 20 trading days, assigning higher priority to strategies with higher win rates.
8. IF a strategy's out-of-sample win rate over the trailing 20 trading days falls below the configured minimum performance threshold (a value between 0% and 100%), THEN THE StrategyEngine SHALL suspend that strategy from signal generation and publish a strategy-degradation alert to the NotificationService until the user explicitly re-enables the strategy.

---

### Requirement 7: Options Intelligence Engine

**User Story:** As a trader, I want the system to intelligently analyze and select options contracts based on OI, IV, Greeks, and liquidity, so that only well-priced, executable contracts are traded.

#### Acceptance Criteria

1. THE OptionsIntelligence SHALL compute Delta, Gamma, Theta, and Vega for all candidate options contracts using live option chain data from the DhanAPI; computed Greek values used for contract selection SHALL not be older than 60 seconds.
2. WHEN selecting a CE or PE contract for a signal, THE OptionsIntelligence SHALL select the contract where Delta falls within the configured minimum and maximum range (both between 0.01 and 0.99), IV rank falls within a configured percentile range (1 to 100 of the 52-week IV range), OI is at least the configured minimum whole-number contract count, and market depth quantity at the best bid and ask each meet the configured minimum — not solely by proximity to the ATM strike.
3. THE OptionsIntelligence SHALL track the IV regime for each underlying and classify it as expanding when current IV exceeds the configured baseline average by more than the configured percentage-point threshold (between 1 and 50), as contracting when it falls below by that same threshold, or as neutral otherwise; IV regime weight factors for contract selection and R:R estimation SHALL be independently configurable.
4. WHEN the current calendar date is an options expiry day, THE OptionsIntelligence SHALL apply expiry-day special controls: the required entry signal score SHALL exceed the standard entry threshold by a configurable positive amount, the maximum position size limit SHALL be set to a configured percentage between 10% and 90% of the standard maximum, and the mandatory square-off time SHALL be set to a configured time between 12:00 IST and 14:30 IST that precedes the standard session square-off time.
5. THE OptionsIntelligence SHALL compute the Theta decay rate in rupees per calendar day for all open options positions and express it as a non-negative magnitude (always greater than or equal to zero), representing the absolute daily value erosion, and provide the computed decay as an input to THE PositionMonitor's exit condition evaluation.
6. WHEN the bid-ask spread of a candidate contract exceeds the configured maximum spread threshold, THE OptionsIntelligence SHALL mark the contract as illiquid and THE SignalScorer SHALL apply the configured liquidity penalty to the Liquidity/Execution Feasibility score component for that signal.

---

### Requirement 8: Signal Scoring Engine

**User Story:** As a trader, I want every trading opportunity scored on a 0-100 scale with full explainability, so that only high-conviction, well-supported signals are acted upon.

#### Acceptance Criteria

1. THE SignalScorer SHALL compute a composite signal score from 0 to 100 using exactly 8 weighted components: Regime Alignment (15 points), Price Structure (15 points), Volume Confirmation (15 points), Momentum (10 points), VWAP/Trend Alignment (10 points), Options/Futures Confirmation (15 points), Liquidity/Execution Feasibility (10 points), and R:R Quality (10 points).
2. WHEN a signal is generated, THE SignalScorer SHALL produce a signal record containing: entry price, stop-loss price, target price, computed position size, composite score, per-component score breakdown, the measured input value used to derive each component's score, and the originating strategy identifier.
3. IF a signal's composite score is below 80, THEN THE RiskEngine SHALL reject the signal for live trading eligibility, and THE SignalScorer SHALL record the signal in the Signals table with rejection reason "score below threshold".
4. THE SignalScorer SHALL record every generated signal — whether accepted, rejected, or expired — in the Signals database table with all fields enumerated in criterion 2, plus the final status and rejection reason.
5. WHEN a signal's R:R ratio is below the originating strategy's configured minimum, THE SignalScorer SHALL set the R:R Quality component score to 0 regardless of all other component scores.
6. WHEN the entry price of a generated signal deviates from the current market price by more than the configured strategy-specific percentage threshold before the order is submitted, THE SignalScorer SHALL recompute the composite score and re-validate against the 80-point threshold before the ExecutionService submits the order.
7. IF a signal has not been acted upon within the configured maximum validity duration, THEN THE SignalScorer SHALL mark the signal as expired in the Signals table with status "expired" and record the expiry as the rejection reason.

---

### Requirement 9: Risk Management Engine

**User Story:** As a trader, I want the system to enforce strict, multi-layered risk controls, so that no single trade or sequence of trades can cause catastrophic or unrecoverable capital loss.

#### Acceptance Criteria

1. THE RiskEngine SHALL maintain the Dynamic_Capital value at all times, computed as starting capital plus cumulative realized net P&L after all brokerage, STT, exchange, GST, SEBI, and stamp duty charges.
2. THE RiskEngine SHALL compute position size for every signal as: risk_amount = Dynamic_Capital multiplied by configured_risk_percentage; quantity = risk_amount divided by (absolute value of entry_price minus stop_loss_price, multiplied by lot_size), truncated down to the nearest whole lot.
3. WHEN the second trade of a calendar trading day whose net P&L after all charges is negative is closed, THE RiskEngine SHALL disable all new entry signals for the remainder of that day until 15:30 IST and record a two-loss lockout event in the RiskEvents table.
4. WHEN cumulative intraday net loss including both realized and unrealized P&L for the current session reaches the configured daily monetary loss limit, THE RiskEngine SHALL trigger an emergency halt, block all new order submissions, and notify the user via the NotificationService.
5. IF a proposed order would breach any of the following limits — maximum per-trade monetary loss, maximum total open exposure as a percentage of Dynamic_Capital, maximum correlated exposure across instruments in the same underlying, maximum concurrent open trades, or maximum concentration in any single instrument — THEN THE RiskEngine SHALL reject the order and notify the user via the NotificationService indicating which specific limit was breached.
6. WHEN market data staleness exceeds the configured maximum allowed data age, THE RiskEngine SHALL block all new order submissions until fresh data receipt is confirmed.
7. WHEN India VIX exceeds the configured unusual-volatility threshold, THE RiskEngine SHALL reduce the maximum permitted position size to the configured volatility-protection limit.
8. WHEN the emergency kill switch is activated, THE RiskEngine SHALL cancel all open orders and submit market exit orders for all open positions within 10 seconds of activation, and record the kill switch event in the RiskEvents table.
9. IF the computed absolute difference between entry_price and stop_loss_price equals zero for any signal, THEN THE RiskEngine SHALL reject the signal and record the rejection in the RiskEvents table with reason "zero per-unit risk".
10. WHEN India VIX remains continuously below the configured unusual-volatility threshold for 5 consecutive minutes after a volatility-triggered position size reduction, THE RiskEngine SHALL restore the maximum permitted position size to the normal configured limit.
11. IF the lot_size for the instrument referenced by a signal is zero or not configured, THEN THE RiskEngine SHALL reject the signal and record a risk event in the RiskEvents table with reason "invalid lot_size configuration".

---

### Requirement 10: Paper Trading Engine

**User Story:** As a trader, I want a realistic paper trading simulation engine, so that I can validate strategy performance and system behavior without risking real capital.

#### Acceptance Criteria

1. THE PaperEngine SHALL be completely isolated from the LiveEngine; no code paths, database tables, event bus channels, or Redis keys SHALL be shared between the two engines.
2. WHEN a paper trade buy order is submitted, THE PaperEngine SHALL simulate execution at the current best ask price.
3. WHEN a paper trade sell order is submitted, THE PaperEngine SHALL simulate execution at the current best bid price.
4. IF the current best bid or best ask price is unavailable for an instrument at the time of paper order submission, THEN THE PaperEngine SHALL reject the order, preserve existing portfolio state and P&L, and record the rejection reason as "market data unavailable".
5. THE PaperEngine SHALL apply configurable slippage to every simulated fill using one of three configurable models: fixed-rupee slippage (valid range 0.00 to 50.00 rupees, default 0.00), percentage-of-price slippage (valid range 0.00% to 2.00%), or market-impact-based slippage.
6. THE PaperEngine SHALL deduct all trading costs from paper P&L including brokerage, STT, NSE exchange charges, GST, SEBI charges, and stamp duty, using the identical cost formulas applied by the LiveEngine.
7. THE PaperEngine SHALL evaluate a configurable rejection probability (valid range 0.00 to 1.00, default 0.00) for each order to simulate realistic exchange and broker rejection behavior.
8. IF an order is selected for simulated rejection, THEN THE PaperEngine SHALL return the order status as rejected, deduct no trading costs, and record no change to paper P&L.
9. THE PaperEngine SHALL simulate order execution latency using a configurable distribution (uniform, normal, or log-normal) with a configurable mean between 10 and 5000 milliseconds (default: uniform distribution with mean 200 ms); zero-latency instantaneous fills SHALL NOT be the default behavior.

---

### Requirement 11: Live Trading Engine

**User Story:** As a trader, I want a live trading engine with explicit two-step activation, fail-safes, and a kill switch, so that autonomous live trading can be authorized deliberately and halted immediately when required.

#### Acceptance Criteria

1. THE LiveEngine SHALL require a two-step user authorization sequence to enter Armed state: first activating live mode, then separately confirming the arm action; a single action SHALL NOT be sufficient to transition to Armed state.
2. WHEN the CloudEngine restarts, the browser updates, or a Dhan session token is renewed, THE LiveEngine SHALL revert to Disarmed state and require explicit user re-authorization to re-arm.
3. WHEN a new live entry order is requested, THE LiveEngine SHALL execute a pre-trade validation chain confirming: signal score is at least 80, RiskEngine approval is granted, available margin is greater than or equal to the required margin for the order, no duplicate order exists for the same instrument and direction, and the current time is within the regular market session and before the configured mandatory square-off time.
4. IF the pre-trade validation chain fails for any check, THEN THE LiveEngine SHALL reject the order without broker submission and return an error response indicating which specific validation check failed.
5. WHEN the emergency kill switch is activated, THE LiveEngine SHALL cancel all open orders and submit market orders to exit all open positions within 10 seconds of activation.
6. IF the kill switch execution results in any open orders or positions remaining after more than 10 seconds have elapsed since activation, THEN THE LiveEngine SHALL alert the user identifying which specific orders and positions remain open and require manual intervention.
7. IF the two-loss daily lockout or the daily monetary loss limit halt is active for the current trading day, THEN THE LiveEngine SHALL reject any new entry order submission without forwarding it to the broker.
8. WHILE open intraday positions exist AND the current time reaches the configured mandatory square-off time, THE LiveEngine SHALL submit market exit orders for all remaining open positions and record a mandatory-exit compliance event including the exit timestamp and all affected position identifiers.

---

### Requirement 12: Trailing Stop Engine

**User Story:** As a trader, I want the system to manage trailing stops with multiple mechanisms and broker-side protection, so that unrealized profits are protected as trades move in the favorable direction.

#### Acceptance Criteria

1. THE TrailingStopEngine SHALL support exactly 8 trailing stop mechanisms: ATR-based, Swing High/Low, Chandelier Exit, Percentage-based, Volatility-adjusted, Structure-based, Time-based, and Partial-profit trailing.
2. WHEN a trailing stop level is updated, THE TrailingStopEngine SHALL only move the stop-loss in the profit direction, defined as strictly higher for long positions and strictly lower for short positions; the stop-loss SHALL never be moved in a direction that increases risk on an open position.
3. WHEN a trailing stop is activated for a position, THE TrailingStopEngine SHALL register the stop-loss with Dhan Super Orders as a broker-side protection layer within 5 seconds, maintaining an internal SL level in addition to the broker-side order.
4. WHEN the CloudEngine reconnects to the DhanAPI after any disconnection, THE ReconciliationService SHALL verify the broker-side SL status of every open position within 60 seconds and report all discrepancies to THE TrailingStopEngine.
5. IF a Super Order SL confirmation has not been received from the DhanAPI for any open position, THEN THE TrailingStopEngine SHALL treat the broker-side SL as inactive and submit a replacement SL order.
6. WHILE a partial-profit trailing mechanism is active for a position AND the underlying price reaches the configured first target price, THE TrailingStopEngine SHALL exit the configured partial quantity and move the stop-loss to the configured post-partial stop price.
7. IF the DhanAPI reports that a broker-side SL order has been rejected or cancelled for any open position, THEN THE TrailingStopEngine SHALL submit a replacement SL order within 5 seconds and publish a critical alert to the NotificationService.
8. IF the DhanAPI reports a replacement SL order rejection for the same position for 3 or more consecutive attempts, THEN THE TrailingStopEngine SHALL escalate by publishing a maximum-priority alert to the NotificationService and disabling new entries until the user acknowledges the alert.
9. WHEN the user acknowledges the maximum-priority SL escalation alert published under criterion 8, THE TrailingStopEngine SHALL reset the consecutive broker-side SL rejection counter for that position to zero, regardless of the counter's current value at the time of acknowledgment.

---

### Requirement 13: Trade Journal and Audit Trail

**User Story:** As a trader, I want an immutable, comprehensive trade journal, so that every decision, execution, and outcome is permanently recorded for performance review, forensic analysis, and regulatory compliance.

#### Acceptance Criteria

1. THE TradeJournal SHALL maintain separate, append-only record sets for: signals, rejected signals, orders, fills, positions, completed trades, risk events, system errors, and configuration changes.
2. WHEN a trade is completed, THE TradeJournal SHALL record: trade ID, instrument, strategy, signal score, entry price, exit price, quantity, entry time, exit time, MFE, MAE, gross P&L, per-component charges, net P&L, exit reason, execution slippage, and all associated Dhan order IDs.
3. THE TradeJournal SHALL implement append-only write semantics; no record SHALL be modified or deleted after initial creation.
4. WHEN a user makes a configuration change, THE TradeJournal SHALL record the user identifier, timestamp, field name, previous value, and new value in the AuditLogs table.
5. WHEN a risk event occurs — including daily lockout, drawdown breach, kill switch activation, or SL order rejection — THE TradeJournal SHALL record the event including: event type, event timestamp, triggering metric name and value, applicable threshold value, affected instrument or strategy identifier, and initiating actor within 1 second of occurrence.
6. WHEN a signal is rejected, THE TradeJournal SHALL record the instrument, strategy, entry timestamp, rejection timestamp, composite score, per-component score breakdown, and rejection reason in the Signals table.
7. IF a TradeJournal write operation fails, THEN THE TradeJournal SHALL retry the write up to 3 times within 30 seconds; if all retries fail, THE TradeJournal SHALL emit an operator alert identifying the record type and failure reason, and SHALL NOT silently drop the record.
8. THE TradeJournal SHALL persist trade completion, configuration change, and signal rejection records within 5 seconds of the triggering event.

---

### Requirement 14: Analytics and Performance Reporting

**User Story:** As a trader, I want a comprehensive analytics dashboard with strategy attribution and intelligence reporting, so that I can evaluate performance, identify weaknesses, and make data-driven capital allocation decisions.

#### Acceptance Criteria

1. THE AnalyticsService SHALL compute and display the following metrics separately for Live and Paper trading modes for a user-selectable time window (current session, last 30 days, or all-time): win rate, profit factor, expectancy, average win, average loss, R:R ratio, maximum drawdown, Sharpe ratio, Sortino ratio, Calmar ratio, maximum consecutive wins, and maximum consecutive losses.
2. IF the trade count for a selected time window is fewer than 30, THEN THE AnalyticsService SHALL suppress ratio-based metrics (Sharpe, Sortino, Calmar, profit factor) and display an "insufficient data — fewer than 30 trades" warning in their place.
3. THE AnalyticsService SHALL provide performance attribution breakdowns by strategy, instrument, market regime, and time-of-day bucket (each bucket spanning exactly 60 minutes).
4. WHEN a trading session ends, THE AnalyticsService SHALL generate a Daily Trading Intelligence Report containing trade summary, regime observations, strategy performance, capital changes, and the specific threshold criterion not met for each signal that was generated but not executed.
5. WHEN a trading session ends AND no trades were placed during that session, THE AnalyticsService SHALL record a No-Trade Intelligence entry documenting the regime, all evaluated signals with their scores, and the specific threshold criterion not met for each signal.
6. THE AnalyticsService SHALL provide a Capital Compounding Simulator that projects capital growth over a user-selected horizon (1, 3, or 5 years) using a configured compounding frequency (daily, weekly, or monthly) and a configured withdrawal rate between 0% and 100% in whole-percentage increments, based on historical performance statistics.
7. THE AnalyticsService SHALL maintain a Market Activity Heatmap showing the count of valid trade signals by instrument, time-of-day bucket, and regime over the trailing 30 trading days.

---

### Requirement 15: Quantitative Validation

**User Story:** As a system operator, I want mandatory backtesting and statistical validation gates before live deployment, so that no strategy enters live trading without evidence of out-of-sample profitability.

#### Acceptance Criteria

1. THE BacktestEngine SHALL support walk-forward validation and out-of-sample testing for all 8 strategies with no look-ahead bias and no survivorship bias in the historical data set.
2. WHEN backtesting a strategy, THE BacktestEngine SHALL apply the same cost model as the PaperEngine, including brokerage, STT, exchange charges, GST, SEBI charges, and stamp duty for every simulated trade.
3. WHEN a strategy is submitted for live deployment, THE ComplianceModule SHALL verify all of the following profitability gates: positive out-of-sample expectancy, maximum drawdown within the configured threshold, a minimum sample of 30 closed trades per regime tested, and robustness confirmed by Monte Carlo simulation with at least 1,000 iterations of which at least 95% yield positive out-of-sample expectancy.
4. THE BacktestEngine SHALL compute confidence intervals at the 95% confidence level for expectancy, win rate, and maximum drawdown using bootstrap resampling with at least 1,000 resamples.
5. WHEN a strategy fails any profitability gate, THE ComplianceModule SHALL block the strategy from live trading and record the failure in the Strategies table with the specific failing criterion and the computed value.
6. THE BacktestEngine SHALL support walk-forward validation with a configurable in-sample to out-of-sample split ratio between 50% and 90% in-sample.

---

### Requirement 16: Security and Secrets Management

**User Story:** As a system operator, I want comprehensive security controls, so that credentials are never exposed and the system is protected against unauthorized access and common attack vectors.

#### Acceptance Criteria

1. THE CloudEngine SHALL store all broker credentials, API keys, and session tokens in a dedicated secrets management store; no secret value SHALL appear in application logs, environment variable exports, or API responses.
2. THE Extension SHALL never pass broker credentials, API keys, or session tokens through content scripts, window.postMessage calls, or any DOM-accessible mechanism.
3. THE CloudEngine SHALL enforce rate limiting on all API endpoints with a configurable per-endpoint limit (default: 100 requests per minute per authenticated client).
4. IF a rate limit is exceeded on any CloudEngine API endpoint, THEN THE CloudEngine SHALL return an HTTP 429 response including a Retry-After header specifying a strictly positive integer number of seconds (greater than 0) until the rate limit resets.
5. THE CloudEngine SHALL implement CSRF protection on all state-modifying API endpoints, including order submission, configuration changes, kill switch activation, and authentication actions.
6. THE CloudEngine SHALL enforce duplicate-order prevention at the execution layer by assigning each order a unique idempotency key with a validity window of 5 minutes.
7. IF THE CloudEngine receives an order with a duplicate idempotency key within the 5-minute validity window, THEN THE CloudEngine SHALL return a duplicate-order-rejected error response to the caller without forwarding the order to the DhanAPI.
8. THE CloudEngine SHALL encrypt sensitive data at rest in PostgreSQL using field-level encryption for credentials and personally identifiable information.
9. WHEN an authentication event, configuration change, trade authorization action, kill switch activation, or arming/disarming event occurs, THE CloudEngine SHALL produce an AuditLog entry containing the authenticated user identifier, event type, UTC timestamp, and outcome.

---

### Requirement 17: Session Management

**User Story:** As a trader, I want the system to manage NSE trading session phases automatically, so that strategies and risk controls adapt to the session context and no intraday positions are carried forward unintentionally.

#### Acceptance Criteria

1. THE SessionManager SHALL track the following NSE session phases with their defined IST time windows: Pre-market (09:00-09:15), Opening Volatility (09:15-09:20), ORB Formation (09:15-09:30), Morning Momentum (09:30-11:00), Mid-session (11:00-13:00), Afternoon (13:00-14:30), Closing (14:30-15:30), and End-of-Day Reconciliation (15:30-16:00).
2. WHEN the session transitions to the Opening Volatility phase, THE StrategyEngine SHALL restrict active strategies to those with the opening-phase compatibility flag enabled.
3. WHEN the session enters the Closing phase at 14:30 IST, THE LiveEngine SHALL block all new position entries.
4. WHEN the mandatory intraday square-off time of 15:15 IST is reached, THE LiveEngine SHALL submit market exit orders for all open positions not yet closed by trailing stops or profit targets.
5. WHEN THE SessionManager transitions to any new session phase, THE SessionManager SHALL publish a session-phase-change event consumed by THE StrategyEngine, RiskEngine, and OptionsIntelligence to adjust their operating parameters for the new phase.
6. WHEN the End-of-Day Reconciliation phase begins at 15:30 IST, THE ReconciliationService SHALL reconcile all CloudEngine position and order records against the Dhan broker portfolio; a discrepancy is defined as any non-zero difference in net position quantity or instrument, and any discrepancies SHALL be flagged for user review.
7. IF a mandatory square-off market exit order is rejected or unconfirmed for any open position within 5 minutes of the 15:15 IST square-off time, THEN THE LiveEngine SHALL alert the user identifying the affected position and require manual intervention.

---

### Requirement 18: Data Persistence

**User Story:** As a system operator, I want a well-structured, comprehensive database schema, so that all trading data is reliably stored, queryable, and available for audit, analytics, and disaster recovery.

#### Acceptance Criteria

1. THE CloudEngine SHALL maintain exactly 24 PostgreSQL database models: UserSettings, BrokerAccounts, BrokerSessions, Instruments, MarketSnapshots, HistoricalCandles, OptionChainSnapshots, MarketRegimes, Strategies, StrategyVersions, Signals, SignalEvaluations, Orders, Executions, Positions, Trades, CapitalLedgers, RiskEvents, DailyTradingSummaries, StrategyPerformance, ModelVersions, ModelEvaluations, SystemHealthEvents, and AuditLogs.
2. THE CapitalLedger SHALL record every capital movement event with a timestamp, including trade P&L net of all charges, manual deposits, manual withdrawals, and compounding events.
3. WHEN a trade is closed, THE CloudEngine SHALL update the CapitalLedger and recompute Dynamic_Capital within 500 milliseconds before evaluating any subsequent signal.
4. IF the CapitalLedger update or Dynamic_Capital recomputation fails after a trade is closed, THEN THE CloudEngine SHALL immediately halt new signal evaluations regardless of the outcome of subsequent error-recording or balance-retention steps, retain the last successfully committed CapitalLedger balance, and record an error event in SystemHealthEvents within 1 second.
5. THE CloudEngine SHALL perform at least one automated PostgreSQL backup between 00:00 IST and 06:00 IST each calendar day.
6. WHEN an automated PostgreSQL backup completes or fails, THE CloudEngine SHALL record the outcome in SystemHealthEvents within 60 seconds.
7. THE CloudEngine SHALL cache live market data snapshots in Redis with a TTL of 2 seconds, option chain data with a TTL of 10 seconds, regime state with a TTL of 300 seconds, and signal scores with a TTL of 60 seconds.
8. THE HistoricalCandles table SHALL store OHLCV data for all subscribed instruments at 1-minute, 5-minute, 15-minute, and daily granularities, retaining 1-minute and 5-minute data for a minimum of 90 days, 15-minute data for a minimum of 1 year, and daily data for a minimum of 5 years.

---

### Requirement 19: Reconciliation

**User Story:** As a trader, I want automated reconciliation between the cloud engine and the Dhan broker, so that state discrepancies are detected immediately and resolved before they affect trading decisions.

#### Acceptance Criteria

1. WHEN the NSE trading session closes, THE ReconciliationService SHALL reconcile CloudEngine order, execution, position, and P&L records against Dhan broker records within 30 minutes of session close.
2. WHEN a discrepancy — defined as any non-zero difference in net position quantity or instrument between CloudEngine records and Dhan broker records — is detected, THE ReconciliationService SHALL halt new order submissions — while permitting modification and cancellation of existing orders to continue — until the user explicitly acknowledges the discrepancy or the records return to full agreement.
3. WHEN the CloudEngine reconnects to the DhanAPI after any disconnection, THE ReconciliationService SHALL reconcile all open position and pending order records within 30 seconds of reconnection.
4. THE ReconciliationService SHALL record every reconciliation run, every discrepancy found, and every resolution action in the AuditLogs table.
5. WHEN the DhanAPI reports a fill that does not match any CloudEngine order record by order identifier, THE ReconciliationService SHALL flag the fill as an unrecognized execution and publish an alert to the NotificationService within 10 seconds.
6. WHEN a reconciliation run completes, THE ReconciliationService SHALL produce a reconciliation report confirming whether CloudEngine net P&L, Dhan broker net P&L, and the CapitalLedger closing balance are in agreement within a 1-rupee tolerance.
7. IF the reconnection reconciliation fails to complete within 30 seconds, THEN THE ReconciliationService SHALL halt all new order submissions and publish an alert to the NotificationService identifying the reconciliation timeout.

---

### Requirement 20: Advanced Intelligence Features

**User Story:** As a trader, I want advanced intelligence features that explain system decisions, rank opportunities, and provide actionable operational insights, so that I can understand, trust, and improve the autonomous trading operation.

#### Acceptance Criteria

1. WHEN a signal evaluation completes, THE SignalScorer SHALL produce an Opportunity Intelligence Ranking that orders all active signals by composite score, estimated expected value, and regime alignment strength, with a natural-language explanation for each signal's ranking position.
2. WHEN the Adaptive Strategy Engine selects a strategy for the current regime, THE StrategyEngine SHALL record the selection rationale — including the regime, the performance metrics used, and the selected strategy — in the StrategyPerformance table.
3. WHEN a trade is completed, THE AnalyticsService SHALL produce Trade Quality Forensics computing a QCR (actual net P&L divided by MFE); classify the exit as premature if QCR is below 0.70, near-optimal if QCR is at least 0.70 and the exit occurred at or before the time of MFE, or late if QCR is at least 0.70 and the exit occurred after the time of MFE; and categorize overall execution quality as Poor (QCR below 0.40), Fair (QCR between 0.40 and 0.70), Good (QCR between 0.70 and 0.90), or Excellent (QCR at or above 0.90).
4. IF MFE for a completed trade equals zero, THEN THE AnalyticsService SHALL record QCR as undefined and set the execution quality category to "No Favorable Excursion" without performing division.
5. WHEN a trading session ends, THE AnalyticsService SHALL produce a Strategy Performance Attribution report breaking down total portfolio P&L contribution by strategy, by market regime, and by instrument class.
6. THE CloudEngine SHALL expose an Options Flow Dashboard that displays aggregate net OI change, put/call ratio, IV skew, and single-trade options activity where the contract volume exceeds the system-configured large-block detection threshold for all monitored instruments, updated at intervals not exceeding 60 seconds.
7. IF the Options Flow data source is unavailable or data is older than 60 seconds, THEN THE CloudEngine SHALL display a staleness indicator on the Options Flow Dashboard and suppress Options/Futures Confirmation score contributions until fresh data is received.
8. WHILE NSE market hours are active, THE SystemHealthMonitor SHALL track CloudEngine module health, DhanAPI connectivity status, PostgreSQL connection pool status, Redis availability, WebSocket feed latency, and live order execution latency, classify each metric as Healthy, Degraded, or Down, and publish health status updates to the NotificationService at 30-second intervals.
9. IF any tracked health metric transitions from Healthy to Degraded or from Degraded to Down, THEN THE SystemHealthMonitor SHALL publish an immediate alert to the NotificationService, independent of the 30-second polling interval.
