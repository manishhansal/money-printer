/**
 * notification.service.ts
 *
 * Core notification delivery engine.
 *
 * Priority queue:  MAX > CRITICAL > WARNING > INFO
 * Delivery:        WebSocket push via registered broadcast callback
 * Buffer:          Redis LIST `notifications:pending:{priority}`
 * Retry:           Up to MAX_DELIVERY_RETRIES (3) attempts before buffering
 * Acknowledgment:  MAX-priority alerts tracked in Redis + in-memory map
 *
 * No alert is silently dropped:
 *   If WebSocket delivery fails after all retries the alert is written to the
 *   Redis buffer. When a client reconnects, flushBuffer() replays the buffer
 *   in priority order (MAX → CRITICAL → WARNING → INFO).
 *
 * Requirements: 12.7, 12.8, 20.9
 */

import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  AlertPriority,
  NotificationAlert,
  PRIORITY_ORDER,
  PRIORITY_WEIGHT,
  redisAckKey,
  redisBufferKey,
  MAX_DELIVERY_RETRIES,
  RETRY_DELAY_MS,
  ACK_TTL_SECONDS,
} from './notification.types';

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface QueueItem {
  alert: NotificationAlert;
  retryCount: number;
}

interface AckState {
  acknowledged: boolean;
  acknowledgedAt?: Date;
}

/** Synchronous broadcast callback registered by NotificationGateway.onModuleInit() */
type BroadcastFn = (alert: NotificationAlert) => boolean;

/** Returns true when at least one WebSocket client is connected */
type HasClientsFn = () => boolean;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);

  /**
   * In-memory priority queue.
   *
   * Invariant: sorted by PRIORITY_WEIGHT descending, then createdAt ascending
   * (FIFO within the same priority level).
   *
   * Items are removed from the queue once delivery succeeds or after all retries
   * have been exhausted and the alert has been buffered to Redis.
   */
  private readonly queue: QueueItem[] = [];

  /**
   * In-memory acknowledgment tracking for MAX-priority alerts.
   * Persisted to Redis for durability (TTL: 24 hours).
   */
  private readonly maxAlertAckMap = new Map<string, AckState>();

  /** Registered by NotificationGateway.onModuleInit() */
  private broadcastFn: BroadcastFn | null = null;
  private hasClientsFn: HasClientsFn | null = null;

  /** Guards against concurrent flushBuffer invocations */
  private isFlushing = false;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleInit(): void {
    this.logger.log('NotificationService initialized');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Gateway registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called by NotificationGateway.onModuleInit() to register the delivery
   * callback. The late-binding pattern avoids a circular NestJS dependency
   * between gateway and service.
   *
   * @param broadcastFn    Sends the alert to all connected WS clients.
   *                       Returns true if at least one client received it.
   * @param hasClientsFn   Returns true when at least one WS client is open.
   */
  registerDelivery(broadcastFn: BroadcastFn, hasClientsFn: HasClientsFn): void {
    this.broadcastFn = broadcastFn;
    this.hasClientsFn = hasClientsFn;
    this.logger.log('Delivery callbacks registered from gateway');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Publish an alert to the priority queue and attempt immediate delivery.
   *
   * Flow:
   *   1. Track MAX-priority alert in the ACK map.
   *   2. Enqueue into in-memory sorted queue.
   *   3. Attempt WebSocket delivery with up to MAX_DELIVERY_RETRIES retries.
   *   4. On exhaustion, buffer to Redis — the alert is never silently dropped.
   *
   * Requirements: 12.7, 12.8, 20.9
   */
  async publish(alert: NotificationAlert): Promise<void> {
    this.logger.log(`[${alert.priority}] Publishing alert id=${alert.id} title="${alert.title}"`);

    // Register MAX alerts for acknowledgment tracking before delivery attempt
    if (alert.priority === 'MAX') {
      this.maxAlertAckMap.set(alert.id, { acknowledged: false });
    }

    this.enqueue({ alert, retryCount: 0 });
    await this.deliverWithRetry(alert);
  }

  /**
   * Mark a MAX-priority alert as acknowledged by the Extension user.
   *
   * Idempotent — duplicate ACKs for the same alertId are silently ignored.
   * Acknowledgment state is persisted to Redis with ACK_TTL_SECONDS TTL for
   * audit purposes.
   *
   * Used by TrailingStopEngine to reset SL rejection counters (Requirements 12.8, 12.9).
   *
   * @throws No exceptions — all errors are logged and swallowed so a failed
   *         ACK persistence does not crash the delivery path.
   */
  async acknowledge(alertId: string): Promise<void> {
    const ackState = this.maxAlertAckMap.get(alertId);

    if (!ackState) {
      this.logger.warn(`Ack received for unknown or non-MAX alert id=${alertId} — ignoring`);
      return;
    }

    if (ackState.acknowledged) {
      this.logger.debug(`Duplicate ack for MAX alert id=${alertId} — ignoring`);
      return;
    }

    const now = new Date();
    ackState.acknowledged = true;
    ackState.acknowledgedAt = now;

    // Persist to Redis for durability
    try {
      await this.redis.set(
        redisAckKey(alertId),
        JSON.stringify({ acknowledged: true, acknowledgedAt: now.toISOString() }),
        'EX',
        ACK_TTL_SECONDS,
      );
      this.logger.log(`MAX alert id=${alertId} acknowledged at ${now.toISOString()}`);
    } catch (err) {
      this.logger.error(
        `Failed to persist ack for alert id=${alertId} to Redis: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Returns all buffered (undelivered) alerts from Redis.
   *
   * Results are ordered MAX → CRITICAL → WARNING → INFO. Within each priority
   * level, alerts are in chronological insertion order (FIFO).
   *
   * @param priority  Optional filter — returns only alerts for this priority.
   */
  async getPendingAlerts(priority?: AlertPriority): Promise<NotificationAlert[]> {
    const levels: AlertPriority[] = priority ? [priority] : [...PRIORITY_ORDER];
    const results: NotificationAlert[] = [];

    for (const level of levels) {
      const raw = await this.redis.lrange(redisBufferKey(level), 0, -1);
      for (const item of raw) {
        try {
          const alert = JSON.parse(item) as NotificationAlert;
          // Rehydrate Date objects lost during JSON serialisation
          alert.createdAt = new Date(alert.createdAt);
          if (alert.acknowledgedAt) {
            alert.acknowledgedAt = new Date(alert.acknowledgedAt);
          }
          results.push(alert);
        } catch {
          this.logger.error(
            `Failed to parse buffered alert from Redis key=${redisBufferKey(level)}: ${item}`,
          );
        }
      }
    }

    return results;
  }

  /**
   * Flush all buffered alerts from Redis to currently connected clients.
   *
   * Called by NotificationGateway when a new Extension client connects so no
   * buffered alert is left undelivered. Concurrent calls are safely coalesced —
   * only one flush runs at a time.
   *
   * Flush order: MAX → CRITICAL → WARNING → INFO (Requirements 12.7)
   */
  async flushBuffer(): Promise<void> {
    if (this.isFlushing) return;
    if (!this.hasClientsFn?.()) return; // No clients — nothing to flush to

    this.isFlushing = true;
    this.logger.log('Flushing Redis alert buffer to connected clients');

    try {
      for (const priority of PRIORITY_ORDER) {
        await this.flushPriorityBuffer(priority);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — queue management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert a QueueItem in sorted position.
   *
   * Sort key: PRIORITY_WEIGHT descending, then createdAt ascending.
   * This maintains MAX-first order while preserving FIFO within a priority.
   */
  private enqueue(item: QueueItem): void {
    const weight = PRIORITY_WEIGHT[item.alert.priority];

    const insertAt = this.queue.findIndex(
      (q) =>
        PRIORITY_WEIGHT[q.alert.priority] < weight ||
        (PRIORITY_WEIGHT[q.alert.priority] === weight &&
          new Date(q.alert.createdAt) > new Date(item.alert.createdAt)),
    );

    if (insertAt === -1) {
      this.queue.push(item);
    } else {
      this.queue.splice(insertAt, 0, item);
    }
  }

  /** Remove the queue entry for a given alert id (called after delivery or buffering) */
  private dequeue(alertId: string): void {
    const idx = this.queue.findIndex((q) => q.alert.id === alertId);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — delivery with retry
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Attempt delivery up to MAX_DELIVERY_RETRIES times.
   *
   * On each failure a back-off delay of RETRY_DELAY_MS × attempt number is
   * applied before the next attempt. After all retries are exhausted the alert
   * is written to the Redis buffer so it is never silently dropped.
   */
  private async deliverWithRetry(alert: NotificationAlert): Promise<void> {
    for (let attempt = 1; attempt <= MAX_DELIVERY_RETRIES; attempt++) {
      const delivered = await this.attemptDelivery(alert);
      if (delivered) {
        this.dequeue(alert.id);
        return;
      }

      if (attempt < MAX_DELIVERY_RETRIES) {
        await this.sleep(RETRY_DELAY_MS * attempt);
      }
    }

    // All retries exhausted — buffer to Redis
    this.logger.warn(
      `[${alert.priority}] Alert id=${alert.id} could not be delivered after ` +
        `${MAX_DELIVERY_RETRIES} retries — buffering to Redis`,
    );
    await this.bufferToRedis(alert);
    this.dequeue(alert.id);
  }

  /**
   * Single delivery attempt via the registered broadcast callback.
   *
   * @returns true if the broadcast function reports at least one delivery.
   */
  private async attemptDelivery(alert: NotificationAlert): Promise<boolean> {
    if (!this.broadcastFn) {
      // Gateway not yet registered — treat as no clients connected
      return false;
    }

    try {
      return this.broadcastFn(alert);
    } catch (err) {
      this.logger.error(`Broadcast error for alert id=${alert.id}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Write an alert to the Redis LIST for its priority level.
   * Uses RPUSH so alerts within a priority are in chronological order.
   *
   * This is the last-resort safety net — even if delivery fails completely,
   * the alert is preserved and will be replayed on the next client reconnection.
   */
  private async bufferToRedis(alert: NotificationAlert): Promise<void> {
    const key = redisBufferKey(alert.priority);
    try {
      await this.redis.rpush(key, JSON.stringify(alert));
      this.logger.debug(`[${alert.priority}] Alert id=${alert.id} buffered to Redis key=${key}`);
    } catch (err) {
      // Even buffering failed — log a CRITICAL error. This is the only scenario
      // where an alert can be lost; we surface it clearly for operator action.
      this.logger.error(
        `CRITICAL: Failed to buffer alert id=${alert.id} [${alert.priority}] ` +
          `to Redis key=${key} — alert may be lost! Error: ${(err as Error).message}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — buffer flush helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Read all buffered alerts for one priority level from Redis and deliver them.
   * Successfully delivered items are removed from the Redis LIST via LREM.
   */
  private async flushPriorityBuffer(priority: AlertPriority): Promise<void> {
    const key = redisBufferKey(priority);

    let items: string[];
    try {
      items = await this.redis.lrange(key, 0, -1);
    } catch (err) {
      this.logger.error(`Failed to read Redis buffer for [${priority}]: ${(err as Error).message}`);
      return;
    }

    if (items.length === 0) return;

    this.logger.log(`Flushing ${items.length} buffered [${priority}] alert(s)`);

    for (const item of items) {
      try {
        const alert = JSON.parse(item) as NotificationAlert;
        alert.createdAt = new Date(alert.createdAt);
        if (alert.acknowledgedAt) {
          alert.acknowledgedAt = new Date(alert.acknowledgedAt);
        }

        const delivered = await this.attemptDelivery(alert);
        if (delivered) {
          // Remove delivered alert from the Redis LIST (count=1 removes first match)
          await this.redis.lrem(key, 1, item);
          this.logger.debug(
            `[${priority}] Buffered alert id=${alert.id} delivered and removed from Redis`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Failed to process buffered [${priority}] alert: ${(err as Error).message}`,
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — utility
  // ─────────────────────────────────────────────────────────────────────────

  /** Promisified sleep — extracted to a protected method so tests can spy on it */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Test helpers (visible to spec files via direct class access)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns a snapshot of the in-memory priority queue.
   * Exposed for unit-testing queue ordering invariants.
   */
  getQueueSnapshot(): ReadonlyArray<Readonly<QueueItem>> {
    return [...this.queue];
  }

  /**
   * Returns the in-memory ACK state for a MAX-priority alert.
   * Returns undefined for non-MAX alerts or unknown alert IDs.
   * Exposed for unit-testing acknowledgment tracking.
   */
  getMaxAlertAckState(alertId: string): AckState | undefined {
    return this.maxAlertAckMap.get(alertId);
  }
}
