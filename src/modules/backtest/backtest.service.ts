/**
 * backtest.service.ts
 *
 * BacktestService — walk-forward historical simulation engine.
 *
 * Key responsibilities:
 *  1. Validate the in-sample ratio (must be 0.5 – 0.9 inclusive).
 *  2. Sort trades chronologically and split at the ratio boundary so that
 *     out-of-sample data is NEVER seen during the in-sample phase
 *     (no look-ahead bias, Requirement 15.1).
 *  3. Include delisted-instrument trades in both phases
 *     (no survivorship bias, Requirement 15.1).
 *  4. Compute BacktestMetrics for each phase via computeMetrics().
 *  5. Compute 95% bootstrap confidence intervals for expectancy, win rate,
 *     and max drawdown using ≥ 1,000 resamples (Requirement 15.4).
 *  6. Expose calculateTradingCosts() with the identical formula used by
 *     PaperTradingService to guarantee cost-model parity (Requirement 15.2).
 *
 * Requirements: 15.1, 15.2, 15.4, 15.6
 */

import { Injectable, BadRequestException } from '@nestjs/common';

import {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  BacktestMetrics,
  ConfidenceInterval,
  TradingCosts,
} from './backtest.types';

@Injectable()
export class BacktestService {
  /** Minimum allowed in-sample ratio (Requirement 15.6). */
  private static readonly MIN_IN_SAMPLE_RATIO = 0.5;

  /** Maximum allowed in-sample ratio (Requirement 15.6). */
  private static readonly MAX_IN_SAMPLE_RATIO = 0.9;

  /** Bootstrap iteration count — must be ≥ 1,000 (Requirement 15.4). */
  private static readonly BOOTSTRAP_ITERATIONS = 1_000;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run a full walk-forward backtest for a single strategy.
   *
   * The method:
   *  - Validates inSampleRatio.
   *  - Sorts historicalTrades chronologically.
   *  - Splits into in-sample (first inSampleRatio × N trades) and out-of-
   *    sample (remainder) windows; both windows are strictly non-overlapping.
   *  - Computes BacktestMetrics for each window.
   *  - Runs 1,000-iteration bootstrap on the out-of-sample window to produce
   *    95% CIs for expectancy, win rate, and max drawdown.
   *  - Delisted trades (isDelisted === true) are included in all computations.
   *
   * @throws BadRequestException when inSampleRatio is outside [0.5, 0.9].
   */
  runBacktest(config: BacktestConfig, historicalTrades: BacktestTrade[]): BacktestResult {
    this.validateConfig(config);

    // Sort ascending by date — required for no-look-ahead guarantee.
    const sorted = [...historicalTrades].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    // Chronological split: in-sample = first ⌊N × ratio⌋ trades.
    const cutoff = Math.floor(sorted.length * config.inSampleRatio);
    const inSampleTrades = sorted.slice(0, cutoff);
    const outSampleTrades = sorted.slice(cutoff);

    // Compute metrics — delisted trades are included (no survivorship bias).
    const inSampleMetrics = this.computeMetrics(inSampleTrades);
    const outOfSampleMetrics = this.computeMetrics(outSampleTrades);

    // Bootstrap CIs from out-of-sample data only (Requirement 15.4).
    const pnlValues = outSampleTrades.map((t) => t.pnl);
    // Win indicator: 1 for positive pnl, 0 otherwise.
    const winValues = outSampleTrades.map((t) => (t.pnl > 0 ? 1 : 0));

    const expectancyCI = this.computeBootstrapCI(pnlValues, BacktestService.BOOTSTRAP_ITERATIONS);
    const winRateCI = this.computeBootstrapCI(winValues, BacktestService.BOOTSTRAP_ITERATIONS);
    const maxDrawdownCI = this.computeBootstrapCI(
      pnlValues,
      BacktestService.BOOTSTRAP_ITERATIONS,
      (sample) => this.computeMaxDrawdown(sample),
    );

    return {
      strategyCode: config.strategyCode,
      inSampleMetrics,
      outOfSampleMetrics,
      expectancyCI,
      winRateCI,
      maxDrawdownCI,
    };
  }

  /**
   * Compute aggregate performance metrics for a trade set.
   *
   * - expectancy  = mean(pnl)                     (₹ per trade)
   * - winRate     = count(pnl > 0) / total         (0 – 1)
   * - maxDrawdown = maximum peak-to-trough of the cumulative pnl curve
   * - tradeCount  = trades.length
   *
   * Returns zero-valued metrics for an empty trade set without throwing.
   */
  computeMetrics(trades: BacktestTrade[]): BacktestMetrics {
    if (trades.length === 0) {
      return { expectancy: 0, winRate: 0, maxDrawdown: 0, tradeCount: 0 };
    }

    const pnlValues = trades.map((t) => t.pnl);
    const expectancy = this.mean(pnlValues);
    const winRate = pnlValues.filter((p) => p > 0).length / pnlValues.length;
    const maxDrawdown = this.computeMaxDrawdown(pnlValues);

    return { expectancy, winRate, maxDrawdown, tradeCount: trades.length };
  }

  /**
   * Compute a 95% confidence interval via percentile bootstrap resampling.
   *
   * Algorithm:
   *  1. For each of `iterations` iterations, draw a bootstrap sample of the
   *     same size as `values` with replacement.
   *  2. Compute `statFn(sample)` for each sample (default: arithmetic mean).
   *  3. Sort the bootstrap statistics.
   *  4. Return the 2.5th percentile as lower95 and 97.5th as upper95.
   *  5. Return `statFn(values)` as the point estimate (mean field).
   *
   * Returns { mean: 0, lower95: 0, upper95: 0 } for empty input.
   *
   * @param values     Numeric observations to resample.
   * @param iterations Bootstrap iteration count (must be ≥ 1 for a result).
   * @param statFn     Statistic to estimate — defaults to arithmetic mean.
   */
  computeBootstrapCI(
    values: number[],
    iterations: number,
    statFn?: (sample: number[]) => number,
  ): ConfidenceInterval {
    if (values.length === 0) {
      return { mean: 0, lower95: 0, upper95: 0 };
    }

    const stat: (s: number[]) => number = statFn ?? ((s) => this.mean(s));
    const bootstrapStats: number[] = new Array(iterations);

    for (let i = 0; i < iterations; i++) {
      const sample = this.resampleWithReplacement(values);
      bootstrapStats[i] = stat(sample);
    }

    bootstrapStats.sort((a, b) => a - b);

    const lower95Index = Math.floor(iterations * 0.025);
    const upper95Index = Math.floor(iterations * 0.975);

    return {
      mean: stat(values),
      lower95: bootstrapStats[lower95Index],
      upper95: bootstrapStats[upper95Index],
    };
  }

  /**
   * Calculate all trading costs for a round-trip options trade.
   *
   * This is an exact copy of PaperTradingService.calculateTradingCosts()
   * to guarantee cost-model parity (Requirement 15.2).
   *
   * Cost components:
   *  - Brokerage:       ₹20 flat per side → ₹40 total
   *  - STT:             0.05% of sell-side turnover
   *  - Exchange charges: 0.053% of total turnover (buy + sell)
   *  - GST:             18% of (brokerage + exchange charges)
   *  - SEBI charges:    ₹10 per crore (turnover × 0.000001)
   *  - Stamp duty:      0.003% of buy-side turnover only
   */
  calculateTradingCosts(entryPrice: number, exitPrice: number, quantity: number): TradingCosts {
    const buyTurnover = entryPrice * quantity;
    const sellTurnover = exitPrice * quantity;
    const totalTurnover = buyTurnover + sellTurnover;

    const brokerage = 40; // ₹20 flat per side × 2 sides
    const stt = sellTurnover * 0.0005;
    const exchangeCharges = totalTurnover * 0.00053;
    const gst = (brokerage + exchangeCharges) * 0.18;
    const sebiCharges = totalTurnover * 0.000001;
    const stampDuty = buyTurnover * 0.00003;

    const total = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;

    return { brokerage, stt, exchangeCharges, gst, sebiCharges, stampDuty, total };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate BacktestConfig, throwing BadRequestException for invalid values.
   */
  private validateConfig(config: BacktestConfig): void {
    if (config.inSampleRatio < BacktestService.MIN_IN_SAMPLE_RATIO) {
      throw new BadRequestException(
        `inSampleRatio must be at least ${BacktestService.MIN_IN_SAMPLE_RATIO} ` +
          `(walk-forward minimum), received ${config.inSampleRatio}`,
      );
    }
    if (config.inSampleRatio > BacktestService.MAX_IN_SAMPLE_RATIO) {
      throw new BadRequestException(
        `inSampleRatio must be at most ${BacktestService.MAX_IN_SAMPLE_RATIO} ` +
          `(walk-forward maximum), received ${config.inSampleRatio}`,
      );
    }
  }

  /**
   * Compute the maximum peak-to-trough drawdown of a P&L sequence.
   *
   * The cumulative P&L series is built left-to-right.  At each step the
   * running drawdown is (peak − current).  The maximum of all such values is
   * returned as a non-negative number.  Returns 0 for an empty sequence.
   */
  private computeMaxDrawdown(pnlValues: number[]): number {
    if (pnlValues.length === 0) return 0;

    let runningPnl = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (const pnl of pnlValues) {
      runningPnl += pnl;
      if (runningPnl > peak) {
        peak = runningPnl;
      }
      const drawdown = peak - runningPnl;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  /**
   * Draw a bootstrap sample of the same length as `values` with replacement.
   */
  private resampleWithReplacement(values: number[]): number[] {
    const n = values.length;
    const sample = new Array(n);
    for (let i = 0; i < n; i++) {
      sample[i] = values[Math.floor(Math.random() * n)];
    }
    return sample;
  }

  /** Arithmetic mean of a numeric array.  Assumes length ≥ 1. */
  private mean(values: number[]): number {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
}
