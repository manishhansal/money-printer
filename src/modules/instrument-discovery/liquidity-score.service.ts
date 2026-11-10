/**
 * liquidity-score.service.ts
 *
 * LiquidityScoreService — computes a composite liquidity score (0–100) for an
 * NSE F&O instrument from five weighted market-data inputs.
 *
 * Score components (Requirement 4.2):
 *  1. Volume score      (25%): current session volume relative to 30-day average.
 *  2. OI score          (25%): open interest relative to a configured reference.
 *  3. Spread score      (20%): inverted bid-ask spread as a percentage of bid price.
 *  4. Depth score       (15%): sum of top-5 bid + ask depth quantities.
 *  5. Best-qty score    (15%): quantity at best bid + quantity at best ask.
 *
 * Composite formula:
 *   score = 0.25×volume + 0.25×OI + 0.20×spread + 0.15×depth + 0.15×bestQty
 *
 * The result is always in [0, 100] for any structurally valid input (Property 1).
 *
 * Requirements: 4.2
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All market-data inputs required to compute one instrument's liquidity score.
 * Nullable fields indicate values that may be unavailable (e.g. no quotes yet).
 */
export interface LiquidityScoreInput {
  /** Current session traded volume (contracts). */
  currentVolume: number;
  /** 30-day average session volume (contracts). */
  avgVolume30Day: number;
  /** Open interest (contracts). */
  openInterest: number;
  /** Best bid price; null when no active quote exists. */
  bidPrice: number | null;
  /** Best ask price; null when no active quote exists. */
  askPrice: number | null;
  /** Sum of top-5 bid-side depth quantities (contracts). */
  marketDepthBidQty5: number;
  /** Sum of top-5 ask-side depth quantities (contracts). */
  marketDepthAskQty5: number;
  /** Quantity available at the best bid; null when no quote. */
  bestBidQty: number | null;
  /** Quantity available at the best ask; null when no quote. */
  bestAskQty: number | null;
}

// ---------------------------------------------------------------------------
// Default reference constants
// ---------------------------------------------------------------------------

/** Default maximum OI reference (contracts). Instruments at or above this OI
 *  receive a full 100-point OI sub-score. */
const DEFAULT_MAX_OI_REFERENCE = 500_000;

/** Default maximum spread percentage (%). A spread ≥ this value yields 0 in
 *  the spread sub-score; a spread of 0 yields 100. */
const DEFAULT_MAX_SPREAD_PCT = 2.0;

/** Default maximum depth reference (contracts sum of top-5 bid+ask). */
const DEFAULT_MAX_DEPTH_REFERENCE = 10_000;

/** Default maximum best-quantity reference (contracts sum of best bid+ask). */
const DEFAULT_MAX_BEST_QTY_REFERENCE = 500;

// ---------------------------------------------------------------------------
// LiquidityScoreService
// ---------------------------------------------------------------------------

@Injectable()
export class LiquidityScoreService {
  /** Maximum OI reference (contracts); configurable via env. */
  private readonly maxOiReference: number;
  /** Maximum spread percentage (%); configurable via env. */
  private readonly maxSpreadPct: number;
  /** Maximum depth reference (sum top-5 bid+ask); configurable via env. */
  private readonly maxDepthReference: number;
  /** Maximum best-qty reference (sum best bid+ask); configurable via env. */
  private readonly maxBestQtyReference: number;

  constructor(private readonly configService: ConfigService) {
    this.maxOiReference =
      this.configService.get<number>('LIQUIDITY_MAX_OI_REFERENCE', DEFAULT_MAX_OI_REFERENCE) ??
      DEFAULT_MAX_OI_REFERENCE;

    this.maxSpreadPct =
      this.configService.get<number>('LIQUIDITY_MAX_SPREAD_PCT', DEFAULT_MAX_SPREAD_PCT) ??
      DEFAULT_MAX_SPREAD_PCT;

    this.maxDepthReference =
      this.configService.get<number>(
        'LIQUIDITY_MAX_DEPTH_REFERENCE',
        DEFAULT_MAX_DEPTH_REFERENCE,
      ) ?? DEFAULT_MAX_DEPTH_REFERENCE;

    this.maxBestQtyReference =
      this.configService.get<number>(
        'LIQUIDITY_MAX_BEST_QTY_REFERENCE',
        DEFAULT_MAX_BEST_QTY_REFERENCE,
      ) ?? DEFAULT_MAX_BEST_QTY_REFERENCE;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Compute the composite liquidity score for an instrument.
   *
   * The returned value is always in [0, 100].
   *
   * @param input  Market-data snapshot for a single instrument.
   * @returns      Composite liquidity score in [0, 100].
   *
   * Requirements: 4.2
   */
  computeLiquidityScore(input: LiquidityScoreInput): number {
    const volumeScore = this.computeVolumeScore(input.currentVolume, input.avgVolume30Day);
    const oiScore = this.computeOiScore(input.openInterest);
    const spreadScore = this.computeSpreadScore(input.bidPrice, input.askPrice);
    const depthScore = this.computeDepthScore(input.marketDepthBidQty5, input.marketDepthAskQty5);
    const bestQtyScore = this.computeBestQtyScore(input.bestBidQty, input.bestAskQty);

    const composite =
      0.25 * volumeScore +
      0.25 * oiScore +
      0.2 * spreadScore +
      0.15 * depthScore +
      0.15 * bestQtyScore;

    // Clamp to [0, 100] as a final safety guard against floating-point drift.
    return Math.min(100, Math.max(0, composite));
  }

  // -------------------------------------------------------------------------
  // Sub-score computations (public for testability)
  // -------------------------------------------------------------------------

  /**
   * Volume sub-score (0–100), weight 25%.
   *
   * Formula:
   *   ratio = min(currentVolume / max(avgVolume30Day, 1), 2.0)
   *   score = (ratio / 2.0) × 100
   *
   * A session volume equal to the 30-day average yields 50 points.
   * Double the average (or more) yields the maximum 100 points.
   *
   * @param currentVolume   Current session volume (≥ 0).
   * @param avgVolume30Day  30-day average session volume (≥ 0).
   * @returns               Volume sub-score in [0, 100].
   */
  computeVolumeScore(currentVolume: number, avgVolume30Day: number): number {
    const denominator = Math.max(avgVolume30Day, 1);
    const ratio = Math.min(currentVolume / denominator, 2.0);
    return (ratio / 2.0) * 100;
  }

  /**
   * Open-interest sub-score (0–100), weight 25%.
   *
   * Formula:
   *   score = min(openInterest / maxOiReference, 1.0) × 100
   *
   * @param openInterest  Current open interest (contracts, ≥ 0).
   * @returns             OI sub-score in [0, 100].
   */
  computeOiScore(openInterest: number): number {
    return Math.min(openInterest / this.maxOiReference, 1.0) * 100;
  }

  /**
   * Spread sub-score (0–100), weight 20%.
   *
   * Formula (when both prices are available and bidPrice > 0):
   *   spreadPct = (askPrice − bidPrice) / bidPrice × 100
   *   score     = max(0, 1 − spreadPct / maxSpreadPct) × 100
   *
   * Yields 0 when either price is null/zero or the spread exceeds maxSpreadPct.
   *
   * @param bidPrice  Best bid price; null if unavailable.
   * @param askPrice  Best ask price; null if unavailable.
   * @returns         Spread sub-score in [0, 100].
   */
  computeSpreadScore(bidPrice: number | null, askPrice: number | null): number {
    if (bidPrice == null || askPrice == null || bidPrice <= 0) {
      return 0;
    }
    const spreadPct = ((askPrice - bidPrice) / bidPrice) * 100;
    return Math.max(0, 1 - spreadPct / this.maxSpreadPct) * 100;
  }

  /**
   * Market-depth sub-score (0–100), weight 15%.
   *
   * Formula:
   *   totalDepth = marketDepthBidQty5 + marketDepthAskQty5
   *   score      = min(totalDepth / maxDepthReference, 1.0) × 100
   *
   * @param marketDepthBidQty5  Sum of top-5 bid depth quantities (≥ 0).
   * @param marketDepthAskQty5  Sum of top-5 ask depth quantities (≥ 0).
   * @returns                   Depth sub-score in [0, 100].
   */
  computeDepthScore(marketDepthBidQty5: number, marketDepthAskQty5: number): number {
    const total = marketDepthBidQty5 + marketDepthAskQty5;
    return Math.min(total / this.maxDepthReference, 1.0) * 100;
  }

  /**
   * Best-quantity sub-score (0–100), weight 15%.
   *
   * Formula:
   *   totalBestQty = (bestBidQty ?? 0) + (bestAskQty ?? 0)
   *   score        = min(totalBestQty / maxBestQtyReference, 1.0) × 100
   *
   * @param bestBidQty  Quantity at best bid; null treated as 0.
   * @param bestAskQty  Quantity at best ask; null treated as 0.
   * @returns           Best-qty sub-score in [0, 100].
   */
  computeBestQtyScore(bestBidQty: number | null, bestAskQty: number | null): number {
    const total = (bestBidQty ?? 0) + (bestAskQty ?? 0);
    return Math.min(total / this.maxBestQtyReference, 1.0) * 100;
  }
}
