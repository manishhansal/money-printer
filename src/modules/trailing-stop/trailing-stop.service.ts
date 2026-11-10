/**
 * trailing-stop.service.ts
 *
 * TrailingStopService — computes trailing stop levels for all 8 mechanisms
 * defined in Requirement 12.1.
 *
 * Each mechanism is implemented as a dedicated compute method so that the
 * logic stays readable and independently testable.  The public entry point
 * `computeTrailingStop()` dispatches to the correct method based on the
 * discriminated-union `config.mechanism` field.
 *
 * Requirements: 12.1, 12.6
 */

import { Injectable } from '@nestjs/common';

import {
  AtrBasedConfig,
  ChandelierExitConfig,
  IVRegime,
  PartialProfitConfig,
  PercentageBasedConfig,
  PositionDirection,
  StructureBasedConfig,
  SwingHighLowConfig,
  TimeBasedConfig,
  TrailingStopConfig,
  TrailingStopMarketData,
  TrailingStopMechanism,
  TrailingStopPosition,
  TrailingStopResult,
  VolatilityAdjustedConfig,
} from './trailing-stop.types';

@Injectable()
export class TrailingStopService {
  // ─────────────────────────────────────────────────────────────────────────
  // Public entry point
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Dispatches to the appropriate mechanism-specific method and returns a
   * populated TrailingStopResult.
   *
   * Requirements: 12.1, 12.6
   */
  computeTrailingStop(
    position: TrailingStopPosition,
    config: TrailingStopConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    switch (config.mechanism) {
      case TrailingStopMechanism.ATR_BASED:
        return this.computeAtrBasedStop(position, config, marketData);
      case TrailingStopMechanism.SWING_HIGH_LOW:
        return this.computeSwingHighLowStop(position, config, marketData);
      case TrailingStopMechanism.CHANDELIER_EXIT:
        return this.computeChandelierExitStop(position, config, marketData);
      case TrailingStopMechanism.PERCENTAGE_BASED:
        return this.computePercentageBasedStop(position, config, marketData);
      case TrailingStopMechanism.VOLATILITY_ADJUSTED:
        return this.computeVolatilityAdjustedStop(position, config, marketData);
      case TrailingStopMechanism.STRUCTURE_BASED:
        return this.computeStructureBasedStop(position, config, marketData);
      case TrailingStopMechanism.TIME_BASED:
        return this.computeTimeBasedStop(position, config, marketData);
      case TrailingStopMechanism.PARTIAL_PROFIT:
        return this.computePartialProfitStop(position, config, marketData);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mechanism 1: ATR-based
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes an ATR-based trailing stop anchored to entry price.
   *
   *   LONG:  newSL = entryPrice − (atr × multiplier)
   *   SHORT: newSL = entryPrice + (atr × multiplier)
   *
   * Requirement 12.1 (mechanism 1)
   */
  computeAtrBasedStop(
    position: TrailingStopPosition,
    config: AtrBasedConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const { atr, currentPrice } = marketData;
    const entryPrice = parseFloat(position.entryPrice);

    const distance = atr * config.multiplier;
    const newSl = position.direction === 'LONG' ? entryPrice - distance : entryPrice + distance;

    return {
      newStopLoss: this.formatPrice(newSl),
      shouldExit: this.isExistingSlHit(position, currentPrice),
      mechanism: TrailingStopMechanism.ATR_BASED,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mechanism 2: Swing High/Low
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes a swing-based trailing stop using the nearest swing high/low
   * within the last N bars.
   *
   *   LONG:  newSL = min(swingLows[0..lookbackBars]) − buffer
   *   SHORT: newSL = max(swingHighs[0..lookbackBars]) + buffer
   *
   * Falls back to currentPrice ± buffer when no swing data is available.
   *
   * Requirement 12.1 (mechanism 2)
   */
  computeSwingHighLowStop(
    position: TrailingStopPosition,
    config: SwingHighLowConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const { swingHighs, swingLows, currentPrice } = marketData;
    const { lookbackBars, buffer } = config;

    let newSl: number;
    if (position.direction === 'LONG') {
      const recentLows = swingLows.slice(0, lookbackBars);
      const recentSwingLow = recentLows.length > 0 ? Math.min(...recentLows) : currentPrice;
      newSl = recentSwingLow - buffer;
    } else {
      const recentHighs = swingHighs.slice(0, lookbackBars);
      const recentSwingHigh = recentHighs.length > 0 ? Math.max(...recentHighs) : currentPrice;
      newSl = recentSwingHigh + buffer;
    }

    return {
      newStopLoss: this.formatPrice(newSl),
      shouldExit: this.isExistingSlHit(position, currentPrice),
      mechanism: TrailingStopMechanism.SWING_HIGH_LOW,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mechanism 3: Chandelier Exit
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes a Chandelier Exit trailing stop.
   *
   *   LONG:  newSL = highestHigh(period) − (atr × multiplier)
   *   SHORT: newSL = lowestLow(period)  + (atr × multiplier)
   *
   * Uses marketData.highestHigh / lowestLow when pre-computed; otherwise
   * derives them from the head of the swingHighs / swingLows arrays.
   *
   * Requirement 12.1 (mechanism 3)
   */
  computeChandelierExitStop(
    position: TrailingStopPosition,
    config: ChandelierExitConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const { atr, currentPrice, swingHighs, swingLows } = marketData;
    const { period, multiplier } = config;

    const highestHigh =
      marketData.highestHigh ??
      (swingHighs.length > 0 ? Math.max(...swingHighs.slice(0, period)) : currentPrice);

    const lowestLow =
      marketData.lowestLow ??
      (swingLows.length > 0 ? Math.min(...swingLows.slice(0, period)) : currentPrice);

    const newSl =
      position.direction === 'LONG' ? highestHigh - atr * multiplier : lowestLow + atr * multiplier;

    return {
      newStopLoss: this.formatPrice(newSl),
      shouldExit: this.isExistingSlHit(position, currentPrice),
      mechanism: TrailingStopMechanism.CHANDELIER_EXIT,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mechanism 4: Percentage-based
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes a percentage-based trailing stop relative to current price.
   *
   *   LONG:  newSL = currentPrice × (1 − percentage)
   *   SHORT: newSL = currentPrice × (1 + percentage)
   *
   * Requirement 12.1 (mechanism 4)
   */
  computePercentageBasedStop(
    position: TrailingStopPosition,
    config: PercentageBasedConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const { currentPrice } = marketData;
    const { percentage } = config;

    const newSl =
      position.direction === 'LONG'
        ? currentPrice * (1 - percentage)
        : currentPrice * (1 + percentage);

    return {
      newStopLoss: this.formatPrice(newSl),
      shouldExit: this.isExistingSlHit(position, currentPrice),
      mechanism: TrailingStopMechanism.PERCENTAGE_BASED,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mechanism 5: Volatility-adjusted
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes an ATR-based stop with an IV-regime multiplier applied to the
   * ATR distance.
   *
   *   effectiveDistance = atr × baseMultiplier × ivRegimeMultiplier
   *   LONG:  newSL = entryPrice − effectiveDistance
   *   SHORT: newSL = entryPrice + effectiveDistance
   *
   * ivRegimeMultiplier > 1.0 in EXPANDING (widens the stop),
   * ivRegimeMultiplier < 1.0 in CONTRACTING (tightens it),
   * ivRegimeMultiplier = 1.0 in NEUTRAL (no adjustment).
   *
   * Requirement 12.1 (mechanism 5)
   */
  computeVolatilityAdjustedStop(
    position: TrailingStopPosition,
    config: VolatilityAdjustedConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const { atr, currentPrice, ivRegime } = marketData;
    const { baseMultiplier, expandingIvMultiplier, contractingIvMultiplier } = config;

    const ivScale = this.resolveIvRegimeScale(
      ivRegime,
      expandingIvMultiplier,
      contractingIvMultiplier,
    );
    const effectiveDistance = atr * baseMultiplier * ivScale;
    const entryPrice = parseFloat(position.entryPrice);

    const newSl =
      position.direction === 'LONG'
        ? entryPrice - effectiveDistance
        : entryPrice + effectiveDistance;

    return {
      newStopLoss: this.formatPrice(newSl),
      shouldExit: this.isExistingSlHit(position, currentPrice),
      mechanism: TrailingStopMechanism.VOLATILITY_ADJUSTED,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mechanism 6: Structure-based
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes a structure-based stop anchored to the nearest significant S/R
   * level relative to the current price.
   *
   *   LONG:  newSL = nearest_support_below_current_price − buffer
   *   SHORT: newSL = nearest_resistance_above_current_price + buffer
   *
   * Falls back to currentPrice ± buffer when no suitable level is found.
   *
   * Requirement 12.1 (mechanism 6)
   */
  computeStructureBasedStop(
    position: TrailingStopPosition,
    config: StructureBasedConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const { currentPrice, supportLevels, resistanceLevels } = marketData;
    const { buffer } = config;

    let newSl: number;
    if (position.direction === 'LONG') {
      const nearestSupport = this.nearestLevelBelow(currentPrice, supportLevels);
      newSl = (nearestSupport ?? currentPrice) - buffer;
    } else {
      const nearestResistance = this.nearestLevelAbove(currentPrice, resistanceLevels);
      newSl = (nearestResistance ?? currentPrice) + buffer;
    }

    return {
      newStopLoss: this.formatPrice(newSl),
      shouldExit: this.isExistingSlHit(position, currentPrice),
      mechanism: TrailingStopMechanism.STRUCTURE_BASED,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mechanism 7: Time-based
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes a progressively tightening stop based on time elapsed since entry.
   *
   *   effectiveMultiplier = max(0, baseMultiplier − tighteningRatePerHour × hoursElapsed)
   *   LONG:  newSL = currentPrice − atr × effectiveMultiplier
   *   SHORT: newSL = currentPrice + atr × effectiveMultiplier
   *
   * Requirement 12.1 (mechanism 7)
   */
  computeTimeBasedStop(
    position: TrailingStopPosition,
    config: TimeBasedConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const { atr, currentPrice } = marketData;
    const { baseMultiplier, tighteningRatePerHour, entryTime } = config;

    const msElapsed = Date.now() - entryTime.getTime();
    const hoursElapsed = msElapsed / (1_000 * 60 * 60);
    const effectiveMultiplier = Math.max(0, baseMultiplier - tighteningRatePerHour * hoursElapsed);

    const newSl =
      position.direction === 'LONG'
        ? currentPrice - atr * effectiveMultiplier
        : currentPrice + atr * effectiveMultiplier;

    return {
      newStopLoss: this.formatPrice(newSl),
      shouldExit: this.isExistingSlHit(position, currentPrice),
      mechanism: TrailingStopMechanism.TIME_BASED,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mechanism 8: Partial-profit
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes a partial-profit trailing stop.
   *
   * When the current price has NOT yet reached the first target:
   *   → Return current SL unchanged; shouldExit = false.
   *
   * When the current price reaches or crosses the first target:
   *   → exitQuantity = floor(quantity × partialExitFraction)
   *   → shouldExit = true (exit only the partial quantity)
   *   → newSL = postPartialStopPrice (if configured) or entryPrice (break-even)
   *
   * Requirement 12.6
   */
  computePartialProfitStop(
    position: TrailingStopPosition,
    config: PartialProfitConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const { currentPrice } = marketData;
    const { firstTargetPrice, partialExitFraction, postPartialStopPrice } = config;
    const entryPrice = parseFloat(position.entryPrice);

    const targetReached =
      position.direction === 'LONG'
        ? currentPrice >= firstTargetPrice
        : currentPrice <= firstTargetPrice;

    if (!targetReached) {
      // Target not reached — hold at current SL, no exit signal.
      return {
        newStopLoss: position.currentStopLoss,
        shouldExit: false,
        mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
      };
    }

    // Target reached — compute partial exit and move SL to break-even (or configured level).
    const exitQuantity = Math.floor(position.quantity * partialExitFraction);
    const newSl = postPartialStopPrice ?? entryPrice;

    return {
      newStopLoss: this.formatPrice(newSl),
      shouldExit: true,
      exitQuantity,
      mechanism: TrailingStopMechanism.PARTIAL_PROFIT,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SL monotonicity enforcement (Requirement 12.2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enforces SL monotonicity in the profit direction.
   *
   * The stop-loss may only be moved in the direction that increases protection
   * (i.e. toward the current price, never away from it):
   *   LONG:  result = max(currentSl, newSl)   — SL can only move higher
   *   SHORT: result = min(currentSl, newSl)   — SL can only move lower
   *
   * If `newSl` would move the SL in a risk-increasing direction, `currentSl`
   * is returned unchanged.
   *
   * Requirement 12.2
   */
  enforceSlMonotonicity(currentSl: string, newSl: string, direction: PositionDirection): string {
    const current = parseFloat(currentSl);
    const next = parseFloat(newSl);

    const enforced = direction === 'LONG' ? Math.max(current, next) : Math.min(current, next);

    return this.formatPrice(enforced);
  }

  /**
   * Computes a trailing stop level and immediately enforces SL monotonicity
   * before returning the result.
   *
   * This is the preferred call site for callers that persist the SL, as it
   * guarantees the returned `newStopLoss` will never move the stop in a
   * risk-increasing direction relative to `position.currentStopLoss`.
   *
   * Requirement 12.2
   */
  computeAndEnforceSl(
    position: TrailingStopPosition,
    config: TrailingStopConfig,
    marketData: TrailingStopMarketData,
  ): TrailingStopResult {
    const raw = this.computeTrailingStop(position, config, marketData);
    const enforcedSl = this.enforceSlMonotonicity(
      position.currentStopLoss,
      raw.newStopLoss,
      position.direction,
    );

    return { ...raw, newStopLoss: enforcedSl };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true when the current price has hit or breached the EXISTING
   * stop-loss level stored in the position.
   *
   *   LONG:  shouldExit = currentPrice ≤ existingStopLoss
   *   SHORT: shouldExit = currentPrice ≥ existingStopLoss
   */
  private isExistingSlHit(position: TrailingStopPosition, currentPrice: number): boolean {
    const existingSl = parseFloat(position.currentStopLoss);
    return position.direction === 'LONG' ? currentPrice <= existingSl : currentPrice >= existingSl;
  }

  /**
   * Formats a price number to a 2-decimal-place NUMERIC string.
   */
  private formatPrice(price: number): string {
    return price.toFixed(2);
  }

  /**
   * Resolves the scale factor for the VOLATILITY_ADJUSTED mechanism based on
   * the current IV regime.
   *
   *   EXPANDING   → expandingMultiplier
   *   CONTRACTING → contractingMultiplier
   *   NEUTRAL     → 1.0
   */
  private resolveIvRegimeScale(
    regime: IVRegime,
    expandingMultiplier: number,
    contractingMultiplier: number,
  ): number {
    switch (regime) {
      case 'EXPANDING':
        return expandingMultiplier;
      case 'CONTRACTING':
        return contractingMultiplier;
      case 'NEUTRAL':
        return 1.0;
    }
  }

  /**
   * Returns the highest level in `levels` that is strictly below `price`,
   * or null when no such level exists.
   */
  private nearestLevelBelow(price: number, levels: number[]): number | null {
    const candidates = levels.filter((l) => l < price);
    return candidates.length > 0 ? Math.max(...candidates) : null;
  }

  /**
   * Returns the lowest level in `levels` that is strictly above `price`,
   * or null when no such level exists.
   */
  private nearestLevelAbove(price: number, levels: number[]): number | null {
    const candidates = levels.filter((l) => l > price);
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }
}
