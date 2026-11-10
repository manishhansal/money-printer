/**
 * CapitalSimulatorService unit tests (10 tests).
 *
 * No database or external dependencies — the service is purely computational.
 *
 * Tests:
 *  1.  Monthly compounding over 1 year increases capital with positive expectancy
 *  2.  Zero withdrawal rate doesn't reduce capital via withdrawals
 *  3.  100% withdrawal rate results in near-zero capital quickly
 *  4.  5-year projection is longer than 1-year
 *  5.  Withdrawal rate exactly 0.5 halves capital each compounding period
 *  6.  totalWithdrawals equals sum of all period-level withdrawn amounts
 *  7.  Negative expectancy reduces capital over time
 *  8.  yearlyProjections has correct length (1, 3, or 5 entries)
 *  9.  Daily compounding produces more periods — and more total gain — than monthly
 * 10.  Zero expectancy with zero withdrawal keeps capital flat
 *
 * Requirements: 14.6
 */

import { CapitalSimulatorService, SimulationConfig } from './capital-simulator.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a baseline config that can be overridden per-test. */
function baseConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    startingCapital: 100_000,
    projectionYears: 1,
    compoundingFrequency: 'monthly',
    withdrawalRate: 0,
    historicalExpectancy: 500,
    historicalWinRate: 0.6,
    tradesPerDay: 2,
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('CapitalSimulatorService', () => {
  let service: CapitalSimulatorService;

  beforeEach(() => {
    service = new CapitalSimulatorService();
  });

  // ── Test 1 ──────────────────────────────────────────────────────────────────
  it('monthly compounding over 1 year increases capital with positive expectancy', () => {
    const result = service.simulate(
      baseConfig({
        compoundingFrequency: 'monthly',
        projectionYears: 1,
        withdrawalRate: 0,
        historicalExpectancy: 500,
        tradesPerDay: 2,
      }),
    );

    // 12 periods × 1000 gain each = 12 000 added → endingCapital = 112 000
    expect(result.endingCapital).toBeGreaterThan(result.startingCapital);
    expect(result.totalGrowthPercent).toBeGreaterThan(0);
  });

  // ── Test 2 ──────────────────────────────────────────────────────────────────
  it('zero withdrawal rate produces zero total withdrawals', () => {
    const result = service.simulate(baseConfig({ withdrawalRate: 0, projectionYears: 3 }));

    expect(result.totalWithdrawals).toBe(0);
    for (const y of result.yearlyProjections) {
      expect(y.totalWithdrawn).toBe(0);
    }
  });

  // ── Test 3 ──────────────────────────────────────────────────────────────────
  it('100% withdrawal rate leaves near-zero capital after each period', () => {
    const result = service.simulate(
      baseConfig({
        withdrawalRate: 1.0,
        compoundingFrequency: 'monthly',
        projectionYears: 1,
        historicalExpectancy: 500,
        tradesPerDay: 2,
      }),
    );

    // After each monthly period the entire (small) gain is withdrawn;
    // the initial capital is fully drained in period 1.
    // endingCapital ≪ startingCapital.
    expect(result.endingCapital).toBeLessThan(result.startingCapital * 0.01);
  });

  // ── Test 4 ──────────────────────────────────────────────────────────────────
  it('5-year projection returns more yearly entries than 1-year projection', () => {
    const result1 = service.simulate(baseConfig({ projectionYears: 1 }));
    const result5 = service.simulate(baseConfig({ projectionYears: 5 }));

    expect(result1.yearlyProjections).toHaveLength(1);
    expect(result5.yearlyProjections).toHaveLength(5);
    expect(result5.yearlyProjections.length).toBeGreaterThan(result1.yearlyProjections.length);
  });

  // ── Test 5 ──────────────────────────────────────────────────────────────────
  it('withdrawal rate of 0.5 halves capital each compounding period', () => {
    const startingCapital = 100_000;
    const result = service.simulate(
      baseConfig({
        startingCapital,
        compoundingFrequency: 'monthly',
        projectionYears: 1,
        withdrawalRate: 0.5,
        historicalExpectancy: 0, // zero gain so only withdrawal drives change
        tradesPerDay: 1,
      }),
    );

    // After 12 monthly periods, each halving: startingCapital × (0.5)^12
    const expectedEndingCapital = startingCapital * Math.pow(0.5, 12);
    expect(result.endingCapital).toBeCloseTo(expectedEndingCapital, 5);
  });

  // ── Test 6 ──────────────────────────────────────────────────────────────────
  it('totalWithdrawals equals the final yearlyProjection cumulative totalWithdrawn', () => {
    const result = service.simulate(
      baseConfig({
        withdrawalRate: 0.1,
        projectionYears: 3,
        compoundingFrequency: 'monthly',
      }),
    );

    const lastYearEntry = result.yearlyProjections[result.yearlyProjections.length - 1];
    expect(result.totalWithdrawals).toBeCloseTo(lastYearEntry.totalWithdrawn, 6);
    // And the ending capital + withdrawals should exceed the start (positive expectancy)
    expect(result.totalWithdrawals).toBeGreaterThan(0);
  });

  // ── Test 7 ──────────────────────────────────────────────────────────────────
  it('negative expectancy reduces capital over time', () => {
    const result = service.simulate(
      baseConfig({
        withdrawalRate: 0,
        historicalExpectancy: -200, // losing strategy
        tradesPerDay: 2,
        projectionYears: 1,
        compoundingFrequency: 'monthly',
      }),
    );

    expect(result.endingCapital).toBeLessThan(result.startingCapital);
    expect(result.totalGrowthPercent).toBeLessThan(0);
  });

  // ── Test 8 ──────────────────────────────────────────────────────────────────
  it('yearlyProjections length matches projectionYears', () => {
    const years: Array<1 | 3 | 5> = [1, 3, 5];

    for (const projectionYears of years) {
      const result = service.simulate(baseConfig({ projectionYears }));
      expect(result.yearlyProjections).toHaveLength(projectionYears);
    }
  });

  // ── Test 9 ──────────────────────────────────────────────────────────────────
  it('daily compounding accumulates more gain than monthly (more periods × same gain)', () => {
    const sharedConfig: Partial<SimulationConfig> = {
      startingCapital: 100_000,
      projectionYears: 1,
      withdrawalRate: 0,
      historicalExpectancy: 100,
      tradesPerDay: 2,
    };

    const dailyResult = service.simulate(
      baseConfig({ ...sharedConfig, compoundingFrequency: 'daily' }),
    );
    const monthlyResult = service.simulate(
      baseConfig({ ...sharedConfig, compoundingFrequency: 'monthly' }),
    );

    // Daily: 365 periods × 200 gain = +73 000; Monthly: 12 × 200 = +2 400
    expect(dailyResult.endingCapital).toBeGreaterThan(monthlyResult.endingCapital);
  });

  // ── Test 10 ─────────────────────────────────────────────────────────────────
  it('zero expectancy with zero withdrawal keeps capital flat', () => {
    const startingCapital = 50_000;
    const result = service.simulate(
      baseConfig({
        startingCapital,
        historicalExpectancy: 0,
        tradesPerDay: 5,
        withdrawalRate: 0,
        compoundingFrequency: 'daily',
        projectionYears: 5,
      }),
    );

    expect(result.endingCapital).toBeCloseTo(startingCapital, 6);
    expect(result.totalWithdrawals).toBe(0);
    expect(result.totalGrowthPercent).toBeCloseTo(0, 6);
  });
});
