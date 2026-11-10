/**
 * iv-regime.service.spec.ts
 *
 * Unit tests and property-based tests for IvRegimeService.
 *
 * Unit tests cover:
 *  - EXPANDING when currentIv > baseline + threshold
 *  - CONTRACTING when currentIv < baseline - threshold
 *  - NEUTRAL when currentIv is within the ±threshold band
 *  - NEUTRAL when there is no history (< 2 observations)
 *  - Weights are independently configurable per regime
 *
 * Property test (Property 7: IV Regime Classification Correctness):
 *  For any (currentIv, baselineAvg, thresholdPp > 0), classifyIvRegime must
 *  return exactly one of the 3 valid regime codes, and the result must be
 *  EXPANDING iff currentIv > baselineAvg + thresholdPp, CONTRACTING iff
 *  currentIv < baselineAvg - thresholdPp, and NEUTRAL otherwise.
 *  Three cases are mutually exclusive and exhaustive.
 *
 * **Validates: Requirements 7.3**
 *
 * Requirements: 7.3
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fc from 'fast-check';
import {
  IvRegimeService,
  IvRegime,
  DEFAULT_THRESHOLD_PP,
  DEFAULT_EXPANDING_CONTRACT_WEIGHT,
  DEFAULT_CONTRACTING_CONTRACT_WEIGHT,
  DEFAULT_NEUTRAL_CONTRACT_WEIGHT,
  DEFAULT_EXPANDING_RR_WEIGHT,
  DEFAULT_CONTRACTING_RR_WEIGHT,
  DEFAULT_NEUTRAL_RR_WEIGHT,
  MIN_OBSERVATIONS_FOR_BASELINE,
} from './iv-regime.service';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a service using the given config overrides
// ─────────────────────────────────────────────────────────────────────────────

function buildService(configOverrides: Record<string, number> = {}): IvRegimeService {
  const configGet = jest.fn((key: string, defaultValue: number) =>
    key in configOverrides ? configOverrides[key] : defaultValue,
  );
  const configService = { get: configGet } as unknown as ConfigService;
  return new IvRegimeService(configService);
}

/**
 * Seed `service` with exactly `count` observations (all equal to `iv`) for
 * the given underlying so `getBaselineAvg` returns a meaningful value.
 */
function seedHistory(
  service: IvRegimeService,
  underlying: string,
  iv: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    service.updateIvHistory(underlying, iv);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('IvRegimeService', () => {
  let service: IvRegimeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IvRegimeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, defaultValue: number) => defaultValue),
          },
        },
      ],
    }).compile();

    service = module.get<IvRegimeService>(IvRegimeService);
  });

  // ── Regime classification ──────────────────────────────────────────────────

  describe('classifyIvRegime', () => {
    it('returns EXPANDING when currentIv > baseline + threshold', () => {
      const underlying = 'NIFTY';
      const baselineIv = 20.0;
      seedHistory(service, underlying, baselineIv, MIN_OBSERVATIONS_FOR_BASELINE);

      // current IV clearly above baseline + threshold (5.0 pp by default)
      const currentIv = baselineIv + DEFAULT_THRESHOLD_PP + 1;
      expect(service.classifyIvRegime(underlying, currentIv)).toBe('EXPANDING');
    });

    it('returns CONTRACTING when currentIv < baseline - threshold', () => {
      const underlying = 'BANKNIFTY';
      const baselineIv = 25.0;
      seedHistory(service, underlying, baselineIv, MIN_OBSERVATIONS_FOR_BASELINE);

      const currentIv = baselineIv - DEFAULT_THRESHOLD_PP - 1;
      expect(service.classifyIvRegime(underlying, currentIv)).toBe('CONTRACTING');
    });

    it('returns NEUTRAL when currentIv is exactly at baseline (within range)', () => {
      const underlying = 'MIDCPNIFTY';
      const baselineIv = 18.0;
      seedHistory(service, underlying, baselineIv, MIN_OBSERVATIONS_FOR_BASELINE);

      expect(service.classifyIvRegime(underlying, baselineIv)).toBe('NEUTRAL');
    });

    it('returns NEUTRAL when currentIv is within +threshold band (not exceeding)', () => {
      const underlying = 'FINNIFTY';
      const baselineIv = 15.0;
      seedHistory(service, underlying, baselineIv, MIN_OBSERVATIONS_FOR_BASELINE);

      // Exactly at the boundary (not strictly greater) → NEUTRAL
      const currentIv = baselineIv + DEFAULT_THRESHOLD_PP;
      expect(service.classifyIvRegime(underlying, currentIv)).toBe('NEUTRAL');
    });

    it('returns NEUTRAL when currentIv is within -threshold band (not below)', () => {
      const underlying = 'SENSEX';
      const baselineIv = 12.0;
      seedHistory(service, underlying, baselineIv, MIN_OBSERVATIONS_FOR_BASELINE);

      // Exactly at the lower boundary (not strictly less) → NEUTRAL
      const currentIv = baselineIv - DEFAULT_THRESHOLD_PP;
      expect(service.classifyIvRegime(underlying, currentIv)).toBe('NEUTRAL');
    });

    it('returns NEUTRAL with no history (0 observations) — conservative default', () => {
      expect(service.classifyIvRegime('NEWUNDERLYING', 30.0)).toBe('NEUTRAL');
    });

    it('returns NEUTRAL with only 1 observation (< 2 required for baseline)', () => {
      const underlying = 'SINGLE';
      service.updateIvHistory(underlying, 20.0);
      expect(service.classifyIvRegime(underlying, 99.0)).toBe('NEUTRAL');
    });
  });

  // ── Baseline average ──────────────────────────────────────────────────────

  describe('getBaselineAvg', () => {
    it('returns null when no history exists', () => {
      expect(service.getBaselineAvg('NIFTY')).toBeNull();
    });

    it('returns null when only 1 observation exists', () => {
      service.updateIvHistory('NIFTY', 20.0);
      expect(service.getBaselineAvg('NIFTY')).toBeNull();
    });

    it('returns correct average of available observations', () => {
      service.updateIvHistory('NIFTY', 10.0);
      service.updateIvHistory('NIFTY', 20.0);
      service.updateIvHistory('NIFTY', 30.0);
      // avg = (10 + 20 + 30) / 3 = 20
      expect(service.getBaselineAvg('NIFTY')).toBeCloseTo(20.0);
    });

    it('caps history at windowSize and computes average over sliding window', () => {
      const svc = buildService({ IV_REGIME_WINDOW_SIZE: 3 });
      svc.updateIvHistory('X', 10);
      svc.updateIvHistory('X', 20);
      svc.updateIvHistory('X', 30);
      // Buffer is [10, 20, 30] → avg 20
      expect(svc.getBaselineAvg('X')).toBeCloseTo(20);

      // Slide in a 4th entry → [20, 30, 40]
      svc.updateIvHistory('X', 40);
      expect(svc.getBaselineAvg('X')).toBeCloseTo(30);
    });
  });

  // ── IV history update ─────────────────────────────────────────────────────

  describe('updateIvHistory', () => {
    it('creates history for a new underlying', () => {
      expect(service.getBaselineAvg('NEW')).toBeNull();
      service.updateIvHistory('NEW', 15.0);
      service.updateIvHistory('NEW', 17.0);
      expect(service.getBaselineAvg('NEW')).toBeCloseTo(16.0);
    });

    it('keeps separate history per underlying', () => {
      service.updateIvHistory('NIFTY', 20.0);
      service.updateIvHistory('NIFTY', 22.0);
      service.updateIvHistory('BANKNIFTY', 30.0);
      service.updateIvHistory('BANKNIFTY', 34.0);

      expect(service.getBaselineAvg('NIFTY')).toBeCloseTo(21.0);
      expect(service.getBaselineAvg('BANKNIFTY')).toBeCloseTo(32.0);
    });

    it('evicts oldest entry once window is full', () => {
      const svc = buildService({ IV_REGIME_WINDOW_SIZE: 2 });
      svc.updateIvHistory('X', 10);
      svc.updateIvHistory('X', 20);
      // Buffer: [10, 20], avg = 15
      expect(svc.getBaselineAvg('X')).toBeCloseTo(15);
      svc.updateIvHistory('X', 30);
      // Buffer: [20, 30], avg = 25 (10 evicted)
      expect(svc.getBaselineAvg('X')).toBeCloseTo(25);
    });
  });

  // ── Weight factors ─────────────────────────────────────────────────────────

  describe('getWeights', () => {
    it('returns default EXPANDING weights', () => {
      const w = service.getWeights('EXPANDING');
      expect(w.contractSelectionWeight).toBe(DEFAULT_EXPANDING_CONTRACT_WEIGHT);
      expect(w.rrEstimationWeight).toBe(DEFAULT_EXPANDING_RR_WEIGHT);
    });

    it('returns default CONTRACTING weights', () => {
      const w = service.getWeights('CONTRACTING');
      expect(w.contractSelectionWeight).toBe(DEFAULT_CONTRACTING_CONTRACT_WEIGHT);
      expect(w.rrEstimationWeight).toBe(DEFAULT_CONTRACTING_RR_WEIGHT);
    });

    it('returns default NEUTRAL weights', () => {
      const w = service.getWeights('NEUTRAL');
      expect(w.contractSelectionWeight).toBe(DEFAULT_NEUTRAL_CONTRACT_WEIGHT);
      expect(w.rrEstimationWeight).toBe(DEFAULT_NEUTRAL_RR_WEIGHT);
    });

    it('weights are independently configurable per regime via config', () => {
      const svc = buildService({
        IV_REGIME_EXPANDING_CONTRACT_WEIGHT: 1.5,
        IV_REGIME_EXPANDING_RR_WEIGHT: 1.3,
        IV_REGIME_CONTRACTING_CONTRACT_WEIGHT: 0.6,
        IV_REGIME_CONTRACTING_RR_WEIGHT: 0.7,
        IV_REGIME_NEUTRAL_CONTRACT_WEIGHT: 1.1,
        IV_REGIME_NEUTRAL_RR_WEIGHT: 1.05,
      });

      // EXPANDING weights are independently set
      const expanding = svc.getWeights('EXPANDING');
      expect(expanding.contractSelectionWeight).toBe(1.5);
      expect(expanding.rrEstimationWeight).toBe(1.3);

      // CONTRACTING weights differ from EXPANDING
      const contracting = svc.getWeights('CONTRACTING');
      expect(contracting.contractSelectionWeight).toBe(0.6);
      expect(contracting.rrEstimationWeight).toBe(0.7);

      // NEUTRAL weights differ from both
      const neutral = svc.getWeights('NEUTRAL');
      expect(neutral.contractSelectionWeight).toBe(1.1);
      expect(neutral.rrEstimationWeight).toBe(1.05);

      // All six values are distinct → independently configurable
      const allWeights = [
        expanding.contractSelectionWeight,
        expanding.rrEstimationWeight,
        contracting.contractSelectionWeight,
        contracting.rrEstimationWeight,
        neutral.contractSelectionWeight,
        neutral.rrEstimationWeight,
      ];
      const unique = new Set(allWeights);
      expect(unique.size).toBe(6);
    });

    it('EXPANDING and NEUTRAL contract selection weights are different by default', () => {
      expect(service.getWeights('EXPANDING').contractSelectionWeight).not.toBe(
        service.getWeights('NEUTRAL').contractSelectionWeight,
      );
    });

    it('CONTRACTING and NEUTRAL R:R weights are different by default', () => {
      expect(service.getWeights('CONTRACTING').rrEstimationWeight).not.toBe(
        service.getWeights('NEUTRAL').rrEstimationWeight,
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property-based test
// Property 7: IV Regime Classification Correctness
// **Validates: Requirements 7.3**
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 7: IV Regime Classification Correctness', () => {
  /**
   * Helper that directly encodes the classification rule from the spec,
   * independent of the service implementation, so we can verify the service
   * produces the same outcome.
   */
  function expectedRegime(currentIv: number, baselineAvg: number, thresholdPp: number): IvRegime {
    if (currentIv > baselineAvg + thresholdPp) return 'EXPANDING';
    if (currentIv < baselineAvg - thresholdPp) return 'CONTRACTING';
    return 'NEUTRAL';
  }

  /**
   * Valid regime codes — the set is closed and exhaustive.
   */
  const VALID_REGIMES: IvRegime[] = ['EXPANDING', 'CONTRACTING', 'NEUTRAL'];

  it('classifyIvRegime returns exactly one valid regime code for any (currentIv, baselineAvg, thresholdPp)', () => {
    fc.assert(
      fc.property(
        // currentIv: any plausible IV value (0.01 – 200 pp)
        fc.float({ min: Math.fround(0.01), max: Math.fround(200), noNaN: true }),
        // baselineAvg: any plausible baseline (0.01 – 200 pp)
        fc.float({ min: Math.fround(0.01), max: Math.fround(200), noNaN: true }),
        // thresholdPp: strictly positive (1 – 50 pp, per requirement 7.3)
        fc.float({ min: Math.fround(1), max: Math.fround(50), noNaN: true }),
        (currentIv, baselineAvg, thresholdPp) => {
          const svc = buildService({ IV_REGIME_THRESHOLD_PP: thresholdPp });

          // Prime the service with exactly `MIN_OBSERVATIONS_FOR_BASELINE`
          // uniform observations so baseline = baselineAvg exactly.
          for (let i = 0; i < MIN_OBSERVATIONS_FOR_BASELINE; i++) {
            svc.updateIvHistory('SYM', baselineAvg);
          }

          const regime = svc.classifyIvRegime('SYM', currentIv);

          // 1. Result must be one of the 3 valid codes.
          expect(VALID_REGIMES).toContain(regime);

          // 2. Result must exactly match the specification rule.
          expect(regime).toBe(expectedRegime(currentIv, baselineAvg, thresholdPp));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('the three regime outcomes are mutually exclusive and exhaustive', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.01), max: Math.fround(200), noNaN: true }),
        fc.float({ min: Math.fround(0.01), max: Math.fround(200), noNaN: true }),
        fc.float({ min: Math.fround(1), max: Math.fround(50), noNaN: true }),
        (currentIv, baselineAvg, thresholdPp) => {
          const svc = buildService({ IV_REGIME_THRESHOLD_PP: thresholdPp });
          for (let i = 0; i < MIN_OBSERVATIONS_FOR_BASELINE; i++) {
            svc.updateIvHistory('SYM', baselineAvg);
          }

          const regime = svc.classifyIvRegime('SYM', currentIv);

          const isExpanding = currentIv > baselineAvg + thresholdPp;
          const isContracting = currentIv < baselineAvg - thresholdPp;
          // By construction, exactly one of the three conditions holds.

          // Mutual exclusivity: EXPANDING and CONTRACTING cannot both be true
          // (they can't overlap since thresholdPp > 0 means the two
          // boundaries are separated by 2 × thresholdPp).
          expect(isExpanding && isContracting).toBe(false);

          // Exhaustiveness: the service must pick the right one.
          if (isExpanding) expect(regime).toBe('EXPANDING');
          else if (isContracting) expect(regime).toBe('CONTRACTING');
          else expect(regime).toBe('NEUTRAL');
        },
      ),
      { numRuns: 1000 },
    );
  });
});
