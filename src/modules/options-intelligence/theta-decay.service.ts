/**
 * theta-decay.service.ts
 *
 * ThetaDecayService — task 11.5
 *
 * Responsibilities:
 *  - Compute Theta decay in ₹ per calendar day for open options positions.
 *  - Express the decay as a non-negative magnitude (always ≥ 0), regardless
 *    of the sign convention of the raw Greek value (which is ≤ 0 for long
 *    positions by standard options theory).
 *  - Expose the computed decay to PositionMonitoringModule as an input for
 *    exit condition evaluation.
 *
 * Public API:
 *  - computeThetaDecay(securityId, lotSize, quantity)
 *      Returns the ₹/day decay for a single position, or null if Greeks are
 *      unavailable or stale (delegated to OptionsIntelligenceService.getGreeks).
 *  - computeThetaDecayForPositions(positions)
 *      Batch variant — returns decay results for all positions whose Greeks
 *      are currently fresh; positions without cached Greeks are silently skipped.
 *
 * Staleness enforcement:
 *  Greek freshness is enforced by OptionsIntelligenceService.getGreeks(), which
 *  already rejects values older than GREEKS_MAX_AGE_MS (60 s).  This service
 *  treats a null return from getGreeks() as "Greeks unavailable" and propagates
 *  it as a null ThetaDecayResult — callers MUST check for null before using
 *  the result.
 *
 * Requirements: 7.5
 */

import { Injectable } from '@nestjs/common';
import { OptionsIntelligenceService } from './options-intelligence.service';

// ─────────────────────────────────────────────────────────────────────────────
// Result type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computed Theta decay for a single open options position.
 *
 * `thetaDecayRupees` is always a non-negative number (Requirement 7.5):
 *   thetaDecayRupees = Math.abs(greeks.theta) × lotSize × quantity
 *
 * `computedAt` is inherited from the underlying GreekValues timestamp so that
 * consumers can assess how fresh the computation is.
 */
export interface ThetaDecayResult {
  /** Dhan security ID of the options contract. */
  securityId: string;
  /**
   * Theta decay in ₹ per calendar day — always ≥ 0.
   *
   * Computed as Math.abs(greeks.theta) × lotSize × quantity, ensuring a
   * non-negative magnitude regardless of the sign of the raw Greek value.
   *
   * Requirements: 7.5
   */
  thetaDecayRupees: number;
  /** Number of units per lot for this contract. */
  lotSize: number;
  /** Number of lots held in the position. */
  quantity: number;
  /** Wall-clock timestamp from which the underlying Greeks were derived. */
  computedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ThetaDecayService {
  constructor(private readonly optionsIntelligenceService: OptionsIntelligenceService) {}

  /**
   * Computes the Theta decay in ₹/calendar-day for a single open options
   * position.
   *
   * Returns null when:
   *  - No Greeks are cached for the given securityId, OR
   *  - The cached Greeks are stale (older than GREEKS_MAX_AGE_MS = 60 s).
   *
   * When Greeks are available and fresh, `thetaDecayRupees` is always ≥ 0
   * because Math.abs() is applied to greeks.theta before multiplication
   * (Requirement 7.5).
   *
   * @param securityId  Dhan security ID of the options contract (string).
   * @param lotSize     Number of units per lot for this contract (≥ 1).
   * @param quantity    Number of lots held in the position (≥ 1).
   * @returns           ThetaDecayResult if fresh Greeks exist; null otherwise.
   *
   * Requirements: 7.5
   */
  computeThetaDecay(
    securityId: string,
    lotSize: number,
    quantity: number,
  ): ThetaDecayResult | null {
    const greeks = this.optionsIntelligenceService.getGreeks(securityId);
    if (!greeks) {
      return null;
    }

    return {
      securityId,
      // Math.abs() converts negative theta (long position convention) to a
      // non-negative magnitude, satisfying Requirement 7.5.
      thetaDecayRupees: Math.abs(greeks.theta) * lotSize * quantity,
      lotSize,
      quantity,
      computedAt: greeks.computedAt,
    };
  }

  /**
   * Batch variant of computeThetaDecay — processes multiple open positions
   * in a single call.
   *
   * Positions for which getGreeks() returns null (no cached data or stale)
   * are silently filtered out.  Consumers should treat a shorter-than-expected
   * result array as an indication that some positions lack fresh Greeks.
   *
   * @param positions  Array of position descriptors.
   * @returns          Array of ThetaDecayResult — one entry per position with
   *                   fresh Greeks; order matches the input array.
   *
   * Requirements: 7.5
   */
  computeThetaDecayForPositions(
    positions: Array<{ securityId: string; lotSize: number; quantity: number }>,
  ): ThetaDecayResult[] {
    return positions
      .map((p) => this.computeThetaDecay(p.securityId, p.lotSize, p.quantity))
      .filter((r): r is ThetaDecayResult => r !== null);
  }
}
