/**
 * contract-selection.service.ts
 *
 * ContractSelectionService — task 11.2
 *
 * Enforces all 4 contract selection criteria simultaneously.
 * A contract is selected only when every criterion passes; failing criteria
 * are accumulated and returned regardless of how many fail, giving callers
 * full observability into why a contract was rejected.
 *
 * Selection criteria (Requirement 7.2):
 *  1. abs(delta) ∈ [minDelta, maxDelta]
 *     Both bounds must be in (0.01, 0.99). The absolute value is used so that
 *     PE puts (which carry a negative delta by convention) are evaluated on
 *     the same scale as CE calls.
 *  2. ivPercentileRank ∈ [minIvPercentile, maxIvPercentile]
 *     Pre-computed IV rank (1–100) from the IV regime tracker.
 *  3. oi ≥ minOiContracts
 *     Open interest must meet or exceed the configured whole-contract minimum.
 *  4. bidQty ≥ minDepthQty AND askQty ≥ minDepthQty
 *     Market depth quantity at both the best bid and best ask must each meet
 *     the configured minimum independently.
 *
 * Requirements: 7.2
 */

import { Injectable } from '@nestjs/common';

// ─────────────────────────────────────────────────────────────────────────────
// Input / output types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single options contract proposed for selection.
 *
 * `delta` follows standard options-theory sign conventions:
 *  - CE (call): delta ∈ (0, 1]
 *  - PE (put):  delta ∈ [-1, 0)
 *
 * The selection criteria use Math.abs(delta) so both option types are
 * evaluated against the same configured range.
 */
export interface ContractCandidate {
  /** Dhan security ID of the options contract. */
  securityId: string;
  /** Underlying instrument identifier (e.g. "NIFTY", "BANKNIFTY"). */
  underlying: string;
  /** Option type: Call (CE) or Put (PE). */
  optionType: 'CE' | 'PE';
  /** Strike price of the contract. */
  strikePrice: number;
  /** Delta from OptionsIntelligenceService; negative for PE puts. */
  delta: number;
  /** Open interest in whole contract count. */
  oi: number;
  /** Current implied volatility, e.g. 18.5 means 18.5 %. */
  impliedVolatility: number;
  /** Best bid price at the time of evaluation. */
  bidPrice: number;
  /** Best ask price at the time of evaluation. */
  askPrice: number;
  /** Quantity available at the best bid. */
  bidQty: number;
  /** Quantity available at the best ask. */
  askQty: number;
}

/**
 * Configured thresholds for all 4 selection criteria.
 *
 * Caller is responsible for providing values within the stated ranges —
 * this service does not validate the configuration itself, only applies it.
 */
export interface ContractSelectionConfig {
  /** Minimum absolute delta (exclusive of 0.01; inclusive of this value). */
  minDelta: number; // (0.01, 0.99)
  /** Maximum absolute delta (exclusive of 0.99; inclusive of this value). */
  maxDelta: number; // (0.01, 0.99)
  /** Minimum IV percentile rank (1–100, inclusive). */
  minIvPercentile: number;
  /** Maximum IV percentile rank (1–100, inclusive). */
  maxIvPercentile: number;
  /** Minimum open interest in whole contracts (inclusive). */
  minOiContracts: number;
  /** Minimum quantity required at both the best bid and best ask (inclusive). */
  minDepthQty: number;
}

/**
 * Outcome of evaluating a single contract candidate.
 *
 * `selected` is `true` only when every criterion passes.
 * `failingCriteria` lists the identifiers of every criterion that failed,
 * enabling downstream callers to log or score the rejection reason precisely.
 */
export interface ContractSelectionResult {
  /** `true` if and only if all 4 criteria passed. */
  selected: boolean;
  /**
   * Names of every criterion that failed.
   * Possible values: "delta" | "iv_rank" | "oi" | "market_depth"
   * Empty when `selected` is `true`.
   */
  failingCriteria: string[];
  /** The original candidate that was evaluated. */
  candidate: ContractCandidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Criterion identifiers (used in failingCriteria)
// ─────────────────────────────────────────────────────────────────────────────

/** Criterion identifier reported when the delta range check fails. */
export const CRITERION_DELTA = 'delta';

/** Criterion identifier reported when the IV percentile rank check fails. */
export const CRITERION_IV_RANK = 'iv_rank';

/** Criterion identifier reported when the open-interest check fails. */
export const CRITERION_OI = 'oi';

/** Criterion identifier reported when either or both depth-qty checks fail. */
export const CRITERION_MARKET_DEPTH = 'market_depth';

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ContractSelectionService {
  /**
   * Evaluates a single contract candidate against all 4 selection criteria
   * simultaneously.
   *
   * All four checks are always executed so that `failingCriteria` contains
   * the full list of failing criteria even when several fail at once. The
   * first failing check does NOT short-circuit evaluation.
   *
   * @param candidate        The contract to evaluate.
   * @param config           Configured thresholds for all 4 criteria.
   * @param ivPercentileRank Pre-computed IV rank (1–100) sourced from the
   *                         IV regime tracker for the contract's underlying.
   * @returns                Selection result with `selected` flag and full
   *                         list of any failing criterion identifiers.
   *
   * Requirements: 7.2
   */
  selectContract(
    candidate: ContractCandidate,
    config: ContractSelectionConfig,
    ivPercentileRank: number,
  ): ContractSelectionResult {
    const failingCriteria: string[] = [];

    // ── Criterion 1: abs(delta) ∈ [minDelta, maxDelta] ────────────────────
    // PE puts carry a negative delta by convention (e.g. -0.45 for a
    // 45-delta put). Taking the absolute value makes the range check uniform
    // across CE calls and PE puts without requiring separate logic.
    const absDelta = Math.abs(candidate.delta);
    if (absDelta < config.minDelta || absDelta > config.maxDelta) {
      failingCriteria.push(CRITERION_DELTA);
    }

    // ── Criterion 2: ivPercentileRank ∈ [minIvPercentile, maxIvPercentile] ─
    if (ivPercentileRank < config.minIvPercentile || ivPercentileRank > config.maxIvPercentile) {
      failingCriteria.push(CRITERION_IV_RANK);
    }

    // ── Criterion 3: oi ≥ minOiContracts ──────────────────────────────────
    if (candidate.oi < config.minOiContracts) {
      failingCriteria.push(CRITERION_OI);
    }

    // ── Criterion 4: bidQty ≥ minDepthQty AND askQty ≥ minDepthQty ────────
    // Both sides of the market must independently meet the minimum depth
    // threshold. Either side failing is enough to reject on this criterion,
    // but a single "market_depth" entry is pushed regardless of whether one
    // or both sides fall short.
    if (candidate.bidQty < config.minDepthQty || candidate.askQty < config.minDepthQty) {
      failingCriteria.push(CRITERION_MARKET_DEPTH);
    }

    return {
      selected: failingCriteria.length === 0,
      failingCriteria,
      candidate,
    };
  }
}
