# MoneyPrinter — Developer Guide

## Project Structure

```
money-printer/
├── src/                          # NestJS CloudEngine (TypeScript)
│   ├── app.module.ts             # Root module; registers all feature modules, global guards/filters
│   ├── main.ts                   # Bootstrap: 10s startup timeout, CORS, validation pipe
│   ├── common/
│   │   ├── filters/              # GlobalExceptionFilter, ThrottlerExceptionFilter
│   │   ├── guards/               # ThrottleByUserGuard (APP_GUARD)
│   │   ├── middleware/           # CsrfMiddleware
│   │   └── transformers/         # EncryptedColumnTransformer (AES-256-GCM)
│   ├── database/
│   │   ├── data-source.ts        # TypeORM DataSource used by both NestJS and migration CLI
│   │   └── entities/             # 25+ TypeORM entity classes
│   ├── migrations/               # TypeORM migration files (compiled to dist/migrations/ by tsc)
│   │   ├── 1700000000000-EnablePostgresExtensions.ts
│   │   └── 1794321588593-CreateFullSchema.ts
│   └── modules/                  # Feature modules (one directory per domain)
│       ├── auth/
│       ├── backtest/
│       ├── charges/              # TradingChargesService — single source of NSE F&O charge rates
│       ├── compliance/
│       ├── dhan/                 # DhanApiClient (25 methods) + DhanWebSocketClient
│       ├── event-wiring/         # Redis channel and EventEmitter2 wiring
│       ├── execution/
│       ├── instrument-discovery/ # 09:15 IST scan; options-only allowlists
│       ├── live-trading/         # Two-step arm, kill switch, broker P&L exit
│       ├── market-data/
│       ├── market-regime/
│       ├── notification/
│       ├── options-flow/
│       ├── options-intelligence/ # Greeks cache, IV regime, getActiveExpiries()
│       ├── paper-trading/        # Fully isolated; options-buying only; configurable capital
│       ├── portfolio/            # PortfolioService, PortfolioController, SettingsController
│       ├── position-monitoring/  # Tick monitoring, greedy trailing, MFE/MAE
│       ├── reconciliation/
│       ├── redis/
│       ├── risk-management/
│       ├── secrets/
│       ├── session-manager/
│       ├── signal-scoring/
│       ├── strategy/
│       ├── system-health-monitor/
│       ├── technical-analysis/
│       ├── trade-journal/
│       └── trailing-stop/        # 8 mechanisms including PARTIAL_PROFIT (greedy trail)
├── extension/                    # Chrome Extension MV3
│   ├── manifest.json             # Declares sidePanel, tabs, storage, alarms permissions
│   ├── build.mjs                 # esbuild bundler script (outputs to extension/dist/)
│   ├── dist/                     # Built extension (committed; load this folder in Chrome)
│   ├── src/
│   │   ├── background/           # BSW: state, WSS, GET_STATE/ARM/DISARM/OPEN_SIDE_PANEL
│   │   ├── popup/                # Popup: ARM/DISARM controls + settings panel
│   │   ├── sidepanel/            # Live position monitor, signal feed
│   │   ├── dashboard/            # Full analytics and options flow
│   │   └── security/             # assertSecureUrl(), secureLocalStorageSet()
│   ├── jest.config.js
│   └── jest.setup.ts
├── docs/                         # Documentation (7 files)
├── .kiro/hooks/                  # Kiro live-watch hook (auto type-check + lint on save)
└── docker-compose.yml            # PostgreSQL 15 (port 5435) + Redis 7 (port 6380)
```

---

## Module Conventions

Every feature module follows this layout:

```
src/modules/{name}/
  {name}.types.ts        — shared types, interfaces, enums, event-name constants
  {name}.service.ts      — business logic
  {name}.module.ts       — NestJS module (imports, providers, exports)
  {name}.service.spec.ts — unit tests
```

Modules with REST endpoints add `{name}.controller.ts`. The `portfolio` module has two controllers: `portfolio.controller.ts` (P&L summary) and `settings.controller.ts` (trading config).

---

## Adding a New Module

1. Create `src/modules/{name}/` and add the convention files.
2. Write `{name}.types.ts` first — settle on the public interface before the implementation.
3. Implement the service with constructor injection.
4. Register the module in `AppModule.imports` (or as a dependency of an existing module).
5. Write unit tests. Use `@nestjs/testing`'s `Test.createTestingModule()`.
6. If new entities are needed: `npm run migration:generate src/migrations/Description`.

---

## TypeScript Configuration

TypeScript 5.7.3 is required (NestJS 10 is incompatible with TS 6.x).

```bash
# Check type errors (whole project)
npx tsc --noEmit

# Check extension only
npx tsc --noEmit -p extension/tsconfig.json
```

The extension uses a separate `extension/tsconfig.json` with `outDir: ./dist`. It is bundled by **esbuild** (not tsc directly) for the browser target.

---

## Building the Chrome Extension

The extension TypeScript is bundled with esbuild into `extension/dist/`. The dist is committed to git so Chrome can load it without a build step. After any source change, rebuild:

```bash
npm run build:extension          # one-shot build
npm run build:extension:watch    # watch mode — rebuilds on every .ts save
```

Then reload the extension in Chrome: `chrome://extensions` → MoneyPrinter → ↺ reload.

---

## Live Watch Mode (Kiro Hook)

The `.kiro/hooks/live-watch-mode.json` hook fires on every `.ts` file save. It automatically:

1. Runs `npx tsc --noEmit` (whole project)
2. Runs ESLint on the saved file
3. Finds and runs the matching `.spec.ts` test
4. Pings `localhost:3002` to check server health

Results appear as a compact summary in the Kiro chat. No manual test run needed during development.

---

## Running Tests

```bash
# All 1,442+ unit tests (main project)
npm test

# Single module
npx jest --testPathPattern="risk-management" --no-coverage

# With coverage
npm run test:cov

# Chrome Extension tests only (uses extension/jest.config.js)
npm run test:extension

# Force-exit (useful for tests with timers)
npx jest --forceExit --no-coverage
```

---

## Migrations

Migrations live in `src/migrations/` and are compiled to `dist/migrations/` by `npm run build`. The `data-source.ts` uses `join(__dirname, '..', 'migrations', '*.{ts,js}')` which resolves to the right path in both ts-node (src/) and compiled (dist/) contexts.

```bash
# Apply all pending migrations
npm run migration:run

# Generate a new migration from entity changes
npm run migration:generate src/migrations/MyDescription

# Revert last migration
npm run migration:revert
```

---

## Key Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `WS_PORT` | `3001` | WebSocket (NotificationGateway) port |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_URL` | — | Redis connection string |
| `DHAN_CLIENT_ID` | — | Dhan API client ID |
| `DHAN_ACCESS_TOKEN` | — | Dhan API access token (refresh daily) |
| `JWT_PRIVATE_KEY` | — | RS256 private key (PEM, `\n`-escaped) |
| `JWT_PUBLIC_KEY` | — | RS256 public key (PEM, `\n`-escaped) |
| `ENCRYPTION_KEY` | — | AES-256-GCM key (64-char hex) |
| `DAILY_LOSS_LIMIT_RUPEES` | `10000` | Daily loss limit — triggers EMERGENCY_HALT |
| `MAX_EXPOSURE_PCT` | `20` | Max total open position exposure (% of capital) |
| `MIN_OI_THRESHOLD` | `0` | Min OI for F&O stock options to be tradable |
| `MIN_ADV_THRESHOLD` | `0` | Min ADV for F&O stock options |
| `GREEDY_FIRST_TARGET_FRACTION` | `0.5` | Partial exit fraction at first target (50%) |
| `GREEDY_TRAIL_MIN_CONDITIONS` | `2` | Min conditions (of 3) needed to trail after first target |

---

## Charge Calculation Reference

All NSE F&O options charges are centralised in `TradingChargesService` (`src/modules/charges/`). Both `PaperTradingService` and `BacktestService` delegate to it.

| Component | Rate | Applied on |
|---|---|---|
| Brokerage | ₹20 × 2 = ₹40 | Both legs |
| STT | **0.1%** (Budget 2024) | Sell leg only |
| NSE Exchange | 0.053% | Total turnover |
| GST | 18% | Brokerage + Exchange |
| SEBI | ₹10/crore | Total turnover |
| Stamp Duty | 0.003% | Buy leg only |

---

## Contributing

- Match the existing style (NestJS decorators, BigInt arithmetic for money, `satisfies` for event payloads).
- Add a `.spec.ts` test for every new service method.
- Never hardcode charge rates — use `TradingChargesService`.
- Never hardcode starting capital — read from `UserSettings.paperStartingCapital` (default ₹50,000).
- Options-buying only: `PaperTradingService` blocks SELL orders that would open a SHORT. Any live trading path must respect this.
- Keep `SECRETS_BACKEND=env` for local dev; switch to `aws` or `vault` for production.
