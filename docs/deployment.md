# MoneyPrinter — Deployment Guide

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | >= 20 |
| npm | >= 10 (bundled with Node.js 20) |
| Docker | >= 24 |
| Docker Compose | >= 2.20 |

The CloudEngine does not support Windows natively in development. macOS and Linux are the target development environments.

---

## Local Development Setup

### 1. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL 15 (port 5432) and Redis 7 (port 6379) using the credentials defined in `docker-compose.yml`. The PostgreSQL instance runs the init script at `docker/postgres/init.sql` on first start.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values. For local development the defaults in `.env.example` connect to the Docker Compose services without modification. See the [Environment Variables](#environment-variables) section for the full reference.

### 4. Run migrations

```bash
npm run migration:run
```

This applies all pending migrations in `migrations/` against the database specified in `DATABASE_URL`. The TypeORM `synchronize` flag is always `false` — schema changes only happen through migrations.

### 5. Start the development server

```bash
npm run start:dev
```

Starts the NestJS application in watch mode (file changes trigger automatic restart). The server binds to `http://localhost:3000` by default.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | `development` | Application environment. Set to `production` for production deployments. Controls query logging verbosity. |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string: `postgresql://<user>:<password>@<host>:<port>/<database>` |
| `DATABASE_SSL` | No | `false` | Set to `true` to enable TLS for managed PostgreSQL instances (e.g. RDS, Cloud SQL). Uses `rejectUnauthorized: false`. |
| `REDIS_URL` | No | — | Redis connection string: `redis://[:<password>@]<host>:<port>[/<db>]` (alternative to individual `REDIS_*` vars) |
| `REDIS_HOST` | No | `localhost` | Redis host |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | — | Redis AUTH password (leave blank for no-auth) |
| `REDIS_TLS` | No | `false` | Set to `true` for TLS connections (e.g. ElastiCache in-transit encryption) |
| `DHAN_CLIENT_ID` | Yes | — | Dhan brokerage client ID for API authentication |
| `JWT_PRIVATE_KEY` | Yes | — | RS256 private key for JWT signing (PEM format) |
| `JWT_PUBLIC_KEY` | Yes | — | RS256 public key for JWT verification (PEM format) |
| `JWT_EXPIRY_SECONDS` | No | `1800` | JWT validity in seconds; hard-capped at 1800 (30 minutes) |
| `ENCRYPTION_KEY` | Yes | — | AES-256-GCM key for field-level encryption. Supply as 64-char hex, 44-char base64, or 32-char UTF-8. |
| `SECRETS_BACKEND` | No | `env` | Secrets backend: `env`, `aws`, or `vault` |
| `AWS_REGION` | Conditional | — | Required when `SECRETS_BACKEND=aws` |
| `AWS_ACCESS_KEY_ID` | Conditional | — | Required when `SECRETS_BACKEND=aws` without IAM role |
| `AWS_SECRET_ACCESS_KEY` | Conditional | — | Required when `SECRETS_BACKEND=aws` without IAM role |
| `VAULT_ADDR` | Conditional | — | Required when `SECRETS_BACKEND=vault` (e.g. `https://vault.internal:8200`) |
| `VAULT_TOKEN` | Conditional | — | Required when `SECRETS_BACKEND=vault` |
| `DAILY_LOSS_LIMIT_RUPEES` | No | `10000` | Daily loss limit in INR; triggers EMERGENCY_HALT state |
| `UNUSUAL_VOLATILITY_VIX_THRESHOLD` | No | `20.0` | India VIX level that triggers REDUCED position sizing |
| `VOLATILITY_PROTECTION_LIMIT_LOTS` | No | `2` | Maximum lots per signal when VIX is elevated |
| `NORMAL_MAX_LOTS_PER_SIGNAL` | No | `10` | Maximum lots per signal under normal VIX conditions |
| `VIX_RESTORE_CONTINUOUS_MINUTES` | No | `5` | Minutes VIX must stay below threshold before position sizing restores |

---

## npm Scripts

| Script | Command | Description |
|---|---|---|
| `start:dev` | `nest start --watch` | Development server with file-watch auto-restart |
| `start:prod` | `node dist/main` | Run the compiled production build |
| `build` | `nest build` | Compile TypeScript to `dist/` |
| `test` | `jest --runInBand` | Run all 1,442 unit tests serially |
| `test:watch` | `jest --watch --runInBand` | Run tests in watch mode |
| `test:cov` | `jest --coverage --runInBand` | Run tests with coverage report |
| `test:extension` | `jest --config ./extension/jest.config.js --runInBand` | Run Chrome Extension tests |
| `migration:run` | `typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts` | Apply all pending migrations |
| `migration:generate` | `typeorm-ts-node-commonjs migration:generate -d src/database/data-source.ts` | Generate a new migration from entity changes |
| `migration:revert` | `typeorm-ts-node-commonjs migration:revert -d src/database/data-source.ts` | Revert the last applied migration |
| `migration:create` | `typeorm-ts-node-commonjs migration:create` | Create an empty migration file |
| `migration:show` | `typeorm-ts-node-commonjs migration:show -d src/database/data-source.ts` | Show migration status |

---

## Production Deployment Checklist

Before deploying to production:

**Database:**
- [ ] `DATABASE_SSL=true` — required for all managed PostgreSQL instances (RDS, Cloud SQL, etc.)
- [ ] Run `npm run migration:run` before starting the new process version
- [ ] Verify PostgreSQL connection pool settings: `max: 10`, `connectionTimeoutMillis: 10000`

**Redis:**
- [ ] Configure Redis AUTH (`REDIS_PASSWORD`) — no-auth Redis is not acceptable in production
- [ ] Enable TLS (`REDIS_TLS=true`) for managed Redis instances (e.g. ElastiCache)

**Secrets:**
- [ ] Set `SECRETS_BACKEND=aws` or `SECRETS_BACKEND=vault`
- [ ] Store `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, and `ENCRYPTION_KEY` in the secrets backend — never in environment variables
- [ ] Store `DHAN_CLIENT_ID` and broker credentials in the secrets backend
- [ ] Verify IAM role or Vault policy grants least-privilege access to only the required secret paths

**Application:**
- [ ] `NODE_ENV=production` — disables query-level SQL logging (error-only)
- [ ] The CloudEngine process must be behind a TLS terminator or load balancer — the application itself does not handle TLS
- [ ] Verify `JWT_EXPIRY_SECONDS ≤ 1800`

**Network:**
- [ ] All Dhan API calls originate from the static egress IP registered with Dhan (`static_ip` column in `broker_accounts`)
- [ ] Inbound port 3000 (or the configured `PORT`) accessible only from the Chrome Extension's known IP range or via a VPN

**Startup behaviour:**
- [ ] On process start, `trading:armed_state` Redis key is always overwritten with `DISARMED` — verify this in deployment logs

---

## Chrome Extension Deployment

### Build requirements

The extension is built from `extension/src/` as TypeScript MV3 code. It requires a separate build step (not part of the NestJS build):

```bash
cd extension
# Build with your preferred bundler (webpack/esbuild targeting the manifest's service_worker path)
```

### Loading in Chrome

1. Open `chrome://extensions` in Chrome
2. Enable **Developer Mode** (toggle in the top-right corner)
3. Click **Load unpacked** and select the `extension/` directory (or the built output directory)
4. The MoneyPrinter extension icon appears in the toolbar

### Manifest summary

```json
{
  "manifest_version": 3,
  "name": "MoneyPrinter",
  "version": "0.1.0",
  "permissions": ["storage", "alarms"],
  "background": {
    "service_worker": "dist/background/service-worker.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html"
  }
}
```

Key constraints:
- Only `storage` and `alarms` permissions are declared — no `tabs`, `webRequest`, or broad host permissions
- No content scripts — the extension does not inject into web pages
- All CloudEngine communication uses WSS (`wss://`) or HTTPS only; plain `ws://` or `http://` URLs are rejected by `assertSecureUrl()` before any connection is attempted

---

## Health Monitoring

`SystemHealthMonitorService` polls every 30 seconds and writes six Redis keys of the form `health:{metric_name}` with a 90-second TTL:

```
health:cloudengine_modules
health:dhan_api_connectivity
health:postgresql_connection
health:redis_availability
health:websocket_feed_latency
health:order_execution_latency
```

Values are `"Healthy"`, `"Degraded"`, or `"Down"`. A key expiring (TTL elapsed with no refresh) means the monitoring loop has stopped — this itself signals a problem.

Active checks run on every 30-second poll:
- `postgresql_connection`: `SELECT 1` round-trip; ≥ 500 ms → Degraded, exception → Down
- `redis_availability`: PING; ≥ 500 ms → Degraded, no PONG / exception → Down

Passive metrics are updated by their respective modules via `updateMetricStatus()`. Any Healthy→Degraded or Degraded→Down transition publishes an immediate CRITICAL notification alert, independent of the 30-second poll.

---

## Database Connection Pooling

The TypeORM pg connection pool is configured with:

```
max: 10          — maximum simultaneous connections
min: 2           — minimum idle connections maintained
connectionTimeoutMillis: 10000  — 10-second connection acquisition timeout
idleTimeoutMillis: 30000        — idle connection recycled after 30 seconds
```

If `NestFactory.create()` does not resolve within 10 seconds, `main.ts` exits the process via a `Promise.race` guard. This prevents silent indefinite startup hangs in environments where the database is unreachable.
