/**
 * sniper-entry.service.ts
 *
 * SniperEntryService — evaluates whether current market conditions justify
 * a high-conviction entry for a given instrument snapshot.
 *
 * MoneyPrinter trading philosophy:
 *   "Wait for high-quality setups. Enter precisely. Trade only liquid contracts."
 *
 * The sniper engine runs BEFORE the strategy pipeline and applies orthogonal
 * pre-qualification filters. A signal can only proceed to strategy evaluation
 * if SniperEntryService.evaluate() returns `eligible: true`.
 *
 * Filters evaluated (all must pass):
 *   1. Minimum LTP                 — reject zero/near-zero premium contracts
 *   2. Maximum spread ratio        — bid/ask spread as fraction of LTP
 *   3. Minimum relative volume     — current vol vs estimated average vol
 *   4. Volume acceleration         — vol growing vs prior period
 *   5. Momentum alignment          — price above/below key VWAP level
 *   6. Market data freshness       — snapshot not stale
 *   7. Minimum bid/ask depth       — market depth present
 *   8. IV sanity                   — IV not extreme (>200% or <1%)
 *
 * All thresholds are environment-configurable.
 *
 * Requirements: Phase 6 — Sniper Entry and Scalping Engine
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketSnapshot } from '../market-data/market-data.types';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MIN_LTP = 5; // ₹5 minimum premium
const DEFAULT_MAX_SPREAD_RATIO = 0.08; // 8% of LTP
const DEFAULT_MIN_RELATIVE_VOLUME = 0.8; // 80% of average volume
const DEFAULT_MIN_BID_DEPTH = 10; // 10 contracts at best bid
const DEFAULT_MIN_ASK_DEPTH = 10; // 10 contracts at best ask
const DEFAULT_MAX_DATA_AGE_MS = 10_000; // 10 seconds
const DEFAULT_MIN_VOLUME_FOR_ACCELERATION = 1000;
const DEFAULT_MAX_IV = 200; // 200% IV ceiling
const DEFAULT_MIN_IV = 1; // 1% IV floor

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SniperEligibilityResult {
  /** True when ALL configured filters pass. */
  eligible: boolean;
  /** Score 0–100 representing the quality of this setup (higher = better). */
  qualityScore: number;
  /** Names of filters that FAILED. Empty when eligible. */
  failingFilters: string[];
  /** Human-readable explanation of the most important failure, if any. */
  primaryFailureReason?: string;
}

export interface SniperContext {
  /** Current market snapshot from Redis. */
  snapshot: MarketSnapshot;
  /** Snapshot timestamp (ms). Used for freshness check. */
  snapshotAgeMs?: number;
  /** Estimated average daily volume for context. 0 if unknown. */
  avgDailyVolume?: number;
  /** Previous period volume (prior 2-min candle). 0 if unknown. */
  priorVolume?: number;
  /** Direction of the signal ('BUY' or 'SELL'). */
  direction: 'BUY' | 'SELL';
  /** Current VWAP of the underlying (optional, enables momentum filter). */
  underlyingVwap?: number;
  /** Current price of the underlying (optional, enables momentum filter). */
  underlyingLtp?: number;
  /** Current implied volatility in % (optional, enables IV filter). */
  impliedVolatility?: number;
  /** Best bid quantity from option chain (optional depth check). */
  bidQty?: number;
  /** Best ask quantity from option chain (optional depth check). */
  askQty?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SniperEntryService {
  private readonly logger = new Logger(SniperEntryService.name);

  readonly minLtp: number;
  readonly maxSpreadRatio: number;
  readonly minRelativeVolume: number;
  readonly minBidDepth: number;
  readonly minAskDepth: number;
  readonly maxDataAgeMs: number;
  readonly minVolumeForAcceleration: number;
  readonly maxIv: number;
  readonly minIv: number;

  constructor(private readonly configService: ConfigService) {
    this.minLtp = configService.get('SNIPER_MIN_LTP', DEFAULT_MIN_LTP);
    this.maxSpreadRatio = configService.get('SNIPER_MAX_SPREAD_RATIO', DEFAULT_MAX_SPREAD_RATIO);
    this.minRelativeVolume = configService.get(
      'SNIPER_MIN_RELATIVE_VOLUME',
      DEFAULT_MIN_RELATIVE_VOLUME,
    );
    this.minBidDepth = configService.get('SNIPER_MIN_BID_DEPTH', DEFAULT_MIN_BID_DEPTH);
    this.minAskDepth = configService.get('SNIPER_MIN_ASK_DEPTH', DEFAULT_MIN_ASK_DEPTH);
    this.maxDataAgeMs = configService.get('SNIPER_MAX_DATA_AGE_MS', DEFAULT_MAX_DATA_AGE_MS);
    this.minVolumeForAcceleration = configService.get(
      'SNIPER_MIN_VOLUME_ACCELERATION',
      DEFAULT_MIN_VOLUME_FOR_ACCELERATION,
    );
    this.maxIv = configService.get('SNIPER_MAX_IV', DEFAULT_MAX_IV);
    this.minIv = configService.get('SNIPER_MIN_IV', DEFAULT_MIN_IV);
  }

  /**
   * Evaluate whether market conditions are suitable for a high-conviction entry.
   *
   * @param context  Market data and direction context.
   * @returns        SniperEligibilityResult with eligible flag and quality score.
   */
  evaluate(context: SniperContext): SniperEligibilityResult {
    const failingFilters: string[] = [];
    let qualityPoints = 0;
    const maxPoints = 100;

    const { snapshot, direction } = context;
    const ltp = parseFloat(snapshot.ltp ?? '0');
    const bidPrice = parseFloat(snapshot.bidPrice ?? '0');
    const askPrice = parseFloat(snapshot.askPrice ?? '0');
    const bidQty = context.bidQty ?? 0;
    const askQty = context.askQty ?? 0;
    const volume = parseFloat(snapshot.volume ?? '0');

    // ── Filter 1: Minimum LTP ─────────────────────────────────────────────────
    if (ltp < this.minLtp) {
      failingFilters.push('min_ltp');
    } else {
      // Higher premium = more points (capped at 15 pts)
      qualityPoints += Math.min(15, Math.floor((ltp / 50) * 15));
    }

    // ── Filter 2: Spread ratio ────────────────────────────────────────────────
    if (ltp > 0 && bidPrice > 0 && askPrice > 0) {
      const spread = askPrice - bidPrice;
      const spreadRatio = spread / ltp;
      if (spreadRatio > this.maxSpreadRatio) {
        failingFilters.push('spread_too_wide');
      } else {
        // Tight spread = more points
        const spreadScore = Math.round((1 - spreadRatio / this.maxSpreadRatio) * 20);
        qualityPoints += spreadScore;
      }
    }

    // ── Filter 3: Market depth ────────────────────────────────────────────────
    if (direction === 'BUY' && askQty < this.minAskDepth) {
      failingFilters.push('insufficient_ask_depth');
    } else if (direction === 'SELL' && bidQty < this.minBidDepth) {
      failingFilters.push('insufficient_bid_depth');
    } else {
      const relevantQty = direction === 'BUY' ? askQty : bidQty;
      qualityPoints += Math.min(15, Math.floor((relevantQty / 100) * 15));
    }

    // ── Filter 4: Data freshness ──────────────────────────────────────────────
    if (context.snapshotAgeMs !== undefined && context.snapshotAgeMs > this.maxDataAgeMs) {
      failingFilters.push('stale_data');
    } else if (context.snapshotAgeMs !== undefined) {
      // Fresher = more points
      const freshnessScore = Math.round((1 - context.snapshotAgeMs / this.maxDataAgeMs) * 10);
      qualityPoints += Math.max(0, freshnessScore);
    }

    // ── Filter 5: Relative volume ─────────────────────────────────────────────
    if (context.avgDailyVolume && context.avgDailyVolume > 0) {
      const relVol = volume / context.avgDailyVolume;
      if (relVol < this.minRelativeVolume) {
        failingFilters.push('low_relative_volume');
      } else {
        // Higher volume = more points (capped at 20 pts)
        qualityPoints += Math.min(20, Math.floor(relVol * 10));
      }
    }

    // ── Filter 6: Volume acceleration ────────────────────────────────────────
    if (context.priorVolume !== undefined && volume > this.minVolumeForAcceleration) {
      if (volume > context.priorVolume * 1.2) {
        // Volume accelerating — bonus points
        qualityPoints += 10;
      } else if (volume < context.priorVolume * 0.5) {
        // Volume decelerating — penalty (not a hard filter)
        qualityPoints -= 5;
      }
    }

    // ── Filter 7: Momentum / VWAP alignment (optional) ───────────────────────
    if (context.underlyingVwap && context.underlyingLtp) {
      const vwapBias = context.underlyingLtp > context.underlyingVwap ? 'BULL' : 'BEAR';
      const aligned =
        (direction === 'BUY' && vwapBias === 'BULL') ||
        (direction === 'SELL' && vwapBias === 'BEAR');
      if (aligned) {
        qualityPoints += 15;
      } else {
        // Against VWAP — reduce quality but don't hard-reject
        qualityPoints -= 10;
      }
    }

    // ── Filter 8: IV sanity ───────────────────────────────────────────────────
    if (context.impliedVolatility !== undefined) {
      if (context.impliedVolatility > this.maxIv || context.impliedVolatility < this.minIv) {
        failingFilters.push('extreme_iv');
      } else {
        // IV in reasonable range — small quality bonus
        qualityPoints += 5;
      }
    }

    // ── Normalize quality score ───────────────────────────────────────────────
    const normalizedScore = Math.max(
      0,
      Math.min(100, Math.round((qualityPoints / maxPoints) * 100)),
    );

    const eligible = failingFilters.length === 0;
    const primaryFailureReason =
      failingFilters.length > 0 ? `Sniper filter failed: ${failingFilters[0]}` : undefined;

    if (!eligible) {
      this.logger.debug(
        `[Sniper] Ineligible — filters failed: ${failingFilters.join(', ')} ` +
          `(LTP=${ltp.toFixed(2)}, vol=${volume})`,
      );
    }

    return { eligible, qualityScore: normalizedScore, failingFilters, primaryFailureReason };
  }

  /**
   * Compute an Active Opportunity Score for ranking multiple instruments.
   *
   * Factors:
   *   - Signal quality score (from evaluate())
   *   - Relative volume
   *   - Spread tightness
   *   - Market depth
   *
   * Returns a score 0–100. Higher is better.
   */
  computeOpportunityScore(context: SniperContext): number {
    const result = this.evaluate(context);
    if (!result.eligible) return 0;

    // Weight quality components for opportunity ranking:
    // 60% quality score + 20% volume relative + 20% depth
    const { snapshot } = context;
    const volume = parseFloat(snapshot.volume ?? '0');
    const bidQty = context.bidQty ?? 0;
    const askQty = context.askQty ?? 0;

    const volumeScore =
      context.avgDailyVolume && context.avgDailyVolume > 0
        ? Math.min(100, (volume / context.avgDailyVolume) * 50)
        : 50;

    const depthScore = Math.min(100, ((bidQty + askQty) / 200) * 100);

    return Math.round(result.qualityScore * 0.6 + volumeScore * 0.2 + depthScore * 0.2);
  }
}
