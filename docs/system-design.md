# MoneyPrinter — System Design

## Overview

MoneyPrinter is a NestJS-based autonomous trading platform for NSE F&O **options buying** via the Dhan brokerage API. It runs as a single CloudEngine process (NestJS, port configurable via `PORT`) paired with a Chrome Extension MV3 control plane. All communication uses CORS-enabled HTTP/WebSocket.

The engine has 25+ NestJS modules wired through two event buses:
- **Redis pub/sub** — cross-module real-time data (ticks, regime changes, session phases)
- **NestJS EventEmitter2** — intra-process domain events (signal candidates, P&L updates, exit signals, partial profit)

PostgreSQL stores all durable state via TypeORM with schema changes managed exclusively through migrations (`synchronize: false`).

---

## Trading Approach

### Options Buying Only

The bot exclusively **buys** options (CE/PE). Short selling is structurally blocked:
- `PaperTradingService` rejects SELL orders with no open position (would open SHORT)
- `InstrumentDiscoveryService` marks `INDEX_FUTURE` and `STOCK_FUTURE` as `isTradable = false`
- Only `INDEX_OPTION` and `STOCK_OPTION` from `NSE_FNO`/`BSE_FNO` segments are tradable

### Instrument Universe

| Allowed | Blocked |
|---|---|
| Index options: Nifty, BankNifty, FinNifty, MidcpNifty, Sensex, Bankex, NiftyNxt50 | All futures (INDEX_FUTURE, STOCK_FUTURE) |
| F&O stock options (NSE_FNO, BSE_FNO) with optional OI/ADV filters | Equity/spot segments (NSE_EQ, BSE_EQ) |

### Greedy Trailing (Post-First-Target)

After the first target is hit, the engine auto-decides whether to trail the remaining position:

```
Phase 1 (scalp):  Enter at signal → first target → exit 50% (PARTIAL_PROFIT)
Phase 2 (trail):  GreedyTrailService evaluates 3 conditions:
  1. DIRECTION  — price still moving in trade direction
  2. VOLUME     — session volume ≥ 60% of entry baseline
  3. OI_ACTIVE  — open interest > 0 (healthy contract)

  3/3 → CHANDELIER_EXIT (period=14, mult=3×ATR) — biggest trail
  2/3 → ATR_BASED (mult=2×ATR) — standard trail
  <2  → take full profit
```

After partial exit, SL is moved to break-even (entry price). The position becomes risk-free.

---

## Capital and Risk Management

### Paper Trading Capital

Default: **₹50,000** (configurable via `PUT /settings` or the popup settings panel).

Stored in `user_settings.paper_starting_capital`. The `PaperTradingService` reads from the DB at runtime — no hardcoded constants.

### Position Sizing Formula

```
risk_amount = capital × risk_percentage / 100   (default 1%)
quantity    = FLOOR(risk_amount / (|entry − SL| × lot_size))
```

At ₹50K capital: risk ₹500/trade, quantity sized so max loss = ₹500.

### 8 Pre-Entry Risk Gates

| Gate | Rule | Default |
|---|---|---|
| SIGNAL_SCORE | Composite score ≥ 80 | Hard |
| ZERO_PER_UNIT_RISK | entry ≠ SL | Hard |
| INVALID_LOT_SIZE | lot_size > 0 | Hard |
| PER_TRADE_LOSS | risk_amount ≤ ₹5,000 | ₹5,000 |
| TOTAL_EXPOSURE | all positions ≤ 100% capital | 100% (paper) |
| CORRELATED_EXPOSURE | same underlying ≤ 50% capital | 50% (paper) |
| CONCURRENT_TRADES | open positions < 5 | 5 |
| CONCENTRATION | single instrument ≤ 80% capital | 80% (paper) |

### Daily Loss State Machine

```
NORMAL → TWO_LOSS_LOCKOUT (after 2 consecutive losing trades)
NORMAL → EMERGENCY_HALT   (intraday loss ≥ DAILY_LOSS_LIMIT_RUPEES)
any    → KILL_SWITCH_ACTIVE (manual)
```

Auto-resets at midnight IST. `KILL_SWITCH_ACTIVE` requires manual deactivation.

### Broker-Side Safety Net

At session open (09:15 IST), the CloudEngine calls Dhan's P&L Exit API:

```typescript
setPnlExit({
  lossValue: DAILY_LOSS_LIMIT_RUPEES,  // e.g. ₹10,000
  profitValue: DAILY_LOSS_LIMIT × 3,  // e.g. ₹30,000
  productType: ['INTRADAY'],
  enableKillSwitch: true,              // Dhan kills account on breach
})
```

This ensures positions are closed even if the CloudEngine crashes.

---

## Database Entities

| Entity | Table | Purpose |
|---|---|---|
| `AuditLogs` | `audit_logs` | Immutable auth/config audit trail; AES-256-GCM on sensitive columns |
| `BrokerAccounts` | `broker_accounts` | Dhan API credentials; `api_key` and `access_token` encrypted |
| `BrokerSessions` | `broker_sessions` | Active JWT sessions; `isActive` flag gates every request |
| `CapitalLedgers` | `capital_ledgers` | Append-only Dynamic Capital ledger |
| `Instruments` | `instruments` | NSE F&O universe; daily scan at 09:15 IST; options-only tradable |
| `Order` | `orders` | Live-engine orders with idempotency key |
| `PaperOrder/Execution/Position/Trade` | `paper_*` | Fully isolated paper engine tables |
| `Position` | `positions` | Live open positions; MFE/MAE tracked in-memory |
| `RiskEvents` | `risk_events` | Immutable risk state transitions |
| `Signals` | `signals` | Scored signals; 8 component scores + JSONB measuredInputs |
| `Strategies` | `strategies` | 8 strategies (A–H) with regime compatibility configs |
| `Trades` | `trades` | Closed live trades; `net_pnl` = gross minus all 6 charge components |
| `UserSettings` | `user_settings` | Per-user config: `paperStartingCapital`, `defaultRiskPercentage`, etc. |

---

## Redis Key Schema

### Live cache keys

| Key | TTL | Value |
|---|---|---|
| `mkt:snapshot:{instrument_id}` | 2 s | JSON `MarketSnapshot` (LTP, bid, ask, volume, OI) |
| `mkt:optchain:{underlying}:{expiry}` | 10 s | Option chain JSON (from Dhan API) |
| `regime:current` | 300 s | Regime code string (e.g. `"STRONG_BULL"`) |
| `session:phase:current` | persistent | Session phase (e.g. `"MORNING_MOMENTUM"`) |
| `trading:armed_state` | persistent | `"DISARMED"` \| `"ARMED_PENDING"` \| `"ARMED"` |
| `health:{metric_name}` | 90 s | `"Healthy"` \| `"Degraded"` \| `"Down"` |
| `notifications:pending:{priority}` | session | Buffered alerts for offline Extension clients |

### Paper engine keys

| Key | Purpose |
|---|---|
| `paper:portfolio:balance` | Paper Dynamic Capital (INR string) |
| `paper:orders:{id}` | Paper order snapshot |
| `paper:orders:idempotency:{key}` | Duplicate guard (TTL 300 s) |
| `paper:positions:{id}` | Paper position snapshot |

### Pub/sub channels

| Channel | Publisher | Subscribers |
|---|---|---|
| `events:tick:{instrument_id}` | MarketData | PositionMonitoring, TechnicalAnalysis |
| `events:regime_change` | MarketRegime | LiveTrading, Strategy, RiskManagement |
| `events:session_phase` | SessionManager | LiveTrading, RedisChannelWiring |
| `events:fill` | Execution | PositionMonitoring, TradeJournal |
| `events:paper:fill` | PaperTrading | PaperTrading consumers |
| `events:paper:order` | PaperTrading | PaperTrading consumers |
| `events:paper:trade` | PaperTrading | Portfolio, Analytics |

---

## Event Flow (Signal → Trade)

```
1. MarketData publishes tick to events:tick:{instrument_id}
2. TechnicalAnalysis computes VWAP, ATR, EMA, RSI, MACD
3. OptionsIntelligence fetches Greeks (60s cache), IV regime
4. Strategy.evaluateSignalCandidate() runs 5 gates
5. Gate 5 → emit SIGNAL_CANDIDATE_EVENT (EventEmitter2)
6. PipelineWiring → SignalScoring.scoreAndPersistSignal()
   - 8-component composite score ≥ 80 to pass
7. RiskManagement.evaluatePreEntryGates() — 8 gates
8. ExecutionService.placeOrder() — 5-check pre-trade chain
9. Order placed via DhanApiClient.placeOrder()
10. TrailingStop registers SL via DhanApiClient.getOrderById() (verify) 
11. PositionMonitoring subscribes to tick, tracks MFE/MAE
12. On first target hit:
    - PARTIAL_PROFIT_BOOKED event emitted (50% exit)
    - GreedyTrailService.decide() checks 3 conditions
    - If 2+/3 → update trailing mechanism + SL to break-even
    - If <2  → full exit
13. TradeJournal records completed trade with all 6 charge components
14. Portfolio updates Dynamic Capital = starting + SUM(net_pnl)
```

---

## Paper/Live Isolation

| Layer | Paper | Live |
|---|---|---|
| DB tables | `paper_orders`, `paper_positions`, `paper_trades`, `paper_executions` | `orders`, `positions`, `trades`, `executions` |
| Redis keys | `paper:*` prefix | no prefix |
| Event channels | `events:paper:*` | `events:*` |
| Dhan API | Never called (simulated fills) | Real orders |
| Engine flag | `engine = 'PAPER'` on all entities | `engine = 'LIVE'` |

---

## Dhan API Charge Rates (NSE Options)

All charges calculated by `TradingChargesService` (single source of truth):

| Component | Rate | Notes |
|---|---|---|
| Brokerage | ₹40 (₹20 × 2) | Flat per executed order × 2 legs |
| STT | **0.1%** of sell premium | Budget 2024 (up from 0.0625%) |
| Exchange | 0.053% of total turnover | NSE flat rate |
| GST | 18% on brokerage + exchange | — |
| SEBI | ₹10/crore = 0.000001× | — |
| Stamp duty | 0.003% of buy premium | Buy side only |
