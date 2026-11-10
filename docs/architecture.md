# Architecture

## Overview

MoneyPrinter has two runtime components:
1. **CloudEngine** — NestJS backend (port configurable via `PORT`, default `3002` in local dev)
2. **Chrome Extension MV3** — Browser control plane

Communication: HTTP (REST) + WebSocket. CORS enabled for `chrome-extension://*` and `localhost`.

## Layer Diagram

```
Chrome Extension (MV3)
  BSW ──ws://localhost:3003──> CloudEngine  │  Popup  │  SidePanel  │  Dashboard

CloudEngine (NestJS)
  MarketData → TechnicalAnalysis → OptionsIntelligence
  MarketRegime (10 regimes, VIX override)
  InstrumentDiscovery (options-only: Nifty/BankNifty/etc + NSE_FNO stocks; futures blocked)
  Strategy (8 strategies A–H, 5-gate evaluation)
  SignalScoring (8-component composite, ≥80 threshold)
  RiskManagement (8 gates, state machine, VIX sizing)
  TradingChargesService (STT 0.1%; single source of truth)
  Execution (5-check pre-trade; getOrderById for SL verification)
  TrailingStop (8 mechanisms; PARTIAL_PROFIT → GreedyTrailService)
  GreedyTrailService (3-condition check → auto-select CHANDELIER or ATR trail)
  PositionMonitoring (MFE/MAE, PARTIAL_PROFIT_BOOKED event)
  LiveTrading (two-step arm; kill switch + Dhan setKillSwitch; broker P&L exit at 09:15)
  PaperTrading (fully isolated; options-buying only; ₹50K default; configurable)
  SessionManager (8 NSE phases, mandatory 15:15 IST square-off)
  Portfolio (Dynamic Capital; GET /portfolio/summary)
  Settings (GET/PUT /settings; configurable paper capital + risk %)
  SystemHealthMonitor (6 metrics, Redis TTL keys, 30s poll)
  OptionsFlow (net OI, PCR, IV skew, large-block ≤60s)
  Notification (priority queue, WebSocket push, Redis buffer)

Infrastructure: PostgreSQL 15 (port 5435) │ Redis 7 (port 6380) │ NestJS EventEmitter2
```

## Redis Pub/Sub Channels

| Channel | Publisher | Subscribers |
|---|---|---|
| `events:tick:{instrument_id}` | MarketDataModule | PositionMonitoring, TechnicalAnalysis |
| `events:regime_change` | MarketRegimeModule | LiveTrading, Strategy, RiskManagement |
| `events:session_phase` | SessionManagerModule | LiveTrading, RedisChannelWiring |
| `events:fill` | ExecutionService | PositionMonitoring, TradeJournal |
| `events:paper:fill` | PaperTradingService | Paper engine consumers |
| `events:paper:order` | PaperTradingService | Paper engine consumers |
| `events:paper:trade` | PaperTradingService | Portfolio, Analytics |

## NestJS EventEmitter2 Events

| Event | Emitter | Handler |
|---|---|---|
| `strategy.signal.candidate` | StrategyService | PipelineWiring → SignalScoringService |
| `risk.unrealized_pnl_updated` | PositionMonitoring | DailyLossStateMachineService |
| `position.exit` | PositionMonitoring | ExecutionService, LiveTrading |
| `risk.daily_loss_state_changed` | DailyLossStateMachine | LiveTrading |
| `instruments.universe.updated` | InstrumentDiscovery | SubscriptionRotation |

## Signal → Trade Flow

```
1. MarketData tick
2. TechnicalAnalysis: VWAP, ATR, EMA, RSI, MACD
3. OptionsIntelligence: Greeks (60s cache), IV regime, getActiveExpiries()
4. Strategy 5-gate evaluation → emit signal candidate
5. SignalScoring: 8-component score ≥ 80 → persist signal
6. RiskManagement 8-gate pre-entry evaluation
7. Execution: 5-check pre-trade → placeOrder via Dhan
8. TrailingStop: register SL via placeOrder, verify via getOrderById
9. PositionMonitoring: tick monitoring, MFE/MAE, greedy partial profit
10. On first target:
    a. PARTIAL_PROFIT_BOOKED → exit 50%
    b. GreedyTrailService: 3 conditions → CHANDELIER (3/3) or ATR (2/3) or full exit
    c. SL moved to break-even (risk-free remaining position)
11. TradeJournal: net_pnl = gross - all 6 charges (STT 0.1%)
12. Portfolio: Dynamic Capital += net_pnl
```

## Paper/Live Isolation

| Layer | Live Engine | Paper Engine |
|---|---|---|
| DB tables | orders, executions, positions, trades | paper_orders, paper_executions, paper_positions, paper_trades |
| Redis keys | orders:{id}, portfolio:balance | paper:orders:{id}, paper:portfolio:balance |
| Event channels | events:fill, events:order | events:paper:fill, events:paper:order |
| Dhan API | Real orders placed | Never calls DhanApiClient |
| Entry direction | BUY or SELL (options) | **BUY only** (SHORT blocked) |
