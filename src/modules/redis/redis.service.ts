import { Injectable, Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, REDIS_PUBSUB_CLIENT } from './redis.constants';

export type MessageHandler = (channel: string, message: string) => void;

/**
 * RedisService — high-level wrapper around the two ioredis client instances.
 *
 * Responsibilities:
 *  - Command operations: get, set, del, expire
 *  - Pub/sub operations: publish, subscribe, unsubscribe
 *  - Health check via PING
 *  - Graceful shutdown (quit both clients on module destroy)
 *
 * The service injects both clients via their respective injection tokens so
 * callers never need to interact with ioredis directly.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(REDIS_PUBSUB_CLIENT) private readonly pubSubClient: Redis,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle hooks
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    this.logger.log('RedisService initialised');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing Redis connections…');
    await Promise.allSettled([this.client.quit(), this.pubSubClient.quit()]);
    this.logger.log('Redis connections closed');
  }

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------

  /**
   * Sends a PING command to the command client and returns true if the response
   * is "PONG". Returns false on any error so callers receive a clean boolean.
   *
   * Used by SystemHealthMonitor and NestJS Terminus health checks.
   * Requirement: 2.3 — Redis connection must be established within 10 s.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.ping();
      return response === 'PONG';
    } catch (err) {
      this.logger.error(`Health check failed: ${(err as Error).message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Command operations (REDIS_CLIENT)
  // ---------------------------------------------------------------------------

  /**
   * Get the string value of a key. Returns null if the key does not exist.
   */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * Set a string value. Optionally set a TTL in seconds via `ttlSeconds`.
   * If `ttlSeconds` is provided and > 0, the key expires after that many seconds.
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  /**
   * Delete one or more keys. Returns the number of keys actually deleted.
   */
  async del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }

  /**
   * Set the TTL (time-to-live) in seconds on an existing key.
   * Returns true if the timeout was set, false if the key does not exist.
   */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.expire(key, ttlSeconds);
    return result === 1;
  }

  // ---------------------------------------------------------------------------
  // Pub/Sub operations (REDIS_PUBSUB_CLIENT)
  // ---------------------------------------------------------------------------

  /**
   * Publish a message to a Redis channel. Returns the number of subscribers
   * that received the message.
   *
   * Uses the command client (not pubSubClient) because a client in subscriber
   * mode cannot publish — only the command client can do both pub/sub sends
   * and regular commands.
   */
  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  /**
   * Subscribe to one or more Redis channels.
   *
   * The provided `handler` is invoked for every message received on any of the
   * subscribed channels. Multiple calls to subscribe() on the same client
   * accumulate handlers — ioredis supports multiple 'message' listeners.
   *
   * @param channels  One or more channel names to subscribe to.
   * @param handler   Callback invoked with (channel, message) per received message.
   */
  async subscribe(channels: string | string[], handler: MessageHandler): Promise<void> {
    const channelList = Array.isArray(channels) ? channels : [channels];
    this.pubSubClient.on('message', handler);
    await this.pubSubClient.subscribe(...channelList);
    this.logger.log(`Subscribed to channel(s): ${channelList.join(', ')}`);
  }

  /**
   * Unsubscribe from one or more channels.
   * If no channels are provided, unsubscribes from all channels.
   */
  async unsubscribe(channels?: string | string[]): Promise<void> {
    if (!channels) {
      await this.pubSubClient.unsubscribe();
      this.logger.log('Unsubscribed from all channels');
      return;
    }
    const channelList = Array.isArray(channels) ? channels : [channels];
    await this.pubSubClient.unsubscribe(...channelList);
    this.logger.log(`Unsubscribed from channel(s): ${channelList.join(', ')}`);
  }

  // ---------------------------------------------------------------------------
  // Accessors (for modules that need the raw client, e.g. for pipelines/multi)
  // ---------------------------------------------------------------------------

  /** Returns the raw command client — use sparingly; prefer the service methods. */
  getCommandClient(): Redis {
    return this.client;
  }

  /** Returns the raw pub/sub client — use sparingly. */
  getPubSubClient(): Redis {
    return this.pubSubClient;
  }

  /**
   * Returns all keys matching the given glob pattern.
   * Use carefully in production — KEYS is O(N) and blocks Redis.
   * Only call with specific prefixes (e.g. 'mkt:snapshot:*') to bound N.
   */
  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }
}
