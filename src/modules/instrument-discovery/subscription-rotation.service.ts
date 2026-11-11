/**
 * subscription-rotation.service.ts
 *
 * SubscriptionRotationService — manages the Dhan WebSocket subscription quota
 * and rotates instruments in/out of the active feed based on liquidity scores.
 *
 * Responsibilities:
 *  1. Every 5 minutes during NSE market hours (09:15–15:30 IST, weekdays),
 *     fetch the active universe and invoke checkAndRotateSubscriptions().
 *  2. When active subscriptions reach the configured upper threshold (default
 *     90% of DHAN_WS_MAX_SUBSCRIPTIONS), drop the lowest-scored instruments
 *     from the feed until the count falls below the lower threshold (default
 *     80% of the limit).
 *  3. Remove instruments whose liquidity score falls below MIN_LIQUIDITY_SCORE
 *     from the active universe (isActive = false, isTradable = false) and
 *     unsubscribe their market data feeds.
 *
 * Configuration (all sourced from ConfigService):
 *  - DHAN_WS_MAX_SUBSCRIPTIONS             (default: 1000)
 *  - DHAN_WS_ROTATION_UPPER_THRESHOLD_PCT  (default: 90)
 *  - DHAN_WS_ROTATION_LOWER_THRESHOLD_PCT  (default: 80)
 *  - MIN_LIQUIDITY_SCORE                   (default: 10)
 *
 * Requirements: 4.3, 4.4, 4.5
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Instruments } from '../../database/entities/instruments.entity';
import { DhanWebSocketClient } from '../dhan/dhan-websocket.client';
import { InstrumentDiscoveryService } from './instrument-discovery.service';

// ---------------------------------------------------------------------------
// IST offset helpers
// ---------------------------------------------------------------------------

/** IST offset from UTC in minutes (UTC+5:30). */
const IST_OFFSET_MINUTES = 330;

/** NSE market open time in IST minutes-of-day (09:15). */
const MARKET_OPEN_IST_MINUTES = 9 * 60 + 15; // 555

/** NSE market close time in IST minutes-of-day (15:30). */
const MARKET_CLOSE_IST_MINUTES = 15 * 60 + 30; // 930

// ---------------------------------------------------------------------------
// SubscriptionRotationService
// ---------------------------------------------------------------------------

@Injectable()
export class SubscriptionRotationService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionRotationService.name);

  /**
   * In-memory set of securityIds that are currently subscribed to the Dhan
   * WebSocket feed.  Updated synchronously by subscribe() and unsubscribe().
   */
  private readonly subscribedSecurityIds = new Set<string>();

  // ── Config ───────────────────────────────────────────────────────────────

  /** Maximum number of simultaneous Dhan WebSocket subscriptions. */
  private readonly maxSubscriptions: number;

  /**
   * Upper rotation threshold as a percentage of maxSubscriptions.
   * When subscribedSecurityIds.size reaches this percentage, rotation begins.
   */
  private readonly upperThresholdPct: number;

  /**
   * Lower rotation target as a percentage of maxSubscriptions.
   * Rotation continues until subscribedSecurityIds.size falls below this level.
   */
  private readonly lowerThresholdPct: number;

  /**
   * Instruments whose composite liquidity score falls below this value are
   * removed from the active universe and their feeds are unsubscribed.
   */
  private readonly minLiquidityScore: number;

  constructor(
    private readonly dhanWebSocketClient: DhanWebSocketClient,
    private readonly instrumentDiscoveryService: InstrumentDiscoveryService,
    @InjectRepository(Instruments)
    private readonly instrumentsRepo: Repository<Instruments>,
    private readonly configService: ConfigService,
  ) {
    this.maxSubscriptions =
      this.configService.get<number>('DHAN_WS_MAX_SUBSCRIPTIONS', 1000) ?? 1000;
    this.upperThresholdPct =
      this.configService.get<number>('DHAN_WS_ROTATION_UPPER_THRESHOLD_PCT', 90) ?? 90;
    this.lowerThresholdPct =
      this.configService.get<number>('DHAN_WS_ROTATION_LOWER_THRESHOLD_PCT', 80) ?? 80;
    this.minLiquidityScore = this.configService.get<number>('MIN_LIQUIDITY_SCORE', 10) ?? 10;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  onModuleInit(): void {
    this.logger.log(
      `SubscriptionRotationService ready — ` +
        `maxSubs=${this.maxSubscriptions}, ` +
        `upper=${this.upperThresholdPct}%, ` +
        `lower=${this.lowerThresholdPct}%, ` +
        `minScore=${this.minLiquidityScore}`,
    );

    // Establish the Dhan WebSocket connection for the live market feed.
    // The client uses exponential backoff reconnection automatically.
    void this.dhanWebSocketClient.connect().catch((err) => {
      this.logger.error(
        `SubscriptionRotation: failed to initiate WebSocket connection: ${(err as Error).message}`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Cron — every 5 minutes (Requirement 4.4)
  // -------------------------------------------------------------------------

  /**
   * Refresh liquidity rankings and check/rotate subscriptions.
   *
   * Fires every 5 minutes but is a no-op outside NSE market hours
   * (09:15–15:30 IST, Monday–Friday).
   *
   * Requirements: 4.3, 4.4, 4.5
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async updateLiquidityRankings(): Promise<void> {
    if (!this.isMarketHours()) {
      return;
    }

    this.logger.log('SubscriptionRotation: refreshing liquidity rankings');

    const instruments = await this.instrumentDiscoveryService.getActiveUniverse();

    this.checkAndRotateSubscriptions(instruments);

    this.logger.log(
      `SubscriptionRotation: ranking update complete — ` +
        `${instruments.length} active instruments, ` +
        `${this.subscribedSecurityIds.size} live subscriptions`,
    );
  }

  // -------------------------------------------------------------------------
  // Rotation logic (Requirement 4.5)
  // -------------------------------------------------------------------------

  /**
   * Evaluate the current subscription quota and instrument quality, then:
   *
   *  Step 1 — Quota rotation:
   *   If subscribedSecurityIds.size >= upperThreshold, sort all subscribed
   *   instruments by ascending liquidity score and unsubscribe the lowest-
   *   scored ones until the count falls strictly below lowerThreshold.
   *
   *  Step 2 — Below-minimum quality removal:
   *   For every instrument whose liquidityScore < minLiquidityScore, mark it
   *   as inactive and non-tradable in the database (fire-and-forget save) and
   *   unsubscribe its feed if currently subscribed.
   *
   * @param instruments  The current active trading universe, as returned by
   *                     InstrumentDiscoveryService.getActiveUniverse().
   *
   * Requirements: 4.3, 4.5
   */
  checkAndRotateSubscriptions(instruments: Instruments[]): void {
    const upperThreshold = Math.floor((this.maxSubscriptions * this.upperThresholdPct) / 100);
    const lowerThreshold = Math.floor((this.maxSubscriptions * this.lowerThresholdPct) / 100);

    // ── Step 1: Quota rotation ────────────────────────────────────────────
    const currentCount = this.subscribedSecurityIds.size;

    if (currentCount >= upperThreshold) {
      this.logger.warn(
        `SubscriptionRotation: ${currentCount} subscriptions reached upper ` +
          `threshold ${upperThreshold} (${this.upperThresholdPct}% of ` +
          `${this.maxSubscriptions}). Rotating to below ${lowerThreshold}.`,
      );

      // Collect subscribed instruments (with score info) sorted ascending.
      // Instruments not present in the passed array keep their slot — rotation
      // only acts on the known active universe.
      const subscribedSorted = instruments
        .filter((inst) => this.subscribedSecurityIds.has(inst.securityId))
        .sort((a, b) => parseFloat(a.liquidityScore ?? '0') - parseFloat(b.liquidityScore ?? '0'));

      for (const instrument of subscribedSorted) {
        if (this.subscribedSecurityIds.size < lowerThreshold) {
          break;
        }
        this.unsubscribe(instrument.securityId);
        this.logger.debug(
          `SubscriptionRotation: rotated out ${instrument.securityId} ` +
            `(${instrument.tradingSymbol}, score=${instrument.liquidityScore})`,
        );
      }

      this.logger.log(
        `SubscriptionRotation: rotation complete — ` +
          `${this.subscribedSecurityIds.size} subscriptions remain.`,
      );
    }

    // ── Step 2: Remove instruments below minimum liquidity score ─────────
    const belowMin = instruments.filter(
      (inst) => parseFloat(inst.liquidityScore ?? '0') < this.minLiquidityScore,
    );

    for (const instrument of belowMin) {
      this.logger.log(
        `SubscriptionRotation: deactivating ${instrument.securityId} ` +
          `(${instrument.tradingSymbol}) — ` +
          `score=${instrument.liquidityScore} < minScore=${this.minLiquidityScore}`,
      );

      // Persist the deactivation (fire-and-forget; any error is logged).
      instrument.isActive = false;
      instrument.isTradable = false;
      void this.instrumentsRepo
        .save(instrument)
        .catch((err: Error) =>
          this.logger.error(
            `Failed to persist deactivation for instrument ` +
              `${instrument.securityId}: ${err.message}`,
          ),
        );

      // Unsubscribe the feed if currently active.
      if (this.subscribedSecurityIds.has(instrument.securityId)) {
        this.unsubscribe(instrument.securityId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public feed management
  // -------------------------------------------------------------------------

  /**
   * Subscribe to live tick data for a single instrument.
   *
   * Adds the securityId to the in-memory subscription set and sends the
   * Dhan WebSocket subscription message.
   *
   * @param instrument  The instrument to subscribe; uses securityId and segment.
   *
   * Requirement 4.4
   */
  subscribe(instrument: Instruments): void {
    this.dhanWebSocketClient.subscribe([parseInt(instrument.securityId, 10)], instrument.segment);
    this.subscribedSecurityIds.add(instrument.securityId);
    this.logger.debug(
      `SubscriptionRotation: subscribed ${instrument.securityId} ` +
        `(${instrument.tradingSymbol}) — ` +
        `total subscriptions: ${this.subscribedSecurityIds.size}`,
    );
  }

  /**
   * Unsubscribe from live tick data for a single instrument.
   *
   * Removes the securityId from the in-memory subscription set and sends the
   * Dhan WebSocket unsubscription message.
   *
   * @param securityId  The Dhan security ID to unsubscribe.
   *
   * Requirement 4.3, 4.5
   */
  unsubscribe(securityId: string): void {
    this.dhanWebSocketClient.unsubscribe([parseInt(securityId, 10)]);
    this.subscribedSecurityIds.delete(securityId);
    this.logger.debug(
      `SubscriptionRotation: unsubscribed ${securityId} — ` +
        `total subscriptions: ${this.subscribedSecurityIds.size}`,
    );
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  /**
   * Return the current number of active WebSocket subscriptions.
   * Useful for health-check endpoints and tests.
   */
  getSubscribedCount(): number {
    return this.subscribedSecurityIds.size;
  }

  // -------------------------------------------------------------------------
  // Private — market hours
  // -------------------------------------------------------------------------

  /**
   * Return true if the current wall-clock time falls within NSE market hours:
   * 09:15 IST to 15:30 IST, Monday–Friday.
   *
   * IST = UTC+5:30.
   *
   * Requirement 4.4
   */
  private isMarketHours(): boolean {
    const now = new Date();

    // Compute minutes-of-day in IST.
    const utcMod = now.getUTCHours() * 60 + now.getUTCMinutes();
    const istMod = (utcMod + IST_OFFSET_MINUTES) % (24 * 60);

    // Derive IST day-of-week (0=Sunday … 6=Saturday).
    const istDayOfWeek = this.getIstDayOfWeek(now);

    // Weekdays only (Monday=1 … Friday=5).
    if (istDayOfWeek < 1 || istDayOfWeek > 5) {
      return false;
    }

    return istMod >= MARKET_OPEN_IST_MINUTES && istMod <= MARKET_CLOSE_IST_MINUTES;
  }

  /**
   * Return the day-of-week (0=Sunday … 6=Saturday) in IST for a given Date.
   */
  private getIstDayOfWeek(date: Date): number {
    const istMs = date.getTime() + IST_OFFSET_MINUTES * 60 * 1000;
    return new Date(istMs).getUTCDay();
  }
}
