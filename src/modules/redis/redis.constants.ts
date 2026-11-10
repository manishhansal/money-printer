/**
 * Injection token for the ioredis command client.
 * Used for get/set/del/expire and all regular Redis commands.
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Injection token for the ioredis pub/sub client.
 * This client is dedicated exclusively to subscribe/publish operations.
 * It CANNOT run regular commands while in subscribed mode (ioredis constraint).
 */
export const REDIS_PUBSUB_CLIENT = 'REDIS_PUBSUB_CLIENT';

/**
 * Default reconnect strategy parameters for both clients.
 */
export const REDIS_RECONNECT_CONFIG = {
  /** Initial backoff delay in milliseconds */
  INITIAL_DELAY_MS: 500,
  /** Multiplier applied on each retry (exponential backoff) */
  BACKOFF_MULTIPLIER: 2,
  /** Maximum delay between retries in milliseconds */
  MAX_DELAY_MS: 30_000,
  /** Maximum number of reconnection attempts (0 = unlimited) */
  MAX_RETRIES: 0,
} as const;
