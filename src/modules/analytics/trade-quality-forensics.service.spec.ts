/**
 * TradeQualityForensicsService unit tests (19 tests).
 *
 * No database interactions — the service is pure computation.
 *
 * Tests:
 *
 * computeQcr
 *  1.  MFE = 0  → returns null (no division performed)
 *  2.  MFE > 0, netPnl positive  → returns positive ratio
 *  3.  MFE > 0, netPnl negative  → returns negative ratio
 *  4.  netPnl = 0, MFE > 0       → returns 0
 *  5.  netPnl = MFE > 0          → returns exactly 1.0
 *
 * classifyExit
 *  6.  qcr null  → 'no-favorable-excursion'
 *  7.  qcr 0.69 (< 0.70)              → 'premature'
 *  8.  qcr 0.00 (< 0.70)              → 'premature'
 *  9.  qcr 0.70 exactly, exitTime = mfeTime  → 'near-optimal'
 * 10.  qcr 0.70 exactly, exitTime < mfeTime  → 'near-optimal'
 * 11.  qcr 0.70 exactly, exitTime > mfeTime  → 'late'
 * 12.  qcr 0.95, exitTime > mfeTime          → 'late'
 * 13.  qcr >= 0.70, mfeTime null             → 'late' (conservative fallback)
 * 14.  qcr negative (< 0.70)                 → 'premature'
 *
 * rateExecutionQuality
 * 15.  qcr null       → 'No Favorable Excursion'
 * 16.  qcr 0.39 (< 0.40)         → 'Poor'
 * 17.  qcr 0.00                   → 'Poor'
 * 18.  qcr 0.40 exactly           → 'Fair'   (boundary: Fair starts at 0.40)
 * 19.  qcr 0.69                   → 'Fair'
 * 20.  qcr 0.70 exactly           → 'Good'   (boundary: Good starts at 0.70)
 * 21.  qcr 0.89                   → 'Good'
 * 22.  qcr 0.90 exactly           → 'Excellent' (boundary: Excellent at ≥ 0.90)
 * 23.  qcr 1.00                   → 'Excellent'
 * 24.  qcr negative               → 'Poor'
 *
 * Requirements: 20.3, 20.4
 */

import { TradeQualityForensicsService } from './trade-quality-forensics.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a Date offset by `seconds` from the reference epoch. */
function dateAt(seconds: number): Date {
  return new Date(1_700_000_000_000 + seconds * 1_000);
}

const T0 = dateAt(0); // reference time (exit reference)
const T_BEFORE = dateAt(-60); // 60 s before T0
const T_AFTER = dateAt(60); // 60 s after T0

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('TradeQualityForensicsService', () => {
  let service: TradeQualityForensicsService;

  beforeEach(() => {
    service = new TradeQualityForensicsService();
  });

  // ── computeQcr ─────────────────────────────────────────────────────────────

  describe('computeQcr', () => {
    it('returns null when MFE = 0 (no division performed)', () => {
      expect(service.computeQcr(500, 0)).toBeNull();
      expect(service.computeQcr(-200, 0)).toBeNull();
      expect(service.computeQcr(0, 0)).toBeNull();
    });

    it('returns positive ratio when netPnl > 0 and MFE > 0', () => {
      expect(service.computeQcr(70, 100)).toBeCloseTo(0.7);
      expect(service.computeQcr(90, 100)).toBeCloseTo(0.9);
    });

    it('returns negative ratio when netPnl < 0 and MFE > 0', () => {
      expect(service.computeQcr(-50, 100)).toBeCloseTo(-0.5);
    });

    it('returns 0 when netPnl = 0 and MFE > 0', () => {
      expect(service.computeQcr(0, 100)).toBeCloseTo(0);
    });

    it('returns exactly 1.0 when netPnl equals MFE', () => {
      expect(service.computeQcr(250, 250)).toBeCloseTo(1.0);
    });
  });

  // ── classifyExit ───────────────────────────────────────────────────────────

  describe('classifyExit', () => {
    it('returns "no-favorable-excursion" when qcr is null', () => {
      expect(service.classifyExit(null, T0, T_BEFORE)).toBe('no-favorable-excursion');
      expect(service.classifyExit(null, T0, null)).toBe('no-favorable-excursion');
    });

    it('returns "premature" when qcr < 0.70 (just below threshold)', () => {
      expect(service.classifyExit(0.69, T0, T_BEFORE)).toBe('premature');
    });

    it('returns "premature" when qcr = 0.00', () => {
      expect(service.classifyExit(0.0, T0, T_AFTER)).toBe('premature');
    });

    it('returns "premature" for negative qcr (loss trade)', () => {
      expect(service.classifyExit(-0.5, T0, T_BEFORE)).toBe('premature');
    });

    it('returns "near-optimal" when qcr = 0.70 exactly and exitTime equals mfeTime', () => {
      expect(service.classifyExit(0.7, T0, T0)).toBe('near-optimal');
    });

    it('returns "near-optimal" when qcr >= 0.70 and exitTime is before mfeTime', () => {
      expect(service.classifyExit(0.8, T_BEFORE, T0)).toBe('near-optimal');
    });

    it('returns "late" when qcr = 0.70 exactly and exitTime is after mfeTime', () => {
      expect(service.classifyExit(0.7, T_AFTER, T0)).toBe('late');
    });

    it('returns "late" when qcr = 0.95 and exitTime is after mfeTime', () => {
      expect(service.classifyExit(0.95, T_AFTER, T0)).toBe('late');
    });

    it('returns "late" when qcr >= 0.70 and mfeTime is null (conservative fallback)', () => {
      expect(service.classifyExit(0.75, T0, null)).toBe('late');
      expect(service.classifyExit(1.0, T0, null)).toBe('late');
    });
  });

  // ── rateExecutionQuality ───────────────────────────────────────────────────

  describe('rateExecutionQuality', () => {
    it('returns "No Favorable Excursion" when qcr is null', () => {
      expect(service.rateExecutionQuality(null)).toBe('No Favorable Excursion');
    });

    it('returns "Poor" when qcr < 0.40', () => {
      expect(service.rateExecutionQuality(0.39)).toBe('Poor');
      expect(service.rateExecutionQuality(0.0)).toBe('Poor');
    });

    it('returns "Poor" for negative qcr', () => {
      expect(service.rateExecutionQuality(-1.0)).toBe('Poor');
    });

    it('returns "Fair" at the lower boundary (qcr = 0.40 exactly)', () => {
      expect(service.rateExecutionQuality(0.4)).toBe('Fair');
    });

    it('returns "Fair" for qcr in the range [0.40, 0.70)', () => {
      expect(service.rateExecutionQuality(0.55)).toBe('Fair');
      expect(service.rateExecutionQuality(0.69)).toBe('Fair');
    });

    it('returns "Good" at the lower boundary (qcr = 0.70 exactly)', () => {
      expect(service.rateExecutionQuality(0.7)).toBe('Good');
    });

    it('returns "Good" for qcr in the range [0.70, 0.90)', () => {
      expect(service.rateExecutionQuality(0.8)).toBe('Good');
      expect(service.rateExecutionQuality(0.89)).toBe('Good');
    });

    it('returns "Excellent" at the lower boundary (qcr = 0.90 exactly)', () => {
      expect(service.rateExecutionQuality(0.9)).toBe('Excellent');
    });

    it('returns "Excellent" for qcr >= 0.90', () => {
      expect(service.rateExecutionQuality(0.95)).toBe('Excellent');
      expect(service.rateExecutionQuality(1.0)).toBe('Excellent');
      expect(service.rateExecutionQuality(1.2)).toBe('Excellent');
    });
  });
});
