/**
 * backtest.types.ts
 *
 * Type definitions for the BacktestEngine module.
 *
 * Requirements: 15.1, 15.2, 15.4, 15.6
 */

/** One of the 8 supported strategy codes. */
export type StrategyCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

/** Engine context for which the backtest result is intended. */
export type EngineType = 'LIVE' | 'PAPER';

/**
 * Configuration for a backtest run.
 *
 * inSampleRatio must be between 0.5 and 0.9 (inclusive).  Trades whose dates
 * fall in the first (inSampleRatio × N) positions of the chronologically
 * sorted set form the in-sample window; the remainder form the strictly
 * non-overlapping out-of-sample window (Requirement 15.6).
 */
export interface BacktestConfig {
  /** Strategy under test (A–H). */
  strategyCode: StrategyCode;
  /**
   * Fraction of the trade set reserved for in-sample calibration.
   * Valid range: 0.5 – 0.9 inclusive.
   */
  inSampleRatio: number;
  /** Inclusive start of the historical window. */
  startDate: Date;
  /** Inclusive end of the historical window. */
  endDate: Date;
  /** Execution engine context for which the result is computed. */
  engine: EngineType;
}

/**
 * A single historical trade record used as backtest input.
 *
 * isDelisted being true does NOT exclude the trade from any computation —
 * the engine must include delisted instruments to avoid survivorship bias
 * (Requirement 15.1).
 */
export interface BacktestTrade {
  /** Trade close date — used for the chronological split. */
  date: Date;
  /**
   * Net P&L for this trade, with trading costs already applied.
   * Costs must follow the identical formula used by PaperEngine
   * (Requirement 15.2).
   */
  pnl: number;
  /** Entry price (used for cost verification or re-computation). */
  entry: number;
  /** Exit price (used for cost verification or re-computation). */
  exit: number;
  /** Market regime active at trade entry. */
  regime: string;
  /** Instrument symbol or identifier. */
  instrument: string;
  /** True when the instrument was delisted before or at trade close. */
  isDelisted: boolean;
}

/**
 * A 95% confidence interval for a scalar metric produced by bootstrap
 * resampling (Requirement 15.4).
 */
export interface ConfidenceInterval {
  /** Point estimate (sample statistic on the original trade set). */
  mean: number;
  /** 2.5th percentile of the bootstrap distribution. */
  lower95: number;
  /** 97.5th percentile of the bootstrap distribution. */
  upper95: number;
}

/**
 * Aggregate performance metrics for a trade set (in-sample or out-of-sample).
 */
export interface BacktestMetrics {
  /** Mean net P&L per trade. */
  expectancy: number;
  /** Fraction of trades with positive net P&L (0 – 1). */
  winRate: number;
  /**
   * Maximum peak-to-trough drawdown of the cumulative P&L curve.
   * Expressed as a positive number; 0 when there is no drawdown.
   */
  maxDrawdown: number;
  /** Number of trades in this set. */
  tradeCount: number;
}

/**
 * Complete result of a backtest run.
 *
 * Confidence intervals are computed only from the out-of-sample trade set
 * using bootstrap resampling (≥ 1,000 iterations) so that the in-sample
 * phase never influences the statistical estimates (Requirement 15.4).
 */
export interface BacktestResult {
  strategyCode: StrategyCode;
  /** Metrics computed on the in-sample (calibration) trade set. */
  inSampleMetrics: BacktestMetrics;
  /** Metrics computed on the strictly held-out out-of-sample trade set. */
  outOfSampleMetrics: BacktestMetrics;
  /** 95% bootstrap CI for expectancy (computed from out-of-sample trades). */
  expectancyCI: ConfidenceInterval;
  /** 95% bootstrap CI for win rate (computed from out-of-sample trades). */
  winRateCI: ConfidenceInterval;
  /** 95% bootstrap CI for max drawdown (computed from out-of-sample trades). */
  maxDrawdownCI: ConfidenceInterval;
}

/**
 * Breakdown of trading costs — mirrors the structure returned by
 * PaperTradingService.calculateTradingCosts() to guarantee parity
 * (Requirement 15.2).
 */
export interface TradingCosts {
  /** ₹20 flat per side × 2 sides = ₹40 total. */
  brokerage: number;
  /** STT: 0.05% of sell-side turnover. */
  stt: number;
  /** NSE exchange charges: 0.053% of total turnover. */
  exchangeCharges: number;
  /** GST: 18% of (brokerage + exchangeCharges). */
  gst: number;
  /** SEBI charges: ₹10 per crore (turnover × 0.000001). */
  sebiCharges: number;
  /** Stamp duty: 0.003% of buy-side turnover. */
  stampDuty: number;
  /** Sum of all cost components. */
  total: number;
}

// ---------------------------------------------------------------------------
// Strategy Ablation Analysis (Phase 9)
// ---------------------------------------------------------------------------

/**
 * Result for a single ablation variant — one dimension value excluded.
 */
export interface AblationVariant {
  /** Dimension being ablated (e.g. 'regime', 'instrument'). */
  dimension: 'regime' | 'instrument';
  /** The specific value excluded from this variant (e.g. 'STRONG_BULL'). */
  excluded: string;
  /** Number of trades removed by this exclusion. */
  removedCount: number;
  /** Metrics of the REMAINING trades (after exclusion). */
  remainingMetrics: BacktestMetrics;
  /**
   * Change in expectancy vs baseline (remaining.expectancy − baseline.expectancy).
   * Positive value = removing this group IMPROVED expectancy (the excluded
   * group was dragging performance down).
   * Negative value = removing this group HURT performance (they were profitable).
   */
  expectancyDelta: number;
}

/**
 * Full ablation analysis result.
 *
 * Runs the backtest once per unique regime and instrument, measuring the
 * marginal contribution of each. Callers can identify which regimes or
 * instruments to filter more aggressively in live trading.
 */
export interface AblationResult {
  strategyCode: string;
  /** Baseline metrics using all trades (no exclusions). */
  baseline: BacktestMetrics;
  /** One variant per unique regime and instrument found in the trade set. */
  variants: AblationVariant[];
  /**
   * The single variant that most improves expectancy when excluded
   * (highest positive expectancyDelta). Null when no trade set is provided.
   */
  topRemovalCandidate: AblationVariant | null;
}
