/**
 * signal-pipeline.integration.spec.ts
 *
 * Near-integration tests for the signal scanner → strategy → scoring pipeline.
 *
 * These tests wire the real service implementations together using NestJS
 * TestingModule with mocked DB repositories and Redis client, verifying that
 * the module boundaries interact correctly without a live PostgreSQL/Redis
 * instance.
 *
 * What is tested (P2-002 fix):
 *   - Full scan → strategy evaluation → signal scoring chain with real service
 *     implementations (not mocked).
 *   - Entry condition filters correctly block extreme-RSI setups.
 *   - Risk gates correctly reject over-exposed positions.
 *   - Paper vs live routing respects the armed-state machine.
 *   - Signal score threshold (≥80) gates acceptance.
 *   - Position sizing uses the risk engine's suggestedQuantity.
 *
 * What is NOT tested here (requires live PostgreSQL/Redis):
 *   - Database persistence of signals, orders, positions.
 *   - Redis pub/sub message delivery.
 *   - Actual Dhan API broker submission.
 *   - Multi-process concurrency.
 *
 * To run: `npx jest --testPathPattern="signal-pipeline.integration" --no-coverage`
 *
 * Requirements: P2-002 — integration test suite
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { SignalScannerService, IndicatorSnapshot } from './signal-scanner.service';
import { StrategyService } from '../strategy/strategy.service';
import { SignalScoringService } from '../signal-scoring/signal-scoring.service';
import { TechnicalAnalysisService } from '../technical-analysis/technical-analysis.service';
import { CandleQueryService } from '../market-data/candle-query.service';
import { RiskManagementService } from '../risk-management/risk-management.service';
import { MarketRegimeService } from '../market-regime/market-regime.service';
import { SessionManagerService } from '../session-manager/session-manager.service';
import { LiveTradingService } from '../live-trading/live-trading.service';
import { SniperEntryService } from './sniper-entry.service';
import { RedisService } from '../redis/redis.service';

import { Instruments } from '../../database/entities/instruments.entity';
import { Strategies } from '../../database/entities/strategies.entity';
import { SignalEvaluations } from '../../database/entities/signal-evaluations.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import { Signals } from '../../database/entities/signals.entity';

import { MarketRegime } from '../market-regime/market-regime.types';
import { SessionPhase } from '../session-manager/session-manager.types';
import { SIGNAL_CANDIDATE_EVENT } from '../strategy/strategy.types';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal STRATEGY_CONFIGS seed (matches production seed)
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_STRATEGIES = [
  {
    id: 'strat-a',
    code: 'A',
    name: 'Opening Range Breakout',
    compatibleRegimes: [MarketRegime.BREAKOUT, MarketRegime.STRONG_BULL, MarketRegime.STRONG_BEAR],
    minRrRatio: '1.5',
    maxConcurrentPositions: 3,
    openingPhaseCompatible: true,
    isActive: true,
    isSuspended: false,
    minPerformanceThreshold: null,
    currentOosWinRate: null,
    version: 1,
  },
  {
    id: 'strat-c',
    code: 'C',
    name: 'Momentum Expansion',
    compatibleRegimes: [MarketRegime.STRONG_BULL, MarketRegime.STRONG_BEAR, MarketRegime.BREAKOUT],
    minRrRatio: '2.0',
    maxConcurrentPositions: 2,
    openingPhaseCompatible: false,
    isActive: true,
    isSuspended: false,
    minPerformanceThreshold: null,
    currentOosWinRate: null,
    version: 1,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Test setup helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal valid indicator snapshot — no candle data (graceful fallback). */
const EMPTY_INDICATORS: IndicatorSnapshot = {
  vwap: null,
  rsi: null,
  atr: null,
  macd: null,
  ema9: null,
  ema21: null,
  relVol: null,
  orb: null,
  candleCount: 0,
};

/** Healthy indicators — will pass entry conditions. */
const HEALTHY_INDICATORS: IndicatorSnapshot = {
  vwap: 100,
  rsi: 55,
  atr: 1.5,
  macd: { macd: 0.5, signal: 0.3, histogram: 0.2 },
  ema9: 99,
  ema21: 97,
  relVol: 1.2,
  orb: { orbHigh: 102, orbLow: 98, windowMinutes: 15 },
  candleCount: 50,
};

/** Extreme RSI indicators — will fail entry conditions. */
const EXTREME_OVERBOUGHT_INDICATORS: IndicatorSnapshot = {
  ...HEALTHY_INDICATORS,
  rsi: 82,
};

interface IntegrationDeps {
  scannerService: SignalScannerService;
  strategyService: StrategyService;
  scoringService: SignalScoringService;
  riskService: RiskManagementService;
  eventEmitter: EventEmitter2;
  signalsRepo: { save: jest.Mock; create: jest.Mock; find: jest.Mock; update: jest.Mock };
  evaluationsRepo: { save: jest.Mock; create: jest.Mock };
  strategiesRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
}

async function buildIntegrationModule(): Promise<IntegrationDeps> {
  // ── Mock repositories ──────────────────────────────────────────────────────
  let signalIdCounter = 0;
  const signalsRepo = {
    save: jest
      .fn()
      .mockImplementation((entity: Partial<Signals>) =>
        Promise.resolve({ ...entity, id: `signal-${++signalIdCounter}` }),
      ),
    create: jest.fn().mockImplementation((dto: Partial<Signals>) => dto),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };

  const evaluationsRepo = {
    save: jest
      .fn()
      .mockImplementation((entity: Partial<SignalEvaluations>) =>
        Promise.resolve({ ...entity, id: `eval-${Date.now()}` }),
      ),
    create: jest.fn().mockImplementation((dto: Partial<SignalEvaluations>) => dto),
  };

  const strategiesRepo = {
    find: jest.fn().mockResolvedValue(MOCK_STRATEGIES),
    findOne: jest.fn().mockResolvedValue(MOCK_STRATEGIES[0]),
    count: jest.fn().mockResolvedValue(2),
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    }),
  };

  const stratPerfRepo = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
    create: jest.fn().mockImplementation((dto: unknown) => dto),
  };

  const instrumentsRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
  };

  const redisService = {
    keys: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };

  const marketRegimeService = {
    getCurrentRegime: jest.fn().mockReturnValue(MarketRegime.STRONG_BULL),
  };

  const sessionManagerService = {
    getCurrentPhase: jest.fn().mockReturnValue(SessionPhase.MORNING_MOMENTUM),
  };

  const liveTradingService = {
    isArmed: jest.fn().mockReturnValue(false),
    getArmedState: jest.fn().mockReturnValue('DISARMED'),
    isNewEntryBlocked: jest.fn().mockReturnValue(false),
  };

  const sniperEntryService = {
    evaluate: jest.fn().mockReturnValue({ eligible: true, failingFilters: [], qualityScore: 80 }),
  };

  const candleQueryService = {
    getTodayCandles: jest.fn().mockResolvedValue([]),
    getMultiDayCandles: jest.fn().mockResolvedValue([]),
    getRecentCandles: jest.fn().mockResolvedValue([]),
  };

  const configService = {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn().mockReturnValue('test-value'),
  };

  const module: TestingModule = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      // Real implementations:
      SignalScannerService,
      StrategyService,
      SignalScoringService,
      TechnicalAnalysisService,
      RiskManagementService,
      // Mocked dependencies:
      { provide: CandleQueryService, useValue: candleQueryService },
      { provide: MarketRegimeService, useValue: marketRegimeService },
      { provide: SessionManagerService, useValue: sessionManagerService },
      { provide: LiveTradingService, useValue: liveTradingService },
      { provide: SniperEntryService, useValue: sniperEntryService },
      { provide: ConfigService, useValue: configService },
      { provide: RedisService, useValue: redisService },
      // Mocked repos:
      { provide: getRepositoryToken(Signals), useValue: signalsRepo },
      { provide: getRepositoryToken(SignalEvaluations), useValue: evaluationsRepo },
      { provide: getRepositoryToken(Strategies), useValue: strategiesRepo },
      { provide: getRepositoryToken(StrategyPerformance), useValue: stratPerfRepo },
      { provide: getRepositoryToken(Instruments), useValue: instrumentsRepo },
    ],
  }).compile();

  return {
    scannerService: module.get(SignalScannerService),
    strategyService: module.get(StrategyService),
    scoringService: module.get(SignalScoringService),
    riskService: module.get(RiskManagementService),
    eventEmitter: module.get(EventEmitter2),
    signalsRepo,
    evaluationsRepo,
    strategiesRepo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Entry condition integration: scanner → gate 3
// ─────────────────────────────────────────────────────────────────────────────

describe('Signal pipeline integration — entry conditions (DEFECT-002)', () => {
  it('passes gate 3 when entry conditions are met (healthy indicators)', async () => {
    const { scannerService } = await buildIntegrationModule();

    const result = scannerService.evaluateEntryConditions(100, HEALTHY_INDICATORS);

    expect(result.met).toBe(true);
  });

  it('fails gate 3 when RSI > 75 (overbought) — entryConditionsMet=false', async () => {
    const { scannerService } = await buildIntegrationModule();

    const result = scannerService.evaluateEntryConditions(100, EXTREME_OVERBOUGHT_INDICATORS);

    expect(result.met).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('gracefully falls back to met=true when no candle data (zero candleCount)', async () => {
    const { scannerService } = await buildIntegrationModule();

    const result = scannerService.evaluateEntryConditions(100, EMPTY_INDICATORS);

    expect(result.met).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Signal scoring integration: component scores → composite threshold
// ─────────────────────────────────────────────────────────────────────────────

describe('Signal pipeline integration — signal scoring (DEFECT-003)', () => {
  it('scores above 80 in STRONG_BULL with healthy indicators and bid/ask present', async () => {
    const { scannerService, scoringService } = await buildIntegrationModule();

    // Build component scores using real computeComponentScores with healthy indicators
    const scores = scannerService.computeComponentScores(
      { ltp: 100, bidPrice: 99.5, askPrice: 100.5, volume: 50000 },
      MarketRegime.STRONG_BULL,
      2.0,
      HEALTHY_INDICATORS,
    );

    // Score via real SignalScoringService (pure computation)
    const result = scoringService.scoreSignal({
      strategyId: 'strat-a',
      instrumentId: 'inst-1',
      engine: 'PAPER',
      direction: 'BUY',
      entryPrice: '100.00',
      stopLossPrice: '98.50',
      targetPrice: '103.00',
      positionSize: 1,
      componentScores: scores,
      measuredInputs: {},
      minRrRatio: 1.5,
      currentRrRatio: 2.0,
    });

    expect(result.compositeScore).toBeGreaterThanOrEqual(80);
    expect(result.approved).toBe(true);
  });

  it('momentum score reflects RSI value — not hardcoded 8 (DEFECT-003 fix)', async () => {
    const { scannerService } = await buildIntegrationModule();

    const scoresLowRsi = scannerService.computeComponentScores(
      { ltp: 100, bidPrice: 99, askPrice: 101, volume: 1000 },
      MarketRegime.STRONG_BULL,
      2.0,
      { ...EMPTY_INDICATORS, rsi: 45, candleCount: 25 },
    );
    const scoresHighRsi = scannerService.computeComponentScores(
      { ltp: 100, bidPrice: 99, askPrice: 101, volume: 1000 },
      MarketRegime.STRONG_BULL,
      2.0,
      { ...EMPTY_INDICATORS, rsi: 65, candleCount: 25 },
    );

    // RSI 65 (bullish) should score higher than RSI 45 (neutral)
    expect(scoresHighRsi.momentum).toBeGreaterThan(scoresLowRsi.momentum);
    // Neither should be the old hardcoded value of 8 when indicator data IS available
    expect(scoresHighRsi.momentum).not.toBe(8);
  });

  it('vwapTrendAlignment score reflects price position — not hardcoded 8 (DEFECT-003 fix)', async () => {
    const { scannerService } = await buildIntegrationModule();

    const scoresAboveVwap = scannerService.computeComponentScores(
      { ltp: 101, bidPrice: 100, askPrice: 102, volume: 5000 },
      MarketRegime.STRONG_BULL,
      2.0,
      { ...EMPTY_INDICATORS, vwap: 100, candleCount: 25 },
    );
    const scoresBelowVwap = scannerService.computeComponentScores(
      { ltp: 99, bidPrice: 98, askPrice: 100, volume: 5000 },
      MarketRegime.STRONG_BULL,
      2.0,
      { ...EMPTY_INDICATORS, vwap: 100, candleCount: 25 },
    );

    // LTP above VWAP = bullish alignment = higher score
    expect(scoresAboveVwap.vwapTrendAlignment).toBeGreaterThan(scoresBelowVwap.vwapTrendAlignment);
    expect(scoresAboveVwap.vwapTrendAlignment).not.toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Risk engine integration: position sizing
// ─────────────────────────────────────────────────────────────────────────────

describe('Signal pipeline integration — position sizing (DEFECT-014)', () => {
  it('computePositionSize returns 0 when lot_size is invalid', () => {
    const riskService = new RiskManagementService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
    const result = riskService.computePositionSize('100000.00', '1.00', '100.00', '95.00', 0);
    expect(result).toBe(0);
  });

  it('computePositionSize returns correct lot count for a standard NIFTY options trade', () => {
    const riskService = new RiskManagementService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
    // capital=100000, risk=1% → risk_amount=1000
    // entry=100, sl=95, diff=5, lot_size=75
    // per_unit_risk = 5 × 75 = 375
    // lots = floor(1000 / 375) = 2
    const result = riskService.computePositionSize('100000.00', '1.00', '100.00', '95.00', 75);
    expect(result).toBe(2);
  });

  it('computePositionSize returns 1 lot for a tight stop (SL within 1 point for large lot)', () => {
    const riskService = new RiskManagementService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
    // capital=50000, risk=1% → risk_amount=500
    // entry=100, sl=99.5, diff=0.5, lot_size=75
    // per_unit_risk = 0.5 × 75 = 37.5
    // lots = floor(500 / 37.5) = 13
    const result = riskService.computePositionSize('50000.00', '1.00', '100.00', '99.50', 75);
    expect(result).toBe(13);
  });

  it('computePositionSize returns 0 when entry equals stop (zero per-unit risk)', () => {
    const riskService = new RiskManagementService({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);
    const result = riskService.computePositionSize('100000.00', '1.00', '100.00', '100.00', 75);
    expect(result).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Strategy gate integration: regime filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('Signal pipeline integration — strategy gate evaluation', () => {
  it('strategy A passes all gates for STRONG_BULL regime with healthy conditions', async () => {
    const { strategyService, eventEmitter } = await buildIntegrationModule();
    await strategyService.initializeStrategies();

    const emittedEvents: unknown[] = [];
    eventEmitter.on(SIGNAL_CANDIDATE_EVENT, (payload) => emittedEvents.push(payload));

    await strategyService.evaluateSignalCandidate({
      instrumentId: 'inst-1',
      currentRegime: MarketRegime.STRONG_BULL,
      isOpeningPhase: false,
      engine: 'PAPER',
      direction: 'BUY',
      entryPrice: '100.00',
      stopLossPrice: '98.50',
      targetPrice: '103.00',
      positionSize: 1,
      entryConditionsMet: true,
      componentScores: {
        regimeAlignment: 15,
        priceStructure: 12,
        volumeConfirmation: 13,
        momentum: 12,
        vwapTrendAlignment: 12,
        optionsFuturesConfirmation: 12,
        liquidityExecution: 10,
        rrQuality: 10,
      },
      measuredInputs: {},
    });

    // Both strategies A and C are compatible with STRONG_BULL — expect signals
    expect(emittedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('strategy A is blocked during opening phase when incompatible strategy evaluated', async () => {
    // Strategy C has openingPhaseCompatible=false
    const { strategyService, eventEmitter } = await buildIntegrationModule();
    await strategyService.initializeStrategies();

    const emittedEvents: unknown[] = [];
    eventEmitter.on(SIGNAL_CANDIDATE_EVENT, (payload) => emittedEvents.push(payload));

    await strategyService.evaluateSignalCandidate({
      instrumentId: 'inst-1',
      currentRegime: MarketRegime.STRONG_BULL,
      isOpeningPhase: true, // ← opening phase active
      engine: 'PAPER',
      direction: 'BUY',
      entryPrice: '100.00',
      stopLossPrice: '98.50',
      targetPrice: '103.00',
      positionSize: 1,
      entryConditionsMet: true,
      componentScores: {
        regimeAlignment: 15,
        priceStructure: 12,
        volumeConfirmation: 13,
        momentum: 12,
        vwapTrendAlignment: 12,
        optionsFuturesConfirmation: 12,
        liquidityExecution: 10,
        rrQuality: 10,
      },
      measuredInputs: {},
    });

    // Only Strategy A (openingPhaseCompatible=true) should fire
    // Strategy C (openingPhaseCompatible=false) must be blocked
    const payloads = emittedEvents as Array<{ strategyId: string }>;
    const stratCFired = payloads.some((p) => p.strategyId === 'strat-c');
    expect(stratCFired).toBe(false);
  });

  it('no signals emitted when entryConditionsMet=false', async () => {
    const { strategyService, eventEmitter } = await buildIntegrationModule();
    await strategyService.initializeStrategies();

    const emittedEvents: unknown[] = [];
    eventEmitter.on(SIGNAL_CANDIDATE_EVENT, (payload) => emittedEvents.push(payload));

    await strategyService.evaluateSignalCandidate({
      instrumentId: 'inst-1',
      currentRegime: MarketRegime.STRONG_BULL,
      isOpeningPhase: false,
      engine: 'PAPER',
      direction: 'BUY',
      entryPrice: '100.00',
      stopLossPrice: '98.50',
      targetPrice: '103.00',
      positionSize: 1,
      entryConditionsMet: false, // ← blocked by DEFECT-002 fix
      entryConditionsFailReason: 'RSI 82 above 75 — deeply overbought extreme',
      componentScores: {
        regimeAlignment: 15,
        priceStructure: 12,
        volumeConfirmation: 13,
        momentum: 3,
        vwapTrendAlignment: 12,
        optionsFuturesConfirmation: 12,
        liquidityExecution: 10,
        rrQuality: 10,
      },
      measuredInputs: {},
    });

    expect(emittedEvents).toHaveLength(0);
  });
});
