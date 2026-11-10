/**
 * CapitalSimulatorService — projects capital growth over 1, 3, or 5 years
 * using configurable compounding frequency and withdrawal rate, driven by
 * historical performance statistics.
 *
 * The simulation is purely computational — no database access required.
 * Callers are expected to supply `historicalExpectancy` and `tradesPerDay`
 * obtained from AnalyticsService for the desired time window.
 *
 * Algorithm per compounding period:
 *   1. capital += historicalExpectancy × tradesPerDay
 *   2. capital  = max(0, capital)                 (clamp to prevent negative)
 *   3. withdrawal = withdrawalRate × capital
 *   4. capital -= withdrawal
 *   5. totalWithdrawn += withdrawal
 *
 * Period counts per year:
 *   daily   → 365 periods
 *   weekly  → 52  periods
 *   monthly → 12  periods
 *
 * Requirements: 14.6
 */

import { Injectable } from '@nestjs/common';

/** Input configuration for a capital compounding simulation run. */
export interface SimulationConfig {
  /** Starting capital in INR. */
  startingCapital: number;
  /** Projection horizon in years. */
  projectionYears: 1 | 3 | 5;
  /** How frequently compounding (and optional withdrawal) is applied. */
  compoundingFrequency: 'daily' | 'weekly' | 'monthly';
  /**
   * Fraction of capital withdrawn after each compounding period.
   * Valid range: 0.0 (no withdrawal) – 1.0 (100 % withdrawal).
   */
  withdrawalRate: number;
  /** Mean net P&L per trade from historical records (INR). */
  historicalExpectancy: number;
  /** Historical win rate (0–1) — stored for context, not used in the formula. */
  historicalWinRate: number;
  /** Average number of trading sessions executed per day. */
  tradesPerDay: number;
}

/** Year-end snapshot within a simulation result. */
export interface YearlyProjection {
  /** Calendar year number (1-indexed from simulation start). */
  year: number;
  /** Capital remaining at the end of this year. */
  capital: number;
  /** Cumulative amount withdrawn from start through end of this year. */
  totalWithdrawn: number;
}

/** Full output of a capital compounding simulation run. */
export interface SimulationResult {
  /** Starting capital supplied in the config (INR). */
  startingCapital: number;
  /** Capital remaining at the very end of the projection horizon. */
  endingCapital: number;
  /**
   * Percentage change in remaining capital relative to the starting amount.
   * Formula: (endingCapital − startingCapital) / startingCapital × 100.
   * Does not account for withdrawals already taken out.
   */
  totalGrowthPercent: number;
  /** Total amount withdrawn across all periods (INR). */
  totalWithdrawals: number;
  /**
   * Snapshot array — one entry per projection year.
   * Length always equals `projectionYears` (1, 3, or 5).
   */
  yearlyProjections: YearlyProjection[];
}

@Injectable()
export class CapitalSimulatorService {
  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Run a deterministic capital compounding simulation using the supplied
   * config and return a fully populated SimulationResult.
   */
  simulate(config: SimulationConfig): SimulationResult {
    const periodsPerYear = this.periodsPerYear(config.compoundingFrequency);
    const totalPeriods = periodsPerYear * config.projectionYears;
    const gainPerPeriod = config.historicalExpectancy * config.tradesPerDay;

    let capital = config.startingCapital;
    let totalWithdrawn = 0;
    const yearlyProjections: YearlyProjection[] = [];

    for (let period = 1; period <= totalPeriods; period++) {
      // 1. Apply this period's gain (or loss)
      capital += gainPerPeriod;

      // 2. Clamp — capital can never go below zero
      capital = Math.max(0, capital);

      // 3-4. Deduct withdrawal
      const withdrawal = config.withdrawalRate * capital;
      capital -= withdrawal;

      // 5. Accumulate
      totalWithdrawn += withdrawal;

      // Record a snapshot at each year-end boundary
      if (period % periodsPerYear === 0) {
        const year = period / periodsPerYear;
        yearlyProjections.push({ year, capital, totalWithdrawn });
      }
    }

    const endingCapital = capital;
    const totalGrowthPercent =
      config.startingCapital > 0
        ? ((endingCapital - config.startingCapital) / config.startingCapital) * 100
        : 0;

    return {
      startingCapital: config.startingCapital,
      endingCapital,
      totalGrowthPercent,
      totalWithdrawals: totalWithdrawn,
      yearlyProjections,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Returns the number of compounding periods per calendar year. */
  private periodsPerYear(frequency: 'daily' | 'weekly' | 'monthly'): number {
    switch (frequency) {
      case 'daily':
        return 365;
      case 'weekly':
        return 52;
      case 'monthly':
        return 12;
    }
  }
}
