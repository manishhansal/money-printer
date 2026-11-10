/**
 * Attribution breakdown types for AnalyticsService.
 *
 * Requirements: 14.3
 */

/**
 * Shared performance metrics shape used across all four attribution dimensions.
 * Intentionally lightweight: only the four fields that are always available
 * regardless of sample size (no ratio-based suppression needed here because
 * attribution rows are displayed as relative contribution tables, not standalone
 * statistical summaries).
 */
export interface AttributionMetrics {
  /** Total number of trades in this group. */
  tradeCount: number;
  /**
   * Fraction of trades in this group with positive net P&L.
   * 0 when tradeCount is 0.
   */
  winRate: number;
  /**
   * Mean net P&L per trade (arithmetic expectancy).
   * 0 when tradeCount is 0.
   */
  expectancy: number;
  /** Sum of net P&L across all trades in this group. */
  netPnl: number;
}

/** Performance metrics attributed to a single strategy (keyed by strategy code). */
export type StrategyMetrics = AttributionMetrics;

/** Performance metrics attributed to a single instrument (keyed by trading symbol). */
export type InstrumentMetrics = AttributionMetrics;

/** Performance metrics attributed to a single market regime (keyed by regime code). */
export type RegimeMetrics = AttributionMetrics;

/**
 * Performance metrics attributed to a single 60-minute IST time-of-day bucket
 * (keyed by label such as "09:15-10:15").
 */
export type TimeOfDayMetrics = AttributionMetrics;

/**
 * Full performance attribution breakdown for a given (engine, time-window) pair.
 *
 * Requirements: 14.3
 */
export interface AttributionBreakdown {
  /**
   * P&L attribution per strategy code (e.g. 'A', 'B', ..., 'H').
   * Keyed by the single-letter strategy code, not the UUID.
   */
  byStrategy: Record<string, StrategyMetrics>;

  /**
   * P&L attribution per instrument trading symbol
   * (e.g. 'NIFTY24JAN21000CE').
   */
  byInstrument: Record<string, InstrumentMetrics>;

  /**
   * P&L attribution per market regime code
   * (e.g. 'TRENDING_BULLISH', 'RANGING', ...).
   *
   * Empty object when the trades table does not carry a denormalised regime
   * column — the regime dimension is populated only when the backing entity
   * exposes a `regime` field directly on the trade record.
   */
  byRegime: Record<string, RegimeMetrics>;

  /**
   * P&L attribution per 60-minute IST time-of-day bucket.
   * Labels follow the format "HH:MM-HH:MM", starting at "09:15-10:15".
   * Buckets are open-ended on the right (09:15 ≤ entry_time_IST < 10:15).
   */
  byTimeOfDay: Record<string, TimeOfDayMetrics>;
}
