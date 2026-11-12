/**
 * nse-holiday-calendar.service.ts
 *
 * NseHolidayCalendarService — NSE trading holiday calendar for FY2025-2026.
 *
 * NSE observes holidays according to the official annual holiday list published
 * at: https://www.nseindia.com/resources/exchange-communication-holiday
 *
 * This service:
 *  1. Maintains a hardcoded list of NSE holidays (updated for each financial year).
 *  2. Provides `isHoliday(date)` for session phase and cron gate checks.
 *  3. Prevents crons (square-off, reconciliation, instrument scan) from firing
 *     on market holidays when the exchange is actually closed.
 *
 * Requirements: Phase 10 — NSE holiday calendar
 */

import { Injectable, Logger } from '@nestjs/common';

/** NSE holiday record. */
interface NseHoliday {
  date: string; // YYYY-MM-DD format
  description: string; // e.g. "Republic Day"
}

/**
 * NSE trading holidays for FY2025-2026 (April 2025 – March 2026).
 * Source: NSE official holiday list.
 * This list covers both equity and F&O segments (they share the same holidays).
 *
 * UPDATE THIS LIST annually from the NSE official holiday notification.
 */
const NSE_HOLIDAYS_2025_2026: NseHoliday[] = [
  // 2025
  { date: '2025-02-26', description: 'Mahashivratri' },
  { date: '2025-03-14', description: 'Holi' },
  { date: '2025-03-31', description: 'Id-Ul-Fitr (Ramzan Id)' },
  { date: '2025-04-10', description: 'Shri Ram Navami' },
  { date: '2025-04-14', description: 'Dr. Baba Saheb Ambedkar Jayanti / Good Friday' },
  { date: '2025-04-18', description: 'Good Friday' },
  { date: '2025-05-01', description: 'Maharashtra Day' },
  { date: '2025-06-07', description: 'Id-Ul-Adha (Bakri Id)' },
  { date: '2025-07-07', description: 'Muharram' },
  { date: '2025-08-15', description: 'Independence Day' },
  { date: '2025-08-27', description: 'Ganesh Chaturthi' },
  { date: '2025-10-02', description: 'Gandhi Jayanti / Dussehra' },
  { date: '2025-10-20', description: 'Diwali - Laxmi Puja' },
  { date: '2025-10-21', description: 'Diwali - Balipratipada' },
  { date: '2025-11-05', description: 'Prakash Gurpurb Sri Guru Nanak Dev' },
  { date: '2025-11-20', description: 'Maharashtra Election Day' },
  { date: '2025-12-25', description: 'Christmas' },
  // 2026
  { date: '2026-01-26', description: 'Republic Day' },
  { date: '2026-02-18', description: 'Mahashivratri' },
  { date: '2026-03-02', description: 'Holi' },
  { date: '2026-03-20', description: 'Id-Ul-Fitr (Ramzan Id)' },
  { date: '2026-03-25', description: 'Shri Ram Navami' },
  { date: '2026-04-03', description: 'Good Friday' },
  { date: '2026-04-14', description: 'Dr. Baba Saheb Ambedkar Jayanti' },
  { date: '2026-05-01', description: 'Maharashtra Day' },
  { date: '2026-05-27', description: 'Id-Ul-Adha (Bakri Id)' },
  { date: '2026-06-26', description: 'Muharram' },
  { date: '2026-08-15', description: 'Independence Day' },
  { date: '2026-08-25', description: 'Janmashtami' },
  { date: '2026-09-16', description: 'Ganesh Chaturthi' },
  { date: '2026-10-02', description: 'Gandhi Jayanti' },
  { date: '2026-11-08', description: 'Diwali - Laxmi Puja' },
  { date: '2026-11-09', description: 'Diwali - Balipratipada' },
  { date: '2026-11-24', description: 'Guru Nanak Jayanti' },
  { date: '2026-12-25', description: 'Christmas' },
];

/** IST offset from UTC in minutes. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

@Injectable()
export class NseHolidayCalendarService {
  private readonly logger = new Logger(NseHolidayCalendarService.name);

  /** Fast lookup set: 'YYYY-MM-DD' → description */
  private readonly holidaySet = new Map<string, string>();

  constructor() {
    for (const holiday of NSE_HOLIDAYS_2025_2026) {
      this.holidaySet.set(holiday.date, holiday.description);
    }
    this.logger.log(
      `[HolidayCalendar] Loaded ${this.holidaySet.size} NSE holidays for FY2025-2026`,
    );
  }

  /**
   * Returns true when the given UTC date falls on an NSE trading holiday.
   * Converts to IST before checking (since NSE observes IST dates).
   *
   * @param utcDate  UTC date to check. Defaults to now.
   */
  isHoliday(utcDate: Date = new Date()): boolean {
    const istDate = this.toIstDate(utcDate);
    return this.holidaySet.has(istDate);
  }

  /**
   * Returns the holiday name for the given date, or null if not a holiday.
   * Useful for logging ("Skipping scan — Diwali").
   */
  getHolidayName(utcDate: Date = new Date()): string | null {
    const istDate = this.toIstDate(utcDate);
    return this.holidaySet.get(istDate) ?? null;
  }

  /**
   * Returns true when the market is likely open:
   *   - Not a Saturday or Sunday (UTC+5:30 weekday)
   *   - Not an NSE holiday
   */
  isMarketDay(utcDate: Date = new Date()): boolean {
    const istMs = utcDate.getTime() + IST_OFFSET_MINUTES * 60 * 1_000;
    const istDayOfWeek = new Date(istMs).getUTCDay(); // 0=Sun, 6=Sat
    if (istDayOfWeek === 0 || istDayOfWeek === 6) return false;
    return !this.isHoliday(utcDate);
  }

  /**
   * Convert a UTC date to a 'YYYY-MM-DD' string in IST.
   */
  private toIstDate(utcDate: Date): string {
    const istMs = utcDate.getTime() + IST_OFFSET_MINUTES * 60 * 1_000;
    const istDate = new Date(istMs);
    const y = istDate.getUTCFullYear();
    const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(istDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}
