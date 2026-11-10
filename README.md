# MoneyPrinter

> Autonomous AI-Powered Quantitative Trading Platform for NSE Options via Dhan Broker

**162 tasks implemented · 1,442 tests passing · 55 test suites · TypeScript strict mode**

---

## Overview

MoneyPrinter is a production-grade autonomous quantitative trading platform for NSE options via
the Dhan broker API. It combines a **NestJS TypeScript backend** (CloudEngine) with a
**Chrome Extension MV3** control plane, providing fully automated signal generation, risk
management, order execution, and real-time position monitoring.

---

## Quick Start

Prerequisites: Node.js >= 20, Docker + Docker Compose, Chrome

```bash
npm install
docker compose up -d          # PostgreSQL 15 + Redis 7
cp .env.example .env          # fill in Dhan credentials and DB settings
npm run migration:run
npm run start:dev             # dev server with hot-reload on :3    npm run start:dev             # dev server w/extensions, Enable Developer Mode, Load unpacked ->     npm run start:dev             # dev server with hot-reload on :3   (MV3)
  BSW <--W      BSW <--W      BSW <--W      BSW <--W      BSW <--W      BSW <--W      BSW <--W      BSW <)
  MarketData -> TechnicalAnalysis -> OptionsIntelligence
  MarketRegime -> Strategy (8 strategies, 5-gate eval)
  SignalScoring (8-component composite score >= 80)
  RiskManagement (8 pre-entry gates, daily loss state machine)
  Execution (5-check pre-trade chain, Dhan API, idempotency)
  TrailingStop (8 mechanisms, SL monotonicity)
  PositionMonitoring (MFE/MAE, exit conditions)

PostgreSQL 15 | Redis 7 | NestJS EventEmitter2
```

Full details: docs/architecture.md

---

## Module Map

| Module | Responsibility |
|---|---|
| InstrumentDiscovery | NSE F&O scan at 09:15 IST; OI/ADV eligibility; liquidity scoring |
| MarketRegime | 10-regime classification every <=60s; VIX override |
| TechnicalAnalysis | VWAP, ATR, EMA(9/21/50/200), ORB, MACD, RSI, relative volume |
| OptionsIntelligence | Greeks, IV regime, Theta decay, contract selection |
| Strategy | 8 strategies A-H; 5-gate sequential evaluation; adaptive OOS ranking |
| SignalScoring | 8-component composite score; >=80 threshold; expir    | SignalScoring | 8-component composite score; >=80 t;     | SignalScoring | 8-component composite score; >=8-c    | SignalScoring | 8-component composite score; >=80 threling |
| SignalScoring | 8-component composite score; >=80 thrper Or    | SignalScoring | 8-component composite score| Tick subscription; MFE/MAE tracking; exit conditions; P&L feed |
| LiveTrading | Two-step arming (DISARMED->ARMED_PENDING->ARMED); kill switch 10s |
| PaperTrading | Fully isolated: paper_* tables, paper:* Redis keys, events:paper:* |
| SessionManager | 8 NSE phases; mandatory 15:15 IST square-off |
| Portfolio | Dynamic_Capital = starting + sum(realized net P&L) |
| TradeJ    | TradeJ    | TradeJ    | TradeJ    | TradeJ    | TradeJ    | TradeJ    | TradeJ  ica    | TradeJ    | TradeJ    | TradeJ    | TradeJ    | TradeJ    | Trciliation | EOD 15:30 IST; reconnection 30s; SL verification 60s |
| Analytics | 12 metrics; attribution; QCR; Daily Intelligence Report; Simulator |
| Compliance | 4 profitability gates + Monte Carlo >=95% |
| Backtest | Walk-forward; no look-ahead/survivorship bias; bootstrap CI |
| SystemHealthMonitor | 6 metrics; health:{name} Redis keys 90s TTL; transition alerts |
| OptionsFlow | Net OI change, PCR, IV skew, large-block; <=60s refresh; staleness |

---

## NSE Session Phases

| Phase | IST Window | Behavior |
|---|---|---|
| Pre-market | 09:00-09:15 | No new entries |
| Opening Volatility | 09:15-09:20 | opening_phase_compatible strategies only |
| ORB Formation | 09:15-09:30 | ORB range established |
| Morning Momentum | 09:30-11:00 | Full strategy set active |
| Mid-session | 11:0    | Mid-session | 11:0    | Mid-session | 11:0    | Mid-session | 11:0    | Mid-session | 11:0    | Mid-session | 11:0    | Mid-session | 11:0    | Mid-session | 11:0    | Mid-session | 11:0    | Mid-session | 11:0    | Mid-session 
---

## Testing

```bash
npm test                                                      # all 1,442 tests
npm run test:cov                                              # with coverage
npx jest --testPathPattern="risk-management" --no-coverage    # single module
cd extension && npx jest --config jest.config.js              # extension tests
npx tsc --noEmit                                     npx tsc --noEmit  ipt c    npx tsc --noEmit                ui es - 32 correctness properties via fast-check (>=100 iterations each)

---

## Environment Variables

| Variable | Required | Description |    | Variable | Required | Description |    | Variable | on    | Variable | Required | Description |    | Variable | Reqing |
| PORT | No | HTTP port (default 3000) |
| NODE_ENV | No | development / production |
| DATABASE_SSL | No | true for managed PostgreSQL TLS |
| DHAN_CLIENT_ID | via Secrets | Vault / AWS Secrets Manager |
| JWT_PRIVATE_KEY | via Secrets | RS256 private key for JWT signing |
| JWT_PUBLIC_KEY | via Secrets | RS256 public key for JWT verification |
| E    | E    | E    | E    | E    | E    | E    | E    | E    | E    | E    | E ---
| E    | E    | E    | E    | E    | E    | E    | E    | E    | E    | E   il
- AES-256-GCM encryption on all ENCRYPTED DB columns
- 100 req/60s rate limit; HTTP 429 with positive Retry-After header
- X-CSRF-Token required on all state-modifying endpoints
- Secrets in HashiCorp Vault / AWS Secrets Manager only
- Extension: credentials in     - Extension: credential (B    - Extension: credentials in     - Extension: credential (B    - Extension: credentials in     - Extension: credential (B    - Extension: credentials in     - Exteon    - Extension: credentials in     - Extentecture, module graph, event flows
- docs/system-design.md - Data models, Redis key schema, event bus design
- docs/api-spec.md - REST API endpoints, request/response schemas
- docs/security.md - Threat model, controls, compliance
- docs/deployment.md - Infrastructure setup, migrations, production checklist
- docs/development.md - Local dev setup, module conventions, contributing
- docs/chro    - docs/chro    - docs/chro    ecture, messaging, security invariants

---

## License

MIT (c) MoneyPrinter
