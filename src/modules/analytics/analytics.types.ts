/**
 * Shared types for the AnalyticsModule.
 *
 * Requirements: 14.1, 14.2
 */

/** Execution engine selector — drives which database table is queried. */
export type Engine = 'LIVE' | 'PAPER';

/** Pre-defined time windows available for performance analysis. */
export type TimeWindow = 'SESSION' | 'LAST_30_DAYS' | 'ALL_TIME';

/**
 * Sentinel string displayed instead of a numeric ratio when the trade sample
 * is too small for statistical reliability (< 30 trades).
 *
 * Requirement 14.2 — ratio-based metrics must be suppressed below this threshold.
 */
export const INSUFFICIENT_DATA = 'insufficient data — fewer than 30 trades' as const;

export type InsufficientData = typeof INSUFFICIENT_DATA;

// ── Trade Quality Forensics types (Requirement 20.3, 20.4) ──────────────────

/**
 * How a trade exit is classified relative to the Maximum Favorable Excursion
 * (MFE) achieved during the trade.
 *
 * - `premature`              — QCR < 0.70: trade was exited before capturing
 *                               70 % of the available MFE profit.
 * - `near-optimal`           — QCR ≥ 0.70 and exit occurred at or before the
 *                               time the MFE was reached.
 * - `late`                   — QCR ≥ 0.70 but the exit occurred after the MFE
 *                               time (profit had already started to decay).
 * - `no-favorable-excursion` — MFE was 0; there is no profit to compare
 *                               against, so QCR is undefined.
 *
 * Requirements: 20.3, 20.4
 */
export type ExitClassification = 'premature' | 'near-optimal' | 'late' | 'no-favorable-excursion';

/**
 * Overall execution quality rating derived from the Quality Capture Ratio
 * (QCR = actual net P&L / MFE).
 *
 * | QCR range       | Rating                   |
 * |-----------------|--------------------------|
 * | null (MFE = 0)  | 'No Favorable Excursion' |
 * | < 0.40          | 'Poor'                   |
 * | 0.40 – < 0.70   | 'Fair'                   |
 * | 0.70 – < 0.90   | 'Good'                   |
 * | ≥ 0.90          | 'Excellent'              |
 *
 * Requirements: 20.3, 20.4
 */
export type ExecutionQuality = 'Poor' | 'Fair' | 'Good' | 'Excellent' | 'No Favorable Excursion';

/**
 * Complete performance metrics for a single (engine, time-window) combination.
 *
 * Twelve performance fields plus a convenience `tradeCount`.  The four
 * ratio-based metrics (`profitFactor`, `sharpeRatio`, `sortinoRatio`,
 * `calmarRatio`) carry the `INSUFFICIENT_DATA` sentinel when fewer than 30
 * trades are present in the selected window.
 *
 * Requirements: 14.1, 14.2
 */
export interface PerformanceMetrics {
  /** Fraction of trades with positive net P&L.  0 when no trades. */
  winRate: number;

  /**
   * Gross profit ÷ |gross loss|.
   * Suppressed to `INSUFFICIENT_DATA` when tradeCount < 30.
   */
  profitFactor: number | InsufficientData;

  /** Mean net P&L per trade.  0 when no trades. */
  expectancy: number;

  /** Mean net P&L of winning trades.  0 when no winning trades. */
  avgWin: number;

  /**
   * Mean net P&L of losing trades — a negative number.
   * 0 when no losing trades.
   */
  avgLoss: number;

  /** |avgWin / avgLoss|.  0 when no losing trades. */
  rrRatio: number;

  /**
   * Maximum peak-to-trough decline in cumulative net P&L (non-negative
   * magnitude, expressed in the same currency as net_pnl).
   * 0 when no drawdown period.
   */
  maxDrawdown: number;

  /**
   * Annualised Sharpe ratio (sample std-dev, sqrt(252) annualisation).
   * Suppressed to `INSUFFICIENT_DATA` when tradeCount < 30.
   */
  sharpeRatio: number | InsufficientData;

  /**
   * Annualised Sortino ratio (downside semi-deviation, sqrt(252) annualisation).
   * Suppressed to `INSUFFICIENT_DATA` when tradeCount < 30.
   */
  sortinoRatio: number | InsufficientData;

  /**
   * Calmar ratio = annualised_return / maxDrawdown.
   * Suppressed to `INSUFFICIENT_DATA` when tradeCount < 30.
   */
  calmarRatio: number | InsufficientData;

  /** Longest consecutive streak of trades with positive net P&L. */
  maxConsecutiveWins: number;

  /** Longest consecutive streak of trades with negative net P&L. */
  maxConsecutiveLosses: number;

  /** Total number of trades in the selected window. */
  tradeCount: number;
}
