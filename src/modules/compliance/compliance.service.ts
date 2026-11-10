/**
 * ComplianceService — enforces all 4 live-deployment profitability gates.
 *
 * Responsibilities (Requirements 15.3, 15.5):
 *
 *   checkLiveDeploymentGates():
 *     Evaluates 4 ordered gates against the provided backtest statistics.
 *     Returns the first failing gate immediately (subsequent gates not evaluated).
 *     On any failure, sets `isSuspended = true`, `suspensionReason`, and
 *     `failingGateValue` on the Strategies row identified by strategyId.
 *
 *   Gate 1 — POSITIVE_EXPECTANCY:
 *     out-of-sample expectancy must be > 0.
 *
 *   Gate 2 — MAX_DRAWDOWN:
 *     maximum drawdown ≤ maxDrawdownThreshold.
 *
 *   Gate 3 — MIN_TRADES_PER_REGIME:
 *     every regime in tradesByRegime must have ≥ 30 closed trades.
 *
 *   Gate 4 — MONTE_CARLO_ROBUSTNESS:
 *     ≥ 95% of 1,000 bootstrap iterations must yield positive expectancy.
 *
 *   runMonteCarloTest():
 *     Bootstrap resamples (with replacement) the trade list `iterations` times,
 *     computes the mean pnl for each sample, and returns the fraction of
 *     samples with positive expectancy.
 *
 * Requirements: 15.3, 15.5
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Strategies } from '../../database/entities/strategies.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import {
  BacktestStats,
  ComplianceCheckResult,
  ComplianceGate,
  TradeRecord,
} from './compliance.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum closed trades required per tested regime (Gate 3). */
const MIN_TRADES_PER_REGIME = 30;

/** Fraction of Monte Carlo iterations that must yield positive expectancy (Gate 4). */
const MONTE_CARLO_PASS_THRESHOLD = 0.95;

/** Default number of Monte Carlo iterations (Gate 4). */
const DEFAULT_MONTE_CARLO_ITERATIONS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    @InjectRepository(Strategies)
    private readonly strategiesRepo: Repository<Strategies>,

    // Injected for future regime-level query needs; not used in current gate logic.
    @InjectRepository(StrategyPerformance)
    private readonly strategyPerfRepo: Repository<StrategyPerformance>,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluates all 4 profitability gates for a strategy submitted for live
   * deployment.  Gates are checked in order; evaluation stops at the first
   * failure.
   *
   * On any gate failure:
   *   - Sets `isSuspended = true` on the Strategies row.
   *   - Persists the failing gate name as `suspensionReason`.
   *   - Persists the computed failing value as `failingGateValue`.
   *
   * @param strategyId            UUID of the strategy being evaluated.
   * @param backtestStats         Aggregated out-of-sample backtest statistics.
   * @param maxDrawdownThreshold  Maximum acceptable drawdown (Gate 2 threshold).
   * @returns ComplianceCheckResult — { passed: true } or the first failing gate.
   */
  async checkLiveDeploymentGates(
    strategyId: string,
    backtestStats: BacktestStats,
    maxDrawdownThreshold: number,
  ): Promise<ComplianceCheckResult> {
    // ── Gate 1: POSITIVE_EXPECTANCY ───────────────────────────────────────
    // Out-of-sample expectancy must be strictly positive (> 0).
    if (backtestStats.expectancy <= 0) {
      this.logger.debug(
        `[Compliance] Gate FAILED — POSITIVE_EXPECTANCY: expectancy=${backtestStats.expectancy} ≤ 0`,
      );
      await this.suspendStrategy(
        strategyId,
        ComplianceGate.POSITIVE_EXPECTANCY,
        backtestStats.expectancy,
      );
      return {
        passed: false,
        failingGate: ComplianceGate.POSITIVE_EXPECTANCY,
        failingCriterion: 'Out-of-sample expectancy must be positive (> 0)',
        computedValue: backtestStats.expectancy,
        thresholdValue: 0,
      };
    }

    // ── Gate 2: MAX_DRAWDOWN ──────────────────────────────────────────────
    // Maximum drawdown must not exceed the configured threshold.
    if (backtestStats.maxDrawdown > maxDrawdownThreshold) {
      this.logger.debug(
        `[Compliance] Gate FAILED — MAX_DRAWDOWN: drawdown=${backtestStats.maxDrawdown} > threshold=${maxDrawdownThreshold}`,
      );
      await this.suspendStrategy(
        strategyId,
        ComplianceGate.MAX_DRAWDOWN,
        backtestStats.maxDrawdown,
      );
      return {
        passed: false,
        failingGate: ComplianceGate.MAX_DRAWDOWN,
        failingCriterion: `Maximum drawdown ${backtestStats.maxDrawdown} exceeds configured threshold ${maxDrawdownThreshold}`,
        computedValue: backtestStats.maxDrawdown,
        thresholdValue: maxDrawdownThreshold,
      };
    }

    // ── Gate 3: MIN_TRADES_PER_REGIME ─────────────────────────────────────
    // Every regime in tradesByRegime must have ≥ 30 closed trades.
    for (const [regime, count] of Object.entries(backtestStats.tradesByRegime)) {
      if (count < MIN_TRADES_PER_REGIME) {
        this.logger.debug(
          `[Compliance] Gate FAILED — MIN_TRADES_PER_REGIME: regime='${regime}' count=${count} < 30`,
        );
        await this.suspendStrategy(strategyId, ComplianceGate.MIN_TRADES_PER_REGIME, count);
        return {
          passed: false,
          failingGate: ComplianceGate.MIN_TRADES_PER_REGIME,
          failingCriterion: `Regime '${regime}' has ${count} closed trades — minimum required is ${MIN_TRADES_PER_REGIME}`,
          computedValue: count,
          thresholdValue: MIN_TRADES_PER_REGIME,
        };
      }
    }

    // ── Gate 4: MONTE_CARLO_ROBUSTNESS ────────────────────────────────────
    // ≥ 95% of 1,000 bootstrap iterations must yield positive expectancy.
    const { positiveRatio } = this.runMonteCarloTest(
      backtestStats.trades,
      DEFAULT_MONTE_CARLO_ITERATIONS,
    );

    if (positiveRatio < MONTE_CARLO_PASS_THRESHOLD) {
      this.logger.debug(
        `[Compliance] Gate FAILED — MONTE_CARLO_ROBUSTNESS: positiveRatio=${positiveRatio} < 0.95`,
      );
      await this.suspendStrategy(strategyId, ComplianceGate.MONTE_CARLO_ROBUSTNESS, positiveRatio);
      return {
        passed: false,
        failingGate: ComplianceGate.MONTE_CARLO_ROBUSTNESS,
        failingCriterion: `Monte Carlo robustness ${(positiveRatio * 100).toFixed(1)}% is below the required 95%`,
        computedValue: positiveRatio,
        thresholdValue: MONTE_CARLO_PASS_THRESHOLD,
      };
    }

    // ── All gates passed ──────────────────────────────────────────────────
    this.logger.debug(`[Compliance] All 4 profitability gates passed for strategyId=${strategyId}`);
    return { passed: true };
  }

  /**
   * Runs a Monte Carlo robustness test using bootstrap resampling.
   *
   * For each iteration:
   *   1. Sample `trades.length` trades at random with replacement.
   *   2. Compute the mean P&L (expectancy) of the sample.
   *   3. Record whether the expectancy is positive.
   *
   * Returns the fraction of iterations that produced positive expectancy.
   * Returns `{ positiveRatio: 0 }` when the trade list is empty.
   *
   * @param trades     Full list of closed trade records.
   * @param iterations Number of bootstrap iterations to run.
   * @returns          { positiveRatio: number } — fraction in [0, 1].
   */
  runMonteCarloTest(trades: TradeRecord[], iterations: number): { positiveRatio: number } {
    if (trades.length === 0) {
      return { positiveRatio: 0 };
    }

    let positiveCount = 0;
    const n = trades.length;

    for (let i = 0; i < iterations; i++) {
      // Bootstrap resample with replacement
      let sampleSum = 0;
      for (let j = 0; j < n; j++) {
        sampleSum += trades[Math.floor(Math.random() * n)].pnl;
      }
      const sampleExpectancy = sampleSum / n;
      if (sampleExpectancy > 0) {
        positiveCount++;
      }
    }

    return { positiveRatio: positiveCount / iterations };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Suspends the strategy in the Strategies table by setting:
   *   - isSuspended = true
   *   - suspensionReason = gate name
   *   - failingGateValue = computed metric value (as numeric string)
   */
  private async suspendStrategy(
    strategyId: string,
    gate: ComplianceGate,
    computedValue: number,
  ): Promise<void> {
    try {
      await this.strategiesRepo.update(strategyId, {
        isSuspended: true,
        suspensionReason: gate,
        failingGateValue: computedValue.toString(),
      });
      this.logger.log(
        `[Compliance] Strategy ${strategyId} suspended — gate=${gate}, value=${computedValue}`,
      );
    } catch (err) {
      this.logger.error(
        `[Compliance] Failed to suspend strategy ${strategyId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
