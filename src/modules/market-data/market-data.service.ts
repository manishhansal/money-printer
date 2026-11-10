/**
 * market-data.service.ts
 *
 * Feed-staleness detector for the MarketDataModule.
 *
 * Responsibilities (task 6.3):
 *  - Track the timestamp of the most recently received market data tick via
 *    the `market.tick.received` NestJS event.
 *  - Expose `isMarketDataStale()` and `getDataAge()` as synchronous helpers.
 *  - Run a cron job every 5 seconds to detect staleness / freshness transitions.
 *  - On staleness detection:
 *      a. Emit `market.data.stale` NestJS event → consumed by RiskEngine to
 *         block new order submissions (Requirement 9.6).
 *      b. Publish a WARNING alert via NotificationService:
 *         "Market data feed is stale — order submissions blocked".
 *  - On freshness restoration:
 *      a. Emit `market.data.fresh` NestJS event → consumed by RiskEngine to
 *         unblock new order submissions.
 *      b. Publish an INFO alert: "Market data feed restored".
 *
 * Configuration:
 *  - MAX_MARKET_DATA_AGE_MS — env variable (default: 5000 ms)
 *
 * Requirements: 9.6
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import { NotificationService } from '../notification/notification.service';
import {
  MARKET_DATA_FRESH_EVENT,
  MARKET_DATA_STALE_EVENT,
  MARKET_TICK_RECEIVED_EVENT,
  MarketDataFreshEvent,
  MarketDataStaleEvent,
} from './market-data.types';

/**
 * Default maximum allowed market data age in milliseconds.
 * Overridable via the `MAX_MARKET_DATA_AGE_MS` environment variable.
 */
export const DEFAULT_MAX_ALLOWED_DATA_AGE_MS = 5_000;

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  /**
   * Effective maximum data age (ms) — resolved from env on construction.
   * Exposed for testing and external inspection.
   */
  readonly maxAllowedDataAgeMs: number;

  /**
   * UTC timestamp of the most recent `market.tick.received` event.
   * Initialised to `new Date()` so the system is considered fresh on startup.
   */
  private lastTickReceivedAt: Date;

  /**
   * Tracks the staleness state from the previous cron evaluation so that
   * transition events are emitted exactly once per edge (fresh→stale or
   * stale→fresh), never on every tick of the 5-second cron.
   */
  private wasStale = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly notificationService: NotificationService,
  ) {
    this.maxAllowedDataAgeMs =
      this.configService.get<number>('MAX_MARKET_DATA_AGE_MS', DEFAULT_MAX_ALLOWED_DATA_AGE_MS) ??
      DEFAULT_MAX_ALLOWED_DATA_AGE_MS;

    // Set lastTickReceivedAt to now so the feed is considered fresh at boot.
    this.lastTickReceivedAt = new Date();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event listener — update last-tick timestamp on every incoming market tick
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Updates `lastTickReceivedAt` whenever a market tick arrives from the
   * Dhan WebSocket feed (emitted by the WebSocket client in task 6.1).
   *
   * This method is intentionally synchronous and lightweight so it never
   * blocks the event-loop during high-frequency tick ingestion.
   */
  @OnEvent(MARKET_TICK_RECEIVED_EVENT)
  onTickReceived(): void {
    this.lastTickReceivedAt = new Date();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public synchronous API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns `true` when the elapsed time since the last received tick
   * exceeds `maxAllowedDataAgeMs`.
   *
   * RiskEngine calls this method directly as a pre-order gate (Requirement 9.6).
   *
   * @returns boolean — true if stale, false if fresh.
   */
  isMarketDataStale(): boolean {
    return this.getDataAge() > this.maxAllowedDataAgeMs;
  }

  /**
   * Returns the number of milliseconds elapsed since the last received tick.
   *
   * A return value of 0 indicates a tick was received within the current
   * millisecond (extremely rare in practice).
   *
   * @returns number — age of most recent market data in milliseconds.
   */
  getDataAge(): number {
    return Date.now() - this.lastTickReceivedAt.getTime();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Staleness monitor cron job
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs every 5 seconds during market hours.
   *
   * Detects two state transitions:
   *  1. fresh → stale: emit `market.data.stale` + WARNING notification.
   *  2. stale → fresh: emit `market.data.fresh` + INFO notification.
   *
   * Only the leading edge of each transition triggers an event, preventing
   * alert storms during extended outages.
   *
   * Requirements: 9.6
   */
  @Cron(CronExpression.EVERY_5_SECONDS)
  async checkFeedStaleness(): Promise<void> {
    const currentlyStale = this.isMarketDataStale();

    if (currentlyStale && !this.wasStale) {
      await this.handleStalenessDetected();
    } else if (!currentlyStale && this.wasStale) {
      await this.handleFreshnessRestored();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private transition handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called exactly once on the fresh → stale edge.
   *
   * 1. Marks wasStale = true.
   * 2. Emits `market.data.stale` NestJS event.
   * 3. Publishes a WARNING alert via NotificationService.
   */
  private async handleStalenessDetected(): Promise<void> {
    this.wasStale = true;

    const dataAgeMs = this.getDataAge();
    const detectedAt = new Date();

    this.logger.warn(
      `Market data feed is STALE — age: ${dataAgeMs} ms, ` +
        `max allowed: ${this.maxAllowedDataAgeMs} ms. ` +
        `Notifying RiskEngine to block new order submissions.`,
    );

    const stalePayload: MarketDataStaleEvent = {
      dataAgeMs,
      maxAllowedMs: this.maxAllowedDataAgeMs,
      detectedAt,
    };

    // Notify RiskEngine (and any other subscribers) via intra-process event.
    this.eventEmitter.emit(MARKET_DATA_STALE_EVENT, stalePayload);

    // Deliver a WARNING alert to the Chrome Extension via NotificationService.
    try {
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'WARNING',
        title: 'Market data feed is stale — order submissions blocked',
        message:
          `Market data feed has not received a tick for ${dataAgeMs} ms ` +
          `(max allowed: ${this.maxAllowedDataAgeMs} ms). ` +
          `New order submissions are blocked until fresh data is confirmed.`,
        metadata: {
          dataAgeMs,
          maxAllowedMs: this.maxAllowedDataAgeMs,
          detectedAt: detectedAt.toISOString(),
        },
        createdAt: detectedAt,
      });
    } catch (err) {
      this.logger.error(`Failed to publish staleness alert: ${(err as Error).message}`);
    }
  }

  /**
   * Called exactly once on the stale → fresh edge.
   *
   * 1. Marks wasStale = false.
   * 2. Emits `market.data.fresh` NestJS event.
   * 3. Publishes an INFO alert via NotificationService.
   */
  private async handleFreshnessRestored(): Promise<void> {
    this.wasStale = false;

    const detectedAt = new Date();

    this.logger.log('Market data feed RESTORED — order submissions unblocked.');

    const freshPayload: MarketDataFreshEvent = {
      detectedAt,
    };

    // Notify RiskEngine to unblock new order submissions.
    this.eventEmitter.emit(MARKET_DATA_FRESH_EVENT, freshPayload);

    // Deliver an INFO alert to the Chrome Extension via NotificationService.
    try {
      await this.notificationService.publish({
        id: uuidv4(),
        priority: 'INFO',
        title: 'Market data feed restored',
        message:
          'Market data feed is now receiving fresh ticks. ' + 'Order submissions are unblocked.',
        metadata: {
          detectedAt: detectedAt.toISOString(),
        },
        createdAt: detectedAt,
      });
    } catch (err) {
      this.logger.error(`Failed to publish feed-restored alert: ${(err as Error).message}`);
    }
  }
}
