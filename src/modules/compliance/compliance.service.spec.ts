/**
 * ComplianceService unit tests.
 *
 * Coverage (12 tests):
 *   Gate 1 — POSITIVE_EXPECTANCY:
 *     1. Negative expectancy fails with POSITIVE_EXPECTANCY
 *     2. Positive expectancy passes gate 1 (all gates pass)
 *
 *   Gate 2 — MAX_DRAWDOWN:
 *     3. Drawdown above threshold fails with MAX_DRAWDOWN
 *     4. Drawdown below threshold passes gate 2 (all gates pass)
 *
 *   Gate 3 — MIN_TRADES_PER_REGIME:
 *     5. Regime with < 30 trades fails with MIN_TRADES_PER_REGIME
 *     6. All regimes with ≥ 30 trades passes gate 3 (all gates pass)
 *
 *   Gate 4 — MONTE_CARLO_ROBUSTNESS:
 *     7. Monte Carlo < 95% positive fails with MONTE_CARLO_ROBUSTNESS
 *     8. Monte Carlo ≥ 95% positive passes gate 4 (all gates pass)
 *
 *   Ordering and suspension:
 *     9.  Gates checked in order — Gate 1 fail stops evaluation before Gate 2
 *     10. Failed strategy is suspended (isSuspended = true, suspensionReason set)
 *
 *   Monte Carlo internals:
 *     11. Deterministic trades (all positive pnl) always produce positiveRatio = 1
 *     12. runMonteCarloTest() always returns a ratio in [0, 1]
 *
 * Requirements: 15.3, 15.5
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ComplianceService } from './compliance.service';
import { ComplianceGate, BacktestStats, TradeRecord } from './compliance.types';
import { Strategies } from '../../database/entities/strategies.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Repository mock factory
// ─────────────────────────────────────────────────────────────────────────────

type MockStrategiesRepo = Pick<Repository<Strategies>, 'update'>;
type MockStrategyPerfRepo = Pick<Repository<StrategyPerformance>, 'find'>;

function buildMockStrategiesRepo(): jest.Mocked<MockStrategiesRepo> {
  return { update: jest.fn().mockResolvedValue({ affected: 1 }) };
}

function buildMockStrategyPerfRepo(): jest.Mocked<MockStrategyPerfRepo> {
  return { find: jest.fn().mockResolvedValue([]) };
}

async function buildService(
  strategiesRepo: MockStrategiesRepo,
  strategyPerfRepo: MockStrategyPerfRepo,
): Promise<ComplianceService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ComplianceService,
      { provide: getRepositoryToken(Strategies), useValue: strategiesRepo },
      { provide: getRepositoryToken(StrategyPerformance), useValue: strategyPerfRepo },
    ],
  }).compile();

  return module.get<ComplianceService>(ComplianceService);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-data builders
// ─────────────────────────────────────────────────────────────────────────────

/** All-positive pnl trades — bootstrap resampling of these always yields positive expectancy. */
function allPositiveTrades(count = 50): TradeRecord[] {
  return Array.from({ length: count }, (_, i) => ({ pnl: i + 1, regime: 'TREND' }));
}

/**
 * BacktestStats that passes all 4 gates when maxDrawdownThreshold = 0.20.
 * Uses all-positive trades so Monte Carlo passes deterministically.
 */
function passingStats(): BacktestStats {
  return {
    expectancy: 5.0,
    maxDrawdown: 0.1,
    tradesByRegime: { TREND: 50, RANGE: 40 },
    trades: allPositiveTrades(100),
  };
}

const STRATEGY_ID = 'strategy-uuid-001';
const MAX_DRAWDOWN_THRESHOLD = 0.2;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ComplianceService — checkLiveDeploymentGates', () => {
  let service: ComplianceService;
  let strategiesRepo: jest.Mocked<MockStrategiesRepo>;
  let strategyPerfRepo: jest.Mocked<MockStrategyPerfRepo>;

  beforeEach(async () => {
    strategiesRepo = buildMockStrategiesRepo();
    strategyPerfRepo = buildMockStrategyPerfRepo();
    service = await buildService(strategiesRepo, strategyPerfRepo);
  });

  // ── Gate 1: POSITIVE_EXPECTANCY ──────────────────────────────────────────

  it('1. fails with POSITIVE_EXPECTANCY when expectancy is negative', async () => {
    const stats: BacktestStats = { ...passingStats(), expectancy: -2.5 };
    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      stats,
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(false);
    expect(result.failingGate).toBe(ComplianceGate.POSITIVE_EXPECTANCY);
    expect(result.computedValue).toBe(-2.5);
    expect(result.thresholdValue).toBe(0);
  });

  it('2. passes when all 4 gates are satisfied (positive expectancy)', async () => {
    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      passingStats(),
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(true);
    expect(result.failingGate).toBeUndefined();
  });

  // ── Gate 2: MAX_DRAWDOWN ──────────────────────────────────────────────────

  it('3. fails with MAX_DRAWDOWN when drawdown exceeds threshold', async () => {
    const stats: BacktestStats = { ...passingStats(), maxDrawdown: 0.35 };
    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      stats,
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(false);
    expect(result.failingGate).toBe(ComplianceGate.MAX_DRAWDOWN);
    expect(result.computedValue).toBe(0.35);
    expect(result.thresholdValue).toBe(MAX_DRAWDOWN_THRESHOLD);
  });

  it('4. passes when drawdown is at or below threshold', async () => {
    const stats: BacktestStats = { ...passingStats(), maxDrawdown: 0.2 };
    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      stats,
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(true);
  });

  // ── Gate 3: MIN_TRADES_PER_REGIME ─────────────────────────────────────────

  it('5. fails with MIN_TRADES_PER_REGIME when a regime has < 30 trades', async () => {
    const stats: BacktestStats = {
      ...passingStats(),
      tradesByRegime: { TREND: 50, LOW_VOL: 25 },
    };
    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      stats,
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(false);
    expect(result.failingGate).toBe(ComplianceGate.MIN_TRADES_PER_REGIME);
    expect(result.computedValue).toBe(25);
    expect(result.thresholdValue).toBe(30);
  });

  it('6. passes when all regimes have ≥ 30 trades', async () => {
    const stats: BacktestStats = {
      ...passingStats(),
      tradesByRegime: { TREND: 30, RANGE: 45, HIGH_VOL: 60 },
    };
    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      stats,
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(true);
  });

  // ── Gate 4: MONTE_CARLO_ROBUSTNESS ────────────────────────────────────────

  it('7. fails with MONTE_CARLO_ROBUSTNESS when Monte Carlo positive ratio < 95%', async () => {
    // Spy on runMonteCarloTest to inject a deterministic low ratio, avoiding flakiness.
    jest.spyOn(service, 'runMonteCarloTest').mockReturnValue({ positiveRatio: 0.9 });

    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      passingStats(),
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(false);
    expect(result.failingGate).toBe(ComplianceGate.MONTE_CARLO_ROBUSTNESS);
    expect(result.computedValue).toBe(0.9);
    expect(result.thresholdValue).toBe(0.95);
  });

  it('8. passes when Monte Carlo positive ratio is ≥ 95% (all-positive trades)', async () => {
    // All-positive pnl trades guarantee every bootstrap sample has positive expectancy.
    const stats: BacktestStats = {
      ...passingStats(),
      trades: allPositiveTrades(100),
    };
    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      stats,
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(true);
  });

  // ── Ordering and suspension ───────────────────────────────────────────────

  it('9. Gate 1 failure stops evaluation — MAX_DRAWDOWN gate is never reached', async () => {
    // Both Gate 1 and Gate 2 would fail, but only Gate 1 should be reported.
    const stats: BacktestStats = {
      ...passingStats(),
      expectancy: -1.0, // Gate 1 fails
      maxDrawdown: 99.0, // Gate 2 would also fail, but should not be reached
    };
    const result = await service.checkLiveDeploymentGates(
      STRATEGY_ID,
      stats,
      MAX_DRAWDOWN_THRESHOLD,
    );

    expect(result.passed).toBe(false);
    expect(result.failingGate).toBe(ComplianceGate.POSITIVE_EXPECTANCY);
    // strategiesRepo.update called exactly once (for Gate 1 suspension only)
    expect(strategiesRepo.update).toHaveBeenCalledTimes(1);
  });

  it('10. failed strategy is suspended with isSuspended=true and suspensionReason set', async () => {
    const stats: BacktestStats = { ...passingStats(), expectancy: -0.5 };
    await service.checkLiveDeploymentGates(STRATEGY_ID, stats, MAX_DRAWDOWN_THRESHOLD);

    expect(strategiesRepo.update).toHaveBeenCalledWith(
      STRATEGY_ID,
      expect.objectContaining({
        isSuspended: true,
        suspensionReason: ComplianceGate.POSITIVE_EXPECTANCY,
      }),
    );
  });

  // ── Monte Carlo internals ─────────────────────────────────────────────────

  it('11. deterministic all-positive trades always yield positiveRatio = 1', () => {
    const trades = allPositiveTrades(50);
    const { positiveRatio } = service.runMonteCarloTest(trades, 1_000);

    // Every bootstrap resample of all-positive trades has positive mean pnl.
    expect(positiveRatio).toBe(1);
  });

  it('12. runMonteCarloTest() always returns a ratio in [0, 1]', () => {
    // Mix of winning and losing trades — ratio is bounded regardless of random seed.
    const trades: TradeRecord[] = [
      { pnl: 100, regime: 'TREND' },
      { pnl: -50, regime: 'TREND' },
      { pnl: 200, regime: 'RANGE' },
      { pnl: -150, regime: 'RANGE' },
      { pnl: 75, regime: 'TREND' },
    ];
    const { positiveRatio } = service.runMonteCarloTest(trades, 500);

    expect(positiveRatio).toBeGreaterThanOrEqual(0);
    expect(positiveRatio).toBeLessThanOrEqual(1);
  });
});
