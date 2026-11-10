# MoneyPrinter — Deployment Guide

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20 LTS (or 22) | NestJS 10 incompatible with TS6; use TS 5.7.3 |
| npm | 10+ | Bundled with Node.js 20 |
| Docker Desktop | 24+ | For PostgreSQL and Redis |
| Docker Compose | v2 | Bundled with Docker Desktop |
| Chrome | Any recent | For the control-plane extension |

---

## Local Development Setup

### Step 1 — Clone and install

```bash
git clone <repo>
cd money-printer
npm install
```

### Step 2 — Start infrastructure

```bash
docker compose up -d
```

This starts:

| Container | Image | Host Port → Container |
|---|---|---|
| `money-printer-postgres` | postgres:15-alpine | **5435** → 5432 |
| `money-printer-redis` | redis:7-alpine | **6380** → 6379 |

Non-standard host ports (5435, 6380) avoid conflicts with other local projects. Update `docker-compose.yml` and `.env` if your machine uses different ports.

### Step 3 — Configure environment

```bash
cp .env.example .env
```

Update `.env` to match your Docker ports:

```dotenv
DATABASE_URL=postgresql://moneyprinter:moneyprinter_dev@localhost:5435/moneyprinter
REDIS_URL=redis://localhost:6380
REDIS_HOST=localhost
REDIS_PORT=6380
PORT=3002
WS_PORT=3003
```

Generate JWT keys:

```bash
openssl genrsa -out /tmp/jwt.pem 2048
openssl rsa -in /tmp/jwt.pem -pubout -out /tmp/jwt.pub
# Format as single-line:
echo "JWT_PRIVATE_KEY=$(awk 'NF{sub(/\r/,""); printf "%s\\n",$0}' /tmp/jwt.pem)"
echo "JWT_PUBLIC_KEY=$(awk 'NF{sub(/\r/,""); printf "%s\\n",$0}' /tmp/jwt.pub)"
# Paste both into .env
```

Generate encryption key:
```bash
openssl rand -hex 32   # → ENCRYPTION_KEY in .env
```

### Step 4 — Add Dhan credentials

1. Log in at [dhan.co](https://dhan.co) → My Profile → Dhan API
2. Copy **Client ID**
3. Click **Generate Access Token** → copy token

```dotenv
DHAN_CLIENT_ID=your_client_id
DHAN_ACCESS_TOKEN=your_access_token
```

> **Token expires daily.** Regenerate each morning before 09:15 IST.

### Step 5 — Run migrations

```bash
npm run migration:run
```

Expected output: 2 migrations applied (`EnablePostgresExtensions`, `CreateFullSchema`).

### Step 6 — Start the development server

```bash
npm run start:dev
```

Wait for:
```
[Bootstrap] CloudEngine is running on http://localhost:3002
[NotificationGateway] WebSocket notification gateway started on port 3003
[LiveTradingService] armed state: DISARMED
```

Verify:
```bash
curl http://localhost:3002/        # → MoneyPrinter CloudEngine is running.
curl http://localhost:3002/settings  # → { "paperStartingCapital": "50000.00", ... }
```

### Step 7 — Load Chrome Extension

1. `npm run build:extension` (if not already built)
2. Open `chrome://extensions` → Developer mode → Load unpacked → select `extension/`
3. Click the MoneyPrinter icon → popup shows HEALTHY / DISARMED / ₹0.00

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port |
| `WS_PORT` | No | `3001` | WebSocket (NotificationGateway) port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `DATABASE_SSL` | No | `false` | `true` for managed PostgreSQL TLS |
| `REDIS_URL` | No | — | Redis connection string |
| `REDIS_HOST` | No | `localhost` | Redis host |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | — | Redis AUTH password |
| `REDIS_TLS` | No | `false` | `true` for ElastiCache TLS |
| `DHAN_CLIENT_ID` | **Yes** | — | Dhan brokerage client ID |
| `DHAN_ACCESS_TOKEN` | **Yes** | — | Dhan API access token (daily refresh) |
| `JWT_PRIVATE_KEY` | **Yes** | — | RS256 private key (PEM, `\n`-escaped) |
| `JWT_PUBLIC_KEY` | **Yes** | — | RS256 public key (PEM, `\n`-escaped) |
| `JWT_EXPIRY_SECONDS` | No | `1800` | JWT TTL; hard-capped at 1800 |
| `ENCRYPTION_KEY` | **Yes** | — | AES-256-GCM key (64-char hex) |
| `SECRETS_BACKEND` | No | `env` | `env`, `aws`, or `vault` |
| `DAILY_LOSS_LIMIT_RUPEES` | No | `10000` | Daily loss limit; triggers EMERGENCY_HALT |
| `MAX_EXPOSURE_PCT` | No | `20` | Max total position exposure (% of capital) |
| `MAX_CORRELATED_PCT` | No | `10` | Max same-underlying exposure (%) |
| `MAX_CONCENTRATION_PCT` | No | `15` | Max single-instrument exposure (%) |
| `MIN_OI_THRESHOLD` | No | `0` | Min OI for F&O stock options |
| `MIN_ADV_THRESHOLD` | No | `0` | Min ADV for F&O stock options |
| `GREEDY_FIRST_TARGET_FRACTION` | No | `0.5` | Partial exit at first target |
| `GREEDY_TRAIL_MIN_CONDITIONS` | No | `2` | Min conditions (of 3) needed to trail |

---

## npm Scripts

| Script | Description |
|---|---|
| `npm run start:dev` | Development server (hot-reload on file changes) |
| `npm run start:prod` | Run compiled production build from `dist/` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run build:extension` | Bundle Chrome Extension to `extension/dist/` |
| `npm run build:extension:watch` | Extension watch mode |
| `npm test` | All unit tests |
| `npm run test:cov` | Tests with coverage |
| `npm run test:extension` | Chrome Extension tests |
| `npm run migration:run` | Apply all pending migrations |
| `npm run migration:generate` | Generate migration from entity changes |
| `npm run migration:revert` | Revert last migration |
| `npm run lint` | ESLint with auto-fix |

---

## Production Deployment Checklist

**Infrastructure:**
- [ ] `DATABASE_SSL=true` for managed PostgreSQL (RDS, etc.)
- [ ] `REDIS_TLS=true` and `REDIS_PASSWORD` set for managed Redis
- [ ] `SECRETS_BACKEND=aws` with secrets in AWS Secrets Manager

**Application:**
- [ ] `NODE_ENV=production` — disables SQL query logging
- [ ] `PORT` and `WS_PORT` configured
- [ ] `MAX_EXPOSURE_PCT=20`, `MAX_CORRELATED_PCT=10`, `MAX_CONCENTRATION_PCT=15` for live trading
- [ ] `DAILY_LOSS_LIMIT_RUPEES` set appropriately

**Migrations:**
- [ ] Run `npm run migration:run` before first start of new version
- [ ] Verify tables created: `SELECT count(*) FROM instruments;` etc.

**Extension:**
- [ ] Update `DEFAULT_WSS_URL` and `DEFAULT_HTTP_URL` in `background.ts` to production URLs
- [ ] `npm run build:extension` after URL change
- [ ] Extension uses `wss://` and `https://` (not `ws://`/`http://`)

**Dhan:**
- [ ] `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN` are real values (not placeholders)
- [ ] Token rotation procedure documented for the team
- [ ] Static egress IP registered with Dhan API (required for F&O API access)

For full AWS deployment, see [docs/aws-deployment.md](aws-deployment.md).

---

## Chrome Extension Deployment (Developer Mode)

1. `npm run build:extension`
2. `chrome://extensions` → Developer mode → Load unpacked → `extension/`
3. Verify popup shows **HEALTHY** badge

**After any source change:**
```bash
npm run build:extension
# Then click ↺ reload in chrome://extensions
```

---

## Health Monitoring

The CloudEngine polls 6 health metrics every 30 seconds and writes them to Redis with 90-second TTL:

```
health:cloudengine_modules    — module initialization status
health:dhan_api_connectivity  — Dhan API reachability
health:postgresql_connection  — PostgreSQL round-trip (SELECT 1)
health:redis_availability     — Redis PING
health:websocket_feed_latency — Live feed latency
health:order_execution_latency — Order placement latency
```

Values: `"Healthy"` | `"Degraded"` | `"Down"`

A key expiring (TTL elapsed with no refresh) means the monitoring loop has stopped — this itself signals a problem.
