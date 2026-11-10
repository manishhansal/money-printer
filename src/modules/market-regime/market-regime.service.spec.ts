/**
 * Unit and property-based tests for MarketRegimeService.classifyRegime().
 *
 * Covers:
 *   - VIX override: HIGH_VOL is returned for any input when indiaVix exceeds the
 *     configured threshold, regardless of all other indicator values.
 *   - Total function: classifyRegime returns exactly one of the 10 valid regime
 *     codes for every structurally valid input combination.
 *   - Example-based tests for each individual regime branch.
 *
 * Property 4: VIX Override Forces High Volatility Regime
 *   For any valid RegimeInputs where indiaVix > HIGH_VOLATILITY_VIX_THRESHOLD,
 *   classifyRegime SHALL return HIGH_VOL — overriding all other indicator values.
 *   **Validates: Requirements 5.7**
 *
 * Property 5: Regime Classification Is a Total Function Over 10 Valid Codes
 *   For any structurally valid RegimeInputs, classifyRegime SHALL return exactly
 *   one value that is a member of the 10-element MarketRegime enum.
 *   **Validates: Requirements 5.1**
 */

import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { MarketRegimeService } from './market-regime.service';
import { MarketRegimes } from '../../database/entities/market-regimes.entity';
import { RedisService } from '../redis/redis.service';
import { MarketRegime, RegimeInputs, TrendDirection, VALID_REGIMES } from './market-regime.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

function createRepositoryMock() {
  return {
    create: jest.fn().mockImplementation((dto: unknown) => dto),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function createRedisServiceMock() {
  return {
    get: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
    set: jest.fn<Promise<void>, [string, string, number?]>().mockResolvedValue(undefined),
    publish: jest.fn<Promise<number>, [string, string]>().mockResolvedValue(0),
  };
}

function createEventEmitterMock() {
  return {
    emit: jest.fn(),
  };
}

function createConfigServiceMock(overrides: Record<string, number> = {}) {
  return {
    get: jest.fn((key: string, defaultValue: number) => {
      return overrides[key] ?? defaultValue;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fast-check arbitraries
// ─────────────────────────────────────────────────────────────────────────────

const trendArb: fc.Arbitrary<TrendDirection> = fc.constantFrom('BULLISH', 'BEARISH', 'SIDEWAYS');

/**
 * Generates RegimeInputs where indiaVix is strictly greater than the default
 * HIGH_VOLATILITY_VIX_THRESHOLD (20.0).  Other fields are arbitrary.
 *
 * We use 21 as the minimum to avoid 32-bit float boundary issues with values
 * like 20.01 which are not exactly representable as 32-bit floats.
 */
const highVixInputsArb: fc.Arbitrary<RegimeInputs> = fc.record({
  niftyTrend: trendArb,
  bankniftyTrend: trendArb,
  marketBreadth: fc.float({ min: 0, max: 100, noNaN: true }),
  advanceDeclineRatio: fc.float({ min: 0, max: 10, noNaN: true }),
  vwapDeviation: fc.float({ min: -10, max: 10, noNaN: true }),
  // VIX strictly above the default threshold (20.0); start at 21 (safe 32-bit float)
  indiaVix: fc.float({ min: 21, max: 100, noNaN: true }),
  atr: fc.float({ min: 0, max: 500, noNaN: true }),
  relativeVolume: fc.float({ min: 0, max: 5, noNaN: true }),
  sectorStrength: fc.option(fc.float({ min: 0, max: 100, noNaN: true }), { nil: null }),
  futuresBasis: fc.option(fc.float({ min: -100, max: 100, noNaN: true }), { nil: null }),
});

/**
 * Generates RegimeInputs with the full VIX range (0–100) for the total-function
 * property test.
 */
const anyValidInputsArb: fc.Arbitrary<RegimeInputs> = fc.record({
  niftyTrend: trendArb,
  bankniftyTrend: trendArb,
  marketBreadth: fc.float({ min: 0, max: 100, noNaN: true }),
  advanceDeclineRatio: fc.float({ min: 0, max: 10, noNaN: true }),
  vwapDeviation: fc.float({ min: -20, max: 20, noNaN: true }),
  indiaVix: fc.float({ min: 0, max: 100, noNaN: true }),
  atr: fc.float({ min: 0, max: 500, noNaN: true }),
  relativeVolume: fc.float({ min: 0, max: 10, noNaN: true }),
  sectorStrength: fc.option(fc.float({ min: 0, max: 100, noNaN: true }), { nil: null }),
  futuresBasis: fc.option(fc.float({ min: -100, max: 100, noNaN: true }), { nil: null }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a fully-specified RegimeInputs from partial overrides. */
function makeInputs(overrides: Partial<RegimeInputs> = {}): RegimeInputs {
  return {
    niftyTrend: 'SIDEWAYS',
    bankniftyTrend: 'SIDEWAYS',
    marketBreadth: 50,
    advanceDeclineRatio: 1.0,
    vwapDeviation: 0.0,
    indiaVix: 15.0,
    atr: 100,
    relativeVolume: 0.9,
    sectorStrength: null,
    futuresBasis: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('MarketRegimeService', () => {
  let service: MarketRegimeService;
  let repoMock: ReturnType<typeof createRepositoryMock>;
  let redisMock: ReturnType<typeof createRedisServiceMock>;
  let eventEmitterMock: ReturnType<typeof createEventEmitterMock>;

  beforeEach(async () => {
    repoMock = createRepositoryMock();
    redisMock = createRedisServiceMock();
    eventEmitterMock = createEventEmitterMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketRegimeService,
        {
          provide: getRepositoryToken(MarketRegimes),
          useValue: repoMock,
        },
        {
          provide: ConfigService,
          useValue: createConfigServiceMock(),
        },
        {
          provide: RedisService,
          useValue: redisMock,
        },
        {
          provide: EventEmitter2,
          useValue: eventEmitterMock,
        },
      ],
    }).compile();

    service = module.get<MarketRegimeService>(MarketRegimeService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Baseline configuration
  // ─────────────────────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('uses default HIGH_VOLATILITY_VIX_THRESHOLD of 20.0', () => {
      expect(service.highVolatilityVixThreshold).toBe(20.0);
    });

    it('uses default BREAKOUT_RELATIVE_VOLUME_THRESHOLD of 2.0', () => {
      expect(service.breakoutRelativeVolumeThreshold).toBe(2.0);
    });

    it('uses default BREAKOUT_ATR_MULTIPLIER of 1.5', () => {
      expect(service.breakoutAtrMultiplier).toBe(1.5);
    });

    it('uses default LOW_VOL_RELATIVE_VOLUME_THRESHOLD of 0.5', () => {
      expect(service.lowVolRelativeVolumeThreshold).toBe(0.5);
    });

    it('uses default REVERSAL_VWAP_DEVIATION_THRESHOLD of 0.5', () => {
      expect(service.reversalVwapDeviationThreshold).toBe(0.5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VIX Override — example-based tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('classifyRegime() — VIX override rule', () => {
    it('returns HIGH_VOL when indiaVix is just above threshold (20.5)', () => {
      const inputs = makeInputs({ indiaVix: 20.5 });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.HIGH_VOL);
    });

    it('returns HIGH_VOL when indiaVix is far above threshold', () => {
      const inputs = makeInputs({ indiaVix: 45.0 });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.HIGH_VOL);
    });

    it('overrides STRONG_BULL conditions: HIGH_VOL returned when VIX > threshold', () => {
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'BULLISH',
        marketBreadth: 75,
        relativeVolume: 2.0,
        indiaVix: 25.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.HIGH_VOL);
    });

    it('overrides STRONG_BEAR conditions: HIGH_VOL returned when VIX > threshold', () => {
      const inputs = makeInputs({
        niftyTrend: 'BEARISH',
        bankniftyTrend: 'BEARISH',
        marketBreadth: 25,
        relativeVolume: 2.5,
        indiaVix: 22.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.HIGH_VOL);
    });

    it('overrides BREAKOUT conditions: HIGH_VOL returned when VIX > threshold', () => {
      const inputs = makeInputs({
        relativeVolume: 3.5,
        vwapDeviation: 2.0,
        atr: 1.0, // |2.0| > 1.0 × 1.5 → would be BREAKOUT without VIX
        indiaVix: 21.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.HIGH_VOL);
    });

    it('does NOT return HIGH_VOL when indiaVix equals exactly the threshold', () => {
      // Boundary: threshold is exclusive (>), not inclusive (>=)
      const inputs = makeInputs({ indiaVix: 20.0 });
      const result = service.classifyRegime(inputs);
      expect(result).not.toBe(MarketRegime.HIGH_VOL);
    });

    it('does NOT return HIGH_VOL when indiaVix is below threshold', () => {
      const inputs = makeInputs({ indiaVix: 19.99 });
      const result = service.classifyRegime(inputs);
      expect(result).not.toBe(MarketRegime.HIGH_VOL);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Individual regime branches — example-based tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('classifyRegime() — BREAKOUT', () => {
    it('returns BREAKOUT when relVol > 2.0 and |vwapDev| > ATR × 1.5', () => {
      const inputs = makeInputs({
        relativeVolume: 2.5,
        vwapDeviation: 2.0,
        atr: 1.0, // |2.0| > 1.0 × 1.5
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.BREAKOUT);
    });

    it('negative vwapDeviation also triggers BREAKOUT', () => {
      const inputs = makeInputs({
        relativeVolume: 3.0,
        vwapDeviation: -2.0,
        atr: 1.0,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.BREAKOUT);
    });

    it('does NOT return BREAKOUT when ATR is 0 (degenerate)', () => {
      const inputs = makeInputs({
        relativeVolume: 3.0,
        vwapDeviation: 2.0,
        atr: 0,
        indiaVix: 15.0,
      });
      // ATR guard prevents false positive; result falls through to a lower branch
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.BREAKOUT);
    });
  });

  describe('classifyRegime() — LOW_VOL', () => {
    it('returns LOW_VOL when relativeVolume < 0.5', () => {
      const inputs = makeInputs({ relativeVolume: 0.3, indiaVix: 15.0 });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.LOW_VOL);
    });

    it('does NOT return LOW_VOL at exactly 0.5 (boundary is exclusive)', () => {
      const inputs = makeInputs({ relativeVolume: 0.5, indiaVix: 15.0 });
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.LOW_VOL);
    });
  });

  describe('classifyRegime() — STRONG_BULL', () => {
    it('returns STRONG_BULL with both bullish, breadth > 60, relVol > 1.5', () => {
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'BULLISH',
        marketBreadth: 70,
        relativeVolume: 1.8,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.STRONG_BULL);
    });

    it('does NOT return STRONG_BULL when bankniftyTrend is not BULLISH', () => {
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 70,
        relativeVolume: 1.8,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.STRONG_BULL);
    });
  });

  describe('classifyRegime() — STRONG_BEAR', () => {
    it('returns STRONG_BEAR with both bearish, breadth < 40, relVol > 1.5', () => {
      const inputs = makeInputs({
        niftyTrend: 'BEARISH',
        bankniftyTrend: 'BEARISH',
        marketBreadth: 30,
        relativeVolume: 2.0,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.STRONG_BEAR);
    });
  });

  describe('classifyRegime() — WEAK_BULL', () => {
    it('returns WEAK_BULL when NIFTY bullish, breadth > 50, relVol <= 1.5', () => {
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 55,
        relativeVolume: 1.2,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.WEAK_BULL);
    });
  });

  describe('classifyRegime() — WEAK_BEAR', () => {
    it('returns WEAK_BEAR when NIFTY bearish and breadth < 50', () => {
      const inputs = makeInputs({
        niftyTrend: 'BEARISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 45,
        relativeVolume: 1.0,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.WEAK_BEAR);
    });
  });

  describe('classifyRegime() — SIDEWAYS', () => {
    it('returns SIDEWAYS when both SIDEWAYS, breadth 45–55, relVol <= 1.0', () => {
      const inputs = makeInputs({
        niftyTrend: 'SIDEWAYS',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50,
        relativeVolume: 0.8,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.SIDEWAYS);
    });

    it('does NOT return SIDEWAYS when breadth is outside 45–55', () => {
      const inputs = makeInputs({
        niftyTrend: 'SIDEWAYS',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 60, // > 55
        relativeVolume: 0.8,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.SIDEWAYS);
    });
  });

  describe('classifyRegime() — REVERSAL', () => {
    it('returns REVERSAL when BULLISH trend but vwapDeviation < -0.5', () => {
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50,
        vwapDeviation: -0.6,
        relativeVolume: 0.8,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.REVERSAL);
    });

    it('returns REVERSAL when BEARISH trend but vwapDeviation > 0.5', () => {
      const inputs = makeInputs({
        niftyTrend: 'BEARISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50,
        vwapDeviation: 0.8,
        relativeVolume: 0.8,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.REVERSAL);
    });
  });

  describe('classifyRegime() — UNSTABLE', () => {
    it('returns UNSTABLE for conflicting signals that match no other branch', () => {
      // BULLISH trend but breadth 50 and relVol 1.3 — doesn't match WEAK_BULL (relVol > 1.5)
      // or STRONG_BULL; also vwapDeviation neutral, so no REVERSAL
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50, // equals threshold, not > 50
        relativeVolume: 1.3,
        vwapDeviation: 0.2,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).toBe(MarketRegime.UNSTABLE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getCurrentRegime()
  // ─────────────────────────────────────────────────────────────────────────

  describe('getCurrentRegime()', () => {
    it('returns UNSTABLE as the default regime before any classification', () => {
      expect(service.getCurrentRegime()).toBe(MarketRegime.UNSTABLE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 4: VIX Override Forces High Volatility Regime
  // **Validates: Requirements 5.7**
  //
  // For any valid RegimeInputs where indiaVix > HIGH_VOLATILITY_VIX_THRESHOLD,
  // classifyRegime MUST return HIGH_VOL.
  // ─────────────────────────────────────────────────────────────────────────

  describe('Property 4: VIX Override Forces HIGH_VOL Regime', () => {
    it('classifyRegime returns HIGH_VOL for any valid inputs when indiaVix > threshold', () => {
      fc.assert(
        fc.property(highVixInputsArb, (inputs) => {
          // Precondition: the generated VIX must be above the default threshold.
          // The arbitrary already constrains indiaVix > 20.01, but we double-check
          // to make the relationship explicit.
          expect(inputs.indiaVix).toBeGreaterThan(service.highVolatilityVixThreshold);

          const result = service.classifyRegime(inputs);

          // MUST return HIGH_VOL regardless of all other indicator values.
          expect(result).toBe(MarketRegime.HIGH_VOL);
        }),
        { numRuns: 200 },
      );
    });

    it('HIGH_VOL overrides the strongest bullish signal combination when VIX > threshold', () => {
      // Use a canonical strong-bull input set and sweep VIX from threshold+1 to 100.
      // Minimum is 21 (safe 32-bit float, strictly > default threshold 20.0).
      fc.assert(
        fc.property(fc.float({ min: 21, max: 100, noNaN: true }), (vix) => {
          const inputs = makeInputs({
            niftyTrend: 'BULLISH',
            bankniftyTrend: 'BULLISH',
            marketBreadth: 80,
            relativeVolume: 3.0,
            indiaVix: vix,
          });
          expect(service.classifyRegime(inputs)).toBe(MarketRegime.HIGH_VOL);
        }),
        { numRuns: 200 },
      );
    });

    it('HIGH_VOL overrides the strongest bearish signal combination when VIX > threshold', () => {
      fc.assert(
        fc.property(fc.float({ min: 21, max: 100, noNaN: true }), (vix) => {
          const inputs = makeInputs({
            niftyTrend: 'BEARISH',
            bankniftyTrend: 'BEARISH',
            marketBreadth: 20,
            relativeVolume: 3.0,
            indiaVix: vix,
          });
          expect(service.classifyRegime(inputs)).toBe(MarketRegime.HIGH_VOL);
        }),
        { numRuns: 200 },
      );
    });

    it('HIGH_VOL overrides BREAKOUT conditions when VIX > threshold', () => {
      fc.assert(
        fc.property(fc.float({ min: 21, max: 100, noNaN: true }), (vix) => {
          // Classic breakout setup: very high relVol + extreme price expansion
          const inputs = makeInputs({
            relativeVolume: 4.0,
            vwapDeviation: 5.0,
            atr: 1.0,
            indiaVix: vix,
          });
          expect(service.classifyRegime(inputs)).toBe(MarketRegime.HIGH_VOL);
        }),
        { numRuns: 200 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Property 5: Regime Classification Is a Total Function Over 10 Valid Codes
  // **Validates: Requirements 5.1**
  //
  // For any structurally valid RegimeInputs, classifyRegime SHALL return
  // exactly one value that is a member of the MarketRegime enum.
  // ─────────────────────────────────────────────────────────────────────────

  describe('Property 5: Regime Classification Is a Total Function Over 10 Valid Codes', () => {
    it('classifyRegime returns one of the 10 valid regime codes for any valid input', () => {
      fc.assert(
        fc.property(anyValidInputsArb, (inputs) => {
          const result = service.classifyRegime(inputs);

          // The result must be a member of the MarketRegime enum.
          expect(VALID_REGIMES).toContain(result);
        }),
        { numRuns: 500 },
      );
    });

    it('classifyRegime never returns undefined, null, or an unrecognised string', () => {
      fc.assert(
        fc.property(anyValidInputsArb, (inputs) => {
          const result = service.classifyRegime(inputs);

          // Strict type check: result must be a non-null string.
          expect(typeof result).toBe('string');
          expect(result).not.toBeNull();
          expect(result).not.toBeUndefined();

          // Must be one of exactly the 10 defined values.
          expect(Object.values(MarketRegime)).toContain(result);
        }),
        { numRuns: 500 },
      );
    });

    it('classifyRegime returns exactly one regime (not an array or object) for any input', () => {
      fc.assert(
        fc.property(anyValidInputsArb, (inputs) => {
          const result = service.classifyRegime(inputs);
          // Must be a plain string (enum value), not a composite type.
          expect(typeof result).toBe('string');
        }),
        { numRuns: 200 },
      );
    });

    it('UNSTABLE is always a valid fallback: any input returns one of 10 regime codes', () => {
      // Sweep only through the non-HIGH-VIX range to test the other 9 branches.
      const belowVixArb = anyValidInputsArb.filter((i) => i.indiaVix <= 20.0);
      fc.assert(
        fc.property(belowVixArb, (inputs) => {
          const result = service.classifyRegime(inputs);
          expect(VALID_REGIMES).toContain(result);
          // HIGH_VOL must NOT appear for inputs below the VIX threshold.
          expect(result).not.toBe(MarketRegime.HIGH_VOL);
        }),
        { numRuns: 300 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // onNewRegimeInputs — persistence (Requirement 5.5)
  //
  // Every call to onNewRegimeInputs must persist a record to the MarketRegimes
  // table containing the timestamp, all 10 input values, and the classification
  // rationale — regardless of whether the regime changed.
  // ─────────────────────────────────────────────────────────────────────────

  describe('onNewRegimeInputs() — persistence (Requirement 5.5)', () => {
    it('calls repository.create with all 10 input values, regime, and rationale', async () => {
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'BULLISH',
        marketBreadth: 70,
        advanceDeclineRatio: 2.5,
        vwapDeviation: 0.3,
        indiaVix: 15.0,
        atr: 120,
        relativeVolume: 1.8,
        sectorStrength: 65.5,
        futuresBasis: 12.5,
      });

      await service.onNewRegimeInputs(inputs);

      expect(repoMock.create).toHaveBeenCalledTimes(1);
      const dto = repoMock.create.mock.calls[0][0] as Record<string, unknown>;

      // regime field
      expect(dto.regime).toBe(MarketRegime.STRONG_BULL);

      // timestamp (classifiedAt must be a Date)
      expect(dto.classifiedAt).toBeInstanceOf(Date);

      // all 10 input values present
      expect(dto.niftyTrend).toBe('BULLISH');
      expect(dto.bankniftyTrend).toBe('BULLISH');
      expect(dto.marketBreadth).toBe('70');
      expect(dto.advanceDeclineRatio).toBe('2.5');
      expect(dto.vwapDeviation).toBe('0.3');
      expect(dto.indiaVix).toBe('15');
      expect(dto.atr).toBe('120');
      expect(dto.relativeVolume).toBe('1.8');
      expect(dto.sectorStrength).toBe('65.5');
      expect(dto.futuresBasis).toBe('12.5');

      // classification rationale is a non-empty string
      expect(typeof dto.classificationRationale).toBe('string');
      expect((dto.classificationRationale as string).length).toBeGreaterThan(0);
    });

    it('calls repository.save with the created record', async () => {
      const inputs = makeInputs();
      await service.onNewRegimeInputs(inputs);

      expect(repoMock.save).toHaveBeenCalledTimes(1);
    });

    it('persists on every call — not just on regime changes', async () => {
      // Same neutral inputs → SIDEWAYS on first call, still SIDEWAYS on second
      const inputs = makeInputs({
        niftyTrend: 'SIDEWAYS',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50,
        relativeVolume: 0.8,
      });

      await service.onNewRegimeInputs(inputs);
      await service.onNewRegimeInputs(inputs); // same regime, no transition

      // Both calls must have persisted a record
      expect(repoMock.create).toHaveBeenCalledTimes(2);
      expect(repoMock.save).toHaveBeenCalledTimes(2);
    });

    it('persists with null sectorStrength and futuresBasis when inputs are null', async () => {
      const inputs = makeInputs({ sectorStrength: null, futuresBasis: null });
      await service.onNewRegimeInputs(inputs);

      const dto = repoMock.create.mock.calls[0][0] as Record<string, unknown>;
      expect(dto.sectorStrength).toBeNull();
      expect(dto.futuresBasis).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // onNewRegimeInputs — UNSTABLE event emission (Requirement 5.6)
  //
  // When the classification result is UNSTABLE, the service MUST emit the
  // `market.regime.unstable` NestJS event so that RiskEngine can enforce the
  // reduced concurrent-trade limit.
  // ─────────────────────────────────────────────────────────────────────────

  describe('onNewRegimeInputs() — UNSTABLE event emission (Requirement 5.6)', () => {
    it('emits market.regime.unstable when classification resolves to UNSTABLE', async () => {
      // These inputs produce UNSTABLE (breadth exactly 50, BULLISH trend,
      // relVol 1.3 — verified in classifyRegime() unit tests above).
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50,
        relativeVolume: 1.3,
        vwapDeviation: 0.2,
        indiaVix: 15.0,
      });

      await service.onNewRegimeInputs(inputs);

      // Confirm classification is UNSTABLE
      expect(service.getCurrentRegime()).toBe(MarketRegime.UNSTABLE);

      // MUST have emitted market.regime.unstable
      const emitCalls = eventEmitterMock.emit.mock.calls as [string, unknown][];
      const unstableCall = emitCalls.find(([event]) => event === 'market.regime.unstable');
      expect(unstableCall).toBeDefined();

      // Payload must carry the regime, classifiedAt, and inputs
      const payload = unstableCall![1] as Record<string, unknown>;
      expect(payload.regime).toBe(MarketRegime.UNSTABLE);
      expect(payload.classifiedAt).toBeInstanceOf(Date);
      expect(payload.inputs).toEqual(inputs);
    });

    it('emits market.regime.unstable on every UNSTABLE classification, not only on transitions', async () => {
      const unstableInputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50,
        relativeVolume: 1.3,
        vwapDeviation: 0.2,
        indiaVix: 15.0,
      });

      // Call twice — regime stays UNSTABLE across both calls
      await service.onNewRegimeInputs(unstableInputs);
      await service.onNewRegimeInputs(unstableInputs);

      const emitCalls = eventEmitterMock.emit.mock.calls as [string, unknown][];
      const unstableCalls = emitCalls.filter(([event]) => event === 'market.regime.unstable');
      expect(unstableCalls.length).toBe(2);
    });

    it('does NOT emit market.regime.unstable when regime is SIDEWAYS', async () => {
      const sidewaysInputs = makeInputs({
        niftyTrend: 'SIDEWAYS',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50,
        relativeVolume: 0.8,
        indiaVix: 15.0,
      });

      await service.onNewRegimeInputs(sidewaysInputs);

      const emitCalls = eventEmitterMock.emit.mock.calls as [string, unknown][];
      const unstableCalls = emitCalls.filter(([event]) => event === 'market.regime.unstable');
      expect(unstableCalls.length).toBe(0);
    });

    it('does NOT emit market.regime.unstable when regime is HIGH_VOL', async () => {
      const highVolInputs = makeInputs({ indiaVix: 25.0 });

      await service.onNewRegimeInputs(highVolInputs);

      const emitCalls = eventEmitterMock.emit.mock.calls as [string, unknown][];
      const unstableCalls = emitCalls.filter(([event]) => event === 'market.regime.unstable');
      expect(unstableCalls.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Boundary conditions
  // ─────────────────────────────────────────────────────────────────────────

  describe('boundary conditions', () => {
    it('breadth exactly 50 does not match WEAK_BULL (condition is breadth > 50)', () => {
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'SIDEWAYS',
        marketBreadth: 50,
        relativeVolume: 1.2,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.WEAK_BULL);
    });

    it('breadth exactly 60 does not match STRONG_BULL (condition is breadth > 60)', () => {
      const inputs = makeInputs({
        niftyTrend: 'BULLISH',
        bankniftyTrend: 'BULLISH',
        marketBreadth: 60,
        relativeVolume: 1.8,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.STRONG_BULL);
    });

    it('breadth exactly 40 does not match STRONG_BEAR (condition is breadth < 40)', () => {
      const inputs = makeInputs({
        niftyTrend: 'BEARISH',
        bankniftyTrend: 'BEARISH',
        marketBreadth: 40,
        relativeVolume: 2.0,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.STRONG_BEAR);
    });

    it('relativeVolume exactly 0.5 does not match LOW_VOL (condition is relVol < 0.5)', () => {
      const inputs = makeInputs({ relativeVolume: 0.5, indiaVix: 15.0 });
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.LOW_VOL);
    });

    it('relativeVolume exactly 2.0 does not match BREAKOUT (condition is relVol > 2.0)', () => {
      const inputs = makeInputs({
        relativeVolume: 2.0,
        vwapDeviation: 3.0,
        atr: 1.0,
        indiaVix: 15.0,
      });
      expect(service.classifyRegime(inputs)).not.toBe(MarketRegime.BREAKOUT);
    });
  });
});
