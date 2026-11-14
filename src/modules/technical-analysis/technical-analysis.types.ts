/**
 * technical-analysis.types.ts
 *
 * Shared types for the TechnicalAnalysisModule.
 *
 * The OHLCV interface is the sole data input for all indicator computations.
 * Callers fetch candle arrays from the database and pass them directly to the
 * TechnicalAnalysisService — no TypeORM entity is injected into the service.
 *
 * Requirements: 5.2, 6.2
 */

/**
 * A single OHLCV (Open / High / Low / Close / Volume) candle.
 *
 * All numeric fields are floating-point values in INR (for price) or lot
 * counts (for volume). `timestamp` is the candle open-time in UTC.
 */
export interface OHLCV {
  /** Opening price of the candle interval */
  open: number;
  /** Highest price reached during the candle interval */
  high: number;
  /** Lowest price reached during the candle interval */
  low: number;
  /** Closing price of the candle interval */
  close: number;
  /** Total traded volume during the candle interval */
  volume: number;
  /** UTC timestamp of the candle open-time */
  timestamp: Date;
}

/** Result of a MACD computation (12/26/9 standard configuration). */
export interface MACDResult {
  /** MACD line = EMA(12) − EMA(26) */
  macd: number;
  /** Signal line = EMA(9) of MACD line */
  signal: number;
  /** Histogram = MACD − Signal */
  histogram: number;
}

/** Result of a Support/Resistance computation derived from swing highs/lows. */
export interface SupportResistanceResult {
  /** Nearest swing-low price acting as support */
  support: number;
  /** Nearest swing-high price acting as resistance */
  resistance: number;
}

/** Result of an Opening Range Breakout (ORB) computation. */
export interface ORBResult {
  /** Highest price reached during the ORB window */
  orbHigh: number;
  /** Lowest price reached during the ORB window */
  orbLow: number;
  /** Duration of the ORB window in minutes (5, 15, or 30). */
  windowMinutes: number;
}

/**
 * Result of an ADX / DMI computation.
 *
 * ADX measures trend strength (direction-independent).
 * +DI measures upward directional movement.
 * -DI measures downward directional movement.
 *
 * Interpretation:
 *   - ADX > 25: strong trend (direction given by +DI vs -DI comparison).
 *   - ADX < 20: weak/no trend (range-bound).
 *   - +DI > -DI and ADX > 25: strong uptrend.
 *   - -DI > +DI and ADX > 25: strong downtrend.
 */
export interface ADXResult {
  /** Average Directional Index (0–100). Trend strength, direction-independent. */
  adx: number;
  /** Positive Directional Indicator (0–100). Upward movement strength. */
  plusDI: number;
  /** Negative Directional Indicator (0–100). Downward movement strength. */
  minusDI: number;
}

/**
 * Rate of Change result.
 * Measures the percentage change in price over `period` candles.
 * Positive = upward momentum; negative = downward momentum.
 */
export interface ROCResult {
  /** Rate of change as a percentage. e.g. 1.5 means +1.5% over the period. */
  roc: number;
  /** Number of candles over which ROC was computed. */
  period: number;
}
