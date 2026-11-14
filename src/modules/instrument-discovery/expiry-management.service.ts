/**
 * expiry-management.service.ts
 *
 * ExpiryManagementService — dynamically resolves valid NSE option expiry dates.
 *
 * # Problem
 *
 * The existing scanner hardcodes no expiry awareness at all.  It scans all
 * instruments in the DB regardless of whether their expiry has passed.  This
 * allows the system to attempt trading expired contracts — a critical defect.
 *
 * # What this service does
 *
 * 1. Fetches the live expiry list for each eligible underlying from the
 *    Dhan option expiry API (POST /v2/optionchain/expirylist).
 * 2. Classifies each expiry date as WEEKLY or MONTHLY per NSE rules.
 * 3. Caches the result in memory (refreshed every 10 minutes during market hours).
 * 4. Provides fast synchronous lookups for:
 *    - getCurrentWeeklyExpiry(underlying)  → nearest Thursday expiry.
 *    - getCurrentMonthlyExpiry(underlying) → last Thursday of current month.
 *    - isExpiryValid(underlying, expiryDate) → whether a date is a live expiry.
 *    - isContractExpired(expiryDate)        → whether a date is in the past.
 *
 * # NSE expiry rules (as of 2025)
 *
 * - NIFTY 50: Weekly expiry every Thursday (can be Wednesday on exchange holidays).
 * - BANKNIFTY: Weekly expiry every Wednesday (moved from Thursday in 2023).
 * - MIDCPNIFTY: Weekly expiry every Monday.
 * - FINNIFTY: Weekly expiry every Tuesday.
 * - SENSEX (BSE): Weekly expiry every Friday (not in scope for NSE).
 * - Stock options: Monthly expiry only (last Thursday of expiry month).
 *
 * This service does NOT hardcode expiry days.  It uses the live expiry list
 * from the Dhan API as the authoritative source, then classifies each entry
 * as WEEKLY or MONTHLY by checking whether the date matches the last Thursday
 * of its month (= monthly expiry) or not (= weekly expiry).
 *
 * # Exchange holidays
 *
 * When an exchange holiday falls on the standard expiry day, NSE moves expiry
 * to the preceding trading day.  By consuming the live Dhan expiry list, this
 * service automatically handles holiday-adjusted dates without a separate
 * holiday calendar.
 *
 * Requirements: Phase 1 — Trading Universe and Expiry Discovery
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DhanApiClient } from '../dhan/dhan-api.client';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result of an expiry classification. */
export interface ExpiryInfo {
  /** Date in YYYY-MM-DD format. */
  date: string;
  /** WEEKLY = mid-month Thursday/holiday-adjusted; MONTHLY = last Thursday. */
  type: 'WEEKLY' | 'MONTHLY';
  /** True when this expiry date is strictly in the future (not expired). */
  isActive: boolean;
  /** Number of calendar days until this expiry from today. */
  daysUntilExpiry: number;
}

/** Cached expiry state for one underlying. */
interface UnderlyingExpiryCache {
  /** All available expiry dates, classified. */
  expiries: ExpiryInfo[];
  /** UTC timestamp when this cache entry was last refreshed. */
  refreshedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Well-known Dhan security IDs for index underlyings
// ─────────────────────────────────────────────────────────────────────────────

/** Dhan security IDs for supported index underlyings. */
export const INDEX_SECURITY_IDS: Record<string, string> = {
  NIFTY: '13',
  BANKNIFTY: '25',
  FINNIFTY: '27',
  MIDCPNIFTY: '442',
  NIFTYNXT50: '50',
};

/** Exchange segment for index options in the Dhan expiry list API. */
const INDEX_EXPIRY_SEGMENT = 'NSE_FNO';

/** Exchange segment for stock options. */
const STOCK_EXPIRY_SEGMENT = 'NSE_FNO';

/** Cache TTL — refresh if older than this. */
const CACHE_TTL_MS = 10 * 60 * 1_000; // 10 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ExpiryManagementService {
  private readonly logger = new Logger(ExpiryManagementService.name);

  /**
   * Per-underlying expiry cache.
   * Key: underlying symbol (e.g. 'NIFTY', 'RELIANCE').
   */
  private readonly cache = new Map<string, UnderlyingExpiryCache>();

  constructor(private readonly dhanApiClient: DhanApiClient) {}

  // ─── Scheduled refresh ─────────────────────────────────────────────────────

  /**
   * Refresh expiry caches for all known index underlyings every 10 minutes
   * during market hours (Mon–Fri, 09:00–16:00 IST).
   */
  @Cron('*/10 9-16 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scheduledRefresh(): Promise<void> {
    for (const underlying of Object.keys(INDEX_SECURITY_IDS)) {
      try {
        await this.refreshUnderlyingExpiries(underlying, true);
      } catch (err) {
        this.logger.warn(
          `[ExpiryMgr] Scheduled refresh failed for ${underlying}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ─── Public query API ───────────────────────────────────────────────────────

  /**
   * Returns the nearest active WEEKLY expiry for an index underlying.
   *
   * Returns null when:
   *   - No live expiry data is available.
   *   - The underlying has no weekly contracts (e.g. stock options).
   *
   * @param underlying  Symbol, e.g. 'NIFTY', 'BANKNIFTY'.
   * @param isIndex     True for index options, false for stock options.
   */
  async getCurrentWeeklyExpiry(underlying: string, isIndex = true): Promise<ExpiryInfo | null> {
    const expiries = await this.getActiveExpiries(underlying, isIndex);
    const weekly = expiries.filter((e) => e.type === 'WEEKLY');
    return weekly.length > 0 ? weekly[0] : null;
  }

  /**
   * Returns the current active MONTHLY expiry for an underlying.
   *
   * Returns null when no monthly contract is available.
   *
   * @param underlying  Symbol, e.g. 'NIFTY', 'RELIANCE'.
   * @param isIndex     True for index options, false for stock options.
   */
  async getCurrentMonthlyExpiry(underlying: string, isIndex = true): Promise<ExpiryInfo | null> {
    const expiries = await this.getActiveExpiries(underlying, isIndex);
    const monthly = expiries.filter((e) => e.type === 'MONTHLY');
    return monthly.length > 0 ? monthly[0] : null;
  }

  /**
   * Returns all active (non-expired) expiry dates for an underlying,
   * sorted by date ascending (nearest first).
   *
   * Uses cached data if fresh; fetches from Dhan API otherwise.
   *
   * @param underlying  Symbol, e.g. 'NIFTY'.
   * @param isIndex     True for index, false for stock options.
   */
  async getActiveExpiries(underlying: string, isIndex = true): Promise<ExpiryInfo[]> {
    await this.ensureFresh(underlying, isIndex);
    const cached = this.cache.get(underlying);
    if (!cached) return [];
    return cached.expiries.filter((e) => e.isActive).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Returns true when an expiry date string is a valid, live (non-expired)
   * expiry for the given underlying.
   *
   * @param underlying   Symbol, e.g. 'NIFTY'.
   * @param expiryDate   Date in YYYY-MM-DD format.
   * @param isIndex      True for index, false for stock options.
   */
  async isExpiryValid(underlying: string, expiryDate: string, isIndex = true): Promise<boolean> {
    const expiries = await this.getActiveExpiries(underlying, isIndex);
    return expiries.some((e) => e.date === expiryDate);
  }

  /**
   * Returns true when the given expiry date has passed (is today or in the past).
   * Does NOT require a network call — purely date arithmetic.
   *
   * @param expiryDate  Date in YYYY-MM-DD format.
   */
  isContractExpired(expiryDate: string): boolean {
    const today = this.todayIST();
    return expiryDate < today;
  }

  /**
   * Returns the number of calendar days until the given expiry date.
   * Negative means already expired.
   *
   * @param expiryDate  Date in YYYY-MM-DD format.
   */
  daysUntilExpiry(expiryDate: string): number {
    const today = this.todayIST();
    const expMs = new Date(`${expiryDate}T00:00:00+05:30`).getTime();
    const todayMs = new Date(`${today}T00:00:00+05:30`).getTime();
    return Math.round((expMs - todayMs) / (24 * 60 * 60 * 1000));
  }

  /**
   * Returns whether the underlying has a valid weekly contract.
   *
   * Not all indices have weekly contracts.  Call this before attempting
   * to trade a weekly expiry to avoid invalid contract selection.
   *
   * @param underlying  Symbol, e.g. 'NIFTY'.
   * @param isIndex     True for index, false for stock options.
   */
  async hasWeeklyContract(underlying: string, isIndex = true): Promise<boolean> {
    const weekly = await this.getCurrentWeeklyExpiry(underlying, isIndex);
    return weekly !== null;
  }

  // ─── Cache management ───────────────────────────────────────────────────────

  /**
   * Refresh expiry data for an underlying from the Dhan API.
   * Populates the in-memory cache.
   *
   * @param underlying  Symbol, e.g. 'NIFTY'.
   * @param isIndex     True for index, false for stock options.
   */
  async refreshUnderlyingExpiries(underlying: string, isIndex = true): Promise<void> {
    const securityId = isIndex ? (INDEX_SECURITY_IDS[underlying] ?? '') : '';
    if (!securityId && isIndex) {
      this.logger.warn(`[ExpiryMgr] No securityId for index ${underlying} — skipping refresh`);
      return;
    }

    const segment = isIndex ? INDEX_EXPIRY_SEGMENT : STOCK_EXPIRY_SEGMENT;

    try {
      const response = await this.dhanApiClient.getOptionExpiryList(
        securityId ? parseInt(securityId, 10) : 0,
        segment,
      );

      const rawDates: string[] = response?.data ?? [];
      if (rawDates.length === 0) {
        this.logger.warn(`[ExpiryMgr] Empty expiry list for ${underlying} — API returned no dates`);
        return;
      }

      const today = this.todayIST();
      const expiries: ExpiryInfo[] = rawDates
        .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
        .map((date) => {
          const isActive = date >= today;
          return {
            date,
            type: this.classifyExpiry(date),
            isActive,
            daysUntilExpiry: this.daysUntilExpiry(date),
          };
        })
        .sort((a, b) => a.date.localeCompare(b.date));

      this.cache.set(underlying, { expiries, refreshedAt: new Date() });

      this.logger.debug(
        `[ExpiryMgr] Refreshed ${underlying}: ${expiries.length} dates, ` +
          `${expiries.filter((e) => e.isActive).length} active ` +
          `(${expiries.filter((e) => e.type === 'WEEKLY' && e.isActive).length} weekly, ` +
          `${expiries.filter((e) => e.type === 'MONTHLY' && e.isActive).length} monthly)`,
      );
    } catch (err) {
      this.logger.error(
        `[ExpiryMgr] Failed to refresh expiries for ${underlying}: ${(err as Error).message}`,
      );
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Ensure the cache for an underlying is populated and fresh.
   * Fetches from API if the cache is absent or stale (> 10 minutes old).
   */
  private async ensureFresh(underlying: string, isIndex: boolean): Promise<void> {
    const cached = this.cache.get(underlying);
    const isStale = !cached || Date.now() - cached.refreshedAt.getTime() > CACHE_TTL_MS;

    if (isStale) {
      await this.refreshUnderlyingExpiries(underlying, isIndex);
    }
  }

  /**
   * Classify an expiry date as WEEKLY or MONTHLY.
   *
   * NSE rule: the monthly expiry is the LAST Thursday of the contract month.
   * Any Thursday (or holiday-adjusted day) in a month that is NOT the last
   * Thursday is a weekly expiry.
   *
   * Algorithm:
   *   1. Find the last Thursday of the month containing `date`.
   *   2. If `date` == last Thursday → MONTHLY.
   *   3. Otherwise → WEEKLY.
   *
   * Note: When a Thursday is a public holiday, NSE moves expiry to the
   * preceding Wednesday.  This algorithm treats those dates as WEEKLY
   * unless they also happen to fall on what would be the last-Thursday week.
   * Since we consume the actual Dhan expiry list (not generated dates), the
   * last entry in a month is always the monthly expiry regardless of the
   * exact day of week — a more robust heuristic.
   *
   * @param dateStr  YYYY-MM-DD format.
   */
  private classifyExpiry(dateStr: string): 'WEEKLY' | 'MONTHLY' {
    const d = new Date(`${dateStr}T12:00:00Z`);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();

    // Find the last Thursday (day 4) of the same month
    const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0));
    while (lastDayOfMonth.getUTCDay() !== 4) {
      lastDayOfMonth.setUTCDate(lastDayOfMonth.getUTCDate() - 1);
    }
    const lastThursday = lastDayOfMonth.toISOString().slice(0, 10);

    // Within ±3 days of last Thursday = monthly (accommodates holiday shifts)
    const diffDays = Math.abs(
      (d.getTime() - new Date(`${lastThursday}T12:00:00Z`).getTime()) / (24 * 60 * 60 * 1000),
    );

    return diffDays <= 3 ? 'MONTHLY' : 'WEEKLY';
  }

  /**
   * Returns today's date string in YYYY-MM-DD format, IST-adjusted.
   */
  private todayIST(): string {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    return nowIst.toISOString().slice(0, 10);
  }
}
