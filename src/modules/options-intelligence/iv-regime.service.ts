/**
 * iv-regime.service.ts
 *
 * IvRegimeService — task 11.3
 *
 * Tracks the implied-volatility regime for each underlying on a per-symbol
 * basis and classifies it as EXPANDING, CONTRACTING, or NEUTRAL relative to a
 * rolling baseline average.
 *
 * Classification rules (Requirement 7.3):
 *   current_iv > baseline_avg + threshold_pp  →  EXPANDING
 *   current_iv < baseline_avg - threshold_pp  →  CONTRACTING
 *   otherwise                                 →  NEUTRAL
 *
 * Conservative default: NEUTRAL when fewer than 2 observations exist for the
 * underlying (not enough data to compute a meaningful baseline).
 *
 * All weight factors (for contract selection and R:R estimation) are
 * independently configurable per regime via environment variables.
 *
 * Configuration (all resolved via ConfigService at construction time):
 *   IV_REGIME_THRESHOLD_PP              — pp deviation threshold  (default: 5.0, range: 1–50)
 *   IV_REGIME_WINDOW_SIZE               — rolling window length   (default: 20)
 *   IV_REGIME_EXPANDING_CONTRACT_WEIGHT — contract weight EXPANDING (default: 1.2)
 *   IV_REGIME_CONTRACTING_CONTRACT_WEIGHT — contract weight CONTRACTING (default: 0.8)
 *   IV_REGIME_NEUTRAL_CONTRACT_WEIGHT   — contract weight NEUTRAL   (default: 1.0)
 *   IV_REGIME_EXPANDING_RR_WEIGHT       — R:R weight EXPANDING     (default: 1.1)
 *   IV_REGIME_CONTRACTING_RR_WEIGHT     — R:R weight CONTRACTING   (default: 0.9)
 *   IV_REGIME_NEUTRAL_RR_WEIGHT         — R:R weight NEUTRAL       (default: 1.0)
 *
 * Requirements: 7.3
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Implied-volatility regime for an underlying at a point in time.
 *
 *  - EXPANDING   : current IV is meaningfully above the rolling baseline
 *  - CONTRACTING : current IV is meaningfully below the rolling baseline
 *  - NEUTRAL     : current IV is within the ±threshold_pp band, or there is
 *                  insufficient history to make a determination
 */
export type IvRegime = 'EXPANDING' | 'CONTRACTING' | 'NEUTRAL';

/**
 * Independently-configurable multipliers applied downstream by contract
 * selection scoring and R:R estimation modules.
 *
 * Each weight is a dimensionless multiplier (>0) that scales the relevant
 * downstream score component.  Values > 1.0 amplify; values < 1.0 dampen.
 */
export interface IvRegimeWeights {
  /** Multiplier applied to the contract selection score component. */
  contractSelectionWeight: number;
  /** Multiplier applied to the R:R estimation component. */
  rrEstimationWeight: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults (exported for testability)
// ─────────────────────────────────────────────────────────────────────────────

/** Default percentage-point deviation threshold (1–50). */
export const DEFAULT_THRESHOLD_PP = 5.0;

/** Default rolling window length used to compute the baseline average. */
export const DEFAULT_WINDOW_SIZE = 20;

/** Default contract-selection weight for EXPANDING regime. */
export const DEFAULT_EXPANDING_CONTRACT_WEIGHT = 1.2;

/** Default contract-selection weight for CONTRACTING regime. */
export const DEFAULT_CONTRACTING_CONTRACT_WEIGHT = 0.8;

/** Default contract-selection weight for NEUTRAL regime. */
export const DEFAULT_NEUTRAL_CONTRACT_WEIGHT = 1.0;

/** Default R:R estimation weight for EXPANDING regime. */
export const DEFAULT_EXPANDING_RR_WEIGHT = 1.1;

/** Default R:R estimation weight for CONTRACTING regime. */
export const DEFAULT_CONTRACTING_RR_WEIGHT = 0.9;

/** Default R:R estimation weight for NEUTRAL regime. */
export const DEFAULT_NEUTRAL_RR_WEIGHT = 1.0;

/** Minimum number of observations required before a baseline is available. */
export const MIN_OBSERVATIONS_FOR_BASELINE = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class IvRegimeService {
  /**
   * Per-underlying rolling IV history.
   *
   * Key   : underlying symbol (e.g. "NIFTY", "BANKNIFTY").
   * Value : circular buffer of the last `windowSize` IV observations (newest
   *         appended to the end).
   */
  private readonly ivHistory: Map<string, number[]> = new Map();

  // ── Resolved config ────────────────────────────────────────────────────────
  /** pp threshold read from IV_REGIME_THRESHOLD_PP. */
  private readonly thresholdPp: number;
  /** Rolling window size read from IV_REGIME_WINDOW_SIZE. */
  private readonly windowSize: number;

  // Per-regime weights
  private readonly expandingContractWeight: number;
  private readonly contractingContractWeight: number;
  private readonly neutralContractWeight: number;
  private readonly expandingRrWeight: number;
  private readonly contractingRrWeight: number;
  private readonly neutralRrWeight: number;

  constructor(private readonly configService: ConfigService) {
    this.thresholdPp = configService.get<number>('IV_REGIME_THRESHOLD_PP', DEFAULT_THRESHOLD_PP);
    this.windowSize = configService.get<number>('IV_REGIME_WINDOW_SIZE', DEFAULT_WINDOW_SIZE);
    this.expandingContractWeight = configService.get<number>(
      'IV_REGIME_EXPANDING_CONTRACT_WEIGHT',
      DEFAULT_EXPANDING_CONTRACT_WEIGHT,
    );
    this.contractingContractWeight = configService.get<number>(
      'IV_REGIME_CONTRACTING_CONTRACT_WEIGHT',
      DEFAULT_CONTRACTING_CONTRACT_WEIGHT,
    );
    this.neutralContractWeight = configService.get<number>(
      'IV_REGIME_NEUTRAL_CONTRACT_WEIGHT',
      DEFAULT_NEUTRAL_CONTRACT_WEIGHT,
    );
    this.expandingRrWeight = configService.get<number>(
      'IV_REGIME_EXPANDING_RR_WEIGHT',
      DEFAULT_EXPANDING_RR_WEIGHT,
    );
    this.contractingRrWeight = configService.get<number>(
      'IV_REGIME_CONTRACTING_RR_WEIGHT',
      DEFAULT_CONTRACTING_RR_WEIGHT,
    );
    this.neutralRrWeight = configService.get<number>(
      'IV_REGIME_NEUTRAL_RR_WEIGHT',
      DEFAULT_NEUTRAL_RR_WEIGHT,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Classifies the IV regime for `underlying` given `currentIv`.
   *
   * The classification compares `currentIv` against the rolling baseline
   * average of historical observations already in the buffer (i.e. it does
   * NOT add `currentIv` to the history — that must be done separately via
   * `updateIvHistory`).
   *
   * Returns `NEUTRAL` conservatively when fewer than
   * `MIN_OBSERVATIONS_FOR_BASELINE` (2) observations are available for the
   * underlying, because a single-point "average" would be meaningless.
   *
   * @param underlying  Symbol of the underlying (e.g. "NIFTY").
   * @param currentIv   Latest IV value (percentage points, e.g. 18.5).
   * @returns           One of EXPANDING, CONTRACTING, or NEUTRAL.
   *
   * Requirements: 7.3
   */
  classifyIvRegime(underlying: string, currentIv: number): IvRegime {
    const baselineAvg = this.getBaselineAvg(underlying);

    // Conservative default: not enough history to classify.
    if (baselineAvg === null) {
      return 'NEUTRAL';
    }

    if (currentIv > baselineAvg + this.thresholdPp) {
      return 'EXPANDING';
    }
    if (currentIv < baselineAvg - this.thresholdPp) {
      return 'CONTRACTING';
    }
    return 'NEUTRAL';
  }

  /**
   * Returns the current rolling baseline average IV for `underlying`.
   *
   * The baseline is the arithmetic mean of the last `windowSize` IV
   * observations.  Returns `null` when fewer than
   * `MIN_OBSERVATIONS_FOR_BASELINE` observations are present, signalling
   * that the baseline is not yet meaningful.
   *
   * @param underlying  Symbol of the underlying.
   * @returns           Baseline average, or `null` if insufficient history.
   *
   * Requirements: 7.3
   */
  getBaselineAvg(underlying: string): number | null {
    const history = this.ivHistory.get(underlying);

    if (!history || history.length < MIN_OBSERVATIONS_FOR_BASELINE) {
      return null;
    }

    const sum = history.reduce((acc, iv) => acc + iv, 0);
    return sum / history.length;
  }

  /**
   * Appends `currentIv` to the rolling history buffer for `underlying`.
   *
   * Once the buffer reaches `windowSize` entries, the oldest entry is
   * discarded (sliding window) so the buffer never exceeds `windowSize`.
   *
   * @param underlying  Symbol of the underlying.
   * @param currentIv   Latest IV observation to record.
   *
   * Requirements: 7.3
   */
  updateIvHistory(underlying: string, currentIv: number): void {
    if (!this.ivHistory.has(underlying)) {
      this.ivHistory.set(underlying, []);
    }

    const history = this.ivHistory.get(underlying)!;
    history.push(currentIv);

    // Keep the buffer bounded to the configured rolling window size.
    if (history.length > this.windowSize) {
      history.shift();
    }
  }

  /**
   * Returns the independently-configurable weight factors for `regime`.
   *
   * Each regime has its own contract-selection multiplier and R:R estimation
   * multiplier.  Both are resolved from environment configuration at service
   * construction so they can be tuned without code changes.
   *
   * @param regime  The IV regime whose weights are requested.
   * @returns       `IvRegimeWeights` containing the two multipliers.
   *
   * Requirements: 7.3
   */
  getWeights(regime: IvRegime): IvRegimeWeights {
    switch (regime) {
      case 'EXPANDING':
        return {
          contractSelectionWeight: this.expandingContractWeight,
          rrEstimationWeight: this.expandingRrWeight,
        };
      case 'CONTRACTING':
        return {
          contractSelectionWeight: this.contractingContractWeight,
          rrEstimationWeight: this.contractingRrWeight,
        };
      case 'NEUTRAL':
      default:
        return {
          contractSelectionWeight: this.neutralContractWeight,
          rrEstimationWeight: this.neutralRrWeight,
        };
    }
  }
}
