/**
 * Type definitions for the SignalScoring module.
 *
 * Defines the 8-component scoring structure, signal input contract, and the
 * scored-signal output shape consumed by the StrategyModule and RiskEngine.
 *
 * Requirements: 8.1, 8.3, 8.5
 */

/**
 * Per-component score breakdown for a trading signal.
 * Each field represents a distinct scoring dimension with its own maximum value.
 */
export interface SignalComponentScores {
  /** Regime alignment with the strategy's compatible_regimes list (0–15 points). */
  regimeAlignment: number;
  /** Price structure quality: support/resistance, trend alignment (0–15 points). */
  priceStructure: number;
  /** Volume confirmation of the price move (0–15 points). */
  volumeConfirmation: number;
  /** Momentum indicator alignment: RSI, MACD, etc. (0–10 points). */
  momentum: number;
  /** VWAP/Trend alignment score (0–10 points). */
  vwapTrendAlignment: number;
  /** Options/Futures market confirmation: OI, PCR, futures basis (0–15 points). */
  optionsFuturesConfirmation: number;
  /** Liquidity and execution feasibility: bid-ask spread, volume depth (0–10 points). */
  liquidityExecution: number;
  /**
   * Risk:Reward quality of the proposed trade (0–10 points).
   * Forced to 0 when the signal R:R ratio falls below the strategy's minimum (Req 8.5).
   */
  rrQuality: number;
}

/**
 * Maximum allowed value for each score component.
 * The sum of all maxima equals 100 (the composite scale ceiling).
 */
export const SCORE_COMPONENT_MAX: Readonly<Record<keyof SignalComponentScores, number>> = {
  regimeAlignment: 15,
  priceStructure: 15,
  volumeConfirmation: 15,
  momentum: 10,
  vwapTrendAlignment: 10,
  optionsFuturesConfirmation: 15,
  liquidityExecution: 10,
  rrQuality: 10,
} as const;

/**
 * Minimum composite score (inclusive) required for a signal to be accepted
 * and forwarded for execution.  Signals below this threshold are rejected
 * with reason "score below threshold" (Req 8.3).
 */
export const SCORE_ACCEPTANCE_THRESHOLD = 80;

/**
 * Full input contract passed to `SignalScoringService.scoreSignal()`.
 * The caller (typically StrategyModule) supplies pre-computed component scores
 * and the R:R figures so the service can apply enforcement rules.
 */
export interface SignalInput {
  /** UUID of the strategy that generated this signal. */
  strategyId: string;
  /** UUID of the target instrument. */
  instrumentId: string;
  /** Trading engine context. */
  engine: 'LIVE' | 'PAPER';
  /** Trade direction. */
  direction: 'BUY' | 'SELL';
  /** Proposed entry price as a numeric string (INR). */
  entryPrice: string;
  /** Stop-loss price as a numeric string (INR). */
  stopLossPrice: string;
  /** Target price as a numeric string (INR). */
  targetPrice: string;
  /** Proposed position size in lots. */
  positionSize: number;
  /** Pre-computed per-component scores from the calling strategy. */
  componentScores: SignalComponentScores;
  /** Raw measured input values used to derive each component score (JSONB). */
  measuredInputs: Record<string, unknown>;
  /** Minimum R:R ratio configured for the originating strategy. */
  minRrRatio: number;
  /** Actual R:R ratio of this signal computed from entry/stop/target prices. */
  currentRrRatio: number;
  /**
   * Maximum validity duration in seconds before the signal is automatically
   * marked as "expired" (Req 8.7).  When omitted, `scoreAndPersistSignal`
   * defaults to 300 seconds (5 minutes).
   */
  maxValidityDurationSeconds?: number;
  /** Market regime active at signal-generation time (denormalised for reporting). */
  regime?: string;
}

/**
 * Output returned by `SignalScoringService.scoreSignal()`.
 * Captures the final composite score, the (possibly overridden) component
 * breakdown, and the accept/reject decision.
 */
export interface ScoredSignal {
  /** Arithmetic sum of all 8 component scores after any enforcement overrides. */
  compositeScore: number;
  /**
   * Per-component scores after enforcement.
   * `rrQuality` may be 0 even if the input had a non-zero value.
   */
  componentScores: SignalComponentScores;
  /**
   * Signal lifecycle status after scoring:
   *   'active'   — composite >= 80, signal is eligible for execution
   *   'rejected' — composite < 80, signal must not be executed
   */
  status: 'active' | 'rejected';
  /**
   * Human-readable rejection reason.
   * Present only when status is 'rejected'; `undefined` for active signals.
   */
  rejectionReason?: string;
  /** `true` when compositeScore >= 80; `false` otherwise. */
  approved: boolean;
}

/**
 * Output returned by `SignalScoringService.scoreAndPersistSignal()`.
 * Extends `ScoredSignal` with the database-assigned UUID so callers can
 * reference the persisted record (e.g. to pass `signalId` to the ExecutionService).
 *
 * Requirements: 8.2, 8.4
 */
export interface PersistedScoredSignal extends ScoredSignal {
  /**
   * The UUID primary key assigned to this signal by the `Signals` database table.
   */
  signalId: string;
}

/**
 * A single entry in the ranked signal list returned by
 * `OpportunityRankingService.rankActiveSignals()`.
 *
 * Combines the raw `Signals` DB record with the three ranking metrics and a
 * natural-language explanation of the signal's position in the ranked list.
 *
 * Requirements: 20.1
 */
export interface RankedSignal {
  /** The raw `Signals` entity from the database (with strategy relation loaded). */
  signal: import('../../database/entities/signals.entity').Signals;

  /**
   * 1-based rank position after sorting by compositeScore → expectedValue →
   * regimeAlignmentStrength (all descending).
   */
  rank: number;

  /**
   * Estimated expected value = `compositeScore * (rrRatio / (rrRatio + 1))`.
   * Set to 0 when risk is zero (entry price equals stop-loss price).
   */
  expectedValue: number;

  /**
   * Regime alignment strength on a 0–3 scale:
   *   3 — signal's stored `regime` matches the supplied `currentRegime`
   *   2 — no `currentRegime` was supplied (alignment unverifiable)
   *   1 — signal has no regime stored (signal.regime is null)
   *   0 — both are set but they do not match (mismatch)
   */
  regimeAlignmentStrength: number;

  /**
   * Human-readable explanation of the signal's ranking position, e.g.:
   * "#1: Score 92/100, EV 61.3, Regime STRONG_BULL (aligned).
   *   Strategy A, BUY NIFTY24JAN21000CE at ₹19500.00, R:R 2.0.
   *   High composite score with strong regime alignment."
   */
  explanation: string;
}
