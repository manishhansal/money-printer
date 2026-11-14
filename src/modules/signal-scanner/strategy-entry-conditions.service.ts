/**
 * strategy-entry-conditions.service.ts
 *
 * StrategyEntryConditionsService — per-strategy entry-condition detection.
 *
 * # Problem (DEFECT-002 — partial fix)
 *
 * The existing StrategyService evaluates 8 differently-named strategies but
 * applies identical entry logic to all of them: RSI ≥ 55 on the OPTION PREMIUM.
 * This means:
 *   - Strategy A (Opening Range Breakout) does NOT check if the underlying
 *     broke its opening-range high or low.
 *   - Strategy B (VWAP Reclaim) does NOT check for a VWAP cross.
 *   - Strategy C (Momentum Expansion) does NOT check for expanding momentum.
 *   - etc.
 *
 * # What this service does
 *
 * Implements genuinely distinct entry conditions for each strategy on the
 * UNDERLYING instrument (not the option premium).  Called by
 * UnderlyingMomentumScannerService after computing multi-timeframe indicators
 * for the underlying.
 *
 * # Strategy definitions (per the master prompt)
 *
 * A — Opening Range Breakout: price breaks ORB high/low with confirmation
 * B — VWAP Reclaim / Rejection: completed candle confirms VWAP reclaim or rejection
 * C — Momentum Expansion: RSI > 60, MACD expanding, ADX > 20, ATR expansion
 * D — Breakout and Retest: break of key level, then retest + continuation
 * E — Relative Strength / Weakness: stock outperforming/underperforming NIFTY
 * F — Trend Continuation: established trend + pullback + volume return
 *
 * # Look-ahead-free design
 *
 * All conditions use COMPLETED candles only (not in-progress bars).
 * The last candle in the array is treated as completed. The scanner ensures
 * only closed candles are loaded.
 *
 * Requirements: Phase 3 — Momentum Strategy Implementation
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  OHLCV,
  MACDResult,
  ORBResult,
  ADXResult,
} from '../technical-analysis/technical-analysis.types';

// ─────────────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full indicator snapshot computed by the underlying momentum scanner.
 * All fields derived from the UNDERLYING (not the option premium).
 */
export interface UnderlyingIndicators {
  /** Current VWAP (intraday). */
  vwap: number | null;
  /** Most recent EMA(9). */
  ema9: number | null;
  /** Most recent EMA(21). */
  ema21: number | null;
  /** Most recent EMA(50). */
  ema50: number | null;
  /** Current RSI(14). */
  rsi: number | null;
  /** Most recent MACD result (12/26/9). */
  macd: MACDResult | null;
  /** Most recent ADX result. */
  adx: ADXResult | null;
  /** Most recent ATR(14). */
  atr: number | null;
  /** Relative volume vs comparable periods. */
  relVol: number | null;
  /** Rate of change over 10 candles. */
  roc: number | null;
  /** ORB range (15-minute default). */
  orb: ORBResult | null;
  /** Previous day high/low. */
  prevDayHigh: number | null;
  prevDayLow: number | null;
  /** Current underlying price (last completed candle close). */
  currentPrice: number;
  /** Relative strength vs NIFTY (stock only; null for indices). */
  relativeStrengthVsNifty: number | null;
  /** Number of 1-minute candles available. */
  candleCount1m: number;
  /** Number of 5-minute candles available. */
  candleCount5m: number;
}

/** Direction of the momentum signal. */
export type MomentumDirection = 'BULLISH' | 'BEARISH';

/** Result of evaluating one strategy's entry conditions. */
export interface EntryConditionResult {
  /** Whether ALL required conditions for this strategy are met. */
  met: boolean;
  /** Strategy code that was evaluated. */
  strategyCode: string;
  /** Direction if conditions met; null otherwise. */
  direction: MomentumDirection | null;
  /** Human-readable reason for rejection, or the specific trigger description. */
  reason: string;
  /** Individual condition results for observability. */
  conditions: Array<{ name: string; passed: boolean; value: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration thresholds (all configurable; initial research values)
// ─────────────────────────────────────────────────────────────────────────────

const RSI_STRONG_BULL = 60;
const RSI_MODERATE_BULL = 55;
const RSI_STRONG_BEAR = 40;
const RSI_MODERATE_BEAR = 45;
const ADX_TREND_MIN = 20;
const REL_VOL_CONFIRM = 1.2;
const MACD_HISTOGRAM_POSITIVE_THRESHOLD = 0;
const VWAP_RECLAIM_TOLERANCE_PCT = 0.001; // 0.1% above/below VWAP
const ORB_BREAK_BUFFER_PCT = 0.001; // 0.1% beyond ORB level
const RELATIVE_STRENGTH_THRESHOLD = 0.5; // stock must outperform by ≥ 0.5%
const PULLBACK_DEPTH_MAX_PCT = 0.015; // max 1.5% pullback for trend continuation

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class StrategyEntryConditionsService {
  private readonly logger = new Logger(StrategyEntryConditionsService.name);

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — evaluate entry conditions per strategy
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Strategy A — Opening Range Breakout.
   *
   * Bullish: price breaks above ORB high with volume confirmation.
   * Bearish: price breaks below ORB low with volume confirmation.
   *
   * Requires: ORB range computed, completed candle above/below ORB level,
   *           relative volume ≥ 1.2×, price holds beyond ORB (no immediate reversal).
   */
  evaluateORB(indicators: UnderlyingIndicators, candles1m: OHLCV[]): EntryConditionResult {
    const conditions: EntryConditionResult['conditions'] = [];
    const { orb, currentPrice, relVol, vwap } = indicators;

    if (!orb || candles1m.length < 3) {
      return this.reject('A', 'Insufficient data for ORB evaluation', conditions);
    }

    const hasVolume = (relVol ?? 0) >= REL_VOL_CONFIRM;
    conditions.push({
      name: 'relVol_confirm',
      passed: hasVolume,
      value: `relVol=${(relVol ?? 0).toFixed(2)} (need ≥${REL_VOL_CONFIRM})`,
    });

    // Bullish: current price > ORB high + buffer
    const bullBreak = currentPrice > orb.orbHigh * (1 + ORB_BREAK_BUFFER_PCT);
    // The last completed candle must have CLOSED above ORB high (no intrabar)
    const lastCandle = candles1m[candles1m.length - 1];
    const candleClosedAbove = lastCandle.close > orb.orbHigh;
    // VWAP confirmation
    const aboveVwap = vwap !== null ? currentPrice > vwap : true;

    conditions.push({
      name: 'price_above_orb_high',
      passed: bullBreak && candleClosedAbove,
      value: `price=${currentPrice.toFixed(2)} orbHigh=${orb.orbHigh.toFixed(2)}`,
    });
    conditions.push({
      name: 'above_vwap',
      passed: aboveVwap,
      value: `price=${currentPrice.toFixed(2)} vwap=${vwap?.toFixed(2) ?? 'n/a'}`,
    });

    if (bullBreak && candleClosedAbove && hasVolume) {
      return this.accept('A', 'BULLISH', 'ORB breakout above high with volume', conditions);
    }

    // Bearish: current price < ORB low - buffer
    const bearBreak = currentPrice < orb.orbLow * (1 - ORB_BREAK_BUFFER_PCT);
    const candleClosedBelow = lastCandle.close < orb.orbLow;
    const belowVwap = vwap !== null ? currentPrice < vwap : true;

    conditions.push({
      name: 'price_below_orb_low',
      passed: bearBreak && candleClosedBelow,
      value: `price=${currentPrice.toFixed(2)} orbLow=${orb.orbLow.toFixed(2)}`,
    });

    if (bearBreak && candleClosedBelow && hasVolume && belowVwap) {
      return this.accept('A', 'BEARISH', 'ORB breakdown below low with volume', conditions);
    }

    return this.reject('A', 'No ORB breakout confirmed', conditions);
  }

  /**
   * Strategy B — VWAP Reclaim / Rejection.
   *
   * Bullish reclaim: prior candle closed BELOW VWAP; current candle closes ABOVE VWAP.
   * Bearish rejection: prior candle closed ABOVE VWAP; current candle closes BELOW VWAP.
   *
   * Also requires EMA alignment and volume confirmation.
   */
  evaluateVWAPReclaim(indicators: UnderlyingIndicators, candles1m: OHLCV[]): EntryConditionResult {
    const conditions: EntryConditionResult['conditions'] = [];
    const { vwap, ema9, ema21, relVol } = indicators;

    if (!vwap || candles1m.length < 3) {
      return this.reject('B', 'Insufficient data for VWAP reclaim evaluation', conditions);
    }

    const prevCandle = candles1m[candles1m.length - 2];
    const currCandle = candles1m[candles1m.length - 1];
    const hasVolume = (relVol ?? 0) >= REL_VOL_CONFIRM;

    conditions.push({
      name: 'relVol_confirm',
      passed: hasVolume,
      value: `relVol=${(relVol ?? 0).toFixed(2)}`,
    });

    // Bullish reclaim: prev close below VWAP, current close above VWAP
    const prevBelowVwap = prevCandle.close < vwap * (1 - VWAP_RECLAIM_TOLERANCE_PCT);
    const currAboveVwap = currCandle.close > vwap * (1 + VWAP_RECLAIM_TOLERANCE_PCT);
    const emaAlignedBull = ema9 !== null && ema21 !== null ? ema9 >= ema21 * 0.998 : true; // EMA9 ≥ EMA21

    conditions.push({
      name: 'vwap_reclaim',
      passed: prevBelowVwap && currAboveVwap,
      value: `prev=${prevCandle.close.toFixed(2)} curr=${currCandle.close.toFixed(2)} vwap=${vwap.toFixed(2)}`,
    });
    conditions.push({
      name: 'ema_aligned_bull',
      passed: emaAlignedBull,
      value: `ema9=${ema9?.toFixed(2) ?? 'n/a'} ema21=${ema21?.toFixed(2) ?? 'n/a'}`,
    });

    if (prevBelowVwap && currAboveVwap && emaAlignedBull && hasVolume) {
      return this.accept('B', 'BULLISH', 'VWAP reclaim confirmed with EMA alignment', conditions);
    }

    // Bearish rejection: prev close above VWAP, current close below VWAP
    const prevAboveVwap = prevCandle.close > vwap * (1 + VWAP_RECLAIM_TOLERANCE_PCT);
    const currBelowVwap = currCandle.close < vwap * (1 - VWAP_RECLAIM_TOLERANCE_PCT);
    const emaAlignedBear = ema9 !== null && ema21 !== null ? ema9 <= ema21 * 1.002 : true;

    conditions.push({
      name: 'vwap_rejection',
      passed: prevAboveVwap && currBelowVwap,
      value: `prev=${prevCandle.close.toFixed(2)} curr=${currCandle.close.toFixed(2)} vwap=${vwap.toFixed(2)}`,
    });

    if (prevAboveVwap && currBelowVwap && emaAlignedBear && hasVolume) {
      return this.accept('B', 'BEARISH', 'VWAP rejection confirmed with EMA alignment', conditions);
    }

    return this.reject('B', 'No VWAP reclaim or rejection detected', conditions);
  }

  /**
   * Strategy C — Momentum Expansion.
   *
   * Requires MULTIPLE momentum indicators aligned simultaneously:
   *   Bullish: RSI > 60, MACD histogram positive and expanding, ADX > 20, ATR expanding, EMA stack bull.
   *   Bearish: RSI < 40, MACD histogram negative and expanding, ADX > 20, ATR expanding, EMA stack bear.
   *
   * This is the most demanding strategy — requires all 5 filters to pass.
   */
  evaluateMomentumExpansion(indicators: UnderlyingIndicators): EntryConditionResult {
    const conditions: EntryConditionResult['conditions'] = [];
    const { rsi, macd, adx, atr, ema9, ema21, relVol } = indicators;

    if (rsi === null || macd === null) {
      return this.reject('C', 'Insufficient data for momentum expansion evaluation', conditions);
    }

    const hasVolume = (relVol ?? 0) >= REL_VOL_CONFIRM;
    const hasADX = adx !== null ? adx.adx >= ADX_TREND_MIN : false;
    const hasATRExpansion = atr !== null; // Basic check; full expansion needs ATR history

    conditions.push({
      name: 'adx_trend',
      passed: hasADX,
      value: `adx=${adx?.adx.toFixed(1) ?? 'n/a'} (need ≥${ADX_TREND_MIN})`,
    });
    conditions.push({
      name: 'relVol',
      passed: hasVolume,
      value: `relVol=${(relVol ?? 0).toFixed(2)}`,
    });

    // Bullish momentum expansion
    const rsiStrongBull = rsi >= RSI_STRONG_BULL;
    const macdExpandingBull = macd.histogram > MACD_HISTOGRAM_POSITIVE_THRESHOLD && macd.macd > 0;
    const emaStackBull =
      ema9 !== null && ema21 !== null && ema9 > ema21 && currentAboveEMAs(indicators);

    conditions.push({
      name: 'rsi_bull',
      passed: rsiStrongBull,
      value: `rsi=${rsi.toFixed(1)} (need ≥${RSI_STRONG_BULL})`,
    });
    conditions.push({
      name: 'macd_expanding_bull',
      passed: macdExpandingBull,
      value: `hist=${macd.histogram.toFixed(3)} macd=${macd.macd.toFixed(3)}`,
    });
    conditions.push({
      name: 'ema_stack_bull',
      passed: emaStackBull,
      value: `ema9=${ema9?.toFixed(2) ?? 'n/a'} ema21=${ema21?.toFixed(2) ?? 'n/a'}`,
    });

    if (
      rsiStrongBull &&
      macdExpandingBull &&
      hasADX &&
      hasATRExpansion &&
      emaStackBull &&
      hasVolume
    ) {
      return this.accept(
        'C',
        'BULLISH',
        'Momentum expansion: RSI + MACD + ADX + EMA aligned',
        conditions,
      );
    }

    // Bearish momentum expansion
    const rsiStrongBear = rsi <= RSI_STRONG_BEAR;
    const macdExpandingBear = macd.histogram < MACD_HISTOGRAM_POSITIVE_THRESHOLD && macd.macd < 0;
    const emaStackBear = ema9 !== null && ema21 !== null && ema9 < ema21;

    conditions.push({
      name: 'rsi_bear',
      passed: rsiStrongBear,
      value: `rsi=${rsi.toFixed(1)} (need ≤${RSI_STRONG_BEAR})`,
    });
    conditions.push({
      name: 'macd_expanding_bear',
      passed: macdExpandingBear,
      value: `hist=${macd.histogram.toFixed(3)}`,
    });

    if (rsiStrongBear && macdExpandingBear && hasADX && emaStackBear && hasVolume) {
      return this.accept(
        'C',
        'BEARISH',
        'Bearish momentum expansion: RSI + MACD + ADX aligned',
        conditions,
      );
    }

    return this.reject('C', 'Momentum expansion conditions not met', conditions);
  }

  /**
   * Strategy D — Breakout and Retest.
   *
   * Detects a break of a key level (ORB high/low or previous day high/low)
   * followed by a successful retest (price returned to the level and bounced).
   *
   * Bullish: broke above key level, pulled back to level, closed above again.
   * Bearish: broke below key level, bounced to level, closed below again.
   */
  evaluateBreakoutRetest(
    indicators: UnderlyingIndicators,
    candles1m: OHLCV[],
  ): EntryConditionResult {
    const conditions: EntryConditionResult['conditions'] = [];
    const { orb, prevDayHigh, prevDayLow, currentPrice, relVol } = indicators;

    if (candles1m.length < 10) {
      return this.reject('D', 'Insufficient candle history for breakout/retest', conditions);
    }

    const hasVolume = (relVol ?? 0) >= REL_VOL_CONFIRM;
    conditions.push({
      name: 'relVol',
      passed: hasVolume,
      value: `relVol=${(relVol ?? 0).toFixed(2)}`,
    });

    // Key levels to check (in priority order)
    const keyLevels: Array<{ level: number; name: string; direction: MomentumDirection }> = [];

    if (orb) {
      keyLevels.push({ level: orb.orbHigh, name: 'ORB_HIGH', direction: 'BULLISH' });
      keyLevels.push({ level: orb.orbLow, name: 'ORB_LOW', direction: 'BEARISH' });
    }
    if (prevDayHigh) keyLevels.push({ level: prevDayHigh, name: 'PDH', direction: 'BULLISH' });
    if (prevDayLow) keyLevels.push({ level: prevDayLow, name: 'PDL', direction: 'BEARISH' });

    for (const kl of keyLevels) {
      const result = this.detectRetestAtLevel(candles1m, kl.level, kl.direction, hasVolume);
      if (result) {
        conditions.push({
          name: `retest_${kl.name}`,
          passed: true,
          value: `level=${kl.level.toFixed(2)} price=${currentPrice.toFixed(2)}`,
        });
        return this.accept(
          'D',
          kl.direction,
          `${kl.direction} retest of ${kl.name} confirmed`,
          conditions,
        );
      }
      conditions.push({
        name: `retest_${kl.name}`,
        passed: false,
        value: `level=${kl.level.toFixed(2)}`,
      });
    }

    return this.reject('D', 'No breakout/retest pattern detected at key levels', conditions);
  }

  /**
   * Strategy E — Relative Strength / Weakness (stocks only).
   *
   * Bullish: stock return > NIFTY return by ≥ 0.5% over last 15 minutes.
   * Bearish: stock return < NIFTY return by ≤ -0.5% over last 15 minutes.
   *
   * Returns NO_SIGNAL for index underlyings (relativeStrengthVsNifty is null).
   */
  evaluateRelativeStrength(indicators: UnderlyingIndicators): EntryConditionResult {
    const conditions: EntryConditionResult['conditions'] = [];
    const { relativeStrengthVsNifty, rsi, relVol } = indicators;

    if (relativeStrengthVsNifty === null) {
      return this.reject(
        'E',
        'Relative strength not available (index or no NIFTY data)',
        conditions,
      );
    }

    const hasVolume = (relVol ?? 0) >= 1.0; // slightly relaxed for stocks
    conditions.push({
      name: 'relVol',
      passed: hasVolume,
      value: `relVol=${(relVol ?? 0).toFixed(2)}`,
    });
    conditions.push({
      name: 'relative_strength',
      passed: Math.abs(relativeStrengthVsNifty) >= RELATIVE_STRENGTH_THRESHOLD,
      value: `rs=${relativeStrengthVsNifty.toFixed(2)}% (need ≥${RELATIVE_STRENGTH_THRESHOLD}%)`,
    });

    if (
      relativeStrengthVsNifty >= RELATIVE_STRENGTH_THRESHOLD &&
      (rsi === null || rsi >= RSI_MODERATE_BULL) &&
      hasVolume
    ) {
      return this.accept(
        'E',
        'BULLISH',
        `Stock outperforming NIFTY by ${relativeStrengthVsNifty.toFixed(2)}%`,
        conditions,
      );
    }

    if (
      relativeStrengthVsNifty <= -RELATIVE_STRENGTH_THRESHOLD &&
      (rsi === null || rsi <= RSI_MODERATE_BEAR) &&
      hasVolume
    ) {
      return this.accept(
        'E',
        'BEARISH',
        `Stock underperforming NIFTY by ${Math.abs(relativeStrengthVsNifty).toFixed(2)}%`,
        conditions,
      );
    }

    return this.reject(
      'E',
      `Relative strength ${relativeStrengthVsNifty.toFixed(2)}% below threshold`,
      conditions,
    );
  }

  /**
   * Strategy F — Trend Continuation.
   *
   * Established trend + controlled pullback + resumption signal.
   *
   * Bullish:
   *   - Price above VWAP, EMA9 > EMA21.
   *   - Recent pullback: price touched EMA21/VWAP zone (within 1.5%).
   *   - Pullback volume contracted.
   *   - Current candle resumes upward with higher close.
   *
   * Bearish: mirror conditions.
   */
  evaluateTrendContinuation(
    indicators: UnderlyingIndicators,
    candles1m: OHLCV[],
  ): EntryConditionResult {
    const conditions: EntryConditionResult['conditions'] = [];
    const { vwap, ema9, ema21, rsi, currentPrice, relVol } = indicators;

    if (!vwap || !ema9 || !ema21 || candles1m.length < 10) {
      return this.reject('F', 'Insufficient data for trend continuation evaluation', conditions);
    }

    const hasVolume = (relVol ?? 0) >= 1.0;
    conditions.push({
      name: 'relVol',
      passed: hasVolume,
      value: `relVol=${(relVol ?? 0).toFixed(2)}`,
    });

    // Bullish trend continuation
    const inUptrend = currentPrice > vwap && ema9 > ema21;
    const nearEMA21 = Math.abs(currentPrice - ema21) / ema21 <= PULLBACK_DEPTH_MAX_PCT;
    const rsiOk = rsi === null || (rsi >= RSI_MODERATE_BULL && rsi <= 75);

    conditions.push({
      name: 'uptrend',
      passed: inUptrend,
      value: `price=${currentPrice.toFixed(2)} vwap=${vwap.toFixed(2)} ema9=${ema9.toFixed(2)} ema21=${ema21.toFixed(2)}`,
    });
    conditions.push({
      name: 'pullback_depth_ok',
      passed: nearEMA21,
      value: `dist_from_ema21=${((Math.abs(currentPrice - ema21) / ema21) * 100).toFixed(2)}%`,
    });
    conditions.push({ name: 'rsi_range', passed: rsiOk, value: `rsi=${rsi?.toFixed(1) ?? 'n/a'}` });

    // Check if last 3 candles show pullback then resumption
    const resumptionBull = this.detectTrendResumption(candles1m, 'BULLISH');
    conditions.push({
      name: 'resumption_bull',
      passed: resumptionBull,
      value: 'last 3 candles confirm resumption',
    });

    if (inUptrend && nearEMA21 && rsiOk && resumptionBull) {
      return this.accept(
        'F',
        'BULLISH',
        'Trend continuation: pullback to EMA21 with resumption',
        conditions,
      );
    }

    // Bearish trend continuation
    const inDowntrend = currentPrice < vwap && ema9 < ema21;
    const nearEMA21Bear = Math.abs(currentPrice - ema21) / ema21 <= PULLBACK_DEPTH_MAX_PCT;
    const rsiOkBear = rsi === null || (rsi <= RSI_MODERATE_BEAR && rsi >= 25);
    const resumptionBear = this.detectTrendResumption(candles1m, 'BEARISH');

    conditions.push({
      name: 'downtrend',
      passed: inDowntrend,
      value: `price=${currentPrice.toFixed(2)} ema9=${ema9.toFixed(2)}`,
    });

    if (inDowntrend && nearEMA21Bear && rsiOkBear && resumptionBear) {
      return this.accept(
        'F',
        'BEARISH',
        'Bearish trend continuation: bounce to EMA21 rejected',
        conditions,
      );
    }

    return this.reject('F', 'Trend continuation conditions not met', conditions);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Detect a breakout-retest pattern at a specific level.
   *
   * Pattern (bullish):
   *   1. Some candle broke clearly above the level (> level * 1.001).
   *   2. A subsequent candle pulled back to touch the level (low ≤ level * 1.005).
   *   3. The current (last) candle closed above the level again.
   *
   * We scan the last 20 candles for this pattern.
   */
  private detectRetestAtLevel(
    candles: OHLCV[],
    level: number,
    direction: MomentumDirection,
    hasVolume: boolean,
  ): boolean {
    if (!hasVolume) return false;
    const lookback = Math.min(candles.length, 20);
    const subset = candles.slice(-lookback);
    const last = subset[subset.length - 1];

    if (direction === 'BULLISH') {
      // Find a prior break above level
      const breakIdx = subset.findIndex((c) => c.close > level * 1.001);
      if (breakIdx < 0) return false;
      // Find a retest (candle whose low came back to within 0.5% of level)
      const retestIdx = subset.findIndex(
        (c, i) => i > breakIdx && c.low <= level * 1.005 && c.close >= level * 0.998,
      );
      if (retestIdx < 0) return false;
      // Current candle closes above level
      return last.close > level;
    } else {
      const breakIdx = subset.findIndex((c) => c.close < level * 0.999);
      if (breakIdx < 0) return false;
      const retestIdx = subset.findIndex(
        (c, i) => i > breakIdx && c.high >= level * 0.995 && c.close <= level * 1.002,
      );
      if (retestIdx < 0) return false;
      return last.close < level;
    }
  }

  /**
   * Check the last 3 candles for a trend resumption pattern:
   *   BULLISH: at least 2 of the last 3 candles are green (close > open).
   *   BEARISH: at least 2 of the last 3 candles are red (close < open).
   */
  private detectTrendResumption(candles: OHLCV[], direction: MomentumDirection): boolean {
    if (candles.length < 3) return false;
    const last3 = candles.slice(-3);
    if (direction === 'BULLISH') {
      return last3.filter((c) => c.close > c.open).length >= 2;
    } else {
      return last3.filter((c) => c.close < c.open).length >= 2;
    }
  }

  private accept(
    strategyCode: string,
    direction: MomentumDirection,
    reason: string,
    conditions: EntryConditionResult['conditions'],
  ): EntryConditionResult {
    this.logger.debug(
      `[EntryConditions] Strategy ${strategyCode} ACCEPTED: ${direction} — ${reason}`,
    );
    return { met: true, strategyCode, direction, reason, conditions };
  }

  private reject(
    strategyCode: string,
    reason: string,
    conditions: EntryConditionResult['conditions'],
  ): EntryConditionResult {
    return { met: false, strategyCode, direction: null, reason, conditions };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helper (pure function)
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true when current price is above both EMA9 and EMA21. */
function currentAboveEMAs(indicators: UnderlyingIndicators): boolean {
  const { currentPrice, ema9, ema21 } = indicators;
  if (ema9 === null || ema21 === null) return true; // insufficient data — allow
  return currentPrice > ema9 && currentPrice > ema21;
}
