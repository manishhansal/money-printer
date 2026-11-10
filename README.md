# MoneyPrinter

> Autonomous AI-Powered Quantitative Trading Platform for NSE Options via Dhan Broker

**162 tasks implemented · 1,442 tests passing · 55 test suites · TypeScript strict mode**

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Local Setup — Step by Step](#local-setup--step-by-step)
4. [Paper Trading](#paper-trading)
5. [Chrome Extension](#chrome-extension)
6. [Environment Variables](#environment-variables)
7. [npm Scripts](#npm-scripts)
8. [Testing](#testing)
9. [Architecture](#architecture)
10. [Module Map](#module-map)
11. [NSE Session Phases](#nse-session-phases)
12. [Docs](#docs)

---

## Overview

MoneyPrinter is a production-grade autonomous quantitative trading platform for NSE **options buying** via the Dhan broker API. It combines a **NestJS TypeScript backend** (CloudEngine) with a **Chrome Extension MV3** control plane, providing fully automated signal generation, risk management, order execution, and real-time position monitoring.

**Two operating modes:**
- **Paper Trading** — real Dhan market data, simulated fills, isolated `paper_*` tables. Safe for testing. Default capital: ₹50,000 (configurable from popup).
- **Live Trading** — real orders to Dhan. Requires explicit two-step arming from the Chrome Extension.

**Key design decisions:**
- Options buying only — INDEX_FUTURE and STOCK_FUTURE are structurally blocked
- Greedy trailing — after first target, auto-select CHANDELIER or ATR trail based on market conditions
- Net P&L after all charges — STT at 0.1% (Budget 2024), tracked via shared `TradingChargesService`
- Broker-side safety net — P&L exit API configured at 09:15 IST; Dhan closes positions even if CloudEngine crashes
- Configurable capital — paper capital set via popup settings panel (default ₹50K)

---

## Prerequisites

| Tool | Minimum Version | Notes |
|---|---|---|
| Node.js | 20 LTS | v22+ also works |
| npm | 10 | Bundled with Node.js 20 |
| Docker Desktop | 24+ | For PostgreSQL and Redis containers |
| Docker Compose | v2 | Bundled with Docker Desktop |
| Chrome | Any recent | For the control-plane extension |
| Git | Any | — |

> **macOS / Linux only.** The dev server does not support Windows natively.

---

## Local Setup — Step by Step

### Step 1 — Clone and install dependencies

```bash
git clone https://github.com/your-org/money-printer.git
cd money-printer
npm install
```

---

### Step 2 — Start infrastructure (PostgreSQL + Redis)

```bash
docker compose up -d
```

This starts two containers:

| Container | Image | Host Port |
|---|---|---|
| `money-printer-postgres` | postgres:15-alpine | **5435** → 5432 |
| `money-printer-redis` | redis:7-alpine | **6380** → 6379 |

> Non-standard host ports (5435, 6380) avoid conflicts with other local PostgreSQL/Redis
> instances. If your machine has no conflicts, you can change them in `docker-compose.yml`
> and update `.env` to match.

Verify both containers are healthy:

```bash
docker compose ps
```

Expected output:
```
NAME                      STATUS
money-printer-postgres    Up (healthy)
money-printer-redis       Up (healthy)
```

---

### Step 3 — Configure environment

Copy the example env file:

```bash
cp .env.example .env
```

Open `.env` and update the connection strings to match the Docker ports:

```dotenv
# Match the ports in docker-compose.yml
DATABASE_URL=postgresql://moneyprinter:moneyprinter_dev@localhost:5435/moneyprinter
REDIS_URL=redis://localhost:6380
REDIS_HOST=localhost
REDIS_PORT=6380

# Server ports
PORT=3002
WS_PORT=3003
```

> **Ports 3000/3001/5432/6379** are the defaults in `.env.example` but may already be used
> by other projects on your machine. Adjust to whatever is free.

Generate JWT RS256 keys (required — the app will not start without them):

```bash
# Generate private key
openssl genrsa -out /tmp/jwt_private.pem 2048

# Derive public key
openssl rsa -in /tmp/jwt_private.pem -pubout -out /tmp/jwt_public.pem

# Format as single-line env values
echo "JWT_PRIVATE_KEY=$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' /tmp/jwt_private.pem)"
echo "JWT_PUBLIC_KEY=$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' /tmp/jwt_public.pem)"
```

Paste the output into `.env` for `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`.

Generate an AES-256-GCM encryption key for field-level encryption:

```bash
openssl rand -hex 32   # → paste as ENCRYPTION_KEY in .env
```

---

### Step 4 — Add Dhan API credentials

1. Log in to [dhan.co](https://dhan.co)
2. Go to **My Profile → Dhan API → Enable API**
3. Copy your **Client ID**
4. Click **Generate Access Token** and copy the token

Set them in `.env`:

```dotenv
DHAN_CLIENT_ID=your_client_id_here
DHAN_ACCESS_TOKEN=your_access_token_here
```

> Without these the CloudEngine starts but the market data feed and order placement will
> fail. For paper trading, the feed still works with valid credentials — only real order
> submission is simulated.

---

### Step 5 — Run database migrations

```bash
npm run migration:run
```

This applies both migrations against the database:

```
EnablePostgresExtensions1700000000000 ✓
CreateFullSchema1794321588593         ✓
```

Expected final line: `query: COMMIT`

Verify the tables were created:

```bash
docker exec money-printer-postgres psql -U moneyprinter -d moneyprinter -c "\dt"
```

You should see ~20 tables including `instruments`, `signals`, `positions`, `orders`, etc.

---

### Step 6 — Start the development server

```bash
npm run start:dev
```

The server compiles and starts in watch mode. Wait for:

```
[Bootstrap] CloudEngine is running on http://localhost:3002
[Bootstrap] Environment: development
```

Also look for:

```
[NotificationGateway] WebSocket notification gateway started on port 3003
[SessionManagerService] SessionManagerService initialised — current phase: MARKET_CLOSED
[LiveTradingService] LiveTradingService initialised — armed state: DISARMED
```

Verify the server is responding:

```bash
curl http://localhost:3002/
# → MoneyPrinter CloudEngine is running.
```

> **Watch mode** (`--watch`) recompiles and restarts the server automatically on any
> `.ts` file change. No manual restart needed during development.

---

### Step 7 — (Optional) Load the Chrome Extension

See [Chrome Extension](#chrome-extension) section below.

---

### Full startup checklist

```
✓ docker compose ps          → postgres healthy, redis healthy
✓ npm run migration:run      → 2 migrations applied
✓ npm run start:dev          → listening on :3002 / :3003
✓ curl localhost:3002/       → 200 OK
✓ .env DHAN_CLIENT_ID        → filled in (not REPLACE_WITH_...)
✓ .env JWT_PRIVATE_KEY       → filled in (not empty)
✓ .env ENCRYPTION_KEY        → 64-char hex or 32-char string
```

---

## Paper Trading

Paper trading uses real Dhan market data but never places real orders — all fills are
simulated. It runs in a fully isolated environment:

| Layer | Paper | Live |
|---|---|---|
| DB tables | `paper_orders`, `paper_positions`, `paper_trades` | `orders`, `positions`, `trades` |
| Redis keys | `paper:*` prefix | no prefix |
| Event channels | `events:paper:*` | `events:*` |
| Dhan API | Never called | Real orders placed |

**To start paper trading:**

1. Ensure the CloudEngine is running (`npm run start:dev`)
2. Ensure your Dhan credentials are set in `.env`
3. Load the Chrome Extension (see below)
4. In the extension popup → select **Paper Trading mode**
5. The session will auto-start at 09:15 IST when NSE markets open

The `LiveTradingService` starts in `DISARMED` state on every restart — you can never
accidentally start live trading without an explicit two-step arming sequence from the extension.

---

## Chrome Extension

### Load in Chrome (developer mode)

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this project
5. The MoneyPrinter icon appears in the Chrome toolbar

### Configure the extension

After loading, open the extension popup and set:
- **CloudEngine URL**: `https://localhost:3002` (or your deployed URL)
- **WebSocket URL**: `wss://localhost:3003`

> The extension enforces `assertSecureUrl()` — plain `http://` and `ws://` are rejected.
> For local development you will need to allow the self-signed cert exception in Chrome
> or run behind a local TLS proxy (e.g. `mkcert` + nginx).

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port |
| `WS_PORT` | No | `3001` | WebSocket (notification gateway) port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `DATABASE_SSL` | No | `false` | `true` for managed PostgreSQL TLS (RDS, etc.) |
| `REDIS_URL` | No | — | Redis connection string (alternative to individual vars) |
| `REDIS_HOST` | No | `localhost` | Redis host |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | — | Redis AUTH password |
| `REDIS_TLS` | No | `false` | `true` for ElastiCache in-transit encryption |
| `DHAN_CLIENT_ID` | **Yes** | — | Dhan brokerage client ID |
| `DHAN_ACCESS_TOKEN` | **Yes** | — | Dhan API access token |
| `JWT_PRIVATE_KEY` | **Yes** | — | RS256 private key (PEM, `\n`-escaped for single line) |
| `JWT_PUBLIC_KEY` | **Yes** | — | RS256 public key (PEM, `\n`-escaped for single line) |
| `JWT_EXPIRY_SECONDS` | No | `1800` | JWT TTL in seconds; hard-capped at 1800 (30 min) |
| `ENCRYPTION_KEY` | **Yes** | — | AES-256 key: 64-char hex, 44-char base64, or 32-char UTF-8 |
| `SECRETS_BACKEND` | No | `env` | `env`, `aws`, or `vault` |
| `AWS_REGION` | Conditional | — | Required when `SECRETS_BACKEND=aws` |
| `VAULT_ADDR` | Conditional | — | Required when `SECRETS_BACKEND=vault` |
| `VAULT_TOKEN` | Conditional | — | Required when `SECRETS_BACKEND=vault` |
| `DAILY_LOSS_LIMIT_RUPEES` | No | `10000` | Daily loss limit in INR; triggers EMERGENCY_HALT |
| `UNUSUAL_VOLATILITY_VIX_THRESHOLD` | No | `20.0` | India VIX level that triggers reduced sizing |
| `VOLATILITY_PROTECTION_LIMIT_LOTS` | No | `2` | Max lots per signal when VIX is elevated |
| `NORMAL_MAX_LOTS_PER_SIGNAL` | No | `10` | Max lots per signal under normal VIX |
| `VIX_RESTORE_CONTINUOUS_MINUTES` | No | `5` | Minutes VIX must stay below threshold before restoring sizing |

---

## npm Scripts

| Script | Description |
|---|---|
| `npm run start:dev` | Dev server with hot-reload (file changes auto-restart) |
| `npm run start:prod` | Run the compiled production build from `dist/` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run build:extension` | Bundle Chrome Extension to `extension/dist/` |
| `npm run build:extension:watch` | Extension watch mode — rebuild on every file change |
| `npm test` | Run all 1,442+ unit tests |
| `npm run test:cov` | Tests with coverage report |
| `npm run test:extension` | Chrome Extension tests only |
| `npm run migration:run` | Apply all pending DB migrations |
| `npm run migration:generate` | Generate a new migration from entity changes |
| `npm run migration:revert` | Revert the last applied migration |
| `npm run migration:show` | Show migration status (applied / pending) |
| `npm run lint` | ESLint with auto-fix |

---

## Testing

```bash
# All 1,442 unit tests
npm test

# Single module
npx jest --testPathPattern="risk-management" --no-coverage

# With coverage
npm run test:cov

# Chrome Extension tests only
npm run test:extension

# TypeScript type check only
npx tsc --noEmit
```

The test suite includes **32 property-based tests** via `fast-check` (≥100 iterations each),
covering correctness of composite scoring, trailing stop monotonicity, and state machine
transitions.

---

## Architecture

```
Chrome Extension (MV3)
  BSW <──WSS──> CloudEngine  │  Popup  │  SidePanel  │  Dashboard

CloudEngine (NestJS)
  MarketData → TechnicalAnalysis → OptionsIntelligence
  MarketRegime (10 regimes, VIX override)
  InstrumentDiscovery (OI/ADV filter, liquidity score)
  Strategy (8 strategies A–H, 5-gate evaluation)
  SignalScoring (8-component composite, ≥80 threshold)
  RiskManagement (8 gates, state machine, VIX sizing)
  Execution (5-check pre-trade chain, Dhan API, idempotency)
  TrailingStop (8 mechanisms, SL monotonicity)
  PositionMonitoring (MFE/MAE, tick subscription, exits)
  LiveTrading (two-step arming, 10 s kill switch)
  PaperTrading (fully isolated: paper_* tables, paper:* keys)
  SessionManager (8 NSE phases, mandatory 15:15 square-off)
  Analytics (12 metrics, attribution, Daily Report)
  Compliance (4 profitability gates, Monte Carlo ≥95%)
  Backtest (walk-forward, no look-ahead/survivorship bias)
  SystemHealthMonitor (6 metrics, Redis TTL keys, 30 s poll)
  OptionsFlow (net OI, PCR, IV skew, large-block ≤60 s)
  Notification (priority queue, WebSocket push, Redis buffer)

Infrastructure: PostgreSQL 15 │ Redis 7 │ NestJS EventEmitter2
```

## Architecture

```
Chrome Extension (MV3)
  BSW ──ws://localhost:3003──> CloudEngine  │  Popup  │  SidePanel  │  Dashboard

CloudEngine (NestJS)
  MarketData → TechnicalAnalysis → OptionsIntelligence
  MarketRegime (10 regimes, VIX override)
  InstrumentDiscovery (options-only: Nifty/BankNifty/etc + NSE_FNO stocks)
  Strategy (8 strategies A–H, 5-gate evaluation)
  SignalScoring (8-component composite, ≥80 threshold)
  TradingChargesService (STT 0.1% Budget 2024; single source of truth)
  RiskManagement (8 gates, state machine, VIX sizing)
  Execution (5-check pre-trade; getOrderById for order status)
  TrailingStop (8 mechanisms; PARTIAL_PROFIT → GreedyTrailService)
  GreedyTrailService (3 conditions → CHANDELIER or ATR auto-trail)
  PositionMonitoring (MFE/MAE, partial profit, greedy exit decision)
  LiveTrading (two-step arm; kill switch + Dhan setKillSwitch; broker P&L exit)
  PaperTrading (fully isolated; options-buying only; ₹50K default capital)
  SessionManager (8 NSE phases, mandatory 15:15 IST square-off)
  Portfolio (Dynamic Capital, GET /portfolio/summary with net P&L)
  Settings (GET/PUT /settings; configurable capital + risk %)
  SystemHealthMonitor (6 metrics, 90s TTL, 30s poll)

Infrastructure: PostgreSQL 15 (port 5435) │ Redis 7 (port 6380) │ NestJS EventEmitter2
```

Full details: [docs/architecture.md](docs/architecture.md)

---

## Module Map

| Module | Responsibility |
|---|---|
| InstrumentDiscovery | NSE F&O scan at 09:15 IST; OI/ADV eligibility; liquidity scoring |
| MarketRegime | 10-regime classification every ≤60 s; VIX override |
| TechnicalAnalysis | VWAP, ATR, EMA(9/21/50/200), ORB, MACD, RSI, relative volume |
| OptionsIntelligence | Greeks, IV regime, Theta decay, contract selection |
| Strategy | 8 strategies A–H; 5-gate sequential evaluation; adaptive OOS ranking |
| SignalScoring | 8-component composite score; ≥80 threshold; signal expiry |
| RiskManagement | 8 pre-entry gates; daily loss state machine; VIX position sizing |
| Execution | 5-check pre-trade chain; Dhan API; Redis idempotency (300 s TTL) |
| TrailingStop | 8 mechanisms; SL monotonicity invariant; broker SL sync within 5 s |
| PositionMonitoring | Tick subscription; MFE/MAE tracking; exit conditions; P&L feed |
| LiveTrading | Two-step arming (DISARMED→ARMED_PENDING→ARMED); kill switch 10 s |
| PaperTrading | Fully isolated: paper_* tables, paper:* Redis keys, events:paper:* |
| SessionManager | 8 NSE phases; mandatory 15:15 IST square-off |
| Portfolio | Dynamic capital = starting + sum(realized net P&L) |
| TradeJournal | Append-only; 9 record sets; SLA |
| Reconciliation | EOD 15:30 IST; reconnection 30 s; SL verification 60 s |
| Analytics | 12 metrics; attribution; QCR; Daily Intelligence Report; Simulator |
| Compliance | 4 profitability gates + Monte Carlo ≥95% |
| Backtest | Walk-forward; no look-ahead/survivorship bias; bootstrap CI |
| SystemHealthMonitor | 6 metrics; health:{name} Redis keys 90 s TTL; transition alerts |
| OptionsFlow | Net OI change, PCR, IV skew, large-block; ≤60 s refresh; staleness |

---

## NSE Session Phases

| Phase | IST Window | Behavior |
|---|---|---|
| Pre-market | 09:00–09:15 | No new entries |
| Opening Volatility | 09:15–09:20 | `opening_phase_compatible` strategies only |
| ORB Formation | 09:15–09:30 | ORB range established |
| Morning Momentum | 09:30–11:00 | Full strategy set active |
| Mid-session | 11:00–13:30 | Regime-dependent strategy filtering |
| Afternoon | 13:30–14:30 | Reduced set; volatility watch |
| Pre-close | 14:30–15:15 | No new entries; existing positions monitored |
| Square-off | 15:15 | Mandatory close of all open positions |
| Post-market | 15:15–15:30 | EOD reconciliation, Daily Report |
| Market Closed | 15:30+ | No activity |

---

## Docs

| File | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layer diagram, module graph, event flows, signal→trade flow |
| [docs/system-design.md](docs/system-design.md) | Data models, Redis key schema, trading approach, charges |
| [docs/api-spec.md](docs/api-spec.md) | REST API endpoints (portfolio, settings, signals, options flow) |
| [docs/security.md](docs/security.md) | Threat model, controls, broker safety net |
| [docs/deployment.md](docs/deployment.md) | Local dev setup (step-by-step), env vars, production checklist |
| [docs/aws-deployment.md](docs/aws-deployment.md) | Full AWS production deployment (ECS Fargate + RDS + ElastiCache) |
| [docs/development.md](docs/development.md) | Module conventions, charge rates, contributing guidelines |
| [docs/chrome-extension.md](docs/chrome-extension.md) | Extension architecture, messages, settings panel, security |

---

## Security

- AES-256-GCM field-level encryption on all sensitive DB columns
- RS256 JWT with 30-min TTL; active-session validation on every request
- 100 req/60 s per-user rate limit with positive `Retry-After` header
- `X-CSRF-Token` required on all state-modifying endpoints
- Secrets in `SECRETS_BACKEND=aws` (AWS Secrets Manager) or `vault` (HashiCorp Vault) in production
- Chrome Extension: credentials only in `chrome.storage.session` (BSW-scoped), never in `chrome.storage.local`
- Paper/Live fully isolated at DB, Redis, event, and API layers

Full details: [docs/security.md](docs/security.md)

---

## License

MIT © MoneyPrinter
