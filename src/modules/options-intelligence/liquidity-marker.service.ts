/**
 * liquidity-marker.service.ts
 *
 * LiquidityMarkerService — task 11.6
 *
 * Marks options contracts as illiquid when their bid-ask spread exceeds the
 * configured maximum spread threshold (expressed as a percentage of the bid
 * price). When a contract is marked illiquid, the configured liquidity penalty
 * is returned so that the SignalScoringModule can apply it to the
 * Liquidity/Execution Feasibility score component.
 *
 * Configuration (via ConfigService / environment variables):
 *  - MAX_SPREAD_THRESHOLD_PCT    — maximum acceptable bid-ask spread as a
 *                                  percentage of the bid price; a spread that
 *                                  STRICTLY EXCEEDS this value triggers the
 *                                  illiquid flag (default: 2.0)
 *  - ILLIQUID_LIQUIDITY_PENALTY  — penalty points to subtract from the
 *                                  Liquidity/Execution Feasibility score
 *                                  component when the contract is illiquid
 *                                  (default: 10)
 *
 * Requirements: 7.6
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration defaults
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SPREAD_THRESHOLD_PCT_DEFAULT = 2.0;
const ILLIQUID_LIQUIDITY_PENALTY_DEFAULT = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full liquidity assessment for a single options contract.
 *
 * The `isIlliquid` flag is `true` when the spread percentage **strictly
 * exceeds** the configured `MAX_SPREAD_THRESHOLD_PCT`. A spread equal to the
 * threshold is treated as liquid. The `liquidityPenalty` is the number of
 * points to subtract from the Liquidity/Execution Feasibility score component
 * in the SignalScoringModule.
 */
export interface LiquidityAssessment {
  /** Dhan security ID of the contract assessed. */
  securityId: string;
  /** Best bid price at the time of assessment (in rupees). */
  bidPrice: number;
  /** Best ask price at the time of assessment (in rupees). */
  askPrice: number;
  /** Absolute bid-ask spread in rupees: askPrice − bidPrice. */
  spreadRupees: number;
  /**
   * Bid-ask spread expressed as a percentage of the bid price:
   * (spreadRupees / bidPrice) × 100.
   *
   * Zero when bidPrice is zero (degenerate input guard).
   */
  spreadPct: number;
  /**
   * `true` when spreadPct **strictly exceeds** MAX_SPREAD_THRESHOLD_PCT;
   * `false` at or below the threshold (exact equality is NOT illiquid).
   */
  isIlliquid: boolean;
  /**
   * Penalty points to subtract from the Liquidity/Execution Feasibility
   * score component. Equals ILLIQUID_LIQUIDITY_PENALTY when illiquid, 0
   * otherwise.
   */
  liquidityPenalty: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class LiquidityMarkerService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Performs a full liquidity assessment for a single options contract.
   *
   * The bid-ask spread percentage is computed as:
   *   spreadRupees = askPrice − bidPrice
   *   spreadPct    = (spreadRupees / bidPrice) × 100
   *
   * The contract is marked illiquid when spreadPct **strictly exceeds**
   * MAX_SPREAD_THRESHOLD_PCT (i.e. `spreadPct > threshold`, not `>=`).
   * A spread exactly equal to the threshold is therefore NOT illiquid.
   *
   * The returned `liquidityPenalty` is the value the SignalScoringModule
   * subtracts from the Liquidity/Execution Feasibility score component.
   *
   * @param securityId  Dhan security ID of the options contract.
   * @param bidPrice    Current best bid price in rupees.
   * @param askPrice    Current best ask price in rupees.
   * @returns           Full liquidity assessment including the illiquid flag
   *                    and penalty to apply to the signal score component.
   *
   * Requirements: 7.6
   */
  assessLiquidity(securityId: string, bidPrice: number, askPrice: number): LiquidityAssessment {
    const maxSpreadThresholdPct = this.configService.get<number>(
      'MAX_SPREAD_THRESHOLD_PCT',
      MAX_SPREAD_THRESHOLD_PCT_DEFAULT,
    );

    const illiquidPenalty = this.configService.get<number>(
      'ILLIQUID_LIQUIDITY_PENALTY',
      ILLIQUID_LIQUIDITY_PENALTY_DEFAULT,
    );

    const spreadRupees = askPrice - bidPrice;

    // Guard against division by zero: a zero bid price yields an undefined
    // percentage; treat it as zero spread to avoid marking valid zero-bid
    // scenarios as illiquid.
    const spreadPct = bidPrice > 0 ? (spreadRupees / bidPrice) * 100 : 0;

    // Strictly greater than — exact equality is NOT illiquid.
    const isIlliquid = spreadPct > maxSpreadThresholdPct;

    const liquidityPenalty = isIlliquid ? illiquidPenalty : 0;

    return {
      securityId,
      bidPrice,
      askPrice,
      spreadRupees,
      spreadPct,
      isIlliquid,
      liquidityPenalty,
    };
  }

  /**
   * Convenience method returning `true` when the contract's bid-ask spread
   * exceeds the configured threshold.
   *
   * Delegates to `assessLiquidity` so both methods always share the same
   * threshold comparison logic.
   *
   * @param securityId  Dhan security ID of the options contract.
   * @param bidPrice    Current best bid price in rupees.
   * @param askPrice    Current best ask price in rupees.
   * @returns           `true` if spreadPct strictly exceeds the threshold.
   *
   * Requirements: 7.6
   */
  isIlliquid(securityId: string, bidPrice: number, askPrice: number): boolean {
    return this.assessLiquidity(securityId, bidPrice, askPrice).isIlliquid;
  }
}
