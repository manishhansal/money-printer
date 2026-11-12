# MoneyPrinter — System Architecture
**Last updated:** 2026-11-12

---

## 1. Overview

MoneyPrinter is an autonomous quantitative options trading platform for NSE/BSE F&O markets via the Dhan API v2. It runs as a local NestJS application with a React dashboard and Chrome Extension.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Local Machine                                   │
│                                                                           │
│  ┌──────────────┐  ┌────────────────┐  ┌───────────────────────────┐   │
│  │  Chrome Ext  │  │  React Dash    │  │  NestJS CloudEngine :3002  │   │
│  │  (MV3)       │  │  public/app.js │  │                             │   │
│  └──────┬───────┘  └───────┬────────┘  │  ┌─────────────────────┐  │   │
│         │                  │           │  │  Trading Pipeline    │  │   │
│         └──────────────────┴───────────┤  │  (critical path)     │  │   │
│                    HTTP/WS             │  └─────────────────────┘  │   │
│                                        │  ┌─────────────────────┐  │   │
│  ┌──────────────┐  ┌────────────────┐  │  │  Intelligence Layer  │  │   │
│  │  PostgreSQL  │  │   Redis 7      │  │  │  (advisory only)     │  │   │
│  │  (port 5435) │  │  (port 6380)   │  │  └─────────────────────┘  │   │
│  └──────────────┘  └────────────────┘  │  ┌─────────────────────┐  │   │
│                                        │  │  Monitoring Layer    │  │   │
│  ┌──────────────────────────────────┐  │  │  (watchdog)          │  │   │
│  │  Dhan API v2  (REST + WebSocket) │  │  └─────────────────────┘  │   │
│  └──────────────────────────────────┘  └───────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Module Architecture

### 2.1 Critical Trading Pipeline (never blocked by other layers)

| Module | Responsibility |
|--------|----------------|
| MarketDataModule | Dhan WebSocket feed, Redis tick cache, staleness detection |
| InstrumentDiscoveryModule | 09:15 IST scan, eligibility filters, lot size enforcement |
| TechnicalAnalysisModule | VWAP, ATR, EMA, ORB, MACD, RSI |
| MarketRegimeModule | 10-regime classification (STRONG_BULL→UNSTABLE) |
| OptionsIntelligenceModule | Greeks cache, IV regime, option chain, contract selection |
| OptionsFlowModule | PCR, net OI change, IV skew, large-block detection |
| StrategyModule | 8 strategy configs (A–H), 5-gate signal evaluation |
| SignalScannerModule | Cron-based scanner → SniperEntry → SignalDispatcher |
| ExecutionModule | 5-check pre-trade chain, DB-first outbox, freeze qty slicing |
| PaperTradingModule | Fully isolated paper engine with realistic slippage |
| LiveTradingModule | Two-step arming, kill switch, 6 square-off crons |
| RiskManagementModule | Position sizing, exposure limits, daily loss state machine |
| PositionMonitoringModule | Tick-driven P&L, Target+Runner, trailing stop |
| ReconciliationModule | EOD, reconnection, SL verification |

### 2.2 Intelligence Layer (advisory — never blocks execution)

| Module | Responsibility |
|--------|----------------|
| AgentsModule | 15-agent multi-agent research workflow (6 phases) |
| LlmClientService | OpenAI/Anthropic REST client with 30s timeout |
| AgentOrchestratorService | Phase 1-6 workflow coordination |
| DecisionMemoryService | Persist decisions, outcome settlement, reflection |

### 2.3 Monitoring Layer (separate execution lane)

| Module | Responsibility |
|--------|----------------|
| WatchdogModule | Continuous health monitoring, issue registry |
| LocalMarketWatchdogService | 30s health checks + 5min deep audit |
| IssueClassifierService | P0/P1/P2/P3 classification |
| AutoRemediationService | Safe auto-fix with trading-critical protection |

### 2.4 Supporting Modules

| Module | Responsibility |
|--------|----------------|
| DhanApiModule | 40+ Dhan v2 endpoints, circuit breaker, retry, rate-limit |
| RedisModule | Command + pub/sub clients (ioredis) |
| NotificationModule | Priority queue + WebSocket push to Extension |
| AuthModule | RS256 JWT, audit logs |
| SessionManagerModule | 6-phase session (PRE_OPEN→EOD_RECON) + NSE holidays |
| SystemHealthMonitorModule | 6 metrics, latency percentiles |
| TradeJournalModule | Append-only trade records |
| PortfolioModule | Capital tracking, dynamic capital compounding |
| AnalyticsModule | 12 metrics, attribution, QCR |
| BacktestModule | Walk-forward, bootstrap CI, ablation analysis |
| ComplianceModule | 4 profitability gates, Monte Carlo ≥95% |

---

## 3. Multi-Agent Intelligence Engine

### 3.1 Workflow Phases

```
Phase 1: 7 Parallel Specialist Analysts (bounded by Promise.allSettled)
  ├── Market Structure Analyst
  ├── Technical Analysis Analyst
  ├── Derivatives Intelligence Analyst
  ├── Options Flow Analyst
  ├── News Intelligence Analyst
  ├── Sentiment Analyst
  └── Event & Volatility Risk Analyst

Phase 2: Bull/Bear Debate (parallel)
  ├── Bull Researcher (builds affirmative case)
  └── Bear Researcher (devil's advocate)

Phase 3: Research Manager (synthesizes debate → BULLISH/BEARISH/NEUTRAL)

Phase 4: Trader Proposal Agent (proposes CE/PE/SKIP setup)

Phase 5: 3 Risk Analysts (parallel)
  ├── Aggressive Risk Analyst
  ├── Conservative Risk Analyst
  └── Neutral Risk Analyst

Phase 6: Portfolio Manager (final EXECUTE/PAPER_ONLY/SKIP)
```

### 3.2 Key safety invariants

- Output is a `ResearchDecision` — never a broker order
- All prices, lot sizes, security IDs come from verified MoneyPrinter services
- LLM unavailability → rule-based fallback, no blocking
- 25s per phase timeout, rule-based fallback on timeout
- Decision stored in `agent_decisions` table for reflection
- Memory never modifies risk limits or live trading behavior

---

## 4. Data Flow — Signal to Order

```
MarketDataService
    │ tick event
    ▼
TechnicalAnalysisService + MarketRegimeService
    │ indicators + regime
    ▼
SignalScannerService (cron)
    │ candidate
    ▼
SniperEntryService (8 filters)
    │ qualified candidate
    ▼
SignalScoringService (8 component scores, composite ≥ 80)
    │ accepted signal
    ▼
SignalDispatcherService
    │ lot × units conversion
    ▼
ExecutionService (5-check pre-trade gate)
    │ passes all checks
    ▼
DhanApiClient.placeOrder()  [LIVE]  or  PaperTradingService [PAPER]
    │ order confirmation
    ▼
PositionMonitoringService → TargetAndRunnerService → TrailingStopService
```

### 4.1 Agent research runs alongside (advisory, non-blocking)

```
AgentOrchestratorService.runWorkflow(marketContext)
    │ async, 2min budget
    ▼
ResearchDecision
    │ stored in agent_decisions
    ▼
DecisionMemoryService.store()
    │ after trade close
    ▼
DecisionMemoryService.settle()  → reflection
```

---

## 5. Database Schema

| Table | Purpose |
|-------|---------|
| instruments | NSE F&O instrument master (lot sizes, expiry, Greeks) |
| orders | LIVE order lifecycle with idempotency keys |
| positions | LIVE open/closed positions |
| trades | Closed trade records with P&L and charges |
| paper_orders | Isolated PAPER order lifecycle |
| paper_positions | Isolated PAPER positions |
| paper_trades | PAPER trade records |
| signals | Signal evaluation records |
| strategies | 8 strategy configurations (A–H) |
| strategy_performance | Daily strategy P&L by regime |
| risk_events | Immutable risk state transition log |
| capital_ledgers | Precise capital movement ledger |
| market_regimes | Historical regime classifications |
| historical_candles | 1-minute OHLCV candles |
| option_chain_snapshots | Daily option chain snapshots |
| daily_trading_summaries | End-of-day summaries |
| audit_logs | Security audit trail (encrypted columns) |
| monitoring_issues | Watchdog issue registry (Phase 16) |
| agent_decisions | Multi-agent research decisions (Phase 11) |
| user_settings | User configuration |
| system_health_events | Infrastructure health events |

---

## 6. Local Startup

```bash
# Full startup (PG + Redis + migrations + backend + frontend)
npm run dev:all

# Health check
npm run health

# View open watchdog issues
npm run issues

# Full validation (TS + ESLint + all tests)
npm run validate

# Pre-flight checks (env vars, DB, Redis)
npm run preflight
```

---

## 7. Kiro Hooks

| Hook | Trigger | Action |
|------|---------|--------|
| live-watch-mode | PostFileSave (*.ts) | TS check + ESLint + matching spec |
| regression-on-save | PostFileSave (critical modules) | Regression + watchdog suite |
| test-after-task | PostTaskExec | Full jest suite |
| session-start-health | SessionStart | TS + tests + issues + git status |

---

## 8. Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| DATABASE_URL | Critical | PostgreSQL connection string |
| REDIS_HOST / REDIS_URL | Critical | Redis connection |
| ENCRYPTION_KEY | Critical | AES-256 for EncryptedColumn |
| JWT_PRIVATE_KEY | Critical | RS256 JWT signing |
| DHAN_SESSION_TOKEN | Live only | 24h Dhan session token |
| DHAN_CLIENT_ID | Live only | Dhan platform client ID |
| DAILY_LOSS_LIMIT_RUPEES | Recommended | Daily loss limit (default: 10,000) |
| LLM_PROVIDER | Optional | openai\|anthropic\|disabled (default: disabled) |
| OPENAI_API_KEY | Optional | Required when LLM_PROVIDER=openai |
| ANTHROPIC_API_KEY | Optional | Required when LLM_PROVIDER=anthropic |
