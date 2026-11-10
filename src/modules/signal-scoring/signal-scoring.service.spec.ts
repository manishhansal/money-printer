/**
 * SignalScoringService unit and property-based tests.
 *
 * Unit tests cover deterministic edge cases; property-based tests (Properties 9–11)
 * verify universal invariants across a large generated input space.
 *
 * Property 9  — composite score = arithmetic sum of 8 output components, in [0, 100]
 * Property 10 — rrQuality is always 0 when currentRrRatio < minRrRatio
 * Property 11 — composite < 80 always produces rejected status
 *
 * Additional unit tests for persistence (Req 8.2, 8.4), expiry (Req 8.7),
 * and price-deviation revalidation (Req 8.6).
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

import * as fc from 'fast-check';
import { Repository } from 'typeorm';
import { SignalScoringService } from './signal-scoring.service';
import {
  SignalComponentScores,
  SignalInput,
  SCORE_ACCEPTANCE_THRESHOLD,
} from './signal-scoring.types';
import { Signals } from '../../database/entities/signals.entity';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Returns a fully-scored SignalInput with optional field overrides. */
function buildInput(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    strategyId: 'strat-001',
    instrumentId: 'instr-001',
    engine: 'LIVE',
    direction: 'BUY',
    entryPrice: '100.00',
    stopLossPrice: '95.00',
    targetPrice: '110.00',
    positionSize: 1,
    componentScores: maxComponentScores(),
    measuredInputs: {},
    minRrRatio: 1.5,
    currentRrRatio: 2.0,
    maxValidityDurationSeconds: 300,
    ...overrides,
  };
}

/** Returns component scores at their maximum allowed values (sum = 100). */
function maxComponentScores(overrides: Partial<SignalComponentScores> = {}): SignalComponentScores {
  return {
    regimeAlignment: 15,
    priceStructure: 15,
    volumeConfirmation: 15,
    momentum: 10,
    vwapTrendAlignment: 10,
    optionsFuturesConfirmation: 15,
    liquidityExecution: 10,
    rrQuality: 10,
    ...overrides,
  };
}

/** Returns component scores all set to zero (sum = 0). */
function zeroComponentScores(): SignalComponentScores {
  return {
    regimeAlignment: 0,
    priceStructure: 0,
    volumeConfirmation: 0,
    momentum: 0,
    vwapTrendAlignment: 0,
    optionsFuturesConfirmation: 0,
    liquidityExecution: 0,
    rrQuality: 0,
  };
}

/** Sums all 8 component score fields. */
function sumComponents(cs: SignalComponentScores): number {
  return (
    cs.regimeAlignment +
    cs.priceStructure +
    cs.volumeConfirmation +
    cs.momentum +
    cs.vwapTrendAlignment +
    cs.optionsFuturesConfirmation +
    cs.liquidityExecution +
    cs.rrQuality
  );
}

// ─── Mock repository factory ──────────────────────────────────────────────────

/**
 * Build a minimal jest-mocked `Repository<Signals>`.
 * Only the methods used by the service are stubbed; everything else is `jest.fn()`.
 */
function buildMockSignalsRepo(): jest.Mocked<
  Pick<Repository<Signals>, 'create' | 'save' | 'findOne' | 'update' | 'find'>
> {
  return {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    find: jest.fn(),
  };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/**
 * Generates valid SignalComponentScores where every field is within its
 * maximum bound.  Max sum = 15+15+15+10+10+15+10+10 = 100.
 */
const componentScoresArb: fc.Arbitrary<SignalComponentScores> = fc.record({
  regimeAlignment: fc.integer({ min: 0, max: 15 }),
  priceStructure: fc.integer({ min: 0, max: 15 }),
  volumeConfirmation: fc.integer({ min: 0, max: 15 }),
  momentum: fc.integer({ min: 0, max: 10 }),
  vwapTrendAlignment: fc.integer({ min: 0, max: 10 }),
  optionsFuturesConfirmation: fc.integer({ min: 0, max: 15 }),
  liquidityExecution: fc.integer({ min: 0, max: 10 }),
  rrQuality: fc.integer({ min: 0, max: 10 }),
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SignalScoringService', () => {
  let service: SignalScoringService;
  let mockSignalsRepo: ReturnType<typeof buildMockSignalsRepo>;

  beforeEach(() => {
    mockSignalsRepo = buildMockSignalsRepo();
    // The repo is injected via DI; in unit tests we pass the mock directly.
    service = new SignalScoringService(mockSignalsRepo as unknown as Repository<Signals>);
  });

  // ─── computeRrRatio ─────────────────────────────────────────────────────────

  describe('computeRrRatio()', () => {
    it('computes 2.0 for a BUY signal (entry=100, stop=95, target=110)', () => {
      // (110 − 100) / (100 − 95) = 10 / 5 = 2.0
      expect(service.computeRrRatio('100', '95', '110')).toBeCloseTo(2.0);
    });

    it('computes 2.0 for a SELL signal (entry=100, stop=105, target=90)', () => {
      // (100 − 90) / (105 − 100) = 10 / 5 = 2.0
      expect(service.computeRrRatio('100', '105', '90')).toBeCloseTo(2.0);
    });

    it('returns 0 when entry equals stop (zero risk — prevents division by zero)', () => {
      expect(service.computeRrRatio('100', '100', '110')).toBe(0);
    });

    it('handles decimal string prices correctly', () => {
      // entry=100.50, stop=98.00, target=105.50 → 5.00 / 2.50 = 2.0
      expect(service.computeRrRatio('100.50', '98.00', '105.50')).toBeCloseTo(2.0);
    });

    it('computes 1.5 R:R (entry=100, stop=98, target=103)', () => {
      // 3 / 2 = 1.5
      expect(service.computeRrRatio('100', '98', '103')).toBeCloseTo(1.5);
    });
  });

  // ─── scoreSignal unit tests ──────────────────────────────────────────────────

  describe('scoreSignal()', () => {
    it('returns composite=100 and status=active for all-maximum component scores', () => {
      const result = service.scoreSignal(buildInput());

      expect(result.compositeScore).toBe(100);
      expect(result.status).toBe('active');
      expect(result.approved).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
    });

    it('returns composite=0 and status=rejected for all-zero component scores', () => {
      const result = service.scoreSignal(buildInput({ componentScores: zeroComponentScores() }));

      expect(result.compositeScore).toBe(0);
      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('score below threshold');
      expect(result.approved).toBe(false);
    });

    it('accepts a signal with composite score exactly equal to 80 (boundary)', () => {
      // 15+15+15+10+10+15+0+0 = 80 (threshold is inclusive)
      const result = service.scoreSignal(
        buildInput({
          componentScores: {
            regimeAlignment: 15,
            priceStructure: 15,
            volumeConfirmation: 15,
            momentum: 10,
            vwapTrendAlignment: 10,
            optionsFuturesConfirmation: 15,
            liquidityExecution: 0,
            rrQuality: 0,
          },
          minRrRatio: 0,
          currentRrRatio: 1,
        }),
      );

      expect(result.compositeScore).toBe(SCORE_ACCEPTANCE_THRESHOLD);
      expect(result.status).toBe('active');
      expect(result.approved).toBe(true);
    });

    it('rejects a signal with composite score exactly 79 (one below threshold)', () => {
      // 15+15+15+10+10+14+0+0 = 79
      const result = service.scoreSignal(
        buildInput({
          componentScores: {
            regimeAlignment: 15,
            priceStructure: 15,
            volumeConfirmation: 15,
            momentum: 10,
            vwapTrendAlignment: 10,
            optionsFuturesConfirmation: 14,
            liquidityExecution: 0,
            rrQuality: 0,
          },
          minRrRatio: 0,
          currentRrRatio: 1,
        }),
      );

      expect(result.compositeScore).toBe(79);
      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('score below threshold');
      expect(result.approved).toBe(false);
    });

    it('overrides rrQuality to 0 when currentRrRatio < minRrRatio (Req 8.5)', () => {
      const result = service.scoreSignal(
        buildInput({
          componentScores: maxComponentScores({ rrQuality: 10 }),
          minRrRatio: 2.0,
          currentRrRatio: 1.5, // strictly less than 2.0
        }),
      );

      expect(result.componentScores.rrQuality).toBe(0);
      // compositeScore reduced from 100 to 90 due to override
      expect(result.compositeScore).toBe(90);
    });

    it('does NOT override rrQuality when currentRrRatio equals minRrRatio', () => {
      const result = service.scoreSignal(
        buildInput({
          componentScores: maxComponentScores({ rrQuality: 10 }),
          minRrRatio: 2.0,
          currentRrRatio: 2.0, // equal, not less than
        }),
      );

      expect(result.componentScores.rrQuality).toBe(10);
      expect(result.compositeScore).toBe(100);
    });

    it('does NOT override rrQuality when currentRrRatio > minRrRatio', () => {
      const result = service.scoreSignal(
        buildInput({
          componentScores: maxComponentScores({ rrQuality: 8 }),
          minRrRatio: 1.5,
          currentRrRatio: 3.0,
        }),
      );

      expect(result.componentScores.rrQuality).toBe(8);
    });

    it('does not mutate the input componentScores object', () => {
      const originalScores = maxComponentScores({ rrQuality: 10 });
      const inputRef = { ...originalScores };

      service.scoreSignal(
        buildInput({
          componentScores: originalScores,
          minRrRatio: 2.0,
          currentRrRatio: 1.0, // triggers override
        }),
      );

      // The original object passed in must remain unmodified
      expect(originalScores.rrQuality).toBe(inputRef.rrQuality);
    });
  });

  // ─── scoreAndPersistSignal ───────────────────────────────────────────────────
  // Req 8.2, 8.4

  describe('scoreAndPersistSignal()', () => {
    it('persists an accepted signal to the Signals table and returns its DB id (Req 8.2, 8.4)', async () => {
      const fakeEntity = {} as Signals;
      const savedEntity = { id: 'uuid-saved-123' } as Signals;

      mockSignalsRepo.create.mockReturnValue(fakeEntity);
      mockSignalsRepo.save.mockResolvedValue(savedEntity);

      const result = await service.scoreAndPersistSignal(buildInput());

      expect(mockSignalsRepo.create).toHaveBeenCalledTimes(1);
      expect(mockSignalsRepo.save).toHaveBeenCalledWith(fakeEntity);
      expect(result.signalId).toBe('uuid-saved-123');
      expect(result.status).toBe('active');
      expect(result.approved).toBe(true);
      expect(result.compositeScore).toBe(100);
    });

    it('persists a rejected signal with status "rejected" and correct rejectionReason (Req 8.4)', async () => {
      const fakeEntity = {} as Signals;
      const savedEntity = { id: 'uuid-rejected-456' } as Signals;

      mockSignalsRepo.create.mockReturnValue(fakeEntity);
      mockSignalsRepo.save.mockResolvedValue(savedEntity);

      const result = await service.scoreAndPersistSignal(
        buildInput({ componentScores: zeroComponentScores() }),
      );

      // Verify create was called with rejected status and reason
      const createArg = mockSignalsRepo.create.mock.calls[0][0] as Partial<Signals>;
      expect(createArg.status).toBe('rejected');
      expect(createArg.rejectionReason).toBe('score below threshold');

      expect(result.signalId).toBe('uuid-rejected-456');
      expect(result.status).toBe('rejected');
      expect(result.approved).toBe(false);
    });

    it('persists all 8 component scores to the entity (Req 8.2)', async () => {
      const fakeEntity = {} as Signals;
      mockSignalsRepo.create.mockReturnValue(fakeEntity);
      mockSignalsRepo.save.mockResolvedValue({ id: 'uuid-789' } as Signals);

      const scores = maxComponentScores({ rrQuality: 8, momentum: 7 });
      await service.scoreAndPersistSignal(buildInput({ componentScores: scores }));

      const createArg = mockSignalsRepo.create.mock.calls[0][0] as Partial<Signals>;
      expect(createArg.scoreRegimeAlignment).toBe('15');
      expect(createArg.scorePriceStructure).toBe('15');
      expect(createArg.scoreVolumeConfirmation).toBe('15');
      expect(createArg.scoreMomentum).toBe('7');
      expect(createArg.scoreVwapTrend).toBe('10');
      expect(createArg.scoreOptionsFutures).toBe('15');
      expect(createArg.scoreLiquidityExecution).toBe('10');
      expect(createArg.scoreRrQuality).toBe('8');
    });

    it('sets expiryTimestamp = signalTimestamp + maxValidityDurationSeconds (Req 8.7)', async () => {
      const fakeEntity = {} as Signals;
      mockSignalsRepo.create.mockReturnValue(fakeEntity);
      mockSignalsRepo.save.mockResolvedValue({ id: 'uuid-expiry' } as Signals);

      await service.scoreAndPersistSignal(buildInput({ maxValidityDurationSeconds: 600 }));

      const createArg = mockSignalsRepo.create.mock.calls[0][0] as Partial<Signals>;
      const signalTs = createArg.signalTimestamp as Date;
      const expiryTs = createArg.expiryTimestamp as Date;

      expect(signalTs).toBeInstanceOf(Date);
      expect(expiryTs).toBeInstanceOf(Date);

      const diffMs = expiryTs.getTime() - signalTs.getTime();
      expect(diffMs).toBe(600_000); // exactly 600 s
    });

    it('defaults maxValidityDurationSeconds to 300 s when not provided', async () => {
      const fakeEntity = {} as Signals;
      mockSignalsRepo.create.mockReturnValue(fakeEntity);
      mockSignalsRepo.save.mockResolvedValue({ id: 'uuid-default' } as Signals);

      const inputWithoutDuration = buildInput();
      delete (inputWithoutDuration as Partial<SignalInput>).maxValidityDurationSeconds;

      await service.scoreAndPersistSignal(inputWithoutDuration);

      const createArg = mockSignalsRepo.create.mock.calls[0][0] as Partial<Signals>;
      const signalTs = createArg.signalTimestamp as Date;
      const expiryTs = createArg.expiryTimestamp as Date;
      const diffMs = expiryTs.getTime() - signalTs.getTime();
      expect(diffMs).toBe(300_000); // default 300 s
    });

    it('persists measuredInputs JSONB field (Req 8.2)', async () => {
      const fakeEntity = {} as Signals;
      mockSignalsRepo.create.mockReturnValue(fakeEntity);
      mockSignalsRepo.save.mockResolvedValue({ id: 'uuid-jsonb' } as Signals);

      const measuredInputs = { rsi: 65, macd: 0.5, vwapDev: -0.3 };
      await service.scoreAndPersistSignal(buildInput({ measuredInputs }));

      const createArg = mockSignalsRepo.create.mock.calls[0][0] as Partial<Signals>;
      expect(createArg.measuredInputs).toEqual(measuredInputs);
    });
  });

  // ─── expireStaleSignals ──────────────────────────────────────────────────────
  // Req 8.7

  describe('expireStaleSignals()', () => {
    it('marks active signals with passed expiryTimestamp as "expired" (Req 8.7)', async () => {
      const pastDate = new Date(Date.now() - 60_000); // 1 minute ago

      const staleActive: Partial<Signals> = {
        id: 'stale-active-001',
        status: 'active',
        expiryTimestamp: pastDate,
      };
      const staleAccepted: Partial<Signals> = {
        id: 'stale-accepted-002',
        status: 'accepted',
        expiryTimestamp: pastDate,
      };

      mockSignalsRepo.find.mockResolvedValue([staleActive, staleAccepted] as Signals[]);
      mockSignalsRepo.update.mockResolvedValue({ affected: 1 } as any);

      const count = await service.expireStaleSignals();

      expect(count).toBe(2);
      expect(mockSignalsRepo.update).toHaveBeenCalledWith('stale-active-001', {
        status: 'expired',
        rejectionReason: 'signal expired without action',
      });
      expect(mockSignalsRepo.update).toHaveBeenCalledWith('stale-accepted-002', {
        status: 'expired',
        rejectionReason: 'signal expired without action',
      });
    });

    it('returns 0 and skips the update call when no stale signals exist', async () => {
      mockSignalsRepo.find.mockResolvedValue([]);

      const count = await service.expireStaleSignals();

      expect(count).toBe(0);
      expect(mockSignalsRepo.update).not.toHaveBeenCalled();
    });

    it('queries for both "active" and "accepted" status signals with past expiryTimestamp', async () => {
      mockSignalsRepo.find.mockResolvedValue([]);

      await service.expireStaleSignals();

      const findArg = mockSignalsRepo.find.mock.calls[0][0] as { where: unknown[] };
      // Should have two where conditions (active + accepted)
      expect(Array.isArray(findArg.where)).toBe(true);
      expect((findArg.where as unknown[]).length).toBe(2);
    });
  });

  // ─── revalidateIfPriceDeviated ───────────────────────────────────────────────
  // Req 8.6

  describe('revalidateIfPriceDeviated()', () => {
    /** Build a mock signal DB record with optional field overrides. */
    function buildMockSignal(overrides: Partial<Signals> = {}): Signals {
      return {
        id: 'signal-revalidate-001',
        status: 'active',
        entryPrice: '100.00',
        stopLossPrice: '95.00',
        targetPrice: '110.00',
        positionSize: 1,
        instrumentId: 'instr-001',
        strategyId: 'strat-001',
        engine: 'LIVE',
        direction: 'BUY',
        scoreRegimeAlignment: '15',
        scorePriceStructure: '15',
        scoreVolumeConfirmation: '15',
        scoreMomentum: '10',
        scoreVwapTrend: '10',
        scoreOptionsFutures: '15',
        scoreLiquidityExecution: '10',
        scoreRrQuality: '10',
        compositeScore: '100',
        measuredInputs: {},
        expiryTimestamp: new Date(Date.now() + 300_000), // 5 min in the future
        regime: null,
        dhanOrderId: null,
        rejectionReason: null,
        signalTimestamp: new Date(),
        createdAt: new Date(),
        strategy: {
          id: 'strat-001',
          minRrRatio: '1.5',
          priceDeviationThreshold: '0.005',
          maxValidityDurationSeconds: 300,
        } as any,
        ...overrides,
      } as Signals;
    }

    it('returns null when price deviation is within the configured threshold', async () => {
      // entry=100, currentMarket=100.4 → deviation = 0.004 ≤ threshold 0.005
      mockSignalsRepo.findOne.mockResolvedValue(buildMockSignal());

      const result = await service.revalidateIfPriceDeviated('signal-revalidate-001', 100.4);

      expect(result).toBeNull();
      expect(mockSignalsRepo.update).not.toHaveBeenCalled();
    });

    it('returns null for non-active signals (rejected/expired/executed)', async () => {
      mockSignalsRepo.findOne.mockResolvedValue(buildMockSignal({ status: 'rejected' }));

      const result = await service.revalidateIfPriceDeviated('some-id', 110);

      expect(result).toBeNull();
      expect(mockSignalsRepo.update).not.toHaveBeenCalled();
    });

    it('returns null when signal is not found in the DB', async () => {
      mockSignalsRepo.findOne.mockResolvedValue(null);

      const result = await service.revalidateIfPriceDeviated('nonexistent-id', 110);

      expect(result).toBeNull();
    });

    it('recomputes and updates signal when price deviation exceeds threshold (Req 8.6)', async () => {
      // entry=100, currentMarket=101 → deviation = 0.01 > threshold 0.005
      mockSignalsRepo.findOne.mockResolvedValue(buildMockSignal());
      mockSignalsRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await service.revalidateIfPriceDeviated('signal-revalidate-001', 101);

      expect(result).not.toBeNull();
      expect(result!.signalId).toBe('signal-revalidate-001');
      expect(mockSignalsRepo.update).toHaveBeenCalledWith(
        'signal-revalidate-001',
        expect.objectContaining({
          entryPrice: '101',
          compositeScore: expect.any(String),
          scoreRrQuality: expect.any(String),
          status: expect.stringMatching(/^(active|rejected)$/),
        }),
      );
    });

    it('sets rrQuality to 0 and may reject when new R:R falls below minRrRatio after deviation (Req 8.6, 8.5)', async () => {
      // entry=100, stop=99, target=101 → original R:R = 1.0
      // strategy minRrRatio = 1.5
      // If currentMarket moves to 100.6 (deviation 0.6% > 0.5% threshold):
      //   new R:R = |101 - 100.6| / |100.6 - 99| = 0.4 / 1.6 = 0.25 → below minRrRatio → rrQuality = 0
      const signalWithLowRr = buildMockSignal({
        entryPrice: '100.00',
        stopLossPrice: '99.00',
        targetPrice: '101.00',
        scoreRrQuality: '10', // was 10, should be zeroed
        compositeScore: '100',
        strategy: {
          id: 'strat-001',
          minRrRatio: '1.5',
          priceDeviationThreshold: '0.005',
          maxValidityDurationSeconds: 300,
        } as any,
      });

      mockSignalsRepo.findOne.mockResolvedValue(signalWithLowRr);
      mockSignalsRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await service.revalidateIfPriceDeviated('signal-revalidate-001', 100.6);

      expect(result).not.toBeNull();
      // R:R Quality must be zeroed when new R:R < minRrRatio
      expect(result!.componentScores.rrQuality).toBe(0);
    });

    it('expires the signal in-band if expiryTimestamp is in the past during revalidation (Req 8.7)', async () => {
      const expiredSignal = buildMockSignal({
        status: 'active',
        expiryTimestamp: new Date(Date.now() - 1_000), // already past
      });

      mockSignalsRepo.findOne.mockResolvedValue(expiredSignal);
      mockSignalsRepo.update.mockResolvedValue({ affected: 1 } as any);

      const result = await service.revalidateIfPriceDeviated('signal-revalidate-001', 999);

      expect(result).toBeNull();
      expect(mockSignalsRepo.update).toHaveBeenCalledWith(
        'signal-revalidate-001',
        expect.objectContaining({
          status: 'expired',
          rejectionReason: 'signal expired without action',
        }),
      );
    });

    it('uses the default deviation threshold (0.5%) when strategy.priceDeviationThreshold is null', async () => {
      // With no configured threshold, the default is 0.005.
      // entry=100, currentMarket=100.4 → deviation=0.004 < 0.005 → no recompute.
      const signalNoThreshold = buildMockSignal({
        strategy: {
          id: 'strat-001',
          minRrRatio: '1.5',
          priceDeviationThreshold: null,
          maxValidityDurationSeconds: 300,
        } as any,
      });

      mockSignalsRepo.findOne.mockResolvedValue(signalNoThreshold);

      const result = await service.revalidateIfPriceDeviated('signal-revalidate-001', 100.4);

      expect(result).toBeNull();
      expect(mockSignalsRepo.update).not.toHaveBeenCalled();
    });
  });

  // ─── Property 9 ──────────────────────────────────────────────────────────────
  // composite score is always arithmetic sum of all 8 output components, in [0, 100]
  // **Validates: Requirements 8.1**

  it('Property 9: composite score equals arithmetic sum of all 8 output components and is in [0, 100]', () => {
    fc.assert(
      fc.property(
        componentScoresArb,
        fc.float({ min: 0, max: 10, noNaN: true }),
        fc.float({ min: 0, max: 10, noNaN: true }),
        (componentScores, minRrRatio, currentRrRatio) => {
          const input = buildInput({ componentScores, minRrRatio, currentRrRatio });
          const result = service.scoreSignal(input);

          // Composite must equal the sum of the RESULT component scores
          // (which may differ from inputs when the R:R override applies).
          const outputSum = sumComponents(result.componentScores);

          expect(result.compositeScore).toBe(outputSum);
          expect(result.compositeScore).toBeGreaterThanOrEqual(0);
          expect(result.compositeScore).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 500 },
    );
  });

  // ─── Property 10 ─────────────────────────────────────────────────────────────
  // R:R Quality = 0 when currentRrRatio < minRrRatio
  // **Validates: Requirements 8.5**

  it('Property 10: rrQuality component in result is always 0 when currentRrRatio < minRrRatio', () => {
    fc.assert(
      fc.property(
        // Generate (minRrRatio, currentRrRatio) pairs where currentRrRatio < minRrRatio.
        // Using integer ranges ensures strict-less-than holds without float precision risk.
        fc
          .integer({ min: 1, max: 100 })
          .chain((minRr) => fc.tuple(fc.constant(minRr), fc.integer({ min: 0, max: minRr - 1 }))),
        // Non-zero rrQuality input to confirm the override actually zeroes it.
        fc.integer({ min: 1, max: 10 }),
        ([minRrRatio, currentRrRatio], rrQuality) => {
          const input = buildInput({
            componentScores: maxComponentScores({ rrQuality }),
            minRrRatio,
            currentRrRatio,
          });
          const result = service.scoreSignal(input);

          expect(result.componentScores.rrQuality).toBe(0);
        },
      ),
      { numRuns: 500 },
    );
  });

  // ─── Property 11 ─────────────────────────────────────────────────────────────
  // score < 80 always results in rejected status and reason "score below threshold"
  // **Validates: Requirements 8.3**

  it('Property 11: signals with composite score < 80 are always rejected with reason "score below threshold"', () => {
    fc.assert(
      fc.property(
        componentScoresArb,
        fc.float({ min: 0, max: 10, noNaN: true }),
        fc.float({ min: 0, max: 10, noNaN: true }),
        (componentScores, minRrRatio, currentRrRatio) => {
          const input = buildInput({ componentScores, minRrRatio, currentRrRatio });
          const result = service.scoreSignal(input);

          if (result.compositeScore < SCORE_ACCEPTANCE_THRESHOLD) {
            expect(result.status).toBe('rejected');
            expect(result.rejectionReason).toBe('score below threshold');
            expect(result.approved).toBe(false);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
