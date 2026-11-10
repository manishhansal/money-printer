/**
 * strategy.service.spec.ts
 *
 * Unit tests for StrategyService.
 *
 * All tests use in-memory stubs — no real PostgreSQL connection is required.
 * The TypeORM repositories are replaced with jest mocks that the test suite
 * controls directly.  EventEmitter2 is also mocked so Gate-5 event assertions
 * can be made without a running NestJS event bus.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Strategies } from '../../database/entities/strategies.entity';
import { SignalEvaluations } from '../../database/entities/signal-evaluations.entity';
import { StrategyPerformance } from '../../database/entities/strategy-performance.entity';
import { StrategyService } from './strategy.service';
import {
  STRATEGY_CONFIGS,
  SignalCandidateInput,
  SIGNAL_CANDIDATE_EVENT,
  STRATEGY_DEGRADATION_EVENT,
} from './strategy.types';
import { MarketRegime } from '../market-regime/market-regime.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal Strategies entity stub from a seed config.
 * Runtime-managed fields default to their "new strategy" values.
 */
function makeStrategy(overrides: Partial<Strategies> = {}): Strategies {
  return {
    id: 'uuid-stub',
    code: 'A',
    name: 'Opening Range Breakout',
    isActive: true,
    isSuspended: false,
    compatibleRegimes: [MarketRegime.BREAKOUT, MarketRegime.STRONG_BULL, MarketRegime.STRONG_BEAR],
    minRrRatio: '1.5',
    maxConcurrentPositions: 3,
    openingPhaseCompatible: true,
    minPerformanceThreshold: null,
    currentOosWinRate: null,
    version: 1,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  } as Strategies;
}

/**
 * Build all 8 strategy stubs matching the canonical STRATEGY_CONFIGS seed.
 */
function makeAllStrategies(): Strategies[] {
  return STRATEGY_CONFIGS.map((cfg) =>
    makeStrategy({
      id: `uuid-${cfg.code}`,
      code: cfg.code,
      name: cfg.name,
      compatibleRegimes: [...cfg.compatibleRegimes],
      minRrRatio: cfg.minRrRatio,
      maxConcurrentPositions: cfg.maxConcurrentPositions,
      openingPhaseCompatible: cfg.openingPhaseCompatible,
    }),
  );
}

/**
 * Build a minimal valid SignalCandidateInput for testing gate evaluation.
 * Defaults: STRONG_BULL regime, non-opening phase, entry conditions met,
 *           prices that give R:R = 2.0 (target 10 pts above entry, stop 5 pts below).
 */
function makeCandidate(overrides: Partial<SignalCandidateInput> = {}): SignalCandidateInput {
  return {
    instrumentId: 'instrument-uuid-1',
    currentRegime: MarketRegime.STRONG_BULL,
    isOpeningPhase: false,
    engine: 'LIVE',
    direction: 'BUY',
    entryPrice: '100.00',
    stopLossPrice: '95.00', // risk = 5
    targetPrice: '110.00', // reward = 10, R:R = 2.0
    positionSize: 1,
    componentScores: {
      regimeAlignment: 15,
      priceStructure: 15,
      volumeConfirmation: 15,
      momentum: 10,
      vwapTrendAlignment: 10,
      optionsFuturesConfirmation: 15,
      liquidityExecution: 10,
      rrQuality: 10,
    },
    measuredInputs: { rsi: 60, macd: 0.5 },
    entryConditionsMet: true,
    ...overrides,
  };
}

/** Build a stub SignalEvaluations record returned by the mock save(). */
function makeEvaluationStub(overrides: Partial<SignalEvaluations> = {}): SignalEvaluations {
  return {
    id: 'eval-uuid-stub',
    strategy: makeStrategy(),
    strategyId: 'uuid-stub',
    instrumentId: 'instrument-uuid-1',
    evaluatedAt: new Date(),
    producedSignal: false,
    skipReason: null,
    signal: null,
    signalId: null,
    regimeAtEvaluation: null,
    ...overrides,
  } as SignalEvaluations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock repository factories
// ─────────────────────────────────────────────────────────────────────────────

function buildMockStrategiesRepo() {
  return {
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    save: jest.fn(),
  };
}

function buildMockSignalEvaluationsRepo() {
  return {
    create: jest.fn(),
    save: jest.fn(),
  };
}

function buildMockStrategyPerformanceRepo() {
  return {
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('StrategyService', () => {
  let service: StrategyService;
  let strategiesRepo: ReturnType<typeof buildMockStrategiesRepo>;
  let signalEvaluationsRepo: ReturnType<typeof buildMockSignalEvaluationsRepo>;
  let strategyPerformanceRepo: ReturnType<typeof buildMockStrategyPerformanceRepo>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    strategiesRepo = buildMockStrategiesRepo();
    signalEvaluationsRepo = buildMockSignalEvaluationsRepo();
    strategyPerformanceRepo = buildMockStrategyPerformanceRepo();
    eventEmitter = { emit: jest.fn() };

    // Default: create() returns a plain object, save() returns it with an id.
    signalEvaluationsRepo.create.mockImplementation((data) => ({ id: 'eval-uuid-stub', ...data }));
    signalEvaluationsRepo.save.mockImplementation(async (entity) => entity);

    strategyPerformanceRepo.create.mockImplementation((data) => ({
      id: 'perf-uuid-stub',
      ...data,
    }));
    strategyPerformanceRepo.save.mockImplementation(async (entity) => entity);

    strategiesRepo.save.mockImplementation(async (entity) => entity);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyService,
        {
          provide: getRepositoryToken(Strategies),
          useValue: strategiesRepo,
        },
        {
          provide: getRepositoryToken(SignalEvaluations),
          useValue: signalEvaluationsRepo,
        },
        {
          provide: getRepositoryToken(StrategyPerformance),
          useValue: strategyPerformanceRepo,
        },
        {
          provide: EventEmitter2,
          useValue: eventEmitter,
        },
      ],
    }).compile();

    service = module.get<StrategyService>(StrategyService);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // initializeStrategies
  // ───────────────────────────────────────────────────────────────────────────

  describe('initializeStrategies()', () => {
    it('should attempt to upsert exactly 8 strategies', async () => {
      // Arrange: mock the query builder chain
      const executeMock = jest.fn().mockResolvedValue({ identifiers: [] });
      const orUpdateMock = jest.fn().mockReturnValue({ execute: executeMock });
      const valuesMock = jest.fn().mockReturnValue({ orUpdate: orUpdateMock });
      const intoMock = jest.fn().mockReturnValue({ values: valuesMock });
      const insertMock = jest.fn().mockReturnValue({ into: intoMock });
      strategiesRepo.createQueryBuilder.mockReturnValue({ insert: insertMock });
      strategiesRepo.count.mockResolvedValue(8);

      // Act
      await service.initializeStrategies();

      // Assert: createQueryBuilder called once per strategy
      expect(strategiesRepo.createQueryBuilder).toHaveBeenCalledTimes(8);
      expect(executeMock).toHaveBeenCalledTimes(8);
    });

    it('should upsert strategy A with correct configuration', async () => {
      // Arrange
      const capturedValues: Array<Partial<Strategies>> = [];
      const executeMock = jest.fn().mockResolvedValue({ identifiers: [] });
      const orUpdateMock = jest.fn().mockReturnValue({ execute: executeMock });
      const valuesMock = jest.fn().mockImplementation((v) => {
        capturedValues.push(v);
        return { orUpdate: orUpdateMock };
      });
      const intoMock = jest.fn().mockReturnValue({ values: valuesMock });
      const insertMock = jest.fn().mockReturnValue({ into: intoMock });
      strategiesRepo.createQueryBuilder.mockReturnValue({ insert: insertMock });
      strategiesRepo.count.mockResolvedValue(8);

      // Act
      await service.initializeStrategies();

      // Assert: strategy A is the first upserted record
      const stratA = capturedValues.find((v) => v.code === 'A');
      expect(stratA).toBeDefined();
      expect(stratA!.name).toBe('Opening Range Breakout');
      expect(stratA!.openingPhaseCompatible).toBe(true);
      expect(stratA!.minRrRatio).toBe('1.5');
      expect(stratA!.maxConcurrentPositions).toBe(3);
      expect(stratA!.compatibleRegimes).toEqual(
        expect.arrayContaining([
          MarketRegime.BREAKOUT,
          MarketRegime.STRONG_BULL,
          MarketRegime.STRONG_BEAR,
        ]),
      );
    });

    it('should continue processing remaining strategies even if one upsert fails', async () => {
      // Arrange: first upsert fails, rest succeed
      let callCount = 0;
      const executeMock = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('DB error'));
        return Promise.resolve({ identifiers: [] });
      });
      const orUpdateMock = jest.fn().mockReturnValue({ execute: executeMock });
      const valuesMock = jest.fn().mockReturnValue({ orUpdate: orUpdateMock });
      const intoMock = jest.fn().mockReturnValue({ values: valuesMock });
      const insertMock = jest.fn().mockReturnValue({ into: intoMock });
      strategiesRepo.createQueryBuilder.mockReturnValue({ insert: insertMock });
      strategiesRepo.count.mockResolvedValue(7);

      // Act — should not throw
      await expect(service.initializeStrategies()).resolves.toBeUndefined();

      // Assert: remaining 7 strategies were still upserted
      expect(executeMock).toHaveBeenCalledTimes(8);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getActiveStrategies
  // ───────────────────────────────────────────────────────────────────────────

  describe('getActiveStrategies()', () => {
    it('should return all active, non-suspended strategies', async () => {
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      const result = await service.getActiveStrategies();

      expect(result).toHaveLength(8);
      expect(strategiesRepo.find).toHaveBeenCalledWith({
        where: { isActive: true, isSuspended: false },
        order: { code: 'ASC' },
      });
    });

    it('should not return suspended strategies', async () => {
      const active = makeAllStrategies().filter((s) => s.code !== 'C');
      strategiesRepo.find.mockResolvedValue(active);

      const result = await service.getActiveStrategies();

      expect(result.some((s) => s.code === 'C')).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getStrategyByCode
  // ───────────────────────────────────────────────────────────────────────────

  describe('getStrategyByCode()', () => {
    it('should return the matching strategy for a valid code', async () => {
      const stratA = makeStrategy({ code: 'A', name: 'Opening Range Breakout' });
      strategiesRepo.findOne.mockResolvedValue(stratA);

      const result = await service.getStrategyByCode('A');

      expect(result).toEqual(stratA);
      expect(strategiesRepo.findOne).toHaveBeenCalledWith({ where: { code: 'A' } });
    });

    it('should return null when no strategy matches the code', async () => {
      strategiesRepo.findOne.mockResolvedValue(null);

      const result = await service.getStrategyByCode('Z');

      expect(result).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getCompatibleStrategies
  // ───────────────────────────────────────────────────────────────────────────

  describe('getCompatibleStrategies()', () => {
    it('should return only strategies compatible with the current regime', async () => {
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      const result = await service.getCompatibleStrategies(MarketRegime.STRONG_BULL, false);

      // STRONG_BULL is in the compatible list for strategies: A, C, D, E, G, H
      const codes = result.map((s) => s.code).sort();
      expect(codes).toEqual(['A', 'C', 'D', 'E', 'G', 'H']);
    });

    it('should return only strategies compatible with BREAKOUT regime', async () => {
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      const result = await service.getCompatibleStrategies(MarketRegime.BREAKOUT, false);

      // BREAKOUT is in the compatible list for strategies: A, C, D, H
      const codes = result.map((s) => s.code).sort();
      expect(codes).toEqual(['A', 'C', 'D', 'H']);
    });

    it('should filter to only opening-phase-compatible strategies when isOpeningPhase is true', async () => {
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      // STRONG_BULL is compatible with A, C, D, E, G, H — but only A has openingPhaseCompatible=true
      const result = await service.getCompatibleStrategies(MarketRegime.STRONG_BULL, true);

      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('A');
    });

    it('should return empty array when no strategies are compatible with the regime', async () => {
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      // SIDEWAYS is not in any strategy's compatibleRegimes list
      const result = await service.getCompatibleStrategies(MarketRegime.SIDEWAYS, false);

      expect(result).toHaveLength(0);
    });

    it('should return empty array when isOpeningPhase is true and no compatible strategies support opening phase', async () => {
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      // REVERSAL is compatible with B and F, neither of which has openingPhaseCompatible=true
      const result = await service.getCompatibleStrategies(MarketRegime.REVERSAL, true);

      expect(result).toHaveLength(0);
    });

    it('should return empty array when no active strategies exist', async () => {
      strategiesRepo.find.mockResolvedValue([]);

      const result = await service.getCompatibleStrategies(MarketRegime.STRONG_BULL, false);

      expect(result).toHaveLength(0);
    });

    it('should not apply opening-phase filter when isOpeningPhase is false', async () => {
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      // BREAKOUT: compatible with A (openingPhaseCompatible=true), C, D, H (all false)
      const resultWithoutPhase = await service.getCompatibleStrategies(
        MarketRegime.BREAKOUT,
        false,
      );
      const resultWithPhase = await service.getCompatibleStrategies(MarketRegime.BREAKOUT, true);

      // Without opening-phase filter: 4 strategies
      expect(resultWithoutPhase.map((s) => s.code).sort()).toEqual(['A', 'C', 'D', 'H']);
      // With opening-phase filter: only A
      expect(resultWithPhase.map((s) => s.code)).toEqual(['A']);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // onModuleInit
  // ───────────────────────────────────────────────────────────────────────────

  describe('onModuleInit()', () => {
    it('should call initializeStrategies on module init', async () => {
      const spy = jest.spyOn(service, 'initializeStrategies').mockResolvedValue();

      await service.onModuleInit();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STRATEGY_CONFIGS invariants
  // ───────────────────────────────────────────────────────────────────────────

  describe('STRATEGY_CONFIGS seed data invariants', () => {
    it('should contain exactly 8 strategies', () => {
      expect(STRATEGY_CONFIGS).toHaveLength(8);
    });

    it('should have unique strategy codes A–H', () => {
      const codes = STRATEGY_CONFIGS.map((c) => c.code);
      const unique = new Set(codes);
      expect(unique.size).toBe(8);
      expect(codes.sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    });

    it('should have min_rr_ratio between 1.0 and 10.0 for all strategies', () => {
      for (const cfg of STRATEGY_CONFIGS) {
        const ratio = parseFloat(cfg.minRrRatio);
        expect(ratio).toBeGreaterThanOrEqual(1.0);
        expect(ratio).toBeLessThanOrEqual(10.0);
      }
    });

    it('should have max_concurrent_positions between 1 and 20 for all strategies', () => {
      for (const cfg of STRATEGY_CONFIGS) {
        expect(cfg.maxConcurrentPositions).toBeGreaterThanOrEqual(1);
        expect(cfg.maxConcurrentPositions).toBeLessThanOrEqual(20);
      }
    });

    it('should have at least one compatible regime for each strategy', () => {
      for (const cfg of STRATEGY_CONFIGS) {
        expect(cfg.compatibleRegimes.length).toBeGreaterThan(0);
      }
    });

    it('should only have opening_phase_compatible=true for Strategy A', () => {
      const openingCompatible = STRATEGY_CONFIGS.filter((c) => c.openingPhaseCompatible);
      expect(openingCompatible).toHaveLength(1);
      expect(openingCompatible[0].code).toBe('A');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // evaluateSignalCandidate — Gate 1: Regime unavailable
  // ───────────────────────────────────────────────────────────────────────────

  describe('evaluateSignalCandidate() — Gate 1: regime unavailable', () => {
    it('should record "regime unavailable" for all active strategies when regime is null', async () => {
      // Arrange
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      const candidate = makeCandidate({ currentRegime: null });

      // Act
      await service.evaluateSignalCandidate(candidate);

      // Assert: one evaluation record per strategy, all with "regime unavailable"
      expect(signalEvaluationsRepo.create).toHaveBeenCalledTimes(8);
      expect(signalEvaluationsRepo.save).toHaveBeenCalledTimes(8);

      const allCreateCalls = signalEvaluationsRepo.create.mock.calls;
      for (const [data] of allCreateCalls) {
        expect(data.skipReason).toBe('regime unavailable');
        expect(data.producedSignal).toBe(false);
        expect(data.regimeAtEvaluation).toBeNull();
      }
    });

    it('should not emit any SIGNAL_CANDIDATE_EVENT when regime is unavailable', async () => {
      strategiesRepo.find.mockResolvedValue(makeAllStrategies());

      await service.evaluateSignalCandidate(makeCandidate({ currentRegime: null }));

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should return early after recording Gate 1 without evaluating any strategy', async () => {
      strategiesRepo.find.mockResolvedValue(makeAllStrategies());

      await service.evaluateSignalCandidate(makeCandidate({ currentRegime: null }));

      // find() should have been called once (via getActiveStrategies for Gate 1)
      expect(strategiesRepo.find).toHaveBeenCalledTimes(1);
    });

    it('should record nothing and not throw when there are no active strategies', async () => {
      strategiesRepo.find.mockResolvedValue([]);

      await expect(
        service.evaluateSignalCandidate(makeCandidate({ currentRegime: null })),
      ).resolves.toBeUndefined();

      expect(signalEvaluationsRepo.create).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // evaluateSignalCandidate — Gate 2: Incompatible regime
  // ───────────────────────────────────────────────────────────────────────────

  describe('evaluateSignalCandidate() — Gate 2: incompatible regime', () => {
    it('should record "incompatible regime" for strategies whose compatibleRegimes does not include the current regime', async () => {
      // Arrange: use all 8 strategies; SIDEWAYS matches none
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      const candidate = makeCandidate({ currentRegime: MarketRegime.SIDEWAYS });

      // Act
      await service.evaluateSignalCandidate(candidate);

      // Assert: all 8 strategies should have "incompatible regime" skip
      const allCreateCalls = signalEvaluationsRepo.create.mock.calls;
      expect(allCreateCalls).toHaveLength(8);
      for (const [data] of allCreateCalls) {
        expect(data.skipReason).toBe('incompatible regime');
        expect(data.producedSignal).toBe(false);
        expect(data.regimeAtEvaluation).toBe(MarketRegime.SIDEWAYS);
      }
    });

    it('should only skip strategies whose regime list does not include the current regime', async () => {
      // Arrange: STRONG_BULL matches A, C, D, E, G, H — but NOT B, F
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      // Use entry conditions NOT met so that only Gate 2 rejects/passes (gates 3+ won't pass)
      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        entryConditionsMet: false,
        entryConditionsFailReason: 'test-reason',
      });

      // Act
      await service.evaluateSignalCandidate(candidate);

      // B and F get "incompatible regime"; A, C, D, E, G, H get "test-reason"
      const allCreateCalls = signalEvaluationsRepo.create.mock.calls;
      const incompatibleCodes = allCreateCalls
        .filter(([d]) => d.skipReason === 'incompatible regime')
        .map(([d]) => d.strategy.code)
        .sort();
      const entryCodes = allCreateCalls
        .filter(([d]) => d.skipReason === 'test-reason')
        .map(([d]) => d.strategy.code)
        .sort();

      expect(incompatibleCodes).toEqual(['B', 'F']);
      expect(entryCodes).toEqual(['A', 'C', 'D', 'E', 'G', 'H']);
    });

    it('should record "opening phase restriction" for opening-phase-incompatible strategies during opening phase', async () => {
      // During opening phase with STRONG_BULL: only A is opening-phase-compatible.
      // B and F are incompatible with STRONG_BULL so they get Gate 2a.
      // C, D, E, G, H are regime-compatible but NOT opening-phase-compatible → Gate 2b.
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        isOpeningPhase: true,
        entryConditionsMet: false,
        entryConditionsFailReason: 'test-reason',
      });

      await service.evaluateSignalCandidate(candidate);

      const allCreateCalls = signalEvaluationsRepo.create.mock.calls;

      const incompatibleRegimeCodes = allCreateCalls
        .filter(([d]) => d.skipReason === 'incompatible regime')
        .map(([d]) => d.strategy.code)
        .sort();
      const openingPhaseCodes = allCreateCalls
        .filter(([d]) => d.skipReason === 'opening phase restriction')
        .map(([d]) => d.strategy.code)
        .sort();
      const entryCodes = allCreateCalls
        .filter(([d]) => d.skipReason === 'test-reason')
        .map(([d]) => d.strategy.code);

      expect(incompatibleRegimeCodes).toEqual(['B', 'F']);
      expect(openingPhaseCodes).toEqual(['C', 'D', 'E', 'G', 'H']);
      expect(entryCodes).toEqual(['A']); // only A passes Gate 2 during opening phase
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // evaluateSignalCandidate — Gate 3: Entry conditions
  // ───────────────────────────────────────────────────────────────────────────

  describe('evaluateSignalCandidate() — Gate 3: entry conditions', () => {
    it('should record the fail reason when entryConditionsMet is false', async () => {
      // Use only strategy A (compatible with STRONG_BULL, non-opening-phase)
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        entryConditionsMet: false,
        entryConditionsFailReason: 'price below ORB level',
      });

      await service.evaluateSignalCandidate(candidate);

      expect(signalEvaluationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          skipReason: 'price below ORB level',
          producedSignal: false,
        }),
      );
    });

    it('should use default "entry conditions not met" reason when no fail reason is provided', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        entryConditionsMet: false,
        // no entryConditionsFailReason
      });

      await service.evaluateSignalCandidate(candidate);

      expect(signalEvaluationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ skipReason: 'entry conditions not met' }),
      );
    });

    it('should not emit any event when entry conditions are not met', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      await service.evaluateSignalCandidate(
        makeCandidate({ currentRegime: MarketRegime.STRONG_BULL, entryConditionsMet: false }),
      );

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // evaluateSignalCandidate — Gate 4: R:R below minimum
  // ───────────────────────────────────────────────────────────────────────────

  describe('evaluateSignalCandidate() — Gate 4: R:R below minimum', () => {
    it('should record "r:r below minimum" when computed R:R < strategy.minRrRatio', async () => {
      // Arrange: R:R = 0.5 (target 2.5 pts, stop 5 pts); minRrRatio = 1.5
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        entryConditionsMet: true,
        entryPrice: '100.00',
        stopLossPrice: '95.00', // risk = 5
        targetPrice: '102.50', // reward = 2.5 → R:R = 0.5
      });

      await service.evaluateSignalCandidate(candidate);

      expect(signalEvaluationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          skipReason: 'r:r below minimum',
          producedSignal: false,
        }),
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should not skip when R:R exactly equals strategy.minRrRatio', async () => {
      // Arrange: R:R = 1.5; minRrRatio = 1.5 → should PASS Gate 4
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        entryConditionsMet: true,
        entryPrice: '100.00',
        stopLossPrice: '90.00', // risk = 10
        targetPrice: '115.00', // reward = 15 → R:R = 1.5
      });

      await service.evaluateSignalCandidate(candidate);

      // Should reach Gate 5 — event should be emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SIGNAL_CANDIDATE_EVENT,
        expect.objectContaining({ currentRrRatio: 1.5 }),
      );
    });

    it('should record "r:r below minimum" when risk is zero (entry === stop)', async () => {
      // Zero risk → R:R = 0, which is below any positive threshold
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        entryConditionsMet: true,
        entryPrice: '100.00',
        stopLossPrice: '100.00', // risk = 0 → R:R = 0
        targetPrice: '110.00',
      });

      await service.evaluateSignalCandidate(candidate);

      expect(signalEvaluationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ skipReason: 'r:r below minimum' }),
      );
    });

    it("should use each strategy's own minRrRatio for the check", async () => {
      // Strategy A: minRrRatio = 1.5; Strategy C: minRrRatio = 2.0
      // R:R = 1.6 → A passes Gate 4, C fails Gate 4
      const strategies = [
        makeStrategy({
          id: 'uuid-A',
          code: 'A',
          compatibleRegimes: [MarketRegime.STRONG_BULL],
          openingPhaseCompatible: false,
          minRrRatio: '1.5',
        }),
        makeStrategy({
          id: 'uuid-C',
          code: 'C',
          compatibleRegimes: [MarketRegime.STRONG_BULL],
          openingPhaseCompatible: false,
          minRrRatio: '2.0',
        }),
      ];
      strategiesRepo.find.mockResolvedValue(strategies);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        entryConditionsMet: true,
        entryPrice: '100.00',
        stopLossPrice: '90.00', // risk = 10
        targetPrice: '116.00', // reward = 16 → R:R = 1.6
      });

      await service.evaluateSignalCandidate(candidate);

      const allCreateCalls = signalEvaluationsRepo.create.mock.calls;
      const stratACall = allCreateCalls.find(([d]) => d.strategy.code === 'A');
      const stratCCall = allCreateCalls.find(([d]) => d.strategy.code === 'C');

      expect(stratACall?.[0].producedSignal).toBe(true);
      expect(stratACall?.[0].skipReason).toBeNull();
      expect(stratCCall?.[0].skipReason).toBe('r:r below minimum');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // evaluateSignalCandidate — Gate 5: Happy path (all gates pass)
  // ───────────────────────────────────────────────────────────────────────────

  describe('evaluateSignalCandidate() — Gate 5: signal generated', () => {
    it('should record producedSignal=true with no skipReason when all gates pass', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({ currentRegime: MarketRegime.STRONG_BULL });

      await service.evaluateSignalCandidate(candidate);

      expect(signalEvaluationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          producedSignal: true,
          skipReason: null,
          regimeAtEvaluation: MarketRegime.STRONG_BULL,
        }),
      );
    });

    it('should emit SIGNAL_CANDIDATE_EVENT with correct payload when all gates pass', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({ currentRegime: MarketRegime.STRONG_BULL });

      await service.evaluateSignalCandidate(candidate);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SIGNAL_CANDIDATE_EVENT,
        expect.objectContaining({
          strategyId: 'uuid-A',
          instrumentId: 'instrument-uuid-1',
          engine: 'LIVE',
          direction: 'BUY',
          entryPrice: '100.00',
          stopLossPrice: '95.00',
          targetPrice: '110.00',
          currentRrRatio: 2,
          minRrRatio: 1.5,
          regime: MarketRegime.STRONG_BULL,
        }),
      );
    });

    it('should include the evaluationId from the saved record in the emitted payload', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      // Override save() to return a stub with a specific id
      signalEvaluationsRepo.save.mockResolvedValueOnce(
        makeEvaluationStub({ id: 'evaluation-id-gate5' }),
      );

      await service.evaluateSignalCandidate(
        makeCandidate({ currentRegime: MarketRegime.STRONG_BULL }),
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SIGNAL_CANDIDATE_EVENT,
        expect.objectContaining({ evaluationId: 'evaluation-id-gate5' }),
      );
    });

    it('should emit one event per strategy that passes all gates', async () => {
      // STRONG_BULL is compatible with A, C, D, E, G, H; R:R = 2.0 > all minRrRatios
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      const candidate = makeCandidate({ currentRegime: MarketRegime.STRONG_BULL });

      await service.evaluateSignalCandidate(candidate);

      // A, C, D, E, G, H pass regime gate; all have minRrRatio <= 2.0
      expect(eventEmitter.emit).toHaveBeenCalledTimes(6);
    });

    it('should include per-component scores and measuredInputs in the emitted payload', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.STRONG_BULL,
        componentScores: {
          regimeAlignment: 15,
          priceStructure: 12,
          volumeConfirmation: 10,
          momentum: 8,
          vwapTrendAlignment: 9,
          optionsFuturesConfirmation: 11,
          liquidityExecution: 7,
          rrQuality: 10,
        },
        measuredInputs: { rsi: 65, volume: 1200000 },
      });

      await service.evaluateSignalCandidate(candidate);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SIGNAL_CANDIDATE_EVENT,
        expect.objectContaining({
          componentScores: candidate.componentScores,
          measuredInputs: { rsi: 65, volume: 1200000 },
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // evaluateSignalCandidate — mixed / full pipeline
  // ───────────────────────────────────────────────────────────────────────────

  describe('evaluateSignalCandidate() — full pipeline', () => {
    it('should produce a SignalEvaluations record for every strategy in every call', async () => {
      // 8 strategies; STRONG_BULL: 2 incompatible (B, F), 6 regime-compatible
      // R:R = 2.0 passes all strategy minimums → 6 signals emitted
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      await service.evaluateSignalCandidate(
        makeCandidate({ currentRegime: MarketRegime.STRONG_BULL }),
      );

      // Exactly 8 evaluations recorded (Requirement 6.5)
      expect(signalEvaluationsRepo.create).toHaveBeenCalledTimes(8);
    });

    it('should not throw when signalEvaluationsRepo.save() fails for one record', async () => {
      const allStrategies = makeAllStrategies();
      strategiesRepo.find.mockResolvedValue(allStrategies);

      // First save fails; rest succeed
      let saveCount = 0;
      signalEvaluationsRepo.save.mockImplementation(async (entity) => {
        saveCount++;
        if (saveCount === 1) throw new Error('DB write failure');
        return entity;
      });

      await expect(
        service.evaluateSignalCandidate(makeCandidate({ currentRegime: null })),
      ).resolves.toBeUndefined();
    });

    it('should record regimeAtEvaluation on all Gate 2+ evaluations', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.BREAKOUT],
        openingPhaseCompatible: false,
        minRrRatio: '1.5',
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      const candidate = makeCandidate({
        currentRegime: MarketRegime.BREAKOUT,
        entryConditionsMet: false,
      });

      await service.evaluateSignalCandidate(candidate);

      expect(signalEvaluationsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ regimeAtEvaluation: MarketRegime.BREAKOUT }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // updateStrategyPerformanceMetrics
  // ───────────────────────────────────────────────────────────────────────────

  describe('updateStrategyPerformanceMetrics()', () => {
    /** Build a minimal StrategyPerformance row stub with configurable counts. */
    function makePerfRow(overrides: Partial<StrategyPerformance> = {}): StrategyPerformance {
      return {
        id: 'perf-row-stub',
        strategy_id: 'uuid-A',
        engine: 'LIVE',
        regime: MarketRegime.STRONG_BULL,
        trading_date: '2024-01-15',
        trades_count: 10,
        win_count: 7,
        loss_count: 3,
        total_net_pnl: '500.00',
        selection_rationale: null,
        oos_win_rate: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
      } as StrategyPerformance;
    }

    it('should suspend strategy and emit STRATEGY_DEGRADATION_EVENT when OOS win rate < threshold', async () => {
      // 4 wins / 10 trades = 40%; threshold = 50% → should suspend
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        minPerformanceThreshold: '50.00',
        isSuspended: false,
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([
        makePerfRow({ win_count: 4, trades_count: 10 }),
      ]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      // Strategy should be suspended and saved
      expect(strategiesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isSuspended: true }),
      );

      // Degradation event should be emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        STRATEGY_DEGRADATION_EVENT,
        expect.objectContaining({
          strategyCode: 'A',
          currentOosWinRate: 40,
          minPerformanceThreshold: 50,
        }),
      );
    });

    it('should NOT suspend strategy when OOS win rate >= threshold', async () => {
      // 6 wins / 10 trades = 60%; threshold = 50% → should NOT suspend
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        minPerformanceThreshold: '50.00',
        isSuspended: false,
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([
        makePerfRow({ win_count: 6, trades_count: 10 }),
      ]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      expect(strategiesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isSuspended: false }),
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should NOT suspend strategy when minPerformanceThreshold is null', async () => {
      // 1 win / 10 trades = 10%; threshold = null → no suspension possible
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        minPerformanceThreshold: null,
        isSuspended: false,
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([
        makePerfRow({ win_count: 1, trades_count: 10 }),
      ]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(strategiesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isSuspended: false }),
      );
    });

    it('should NOT suspend and NOT save strategy when no performance data exists', async () => {
      // No data → oosWinRate = null → no suspension, no save
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        minPerformanceThreshold: '50.00',
        isSuspended: false,
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      expect(strategiesRepo.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should record "suspended: win rate below threshold" rationale on suspension', async () => {
      const strategy = makeStrategy({
        id: 'uuid-A',
        minPerformanceThreshold: '50.00',
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([
        makePerfRow({ win_count: 3, trades_count: 10 }), // 30% < 50%
      ]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      expect(strategyPerformanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ selection_rationale: 'suspended: win rate below threshold' }),
      );
    });

    it('should record "performance within threshold" rationale when not suspending', async () => {
      const strategy = makeStrategy({
        id: 'uuid-A',
        minPerformanceThreshold: '50.00',
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([
        makePerfRow({ win_count: 7, trades_count: 10 }), // 70% >= 50%
      ]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      expect(strategyPerformanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ selection_rationale: 'performance within threshold' }),
      );
    });

    it('should record oos_win_rate in the StrategyPerformance entry', async () => {
      // 7/10 = 70%
      const strategy = makeStrategy({ id: 'uuid-A', minPerformanceThreshold: null });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([
        makePerfRow({ win_count: 7, trades_count: 10 }),
      ]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      expect(strategyPerformanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ oos_win_rate: '70.00' }),
      );
    });

    it('should emit STRATEGY_DEGRADATION_EVENT with correct payload fields', async () => {
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        name: 'Opening Range Breakout',
        minPerformanceThreshold: '60.00',
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([
        makePerfRow({ win_count: 5, trades_count: 10 }), // 50% < 60%
      ]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        STRATEGY_DEGRADATION_EVENT,
        expect.objectContaining({
          strategyCode: 'A',
          strategyName: 'Opening Range Breakout',
          currentOosWinRate: 50,
          minPerformanceThreshold: 60,
        }),
      );

      const [, payload] = eventEmitter.emit.mock.calls[0];
      expect(payload.suspendedAt).toBeInstanceOf(Date);
    });

    it('should query last 20 rows ordered by trading_date DESC', async () => {
      const strategy = makeStrategy({ id: 'uuid-A', minPerformanceThreshold: null });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategyPerformanceRepo.find.mockResolvedValue([]);

      await service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL);

      expect(strategyPerformanceRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { strategy_id: 'uuid-A', regime: MarketRegime.STRONG_BULL },
          order: { trading_date: 'DESC' },
          take: 20,
        }),
      );
    });

    it('should return early without error when strategy is not found', async () => {
      strategiesRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateStrategyPerformanceMetrics('non-existent-id', MarketRegime.STRONG_BULL),
      ).resolves.toBeUndefined();

      expect(strategyPerformanceRepo.find).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should handle totalTrades = 0 gracefully (no division by zero)', async () => {
      const strategy = makeStrategy({ id: 'uuid-A', minPerformanceThreshold: null });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      // Row exists but has zero trades
      strategyPerformanceRepo.find.mockResolvedValue([
        makePerfRow({ win_count: 0, trades_count: 0 }),
      ]);

      await expect(
        service.updateStrategyPerformanceMetrics('uuid-A', MarketRegime.STRONG_BULL),
      ).resolves.toBeUndefined();

      // oosWinRate = null when trades_count = 0, so no save
      expect(strategiesRepo.save).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // rankStrategiesByPerformance
  // ───────────────────────────────────────────────────────────────────────────

  describe('rankStrategiesByPerformance()', () => {
    it('should return strategies sorted by currentOosWinRate DESC', async () => {
      // Three STRONG_BULL-compatible strategies with different win rates
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: true,
        currentOosWinRate: '65.00',
      });
      const stratC = makeStrategy({
        id: 'uuid-C',
        code: 'C',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: '45.00',
      });
      const stratD = makeStrategy({
        id: 'uuid-D',
        code: 'D',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: '80.00',
      });
      strategiesRepo.find.mockResolvedValue([stratA, stratC, stratD]);

      const result = await service.rankStrategiesByPerformance(MarketRegime.STRONG_BULL);

      expect(result.map((s) => s.code)).toEqual(['D', 'A', 'C']);
    });

    it('should place strategies with null currentOosWinRate at the end', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: '55.00',
      });
      const stratC = makeStrategy({
        id: 'uuid-C',
        code: 'C',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: null,
      });
      const stratD = makeStrategy({
        id: 'uuid-D',
        code: 'D',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: '70.00',
      });
      strategiesRepo.find.mockResolvedValue([stratA, stratC, stratD]);

      const result = await service.rankStrategiesByPerformance(MarketRegime.STRONG_BULL);

      // Null win rate (C) goes to end
      expect(result.map((s) => s.code)).toEqual(['D', 'A', 'C']);
      expect(result[result.length - 1].currentOosWinRate).toBeNull();
    });

    it('should record a StrategyPerformance entry for each strategy with correct rank rationale', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: '70.00',
      });
      const stratC = makeStrategy({
        id: 'uuid-C',
        code: 'C',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: '50.00',
      });
      strategiesRepo.find.mockResolvedValue([stratA, stratC]);

      await service.rankStrategiesByPerformance(MarketRegime.STRONG_BULL);

      // Two StrategyPerformance records should be created
      expect(strategyPerformanceRepo.create).toHaveBeenCalledTimes(2);

      const createCalls = strategyPerformanceRepo.create.mock.calls;
      const rationales = createCalls.map(([d]) => d.selection_rationale as string);

      expect(rationales).toContain(
        `rank 1: OOS win rate 70.00% for regime ${MarketRegime.STRONG_BULL}`,
      );
      expect(rationales).toContain(
        `rank 2: OOS win rate 50.00% for regime ${MarketRegime.STRONG_BULL}`,
      );
    });

    it('should include "no data" in rationale for strategies with null win rate', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: null,
      });
      strategiesRepo.find.mockResolvedValue([stratA]);

      await service.rankStrategiesByPerformance(MarketRegime.STRONG_BULL);

      expect(strategyPerformanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          selection_rationale: `rank 1: OOS win rate no data for regime ${MarketRegime.STRONG_BULL}`,
        }),
      );
    });

    it('should return an empty array when no compatible strategies exist', async () => {
      strategiesRepo.find.mockResolvedValue([]);

      const result = await service.rankStrategiesByPerformance(MarketRegime.SIDEWAYS);

      expect(result).toEqual([]);
      expect(strategyPerformanceRepo.create).not.toHaveBeenCalled();
    });

    it('should not mutate the original strategy objects while sorting', async () => {
      const stratA = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: '40.00',
      });
      const stratD = makeStrategy({
        id: 'uuid-D',
        code: 'D',
        compatibleRegimes: [MarketRegime.STRONG_BULL],
        openingPhaseCompatible: false,
        currentOosWinRate: '80.00',
      });
      strategiesRepo.find.mockResolvedValue([stratA, stratD]);

      const result = await service.rankStrategiesByPerformance(MarketRegime.STRONG_BULL);

      // Original array order should be unchanged
      expect(stratA.currentOosWinRate).toBe('40.00');
      expect(stratD.currentOosWinRate).toBe('80.00');
      // Returned list is sorted
      expect(result[0].code).toBe('D');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // reenableStrategy
  // ───────────────────────────────────────────────────────────────────────────

  describe('reenableStrategy()', () => {
    it('should set isSuspended = false and save the strategy', async () => {
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        isSuspended: true,
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);

      await service.reenableStrategy('A');

      expect(strategiesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isSuspended: false }),
      );
    });

    it('should return the updated strategy with isSuspended = false', async () => {
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        isSuspended: true,
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);
      strategiesRepo.save.mockImplementation(async (entity) => entity);

      const result = await service.reenableStrategy('A');

      expect(result.isSuspended).toBe(false);
      expect(result.code).toBe('A');
    });

    it('should record a StrategyPerformance entry with "re-enabled by user action" rationale', async () => {
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        isSuspended: true,
        currentOosWinRate: '45.00',
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);

      await service.reenableStrategy('A');

      expect(strategyPerformanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          strategy_id: 'uuid-A',
          selection_rationale: 're-enabled by user action',
        }),
      );
    });

    it('should include the current oos_win_rate in the StrategyPerformance record', async () => {
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        isSuspended: true,
        currentOosWinRate: '48.50',
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);

      await service.reenableStrategy('A');

      expect(strategyPerformanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ oos_win_rate: '48.50' }),
      );
    });

    it('should include null oos_win_rate when strategy has no win rate data', async () => {
      const strategy = makeStrategy({
        id: 'uuid-A',
        code: 'A',
        isSuspended: true,
        currentOosWinRate: null,
      });
      strategiesRepo.findOne.mockResolvedValue(strategy);

      await service.reenableStrategy('A');

      expect(strategyPerformanceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ oos_win_rate: null }),
      );
    });

    it('should throw an error when strategy code does not exist', async () => {
      strategiesRepo.findOne.mockResolvedValue(null);

      await expect(service.reenableStrategy('Z')).rejects.toThrow(
        "Strategy with code 'Z' not found",
      );
    });

    it('should not emit any event when re-enabling a strategy', async () => {
      const strategy = makeStrategy({ id: 'uuid-A', code: 'A', isSuspended: true });
      strategiesRepo.findOne.mockResolvedValue(strategy);

      await service.reenableStrategy('A');

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should look up the strategy by code (not by id)', async () => {
      const strategy = makeStrategy({ id: 'uuid-C', code: 'C', isSuspended: true });
      strategiesRepo.findOne.mockResolvedValue(strategy);

      await service.reenableStrategy('C');

      expect(strategiesRepo.findOne).toHaveBeenCalledWith({ where: { code: 'C' } });
    });
  });
});
