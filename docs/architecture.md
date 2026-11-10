# Architecture

## Overview

MoneyPrinter has two runtime components:
1. **CloudEngine** - NestJS backend (port 3000)
2. **Chrome Extension MV3** - Browser control plane

Communication is exclusively via WSS and HTTPS.

## Layer Diagram

```
Chrome Extension (MV3)
  BSW <--WSS--> CloudEngine  |  Popup  |  SidePanel  |  Dashboard

CloudEngine (NestJS)
  MarketData -> TechnicalAnalysis -> OptionsIntelligence
  MarketRegime (10 regimes, VIX override)
  InstrumentDiscovery (OI/ADV filter, liquidity score)
  Strategy (8 strategies A-H, 5-gate evaluation)
  SignalScoring (8-component composite, >= 80 threshold)
  RiskManagement (8 gates, state machine, VIX sizing)
  Execution (5-check pre-trade, Dhan API, idempotency)
  TrailingStop (8 mechanisms, SL monotonicity, broker SL)
  PositionMonitoring (MFE/MAE, exit condit  PositionMond)
  LiveTrading (two-step arming, kill switch)
  PaperTrading (fully i  PaperTrading (fully i  PaperTna  PaperTrading (fully i  PaperTrading (ftfolio (Dynamic  PaperTrading (fully i  PaperTrading (full (append-only, 9 record sets, SLA)
  Notification (priority queue, WebSocket push)
  Reconciliation (EOD + reconnection + SL verification)
  Analytics (12 metrics, attribution, QCR, Daily Report)
  Compliance (4 profitability gates, Monte Carlo)
  Backtest (walk-forward, no look-ahead/survivorship bias)
  SystemHealthMonitor (6 metrics, Redis TTL keys)
  OptionsFlow (PCR, IV skew, large-block detection)

Infrastructure: PostgreSQL 15 | Redis 7 | NestJS EventEmitter2
```

## Redis Pub/Sub Channels

| Channel | Publisher | Subscribers |
|---|---|---|
| `events:tick:{instrument_id}` | MarketDataModule | PositionMonitoring, TechnicalAnalysis, Options| `events:tick:{instrument_id}` | MarketDataModule | eM| `events:tick:{instrument_id}` | MarketDataModule | Poste| `events:tick:{instrumesion_phase` | SessionManagerModule| `events:tick:{instrument_id}` | MarketDatpt| `events:tick:{instrument_id}` | MarketDataModule | PositionMonitoring, TechnicalAnalysis, Options| `events:tick:{instrument_id}` | MarketDataModule | eM| `events:tick:{instrument_id}` |:trade` | PaperTradingService | Paper engine consumers only |

## NestJS EventEmitter2 Events

| Event | Emitter | Handler |
|---|---|---|
| `strategy.signal.candidate` | StrategyService | PipelineWiringService -> SignalScoringService |
| `risk.unrealized_pnl_updated` | P| `risk.unitoringService | PipelineWiringService -> DailyLossStateMachineService |
| `position.exit` | | `position.exit` | | `position.exit` | | `position.exit` | |na| ervice |
| `risk.daily_loss_st| `risk.daily_loss_st| `risk.daily_lSe| `risk.dourna| `risk.daily_loss_st| `risk.daily_loss_st| `risk.daily_lSe| `risk.dourna| `risk.daily_loss_st| `risk.daily_loss_st| `risk.daily_lSe| `risk.dourna| `risk.daily_loss_st| `risk.daily_loss_st| `risk.daily_lSe| `risk.dourna| `risk.daily_loss_st| `risk.daily_loss_st| `risk.daily_lSe| `risk.dourna| `risk.daily_loss_st| `risk.daily_loss_st| `risk.daily_lSe| `risk.dourna| `risk.daily_loss_st| `risk.daily_loss_st| `risk.daily_lSe| `risk.dourna| `risk.daily_loss_st| `risk.daily_loss_st| `risk.daily_lSe| `risk.dourna| `risk.daily_loss_st| `risk.daily_loss_st| `risk.des | `risk.daily_loss_st| `risk.nService runs 5-check pre-trade chain, places Dhan order
9. TrailingStop registers broker-side SL via Dhan Super Order within 5s
10. PositionMonitoring subscribes to tick, tracks MFE/MAE, evaluates exits

## Paper/Live Isolation

| Layer | Live Engine | Paper Engine |
|---|---|---|
| DB tables | orders, executions, positions, trades | paper_orders, paper_executions, paper_positions, paper_trades |
| Redis keys | orders:{id}, portfolio:balance | paper:orders:{id}, paper:portfolio:balance |
| Event channels | events:fill, events:order | events:paper:fill, events:paper:order |
| Dhan API | Real orders placed | Never calls DhanApiClient |
