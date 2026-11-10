/**
 * technical-analysis.service.ts
 *
 * Stateless on-demand technical indicator computation service.
 *
 * Responsibilities (task 10.1):
 *  - Compute VWAP, ATR, EMA, Support/Resistance, ORB range, MACD, RSI, and
 *    Relative Volume from caller-provided OHLCV candle arrays.
 *  - No TypeORM injection — callers fetch candle data from the database and
 *    pass arrays directly to each method.
 *  - No persistent state — every method is a pure function: same inputs always
 *    produce the same output, with zero side-effects.
 *  - Return `null` when the candle array is too short to produce a meaningful
 *    result for the requested period.
 *
 * Consumers:
 *  - StrategyEngine (task 13) — reads indicators to evaluate entry conditions
 *  - MarketRegimeDetector (task 9) — reads VWAP deviation, ATR, relative volume
 *  - SignalScorer (task 15) — reads momentum and VWAP/trend alignment components
 *
 * Requirements: 5.2, 6.2
 */

import { Injectable, Logger } from '@nestjs/common';
import { MACDResult, OHLCV, ORBResult, SupportResistanceResult } from './technical-analysis.types';

/** Duration of the Opening Range window in milliseconds (15 minutes). */
const ORB_WINDOW_MS = 15 * 60 * 1_000;

/** Standard MACD fast / slow / signal periods. */
const MACD_FAST_PERIOD = 12;
const MACD_SLOW_PERIOD = 26;
const MACD_SIGNAL_PERIOD = 9;

/**
 * Minimum candles required to produce at least one MACD signal value:
 *   MACD_SLOW_PERIOD + MACD_SIGNAL_PERIOD − 1 = 34
 */
const MACD_MIN_CANDLES = MACD_SLOW_PERIOD + MACD_SIGNAL_PERIOD - 1;

@Injectable()
export class TechnicalAnalysisService {
  private readonly logger = new Logger(TechnicalAnalysisService.name);

  // ───────────────────────────────────────────────────────────────────────────
  // 1. VWAP — Volume Weighted Average Price
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute the VWAP (Volume Weighted Average Price) for the given candle set.
   *
   * Formula:
   *   typical_price = (high + low + close) / 3
   *   VWAP = Σ(typical_price × volume) / Σ(volume)
   *
   * Intended to be called with the full intraday candle set for the current
   * session (i.e. all candles since market open at 09:15 IST).
   *
   * @param candles - Array of intraday OHLCV candles, oldest first.
   * @returns VWAP price, or `null` when the array is empty or total volume = 0.
   *
   * Requirements: 5.2
   */
  computeVWAP(candles: OHLCV[]): number | null {
    if (candles.length === 0) {
      this.logger.debug('computeVWAP: no candles supplied — returning null');
      return null;
    }

    let sumPV = 0;
    let sumV = 0;

    for (const c of candles) {
      const typicalPrice = (c.high + c.low + c.close) / 3;
      sumPV += typicalPrice * c.volume;
      sumV += c.volume;
    }

    if (sumV === 0) {
      this.logger.debug('computeVWAP: total volume is zero — returning null');
      return null;
    }

    return sumPV / sumV;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. ATR — Average True Range (Wilder's smoothing)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute the ATR (Average True Range) using Wilder's smoothing method.
   *
   * True Range for candle i = max(
   *   high[i] − low[i],
   *   |high[i] − close[i−1]|,
   *   |low[i]  − close[i−1]|
   * )
   *
   * The first ATR value is the simple average of the first `period` TR values;
   * subsequent values use Wilder's smoothing:
   *   ATR[n] = (ATR[n−1] × (period−1) + TR[n]) / period
   *
   * @param candles - OHLCV candles, oldest first. Requires ≥ period + 1 candles.
   * @param period  - Smoothing period (default: 14).
   * @returns Latest ATR value, or `null` when there are fewer than period + 1 candles.
   *
   * Requirements: 5.2
   */
  computeATR(candles: OHLCV[], period = 14): number | null {
    if (candles.length < period + 1) {
      this.logger.debug(
        `computeATR: need ≥ ${period + 1} candles, got ${candles.length} — returning null`,
      );
      return null;
    }

    // Build the True Range series (length = candles.length − 1).
    const trValues: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i];
      const prevClose = candles[i - 1].close;
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prevClose),
        Math.abs(curr.low - prevClose),
      );
      trValues.push(tr);
    }

    // Seed ATR with the SMA of the first `period` TR values.
    let atr = trValues.slice(0, period).reduce((acc, v) => acc + v, 0) / period;

    // Apply Wilder's smoothing for the remaining TR values.
    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return atr;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. EMA — Exponential Moving Average
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute the latest EMA (Exponential Moving Average) for the given period.
   *
   * The seed value is the SMA of the first `period` candles; subsequent values
   * use the standard EMA multiplier:
   *   k   = 2 / (period + 1)
   *   EMA = close × k + prevEMA × (1 − k)
   *
   * Supports all required periods: 9, 21, 50, 200.
   *
   * @param candles - OHLCV candles, oldest first. Requires ≥ period candles.
   * @param period  - EMA period (e.g. 9, 21, 50, 200).
   * @returns Latest EMA value, or `null` when there are fewer than `period` candles.
   *
   * Requirements: 5.2, 6.2
   */
  computeEMA(candles: OHLCV[], period: number): number | null {
    if (candles.length < period) {
      this.logger.debug(
        `computeEMA(${period}): need ≥ ${period} candles, got ${candles.length} — returning null`,
      );
      return null;
    }

    const k = 2 / (period + 1);

    // Seed: SMA of the first `period` closes.
    let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;

    // Apply EMA for all subsequent candles.
    for (let i = period; i < candles.length; i++) {
      ema = candles[i].close * k + ema * (1 - k);
    }

    return ema;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Support / Resistance — Swing high/low method
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Identify the nearest support and resistance levels from swing highs/lows.
   *
   * A swing high is a candle whose high exceeds both its immediate neighbours.
   * A swing low  is a candle whose low is below both its immediate neighbours.
   *
   * - Resistance = the highest swing-high found in `candles`.
   * - Support    = the lowest  swing-low  found in `candles`.
   *
   * Falls back to the overall range high/low when no swing points are detected
   * (e.g. a monotonic trend with no retracements).
   *
   * @param candles - OHLCV candles, oldest first. Requires ≥ 3 candles.
   * @returns `{ support, resistance }`, or `null` when fewer than 3 candles supplied.
   *
   * Requirements: 5.2
   */
  computeSupportResistance(candles: OHLCV[]): SupportResistanceResult | null {
    if (candles.length < 3) {
      this.logger.debug('computeSupportResistance: need ≥ 3 candles — returning null');
      return null;
    }

    const swingHighs: number[] = [];
    const swingLows: number[] = [];

    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const curr = candles[i];
      const next = candles[i + 1];

      if (curr.high > prev.high && curr.high > next.high) {
        swingHighs.push(curr.high);
      }
      if (curr.low < prev.low && curr.low < next.low) {
        swingLows.push(curr.low);
      }
    }

    // Fall back to overall range when no swing points are detected.
    const resistance =
      swingHighs.length > 0 ? Math.max(...swingHighs) : Math.max(...candles.map((c) => c.high));

    const support =
      swingLows.length > 0 ? Math.min(...swingLows) : Math.min(...candles.map((c) => c.low));

    return { support, resistance };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. ORB Range — Opening Range Breakout (first 15-minute high/low)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute the Opening Range Breakout (ORB) high and low from the first
   * 15-minute window of the trading session.
   *
   * Any candle whose `timestamp` falls in the half-open interval
   *   [sessionStart, sessionStart + 15 min)
   * is included in the ORB window.
   *
   * @param candles      - Full intraday OHLCV candle array, oldest first.
   * @param sessionStart - UTC timestamp of the session open (typically 09:15 IST).
   * @returns `{ orbHigh, orbLow }`, or `null` when no candles fall in the ORB window.
   *
   * Requirements: 5.2, 6.2
   */
  computeORBRange(candles: OHLCV[], sessionStart: Date): ORBResult | null {
    const startMs = sessionStart.getTime();
    const endMs = startMs + ORB_WINDOW_MS;

    const orbCandles = candles.filter((c) => {
      const ts = c.timestamp.getTime();
      return ts >= startMs && ts < endMs;
    });

    if (orbCandles.length === 0) {
      this.logger.debug(
        'computeORBRange: no candles within the 15-minute ORB window — returning null',
      );
      return null;
    }

    const orbHigh = Math.max(...orbCandles.map((c) => c.high));
    const orbLow = Math.min(...orbCandles.map((c) => c.low));

    return { orbHigh, orbLow };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 6. MACD — Moving Average Convergence Divergence (12 / 26 / 9)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute the standard MACD indicator (12/26/9 configuration).
   *
   *   MACD line   = EMA(12) − EMA(26)   (applied to close prices)
   *   Signal line = EMA(9)  of MACD line
   *   Histogram   = MACD − Signal
   *
   * Minimum candle requirement:
   *   MACD_SLOW_PERIOD (26) + MACD_SIGNAL_PERIOD (9) − 1 = 34 candles.
   *
   * @param candles - OHLCV candles, oldest first. Requires ≥ 34 candles.
   * @returns Latest `{ macd, signal, histogram }`, or `null` when insufficient data.
   *
   * Requirements: 5.2, 6.2
   */
  computeMACD(candles: OHLCV[]): MACDResult | null {
    if (candles.length < MACD_MIN_CANDLES) {
      this.logger.debug(
        `computeMACD: need ≥ ${MACD_MIN_CANDLES} candles, got ${candles.length} — returning null`,
      );
      return null;
    }

    const closes = candles.map((c) => c.close);

    // Full EMA series for fast (12) and slow (26) periods.
    // ema12Series[j] corresponds to candle index (MACD_FAST_PERIOD − 1) + j = 11 + j
    // ema26Series[j] corresponds to candle index (MACD_SLOW_PERIOD − 1) + j = 25 + j
    const ema12Series = this.computeEMASeries(closes, MACD_FAST_PERIOD);
    const ema26Series = this.computeEMASeries(closes, MACD_SLOW_PERIOD);

    // Align both series at the first candle where EMA26 is defined (index 25).
    // For ema12Series: index (25 − 11) = 14 aligns with ema26Series[0].
    const ema12Offset = MACD_SLOW_PERIOD - MACD_FAST_PERIOD; // = 14

    const macdValues: number[] = [];
    for (let j = 0; j < ema26Series.length; j++) {
      macdValues.push(ema12Series[ema12Offset + j] - ema26Series[j]);
    }

    // Signal = EMA(9) of the MACD line values.
    const signalSeries = this.computeEMASeriesFromValues(macdValues, MACD_SIGNAL_PERIOD);

    if (signalSeries.length === 0) {
      // This branch is unreachable given the minimum candle check, but kept for safety.
      return null;
    }

    const latestMacd = macdValues[macdValues.length - 1];
    const latestSignal = signalSeries[signalSeries.length - 1];

    return {
      macd: latestMacd,
      signal: latestSignal,
      histogram: latestMacd - latestSignal,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 7. RSI — Relative Strength Index (Wilder's smoothing)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute the RSI (Relative Strength Index) using Wilder's smoothing.
   *
   * Step 1 — Seed with SMA of first `period` gains / losses.
   * Step 2 — Apply Wilder's smoothing for subsequent candles.
   *   RS  = avgGain / avgLoss
   *   RSI = 100 − (100 / (1 + RS))
   *
   * Special cases:
   *   - avgLoss = 0 (all up days) → RSI = 100
   *   - avgGain = 0 (all down days) → RSI = 0
   *
   * @param candles - OHLCV candles, oldest first. Requires ≥ period + 1 candles.
   * @param period  - RSI period (default: 14).
   * @returns RSI value in [0, 100], or `null` when fewer than period + 1 candles supplied.
   *
   * Requirements: 5.2
   */
  computeRSI(candles: OHLCV[], period = 14): number | null {
    if (candles.length < period + 1) {
      this.logger.debug(
        `computeRSI: need ≥ ${period + 1} candles, got ${candles.length} — returning null`,
      );
      return null;
    }

    const closes = candles.map((c) => c.close);

    // Seed: SMA of first `period` gains and losses.
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
      const delta = closes[i] - closes[i - 1];
      if (delta > 0) {
        avgGain += delta;
      } else {
        avgLoss += Math.abs(delta);
      }
    }

    avgGain /= period;
    avgLoss /= period;

    // Wilder's smoothing for subsequent closes.
    for (let i = period + 1; i < closes.length; i++) {
      const delta = closes[i] - closes[i - 1];
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? Math.abs(delta) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    if (avgGain === 0) return 0;

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Relative Volume
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute relative volume: current session volume divided by average daily
   * volume over the configured lookback period.
   *
   *   relVol = currentSessionVolume / avgDailyVolumeOverLookback
   *
   * Candles are grouped by calendar date (UTC) to isolate individual sessions.
   * The most recent date is treated as the current session; up to `lookbackDays`
   * prior sessions form the historical baseline.
   *
   * A value > 1.0 indicates above-average activity; < 1.0 below average.
   *
   * @param candles      - Multi-day OHLCV candles, any order (grouped internally).
   * @param lookbackDays - Number of prior sessions to average (must be ≥ 1).
   * @returns Relative volume ratio, or `null` when there is insufficient history.
   *
   * Requirements: 5.2
   */
  computeRelativeVolume(candles: OHLCV[], lookbackDays: number): number | null {
    if (candles.length === 0 || lookbackDays <= 0) {
      this.logger.debug(
        'computeRelativeVolume: empty candle array or invalid lookback — returning null',
      );
      return null;
    }

    // Group candles by UTC date string (YYYY-MM-DD).
    const dayMap = new Map<string, OHLCV[]>();
    for (const c of candles) {
      const dateKey = c.timestamp.toISOString().split('T')[0];
      if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
      dayMap.get(dateKey)!.push(c);
    }

    const sortedDates = [...dayMap.keys()].sort();

    // Need at least 2 dates: 1 current + 1 historical.
    if (sortedDates.length < 2) {
      this.logger.debug('computeRelativeVolume: fewer than 2 distinct sessions — returning null');
      return null;
    }

    // Current session = last (most recent) date.
    const currentDate = sortedDates[sortedDates.length - 1];
    const currentVolume = dayMap.get(currentDate)!.reduce((sum, c) => sum + c.volume, 0);

    // Historical baseline = up to `lookbackDays` sessions before current.
    const historicalDates = sortedDates
      .slice(0, -1) // exclude current date
      .slice(-lookbackDays); // take at most lookbackDays recent sessions

    if (historicalDates.length === 0) return null;

    const totalHistoricalVolume = historicalDates.reduce((sum, date) => {
      return sum + dayMap.get(date)!.reduce((sessionSum, c) => sessionSum + c.volume, 0);
    }, 0);

    const avgDailyVolume = totalHistoricalVolume / historicalDates.length;

    if (avgDailyVolume === 0) {
      this.logger.debug(
        'computeRelativeVolume: historical average volume is zero — returning null',
      );
      return null;
    }

    return currentVolume / avgDailyVolume;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private EMA helpers (shared by computeEMA, computeMACD)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Compute the full EMA series from a close-price array.
   *
   * Returns an array of length `(closes.length − period + 1)`:
   *   result[0] = SMA of closes[0..period−1]  (seeded value)
   *   result[j] = EMA at closes[period−1+j]   for j ≥ 1
   *
   * Returns an empty array if `closes.length < period`.
   *
   * @internal
   */
  private computeEMASeries(closes: number[], period: number): number[] {
    if (closes.length < period) return [];

    const k = 2 / (period + 1);
    const result: number[] = [];

    // Seed value.
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(ema);

    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      result.push(ema);
    }

    return result;
  }

  /**
   * Compute the full EMA series from an arbitrary numeric array (e.g. MACD values).
   *
   * Identical to `computeEMASeries` but accepts `number[]` instead of close prices.
   *
   * @internal
   */
  private computeEMASeriesFromValues(values: number[], period: number): number[] {
    if (values.length < period) return [];

    const k = 2 / (period + 1);
    const result: number[] = [];

    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(ema);

    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      result.push(ema);
    }

    return result;
  }
}
