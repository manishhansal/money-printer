/**
 * expiry-day-controls.service.spec.ts
 *
 * Unit tests for ExpiryDayControlsService (task 11.4).
 *
 * Covers:
 *  1.  isExpiryDay() returns true when tradingDate and expiryDate are the same
 *      calendar day (UTC date match).
 *  2.  isExpiryDay() returns false when tradingDate and expiryDate are on
 *      different calendar days.
 *  3.  getControls() on expiry day: signalScoreThreshold = standard + delta
 *      (default: 80 + 5 = 85).
 *  4.  getControls() on expiry day: signalScoreThreshold reflects custom
 *      configured values.
 *  5.  getControls() on expiry day: positionSizeLimitPct is within 10–90
 *      (default: 50).
 *  6.  getControls() on expiry day: mandatorySquareOffTime is between "12:00"
 *      and "14:30" (default: "14:00").
 *  7.  getControls() on non-expiry day: standard threshold (80), full
 *      position size (100%), and standard square-off time ("15:15").
 *  8.  getControls() on expiry day: isExpiryDay flag is true.
 *  9.  getControls() on non-expiry day: isExpiryDay flag is false.
 * 10.  isExpiryDay() is date-only: same day but different times → still true.
 * 11.  isExpiryDay() boundary: day before expiry → false.
 * 12.  isExpiryDay() boundary: day after expiry → false.
 * 13.  getControls() with configured boundary position size 10 → within range.
 * 14.  getControls() with configured boundary position size 90 → within range.
 * 15.  getControls() with configured boundary square-off "12:00" → in range.
 * 16.  getControls() with configured boundary square-off "14:30" → in range.
 *
 * Requirements: 7.4
 */

import { ExpiryDayControlsService } from './expiry-day-controls.service';
import { ConfigService } from '@nestjs/config';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a mock ConfigService whose `get` implementation returns values from
 * the provided `overrides` map (keyed by env-var name), falling back to the
 * second argument (defaultValue) when a key is absent — matching NestJS
 * ConfigService's behaviour.
 */
function makeConfigService(overrides: Record<string, string | number> = {}): ConfigService {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        return overrides[key] as unknown as T;
      }
      return defaultValue as T;
    },
  } as unknown as ConfigService;
}

/** Build a UTC Date for a given "YYYY-MM-DD" date at the specified UTC time. */
function utcDate(dateStr: string, utcHour = 6, utcMin = 0): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, utcHour, utcMin, 0));
}

/** Compares two "HH:mm" time strings; returns a number like strcmp. */
function compareTime(a: string, b: string): number {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return ah * 60 + am - (bh * 60 + bm);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ExpiryDayControlsService', () => {
  // Shared trading and expiry dates used across suites
  const EXPIRY_DATE = '2024-10-17';
  const expiryDay = utcDate(EXPIRY_DATE, 3, 30); // 03:30 UTC = 09:00 IST
  const nonExpiryDay = utcDate('2024-10-16', 6, 0);

  // ── isExpiryDay ────────────────────────────────────────────────────────────

  describe('isExpiryDay()', () => {
    it('returns true when tradingDate and expiryDate are the same calendar day', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      expect(service.isExpiryDay(expiryDay, EXPIRY_DATE)).toBe(true);
    });

    it('returns false when tradingDate is one day before expiryDate', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const dayBefore = utcDate('2024-10-16', 6, 0);
      expect(service.isExpiryDay(dayBefore, EXPIRY_DATE)).toBe(false);
    });

    it('returns false when tradingDate is one day after expiryDate', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const dayAfter = utcDate('2024-10-18', 6, 0);
      expect(service.isExpiryDay(dayAfter, EXPIRY_DATE)).toBe(false);
    });

    it('returns true regardless of the time component on the same day', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      // Different UTC times on the same UTC date all equal the expiry date
      const morning = utcDate(EXPIRY_DATE, 3, 30); // 09:00 IST
      const noon = utcDate(EXPIRY_DATE, 6, 30); // 12:00 IST
      const afternoon = utcDate(EXPIRY_DATE, 8, 45); // 14:15 IST

      expect(service.isExpiryDay(morning, EXPIRY_DATE)).toBe(true);
      expect(service.isExpiryDay(noon, EXPIRY_DATE)).toBe(true);
      expect(service.isExpiryDay(afternoon, EXPIRY_DATE)).toBe(true);
    });

    it('returns false when the month differs', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const differentMonth = utcDate('2024-09-17', 6, 0);
      expect(service.isExpiryDay(differentMonth, EXPIRY_DATE)).toBe(false);
    });

    it('returns false when the year differs', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const differentYear = utcDate('2025-10-17', 6, 0);
      expect(service.isExpiryDay(differentYear, EXPIRY_DATE)).toBe(false);
    });
  });

  // ── getControls — expiry day ───────────────────────────────────────────────

  describe('getControls() on expiry day', () => {
    it('sets isExpiryDay to true', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(controls.isExpiryDay).toBe(true);
    });

    it('sets signalScoreThreshold to standard + delta using defaults (80 + 5 = 85)', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(controls.signalScoreThreshold).toBe(85);
    });

    it('applies custom STANDARD_SIGNAL_SCORE_THRESHOLD and EXPIRY_DAY_SCORE_THRESHOLD_DELTA', () => {
      const service = new ExpiryDayControlsService(
        makeConfigService({
          STANDARD_SIGNAL_SCORE_THRESHOLD: 75,
          EXPIRY_DAY_SCORE_THRESHOLD_DELTA: 10,
        }),
      );
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(controls.signalScoreThreshold).toBe(85); // 75 + 10
    });

    it('positionSizeLimitPct is within valid range 10–90 (default 50)', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(controls.positionSizeLimitPct).toBeGreaterThanOrEqual(10);
      expect(controls.positionSizeLimitPct).toBeLessThanOrEqual(90);
    });

    it('positionSizeLimitPct equals configured value when set to minimum boundary (10)', () => {
      const service = new ExpiryDayControlsService(
        makeConfigService({ EXPIRY_DAY_POSITION_SIZE_LIMIT_PCT: 10 }),
      );
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(controls.positionSizeLimitPct).toBe(10);
      expect(controls.positionSizeLimitPct).toBeGreaterThanOrEqual(10);
      expect(controls.positionSizeLimitPct).toBeLessThanOrEqual(90);
    });

    it('positionSizeLimitPct equals configured value when set to maximum boundary (90)', () => {
      const service = new ExpiryDayControlsService(
        makeConfigService({ EXPIRY_DAY_POSITION_SIZE_LIMIT_PCT: 90 }),
      );
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(controls.positionSizeLimitPct).toBe(90);
      expect(controls.positionSizeLimitPct).toBeGreaterThanOrEqual(10);
      expect(controls.positionSizeLimitPct).toBeLessThanOrEqual(90);
    });

    it('mandatorySquareOffTime is within valid range "12:00"–"14:30" (default "14:00")', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(compareTime(controls.mandatorySquareOffTime, '12:00')).toBeGreaterThanOrEqual(0);
      expect(compareTime(controls.mandatorySquareOffTime, '14:30')).toBeLessThanOrEqual(0);
    });

    it('mandatorySquareOffTime equals configured "12:00" (lower boundary)', () => {
      const service = new ExpiryDayControlsService(
        makeConfigService({ EXPIRY_DAY_SQUARE_OFF_TIME: '12:00' }),
      );
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(controls.mandatorySquareOffTime).toBe('12:00');
      expect(compareTime(controls.mandatorySquareOffTime, '12:00')).toBeGreaterThanOrEqual(0);
      expect(compareTime(controls.mandatorySquareOffTime, '14:30')).toBeLessThanOrEqual(0);
    });

    it('mandatorySquareOffTime equals configured "14:30" (upper boundary)', () => {
      const service = new ExpiryDayControlsService(
        makeConfigService({ EXPIRY_DAY_SQUARE_OFF_TIME: '14:30' }),
      );
      const controls = service.getControls(expiryDay, EXPIRY_DATE);
      expect(controls.mandatorySquareOffTime).toBe('14:30');
      expect(compareTime(controls.mandatorySquareOffTime, '12:00')).toBeGreaterThanOrEqual(0);
      expect(compareTime(controls.mandatorySquareOffTime, '14:30')).toBeLessThanOrEqual(0);
    });
  });

  // ── getControls — non-expiry day ──────────────────────────────────────────

  describe('getControls() on non-expiry day', () => {
    it('sets isExpiryDay to false', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const controls = service.getControls(nonExpiryDay, EXPIRY_DATE);
      expect(controls.isExpiryDay).toBe(false);
    });

    it('sets signalScoreThreshold to standard threshold (default: 80)', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const controls = service.getControls(nonExpiryDay, EXPIRY_DATE);
      expect(controls.signalScoreThreshold).toBe(80);
    });

    it('applies custom STANDARD_SIGNAL_SCORE_THRESHOLD without adding a delta', () => {
      const service = new ExpiryDayControlsService(
        makeConfigService({ STANDARD_SIGNAL_SCORE_THRESHOLD: 75 }),
      );
      const controls = service.getControls(nonExpiryDay, EXPIRY_DATE);
      expect(controls.signalScoreThreshold).toBe(75);
    });

    it('sets positionSizeLimitPct to 100 (full position size; no reduction)', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const controls = service.getControls(nonExpiryDay, EXPIRY_DATE);
      expect(controls.positionSizeLimitPct).toBe(100);
    });

    it('sets mandatorySquareOffTime to "15:15" (standard NSE intraday square-off)', () => {
      const service = new ExpiryDayControlsService(makeConfigService());
      const controls = service.getControls(nonExpiryDay, EXPIRY_DATE);
      expect(controls.mandatorySquareOffTime).toBe('15:15');
    });

    it('ignores expiry-day config overrides and returns standard values', () => {
      // Even if expiry-day specific configs are set, non-expiry day must use standard values
      const service = new ExpiryDayControlsService(
        makeConfigService({
          STANDARD_SIGNAL_SCORE_THRESHOLD: 80,
          EXPIRY_DAY_SCORE_THRESHOLD_DELTA: 10,
          EXPIRY_DAY_POSITION_SIZE_LIMIT_PCT: 30,
          EXPIRY_DAY_SQUARE_OFF_TIME: '13:00',
        }),
      );
      const controls = service.getControls(nonExpiryDay, EXPIRY_DATE);

      expect(controls.isExpiryDay).toBe(false);
      expect(controls.signalScoreThreshold).toBe(80); // standard only, no delta
      expect(controls.positionSizeLimitPct).toBe(100); // full size
      expect(controls.mandatorySquareOffTime).toBe('15:15'); // standard NSE
    });
  });
});
