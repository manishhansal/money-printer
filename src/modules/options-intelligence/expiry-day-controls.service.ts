/**
 * expiry-day-controls.service.ts
 *
 * ExpiryDayControlsService — task 11.4
 *
 * Responsibilities:
 *  - Determines whether a given trading date falls on an options expiry date.
 *  - Returns the appropriate risk controls for that date:
 *      • Expiry day:     higher signal score threshold, reduced position size,
 *                        and an earlier mandatory square-off time.
 *      • Non-expiry day: standard threshold, full (100%) position size, and
 *                        the regular 15:15 IST square-off time.
 *
 * Configuration (via ConfigService / environment variables):
 *  - STANDARD_SIGNAL_SCORE_THRESHOLD      — baseline entry score (default: 80)
 *  - EXPIRY_DAY_SCORE_THRESHOLD_DELTA     — extra points added on expiry day
 *                                           (default: 5)
 *  - EXPIRY_DAY_POSITION_SIZE_LIMIT_PCT   — max position size as a percentage
 *                                           of the standard maximum on expiry
 *                                           day; valid range 10–90 (default: 50)
 *  - EXPIRY_DAY_SQUARE_OFF_TIME           — mandatory square-off time in IST
 *                                           on expiry day in "HH:mm" format;
 *                                           valid range "12:00"–"14:30"
 *                                           (default: "14:00")
 *
 * Requirements: 7.4
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration defaults
// ─────────────────────────────────────────────────────────────────────────────

const STANDARD_SIGNAL_SCORE_THRESHOLD_DEFAULT = 80;
const EXPIRY_DAY_SCORE_THRESHOLD_DELTA_DEFAULT = 5;
const EXPIRY_DAY_POSITION_SIZE_LIMIT_PCT_DEFAULT = 50;
const EXPIRY_DAY_SQUARE_OFF_TIME_DEFAULT = '14:00';

// On a non-expiry day the system uses the regular NSE intraday square-off time.
const NON_EXPIRY_SQUARE_OFF_TIME = '15:15';

// On a non-expiry day positions are not restricted: 100% of standard maximum.
const NON_EXPIRY_POSITION_SIZE_PCT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The set of trading controls that apply for a given trading date.
 *
 * On a non-expiry day every field holds the standard (unrestricted) value.
 * On an expiry day the threshold is raised, position size is reduced, and
 * the mandatory square-off time is brought forward into the "12:00"–"14:30"
 * IST window.
 */
export interface ExpiryDayControls {
  /** `true` when the trading date coincides with the options expiry date. */
  isExpiryDay: boolean;

  /**
   * Minimum signal score required to enter a new position.
   *
   * Non-expiry: STANDARD_SIGNAL_SCORE_THRESHOLD (default 80).
   * Expiry day: STANDARD_SIGNAL_SCORE_THRESHOLD + EXPIRY_DAY_SCORE_THRESHOLD_DELTA
   *             (default 80 + 5 = 85).
   */
  signalScoreThreshold: number;

  /**
   * Maximum position size as a percentage of the configured standard maximum.
   *
   * Non-expiry: 100 (no reduction).
   * Expiry day: EXPIRY_DAY_POSITION_SIZE_LIMIT_PCT (valid range 10–90; default 50).
   */
  positionSizeLimitPct: number;

  /**
   * Time by which all open positions must be squared off, in "HH:mm" IST format.
   *
   * Non-expiry: "15:15" (standard NSE intraday square-off).
   * Expiry day: EXPIRY_DAY_SQUARE_OFF_TIME (valid range "12:00"–"14:30"; default "14:00").
   */
  mandatorySquareOffTime: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ExpiryDayControlsService {
  constructor(private readonly configService: ConfigService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns `true` when `tradingDate` falls on the same calendar day as
   * `expiryDate`, `false` otherwise.
   *
   * The comparison is done in UTC to avoid introducing a runtime dependency
   * on the host's local timezone. NSE market hours (09:15–15:30 IST / 03:45–
   * 10:00 UTC) are always within the same UTC calendar day as the IST day,
   * so this comparison is correct for all practical NSE trading timestamps.
   *
   * @param tradingDate  The current trading date and time.
   * @param expiryDate   The expiry date in "YYYY-MM-DD" format.
   * @returns            `true` if the two dates refer to the same calendar day.
   *
   * Requirements: 7.4
   */
  isExpiryDay(tradingDate: Date, expiryDate: string): boolean {
    const y = tradingDate.getUTCFullYear();
    const m = String(tradingDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(tradingDate.getUTCDate()).padStart(2, '0');
    const tradingDateStr = `${y}-${m}-${d}`;
    return tradingDateStr === expiryDate;
  }

  /**
   * Returns the `ExpiryDayControls` applicable for the given trading date.
   *
   * On a non-expiry day the returned controls use the standard (unrestricted)
   * values. On an expiry day the signal score threshold is raised by the
   * configured delta, the maximum position size is reduced to the configured
   * percentage, and the mandatory square-off time is set to the configured
   * early value.
   *
   * @param tradingDate  The current trading date and time.
   * @param expiryDate   The expiry date in "YYYY-MM-DD" format.
   * @returns            Applicable controls for the given trading date.
   *
   * Requirements: 7.4
   */
  getControls(tradingDate: Date, expiryDate: string): ExpiryDayControls {
    const standardThreshold = this.configService.get<number>(
      'STANDARD_SIGNAL_SCORE_THRESHOLD',
      STANDARD_SIGNAL_SCORE_THRESHOLD_DEFAULT,
    );

    if (!this.isExpiryDay(tradingDate, expiryDate)) {
      return {
        isExpiryDay: false,
        signalScoreThreshold: standardThreshold,
        positionSizeLimitPct: NON_EXPIRY_POSITION_SIZE_PCT,
        mandatorySquareOffTime: NON_EXPIRY_SQUARE_OFF_TIME,
      };
    }

    const delta = this.configService.get<number>(
      'EXPIRY_DAY_SCORE_THRESHOLD_DELTA',
      EXPIRY_DAY_SCORE_THRESHOLD_DELTA_DEFAULT,
    );

    const positionSizeLimitPct = this.configService.get<number>(
      'EXPIRY_DAY_POSITION_SIZE_LIMIT_PCT',
      EXPIRY_DAY_POSITION_SIZE_LIMIT_PCT_DEFAULT,
    );

    const mandatorySquareOffTime = this.configService.get<string>(
      'EXPIRY_DAY_SQUARE_OFF_TIME',
      EXPIRY_DAY_SQUARE_OFF_TIME_DEFAULT,
    );

    return {
      isExpiryDay: true,
      signalScoreThreshold: standardThreshold + delta,
      positionSizeLimitPct,
      mandatorySquareOffTime,
    };
  }
}
