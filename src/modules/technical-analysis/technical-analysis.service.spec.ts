/**
 * technical-analysis.service.spec.ts
 *
 * Unit tests for TechnicalAnalysisService.
 *
 * Covers:
 *  1. VWAP — correct computation for a known fixture; null on empty input.
 *  2. ATR  — null when candles < period + 1; correct value for known fixture.
 *  3. EMA(9) — correct computation for a known 10-candle sequence.
 *  4. EMA edge cases — null below minimum candles; exact period boundary.
 *  5. RSI  — always in [0, 100]; correct extremes (all-up → 100, all-down → 0).
 *  6. ORB  — correctly identifies candles within the first 15-minute window;
 *            null when no candles fall in the window.
 *  7. MACD — null when insufficient candles; structure check on valid input.
 *  8. Support/Resistance — swing detection; fallback when no swing points.
 *  9. Relative Volume — correct ratio; null for single-session input.
 *
 * No mocks — all tests operate against real TechnicalAnalysisService logic.
 *
 * Requirements: 5.2, 6.2
 */

import { Test, TestingModule } from '@nestjs/testing';
import { TechnicalAnalysisService } from './technical-analysis.service';
import { OHLCV } from './technical-analysis.types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/** Build a single OHLCV candle with a fixed timestamp. */
function candle(
  close: number,
  opts: Partial<Omit<OHLCV, 'close' | 'timestamp'>> & { tsOffset?: number } = {},
): OHLCV {
  return {
    open: opts.open ?? close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: opts.volume ?? 1_000,
    timestamp: new Date(1_700_000_000_000 + (opts.tsOffset ?? 0)),
  };
}

/**
 * Build `n` candles with linearly increasing closes starting from `start`.
 * Timestamps are 1-minute apart beginning from baseMs.
 */
function linearCandles(n: number, start: number, step = 1, baseMs = 1_700_000_000_000): OHLCV[] {
  return Array.from({ length: n }, (_, i) => ({
    open: start + i * step,
    high: start + i * step + 1,
    low: start + i * step - 1,
    close: start + i * step,
    volume: 1_000,
    timestamp: new Date(baseMs + i * 60_000),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('TechnicalAnalysisService', () => {
  let service: TechnicalAnalysisService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TechnicalAnalysisService],
    }).compile();

    service = module.get<TechnicalAnalysisService>(TechnicalAnalysisService);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. VWAP
  // ───────────────────────────────────────────────────────────────────────────

  describe('computeVWAP()', () => {
    it('returns null for an empty candle array', () => {
      expect(service.computeVWAP([])).toBeNull();
    });

    it('returns null when total volume is zero', () => {
      const candles: OHLCV[] = [
        { open: 10, high: 12, low: 8, close: 10, volume: 0, timestamp: new Date() },
        { open: 20, high: 22, low: 18, close: 20, volume: 0, timestamp: new Date() },
      ];
      expect(service.computeVWAP(candles)).toBeNull();
    });

    it('computes VWAP correctly for a simple two-candle fixture', () => {
      /**
       * c1: h=10, l=10, c=10, v=100 → typical_price=10, pv=1000
       * c2: h=20, l=20, c=20, v=100 → typical_price=20, pv=2000
       * VWAP = 3000 / 200 = 15
       */
      const candles: OHLCV[] = [
        { open: 10, high: 10, low: 10, close: 10, volume: 100, timestamp: new Date() },
        { open: 20, high: 20, low: 20, close: 20, volume: 100, timestamp: new Date() },
      ];
      expect(service.computeVWAP(candles)).toBeCloseTo(15, 6);
    });

    it('computes VWAP correctly for a three-candle fixture with unequal volumes', () => {
      /**
       * c1: h=110, l=90,  c=100, v=200 → tp=100,  pv=20000
       * c2: h=115, l=105, c=110, v=100 → tp=110,  pv=11000
       * c3: h=120, l=110, c=115, v=300 → tp=115,  pv=34500
       * VWAP = (20000+11000+34500) / (200+100+300) = 65500 / 600 ≈ 109.1667
       */
      const candles: OHLCV[] = [
        { open: 100, high: 110, low: 90, close: 100, volume: 200, timestamp: new Date() },
        { open: 110, high: 115, low: 105, close: 110, volume: 100, timestamp: new Date() },
        { open: 115, high: 120, low: 110, close: 115, volume: 300, timestamp: new Date() },
      ];
      // tp1 = (110+90+100)/3  = 300/3 = 100    → pv = 100 × 200 = 20000
      // tp2 = (115+105+110)/3 = 330/3 = 110    → pv = 110 × 100 = 11000
      // tp3 = (120+110+115)/3 = 345/3 = 115    → pv = 115 × 300 = 34500
      // VWAP = (20000 + 11000 + 34500) / (200 + 100 + 300) = 65500 / 600 ≈ 109.1667
      const expected = (100 * 200 + 110 * 100 + 115 * 300) / (200 + 100 + 300);
      expect(service.computeVWAP(candles)).toBeCloseTo(expected, 4);
    });

    it('returns the typical price when only one candle is supplied', () => {
      const c: OHLCV = {
        open: 100,
        high: 120,
        low: 80,
        close: 110,
        volume: 500,
        timestamp: new Date(),
      };
      // VWAP = typical_price = (120+80+110)/3 ≈ 103.333
      const expected = (120 + 80 + 110) / 3;
      expect(service.computeVWAP([c])).toBeCloseTo(expected, 6);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. ATR
  // ───────────────────────────────────────────────────────────────────────────

  describe('computeATR()', () => {
    it('returns null when candles < period + 1 (default period 14)', () => {
      const candles = linearCandles(14, 100); // exactly period, not period+1
      expect(service.computeATR(candles)).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(service.computeATR([])).toBeNull();
    });

    it('returns null when candles < period + 1 for a custom period', () => {
      const candles = linearCandles(5, 100); // period=5 needs 6 candles
      expect(service.computeATR(candles, 5)).toBeNull();
    });

    it('computes ATR correctly for a known period-2 fixture', () => {
      /**
       * Candles (oldest first):
       *   c0: h=12, l=8,  c=10  (prev for c1)
       *   c1: h=14, l=9,  c=11  TR=max(14-9=5, |14-10|=4, |9-10|=1) = 5
       *   c2: h=13, l=7,  c=9   TR=max(13-7=6, |13-11|=2, |7-11|=4) = 6
       * ATR(2) = (5+6)/2 = 5.5
       */
      const candles: OHLCV[] = [
        { open: 10, high: 12, low: 8, close: 10, volume: 1000, timestamp: new Date() },
        { open: 11, high: 14, low: 9, close: 11, volume: 1000, timestamp: new Date() },
        { open: 9, high: 13, low: 7, close: 9, volume: 1000, timestamp: new Date() },
      ];
      expect(service.computeATR(candles, 2)).toBeCloseTo(5.5, 6);
    });

    it('computes ATR with Wilder smoothing for a 4-candle period-2 fixture', () => {
      /**
       * c0: h=12, l=8, c=10
       * c1: h=14, l=9, c=11   TR=5 (seeded)
       * c2: h=13, l=7, c=9    TR=6 (seeded)
       * ATR seed = (5+6)/2 = 5.5
       * c3: h=15, l=8, c=12   TR=max(15-8=7, |15-9|=6, |8-9|=1) = 7
       * ATR(2) = (5.5*(2-1) + 7) / 2 = (5.5+7)/2 = 6.25
       */
      const candles: OHLCV[] = [
        { open: 10, high: 12, low: 8, close: 10, volume: 1000, timestamp: new Date() },
        { open: 11, high: 14, low: 9, close: 11, volume: 1000, timestamp: new Date() },
        { open: 9, high: 13, low: 7, close: 9, volume: 1000, timestamp: new Date() },
        { open: 12, high: 15, low: 8, close: 12, volume: 1000, timestamp: new Date() },
      ];
      expect(service.computeATR(candles, 2)).toBeCloseTo(6.25, 6);
    });

    it('returns a positive number for a valid candle series', () => {
      const candles = linearCandles(20, 100);
      const atr = service.computeATR(candles);
      expect(atr).not.toBeNull();
      expect(atr!).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. EMA
  // ───────────────────────────────────────────────────────────────────────────

  describe('computeEMA()', () => {
    it('returns null when candles < period', () => {
      const candles = linearCandles(8, 1); // period=9, need 9
      expect(service.computeEMA(candles, 9)).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(service.computeEMA([], 9)).toBeNull();
    });

    it('computes EMA(9) correctly for a known 10-candle sequence', () => {
      /**
       * Closes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 19]
       * Seed SMA(9) = (1+2+…+9)/9 = 45/9 = 5
       * k = 2/(9+1) = 0.2
       * EMA at candle 10 = 19×0.2 + 5×0.8 = 3.8 + 4.0 = 7.8
       */
      const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 19];
      const candles: OHLCV[] = closes.map((c) => ({
        open: c,
        high: c,
        low: c,
        close: c,
        volume: 1000,
        timestamp: new Date(),
      }));
      expect(service.computeEMA(candles, 9)).toBeCloseTo(7.8, 6);
    });

    it('returns exactly the SMA when only `period` candles are provided', () => {
      // With exactly 9 candles, the seed SMA is returned (no further EMA steps).
      const candles: OHLCV[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => ({
        open: c,
        high: c,
        low: c,
        close: c,
        volume: 1000,
        timestamp: new Date(),
      }));
      // SMA = 45/9 = 5
      expect(service.computeEMA(candles, 9)).toBeCloseTo(5, 6);
    });

    it('returns the close price when all candles have the same close', () => {
      // EMA of identical values = that value.
      const candles = Array.from({ length: 20 }, () => ({
        open: 50,
        high: 50,
        low: 50,
        close: 50,
        volume: 1000,
        timestamp: new Date(),
      }));
      expect(service.computeEMA(candles, 9)).toBeCloseTo(50, 6);
    });

    it('supports EMA(200) returning null when fewer than 200 candles', () => {
      const candles = linearCandles(199, 100);
      expect(service.computeEMA(candles, 200)).toBeNull();
    });

    it('supports EMA(200) returning a value when exactly 200 candles are supplied', () => {
      const candles = linearCandles(200, 100);
      const ema = service.computeEMA(candles, 200);
      expect(ema).not.toBeNull();
      expect(typeof ema).toBe('number');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. RSI
  // ───────────────────────────────────────────────────────────────────────────

  describe('computeRSI()', () => {
    it('returns null when candles < period + 1 (default 14)', () => {
      const candles = linearCandles(14, 100); // exactly period, need period+1
      expect(service.computeRSI(candles)).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(service.computeRSI([])).toBeNull();
    });

    it('returns 100 when all candles are up-days (no losses)', () => {
      // 15 candles of strictly increasing closes.
      const candles = linearCandles(15, 100, 1);
      expect(service.computeRSI(candles, 14)).toBe(100);
    });

    it('returns 0 when all candles are down-days (no gains)', () => {
      // 15 candles of strictly decreasing closes.
      const candles = linearCandles(15, 100 + 14, -1); // 114, 113, …, 100
      expect(service.computeRSI(candles, 14)).toBe(0);
    });

    it('returns a value within [0, 100] for a mixed candle series', () => {
      // Alternating up/down candles.
      const closes = [100, 102, 99, 103, 98, 104, 97, 105, 96, 106, 95, 107, 94, 108, 93];
      const candles: OHLCV[] = closes.map((c) => ({
        open: c,
        high: c + 1,
        low: c - 1,
        close: c,
        volume: 1000,
        timestamp: new Date(),
      }));
      const rsi = service.computeRSI(candles, 14);
      expect(rsi).not.toBeNull();
      expect(rsi!).toBeGreaterThanOrEqual(0);
      expect(rsi!).toBeLessThanOrEqual(100);
    });

    it('returns a value within [0, 100] for a long random-walk series', () => {
      // Build a 50-candle series with a realistic-looking walk.
      const closes: number[] = [100];
      for (let i = 1; i < 50; i++) {
        // Alternate up/down with varying magnitudes.
        closes.push(closes[i - 1] + (i % 3 === 0 ? -2 : 1));
      }
      const candles: OHLCV[] = closes.map((c) => ({
        open: c,
        high: c + 1,
        low: c - 1,
        close: c,
        volume: 1000,
        timestamp: new Date(),
      }));
      const rsi = service.computeRSI(candles, 14);
      expect(rsi).not.toBeNull();
      expect(rsi!).toBeGreaterThanOrEqual(0);
      expect(rsi!).toBeLessThanOrEqual(100);
    });

    it('works correctly with a custom period of 9', () => {
      const candles = linearCandles(20, 100, 1);
      const rsi = service.computeRSI(candles, 9);
      // All up-days → RSI should be 100.
      expect(rsi).toBe(100);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. ORB Range
  // ───────────────────────────────────────────────────────────────────────────

  describe('computeORBRange()', () => {
    /**
     * Session starts at 09:15 IST (UTC 03:45) — represented here as
     * baseMs for simplicity.  Candle timestamps are baseMs + minute offsets.
     */
    const baseMs = 1_700_000_000_000; // arbitrary epoch
    const sessionStart = new Date(baseMs);

    it('returns null when no candles fall within the ORB window', () => {
      // All candles are 20 minutes after session start — outside 15-min window.
      const candles: OHLCV[] = [
        {
          open: 100,
          high: 110,
          low: 90,
          close: 100,
          volume: 1000,
          timestamp: new Date(baseMs + 20 * 60_000),
        },
      ];
      expect(service.computeORBRange(candles, sessionStart)).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(service.computeORBRange([], sessionStart)).toBeNull();
    });

    it('correctly identifies candles within the first 15-minute window', () => {
      /**
       * ORB window: [baseMs, baseMs + 15 min)
       *   c1 @  0 min: h=100, l=95   (IN)
       *   c2 @  5 min: h=105, l=98   (IN)
       *   c3 @ 10 min: h=102, l=97   (IN)
       *   c4 @ 15 min: h=110, l=100  (OUT — exactly at end of window)
       *   c5 @ 20 min: h=108, l=103  (OUT)
       *
       * Expected: orbHigh = max(100,105,102) = 105, orbLow = min(95,98,97) = 95
       */
      const candles: OHLCV[] = [
        {
          open: 97,
          high: 100,
          low: 95,
          close: 98,
          volume: 1000,
          timestamp: new Date(baseMs + 0 * 60_000),
        },
        {
          open: 100,
          high: 105,
          low: 98,
          close: 104,
          volume: 1200,
          timestamp: new Date(baseMs + 5 * 60_000),
        },
        {
          open: 104,
          high: 102,
          low: 97,
          close: 100,
          volume: 900,
          timestamp: new Date(baseMs + 10 * 60_000),
        },
        {
          open: 100,
          high: 110,
          low: 100,
          close: 108,
          volume: 1500,
          timestamp: new Date(baseMs + 15 * 60_000),
        },
        {
          open: 108,
          high: 108,
          low: 103,
          close: 105,
          volume: 800,
          timestamp: new Date(baseMs + 20 * 60_000),
        },
      ];
      const result = service.computeORBRange(candles, sessionStart);
      expect(result).not.toBeNull();
      expect(result!.orbHigh).toBe(105);
      expect(result!.orbLow).toBe(95);
    });

    it('includes a candle exactly at sessionStart (boundary inclusive)', () => {
      const candles: OHLCV[] = [
        { open: 100, high: 102, low: 98, close: 101, volume: 500, timestamp: new Date(baseMs) },
      ];
      const result = service.computeORBRange(candles, sessionStart);
      expect(result).not.toBeNull();
      expect(result!.orbHigh).toBe(102);
      expect(result!.orbLow).toBe(98);
    });

    it('excludes a candle exactly at sessionStart + 15 minutes (boundary exclusive)', () => {
      const candles: OHLCV[] = [
        // Only candle is at exactly 15 min — outside the window.
        {
          open: 100,
          high: 120,
          low: 80,
          close: 110,
          volume: 1000,
          timestamp: new Date(baseMs + 15 * 60_000),
        },
      ];
      expect(service.computeORBRange(candles, sessionStart)).toBeNull();
    });

    it('orbHigh >= orbLow always holds', () => {
      const candles: OHLCV[] = [
        {
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1000,
          timestamp: new Date(baseMs + 1 * 60_000),
        },
        {
          open: 100,
          high: 103,
          low: 97,
          close: 101,
          volume: 1000,
          timestamp: new Date(baseMs + 3 * 60_000),
        },
      ];
      const result = service.computeORBRange(candles, sessionStart)!;
      expect(result.orbHigh).toBeGreaterThanOrEqual(result.orbLow);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. MACD
  // ───────────────────────────────────────────────────────────────────────────

  describe('computeMACD()', () => {
    it('returns null when candles < 34 (minimum for 12/26/9)', () => {
      const candles = linearCandles(33, 100);
      expect(service.computeMACD(candles)).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(service.computeMACD([])).toBeNull();
    });

    it('returns a valid result structure for ≥ 34 candles', () => {
      const candles = linearCandles(50, 100);
      const result = service.computeMACD(candles);
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('macd');
      expect(result).toHaveProperty('signal');
      expect(result).toHaveProperty('histogram');
    });

    it('histogram equals macd minus signal', () => {
      const candles = linearCandles(50, 100);
      const result = service.computeMACD(candles)!;
      expect(result.histogram).toBeCloseTo(result.macd - result.signal, 10);
    });

    it('returns a non-null result for exactly 34 candles', () => {
      const candles = linearCandles(34, 100);
      expect(service.computeMACD(candles)).not.toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Support / Resistance
  // ───────────────────────────────────────────────────────────────────────────

  describe('computeSupportResistance()', () => {
    it('returns null when fewer than 3 candles are supplied', () => {
      expect(service.computeSupportResistance([])).toBeNull();
      expect(service.computeSupportResistance([candle(100)])).toBeNull();
      expect(service.computeSupportResistance([candle(100), candle(102)])).toBeNull();
    });

    it('identifies swing high and swing low from a simple fixture', () => {
      /**
       * Highs:  [100, 120, 110]   — candle 1 (index 1) is a swing high at h=120
       * Lows:   [90,   85, 95]   — candle 1 (index 1) is a swing low  at l=85
       *
       * resistance = 120, support = 85
       */
      const candles: OHLCV[] = [
        { open: 95, high: 100, low: 90, close: 95, volume: 1000, timestamp: new Date() },
        { open: 115, high: 120, low: 85, close: 115, volume: 1000, timestamp: new Date() },
        { open: 105, high: 110, low: 95, close: 105, volume: 1000, timestamp: new Date() },
      ];
      const result = service.computeSupportResistance(candles)!;
      expect(result.resistance).toBe(120);
      expect(result.support).toBe(85);
    });

    it('falls back to overall range high/low when no swing points exist', () => {
      // Monotonically increasing — no swing points detectable.
      const candles = linearCandles(5, 100, 5);
      const result = service.computeSupportResistance(candles)!;
      // Resistance = overall max high; Support = overall min low.
      expect(result.resistance).toBe(Math.max(...candles.map((c) => c.high)));
      expect(result.support).toBe(Math.min(...candles.map((c) => c.low)));
    });

    it('support is always ≤ resistance', () => {
      const candles = linearCandles(10, 100, 2);
      const result = service.computeSupportResistance(candles)!;
      expect(result.support).toBeLessThanOrEqual(result.resistance);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Relative Volume
  // ───────────────────────────────────────────────────────────────────────────

  describe('computeRelativeVolume()', () => {
    /**
     * Build a multi-day fixture: day 1 has `day1Vol` total volume,
     * day 2 has `day2Vol`, day 3 has `day3Vol`.
     */
    function multiDayCandles(volumes: number[]): OHLCV[] {
      const result: OHLCV[] = [];
      const dayMs = 24 * 60 * 60 * 1_000;

      volumes.forEach((vol, dayIdx) => {
        // One candle per day (representing total session volume).
        result.push({
          open: 100,
          high: 105,
          low: 95,
          close: 100,
          volume: vol,
          // Use dates far apart to ensure distinct date strings.
          timestamp: new Date(1_700_000_000_000 + dayIdx * dayMs),
        });
      });

      return result;
    }

    it('returns null for an empty array', () => {
      expect(service.computeRelativeVolume([], 5)).toBeNull();
    });

    it('returns null when lookbackDays ≤ 0', () => {
      const candles = multiDayCandles([1000, 2000, 3000]);
      expect(service.computeRelativeVolume(candles, 0)).toBeNull();
    });

    it('returns null when only a single session is present', () => {
      const candles = multiDayCandles([5000]);
      expect(service.computeRelativeVolume(candles, 5)).toBeNull();
    });

    it('computes correct relative volume (current = 2× historical average)', () => {
      /**
       * day 1: 1000 (historical baseline)
       * day 2: 2000 (current session)
       * lookback = 1 → avg = 1000
       * relVol = 2000 / 1000 = 2.0
       */
      const candles = multiDayCandles([1000, 2000]);
      expect(service.computeRelativeVolume(candles, 1)).toBeCloseTo(2.0, 6);
    });

    it('averages correctly over multiple lookback days', () => {
      /**
       * days 1,2: 1000, 3000 → avg = 2000
       * day 3 (current): 4000
       * lookback = 2 → relVol = 4000 / 2000 = 2.0
       */
      const candles = multiDayCandles([1000, 3000, 4000]);
      expect(service.computeRelativeVolume(candles, 2)).toBeCloseTo(2.0, 6);
    });

    it('caps historical lookback at available sessions', () => {
      /**
       * Only 2 historical sessions available even though lookback=10.
       * days 1,2: 1000, 2000 → avg = 1500
       * day 3 (current): 3000
       * relVol = 3000 / 1500 = 2.0
       */
      const candles = multiDayCandles([1000, 2000, 3000]);
      expect(service.computeRelativeVolume(candles, 10)).toBeCloseTo(2.0, 6);
    });

    it('returns null when historical average volume is zero', () => {
      const candles = multiDayCandles([0, 1000]); // historical day has 0 volume
      expect(service.computeRelativeVolume(candles, 1)).toBeNull();
    });
  });
});
