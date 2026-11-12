/**
 * options-intelligence.types.ts
 *
 * Shared types and constants for the OptionsIntelligenceModule.
 *
 * References:
 *   - DhanOptionChainResponse  (dhan-api.types.ts)
 *
 * Requirements: 7.1
 */

// ─────────────────────────────────────────────────────────────────────────────
// Staleness threshold
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum allowed age (in milliseconds) for cached Greek values.
 *
 * Greek values older than this threshold are considered stale and MUST NOT be
 * used for contract selection (Requirement 7.1 — "not be older than 60 seconds").
 */
export const GREEKS_MAX_AGE_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Core Greek values record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Option Greeks for a single contract, as parsed from the Dhan option chain.
 *
 * Field sign conventions follow standard options theory:
 *  - delta:  ∈ (0, 1] for CE, ∈ [-1, 0) for PE
 *  - gamma:  ≥ 0 (always non-negative)
 *  - theta:  ≤ 0 for long positions (time decay expressed in ₹/calendar-day)
 *  - vega:   ≥ 0 (sensitivity to implied-volatility change)
 *
 * `computedAt` is the wall-clock timestamp at which these values were fetched
 * from the live option chain. Any consumer MUST check this field (or call
 * `areGreeksFresh`) before using the values for contract selection.
 *
 * Requirements: 7.1
 */
export interface GreekValues {
  /** Delta: rate of change of option price w.r.t. underlying price. */
  delta: number;
  /** Gamma: rate of change of delta w.r.t. underlying price (≥ 0). */
  gamma: number;
  /** Theta: time-decay per calendar day in ₹ (≤ 0 for long positions). */
  theta: number;
  /** Vega: sensitivity to implied-volatility change (≥ 0). */
  vega: number;
  /** Implied volatility (fractional, e.g. 0.25 = 25%). */
  iv: number;
  /** Last traded price of this option contract. */
  ltp: number;
  /** Best bid price. */
  bidPrice: number;
  /** Best ask price. */
  askPrice: number;
  /** Quantity available at best bid. */
  bidQty: number;
  /** Quantity available at best ask. */
  askQty: number;
  /** Open interest (number of outstanding contracts). */
  oi: number;
  /** Total traded volume for the day. */
  volume: number;
  /** Wall-clock time at which these Greeks were fetched. */
  computedAt: Date;
  /** Dhan security ID of the options contract this record belongs to. */
  instrumentId: string;
}
