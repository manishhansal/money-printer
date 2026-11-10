/**
 * theta-decay.service.spec.ts
 *
 * Unit tests and property-based test for ThetaDecayService (task 11.5).
 *
 * Unit tests cover:
 *  1.  Returns null when no Greeks cached for securityId.
 *  2.  Returns null when Greeks are stale (>60 seconds old — fake timers).
 *  3.  Returns non-negative thetaDecayRupees when theta is negative (standard
 *      long-position convention, e.g. theta = -5.3).
 *  4.  Returns non-negative thetaDecayRupees when theta is positive (unusual
 *      short-position or exotic scenario).
 *  5.  Returns 0 when theta = 0.
 *  6.  thetaDecayRupees = Math.abs(theta) × lotSize × quantity.
 *  7.  Result carries correct securityId, lotSize, quantity, and computedAt.
 *  8.  computeThetaDecayForPositions returns a result for every position whose
 *      Greeks are currently fresh.
 *  9.  computeThetaDecayForPositions silently skips positions without cached
 *      Greeks.
 * 10.  computeThetaDecayForPositions returns an empty array when no positions
 *      have fresh Greeks.
 * 11.  computeThetaDecayForPositions returns an empty array for empty input.
 *
 * Property test (Property 8: Theta Decay Is Non-Negative):
 *  For any theta (positive or negative), lotSize ≥ 1, quantity ≥ 1,
 *  thetaDecayRupees MUST always be >= 0.
 *
 * **Validates: Requirements 7.5**
 *
 * Requirements: 7.5
 */

import { Test, TestingModule } from '@nestjs/testing';
import * as fc from 'fast-check';
import { ThetaDecayService } from './theta-decay.service';
import { OptionsIntelligenceService } from './options-intelligence.service';
import { GreekValues, GREEKS_MAX_AGE_MS } from './options-intelligence.types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal GreekValues fixture with the given theta.
 * All other Greek fields use sensible defaults.
 */
function makeGreekValues(
  instrumentId: string,
  theta: number,
  computedAt: Date = new Date(),
): GreekValues {
  return {
    delta: 0.45,
    gamma: 0.02,
    theta,
    vega: 0.18,
    computedAt,
    instrumentId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock setup
// ─────────────────────────────────────────────────────────────────────────────

const mockGetGreeks = jest.fn<GreekValues | null, [string]>();

const mockOptionsIntelligenceService = {
  getGreeks: mockGetGreeks,
} as unknown as OptionsIntelligenceService;

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ThetaDecayService', () => {
  let service: ThetaDecayService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThetaDecayService,
        {
          provide: OptionsIntelligenceService,
          useValue: mockOptionsIntelligenceService,
        },
      ],
    }).compile();

    service = module.get<ThetaDecayService>(ThetaDecayService);
  });

  afterEach(() => {
    // Ensure fake timers are restored if a test installed them.
    jest.useRealTimers();
  });

  // ── 1. No cached Greeks → null ───────────────────────────────────────────

  describe('computeThetaDecay() — no cached Greeks', () => {
    it('returns null when no entry exists for the given securityId', () => {
      mockGetGreeks.mockReturnValue(null);

      const result = service.computeThetaDecay('99999', 50, 2);

      expect(result).toBeNull();
      expect(mockGetGreeks).toHaveBeenCalledWith('99999');
    });

    it('returns null for a securityId that was never fetched', () => {
      mockGetGreeks.mockReturnValue(null);

      expect(service.computeThetaDecay('0', 50, 2)).toBeNull();
      expect(service.computeThetaDecay('unknown', 25, 1)).toBeNull();
    });
  });

  // ── 2. Stale Greeks (fake timers) → null ─────────────────────────────────

  describe('computeThetaDecay() — stale Greeks (>60 s)', () => {
    it('returns null when Greeks are stale (>60 seconds old)', () => {
      jest.useFakeTimers();

      // Capture the wall-clock time at the moment of "fetch"
      const computedAt = new Date(Date.now());

      // Simulate a time-aware getGreeks: returns null once the value is stale.
      // This mirrors OptionsIntelligenceService.getGreeks() behaviour exactly.
      mockGetGreeks.mockImplementation(() => {
        const ageMs = Date.now() - computedAt.getTime();
        if (ageMs > GREEKS_MAX_AGE_MS) return null;
        return makeGreekValues('49081', -5.3, computedAt);
      });

      // Advance past the 60-second staleness threshold
      jest.advanceTimersByTime(GREEKS_MAX_AGE_MS + 1);

      const result = service.computeThetaDecay('49081', 50, 2);

      expect(result).toBeNull();
    });

    it('returns null when cache is exactly GREEKS_MAX_AGE_MS + 1 ms old', () => {
      jest.useFakeTimers();

      const computedAt = new Date(Date.now());
      mockGetGreeks.mockImplementation(() => {
        const ageMs = Date.now() - computedAt.getTime();
        if (ageMs > GREEKS_MAX_AGE_MS) return null;
        return makeGreekValues('49082', -4.8, computedAt);
      });

      jest.advanceTimersByTime(60_001);

      expect(service.computeThetaDecay('49082', 25, 1)).toBeNull();
    });
  });

  // ── 3. Theta is negative (standard long position) ─────────────────────────

  describe('computeThetaDecay() — theta is negative (standard case)', () => {
    it('returns non-negative thetaDecayRupees when theta = -5.3', () => {
      mockGetGreeks.mockReturnValue(makeGreekValues('49081', -5.3));

      const result = service.computeThetaDecay('49081', 50, 2);

      expect(result).not.toBeNull();
      expect(result!.thetaDecayRupees).toBeGreaterThanOrEqual(0);
    });

    it('thetaDecayRupees is positive (not zero) when theta = -5.3', () => {
      mockGetGreeks.mockReturnValue(makeGreekValues('49081', -5.3));

      const result = service.computeThetaDecay('49081', 50, 2);

      expect(result!.thetaDecayRupees).toBeGreaterThan(0);
    });
  });

  // ── 4. Theta is positive (unusual case) ──────────────────────────────────

  describe('computeThetaDecay() — theta is positive (unusual)', () => {
    it('returns non-negative thetaDecayRupees when theta = 3.7', () => {
      mockGetGreeks.mockReturnValue(makeGreekValues('49081', 3.7));

      const result = service.computeThetaDecay('49081', 50, 2);

      expect(result).not.toBeNull();
      expect(result!.thetaDecayRupees).toBeGreaterThanOrEqual(0);
    });
  });

  // ── 5. Theta = 0 ────────────────────────────────────────────────────────

  describe('computeThetaDecay() — theta is zero', () => {
    it('returns thetaDecayRupees = 0 when theta = 0', () => {
      mockGetGreeks.mockReturnValue(makeGreekValues('49081', 0));

      const result = service.computeThetaDecay('49081', 50, 2);

      expect(result).not.toBeNull();
      expect(result!.thetaDecayRupees).toBe(0);
    });
  });

  // ── 6. Computation correctness ────────────────────────────────────────────

  describe('computeThetaDecay() — arithmetic', () => {
    it('computes thetaDecayRupees = Math.abs(theta) × lotSize × quantity', () => {
      const theta = -5.3;
      const lotSize = 50;
      const quantity = 2;
      mockGetGreeks.mockReturnValue(makeGreekValues('49081', theta));

      const result = service.computeThetaDecay('49081', lotSize, quantity);

      expect(result).not.toBeNull();
      expect(result!.thetaDecayRupees).toBeCloseTo(Math.abs(theta) * lotSize * quantity, 10);
    });

    it('computes correctly for positive theta (Math.abs is a no-op)', () => {
      const theta = 7.2;
      const lotSize = 75;
      const quantity = 3;
      mockGetGreeks.mockReturnValue(makeGreekValues('49083', theta));

      const result = service.computeThetaDecay('49083', lotSize, quantity);

      expect(result!.thetaDecayRupees).toBeCloseTo(theta * lotSize * quantity, 10);
    });
  });

  // ── 7. Result shape ───────────────────────────────────────────────────────

  describe('computeThetaDecay() — result fields', () => {
    it('returns correct securityId, lotSize, quantity, and computedAt', () => {
      const computedAt = new Date();
      mockGetGreeks.mockReturnValue(makeGreekValues('49081', -5.3, computedAt));

      const result = service.computeThetaDecay('49081', 50, 2);

      expect(result!.securityId).toBe('49081');
      expect(result!.lotSize).toBe(50);
      expect(result!.quantity).toBe(2);
      expect(result!.computedAt).toBe(computedAt); // same Date object reference
    });
  });

  // ── 8-11. computeThetaDecayForPositions ──────────────────────────────────

  describe('computeThetaDecayForPositions()', () => {
    it('returns a ThetaDecayResult for every position with fresh Greeks', () => {
      mockGetGreeks.mockImplementation((id) => makeGreekValues(id, -5.3));

      const positions = [
        { securityId: '49081', lotSize: 50, quantity: 2 },
        { securityId: '49082', lotSize: 25, quantity: 1 },
        { securityId: '49083', lotSize: 50, quantity: 4 },
      ];

      const results = service.computeThetaDecayForPositions(positions);

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.securityId)).toEqual(['49081', '49082', '49083']);
    });

    it('skips positions whose Greeks are not cached (getGreeks returns null)', () => {
      mockGetGreeks.mockImplementation((id) => {
        if (id === '49081') return makeGreekValues(id, -5.3);
        return null; // no Greeks for other IDs
      });

      const positions = [
        { securityId: '49081', lotSize: 50, quantity: 2 }, // has Greeks
        { securityId: '99999', lotSize: 25, quantity: 1 }, // no Greeks
      ];

      const results = service.computeThetaDecayForPositions(positions);

      expect(results).toHaveLength(1);
      expect(results[0].securityId).toBe('49081');
    });

    it('returns empty array when no positions have cached Greeks', () => {
      mockGetGreeks.mockReturnValue(null);

      const positions = [
        { securityId: '99999', lotSize: 50, quantity: 2 },
        { securityId: '88888', lotSize: 25, quantity: 1 },
      ];

      const results = service.computeThetaDecayForPositions(positions);

      expect(results).toHaveLength(0);
    });

    it('returns empty array for an empty positions input', () => {
      const results = service.computeThetaDecayForPositions([]);

      expect(results).toHaveLength(0);
    });

    it('each result carries the correct per-position thetaDecayRupees', () => {
      mockGetGreeks.mockImplementation((id) => {
        const theta = id === '49081' ? -5.3 : -4.8;
        return makeGreekValues(id, theta);
      });

      const positions = [
        { securityId: '49081', lotSize: 50, quantity: 2 },
        { securityId: '49082', lotSize: 25, quantity: 1 },
      ];

      const results = service.computeThetaDecayForPositions(positions);

      expect(results[0].thetaDecayRupees).toBeCloseTo(5.3 * 50 * 2, 10);
      expect(results[1].thetaDecayRupees).toBeCloseTo(4.8 * 25 * 1, 10);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property-based test
// Property 8: Theta Decay Is Non-Negative
//
// For any theta (positive or negative), lotSize ≥ 1, quantity ≥ 1,
// thetaDecayRupees MUST always be >= 0.
//
// **Validates: Requirements 7.5**
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 8: Theta Decay Is Non-Negative', () => {
  /**
   * Directly instantiate ThetaDecayService with an inline mock so we avoid
   * the overhead of compiling a full NestJS TestingModule on every fc.assert
   * iteration (1 000 runs).
   */
  it('thetaDecayRupees is always >= 0 for any finite theta, lotSize >= 1, quantity >= 1', () => {
    fc.assert(
      fc.property(
        // theta: any finite float — covers negative (long), positive (short),
        // and zero values without NaN or ±Infinity edge cases.
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        // lotSize: at least 1 lot; cap at 10 000 to stay in realistic range.
        fc.integer({ min: 1, max: 10_000 }),
        // quantity: at least 1 unit; cap at 10 000.
        fc.integer({ min: 1, max: 10_000 }),
        (theta, lotSize, quantity) => {
          const computedAt = new Date();
          const greeks = makeGreekValues('test-id', theta, computedAt);

          // Build a minimal inline mock that always returns the given greeks.
          const mockOIS = {
            getGreeks: (_id: string): GreekValues | null => greeks,
          } as unknown as OptionsIntelligenceService;

          const testService = new ThetaDecayService(mockOIS);
          const result = testService.computeThetaDecay('test-id', lotSize, quantity);

          // getGreeks always returns a fresh value → result must be non-null.
          if (result === null) {
            throw new Error(
              `Expected non-null result for theta=${theta}, ` +
                `lotSize=${lotSize}, quantity=${quantity}`,
            );
          }

          // Core invariant: thetaDecayRupees is always a non-negative number.
          return result.thetaDecayRupees >= 0;
        },
      ),
      { numRuns: 1000 },
    );
  });
});
