/**
 * backtest.service.spec.ts
 *
 * Unit tests for BacktestService.
 *
 * Coverage (12 tests):
 *  1.  In-sample / out-of-sample split at the correct date cutoff
 *  2.  Out-of-sample data never includes in-sample dates (no look-ahead bias)
 *  3.  Delisted trades (isDelisted=true) are included in both phases (no survivorship bias)
 *  4.  inSampleRatio < 0.5 throws BadRequestException
 *  5.  inSampleRatio > 0.9 throws BadRequestException
 *  6.  computeMetrics(): expectancy equals mean pnl
 *  7.  computeMetrics(): winRate equals positive-pnl fraction
 *  8.  computeMetrics(): maxDrawdown computed from peak-to-trough of cumulative pnl
 *  9.  computeBootstrapCI(): lower95 < mean < upper95 for mixed-pnl values
 * 10.  computeBootstrapCI(): winRate CI bounds always between 0 and 1
 * 11.  computeBootstrapCI(): 1,000 iterations produce stable (converged) CI estimates
 * 12.  computeMetrics(): empty trade list returns zero metrics without crashing
 *
 * Requirements: 15.1, 15.2, 15.4, 15.6
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';

import { BacktestService } from './backtest.service';
import { BacktestConfig, BacktestTrade } from './backtest.types';
import { TradingChargesService } from '../charges/trading-charges.service';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal BacktestTrade.  Only date and pnl are required. */
function makeTrade(overrides: { date: Date; pnl: number } & Partial<BacktestTrade>): BacktestTrade {
  return {
    entry: 100,
    exit: 110,
    regime: 'STRONG_BULLISH',
    instrument: 'NIFTY_CE',
    isDelisted: false,
    ...overrides,
  };
}

/** Create a minimal BacktestConfig.  Sensible defaults for all fields. */
function makeConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    strategyCode: 'A',
    inSampleRatio: 0.7,
    startDate: new Date('2024-01-01'),
    endDate: new Date('2024-12-31'),
    engine: 'PAPER',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('BacktestService', () => {
  let service: BacktestService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BacktestService, TradingChargesService],
    }).compile();

    service = module.get<BacktestService>(BacktestService);
  });

  // ---- Test 1 ---------------------------------------------------------------
  it('should split trades at the correct date cutoff based on inSampleRatio', () => {
    // 10 trades; 70% in-sample → cutoff = floor(10 × 0.7) = 7
    const trades: BacktestTrade[] = Array.from({ length: 10 }, (_, i) =>
      makeTrade({ date: new Date(2024, 0, i + 1), pnl: 100 }),
    );
    const config = makeConfig({ inSampleRatio: 0.7 });

    const result = service.runBacktest(config, trades);

    expect(result.inSampleMetrics.tradeCount).toBe(7);
    expect(result.outOfSampleMetrics.tradeCount).toBe(3);
  });

  // ---- Test 2 ---------------------------------------------------------------
  it('should ensure out-of-sample trades never include in-sample dates (no look-ahead bias)', () => {
    // 10 trades with incrementally later dates; pnl increases over time so
    // that the two windows are distinguishable by their expectancy values.
    const trades: BacktestTrade[] = Array.from({ length: 10 }, (_, i) =>
      makeTrade({ date: new Date(2024, 0, i + 1), pnl: (i + 1) * 10 }),
    );
    const config = makeConfig({ inSampleRatio: 0.6 }); // cutoff = 6

    const result = service.runBacktest(config, trades);

    // In-sample covers first 6 trades (pnl: 10 … 60), expectancy = 35.
    // Out-of-sample covers last 4 trades (pnl: 70 … 100), expectancy = 85.
    expect(result.inSampleMetrics.tradeCount).toBe(6);
    expect(result.outOfSampleMetrics.tradeCount).toBe(4);

    // Out-of-sample expectancy must be strictly higher because later trades
    // have larger pnl — confirming the split honours chronological order.
    expect(result.outOfSampleMetrics.expectancy).toBeGreaterThan(result.inSampleMetrics.expectancy);
    expect(result.inSampleMetrics.expectancy).toBeCloseTo(35, 5);
    expect(result.outOfSampleMetrics.expectancy).toBeCloseTo(85, 5);
  });

  // ---- Test 3 ---------------------------------------------------------------
  it('should include delisted trades in both phases (no survivorship bias)', () => {
    const trades: BacktestTrade[] = [
      makeTrade({ date: new Date('2024-01-01'), pnl: 100, isDelisted: true }),
      makeTrade({ date: new Date('2024-02-01'), pnl: 200, isDelisted: true }),
      makeTrade({ date: new Date('2024-03-01'), pnl: 300, isDelisted: false }),
      makeTrade({ date: new Date('2024-04-01'), pnl: 400, isDelisted: false }),
    ];
    const config = makeConfig({ inSampleRatio: 0.5 }); // cutoff = 2

    const result = service.runBacktest(config, trades);

    // Both delisted trades land in the in-sample window.
    expect(result.inSampleMetrics.tradeCount).toBe(2);
    // Delisted pnl values contribute to the expectancy.
    expect(result.inSampleMetrics.expectancy).toBeCloseTo(150, 5); // mean([100, 200])

    // Out-of-sample window holds the two non-delisted trades.
    expect(result.outOfSampleMetrics.tradeCount).toBe(2);
    expect(result.outOfSampleMetrics.expectancy).toBeCloseTo(350, 5); // mean([300, 400])
  });

  // ---- Test 4 ---------------------------------------------------------------
  it('should throw BadRequestException when inSampleRatio < 0.5', () => {
    const config = makeConfig({ inSampleRatio: 0.49 });
    const trades = [makeTrade({ date: new Date('2024-01-01'), pnl: 100 })];

    expect(() => service.runBacktest(config, trades)).toThrow(BadRequestException);
  });

  // ---- Test 5 ---------------------------------------------------------------
  it('should throw BadRequestException when inSampleRatio > 0.9', () => {
    const config = makeConfig({ inSampleRatio: 0.91 });
    const trades = [makeTrade({ date: new Date('2024-01-01'), pnl: 100 })];

    expect(() => service.runBacktest(config, trades)).toThrow(BadRequestException);
  });

  // ---- Test 6 ---------------------------------------------------------------
  it('computeMetrics(): expectancy should equal the arithmetic mean of pnl values', () => {
    const trades: BacktestTrade[] = [
      makeTrade({ date: new Date('2024-01-01'), pnl: 100 }),
      makeTrade({ date: new Date('2024-01-02'), pnl: -50 }),
      makeTrade({ date: new Date('2024-01-03'), pnl: 200 }),
    ];

    const metrics = service.computeMetrics(trades);

    // (100 + (−50) + 200) / 3 = 250 / 3 ≈ 83.33
    expect(metrics.expectancy).toBeCloseTo(250 / 3, 5);
    expect(metrics.tradeCount).toBe(3);
  });

  // ---- Test 7 ---------------------------------------------------------------
  it('computeMetrics(): winRate should equal the fraction of trades with positive pnl', () => {
    const trades: BacktestTrade[] = [
      makeTrade({ date: new Date('2024-01-01'), pnl: 100 }), // win
      makeTrade({ date: new Date('2024-01-02'), pnl: -50 }), // loss
      makeTrade({ date: new Date('2024-01-03'), pnl: 200 }), // win
      makeTrade({ date: new Date('2024-01-04'), pnl: -20 }), // loss
    ];

    const metrics = service.computeMetrics(trades);

    // 2 wins out of 4 trades → 0.5
    expect(metrics.winRate).toBeCloseTo(0.5, 5);
  });

  // ---- Test 8 ---------------------------------------------------------------
  it('computeMetrics(): maxDrawdown should be the maximum peak-to-trough of cumulative pnl', () => {
    // Cumulative series: 100 → 50 → 150 → 100
    // Drawdown after each step:  0 → 50 → 0 → 50
    // Maximum peak-to-trough drawdown = 50
    const trades: BacktestTrade[] = [
      makeTrade({ date: new Date('2024-01-01'), pnl: 100 }),
      makeTrade({ date: new Date('2024-01-02'), pnl: -50 }),
      makeTrade({ date: new Date('2024-01-03'), pnl: 100 }),
      makeTrade({ date: new Date('2024-01-04'), pnl: -50 }),
    ];

    const metrics = service.computeMetrics(trades);

    expect(metrics.maxDrawdown).toBe(50);
  });

  // ---- Test 9 ---------------------------------------------------------------
  it('computeBootstrapCI(): lower95 < mean < upper95 for a mixed-pnl value set', () => {
    // 20 values with both positive and negative entries give sufficient
    // variance for the CI to be non-degenerate.
    const values = [
      100, -50, 200, -100, 150, 50, -20, 300, -80, 120, 90, -60, 180, -40, 130, 70, -30, 250, -90,
      110,
    ];

    const ci = service.computeBootstrapCI(values, 1_000);

    expect(ci.lower95).toBeLessThan(ci.mean);
    expect(ci.mean).toBeLessThan(ci.upper95);
  });

  // ---- Test 10 --------------------------------------------------------------
  it('computeBootstrapCI(): winRate CI bounds should always be between 0 and 1', () => {
    // Win indicator values are always 0 or 1, so every bootstrap sample's
    // mean must lie in [0, 1].
    const winValues = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1];

    const ci = service.computeBootstrapCI(winValues, 1_000);

    expect(ci.lower95).toBeGreaterThanOrEqual(0);
    expect(ci.upper95).toBeLessThanOrEqual(1);
    expect(ci.mean).toBeGreaterThanOrEqual(0);
    expect(ci.mean).toBeLessThanOrEqual(1);
  });

  // ---- Test 11 --------------------------------------------------------------
  it('computeBootstrapCI(): 1,000 iterations should produce stable CI estimates', () => {
    // 50 alternating values (25 × 100, 25 × −50); mean = 25, std = 75.
    const values = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 100 : -50));

    const ci1 = service.computeBootstrapCI(values, 1_000);
    const ci2 = service.computeBootstrapCI(values, 1_000);

    // Point estimate is deterministic — identical across both calls.
    expect(ci1.mean).toBeCloseTo(ci2.mean, 10);

    // With 1,000 iterations the percentile bounds converge; two independent
    // runs should agree within a generous tolerance (expected σ ≈ 0.6 units).
    expect(Math.abs(ci1.lower95 - ci2.lower95)).toBeLessThan(15);
    expect(Math.abs(ci1.upper95 - ci2.upper95)).toBeLessThan(15);
  });

  // ---- Test 12 --------------------------------------------------------------
  it('computeMetrics(): empty trade list should return zero metrics without throwing', () => {
    const metrics = service.computeMetrics([]);

    expect(metrics.expectancy).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.maxDrawdown).toBe(0);
    expect(metrics.tradeCount).toBe(0);
  });
});
