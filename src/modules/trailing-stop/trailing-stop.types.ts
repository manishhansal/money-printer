/**
 * trailing-stop.types.ts
 *
 * Shared type definitions for the TrailingStopModule.
 *
 * Requirements: 12.1, 12.6
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mechanism enum
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All 8 trailing stop mechanisms supported by the TrailingStopEngine.
 * (Requirement 12.1)
 */
export enum TrailingStopMechanism {
  ATR_BASED = 'ATR_BASED',
  SWING_HIGH_LOW = 'SWING_HIGH_LOW',
  CHANDELIER_EXIT = 'CHANDELIER_EXIT',
  PERCENTAGE_BASED = 'PERCENTAGE_BASED',
  VOLATILITY_ADJUSTED = 'VOLATILITY_ADJUSTED',
  STRUCTURE_BASED = 'STRUCTURE_BASED',
  TIME_BASED = 'TIME_BASED',
  PARTIAL_PROFIT = 'PARTIAL_PROFIT',
}

// ─────────────────────────────────────────────────────────────────────────────
// Supporting enums / literals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IV regime used by the VOLATILITY_ADJUSTED mechanism.
 * EXPANDING → wider stop (higher multiplier)
 * CONTRACTING → tighter stop (lower multiplier)
 * NEUTRAL → base multiplier unchanged
 */
export type IVRegime = 'CONTRACTING' | 'NEUTRAL' | 'EXPANDING';

/** Direction of an open position. */
export type PositionDirection = 'LONG' | 'SHORT';

// ─────────────────────────────────────────────────────────────────────────────
// Mechanism-specific configuration objects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ATR-based trailing stop configuration.
 *
 * SL distance = atr × multiplier, applied from entry price.
 *   LONG:  newSL = entryPrice − (atr × multiplier)
 *   SHORT: newSL = entryPrice + (atr × multiplier)
 */
export interface AtrBasedConfig {
  mechanism: TrailingStopMechanism.ATR_BASED;
  /** ATR multiplier (e.g. 2.0 → SL at 2 × ATR away from entry price). */
  multiplier: number;
}

/**
 * Swing High/Low trailing stop configuration.
 *
 *   LONG:  newSL = recentSwingLow − buffer (minimum of last lookbackBars swing lows)
 *   SHORT: newSL = recentSwingHigh + buffer (maximum of last lookbackBars swing highs)
 */
export interface SwingHighLowConfig {
  mechanism: TrailingStopMechanism.SWING_HIGH_LOW;
  /** Number of recent bars to scan for swing highs/lows. */
  lookbackBars: number;
  /** Buffer distance below swing low (long) or above swing high (short), in price units. */
  buffer: number;
}

/**
 * Chandelier Exit trailing stop configuration.
 *
 *   LONG:  newSL = highestHigh(period) − (atr × multiplier)
 *   SHORT: newSL = lowestLow(period)  + (atr × multiplier)
 */
export interface ChandelierExitConfig {
  mechanism: TrailingStopMechanism.CHANDELIER_EXIT;
  /** Lookback period (bars) for finding the highest high / lowest low. */
  period: number;
  /** ATR multiplier. */
  multiplier: number;
}

/**
 * Percentage-based trailing stop configuration.
 *
 *   LONG:  newSL = currentPrice × (1 − percentage)
 *   SHORT: newSL = currentPrice × (1 + percentage)
 */
export interface PercentageBasedConfig {
  mechanism: TrailingStopMechanism.PERCENTAGE_BASED;
  /** Stop distance as a decimal fraction (e.g. 0.02 for 2 %). */
  percentage: number;
}

/**
 * Volatility-adjusted ATR trailing stop configuration.
 *
 * The ATR distance is scaled by an IV-regime multiplier:
 *   effectiveDistance = atr × baseMultiplier × ivRegimeMultiplier
 *   LONG:  newSL = entryPrice − effectiveDistance
 *   SHORT: newSL = entryPrice + effectiveDistance
 *
 * ivRegimeMultiplier > 1 in EXPANDING (wider stop), < 1 in CONTRACTING (tighter).
 */
export interface VolatilityAdjustedConfig {
  mechanism: TrailingStopMechanism.VOLATILITY_ADJUSTED;
  /** Base ATR multiplier (applied regardless of regime). */
  baseMultiplier: number;
  /**
   * Scale factor applied in EXPANDING IV regime.
   * Must be > 1.0 (widens the stop distance).
   */
  expandingIvMultiplier: number;
  /**
   * Scale factor applied in CONTRACTING IV regime.
   * Must be < 1.0 (tightens the stop distance).
   */
  contractingIvMultiplier: number;
}

/**
 * Structure-based (S/R level) trailing stop configuration.
 *
 *   LONG:  newSL = nearestSupportBelow − buffer
 *   SHORT: newSL = nearestResistanceAbove + buffer
 */
export interface StructureBasedConfig {
  mechanism: TrailingStopMechanism.STRUCTURE_BASED;
  /** Buffer distance below support (long) or above resistance (short), in price units. */
  buffer: number;
}

/**
 * Time-based progressively tightening stop configuration.
 *
 * The effective ATR multiplier decreases by tighteningRatePerHour for every
 * hour elapsed since entryTime.  The multiplier is clamped to 0 (minimum).
 *
 *   effectiveMultiplier = max(0, baseMultiplier − tighteningRatePerHour × hoursSinceEntry)
 *   LONG:  newSL = currentPrice − atr × effectiveMultiplier
 *   SHORT: newSL = currentPrice + atr × effectiveMultiplier
 */
export interface TimeBasedConfig {
  mechanism: TrailingStopMechanism.TIME_BASED;
  /** ATR multiplier at the moment of entry (before any tightening). */
  baseMultiplier: number;
  /** Amount by which the multiplier tightens per hour (e.g. 0.1 = reduces by 0.1 per hour). */
  tighteningRatePerHour: number;
  /** UTC timestamp when the position was entered. */
  entryTime: Date;
}

/**
 * Partial-profit trailing stop configuration.
 *
 * When currentPrice reaches firstTargetPrice:
 *   1. Exit partialExitFraction of total quantity.
 *   2. Move SL to postPartialStopPrice (if configured) or to entryPrice (break-even).
 *
 * Requirement 12.6
 */
export interface PartialProfitConfig {
  mechanism: TrailingStopMechanism.PARTIAL_PROFIT;
  /** First target price at which to trigger the partial exit. */
  firstTargetPrice: number;
  /** Fraction of total position quantity to exit at first target (e.g. 0.5 = 50 %). */
  partialExitFraction: number;
  /**
   * Stop-loss price to apply after the partial exit.
   * When omitted, the SL is moved to entryPrice (break-even).
   */
  postPartialStopPrice?: number;
}

/**
 * Discriminated union of all 8 mechanism-specific configuration objects.
 */
export type TrailingStopConfig =
  | AtrBasedConfig
  | SwingHighLowConfig
  | ChandelierExitConfig
  | PercentageBasedConfig
  | VolatilityAdjustedConfig
  | StructureBasedConfig
  | TimeBasedConfig
  | PartialProfitConfig;

// ─────────────────────────────────────────────────────────────────────────────
// Market data input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Market data inputs required by TrailingStopService.computeTrailingStop().
 *
 * All array fields are ordered most-recent first so that slice(0, N) gives
 * the last N observations.
 */
export interface TrailingStopMarketData {
  /** Current market price of the instrument (INR). */
  currentPrice: number;
  /** Average True Range value (INR). */
  atr: number;
  /** Recent swing high prices, most-recent first. */
  swingHighs: number[];
  /** Recent swing low prices, most-recent first. */
  swingLows: number[];
  /** Current implied-volatility regime. */
  ivRegime: IVRegime;
  /** Support level prices (any order; the service picks the nearest one below current price). */
  supportLevels: number[];
  /** Resistance level prices (any order; the service picks the nearest one above current price). */
  resistanceLevels: number[];
  /**
   * Pre-computed highest high over the Chandelier lookback period.
   * When provided, used directly by ChandelierExit.
   * When absent, the service falls back to max(swingHighs.slice(0, period)).
   */
  highestHigh?: number;
  /**
   * Pre-computed lowest low over the Chandelier lookback period.
   * When provided, used directly by ChandelierExit.
   * When absent, the service falls back to min(swingLows.slice(0, period)).
   */
  lowestLow?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Position context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open position data required to compute a trailing stop update.
 *
 * Monetary string fields use PostgreSQL NUMERIC decimal notation
 * (e.g. "100.00"), matching the entity column format used elsewhere in the
 * codebase.
 */
export interface TrailingStopPosition {
  /** Entry price of the position (INR, NUMERIC string, e.g. "100.00"). */
  entryPrice: string;
  /** Current (existing) stop-loss price (INR, NUMERIC string). */
  currentStopLoss: string;
  /** Whether this is a long or short position. */
  direction: PositionDirection;
  /** Total position size in units/lots. */
  quantity: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result returned by TrailingStopService.computeTrailingStop().
 *
 * Requirements: 12.1, 12.6
 */
export interface TrailingStopResult {
  /**
   * Newly computed stop-loss price (INR, NUMERIC string, 2 decimal places).
   * The caller is responsible for enforcing SL monotonicity before persisting
   * this value (see Task 23.2 / Requirement 12.2).
   */
  newStopLoss: string;
  /**
   * Whether the position (or partial quantity) should be exited immediately.
   *
   * For standard mechanisms: true when the current price has hit or breached
   * the existing stop-loss in position.currentStopLoss.
   *
   * For PARTIAL_PROFIT: true when the current price has reached the configured
   * firstTargetPrice — only the exitQuantity should be exited, not the full
   * position.
   */
  shouldExit: boolean;
  /**
   * Quantity to exit.
   * Populated only for PARTIAL_PROFIT when shouldExit = true.
   * For all other mechanisms this field is undefined.
   */
  exitQuantity?: number;
  /** The mechanism that produced this result. */
  mechanism: TrailingStopMechanism;
}
