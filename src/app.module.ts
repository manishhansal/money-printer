import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisModule } from './modules/redis/redis.module';
import { NotificationModule } from './modules/notification/notification.module';
import { AuthModule } from './modules/auth/auth.module';
import { SecretsModule } from './modules/secrets/secrets.module';
import { SignalScoringModule } from './modules/signal-scoring/signal-scoring.module';
import { OptionsFlowModule } from './modules/options-flow/options-flow.module';
import { RedisChannelWiringModule } from './modules/event-wiring/redis-channel-wiring.module';
import { ThrottleByUserGuard } from './common/guards/throttle-by-user.guard';
import { ThrottlerExceptionFilter } from './common/filters/throttler-exception.filter';
import { CsrfMiddleware } from './common/middleware/csrf.middleware';
import { PipelineWiringModule } from './modules/event-wiring/pipeline-wiring.module';
import { JournalWiringModule } from './modules/event-wiring/journal-wiring.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';

/**
 * Root application module.
 *
 * Database configuration rules (Requirements 2.3, 2.4):
 *  - synchronize is ALWAYS false — schema changes via migrations only.
 *  - Connection timeout is enforced at two levels:
 *      1. Driver level: `extra.connectionTimeoutMillis` in the pg pool (10 s).
 *      2. Application level: the Promise.race guard in main.ts exits the
 *         process if NestFactory.create does not resolve within 10 seconds.
 *
 * Security middleware (Requirements 16.3, 16.4, 16.5):
 *  - ThrottlerModule: global rate limiting (100 req/60 s per authenticated client).
 *  - ThrottleByUserGuard: APP_GUARD — active on every route; uses JWT sub as key.
 *  - ThrottlerExceptionFilter: APP_FILTER — returns HTTP 429 with Retry-After > 0.
 *  - CsrfMiddleware: applied to all routes; validates X-CSRF-Token on mutations.
 */
@Module({
  imports: [
    // ── Rate limiting (Requirements 16.3, 16.4) ──────────────────────────
    // Default throttler: 100 requests per 60-second window per client.
    // ttl is in milliseconds in @nestjs/throttler v6.x.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000, // 60-second sliding window (ms)
        limit: 100, // maximum requests per window per client
      },
    ]),
    // Load .env variables globally so every module can inject ConfigService.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),

    // TypeORM module — async so ConfigService is available before connecting.
    // Using forRootAsync with an explicit 'type: postgres' constant ensures
    // TypeScript can narrow the union of DataSourceOptions correctly.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,

        // Prefer DATABASE_URL (connection string) for portability.
        url: config.getOrThrow<string>('DATABASE_URL'),

        // Entity discovery — glob covers both ts-node (*.ts) and compiled (*.js).
        entities: [join(__dirname, '**', '*.entity.{ts,js}')],

        // Migration files live in the project-root migrations/ directory.
        migrations: [join(__dirname, '..', 'migrations', '*.{ts,js}')],

        // ALWAYS false — schema changes are managed exclusively through migrations.
        synchronize: false,

        // Migrations are run explicitly via `npm run migration:run`.
        migrationsRun: false,

        // Verbose query logging in development only.
        logging:
          config.get<string>('NODE_ENV') === 'development'
            ? (['query', 'error', 'warn'] as const)
            : (['error'] as const),

        // TLS: enable for managed cloud PostgreSQL instances.
        ssl: config.get<string>('DATABASE_SSL') === 'true' ? { rejectUnauthorized: false } : false,

        // pg connection pool settings with 10-second connection timeout.
        extra: {
          connectionTimeoutMillis: 10_000,
          idleTimeoutMillis: 30_000,
          max: 10,
          min: 2,
        },
      }),
    }),

    // Redis module — global, provides command and pub/sub clients to all modules.
    RedisModule,

    // Notification module — priority queue + WebSocket push to Extension.
    NotificationModule,

    // Secrets module — global, provides SecretsService to all modules.
    SecretsModule,

    // Auth module — JWT strategy, guards, login/logout/refresh/status.
    AuthModule,

    // Signal scoring + opportunity intelligence ranking (Req 8.x, 20.1).
    SignalScoringModule,

    // Options Flow Dashboard — net OI change, PCR, IV skew, large-block
    // detection; GET /options-flow/dashboard (Req 20.6, 20.7).
    OptionsFlowModule,

    // Event pipeline wiring — connects StrategyModule → SignalScoringModule and
    // PositionMonitoringModule → RiskManagementModule via NestJS EventEmitter2
    // (Requirements 9.1, 9.2, 11.3).
    PipelineWiringModule,

    // Journal wiring — routes position.exit and risk.daily_loss_state_changed events
    // to TradeJournal write paths; installs GlobalExceptionFilter for health reporting
    // (Requirements 13.1, 10.1).
    JournalWiringModule,

    // Portfolio — Dynamic_Capital tracking, open position management, and
    // GET /portfolio/summary endpoint for Chrome Extension P&L display.
    PortfolioModule,

    // Redis channel wiring — bridges events:regime_change and events:session_phase
    // pub/sub channels to in-process service handlers; also ensures
    // PositionMonitoringService tick subscriptions are active on startup
    // (Requirements 2.1, 5.3, 17.5).
    RedisChannelWiringModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,

    // ── Global rate-limiting guard (Requirements 16.3, 16.4) ─────────────
    // ThrottleByUserGuard runs on every route.  Uses JWT sub claim as the
    // throttle bucket key; falls back to IP for unauthenticated requests.
    {
      provide: APP_GUARD,
      useClass: ThrottleByUserGuard,
    },

    // ── Global HTTP 429 exception filter (Requirement 16.4) ──────────────
    // Intercepts ThrottlerException and returns a well-formed 429 response
    // with a strictly positive Retry-After integer header.
    {
      provide: APP_FILTER,
      useClass: ThrottlerExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * Apply CSRF middleware globally.
   *
   * The middleware itself only validates tokens on state-modifying HTTP methods
   * (POST, PUT, PATCH, DELETE) and skips health-check paths.  Applying it to
   * all routes here ensures every future controller is automatically protected
   * without opt-in decoration.
   *
   * Requirement 16.5
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}
