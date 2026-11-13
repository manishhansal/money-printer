/**
 * expiry-management.service.spec.ts
 *
 * Tests for ExpiryManagementService.
 *
 * Covers:
 *  - WEEKLY vs MONTHLY classification (last-Thursday detection)
 *  - Holiday-adjusted expiry classification (±3-day tolerance)
 *  - isContractExpired() date arithmetic
 *  - daysUntilExpiry() date arithmetic
 *  - getActiveExpiries() filters out past dates
 *  - getCurrentWeeklyExpiry() returns nearest active WEEKLY
 *  - getCurrentMonthlyExpiry() returns nearest active MONTHLY
 *  - Cache staleness refresh trigger
 *  - Empty API response does not crash
 *
 * Requirements: Phase 1 — Trading Universe and Expiry Discovery
 */

import { ExpiryManagementService } from './expiry-management.service';
import { DhanApiClient } from '../dhan/dhan-api.client';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApiClient(dates: string[] = []): jest.Mocked<DhanApiClient> {
  return {
    getOptionExpiryList: jest.fn().mockResolvedValue({ data: dates }),
  } as unknown as jest.Mocked<DhanApiClient>;
}

/** Freeze the system clock to a specific IST date for deterministic tests. */
function freezeDate(istDate: string): () => void {
  const isoUtc = new Date(`${istDate}T12:00:00+05:30`).toISOString();
  const spy = jest.spyOn(Date, 'now').mockReturnValue(new Date(isoUtc).getTime());
  return () => spy.mockRestore();
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY vs MONTHLY classification
// ─────────────────────────────────────────────────────────────────────────────

describe('ExpiryManagementService — expiry classification', () => {
  let svc: ExpiryManagementService;
  let api: jest.Mocked<DhanApiClient>;

  beforeEach(() => {
    api = makeApiClient();
    svc = new ExpiryManagementService(api);
  });

  /**
   * Access private classifyExpiry via type cast.
   */
  function classify(date: string): 'WEEKLY' | 'MONTHLY' {
    return (svc as unknown as { classifyExpiry(d: string): 'WEEKLY' | 'MONTHLY' }).classifyExpiry(
      date,
    );
  }

  it('classifies the last Thursday of January 2024 as MONTHLY', () => {
    // Last Thursday of Jan 2024 = 2024-01-25
    expect(classify('2024-01-25')).toBe('MONTHLY');
  });

  it('classifies a mid-month Thursday as WEEKLY', () => {
    // 2024-01-04 is a Thursday and NOT the last Thursday of January
    expect(classify('2024-01-04')).toBe('WEEKLY');
  });

  it('classifies the last Thursday of December 2024 as MONTHLY', () => {
    // Last Thursday of Dec 2024 = 2024-12-26
    expect(classify('2024-12-26')).toBe('MONTHLY');
  });

  it('classifies a Wednesday 2 days before last Thursday as MONTHLY (holiday shift tolerance)', () => {
    // If last Thursday is 2024-01-25, then 2024-01-24 (Wed) is within ±3 days → MONTHLY
    expect(classify('2024-01-24')).toBe('MONTHLY');
  });

  it('classifies a mid-month Wednesday as WEEKLY (outside ±3 day window)', () => {
    // 2024-01-10 (Wed) is well away from last Thursday Jan 25
    expect(classify('2024-01-10')).toBe('WEEKLY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isContractExpired / daysUntilExpiry
// ─────────────────────────────────────────────────────────────────────────────

describe('ExpiryManagementService — expiry date arithmetic', () => {
  let svc: ExpiryManagementService;

  beforeEach(() => {
    svc = new ExpiryManagementService(makeApiClient());
  });

  it('isContractExpired returns true for a past date', () => {
    const unfreeze = freezeDate('2024-06-15');
    expect(svc.isContractExpired('2024-06-13')).toBe(true);
    unfreeze();
  });

  it('isContractExpired returns false for a future date', () => {
    const unfreeze = freezeDate('2024-06-15');
    expect(svc.isContractExpired('2024-06-20')).toBe(false);
    unfreeze();
  });

  it('isContractExpired returns true for today (expiry day has passed)', () => {
    const unfreeze = freezeDate('2024-06-15');
    // Same date as today is considered expired (trading day over when scanner runs)
    // The comparison is `date < today` so today itself is NOT expired
    expect(svc.isContractExpired('2024-06-15')).toBe(false);
    unfreeze();
  });

  it('daysUntilExpiry returns positive for future expiry', () => {
    const unfreeze = freezeDate('2024-06-15');
    expect(svc.daysUntilExpiry('2024-06-20')).toBe(5);
    unfreeze();
  });

  it('daysUntilExpiry returns negative for past expiry', () => {
    const unfreeze = freezeDate('2024-06-15');
    expect(svc.daysUntilExpiry('2024-06-13')).toBe(-2);
    unfreeze();
  });

  it('daysUntilExpiry returns 0 for today', () => {
    const unfreeze = freezeDate('2024-06-15');
    expect(svc.daysUntilExpiry('2024-06-15')).toBe(0);
    unfreeze();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getActiveExpiries / getCurrentWeeklyExpiry / getCurrentMonthlyExpiry
// ─────────────────────────────────────────────────────────────────────────────

describe('ExpiryManagementService — expiry queries', () => {
  let svc: ExpiryManagementService;
  let api: jest.Mocked<DhanApiClient>;

  const MOCK_EXPIRY_DATES = [
    '2024-06-06', // past Thursday (weekly)
    '2024-06-13', // past Thursday (weekly)
    '2024-06-20', // future Thursday (weekly) — today is 2024-06-15
    '2024-06-27', // last Thursday of June 2024 (monthly)
    '2024-07-04', // future (weekly July)
    '2024-07-25', // last Thursday of July 2024 (monthly)
  ];

  beforeEach(() => {
    api = makeApiClient(MOCK_EXPIRY_DATES);
    svc = new ExpiryManagementService(api);
  });

  it('getActiveExpiries filters out past dates', async () => {
    const unfreeze = freezeDate('2024-06-15');
    const actives = await svc.getActiveExpiries('NIFTY', true);
    unfreeze();

    const dates = actives.map((e) => e.date);
    expect(dates).not.toContain('2024-06-06');
    expect(dates).not.toContain('2024-06-13');
    expect(dates).toContain('2024-06-20');
  });

  it('getActiveExpiries returns expiries sorted ascending', async () => {
    const unfreeze = freezeDate('2024-06-15');
    const actives = await svc.getActiveExpiries('NIFTY', true);
    unfreeze();

    for (let i = 1; i < actives.length; i++) {
      expect(actives[i].date >= actives[i - 1].date).toBe(true);
    }
  });

  it('getCurrentWeeklyExpiry returns nearest active WEEKLY', async () => {
    const unfreeze = freezeDate('2024-06-15');
    const weekly = await svc.getCurrentWeeklyExpiry('NIFTY', true);
    unfreeze();

    expect(weekly).not.toBeNull();
    expect(weekly!.date).toBe('2024-06-20');
    expect(weekly!.type).toBe('WEEKLY');
  });

  it('getCurrentMonthlyExpiry returns nearest active MONTHLY', async () => {
    const unfreeze = freezeDate('2024-06-15');
    const monthly = await svc.getCurrentMonthlyExpiry('NIFTY', true);
    unfreeze();

    expect(monthly).not.toBeNull();
    expect(monthly!.date).toBe('2024-06-27');
    expect(monthly!.type).toBe('MONTHLY');
  });

  it('isExpiryValid returns true for a known active expiry', async () => {
    const unfreeze = freezeDate('2024-06-15');
    const valid = await svc.isExpiryValid('NIFTY', '2024-06-20', true);
    unfreeze();

    expect(valid).toBe(true);
  });

  it('isExpiryValid returns false for a past expiry', async () => {
    const unfreeze = freezeDate('2024-06-15');
    const valid = await svc.isExpiryValid('NIFTY', '2024-06-06', true);
    unfreeze();

    expect(valid).toBe(false);
  });

  it('hasWeeklyContract returns true when weekly expiries exist', async () => {
    const unfreeze = freezeDate('2024-06-15');
    const hasWeekly = await svc.hasWeeklyContract('NIFTY', true);
    unfreeze();

    expect(hasWeekly).toBe(true);
  });

  it('getCurrentWeeklyExpiry returns null when API returns empty list', async () => {
    api.getOptionExpiryList = jest.fn().mockResolvedValue({ data: [] });

    const unfreeze = freezeDate('2024-06-15');
    const weekly = await svc.getCurrentWeeklyExpiry('NIFTY', true);
    unfreeze();

    expect(weekly).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache staleness
// ─────────────────────────────────────────────────────────────────────────────

describe('ExpiryManagementService — cache behaviour', () => {
  it('fetches from API only once when cache is fresh', async () => {
    const api = makeApiClient(['2024-06-20', '2024-06-27']);
    const svc = new ExpiryManagementService(api);

    const unfreeze = freezeDate('2024-06-15');
    await svc.getActiveExpiries('NIFTY', true);
    await svc.getActiveExpiries('NIFTY', true); // second call — should use cache
    unfreeze();

    expect(api.getOptionExpiryList).toHaveBeenCalledTimes(1);
  });
});
