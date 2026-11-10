import { Global, Module, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { REDIS_CLIENT, REDIS_PUBSUB_CLIENT, REDIS_RECONNECT_CONFIG } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * Builds ioredis options with exponential-backoff reconnect strategy.
 *
 * ioredis calls retryStrategy on every failed connection attempt and uses the
 * returned number (milliseconds) as the delay before the next attempt.
 * Returning null/undefined stops retrying permanently.
 */
function buildRedisOptions(configService: ConfigService, clientName: string): RedisOptions {
  const logger = new Logger(`Redis:${clientName}`);

  return {
    host: configService.get<string>('REDIS_HOST', 'localhost'),
    port: configService.get<number>('REDIS_PORT', 6379),
    password: configService.get<string>('REDIS_PASSWORD'),
    db: configService.get<number>('REDIS_DB', 0),
    tls: configService.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,

    // Exponential backoff: 500ms → 1s → 2s → 4s … capped at 30s
    retryStrategy(times: number): number | null {
      const { INITIAL_DELAY_MS, BACKOFF_MULTIPLIER, MAX_DELAY_MS, MAX_RETRIES } =
        REDIS_RECONNECT_CONFIG;

      if (MAX_RETRIES > 0 && times > MAX_RETRIES) {
        logger.error(
          `[${clientName}] Exceeded max reconnection attempts (${MAX_RETRIES}). Stopping retries.`,
        );
        return null; // Stop retrying — ioredis will emit 'end'
      }

      const delay = Math.min(
        INITIAL_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, times - 1),
        MAX_DELAY_MS,
      );
      logger.warn(`[${clientName}] Reconnect attempt #${times} in ${delay}ms`);
      return delay;
    },

    // Reconnect on specific errors only; for others (e.g. AUTH failures) stop retrying
    reconnectOnError(err: Error): boolean | 1 | 2 {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'];
      const shouldReconnect = targetErrors.some((e) => err.message.includes(e));
      if (shouldReconnect) {
        logger.warn(`[${clientName}] Reconnecting after error: ${err.message}`);
      }
      return shouldReconnect ? 2 : false; // 2 = reconnect and resend failed command
    },
  };
}

/**
 * Attaches shared event listeners to a Redis client instance.
 * Errors are logged but NEVER rethrow — prevents crashing the process.
 */
function attachEventListeners(client: Redis, clientName: string, logger: Logger): void {
  client.on('connect', () => logger.log(`[${clientName}] Connected`));
  client.on('ready', () => logger.log(`[${clientName}] Ready`));
  client.on('reconnecting', (delay: number) =>
    logger.warn(`[${clientName}] Reconnecting in ${delay}ms`),
  );
  client.on('close', () => logger.warn(`[${clientName}] Connection closed`));
  client.on('end', () => logger.error(`[${clientName}] Connection ended (all retries exhausted)`));

  // CRITICAL: handle 'error' to prevent Node.js unhandled-exception crash
  client.on('error', (err: Error) => {
    logger.error(`[${clientName}] Error: ${err.message}`);
  });
}

const logger = new Logger('RedisModule');

/**
 * RedisModule — NestJS global module providing two ioredis client instances:
 *
 *  1. REDIS_CLIENT       — command client (get/set/del/expire/etc.)
 *  2. REDIS_PUBSUB_CLIENT — dedicated pub/sub client (subscribe/publish only)
 *
 * The two-client pattern is required because ioredis enters a special
 * "subscriber" mode after the first subscribe() call, after which the client
 * can no longer issue regular Redis commands until it unsubscribes from all
 * channels. Keeping a separate client avoids this limitation.
 *
 * Both clients use exponential-backoff reconnection.
 * Requirement: 2.3 — CloudEngine must establish Redis connections within 10 s.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const options = buildRedisOptions(configService, 'CMD');
        const client = new Redis(options);
        attachEventListeners(client, 'CMD', logger);
        return client;
      },
    },
    {
      provide: REDIS_PUBSUB_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        const options = buildRedisOptions(configService, 'PUBSUB');
        const client = new Redis({
          ...options,
          // Pub/sub client: disable command timeout so long-lived subscriptions
          // are not torn down by the server-side idle timeout
          commandTimeout: undefined,
          // No maxRetriesPerRequest for pub/sub — commands are not retriable
          maxRetriesPerRequest: null,
        });
        attachEventListeners(client, 'PUBSUB', logger);
        return client;
      },
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, REDIS_PUBSUB_CLIENT, RedisService],
})
export class RedisModule implements OnApplicationShutdown {
  async onApplicationShutdown(signal?: string): Promise<void> {
    logger.log(`Application shutting down (signal: ${signal ?? 'unknown'}). Redis clients closed.`);
    // ioredis client disconnection is handled by RedisService.onModuleDestroy()
  }
}
