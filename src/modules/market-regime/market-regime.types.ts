/**
 * market-regime.types.ts
 *
 * Shared types, enums, event constants, and payload interfaces for the
 * MarketRegimeModule.
 *
 * The 10 regime codes are the authoritative enumeration used everywhere in the
 * CloudEngine.  They are persisted verbatim in the `market_regimes` table and
 * published as-is to the Redis pub/sub channel.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.7
 */

// ─────────────────────────────────────────────────────────────────────────────
// Regime enum — exactly 10 values (Requirement 5.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 10 mutually-exclusive market regimes the detector can produce.
 *
 * At any point in time the MarketRegimeDetector holds exactly one of these
 * values as the current regime.
 *
 * Requirement 5.1: classify market into exactly one of 10 regimes.
 */
export enum MarketRegime {
  /** Both NIFTY and BANKNIFTY bullish, broad breadth, elevated volume. */
  STRONG_BULL = 'STRONG_BULL',
  /** NIFTY bullish, moderate breadth, average volume. */
  WEAK_BULL = 'WEAK_BULL',
  /** Both NIFTY and BANKNIFTY bearish, weak breadth, elevated sell volume. */
  STRONG_BEAR = 'STRONG_BEAR',
  /** NIFTY bearish, weak breadth. */
  WEAK_BEAR = 'WEAK_BEAR',
  /** Both indices sideways, neutral breadth, low volume. */
  SIDEWAYS = 'SIDEWAYS',
  /**
   * India VIX exceeds the configured high-volatility threshold.
   * Applied via VIX override rule — always evaluated first.
   * Requirement 5.7.
   */
  HIGH_VOL = 'HIGH_VOL',
  /** Extremely low relative volume; market unusually quiet. */
  LOW_VOL = 'LOW_VOL',
  /** Volume surge with significant price expansion beyond ATR. */
  BREAKOUT = 'BREAKOUT',
  /** Price structure diverges from prevailing trend direction. */
  REVERSAL = 'REVERSAL',
  /** Conflicting signals; catch-all regime when no other regime matches. */
  UNSTABLE = 'UNSTABLE',
}

/**
 * All valid regime codes as a frozen array — used by tests and validators
 * to assert that classifyRegime is a total function over exactly 10 values.
 */
export const VALID_REGIMES: readonly MarketRegime[] = Object.values(MarketRegime);

// ─────────────────────────────────────────────────────────────────────────────
// Indicator inputs (Requirement 5.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Direction of a price trend for NIFTY or BANKNIFTY.
 */
export type TrendDirection = 'BULLISH' | 'BEARISH' | 'SIDEWAYS';

/**
 * All 10 indicator inputs required for a regime classification.
 *
 * Every field is mandatory for classification.  `sectorStrength` and
 * `futuresBasis` may be null when the data source is unavailable (e.g.
 * pre-market or feed gaps); the classifier degrades gracefully by ignoring
 * those inputs.
 *
 * Requirement 5.2
 */
export interface RegimeInputs {
  /** NIFTY 50 price trend direction. */
  niftyTrend: TrendDirection;

  /** BANKNIFTY price trend direction. */
  bankniftyTrend: TrendDirection;

  /**
   * Market breadth: percentage of NSE-listed stocks advancing (0–100).
   * Values above 60 indicate broad buying, below 40 indicate broad selling.
   */
  marketBreadth: number;

  /** Advance/Decline ratio (advancing issues ÷ declining issues). */
  advanceDeclineRatio: number;

  /**
   * VWAP deviation of NIFTY expressed as a percentage above (+) or below (-)
   * the session VWAP.
   */
  vwapDeviation: number;

  /**
   * India VIX level.  The VIX override rule (Requirement 5.7) is triggered
   * when this value exceeds the configured `HIGH_VOLATILITY_VIX_THRESHOLD`.
   */
  indiaVix: number;

  /**
   * Average True Range of NIFTY over the configured period (in price points).
   * Used to measure price expansion for breakout detection.
   */
  atr: number;

  /**
   * Relative volume: ratio of current session volume to the 30-day average
   * session volume.  Values > 1.0 mean above-average activity.
   */
  relativeVolume: number;

  /**
   * Composite sector strength indicator (0–100 or any signed scale).
   * Nullable — may be absent during pre-market or data-feed gaps.
   */
  sectorStrength: number | null;

  /**
   * Nifty futures basis: futures price minus spot price (positive = premium,
   * negative = discount).
   * Nullable — not applicable when computing from cash-market data alone.
   */
  futuresBasis: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload published to the `events:regime_change` Redis pub/sub channel and
 * emitted as the NestJS `market.regime.changed` event on every regime
 * transition.
 *
 * Requirement 5.3: publish within 30 seconds of the triggering condition.
 */
export interface RegimeChangeEvent {
  /** The regime the system has just entered. */
  regime: MarketRegime;

  /** The regime the system was in before this transition (null on first classification). */
  previousRegime: MarketRegime | null;

  /** All 10 indicator inputs that produced this classification. */
  inputs: RegimeInputs;

  /** Human-readable rationale describing why this regime was selected. */
  rationale: string;

  /** UTC timestamp when the classification was produced. */
  classifiedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis keys and event-name constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redis pub/sub channel for regime-change broadcasts.
 * Requirement 5.3.
 */
export const REGIME_CHANGE_CHANNEL = 'events:regime_change';

/**
 * Redis key holding the current regime string (TTL 300 s, written by
 * MarketDataCacheService — MarketRegimeService also writes this key directly
 * on every classification to stay in sync).
 */
export const REGIME_CURRENT_KEY = 'regime:current';

/**
 * NestJS EventEmitter event name emitted intra-process on every regime
 * transition.  Consumers: StrategyEngine, RiskEngine, OptionsIntelligence.
 */
export const REGIME_CHANGED_EVENT = 'market.regime.changed';

/**
 * NestJS EventEmitter event name emitted when the regime transitions to or
 * remains UNSTABLE.  Consumed by RiskEngine to enforce the reduced concurrent-
 * trade limit (Requirement 5.6).
 */
export const REGIME_UNSTABLE_EVENT = 'market.regime.unstable';
