/**
 * CloudEngine entry point.
 *
 * Startup connection-timeout rule (Requirements 2.3, 2.4):
 *   If PostgreSQL and Redis connections are not established within 10 seconds,
 *   the process logs the failure and exits with code 1.
 *   The CloudEngine must never accept API requests with degraded infrastructure.
 *
 * Production hardening (Phase 10):
 *   - helmet: sets 14 security HTTP response headers (CSP, HSTS, X-Frame-Options, etc.)
 *   - compression: gzip/deflate for API responses > 1KB (reduces payload by ~70%)
 *   - validateEnv(): fast-fail on missing critical environment variables
 */

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { validateEnv } from './common/config/env-validation';

/** Maximum milliseconds allowed for all infrastructure connections on startup. */
const STARTUP_CONNECTION_TIMEOUT_MS = 10_000;

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  /**
   * Race the full NestJS initialisation (which includes TypeORM connecting to
   * PostgreSQL and the RedisModule connecting to Redis) against a 10-second
   * deadline.  If the deadline fires first the process exits with code 1 so
   * process supervisors (Docker, systemd, PM2) can trigger restart logic.
   */
  const connectionTimeoutGuard = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `CloudEngine failed to establish infrastructure connections within ` +
            `${STARTUP_CONNECTION_TIMEOUT_MS / 1_000} seconds. ` +
            `Verify that PostgreSQL (DATABASE_URL) and Redis (REDIS_HOST/REDIS_URL) ` +
            `are reachable and the credentials in .env are correct.`,
        ),
      );
    }, STARTUP_CONNECTION_TIMEOUT_MS);
  });

  try {
    // ── Phase 10: Validate required env vars before creating the app ──────
    validateEnv(process.env.NODE_ENV !== 'test');

    const app = await Promise.race([
      NestFactory.create<NestExpressApplication>(AppModule),
      connectionTimeoutGuard,
    ]);

    // Connections succeeded — cancel the deadline timer.
    clearTimeout(timeoutHandle);

    // ── Phase 10: Security headers via helmet ─────────────────────────────
    // Configured to allow the dashboard's inline scripts and styles.
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            // Dashboard HTML uses inline <style> and <script> blocks.
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            // Allow WebSocket connections back to the CloudEngine.
            connectSrc: ["'self'", 'ws://localhost:*', 'wss://*'],
            imgSrc: ["'self'", 'data:'],
            fontSrc: ["'self'"],
          },
        },
        // HSTS: 1 year, include subdomains (disable in dev if using HTTP).
        strictTransportSecurity:
          process.env.NODE_ENV === 'production'
            ? { maxAge: 31_536_000, includeSubDomains: true }
            : false,
      }),
    );

    // ── Phase 10: Gzip compression for API responses ──────────────────────
    // Skips already-compressed content (images, pre-compressed bundles).
    // Reduces JSON API payloads by ~70% on average.
    app.use(compression());

    // Serve the browser dashboard from the public/ directory.
    // GET http://localhost:{PORT}/ → public/index.html
    app.useStaticAssets(join(__dirname, '..', 'public'));

    // CORS — allow Chrome extensions and localhost origins.
    // In production, restrict `chrome-extension://*` to known extension IDs.
    app.enableCors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Postman)
        if (!origin) return callback(null, true);
        // Allow any Chrome extension origin
        if (origin.startsWith('chrome-extension://')) return callback(null, true);
        // Allow localhost on any port (dev servers, tests)
        if (origin.startsWith('http://localhost') || origin.startsWith('https://localhost')) {
          return callback(null, true);
        }
        callback(new Error(`CORS: origin '${origin}' is not allowed`), false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    });

    // Enable DTO validation globally.  `whitelist: true` strips unknown
    // properties; `transform: true` coerces plain objects into DTO class
    // instances so class-validator decorators fire correctly.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    const port = parseInt(process.env.PORT ?? '3000', 10);
    await app.listen(port);

    // Enable graceful shutdown so NestJS calls `onModuleDestroy()` on SIGTERM/SIGINT.
    // This allows DhanWebSocketClient, timers, and DB connections to close cleanly.
    app.enableShutdownHooks();

    logger.log(`CloudEngine is running on http://localhost:${port}`);
    logger.log(`Environment: ${process.env.NODE_ENV ?? 'development'}`);
  } catch (error) {
    clearTimeout(timeoutHandle);

    logger.error(`CloudEngine startup failed: ${(error as Error).message}`, (error as Error).stack);
    logger.error('Terminating process. Fix connectivity issues and restart the CloudEngine.');

    // Exit with non-zero code so supervisors know the service did not start.
    process.exit(1);
  }
}

void bootstrap();
