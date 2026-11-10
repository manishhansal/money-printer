/**
 * options-flow.types.ts
 *
 * Shared types for the OptionsFlowModule (task 31.2).
 *
 * Requirements: 20.6, 20.7
 */

/**
 * Aggregated options-flow metrics for a single monitored instrument.
 * Computed from the `mkt:optchain:{underlying}:{expiry}` Redis key on every
 * ≤60-second refresh cycle.
 */
export interface OptionsFlowSnapshot {
  /** Internal instrument UUID from the instruments table. */
  instrumentId: string;

  /** Human-readable exchange trading symbol, e.g. "NIFTY24JAN21000CE". */
  tradingSymbol: string;

  /**
   * Aggregate net change in open interest across ALL strikes and legs
   * since the previous option-chain snapshot.
   * Computed as Σ(oi − previous_oi) for every CE + PE leg.
   */
  netOiChange: number;

  /**
   * Put/Call open-interest ratio.
   * Computed as totalPutOI / totalCallOI.
   * Returns 0 when totalCallOI is zero to prevent division by zero.
   */
  putCallRatio: number;

  /**
   * IV skew: 25-delta put implied-volatility minus 25-delta call
   * implied-volatility.
   * A positive skew indicates higher put demand (bearish hedging pressure).
   * Returns 0 when a 25-delta leg cannot be identified.
   */
  ivSkew: number;

  /**
   * True when any single CE or PE leg has a volume greater than the
   * configured LARGE_BLOCK_VOLUME_THRESHOLD.
   * Requirement 20.6: "single-trade options activity where the contract
   * volume exceeds the system-configured large-block detection threshold".
   */
  largeBlockDetected: boolean;

  /**
   * Maximum single-leg volume observed this cycle.
   * Populated only when largeBlockDetected is true.
   */
  largeBlockVolume?: number;

  /** Wall-clock time at which these metrics were computed. */
  snapshotTime: Date;

  /**
   * True when snapshotTime is more than 60 seconds in the past.
   * Set by getDashboard() at read time; always false immediately after refresh.
   * Requirement 20.7.
   */
  isStale: boolean;
}

/**
 * Full dashboard payload returned by GET /options-flow/dashboard.
 *
 * Requirements: 20.6, 20.7
 */
export interface OptionsFlowDashboard {
  /** One entry per subscribed instrument. */
  snapshots: OptionsFlowSnapshot[];

  /** Wall-clock time at which this dashboard response was assembled. */
  generatedAt: Date;

  /**
   * True when at least one snapshot is stale (data age > 60 seconds).
   * When true, callers MUST suppress the Options/Futures Confirmation
   * score contribution until fresh data is received.
   * Requirement 20.7.
   */
  suppressOptionsFuturesScore: boolean;
}

/**
 * Internal tracking entry for a subscribed instrument.
 * Stores the Redis key components needed to fetch option-chain data.
 */
export interface InstrumentSubscription {
  instrumentId: string;
  tradingSymbol: string;
  /** NSE underlying symbol, e.g. "NIFTY", "BANKNIFTY". */
  underlying: string;
  /** Expiry date string used as the Redis key suffix, e.g. "2024-12-26". */
  expiry: string;
}
