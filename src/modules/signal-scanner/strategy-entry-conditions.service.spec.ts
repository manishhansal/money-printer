/**
 * strategy-entry-conditions.service.spec.ts
 *
 * Tests for StrategyEntryConditionsService — per-strategy entry-condition detection
 * on the UNDERLYING instrument (not the option premium).
 *
 * Covers:
 *  A — Opening Range Breakout: bullish break, bearish break, insufficient data
 *  B — VWAP Reclaim / Rejection: reclaim confirmed, rejection confirmed, sideways crossing
 *  C — Momentum Expansion: bull aligned, bear aligned, mixed signals
 *  D — Breakout and Retest: bullish retest pattern, no pattern
 *  E — Relative Strength: stock outperforming, underperforming, index (null RS)
 *  F — Trend Continuation: bullish pullback, bearish pullback, no trend
 *
 * Key invariants:
 *  - All conditions must use COMPLETED candles only (no look-ahead)
 *  - RSI checked on UNDERLYING close prices, not option premium
 *  - Each strategy returns a distinct direction or rejects independently
 *
 * Requirements: Phase 3 — Momentum Strategy Implementation (DEFECT-002 genuine fix)
 */

import {
  StrategyEntryConditionsService,
  UnderlyingIndicators,
} from './strategy-entry-conditions.service';
import { OHLCV } from '../technical-analysis/technical-analysis.types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCandles(closes: number[], base = 100): OHLCV[] {
  return closes.map((close, i) => ({
    open: base,
    high: Math.max(close, base) + 2,
    low: Math.min(close, base) - 2,
    close,
    volume: 10000 + i * 100,
    timestamp: new Date(Date.now() - (closes.length - i) * 60_000),
  }));
}

function baseIndicators(overrides: Partial<UnderlyingIndicators> = {}): UnderlyingIndicators {
  return {
    vwap: 100,
    ema9: 101,
    ema21: 100,
    ema50: 98,
    rsi: 60,
    macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
    adx: { adx: 25, plusDI: 30, minusDI: 15 },
    atr: 2.5,
    relVol: 1.5,
    roc: 1.2,
    orb: { orbHigh: 105, orbLow: 95, windowMinutes: 15 },
    prevDayHigh: 108,
    prevDayLow: 92,
    currentPrice: 107,
    relativeStrengthVsNifty: 1.2,
    candleCount1m: 60,
    candleCount5m: 25,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('StrategyEntryConditionsService', () => {
  let svc: StrategyEntryConditionsService;

  beforeEach(() => {
    svc = new StrategyEntryConditionsService();
  });

  // ─── Strategy A: Opening Range Breakout ──────────────────────────────────

  describe('evaluateORB (Strategy A)', () => {
    it('BULLISH: price above ORB high with volume confirms breakout', () => {
      const indicators = baseIndicators({
        orb: { orbHigh: 105, orbLow: 95, windowMinutes: 15 },
        currentPrice: 106.2, // > 105 × 1.001
        vwap: 103,
        relVol: 1.5,
      });
      // Last candle closes above ORB high
      const candles = makeCandles([97, 98, 99, 101, 103, 106.5]);
      const result = svc.evaluateORB(indicators, candles);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BULLISH');
      expect(result.strategyCode).toBe('A');
    });

    it('BEARISH: price below ORB low with volume confirms breakdown', () => {
      const indicators = baseIndicators({
        orb: { orbHigh: 105, orbLow: 95, windowMinutes: 15 },
        currentPrice: 94.0, // < 95 × 0.999
        vwap: 97,
        relVol: 1.4,
      });
      // Last candle closes below ORB low
      const candles = makeCandles([103, 101, 99, 97, 95.5, 93.8]);
      const result = svc.evaluateORB(indicators, candles);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BEARISH');
    });

    it('rejects when price is inside the ORB range', () => {
      const indicators = baseIndicators({
        orb: { orbHigh: 105, orbLow: 95, windowMinutes: 15 },
        currentPrice: 100,
        relVol: 1.5,
      });
      const candles = makeCandles([98, 99, 100, 101, 100, 100]);
      const result = svc.evaluateORB(indicators, candles);
      expect(result.met).toBe(false);
    });

    it('rejects when volume is below threshold', () => {
      const indicators = baseIndicators({
        orb: { orbHigh: 105, orbLow: 95, windowMinutes: 15 },
        currentPrice: 106.5,
        relVol: 0.8, // below 1.2 threshold
        vwap: 103,
      });
      const candles = makeCandles([98, 100, 102, 104, 105.5, 106.5]);
      const result = svc.evaluateORB(indicators, candles);
      expect(result.met).toBe(false);
    });

    it('rejects when ORB is null', () => {
      const indicators = baseIndicators({ orb: null, currentPrice: 106 });
      const result = svc.evaluateORB(indicators, makeCandles([100, 103, 106]));
      expect(result.met).toBe(false);
    });

    it('rejects when fewer than 3 candles available', () => {
      const indicators = baseIndicators({
        orb: { orbHigh: 105, orbLow: 95, windowMinutes: 15 },
        currentPrice: 108,
      });
      const result = svc.evaluateORB(indicators, makeCandles([106, 107]));
      expect(result.met).toBe(false);
    });
  });

  // ─── Strategy B: VWAP Reclaim / Rejection ────────────────────────────────

  describe('evaluateVWAPReclaim (Strategy B)', () => {
    it('BULLISH: prior candle below VWAP, current closes above VWAP', () => {
      const indicators = baseIndicators({
        vwap: 100,
        ema9: 100.5,
        ema21: 100,
        relVol: 1.3,
      });
      // Last 2 candles: prev below VWAP (99.5), curr above VWAP (100.3)
      const candles = makeCandles([98, 99, 99.5, 100.3]);
      const result = svc.evaluateVWAPReclaim(indicators, candles);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BULLISH');
      expect(result.strategyCode).toBe('B');
    });

    it('BEARISH: prior candle above VWAP, current closes below VWAP', () => {
      const indicators = baseIndicators({
        vwap: 100,
        ema9: 99.5,
        ema21: 100,
        relVol: 1.4,
      });
      const candles = makeCandles([102, 101, 100.5, 99.5]);
      const result = svc.evaluateVWAPReclaim(indicators, candles);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BEARISH');
    });

    it('rejects when candles remain on same side of VWAP (no cross)', () => {
      const indicators = baseIndicators({
        vwap: 100,
        relVol: 1.4,
      });
      // Both above VWAP — no reclaim pattern
      const candles = makeCandles([101, 102, 101.5, 102.5]);
      const result = svc.evaluateVWAPReclaim(indicators, candles);
      expect(result.met).toBe(false);
    });

    it('rejects when VWAP is null', () => {
      const indicators = baseIndicators({ vwap: null });
      const result = svc.evaluateVWAPReclaim(indicators, makeCandles([99, 100, 101]));
      expect(result.met).toBe(false);
    });
  });

  // ─── Strategy C: Momentum Expansion ──────────────────────────────────────

  describe('evaluateMomentumExpansion (Strategy C)', () => {
    it('BULLISH: RSI > 60, MACD expanding positive, ADX > 20, EMA stack bull', () => {
      const indicators = baseIndicators({
        rsi: 65,
        macd: { macd: 1.2, signal: 0.8, histogram: 0.4 },
        adx: { adx: 28, plusDI: 35, minusDI: 12 },
        ema9: 102,
        ema21: 100,
        currentPrice: 103,
        relVol: 1.5,
        atr: 2.5,
      });
      const result = svc.evaluateMomentumExpansion(indicators);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BULLISH');
      expect(result.strategyCode).toBe('C');
    });

    it('BEARISH: RSI < 40, MACD expanding negative, ADX > 20, EMA stack bear', () => {
      const indicators = baseIndicators({
        rsi: 35,
        macd: { macd: -1.5, signal: -0.8, histogram: -0.7 },
        adx: { adx: 26, plusDI: 10, minusDI: 32 },
        ema9: 98,
        ema21: 100,
        currentPrice: 97,
        relVol: 1.6,
        atr: 3.0,
      });
      const result = svc.evaluateMomentumExpansion(indicators);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BEARISH');
    });

    it('rejects when RSI is in neutral zone (50)', () => {
      const indicators = baseIndicators({
        rsi: 50,
        macd: { macd: 0.3, signal: 0.2, histogram: 0.1 },
        adx: { adx: 25, plusDI: 20, minusDI: 15 },
        relVol: 1.4,
      });
      const result = svc.evaluateMomentumExpansion(indicators);
      expect(result.met).toBe(false);
    });

    it('rejects when MACD histogram is negative in bull scenario', () => {
      const indicators = baseIndicators({
        rsi: 62,
        macd: { macd: 0.3, signal: 0.5, histogram: -0.2 }, // histogram negative
        adx: { adx: 25, plusDI: 30, minusDI: 10 },
        relVol: 1.5,
      });
      const result = svc.evaluateMomentumExpansion(indicators);
      expect(result.met).toBe(false);
    });

    it('rejects when RSI and MACD are null', () => {
      const indicators = baseIndicators({ rsi: null, macd: null });
      const result = svc.evaluateMomentumExpansion(indicators);
      expect(result.met).toBe(false);
    });
  });

  // ─── Strategy D: Breakout and Retest ─────────────────────────────────────

  describe('evaluateBreakoutRetest (Strategy D)', () => {
    it('rejects when fewer than 10 candles available', () => {
      const indicators = baseIndicators();
      const result = svc.evaluateBreakoutRetest(indicators, makeCandles([100, 101, 102]));
      expect(result.met).toBe(false);
      expect(result.strategyCode).toBe('D');
    });

    it('rejects when no key level has been broken and retested', () => {
      const indicators = baseIndicators({
        orb: { orbHigh: 105, orbLow: 95, windowMinutes: 15 },
        currentPrice: 100,
        relVol: 0.5, // low volume
      });
      // Sideways candles — no breakout pattern
      const candles = makeCandles([100, 101, 100, 101, 100, 99, 100, 101, 100, 100]);
      const result = svc.evaluateBreakoutRetest(indicators, candles);
      expect(result.met).toBe(false);
    });

    it('BULLISH: detects ORB high breakout → retest → continuation', () => {
      const indicators = baseIndicators({
        orb: { orbHigh: 100, orbLow: 90, windowMinutes: 15 },
        currentPrice: 102,
        relVol: 1.5,
      });
      // Pattern: break above 100, retest near 100, bounce
      const candles = makeCandles([97, 98, 99, 101.5, 100.5, 100.2, 100.8, 101, 101.5, 102]);
      const result = svc.evaluateBreakoutRetest(indicators, candles);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BULLISH');
    });
  });

  // ─── Strategy E: Relative Strength ───────────────────────────────────────

  describe('evaluateRelativeStrength (Strategy E)', () => {
    it('BULLISH: stock outperforming NIFTY by > 0.5%', () => {
      const indicators = baseIndicators({
        relativeStrengthVsNifty: 1.2, // stock +1.2% vs NIFTY
        rsi: 58,
        relVol: 1.1,
      });
      const result = svc.evaluateRelativeStrength(indicators);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BULLISH');
      expect(result.strategyCode).toBe('E');
    });

    it('BEARISH: stock underperforming NIFTY by > 0.5%', () => {
      const indicators = baseIndicators({
        relativeStrengthVsNifty: -1.5, // stock -1.5% vs NIFTY
        rsi: 42,
        relVol: 1.2,
      });
      const result = svc.evaluateRelativeStrength(indicators);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BEARISH');
    });

    it('rejects when RS is within threshold (0.3%)', () => {
      const indicators = baseIndicators({
        relativeStrengthVsNifty: 0.3, // below 0.5% threshold
        relVol: 1.5,
      });
      const result = svc.evaluateRelativeStrength(indicators);
      expect(result.met).toBe(false);
    });

    it('rejects when relativeStrengthVsNifty is null (index underlying)', () => {
      const indicators = baseIndicators({ relativeStrengthVsNifty: null });
      const result = svc.evaluateRelativeStrength(indicators);
      expect(result.met).toBe(false);
      expect(result.reason).toContain('not available');
    });
  });

  // ─── Strategy F: Trend Continuation ──────────────────────────────────────

  describe('evaluateTrendContinuation (Strategy F)', () => {
    it('BULLISH: price above VWAP, near EMA21, resumption candles', () => {
      const indicators = baseIndicators({
        vwap: 100,
        ema9: 101,
        ema21: 100,
        currentPrice: 100.8, // near EMA21 (within 1.5%)
        rsi: 57,
        relVol: 1.1,
      });
      // Last 3 candles: pullback then 2 green (resumption)
      const candles = makeCandles([103, 102, 100.5, 101, 100.8, 101, 101.5, 101, 100.9, 101.2]);
      const result = svc.evaluateTrendContinuation(indicators, candles);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BULLISH');
      expect(result.strategyCode).toBe('F');
    });

    it('BEARISH: price below VWAP, near EMA21, bearish resumption', () => {
      const indicators = baseIndicators({
        vwap: 100,
        ema9: 99,
        ema21: 100,
        currentPrice: 99.5,
        rsi: 43,
        relVol: 1.2,
      });
      // Last 3 candles: bounce then 2 red (bearish resumption)
      const candles = makeCandles([97, 98, 100, 99.5, 100, 99.8, 99.5, 99.8, 99.9, 99.5]);
      const result = svc.evaluateTrendContinuation(indicators, candles);
      expect(result.met).toBe(true);
      expect(result.direction).toBe('BEARISH');
    });

    it('rejects when VWAP is null', () => {
      const indicators = baseIndicators({ vwap: null });
      const result = svc.evaluateTrendContinuation(indicators, makeCandles([100, 101]));
      expect(result.met).toBe(false);
    });

    it('rejects when pullback is too deep (> 1.5% from EMA21)', () => {
      const indicators = baseIndicators({
        vwap: 100,
        ema9: 102,
        ema21: 100,
        currentPrice: 97, // 3% from EMA21 — too deep
        rsi: 55,
        relVol: 1.2,
      });
      const candles = makeCandles([103, 102, 101, 100, 99, 98, 97, 97.5, 97.8, 97]);
      const result = svc.evaluateTrendContinuation(indicators, candles);
      expect(result.met).toBe(false);
    });

    it('rejects when fewer than 10 candles available', () => {
      const indicators = baseIndicators();
      const result = svc.evaluateTrendContinuation(indicators, makeCandles([100, 101, 102]));
      expect(result.met).toBe(false);
    });
  });

  // ─── Cross-strategy invariants ────────────────────────────────────────────

  describe('cross-strategy invariants', () => {
    it('every strategy returns a strategyCode field', () => {
      const indicators = baseIndicators();
      const candles = makeCandles(Array.from({ length: 20 }, (_, i) => 100 + i * 0.5));

      const results = [
        svc.evaluateORB(indicators, candles),
        svc.evaluateVWAPReclaim(indicators, candles),
        svc.evaluateMomentumExpansion(indicators),
        svc.evaluateBreakoutRetest(indicators, candles),
        svc.evaluateRelativeStrength(indicators),
        svc.evaluateTrendContinuation(indicators, candles),
      ];

      const codes = results.map((r) => r.strategyCode);
      expect(codes).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    });

    it('rejected results always have direction = null', () => {
      const indicators = baseIndicators({
        rsi: 50,
        macd: null,
        orb: null,
        relativeStrengthVsNifty: null,
        vwap: null,
      });
      const candles = makeCandles([100]);

      const results = [
        svc.evaluateORB(indicators, candles),
        svc.evaluateVWAPReclaim(indicators, candles),
        svc.evaluateMomentumExpansion(indicators),
        svc.evaluateBreakoutRetest(indicators, candles),
        svc.evaluateRelativeStrength(indicators),
        svc.evaluateTrendContinuation(indicators, candles),
      ];

      for (const r of results) {
        if (!r.met) {
          expect(r.direction).toBeNull();
        }
      }
    });

    it('every result includes a conditions array', () => {
      const indicators = baseIndicators();
      const candles = makeCandles([100, 101, 102]);
      const result = svc.evaluateORB(indicators, candles);
      expect(Array.isArray(result.conditions)).toBe(true);
    });
  });
});
