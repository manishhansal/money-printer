# MoneyPrinter — Developer Guide

## Project Structure

The repository has two independently buildable sub-projects:

```
money-printer/
├── src/                        # NestJS CloudEngine
│   ├── app.module.ts           # Root module; registers global guards, filters, middleware
│   ├── main.ts                 # Bootstrap with 10-second startup timeout guard
│   ├── common/                 # Cross-cutting concerns
│   │   ├── filters/            # GlobalExceptionFilter, ThrottlerExceptionFilter
│   │   ├── guards/             # ThrottleByUserGuard
│   │   ├── middleware/         # CsrfMiddleware
│   │   └── transformers/       # EncryptedColumnTransformer (AES-256-GCM)
│   ├── database/
│   │   ├── data-source.ts      # TypeORM DataSource for migration CLI
│   │   └── entities/           # 24+ TypeORM entity classes
│   └── modules/                # Feature modules (one directory per domain)
│       ├── auth/
│       ├── signal-scoring/
│       ├── risk-management/
│       ├── ...
│       └── event-wiring/       # Redis channel and EventEmitter2 wiring
├── extension/                  # Chrome Extension MV3
│   ├── manifest.json
│   ├── src/
│   │   ├── background/         # Background Service Worker
│   │   ├── popup/              # Popup UI (two-step ARM/DISARM)
│   │   ├── sidepanel/          # Side panel (positions, signals, alerts)
│   │   ├── dashboard/          # Full dashboard (analytics, options flow)
│   │   └── security/           # Security invariant helpers
│   └── jest.config.js
└── migrations/                 # TypeORM migration files
```

---

## Module Conventions

Every feature module follows this file layout:

```
src/modules/{name}/
  {name}.types.ts      — shared types, interfaces, enums, event name constants
  {name}.service.ts    — business logic implementation
  {name}.module.ts     — NestJS module class (imports, providers, exports)
  {name}.service.spec.ts  — unit tests
```

Modules with REST endpoints add `{name}.controller.ts`. Modules with multiple services add additional `{name2}.service.ts` / `{name2}.service.spec.ts` pairs within the same directory.

**Types file** is the first thing to write when adding a new module. It defines the contracts (interfaces, enums, event names) that other modules depend on, and keeps circular import risk minimal by importing from other modules' types files rather than their service files.

**Module file** imports only what the service needs. Prefer injecting from global modules (RedisModule, SecretsModule, NotificationModule are global) rather than re-importing them. Register the service in `providers`, export it if other modules will inject it.

---

## Adding a New Module

1. Create `src/modules/{name}/` and add the four convention files.
2. Write types first — settle on the public interface before the implementation.
3. Implement the service, injecting any required repositories via `@InjectRepository` and global services via constructor injection.
4. Register the module class in `AppModule.imports` (or as a dependency of an existing module).
5. Write unit tests in `{name}.service.spec.ts`. Use `@nestjs/testing`'s `Test.createTestingModule()`.
6. Run `npm run typeorm -- migration:generate -d src/database/data-source.ts migrations/{description}` if the module adds new entities.

---

## TypeScript Configuration

TypeScript strict mode is enabled. Relevant flags in `tsconfig.json`:

- `strict: true` — enables `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, and others
- `noImplicitAny: true`
- `strictNullChecks: true`

Before submitting changes, verify there are no type errors:

```bash
npx tsc --noEmit
```

TypeORM entities use `!` definite assignment assertions (e.g. `id!: string`) because TypeORM hydrates properties at runtime rather than through constructors. This is expected and intentional — do not remove them.

Monetary amounts that come from PostgreSQL `NUMERIC` columns are typed as `string` to prevent IEEE-754 floating-point precision loss. Never cast them to `number` without explicit intent.

---

## Event Bus Architecture

Two event mechanisms are used. Choosing the right one matters for coupling and performance.

### Redis pub/sub — cross-module realtime data

Use for data that must cross module or process boundaries in realtime:

| Channel | Use case |
|---|---|
| `events:tick:{instrument_id}` | Live market tick from DhanWebSocketClient to position monitoring, technical analysis, options intelligence |
| `events:regime_change` | Regime transition broadcast to strategy, risk, live trading modules |
| `events:session_phase` | Session phase transition to all trading-aware modules |
| `events:paper:*` | Paper engine event isolation namespace |

Publishing uses `RedisService.publish(channel, JSON.stringify(payload))`. Subscribing uses `RedisService.subscribe(channel, handler)` — the pub/sub client is a dedicated `ioredis` instance that cannot run regular commands while in subscribed mode.

### NestJS EventEmitter2 — intra-process domain events

Use for events that connect services within the same process without needing cross-process fan-out:

| Event | Emitter | Handler |
|---|---|---|
| `strategy.signal.candidate` | `StrategyService` | `PipelineWiringService` → `SignalScoringService` |
| `risk.unrealized_pnl_updated` | `PositionMonitoringService` | `PipelineWiringService` → `DailyLossStateMachineService` |
| `position.exit` | `PositionMonitoringService` | `JournalWiringService` → `TradeJournalService` |
| `risk.daily_loss_state_changed` | `DailyLossStateMachineService` | `JournalWiringService` → `TradeJournalService` |
| `vix.position.size.restored` | `VixPositionSizeService` | `RiskManagementService` |
| `market.regime.changed` | `MarketRegimeService` | `StrategyService`, `RiskManagementService` |
| `session.phase.changed` | `SessionManagerService` | `StrategyService`, `LiveTradingService` |

EventEmitter2 event names are defined as string constants in the module's `types.ts` file (e.g. `REGIME_CHANGED_EVENT = 'market.regime.changed'`). Never use magic strings directly in `emit()` or `@OnEvent()` decorators.

---

## Testing

### Running tests

```bash
npm test               # All CloudEngine unit tests (1,442 tests), run serially
npm run test:extension # Chrome Extension unit tests
npm run test:cov       # Coverage report (HTML + lcov in coverage/)
```

To run tests for a single module, use `--testPathPattern`:

```bash
npx jest --testPathPattern signal-scoring --runInBand
npx jest --testPathPattern daily-loss-state-machine --runInBand
```

Tests run with `--runInBand` (serially) because some test suites mock global state. Do not remove this flag.

### Unit test conventions

Tests use `@nestjs/testing`'s `Test.createTestingModule()`. Repositories are mocked by providing `jest.fn()` implementations for the methods under test:

```typescript
const module = await Test.createTestingModule({
  providers: [
    MyService,
    {
      provide: getRepositoryToken(MyEntity),
      useValue: { find: jest.fn(), save: jest.fn() },
    },
  ],
}).compile();
```

Do not write tests that depend on a live database or Redis instance. The test environment is fully in-memory.

### Property-based tests

Fast-check (`fast-check` package) is used for property-based tests that verify financial invariants. Every property-based test file must:

1. Import `* as fc from 'fast-check'`
2. Use a minimum of **100 iterations** per property: `{ numRuns: 100 }`
3. Tag the containing describe block with a comment:

```typescript
// Feature: money-printer
// Property 1: net_pnl = gross_pnl - sum(all_charges)
```

Existing property-based test files:
- `src/modules/trade-journal/trade-journal-net-pnl.pbt.spec.ts` — P&L calculation invariants
- `src/modules/market-data/market-data-cache.service.spec.ts` — Redis key derivation invariants
- `src/modules/risk-management/risk-management.service.spec.ts` — position sizing invariants

---

## Paper vs Live Engine Rules

The paper engine is a full simulation that must behave identically to the live engine in signal evaluation, risk gate checks, and cost calculation — but must never touch live infrastructure:

| Rule | Requirement |
|---|---|
| Write to `paper_*` tables only | Never INSERT into `orders`, `executions`, `positions`, `trades` from paper code paths |
| Write to `paper:*` Redis keys only | Never write to keys without the `paper:` prefix from paper code paths |
| Publish to `events:paper:*` channels only | Never publish to `events:fill`, `events:order`, etc. from paper code paths |
| Never call `DhanApiClient` | Paper fills are simulated; no real broker API calls |
| Apply identical NSE cost model | Use the same 6-component cost formula as the live engine |

The paper/live isolation invariants are verified by tests in `src/modules/event-wiring/journal-wiring.service.spec.ts` (tests 3 and 4 specifically check the `paper:` key and channel namespacing).

---

## Migration Workflow

Migrations live in `migrations/` and are run by the TypeORM CLI against `src/database/data-source.ts`.

```bash
# Generate a new migration after changing entities
npm run migration:generate -- migrations/YourDescriptiveName

# Apply pending migrations
npm run migration:run

# Revert the last migration (destructive — only in development)
npm run migration:revert
```

The `synchronize: false` flag in `AppModule`'s TypeORM config is never changed. Schema changes in production always go through migrations, never through auto-sync.

Migrations in `migrations/` are compiled by ts-node at CLI time. The glob `join(__dirname, '..', 'migrations', '*.{ts,js}')` in `AppModule` picks up both `.ts` (ts-node) and `.js` (compiled dist) files.

---

## Linting and Formatting

```bash
npm run lint     # ESLint with auto-fix
npm run format   # Prettier formatting
```

ESLint config is in `.eslintrc.js` and extends `@typescript-eslint`. Prettier config is in `.prettierrc`. Both are enforced in CI. The `.prettierignore` file excludes `dist/` and `node_modules/`.

---

## Dependency Management

New dependencies should be pinned to exact versions in `package.json` (or use the lockfile). When adding a dependency, check:

1. Is it actively maintained? (last publish date, open issues)
2. Is the package name correct? (typosquatting risk)
3. Does a lighter-weight alternative already exist in the project?

The project uses these primary runtime stacks: NestJS 10, TypeORM 0.3, ioredis 5, `@aws-sdk/client-secrets-manager` v3, `uuid` v10. New dependencies in these domains should be verified against existing versions before introducing alternatives.
