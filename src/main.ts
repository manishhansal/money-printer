/**
 * CloudEngine entry point.
 *
 * Startup connection-timeout rule (Requirements 2.3, 2.4):
 *   If PostgreSQL and Redis connections are not established within 10 seconds,
 *   the process logs the failure and exits with code 1.
 *   The CloudEngine must never accept API requests with degraded infrastructure.
 */

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

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
    const app = await Promise.race([NestFactory.create(AppModule), connectionTimeoutGuard]);

    // Connections succeeded — cancel the deadline timer.
    clearTimeout(timeoutHandle);

    // Enable DTO validation globally.  `whitelist: true` strips unknown
    // properties; `transform: true` coerces plain objects into DTO class
    // instances so class-validator decorators fire correctly.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    const port = parseInt(process.env.PORT ?? '3000', 10);
    await app.listen(port);

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
